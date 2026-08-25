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

const out = [];
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
    }
    out.push(tile);
  }
}
return { width: W, height: H, tiles: out };
