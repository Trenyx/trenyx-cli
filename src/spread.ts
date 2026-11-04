/**
 * Where the bugs go, as a rule the run enforces. Left alone, a writer picks small self-contained files, which is where a
 * good suite is strongest, and the score flatters. So the plan comes first: folders from the blind view, weighted by how
 * much code each holds, with limits per file and per folder and a limit on small files.
 *
 * Blind by construction: the only inputs are the view (test code already gone), the language and the bug count. Nothing
 * here may take the repository, the test command, or anything else that knows what the tests check. The run may hand it
 * a view narrowed to the part the test command runs (hints.ts runScope): that is the command's paths, not its tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { View } from "./blind.js";
import type { Bug, Lang } from "./types.js";

const LANG_EXT: Record<Lang, string[]> = {
  go: [".go"], python: [".py"], rust: [".rs"], typescript: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".vue"],
};
// a Trenyx-side tool replays the engine's own lists against these numbers, on placement alone, never on scores.
const SPLIT_SHARE = 1 / 8;      // a folder over this share of the code is split into its subfolders
const MAX_SHARE = 0.3;          // most of the bugs one folder may take
const PER_FILE = 2;             // most bugs in one file, unless the project has too few files
const SMALL_SHARE = 0.25;       // most of the bugs in files smaller than the project's median file
const LINES_CAP = 1500;         // one file counts for this many lines at most, so a data table does not steer the plan

// Support folders by name, read only above the source root: src/lib/features/playground is a feature, examples/foo/src is not.
const SUPPORT = new Set(["examples", "example", "samples", "sample", "demo", "demos", "benchmarks", "benchmark", "bench", "benches", "docs", "doc",
  "scripts", "script", "hack", "stories", "storybook", "playground", "website"]);
const AT_ROOT = new Set(["tools", "ci", "contrib"]);
const SOURCE_ROOT = new Set(["src", "lib", "pkg", "internal", "app"]);
const GENERATED_DIR = new Set(["generated", "__generated__"]);
const GENERATED = /(?:^|\n)\s*(?:\/\/|#|\/\*+|\*|<!--)[^\n]*(?:code generated|@generated|auto-?generated|\bDO NOT EDIT\b)/i;
const NOT_LOGIC = /\.d\.[cm]?ts$|\.config\.[cm]?[jt]s$/;

/** Why a file is not product code by its name or first lines, or "". */
export function notProduct(rel: string, head: string): string {
  const parts = rel.split("/"), dirs = parts.slice(0, -1);
  const root = dirs.findIndex((d) => SOURCE_ROOT.has(d.toLowerCase())), above = root < 0 ? dirs.length : root;
  const hit = dirs.find((d, i) => d.startsWith(".") || GENERATED_DIR.has(d.toLowerCase()) || (i < above && SUPPORT.has(d.toLowerCase())) || (i === 0 && AT_ROOT.has(d.toLowerCase())));
  if (hit) return `in ${hit}/, which is not product code`;
  if (NOT_LOGIC.test(parts[parts.length - 1]!)) return "a type or config file";
  if (GENERATED.test(head)) return "generated code";
  return "";
}

export interface Bucket {
  dir: string;        // "." is the project root
  direct: boolean;    // only the files directly in dir; otherwise everything under it
  lines: number;
  files: number;
  share: number;      // of the code in the plan
  quota: number;      // bugs planned here
  cap: number;        // most bugs here
}

export interface SpreadPlan {
  count: number;
  buckets: Bucket[];
  perFolder: number;    // the folder limit; a folder holding more of the code than this keeps its share
  perFile: number;
  smallUnder: number;   // a file under this many lines is small
  smallMost: number;    // most bugs in small files
  home: Map<string, number>;    // file -> index into buckets
  sizes: Map<string, number>;   // file -> lines counted
  leftOut: number;      // source files outside the plan
}

export interface Gap { bucket: Bucket; need: number }

export const folderName = (b: Pick<Bucket, "dir" | "direct">) => (b.dir === "." ? (b.direct ? "(files at the top level)" : "(whole project)") : `${b.dir}/${b.direct ? " (only the files directly here)" : ""}`);

interface Node { dir: string; own: [string, number][]; subs: Map<string, Node>; total: number }

function tree(sizes: Map<string, number>): Node {
  const root: Node = { dir: ".", own: [], subs: new Map(), total: 0 };
  for (const [file, lines] of sizes) {
    const parts = file.split("/");
    let at = root;
    at.total += lines;
    for (const seg of parts.slice(0, -1)) {
      if (!at.subs.has(seg)) at.subs.set(seg, { dir: at.dir === "." ? seg : `${at.dir}/${seg}`, own: [], subs: new Map(), total: 0 });
      at = at.subs.get(seg)!;
      at.total += lines;
    }
    at.own.push([file, lines]);
  }
  return root;
}

const filesUnder = (n: Node): [string, number][] => [...n.own, ...[...n.subs.values()].flatMap(filesUnder)];

function cut(n: Node, all: number): { dir: string; direct: boolean; files: [string, number][] }[] {
  if (!n.subs.size || n.total / all <= SPLIT_SHARE) return [{ dir: n.dir, direct: false, files: filesUnder(n) }];
  const subs = [...n.subs.values()].flatMap((s) => cut(s, all));
  return n.own.length ? [{ dir: n.dir, direct: true, files: n.own }, ...subs] : subs;
}

/** How many bugs each folder gets, in proportion to its code, within a per-folder and a per-file limit. */
function apportion(b: Bucket[], count: number, perFile: number): void {
  for (const x of b) x.quota = 0;
  for (let left = count; left > 0; left--) {
    const room = b.filter((x) => x.quota < Math.min(x.cap, x.files * perFile));
    if (!room.length) return;
    room.sort((x, y) => (count * y.share - y.quota) - (count * x.share - x.quota) || y.lines - x.lines || (x.dir < y.dir ? -1 : 1));
    room[0]!.quota++;
  }
}

export function planSpread(view: View, language: Lang, count: number): SpreadPlan {
  const ours = view.sourceFiles.filter((f) => LANG_EXT[language].some((e) => f.endsWith(e)));
  const read = (f: string) => fs.readFileSync(path.join(view.dir, f), "utf8");
  let chosen = ours.filter((f) => !notProduct(f, read(f).slice(0, 2048)));
  if (!chosen.length) chosen = ours.length ? ours : view.sourceFiles;   // the whole repository is one of these: the developer pointed us here
  const sizes = new Map(chosen.map((f) => [f, Math.min(LINES_CAP, Math.max(1, read(f).split("\n").filter((l) => l.trim()).length))]));
  const all = [...sizes.values()].reduce((a, n) => a + n, 0);
  const home = new Map<string, number>();
  const buckets: Bucket[] = cut(tree(sizes), all).map((c, i) => {
    for (const [f] of c.files) home.set(f, i);
    const lines = c.files.reduce((a, [, n]) => a + n, 0);
    return { dir: c.dir, direct: c.direct, lines, files: c.files.length, share: lines / all, quota: 0, cap: 0 };
  });
  // a folder holding more of the code than the limit keeps its share: a flat package has nowhere else for the bugs to go
  let cap = Math.max(Math.ceil(count * MAX_SHARE), Math.ceil(count / buckets.length));
  let perFile = Math.max(PER_FILE, Math.ceil(count / sizes.size));
  for (;;) {
    for (const b of buckets) b.cap = Math.max(cap, Math.ceil(count * b.share));
    apportion(buckets, count, perFile);
    if (buckets.reduce((a, b) => a + b.quota, 0) === count) break;
    if (cap < count) cap++; else perFile++;
  }
  const sorted = [...sizes.values()].sort((a, b) => a - b), smallUnder = sorted[Math.floor(sorted.length / 2)]!;
  // a folder of only small files keeps its share: the limit never makes the plan impossible
  const forced = buckets.reduce((sum, b, i) => {
    const big = [...sizes].filter(([f, n]) => home.get(f) === i && n >= smallUnder).length;
    return sum + Math.max(0, b.quota - big * perFile);
  }, 0);
  return { count, buckets, perFolder: cap, perFile, smallUnder, smallMost: Math.max(Math.ceil(count * SMALL_SHARE), forced), home, sizes, leftOut: view.sourceFiles.length - chosen.length };
}

/** Which bugs stand: the plan's places fill first, in list order, then any left go wherever the limits still allow. */
export function pickSpread(bugs: Bug[], plan: SpreadPlan, count: number): { kept: Bug[]; dropped: { bug: Bug; why: string }[] } {
  const inFile = new Map<string, number>(), inBucket = plan.buckets.map(() => 0), dropped: { bug: Bug; why: string }[] = [];
  let small = 0;
  const chosen = new Set<Bug>();
  const take = (b: Bug, i: number) => {
    chosen.add(b);
    inFile.set(b.file, (inFile.get(b.file) ?? 0) + 1);
    inBucket[i]!++;
    if (plan.sizes.get(b.file)! < plan.smallUnder) small++;
  };
  const limit = (b: Bug) => {
    if ((inFile.get(b.file) ?? 0) >= plan.perFile) return `over the limit of ${plan.perFile} in one file`;
    if (plan.sizes.get(b.file)! < plan.smallUnder && small >= plan.smallMost) return `over the limit of ${plan.smallMost} in small files (under ${plan.smallUnder} lines)`;
    return "";
  };
  const later: [Bug, number][] = [];
  for (const b of bugs) {
    const i = plan.home.get(b.file);
    if (i === undefined) { dropped.push({ bug: b, why: "outside the plan: not product code in this language, or code the test command never runs" }); continue; }
    if (chosen.size < count && inBucket[i]! < plan.buckets[i]!.quota && !limit(b)) take(b, i);
    else later.push([b, i]);
  }
  for (const [b, i] of later) {
    if (chosen.size >= count) break;      // a full list needs no spares
    const why = limit(b) || (inBucket[i]! >= plan.buckets[i]!.cap ? `over the limit of ${plan.buckets[i]!.cap} in ${folderName(plan.buckets[i]!)}` : "");
    if (why) dropped.push({ bug: b, why });
    else take(b, i);
  }
  return { kept: bugs.filter((b) => chosen.has(b)), dropped };
}

/** The folders still short of their plan. */
export function gaps(kept: Bug[], plan: SpreadPlan): Gap[] {
  const placed = plan.buckets.map(() => 0);
  for (const b of kept) {
    const i = plan.home.get(b.file);
    if (i !== undefined) placed[i]!++;
  }
  return plan.buckets.flatMap((b, i) => (placed[i]! < b.quota ? [{ bucket: b, need: b.quota - placed[i]! }] : []));
}

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;

/** The plan in the writer's prompt. */
export function planText(plan: SpreadPlan, spare: number): string {
  const rows = plan.buckets.filter((b) => b.quota).sort((a, b) => b.quota - a.quota || (a.dir < b.dir ? -1 : 1));
  return `Where the bugs go. This plan comes from how much code each folder holds, and the run enforces it: a bug that breaks a limit is dropped.
${rows.map((b) => `- ${folderName(b)}: ${plural(b.quota, "bug")}`).join("\n")}
Keep to these numbers. Limits: at most ${plan.perFile} in one file, and at most ${plan.smallMost} in files under ${plan.smallUnder} lines, so most bugs belong in the larger files of each folder. Anywhere outside the folders above is not in the plan.${spare > 0 ? ` The other ${plural(spare, "bug")} ${spare === 1 ? "is a spare" : "are spares"}: put them in any of these folders, within the limits.` : ""}
Open only what you need: a file or two for each bug, not the whole project.`;
}

export interface SpreadRow { folder: string; share: number; planned: number; placed: number; caught: number; through: number }

/** The plan against where the bugs ended up, with what each folder's tests did. Run gives a verdict per bug id. */
export function spreadRows(plan: SpreadPlan, bugs: Bug[], verdict?: (b: Bug) => string): SpreadRow[] {
  const rows = plan.buckets.map((b) => ({ folder: folderName(b), share: b.share, planned: b.quota, placed: 0, caught: 0, through: 0 }));
  const outside: SpreadRow = { folder: "(outside the plan)", share: 0, planned: 0, placed: 0, caught: 0, through: 0 };
  for (const b of bugs) {
    const i = plan.home.get(b.file), r = i === undefined ? outside : rows[i]!;
    r.placed++;
    if (verdict?.(b) === "CAUGHT") r.caught++;
    if (verdict?.(b) === "ESCAPED") r.through++;
  }
  return [...rows, outside].filter((r) => r.planned || r.placed).sort((a, b) => b.placed - a.placed || b.share - a.share);
}

export function spreadRule(plan: SpreadPlan): string {
  return `at most ${plan.perFile} in one file, ${plan.perFolder} in one folder (more only where a folder holds more of the code) and ${plan.smallMost} in files under ${plan.smallUnder} lines`;
}
