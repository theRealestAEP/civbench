// Runs inside Civ 7's GAMEPLAY context. Removes the hotseat handoff curtain.
//
// Hotseat drops a full-screen "pass the device" curtain between every player's turn, plus a
// confirmation popup. With agents playing there is no device to pass, and the curtain makes the
// match unwatchable: the board is hidden for most of the game while it looks like a hung menu.
//
// mp-ingame-mgr.ts builds it as <hotseat-curtain id="hotseat-screen-curtain">, so removing that
// element is enough. Purely cosmetic — it touches no game state.
let removed = 0;

for (const el of document.querySelectorAll("#hotseat-screen-curtain, hotseat-curtain")) {
  el.remove();
  removed++;
}

// The curtain ships with a "continue" confirmation. Dismiss it the way a player would.
let confirmed = 0;
for (const el of document.querySelectorAll(".fxs-popups button, .fxs-popups fxs-button")) {
  const label = (el.textContent || "").trim().toLowerCase();
  if (/continue|ok|begin|start/.test(label)) {
    try { el.click(); confirmed++; } catch (err) { /* not clickable */ }
  }
}

return { removed, confirmed };
