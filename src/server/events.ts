// The append-only event log (docs/PLAN.md §8). Ground truth for replays and for the run report.
// Nothing in here is ever rewritten, and no agent can read it (§9.1).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type Event = {
  turn: number;
  player: number | null;
  kind: string;
  [key: string]: unknown;
};

export class EventLog {
  #path: string;
  #runDir: string;
  #seq = 0;

  constructor(path: string) {
    this.#path = path;
    this.#runDir = dirname(path);
    mkdirSync(this.#runDir, { recursive: true });
  }

  append(event: Event): void {
    const at = new Date().toISOString();
    appendFileSync(this.#path, JSON.stringify({ seq: this.#seq++, at, ...event }) + "\n");

    // Also write a readable per-agent log, so one seat can be followed with `tail -f` while a
    // match runs. events.jsonl interleaves every seat, which is unreadable live.
    const name = typeof event.playerName === "string" ? event.playerName : null;
    if (!name) return;
    const dir = join(this.#runDir, "agents", name);
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "log.txt"), `${at.slice(11, 19)}  t${event.turn}  ${describe(event)}\n`);
    } catch { /* the agent directory may not exist yet on the first event */ }
  }
}

/** One readable line per event. */
function describe(event: Event): string {
  const req = event.request as { actionType?: string; targetId?: string } | undefined;
  const res = event.result as { ok?: boolean; code?: string; message?: string } | undefined;
  switch (event.kind) {
    case "turn_begin":
      return `--- turn begins (${(event.pending as number) ?? 0} pending) ---`;
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
      return `--- turn ends ---`;
    case "turn_end_forced":
      return `--- turn ENDED FOR IT (it never called end-turn) ---`;
    case "brain_error":
      return `ERROR ${String(event.message ?? "").slice(0, 160)}`;
    default:
      return event.kind;
  }
}
