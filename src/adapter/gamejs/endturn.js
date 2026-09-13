// Runs inside Civ 7. Ends PLAYER_ID's turn, and says why when it cannot.
//
// GameContext.sendTurnComplete() is SILENTLY IGNORED when the game would not let a human end
// their turn. It returns nothing and throws nothing, so a version that just calls it reports ok,
// leaves the seat active forever, and the match waits for a turn that never advances.
//
// The game's own panel-action.ts gates the same call behind canEndTurn(), which is false when:
//   1. a notification blocks the end of turn, or
//   2. showRemainingMovesState() says a unit still needs orders.
//
// Rule 2 is ported from panel-action.ts rather than reinvented. The version that scanned every
// unit for `canMove && !hasMoved` was STRICTER THAN THE GAME: it reported three units blocking a
// turn the engine was perfectly willing to end, refused the agent's end-turn on that basis, and
// then tried to skip units the engine would not let anyone skip. A seat sat on turn 10 for hours
// with nothing actually wrong with it.
const player = Players.get(PLAYER_ID);

/**
 * Does a unit still need orders? panel-action.ts showRemainingMovesState(), ported.
 *
 * getFirstReadyUnit() is the engine's own answer, and it answers for the LOCAL player, so this is
 * only meaningful for the seat currently holding the game. A unit having moves left is NOT the
 * same as being ready: a unit told to sleep, fortify or wait has moves and blocks nothing.
 */
/**
 * EVERY unit the engine still wants orders for, not just the first.
 *
 * getFirstReadyUnit answers one at a time, and we passed that straight through — so a turn with
 * eight unordered units took eight end-turn attempts to discover them, one per round trip. Every
 * transcript reader found this independently. The engine will not enumerate them, but SKIP_TURN's
 * own legality mask will: it is legal exactly for a unit that is ready.
 */
function allReadyUnits(includeUnskippable) {
  const out = [];
  for (const cid of player?.Units?.getUnitIds?.() ?? []) {
    let can = null;
    try { can = Game.UnitOperations.canStart(cid, UnitOperationTypes.SKIP_TURN, {}, false); }
    catch { continue; }
    // SKIP_TURN is legal exactly for a unit that is ready, which is what we want — a unit part
    // way through a multi-turn operation is busy, not waiting, and naming it would send the agent
    // after something it cannot give an order to.
    //
    // Except when the engine says a unit needs orders and refuses to skip any: a unit built this
    // turn is awake, unmoved, unskippable — and the one the engine is waiting on. Naming nobody
    // cost three whole turns in one run; name the awake unmoved ones then (awaitingOrders).
    const skippable = can?.Success === true;
    if (!skippable && !(includeUnskippable && awaitingOrders(cid))) continue;
    const unit = Units.get(cid);
    out.push({
      id: String(cid.id ?? cid),
      type: unit?.type !== undefined ? typeName("Units", unit.type) : null,
      skippable,
    });
  }
  return out;
}

// readyUnit() is gone, deliberately. It called UI.Player.getFirstReadyUnit() — a UI-layer,
// LOCAL-PLAYER-only API that reaches into the engine's unit-cycling machinery — on every
// end-turn attempt, refusals included. Five identical SIGSEGVs (null deref on AsyncWorker1,
// the same six stack frames every time) each landed seconds after an end-turn attempt, and
// this was the last unit-cycle touch left in that path after the WAIT_FOR and probe-storm
// suspects were eliminated and the crash recurred. allReadyUnits() below answers the same
// question from Game.UnitOperations.canStart alone — the engine's validator, no UI layer —
// so nothing is lost but the suspect call.

/** A ready unit as something an agent can act on: its id and what it is. */
function describeReady(cid) {
  if (!cid) return null;
  const unit = Units.get(cid);
  // Whether `civ skip` will actually work. getFirstReadyUnit can name a unit whose SKIP_TURN
  // canStart fails — recommending the skip anyway is how one agent learned a 17-turn
  // superstition, so the hint below only names skip when the engine will take it.
  let skippable = false;
  try {
    skippable = Game.UnitOperations.canStart(cid, UnitOperationTypes.SKIP_TURN, {}, false)?.Success === true;
  } catch { skippable = false; }
  return {
    id: String(cid.id ?? cid),
    type: unit?.type !== undefined ? typeName("Units", unit.type) : null,
    moves: unit?.Movement?.movementMovesRemaining ?? null,
    skippable,
    busy: unit?.hasPendingOperations === true,
  };
}

/** The unit holding an unspent promotion, when a promotion blocker names no unit. */
function promotableUnit() {
  for (const cid of player?.Units?.getUnitIds?.() ?? []) {
    const unit = Units.get(cid);
    const xp = unit?.Experience;
    if (!xp) continue;
    let can = false;
    try { can = xp.canPromote === true || (xp.getStoredPromotionPoints ?? 0) > 0; }
    catch { can = false; }
    if (can) return { id: String(cid.id ?? cid), type: unit?.type !== undefined ? typeName("Units", unit.type) : null };
  }
  return null;
}

const blockerInfo = endTurnBlocker(PLAYER_ID);
const blocking = blockerInfo?.name ?? null;
// The first unit still holding the turn open, from gameplay APIs alone. Skippable is not
// enough: with the default unit-cycling setting only a unit that has not moved AT ALL blocks
// the game's own end of turn, and dropping that rule once made this file stricter than the
// game. The default is hardcoded here — reading the setting was the old code's only reason to
// touch the UI-layer APIs now banned from this path.
const firstReady = (() => {
  try {
    if (Game.UnitOperations.canStartAny(PLAYER_ID) === false) return null;
    for (const cid of player?.Units?.getUnitIds?.() ?? []) {
      if (holdsTurnOpen(cid)) return cid;
    }
  } catch { return null; }
  return null;
})();
const ready = describeReady(firstReady);

/**
 * A settlement with nothing in its build queue.
 *
 * NOTIFICATION_CHOOSE_CITY_PRODUCTION blocked eighteen turns, and we answered with the
 * notification's name. With more than one settlement an agent cannot tell which one is idle, and
 * the same guessing that cost ninety-two turns on COMMAND_UNITS applies here.
 */
function idleSettlement() {
  for (const cid of player?.Cities?.getCityIds?.() ?? []) {
    const city = Cities.get(cid);
    const queue = city?.BuildQueue;
    if (!queue) continue;
    let empty = false;
    try { empty = queue.isEmpty === true || (queue.getQueue?.() ?? []).length === 0; }
    catch { empty = false; }
    if (empty) return { id: String(cid.id ?? cid), name: locText(city.name ?? null) };
  }
  return null;
}

// Clearing and sending are SEPARATE CALLS, and the gap between them is the point.
//
// The engine applies a request asynchronously. Skipping units and then calling sendTurnComplete in
// the same pass sends it while they still hold their orders, so the game refuses without a word
// and the seat stays active. match.ts clears, waits, then sends.
if (CLEAR_ONLY === true) {
  // canStart is the mask. SKIP_TURN is legal only for a unit the engine considers ready, so
  // asking it is both the test and the filter — the version that sent SKIP_TURN to every unit and
  // swallowed the result was refused every time and could not tell.
  // At most a few skips per call. This loop used to fire a sendRequest at every ready unit in
  // one tick — the same write-burst shape that sat under all five identical engine SIGSEGVs.
  // The caller retries with a 900ms gap, so a large army still gets cleared, just at a pace the
  // engine's async workers have actually been tested at.
  let skipped = 0;
  for (const cid of player?.Units?.getUnitIds?.() ?? []) {
    if (skipped >= 4) break;
    let can = null;
    try { can = Game.UnitOperations.canStart(cid, UnitOperationTypes.SKIP_TURN, {}, false); }
    catch { continue; }
    if (!can?.Success) continue;
    try { Game.UnitOperations.sendRequest(cid, UnitOperationTypes.SKIP_TURN, {}); skipped++; }
    catch { /* the caller reads the blocker back */ }
  }
  // The unit the engine will not skip but still waits on (awaitingOrders): sleep it, fortify
  // it, or step it one tile — a forced end is past asking the agent, and the harness answered
  // this blocker with "?" nineteen times while the seat sat stalled.
  if (waitingOnUnits(PLAYER_ID)) {
    for (const cid of player?.Units?.getUnitIds?.() ?? []) {
      if (skipped >= 4) break;
      if (holdsTurnOpen(cid) || !awaitingOrders(cid)) continue;
      if (settleUnit(cid, true)) skipped++;
    }
  }
  // Dismiss the blocker only if it is the sort you CAN dismiss. A decision notification
  // (traditions, a tech to pick) ignores dismiss, so match.ts answers those through choose.js
  // instead. Dismissing eight times and hoping is what stalled the marathon run at turn 4.
  const blocker = endTurnBlocker(PLAYER_ID);
  if (blocker?.id && !blocker.name?.startsWith("NOTIFICATION_ADVISOR_WARNING_")) {
    try { Game.Notifications.dismiss(blocker.id); } catch { /* the caller reads the blocker back */ }
  }
  return { ok: true, cleared: true, skipped, blocking, ready };
}

// A forced end-turn does not report "cannot": it clears what it can and tries anyway. Only an
// agent's own end-turn gets told why it is blocked, because only an agent can act on the reason.
if (FORCED !== true && (blocking || ready)) {
  // Name the UNIT, not the notification.
  //
  // NOTIFICATION_COMMAND_UNITS means "a unit needs orders", and we answered with the
  // notification's name plus a hint reading `civ move <unit> <x,y>` — a literal placeholder. The
  // agent could not tell WHICH unit, so it moved all of them, was refused, moved them again,
  // tried WAIT_FOR, and was refused again: four rounds of correct commands against a requirement
  // it was never told the subject of. The engine knows the unit; ask it.
  const unitBlocker = blocking !== null && /COMMAND_UNITS|MOVE_A_UNIT/.test(blocking);
  const waiting = unitBlocker || !blocking ? allReadyUnits(unitBlocker) : [];
  const productionBlocker = blocking !== null && /CITY_PRODUCTION|CHOOSE_PRODUCTION/.test(blocking);
  const idle = productionBlocker ? idleSettlement() : null;

  // A citizen waiting to be placed. Name the settlement AND the plots, because the agent's next
  // move is to guess a coordinate: three of the ten failures in a clean run were a guessed expand
  // target, and the legal list was one call away the whole time.
  const growthBlocker = blocking !== null && /NEW_POPULATION|POPULATION_GROWTH/.test(blocking);
  let growing = null;
  if (growthBlocker) {
    for (const cid of player?.Cities?.getCityIds?.() ?? []) {
      const plots = expandPlots(cid);
      if (plots.length > 0) {
        growing = { id: String(cid.id ?? cid), name: locText(Cities.get(cid)?.name ?? null), plots };
        break;
      }
    }
  }
  // A settlement just taken: keep it, raze it or free it. The chooser is a HUD panel `civ
  // screen` cannot see, so without this line the agent had no idea what the game wanted.
  const captured = blocking !== null && /RAZE_CITY/.test(blocking) ? justConqueredCity(PLAYER_ID) : null;
  const promotionBlocker = blocking !== null && /UNIT_PROMOTION|PROMOTION_AVAILABLE/.test(blocking);
  const promotable = promotionBlocker ? promotableUnit() : null;

  // A town that has grown enough to choose its focus. Name the town AND the focus projects it
  // may start, because the old hint said `civ build <town>` and nothing more: an agent queued
  // the cheapest unit it could find in every town it had — seventeen scout orders in one turn —
  // against a prompt that only a focus project answers.
  const focusBlocker = blocking !== null && /TOWN_PROJECT/.test(blocking);
  let focusing = null;
  if (focusBlocker) {
    const wanted = blockerInfo?.city?.id ?? null;
    for (const cid of player?.Cities?.getCityIds?.() ?? []) {
      const city = Cities.get(cid);
      if (!city?.isTown) continue;
      const id = String(cid.id ?? cid);
      if (wanted !== null && wanted !== "" && id !== wanted) continue;
      const choices = townFocusChoices(city);
      if (choices.length === 0) continue;
      focusing = { id, name: locText(city.name ?? null), choices };
      break;
    }
  }

  // ONE waiting unit is named too. A unit that moved part-way and still has moves is skippable
  // (the engine's own COMMAND_UNITS subject) yet fails the never-moved rule `ready` applies, so
  // it was named only when it had company: a lone one fell through to "the game is waiting on
  // NOTIFICATION_COMMAND_UNITS" with a placeholder hint — eleven refusals in one 480s turn.
  const lone = waiting.length === 1 ? waiting[0] : null;
  // Plain words: a unit that has not been given any order this turn. Nothing is wrong with it.
  const named = waiting.length > 1
    ? `${waiting.length} units still need orders — none of them has been given one this turn: ` +
      waiting.map((u) => `${u.id}${u.type ? ` (${u.type})` : ""}`).join(", ")
    : ready
      ? `unit ${ready.id}${ready.type ? ` (${ready.type})` : ""} still needs orders — it has not been given one this turn`
      : lone
        ? `unit ${lone.id}${lone.type ? ` (${lone.type})` : ""} still needs orders — it has not been given one this turn`
        : null;
  const why =
    (growing && `${growing.name || `settlement ${growing.id}`} has a citizen to place`) ||
    (focusing && `${focusing.name || `town ${focusing.id}`} has grown enough to choose its town focus`) ||
    (captured && `${captured.name || `settlement ${captured.id}`} was just conquered: keep it, raze it or free it`) ||
    (promotable && `unit ${promotable.id}${promotable.type ? ` (${promotable.type})` : ""} has an unspent promotion`) ||
    (unitBlocker && named) ||
    (idle && `${idle.name || `settlement ${idle.id}`} has nothing in its build queue`) ||
    (!blocking && named) ||
    `the game is waiting on ${blocking}`;
  // What to actually do about one stuck unit. Only name `civ skip` when the engine will take it
  // — recommending a skip the engine refuses with no reason is worse than saying nothing.
  //
  // A unit on a standing order can still hold the turn open: auto-explore pauses beside a
  // discovery, a queued path pauses when it is blocked, and the engine then wants a decision from
  // that unit. This used to say the unit "should not be blocking" and told the agent to cancel
  // the order — which it did, every turn, and then re-issued it: 23 refusals in one 46-turn run,
  // each one a wasted model round. The skip is legal (that is how the unit was found), and it
  // is the one-command answer.
  // The engine refuses to skip a unit it is still waiting on — a unit built this turn, most
  // often. Sleep, fortify or a move are what it takes instead; `civ skip` tries the first two.
  const unskippable = waiting.filter((u) => !u.skippable);
  const moveHint = (unit) =>
    `the game will not skip unit ${unit.id} yet still waits on it (a unit built this turn does this): ` +
    `\`civ skip ${unit.id}\` puts it to sleep if the engine allows, otherwise move it one tile — ` +
    `\`civ move ${unit.id} <x,y>\` (\`civ near ${unit.id} 1\` lists the tiles beside it)`;
  // Every unit gets one order per turn, and skipping IS an order — a normal choice for a unit
  // you have no better use for right now, not a failure to fix.
  const oneOrder = (unit) =>
    `give it one order: \`civ skip ${unit.id}\` skips it for this turn (a normal, valid choice), ` +
    `\`civ move ${unit.id} <x,y>\` moves it, or a standing order — \`civ do unit-op ${unit.id} UNITOPERATION_SLEEP\` ` +
    `or UNITOPERATION_FORTIFY — so it stops asking every turn`;
  const orderHint = (unit) =>
    unit.busy && unit.skippable
      ? `unit ${unit.id} has a standing order, but the game still wants a decision from it this turn. ` +
        `\`civ skip ${unit.id}\` finishes it for this turn, or \`civ move ${unit.id} <x,y>\` gives it a new order`
      : unit.skippable
        ? oneOrder(unit)
        : `give unit ${unit.id} an order — \`civ move ${unit.id} <x,y>\`, or fortify it. ` +
          `The engine will not accept a plain skip for this unit right now; \`civ what-can ${unit.id}\` lists what it will take.`;
  return {
    ok: false,
    code: "CANNOT_END_TURN",
    message: `your turn cannot end yet: ${why}`,
    // Name a command that exists, against the thing it applies to. Wording that said "deal with
    // the notification" while the harness had no way to deal with one cost an agent a whole turn.
    hint: growing
      ? `put it on one of these: ${growing.plots.slice(0, 10).map((p) => `\`civ expand ${growing.id} ${p}\``).join(", ")}`
      : focusing
      ? `choose one: ${focusing.choices.map((c) => `\`civ build ${focusing.id} ${c}\``).join(", ")}` +
        ` — a focus is the only thing a town builds; its units and buildings are bought with gold`
      : captured
      ? `decide: \`civ capture ${captured.id} keep\`, \`civ capture ${captured.id} raze\` or \`civ capture ${captured.id} liberate\` (\`civ capture ${captured.id}\` says which the game allows)`
      : promotable
      ? `take one: \`civ promote ${promotable.id}\` lists what it has earned`
      : idle
      ? `pick something for it: \`civ build ${idle.id}\` lists what it can make`
      : waiting.length > 1
        ? `each needs one order. Skipping is a normal, valid choice for units you have no better use for: ` +
          `\`${waiting.map((u) => `civ skip ${u.id}`).join("; ")}\` finishes them all at once` +
          ` — a skip lasts one turn; a unit you mean to leave idle should sleep instead ` +
          `(\`civ do unit-op <unit> UNITOPERATION_SLEEP\`, before it moves) so it stops asking every turn` +
          (unskippable.length > 0 ? `. ${unskippable.map(moveHint).join(". ")}` : "")
        : unitBlocker && ready
      ? orderHint(ready)
      : lone
        ? lone.skippable
          ? oneOrder(lone)
          : moveHint(lone)
      : blocking
        ? `the harness has no specific answer for ${blocking} yet. Try \`civ dismiss\`; if that ` +
          `does not clear it, \`civ open <id>\` with its id from /current/pending.txt`
        : ready
          ? orderHint(ready)
          : "check /current/pending.txt for what the game is waiting on",
    blocking,
    ready,
    waiting,
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
