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
export type FakeCity = { id: number; owner: number; name: string; x: number; y: number; isTown?: boolean };

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
  notifications: Map<number, Array<{ id: number; name: string; typeHash: number; blocking: boolean; dismissible: boolean }>>;
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
  /** Victories CIV has claimed, as {team, victory-hash}. Drives Game.VictoryManager.getVictories. */
  victories: Array<{ team: number; victory: number }>;
  /** Whether the current age has ended (Game.AgeProgressManager.isAgeOver). */
  ageOver: boolean;
  /** Whether the current age is the FINAL one — only a final-age end is game-over. */
  finalAge: boolean;
  /** Per-player resources available to assign, as {index (plot), hash (ResourceType)}. */
  resources: Record<number, Array<{ index: number; hash: number }>>;
  /** ASSIGN_RESOURCE sends recorded, so a test can assert a resource was placed. */
  resourceAssigns: Array<{ player: number; location: unknown; city: number }>;
  /**
   * Units that already have standing orders this turn — skipping, asleep, fortified.
   *
   * This is the field whose absence hid the bug. A unit with orders keeps its moves and reports
   * canMove true and hasMoved false, yet the engine does not consider it ready and refuses to
   * skip it again. Our end-turn scanned for `canMove && !hasMoved` and so blocked on three units
   * the game was perfectly happy to end the turn without.
   */
  unitOrdered: Set<number>;
};

/** A small stable string hash, distinct per name. */
/** Every name this fake game knows, so a hash can be turned back into the name it came from. */
/** Constructibles and projects, BY ROW INDEX — which is how the engine addresses them. */
const FAKE_CONSTRUCTIBLES = ["BUILDING_GRANARY", "PROJECT_TEST"];

/** Units, BY ROW INDEX — the indices canStartQuery hands back. Sparse, like a real table. */
const FAKE_UNITS: Record<number, string> = {
  77: "UNIT_77",
  88: "UNIT_88",
  100: "UNIT_WARRIOR",
  101: "UNIT_SCOUT",
};


const KNOWN_NAMES = [
  "UNIT_WARRIOR", "UNIT_SCOUT", "UNIT_77", "UNIT_88",
  "BUILDING_GRANARY", "PROJECT_TEST",
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

function hashOf(name: string): number {
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
    researching: new Map(),
    civic: new Map(),
    storyAnswered: new Set(),
    traditions: new Map(),
    unitOrdered: new Set(),
    diplomacyDone: [],
    dealItems: [],
    dealsSent: [],
    atWar: new Set(),
    buildQueue: new Map(),
    victories: [],
    ageOver: false,
    finalAge: false,
    resources: {},
    resourceAssigns: [],
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
type OperationArgs = Record<string, Json>;

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

  const unitObj = (u: FakeUnit) => ({
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
    Experience: { experiencePoints: 0 },
    isCommanderUnit: false,
    armyId: null,
  });

  const cityObj = (c: FakeCity) => ({
    id: { id: c.id, owner: c.owner },
    owner: c.owner,
    name: c.name,
    isTown: c.isTown ?? false,
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
    isBeingRazed: false,
    isDistantLands: false,
  });

  const playerObj = (id: number) => ({
    id,
    // The fake has no hotseat rotation; every seat is always able to act.
    // Every seat reads as active. Hotseat really has one at a time, but the fake has no turn
    // order of its own and the multi-agent tests drive seats directly; making this exclusive
    // made activeSeat() poll for its full timeout and hung the suite.
    isTurnActive: true,
    civilizationName: `CIV_${id}`,
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
    Treasury: { goldBalance: 100 + id },
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
    },
    UnitCommandTypes: { PROMOTE: "UNITCOMMAND_PROMOTE" },
    CityOperationTypes: { BUILD: "CITYOPERATION_BUILD" },
    CityCommandTypes: { PURCHASE: "CITYCOMMAND_PURCHASE" },
    PlayerOperationTypes: {
      SET_TECH_TREE_NODE: "SET_TECH_TREE_NODE",
      ASSIGN_RESOURCE: "ASSIGN_RESOURCE",
      SET_CULTURE_TREE_NODE: "SET_CULTURE_TREE_NODE",
      CHOOSE_NARRATIVE_STORY_DIRECTION: "CHOOSE_NARRATIVE_STORY_DIRECTION",
      DECLARE_WAR: "DECLARE_WAR",
      CHANGE_TRADITION: "CHANGE_TRADITION",
      CHANGE_GOVERNMENT: "CHANGE_GOVERNMENT",
      CONSIDER_ASSIGN_TRADITIONS: "CONSIDER_ASSIGN_TRADITIONS",
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
        canStart: () => ({ Success: false, FailureReasons: ["LOC_FAKE_NOT_ALLOWED"] }),
        sendRequest: () => {},
      },
      CityOperations: {
        canStart: () => ({ Success: true, FailureReasons: [] }),
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
        sendRequest: (id: ComponentRef, _type: OperationType, args: OperationArgs) => {
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
            const row = FAKE_CONSTRUCTIBLES[index];
            // A hash here is the bug: it will not match any row index, so nothing is queued.
            if (row) queue(hashOf(row));
            return;
          }
        },
      },
      CityCommands: {
        canStart: () => ({ Success: true, FailureReasons: [] }),
        sendRequest: () => {},
      },
      PlayerOperations: {
        canStart: (pid: number, type: OperationType, args?: OperationArgs) => {
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
          if (type === "ASSIGN_RESOURCE") {
            world.resourceAssigns.push({ player: pid, location: args?.Location, city: Number(args?.City) });
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
            if (hit) return { id: hit.id, Type: hit.typeHash };
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
        if (ended.size >= world.seats) {
          world.unitMoves.clear(); // a new turn restores every unit's moves
          world.unitOrdered.clear(); // ...and clears their standing orders
          ended.clear();
          world.turn += 1;
        }
      },
    },
    GameInfo: {
      Terrains: { lookup: (h: number) => ({ TerrainType: `TERRAIN_${h}` }) },
      Victories: { lookup: (h: number) => ({ VictoryType: `VICTORY_${h}` }) },
      Biomes: { lookup: (h: number) => ({ BiomeType: `BIOME_${h}` }) },
      Features: { lookup: () => null },
      Resources: { lookup: (h: number) => ({ ResourceType: `RESOURCE_${h}` }) },
      Continents: { lookup: (h: number) => ({ ContinentType: `CONTINENT_${h}` }) },
      // These reverse the SAME hash Types.lookup produces, so a thing chosen by name reads back
      // as that name. Returning `UNIT_${h}` for any hash meant a queued UNIT_WARRIOR read back as
      // "UNIT_896713063", and no test could tell a correct round-trip from a broken one.
      // lookup serves two callers: the build query hands it a ROW INDEX, and naming a queued item
      // hands it a HASH. The real table accepts both, so the fake must too — and must return null
      // for a hash it does not own, or callers can never fall through to the next table.
      Units: {
        lookup: (key: number) =>
          FAKE_UNITS[key] !== undefined
            ? { UnitType: FAKE_UNITS[key] }
            : reverseHash(key, "UNIT_", (n) => ({ UnitType: n })),
      },
      // Iterable AND indexable, like the real table: `civ build` walks it to turn a name into
      // the ROW INDEX the engine wants. A lookup-only stub meant the walk found nothing and the
      // build silently never happened.
      Constructibles: Object.assign(
        table(FAKE_CONSTRUCTIBLES.map((name, index) => ({ ConstructibleType: name, $index: index }))),
        {
          lookup: (key: number) =>
            FAKE_CONSTRUCTIBLES[key] !== undefined
              ? { ConstructibleType: FAKE_CONSTRUCTIBLES[key] }
              : reverseHash(key, "BUILDING_", (n) => ({ ConstructibleType: n })),
        },
      ),
      Projects: Object.assign(
        table(FAKE_CONSTRUCTIBLES.map((name, index) => ({ ProjectType: name, $index: index }))),
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
            PROJECT_TEST: "KIND_PROJECT",
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
      getAlive: () => world.players.map(playerObj),
      isHuman: () => true,
    },
    // Built on demand, from the live record.
    //
    // This used to be `world.units.map(unitObj)` — evaluated ONCE, when the globals were built,
    // which is once per FakeBridge. Every unit's position was frozen at match start, so a test
    // could not tell a unit that moved from one that did not, and the harness bug where the
    // engine accepts a move order and does nothing was invisible here.
    Units: {
      get: (ref: ComponentRef) => {
        const found = world.units.find((u) => u.id === refId(ref));
        return found ? { ...unitObj(found), id: found.id } : undefined;
      },
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
      isWater: () => false,
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

/** A Bridge that runs the real gamejs scripts against the fake world. */
export class FakeBridge implements Bridge {
  #context: object;

  constructor(world: FakeWorld) {
    this.#context = createContext(buildGlobals(world));
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
