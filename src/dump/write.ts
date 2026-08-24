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
        ["owner", t.owner === null ? null : `p${t.owner}`],
        ["city", t.cityId],
        ["vis", t.vis === 2 ? "visible" : "fogged"],
        ["last_seen", t.lastSeenTurn],
      ]),
    );
}

export function unitLines(own: OwnUnit[], foreign: ForeignUnit[]): string[] {
  const ownLines = [...own]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((u) =>
      line("unit", u.id, [
        ["owner", `p${u.owner}`],
        ["type", u.type as unknown as Scalar],
        ["at", u.x === null ? null : `${u.x},${u.y}`],
        ["hp", u.maxDamage === null ? null : (u.maxDamage ?? 0) - (u.damage ?? 0)],
        ["moves", u.movesRemaining],
        ["can_move", u.canMove],
        ["commander", u.isCommander],
        ["army", u.armyId],
        ["xp", u.experience],
        ["name", u.name],
      ]),
    );
  const foreignLines = [...foreign]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((u) =>
      line("enemy_unit", u.id, [
        ["owner", `p${u.owner}`],
        ["type", u.type as unknown as Scalar],
        ["at", u.x === null ? null : `${u.x},${u.y}`],
        ["hp", u.maxDamage === null ? null : (u.maxDamage ?? 0) - (u.damage ?? 0)],
      ]),
    );
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
