// Readable names for things the engine addresses by number (docs/PLAN.md §6.1).
//
// Civ identifies a unit or a settlement by a ComponentID — 65536, 131072, 196609. A human never
// sees one. They see "Pārsa" and a scout on a hill, and they click it.
//
// Handing agents the raw numbers did exactly what you would expect. From the transcripts:
//   "I need to build a city ID, which I think is likely around 65536"
//   `civ near 65536` -> "you have no unit 65536"        (65536 was a city)
//   unit ids invented by adding 65536 to the last one, then ordered blind
// The settler is unit 65536 and the city it founds is settlement 65536, which is how an agent
// came to believe the two were the same thing.
//
// So every unit gets a stable, readable handle — `scout-1`, `warrior-2` — assigned the first time
// it is seen and kept for the rest of the match. Settlements use the name the game already gave
// them. The numeric id stays on the line as `id=`, because it is what the engine understands and
// an agent that has one should be able to use it.

/** Handles assigned so far, and the next ordinal per kind. Lives in PlayerMemory. */
export type Handles = {
  /** unit id -> handle, e.g. "131072" -> "scout-1" */
  units: Record<string, string>;
  /** kind -> how many have been named, e.g. { scout: 2, warrior: 3 } */
  counts: Record<string, number>;
};

export const emptyHandles = (): Handles => ({ units: {}, counts: {} });

/** `UNIT_ARMY_COMMANDER` / `army_commander` / `scout` -> `commander`, `scout`. */
function kindOf(type: string | null): string {
  if (!type) return "unit";
  const bare = type.replace(/^UNIT_/, "").toLowerCase();
  // The last word carries the meaning: ARMY_COMMANDER is a commander, SCOUT is a scout.
  const parts = bare.split("_").filter(Boolean);
  return parts.at(-1) ?? "unit";
}

/**
 * The handle for a unit, assigning one if this is the first time it has been seen.
 *
 * Stable for the life of the match: an agent that wrote "scout-1 is exploring north" in its
 * journal on turn 3 can still act on scout-1 on turn 30.
 */
export function handleFor(handles: Handles, id: string, type: string | null): string {
  const existing = handles.units[id];
  if (existing) return existing;
  const kind = kindOf(type);
  const next = (handles.counts[kind] ?? 0) + 1;
  handles.counts[kind] = next;
  const handle = `${kind}-${next}`;
  handles.units[id] = handle;
  return handle;
}

/**
 * The numeric id behind a handle, or null if it is not one.
 *
 * Commands accept either. An agent reading `unit scout-1 id=131072` can type whichever it has.
 */
export function idForHandle(handles: Handles, text: string): string | null {
  const wanted = text.trim().toLowerCase();
  for (const [id, handle] of Object.entries(handles.units)) {
    if (handle === wanted) return id;
  }
  return null;
}
