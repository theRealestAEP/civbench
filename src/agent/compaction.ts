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

export type CompactionStats = { before: number; after: number; dropped: number };

/**
 * Replace the bodies of old tool results with a one-line stub.
 *
 * `turnMarkers` holds the index in `messages` at which each turn began, most recent last.
 */
/** A compacted transcript, and what it cost to get there. */
export type CompactionResult = { messages: AgentMessage[]; stats: CompactionStats };

export function compactTranscript(
  messages: AgentMessage[],
  turnMarkers: number[],
): CompactionResult {
  const before = estimateTokens(messages);
  if (before < COMPACT_ABOVE_TOKENS) {
    return { messages, stats: { before, after: before, dropped: 0 } };
  }

  // Everything before this index is old enough to lose its tool output.
  //
  // The fallback matters. `?? 0` meant "everything is recent" when markers were missing, so an
  // over-threshold transcript compacted nothing at all and the context grew until the API refused
  // it — failing open in the one direction that breaks a long match. Without markers, keep the
  // last few messages instead and compact the rest.
  const cutoff = turnMarkers.at(-KEEP_TOOL_RESULTS_FOR_TURNS) ?? Math.max(0, messages.length - FALLBACK_RECENT_MESSAGES);
  let dropped = 0;

  const compacted = messages.map((message, index) => {
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
    return {
      ...message,
      content: [
        {
          type: "text",
          text: "[earlier tool output dropped to save context — re-read the file, or re-run the command that produced it, if you need it again]",
        },
      ],
    } as AgentMessage;
  });

  return { messages: compacted, stats: { before, after: estimateTokens(compacted), dropped } };
}
