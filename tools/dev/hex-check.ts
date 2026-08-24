// Is our hex distance the same as the engine's?
//
// src/cli/near.ts assumes Civ lays hexes out as odd-r offset rows. Nothing in the extracted UI
// source states the parity, so this asks the running game directly. Run it against a live match.
import { loadEnv } from "../../src/config/env.ts";
import { listTargets, CdpBridge } from "../../src/adapter/cdp.ts";
import { hexDistance } from "../../src/cli/near.ts";

loadEnv();

const targets = await listTargets();
const game = targets.find((t) => t.url.includes("root-game"));
if (!game) {
  console.log("no game target — start a match first");
  process.exit(1);
}
const bridge = new CdpBridge(game.webSocketDebuggerUrl);
await bridge.connect();

const pairs: Array<[number, number, number, number]> = [
  [10, 10, 10, 10], [10, 10, 11, 10], [10, 10, 10, 11], [10, 10, 9, 11],
  [10, 11, 10, 12], [10, 11, 11, 12], [11, 10, 12, 11], [10, 10, 14, 13],
  [7, 5, 3, 12], [20, 20, 21, 23],
];

let bad = 0;
for (const [ax, ay, bx, by] of pairs) {
  const engine = await bridge.eval<number>(`GameplayMap.getPlotDistance(${ax},${ay},${bx},${by})`);
  const ours = hexDistance(ax, ay, bx, by);
  const ok = engine === ours;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "DIFF"} (${ax},${ay})->(${bx},${by})  engine=${engine} ours=${ours}`);
}
console.log(bad === 0 ? "\nodd-r offset confirmed" : `\n${bad} mismatches — the parity assumption is wrong`);
process.exit(bad === 0 ? 0 : 1);
