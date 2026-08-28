// Config validation (docs/PLAN.md §5). The important behaviour is refusing to start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMatchConfig, ConfigError } from "../src/config/load.ts";

function configFile(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "civbench-cfg-")), "match.yaml");
  writeFileSync(path, body);
  return path;
}

const BASE = `
seed: 1
game: { turn_limit: 10 }
agents:
  - { slot: 0, player_id: 0, name: alpha }
`;

test("a minimal config loads with sane defaults", () => {
  const { config } = loadMatchConfig(configFile(BASE));
  assert.equal(config.agents.length, 1);
  assert.equal(config.agents[0]!.brain.kind, "scripted");
  assert.equal(config.game.fillerAi, "none");
});

test("the run id is derived from the config bytes, so it is reproducible", () => {
  const a = loadMatchConfig(configFile(BASE)).runId;
  const b = loadMatchConfig(configFile(BASE)).runId;
  const c = loadMatchConfig(configFile(BASE.replace("seed: 1", "seed: 2"))).runId;
  assert.equal(a, b, "same bytes, same run id");
  assert.notEqual(a, c, "a different seed is a different run");
});

test("an uncovered game mode refuses the match rather than running it", () => {
  // The whole point of §5: a mechanic the adapter does not model would corrupt the results
  // silently. Better to fail at startup with a name.
  const path = configFile(BASE + "\n");
  const withMode = configFile(`
seed: 1
game: { turn_limit: 10, game_modes: [secret_societies] }
agents:
  - { slot: 0, player_id: 0, name: alpha }
`);
  assert.doesNotThrow(() => loadMatchConfig(path));
  assert.throws(() => loadMatchConfig(withMode), (err: Error) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /secret_societies/);
    return true;
  });
});

test("duplicate player ids are refused", () => {
  const path = configFile(`
seed: 1
game: { turn_limit: 10 }
agents:
  - { slot: 0, player_id: 0, name: alpha }
  - { slot: 1, player_id: 0, name: beta }
`);
  assert.throws(() => loadMatchConfig(path), /share player id 0/);
});

test("the shipped duel config is valid", () => {
  const { config } = loadMatchConfig("configs/duel.yaml");
  assert.equal(config.agents.length, 2);
  assert.equal(config.controlMode, "direct");
});

test("the operation catalogue comes from the global enums, not GameInfo", async () => {
  // Reading GameInfo.PlayerOperations returned an empty list, which silently disabled the
  // unknown-operation check and left agents guessing names like CHOOSE_TECH.
  const { GameAdapter } = await import("../src/adapter/game.ts");
  const { FakeBridge, makeWorld } = await import("../src/test-support/fake-game.ts");
  const adapter = new GameAdapter(new FakeBridge(makeWorld()));
  const kinds = await adapter.run<Record<string, string[]>>("optypes", 0);
  assert.ok(kinds.player_operation.includes("SET_TECH_TREE_NODE"), "research op must be listed");
  assert.ok(kinds.unit_operation.length > 0);
  assert.ok(kinds.city_operation.length > 0);
});

test("the catalogue lists the names the engine accepts, not the enum keys", async () => {
  // UnitOperationTypes.FOUND_CITY has the value "UNITOPERATION_FOUND_CITY", and the engine wants
  // the value. Emitting keys made the unknown-operation check reject the CORRECT name.
  const { GameAdapter } = await import("../src/adapter/game.ts");
  const { FakeBridge, makeWorld } = await import("../src/test-support/fake-game.ts");
  const kinds = await new GameAdapter(new FakeBridge(makeWorld())).run<Record<string, string[]>>(
    "optypes",
    0,
  );
  assert.ok(
    kinds.unit_operation.includes("UNITOPERATION_FOUND_CITY"),
    `expected the full name, got ${kinds.unit_operation.join(", ")}`,
  );
  assert.ok(!kinds.unit_operation.includes("FOUND_CITY"), "the bare key must not be offered");
});

// The config was read through `Record<string, any>`, so a misspelled enum value was assigned
// straight through and surfaced hours later inside the game setup as a nonsense age.
test("a config with a bad enum value is refused at read time, by name", async () => {
  const { loadMatchConfig, ConfigError } = await import("../src/config/load.ts");
  const dir = mkdtempSync(join(tmpdir(), "civbench-config-"));
  const path = join(dir, "bad.yaml");
  writeFileSync(path, "seed: 1\ngame:\n  start_age: antiquty\nagents: []\n");
  assert.throws(
    () => loadMatchConfig(path),
    (err: unknown) =>
      err instanceof ConfigError &&
      /start_age/.test(err.message) &&
      /antiquity/.test(err.message),
    "it must name the field and what was allowed",
  );
});
