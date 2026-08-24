// One seat's slice of one turn, read off disk (docs/PLAN.md §12.3).
//
// The commentator reads only what is already written: events.jsonl and the agents' own
// transcripts. It holds no seat and it takes no action. Nothing built here ever reaches a
// playing agent — that would make the caster a covert channel between them and invalidate
// every result the benchmark produces.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type TurnBrief = {
  turn: number;
  seat: string;
  /** One readable line per thing the seat did, in the order it did them. */
  did: string[];
  /** True when the turn loop ended the turn because the seat never did. */
  endedByLoop: boolean;
  /** The opening of the seat's own reasoning, from its transcript. */
  reasoning: string;
};

/** One game turn, once every seat that began it has ended it. */
export type CompleteTurn = { turn: number; seats: TurnBrief[] };

type Event = Record<string, any>;

/** How much of the seat's reasoning to carry. The opening states the plan; the rest is grep output. */
const REASONING_CHARS = 1200;

function readEvents(runDir: string): Event[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
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
  const req = (event.request ?? {}) as {
    actionType?: string;
    targetId?: string;
    args?: Record<string, unknown>;
  };
  const res = (event.result ?? {}) as { ok?: boolean; code?: string; message?: string };
  const args = req.args && Object.keys(req.args).length > 0 ? ` ${JSON.stringify(req.args)}` : "";
  const what = `${req.actionType ?? "?"}${req.targetId ? ` on ${req.targetId}` : ""}${args}`;
  switch (event.kind) {
    // ok and FAILED are deliberately parallel. A first draft wrote "did X" against "FAILED X",
    // and the caster moved a successful build into the failure column of its sentence.
    case "action":
      return res.ok ? `ok ${what}` : `FAILED ${what} -> ${res.code ?? "?"}: ${res.message ?? ""}`;
    case "action_refused":
      return `REFUSED ${what} -> out of budget`;
    case "message":
      return `said to ${event.to ?? "everyone"}: ${JSON.stringify(event.text)}`;
    default:
      return null;
  }
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
      brief.endedByLoop = event.kind === "turn_end_forced";
      brief.reasoning = readReasoning(runDir, seat, event.turn);
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
