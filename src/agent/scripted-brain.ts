// The scripted baseline (docs/PLAN.md §13).
//
// Deterministic, free to run, and it never calls a model. Two jobs:
//   1. An ELO anchor. Without a floor, model ratings mean nothing.
//   2. A harness test. It exercises the same sandbox, the same civ command, and the same turn
//      loop a real agent uses, so a broken harness fails here first and cheaply.
//
// Its policy is deliberately shallow — settle where it stands, otherwise take the first legal
// action from a fixed preference order, otherwise skip. It is a floor, not an opponent. What it
// must NOT do is guess: it asks the engine what is legal, exactly as an agent should.
import type { Brain, TurnContext, TurnReport } from "./brain.ts";

/** Tried in order. The first legal one wins. */
const PREFERENCE = ["found_city", "skip_turn", "wait_for"];

export class ScriptedBrain implements Brain {
  readonly name = "scripted-baseline";

  async playTurn({ exec, turn }: TurnContext): Promise<TurnReport> {
    let commands = 0;
    const run = async (command: string) => {
      commands++;
      return exec(command);
    };

    const units = await run("cat /current/units.jsonl");
    // SAFETY: units.jsonl is written by this harness's own dump writer, one unit per line.
    const own = units.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { id: string; movesRemaining?: number | null })
      // Only our own units carry movement detail; enemy sightings do not.
      .filter((u) => u.movesRemaining !== undefined);

    let acted = 0;
    for (const unit of own) {
      const legal = await run(`civ what-can ${unit.id}`);
      const choice = PREFERENCE.find((action) => legal.stdout.includes(`  ${action}  `));
      if (!choice) continue;
      const result = await run(
        choice === "skip_turn" ? `civ skip ${unit.id}` : `civ do unit-op ${unit.id} UNITOPERATION_${choice.toUpperCase()}`,
      );
      if (result.exitCode === 0) acted++;
    }

    await run(`echo 'turn ${turn}: acted on ${acted}/${own.length} units' >> /notes/notes.md`);
    await run("civ end-turn");
    return { commands, notes: `acted on ${acted}/${own.length} units` };
  }
}
