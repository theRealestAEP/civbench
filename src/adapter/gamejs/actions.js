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
const player = Players.get(PLAYER_ID);
const out = { units: [], settlements: [], player: [] };

/** Ask the engine, and keep only what it accepts. */
function legalFor(api, kind, names, id, args) {
  const legal = [];
  for (const name of names) {
    try {
      if (api.canStart(id, operationValue(kind, name), args ?? PROBE_ARGS, false)?.Success === true) {
        legal.push(name);
      }
    } catch { /* an operation that throws is not available; the catalogue below still lists it */ }
  }
  return legal;
}

const unitOperationNames = (GameInfo.UnitOperations ?? []).map((o) => o.OperationType);
const unitCommandNames = (GameInfo.UnitCommands ?? []).map((c) => c.CommandType);

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

return out;
