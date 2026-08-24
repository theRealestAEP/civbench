// `civ near` — what is around a place (docs/PLAN.md §6).
//
// A human looks at the map. An agent got a flat list of tile lines sorted by coordinate and had
// to reassemble the neighbourhood in its head, every turn, for every unit. A live transcript:
//
//   My founder is on tile (17,30): flat, plains, no resources, no river.
//   Nearby tiles with visible range:
//   - (16,29): navigable_river ... river!
//   - (17,29): navigable_river ... river!
//   ... and so on for every neighbour, before deciding anything
//
// This answers the geometry so the agent can spend its turn on judgement instead. It is not
// curation: the agent picks the centre and the radius, and every tile in range is returned
// unranked and unfiltered. It reads the same tiles.txt the agent can read, so a tile it is not
// entitled to see cannot appear here either.

/** Civ lays hexes out as odd-r offset rows. Convert to cube coordinates to measure distance. */
function toCube(x: number, y: number): [number, number, number] {
  const q = x - (y - (y & 1)) / 2;
  const r = y;
  return [q, r, -q - r];
}

export function hexDistance(ax: number, ay: number, bx: number, by: number): number {
  const [aq, ar, as] = toCube(ax, ay);
  const [bq, br, bs] = toCube(bx, by);
  return Math.max(Math.abs(aq - bq), Math.abs(ar - br), Math.abs(as - bs));
}

/** Pull `x,y` off a `tile 14,22 key=value ...` line. */
function coordsOf(line: string): [number, number] | null {
  const m = /^tile (\d+),(\d+) /.exec(line);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Tile lines within `radius` of (cx, cy), nearest first, each prefixed with its distance.
 *
 * Distance only, no compass bearing: Civ's grid has six directions (E, W, NE, NW, SE, SW) and no
 * north or south, so a N/S label would be a lie the agent then reasons from.
 */
export function tilesNear(
  tilesText: string,
  cx: number,
  cy: number,
  radius: number,
): string[] {
  const found: Array<{ d: number; line: string }> = [];
  for (const line of tilesText.split("\n")) {
    const at = coordsOf(line);
    if (!at) continue;
    const d = hexDistance(cx, cy, at[0], at[1]);
    if (d > radius) continue;
    found.push({ d, line: `${(d === 0 ? "here" : `d=${d}`).padEnd(5)} ${line}` });
  }
  found.sort((a, b) => a.d - b.d);
  return found.map((f) => f.line);
}
