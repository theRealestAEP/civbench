// Turns one player's raw read of the game into the files their agent will grep
// (docs/PLAN.md §6.4, §8).
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeTiles, mergeForeignSettlements, type MergedSettlement } from "./merge.ts";
import { emptyHandles, type Handles } from "./handles.ts";
import { renderHud, type MatchFacts } from "./hud.ts";
import {
  tileLines, unitLines, settlementLines, playerLines, pendingLines, toJsonl,
} from "./write.ts";
import type { MergedTile, RawSnapshot } from "./types.ts";

/** What we must remember between turns to keep fogged tiles honest (§7). */
export type PlayerMemory = {
  tiles: MergedTile[] | null;
  foreignSettlements: MergedSettlement[] | null;
  /** Readable names for units, kept for the life of the match. */
  handles: Handles;
};

export const emptyMemory = (): PlayerMemory => ({
  tiles: null,
  foreignSettlements: null,
  handles: emptyHandles(),
});

export type WrittenSnapshot = {
  dir: string;
  hud: string;
  memory: PlayerMemory;
  counts: { tilesChanged: number; unitsChanged: number; settlementsChanged: number };
};

/** A turn's directory name. Exported so nothing writes a second copy of this rule. */
export const pad = (turn: number) => `t${String(turn).padStart(4, "0")}`;

/**
 * What changed since this player last looked (docs/PLAN.md §6.3).
 *
 * The point is to make the cheap read the useful one: an agent should be able to open delta.md,
 * see nothing surprising, and get on with playing rather than re-reading thousands of tile lines.
 */
// eslint-disable-next-line complexity -- a renderer: one conditional per delta section, in the order the agent reads them.
export function renderDelta(
  tiles: MergedTile[],
  previous: MergedTile[] | null,
  raw: RawSnapshot,
  counts: { tilesChanged: number; unitsChanged: number; settlementsChanged: number },
): string {
  const lines: string[] = [`# changes since your last turn (turn ${raw.header.turn})`, ""];

  if (!previous) {
    lines.push("First turn — everything is new. Read tiles.txt, units.txt and settlements.txt.");
    return lines.join("\n") + "\n";
  }

  const before = new Map(previous.map((t) => [`${t.x},${t.y}`, t]));
  const newlySeen: string[] = [];
  const changed: string[] = [];
  for (const tile of tiles) {
    const key = `${tile.x},${tile.y}`;
    const old = before.get(key);
    if (!old) {
      newlySeen.push(key);
    } else {
      // Compare what the agent would SEE, not the raw values. `undefined` and `null` are
      // different values and the same word, so a plot that had never been owned and still was not
      // reported itself as having "changed hands" from none to none — three of them in one turn,
      // in the section an agent reads to find out what is new.
      const was = old.owner ?? null;
      const now = tile.owner ?? null;
      const wasCity = old.cityId ?? null;
      const nowCity = tile.cityId ?? null;
      if (was !== now || wasCity !== nowCity) {
        changed.push(`${key} owner ${was ?? "none"} -> ${now ?? "none"}`);
      }
    }
  }

  lines.push(`tiles: ${newlySeen.length} newly revealed, ${changed.length} changed hands`);
  if (newlySeen.length > 0 && newlySeen.length <= 40) {
    lines.push(`  new: ${newlySeen.join(" ")}`);
  } else if (newlySeen.length > 40) {
    lines.push(`  new: ${newlySeen.slice(0, 40).join(" ")} … and ${newlySeen.length - 40} more`);
  }
  for (const line of changed.slice(0, 20)) lines.push(`  ${line}`);

  lines.push("", `your units: ${raw.units.own.length}`, `enemy units in sight: ${raw.units.foreign.length}`);
  for (const unit of raw.units.foreign.slice(0, 10)) {
    lines.push(`  ${unit.type} of p${unit.owner} at ${unit.x},${unit.y}`);
  }

  lines.push("", `your settlements: ${raw.settlements.own.length}`);
  for (const s of raw.settlements.own) {
    lines.push(`  ${s.name ?? s.id} (${s.kind}) at ${s.x},${s.y} pop ${s.population ?? "?"}${s.queueEmpty && s.kind !== "town" ? "  BUILD QUEUE EMPTY" : ""}`);
  }

  if (raw.pending.items.length > 0) {
    lines.push("", "the game is waiting on you for:");
    for (const item of raw.pending.items) lines.push(`  ${item.summary ?? item.type}`);
  }
  lines.push("", `(changed tiles: ${counts.tilesChanged}; in sight: ${counts.unitsChanged} units, ${counts.settlementsChanged} settlements)`);
  return lines.join("\n") + "\n";
}

function countChangedTiles(next: MergedTile[], previous: MergedTile[] | null): number {
  if (!previous) return next.length;
  const before = new Map(previous.map((t) => [`${t.x},${t.y}`, t]));
  let changed = 0;
  for (const tile of next) {
    const old = before.get(`${tile.x},${tile.y}`);
    if (!old || old.owner !== tile.owner || old.cityId !== tile.cityId || old.vis !== tile.vis) {
      changed++;
    }
  }
  return changed;
}

/**
 * The fog filter and carry-forward merge, shared by the turn-start snapshot and every mid-turn
 * refresh. It used to live only in writeSnapshot, so refreshDump wrote raw.units.foreign
 * UNFILTERED — every mid-turn refresh bypassed the second defense layer the comment below calls
 * the invariant the whole benchmark rests on.
 */
export function applyFog(raw: RawSnapshot, memory: PlayerMemory) {
  const turn = raw.header.turn;
  const tiles = mergeTiles(raw.tiles, memory.tiles, turn);

  const visibleNow = new Set(tiles.filter((t) => t.vis === 2).map((t) => `${t.x},${t.y}`));
  const visibleForeign = raw.units.foreign.filter((u) => visibleNow.has(`${u.x},${u.y}`));

  // Settlements take the weaker rule on purpose: you keep knowing about a city once you have
  // found it, so REVEALED is enough and it stays through fog. A plot never revealed is still
  // never reported.
  const everSeen = new Set(tiles.map((t) => `${t.x},${t.y}`));
  const knownForeign = raw.settlements.foreign.filter((c) => everSeen.has(`${c.x},${c.y}`));

  const foreignSettlements = mergeForeignSettlements(knownForeign, memory.foreignSettlements, turn);

  return { tiles, visibleForeign, foreignSettlements };
}

export function writeSnapshot(
  agentDir: string,
  raw: RawSnapshot,
  memory: PlayerMemory,
  messageCount = 0,
  notesText?: string,
  match?: MatchFacts,
): WrittenSnapshot {
  const turn = raw.header.turn;
  const { tiles, visibleForeign, foreignSettlements } = applyFog(raw, memory);

  // Retire the handle of any unit that no longer exists, so a recycled engine id can never
  // silently inherit a dead unit's name. Ordinals never restart, so a retired handle is never
  // reassigned either — a unit seen again later gets a fresh name.
  const liveIds = new Set(raw.units.own.map((u) => u.id));
  for (const id of Object.keys(memory.handles.units)) {
    if (!liveIds.has(id)) delete memory.handles.units[id];
  }

  const counts = {
    tilesChanged: countChangedTiles(tiles, memory.tiles),
    unitsChanged: raw.units.own.length + raw.units.foreign.length,
    settlementsChanged: raw.settlements.own.length + foreignSettlements.length,
  };

  /**
   * A rival unit is only reported on a plot the player can see RIGHT NOW.
   *
   * `units.js` already applies this rule inside the game, so this is the second of two independent
   * layers. That is deliberate: a single regression in the extractor would otherwise put a hidden
   * unit in front of an agent, and nothing downstream would notice. §7 makes this the invariant
   * the whole benchmark rests on — a leak invalidates every result without ever throwing.
   *
   * Remembered settlements are different and stay: you keep knowing about a city you have found.
   */
  const turnDir = join(agentDir, "turns", pad(turn));
  mkdirSync(turnDir, { recursive: true });

  // Text for grep and sed; JSONL for jq. Same records, same order (§6.1).
  const files: Array<[string, string[], unknown[]]> = [
    ["tiles", tileLines(tiles), tiles],
    ["units", unitLines(raw.units.own, visibleForeign, memory.handles), [...raw.units.own, ...visibleForeign]],
    ["settlements", settlementLines(raw.settlements.own, foreignSettlements), [...raw.settlements.own, ...foreignSettlements]],
    ["players", playerLines(raw.players.known), raw.players.known],
  ];
  for (const [name, lines, records] of files) {
    writeFileSync(join(turnDir, `${name}.txt`), lines.join("\n") + "\n");
    writeFileSync(join(turnDir, `${name}.jsonl`), toJsonl(records) + "\n");
  }

  writeFileSync(join(turnDir, "pending.txt"), pendingLines(raw.pending).join("\n") + "\n");
  // The briefing promises a .jsonl twin for the /current files; pending had none.
  writeFileSync(join(turnDir, "pending.jsonl"), toJsonl(raw.pending.items) + "\n");

  // The delta. Promised by the HUD on every turn and, until now, never written — so agents
  // re-read the entire dump each turn instead. Two thirds of an agent's commands were `cat`.
  writeFileSync(join(turnDir, "delta.md"), renderDelta(tiles, memory.tiles, raw, counts));
  writeFileSync(join(turnDir, "header.json"), JSON.stringify(raw.header, null, 2));

  // Read back what we just wrote, so the push and the files can never disagree.
  const read = (name: string): string | undefined => {
    try {
      return readFileSync(join(turnDir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const hud = renderHud(raw.header, raw.pending, counts, messageCount, {
    deltaText: read("delta.md"),
    pendingText: read("pending.txt"),
    unitsText: read("units.txt"),
    settlementsText: read("settlements.txt"),
    messagesText: read("messages.txt"),
    notesText: notesText,
    playersText: read("players.txt"),
    // Written after the snapshot, so this reads last turn's on turn one and the current one after.
    actionsText: read("actions.txt"),
  }, match);
  writeFileSync(join(turnDir, "hud.txt"), hud + "\n");

  // One line per turn, so an agent can find the right turn before reading it (§8).
  const indexPath = join(agentDir, "index.md");
  if (!existsSync(indexPath)) writeFileSync(indexPath, "# turn index\n");
  // The label matches the directory name (t0004, not t4), so a line can be copied into a path.
  appendFileSync(
    indexPath,
    `- ${pad(turn)}: age=${raw.header.age} gold=${raw.header.gold ?? "?"} settlements=${raw.header.settlements.total ?? "?"} units=${raw.header.unitCount} pending=${raw.pending.items.length}\n`,
  );

  // handles carries forward: a handle assigned on turn 3 must still name the same unit on turn 30,
  // or a journal entry about "scout-1" becomes a lie.
  return { dir: turnDir, hud, memory: { tiles, foreignSettlements, handles: memory.handles }, counts };
}
