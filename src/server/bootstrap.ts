// Wiring a match config to a running match (docs/PLAN.md §3, §5).
//
// Picks a transport: the live game when its debug bridge answers, otherwise the fake used by
// the tests. That means the whole pipeline can be exercised on any machine, and the same code
// path runs against the real game when it is up.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bridge } from "../adapter/bridge.ts";
import { CdpBridge, discover, CANDIDATE_PORTS } from "../adapter/cdp.ts";
import { gameListeningPorts, findGamePids } from "../adapter/discover.ts";
import { GameAdapter } from "../adapter/game.ts";
import { FakeBridge, makeWorld } from "../test-support/fake-game.ts";
import { MatchServer, type AgentConfig } from "./match.ts";
import type { Seat } from "./run.ts";
import { ScriptedBrain } from "../agent/scripted-brain.ts";
import { PiBrain } from "../agent/pi-brain.ts";
import type { MatchConfig } from "../config/schema.ts";

export type Transport = { bridge: Bridge; kind: "live" | "fake"; detail: string };

export async function connect(preferFake = false): Promise<Transport> {
  if (!preferFake) {
    const ports = [...new Set([...gameListeningPorts(), ...CANDIDATE_PORTS])];
    // Retry: the debug server stops answering while the engine is busy, and a single failed
    // probe used to drop us onto the fake. Falling back silently while a real game is running
    // burns model spend on a match that means nothing.
    const found = await discover(ports, 5);
    const targets = found.flatMap((f) => f.targets).filter((t) => t.webSocketDebuggerUrl);
    // Only the gameplay context has Players/GameplayMap; the shell is the main menu and cannot
    // answer anything the adapter asks.
    const target = targets.find((t) => t.url.includes("root-game"));
    if (target) {
      return {
        bridge: await CdpBridge.connect(target.webSocketDebuggerUrl),
        kind: "live",
        detail: `CDP: ${target.title || target.id}`,
      };
    }
  }
  // If Civilization is actually running, refuse to pretend. A fake match that looks like a real
  // one is worse than a clear failure.
  if (!preferFake && findGamePids().length > 0) {
    throw new Error(
      "Civilization VII is running but its debug bridge did not answer.\n" +
        "The bridge is serviced on the game thread, so it goes quiet while the engine is busy.\n" +
        "Wait for the match to finish loading and try again, or pass --fake to run against the fake.",
    );
  }
  return { bridge: new FakeBridge(makeWorld()), kind: "fake", detail: "fake Civ 7 (no game found)" };
}

export function seatsFrom(config: MatchConfig): { seats: Seat[]; agents: AgentConfig[] } {
  const agents: AgentConfig[] = config.agents.map((a) => ({
    slot: a.slot,
    playerId: a.playerId,
    name: a.name,
    actionsPerTurn: a.budget.actionsPerTurn,
    secondsPerTurn: a.budget.secondsPerTurn,
  }));
  const seats: Seat[] = config.agents.map((a, i) => ({
    config: agents[i]!,
    brain:
      a.brain.kind === "model"
        ? new PiBrain(a.brain.model, "low", config.harness.memoryMode)
        : new ScriptedBrain(),
  }));
  return { seats, agents };
}

/** Everything needed to reproduce or audit this run (§14). */
export function writeManifest(
  runDir: string,
  config: MatchConfig,
  runId: string,
  transport: Transport,
): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify(
      {
        runId,
        startedAt: new Date().toISOString(),
        transport: { kind: transport.kind, detail: transport.detail },
        game: config.game,
        controlMode: config.controlMode,
        harnessVersion: process.env.npm_package_version ?? "0.0.1",
        agents: config.agents.map((a) => ({ name: a.name, brain: a.brain, budget: a.budget })),
      },
      null,
      2,
    ),
  );
}

/**
 * Build a MatchServer the same way every time.
 *
 * Three tools each assembled one by hand and each forgot something different. `run-match.ts` and
 * `live-session.ts` never called `exportRules()`, so `/run/rules/` — which the briefing tells
 * agents to look operation names up in — did not exist on those paths. The same two never passed
 * MatchFacts, so the `match: N turns total` line the briefing describes never appeared. And only
 * `start.ts` honoured `autosave_every_turn`, which `match.ts` claimed was no longer ignored.
 *
 * Assembly belongs in one place beside seatsFrom.
 */
export async function startMatch(
  adapter: GameAdapter,
  runDir: string,
  config: MatchConfig,
  agents: AgentConfig[],
  options: { turnLimit: number; majorPlayers?: number } ,
): Promise<{ server: MatchServer; rules: { tables: number; rows: number } }> {
  const majors = options.majorPlayers ?? agents.length;
  const server = new MatchServer(adapter, runDir, agents, {
    turnLimit: options.turnLimit,
    speed: config.game.gameSpeed ?? null,
    singleAge: config.game.singleAge !== false,
    agentRivals: agents.length - 1,
    aiRivals: Math.max(0, majors - agents.length),
  });
  server.autosave = config.harness.autosaveEveryTurn;
  // Never fatal: a match without the ruleset is worse for the agents, but still a match.
  const rules = await server.exportRules().catch(() => ({ tables: 0, rows: 0 }));
  return { server, rules };
}
