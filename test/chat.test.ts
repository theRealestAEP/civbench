// Agent-to-agent messaging (docs/PLAN.md §13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatChannel, renderMessages, MAX_PER_TURN } from "../src/server/chat.ts";

const msg = (from: string, to: string | null, text: string) => ({ turn: 1, from, to, text });

test("a broadcast reaches the others but not the sender", () => {
  const chat = new ChatChannel();
  chat.startTurn();
  chat.send(msg("alpha", null, "peace in the east"));
  assert.equal(chat.unreadFor("beta").length, 1);
  assert.equal(chat.unreadFor("alpha").length, 0, "a seat must not be told its own words");
});

test("a private message reaches only its recipient", () => {
  const chat = new ChatChannel();
  chat.startTurn();
  chat.send(msg("alpha", "beta", "attack gamma with me"));
  assert.equal(chat.unreadFor("beta").length, 1);
  assert.equal(chat.unreadFor("gamma").length, 0, "gamma must not overhear the plot against it");
});

test("messages are delivered once", () => {
  const chat = new ChatChannel();
  chat.startTurn();
  chat.send(msg("alpha", null, "hello"));
  assert.equal(chat.unreadFor("beta").length, 1);
  chat.markRead("beta");
  assert.equal(chat.unreadFor("beta").length, 0);
});

test("a seat cannot flood the others", () => {
  const chat = new ChatChannel();
  chat.startTurn();
  for (let i = 0; i < MAX_PER_TURN; i++) {
    assert.equal(chat.send(msg("alpha", null, `spam ${i}`)).ok, true);
  }
  const over = chat.send(msg("alpha", null, "one too many"));
  assert.equal(over.ok, false);
  assert.match(over.reason ?? "", /this turn/);
});

test("the per-turn allowance resets each turn", () => {
  const chat = new ChatChannel();
  chat.startTurn();
  for (let i = 0; i < MAX_PER_TURN; i++) chat.send(msg("alpha", null, `x${i}`));
  chat.startTurn();
  assert.equal(chat.send(msg("alpha", null, "new turn")).ok, true);
});

test("long messages are truncated rather than refused", () => {
  const chat = new ChatChannel();
  chat.startTurn();
  chat.send(msg("alpha", null, "z".repeat(5000)));
  assert.ok((chat.transcript()[0]?.text.length ?? 0) <= 500);
});

test("the whole conversation is recorded for the report", () => {
  const chat = new ChatChannel();
  chat.startTurn();
  chat.send(msg("alpha", null, "open"));
  chat.send(msg("beta", "alpha", "secret"));
  assert.equal(chat.transcript().length, 2, "private messages are logged too");
  assert.match(renderMessages([...chat.transcript()]), /from=beta to=alpha/);
});
