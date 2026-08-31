// The units text file is what agents actually read. A settler's `can_found_here` is the decisive
// "found button lit or dark" flag, but the writer's blanket false-drop hid it exactly when it was
// false — so an agent saw the button only when lit and spammed illegal FOUND_CITY for turns. It
// must stay visible for founders in BOTH states, without adding can_found_here=no noise to others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unitLines } from "../src/dump/write.ts";
import type { OwnUnit } from "../src/dump/types.ts";

const base: OwnUnit = {
  id: "1", owner: 0, type: "warrior", x: 50, y: 14, damage: null, maxDamage: null, name: null,
  movesRemaining: 2, canMove: true, experience: null, isCommander: false, armyId: null,
};

test("a blocked settler shows can_found_here=no; a warrior omits the flag", () => {
  const settler: OwnUnit = { ...base, id: "1", type: "settler", canFoundHere: false };
  const warrior: OwnUnit = { ...base, id: "2", type: "warrior", canFoundHere: false };
  const [settlerLine, warriorLine] = unitLines([settler, warrior], []);
  assert.match(settlerLine!, /can_found_here=no/, "the founder's dark button must be visible");
  assert.doesNotMatch(warriorLine!, /can_found_here/, "non-founders keep no can_found_here noise");
});

test("a settler that can found shows can_found_here=yes", () => {
  const settler: OwnUnit = { ...base, type: "settler", canFoundHere: true };
  assert.match(unitLines([settler], [])[0]!, /can_found_here=yes/);
});
