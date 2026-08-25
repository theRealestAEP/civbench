// Run a match from a config: node tools/run-match.ts configs/duel.yaml [--fake] [--turns N]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMatchConfig, nextRunDir } from "../src/config/load.ts";
import { MatchServer } from "../src/server/match.ts";
import { runMatch } from "../src/server/run.ts";
import { GameAdapter } from "../src/adapter/game.ts";
import { connect, seatsFrom, writeManifest , startMatch} from "../src/server/bootstrap.ts";
import { renderReport } from "../src/server/report.ts";
import { collectRun } from "../src/replay/build.ts";
import { renderReplayPage } from "../src/replay/page.ts";
import { loadEnv } from "../src/config/env.ts";

loadEnv(); // model brains need ANTHROPIC_API_KEY before any seat is built

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: node tools/run-match.ts <config.yaml> [--fake] [--turns N]");
  process.exit(1);
}
const preferFake = process.argv.includes("--fake");
const turnsArg = process.argv.indexOf("--turns");

const { config, runId } = loadMatchConfig(configPath);
const turnLimit = turnsArg > 0 ? Number(process.argv[turnsArg + 1]) : config.game.turnLimit;

const transport = await connect(preferFake);
console.log(`transport: ${transport.detail}`);
if (transport.kind === "fake") {
  console.log("  (no live game found — this exercises the harness, not Civilization)");
}

const runDir = nextRunDir("runs", runId);
mkdirSync(runDir, { recursive: true });
writeManifest(runDir, config, runId, transport);

const { seats, agents } = seatsFrom(config);
const { server, rules } = await startMatch(new GameAdapter(transport.bridge), runDir, config, agents, {
  turnLimit: config.game.turnLimit,
});
if (rules.tables > 0) console.log(`   rules exported: ${rules.tables} tables, ${rules.rows} rows`);

console.log(`run ${runId}: ${agents.length} seats, up to ${turnLimit} turns\n`);
const outcomes = await runMatch(
  server,
  runDir,
  seats,
  { turnLimit, stallStrikes: config.harness.stallStrikes },
  (line) => console.log(line),
);

const report = renderReport(outcomes, runDir);
writeFileSync(join(runDir, "report.txt"), report + "\n");
console.log(report);

const replayPath = join(runDir, "replay.html");
writeFileSync(replayPath, renderReplayPage(collectRun(runDir), `CivBench — ${runId}`));
console.log(`\nreplay: ${replayPath}`);

await transport.bridge.close();
