// Runs inside Civ 7. Submits "I am done" for an Age TRANSITION, for PLAYER_ID, if the engine will
// accept it — a last resort so a transition can never deadlock the match.
//
// A non-final Age ends by TRANSITIONING into the next: each seat picks a next-age civ and then
// clicks done = SET_AGE_TRANSITION_DATA { Finished: true }. During the transition NO seat is
// isTurnActive, so the run loop is offered no turn and would spin to its round cap waiting for a
// turn that never comes (a 50-minute stall observed live until a human clicked through). The picks
// default the same way a human's would; this just says "done" so the game advances.
//
// Gated on canStart, so outside a transition it does nothing and reports finished:false.
let finished = false;
try {
  const args = { Finished: true };
  const allowed =
    Game.PlayerOperations?.canStart?.(PLAYER_ID, PlayerOperationTypes.SET_AGE_TRANSITION_DATA, args, false)?.Success === true;
  if (allowed) {
    Game.PlayerOperations.sendRequest(PLAYER_ID, PlayerOperationTypes.SET_AGE_TRANSITION_DATA, args);
    finished = true;
  }
} catch {
  finished = false;
}
return { finished };
