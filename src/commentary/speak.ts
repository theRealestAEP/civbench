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

/** The slice of pi's stream event that the commentator reads. */
type StreamEvent = {
  type?: string;
  delta?: string;
  error?: { errorMessage?: string };
};

export function modelSpeaker(modelId = MODEL_ID): Speak {
  const model = resolveModel(modelId);
  return async (system, user) => {
    let text = "";
    // SAFETY: pi's streamSimple is generic over its own model registry and context types, which
    // values built here cannot satisfy nominally. The model is a real descriptor (resolveModel
    // throws otherwise) and the context is the shape pi documents; only the nominal types differ.
    for await (const event of streamSimple(
      model as never,
      { systemPrompt: system, messages: [{ role: "user", content: user }] } as never,
      { apiKey: requireKey(model.apiKeyEnv), maxTokens: 400 } as never,
    )) {
      // SAFETY: the stream's event union is not exported in a nameable form. StreamEvent is the
      // slice this reads; every field is optional, so an unrecognised event falls through.
      const e = event as StreamEvent;
      if (e.type === "text_delta" && e.delta) text += String(e.delta);
      // Without this a refused or cut-off call returns an empty string, and the run writes a
      // blank commentary file that reads like a quiet turn.
      if (e.type === "error") throw new Error(e.error?.errorMessage ?? `${modelId} failed`);
    }
    return text;
  };
}
