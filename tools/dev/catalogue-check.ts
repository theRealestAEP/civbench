// Does the live game's catalogue contain the names the game itself uses?
// Run with a match loaded. This is the check that would have caught the enum-key mistake.
import { listTargets, CdpBridge } from "../../src/adapter/cdp.ts";
import { GameAdapter } from "../../src/adapter/game.ts";

const target = (await listTargets(9444, 8000)).find((t) => t.url.includes("root-game"));
if (!target) {
  console.error("No gameplay context — start a match first.");
  process.exit(1);
}
const adapter = new GameAdapter(await CdpBridge.connect(target.webSocketDebuggerUrl));
const kinds = await adapter.run<Record<string, string[]>>("optypes", 0);

for (const [kind, names] of Object.entries(kinds)) {
  console.log(`${kind}: ${names.length}`);
  console.log(`   sample: ${names.slice(0, 3).join(", ")}`);
}

// These are names the shipped UI passes verbatim, so the catalogue must contain them.
const MUST_CONTAIN: Array<[string, string]> = [
  ["unit_operation", "UNITOPERATION_FOUND_CITY"],
  ["unit_operation", "UNITOPERATION_MOVE_TO"],
  ["player_operation", "SET_TECH_TREE_NODE"],
];
let bad = 0;
console.log("");
for (const [kind, name] of MUST_CONTAIN) {
  const ok = kinds[kind]?.includes(name);
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "MISSING"}  ${kind} -> ${name}`);
}
process.exit(bad === 0 ? 0 : 1);
