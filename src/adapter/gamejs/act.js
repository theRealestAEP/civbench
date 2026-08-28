// Runs inside Civ 7. Executes one action for one player (docs/PLAN.md §10).
//
// The engine call itself lives in _prelude.js as startOperation(), because build.js needs the
// identical validate-then-send contract. The Match Server turns the result into the structured
// { ok, code, message, hint } an agent sees.
if (KIND === "unit_operation" || KIND === "unit_command") {
  const unit = findOwnUnit(PLAYER_ID, TARGET_ID);
  // "not found" reads like a harness bug, so say what most likely happened. Founding a city
  // consumes the settler, and the new city reuses the same number — Civ ids are unique per type,
  // not globally — so an agent sees 65536 succeed and then 65536 "not found" one action later.
  if (!unit) {
    return {
      ok: false,
      code: "NO_SUCH_UNIT",
      message: `you have no unit ${TARGET_ID} — it was probably consumed or killed`,
      hint: `settlements share numbers with units; your live units are in /current/units.txt`,
    };
  }
  // WAIT_FOR never reaches the engine. Three identical SIGSEGVs (null deref on the engine's
  // AsyncWorker1, same six stack frames each time) each came 1-3 seconds after a WAIT_FOR sent
  // during an end-turn refusal loop — it was the only mutation consistently delivered before
  // every crash. And the operation buys an agent nothing: it defers the unit in the UI's
  // unit-cycling queue, which agents do not use — they already issue commands in their own
  // order. Acknowledge the intent; skip the call that kills the game.
  if (KIND === "unit_operation" && /WAIT_FOR/.test(String(ACTION_TYPE))) {
    return {
      ok: true,
      note:
        `noted — unit ${TARGET_ID} stays available for orders later this turn. Waiting does NOT ` +
        `finish it: \`civ skip ${TARGET_ID}\` does, when it is holding your turn open.`,
    };
  }
  const api = KIND === "unit_operation" ? Game.UnitOperations : Game.UnitCommands;
  const result = startOperation(api, unit.id, operationValue(KIND, ACTION_TYPE), ARGS);

  // Asking for a state the unit is already in is not a failure.
  //
  // The engine refuses SKIP_TURN for a unit that has already been given orders, has spent its
  // moves, or is busy with a queued operation — including the unit our own end-turn hint once
  // told the agent to skip. `state.finished` is set by startOperation when it recognised one of
  // those states, so this matches a machine flag rather than the English message text (which
  // silently broke the aliasing the last time the wording changed). Handled here rather than in
  // the CLI so the event log records what actually happened.
  if (!result.ok && /SKIP_TURN/.test(String(ACTION_TYPE)) && result.state?.finished === true) {
    return {
      ok: true,
      note: `unit ${TARGET_ID} does not need orders this turn — ${result.message}`,
    };
  }

  // Out of moves is the commonest silent refusal, and the engine reports no reason for it. Say
  // the unit's state so the agent stops looking for the answer in its arguments.
  // Only when the engine gave no reason of its own.
  //
  // This used to append the unit's moves to EVERY failure and, at 0 moves, assert "it can act
  // again next turn". A founder refused because the plot sits too close to another city was told
  // to wait — so it waited, retried next turn, and failed again for the same real reason, which
  // was sitting in result.message all along.
  if (!result.ok && !result.message) {
    const moves = unit.Movement?.movementMovesRemaining ?? null;
    if (moves !== null) result.message = `the game refused this action (unit ${TARGET_ID} has ${moves} moves left)`;
  }
  // No state claim here, deliberately.
  //
  // The engine applies a request ASYNCHRONOUSLY, so anything read back on this line is the state
  // before the action. Reporting it caused the worst agent error of the project: after founding a
  // city the settler still looked alive with 3 moves, the harness said so, and the agent tried to
  // found a second city with a unit the game had already consumed.
  //
  // The files under /current are the truth. They are refreshed once the engine has caught up.
  return result;
}

if (KIND === "city_operation" || KIND === "city_command") {
  const city = findOwnCity(PLAYER_ID, TARGET_ID);
  if (!city) return { ok: false, code: "NO_SUCH_CITY", message: `settlement ${TARGET_ID} not found for p${PLAYER_ID}` };
  const api = KIND === "city_operation" ? Game.CityOperations : Game.CityCommands;
  const result = startOperation(api, city.id, operationValue(KIND, ACTION_TYPE), ARGS);
  // BUILD is the one action whose arguments cannot be guessed, and the engine gives no reason
  // when they are wrong. Answer the question the agent was actually asking.
  if (!result.ok && ACTION_TYPE === "CITYOPERATION_BUILD") {
    result.hint = `name what to build: \`civ build ${TARGET_ID} <THING>\`, or \`civ build ${TARGET_ID}\` for the list.`;
  }
  return result;
}

if (KIND === "player_operation") {
  return startOperation(Game.PlayerOperations, PLAYER_ID, operationValue(KIND, ACTION_TYPE), ARGS);
}

return { ok: false, code: "UNKNOWN_KIND", message: `unknown action kind: ${KIND}` };
