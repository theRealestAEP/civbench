// A whole multi-turn match against the fake game (docs/PLAN.md §14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameAdapter } from "../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../src/test-support/fake-game.ts";
import { MatchServer } from "../src/server/match.ts";
import { runMatch, type Seat } from "../src/server/run.ts";
import { ScriptedBrain } from "../src/agent/scripted-brain.ts";
import type { Brain, TurnContext, TurnReport } from "../src/agent/brain.ts";

function makeMatch(brains: Brain[]) {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-run-"));
  const server = new MatchServer(new GameAdapter(new FakeBridge(makeWorld())), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 },
  ]);
  const seats: Seat[] = brains.map((brain, i) => ({
    config: { slot: i, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 },
    brain,
  }));
  return { runDir, server, seats };
}

test("the scripted baseline plays several turns unattended", async () => {
  const { runDir, server, seats } = makeMatch([new ScriptedBrain()]);
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 3, stallStrikes: 3 });
  const alpha = outcomes[0]!;
  assert.equal(alpha.turnsPlayed, 3);
  assert.ok(alpha.commands > 0, "the baseline must actually drive the sandbox");
  assert.equal(alpha.forfeited, false);
  assert.equal(alpha.forcedEndTurns, 0, "it ends its own turns");
});

test("a brain that hangs is timed out and its turn is forced", async () => {
  class Hanging implements Brain {
    readonly name = "hanging";
    playTurn(): Promise<TurnReport> {
      return new Promise(() => {}); // never settles
    }
  }
  const { runDir, server, seats } = makeMatch([new Hanging()]);
  seats[0]!.config.secondsPerTurn = 0.05;
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 2, stallStrikes: 5 });
  assert.ok(outcomes[0]!.timeouts >= 1, "the watchdog must fire");
  assert.ok(outcomes[0]!.forcedEndTurns >= 1, "and the turn must be ended for it");
});

test("a brain that throws does not crash the match", async () => {
  class Broken implements Brain {
    readonly name = "broken";
    async playTurn(): Promise<TurnReport> {
      throw new Error("boom");
    }
  }
  const { runDir, server, seats } = makeMatch([new Broken()]);
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 4, stallStrikes: 2 });
  assert.equal(outcomes[0]!.forfeited, true, "repeated stalls forfeit the seat");
  assert.ok(outcomes[0]!.turnsPlayed >= 2);
});

test("a seat that never ends its turn is stopped by the action budget", async () => {
  class Spammer implements Brain {
    readonly name = "spammer";
    async playTurn({ exec }: TurnContext): Promise<TurnReport> {
      for (let i = 0; i < 50; i++) await exec("civ skip 10");
      return { commands: 50 };
    }
  }
  const { runDir, server, seats } = makeMatch([new Spammer()]);
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 1, stallStrikes: 3 });
  assert.equal(outcomes[0]!.forcedEndTurns, 1, "it never ended its turn, so we did");
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /ACTION_BUDGET_SPENT/, "the budget must bite and be logged");
  assert.match(events, /"kind":"turn_end_forced"/);
});

test("the event log records every action and its result", async () => {
  const { runDir, server, seats } = makeMatch([new ScriptedBrain()]);
  await runMatch(server, runDir, seats, { turnLimit: 1, stallStrikes: 3 });
  const lines = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n");
  const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
  assert.ok(kinds.includes("turn_begin"));
  assert.ok(kinds.includes("action"));
  assert.ok(kinds.includes("turn_end"));
});

test("autosave writes a save each round when the config asks for it", async () => {
  // autosave_every_turn was parsed and then ignored for most of this project's life; this is the
  // test that keeps it honest.
  const runDir = mkdtempSync(join(tmpdir(), "civbench-save-"));
  const world = makeWorld();
  const cfg = { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 };
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [cfg]);
  server.autosave = true;
  await runMatch(server, runDir, [{ config: cfg, brain: new ScriptedBrain() }], {
    turnLimit: 2,
    stallStrikes: 3,
  });
  assert.ok(world.saves.length >= 2, `expected a save per round, got ${world.saves.length}`);
  assert.match(world.saves[0]!, /^civbench-t\d{4}$/);
});

test("autosave can be turned off", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-nosave-"));
  const world = makeWorld();
  const cfg = { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 };
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [cfg]);
  server.autosave = false;
  await runMatch(server, runDir, [{ config: cfg, brain: new ScriptedBrain() }], {
    turnLimit: 2,
    stallStrikes: 3,
  });
  assert.equal(world.saves.length, 0);
});
