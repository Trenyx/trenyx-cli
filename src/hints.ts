/**
 * Where a repository's shape would stop a run or mislead it, the exact flags to use. Only names of files and folders, and
 * the test output: nothing here opens a test, and nothing here reaches the bug writer, so the view stays blind. A hint is
 * advice: it never changes the run, and a failure here never stops one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isTestPath } from "./blind.js";
import { notProduct } from "./spread.js";
import type { Lang } from "./types.js";
import { git } from "./workspace.js";

const tracked = (repo: string) => { try { return git(repo, "ls-files").split("\n").filter(Boolean); } catch { return []; } };
const has = (repo: string, ...names: string[]) => names.some((n) => fs.existsSync(path.join(repo, n)));
const under = (dir: string, files: string[]) => files.filter((f) => f.startsWith(`${dir}/`));
const words = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0]!);

export function packageManager(repo: string): string {
  return has(repo, "pnpm-lock.yaml") ? "pnpm" : has(repo, "yarn.lock") ? "yarn" : has(repo, "bun.lockb", "bun.lock") ? "bun" : "npm";
}

const NOT_FOLDERS = new Set(["run", "test", "tests", "exec", "npm", "pnpm", "yarn", "bun", "npx", "go", "cargo", "python", "python3", "pytest", "vitest", "jest", "node", "make", "sh", "bash", "cd"]);
const TEST_FOLDER = /^(tests?|__tests__|specs?|e2e|integration|unit)$/i;

/** The product folders a test command names: `pytest services/api/tests` names services/api. */
function namedFolders(text: string, files: string[]): string[] {
  const found = new Set<string>();
  for (const raw of text.split(/[\s;&|]+/)) {
    const word = raw.replace(/^["']|["']$/g, "").split("=").pop()!.replace(/^\.\//, "").replace(/\/\.\.\.$/, "").replace(/\/+$/, "");
    if (!word || word.startsWith("-") || NOT_FOLDERS.has(word)) continue;
    const parts = word.split("/");
    while (parts.length && TEST_FOLDER.test(parts[parts.length - 1]!)) parts.pop();
    const dir = parts.join("/");
    if (dir && under(dir, files).length) found.add(dir);
  }
  return [...found];
}

/** The test command names part of the repository, and the bugs would go across all of it. files: where bugs can go. */
export function scopeHint(command: string | undefined, files: string[], paths?: string[]): string {
  if (!command || paths?.length) return "";
  const folders = namedFolders(command, files);
  if (!folders.length || files.every((f) => folders.some((d) => f.startsWith(`${d}/`)))) return "";
  return `Your test command names only ${words(folders)}, but the bugs would go across the whole repository, and a bug in code a command never runs always reads as got through. To keep them in that part, add: ${folders.map((d) => `--path ${d}`).join(" ")}`;
}

export interface RunScope { keep: (file: string) => boolean; note: string }

const goPackages = (text: string) => text.split(/[\s;&|]+/).map((w) => w.replace(/^["']|["']$/g, "")).filter((w) => /^\.(\/|$)/.test(w));

/** The part of the code the test command runs, so no bug goes where no test can run. Only the command and the names of
 * files and folders: what the tests check never enters. Go: `./x/...` is x and everything under it, `./x` the files
 * directly in x, and a folder with its own go.mod is never reached from the root. Other runners: the folders named.
 * null: the command runs everything, or names nothing we can read. files: where bugs can go. */
export function runScope(command: string | undefined, language: Lang, files: string[], repo: string): RunScope | null {
  if (!command) return null;
  files = files.filter((f) => !notProduct(f, ""));     // examples, docs and tools never get bugs anyway: leaving them out changes nothing
  let keep: (f: string) => boolean, parts: string[];
  if (language === "go" && /\bgo test\b/.test(command) && !/(^|[\s;&|])cd\s/.test(command)) {
    const pkgs = goPackages(command).map((w) => w.replace(/^\.\/?/, ""));
    const deep = pkgs.filter((p) => p === "..." || p.endsWith("/...")).map((p) => p.replace(/\/?\.\.\.$/, ""));
    const flat = pkgs.filter((p) => !p.endsWith("...")).map((p) => p.replace(/\/+$/, ""));
    const mods = has(repo, "go.work") ? [] : tracked(repo).filter((f) => f.endsWith("/go.mod")).map((f) => path.posix.dirname(f));
    const ownModule = (f: string) => mods.some((m) => f.startsWith(`${m}/`));
    if (!deep.length && !flat.length) return null;
    keep = (f) => !ownModule(f) && (deep.some((d) => d === "" || f.startsWith(`${d}/`)) || flat.includes(path.posix.dirname(f) === "." ? "" : path.posix.dirname(f)));
    const missed = mods.filter((m) => files.some((f) => f.startsWith(`${m}/`)));
    const named = missed.length > 3 ? `${missed.slice(0, 3).join(", ")} and ${missed.length - 3} more` : words(missed);
    if (deep.includes("")) {
      if (files.every(keep) || !files.some(keep)) return null;
      return { keep, note: `go test from the root never reaches ${named}, which ${missed.length === 1 ? "has its" : "have their"} own go.mod, so no bugs go there: a bug in code the command never runs always reads as got through. To test ${missed.length === 1 ? "it" : "one"}, use --path ${missed[0]} --test-cmd "cd ${missed[0]} && go test ./..."` };
    }
    parts = [...deep.map((d) => `${d}/`), ...flat.map((d) => (d ? `${d}/ (its own files)` : "the top-level files"))];
    if (missed.length) parts.push(`not ${named} (own go.mod)`);
  } else {
    const folders = namedFolders(command, files);
    if (!folders.length) return null;
    keep = (f) => folders.some((d) => f.startsWith(`${d}/`));
    parts = folders.map((d) => `${d}/`);
  }
  if (files.every(keep) || !files.some(keep)) return null;
  return { keep, note: `Your test command runs only ${words(parts)}, so the bugs go only there: a bug in code the command never runs always reads as got through. To choose the part yourself, use --path.` };
}

/** How much of the product code (by size) the test command runs, and the biggest folders it leaves out, when that is
 * under COVER_WARN. Only names and sizes: where the bugs go is runScope's, and this never changes it. */
export const COVER_WARN = 0.8;
export function coverageNote(scope: RunScope | null, files: string[], dir: string): string {
  if (!scope) return "";
  const size = (f: string) => { try { return fs.statSync(path.join(dir, f)).size; } catch { return 0; } };
  let all = 0, kept = 0;
  const out = new Map<string, number>();
  for (const f of files.filter((x) => !notProduct(x, ""))) {
    const n = size(f);
    all += n;
    if (scope.keep(f)) kept += n;
    else {
      const top = f.includes("/") ? `${f.split("/")[0]}/` : "the top-level files";
      out.set(top, (out.get(top) ?? 0) + n);
    }
  }
  if (!all || kept / all >= COVER_WARN) return "";
  const biggest = [...out].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([d]) => d);
  return `Your test command runs about ${Math.round((kept / all) * 100)}% of the code (by size); bugs are planted only there, so the score speaks for that part. Left out, biggest first: ${words(biggest)}.`;
}

/** Below a root go.mod, `go test ./...` stops at any folder that has its own, unless a go.work joins them. */
export function nestedModulesHint(repo: string, files: string[]): string {
  if (!has(repo, "go.mod") || has(repo, "go.work")) return "";
  const mods = tracked(repo).filter((f) => f.endsWith("/go.mod")).map((f) => path.posix.dirname(f)).filter((d) => under(d, files).length).sort();
  if (!mods.length) return "";
  return `go test ./... stops at a folder with its own go.mod, so it never runs ${words(mods)}, and a bug there always reads as got through. Leave ${mods.length === 1 ? "it" : "them"} out with ${mods.map((d) => `--exclude ${d}`).join(" ")}, or test one with --path ${mods[0]} --test-cmd "cd ${mods[0]} && go test ./..."`;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Untracked files the failed run's own output names: they exist here, and are missing from a clean copy. */
export function copyHint(repo: string, wt: string, logs: string[]): string {
  let others: string[];
  try { others = git(repo, "ls-files", "--others", "--directory", "--no-empty-directory").split("\n"); } catch { return ""; }
  const text = logs.flatMap((f) => { try { return [fs.readFileSync(f, "utf8").slice(-1_000_000)]; } catch { return []; } }).join("\n");
  const named = (entry: string) => new RegExp(`(?:^|[\\s'"\`(=:]|${esc(wt)}/|\\./)${esc(entry)}(?=[\\s'"\`/):,]|$)`, "m").test(text);
  const found = others.map((e) => e.replace(/\/$/, "")).filter((e) => e && !/(^|\/)(node_modules|\.git)$/.test(e) && named(e)).slice(0, 3);
  return found.length ? `The test output names ${found.length === 1 ? "something" : "things"} a clean copy doesn't have. Try: ${found.map((e) => `--copy ${e}`).join(" ")}` : "";
}

const hasTestScript = (repo: string, dir: string) => {
  try {
    const script = (JSON.parse(fs.readFileSync(path.join(repo, dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.test;
    return !!script && !/no test specified/.test(script);
  } catch { return false; }
};

/** The root runs no tests, but parts of the repository have their own project file. */
export function partsHint(repo: string, language: Lang): string {
  const [file, run] = { go: ["go.mod", "go test ./..."], rust: ["Cargo.toml", "cargo test"], python: ["pyproject.toml", "python3 -m pytest"], typescript: ["package.json", `${packageManager(repo)} test`] }[language];
  const parts = tracked(repo).filter((f) => f.endsWith(`/${file}`) && !isTestPath(f) && !notProduct(f, "")).map((f) => path.posix.dirname(f))
    .filter((d) => language !== "typescript" || hasTestScript(repo, d)).sort().slice(0, 3);
  if (!parts.length) return "";
  return `This repository has separate parts, so test one at a time:\n${parts.map((d) => `  trenyx run --path ${d} --test-cmd "cd ${d} && ${run}"`).join("\n")}`;
}
