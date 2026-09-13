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
  // A standing order can PAUSE. Auto-explore stops beside a discovery and a queued path stops when
  // it is blocked, and the engine then asks for a decision from that unit exactly as it would
  // from an idle one. The dump called such a unit busy — "does not need orders from you" — so
  // agents read past it, and end-turn was refused on it in 23 of one run's 46 turns. The engine's
  // own end-of-turn rule decides: a unit that holds the turn open needs orders, busy or not.
  // Plus the unit the engine will not skip but still waits on — awake, unmoved, built this turn
  // (awaitingOrders) — only while the end of the turn is actually blocked on a unit.
  const needsOrders = holdsTurnOpen(unit.id) || (turnWaitsOnUnits && awaitingOrders(unit.id));
  const busy = (activity === "operation" || unit.hasPendingOperations === true) && !needsOrders;

  let canFound = false;
  try {
    canFound = Game.UnitOperations.canStart(unit.id, UnitOperationTypes.FOUND_CITY, {}, false)?.Success === true;
  } catch { canFound = false; }

  // Commanders and the units packed into them, read the way the army-commander flag reads
  // them (army-commander-flags.ts): the army's count against its capacity, and who is in it.
  // armyId is a component id, which describeAll drops, so the line said nothing about armies.
  const army = {};
  try {
    const self = String(unit.id?.id ?? unit.id);
    if (unit.isCommanderUnit === true) {
      army.commander = true;
      const a = unit.armyId ? Armies.get(unit.armyId) : null;
      if (a) {
        army.army_units = Math.max(0, (a.unitCount ?? 1) - 1);
        army.army_capacity = a.combatUnitCapacity ?? null;
        const members = (a.getUnitIds?.() ?? []).map((c) => String(c?.id ?? c)).filter((i) => i !== self);
        if (members.length > 0) army.army_members = members.join(";");
      }
    } else if (unit.armyId) {
      const a = Armies.get(unit.armyId);
      const commander = (a?.getUnitIds?.() ?? []).map((c) => Units.get(c)).find((u) => u?.isCommanderUnit === true);
      if (commander) army.packed_in = String(commander.id?.id ?? commander.id);
    }
  } catch { /* no army API in this build */ }
  return {
    ...base,
    name: locText(unit.name ?? null),
    ...withAliases(describeAll(unit)),
    ...strength,
    // `orders` is what a human reads off the unit's banner. `busy` is the one that matters: a
    // busy unit will refuse everything until it finishes, and does not need orders from you.
    orders: activity && activity !== "awake" && activity !== "none" ? activity : null,
    busy,
    needsOrders,
    canFoundHere: canFound,
    ...army,
  };
};

const own = [];
const player = Players.get(PLAYER_ID);
const turnWaitsOnUnits = waitingOnUnits(PLAYER_ID);
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
