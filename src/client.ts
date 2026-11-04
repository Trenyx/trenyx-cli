/** The API client for the provider the developer chose. The only file that loads an AI provider's package. */
import type { MessagesClient } from "./loop.js";
import { sealEnv, type Provider } from "./provider.js";
import { Stop } from "./types.js";

// logs off: a debug setting in the shell must not print requests. Traces off: the run makes the model call and nothing else.
const OPTIONS = { logLevel: "off", maxRetries: 6, openTelemetry: { traces: false, propagation: false } } as const;

const EXTRA: Partial<Record<Provider["id"], string>> = { bedrock: "@anthropic-ai/bedrock-sdk", vertex: "@anthropic-ai/vertex-sdk" };

/** Built before any test runs, so a missing package or setting stops the run at once. The key is passed in code, so the
 * SDK reads no other credential: no auth token, no saved profile, nothing from the disk. */
export async function makeClient(provider: Provider, env: Record<string, string | undefined> = process.env): Promise<MessagesClient> {
  sealEnv(provider, process.env);       // the SDKs read these for themselves, so what must not be read must not be there
  try {
    if (provider.id === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      return new Anthropic({ ...OPTIONS, apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL ?? null });
    }
    if (provider.id === "bedrock") {
      const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
      return new AnthropicBedrockMantle(OPTIONS);
    }
    const { AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
    const client = new AnthropicVertex(OPTIONS);
    await (client as unknown as { _authClientPromise?: Promise<unknown> })._authClientPromise;     // a failure here is a plain message, not a crash later on
    return client;
  } catch (e) {
    const pkg = EXTRA[provider.id];
    if (pkg && (e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      throw new Stop(`${provider.name} needs one more package, left out of the normal install because it is large. Run:\n  npx --package=trenyx --package=${pkg} trenyx run`);
    }
    throw new Stop(`${provider.name} is not set up: ${String((e as Error).message ?? e).split("\n")[0]}`);
  }
}
