// Runs the REAL src/adapter/gamejs/*.js against a fake Civ 7 (docs/PLAN.md §14).
// These tests are the fog-of-war contract enforced at the source, not at the writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameAdapter } from "../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../src/test-support/fake-game.ts";

const adapterFor = (world = makeWorld()) => new GameAdapter(new FakeBridge(world));

test("tiles: only revealed plots are returned", async () => {
  const result = await adapterFor().tiles(0);
  // p0 revealed exactly three plots of a 64-plot map.
  assert.equal(result.tiles.length, 3);
  const coords = result.tiles.map((t) => `${t.x},${t.y}`).sort();
  assert.deepEqual(coords, ["1,1", "1,2", "2,1"]);
});

test("tiles: mutable fields are withheld while fogged", async () => {
  const result = await adapterFor().tiles(0);
  const visible = result.tiles.find((t) => t.x === 1 && t.y === 1)!;
  const fogged = result.tiles.find((t) => t.x === 1 && t.y === 2)!;
  assert.equal(visible.vis, 2);
  assert.ok("owner" in visible, "a visible plot reports its owner");
  assert.equal(fogged.vis, 1);
  assert.ok(!("owner" in fogged), "a fogged plot must not read the engine's current owner");
});

test("tiles: hashes are resolved to names, never leaked as numbers", async () => {
  const result = await adapterFor().tiles(0);
  assert.equal(typeof result.tiles[0]!.terrain, "string");
  assert.equal(result.tiles[0]!.terrain as unknown as string, "1");
});

test("units: a rival unit on an unrevealed plot is invisible", async () => {
  const result = await adapterFor().units(0);
  assert.equal(result.own.length, 1);
  assert.equal(result.own[0]!.id, "10");
  assert.equal(result.foreign.length, 0, "p1's unit sits on a plot p0 has never revealed");
});

test("units: a rival unit becomes visible only when its plot is", async () => {
  const world = makeWorld();
  world.revealed[0]!["6,6"] = 2; // p0 now sees p1's tile
  const result = await adapterFor(world).units(0);
  assert.equal(result.foreign.length, 1);
  assert.equal(result.foreign[0]!.owner, 1);
});

test("players: an unmet civ is absent entirely", async () => {
  const result = await adapterFor().players(0);
  assert.equal(result.known.length, 0);
});

// Where the line actually falls, checked against the game rather than assumed.
//
// The diplomacy ribbon is on a human's screen at all times and shows every MET civ's net yields,
// settlement count and score — `createPlayerYieldsData(player, isLocal)` computes the values for
// everyone and uses isLocal only to pick which icon to draw. So those are parity, not secrets.
// This test used to forbid them, which meant no agent could tell whether it was winning.
//
// Still private, because no screen shows them: the treasury BALANCE (as against income per turn),
// what a rival is building, and which techs it holds.
test("a met civ shows what the ribbon shows, and nothing a screen never shows", async () => {
  const world = makeWorld();
  world.met[0] = [1];
  const result = await adapterFor(world).players(0);
  assert.equal(result.known.length, 1);
  const known = result.known[0]! as Record<string, unknown>;

  for (const shown of ["gold", "science", "culture", "settlements", "atWar"]) {
    assert.ok(shown in known, `the ribbon shows rival ${shown}; withholding it handicaps the agent`);
  }
  for (const secret of ["treasury", "goldBalance", "production", "productionHash", "techs", "researching"]) {
    assert.ok(!(secret in known), `rival ${secret} is on no screen and must not be exposed`);
  }
});

test("settlements: a rival city on an unrevealed plot is absent", async () => {
  const result = await adapterFor().settlements(0);
  assert.equal(result.own.length, 1);
  assert.equal(result.foreign.length, 0);
});

test("header: reports the player's own totals", async () => {
  const header = await adapterFor().header(0);
  assert.equal(header.turn, 42);
  assert.equal(header.playerId, 0);
  assert.equal(header.gold, 100);
  assert.equal(header.unitCount, 1);
});
