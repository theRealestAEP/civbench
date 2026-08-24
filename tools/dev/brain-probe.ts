// Run PiBrain against the fake and report what the transcript captured.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../../src/config/env.ts";
import { GameAdapter } from "../../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../../src/test-support/fake-game.ts";
import { MatchServer } from "../../src/server/match.ts";
import { createAgentSandbox } from "../../src/agent/sandbox.ts";
import { PiBrain } from "../../src/agent/pi-brain.ts";
loadEnv();

const runDir = mkdtempSync(join(tmpdir(), "bp-"));
const cfg = { slot: 0, playerId: 0, name: "Ada", actionsPerTurn: 20, secondsPerTurn: 120 };
const server = new MatchServer(new GameAdapter(new FakeBridge(makeWorld())), runDir, [cfg]);
const hud = await server.beginTurn(0);
const notes = join(runDir, "n"); mkdirSync(notes, { recursive: true });
const sb = createAgentSandbox(server, 0, notes, () => hud);

const brain = new PiBrain(process.argv[2] ?? "claude-sonnet-5");

// Bounded, because the whole point is telling "hung" apart from "slow". Without this the probe
// hangs exactly like the match did and tells you nothing.
const limitMs = Number(process.argv[3] ?? 240) * 1000;
const started = Date.now();
const bail = setTimeout(() => {
  console.log(`NO RESPONSE within ${limitMs / 1000}s — treat this model as hung`);
  process.exit(2);
}, limitMs);
let reports = 0;
const report = await brain.playTurn({
  hud, turn: 0, playerId: "0", exec: sb.exec,
  report: (u) => { if (u.thinking) reports++; },
});
clearTimeout(bail);
console.log(`ok in ${((Date.now() - started) / 1000).toFixed(0)}s | commands:`, report.commands, "| thinking updates:", reports);
console.log("lastTranscript length:", brain.lastTranscript.length);
console.log("thinking blocks in transcript:", (brain.lastTranscript.match(/^--- thinking/gm) ?? []).length);
console.log("\n--- first 400 chars ---");
console.log(brain.lastTranscript.slice(0, 400));
