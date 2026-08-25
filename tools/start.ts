// One command to run a match: configure, launch, play, watch.
//
//   npm start                                   3 Sonnet agents, 10 turns
//   npm start -- --agents 2 --turns 20
//   npm start -- --models claude-sonnet-5,claude-opus-5
//   npm start -- --names Ada,Bruno,Cleo
//   npm start -- --config configs/live-3.yaml   use a config file instead of flags
//   npm start -- --fake                         no Civilization needed (harness only)
//   npm start -- --resume civbench-t0006        continue a saved match
//
// It does the whole sequence with no gaps, which matters: Civ VII's debug bridge is serviced on
// the game thread, so any idle pause between steps can leave it unreachable (docs/FINDINGS.md).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv, requireKey } from "../src/config/env.ts";
import { resolveModel, costOf } from "../src/agent/models.ts";
import { loadMatchConfig, nextRunDir } from "../src/config/load.ts";
import { listTargets, CdpBridge, type CdpTarget } from "../src/adapter/cdp.ts";
import { findGamePids } from "../src/adapter/discover.ts";
import { GameAdapter } from "../src/adapter/game.ts";
import { MatchServer } from "../src/server/match.ts";
import { runMatch } from "../src/server/run.ts";
import { seatsFrom, writeManifest, connect, startMatch } from "../src/server/bootstrap.ts";
import { renderReport } from "../src/server/report.ts";
import { collectRun } from "../src/replay/build.ts";
import { renderReplayPage } from "../src/replay/page.ts";

loadEnv();

// ---------------------------------------------------------------- options

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

if (has("help")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 10).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(0);
}

const useFake = has("fake");
const configPath = flag("config");
const models = (flag("models") ?? "").split(",").filter(Boolean);
const agentCount = Number(flag("agents") ?? models.length ?? 0) || models.length || 3;
const defaultModel = flag("model") ?? "claude-sonnet-5";
const turns = Number(flag("turns") ?? 10);
const speed = flag("speed") ?? "GAMESPEED_QUICK";
const spectate = !has("no-spectate") && !useFake;
// Civ VII has no per-victory toggle: victories are tied to Ages. A single Age keeps a short match
// focused, but a long one wants all three, because that is a full game and domination is defined
// in every Age. --all-ages turns the single-Age restriction off.
const allAges = has("all-ages");
// A turn budget is the only thing that bounds a stalled model, so it has to be long enough for a
// slow-but-working turn and short enough that a dead one is not free. 8 minutes by default.
const turnSeconds = Number(flag("turn-seconds") ?? 480) || 480;
const resumeFrom = flag("resume");

/**
 * Short, distinct names so a match can be discussed out loud. "Ada attacked Bruno" is followable;
 * "seat1-sonnet-5 attacked seat2-sonnet-5" is not. Override with --names.
 */
const DEFAULT_NAMES = ["Ada", "Bruno", "Cleo", "Dara", "Emil", "Fen", "Goro", "Hana", "Iris", "Jun", "Kai", "Lena"];

/** Build a config from flags when no config file is given. */
function buildConfig() {
  const seatModels = Array.from({ length: agentCount }, (_, i) => models[i] ?? defaultModel);
  const chosen = (flag("names") ?? "").split(",").filter(Boolean);
  const seatNames = Array.from({ length: agentCount }, (_, i) => chosen[i] ?? DEFAULT_NAMES[i] ?? `Seat${i}`);
  const yaml = `seed: 8891234
game:
  build: "1.4.2"
  start_age: antiquity
  single_age: ${allAges ? "false" : "true"}
  game_speed: ${speed}
  map_size: default
  turn_limit: ${turns}
  filler_ai: none
  game_modes: []
control_mode: ${useFake ? "direct" : "hotseat"}
agents:
${seatModels
  .map(
    (m, i) => `  - { slot: ${i}, player_id: ${i}, name: ${seatNames[i]}, brain: { model: ${m} }, budget: { actions_per_turn: 80, seconds_per_turn: ${turnSeconds} } }`,
  )
  .join("\n")}
harness: { stall_strikes: 3 }
`;
  mkdirSync("configs/generated", { recursive: true });
  const path = "configs/generated/last-start.yaml";
  writeFileSync(path, yaml);
  return path;
}

const path = configPath ?? buildConfig();
const { config, runId } = loadMatchConfig(path);
// Each model says which key it needs, so a run that uses only OpenRouter models does not demand
// an Anthropic key, and a mixed run demands both.
loadEnv();
for (const agent of config.agents) {
  if (agent.brain.kind !== "model") continue;
  requireKey(resolveModel(agent.brain.model).apiKeyEnv);
}

console.log(`config : ${path}`);
console.log(
  `seats  : ${config.agents.map((a) => `${a.name} (${a.brain.kind === "model" ? a.brain.model : "scripted"})`).join(", ")}`,
);
console.log(
  `turns  : ${turns}   speed: ${config.game.gameSpeed ?? "default"}   mode: ${config.controlMode}   turn budget: ${turnSeconds}s`,
);
const modelAgents = config.agents.filter((a) => a.brain.kind === "model");
// Measured on turn 1 of a real Sonnet 5 run: 298k cached tokens, 18k new, 4.5k output. Token
// counts grow as there is more empire to manage, so ramp them; price them per model, because a
// three-seat match ranges from $0.21 on Luna to $2.84 on Kimi K3 and a flat guess is useless.
const TURN1 = { cacheRead: 298_000, cacheWrite: 18_000, output: 4_500 };
const estimate = modelAgents.reduce((total, agent) => {
  const model = resolveModel((agent.brain as { model: string }).model);
  for (let n = 0; n < turns; n++) {
    const growth = Math.min(4, 1 + n * 0.6);
    total += costOf(model, {
      input: 0,
      output: TURN1.output * growth,
      cacheRead: TURN1.cacheRead * growth,
      cacheWrite: TURN1.cacheWrite,
    });
  }
  return total;
}, 0);
const modelSeats = modelAgents.length;
const minutes = Math.round((modelSeats * turns * 40) / 60) + 3;
console.log(`cost   : roughly $${estimate.toFixed(2)}   time: about ${minutes} min\n`);

// ---------------------------------------------------------------- the game

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OPTIONS = join(homedir(), "Library/Application Support/Civilization VII/AppOptions.txt");

/** Cap the render loop. Civ renders flat out even while an agent thinks for a minute (§11). */
function capFramerate(): void {
  const path = join(homedir(), "Library/Application Support/Civilization VII/GraphicsOptions.txt");
  if (!existsSync(path)) return;
  const wanted: Record<string, string> = { VSync: "1", MSAA: "0" };
  const seen = new Set<string>();
  const out = readFileSync(path, "utf8").split("\n").map((line) => {
    const m = /^\s*;?\s*([A-Za-z_]\w*)\s+(-?\w+)\s*$/.exec(line);
    const k = m?.[1];
    if (k && k in wanted) { seen.add(k); return `${k} ${wanted[k]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(wanted)) if (!seen.has(k)) out.push(`${k} ${v}`);
  writeFileSync(path, out.join("\n"));
}

function applyOptions(): void {
  // UIDebugger is consumed at startup and reset, so write it immediately before every launch.
  const wanted: Record<string, string> = { UIDebugger: "1", EnableTuner: "1", FullScreen: "0" };
  if (!existsSync(OPTIONS)) throw new Error(`no AppOptions.txt at ${OPTIONS}; launch Civ VII once first`);
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
      const found = (await listTargets(9444, 4000)).find(match);
      if (found) return found;
    } catch { /* busy while loading */ }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let adapter: GameAdapter;
let closeBridge: () => Promise<void> = async () => {};

if (useFake) {
  const transport = await connect(true);
  adapter = new GameAdapter(transport.bridge);
  closeBridge = () => transport.bridge.close();
  console.log("transport: fake Civ 7 (harness only)\n");
} else {
  console.log("1. launching Civilization VII");
  for (const pid of findGamePids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await sleep(8000);
  for (let attempt = 1; attempt <= 4; attempt++) {
    applyOptions(); // consumed and reset at every startup
    capFramerate();
    execFileSync("open", ["steam://rungameid/1295660"]);
    let up = false;
    for (let i = 0; i < 12; i++) { await sleep(5000); if (findGamePids().length) { up = true; break; } }
    if (up) break;
    console.log(`   Steam ignored the launch; retrying (${attempt}/4)`);
  }

  // Declared out here because the gameplay-context connection below reuses it.
  let bridge: CdpBridge;

  if (resumeFrom) {
    // Resuming skips setup entirely: the save carries the map, the seats and the turn.
    console.log(`2. loading save "${resumeFrom}"`);
    const shell = await waitForTarget((t) => t.url.includes("root-shell"), "main menu", 240);
    bridge = await CdpBridge.connect(shell.webSocketDebuggerUrl);
    const loaded = await new GameAdapter(bridge).run<{ requested: boolean; error?: string }>(
      "loadsave",
      0,
      { SAVE_NAME: resumeFrom, SERVER_TYPE: config.controlMode === "hotseat" ? "hotseat" : "single" },
    );
    await bridge.close();
    if (!loaded.requested) throw new Error(`could not load "${resumeFrom}": ${loaded.error}`);
    console.log("   load requested");
  } else {
  console.log("2. hosting the match");
  const shell = await waitForTarget((t) => t.url.includes("root-shell"), "main menu", 240);
  bridge = await CdpBridge.connect(shell.webSocketDebuggerUrl);
  const hosted = await new GameAdapter(bridge).run<{ summary?: Record<string, unknown> }>("newgame", 0, {
    SETUP: {
      humanSlots: config.agents.length,
      players: {},
      start: true,
      startAge: "AGE_ANTIQUITY",
      singleAge: config.game.singleAge,
      gameSpeed: config.game.gameSpeed,
      mapSize: config.game.mapSize?.startsWith("MAPSIZE_") ? config.game.mapSize : null,
      maxTurns: turns,
      seed: config.seed,
      serverType: config.controlMode === "hotseat" ? "hotseat" : "single",
      fillerAi: config.game.fillerAi,
    },
  });
  console.log(`   ${JSON.stringify(hosted.summary)}`);
  await bridge.close();

  if (config.controlMode === "hotseat") {
    // Hotseat opens a staging lobby and waits; it does not start on its own.
    console.log("3. starting the hotseat lobby");
    const lobby = await waitForTarget((t) => t.url.includes("root-shell"), "lobby", 60);
    const lobbyBridge = await CdpBridge.connect(lobby.webSocketDebuggerUrl);
    const started = await new GameAdapter(lobbyBridge).run<{ started: boolean; error: string | null }>("startlobby", 0);
    await lobbyBridge.close();
    console.log(`   startGame: ${started.started ? "accepted" : "FAILED " + started.error}`);
  }
  }

  console.log("4. waiting for the map");
  const game = await waitForTarget((t) => t.url.includes("root-game"), "gameplay context", 300);
  bridge = await CdpBridge.connect(game.webSocketDebuggerUrl);
  adapter = new GameAdapter(bridge);
  closeBridge = () => bridge.close();
  for (let i = 0; i < 60; i++) {
    const ready = await adapter.run<{ hasMap: boolean }>("ready", 0).catch(() => ({ hasMap: false }));
    if (ready.hasMap) break;
    await sleep(3000);
  }

  // Verify we actually got the seats we asked for. A single-player host silently gives one.
  const seatCheck = await adapter.run<{ majors: Array<{ id: number; human: boolean }> }>("seats", 0);
  const humans = seatCheck.majors.filter((m) => m.human).map((m) => m.id);
  console.log(`   human seats: ${humans.join(", ") || "none"}`);
  if (humans.length < config.agents.length) {
    throw new Error(
      `asked for ${config.agents.length} seats, got ${humans.length}. ` +
        `A single-player host only ever yields one — use control_mode: hotseat.`,
    );
  }
}

// ---------------------------------------------------------------- spectator

let spectator: ReturnType<typeof spawn> | null = null;
if (spectate) {
  // Kill any spectator left behind by an earlier run before starting ours.
  //
  // The spectator is a child process, and killing this script by name does not kill it. Nine of
  // them accumulated across restarts, each polling the game once a second on its own CDP
  // connection. That pinned the game at 180% CPU, made Runtime.evaluate exceed its 30s timeout,
  // and produced "no seat became active" — which cost hours chasing the game, the extraction
  // scripts, and the models in turn. One stray poller is a nuisance; nine is an outage.
  try {
    execFileSync("pkill", ["-f", "tools/spectate.ts"], { stdio: "ignore" });
  } catch { /* pkill exits non-zero when it matches nothing, which is the normal case */ }

  spectator = spawn("node", ["tools/spectate.ts", "1000"], { stdio: "ignore", detached: false });
  console.log("   spectator running (clears the hotseat handoff, follows the active seat)");
  console.log("   >> bring the Civilization VII window to the front: macOS freezes it when hidden\n");
}

// ---------------------------------------------------------------- the match

const runDir = nextRunDir("runs", runId);
mkdirSync(runDir, { recursive: true });
writeManifest(runDir, config, runId, { bridge: null as never, kind: useFake ? "fake" : "live", detail: "start.ts" });

const { seats, agents } = seatsFrom(config);
// Rival counts come from the loaded game, not from the config: the config asked for no filler AI
// and got three anyway, and the HUD must never tell an agent something the game contradicts.
// One assembly path for every tool: MatchFacts, autosave, and the exported ruleset together.
// Rival counts come from the loaded game, because the config asked for no filler AI and got three.
const majors = await adapter.majorPlayerCount().catch(() => config.agents.length);
const { server, rules } = await startMatch(adapter, runDir, config, agents, {
  turnLimit: turns,
  majorPlayers: majors,
});
if (server.autosave) console.log("   autosaving each turn (resume with --resume <name>)");
console.log(`   rules exported: ${rules.tables} tables, ${rules.rows} rows`);

console.log(`5. playing ${turns} turns\n`);
const outcomes = await runMatch(
  server,
  runDir,
  seats,
  { turnLimit: turns, stallStrikes: config.harness.stallStrikes },
  (line) => console.log(line),
);

spectator?.kill();

const report = renderReport(outcomes, runDir);
writeFileSync(join(runDir, "report.txt"), report + "\n");
console.log("\n" + report);
writeFileSync(join(runDir, "replay.html"), renderReplayPage(collectRun(runDir), `CivBench — ${runId}`));
console.log(`\nreplay: ${join(runDir, "replay.html")}`);
await closeBridge();
