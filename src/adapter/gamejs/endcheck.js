// Runs inside Civ 7. Did PLAYER_ID's end-turn actually take?
//
// endturn.js reads these flags on the line after sendTurnComplete(), which is before the engine
// has applied anything — the read-after-mutation mistake. The Match Server polls THIS a moment
// later instead: a seat that is still the active player with the sent flag clear and the turn
// unmoved has had its end-turn silently refused. Reporting that "ok" stalled rounds for four
// minutes at a time and charged the forced end to an innocent seat.
let sent = null;
try { sent = GameContext.hasSentTurnComplete(); } catch { sent = null; }
let active = null;
try { active = Players.get(PLAYER_ID)?.isTurnActive === true; } catch { active = null; }
const blocker = endTurnBlocker(PLAYER_ID);
return {
  turn: Game.turn,
  sent,
  active,
  blocking: blocker?.name ?? null,
};
