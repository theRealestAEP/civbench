// Start a match in the running game: node tools/new-game.ts [--humans N] [--dry]
import { discover, CdpBridge } from "../src/adapter/cdp.ts";
import { GameAdapter } from "../src/adapter/game.ts";
import { gameListeningPorts } from "../src/adapter/discover.ts";

const humansArg = process.argv.indexOf("--humans");
const humanSlots = humansArg > 0 ? Number(process.argv[humansArg + 1]) : 1;
const dry = process.argv.includes("--dry");

const found = await discover([...new Set([...gameListeningPorts(), 9444])]);
const shell = found.flatMap((f) => f.targets).find((t) => t.url.includes("root-shell"));
if (!shell) {
  console.error("No shell context found. The game must be at the main menu, not in a game.");
  console.error("targets: " + found.flatMap((f) => f.targets).map((t) => t.url).join(", "));
  process.exit(1);
}

const bridge = await CdpBridge.connect(shell.webSocketDebuggerUrl);
const adapter = new GameAdapter(bridge);

const result = await adapter.run<{ ok: boolean; started?: boolean; summary?: unknown; error?: string }>(
  "newgame",
  0,
  {
    SETUP: {
      mapScript: "MAPS_CONTINENTS_PLUS",
      mapSize: "MAPSIZE_TINY",
      seed: 8891234,
      startAge: "AGE_ANTIQUITY",
      maxTurns: 150,
      humanSlots,
      players: {},
      start: !dry,
    },
  },
);
console.log(JSON.stringify(result, null, 2));
await bridge.close();
