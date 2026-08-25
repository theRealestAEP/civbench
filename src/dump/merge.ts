// Carry-forward merge (docs/PLAN.md §7).
//
// The game engine will happily tell us the CURRENT owner and settlement of a plot the player
// cannot presently see. Reporting that is a leak: a human looking at a fogged tile sees what
// they last saw there, not what is true now. So the adapter refuses to read mutable fields
// while fogged, and this merge fills them in from the player's own previous snapshot.
//
// Immutable fields (terrain, biome, feature, resource, water, river, continent) are safe to
// read at any visibility, because they do not change without the player being told.
import type { MergedTile, RawTilesSnapshot, ForeignSettlement } from "./types.ts";

const key = (x: number, y: number) => `${x},${y}`;

export function mergeTiles(
  raw: RawTilesSnapshot,
  previous: MergedTile[] | null,
  turn: number,
): MergedTile[] {
  const before = new Map<string, MergedTile>();
  for (const tile of previous ?? []) before.set(key(tile.x, tile.y), tile);

  return raw.tiles.map((tile) => {
    if (tile.vis === 2) {
      // Seen first-hand this turn: the engine's values are what the player is looking at.
      // The engine uses -1 for "unclaimed"; normalise it so no sentinel reaches an agent.
      return {
        ...tile,
        owner: tile.owner === undefined || tile.owner < 0 ? null : tile.owner,
        cityId: tile.cityId ?? null,
        lastSeenTurn: turn,
      };
    }
    // Fogged: remember what this player last observed, and say when.
    const remembered = before.get(key(tile.x, tile.y));
    return {
      ...tile,
      owner: remembered?.owner ?? null,
      cityId: remembered?.cityId ?? null,
      // Buildings and improvements are remembered, not re-read. You keep knowing what you saw
      // standing on a plot; `last_seen` says how stale that memory is. Reading it fresh here
      // would leak what a rival has built since you last looked.
      built: remembered?.built ?? null,
      lastSeenTurn: remembered?.lastSeenTurn ?? null,
    };
  });
}

export type MergedSettlement = ForeignSettlement & { lastSeenTurn: number | null };

export function mergeForeignSettlements(
  raw: ForeignSettlement[],
  previous: MergedSettlement[] | null,
  turn: number,
): MergedSettlement[] {
  const before = new Map<string, MergedSettlement>();
  for (const s of previous ?? []) before.set(s.id, s);

  return raw.map((settlement) => {
    if (settlement.vis === 2) return { ...settlement, lastSeenTurn: turn };
    const remembered = before.get(settlement.id);
    // Keep the remembered record wholesale: name and owner may have changed since, and the
    // player has no way to know that yet.
    return remembered
      ? { ...remembered, vis: 1 as const }
      : { ...settlement, lastSeenTurn: null };
  });
}
