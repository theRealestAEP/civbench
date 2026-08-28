// Plays a match against the fake game and prints the run report (docs/PLAN.md §13).
// No Civilization install and no API key needed: this is the harness proving itself.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameAdapter } from "../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../src/test-support/fake-game.ts";
import { MatchServer } from "../src/server/match.ts";
import { runMatch, type Seat } from "../src/server/run.ts";
import { ScriptedBrain } from "../src/agent/scripted-brain.ts";
import { renderReport } from "../src/server/report.ts";
import { loadEnv } from "../src/config/env.ts";

loadEnv(); // model brains need ANTHROPIC_API_KEY before any seat is built

const turns = Number(process.argv[2] ?? 5);
const runDir = mkdtempSync(join(tmpdir(), "civbench-demo-"));

const world = makeWorld();
world.met[0] = [1];
const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
  { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 30, secondsPerTurn: 30 },
]);

const seats: Seat[] = [
  {
    config: { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 30, secondsPerTurn: 30 },
    brain: new ScriptedBrain(),
  },
];

console.log(`run dir: ${runDir}\nplaying ${turns} turns...\n`);
const outcomes = await runMatch(server, runDir, seats, { turnLimit: turns});
console.log(renderReport(outcomes, runDir));
