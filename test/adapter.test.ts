// The adapter's own contract with a bridge that can die.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameAdapter } from "../src/adapter/game.ts";
import { BridgeError, type Bridge } from "../src/adapter/bridge.ts";
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
