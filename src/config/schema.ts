// Match configuration (docs/PLAN.md §5). One file defines a match, and it is the reproducibility
// unit: its hash becomes part of the run id.
export type GameConfig = {
  build: string;
  dlc: string[];
  startAge: "antiquity" | "exploration" | "modern";
  ageLength: string;
  mapType: string;
  mapSize: string;
  difficulty: string;
  crises: boolean;
  singleAge: boolean;
  gameSpeed: string | null;
  turnLimit: number;
  fillerAi: "none" | "filler" | "barbarians_only";
  gameModes: string[];
};

export type AgentSpec = {
  slot: number;
  playerId: number;
  name: string;
  leader?: string;
  civ?: string;
  civSwitch: "agent" | "fixed";
  brain: { kind: "scripted" } | { kind: "model"; model: string };
  budget: { tokensPerGame: number; secondsPerTurn: number; actionsPerTurn: number };
  /** The seat's monologue voice. `id` is an ElevenLabs voice; `gender` is metadata for alignment. */
  voice?: { id: string; gender?: "m" | "f" | "x" };
};

export type MatchConfig = {
  seed: number;
  game: GameConfig;
  controlMode: "direct" | "hotseat" | "network_mp";
  agents: AgentSpec[];
  harness: {
    hudFields: string;
    autosaveEveryTurn: boolean;
    /** "persistent" keeps each agent's transcript across turns and compacts it (§8). */
    memoryMode: "persistent" | "fresh";
  };
};

/**
 * Mechanics the adapter fully covers. Anything outside this refuses to start (§5): a silently
 * unsupported game mode produces a corrupt benchmark, which is worse than an error.
 */
export const SUPPORTED = {
  // SAFETY: an empty literal infers never[], which would refuse every later push. The element
  // type is the declaration, not a claim about a value.
  gameModes: [] as string[],
  startAges: ["antiquity", "exploration", "modern"],
  controlModes: ["direct", "hotseat"],
  fillerAi: ["none", "filler", "barbarians_only"],
};
