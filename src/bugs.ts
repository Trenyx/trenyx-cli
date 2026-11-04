import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { View } from "./blind.js";
import { pickSpread, type SpreadPlan } from "./spread.js";
import { Stop, type Bug } from "./types.js";

// A bug makes the program wrong; it never reaches outside it. These are dropped unless the code already said so.
const REACHES_OUT = /child_process|subprocess|os\.system|os\.popen|exec\.Command|std::process::Command|\bcurl\b|\bwget\b|\brm -rf\b|shutil\.rmtree|\bfetch\(|requests\.(get|post)|http\.(Get|Post)|net\.Dial|socket\.|process\.env|os\.environ|os\.Getenv|std::env::var/;

/** Where a bug's file really is, inside the copy at `root`. Every edit goes through here, and a bug list can come from
 * anywhere (--bugs-file): an absolute path, a `..` that climbs out, or a link that leads out stops the run, so a planted
 * bug can only ever be written inside the copy. A path that is inside but not a plain file is the caller's to drop. */
export function insideCopy(root: string, file: string): string {
  const base = fs.realpathSync(root);
  const out = () => new Stop(`The bug list names ${JSON.stringify(file)}, which is outside the temporary copy. No bug ran. A bug's file must be a path inside the repository, like src/app.py.`);
  if (!file || file.includes("\0") || path.isAbsolute(file) || path.win32.isAbsolute(file)) throw out();
  const target = path.resolve(base, file);
  if (!target.startsWith(base + path.sep)) throw out();
  // follow every link on the way: the deepest part that exists must resolve inside the copy
  for (let p = target; p.startsWith(base + path.sep); p = path.dirname(p)) {
    try { fs.lstatSync(p); } catch { continue; }
    let real: string;
    try { real = fs.realpathSync(p); } catch { throw out(); }   // a link to nowhere could still be written through
    if (!real.startsWith(base + path.sep)) throw out();
    break;
  }
  return target;
}

function occurrences(hay: Buffer, needle: Buffer): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Keeps `count` bugs that are a real one-place edit to a source file in the view, checked in the REAL file, numbered
 * B01 up: with a plan, the ones that fit it; without one, the first that pass. Everything dropped is listed with its reason. */
export function validate(bugs: Bug[], src: string, view: View, count: number, plan?: SpreadPlan): { kept: Bug[]; dropped: { bug: Bug; why: string }[] } {
  const passed: Bug[] = [], dropped: { bug: Bug; why: string }[] = [], seen = new Set<string>();
  const root = fs.realpathSync(src), allowed = new Set(view.sourceFiles);
  for (const bug of bugs) {
    if (!plan && passed.length === count) break;
    const why = (() => {
      const real = insideCopy(root, bug.file);
      if (!allowed.has(bug.file)) return "not a source file in the view";
      if (!fs.lstatSync(real).isFile() || !fs.realpathSync(real).startsWith(root + path.sep)) return "not a plain file in the repository";
      if (!bug.old || bug.old === bug.new) return "the edit changes nothing";
      if (seen.has(bug.file + "\0" + bug.old)) return "repeats another bug";
      if (REACHES_OUT.test(bug.new) && !REACHES_OUT.test(bug.old)) return "reaches outside the program";
      const buf = fs.readFileSync(real), at = occurrences(buf, Buffer.from(bug.old));
      if (at.length !== 1) return at.length ? `its text occurs ${at.length} times in the file` : "its text is not in the file";
      bug.line = buf.subarray(0, at[0]).toString("utf8").split("\n").length;
      return "";
    })();
    if (why) dropped.push({ bug, why });
    else {
      seen.add(bug.file + "\0" + bug.old);
      passed.push(bug);
    }
  }
  const pick = plan ? pickSpread(passed, plan, count) : { kept: passed, dropped: [] };
  return { kept: pick.kept.map((b, i) => ({ ...b, id: `B${String(i + 1).padStart(2, "0")}` })), dropped: [...dropped, ...pick.dropped] };
}

/** SHA-256 of the list: id, file, old and new, as UTF-8 JSON with no spaces. */
export function fingerprint(bugs: Bug[]): string {
  return createHash("sha256").update(JSON.stringify(bugs.map((b) => [b.id, b.file, b.old, b.new]))).digest("hex");
}

/** The one edit, in a throwaway copy. Never follows a link out of that copy. */
export function applyBug(bug: Bug, wt: string): void {
  const root = fs.realpathSync(wt), target = insideCopy(root, bug.file);
  if (!fs.existsSync(target) || !fs.lstatSync(target).isFile() || !fs.realpathSync(target).startsWith(root + path.sep)) throw new Error(`${bug.file} is not a plain file in the copy`);
  const buf = fs.readFileSync(target), old = Buffer.from(bug.old), at = occurrences(buf, old);
  if (at.length !== 1) throw new Error(`${bug.id} no longer applies to ${bug.file}`);
  fs.writeFileSync(target, Buffer.concat([buf.subarray(0, at[0]), Buffer.from(bug.new), buf.subarray(at[0]! + old.length)]));
}
