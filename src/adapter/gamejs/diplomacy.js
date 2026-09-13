// Runs inside Civ 7. What you can do to another civilization, and doing it.
//
// The player-to-player actions share one argument shape:
//   { Player1: <you>, Player2: <them>, Type: DiplomacyActionTypes.DIPLOMACY_ACTION_X }
// but each has its OWN player operation — DECLARE_WAR, FORM_ALLIANCE,
// CLOSE_BORDERS_DIPLOMATIC_ACTION, and so on. Rather than hand-map action to operation and get it
// wrong (the failure that has cost most in this project), ask the engine: try every operation
// that could plausibly carry an action and report the pairs canStart accepts.
//
const me = PLAYER_ID;
// Number(null) is 0, not NaN. `civ diplomacy` with no target therefore read as "target player 0"
// and the who-have-you-met listing was unreachable — an agent asking who it knew got a list of
// offers against whoever happened to be seat 0, including itself.
const other = OTHER_PLAYER === null || OTHER_PLAYER === undefined ? NaN : Number(OTHER_PLAYER);

/**
 * Operations that take a { Player1, Player2, Type } action.
 *
 * MAKE_PEACE does not end in DIPLOMATIC_ACTION and was not in the explicit list, so it was not
 * reachable by any command: an agent could declare war and then had no way out of it for the rest
 * of the match. RESPOND_DIPLOMATIC_FIRST_MEET is how you answer a civ that has just found you.
 */
function actionOperations() {
  const names = [];
  for (const key of Object.keys(PlayerOperationTypes ?? {})) {
    if (
      /DIPLOMATIC_ACTION$/.test(key) ||
      /^(DECLARE_WAR|MAKE_PEACE|FORM_ALLIANCE|CANCEL_ALLIANCE|RESPOND_DIPLOMATIC_FIRST_MEET)$/.test(key)
    ) {
      names.push(key);
    }
  }
  return names;
}

/** Every diplomacy action this build defines, by name. */
function actionTypes() {
  const out = [];
  for (const key of Object.keys(DiplomacyActionTypes ?? {})) {
    if (/^DIPLOMACY_ACTION_/.test(key)) out.push(key);
  }
  return out;
}

/** The greeting a civ that just found you is owed: FRIENDLY, NEUTRAL or UNFRIENDLY. */
function greetingType(word) {
  const key = `PLAYER_REALATIONSHIP_FIRSTMEET_${String(word ?? "").toUpperCase()}`; // the engine's own spelling
  return typeof DiplomacyPlayerFirstMeets !== "undefined" ? DiplomacyPlayerFirstMeets[key] : undefined;
}
function greetingArgs(target, word) {
  return { Player1: me, Player2: target, Type: greetingType(word) };
}
/** Whether a first-meet greeting to this player is still owed. */
function greetingOwed(target) {
  const type = greetingType("neutral");
  if (type === undefined || PlayerOperationTypes.RESPOND_DIPLOMATIC_FIRST_MEET === undefined) return false;
  try {
    return Game.PlayerOperations.canStart(me, PlayerOperationTypes.RESPOND_DIPLOMATIC_FIRST_MEET, greetingArgs(target, "neutral"), false)?.Success === true;
  } catch { return false; }
}
/** Proposals from other civs waiting on an answer: the NOTIFICATION_DIPLOMATIC_RESPONSE_REQUIRED targets. */
function proposalsWaiting() {
  const out = [];
  try {
    for (const nid of Game.Notifications?.getIdsForPlayer?.(me) ?? []) {
      const notification = Game.Notifications.find(nid);
      if (!notification) continue;
      const name = Game.Notifications.getTypeName(notification.Type) ?? "";
      if (!/DIPLOMATIC_RESPONSE_REQUIRED/.test(name)) continue;
      const id = notification.Target?.id ?? notification.Target ?? null;
      if (id === null || id === undefined) continue;
      let header = null;
      try { header = Game.Diplomacy?.getDiplomaticEventData?.(id) ?? null; } catch { header = null; }
      const actionType = header?.actionType;
      const actionName = actionType !== undefined
        ? Object.keys(DiplomacyActionTypes ?? {}).find((k) => DiplomacyActionTypes[k] === actionType) ?? String(actionType)
        : null;
      out.push({ id: String(id), from: header?.initialPlayer !== undefined ? `p${header.initialPlayer}` : null, action: actionName });
    }
  } catch { /* no notifications API */ }
  return out;
}

// `civ diplomacy respond <ID> accept|reject|support` — an AI's proposal (a treaty, a sanction,
// an endeavour) must be answered with RESPOND_DIPLOMATIC_ACTION { ID, Type }. That shape shares
// nothing with the Player1/Player2 actions below, so it was unreachable from any command.
const respond = /^respond\s+(\S+)\s+(\S+)$/i.exec(String(ACTION ?? "").trim());
if (respond) {
  const id = respond[1];
  const key = `DIPLOMACY_RESPONSE_${respond[2].toUpperCase()}`;
  const type = typeof DiplomaticResponseTypes !== "undefined" ? DiplomaticResponseTypes[key] : undefined;
  if (type === undefined) {
    return { ok: false, code: "NO_SUCH_ACTION", message: `answer a proposal with accept, reject or support — not ${respond[2]}` };
  }
  const args = { ID: Number.isFinite(Number(id)) ? Number(id) : id, Type: type };
  const result = startOperation(Game.PlayerOperations, me, PlayerOperationTypes.RESPOND_DIPLOMATIC_ACTION, args);
  if (result.ok) result.note = `proposal ${id} answered: ${respond[2].toLowerCase()}`;
  else if (!result.message) result.message = `the game will not take that answer to proposal ${id} — \`civ diplomacy\` lists the proposals waiting on you`;
  return result;
}

if (!Number.isFinite(other)) {
  // No target: who have you met, and are you at war with them?
  const known = [];
  const diplomacy = Players.get(me)?.Diplomacy;
  for (const p of Players.getAlive() ?? []) {
    if (p.id === me || !(p.isMajor ?? true)) continue;
    let met = false;
    try { met = diplomacy?.hasMet?.(p.id) === true; } catch { met = false; }
    if (!met) continue;
    let atWar = false;
    try { atWar = diplomacy?.isAtWarWith?.(p.id) === true; } catch { atWar = false; }
    known.push({ player: `p${p.id}`, civ: locText(p.civilizationName ?? null), atWar, greetingOwed: greetingOwed(p.id) });
  }
  return { ok: true, listing: true, players: known, proposals: proposalsWaiting() };
}

// `civ diplomacy <player> greet friendly|neutral|unfriendly` — the reply to a civ that has
// just found you (NOTIFICATION_PLAYER_MET). RESPOND_DIPLOMATIC_FIRST_MEET takes a
// DiplomacyPlayerFirstMeets value, never a DiplomacyActionTypes one, so the generic path below
// could not send it: three blocked turns, nothing to answer them with.
const greet = /^greet\s+(\S+)$/i.exec(String(ACTION ?? "").trim());
if (greet) {
  const type = greetingType(greet[1]);
  if (type === undefined) {
    return { ok: false, code: "NO_SUCH_ACTION", message: `a greeting is friendly, neutral or unfriendly — not ${greet[1]}` };
  }
  const result = startOperation(Game.PlayerOperations, me, PlayerOperationTypes.RESPOND_DIPLOMATIC_FIRST_MEET, greetingArgs(other, greet[1]));
  if (result.ok) result.note = `greeted p${other}: ${greet[1].toLowerCase()}`;
  else if (!result.message) result.message = `p${other} is not waiting on a greeting from you`;
  return result;
}

if (!ACTION) {
  // What the engine will actually accept against this player, right now.
  const offers = [];
  for (const operation of actionOperations()) {
    for (const type of actionTypes()) {
      const args = { Player1: me, Player2: other, Type: DiplomacyActionTypes[type] };
      let ok = false;
      try { ok = Game.PlayerOperations.canStart(me, PlayerOperationTypes[operation], args, false)?.Success === true; }
      catch { ok = false; }
      if (ok) offers.push({ operation, action: type });
    }
  }
  return { ok: true, listing: true, target: `p${other}`, offers, greetingOwed: greetingOwed(other) };
}

// Doing it. The agent names the action; we find the operation that accepts it.
// Accept the short form too: MAKE_PEACE means DIPLOMACY_ACTION_MAKE_PEACE. The full prefix is
// noise an agent had to discover by being refused once.
const upper = String(ACTION).toUpperCase();
const wanted = DiplomacyActionTypes?.[upper] !== undefined ? upper : `DIPLOMACY_ACTION_${upper}`;
const type = DiplomacyActionTypes?.[wanted];
if (type === undefined) {
  return {
    ok: false,
    code: "NO_SUCH_ACTION",
    message: `this game has no diplomacy action named ${ACTION}`,
    hint: `run \`civ diplomacy p${other}\` to see what you can do to them`,
  };
}

const args = { Player1: me, Player2: other, Type: type };
let chosen = null;
// Keep the engine's own words for why, when it gives any. "The game will not let you X right
// now" with no reason left an agent at war with no path to peace and no idea what was missing.
const refusals = [];
for (const operation of actionOperations()) {
  try {
    const check = Game.PlayerOperations.canStart(me, PlayerOperationTypes[operation], args, false);
    if (check?.Success === true) {
      chosen = operation;
      break;
    }
    for (const reasonId of check?.FailureReasons ?? []) {
      let text = reasonId;
      try { text = Locale.compose(reasonId); } catch { /* keep the id */ }
      if (text && !refusals.includes(text)) refusals.push(text);
    }
  } catch { /* try the next */ }
}
if (!chosen) {
  return {
    ok: false,
    code: "ILLEGAL_ACTION",
    message: `the game will not let you ${wanted} against p${other} right now` +
      (refusals.length > 0 ? ` — ${refusals.slice(0, 3).join("; ")}` : ""),
    hint: `run \`civ diplomacy p${other}\` to see what it will allow`,
  };
}

const result = startOperation(Game.PlayerOperations, me, PlayerOperationTypes[chosen], args);
if (result.ok) result.note = `${wanted} sent to p${other}`;
return result;
