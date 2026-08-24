// Builds a self-contained replay page from a run's artifacts (docs/PLAN.md §12.1).
//
// We own events.jsonl and every turn's dump, so the replay needs nothing from the game. It is
// also the debugging tool: when a match goes wrong, this is how you see what each agent saw.
//
// Fog is per agent and free, because §7 already computed it.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

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
export type ReplayData = {
  agents: ReplayAgent[];
  events: Array<Record<string, unknown>>;
  width: number;
  height: number;
};

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
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
      const tileRows = readJsonl(join(dir, "tiles.jsonl"));
      const unitRows = readJsonl(join(dir, "units.jsonl"));
      const header = existsSync(join(dir, "header.json"))
        ? (JSON.parse(readFileSync(join(dir, "header.json"), "utf8")) as { turn: number })
        : { turn: Number(turnName.replace(/\D/g, "")) };

      const tiles: ReplayTile[] = tileRows.map((t) => {
        width = Math.max(width, (t.x as number) + 1);
        height = Math.max(height, (t.y as number) + 1);
        return {
          x: t.x as number,
          y: t.y as number,
          t: String(t.terrain ?? "unknown"),
          v: (t.vis as 1 | 2) ?? 1,
          o: t.owner === null || t.owner === undefined ? null : `p${t.owner}`,
        };
      });

      turns.push({
        turn: header.turn,
        hud: existsSync(join(dir, "hud.txt")) ? readFileSync(join(dir, "hud.txt"), "utf8") : "",
        tiles,
        units: unitRows.map((u) => ({
          id: String(u.id),
          x: (u.x as number) ?? 0,
          y: (u.y as number) ?? 0,
          type: String(u.type ?? "?"),
          own: u.movesRemaining !== undefined, // only own units carry movement detail
        })),
        pending: 0,
      });
    }
    agents.push({ name, turns });
  }

  return { agents, events: readJsonl(join(runDir, "events.jsonl")), width, height };
}
