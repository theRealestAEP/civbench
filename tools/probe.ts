// Phase 0 probe: does the bridge work against a running Civ 7?
// Run with the game launched and in a game (not the main menu) for the fullest answer.
import { discover, CdpBridge, CANDIDATE_PORTS, type CdpTarget } from "../src/adapter/cdp.ts";
import { findGamePids, gameListeningPorts } from "../src/adapter/discover.ts";

const CHECKS: Array<{ name: string; js: string }> = [
  { name: "Game.turn", js: "return Game.turn" },
  { name: "Game.age", js: "return Game.age" },
  { name: "localPlayerID", js: "return GameContext.localPlayerID" },
  { name: "map size", js: "return [GameplayMap.getGridWidth(), GameplayMap.getGridHeight()]" },
  { name: "alive players", js: "return Players.getAlive().map(p => p.id)" },
  {
    name: "per-player fog (item 8)",
    js: `const out = {};
         for (const p of Players.getAlive()) {
           let revealed = 0;
           for (let x = 0; x < GameplayMap.getGridWidth(); x += 4)
             for (let y = 0; y < GameplayMap.getGridHeight(); y += 4)
               if (GameplayMap.getRevealedState(p.id, x, y) > 0) revealed++;
           out[p.id] = revealed;
         }
         return out`,
  },
  {
    name: "canStart masking (item 9)",
    js: `const p = Players.get(GameContext.localPlayerID);
         const units = p?.Units?.getUnitIds?.() ?? [];
         if (!units.length) return "no units";
         const u = units[0];
         return { unit: String(u), ops: GameInfo.UnitOperations
           ? Array.from(GameInfo.UnitOperations).slice(0, 5).map(o => o.OperationType)
           : "no GameInfo.UnitOperations" }`,
  },
];

const pids = findGamePids();
const running = pids.length > 0;
console.log(`Civ 7 process running: ${running ? `yes (pid ${pids.join(", ")})` : "no"}`);

// Ask the OS what the game actually listens on, then fall back to the usual suspects.
const observed = gameListeningPorts();
if (observed.length > 0) console.log(`listening ports: ${observed.join(", ")}`);
const ports = [...new Set([...observed, ...CANDIDATE_PORTS])];

const found = await discover(ports);
if (found.length === 0) {
  console.log(`No CDP endpoint on ports ${ports.join(", ")}.`);
  console.log(
    running
      ? "Game is up but no CDP endpoint answered.\n" +
          "Run `npm run enable-debug`, then relaunch the game and try again.\n" +
          (observed.length > 0
            ? `The game is listening on ${observed.join(", ")} — one of those may speak the\nFireTuner protocol instead of CDP.`
            : "The game is listening on no TCP port, so the bridge is switched off.")
      : "Launch Civilization VII first, start or load a game, then re-run this probe.",
  );
  process.exit(1);
}

for (const { port, targets } of found) {
  console.log(`\nCDP endpoint on port ${port}: ${targets.length} target(s)`);
  for (const t of targets) console.log(`  - ${t.title || "(untitled)"}  ${t.url}`);
}

const target: CdpTarget | undefined = found[0]?.targets.find((t) => t.webSocketDebuggerUrl);
if (!target) {
  console.log("\nNo target exposes a webSocketDebuggerUrl.");
  process.exit(1);
}

console.log(`\nConnecting to: ${target.title || target.id}`);
const bridge = await CdpBridge.connect(target.webSocketDebuggerUrl);

for (const check of CHECKS) {
  try {
    const value = await bridge.eval(check.js);
    console.log(`  PASS  ${check.name}: ${JSON.stringify(value)?.slice(0, 160)}`);
  } catch (err) {
    console.log(`  FAIL  ${check.name}: ${(err as Error).message.slice(0, 160)}`);
  }
}

await bridge.close();
