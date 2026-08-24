// Turns on Civ 7's debug bridge (docs/PLAN.md §3.1, FINDINGS item 1/2).
//
// The game writes its options only after it has run once, so the usual order is:
//   1. launch Civilization VII, reach the main menu, quit
//   2. node tools/enable-debug.ts
//   3. launch again — the bridge is now listening
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPPORT = join(homedir(), "Library/Application Support");

/** Where the Mac build might keep AppOptions.txt. The Windows build uses %LocalAppdata%. */
const CANDIDATES = [
  join(SUPPORT, "Firaxis Games/Sid Meier's Civilization VII"),
  join(SUPPORT, "Sid Meier's Civilization VII"),
  join(SUPPORT, "Civilization VII"),
  join(homedir(), "Documents/My Games/Sid Meier's Civilization VII"),
];

function findUserDir(): string | null {
  for (const dir of CANDIDATES) if (existsSync(dir)) return dir;
  // Fall back to anything Civ-VII-shaped that already exists.
  if (existsSync(SUPPORT)) {
    for (const entry of readdirSync(SUPPORT)) {
      if (/civilization\s*(vii|7)/i.test(entry)) return join(SUPPORT, entry);
    }
  }
  return null;
}

const userDir = findUserDir();
if (!userDir) {
  console.log("Could not find a Civilization VII user directory. Looked in:");
  for (const dir of CANDIDATES) console.log(`  ${dir}`);
  console.log("\nLaunch Civilization VII once (main menu is enough), quit, then re-run this.");
  process.exit(1);
}

console.log(`user directory: ${userDir}`);
const optionsPath = join(userDir, "AppOptions.txt");
mkdirSync(userDir, { recursive: true });

if (!existsSync(optionsPath)) {
  console.log(`No AppOptions.txt in ${userDir}.`);
  console.log("Launch Civilization VII once so it writes its defaults, then re-run this.");
  process.exit(1);
}

const existing = readFileSync(optionsPath, "utf8");
writeFileSync(optionsPath + ".civbench-backup", existing);

/**
 * The file uses `;` for comments and `Key Value` (space separated) for settings. Every option
 * ships commented out at its default, so enabling one means uncommenting it and setting a value.
 *
 * UIDebugger is the Coherent remote debugger — the CDP transport we prefer (§3.1).
 * EnableTuner is the FireTuner fallback. Turning either on disables achievements.
 */
const wanted: Record<string, string> = {
  UIDebugger: "1",
  EnableTuner: "1",
  FullScreen: "0",
};

const seen = new Set<string>();
const patched = existing.split("\n").map((line) => {
  // Match both a live setting and the commented-out default the game ships.
  const m = /^\s*;?\s*([A-Za-z_]\w*)\s+(-?\w+)\s*$/.exec(line);
  const key = m?.[1];
  if (key && key in wanted) {
    seen.add(key);
    return `${key} ${wanted[key]}`;
  }
  return line;
});
for (const [key, value] of Object.entries(wanted)) {
  if (!seen.has(key)) patched.push(`${key} ${value}`);
}

writeFileSync(optionsPath, patched.join("\n"));
console.log(`wrote ${optionsPath}`);
for (const [key, value] of Object.entries(wanted)) {
  console.log(`  ${key} ${value}${seen.has(key) ? "" : "   (appended)"}`);
}
console.log(`  backup: ${optionsPath}.civbench-backup`);
console.log("\nAchievements are disabled while a debugger is on. Nothing else changes.");
console.log("Now launch Civilization VII, start any game, then: npm run probe");
