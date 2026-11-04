import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { baseline, intermittent, settle, sharedFailing, unreliableCatch, verdict, type Baseline, type Cell } from "../src/verdict.js";

const cell = (o: Partial<Cell> = {}): Cell => ({ installFailed: false, failing: { F: [], E: [] }, killed: null, total: 5, testFailed: false, ...o });
// The parity check runs only where the engine is available: set TRENYX_ENGINE_VERDICT to its verdict module (a .py file).
const ENGINE = process.env.TRENYX_ENGINE_VERDICT ?? "";

const SCENARIOS: [string, Partial<Cell>][] = [
  ["clean pass", {}],
  ["new failing test", { failing: { F: ["t1"], E: [] }, testFailed: true }],
  ["only a baseline failure", { failing: { F: ["base"], E: [] }, testFailed: true }],
  ["only a flaky test", { failing: { F: ["flaky"], E: [] }, testFailed: true }],
  ["new errored test only", { failing: { F: [], E: ["e1"] }, testFailed: true }],
  ["test step failed, nothing newly failing", { testFailed: true }],
  ["broken build", { installFailed: true, failing: null }],
  ["no report", { failing: null, testFailed: true }],
  ["fewer tests ran", { total: 3 }],
  ["hang, no report", { failing: null, killed: 124, testFailed: true }],
  ["hang, partial report with a new failure", { failing: { F: ["t1"], E: [] }, killed: 124, testFailed: true }],
  ["hang, partial report with no new failure", { killed: 124, testFailed: true }],
  ["hang, partial report with a new error", { failing: { F: [], E: ["e1"] }, killed: 124, testFailed: true }],
];
const BASES: [string, Baseline][] = [
  ["clean", baseline([cell(), cell()])],
  ["one flaky test", baseline([cell({ failing: { F: ["flaky"], E: [] }, testFailed: true }), cell()])],
  ["one solid failure", baseline([cell({ failing: { F: ["base"], E: [] }, testFailed: true }), cell({ failing: { F: ["base"], E: [] }, testFailed: true })])],
];

describe("verdict", () => {
  it("matches the engine's own function on every scenario", { skip: ENGINE && fs.existsSync(ENGINE) ? false : "engine not present (set TRENYX_ENGINE_VERDICT to run this parity check)" }, () => {
    const cases = BASES.flatMap(([bn, b]) => SCENARIOS.map(([sn, s]) => {
      const c = cell(s);
      return {
        name: `${bn} / ${sn}`, ours: verdict(c, b),
        info: { state: "DONE", install_failed: c.installFailed, failing: c.failing, killed: c.killed ?? 0, total: c.total, tests: { test_step: c.testFailed ? "failure" : "success", failed_steps: c.testFailed ? ["Test"] : [] } },
        baseF: [...b.baseF], baseE: [...b.baseE], flakyF: [...b.flakyF], flakyE: [...b.flakyE], baseTestFailed: b.baseTestFailed, baseTotal: b.baseTotal,
      };
    }));
    const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.dirname(ENGINE))})
import ${path.basename(ENGINE, ".py")} as e
for c in json.load(sys.stdin):
    v = e.verdict(c["info"], set(c["baseF"]), set(c["baseE"]), c["baseTestFailed"], set(c["flakyF"]), set(c["flakyE"]), base_total=c["baseTotal"])[0]
    print(c["name"] + "|" + c["ours"] + "|" + v)
`;
    const lines = execFileSync("python3", ["-c", py], { input: JSON.stringify(cases), encoding: "utf8" }).trim().split("\n");
    assert.equal(lines.length, cases.length);
    for (const l of lines) { const [n, ours, theirs] = l.split("|"); assert.equal(ours, theirs, n); }
  });

  it("a catch counts only when the re-run fails one of the same tests", () => {
    const b = baseline([cell(), cell()]), first = cell({ failing: { F: ["t1", "t2"], E: [] }, testFailed: true });
    assert.equal(settle(first, cell({ failing: { F: ["t2"], E: [] }, testFailed: true }), b).verdict, "CAUGHT");
    assert.equal(settle(first, cell(), b).verdict, "FLAKY");
    assert.equal(settle(first, cell({ failing: { F: ["other"], E: [] }, testFailed: true }), b).verdict, "FLAKY");
    assert.equal(settle(first, cell({ installFailed: true, failing: null }), b).verdict, "INSPECT");
    assert.equal(settle(first, cell({ failing: null, killed: 124 }), b).verdict, "TIMEOUT");
    const hung = cell({ failing: { F: ["t1"], E: [] }, killed: 124 });
    assert.equal(settle(hung, cell({ failing: { F: ["t1"], E: [] }, killed: 124 }), b).verdict, "CAUGHT");
  });

  it("baseline: any failure is never a catch, only some-of-the-runs is flaky", () => {
    const b = baseline([cell({ failing: { F: ["a", "f"], E: [] }, testFailed: true }), cell({ failing: { F: ["a"], E: [] }, testFailed: true })]);
    assert.deepEqual([...b.baseF].sort(), ["a", "f"]);
    assert.deepEqual([...b.flakyF], ["f"]);
    assert.equal(b.baseTestFailed, true);
    assert.equal(b.baseTotal, 5);
  });
});

describe("catches that rest on an unstable test", () => {
  const base = baseline([cell(), cell()]);
  const fails = (...F: string[]) => cell({ failing: { F, E: [] }, testFailed: true });

  it("a test that fails on one of a bug's two runs is unstable", () => {
    const got = intermittent([{ first: fails("steady", "wobbly"), again: fails("steady") }, { first: fails("a"), again: fails("a", "b") }], base);
    assert.deepEqual([...got].sort(), ["b", "wobbly"]);
  });

  it("a hung or reportless run says nothing about stability", () => {
    assert.equal(intermittent([{ first: fails("t"), again: cell({ failing: { F: [], E: [] }, killed: 1 }) }, { first: fails("t"), again: cell({ failing: null }) }], base).size, 0);
  });

  it("the catch rests on what both runs failed", () => {
    assert.deepEqual(sharedFailing(fails("a", "b"), fails("b", "c"), base), ["b"]);
  });

  it("one reliable test keeps a catch; only unstable ones lose it", () => {
    const unstable = new Set(["poll"]);
    assert.equal(unreliableCatch(["poll"], unstable), true);
    assert.equal(unreliableCatch(["poll", "real"], unstable), false);
    assert.equal(unreliableCatch([], unstable), false);
  });
});
