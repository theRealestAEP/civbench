// Runs inside Civ 7. Mirrors an agent message into the game's own chat window.
//
// The harness channel is the record; this is purely so a spectator watching the game sees what
// the agents are saying to each other (docs/PLAN.md §12).
if (typeof CHAT_TEXT !== "string" || CHAT_TEXT.length === 0) return { sent: false };
try {
  // sendChat(message, targetType, targetID) — global target reaches every player.
  Network.sendChat(CHAT_TEXT, ChatTargetTypes.CHATTARGET_ALL ?? 0, -1);
  return { sent: true };
} catch (err) {
  return { sent: false, error: String(err) };
}
