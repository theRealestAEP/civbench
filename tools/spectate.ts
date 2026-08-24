// Keep a live match watchable (docs/PLAN.md §12).
//
// Two things make an agent match invisible even while it runs:
//
//   1. The hotseat handoff panel + curtain. Civ VII rebuilds them constantly — a single removal
//      is useless; one poll removed fourteen. The next seat's turn does not begin until START
//      TURN is pressed, and with agents playing nobody presses it.
//   2. The camera never moves. With no human at the controls the view sits where it was left
//      while three agents play in different corners of the map.
//
// So: clear the handoff, and follow whichever seat is active. Runs alongside a match; it only
// touches the view and the handoff panel, never game state.
import { listTargets, CdpBridge } from "../src/adapter/cdp.ts";
import { GameAdapter } from "../src/adapter/game.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const intervalMs = Number(process.argv[2] ?? 1000);

/**
 * Stop when the run that started us is gone.
 *
 * This polls the game once a second, so a stray copy is not idle — it is load. Killing the match
 * script by name leaves this child alive, and nine of them once accumulated across restarts and
 * pinned the game hard enough that Runtime.evaluate exceeded its 30s timeout. Outlive the parent
 * by nothing.
 */
const parentPid = process.ppid;
function parentGone(): boolean {
  if (parentPid <= 1) return true; // reparented to init: whoever launched us has exited
  try {
    process.kill(parentPid, 0); // signal 0 tests for existence without sending anything
    return false;
  } catch {
    return true;
  }
}

console.log(`spectating (poll ${intervalMs}ms) — ctrl-c to stop`);

let bridge: CdpBridge | null = null;
let adapter: GameAdapter | null = null;
let lastSeat = -1;
let lastTurn = -1;

async function connect(): Promise<boolean> {
  try {
    const target = (await listTargets(9444, 4000)).find((t) => t.url.includes("root-game"));
    if (!target) return false;
    bridge = await CdpBridge.connect(target.webSocketDebuggerUrl);
    adapter = new GameAdapter(bridge);
    return true;
  } catch {
    return false;
  }
}

for (;;) {
  if (parentGone()) {
    console.log("the match that started me has exited — stopping");
    process.exit(0);
  }
  if (!adapter && !(await connect())) {
    await sleep(3000);
    continue;
  }
  try {
    const state = await adapter!.run<{ clicked: number; removed: number; turn: number; localPlayer: number }>(
      "handoff",
      0,
    );

    // Follow the seat whose turn it is, but only when it changes — re-aiming every poll would
    // fight a human trying to look somewhere else.
    const seats = await adapter!.run<{ majors: Array<{ id: number; active: boolean }> }>("seats", 0);
    const active = seats.majors.find((m) => m.active)?.id ?? -1;
    if (active >= 0 && (active !== lastSeat || state.turn !== lastTurn)) {
      await adapter!.run("focusseat", active).catch(() => undefined);
      console.log(
        `t${state.turn} -> seat p${active}` +
          (state.clicked ? `  (pressed START TURN)` : "") +
          (state.removed ? `  (cleared ${state.removed} curtain${state.removed === 1 ? "" : "s"})` : ""),
      );
      lastSeat = active;
      lastTurn = state.turn;
    }
  } catch {
    // The bridge goes quiet while the engine is busy. Drop it and reconnect.
    try { await bridge?.close(); } catch { /* already gone */ }
    bridge = null;
    adapter = null;
  }
  await sleep(intervalMs);
}
