// The pre-game leader pick (docs/PLAN.md §5): the agent names a leader from the settings, and the
// caller validates it against the real list — an unclear pick must fall back to the default, never
// block the start. A static list (leaders-list.ts) holds the choices; the game applies them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchLeader, pickLeader, type LeaderOption, type PickStream } from "../src/agent/pick-leader.ts";
import { LEADERS as LEADER_LIST } from "../src/agent/leaders-list.ts";

const LEADERS: LeaderOption[] = [
  { type: "LEADER_XERXES", name: "Xerxes" },
  { type: "LEADER_HATSHEPSUT", name: "Hatshepsut" },
];

test("matchLeader accepts the type, the name, and prose around the pick", () => {
  assert.equal(matchLeader("LEADER_XERXES", LEADERS), "LEADER_XERXES");
  assert.equal(matchLeader("xerxes", LEADERS), "LEADER_XERXES");
  assert.equal(matchLeader("I will play as Hatshepsut.", LEADERS), "LEADER_HATSHEPSUT");
});

test("an unknown pick returns null so the caller keeps the default", () => {
  assert.equal(matchLeader("Napoleon", LEADERS), null);
  assert.equal(matchLeader("", LEADERS), null);
});

test("the static leader list holds real leaders and no placeholders", () => {
  const types = LEADER_LIST.map((l) => l.type);
  assert.ok(types.includes("LEADER_XERXES") && types.includes("LEADER_HATSHEPSUT"));
  assert.ok(types.length >= 20, "the roster is populated from the game data");
  assert.ok(
    !types.some((t) => /RANDOM|NONE|_DEFAULT|_ABSTRACT|INDEPENDENT/.test(t)),
    "no placeholder/non-playable rows are offered",
  );
});

// One live pick sat silent for the whole 120s cap — a stream that opened and never answered —
// while the same call normally returns in a second. The seat then played the default leader,
// which is the one outcome the pick exists to avoid. A silent try is abandoned and asked again.
test("a stalled pick is abandoned after its time and asked again", async () => {
  process.env.OPEN_ROUTER_API_KEY ??= "test-key";
  let calls = 0;
  const retries: string[] = [];
  const stream: PickStream = (_model, _context, options) => ({
    async *[Symbol.asyncIterator]() {
      calls++;
      yield { type: "start" }; // the stream opens either way
      if (calls === 1) {
        // Silent until aborted, like the stalled stream.
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
        throw new Error("aborted");
      }
      yield { type: "text_delta", delta: "LEADER_XERXES" };
    },
  });
  const answer = await pickLeader("deepseek/deepseek-v4-flash", "sys", "user", "medium", {
    attemptMs: 20,
    stream,
    onRetry: (attempt, reason) => retries.push(`${attempt}: ${reason}`),
  });
  assert.equal(answer, "LEADER_XERXES");
  assert.equal(calls, 2, "the second try answered");
  assert.deepEqual(retries, ["1: no answer in 0.02s"]);
});

test("three silent tries give up, so the launcher can fall back to the default", async () => {
  process.env.OPEN_ROUTER_API_KEY ??= "test-key";
  let calls = 0;
  const stream: PickStream = (_m, _c, options) => ({
    async *[Symbol.asyncIterator]() {
      calls++;
      yield { type: "start" };
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
      throw new Error("aborted");
    },
  });
  await assert.rejects(
    pickLeader("deepseek/deepseek-v4-flash", "sys", "user", "medium", { attemptMs: 10, stream }),
    /no answer in 0.01s \(3 tries\)/,
  );
  assert.equal(calls, 3);
});
