// Runs inside Civ 7. The full operation catalogue for a settlement or a player.
//
// Agents were guessing action names — FOO, SET_PRODUCTION, CHOOSE_TECH — because `civ what-can`
// only ever covered units. The game ships complete catalogues in GameInfo; not exposing them is
// exactly the §7 handicap: it measures our adapter, not the model.
const reasons = (result) => (result?.FailureReasons ?? []).map((id) => {
  try { return Locale.compose(id); } catch { return id; }
});

const legal = [];
const illegal = [];

// The agent only ever sees the name; operationValue turns it into what the engine wants.
const consider = (kind, api, name, id, args) => {
  let result;
  try { result = api.canStart(id, operationValue(kind, name), args, false); } catch (err) { return; }
  const entry = { kind, type: name, short: shortName(name) };
  if (result?.Success) legal.push(entry);
  else illegal.push({ ...entry, reasons: reasons(result) });
};

if (KIND === "city") {
  const city = findOwnCity(PLAYER_ID, TARGET_ID);
  if (!city) return { error: `settlement ${TARGET_ID} not found for p${PLAYER_ID}` };
  // GameInfo has no CityOperations table; the names live in the enum (docs/FINDINGS.md).
  for (const name of operationNames("city_operation")) {
    consider("city_operation", Game.CityOperations, name, city.id, {});
  }
  for (const name of operationNames("city_command")) {
    consider("city_command", Game.CityCommands, name, city.id, {});
  }
  return {
    settlement: String(city.id?.id ?? city.id),
    name: locText(city.name ?? null),
    kind: city.isTown ? "town" : "city",
    legal,
    illegal,
  };
}

if (KIND === "player") {
  for (const name of operationNames("player_operation")) {
    consider("player_operation", Game.PlayerOperations, name, PLAYER_ID, {});
  }
  return { player: PLAYER_ID, legal, illegal };
}

return { error: `unknown catalogue kind: ${KIND}` };
