// Which setup option breaks the load?
//
// A failed host returns to the main menu and leaves the shell context alive, so several
// configurations can be tried in one game session instead of relaunching for each.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listTargets, CdpBridge } from "../../src/adapter/cdp.ts";
import { GameAdapter } from "../../src/adapter/game.ts";
import { findGamePids } from "../../src/adapter/discover.ts";

const LOG = join(homedir(), "Library/Application Support/Civilization VII/Logs/AppStateLoadGame.log");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CASES: Array<{ name: string; setup: Record<string, unknown> }> = [
  { name: "baseline (3 seats only)", setup: { humanSlots: 3 } },
  { name: "+ maxTurns", setup: { humanSlots: 3, maxTurns: 40 } },
  { name: "+ seed", setup: { humanSlots: 3, maxTurns: 40, seed: 8891234 } },
  { name: "+ gameSpeed QUICK", setup: { humanSlots: 3, gameSpeed: "GAMESPEED_QUICK" } },
  { name: "+ mapSize TINY", setup: { humanSlots: 3, mapSize: "MAPSIZE_TINY" } },
  { name: "+ startAge MODERN", setup: { humanSlots: 3, startAge: "AGE_MODERN" } },
  { name: "+ singleAge", setup: { humanSlots: 3, singleAge: true } },
];

async function shell() {
  for (let i = 0; i < 40; i++) {
    try {
      const t = (await listTargets(9444, 4000)).find((x) => x.url.includes("root-shell"));
      if (t) return t;
    } catch { /* busy */ }
    await sleep(3000);
  }
  throw new Error("no shell context");
}

if (findGamePids().length === 0) {
  console.log("launching game...");
  execFileSync("open", ["steam://rungameid/1295660"]);
}

for (const testCase of CASES) {
  const target = await shell();
  const bridge = await CdpBridge.connect(target.webSocketDebuggerUrl);
  const before = readFileSync(LOG, "utf8").length;
  await new GameAdapter(bridge).run("newgame", 0, {
    SETUP: { players: {}, start: true, ...testCase.setup },
  });
  await bridge.close();

  // A failure shows up in the load log within a couple of seconds; a success keeps loading.
  await sleep(12_000);
  const tail = readFileSync(LOG, "utf8").slice(before);
  const failed = tail.includes("LOADSTATE_EARLYEXIT");
  console.log(`${failed ? "FAIL" : "ok  "}  ${testCase.name}`);
  if (!failed) {
    console.log("      (this one is loading — stopping here so it does not consume the session)");
    break;
  }
}
