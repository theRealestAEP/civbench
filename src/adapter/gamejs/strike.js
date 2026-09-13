// Runs inside Civ 7. What a unit could hit with a ranged attack right now.
//
// The game's ranged-attack mode (interface-mode-ranged-attack.ts) asks canStart(RANGE_ATTACK)
// with no target and reads the Plots the engine hands back. `civ attack` does the same, so a
// slinger's attack goes out as a RANGE_ATTACK on a plot the engine will take, instead of as a
// melee move — half of all ranged attacks in one run were refused with no reason.
const unit = findOwnUnit(PLAYER_ID, UNIT_ID);
if (!unit) return { ranged: false, canStrikeNow: false, plots: [], error: `no unit ${UNIT_ID}` };
let check = null;
try { check = Game.UnitOperations.canStart(unit.id, UnitOperationTypes.RANGE_ATTACK, {}, false); }
catch { check = null; }
let rangedStrength = 0;
try { rangedStrength = unit.Combat?.rangedStrength ?? 0; } catch { rangedStrength = 0; }
const none = typeof OperationPlotModifiers !== "undefined" ? OperationPlotModifiers.NONE : null;
const all = check?.Plots ?? [];
const mods = check?.Modifiers ?? [];
const plots = [];
all.forEach((index, i) => {
  // The Modifiers array says what is in each plot; NONE is a plot in range with nothing to hit.
  if (none !== null && mods.length === all.length && mods[i] === none) return;
  const at = GameplayMap.getLocationFromIndex(index);
  if (!at) return;
  let what = null;
  try {
    const ids = MapUnits.getUnits?.(at.x, at.y) ?? [];
    const first = ids.length > 0 ? Units.get(ids[0]) : null;
    if (first) what = `${typeName("Units", first.type) ?? "unit"} of p${first.owner}`;
  } catch { what = null; }
  plots.push({ at: `${at.x},${at.y}`, what });
});
// Whether it can also fight hand to hand. A galley reads as "ranged" here — the engine answers
// the RANGE_ATTACK query for naval units — yet its real attack is a melee move onto the enemy;
// `civ attack` refused that as OUT_OF_RANGE in eight turns while combat-preview said "melee,
// possible". A unit that can melee falls back to the move when the plot is not a ranged target.
let melee = false;
try { melee = unit.Combat?.canAttack === true && (unit.Combat.getMeleeStrength?.(false) ?? 0) > 0; } catch { melee = false; }
return { ranged: rangedStrength > 0 || check?.Success === true, melee, canStrikeNow: check?.Success === true, plots };
