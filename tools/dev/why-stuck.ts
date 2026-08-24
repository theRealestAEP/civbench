// Why did no seat become active?
//
// A hotseat match can stop for reasons invisible to every log: the handoff curtain is up, a modal
// dialog is waiting, or a seat has an end-turn-blocking notification it will not pass. Ask the
// game rather than guessing.
import { loadEnv } from "../../src/config/env.ts";
import { listTargets, CdpBridge } from "../../src/adapter/cdp.ts";

loadEnv();

const targets = await listTargets(9444);
console.log("targets:", targets.map((t) => t.url.split("/").pop()).join(", "));

const game = targets.find((t) => t.url.includes("root-game"));
if (!game) {
  console.log("no gameplay context — the game is not in a match");
  process.exit(1);
}

const bridge = await CdpBridge.connect(game.webSocketDebuggerUrl);
const state = await bridge.eval<unknown>(`(() => {
  const out = { turn: Game.turn, players: [] };
  for (const p of Players.getAlive() ?? []) {
    if (!(p?.isMajor ?? true)) continue;
    let blocking = null;
    try {
      const id = Game.Notifications?.findEndTurnBlocking?.(p.id);
      if (id !== null && id !== undefined) {
        const n = Game.Notifications.find(id);
        blocking = n ? Game.Notifications.getTypeName(n.Type) : String(id);
      }
    } catch (e) { blocking = "lookup failed: " + e; }
    out.players.push({
      id: p.id,
      human: Players.isHuman(p.id),
      turnActive: p.isTurnActive,
      blocking,
    });
  }
  return out;
})()`);
console.log("game state:", JSON.stringify(state, null, 1));

// Anything on screen? A curtain or dialog stops hotseat dead.
const dom = await bridge.eval<unknown>(`(() => {
  const hits = [];
  for (const sel of ["fxs-modal-frame", "screen-dialog-box", ".screen-dialog-box", "hotseat-handoff", "[class*=handoff]", "[class*=curtain]"]) {
    for (const el of document.querySelectorAll(sel)) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      hits.push({ sel, text: (el.textContent ?? "").trim().slice(0, 160) });
    }
  }
  return hits;
})()`);
console.log("on screen:", JSON.stringify(dom, null, 1));
await bridge.close();
