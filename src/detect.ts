import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { packageManager, partsHint } from "./hints.js";
import type { Command } from "./suite.js";
import { Stop, type Lang } from "./types.js";
import { git } from "./workspace.js";

export interface Detected {
  language: Lang;
  cmd: Command;
  carry: string[];       // folders the tests need that git does not hold
  command?: string;      // the test command as the developer wrote it, where there is one
  note?: string;
}

const has = (repo: string, ...names: string[]) => names.some((n) => fs.existsSync(path.join(repo, n)));

function pythonBin(repo: string): string {
  for (const v of [".venv", "venv"]) {
    const p = path.join(repo, v, "bin", "python");
    if (fs.existsSync(p)) return p;
  }
  return "python3";
}

const PY_ENV = { PYTHONPATH: "{wt}/src:{wt}" };     // an editable install must not hide the copy under test

function python(repo: string): Command {
  const py = pythonBin(repo);
  if (spawnSync(py, ["-c", "import pytest"], { stdio: "ignore" }).status === 0) {
    return { argv: [py, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--junitxml={report}"], format: "junit", env: PY_ENV, label: "pytest" };
  }
  const start = has(repo, "tests") ? ["-s", "tests", "-t", "."] : [];
  return { argv: [py, "-m", "unittest", "discover", ...start], format: "unittest-text", env: PY_ENV, label: "python -m unittest" };
}

function nodeModuleDirs(repo: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    for (const e of fs.readdirSync(path.join(repo, rel || "."), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === "node_modules") out.push(r);
      else if (depth < 3) walk(r, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

const REPORT = {
  vitest: { args: ["--reporter=junit", "--outputFile={report}"], format: "junit" },
  jest: { args: ["--json", "--outputFile={report}"], format: "jest-json" },
} as const;

/** Runs the project's own test script, adding a machine-readable report when it is one plain runner call. */
function javascript(repo: string): { cmd: Command; carry: string[]; script?: string } {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const carry = nodeModuleDirs(repo);
  const script = pkg.scripts?.test;
  const placeholder = !script || /no test specified/.test(script);
  if (placeholder && !deps.vitest && !deps.jest) throw new Stop(["No test script found in package.json. Say how to run the tests with --test-cmd.", partsHint(repo, "typescript")].filter(Boolean).join("\n"));
  if (Object.keys(deps).length && !carry.length) throw new Stop("node_modules is missing. Install the project's dependencies first, then run this again.");
  const words = (placeholder ? (deps.vitest ? "vitest run" : "jest") : script).trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
  const env = { PATH: `{wt}/node_modules/.bin:${process.env.PATH ?? ""}` };
  const simple = !/[&|;<>$`]/.test(script ?? "");
  const builds: string[][] = has(repo, "tsconfig.json") && deps.typescript ? [["tsc", "--noEmit"]] : [];
  if (simple && (words[0] === "vitest" || words[0] === "jest")) {
    const r = REPORT[words[0]], argv = words[0] === "vitest" && !words.includes("run") ? ["vitest", "run", ...words.slice(1)] : words;
    return { cmd: { argv: [...argv, ...r.args], format: r.format, env, builds, label: words[0] }, carry, script };
  }
  if (simple && words[0] === "node" && words.includes("--test")) {
    return { cmd: { argv: ["node", "--test-reporter=junit", "--test-reporter-destination={report}", ...words.slice(1)], format: "junit", env, builds, label: "node --test" }, carry, script };
  }
  return { cmd: { argv: [packageManager(repo), "test"], format: "exit", env, builds, label: `${packageManager(repo)} test` }, carry, script };
}

/** A command the developer gave: run as written, and when it is a plain call of a runner we know, with a report added
 * so tests can be told apart. Anything else is pass or fail on its exit code. */
export function fromTestCmd(text: string): Command {
  const plain = !/[&|;<>`]/.test(text), argv = ["/bin/sh", "-c", text], label = text;
  if (plain && /\bpytest\b/.test(text)) return { argv: ["/bin/sh", "-c", `${text} -p no:cacheprovider --junitxml={report}`], format: "junit", env: PY_ENV, label };
  if (plain && /\bgo test\b/.test(text)) return { argv: ["/bin/sh", "-c", `${text.includes("-json") ? text : `${text} -json`}${text.includes("-count") ? "" : " -count=1"}`], format: "go-json", label };
  if (plain && /\bcargo test\b/.test(text)) return { argv, format: "cargo-text", env: { CARGO_TARGET_DIR: "{wt}/../target", CARGO_TERM_COLOR: "never" }, label };
  if (plain && /\bvitest\b/.test(text)) return { argv: ["/bin/sh", "-c", `${text} --reporter=junit --outputFile={report}`], format: "junit", env: { PATH: `{wt}/node_modules/.bin:${process.env.PATH ?? ""}` }, label };
  if (plain && /\bjest\b/.test(text)) return { argv: ["/bin/sh", "-c", `${text} --json --outputFile={report}`], format: "jest-json", env: { PATH: `{wt}/node_modules/.bin:${process.env.PATH ?? ""}` }, label };
  return { argv, format: "exit", label };
}

function languageOf(repo: string, want?: Lang): Lang {
  const found: Lang[] = [];
  if (has(repo, "go.mod", "go.work")) found.push("go");
  if (has(repo, "Cargo.toml")) found.push("rust");
  if (has(repo, "pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "requirements.txt")) found.push("python");
  if (has(repo, "package.json")) found.push("typescript");
  if (want) return want;
  if (found.length === 1) return found[0]!;
  const tracked = git(repo, "ls-files").split("\n");
  const count = (l: Lang) => tracked.filter((f) => ({ go: /\.go$/, rust: /\.rs$/, python: /\.py$/, typescript: /\.[cm]?[jt]sx?$/ })[l].test(f)).length;
  const pool: Lang[] = found.length ? found : ["go", "rust", "python", "typescript"];
  const best = [...pool].sort((a, b) => count(b) - count(a))[0]!;
  if (!count(best)) throw new Stop("Could not tell what language this repository is in. It has no Go, Python, TypeScript/JavaScript or Rust files.");
  return best;
}

export function detect(repo: string, o: { testCmd?: string; lang?: Lang; copy?: string[] }): Detected {
  const language = languageOf(repo, o.lang);
  let cmd: Command, carry: string[] = [], script: string | undefined;
  if (language === "go") cmd = { argv: ["go", "test", "-json", "-count=1", "./..."], format: "go-json", builds: [["go", "build", "./..."]], label: "go test ./..." };
  else if (language === "rust") {
    const ws = /^\[workspace\]/m.test(fs.readFileSync(path.join(repo, "Cargo.toml"), "utf8")) ? ["--workspace"] : [];
    cmd = { argv: ["cargo", "test", ...ws, "--no-fail-fast"], format: "cargo-text", env: { CARGO_TARGET_DIR: "{wt}/../target", CARGO_TERM_COLOR: "never" }, builds: [["cargo", "test", ...ws, "--no-run", "--quiet"]], label: "cargo test" };
  } else if (language === "python") cmd = python(repo);
  else ({ cmd, carry, script } = javascript(repo));
  if (o.testCmd) {
    const given = fromTestCmd(o.testCmd);
    cmd = { ...given, env: { ...cmd.env, ...given.env }, builds: cmd.builds };
  }
  return { language, cmd, carry: [...carry, ...(o.copy ?? [])], command: o.testCmd ?? script };
}

/** A syntax check of the edited file, where a language has no build step: a broken file is not a catch. */
export function parseCheck(language: Lang, cmd: Command, file: string): string[] | undefined {
  if (language === "python" && file.endsWith(".py")) {
    const py = cmd.argv[0] === "/bin/sh" ? "python3" : cmd.argv[0]!;
    return [py, "-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", `{wt}/${file}`];
  }
  if (language === "typescript" && /\.[cm]?js$/.test(file)) return ["node", "--check", `{wt}/${file}`];
  return undefined;
}
