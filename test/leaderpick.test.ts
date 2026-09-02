// The pre-game leader pick (docs/PLAN.md §5): the agent names a leader from the settings, and the
// caller validates it against the real list — an unclear pick must fall back to the default, never
// block the start. A static list (leaders-list.ts) holds the choices; the game applies them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchLeader, type LeaderOption } from "../src/agent/pick-leader.ts";
import { LEADERS as LEADER_LIST } from "../src/agent/leaders-list.ts";

const LEADERS: LeaderOption[] = [
  { type: "LEADER_XERXES", name: "Xerxes" },
  { type: "LEADER_HATSHEPSUT", name: "Hatshepsut" },
];

test("matchLeader accepts the type, the name, and prose around the pick", () => {
  assert.equal(matchLeader("LEADER_XERXES", LEADERS), "LEADER_XERXES");
  assert.equal(matchLeader("xerxes", LEADERS), "LEADER_XERXES");
  assert.equal(matchLeader("I will play as Hatshepsut.", LEADERS), "LEADER_HATSHEPSUT");
});

test("an unknown pick returns null so the caller keeps the default", () => {
  assert.equal(matchLeader("Napoleon", LEADERS), null);
  assert.equal(matchLeader("", LEADERS), null);
});

test("the static leader list holds real leaders and no placeholders", () => {
  const types = LEADER_LIST.map((l) => l.type);
  assert.ok(types.includes("LEADER_XERXES") && types.includes("LEADER_HATSHEPSUT"));
  assert.ok(types.length >= 20, "the roster is populated from the game data");
  assert.ok(
    !types.some((t) => /RANDOM|NONE|_DEFAULT|_ABSTRACT|INDEPENDENT/.test(t)),
    "no placeholder/non-playable rows are offered",
  );
});
