// Read one agent's log: node tools/agent-log.ts [runDir] [agent]
//
// events.jsonl interleaves every seat, which is unreadable while a match runs. This shows one
// agent's story on its own.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2] ?? (() => {
  const runs = readdirSync("runs").map((d) => join("runs", d));
  return runs.sort().at(-1)!;
})();

const agentsDir = join(runDir, "agents");
const agents = existsSync(agentsDir) ? readdirSync(agentsDir) : [];
const wanted = process.argv[3];

if (!wanted) {
  console.log(`run: ${runDir}\nagents: ${agents.join(", ") || "(none yet)"}\n`);
  console.log("usage: node tools/agent-log.ts [runDir] <agent>");
  console.log(`  live: tail -f ${join(agentsDir, agents[0] ?? "<agent>", "log.txt")}`);
  process.exit(0);
}

const path = join(agentsDir, wanted, "log.txt");
if (existsSync(path)) {
  process.stdout.write(readFileSync(path, "utf8"));
} else {
  // A match started before per-agent logs existed still has events.jsonl, which carries the same
  // information interleaved. Render this seat's share of it.
  const events = join(runDir, "events.jsonl");
  if (!existsSync(events)) {
    console.error(`no log and no events for "${wanted}". Agents: ${agents.join(", ")}`);
    process.exit(1);
  }
  for (const line of readFileSync(events, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Record<string, any>;
    if (e.playerName !== wanted) continue;
    const req = e.request ?? {};
    const res = e.result ?? {};
    let what: string;
    switch (e.kind) {
      case "turn_begin": what = `--- turn begins (${e.pending ?? 0} pending) ---`; break;
      case "action": what = res.ok
        ? `did   ${req.actionType}${req.targetId ? ` on ${req.targetId}` : ""}`
        : `FAILED ${req.actionType} -> ${res.code}: ${res.message ?? ""}`; break;
      case "message": what = `said to ${e.to ?? "everyone"}: ${JSON.stringify(e.text)}`; break;
      case "turn_end": what = "--- turn ends ---"; break;
      case "turn_end_forced": what = "--- turn ENDED FOR IT ---"; break;
      case "brain_error": what = `ERROR ${String(e.message ?? "").slice(0, 160)}`; break;
      default: what = e.kind;
    }
    console.log(`${String(e.at).slice(11, 19)}  t${e.turn}  ${what}`);
  }
}
