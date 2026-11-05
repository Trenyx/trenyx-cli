#!/usr/bin/env node
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { buildView } from "./blind.js";
import { applyBug, fingerprint, insideCopy, validate } from "./bugs.js";
import { bundledCatalogue, drawKinds, newSeed } from "./catalogue.js";
import { makeClient } from "./client.js";
import { detect, parseCheck } from "./detect.js";
import { copyHint, coverageNote, nestedModulesHint, partsHint, runScope, scopeHint } from "./hints.js";
import { detectProvider } from "./provider.js";
import { markdownReport, score, spreadLines, terminalReport, verdictWords, type Outcome, type Summary } from "./report.js";
import { folderName, gaps, planSpread, spreadRows, spreadRule } from "./spread.js";
import { killChildren, logTail, runSuite, testEnv, type Ran } from "./suite.js";
import { LANG_NAME, Stop, type Lang } from "./types.js";
import { baseline, intermittent, newFailing, settle, sharedFailing, unreliableCatch, verdict } from "./verdict.js";
import { Workspace, git } from "./workspace.js";
import { ownKeyWriter, readBugList, savedListWriter, type BugWriter } from "./writer.js";

const VERSION = "0.1.2";
const MAX_BUGS = 16;
const MAX_CLEAN_RUNS = 4;
const CHECK_RUNS = 3;                // extra clean runs after the bugs, when anything was caught
const SECOND_PASS_SHARE = 1 / 3;    // the most of --max-cost one second pass may use
const COST_MARGIN = 0.1;            // a reply's input is only priced once it is back, so a last turn can pass the limit: stop short by this share
const HELP = `trenyx run: plant realistic bugs in a throwaway copy of your repo and see which ones your tests catch.
Runs on your machine. Code goes only to the AI provider you already use, through your own key. Nothing goes to Trenyx.

Usage: trenyx run [options]            inside a git repository with passing tests

  --bugs N            how many bugs to write (default ${MAX_BUGS}, also the most)
  --test-cmd "CMD"    how to run the tests, when the default is wrong
  --path DIR          only this part of the code goes to the provider (repeatable)
  --exclude PATH      never send this file or folder (repeatable)
  --copy PATH         an untracked file or folder the tests need, such as .env.test (repeatable)
  --lang L            go, python, typescript or rust, when detection picks wrong
  --model NAME        the model to use (default claude-opus-5-5)
  --seed TEXT         draw the same kinds of bug as an earlier run (the run prints its seed)
  --max-cost USD      stop if AI cost passes this (default 5)
  --timeout SECONDS   stop one test run after this long
  --allow-failing     set aside tests that already fail, instead of refusing
  --bugs-file FILE    run a saved bug list; nothing is sent anywhere
  --list-files        show exactly which files the provider could read, then stop
  --out FILE          where to write the report
  --save-bugs FILE    where to save the bug list (default: next to the report, as .bugs.json)
  --yes               do not ask before sending code

Credentials: ANTHROPIC_API_KEY, or CLAUDE_CODE_USE_BEDROCK=1 with your AWS setup, or CLAUDE_CODE_USE_VERTEX=1 with your Google Cloud setup.`;

const say = (s = "") => process.stdout.write(s + "\n");

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      bugs: { type: "string" }, "test-cmd": { type: "string" }, path: { type: "string", multiple: true }, exclude: { type: "string", multiple: true },
      copy: { type: "string", multiple: true }, lang: { type: "string" }, model: { type: "string" }, seed: { type: "string" }, "max-cost": { type: "string" }, timeout: { type: "string" },
      "allow-failing": { type: "boolean" }, "bugs-file": { type: "string" }, "list-files": { type: "boolean" }, out: { type: "string" }, "save-bugs": { type: "string" }, yes: { type: "boolean" },
      help: { type: "boolean", short: "h" }, version: { type: "boolean" },
    },
  });
  return { values, positionals };
}

async function ask(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  process.stdout.write(q);
  const line = await new Promise<string>((res) => { rl.once("line", res); rl.once("close", () => res("")); });
  rl.close();
  return /^y(es)?$/i.test(line.trim());
}

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

/** The tests that failed on every clean run so far. */
const failedEvery = (runs: Ran[]) => (["F", "E"] as const).flatMap((k) => runs[0]!.failing?.[k].filter((t) => runs.every((r) => r.failing?.[k].includes(t))) ?? []);

function refuseBaseline(runs: Ran[], allowFailing: boolean, exitOnly: boolean, shape: (logs: string[]) => string[]): void {
  const advice = () => ["The run uses a clean copy of your last commit, so untracked files are missing: use --copy for what the tests need, or --test-cmd to run a part that passes.", ...shape(runs.flatMap((r) => [r.log, r.log.replace(/\.log$/, ".report")]))].filter(Boolean).join("\n");
  for (const r of runs) {
    if (r.installFailed) throw new Stop(`The project does not build in a clean copy of your last commit.\n${logTail(r.log)}\n\n${advice()}`);
    if (r.killed !== null) throw new Stop(`Your tests hung in a clean copy of your last commit.\n${logTail(r.log)}\n\nGive them longer with --timeout, or run a part with --test-cmd.`);
    if (r.failing === null) throw new Stop(`Your tests did not run in a clean copy of your last commit.\n${logTail(r.log)}\n\n${advice()}`);
    if (r.total === 0) throw new Stop(`No tests ran in a clean copy of your last commit.\n${logTail(r.log)}\n\n${advice()}`);
  }
  if (exitOnly && runs.some((r) => r.testFailed)) throw new Stop(`Your tests do not pass on a clean copy of your last commit.\n${logTail(runs.find((r) => r.testFailed)!.log)}\n\n${advice()}`);
  const failing = failedEvery(runs);
  if (failing.length && !allowFailing) {
    const list = failing.slice(0, 10).map((t) => `  ${t}`).join("\n");
    const n = failing.length, these = n === 1 ? "This test fails" : `These ${n} tests fail`;
    // the likeliest next step first (a test that fails every time on a clean copy usually depends on the machine), then the rest
    throw new Stop(`Your tests do not pass on a clean copy of your last commit. ${these} on all ${runs.length} clean runs, which usually means ${n === 1 ? "it depends" : "they depend"} on your setup (a port, a service, a file):\n${list}${n > 10 ? `\n  and ${n - 10} more` : ""}\n\nTo set ${n === 1 ? "it" : "them"} aside and continue:\n  trenyx run --allow-failing\n\nOther options: fix ${n === 1 ? "it" : "them"}, or run a part that passes with --test-cmd.\n${advice()}`);
  }
}

async function run(values: ReturnType<typeof parse>["values"]): Promise<number> {
  const count = values.bugs === undefined ? MAX_BUGS : Number(values.bugs);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BUGS) throw new Stop(`--bugs must be a whole number from 1 to ${MAX_BUGS}.`);
  const maxCost = values["max-cost"] === undefined ? 5 : Number(values["max-cost"]);
  if (!(maxCost > 0)) throw new Stop("--max-cost must be above 0.");
  const timeoutMs = values.timeout === undefined ? null : Number(values.timeout) * 1000;
  if (timeoutMs !== null && !(timeoutMs > 0)) throw new Stop("--timeout must be a number of seconds.");
  if (values.lang && !(values.lang in LANG_NAME)) throw new Stop("--lang must be go, python, typescript or rust.");
  const seed = values.seed ?? newSeed();
  if (!/^[\w-]{1,64}$/.test(seed)) throw new Stop("--seed must be letters, digits, - or _, at most 64 of them.");

  let repo: string, sha: string;
  try {
    repo = git(process.cwd(), "rev-parse", "--show-toplevel");
    sha = git(repo, "rev-parse", "HEAD");
  } catch { throw new Stop("Run this inside a git repository with at least one commit."); }
  // the developer's repository, as git sees it: compared again after the run, which only ever reads it
  const repoState = () => `${git(repo, "rev-parse", "HEAD")}\n${git(repo, "status", "--porcelain")}`;
  const before = repoState();
  const dirty = git(repo, "status", "--porcelain") !== "";

  const provider = detectProvider(process.env);
  const listOnly = !!values["list-files"];
  let writer: BugWriter;
  if (values["bugs-file"]) writer = savedListWriter(path.resolve(values["bugs-file"]));
  else if (listOnly) writer = savedListWriter("");
  else if (provider) writer = ownKeyWriter(provider, process.env, await makeClient(provider));
  else throw new Stop("No AI key found. Set ANTHROPIC_API_KEY, or CLAUDE_CODE_USE_BEDROCK=1 with your AWS setup, or CLAUDE_CODE_USE_VERTEX=1 with your Google Cloud setup. Your key stays on this machine and goes only to that provider.");

  const det = detect(repo, { testCmd: values["test-cmd"], lang: values.lang as Lang | undefined, copy: values.copy });
  const ws = new Workspace(repo, sha, det.carry);
  const abort = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    process.stderr.write("\nStopping and cleaning up. Your repository was not touched.\n");
    killChildren();
    abort.abort();
    ws.destroy();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, onSignal);
  process.on("uncaughtException", (e) => {
    killChildren();
    ws.destroy();
    process.stderr.write(`\nThe run stopped on an error: ${e.message}\nYour repository was not touched.\n`);
    process.exit(1);
  });

  try {
    say(`Repository: ${path.basename(repo)} at ${sha.slice(0, 7)}${dirty ? " (uncommitted changes are not included)" : ""}`);
    say(`Tests: ${LANG_NAME[det.language]}, ${det.cmd.label}${det.cmd.format === "exit" ? " (pass or fail only)" : ""}`);

    const paths = values.path, exclude = values.exclude;
    const view = buildView(ws.pristine(), path.join(ws.root, "view"), { paths, exclude });
    if (!view.sourceFiles.length) throw new Stop("No product source files found to put bugs in. Check --path and --exclude.");
    if (listOnly) {
      view.files.forEach((f) => say(`  ${f}`));
      say(`\n${view.files.length} files, ${view.sourceFiles.length} of them source. Test files are not on the list. Nothing was sent.`);
      return 0;
    }

    const told = writer.describe();
    // where the command runs no test, no bug can be caught: the plan keeps to the part it runs, unless --path chose one
    const scope = paths?.length ? null : runScope(det.command ?? (det.language === "go" ? "go test ./..." : undefined), det.language, view.sourceFiles, repo);
    const spread = planSpread(scope ? { ...view, sourceFiles: view.sourceFiles.filter(scope.keep) } : view, det.language, count);   // blind: the view, the language and the count
    if (told.sends) {
      const files = [...spread.home.keys()];
      const hints = [scope ? scope.note : scopeHint(det.command, files, paths), det.language === "go" && !values["test-cmd"] && !scope ? nestedModulesHint(repo, files) : ""].filter(Boolean);
      hints.forEach((h) => say(`Note: ${h}`));
    }
    const coverage = told.sends ? coverageNote(scope, view.sourceFiles, view.dir) : "";
    if (coverage) say(coverage);

    // a saved list can come from anywhere: every file it names is checked against the copy before any test runs
    const saved = values["bugs-file"] ? readBugList(path.resolve(values["bugs-file"])) : null;
    saved?.forEach((b) => insideCopy(ws.pristine(), b.file));
    const n = saved ? Math.min(saved.length, count) : count;
    say();
    say("Before anything runs:");
    say(`  Your tests (${det.cmd.label}) will run ${2 + n} to ${MAX_CLEAN_RUNS + 2 * n + CHECK_RUNS} times, in a temporary copy: ${ws.root}`);
    say("  Each bug is written only into that copy. Your repository is never changed.");
    say("  Your tests can still reach what they normally reach: the network, databases, environment variables.");
    say("  So run this where you would run your tests anyway.");
    say();
    // asked only at a terminal: a script or CI job that calls the CLI has already chosen to run it
    if (!values.yes && process.stdin.isTTY && !(await ask("Run your tests in that copy? [y/N] "))) { say("Nothing ran."); return 0; }

    const env = testEnv(process.env);
    if (det.language === "typescript" && det.cmd.builds?.length) {     // a project whose type check already fails still runs: the check just cannot judge a bug
      ws.fresh();
      const probe = await runSuite({ ...det.cmd, argv: ["true"], format: "exit" }, { wt: ws.wt, root: ws.root, env, timeoutMs: timeoutMs ?? 20 * 60_000 });
      if (probe.installFailed) { det.cmd.builds = []; say("The type check already fails on a clean copy, so it is skipped."); }
    }
    const opts = (timeout: number, file?: string) => ({ wt: ws.wt, root: ws.root, env, timeoutMs: timeout, parseCheck: file ? parseCheck(det.language, det.cmd, file) : undefined });
    const runs: Ran[] = [];
    for (const n of [1, 2]) {
      process.stdout.write(`Clean run ${n} of 2: `);
      ws.fresh();
      const r = await runSuite(det.cmd, opts(timeoutMs ?? 20 * 60_000));
      runs.push(r);
      say(r.killed !== null ? `stopped at the time limit after ${seconds(r.ms)}` : r.failing && r.total ? `${r.total - r.failing.F.length - r.failing.E.length} of ${r.total} passed in ${seconds(r.ms)}` : r.testFailed || r.installFailed ? "failed" : `passed in ${seconds(r.ms)}`);
    }
    const exitOnly = det.cmd.format === "exit";
    // a test failing twice may only be flaky: two more runs, so one unstable test doesn't stop the whole check
    const settled = () => runs.every((r) => !r.installFailed && r.killed === null && r.failing && r.total !== 0);
    for (let n = 3; n <= MAX_CLEAN_RUNS && !exitOnly && settled() && failedEvery(runs).length; n++) {
      process.stdout.write(`Clean run ${n} of ${MAX_CLEAN_RUNS}, as ${failedEvery(runs).length === 1 ? "a test" : "some tests"} failed both times: `);
      ws.fresh();
      const r = await runSuite(det.cmd, opts(timeoutMs ?? 20 * 60_000));
      runs.push(r);
      say(r.killed !== null ? `stopped at the time limit after ${seconds(r.ms)}` : `${seconds(r.ms)}`);
    }
    refuseBaseline(runs, !!values["allow-failing"], exitOnly, (logs) => [copyHint(repo, ws.wt, logs), values["test-cmd"] ? "" : partsHint(repo, det.language)]);
    const base = baseline(runs);
    const flaky = [...base.flakyF, ...base.flakyE];
    const setAside = [...base.baseF, ...base.baseE].filter((t) => !flaky.includes(t));
    if (flaky.length) say(`${flaky.length} flaky ${flaky.length === 1 ? "test" : "tests"} left out: failed on some clean runs, not all.`);
    if (setAside.length) say(`${setAside.length} already failing, set aside.`);

    if (told.sends) {
      say();
      say(`About to send code to: ${told.to}`);
      say(`What it can read: ${view.files.length} files from your last commit, with the tests taken out (--list-files shows them).`);
      say("Nothing goes to Trenyx.");
      if ((process.env.HTTPS_PROXY ?? process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) say("HTTPS_PROXY is set, but Node ignores it unless NODE_USE_ENV_PROXY=1 is set too.");
      if (!values.yes) {
        if (!(await ask("Continue? [y/N] "))) { say("Nothing sent."); return 0; }
      }
    }
    const kinds = await bundledCatalogue.load({ language: det.language, fileTypes: [...new Set(view.sourceFiles.map((f) => path.extname(f)))] });
    const catalogue = drawKinds(kinds, seed);
    if (told.sends) say(`Bug kinds: ${catalogue.length} of ${kinds.length}, drawn with seed ${seed}. --seed ${seed} draws the same ones.`);
    say(told.sends ? `Writing ${count} bugs...` : "Reading the saved bug list.");
    const asked = told.sends ? Math.min(count + 2, MAX_BUGS + 2) : count;
    const enforced = told.sends ? spread : undefined;           // a saved list is the developer's own, and runs as written
    const input = { view, language: det.language, count: asked, catalogue, suite: det.cmd.label, spread: enforced, model: values.model, scratch: ws.root, abort };
    const budget = maxCost * (1 - COST_MARGIN);
    const written = await writer.write({ ...input, maxCostUsd: budget, limitUsd: maxCost });
    let bugs = written.bugs, cost = written.costUsd, secondNote = "";
    let { kept, dropped } = validate(bugs, ws.pristine(), view, count, enforced);
    const short = enforced ? gaps(kept, enforced) : [];
    // a full list inside the limits and one place off the plan is not worth paying to fix
    if (writer.topUp && (kept.length < count || short.reduce((a, g) => a + g.need, 0) > 1)) {
      const left = budget - (cost ?? 0);
      if (left < 0.05) secondNote = "your spending limit left nothing for a second pass";
      else {
        say(`${short.length} ${short.length === 1 ? "folder is" : "folders are"} short of the plan, so the writer gets one more pass, on those only.`);
        const more = await writer.topUp({ ...input, maxCostUsd: Math.min(left, maxCost * SECOND_PASS_SHARE), limitUsd: maxCost }, short, bugs);
        bugs = [...bugs, ...more.bugs];
        cost = (cost ?? 0) + (more.costUsd ?? 0);
        secondNote = more.note ?? "";
        ({ kept, dropped } = validate(bugs, ws.pristine(), view, count, enforced));
      }
    }
    if (!kept.length) throw new Stop(`None of the ${bugs.length} bugs could be applied to your code: ${dropped[0]?.why ?? "no reason given"}. Nothing ran.`);
    const missed = enforced ? gaps(kept, enforced) : [];
    const shortNote = !enforced ? "" : [
      kept.length < count ? `Only ${kept.length} of the ${count} bugs asked for could be placed.` : "",
      missed.length ? `Short of the plan in ${missed.map((g) => folderName(g.bucket)).join(", ")}.` : "",
      (missed.length || kept.length < count) && secondNote ? `Second pass: ${secondNote}.` : "",
    ].filter(Boolean).join(" ");
    const print = fingerprint(kept);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const out = path.resolve(values.out ?? path.join(os.homedir(), ".trenyx", "reports", `${path.basename(repo)}-${sha.slice(0, 7)}-${stamp}.md`));
    // saved before any bug runs, so a stopped run still leaves the list; a --bugs-file list is already saved, unless asked
    const bugsFile = values["save-bugs"] ? path.resolve(values["save-bugs"]) : values["bugs-file"] ? path.resolve(values["bugs-file"]) : `${out.replace(/\.md$/, "")}.bugs.json`;
    if (!values["bugs-file"] || values["save-bugs"]) {
      fs.mkdirSync(path.dirname(bugsFile), { recursive: true });
      fs.writeFileSync(bugsFile, JSON.stringify({ bugs: kept.map(({ id, title, kind, file, old, new: next }) => ({ id, title, kind, file, old, new: next })) }, null, 2) + "\n");
    }
    say();
    say(`Bug list fingerprint (SHA-256): ${print}`);
    if (!values["bugs-file"] || values["save-bugs"]) say(`Bug list saved: ${bugsFile}. To run the same bugs again later: trenyx run --bugs-file ${/\s/.test(bugsFile) ? JSON.stringify(bugsFile) : bugsFile}`);
    say(`${kept.length} bugs locked. Each runs alone in a throwaway copy.`);
    if (dropped.length) say(`${dropped.length} dropped before running (the report says why).`);
    say(enforced ? `Where the bugs went (planned from code size, never from the tests; ${spreadRule(spread)}):` : "Where the bugs went (a saved list runs as written, so no limits were applied):");
    spreadLines(spreadRows(spread, kept)).forEach((l) => say(l));
    if (shortNote) say(shortNote);

    const slowest = Math.max(...runs.map((r) => r.ms));
    const limit = timeoutMs ?? Math.max(120_000, slowest * 3);
    const outcomes: Outcome[] = [], pairs: { first: Ran; again: Ran }[] = [];
    for (const [i, bug] of kept.entries()) {
      process.stdout.write(`[${i + 1}/${kept.length}] ${bug.id} ${bug.file}:${bug.line}  `);
      ws.fresh();
      applyBug(bug, ws.wt);
      const first = await runSuite(det.cmd, opts(limit, bug.file));
      let v: Outcome["verdict"] = verdict(first, base), note = "", confirmed: string[] = [];
      if (v === "CAUGHT") {
        ws.fresh();
        applyBug(bug, ws.wt);
        const again = await runSuite(det.cmd, opts(limit, bug.file));
        ({ verdict: v, note } = settle(first, again, base));
        confirmed = sharedFailing(first, again, base);
        pairs.push({ first, again });
      } else if (v === "INSPECT") note = first.total !== null && base.baseTotal !== null && first.total < base.baseTotal ? `ran ${first.total} of ${base.baseTotal} tests: a test file may not have loaded` : "the test run failed, but no test newly failed";
      else if (v === "TIMEOUT") note = "stopped at the time limit with no new failing test";
      const failed = newFailing(first, base);
      const o: Outcome = { bug, verdict: v, note, tests: failed.length, names: failed, confirmed };
      outcomes.push(o);
      say(verdictWords(o));
    }

    if (!exitOnly && outcomes.some((o) => o.verdict === "CAUGHT")) {
      // a test that fails without any bug is not a catch: passing the first two clean runs doesn't show it can't
      const unstable = intermittent(pairs, base);
      for (let n = 1; n <= CHECK_RUNS; n++) {
        process.stdout.write(`Checking the catches, clean run ${n} of ${CHECK_RUNS}: `);
        ws.fresh();
        const r = await runSuite(det.cmd, opts(limit));
        for (const t of [...(r.failing?.F ?? []), ...(r.failing?.E ?? [])]) if (!base.baseF.has(t) && !base.baseE.has(t)) unstable.add(t);
        say(r.failing ? "done" : "no result");
      }
      for (const o of outcomes) {
        if (o.verdict === "CAUGHT" && unreliableCatch(o.confirmed ?? [], unstable)) {
          o.verdict = "UNRELIABLE";
          o.note = `${o.confirmed!.slice(0, 2).join(", ")}${o.confirmed!.length > 2 ? ` and ${o.confirmed!.length - 2} more` : ""}`;
          say(`${o.bug.id}: ${verdictWords(o)}: ${o.note}`);
        }
      }
    }

    let repoChanged = false;
    try { repoChanged = repoState() !== before; } catch { repoChanged = true; }
    const summary: Summary = {
      repo: path.basename(repo), sha, dirty, repoChanged, coverage, bugsFile, language: LANG_NAME[det.language], suite: det.cmd.label, exitOnly, testCount: base.baseTotal, flaky, setAside,
      fingerprint: print, outcomes, dropped, sentTo: told.sends ? told.to : null, model: written.model, costUsd: cost,
      spread: {
        rows: spreadRows(spread, kept, (b) => outcomes.find((o) => o.bug === b)?.verdict ?? ""), rule: spreadRule(spread), enforced: !!enforced, short: shortNote,
      },
      draw: told.sends ? { seed, used: catalogue.length, of: kinds.length } : undefined,
    };
    say(terminalReport(summary));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, markdownReport(summary));
    say(`Report: ${out}`);
    return score(summary).counted ? 0 : 1;
  } finally {
    ws.destroy();
  }
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parse>;
  try { args = parse(process.argv.slice(2)); } catch (e) { process.stderr.write(`${(e as Error).message}\n\n${HELP}\n`); process.exit(2); }
  if (args.values.version) { say(VERSION); return; }
  if (args.values.help || args.positionals[0] !== "run") { say(HELP); process.exit(args.values.help ? 0 : 2); }
  try {
    process.exitCode = await run(args.values);
  } catch (e) {
    if (e instanceof Stop) { process.stderr.write(`\n${e.message}\n`); process.exitCode = 1; return; }
    if ((e as NodeJS.ErrnoException).code === "ABORT_ERR") { process.exitCode = 130; return; }
    throw e;
  }
}


await main();
