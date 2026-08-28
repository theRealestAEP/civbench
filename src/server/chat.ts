// Agent-to-agent messaging (docs/PLAN.md §13).
//
// This is the benchmark's real differentiator: three models that can talk to each other can
// bluff, bargain, threaten, and gang up, and none of that is visible in the in-game deal system.
// The channel is harness-mediated rather than purely in-game so that every word is logged and
// auditable — including collusion between seats running the same model, which is a result worth
// measuring rather than an accident to avoid.
export type ChatMessage = {
  turn: number;
  from: string;
  /** null = broadcast. */
  to: string | null;
  /**
   * For a broadcast: the seats that had met the sender when it spoke. The briefing promises
   * "tell every civ you have met"; without this the gate was a comment, and unmet rivals heard
   * everything.
   */
  audience?: string[];
  text: string;
};

/** Messages are capped so one agent cannot flood another's context. */
export const MAX_MESSAGE_CHARS = 500;
export const MAX_PER_TURN = 5;

/** Whether a message went out, and why not when it did not. */
export type SendResult = { ok: boolean; reason?: string; truncated?: boolean };

export class ChatChannel {
  #history: ChatMessage[] = [];
  #sentThisTurn = new Map<string, number>();
  /** Index of the last message each seat has already been shown. */
  #readCursor = new Map<string, number>();

  /** Called at the start of a game turn so per-turn limits reset. */
  startTurn(): void {
    this.#sentThisTurn.clear();
  }

  send(message: ChatMessage): SendResult {
    const sent = this.#sentThisTurn.get(message.from) ?? 0;
    if (sent >= MAX_PER_TURN) {
      return { ok: false, reason: `you have sent ${MAX_PER_TURN} messages this turn` };
    }
    const trimmed = message.text.trim();
    const text = trimmed.slice(0, MAX_MESSAGE_CHARS);
    if (text.length === 0) return { ok: false, reason: "empty message" };

    this.#sentThisTurn.set(message.from, sent + 1);
    this.#history.push({ ...message, text });
    // Truncation was silent; the sender believed the whole message went out.
    return { ok: true, truncated: trimmed.length > MAX_MESSAGE_CHARS };
  }

  /** Everything addressed to this seat that it has not been shown yet. */
  unreadFor(seat: string): ChatMessage[] {
    const from = this.#readCursor.get(seat) ?? 0;
    const unread: ChatMessage[] = [];
    for (let i = from; i < this.#history.length; i++) {
      const m = this.#history[i]!;
      if (m.from === seat) continue; // never echo a seat its own words
      if (m.to === seat) unread.push(m);
      else if (m.to === null && (!m.audience || m.audience.includes(seat))) unread.push(m);
    }
    return unread;
  }

  markRead(seat: string): void {
    this.#readCursor.set(seat, this.#history.length);
  }

  /** The full transcript, for the run report and the replay. */
  transcript(): readonly ChatMessage[] {
    return this.#history;
  }
}

/** One message per line, in the same shape as the rest of the dump (§6.1). */
export function renderMessages(messages: ChatMessage[]): string {
  if (messages.length === 0) return "(no messages)\n";
  return (
    messages
      .map((m) => `message t${m.turn} from=${m.from} to=${m.to ?? "all"} text=${JSON.stringify(m.text)}`)
      .join("\n") + "\n"
  );
}
