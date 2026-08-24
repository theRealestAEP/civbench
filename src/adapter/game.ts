// GameAdapter turns a raw JS bridge into typed, per-player reads of the live game.
// It is the only place that knows the shape of Civ 7's API.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bridge } from "./bridge.ts";
import type {
  HeaderSnapshot,
  PendingSnapshot,
  PlayersSnapshot,
  RawTilesSnapshot,
  SettlementsSnapshot,
  UnitsSnapshot,
} from "../dump/types.ts";

const GAMEJS_DIR = join(dirname(fileURLToPath(import.meta.url)), "gamejs");
const scriptCache = new Map<string, string>();

function readGameJs(name: string): string {
  return readFileSync(join(GAMEJS_DIR, `${name}.js`), "utf8");
}

/** Scripts share a prelude that resolves the engine's numeric hashes to readable names. */
function loadScript(name: string): string {
  let source = scriptCache.get(name);
  if (source === undefined) {
    source = `${readGameJs("_prelude")}\n${readGameJs(name)}`;
    scriptCache.set(name, source);
  }
  return source;
}

export class GameAdapter {
  #bridge: Bridge;

  constructor(bridge: Bridge) {
    this.#bridge = bridge;
  }

  /** Major civilizations alive in this match, agents and built-in AI together. */
  async majorPlayerCount(): Promise<number> {
    const out = await this.run<{ majors: number }>("majors", 0);
    return out.majors;
  }

  /** Run one of the gamejs/ scripts for a given player. */
  async run<T>(script: string, playerId: number, extra: Record<string, unknown> = {}): Promise<T> {
    const consts = Object.entries({ PLAYER_ID: playerId, ...extra })
      .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`)
      .join("\n");
    return this.#bridge.eval<T>(`${consts}\n${loadScript(script)}`);
  }

  /** Every GameInfo table in this build. Adapts to DLC instead of hard-coding a list. */
  ruleTables(): Promise<string[]> {
    return this.run<string[]>("tables", 0);
  }

  /** One static gameplay table, with display names resolved. */
  ruleTable(table: string) {
    return this.run<{ table: string; count: number; rows: Record<string, unknown>[] } | null>(
      "rules",
      0,
      { TABLE_NAME: table },
    );
  }

  header(playerId: number) {
    return this.run<HeaderSnapshot>("header", playerId);
  }
  tiles(playerId: number) {
    return this.run<RawTilesSnapshot>("tiles", playerId);
  }
  units(playerId: number) {
    return this.run<UnitsSnapshot>("units", playerId);
  }
  settlements(playerId: number) {
    return this.run<SettlementsSnapshot>("settlements", playerId);
  }
  players(playerId: number) {
    return this.run<PlayersSnapshot>("players", playerId);
  }
  pending(playerId: number) {
    return this.run<PendingSnapshot>("pending", playerId);
  }

  /** Everything for one player, in one round of evaluations. */
  async snapshot(playerId: number) {
    const [header, tiles, units, settlements, players, pending] = await Promise.all([
      this.header(playerId),
      this.tiles(playerId),
      this.units(playerId),
      this.settlements(playerId),
      this.players(playerId),
      this.pending(playerId),
    ]);
    return { header, tiles, units, settlements, players, pending };
  }

  /** Player ids taking part in the match. */
  alivePlayers(): Promise<number[]> {
    return this.#bridge.eval<number[]>("return Players.getAlive().map((p) => p.id)");
  }

  turn(): Promise<number> {
    return this.#bridge.eval<number>("return Game.turn");
  }
}
