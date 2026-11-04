import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Cell, Failing } from "./verdict.js";

export type Format = "junit" | "go-json" | "cargo-text" | "unittest-text" | "jest-json" | "exit";

export interface Command {
  argv: string[];              // {report} and {wt} are filled in per run
  format: Format;
  env?: Record<string, string>;
  builds?: string[][];         // run before the tests: a failure is a broken build, not a catch
  label: string;               // shown to the developer and the writer: holds no test names
}

const live = new Set<number>();

/** Stops every process group still running. Safe inside a signal handler. */
export function killChildren(): void {
  for (const pid of live) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  live.clear();
}

export interface Proc { code: number | null; timedOut: boolean; ms: number }

/** Runs one command in its own process group, output to a file. On a timeout: SIGINT (a runner writes its report),
 * then SIGTERM, then SIGKILL, and whatever the command left behind goes with the group. */
export function runProcess(argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; log: string }): Promise<Proc> {
  const fd = fs.openSync(o.log, "a"), t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", fd, fd] });
    const pid = child.pid;
    let timedOut = false, done = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (code: number | null) => {       // a command that cannot start fires both error and close
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      fs.closeSync(fd);
      if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } live.delete(pid); }
      resolve({ code, timedOut, ms: Date.now() - t0 });
    };
    child.on("error", (e) => { fs.appendFileSync(o.log, `\ncould not start ${argv[0]}: ${e.message}\n`); finish(127); });
    child.on("close", (code, sig) => finish(code ?? (sig ? 128 : null)));
    if (!pid) return;
    live.add(pid);
    const send = (s: NodeJS.Signals) => { try { process.kill(-pid, s); } catch { /* gone */ } };
    timers.push(setTimeout(() => {
      timedOut = true;
      send("SIGINT");
      timers.push(setTimeout(() => send("SIGTERM"), 5000), setTimeout(() => send("SIGKILL"), 8000));
    }, o.timeoutMs));
  });
}

export function testEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, CI: "1", PYTHONDONTWRITEBYTECODE: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
  // the AI key never reaches the tests or the bugs, and no git variable points them back at the real repository
  for (const k of Object.keys(out)) if (/^(ANTHROPIC_|CLAUDE_|GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR)$)/.test(k)) delete out[k];
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!);
const clean = (s: string, root: string) => s.split(root + "/").join("").split(root).join(".");

export interface Parsed { failing: Failing | null; total: number | null }

export function parseJunit(xml: string, root = "\0"): Parsed {
  const F: string[] = [], E: string[] = [];
  let total = 0;
  const open = /<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>)/g;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    total++;
    const attr = (k: string) => unescape(new RegExp(`\\b${k}=(?:"([^"]*)"|'([^']*)')`).exec(m![1]!)?.slice(1).find((x) => x !== undefined) ?? "");
    const id = clean(`${attr("classname")}::${attr("name")}`, root);
    if (m[2] === "/>") continue;
    const end = xml.indexOf("</testcase>", open.lastIndex);
    const body = xml.slice(open.lastIndex, end < 0 ? xml.length : end);
    if (/<failure\b/.test(body)) F.push(id);
    else if (/<error\b/.test(body)) E.push(id);
  }
  return { failing: { F, E }, total };
}

export function parseGoJson(text: string): Parsed {
  const F = new Set<string>(), pkgFail = new Set<string>(), failedIn = new Set<string>();
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: { Action?: string; Package?: string; Test?: string };
    try { e = JSON.parse(line) as typeof e; } catch { continue; }
    if (e.Action !== "fail" && e.Action !== "pass") continue;
    if (e.Test) {
      total++;
      if (e.Action === "fail") { F.add(`${e.Package}/${e.Test}`); failedIn.add(e.Package ?? ""); }
    } else if (e.Action === "fail") pkgFail.add(e.Package ?? "");
  }
  return { failing: { F: [...F], E: [...pkgFail].filter((p) => !failedIn.has(p)).map((p) => `${p} (package failed)`) }, total };
}

export function parseCargoText(text: string): Parsed {
  const F: string[] = [];
  let total = 0, results = 0;
  for (const line of text.split("\n")) {
    const m = /^test (.+?) \.\.\. (ok|FAILED)\s*$/.exec(line);
    if (m) { total++; if (m[2] === "FAILED") F.push(m[1]!); }
    if (/^test result: /.test(line)) results++;
  }
  return { failing: total || results ? { F, E: [] } : null, total: total || results ? total : null };
}

export function parseUnittestText(text: string): Parsed {
  const F: string[] = [], E: string[] = [];
  for (const m of text.matchAll(/^(FAIL|ERROR): (.+)$/gm)) (m[1] === "FAIL" ? F : E).push(m[2]!.trim());
  const ran = /^Ran (\d+) tests?\b/m.exec(text);
  return ran || F.length || E.length ? { failing: { F, E }, total: ran ? Number(ran[1]) : null } : { failing: null, total: null };
}

export function parseJestJson(text: string, root = "\0"): Parsed {
  const doc = JSON.parse(text) as { numTotalTests?: number; testResults?: { name?: string; status?: string; message?: string; assertionResults?: { status?: string; fullName?: string }[] }[] };
  const F: string[] = [], E: string[] = [];
  for (const r of doc.testResults ?? []) {
    const file = clean(r.name ?? "", root);
    const failed = (r.assertionResults ?? []).filter((a) => a.status === "failed");
    failed.forEach((a) => F.push(`${file}::${a.fullName}`));
    if (r.status === "failed" && !failed.length) E.push(`${file} (did not load)`);
  }
  return { failing: { F, E }, total: doc.numTotalTests ?? null };
}

export function parseRun(format: Format, code: number | null, log: string, report: string, root: string): Parsed {
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
  try {
    if (format === "exit") return { failing: { F: code === 0 ? [] : ["(the test command failed)"], E: [] }, total: null };
    if (format === "go-json") return parseGoJson(read(log) ?? "");
    if (format === "cargo-text") return parseCargoText(read(log) ?? "");
    if (format === "unittest-text") return parseUnittestText(read(log) ?? "");
    const body = read(report);
    if (body === null) return { failing: null, total: null };
    return format === "junit" ? parseJunit(body, root) : parseJestJson(body, root);
  } catch { return { failing: null, total: null }; }
}

let serial = 0;

export interface RunOptions { wt: string; root: string; env: NodeJS.ProcessEnv; timeoutMs: number; parseCheck?: string[] }

export interface Ran extends Cell { ms: number; log: string }

/** One whole suite run in the copy: the parse check and build steps, then the tests. */
export async function runSuite(cmd: Command, o: RunOptions): Promise<Ran> {
  const n = ++serial, logs = path.join(o.root, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const log = path.join(logs, `${n}.log`), report = path.join(logs, `${n}.report`);
  const fill = (a: string) => a.split("{report}").join(report).split("{wt}").join(o.wt);
  // the tests' temp files live in the run's folder too, so a killed run leaves none behind (go test's go-build folders)
  const temp = path.join(o.root, "tmp");
  fs.mkdirSync(temp, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...o.env, TMPDIR: temp, TEMP: temp, TMP: temp };
  for (const [k, v] of Object.entries(cmd.env ?? {})) env[k] = fill(v);
  const empty = { installFailed: false, failing: null, killed: null, total: null, testFailed: false, log };
  for (const argv of [...(o.parseCheck ? [o.parseCheck] : []), ...(cmd.builds ?? [])]) {
    const p = await runProcess(argv.map(fill), { cwd: o.wt, env, timeoutMs: o.timeoutMs, log });
    if (p.code !== 0) return { ...empty, installFailed: !p.timedOut, killed: p.timedOut ? 124 : null, ms: p.ms };
  }
  const p = await runProcess(cmd.argv.map(fill), { cwd: o.wt, env, timeoutMs: o.timeoutMs, log });
  const parsed = parseRun(cmd.format, p.code, log, report, o.wt);
  if (p.timedOut && cmd.format === "go-json" && parsed.failing) parsed.failing.E = [];    // go reports our own stop as a failed package
  return { installFailed: false, failing: parsed.failing, total: parsed.total, killed: p.timedOut ? 124 : null, testFailed: p.code !== 0, ms: p.ms, log };
}

export const logTail = (log: string, lines = 15) => {
  try { return fs.readFileSync(log, "utf8").trimEnd().split("\n").slice(-lines).map((l) => l.slice(0, 200)).join("\n"); } catch { return ""; }
};
