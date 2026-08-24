// Does an OpenRouter model answer through pi, and does its prompt cache engage?
//
// Caching decides whether these models are cheap at all: ~90% of an agent turn is re-read prompt.
// Anthropic needs explicit cache_control markers; DeepSeek and GLM cache automatically on a
// prefix match. This sends the same long prefix twice and prints what the provider reports.
import { loadEnv } from "../../src/config/env.ts";
import { resolveModel } from "../../src/agent/models.ts";
import { streamSimple } from "@mariozechner/pi-ai";

loadEnv();

const PREFIX = "You are a benchmark harness. ".repeat(400); // ~2.4k tokens, above every cache floor

async function ask(id: string, label: string) {
  const model = resolveModel(id);
  let text = "";
  let usage: Record<string, unknown> | null = null;
  for await (const ev of streamSimple(
    model as never,
    { messages: [{ role: "user", content: `${PREFIX}\n\nReply with exactly: OK` }] } as never,
    { apiKey: process.env[model.apiKeyEnv]!, maxTokens: 400 } as never,
  )) {
    const e = ev as Record<string, any>;
    if (e.type === "text_delta" && e.delta) text += e.delta;
    const found = e.usage ?? e.message?.usage ?? e.partial?.usage;
    if (found) usage = found;
  }
  console.log(`  ${label.padEnd(8)} reply=${JSON.stringify(text.trim()).padEnd(6)} usage=${JSON.stringify(usage)}`);
}

for (const id of process.argv.slice(2)) {
  console.log(id);
  try {
    await ask(id, "first");
    await ask(id, "repeat"); // a cache hit should show here, if the provider does it
  } catch (err) {
    console.log(`  FAILED: ${(err as Error).message.slice(0, 200)}`);
  }
}
