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

/**
 * Legacy progress, with the number it is measured against.
 *
 * This used to report `military 3` and nothing else. Three out of what? The briefing tells every
 * agent to win its Age and then hid the target. A human sees milestone pips and required points.
 * The total comes the same way model-age-rankings.ts computes it: sum the progression points of
 * every milestone on that path.
 */
const legacy = (() => {
  // Iterate GameInfo.LegacyPaths, the way the game's own victory manager does.
  //
  // This used to rely on getEnabledLegacyPaths(), which returns an empty list here — so the HUD
  // printed "legacy: none" on every turn of every run, in a benchmark whose stated goal is
  // winning the Age. Two further faults were hidden behind that: the target was matched by
  // comparing a milestone's LegacyPathType (a STRING) against a hash, so it could never resolve;
  // and it summed age-progression points rather than the milestone's own RequiredPathPoints.
  //
  // victory-manager.ts: score with `player.LegacyPaths.getScore(d.LegacyPathType)` — the STRING —
  // and take the target from the FinalMilestone's RequiredPathPoints.
  const out = [];
  try {
    for (const path of GameInfo.LegacyPaths ?? []) {
      const type = path.LegacyPathType;
      if (!type) continue;
      if (path.EnabledByDefault === false) continue;
      let score = null;
      try { score = p.LegacyPaths?.getScore?.(type) ?? null; } catch { score = null; }
      let target = null;
      try {
        for (const milestone of GameInfo.AgeProgressionMilestones ?? []) {
          if (milestone.LegacyPathType !== type) continue;
          if (!milestone.FinalMilestone) continue;
          target = milestone.RequiredPathPoints ?? null;
          break;
        }
      } catch { target = null; }
      out.push({ type: shortName(type), score, target });
    }
  } catch { return []; }
  return out;
})();

/** What this player is researching and adopting, by name. A human has both permanently on screen. */
function treeNode(tree) {
  try {
    const active = tree?.getResearching?.();
    if (!active || active.type === undefined) return null;
    const def = GameInfo.ProgressionTreeNodes.lookup(active.type);
    return def ? { node: def.ProgressionTreeNodeType, progress: active.progress ?? null } : null;
  } catch { return null; }
}

return {
  researching: treeNode(p?.Techs),
  adopting: treeNode(p?.Culture),
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
  // A PLAYER has no Happiness component — that is a city thing. The player's figure is a yield,
  // and it was sitting in the same object the whole time: the HUD printed "happiness ?" on every
  // turn of every run while `yields.happiness` held the number.
  happiness: {
    net: yieldOf("YIELD_HAPPINESS"),
    hasUnrest: p.Stats?.hasUnrest ?? null,
    turnsOfUnrest: p.Stats?.turnsOfUnrest ?? null,
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
  // The name. getGovernmentType returns a hash, and it was reaching header.json unresolved.
  government: typeName("Governments", p.Culture?.getGovernmentType?.()) ?? null,
};
