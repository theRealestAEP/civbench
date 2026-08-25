// A whole multi-turn match against the fake game (docs/PLAN.md §14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
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

// `echo "then civ end-turn" >> /notes/notes.md` used to end the agent's turn. The detector
// matched the phrase anywhere in the line, and echo exits 0 — so writing next turn's plan
// aborted this one without ending it. notes.md is exactly where a plan gets written.
test("writing about end-turn in a note does not end the turn", async () => {
  const { endsTurn } = await import("../src/agent/pi-brain.ts");
  assert.equal(endsTurn("civ end-turn"), true);
  assert.equal(endsTurn("civ skip 10; civ end-turn"), true);
  assert.equal(endsTurn("echo 'then civ end-turn' >> /notes/notes.md"), false);
  assert.equal(endsTurn("echo civ end-turn > /notes/plan.md"), false);
  assert.equal(endsTurn("grep 'civ end-turn' /notes/notes.md"), false);
});

// Three tools each assembled a match by hand and each forgot something different: run-match.ts
// and live-session.ts never exported the ruleset, so /run/rules/ — which the briefing tells
// agents to look operation names up in — did not exist on those paths. They also skipped
// MatchFacts, so the "match: N turns total" line the briefing describes never appeared.
test("assembling a match gives it the ruleset, the match facts, and autosave", async () => {
  const { startMatch, seatsFrom } = await import("../src/server/bootstrap.ts");
  const { loadMatchConfig } = await import("../src/config/load.ts");
  const runDir = mkdtempSync(join(tmpdir(), "civbench-assemble-"));
  const { config } = loadMatchConfig("configs/duel-scripted.yaml");
  const { agents } = seatsFrom(config);

  const { server, rules } = await startMatch(
    new GameAdapter(new FakeBridge(makeWorld({ seats: agents.length }))),
    runDir,
    config,
    agents,
    { turnLimit: 7 },
  );

  assert.ok(rules.tables > 0, "the ruleset must be exported: the briefing tells agents to read it");
  assert.equal(server.autosave, config.harness.autosaveEveryTurn, "autosave must follow the config");

  const hud = await server.beginTurn(agents[0]!.playerId);
  assert.match(hud, /match: 7 turns total/, "the match facts line the briefing describes must appear");
  assert.ok(
    existsSync(join(runDir, "agents", agents[0]!.name, "rules")),
    "/run/rules must exist for the agent",
  );
});

// resolveModel used to hand ANTHROPIC_API_KEY and Anthropic's cache_control format to anything
// pi's registry knew, including OpenAI and Google models. That either sends a valid Anthropic key
// to a third-party base URL, or fails mid-match with a 400 from a provider that has never heard
// of cache_control.
test("an undeclared third-party model is refused, not stamped with Anthropic's key", async () => {
  const { resolveModel } = await import("../src/agent/models.ts");
  // Declared models still resolve, with their own key and reasoning flag.
  const luna = resolveModel("openai/gpt-5.6-luna");
  assert.equal(luna.apiKeyEnv, "OPEN_ROUTER_API_KEY");
  assert.equal(resolveModel("claude-sonnet-5").apiKeyEnv, "ANTHROPIC_API_KEY");

  assert.throws(() => resolveModel("totally-made-up-model"), /unknown model/);
});

// The regression that ended every live match, reproduced end to end.
//
// No live run has ever passed turn 6. Each died at the round barrier because a notification
// blocked the end of a turn and the harness could neither see it nor clear it. These drive the
// real loop — run.ts, match.ts, the gamejs scripts — against the fake, with a blocking
// notification arriving every turn.
function blockedMatch(brain: Brain, world = makeWorld()) {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-blocked-"));
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 },
  ]);
  const seats: Seat[] = [
    { config: { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 }, brain },
  ];
  return { runDir, server, seats, world };
}

/** A notification of the kind dismissal cannot clear: a decision, not a notice. */
const blocker = () => [
  { id: 900, name: "NOTIFICATION_LEGACY_COMPLETED", typeHash: 442844772, blocking: true, dismissible: true },
];

test("an agent that clears its blocker plays every turn it is given", async () => {
  const world = makeWorld();
  class Playing implements Brain {
    readonly name = "playing";
    async playTurn(ctx: { exec: (c: string) => Promise<{ exitCode: number }> }) {
      world.notifications.set(0, blocker());
      // What a real agent now does: clear the blocker, park the unit, end the turn.
      await ctx.exec("civ dismiss");
      await ctx.exec("civ skip 10");
      await ctx.exec("civ end-turn");
      return { commands: 3 };
    }
  }
  const { runDir, server, seats } = blockedMatch(new Playing(), world);
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 10, stallStrikes: 3 });

  const alpha = outcomes[0]!;
  assert.ok(alpha.turnsPlayed > 6, `must get past turn 6, reached ${alpha.turnsPlayed}`);
  assert.equal(alpha.turnsPlayed, 10, "and play every turn it was asked for");
  assert.equal(alpha.forfeited, false);
  assert.equal(alpha.forcedEndTurns, 0, "it ends its own turns, so nothing is forced");
});

test("an agent that never clears its blocker forfeits rather than hanging the match", async () => {
  const world = makeWorld();
  class Stuck implements Brain {
    readonly name = "stuck";
    async playTurn(ctx: { exec: (c: string) => Promise<{ exitCode: number }> }) {
      world.notifications.set(0, blocker());
      await ctx.exec("civ end-turn"); // refused: the blocker is still there
      return { commands: 1 };
    }
  }
  const { runDir, server, seats } = blockedMatch(new Stuck(), world);
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 10, stallStrikes: 3 });

  const alpha = outcomes[0]!;
  // The seat gives up, but the MATCH does not hang: forced end-turn still advanced the game each
  // time, which is the behaviour whose absence left a seat active and the round waiting forever.
  assert.equal(alpha.forfeited, true, "a seat that never plays should forfeit");
  assert.ok(alpha.forcedEndTurns > 0, "and the harness must have ended its turns for it");
});
