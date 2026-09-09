// Firaxis hotseat-curtain.tsx onStartTurn removes this exact curtain. Its unmount
// resumes the display queue. Leave gameplay popups for the active agent to answer.
let removed = 0;
for (const el of document.querySelectorAll("#hotseat-screen-curtain, hotseat-curtain")) {
  el.remove();
  removed++;
}
return { removed, clicked: 0, confirmed: 0, turn: Game.turn, localPlayer: GameContext.localPlayerID };
