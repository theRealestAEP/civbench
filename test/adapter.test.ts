// The adapter's own contract with a bridge that can die.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameAdapter } from "../src/adapter/game.ts";
import { BridgeError, BridgeTimeout, type Bridge } from "../src/adapter/bridge.ts";
import { FakeBridge, makeWorld } from "../src/test-support/fake-game.ts";

/** A bridge that dies after `deathsAfter` calls, the way the real socket does mid-match. */
function mortalBridge(deathsAfter: number): Bridge & { calls: number } {
  const real = new FakeBridge(makeWorld());
  let calls = 0;
  return {
    get calls() { return calls; },
    get alive() { return calls < deathsAfter ? true : false; },
    async eval<T>(js: string): Promise<T> {
      calls++;
      if (calls > deathsAfter) throw new BridgeError("socket closed");
      return real.eval<T>(js);
    },
    close: async () => {},
  };
}

// An hour of a live 50-turn run was spent printing "no seat became active" at a game that was
// perfectly healthy. The socket had dropped, every read after it failed, and nothing reconnected.
test("a dead bridge is reconnected rather than retried into a wall", async () => {
  const dead = mortalBridge(0);
  let reconnects = 0;
  const adapter = new GameAdapter(dead, async () => {
    reconnects++;
    return new FakeBridge(makeWorld());
  });
  const seats = await adapter.run<{ turn: number }>("seats", 0);
  assert.equal(reconnects, 1, "a dead bridge must be replaced, not retried");
  assert.ok(typeof seats.turn === "number", "the retried read must actually return game state");
});

// A live bridge that throws is a game-side error — a bad script, a missing API. Reconnecting
// would hide it and produce an infinite reconnect loop against a game that is answering fine.
test("a live bridge that throws is not treated as a dead one", async () => {
  const live: Bridge = {
    alive: true,
    eval: async () => { throw new BridgeError("game-side exception: TypeError"); },
    close: async () => {},
  };
  let reconnects = 0;
  const adapter = new GameAdapter(live, async () => {
    reconnects++;
    return new FakeBridge(makeWorld());
  });
  await assert.rejects(() => adapter.run("seats", 0), /TypeError/);
  assert.equal(reconnects, 0, "a game-side error must not be mistaken for a dropped socket");
});

/** A bridge whose socket stays open but never answers, the way a desynced inspector leaves it. */
function stalledBridge(): Bridge & { closed: number } {
  let closed = 0;
  return {
    get closed() { return closed; },
    alive: true,
    eval: async () => { throw new BridgeTimeout("CDP Runtime.evaluate timed out after 30000ms"); },
    close: async () => { closed++; },
  };
}

// Turn 24 of a live run: the game's inspector lost sync on the harness's connection and never
// answered on it again. The socket stayed open, so nothing called it dead; every read timed out
// at 30s, the seat wait ran out, and the match was declared crashed at a game that was fine.
test("a stalled socket on a live game is dropped and reconnected", async () => {
  const stalled = stalledBridge();
  let reconnects = 0;
  const adapter = new GameAdapter(stalled, async () => {
    reconnects++;
    return new FakeBridge(makeWorld());
  });
  const seats = await adapter.run<{ turn: number }>("seats", 0);
  assert.equal(reconnects, 1);
  assert.equal(stalled.closed, 1, "the stalled socket is closed, since the game will not close it");
  assert.ok(Number.isInteger(seats.turn), "the read is retried on the new socket");
});

test("reads that stall together share one reconnect", async () => {
  const stalled = stalledBridge();
  let reconnects = 0;
  const adapter = new GameAdapter(stalled, async () => {
    reconnects++;
    await new Promise((r) => setTimeout(r, 20));
    return new FakeBridge(makeWorld());
  });
  const reads = await Promise.all(["header", "tiles", "units", "settlements", "players", "pending"].map((s) => adapter.run(s, 0)));
  assert.equal(reads.length, 6);
  assert.equal(reconnects, 1, "six parallel timeouts must open one socket, not six");
});

test("a stalled mutation reconnects but is not replayed", async () => {
  let reconnects = 0;
  const adapter = new GameAdapter(stalledBridge(), async () => {
    reconnects++;
    return new FakeBridge(makeWorld());
  });
  await assert.rejects(() => adapter.run("endturn", 0, { FORCED: false, CLEAR_ONLY: false }), /outcome is unknown/);
  assert.equal(reconnects, 1);
});

test("a stall with the game gone keeps the timeout as the error", async () => {
  const adapter = new GameAdapter(stalledBridge(), async () => { throw new Error("no gameplay context"); });
  await assert.rejects(() => adapter.run("seats", 0), /timed out after 30000ms/);
});
