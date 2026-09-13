// Runs inside Civ 7. Which major players are actually human-controlled?
//
// The setup summary is not proof: a single-player host reports the human slots you asked for and
// then converts all but one back to AI at load. This is the check that catches that
// (docs/FINDINGS.md).
const majors = [];
for (const p of Players.getAlive()) {
  if (!p.isMajor) continue;
  majors.push({ id: p.id, human: Players.isHuman(p.id) === true, active: p.isTurnActive === true, alive: true });
}
// An ELIMINATED seat is not among the alive players, yet hotseat still hands it the turn: the
// engine marks it active and waits for its end-turn, with a defeat screen up. A harness that
// only reads the living saw no active seat at all and waited at turn 58 for forty minutes.
// Name the seats the caller cares about that the game no longer counts as alive.
if (typeof SEAT_IDS !== "undefined" && Array.isArray(SEAT_IDS)) {
  for (const id of SEAT_IDS) {
    if (majors.some((m) => m.id === id)) continue;
    const p = Players.get(id);
    if (!p) continue;
    majors.push({ id, human: Players.isHuman(id) === true, active: p.isTurnActive === true, alive: p.isAlive === true });
  }
}
return { localPlayer: GameContext.localPlayerID, turn: Game.turn, majors };
