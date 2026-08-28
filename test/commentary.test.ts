// The commentator (docs/PLAN.md §12.3).
//
// The model call is injected, so nothing here reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTurns } from "../src/commentary/brief.ts";
import type { CompleteTurn } from "../src/commentary/brief.ts";
import {
  commentateTurn, hasCommentary, promptFor, writeCommentary, newMemory, MEMORY_TURNS } from "../src/commentary/commentate.ts";
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
  const brief = readTurns(runDir)[0]!.seats[0]!;
  assert.equal(brief.endedByLoop, true);
  assert.match(promptFor(brief), /never ended its own turn/);
});

test("an empty turn reads as empty rather than as nothing at all", () => {
  const runDir = makeRun([begin(3, "Cleo"), end(3, "Cleo")]);
  const brief = readTurns(runDir)[0]!.seats[0]!;
  assert.deepEqual(brief.did, []);
  assert.match(promptFor(brief), /took no actions/);
});

// The opening states the plan. Everything after it is dump reading, and it is enormous.
test("only the opening of the seat's own reasoning is carried", () => {
  const runDir = makeRun([begin(1, "Ada"), end(1, "Ada")]);
  writeTranscript(
    runDir, "Ada", 1,
    "--- thinking ---\nI will found on the river.\n\n--- ran ---\n$ civ near 10 3\n" +
      "tile 1,1 terrain=flat\n".repeat(500) + "\n--- thinking ---\nSecond thoughts.\n",
  );
  const brief = readTurns(runDir)[0]!.seats[0]!;
  assert.equal(brief.reasoning, "I will found on the river.");
  assert.match(promptFor(brief), /found on the river/);
});

test("a seat that wrote no reasoning still gets a brief", () => {
  const runDir = makeRun([begin(1, "Ada"), end(1, "Ada")]);
  const brief = readTurns(runDir)[0]!.seats[0]!;
  assert.equal(brief.reasoning, "");
  assert.doesNotMatch(promptFor(brief), /reasoning/);
});

test("each seat in a turn gets its own call and its own line", async () => {
  const runDir = makeRun([
    begin(1, "Ada"), end(1, "Ada"),
    begin(1, "Bruno"), end(1, "Bruno"),
  ]);
  const speak = stub();
  const lines = await commentateTurn(readTurns(runDir)[0]!, speak);
  assert.equal(speak.prompts.length, 2, "one call per seat");
  assert.deepEqual(lines.map((l) => l.seat), ["Ada", "Bruno"]);
  assert.equal(speak.prompts[1]!.includes("Ada"), false, "a seat's brief holds only its own turn");
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
test("the caster is given its own recent lines about that seat", async () => {
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
  assert.doesNotMatch(prompts[0]!, /What you said about/, "the first turn has no past to compare to");

  await commentateTurn(turn(2), speak, memory);
  assert.match(prompts[1]!, /What you said about Ada/);
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
  assert.equal(memory.get("Ada")!.length, MEMORY_TURNS, "the window must stay bounded");
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
  const brief = readTurns(runDir)[0]!.seats[0]!;
  const prompt = promptFor(brief);
  assert.match(prompt, /Where it stands/);
  assert.match(prompt, /gold 147/);
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
  const brief = readTurns(runDir)[0]!.seats[0]!;
  const prompt = promptFor(brief);
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
  assert.deepEqual(offCadence.map((l) => l.seat), ["Ada", "Bruno"], "turn 4 is not a standings turn");

  const onCadence = await commentateTurn(seatsFor(5, true), speak);
  assert.deepEqual(onCadence.map((l) => l.seat), ["Ada", "Bruno", "standings"]);
  const standingsPrompt = speak.prompts.at(-1)!;
  assert.match(standingsPrompt, /Ada:.*gold 100/, "the standings call must see every seat side by side");
  assert.match(standingsPrompt, /Bruno:.*gold 40/);

  const noNumbers = await commentateTurn(seatsFor(10, false), speak);
  assert.deepEqual(noNumbers.map((l) => l.seat), ["Ada", "Bruno"], "no numbers, no standings call");
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
  assert.match(speak.prompts[0]!, /DECLARE_WAR/, "the first seat's prompt carries the missed beats");
  assert.doesNotMatch(speak.prompts[1]!, /DECLARE_WAR/, "told once, not once per seat");
});
