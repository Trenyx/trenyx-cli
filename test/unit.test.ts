import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { buildView, isTestPath, stripRust } from "../src/blind.js";
import { applyBug, fingerprint, insideCopy, validate } from "../src/bugs.js";
import { bundledCatalogue, drawKinds, newSeed } from "../src/catalogue.js";
import { detect, fromTestCmd, parseCheck } from "../src/detect.js";
import { costOf } from "../src/loop.js";
import { detectProvider, sealEnv } from "../src/provider.js";
import { AI_NOTICE, likelyLine, likelyRange, markdownReport, score, scoreLine, terminalReport, type Summary } from "../src/report.js";
import { parseCargoText, parseGoJson, parseJestJson, parseJunit, parseUnittestText, runProcess, testEnv } from "../src/suite.js";
import { Stop, type Bug } from "../src/types.js";
import { TOOLS, runTool, toolDecision } from "../src/tools.js";
import { DEFAULT_MODEL, SYSTEM, ownKeyWriter, parseBugs, savedListWriter, writerPrompt } from "../src/writer.js";
import { CLI_DIR, FIXTURES, fakeClient, makeRepo, tempDir } from "./helpers.js";

const tmp = () => tempDir();
const anthropic = detectProvider({ ANTHROPIC_API_KEY: "k" })!;

describe("provider", () => {
  it("prefers the API key, then Bedrock, then Vertex, and refuses with none", () => {
    assert.equal(detectProvider({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1" })!.id, "anthropic");
    assert.equal(detectProvider({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" })!.where, "us-east-1");
    assert.equal(detectProvider({ CLAUDE_CODE_USE_VERTEX: "1" })!.id, "vertex");
    assert.equal(detectProvider({ CLAUDE_CODE_USE_BEDROCK: "0" }), null);
    assert.equal(detectProvider({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), null, "a subscription token is not a key");
  });
  it("names a custom endpoint on screen", () => {
    assert.equal(detectProvider({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://llm.corp.example/v1" })!.where, "llm.corp.example");
  });
  it("names where a Bedrock or Vertex override really sends the code", () => {
    assert.equal(detectProvider({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "https://gw.corp.example/x" })!.where, "gw.corp.example");
    assert.equal(detectProvider({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_BASE_URL: "https://gv.corp.example/v1" })!.where, "gv.corp.example");
  });
  it("seals out everything an Anthropic SDK would read for itself, and leaves other providers' settings for the tests", () => {
    const shell = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "u", ANTHROPIC_MODEL: "m", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_CUSTOM_HEADERS: "Authorization: x", ANTHROPIC_PROFILE: "p", ANTHROPIC_FEDERATION_RULE_ID: "r", ANTHROPIC_LOG: "debug", ANTHROPIC_OPEN_TELEMETRY: "true", PATH: "/bin", AWS_SECRET_ACCESS_KEY: "s" };
    const a: Record<string, string | undefined> = { ...shell };
    sealEnv(anthropic, a);
    assert.deepEqual(Object.keys(a).sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "AWS_SECRET_ACCESS_KEY", "PATH"]);
    const b: Record<string, string | undefined> = { ...shell, CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "u" };
    sealEnv(detectProvider({ CLAUDE_CODE_USE_BEDROCK: "1" })!, b);
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"]) assert.equal(b[k], undefined, k);
    assert.equal(b.ANTHROPIC_BEDROCK_MANTLE_BASE_URL, "u");
    const v: Record<string, string | undefined> = { ANTHROPIC_VERTEX_PROJECT_ID: "p", ANTHROPIC_AUTH_TOKEN: "t", CLOUD_ML_REGION: "r" };
    sealEnv(detectProvider({ CLAUDE_CODE_USE_VERTEX: "1" })!, v);
    assert.deepEqual(v, { ANTHROPIC_VERTEX_PROJECT_ID: "p", CLOUD_ML_REGION: "r" });
  });
  it("keeps the AI key away from the tests and the bugs", () => {
    const e = testEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "x", GIT_DIR: "y", PATH: "/bin" });
    assert.equal(e.ANTHROPIC_API_KEY, undefined);
    assert.equal(e.GIT_DIR, undefined);
    assert.equal(e.PATH, "/bin");
    assert.equal(e.PYTHONDONTWRITEBYTECODE, "1");
  });
});

describe("writer, with a fake API client", () => {
  const reply = '```json\n{"bugs": [{"id": "B01", "title": "t", "file": "a.py", "old": "x", "new": "y"}]}\n```';
  const view = { dir: "", files: [] as string[], sourceFiles: [] as string[] };
  const input = (dir: string) => ({ view: { ...view, dir }, language: "python" as const, count: 8, catalogue: [{ name: "n", how: "h" }], suite: "pytest", maxCostUsd: 5, scratch: dir });
  const read = (id: string, p: string) => ({ type: "tool_use", id, name: "read_file", input: { path: p } });
  const spend = (usd: number) => ({ output_tokens: usd * 50_000 });     // US$20 a million on the default model

  it("returns the bug list, takes its cost from the usage, and sends only what is meant to go", async () => {
    const { client, requests } = fakeClient([{ text: reply, usage: spend(0.25) }]);
    const r = await ownKeyWriter(anthropic, {}, client).write(input(tmp()));
    assert.equal(r.bugs.length, 1);
    assert.equal(r.costUsd, 0.25);
    assert.equal(r.model, DEFAULT_MODEL);
    const q = requests[0] as unknown as Record<string, unknown>;
    assert.deepEqual((q.tools as { name: string }[]).map((t) => t.name), ["list_files", "read_file", "search"]);
    assert.deepEqual(q.thinking, { type: "adaptive" });
    assert.deepEqual(q.output_config, { effort: "medium" }, "the setting the scores so far were measured at");
    assert.deepEqual(q.cache_control, { type: "ephemeral" });
    assert.equal(q.system, SYSTEM);
    assert.equal(q.fallbacks, undefined, "a refusal is never rerouted to another model");
    assert.deepEqual(Object.keys(q).sort(), ["cache_control", "max_tokens", "messages", "model", "output_config", "system", "thinking", "tools"], "a new field is a decision, not an accident");
  });

  it("no tool can write, run anything or reach a network", () => {
    assert.deepEqual(TOOLS.map((t) => t.name), ["list_files", "read_file", "search"]);
    for (const t of TOOLS) {
      assert.equal((t.input_schema as { additionalProperties?: boolean }).additionalProperties, false, t.name);
      assert.equal((t as { type?: string }).type, undefined, `${t.name} is ours, not a server tool`);
    }
  });

  it("the provider's model name fits the provider", async () => {
    for (const [env, id, want] of [[{ CLAUDE_CODE_USE_BEDROCK: "1" }, "bedrock", "anthropic.claude-opus-5-5"], [{ CLAUDE_CODE_USE_VERTEX: "1" }, "vertex", "claude-opus-5-5"]] as const) {
      const p = detectProvider(env)!, { client, requests } = fakeClient([{ text: reply }]);
      assert.equal(p.id, id);
      await ownKeyWriter(p, {}, client).write(input(tmp()));
      assert.equal(requests[0]!.model, want);
    }
    const { client, requests } = fakeClient([{ text: reply }]);
    await ownKeyWriter(anthropic, { ANTHROPIC_MODEL: "claude-sonnet-5-5" }, client).write({ ...input(tmp()), model: "claude-haiku-5-5" });
    assert.equal(requests[0]!.model, "claude-haiku-5-5", "--model wins");
  });

  it("an older model gets no thinking or effort field, which it would refuse", async () => {
    const { client, requests } = fakeClient([{ text: reply }]);
    await ownKeyWriter(anthropic, {}, client).write({ ...input(tmp()), model: "claude-sonnet-4-5" });
    assert.equal(requests[0]!.thinking, undefined);
    assert.equal(requests[0]!.output_config, undefined);
  });

  it("retries a refusal once with the same words, then stops in plain words", async () => {
    const { client, prompts } = fakeClient([{ stop: "refusal", text: "I can't help with that." }]);
    await assert.rejects(ownKeyWriter(anthropic, {}, client).write(input(tmp())), (e: Error) => e instanceof Stop && /declined to write bugs/.test(e.message) && /does not reword/.test(e.message));
    assert.equal(prompts().length, 2);
    assert.equal(prompts()[0], prompts()[1]);
  });

  it("a first refusal followed by a good reply goes through", async () => {
    const { client, requests } = fakeClient([{ stop: "refusal" }, { text: reply, usage: spend(0.1) }]);
    const r = await ownKeyWriter(anthropic, {}, client).write(input(tmp()));
    assert.equal(r.bugs.length, 1);
    assert.equal(requests.length, 2);
  });

  it("never runs the tools of a refused or cut-off turn", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.py"), "secret-looking\n");
    for (const stop of ["refusal", "max_tokens"]) {
      const { client, requests } = fakeClient([{ stop, content: [read("t1", "a.py")] }, { text: reply }]);
      await ownKeyWriter(anthropic, {}, client).write({ ...input(dir), view: { dir, files: ["a.py"], sourceFiles: ["a.py"] } });
      assert.doesNotMatch(JSON.stringify(requests), /secret-looking/, stop);
    }
  });

  it("stops at the spending limit between turns, says what was spent, and does not retry", async () => {
    const { client, requests } = fakeClient([{ content: [read("t1", "a.py")], usage: spend(5.1) }]);
    await assert.rejects(ownKeyWriter(anthropic, {}, client).write(input(tmp())), /spending limit \(--max-cost 5\).*after about US\$5\.10/);
    assert.equal(requests.length, 1);
  });

  it("holds each reply to what the money left can buy, so one long turn cannot run past the limit", async () => {
    const { client, requests } = fakeClient([{ content: [read("t1", "a.py")], usage: spend(0.25) }, { text: reply }]);
    await ownKeyWriter(anthropic, {}, client).write({ ...input(tmp()), maxCostUsd: 0.75 });
    assert.equal(requests[0]!.max_tokens, 37_500);
    assert.equal(requests[1]!.max_tokens, 25_000);
    const out = fakeClient([{ stop: "max_tokens", text: "half a thought", usage: spend(0.75) }]);
    await assert.rejects(ownKeyWriter(anthropic, {}, out.client).write({ ...input(tmp()), maxCostUsd: 0.75 }), /spending limit/);
    assert.equal(fakeClient([]).requests.length, 0);
    const poor = fakeClient([{ text: reply }]);
    await assert.rejects(ownKeyWriter(anthropic, {}, poor.client).write({ ...input(tmp()), maxCostUsd: 0.001 }), /spending limit/);
    assert.equal(poor.requests.length, 0, "not worth a request");
  });

  it("--max-cost covers both tries together", async () => {
    const { client, requests } = fakeClient([{ text: "no list", usage: spend(0.5) }, { text: reply, usage: spend(0.25) }]);
    const r = await ownKeyWriter(anthropic, {}, client).write({ ...input(tmp()), maxCostUsd: 1 });
    assert.equal(requests[1]!.max_tokens, 25_000);
    assert.equal(r.costUsd, 0.75);
    const spent = fakeClient([{ text: "no list", usage: spend(5) }]);
    await assert.rejects(ownKeyWriter(anthropic, {}, spent.client).write(input(tmp())), /spending limit/);
    assert.equal(spent.requests.length, 1);
  });

  it("a key the provider rejects stops at once, and a crash that spent money still counts", async () => {
    for (const status of [401, 403]) {
      const { client, requests } = fakeClient([{ error: Object.assign(new Error(`${status} no`), { status }) }]);
      await assert.rejects(ownKeyWriter(anthropic, {}, client).write(input(tmp())), /rejected your ANTHROPIC_API_KEY/);
      assert.equal(requests.length, 1);
    }
    const boom = fakeClient([{ content: [read("t1", "a.py")], usage: spend(1) }, { error: new Error("overloaded") }, { text: reply, usage: spend(1) }]);
    const r = await ownKeyWriter(anthropic, {}, boom.client).write(input(tmp()));
    assert.equal(r.costUsd, 2);
  });

  it("says plainly when the session crashes or the list is unusable", async () => {
    const { client } = fakeClient([{ error: new Error("connection lost\nsecond line") }]);
    await assert.rejects(ownKeyWriter(anthropic, {}, client).write(input(tmp())), (e: Error) => /AI session failed twice: connection lost\. Nothing ran\.$/.test(e.message));
    const none = fakeClient([{ text: "no json here" }]);
    await assert.rejects(ownKeyWriter(anthropic, {}, none.client).write(input(tmp())), /no usable bug list/);
  });

  it("gives up at the turn limit, on both tries", async () => {
    const { client, requests } = fakeClient([{ content: [read("t1", "a.py")] }]);
    await assert.rejects(ownKeyWriter(anthropic, {}, client).write(input(tmp())), /ran out of turns/);
    assert.equal(requests.length, 240);
  });

  it("a Ctrl-C ends the conversation at once", async () => {
    const abort = new AbortController();
    const { client, requests, signals } = fakeClient([{ error: new Error("aborted") }]);
    abort.abort();
    await assert.rejects(ownKeyWriter(anthropic, {}, client).write({ ...input(tmp()), abort }), /aborted/);
    assert.equal(requests.length, 1);
    assert.equal(signals[0]!.aborted, true);
  });

  it("history only grows, thinking goes back as it came, and every result of a turn goes in one message, in order", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.py"), "alpha\n");
    const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
    const { client, requests } = fakeClient([
      { content: [thinking, read("t1", "a.py"), read("t2", "../nope"), { type: "tool_use", id: "t3", name: "bash", input: { command: "ls" } }], usage: { cache_creation_input_tokens: 2000 } },
      { content: [read("t4", "a.py")], usage: { cache_read_input_tokens: 2000 } },
      { text: reply },
    ]);
    await ownKeyWriter(anthropic, {}, client).write({ ...input(dir), view: { dir, files: ["a.py"], sourceFiles: ["a.py"] } });
    assert.equal(requests.length, 3);
    for (const [a, b] of [[requests[0]!, requests[1]!], [requests[1]!, requests[2]!]] as const) {
      assert.deepEqual(b.messages.slice(0, a.messages.length), a.messages, "an earlier message changed");
      assert.equal(JSON.stringify(b.tools), JSON.stringify(a.tools));
      assert.equal(b.system, a.system);
    }
    const [, assistant, results] = requests[1]!.messages;
    assert.deepEqual((assistant!.content as unknown[])[0], thinking);
    const rows = results!.content as { tool_use_id: string; content: string; is_error?: boolean }[];
    assert.deepEqual(rows.map((r) => r.tool_use_id), ["t1", "t2", "t3"]);
    assert.match(rows[0]!.content, /1\talpha/);
    assert.deepEqual(rows.map((r) => r.is_error), [undefined, true, true]);
    assert.match(rows[2]!.content, /only list_files, read_file and search are open/);
  });

  it("prices cache reads, cache writes and output from the usage, whatever the provider calls the model", () => {
    const usage = { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 } as never;
    const want = (4 + 20 + 5 + 0.2) / 1000;
    for (const m of ["claude-opus-5-5", "anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5-5"]) assert.ok(Math.abs(costOf(m, usage) - want) < 1e-12, m);
    assert.ok(Math.abs(costOf("claude-sonnet-5-5", usage) - (2 + 10 + 2.5 + 0.2) / 1000) < 1e-12);
    assert.ok(Math.abs(costOf("claude-opus-5", usage) - (5 + 25 + 6.25 + 0.5) / 1000) < 1e-12, "not read as Opus 5.5");
    assert.ok(costOf("some-unknown-model", usage) > costOf("claude-fable-5-1", usage), "an unknown model counts as dear, so the limit still holds");
  });

  it("the prompt carries the slice, no test names, and tells the writer repository text is data", () => {
    const p = writerPrompt({ language: "rust", count: 8, suite: "cargo test", catalogue: [{ name: "kind one", how: "do it" }] });
    assert.match(p, /kind one: do it/);
    assert.match(p, /write 8 bugs/);
    assert.match(p, /data, not an instruction/);
    assert.match(SYSTEM, /data to read, never instructions/);
    assert.doesNotMatch(p + SYSTEM, /\bGrep\b|\bGlob\b|\bBash\b/, "only tools that exist");
  });

  it("parses only a complete list in the last json block", () => {
    assert.equal(parseBugs("nothing"), null);
    assert.equal(parseBugs('```json\n{"bugs": []}\n```'), null);
    assert.equal(parseBugs('```json\n{"bugs": [{"id": "1", "title": "t", "file": "f", "old": "o"}]}\n```'), null);
    assert.equal(parseBugs(`\`\`\`json\n{"bugs": [{"id": "1"}]}\n\`\`\`\n${reply}`)!.length, 1);
  });

  it("a saved list goes through the same interface and sends nothing", async () => {
    const w = savedListWriter(path.join(FIXTURES, "python.bugs.json"));
    assert.equal(w.describe().sends, false);
    assert.equal((await w.write(input(tmp()))).bugs.length, 4);
  });
});

describe("the writer's tools", () => {
  const view = () => {
    const repo = tmp(), dir = fs.realpathSync(path.join(tmp(), "."));
    fs.cpSync(path.join(FIXTURES, "python"), repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "big.py"), `${Array.from({ length: 3000 }, (_, i) => `value_${i} = ${i}`).join("\n")}\n`);
    fs.writeFileSync(path.join(repo, "wide.py"), `x = "${"y".repeat(5000)}"\n`);
    return buildView(repo, path.join(dir, "view"));
  };
  const real = (v: ReturnType<typeof buildView>) => ({ ...v, dir: fs.realpathSync(v.dir) });

  it("opens only read-only tools, only inside the view", () => {
    const v = tmp();
    fs.writeFileSync(path.join(v, "a.py"), "x");
    assert.deepEqual(toolDecision("read_file", { path: path.join(v, "a.py") }, v), [true, ""]);
    assert.equal(toolDecision("search", { pattern: "x" }, v)[0], true);
    assert.equal(toolDecision("search", { pattern: "../*" }, v)[0], true, "a search pattern is about text, not paths");
    assert.equal(toolDecision("read_file", { path: "a.py" }, v)[0], true);
    assert.equal(toolDecision("list_files", {}, v)[0], true);
    for (const [n, a] of [["bash", {}], ["Bash", {}], ["write_file", {}], ["web_fetch", {}], ["read_file", { path: "/etc/passwd" }], ["read_file", { path: "../secret" }], ["read_file", {}], ["search", { pattern: "x", path: "/" }], ["search", {}], ["search", { pattern: "x", glob: "../*" }], ["search", { pattern: "x", glob: "/etc/*" }], ["list_files", { pattern: "../**" }], ["list_files", { pattern: "/etc/*" }], ["list_files", { path: "/etc" }], ["read_file", { path: 3 }]] as [string, unknown][]) assert.equal(toolDecision(n, a, v)[0], false, `${n} ${JSON.stringify(a)}`);
    fs.symlinkSync("/etc", path.join(v, "out"));
    assert.equal(toolDecision("read_file", { path: "out/passwd" }, v)[0], false, "a link out of the view");
  });

  it("tests stay invisible: not listed, not found, not searchable, and the refusal gives nothing away", () => {
    const v = real(view());
    const listed = runTool("list_files", {}, v).text;
    assert.match(listed, /pricing\.py/);
    assert.doesNotMatch(listed, /test_pricing/);
    assert.deepEqual(runTool("read_file", { path: "tests/test_pricing.py" }, v), runTool("read_file", { path: "never/was/here.py" }, v), "a test file reads exactly like a file that does not exist");
    assert.equal(runTool("read_file", { path: "tests/test_pricing.py" }, v).isError, true);
    assert.equal(runTool("search", { pattern: "assertEqual|unittest" }, v).text, "No matches.");
    assert.equal(runTool("list_files", { path: "tests" }, v).text, "No files match.");
  });

  it("a real file on disk that is not on the view's list stays closed", () => {
    const v = real(view());
    fs.writeFileSync(path.join(v.dir, "planted.py"), "secret = 1\n");
    assert.equal(runTool("read_file", { path: "planted.py" }, v).isError, true);
    assert.equal(runTool("search", { pattern: "secret" }, v).text, "No matches.");
    assert.doesNotMatch(runTool("list_files", {}, v).text, /planted/);
  });

  it("a link swapped into the view after it was built reads nothing outside", () => {
    const v = real(view()), outside = path.join(tmp(), "outside.py");
    fs.writeFileSync(outside, "stolen = 1\n");
    fs.rmSync(path.join(v.dir, "pricing.py"));
    fs.symlinkSync(outside, path.join(v.dir, "pricing.py"));
    assert.equal(runTool("read_file", { path: "pricing.py" }, v).isError, true);
    assert.equal(runTool("search", { pattern: "stolen" }, v).text, "No matches.");
  });

  it("reads with line numbers, in parts, and cuts what would flood the context", () => {
    const v = real(view());
    const first = runTool("read_file", { path: "big.py" }, v).text;
    assert.match(first, /^ {5}1\tvalue_0 = 0$/m);
    assert.match(first, /Lines 1 to 2000 of 3000\. Use offset to read on\.$/);
    const part = runTool("read_file", { path: "big.py", offset: 2999, limit: 5 }, v).text;
    assert.equal(part, "  2999\tvalue_2998 = 2998\n  3000\tvalue_2999 = 2999");
    assert.equal(runTool("read_file", { path: "big.py", offset: 9000 }, v).text, "This file has 3000 lines.");
    assert.match(runTool("read_file", { path: "wide.py" }, v).text, /this line is cut here/);
    assert.ok(runTool("read_file", { path: "wide.py" }, v).text.length < 2100);
  });

  it("lists by folder and glob, and search filters the same way", () => {
    const v = real(view());
    assert.equal(runTool("list_files", { pattern: "pri*.py" }, v).text, "pricing.py");
    assert.equal(runTool("list_files", { pattern: "**/*.{py,toml}" }, v).text.split("\n").length, 4);
    assert.equal(runTool("list_files", { pattern: "*.nothing" }, v).text, "No files match.");
    assert.match(runTool("search", { pattern: "value_1500", glob: "big.*" }, v).text, /^big\.py:1501:value_1500 = 1500\n1 match in 1 file\.$/);
    assert.equal(runTool("search", { pattern: "value_1500", glob: "pricing.*" }, v).text, "No matches.");
    assert.equal(runTool("search", { pattern: "value_1500", path: "pricing.py" }, v).text, "No matches.");
  });

  it("search counts everything, shows a part, spans lines and ignores case when asked", () => {
    const v = real(view());
    const all = runTool("search", { pattern: "value_\\d+ =", path: "big.py" }, v).text;
    assert.match(all, /3000 matches in 1 file; the first 100 are shown\./);
    assert.equal(all.split("\n").length, 101);
    assert.match(runTool("search", { pattern: "value_1 = 1\\nvalue_2" }, v).text, /big\.py:2:value_1 = 1/);
    assert.equal(runTool("search", { pattern: "VALUE_7 =" }, v).text, "No matches.");
    assert.match(runTool("search", { pattern: "VALUE_7 =", ignore_case: true }, v).text, /big\.py:8:/);
  });

  it("a bad pattern is an answer, not a crash, and one that backtracks forever is stopped", { timeout: 30_000 }, () => {
    const v = real(view());
    assert.equal(runTool("search", { pattern: "(" }, v).isError, true);
    assert.equal(runTool("search", { pattern: "x".repeat(501) }, v).isError, true);
    fs.writeFileSync(path.join(v.dir, "pricing.py"), `${"a".repeat(40)}b\n`);
    const t0 = Date.now(), r = runTool("search", { pattern: "^(a+)+$" }, v);
    assert.equal(r.isError, true);
    assert.match(r.text, /took too long/);
    assert.ok(Date.now() - t0 < 15_000, `${Date.now() - t0} ms`);
  });
});

describe("catalogue slice", () => {
  const doc = JSON.parse(fs.readFileSync(path.join(CLI_DIR, "catalogue", "slice.json"), "utf8")) as { rule: string; kinds: Record<string, { name: string; how: string }[]> };
  it("loads per language through the interface", async () => {
    for (const language of ["go", "python", "typescript", "rust"] as const) assert.ok((await bundledCatalogue.load({ language, fileTypes: [] })).length > 5, language);
  });
  it("ships a small slice: name and how-to only, no ids, history or results", () => {
    const raw = fs.readFileSync(path.join(CLI_DIR, "catalogue", "slice.json"), "utf8");
    assert.doesNotMatch(raw, /"history"|"result"|ESCAPED|CAUGHT|F-[A-Z]{3,}|"domains"/);
    for (const [lang, rows] of Object.entries(doc.kinds)) {
      assert.ok(rows.length <= 36, lang);
      for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["how", "name"]);
    }
    assert.ok(new Set(Object.values(doc.kinds).flat().map((k) => k.name)).size < 100);
  });
});

describe("the draw", () => {
  const langs = ["go", "python", "typescript", "rust"] as const;
  it("gives each language a part of its kinds, the same part for the same seed, in the catalogue's order", async () => {
    for (const language of langs) {
      const all = await bundledCatalogue.load({ language, fileTypes: [] });
      const a = drawKinds(all, "seed-1");
      assert.deepEqual(a, drawKinds(all, "seed-1"), language);
      assert.notDeepEqual(a, drawKinds(all, "seed-2"), language);
      assert.equal(a.length, Math.ceil(all.length * 2 / 3), language);
      assert.ok(a.length < all.length, language);
      assert.deepEqual(a, all.filter((k) => a.includes(k)), language);
      assert.deepEqual(new Set(drawKinds([...all].reverse(), "seed-1")), new Set(a), "the order of the list does not change the draw");
    }
  });
  it("every kind comes up, so no kind is out of the draw for good", async () => {
    const all = await bundledCatalogue.load({ language: "rust", fileTypes: [] }), seen = new Set<string>();
    for (let i = 0; i < 40; i++) drawKinds(all, `s${i}`).forEach((k) => seen.add(k.name));
    assert.equal(seen.size, all.length);
  });
  it("a new seed can be printed and typed back in", () => {
    assert.match(newSeed(), /^[0-9a-f]{8}$/);
    assert.notEqual(newSeed(), newSeed());
  });
  it("an empty catalogue draws nothing, and does not fail", () => assert.deepEqual(drawKinds([], "x"), []));
});

describe("no route to Trenyx", () => {
  const src = path.join(CLI_DIR, "src");
  const files = fs.readdirSync(src).filter((f) => f.endsWith(".ts"));
  it("no source file imports a network module or calls fetch", () => {
    for (const f of files) {
      const t = fs.readFileSync(path.join(src, f), "utf8");
      const mods = [...t.matchAll(/from "([^"]+)"|import\("([^"]+)"\)/g)].map((m) => m[1] ?? m[2]);
      for (const m of mods) assert.doesNotMatch(m!, /^(node:)?(net|http|https|http2|dns|tls|dgram|undici|axios|got|node-fetch)$/, `${f}: ${m}`);
      assert.doesNotMatch(t.replace(/"[^"\n]*"|`[^`]*`/g, '""').replace(/\/[^/\n]+\/[a-z]*/g, ""), /\bfetch\(|XMLHttpRequest|WebSocket/, f);
    }
  });
  it("the only packages loaded are the AI provider's, from one file, and only when a run needs them", () => {
    for (const f of files) {
      const t = fs.readFileSync(path.join(src, f), "utf8");
      const ext = [...t.matchAll(/^import (?!type )[^;\n]*from "([^"./][^"]*)"|import\("([^"./][^"]*)"\)/gm)].map((m) => m[1] ?? m[2]).filter((m) => !m!.startsWith("node:"));
      assert.deepEqual(ext, f === "client.ts" ? ["@anthropic-ai/sdk", "@anthropic-ai/bedrock-sdk", "@anthropic-ai/vertex-sdk"] : [], f);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(CLI_DIR, "package.json"), "utf8")) as { dependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional: boolean }>; private: boolean };
    assert.deepEqual(pkg.dependencies, { "@anthropic-ai/sdk": "1.3.0" });
    assert.deepEqual(Object.keys(pkg.peerDependenciesMeta).sort(), ["@anthropic-ai/bedrock-sdk", "@anthropic-ai/vertex-sdk"]);
    for (const p of Object.values(pkg.peerDependenciesMeta)) assert.equal(p.optional, true, "the large clients never install by default");
    assert.equal(pkg.private, undefined, "published on SK's word, 11-03");
    assert.doesNotMatch(fs.readFileSync(path.join(CLI_DIR, "package-lock.json"), "utf8"), /claude-agent-sdk/);
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(src, f), "utf8"), /claude-agent-sdk/, f);
  });
  it("no Trenyx address anywhere in the shipped code", () => {
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(src, f), "utf8"), /trenyx\.(io|ai|com)|https?:\/\/(?!\S*example)/i, f);
    assert.doesNotMatch(fs.readFileSync(path.join(CLI_DIR, "catalogue", "slice.json"), "utf8"), /https?:\/\/|trenyx\./i);
  });
});

describe("licence", () => {
  const read = (f: string) => fs.readFileSync(path.join(CLI_DIR, f), "utf8");
  const pkg = JSON.parse(read("package.json")) as { license: string; files: string[]; private: boolean };
  it("the code is Apache-2.0, and the licence field says the catalogue has its own terms", () => {
    assert.match(read("LICENSE"), /^ +Apache License\n +Version 2\.0, January 2004/);
    assert.equal(pkg.license, "SEE LICENSE IN LICENSE AND catalogue/LICENSE");
    assert.equal(pkg.private, undefined, "published on SK's word, 11-03");
  });
  it("the catalogue's terms are exactly these words", () => {
    assert.equal(read("catalogue/LICENSE"), `The files in this folder are not covered by the Apache License.

Copyright 2026 Saurabh Bhatt.

You may use these files as part of this package to run Trenyx on your own code, including at work and for commercial projects. You may not copy them out of this package, redistribute them, or use them to build or train another product or model. All other rights reserved.

These files are provided as is, without warranty of any kind.
`);
  });
  it("names no company form anywhere: Trenyx is not incorporated", () => {
    for (const f of ["LICENSE", "catalogue/LICENSE", "README.md", "package.json"]) assert.doesNotMatch(read(f), /\b(Inc|Ltd|LLC|Corp|Limited|Incorporated)\b\.?/, f);
  });
  it("both licence files ship, and only what should ships", () => {
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: CLI_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as [{ files: { path: string }[] }];
    const names = pack.files.map((f) => f.path);
    for (const f of ["LICENSE", "catalogue/LICENSE", "catalogue/slice.json", "dist/src/main.js", "dist/src/tools.js", "dist/src/loop.js", "package.json"]) assert.ok(names.includes(f), f);
    assert.deepEqual(names.filter((f) => /^(test|tools|fixtures|src)\/|^dist\/test/.test(f)), [], "nothing else goes in the package");
  });
  it("the README says it in one plain line", () => {
    assert.match(read("README.md"), /Apache-2\.0 \(`LICENSE`\); the bug catalogue in `catalogue\/` has its own terms \(`catalogue\/LICENSE`\)/);
  });
});

describe("blind view", () => {
  it("hides tests, in every language", () => {
    for (const [lang, seen, hidden] of [["python", "pricing.py", "test_pricing"], ["go", "pricing.go", "pricing_test.go"], ["typescript", "src/pricing.ts", "pricing.test"], ["rust", "src/lib.rs", "tests.rs"]] as const) {
      const out = path.join(tmp(), "v"), v = buildView(path.join(FIXTURES, lang), out);
      assert.ok(v.sourceFiles.includes(seen), `${lang}: ${v.sourceFiles}`);
      assert.ok(!v.files.some((f) => f.includes(hidden)), `${lang}: ${v.files}`);
    }
  });
  it("takes Rust test modules and test items out of a file", () => {
    const out = stripRust(`pub fn a() -> i32 { 1 }
#[cfg(test)]
mod tests { #[test] fn t() { let s = "}"; assert_eq!(1, 1); } }
#[cfg(all(test, feature = "x"))]
fn helper() {}
#[cfg(not(test))]
fn real() {}
#[cfg(test)]
mod gone;
#[tokio::test]
async fn loose() { }
pub fn b<'a>(x: &'a str) -> &'a str { x }
`);
    assert.deepEqual(out.mods, ["gone"]);
    assert.doesNotMatch(out.text, /tests|helper|loose|gone/);
    assert.match(out.text, /fn a\(\)/);
    assert.match(out.text, /fn real\(\)/);
    assert.match(out.text, /fn b</);
    assert.equal(stripRust("#![cfg(test)]\nfn x() {}\n").testOnly, true);
  });
  it("reads cfg predicates as the engine does, and stops a test-only field at its comma", () => {
    const keep = (c: string) => stripRust(`${c}\nfn x() {}\nfn after() {}\n`).text.includes("fn x");
    for (const c of ["#[cfg(test)]", "#[cfg(all(test, unix))]", "#[cfg(any(test, loom))]", "#[cfg(any(test, fuzzing))]", '#[cfg(feature = "test-util")]']) assert.equal(keep(c), false, c);
    for (const c of ["#[cfg(not(test))]", "#[cfg(not(all(test, loom)))]", "#[cfg(any(test, unix))]", "#[cfg(unix)]", '#[cfg(feature = "testnet")]']) assert.equal(keep(c), true, c);
    const t = stripRust(`struct S {\n    a: u8,\n    /// only for checks\n    #[cfg(test)]\n    b: HashMap<u8, u8>,\n    c: u8,\n}\nfn real(x: u8) {\n    match x {\n        #[cfg(test)]\n        1 => f(),\n        2 => g(),\n        _ => {}\n    }\n}\n`).text;
    assert.doesNotMatch(t, /only for checks|b: HashMap|1 => f/);
    assert.match(t, /a: u8,[\s\S]*c: u8,/);
    assert.match(t, /2 => g\(\)/);
  });
  it("removes comments that name tests, coverage markers, in-source tests and test scripts", () => {
    const repo = tmp(), out = path.join(tmp(), "v");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "// covered by the unit tests\nexport const a = 1; /* istanbul ignore next */\nif (import.meta.vitest) {\n  const { it } = import.meta.vitest;\n  it('x', () => {});\n}\nexport const b = 2;\n");
    fs.writeFileSync(path.join(repo, "src", "b.py"), 'def f():\n    """Tested by test_something_long in the suite."""\n    return "x"  # pragma: no cover\n');
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "x", scripts: { test: "vitest tests/a.test.ts", build: "tsc" } }));
    fs.writeFileSync(path.join(repo, "src", "a.test.ts"), "test('x', () => {})");
    fs.writeFileSync(path.join(repo, "src", "secret.env"), "S=1");
    fs.symlinkSync("/etc/hosts", path.join(repo, "src", "hosts.py"));
    const v = buildView(repo, out);
    assert.deepEqual(v.sourceFiles, ["src/a.ts", "src/b.py"]);
    const a = fs.readFileSync(path.join(out, "src/a.ts"), "utf8");
    assert.doesNotMatch(a, /unit tests|istanbul|vitest/);
    assert.match(a, /export const a = 1;[\s\S]*export const b = 2;/);
    assert.doesNotMatch(fs.readFileSync(path.join(out, "src/b.py"), "utf8"), /pragma/);
    assert.doesNotMatch(fs.readFileSync(path.join(out, "package.json"), "utf8"), /vitest|"test"/);
  });
  it("keeps look-alike product names", () => {
    assert.equal(isTestPath("src/latest.py"), false);
    assert.equal(isTestPath("internal/backtesting/x.go"), false);
    assert.equal(isTestPath("src/__tests__/x.ts"), true);
    assert.equal(isTestPath("pkg/testutil/x.go"), true);
  });
  it("--path and --exclude narrow what can be read", () => {
    const out = path.join(tmp(), "v");
    assert.deepEqual(buildView(path.join(FIXTURES, "typescript"), out, { paths: ["src"], exclude: ["src/clamp.js"] }).sourceFiles, ["src/pricing.ts"]);
  });
});

describe("bugs", () => {
  const b = (o: Partial<Bug>): Bug => ({ id: "x", title: "t", file: "a.py", old: "x = 1", new: "x = 2", ...o });
  const setup = () => {
    const src = tmp();
    fs.writeFileSync(path.join(src, "a.py"), "x = 1\ny = 2\ny = 2\n");
    fs.writeFileSync(path.join(src, "README.md"), "x = 1\n");
    fs.symlinkSync(path.join(src, "a.py"), path.join(src, "l.py"));
    return { src, view: { dir: "", files: ["a.py", "l.py", "README.md"], sourceFiles: ["a.py", "l.py"] } };
  };
  it("keeps a real one-place edit, numbered, with its line", () => {
    const { src, view } = setup();
    const { kept } = validate([b({ old: "y = 2\ny = 2", new: "y = 3\ny = 2", id: "q" })], src, view, 8);
    assert.equal(kept[0]!.id, "B01");
    assert.equal(kept[0]!.line, 2);
  });
  it("drops what cannot be a fair bug, and says why", () => {
    const { src, view } = setup();
    const cases: [Partial<Bug>, RegExp][] = [
      [{ old: "y = 2" }, /occurs 2 times/], [{ old: "nope" }, /not in the file/], [{ new: "x = 1" }, /changes nothing/], [{ file: "README.md" }, /not a source file/],
      [{ file: "l.py" }, /not a plain file/], [{ new: "import subprocess; subprocess.run(['x'])" }, /reaches outside/], [{ new: "x = os.environ['ANTHROPIC_API_KEY']" }, /reaches outside/],
    ];
    for (const [o, why] of cases) assert.match(validate([b(o)], src, view, 8).dropped[0]!.why, why);
    assert.equal(validate([b({}), b({})], src, view, 8).dropped[0]!.why, "repeats another bug");
  });
  it("stops, not drops, on a file outside the copy", () => {
    const { src, view } = setup();
    assert.throws(() => validate([b({ file: "../a.py" })], src, view, 8), (e) => e instanceof Stop && /outside the temporary copy/.test(e.message));
  });
  it("keeps every edit inside the copy: absolute paths, .., and links out stop", () => {
    const { src } = setup();
    fs.mkdirSync(path.join(src, "sub"));
    fs.symlinkSync("/etc", path.join(src, "out"));
    fs.symlinkSync("/etc/hosts", path.join(src, "hosts.py"));
    fs.symlinkSync(path.join(src, "nowhere"), path.join(src, "dangling.py"));
    assert.equal(insideCopy(src, "a.py"), path.join(src, "a.py"));
    assert.equal(insideCopy(src, "sub/../a.py"), path.join(src, "a.py"));
    assert.equal(insideCopy(src, "sub/new.py"), path.join(src, "sub", "new.py"), "a missing file inside is not an escape");
    for (const f of ["/etc/hosts", path.join(src, "a.py"), "../a.py", "sub/../../x.py", "out/hosts", "out/none/x", "hosts.py", "dangling.py", "", "a\0.py"]) {
      assert.throws(() => insideCopy(src, f), (e) => e instanceof Stop && /outside the temporary copy/.test(e.message), f);
    }
  });
  it("stops at the number asked for", () => {
    const { src, view } = setup();
    assert.equal(validate([b({}), b({ old: "y = 2\ny = 2", new: "z" })], src, view, 1).kept.length, 1);
  });
  it("fingerprints id, file, old and new, and nothing else", () => {
    assert.equal(fingerprint([b({ title: "one" })]), fingerprint([b({ title: "two" })]));
    assert.notEqual(fingerprint([b({})]), fingerprint([b({ new: "x = 3" })]));
    assert.match(fingerprint([b({})]), /^[0-9a-f]{64}$/);
  });
  it("applies the one edit and refuses a link out of the copy", () => {
    const { src } = setup();
    applyBug(b({}), src);
    assert.equal(fs.readFileSync(path.join(src, "a.py"), "utf8").split("\n")[0], "x = 2");
    fs.rmSync(path.join(src, "l.py"));
    fs.symlinkSync("/etc/hosts", path.join(src, "l.py"));
    assert.throws(() => applyBug(b({ file: "l.py", old: "localhost" }), src), /outside the temporary copy/);
    assert.equal(fs.readFileSync("/etc/hosts", "utf8").includes("x = 2"), false);
  });
});

describe("running a suite", () => {
  it("says what failed when a tool is missing, instead of crashing", async () => {
    const root = tmp(), log = path.join(root, "log");
    const p = await runProcess(["/no/such/tool"], { cwd: root, env: process.env, timeoutMs: 5000, log });
    assert.notEqual(p.code, 0);
    assert.match(fs.readFileSync(log, "utf8"), /ENOENT/);
  });
  it("stops a hung command at its limit, with the whole process group", async () => {
    const root = tmp();
    const p = await runProcess(["/bin/sh", "-c", "sleep 30 & sleep 30"], { cwd: root, env: process.env, timeoutMs: 200, log: path.join(root, "log") });
    assert.equal(p.timedOut, true);
    assert.ok(p.ms < 7000, `${p.ms}`);
  });
});

describe("report parsers", () => {
  it("junit", () => {
    const xml = `<testsuite><testcase classname="tests.t" name="ok"/><testcase classname="tests.t" name="bad &lt;x&gt;"><failure message="a>b">x</failure></testcase><testcase classname="c" name="err"><error/></testcase><testcase name="s"><skipped/></testcase></testsuite>`;
    assert.deepEqual(parseJunit(xml), { failing: { F: ["tests.t::bad <x>"], E: ["c::err"] }, total: 4 });
  });
  it("go test -json, with a package that failed outside any test", () => {
    const text = ['{"Action":"pass","Package":"p","Test":"TestA"}', '{"Action":"fail","Package":"p","Test":"TestB"}', '{"Action":"fail","Package":"p"}', '{"Action":"fail","Package":"q"}', "not json"].join("\n");
    assert.deepEqual(parseGoJson(text), { failing: { F: ["p/TestB"], E: ["q (package failed)"] }, total: 2 });
  });
  it("cargo test text, and no report when nothing compiled", () => {
    assert.deepEqual(parseCargoText("running 2 tests\ntest a::b ... ok\ntest c ... FAILED\ntest result: FAILED. 1 passed; 1 failed\n"), { failing: { F: ["c"], E: [] }, total: 2 });
    assert.deepEqual(parseCargoText("error[E0308]: mismatched types\n"), { failing: null, total: null });
  });
  it("unittest text", () => {
    assert.deepEqual(parseUnittestText("FAIL: test_a (t.T)\nERROR: test_b (t.T)\nRan 3 tests in 0.1s\n"), { failing: { F: ["test_a (t.T)"], E: ["test_b (t.T)"] }, total: 3 });
    assert.deepEqual(parseUnittestText("Traceback: boom\n"), { failing: null, total: null });
  });
  it("jest json, with a file that did not load", () => {
    const doc = { numTotalTests: 2, testResults: [{ name: "/w/a.test.js", status: "failed", assertionResults: [{ status: "passed", fullName: "ok" }, { status: "failed", fullName: "bad" }] }, { name: "/w/b.test.js", status: "failed", assertionResults: [] }] };
    assert.deepEqual(parseJestJson(JSON.stringify(doc), "/w"), { failing: { F: ["a.test.js::bad"], E: ["b.test.js (did not load)"] }, total: 2 });
  });
});

describe("detection", () => {
  it("finds the test command for each language", () => {
    const { repo } = makeRepo("go");
    assert.equal(detect(repo, {}).cmd.label, "go test ./...");
    assert.equal(detect(makeRepo("rust").repo, {}).cmd.format, "cargo-text");
    assert.equal(detect(makeRepo("python").repo, {}).language, "python");
    const ts = detect(makeRepo("typescript").repo, {});
    assert.equal(ts.cmd.label, "node --test");
    assert.equal(ts.cmd.format, "junit");
  });
  it("uses vitest and jest directly, with a report, and a runner it does not know by exit code", () => {
    const { repo } = makeRepo("typescript"), put = (scripts: object, dev: object) => {
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts, devDependencies: dev }));
      fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
      return detect(repo, {}).cmd;
    };
    assert.deepEqual(put({ test: "vitest" }, { vitest: "1" }).argv, ["vitest", "run", "--reporter=junit", "--outputFile={report}"]);
    assert.equal(put({ test: "jest --ci" }, { jest: "1" }).format, "jest-json");
    assert.equal(put({ test: "turbo run test" }, { turbo: "1" }).format, "exit");
    assert.equal(put({ test: "lint && vitest" }, { vitest: "1" }).format, "exit");
    assert.throws(() => put({ test: 'echo "Error: no test specified" && exit 1' }, {}), /No test script/);
    fs.rmSync(path.join(repo, "node_modules"), { recursive: true });
    assert.throws(() => detect(repo, {}), /node_modules is missing|No test script/);
  });
  it("--test-cmd adds a report only to a plain runner call", () => {
    assert.equal(fromTestCmd("pytest tests/unit").format, "junit");
    assert.match(fromTestCmd("go test ./pkg/...").argv[2]!, /-json -count=1$/);
    assert.equal(fromTestCmd("cargo test -p core").format, "cargo-text");
    assert.equal(fromTestCmd("make test").format, "exit");
    assert.equal(fromTestCmd("pytest && mypy .").format, "exit");
  });
  it("picks a syntax check only where there is no build step", () => {
    const cmd = fromTestCmd("pytest");
    assert.ok(parseCheck("python", cmd, "a.py"));
    assert.ok(parseCheck("typescript", cmd, "a.js"));
    assert.equal(parseCheck("go", cmd, "a.go"), undefined);
  });
});

describe("report", () => {
  const s: Summary = {
    repo: "r", sha: "a".repeat(40), dirty: true, language: "Go", suite: "go test ./...", exitOnly: false, testCount: 3, flaky: ["f"], setAside: [], fingerprint: "ab",
    outcomes: [
      { bug: { id: "B01", title: "caught one", file: "a.go", old: "o", new: "n", line: 3 }, verdict: "CAUGHT", note: "", tests: 2, names: ["pkg/TestOne", "pkg/TestTwo"] },
      { bug: { id: "B02", title: "exactly 100 pays full price", file: "b.go", old: "if a >= b", new: "if a > b", line: 9 }, verdict: "ESCAPED", note: "", tests: 0 },
      { bug: { id: "B03", title: "hang", file: "c.go", old: "o", new: "n", line: 1 }, verdict: "TIMEOUT", note: "stopped at the time limit", tests: 0 },
    ],
    dropped: [{ bug: { id: "x", title: "dropped one", file: "d.go", old: "", new: "" }, why: "its text is not in the file" }],
    sentTo: "Anthropic API (api.anthropic.com), using your ANTHROPIC_API_KEY", model: "m", costUsd: 0.5,
  };
  it("counts catches over counted bugs, and labels the score as self-run", () => {
    assert.deepEqual(score(s), { caught: 1, counted: 2 });
    for (const text of [terminalReport(s), markdownReport(s)]) {
      assert.match(text, /Score: 1 of 2 counted; 1 to 2 of 3 if that one counts\./);
      assert.match(text, /self-run score, not an independent Trenyx result/);
      assert.ok(text.includes(AI_NOTICE), "Commercial Terms D.3");
      assert.match(text, /Nothing went to Trenyx/);
      assert.match(text, /b\.go:9/);
      assert.match(text, /exactly 100 pays full price/);
    }
    assert.match(markdownReport(s), /- if a >= b\n\+ if a > b/);
    assert.match(markdownReport(s), /dropped one/);
    assert.match(markdownReport(s), /2 tests: `pkg\/TestOne`, `pkg\/TestTwo`/);
  });

  it("carries the coverage warning, and says loudly when the repository changed", () => {
    const c = { ...s, coverage: "Your test command runs about 40% of the code (by size); bugs are planted only there, so the score speaks for that part. Left out, biggest first: web/." };
    for (const text of [terminalReport(c), markdownReport(c)]) assert.match(text, /about 40% of the code \(by size\)/);
    for (const text of [terminalReport(s), markdownReport(s)]) assert.doesNotMatch(text, /of the code \(by size\)|WARNING/);
    assert.match(terminalReport({ ...s, repoChanged: true }), /^\nWARNING: your repository changed while this ran/);
    assert.match(markdownReport({ ...s, repoChanged: true }), /\n\n\*\*WARNING: your repository changed/);
  });

  const out = (verdict: string, n: number) => Array.from({ length: n }, (_, i) => ({ bug: { id: `${verdict}${i}`, title: "t", file: "a.go", old: "o", new: "n", line: 1 }, verdict, note: "", tests: verdict === "CAUGHT" ? 1 : 0 }));
  const withOutcomes = (...o: unknown[][]) => ({ ...s, outcomes: o.flat() } as Summary);

  it("the likely range is an 80% Wilson interval on caught over counted, in whole bugs", () => {
    assert.deepEqual(likelyRange(6, 15), [4, 8]);
    assert.deepEqual(likelyRange(9, 15), [7, 11]);
    assert.equal(likelyRange(0, 0), null);
  });

  it("the likely range stays on the scale and always holds the score", () => {
    for (let n = 1; n <= 40; n++) for (let c = 0; c <= n; c++) {
      const [low, high] = likelyRange(c, n)!;
      assert.ok(low >= 0 && low <= c && c <= high && high <= n, `${c} of ${n}: ${low} to ${high}`);
    }
    assert.equal(likelyRange(16, 16)![1], 16);
    assert.equal(likelyRange(0, 16)![0], 0);
  });

  it("the likely range sits on its own line, apart from the range for bugs left out", () => {
    const one = withOutcomes(out("CAUGHT", 6), out("ESCAPED", 9), out("BUILD-BREAK", 1));
    assert.equal(likelyLine(one), "Likely between 4 and 8 of 15 if different bugs were drawn.");
    assert.equal(scoreLine(one), "6 of 15 counted; 6 to 7 of 16 if that one counts.");
    assert.match(terminalReport(one), /^Score: 6 of 15 counted; 6 to 7 of 16 if that one counts\.\nLikely between 4 and 8 of 15 if different bugs were drawn\.$/m);
    assert.match(markdownReport(one), /^\*\*Score: 6 of 15 counted; 6 to 7 of 16 if that one counts\.\*\*\n\nLikely between 4 and 8 of 15 if different bugs were drawn\.$/m);
  });

  it("no likely range when nothing counted", () => {
    const none = withOutcomes(out("BUILD-BREAK", 2));
    assert.equal(likelyLine(none), null);
    assert.doesNotMatch(terminalReport(none), /Likely between/);
    assert.doesNotMatch(markdownReport(none), /Likely between/);
  });

  it("the score alone when every bug counts", () => {
    assert.equal(scoreLine(withOutcomes(out("CAUGHT", 11), out("ESCAPED", 5))), "11 of 16 bugs caught.");
  });
  it("shows the range when bugs can't be counted, in the words SK gave", () => {
    assert.equal(scoreLine(withOutcomes(out("CAUGHT", 11), out("ESCAPED", 1), out("BUILD-BREAK", 2), out("TIMEOUT", 1), out("INSPECT", 1))), "11 of 12 counted; 11 to 15 of 16 if those four count.");
  });
  it("the range is the same in both reports, says one in the singular, and takes in every kind of uncounted bug", () => {
    const one = withOutcomes(out("CAUGHT", 2), out("ESCAPED", 1), out("FLAKY", 1));
    assert.equal(scoreLine(one), "2 of 3 counted; 2 to 3 of 4 if that one counts.");
    assert.match(terminalReport(one), /^Score: 2 of 3 counted; 2 to 3 of 4 if that one counts\.$/m);
    assert.match(markdownReport(one), /^\*\*Score: 2 of 3 counted; 2 to 3 of 4 if that one counts\.\*\*$/m);
  });
  it("still makes sense with nothing counted, and at the most bugs a run can have", () => {
    assert.equal(scoreLine(withOutcomes(out("BUILD-BREAK", 2))), "0 of 0 counted; 0 to 2 of 2 if those two count.");
    assert.equal(scoreLine(withOutcomes(out("TIMEOUT", 16))), "0 of 0 counted; 0 to 16 of 16 if those sixteen count.");
  });
  it("a bug dropped before running is not in the range: it never ran", () => {
    assert.equal(s.dropped.length, 1);
    assert.equal(scoreLine(withOutcomes(out("CAUGHT", 1), out("ESCAPED", 1))), "1 of 2 bugs caught.");
  });
  it("shows the draw only where a writer ran", () => {
    const drawn = { ...s, draw: { seed: "3f9a21c7", used: 24, of: 36 } };
    assert.match(terminalReport(drawn), /Bug kinds: 24 of 36, seed 3f9a21c7\./);
    assert.match(markdownReport(drawn), /24 of 36 drawn at random, seed `3f9a21c7`\. `--seed` draws the same kinds; the AI still writes its own bugs from them\./);
    assert.doesNotMatch(terminalReport(s) + markdownReport(s), /Bug kinds/);
  });
});
