// Metrics and Elo (docs/PLAN.md §13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreRun } from "../src/score/metrics.ts";
import { GameAdapter } from "../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../src/test-support/fake-game.ts";
import { MatchServer } from "../src/server/match.ts";
import { runMatch } from "../src/server/run.ts";
import { ScriptedBrain } from "../src/agent/scripted-brain.ts";

/** Build a small real run rather than depending on whatever is left in runs/. */
async function makeRun(): Promise<string> {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-score-"));
  const configs = [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 },
    { slot: 1, playerId: 1, name: "beta", actionsPerTurn: 20, secondsPerTurn: 10 },
  ];
  const server = new MatchServer(new GameAdapter(new FakeBridge(makeWorld({ seats: 2 }))), runDir, configs);
  await runMatch(server, runDir, configs.map((config) => ({ config, brain: new ScriptedBrain() })), {
    turnLimit: 3,
    stallStrikes: 3,
  });
  return runDir;
}
import { updateRatings, leaderboard, ANCHOR, START_RATING } from "../src/score/elo.ts";

test("scoring reads a real run and separates outcome from hygiene", async () => {
  const metrics = scoreRun(await makeRun());
  assert.equal(metrics.length, 2);
  const alpha = metrics.find((m) => m.name === "alpha")!;
  assert.ok(alpha.trajectory.length > 0, "a trajectory, not just an endpoint");
  assert.equal(alpha.hygiene.forcedEndTurns, 0);
  assert.ok(alpha.hygiene.actions > 0);
});

test("a short run is inadmissible and says why", async () => {
  const metrics = scoreRun(await makeRun());
  const alpha = metrics.find((m) => m.name === "alpha")!;
  // The demo plays 6 turns; the bar is 50. Admissibility must fail loudly, not silently pass.
  assert.equal(alpha.admissible, false);
  assert.match(alpha.inadmissibleBecause.join(" "), /turns/);
});

test("Age checkpoints collapse a trajectory into the game's own scoring moments", async () => {
  const alpha = scoreRun(await makeRun()).find((m) => m.name === "alpha")!;
  assert.ok(alpha.ageCheckpoints.length >= 1);
  assert.ok(String(alpha.ageCheckpoints[0]!.age).length > 0);
});

test("the winner gains rating and the loser sheds it", () => {
  let ratings = {};
  ratings = updateRatings(ratings, {
    admissible: true,
    ranking: [{ name: "alpha", rank: 1 }, { name: "beta", rank: 2 }],
  });
  const board = leaderboard(ratings);
  assert.equal(board[0]!.name, "alpha");
  assert.ok(board[0]!.rating > START_RATING);
  assert.ok(board[1]!.rating < START_RATING);
});

test("the baseline is a fixed anchor and never drifts", () => {
  let ratings = {};
  for (let i = 0; i < 5; i++) {
    ratings = updateRatings(ratings, {
      admissible: true,
      ranking: [{ name: "model-x", rank: 1 }, { name: ANCHOR, rank: 2 }],
    });
  }
  const board = leaderboard(ratings);
  const anchor = board.find((r) => r.name === ANCHOR)!;
  assert.equal(anchor.rating, START_RATING, "the yardstick must not move");
  assert.ok(board.find((r) => r.name === "model-x")!.rating > START_RATING);
});

test("an inadmissible match changes nothing", () => {
  const before = updateRatings({}, {
    admissible: true,
    ranking: [{ name: "a", rank: 1 }, { name: "b", rank: 2 }],
  });
  const after = updateRatings(before, {
    admissible: false,
    ranking: [{ name: "a", rank: 2 }, { name: "b", rank: 1 }],
  });
  assert.deepEqual(after, before, "a degraded match must not move the board");
});
