// Match metrics (docs/PLAN.md §13).
//
// Two groups, and they are always reported together. Outcome without hygiene is misleading: an
// agent that "won" while its turns were auto-passed 40 times did not win.
//
// Civ 7 gives us something Civ 6 would not: Legacy points at each Age boundary are the game's
// own intermediate score, so partial results are graded without inventing a metric.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HeaderSnapshot } from "../dump/types.ts";

export type TurnPoint = {
  turn: number;
  age: number | string;
  gold: number | null;
  science: number | null;
  culture: number | null;
  settlements: number | null;
  population: number | null;
  units: number;
  legacy: Record<string, number>;
};

export type AgentMetrics = {
  name: string;
  trajectory: TurnPoint[];
  /** Legacy score on each path at the last turn of each Age — the game's own checkpoints. */
  ageCheckpoints: Array<{ age: number | string; lastTurn: number; legacy: Record<string, number> }>;
  hygiene: {
    turns: number;
    actions: number;
    illegalActions: number;
    refusedActions: number;
    forcedEndTurns: number;
    blockedTurns: number;
    illegalRate: number;
  };
  admissible: boolean;
  inadmissibleBecause: string[];
};

function readHeaders(agentDir: string): HeaderSnapshot[] {
  const turnsDir = join(agentDir, "turns");
  if (!existsSync(turnsDir)) return [];
  return readdirSync(turnsDir)
    .sort()
    .map((t) => join(turnsDir, t, "header.json"))
    .filter(existsSync)
    .map((p) => JSON.parse(readFileSync(p, "utf8")) as HeaderSnapshot);
}

const legacyMap = (header: HeaderSnapshot): Record<string, number> =>
  Object.fromEntries(
    header.legacy.map((l) => [l.type.replace(/^LEGACY_PATH_/, "").toLowerCase(), l.score ?? 0]),
  );

/** A run is admissible as benchmark data only if it was played cleanly and long enough (§13). */
const MIN_TURNS = 50;

export function scoreAgent(
  runDir: string,
  name: string,
  events: Array<Record<string, any>>,
): AgentMetrics {
  const headers = readHeaders(join(runDir, "agents", name));
  const trajectory: TurnPoint[] = headers.map((h) => ({
    turn: h.turn,
    age: h.age,
    gold: h.gold,
    science: h.yields?.science ?? null,
    culture: h.yields?.culture ?? null,
    settlements: h.settlements?.total ?? null,
    population: h.settlements?.population ?? null,
    units: h.unitCount,
    legacy: legacyMap(h),
  }));

  // The last observation inside each Age is that Age's checkpoint.
  const ageCheckpoints: AgentMetrics["ageCheckpoints"] = [];
  for (const point of trajectory) {
    const last = ageCheckpoints.at(-1);
    if (last && last.age === point.age) {
      last.lastTurn = point.turn;
      last.legacy = point.legacy;
    } else {
      ageCheckpoints.push({ age: point.age, lastTurn: point.turn, legacy: point.legacy });
    }
  }

  const mine = events.filter((e) => e.player !== null && e.playerName === name);
  const actions = mine.filter((e) => e.kind === "action");
  const illegal = actions.filter((e) => e.result?.ok === false);
  const refused = mine.filter((e) => e.kind === "action_refused");
  const forced = mine.filter((e) => e.kind === "turn_end_forced");
  // The game refused to advance the round.
  //
  // This is a MATCH fact, not a seat's fault: it is logged at the round barrier once every seat
  // has played, and carries `player: null`. It used to be counted per agent, so one stalled round
  // made every agent inadmissible and the report blamed all three. Counted for the record, and
  // deliberately not used to disqualify anyone below.
  const blocked = events.filter((e) => e.kind === "turn_advance_timeout");
  const turns = mine.filter((e) => e.kind === "turn_begin").length;

  const hygiene = {
    turns,
    actions: actions.length,
    illegalActions: illegal.length,
    refusedActions: refused.length,
    forcedEndTurns: forced.length,
    blockedTurns: blocked.length,
    illegalRate: actions.length > 0 ? illegal.length / actions.length : 0,
  };

  const inadmissibleBecause: string[] = [];
  if (turns < MIN_TURNS) inadmissibleBecause.push(`only ${turns} turns (need ${MIN_TURNS})`);
  if (hygiene.forcedEndTurns > 0) {
    inadmissibleBecause.push(`${hygiene.forcedEndTurns} turns were ended for it`);
  }
  // A stalled round is deliberately NOT grounds for inadmissibility. It is the harness's problem
  // or the game's, it is logged once for the whole round with no seat attached, and an agent that
  // played a clean turn should not be disqualified because the engine would not move on.

  return {
    name,
    trajectory,
    ageCheckpoints,
    hygiene,
    admissible: inadmissibleBecause.length === 0,
    inadmissibleBecause,
  };
}

export function scoreRun(runDir: string): AgentMetrics[] {
  const eventsPath = join(runDir, "events.jsonl");
  const events = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, any>)
    : [];
  const agentsDir = join(runDir, "agents");
  const names = existsSync(agentsDir) ? readdirSync(agentsDir) : [];
  return names.map((name) => scoreAgent(runDir, name, events));
}
