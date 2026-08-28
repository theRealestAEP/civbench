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
/**
 * Argument keys whose operation wants a table ROW INDEX, not a hash.
 *
 * Civ is not consistent about this. CITYOPERATION_BUILD wants `.Hash`; CHANGE_GOVERNMENT and
 * CHANGE_TRADITION want `$index`. Resolving everything to a hash meant
 * `civ do player-op CHANGE_TRADITION TraditionType=TRADITION_X` returned ok and did nothing —
 * canStart accepted the number and the game changed no policy.
 */
const INDEX_ARGS = {
  TraditionType: "Traditions",
  GovernmentType: "Governments",
  // CITYOPERATION_BUILD wants $index for these two (production-chooser-operations.ts). The raw
  // `civ do` path resolved them to .Hash, which canStart ACCEPTED and the engine ignored — the
  // "ok, and nothing happened" class. UnitType genuinely wants the hash and stays out.
  // ProgressionTreeNodeType is ambiguous by key alone (hash for tech/civic, $index for
  // attributes), so it stays with the purpose-built `civ tech/civic/attribute` commands.
  ConstructibleType: "Constructibles",
  ProjectType: "Projects",
};

function resolveTypeArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value !== "string" || !/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(value)) {
      out[key] = value;
      continue;
    }
    const table = INDEX_ARGS[key];
    if (table) {
      let index = null;
      try {
        for (const row of GameInfo[table] ?? []) {
          if (row[key] === value) { index = row.$index; break; }
        }
      } catch { index = null; }
      out[key] = index === null ? value : index;
      continue;
    }
    let hash = null;
    try { hash = GameInfo.Types.lookup(value)?.Hash ?? null; } catch { hash = null; }
    out[key] = hash === null ? value : hash;
  }
  return out;
}

/**
 * Call the engine and report why it said no. Always canStart() first, so a rejection carries the
 * engine's own FailureReasons rather than being a silent no-op. Shared by act.js and build.js —
 * the last time a rule like this lived in more than one file, the copies drifted.
 */
/**
 * A GameInfo table as a plain array.
 *
 * NO GameInfo table is an array and none has .map — they are iterable and nothing else. Three
 * places called .map on one anyway. `civ government` threw on every call, so no agent could ever
 * see the list of governments, let alone pick one; actions.js threw while building the legal
 * action list. Both failed as a game-side exception with no hint that a table was the cause.
 */
function tableRows(table) {
  const out = [];
  try { for (const row of table ?? []) out.push(row); } catch { return out; }
  return out;
}

/**
 * What the engine says about the thing an action was refused for.
 *
 * A refusal with no FailureReasons is unanswerable on its own. A unit that is already fortified,
 * or has no moves, or is not in the ready queue, explains most of them — and every one of those
 * is a fact the engine will state plainly if asked.
 */
/**
 * Activities that mean a unit has ALREADY been given orders.
 *
 * AWAKE and NONE are not among them — an awake unit is precisely the one still waiting for
 * orders. Treating every non-NONE activity as "already ordered" told an agent
 * "this unit already has standing orders (AWAKE), so it cannot be given them again" about the
 * one unit the game was actively demanding it command. It is hard to imagine worse advice.
 */
const STANDING_ORDERS = new Set([
  "SLEEP", "FORTIFY", "ALERT", "HOLD", "SKIP", "HEAL", "AUTOMATE", "SENTRY", "GUARD",
  // A unit part-way through a multi-turn operation. It refuses everything until it finishes, and
  // an agent that cannot tell that from a broken command retries it every turn for the rest of
  // the match — 136 refusals across 8 units in one 26-turn run.
  "OPERATION",
]);

/**
 * Wrap an x coordinate around the map's east-west seam. Civ maps wrap horizontally, so a
 * neighbourhood scan near x=0 must look at the far edge too — `if (x < 0) continue` silently
 * blinded every such scan to half its neighbours.
 */
function wrapX(x) {
  try {
    const w = GameplayMap.getGridWidth();
    return ((x % w) + w) % w;
  } catch { return x; }
}

/**
 * Operations that exist in the engine's catalogue but have no button in the game's UI — script
 * plumbing, not gameplay. A human cannot invoke them, so offering them to an agent is a trap:
 * one agent ran EXECUTE_SCRIPT on every idle unit every turn for 17 turns because it once
 * appeared to work.
 */
const ENGINE_INTERNAL_OPS = /EXECUTE_SCRIPT|CREATE_ELEMENT|SCRIPT_DYNAMIC|DYNAMIC_PROPERTY/;

/** The adjacent plot holding a discovery, as "x,y", or null. */
function discoveryNear(id) {
  try {
    const unit = Units.get(id);
    const at = unit?.location;
    if (!at) return null;
    // A box of ±2, not ±1. Civ's grid is HEX with odd-row offset, so a tile's six neighbours are
    // not the eight cells around it in x/y — on an odd row two of them sit at dx=+1,dy=±1 and on
    // an even row at dx=-1. A ±1 box missed the discovery every time and fell through to the
    // "go and grep for it" branch, which is what the agent was already stuck on.
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const x = wrapX(at.x + dx);
        const y = at.y + dy;
        if (y < 0) continue;
        for (const cid of MapConstructibles.getHiddenFilteredConstructibles(x, y) ?? []) {
          const instance = Constructibles.getByComponentID(cid);
          const info = instance ? GameInfo.Constructibles.lookup(instance.type) : null;
          if (info?.Discovery) return `${x},${y}`;
        }
      }
    }
    return null;
  } catch { return null; }
}

function subjectState(id) {
  try {
    const unit = Units.get(id);
    if (!unit) return null;
    const activity = typeof UnitActivityTypes !== "undefined"
      ? Object.keys(UnitActivityTypes).find((k) => UnitActivityTypes[k] === unit.activityType) ?? null
      : null;
    // The two fields that explain most bare refusals. A unit with a queued operation refuses
    // SKIP_TURN while moves/canMove/activity all look fine — the live run where two warriors
    // were unskippable for 17 turns showed exactly this state, and the refusal never said so.
    const pending = unit.hasPendingOperations === true;
    let queued = null;
    try { queued = unit.operationQueueSize ?? null; } catch { queued = null; }
    return {
      moves: unit.Movement?.movementMovesRemaining ?? null,
      hasMoved: unit.hasMoved ?? null,
      canMove: unit.canMove ?? null,
      // The usual answer: a unit with standing orders cannot be given the same order again.
      activity,
      busy: pending || activity === "OPERATION",
      queued_operations: queued,
    };
  } catch { return null; }
}

function startOperation(api, id, type, rawArgs) {
  // An operation this build does not define reads as `undefined`, and canStart happily accepts
  // it: the agent gets `ok`, the engine does nothing, and nothing anywhere says why. That is how
  // `civ tradition` reported twelve successful adoptions while the player held no traditions.
  // Which operations exist varies by Civ version and DLC, so this is a real case, not a guard
  // against the impossible.
  if (type === undefined || type === null) {
    return {
      ok: false,
      code: "NO_SUCH_OPERATION",
      message: "this version of Civilization does not define that operation",
    };
  }
  const args = resolveTypeArgs(rawArgs);
  let check;
  try { check = api.canStart(id, type, args, false); }
  catch (err) { return { ok: false, code: "CANSTART_THREW", message: String(err) }; }
  if (!check?.Success) {
    const why = (check?.FailureReasons ?? [])
      .map((id) => { try { return Locale.compose(id); } catch { return id; } })
      .join("; ");
    // A bare refusal carries no FailureReasons, and guessing the cause is worse than admitting we
    // do not know it. But "the game refused this action and gave no reason" is what an agent saw
    // 43 times in ten turns, and it is not something anyone can act on: one wrote "maybe it's a
    // small technical hiccup that will clear up on its own" and moved on.
    //
    // So state the facts we CAN read off the subject. These are observations, not diagnoses — the
    // engine still will not say why, and we do not pretend to know.
    // Say what we can actually see. "The game refused this action and gave no reason" was the
    // answer 43 times in ten turns, and it is unanswerable: one agent concluded "maybe it's a
    // small technical hiccup that will clear up on its own". Most of those were a unit that had
    // already finished its turn — a fact the engine states plainly if asked.
    const state = subjectState(id);
    let reason = why;
    // The engine's own words, where they need translating into an action. "There is a Discovery
    // nearby!" is a real FailureReason and a dead end on its own: it refuses the skip, names no
    // plot, and an agent that cannot see discoveries has nowhere to go with it.
    if (reason && /Discovery nearby/i.test(reason)) {
      // Name the plot. "There is a Discovery nearby!" is the engine's whole answer, and pointing
      // at a grep was still work: it was the commonest remaining failure in a clean run, five
      // times in seven turns, because an agent cannot skip the unit and is not told where to go.
      const plot = discoveryNear(id);
      reason += plot
        ? ` — the game refuses to skip or automate a unit standing next to one. Move it onto ${plot} to collect it.`
        : " — the game refuses to skip or automate a unit standing next to one. `grep discovery= /current/tiles.txt` finds them.";
    }
    let finished = false;
    if (!reason && state) {
      if (state.canMove === false || state.moves === 0) {
        reason = "this unit has no moves left — it is finished for this turn";
        finished = true;
      } else if (state.busy) {
        // The commonest unexplained refusal in live runs: a queued or in-flight operation. Such a
        // unit refuses new orders, and it does NOT hold your turn open — leave it alone, or
        // cancel what it is doing.
        reason =
          `this unit is busy with an operation it has not finished` +
          (state.queued_operations ? ` (${state.queued_operations} queued)` : "") +
          ` — it will refuse new orders and it does not block your turn`;
        finished = true;
      } else if (STANDING_ORDERS.has(state.activity)) {
        reason = `this unit already has standing orders (${state.activity}), so it cannot be given them again`;
        finished = true;
      }
    }
    if (state) state.finished = finished;
    return {
      ok: false,
      code: "ILLEGAL_ACTION",
      message: reason || "the game refused this action and gave no reason",
      state,
      hint: state?.busy
        ? "leave it alone, or cancel its current operation: `civ do unit-cmd " +
          String(id?.id ?? id) + " UNITCOMMAND_CANCEL`"
        : "run `civ what-can` — it lists what is legal now, and why the rest is not",
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
    if (!id) {
      // No notification to hang it on, but the TYPE hash still has a readable name — getTypeName
      // takes a Type hash. Showing the raw number matched no answer table and read as noise.
      let name = null;
      try { name = Game.Notifications.getTypeName(type) ?? null; } catch { name = null; }
      return { id: null, name: name ?? String(type) };
    }
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
