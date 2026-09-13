// The commentator (docs/PLAN.md §12.3).
//
// The model call is injected, so nothing here reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTurns, interestOf, shouldSpeak, HEARTBEAT_EVERY, inProgressTurn, liveSnapshot } from "../src/commentary/brief.ts";
import type { CompleteTurn, TurnBrief, SeatStats } from "../src/commentary/brief.ts";
import {
  commentateTurn, commentateLive, hasCommentary, promptFor, writeCommentary, newMemory, MEMORY_TURNS, PLAY_KEY } from "../src/commentary/commentate.ts";
import type { Speak } from "../src/commentary/speak.ts";

type Event = Record<string, unknown>;

function makeRun(events: Event[]): string {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-cast-"));
  writeFileSync(
    join(runDir, "events.jsonl"),
    events.map((e, seq) => JSON.stringify({ seq, at: "2026-08-24T03:10:04.589Z", ...e })).join("\n") + "\n",
  );
  return runDir;
}

const begin = (turn: number, seat: string) => ({ turn, player: 0, playerName: seat, kind: "turn_begin" });
const end = (turn: number, seat: string, forced = false) => ({
  turn, player: 0, playerName: seat, kind: forced ? "turn_end_forced" : "turn_end",
});
const action = (turn: number, seat: string, request: Event, ok = true, result: Event = {}) => ({
  turn, player: 0, playerName: seat, kind: "action", request, result: { ok, ...result },
});

function writeTranscript(runDir: string, seat: string, turn: number, text: string): void {
  const dir = join(runDir, "agents", seat, "turns", `t${String(turn).padStart(4, "0")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transcript.md"), text);
}

/** Answers every prompt the same way, and keeps what it was asked. */
function stub(reply = "Ada founded her capital."): Speak & { prompts: string[] } {
  const prompts: string[] = [];
  const speak = async (_system: string, user: string) => {
    prompts.push(user);
    return reply;
  };
  return Object.assign(speak, { prompts });
}

test("a finished turn yields one brief per seat", () => {
  const runDir = makeRun([
    begin(1, "Ada"), action(1, "Ada", { actionType: "UNITOPERATION_FOUND_CITY", targetId: "65536" }), end(1, "Ada"),
    begin(1, "Bruno"), end(1, "Bruno"),
  ]);
  const turns = readTurns(runDir);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]!.seats.map((s) => s.seat), ["Ada", "Bruno"]);
  assert.deepEqual(turns[0]!.seats[0]!.did, ["ok UNITOPERATION_FOUND_CITY on 65536"]);
});

// The caster must never describe a turn that is still being played.
test("a turn still in progress is left out", () => {
  const runDir = makeRun([
    begin(1, "Ada"), end(1, "Ada"),
    begin(1, "Bruno"), // Bruno is still thinking
  ]);
  assert.deepEqual(readTurns(runDir), []);
});

// "CITYOPERATION_BUILD on 65536" says nothing about what the city is making, so the commentary
// would have to invent it. The build argument carries the answer and must survive.
test("a build says what is being built", () => {
  const runDir = makeRun([
    begin(2, "Bruno"),
    action(2, "Bruno", { kind: "build", actionType: "CITYOPERATION_BUILD", targetId: "65536", args: { thing: "UNIT_SCOUT" } }),
    end(2, "Bruno"),
  ]);
  assert.match(readTurns(runDir)[0]!.seats[0]!.did[0]!, /UNIT_SCOUT/);
});

test("a failed action is kept, with its code but not the harness error text", () => {
  const runDir = makeRun([
    begin(1, "Ada"),
    action(1, "Ada", { actionType: "SET_TECH_TREE_NODE" }, false, { code: "ILLEGAL_ACTION", message: "the game refused this action" }),
    end(1, "Ada"),
  ]);
  const line = readTurns(runDir)[0]!.seats[0]!.did[0]!;
  assert.match(line, /^FAILED SET_TECH_TREE_NODE/);
  assert.match(line, /ILLEGAL_ACTION/);
  assert.doesNotMatch(line, /refused this action/, "error prose pulled the caster toward narrating plumbing");
});

test("a turn the loop had to end is flagged", () => {
  const runDir = makeRun([begin(3, "Cleo"), end(3, "Cleo", true)]);
  const turn = readTurns(runDir)[0]!;
  assert.equal(turn.seats[0]!.endedByLoop, true);
  assert.match(promptFor(turn), /never ended its own turn/);
});

test("an empty turn reads as empty rather than as nothing at all", () => {
  const runDir = makeRun([begin(3, "Cleo"), end(3, "Cleo")]);
  const turn = readTurns(runDir)[0]!;
  assert.deepEqual(turn.seats[0]!.did, []);
  assert.match(promptFor(turn), /took no actions/);
});

// The opening states the plan. Everything after it is dump reading, and it is enormous.
test("only the opening of the seat's own reasoning is carried", () => {
  const runDir = makeRun([begin(1, "Ada"), end(1, "Ada")]);
  writeTranscript(
    runDir, "Ada", 1,
    "--- thinking ---\nI will found on the river.\n\n--- ran ---\n$ civ near 10 3\n" +
      "tile 1,1 terrain=flat\n".repeat(500) + "\n--- thinking ---\nSecond thoughts.\n",
  );
  const turn = readTurns(runDir)[0]!;
  assert.equal(turn.seats[0]!.reasoning, "I will found on the river.");
  assert.match(promptFor(turn), /found on the river/);
});

test("a seat that wrote no reasoning still gets a brief", () => {
  const runDir = makeRun([begin(1, "Ada"), end(1, "Ada")]);
  const turn = readTurns(runDir)[0]!;
  assert.equal(turn.seats[0]!.reasoning, "");
  assert.doesNotMatch(promptFor(turn), /reasoning/);
});

test("a turn gets one play-by-play call that sees every seat", async () => {
  const runDir = makeRun([
    begin(1, "Ada"), end(1, "Ada"),
    begin(1, "Bruno"), end(1, "Bruno"),
  ]);
  const speak = stub();
  const lines = await commentateTurn(readTurns(runDir)[0]!, speak);
  assert.equal(speak.prompts.length, 1, "one call for the whole turn, not one per seat");
  assert.deepEqual(lines.map((l) => l.seat), ["play-by-play"]);
  assert.match(speak.prompts[0]!, /Ada/);
  assert.match(speak.prompts[0]!, /Bruno/, "one prompt sees every seat, so it can pick the biggest beats");
});

// A model that answers in paragraphs still has to render on one line beside the turn.
test("a multi-paragraph answer is flattened", async () => {
  const runDir = makeRun([begin(1, "Ada"), end(1, "Ada")]);
  const lines = await commentateTurn(readTurns(runDir)[0]!, stub("  First.\n\nSecond.\n"));
  assert.equal(lines[0]!.text, "First. Second.");
});

test("commentary is written per turn and appended to the running transcript", () => {
  const runDir = makeRun([begin(1, "Ada"), end(1, "Ada")]);
  assert.equal(hasCommentary(runDir, 1), false);
  writeCommentary(runDir, 1, [{ seat: "Ada", text: "Ada founded her capital." }]);
  writeCommentary(runDir, 2, [{ seat: "Ada", text: "Ada pushed her scout north." }]);
  assert.equal(hasCommentary(runDir, 1), true);
  assert.match(readFileSync(join(runDir, "commentary/t0002.md"), "utf8"), /pushed her scout north/);
  const running = readFileSync(join(runDir, "commentary.md"), "utf8");
  assert.match(running, /founded her capital/);
  assert.match(running, /pushed her scout north/);
});

// The single thing that would invalidate the benchmark: commentary reaching a playing agent.
// The sandbox mounts runs/<id>/agents/<seat> as /run, so nothing may be written under it.
test("commentary lands outside every agent directory", () => {
  const runDir = makeRun([begin(1, "Ada"), end(1, "Ada")]);
  writeCommentary(runDir, 1, [{ seat: "Ada", text: "Ada founded her capital." }]);
  assert.equal(existsSync(join(runDir, "commentary/t0001.md")), true);
  assert.equal(existsSync(join(runDir, "agents/Ada/commentary")), false);
  assert.equal(existsSync(join(runDir, "agents/Ada/commentary.md")), false);
});

// Without memory the caster can only describe one turn at a time, and the plan's own example
// line — "they are still the only one who has met nobody" — cannot be written at all.
test("the caster is given its own recent lines", async () => {
  const prompts: string[] = [];
  const speak = async (_system: string, user: string) => {
    prompts.push(user);
    return `line ${prompts.length}`;
  };
  const memory = newMemory();
  const turn = (n: number): CompleteTurn => ({
    turn: n,
    seats: [{ seat: "Ada", turn: n, did: [`ok  did thing ${n}`], endedByLoop: false, reasoning: "" }],
  });

  await commentateTurn(turn(1), speak, memory);
  assert.doesNotMatch(prompts[0]!, /Your last/, "the first turn has no past to compare to");

  await commentateTurn(turn(2), speak, memory);
  assert.match(prompts[1]!, /Your last/);
  assert.match(prompts[1]!, /line 1/, "it must see what it actually said last turn");
});

test("memory is a sliding window, so a long match does not grow the prompt forever", async () => {
  const prompts: string[] = [];
  const speak = async (_system: string, user: string) => {
    prompts.push(user);
    return `line ${prompts.length}`;
  };
  const memory = newMemory();
  for (let n = 1; n <= MEMORY_TURNS + 3; n++) {
    await commentateTurn(
      { turn: n, seats: [{ seat: "Ada", turn: n, did: ["ok  did a thing"], endedByLoop: false, reasoning: "" }] },
      speak,
      memory,
    );
  }
  assert.equal(memory.get(PLAY_KEY)!.length, MEMORY_TURNS, "the window must stay bounded");
  const last = prompts.at(-1)!;
  assert.doesNotMatch(last, /\bline 1\b/, "the oldest line must have fallen out of the window");
  assert.match(last, new RegExp(`line ${prompts.length - 1}`), "the newest must still be in it");
});

// ---- the strategy-and-standings layer -------------------------------------------------------

function writeHeader(runDir: string, seat: string, turn: number, gold: number, legacy = 0): void {
  const dir = join(runDir, "agents", seat, "turns", `t${String(turn).padStart(4, "0")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "header.json"),
    JSON.stringify({
      turn, age: "antiquity", gold,
      yields: { science: 4, culture: 2 },
      settlements: { total: 1 },
      unitCount: 3,
      legacy: [{ type: "LEGACY_PATH_ANTIQUITY_SCIENCE", score: legacy }],
    }),
  );
}

function writeNotes(runDir: string, seat: string, lines: string[]): void {
  const dir = join(runDir, "notes", seat);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.md"), "# notes\n\nheader text\n" + lines.join("\n") + "\n");
}

// The caster could describe actions but never the race: nothing read header.json, so gold,
// yields and legacy progress — the numbers a viewer watches for — were invisible to it.
test("a seat's standing reaches the prompt", () => {
  const runDir = makeRun([begin(4, "Ada"), end(4, "Ada")]);
  writeHeader(runDir, "Ada", 4, 147, 3);
  const turn = readTurns(runDir)[0]!;
  const prompt = promptFor(turn);
  assert.match(prompt, /Where it stands/);
  assert.match(prompt, /treasury 147/);
  assert.match(prompt, /antiquity_science 3/, "legacy progress is the win condition — it must be visible");
});

// The journal is where agents distil their plan — one dated line per turn. It beats the
// transcript opening, which is usually "let me read delta.md".
test("the seat's journal reaches the prompt, tail only", () => {
  const runDir = makeRun([begin(4, "Ada"), end(4, "Ada")]);
  writeNotes(runDir, "Ada", [
    ...Array.from({ length: 12 }, (_, i) => `- t${i + 1}: filler turn ${i + 1}`),
    "- t13: chose Writing; queued settler for second city",
  ]);
  const turn = readTurns(runDir)[0]!;
  const prompt = promptFor(turn);
  assert.match(prompt, /its own journal/i);
  assert.match(prompt, /queued settler/);
  assert.doesNotMatch(prompt, /filler turn 1\b/, "only the tail is carried, or a long match grows the prompt");
  assert.doesNotMatch(prompt, /header text/, "the file's boilerplate header is not journal content");
});

// The per-seat lines never compare seats. Every few turns the caster steps back and calls the
// race — that is the segment a viewer actually wants.
test("a standings call happens on the cadence, and only with numbers to stand on", async () => {
  const speak = stub("Ada leads on science.");
  const seatsFor = (turn: number, stats: boolean): CompleteTurn => {
    const runDir = makeRun([begin(turn, "Ada"), end(turn, "Ada"), begin(turn, "Bruno"), end(turn, "Bruno")]);
    if (stats) {
      writeHeader(runDir, "Ada", turn, 100, 5);
      writeHeader(runDir, "Bruno", turn, 40);
    }
    return readTurns(runDir)[0]!;
  };

  const offCadence = await commentateTurn(seatsFor(4, true), speak);
  assert.deepEqual(offCadence.map((l) => l.seat), ["play-by-play"], "turn 4 is not a standings turn");

  const onCadence = await commentateTurn(seatsFor(5, true), speak);
  assert.deepEqual(onCadence.map((l) => l.seat), ["play-by-play", "standings"]);
  const standingsPrompt = speak.prompts.at(-1)!;
  assert.match(standingsPrompt, /Ada:.*treasury 100/, "the standings call must see every seat side by side");
  assert.match(standingsPrompt, /Bruno:.*treasury 40/);

  const noNumbers = await commentateTurn(seatsFor(10, false), speak);
  assert.deepEqual(noNumbers.map((l) => l.seat), ["play-by-play"], "no numbers, no standings call");
});

// The follow loop drops whole turns when it falls behind — right for pacing, but the dropped
// turn might be the one where war broke out. The big beats survive the drop.
test("milestones survive a dropped turn and are told once", async () => {
  const { milestonesOf } = await import("../src/commentary/brief.ts");
  const runDir = makeRun([
    begin(7, "Ada"),
    action(7, "Ada", { actionType: "DIPLOMACY_ACTION_DECLARE_WAR", targetId: "2" }),
    action(7, "Ada", { actionType: "UNITOPERATION_MOVE_TO", targetId: "131072" }),
    end(7, "Ada"),
    begin(7, "Bruno"), end(7, "Bruno"),
  ]);
  const dropped = readTurns(runDir)[0]!;
  const milestones = milestonesOf(dropped);
  assert.equal(milestones.length, 1, "a routine move is not a milestone");
  assert.match(milestones[0]!, /DECLARE_WAR/);

  const speak = stub("War came while we were away.");
  const next: CompleteTurn = {
    turn: 8,
    seats: [
      { seat: "Ada", turn: 8, did: [], endedByLoop: false, reasoning: "" },
      { seat: "Bruno", turn: 8, did: [], endedByLoop: false, reasoning: "" },
    ],
  };
  await commentateTurn(next, speak, newMemory(), milestones);
  assert.equal(speak.prompts.length, 1, "one call for the whole turn");
  assert.match(speak.prompts[0]!, /DECLARE_WAR/, "the play-by-play prompt carries the missed beats");
});

// The narrator announced a seat "absent from this turn's record" for a turn that, once finished,
// held all three seats. Cause: seats play one at a time, and the turn reader called a turn done as
// soon as ended-count met begun-count-so-far. In the window after the second seat ended and before
// the third BEGAN, both were two, so a live read emitted the turn a seat short. The roster (from
// the manifest) is the fix: a turn is done when every roster seat has ended it.
function makeRunWithRoster(events: Event[], roster: string[]): string {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-cast-"));
  writeFileSync(
    join(runDir, "events.jsonl"),
    events.map((e, seq) => JSON.stringify({ seq, at: "2026-08-29T03:10:04.589Z", ...e })).join("\n") + "\n",
  );
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ agents: roster.map((name) => ({ name })) }));
  return runDir;
}

test("a turn is not finished until every roster seat has ended it", () => {
  // Turn 1 is complete. In turn 2, the third seat has not begun yet — the exact race window.
  const runDir = makeRunWithRoster(
    [
      begin(1, "Ada"), end(1, "Ada"), begin(1, "Bruno"), end(1, "Bruno"), begin(1, "Cleo"), end(1, "Cleo"),
      begin(2, "Ada"), end(2, "Ada"), begin(2, "Bruno"), end(2, "Bruno"), // Cleo has not begun turn 2
    ],
    ["Ada", "Bruno", "Cleo"],
  );
  const turns = readTurns(runDir);
  assert.deepEqual(turns.map((t) => t.turn), [1], "turn 2 must wait for Cleo, not go out a seat short");
  assert.deepEqual(turns[0]!.seats.map((s) => s.seat), ["Ada", "Bruno", "Cleo"]);
});

test("a later turn beginning still finishes a turn, so elimination does not stall the caster", () => {
  // Cleo never ends turn 2, but turn 3 has begun: the game moved on without her (eliminated). The
  // turn must still be narrated, with the seats that actually played it.
  const runDir = makeRunWithRoster(
    [
      begin(2, "Ada"), end(2, "Ada"), begin(2, "Bruno"), end(2, "Bruno"),
      begin(3, "Ada"),
    ],
    ["Ada", "Bruno", "Cleo"],
  );
  const turns = readTurns(runDir);
  assert.deepEqual(turns.map((t) => t.turn), [2]);
  assert.deepEqual(turns[0]!.seats.map((s) => s.seat), ["Ada", "Bruno"], "narrate who actually played");
});

// The narrator narrated a seat's "illegal attempts". The prompt was handing it the seat's failed
// and refused console lines, and the voice rules alone did not hold. Those lines are invisible in
// the game world, so they must not reach the caster at all — it cannot narrate what it never sees.
test("failed and refused actions never reach the commentary prompt", () => {
  const runDir = makeRun([
    begin(5, "Ada"),
    action(5, "Ada", { kind: "build", actionType: "CITYOPERATION_BUILD", targetId: "65536", args: { thing: "UNIT_SCOUT" } }),
    action(5, "Ada", { actionType: "SET_TECH_TREE_NODE" }, false, { code: "ILLEGAL_ACTION" }),
    end(5, "Ada"),
  ]);
  const turn = readTurns(runDir);
  const prompt = promptFor(turn[0]!);
  assert.match(prompt, /UNIT_SCOUT/, "the successful build is game-visible and must stay");
  assert.doesNotMatch(prompt, /ILLEGAL_ACTION/, "an illegal attempt is console plumbing, not an event");
  assert.doesNotMatch(prompt, /FAILED/, "no failure lines reach the caster");
});

// ---- the interestingness gate ----------------------------------------------------------------

const seatBrief = (name: string, over: Partial<TurnBrief> = {}): TurnBrief => ({
  turn: 7, seat: name, did: [], endedByLoop: false, reasoning: "", ...over,
});

const statsOf = (over: Partial<SeatStats> = {}): SeatStats => ({
  age: "antiquity", gold: 100, goldPerTurn: 2, science: 10, culture: 10, production: 10,
  population: 5, settlements: 2, units: 5, researching: null, legacy: {}, ...over,
});

// Every event kind on the always-speak list, as the did-lines readTurns actually produces.
test("the gate speaks on every big event kind", () => {
  const cases: Array<[string, Partial<TurnBrief>]> = [
    ["a city founded", { did: ["ok UNITOPERATION_FOUND_CITY on 131072"] }],
    ["a ranged attack", { did: ["ok UNITOPERATION_RANGE_ATTACK on 196609"] }],
    ["a naval attack", { did: ["ok UNITOPERATION_NAVAL_ATTACK on 196609"] }],
    ["war declared", { did: ["ok DECLARE_WAR on p3"] }],
    ["peace made", { did: ["ok MAKE_PEACE on p3"] }],
    ["an alliance formed", { did: ["ok FORM_ALLIANCE on p3"] }],
    ["words exchanged", { did: ['said to everyone: "meet me at the river"'] }],
    ["a deal accepted", { did: ["ok accept on p3"] }],
    ["a deal rejected", { did: ["ok reject on p3"] }],
    ["a turn taken away", { endedByLoop: true }],
  ];
  for (const [why, over] of cases) {
    const turn: CompleteTurn = { turn: 7, seats: [seatBrief("Ada", over)] };
    assert.ok(interestOf(turn).length > 0, why);
  }
});

test("a quiet turn of moves, skips and queue orders says nothing", () => {
  const turn: CompleteTurn = {
    turn: 7,
    seats: [seatBrief("Ada", {
      did: [
        "ok UNITOPERATION_MOVE_TO on 196609",
        "ok UNITOPERATION_SKIP_TURN on 131072",
        "ok UNITOPERATION_FORTIFY on 262146",
        'ok QUEUED build on 65536 {"thing":"UNIT_WARRIOR"} (an order - it completes turns later, nothing exists yet)',
      ],
      stats: statsOf(),
    })],
  };
  assert.deepEqual(interestOf(turn, { turn: 6, seats: [seatBrief("Ada", { stats: statsOf() })] }), []);
});

test("the gate speaks on big number moves and holds on small ones", () => {
  const prev: CompleteTurn = { turn: 6, seats: [seatBrief("Ada", { stats: statsOf() })] };
  const speaks: Array<[string, Partial<SeatStats>]> = [
    ["a settlement gained", { settlements: 3 }],
    ["a settlement lost", { settlements: 1 }],
    ["two units lost", { units: 3 }],
    ["an army surge", { units: 8 }],
    ["a science swing", { science: 14 }],
    ["a treasury starting to bleed", { goldPerTurn: -1 }],
    ["victory progress", { legacy: { antiquity_science: { score: 1, target: 10 } } }],
  ];
  for (const [why, over] of speaks) {
    const turn: CompleteTurn = { turn: 7, seats: [seatBrief("Ada", { stats: statsOf(over) })] };
    assert.ok(interestOf(turn, prev).length > 0, why);
  }
  const holds: Array<[string, Partial<SeatStats>]> = [
    ["a small science drift", { science: 12 }],
    ["one unit lost", { units: 4 }],
    ["treasury spend without bleeding", { gold: 60 }],
  ];
  for (const [why, over] of holds) {
    const turn: CompleteTurn = { turn: 7, seats: [seatBrief("Ada", { stats: statsOf(over) })] };
    assert.deepEqual(interestOf(turn, prev), [], why);
  }
});

test("a voided queue order does not count as an event", () => {
  const turn: CompleteTurn = {
    turn: 7,
    seats: [seatBrief("Ada", {
      did: ["ok QUEUED build on 65536 — CORRECTION: the order did NOT take, the queue is still empty"],
    })],
  };
  assert.deepEqual(interestOf(turn), []);
});

test("first contact speaks once, from the seat's player list", () => {
  const world = (relations: string[]) => ({ settlements: [], relations, sightings: [], unitCensus: null });
  const before: CompleteTurn = { turn: 6, seats: [seatBrief("Ada", { world: world(["p8 Villages — Neutral"]) })] };
  const met: CompleteTurn = {
    turn: 7,
    seats: [seatBrief("Ada", { world: world(["p8 Villages — Neutral", "p3 Greece (Cleo) — Neutral"]) })],
  };
  assert.ok(interestOf(met, before).some((r) => r.includes("first contact")), "a new player line is first contact");
  assert.deepEqual(interestOf(before, before), [], "an already-met player is not news");
});

// The heartbeat bounds the silence: at most HEARTBEAT_EVERY - 1 held turns in a row.
test("the heartbeat speaks on the boundary and holds under it", () => {
  const quiet: CompleteTurn = { turn: 9, seats: [seatBrief("Ada", { did: ["ok UNITOPERATION_MOVE_TO on 1"] })] };
  assert.equal(shouldSpeak(quiet, undefined, HEARTBEAT_EVERY - 2).speak, false, "under the boundary: hold");
  const boundary = shouldSpeak(quiet, undefined, HEARTBEAT_EVERY - 1);
  assert.equal(boundary.speak, true, "on the boundary: speak");
  assert.match(boundary.reasons[0]!, /heartbeat/);
});

// ---- the world feed --------------------------------------------------------------------------

function writeDump(runDir: string, seat: string, turn: number, files: Record<string, string>): void {
  const dir = join(runDir, "agents", seat, "turns", `t${String(turn).padStart(4, "0")}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

// The caster once narrated a settler three turns of hammers away. The dump lists what exists;
// handing them to the prompt as authoritative is what stops the guessing.
test("the seat's world reaches the prompt as authoritative lists", () => {
  const runDir = makeRun([begin(4, "Ada"), end(4, "Ada")]);
  writeDump(runDir, "Ada", 4, {
    "settlements.txt":
      "settlement Paris kind=city engine_id=65536 owner=self at=25,24 pop=7 capital=yes building=UNIT_SETTLER\n" +
      "settlement Nantes kind=town engine_id=131073 owner=self at=28,26 pop=2 queue_empty=yes\n",
    "players.txt": "player p8 civ=Villages leader=Villages at_war=yes relationship=Neutral\n",
    "units.txt":
      "unit warrior-1 owner=p2 type=warrior at=26,24 hp=100\n" +
      "unit warrior-2 owner=p2 type=warrior at=25,25 hp=100\n" +
      "unit scout-1 owner=p2 type=scout at=35,34 hp=100\n",
    "delta.md": "# changes\n\nenemy units in sight: 1\n  galley of p8 at 24,23\n\nyour settlements: 2\n",
  });
  const prompt = promptFor(readTurns(runDir)[0]!);
  assert.match(prompt, /Paris \(city, capital, pop 7\) — building UNIT_SETTLER/);
  assert.match(prompt, /Nantes \(town, pop 2\) — build queue empty/);
  assert.match(prompt, /2 warrior, 1 scout/, "the army arrives counted, not as raw dump lines");
  assert.match(prompt, /p8 Villages — AT WAR/);
  assert.match(prompt, /galley of p8/);
  assert.match(prompt, /authoritative/);
});

test("a run without dumps still prompts, with no world section", () => {
  const runDir = makeRun([begin(4, "Ada"), end(4, "Ada")]);
  const prompt = promptFor(readTurns(runDir)[0]!);
  assert.doesNotMatch(prompt, /authoritative/);
});

// The engine sometimes reports ok and then emits a correction: the order never took. The caster
// narrated a library and a brickyard that were never queued (turn 30 of run 65661dbf8382-016).
test("an engine correction voids the queue order it follows", () => {
  const runDir = makeRun([
    begin(30, "Cleo"),
    action(30, "Cleo", { kind: "choose", actionType: "build", targetId: "65536", args: { thing: "BUILDING_LIBRARY" } }),
    { turn: 30, player: 0, playerName: "Cleo", kind: "action_correction", code: "NOT_QUEUED", message: "BUILDING_LIBRARY — queue still empty" },
    action(30, "Cleo", { kind: "choose", actionType: "build", targetId: "65536", args: { thing: "UNIT_SETTLER" } }),
    end(30, "Cleo"),
  ]);
  const did = readTurns(runDir)[0]!.seats[0]!.did;
  assert.match(did[0]!, /CORRECTION: the order did NOT take/);
  assert.doesNotMatch(did[1]!, /CORRECTION/, "the order that really queued keeps its clean line");
});

// The narrator read grid numbers aloud ("moved to 50,13") because the action lines carried raw
// coordinate args and numeric ids. A viewer has no map grid, so those must not reach the caster;
// a build's type (the useful arg) must survive. Direction, when given, is cardinal — a voice rule.
test("coordinate args and numeric ids are stripped from the caster prompt, build type kept", () => {
  const runDir = makeRun([
    begin(6, "Ada"),
    action(6, "Ada", { actionType: "UNITOPERATION_MOVE_TO", targetId: "131072", args: { X: 50, Y: 13 } }),
    action(6, "Ada", { kind: "build", actionType: "CITYOPERATION_BUILD", targetId: "65536", args: { thing: "UNIT_SCOUT" } }),
    end(6, "Ada"),
  ]);
  const prompt = promptFor(readTurns(runDir)[0]!);
  assert.doesNotMatch(prompt, /"[XY]":/, "no coordinate blobs");
  assert.doesNotMatch(prompt, /\bon \d+/, "no numeric target ids");
  assert.match(prompt, /UNIT_SCOUT/, "the build type is a meaningful arg and stays");
});

// The narrator called powers by their raw id ("p11", "player 2") because the agents' journals and
// the log refer to them that way and nothing translated. A legend (seats from the event log,
// city-states from the players dump) turns those codes into names before the caster sees them.
test("a legend rewrites player-id codes to names in the prompt", () => {
  const runDir = makeRun([begin(9, "Ada"), end(9, "Ada")]);
  writeNotes(runDir, "Ada", ["- t9: declared war on p11 and warned p2 to stay out of it"]);
  const turn = readTurns(runDir)[0]!;
  const legend = new Map<number, string>([
    [0, "Ada"],
    [2, "Cleo"],
    [11, "Carthage"],
  ]);
  const prompt = promptFor(turn, [], [], legend);
  assert.match(prompt, /Carthage/, "the city-state id becomes its name");
  assert.match(prompt, /Cleo/, "the seat id becomes its name");
  assert.doesNotMatch(prompt, /\bp(?:11|2)\b/i, "no raw player-id codes survive");
});

// The did-lines are filtered before the caster sees them, but the agents' JOURNAL and REASONING
// reached the prompt raw — and agents journal plumbing ("granary order was rejected", open with
// "the ILLEGAL_ACTION means..."). The model sanitised it by luck. Scrub notes+reasoning too, clause
// by clause, so the game-world part survives and only the plumbing is cut.
test("plumbing in a seat's notes and reasoning never reaches the caster prompt", () => {
  const runDir = makeRun([begin(9, "Ada"), end(9, "Ada")]);
  writeNotes(runDir, "Ada", [
    "- t8: founded second city; granary order was rejected",
    "- t9: monument command inexplicably failed; held the line and built walls",
  ]);
  writeTranscript(
    runDir, "Ada", 9,
    "--- thinking ---\nThe ILLEGAL_ACTION means I should reposition. I will march the horsemen north.\n\n--- ran ---\n$ civ hud\n",
  );
  const turn = readTurns(runDir)[0]!;
  const prompt = promptFor(turn);
  assert.doesNotMatch(prompt, /ILLEGAL_ACTION/, "no engine codes from reasoning");
  assert.doesNotMatch(prompt, /rejected|inexplicably failed|command/i, "no plumbing verbs from notes");
  assert.match(prompt, /founded second city/, "the game-world half of the note survives");
  assert.match(prompt, /horsemen north/, "the game-world half of the reasoning survives");
});

// ---- live play-by-play between finished turns ----
//
// A turn runs several minutes and the per-turn segment left all of it as dead air. The live line
// reads the seat mid-turn: what it did since the caster's last look, its latest reasoning, and its
// mistakes glossed for a viewer — never the console.
test("the in-progress turn is the last begin without an end that took", () => {
  const runDir = makeRun([
    begin(1, "Ada"), end(1, "Ada"), begin(1, "Bruno"),
    { turn: 1, player: 1, playerName: "Bruno", kind: "turn_end", ok: false, code: "CANNOT_END_TURN" },
  ]);
  assert.deepEqual(inProgressTurn(runDir)?.seat, "Bruno", "a refused end-turn does not close it");
  const done = makeRun([begin(1, "Ada"), end(1, "Ada")]);
  assert.equal(inProgressTurn(done), null);
});

test("a live snapshot carries new moves, glossed mistakes with repeats, and the latest reasoning", () => {
  const runDir = makeRun([
    begin(3, "Ada"),
    action(3, "Ada", { kind: "unit_operation", targetId: "10", actionType: "UNITOPERATION_MOVE_TO", args: { X: 2, Y: 1 } }),
    action(3, "Ada", { kind: "unit_operation", targetId: "10", actionType: "UNITOPERATION_MOVE_TO", args: { X: 7, Y: 7 } }, false, { code: "NO_PATH" }),
    action(3, "Ada", { kind: "unit_operation", targetId: "10", actionType: "UNITOPERATION_MOVE_TO", args: { X: 7, Y: 8 } }, false, { code: "NO_PATH" }),
    { turn: 3, player: 0, playerName: "Ada", kind: "turn_end", ok: false, code: "CANNOT_END_TURN" },
  ]);
  writeTranscript(runDir, "Ada", 3, "--- thinking ---\nFirst I read the map.\n--- ran ---\n$ cat x\n--- thinking ---\nThe river blocks the scout; I will swing north instead.\n--- ran ---\n$ civ move 10 7,8\n");
  const snap = liveSnapshot(runDir, "Ada", 3);
  assert.equal(snap.did.length, 1, "only the move that took is a did-line");
  assert.match(snap.did[0]!, /^ok UNITOPERATION_MOVE_TO/);
  assert.deepEqual(snap.mistakes, ["ordered a unit somewhere it cannot go (2 times)"], "one refused end-turn is routine, not a mistake");
  assert.match(snap.thinking, /swing north/, "the LATEST reasoning block, not the first");
  assert.ok(snap.lastSeq > 0);
  const again = liveSnapshot(runDir, "Ada", 3, snap.lastSeq);
  assert.equal(again.did.length + again.mistakes.length, 0, "nothing new since the last look");
});

test("a live line is one sentence from the seat's snapshot, with mistakes and reasoning in the prompt", async () => {
  const runDir = makeRun([
    begin(3, "Ada"),
    action(3, "Ada", { kind: "unit_operation", targetId: "10", actionType: "UNITOPERATION_MOVE_TO", args: { X: 7, Y: 7 } }, false, { code: "NO_PATH" }),
  ]);
  writeTranscript(runDir, "Ada", 3, "--- thinking ---\nThe river blocks the scout; swing north.\n--- ran ---\n$ x\n");
  const speak = stub("They just sent a scout at a river, again.");
  const line = await commentateLive(liveSnapshot(runDir, "Ada", 3), speak, newMemory());
  assert.equal(line.seat, "live");
  assert.match(line.text, /scout/);
  const prompt = speak.prompts[0]!;
  assert.match(prompt, /Ada is mid-turn/);
  assert.match(prompt, /ordered a unit somewhere it cannot go/, "the mistake is glossed, not a code");
  assert.doesNotMatch(prompt, /NO_PATH/, "the code never reaches the caster");
  assert.match(prompt, /swing north/);
});

// The live caster called end-of-turn skips blunders and scored twenty of them as twenty
// decisions. They collapse to one housekeeping line, and a refused end-turn only counts as a
// mistake once it has repeated.
test("skips collapse to one housekeeping line and routine refusals are not mistakes", () => {
  const runDir = makeRun([
    begin(5, "Bruno"),
    action(5, "Bruno", { kind: "unit_operation", targetId: "1", actionType: "UNITOPERATION_SKIP_TURN" }),
    action(5, "Bruno", { kind: "unit_operation", targetId: "2", actionType: "UNITOPERATION_SKIP_TURN" }),
    action(5, "Bruno", { kind: "unit_operation", targetId: "3", actionType: "UNITOPERATION_SKIP_TURN" }),
    { turn: 5, player: 1, playerName: "Bruno", kind: "turn_end", ok: false, code: "CANNOT_END_TURN" },
    { turn: 5, player: 1, playerName: "Bruno", kind: "turn_end", ok: false, code: "CANNOT_END_TURN" },
    action(5, "Bruno", { kind: "unit_operation", targetId: "4", actionType: "UNITOPERATION_FORTIFY" }, false, { code: "ILLEGAL_ACTION" }),
  ]);
  const snap = liveSnapshot(runDir, "Bruno", 5);
  assert.deepEqual(snap.did, ["ok put 3 idle units on hold for the turn (routine housekeeping, not a decision)"]);
  assert.deepEqual(snap.mistakes, [], "two refused end-turns and one bare refusal are noise");
});

