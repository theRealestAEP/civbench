// The turn HUD (docs/PLAN.md §6.3).
//
// Pushed to the agent unasked at the start of its turn. Small, fixed, and strictly mechanical:
// the same fields in the same order every turn, whether or not they look interesting today.
// Conditional inclusion based on our judgement of importance would be curation returning
// through the side door, so there is none here.
//
// Keep it thin. A rich HUD makes agents stop seeking, which flattens the information-seeking
// signal (§6.5) and hides the differences between models.
import type { HeaderSnapshot, PendingSnapshot } from "./types.ts";

export type HudCounts = { tilesChanged: number; unitsChanged: number; settlementsChanged: number };

/**
 * What this match is, as opposed to what this turn is.
 *
 * A human sees all of it on the setup screen before the first turn. Agents saw none of it: they
 * did not know how many turns the match runs, how many rivals were in it, or that the rivals were
 * other agents. You cannot plan an Age without knowing how long it lasts.
 */
export type MatchFacts = {
  turnLimit: number | null;
  speed: string | null;
  singleAge: boolean;
  /** Rival seats driven by other agents. */
  agentRivals: number;
  /** Rival civs driven by the game's own AI. Must be counted from the loaded game, not assumed:
   *  `filler_ai: none` was silently ignored for a while and every match secretly had three. */
  aiRivals: number;
};

const num = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined ? "?" : Number.isInteger(v) ? String(v) : v.toFixed(digits);

const signed = (v: number | null | undefined): string =>
  v === null || v === undefined ? "?" : `${v >= 0 ? "+" : ""}${num(v)}`;

/**
 * Sections a human has on screen at all times, so pushing them is parity rather than an assist:
 * the unit list, the settlement list, notifications, and their own notes. Anything a human has to
 * click for — tile detail, history, the ruleset, combat odds — stays a pull.
 *
 * Capped, because a large empire would otherwise crowd out the agent's own reasoning. Past the
 * cap the push summarises and points at the file, which is the same bargain as before.
 */
export type HudExtras = {
  pendingText?: string;
  unitsText?: string;
  settlementsText?: string;
  messagesText?: string;
  notesText?: string;
  deltaText?: string;
};

const MAX_SECTION_LINES = 40;

function section(title: string, body: string | undefined, file: string): string[] {
  const text = (body ?? "").trim();
  if (!text || text === "(no messages)") return [];
  const lines = text.split("\n");
  if (lines.length <= MAX_SECTION_LINES) return ["", `## ${title}`, ...lines];
  return [
    "",
    `## ${title} (${lines.length} lines, showing ${MAX_SECTION_LINES} — all of it in ${file})`,
    ...lines.slice(0, MAX_SECTION_LINES),
  ];
}

export function renderHud(
  header: HeaderSnapshot,
  pending: PendingSnapshot,
  counts: HudCounts,
  messageCount = 0,
  extras: HudExtras = {},
  match?: MatchFacts,
): string {
  const ap = header.ageProgress;
  const ageBit =
    ap && ap.current !== null && ap.max !== null
      ? `age=${header.age} progress=${num(ap.current, 0)}/${num(ap.max, 0)}${ap.canTransition ? " TRANSITION_READY" : ""}`
      : `age=${header.age}`;

  const y = header.yields;
  // Scores with the number they are measured against. "military 3" alone hid the target from an
  // agent whose whole instruction is to win the Age.
  const legacy =
    header.legacy.length > 0
      ? header.legacy
          .map((l) => {
            const name = l.type.replace(/^LEGACY_PATH_/, "").toLowerCase();
            return `${name} ${num(l.score, 0)}${l.target ? `/${num(l.target, 0)}` : ""}`;
          })
          .join("  ")
      : "none";
  // A human has both of these permanently on screen. Without them an agent spent a command every
  // turn asking what it was already researching.
  const studying = [
    header.researching ? `researching ${header.researching.node}` : null,
    header.adopting ? `civic ${header.adopting.node}` : null,
  ].filter(Boolean).join("  ");

  const s = header.settlements;
  // The harness turn limit, not Game.maxTurns: the engine reports no limit for these matches, so
  // the number that actually ends the game is ours.
  const limit = match?.turnLimit ?? header.maxTurns;
  const rivals = match ? match.agentRivals + match.aiRivals : 0;
  const who = match
    ? match.aiRivals === 0
      ? "all played by other agents"
      : `${match.agentRivals} played by other agents, ${match.aiRivals} by the game's own AI`
    : "";
  const matchLine = match
    ? [
        `match: ${match.turnLimit ?? "?"} turns total, ${match.speed ?? "default"} speed, ` +
          `${match.singleAge ? "this Age only" : "all three Ages"}, ` +
          `${rivals} rival${rivals === 1 ? "" : "s"} (${who})`,
      ]
    : [];
  return [
    `turn ${header.turn}${limit ? `/${limit}` : ""}  ${ageBit}`,
    ...matchLine,
    `you: p${header.playerId} ${header.civ ?? "?"} / ${header.leader ?? "?"}`,
    `gold ${num(header.gold, 0)} (${signed(y.gold)})  sci ${signed(y.science)}  cult ${signed(y.culture)}  food ${signed(y.food)}  prod ${signed(y.production)}  happiness ${signed(header.happiness.net)}`,
    `legacy: ${legacy}`,
    ...(studying ? [studying] : []),
    `settlements ${num(s.total, 0)} (${num(s.cities, 0)} cities, ${num(s.towns, 0)} towns, cap ${num(s.cap, 0)})  pop ${num(s.population, 0)}  units ${header.unitCount}`,
    `pending: ${pending.items.length} items${pending.blockingType ? ` (blocking: ${pending.blockingType})` : ""} -> pending.txt`,
    `messages: ${messageCount} new -> messages.txt`,
    `changed: ${counts.tilesChanged} tiles, ${counts.unitsChanged} units, ${counts.settlementsChanged} settlements`,
    ...section("What changed", extras.deltaText, "/current/delta.md"),
    ...section("The game is waiting on you for", extras.pendingText, "/current/pending.txt"),
    ...section("Your settlements", extras.settlementsText, "/current/settlements.txt"),
    ...section("Your units", extras.unitsText, "/current/units.txt"),
    ...section("Messages", extras.messagesText, "/current/messages.txt"),
    ...section("Your notes", extras.notesText, "/notes/notes.md"),
    "",
    "The map is in /current/tiles.txt. Rules are in /run/rules/. Ask `civ what-can` before acting.",
    "",
    // The last line of the push, because it is the one instruction a turn cannot end without.
    "When you are done, run `civ end-turn`. Nothing else finishes your turn.",
  ].join("\n");
}
