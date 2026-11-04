/**
 * The conversation with the model: send, run the read-only tools it asks for, send again, until it answers or a limit
 * stops it. Nothing here edits what was already sent: the history only grows, which keeps the thinking blocks valid and
 * the prompt cache working.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { View } from "./blind.js";
import { TOOLS, runTool } from "./tools.js";

const TURNS = 120;
const MAX_TOKENS = 64_000;      // one reply, thinking included
const MIN_TOKENS = 1024;        // less money left than this buys is not worth a request
const TURN_MS = 20 * 60_000;    // a stalled connection ends here, so it cannot hang the run
const EFFORT = "medium";        // what the Agent SDK sent for this model: the scores so far were measured at this setting

// US$ per million tokens: input, output, cache read. Cache writes are 1.25 times input. First match wins, so a longer
// name goes before its prefix. These are Anthropic's own prices: Bedrock and Vertex bill separately, so there it is an estimate.
const PRICES: [string, number, number, number][] = [
  ["claude-fable-5-1", 10, 50, 0.25], ["claude-mythos-5-1", 10, 50, 0.25], ["claude-fable-5", 10, 50, 1],
  ["claude-opus-5-5", 4, 20, 0.2], ["claude-opus-5", 5, 25, 0.5], ["claude-opus-4-8", 5, 25, 0.5], ["claude-opus-4-7", 5, 25, 0.5], ["claude-opus-4-6", 5, 25, 0.5],
  ["claude-sonnet-5-5", 2, 10, 0.2], ["claude-sonnet-5", 2, 10, 0.2], ["claude-sonnet-4-6", 3, 15, 0.3],
  ["claude-haiku-5-5", 0.1, 0.5, 0.01], ["claude-haiku-4-5", 1, 5, 0.1],
];
const UNKNOWN_PRICE: [number, number, number] = [15, 75, 1.5];    // a model not listed counts as dear, so --max-cost still holds

const priceOf = (model: string): [number, number, number] => {
  const row = PRICES.find(([name]) => model.includes(name));
  return row ? [row[1], row[2], row[3]] : UNKNOWN_PRICE;
};

/** What one reply cost, from the usage the API reported. */
export function costOf(model: string, usage: Anthropic.Usage): number {
  const [input, output, read] = priceOf(model);
  return (usage.input_tokens * input + (usage.cache_creation_input_tokens ?? 0) * input * 1.25 + (usage.cache_read_input_tokens ?? 0) * read + usage.output_tokens * output) / 1e6;
}

/** Adaptive thinking and effort exist from these models on. Sending them to an older one is a refused request. */
const ADAPTIVE = /(opus|sonnet|haiku|fable|mythos)-[5-9]|opus-4-[678]|sonnet-4-6/;

/** The one part of a client this code uses, so the three providers and a test's fake all fit. */
export interface MessagesClient {
  messages: {
    stream(params: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }): { finalMessage(): Promise<Anthropic.Message> };
  };
}

export interface Attempt {
  ok: boolean;
  text: string;
  cost: number;
  subtype: "success" | "error_max_turns" | "error_max_budget_usd" | "crash";
  stop: string | null;
  error?: string;     // the first line of what went wrong
  status?: number;    // the HTTP status, when the API answered with an error
}

export interface Conversation {
  client: MessagesClient;
  model: string;
  system: string;
  prompt: string;
  view: View;         // view.dir must be a real path
  maxCostUsd: number;
  signal?: AbortSignal;
}

export async function converse(c: Conversation): Promise<Attempt> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: c.prompt }];
  const [, outputPrice] = priceOf(c.model);
  const adaptive: Partial<Anthropic.MessageStreamParams> = ADAPTIVE.test(c.model) ? { thinking: { type: "adaptive" }, output_config: { effort: EFFORT } } : {};
  let cost = 0;
  for (let turn = 0; turn < TURNS; turn++) {
    // cost is only known after a reply, so the reply itself is held to what the money left can buy
    const room = Math.floor(((c.maxCostUsd - cost) / outputPrice) * 1e6);
    if (room < MIN_TOKENS) return { ok: false, text: "", cost, subtype: "error_max_budget_usd", stop: null };
    let reply: Anthropic.Message;
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(TURN_MS), ...(c.signal ? [c.signal] : [])]);
      reply = await c.client.messages.stream({
        model: c.model, max_tokens: Math.min(MAX_TOKENS, room), system: c.system, tools: TOOLS, messages, cache_control: { type: "ephemeral" }, ...adaptive,
      }, { signal }).finalMessage();
    } catch (e) {
      if (c.signal?.aborted) throw e;
      return { ok: false, text: "", cost, subtype: "crash", stop: null, error: String((e as Error).message ?? e).split("\n")[0], status: (e as { status?: number }).status };
    }
    cost += costOf(c.model, reply.usage);
    const stop = reply.stop_reason;
    const calls = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (stop === "refusal") return { ok: false, text: "", cost, subtype: "success", stop };     // a refused turn's tools never run
    if (stop === "max_tokens") {                                                                // nor a cut-off turn's: its input may be cut too
      return { ok: false, text: "", cost, subtype: Math.min(MAX_TOKENS, room) < MAX_TOKENS ? "error_max_budget_usd" : "success", stop };
    }
    if (stop !== "tool_use" || !calls.length) {
      const text = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      return { ok: true, text, cost, subtype: "success", stop };
    }
    messages.push({ role: "assistant", content: reply.content });     // unchanged: the thinking blocks must go back as they came
    messages.push({
      role: "user",
      content: calls.map((call) => {
        const { text, isError } = runTool(call.name, call.input, c.view);
        return { type: "tool_result", tool_use_id: call.id, content: text, ...(isError ? { is_error: true } : {}) };
      }),
    });
  }
  return { ok: false, text: "", cost, subtype: "error_max_turns", stop: null };
}
