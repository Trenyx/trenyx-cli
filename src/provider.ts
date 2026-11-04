/** Which AI provider the developer's own credentials point at, and which settings of theirs the run may see. */
export interface Provider {
  id: "anthropic" | "bedrock" | "vertex";
  name: string;        // said on screen
  where: string;       // the host or region the code goes to
  credential: string;  // the name of what is used, never its value
}

type Env = Record<string, string | undefined>;
const on = (v: string | undefined) => !!v && !["0", "false", "no", ""].includes(v.toLowerCase());
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

export function detectProvider(env: Env): Provider | null {
  if (env.ANTHROPIC_API_KEY) {
    const where = env.ANTHROPIC_BASE_URL ? hostOf(env.ANTHROPIC_BASE_URL) : "api.anthropic.com";
    return { id: "anthropic", name: where === "api.anthropic.com" ? "Anthropic API" : "the endpoint in ANTHROPIC_BASE_URL", where, credential: "your ANTHROPIC_API_KEY" };
  }
  if (on(env.CLAUDE_CODE_USE_BEDROCK)) {
    const url = env.ANTHROPIC_BEDROCK_MANTLE_BASE_URL;
    return { id: "bedrock", name: "AWS Bedrock", where: url ? hostOf(url) : env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "your default AWS region", credential: "your AWS credentials" };
  }
  if (on(env.CLAUDE_CODE_USE_VERTEX)) {
    const url = env.ANTHROPIC_VERTEX_BASE_URL;
    return { id: "vertex", name: "Google Vertex AI", where: url ? hostOf(url) : env.CLOUD_ML_REGION ?? "your Vertex region", credential: "your Google Cloud credentials" };
  }
  return null;
}

const FOR: Record<Provider["id"], RegExp> = {
  anthropic: /^(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|ANTHROPIC_MODEL)$/,
  bedrock: /^(CLAUDE_CODE_USE_BEDROCK|ANTHROPIC_BEDROCK_MANTLE_BASE_URL|ANTHROPIC_MODEL)$/,
  vertex: /^(CLAUDE_CODE_USE_VERTEX|ANTHROPIC_VERTEX_BASE_URL|ANTHROPIC_VERTEX_PROJECT_ID|ANTHROPIC_MODEL)$/,
};

/** An allow-list over everything an Anthropic SDK reads by itself, kept out of this process before one loads: a subscription
 * token, an auth token, a saved profile, custom headers, logging. AWS and Google settings stay, because only their own
 * provider's package reads them and the developer's tests may need them. */
export function sealEnv(p: Provider, env: Env): void {
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_)/.test(k) && !FOR[p.id].test(k)) delete env[k];
}
