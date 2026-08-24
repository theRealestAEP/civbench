// Shared helpers prepended to every gamejs script by src/adapter/game.ts.
//
// The live API returns numeric hashes for terrain, features, resources, and unit types. Nothing
// downstream should ever see a raw hash, so we resolve them here, inside the game, using the
// same GameInfo tables the UI uses. Lookups are memoised per evaluation because a full map scan
// asks the same question thousands of times.
const __nameCache = new Map();
function typeName(tableName, hash) {
  if (hash === null || hash === undefined || hash === -1) return null;
  const key = tableName + ":" + hash;
  if (__nameCache.has(key)) return __nameCache.get(key);
  let value = null;
  try {
    const row = GameInfo[tableName]?.lookup?.(hash);
    if (row) value = row[tableName.replace(/s$/, "") + "Type"] ?? row.Type ?? null;
  } catch { value = null; }
  __nameCache.set(key, value);
  return value;
}
/** Strip the loud Civ prefix: TERRAIN_GRASSLAND -> grassland, UNIT_SCOUT -> scout. */
function shortName(value) {
  if (typeof value !== "string") return value;
  return value.replace(/^[A-Z]+_/, "").toLowerCase();
}

/** Resolve a LOC_* key to display text. Named locText because the game context
 * already defines a global `loc`, which shadowed ours and produced a confusing
 * "loc is not a function" at runtime. */
function locText(value) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("LOC_")) return value;
  try { return Locale.compose(value); } catch { return value; }
}
/** The engine uses -1 and 0 as "none" sentinels for ids. Never pass those on. */
function idOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value.id ?? value);
  return s === "-1" || s === "0" ? null : s;
}

/**
 * Civ addresses units and settlements by ComponentID: { owner, id, type }. The dump only carries
 * the numeric `id`, because that is what reads well in a text file. Resolve it by scanning the
 * player's own list rather than hard-coding the `type` constant — that keeps us honest about
 * ownership too, since an agent can only ever name something it owns.
 */
function findOwnUnit(playerId, numericId) {
  const player = Players.get(playerId);
  for (const cid of player?.Units?.getUnitIds?.() ?? []) {
    if (Number(cid.id) === Number(numericId)) return Units.get(cid);
  }
  return null;
}
function findOwnCity(playerId, numericId) {
  const player = Players.get(playerId);
  for (const cid of player?.Cities?.getCityIds?.() ?? []) {
    if (Number(cid.id) === Number(numericId)) return Cities.get(cid);
  }
  return null;
}

/**
 * Civ identifies operations by a hashed integer. Only the GameInfo tables carry the readable
 * string; the enums hold the hash, so `CityOperationTypes.BUILD` is 739199558 and
 * `PlayerOperationTypes.SET_TECH_TREE_NODE` is 759655162.
 *
 * Agents must only ever see and type the NAME. This is the single place that maps one to the
 * other — showing a hash once had an agent implement CRC32 to invert it.
 */
const OPERATION_ENUMS = {
  unit_operation: ["UnitOperationTypes", "UNITOPERATION_"],
  unit_command: ["UnitCommandTypes", "UNITCOMMAND_"],
  city_operation: ["CityOperationTypes", "CITYOPERATION_"],
  city_command: ["CityCommandTypes", "CITYCOMMAND_"],
  player_operation: ["PlayerOperationTypes", ""],
};

/** Name -> whatever the engine accepts. Unknown names pass through so the engine can answer. */
function operationValue(kind, name) {
  const spec = OPERATION_ENUMS[kind];
  if (!spec) return name;
  const table = globalThis[spec[0]];
  if (!table) return name;
  if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
  const bare = spec[1] && name.startsWith(spec[1]) ? name.slice(spec[1].length) : name;
  if (Object.prototype.hasOwnProperty.call(table, bare)) return table[bare];
  return name;
}

/** Every readable name for a kind, qualified so it is unambiguous to type. */
function operationNames(kind) {
  const spec = OPERATION_ENUMS[kind];
  if (!spec) return [];
  const table = globalThis[spec[0]];
  if (!table) return [];
  const out = [];
  for (const key of Object.keys(table)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    const value = table[key];
    if (typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value)) out.push(value);
    else out.push(spec[1] && !key.startsWith(spec[1]) ? spec[1] + key : key);
  }
  return out;
}

/**
 * The same problem as operationValue, one level down. CITYOPERATION_BUILD wants
 * { UnitType | ConstructibleType | ProjectType: <hashed int> } — the key depends on what the
 * thing IS, and the value is a hash. An agent that typed the right key with a readable name
 * got a bare refusal, so it guessed argument names 25 times in one turn.
 *
 * GameInfo.Types is the one table that knows both: Kind tells us the key, Hash the value.
 */
const BUILD_ARG_KEY = {
  KIND_UNIT: "UnitType",
  KIND_CONSTRUCTIBLE: "ConstructibleType",
  KIND_PROJECT: "ProjectType",
};

/** "UNIT_WARRIOR" -> { key: "UnitType", value: -373982416 }, or null if the game has no such type. */
function buildArgFor(name) {
  let row;
  try { row = GameInfo.Types.lookup(name); } catch { return null; }
  if (!row) return null;
  const key = BUILD_ARG_KEY[row.Kind];
  return key ? { key, value: row.Hash } : null;
}

/**
 * Let agents write names wherever the engine wants a hashed type.
 *
 * This is not only about building. Research wants { ProgressionTreeNodeType: <hash> }, and every
 * other type argument in Civ works the same way. So resolve any value that looks like a Civ type
 * name and that GameInfo.Types actually knows; everything else passes through untouched.
 *
 * The PREFIX_NAME shape is the guard: it keeps plain string arguments such as
 * `Modifiers: "ATTACK"` out of the lookup.
 */
function resolveTypeArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    let resolved = null;
    if (typeof value === "string" && /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(value)) {
      try { resolved = GameInfo.Types.lookup(value)?.Hash ?? null; } catch { resolved = null; }
    }
    out[key] = resolved === null ? value : resolved;
  }
  return out;
}

/**
 * Call the engine and report why it said no. Always canStart() first, so a rejection carries the
 * engine's own FailureReasons rather than being a silent no-op. Shared by act.js and build.js —
 * the last time a rule like this lived in more than one file, the copies drifted.
 */
function startOperation(api, id, type, rawArgs) {
  const args = resolveTypeArgs(rawArgs);
  let check;
  try { check = api.canStart(id, type, args, false); }
  catch (err) { return { ok: false, code: "CANSTART_THREW", message: String(err) }; }
  if (!check?.Success) {
    const why = (check?.FailureReasons ?? [])
      .map((id) => { try { return Locale.compose(id); } catch { return id; } })
      .join("; ");
    // A bare refusal carries no FailureReasons, and guessing the cause is worse than admitting
    // we do not know it. Saying "check the argument names and values" sent an agent into 23
    // consecutive argument guesses for a unit that had simply run out of moves.
    //
    // Point at the engine's own answer instead. `civ what-can` lists what is legal right now and
    // why the rest is not, which is the question the agent is actually asking.
    return {
      ok: false,
      code: "ILLEGAL_ACTION",
      message: why || "the game refused this action and gave no reason",
      hint: "run `civ what-can` — it lists what is legal now, and why the rest is not",
    };
  }
  try { api.sendRequest(id, type, args); }
  catch (err) { return { ok: false, code: "SEND_FAILED", message: String(err) }; }
  return { ok: true };
}

/**
 * The notification blocking a player's end of turn, or null.
 *
 * findEndTurnBlocking() needs the blocking TYPE as a second argument. Called with the player id
 * alone it returns null, so the harness reported "nothing is blocking your turn" while the engine
 * refused to end it — a seat sat active with no visible reason and the round waited forever.
 * The game's own panel-action.ts fetches the type first, exactly like this.
 */
function endTurnBlocker(playerId) {
  try {
    const type = Game.Notifications?.getEndTurnBlockingType?.(playerId);
    const none = typeof EndTurnBlockingTypes !== "undefined" ? EndTurnBlockingTypes.NONE : 0;
    if (type === undefined || type === null || type === none) return null;
    const id = Game.Notifications?.findEndTurnBlocking?.(playerId, type) ?? null;
    if (!id) return { id: null, name: String(type) };
    const notification = Game.Notifications.find(id);
    return { id, name: notification ? (Game.Notifications.getTypeName(notification.Type) ?? String(type)) : String(type) };
  } catch {
    return null;
  }
}
