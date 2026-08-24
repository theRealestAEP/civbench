// Runs inside Civ 7. Is the simulation up yet? Used while waiting out map generation.
return {
  hasMap: typeof GameplayMap !== "undefined" && typeof Players !== "undefined",
  turn: typeof Game !== "undefined" ? Game.turn : null,
  inGame: typeof UI !== "undefined" && UI.isInGame ? UI.isInGame() : null,
};
