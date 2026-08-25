// Runs inside Civ 7. Acts on a notification: dismiss it, or activate it.
//
// This was the hole that stopped matches dead. A notification can BLOCK the end of a turn, and
// nothing in the harness could clear one. The refusal even told the agent to "deal with the
// notification in /current/pending.txt" while giving it no way to do so, so one agent issued
// ACKNOWLEDGE_TURN_START 27 times looking for anything that would work.
//
// The game's own panel-notification-train.ts uses exactly these two calls.
const ids = Game.Notifications?.getIdsForPlayer?.(PLAYER_ID) ?? [];

/** Match on the numeric id an agent can read from pending.txt. */
function findId(wanted) {
  for (const id of ids) {
    if (String(id?.id ?? id) === String(wanted)) return id;
  }
  return null;
}

// No id given: act on whatever is blocking the end of the turn, which is what a human's end-turn
// button does when the game refuses it.
let target = null;
if (TARGET_ID === null || TARGET_ID === undefined || TARGET_ID === "") {
  // endTurnBlocker() is the one place that knows findEndTurnBlocking needs the type as a second
  // argument AND that NONE is 0 rather than null. This re-implemented it and dropped the NONE
  // check, so with nothing blocking it asked the engine to find a notification of type NONE.
  target = endTurnBlocker(PLAYER_ID)?.id ?? null;
  if (!target) return { ok: false, code: "NOTHING_BLOCKING", message: "nothing is blocking your turn" };
} else {
  target = findId(TARGET_ID);
  if (!target) return { ok: false, code: "NO_SUCH_NOTIFICATION", message: `you have no notification ${TARGET_ID}` };
}

const name = (() => {
  try {
    const n = Game.Notifications.find(target);
    return n ? Game.Notifications.getTypeName(n.Type) : null;
  } catch { return null; }
})();

try {
  if (MODE === "activate") Game.Notifications.activate(target);
  else Game.Notifications.dismiss(target);
} catch (err) {
  return { ok: false, code: "NOTIFY_FAILED", message: String(err) };
}

// Deliberately no "did it clear?" claim here.
//
// The engine applies the dismissal asynchronously: an immediate re-read still reported the same
// notification blocking, a second later it was gone. Reporting that stale read told the agent the
// dismissal had failed when it had worked. `civ end-turn` gives the accurate answer a moment
// later, so let it be the one to speak.
return { ok: true, note: `${MODE === "activate" ? "opened" : "dismissed"} ${name ?? TARGET_ID}` };
