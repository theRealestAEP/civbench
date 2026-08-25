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

/**
 * Everything readable on a game object, as plain named values.
 *
 * The dump used to carry a hand-picked list of fields per entity — and every audit found more
 * that a human sees and an agent did not: no combat strength, no build charges, no promotions, no
 * food-to-grow, no rival yields. Curating the list means the harness decides what matters, which
 * is the agent's job and the thing being measured.
 *
 * So: walk the object and its sub-objects, take every scalar, resolve hashes to names, and write
 * the lot. Fog is enforced by WHICH objects get described and which sub-objects are read — never
 * by quietly dropping a field.
 *
 * Depth 1 by design. Civ's objects hold their detail one level down (`unit.Combat.meleeStrength`),
 * and going deeper walks into the whole game graph.
 */
const DESCRIBE_SKIP = new Set(["constructor", "id", "location", "owner", "type"]);

function readableKeys(object) {
  const keys = [];
  let level = object;
  while (level && level !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(level)) {
      if (DESCRIBE_SKIP.has(key) || keys.includes(key)) continue;
      if (key.startsWith("_")) continue;
      keys.push(key);
    }
    level = Object.getPrototypeOf(level);
  }
  return keys;
}

/** A value worth writing down, with hashes resolved. Returns undefined for anything else. */
function describeValue(value) {
  if (value === null || value === undefined) return undefined;
  const kind = typeof value;
  if (kind === "boolean" || kind === "string") return locText(value);
  if (kind === "number") {
    // -1 is Civ's "none" everywhere. A large int is nearly always a hashed type.
    if (value === -1) return undefined;
    if (Number.isInteger(value) && Math.abs(value) > 100000) {
      const name =
        typeName("Units", value) ?? typeName("Constructibles", value) ?? typeName("Projects", value) ??
        typeName("Resources", value) ?? typeName("ProgressionTreeNodes", value) ?? typeName("Yields", value);
      return name ?? undefined; // an unresolvable hash is worse than nothing: never show it
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map(describeValue).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

/**
 * Describe an object and one level of its sub-objects.
 *
 * `skip` names sub-objects that must not be read — the fog rule, applied structurally.
 */
function describeAll(object, skip = []) {
  const out = {};
  if (!object) return out;
  for (const key of readableKeys(object)) {
    if (skip.includes(key)) continue;
    let value;
    try { value = object[key]; } catch { continue; }
    if (typeof value === "function") continue;

    const direct = describeValue(value);
    if (direct !== undefined) {
      out[key] = direct;
      continue;
    }
    // A sub-object such as Combat, Movement, Experience: flatten it as Combat_meleeStrength.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const inner of readableKeys(value)) {
        let sub;
        try { sub = value[inner]; } catch { continue; }
        if (typeof sub === "function") continue;
        const described = describeValue(sub);
        if (described !== undefined) out[`${key}_${inner}`] = described;
      }
    }
  }
  return out;
}

/**
 * Short, stable names for the fields read every turn.
 *
 * describeAll() returns the game's own names, so a moves count arrives as
 * `Movement_movementMovesRemaining`. Completeness is the point, but so is being able to grep
 * `moves=0` without knowing Civ's internal spelling. Applied once, in the extractor, so the text
 * dump and the JSONL twin share one vocabulary.
 */
const FIELD_ALIAS = {
  Movement_movementMovesRemaining: "movesRemaining",
  Movement_maxMoves: "maxMoves",
  Movement_canMove: "canMove",
  Movement_hasMoved: "hasMoved",
  Health_damage: "damage",
  Health_maxDamage: "maxDamage",
  Experience_experiencePoints: "experience",
  Experience_experienceToNextLevel: "experienceToNextLevel",
  Combat_meleeStrength: "melee",
  Combat_rangedStrength: "ranged",
  Combat_bombardStrength: "bombard",
  Combat_attackRange: "attackRange",
  isCommanderUnit: "isCommander",
};

function withAliases(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) out[FIELD_ALIAS[key] ?? key] = value;
  return out;
}

/**
 * The arguments the game itself uses when asking "is this action possible at all?".
 *
 * From unit-actions.ts, with its own comment: "ask for canStart on an invalid plot - GameCore
 * gives the correct answers then." An invalid plot makes the engine answer about the ACTION
 * rather than about one particular target square.
 *
 * We probed with `{}`, which asks a different question, so the legal set an agent reads could
 * differ from what a human is offered — and the briefing now tells agents to trust that list.
 */
const PROBE_ARGS = { X: -9999, Y: -9999, UnitAbilityType: -1 };
