// Runs inside Civ 7's SHELL context. Loads a saved match so a run can be resumed.

// Tutorials off on the resume path too — see newgame.js for why.
try { Configuration.getUser()?.setTutorialLevel?.(0); } catch { /* older build without the setter */ }
const type = (() => {
  try { return GameStateStorage.getGameConfigurationSaveType(); }
  catch { return SaveTypes.SINGLE_PLAYER; }
})();

try {
  Network.loadGame(
    {
      Location: SaveLocations.LOCAL_STORAGE,
      LocationCategories: SaveLocationCategories.AUTOSAVE,
      Type: type,
      ContentType: SaveFileTypes.GAME_STATE,
      FileName: SAVE_NAME,
    },
    SERVER_TYPE === "hotseat" ? ServerType.SERVER_TYPE_HOTSEAT : ServerType.SERVER_TYPE_NONE,
  );
  return { requested: true, name: SAVE_NAME };
} catch (err) {
  return { requested: false, error: String(err) };
}
