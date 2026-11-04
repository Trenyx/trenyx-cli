import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { describe, it } from "node:test";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { detectProvider } from "../src/provider.js";
import { ownKeyWriter } from "../src/writer.js";
import { cli, hasTool, makeRepo, tempDir } from "./helpers.js";

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "thinking"; thinking: string; signature: string };

/** A provider on localhost that speaks the Messages API, so the real SDK runs with no key, no cost and no network. */
function fakeProvider(plan: (n: number) => Block[], stopReason?: string) {
  const seen: Seen[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (!isModelCall(req.url)) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "the only thing this run should call is the model" } })); return; }
      const blocks = plan(n++);
      const stream = (JSON.parse(body) as { stream?: boolean }).stream;
      const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const stop = stopReason ?? (blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_${n}`, type: "message", role: "assistant", model: "fake", content: blocks, stop_reason: stop, stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, stop_sequence: null, usage } });
      blocks.forEach((b, index) => {
        if (b.type === "text") {
          send("content_block_start", { index, content_block: { type: "text", text: "" } });
          send("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
        } else if (b.type === "thinking") {
          send("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
          send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.thinking } });
          send("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } });
        } else {
          send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
          send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
        }
        send("content_block_stop", { index });
      });
      send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
      send("message_stop", {});
      res.end();
    });
  });
  return new Promise<{ url: string; seen: Seen[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() }));
  });
}

const isModelCall = (url = "") => url.split("?")[0] === "/v1/messages" || url.endsWith(":streamRawPredict");

const LIST = '```json\n{"bugs": [{"id": "B01", "title": "large orders get 20% off", "kind": "constant", "file": "pricing.py", "old": "total * 0.9", "new": "total * 0.8"}]}\n```';

describe("the real SDK against a fake provider", () => {
  const thought = { type: "thinking", thinking: "", signature: "sig-from-the-server" } as const;

  it("runs end to end, sends only the view, and the walls hold", { timeout: 120_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    const p = await fakeProvider((n) => n === 0 ? [
      thought,
      { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "cat /etc/hosts" } },
      { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "/etc/hosts" } },
      { type: "tool_use", id: "toolu_3", name: "read_file", input: { path: "../repo/.env" } },
      { type: "tool_use", id: "toolu_4", name: "list_files", input: {} },
      { type: "tool_use", id: "toolu_5", name: "read_file", input: { path: "pricing.py" } },
      { type: "tool_use", id: "toolu_6", name: "read_file", input: { path: "tests/test_pricing.py" } },
      { type: "tool_use", id: "toolu_7", name: "search", input: { pattern: "test_large_order|do-not-send" } },
    ] : [{ type: "text", text: `Done.\n${LIST}` }]);
    try {
      const r = await cli(repo, ["--yes", "--bugs", "1", "--out", path.join(base, "r.md")], { tmp, env: { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: p.url, CLAUDE_CODE_OAUTH_TOKEN: "should-not-travel", ANTHROPIC_AUTH_TOKEN: "should-not-travel", ANTHROPIC_CUSTOM_HEADERS: "x-sneaky: should-not-travel", ANTHROPIC_LOG: "debug" } });
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, new RegExp(`About to send code to: the endpoint in ANTHROPIC_BASE_URL \\(${p.url.slice(7)}\\)`));
      assert.ok(r.out.indexOf("About to send") < r.out.indexOf("Writing 1 bugs"), "the provider is named before anything is sent");
      assert.match(r.out, /Score: 1 of 1/);
      assert.match(r.out, /self-run score/);

      assert.deepEqual([...new Set(p.seen.map((s) => `${s.method} ${s.url.split("?")[0]}`))], ["POST /v1/messages"], "the model call, and nothing else, ever");
      assert.equal(p.seen.length, 2);
      // what the model was offered: exactly the three read-only tools
      const bodies = p.seen.map((s) => JSON.parse(s.body) as { stream: boolean; messages: { role: string; content: unknown }[]; tools: { name: string }[] });
      assert.deepEqual(bodies[0]!.tools.map((t) => t.name), ["list_files", "read_file", "search"]);
      assert.equal(bodies[0]!.stream, true);
      const blocks = bodies[1]!.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; signature?: string }[];
      assert.equal(blocks.find((b) => b.type === "thinking")?.signature, "sig-from-the-server", "thinking goes back as it came");
      const resultOf = (id: string) => blocks.find((c) => c.type === "tool_result" && c.tool_use_id === id);
      for (const id of ["toolu_1", "toolu_2", "toolu_3", "toolu_6"]) assert.equal(resultOf(id)?.is_error, true, `${id} was not refused: ${JSON.stringify(resultOf(id))}`);
      assert.match(JSON.stringify(resultOf("toolu_5")), /total \* 0\.9/, "a read inside the view works");
      assert.match(JSON.stringify(resultOf("toolu_4")), /pricing\.py/);
      assert.equal(resultOf("toolu_7")?.content, "No matches.");
      // everything this machine sent, leaving out the assistant turns, which are the fake model's own words coming back
      const everything = JSON.stringify(bodies.map((b) => ({ ...b, messages: b.messages.filter((m) => m.role === "user") })));
      assert.match(everything, /total \* 0\.9/, "the view reached the model");
      assert.doesNotMatch(everything, /test_large_order|do-not-send|127\.0\.0\.1\s+localhost/, "tests, .env and files outside the view never left");
      assert.doesNotMatch(p.seen.map((s) => s.body).join("\n"), /should-not-travel|fake-key/);
      assert.doesNotMatch(everything, /test_pricing\.py/, "not even a test file's name");
      for (const s of p.seen) {
        assert.equal(s.headers.authorization, "Bearer fake-key", s.url);
        assert.doesNotMatch(JSON.stringify(s.headers), /should-not-travel|device|session/i, "no token, no id for this machine");
      }
      assert.doesNotMatch(r.out + r.err, /fake-key|should-not-travel/, "nothing prints a key, whatever the log level");
      assert.deepEqual(fs.readdirSync(tmp), [], "the temp folder was not cleaned");
    } finally { p.close(); }
  });

  it("a refusal from the real stream stops in plain words after one retry with the same words", { timeout: 120_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    const p = await fakeProvider(() => [{ type: "text", text: "I can't help with that." }], "refusal");
    try {
      const r = await cli(repo, ["--yes", "--bugs", "1", "--out", path.join(base, "r.md")], { tmp, env: { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: p.url } });
      assert.equal(r.code, 1, r.out + r.err);
      assert.match(r.err, /declined to write bugs for this code, twice/);
      const bodies = p.seen.filter((s) => s.body.includes("write 3 bugs"));
      assert.equal(bodies.length, 2);
      const prompts = bodies.map((s) => JSON.stringify((JSON.parse(s.body) as { messages: unknown[] }).messages[0]));
      assert.equal(new Set(prompts).size, 1, "the retry used the same words");
      const models = bodies.map((s) => (JSON.parse(s.body) as { model: string }).model);
      assert.equal(new Set(models).size, 1, "a refusal never moves to another model");
    } finally { p.close(); }
  });

  it("a key the provider rejects stops at once and prints no key", { timeout: 120_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    const server = http.createServer((req, res) => { req.resume(); res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const r = await cli(repo, ["--yes", "--bugs", "1", "--out", path.join(base, "r.md")], { tmp, env: { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } });
      assert.equal(r.code, 1);
      assert.match(r.err, /rejected your ANTHROPIC_API_KEY\. Nothing ran\./);
      assert.doesNotMatch(r.out + r.err, /fake-key/);
    } finally { server.close(); }
  });

  it("asks for 16 bugs and two spares by default", { timeout: 120_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    const p = await fakeProvider(() => [{ type: "text", text: "no list" }]);
    try {
      const r = await cli(repo, ["--yes", "--out", path.join(base, "r.md")], { tmp, env: { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: p.url, HTTPS_PROXY: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: undefined } });
      assert.ok(p.seen.some((s) => s.body.includes("write 18 bugs")));
      assert.match(r.out, /HTTPS_PROXY is set, but Node ignores it unless NODE_USE_ENV_PROXY=1 is set too\./);
    } finally { p.close(); }
  });

  it("each run draws its kinds, prints the seed, and --seed draws the same ones", { timeout: 240_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    const p = await fakeProvider(() => [{ type: "text", text: LIST }]);
    const kinds = (s: { body: string }) => JSON.stringify((JSON.parse(s.body) as { messages: { content: string }[] }).messages[0]!.content.split("Common kinds of bug")[1]);
    try {
      const run = async (...extra: string[]) => {
        const n = p.seen.length, out = path.join(base, `r${n}.md`);
        const r = await cli(repo, ["--yes", "--bugs", "1", "--out", out, ...extra], { tmp, env: { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: p.url } });
        assert.equal(r.code, 0, r.out + r.err);
        return { r, sent: kinds(p.seen[n]!), md: fs.readFileSync(out, "utf8") };
      };
      const first = await run();
      const seed = /drawn with seed (\w+)\. --seed \1 draws the same ones\./.exec(first.r.out)?.[1];
      assert.ok(seed, first.r.out);
      assert.match(first.r.out, /Bug kinds: 24 of 36, drawn with seed/);
      assert.ok(first.r.out.indexOf("drawn with seed") < first.r.out.indexOf("Writing 1 bugs"), "the seed shows before anything is sent");
      assert.ok(first.md.includes(`seed \`${seed}\``));
      // the list is saved next to the report, in the shape --bugs-file reads, and the same bugs run again from it
      const saved = path.join(base, "r0.bugs.json"), print = /fingerprint \(SHA-256\): ([0-9a-f]{64})/.exec(first.r.out)?.[1];
      assert.ok(first.r.out.includes(`Bug list saved: ${saved}. To run the same bugs again later: trenyx run --bugs-file ${saved}`), first.r.out);
      assert.ok(first.md.includes(`Bug list: \`${saved}\``));
      const list = JSON.parse(fs.readFileSync(saved, "utf8")) as { bugs: { id: string; file: string }[] };
      assert.equal(list.bugs[0]!.id, "B01");
      const rerun = await cli(repo, ["--bugs-file", saved, "--out", path.join(base, "rerun.md")], { tmp });
      assert.equal(rerun.code, 0, rerun.out + rerun.err);
      assert.ok(print && rerun.out.includes(print), "the same list has the same fingerprint");
      assert.doesNotMatch(rerun.out, /Bug list saved/);
      const moved = await run("--seed", seed, "--save-bugs", path.join(base, "keep", "list.json"));
      assert.ok(fs.existsSync(path.join(base, "keep", "list.json")) && moved.md.includes("keep/list.json"));
      const again = await run("--seed", seed);
      assert.equal(again.sent, first.sent, "the same seed sends the same kinds");
      assert.ok(again.r.out.includes(`seed ${seed}`));
      const other = await run("--seed", `${seed}x`);
      assert.notEqual(other.sent, first.sent);
      assert.equal(first.sent.split("\\n- ").length, 25, "only the drawn kinds went");
    } finally { p.close(); }
  });

  it("a bad seed stops at once", { timeout: 30_000 }, async () => {
    const { repo, tmp } = makeRepo("python");
    const r = await cli(repo, ["--seed", "not a seed; rm"], { tmp, env: { ANTHROPIC_API_KEY: "fake-key" } });
    assert.equal(r.code, 1);
    assert.match(r.err, /--seed must be letters/);
  });

  it("a test command that names one folder keeps the bugs there, and says so before any test runs", { timeout: 60_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    fs.mkdirSync(path.join(repo, "api"));
    fs.writeFileSync(path.join(repo, "api", "pay.py"), "def pay(x):\n    return x + 1\n");
    execFileSync("git", ["add", "api"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "api"], { cwd: repo });
    const p = await fakeProvider(() => [{ type: "text", text: "no list" }]);
    try {
      const r = await cli(repo, ["--yes", "--bugs", "1", "--test-cmd", "python3 -m unittest discover -s tests -t . # api/tests", "--out", path.join(base, "r.md")], { tmp, env: { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: p.url } });
      assert.match(r.out, /Note: Your test command runs only api\/, so the bugs go only there.* use --path\.\n/);
      assert.ok(r.out.indexOf("Note:") < r.out.indexOf("Clean run 1"), r.out);
    } finally { p.close(); }
  });

  it("a Go module the root command never reaches is left out of the plan, and the run says so", { timeout: 60_000, skip: hasTool("go") ? false : "go not installed" }, async () => {
    const { repo, tmp, base } = makeRepo("go");
    fs.mkdirSync(path.join(repo, "plugin"));
    fs.writeFileSync(path.join(repo, "plugin", "go.mod"), "module example.com/plugin\n\ngo 1.21\n");
    fs.writeFileSync(path.join(repo, "plugin", "p.go"), "package plugin\n\nfunc Add(a, b int) int { return a + b }\n");
    execFileSync("git", ["add", "plugin"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "plugin"], { cwd: repo });
    const p = await fakeProvider(() => [{ type: "text", text: "no list" }]);
    try {
      const r = await cli(repo, ["--yes", "--bugs", "1", "--out", path.join(base, "r.md")], { tmp, env: { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: p.url } });
      assert.match(r.out, /Note: go test from the root never reaches plugin, which has its own go\.mod, so no bugs go there.*--path plugin --test-cmd "cd plugin && go test \.\/\.\.\."/);
      const quiet = await cli(repo, ["--list-files"], { tmp, env: { ANTHROPIC_API_KEY: "fake-key" } });
      assert.doesNotMatch(quiet.out, /Note:/);
    } finally { p.close(); }
  });

  it("a list that breaks the spread is cut, the short folders get one second pass, and the run shows where the bugs went", { timeout: 120_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    for (const [dir, name] of [["a", "one"], ["b", "two"]]) {
      fs.mkdirSync(path.join(repo, dir));
      fs.writeFileSync(path.join(repo, dir, `${name}.py`), `def ${name}(x):\n    return x + 1\n\n\ndef ${name}_b(x):\n    return x + 2\n\n\ndef ${name}_c(x):\n    return x + 3\n`);
    }
    execFileSync("git", ["add", "a", "b"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "two more folders"], { cwd: repo });
    const crowded = { bugs: [
      { id: "B01", title: "large orders get 20% off", file: "pricing.py", old: "total * 0.9", new: "total * 0.8" },
      { id: "B02", title: "the threshold moved", file: "pricing.py", old: "total >= 100", new: "total > 100" },
    ] };
    const more = { bugs: [
      { id: "B01", title: "one is off", file: "a/one.py", old: "return x + 1", new: "return x + 9" },
      { id: "B02", title: "two is off", file: "b/two.py", old: "return x + 1", new: "return x + 9" },
    ] };
    const p = await fakeProvider((n) => [{ type: "text", text: `\`\`\`json\n${JSON.stringify(n === 0 ? crowded : more)}\n\`\`\`` }]);
    try {
      const out = path.join(base, "r.md");
      const r = await cli(repo, ["--yes", "--bugs", "3", "--allow-failing", "--out", out], { tmp, env: { ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: p.url } });
      assert.ok(r.code === 0 || r.code === 1, r.out + r.err);
      const second = p.seen.filter((s) => s.body.includes("A first pass already wrote bugs"));
      assert.equal(second.length, 1, "exactly one second pass");
      assert.ok(r.out.indexOf("short of the plan") > 0 && r.out.indexOf("short of the plan") < r.out.indexOf("bugs locked"), r.out);
      assert.match(r.out, /3 bugs locked/);
      assert.match(r.out, /Where the bugs went \(planned from code size, never from the tests/);
      const report = fs.readFileSync(out, "utf8");
      assert.match(report, /## Where the bugs went/);
      assert.match(report, /`a\/`/);
      assert.match(report, /`b\/`/);
      assert.doesNotMatch(report, /the threshold moved/, "the bug over the limit never ran");
      assert.doesNotMatch(r.out, /Short of the plan/);
    } finally { p.close(); }
  });
});

describe("Bedrock and Vertex through their real clients, against a fake provider", () => {
  it("Bedrock signs with the developer's AWS credentials and sends no Anthropic credential", { timeout: 120_000 }, async () => {
    const { repo, tmp, base } = makeRepo("python");
    const p = await fakeProvider(() => [{ type: "text", text: LIST }]);
    try {
      const r = await cli(repo, ["--yes", "--bugs", "1", "--out", path.join(base, "r.md")], {
        tmp, env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", ANTHROPIC_BEDROCK_MANTLE_BASE_URL: p.url, AWS_ACCESS_KEY_ID: "AKIAFAKE", AWS_SECRET_ACCESS_KEY: "fake-secret", AWS_PROFILE: undefined, AWS_BEARER_TOKEN_BEDROCK: undefined, ANTHROPIC_AUTH_TOKEN: "should-not-travel", CLAUDE_CODE_OAUTH_TOKEN: "should-not-travel" },
      });
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, new RegExp(`About to send code to: AWS Bedrock \\(${p.url.slice(7)}\\), using your AWS credentials`));
      assert.match(r.out, /Score: 1 of 1/);
      assert.equal(p.seen.length, 1);
      assert.match(String(p.seen[0]!.headers.authorization), /^AWS4-HMAC-SHA256 /);
      assert.equal((JSON.parse(p.seen[0]!.body) as { model: string }).model, "anthropic.claude-opus-5-5");
      assert.doesNotMatch(JSON.stringify(p.seen), /should-not-travel|fake-secret/);
    } finally { p.close(); }
  });

  it("Vertex sends the loop's request to the model's own address, with no Anthropic credential", { timeout: 30_000 }, async () => {
    const dir = tempDir(), p = await fakeProvider((n) => n === 0 ? [{ type: "tool_use", id: "t1", name: "list_files", input: {} }] : [{ type: "text", text: LIST }]);
    fs.writeFileSync(path.join(dir, "pricing.py"), "total = 1\n");
    try {
      const authClient = { projectId: "fake-project", getRequestHeaders: async () => new Headers({ authorization: "Bearer fake-google-token" }) };
      const client = new AnthropicVertex({ baseURL: `${p.url}/v1`, region: "us-central1", projectId: "fake-project", authClient: authClient as never, logLevel: "off" });
      const w = ownKeyWriter(detectProvider({ CLAUDE_CODE_USE_VERTEX: "1" })!, {}, client);
      const r = await w.write({ view: { dir, files: ["pricing.py"], sourceFiles: ["pricing.py"] }, language: "python", count: 1, catalogue: [], suite: "pytest", maxCostUsd: 1, scratch: dir });
      assert.equal(r.bugs.length, 1);
      assert.equal(p.seen.length, 2);
      assert.match(p.seen[0]!.url, /\/projects\/fake-project\/locations\/us-central1\/publishers\/anthropic\/models\/claude-opus-5-5:streamRawPredict$/);
      assert.equal(p.seen[0]!.headers.authorization, "Bearer fake-google-token");
      assert.match(p.seen[1]!.body, /pricing\.py/, "the tool result went back");
    } finally { p.close(); }
  });

  it("a provider that is not set up stops before any test runs, in plain words", { timeout: 60_000 }, async () => {
    const { repo, tmp } = makeRepo("python");
    const aws = await cli(repo, ["--yes"], { tmp, env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined } });
    assert.equal(aws.code, 1);
    assert.match(aws.err, /AWS Bedrock is not set up: No AWS region/);
    assert.doesNotMatch(aws.out, /Clean run/);
    const gcp = await cli(repo, ["--yes"], { tmp, env: { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: undefined } });
    assert.equal(gcp.code, 1);
    assert.match(gcp.err, /Google Vertex AI is not set up: No region was given/);
    assert.doesNotMatch(gcp.out, /Clean run/);
  });
});
