// One command: launch Civ 7, host a match, and play it with the harness.
//
// This exists because the pieces are only reliable when run without gaps. The Coherent debug
// server is serviced on the game thread, so a game that has been sitting idle behind another
// window stops answering (docs/FINDINGS.md). Doing launch -> host -> play in one unbroken
// sequence avoids that entirely.
//
//   node tools/live-session.ts configs/live-solo.yaml [--turns N]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listTargets, CdpBridge, type CdpTarget } from "../src/adapter/cdp.ts";
import { findGamePids } from "../src/adapter/discover.ts";
import { GameAdapter } from "../src/adapter/game.ts";
import { MatchServer } from "../src/server/match.ts";
import { runMatch } from "../src/server/run.ts";
import { seatsFrom, writeManifest } from "../src/server/bootstrap.ts";
import { loadMatchConfig, nextRunDir } from "../src/config/load.ts";
import { renderReport } from "../src/server/report.ts";
import { collectRun } from "../src/replay/build.ts";
import { renderReplayPage } from "../src/replay/page.ts";
import { loadEnv } from "../src/config/env.ts";

loadEnv(); // model brains need ANTHROPIC_API_KEY before any seat is built

const PORT = 9444;
const OPTIONS = join(homedir(), "Library/Application Support/Civilization VII/AppOptions.txt");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function applyOptions(): void {
  // UIDebugger is consumed at startup and reset, so it must be written immediately before launch.
  const wanted: Record<string, string> = { UIDebugger: "1", EnableTuner: "1", FullScreen: "0" };
  if (!existsSync(OPTIONS)) throw new Error(`no AppOptions.txt at ${OPTIONS}`);
  const seen = new Set<string>();
  const out = readFileSync(OPTIONS, "utf8").split("\n").map((line) => {
    const m = /^\s*;?\s*([A-Za-z_]\w*)\s+(-?\w+)\s*$/.exec(line);
    const k = m?.[1];
    if (k && k in wanted) { seen.add(k); return `${k} ${wanted[k]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(wanted)) if (!seen.has(k)) out.push(`${k} ${v}`);
  writeFileSync(OPTIONS, out.join("\n"));
}

async function waitForTarget(match: (t: CdpTarget) => boolean, label: string, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const found = (await listTargets(PORT, 4000)).find(match);
      if (found) return found;
    } catch { /* busy while loading; expected */ }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const configPath = process.argv[2] ?? "configs/live-solo.yaml";
const turnsArg = process.argv.indexOf("--turns");
const { config, runId } = loadMatchConfig(configPath);
const turnLimit = turnsArg > 0 ? Number(process.argv[turnsArg + 1]) : config.game.turnLimit;

/**
 * Ask Steam to start the game, and check that it actually did.
 *
 * Steam intermittently swallows a `steam://rungameid` request issued shortly after the game was
 * killed — it still believes the previous process is alive. Retrying is the whole fix.
 */
async function launchGame(attempts = 4): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    applyOptions(); // consumed and reset at every startup, so write it each time
    execFileSync("open", ["steam://rungameid/1295660"]);
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      if (findGamePids().length > 0) return;
    }
    console.log(`   Steam ignored the launch; retrying (${attempt}/${attempts})`);
  }
  throw new Error("could not start Civilization VII through Steam");
}

console.log("1. launching a fresh game");
for (const pid of findGamePids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
await sleep(8000);
await launchGame();

console.log("2. waiting for the main menu");
const shell = await waitForTarget((t) => t.url.includes("root-shell"), "shell", 240);

console.log("3. hosting the match");
let bridge = await CdpBridge.connect(shell.webSocketDebuggerUrl);
const hosted = await new GameAdapter(bridge).run<{ summary?: Record<string, unknown> }>(
  "newgame",
  0,
  {
    SETUP: {
      humanSlots: config.agents.length,
      players: {},
      start: true,
      startAge: config.game.startAge === "modern" ? "AGE_MODERN"
        : config.game.startAge === "exploration" ? "AGE_EXPLORATION" : "AGE_ANTIQUITY",
      singleAge: config.game.singleAge,
      gameSpeed: config.game.gameSpeed,
      // Only pass a size the config names explicitly as a MAPSIZE_ constant; an
      // unsupported one fails the load with a dialog and no log line (docs/FINDINGS.md).
      mapSize: config.game.mapSize?.startsWith("MAPSIZE_") ? config.game.mapSize : null,
      maxTurns: turnLimit,
      seed: config.seed,
      serverType: config.controlMode === "hotseat" ? "hotseat" : "single",
    },
  },
);
console.log("   ", JSON.stringify(hosted.summary));
await bridge.close();

// Hotseat does not start from hostGame: it opens the multiplayer staging room and waits for the
// host to start. Do it immediately, with no idle gap — the debug bridge goes quiet whenever the
// game sits idle (docs/FINDINGS.md).
if (config.controlMode === "hotseat") {
  console.log("3b. starting the hotseat lobby");
  const lobbyShell = await waitForTarget((t) => t.url.includes("root-shell"), "shell", 60);
  const lobbyBridge = await CdpBridge.connect(lobbyShell.webSocketDebuggerUrl);
  const lobby = await new GameAdapter(lobbyBridge).run<{ started: boolean; error: string | null }>(
    "startlobby",
    0,
  );
  await lobbyBridge.close();
  console.log(`    startGame: ${lobby.started ? "accepted" : "FAILED " + lobby.error}`);
}

console.log("4. waiting for the match to load");
let gameTarget;
try {
  gameTarget = await waitForTarget((t) => t.url.includes("root-game"), "gameplay context", 300);
} catch (err) {
  // The game refuses some configurations with an on-screen dialog and no log line. Read it,
  // so a failed setup reports its actual reason instead of a timeout.
  try {
    const shellAgain = await waitForTarget((t) => t.url.includes("root-shell"), "shell", 30);
    const b = await CdpBridge.connect(shellAgain.webSocketDebuggerUrl);
    const seen = await new GameAdapter(b).run<{ dialogs: string[] }>("dialog", 0);
    await b.close();
    if (seen.dialogs.length > 0) {
      console.error("\nThe game refused this configuration:");
      for (const d of seen.dialogs) console.error(`  ${d}`);
    }
  } catch { /* best effort */ }
  throw err;
}
bridge = await CdpBridge.connect(gameTarget.webSocketDebuggerUrl);
const adapter = new GameAdapter(bridge);
for (let i = 0; i < 60; i++) {
  const ready = await adapter.run<{ hasMap: boolean }>("ready", 0).catch(() => ({ hasMap: false }));
  if (ready.hasMap) break;
  await sleep(3000);
}
console.log(`   simulation live at turn ${await adapter.turn()}`);

// The setup summary lies: a single-player host reports the human slots you asked for and then
// converts all but one back to AI. Check what actually loaded before spending anything.
const seatCheck = await adapter.run<{
  localPlayer: number;
  majors: Array<{ id: number; human: boolean; active: boolean }>;
}>("seats", 0);
const humans = seatCheck.majors.filter((m) => m.human).map((m) => m.id);
console.log(`   human seats: ${humans.length ? humans.join(", ") : "none"} (local ${seatCheck.localPlayer})`);
if (humans.length < config.agents.length) {
  throw new Error(
    `asked for ${config.agents.length} agent seats but the game loaded ${humans.length}. ` +
      `control_mode is "${config.controlMode}". A single-player host only ever yields one human ` +
      `seat — use control_mode: hotseat for several.`,
  );
}

console.log(`5. playing ${turnLimit} turns\n`);
const runDir = nextRunDir("runs", runId);
mkdirSync(runDir, { recursive: true });
writeManifest(runDir, config, runId, { bridge, kind: "live", detail: "CDP live-session" });
const { seats, agents } = seatsFrom(config);
const server = new MatchServer(adapter, runDir, agents);
const outcomes = await runMatch(
  server,
  runDir,
  seats,
  { turnLimit, stallStrikes: config.harness.stallStrikes },
  // Live ticker: one line per seat-turn, so a long match is watchable in the terminal.
  (line) => console.log(line),
);

const report = renderReport(outcomes, runDir);
writeFileSync(join(runDir, "report.txt"), report + "\n");
console.log(report);
writeFileSync(join(runDir, "replay.html"), renderReplayPage(collectRun(runDir), `CivBench live — ${runId}`));
console.log(`\nreplay: ${join(runDir, "replay.html")}`);
await bridge.close();
