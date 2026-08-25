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
} from "../src/agent/compaction.ts";

const say = (role: string, text: string): AgentMessage =>
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
  assert.match(stub, /still on disk/, "the stub must tell the agent it can re-read the file");
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
