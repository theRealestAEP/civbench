// Runs inside Civ 7. Centres the camera on this player's holdings, so the view follows whichever
// agent is currently taking its turn.
const player = Players.get(PLAYER_ID);
if (!player) return { moved: false };

// Prefer the capital, then any settlement, then any unit — whatever this seat actually has.
let target = null;
for (const id of player.Cities?.getCityIds?.() ?? []) {
  const city = Cities.get(id);
  if (city?.location) { target = city.location; if (city.isCapital) break; }
}
if (!target) {
  for (const id of player.Units?.getUnitIds?.() ?? []) {
    const unit = Units.get(id);
    if (unit?.location) { target = unit.location; break; }
  }
}
if (!target) return { moved: false };

try {
  Camera.lookAtPlot(target.x, target.y);
  return { moved: true, x: target.x, y: target.y };
} catch (err) {
  return { moved: false, error: String(err) };
}
