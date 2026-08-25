// Runs inside Civ 7. What you can do to another civilization, and doing it.
//
// The player-to-player actions share one argument shape:
//   { Player1: <you>, Player2: <them>, Type: DiplomacyActionTypes.DIPLOMACY_ACTION_X }
// but each has its OWN player operation — DECLARE_WAR, FORM_ALLIANCE,
// CLOSE_BORDERS_DIPLOMATIC_ACTION, and so on. Rather than hand-map action to operation and get it
// wrong (the failure that has cost most in this project), ask the engine: try every operation
// that could plausibly carry an action and report the pairs canStart accepts.
//
// UNVERIFIED against a live game. Everything here follows the game's own diplomacy-manager.ts,
// but no match has yet run long enough for two agents to meet.
const me = PLAYER_ID;
const other = Number(OTHER_PLAYER);

/** Operations that take a { Player1, Player2, Type } action. */
function actionOperations() {
  const names = [];
  for (const key of Object.keys(PlayerOperationTypes ?? {})) {
    if (/^(DECLARE_WAR|FORM_ALLIANCE|CANCEL_ALLIANCE)$/.test(key) || /DIPLOMATIC_ACTION$/.test(key)) {
      names.push(key);
    }
  }
  return names;
}

/** Every diplomacy action this build defines, by name. */
function actionTypes() {
  const out = [];
  for (const key of Object.keys(DiplomacyActionTypes ?? {})) {
    if (/^DIPLOMACY_ACTION_/.test(key)) out.push(key);
  }
  return out;
}

if (!Number.isFinite(other)) {
  // No target: who have you met, and are you at war with them?
  const known = [];
  const diplomacy = Players.get(me)?.Diplomacy;
  for (const p of Players.getAlive() ?? []) {
    if (p.id === me || !(p.isMajor ?? true)) continue;
    let met = false;
    try { met = diplomacy?.hasMet?.(p.id) === true; } catch { met = false; }
    if (!met) continue;
    let atWar = false;
    try { atWar = diplomacy?.isAtWarWith?.(p.id) === true; } catch { atWar = false; }
    known.push({ player: `p${p.id}`, civ: locText(p.civilizationName ?? null), atWar });
  }
  return { ok: true, listing: true, players: known };
}

if (!ACTION) {
  // What the engine will actually accept against this player, right now.
  const offers = [];
  for (const operation of actionOperations()) {
    for (const type of actionTypes()) {
      const args = { Player1: me, Player2: other, Type: DiplomacyActionTypes[type] };
      let ok = false;
      try { ok = Game.PlayerOperations.canStart(me, PlayerOperationTypes[operation], args, false)?.Success === true; }
      catch { ok = false; }
      if (ok) offers.push({ operation, action: type });
    }
  }
  return { ok: true, listing: true, target: `p${other}`, offers };
}

// Doing it. The agent names the action; we find the operation that accepts it.
const wanted = String(ACTION).toUpperCase();
const type = DiplomacyActionTypes?.[wanted];
if (type === undefined) {
  return {
    ok: false,
    code: "NO_SUCH_ACTION",
    message: `this game has no diplomacy action named ${ACTION}`,
    hint: `run \`civ diplomacy p${other}\` to see what you can do to them`,
  };
}

const args = { Player1: me, Player2: other, Type: type };
let chosen = null;
for (const operation of actionOperations()) {
  try {
    if (Game.PlayerOperations.canStart(me, PlayerOperationTypes[operation], args, false)?.Success === true) {
      chosen = operation;
      break;
    }
  } catch { /* try the next */ }
}
if (!chosen) {
  return {
    ok: false,
    code: "ILLEGAL_ACTION",
    message: `the game will not let you ${ACTION} against p${other} right now`,
    hint: `run \`civ diplomacy p${other}\` to see what it will allow`,
  };
}

const result = startOperation(Game.PlayerOperations, me, PlayerOperationTypes[chosen], args);
if (result.ok) result.note = `${ACTION} sent to p${other} via ${chosen}`;
return result;
