// Runs inside Civ 7's SHELL context. Loads a saved match so a run can be resumed.
//
// Three modes, because loading with FABRICATED metadata broke resume: the old version guessed
// the save Type from getGameConfigurationSaveType() at the main menu (SINGLE_PLAYER), and a
// HOTSEAT autosave loaded under that type came up with ONE human seat — the first live resume
// died on the seat check, and an auto-recovery would have silently handed two agents' civs to
// the game's AI. The game's own save screen loads a save with the metadata the query returned
// for that exact file (model-save-load.ts handleLoadSave); so do we now.
//
//   MODE "query": fire GameStateStorage.querySaveGameList for every save type this build knows.
//   MODE "find":  how many results have arrived, and whether SAVE_NAME is among them.
//   MODE "load":  Network.loadGame with the found entry's own fields, hotseat server type.

// Tutorials off on the resume path too — see newgame.js for why.
try { Configuration.getUser()?.setTutorialLevel?.(0); } catch { /* older build without the setter */ }

if (!globalThis.__civbenchSaves) {
  globalThis.__civbenchSaves = { files: [], queries: 0, answered: 0 };
  try {
    engine.on("FileListQueryResults", (queryId, fileList) => {
      const stash = globalThis.__civbenchSaves;
      stash.answered++;
      for (const file of fileList ?? []) stash.files.push(file);
    });
  } catch { /* without the event, "find" reports zero and the caller says so */ }
}
const stash = globalThis.__civbenchSaves;

/**
 * The stashed entry for SAVE_NAME — or, failing that, the newest hotseat autosave.
 *
 * The fallback is the one that actually fires: the engine IGNORES the name a save request
 * carries and writes autosave-numbered files (AutoSave_00_0031.Civ7Save), so the harness's
 * "civbench-<run>-t<turn>" names never exist on disk. The newest hotseat-typed autosave IS the
 * last turn the harness saved, which is exactly what a resume wants.
 */
function findEntry() {
  const exact = stash.files.find((file) => String(file?.fileName ?? "").includes(SAVE_NAME));
  if (exact) return exact;
  const wantedType = SERVER_TYPE === "hotseat" ? SaveTypes.HOTSEAT : SaveTypes.SINGLE_PLAYER;
  const candidates = stash.files
    .filter((file) => file?.type === wantedType)
    .sort((a, b) => String(b?.fileName ?? "").localeCompare(String(a?.fileName ?? ""), undefined, { numeric: true }));
  return candidates[0] ?? null;
}

if (MODE === "query") {
  stash.files = [];
  stash.queries = 0;
  stash.answered = 0;
  // Every save type this build defines. The type of a hotseat autosave is not knowable from the
  // main menu, so ask for all of them and let the file list say.
  const types = [];
  try {
    for (const key of Object.keys(SaveTypes)) {
      const value = SaveTypes[key];
      if (typeof value === "number" && !types.includes(value)) types.push(value);
    }
  } catch { /* fall through */ }
  if (types.length === 0) types.push(SaveTypes.SINGLE_PLAYER);
  for (const type of types) {
    // Autosaves and manual saves live in different categories; ask for both.
    for (const category of [SaveLocationCategories.AUTOSAVE, SaveLocationCategories.NORMAL]) {
      try {
        GameStateStorage.querySaveGameList({
          Location: SaveLocations.LOCAL_STORAGE,
          Type: type,
          LocationOptions: category,
          ContentType: SaveFileTypes.GAME_STATE,
          ForceRefresh: true,
        });
        stash.queries++;
      } catch { /* a type this build cannot query is not in the list */ }
    }
  }
  return { requested: true, queries: stash.queries };
}

if (MODE === "find") {
  return {
    answered: stash.answered,
    queries: stash.queries,
    total: stash.files.length,
    found: findEntry() !== null,
  };
}

// MODE "load"
const entry = findEntry();
if (!entry) {
  return {
    requested: false,
    error: `save "${SAVE_NAME}" is not in the list (${stash.files.length} saves seen)`,
  };
}
try {
  Network.loadGame(
    {
      Location: entry.location,
      LocationCategories: entry.locationCategories,
      Type: entry.type,
      ContentType: entry.contentType,
      FileName: entry.fileName,
      DisplayName: entry.displayName,
      Slot: entry.slot,
      AdditionalInfo: entry.additionalInfo,
    },
    SERVER_TYPE === "hotseat" ? ServerType.SERVER_TYPE_HOTSEAT : ServerType.SERVER_TYPE_NONE,
  );
  return { requested: true, name: String(entry.fileName), type: entry.type };
} catch (err) {
  return { requested: false, error: String(err) };
}
