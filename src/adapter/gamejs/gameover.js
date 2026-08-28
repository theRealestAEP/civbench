// Runs inside Civ 7. Is this match decided — a victory claimed, or everyone else dead?
//
// The run loop had no idea. After a domination win the game sat on its victory screen while the
// harness kept waiting for seats that would never be offered a turn again, burning a two-minute
// timeout per round until the round backstop — hours of nothing. getVictories() is the same call
// the game's own victory-manager.ts makes.
const victories = [];
try {
  for (const v of Game.VictoryManager?.getVictories?.() ?? []) {
    let name = null;
    try { name = typeName("Victories", v.victory) ?? null; } catch { name = null; }
    victories.push({ team: v.team ?? null, type: name });
  }
} catch { /* no victory manager in this build; elimination below still answers */ }

let aliveMajors = 0;
try {
  for (const p of Players.getAlive() ?? []) {
    if (p.isMajor ?? true) aliveMajors++;
  }
} catch { aliveMajors = -1; }

return { victories, aliveMajors, turn: Game.turn };
