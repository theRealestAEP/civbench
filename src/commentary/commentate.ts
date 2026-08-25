// The commentator (docs/PLAN.md §12.3).
//
// A turn is 20 to 100 seconds of silence, and reading a log is not watching a game. This writes
// two or three sentences per seat per turn, saying what that civ did and what it wants.
//
// It reads. It never writes anything a playing agent can reach: the commentary lives in
// runs/<id>/commentary/, outside every sandbox mount, and no part of the match loop calls it.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompleteTurn, TurnBrief } from "./brief.ts";
import type { Speak } from "./speak.ts";

const VOICE = `You are the commentator for CivBench, where AI agents play the seats in a game of Civilization VII.

You get one seat's record of one turn: the actions it took, which of them failed, and the opening
of its own reasoning. Write two or three sentences about that turn.

Rules:
- Name the seat, and be specific.
- Say what the seat is trying to do. Leave the mechanics out: keep coordinates, unit numbers and
  engine action names out of the sentence.
- A seat is a chair at the table, not a person. Call it "they".
- On a busy turn, generalise. "Bruno spent the turn on infrastructure" beats six build lines.
- On an empty turn, say it is empty. "Cleo skipped." is a whole answer.
- Use only what the record shows. A caster that invents drama is worse than a caster that says
  nothing happened.
- Every line of the record is marked ok or FAILED. Keep each one on the side it is marked.
- Write plain prose. Use no lists, no headings, and no markdown.

You are also given your own recent lines about this seat. Use them to say what has CHANGED, and to
notice what has not: "they are still the only one who has met nobody" is worth more than another
list of builds. Never repeat an observation you have already made — if the turn is a continuation,
say that it is.`;

/**
 * How many of a seat's previous lines the commentator sees.
 *
 * Without any, it can only describe one turn at a time, and the plan's own example line — "she is
 * still the only one who has met nobody" — is impossible to write. A sliding window rather than
 * the whole history: the interesting comparison is against the recent past, and an unbounded
 * prompt would grow for 300 turns.
 */
export const MEMORY_TURNS = 4;

export function promptFor(brief: TurnBrief, recent: string[] = []): string {
  const did = brief.did.length > 0 ? brief.did.join("\n") : "(nothing — the seat took no actions)";
  const parts = [`Turn ${brief.turn}. Seat: ${brief.seat}.`, "", "Its record this turn:", did];
  if (brief.endedByLoop) {
    parts.push("", "It never ended its own turn. The match loop ended it.");
  }
  if (brief.reasoning) {
    parts.push("", "How it opened its own reasoning:", brief.reasoning);
  }
  if (recent.length > 0) {
    parts.push("", `What you said about ${brief.seat} on the last ${recent.length} turns you covered:`, ...recent);
  }
  return parts.join("\n");
}

/** One seat's line of commentary. */
export type Line = { seat: string; text: string };

/** A seat's own recent lines, newest last. Held by the caller across turns. */
export type Memory = Map<string, string[]>;

export const newMemory = (): Memory => new Map();

export async function commentateTurn(turn: CompleteTurn, speak: Speak, memory: Memory = newMemory()): Promise<Line[]> {
  const lines: Line[] = [];
  for (const brief of turn.seats) {
    const recent = memory.get(brief.seat) ?? [];
    const text = await speak(VOICE, promptFor(brief, recent));
    // A model that answers in paragraphs still has to render on one line beside the turn.
    const line = text.trim().split(/\n+/).join(" ");
    lines.push({ seat: brief.seat, text: line });
    // Keep only the window. Dropped turns leave a gap, which is honest: the commentator did not
    // see them either.
    memory.set(brief.seat, [...recent, line].slice(-MEMORY_TURNS));
  }
  return lines;
}

const turnFile = (runDir: string, turn: number) =>
  join(runDir, "commentary", `t${String(turn).padStart(4, "0")}.md`);

export const hasCommentary = (runDir: string, turn: number) => existsSync(turnFile(runDir, turn));

/** Write one turn's commentary, and append it to the running transcript. */
export function writeCommentary(runDir: string, turn: number, lines: Line[]): string {
  const body = `## turn ${turn}\n\n${lines.map((l) => `**${l.seat}** — ${l.text}`).join("\n\n")}\n`;
  mkdirSync(join(runDir, "commentary"), { recursive: true });
  writeFileSync(turnFile(runDir, turn), body);
  appendFileSync(join(runDir, "commentary.md"), `${body}\n`);
  return body;
}
