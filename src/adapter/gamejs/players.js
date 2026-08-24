// Runs inside Civ 7. What PLAYER_ID knows about the other players (docs/PLAN.md §7).
// Limited to civs this player has met. No treasury, tech list, or production of rivals.
const me = Players.get(PLAYER_ID);
const out = [];
for (const other of Players.getAlive()) {
  if (other.id === PLAYER_ID) continue;
  const met = me?.Diplomacy?.hasMet?.(other.id) ?? false;
  if (!met) continue;
  out.push({
    id: other.id,
    civ: locText(other.civilizationName ?? other.civilizationType ?? null),
    leader: locText(other.leaderName ?? other.leaderType ?? null),
    isHuman: Players.isHuman?.(other.id) ?? null,
    isMajor: other.isMajor ?? null,
    atWar: me?.Diplomacy?.isAtWarWith?.(other.id) ?? false,
    suzerain: other.Influence?.getSuzerain?.() ?? null,
  });
}
return { me: PLAYER_ID, known: out };
