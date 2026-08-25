// Model descriptors (docs/PLAN.md §9.4).
//
// pi-ai ships a model registry, but it lags the current lineup — v0.73.1 stops at
// claude-sonnet-4-6. Rather than pin the benchmark to whatever pi happens to know, we declare the
// models we run and fall back to pi's registry for anything else.
//
// `cacheControlFormat: "anthropic"` is what turns prompt caching on: pi then marks the system
// prompt, the last tool definition, and the last user/assistant content with `cache_control`.
// That matters here more than in a normal chat app — an agent turn makes many shell calls and
// resends a growing transcript each time (§9.3).
import { getModel as piGetModel } from "@mariozechner/pi-ai";

type ModelDescriptor = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  cacheControlFormat?: "anthropic";
  apiKeyEnv: string;
};

const anthropic = (
  id: string,
  name: string,
  input: number,
  output: number,
  contextWindow = 1_000_000,
): ModelDescriptor => ({
  id,
  name,
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  // Deliberately false, and it does NOT mean "no thinking".
  //
  // pi-ai decides the thinking parameter from a hardcoded allowlist (`supportsAdaptiveThinking`)
  // that only matches opus-4.6/4.7 and sonnet-4.6. For any newer id it falls back to the old
  // `thinking: {type: "enabled", budget_tokens: N}` shape, which the current models reject with
  // a 400: "thinking.type.enabled is not supported for this model".
  //
  // With `reasoning: false` pi omits the thinking parameter entirely — and these models run
  // adaptive thinking by default when it is omitted. So this yields correct behaviour rather
  // than patching node_modules. Effort is left at the API default.
  reasoning: false,
  input: ["text", "image"],
  // Cache reads are ~0.1x the input rate; writes ~1.25x.
  cost: { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 },
  contextWindow,
  maxTokens: 64_000,
  cacheControlFormat: "anthropic",
  apiKeyEnv: "ANTHROPIC_API_KEY",
});

/**
 * Anything reachable through OpenRouter, which speaks the OpenAI wire format.
 *
 * No `cacheControlFormat`: that field makes pi stamp Anthropic `cache_control` breakpoints, and
 * only Anthropic models understand them. DeepSeek and GLM cache automatically on a prefix match,
 * so the saving still applies — it just needs no marking. Since roughly 90% of an agent turn is
 * re-read prompt, whether caching engages decides whether these models are cheap at all, so the
 * per-turn report prints cached vs new tokens and the answer is visible in the first turn.
 */
const openrouter = (
  id: string,
  name: string,
  input: number,
  output: number,
  cacheRead: number,
  contextWindow: number,
  /**
   * Whether pi should negotiate a thinking parameter with this model.
   *
   * Per model, not per provider. The reliable tell is whether the model streams `thinking_*`
   * events: GLM 5.3 and DeepSeek V4 Pro both do, and both stall with this off — a full 600s turn
   * budget burned with not one command logged. GLM 5.2 and Luna emit none and work either way.
   *
   * tools/dev/tools-probe.ts prints the event stream and whether a real tool call came back. Run
   * it before adding a model: Kimi K3 answers that prompt in prose instead of calling the tool,
   * so it would never act in a match. Then confirm with the bounded tools/dev/brain-probe.ts —
   * a stall looks exactly like a slow model, and DeepSeek takes 190s on a trivial turn.
   */
  reasoning: boolean,
): ModelDescriptor => ({
  id,
  name,
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning,
  input: ["text"],
  // cacheWrite is 0, measured: these providers cache automatically on a prefix match and bill
  // nothing to populate it. A miss is just `input`. Anthropic instead charges 1.25x to write.
  cost: { input, output, cacheRead, cacheWrite: 0 },
  contextWindow,
  maxTokens: 32_000,
  apiKeyEnv: "OPEN_ROUTER_API_KEY",
});

/** Prices are $/1M tokens. */
export const MODELS: Record<string, ModelDescriptor> = {
  "claude-opus-5": anthropic("claude-opus-5", "Claude Opus 5", 5, 25),
  "claude-sonnet-5": anthropic("claude-sonnet-5", "Claude Sonnet 5", 2, 10),
  "claude-haiku-4-5": anthropic("claude-haiku-4-5", "Claude Haiku 4.5", 1, 5, 200_000),

  // Prices checked against OpenRouter's live catalogue on 2026-08-23. They move; `npm run prices`
  // re-checks them rather than trusting this table.
  // The trailing flag is `reasoning`, verified with tools/dev/brain-probe.ts. Do not guess it.
  //
  // DeepSeek V4 Pro is listed but NOT fit to play: it stalls on a real turn with the flag either
  // way — 600s with no output live, 240s with none in the probe — while answering a one-shot
  // prompt in 2.7s. Left here so the next person does not rediscover it. Kimi K3 is worse: it
  // describes running bash in prose instead of calling the tool, so it never acts at all.
  "openai/gpt-5.6-luna": openrouter("openai/gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, 0.02, 1_050_000, true),
  "deepseek/deepseek-v4-pro": openrouter("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 0.519, 1.038, 0.0433, 1_048_576, false),
  "z-ai/glm-5.2": openrouter("z-ai/glm-5.2", "GLM 5.2", 0.966, 3.036, 0.1932, 1_048_576, true),
  "z-ai/glm-5.3": openrouter("z-ai/glm-5.3", "GLM 5.3", 1.4, 4.4, 0.26, 1_048_576, true),
  "moonshotai/kimi-k3": openrouter("moonshotai/kimi-k3", "Kimi K3", 3, 15, 0.3, 262_144, true),
};

export function resolveModel(id: string): ModelDescriptor {
  const known = MODELS[id];
  if (known) return known;
  const fromPi = piGetModel(id) as ModelDescriptor | undefined;
  // Only an Anthropic model may be stamped with Anthropic's key and cache format.
  //
  // This used to accept anything pi's registry knew — OpenAI and Google models included — and
  // hand each one ANTHROPIC_API_KEY plus `cacheControlFormat: "anthropic"`. That either sends a
  // valid Anthropic key to a third-party base URL, or fails mid-match with a 400 when the
  // provider rejects cache_control markers it has never heard of.
  if (fromPi && fromPi.provider === "anthropic") {
    return { ...fromPi, cacheControlFormat: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" };
  }
  if (fromPi) {
    throw new Error(
      `${id} is a ${fromPi.provider} model and is not declared here. Add it to MODELS with its own ` +
        `apiKeyEnv and reasoning flag, verified with tools/dev/brain-probe.ts. Known here: ` +
        Object.keys(MODELS).join(", "),
    );
  }
  throw new Error(
    `unknown model: ${id}. Known here: ${Object.keys(MODELS).join(", ")}`,
  );
}

/** Dollar cost of one turn, with cached input priced separately. */
export function costOf(
  model: ModelDescriptor,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const perToken = (rate: number) => rate / 1_000_000;
  return (
    usage.input * perToken(model.cost.input) +
    usage.output * perToken(model.cost.output) +
    usage.cacheRead * perToken(model.cost.cacheRead) +
    usage.cacheWrite * perToken(model.cost.cacheWrite)
  );
}
