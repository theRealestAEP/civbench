import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTiles, mergeForeignSettlements, type MergedSettlement } from "../src/dump/merge.ts";
import type { RawTilesSnapshot, MergedTile, ForeignSettlement } from "../src/dump/types.ts";

const tile = (x: number, y: number, vis: 1 | 2, extra: Record<string, unknown> = {}) => ({
  x, y, vis, terrain: 1, biome: 2, feature: 0, resource: 0,
  water: false, river: false, mountain: false, continent: 1, elevation: 100, ...extra,
});

const snapshot = (tiles: unknown[]): RawTilesSnapshot =>
  ({ width: 10, height: 10, tiles }) as RawTilesSnapshot;

test("visible tiles take the engine's current values", () => {
  const merged = mergeTiles(snapshot([tile(1, 1, 2, { owner: 3, cityId: "c7" })]), null, 42);
  assert.equal(merged[0]!.owner, 3);
  assert.equal(merged[0]!.cityId, "c7");
  assert.equal(merged[0]!.lastSeenTurn, 42);
});

test("fogged tiles keep what the player last saw, not what is true now", () => {
  const previous: MergedTile[] = [
    { ...tile(1, 1, 2), owner: 3, cityId: "c7", lastSeenTurn: 10 } as MergedTile,
  ];
  // The plot changed hands on turn 20, but this player has not looked since turn 10.
  const merged = mergeTiles(snapshot([tile(1, 1, 1)]), previous, 42);
  assert.equal(merged[0]!.owner, 3, "must report the remembered owner");
  assert.equal(merged[0]!.cityId, "c7");
  assert.equal(merged[0]!.lastSeenTurn, 10, "and must say how stale that is");
});

test("a fogged tile never seen up close reports no owner at all", () => {
  const merged = mergeTiles(snapshot([tile(4, 4, 1)]), [], 42);
  assert.equal(merged[0]!.owner, null);
  assert.equal(merged[0]!.lastSeenTurn, null);
});

test("unrevealed tiles are absent, not blanked", () => {
  const merged = mergeTiles(snapshot([tile(1, 1, 2, { owner: 0 })]), null, 5);
  assert.equal(merged.length, 1);
  assert.ok(!merged.some((t) => t.x === 9 && t.y === 9));
});

test("immutable fields survive fog", () => {
  const merged = mergeTiles(snapshot([tile(2, 2, 1, {})]), [], 42);
  assert.equal(merged[0]!.terrain, 1, "terrain does not change unseen");
  assert.equal(merged[0]!.biome, 2);
});

test("a remembered enemy city keeps its old owner while fogged", () => {
  const previous: MergedSettlement[] = [
    { id: "s1", name: "Uruk", kind: "city", owner: 2, x: 5, y: 5, isCapital: true, vis: 2, lastSeenTurn: 12 },
  ];
  const raw: ForeignSettlement[] = [
    { id: "s1", name: "Uruk", kind: "city", owner: 4, x: 5, y: 5, isCapital: true, vis: 1 },
  ];
  const merged = mergeForeignSettlements(raw, previous, 40);
  assert.equal(merged[0]!.owner, 2, "the player has not seen the conquest");
  assert.equal(merged[0]!.lastSeenTurn, 12);
});

test("the engine's unclaimed sentinel never reaches an agent", () => {
  // GameplayMap.getOwner returns -1 for an unowned plot. `owner=p-1` in a dump would be a
  // sentinel leaking into the agent's view of the world.
  const merged = mergeTiles(snapshot([tile(3, 3, 2, { owner: -1, cityId: null })]), null, 7);
  assert.equal(merged[0]!.owner, null);
});
