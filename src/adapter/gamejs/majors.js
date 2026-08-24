// Runs inside Civ 7. How many major civilizations are actually in this match?
//
// Not a parity concern: a human sees the player count on the setup screen. It is here because the
// harness must report the truth — `filler_ai: none` was ignored for a while and matches quietly
// ran three built-in AI civs alongside the agents.
let majors = 0;
for (const player of Players.getAlive() ?? []) {
  if (player?.isMajor ?? true) majors++;
}
return { majors };
