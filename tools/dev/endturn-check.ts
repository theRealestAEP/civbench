import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameAdapter } from "../../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../../src/test-support/fake-game.ts";
import { MatchServer } from "../../src/server/match.ts";
import { createAgentSandbox } from "../../src/agent/sandbox.ts";

const runDir = mkdtempSync(join(tmpdir(), "et-"));
const cfg = { slot: 0, playerId: 0, name: "a", actionsPerTurn: 20, secondsPerTurn: 60 };
const server = new MatchServer(new GameAdapter(new FakeBridge(makeWorld())), runDir, [cfg]);
const hud = await server.beginTurn(0);
const notes = join(runDir, "n"); mkdirSync(notes, { recursive: true });
const s = createAgentSandbox(server, 0, notes, () => hud);

for (const cmd of ["civ end-turn", "civ end-turn", "civ skip 10"]) {
  const r = await s.exec(cmd);
  console.log(`$ ${cmd}\n  exit=${r.exitCode} out=${JSON.stringify(r.stdout.slice(0,90))} err=${JSON.stringify(r.stderr.slice(0,90))}`);
}
