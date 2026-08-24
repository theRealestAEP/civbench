// Loading and validating a match config (docs/PLAN.md §5).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { SUPPORTED, type MatchConfig, type AgentSpec } from "./schema.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_BUDGET = { tokensPerGame: 40_000_000, secondsPerTurn: 180, actionsPerTurn: 60 };

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

export function loadMatchConfig(path: string): { config: MatchConfig; runId: string } {
  const source = readFileSync(path, "utf8");
  const raw = parse(source) as Record<string, any>;
  if (!raw || typeof raw !== "object") throw new ConfigError(`${path} is not a mapping`);

  const game = raw.game ?? {};
  const config: MatchConfig = {
    seed: Number(raw.seed ?? 0),
    game: {
      build: String(game.build ?? "unknown"),
      dlc: game.dlc ?? ["all"],
      startAge: game.start_age ?? "antiquity",
      ageLength: game.age_length ?? "standard",
      mapType: game.map_type ?? "continents_plus",
      mapSize: game.map_size ?? "small",
      difficulty: game.difficulty ?? "sovereign",
      crises: game.crises ?? true,
      singleAge: game.single_age ?? false,
      gameSpeed: game.game_speed ?? null,
      turnLimit: Number(game.turn_limit ?? 250),
      fillerAi: game.filler_ai ?? "none",
      gameModes: game.game_modes ?? [],
    },
    controlMode: raw.control_mode ?? "direct",
    agents: (raw.agents ?? []).map((a: Record<string, any>, index: number): AgentSpec => ({
      slot: Number(a.slot ?? index),
      playerId: Number(a.player_id ?? a.slot ?? index),
      name: String(a.name ?? `seat${index}`),
      leader: a.leader,
      civ: a.civ,
      civSwitch: a.civ_switch ?? "agent",
      brain:
        a.brain?.model !== undefined
          ? { kind: "model", model: String(a.brain.model) }
          : { kind: "scripted" },
      budget: {
        tokensPerGame: Number(a.budget?.tokens_per_game ?? DEFAULT_BUDGET.tokensPerGame),
        secondsPerTurn: Number(a.budget?.seconds_per_turn ?? DEFAULT_BUDGET.secondsPerTurn),
        actionsPerTurn: Number(a.budget?.actions_per_turn ?? DEFAULT_BUDGET.actionsPerTurn),
      },
    })),
    harness: {
      hudFields: raw.harness?.hud_fields ?? "default",
      autosaveEveryTurn: raw.harness?.autosave_every_turn ?? true,
      stallStrikes: Number(raw.harness?.stall_strikes ?? 3),
      memoryMode: raw.harness?.memory_mode ?? "persistent",
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
