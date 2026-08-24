// Build a replay page from a run directory: node tools/replay.ts <runDir> [out.html]
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { collectRun } from "../src/replay/build.ts";
import { renderReplayPage } from "../src/replay/page.ts";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node tools/replay.ts <runDir> [out.html]");
  process.exit(1);
}
const out = process.argv[3] ?? join(runDir, "replay.html");
const data = collectRun(runDir);
writeFileSync(out, renderReplayPage(data, `CivBench replay — ${basename(runDir)}`));
console.log(
  `wrote ${out}\n  agents: ${data.agents.map((a) => `${a.name}(${a.turns.length} turns)`).join(", ")}\n  events: ${data.events.length}`,
);
