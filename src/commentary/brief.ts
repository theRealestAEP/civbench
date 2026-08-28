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
  gold: number | null;
  science: number | null;
  culture: number | null;
  settlements: number | null;
  units: number | null;
  /** Legacy-path scores, the game's own win progress. */
  legacy: Record<string, number>;
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
};

/** One game turn, once every seat that began it has ended it. */
export type CompleteTurn = { turn: number; seats: TurnBrief[] };


/** How much of the seat's reasoning to carry. The opening states the plan; the rest is grep output. */
const REASONING_CHARS = 1200;

function readEvents(runDir: string): Event[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  // SAFETY: this file is written by the match server in this same run, one Event per line.
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Event);
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
    case "action":
      return res.ok ? `ok ${what}` : `FAILED ${what} -> ${res.code ?? "?"}`;
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
      yields?: { science?: number; culture?: number };
      settlements?: { total?: number };
      unitCount?: number;
      legacy?: Array<{ type: string; score?: number }>;
    };
    return {
      age: header.age ?? null,
      gold: header.gold ?? null,
      science: header.yields?.science ?? null,
      culture: header.yields?.culture ?? null,
      settlements: header.settlements?.total ?? null,
      units: header.unitCount ?? null,
      legacy: Object.fromEntries(
        (header.legacy ?? [])
          .filter((l) => (l.score ?? 0) > 0)
          .map((l) => [l.type.replace(/^LEGACY_PATH_/, "").toLowerCase(), l.score ?? 0]),
      ),
    };
  } catch {
    return null;
  }
}

/** How many journal lines the caster sees. The tail is the seat's recent plan in its own words. */
const NOTES_LINES = 8;

/**
 * The tail of the seat's own journal. It is where agents distil their strategy — one dated line
 * per turn — and it beats the transcript opening as a strategy source: the first thinking block
 * is often "let me read delta.md", while a note reads "t13: chose Writing; queued settler".
 */
function readNotesTail(runDir: string, seat: string): string {
  const path = join(runDir, "notes", seat, "notes.md");
  if (!existsSync(path)) return "";
  const dated = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => /^- t\d+:/.test(line));
  return dated.slice(-NOTES_LINES).join("\n");
}

/**
 * The lines in a finished turn worth telling even late — war, peace, a settlement founded, a
 * deal answered, words exchanged, a turn taken away. The follow loop drops whole turns when it
 * falls behind; these survive the drop and ride into the next prompt, so "while we were away,
 * war broke out" gets said instead of never.
 */
export function milestonesOf(turn: CompleteTurn): string[] {
  const BIG = /FOUND_CITY|DECLARE_WAR|MAKE_PEACE|FORM_ALLIANCE|^said to|^ok accept|^ok reject/;
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

/** The opening of one seat's reasoning for one turn. Empty when the seat wrote none. */
function readReasoning(runDir: string, seat: string, turn: number): string {
  const dir = `t${String(turn).padStart(4, "0")}`;
  const path = join(runDir, "agents", seat, "turns", dir, "transcript.md");
  if (!existsSync(path)) return "";
  // The transcript interleaves reasoning with shell output. Take the first thinking block: it is
  // where the seat states its plan, before the dump reading buries it.
  const block = readFileSync(path, "utf8").split("--- thinking ---")[1] ?? "";
  return block.split("--- ran ---")[0]!.trim().slice(0, REASONING_CHARS);
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
  const started = new Map<number, number>();

  for (const event of readEvents(runDir)) {
    const seat = typeof event.playerName === "string" ? event.playerName : null;
    if (!seat) continue;
    const key = `${event.turn}:${seat}`;

    if (event.kind === "turn_begin") {
      open.set(key, { turn: event.turn, seat, did: [], endedByLoop: false, reasoning: "" });
      started.set(event.turn, (started.get(event.turn) ?? 0) + 1);
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
      brief.notes = readNotesTail(runDir, seat);
      open.delete(key);
      if (!turns.has(event.turn)) turns.set(event.turn, []);
      turns.get(event.turn)!.push(brief);
      continue;
    }
    const line = describe(event);
    if (line) brief.did.push(line);
  }

  return [...turns]
    .filter(([turn, seats]) => seats.length >= (started.get(turn) ?? 0))
    .map(([turn, seats]) => ({ turn, seats }))
    .sort((a, b) => a.turn - b.turn);
}
