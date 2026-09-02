// Runs inside Civ 7 (gameplay context) during an Age TRANSITION. Finishes the transition for
// PLAYER_ID, and — unlike the first version — makes the required next-age CIVILIZATION pick first.
//
// A non-final Age ends by TRANSITIONING into the next. Each seat must do TWO things: (1) choose its
// next-age civilization, then (2) submit SET_AGE_TRANSITION_DATA { Finished: true }. The first
// version sent only step 2. The engine refuses it (canStart=false) while the seat still owes the
// pick — a blocking NOTIFICATION_CHOOSE_CIVILIZATION — so a real 3-seat match looped on that
// blocker for hours at the Antiquity boundary (see docs/FINDINGS.md, run 77cbb1a9653b-001).
//
// The pick writes the GameSetup parameter "AgeTransitionPlayerCivilization" — the exact value the
// game's own age-transition screen sets (civ-select-model.ts setSelectedCiv, age-transition-
// screen.tsx sendFinishedMakingAgeTransitionChoices). We commit the parameter's own preselected
// default, which is a valid civ the way the screen shows it preselected; only if there is none do
// we fall back to the first domain value. Gated on canStart, so outside a transition it is a no-op.

const FINISH = { Finished: true };
const canFinish = () =>
  Game.PlayerOperations?.canStart?.(PLAYER_ID, PlayerOperationTypes.SET_AGE_TRANSITION_DATA, FINISH, false)?.Success === true;

const diag = { neededPick: false, pickedCiv: null, domainSize: 0, validCount: 0, setOk: false, finished: false, error: null };
try {
  if (!canFinish()) {
    diag.neededPick = true;
    const param = GameSetup.findPlayerParameter(PLAYER_ID, "AgeTransitionPlayerCivilization");
    const values = param?.domain?.possibleValues ?? [];
    diag.domainSize = values.length;
    // Only a value the screen would let a human click. civ-select-model.ts greys out every
    // domain value whose invalidReason is not Valid (a locked or unowned civ, or one this
    // transition does not allow) and refuses to select it, so committing one of those would
    // leave the pick unmade. Prefer the parameter's current value — the screen's own
    // preselection — when it is valid; otherwise the first valid concrete civ, RANDOM last.
    const VALID = typeof GameSetupDomainValueInvalidReason !== "undefined" ? GameSetupDomainValueInvalidReason.Valid : 0;
    const valid = values
      .filter((v) => (v?.invalidReason ?? VALID) === VALID)
      .map((v) => v?.value?.toString() || null)
      .filter((id) => id !== null);
    diag.validCount = valid.length;
    const current = param?.value?.value?.toString() || null;
    const civID =
      (current && valid.includes(current) ? current : null) ??
      valid.find((id) => id !== "RANDOM") ?? valid[0] ?? current;
    if (civID) {
      GameSetup.setPlayerParameterValue(PLAYER_ID, "AgeTransitionPlayerCivilization", civID);
      diag.pickedCiv = civID;
      diag.setOk = true;
    }
  }
} catch (err) {
  diag.error = "pick: " + String(err);
}

try {
  if (canFinish()) {
    Game.PlayerOperations.sendRequest(PLAYER_ID, PlayerOperationTypes.SET_AGE_TRANSITION_DATA, FINISH);
    diag.finished = true;
  }
} catch (err) {
  diag.error = (diag.error ? diag.error + "; " : "") + "finish: " + String(err);
}

return { finished: diag.finished, ...diag };
