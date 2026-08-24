// Score a finished run: node tools/score.ts runs/<runId>
import { scoreRun } from "../src/score/metrics.ts";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node tools/score.ts <runDir>");
  process.exit(1);
}
for (const m of scoreRun(runDir)) {
  console.log(`\n== ${m.name} ==`);
  console.log(`  admissible: ${m.admissible ? "yes" : `no — ${m.inadmissibleBecause.join("; ")}`}`);
  const h = m.hygiene;
  console.log(
    `  hygiene: ${h.turns} turns, ${h.actions} actions, ${h.illegalActions} illegal ` +
      `(${(h.illegalRate * 100).toFixed(1)}%), ${h.refusedActions} refused, ${h.forcedEndTurns} forced`,
  );
  for (const c of m.ageCheckpoints) {
    const legacy = Object.entries(c.legacy).map(([k, v]) => `${k} ${v}`).join("  ") || "none";
    console.log(`  ${c.age} through t${c.lastTurn}: ${legacy}`);
  }
  const first = m.trajectory[0];
  const last = m.trajectory.at(-1);
  if (first && last) {
    console.log(`  trajectory: t${first.turn} gold ${first.gold} -> t${last.turn} gold ${last.gold}`);
  }
}
