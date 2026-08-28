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

// Screens the game has pushed OVER the map. A human is looking at these; agents were not.
//
// ContextManager mounts every pushed screen and popup under `.fxs-popups` (its own fallback
// root), so the DOM is the honest inventory of what is on screen — an advisor-selection popup
// sat there invisible to every agent because it is UI, not an engine notification. Anything
// found here reaches pending.txt as SCREEN_<name>, so an agent can at least see it and decide.
try {
  const root = typeof document !== "undefined" ? document.querySelector(".fxs-popups") : null;
  for (const el of root?.children ?? []) {
    const tag = String(el.tagName ?? "").toLowerCase();
    if (!tag || tag === "mouse-guard") continue;
    items.push({
      id: `screen:${tag}`,
      type: `SCREEN_${tag.toUpperCase().replace(/-/g, "_")}`,
      summary: `the game has a screen open on top of the map: ${tag}`,
      message: null,
    });
  }
} catch { /* a context with no DOM (the fake game) has no screens */ }

return { blockingType, items };
