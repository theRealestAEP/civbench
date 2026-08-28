// Runs inside Civ 7. Returns every plot PLAYER_ID has revealed (docs/PLAN.md §7).
//
// Visibility is per FIELD, not per tile. A fogged plot still shows terrain, resources, and
// settlements as the player last saw them; it hides units. We report the current value plus a
// `vis` flag, and the dump layer decides which fields to trust:
//   - immutable facts (terrain, biome, feature, water, river, continent) are safe at any vis
//   - mutable facts (owner, city, improvement) are only trusted at vis=2 (VISIBLE); at vis=1
//     the dump layer carries forward what this player last saw. Reading them here would leak.
const W = GameplayMap.getGridWidth();
const H = GameplayMap.getGridHeight();
const HIDDEN = RevealedStates.HIDDEN;
const VISIBLE = RevealedStates.VISIBLE;

/** Movement cost and defence for a terrain, memoised: a full map asks this thousands of times. */
const __terrain = new Map();
function terrainCost(hash) {
  if (__terrain.has(hash)) return __terrain.get(hash);
  let out = {};
  try {
    const row = GameInfo.Terrains?.lookup?.(hash);
    if (row) {
      out = {
        moveCost: row.MovementCost ?? null,
        defense: row.DefenseModifier || null,
        impassable: row.Impassable === true ? true : null,
      };
    }
  } catch { out = {}; }
  __terrain.set(hash, out);
  return out;
}

const out = [];
/** Your settlements, with their locations, so the growth check below can skip distant plots. */
const OWN_CITIES = [];
try {
  for (const cid of Players.get(PLAYER_ID)?.Cities?.getCityIds?.() ?? []) {
    const city = Cities.get(cid);
    if (city?.location) {
      OWN_CITIES.push({ id: cid, name: String(cid.id ?? cid), x: city.location.x, y: city.location.y });
    }
  }
} catch { /* no settlements yet */ }

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const vis = GameplayMap.getRevealedState(PLAYER_ID, x, y);
    if (vis === HIDDEN) continue; // never seen: emit nothing at all

    const tile = {
      x,
      y,
      vis: vis === VISIBLE ? 2 : 1,
      terrain: shortName(typeName("Terrains", GameplayMap.getTerrainType(x, y))),
      biome: shortName(typeName("Biomes", GameplayMap.getBiomeType(x, y))),
      feature: shortName(typeName("Features", GameplayMap.getFeatureType(x, y))),
      resource: shortName(typeName("Resources", GameplayMap.getResourceType(x, y))),
      water: GameplayMap.isWater(x, y),
      river: GameplayMap.isNavigableRiver(x, y),
      mountain: GameplayMap.isMountain(x, y),
      continent: shortName(typeName("Continents", GameplayMap.getContinentType(x, y))),
      elevation: GameplayMap.getElevation(x, y),
      // What it costs to walk here, and what it is worth to defend.
      //
      // The Terrains table carries these and we export it, but joining a tile to it by hand is
      // work the agent should not be doing mid-move. One agent moved a warrior and then wrote
      // "the warrior moves two spaces each — did we use six moves?", because nothing on the tile
      // said what a step costs.
      ...terrainCost(GameplayMap.getTerrainType(x, y)),
      // What the plot is worth.
      //
      // A human reads these off the map and the plot tooltip; getPlotYields() in the UI's
      // helpers.ts is the same call. Without them an agent cannot compare two settle sites, tell
      // 3-food grassland from 1-food tundra, or judge where a district belongs — so the benchmark
      // measured which model best recalled Civ VII terrain values from training data.
      yields: (() => {
        try {
          const raw = GameplayMap.getYields(GameplayMap.getIndexFromLocation({ x, y }), PLAYER_ID);
          if (!raw) return null;
          const out = {};
          for (const [type, amount] of raw) {
            if (!amount) continue;
            const def = GameInfo.Yields.lookup(type);
            if (def) out[shortName(def.YieldType)] = amount;
          }
          return Object.keys(out).length > 0 ? out : null;
        } catch { return null; }
      })(),
    };

    // Mutable state: only read it when the plot is actually visible this turn.
    if (vis === VISIBLE) {
      tile.owner = GameplayMap.getOwner(x, y);
      const city = GameplayMap.getOwningCityFromXY(x, y);
      tile.cityId = city ? String(city.id ?? city) : null;
      // What is built here. Mutable, so it follows the same VISIBLE-only rule as owner above:
      // reporting it from a fogged plot would leak what a rival has built since you last looked.
      try {
        const built = [];
        for (const cid of MapConstructibles.getConstructibles(x, y) ?? []) {
          const instance = Constructibles.getByComponentID(cid);
          const info = instance ? GameInfo.Constructibles.lookup(instance.type) : null;
          if (info) built.push(info.ConstructibleType + (instance.complete === false ? "(building)" : ""));
        }
        tile.built = built.length > 0 ? built : null;
      } catch { tile.built = null; }
      // A discovery sitting on this plot.
      //
      // A human sees these highlighted on the map — discovery-layer.ts draws an overlay on every
      // one. We showed them nowhere, and the engine refuses to let a unit skip its turn while one
      // is adjacent: "There is a Discovery nearby!", seven times across six turns, against an
      // agent with no way to find out where "nearby" was or what to do about it. Walk onto it.
      //
      // getHiddenFilteredConstructibles is the call the game's own layer makes — a discovery is a
      // constructible flagged `Discovery`, and it does not come back from getConstructibles.
      // Can one of your settlements grow onto this plot?
      //
      // A human sees the claimable ring highlighted when a city grows. We showed nothing, so an
      // agent placing a citizen guessed a coordinate, was refused, and only then got the list —
      // three times in six turns, each costing an action. `canStart` is the engine's own mask, so
      // this is the same answer `civ expand` gives, just visible before you have to ask.
      // Only plots near one of your settlements can be asked about. A city can never grow onto a
      // plot four rings out, and asking the engine anyway would mean a canStart call for every
      // revealed tile times every city — well over a thousand per snapshot, on the same thread
      // that runs the game.
      tile.expandFor = null;
      for (const near of OWN_CITIES) {
        if (Math.abs(near.x - x) > 3 || Math.abs(near.y - y) > 3) continue;
        let ok = false;
        try { ok = Game.CityCommands.canStart(near.id, CityCommandTypes.EXPAND, { X: x, Y: y }, false)?.Success === true; }
        catch { ok = false; }
        if (ok) { tile.expandFor = near.name; break; }
      }
      try {
        let discovery = null;
        for (const cid of MapConstructibles.getHiddenFilteredConstructibles(x, y) ?? []) {
          const instance = Constructibles.getByComponentID(cid);
          const info = instance ? GameInfo.Constructibles.lookup(instance.type) : null;
          if (info?.Discovery) { discovery = info.ConstructibleType; break; }
        }
        tile.discovery = discovery;
      } catch { tile.discovery = null; }
    }
    out.push(tile);
  }
}
return { width: W, height: H, tiles: out };
