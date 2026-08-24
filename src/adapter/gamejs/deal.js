// Runs inside Civ 7. Trade deals (docs/PLAN.md §13).
//
// Deals are the one part of diplomacy that is NOT an operation. Game.DiplomacyDeals is a stateful
// builder — open a working deal, add items to each side, then send it — so `civ do player-op`
// could never reach it. Without this, agents can talk about trading but cannot actually trade.
const deals = Game.DiplomacyDeals;
if (!deals) return { error: "DiplomacyDeals is unavailable in this context" };

if (DEAL_MODE === "items") {
  // What could each side put on the table?
  try {
    const workingId = deals.getWorkingDeal?.(PLAYER_ID, OTHER_PLAYER)?.id ?? null;
    const kinds = Object.keys(DiplomacyDealItemTypes ?? {});
    const out = {};
    for (const kind of kinds) {
      try {
        const items = deals.getPossibleWorkingDealItems(workingId, PLAYER_ID, DiplomacyDealItemTypes[kind]) ?? [];
        if (items.length > 0) out[kind] = items.length;
      } catch (err) { /* not every kind applies */ }
    }
    return { workingId: workingId ? String(workingId) : null, offerable: out };
  } catch (err) {
    return { error: String(err) };
  }
}

if (DEAL_MODE === "pending") {
  try {
    return { hasPending: deals.hasPendingDeal?.(PLAYER_ID, OTHER_PLAYER) ?? false,
             dealIds: (deals.getDealIds?.(PLAYER_ID) ?? []).map(String) };
  } catch (err) {
    return { error: String(err) };
  }
}

if (DEAL_MODE === "send") {
  try {
    deals.sendWorkingDeal(PLAYER_ID, OTHER_PLAYER);
    return { sent: true };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
}

if (DEAL_MODE === "clear") {
  try {
    deals.clearWorkingDeal(PLAYER_ID, OTHER_PLAYER);
    return { cleared: true };
  } catch (err) {
    return { cleared: false, error: String(err) };
  }
}

return { error: `unknown deal mode: ${DEAL_MODE}` };
