// Is the match actually playing, or only returning ok?
//
// Every wrong claim made about this project came from trusting a return value. `civ research`
// returned ok for weeks while SET_TECH_TREE_TARGET_NODE quietly did nothing; an action-surface
// audit counted that operation as working because canStart said Success. Tests pass against a
// fake game, and log lines scroll whether or not the agent inside is playing.
//
// So this asks the GAME what is true, and reports one line per claim. Run it against a live match.
import { loadEnv } from "../../src/config/env.ts";
import { listTargets, CdpBridge } from "../../src/adapter/cdp.ts";

loadEnv();

const targets = await listTargets(9444);
const game = targets.find((t) => t.url.includes("root-game"));
if (!game) {
  console.log("FAIL  no gameplay context — no match is running");
  process.exit(1);
}
const bridge = await CdpBridge.connect(game.webSocketDebuggerUrl);

const state = await bridge.eval<{
  turn: number;
  players: Array<{
    id: number;
    melee: number | string | null;
    unitFields: number;
    tileYield: number | string | null;
    rivalGold: number | string | null;
    researching: string | null;
    progress: number | null;
    newReads: string | null;
    civics: string | null;
    cities: number;
    units: number;
    building: string | null;
    met: number;
  }>;
}>(`
  const name = (hash) => {
    try { return (GameInfo.ProgressionTreeNodes.lookup(hash) || {}).ProgressionTreeNodeType || null; }
    catch (e) { return null; }
  };
  const nodeOf = (tree) => {
    try { const r = tree && tree.getResearching && tree.getResearching(); return r ? r : null; }
    catch (e) { return null; }
  };
  const players = [];
  for (const p of Players.getAlive() || []) {
    if (!(p.isMajor ?? true)) continue;
    const tech = nodeOf(p.Techs);
    const civic = nodeOf(p.Culture);
    const cityIds = (p.Cities && p.Cities.getCityIds && p.Cities.getCityIds()) || [];
    let building = null;
    try {
      const c = cityIds.length ? Cities.get(cityIds[0]) : null;
      const h = c && c.BuildQueue ? c.BuildQueue.currentProductionTypeHash : null;
      // -1 is Civ's "none" sentinel. Treating it as a value reported an empty queue as healthy.
      if (h && h !== -1) {
        const u = GameInfo.Units.lookup(h) || GameInfo.Constructibles.lookup(h) || GameInfo.Projects.lookup(h);
        building = u ? (u.UnitType || u.ConstructibleType || u.ProjectType) : String(h);
      }
    } catch (e) { building = "err"; }
    let met = 0;
    try { for (const q of Players.getAlive() || []) if (q.id !== p.id && p.Diplomacy && p.Diplomacy.hasMet && p.Diplomacy.hasMet(q.id)) met++; }
    catch (e) { met = -1; }
    // The fields added from reading the game's source, never yet confirmed against the real API.
    // A wrong accessor here reads as null rather than throwing, so it has to be checked explicitly.
    let melee = null, unitFields = 0;
    try {
      const first = ((p.Units && p.Units.getUnitIds && p.Units.getUnitIds()) || [])[0];
      const u = first ? Units.get(first) : null;
      if (u) {
        melee = (u.Combat && u.Combat.meleeStrength) ?? null;
        unitFields = Object.keys(u.Movement || {}).length + Object.keys(u.Combat || {}).length;
      }
    } catch (e) { melee = "err"; }

    let tileYield = null;
    try {
      const raw = GameplayMap.getYields(GameplayMap.getIndexFromLocation({ x: 1, y: 1 }), p.id);
      tileYield = raw ? raw.length : null;
    } catch (e) { tileYield = "err"; }

    let rivalGold = null;
    try {
      for (const q of Players.getAlive() || []) {
        if (q.id === p.id) continue;
        if (!(p.Diplomacy && p.Diplomacy.hasMet && p.Diplomacy.hasMet(q.id))) continue;
        rivalGold = (q.Stats && q.Stats.getNetYield) ? q.Stats.getNetYield(YieldTypes.YIELD_GOLD) : null;
        break;
      }
    } catch (e) { rivalGold = "err"; }

    // The state added by reading the game's source, exercised here with the SAME arity the dump
    // uses. If any of these had wrong arity the game would segfault during this eval; surviving it
    // is the proof the dump is safe. A JS-level miss just reports "err".
    let newReads = null;
    try {
      const bits = [];
      bits.push("gw=" + (p.Stats && p.Stats.getTotalGreatWorksSlotted ? p.Stats.getTotalGreatWorksSlotted() : "na"));
      bits.push("conq=" + (p.Stats && p.Stats.getNumConqueredSettlements ? p.Stats.getNumConqueredSettlements(true, true, true, false) : "na"));
      bits.push("eta=" + (tech && p.Techs && p.Techs.getTurnsForNode ? p.Techs.getTurnsForNode(tech.type) : "na"));
      bits.push("rel=" + (p.Religion && p.Religion.hasCreatedReligion ? p.Religion.hasCreatedReligion() : "na"));
      bits.push("trade=" + (p.Trade && p.Trade.countPlayerTradeRoutes ? p.Trade.countPlayerTradeRoutes() : "na"));
      // ASSIGN_RESOURCE arity: getResources() + getLocationFromIndex + canStart({Location,City}).
      // Surviving this eval proves the arity is safe (wrong arity would segfault, not return).
      try {
        const rl = p.Resources && p.Resources.getResources ? p.Resources.getResources() : [];
        const r0 = rl && rl[0];
        const cid0 = p.Cities && p.Cities.getCityIds ? p.Cities.getCityIds()[0] : null;
        let rok = "na";
        if (r0 && r0.value != null && cid0 && GameplayMap.getLocationFromIndex && Game.PlayerOperations) {
          const loc = GameplayMap.getLocationFromIndex(r0.value);
          rok = String(Game.PlayerOperations.canStart(p.id, PlayerOperationTypes.ASSIGN_RESOURCE, { Location: loc, City: cid0.id }, false) != null);
        }
        bits.push("res=" + (rl ? rl.length : "na") + "/assignCanStart=" + rok);
      } catch (e) { bits.push("res=err"); }
      if (p.isIndependent && Game.IndependentPowers && Game.IndependentPowers.independentName) {
        bits.push("ind=" + Game.IndependentPowers.independentName(p.id));
      }
      newReads = bits.join(" ");
    } catch (e) { newReads = "err: " + String(e); }

    players.push({
      newReads,
      melee,
      unitFields,
      tileYield,
      rivalGold,
      id: p.id,
      researching: tech ? name(tech.type) : null,
      progress: tech ? tech.progress : null,
      civics: civic ? name(civic.type) : null,
      cities: cityIds.length,
      units: ((p.Units && p.Units.getUnitIds && p.Units.getUnitIds()) || []).length,
      building,
      met,
    });
  }
  return { turn: Game.turn, players };
`);

// The APIs the 2026-08 harness fixes lean on, none of which a fake can confirm. A wrong accessor
// here returns null rather than throwing, so silence in this output is the bug.
const apis = await bridge.eval<Record<string, string | boolean | null>>(`
  const out = {};
  try {
    const p = Players.getAlive().find((x) => x.isMajor ?? true);
    const uid = p && p.Units && p.Units.getUnitIds ? p.Units.getUnitIds()[0] : null;
    const unit = uid ? Units.get(uid) : null;
    out.hasPendingOperations = unit ? typeof unit.hasPendingOperations : "no unit to test";
    out.operationQueueSize = unit ? typeof unit.operationQueueSize : "no unit to test";
  } catch (e) { out.unitStateErr = String(e); }
  try {
    const t = Game.Notifications.getEndTurnBlockingType(0);
    out.blockerTypeName = t ? String(Game.Notifications.getTypeName(t)) : "no blocker to test";
  } catch (e) { out.blockerTypeName = "err: " + String(e); }
  try { out.hasSentTurnComplete = typeof GameContext.hasSentTurnComplete; } catch (e) { out.hasSentTurnComplete = null; }
  try {
    out.dealIncomingApi = typeof Game.DiplomacyDeals.getWorkingDeal;
    out.dealItemApi = typeof Game.DiplomacyDeals.getWorkingDealItem;
    out.dealAccept = typeof DiplomacyDealProposalActions.ACCEPTED;
    out.dealReject = typeof DiplomacyDealProposalActions.REJECTED;
  } catch (e) { out.dealErr = String(e); }
  try {
    const link = null;
    for (const l of GameInfo.NarrativeStory_Links) {
      out.storyLookup = String((GameInfo.NarrativeStories.lookup(Database.makeHash(l.ToNarrativeStoryType)) || {}).NarrativeStoryType || null);
      break;
    }
  } catch (e) { out.storyLookup = "err: " + String(e); }
  try { out.gridWidth = String(GameplayMap.getGridWidth()); } catch (e) { out.gridWidth = null; }
  return out;
`);
await bridge.close();

console.log(`turn ${state.turn}\n`);
let failures = 0;
const check = (ok: boolean, label: string, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(28)} ${detail}`);
};

for (const p of state.players) {
  console.log(`-- player ${p.id}`);
  check(p.cities > 0, "has a settlement", `${p.cities} cities`);
  check(p.units > 0, "has units", `${p.units} units`);
  check(p.researching !== null, "is researching something", p.researching ?? "NOTHING");
  check(p.civics !== null, "has a civic in progress", p.civics ?? "NOTHING");
  check(p.building !== null, "is building something", p.building ?? "NOTHING");
  // Not a failure: contact takes many turns, and this is the number that gates chat and trade.
  console.log(`      met                          ${p.met} other civs`);
  // The state added by reading the game's source. Each one is an accessor that could be wrong,
  // and a wrong accessor returns null rather than throwing — so silence here is the bug.
  check(p.unitFields > 0, "unit detail is populated", `${p.unitFields} movement/combat fields`);
  check(p.melee !== null && p.melee !== "err", "unit combat strength reads", String(p.melee));
  check(p.tileYield !== null && p.tileYield !== "err", "tile yields read", `${p.tileYield} yield types`);
  if (p.met > 0) {
    check(p.rivalGold !== null && p.rivalGold !== "err", "rival standing reads", String(p.rivalGold));
  }
  // The freshly-added state reads. Surviving the eval at all proves their arity is safe (a wrong
  // one would have crashed the game here, not returned "err").
  check(p.newReads != null && !String(p.newReads).startsWith("err"), "new state reads (arity-safe)", String(p.newReads));
}

console.log("-- engine APIs the harness leans on (a null or err here is a live bug)");
check(apis.hasPendingOperations === "boolean" || apis.hasPendingOperations === "no unit to test", "unit.hasPendingOperations", String(apis.hasPendingOperations ?? apis.unitStateErr ?? "null"));
check(apis.operationQueueSize === "number" || apis.operationQueueSize === "no unit to test", "unit.operationQueueSize", String(apis.operationQueueSize ?? "null"));
check(typeof apis.blockerTypeName === "string" && !String(apis.blockerTypeName).startsWith("err"), "blocker type resolves to a name", String(apis.blockerTypeName));
check(apis.hasSentTurnComplete === "function", "GameContext.hasSentTurnComplete", String(apis.hasSentTurnComplete ?? "null"));
check(apis.dealIncomingApi === "function", "DiplomacyDeals.getWorkingDeal", String(apis.dealIncomingApi ?? apis.dealErr ?? "null"));
check(apis.dealItemApi === "function", "DiplomacyDeals.getWorkingDealItem", String(apis.dealItemApi ?? "null"));
check(apis.dealAccept === "number" || apis.dealAccept === "string", "DealProposalActions.ACCEPTED", String(apis.dealAccept ?? "null"));
check(typeof apis.storyLookup === "string" && !String(apis.storyLookup).startsWith("err"), "story option text lookup", String(apis.storyLookup));
check(apis.gridWidth !== null, "GameplayMap.getGridWidth (wrap)", String(apis.gridWidth));

console.log(`\n${failures === 0 ? "all claims hold" : `${failures} claims FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
