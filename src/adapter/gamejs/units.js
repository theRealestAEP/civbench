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
    return { ...base, ...withAliases(describeAll(unit, ["Movement", "Experience"])) };
  }
  return { ...base, name: locText(unit.name ?? null), ...withAliases(describeAll(unit)) };
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
