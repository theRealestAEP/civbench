// Dump writers (docs/PLAN.md §6.1).
//
// Two rules govern everything here:
//   - Never rank or sort by relevance. Ordering is by stable id or coordinate. Sorting by our
//     idea of importance would be an assist, and strategic perception is what we measure.
//   - Never filter. Completeness inside the parity boundary is the whole contract.
//
// Every record type has a FIXED key set. A field with no value is written `none` rather than
// omitted, so `grep "resource=none"` works and lines stay aligned across turns.
import type { MergedTile } from "./types.ts";
import type { MergedSettlement } from "./merge.ts";
import type { OwnSettlement, OwnUnit, ForeignUnit, KnownPlayer, PendingSnapshot } from "./types.ts";
import { handleFor, type Handles } from "./handles.ts";

type Scalar = string | number | boolean | null | undefined;

/** One dumped record: field name to value, ready for a text line or its JSONL twin. */
type DumpRecord = Record<string, Scalar | null>;

function field(value: Scalar): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(value).replace(/\s+/g, "_");
}

/**
 * Fields that stay even when empty, because their absence would mislead rather than inform.
 * `vis` says whether you can see the plot at all; `moves=0` says a unit is finished this turn.
 */
const ALWAYS: ReadonlySet<string> = new Set(["vis", "moves", "hp", "pop", "kind", "owner", "at", "type", "name"]);

/**
 * `kind id k=v k=v ...` — one fact per line.
 *
 * A field that does not apply is left out. Telling an agent a scout is `isPrivateer=no`, a tile is
 * `water=no river=no mountain=no resource=none`, or a city is `razing=no distant=no` says nothing
 * it did not already know: six of sixteen fields on every tile line were a fact about what the
 * tile is NOT. The game's own UI draws no row for those either.
 *
 * `-1` and `none` go too — both are the engine's "nothing here", and a sentinel has no business
 * reaching an agent. (`city=-1` was doing exactly that on every unowned tile.)
 */
function line(kind: string, id: Scalar, pairs: Array<[string, Scalar]>): string {
  const carries = (k: string, v: Scalar): boolean => {
    if (ALWAYS.has(k)) return true;
    return !(
      v === false || v === null || v === undefined || v === "" ||
      v === "none" || v === -1 || v === "-1" || v === 0
    );
  };
  const body = pairs
    .filter(([k, v]) => carries(k, v))
    .map(([k, v]) => `${k}=${field(v)}`)
    .join(" ");
  return `${kind} ${field(id)} ${body}`;
}

export function tileLines(tiles: MergedTile[]): string[] {
  return [...tiles]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((t) =>
      line("tile", `${t.x},${t.y}`, [
        ["terrain", t.terrain],
        ["biome", t.biome],
        ["feature", t.feature],
        ["resource", t.resource],
        ["water", t.water],
        ["river", t.river],
        ["mountain", t.mountain],
        ["continent", t.continent],
        // Yields as one field, so a line stays greppable: `yield=food2,production1`.
        ["move_cost", t.moveCost ?? null],
        ["defense", t.defense ?? null],
        ["impassable", t.impassable ?? null],
        ["yield", t.yields ? Object.entries(t.yields).map(([k, v]) => `${k}${v}`).join(",") : null],
        ["built", t.built && t.built.length > 0 ? t.built.join(",") : null],
        ["discovery", t.discovery ?? null],
        ["can_grow_here", t.expandFor ?? null],
        ["owner", t.owner === null ? null : `p${t.owner}`],
        ["city", t.cityId],
        ["vis", t.vis === 2 ? "visible" : "fogged"],
        ["last_seen", t.lastSeenTurn],
      ]),
    );
}

/**
 * A unit line carries every field the extractor sent.
 *
 * The old version listed ten fields by hand, so anything the game knew and this list omitted was
 * invisible to the agent no matter what the extractor collected. The lead fields stay first
 * because they are what an agent scans for; everything else follows in a stable order, so the
 * lines stay greppable and diffable.
 */
const UNIT_LEAD = ["owner", "type", "at", "hp", "moves"] as const;

function entityLine(kind: string, record: Record<string, Scalar | null | undefined>, id: string): string {
  const lead: Array<[string, Scalar | null]> = [];
  for (const key of UNIT_LEAD) {
    if (key in record) lead.push([key, record[key] ?? null]);
  }
  // SAFETY: `includes` on a readonly tuple narrows its argument to the tuple's members. The cast
  // asks "is this key one of them", which is exactly what the filter is testing.
  const rest = Object.keys(record)
    .filter((k) => !UNIT_LEAD.includes(k as (typeof UNIT_LEAD)[number]) && k !== "id")
    .sort()
    .map((k): [string, Scalar | null] => [k, record[k] ?? null]);
  return line(kind, id, [...lead, ...rest]);
}

/**
 * Display names for the text dump.
 *
 * The JSONL twin keeps the code names, because jq filters are written against those. The text file
 * uses the short snake_case an agent greps for — `moves=0`, not `movesRemaining=0`. Anything not
 * listed keeps the name the extractor sent, so a new field appears without being renamed by hand.
 */
const DISPLAY = new Map<string, string>(Object.entries({
  canFoundHere: "can_found_here",
  Combat_attacksRemaining: "attacks_left",
  Combat_canAttack: "can_attack",
  Combat_defenseStrength: "defense",
  sightRange: "sight",
  buildCharges: "charges",
  originCityId: "from_city",
  movesRemaining: "moves",
  maxMoves: "max_moves",
  canMove: "can_move",
  hasMoved: "has_moved",
  isCommander: "commander",
  armyId: "army",
  experience: "xp",
  experienceToNextLevel: "xp_to_level",
  attackRange: "range",
}));

/**
 * Fields that stay on the line even when they are zero, because zero is the whole point.
 * A unit with no moves left is done for the turn; that has to be visible.
 */
const KEEP_ZERO = new Set(["moves", "hp", "xp", "at", "owner", "type", "name"]);

/**
 * Flatten what the extractor sent into printable fields for the TEXT line.
 *
 * The extractor now returns everything the game holds — 101 fields for one scout, 70 of them zero
 * or false: `isPrivateer=no`, `antiAirStrength=0` in the Bronze Age. A human sees none of that,
 * because the UI does not draw a row for something that does not apply. So the text line carries
 * what applies, and the .jsonl twin keeps every field for anything that wants the lot.
 *
 * Nothing is hidden: the full record is one file away, and the briefing says so.
 */
// eslint-disable-next-line complexity -- field-inclusion rules: one branch per field family, mirroring what the game's UI draws.
function unitRecord(u: OwnUnit | ForeignUnit): DumpRecord {
  const out: DumpRecord = {};
  for (const [key, value] of Object.entries(u)) {
    if (value === undefined || value === null) continue;
    if (key === "id" || key === "x" || key === "y") continue;
    if (key === "damage" || key === "maxDamage") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) out[DISPLAY.get(key) ?? key] = value.join(",");
    } else if (typeof value === "object") {
      continue;
    } else {
      const name = DISPLAY.get(key) ?? key;
      // A field that does not apply is left out, the way the UI leaves out its row.
      const empty = value === false || value === 0 || value === "";
      if (!empty || KEEP_ZERO.has(name)) out[name] = value;
    }
  }
  // ForeignUnit is a Pick of OwnUnit, so every field read here is on both arms of the union.
  out.at = u.x === null || u.x === undefined ? null : `${u.x},${u.y}`;
  out.owner = `p${u.owner}`;
  if (u.maxDamage !== null && u.maxDamage !== undefined) {
    out.hp = u.maxDamage - (u.damage ?? 0);
  }
  return out;
}

export function unitLines(own: OwnUnit[], foreign: ForeignUnit[], handles?: Handles): string[] {
  // Your own units lead with a readable handle — `unit scout-1 id=131072 ...`. The raw
  // ComponentID is what the engine understands, so it stays on the line, but it is not what an
  // agent should have to reason with: 65536 is both the starting settler and the city it founds,
  // which is how one came to treat them as the same thing.
  const ownLines = [...own]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((u) => {
      const record = unitRecord(u);
      if (!handles) return entityLine("unit", record, u.id);
      // The engine's own id stays on the line: an agent that reads one elsewhere, or wants to
      // pass one to `civ do`, should not have to translate.
      return entityLine("unit", { engine_id: u.id, ...record }, handleFor(handles, u.id, u.type));
    });
  // A rival's unit gets no handle: you have not been introduced, and inventing one would imply
  // you can track it between sightings.
  const foreignLines = [...foreign]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((u) => entityLine("enemy_unit", unitRecord(u), u.id));
  return [...ownLines, ...foreignLines];
}

export function settlementLines(own: OwnSettlement[], foreign: MergedSettlement[]): string[] {
  // Led by the NAME the game gave it, not its ComponentID. `settlement 65536` meant nothing to an
  // agent, and 65536 is also the id of the settler that founded it.
  const ownLines = [...own]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) =>
      line("settlement", s.name ?? s.id, [
        ["kind", s.kind],
        ["engine_id", s.id],
        ["owner", "self"],
        ["at", s.x === null ? null : `${s.x},${s.y}`],
        ["pop", s.population],
        ["capital", s.isCapital],
        ["food", s.currentFood],
        ["food_to_grow", s.foodToGrow],
        ["food_per_turn", s.foodPerTurn],
        ["turns_to_grow", s.turnsToGrow],
        ["urban", s.urbanPopulation],
        ["rural", s.ruralPopulation],
        ["building", s.building],
        ["prod_turns_left", s.productionTurnsLeft],
        ["queue_empty", s.queueEmpty],
        ["happiness", s.happiness],
        ["unrest", s.hasUnrest],
        ["razing", s.beingRazed],
        ["distant", s.distantLands],
      ]),
    );
  const foreignLines = [...foreign]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) =>
      line("settlement", s.id, [
        ["kind", s.kind],
        ["name", s.name],
        ["owner", `p${s.owner}`],
        ["at", `${s.x},${s.y}`],
        ["capital", s.isCapital],
        ["vis", s.vis === 2 ? "visible" : "fogged"],
        ["last_seen", s.lastSeenTurn],
      ]),
    );
  return [...ownLines, ...foreignLines];
}

export function playerLines(known: KnownPlayer[]): string[] {
  return [...known]
    .sort((a, b) => a.id - b.id)
    .map((p) =>
      line("player", `p${p.id}`, [
        ["civ", p.civ],
        ["leader", p.leader],
        ["major", p.isMajor],
        ["at_war", p.atWar],
        ["relationship", p.relationship],
        // How they are doing. A human reads this off the diplomacy ribbon every turn.
        ["gold", p.gold],
        ["sci", p.science],
        ["cult", p.culture],
        ["happy", p.happiness],
        ["diplo", p.diplomacy],
        ["settlements", p.settlements === null ? null : `${p.settlements}/${p.settlementCap ?? "?"}`],
        ["legacy", p.legacy],
        ["war_support_for_me", p.warSupportForMe],
        ["war_support_for_them", p.warSupportForThem],
        ["suzerain", p.suzerain === null ? null : `p${p.suzerain}`],
      ]),
    );
}

export function pendingLines(pending: PendingSnapshot): string[] {
  // The game's own notification list. Reproduced in the game's own order; we rank nothing.
  return pending.items.map((item) =>
    line("pending", item.id, [
      ["type", item.type],
      ["blocking", item.type !== null && item.type === pending.blockingType],
      ["summary", item.summary ?? item.message],
    ]),
  );
}

/** Same records, same order, as JSONL — so `jq` covers what `awk` would have (see §9.5). */
export function toJsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}
