// Try one setup and report whether the match actually loads.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listTargets, CdpBridge } from "../../src/adapter/cdp.ts";
import { GameAdapter } from "../../src/adapter/game.ts";
import { findGamePids } from "../../src/adapter/discover.ts";

const LOG = join(homedir(), "Library/Application Support/Civilization VII/Logs/AppStateLoadGame.log");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const pid of findGamePids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
await sleep(8000);
execFileSync("open", ["steam://rungameid/1295660"]);

async function shell() {
  for (let i = 0; i < 60; i++) {
    try {
      const t = (await listTargets(9444, 4000)).find((x) => x.url.includes("root-shell"));
      if (t) return t;
    } catch { /* busy */ }
    await sleep(3000);
  }
  throw new Error("no shell context");
}

const SETUP = {
  humanSlots: 3,
  players: {},
  start: true,
  singleAge: true,
  gameSpeed: "GAMESPEED_QUICK",
  maxTurns: 40,
  seed: 8891234,
};

const target = await shell();
const bridge = await CdpBridge.connect(target.webSocketDebuggerUrl);
const before = readFileSync(LOG, "utf8").length;
const result = await new GameAdapter(bridge).run<{ summary?: unknown }>("newgame", 0, { SETUP });
console.log("configured:", JSON.stringify(result.summary));
await bridge.close();

await sleep(15_000);
const tail = readFileSync(LOG, "utf8").slice(before);
console.log(tail.includes("LOADSTATE_EARLYEXIT") ? "RESULT: FAIL (early exit)" : "RESULT: loading ok");
