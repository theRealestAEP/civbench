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

/** Compact once the transcript passes this, so the cached prefix stays stable most turns. */
export const COMPACT_ABOVE_TOKENS = 120_000;

export type CompactionStats = { before: number; after: number; dropped: number };

/**
 * Replace the bodies of old tool results with a one-line stub.
 *
 * `turnMarkers` holds the index in `messages` at which each turn began, most recent last.
 */
export function compactTranscript(
  messages: AgentMessage[],
  turnMarkers: number[],
): { messages: AgentMessage[]; stats: CompactionStats } {
  const before = estimateTokens(messages);
  if (before < COMPACT_ABOVE_TOKENS) {
    return { messages, stats: { before, after: before, dropped: 0 } };
  }

  // Everything before this index is old enough to lose its tool output.
  const cutoff = turnMarkers.at(-KEEP_TOOL_RESULTS_FOR_TURNS) ?? 0;
  let dropped = 0;

  const compacted = messages.map((message, index) => {
    if (index >= cutoff) return message;
    const m = message as { role?: string; content?: unknown };
    if (m.role !== "toolResult") return message;

    const text = JSON.stringify(m.content ?? "");
    if (text.length < 200) return message; // not worth stubbing
    dropped++;
    return {
      ...message,
      content: [
        {
          type: "text",
          text: "[earlier tool output dropped to save context — the files are still on disk, re-read them if you need them]",
        },
      ],
    } as AgentMessage;
  });

  return { messages: compacted, stats: { before, after: estimateTokens(compacted), dropped } };
}
