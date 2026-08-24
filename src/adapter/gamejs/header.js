// Runs inside Civ 7. Returns the per-turn HUD facts for PLAYER_ID (docs/PLAN.md §6.3).
// Strictly mechanical: no ranking, no judgement, fixed shape every turn.
const p = Players.get(PLAYER_ID);
if (!p) return null;

const yieldOf = (name) => {
  try { return p.Stats?.getNetYield?.(YieldTypes[name]) ?? null; } catch { return null; }
};

const ageProgress = (() => {
  const m = Game.AgeProgressManager;
  if (!m) return null;
  return {
    current: m.getCurrentAgeProgressionPoints?.() ?? null,
    max: m.getMaxAgeProgressionPoints?.() ?? null,
    isFinalAge: m.isFinalAge ?? null,
    isAgeOver: m.isAgeOver ?? null,
    canTransition: m.canTransitionToNextAge?.() ?? null,
    countdownStarted: m.ageCountdownStarted ?? null,
  };
})();

const legacy = (() => {
  try {
    const paths = p.LegacyPaths?.getEnabledLegacyPaths?.() ?? [];
    return paths.map((path) => ({
      type: path.legacyPath ?? path.LegacyPathType ?? String(path),
      score: p.LegacyPaths?.getScore?.(path.legacyPath ?? path) ?? null,
    }));
  } catch { return []; }
})();

return {
  turn: Game.turn,
  maxTurns: Game.maxTurns ?? null,
  age: shortName(typeName("Ages", Game.age)) ?? Game.age,
  ageProgress,
  playerId: PLAYER_ID,
  civ: locText(p.civilizationName ?? p.civilizationType ?? null),
  leader: locText(p.leaderName ?? p.leaderType ?? null),
  isHuman: Players.isHuman?.(PLAYER_ID) ?? null,
  gold: p.Treasury?.goldBalance ?? null,
  yields: {
    food: yieldOf("YIELD_FOOD"),
    production: yieldOf("YIELD_PRODUCTION"),
    gold: yieldOf("YIELD_GOLD"),
    science: yieldOf("YIELD_SCIENCE"),
    culture: yieldOf("YIELD_CULTURE"),
    happiness: yieldOf("YIELD_HAPPINESS"),
    diplomacy: yieldOf("YIELD_DIPLOMACY"),
  },
  happiness: {
    net: p.Happiness?.netHappinessPerTurn ?? null,
    hasUnrest: p.Happiness?.hasUnrest ?? null,
    turnsOfUnrest: p.Happiness?.turnsOfUnrest ?? null,
  },
  settlements: {
    cities: p.Stats?.numCities ?? null,
    towns: p.Stats?.numTowns ?? null,
    total: p.Stats?.numSettlements ?? null,
    cap: p.Stats?.settlementCap ?? null,
    population: p.Stats?.totalPopulation ?? null,
  },
  unitCount: (p.Units?.getUnitIds?.() ?? []).length,
  legacy,
  government: p.Culture?.getGovernmentType?.() ?? null,
};
