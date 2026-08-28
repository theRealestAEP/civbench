// Builds a self-contained replay page from a run's artifacts (docs/PLAN.md §12.1).
//
// We own events.jsonl and every turn's dump, so the replay needs nothing from the game. It is
// also the debugging tool: when a match goes wrong, this is how you see what each agent saw.
//
// Fog is per agent and free, because §7 already computed it.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MergedTile } from "../dump/types.ts";

/** A row of units.jsonl. Own units carry movement detail; foreign ones do not. */
type DumpUnit = {
  id: string | number;
  x?: number;
  y?: number;
  type?: string;
  movesRemaining?: number;
};

export type ReplayTile = { x: number; y: number; t: string; v: 1 | 2; o: string | null };
export type ReplayUnit = { id: string; x: number; y: number; type: string; own: boolean };
export type ReplayTurn = {
  turn: number;
  hud: string;
  tiles: ReplayTile[];
  units: ReplayUnit[];
  pending: number;
};
export type ReplayAgent = { name: string; turns: ReplayTurn[] };

/** One line of events.jsonl, as the replay page renders it. */
export type ReplayEvent = {
  turn?: number;
  player?: number;
  kind?: string;
  request?: { actionType?: string };
  result?: { ok?: boolean; code?: string };
};
export type ReplayData = {
  agents: ReplayAgent[];
  events: ReplayEvent[];
  width: number;
  height: number;
};

/**
 * Read a JSONL file, skipping any line that will not parse.
 *
 * A killed run leaves a half-written last line, and this used to throw on it — so the replay, the
 * tool for working out why a run died, could not be built for a run that died. Every complete line
 * before the truncation is still good evidence.
 */
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.trim().length === 0) continue;
    try {
      // SAFETY: every file read here was written by this same run — tiles.jsonl and units.jsonl
      // come from toJsonl() in the dump writer, events.jsonl from the event log. The caller names
      // the record type it wrote. A line that does not parse is skipped above.
      out.push(JSON.parse(raw) as T);
    } catch {
      // A truncated tail is expected on a killed run. Earlier lines are still usable.
    }
  }
  return out;
}

export function collectRun(runDir: string): ReplayData {
  const agentsDir = join(runDir, "agents");
  const agents: ReplayAgent[] = [];
  let width = 0;
  let height = 0;

  for (const name of existsSync(agentsDir) ? readdirSync(agentsDir) : []) {
    const turnsDir = join(agentsDir, name, "turns");
    if (!existsSync(turnsDir)) continue;
    const turns: ReplayTurn[] = [];

    for (const turnName of readdirSync(turnsDir).sort()) {
      const dir = join(turnsDir, turnName);
      const tileRows = readJsonl<MergedTile>(join(dir, "tiles.jsonl"));
      const unitRows = readJsonl<DumpUnit>(join(dir, "units.jsonl"));
      // SAFETY: header.json is written by this harness's snapshot writer; only `turn` is read
      // here, and the other branch covers the file being absent.
      const header = existsSync(join(dir, "header.json"))
        ? (JSON.parse(readFileSync(join(dir, "header.json"), "utf8")) as { turn: number })
        : { turn: Number(turnName.replace(/\D/g, "")) };

      const tiles: ReplayTile[] = tileRows.map((t) => {
        width = Math.max(width, t.x + 1);
        height = Math.max(height, t.y + 1);
        return {
          x: t.x,
          y: t.y,
          t: t.terrain ?? "unknown",
          v: t.vis ?? 1,
          o: t.owner === null || t.owner === undefined ? null : `p${t.owner}`,
        };
      });

      turns.push({
        turn: header.turn,
        hud: existsSync(join(dir, "hud.txt")) ? readFileSync(join(dir, "hud.txt"), "utf8") : "",
        tiles,
        units: unitRows.map((u) => ({
          id: String(u.id),
          x: u.x ?? 0,
          y: u.y ?? 0,
          type: u.type ?? "?",
          own: u.movesRemaining !== undefined, // only own units carry movement detail
        })),
        pending: 0,
      });
    }
    agents.push({ name, turns });
  }

  return { agents, events: readJsonl<ReplayEvent>(join(runDir, "events.jsonl")), width, height };
}
