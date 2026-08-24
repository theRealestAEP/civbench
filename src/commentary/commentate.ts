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
- Write plain prose. Use no lists, no headings, and no markdown.`;

export function promptFor(brief: TurnBrief): string {
  const did = brief.did.length > 0 ? brief.did.join("\n") : "(nothing — the seat took no actions)";
  const parts = [`Turn ${brief.turn}. Seat: ${brief.seat}.`, "", "Its record this turn:", did];
  if (brief.endedByLoop) {
    parts.push("", "It never ended its own turn. The match loop ended it.");
  }
  if (brief.reasoning) {
    parts.push("", "How it opened its own reasoning:", brief.reasoning);
  }
  return parts.join("\n");
}

/** One seat's line of commentary. */
export type Line = { seat: string; text: string };

export async function commentateTurn(turn: CompleteTurn, speak: Speak): Promise<Line[]> {
  const lines: Line[] = [];
  for (const brief of turn.seats) {
    const text = await speak(VOICE, promptFor(brief));
    // A model that answers in paragraphs still has to render on one line beside the turn.
    lines.push({ seat: brief.seat, text: text.trim().split(/\n+/).join(" ") });
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
