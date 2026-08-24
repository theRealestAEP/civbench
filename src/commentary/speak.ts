// The commentator's model call (docs/PLAN.md §12.3).
//
// The plan named DeepSeek V4 Pro. It is unfit: it stalls on a real prompt with `reasoning` either
// way, 600s with no output live (docs/FINDINGS.md, "Not every model can play"). Luna is verified,
// costs about a tenth of a cent a turn, and answers in seconds — which is what the ordering
// constraint needs. The commentator has no bearing on the benchmark, so a cheap model is right.
import { streamSimple } from "@mariozechner/pi-ai";
import { resolveModel } from "../agent/models.ts";
import { requireKey } from "../config/env.ts";

/** One prompt in, one block of prose out. Injected, so a test never reaches the network. */
export type Speak = (system: string, user: string) => Promise<string>;

export const MODEL_ID = "openai/gpt-5.6-luna";

export function modelSpeaker(modelId = MODEL_ID): Speak {
  const model = resolveModel(modelId);
  return async (system, user) => {
    let text = "";
    for await (const event of streamSimple(
      model as never,
      { systemPrompt: system, messages: [{ role: "user", content: user }] } as never,
      { apiKey: requireKey(model.apiKeyEnv), maxTokens: 400 } as never,
    )) {
      const e = event as Record<string, any>;
      if (e.type === "text_delta" && e.delta) text += String(e.delta);
      // Without this a refused or cut-off call returns an empty string, and the run writes a
      // blank commentary file that reads like a quiet turn.
      if (e.type === "error") throw new Error(e.error?.errorMessage ?? `${modelId} failed`);
    }
    return text;
  };
}
