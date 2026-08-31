// Runs inside Civ 7. Assign a new resource to a settlement (docs/PLAN.md §7).
//
// NOTIFICATION_ASSIGN_NEW_RESOURCES blocks the end of a turn until each new resource is placed in a
// settlement for its bonus. There was no command for it, so the block could only be cleared by a
// human. ASSIGN_RESOURCE takes { Location, City } — the resource's PLOT (from its .value index) and
// the settlement's numeric id — exactly as model-resource-allocation.ts sends it. It takes NO
// Action field for an assign; Action:Deactivate is only for the UNASSIGN path.
const player = Players.get(PLAYER_ID);

/** The player's resources as { name, index }, where index is the resource's plot index. */
function ownResources() {
  const out = [];
  try {
    for (const r of player?.Resources?.getResources?.() ?? []) {
      const index = r?.value;
      if (index === undefined || index === null) continue;
      out.push({ name: typeName("Resources", r?.uniqueResource?.resource) ?? String(index), index });
    }
  } catch {
    /* no resources */
  }
  return out;
}

if (MODE === "list") {
  const cities = [];
  try {
    for (const cid of player?.Cities?.getCityIds?.() ?? []) {
      const c = Cities.get(cid);
      if (c) cities.push({ name: locText(c.name ?? null) ?? String(cid.id), id: String(cid.id) });
    }
  } catch {
    /* no settlements */
  }
  return { resources: ownResources(), cities };
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

const city = findOwnCity(PLAYER_ID, CITY);
if (!city) {
  return { ok: false, code: "NO_SUCH_UNIT", message: `you have no settlement ${CITY} — run \`civ resource\` to see which can take it` };
}
const cityName = locText(city.name ?? null) ?? String(CITY);

// { Location, City } — the exact shape model-resource-allocation.ts sends. Wrong arity/keys on a
// native op segfault the game, so this matches the source and adds no Action field.
const args = { Location: GameplayMap.getLocationFromIndex(picked.index), City: city.id?.id ?? city.id };
let allowed = false;
try {
  allowed = Game.PlayerOperations?.canStart?.(PLAYER_ID, PlayerOperationTypes.ASSIGN_RESOURCE, args, false)?.Success === true;
} catch {
  allowed = false;
}
if (!allowed) {
  return { ok: false, code: "ILLEGAL_ACTION", message: `the game will not put ${picked.name} in ${cityName} right now — its resource slots may be full` };
}
try {
  Game.PlayerOperations.sendRequest(PLAYER_ID, PlayerOperationTypes.ASSIGN_RESOURCE, args);
} catch (e) {
  return { ok: false, code: "ENGINE_INTERNAL", message: String(e).slice(0, 120) };
}
return { ok: true, note: `assigned ${picked.name} to ${cityName}` };
