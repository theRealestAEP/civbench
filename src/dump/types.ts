/**
 * Any value that survives the trip out of the game as JSON.
 *
 * The bridge hands back parsed JSON and nothing more, so this is the honest type for a GameInfo
 * row's contents. `Record<string, unknown>` says less and forces a cast at every use.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// Shapes returned by src/adapter/gamejs/*.js, and the merged per-player view above them.

export type Vis = 1 | 2; // 1 = revealed but fogged, 2 = currently visible

export type RawTile = {
  x: number;
  y: number;
  vis: Vis;
  // Names, not hashes. The extractor resolves every type hash through GameInfo before it leaves
  // the game — no agent is ever shown a raw number for these. The type said `number` anyway, so
  // every producer and every test wrote `as unknown as number` to get a string past it, and the
  // writer needed `as unknown as Scalar` to get it back out.
  terrain: string | null;
  biome: string | null;
  feature: string | null;
  resource: string | null;
  water: boolean;
  river: boolean;
  mountain: boolean;
  continent: string | null;
  elevation: number;
  moveCost?: number | null;
  defense?: number | null;
  impassable?: boolean | null;
  /** What the plot produces for this player, by yield name. */
  yields: Record<string, number> | null;
  /** Buildings and improvements standing here. Only ever set on a VISIBLE plot. */
  built?: string[] | null;
  /**
   * A discovery waiting on this plot, if any.
   *
   * A human sees these highlighted on the map. Walking a unit onto one collects it — and the
   * engine will not let a unit skip its turn while one is adjacent, which is unanswerable if you
   * cannot see where it is.
   */
  discovery?: string | null;
  /** The id of one of your settlements that could grow onto this plot, if any. */
  expandFor?: string | null;
  /** Present only when vis === 2. Reading these while fogged would leak. */
  owner?: number;
  cityId?: string | null;
};

export type RawTilesSnapshot = { width: number; height: number; tiles: RawTile[] };

/**
 * A tile after the carry-forward merge: mutable fields may be remembered rather than current.
 *
 * `Omit` rather than a plain intersection. The merge REPLACES owner and cityId — on a fogged plot
 * they come from memory and are null when nothing was ever seen. Intersecting instead collapsed
 * `owner?: number` with `owner: number | null` down to plain `number`, making the null the merge
 * actually produces illegal.
 */
export type MergedTile = Omit<RawTile, "owner" | "cityId"> & {
  owner: number | null;
  cityId: string | null;
  /** Turn on which the mutable fields were last observed first-hand. */
  lastSeenTurn: number | null;
};

export type HeaderSnapshot = {
  turn: number;
  maxTurns: number | null;
  /** The age's name, e.g. "antiquity" — resolved from its hash before it leaves the game. */
  age: string;
  ageProgress: {
    current: number | null;
    max: number | null;
    isFinalAge: boolean | null;
    isAgeOver: boolean | null;
    canTransition: boolean | null;
    countdownStarted: boolean | null;
  } | null;
  playerId: number;
  civ: string | null;
  leader: string | null;
  isHuman: boolean | null;
  gold: number | null;
  /** The influence stockpile, which diplomatic actions spend. */
  influence?: number | null;
  yields: Record<string, number | null>;
  happiness: { net: number | null; hasUnrest: boolean | null; turnsOfUnrest: number | null };
  settlements: {
    cities: number | null;
    towns: number | null;
    total: number | null;
    cap: number | null;
    population: number | null;
  };
  unitCount: number;
  legacy: Array<{ type: string; score: number | null; target?: number | null; does?: string | null }>;
  /**
   * The game's own victory progress for this player's team: VICTORY_DOMINATION 8/13 and so on.
   * Legacy paths can be disabled for a match (they were, all night, and every legacy score read
   * 0 while Ada held 8 of the 13 settlements domination needs).
   */
  victories?: Array<{ type: string; current: number; total: number }>;
  researching?: { node: string; progress: number | null; turnsLeft?: number | null } | null;
  adopting?: { node: string; progress: number | null; turnsLeft?: number | null } | null;
  government: string | number | null;
};

export type OwnUnit = {
  id: string;
  owner: number;
  /** The unit's type NAME. Resolved from its hash before it leaves the game, like every other. */
  type: string | null;
  x: number | null;
  y: number | null;
  damage: number | null;
  maxDamage: number | null;
  name: string | null;
  movesRemaining: number | null;
  canMove: boolean | null;
  experience: number | null;
  isCommander: boolean;
  /** Whether this unit could found a settlement on the plot it is standing on, right now. */
  canFoundHere?: boolean;
  /** What it is already doing — fortified, asleep, exploring. Null when it is awaiting orders. */
  orders?: string | null;
  /** On a multi-turn operation. It will refuse new orders until it finishes. */
  busy?: boolean;
  /** Holds the turn open: the engine wants an order from it before the turn can end. */
  needsOrders?: boolean;
  armyId: string | null;
};

export type ForeignUnit = Pick<OwnUnit, "id" | "owner" | "type" | "x" | "y" | "damage" | "maxDamage">;
export type UnitsSnapshot = { own: OwnUnit[]; foreign: ForeignUnit[] };

export type OwnSettlement = {
  id: string;
  name: string | null;
  kind: "town" | "city";
  isCapital: boolean;
  x: number | null;
  y: number | null;
  population: number | null;
  growthType: number | string | null;
  currentFood: number | null;
  projectType: number | string | null;
  productionTurns: number | null;
  productionHash: number | string | null;
  /** What the city is building, by name. The hash above is never shown to an agent. */
  building: string | null;
  foodToGrow: number | null;
  foodPerTurn: number | null;
  turnsToGrow: number | null;
  urbanPopulation: number | null;
  ruralPopulation: number | null;
  queueEmpty: boolean | null;
  happiness: number | null;
  hasUnrest: boolean | null;
  /** Turns of unrest queued: the revolt countdown the city banner shows. */
  unrestTurns?: number | null;
  beingRazed: boolean;
  distantLands: boolean;
};

export type ForeignSettlement = {
  id: string;
  name: string | null;
  kind: "town" | "city";
  owner: number;
  x: number;
  y: number;
  isCapital: boolean;
  vis: Vis;
};

export type SettlementsSnapshot = { own: OwnSettlement[]; foreign: ForeignSettlement[] };

/**
 * A rival this player has MET, as the diplomacy ribbon shows them.
 *
 * The yield and settlement fields were added to players.js when the ribbon parity work went in,
 * and this type was never updated to match. Nothing caught it, because the repo had a strict
 * tsconfig and no compiler installed — so for as long as those fields existed, the type said they
 * did not.
 */
export type KnownPlayer = {
  id: number;
  civ: string | null;
  leader: string | null;
  isHuman: boolean | null;
  isMajor: boolean | null;
  atWar: boolean;
  suzerain: number | null;
  /** How they feel about you, in the game's own words. */
  relationship: string | null;
  /** Net per-turn yields, the same numbers the ribbon prints. */
  gold: number | null;
  science: number | null;
  culture: number | null;
  happiness: number | null;
  diplomacy: number | null;
  settlements: number | null;
  settlementCap: number | null;
  /** Their score on each legacy path, so you can see who is closest to winning. */
  legacy: string | null;
  /** Whether a war would find support, for you and against you. */
  warSupportForMe: number | null;
  warSupportForThem: number | null;
};
export type PlayersSnapshot = { me: number; known: KnownPlayer[] };

export type PendingItem = {
  id: string;
  type: string | null;
  summary: string | null;
  message: string | null;
  controls?: Array<{
    id: string;
    label: string;
    disabled: boolean;
    selected?: string | null;
    context?: string;
    description?: string | null;
  }>;
  interfaceGaps?: string[];
};
export type PendingSnapshot = { blockingType: string | null; items: PendingItem[] };

export type RawSnapshot = {
  header: HeaderSnapshot;
  tiles: RawTilesSnapshot;
  units: UnitsSnapshot;
  settlements: SettlementsSnapshot;
  players: PlayersSnapshot;
  pending: PendingSnapshot;
};
