// Loading and validating a match config (docs/PLAN.md §5).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { Json } from "../dump/types.ts";
import { SUPPORTED, type MatchConfig, type AgentSpec } from "./schema.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// actionsPerTurn is a runaway backstop, not a game rule — see MatchServer.act. Set well above any
// legitimate turn: a large empire with twenty cities and forty units has a lot to do.
const DEFAULT_BUDGET = { tokensPerGame: 40_000_000, secondsPerTurn: 180, actionsPerTurn: 500 };

/**
 * A directory for this run. The config hash identifies WHAT was played and stays in the manifest;
 * the suffix keeps two runs of the same config from writing over each other.
 */
export function nextRunDir(root: string, runId: string): string {
  for (let n = 1; ; n++) {
    const candidate = join(root, `${runId}-${String(n).padStart(3, "0")}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/** A config file, read and validated, with the id derived from its exact bytes. */
export type LoadedConfig = { config: MatchConfig; runId: string };

/**
 * Readers for a parsed YAML document.
 *
 * This is the I/O boundary, and it is the one place `typeof` belongs: everything past it works
 * with the domain type. Before, the document was cast to `Record<string, any>` and every field
 * read reached through that `any` — a misspelled key or a string where a number belonged produced
 * NaN or undefined somewhere much later.
 */
const asObject = (value: Json | undefined): Record<string, Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const asString = (value: Json | undefined, fallback: string): string =>
  typeof value === "string" ? value : fallback;
const asNumber = (value: Json | undefined, fallback: number): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const asBoolean = (value: Json | undefined, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;
const asStrings = (value: Json | undefined, fallback: string[]): string[] =>
  Array.isArray(value) ? value.map((v) => String(v)) : fallback;

/**
 * A field that may only be one of a fixed set.
 *
 * Under the old `any` these were assigned straight through, so `start_age: antiquty` became a
 * config with a nonsense age in it and the failure surfaced hours later inside the game setup.
 * Say which values are allowed, at the point the file is read.
 */
function asOneOf<T extends string>(
  value: Json | undefined,
  allowed: readonly T[],
  fallback: T,
  field: string,
): T {
  if (value === undefined || value === null) return fallback;
  const text = String(value);
  const hit = allowed.find((option) => option === text);
  if (!hit) {
    throw new ConfigError(`${field}: ${text} is not one of ${allowed.join(", ")}`);
  }
  return hit;
}

const AGES = ["antiquity", "exploration", "modern"] as const;
const FILLER_AI = ["barbarians_only", "filler", "none"] as const;
const CONTROL_MODES = ["direct", "hotseat", "network_mp"] as const;
const CIV_SWITCH = ["agent", "fixed"] as const;
const MEMORY_MODES = ["fresh", "persistent"] as const;

/** A seat's monologue voice from YAML: `voice: { id, gender }`. Absent -> no configured voice. */
function voiceOf(raw: Json | undefined): AgentSpec["voice"] {
  if (raw === undefined || raw === null) return undefined;
  const v = asObject(raw);
  const id = v.id === undefined ? "" : asString(v.id, "");
  if (!id) return undefined;
  const g = v.gender === undefined ? undefined : asString(v.gender, "");
  const gender = g === "m" || g === "f" || g === "x" ? g : undefined;
  return { id, gender };
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export function loadMatchConfig(path: string): LoadedConfig {
  const source = readFileSync(path, "utf8");
  const parsed: Json = parse(source);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${path} is not a mapping`);
  }
  const raw = parsed;
  const game = asObject(raw.game);
  const config: MatchConfig = {
    seed: asNumber(raw.seed, 0),
    game: {
      build: asString(game.build, "unknown"),
      dlc: asStrings(game.dlc, ["all"]),
      startAge: asOneOf(game.start_age, AGES, "antiquity", "game.start_age"),
      ageLength: asString(game.age_length, "standard"),
      mapType: asString(game.map_type, "continents_plus"),
      mapSize: asString(game.map_size, "small"),
      difficulty: asString(game.difficulty, "sovereign"),
      crises: asBoolean(game.crises, true),
      singleAge: asBoolean(game.single_age, false),
      gameSpeed: game.game_speed === undefined || game.game_speed === null
        ? null
        : asString(game.game_speed, ""),
      turnLimit: asNumber(game.turn_limit, 250),
      fillerAi: asOneOf(game.filler_ai, FILLER_AI, "none", "game.filler_ai"),
      gameModes: asStrings(game.game_modes, []),
      agentsPickLeaders: asBoolean(game.agents_pick_leaders, false),
    },
    controlMode: asOneOf(raw.control_mode, CONTROL_MODES, "direct", "control_mode"),
    agents: (Array.isArray(raw.agents) ? raw.agents : []).map((entry, index): AgentSpec => {
      const a = asObject(entry);
      const brain = asObject(a.brain);
      const budget = asObject(a.budget);
      return {
        slot: asNumber(a.slot, index),
        playerId: asNumber(a.player_id, asNumber(a.slot, index)),
        name: asString(a.name, `seat${index}`),
        leader: a.leader === undefined || a.leader === null ? undefined : asString(a.leader, ""),
        civ: a.civ === undefined || a.civ === null ? undefined : asString(a.civ, ""),
        civSwitch: asOneOf(a.civ_switch, CIV_SWITCH, "agent", "civ_switch"),
        brain:
          brain.model !== undefined
            ? {
                kind: "model",
                model: asString(brain.model, ""),
                thinking: asOneOf(brain.thinking, THINKING_LEVELS, "low", "brain.thinking"),
              }
            : { kind: "scripted" },
        budget: {
          tokensPerGame: asNumber(budget.tokens_per_game, DEFAULT_BUDGET.tokensPerGame),
          secondsPerTurn: asNumber(budget.seconds_per_turn, DEFAULT_BUDGET.secondsPerTurn),
          actionsPerTurn: asNumber(budget.actions_per_turn, DEFAULT_BUDGET.actionsPerTurn),
        },
        voice: voiceOf(a.voice),
      };
    }),
    harness: {
      hudFields: asString(asObject(raw.harness).hud_fields, "default"),
      autosaveEveryTurn: asBoolean(asObject(raw.harness).autosave_every_turn, true),
      memoryMode: asOneOf(asObject(raw.harness).memory_mode, MEMORY_MODES, "persistent", "harness.memory_mode"),
    },
  };

  validate(config);
  // The config IS the reproducibility unit, so the run id is derived from its exact bytes.
  const runId = createHash("sha256").update(source).digest("hex").slice(0, 12);
  return { config, runId };
}

function validate(config: MatchConfig): void {
  const problems: string[] = [];

  if (config.agents.length === 0) problems.push("no agents configured");

  const ids = new Set<number>();
  for (const agent of config.agents) {
    if (ids.has(agent.playerId)) problems.push(`two agents share player id ${agent.playerId}`);
    ids.add(agent.playerId);
    if (agent.budget.actionsPerTurn < 1) problems.push(`${agent.name}: actions_per_turn must be >= 1`);
    if (agent.budget.secondsPerTurn <= 0) problems.push(`${agent.name}: seconds_per_turn must be > 0`);
  }

  if (!SUPPORTED.startAges.includes(config.game.startAge)) {
    problems.push(`unsupported start_age: ${config.game.startAge}`);
  }
  if (!SUPPORTED.controlModes.includes(config.controlMode)) {
    problems.push(`unsupported control_mode: ${config.controlMode}`);
  }
  if (!SUPPORTED.fillerAi.includes(config.game.fillerAi)) {
    problems.push(`unsupported filler_ai: ${config.game.fillerAi}`);
  }

  // The coverage rule from §5. Refusing loudly beats running a match whose results are quietly
  // meaningless because a mechanic went unmodelled.
  const uncovered = config.game.gameModes.filter((m) => !SUPPORTED.gameModes.includes(m));
  if (uncovered.length > 0) {
    problems.push(
      `game modes not covered by the adapter: ${uncovered.join(", ")}. ` +
        `Supported: ${SUPPORTED.gameModes.length > 0 ? SUPPORTED.gameModes.join(", ") : "(none yet)"}`,
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(`this match cannot start:\n  - ${problems.join("\n  - ")}`);
  }
}
