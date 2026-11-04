import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";

export const CLI_DIR = fileURLToPath(new URL("../../", import.meta.url));
export const FIXTURES = path.join(CLI_DIR, "fixtures");
export const MAIN = path.join(CLI_DIR, "dist", "src", "main.js");
export const LANGS = ["go", "python", "typescript", "rust"] as const;
export type L = (typeof LANGS)[number];

export const hasTool = (t: string) => { try { execFileSync(t, [t === "go" ? "version" : "--version"], { stdio: "ignore" }); return true; } catch { return false; } };
export const TOOL: Record<L, string> = { go: "go", python: "python3", typescript: "node", rust: "cargo" };

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });

const made: string[] = [];
process.on("exit", () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
export function tempDir(prefix = "trenyx-unit-"): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
}

/** A fixture as a real git repo with a developer's usual mess in it: uncommitted edit, untracked and ignored files, a
 * stash, a second branch, a hook that would leave a mark if it ever ran. */
export function makeRepo(lang: L): { repo: string; tmp: string; base: string } {
  const base = tempDir(`trenyx-test-${lang}-`);
  const repo = path.join(base, "repo"), tmp = path.join(base, "tmp");
  fs.mkdirSync(tmp);
  fs.cpSync(path.join(FIXTURES, lang), repo, { recursive: true });
  fs.appendFileSync(path.join(repo, ".gitignore"), ".env\n.cache/\n");
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "first");
  sh(repo, "branch", "feature");
  fs.writeFileSync(path.join(repo, "stashed.txt"), "in the stash\n");
  sh(repo, "add", "stashed.txt");
  sh(repo, "stash", "-q");
  fs.writeFileSync(path.join(repo, "notes.txt"), "untracked\n");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=do-not-send\n");
  fs.mkdirSync(path.join(repo, ".cache"));
  fs.writeFileSync(path.join(repo, ".cache", "x"), "ignored\n");
  fs.appendFileSync(path.join(repo, ".gitignore"), "# an uncommitted edit\n");
  const hook = path.join(repo, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${path.join(base, "hook-ran")}"\n`, { mode: 0o755 });
  return { repo, tmp, base };
}

/** A hash of every byte under a folder, .git included: paths, modes, links and contents. */
export function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name, p = path.join(dir, r), st = fs.lstatSync(p);
      h.update(`${r}\0${st.mode}\0`);
      if (st.isSymbolicLink()) h.update(fs.readlinkSync(p));
      else if (st.isDirectory()) walk(r);
      else h.update(fs.readFileSync(p));
    }
  };
  walk("");
  return h.digest("hex");
}

export interface Result { code: number | null; out: string; err: string }

export function cli(repo: string, args: string[], o: { tmp: string; env?: Record<string, string | undefined>; prefix?: string[]; onOutput?: (text: string, kill: (s: NodeJS.Signals) => void) => void; timeoutMs?: number }): Promise<Result> {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: o.tmp, ...o.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.NODE_TEST_CONTEXT;      // node --test sets this, and a nested node --test then runs nothing
  for (const [k, v] of Object.entries(o.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  const argv = [...(o.prefix ?? []), process.execPath, MAIN, "run", ...args];
  return new Promise((resolve) => {
    const c = spawn(argv[0]!, argv.slice(1), { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const kill = (s: NodeJS.Signals) => c.kill(s);
    const timer = setTimeout(() => c.kill("SIGKILL"), o.timeoutMs ?? 170_000);
    c.stdout.on("data", (d) => { out += d; o.onOutput?.(out, kill); });
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

export interface Turn { content?: unknown[]; text?: string; stop?: string; usage?: Partial<Anthropic.Usage>; error?: Error }

/** Stands in for the API client: replies in order, the last one repeating, and keeps each request exactly as it was sent. */
export function fakeClient(turns: Turn[]) {
  const requests: Anthropic.MessageStreamParams[] = [], signals: (AbortSignal | undefined)[] = [];
  const client = {
    messages: {
      stream(params: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }) {
        requests.push(structuredClone(params));
        signals.push(options?.signal);
        const t = turns[Math.min(requests.length - 1, turns.length - 1)]!;
        return {
          finalMessage: async () => {
            if (t.error) throw t.error;
            const content = t.content ?? [{ type: "text", text: t.text ?? "" }];
            const stop_reason = t.stop ?? (content.some((b) => (b as { type: string }).type === "tool_use") ? "tool_use" : "end_turn");
            return { id: "m", type: "message", role: "assistant", model: "fake", content, stop_reason, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...t.usage } } as unknown as Anthropic.Message;
          },
        };
      },
    },
  };
  return { client, requests, signals, prompts: () => requests.map((r) => r.messages[0]!.content as string) };
}
