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
  const api = KIND === "unit_operation" ? Game.UnitOperations : Game.UnitCommands;
  const result = startOperation(api, unit.id, operationValue(KIND, ACTION_TYPE), ARGS);
  // Out of moves is the commonest silent refusal, and the engine reports no reason for it. Say
  // the unit's state so the agent stops looking for the answer in its arguments.
  if (!result.ok) {
    const moves = unit.Movement?.movementMovesRemaining ?? null;
    if (moves !== null) {
      result.message += ` (unit ${TARGET_ID} has ${moves} moves left)`;
      if (moves <= 0) result.hint = "this unit has no moves left; it can act again next turn";
    }
  }
  // Say when the unit is gone. "ok" alone had an agent found a city and immediately try to found
  // again with the same id. If the engine applies the request asynchronously the unit is still
  // here and we simply say nothing, which is the same as before.
  if (result.ok) {
    const after = findOwnUnit(PLAYER_ID, TARGET_ID);
    if (!after) {
      result.note = `unit ${TARGET_ID} is used up and no longer exists`;
    } else if (ACTION_TYPE === "UNITOPERATION_MOVE_TO") {
      // Only for moves. Spending the last move is what turns a good plan into a refused one:
      // step onto the spot you meant to settle, and founding is illegal until next turn.
      //
      // Only for moves, because the engine applies a request asynchronously. Right after
      // FOUND_CITY the settler still exists with its moves intact, so reporting them read as
      // "you can act again" and an agent immediately tried to found a second city.
      const moves = after.Movement?.movementMovesRemaining ?? null;
      if (moves !== null) {
        result.note = `unit ${TARGET_ID} has ${moves} moves left${moves <= 0 ? " — it cannot act again this turn" : ""}`;
      }
    }
  }
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
    result.hint = `name what to build: civ build ${TARGET_ID} <THING>. Run \`civ produce ${TARGET_ID}\` for the list.`;
  }
  return result;
}

if (KIND === "player_operation") {
  return startOperation(Game.PlayerOperations, PLAYER_ID, operationValue(KIND, ACTION_TYPE), ARGS);
}

return { ok: false, code: "UNKNOWN_KIND", message: `unknown action kind: ${KIND}` };
