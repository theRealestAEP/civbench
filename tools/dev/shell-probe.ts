// Which common shell idioms actually work in the sandbox? Agents assume a Unix shell.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameAdapter } from "../../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../../src/test-support/fake-game.ts";
import { MatchServer } from "../../src/server/match.ts";
import { createAgentSandbox } from "../../src/agent/sandbox.ts";

const runDir = mkdtempSync(join(tmpdir(), "probe-"));
const cfg = { slot: 0, playerId: 0, name: "probe", actionsPerTurn: 50, secondsPerTurn: 60 };
const server = new MatchServer(new GameAdapter(new FakeBridge(makeWorld())), runDir, [cfg]);
const hud = await server.beginTurn(0);
const notes = join(runDir, "n"); mkdirSync(notes, { recursive: true });
writeFileSync(join(notes, "notes.md"), "seed\n");
const s = createAgentSandbox(server, 0, notes, () => hud);

const cases = [
  "grep -E 'tile|unit' /current/units.txt",
  "grep -i TILE /current/tiles.txt",
  "grep -A2 tile /current/tiles.txt",
  "grep -r tile /current",
  "cat /current/*.txt",
  "ls /current/*.txt",
  "printf '%s\\n' hello",
  "find /current -name '*.txt'",
  "head -c 50 /current/tiles.txt",
  "grep -c . /run/rules/operations.txt",
  "head -3 /current/tiles.txt",
  "head -n 3 /current/tiles.txt",
  "cat /current/nope.txt 2>/dev/null",
  "echo hi > /dev/null",
  "grep -c tile /current/tiles.txt",
  "wc -l < /current/tiles.txt",
  "cut -d' ' -f2 /current/tiles.txt | head -n 2",
  "tail -n 2 /current/tiles.txt",
  "sort /current/tiles.txt | uniq | wc -l",
  "cat /current/tiles.txt | jq -R . | head -n 1",
  "ls /current | tr '\\n' ' '",
  "test -f /notes/notes.md && echo yes",
  "for f in a b; do echo $f; done",
  "echo $((1+2))",
];
for (const c of cases) {
  const r = await s.exec(c);
  const out = (r.stdout || r.stderr).replace(/\n/g, " ").slice(0, 58);
  console.log(`${r.exitCode === 0 ? "ok  " : "FAIL"}  ${c.padEnd(42)} ${out}`);
}
