// Runs inside Civ 7. Trade deals (docs/PLAN.md §13).
//
// Deals are the one part of diplomacy that is not an operation. Game.DiplomacyDeals is a stateful
// builder: open a working deal, add an item to each side, then send it.
//
// Every call here used to have the wrong signature. A working deal is addressed by an OBJECT —
// { direction, player1, player2 } — not by two player ids, and sendWorkingDeal takes a proposal
// action as its second argument. There was also no way to add an item at all, so the best an
// agent could send was an empty deal, and the harness told it the trade had gone out. Trade has
// never worked, and could not have.
//
// Signatures taken from the game's own panel-diplomacy-peace-deal.ts.
const deals = Game.DiplomacyDeals;
if (!deals) return { error: "DiplomacyDeals is unavailable in this context" };

const other = Number(OTHER_PLAYER);
const dealId = {
  direction: DiplomacyDealDirection.OUTGOING,
  player1: PLAYER_ID,
  player2: other,
};

/** Deal item kinds this build defines, by name. */
const ITEM_TYPES = Object.keys(DiplomacyDealItemTypes ?? {}).filter((k) => /^[A-Z_]+$/.test(k));

/** Describe one item the engine offered, in names an agent can type back. */
function describeItem(item, from) {
  return {
    from: `p${from}`,
    kind: typeName("Types", item?.type) ?? String(item?.type ?? "?"),
    amount: item?.amount ?? null,
    city: item?.cityId ? String(item.cityId.id ?? item.cityId) : null,
    resource: typeName("Resources", item?.resourceType) ?? null,
  };
}

if (DEAL_MODE === "items") {
  // What each side could put on the table, asked of the engine for both players.
  const out = [];
  for (const side of [PLAYER_ID, other]) {
    for (const kind of ITEM_TYPES) {
      let items = [];
      try { items = deals.getPossibleWorkingDealItems(dealId, side, DiplomacyDealItemTypes[kind]) ?? []; }
      catch { continue; }
      for (const item of items) out.push({ ...describeItem(item, side), kind });
    }
  }
  return { offerable: out };
}

if (DEAL_MODE === "pending") {
  try {
    const ids = deals.getDealIds?.(PLAYER_ID) ?? [];
    return { hasPending: ids.length > 0, dealIds: ids.map((d) => String(d?.id ?? d)) };
  } catch (err) {
    return { error: String(err) };
  }
}

if (DEAL_MODE === "offer") {
  // Put one item on the table. KIND names the sort of thing; AMOUNT and SUBJECT qualify it.
  const kind = String(ITEM_KIND ?? "").toUpperCase();
  if (!(kind in (DiplomacyDealItemTypes ?? {}))) {
    return {
      error: `no such deal item kind: ${ITEM_KIND}`,
      hint: `one of: ${ITEM_TYPES.join(", ")}`,
    };
  }
  const item = { type: DiplomacyDealItemTypes[kind] };
  if (AMOUNT !== null && AMOUNT !== undefined) item.amount = Number(AMOUNT);
  if (kind === "AGREEMENTS" && SUBJECT) {
    const agreement = DiplomacyDealItemAgreementTypes?.[String(SUBJECT).toUpperCase()];
    if (agreement === undefined) {
      return {
        error: `no such agreement: ${SUBJECT}`,
        hint: `one of: ${Object.keys(DiplomacyDealItemAgreementTypes ?? {}).join(", ")}`,
      };
    }
    item.agreementType = agreement;
  }
  try {
    deals.addItemToWorkingDeal(dealId, item);
    return { ok: true, added: kind };
  } catch (err) {
    return { error: String(err) };
  }
}

if (DEAL_MODE === "send") {
  try {
    // The proposal action is required. Without it the engine has no idea what you are doing.
    deals.sendWorkingDeal(dealId, DiplomacyDealProposalActions.PROPOSED);
    return { ok: true, sent: true };
  } catch (err) {
    return { error: String(err) };
  }
}

if (DEAL_MODE === "clear") {
  try {
    deals.clearWorkingDeal(dealId);
    return { ok: true, cleared: true };
  } catch (err) {
    return { error: String(err) };
  }
}

return { error: `unknown deal mode: ${DEAL_MODE}`, hint: "items, pending, offer, send, clear" };
