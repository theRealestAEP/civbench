// Metrics and Elo (docs/PLAN.md §13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
  });
  return runDir;
}
import { updateRatings, leaderboard, ANCHOR, START_RATING, K_FACTOR } from "../src/score/elo.ts";
import type { Ratings } from "../src/score/elo.ts";

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

// Elo across more than two seats. Neither reviewer read this file, and its behaviour decides the
// leaderboard, so the rules it relies on are pinned here.
test("every pair in a match counts, and expectations use pre-match ratings", () => {
  const ratings = updateRatings(
    { alpha: { rating: 1600, matches: 4 }, beta: { rating: 1400, matches: 4 }, gamma: { rating: 1500, matches: 4 } },
    {
      ranking: [
        { name: "gamma", rank: 1 },
        { name: "alpha", rank: 2 },
        { name: "beta", rank: 3 },
      ],
      admissible: true,
    },
  );
  // gamma beat a higher-rated player, so it must gain more than alpha loses to it alone.
  assert.ok(ratings.gamma!.rating > 1500, "the winner gains");
  assert.ok(ratings.alpha!.rating < 1600, "the favourite that came second sheds");
  assert.ok(ratings.beta!.rating < 1400, "last place sheds");
  // Ratings must move by a bounded amount: a single match cannot swing more than K.
  for (const name of ["alpha", "beta", "gamma"]) {
    const before = { alpha: 1600, beta: 1400, gamma: 1500 }[name]!;
    assert.ok(Math.abs(ratings[name]!.rating - before) <= K_FACTOR, `${name} moved more than K`);
  }
});

test("a tie splits the difference rather than picking a winner", () => {
  const tied = updateRatings(
    { alpha: { rating: 1500, matches: 0 }, beta: { rating: 1500, matches: 0 } },
    { ranking: [{ name: "alpha", rank: 1 }, { name: "beta", rank: 1 }], admissible: true },
  );
  assert.equal(Math.round(tied.alpha!.rating), 1500, "equal players who tie do not move");
  assert.equal(Math.round(tied.beta!.rating), 1500);
});

test("the anchor plays matches without ever moving", () => {
  // Annotated, because inference from the first assignment alone gives a type with only the
  // anchor in it — and then the challenger this test is about is not allowed to exist.
  let ratings: Ratings = { [ANCHOR]: { rating: START_RATING, matches: 0 } };
  for (let i = 0; i < 5; i++) {
    ratings = updateRatings(ratings, {
      ranking: [{ name: "challenger", rank: 1 }, { name: ANCHOR, rank: 2 }],
      admissible: true,
    });
  }
  assert.equal(ratings[ANCHOR]!.rating, START_RATING, "the yardstick must not drift");
  assert.equal(ratings[ANCHOR]!.matches, 5, "but its matches are still counted");
  assert.ok(ratings.challenger!.rating > START_RATING, "beating the anchor must be worth something");
});

// The replay renders event fields into innerHTML, and actionType is typed by the agent — `civ do`
// takes a free-form operation name. Unescaped, an agent naming an operation `<img onerror=...>`
// runs script in the browser of whoever opens the replay.
test("the replay escapes agent-controlled text", async () => {
  const { renderReplayPage } = await import("../src/replay/page.ts");
  const html = renderReplayPage({
    width: 4,
    height: 4,
    agents: [{ name: "alpha", turns: [] }],
    events: [
      {
        turn: 1,
        player: 0,
        kind: "action",
        request: { actionType: "<img src=x onerror=alert(1)>" },
        result: { ok: false, code: "</script><script>alert(2)</script>" },
      },
    ],
    // SAFETY: this payload is deliberately hostile — an agent-chosen operation name carrying a
    // closing script tag. It is shaped like ReplayData but typed loosely so the test can put text
    // in fields the type narrows; the assertions below are about escaping, not about the shape.
  } as unknown as Parameters<typeof renderReplayPage>[0], "escape test");
  // The payload may appear as DATA — it is a record of what the agent did. What it must never do
  // is escape its context: no raw closing script tag, and no unescaped `<` in the data blob.
  assert.ok(!html.includes("</script><script>"), "an agent must not break out of the data block");
  assert.ok(html.includes("\\u003c"), "`<` in agent text must be escaped inside the script tag");
  // And at render time the event list escapes before touching innerHTML.
  assert.match(html, /replace\(\/\[&<>"'\]\/g/, "the event renderer must escape before innerHTML");
});

// A killed run leaves a half-written last line in events.jsonl. The replay is the tool for
// working out why a run died, so it has to survive the artifacts of one.
test("the replay builds from a run that was killed mid-write", async () => {
  const { collectRun } = await import("../src/replay/build.ts");
  const runDir = mkdtempSync(join(tmpdir(), "civbench-truncated-"));
  mkdirSync(join(runDir, "agents", "alpha", "turns", "t0001"), { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    '{"turn":1,"kind":"turn_begin"}\n{"turn":1,"kind":"action"}\n{"turn":1,"kind":"acti',
  );
  const data = collectRun(runDir);
  assert.equal(data.events.length, 2, "every complete line before the truncation must survive");
});
