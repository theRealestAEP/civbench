// Start a real match and validate the extraction pipeline against it (docs/PLAN.md §15).
//
// Kept as ONE script with as few connections as possible: Cohtml's debug server is serviced on
// the game thread, and hammering /json/list while the game is busy wedges it.
import { listTargets, CdpBridge, type CdpTarget } from "../src/adapter/cdp.ts";
import { GameAdapter } from "../src/adapter/game.ts";

const PORT = 9444;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget(match: (t: CdpTarget) => boolean, label: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const found = (await listTargets(PORT, 4000)).find(match);
      if (found) return found;
    } catch { /* the game is busy; that is expected during load */ }
    if (i % 6 === 0) console.log(`  waiting for ${label} (${i * 5}s)`);
    await sleep(5000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

console.log("1. connecting to the shell");
const shell = await waitForTarget((t) => t.url.includes("root-shell"), "shell");
let bridge = await CdpBridge.connect(shell.webSocketDebuggerUrl);
let adapter = new GameAdapter(bridge);

console.log("2. configuring and starting a match");
const setup = await adapter.run<{ ok: boolean; started?: boolean; summary?: Record<string, unknown> }>(
  "newgame",
  0,
  {
    SETUP: {
      mapScript: "MAPS_CONTINENTS_PLUS",
      mapSize: "MAPSIZE_TINY",
      seed: 8891234,
      startAge: "AGE_ANTIQUITY",
      maxTurns: 150,
      humanSlots: 1,
      players: { 0: { civ: "CIVILIZATION_EGYPT", leader: "LEADER_HATSHEPSUT" } },
      start: true,
    },
  },
);
console.log("   ", JSON.stringify(setup.summary));
await bridge.close();

console.log("3. waiting for the gameplay context (map generation takes a while)");
const game = await waitForTarget((t) => t.url.includes("root-game"), "gameplay context", 90);
await sleep(5000);
bridge = await CdpBridge.connect(game.webSocketDebuggerUrl);
adapter = new GameAdapter(bridge);

console.log("4. waiting for the simulation to exist");
for (let i = 0; i < 60; i++) {
  try {
    const ready = await adapter.run<{ hasMap: boolean; turn: number | null }>("ready", 0);
    if (ready.hasMap) {
      console.log(`   simulation live at turn ${ready.turn}`);
      break;
    }
  } catch { /* still loading */ }
  await sleep(5000);
}

console.log("5. reading live state");
const alive = await adapter.alivePlayers();
console.log("   alive players:", alive.join(", "));
const turn = await adapter.turn();
console.log("   turn:", turn);

const me = alive[0]!;
const header = await adapter.header(me);
console.log(`   p${me}: ${header.civ} / ${header.leader}, gold ${header.gold}, units ${header.unitCount}`);

const tiles = await adapter.tiles(me);
console.log(`   map ${tiles.width}x${tiles.height}, ${tiles.tiles.length} plots revealed to p${me}`);
const visible = tiles.tiles.filter((t) => t.vis === 2).length;
console.log(`   ${visible} visible, ${tiles.tiles.length - visible} fogged`);
console.log("   sample tile:", JSON.stringify(tiles.tiles[0]));

const units = await adapter.units(me);
console.log(`   own units ${units.own.length}, visible foreign ${units.foreign.length}`);
if (units.own[0]) console.log("   sample unit:", JSON.stringify(units.own[0]));

console.log("\n6. FOG CHECK across players");
for (const p of alive.slice(0, 4)) {
  const t = await adapter.tiles(p);
  console.log(`   p${p}: ${t.tiles.length} plots revealed`);
}

await bridge.close();
console.log("\ndone");
