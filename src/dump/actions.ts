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

/**
 * The `civ` command for an operation.
 *
 * Where a purpose-built command exists it is named, because it knows the argument shape. Where one
 * does not, the general `civ do` form is offered WITH A WARNING, because the arguments are the
 * problem: every operation wants a differently shaped argument, and the engine refuses a wrong one
 * with no reason at all. An agent offered a bare `civ do player-op CHANGE_TRADITION` reasonably
 * concluded it should experiment, and spent its turn doing that.
 */
/**
 * Operations that take NO arguments, so `civ do` runs them exactly as printed.
 *
 * Without this they fell below the "nothing here knows what arguments they take — do not try
 * these" divider, which is where UNITOPERATION_FOUND_CITY ended up: the most important action in
 * the game, filed under do-not-use. One agent lost three consecutive turns to it.
 */
const NO_ARGUMENT_OPS =
  /^(UNITOPERATION_(FOUND_CITY|SLEEP|FORTIFY|ALERT|WAIT_FOR|HEAL|REST_UNTIL_HEALED|AUTOMATE_EXPLORE)|UNITCOMMAND_(WAKE|CANCEL))$/;

/**
 * Engine internals with no UI button — script plumbing a human is never offered. Filtered from
 * every agent-facing listing: one appeared to work once, and an agent ran it on every idle unit
 * every turn for 17 turns. Mirrors ENGINE_INTERNAL_OPS in gamejs/_prelude.js.
 */
export const ENGINE_INTERNAL_OPS = /EXECUTE_SCRIPT|CREATE_ELEMENT|SCRIPT_DYNAMIC|DYNAMIC_PROPERTY/;

const COMMANDS: Array<[RegExp, (id: string) => string]> = [
  [/^UNITOPERATION_MOVE_TO$/, (id) => `civ move ${id} <x,y>`],
  [/^UNITOPERATION_SKIP_TURN$/, (id) => `civ skip ${id}`],
  [/^UNITCOMMAND_PROMOTE$/, (id) => `civ promote ${id}`],
  [/^CITYOPERATION_BUILD$/, (id) => `civ build ${id} <THING>`],
  [/^CITYCOMMAND_EXPAND$/, (id) => `civ expand ${id} <x,y>`],
  [/^SET_TECH_TREE_NODE$/, () => "civ tech <NODE>"],
  [/^SET_CULTURE_TREE_NODE$/, () => "civ civic <NODE>"],
  [/^CHANGE_GOVERNMENT$/, () => "civ government <TYPE>"],
  [/^CHANGE_TRADITION$/, () => "civ tradition <TYPE>"],
  [/^CHOOSE_NARRATIVE_STORY_DIRECTION$/, () => "civ story <ANSWER>"],
  [/^CHOOSE_GOLDEN_AGE$/, () => "civ celebration <TYPE>"],
  [/^FOUND_PANTHEON$/, () => "civ pantheon <BELIEF>"],
  [/^BUY_ATTRIBUTE_TREE_NODE$/, () => "civ attribute <NODE>"],
  [/^SET_AGE_TRANSITION_DATA$/, () => "civ age finish"],
  [/^DECLARE_WAR$|^MAKE_PEACE$|^FORM_ALLIANCE$|DIPLOMATIC_ACTION$/, () => "civ diplomacy <player> <ACTION>"],
];

/** The command for an operation, and whether we actually know how to call it. */
type Offered = { line: string; known: boolean };

function commandFor(scope: "unit" | "city" | "player", id: string, kind: string, name: string): Offered {
  for (const [pattern, build] of COMMANDS) {
    if (pattern.test(name)) return { line: build(id), known: true };
  }
  if (NO_ARGUMENT_OPS.test(name)) {
    const form = kind === "unit_command" ? "unit-cmd" : "unit-op";
    return { line: `civ do ${form} ${id} ${name}`, known: true };
  }
  const form = {
    unit: kind === "unit_command" ? "unit-cmd" : "unit-op",
    city: kind === "city_command" ? "city-cmd" : "city-op",
    player: "player-op",
  }[scope];
  const base = scope === "player" ? `civ do ${form} ${name}` : `civ do ${form} ${id} ${name}`;
  return { line: base, known: false };
}

/**
 * The runnable `civ` command for one of a unit's legal operations. Used by the end-turn hint,
 * which once listed raw short names ("execute_script, move_to, wait_for, delete") — advice an
 * agent could only act on by guessing the `civ do` form, and which recommended internals.
 */
export function unitCommandLine(id: string, kind: string, type: string): string {
  return commandFor("unit", id, kind, type).line;
}

/**
 * `actions.txt` — what the agent can do, in the order it should read it.
 *
 * The unknown-argument operations are LISTED LAST, in their own section, rather than mixed in.
 * They used to sit inline: a settlement's three lines were all "arguments unknown", and the
 * player section opened with twenty of them — CREATE_ELEMENT, EXECUTE_SCRIPT,
 * SCRIPT_DYNAMIC_PROPERTY and the rest, which are engine internals no human ever sees a button
 * for. Presented as a menu, that is a list of traps: every one is refused with no reason, and an
 * agent that works down it spends its turn collecting bare refusals.
 *
 * They stay in the file, because nothing is hidden from an agent that a human could find. They
 * just stop being the first thing it reads.
 */
export function actionLines(legal: LegalActions): string[] {
  const out: string[] = [
    "# what you can do right now, straight from the engine",
    "# every line in this section runs as written; fill in a <x,y> or <THING> where one appears",
    "",
  ];
  const unknown: string[] = [];

  const add = (indent: string, subject: string, result: Offered) => {
    // Engine internals never reach the file at all. The game-side listing already filters them;
    // this is the second layer, so a regression there cannot re-open the trap.
    if (ENGINE_INTERNAL_OPS.test(result.line)) return;
    if (result.known) out.push(`${indent}${result.line}`);
    else unknown.push(`  ${result.line}${subject ? `    # ${subject}` : ""}`);
  };

  for (const unit of legal.units) {
    const header = `unit ${unit.id} ${unit.type ?? "?"} at=${unit.at ?? "?"} moves=${unit.moves ?? "?"}`;
    const before = out.length;
    out.push(header);
    for (const name of unit.operations) add("  ", header, commandFor("unit", unit.id, "unit_operation", name));
    for (const name of unit.commands) add("  ", header, commandFor("unit", unit.id, "unit_command", name));
    if (out.length === before + 1) out.push("  (nothing it can be told to do right now)");
    out.push("");
  }

  for (const city of legal.settlements) {
    const header = `settlement ${city.id} ${city.name ?? ""}`.trimEnd();
    const before = out.length;
    out.push(header);
    for (const name of city.operations) add("  ", header, commandFor("city", city.id, "city_operation", name));
    for (const name of city.commands) add("  ", header, commandFor("city", city.id, "city_command", name));
    if (out.length === before + 1) out.push("  (nothing it can be told to do right now)");
    out.push("");
  }

  // Commands that are always available.
  //
  // The briefing's strongest instruction is "never guess an action name — actions.txt lists
  // everything the engine will accept". This file only ever listed per-unit and per-settlement
  // operations, so `civ say`, `civ diplomacy` and `civ deal` appeared nowhere. Across three runs
  // and 83 turns they were used ZERO times: the agents obeyed the instruction, and the entire
  // social half of the benchmark became invisible.
  //
  // These are not engine operations, so they cannot come from the catalogue. They are listed
  // because they are true.
  out.push(
    "",
    "always available:",
    "  civ say <text>                     say something to every other civilization",
    "  civ say @<seat> <text>             say it to one of them",
    "  civ diplomacy                      who you have met",
    "  civ diplomacy <player> [ACTION]    what you can do to them, or do it",
    "  civ deal items <player>            what either side could put on the table",
    "  civ deal offer <player> <KIND>     put something on it",
    "  civ deal send <player>             send the deal",
    "  civ note <text>                    add a line to your journal",
    "  civ hud                            the situation now, re-read from the game",
  );

  const playerBefore = out.length;
  out.push("", "your civilization:");
  for (const name of legal.player) add("  ", "", commandFor("player", "", "player_operation", name));
  if (out.length === playerBefore + 1) out.push("  (nothing)");

  if (unknown.length > 0) {
    out.push(
      "",
      "# ---------------------------------------------------------------------------",
      "# The engine also accepts the operations below, but nothing here knows what",
      "# arguments they take, and a wrong one is refused with no reason at all.",
      "# Most are engine internals that no human sees a button for. Treat this as a",
      "# record of what exists, not as a list of things to try.",
      "# ---------------------------------------------------------------------------",
      ...unknown,
    );
  }
  return out;
}
