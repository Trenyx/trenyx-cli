import type { SpreadRow } from "./spread.js";
import type { Bug } from "./types.js";
import type { Verdict } from "./verdict.js";

export const LABEL = "This is a self-run score, not an independent Trenyx result.";
export const AI_NOTICE = "AI output can be wrong. Check the bugs and this score before you rely on them.";

export const REPO_CHANGED = "WARNING: your repository changed while this ran: its git status or commit is not what it was at the start. "
  + "Bugs are written only into the temporary copy, so something else changed it, such as your tests or an edit made during the run. Check git status.";

export interface Outcome { bug: Bug; verdict: Verdict; note: string; tests: number; names?: string[]; confirmed?: string[] }

export interface Summary {
  repo: string;
  sha: string;
  dirty: boolean;
  /** git status or HEAD of the developer's repository differed after the run from before it. */
  repoChanged?: boolean;
  /** The test command runs only part of the code: the plain warning, or empty. */
  coverage?: string;
  /** The saved bug list: --bugs-file runs the same bugs again. */
  bugsFile?: string;
  language: string;
  suite: string;
  exitOnly: boolean;
  testCount: number | null;
  flaky: string[];
  setAside: string[];
  fingerprint: string;
  outcomes: Outcome[];
  dropped: { bug: Bug; why: string }[];
  sentTo: string | null;
  model: string | null;
  costUsd: number | null;
  spread?: { rows: SpreadRow[]; rule: string; enforced: boolean; short: string };
  draw?: { seed: string; used: number; of: number };
}

const WORDS: Record<Verdict, string> = {
  CAUGHT: "caught", ESCAPED: "got through", "BUILD-BREAK": "did not build, not counted", TIMEOUT: "hung the tests, not counted",
  INSPECT: "unclear, not counted", FLAKY: "caught once but not twice, not counted",
  UNRELIABLE: "caught only by a test that also fails without the bug, not counted",
};

export const verdictWords = (o: Outcome) => (o.verdict === "CAUGHT" ? `caught (${o.tests} ${o.tests === 1 ? "test" : "tests"})` : WORDS[o.verdict]);

export function score(s: Summary): { caught: number; counted: number } {
  const caught = s.outcomes.filter((o) => o.verdict === "CAUGHT").length;
  return { caught, counted: caught + s.outcomes.filter((o) => o.verdict === "ESCAPED").length };
}

const NUMBER = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];

/** With nothing left out, the score. With bugs left out, the score and how far they could move it. */
export function scoreLine(s: Summary): string {
  const { caught, counted } = score(s), left = s.outcomes.length - counted;
  if (!left) return `${caught} of ${counted} bugs caught.`;
  return `${caught} of ${counted} counted; ${caught} to ${caught + left} of ${counted + left} if ${left === 1 ? "that one counts" : `those ${NUMBER[left] ?? left} count`}.`;
}

const Z80 = 1.2816;    // two-sided 80% normal quantile

/** Wilson interval on caught / counted at 80%, as whole bugs, never leaving out the score itself. Null with nothing counted. */
export function likelyRange(caught: number, counted: number): [number, number] | null {
  if (counted <= 0) return null;
  const p = caught / counted, z2 = Z80 * Z80, d = 1 + z2 / counted;
  const mid = (p + z2 / (2 * counted)) / d;
  const half = (Z80 * Math.sqrt((p * (1 - p)) / counted + z2 / (4 * counted * counted))) / d;
  return [Math.min(caught, Math.round((mid - half) * counted)), Math.max(caught, Math.round((mid + half) * counted))];
}

/** How far the score could move on another draw of bugs. A bug left out of the count is a separate matter: see scoreLine. */
export function likelyLine(s: Summary): string | null {
  const { caught, counted } = score(s), range = likelyRange(caught, counted);
  return range ? `Likely between ${range[0]} and ${range[1]} of ${counted} if different bugs were drawn.` : null;
}

const where = (b: Bug) => `${b.file}:${b.line ?? "?"}`;
const through = (s: Summary) => s.outcomes.filter((o) => o.verdict === "ESCAPED");
const uncounted = (s: Summary) => s.outcomes.filter((o) => !["CAUGHT", "ESCAPED"].includes(o.verdict));

function sentLine(s: Summary): string {
  return s.sentTo ? `Code read by: ${s.sentTo}${s.model ? `, model ${s.model}` : ""}. Nothing went to Trenyx.` : "No code was sent anywhere.";
}

export function terminalReport(s: Summary): string {
  const likely = likelyLine(s);
  const out = ["", ...(s.repoChanged ? [REPO_CHANGED, ""] : []), `Score: ${scoreLine(s)}`, ...(likely ? [likely] : []), ...(s.coverage ? [s.coverage] : []), LABEL, AI_NOTICE];
  if (through(s).length) {
    out.push("", "Got through your tests:");
    for (const o of through(s)) {
      out.push(`  ${o.bug.id}  ${where(o.bug)}`, `        ${o.bug.title}`);
    }
  }
  if (uncounted(s).length) {
    out.push("", "Not counted:");
    for (const o of uncounted(s)) out.push(`  ${o.bug.id}  ${where(o.bug)}  ${WORDS[o.verdict]}${o.note ? `: ${o.note}` : ""}`);
  }
  if (s.exitOnly) out.push("", "Your test command gives only pass or fail here, so a crash reads the same as a failing test.");
  out.push("", sentLine(s));
  if (s.costUsd !== null) out.push(`AI cost on your account: about US$${s.costUsd.toFixed(2)}.`);
  if (s.draw) out.push(`Bug kinds: ${s.draw.used} of ${s.draw.of}, seed ${s.draw.seed}.`);
  return out.join("\n");
}

/** Where the bugs went, for the run's output. The share is of the code in the plan. */
export function spreadLines(rows: SpreadRow[]): string[] {
  const wide = Math.max(...rows.map((r) => r.folder.length));
  return rows.map((r) => `  ${String(r.placed).padStart(2)}  ${r.folder.padEnd(wide)}  ${Math.round(r.share * 100)}% of the code`);
}

function spreadSection(s: NonNullable<Summary["spread"]>): string[] {
  const head = s.enforced ? `Planned from how much code each folder holds, never from the tests: ${s.rule}.` : "A saved list runs as written, so these limits were not applied.";
  const out = ["", "## Where the bugs went", "", `${head}${s.short ? ` ${s.short}` : ""}`, ""];
  out.push("| Folder | Share of code | Planned | Placed | Caught | Got through |", "|---|---:|---:|---:|---:|---:|");
  for (const r of s.rows) out.push(`| \`${r.folder}\` | ${Math.round(r.share * 100)}% | ${s.enforced ? r.planned : "-"} | ${r.placed} | ${r.caught} | ${r.through} |`);
  return out;
}

const fence = (text: string, lang = "") => {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

export function markdownReport(s: Summary): string {
  const likely = likelyLine(s);
  const out = [`# Test check: ${s.repo} at ${s.sha.slice(0, 7)}`, "", `**Score: ${scoreLine(s)}**`, "", ...(likely ? [likely, ""] : []), `*${LABEL} ${AI_NOTICE}*`, ""];
  if (s.repoChanged) out.splice(2, 0, `**${REPO_CHANGED}**`, "");
  out.push(`- Code: commit ${s.sha}${s.dirty ? " (uncommitted changes were not included)" : ""}`);
  out.push(`- Tests: ${s.language}, \`${s.suite}\`${s.testCount !== null ? `, ${s.testCount} tests` : ""}`);
  if (s.coverage) out.push(`- ${s.coverage}`);
  out.push(`- Bug list fingerprint (SHA-256): \`${s.fingerprint}\``);
  if (s.bugsFile) out.push(`- Bug list: \`${s.bugsFile}\`. \`trenyx run --bugs-file ${s.bugsFile}\` runs the same bugs again; the fingerprint stays the same while they all still apply.`);
  out.push(`- ${sentLine(s)}`);
  if (s.costUsd !== null) out.push(`- AI cost on your account: about US$${s.costUsd.toFixed(2)}`);
  if (s.draw) out.push(`- Bug kinds: ${s.draw.used} of ${s.draw.of} drawn at random, seed \`${s.draw.seed}\`. \`--seed\` draws the same kinds; the AI still writes its own bugs from them.`);
  if (s.exitOnly) out.push("- Your test command gives only pass or fail here, so a crash reads the same as a failing test.");
  if (s.flaky.length) out.push(`- Left out as flaky (failed on some clean runs, not all): ${s.flaky.map((t) => `\`${t}\``).join(", ")}`);
  if (s.setAside.length) out.push(`- Already failing before any bug, set aside: ${s.setAside.map((t) => `\`${t}\``).join(", ")}`);
  if (s.spread) out.push(...spreadSection(s.spread));
  if (through(s).length) {
    out.push("", "## Got through your tests", "");
    for (const o of through(s)) {
      out.push(`### ${o.bug.id}: ${o.bug.title}`, "", `\`${where(o.bug)}\`${o.bug.kind ? ` (${o.bug.kind})` : ""}`, "");
      out.push(fence(`- ${o.bug.old.split("\n").join("\n- ")}\n+ ${o.bug.new.split("\n").join("\n+ ")}`, "diff"), "");
    }
  }
  const caughtRows = s.outcomes.filter((o) => o.verdict === "CAUGHT");
  if (caughtRows.length) {
    out.push("", "## Caught", "");
    for (const o of caughtRows) {
      const shown = (o.names ?? []).slice(0, 3).map((t) => `\`${t}\``).join(", ");
      out.push(`- ${o.bug.id}, \`${where(o.bug)}\`: ${o.bug.title} (${o.tests} ${o.tests === 1 ? "test" : "tests"}${shown ? `: ${shown}` : ""})`);
    }
  }
  if (uncounted(s).length) {
    out.push("", "## Not counted", "");
    for (const o of uncounted(s)) out.push(`- ${o.bug.id}, \`${where(o.bug)}\`: ${o.bug.title}. ${WORDS[o.verdict]}${o.note ? `: ${o.note}` : ""}`);
  }
  if (s.dropped.length) {
    out.push("", "## Dropped before running", "");
    for (const d of s.dropped) out.push(`- ${d.bug.title || d.bug.id}, \`${d.bug.file}\`: ${d.why}`);
  }
  return out.join("\n") + "\n";
}
