// Launch Civ 7 with the debug bridge on, and wait until it answers.
//
// The game REWRITES AppOptions.txt when it quits and re-comments UIDebugger back to its default,
// so the setting must be applied immediately before every launch. EnableTuner does persist.
// (Learned the hard way; see docs/FINDINGS.md.)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discover } from "../src/adapter/cdp.ts";
import { findGamePids, gameListeningPorts } from "../src/adapter/discover.ts";

const STEAM_APP_ID = "1295660";
const USER_DIR = join(homedir(), "Library/Application Support/Civilization VII");
const OPTIONS = join(USER_DIR, "AppOptions.txt");

const WANTED: Record<string, string> = { UIDebugger: "1", EnableTuner: "1", FullScreen: "0" };

function applyOptions(): string[] {
  if (!existsSync(OPTIONS)) throw new Error(`no AppOptions.txt at ${OPTIONS}; launch the game once first`);
  const seen = new Set<string>();
  const patched = readFileSync(OPTIONS, "utf8")
    .split("\n")
    .map((line) => {
      const m = /^\s*;?\s*([A-Za-z_]\w*)\s+(-?\w+)\s*$/.exec(line);
      const key = m?.[1];
      if (key && key in WANTED) {
        seen.add(key);
        return `${key} ${WANTED[key]}`;
      }
      return line;
    });
  for (const [k, v] of Object.entries(WANTED)) if (!seen.has(k)) patched.push(`${k} ${v}`);
  writeFileSync(OPTIONS, patched.join("\n"));
  return Object.keys(WANTED);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForBridge(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await discover([...new Set([...gameListeningPorts(), 9444])], 1);
    if (found.some((f) => f.targets.length > 0)) return true;
    process.stdout.write(".");
    await sleep(5000);
  }
  return false;
}

// A running instance would keep the stale (debugger-less) options, so start from a clean process.
for (const pid of findGamePids()) {
  try {
    process.kill(pid, "SIGKILL");
    console.log(`killed existing game (pid ${pid})`);
  } catch { /* already gone */ }
}
if (findGamePids().length > 0) await sleep(3000);

console.log(`options: ${applyOptions().join(", ")} -> ${OPTIONS}`);
execFileSync("open", [`steam://rungameid/${STEAM_APP_ID}`]);
console.log("launched via Steam; waiting for the bridge");

if (await waitForBridge(240_000)) {
  const found = await discover([...new Set([...gameListeningPorts(), 9444])]);
  console.log("\nbridge is up:");
  for (const { port, targets } of found) {
    for (const t of targets) console.log(`  ${port}  ${t.url}`);
  }
} else {
  console.log("\nthe bridge did not answer within 4 minutes.");
  console.log("If this is a fresh install, the game shows a one-time graphics setup screen that");
  console.log("must be dismissed before the main menu (and its CDP context) appears.");
  process.exit(1);
}
