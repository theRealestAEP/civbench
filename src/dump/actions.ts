// Rendering the per-turn legal-action list (docs/PLAN.md §10).
//
// One line per thing the agent can do, with the command that does it. An agent should never have
// to work out how to phrase an action: it reads the line and runs it.

export type LegalActions = {
  units: Array<{
    id: string;
    type: string | null;
    at: string | null;
    moves: number | null;
    operations: string[];
    commands: string[];
  }>;
  settlements: Array<{ id: string; name: string | null; operations: string[]; commands: string[] }>;
  player: string[];
};

/** The `civ` command for an operation, where one exists. Otherwise the general form. */
function commandFor(scope: "unit" | "city" | "player", id: string, kind: string, name: string): string {
  if (name === "UNITOPERATION_MOVE_TO") return `civ move ${id} <x,y>`;
  if (name === "UNITOPERATION_SKIP_TURN") return `civ skip ${id}`;
  if (name === "CITYOPERATION_BUILD") return `civ build ${id} <THING>`;
  if (name === "CITYCOMMAND_EXPAND") return `civ expand ${id} <x,y>`;
  if (name === "SET_TECH_TREE_NODE") return "civ tech <NODE>";
  if (name === "SET_CULTURE_TREE_NODE") return "civ civic <NODE>";
  if (name === "CHANGE_GOVERNMENT") return "civ government <TYPE>";
  if (name === "CHOOSE_NARRATIVE_STORY_DIRECTION") return "civ story <ANSWER>";
  const form = { unit: kind === "unit_command" ? "unit-cmd" : "unit-op", city: kind === "city_command" ? "city-cmd" : "city-op", player: "player-op" }[scope];
  return scope === "player" ? `civ do ${form} ${name}` : `civ do ${form} ${id} ${name}`;
}

export function actionLines(legal: LegalActions): string[] {
  const out: string[] = [
    "# what you can do right now, straight from the engine",
    "# every line is the command that does it",
    "",
  ];

  for (const unit of legal.units) {
    out.push(`unit ${unit.id} ${unit.type ?? "?"} at=${unit.at ?? "?"} moves=${unit.moves ?? "?"}`);
    for (const name of unit.operations) out.push(`  ${commandFor("unit", unit.id, "unit_operation", name)}`);
    for (const name of unit.commands) out.push(`  ${commandFor("unit", unit.id, "unit_command", name)}`);
    if (unit.operations.length + unit.commands.length === 0) out.push("  (nothing — it has already acted)");
    out.push("");
  }

  for (const city of legal.settlements) {
    out.push(`settlement ${city.id} ${city.name ?? ""}`.trimEnd());
    for (const name of city.operations) out.push(`  ${commandFor("city", city.id, "city_operation", name)}`);
    for (const name of city.commands) out.push(`  ${commandFor("city", city.id, "city_command", name)}`);
    out.push("");
  }

  out.push("your civilization:");
  for (const name of legal.player) out.push(`  ${commandFor("player", "", "player_operation", name)}`);
  if (legal.player.length === 0) out.push("  (nothing)");
  return out;
}
