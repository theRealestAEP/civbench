// Two agents in one match (docs/PLAN.md §4, §7).
// The point of this file is isolation: two seats play the same game and must not be able to
// learn anything about each other except through the game.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameAdapter } from "../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../src/test-support/fake-game.ts";
import { MatchServer } from "../src/server/match.ts";
import { runMatch, type Seat } from "../src/server/run.ts";
import { ScriptedBrain } from "../src/agent/scripted-brain.ts";
import { createAgentSandbox } from "../src/agent/sandbox.ts";

const seatConfigs = [
  { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 },
  { slot: 1, playerId: 1, name: "beta", actionsPerTurn: 20, secondsPerTurn: 10 },
];

function makeMatch() {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-multi-"));
  const world = makeWorld({ seats: 2 });
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, seatConfigs);
  const seats: Seat[] = seatConfigs.map((config) => ({ config, brain: new ScriptedBrain() }));
  return { runDir, server, seats };
}

test("both seats play, each in its own directory", async () => {
  const { runDir, server, seats } = makeMatch();
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 2 });
  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.equal(outcome.turnsPlayed, 2);
  }
});

test("the two seats see genuinely different maps", async () => {
  const { runDir, server, seats } = makeMatch();
  await runMatch(server, runDir, seats, { turnLimit: 1 });
  const alpha = readFileSync(join(runDir, "agents/alpha/turns/t0042/tiles.txt"), "utf8");
  const beta = readFileSync(join(runDir, "agents/beta/turns/t0042/tiles.txt"), "utf8");

  assert.notEqual(alpha, beta);
  assert.ok(alpha.includes("tile 1,1"), "alpha sees its own start");
  assert.ok(!beta.includes("tile 1,1"), "beta has never revealed alpha's start");
  assert.ok(beta.includes("tile 6,6"), "beta sees its own start");
  assert.ok(!alpha.includes("tile 6,6"), "alpha has never revealed beta's start");
});

test("neither seat's units appear in the other's dump", async () => {
  const { runDir, server, seats } = makeMatch();
  await runMatch(server, runDir, seats, { turnLimit: 1 });
  const alpha = readFileSync(join(runDir, "agents/alpha/turns/t0042/units.txt"), "utf8");
  const beta = readFileSync(join(runDir, "agents/beta/turns/t0042/units.txt"), "utf8");
  // Units lead with a readable handle now; the engine id is on the same line as engine_id=.
  assert.ok(alpha.includes("engine_id=10"), "alpha sees its own unit");
  assert.ok(!alpha.includes("engine_id=20"), "beta's unit is out of sight");
  assert.ok(beta.includes("engine_id=20"));
  assert.ok(!beta.includes("engine_id=10"));
});

test("a seat cannot reach the other seat's files from inside its sandbox", async () => {
  const { runDir, server } = makeMatch();
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes/alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  for (const attempt of [
    "cat /run/../beta/turns/t0042/tiles.txt",
    "ls /run/../../agents",
    "cat /run/../../events.jsonl",
    "find / -name 'tiles.txt' -path '*beta*'",
  ]) {
    const result = await session.exec(attempt);
    assert.ok(
      result.exitCode !== 0 || !result.stdout.includes("tile "),
      `escape succeeded: ${attempt} -> ${result.stdout.slice(0, 80)}`,
    );
  }
});

// The built-in commands go through the read-only VFS, which already refuses `..` — but the
// CUSTOM tools (grep, head, tail, sed, cut, test, find) resolve paths themselves, and their
// resolver used to check only the prefix before join() normalised the dots away. `grep x
// /run/../../events.jsonl` read the event log agents must never see, and a rival's notes.
test("the custom shell tools cannot traverse out of their mounts either", async () => {
  const { runDir, server } = makeMatch();
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes/alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  for (const attempt of [
    "grep -c . /run/../../events.jsonl",
    "head -5 /run/../../events.jsonl",
    "sed -n '1,5p' /run/../../events.jsonl",
    "grep -c tile /run/../beta/turns/t0042/tiles.txt",
    "cut -d' ' -f1 /notes/../../events.jsonl",
  ]) {
    const result = await session.exec(attempt);
    assert.ok(
      result.exitCode !== 0 && !result.stdout.trim(),
      `custom-tool escape succeeded: ${attempt} -> ${result.stdout.slice(0, 80)}`,
    );
  }
});
