import type { Window } from "happy-dom";
// A miniature Civ 7 for tests (docs/PLAN.md §14, "fixture replay").
//
// This is deliberately not a mock of our own code: it fakes the GAME's API surface and then runs
// the real src/adapter/gamejs/*.js against it in a VM. So the extraction scripts — including the
// fog filtering that §7 depends on — are genuinely exercised without launching Civilization.
import { createContext, runInContext } from "node:vm";
import type { Json } from "../dump/types.ts";
import type { Bridge } from "../adapter/bridge.ts";
import { unwrap, wrapExpression } from "../adapter/bridge.ts";

export type FakeUnit = { id: number; owner: number; type: number; x: number; y: number };
export type FakeCity = { id: number; owner: number; name: string; x: number; y: number; isTown?: boolean; justConquered?: boolean };

export type FakeWorld = {
  width: number;
  height: number;
  turn: number;
  age: string;
  /** playerId -> "x,y" -> 1 fogged | 2 visible. Absent means never revealed. */
  revealed: Record<number, Record<string, 1 | 2>>;
  units: FakeUnit[];
  cities: FakeCity[];
  players: number[];
  /** playerId -> the set of players it has met */
  met: Record<number, number[]>;
  /** Save names requested, so autosave can be asserted in tests. */
  saves: string[];
  /**
   * How many seats must end their turn before the game turn advances. The rest stand in for AI
   * players, which finish on their own. Defaults to one, matching a single-agent match.
   */
  seats: number;
  /** Every argument object handed to CityOperations.sendRequest, so a test can assert the shape
   * build.js actually sends. Guessing that shape cost 25 illegal actions in one live turn. */
  cityRequests: OperationArgs[];
  /** Moves each unit has left this turn, by unit id. Lives on the world, not in the globals
   *  factory: the factory runs afresh for every script evaluation, so state kept there resets
   *  between calls and a skipped unit looked unskipped on the very next command. */
  unitMoves: Map<number, number>;
  /** Units whose move orders are accepted but leave their position and movement unchanged. */
  stalledMoves: Set<number>;
  /** What each player has chosen to research / adopt, by player id. */
  researching: Map<number, number>;
  civic: Map<number, number>;
  /** Players who have answered their pending narrative event. */
  storyAnswered: Set<number>;
  /**
   * Notifications per player. `blocking` stops the turn ending; `dismissible` says whether
   * dismissal clears it. A DECISION (place a citizen, answer a story) is blocking and NOT
   * dismissible — that asymmetry is the whole reason forced end-turn kept failing.
   */
  notifications: Map<
    number,
    Array<{ id: number; name: string; typeHash: number; blocking: boolean; dismissible: boolean; target?: { id: number; owner: number } }>
  >;
  /** Tradition row indices each player has adopted. */
  traditions: Map<number, number[]>;
  /** Diplomacy actions successfully started, as "OPERATION:ACTION" — proof the right one was picked. */
  diplomacyDone: string[];
  /** Items on the working deal, and the deals actually sent. */
  dealItems: Array<{ from: number; to: number; kind: string; amount: number | null }>;
  dealsSent: Array<{ from: number; to: number; items: number }>;
  /** Player pairs currently at war, keyed "a-b". */
  atWar: Set<string>;
  /** Each city's build queue, head first, as type hashes. */
  buildQueue: Map<number, number[]>;
  /** Plots ("x,y") no unit can path to; a move there is refused before it is sent. */
  unreachable: Set<string>;
  /** Gold per player, spent by purchases; absent means the default balance. */
  gold: Map<number, number>;
  /** Every PURCHASE sent, with the arguments the engine was given. */
  purchases: Array<{ city: number; args: OperationArgs }>;
  /** Victories CIV has claimed, as {team, victory-hash}. Drives Game.VictoryManager.getVictories. */
  victories: Array<{ team: number; victory: number }>;
  /** Whether the current age has ended (Game.AgeProgressManager.isAgeOver). */
  ageOver: boolean;
  /** Whether the current age is the FINAL one — only a final-age end is game-over. */
  finalAge: boolean;
  /**
   * The last turn of the current Age, or null when it never ends. Ending it restarts Game.turn
   * at 1, as the real engine does at an Age boundary — the game's own Exploration and Modern
   * advice scripts test `Game.turn == 1` for the first turn of the age.
   */
  ageEndsAfterTurn: number | null;
  /** Per-player resources available to assign, as {index (plot), hash (ResourceType)}. */
  resources: Record<number, Array<{ index: number; hash: number }>>;
  /** ASSIGN_RESOURCE sends recorded, so a test can assert a resource was placed. */
  resourceAssigns: Array<{ player: number; location: unknown; city: number }>;
  /** Resource-to-settlement pairs ("index:cityId") the engine refuses, the way a town refuses a city resource. */
  resourceRefused: Set<string>;
  /**
   * Units that already have standing orders this turn — skipping, asleep, fortified.
   *
   * This is the field whose absence hid the bug. A unit with orders keeps its moves and reports
   * canMove true and hasMoved false, yet the engine does not consider it ready and refuses to
   * skip it again. Our end-turn scanned for `canMove && !hasMoved` and so blocked on three units
   * the game was perfectly happy to end the turn without.
   */
  unitOrdered: Set<number>;
  /** Units part-way through a multi-turn operation (hasPendingOperations on the real unit). */
  unitBusy: Set<number>;
  /** Players the game has eliminated: out of getAlive(). */
  dead: Set<number>;
  /** Dead players the game is still handing a turn to (the defeat turn itself). */
  deadTurnPending: Set<number>;
  /** Beliefs the fake will let a player claim, by BeliefType name. */
  claimableBeliefs: Set<string>;
  /** ADD_BELIEF and FOUND_RELIGION sends recorded, as the argument objects the engine got. */
  beliefRequests: Array<{ op: string; args: OperationArgs }>;
  /** CITYCOMMAND_DESTROY sends: the fate chosen for a conquered settlement. */
  captures: Array<{ city: number; directive: number }>;
  /** Dedication cards on offer at an Age boundary (player.AdvancedStart.getAvailableCards). */
  ageCards: Array<{ id: string; name: string; description: string; effects: Array<{ id: string; amount: number }> }>;
  /** Cards added to the dedication deck, in order. */
  deck: string[];
  /** ADVANCED_START_USE_EFFECT sends, by effect id. */
  effectsUsed: string[];
  /** Whether the deck has been marked complete. */
  deckComplete: boolean;
  /** Combat values per unit: melee strength, and the plots RANGE_ATTACK would offer. */
  unitCombat: Map<number, { melee: number; rangedPlots: number[] | null }>;
  /** Players who have just met player 0 and await a greeting. */
  greetingOwed: Set<number>;
  /** Greetings sent: "other:TYPE". */
  greetings: string[];
  /** Diplomatic proposals waiting on player 0, by action id. */
  proposals: Map<number, { actionType: number; initialPlayer: number }>;
  /** RESPOND_DIPLOMATIC_ACTION sends: "id:TYPE". */
  responses: string[];
  /** Unspent promotion points per unit. */
  promotionPoints: Map<number, number>;
  /** Promotions held, as "unitId:PROMOTION_TYPE". */
  promotionsTaken: Set<string>;
  /** When true, a PROMOTE send is accepted and applied to nothing — the live engine's behaviour for a pick the tree forbids. */
  promotionsStuck: boolean;
  /** Water plots ("x,y"). The map is dry land unless a test says otherwise. */
  water: Set<string>;
  /** Plots ringed by cliffs ("x,y"): every crossing into them reads as a cliff. */
  cliffs: Set<string>;
  /**
   * Where a constructible may go, as the engine reports it: urban plots with a free slot and
   * rural plots it could turn urban. Null means the fake names no plots at all (the old shape).
   * With a list, a BUILD sent WITHOUT a plot queues nothing — the live engine's behaviour.
   */
  buildPlots: { Plots: number[]; ExpandUrbanPlots: number[] } | null;
};

/** A small stable string hash, distinct per name. */
/** Every name this fake game knows, so a hash can be turned back into the name it came from. */
/** Constructibles and projects, BY ROW INDEX — which is how the engine addresses them. */
const FAKE_CONSTRUCTIBLES = ["BUILDING_GRANARY", "PROJECT_TEST", "PROJECT_TOWN_TEST"];

/** One row of the game's UnitPromotionDisciplineDetails table. */
type PromotionRow = { UnitPromotionType: string; UnitPromotionDisciplineType: string; PrereqUnitPromotion: string | null };

/** A two-step promotion tree: TWO needs ONE first, the way the real disciplines chain. */
const FAKE_PROMOTION_TREE: PromotionRow[] = [
  { UnitPromotionType: "PROMOTION_TEST_ONE", UnitPromotionDisciplineType: "DISCIPLINE_TEST", PrereqUnitPromotion: null },
  { UnitPromotionType: "PROMOTION_TEST_TWO", UnitPromotionDisciplineType: "DISCIPLINE_TEST", PrereqUnitPromotion: "PROMOTION_TEST_ONE" },
];

/** Units, BY ROW INDEX — the indices canStartQuery hands back. Sparse, like a real table. */
const FAKE_UNITS: Record<number, string> = {
  77: "UNIT_77",
  88: "UNIT_88",
  100: "UNIT_WARRIOR",
  101: "UNIT_SCOUT",
  102: "UNIT_SETTLER",
};


const KNOWN_NAMES = [
  "UNIT_WARRIOR", "UNIT_SCOUT", "UNIT_77", "UNIT_88",
  "BUILDING_GRANARY", "PROJECT_TEST", "PROJECT_TOWN_TEST",
];

/**
 * The name behind a hash, or NULL when this table does not have it.
 *
 * Null matters. Callers try Units, then Constructibles, then Projects, and fall through on null.
 * Returning `UNIT_<hash>` for anything meant the first table always answered, so a queued
 * BUILDING_GRANARY read back as "UNIT_174846565" and no lookup could ever fall through.
 */
function reverseHash<T>(hash: number, prefix: string, build: (name: string) => T): T | null {
  for (const name of KNOWN_NAMES) {
    if (name.startsWith(prefix) && hashOf(name) === hash) return build(name);
  }
  return null;
}

export function hashOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return h;
}

export function makeWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    width: 8,
    height: 8,
    turn: 42,
    age: "AGE_ANTIQUITY",
    players: [0, 1],
    revealed: {
      0: { "1,1": 2, "2,1": 2, "1,2": 1 },
      1: { "6,6": 2, "6,5": 1 },
    },
    units: [
      { id: 10, owner: 0, type: 100, x: 1, y: 1 },
      { id: 20, owner: 1, type: 101, x: 6, y: 6 }, // p1's unit, invisible to p0
    ],
    cities: [
      { id: 30, owner: 0, name: "Waset", x: 1, y: 1 },
      { id: 40, owner: 1, name: "Hanseong", x: 6, y: 6 },
    ],
    met: { 0: [], 1: [] },
    saves: [],
    seats: 1,
    cityRequests: [],
    unitMoves: new Map(),
    stalledMoves: new Set(),
    researching: new Map(),
    civic: new Map(),
    storyAnswered: new Set(),
    traditions: new Map(),
    unitOrdered: new Set(),
    unitBusy: new Set(),
    dead: new Set(),
    deadTurnPending: new Set(),
    claimableBeliefs: new Set(),
    beliefRequests: [],
    captures: [],
    ageCards: [],
    deck: [],
    effectsUsed: [],
    deckComplete: false,
    unitCombat: new Map(),
    greetingOwed: new Set(),
    greetings: [],
    proposals: new Map(),
    responses: [],
    promotionPoints: new Map(),
    promotionsTaken: new Set(),
    promotionsStuck: false,
    water: new Set(),
    cliffs: new Set(),
    buildPlots: null,
    diplomacyDone: [],
    dealItems: [],
    dealsSent: [],
    atWar: new Set(),
    buildQueue: new Map(),
    unreachable: new Set(),
    gold: new Map(),
    purchases: [],
    victories: [],
    ageOver: false,
    finalAge: false,
    ageEndsAfterTurn: null,
    resources: {},
    resourceAssigns: [],
    resourceRefused: new Set(),
    notifications: new Map(),
    ...overrides,
  };
}

/** Build the globals the gamejs scripts expect. */
/**
 * How the engine addresses a unit, city or notification.
 *
 * Always a ComponentID object in the real game, but call sites in this project pass a bare number
 * often enough that the fake has to accept both — which is itself worth writing down.
 */
type ComponentRef = { id?: number } | number;

/**
 * The numeric id inside a ComponentRef.
 *
 * One place, because the unwrap was written out three times — each an `as` cast plus its own
 * typeof — and a fourth spelling would have been a fourth chance to get it subtly wrong.
 */
function refId(ref: ComponentRef): number {
  return Number(typeof ref === "object" && ref !== null ? ref.id : ref);
}

/** An operation or command type. Real ones are hashed ints; the fake files them under their name. */
type OperationType = string | number;

/** Arguments an operation carries. Shapes differ per operation; all of them are JSON. */
type OperationArgs = Record<string, Json> & { Target?: { id: number; owner: number } };

/** Every global the game-side scripts see. Open by nature: it IS the engine's global namespace. */
type FakeGlobals = Record<string, Json | object>;

function buildGlobals(world: FakeWorld): FakeGlobals {
  // Which seats have ended the current turn. The scripts always run for one PLAYER_ID at a
  // time, so we track the id the running script was compiled with.
  const ended = new Set<number>();
  let lastPlayerId = 0;
  const currentPlayer = () => lastPlayerId;
  const RevealedStates = { HIDDEN: 0, REVEALED: 1, VISIBLE: 2 };
  const visOf = (playerId: number, x: number, y: number) =>
    world.revealed[playerId]?.[`${x},${y}`] ?? RevealedStates.HIDDEN;

  const unitObj = (u: FakeUnit) => {
    const combat = world.unitCombat.get(u.id);
    const base = unitBase(u);
    // Only for units a test gives combat values; the rest are civilians, as before.
    return combat
      ? { ...base, Combat: { canAttack: true, getMeleeStrength: () => combat.melee, rangedStrength: 0 } }
      : base;
  };
  const unitBase = (u: FakeUnit) => ({
    id: { id: u.id, owner: u.owner },
    owner: u.owner,
    type: u.type,
    location: { x: u.x, y: u.y },
    name: `unit-${u.id}`,
    Health: { damage: 0, maxDamage: 100 },
    // Per unit, not a constant: the real game refuses to end a turn while any unit still has
    // moves, so a fake where moves never change cannot exercise end-turn at all.
    Movement: {
      get movementMovesRemaining() { return world.unitMoves.get(u.id) ?? 2; },
      get canMove() { return (world.unitMoves.get(u.id) ?? 2) > 0; },
      // The game blocks the end of a turn on a unit that has not moved AT ALL, not on any unit
      // with moves left. Without this the fake cannot tell the two rules apart.
      get hasMoved() { return world.unitMoves.has(u.id); },
    },
    // panel-action.ts reads canMove and hasMoved OFF THE UNIT, not off unit.Movement. Our port
    // read them from Movement, which is a different object on the real unit.
    get canMove() { return (world.unitMoves.get(u.id) ?? 2) > 0; },
    get hasMoved() { return world.unitMoves.has(u.id); },
    get hasPendingOperations() { return world.unitBusy.has(u.id); },
    // The panel's gate (panel-unit-promotion.ts): points to spend, not held, tree allows it.
    Experience: {
      experiencePoints: 0,
      get getStoredPromotionPoints() { return world.promotionPoints.get(u.id) ?? 0; },
      get canPromote() { return (world.promotionPoints.get(u.id) ?? 0) > 0; },
      hasPromotion: (_disc: string, promo: string) => world.promotionsTaken.has(`${u.id}:${promo}`),
      canEarnPromotion: (_disc: string, promo: string) => {
        const row = FAKE_PROMOTION_TREE.find((r) => r.UnitPromotionType === promo);
        return !!row && (row.PrereqUnitPromotion === null || world.promotionsTaken.has(`${u.id}:${row.PrereqUnitPromotion}`));
      },
    },
    isCommanderUnit: false,
    armyId: null,
  });

  const cityObj = (c: FakeCity) => ({
    id: { id: c.id, owner: c.owner },
    owner: c.owner,
    name: c.name,
    isTown: c.isTown ?? false,
    isJustConqueredFrom: c.justConquered ?? false,
    isCapital: true,
    location: { x: c.x, y: c.y },
    population: 4,
    Growth: { growthType: 0, currentFood: 3, projectType: null },
    // A real QUEUE, because CITYOPERATION_BUILD appends rather than replaces. A fake that only
    // held `currentProductionTypeHash` could not tell the two apart, and the harness spent a live
    // run telling agents "build set to X" while X sat second in a queue they could not see.
    BuildQueue: {
      getTurnsLeft: () => 3,
      currentTurnsLeft: 3,
      get currentProductionTypeHash() {
        return world.buildQueue.get(c.id)?.[0] ?? 999;
      },
      getQueue: () => (world.buildQueue.get(c.id) ?? []).map((type) => ({ type })),
      get isEmpty() {
        return (world.buildQueue.get(c.id) ?? []).length === 0;
      },
    },
    Happiness: { netHappinessPerTurn: 1, hasUnrest: false },
    // What a purchase costs here, so `civ buy` can list a price.
    Gold: { getUnitPurchaseCost: () => 60, getBuildingPurchaseCost: () => 120 },
    Resources: { getAssignedResources: () => [], getTotalCountAssignedResources: () => 0, getAssignedResourcesCap: () => 2 },
    isBeingRazed: false,
    isDistantLands: false,
  });

  const playerObj = (id: number) => ({
    id,
    // A seat is active until it ends its turn, and every seat is active again once the round
    // completes. The fake has no hotseat order of its own, so the multi-agent tests still drive
    // seats directly; this only stops a seat that has ended from being offered the same turn
    // twice, which is how the round loop can be attached mid-round.
    get isTurnActive() { return world.dead.has(id) ? world.deadTurnPending.has(id) && !ended.has(id) : !ended.has(id); },
    get isAlive() { return !world.dead.has(id); },
    civilizationName: `CIV_${id}`,
    // The advisor the settler lens asks: the fake always recommends one spot east of the unit.
    AI: { getBestSettleLocationsForSettler: (_n: number, at: { x: number; y: number }) => [{ location: { x: at.x + 2, y: at.y } }] },
    leaderName: `LEADER_${id}`,
    isMajor: true,
    team: id,
    // Research and civics. The real API hands back node type hashes, and the names only come
    // from GameInfo.ProgressionTreeNodes — the same name/hash split as everything else.
    Techs: {
      getAllAvailableNodeTypes: () => [501, 502],
      getTurnsForNode: (n: number) => n - 497,
      getNodeCost: (n: number) => n * 2,
      // Returns an object whose `.type` is the hash — the real API's shape, verified live.
      // It reflects what was actually chosen, so a test can check the effect and not just the
      // return value. Every worst bug here was an operation that returned ok and changed nothing.
      getResearching: () => (world.researching.has(id) ? { type: world.researching.get(id) } : null),
    },
    // A narrative event waiting on this player. These block the end of a turn in the real game,
    // so the fake carries one to keep `civ story` honest.
    Stories: {
      getFirstPendingMetId: () => (world.storyAnswered.has(id) ? null : { id: 7, owner: id }),
      getFirstPendingDiscoveryLastMetID: () => null,
      find: () => ({ id: 7, type: 4242 }),
    },
    // One object, two jobs, exactly as the real PlayerCulture has: the civics progression tree,
    // and the policy screen. Adding the policy half as a SECOND `Culture` key silently replaced
    // the civics half — the later key wins — and `civ civic` stopped working with nothing said.
    Culture: {
      getAllAvailableNodeTypes: () => [601],
      getTurnsForNode: () => 5,
      getNodeCost: () => 30,
      getResearching: () => (world.civic.has(id) ? { type: world.civic.get(id) } : null),
      // Traditions, ordinary policies and crisis cards are all rows in GameInfo.Traditions, told
      // apart only by which slot kind unlocked them — which is also what decides whether a board
      // is full. A flat list could not model a swap.
      getGovernmentType: () => "GOVERNMENT_CHIEFDOM",
      getUnlockedTraditions: (slot: number) => (slot === 0 ? [0, 1] : []),
      getActiveTraditions: (slot: number) => (slot === 0 ? (world.traditions.get(id) ?? []) : []),
      getNumCultureSlots: (slot: number) => (slot === 0 ? 2 : 1),
      getNumAllCultureSlots: () => 4,
      isTraditionActive: (hash: number) => (world.traditions.get(id) ?? []).includes(hash),
      canSwapCultureSlot: () => true,
      getAllRecentUnlockedTraditions: () => [],
    },
    Units: {
      getUnitIds: () =>
        world.units.filter((u) => u.owner === id).map((u) => ({ owner: u.owner, id: u.id, type: 26 })),
    },
    Cities: {
      getCityIds: () =>
        world.cities.filter((c) => c.owner === id).map((c) => ({ owner: c.owner, id: c.id, type: 27 })),
    },
    Resources: {
      getResources: () => (world.resources[id] ?? []).map((r) => ({ value: r.index, uniqueResource: { resource: r.hash } })),
    },
    Treasury: {
      get goldBalance() {
        return world.gold.get(id) ?? 100 + id;
      },
    },
    // The dedication deck at an Age boundary, the way dedications-model.ts reads it.
    AdvancedStart: {
      getAvailableCards: () => world.ageCards,
      getCards: () => world.deck.map((cardId) => ({ info: world.ageCards.find((c) => c.id === cardId) ?? { id: cardId, effects: [] } })),
      getLegacyPoints: () => [{ category: "CARD_CATEGORY_WILDCARD", value: Math.max(0, 3 - world.deck.length) }],
      getPlacementComplete: () => world.deckComplete,
    },
    Stats: {
      getNetYield: () => 5,
      numCities: world.cities.filter((c) => c.owner === id && !c.isTown).length,
      numTowns: world.cities.filter((c) => c.owner === id && c.isTown).length,
      numSettlements: world.cities.filter((c) => c.owner === id).length,
      settlementCap: 5,
      totalPopulation: 4,
    },
    Happiness: { netHappinessPerTurn: 1, hasUnrest: false, turnsOfUnrest: 0 },
    Diplomacy: {
      hasMet: (other: number) => (world.met[id] ?? []).includes(other),
      isAtWarWith: (other: number) =>
        world.atWar.has(`${id}-${other}`) || world.atWar.has(`${other}-${id}`),
      // The ribbon prints both for every met civ; the harness read neither, so an agent could see
      // who had the bigger economy but not who was closer to winning, or whether a war was safe.
      getTotalWarSupportBonusForPlayer: () => 2,
      getTotalWarSupportBonusForTarget: () => -1,
    },
    Influence: { getSuzerain: () => null },
    // getEnabledLegacyPaths returns [] in a real game too — which is why the harness read nothing
    // and the HUD printed "legacy: none" every turn. Score is keyed by the path's STRING type,
    // the way victory-manager.ts calls it.
    LegacyPaths: {
      getEnabledLegacyPaths: () => [],
      getScore: (type: string) => (type === "LEGACY_PATH_FAKE_SCIENCE" ? 4 : 1),
    },

  });

  /**
   * A GameInfo table, shaped the way the real one is.
   *
   * The real tables are ITERABLE AND NOTHING ELSE — no .map, no .filter, not an array. Modelling
   * them as plain arrays let three call sites use .map, and each threw against the live game:
   * `civ government` failed on every call, so no agent could ever list a government, and
   * actions.js failed while building the legal action list. The fake said all three were fine.
   */
  const table = <T>(list: T[], lookup?: (key: never) => T | null) => ({
    [Symbol.iterator]: () => list[Symbol.iterator](),
    lookup: lookup ?? ((i: number) => list[i] ?? null),
  });

  /** Operations that carry a { Player1, Player2, Type } diplomacy action. */
  const DIPLOMACY_OPERATIONS = new Set([
    "DECLARE_WAR",
    "MAKE_PEACE",
    "OPEN_BORDERS_DIPLOMATIC_ACTION",
  ]);

  const byId = <T extends { id: number }>(list: T[]) => (ref: ComponentRef) =>
    list.find((item) => item.id === refId(ref));

  return {
    __setPlayer: (n: number) => {
      lastPlayerId = n;
    },
    // Saving, so autosave can be exercised without a real game.
    // NONE is 0, not null. endTurnBlocker() checks against it, and a fake that returned null
    // would let a wrong check pass here and fail against the real game.
    EndTurnBlockingTypes: { NONE: 0 },
    SaveTypes: { DEFAULT: 0, SINGLE_PLAYER: 1, HOTSEAT: 2, NETWORK_MULTIPLAYER: 3 },
    CityQueryType: { Unit: 0, Constructible: 1, Project: 2 },
    CityOperationsParametersValues: { Exclusive: 1 },
    SaveLocations: { DEFAULT: 0, LOCAL_STORAGE: 1, FIRAXIS_CLOUD: 2 },
    SaveFileTypes: { GAME_STATE: 0, GAME_CONFIGURATION: 1, GAME_TRANSITION: 2 },
    SaveLocationCategories: { NORMAL: 0, AUTOSAVE: 1, QUICKSAVE: 2 },
    GameStateStorage: { getGameConfigurationSaveType: () => 1 },
    // Operation names live in global enums in the real game, not GameInfo tables. The fake needs
    // the same shape or the catalogue export silently produces an empty file.
    // Keys are short, values are the full accepted names — the shape the real enums have.
    UnitOperationTypes: {
      MOVE_TO: "UNITOPERATION_MOVE_TO",
      SKIP_TURN: "UNITOPERATION_SKIP_TURN",
      FOUND_CITY: "UNITOPERATION_FOUND_CITY",
      RANGE_ATTACK: "UNITOPERATION_RANGE_ATTACK",
      SLEEP: "UNITOPERATION_SLEEP",
      FORTIFY: "UNITOPERATION_FORTIFY",
    },
    UnitCommandTypes: { PROMOTE: "UNITCOMMAND_PROMOTE" },
    CityOperationTypes: { BUILD: "CITYOPERATION_BUILD", CONSIDER_TOWN_PROJECT: "CITYOPERATION_CONSIDER_TOWN_PROJECT" },
    CityCommandTypes: { PURCHASE: "CITYCOMMAND_PURCHASE", DESTROY: "CITYCOMMAND_DESTROY", EXPAND: "CITYCOMMAND_EXPAND" },
    DirectiveTypes: { KEEP: 0, RAZE: 1, LIBERATE_FOUNDER: 2 },
    PlayerOperationTypes: {
      SET_TECH_TREE_NODE: "SET_TECH_TREE_NODE",
      ASSIGN_RESOURCE: "ASSIGN_RESOURCE",
      ADD_BELIEF: "ADD_BELIEF",
      FOUND_RELIGION: "FOUND_RELIGION",
      SET_CULTURE_TREE_NODE: "SET_CULTURE_TREE_NODE",
      CHOOSE_NARRATIVE_STORY_DIRECTION: "CHOOSE_NARRATIVE_STORY_DIRECTION",
      DECLARE_WAR: "DECLARE_WAR",
      CHANGE_TRADITION: "CHANGE_TRADITION",
      CHANGE_GOVERNMENT: "CHANGE_GOVERNMENT",
      CONSIDER_ASSIGN_TRADITIONS: "CONSIDER_ASSIGN_TRADITIONS",
      CONSIDER_ASSIGN_ATTRIBUTE: "CONSIDER_ASSIGN_ATTRIBUTE",
      SET_AGE_TRANSITION_DATA: "SET_AGE_TRANSITION_DATA",
      ADVANCED_START_MODIFY_DECK: "ADVANCED_START_MODIFY_DECK",
      ADVANCED_START_USE_EFFECT: "ADVANCED_START_USE_EFFECT",
      ADVANCED_START_MARK_COMPLETED: "ADVANCED_START_MARK_COMPLETED",
      SELECT_CAPITAL: "SELECT_CAPITAL",
      RESPOND_DIPLOMATIC_FIRST_MEET: "RESPOND_DIPLOMATIC_FIRST_MEET",
      RESPOND_DIPLOMATIC_ACTION: "RESPOND_DIPLOMATIC_ACTION",
      VIEWED_ADVISOR_WARNING: "VIEWED_ADVISOR_WARNING",
      // MAKE_PEACE does NOT end in DIPLOMATIC_ACTION. It was missing from the operation filter,
      // so an agent could declare war and had no way out of it for the rest of the match.
      MAKE_PEACE: "MAKE_PEACE",
      OPEN_BORDERS_DIPLOMATIC_ACTION: "OPEN_BORDERS_DIPLOMATIC_ACTION",
    },
    // TRADITION is 0 so the fake's unlocked list lines up with GameInfo.Traditions row indices.
    DiplomacyActionTypes: {
      DIPLOMACY_ACTION_DECLARE_WAR: 1,
      DIPLOMACY_ACTION_MAKE_PEACE: 2,
      DIPLOMACY_ACTION_OPEN_BORDERS: 3,
    },
    // The engine's own spelling of the first-meet enum, typo included.
    DiplomacyPlayerFirstMeets: {
      PLAYER_REALATIONSHIP_FIRSTMEET_FRIENDLY: 0,
      PLAYER_REALATIONSHIP_FIRSTMEET_NEUTRAL: 1,
      PLAYER_REALATIONSHIP_FIRSTMEET_UNFRIENDLY: 2,
    },
    DiplomaticResponseTypes: { DIPLOMACY_RESPONSE_ACCEPT: 0, DIPLOMACY_RESPONSE_REJECT: 1, DIPLOMACY_RESPONSE_SUPPORT: 2 },
    // Trade. Deals are a stateful builder addressed by an OBJECT, not by two player ids.
    DiplomacyDealDirection: { OUTGOING: 0, INCOMING: 1 },
    DiplomacyDealItemTypes: { ALL: 0, GOLD: 1, RESOURCES: 2, AGREEMENTS: 3 },
    DiplomacyDealItemAgreementTypes: { OPEN_BORDERS: 10 },
    DiplomacyDealProposalActions: { PROPOSED: 1 },
    CultureSlotTypes: {
      TRADITION_CULTURE_SLOT: 0,
      POLICY_CULTURE_SLOT: 1,
      CRISIS_CULTURE_SLOT: 2,
    },
    PlayerOperationParameters: { Activate: 1, Deactivate: 2 },
    RevealedStates,
    YieldTypes: {
      YIELD_FOOD: 1, YIELD_PRODUCTION: 2, YIELD_GOLD: 3, YIELD_SCIENCE: 4,
      YIELD_CULTURE: 5, YIELD_HAPPINESS: 6, YIELD_DIPLOMACY: 7,
    },
    Game: {
      // The header of a pending diplomatic action, the way the reaction panel reads it.
      Diplomacy: {
        getDiplomaticEventData: (id: number) => {
          const proposal = world.proposals.get(Number(id));
          return proposal ? { actionType: proposal.actionType, initialPlayer: proposal.initialPlayer } : null;
        },
      },
      // Religion, the way the belief picker asks: claimable beliefs and founded religions.
      Religion: {
      isBeliefClaimable: (belief: string | number) => world.claimableBeliefs.has(String(belief)),
      hasBeenFounded: (religion: string) => world.beliefRequests.some((r) => r.op === "FOUND_RELIGION" && r.args?.ReligionType === hashOf(religion)),
      getPlayerReligion: () => null,
      },
      // A getter, not a snapshot: the turn advances when a player ends their turn, and the
      // extraction scripts must observe that the same way they would in the real game.
      get turn() {
        return world.turn;
      },
      maxTurns: 250,
      age: world.age,
      AgeProgressManager: {
        getCurrentAgeProgressionPoints: () => 14,
        getMaxAgeProgressionPoints: () => 60,
        get isFinalAge() { return world.finalAge; },
        get isAgeOver() { return world.ageOver; },
        canTransitionToNextAge: () => false,
        ageCountdownStarted: false,
      },
      // CIV's authoritative claimed-victories list. gameover.js reads exactly this.
      VictoryManager: {
        getVictories: () => world.victories.map((v) => ({ team: v.team, victory: v.victory })),
      },
      // Operation APIs. canStart mirrors the real contract: { Success, FailureReasons }.
      UnitOperations: {
        canStartAny: (pid: number) => world.units.some((u) => u.owner === pid),
        // SKIP_TURN is legal ONLY for a unit the engine considers ready. The live game refuses it
        // for every other unit and gives no reason, so a fake that always allows it certified a
        // skip loop that had never once worked.
        canStart: (id: ComponentRef, type: OperationType) => {
          const unitId = refId(id);
          if (type === "UNITOPERATION_SKIP_TURN") {
            return { Success: !world.unitOrdered.has(unitId), FailureReasons: [] };
          }
          // A bare refusal for these, as the live engine gives: no FailureReasons at all.
          if (type === "UNITOPERATION_FORTIFY" || type === "UNITOPERATION_FOUND_CITY") return { Success: false, FailureReasons: [] };
          // The engine answers the ranged query for a naval melee unit too, with the plots it
          // could shell — none, for a galley beside an enemy. That is the shape that misled attack.
          if (type === "UNITOPERATION_RANGE_ATTACK") {
            const plots = world.unitCombat.get(unitId)?.rangedPlots ?? null;
            return plots ? { Success: true, FailureReasons: [], Plots: plots, Modifiers: [] } : { Success: false, FailureReasons: [] };
          }
          return {
            Success: type === "UNITOPERATION_MOVE_TO",
            FailureReasons: ["LOC_FAKE_NOT_ALLOWED"],
          };
        },
        // Skipping spends the unit's moves, which is what unblocks the end of a turn.
        sendRequest: (id: ComponentRef, type: OperationType, args?: OperationArgs) => {
          const unitId = refId(id);
          if (type === "UNITOPERATION_SKIP_TURN") {
            world.unitMoves.set(unitId, 0);
            world.unitOrdered.add(unitId);
          }
          if (type === "UNITOPERATION_MOVE_TO") {
            if (world.stalledMoves.has(unitId)) return;
            world.unitMoves.set(unitId, Math.max(0, (world.unitMoves.get(unitId) ?? 2) - 1));
            // The unit actually MOVES. It used to only lose a move and stay put, so the fake
            // could not tell a real move from the engine accepting an order and doing nothing —
            // which is what 88 of 144 live moves turned out to be, all reported as `ok`.
            const unit = world.units.find((u) => u.id === unitId);
            if (unit && typeof args?.X === "number" && typeof args?.Y === "number") {
              unit.x = args.X;
              unit.y = args.Y;
            }
          }
        },
      },
      UnitCommands: {
        // PROMOTE reads as startable for any pairing, as the live engine does: canStart is not
        // the promotion gate, the panel's Experience checks are.
        canStart: (_id: ComponentRef, type: OperationType) =>
          type === "UNITCOMMAND_PROMOTE"
            ? { Success: true, FailureReasons: [] }
            : { Success: false, FailureReasons: ["LOC_FAKE_NOT_ALLOWED"] },
        sendRequest: (id: ComponentRef, type: OperationType, args?: OperationArgs) => {
          if (type !== "UNITCOMMAND_PROMOTE" || world.promotionsStuck) return;
          const unitId = refId(id);
          const row = FAKE_PROMOTION_TREE.find((r) => hashOf(r.UnitPromotionType) === args?.PromotionType);
          const points = world.promotionPoints.get(unitId) ?? 0;
          const allowed = !!row && points > 0 && (row.PrereqUnitPromotion === null || world.promotionsTaken.has(`${unitId}:${row.PrereqUnitPromotion}`));
          if (!allowed) return; // accepted, applied to nothing
          world.promotionsTaken.add(`${unitId}:${row.UnitPromotionType}`);
          world.promotionPoints.set(unitId, points - 1);
        },
      },
      CityOperations: {
        // With plots configured, the real contract: a bare query lists them, and a query WITH a
        // plot succeeds only for one of them (interface-mode-place-building.ts commitPlot).
        canStart: (_id: ComponentRef, _type: OperationType, args?: OperationArgs) => {
          const plots = world.buildPlots;
          if (!plots || typeof args?.ConstructibleType !== "number") return { Success: true, FailureReasons: [] };
          if (typeof args.X === "number" && typeof args.Y === "number") {
            const index = args.Y * world.width + args.X;
            const legal = [...plots.Plots, ...plots.ExpandUrbanPlots].includes(index);
            return { Success: legal, FailureReasons: legal ? [] : ["LOC_FAKE_BAD_PLOT"] };
          }
          return { Success: true, FailureReasons: [], Plots: plots.Plots, ExpandUrbanPlots: plots.ExpandUrbanPlots };
        },
        // The real signature: an array of { index, result }, where index is a row index into
        // GameInfo.Units / Constructibles / Projects. Getting this wrong printed "[object
        // Object]" for every option in a live run, so the fake mirrors it exactly.
        canStartQuery: (_id: ComponentRef, _type: OperationType, query: number) =>
          query === 0
            ? [
                { index: 77, result: { Success: true, FailureReasons: [] } },
                {
                  index: 88,
                  result: { Success: false, FailureReasons: [], Requirements: { NeededPopulation: 3 } },
                },
              ]
            : [],
        sendRequest: (id: ComponentRef, type: OperationType, args: OperationArgs) => {
          // "I have considered this town's project" is what clears the town-focus prompt, the
          // way the game's production chooser sends it when it opens for a town.
          if (type === "CITYOPERATION_CONSIDER_TOWN_PROJECT") {
            const owner = world.cities.find((c) => c.id === refId(id))?.owner ?? 0;
            world.notifications.set(owner, (world.notifications.get(owner) ?? []).filter((n) => n.name !== "NOTIFICATION_CHOOSE_TOWN_PROJECT"));
            return;
          }
          world.cityRequests.push(args);
          // The engine's encoding rule, enforced.
          //
          // A UNIT is addressed by its type HASH; a CONSTRUCTIBLE or PROJECT by its ROW INDEX
          // (production-chooser-operations.ts: `{ ConstructibleType: constructible.$index }`).
          // Send the wrong one and the engine queues NOTHING while canStart still says yes.
          //
          // This fake used to accept either, so the test named "civ build sends the argument key
          // the engine actually wants" passed against a fake that shared our bug — and a live run
          // answered "BUILDING_GRANARY added to the build queue" in the same turn as "Pārsa has
          // nothing in its build queue". A fake that agrees with the bug tests nothing.
          const cityId = refId(id);
          const queue = (type: number) =>
            world.buildQueue.set(cityId, [...(world.buildQueue.get(cityId) ?? []), type]);

          if (typeof args.UnitType === "number") {
            // Must be a hash, not a row index. Row indices are small; hashes are not.
            if (KNOWN_NAMES.some((n) => hashOf(n) === args.UnitType)) queue(args.UnitType);
            return;
          }
          for (const key of ["ConstructibleType", "ProjectType"] as const) {
            const index = args[key];
            if (typeof index !== "number") continue;
            // A building sent without its plot: the live engine accepts and queues nothing.
            if (key === "ConstructibleType" && world.buildPlots && typeof args.X !== "number") return;
            const row = FAKE_CONSTRUCTIBLES[index];
            // A hash here is the bug: it will not match any row index, so nothing is queued.
            if (row) queue(hashOf(row));
            return;
          }
        },
      },
      CityCommands: {
        // A conquest's fate: keep and raze are open; liberating needs a founder to give it to,
        // which this fake's settlements never have.
        canStart: (_id: ComponentRef, type: OperationType, args?: OperationArgs) =>
          type === "CITYCOMMAND_DESTROY" && args?.Directive === 2
            ? { Success: false, FailureReasons: ["LOC_FAKE_NO_FOUNDER"] }
            : { Success: true, FailureReasons: [] },
        // A purchase offers the same row shape as a build query; here one unit, by row index.
        canStartQuery: (_id: ComponentRef, type: OperationType, query: number) =>
          type === "CITYCOMMAND_PURCHASE" && query === 0
            ? [{ index: 100, result: { Success: true, FailureReasons: [] } }]
            : [],
        sendRequest: (id: ComponentRef, type: OperationType, args: OperationArgs) => {
          if (type === "CITYCOMMAND_DESTROY") {
            const city = world.cities.find((c) => c.id === refId(id));
            if (!city) return;
            world.captures.push({ city: city.id, directive: Number(args.Directive) });
            city.justConquered = false;
            world.notifications.set(city.owner, (world.notifications.get(city.owner) ?? []).filter((n) => n.name !== "NOTIFICATION_CONSIDER_RAZE_CITY"));
            return;
          }
          if (type !== "CITYCOMMAND_PURCHASE") return;
          const cityId = refId(id);
          world.purchases.push({ city: cityId, args });
          // The treasury moves, which is how the CLI knows a purchase took.
          const owner = world.cities.find((c) => c.id === cityId)?.owner ?? 0;
          world.gold.set(owner, (world.gold.get(owner) ?? 100 + owner) - 60);
        },
      },
      PlayerOperations: {
        // eslint-disable-next-line complexity -- a test double covering many operations by design; each op is a short flat branch.
        canStart: (pid: number, type: OperationType, args?: OperationArgs) => {
          if (type === "ADD_BELIEF") {
            const legal = [...world.claimableBeliefs].some((b) => hashOf(b) === args?.BeliefType);
            return { Success: legal, FailureReasons: legal ? [] : [] };
          }
          if (type === "FOUND_RELIGION") return { Success: true, FailureReasons: [] };
          if (type === "SET_AGE_TRANSITION_DATA") return { Success: false, FailureReasons: [] };
          if (type === "RESPOND_DIPLOMATIC_FIRST_MEET") {
            const owed = world.greetingOwed.has(Number(args?.Player2)) && args?.Type !== undefined;
            return { Success: owed, FailureReasons: owed ? [] : [] };
          }
          if (type === "RESPOND_DIPLOMATIC_ACTION") {
            const waiting = world.proposals.has(Number(args?.ID)) && args?.Type !== undefined;
            return { Success: waiting, FailureReasons: waiting ? [] : [] };
          }
          if (type === "ADVANCED_START_MODIFY_DECK") {
            const id = String(args?.ID ?? "");
            const legal = args?.Type === "REMOVE"
              ? world.deck.includes(id)
              : world.ageCards.some((c) => c.id === id) && !world.deck.includes(id) && world.deck.length < 3;
            return { Success: legal, FailureReasons: legal ? [] : ["LOC_FAKE_DECK"] };
          }
          if (type === "ADVANCED_START_MARK_COMPLETED") return { Success: !world.deckComplete, FailureReasons: [] };
          if (type === "ASSIGN_RESOURCE") {
            // SAFETY: the resource script builds Location from getLocationFromIndex, an {x, y}.
            const at = args?.Location as { x: number; y: number } | undefined;
            const index = at ? at.y * world.width + at.x : -1;
            const refused = world.resourceRefused.has(`${index}:${Number(args?.City)}`);
            return { Success: !refused, FailureReasons: refused ? [] : [] };
          }
          if (type === "VIEWED_ADVISOR_WARNING") {
            const valid = args?.Target?.owner === pid && (world.notifications.get(pid) ?? []).some(
              n => n.id === args?.Target?.id && n.name.startsWith("NOTIFICATION_ADVISOR_WARNING_"),
            );
            return { Success: valid, FailureReasons: valid ? [] : ["LOC_FAKE_INVALID_NOTIFICATION_TARGET"] };
          }
          // A fake that says yes to everything cannot test a scan that looks for the one
          // operation the engine accepts — every scan would stop on the first candidate.
          if (typeof type === "string" && DIPLOMACY_OPERATIONS.has(type)) {
            const atWar = world.atWar.has(`${args?.Player1}-${args?.Player2}`);
            const legal =
              type === "DECLARE_WAR"
                ? !atWar && args?.Type === 1
                : type === "MAKE_PEACE"
                  ? atWar && args?.Type === 2
                  : args?.Type === 3;
            return { Success: legal, FailureReasons: legal ? [] : ["LOC_FAKE_NOT_NOW"] };
          }
          return { Success: true, FailureReasons: [] };
        },
        // Record the choice, so getResearching can report it back the way the real game does.
        // eslint-disable-next-line complexity -- a test double covering many operations by design; each op is a short flat branch.
        sendRequest: (pid: number, type: OperationType, args: OperationArgs) => {
          if (type === "VIEWED_ADVISOR_WARNING") {
            if (args.Target?.owner === pid) {
              world.notifications.set(pid, (world.notifications.get(pid) ?? []).filter(
                n => n.id !== args.Target?.id || !n.name.startsWith("NOTIFICATION_ADVISOR_WARNING_"),
              ));
            }
            return;
          }
          if (type === "ASSIGN_RESOURCE") {
            world.resourceAssigns.push({ player: pid, location: args?.Location, city: Number(args?.City) });
            return;
          }
          if (type === "ADD_BELIEF" || type === "FOUND_RELIGION") {
            world.beliefRequests.push({ op: String(type), args });
            return;
          }
          if (type === "CHOOSE_NARRATIVE_STORY_DIRECTION") {
            world.storyAnswered.add(pid);
            return;
          }
          // Diplomacy. Every action shares { Player1, Player2, Type } but each has its OWN
          // operation, so recording the pair is what proves the right one was chosen.
          if (typeof type === "string" && DIPLOMACY_OPERATIONS.has(type)) {
            world.diplomacyDone.push(`${type}:${args?.Type ?? "?"}`);
            if (type === "DECLARE_WAR") world.atWar.add(`${args?.Player1}-${args?.Player2}`);
            if (type === "MAKE_PEACE") world.atWar.delete(`${args?.Player1}-${args?.Player2}`);
            return;
          }
          // Adopting a tradition ANSWERS the traditions decision, which is what clears it.
          // Dismissal does not, and that asymmetry is the whole bug: a forced end-turn dismissed
          // NOTIFICATION_TRADITIONS_AVAILABLE eight times, changed nothing, and stalled the match.
          // Finishing with the policy screen is what clears the notification. Adopting does not:
          // the fake used to clear it on adoption, which made a loop that cost a live run half
          // its end-turns look like correct behaviour.
          if (type === "CONSIDER_ASSIGN_TRADITIONS") {
            world.notifications.set(
              pid,
              (world.notifications.get(pid) ?? []).filter(
                (n) => n.name !== "NOTIFICATION_TRADITIONS_AVAILABLE",
              ),
            );
            return;
          }
          if (type === "ADVANCED_START_MODIFY_DECK") {
            const id = String(args?.ID ?? "");
            if (args?.Type === "REMOVE") world.deck = world.deck.filter((c) => c !== id);
            else if (!world.deck.includes(id)) world.deck.push(id);
            return;
          }
          if (type === "ADVANCED_START_USE_EFFECT") { world.effectsUsed.push(String(args?.ID ?? "")); return; }
          if (type === "RESPOND_DIPLOMATIC_FIRST_MEET") {
            const target = Number(args?.Player2);
            world.greetings.push(`${target}:${args?.Type}`);
            world.greetingOwed.delete(target);
            world.notifications.set(pid, (world.notifications.get(pid) ?? []).filter((n) => n.name !== "NOTIFICATION_PLAYER_MET"));
            return;
          }
          if (type === "RESPOND_DIPLOMATIC_ACTION") {
            const id = Number(args?.ID);
            world.responses.push(`${id}:${args?.Type}`);
            world.proposals.delete(id);
            world.notifications.set(pid, (world.notifications.get(pid) ?? []).filter((n) => !(n.name === "NOTIFICATION_DIPLOMATIC_RESPONSE_REQUIRED" && n.target?.id === id)));
            return;
          }
          if (type === "ADVANCED_START_MARK_COMPLETED") {
            world.deckComplete = true;
            world.notifications.set(pid, (world.notifications.get(pid) ?? []).filter((n) => n.name !== "NOTIFICATION_ADVANCED_START"));
            return;
          }
          // The attribute screen's "considered" signal, sent when it closes; clears the prompt.
          if (type === "CONSIDER_ASSIGN_ATTRIBUTE") {
            world.notifications.set(pid, (world.notifications.get(pid) ?? []).filter((n) => n.name !== "NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL"));
            return;
          }
          if (type === "CHANGE_TRADITION") {
            const index = args?.TraditionType;
            if (typeof index !== "number") return;
            const held = world.traditions.get(pid) ?? [];
            // Action decides which way this goes. A fake that only ever added could not tell an
            // adoption from a swap, and a swap is the only legal move once the slots are full.
            world.traditions.set(
              pid,
              args?.Action === 2 ? held.filter((i) => i !== index) : [...held, index],
            );
            return;
          }
          const node = args?.ProgressionTreeNodeType;
          if (typeof node !== "number") return;
          if (type === "SET_TECH_TREE_NODE") world.researching.set(pid, node);
          if (type === "SET_CULTURE_TREE_NODE") world.civic.set(pid, node);
        },
      },
      // Trade. A working deal is addressed by an OBJECT — { direction, player1, player2 } — and
      // sendWorkingDeal takes a proposal action as its second argument. Every call site had the
      // wrong signature, there was no way to add an item at all, and the harness reported an
      // empty deal as sent. A fake without this could not have caught any of it.
      DiplomacyDeals: {
        getPossibleWorkingDealItems: (_dealId: object, from: number) => [
          { id: 1, from, to: from === 0 ? 1 : 0, type: 1, subType: 0, duration: 0, amount: 100, isValid: true },
          { id: 2, from, to: from === 0 ? 1 : 0, type: 3, subType: 10, duration: 30, amount: null, isValid: true },
        ],
        getDealIds: () => [],
        addItemToWorkingDeal: (dealId: { player1: number; player2: number }, item: { type: number; amount?: number }) => {
          world.dealItems.push({
            from: dealId.player1,
            to: dealId.player2,
            kind: item.type === 1 ? "GOLD" : item.type === 3 ? "AGREEMENTS" : "OTHER",
            amount: item.amount ?? null,
          });
        },
        sendWorkingDeal: (dealId: { player1: number; player2: number }, action: number) => {
          // Without the proposal action the engine has no idea what you are doing. Refusing here
          // is what makes a missing second argument visible instead of silently accepted.
          if (action !== 1) throw new Error("sendWorkingDeal needs a proposal action");
          world.dealsSent.push({
            from: dealId.player1,
            to: dealId.player2,
            items: world.dealItems.length,
          });
        },
        clearWorkingDeal: () => { world.dealItems.length = 0; },
      },
      // A real notification queue, because a blocking notification is the failure that has ended
      // every live match. With the old stub, endTurnBlocker() always returned null, endturn.js
      // never took its blocking branch, the forced-dismissal loop never ran once, and pending.txt
      // was always empty. The bug that stops the benchmark could not be reproduced here at all.
      //
      // getTypeName takes a notification's .Type hash, never its id — the distinction that cost
      // the most in this project, so the fake enforces it.
      Notifications: {
        getIdsForPlayer: (pid: number) =>
          (world.notifications.get(pid) ?? []).map((n) => ({ id: n.id, owner: pid })),
        find: (cid: { id?: number } | number) => {
          const wanted = refId(cid);
          for (const list of world.notifications.values()) {
            const hit = list.find((n) => n.id === wanted);
            // Target is the settlement (or unit) the notification is about, as the real API has it.
            if (hit) return { id: hit.id, Type: hit.typeHash, Target: hit.target };
          }
          return null;
        },
        getTypeName: (typeHash: number) => {
          for (const list of world.notifications.values()) {
            const hit = list.find((n) => n.typeHash === typeHash);
            if (hit) return hit.name;
          }
          return null; // an id was passed where a type hash belongs
        },
        getEndTurnBlockingType: (pid: number) => {
          const blocker = (world.notifications.get(pid) ?? []).find((n) => n.blocking);
          return blocker ? blocker.typeHash : 0; // 0 is NONE
        },
        findEndTurnBlocking: (pid: number, type?: number) => {
          // The real API returns null unless the caller passes the type as well.
          if (type === undefined || type === 0) return null;
          const hit = (world.notifications.get(pid) ?? []).find((n) => n.blocking && n.typeHash === type);
          return hit ? { id: hit.id, owner: pid } : null;
        },
        dismiss: (cid: { id?: number } | number) => {
          const wanted = refId(cid);
          for (const [pid, list] of world.notifications) {
            const next = list.filter((n) => !(n.id === wanted && n.dismissible));
            world.notifications.set(pid, next);
          }
        },
        activate: () => {},
        getSummary: (cid: { id?: number } | number) => {
          const wanted = refId(cid);
          for (const list of world.notifications.values()) {
            const hit = list.find((n) => n.id === wanted);
            if (hit) return hit.name;
          }
          return "";
        },
        getMessage: () => "",
      },
    },
    Network: {
      saveGame: (params: { FileName?: string }) => {
        world.saves.push(params.FileName ?? "unnamed");
      },
      loadGame: () => {},
    },
    // The end-turn gate is the engine's, not ours: panel-action.ts asks getFirstReadyUnit() and
    // reads a user setting. A fake without these could not tell "this unit has moves" apart from
    // "this unit needs orders", and those are different questions — the live game had three units
    // with full moves and no ready unit at all.
    UI: {
      Player: {
        deselectAllUnits: () => {},
        getFirstReadyUnit: () => {
          const pid = currentPlayer();
          const unit = world.units.find(
            (u) => u.owner === pid && !world.unitOrdered.has(u.id) && !world.unitMoves.has(u.id),
          );
          return unit ? { id: unit.id, owner: unit.owner } : null;
        },
      },
    },
    Configuration: {
      getUser: () => ({ isUnitCycle_RemainingMoves: false }),
    },
    GameContext: {
      localPlayerID: 0,
      localObserverID: 0,
      // A game turn advances only once every player has acted, as in a real match. Modelling
      // this correctly matters: each seat must see the SAME turn number within a round, or the
      // per-turn directories diverge and the replay stops lining up.
      // The real GameContext exposes this, and endturn.js checks it to confirm the engine
      // accepted the end of the turn rather than silently ignoring it.
      hasSentTurnComplete: () => ended.has(currentPlayer()),
      sendTurnComplete: () => {
        ended.add(currentPlayer());
        // The defeat turn is offered once; after it the dead seat is out of the rotation.
        if (world.dead.has(currentPlayer())) world.deadTurnPending.delete(currentPlayer());
        // The engine advances once every seat that still gets a turn has ended: the living, plus
        // a dead seat on its defeat turn. A dead seat with no turn to end never holds the round.
        const expected = world.players.filter((id) => !world.dead.has(id) || world.deadTurnPending.has(id)).length;
        if (ended.size >= Math.min(world.seats, expected)) {
          world.unitMoves.clear(); // a new turn restores every unit's moves
          world.unitOrdered.clear(); // ...and clears their standing orders
          ended.clear();
          world.turn = world.turn === world.ageEndsAfterTurn ? 1 : world.turn + 1;
        }
      },
    },
    Database: { makeHash: hashOf },
    GameInfo: {
      UnitPromotionDisciplineDetails: FAKE_PROMOTION_TREE,
      Beliefs: [
        { BeliefType: "BELIEF_TEST_TITHE", BeliefClassType: "BELIEF_CLASS_FOUNDER", Name: "Tithe", Description: "gold per follower" },
        { BeliefType: "BELIEF_TEST_LOCKED", BeliefClassType: "BELIEF_CLASS_FOUNDER", Name: "Locked", Description: "not yet" },
        { BeliefType: "BELIEF_TEST_PANTHEON", BeliefClassType: "BELIEF_CLASS_PANTHEON", Name: "Pantheon", Description: "a pantheon belief" },
      ],
      Religions: [
        { ReligionType: "RELIGION_TEST_ONE", Name: "One" },
        { ReligionType: "RELIGION_TEST_TWO", Name: "Two" },
      ],
      UnitPromotions: { lookup: (h: number) => { const row = FAKE_PROMOTION_TREE.find((r) => hashOf(r.UnitPromotionType) === h); return row ? { Name: row.UnitPromotionType, Description: `does ${row.UnitPromotionType}` } : null; } },
      Terrains: { lookup: (h: number) => ({ TerrainType: `TERRAIN_${h}` }) },
      Victories: { lookup: (h: number) => ({ VictoryType: `VICTORY_${h}` }) },
      // The leaders an agent may pick at setup. RANDOM is a placeholder the list script filters out.
      Leaders: table([
        { LeaderType: "LEADER_XERXES", Name: "Xerxes" },
        { LeaderType: "LEADER_HATSHEPSUT", Name: "Hatshepsut" },
        { LeaderType: "LEADER_RANDOM", Name: "Random" },
      ]),
      Biomes: { lookup: (h: number) => ({ BiomeType: `BIOME_${h}` }) },
      Features: { lookup: () => null },
      Resources: { lookup: (h: number) => ({ ResourceType: `RESOURCE_${h}`, ResourceClassType: "RESOURCECLASS_CITY" }) },
      Continents: { lookup: (h: number) => ({ ContinentType: `CONTINENT_${h}` }) },
      // These reverse the SAME hash Types.lookup produces, so a thing chosen by name reads back
      // as that name. Returning `UNIT_${h}` for any hash meant a queued UNIT_WARRIOR read back as
      // "UNIT_896713063", and no test could tell a correct round-trip from a broken one.
      // lookup serves two callers: the build query hands it a ROW INDEX, and naming a queued item
      // hands it a HASH. The real table accepts both, so the fake must too — and must return null
      // for a hash it does not own, or callers can never fall through to the next table.
      Units: {
        // The classes the refusal text reads: a settler is civilian, the rest are land combat.
        lookup: (key: number) =>
          FAKE_UNITS[key] !== undefined
            ? { UnitType: FAKE_UNITS[key], FormationClass: FAKE_UNITS[key] === "UNIT_SETTLER" ? "FORMATION_CLASS_CIVILIAN" : "FORMATION_CLASS_LAND_COMBAT", Domain: "DOMAIN_LAND" }
            : reverseHash(key, "UNIT_", (n) => ({ UnitType: n })),
      },
      // Iterable AND indexable, like the real table: `civ build` walks it to turn a name into
      // the ROW INDEX the engine wants. A lookup-only stub meant the walk found nothing and the
      // build silently never happened.
      // Buildings only. Projects have their own table below; one shared list put the town focus
      // in here too, and `civ build <town> PROJECT_TOWN_X` went out as a constructible.
      Constructibles: Object.assign(
        table(FAKE_CONSTRUCTIBLES.map((name, index) => ({ ConstructibleType: name, $index: index }))
          .filter((row) => row.ConstructibleType.startsWith("BUILDING_"))),
        {
          lookup: (key: number) =>
            FAKE_CONSTRUCTIBLES[key] !== undefined
              ? { ConstructibleType: FAKE_CONSTRUCTIBLES[key] }
              : reverseHash(key, "BUILDING_", (n) => ({ ConstructibleType: n })),
        },
      ),
      // Only the projects, by the row index sendRequest expects. A town-only focus project sits
      // beside a city project so the listing's town/city split can be tested.
      Projects: Object.assign(
        table([
          { ProjectType: "PROJECT_TEST", $index: 1, CityOnly: true, TownOnly: false },
          { ProjectType: "PROJECT_TOWN_TEST", $index: 2, CityOnly: false, TownOnly: true },
        ]),
        { lookup: (h: number) => reverseHash(h, "PROJECT_", (n) => ({ ProjectType: n })) },
      ),
      // Reverses the same hash Types.lookup produces, so a node chosen by name reads back as
      // that name. A fake that cannot round-trip cannot check that a choice actually took.
      // Traditions are addressed by ROW INDEX, not by hash. Keeping $index here is what lets a
      // test catch the encoding being wrong again.
      Traditions: table([
        { TraditionType: "TRADITION_FAKE_DISCIPLINE", $index: 0 },
        { TraditionType: "TRADITION_FAKE_ISONOMY", $index: 1 },
      ]),
      LegacyPaths: table([
        { LegacyPathType: "LEGACY_PATH_FAKE_SCIENCE", EnabledByDefault: true },
        { LegacyPathType: "LEGACY_PATH_FAKE_CULTURE", EnabledByDefault: true },
      ]),
      AgeProgressionMilestones: table([
        { LegacyPathType: "LEGACY_PATH_FAKE_SCIENCE", FinalMilestone: true, RequiredPathPoints: 12 },
        { LegacyPathType: "LEGACY_PATH_FAKE_CULTURE", FinalMilestone: true, RequiredPathPoints: 9 },
      ]),
      NarrativeStories: { lookup: () => ({ NarrativeStoryType: "STORY_FAKE_DISCOVERY" }) },
      NarrativeStory_Links: table([
        { FromNarrativeStoryType: "STORY_FAKE_DISCOVERY", ToNarrativeStoryType: "STORY_FAKE_ACCEPT" },
        { FromNarrativeStoryType: "STORY_FAKE_DISCOVERY", ToNarrativeStoryType: "STORY_FAKE_REFUSE" },
      ]),
      ProgressionTreeNodes: {
        lookup: (h: number) => {
          for (const n of ["NODE_TECH_501", "NODE_TECH_502", "NODE_TECH_601"]) {
            if (hashOf(n) === h) return { ProgressionTreeNodeType: n };
          }
          return { ProgressionTreeNodeType: `NODE_TECH_${h}` };
        },
      },
      // whatcan.js enumerates the game's own catalogue rather than a hand-kept list, so the
      // fake needs one too.
      UnitOperations: table([
        { OperationType: "UNITOPERATION_MOVE_TO" },
        { OperationType: "UNITOPERATION_SKIP_TURN" },
        { OperationType: "UNITOPERATION_FOUND_CITY" },
      ]),
      UnitCommands: table([{ CommandType: "UNITCOMMAND_PROMOTE" }]),
      // Governments were absent entirely, so `civ government` could not be exercised at all.
      Governments: table([
        { GovernmentType: "GOVERNMENT_FAKE_CHIEFDOM", $index: 0, Name: "Chiefdom", Description: "A fake." },
        { GovernmentType: "GOVERNMENT_FAKE_REPUBLIC", $index: 1, Name: "Republic", Description: "Also fake." },
      ]),
      // GameInfo.Types is how build.js decides whether a name is a unit, a building or a
      // project, and what hash to send. Without it the fake would pass a build that the real
      // game rejects.
      Types: {
        // Only names this fake game actually has, because GameInfo.Types.lookup returning a row
        // for an invented name is how a "does this exist" check silently stops checking.
        lookup: (name: string) => {
          const known: Record<string, string> = {
            NODE_TECH_501: "KIND_TREE_NODE",
            NODE_TECH_502: "KIND_TREE_NODE",
            NODE_TECH_601: "KIND_TREE_NODE",
            UNIT_WARRIOR: "KIND_UNIT",
            UNIT_77: "KIND_UNIT",
            UNIT_88: "KIND_UNIT",
            BUILDING_GRANARY: "KIND_CONSTRUCTIBLE",
            BELIEF_TEST_TITHE: "KIND_BELIEF",
            BELIEF_TEST_LOCKED: "KIND_BELIEF",
            RELIGION_TEST_ONE: "KIND_RELIGION",
            RELIGION_TEST_TWO: "KIND_RELIGION",
            PROJECT_TEST: "KIND_PROJECT",
            PROJECT_TOWN_TEST: "KIND_PROJECT",
          };
          const kind = known[name];
          // Distinct per NAME, not per length. The old `name.length * -7919` gave every
          // 13-character node the same hash, so a chosen tech always read back as the first one
          // and the "did the choice take?" assertion could not fail.
          return kind ? { Kind: kind, Hash: hashOf(name) } : null;
        },
      },
    },
    Locale: { compose: (s: string) => s },
    Players: {
      get: (id: number) => (world.players.includes(id) ? playerObj(id) : null),
      getAlive: () => world.players.filter((id) => !world.dead.has(id)).map(playerObj),
      isHuman: () => true,
    },
    // Built on demand, from the live record.
    //
    // This used to be `world.units.map(unitObj)` — evaluated ONCE, when the globals were built,
    // which is once per FakeBridge. Every unit's position was frozen at match start, so a test
    // could not tell a unit that moved from one that did not, and the harness bug where the
    // engine accepts a move order and does nothing was invisible here.
    MapUnits: {
      getUnits: (x: number, y: number) => world.units.filter((u) => u.x === x && u.y === y).map((u) => u.id),
    },
    Units: {
      get: (ref: ComponentRef) => {
        const found = world.units.find((u) => u.id === refId(ref));
        return found ? { ...unitObj(found), id: found.id } : undefined;
      },
      // The real shape: a list of plots, empty when there is no way there.
      getPathTo: (_ref: ComponentRef, to: { x: number; y: number }) =>
        world.unreachable.has(`${to.x},${to.y}`) ? { plots: [], turns: [] } : { plots: [to], turns: [1] },
    },
    Cities: { get: byId(world.cities.map(cityObj).map((c, i) => ({ ...c, id: world.cities[i]!.id }))) },
    GameplayMap: {
      getGridWidth: () => world.width,
      getGridHeight: () => world.height,
      getLocationFromIndex: (idx: number) => ({ x: idx % world.width, y: Math.floor(idx / world.width) }),
      getRevealedState: visOf,
      getTerrainType: () => 1,
      getBiomeType: () => 2,
      getFeatureType: () => -1,
      getResourceType: () => -1,
      isWater: (x: number, y: number) => world.water.has(`${x},${y}`),
      isImpassable: () => false,
      getPlotDistance: (x1: number, y1: number, x2: number, y2: number) => Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2)),
      getDirectionToPlot: (_from: { x: number; y: number }, to: { x: number; y: number }) => (world.cliffs.has(`${to.x},${to.y}`) ? 1 : 0),
      // Direction 1 is the fake's "into a cliff plot" edge; 0 is open ground.
      isCliffCrossing: (_x: number, _y: number, direction: number) => direction !== 1,
      isNavigableRiver: () => false,
      isMountain: () => false,
      getContinentType: () => 3,
      getElevation: () => 100,
      getOwner: (x: number, y: number) =>
        world.cities.find((c) => c.x === x && c.y === y)?.owner ?? -1,
      getOwningCityFromXY: (x: number, y: number) => {
        const city = world.cities.find((c) => c.x === x && c.y === y);
        return city ? { id: city.id } : null;
      },
    },
  };
}

type FakeUiGlobals = {
  document?: Window["document"];
  getComputedStyle?: Window["getComputedStyle"];
  CustomEvent?: Window["CustomEvent"];
  GameContext?: { localPlayerID: number };
  InputActionStatuses?: { FINISH: number };
};

/** A Bridge that runs the real gamejs scripts against the fake world. */
export class FakeBridge implements Bridge {
  #context: object;

  constructor(world: FakeWorld, uiGlobals: FakeUiGlobals = {}) {
    this.#context = createContext({ ...buildGlobals(world), ...uiGlobals });
  }

  async eval<T = unknown>(js: string): Promise<T> {
    // The adapter prefixes every script with `const PLAYER_ID = n;`. Mirror that into the fake
    // so end-turn accounting knows which seat is acting.
    const declared = /const PLAYER_ID = (\d+);/.exec(js);
    if (declared) (this.#context as { __setPlayer?: (n: number) => void }).__setPlayer?.(Number(declared[1]));
    // Same contract as the real transports: the bridge wraps, so the game returns a JSON string.
    const raw = runInContext(wrapExpression(js), this.#context) as string;
    return unwrap<T>(raw);
  }

  async close(): Promise<void> {}
}
