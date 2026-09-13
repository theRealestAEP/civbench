// Compaction (docs/PLAN.md §8).
//
// This is the one piece of src/agent/ that had no test at all, and it only runs once a transcript
// passes 120k tokens — so in practice it had never executed. It decides what an agent remembers
// across a long match, and getting it wrong either blows the context window or throws away the
// reasoning the benchmark exists to measure.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  compactTranscript,
  COMPACT_ABOVE_TOKENS,
  KEEP_TOOL_RESULTS_FOR_TURNS,
  KEEP_REASONING_FOR_TURNS,
  ALWAYS_KEEP_TURNS,
  CONTEXT_BUDGET_MAX_TOKENS,
  LOW_WATER_FRACTION,
  contextBudget,
} from "../src/agent/compaction.ts";

const say = (role: string, text: string): AgentMessage =>
  // SAFETY: a minimal message fixture. pi's AgentMessage is a union whose arms carry more than
  // this, but compaction only reads `role` and `content`.
  ({ role, content: [{ type: "text", text }] }) as unknown as AgentMessage;

/** A transcript big enough to trigger compaction, with turn markers where each turn began. */
function longTranscript(turns: number, bytesPerResult: number) {
  const messages: AgentMessage[] = [];
  const markers: number[] = [];
  for (let t = 0; t < turns; t++) {
    markers.push(messages.length);
    messages.push(say("assistant", `turn ${t}: I will scout north because the river is there.`));
    messages.push(say("toolResult", "x".repeat(bytesPerResult)));
  }
  return { messages, markers };
}

test("a short transcript is left completely alone", () => {
  const { messages, markers } = longTranscript(3, 100);
  const result = compactTranscript(messages, markers);
  assert.equal(result.stats.dropped, 0);
  assert.deepEqual(result.messages, messages, "below the threshold nothing may change");
  assert.ok(result.stats.before < COMPACT_ABOVE_TOKENS);
});

test("over the threshold, old tool output goes and reasoning stays", () => {
  const { messages, markers } = longTranscript(40, 20_000);
  const result = compactTranscript(messages, markers);

  assert.ok(result.stats.before > COMPACT_ABOVE_TOKENS, "this test needs to cross the threshold");
  assert.ok(result.stats.dropped > 0, "something must actually be dropped");
  assert.ok(result.stats.after < result.stats.before, "and the transcript must get smaller");

  // Every piece of the agent's own reasoning survives. That is the thing worth keeping: a dropped
  // file can be re-read from disk, a dropped decision cannot be recovered.
  const kept = JSON.stringify(result.messages);
  for (let t = 0; t < 40; t++) {
    assert.ok(kept.includes(`turn ${t}: I will scout north`), `reasoning from turn ${t} was lost`);
  }
});

test("the most recent turns keep their tool output", () => {
  const { messages, markers } = longTranscript(40, 20_000);
  const result = compactTranscript(messages, markers);

  // An agent must be able to act on what it just read. Only turns older than the window lose it.
  const cutoff = markers.at(-KEEP_TOOL_RESULTS_FOR_TURNS)!;
  for (let i = cutoff; i < messages.length; i++) {
    assert.deepEqual(result.messages[i], messages[i], `recent message ${i} must be untouched`);
  }
});

test("a dropped result says where the content went", () => {
  const { messages, markers } = longTranscript(40, 20_000);
  const result = compactTranscript(messages, markers);
  const stub = JSON.stringify(result.messages[1]);
  assert.match(stub, /re-read the file/, "the stub must tell the agent it can re-read the file");
});

test("compaction never loses a message", () => {
  const { messages, markers } = longTranscript(40, 20_000);
  const result = compactTranscript(messages, markers);
  assert.equal(result.messages.length, messages.length, "messages are stubbed, never removed");
});

test("no turn markers is survivable rather than fatal", () => {
  const { messages } = longTranscript(40, 20_000);
  const result = compactTranscript(messages, []);
  assert.equal(result.messages.length, messages.length);
  assert.ok(result.stats.dropped > 0, "with no markers everything is old enough to stub");
});

// ---- the budget tiers ----
//
// One seat's kept reasoning reached 1.77M tokens against a 1.05M window; every call failed on
// size and the seat sat dead for sixty turns. Tier 1 alone can never prevent that, because it
// keeps every word of reasoning by design.

const reasoned = (turn: number, reasoning: string): AgentMessage => {
  const content = [{ type: "thinking", thinking: reasoning }, { type: "text", text: `turn ${turn}: settle east` }];
  // SAFETY: a minimal assistant message fixture, like `say` above; compaction reads only `role`
  // and `content`.
  return { role: "assistant", content } as unknown as AgentMessage;
};

const roleOf = (m: AgentMessage): string | undefined =>
  // SAFETY: every AgentMessage arm carries `role`; reading it through a narrow shape only says so.
  (m as { role?: string }).role;

const hasThinking = (m: AgentMessage): boolean =>
  // SAFETY: fixtures built above; content is always an array of typed blocks.
  ((m as { content?: Array<{ type?: string }> }).content ?? []).some((b) => b.type === "thinking");

/** Turns whose weight is reasoning, not tool output. */
function reasoningHeavy(turns: number, reasoningBytes: number) {
  const messages: AgentMessage[] = [];
  const markers: number[] = [];
  for (let t = 0; t < turns; t++) {
    markers.push(messages.length);
    messages.push(say("user", `turn ${t} hud`));
    messages.push(reasoned(t, "r".repeat(reasoningBytes)));
    messages.push(say("toolResult", "ok"));
  }
  return { messages, markers };
}

test("under budget, nothing at all is touched", () => {
  const { messages, markers } = longTranscript(20, 20_000);
  const result = compactTranscript(messages, markers, 10_000_000);
  // Tool output used to go here too, above the fixed threshold. With a budget it stays until
  // the budget binds — see "with a budget, tool output stays until the budget is exceeded".
  assert.equal(result.stats.dropped, 0);
  assert.equal(result.stats.stripped, 0);
  assert.equal(result.stats.droppedTurns, 0);
  assert.equal(result.messages.length, messages.length);
});

test("over budget, reasoning older than the recent turns goes, and recent reasoning stays", () => {
  const { messages, markers } = reasoningHeavy(20, 3000);
  const result = compactTranscript(messages, markers, 8_000);
  assert.equal(result.stats.stripped, 20 - KEEP_REASONING_FOR_TURNS, "exactly the old turns lose reasoning");
  assert.equal(result.stats.droppedTurns, 0, "stripping was enough; no turn was dropped");
  const cutoff = markers.at(-KEEP_REASONING_FOR_TURNS)!;
  for (let i = 0; i < result.messages.length; i++) {
    const m = result.messages[i]!;
    if (roleOf(m) !== "assistant") continue;
    if (i >= cutoff) assert.ok(hasThinking(m), `recent turn at ${i} keeps its reasoning`);
    else assert.ok(!hasThinking(m), `old turn at ${i} lost its reasoning`);
    assert.ok(JSON.stringify(m).includes("settle east"), "what it said is never dropped by this tier");
  }
});

test("still over budget, whole turns go oldest first, never the last two", () => {
  const { messages, markers } = reasoningHeavy(20, 3000);
  const result = compactTranscript(messages, markers, 1_500);
  assert.ok(result.stats.droppedTurns > 0, "turns had to go");
  assert.ok(result.stats.droppedTurns <= 20 - ALWAYS_KEEP_TURNS, "the last two are never dropped");
  const text = JSON.stringify(result.messages);
  assert.ok(text.includes("turn 19: settle east") && text.includes("turn 18: settle east"), "the recent turns survive");
  assert.ok(!text.includes("turn 0 hud"), "the oldest turn is the first to go");
  // Every kept turn is whole: the first kept message is a turn's own prompt.
  assert.equal(roleOf(result.messages[0]!), "user");
});

test("with no budget, only tier 1 ever runs", () => {
  const { messages, markers } = reasoningHeavy(40, 20_000);
  const result = compactTranscript(messages, markers);
  assert.equal(result.stats.stripped, 0);
  assert.equal(result.stats.droppedTurns, 0);
});

// A fraction of a million-token window never bound: contexts grew ~9K a turn after compaction
// and every model call slowed with them. The budget exists for latency, so it has a ceiling.
test("the budget is a fraction of the window, capped at a fixed size", () => {
  assert.equal(contextBudget(100_000), 60_000, "small window: the fraction applies");
  assert.equal(contextBudget(1_048_576), CONTEXT_BUDGET_MAX_TOKENS, "million-token window: the cap applies");
  assert.equal(contextBudget(1_310_720), CONTEXT_BUDGET_MAX_TOKENS);
});

// Dropping the oldest turn rewrites the prompt's start and loses the provider's prefix cache.
// One turn dropped per turn once the cap binds is one full uncached prefill per seat per turn,
// so a drop goes down to the low-water mark and the dropped set then holds still.
test("over budget, turns are dropped down to the low-water mark, not merely under budget", () => {
  const { messages, markers } = reasoningHeavy(20, 3000);
  // Over budget once old reasoning is stripped, with room to drop into the reasoning-kept turns.
  const budget = 6_000;
  const result = compactTranscript(messages, markers, budget);
  assert.ok(result.stats.droppedTurns > 0);
  assert.ok(result.stats.after <= budget * LOW_WATER_FRACTION, `after=${result.stats.after} must be at or under ${budget * LOW_WATER_FRACTION}`);
});

test("turns already dropped stay dropped when the transcript would fit again", () => {
  const { messages, markers } = reasoningHeavy(20, 3000);
  const result = compactTranscript(messages, markers, 10_000_000, 3);
  assert.equal(result.stats.droppedTurns, 3, "the earlier drop is kept");
  const text = JSON.stringify(result.messages);
  assert.ok(!text.includes("turn 2 hud"), "the third turn stays gone");
  assert.ok(text.includes("turn 3 hud"), "and the fourth is the first kept");
  assert.equal(roleOf(result.messages[0]!), "user", "the kept transcript still starts on a turn boundary");
});


// Tool output used to go two turns after it was read whatever the budget, so every rule an agent
// looked up was gone two turns later and looked up again: 317 rules reads in 63 turns. With a
// budget, output goes only when the budget is exceeded — and once gone it stays gone, so the
// prompt prefix (and the cache) holds still between batches.
test("with a budget, tool output stays until the budget is exceeded, and the stubbed set only grows", () => {
  const { messages, markers } = longTranscript(40, 20_000);
  const roomy = compactTranscript(messages, markers, 10_000_000);
  assert.equal(roomy.stats.dropped, 0, "with room to spare nothing is stubbed");
  assert.deepEqual(roomy.messages, messages);

  const tight = compactTranscript(messages, markers, 100_000);
  assert.ok(tight.stats.dropped > 0, "over the budget, old tool output goes");
  assert.ok(tight.stats.stubbedBefore > 0);

  // Under the budget again, with the earlier cutoff passed back: the same messages stay stubbed.
  const later = compactTranscript(messages, markers, 10_000_000, 0, tight.stats.stubbedBefore);
  assert.equal(later.stats.dropped, tight.stats.dropped, "what was stubbed stays stubbed");
  assert.equal(later.stats.stubbedBefore, tight.stats.stubbedBefore);
});
