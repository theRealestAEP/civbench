// What block types does the model emit during an actual agent turn?
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../../src/config/env.ts";
import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { resolveModel } from "../../src/agent/models.ts";
import { BRIEFING } from "../../src/agent/briefing.ts";
import { GameAdapter } from "../../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../../src/test-support/fake-game.ts";
import { MatchServer } from "../../src/server/match.ts";
import { createAgentSandbox } from "../../src/agent/sandbox.ts";
loadEnv();

const runDir = mkdtempSync(join(tmpdir(), "bt-"));
const cfg = { slot: 0, playerId: 0, name: "Ada", actionsPerTurn: 20, secondsPerTurn: 120 };
const server = new MatchServer(new GameAdapter(new FakeBridge(makeWorld())), runDir, [cfg]);
const hud = await server.beginTurn(0);
const notes = join(runDir, "n"); mkdirSync(notes, { recursive: true });
const sb = createAgentSandbox(server, 0, notes, () => hud);

const events: string[] = [];
const agent = new Agent({
  initialState: {
    systemPrompt: BRIEFING,
    model: resolveModel("claude-sonnet-5") as never,
    thinkingLevel: "low",
    tools: [{
      name: "bash", label: "bash", description: "Run a shell command.",
      parameters: Type.Object({ command: Type.String() }),
      execute: async (_i: string, p: { command: string }) => {
        const r = await sb.exec(p.command);
        return { content: [{ type: "text" as const, text: (r.stdout || r.stderr).slice(0, 400) }] };
      },
    } as never],
  },
});
agent.subscribe((ev: unknown) => {
  const e = ev as { type?: string; message?: { role?: string; content?: Array<{ type: string }> } };
  if (!e.type?.startsWith("message")) return;
  const blocks = (e.message?.content ?? []).map((c) => c.type).join("+") || "(empty)";
  events.push(`${e.type} role=${e.message?.role} blocks=${blocks}`);
});
await agent.prompt(hud);
await agent.waitForIdle();

console.log("--- events ---");
for (const e of [...new Set(events)].slice(0, 14)) console.log("  " + e);
console.log("\n--- assistant text blocks in final state ---");
for (const m of agent.state.messages as Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>) {
  if (m.role !== "assistant") continue;
  for (const c of m.content ?? []) {
    if (c.type === "text" && c.text) console.log("  TEXT:", c.text.slice(0, 100));
  }
}
