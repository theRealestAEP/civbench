// The run report (docs/PLAN.md §13).
//
// Hygiene sits beside the result, always. An agent that "won" with 200 auto-passes did not win,
// and a report that hides that is worse than no report.
import type { SeatOutcome } from "./run.ts";
import { scoreRun } from "../score/metrics.ts";

export function renderReport(outcomes: SeatOutcome[], runDir: string): string {
  // Game actions and their refusals come from the event log via scoreRun, so the two columns
  // share one denominator. "bash" (model tool calls) and "illegal" (refused game actions) used
  // to sit side by side as "cmds"/"illegal", and a seat could show more illegal than cmds —
  // one bash call carries many `civ` commands.
  const metricsByName = new Map(scoreRun(runDir).map((m) => [m.name, m]));
  const rows = outcomes.map((o) => {
    const m = metricsByName.get(o.name);
    const clean = o.timeouts === 0 && o.forcedEndTurns === 0;
    return [
      o.name,
      String(o.turnsPlayed),
      String(o.commands),
      String(m?.hygiene.actions ?? "?"),
      String(m?.hygiene.illegalActions ?? o.illegalActions),
      String(o.timeouts),
      String(o.forcedEndTurns),
      clean ? "clean" : "degraded",
      `${o.inputTokens}/${o.outputTokens}`,
    ];
  });

  const header = ["agent", "turns", "bash", "actions", "illegal", "timeouts", "forced", "status", "tok in/out"];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");

  const lines = [fmt(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(fmt)];

  const degraded = outcomes.filter((o) => o.timeouts > 0 || o.forcedEndTurns > 0);
  if (degraded.length > 0) {
    lines.push(
      "",
      `WARNING: ${degraded.length} seat(s) did not play cleanly. These results are not admissible`,
      "as benchmark data without saying so.",
    );
  }
  // Admissibility decides whether this match may touch the leaderboard at all (§13).
  const metrics = [...metricsByName.values()];
  if (metrics.length > 0) {
    lines.push("", "admissibility");
    for (const m of metrics) {
      lines.push(
        m.admissible
          ? `  ${m.name}: admissible  (illegal-action rate ${(m.hygiene.illegalRate * 100).toFixed(1)}%, ${m.hygiene.blockedTurns} blocked turns)`
          : `  ${m.name}: NOT admissible — ${m.inadmissibleBecause.join("; ")}`,
      );
    }
    const checkpoints = metrics[0]?.ageCheckpoints ?? [];
    if (checkpoints.length > 0) {
      lines.push("", "age checkpoints (the game's own scoring moments)");
      for (const m of metrics) {
        for (const c of m.ageCheckpoints) {
          const legacy = Object.entries(c.legacy).map(([k, v]) => `${k} ${v}`).join("  ") || "none";
          lines.push(`  ${m.name} @ ${c.age} (t${c.lastTurn}): ${legacy}`);
        }
      }
    }
  }

  lines.push("", `events: ${runDir}/events.jsonl`);
  return lines.join("\n");
}
