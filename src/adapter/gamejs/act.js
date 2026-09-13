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
  // A move modifier by name — "ATTACK", "MOVE_IGNORE_UNEXPLORED_DESTINATION" — becomes the
  // engine's own value, the way the game's move mode sends it.
  let args = ARGS;
  if (typeof ARGS?.Modifiers === "string" && typeof UnitOperationMoveModifiers !== "undefined" &&
      UnitOperationMoveModifiers[ARGS.Modifiers] !== undefined) {
    args = { ...ARGS, Modifiers: UnitOperationMoveModifiers[ARGS.Modifiers] };
  }
  // A move the engine cannot path is accepted and never carried out: 363 such orders in one run,
  // every one reported "ok" and then contradicted, and each one left a dead entry in the unit's
  // queue — the pattern under every observed engine crash. The game's own UI asks the engine for
  // the path first (Units.getPathTo, as trade-route-chooser.ts does). Ask the same and refuse
  // up front, with the reason a human would see on the map.
  let eta = null;
  if (KIND === "unit_operation" && /MOVE_TO/.test(String(ACTION_TYPE)) && args?.X !== undefined && args?.Y !== undefined) {
    const x = Number(args.X);
    const y = Number(args.Y);
    // A plain move onto another civilization's unit. The path exists, the engine accepts the
    // order, and nothing happens: one agent sent its slinger at an enemy scout's tile three
    // times in a turn and was told only DID_NOT_MOVE each time, while the scout was on its own
    // map. Only a VISIBLE unit is named — what the fog hides stays hidden — and an attack is a
    // move with the attack modifier, so that goes through.
    const attacking = typeof UnitOperationMoveModifiers !== "undefined" && args.Modifiers === UnitOperationMoveModifiers.ATTACK;
    const holder = attacking ? null : foreignUnitAt(PLAYER_ID, x, y);
    if (holder) {
      let atWar = false;
      try { atWar = Players.get(PLAYER_ID)?.Diplomacy?.isAtWarWith?.(holder.owner) === true; } catch { atWar = false; }
      return {
        ok: false,
        code: "TILE_OCCUPIED",
        message: `${x},${y} holds a ${holder.type ?? "unit"} of p${holder.owner} — units of two civilizations cannot share a tile`,
        hint: atWar
          ? `you are at war with p${holder.owner}: \`civ attack ${TARGET_ID} ${x},${y}\` attacks it; otherwise pick another tile`
          : `you are not at war with p${holder.owner}; pick another tile, or wait for it to move`,
      };
    }
    let path = null;
    try { path = Units.getPathTo?.(unit.id, { x, y }) ?? null; } catch { path = null; }
    if (path && Array.isArray(path.plots) && path.plots.length === 0) {
      const at = unit.location ?? {};
      // Name the tile. "Water, mountains, or a tile it may not enter" was every refusal's text,
      // and agents retried the identical move: six of one run's thirteen NO_PATH refusals were
      // repeats. The map knows what the tile is, so say it.
      const tile = plotDescription(PLAYER_ID, x, y, at);
      return {
        ok: false,
        code: "NO_PATH",
        message: `unit ${TARGET_ID} has no path from ${at.x},${at.y} to ${x},${y} — ` +
          (tile === null
            ? `the way is impassable for it (water for a land unit, mountains, or a tile it may not enter)`
            : `${x},${y} is ${tile}`),
        hint: `\`civ near ${TARGET_ID} 3\` lists the tiles around it with their move costs; pick one it can reach`,
      };
    }
    const turns = Array.isArray(path?.turns) ? path.turns[path.turns.length - 1] : null;
    if (typeof turns === "number" && turns > 0) eta = turns;
  }
  const result = startOperation(api, unit.id, operationValue(KIND, ACTION_TYPE), args, String(ACTION_TYPE));
  if (result.ok && eta !== null) result.eta = eta;

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
  // A skip the engine refuses WITHOUT a reason is a unit that is not waiting for orders: a skip
  // exists only to satisfy the end of the turn, and the engine takes it from exactly the units
  // holding the turn open. 232 such refusals in one run — every one a unit already on hold —
  // and each read as a failure to fix. There is nothing to fix.
  if (!result.ok && /SKIP_TURN/.test(String(ACTION_TYPE)) && result.bare === true) {
    // Unless the engine is waiting on a unit and this one is awake and unmoved: a unit built
    // this turn cannot be skipped and still holds the turn. "Needs no skip — leave it" was told
    // to the agent 33 times about exactly the unit that was blocking it. Sleep or fortify it
    // if the engine allows; otherwise say plainly that only a move will do.
    if (waitingOnUnits(PLAYER_ID) && awaitingOrders(unit.id)) {
      const sent = settleUnit(unit.id, false);
      if (sent) {
        return { ok: true, note: `the game would not skip unit ${TARGET_ID}, so it was given ${sent} instead — that lasts until you wake it (\`civ do unit-cmd ${TARGET_ID} UNITCOMMAND_WAKE\`)` };
      }
      const moves = unit.Movement?.movementMovesRemaining ?? "?";
      return {
        ok: false,
        code: "SKIP_REFUSED",
        message: `the game will not skip, sleep or fortify unit ${TARGET_ID}, yet it is awake with ${moves} moves, has not moved, and the turn is waiting on a unit. A unit built this turn does this; the one order the engine takes from it is a move.`,
        hint: `\`civ move ${TARGET_ID} <x,y>\` to a tile beside it — \`civ near ${TARGET_ID} 1\` lists them`,
      };
    }
    return {
      ok: true,
      note: `unit ${TARGET_ID} is not holding your turn open, so it needs no skip — leave it`,
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
