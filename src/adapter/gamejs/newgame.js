// Runs inside Civ 7's SHELL context (root-shell.html). Configures and starts a match
// (docs/PLAN.md §5, §15 item 7).
//
// This mirrors Firaxis' own automation harness (automation-test-support.ts), which is the only
// documented path to a reproducible match: set the configuration, mark the slots we want as
// human, then host. Doing it through the UI would be unrepeatable and unscriptable.
//
// Expects: SETUP = { mapScript, mapSize, seed, startAge, maxTurns, humanSlots, players }
// Tutorials OFF, before anything else. TutorialLevel 4 (the install default) runs the FTUE
// flow: an advisor-selection popup the agents cannot see — it is a UI screen, not an engine
// notification — plus advisor-warning notifications that blocked a whole live turn. A benchmark
// player plays with the assists off; 0 is the options screen's own "no tutorials" value.
try { Configuration.getUser()?.setTutorialLevel?.(0); } catch { /* older build without the setter */ }

const game = Configuration.editGame();
const map = Configuration.editMap();
if (!game || !map) return { ok: false, error: "configuration is not editable here" };

// NOTE: do NOT call game.reset(). It clears the enabled content modules while TypeTags still
// reference them, so the gameplay database fails validation ("BUILDING_MONUMENT does not exist
// in Types") and the load early-exits back to the main menu. Build on the shell's own default
// configuration instead. (Diagnosed from Database.log; see docs/FINDINGS.md.)

if (SETUP.mapScript) map.setScript(SETUP.mapScript);
if (SETUP.mapSize) map.setMapSize(SETUP.mapSize);
if (SETUP.seed !== null && SETUP.seed !== undefined) {
  map.setMapSeed(SETUP.seed);
  game.setGameSeed(SETUP.seed);
}
if (SETUP.startAge) game.setStartAgeType(SETUP.startAge);
if (SETUP.difficulty) game.setDifficultyType(SETUP.difficulty);
if (SETUP.gameSpeed) game.setGameSpeedType(SETUP.gameSpeed);
if (SETUP.maxTurns) game.setMaxTurns(SETUP.maxTurns);
// A single-age game ends in a victory instead of transitioning, which is what makes a short
// military match possible at all (Civ VII has no per-victory toggle — see docs/FINDINGS.md).
if (SETUP.singleAge === true && game.setSingleAge) game.setSingleAge(true);

// Claim the slots our agents will drive. A slot left as SS_COMPUTER is played by the built-in
// AI; SS_TAKEN is a human seat, which is what an agent needs (§4).
const wanted = SETUP.humanSlots ?? 1;
let needed = wanted - Configuration.getGame().humanPlayerCount;
const claim = (ids) => {
  for (const id of ids) {
    if (needed <= 0) break;
    Configuration.editPlayer(id)?.setSlotStatus(SlotStatus.SS_TAKEN);
    needed--;
  }
};
claim(Configuration.getGame().availablePlayerIDs);
claim(Configuration.getGame().aiPlayerIDs);

// Any leftover human slots become AI, so an over-provisioned config cannot hang on a screen
// waiting for a player who does not exist.
if (needed < 0) {
  const humans = Configuration.getGame().humanPlayerIDs;
  for (let i = wanted; i < humans.length; i++) {
    Configuration.editPlayer(humans[i])?.setSlotStatus(SlotStatus.SS_COMPUTER);
  }
}

// Close the leftover AI slots when the config asks for no filler.
//
// `filler_ai: none` was parsed and validated and then never applied, so every match so far ran
// 3 agents against 3 built-in AI civs — the benchmark was measuring agents against Firaxis' AI
// without saying so. SS_CLOSED is the game's own "remove player", used by its advanced options
// panel. Keep at least two majors, since a one-civ game has nothing to play against.
if (SETUP.fillerAi === "none") {
  const keep = new Set(Configuration.getGame().humanPlayerIDs.slice(0, wanted));
  for (const id of Configuration.getGame().aiPlayerIDs ?? []) {
    if (keep.has(id)) continue;
    if (keep.size + (Configuration.getGame().aiPlayerCount ?? 0) <= 2) break;
    Configuration.editPlayer(id)?.setSlotStatus(SlotStatus.SS_CLOSED);
  }
}

// Leaving a seat without a civ or leader sends the game to a selection screen.
for (const [slot, spec] of Object.entries(SETUP.players ?? {})) {
  const cfg = Configuration.editPlayer(Number(slot));
  if (!cfg) continue;
  if (spec.civ) cfg.setCivilizationTypeName(spec.civ);
  if (spec.leader) cfg.setLeaderTypeName(spec.leader);
}

const summary = {
  ruleSet: Configuration.getGame().ruleSet,
  mapSize: Configuration.getMap().mapSizeName,
  humanPlayerCount: Configuration.getGame().humanPlayerCount,
  humanPlayerIDs: Configuration.getGame().humanPlayerIDs,
  aiPlayerCount: Configuration.getGame().aiPlayerCount,
  maxMajorPlayers: Configuration.getMap().maxMajorPlayers,
};

if (SETUP.start === false) return { ok: true, started: false, summary };

// Without this the game stops on the leader-select screen waiting for a human to press
// "Begin Game". component-support.ts auto-readies when `skipStartButton || Automation.isActive`,
// and Automation is the flag Firaxis' own tests use. Setting it is what makes an unattended
// match possible at all (§15 item 7).
let automation = false;
try {
  if (typeof Automation !== "undefined" && Automation.setActive) {
    Automation.setActive(true);
    automation = Automation.isActive === true || Automation.isActive?.() === true;
  }
} catch (err) {
  automation = "error: " + String(err);
}
summary.automationActive = automation;

// SERVER_TYPE_NONE is a local single-player host. Hotseat would be SERVER_TYPE_HOTSEAT.
Network.hostGame(SETUP.serverType === "hotseat"
  ? ServerType.SERVER_TYPE_HOTSEAT
  : ServerType.SERVER_TYPE_NONE);
return { ok: true, started: true, summary };
