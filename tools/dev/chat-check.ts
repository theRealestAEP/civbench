import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameAdapter } from "../../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../../src/test-support/fake-game.ts";
import { MatchServer } from "../../src/server/match.ts";
import { createAgentSandbox } from "../../src/agent/sandbox.ts";

const runDir = mkdtempSync(join(tmpdir(), "chat-"));
const seats = [
  { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 60 },
  { slot: 1, playerId: 1, name: "beta", actionsPerTurn: 20, secondsPerTurn: 60 },
];
const server = new MatchServer(new GameAdapter(new FakeBridge(makeWorld({ seats: 2 }))), runDir, seats);
server.startChatTurn();

const hudA = await server.beginTurn(0);
const notesA = join(runDir, "na"); mkdirSync(notesA, { recursive: true });
const a = createAgentSandbox(server, 0, notesA, () => hudA);
console.log("alpha:", (await a.exec("civ say @beta I will not settle east of the river.")).stdout.trim());
console.log("alpha broadcast:", (await a.exec("civ say Anyone who touches Uruk answers to me.")).stdout.trim());

const hudB = await server.beginTurn(1);
console.log("\nbeta HUD messages line:", hudB.split("\n").find((l) => l.startsWith("messages:")));
console.log("beta /current/messages.txt:");
process.stdout.write(readFileSync(join(server.currentTurnDir(1)!, "messages.txt"), "utf8"));
