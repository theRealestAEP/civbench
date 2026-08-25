// Shapes returned by src/adapter/gamejs/*.js, and the merged per-player view above them.

export type Vis = 1 | 2; // 1 = revealed but fogged, 2 = currently visible

export type RawTile = {
  x: number;
  y: number;
  vis: Vis;
  terrain: number;
  biome: number;
  feature: number;
  resource: number;
  water: boolean;
  river: boolean;
  mountain: boolean;
  continent: number;
  elevation: number;
  /** What the plot produces for this player, by yield name. */
  yields: Record<string, number> | null;
  /** Buildings and improvements standing here. Only ever set on a VISIBLE plot. */
  built?: string[] | null;
  /** Present only when vis === 2. Reading these while fogged would leak. */
  owner?: number;
  cityId?: string | null;
};

export type RawTilesSnapshot = { width: number; height: number; tiles: RawTile[] };

/** A tile after the carry-forward merge: mutable fields may be remembered rather than current. */
export type MergedTile = RawTile & {
  owner: number | null;
  cityId: string | null;
  /** Turn on which the mutable fields were last observed first-hand. */
  lastSeenTurn: number | null;
};

export type HeaderSnapshot = {
  turn: number;
  maxTurns: number | null;
  age: number;
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
  legacy: Array<{ type: string; score: number | null; target?: number | null }>;
  researching?: { node: string; progress: number | null } | null;
  adopting?: { node: string; progress: number | null } | null;
  government: string | number | null;
};

export type OwnUnit = {
  id: string;
  owner: number;
  type: number | string;
  x: number | null;
  y: number | null;
  damage: number | null;
  maxDamage: number | null;
  name: string | null;
  movesRemaining: number | null;
  canMove: boolean | null;
  experience: number | null;
  isCommander: boolean;
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
  productionTurnsLeft: number | null;
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

export type KnownPlayer = {
  id: number;
  civ: string | null;
  leader: string | null;
  isHuman: boolean | null;
  isMajor: boolean | null;
  atWar: boolean;
  suzerain: number | null;
};
export type PlayersSnapshot = { me: number; known: KnownPlayer[] };

export type PendingItem = {
  id: string;
  type: string | null;
  summary: string | null;
  message: string | null;
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
