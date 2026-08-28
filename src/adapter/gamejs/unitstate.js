// Runs inside Civ 7. Where one unit actually is, after the engine has applied what it was told.
//
// `civ move` answered "ok" and nothing else. In Civ a move order spends what movement the unit
// has and then stops — a three-tile order on a two-move scout ends one tile short, and continues
// next turn. An agent that only sees "ok" cannot tell arrival from a partial move, and one spent
// its turn writing "I need to look into movement mechanics, possibly considering how movement
// only consumes one tile" instead of playing.
const unit = findOwnUnit(PLAYER_ID, UNIT_ID);
if (!unit) return { error: `you have no unit ${UNIT_ID}` };

const location = unit.location ?? {};
return {
  id: String(UNIT_ID),
  at: location.x === undefined ? null : `${location.x},${location.y}`,
  moves: unit.Movement?.movementMovesRemaining ?? null,
  maxMoves: unit.Movement?.maxMoves ?? null,
  hasMoved: unit.hasMoved ?? null,
  canMove: unit.canMove ?? null,
};
