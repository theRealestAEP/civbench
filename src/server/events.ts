// The append-only event log (docs/PLAN.md §8). Ground truth for replays and for the run report.
// Nothing in here is ever rewritten, and no agent can read it (§9.1).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Json } from "../dump/types.ts";

/**
 * One line of events.jsonl.
 *
 * The fields are named rather than left to an open `[key: string]: unknown`. With the index
 * signature every reader had to assert its way back out — `describe` cast `request`, `result` and
 * `pending` on three consecutive lines — and nothing checked that a writer and a reader agreed on
 * a field's shape. Anything genuinely per-kind goes in `extra`.
 */
export type Event = {
  turn: number;
  player: number | null;
  kind: string;
  playerName?: string;
  playerId?: number;
  /** The action that was attempted, and what came back. */
  request?: {
    kind?: string;
    actionType?: string;
    targetId?: string | number;
    args?: Record<string, Json>;
  };
  result?: { ok?: boolean; code?: string; message?: string };
  ok?: boolean;
  code?: string | null;
  message?: string;
  error?: string | null;
  /** Rules export. */
  tables?: number;
  rows?: number;
  /** Autosave. */
  name?: string;
  /** Chat. */
  to?: string | null;
  text?: string;
  /** Turn bookkeeping. */
  pending?: number;
  blocking?: string | null;
  /** game_over: true for a real win, false when the age merely ended with no victor. */
  victory?: boolean;
  actionsUsed?: number;
  illegalActions?: number;
  timeoutMs?: number;
  unitId?: string;
  effort?: string;
  counts?: Record<string, number>;
  /** Anything a future event kind needs that is not worth a field here. */
  extra?: Record<string, string | number | boolean | null>;
};

export class EventLog {
  #path: string;
  #runDir: string;
  #seq = 0;

  constructor(path: string) {
    this.#path = path;
    this.#runDir = dirname(path);
    mkdirSync(this.#runDir, { recursive: true });
    // A resumed run appends to an existing log; restarting seq at 0 wrote duplicate sequence
    // numbers into a file whose whole point is a total order.
    try {
      this.#seq = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).length;
    } catch { /* a fresh run starts at 0 */ }
  }

  append(event: Event): void {
    const at = new Date().toISOString();
    appendFileSync(this.#path, JSON.stringify({ seq: this.#seq++, at, ...event }) + "\n");

    // Also write a readable per-agent log, so one seat can be followed with `tail -f` while a
    // match runs. events.jsonl interleaves every seat, which is unreadable live.
    const name = event.playerName;
    if (!name) return;
    const dir = join(this.#runDir, "agents", name);
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "log.txt"), `${at.slice(11, 19)}  t${event.turn}  ${describe(event)}\n`);
    } catch { /* the agent directory may not exist yet on the first event */ }
  }
}

/** One readable line per event. */
// eslint-disable-next-line complexity -- a switch over event kinds: one flat case per kind, and the log line for a kind belongs beside its siblings.
function describe(event: Event): string {
  const req = event.request;
  const res = event.result;
  switch (event.kind) {
    case "turn_begin":
      return `--- turn begins (${event.pending ?? 0} pending) ---`;
    case "action": {
      const what = `${req?.actionType ?? "?"}${req?.targetId ? ` on ${req.targetId}` : ""}`;
      return res?.ok ? `did   ${what}` : `FAILED ${what} -> ${res?.code ?? "?"}: ${res?.message ?? ""}`;
    }
    case "action_refused":
      return `refused ${req?.actionType ?? "?"} -> ${res?.code ?? ""}`;
    case "what_can":
      return `asked what it could do`;
    case "message":
      return `said to ${event.to ?? "everyone"}: ${JSON.stringify(event.text)}`;
    case "turn_end":
      // A refused end-turn is not the end of the turn. Rendering both the same way made the log
      // read as though turns ended two and three times over, and hid the refusals underneath.
      return event.ok === false
        ? `--- tried to end its turn, REFUSED: ${String(event.blocking ?? event.code ?? "no reason given")} ---`
        : `--- turn ends ---`;
    case "turn_end_forced":
      // Reached both when the agent never called end-turn and when its end-turn was refused and
      // the harness stepped in; the old wording claimed the first cause for every case.
      return event.ok === false
        ? `--- forced end-turn attempt FAILED: ${String(event.blocking ?? event.code ?? "no reason")} ---`
        : `--- turn ENDED FOR IT by the harness ---`;
    case "forced_answer":
      return `--- harness answered blocker ${String(event.blocking ?? "?")} for it: ${String(event.extra?.picked ?? "?")} ---`;
    case "interface_gap":
      return `INTERFACE GAP: ${event.message}`;
    case "action_correction":
      return `CORRECTION ${event.code ?? "?"}: ${event.message ?? ""}`;
    case "game_over":
      return `=== GAME OVER: ${event.message ?? "decided"} ===`;
    case "brain_error":
      return `ERROR ${String(event.message ?? "").slice(0, 160)}`;
    default:
      return event.kind;
  }
}
