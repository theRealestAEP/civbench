// Two model turns against the fake game. Proves the loop end to end and, on turn 2, that the
// cached briefing is actually being read from cache (docs/PLAN.md §9.4).
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, requireAnthropicKey } from "../../src/config/env.ts";
import { GameAdapter } from "../../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../../src/test-support/fake-game.ts";
import { MatchServer } from "../../src/server/match.ts";
import { createAgentSandbox } from "../../src/agent/sandbox.ts";
import { PiBrain } from "../../src/agent/pi-brain.ts";

loadEnv();
requireAnthropicKey();

const runDir = mkdtempSync(join(tmpdir(), "civbench-one-"));
const cfg = { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 30, secondsPerTurn: 300 };
const server = new MatchServer(new GameAdapter(new FakeBridge(makeWorld())), runDir, [cfg]);
const brain = new PiBrain(process.argv[2] ?? "claude-sonnet-5");

for (const turn of [0, 1]) {
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);
  const started = Date.now();
  const report = await brain.playTurn({ hud, turn, playerId: "0", exec: session.exec });
  console.log(
    `turn ${turn}: ${report.commands} cmds, ${((Date.now() - started) / 1000).toFixed(1)}s — ${report.notes}`,
  );
}

const u = brain.usage;
console.log(`\ntotals: in ${u.input} out ${u.output} cacheRead ${u.cacheRead} cacheWrite ${u.cacheWrite}`);
console.log(`cost: $${u.cost.toFixed(4)}`);
console.log(
  u.cacheRead > 0
    ? `caching WORKS — ${u.cacheRead} tokens served from cache`
    : "caching did NOT engage (check the briefing is >1024 tokens and byte-stable)",
);
