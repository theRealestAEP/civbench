// Runs inside Civ 7. Is it this player's turn yet?
//
// Hotseat hands the seat around: only one player is active at a time, and the local player
// switches as turns complete. A seat must wait for its own turn rather than acting whenever the
// harness feels like it.
const player = Players.get(PLAYER_ID);
return {
  active: player?.isTurnActive === true,
  localPlayer: GameContext.localPlayerID,
  turn: Game.turn,
};
