// A one-shot, pre-game leader pick (docs/PLAN.md §5).
//
// Leader choice happens at SETUP, before turn 1, so it does not use the in-turn sandbox. It is a
// single model call: given the match settings and the leader list, the agent names a leader. The
// caller validates the answer against the real list and falls back to the game's default on any
// miss — a bad pick must never block game start. This is a behavior probe: which leader does each
// model choose for given settings.
import { streamSimple } from "@mariozechner/pi-ai";
import { resolveModel } from "./models.ts";
import { requireKey } from "../config/env.ts";

type StreamEvent = { type?: string; delta?: string; error?: { errorMessage?: string } };

/** The one thing a model call needs to look like here, so a test can stand in for the network. */
export type PickStream = (
  model: unknown,
  context: unknown,
  options: Record<string, unknown> & { signal: AbortSignal },
) => AsyncIterable<unknown>;

export type PickOptions = {
  /** Tries before giving up. */
  attempts?: number;
  /** Wall clock per try. The real call answers in one to three seconds; a stall never answers. */
  attemptMs?: number;
  /** Called when a try is abandoned, with what happened. */
  onRetry?: (attempt: number, reason: string) => void;
  /** The model call. Defaults to pi's streamSimple. */
  stream?: PickStream;
};

/**
 * One model call: system + user prompt in, the model's raw text out. Trimmed.
 *
 * Retried on a stall. DeepSeek V4 Flash answers this prompt in about a second and never took
 * more than 37s on a real turn, yet one pick sat for the whole 120s cap with nothing back —
 * a stream that opened and stayed silent — and the seat played the game's default leader. The
 * pick is the behaviour probe the match exists for, so a stalled try is abandoned early and
 * asked again, and only three silent tries fall back to the default.
 */
export async function pickLeader(
  modelId: string,
  system: string,
  user: string,
  thinking: "minimal" | "low" | "medium" | "high" | "xhigh" = "high",
  { attempts = 3, attemptMs = 45_000, onRetry, stream = streamSimple as unknown as PickStream }: PickOptions = {},
): Promise<string> {
  const model = resolveModel(modelId);
  // Only ask for thinking when the model's descriptor says it reasons. Forcing thinkingLevel on a
  // non-reasoning model (GLM 5.3 Flash) made it think for the whole 2000-token budget and emit no
  // answer text, so the pick came back empty and every match fell back to the default leader.
  // maxTokens is the model's own output ceiling, not a magic 2000: a reasoning model needs room to
  // finish thinking AND still answer.
  const options: Record<string, unknown> = { apiKey: requireKey(model.apiKeyEnv), maxTokens: model.maxTokens };
  if (model.reasoning) options.thinkingLevel = thinking;
  const context = { systemPrompt: system, messages: [{ role: "user", content: user }] };

  let lastError = "no answer";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), attemptMs);
    try {
      let text = "";
      for await (const event of stream(model, context, { ...options, signal: control.signal })) {
        const e = event as StreamEvent;
        if (e.type === "text_delta" && e.delta) text += String(e.delta);
        if (e.type === "error") throw new Error(e.error?.errorMessage ?? `${modelId} failed`);
      }
      return text.trim();
    } catch (err) {
      lastError = control.signal.aborted ? `no answer in ${attemptMs / 1000}s` : String(err);
      if (attempt < attempts) onRetry?.(attempt, lastError);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${lastError} (${attempts} tries)`);
}

/** A leader as the game lists it. */
export type LeaderOption = { type: string; name: string; ability?: string };

/**
 * Match a model's free-text answer to a real leader. Accepts the LeaderType token or the display
 * name, case-insensitively, and tolerates surrounding prose ("I'll be XERXES."). Returns the
 * canonical LeaderType, or null when nothing matches — the caller then leaves the default in place.
 */
export function matchLeader(answer: string, leaders: readonly LeaderOption[]): string | null {
  const hay = answer.toLowerCase();
  // Prefer an exact token/name hit; fall back to a substring so prose around the pick still resolves.
  const exact = leaders.find((l) => hay === l.type.toLowerCase() || hay === l.name.toLowerCase());
  if (exact) return exact.type;
  const within = leaders.find((l) => hay.includes(l.type.toLowerCase()) || hay.includes(l.name.toLowerCase()));
  return within ? within.type : null;
}

/** The tiny prompt: settings + leaders + "pick one". Blind to opponents and map — settings only. */
export function leaderPrompt(settings: string, leaders: readonly LeaderOption[]): { system: string; user: string } {
  const list = leaders.map((l) => `- ${l.type}${l.name && l.name !== l.type ? ` (${l.name})` : ""}${l.ability ? `: ${l.ability}` : ""}`).join("\n");
  return {
    system:
      "You are choosing which leader to play in a game of Civilization VII, before it starts. " +
      "Weigh the match settings against each leader's strengths. Reply with ONLY the leader's type token.",
    user: `Match settings:\n${settings}\n\nAvailable leaders:\n${list}\n\nPick ONE leader that best fits these settings. Reply with only the LeaderType token.`,
  };
}
