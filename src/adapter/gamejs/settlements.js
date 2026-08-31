// Runs inside Civ 7. Settlements PLAYER_ID may legitimately see (docs/PLAN.md §7).
// Own settlements get full detail. Foreign ones are limited to what the map reveals.
const VISIBLE = RevealedStates.VISIBLE;

/** One of a city's net per-turn yields, the same call the city panel makes. */
function cityYield(city, name) {
  try {
    const type = YieldTypes?.[name];
    return type === undefined ? null : city.Yields?.getNetYield?.(type) ?? null;
  } catch { return null; }
}

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
    // The NAME, not the hash. A raw type hash in an agent-readable file is the one thing this
    // codebase forbids, and this one was surviving into settlements.jsonl on every line.
    growthType: typeName("Types", city.Growth?.growthType) ?? null,
    currentFood: city.Growth?.currentFood ?? null,
    projectType: typeName("Projects", city.Growth?.projectType) ?? null,

    // The NAME, resolved here. The raw hash used to be all the dump carried, and it survived only
    // into the JSONL — the one thing this codebase forbids showing an agent. So `prod_turns_left=3`
    // told a player its city would finish something in three turns without saying what.
    building: (() => {
      const h = city.BuildQueue?.currentProductionTypeHash;
      if (h === null || h === undefined || h === -1) return null;
      return typeName("Units", h) ?? typeName("Constructibles", h) ?? typeName("Projects", h) ?? null;
    })(),
    // Growth, as the city panel shows it: how much food, how much is needed, how long.
    //
    // foodPerTurn and the population split were read off components that do not exist, so they
    // were null on every settlement line of every run — leaving a line that says how much food is
    // needed to grow and never how much arrives. The game reads food from Yields
    // (model-city-details.ts) and the population split off the CITY, not a Population component.
    foodToGrow: city.Growth?.getNextGrowthFoodThreshold?.()?.value ?? null,
    foodPerTurn: cityYield(city, "YIELD_FOOD"),
    turnsToGrow: city.Growth?.turnsUntilGrowth ?? null,
    urbanPopulation: city.urbanPopulation ?? null,
    ruralPopulation: city.ruralPopulation ?? null,
    // What this settlement actually produces per turn. Nothing in the dump carried it, so an
    // agent could not compare two of its own cities, or tell whether a build was affordable.
    production: cityYield(city, "YIELD_PRODUCTION"),
    gold: cityYield(city, "YIELD_GOLD"),
    science: cityYield(city, "YIELD_SCIENCE"),
    culture: cityYield(city, "YIELD_CULTURE"),
    // How long what it is building will take. getTurnsLeft() with NO argument returns -1, which
    // the writer then dropped as a sentinel — so the field simply vanished from every line.
    productionTurns: city.BuildQueue?.currentTurnsLeft ?? null,
    queueEmpty: city.BuildQueue?.isEmpty ?? null,
    happiness: city.Happiness?.netHappinessPerTurn ?? null,
    hasUnrest: city.Happiness?.hasUnrest ?? null,
    // Properties (not calls) — reading them is safe. Rebellion pressure the banner shows.
    unrestTurns: city.Happiness?.turnsOfUnrest ?? null,
    warWeariness: city.Happiness?.hasWarWeariness ?? null,
    // City faith — banner majority/urban/rural. Properties on city.Religion, guarded like the game.
    religion: (() => {
      try {
        const r = city.Religion;
        if (!r) return null;
        const nm = (h) => (h === undefined || h === null ? null : typeName("Religions", h) ?? null);
        const out = { majority: nm(r.majorityReligion), urban: nm(r.urbanReligion), rural: nm(r.ruralReligion) };
        return out.majority || out.urban || out.rural ? out : null;
      } catch { return null; }
    })(),
    // Rebellion pressure the city banner shows: how many turns of unrest are queued (a revolt
    // countdown), and whether war is wearing the settlement down. Net happiness alone did not say
    // how close a settlement was to actually revolting.
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
      ...ownerIdentity(city.owner),
      x: loc.x,
      y: loc.y,
      isCapital: city.isCapital ?? false,
      vis: vis === VISIBLE ? 2 : 1,
    });
  }
}
return { own, foreign };
