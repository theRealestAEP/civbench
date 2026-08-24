// Extract the original TypeScript sources Firaxis shipped inside the Civ 7 JS source maps.
// 1207 of 1419 .js.map files embed sourcesContent. That is the game's whole UI layer in TS,
// and it is our reference for both the API surface and the parity contract (see docs/PLAN.md §7).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const GAME_BASE =
  process.env.CIV7_BASE ??
  "/Users/alexpickett/Library/Application Support/Steam/steamapps/common/Sid Meier's Civilization VII/CivilizationVII.app/Contents/Resources/Base";
const OUT = resolve("reference/game-src");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".js.map")) yield p;
  }
}

let written = 0;
let skipped = 0;
for (const mapPath of walk(GAME_BASE)) {
  let map;
  try {
    map = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch {
    skipped++;
    continue;
  }
  const sources = map.sources ?? [];
  const contents = map.sourcesContent ?? [];
  for (let i = 0; i < sources.length; i++) {
    const content = contents[i];
    if (!content) continue;
    // sources are relative paths like ../../../../modules/core/ui/foo.ts
    const rel = sources[i].replace(/^(\.\.\/)+/, "");
    const dest = join(OUT, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    written++;
  }
}
console.log(`wrote ${written} source files to ${OUT} (${skipped} unreadable maps)`);
