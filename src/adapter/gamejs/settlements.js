// Runs inside Civ 7. Settlements PLAYER_ID may legitimately see (docs/PLAN.md §7).
// Own settlements get full detail. Foreign ones are limited to what the map reveals.
const VISIBLE = RevealedStates.VISIBLE;

const own = [];
const player = Players.get(PLAYER_ID);
for (const id of player?.Cities?.getCityIds?.() ?? []) {
  const city = Cities.get(id);
  if (!city) continue;
  const loc = city.location ?? {};
  own.push({
    id: String(city.id?.id ?? city.id),
    name: locText(city.name ?? null),
    kind: city.isTown ? "town" : "city",
    isCapital: city.isCapital ?? false,
    x: loc.x ?? null,
    y: loc.y ?? null,
    population: city.population ?? null,
    growthType: city.Growth?.growthType ?? null,
    currentFood: city.Growth?.currentFood ?? null,
    projectType: city.Growth?.projectType ?? null,
    productionTurnsLeft: city.BuildQueue?.getTurnsLeft?.() ?? null,
    productionHash: city.BuildQueue?.currentProductionTypeHash ?? null,
    queueEmpty: city.BuildQueue?.isEmpty ?? null,
    happiness: city.Happiness?.netHappinessPerTurn ?? null,
    hasUnrest: city.Happiness?.hasUnrest ?? null,
    beingRazed: city.isBeingRazed ?? false,
    distantLands: city.isDistantLands ?? false,
  });
}

const foreign = [];
for (const other of Players.getAlive()) {
  if (other.id === PLAYER_ID) continue;
  for (const id of other.Cities?.getCityIds?.() ?? []) {
    const city = Cities.get(id);
    const loc = city?.location;
    if (!city || !loc) continue;
    // Only settlements on a plot this player has revealed. The dump layer decides whether the
    // record is current or remembered, using the vis flag.
    const vis = GameplayMap.getRevealedState(PLAYER_ID, loc.x, loc.y);
    if (vis === RevealedStates.HIDDEN) continue;
    foreign.push({
      id: String(city.id?.id ?? city.id),
      name: locText(city.name ?? null),
      kind: city.isTown ? "town" : "city",
      owner: city.owner,
      x: loc.x,
      y: loc.y,
      isCapital: city.isCapital ?? false,
      vis: vis === VISIBLE ? 2 : 1,
    });
  }
}
return { own, foreign };
