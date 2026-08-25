// A miniature Civ 7 for tests (docs/PLAN.md §14, "fixture replay").
//
// This is deliberately not a mock of our own code: it fakes the GAME's API surface and then runs
// the real src/adapter/gamejs/*.js against it in a VM. So the extraction scripts — including the
// fog filtering that §7 depends on — are genuinely exercised without launching Civilization.
import { createContext, runInContext } from "node:vm";
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
  cityRequests: Array<Record<string, unknown>>;
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
};

/** A small stable string hash, distinct per name. */
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
    notifications: new Map(),
    ...overrides,
  };
}

/** Build the globals the gamejs scripts expect. */
function buildGlobals(world: FakeWorld): Record<string, unknown> {
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
    BuildQueue: { getTurnsLeft: () => 3, currentProductionTypeHash: 999, isEmpty: false },
    Happiness: { netHappinessPerTurn: 1, hasUnrest: false },
    isBeingRazed: false,
    isDistantLands: false,
  });

  const playerObj = (id: number) => ({
    id,
    // The fake has no hotseat rotation; every seat is always able to act.
    isTurnActive: true,
    civilizationName: `CIV_${id}`,
    leaderName: `LEADER_${id}`,
    isMajor: true,
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
    Culture: {
      getAllAvailableNodeTypes: () => [601],
      getTurnsForNode: () => 5,
      getNodeCost: () => 30,
      getResearching: () => (world.civic.has(id) ? { type: world.civic.get(id) } : null),
    },
    Units: {
      getUnitIds: () =>
        world.units.filter((u) => u.owner === id).map((u) => ({ owner: u.owner, id: u.id, type: 26 })),
    },
    Cities: {
      getCityIds: () =>
        world.cities.filter((c) => c.owner === id).map((c) => ({ owner: c.owner, id: c.id, type: 27 })),
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
      isAtWarWith: () => false,
    },
    Influence: { getSuzerain: () => null },
    LegacyPaths: { getEnabledLegacyPaths: () => [], getScore: () => 0 },
    Culture: { getGovernmentType: () => "GOVERNMENT_CHIEFDOM" },
  });

  const byId = <T extends { id: number }>(list: T[]) => (ref: unknown) => {
    const id = typeof ref === "object" && ref !== null ? (ref as { id: number }).id : ref;
    return list.find((item) => item.id === Number(id));
  };

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
      SET_CULTURE_TREE_NODE: "SET_CULTURE_TREE_NODE",
      CHOOSE_NARRATIVE_STORY_DIRECTION: "CHOOSE_NARRATIVE_STORY_DIRECTION",
      DECLARE_WAR: "DECLARE_WAR",
    },
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
        isFinalAge: false,
        isAgeOver: false,
        canTransitionToNextAge: () => false,
        ageCountdownStarted: false,
      },
      // Operation APIs. canStart mirrors the real contract: { Success, FailureReasons }.
      UnitOperations: {
        canStart: (_id: unknown, type: string) => ({
          Success: type === "UNITOPERATION_SKIP_TURN" || type === "UNITOPERATION_MOVE_TO",
          FailureReasons: ["LOC_FAKE_NOT_ALLOWED"],
        }),
        // Skipping spends the unit's moves, which is what unblocks the end of a turn.
        sendRequest: (id: { id?: number } | number, type: unknown) => {
          const unitId = Number((id as { id?: number })?.id ?? id);
          if (type === "UNITOPERATION_SKIP_TURN") {
            world.unitMoves.set(unitId, 0);
          }
          if (type === "UNITOPERATION_MOVE_TO") {
            world.unitMoves.set(unitId, Math.max(0, (world.unitMoves.get(unitId) ?? 2) - 1));
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
        canStartQuery: (_id: unknown, _type: unknown, query: number) =>
          query === 0
            ? [
                { index: 77, result: { Success: true, FailureReasons: [] } },
                {
                  index: 88,
                  result: { Success: false, FailureReasons: [], Requirements: { NeededPopulation: 3 } },
                },
              ]
            : [],
        sendRequest: (_id: unknown, _type: unknown, args: Record<string, unknown>) => {
          world.cityRequests.push(args);
        },
      },
      CityCommands: {
        canStart: () => ({ Success: true, FailureReasons: [] }),
        sendRequest: () => {},
      },
      PlayerOperations: {
        canStart: () => ({ Success: true, FailureReasons: [] }),
        // Record the choice, so getResearching can report it back the way the real game does.
        sendRequest: (pid: number, type: unknown, args: Record<string, unknown>) => {
          if (type === "CHOOSE_NARRATIVE_STORY_DIRECTION") {
            world.storyAnswered.add(pid);
            return;
          }
          const node = args?.ProgressionTreeNodeType;
          if (typeof node !== "number") return;
          if (type === "SET_TECH_TREE_NODE") world.researching.set(pid, node);
          if (type === "SET_CULTURE_TREE_NODE") world.civic.set(pid, node);
        },
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
          const wanted = Number((cid as { id?: number })?.id ?? cid);
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
          const wanted = Number((cid as { id?: number })?.id ?? cid);
          for (const [pid, list] of world.notifications) {
            const next = list.filter((n) => !(n.id === wanted && n.dismissible));
            world.notifications.set(pid, next);
          }
        },
        activate: () => {},
        getSummary: (cid: { id?: number } | number) => {
          const wanted = Number((cid as { id?: number })?.id ?? cid);
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
          ended.clear();
          world.turn += 1;
        }
      },
    },
    GameInfo: {
      Terrains: { lookup: (h: number) => ({ TerrainType: `TERRAIN_${h}` }) },
      Biomes: { lookup: (h: number) => ({ BiomeType: `BIOME_${h}` }) },
      Features: { lookup: () => null },
      Resources: { lookup: () => null },
      Continents: { lookup: (h: number) => ({ ContinentType: `CONTINENT_${h}` }) },
      Units: { lookup: (h: number) => ({ UnitType: `UNIT_${h}` }) },
      Constructibles: { lookup: (h: number) => ({ ConstructibleType: `BUILDING_${h}` }) },
      Projects: { lookup: (h: number) => ({ ProjectType: `PROJECT_${h}` }) },
      // Reverses the same hash Types.lookup produces, so a node chosen by name reads back as
      // that name. A fake that cannot round-trip cannot check that a choice actually took.
      NarrativeStories: { lookup: () => ({ NarrativeStoryType: "STORY_FAKE_DISCOVERY" }) },
      NarrativeStory_Links: [
        { FromNarrativeStoryType: "STORY_FAKE_DISCOVERY", ToNarrativeStoryType: "STORY_FAKE_ACCEPT" },
        { FromNarrativeStoryType: "STORY_FAKE_DISCOVERY", ToNarrativeStoryType: "STORY_FAKE_REFUSE" },
      ],
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
      UnitOperations: [
        { OperationType: "UNITOPERATION_MOVE_TO" },
        { OperationType: "UNITOPERATION_SKIP_TURN" },
        { OperationType: "UNITOPERATION_FOUND_CITY" },
      ],
      UnitCommands: [{ CommandType: "UNITCOMMAND_PROMOTE" }],
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
    Units: { get: byId(world.units.map(unitObj).map((u, i) => ({ ...u, id: world.units[i]!.id }))) },
    Cities: { get: byId(world.cities.map(cityObj).map((c, i) => ({ ...c, id: world.cities[i]!.id }))) },
    GameplayMap: {
      getGridWidth: () => world.width,
      getGridHeight: () => world.height,
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
