import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildView, type View } from "../src/blind.js";
import { validate } from "../src/bugs.js";
import { markdownReport, type Summary } from "../src/report.js";
import { gaps, notProduct, pickSpread, planSpread, spreadRows, type SpreadPlan } from "../src/spread.js";
import type { Bug } from "../src/types.js";
import { ownKeyWriter, topUpPrompt, writerPrompt } from "../src/writer.js";
import type { Provider } from "../src/provider.js";
import { cli, fakeClient, makeRepo, tempDir } from "./helpers.js";

/** A view holding these files, each with this many lines of code. */
function viewOf(files: Record<string, number>): View {
  const dir = tempDir();
  for (const [f, n] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n"));
  }
  return { dir, files: Object.keys(files), sourceFiles: Object.keys(files).sort() };
}

const bug = (id: string, file: string): Bug => ({ id, title: id, file, old: `old ${id}`, new: `new ${id}` });
const quotas = (p: SpreadPlan) => Object.fromEntries(p.buckets.filter((b) => b.quota).map((b) => [b.dir + (b.direct ? "*" : ""), b.quota]));
const sum = (p: SpreadPlan) => p.buckets.reduce((a, b) => a + b.quota, 0);

/** Twelve folders of three 200-line files, so nothing is forced. */
const wide = () => {
  const files: Record<string, number> = {};
  for (let d = 0; d < 12; d++) for (let f = 0; f < 3; f++) files[`src/d${String(d).padStart(2, "0")}/f${f}.ts`] = 200;
  return files;
};

describe("the spread plan", () => {
  it("places every bug, in proportion to the code", () => {
    const p = planSpread(viewOf({ "src/big/a.ts": 800, "src/big/b.ts": 800, "src/big/c.ts": 800, "src/small/a.ts": 400, "src/small/b.ts": 400, "src/tiny/a.ts": 400 }), "typescript", 16);
    assert.equal(sum(p), 16);
    assert.ok(p.buckets.find((b) => b.dir === "src/big")!.quota > p.buckets.find((b) => b.dir === "src/small")!.quota);
  });

  it("splits a folder holding most of the code, down through folders with nothing else in them", () => {
    const p = planSpread(viewOf({ "packages/a/src/x/one.ts": 500, "packages/a/src/y/two.ts": 500, "packages/b/src/z/three.ts": 500, "packages/a/src/own.ts": 500 }), "typescript", 8);
    assert.ok(p.buckets.length >= 4, JSON.stringify(p.buckets.map((b) => b.dir)));
    assert.ok(p.buckets.some((b) => b.direct && b.dir === "packages/a/src"), "the files beside the subfolders are a bucket of their own");
  });

  it("holds a folder to the limit when other folders can take the bugs", () => {
    const files: Record<string, number> = wide();
    for (let f = 0; f < 10; f++) files[`src/heavy/h${f}.ts`] = 90;     // 25% of the code, so a share the limit allows
    const p = planSpread(viewOf(files), "typescript", 16);
    assert.ok(p.buckets.every((b) => b.quota <= p.perFolder), JSON.stringify(quotas(p)));
  });

  it("lets a flat package keep its share: the bugs have nowhere else to go", () => {
    const files: Record<string, number> = { "pkg/sub/a.py": 100 };
    for (let f = 0; f < 12; f++) files[`pkg/m${f}.py`] = 300;
    const p = planSpread(viewOf(files), "python", 16);
    assert.ok(p.buckets.find((b) => b.dir === "pkg" && b.direct)!.quota > p.perFolder);
    assert.equal(sum(p), 16);
  });

  it("never plans more than the file limit, and loosens it only when the project is too small", () => {
    assert.equal(planSpread(viewOf(wide()), "typescript", 16).perFile, 2);
    const one = planSpread(viewOf({ "pricing.ts": 40 }), "typescript", 16);
    assert.equal(one.perFile, 16);
    assert.equal(sum(one), 16);
    const three = planSpread(viewOf({ "a.ts": 40, "b.ts": 40, "c.ts": 40 }), "typescript", 16);
    assert.equal(three.perFile, 6);
    assert.equal(sum(three), 16);
  });

  it("always adds up, whatever the shape", () => {
    for (const count of [1, 2, 3, 8, 16]) {
      for (const files of [wide(), { "a.ts": 1 }, { "x/a.ts": 5000, "y/b.ts": 1, "z/c.ts": 1 }, { "a/a.ts": 10, "a/b.ts": 10, "b/c.ts": 10 }]) {
        const p = planSpread(viewOf(files), "typescript", count);
        assert.equal(sum(p), count, JSON.stringify({ count, files: Object.keys(files) }));
        assert.ok(p.buckets.every((b) => b.quota <= b.files * p.perFile && b.quota <= b.cap));
      }
    }
  });

  it("keeps out what is not product code, by name and first lines only", () => {
    assert.match(notProduct(".claude/skills/x/a.ts", ""), /\.claude/);
    assert.match(notProduct("scripts/x.ts", ""), /scripts/);
    assert.match(notProduct("packages/web/scripts/x.ts", ""), /scripts/);
    assert.match(notProduct("examples/foo/src/x.ts", ""), /examples/);
    assert.match(notProduct("tools/gen.go", ""), /tools/);
    assert.match(notProduct("types.d.ts", ""), /type or config/);
    assert.match(notProduct("vite.config.ts", ""), /type or config/);
    assert.match(notProduct("api.go", "// Code generated by protoc-gen-go. DO NOT EDIT.\npackage api\n"), /generated/);
    assert.equal(notProduct("src/lib/features/playground/service.ts", ""), "", "a feature that shares a name with a support folder stays");
    assert.equal(notProduct("src/tools/run.py", ""), "");
  });

  it("does not read prose about generated things as generated code", () => {
    assert.equal(notProduct("src/env_key.rs", "use std::env;\nconst MARKER: &str = \"mirrord-internal-autogenerated\";\n"), "");
  });

  it("counts only the project's own language: another language's bugs could not be caught", () => {
    const p = planSpread(viewOf({ "main.go": 100, "cmd/run.go": 100, "web/app.ts": 9000 }), "go", 4);
    assert.equal(p.home.has("web/app.ts"), false);
    assert.equal(p.leftOut, 1);
    assert.equal(sum(p), 4);
  });

  it("falls back to the view when a developer points it at a support folder", () => {
    const p = planSpread(viewOf({ "scripts/a.ts": 100, "scripts/b.ts": 100 }), "typescript", 4);
    assert.equal(p.home.size, 2);
    assert.equal(sum(p), 4);
  });

  it("does not let one huge file steer the plan", () => {
    const p = planSpread(viewOf({ "data/table.ts": 90000, "core/a.ts": 700, "core/b.ts": 700, "core/c.ts": 700 }), "typescript", 16);
    assert.ok(p.buckets.find((b) => b.dir === "core")!.quota > p.buckets.find((b) => b.dir === "data")!.quota);
  });
});

describe("the plan stays blind", () => {
  const repo = () => {
    const d = tempDir();
    const put = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
    for (let i = 0; i < 6; i++) put(`src/m${i}/code.ts`, Array.from({ length: 40 * (i + 1) }, (_, k) => `export const v${k} = ${k};`).join("\n"));
    return { d, put };
  };
  const planOf = (d: string, lang: "typescript" | "rust" = "typescript") => {
    const p = planSpread(buildView(d, path.join(tempDir(), "view")), lang, 16);
    return JSON.stringify({ b: p.buckets, f: [...p.home], s: [...p.sizes], u: p.smallUnder, m: p.smallMost });
  };

  it("does not change when test files are added, grown or moved", () => {
    const { d, put } = repo();
    const before = planOf(d);
    put("src/m0/code.test.ts", "it('a', () => {});\n".repeat(5000));
    put("src/m1/__tests__/more.ts", "it('b', () => {});\n".repeat(5000));
    put("tests/e2e/everything.ts", "it('c', () => {});\n".repeat(5000));
    put("src/m2/testdata/case.ts", "export const c = 1;\n".repeat(5000));
    assert.equal(planOf(d), before);
  });

  it("does not count inline test modules: a Rust file's tests are gone from its size", () => {
    const { d, put } = repo();
    put("src/lib.rs", "pub fn one() -> u8 { 1 }\n");
    const before = planOf(d, "rust");
    put("src/lib.rs", `pub fn one() -> u8 { 1 }\n#[cfg(test)]\nmod tests {\n${"    #[test] fn t() { assert_eq!(super::one(), 1); }\n".repeat(500)}}\n`);
    assert.equal(planOf(d, "rust"), before);
  });

  it("takes no argument that could know about the tests", () => {
    assert.equal(planSpread.length, 3);
    const text = fs.readFileSync(new URL("../../src/spread.ts", import.meta.url), "utf8");
    assert.doesNotMatch(text.split("*/").slice(1).join("*/"), /from "\.\/(suite|verdict|detect|workspace|report)\.js"/);
  });
});

describe("enforcing the plan", () => {
  const plan = () => planSpread(viewOf(wide()), "typescript", 16);
  const fileIn = (d: number, f: number) => `src/d${String(d).padStart(2, "0")}/f${f}.ts`;

  it("a list that crowds one file keeps the limit and drops the rest, saying why", () => {
    const p = plan(), list = Array.from({ length: 6 }, (_, i) => bug(`B${i}`, fileIn(0, 0)));
    const { kept, dropped } = pickSpread(list, p, 16);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 4);
    assert.match(dropped[0]!.why, /limit of 2 in one file/);
  });

  it("a list that crowds one folder keeps the folder limit", () => {
    const p = plan(), list = [0, 1, 2].flatMap((f) => [bug(`A${f}`, fileIn(0, f)), bug(`B${f}`, fileIn(0, f))]);
    const { kept, dropped } = pickSpread(list, p, 16);
    assert.equal(kept.length, p.perFolder);
    assert.match(dropped[dropped.length - 1]!.why, /limit of \d+ in src\/d00/);
  });

  it("the plan's places fill before the extras, whatever the list's order", () => {
    const p = plan();
    const extras = [bug("X1", fileIn(0, 0)), bug("X2", fileIn(0, 1)), bug("X3", fileIn(0, 2))];
    const planned = p.buckets.flatMap((b, i) => Array.from({ length: b.quota }, (_, k) => bug(`P${i}${k}`, `${b.dir}/f${k % 3}.ts`)));
    const { kept } = pickSpread([...extras, ...planned], p, 16);
    assert.equal(kept.length, 16);
    assert.deepEqual(gaps(kept, p), []);
  });

  it("holds small files to their limit, so a list of the smallest files is not enough", () => {
    const files: Record<string, number> = {};
    for (let d = 0; d < 6; d++) { files[`src/d${d}/big.ts`] = 900; for (let f = 0; f < 3; f++) files[`src/d${d}/s${f}.ts`] = 20 + d * 3 + f * 40; }
    const p = planSpread(viewOf(files), "typescript", 16);
    assert.ok(p.smallMost < 16);
    const small = [...p.sizes].filter(([, n]) => n < p.smallUnder).map(([f]) => bug(f, f));
    assert.ok(small.length > p.smallMost);
    const { kept, dropped } = pickSpread(small, p, 16);
    assert.equal(kept.length, p.smallMost);
    assert.ok(dropped.some((d) => /small files/.test(d.why)));
  });

  it("a plan of only small files stays possible", () => {
    const files: Record<string, number> = { "big/a.ts": 500 };
    for (let f = 0; f < 12; f++) files[`small/s${f}.ts`] = 60;
    const p = planSpread(viewOf(files), "typescript", 16);
    const short = p.buckets.reduce((sum, b, i) => sum + Math.max(0, b.quota - [...p.sizes].filter(([g, n]) => p.home.get(g) === i && n >= p.smallUnder).length * p.perFile), 0);
    assert.ok(p.smallMost >= short);
  });

  it("refuses a bug outside the plan", () => {
    const view = viewOf({ "src/a.ts": 100, "scripts/b.ts": 100 });
    const { kept, dropped } = pickSpread([bug("B1", "scripts/b.ts")], planSpread(view, "typescript", 2), 2);
    assert.equal(kept.length, 0);
    assert.match(dropped[0]!.why, /outside the plan/);
  });

  it("names the folders still short", () => {
    const p = plan(), g = gaps([bug("B1", fileIn(0, 0))], p);
    assert.equal(g.reduce((a, x) => a + x.need, 0), 15);
    assert.ok(!g.some((x) => x.bucket.dir === "src/d00" && x.need === x.bucket.quota) || p.buckets.find((b) => b.dir === "src/d00")!.quota > 1);
  });

  it("validate checks the real file first, then applies the plan, and numbers what stands", () => {
    const src = tempDir();
    fs.writeFileSync(path.join(src, "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const view = { ...viewOf({ "a.ts": 3 }), sourceFiles: ["a.ts"] };
    const p = planSpread(view, "typescript", 2);
    const list = [{ id: "x", title: "x", file: "a.ts", old: "nowhere", new: "y" }, { id: "y", title: "y", file: "a.ts", old: "a = 1", new: "a = 2" }, { id: "z", title: "z", file: "a.ts", old: "b = 2", new: "b = 3" }, { id: "w", title: "w", file: "a.ts", old: "c = 3", new: "c = 4" }];
    const { kept, dropped } = validate(list, src, view, 2, p);
    assert.deepEqual(kept.map((b) => b.id), ["B01", "B02"]);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0]!.why, /not in the file/);
  });
});

describe("the writer and the plan, with a fake API client", () => {
  const anthropic: Provider = { id: "anthropic", name: "Anthropic", where: "api.anthropic.com", credential: "your ANTHROPIC_API_KEY" };
  const spend = (usd: number) => ({ output_tokens: usd * 50_000 });     // US$20 a million on the default model
  const keepGoing = [{ type: "tool_use", id: "t1", name: "list_files", input: {} }];
  const inputFor = (view: View, spread: SpreadPlan) => ({ view, language: "typescript" as const, count: 18, catalogue: [{ name: "n", how: "h" }], suite: "vitest", spread, maxCostUsd: 2, scratch: view.dir });
  const reply = '```json\n{"bugs": [{"id": "B01", "title": "t", "file": "src/d00/f0.ts", "old": "x", "new": "y"}]}\n```';

  it("states the plan, the limits and the spares", () => {
    const view = viewOf(wide()), spread = planSpread(view, "typescript", 16);
    const text = writerPrompt(inputFor(view, spread));
    assert.match(text, /write 18 bugs/);
    assert.match(text, /- src\/d00\/: 1 bug|- src\/d00\/: 2 bugs/);
    assert.match(text, /at most 2 in one file/);
    assert.match(text, /other 2 bugs are spares/);
    assert.match(text, /Open only what you need/);
    assert.doesNotMatch(text, /Spread the bugs across different files/);
  });

  it("the second pass asks only for what is short, inside the money left, and never repeats a bug", async () => {
    const view = viewOf(wide()), spread = planSpread(view, "typescript", 16), { client, requests, prompts } = fakeClient([{ text: reply, usage: spend(0.2) }]);
    const short = gaps([], spread).slice(0, 2);
    const r = await ownKeyWriter(anthropic, {}, client).topUp!({ ...inputFor(view, spread), maxCostUsd: 0.5 }, short, [bug("B09", "src/d05/f1.ts")]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.max_tokens, 25_000, "held to the money left");
    assert.equal(r.bugs.length, 1);
    assert.equal(r.costUsd, 0.2);
    assert.match(prompts()[0]!, new RegExp(`Write ${short.reduce((a, g) => a + g.need, 0)} more`));
    assert.match(prompts()[0]!, /src\/d05\/f1\.ts: B09/);
    assert.doesNotMatch(prompts()[0]!.split("Do not repeat these")[0]!, /src\/d11/);
  });

  it("a refusal on the second pass keeps the first list and is never reworded", async () => {
    const view = viewOf(wide()), spread = planSpread(view, "typescript", 16), { client, requests } = fakeClient([{ stop: "refusal", usage: spend(0.01) }]);
    const r = await ownKeyWriter(anthropic, {}, client).topUp!(inputFor(view, spread), gaps([], spread), []);
    assert.equal(requests.length, 1);
    assert.deepEqual(r.bugs, []);
    assert.match(r.note!, /declined/);
  });

  it("a second pass that dies or runs out of money keeps the first list, and its cost is counted", async () => {
    const view = viewOf(wide()), spread = planSpread(view, "typescript", 16);
    const out = fakeClient([{ content: keepGoing, usage: spend(0.4) }]);
    const r = await ownKeyWriter(anthropic, {}, out.client).topUp!({ ...inputFor(view, spread), maxCostUsd: 0.4 }, gaps([], spread), []);
    assert.equal(r.costUsd, 0.4);
    assert.match(r.note!, /spending limit/);
    const boom = fakeClient([{ error: new Error("connection lost") }]);
    const r2 = await ownKeyWriter(anthropic, {}, boom.client).topUp!(inputFor(view, spread), gaps([], spread), []);
    assert.deepEqual(r2.bugs, []);
    assert.match(r2.note!, /connection lost/);
  });

  it("a stop at the limit names the developer's limit and what was spent", async () => {
    const view = viewOf(wide()), spread = planSpread(view, "typescript", 16), { client } = fakeClient([{ content: keepGoing, usage: spend(4.6) }]);
    await assert.rejects(ownKeyWriter(anthropic, {}, client).write({ ...inputFor(view, spread), maxCostUsd: 4.5, limitUsd: 5 }), /--max-cost 5\) before a bug list came back, after about US\$4\.60/);
  });

  it("the second pass names the files already full, so it does not spend its bugs there", () => {
    const view = viewOf(wide()), spread = planSpread(view, "typescript", 16);
    const have = [bug("B1", "src/d00/f0.ts"), bug("B2", "src/d00/f0.ts"), bug("B3", "src/d00/f1.ts")];
    const text = topUpPrompt(inputFor(view, spread), gaps(have, spread), have);
    assert.match(text, /These files are full, so a new bug there is dropped: src\/d00\/f0\.ts\./);
    assert.doesNotMatch(text.split("Do not repeat these")[0]!.split("These files are full")[1]!, /f1\.ts/);
    assert.doesNotMatch(topUpPrompt(inputFor(view, spread), gaps([], spread), []), /These files are full/);
  });

  it("the second pass prompt keeps the same rules as the first", () => {
    const view = viewOf(wide()), spread = planSpread(view, "typescript", 16), text = topUpPrompt(inputFor(view, spread), gaps([], spread), []);
    for (const rule of [/EXACTLY ONCE/, /never from guesses about what is tested/, /It never adds a process/]) assert.match(text, rule);
  });
});

describe("showing the spread", () => {
  it("the report shows the plan, the placing and what the tests did in each folder", () => {
    const view = viewOf(wide()), p = planSpread(view, "typescript", 16);
    const a = bug("B01", "src/d00/f0.ts"), b = bug("B02", "src/d01/f0.ts");
    const verdicts: Record<string, string> = { B01: "CAUGHT", B02: "ESCAPED" };
    const rows = spreadRows(p, [a, b], (x) => verdicts[x.id]!);
    const row = (d: string) => rows.find((r) => r.folder.startsWith(d))!;
    assert.deepEqual([row("src/d00").placed, row("src/d00").caught, row("src/d00").through], [1, 1, 0]);
    assert.deepEqual([row("src/d01").placed, row("src/d01").caught, row("src/d01").through], [1, 0, 1]);
    const s: Summary = {
      repo: "r", sha: "a".repeat(40), dirty: false, language: "TypeScript", suite: "vitest", exitOnly: false, testCount: 3, flaky: [], setAside: [], fingerprint: "f",
      outcomes: [], dropped: [], sentTo: null, model: null, costUsd: null, spread: { rows, rule: "at most 2 in one file", enforced: true, short: "Short of the plan in src/d02/." },
    };
    const md = markdownReport(s);
    assert.match(md, /## Where the bugs went/);
    assert.match(md, /never from the tests: at most 2 in one file\. Short of the plan in src\/d02\//);
    assert.match(md, /\| `src\/d00\/` \| 8% \| \d \| 1 \| 1 \| 0 \|/);
    assert.match(markdownReport({ ...s, spread: { ...s.spread!, enforced: false } }), /saved list runs as written/);
  });

  it("a saved list runs as written, and the run says the limits were not applied", async () => {
    const { repo, tmp, base } = makeRepo("python");
    const list = path.join(base, "bugs.json"), out = path.join(base, "r.md");
    const edit = (id: string, old: string, next: string) => ({ id, title: id, file: "pricing.py", old, new: next });
    fs.writeFileSync(list, JSON.stringify({ bugs: [edit("B01", "total * 0.9", "total * 0.8"), edit("B02", "total >= 100", "total > 100"), edit("B03", "low, min(value, high)", "low, max(value, high)")] }));
    const r = await cli(repo, ["--bugs-file", list, "--timeout", "60", "--out", out], { tmp });
    assert.match(r.out, /3 bugs locked/);
    assert.match(r.out, /a saved list runs as written/);
    assert.match(fs.readFileSync(out, "utf8"), /A saved list runs as written, so these limits were not applied/);
  });

  it("--bugs stays capped", async () => {
    const { repo, tmp } = makeRepo("python");
    const r = await cli(repo, ["--bugs", "17"], { tmp });
    assert.equal(r.code, 1);
    assert.match(r.err, /from 1 to 16/);
  });

  it("a bug from a saved list outside the plan is still shown", () => {
    const p = planSpread(viewOf({ "src/a.ts": 100, "scripts/b.ts": 100 }), "typescript", 1);
    assert.equal(spreadRows(p, [bug("B1", "scripts/b.ts")])[0]!.folder, "(outside the plan)");
  });
});
