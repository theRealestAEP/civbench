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

/** The readable name of an item kind, from the hash the engine puts on the item itself. */
function itemKindName(type) {
  for (const key of ITEM_TYPES) {
    if (DiplomacyDealItemTypes[key] === type) return key;
  }
  return String(type ?? "?");
}

/**
 * Describe one item the engine offered.
 *
 * The fields are the ones a working deal item actually carries — id, from, to, type, subType,
 * duration, amount, isValid. The previous version read `cityId` and `resourceType`, which are not
 * on the object at all, so every item reported a null city and a null resource forever.
 */
function describeItem(item) {
  return {
    from: `p${item?.from ?? "?"}`,
    to: `p${item?.to ?? "?"}`,
    kind: itemKindName(item?.type),
    // What the item is OF: the resource, the agreement, the city. The engine hands back a hash
    // and which table it belongs to depends on the kind, so try the ones that can answer.
    of: typeName("Resources", item?.subType) ?? typeName("Types", item?.subType) ?? null,
    amount: item?.amount ?? null,
    turns: item?.duration ?? null,
    valid: item?.isValid ?? null,
  };
}

if (DEAL_MODE === "items") {
  // ALL is a query-everything sentinel, not an item kind. Asking per kind AND asking ALL returned
  // the same gold four times over, each labelled with the QUERY's kind rather than its own — so
  // an agent saw "ALL 26 gold" and "GOLD 134" as if they were different things to trade.
  const out = [];
  for (const side of [PLAYER_ID, other]) {
    let items = [];
    try { items = deals.getPossibleWorkingDealItems(dealId, side, DiplomacyDealItemTypes.ALL) ?? []; }
    catch { continue; }
    for (const item of items) out.push(describeItem(item));
  }
  return { offerable: out, kinds: ITEM_TYPES.filter((k) => k !== "ALL") };
}

if (DEAL_MODE === "pending") {
  try {
    const ids = deals.getDealIds?.(PLAYER_ID) ?? [];
    return { hasPending: ids.length > 0, dealIds: ids.map((d) => String(d?.id ?? d)) };
  } catch (err) {
    return { error: String(err) };
  }
}

// A deal someone has SENT this player. Without these two modes trade could begin but never
// finish: both sides could propose forever and neither could read or answer what arrived.
const incomingId = {
  direction: DiplomacyDealDirection.INCOMING,
  player1: PLAYER_ID,
  player2: other,
};

if (DEAL_MODE === "incoming") {
  // getWorkingDeal returns { itemIds }; each item is fetched by id. There is no bulk items call
  // — the first version guessed getWorkingDealItems and verify-live caught it as undefined.
  // panel-diplomacy-peace-deal.ts reads a deal exactly this way.
  try {
    const working = deals.getWorkingDeal?.(incomingId);
    const items = [];
    for (const itemId of working?.itemIds ?? []) {
      const item = deals.getWorkingDealItem?.(incomingId, itemId);
      if (item) items.push(describeItem(item));
    }
    return { incoming: items, count: items.length };
  } catch (err) {
    return { error: String(err), hint: `there may be no deal from p${other} waiting on you` };
  }
}

if (DEAL_MODE === "accept" || DEAL_MODE === "reject") {
  try {
    deals.sendWorkingDeal(
      incomingId,
      DEAL_MODE === "accept" ? DiplomacyDealProposalActions.ACCEPTED : DiplomacyDealProposalActions.REJECTED,
    );
    return { ok: true, responded: DEAL_MODE };
  } catch (err) {
    return { error: String(err), hint: `run \`civ deal incoming ${other}\` to see what is on the table` };
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
  if (AMOUNT !== null && AMOUNT !== undefined && Number.isFinite(Number(AMOUNT))) {
    item.amount = Number(AMOUNT);
  }
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
  // A resource offer has to say WHICH resource. The subType is the resource's hash, the same
  // encoding describeItem reads back.
  if (kind === "RESOURCES" && SUBJECT) {
    let hash = null;
    try { hash = GameInfo.Types.lookup(String(SUBJECT).toUpperCase())?.Hash ?? null; } catch { hash = null; }
    if (hash === null) {
      return {
        error: `no such resource: ${SUBJECT}`,
        hint: "name it as the rules do, e.g. RESOURCE_SALT — `civ deal items <player>` lists what you hold",
      };
    }
    item.subType = hash;
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

return { error: `unknown deal mode: ${DEAL_MODE}`, hint: "items, pending, incoming, offer, send, accept, reject, clear" };
