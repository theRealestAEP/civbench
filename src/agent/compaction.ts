// Keeping an agent's context across turns without letting it grow forever (docs/PLAN.md §8).
//
// The original design threw the whole transcript away each turn and let notes.md carry
// everything. That is clean to measure but it is not how anyone deploys an agent, and by §7's own
// argument an artificial handicap measures our harness rather than the model.
//
// So the transcript persists, and we compact it. The policy is deliberately dumb and
// deterministic: DROP OLD TOOL RESULTS, KEEP THE AGENT'S OWN REASONING.
//
// That works here for a reason specific to this benchmark: the tool results ARE the dump files.
// A stale `grep tiles.txt` from turn 4 is not lost when dropped — it is still on disk and can be
// re-read at any time. What cannot be recovered is why the agent decided something, so that is
// what we keep. No summarising model call, so no summarisation-quality variable creeping into the
// comparison.
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Tool results older than this many turns are replaced with a stub. */
export const KEEP_TOOL_RESULTS_FOR_TURNS = 2;

/** Rough token estimate; good enough to decide when to act. */
const estimateTokens = (messages: AgentMessage[]): number =>
  Math.round(JSON.stringify(messages).length / 3.7);

/**
 * Compact once the transcript passes this.
 *
 * Was 120_000, which never fired. Measured on a real 50-turn run: input per model call was ~40k by
 * turn 10 and climbing about 4k a turn, so compaction would not have engaged until turn 25 or so —
 * by which point the run was tracking to $20 and eleven hours, against $0.85 and one hour at the
 * turn-1 rate. Cost here is (tokens per call) x (calls per turn), and both grow, so the curve is
 * quadratic if nothing trims it.
 *
 * 50k engages around turn 12 and holds the per-call context roughly flat after that. Nothing is
 * lost that cannot be re-read: the policy drops old TOOL OUTPUT, which is the dump files, and
 * keeps every word of the agent's own reasoning.
 */
export const COMPACT_ABOVE_TOKENS = 50_000;

/** How many messages stay intact when turn markers are unavailable. */
const FALLBACK_RECENT_MESSAGES = 20;

/**
 * How much of the model's context window a request may use. The rest is headroom for the
 * reply, the tool output of this turn, and the error in the token estimate below.
 *
 * Without a budget the transcript grew until the API refused it: one seat's kept reasoning
 * alone reached 1.77M tokens against a 1.05M window, every call failed on size, and the seat
 * sat dead for sixty turns.
 */
export const CONTEXT_BUDGET_FRACTION = 0.6;

/**
 * The most any request may carry, whatever the window. A fraction of a million-token window
 * is 600K+, which never binds: contexts grew ~9K a turn after compaction (Bruno 80K at turn 12,
 * 139K at turn 18), every call got slower with them — DeepSeek's 15-30s calls all came past
 * 100K cached tokens — and turns stretched toward minutes overnight. Latency, not the API's
 * limit, is what the budget must protect.
 */
export const CONTEXT_BUDGET_MAX_TOKENS = 500_000;

/**
 * Once the budget is exceeded, drop down to this share of it, not merely under it.
 *
 * Dropping the oldest turn rewrites the start of the prompt, which invalidates the provider's
 * prefix cache for everything after it. Dropping one turn each turn once the cap binds would
 * cost one full uncached prefill per seat per turn — 42s for 54K tokens on one provider. A
 * batch of turns dropped at once buys several cache-friendly turns before the next batch.
 */
export const LOW_WATER_FRACTION = 0.7;

/** The budget for a model with this context window. */
export function contextBudget(contextWindow: number): number {
  return Math.min(Math.floor(contextWindow * CONTEXT_BUDGET_FRACTION), CONTEXT_BUDGET_MAX_TOKENS);
}

/** Reasoning older than this many turns is dropped before whole turns are. */
export const KEEP_REASONING_FOR_TURNS = 8;

/** Whole turns are never dropped from the most recent this many. */
export const ALWAYS_KEEP_TURNS = 2;

export type CompactionStats = {
  before: number;
  after: number;
  /** Tool results stubbed. */
  dropped: number;
  /** Assistant messages whose reasoning was removed. */
  stripped: number;
  /** Whole turns removed, oldest first. */
  droppedTurns: number;
  /** Messages before this index carry stubbed tool output; pass it back as keepStubbed. */
  stubbedBefore: number;
};

/** A compacted transcript, and what it cost to get there. */
export type CompactionResult = { messages: AgentMessage[]; stats: CompactionStats };

const STUB =
  "[earlier tool output dropped to save context — re-read the file, or re-run the command that produced it, if you need it again]";

/** Tier 1: old tool results become a one-line stub. */
function stubToolResults(messages: AgentMessage[], cutoff: number) {
  let dropped = 0;
  const out = messages.map((message, index) => {
    if (index >= cutoff) return message;
    // SAFETY: pi's AgentMessage is a union whose arms vary by message kind. Both fields read here
    // are optional, so an arm without them simply fails the toolResult check below.
    const m = message as { role?: string; content?: unknown };
    if (m.role !== "toolResult") return message;
    const text = JSON.stringify(m.content ?? "");
    if (text.length < 200) return message; // not worth stubbing
    dropped++;
    // SAFETY: the original message is spread through unchanged apart from `content`, which is
    // replaced with a single text block — the shape every AgentMessage arm accepts. Narrowed
    // above to role "toolResult", so this is a toolResult with its payload stubbed out.
    return { ...message, content: [{ type: "text", text: STUB }] } as AgentMessage;
  });
  return { messages: out, dropped };
}

/** Tier 2: old assistant messages lose their reasoning and keep what they said and did. */
function stripReasoning(messages: AgentMessage[], cutoff: number) {
  let stripped = 0;
  const out = messages.map((message, index) => {
    if (index >= cutoff) return message;
    // SAFETY: as above — role and content are optional on every arm, and only an assistant
    // message with a content array reaches the filter.
    const m = message as { role?: string; content?: Array<{ type?: string }> };
    if (m.role !== "assistant" || !Array.isArray(m.content)) return message;
    const kept = m.content.filter((block) => block?.type !== "thinking");
    if (kept.length === m.content.length) return message;
    stripped++;
    // SAFETY: same message, same arm, with its thinking blocks removed from `content`.
    return { ...message, content: kept } as AgentMessage;
  });
  return { messages: out, stripped };
}

/**
 * Trim a transcript to fit the request.
 *
 * `turnMarkers` holds the index in `messages` at which each turn began, most recent last.
 * `budgetTokens` is the most a request may carry; without one, only tier 1 runs (the original
 * behaviour, kept for callers that have no model to size against).
 *
 * Tiers, applied only as far as needed:
 *   1. tool results older than KEEP_TOOL_RESULTS_FOR_TURNS become a stub
 *   2. reasoning older than KEEP_REASONING_FOR_TURNS is removed
 *   3. whole turns are dropped, oldest first, never the last ALWAYS_KEEP_TURNS
 *
 * Nothing removed is lost: every dump is on disk, the transcript and thread files hold the
 * whole history, and notes.md is never touched.
 */
export function compactTranscript(
  messages: AgentMessage[],
  turnMarkers: number[],
  budgetTokens?: number,
  /**
   * Turns already dropped by an earlier call. They stay dropped even when the transcript would
   * now fit: letting them back in would rewrite the prompt's start again and lose the cache.
   */
  keepDropped = 0,
  /**
   * Messages before this index already lost their tool output on an earlier call, and stay
   * that way. Same hysteresis as keepDropped: the stubbed set only grows, in batches, when the
   * budget is exceeded, so the prompt's prefix holds still and the cache survives between them.
   */
  keepStubbed = 0,
): CompactionResult {
  const before = estimateTokens(messages);
  const stats: CompactionStats = { before, after: before, dropped: 0, stripped: 0, droppedTurns: 0, stubbedBefore: keepStubbed };
  const overBudget = (list: AgentMessage[]) => budgetTokens !== undefined && estimateTokens(list) > budgetTokens;
  // A small transcript is left alone — unless something was already compacted, which must hold.
  if (before < COMPACT_ABOVE_TOKENS && !overBudget(messages) && keepDropped === 0 && keepStubbed === 0) {
    return { messages, stats };
  }

  // Everything before this index is old enough to lose its tool output.
  //
  // The fallback matters. `?? 0` meant "everything is recent" when markers were missing, so an
  // over-threshold transcript compacted nothing at all and the context grew until the API refused
  // it — failing open in the one direction that breaks a long match. Without markers, keep the
  // last few messages instead and compact the rest.
  const toolCutoff = turnMarkers.at(-KEEP_TOOL_RESULTS_FOR_TURNS) ?? Math.max(0, messages.length - FALLBACK_RECENT_MESSAGES);
  // With a budget, tool output goes only when the budget is exceeded. It used to go after two
  // turns no matter how much room there was, so every rule an agent looked up was gone two turns
  // later and looked up again: 317 rules reads in 63 turns, most of them repeats. Without a
  // budget (no model to size against) the old threshold rule stands.
  const stubBefore = budgetTokens === undefined || overBudget(messages) ? Math.max(toolCutoff, keepStubbed) : keepStubbed;
  stats.stubbedBefore = stubBefore;
  const tier1 = stubToolResults(messages, stubBefore);
  stats.dropped = tier1.dropped;
  let current = tier1.messages;

  if (overBudget(current)) {
    const reasoningCutoff = turnMarkers.at(-KEEP_REASONING_FOR_TURNS) ?? Math.max(0, messages.length - FALLBACK_RECENT_MESSAGES);
    const tier2 = stripReasoning(current, reasoningCutoff);
    stats.stripped = tier2.stripped;
    current = tier2.messages;
  }

  // Tier 3: drop whole turns from the front. A turn is everything from its marker to the next,
  // so a dropped turn takes its prompt, replies and tool results together and the thread stays
  // well-formed.
  //
  // Hysteresis: past the budget, drop until under the low-water mark, and never fewer turns
  // than were dropped before. The dropped set therefore changes only when the budget is
  // exceeded, and then by a batch, so the prompt's prefix holds still between batches.
  let marker = Math.min(keepDropped, Math.max(0, turnMarkers.length - ALWAYS_KEEP_TURNS));
  let start = turnMarkers[marker] ?? 0;
  const lowWater = budgetTokens === undefined ? undefined : budgetTokens * LOW_WATER_FRACTION;
  const aboveLowWater = (list: AgentMessage[]) => lowWater !== undefined && estimateTokens(list) > lowWater;
  if (overBudget(current.slice(start))) {
    while (aboveLowWater(current.slice(start)) && marker < turnMarkers.length - ALWAYS_KEEP_TURNS) {
      marker++;
      start = turnMarkers[marker] ?? start;
    }
  }
  stats.droppedTurns = marker;
  if (start > 0) current = current.slice(start);

  stats.after = estimateTokens(current);
  return { messages: current, stats };
}
