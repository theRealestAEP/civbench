// A whole multi-turn match against the fake game (docs/PLAN.md §14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
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
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 3 });
  const alpha = outcomes[0]!;
  assert.equal(alpha.turnsPlayed, 3);
  assert.ok(alpha.commands > 0, "the baseline must actually drive the sandbox");
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
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 2 });
  assert.ok(outcomes[0]!.timeouts >= 1, "the watchdog must fire");
  assert.ok(outcomes[0]!.forcedEndTurns >= 1, "and the turn must be ended for it");
});

test("a turn's reasoning reaches disk as it happens, even when the turn times out", async () => {
  class Muser implements Brain {
    readonly name = "muser";
    playTurn({ log, thread }: TurnContext): Promise<TurnReport> {
      log?.("--- thinking ---\nfirst thought");
      thread?.({ event: "turn_start", turn: 1, model: "muser", memory: "fresh", carriedMessages: 0 });
      return new Promise(() => {}); // still thinking when the clock runs out
    }
  }
  const { runDir, server, seats } = makeMatch([new Muser()]);
  seats[0]!.config.secondsPerTurn = 0.05;
  await runMatch(server, runDir, seats, { turnLimit: 1 });
  const turns = join(runDir, "agents", "alpha", "turns");
  const transcript = readFileSync(join(turns, readdirSync(turns)[0]!, "transcript.md"), "utf8");
  assert.match(transcript, /first thought/, "what it thought before the cutoff is on disk");
  assert.match(transcript, /--- turn over ---\ntimed out/, "and the file says how the turn ended");
  const thread = readFileSync(join(turns, readdirSync(turns)[0]!, "thread.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(thread[0]!).event, "turn_start", "the thread is on disk");
  assert.equal(JSON.parse(thread[1]!).reason, "timeout", "and so is how the turn ended");
  assert.ok(existsSync(join(runDir, "briefing.md")), "the system prompt is saved with the run");
});

test("an error the model returned mid-turn is in the event log, not swallowed", async () => {
  class Flaky implements Brain {
    readonly name = "flaky";
    async playTurn({ exec }: TurnContext): Promise<TurnReport> {
      await exec("civ skip 10");
      await exec("civ end-turn");
      return { commands: 2, errors: ["This model's maximum context length is 1048576 tokens"] };
    }
  }
  const { runDir, server, seats } = makeMatch([new Flaky()]);
  await runMatch(server, runDir, seats, { turnLimit: 1 });
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"brain_error"/, "the error is an event");
  assert.match(events, /maximum context length/, "with the model's own message");
});

test("a brain that throws does not crash the match, and the seat keeps playing", async () => {
  class Broken implements Brain {
    readonly name = "broken";
    async playTurn(): Promise<TurnReport> {
      throw new Error("boom");
    }
  }
  const { runDir, server, seats } = makeMatch([new Broken()]);
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 4 });
  // Every turn, not two. A seat is never removed from the match: Civ has no such rule, and the
  // version that ejected one after N bad turns deadlocked a live run — the game went on offering
  // that seat turns nobody would end.
  assert.equal(outcomes[0]!.turnsPlayed, 4, "a broken seat still gets every turn");
  assert.equal(outcomes[0]!.forcedEndTurns, 4, "and the harness ends each one for it");
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
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 1 });
  assert.equal(outcomes[0]!.forcedEndTurns, 1, "it never ended its turn, so we did");
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /ACTION_BUDGET_SPENT/, "the budget must bite and be logged");
  assert.match(events, /"kind":"turn_end_forced"/);
});

test("the event log records every action and its result", async () => {
  const { runDir, server, seats } = makeMatch([new ScriptedBrain()]);
  await runMatch(server, runDir, seats, { turnLimit: 1 });
  const lines = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n");
  // SAFETY: events.jsonl is written by the match server under test, one Event per line.
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
  await runMatch(server, runDir, [{ config: cfg, brain: new ScriptedBrain() }], { turnLimit: 2 });
  assert.ok(world.saves.length >= 2, `expected a save per round, got ${world.saves.length}`);
  // The label carries the run's name so a second match cannot overwrite the first's save trail.
  assert.match(world.saves[0]!, /^civbench-.+-t\d{4}$/);
});

test("autosave can be turned off", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-nosave-"));
  const world = makeWorld();
  const cfg = { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 };
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [cfg]);
  server.autosave = false;
  await runMatch(server, runDir, [{ config: cfg, brain: new ScriptedBrain() }], { turnLimit: 2 });
  assert.equal(world.saves.length, 0);
});

// `echo "then civ end-turn" >> /notes/notes.md` used to end the agent's turn: the brain inferred
// the end from the command TEXT and the compound exit code. The signal now comes from the `civ`
// command itself (ExecResult.turnEnded), so text that merely mentions end-turn cannot fire it —
// the sandbox e2e test "writing about end-turn in a note does not end the turn" covers the
// mechanism end to end.

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
  // Both seats share a 30s budget, so the per-turn wall clock shows up front on the match line.
  assert.match(hud, /30s per turn/, "the shared per-turn time budget must appear on the match line");
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
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 10 });

  const alpha = outcomes[0]!;
  assert.ok(alpha.turnsPlayed > 6, `must get past turn 6, reached ${alpha.turnsPlayed}`);
  assert.equal(alpha.turnsPlayed, 10, "and play every turn it was asked for");
  assert.equal(alpha.forcedEndTurns, 0, "it ends its own turns, so nothing is forced");
});

// A seat that never clears its blocker keeps playing. Civ has no forfeit: a player who cannot
// finish just has their turn ended and gets the next one. The version that ejected a seat after
// N such turns deadlocked a live run at turn 7 — the game went on offering that seat turns, and
// the harness had stopped listening.
test("an agent that never clears its blocker keeps its seat, and the match keeps moving", async () => {
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
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 10 });

  const alpha = outcomes[0]!;
  assert.equal(alpha.turnsPlayed, 10, "it keeps its seat for every turn");
  assert.ok(alpha.forcedEndTurns > 0, "and the harness ends each turn it could not finish");
});

// The deadlock that stopped a 40-turn run at turn 7.
//
// The harness had a strike count that ejected a seat after N "stalled" turns, and a stall
// included any turn the harness had to end — which is most turns, since an agent's own end-turn
// is refused whenever a decision is pending. Civ has no such rule. A player who runs out of time
// has their turn ended and plays the next one.
test("the match has no forfeit rule", async () => {
  const source = readFileSync(new URL("../src/server/run.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /forfeit/i, "a seat is never removed from the match");
  assert.doesNotMatch(source, /strikes/i, "and nothing counts strikes against it");
});

// Game.turn restarts at 1 when a new Age begins. Run 77cbb1a9653b-001 reached the Antiquity
// boundary at turn 93 and the engine then reported turns 1, 2, 3… — numbers every seat had
// already played, so the loop force-ended each seat as "already played" and fourteen Exploration
// turns went by with no agent acting. The match counts turns across Ages itself.
test("the turn count runs on across an Age boundary, and the seat keeps playing", async () => {
  // The fake world opens on turn 42; its Age ends after turn 44, three turns in.
  const world = makeWorld({ ageEndsAfterTurn: 44 });
  const { runDir, server, seats } = blockedMatch(new ScriptedBrain(), world);
  const outcomes = await runMatch(server, runDir, seats, { turnLimit: 6 });

  const alpha = outcomes[0]!;
  assert.equal(alpha.turnsPlayed, 6, "three turns before the boundary and three after");
  assert.equal(alpha.forcedEndTurns, 0, "no turn is mistaken for one already played");
  // The new Age's first turn is turn 45 of the match, not a second turn 1.
  for (const turn of [42, 43, 44, 45, 46, 47]) {
    assert.ok(
      existsSync(join(runDir, "agents", "alpha", "turns", `t00${turn}`)),
      `turn ${turn} was played and written under its match-wide number`,
    );
  }
  assert.ok(!existsSync(join(runDir, "agents", "alpha", "turns", "t0001")), "and no turn is filed as a second turn 1");
});

// A harness attached to a game mid-round — the old one stopped at Bruno's turn 24, Ada had
// already played — treated Bruno's and Cleo's turn 24 plus Ada's turn 25 as one full round,
// saved, and waited 60s for a turn advance that Bruno and Cleo still had to play. Every round.
test("a match attached mid-round does not wait for a turn advance after the first seat", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-attach-"));
  const world = makeWorld({ seats: 2, players: [0, 1] });
  const adapter = new GameAdapter(new FakeBridge(world));
  // Seat 0 has already ended this turn; the game is waiting on seat 1.
  await adapter.run("endturn", 0, { FORCED: true, CLEAR_ONLY: false });
  const cfgs = [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 },
    { slot: 1, playerId: 1, name: "beta", actionsPerTurn: 20, secondsPerTurn: 10 },
  ];
  const server = new MatchServer(adapter, runDir, cfgs);
  const started = Date.now();
  await runMatch(server, runDir, cfgs.map((config) => ({ config, brain: new ScriptedBrain() })), { turnLimit: 2 });
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.doesNotMatch(events, /turn_advance_timeout/, "the round must not be declared over after one seat");
  assert.ok(Date.now() - started < 30_000, "and nothing waited out a barrier");
});

// Cleo lost her last settlement at turn 58. Hotseat still handed her seat the turn — defeat
// screen up, turn active — and the living-only seat read saw nothing, so the loop saved and
// waited for forty minutes. An eliminated seat's turn is ended for it and it plays no more.
test("an eliminated seat's turn is ended for it and the round moves on", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-dead-"));
  // Three seats, one dead: with two the match would be over, which is a different rule.
  const world = makeWorld({ seats: 3, players: [0, 1, 2] });
  world.dead.add(2);
  world.deadTurnPending.add(2); // the defeat turn: the game still hands the dead seat a turn
  const cfgs = [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 },
    { slot: 1, playerId: 1, name: "beta", actionsPerTurn: 20, secondsPerTurn: 10 },
    { slot: 2, playerId: 2, name: "gamma", actionsPerTurn: 20, secondsPerTurn: 10 },
  ];
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, cfgs);
  const lines: string[] = [];
  const started = Date.now();
  const outcomes = await runMatch(server, runDir, cfgs.map((config) => ({ config, brain: new ScriptedBrain() })), { turnLimit: 2 }, (l) => lines.push(l));
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.ok(lines.some((l) => /gamma has been eliminated/.test(l)), lines.join("\n"));
  assert.match(events, /"playerName":"gamma","kind":"turn_end_forced"/, "the dead seat's turn is ended for it");
  assert.doesNotMatch(events, /turn_advance_timeout/, "and nothing waits out a barrier");
  assert.equal(outcomes[2]!.turnsPlayed, 0, "an eliminated seat plays no turns");
  assert.ok(outcomes[0]!.turnsPlayed >= 2, "the living seat keeps playing");
  assert.ok(Date.now() - started < 30_000);
});

// After the defeat turn the game stops offering the dead seat a turn at all. Marking only an
// ACTIVE dead seat left Cleo a candidate every round, and each round waited the full two-minute
// seat timeout for her: 121s of dead air per round, for hours.
test("a dead seat the game no longer offers a turn is dropped without waiting for it", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-dead2-"));
  const world = makeWorld({ seats: 3, players: [0, 1, 2] });
  world.dead.add(2); // never active again
  const cfgs = [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 10 },
    { slot: 1, playerId: 1, name: "beta", actionsPerTurn: 20, secondsPerTurn: 10 },
    { slot: 2, playerId: 2, name: "gamma", actionsPerTurn: 20, secondsPerTurn: 10 },
  ];
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, cfgs);
  const lines: string[] = [];
  const started = Date.now();
  const outcomes = await runMatch(server, runDir, cfgs.map((config) => ({ config, brain: new ScriptedBrain() })), { turnLimit: 2 }, (l) => lines.push(l));
  assert.ok(lines.some((l) => /gamma has been eliminated/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /waiting for p2/.test(l)), "the dead seat is never waited for");
  assert.equal(outcomes[2]!.turnsPlayed, 0);
  assert.ok(outcomes[0]!.turnsPlayed >= 2);
  assert.ok(Date.now() - started < 30_000, "no seat timeout was paid");
});

