// The turn loop (docs/PLAN.md §10).
//
// Every safety control lives here or in the Match Server, never in the harness. A brain that
// hangs, crashes, or refuses to end its turn must not be able to stall the match, because a
// 25-hour game cannot be babysat.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MatchServer, AgentConfig } from "./match.ts";
import type { Brain } from "../agent/brain.ts";
import { createAgentSandbox } from "../agent/sandbox.ts";

export type Seat = { config: AgentConfig; brain: Brain };

export type RunOptions = {
  turnLimit: number;
  /** Consecutive stalled turns before a seat forfeits. */
  stallStrikes: number;
};

export type SeatOutcome = {
  name: string;
  playerId: number;
  turnsPlayed: number;
  commands: number;
  timeouts: number;
  forcedEndTurns: number;
  illegalActions: number;
  forfeited: boolean;
  inputTokens: number;
  outputTokens: number;
};

/** Reject after `ms`, so one wedged brain cannot hold the whole match. */
/** How often to say "still waiting", and the silence after which that is worth saying. */
const HEARTBEAT_SECONDS = 60;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms).unref?.()),
  ]);
}

export type ProgressSink = (line: string) => void;

export async function runMatch(
  server: MatchServer,
  runDir: string,
  seats: Seat[],
  options: RunOptions,
  onProgress: ProgressSink = () => {},
): Promise<SeatOutcome[]> {
  const outcomes = new Map<number, SeatOutcome>(
    seats.map((s) => [
      s.config.playerId,
      {
        name: s.config.name,
        playerId: s.config.playerId,
        turnsPlayed: 0,
        commands: 0,
        timeouts: 0,
        forcedEndTurns: 0,
        illegalActions: 0,
        forfeited: false,
        inputTokens: 0,
        outputTokens: 0,
      },
    ]),
  );
  const strikes = new Map<number, number>(seats.map((s) => [s.config.playerId, 0]));
  /** `${gameTurn}:${playerId}` for every turn actually played, across the whole match. */
  const playedTurns = new Set<string>();

  for (let turn = 0; turn < options.turnLimit; turn++) {
    const turnAtRoundStart = await server.currentTurn().catch(() => 0);
    const playedThisRound = new Set<number>();
    const seatIds = seats.map((s) => s.config.playerId);

    // Hotseat decides the order, so ask the game whose turn it is rather than assuming ours.
    // Iterating seats in a fixed order deadlocks: the loop waits for seat 0 while the game waits
    // for seat 2 to play.
    while (playedThisRound.size < seats.length) {
      const candidates = seatIds.filter(
        (id) => !playedThisRound.has(id) && !outcomes.get(id)!.forfeited,
      );
      if (candidates.length === 0) break;

      const activeId = await server.activeSeat(candidates);
      if (activeId === null) {
        onProgress(`  no seat became active — the game may be waiting on something`);
        break;
      }
      const seat = seats.find((s) => s.config.playerId === activeId)!;
      const outcome = outcomes.get(activeId)!;
      playedThisRound.add(activeId);

      const gameTurn = await server.currentTurn().catch(() => 0);

      // Never let a seat play the same game turn twice.
      //
      // `playedThisRound` is keyed to this loop, and a stall breaks out of the round entirely —
      // so the next round started with an empty set while the game was still on the same turn,
      // and the active seat played again. Observed: Ada took turn 3 twice, spending 2 actions and
      // then 4 more. Key the guard on the game's own turn, which a loop restart cannot reset.
      const stamp = `${gameTurn}:${activeId}`;
      if (playedTurns.has(stamp)) {
        onProgress(
          `  t${gameTurn} ${seat.config.name.padEnd(10)} already played this turn — waiting for the game to advance`,
        );
        await server.waitForTurnAdvance(gameTurn).catch(() => undefined);
        continue;
      }
      playedTurns.add(stamp);

      const started = Date.now();
      const hud = await server.beginTurn(activeId);
      const notesDir = join(runDir, "notes", seat.config.name);
      mkdirSync(notesDir, { recursive: true });
      const session = createAgentSandbox(server, activeId, notesDir, () => hud);

      let stalled = false;
      // A model that has gone silent and a model that is working steadily both just sit there for
      // the whole turn budget, so watching the run cannot tell them apart. Say which it is: every
      // heartbeat reports how long since the model last produced anything.
      let lastSignal = Date.now();
      let signals = 0;
      const heartbeat = setInterval(() => {
        const quiet = Math.round((Date.now() - lastSignal) / 1000);
        if (quiet < HEARTBEAT_SECONDS) return;
        onProgress(
          `  t${gameTurn} ${seat.config.name.padEnd(10)} ...${quiet}s since last output` +
            (signals === 0 ? " (nothing yet — the model may be stalled)" : ""),
        );
      }, HEARTBEAT_SECONDS * 1000);
      heartbeat.unref?.();
      try {
        const report = await withTimeout(
          seat.brain.playTurn({
            hud,
            turn,
            playerId: String(activeId),
            exec: session.exec,
            report: (update) => {
              lastSignal = Date.now();
              signals++;
              server.showOnScreen(activeId, seat.config.name, update);
            },
          }),
          seat.config.secondsPerTurn * 1000,
        );
        if (report === "timeout") {
          outcome.timeouts++;
          stalled = true;
          // Distinguish the two failures in the record, not just on screen.
          onProgress(
            `  t${gameTurn} ${seat.config.name.padEnd(10)} ` +
              (signals === 0 ? "TIMED OUT — never produced any output" : "TIMED OUT while working"),
          );
        } else {
          outcome.commands += report.commands;
          outcome.inputTokens += report.inputTokens ?? 0;
          outcome.outputTokens += report.outputTokens ?? 0;
          onProgress(
            `  t${gameTurn} ${seat.config.name.padEnd(10)} ${String(report.commands).padStart(3)} cmds ` +
              `${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s  ${report.notes ?? ""}`,
          );
        }
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        onProgress(`  t${gameTurn} ${seat.config.name.padEnd(10)} ERROR ${message.slice(0, 120)}`);
        server.logBrainError(activeId, message);
        stalled = true;
      } finally {
        clearInterval(heartbeat);
        session.close();
        // Park the reasoning beside the state it was reasoning about, so the two can be compared.
        const brain = seat.brain as { lastTranscript?: string };
        if (brain.lastTranscript) {
          server.writeTranscript(activeId, brain.lastTranscript);
        }
      }

      const state = server.turnStats(activeId);
      outcome.illegalActions += state?.illegalCount ?? 0;
      if (!state?.ended) {
        // The engine can be mid-processing here, and a bridge timeout must not end the match.
        await server.endTurn(activeId, true).catch((err) => {
          onProgress(`  t${gameTurn} ${seat.config.name.padEnd(10)} end-turn: ${String(err).slice(0, 80)}`);
        });
        outcome.forcedEndTurns++;
        stalled = true;
      }

      const streak = stalled ? (strikes.get(activeId) ?? 0) + 1 : 0;
      strikes.set(activeId, streak);
      if (streak >= options.stallStrikes) outcome.forfeited = true;
      outcome.turnsPlayed++;
    }

    if (seats.every((s) => outcomes.get(s.config.playerId)!.forfeited)) break;

    // The engine now runs every non-agent player. Reading the next round before that finishes
    // would snapshot the turn we just played (§10). Barrier on the turn we know we captured,
    // not on a fresh query that can fail while the engine is busy.
    const playedTurn = server.lastSnapshotTurn();

    // Save before waiting for the next round: if the game wedges during turn processing, the
    // save is already on disk.
    if (server.autosave && playedTurn > 0) {
      const saved = await server.save(`t${String(playedTurn).padStart(4, "0")}`);
      if (!saved.requested) onProgress(`  autosave failed: ${saved.error ?? "unknown"}`);
    }

    // Unguarded, this ended a match three turns in.
    //
    // The round barrier polls the game at exactly the moment it is busiest — every seat has ended
    // its turn and the engine is processing the round — so a Runtime.evaluate can exceed the
    // 30s bridge timeout. That threw out of the loop and killed the process with a stack trace,
    // discarding a run that was otherwise healthy. The spectator already survives this by
    // reconnecting; the match loop must at least not die of it. The next round re-reads the turn
    // anyway, so losing this barrier costs nothing but a little ordering.
    if (playedTurn > 0) {
      await server.waitForTurnAdvance(playedTurn).catch((err) => {
        onProgress(`  waiting for turn ${playedTurn + 1}: ${String(err).slice(0, 90)}`);
      });
    }
  }

  return [...outcomes.values()];
}
