// The commentator (docs/PLAN.md §12.3).
//
// The model call is injected, so nothing here reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTurns } from "../src/commentary/brief.ts";
import {
  commentateTurn, hasCommentary, promptFor, writeCommentary,
} from "../src/commentary/commentate.ts";
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

test("a failed action is kept, with the reason the game gave", () => {
  const runDir = makeRun([
    begin(1, "Ada"),
    action(1, "Ada", { actionType: "SET_TECH_TREE_NODE" }, false, { code: "ILLEGAL_ACTION", message: "the game refused this action" }),
    end(1, "Ada"),
  ]);
  const line = readTurns(runDir)[0]!.seats[0]!.did[0]!;
  assert.match(line, /^FAILED SET_TECH_TREE_NODE/);
  assert.match(line, /ILLEGAL_ACTION/);
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
