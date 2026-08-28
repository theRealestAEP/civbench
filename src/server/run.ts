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
};

export type SeatOutcome = {
  name: string;
  playerId: number;
  turnsPlayed: number;
  commands: number;
  timeouts: number;
  forcedEndTurns: number;
  illegalActions: number;
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

/**
 * The game came back to a seat that already played this turn: its end-turn did not take. End it
 * for them and wait — waiting alone was a deadlock, since nothing advances a turn no one ends.
 * With backoff: a blocker the forced clear cannot answer used to re-enter here every round at
 * ~3 minutes a cycle until the turn limit.
 */
async function endReplayedSeat(
  server: MatchServer,
  seatName: string,
  activeId: number,
  gameTurn: number,
  repeats: number,
  onProgress: ProgressSink,
): Promise<void> {
  onProgress(
    `  t${gameTurn} ${seatName.padEnd(10)} already played, but the game came back to it — ending its turn` +
      (repeats > 1 ? ` (attempt ${repeats})` : ""),
  );
  if (repeats > 3) {
    onProgress(
      `  t${gameTurn} ${seatName.padEnd(10)} the game will not advance past this seat — ` +
        `an end-turn blocker the harness cannot answer. Backing off.`,
    );
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  await server.endTurn(activeId, true).catch(() => undefined);
  await server.waitForTurnAdvance(gameTurn).catch(() => undefined);
}

/** How many consecutive unreadable rounds mean the game has exited or crashed. */
const GONE_AFTER = 2;

/** A claimed victory or a last civilization standing ends the match; say so and record it. */
async function matchDecided(server: MatchServer, onProgress: ProgressSink): Promise<boolean> {
  const decided = await server.gameOver().catch(() => ({ over: false, why: null }));
  if (!decided.over) return false;
  onProgress(`  the match is decided: ${decided.why ?? "the game reports it is over"}`);
  server.logGameOver(decided.why ?? "the game reports it is over");
  return true;
}

/**
 * Save before waiting for the next round: if the game wedges during turn processing, the save is
 * already on disk. The label carries the run's name — bare "t0005" collided across runs, and a
 * second match silently overwrote the first's whole save trail.
 */
async function autosaveRound(
  server: MatchServer,
  runDir: string,
  playedTurn: number,
  onProgress: ProgressSink,
): Promise<void> {
  if (!server.autosave || playedTurn <= 0) return;
  const runName = runDir.split("/").filter(Boolean).at(-1) ?? "run";
  const saved = await server.save(`${runName}-t${String(playedTurn).padStart(4, "0")}`);
  if (!saved.requested) onProgress(`  autosave failed: ${saved.error ?? "unknown"}`);
}

/**
 * Count consecutive rounds where the game could not be read at all.
 *
 * A read that fails after the adapter has already tried to reconnect means the game is not there
 * any more — it crashed, or someone closed it. Retrying costs two minutes a go and can never
 * succeed, so after GONE_AFTER of them the match gives up rather than loop until the turn limit.
 */
function trackUnreadable(
  lastSeatWait: string,
  unreadable: number,
  onProgress: ProgressSink,
) {
  const next = lastSeatWait.startsWith("could not read") ? unreadable + 1 : 0;
  const gone = next >= GONE_AFTER;
  if (gone) onProgress(`  the game is not answering — it has exited or crashed.`);
  return { unreadable: next, gone };
}

/**
 * Read the game and write the seat's turn files, surviving a bridge hiccup.
 *
 * Guarded because beginTurn snapshots the game at a busy moment, and an unguarded timeout here
 * killed a whole match at the seat handoff. Null means "skip this seat for now".
 */
async function beginTurnGuarded(
  server: MatchServer,
  seatName: string,
  activeId: number,
  gameTurn: number,
  onProgress: ProgressSink,
): Promise<string | null> {
  try {
    return await server.beginTurn(activeId);
  } catch (err) {
    onProgress(
      `  t${gameTurn} ${seatName.padEnd(10)} could not read the game to start the turn: ` +
        `${String(err).slice(0, 90)} — skipping this seat for now`,
    );
    return null;
  }
}

/**
 * One brain's turn: heartbeat while it works, race it against the clock, and account for what
 * it did. The session is closed and the transcript parked whatever happens.
 */
async function runBrainTurn(
  server: MatchServer,
  seat: Seat,
  outcome: SeatOutcome,
  session: ReturnType<typeof createAgentSandbox>,
  hud: string,
  gameTurn: number,
  onProgress: ProgressSink,
): Promise<void> {
  const activeId = seat.config.playerId;
  const started = Date.now();
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
        turn: gameTurn,
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
      // The commands it DID run still count. Discarding them made the report table's columns
      // incomparable: a seat could show more illegal actions than commands.
      outcome.commands += session.commandsRun();
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
    // SAFETY: `.message` is read defensively and falls back to String(err), so a thrown
    // non-Error still produces a usable line rather than "undefined".
    const message = (err as Error).message ?? String(err);
    onProgress(`  t${gameTurn} ${seat.config.name.padEnd(10)} ERROR ${message.slice(0, 120)}`);
    server.logBrainError(activeId, message);
  } finally {
    clearInterval(heartbeat);
    session.close();
    // Park the reasoning beside the state it was reasoning about, so the two can be compared.
    // SAFETY: only PiBrain records a transcript; ScriptedBrain has none. The field is
    // optional here precisely so the absent case reads as absent rather than as an error.
    const brain = seat.brain as { lastTranscript?: string };
    if (brain.lastTranscript) {
      server.writeTranscript(activeId, brain.lastTranscript);
    }
  }
}

export async function runMatch(
  server: MatchServer,
  runDir: string,
  seats: Seat[],
  options: RunOptions,
  onProgress: ProgressSink = () => {},
): Promise<SeatOutcome[] & { gameCrashed?: boolean }> {
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
        inputTokens: 0,
        outputTokens: 0,
      },
    ]),
  );
  /** `${gameTurn}:${playerId}` for every turn actually played, across the whole match. */
  const playedTurns = new Set<string>();
  /** Consecutive rounds where the game could not be read at all (see trackUnreadable). */
  let unreadable = 0;
  let gameGone = false;

  /**
   * `${gameTurn}:${playerId}` -> how many times the game has come back to a seat that already
   * played that turn. A blocker the forced clear cannot answer would otherwise loop the stamp
   * path at full speed forever.
   */
  const stampRepeats = new Map<string, number>();

  // Bounded by how far the GAME has advanced, not by loop iterations: a stalled round used to
  // be debited from the "N turns total" the HUD promised the agents. Relative to the starting
  // turn, because a resumed save does not start at turn 1. The iteration cap is a runaway
  // backstop for a game that never advances.
  const startTurn = await server.currentTurn().catch(() => 0);
  const maxRounds = options.turnLimit * 3 + 10;
  for (let round = 0; round < maxRounds; round++) {
    if (gameGone) break;
    const turnAtRoundStart = await server.currentTurn().catch(() => startTurn);
    if (turnAtRoundStart - startTurn >= options.turnLimit) break;
    // A decided match ends here — a claimed victory, or one civilization left standing. Without
    // this the loop kept waiting for seats the game would never offer a turn again.
    if (await matchDecided(server, onProgress)) break;
    // Per-turn chat quotas reset here. Nothing called this before, so "five messages per turn"
    // was five per MATCH: after the fifth send a seat was refused for the rest of the game.
    server.startChatTurn();
    const playedThisRound = new Set<number>();
    const seatIds = seats.map((s) => s.config.playerId);

    // Hotseat decides the order, so ask the game whose turn it is rather than assuming ours.
    // Iterating seats in a fixed order deadlocks: the loop waits for seat 0 while the game waits
    // for seat 2 to play.
    while (playedThisRound.size < seats.length) {
      // Every seat is always a candidate. The game decides whose turn it is, and a seat the
      // harness has given up on is still a seat the game will keep offering turns to.
      const candidates = seatIds.filter((id) => !playedThisRound.has(id));
      if (candidates.length === 0) break;

      const activeId = await server.activeSeat(candidates);
      if (activeId === null) {
        // The server knows which of the three this was — a failed read, a seat that has already
        // played, or a genuinely idle game. They used to print identically, and an hour of a live
        // run was spent reading "the game may be waiting on something" at a healthy game whose
        // socket had simply dropped.
        onProgress(`  ${server.lastSeatWait}`);
        ({ unreadable, gone: gameGone } = trackUnreadable(server.lastSeatWait, unreadable, onProgress));
        break;
      }
      unreadable = 0;
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
        const repeats = (stampRepeats.get(stamp) ?? 0) + 1;
        stampRepeats.set(stamp, repeats);
        await endReplayedSeat(server, seat.config.name, activeId, gameTurn, repeats, onProgress);
        continue;
      }
      playedTurns.add(stamp);

      const hud = await beginTurnGuarded(server, seat.config.name, activeId, gameTurn, onProgress);
      if (hud === null) {
        playedTurns.delete(stamp);
        continue;
      }
      const notesDir = join(runDir, "notes", seat.config.name);
      mkdirSync(notesDir, { recursive: true });
      const session = createAgentSandbox(server, activeId, notesDir, () => hud);
      await runBrainTurn(server, seat, outcome, session, hud, gameTurn, onProgress);

      const state = server.turnStats(activeId);
      outcome.illegalActions += state?.illegalCount ?? 0;
      if (!state?.ended) {
        // Out of time, or it stopped without ending its turn. Either way the turn ends and the
        // seat plays again next turn — the same thing that happens to a human who runs the clock
        // down in a hotseat game.
        //
        // There used to be a strike count here that ejected a seat after three such turns. Civ
        // has no such rule, and ours dropped a seat that was playing perfectly well: an agent's
        // own end-turn is refused whenever a decision is pending, so the harness force-ends most
        // turns. The game then kept offering that seat turns nobody would end, and the match
        // deadlocked at turn 7. What bounds the cost of a broken agent is the per-turn time
        // limit, which needs no bookkeeping of its own.
        //
        // The engine can be mid-processing here, and a bridge timeout must not end the match.
        await server.endTurn(activeId, true).catch((err) => {
          onProgress(`  t${gameTurn} ${seat.config.name.padEnd(10)} end-turn: ${String(err).slice(0, 80)}`);
        });
        outcome.forcedEndTurns++;
      }

      outcome.turnsPlayed++;
    }


    // The engine now runs every non-agent player. Reading the next round before that finishes
    // would snapshot the turn we just played (§10). Barrier on the turn we know we captured,
    // not on a fresh query that can fail while the engine is busy.
    const playedTurn = server.lastSnapshotTurn();

    await autosaveRound(server, runDir, playedTurn, onProgress);

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

  // The launcher needs to tell "the match finished" apart from "the game died under it", because
  // one is a result and the other is a crash it can recover from — every turn is autosaved.
  const done = [...outcomes.values()] as SeatOutcome[] & { gameCrashed?: boolean };
  done.gameCrashed = gameGone;
  return done;
}
