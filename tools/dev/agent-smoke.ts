// Smoke test: does one model turn actually reach the API and come back?
import { loadEnv } from "../../src/config/env.ts";
import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { resolveModel } from "../../src/agent/models.ts";
loadEnv();

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a test. Call the echo tool once with text 'hi', then reply DONE.",
    model: resolveModel("claude-sonnet-5") as never,
    thinkingLevel: "minimal",
    tools: [
      {
        name: "echo",
        label: "echo",
        description: "Echo text back.",
        parameters: Type.Object({ text: Type.String() }),
        execute: async (_id: string, p: { text: string }) => ({
          content: [{ type: "text" as const, text: "echoed: " + p.text }],
        }),
      } as never,
    ],
  },
});

agent.subscribe((ev: unknown) => {
  const e = ev as { type?: string; errorMessage?: string };
  console.log("EVENT", e.type ?? "?", e.errorMessage ? "ERR:" + e.errorMessage.slice(0, 200) : "");
});

await agent.prompt("Say hello.");
await agent.waitForIdle();
const state = agent.state as unknown as { errorMessage?: string; messages: unknown[] };
console.log("errorMessage:", state.errorMessage ?? "(none)");
console.log("messages:", state.messages.length);
for (const m of state.messages as Array<Record<string, unknown>>) {
  console.log(" ", m.role, m.stopReason ?? "", String(m.errorMessage ?? ""), JSON.stringify(m.usage ?? {}).slice(0, 150));
}
