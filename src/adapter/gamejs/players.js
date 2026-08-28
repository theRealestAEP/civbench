// Runs inside Civ 7. What PLAYER_ID knows about the other players (docs/PLAN.md §7).
//
// A human has the diplomacy ribbon on screen at all times: every met rival's yields, how many
// settlements they hold, their score, and how they feel about you. Ours carried five fields, so no
// agent could tell whether it was winning, who was running away with the game, or whether a war
// would find support. In an Age race that is the most important thing on the screen.
//
// Everything here is from model-diplo-ribbon.ts, which is what the human is looking at. It is
// parity, not an assist — and it applies only to civs this player has MET.
const me = Players.get(PLAYER_ID);
const myDiplomacy = me?.Diplomacy;

/** A rival's net yield, the same call the ribbon makes. */
function netYield(player, name) {
  try {
    const type = YieldTypes?.[name];
    return type === undefined ? null : player.Stats?.getNetYield?.(type) ?? null;
  } catch { return null; }
}

/**
 * A rival's legacy score per path, as victory-manager.ts shows it for every MET player.
 *
 * Gated on having met them, like everything else here — the caller only reaches this for civs
 * this player knows.
 */
function legacyOf(other) {
  const out = [];
  try {
    for (const path of GameInfo.LegacyPaths ?? []) {
      const type = path.LegacyPathType;
      if (!type || path.EnabledByDefault === false) continue;
      const score = other.LegacyPaths?.getScore?.(type) ?? null;
      if (score) out.push(`${shortName(type)}${score}`);
    }
  } catch { return null; }
  return out.length > 0 ? out.join(",") : null;
}

/** Whether a war would find support, the number the ribbon prints on each civ's card. */
function warSupport(otherId, forMe) {
  try {
    return forMe
      ? myDiplomacy?.getTotalWarSupportBonusForPlayer?.(otherId) ?? null
      : myDiplomacy?.getTotalWarSupportBonusForTarget?.(otherId) ?? null;
  } catch { return null; }
}

const out = [];
for (const other of Players.getAlive()) {
  if (other.id === PLAYER_ID) continue;
  const met = myDiplomacy?.hasMet?.(other.id) ?? false;
  if (!met) continue;

  let relationship = null;
  try {
    relationship = locText(myDiplomacy?.getRelationshipLevelName?.(other.id) ?? null);
  } catch { relationship = null; }

  out.push({
    id: other.id,
    civ: locText(other.civilizationName ?? other.civilizationType ?? null),
    leader: locText(other.leaderName ?? other.leaderType ?? null),
    isHuman: Players.isHuman?.(other.id) ?? null,
    isMajor: other.isMajor ?? null,
    atWar: myDiplomacy?.isAtWarWith?.(other.id) ?? false,
    suzerain: other.Influence?.getSuzerain?.() ?? null,
    relationship,
    // How they are doing. The ribbon shows all of this for every met civ.
    gold: netYield(other, "YIELD_GOLD"),
    science: netYield(other, "YIELD_SCIENCE"),
    culture: netYield(other, "YIELD_CULTURE"),
    happiness: netYield(other, "YIELD_HAPPINESS"),
    diplomacy: netYield(other, "YIELD_DIPLOMACY"),
    settlements: other.Stats?.numSettlements ?? null,
    settlementCap: other.Stats?.settlementCap ?? null,
    // How close they are to winning, and whether a war against them would find support.
    //
    // The ribbon shows both for every met civ. Without them an agent could see who had the bigger
    // economy and not who was closer to winning, and could not judge a war before starting one —
    // in a benchmark scored on winning the Age.
    legacy: legacyOf(other),
    warSupportForMe: warSupport(other.id, true),
    warSupportForThem: warSupport(other.id, false),
  });
}
return { me: PLAYER_ID, known: out };
