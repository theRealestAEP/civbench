// Runs inside Civ 7. Saves the match so a long run can be resumed (docs/PLAN.md §10, §15 item 10).
//
// This matters more than it sounds: at roughly half a dollar per agent-turn and hours per match,
// a crash three hours into a 50-turn run currently costs the entire run. Autosaving each turn is
// what makes long matches affordable to attempt at all.
//
// `GameStateStorage.getGameConfigurationSaveType()` picks the right SaveTypes value for however
// this match was hosted (single player vs hotseat), which the shipped quick-save uses too.
const type = (() => {
  try { return GameStateStorage.getGameConfigurationSaveType(); }
  catch { return SaveTypes.SINGLE_PLAYER; }
})();

try {
  Network.saveGame({
    Location: SaveLocations.LOCAL_STORAGE,
    LocationCategories: SaveLocationCategories.AUTOSAVE,
    Type: type,
    ContentType: SaveFileTypes.GAME_STATE,
    FileName: SAVE_NAME,
    Overwrite: true,
  });
  return { requested: true, name: SAVE_NAME };
} catch (err) {
  return { requested: false, error: String(err) };
}
