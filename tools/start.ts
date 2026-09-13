// One command to run a match: configure, launch, play, watch.
//
//   npm start                                   3 Sonnet agents, 10 turns
//   npm start -- --agents 2 --turns 20
//   npm start -- --models claude-sonnet-5,claude-opus-5
//   npm start -- --names Ada,Bruno,Cleo
//   npm start -- --config configs/live-3.yaml   use a config file instead of flags
//   npm start -- --fake                         no Civilization needed (harness only)
//   npm start -- --resume civbench-t0006        continue a saved match
//   npm start -- --attach --go                  join the match the game is already playing
//
// It does the whole sequence with no gaps, which matters: Civ VII's debug bridge is serviced on
// the game thread, so any idle pause between steps can leave it unreachable (docs/FINDINGS.md).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, createReadStream } from "node:fs";
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
import { pickLeader, matchLeader, leaderPrompt } from "../src/agent/pick-leader.ts";
import { LEADERS } from "../src/agent/leaders-list.ts";
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
let turns = Number(flag("turns") ?? 10);
const speed = flag("speed") ?? "GAMESPEED_QUICK";
/**
 * Stop macOS throttling the game when its window is hidden.
 *
 * App Nap suspends a backgrounded app, which froze the game mid-match and made every bridge call
 * time out. The advice until now was "keep the window in front", which is not a thing anyone
 * should have to do for a ten-hour match. Written every launch because a `defaults` value set by
 * hand is one `defaults delete` away from being lost silently.
 */
function keepAwake(): void {
  for (const bundle of ["com.2k.civ7", "com.valvesoftware.steam"]) {
    try {
      execFileSync("defaults", ["write", bundle, "NSAppSleepDisabled", "-bool", "YES"], { stdio: "ignore" });
    } catch { /* not fatal: the match still runs, it just wants the window visible */ }
  }
}

/**
 * Drop the game to a low scheduling priority.
 *
 * A match runs for hours on someone's working machine, and Civ takes two to three cores whether or
 * not anyone is watching it. Nice makes it yield to whatever the machine is really for; it keeps
 * every core it can get when nothing else wants them, so turns do not get slower in practice.
 */
function yieldPriority(): void {
  for (const pid of findGamePids()) {
    try {
      execFileSync("renice", ["+10", "-p", String(pid)], { stdio: "ignore" });
    } catch { /* best effort */ }
  }
}

const spectate = !has("no-spectate") && !useFake;
// Civ VII has no per-victory toggle: victories are tied to Ages. A single Age keeps a short match
// focused, but a long one wants all three, because that is a full game and domination is defined
// in every Age. --all-ages turns the single-Age restriction off.
const allAges = has("all-ages");
// A turn budget is the only thing that bounds a stalled model, so it has to be long enough for a
// slow-but-working turn and short enough that a dead one is not free. 8 minutes by default.
const turnSeconds = Number(flag("turn-seconds") ?? 480) || 480;
const resumeFrom = flag("resume");
// Join a match the game is already playing, without relaunching it. For swapping in a harness
// change mid-run: the old harness is stopped, this one connects to the same game and carries on
// from whichever seat is active. The agents start fresh conversations, as they do on a resume.
const attach = has("attach");

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
    (m, i) => `  - { slot: ${i}, player_id: ${i}, name: ${seatNames[i]}, brain: { model: ${m} }, budget: { actions_per_turn: 500, seconds_per_turn: ${turnSeconds} } }`,
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
// A config file's turn_limit is the match length. The `turns` flag default silently overrode it
// — a config saying 80 turns ran 10, in the engine's maxTurns, the run loop, and the estimate.
// An explicit --turns still wins, so a config can be trialled short without editing it.
if (flag("turns") === undefined) turns = config.game.turnLimit;
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
// Per 100 turns as well as at the limit: a config's turn_limit is a backstop (1000), and the
// figure at the backstop read as the price of the match — "$400" for a game that ends by turn 150.
const per100 = (estimate * 100) / Math.max(1, turns);
console.log(`cost   : roughly $${per100.toFixed(2)} per 100 turns ($${estimate.toFixed(2)} at the ${turns}-turn limit)   time: about ${Math.round((modelSeats * 100 * 40) / 60)} min per 100 turns (${minutes} min at the limit)\n`);

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

/** Kill any leftover game process and launch a fresh one through Steam. */
/** A short, UI-free summary of the match settings for the leader pick. */
function settingsSummary(): string {
  const g = config.game;
  return [
    `Start age: ${g.startAge}`,
    `Single age (ends in a victory, no age transitions): ${g.singleAge}`,
    `Game speed: ${g.gameSpeed ?? "default"}`,
    `Map: ${g.mapType}, size ${g.mapSize}`,
    `Crises enabled: ${g.crises}`,
    `Turn limit: ${g.turnLimit}`,
    `Other players: ${Math.max(0, config.agents.length - 1)}`,
    `Filler AI: ${g.fillerAi}`,
  ].join("\n");
}

/** Let each model-driven agent choose its leader; fill `players` with the picks. Never throws. */
async function chooseLeaders(players: Record<number, { leader?: string }>): Promise<void> {
  // The leader roster is a STATIC local list (src/agent/leaders-list.ts, extracted from the game's
  // own leaders.xml) — no live query. Reading it from the shell was fragile: GameInfo.Leaders is
  // empty before a match exists. setLeaderTypeName still validates the pick against the game.
  const leaders = LEADERS;
  const { system, user } = leaderPrompt(settingsSummary(), leaders);
  const pickers = config.agents.filter((a) => a.brain.kind === "model");
  console.log(`   ${pickers.length} agent(s) choosing a leader (high reasoning; this takes a moment)...`);
  // In parallel, each try bounded and retried: a stalled model (DeepSeek has a stall history)
  // must NOT hang the whole setup, and one silent stream must not hand the seat the game's
  // default leader either — pickLeader asks again before giving up.
  await Promise.all(
    pickers.map(async (agent) => {
      if (agent.brain.kind !== "model") return;
      try {
        const answer = await pickLeader(agent.brain.model, system, user, agent.brain.thinking, {
          onRetry: (attempt, reason) => console.log(`   ${agent.name}'s pick stalled (${reason}); asking again (try ${attempt + 1})`),
        });
        const type = matchLeader(answer, leaders);
        if (type) {
          players[agent.playerId] = { leader: type };
          console.log(`   ${agent.name} chose ${type}`);
        } else {
          console.log(`   ${agent.name} gave an unclear pick ("${answer.slice(0, 40)}"); using default`);
        }
      } catch (err) {
        console.log(`   ${agent.name} leader pick skipped (${String(err).slice(0, 80)}); using default`);
      }
    }),
  );
}

async function launchGame(): Promise<void> {
  for (const pid of findGamePids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await sleep(8000);
  for (let attempt = 1; attempt <= 4; attempt++) {
    applyOptions(); // consumed and reset at every startup
    capFramerate();
    execFileSync("open", ["steam://rungameid/1295660"]);
    let up = false;
    for (let i = 0; i < 12; i++) { await sleep(5000); if (findGamePids().length) { up = true; break; } }
    if (up) return;
    console.log(`   Steam ignored the launch; retrying (${attempt}/4)`);
  }
}

/**
 * Ask the freshly launched game's main menu to load a save.
 *
 * Three phases against loadsave.js: query the save list, wait for the results to arrive on the
 * engine's own event, then load the entry with ITS metadata. Loading with fabricated metadata
 * turned a hotseat save into a one-human game and killed the first live resume.
 */
async function loadSave(name: string): Promise<void> {
  const shell = await waitForTarget((t) => t.url.includes("root-shell"), "main menu", 240);
  const shellBridge = await CdpBridge.connect(shell.webSocketDebuggerUrl);
  const shellAdapter = new GameAdapter(shellBridge);
  const serverType = config.controlMode === "hotseat" ? "hotseat" : "single";
  try {
    const queried = await shellAdapter.run<{ queries: number }>(
      "loadsave", 0, { MODE: "query", SAVE_NAME: name, SERVER_TYPE: serverType },
    );
    let found = false;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const seen = await shellAdapter.run<{ found: boolean; answered: number; total: number }>(
        "loadsave", 0, { MODE: "find", SAVE_NAME: name, SERVER_TYPE: serverType },
      );
      if (seen.found) { found = true; break; }
      // Every query answered and the save is not there: waiting longer will not help.
      if (seen.answered >= queried.queries && i > 3) break;
    }
    if (!found) throw new Error(`save "${name}" did not appear in the game's save list`);
    const loaded = await shellAdapter.run<{ requested: boolean; error?: string; name?: string }>(
      "loadsave", 0, { MODE: "load", SAVE_NAME: name, SERVER_TYPE: serverType },
    );
    if (!loaded.requested) throw new Error(`could not load "${name}": ${loaded.error}`);
    console.log(`   load requested (${loaded.name ?? name})`);
  } finally {
    await shellBridge.close();
  }

  // A loaded HOTSEAT game parks in the multiplayer staging room, exactly like a hosted one, and
  // waits for Network.startGame(). The resume path never sent it, so the first live resume sat
  // at "waiting for the map" until the timeout with a perfectly loaded 3-seat game behind it.
  // Retried, because startGame is refused while the load is still setting the room up.
  if (config.controlMode === "hotseat") {
    console.log("   starting the loaded hotseat lobby");
    for (let attempt = 0; attempt < 18; attempt++) {
      await sleep(5000);
      try {
        const lobby = await waitForTarget((t) => t.url.includes("root-shell"), "lobby", 30);
        const lobbyBridge = await CdpBridge.connect(lobby.webSocketDebuggerUrl);
        const started = await new GameAdapter(lobbyBridge)
          .run<{ started: boolean; error: string | null }>("startlobby", 0);
        await lobbyBridge.close();
        if (started.started) {
          console.log("   startGame: accepted");
          return;
        }
      } catch { /* the shell target reloads during staging; try again */ }
    }
    console.log("   startGame never accepted — the map wait below will say if it mattered");
  }
}

/** Two runMatch legs of the same match, as one set of per-seat totals for the report. */
function mergeOutcomes(
  first: Awaited<ReturnType<typeof runMatch>>,
  second: Awaited<ReturnType<typeof runMatch>>,
): Awaited<ReturnType<typeof runMatch>> {
  const bySeat = new Map(first.map((o) => [o.name, { ...o }]));
  for (const o of second) {
    const seat = bySeat.get(o.name);
    if (!seat) { bySeat.set(o.name, { ...o }); continue; }
    seat.turnsPlayed += o.turnsPlayed;
    seat.commands += o.commands;
    seat.timeouts += o.timeouts;
    seat.forcedEndTurns += o.forcedEndTurns;
    seat.illegalActions += o.illegalActions;
    seat.inputTokens += o.inputTokens;
    seat.outputTokens += o.outputTokens;
  }
  // SAFETY: the array carries SeatOutcome values built above; the cast only re-attaches the
  // `gameCrashed` marker property that runMatch's return type declares.
  const merged = [...bySeat.values()] as Awaited<ReturnType<typeof runMatch>>;
  merged.gameCrashed = second.gameCrashed;
  return merged;
}

let adapter: GameAdapter;
let closeBridge: () => Promise<void> = async () => {};

if (useFake) {
  const transport = await connect(true);
  adapter = new GameAdapter(transport.bridge);
  closeBridge = () => transport.bridge.close();
  console.log("transport: fake Civ 7 (harness only)\n");
} else {
  keepAwake();
  if (attach) {
    console.log("1. attaching to the running game");
  } else {
    console.log("1. launching Civilization VII");
    await launchGame();
  }

  // Declared out here because the gameplay-context connection below reuses it.
  let bridge: CdpBridge;

  if (attach) {
    // The match exists; nothing to load or host.
  } else if (resumeFrom) {
    // Resuming skips setup entirely: the save carries the map, the seats and the turn.
    console.log(`2. loading save "${resumeFrom}"`);
    await loadSave(resumeFrom);
  } else {
  console.log("2. hosting the match");
  const shell = await waitForTarget((t) => t.url.includes("root-shell"), "main menu", 240);
  bridge = await CdpBridge.connect(shell.webSocketDebuggerUrl);
  const shellAdapter = new GameAdapter(bridge);
  // Each agent picks its own leader from the settings, before the game exists (a behavior study).
  // Off by default; any failure falls back to the game's default leader and never blocks the start.
  const players: Record<number, { leader?: string }> = {};
  if (config.game.agentsPickLeaders) await chooseLeaders(players);
  const hosted = await shellAdapter.run<{ summary?: Record<string, unknown> }>("newgame", 0, {
    SETUP: {
      humanSlots: config.agents.length,
      players,
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

  yieldPriority();
  console.log("4. waiting for the map");
  const game = await waitForTarget((t) => t.url.includes("root-game"), "gameplay context", attach ? 30 : 300);
  bridge = await CdpBridge.connect(game.webSocketDebuggerUrl);
  // The debug server is serviced on the game thread and goes quiet while the engine is busy, so
  // over 50 turns the socket does eventually drop. Nothing used to reconnect it: every read after
  // that failed, the match loop reported "no seat became active", and an hour of a live run was
  // spent printing that line at a game that was fine. Re-discover, because the target gets a new
  // id when the UI context reloads.
  const reopen = async () => {
    console.log("   the debug connection stalled — reconnecting to the game");
    const again = await waitForTarget((t) => t.url.includes("root-game"), "gameplay context", 60);
    bridge = await CdpBridge.connect(again.webSocketDebuggerUrl);
    closeBridge = () => bridge.close();
    return bridge;
  };
  adapter = new GameAdapter(bridge, reopen);
  closeBridge = () => bridge.close();
  for (let i = 0; i < 60; i++) {
    const ready = await adapter.run<{ hasMap: boolean }>("ready", 0).catch(() => ({ hasMap: false }));
    if (ready.hasMap) break;
    await sleep(3000);
  }

  // Verify we actually got the seats we asked for. A single-player host silently gives one.
  // POLLED: right after a save loads, the seat flags lag the map by several seconds, and the
  // first live resume died here with "got 1" while the save genuinely held three.
  // Asked with the seats we expect, so an ELIMINATED human seat still counts: it is human, it is
  // just no longer alive, and a harness attaching after a defeat must not read that as a host
  // that converted a seat to AI.
  const expectedSeats = config.agents.map((a) => a.playerId);
  let humans: number[] = [];
  for (let i = 0; i < 20; i++) {
    const seatCheck = await adapter
      .run<{ majors: Array<{ id: number; human: boolean }> }>("seats", 0, { SEAT_IDS: expectedSeats })
      .catch(() => ({ majors: [] }));
    humans = seatCheck.majors.filter((m) => m.human).map((m) => m.id);
    if (humans.length >= config.agents.length) break;
    await sleep(3000);
  }
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
  console.log("   the window can be minimised: App Nap is off, so macOS will not throttle it\n");
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
// The A/B lever for the engine-crash hunt: --no-spectate silences the overlay evals too.
if (!spectate) server.overlayEnabled = false;
if (server.autosave) console.log("   autosaving each turn (resume with --resume <name>)");
console.log(`   rules exported: ${rules.tables} tables, ${rules.rows} rows`);

// The start button. Everything is staged — the game is up, the seats are claimed, the ruleset
// is exported — and nothing plays until you say so, so you can get the window where you want it
// and the narrator attached before turn 1. `--go` skips the pause for unattended runs, and a
// non-interactive stdin (CI, a pipe) never waits.
if (!useFake && !has("go")) {
  // Wait on the CONTROLLING TERMINAL, not process.stdin. stdin is often not a TTY under a launcher
  // (tmux/npm layering, a pipe, an IDE terminal), and the old `process.stdin.isTTY` gate silently
  // skipped the pause in those cases, so the match auto-started. /dev/tty is the real terminal and
  // opens whenever one exists; it fails only in genuinely non-interactive contexts (CI), where we
  // then proceed without blocking.
  await new Promise<void>((resolve) => {
    let tty: ReturnType<typeof createReadStream>;
    try {
      tty = createReadStream("/dev/tty");
    } catch {
      resolve();
      return;
    }
    tty.on("error", () => resolve()); // no controlling terminal -> do not block
    console.log("\n▶ READY — press Enter to start the match (--go skips this pause)");
    // Only an Enter pressed AFTER the prompt counts. The terminal is in line mode, so anything
    // typed during the two-minute launch sits in its input buffer and the first read hands it
    // over at once — an Enter pressed while the map was loading started the match the instant
    // this prompt appeared. Let that buffered input drain first, then wait for a fresh line.
    let armed = false;
    tty.on("data", () => {
      if (!armed) {
        console.log("   (ignoring input typed before the prompt)");
        return;
      }
      tty.close();
      resolve();
    });
    setTimeout(() => { armed = true; }, 300);
  });
}

console.log(`5. playing ${turns} turns\n`);
const matchStartTurn = await server.currentTurn().catch(() => 1);
let outcomes = await runMatch(
  server,
  runDir,
  seats,
  { turnLimit: turns, live: !useFake },
  (line) => console.log(line),
);

// Civ 7 sometimes dies mid-match — a known engine SIGSEGV has ended three runs. Every turn is
// autosaved, so a crash is a hiccup, not a lost run: relaunch the game, load the last autosave,
// and keep playing IN THIS PROCESS — same run directory, same event log, same fog memory, and
// the narrator never loses the thread. Only a recovery that itself fails ends the match.
// Effectively unlimited: the engine bug behind this fires roughly every 10-40 minutes of play
// no matter which trigger the harness starves (eight identical crashes, every theory falsified
// by the next one). Each recovery costs a few minutes and loses at most one turn, so the cap
// exists only to stop a truly wedged system from looping forever.
const MAX_RECOVERIES = 50;
for (let recovery = 1; !useFake && outcomes.gameCrashed && recovery <= MAX_RECOVERIES; recovery++) {
  const lastTurn = server.lastSnapshotTurn();
  const runName = runDir.split("/").filter(Boolean).at(-1) ?? "run";
  const save = `civbench-${runName}-t${String(lastTurn).padStart(4, "0")}`;
  console.log(
    `\nthe game crashed. Recovery ${recovery}/${MAX_RECOVERIES}: relaunching and loading ${save}`,
  );
  try {
    await launchGame();
    await loadSave(save);
    await waitForTarget((t) => t.url.includes("root-game"), "gameplay context", 300);
  } catch (err) {
    console.log(`   recovery failed: ${String(err).slice(0, 140)}`);
    break;
  }
  const remaining = Math.max(1, turns - (lastTurn - matchStartTurn));
  console.log(`   resumed at turn ${lastTurn}; playing up to ${remaining} more turns\n`);
  const more = await runMatch(server, runDir, seats, { turnLimit: remaining, live: true }, (line) => console.log(line));
  outcomes = mergeOutcomes(outcomes, more);
}

if (outcomes.gameCrashed) {
  console.log(
    `\nthe game exited and could not be recovered automatically.\n` +
      `every turn was autosaved, so the run can continue by hand:\n` +
      `  npm start -- --config ${path} --resume civbench-<runName>-t<turn>\n`,
  );
}

spectator?.kill();

const report = renderReport(outcomes, runDir);
writeFileSync(join(runDir, "report.txt"), report + "\n");
console.log("\n" + report);
writeFileSync(join(runDir, "replay.html"), renderReplayPage(collectRun(runDir), `CivBench — ${runId}`));
console.log(`\nreplay: ${join(runDir, "replay.html")}`);
await closeBridge();
