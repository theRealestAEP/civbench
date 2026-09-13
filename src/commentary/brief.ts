// One seat's slice of one turn, read off disk (docs/PLAN.md §12.3).
//
// The commentator reads only what is already written: events.jsonl and the agents' own
// transcripts. It holds no seat and it takes no action. Nothing built here ever reaches a
// playing agent — that would make the caster a covert channel between them and invalidate
// every result the benchmark produces.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// The same records the match server writes. It used to be re-declared here as
// `Record<string, any>`, so the writer and this reader could disagree about a field's shape and
// nothing would say so.
import type { Event } from "../server/events.ts";

/** The numbers a viewer reads off the ribbon: where this seat stands. From header.json. */
export type SeatStats = {
  age: string | number | null;
  /** Treasury, and the per-turn figures a viewer watches climb. */
  gold: number | null;
  goldPerTurn: number | null;
  science: number | null;
  culture: number | null;
  production: number | null;
  population: number | null;
  settlements: number | null;
  units: number | null;
  /** What the seat is researching now, for the strategy read. */
  researching: string | null;
  /** Legacy-path progress: score toward the target that wins the path. The game's own win meter. */
  legacy: Record<string, { score: number; target: number }>;
};

export type TurnBrief = {
  turn: number;
  seat: string;
  /** One readable line per thing the seat did, in the order it did them. */
  did: string[];
  /** True when the turn loop ended the turn because the seat never did. */
  endedByLoop: boolean;
  /** The opening of the seat's own reasoning, from its transcript. */
  reasoning: string;
  /** Where the seat stands this turn. Optional: a run may predate header.json. */
  stats?: SeatStats | null;
  /** The tail of the seat's own journal — its plan, in its own words across turns. */
  notes?: string;
  /** What the seat's own state dump shows this turn. Optional: a run may predate the dumps. */
  world?: SeatWorld | null;
};

/**
 * The ground truth a spectator overlay would show for one seat: its settlements, its army, who
 * it has met, and what enemies it can see. Read from the seat's own per-turn dump files. Without
 * this the caster knows only counts, and it guesses at everything the counts stand for.
 */
export type SeatWorld = {
  /** One line per settlement: name, kind, pop, what it is building. Authoritative. */
  settlements: string[];
  /** One line per player the seat has met, with its war state. */
  relations: string[];
  /** Enemy units in sight this turn, from the seat's delta. */
  sightings: string[];
  /** The seat's army counted by type, e.g. "4 warrior, 1 scout, 1 galley". Authoritative. */
  unitCensus: string | null;
};

/** One game turn, once every seat that began it has ended it. */
export type CompleteTurn = { turn: number; seats: TurnBrief[] };


/** How much of the seat's reasoning to carry. The opening states the plan; the rest is grep output. */
const REASONING_CHARS = 1200;

/** An event as the log wrote it: the server's record plus its sequence number and timestamp. */
type LoggedEvent = Event & { seq?: number; at?: string };

function readEvents(runDir: string): LoggedEvent[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  // SAFETY: this file is written by the match server in this same run, one Event per line.
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoggedEvent);
}

/**
 * Render one event the way a caster needs to read it.
 *
 * The per-agent log has a similar renderer, but it drops `args` — and `args.thing` is the whole
 * point of a build event. "CITYOPERATION_BUILD on 65536" says nothing about what the city is
 * making, so the commentary would describe mechanics it cannot see.
 */
function describe(event: Event): string | null {
  const req = event.request ?? {};
  const res = event.result ?? {};
  const args = req.args && Object.keys(req.args).length > 0 ? ` ${JSON.stringify(req.args)}` : "";
  const what = `${req.actionType ?? "?"}${req.targetId ? ` on ${req.targetId}` : ""}${args}`;
  switch (event.kind) {
    // ok and FAILED are deliberately parallel. A first draft wrote "did X" against "FAILED X",
    // and the caster moved a successful build into the failure column of its sentence.
    //
    // The failure MESSAGE stays out. It is harness error text, and carrying it gave the caster
    // gravity toward narrating plumbing — one broadcast described an agent's blocked automation
    // command instead of the game.
    case "action": {
      // Builds and techs are ORDERS, not outcomes. The raw line "ok build
      // UNIT_SETTLER" read to the caster as a settler existing, and one
      // broadcast narrated Bruno marching a settler that was still three
      // turns of hammers away. Say what actually happened: a queue entry.
      if (res.ok && (req.actionType === "build" || req.actionType === "tech" || req.actionType === "civic")) {
        return `ok QUEUED ${what} (an order - it completes turns later, nothing exists yet)`;
      }
      return res.ok ? `ok ${what}` : `FAILED ${what} -> ${res.code ?? "?"}`;
    }
    case "action_refused":
      return `REFUSED ${what} -> out of budget`;
    case "message":
      return `said to ${event.to ?? "everyone"}: ${JSON.stringify(event.text)}`;
    default:
      return null;
  }
}

/**
 * Where a seat stands, read from the header its own dump wrote that turn.
 *
 * This is the caster's only source of numbers — gold, yields, legacy progress. Without it the
 * commentary could describe actions but never the race, which is the thing a viewer watches for.
 */
function readStats(runDir: string, seat: string, turn: number): SeatStats | null {
  const path = join(runDir, "agents", seat, "turns", `t${String(turn).padStart(4, "0")}`, "header.json");
  if (!existsSync(path)) return null;
  try {
    // SAFETY: header.json is written by this harness's own snapshot writer, one HeaderSnapshot
    // per turn directory; every field below is read defensively.
    const header = JSON.parse(readFileSync(path, "utf8")) as {
      age?: string | number;
      gold?: number;
      yields?: { science?: number; culture?: number; production?: number; gold?: number };
      settlements?: { total?: number; population?: number };
      unitCount?: number;
      researching?: { node?: string };
      legacy?: Array<{ type: string; score?: number; target?: number }>;
    };
    return {
      age: header.age ?? null,
      gold: header.gold ?? null,
      goldPerTurn: header.yields?.gold ?? null,
      science: header.yields?.science ?? null,
      culture: header.yields?.culture ?? null,
      production: header.yields?.production ?? null,
      population: header.settlements?.population ?? null,
      settlements: header.settlements?.total ?? null,
      units: header.unitCount ?? null,
      researching: header.researching?.node
        ? header.researching.node.replace(/^NODE_(TECH|CIVIC)_[A-Z]+_/, "").replace(/_/g, " ").toLowerCase()
        : null,
      legacy: Object.fromEntries(
        (header.legacy ?? [])
          .filter((l) => (l.score ?? 0) > 0)
          .map((l) => [
            l.type.replace(/^LEGACY_PATH_/, "").replace(/^path_/, "").toLowerCase(),
            { score: l.score ?? 0, target: l.target ?? 0 },
          ]),
      ),
    };
  } catch {
    return null;
  }
}

/** The `key=value` pairs of one dump line. The dumps write one record per line in this shape. */
function kv(line: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const token of line.split(" ")) {
    const eq = token.indexOf("=");
    if (eq > 0) out.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return out;
}

/** One dump file as trimmed non-empty lines, or null when the file is not there. */
function readDumpLines(dir: string, file: string): string[] | null {
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * The seat's view of the world, from the same per-turn dump its own agent reads.
 *
 * settlements.txt and units.txt are the authoritative answer to "what exists" — the caster once
 * narrated a settler three turns of hammers away, and lists beat inference. tiles.* stays out
 * (about 100 KB a seat) and hud.txt stays out (it repeats header.json and delta.md).
 */
function readWorld(runDir: string, seat: string, turn: number): SeatWorld | null {
  const dir = join(runDir, "agents", seat, "turns", `t${String(turn).padStart(4, "0")}`);

  const settlements = (readDumpLines(dir, "settlements.txt") ?? [])
    .filter((l) => l.startsWith("settlement "))
    .map((l) => {
      const f = kv(l);
      const name = l.split(" ")[1] ?? "?";
      const owner = f.get("owner") && f.get("owner") !== "self" ? ` of ${f.get("owner")}` : "";
      const capital = f.get("capital") === "yes" ? ", capital" : "";
      const building = f.get("building") ? `building ${f.get("building")}` : "build queue empty";
      return `${name} (${f.get("kind") ?? "?"}${capital}, pop ${f.get("pop") ?? "?"})${owner} — ${building}`;
    });

  const relations = (readDumpLines(dir, "players.txt") ?? [])
    .filter((l) => l.startsWith("player "))
    .map((l) => {
      const f = kv(l);
      const id = l.split(" ")[1] ?? "?";
      const who = f.get("leader") && f.get("leader") !== f.get("civ") ? `${f.get("civ")} (${f.get("leader")})` : (f.get("civ") ?? "?");
      return `${id} ${who} — ${f.get("at_war") === "yes" ? "AT WAR" : (f.get("relationship") ?? "unmet")}`;
    });

  // The delta's sightings block: the lines indented under "enemy units in sight:".
  const deltaPath = join(dir, "delta.md");
  const sightings: string[] = [];
  if (existsSync(deltaPath)) {
    let inBlock = false;
    for (const raw of readFileSync(deltaPath, "utf8").split("\n")) {
      if (/^enemy units in sight:/.test(raw.trim()) && !raw.trim().endsWith(": 0")) {
        inBlock = true;
        continue;
      }
      if (inBlock) {
        if (/^\s+\S/.test(raw)) sightings.push(raw.trim());
        else inBlock = false;
      }
    }
  }

  const unitLines = readDumpLines(dir, "units.txt");
  let unitCensus: string | null = null;
  if (unitLines) {
    const byType = new Map<string, number>();
    for (const l of unitLines) {
      if (!l.startsWith("unit ")) continue;
      const type = kv(l).get("type") ?? "?";
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    unitCensus = [...byType].map(([type, n]) => `${n} ${type}`).join(", ") || null;
  }

  if (settlements.length === 0 && relations.length === 0 && sightings.length === 0 && unitCensus === null) return null;
  return { settlements, relations, sightings, unitCensus };
}

/** How many journal lines the caster sees. The tail is the seat's recent plan in its own words. */
const NOTES_LINES = 8;

/**
 * The tail of the seat's own journal. It is where agents distil their strategy — one dated line
 * per turn — and it beats the transcript opening as a strategy source: the first thinking block
 * is often "let me read delta.md", while a note reads "t13: chose Writing; queued settler".
 */
/**
 * Plumbing a spectator must never hear, if it rides in on the seat's own journal or reasoning.
 *
 * The did-lines are already filtered before the caster sees them (commentate.ts gameVisible), but
 * `notes` and `reasoning` reached the prompt raw — and agents journal things like "granary order was
 * rejected" or "promotion command errored" and open with "the ILLEGAL_ACTION means...". The model
 * sanitised those by luck; nothing guaranteed it. This scrubs the COPY the caster reads (the raw log
 * is untouched), clause by clause, so game-world text survives and only the plumbing clause is cut.
 */
const PLUMBING =
  /[A-Z]{2,}_[A-Z_]+|\b(errored|rejected|failed to queue|inexplicably failed|rejected by syntax|no valid construction|does not exist in this build|order (failed|was rejected)|command (failed|rejected|exposed|errored)|interface (errored|failed)|engine errored)\b/i;

/** Drop plumbing clauses (split on newline, then on ; and sentence breaks); keep the rest. */
function scrubPlumbing(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[;.])\s+/)
        .filter((clause) => !PLUMBING.test(clause))
        .join(" ")
        .trim(),
    )
    .filter((line) => line && line !== "-")
    .join("\n");
}

function readNotesTail(runDir: string, seat: string): string {
  const path = join(runDir, "notes", seat, "notes.md");
  if (!existsSync(path)) return "";
  const dated = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => /^- t\d+:/.test(line));
  return scrubPlumbing(dated.slice(-NOTES_LINES).join("\n"));
}

/**
 * The lines in a finished turn worth telling even late — war, peace, a settlement founded, a
 * deal answered, words exchanged, a turn taken away. The follow loop drops whole turns when it
 * falls behind; these survive the drop and ride into the next prompt, so "while we were away,
 * war broke out" gets said instead of never.
 */
export function milestonesOf(turn: CompleteTurn): string[] {
  const BIG = new RegExp(`${LOUD.source}|^said to|^ok accept|^ok reject`);
  const out: string[] = [];
  for (const seat of turn.seats) {
    for (const line of seat.did) {
      if (line.startsWith("ok") || line.startsWith("said")) {
        if (BIG.test(line)) out.push(`turn ${turn.turn}, ${seat.seat}: ${line}`);
      }
    }
    if (seat.endedByLoop) out.push(`turn ${turn.turn}, ${seat.seat}: never ended its own turn — the loop ended it`);
  }
  return out;
}

/** Turns of silence the gate tolerates before a heartbeat segment keeps the broadcast alive. */
export const HEARTBEAT_EVERY = 5;

/** An action line the gate always speaks about: the game visibly changed shape. */
const LOUD = /FOUND_CITY|DECLARE_WAR|MAKE_PEACE|FORM_ALLIANCE|ATTACK|BOMBARD|PILLAGE|RAZE|CAPTURE/;

/** A per-turn yield swing worth a segment: at least 30 percent and at least 3 absolute. */
const swung = (now: number | null | undefined, then: number | null | undefined): boolean =>
  now != null && then != null && Math.abs(now - then) >= 3 && Math.abs(now - then) / Math.max(then, 1) >= 0.3;

/**
 * Why this turn deserves live commentary — empty when it is a quiet one (docs/narrator-review.md).
 *
 * The narrator used to speak on every turn, a metronome of builders building. This is the gate:
 * events that change the shape of the game always speak; number moves speak when they are big;
 * scouts wandering and settlers queuing say nothing. `prev` is the last turn that WAS spoken, so
 * a swing that builds up across quiet turns still fires.
 */
export function interestOf(turn: CompleteTurn, prev?: CompleteTurn): string[] {
  const reasons: string[] = [];
  for (const seat of turn.seats) {
    for (const line of seat.did) {
      if (line.includes("CORRECTION:")) continue; // a voided order changed nothing
      if (line.startsWith("ok ") && LOUD.test(line)) reasons.push(`${seat.seat}: ${line}`);
      if (/^said to/.test(line)) reasons.push(`${seat.seat}: words exchanged`);
      if (/^ok (accept|reject)/.test(line)) reasons.push(`${seat.seat}: a deal answered`);
    }
    if (seat.endedByLoop) reasons.push(`${seat.seat}: had its turn taken away`);

    const before = prev?.seats.find((s) => s.seat === seat.seat);
    const now = seat.stats;
    const then = before?.stats;
    if (now && then) {
      if (now.settlements != null && then.settlements != null && now.settlements !== then.settlements)
        reasons.push(`${seat.seat}: settlements ${then.settlements} -> ${now.settlements}`);
      if (now.units != null && then.units != null && then.units - now.units >= 2)
        reasons.push(`${seat.seat}: lost ${then.units - now.units} units`);
      if (now.units != null && then.units != null && now.units - then.units >= 3)
        reasons.push(`${seat.seat}: army grew by ${now.units - then.units}`);
      for (const [path, { score }] of Object.entries(now.legacy)) {
        if (score !== (then.legacy[path]?.score ?? 0)) reasons.push(`${seat.seat}: victory progress moved on ${path}`);
      }
      if (swung(now.science, then.science)) reasons.push(`${seat.seat}: science ${then.science} -> ${now.science}`);
      if (swung(now.culture, then.culture)) reasons.push(`${seat.seat}: culture ${then.culture} -> ${now.culture}`);
      if (swung(now.production, then.production)) reasons.push(`${seat.seat}: production ${then.production} -> ${now.production}`);
      if (now.goldPerTurn != null && then.goldPerTurn != null && now.goldPerTurn < 0 && then.goldPerTurn >= 0)
        reasons.push(`${seat.seat}: treasury started bleeding`);
    }
    // A new line in the seat's player list is first contact — the classic always-speak moment.
    if (seat.world && before?.world) {
      const known = new Set(before.world.relations.map((r) => r.split(" ")[0]));
      for (const r of seat.world.relations) {
        if (!known.has(r.split(" ")[0])) reasons.push(`${seat.seat}: first contact — ${r}`);
      }
    }
  }
  return reasons;
}

/**
 * The follow loop's whole question: speak on this turn, or hold?
 *
 * `quietStreak` is how many turns in a row have already been held. The heartbeat bounds the
 * silence: at most HEARTBEAT_EVERY - 1 held turns, then a strategy read even on a quiet board —
 * the VOICE prompt's lull mode already knows what to do with one.
 */
export function shouldSpeak(
  turn: CompleteTurn,
  prev: CompleteTurn | undefined,
  quietStreak: number,
) {
  const reasons = interestOf(turn, prev);
  if (reasons.length > 0) return { speak: true, reasons };
  if (quietStreak + 1 >= HEARTBEAT_EVERY) return { speak: true, reasons: ["heartbeat: time for a strategy read"] };
  return { speak: false, reasons: [] };
}

/** The opening of one seat's reasoning for one turn. Empty when the seat wrote none. */
function readReasoning(runDir: string, seat: string, turn: number): string {
  const dir = `t${String(turn).padStart(4, "0")}`;
  const path = join(runDir, "agents", seat, "turns", dir, "transcript.md");
  if (!existsSync(path)) return "";
  // The transcript interleaves reasoning with shell output. Take the first thinking block: it is
  // where the seat states its plan, before the dump reading buries it.
  const block = readFileSync(path, "utf8").split("--- thinking ---")[1] ?? "";
  return scrubPlumbing(block.split("--- ran ---")[0]!.trim()).slice(0, REASONING_CHARS);
}

/** The seat whose turn is open right now: the last turn_begin with no end-turn that took. */
export function inProgressTurn(runDir: string): { seat: string; turn: number; beganAt: string } | null {
  let current: { seat: string; turn: number; beganAt: string } | null = null;
  for (const event of readEvents(runDir)) {
    const seat = event.playerName;
    if (!seat) continue;
    if (event.kind === "turn_begin") current = { seat, turn: event.turn, beganAt: event.at ?? "" };
    else if ((event.kind === "turn_end" || event.kind === "turn_end_forced") && event.ok !== false &&
      current && current.seat === seat && current.turn === event.turn) current = null;
  }
  return current;
}

/** What a viewer would call a failure, in game terms. The code never reaches the caster. */
const MISTAKES: Array<[RegExp, string]> = [
  [/NO_PATH/, "ordered a unit somewhere it cannot go"],
  [/TILE_OCCUPIED/, "marched a unit onto a tile another civilization's unit already holds"],
  [/DID_NOT_MOVE|DEAD_ORDER/, "gave a move order that went nowhere"],
  [/OUT_OF_RANGE/, "tried an attack from out of range"],
  [/NOT_PROMOTED|NOT_AVAILABLE/, "tried to give a commander a promotion it cannot take"],
  [/NOT_QUEUED|NO_PLOT/, "ordered a building with nowhere to put it"],
  [/NOT_BOUGHT/, "tried to buy something the treasury could not cover"],
  [/CANNOT_END_TURN|END_TURN_REFUSED/, "tried to end the turn with a decision still waiting"],
  [/ILLEGAL_ACTION/, "tried something the game refused"],
];

/**
 * How many times a glossed failure must repeat before it counts as a mistake. A refused
 * end-turn is the game asking for one more decision — routine, answered on the next command —
 * and a lone bare refusal is noise; the live caster called both blunders.
 */
const MISTAKE_THRESHOLD = new Map<string, number>(Object.entries({
  "tried to end the turn with a decision still waiting": 3,
  "tried something the game refused": 2,
}));

function glossMistake(code: string): string {
  for (const [re, text] of MISTAKES) if (re.test(code)) return text;
  return "tried something the game refused";
}

/** A seat's turn as it stands right now, for live play-by-play between finished turns. */
export type LiveSnapshot = {
  seat: string;
  turn: number;
  /** Seconds since the seat's turn began. */
  elapsedSec: number;
  /** What it did since the last look, in the brief's did-line form (successes only). */
  did: string[];
  /** Its failures since the last look, glossed for a viewer, repeats counted. */
  mistakes: string[];
  /** Its most recent reasoning, scrubbed, from the streaming transcript. */
  thinking: string;
  stats: SeatStats | null;
  notes: string;
  /** The last event sequence number folded in; pass it back next time. */
  lastSeq: number;
};

/** How much of the latest reasoning the live caster sees. */
const LIVE_THINKING_CHARS = 700;

/** The failure a logged event represents, glossed for a viewer, or null when it is not one. */
function mistakeOf(event: LoggedEvent): string | null {
  if (event.kind === "action" && event.result?.ok === false) return glossMistake(event.result.code ?? "");
  if (event.kind === "action_correction") return glossMistake(String(event.code ?? ""));
  if ((event.kind === "turn_end" || event.kind === "turn_end_forced") && event.ok === false) return glossMistake("CANNOT_END_TURN");
  return null;
}

/** The seat's did-lines and glossed mistakes since `sinceSeq`, with the turn's start and the last seq seen. */
function liveEventsSince(runDir: string, seat: string, turn: number, sinceSeq: number) {
  const did: string[] = [];
  const failures = new Map<string, number>();
  let skipped = 0;
  let lastSeq = sinceSeq;
  let beganAt: string | null = null;
  for (const event of readEvents(runDir)) {
    if (event.playerName !== seat || event.turn !== turn) continue;
    if (event.kind === "turn_begin") beganAt = event.at ?? "";
    const seq = event.seq ?? 0;
    if (seq <= sinceSeq) continue;
    lastSeq = Math.max(lastSeq, seq);
    const mistake = mistakeOf(event);
    if (mistake) {
      failures.set(mistake, (failures.get(mistake) ?? 0) + 1);
      continue;
    }
    // Skips are end-of-turn housekeeping for idle units — one line for all of them, or the
    // caster reads twenty of them as twenty decisions and scores each one.
    if (event.kind === "action" && event.result?.ok && /SKIP_TURN/.test(String(event.request?.actionType))) {
      skipped++;
      continue;
    }
    const line = event.kind === "action" || event.kind === "message" ? describe(event) : null;
    if (line) did.push(line);
  }
  if (skipped > 0) did.push(`ok put ${skipped} idle unit${skipped === 1 ? "" : "s"} on hold for the turn (routine housekeeping, not a decision)`);
  const mistakes = [...failures]
    .filter(([gloss, n]) => n >= (MISTAKE_THRESHOLD.get(gloss) ?? 1))
    .map(([gloss, n]) => (n > 1 ? `${gloss} (${n} times)` : gloss));
  return { did, mistakes, lastSeq, beganAt };
}

/** The tail of the seat's latest reasoning block, scrubbed, from its streaming transcript. */
function latestThinking(runDir: string, seat: string, turn: number): string {
  const dir = `t${String(turn).padStart(4, "0")}`;
  const path = join(runDir, "agents", seat, "turns", dir, "transcript.md");
  if (!existsSync(path)) return "";
  const last = readFileSync(path, "utf8").split("--- thinking ---").at(-1) ?? "";
  return scrubPlumbing(last.split("--- ran ---")[0]!.trim()).slice(-LIVE_THINKING_CHARS);
}

export function liveSnapshot(runDir: string, seat: string, turn: number, sinceSeq = 0): LiveSnapshot {
  const { did, mistakes, lastSeq, beganAt } = liveEventsSince(runDir, seat, turn, sinceSeq);
  const elapsedSec = beganAt ? Math.max(0, Math.round((Date.now() - Date.parse(beganAt)) / 1000)) : 0;
  return {
    seat, turn, elapsedSec, did, mistakes,
    thinking: latestThinking(runDir, seat, turn),
    stats: readStats(runDir, seat, turn),
    notes: readNotesTail(runDir, seat),
    lastSeq,
  };
}

/**
 * Every finished game turn in a run, oldest first.
 *
 * A turn is finished once every seat that began it has ended it. A turn still in progress is
 * left out, so this reads the same on a live run as on a finished one.
 */
export function readTurns(runDir: string): CompleteTurn[] {
  const open = new Map<string, TurnBrief>();
  const turns = new Map<number, TurnBrief[]>();
  const everBegan = new Set<string>();
  let maxBegun = 0;
  let terminal = false;

  for (const event of readEvents(runDir)) {
    if (event.kind === "game_over" || event.kind === "decided") terminal = true;
    const seat = typeof event.playerName === "string" ? event.playerName : null;
    if (!seat) continue;
    const key = `${event.turn}:${seat}`;

    if (event.kind === "turn_begin") {
      open.set(key, { turn: event.turn, seat, did: [], endedByLoop: false, reasoning: "" });
      everBegan.add(seat);
      if (event.turn > maxBegun) maxBegun = event.turn;
      continue;
    }
    const brief = open.get(key);
    if (!brief) continue;

    if (event.kind === "turn_end" || event.kind === "turn_end_forced") {
      // Only an end-turn that TOOK closes the brief. A refused one (ok:false) is mid-turn — the
      // seat keeps acting after it, and closing here dropped everything that followed, including
      // the struggle itself, which is often the most tellable part of the turn.
      if (event.ok === false) {
        brief.did.push(`tried to end its turn, refused: ${event.blocking ?? event.code ?? "no reason"}`);
        continue;
      }
      brief.endedByLoop = event.kind === "turn_end_forced";
      brief.reasoning = readReasoning(runDir, seat, event.turn);
      brief.stats = readStats(runDir, seat, event.turn);
      brief.world = readWorld(runDir, seat, event.turn);
      brief.notes = readNotesTail(runDir, seat);
      open.delete(key);
      if (!turns.has(event.turn)) turns.set(event.turn, []);
      turns.get(event.turn)!.push(brief);
      continue;
    }
    // A correction voids the ok right before it: the engine reported success, then found the
    // order never took. Rewrite that line rather than appending one — a new line would be
    // filtered as console noise, and the caster went on to narrate a library and a brickyard
    // that were never queued (turn 30 of run 65661dbf8382-016).
    if (event.kind === "action_correction") {
      for (let i = brief.did.length - 1; i >= 0; i--) {
        if (brief.did[i]!.startsWith("ok QUEUED")) {
          brief.did[i] = `${brief.did[i]} — CORRECTION: the order did NOT take, the queue is still empty`;
          break;
        }
      }
      continue;
    }
    const line = describe(event);
    if (line) brief.did.push(line);
  }

  // The roster is every seat in the match, from the manifest when it is there, else every seat
  // that has ever begun a turn. A turn is finished when EVERY roster seat has ended it — the plain
  // case — OR a later turn has already begun, which proves the turn fully cycled and lets a match
  // keep being narrated after a seat is eliminated and stops taking turns, OR the game is over.
  //
  // The old rule compared ended-count to begun-count SO FAR, and seats play one at a time: in the
  // window after the second seat ended and before the third began, both counts were two, so a live
  // reader called the turn finished and the commentator announced a seat "absent" that had simply
  // not started yet.
  const roster = readRoster(runDir, everBegan);
  return [...turns]
    .filter(([turn, seats]) => {
      const ended = new Set(seats.map((s) => s.seat));
      const allEnded = roster.every((r) => ended.has(r));
      return allEnded || turn < maxBegun || terminal;
    })
    .map(([turn, seats]) => ({ turn, seats }))
    .sort((a, b) => a.turn - b.turn);
}

/** The match roster: the manifest's seats, or every seat that has begun a turn if there is none. */
function readRoster(runDir: string, fallback: Set<string>): string[] {
  const path = join(runDir, "manifest.json");
  if (existsSync(path)) {
    try {
      // SAFETY: the manifest is written by this harness at match start; agents[].name is the roster.
      const manifest = JSON.parse(readFileSync(path, "utf8")) as { agents?: Array<{ name?: string }> };
      const names = (manifest.agents ?? []).flatMap((a) => (a.name ? [a.name] : []));
      if (names.length > 0) return names;
    } catch {
      // fall through to the seats we saw
    }
  }
  return [...fallback];
}
