// Runs inside Civ 7. The game's own notification list for PLAYER_ID (docs/PLAN.md §6.4).
//
// This is parity, not curation: it is what the UI puts in front of a human every turn. We
// reproduce it and rank nothing. `blocking` marks the items the game itself will refuse to end
// the turn over.
//
// getTypeName() takes a notification's `.Type` hash, NOT its id. Passing the id returned the same
// wrong name for every item, so "choose research", "move a unit" and "production finished" all
// read as NOTIFICATION_ASSIGN_NEW_RESOURCES and the type field was worse than useless. Resolve
// the notification first, exactly as the game's own UI does.
function typeNameOf(id) {
  try {
    const notification = Game.Notifications?.find?.(id);
    if (notification) return Game.Notifications.getTypeName(notification.Type) ?? null;
  } catch { /* fall through */ }
  return null;
}

const ids = Game.Notifications?.getIdsForPlayer?.(PLAYER_ID) ?? [];
const blockingType = endTurnBlocker(PLAYER_ID)?.name ?? null;

/** The database keeps the UI's own markup in these strings; the agent cannot see an icon. */
function plain(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\[icon:[^\]]*\]/g, "")
    .replace(/\[\/?(?:TIP|B|I|S|LINK)(?::[^\]]*)?\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const text = (get, id) => {
  try { return plain(Locale.compose(get(id))); } catch { return null; }
};

const items = [];
for (const id of ids) {
  items.push({
    id: String(id?.id ?? id),
    type: typeNameOf(id),
    summary: text((n) => Game.Notifications.getSummary(n), id),
    message: text((n) => Game.Notifications.getMessage(n), id),
  });
}

// Include visible popup content and controls for the local seat.
items.push(...screenInventory().map(screenRecord));

return { blockingType, items };
