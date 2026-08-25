// Runs inside Civ 7. Ends PLAYER_ID's turn, and says why when it cannot.
//
// GameContext.sendTurnComplete() is SILENTLY IGNORED when the game would not let a human end
// their turn. It returns nothing and throws nothing, so the old version called it, reported ok,
// and left the seat active forever — the match then waited for a turn that never advanced.
//
// The game's own panel-action.ts gates the same call behind canEndTurn(), which is false when:
//   1. a notification blocks the end of turn, or
//   2. any unit still has moves left (showRemainingMovesState).
//
// Rule 2 is the one that caught us: a scout whose AUTOMATE_EXPLORE was refused kept 2 moves, and
// nothing anywhere said that this was what held the turn open.
const player = Players.get(PLAYER_ID);

/** Units that still have moves. The game will not end a turn while any of these exist. */
function idleUnits() {
  const idle = [];
  for (const cid of player?.Units?.getUnitIds?.() ?? []) {
    const unit = Units.get(cid);
    if (!unit) continue;
    // The game's own rule, from panel-action.ts showRemainingMovesState():
    //   return unit != null && unit.canMove && !unit.hasMoved;
    // It blocks on a unit that has NOT MOVED AT ALL, not on any unit with moves left. We used the
    // stricter test, so a scout that moved one tile of three blocked our end-turn while a human's
    // would have ended — costing a wasted `civ skip` per partially-moved unit, every turn.
    const canMove = unit.Movement?.canMove ?? (unit.Movement?.movementMovesRemaining ?? 0) > 0;
    const hasMoved = unit.Movement?.hasMoved ?? unit.hasMoved ?? false;
    if (canMove && !hasMoved) {
      idle.push({ id: String(cid.id ?? cid), moves: unit.Movement?.movementMovesRemaining ?? 0 });
    }
  }
  return idle;
}

let blocking = endTurnBlocker(PLAYER_ID)?.name ?? null;
let idle = idleUnits();

// A forced end-turn means "end it anyway", so clear both things the game gates on.
//
// Skipping idle units was not enough: a seat sat blocked on NOTIFICATION_DISCOVER_NATURAL_WONDER
// with every unit already parked, and the round waited on a turn that nothing was going to end.
if (FORCED === true) {
  for (const unit of idle) {
    const found = findOwnUnit(PLAYER_ID, unit.id);
    if (!found) continue;
    try { Game.UnitOperations.sendRequest(found.id, UnitOperationTypes.SKIP_TURN, {}); } catch { /* keep going */ }
  }
  idle = idleUnits();

  // Dismiss whatever is holding the turn. Bounded, and NOT gated on re-reading the blocker:
  // dismissal is applied asynchronously, so the blocking name is unchanged immediately after and
  // a loop that trusts it stops on its first pass. Dismiss what the game names, then move on and
  // let sendTurnComplete be the judge.
  for (let attempt = 0; attempt < 8; attempt++) {
    const blocker = endTurnBlocker(PLAYER_ID);
    if (!blocker?.id) break;
    try { Game.Notifications.dismiss(blocker.id); } catch { break; }
  }
}

// A forced end-turn does not report "cannot": it clears what it can and tries anyway. Only an
// agent's own end-turn gets told why it is blocked, because only an agent can act on the reason.
if (FORCED !== true && (blocking || idle.length > 0)) {

  const why = blocking
    ? `the game is waiting on ${blocking}`
    : `${idle.length} unit${idle.length === 1 ? "" : "s"} still ${idle.length === 1 ? "has" : "have"} moves: ` +
      idle.map((u) => `${u.id} (${u.moves})`).join(", ");
  return {
    ok: false,
    code: "CANNOT_END_TURN",
    message: `your turn cannot end yet: ${why}`,
    // Name a command that exists. The previous wording said "deal with the notification" while
    // the harness had no way to deal with one, and an agent burned a whole turn hunting for it.
    hint: blocking
      ? "run `civ dismiss` to clear it, or `civ open <id>` with an id from /current/pending.txt"
      : "give every unit an order — `civ move`, `civ skip`, or fortify — then end your turn",
    blocking,
    idle,
  };
}

const before = Game.turn;
try {
  // The UI deselects first; a selected unit can hold the turn open. `typeof` rather than optional
  // chaining, because `UI?.x` still throws when UI is not declared at all.
  if (typeof UI !== "undefined") UI?.Player?.deselectAllUnits?.();
  GameContext.sendTurnComplete();
} catch (err) {
  return { ok: false, code: "END_TURN_FAILED", message: String(err), blocking };
}

// Confirm the engine accepted it rather than assuming. This is the check whose absence let a
// silent refusal read as success.
//
// hasSentTurnComplete() alone is not enough: it also reads false once the turn has already
// advanced, which is the success case. So only call it a refusal when NOTHING moved — the flag is
// clear, the turn number is unchanged, and this player is somehow still the active one.
let sent = null;
try { sent = GameContext.hasSentTurnComplete(); } catch { sent = null; }
const advanced = Game.turn !== before;
const stillActive = Players.get(PLAYER_ID)?.isTurnActive === true;
if (sent === false && !advanced && stillActive) {
  return {
    ok: false,
    code: "END_TURN_REFUSED",
    message: "the game did not accept the end of your turn and gave no reason",
    hint: "run `civ what-can` on each unit, and check /current/pending.txt",
    blocking,
  };
}
return { ok: true, turnBefore: before, blocking };
