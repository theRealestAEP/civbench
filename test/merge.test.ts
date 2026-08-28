import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTiles, mergeForeignSettlements, type MergedSettlement } from "../src/dump/merge.ts";
import type { RawTilesSnapshot, MergedTile, ForeignSettlement } from "../src/dump/types.ts";

// `yields` is required on RawTile — a tile always produces something, even nothing. Two calls
// here built a tile without it and went through an `as` cast that hid the gap.
const tile = (x: number, y: number, vis: 1 | 2, extra: Record<string, unknown> = {}) => ({
  x, y, vis, terrain: "grassland", biome: "temperate", feature: null, resource: null,
  water: false, river: false, mountain: false, continent: "home", elevation: 100,
  yields: null, ...extra,
});

const snapshot = (tiles: unknown[]): RawTilesSnapshot =>
  // SAFETY: the helper above builds real RawTiles; this only wraps them in a snapshot so each
  // test can pass a bare list.
  ({ width: 10, height: 10, tiles }) as RawTilesSnapshot;

test("visible tiles take the engine's current values", () => {
  const merged = mergeTiles(snapshot([tile(1, 1, 2, { owner: 3, cityId: "c7" })]), null, 42);
  assert.equal(merged[0]!.owner, 3);
  assert.equal(merged[0]!.cityId, "c7");
  assert.equal(merged[0]!.lastSeenTurn, 42);
});

test("fogged tiles keep what the player last saw, not what is true now", () => {
  const previous: MergedTile[] = [
    // SAFETY: a tile as the merge would have left it last turn — the same fields mergeTiles
    // writes, assembled by hand so the test can control what was "remembered".
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
  assert.equal(merged[0]!.terrain, "grassland", "terrain does not change unseen");
  assert.equal(merged[0]!.biome, "temperate");
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

// Buildings and improvements are mutable, so they follow the same rule as owner: read fresh when
// the plot is visible, remembered when it is fogged, never re-read through fog. Reading them fresh
// would tell a player what a rival built since they last looked.
test("what is built on a plot is remembered through fog, not re-read", () => {
  const seen = mergeTiles(
    { width: 4, height: 4, tiles: [tile(1, 1, 2, { built: ["IMPROVEMENT_FARM"] })] },
    null,
    5,
  );
  assert.deepEqual(seen[0]!.built, ["IMPROVEMENT_FARM"]);
  assert.equal(seen[0]!.lastSeenTurn, 5);

  // The rival builds a wonder there, and the plot is now fogged. The player must not see it.
  const later = mergeTiles(
    { width: 4, height: 4, tiles: [tile(1, 1, 1, { built: ["WONDER_PYRAMIDS"] })] },
    seen,
    9,
  );
  assert.deepEqual(later[0]!.built, ["IMPROVEMENT_FARM"], "fog must show the remembered build");
  assert.equal(later[0]!.lastSeenTurn, 5, "and say how stale that memory is");
});

// `undefined` and `null` are different values and the same word, so a plot that had never been
// owned and still was not reported itself as having "changed hands" from none to none — three in
// one turn, in the section an agent reads to find out what is new.
test("a tile that did not change is not reported as changed", async () => {
  const { renderDelta } = await import("../src/dump/snapshot.ts");
  const previous = [{ ...tile(1, 1, 2), owner: null, cityId: null, lastSeenTurn: 5 } as MergedTile];
  // Same plot, unowned both times — but as `undefined` rather than `null` this turn.
  const now = [{ ...tile(1, 1, 2), lastSeenTurn: 6 } as unknown as MergedTile];
  const raw = {
    header: { turn: 6 },
    units: { own: [], foreign: [] },
    settlements: { own: [], foreign: [] },
    pending: { items: [], blockingType: null },
  } as unknown as Parameters<typeof renderDelta>[2];
  const delta = renderDelta(now, previous, raw, {
    tilesChanged: 0,
    unitsChanged: 0,
    settlementsChanged: 0,
  });
  assert.doesNotMatch(delta, /none -> none/, "nothing changed, so nothing should be reported");
});
