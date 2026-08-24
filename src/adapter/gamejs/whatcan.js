// Runs inside Civ 7. Legal actions for one unit, right now (docs/PLAN.md §10).
//
// We do not hand-maintain a list of supported actions. The game ships a complete, self
// describing catalogue in GameInfo.UnitOperations / UnitCommands, and canStart() is the
// engine's own validator. Enumerating them means new DLC actions appear automatically, and
// coverage gaps cannot silently handicap an agent (§7).
//
// canStart returns { Success, FailureReasons } where FailureReasons are localisation ids, so
// a rejection carries the same words a human would read.
const unit = findOwnUnit(Number(UNIT_OWNER), UNIT_ID);
if (!unit) return { error: "no such unit" };

const args = TARGET ? { X: TARGET.x, Y: TARGET.y } : {};

const reasons = (result) => {
  const ids = result?.FailureReasons ?? [];
  return ids.map((id) => { try { return Locale.compose(id); } catch { return id; } });
};

const legal = [];
const illegal = [];

const consider = (kind, api, typeName) => {
  let result;
  try { result = api.canStart(unit.id, operationValue(kind, typeName), args, false); } catch (err) { return; }
  const entry = { kind, type: typeName, short: shortName(typeName) };
  if (result?.Success) legal.push(entry);
  else illegal.push({ ...entry, reasons: reasons(result) });
};

for (const op of GameInfo.UnitOperations ?? []) {
  consider("unit_operation", Game.UnitOperations, op.OperationType);
}
for (const cmd of GameInfo.UnitCommands ?? []) {
  consider("unit_command", Game.UnitCommands, cmd.CommandType);
}

return {
  unit: String(unit.id?.id ?? unit.id),
  type: shortName(typeName("Units", unit.type)),
  at: unit.location ? { x: unit.location.x, y: unit.location.y } : null,
  movesRemaining: unit.Movement?.movementMovesRemaining ?? null,
  target: TARGET ?? null,
  legal,
  illegal,
};
