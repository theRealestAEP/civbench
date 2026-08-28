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

const VOICE = `You are the color commentator for CivBench — three AI civilizations fighting over
one world, and you have the best seat in the house.

You are sharp, warm, and funny: dry wit, gentle mockery, a taste for hubris meeting consequence.
One good joke lands harder than three adjectives. Never explain a joke, and never bury the game
under the bit — the play comes first, the humor rides on top.

You get one seat's record of one turn: the actions it took, which of them failed, and the opening
of its own reasoning. Write two or three sentences about that turn.

Rules:
- Name the seat, and be specific.
- Say what the seat is trying to do. Leave the mechanics out: keep coordinates, unit numbers and
  engine action names out of the sentence.
- A seat is a chair at the table, not a person. Call it "they". Tease the play, never the player.
- On a busy turn, generalise. "Bruno spent the turn on infrastructure" beats six build lines.
- On an empty turn, say it is empty — one wry line is a whole answer.
- Use only what the record shows. A caster that invents drama is worse than a caster that says
  nothing happened.
- The record is the seat's CONSOLE: commands, refusals, notification names, error text. That
  plumbing is invisible in the game world. Never mention commands, errors, notifications,
  blockers, retries, automation, skipping, or the harness. Narrate what a spectator of the GAME
  would see: settlements, exploration, armies, growth, diplomacy, the race.
- A failure earns a sentence only when it shows on the map — a lost unit, a repelled attack, a
  war going badly. A refused command is not an event.
- If a turn was all plumbing, it was a quiet turn. Say so in a few words.
- Write plain prose. Use no lists, no headings, and no markdown.

You are also given your own recent lines about this seat. Use them to say what has CHANGED, and to
notice what has not: "they are still the only one who has met nobody" is worth more than another
list of builds. Never repeat an observation you have already made — if the turn is a continuation,
say that it is.

When the seat's journal is given, trust it as the seat's plan in its own words — it beats the
reasoning excerpt. When the seat's numbers are given, use at most one, and only when it earns its
place: "their treasury has doubled" is commentary, "gold 147" is a readout.`;

const STANDINGS_VOICE = `You are the color commentator for CivBench — three AI civilizations
fighting over one world. Every few turns you step back and call the race like a late-night sports
desk: who leads, who is closing, who is about to learn something.

You get every seat's current numbers — treasury, yields, settlements, units, and progress on the
game's own Legacy paths — plus your own recent standings calls. Write two or three sentences on
the state of the game, with the same charm as your play-by-play: dry, warm, one good line beats
three adjectives. Compare seats to each other, not to their own last turn. Use a number only when
it makes the gap vivid. Plain prose, no lists, no markdown, no coordinates or engine names. A
seat is a chair at the table: call it "they".`;

/** How often the caster steps back and calls the race. */
export const STANDINGS_EVERY = 5;

/** The memory key for the standings thread — not a seat, so it can never collide with one. */
const STANDINGS_KEY = "__standings__";

/**
 * How many of a seat's previous lines the commentator sees.
 *
 * Without any, it can only describe one turn at a time, and the plan's own example line — "she is
 * still the only one who has met nobody" — is impossible to write. A sliding window rather than
 * the whole history: the interesting comparison is against the recent past, and an unbounded
 * prompt would grow for 300 turns.
 */
export const MEMORY_TURNS = 4;

/** One seat's numbers as a single readable line, or null when there are none to show. */
function statsLine(stats: TurnBrief["stats"]): string | null {
  if (!stats) return null;
  const legacy = Object.entries(stats.legacy)
    .map(([path, score]) => `${path} ${score}`)
    .join(", ");
  return (
    `gold ${stats.gold ?? "?"}, science ${stats.science ?? "?"}, culture ${stats.culture ?? "?"}, ` +
    `${stats.settlements ?? "?"} settlements, ${stats.units ?? "?"} units` +
    (legacy ? `, legacy: ${legacy}` : ", no legacy progress yet")
  );
}

export function promptFor(brief: TurnBrief, recent: string[] = [], missed: string[] = []): string {
  const did = brief.did.length > 0 ? brief.did.join("\n") : "(nothing — the seat took no actions)";
  const parts = [`Turn ${brief.turn}. Seat: ${brief.seat}.`, "", "Its record this turn:", did];
  if (brief.endedByLoop) {
    parts.push("", "It never ended its own turn. The match loop ended it.");
  }
  const stats = statsLine(brief.stats);
  if (stats) parts.push("", "Where it stands:", stats);
  if (brief.notes) {
    parts.push("", "Its own journal (its plan, in its own words):", brief.notes);
  }
  if (brief.reasoning) {
    parts.push("", "How it opened its own reasoning:", brief.reasoning);
  }
  if (missed.length > 0) {
    parts.push(
      "",
      "You fell behind and skipped some turns. These happened in them — weave any that involve " +
        "this seat into your lines, briefly, as things that already happened:",
      ...missed,
    );
  }
  if (recent.length > 0) {
    parts.push("", `What you said about ${brief.seat} on the last ${recent.length} turns you covered:`, ...recent);
  }
  return parts.join("\n");
}

/** The standings prompt: every seat's numbers side by side, plus the caster's own recent calls. */
export function standingsPromptFor(turn: CompleteTurn, recent: string[] = []): string {
  const parts = [`Turn ${turn.turn}. The seats, side by side:`];
  for (const seat of turn.seats) {
    parts.push(`${seat.seat}: ${statsLine(seat.stats) ?? "(no numbers this turn)"}`);
  }
  if (recent.length > 0) {
    parts.push("", "Your recent standings calls:", ...recent);
  }
  return parts.join("\n");
}

/** One seat's line of commentary. */
export type Line = { seat: string; text: string };

/** A seat's own recent lines, newest last. Held by the caller across turns. */
export type Memory = Map<string, string[]>;

export const newMemory = (): Memory => new Map();

export async function commentateTurn(
  turn: CompleteTurn,
  speak: Speak,
  memory: Memory = newMemory(),
  /** Milestones from turns the follow loop dropped: told once, through the first seat's lines. */
  missed: string[] = [],
): Promise<Line[]> {
  const lines: Line[] = [];
  let carry = missed;
  for (const brief of turn.seats) {
    const recent = memory.get(brief.seat) ?? [];
    const text = await speak(VOICE, promptFor(brief, recent, carry));
    carry = []; // said once; repeating it per seat would narrate the same war three times
    // A model that answers in paragraphs still has to render on one line beside the turn.
    const line = text.trim().split(/\n+/).join(" ");
    lines.push({ seat: brief.seat, text: line });
    // Keep only the window. Dropped turns leave a gap, which is honest: the commentator did not
    // see them either.
    memory.set(brief.seat, [...recent, line].slice(-MEMORY_TURNS));
  }
  // Every few turns, step back and call the race — the per-seat lines never compare seats.
  if (turn.turn % STANDINGS_EVERY === 0 && turn.seats.some((s) => s.stats)) {
    const recent = memory.get(STANDINGS_KEY) ?? [];
    const text = await speak(STANDINGS_VOICE, standingsPromptFor(turn, recent));
    const line = text.trim().split(/\n+/).join(" ");
    lines.push({ seat: "standings", text: line });
    memory.set(STANDINGS_KEY, [...recent, line].slice(-MEMORY_TURNS));
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
