// Runs inside Civ 7. What can this settlement build, and what is it waiting on?
//
// canStartQuery returns [{ index, result }] — `index` is a row index into GameInfo.Units /
// Constructibles / Projects, NOT a hash, and there is no .Items wrapper. Reading it wrong printed
// "[object Object]" for every option, so an agent had to recall unit names from memory: it
// guessed UNIT_WARRIOR right and UNIT_SETTLER wrong.
//
// result.Requirements says why something is unavailable. That answers "why can't I build a
// settler yet", which is otherwise invisible.
const city = findOwnCity(PLAYER_ID, TARGET_ID);
if (!city) return { error: `settlement ${TARGET_ID} not found for p${PLAYER_ID}` };

const QUERIES = [
  ["units", "Unit", "Units", "UnitType"],
  ["buildings", "Constructible", "Constructibles", "ConstructibleType"],
  ["projects", "Project", "Projects", "ProjectType"],
];

/** The engine's own words for what a thing is waiting on. */
function blockedBy(result) {
  const req = result?.Requirements;
  const node = req?.NeededProgressionTreeNode;
  if (node) {
    const info = GameInfo.ProgressionTreeNodes.lookup(node);
    if (info) return `needs ${info.ProgressionTreeNodeType ?? locText(info.Name)}`;
  }
  if (req?.NeededPopulation) return `needs population ${req.NeededPopulation}`;
  if (result?.InsufficientFunds) return "not enough gold";
  const reasons = (result?.FailureReasons ?? []).map(locText);
  return reasons.length > 0 ? reasons.join("; ") : "not available yet";
}

const options = {};
for (const [label, queryName, table, nameField] of QUERIES) {
  const queryType = CityQueryType?.[queryName];
  if (queryType === undefined) continue;
  let results;
  try { results = Game.CityOperations.canStartQuery(city.id, CityOperationTypes.BUILD, queryType); }
  catch (err) { options[label] = { error: String(err) }; continue; }

  const ready = [];
  const blocked = [];
  for (const entry of results ?? []) {
    const result = entry?.result;
    // The game hides these two in its own production list, so we do too.
    if (result?.Requirements?.FullFailure || result?.Requirements?.Obsolete) continue;
    const definition = GameInfo[table]?.lookup?.(entry?.index);
    const name = definition?.[nameField];
    if (!name) continue;
    if (result?.Success) {
      ready.push({ name, turns: city.BuildQueue?.getTurnsLeft?.(name) ?? null });
    } else {
      blocked.push({ name, why: blockedBy(result) });
    }
  }
  if (ready.length > 0 || blocked.length > 0) options[label] = { ready, blocked };
}

const current = city.BuildQueue?.currentProductionTypeHash;
return {
  settlement: String(city.id?.id ?? city.id),
  name: locText(city.name ?? null),
  currentlyBuilding:
    typeName("Units", current) ?? typeName("Constructibles", current) ?? typeName("Projects", current),
  turnsLeft: city.BuildQueue?.getTurnsLeft?.() ?? null,
  options,
};
