// Runs inside Civ 7. Everything this player can legally do RIGHT NOW, in one pass.
//
// The agent already had /run/rules/operations.txt: 229 lines, written once at match start,
// alphabetical, listing UNITOPERATION_AIR_ATTACK in a Bronze Age match. It said what could ever
// exist, never what is possible now, and carried no arguments. Across every run so far 36% of all
// actions were refused, and the commonest refusal carried no reason at all — because the engine
// gives none for a wrong argument. Agents had nowhere to look, so they guessed.
//
// This is the answer to "what can I do", asked of the engine itself, once a turn, for free.
// canStart() IS the validator the game uses, so this cannot drift from the truth.
// Deduped by WORLD STATE, like whatcan.js and for the same reason: this sweep is canStart ×
// every operation × every unit — ~1,400 probes for a modest empire — and it re-ran on every
// post-action refresh, inside the window of all four identical engine SIGSEGVs. SEQ is the
// server's count of this player's applied mutations: same turn + same SEQ, same world, same
// answer. Never time-based — a wall-clock cache here served a stale actions.txt after a real
// move, and the consistency test caught it. No SEQ (an older server) means no caching.
const actionsKey = typeof SEQ === "undefined" ? null : `${PLAYER_ID}:${Game.turn}:${SEQ}`;
if (!globalThis.__civbenchActions) globalThis.__civbenchActions = { key: null, result: null };
const actionsStash = globalThis.__civbenchActions;
if (actionsKey !== null && actionsStash.key === actionsKey && actionsStash.result) {
  return actionsStash.result;
}

const player = Players.get(PLAYER_ID);
const out = { units: [], settlements: [], player: [] };

/**
 * Operations the `civ` layer executes with EMPTY args. These must be probed with `{}` too:
 * canStart answers differently for `{}` and for PROBE_ARGS, so probing them with PROBE_ARGS
 * listed `civ skip <id>` as ready-to-run for units whose skip the engine then refused with no
 * reason. Mirrors NO_ARGUMENT_OPS + SKIP_TURN in src/dump/actions.ts — keep the two in step.
 */
const EMPTY_ARG_OPS =
  /^(UNITOPERATION_(SKIP_TURN|FOUND_CITY|SLEEP|FORTIFY|ALERT|WAIT_FOR|HEAL|REST_UNTIL_HEALED|AUTOMATE_EXPLORE)|UNITCOMMAND_(WAKE|CANCEL))$/;

/** Ask the engine, and keep only what it accepts. */
function legalFor(api, kind, names, id, args) {
  const legal = [];
  for (const name of names) {
    // Engine internals with no UI button: a human is never offered them, so neither is an agent.
    if (ENGINE_INTERNAL_OPS.test(name)) continue;
    const probe = args ?? (EMPTY_ARG_OPS.test(name) ? {} : PROBE_ARGS);
    try {
      if (api.canStart(id, operationValue(kind, name), probe, false)?.Success === true) {
        legal.push(name);
      }
    } catch { /* an operation that throws is not available; the catalogue below still lists it */ }
  }
  return legal;
}

const unitOperationNames = tableRows(GameInfo.UnitOperations).map((o) => o.OperationType);
const unitCommandNames = tableRows(GameInfo.UnitCommands).map((c) => c.CommandType);

for (const cid of player?.Units?.getUnitIds?.() ?? []) {
  const unit = Units.get(cid);
  if (!unit) continue;
  out.units.push({
    id: String(cid.id ?? cid),
    type: shortName(typeName("Units", unit.type)),
    at: unit.location ? `${unit.location.x},${unit.location.y}` : null,
    moves: unit.Movement?.movementMovesRemaining ?? null,
    operations: legalFor(Game.UnitOperations, "unit_operation", unitOperationNames, unit.id),
    commands: legalFor(Game.UnitCommands, "unit_command", unitCommandNames, unit.id),
  });
}

const cityOperationNames = operationNames("city_operation");
const cityCommandNames = operationNames("city_command");

for (const cid of player?.Cities?.getCityIds?.() ?? []) {
  const city = Cities.get(cid);
  if (!city) continue;
  out.settlements.push({
    id: String(cid.id ?? cid),
    name: locText(city.name ?? null),
    operations: legalFor(Game.CityOperations, "city_operation", cityOperationNames, city.id),
    commands: legalFor(Game.CityCommands, "city_command", cityCommandNames, city.id),
  });
}

out.player = legalFor(Game.PlayerOperations, "player_operation", operationNames("player_operation"), PLAYER_ID);

if (actionsKey !== null) {
  actionsStash.key = actionsKey;
  actionsStash.result = out;
}
return out;
