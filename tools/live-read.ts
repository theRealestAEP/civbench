// Read a running Civ 7 match through the real adapter (docs/PLAN.md §15 items 8, 12).
import { listTargets, CdpBridge } from "../src/adapter/cdp.ts";
import { GameAdapter } from "../src/adapter/game.ts";

const target = (await listTargets(9444, 8000)).find((t) => t.url.includes("root-game"));
if (!target) {
  console.error("No gameplay context. Start a match first.");
  process.exit(1);
}
const bridge = await CdpBridge.connect(target.webSocketDebuggerUrl);
const adapter = new GameAdapter(bridge);

for (let i = 0; i < 30; i++) {
  const ready = await adapter.run<{ hasMap: boolean; turn: number | null }>("ready", 0);
  if (ready.hasMap) { console.log(`simulation live, turn ${ready.turn}`); break; }
  await new Promise((r) => setTimeout(r, 4000));
}

const t0 = Date.now();
const alive = await adapter.alivePlayers();
console.log("alive players:", alive.join(", "));

const me = alive[0]!;
const header = await adapter.header(me);
console.log(`\nheader p${me}:`);
console.log(`  civ=${header.civ} leader=${header.leader} turn=${header.turn} age=${header.age}`);
console.log(`  gold=${header.gold} units=${header.unitCount} settlements=${JSON.stringify(header.settlements)}`);
console.log(`  yields=${JSON.stringify(header.yields)}`);

const tiles = await adapter.tiles(me);
const visible = tiles.tiles.filter((x) => x.vis === 2).length;
console.log(`\ntiles: map ${tiles.width}x${tiles.height} = ${tiles.width * tiles.height} plots`);
console.log(`  revealed to p${me}: ${tiles.tiles.length} (${visible} visible, ${tiles.tiles.length - visible} fogged)`);
console.log(`  sample: ${JSON.stringify(tiles.tiles[0])}`);
const fogged = tiles.tiles.find((x) => x.vis === 1);
if (fogged) console.log(`  fogged sample (no owner field): ${JSON.stringify(fogged)}`);

const units = await adapter.units(me);
console.log(`\nunits: own=${units.own.length} visibleForeign=${units.foreign.length}`);
if (units.own[0]) console.log(`  ${JSON.stringify(units.own[0])}`);

const settlements = await adapter.settlements(me);
console.log(`\nsettlements: own=${settlements.own.length} known foreign=${settlements.foreign.length}`);
if (settlements.own[0]) console.log(`  ${JSON.stringify(settlements.own[0])}`);

const players = await adapter.players(me);
console.log(`\nplayers met: ${players.known.length}`);

const pending = await adapter.pending(me);
console.log(`pending: ${pending.items.length} items, blocking=${pending.blockingType}`);
console.log(`\nall reads took ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log("\n=== FOG CHECK: per-player revealed counts ===");
for (const p of alive) {
  const t = await adapter.tiles(p);
  console.log(`  p${p}: ${t.tiles.length} plots revealed`);
}
await bridge.close();
