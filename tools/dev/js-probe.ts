// What can the sandbox's `js` runtime actually do? Agents keep fighting the shell instead.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameAdapter } from "../../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../../src/test-support/fake-game.ts";
import { MatchServer } from "../../src/server/match.ts";
import { createAgentSandbox } from "../../src/agent/sandbox.ts";

const runDir = mkdtempSync(join(tmpdir(), "js-"));
const cfg = { slot: 0, playerId: 0, name: "p", actionsPerTurn: 50, secondsPerTurn: 60 };
const server = new MatchServer(new GameAdapter(new FakeBridge(makeWorld())), runDir, [cfg]);
const hud = await server.beginTurn(0);
const notes = join(runDir, "n"); mkdirSync(notes, { recursive: true });
const s = createAgentSandbox(server, 0, notes, () => hud);

const cases: Array<[string, string]> = [
  ["js -e inline", `js -e 'console.log(1+2)'`],
  ["js reads a file", `js -e 'const fs=require("fs");console.log(fs.readFileSync("/current/units.txt","utf8").length)'`],
  ["js loop + filter", `js -e 'const fs=require("fs");const t=fs.readFileSync("/current/tiles.txt","utf8").split("\\n").filter(Boolean);let n=0;for(const l of t){if(l.includes("vis=visible"))n++}console.log("visible",n)'`],
  ["write then run a script", `echo 'console.log("from a file")' > /notes/s.js && js /notes/s.js`],
  ["js writes output", `js -e 'require("fs").writeFileSync("/notes/out.txt","hello")' && cat /notes/out.txt`],
];
for (const [label, cmd] of cases) {
  const r = await s.exec(cmd);
  const out = (r.stdout || r.stderr).replace(/\n/g, " ").slice(0, 60);
  console.log(`${r.exitCode === 0 ? "ok  " : "FAIL"}  ${label.padEnd(24)} ${out}`);
}
