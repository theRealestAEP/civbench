// Runs inside Civ 7. The player's treasury, so a purchase can be checked against it.
let gold = null;
try { gold = Players.get(PLAYER_ID)?.Treasury?.goldBalance ?? null; } catch { gold = null; }
return { gold };
