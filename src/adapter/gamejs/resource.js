// Runs inside Civ 7. Assign a new resource to a settlement (docs/PLAN.md §7).
//
// NOTIFICATION_ASSIGN_NEW_RESOURCES blocks the end of a turn until each new resource is placed in a
// settlement for its bonus. ASSIGN_RESOURCE takes { Location, City } — the resource's PLOT (from
// its .value index) and the settlement's numeric id — exactly as model-resource-allocation.ts
// sends it. It takes NO Action field for an assign; Action:Deactivate is only for the UNASSIGN path.
//
// The listing says which resources are still unplaced and how many slots each settlement has
// free, the way the game's own allocation screen does. Without that, 558 of 678 assignments in
// one run were refused for a full slot the agent could not see, and the prompt blocked 87 turns.
const player = Players.get(PLAYER_ID);

/** Plot indices of every resource already sitting in one of the player's settlements. */
function assignedEverywhere() {
  const set = new Set();
  try {
    for (const cid of player?.Cities?.getCityIds?.() ?? []) {
      const city = Cities.get(cid);
      for (const r of city?.Resources?.getAssignedResources?.() ?? []) {
        if (r?.value !== undefined && r?.value !== null) set.add(r.value);
      }
    }
  } catch { /* no settlements */ }
  return set;
}

/** The player's resources as { name, index, assigned }, where index is the resource's plot index. */
function ownResources() {
  const out = [];
  const placed = assignedEverywhere();
  try {
    for (const r of player?.Resources?.getResources?.() ?? []) {
      const index = r?.value;
      if (index === undefined || index === null) continue;
      out.push({
        name: typeName("Resources", r?.uniqueResource?.resource) ?? String(index),
        index,
        hash: r?.uniqueResource?.resource ?? null,
        assigned: placed.has(index),
      });
    }
  } catch { /* no resources */ }
  return out;
}

function settlements() {
  const cities = [];
  try {
    for (const cid of player?.Cities?.getCityIds?.() ?? []) {
      const c = Cities.get(cid);
      if (!c) continue;
      let assigned = null; let cap = null;
      try { assigned = c.Resources?.getTotalCountAssignedResources?.() ?? null; } catch { assigned = null; }
      try { cap = c.Resources?.getAssignedResourcesCap?.() ?? null; } catch { cap = null; }
      const free = assigned !== null && cap !== null ? Math.max(0, cap - assigned) : null;
      cities.push({
        name: locText(c.name ?? null) ?? String(cid.id),
        id: String(cid.id),
        cityId: c.id?.id ?? c.id,
        isTown: c.isTown === true,
        assigned, cap, free,
      });
    }
  } catch { /* no settlements */ }
  return cities;
}

/** RESOURCECLASS_CITY -> "city". The class decides where a resource may go. */
function resourceClass(hash) {
  try {
    const row = hash === null ? null : GameInfo.Resources?.lookup?.(hash) ?? null;
    return shortName(row?.ResourceClassType ?? null);
  } catch { return null; }
}

/** The engine's own answer for one resource in one settlement. */
function placement(index, city) {
  const args = { Location: GameplayMap.getLocationFromIndex(index), City: city.cityId };
  let result = null;
  try { result = Game.PlayerOperations?.canStart?.(PLAYER_ID, PlayerOperationTypes.ASSIGN_RESOURCE, args, false) ?? null; }
  catch { result = null; }
  const reasons = (result?.FailureReasons ?? []).map((r) => locText(r)).filter((r) => typeof r === "string" && r.length > 0);
  return { ok: result?.Success === true, reasons, args };
}

/**
 * Where a resource can go, asked of the engine settlement by settlement.
 *
 * The free-slot count is not the rule. A city resource never goes to a town, a settlement never
 * holds the same resource twice, and the engine has reasons of its own — so a listing that said
 * "3 free of 4" sent an agent into five refusals and a search of the rules files, and its turn
 * ran out with the prompt still open. The engine's per-pair answer is the listing.
 */
function takers(index, cities) {
  return cities.filter((c) => placement(index, c).ok).map((c) => c.id);
}

if (MODE === "list") {
  const cities = settlements();
  const resources = ownResources().filter((r) => !r.assigned).map((r) => ({
    ...r,
    class: resourceClass(r.hash),
    canGo: takers(r.index, cities),
  }));
  return { resources, cities };
}

if (MODE === "done") {
  // The game's own screen sends this when it closes; it is the "I have looked" signal that clears
  // the prompt when every slot is full and nothing more can be placed.
  const done = startOperation(Game.PlayerOperations, PLAYER_ID, PlayerOperationTypes.CONSIDER_ASSIGN_RESOURCE, {});
  if (done.ok) done.note = "finished with resources";
  return done;
}

// assign
const wanted = String(RESOURCE ?? "").toUpperCase();
let picked = null;
for (const r of ownResources()) {
  if (String(r.index) === wanted || (r.name && r.name.toUpperCase() === wanted)) {
    picked = r;
    break;
  }
}
if (!picked) {
  return { ok: false, code: "NO_SUCH_THING", message: `you have no resource "${RESOURCE}" to assign — run \`civ resource\` to see them` };
}
if (picked.assigned) {
  return { ok: false, code: "ILLEGAL_ACTION", message: `${picked.name} is already placed in a settlement — \`civ resource\` lists the ones still waiting` };
}

const city = findOwnCity(PLAYER_ID, CITY);
if (!city) {
  return { ok: false, code: "NO_SUCH_UNIT", message: `you have no settlement ${CITY} — run \`civ resource\` to see which can take it` };
}
const cityName = locText(city.name ?? null) ?? String(CITY);
const here = settlements().find((c) => c.id === String(city.id?.id ?? city.id));
if (here && here.free === 0) {
  const room = settlements().filter((c) => c.free !== null && c.free > 0).map((c) => `${c.name} (${c.free} free)`);
  return {
    ok: false,
    code: "ILLEGAL_ACTION",
    message: `${cityName} has no free resource slot (${here.assigned}/${here.cap} used)`,
    hint: room.length > 0
      ? `these have room: ${room.join(", ")}`
      : "no settlement has a free slot; `civ resource done` tells the game you are finished. A Market (+1) or Lighthouse (+2) adds slots",
  };
}

// { Location, City } — the exact shape model-resource-allocation.ts sends. Wrong arity/keys on a
// native op segfault the game, so this matches the source and adds no Action field.
const all = settlements();
const target = all.find((c) => c.id === String(city.id?.id ?? city.id)) ?? { cityId: city.id?.id ?? city.id, isTown: city.isTown === true };
const check = placement(picked.index, target);
if (!check.ok) {
  // Say why, in the game's own terms where it gives them, and where the resource CAN go.
  const cls = resourceClass(picked.hash);
  let already = false;
  try { already = (city.Resources?.getAssignedResources?.() ?? []).some((r) => r?.value === picked.index); } catch { already = false; }
  const why = check.reasons.length > 0
    ? check.reasons.join("; ")
    : already
      ? `${cityName} already holds this resource`
      : cls === "city" && target.isTown
        ? `${picked.name} is a city resource and ${cityName} is a town`
        : `the game gives no reason`;
  const room = takers(picked.index, all).map((id) => all.find((c) => c.id === id)).filter(Boolean).map((c) => `${c.name} (city:${c.id})`);
  return {
    ok: false,
    code: "ILLEGAL_ACTION",
    message: `the game will not put ${picked.name} in ${cityName}: ${why}`,
    hint: room.length > 0
      ? `it can go to: ${room.join(", ")}`
      : `no settlement can take ${picked.name} right now; once nothing more can be placed, \`civ resource done\` tells the game you are finished`,
  };
}
const args = check.args;
try {
  Game.PlayerOperations.sendRequest(PLAYER_ID, PlayerOperationTypes.ASSIGN_RESOURCE, args);
} catch (e) {
  return { ok: false, code: "ENGINE_INTERNAL", message: String(e).slice(0, 120) };
}
return { ok: true, note: `assigned ${picked.name} to ${cityName}` };
