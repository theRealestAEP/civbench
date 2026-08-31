// Runs inside Civ 7. Returns units PLAYER_ID may legitimately see (docs/PLAN.md §7).
//   - own units: full detail
//   - foreign units: only on plots currently VISIBLE to this player, and only what the map shows
const VISIBLE = RevealedStates.VISIBLE;

/**
 * Everything the game knows about a unit that this player is entitled to see.
 *
 * Not a hand-picked field list. Every audit of the old one found more that a human sees and an
 * agent did not — combat strength, attack range, build charges, promotion level, sight. Choosing
 * the fields means the harness decides what matters, which is the agent's job.
 *
 * Fog is applied structurally: a foreign unit is described only on a plot this player can see
 * right now, and only from what the map itself shows. Its owner's private view of it is not read.
 */
/** A rival's combat strength, which the map shows on its banner. */
function enemyStrength(unit) {
  try {
    const melee = unit.Combat?.getMeleeStrength?.(false);
    return typeof melee === "number" && melee > 0 ? { melee } : {};
  } catch { return {}; }
}

const describe = (unit, own) => {
  const loc = unit.location ?? {};
  const base = {
    id: String(unit.id?.id ?? unit.id),
    owner: unit.owner,
    type: shortName(typeName("Units", unit.type)),
    x: loc.x ?? null,
    y: loc.y ?? null,
  };
  // A rival's unit shows what the map shows: what it is, where it stands, how hurt it looks.
  if (!own) {
    return { ...base, ...ownerIdentity(unit.owner), ...withAliases(describeAll(unit, ["Movement", "Experience"])), ...enemyStrength(unit) };
  }
  // Can it found a settlement where it stands, right now?
  //
  // Every agent in every run lost turn 1 to this: they see `moves=3` and `move_cost=1`, move the
  // founder one tile, and the move spends everything — so FOUND_CITY is refused and the first
  // turn is gone. A human's UI shows the found button lit or dark before they commit. This is
  // that button.
  // Combat strength, which no unit line has ever carried.
  //
  // `Combat_meleeStrength` was in the field alias table, but melee strength is a METHOD —
  // `combat.getMeleeStrength(false)` — and describeAll drops functions, so the alias was dead and
  // the property does not exist. An agent could not compare two of its own units or judge a fight
  // without spending a separate combat-preview call. unit-actions.ts shows these for EVERY unit.
  const combat = unit.Combat;
  const strength = {};
  if (combat) {
    try {
      const melee = combat.getMeleeStrength?.(false);
      if (typeof melee === "number" && melee > 0) {
        strength[combat.canAttack ? "melee" : "defense"] = melee;
      }
    } catch { /* not a combat unit */ }
    for (const [key, field] of [["ranged", "rangedStrength"], ["bombard", "bombardStrength"], ["range", "attackRange"]]) {
      const value = combat[field];
      if (typeof value === "number" && value > 0) strength[key] = value;
    }
  }

  // What this unit is already doing.
  //
  // A unit on a multi-turn operation — auto-explore, a queued path — refuses every new order with
  // no reason the engine will give. Nothing on the unit line said so, so agents re-ordered them
  // every turn for the rest of the match: 136 refusals across 8 units in one 26-turn run, every
  // one of them the harness failing to mention that the unit was busy.
  let activity = null;
  try {
    if (typeof UnitActivityTypes !== "undefined") {
      for (const key of Object.keys(UnitActivityTypes)) {
        if (UnitActivityTypes[key] === unit.activityType) { activity = key.toLowerCase(); break; }
      }
    }
  } catch { activity = null; }
  const busy = activity === "operation" || unit.hasPendingOperations === true;

  let canFound = false;
  try {
    canFound = Game.UnitOperations.canStart(unit.id, UnitOperationTypes.FOUND_CITY, {}, false)?.Success === true;
  } catch { canFound = false; }
  return {
    ...base,
    name: locText(unit.name ?? null),
    ...withAliases(describeAll(unit)),
    ...strength,
    // `orders` is what a human reads off the unit's banner. `busy` is the one that matters: a
    // busy unit will refuse everything until it finishes, and does not need orders from you.
    orders: activity && activity !== "awake" && activity !== "none" ? activity : null,
    busy,
    canFoundHere: canFound,
  };
};

const own = [];
const player = Players.get(PLAYER_ID);
for (const id of player?.Units?.getUnitIds?.() ?? []) {
  const unit = Units.get(id);
  if (unit) own.push(describe(unit, true));
}

const foreign = [];
for (const other of Players.getAlive()) {
  if (other.id === PLAYER_ID) continue;
  for (const id of other.Units?.getUnitIds?.() ?? []) {
    const unit = Units.get(id);
    const loc = unit?.location;
    if (!unit || !loc) continue;
    if (GameplayMap.getRevealedState(PLAYER_ID, loc.x, loc.y) !== VISIBLE) continue;
    foreign.push(describe(unit, false));
  }
}
return { own, foreign };
