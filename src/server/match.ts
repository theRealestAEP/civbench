// The Match Server owns the game (docs/PLAN.md §3).
//
// It is the trust boundary. Agents reach it only through the `civ` command; they never touch
// the adapter and never see raw JS. It schedules turns, validates every action, enforces the
// budgets in §10, and writes the event log.
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import type { GameAdapter } from "../adapter/game.ts";
import { BridgeError } from "../adapter/bridge.ts";
import { writeSnapshot, emptyMemory, applyFog, pad as turnDirName, type PlayerMemory } from "../dump/snapshot.ts";
import type { Json } from "../dump/types.ts";
import { idForHandle } from "../dump/handles.ts";
import { renderHud, type HudCounts, type MatchFacts } from "../dump/hud.ts";
import { actionLines, unitCommandLine, ENGINE_INTERNAL_OPS, type LegalActions } from "../dump/actions.ts";
import { answerFor } from "../dump/required.ts";
import {
  tileLines, unitLines, settlementLines, playerLines, pendingLines, toJsonl,
} from "../dump/write.ts";
import { EventLog, type Event } from "./events.ts";
import { ChatChannel, renderMessages, MAX_MESSAGE_CHARS, type ChatMessage } from "./chat.ts";
import type {
  ChooseResult, CatalogueResult, WhatCanResult, DiplomacyResult, DealResult, CombatPreview, UnitState,
} from "./results.ts";

export type AgentConfig = {
  slot: number;
  playerId: number;
  name: string;
  actionsPerTurn: number;
  secondsPerTurn: number;
};

export type ActionRequest = {
  // The first five are the engine's own action kinds. "build" and "research" are ours: both need
  // a GameInfo.Types lookup to turn a readable name into the hash the engine wants, so each runs
  // its own script. They still spend budget and get logged like any other action.
  kind:
    | "unit_operation"
    | "unit_command"
    | "city_operation"
    | "city_command"
    | "player_operation"
    | "choose"
    | "diplomacy"
    | "notify"
    | "deal";
  targetId?: string | number;
  actionType: string;
  /** Whatever the operation wants. Shapes differ per operation; all of them are JSON. */
  args?: Record<string, Json>;
};

export type ActionResult = {
  ok: boolean;
  code?: string;
  message?: string;
  hint?: string;
  /** What a successful action changed, when that is not obvious. */
  note?: string;
  /** What the engine says about the subject of a refused action, when it will not say why. */
  state?: unknown;
};

type TurnState = {
  actionsUsed: number;
  ended: boolean;
  illegalCount: number;
  /** How many times each exact action has been issued this turn. */
  repeats: Map<string, number>;
};

/** The kinds that run as their own gamejs script; everything else goes through act.js. */
function scriptForAction(kind: ActionRequest["kind"]): string {
  return kind === "choose" || kind === "diplomacy" || kind === "notify" || kind === "deal"
    ? kind
    : "act";
}

/** Flatten an ActionRequest into the consts every gamejs script reads. `undefined` is not JSON,
 *  so absent fields are written as null and the event log round-trips. */
function adapterArgsFor(request: ActionRequest) {
  return {
    KIND: request.kind,
    WHAT: request.actionType,
    TARGET_ID: request.targetId ?? null,
    ACTION_TYPE: request.actionType,
    ARGS: request.args ?? {},
    THING: request.args?.thing ?? null,
    OTHER_PLAYER: request.args?.other ?? null,
    ACTION: request.args?.action ?? null,
    MODE: request.args?.mode ?? null,
    DEAL_MODE: request.args?.mode ?? null,
    ITEM_KIND: request.args?.itemKind ?? null,
    AMOUNT: request.args?.amount ?? null,
    SUBJECT: request.args?.subject ?? null,
  };
}

/** What endturn.js hands back, beyond the plain ActionResult. */
type EndTurnRun = ActionResult & {
  blocking?: string | null;
  /** The unit the engine says still needs orders, when that is what is blocking. */
  ready?: { id: string; type: string | null } | null;
  /** Game.turn before the request was sent, for the took-effect verification. */
  turnBefore?: number;
};

/**
 * How often the same exact action may be issued in one turn before we refuse it.
 *
 * Some operations return Success and change nothing — ACKNOWLEDGE_TURN_START is one, and an agent
 * issued it 27 times in a single turn because every call said ok. An error message cannot help
 * here, because there is no error. Three is enough for a legitimate repeat (build two warriors,
 * move twice) and short enough that a no-op loop dies quickly.
 */
const SAME_ACTION_LIMIT = 3;

export class MatchServer {
  #adapter: GameAdapter;
  /** Set from the config; autosave_every_turn was previously parsed and then ignored. */
  autosave = true;
  #runDir: string;
  #match?: MatchFacts;
  /** Seats whose dump was written before the engine had applied their last action. */
  #dumpStale = new Set<number>();
  #agents: Map<number, AgentConfig>;
  #memory = new Map<number, PlayerMemory>();
  #turnState = new Map<number, TurnState>();
  #currentTurnDir = new Map<number, string>();
  #opTypes: Record<string, string[]> | undefined;
  #chat = new ChatChannel();
  #lastThinking = new Map<number, string>();
  #lastAction = new Map<number, string>();
  #lastPaint = new Map<number, number>();
  #lastTurnSeen = new Map<number, number>();
  /** The turn-start change counts, so `civ hud` can repeat them instead of printing zeros. */
  #lastCounts = new Map<number, HudCounts>();
  /**
   * Count of this player's APPLIED mutations, ever. The legality sweeps (whatcan.js,
   * actions.js) key their caches on it: same turn + same count means the world has not moved,
   * so the cached answer is correct rather than merely recent — and the probe storms that
   * preceded every observed engine SIGSEGV collapse to one sweep per actual change.
   */
  #mutationSeq = new Map<number, number>();
  /** Why the last activeSeat() call gave up, so the match loop can say which of the three it was. */
  lastSeatWait = "no seat became active — the game may be waiting on something";
  #log: EventLog;

  /** The turn for an event line. Logging must never throw after the engine accepted an action. */
  async #safeTurn(): Promise<number> {
    return this.#adapter.turn().catch(() => this.lastSnapshotTurn());
  }

  constructor(adapter: GameAdapter, runDir: string, agents: AgentConfig[], match?: MatchFacts) {
    this.#adapter = adapter;
    this.#runDir = runDir;
    // Optional so every existing test keeps working; when absent the HUD simply omits the line.
    this.#match = match;
    this.#agents = new Map(agents.map((a) => [a.playerId, a]));
    this.#log = new EventLog(join(runDir, "events.jsonl"));
    for (const a of agents) {
      this.#memory.set(a.playerId, emptyMemory());
      mkdirSync(this.agentDir(a.playerId), { recursive: true });
      // Seed the journal into the WRITABLE mount.
      //
      // agentDir() is mounted read-only as /run. Seeding there put a notes.md the agent could see
      // but never write, while /notes/notes.md — the path the briefing calls "the ONLY thing you
      // keep between turns" — did not exist at all. Every agent's first read of its own journal
      // failed, and a decoy sat in /run to confuse it.
      const notesDir = join(runDir, "notes", a.name);
      mkdirSync(notesDir, { recursive: true });
      const notes = join(notesDir, "notes.md");
      if (!existsSync(notes)) {
        writeFileSync(
          notes,
          "# notes\n\nYour own journal. It is the only thing that survives between turns.\n" +
            "Add to it with `civ note '<text>'`, which appends. In the shell, `>>` appends and\n" +
            "`>` destroys everything below this line.\n",
        );
      }
    }
  }

  /** Where this player's current turn files live. Mounted as /current in the sandbox. */
  currentTurnDir(playerId: number): string | undefined {
    return this.#currentTurnDir.get(playerId);
  }

  agentDir(playerId: number): string {
    return join(this.#runDir, "agents", this.#nameOf(playerId));
  }

  /** Seat name for a player id. Every event carries it so the log reads on its own. */
  #nameOf(playerId: number): string {
    return this.#agents.get(playerId)?.name ?? `p${playerId}`;
  }

  /** Read the game for one player and write their turn files. Returns the HUD to push. */
  async beginTurn(playerId: number): Promise<string> {
    // Clear the hotseat handoff curtain before reading. Cosmetic only, but without it the match
    // is unwatchable — the board stays hidden behind a "pass the device" screen.
    await this.#adapter.run("uncurtain", playerId).catch(() => undefined);
    // Follow the seat that is about to play, so a spectator can see whose turn it is.
    await this.#adapter.run("focusseat", playerId).catch(() => undefined);

    const raw = await this.#adapter.snapshot(playerId);
    const unread = this.#chat.unreadFor(this.#nameOf(playerId));
    // notes.md lives in the writable mount, which the snapshot writer does not know about.
    let notesText: string | undefined;
    try {
      notesText = readFileSync(join(this.#runDir, "notes", this.#nameOf(playerId), "notes.md"), "utf8");
    } catch { /* first turn, or the agent has not written any */ }

    // messages.txt has to exist BEFORE the snapshot renders the HUD, or the "Messages" section
    // reads an absent file and is silently empty every turn. It used to be written afterwards.
    const turnDirForMessages = join(this.agentDir(playerId), "turns", turnDirName(raw.header.turn));
    mkdirSync(turnDirForMessages, { recursive: true });
    writeFileSync(join(turnDirForMessages, "messages.txt"), renderMessages(unread));
    // The .jsonl twin the briefing promises for every /current record.
    writeFileSync(
      join(turnDirForMessages, "messages.jsonl"),
      unread.map((m) => JSON.stringify(m)).join("\n") + "\n",
    );

    // actions.txt, for the same reason: the HUD pushes it, so it has to exist before the snapshot
    // renders.
    //
    // This catch used to be empty, and it hid a total failure for the life of the project.
    // actions.js threw on every single call, so actions.txt was NEVER WRITTEN — 0 of 33 turn
    // directories had one — while the briefing told agents four times to read it and never to
    // guess an action name. They had nothing to read, so they guessed, and the harness answered
    // "the game refused this action and gave no reason" 43 times in ten turns.
    //
    // A failure that matters this much has to be loud. Write the reason into the file the agent
    // is told to read, and say it on the console too.
    try {
      const legal = await this.legalActions(playerId);
      writeFileSync(join(turnDirForMessages, "actions.txt"), actionLines(legal).join("\n") + "\n");
    } catch (err) {
      const why = `# the harness could not read your legal actions this turn: ${String(err)}\n` +
        `# this is a harness fault, not your mistake. Use \`civ what-can\` and \`civ what-can player\`.\n`;
      writeFileSync(join(turnDirForMessages, "actions.txt"), why);
      console.error(`actions.txt could not be built for ${this.#nameOf(playerId)}: ${String(err)}`);
    }

    const written = writeSnapshot(
      this.agentDir(playerId),
      raw,
      this.#memory.get(playerId) ?? emptyMemory(),
      unread.length,
      notesText,
      this.#match,
    );
    this.#memory.set(playerId, written.memory);
    this.#currentTurnDir.set(playerId, written.dir);
    this.#lastTurnSeen.set(playerId, raw.header.turn);
    this.#lastCounts.set(playerId, written.counts);

    // markRead happens when the turn ENDS, not here: marking at turn start meant a turn that
    // timed out before reading its inbox lost those messages forever.
    this.#dumpStale.delete(playerId);
    this.#turnState.set(playerId, { actionsUsed: 0, ended: false, illegalCount: 0, repeats: new Map() });
    this.#log.append({
      turn: raw.header.turn,
      player: playerId,
      playerName: this.#nameOf(playerId),
      kind: "turn_begin",
      counts: written.counts,
      pending: raw.pending.items.length,
    });
    return written.hud;
  }

  /** The seat names of every rival this player has MET, via the engine's own diplomacy state. */
  async #metSeats(playerId: number): Promise<string[]> {
    const listing = await this.#adapter
      .run<{ players?: Array<{ player: string }> }>("diplomacy", playerId, { OTHER_PLAYER: null, ACTION: null })
      .catch(() => null);
    const met: string[] = [];
    for (const p of listing?.players ?? []) {
      const id = Number(p.player.replace(/^p/, ""));
      const name = this.#agents.get(id)?.name;
      if (name) met.push(name);
    }
    return met;
  }

  /**
   * Send a message to another seat, or to everyone you have met. Logged in full (§13).
   *
   * Addressing takes a seat number (`p2`, `2`) or a seat name, case-insensitively. It used to
   * take exact config names only, and the dump names rivals p0/p1/p2 — so `civ say @p2` returned
   * ok and was delivered to NOBODY, forever, with nothing telling the sender.
   */
  async say(playerId: number, to: string | null, text: string): Promise<ActionResult> {
    const from = this.#nameOf(playerId);
    const turn = this.lastSnapshotTurn();

    const met = await this.#metSeats(playerId);
    let recipient: string | null = null;
    if (to !== null) {
      const wanted = to.trim().toLowerCase();
      for (const agent of this.#agents.values()) {
        if (
          agent.name.toLowerCase() === wanted ||
          `p${agent.playerId}` === wanted ||
          String(agent.playerId) === wanted
        ) {
          recipient = agent.name;
          break;
        }
      }
      if (!recipient) {
        return {
          ok: false,
          code: "NO_SUCH_SEAT",
          message: `there is no seat "${to}"`,
          hint: `address a rival by number: ${[...this.#agents.values()]
            .filter((a) => a.playerId !== playerId)
            .map((a) => `@p${a.playerId}`)
            .join(", ")}`,
        };
      }
      if (recipient === from) {
        return { ok: false, code: "MESSAGE_REFUSED", message: "that is your own seat" };
      }
      // You can only talk to a civilization you have met, the same as in-game diplomacy.
      if (!met.includes(recipient)) {
        return {
          ok: false,
          code: "NOT_MET",
          message: `you have not met them yet — a message cannot reach a civilization you have never encountered`,
        };
      }
    } else if (met.length === 0) {
      return {
        ok: false,
        code: "NOT_MET",
        message: "you have met nobody yet — there is no one to hear you",
      };
    }

    const result = this.#chat.send({
      turn,
      from,
      to: recipient,
      audience: recipient === null ? met : undefined,
      text,
    });
    if (!result.ok) {
      return { ok: false, code: "MESSAGE_REFUSED", message: result.reason ?? "refused" };
    }
    this.#log.append({ turn, player: playerId, playerName: from, kind: "message", to: recipient, text });

    // Mirror into the game's own chat so a spectator sees it on screen too. Best effort: the
    // harness channel is the record, this is only for watchability.
    await this.#adapter
      .run("chat", playerId, { CHAT_TEXT: `${from}: ${text}` })
      .catch(() => undefined);
    return {
      ok: true,
      note:
        (recipient ? `sent to ${recipient}` : `sent to everyone you have met (${met.length})`) +
        (result.truncated ? ` — trimmed to ${MAX_MESSAGE_CHARS} characters` : ""),
    };
  }

  chatTranscript(): readonly ChatMessage[] {
    return this.#chat.transcript();
  }

  startChatTurn(): void {
    this.#chat.startTurn();
  }

  /** Every operation name this build knows, by category. Cached: it never changes mid-match. */
  async operationTypes(): Promise<Record<string, string[]>> {
    this.#opTypes ??= await this.#adapter.run<Record<string, string[]>>("optypes", 0);
    return this.#opTypes;
  }

  /**
   * Predicted outcome of attacking a plot (docs/PLAN.md §7).
   *
   * The engine answers asynchronously, so this fires the query and then polls for the result.
   */
  async combatPreview(playerId: number, unitId: string, x: number, y: number): Promise<CombatPreview> {
    const fired = await this.#adapter.run<{ possible?: boolean; kind?: string; error?: string }>(
      "combat",
      playerId,
      { UNIT_ID: Number(unitId), TARGET_X: x, TARGET_Y: y, MODE: "fire" },
    );
    if (!fired.possible) return fired;

    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const read = await this.#adapter.run<{ ready: boolean; results?: unknown }>("combat", playerId, {
        UNIT_ID: Number(unitId),
        TARGET_X: x,
        TARGET_Y: y,
        MODE: "read",
      });
      if (read.ready) {
        // SAFETY: `results` is whatever the engine's combat preview produced — a record of damage
        // estimates whose keys vary by attack kind, merged in verbatim and only ever printed.
        const estimate = read.results as Record<string, Json>;
        return { ...fired, ...estimate };
      }
    }
    // The kind alone is still worth returning: melee vs ranged changes the decision.
    return { ...fired, note: "the engine did not return a damage estimate in time" };
  }

  /**
   * Paint the acting agent's name, action, and thinking onto the game window (§12).
   *
   * Throttled and fire-and-forget: a spectator overlay must never slow a turn down or fail one.
   */
  showOnScreen(playerId: number, name: string, update: { thinking?: string; action?: string }): void {
    if (update.thinking) this.#lastThinking.set(playerId, update.thinking);
    if (update.action) this.#lastAction.set(playerId, update.action);

    const now = Date.now();
    if (now - (this.#lastPaint.get(playerId) ?? 0) < 700) return;
    this.#lastPaint.set(playerId, now);

    void this.#adapter
      .run("overlay", playerId, {
        OVERLAY_WHO: `${name}  —  turn ${this.lastSnapshotTurn()}`,
        OVERLAY_ACTION: this.#lastAction.get(playerId) ?? "",
        OVERLAY_TEXT: this.#lastThinking.get(playerId) ?? "",
      })
      .catch(() => undefined);
  }

  /** Save this turn's reasoning next to the dump it was reading. */
  writeTranscript(playerId: number, text: string): void {
    const dir = this.#currentTurnDir.get(playerId);
    if (!dir) return;
    try {
      writeFileSync(join(dir, "transcript.md"), text + "\n");
    } catch { /* the turn directory may already be gone */ }
  }

  /**
   * The HUD as it is NOW, not as the turn began.
   *
   * `civ hud` used to replay the string built at turn start, so an agent that founded a city and
   * then asked for its situation was shown the situation before it acted. That is the one command
   * whose whole job is to say where you stand.
   *
   * The delta is the exception and stays as it was: "what changed since your last turn" is a fact
   * about the start of this turn, and an agent needs it stable to reason against. Everything else
   * — yields, units, settlements, what the game is waiting for — is re-read.
   */
  async currentHud(playerId: number, turnStartDelta: string): Promise<string> {
    const dir = this.#currentTurnDir.get(playerId);
    if (!dir) return turnStartDelta;
    await this.settleDump(playerId).catch(() => undefined);
    const raw = await this.#adapter.snapshot(playerId);
    const read = (name: string): string | undefined => {
      try {
        return readFileSync(join(dir, name), "utf8");
      } catch {
        return undefined;
      }
    };
    // The turn-start counts and the current inbox, not hardcoded zeros — `civ hud` claimed
    // "changed: 0 tiles" and "messages: 0 new" regardless of reality.
    const counts = this.#lastCounts.get(playerId) ?? { tilesChanged: 0, unitsChanged: 0, settlementsChanged: 0 };
    const messagesText = read("messages.txt");
    const messageCount = (messagesText ?? "").split("\n").filter((l) => l.startsWith("message ")).length;
    return renderHud(
      raw.header,
      raw.pending,
      counts,
      messageCount,
      {
        deltaText: turnStartDelta,
        pendingText: read("pending.txt"),
        unitsText: read("units.txt"),
        settlementsText: read("settlements.txt"),
        playersText: read("players.txt"),
        actionsText: read("actions.txt"),
        messagesText: read("messages.txt"),
        notesText: read("notes.md"),
      },
      this.#match,
    );
  }

  /** What other civs have said to this seat this turn. */
  currentMessages(playerId: number): string | null {
    const dir = this.#currentTurnDir.get(playerId);
    if (!dir) return null;
    try {
      return readFileSync(join(dir, "messages.txt"), "utf8");
    } catch {
      return null;
    }
  }

  /** This turn's tile dump, read back from disk — the same bytes the agent can read. */
  currentTilesText(playerId: number): string | null {
    const dir = this.#currentTurnDir.get(playerId);
    if (!dir) return null;
    try {
      return readFileSync(join(dir, "tiles.txt"), "utf8");
    } catch {
      return null;
    }
  }

  /** Where one of the player's own units is, from this turn's dump. */
  unitLocation(playerId: number, unitId: string): { x: number; y: number } | null {
    const dir = this.#currentTurnDir.get(playerId);
    if (!dir) return null;
    try {
      const text = readFileSync(join(dir, "units.txt"), "utf8");
      // Lines now lead with a handle, so match on the engine id that sits on the same line.
      const line = text
        .split("\n")
        .find((l) => l.startsWith("unit ") && l.includes(`engine_id=${unitId} `));
      const at = line ? /\bat=(\d+),(\d+)\b/.exec(line) : null;
      return at ? { x: Number(at[1]), y: Number(at[2]) } : null;
    } catch {
      return null;
    }
  }

  /**
   * Make one of the game's "pick a thing" decisions, or list the options when `value` is omitted.
   *
   * One method for build, tech, civic and government, because they differ only in which argument
   * shape the engine wants — and that difference belongs in one table, not in four call paths.
   */
  async choose(playerId: number, what: string, value?: string, targetId?: string): Promise<ChooseResult> {
    if (!value) {
      return this.#adapter.run<ChooseResult>("choose", playerId, {
        WHAT: what,
        THING: null,
        TARGET_ID: targetId ?? null,
        BLOCKER: null,
      });
    }
    return this.act(playerId, { kind: "choose", actionType: what, targetId, args: { thing: value } });
  }

  /** What you can do to another civilization, and doing it. */
  async diplomacy(playerId: number, other?: number, action?: string): Promise<DiplomacyResult> {
    if (other === undefined || !action) {
      return this.#adapter.run<DiplomacyResult>("diplomacy", playerId, {
        OTHER_PLAYER: other ?? null,
        ACTION: null,
      });
    }
    return this.act(playerId, {
      kind: "diplomacy",
      actionType: action,
      targetId: String(other),
      args: { other, action },
    });
  }

  /** Dismiss or open a notification. With no id, act on whatever is blocking the turn. */
  async notify(playerId: number, mode: "dismiss" | "activate", id?: string): Promise<ActionResult>{
    // Through act(), not straight to the adapter. This changes game state, so it must spend the
    // action budget and land in events.jsonl like anything else — metrics.ts scores hygiene from
    // `kind === "action"` events alone, so an unlogged mutation is invisible to the benchmark and
    // a seat could spend a whole turn dismissing notifications with a spotless record.
    // SAFETY: notify.js returns an ActionResult plus the target's id and name; the two extra
    // fields are read defensively below and an arm without them skips the verification.
    const result = (await this.act(playerId, {
      kind: "notify",
      actionType: mode,
      targetId: id,
      args: { mode, id: id ?? null },
    })) as ActionResult & { targetId?: string; targetName?: string | null };

    // Verify a dismissal actually took. The engine applies it asynchronously, and a DECISION
    // notification ignores dismissal entirely — six "ok — dismissed" answers in a row once sent
    // an agent in circles for a whole turn while the notification stood. Poll briefly; if it is
    // still there, say so and name the command that answers it.
    if (mode === "dismiss" && result.ok && result.targetId) {
      const stillThere = async (): Promise<boolean> => {
        const pending = await this.#adapter
          .run<{ items: Array<{ id: string }> }>("pending", playerId)
          .catch(() => null);
        if (!pending) return false; // an unreadable poll must not turn a real ok into a failure
        return pending.items.some((item) => item.id === result.targetId);
      };
      let standing = true;
      for (let attempt = 0; attempt < 8 && standing; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        standing = await stillThere();
      }
      if (standing) {
        const answer = answerFor(result.targetName ?? null);
        this.#log.append({
          turn: await this.#safeTurn(),
          player: playerId,
          playerName: this.#nameOf(playerId),
          kind: "action_correction",
          code: "DISMISS_IGNORED",
          message: result.targetName ?? result.targetId,
        });
        return {
          ok: false,
          code: "DISMISS_IGNORED",
          message:
            `the game ignored the dismissal — ${result.targetName ?? `notification ${result.targetId}`} ` +
            `is still standing. A decision cannot be dismissed; it has to be answered.`,
          hint: answer
            ? `answer it with \`${answer}\``
            : `\`civ open ${result.targetId}\` opens it; /current/pending.txt says what it is`,
        };
      }
    }
    return result;
  }

  /** Trade deals — the one part of diplomacy that is not an operation (§13). */
  async deal(
    playerId: number,
    mode: string,
    otherPlayer: number,
    extra?: { kind?: string; amount?: number; subject?: string },
  ): Promise<DealResult> {
    // `items` and `pending` only read; `send` and `clear` change the game and are accounted for.
    const reads = mode === "items" || mode === "pending";
    if (reads) {
      return this.#adapter.run<DealResult>("deal", playerId, { DEAL_MODE: mode, OTHER_PLAYER: otherPlayer });
    }
    return this.act(playerId, {
      kind: "deal",
      actionType: mode,
      targetId: String(otherPlayer),
      // `undefined` is not JSON. Absent fields are written as null so the event log round-trips.
      args: {
        mode,
        other: otherPlayer,
        itemKind: extra?.kind ?? null,
        amount: extra?.amount ?? null,
        subject: extra?.subject ?? null,
      },
    });
  }

  /**
   * Rewrite this turn's state files from the live game.
   *
   * Deliberately leaves hud.txt and delta.md alone: those describe the turn as it began, and an
   * agent needs a stable "what changed since last turn" to reason against. Only the current-state
   * files move.
   */
  /**
   * Everything this seat can legally do right now, asked of the engine.
   *
   * Written to the turn directory each turn so an agent can grep it for free. The alternative it
   * replaces was /run/rules/operations.txt: 229 lines, written once at match start, listing every
   * operation the build knows whether or not it applies. 36% of all actions ever taken were
   * refused, and the commonest refusal carried no reason, because the engine gives none for a
   * wrong argument. Agents had nowhere to look, so they guessed.
   */
  async legalActions(playerId: number): Promise<LegalActions> {
    return this.#adapter.run<LegalActions>("actions", playerId, {
      SEQ: this.#mutationSeq.get(playerId) ?? 0,
    });
  }

  /** Bring the dump up to date if the last refresh raced the engine. Cheap when it did not. */
  /**
   * Where a unit ended up, once the engine has actually applied its orders.
   *
   * Settles first. Reading straight after an action gives the state BEFORE the request was
   * applied — the mistake behind five separate bugs in this project — so this waits for the same
   * settle every command already waits for.
   */
  async unitReport(playerId: number, unitId: string): Promise<string | null> {
    await this.settleDump(playerId).catch(() => undefined);
    const seen = await this.#adapter
      .run<UnitState>("unitstate", playerId, { UNIT_ID: Number(unitId) })
      .catch(() => null);
    if (!seen || seen.error || !seen.at) return null;
    const moves = seen.moves ?? 0;
    return `unit ${seen.id} is at ${seen.at} with ${moves} move${moves === 1 ? "" : "s"} left` +
      (moves === 0 ? " — it is finished for this turn" : "");
  }

  /** Where a unit is right now, without settling. For comparing before and after an order. */
  async unitAt(playerId: number, unitId: string): Promise<string | null> {
    const seen = await this.#adapter
      .run<UnitState>("unitstate", playerId, { UNIT_ID: Number(unitId) })
      .catch(() => null);
    return seen && !seen.error ? seen.at : null;
  }

  /** A unit's remaining movement right now, without settling. */
  async unitMoves(playerId: number, unitId: string): Promise<number | null> {
    const seen = await this.#adapter
      .run<UnitState>("unitstate", playerId, { UNIT_ID: Number(unitId) })
      .catch(() => null);
    return seen && !seen.error ? seen.moves : null;
  }

  /**
   * A verdict the CLI reached AFTER the action event was logged — a DID_NOT_MOVE or NOT_QUEUED.
   * Without this the event log said ok:true for an action the agent was told failed, and the
   * record and the transcript disagreed.
   */
  logCorrection(playerId: number, code: string, message: string): void {
    this.#log.append({
      turn: this.lastSnapshotTurn(),
      player: playerId,
      playerName: this.#nameOf(playerId),
      kind: "action_correction",
      code,
      message,
    });
  }

  /**
   * Wait for a move order to visibly change the unit, then report the unit's state.
   *
   * The engine applies orders asynchronously, so a read on the next line sees the pre-move state
   * — and the old DID_NOT_MOVE check read exactly there, confidently calling working moves
   * "unreachable". Poll the way combatPreview does; only a unit still unchanged after the wait
   * has genuinely not moved.
   */
  async waitForMove(
    playerId: number,
    unitId: string,
    before: { at: string | null; moves: number | null },
  ): Promise<{ changed: boolean; state: UnitState | null }> {
    let last: UnitState | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      last = await this.#adapter
        .run<UnitState>("unitstate", playerId, { UNIT_ID: Number(unitId) })
        .catch(() => null);
      if (!last || last.error) continue;
      if (last.at !== before.at || last.moves !== before.moves) {
        return { changed: true, state: last };
      }
    }
    return { changed: false, state: last };
  }

  /**
   * Wait for a build order to appear in the settlement's queue, then say what the queue holds.
   *
   * Same async story as waitForMove: a single immediate read produced false "NOT_QUEUED —
   * the engine accepted the order and queued nothing" verdicts for orders that had worked.
   */
  async waitForQueued(playerId: number, cityId: string, thing: string): Promise<string | null> {
    let queue: string | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const seen = await this.#adapter
        .run<ChooseResult>("choose", playerId, { WHAT: "build", THING: null, TARGET_ID: cityId, BLOCKER: null })
        .catch(() => null);
      queue = seen?.current ? `now building: ${seen.current}` : null;
      if (queue?.includes(thing)) return queue;
    }
    return queue;
  }

  /**
   * What a settlement is building, once the engine has applied the order.
   *
   * Settles first, for the same reason unitReport does: reading straight after a request gives
   * the state before it was applied.
   */
  async buildReport(playerId: number, cityId: string): Promise<string | null> {
    await this.settleDump(playerId).catch(() => undefined);
    const seen = await this.#adapter
      .run<ChooseResult>("choose", playerId, {
        WHAT: "build",
        THING: null,
        TARGET_ID: cityId,
        BLOCKER: null,
      })
      .catch(() => null);
    return seen?.current ? `now building: ${seen.current}` : null;
  }

  /**
   * Append a line to the seat's journal.
   *
   * A command, because the shell form is one character away from destroying the thing. 36 of 41
   * journal writes in three runs used `>` rather than `>>`, so six of nine agents finished a
   * fifteen-turn game with one line of memory and three with none — in the one file the briefing
   * calls "the only thing that survives between turns". This cannot overwrite.
   */
  async note(playerId: number, text: string): Promise<ActionResult> {
    const line = text.trim();
    if (line.length === 0) return { ok: false, code: "EMPTY_NOTE", message: "nothing to write" };
    const turn = await this.#adapter.turn().catch(() => 0);
    const path = join(this.#runDir, "notes", this.#nameOf(playerId), "notes.md");
    try {
      appendFileSync(path, `- t${turn}: ${line}\n`);
    } catch (err) {
      return { ok: false, code: "NOTE_FAILED", message: String(err) };
    }
    return { ok: true, note: "added to your journal" };
  }

  async settleDump(playerId: number): Promise<void> {
    if (!this.#dumpStale.delete(playerId)) return;
    await this.refreshDump(playerId).catch(() => undefined);
  }

  async refreshDump(playerId: number): Promise<void> {
    const dir = this.#currentTurnDir.get(playerId);
    if (!dir) return;
    const raw = await this.#adapter.snapshot(playerId);
    const memory = this.#memory.get(playerId) ?? emptyMemory();
    // The SAME fog filter the turn-start snapshot applies. This refresh used to write
    // raw.units.foreign unfiltered — every mid-turn read bypassed the second defense layer — and
    // it never committed what it merged, so a mid-turn reveal lost its last_seen by next turn.
    const { tiles, visibleForeign, foreignSettlements } = applyFog(raw, memory);
    this.#memory.set(playerId, { tiles, foreignSettlements, handles: memory.handles });
    writeFileSync(join(dir, "tiles.txt"), tileLines(tiles).join("\n") + "\n");
    writeFileSync(join(dir, "tiles.jsonl"), toJsonl(tiles) + "\n");
    // Same handles as the turn-start write. Without them this mid-turn refresh overwrote
    // `unit scout-1 ...` with `unit 131072 ...` on the first settle of every turn, so the names
    // existed only in the file nobody read twice.
    writeFileSync(
      join(dir, "units.txt"),
      unitLines(raw.units.own, visibleForeign, memory.handles).join("\n") + "\n",
    );
    writeFileSync(join(dir, "units.jsonl"), toJsonl([...raw.units.own, ...visibleForeign]) + "\n");
    writeFileSync(join(dir, "settlements.txt"), settlementLines(raw.settlements.own, foreignSettlements).join("\n") + "\n");
    writeFileSync(join(dir, "settlements.jsonl"), toJsonl([...raw.settlements.own, ...foreignSettlements]) + "\n");
    writeFileSync(join(dir, "players.txt"), playerLines(raw.players.known).join("\n") + "\n");
    writeFileSync(join(dir, "pending.txt"), pendingLines(raw.pending).join("\n") + "\n");
    writeFileSync(join(dir, "pending.jsonl"), toJsonl(raw.pending.items) + "\n");
    writeFileSync(join(dir, "header.json"), JSON.stringify(raw.header, null, 2));

    // actions.txt too. It was written once at turn start and left to rot: after the first move of
    // the turn it described a position the agent no longer had, while the briefing tells agents to
    // trust it over guessing.
    try {
      const legal = await this.legalActions(playerId);
      writeFileSync(join(dir, "actions.txt"), actionLines(legal).join("\n") + "\n");
    } catch { /* the previous copy is better than none */ }
  }

  /** Legal actions for a settlement, or for the player themselves. */
  async catalogue(playerId: number, kind: "city" | "player", targetId?: string): Promise<CatalogueResult> {
    return this.#adapter.run<CatalogueResult>("catalogue", playerId, {
      KIND: kind,
      TARGET_ID: targetId ?? null,
    });
  }

  async whatCan(playerId: number, unitId: string, target?: { x: number; y: number }) {
    const result = await this.#adapter.run<WhatCanResult>("whatcan", playerId, {
      UNIT_ID: Number(unitId),
      UNIT_OWNER: playerId,
      TARGET: target ?? null,
      SEQ: this.#mutationSeq.get(playerId) ?? 0,
    });
    // Record what the agent was TOLD, not just that it asked — reconstructing a confused turn
    // from the log was impossible when every what_can line carried only the unit id.
    this.#log.append({
      turn: await this.#safeTurn(),
      player: playerId,
      kind: "what_can",
      unitId,
      extra: {
        legal: (result.legal ?? []).map((a) => a.short).join(",").slice(0, 300),
        illegal: (result.illegal ?? []).length,
      },
    });
    return result;
  }

  /**
   * Log one refusal and hand it back. Every pre-flight guard in act() ends this way; before the
   * extraction each wrote its own log block, and the five copies had already drifted (one logged
   * `actionsUsed`, one used a different event kind).
   *
   * `spends` marks refusals that count against the turn (an attempted game action); a refusal
   * that only reports state — turn already over, budget already gone — spends nothing.
   */
  async #refuseAction(
    playerId: number,
    request: ActionRequest,
    refused: ActionResult,
    opts: { logKind: "action" | "action_refused"; spends?: TurnState },
  ): Promise<ActionResult> {
    const event: Event = {
      turn: await this.#safeTurn(),
      player: playerId,
      playerName: this.#nameOf(playerId),
      kind: opts.logKind,
      request,
      result: refused,
    };
    if (opts.spends) {
      opts.spends.actionsUsed++;
      opts.spends.illegalCount++;
      event.actionsUsed = opts.spends.actionsUsed;
    }
    this.#log.append(event);
    return refused;
  }

  /** Near-miss suggestions for an operation name this build does not define. */
  #suggestOperations(actionType: string, known: string[]): string[] {
    const wanted = new Set(
      actionType
        .replace(/^(PLAYEROPERATION|UNITOPERATION|UNITCOMMAND|CITYOPERATION|CITYCOMMAND)_/, "")
        .split("_")
        .filter((w) => w.length > 2),
    );
    return known
      .map((name) => ({ name, score: name.split("_").filter((w) => wanted.has(w)).length }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((s) => s.name);
  }

  async act(playerId: number, request: ActionRequest): Promise<ActionResult> {
    const state = this.#turnState.get(playerId);
    const agent = this.#agents.get(playerId);
    if (!state || !agent) return { ok: false, code: "NOT_YOUR_TURN", message: "no active turn" };

    // A zombie brain acting past its turn used to be refused silently, so the record showed a
    // clean turn where a timed-out agent was still firing commands.
    if (state.ended) {
      return this.#refuseAction(playerId, request, {
        ok: false,
        code: "TURN_ENDED",
        message: "you have already ended this turn",
      }, { logKind: "action_refused" });
    }

    // Engine internals with no UI button. One returned ok once and taught an agent a 17-turn
    // ritual; a human is never offered these, so refusing them is parity, not a limit.
    if (ENGINE_INTERNAL_OPS.test(request.actionType)) {
      return this.#refuseAction(playerId, request, {
        ok: false,
        code: "ENGINE_INTERNAL",
        message:
          `${request.actionType} is engine plumbing, not a game action — a human player has no ` +
          `button for it and it does nothing for your civilization`,
        hint: "actions.txt lists what the game actually offers you",
      }, { logKind: "action", spends: state });
    }

    // A runaway backstop, not a rule of the game. Civ has no per-turn action budget — the number
    // sits far above anything legitimate and exists only to catch a loop. What actually stops a
    // loop is the repeat guard below; what bounds cost is the per-turn time limit.
    if (state.actionsUsed >= agent.actionsPerTurn) {
      return this.#refuseAction(playerId, request, {
        ok: false,
        code: "ACTION_BUDGET_SPENT",
        message:
          `the harness stopped you after ${agent.actionsPerTurn} actions in one turn. This is a ` +
          `runaway guard, not a rule of Civ — if you are here, something is looping.`,
        hint: "end your turn",
      }, { logKind: "action_refused" });
    }

    // Reject an invented action type here, with the valid names. The engine's own refusal for an
    // unknown type carries no FailureReasons at all — agents were guessing FOO, SET_PRODUCTION,
    // CHOOSE_TECH and getting back "the game refused this action", which teaches them nothing.
    // Only reject when the catalogue looks complete for this category; if it is short we are
    // probably reading the wrong source.
    const catalogue = await this.operationTypes().catch(() => undefined);
    const known = catalogue?.[request.kind];
    if (known && known.length >= 4 && !known.includes(request.actionType)) {
      const suggestions = this.#suggestOperations(request.actionType, known);
      return this.#refuseAction(playerId, request, {
        ok: false,
        code: "NO_SUCH_OPERATION",
        message: `${request.kind} "${request.actionType}" does not exist in this build`,
        hint:
          suggestions.length > 0
            ? `did you mean: ${suggestions.join(", ")}`
            : `run \`civ list-ops ${request.kind}\` for the valid names, or \`civ what-can\` for what applies now`,
      }, { logKind: "action", spends: state });
    }

    // Refuse an action that has already been issued identically several times this turn.
    //
    // A bare `civ dismiss` is exempt: each call targets whatever is blocking NOW, so three
    // identical-looking dismissals can be three different notifications — the guard once told an
    // agent its fourth legitimate dismissal "is not changing anything", which was false. The
    // dismissal verifier is what breaks a genuine dismiss loop.
    const guarded = !(request.kind === "notify" && !request.targetId);
    const signature = `${request.kind}:${request.targetId ?? ""}:${request.actionType}:${JSON.stringify(request.args ?? {})}`;
    const seen = (state.repeats.get(signature) ?? 0) + 1;
    if (guarded) state.repeats.set(signature, seen);
    if (guarded && seen > SAME_ACTION_LIMIT) {
      return this.#refuseAction(playerId, request, {
        ok: false,
        code: "NOTHING_CHANGED",
        message: `you have already done exactly this ${seen - 1} times this turn — it is not changing anything`,
        hint: "do something else, or run `civ end-turn`",
      }, { logKind: "action", spends: state });
    }

    state.actionsUsed++;
    const result = await this.#adapter.run<ActionResult>(
      scriptForAction(request.kind),
      playerId,
      adapterArgsFor(request),
    );
    if (!result.ok) state.illegalCount++;
    if (result.ok) this.#mutationSeq.set(playerId, (this.#mutationSeq.get(playerId) ?? 0) + 1);

    // Refresh the dump so the agent can see what its own action did.
    //
    // The files were a start-of-turn snapshot, so after founding a city an agent re-read
    // settlements.txt and found nothing there — six times in one observed turn. It then thrashed:
    // turn 1 took 17s, turn 2 took 312s and timed out. A read costs about 0.2s, which is nothing
    // beside that.
    // Refresh now AND mark the dump stale.
    //
    // The engine applies a request asynchronously, so this refresh often captures the state from
    // BEFORE the action — which is why the harness must never describe state in an action reply.
    // The stale flag makes the next command refresh again, by which point a model round trip has
    // passed and the engine has caught up. The files are the agent's source of truth, so they
    // have to be right rather than merely recent.
    // Mark it stale; do NOT refresh here.
    //
    // The engine applies a request asynchronously, so a refresh on this line captures the state
    // from BEFORE the action about as often as after it — and then writes that to the files the
    // agent trusts. Every read settles first (see settleDump, called before every sandbox
    // command), so by the time anything looks at the dump it is genuinely current. Refreshing
    // eagerly bought nothing except a second full snapshot per action and a window in which the
    // files held the wrong answer.
    if (result.ok) this.#dumpStale.add(playerId);

    this.#log.append({
      turn: await this.#safeTurn(),
      player: playerId,
      playerName: this.#nameOf(playerId),
      kind: "action",
      request,
      result,
      actionsUsed: state.actionsUsed,
    });
    return result;
  }

  /**
   * Export the gameplay database once per match, into every agent's rules/ directory.
   *
   * §7 calls this essential parity: a human plays with the Civilopedia open, and memorised Civ VII
   * knowledge is thin and partly stale after 1.4.1. The briefing has advertised rules/ since the
   * beginning and nothing ever wrote it, so agents were guessing costs and prerequisites from
   * training data about a game that has been patched since.
   */
  /**
   * The database keeps the UI's own markup in its text columns, so a rules grep came back as
   *   "+1 [icon:YIELD_CULTURE] Culture on [icon:CITY_URBAN] [TIP:LOC_PEDIA_..._TOOLTIP]Districts[/TIP]"
   * An agent searching for how settling works had to read past all of it. Strip the icon and tip
   * tags and keep the words they wrap.
   */
  async exportRules(): Promise<{ tables: number; rows: number }> {
    // A useful subset, not everything: the whole database is enormous and most of it is art and
    // audio bindings the agent will never need.
    const wanted = [
      "Units", "Constructibles", "Buildings", "Improvements", "Yields", "Resources",
      "Terrains", "Biomes", "Features", "Civilizations", "Leaders", "Ages",
      "ProgressionTreeNodes", "Traditions", "Projects", "LegacyPaths", "Victories",
      "UnitOperations", "UnitCommands", "PlayerOperations", "DiplomacyActions",
      // The tables that make the ones above worth having. Without ProgressionTreeNodeUnlocks an
      // agent picks research blind; without Unit_Stats it cannot judge a fight without a combat
      // preview per target; without AgeProgressionMilestones the Legacy targets have no source.
      "ProgressionTreeNodeUnlocks", "Unit_Stats", "Constructible_Adjacencies", "Constructible_YieldChanges",
      "AgeProgressionMilestones", "UnitPromotions", "UnitPromotionDisciplines", "Attributes",
      "GoldenAges", "Beliefs", "Religions", "Independents",
    ];
    const available = new Set(await this.#adapter.ruleTables().catch(() => []));
    let tables = 0;
    let rows = 0;

    for (const table of wanted) {
      if (available.size > 0 && !available.has(table)) continue;
      const data = await this.#adapter.ruleTable(table).catch(() => null);
      if (!data || data.rows.length === 0) continue;
      tables++;
      rows += data.rows.length;
      const cleaned = data.rows.map(stripMarkup);
      // One JSON file per table, plus a greppable text summary — the same text/JSON pairing the
      // dump uses (§6.1), for the same reason.
      for (const agent of this.#agents.values()) {
        const dir = join(this.#runDir, "agents", agent.name, "rules");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${table}.json`), JSON.stringify(cleaned, null, 1));
      }
    }

    // The operation names live in global enums rather than GameInfo tables, so they need their
    // own export — and they are the single most useful thing in rules/ for an acting agent.
    const ops: Record<string, string[]> = await this.operationTypes().catch(() => ({}));
    for (const agent of this.#agents.values()) {
      const dir = join(this.#runDir, "agents", agent.name, "rules");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "operations.json"), JSON.stringify(ops, null, 1));
      const flat = Object.entries(ops)
        .flatMap(([kind, names]) => names.map((n) => `${kind}  ${n}`))
        .join("\n");
      writeFileSync(join(dir, "operations.txt"), flat + "\n");
    }

    for (const agent of this.#agents.values()) {
      const dir = join(this.#runDir, "agents", agent.name, "rules");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "README.md"),
        `# rules\n\nThe gameplay database of this build, one JSON file per table.\n` +
          `Exported once at the start of the match, so it matches the installed version and DLC.\n\n` +
          `Use jq: \`jq '.[] | select(.UnitType=="UNIT_SCOUT")' /run/rules/Units.json\`\n\n` +
          `Tables: ${tables}, rows: ${rows}.\n`,
      );
    }
    this.#log.append({ turn: 0, player: null, kind: "rules_exported", tables, rows });
    return { tables, rows };
  }

  /**
   * Save the match under a name derived from the run and turn (§10).
   *
   * Named per turn rather than overwritten, so a run can be resumed from any point rather than
   * only the last one — useful when the last turn is the one that broke.
   */
  async save(label: string): Promise<{ requested: boolean; name?: string; error?: string }> {
    const name = `civbench-${label}`;
    const result = await this.#adapter
      .run<{ requested: boolean; name?: string; error?: string }>("save", 0, { SAVE_NAME: name })
      .catch((err: Error) => ({ requested: false, error: err.message }));
    this.#log.append({
      turn: this.lastSnapshotTurn(),
      player: null,
      kind: "save",
      name,
      ok: result.requested,
      error: result.error ?? null,
    });
    return result;
  }

  /**
   * Replace a refusal's generic hint with the command that ANSWERS the blocker, and list what
   * the engine will accept for a stuck unit — as RUNNABLE commands, internals filtered.
   *
   * The refusal's own hint said "run `civ dismiss` to clear it" for every blocker, and dismiss
   * does nothing to a decision. The raw short-name accept list ("execute_script, move_to,
   * wait_for, delete") recommended plumbing and near-deleted a scout. The script's own specific
   * hints ("give unit 196609 an order") are kept; only the generic dismiss text is replaced.
   */
  async #improveEndTurnHints(playerId: number, result: EndTurnRun): Promise<void> {
    const generic = result.hint === undefined || result.hint.includes("civ dismiss");
    if (result.blocking && generic) {
      const answer = answerFor(result.blocking);
      if (answer) result.hint = `answer it with \`${answer}\``;
    }
    const stuck = result.ready?.id;
    if (!stuck) return;
    const can = await this.whatCan(playerId, stuck).catch(() => null);
    const commands = (can?.legal ?? [])
      .map((a) => unitCommandLine(stuck, a.kind ?? "unit_operation", a.type))
      .filter((line) => !ENGINE_INTERNAL_OPS.test(line));
    if (commands.length > 0) {
      result.hint = `${result.hint ?? ""}\nthe engine will accept these for unit ${stuck}: ` +
        commands.slice(0, 8).join("  |  ");
    }
  }

  /**
   * Verify that an "ok" end-turn actually took, and downgrade it when it did not.
   *
   * An ok from endturn.js means the request was SENT, not that the turn ended — the flags it
   * reads apply asynchronously. A seat still active with the sent flag clear and the turn
   * unmoved was silently refused; reporting that ok stalled rounds for ~4 minutes each and
   * charged the forced end to an innocent seat — 3 of one seat's 4 "forced ends" in the last
   * live run were this.
   */
  async #verifyEndTurnTook(playerId: number, result: EndTurnRun, state: TurnState): Promise<void> {
    const before = result.turnBefore ?? (await this.#safeTurn());
    type Verdict = { active?: boolean | null; sent?: boolean | null; turn?: number; blocking?: string | null };
    let verdict: Verdict | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      verdict = await this.#adapter.run<Verdict>("endcheck", playerId).catch(() => null);
      if (!verdict) continue;
      if (verdict.active === false || (verdict.turn ?? before) > before) break; // it ended
      if (verdict.sent === true) break; // accepted, the engine is working through it
    }
    const refused = verdict !== null && verdict.active === true && verdict.sent === false &&
      (verdict.turn ?? before) <= before;
    if (!refused) return;
    state.ended = false;
    const blocking = verdict?.blocking ?? null;
    const answer = answerFor(blocking);
    result.ok = false;
    result.code = "END_TURN_REFUSED";
    result.message = blocking
      ? `the game quietly refused the end of your turn — it is still waiting on ${blocking}`
      : "the game quietly refused the end of your turn and named no reason";
    result.hint = answer
      ? `answer it with \`${answer}\``
      : "check /current/pending.txt, and `civ what-can` on each unit with moves left";
    result.blocking = blocking;
  }

  async endTurn(playerId: number, forced = false): Promise<ActionResult> {
    const state = this.#turnState.get(playerId);
    // Ending an already-ended turn is a no-op, not a second end-turn. An agent that keeps
    // calling it would otherwise re-run the engine command and burn its whole time budget.
    if (state?.ended && !forced) {
      return {
        ok: true,
        code: "TURN_ALREADY_ENDED",
        message: "your turn is already over — stop issuing commands",
      };
    }
    if (state) state.ended = true;
    // Leave the turn's files matching how the turn actually finished. Nothing reads them again
    // this turn, but the replay and the run report do.
    await this.settleDump(playerId).catch(() => undefined);
    if (forced) await this.#clearEndTurnBlockers(playerId);
    const result = await this.#adapter.run<EndTurnRun>("endturn", playerId, { FORCED: forced, CLEAR_ONLY: false });
    // A refused end-turn is not the end of the turn. Saying otherwise left the seat active in the
    // game while the match moved on, and the round then waited forever for it to advance.
    if (state && !result.ok) state.ended = false;
    if (!result.ok) await this.#improveEndTurnHints(playerId, result);
    if (result.ok && !forced && state) await this.#verifyEndTurnTook(playerId, result, state);

    // Messages are marked read only when the agent's own turn ends cleanly. A timed-out turn
    // may never have read its inbox, and those messages must reappear next turn.
    if (result.ok && !forced) this.#chat.markRead(this.#nameOf(playerId));

    await this.#logTurnEnd(playerId, forced, result, state);
    return result;
  }

  /** The turn_end record. `ok` matters: without it the log rendered a refusal exactly like a
   *  success, and a turn appeared to end three times. */
  async #logTurnEnd(
    playerId: number,
    forced: boolean,
    result: EndTurnRun,
    state: TurnState | undefined,
  ): Promise<void> {
    this.#log.append({
      turn: await this.#safeTurn(),
      player: playerId,
      playerName: this.#nameOf(playerId),
      kind: forced ? "turn_end_forced" : "turn_end",
      ok: result.ok,
      code: result.code ?? null,
      blocking: result.blocking ?? null,
      actionsUsed: state?.actionsUsed ?? 0,
      illegalActions: state?.illegalCount ?? 0,
    });
  }

  /**
   * Make a forced end-turn actually possible before sending it.
   *
   * Two things gate the end of a turn, and each one needed a fix the other did not.
   *
   * Units: skipping them is applied asynchronously, so skipping and sending in one pass sends
   * while they still have moves. Clearing is its own call, with a gap before the send.
   *
   * Notifications: an informational one can be dismissed, and a DECISION one cannot.
   * NOTIFICATION_TRADITIONS_AVAILABLE ignored dismiss, so the old loop dismissed it eight times,
   * the game refused the end-turn without a word, and the run sat on turn 4 until it was killed.
   * A decision gets answered through the same table `civ tradition` uses.
   */
  async #clearEndTurnBlockers(playerId: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cleared = await this.#adapter
        .run<{ blocking?: string | null; skipped?: number }>("endturn", playerId, { FORCED: true, CLEAR_ONLY: true })
        .catch(() => ({ blocking: null, skipped: 0 }));
      if (cleared.blocking) {
        const answered = await this.#adapter
          .run<ChooseResult & { answered?: string; picked?: string }>(
            "choose", playerId, { WHAT: null, THING: null, TARGET_ID: null, BLOCKER: cleared.blocking },
          )
          .catch(() => undefined);
        // A forced clear can ANSWER a decision for the agent — a tech picked, a story closed.
        // That is a game-state mutation and it belongs in the record: an unlogged one is exactly
        // what notify()'s comment forbids, and the replay could not explain the changed state.
        this.#log.append({
          turn: await this.#safeTurn(),
          player: playerId,
          playerName: this.#nameOf(playerId),
          kind: "forced_answer",
          blocking: cleared.blocking,
          ok: answered?.ok ?? false,
          code: answered?.code ?? null,
          extra: {
            // SAFETY: choose.js's blocker path returns { answered, picked } on success; both
            // reads are optional, so any other shape contributes null to the record.
            answered: (answered as { answered?: string } | undefined)?.answered ?? null,
            picked: (answered as { picked?: string } | undefined)?.picked ?? null,
            skippedUnits: cleared.skipped ?? null,
          },
        });
      }
      // Let the engine apply the skips, the dismissal and the answer before reading or sending.
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (!cleared.blocking) return;
    }
  }

  /**
   * Is the match decided — a victory claimed, or all rivals eliminated?
   *
   * Elimination only counts when this match HAS rivals: a one-seat harness test is not "decided"
   * at turn 1 because its only player is the last one standing.
   */
  async gameOver(): Promise<{ over: boolean; why: string | null }> {
    const seen = await this.#adapter
      .run<{ victories: Array<{ team: number | null; type: string | null }>; aliveMajors: number }>(
        "gameover", 0,
      )
      .catch(() => null);
    if (!seen) return { over: false, why: null };
    const claimed = seen.victories[0];
    if (claimed) {
      return {
        over: true,
        why: `${claimed.type ?? "a victory"} claimed by team ${claimed.team ?? "?"}`,
      };
    }
    const seats = this.#agents.size;
    if (seats > 1 && seen.aliveMajors >= 0 && seen.aliveMajors <= 1) {
      return { over: true, why: `only ${seen.aliveMajors} major civilization left alive` };
    }
    return { over: false, why: null };
  }

  /** The match's decisive moment, once, in the record. */
  logGameOver(why: string): void {
    this.#log.append({
      turn: this.lastSnapshotTurn(),
      player: null,
      kind: "game_over",
      message: why,
    });
  }

  /**
   * Wait for the game to actually advance past `fromTurn` (docs/PLAN.md §10).
   *
   * Ending a turn is asynchronous: the engine has to run every other player before ours comes
   * round again. Reading the next turn immediately gives the previous turn's state, which
   * silently produces duplicate snapshots and a replay that does not line up.
   */
  async waitForTurnAdvance(fromTurn: number, timeoutMs = 60_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const turn = await this.#adapter.turn();
      if (turn > fromTurn) return turn;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // A timeout is worth recording: it usually means the game is blocked on something.
    this.#log.append({ turn: fromTurn, player: null, kind: "turn_advance_timeout", timeoutMs });
    return fromTurn;
  }

  currentTurn(): Promise<number> {
    return this.#adapter.turn();
  }


  /**
   * Which of our seats the game is currently offering, or null if none yet.
   *
   * Hotseat chooses the order, not us. Asking is the only correct way to know whose turn it is.
   */
  async activeSeat(playerIds: number[], timeoutMs = 120_000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    let lastError: string | null = null;
    let lastSeen: number[] = [];
    while (Date.now() < deadline) {
      // A failed read is not the same as an idle game.
      //
      // This used to swallow every error and return an empty seat list, so a bridge timeout, a
      // dropped socket or a busy engine all reported "no seat became active — the game may be
      // waiting on something". That sent me looking at the game for hours when the harness simply
      // could not see it. Say which it is.
      let seats: { majors: Array<{ id: number; active: boolean }> };
      try {
        seats = await this.#adapter.run<{ majors: Array<{ id: number; active: boolean }> }>("seats", 0);
      } catch (err) {
        lastError = String(err);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      const active = seats.majors.find((m) => m.active && playerIds.includes(m.id));
      if (active) return active.id;
      // Remember who the game DID say was active, so a mismatch is visible rather than silent.
      lastSeen = seats.majors.filter((m) => m.active).map((m) => m.id);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // Say WHICH of the three this was, and let the caller carry on.
    //
    // An earlier version threw here. That was wrong: "the game is on p1 while we wait for p2" is
    // an ordinary transient — the round's bookkeeping is briefly out of step with hotseat's own
    // order, and it resolves itself. Throwing killed a healthy run at turn 14. The fault was
    // never that this case was survivable; it was that all three printed the same line.
    this.lastSeatWait = lastError
      ? `could not read which seat is active for ${Math.round(timeoutMs / 1000)}s: ${lastError}`
      : lastSeen.length > 0
        ? `the game is on p${lastSeen.join(", p")}, which has already played this round — ` +
          `waiting for ${playerIds.map((p) => `p${p}`).join(", ")}`
        : "no seat became active — the game may be waiting on something";
    return null;
  }

  /**
   * Wait until it is this seat's turn (docs/PLAN.md §4).
   *
   * Hotseat passes the seat around: one player is active at a time and the local player switches
   * as turns complete. Acting out of order gets refused by the engine, so a seat waits for its
   * own turn before it reads or acts.
   */
  async waitForSeat(playerId: number, timeoutMs = 180_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastError: string | null = null;
    let lastSeen: number[] = [];
    while (Date.now() < deadline) {
      const state = await this.#adapter
        .run<{ active: boolean }>("active", playerId)
        .catch(() => ({ active: false }));
      if (state.active) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    this.#log.append({
      turn: this.lastSnapshotTurn(),
      player: playerId,
      playerName: this.#nameOf(playerId),
      kind: "seat_wait_timeout",
      timeoutMs,
    });
    return false;
  }

  /**
   * The highest game turn any seat has actually been snapshotted at.
   *
   * Safer than querying the game for the round barrier: the query can fail while the engine is
   * busy, and a failed query used to skip the barrier entirely, which snapshotted the same turn
   * twice and produced a replay that did not line up.
   */
  lastSnapshotTurn(): number {
    return Math.max(0, ...this.#lastTurnSeen.values());
  }

  /** A brain that threw. Recorded so a silent forfeit can be explained afterwards. */
  logBrainError(playerId: number, message: string): void {
    this.#log.append({
      turn: this.lastSnapshotTurn(),
      player: playerId,
      playerName: this.#nameOf(playerId),
      kind: "brain_error",
      message,
    });
  }

  /** Hygiene counters for the run report (§13). Reported beside results, always. */
  /**
   * The numeric id behind a readable handle, or the text unchanged if it is not one.
   *
   * Commands take either. `civ move scout-1 47,16` and `civ move 131072 47,16` are the same
   * order; the first is the one an agent can actually hold in its head.
   */
  resolveHandle(playerId: number, text: string): string {
    const handles = this.#memory.get(playerId)?.handles;
    const unit = handles ? idForHandle(handles, text) : null;
    if (unit) return unit;
    // Settlements go by the name the game gave them, so `civ build Pārsa UNIT_SCOUT` works.
    // Compare loosely: the dump writes spaces as underscores and the names carry diacritics, so
    // an agent typing "Ha Noi" or "Parsa" must still hit — the exact-match version fell through
    // to a reasonless engine refusal.
    const dir = this.#currentTurnDir.get(playerId);
    if (!dir) return text;
    const loose = (name: string): string =>
      name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[_\s]+/g, "")
        .toLowerCase();
    try {
      const wanted = loose(text.trim());
      for (const l of readFileSync(join(dir, "settlements.txt"), "utf8").split("\n")) {
        if (!l.startsWith("settlement ")) continue;
        const name = l.slice("settlement ".length).split(" ")[0] ?? "";
        if (loose(name) !== wanted) continue;
        const id = /\bengine_id=(\d+)\b/.exec(l);
        if (id) return id[1]!;
      }
    } catch { /* no settlements this turn */ }
    return text;
  }

  /** The handle for a unit, for echoing an order back in the words the agent used. */
  handleOf(playerId: number, unitId: string): string {
    const handles = this.#memory.get(playerId)?.handles;
    return handles?.units[unitId] ?? unitId;
  }

  turnStats(playerId: number): TurnState | undefined {
    return this.#turnState.get(playerId);
  }
}

/**
 * Remove Civ's UI markup from a database row's text columns.
 *
 * `[icon:X]` is a picture the agent cannot see; `[TIP:X]word[/TIP]` and `[B]word[/B]` wrap words
 * worth keeping. Anything unrecognised is left alone rather than guessed at.
 *
 * Takes Json rather than `<T>(row: T): T`. As a generic the walk had to assert its way out of
 * every branch — string, array and object each needed a cast to convince the compiler the result
 * was still a T.
 */
function stripMarkup(row: Json): Json {
  if (typeof row === "string") {
    return row
      .replace(/\[icon:[^\]]*\]/g, "")
      .replace(/\[\/?(?:TIP|B|I|S|LINK)(?::[^\]]*)?\]/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
  if (Array.isArray(row)) return row.map(stripMarkup);
  if (row && typeof row === "object") {
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, stripMarkup(v)]));
  }
  return row;
}
