// Runs inside Civ 7's SHELL context, after hosting a hotseat game.
//
// hostGame(SERVER_TYPE_HOTSEAT) does not start the match — it opens the multiplayer staging room
// and waits. The game's own staging model (model-mp-staging-new.ts) readies the local player and
// then calls Network.startGame() as host. We do the same.
const before = {
  isHotseat: Configuration.getGame().isHotseat,
  humans: Configuration.getGame().humanPlayerCount,
  gameStarted: Configuration.getGame().isGameStarted,
};

// Mark every seat ready. In hotseat all seats are local, so readiness is ours to give.
let readied = 0;
try {
  for (const id of Configuration.getGame().humanPlayerIDs) {
    const cfg = Configuration.editPlayer(id);
    if (cfg?.setModReady) cfg.setModReady(true);
    readied++;
  }
} catch (err) { /* not all builds expose this */ }

try {
  if (Network.toggleLocalPlayerStartReady) Network.toggleLocalPlayerStartReady();
} catch (err) { /* best effort */ }

let started = false;
let error = null;
try {
  Network.startGame();
  started = true;
} catch (err) {
  error = String(err);
}

return { before, readied, started, error };
