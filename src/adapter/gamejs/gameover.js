// Runs inside Civ 7. Reports CIV's OWN victory state — the harness does not decide who won.
//
// getVictories() is the authoritative claimed-victories list (victory-manager.ts:
// `claimedVictories = victoryManager.getVictories()`). If CIV put an entry there, CIV declared that
// victory — including the age-countdown DOMINANCE victory awarded by score, not legacy, when a
// single-age countdown ends (which is why a 0-legacy game can still have a real winner). We report
// every entry faithfully; we never suppress one for looking hollow, and never invent one.
//
// ageOver and aliveMajors are reported too, but ONLY so the run loop knows when to stop waiting for
// turns that will never come. They are not victory claims.
const victories = [];
try {
  for (const v of Game.VictoryManager?.getVictories?.() ?? []) {
    let type = null;
    try { type = GameInfo.Victories?.lookup?.(v.victory)?.VictoryType ?? null; } catch { type = null; }
    // Who is on the winning team, by name, so the record says who — not just "team 1".
    const winners = [];
    try {
      for (const p of Players.getAlive() ?? []) {
        if (p.team === v.team) winners.push(locText(p.civilizationName ?? p.leaderName ?? null));
      }
    } catch { /* leave winners empty; team number still identifies it */ }
    victories.push({ team: v.team ?? null, type, winners });
  }
} catch { /* no victory manager in this build */ }

let ageOver = false;
let isFinalAge = false;
let ageName = null;
try { ageOver = Game.AgeProgressManager?.isAgeOver ?? false; } catch { ageOver = false; }
// A non-final age ending is a TRANSITION into the next age, not the end of the game. Only the final
// age ending (or a single-age game, where the one age IS final) ends the match.
try { isFinalAge = Game.AgeProgressManager?.isFinalAge ?? false; } catch { isFinalAge = false; }
try { ageName = shortName(typeName("Ages", Game.age)) ?? null; } catch { ageName = null; }

let aliveMajors = 0;
try {
  for (const p of Players.getAlive() ?? []) {
    if (p.isMajor ?? true) aliveMajors++;
  }
} catch { aliveMajors = -1; }

return { victories, ageOver, isFinalAge, ageName, aliveMajors, turn: Game.turn };
