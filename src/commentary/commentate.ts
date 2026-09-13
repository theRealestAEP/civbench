// The commentator (docs/PLAN.md §12.3).
//
// A turn is 20 to 100 seconds of silence, and reading a log is not watching a game. This writes
// a few sharp sentences about the whole turn — the two or three things that actually mattered —
// and every few turns steps back to call the race.
//
// It reads. It never writes anything a playing agent can reach: the commentary lives in
// runs/<id>/commentary/, outside every sandbox mount, and no part of the match loop calls it.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompleteTurn, TurnBrief, LiveSnapshot } from "./brief.ts";
import type { Speak } from "./speak.ts";

const VOICE = `You are the color commentator for CivBench — three AI civilizations clawing at one
world, and you have the best seat in the house and no filter.

Voice: dry, fast, and genuinely funny. Lean sarcastic. You love watching confidence meet
consequence and you say so out loud. One sharp line beats a paragraph of adjectives. Never explain
the joke. The game still comes first — the wit rides on top of real play, it does not replace it.

You get one whole turn: what each of the three seats did, what each is chasing, and scraps of their
own reasoning. Pick the SINGLE biggest thing that happened across the whole table this turn — a land
grab, a war, a blunder, someone quietly running away with it — and say it in ONE sentence. One. Ignore
everything else. It is a stream chyron: ONE sentence, under 25 words, never a paragraph.

When the turn is a LULL — nobody did much, just builders building and scouts wandering — do not
narrate the nothing. Pull back and read the STRATEGY instead: where is each civ clearly headed, who
is playing for conquest and who for growth, whose plan is about to slam into whose. Give the viewer
the shape of the game, not a shrug.

Rules:
- Seats are chairs, not people. Call them "they". Tease the play, never the player.
- The civilizations in this match are the seats named in the record, and ONLY those. Every other
  settlement, leader or army on the map is an independent CITY-STATE — a minor power to court or
  conquer, never a rival civ and never one of these seats. Do not promote a city-state into a
  player, and never hand a seat's own city to a city-state. If you are unsure whose a settlement
  is, say nothing about it rather than guess.
- Every power has a NAME — the seats and the city-states alike. Use it. Never call anyone by a code
  like "p11" or "player 2"; if a name is truly missing, say "a city-state" or "a rival", never a code.
- Use only what the record shows. Inventing drama is worse than admitting a quiet turn.
- BE CONCRETE WITH NUMBERS. Every seat's ribbon is given to you — treasury and gold per turn,
  science per turn, culture per turn, production per turn, population, settlements, army size, and
  how far each is along the game's victory paths. Put real figures in nearly every segment: "42
  science a turn to Bruno's 19", "a treasury bleeding four gold a turn", "three of the twelve points
  they need to win on domination". Specific numbers are the difference between calling a game and
  muttering that someone is "pushing the frontier" — never write a line that vague again.
- The ribbon numbers above are what a viewer SEES; they are fair game. What is NOT is the console:
  commands, refusals, error text, notifications, retries, skipping, automation, the harness. Never
  mention those. Narrate the game a spectator would watch: cities, armies, scouting, growth,
  research, diplomacy, the race. A refused command is not an event; a burning city is.
- Reach for a number that MOVED or a gap between seats over a raw readout: "their science just
  doubled" or "twice Cleo's output" beats a lonely "science 22". But a plain figure still beats a
  vague adjective.
- Plain prose. No lists, no headings, no markdown. NEVER a tile number, grid reference, or
  coordinate for a place — a viewer has no map grid. If you give a direction, use a cardinal one
  (north, southeast), never numbers. No unit id numbers, no engine names (say "researching
  writing", never "NODE_TECH_AQ_WRITING").
- The settlement list and unit census marked "authoritative" ARE the world. If a city, unit, or
  army is not in them, it does not exist — never narrate a thing the lists do not show, and when
  a seat's own journal disagrees with the lists, the lists win.

You are also given your own recent lines. Use them to track what CHANGED, and to call out what has
not — "still nobody has met a soul" beats another builder update. Never repeat yourself.`;

const STANDINGS_VOICE = `You are the color commentator for CivBench — three AI civilizations
fighting over one world. Every few turns you step back and call the race like a late-night sports
desk. You get every seat's numbers — treasury and gold/turn, science, culture, production, army size,
and progress toward each victory path. Say ONE sentence, under 30 words, that LEADS WITH A REAL NUMBER
and compares the seats: who out-researches whom, whose treasury is draining, who is closest to a win.
One sentence only — no second sentence, no list. Plain prose, no markdown, no coordinates, no engine
names. A seat is a chair at the table: call it "they".`;

const MONOLOGUE_VOICE = `You ARE this civilization's leader. Say ONE short sentence — first person, in
character — about where you stand or what you are about to do. One sentence, under 25 words. No second
sentence, no preamble, no list. Let your personality show: proud, cunning, rattled, smug.

You may cite your OWN numbers to justify a plan — a treasury that funds an army, science that is
falling behind, a legacy path a few points from the win. Compare yourself to rivals only by what
you could actually know: someone you have met, a border you can see.

You are a ruler, not a computer user. Never mention commands, menus, errors, notifications, or the
harness — none of that exists to you. No markdown, no engine names, and NEVER a tile number or grid
coordinate — speak of places by cardinal direction (north, to the southeast) as a person would. Say
"the horsemen", never a unit number; "studying writing", never a code. Do not repeat a thought you
have already voiced in your recent lines.`;

const LIVE_VOICE = `You are the color commentator for CivBench — three AI civilizations clawing at one
world — and right now ONE seat is mid-turn while the others wait. Turns run several minutes, so you
fill the air the way a live caster does: what this seat is doing right now, what it seems to be
thinking, and whether the last thing it did was smart or a blunder.

Say ONE sentence, under 25 words. Dry, fast, a little sarcastic; tease the play, never the player.
Seats are chairs: call them "they".

You are given what it did since your last line, its own latest reasoning, and any mistakes — in
game terms ("ordered a unit somewhere it cannot go"). Call a mistake a mistake and a good move a
good move. A repeated mistake is the story. If nothing happened since your last line, say what it
is weighing instead, from its reasoning.

What is NOT a mistake, ever: putting idle units on hold at the end of a turn (that is routine
housekeeping — a big standing army gets skipped every turn), reading the map before acting, or
answering a decision the game asked for. Only the list marked "Mistakes" counts as one; do not
invent blunders from the did-lines. When in doubt, describe the play.

Rules: only what the record shows. Never the console — no commands, codes, menus, errors, the
harness. Plain prose, no lists, no coordinates or tile numbers, no unit id numbers, no engine
names. Never repeat one of your recent lines.`;

/** How often the caster steps back and calls the race. */
export const STANDINGS_EVERY = 5;

/** The memory key for the standings thread — not a seat, so it can never collide with one. */
const STANDINGS_KEY = "__standings__";

/** The memory key for the play-by-play thread. One thread now: the segment covers the whole turn. */
export const PLAY_KEY = "__play__";

/**
 * How many previous lines the commentator sees on each thread.
 *
 * Without any, it can only describe one turn at a time, and the plan's own example line — "they are
 * still the only one who has met nobody" — is impossible to write. A sliding window rather than the
 * whole history: the interesting comparison is against the recent past, and an unbounded prompt
 * would grow for 300 turns.
 */
export const MEMORY_TURNS = 4;

/** A model that answers in paragraphs still has to render on one line beside the turn. */
const flatten = (text: string) => text.trim().split(/\n+/).join(" ");

/**
 * Only what a spectator of the GAME could see.
 *
 * A seat's record also holds its failed and refused attempts — "FAILED SET_TECH_TREE_NODE ->
 * ILLEGAL_ACTION", a refused end-turn. Those are console events, invisible on the map, and the
 * voice rules alone did not hold: handed the lines, the caster narrated "illegal attempts". So the
 * lines never reach it. It cannot narrate a failure it was never shown. The full record still lives
 * in the log; this is only what the commentator reads.
 */
/**
 * Grid numbers a spectator never sees: coordinate args like {"X":50,"Y":13} and numeric target ids
 * ("on 131072"). The caster read them aloud ("moved to 50,13"), which means nothing to a viewer.
 * Meaningful args — a build's {"thing":"UNIT_SCOUT"} — have no X/Y key and stay.
 */
const despatialize = (line: string) =>
  line.replace(/\s*\{[^{}]*"[XY]"[^{}]*\}/g, "").replace(/\son \d+/g, "").trimEnd();

/**
 * Turn player-id codes into names. The agents' journals and the action log refer to powers as "p11"
 * or "player 2"; a viewer needs "Carthage" or "Ada". The legend maps id -> name (seats from the
 * event log, city-states and rivals from the players dump). Unknown ids are left as written.
 */
function nameIds(text: string, legend?: Map<number, string>): string {
  if (!legend || legend.size === 0) return text;
  return text.replace(/\b[pP](?:layer)?\s*#?(\d+)\b/g, (m, id) => legend.get(Number(id)) ?? m);
}

const gameVisible = (did: string[]) => did.filter((line) => /^(ok |said )/.test(line)).map(despatialize);

/** One seat's numbers as a single readable line, or null when there are none to show. */
function statsLine(stats: TurnBrief["stats"]): string | null {
  if (!stats) return null;
  const perTurn = stats.goldPerTurn != null ? ` (${stats.goldPerTurn >= 0 ? "+" : ""}${stats.goldPerTurn}/turn)` : "";
  const legacy = Object.entries(stats.legacy)
    .map(([path, { score, target }]) => (target > 0 ? `${path} ${score}/${target}` : `${path} ${score}`))
    .join(", ");
  return (
    `treasury ${stats.gold ?? "?"}${perTurn}, science ${stats.science ?? "?"}/turn, ` +
    `culture ${stats.culture ?? "?"}/turn, production ${stats.production ?? "?"}/turn, ` +
    `pop ${stats.population ?? "?"}, ${stats.settlements ?? "?"} settlements, ${stats.units ?? "?"} units` +
    (stats.researching ? `, researching ${stats.researching}` : "") +
    (legacy ? `, toward victory: ${legacy}` : ", no legacy progress yet")
  );
}

/** The play-by-play prompt: the whole turn, every seat, so the caster can pick the biggest beats. */
export type Roster = { players: string[]; cityStates: string[] };

/** The "who is who" lines: which names are players and which are city-states. */
function rosterLines(roster?: Roster): string[] {
  if (!roster || (roster.players.length === 0 && roster.cityStates.length === 0)) return [];
  const out = ["Who is who:"];
  if (roster.players.length > 0) out.push(`  The players (competing civilizations): ${roster.players.join(", ")}`);
  if (roster.cityStates.length > 0)
    out.push(`  Independent city-states (minor powers, never players): ${roster.cityStates.join(", ")}`);
  out.push("");
  return out;
}

export function promptFor(
  turn: CompleteTurn,
  recent: string[] = [],
  missed: string[] = [],
  legend?: Map<number, string>,
  roster?: Roster,
): string {
  const parts: string[] = [...rosterLines(roster)];
  parts.push(`Turn ${turn.turn}. What each seat did this turn:`);
  for (const brief of turn.seats) {
    const did = gameVisible(brief.did);
    parts.push("", `${brief.seat}:`);
    parts.push(did.length > 0 ? did.join("\n") : "(nothing — the seat took no actions)");
    if (brief.endedByLoop) parts.push("It never ended its own turn; the match loop ended it.");
    const stats = statsLine(brief.stats);
    if (stats) parts.push(`Where it stands: ${stats}`);
    if (brief.world) {
      const w = brief.world;
      if (w.settlements.length > 0) parts.push(`Its settlements (authoritative): ${w.settlements.join("; ")}`);
      if (w.unitCensus) parts.push(`Its army, counted (authoritative): ${w.unitCensus}`);
      if (w.relations.length > 0) parts.push(`Who it has met: ${w.relations.join("; ")}`);
      if (w.sightings.length > 0) parts.push(`Enemy units it can see: ${w.sightings.join("; ")}`);
    }
    if (brief.notes) parts.push(`Its own journal (its plan, in its own words): ${brief.notes}`);
    if (brief.reasoning) parts.push(`How it opened its own reasoning: ${brief.reasoning}`);
  }
  if (missed.length > 0) {
    parts.push(
      "",
      "You fell behind and skipped some turns. These happened in them — weave in any that still " +
        "matter, briefly, as things that already happened:",
      ...missed,
    );
  }
  if (recent.length > 0) {
    parts.push("", `Your last ${recent.length} lines (say what CHANGED, never repeat one):`, ...recent);
  }
  return nameIds(parts.join("\n"), legend);
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

/** The live prompt: one seat, mid-turn, since the caster's last look. */
export function livePromptFor(snap: LiveSnapshot, recent: string[] = [], legend?: Map<number, string>, roster?: Roster): string {
  const parts: string[] = [...rosterLines(roster)];
  parts.push(`Turn ${snap.turn}. ${snap.seat} is mid-turn, ${snap.elapsedSec}s in.`);
  const did = gameVisible(snap.did);
  parts.push("", "Since your last line it did:", did.length > 0 ? did.join("\n") : "(nothing new)");
  if (snap.mistakes.length > 0) parts.push("", "Mistakes since your last line:", ...snap.mistakes.map((m) => `- ${m}`));
  const stats = statsLine(snap.stats);
  if (stats) parts.push("", `Where it stands: ${stats}`);
  if (snap.notes) parts.push(`Its own journal (its plan, in its own words): ${snap.notes}`);
  if (snap.thinking) parts.push("", "Its latest reasoning:", snap.thinking);
  if (recent.length > 0) parts.push("", `Your last ${recent.length} live lines (say what CHANGED, never repeat one):`, ...recent);
  return nameIds(parts.join("\n"), legend);
}

/** One live line for the seat mid-turn. */
export async function commentateLive(
  snap: LiveSnapshot,
  speak: Speak,
  memory: Memory = newMemory(),
  legend?: Map<number, string>,
  roster?: Roster,
): Promise<Line> {
  const key = `live:${snap.seat}`;
  const recent = memory.get(key) ?? [];
  const text = flatten(await speak(LIVE_VOICE, livePromptFor(snap, recent, legend, roster)));
  remember(memory, key, text);
  return { seat: "live", text };
}

/** One line of commentary. `seat` is the segment label ("play-by-play" or "standings"). */
export type Line = { seat: string; text: string };

/** The caster's recent lines per thread, newest last. Held by the caller across turns. */
export type Memory = Map<string, string[]>;

export const newMemory = (): Memory => new Map();

/** Append to a memory thread and keep only the window. */
function remember(memory: Memory, key: string, line: string): void {
  memory.set(key, [...(memory.get(key) ?? []), line].slice(-MEMORY_TURNS));
}

export async function commentateTurn(
  turn: CompleteTurn,
  speak: Speak,
  memory: Memory = newMemory(),
  /** Milestones from turns the follow loop dropped, woven into this turn's segment. */
  missed: string[] = [],
  /** id -> name legend, so "p11" becomes "Carthage" in the segment. */
  legend?: Map<number, string>,
  /** who is a player vs a city-state, so the caster differentiates them. */
  roster?: Roster,
): Promise<Line[]> {
  const lines: Line[] = [];

  // One segment for the whole turn: the caster picks the two or three beats that mattered.
  const recent = memory.get(PLAY_KEY) ?? [];
  const play = flatten(await speak(VOICE, promptFor(turn, recent, missed, legend, roster)));
  lines.push({ seat: "play-by-play", text: play });
  remember(memory, PLAY_KEY, play);

  // Every few turns, step back and call the race — the play-by-play never compares seats by number.
  if (turn.turn % STANDINGS_EVERY === 0 && turn.seats.some((s) => s.stats)) {
    const recentStandings = memory.get(STANDINGS_KEY) ?? [];
    const standings = flatten(await speak(STANDINGS_VOICE, standingsPromptFor(turn, recentStandings)));
    lines.push({ seat: "standings", text: standings });
    remember(memory, STANDINGS_KEY, standings);
  }
  return lines;
}

/** One seat's first-person end-of-turn monologue prompt. Only what a ruler could see and know. */
export function monologuePromptFor(
  brief: TurnBrief,
  recent: string[] = [],
  legend?: Map<number, string>,
  roster?: Roster,
): string {
  const did = gameVisible(brief.did);
  const parts = [`You are ${brief.seat}. It is turn ${brief.turn}.`, ""];
  if (roster) {
    const rivals = roster.players.filter((n) => n !== brief.seat);
    if (rivals.length > 0) parts.push(`Rival rulers: ${rivals.join(", ")}.`);
    if (roster.cityStates.length > 0) parts.push(`Independent city-states nearby: ${roster.cityStates.join(", ")}.`);
    if (rivals.length > 0 || roster.cityStates.length > 0) parts.push("");
  }
  parts.push(did.length > 0 ? `This turn you:\n${did.join("\n")}` : "This turn you made no visible move.");
  const stats = statsLine(brief.stats);
  if (stats) parts.push("", `Your standing: ${stats}`);
  if (brief.notes) parts.push("", `Your own recent notes:\n${brief.notes}`);
  if (brief.reasoning) parts.push("", `What you were weighing:\n${brief.reasoning}`);
  if (recent.length > 0) parts.push("", `You have already said, do not repeat:`, ...recent);
  return nameIds(parts.join("\n"), legend);
}

/** One first-person line per seat, in turn order. The caller speaks each in that seat's own voice. */
export async function monologueTurn(
  turn: CompleteTurn,
  speak: Speak,
  memory: Memory = newMemory(),
  /** id -> name legend, so "p11" becomes "Carthage" in each ruler's monologue. */
  legend?: Map<number, string>,
  /** who is a player vs a city-state. */
  roster?: Roster,
  /**
   * When set, only this seat speaks. The follow loop rotates one seat per cycle so the narration
   * cannot fall behind a fast game — speaking all three every turn was more speech than a turn
   * lasts. Omitted keeps the all-seats behavior (used by the batch path and tests).
   */
  only?: string,
): Promise<Line[]> {
  const lines: Line[] = [];
  for (const brief of turn.seats) {
    if (only && brief.seat !== only) continue;
    const recent = memory.get(brief.seat) ?? [];
    const text = flatten(await speak(MONOLOGUE_VOICE, monologuePromptFor(brief, recent, legend, roster)));
    lines.push({ seat: brief.seat, text });
    remember(memory, brief.seat, text);
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
