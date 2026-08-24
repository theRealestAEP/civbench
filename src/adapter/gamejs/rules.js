// Runs inside Civ 7. Exports a static gameplay table from GameInfo.
//
// Two jobs (docs/PLAN.md §7):
//   1. Name resolution — the live game returns numeric hashes for terrain, units, and buildings.
//      Nothing downstream should ever show an agent a raw hash.
//   2. The agent's rules/ directory. A human plays with the Civilopedia open, so full ruleset
//      access is parity. Exporting from the game's own database keeps it true to the installed
//      build and DLC, which matters because memorised Civ 7 rules are thin and often stale.
const table = GameInfo[TABLE_NAME];
if (!table) return null;

const rows = [];
for (const row of table) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    const t = typeof v;
    if (v === null || t === "string" || t === "number" || t === "boolean") out[k] = v;
    else if (t === "bigint") out[k] = Number(v);
  }
  // Resolve the display name where the row has one, so rules/ reads like the Civilopedia.
  if (typeof row.Name === "string") {
    try { out.DisplayName = Locale.compose(row.Name); } catch { /* key may not resolve */ }
  }
  if (typeof row.Description === "string") {
    try { out.DisplayDescription = Locale.compose(row.Description); } catch { /* ignore */ }
  }
  rows.push(out);
}
return { table: TABLE_NAME, count: rows.length, rows };
