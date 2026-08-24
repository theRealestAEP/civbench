// Runs inside Civ 7's GAMEPLAY context. Clears the hotseat handoff screen.
//
// Hotseat does not simply switch players between turns. It puts up a full-screen handoff panel —
// "Xerxes, the Achaemenid / PLAYER 1" with SAVE GAME and START TURN — and the next player's turn
// does NOT begin until START TURN is pressed. With agents playing there is nobody to press it, so
// the match stops dead and looks like a hung menu.
//
// So the harness presses it. This is the agent equivalent of picking the machine up, and without
// it hotseat cannot run unattended at all (docs/PLAN.md §4).
let clicked = 0;
let removed = 0;

// The panel is built from fxs-button divs whose text is the label.
for (const el of document.querySelectorAll(".fxs-button, fxs-button, button")) {
  const label = (el.textContent || "").trim().toLowerCase();
  // "Start Turn" begins the next seat's turn. Never touch "Save Game".
  if (label === "start turn" || label === "begin turn" || label === "continue") {
    try {
      el.click();
      clicked++;
    } catch (err) { /* not clickable this frame */ }
  }
}

// The curtain sits behind the panel and hides the board even after the click.
for (const el of document.querySelectorAll("#hotseat-screen-curtain, hotseat-curtain")) {
  el.remove();
  removed++;
}

return { clicked, removed, turn: Game.turn, localPlayer: GameContext.localPlayerID };
