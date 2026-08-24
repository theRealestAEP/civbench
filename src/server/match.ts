// The Match Server owns the game (docs/PLAN.md §3).
//
// It is the trust boundary. Agents reach it only through the `civ` command; they never touch
// the adapter and never see raw JS. It schedules turns, validates every action, enforces the
// budgets in §10, and writes the event log.
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import type { GameAdapter } from "../adapter/game.ts";
import { writeSnapshot, emptyMemory, type PlayerMemory } from "../dump/snapshot.ts";
import type { MatchFacts } from "../dump/hud.ts";
import { mergeTiles, mergeForeignSettlements } from "../dump/merge.ts";
import {
  tileLines, unitLines, settlementLines, playerLines, pendingLines, toJsonl,
} from "../dump/write.ts";
import { EventLog } from "./events.ts";
import { ChatChannel, renderMessages, type ChatMessage } from "./chat.ts";

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
    | "choose";
  targetId?: string | number;
  actionType: string;
  args?: Record<string, unknown>;
};

export type ActionResult = {
  ok: boolean;
  code?: string;
  message?: string;
  hint?: string;
  /** What a successful action changed, when that is not obvious. */
  note?: string;
};

type TurnState = {
  actionsUsed: number;
  ended: boolean;
  illegalCount: number;
  /** How many times each exact action has been issued this turn. */
  repeats: Map<string, number>;
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
  #log: EventLog;

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
      const notes = join(this.agentDir(a.playerId), "notes.md");
      if (!existsSync(notes)) {
        writeFileSync(
          notes,
          "# notes\n\nYour own journal. It is the only thing that survives between turns.\n",
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

    // Deliver anything other seats have said to this one (§13).
    writeFileSync(join(written.dir, "messages.txt"), renderMessages(unread));
    this.#chat.markRead(this.#nameOf(playerId));
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

  /** Legal actions for a unit, with the engine's reasons for the rest. */
  /** Send a message to another seat, or to everyone. Logged in full (§13). */
  async say(playerId: number, to: string | null, text: string): Promise<ActionResult> {
    const from = this.#nameOf(playerId);
    const turn = this.lastSnapshotTurn();
    const result = this.#chat.send({ turn, from, to, text });
    if (!result.ok) {
      return { ok: false, code: "MESSAGE_REFUSED", message: result.reason ?? "refused" };
    }
    this.#log.append({ turn, player: playerId, playerName: from, kind: "message", to, text });

    // Mirror into the game's own chat so a spectator sees it on screen too. Best effort: the
    // harness channel is the record, this is only for watchability.
    await this.#adapter
      .run("chat", playerId, { CHAT_TEXT: `${from}: ${text}` })
      .catch(() => undefined);
    return { ok: true };
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
  async combatPreview(playerId: number, unitId: string, x: number, y: number): Promise<unknown> {
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
      if (read.ready) return { ...fired, ...(read.results as object) };
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
      const line = text.split("\n").find((l) => l.startsWith(`unit ${unitId} `));
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
  async choose(playerId: number, what: string, value?: string, targetId?: string): Promise<unknown> {
    if (!value) {
      return this.#adapter.run<unknown>("choose", playerId, {
        WHAT: what,
        THING: null,
        TARGET_ID: targetId ?? null,
      });
    }
    return this.act(playerId, { kind: "choose", actionType: what, targetId, args: { thing: value } });
  }

  /** Dismiss or open a notification. With no id, act on whatever is blocking the turn. */
  async notify(playerId: number, mode: "dismiss" | "activate", id?: string): Promise<unknown> {
    return this.#adapter.run<unknown>("notify", playerId, { MODE: mode, TARGET_ID: id ?? null });
  }

  /** What a settlement can build right now, with names rather than hashes. */
  async production(playerId: number, settlementId: string): Promise<unknown> {
    return this.#adapter.run<unknown>("produce", playerId, { TARGET_ID: Number(settlementId) });
  }

  /** Trade deals — the one part of diplomacy that is not an operation (§13). */
  async deal(playerId: number, mode: string, otherPlayer: number): Promise<unknown> {
    return this.#adapter.run<unknown>("deal", playerId, {
      DEAL_MODE: mode,
      OTHER_PLAYER: otherPlayer,
    });
  }

  /**
   * Rewrite this turn's state files from the live game.
   *
   * Deliberately leaves hud.txt and delta.md alone: those describe the turn as it began, and an
   * agent needs a stable "what changed since last turn" to reason against. Only the current-state
   * files move.
   */
  async refreshDump(playerId: number): Promise<void> {
    const dir = this.#currentTurnDir.get(playerId);
    if (!dir) return;
    const raw = await this.#adapter.snapshot(playerId);
    const tiles = mergeTiles(raw.tiles, this.#memory.get(playerId)?.tiles ?? null, raw.header.turn);
    const foreign = mergeForeignSettlements(
      raw.settlements.foreign,
      this.#memory.get(playerId)?.foreignSettlements ?? null,
      raw.header.turn,
    );
    writeFileSync(join(dir, "tiles.txt"), tileLines(tiles).join("\n") + "\n");
    writeFileSync(join(dir, "tiles.jsonl"), toJsonl(tiles) + "\n");
    writeFileSync(join(dir, "units.txt"), unitLines(raw.units.own, raw.units.foreign).join("\n") + "\n");
    writeFileSync(join(dir, "units.jsonl"), toJsonl([...raw.units.own, ...raw.units.foreign]) + "\n");
    writeFileSync(join(dir, "settlements.txt"), settlementLines(raw.settlements.own, foreign).join("\n") + "\n");
    writeFileSync(join(dir, "settlements.jsonl"), toJsonl([...raw.settlements.own, ...foreign]) + "\n");
    writeFileSync(join(dir, "players.txt"), playerLines(raw.players.known).join("\n") + "\n");
    writeFileSync(join(dir, "pending.txt"), pendingLines(raw.pending).join("\n") + "\n");
    writeFileSync(join(dir, "header.json"), JSON.stringify(raw.header, null, 2));
  }

  /** Legal actions for a settlement, or for the player themselves. */
  async catalogue(playerId: number, kind: "city" | "player", targetId?: string) {
    return this.#adapter.run<unknown>("catalogue", playerId, {
      KIND: kind,
      TARGET_ID: targetId ?? null,
    });
  }

  async whatCan(playerId: number, unitId: string, target?: { x: number; y: number }) {
    const result = await this.#adapter.run<unknown>("whatcan", playerId, {
      UNIT_ID: Number(unitId),
      UNIT_OWNER: playerId,
      TARGET: target ?? null,
    });
    this.#log.append({ turn: await this.#adapter.turn(), player: playerId, kind: "what_can", unitId });
    return result;
  }

  async act(playerId: number, request: ActionRequest): Promise<ActionResult> {
    const state = this.#turnState.get(playerId);
    const agent = this.#agents.get(playerId);
    if (!state || !agent) return { ok: false, code: "NOT_YOUR_TURN", message: "no active turn" };
    if (state.ended) {
      return { ok: false, code: "TURN_ENDED", message: "you have already ended this turn" };
    }
    if (state.actionsUsed >= agent.actionsPerTurn) {
      const refused: ActionResult = {
        ok: false,
        code: "ACTION_BUDGET_SPENT",
        message: `you have used all ${agent.actionsPerTurn} actions this turn`,
        hint: "end your turn",
      };
      // Budget rejections belong in the log: a seat that spent its whole budget and achieved
      // nothing must not read like a clean turn in the run report (§13).
      this.#log.append({
        turn: await this.#adapter.turn(),
        player: playerId,
      playerName: this.#nameOf(playerId),
        kind: "action_refused",
        request,
        result: refused,
      });
      return refused;
    }

    // Reject an invented action type here, with the valid names. The engine's own refusal for an
    // unknown type carries no FailureReasons at all — agents were guessing FOO, SET_PRODUCTION,
    // CHOOSE_TECH and getting back "the game refused this action", which teaches them nothing.
    const catalogue = await this.operationTypes().catch(() => undefined);
    const known = catalogue?.[request.kind];
    // Only reject when the catalogue looks complete for this category. If it is short, we are
    // probably reading the wrong source, and rejecting a valid name would be worse than letting
    // the engine answer for itself.
    const catalogueLooksReal = (known?.length ?? 0) >= 4;
    if (known && catalogueLooksReal && !known.includes(request.actionType)) {
      const wanted = new Set(
        request.actionType
          .replace(/^(PLAYEROPERATION|UNITOPERATION|UNITCOMMAND|CITYOPERATION|CITYCOMMAND)_/, "")
          .split("_")
          .filter((w) => w.length > 2),
      );
      const suggestions = known
        .map((name) => ({
          name,
          score: name.split("_").filter((w) => wanted.has(w)).length,
        }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map((s) => s.name);
      const refused: ActionResult = {
        ok: false,
        code: "NO_SUCH_OPERATION",
        message: `${request.kind} "${request.actionType}" does not exist in this build`,
        hint:
          suggestions.length > 0
            ? `did you mean: ${suggestions.join(", ")}`
            : `run \`civ list-ops ${request.kind}\` for the valid names, or \`civ what-can\` for what applies now`,
      };
      state.actionsUsed++;
      state.illegalCount++;
      this.#log.append({
        turn: await this.#adapter.turn(),
        player: playerId,
        playerName: this.#nameOf(playerId),
        kind: "action",
        request,
        result: refused,
      });
      return refused;
    }

    // Refuse an action that has already been issued identically several times this turn.
    const signature = `${request.kind}:${request.targetId ?? ""}:${request.actionType}:${JSON.stringify(request.args ?? {})}`;
    const seen = (state.repeats.get(signature) ?? 0) + 1;
    state.repeats.set(signature, seen);
    if (seen > SAME_ACTION_LIMIT) {
      const refused: ActionResult = {
        ok: false,
        code: "NOTHING_CHANGED",
        message: `you have already done exactly this ${seen - 1} times this turn — it is not changing anything`,
        hint: "do something else, or run `civ end-turn`",
      };
      state.actionsUsed++;
      state.illegalCount++;
      this.#log.append({
        turn: await this.#adapter.turn(),
        player: playerId,
        playerName: this.#nameOf(playerId),
        kind: "action",
        request,
        result: refused,
        actionsUsed: state.actionsUsed,
      });
      return refused;
    }

    state.actionsUsed++;
    const result = await this.#adapter.run<ActionResult>(
      request.kind === "choose" ? "choose" : "act",
      playerId,
      {
        KIND: request.kind,
        WHAT: request.actionType,
        TARGET_ID: request.targetId ?? null,
        ACTION_TYPE: request.actionType,
        ARGS: request.args ?? {},
        THING: request.args?.thing ?? null,
      },
    );
    if (!result.ok) state.illegalCount++;

    // Refresh the dump so the agent can see what its own action did.
    //
    // The files were a start-of-turn snapshot, so after founding a city an agent re-read
    // settlements.txt and found nothing there — six times in one observed turn. It then thrashed:
    // turn 1 took 17s, turn 2 took 312s and timed out. A read costs about 0.2s, which is nothing
    // beside that.
    if (result.ok) await this.refreshDump(playerId).catch(() => undefined);

    this.#log.append({
      turn: await this.#adapter.turn(),
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
  static stripMarkupIn = stripMarkup;

  async exportRules(): Promise<{ tables: number; rows: number }> {
    // A useful subset, not everything: the whole database is enormous and most of it is art and
    // audio bindings the agent will never need.
    const wanted = [
      "Units", "Constructibles", "Buildings", "Improvements", "Yields", "Resources",
      "Terrains", "Biomes", "Features", "Civilizations", "Leaders", "Ages",
      "ProgressionTreeNodes", "Traditions", "Projects", "LegacyPaths", "Victories",
      "UnitOperations", "UnitCommands", "CityOperations", "PlayerOperations", "DiplomacyActions",
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
    const ops = await this.operationTypes().catch(() => ({}) as Record<string, string[]>);
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
    const result = await this.#adapter.run<ActionResult & { blocking?: string | null }>(
      "endturn",
      playerId,
      { FORCED: forced },
    );
    // A refused end-turn is not the end of the turn. Saying otherwise left the seat active in the
    // game while the match moved on, and the round then waited forever for it to advance.
    if (state && !result.ok) state.ended = false;
    this.#log.append({
      turn: await this.#adapter.turn(),
      player: playerId,
      playerName: this.#nameOf(playerId),
      kind: forced ? "turn_end_forced" : "turn_end",
      blocking: result.blocking ?? null,
      actionsUsed: state?.actionsUsed ?? 0,
      illegalActions: state?.illegalCount ?? 0,
    });
    return result;
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
    while (Date.now() < deadline) {
      const seats = await this.#adapter
        .run<{ majors: Array<{ id: number; active: boolean }> }>("seats", 0)
        .catch(() => ({ majors: [] as Array<{ id: number; active: boolean }> }));
      const active = seats.majors.find((m) => m.active && playerIds.includes(m.id));
      if (active) return active.id;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
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
  turnStats(playerId: number): TurnState | undefined {
    return this.#turnState.get(playerId);
  }
}

/**
 * Remove Civ's UI markup from a database row's text columns.
 *
 * `[icon:X]` is a picture the agent cannot see; `[TIP:X]word[/TIP]` and `[B]word[/B]` wrap words
 * worth keeping. Anything unrecognised is left alone rather than guessed at.
 */
function stripMarkup<T>(row: T): T {
  if (typeof row === "string") {
    return row
      .replace(/\[icon:[^\]]*\]/g, "")
      .replace(/\[\/?(?:TIP|B|I|S|LINK)(?::[^\]]*)?\]/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim() as unknown as T;
  }
  if (Array.isArray(row)) return row.map(stripMarkup) as unknown as T;
  if (row && typeof row === "object") {
    return Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, stripMarkup(v)]),
    ) as T;
  }
  return row;
}
