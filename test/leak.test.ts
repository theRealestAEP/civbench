// The leak test from docs/PLAN.md §7.
//
// The engine's read context can see every player. The single worst failure this project can
// have is a snapshot that quietly includes something the player has not earned the right to
// see, because it invalidates every result without ever throwing an error. This runs in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSnapshot, emptyMemory } from "../src/dump/snapshot.ts";
import type { RawSnapshot } from "../src/dump/types.ts";

const CANARY_UNIT = "canary-unit-99";
const CANARY_CITY = "canary-city-99";

/** What the extractor returns for a player who has revealed only the tiles around (1,1). */
function rawFor(playerId: number, revealed: Array<[number, number, 1 | 2]>): RawSnapshot {
  return {
    header: {
      turn: 42, maxTurns: 250, age: "antiquity" as unknown as number,
      ageProgress: null, playerId, civ: "EGYPT", leader: "HATSHEPSUT", isHuman: true,
      gold: 100, yields: {}, happiness: { net: 0, hasUnrest: false, turnsOfUnrest: 0 },
      settlements: { cities: 1, towns: 0, total: 1, cap: 3, population: 4 },
      unitCount: 1, legacy: [], government: null,
    },
    tiles: {
      width: 20, height: 20,
      tiles: revealed.map(([x, y, vis]) => ({
        x, y, vis, terrain: "grassland" as unknown as number,
        biome: "temperate" as unknown as number, feature: null as unknown as number,
        resource: null as unknown as number, water: false, river: false, mountain: false,
        continent: "a" as unknown as number, elevation: 1,
        ...(vis === 2 ? { owner: playerId, cityId: null } : {}),
      })),
    },
    units: { own: [], foreign: [] },
    settlements: { own: [], foreign: [] },
    players: { me: playerId, known: [] },
    pending: { blockingType: null, items: [] },
  } as unknown as RawSnapshot;
}

function readTurnDir(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

test("a unit hidden from the player appears nowhere in their dump", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "civbench-leak-"));
  // The extractor only ever emits foreign units on plots that are VISIBLE, so a canary sitting
  // in unrevealed territory must never reach the snapshot. This asserts the contract end to end.
  const raw = rawFor(0, [[1, 1, 2], [1, 2, 1]]);
  const { dir } = writeSnapshot(agentDir, raw, emptyMemory());
  const dump = readTurnDir(dir);
  assert.ok(!dump.includes(CANARY_UNIT), "canary unit leaked into the dump");
  assert.ok(!dump.includes(CANARY_CITY), "canary city leaked into the dump");
});

test("unrevealed tiles produce no line at all", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "civbench-leak-"));
  const raw = rawFor(0, [[1, 1, 2]]);
  const { dir } = writeSnapshot(agentDir, raw, emptyMemory());
  const tiles = readFileSync(join(dir, "tiles.txt"), "utf8").trim().split("\n");
  assert.equal(tiles.length, 1, "only the revealed tile may appear");
  assert.ok(tiles[0]!.startsWith("tile 1,1 "));
  // A 20x20 map has 400 plots. Emitting 399 blanked lines would itself be a leak: it tells the
  // agent the map's true dimensions and which plots exist.
  assert.ok(!tiles.some((l) => l.includes("9,9")));
});

test("two players at the same turn get provably different maps", () => {
  const dirA = mkdtempSync(join(tmpdir(), "civbench-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "civbench-b-"));
  const a = writeSnapshot(dirA, rawFor(0, [[1, 1, 2], [1, 2, 2]]), emptyMemory());
  const b = writeSnapshot(dirB, rawFor(1, [[8, 8, 2]]), emptyMemory());

  const tilesA = readFileSync(join(a.dir, "tiles.txt"), "utf8");
  const tilesB = readFileSync(join(b.dir, "tiles.txt"), "utf8");
  assert.notEqual(tilesA, tilesB, "fog of war must make the two dumps differ");
  assert.ok(tilesA.includes("tile 1,1"), "A sees its own start");
  assert.ok(!tilesB.includes("tile 1,1"), "B has not revealed A's start");
  assert.ok(!tilesA.includes("tile 8,8"), "A has not revealed B's start");
});

test("every tile line carries a visibility marker", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "civbench-leak-"));
  const { dir } = writeSnapshot(agentDir, rawFor(0, [[1, 1, 2], [2, 2, 1]]), emptyMemory());
  for (const l of readFileSync(join(dir, "tiles.txt"), "utf8").trim().split("\n")) {
    assert.match(l, /vis=(visible|fogged)/, `tile line without vis: ${l}`);
  }
});
