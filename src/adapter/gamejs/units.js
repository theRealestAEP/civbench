// Runs inside Civ 7. Returns units PLAYER_ID may legitimately see (docs/PLAN.md §7).
//   - own units: full detail
//   - foreign units: only on plots currently VISIBLE to this player, and only what the map shows
const VISIBLE = RevealedStates.VISIBLE;

const describe = (unit, own) => {
  const loc = unit.location ?? {};
  const base = {
    id: String(unit.id?.id ?? unit.id),
    owner: unit.owner,
    type: shortName(typeName("Units", unit.type)),
    x: loc.x ?? null,
    y: loc.y ?? null,
    damage: unit.Health?.damage ?? null,
    maxDamage: unit.Health?.maxDamage ?? null,
  };
  if (!own) return base;
  return {
    ...base,
    name: locText(unit.name ?? null),
    movesRemaining: unit.Movement?.movementMovesRemaining ?? null,
    canMove: unit.Movement?.canMove ?? null,
    experience: unit.Experience?.experiencePoints ?? null,
    isCommander: unit.isCommanderUnit ?? false,
    armyId: idOrNull(unit.armyId),
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
