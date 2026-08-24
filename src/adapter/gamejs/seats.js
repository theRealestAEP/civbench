// Runs inside Civ 7. Which major players are actually human-controlled?
//
// The setup summary is not proof: a single-player host reports the human slots you asked for and
// then converts all but one back to AI at load. This is the check that catches that
// (docs/FINDINGS.md).
const majors = [];
for (const p of Players.getAlive()) {
  if (!p.isMajor) continue;
  majors.push({ id: p.id, human: Players.isHuman(p.id) === true, active: p.isTurnActive === true });
}
return { localPlayer: GameContext.localPlayerID, turn: Game.turn, majors };
