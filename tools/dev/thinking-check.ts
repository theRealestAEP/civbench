// Does the thinking actually reach the transcript now?
import { loadEnv } from "../../src/config/env.ts";
import { Agent } from "@mariozechner/pi-agent-core";
import { resolveModel } from "../../src/agent/models.ts";
loadEnv();

const captured: string[] = [];
const agent = new Agent({
  initialState: {
    systemPrompt: "Think out loud in one sentence, then answer.",
    model: resolveModel("claude-sonnet-5") as never,
    thinkingLevel: "minimal",
    tools: [],
  },
});
agent.subscribe((event: unknown) => {
  const e = event as { type?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } };
  if (e.type !== "message_end" || e.message?.role !== "assistant") return;
  const text = (e.message?.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("");
  if (text) captured.push(text);
});
await agent.prompt("What is 2+2? Explain briefly.");
await agent.waitForIdle();
console.log(captured.length > 0 ? `CAPTURED: ${captured[0]?.slice(0, 120)}` : "NOTHING CAPTURED");
