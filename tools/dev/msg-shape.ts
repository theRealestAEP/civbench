// What does an assistant message actually look like after a turn?
import { loadEnv } from "../../src/config/env.ts";
import { Agent } from "@mariozechner/pi-agent-core";
import { resolveModel } from "../../src/agent/models.ts";
loadEnv();

const agent = new Agent({
  initialState: {
    systemPrompt: "Reply with one short sentence.",
    model: resolveModel("claude-sonnet-5") as never,
    thinkingLevel: "minimal",
    tools: [],
  },
});
await agent.prompt("Say hello briefly.");
await agent.waitForIdle();

// This tool exists to print the SHAPE of pi's messages, so it reads them as open records on
// purpose. AgentMessage is a union of closed object types with no index signature, so the
// conversion goes through `unknown` rather than pretending the two overlap.
for (const m of agent.state.messages as unknown as Array<Record<string, unknown>>) {
  const content = m.content as Array<Record<string, unknown>> | string | undefined;
  console.log(`role=${m.role} contentType=${Array.isArray(content) ? "array" : typeof content}`);
  if (Array.isArray(content)) {
    for (const c of content) console.log(`   block type=${c.type} keys=${Object.keys(c).join(",")}`);
  } else if (typeof content === "string") {
    console.log(`   string: ${content.slice(0, 60)}`);
  }
}
