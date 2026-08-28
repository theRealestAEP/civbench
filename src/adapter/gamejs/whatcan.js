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

// Dedupe the sweep by WORLD STATE, never by wall clock. This asks canStart for ~200
// operations, and an end-turn refusal loop fires it every second or two — a probe storm that
// preceded all four identical engine SIGSEGVs (AsyncWorker1, same stack) by seconds. SEQ is the
// server's count of this player's applied mutations: same turn + same SEQ means nothing has
// changed, so the last answer is CORRECT, not merely recent. A time-based cache here served
// stale legality after a real move — the exact told-something-untrue class this harness exists
// to prevent. No SEQ (an older server) means no caching at all.
const cacheKey = typeof SEQ === "undefined" ? null
  : `${UNIT_OWNER}:${UNIT_ID}:${Game.turn}:${SEQ}:${JSON.stringify(TARGET ?? null)}`;
if (!globalThis.__civbenchWhatCan) globalThis.__civbenchWhatCan = { key: null, result: null };
const stash = globalThis.__civbenchWhatCan;
if (cacheKey !== null && stash.key === cacheKey && stash.result) {
  return stash.result;
}

// A named target asks "can I do this THERE"; no target asks "is this possible at all", which the
// engine answers correctly only for an invalid plot. See PROBE_ARGS in _prelude.js.
const args = TARGET ? { X: TARGET.x, Y: TARGET.y, UnitAbilityType: -1 } : PROBE_ARGS;

const reasons = (result) => {
  const ids = result?.FailureReasons ?? [];
  return ids.map((id) => { try { return Locale.compose(id); } catch { return id; } });
};

const legal = [];
const illegal = [];

const consider = (kind, api, typeName) => {
  // Engine internals with no UI button. A human is never offered these; listing them here is how
  // one agent came to run EXECUTE_SCRIPT on every idle unit every turn.
  if (ENGINE_INTERNAL_OPS.test(typeName)) return;
  let result;
  try { result = api.canStart(unit.id, operationValue(kind, typeName), args, false); } catch (err) { return; }
  const entry = { kind, type: typeName, short: shortName(typeName) };
  // `why` is what the CLI prints. It used to ship these as `reasons`, which the renderer never
  // read — so "unavailable: (none)" was the answer every hint pointed agents at.
  if (result?.Success) legal.push(entry);
  else illegal.push({ ...entry, why: reasons(result).join("; ") || null });
};

for (const op of GameInfo.UnitOperations ?? []) {
  consider("unit_operation", Game.UnitOperations, op.OperationType);
}
for (const cmd of GameInfo.UnitCommands ?? []) {
  consider("unit_command", Game.UnitCommands, cmd.CommandType);
}

const answer = {
  unit: String(unit.id?.id ?? unit.id),
  type: shortName(typeName("Units", unit.type)),
  at: unit.location ? { x: unit.location.x, y: unit.location.y } : null,
  movesRemaining: unit.Movement?.movementMovesRemaining ?? null,
  // A busy unit refuses everything with no FailureReasons, which is otherwise invisible here.
  busy: unit.hasPendingOperations === true,
  target: TARGET ?? null,
  legal,
  illegal,
};
if (cacheKey !== null) {
  stash.key = cacheKey;
  stash.result = answer;
}
return answer;
