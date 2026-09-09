// Popup ids belong to the screen interface, including ids from earlier dumps.
if (String(TARGET_ID ?? "").startsWith("screen:")) {
  return { ok: false, code: "USE_SCREEN", message: "this is a UI screen", hint: "civ screen reads its text and lists its controls" };
}
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
  // Not a failure. An agent running `civ dismiss` defensively before ending its turn is playing
  // carefully, and marking that illegal charged it against the seat's hygiene score — the metric
  // meant to catch flailing. Answer the question it asked instead.
  if (!target) return { ok: true, note: "nothing was blocking your turn" };
} else {
  target = findId(TARGET_ID);
  if (!target) {
    // A dead end used to stop here. Notification ids come and go DURING a turn — dismissing one
    // renumbers nothing but removes it — so an agent acting on an id it read a moment ago gets
    // this, and "you have no notification 28" gives it nowhere to go. Say what is pending now.
    const live = [];
    for (const cid of Game.Notifications?.getIdsForPlayer?.(PLAYER_ID) ?? []) {
      const id = String(cid?.id ?? cid);
      let type = null;
      try {
        const n = Game.Notifications.find(cid);
        type = n ? Game.Notifications.getTypeName(n.Type) : null;
      } catch { type = null; }
      live.push(type ? `${id} (${type})` : id);
    }
    return {
      ok: false,
      code: "NO_SUCH_NOTIFICATION",
      message: `you have no notification ${TARGET_ID} — it was probably cleared earlier this turn`,
      pending: live,
      hint: live.length > 0
        ? `pending right now: ${live.join(", ")}`
        : "no engine notifications remain; civ screen lists open UI screens",
    };
  }
}

const name = (() => {
  try {
    const n = Game.Notifications.find(target);
    return n ? Game.Notifications.getTypeName(n.Type) : null;
  } catch { return null; }
})();

try {
  if (MODE === "activate") Game.Notifications.activate(target);
  else {
    // Firaxis AdvisorWarning.dismiss acknowledges the exact notification before dismissing it.
    // Its Target is the full ComponentID, including owner/type, returned by getIdsForPlayer.
    if (name?.startsWith("NOTIFICATION_ADVISOR_WARNING_")) {
      const acknowledged = startOperation(
        Game.PlayerOperations, PLAYER_ID, PlayerOperationTypes.VIEWED_ADVISOR_WARNING, { Target: target },
      );
      if (!acknowledged.ok) return acknowledged;
    }
    Game.Notifications.dismiss(target);
  }
} catch (err) {
  return { ok: false, code: "NOTIFY_FAILED", message: String(err) };
}

// No "did it clear?" claim from THIS read: the engine applies the dismissal asynchronously, and
// an immediate re-read reports the old state. The Match Server polls a moment later with the id
// returned here, and downgrades this ok if the notification is still standing — a decision
// notification ignores dismissal entirely, and six "ok — dismissed" answers in a row once sent
// an agent in circles for a whole turn.
return {
  ok: true,
  note: `${MODE === "activate" ? "opened" : "dismissed"} ${name ?? TARGET_ID}`,
  targetId: String(target?.id ?? target),
  targetName: name ?? null,
};
