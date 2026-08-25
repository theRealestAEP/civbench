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

type Scalar = string | number | boolean | null | undefined;

function field(value: Scalar): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(value).replace(/\s+/g, "_");
}

/** `kind id k=v k=v ...` — one fact per line, fixed keys, in the order given. */
function line(kind: string, id: Scalar, pairs: Array<[string, Scalar]>): string {
  const body = pairs.map(([k, v]) => `${k}=${field(v)}`).join(" ");
  return `${kind} ${field(id)} ${body}`;
}

export function tileLines(tiles: MergedTile[]): string[] {
  return [...tiles]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((t) =>
      line("tile", `${t.x},${t.y}`, [
        ["terrain", t.terrain as unknown as Scalar],
        ["biome", t.biome as unknown as Scalar],
        ["feature", t.feature as unknown as Scalar],
        ["resource", t.resource as unknown as Scalar],
        ["water", t.water],
        ["river", t.river],
        ["mountain", t.mountain],
        ["continent", t.continent as unknown as Scalar],
        // Yields as one field, so a line stays greppable: `yield=food2,production1`.
        ["yield", t.yields ? Object.entries(t.yields).map(([k, v]) => `${k}${v}`).join(",") : null],
        ["built", t.built && t.built.length > 0 ? t.built.join(",") : null],
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
const DISPLAY: Record<string, string> = {
  movesRemaining: "moves",
  maxMoves: "max_moves",
  canMove: "can_move",
  hasMoved: "has_moved",
  isCommander: "commander",
  armyId: "army",
  experience: "xp",
  experienceToNextLevel: "xp_to_level",
  attackRange: "range",
};

/** Flatten what the extractor sent into printable fields, dropping only what cannot render. */
function unitRecord(u: OwnUnit | ForeignUnit): Record<string, Scalar | null> {
  const out: Record<string, Scalar | null> = {};
  for (const [key, value] of Object.entries(u as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (key === "id" || key === "x" || key === "y") continue;
    if (key === "damage" || key === "maxDamage") continue;
    if (Array.isArray(value)) {
      out[key] = value.join(",");
    } else if (typeof value === "object") {
      continue;
    } else {
      out[DISPLAY[key] ?? key] = value as Scalar;
    }
  }
  const u2 = u as { x?: number | null; y?: number | null; damage?: number | null; maxDamage?: number | null };
  out.at = u2.x === null || u2.x === undefined ? null : `${u2.x},${u2.y}`;
  out.owner = `p${(u as { owner: number }).owner}`;
  if (u2.maxDamage !== null && u2.maxDamage !== undefined) {
    out.hp = (u2.maxDamage ?? 0) - (u2.damage ?? 0);
  }
  return out;
}

export function unitLines(own: OwnUnit[], foreign: ForeignUnit[]): string[] {
  const ownLines = [...own]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((u) => entityLine("unit", unitRecord(u), u.id));
  const foreignLines = [...foreign]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((u) => entityLine("enemy_unit", unitRecord(u), u.id));
  return [...ownLines, ...foreignLines];
}

export function settlementLines(own: OwnSettlement[], foreign: MergedSettlement[]): string[] {
  const ownLines = [...own]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) =>
      line("settlement", s.id, [
        ["kind", s.kind],
        ["name", s.name],
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
