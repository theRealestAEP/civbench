// GameAdapter turns a raw JS bridge into typed, per-player reads of the live game.
// It is the only place that knows the shape of Civ 7's API.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bridge } from "./bridge.ts";
import type { Json } from "../dump/types.ts";
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

/** Scripts that change game state. Never auto-replayed across a reconnect (see run()). */
const MUTATING_SCRIPTS = new Set([
  "act", "choose", "diplomacy", "notify", "screen", "deal", "endturn", "save", "chat",
  "newgame", "startlobby", "loadsave", "handoff", "agefinish", "resource",
]);

function readGameJs(name: string): string {
  return readFileSync(join(GAMEJS_DIR, `${name}.js`), "utf8");
}

/** Scripts share a prelude that resolves the engine's numeric hashes to readable names. */
function loadScript(name: string): string {
  let source = scriptCache.get(name);
  if (source === undefined) {
    const screens = name === "pending" || name === "screen" ? readGameJs("_screens") : "";
    source = `${readGameJs("_prelude")}\n${screens}\n${readGameJs(name)}`;
    scriptCache.set(name, source);
  }
  return source;
}

export class GameAdapter {
  #bridge: Bridge;
  /** How to get a fresh bridge when this one dies. Absent for the fake, which cannot die. */
  #reconnect?: () => Promise<Bridge>;

  constructor(bridge: Bridge, reconnect?: () => Promise<Bridge>) {
    this.#bridge = bridge;
    this.#reconnect = reconnect;
  }

  /** Major civilizations alive in this match, agents and built-in AI together. */
  async majorPlayerCount(): Promise<number> {
    const out = await this.run<{ majors: number }>("majors", 0);
    return out.majors;
  }

  /**
   * Run one of the gamejs/ scripts for a given player.
   *
   * A dropped socket is survivable and used not to be. The debug server is serviced on the game
   * thread and goes quiet while the engine is busy, so the connection does die in a long match.
   * Nothing reconnected it: every later read failed, the match loop read that as "no seat became
   * active", and a 50-turn run sat printing that line for an hour with a perfectly healthy game
   * on screen. Reconnect once and try again — a second failure is a real failure.
   */
  async run<T>(script: string, playerId: number, extra: Record<string, Json> = {}): Promise<T> {
    const consts = Object.entries({ PLAYER_ID: playerId, ...extra })
      .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`)
      .join("\n");
    const js = `${consts}\n${loadScript(script)}`;
    try {
      return await this.#bridge.eval<T>(js);
    } catch (err) {
      if (!this.#reconnect || this.#bridge.alive !== false) throw err;
      this.#bridge = await this.#reconnect();
      // Replaying a MUTATION after a dead socket can execute it twice: sendRequest is
      // fire-and-forget, so the first eval may have sent the order and only the reply was lost.
      // Reads are safe to replay; a lost mutation must be re-checked, not re-sent.
      if (MUTATING_SCRIPTS.has(script)) {
        throw new Error(
          `the connection to the game dropped while sending "${script}" — ` +
            `the outcome is unknown. Re-read the state before retrying.`,
        );
      }
      return this.#bridge.eval<T>(js);
    }
  }

  /** Every GameInfo table in this build. Adapts to DLC instead of hard-coding a list. */
  ruleTables(): Promise<string[]> {
    return this.run<string[]>("tables", 0);
  }

  /** One static gameplay table, with display names resolved. */
  ruleTable(table: string) {
    return this.run<{ table: string; count: number; rows: Record<string, Json>[] } | null>(
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
