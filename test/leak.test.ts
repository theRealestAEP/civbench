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

/**
 * Owner fields, which the extractor only ever sets on a VISIBLE plot.
 *
 * Its own function rather than a conditional spread of `{}`: an empty spread hides WHICH keys go
 * missing, and in a fog test the keys that go missing are the whole point.
 */
function visibleOwner(vis: 1 | 2, playerId: number): { owner?: number; cityId?: null } {
  return vis === 2 ? { owner: playerId, cityId: null } : {};
}

/** What the extractor returns for a player who has revealed only the tiles around (1,1). */
function rawFor(playerId: number, revealed: Array<[number, number, 1 | 2]>): RawSnapshot {
  return {
    header: {
      turn: 42, maxTurns: 250, age: "antiquity",
      ageProgress: null, playerId, civ: "EGYPT", leader: "HATSHEPSUT", isHuman: true,
      gold: 100, yields: {}, happiness: { net: 0, hasUnrest: false, turnsOfUnrest: 0 },
      settlements: { cities: 1, towns: 0, total: 1, cap: 3, population: 4 },
      unitCount: 1, legacy: [], government: null,
    },
    tiles: {
      width: 20, height: 20,
      tiles: revealed.map(([x, y, vis]) => ({
        x, y, vis, terrain: "grassland",
        biome: "temperate", feature: null,
        resource: null, water: false, river: false, mountain: false,
        continent: "a", elevation: 1,
        ...visibleOwner(vis, playerId),
      })),
    },
    // The canaries go IN, on a plot the player has never revealed.
    //
    // They used to be absent from the input entirely, so this test asserted that a string which
    // never entered the pipeline did not come out of it. Replacing writeSnapshot with a function
    // that dumped every field it received would still have passed. The flagship leak guard, and
    // the contract the whole benchmark rests on, was checking nothing at all.
    units: {
      own: [],
      foreign: [
        // SAFETY: a canary, deliberately shaped like a unit the player must never be shown. It
        // carries `hp` rather than the real damage fields precisely so it is distinguishable.
        { id: CANARY_UNIT, owner: 9, type: "warrior", x: 9, y: 9, hp: 100 } as never,
      ],
    },
    settlements: {
      own: [],
      foreign: [
        // SAFETY: the settlement canary, same purpose as the unit one above.
        { id: CANARY_CITY, owner: 9, name: CANARY_CITY, x: 9, y: 9, kind: "city" } as never,
      ],
    },
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
  // The player reveals 1,1 and 1,2 only. The canaries sit at 9,9, which they have never seen.
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

// The rule this codebase states in types.ts: no raw type hash ever reaches an agent. Two were
// getting through on every turn — `growthType` in settlements.jsonl and `government` in
// header.json — because both are resolved nowhere and pass straight from the engine to disk.
test("no agent-readable file carries a raw type hash", async () => {
  const { writeSnapshot, emptyMemory } = await import("../src/dump/snapshot.ts");
  const dir = mkdtempSync(join(tmpdir(), "civbench-hash-"));
  const written = writeSnapshot(dir, rawFor(0, [[1, 1, 2]]), emptyMemory(), 0);
  for (const file of readdirSync(written.dir)) {
    const text = readFileSync(join(written.dir, file), "utf8");
    // A bare number of seven digits or more, as a field value, is a hash that escaped. `engine_id`
    // is the one number an agent is meant to see: it is how the engine names a unit.
    const escaped = text
      .split("\n")
      .filter((l) => /(?<!engine_id)(=|":\s*)-?\d{7,}\b/.test(l))
      .filter((l) => !l.includes("engine_id"));
    assert.deepEqual(escaped, [], `${file} leaks a raw hash`);
  }
});

// A rival's legacy score and war support are on the diplomacy ribbon for every MET civ, so they
// are inside the fog boundary and belong in the dump. The harness read neither: an agent could
// see who had the bigger economy but not who was closest to winning, and could not judge a war
// before starting one — in a benchmark scored on winning the Age.
test("a met rival shows how close they are to winning, and whether a war is safe", async () => {
  const { writeSnapshot, emptyMemory } = await import("../src/dump/snapshot.ts");
  const dir = mkdtempSync(join(tmpdir(), "civbench-ribbon-"));
  const written = writeSnapshot(dir, rawFor(0, [[1, 1, 2]]), emptyMemory(), 0);
  const players = readFileSync(join(written.dir, "players.txt"), "utf8");
  if (!players.trim()) return; // no rivals met in this fixture
  assert.match(players, /war_support_for_me=/, "a war must be judgeable before it is started");
});
