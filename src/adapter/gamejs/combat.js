// Runs inside Civ 7. Combat preview before committing to an attack (docs/PLAN.md §7).
//
// The UI shows a human the predicted damage in both directions before they attack. Denying an
// agent that is a straight handicap — it would be attacking blind in a benchmark configured for
// military victory.
//
// Two parts, because the engine splits them:
//   testAttackInto      synchronous; says whether an attack is possible and melee vs ranged
//   simulateAttackAsync fires a query whose results arrive later on the "SimulateCombatResult"
//                       engine event, so we stash them on a global and read them on a second call
const unit = findOwnUnit(PLAYER_ID, UNIT_ID);
if (!unit) return { error: `unit ${UNIT_ID} not found for p${PLAYER_ID}` };

const args = { X: TARGET_X, Y: TARGET_Y, Location: { x: TARGET_X, y: TARGET_Y } };

// Install the result catcher once per page, not once per call.
if (!globalThis.__civbenchCombat) {
  globalThis.__civbenchCombat = { last: null };
  try {
    engine.on("SimulateCombatResult", (results) => {
      globalThis.__civbenchCombat.last = results;
    });
  } catch (err) {
    globalThis.__civbenchCombat.error = String(err);
  }
}

if (MODE === "read") {
  const last = globalThis.__civbenchCombat.last;
  return last ? { ready: true, results: last } : { ready: false };
}

let combatType = null;
try {
  combatType = Game.Combat.testAttackInto(unit.id, args);
} catch (err) {
  return { error: "testAttackInto failed: " + String(err) };
}

const NAMES = { [CombatTypes.NO_COMBAT]: "none", [CombatTypes.COMBAT_MELEE]: "melee", [CombatTypes.COMBAT_RANGED]: "ranged" };
const kind = NAMES[combatType] ?? String(combatType);

if (combatType === CombatTypes.NO_COMBAT) {
  return { possible: false, kind, reason: "no attack is possible into that plot from here" };
}

// Ask the engine to work out the damage. The answer lands on the event above.
globalThis.__civbenchCombat.last = null;
try {
  Game.Combat.simulateAttackAsync(unit.id, { ...args, CombatType: combatType });
} catch (err) {
  return { possible: true, kind, simulated: false, error: String(err) };
}
return { possible: true, kind, simulated: true };
