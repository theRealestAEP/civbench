// Runs inside Civ 7. Every operation name this build accepts, by category.
//
// The names are readable; the engine wants hashes. _prelude.js owns that mapping — see
// operationNames / operationValue there. GameInfo tables are merged in where they exist, because
// they carry the canonical string for unit operations.
const fromTable = (table, column) => {
  const out = [];
  try {
    for (const row of GameInfo[table] ?? []) {
      if (typeof row[column] === "string" && row[column]) out.push(row[column]);
    }
  } catch { /* table absent in this build */ }
  return out;
};

const merge = (...lists) => [...new Set(lists.flat())].sort();

return {
  unit_operation: merge(fromTable("UnitOperations", "OperationType"), operationNames("unit_operation")),
  unit_command: merge(fromTable("UnitCommands", "CommandType"), operationNames("unit_command")),
  city_operation: merge(operationNames("city_operation")),
  city_command: merge(operationNames("city_command")),
  player_operation: merge(operationNames("player_operation")),
};
