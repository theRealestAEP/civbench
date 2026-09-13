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
    // Takes the player id (screen-legends-report.ts); called bare it was null every turn.
    canTransition: m.canTransitionToNextAge?.(PLAYER_ID) ?? null,
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
/** VICTORY_DOMINATION for its hash. The table's lookup did not answer by hash here; its rows do. */
function victoryName(hash) {
  const direct = typeName("Victories", hash);
  if (direct) return direct;
  try {
    for (const row of GameInfo.Victories ?? []) {
      if (row?.$hash === hash) return row.VictoryType;
    }
  } catch { /* fall through */ }
  return String(hash);
}

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
      // What earns points, in the game's words ("Build 7 World Wonders."). Agents reasoned
      // about this in 40 turns and read LegacyPaths.json 32 times.
      out.push({ type: shortName(type), score, target, does: locText(path.Description ?? null) || null });
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
    if (!def) return null;
    // Turns to finish — model-tech-tree.ts: player.Techs.getTurnsForNode(nodeType). One arg.
    let turnsLeft = null;
    try { turnsLeft = tree.getTurnsForNode?.(active.type) ?? null; } catch { turnsLeft = null; }
    return { node: def.ProgressionTreeNodeType, progress: active.progress ?? null, turnsLeft };
  } catch { return null; }
}

/**
 * Military power: the combat strength of this player's units, summed.
 *
 * Civ has no single "military might" on the player object, but the diplo ribbon a human watches
 * conveys the same idea, and the parts are on each unit — the melee or ranged strength units.js
 * already reads. Sum them for a stat the standings page can compare across seats.
 */
const militaryStrength = (() => {
  let total = 0;
  try {
    for (const id of p.Units?.getUnitIds?.() ?? []) {
      const unit = Units.get(id);
      const combat = unit?.Combat;
      if (!combat) continue;
      const melee = combat.getMeleeStrength?.(false) ?? 0;
      const ranged = combat.rangedStrength ?? 0;
      total += Math.max(typeof melee === "number" ? melee : 0, typeof ranged === "number" ? ranged : 0);
    }
  } catch { return total; }
  return total;
})();

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
  // The influence STOCKPILE the top bar shows (panel-yield-banner.ts: DiplomacyTreasury). The
  // header carried only the per-turn yield, and every diplomatic action spends the stockpile.
  influence: p.DiplomacyTreasury?.diplomacyBalance ?? null,
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
  militaryStrength,
  // Arg-less/correct-arity reads mirrored from the game's own advice code. getNumWonders is
  // deliberately omitted: its signature is getNumWonders(originalConstructor, currentAgeOnly) and a
  // wrong-arity native call segfaults, which is what crashed the UI before.
  greatWorks: (() => { try { return p.Stats?.getTotalGreatWorksSlotted?.() ?? null; } catch { return null; } })(),
  conqueredSettlements: (() => { try { return p.Stats?.getNumConqueredSettlements?.(true, true, true, false) ?? null; } catch { return null; } })(),
  religionFounded: (() => { try { return p.Religion?.hasCreatedReligion?.() ?? null; } catch { return null; } })(),
  tradeRoutes: (() => { try { return p.Trade?.countPlayerTradeRoutes?.() ?? null; } catch { return null; } })(),
  legacy,
  // The victory manager's own progress for this team (victory-manager.ts getVictoryProgress).
  // Legacy paths were disabled for a whole night's match and every legacy score read 0 while
  // domination stood at 8 of 13 settlements; this is the number that actually decides the game.
  victories: (() => {
    try {
      const team = p.team ?? PLAYER_ID;
      return (Game.VictoryManager?.getVictoryProgress?.() ?? [])
        .filter((v) => v?.team === team)
        .map((v) => ({ type: victoryName(v.victory), current: v.current ?? 0, total: v.total ?? 0 }))
        .filter((v) => v.total > 0);
    } catch { return []; }
  })(),
  // The name. getGovernmentType returns a hash, and it was reaching header.json unresolved.
  government: typeName("Governments", p.Culture?.getGovernmentType?.()) ?? null,
};
