// Does this model actually emit tool calls through pi?
//
// The plain-text probe passed for every OpenRouter model, but a player agent only ever acts by
// calling a tool. GLM 5.3 sat for nine minutes on turn 1 without logging a single command, so the
// text path passing tells us nothing about the path that matters.
import { loadEnv } from "../../src/config/env.ts";
import { resolveModel } from "../../src/agent/models.ts";
import { streamSimple } from "@mariozechner/pi-ai";

loadEnv();

const bash = {
  name: "bash",
  description: "Run a shell command.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "the command" } },
    required: ["command"],
  },
};

for (const id of process.argv.slice(2)) {
  const model = resolveModel(id);
  const started = Date.now();
  try {
    let text = "";
    const calls: string[] = [];
    const seen = new Set<string>();
    for await (const ev of streamSimple(
      model as never,
      {
        messages: [{ role: "user", content: "List the files in /current. Use the bash tool." }],
        tools: [bash],
      } as never,
      { apiKey: process.env[model.apiKeyEnv]!, maxTokens: 500 } as never,
    )) {
      const e = ev as Record<string, any>;
      seen.add(String(e.type));
      if (e.delta) text += String(e.delta);
      if (e.type === "message_end" || e.type === "done") {
        const blocks = e.message?.content ?? e.partial?.content ?? [];
        for (const block of blocks) {
          if (String(block?.type).toLowerCase().includes("tool")) {
            calls.push(`${block.name} ${JSON.stringify(block.arguments ?? block.input ?? {})}`.slice(0, 80));
          }
        }
      }
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${id.padEnd(26)} ${secs.padStart(6)}s  toolCalls=${calls.length}  ${calls[0] ?? `text=${JSON.stringify(text.slice(0, 50))}`}  events=[${[...seen].join(",")}]`);
  } catch (err) {
    console.log(`${id.padEnd(26)} FAILED: ${(err as Error).message.slice(0, 150)}`);
  }
}
