/** The engine's verdict rules, for a suite run on this machine. test/verdict.test.ts checks this port
 * against the engine's own function, scenario by scenario, when the engine is present. */
export interface Failing { F: string[]; E: string[] }

export interface Cell {
  installFailed: boolean;      // the build or parse check failed
  failing: Failing | null;     // the report's failing tests; null when there is no report
  killed: number | null;       // set when the suite hung and was stopped
  total: number | null;
  testFailed: boolean;         // the test command exited non-zero
}

export type Verdict = "CAUGHT" | "ESCAPED" | "BUILD-BREAK" | "TIMEOUT" | "INSPECT" | "FLAKY" | "UNRELIABLE";

export interface Baseline {
  baseF: Set<string>;          // failed on ANY baseline: never a catch
  baseE: Set<string>;
  flakyF: Set<string>;         // failed on some baselines but not all
  flakyE: Set<string>;
  baseTestFailed: boolean;     // the test command failed on EVERY whole baseline
  baseTotal: number | null;
}

export function baseline(runs: Cell[]): Baseline {
  const ran = runs.filter((c) => c.failing), whole = ran.filter((c) => c.killed === null);
  const union = (k: "F" | "E") => new Set(ran.flatMap((c) => c.failing![k]));
  const every = (k: "F" | "E") => whole.length ? whole.map((c) => new Set(c.failing![k])).reduce((a, b) => new Set([...a].filter((x) => b.has(x)))) : new Set<string>();
  const baseF = union("F"), baseE = union("E"), allF = every("F"), allE = every("E");
  const totals = whole.map((c) => c.total);
  return {
    baseF, baseE, flakyF: new Set([...baseF].filter((x) => !allF.has(x))), flakyE: new Set([...baseE].filter((x) => !allE.has(x))),
    baseTestFailed: whole.length > 0 && whole.every((c) => c.testFailed),
    baseTotal: totals.length && totals.every((t) => t !== null) ? Math.min(...(totals as number[])) : null,
  };
}

const minus = (a: string[], b: Set<string>) => a.filter((x) => !b.has(x));
export const newFailing = (c: Cell, b: Baseline) => (c.failing ? minus(c.failing.F, b.baseF) : []);

/** The first run's verdict. A CAUGHT here still needs its re-run: see settle(). */
export function verdict(c: Cell, b: Baseline): Exclude<Verdict, "FLAKY"> {
  if (c.installFailed) return "BUILD-BREAK";
  const fl = c.failing;
  if (c.killed !== null) {             // a hang counts on the new failing tests of its partial report, or not at all
    if (!fl) return "TIMEOUT";
    if (minus(fl.F, b.baseF).length) return "CAUGHT";
    return minus(fl.E, b.baseE).length ? "INSPECT" : "TIMEOUT";
  }
  if (!fl) return "BUILD-BREAK";
  if (minus(fl.F, b.baseF).length) return "CAUGHT";
  if (minus(fl.E, b.baseE).length) return "INSPECT";
  if (fl.F.some((x) => b.flakyF.has(x)) || fl.E.some((x) => b.flakyE.has(x))) return "INSPECT";
  if (c.testFailed && !b.baseTestFailed) return "INSPECT";
  if (b.baseTotal !== null && c.total !== null && c.total < b.baseTotal) return "INSPECT";
  return "ESCAPED";
}

/** A catch counts only when its re-run fails at least one of the same new tests. */
export function settle(first: Cell, again: Cell, b: Baseline): { verdict: Verdict; note: string } {
  const one = new Set(newFailing(first, b)), hung2 = again.killed !== null;
  const shared = newFailing(again, b).filter((x) => one.has(x));
  if (shared.length) return { verdict: "CAUGHT", note: first.killed !== null || hung2 ? "it hung, and its re-run failed the same tests" : "" };
  if (!again.installFailed && again.failing && !hung2) return { verdict: "FLAKY", note: "caught once, but not on the re-run" };
  if (hung2) return { verdict: "TIMEOUT", note: "caught once, then its re-run hung before failing the same tests" };
  return { verdict: "INSPECT", note: "caught once, but its re-run gave no result either way" };
}

/** The new tests both runs of one bug failed: the ones a catch rests on. */
export function sharedFailing(first: Cell, again: Cell, b: Baseline): string[] {
  const one = new Set(newFailing(first, b));
  return newFailing(again, b).filter((x) => one.has(x));
}

/** Tests that went both ways on identical code: a bug's two runs are the same code, so a test failing on one of them only is
 * unstable, whatever the bug. Two passing clean runs can't show this: a test that fails half the time passes both a quarter
 * of the time, and then reads as a catch for any bug (nanoclaw, 11-02: one such test "caught" four unrelated bugs). */
export function intermittent(pairs: { first: Cell; again: Cell }[], b: Baseline): Set<string> {
  const out = new Set<string>();
  for (const { first, again } of pairs) {
    if (!first.failing || !again.failing || first.killed !== null || again.killed !== null) continue;
    const one = new Set(newFailing(first, b)), two = new Set(newFailing(again, b));
    for (const t of one) if (!two.has(t)) out.add(t);
    for (const t of two) if (!one.has(t)) out.add(t);
  }
  return out;
}

/** A catch resting only on tests that also fail without the bug is no catch. One reliable test keeps it. */
export const unreliableCatch = (confirmed: string[], unstable: Set<string>) => confirmed.length > 0 && confirmed.every((t) => unstable.has(t));
