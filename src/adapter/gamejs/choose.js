// Runs inside Civ 7. Every "pick a thing" decision, in one place.
//
// Civ hashes each type string to an int, and operations disagree on which encoding they want:
// CITYOPERATION_BUILD wants GameInfo.Types .Hash under a key that depends on what the thing IS,
// while CHANGE_GOVERNMENT wants a table ROW INDEX plus an Action enum. There is no introspection,
// so somewhere has to know. This is the only place that does.
//
// It replaced build.js, research.js and government.js — three scripts with the same shape and
// three chances to get it subtly wrong. Adding a decision is a row in DECISIONS, not a new file.
/**
 * Every plot the engine will let a constructible go on, or null when it named none.
 *
 * Two lists, not one. `Plots` is the urban tiles with a free slot; `ExpandUrbanPlots` is the
 * rural tiles the building could turn urban — the game's own placement mode offers both
 * (building-placement-manager.ts selectPlacementData). Reading only `Plots` sent an order for
 * a saw pit without a plot when the city's districts were full: the engine accepted it, queued
 * nothing, and the listing kept offering the saw pit as buildable.
 */
function buildPlots(result) {
  const urban = Array.isArray(result?.Plots) ? result.Plots : null;
  const expand = Array.isArray(result?.ExpandUrbanPlots) ? result.ExpandUrbanPlots : null;
  if (urban === null && expand === null) return null;
  return [...(urban ?? []), ...(expand ?? [])];
}

/**
 * Whether a unit may take a promotion, the way the game's own panel decides it
 * (panel-unit-promotion.ts): a point to spend, not already held, and the discipline tree
 * allows it. `canStart` is not that gate — it said yes to eleven promotions in one turn and
 * the engine applied none of them, so the point stayed unspent and the turn ran out.
 */
function promotionGate(unit, disciplineType, promotionType) {
  const args = {
    PromotionType: Database.makeHash(promotionType),
    PromotionDisciplineType: Database.makeHash(disciplineType),
  };
  const xp = unit?.Experience;
  if (xp && typeof xp.canEarnPromotion === "function") {
    try {
      if (xp.canPromote !== true) return { ok: false, args };
      if (typeof xp.hasPromotion === "function" && xp.hasPromotion(disciplineType, promotionType) === true) return { ok: false, args };
      return { ok: xp.canEarnPromotion(disciplineType, promotionType, false) === true, args };
    } catch { return { ok: false, args }; }
  }
  let ok = false;
  try { ok = Game.UnitCommands.canStart(unit.id, UnitCommandTypes.PROMOTE, args, false)?.Success === true; }
  catch { ok = false; }
  return { ok, args };
}

/** The discipline rows that apply to this unit: an army commander's are the ARMY ones. */
function promotionRows(unit) {
  const type = String(typeName("Units", unit?.type) ?? "");
  const family = /ARMY|FLEET|SQUADRON/.exec(type)?.[0] ?? null;
  return tableRows(GameInfo.UnitPromotionDisciplineDetails).filter((d) =>
    d?.UnitPromotionType && (family === null || String(d.UnitPromotionDisciplineType).includes(`_${family}_`)));
}

/** Every promotion this unit can take right now, by name, with what it does. */
function promotionChoices(unit) {
  const seen = new Set();
  const out = [];
  for (const detail of promotionRows(unit)) {
    const name = detail.UnitPromotionType;
    if (seen.has(name)) continue;
    if (!promotionGate(unit, detail.UnitPromotionDisciplineType, name).ok) continue;
    seen.add(name);
    const def = GameInfo.UnitPromotions?.lookup?.(Database.makeHash(name));
    out.push({ name, title: locText(def?.Name ?? null), does: locText(def?.Description ?? null), available: true });
  }
  return out;
}

const player = Players.get(PLAYER_ID);
const ACTIVATE = typeof PlayerOperationParameters !== "undefined" ? PlayerOperationParameters.Activate : 1;
const DEACTIVATE = typeof PlayerOperationParameters !== "undefined" ? PlayerOperationParameters.Deactivate : 2;

/**
 * The three kinds of culture slot, as [enum, readable name].
 *
 * A human's policy screen is split this way and the split matters: crisis cards only go in crisis
 * slots, so "no free slot" depends on WHICH kind. A flat list could not say that.
 */
function cultureSlots() {
  if (typeof CultureSlotTypes === "undefined") return [];
  return [
    [CultureSlotTypes.TRADITION_CULTURE_SLOT, "tradition"],
    [CultureSlotTypes.POLICY_CULTURE_SLOT, "policy"],
    [CultureSlotTypes.CRISIS_CULTURE_SLOT, "crisis"],
  ];
}

const DECISIONS = {
  build: {
    // The key follows the thing's Kind, and the value is its hash.
    scope: "city",
    // A town's focus is chosen through the production chooser, and that panel tells the engine
    // "I have considered this town's project" the moment it opens for a town
    // (panel-production-chooser.ts, CONSIDER_TOWN_PROJECT). That signal, not the project order,
    // is what clears NOTIFICATION_CHOOSE_TOWN_PROJECT — 116 blocks, 115 never resolved.
    after: (cityId, args) => {
      if (args?.ProjectType === undefined) return;
      const op = CityOperationTypes.CONSIDER_TOWN_PROJECT;
      if (op === undefined || !Cities.get(cityId)?.isTown) return;
      try {
        if (Game.CityOperations.canStart(cityId, op, {}, false)?.Success === true) {
          Game.CityOperations.sendRequest(cityId, op, {});
        }
      } catch { /* the notification says whether it cleared */ }
    },
    // What this settlement can build right now. canStartQuery returns [{ index, result }] where
    // index is a row index into GameInfo — not a hash, and there is no .Items wrapper.
    list: () => {
      const out = [];
      const city = findOwnCity(PLAYER_ID, TARGET_ID);
      if (!city || typeof CityQueryType === "undefined") return out;
      // A town builds nothing. The game's chooser offers a town only purchases and its focus,
      // and this harness has no purchase yet — so a town's list is its focus projects, below.
      // The engine still answers "yes" to a BUILD query in a town, which is how one seat put
      // seventeen scouts into two towns' queues while the real prompt stood unanswered.
      const kinds = city.isTown ? [] : [
        [CityQueryType.Unit, "Units", "UnitType"],
        [CityQueryType.Constructible, "Constructibles", "ConstructibleType"],
      ];
      for (const [query, table, field] of kinds) {
        let rows = [];
        try { rows = Game.CityOperations.canStartQuery(city.id, CityOperationTypes.BUILD, query) ?? []; }
        catch { rows = []; }
        for (const row of rows) {
          if (row?.result?.Requirements?.FullFailure || row?.result?.Requirements?.Obsolete) continue;
          const def = GameInfo[table]?.lookup?.(row?.index);
          if (!def?.[field]) continue;
          let available = row?.result?.Success === true;
          let why = available ? null : needed(row?.result);
          // A building the city may make but has nowhere to put. The query says yes, the
          // placement has no legal tile, and an order sent without one is accepted and never
          // queued — 78 times in one run, all buildings and wonders. Ask the placement too.
          if (available && field === "ConstructibleType") {
            let placement = null;
            try { placement = Game.CityOperations.canStart(city.id, CityOperationTypes.BUILD, { ConstructibleType: def.$index }, false); }
            catch { placement = null; }
            if (placement && buildPlots(placement)?.length === 0) {
              available = false;
              why = "no tile in this settlement can take it right now";
            }
          }
          out.push({
            name: def[field],
            turns: city.BuildQueue?.getTurnsLeft?.(def[field]) ?? null,
            available,
            why,
          });
        }
      }
      // Projects, the way the game's own chooser does it (production-chooser-helpers.ts): walk the
      // table and ask per project, keeping city-only projects out of towns and town-only ones out
      // of cities. The BUILD query by kind never returned a town's focus projects.
      for (const def of tableRows(GameInfo.Projects)) {
        if (!def?.ProjectType) continue;
        if (city.isTown ? def.CityOnly : def.TownOnly) continue;
        let check = null;
        try { check = Game.CityOperations.canStart(city.id, CityOperationTypes.BUILD, { ProjectType: def.$index }, false); }
        catch { check = null; }
        const req = check?.Requirements;
        if (!check || (req && (req.FullFailure || req.Obsolete || req.MeetsRequirements === false))) continue;
        out.push({
          name: def.ProjectType,
          turns: city.BuildQueue?.getTurnsLeft?.(def.ProjectType) ?? null,
          available: check.Success === true,
          why: check.Success ? null : needed(check),
        });
      }
      return out;
    },
    // The whole QUEUE, not just the head.
    //
    // CITYOPERATION_BUILD appends; it does not replace. Showing only
    // `currentProductionTypeHash` meant an agent that queued a granary behind a scout saw the
    // scout, concluded the order had not stuck, and queued the granary again — three times in one
    // turn, in a run where every one of those orders had in fact worked. The game's own build
    // queue panel shows the list, and so does this.
    current: () => {
      const city = findOwnCity(PLAYER_ID, TARGET_ID);
      const queue = city?.BuildQueue;
      if (!queue) return null;
      const named = (hash) =>
        typeName("Units", hash) ?? typeName("Constructibles", hash) ?? typeName("Projects", hash);
      const items = [];
      try {
        for (const entry of queue.getQueue?.() ?? []) {
          const name = named(entry?.type ?? entry);
          if (name) items.push(name);
        }
      } catch { /* fall back to the head below */ }
      if (items.length === 0) {
        const head = named(queue.currentProductionTypeHash);
        return head ?? null;
      }
      let turns = null;
      try { turns = queue.currentTurnsLeft ?? null; } catch { turns = null; }
      const first = `${items[0]}${turns && turns > 0 ? ` (${turns} turns)` : ""}`;
      return items.length === 1 ? first : `${first}, then ${items.slice(1).join(", ")}`;
    },
    operation: () => CityOperationTypes.BUILD,
    api: () => Game.CityOperations,
    // Units take a HASH. Constructibles and projects take a ROW INDEX.
    //
    // The game's own production chooser is unambiguous — production-chooser-operations.ts passes
    // `{ ConstructibleType: constructible.$index }` — and we sent `.Hash` for all three. canStart
    // accepted it, sendRequest queued nothing, and the harness answered "BUILDING_GRANARY added
    // to the build queue" in the same breath as "Pārsa has nothing in its build queue".
    /**
     * A unit needs only its type. A BUILDING NEEDS A PLOT.
     *
     * Buildings quietly refused to queue for the life of the project: `civ build X GRANARY`
     * reported "added to the build queue", the queue stayed empty, and the NOT_QUEUED verifier
     * then told the agent its order had failed with no reason it could act on. Units worked,
     * so every seat could make warriors and no seat could ever make a building.
     *
     * The game's own production chooser explains why (production-chooser-helpers.ts): an item
     * with an `interfaceMode` — every constructible — does NOT get a bare sendRequest. The UI
     * switches to a placement mode, the human clicks a tile, and the plot rides along in the
     * arguments. canStart() answers with the legal plots in `result.Plots`, which is how the UI
     * knows where the clicks may go, and the same call answers for us. Take the engine's first
     * legal plot; an agent that wants a specific one can pass `x,y` (see PLOT below).
     */
    args: (name) => {
      // The adapter only declares consts it was given, so this may be undefined.
      const PLOT = typeof BUILD_PLOT === "undefined" ? null : BUILD_PLOT;
      const row = GameInfo.Types.lookup(name);
      if (!row) return null;
      const city = findOwnCity(PLAYER_ID, TARGET_ID);
      // Refuse what the game's own screen would never offer a town (see list above).
      if (city?.isTown && row.Kind !== "KIND_PROJECT") return null;
      if (row.Kind === "KIND_UNIT") return { UnitType: row.Hash };
      for (const [table, key] of [["Constructibles", "ConstructibleType"], ["Projects", "ProjectType"]]) {
        for (const def of GameInfo[table] ?? []) {
          if (def[key] !== name) continue;
          const base = { [key]: def.$index };
          // Projects are placed by the engine; only constructibles want a plot. A town's focus
          // replaces whatever is queued — the game's chooser sends it exclusive.
          if (key !== "ConstructibleType") {
            return city?.isTown && typeof CityOperationsParametersValues !== "undefined"
              ? { ...base, InsertMode: CityOperationsParametersValues.Exclusive }
              : base;
          }
          if (!city) return base;
          let check = null;
          try { check = Game.CityOperations.canStart(city.id, CityOperationTypes.BUILD, base, false); }
          catch { check = null; }
          const plots = buildPlots(check);
          if (plots !== null && plots.length === 0) {
            // Sent without a plot, the engine accepts this and queues nothing. Say why instead.
            return {
              __refuse: {
                code: "NO_PLOT",
                message: `${locText(city.name ?? null) ?? "this settlement"} has no tile that can take ${name} right now — ` +
                  `every tile a building can go on is in use`,
                hint: `a building needs a free slot in one of the settlement's districts, or a tile it can turn urban; ` +
                  `\`civ build ${TARGET_ID}\` lists what it can place today`,
              },
            };
          }
          if (plots === null) return base; // the engine listed no plots at all; let it decide
          // An explicit "THING at x,y" wins when the agent named one and it is legal.
          let candidates = plots;
          if (typeof PLOT === "string" && /^\d+\s*,\s*\d+$/.test(PLOT)) {
            const [px, py] = PLOT.split(",").map((n) => Number(n.trim()));
            const named = plots.filter((index) => {
              const at = GameplayMap.getLocationFromIndex(index);
              return at?.x === px && at?.y === py;
            });
            if (named.length > 0) candidates = named;
          }
          // Confirm the plot the way the game's placement mode does before it sends
          // (interface-mode-place-building.ts commitPlot): canStart with X and Y. A plot the list
          // offers can still be refused with the building on it, and the engine then accepts
          // the order and queues nothing.
          for (const index of candidates) {
            const at = GameplayMap.getLocationFromIndex(index);
            if (!at) continue;
            const placed = { ...base, X: at.x, Y: at.y };
            let ok = false;
            try { ok = Game.CityOperations.canStart(city.id, CityOperationTypes.BUILD, placed, false)?.Success === true; }
            catch { ok = false; }
            if (ok) return placed;
          }
          return {
            __refuse: {
              code: "NO_PLOT",
              message: `${locText(city.name ?? null) ?? "this settlement"} offers ${plots.length} tile(s) for ${name}, ` +
                `but the engine refuses to place it on any of them right now`,
              hint: `\`civ build ${TARGET_ID}\` lists what it can place today`,
            },
          };
        }
      }
      return null;
    },
  },
  buy: {
    // Buying with gold: what a TOWN does instead of building, and what a city does in a hurry.
    // The game's chooser (Construct() in production-chooser-helpers.ts) sends PURCHASE with the
    // same type keys as a build and prices it through city.Gold. The CLI checks the treasury
    // afterwards, so an accepted-but-empty purchase is reported as one.
    scope: "city",
    operation: () => CityCommandTypes.PURCHASE,
    api: () => Game.CityCommands,
    list: () => {
      const out = [];
      const city = findOwnCity(PLAYER_ID, TARGET_ID);
      if (!city || typeof CityQueryType === "undefined") return out;
      const goldYield = typeof YieldTypes !== "undefined" ? YieldTypes.YIELD_GOLD : undefined;
      const priced = [
        [CityQueryType.Unit, "Units", "UnitType", (name) => city.Gold?.getUnitPurchaseCost?.(goldYield, name)],
        [CityQueryType.Constructible, "Constructibles", "ConstructibleType", (name) => city.Gold?.getBuildingPurchaseCost?.(goldYield, name)],
      ];
      for (const [query, table, field, price] of priced) {
        let rows = [];
        try { rows = Game.CityCommands.canStartQuery(city.id, CityCommandTypes.PURCHASE, query) ?? []; }
        catch { rows = []; }
        for (const row of rows) {
          if (row?.result?.Requirements?.FullFailure || row?.result?.Requirements?.Obsolete) continue;
          const def = GameInfo[table]?.lookup?.(row?.index);
          if (!def?.[field]) continue;
          let cost = null;
          try { cost = price(def[field]) ?? null; } catch { cost = null; }
          out.push({
            name: def[field],
            cost,
            available: row?.result?.Success === true,
            why: row?.result?.Success ? null : needed(row?.result),
          });
        }
      }
      return out;
    },
    current: () => {
      let gold = null;
      try { gold = player?.Treasury?.goldBalance ?? null; } catch { gold = null; }
      return gold === null ? null : `${Math.floor(gold)} gold in the treasury`;
    },
    args: (name) => {
      const PLOT = typeof BUILD_PLOT === "undefined" ? null : BUILD_PLOT;
      const row = GameInfo.Types.lookup(name);
      if (!row) return null;
      if (row.Kind === "KIND_UNIT") return { UnitType: row.Hash };
      if (row.Kind !== "KIND_CONSTRUCTIBLE") return null;
      // A building needs a plot, exactly as a build does; the engine lists the legal ones.
      const base = { ConstructibleType: row.Hash };
      const city = findOwnCity(PLAYER_ID, TARGET_ID);
      if (!city) return base;
      let check = null;
      try { check = Game.CityCommands.canStart(city.id, CityCommandTypes.PURCHASE, base, false); }
      catch { check = null; }
      const plots = check?.Plots ?? [];
      if (plots.length === 0) return base;
      let chosen = plots[0];
      if (typeof PLOT === "string" && /^\d+\s*,\s*\d+$/.test(PLOT)) {
        const [px, py] = PLOT.split(",").map((n) => Number(n.trim()));
        for (const index of plots) {
          const at = GameplayMap.getLocationFromIndex(index);
          if (at?.x === px && at?.y === py) { chosen = index; break; }
        }
      }
      const at = GameplayMap.getLocationFromIndex(chosen);
      return at ? { ...base, X: at.x, Y: at.y } : base;
    },
  },
  tech: {
    scope: "player",
    operation: () => PlayerOperationTypes.SET_TECH_TREE_NODE,
    api: () => Game.PlayerOperations,
    args: (name) => {
      const row = GameInfo.Types.lookup(name);
      return row ? { ProgressionTreeNodeType: row.Hash } : null;
    },
    list: () => nodeList(player?.Techs),
    current: () => nodeName(player?.Techs),
  },
  civic: {
    scope: "player",
    operation: () => PlayerOperationTypes.SET_CULTURE_TREE_NODE,
    api: () => Game.PlayerOperations,
    args: (name) => {
      const row = GameInfo.Types.lookup(name);
      return row ? { ProgressionTreeNodeType: row.Hash } : null;
    },
    list: () => nodeList(player?.Culture),
    current: () => nodeName(player?.Culture),
  },
  expand: {
    // A city that grows must place its new citizen, and until it does the turn cannot end. That
    // made NOTIFICATION_NEW_POPULATION a permanent block: cities grow every few turns, and no
    // command could answer it. Takes a plot, not a type name, so `value` is "x,y".
    scope: "city",
    operation: () => CityCommandTypes.EXPAND,
    api: () => Game.CityCommands,
    args: (value) => {
      const m = /^(\d+)\s*,\s*(\d+)$/.exec(String(value).trim());
      return m ? { X: Number(m[1]), Y: Number(m[2]) } : null;
    },
    list: () => {
      const out = [];
      const city = findOwnCity(PLAYER_ID, TARGET_ID);
      const at = city?.location;
      if (!at) return out;
      // What the plot IS, on the option line. Bare coordinates forced agents to cross-reference
      // tiles.txt by hand; one mis-mapped, expanded onto the wrong tile, and wrote a correction
      // into its journal the next turn.
      const describePlot = (x, y) => {
        try {
          const parts = [];
          const terrain = shortName(typeName("Terrains", GameplayMap.getTerrainType(x, y)));
          if (terrain) parts.push(terrain);
          const resource = shortName(typeName("Resources", GameplayMap.getResourceType(x, y)));
          if (resource) parts.push(resource);
          const raw = GameplayMap.getYields(GameplayMap.getIndexFromLocation({ x, y }), PLAYER_ID);
          if (raw) {
            const yields = [];
            for (const [type, amount] of raw) {
              if (!amount) continue;
              const def = GameInfo.Yields.lookup(type);
              if (def) yields.push(`${shortName(def.YieldType)}${amount}`);
            }
            if (yields.length > 0) parts.push(yields.join(","));
          }
          return parts.join(" ") || null;
        } catch { return null; }
      };
      // Ask the engine about the plots around the city rather than guessing which are claimable.
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          const x = wrapX(at.x + dx);
          const y = at.y + dy;
          if (y < 0) continue;
          let ok = false;
          try { ok = Game.CityCommands.canStart(city.id, CityCommandTypes.EXPAND, { X: x, Y: y }, false)?.Success === true; }
          catch { ok = false; }
          if (ok) out.push({ name: `${x},${y}`, available: true, does: describePlot(x, y) });
        }
      }
      return out;
    },
    current: () => null,
  },
  story: {
    // Narrative events block the end of a turn and fire constantly, so a match walls on them the
    // same way it did on new population. The answer key is a linked story type — or "CLOSE" when
    // a story has run out of links — and the target is the pending story's ComponentID.
    scope: "player",
    operation: () => PlayerOperationTypes.CHOOSE_NARRATIVE_STORY_DIRECTION,
    api: () => Game.PlayerOperations,
    args: (value) => {
      const target = pendingStoryId();
      if (!target) return null;
      // Check the answer against the story's own links, the way `civ build` checks a name against
      // GameInfo.Types. Without this any string was accepted and sent to the engine, which then
      // refused it with no reason — the exact loop these commands exist to prevent.
      // Accept what agents actually type. The exact id is canonical, but a story's options are
      // presented as a short list and agents reasonably answer with an ORDINAL ("1") or the
      // trailing letter ("B") — both were refused as "this game has no story named 1", which
      // reads as the harness not understanding its own menu.
      const answers = storyChoices().map((c) => c.name);
      let picked = answers.includes(value) ? value : null;
      if (picked === null) {
        const typed = String(value).trim();
        if (/^\d+$/.test(typed)) {
          picked = answers[Number(typed) - 1] ?? null; // 1-based, as the list is printed
        } else if (/^[A-Za-z]$/.test(typed)) {
          picked = answers.find((a) => a.toUpperCase().endsWith(typed.toUpperCase())) ?? null;
        } else {
          // A full id from an EARLIER story: same family, wrong instance. Not answerable.
          picked = answers.find((a) => a.toUpperCase() === typed.toUpperCase()) ?? null;
        }
      }
      if (picked === null) return null;
      value = picked;
      return { TargetType: value, Target: target, Action: ACTIVATE };
    },
    list: () => storyChoices(),
    current: () => storyName(),
  },
  celebration: {
    // A Celebration blocks the turn until you pick its effect. Predicted as the next wall after
    // new population and narrative stories, so it is answered before it costs a run.
    // getGoldenAgeChoices() returns TYPE NAMES; the operation wants the hash of one.
    scope: "player",
    operation: () => PlayerOperationTypes.CHOOSE_GOLDEN_AGE,
    api: () => Game.PlayerOperations,
    args: (value) => {
      const row = GameInfo.Types.lookup(value);
      return row ? { GoldenAgeType: row.Hash } : null;
    },
    list: () => {
      try {
        const choices = player?.Culture?.getGoldenAgeChoices?.() ?? [];
        return (Array.isArray(choices) ? choices : []).map((name) => ({ name: String(name) }));
      } catch { return []; }
    },
    current: () => null,
  },
  pantheon: {
    // Founding a pantheon. BeliefType wants the belief's hash.
    scope: "player",
    operation: () => PlayerOperationTypes.FOUND_PANTHEON,
    api: () => Game.PlayerOperations,
    args: (value) => {
      const row = GameInfo.Types.lookup(value);
      return row ? { BeliefType: row.Hash } : null;
    },
    list: () => {
      const out = [];
      try {
        for (const belief of GameInfo.Beliefs ?? []) {
          if (belief.BeliefClassType && String(belief.BeliefClassType).includes("PANTHEON")) {
            out.push({ name: belief.BeliefType });
          }
        }
      } catch { /* the engine decides; an empty list just means nothing to pick */ }
      return out;
    },
    current: () => null,
  },
  belief: {
    // A belief for the player's religion (panel-belief-picker.ts addNextBelief): ADD_BELIEF with
    // the belief's hash, one at a time. NOTIFICATION_CHOOSE_BELIEF blocked a whole turn while an
    // agent drove the game's own picker through the generic screen reader, whose belief cards
    // carry no names — it clicked blind and the turn ran out.
    scope: "player",
    operation: () => PlayerOperationTypes.ADD_BELIEF,
    api: () => Game.PlayerOperations,
    args: (value) => {
      const row = GameInfo.Types.lookup(value);
      return row ? { BeliefType: row.Hash } : null;
    },
    list: () => {
      const out = [];
      try {
        for (const belief of GameInfo.Beliefs ?? []) {
          const cls = String(belief.BeliefClassType ?? "");
          if (cls.includes("PANTHEON")) continue; // those are `civ pantheon`
          let claimable = false;
          try { claimable = Game.Religion?.isBeliefClaimable?.(belief.BeliefType) === true; } catch { claimable = false; }
          if (!claimable) continue;
          out.push({
            name: belief.BeliefType,
            title: locText(belief.Name ?? null),
            does: `${shortName(cls) ?? "belief"}: ${locText(belief.Description ?? null) ?? ""}`,
            available: true,
          });
        }
      } catch { /* no religion API in this build */ }
      return out;
    },
    current: () => {
      try {
        const religion = Game.Religion?.getPlayerReligion?.(PLAYER_ID) ?? null;
        const held = religion?.getBeliefs?.() ?? [];
        return held.length > 0 ? `beliefs held: ${held.map((b) => typeName("Beliefs", b) ?? String(b)).join(", ")}` : null;
      } catch { return null; }
    },
  },
  religion: {
    // Founding a religion (panel-belief-picker.ts foundReligion): FOUND_RELIGION with the
    // religion's hash. The beliefs come after, through `civ belief`.
    scope: "player",
    operation: () => PlayerOperationTypes.FOUND_RELIGION,
    api: () => Game.PlayerOperations,
    args: (value) => {
      const row = GameInfo.Types.lookup(value);
      return row ? { ReligionType: row.Hash } : null;
    },
    list: () => {
      const out = [];
      try {
        for (const religion of GameInfo.Religions ?? []) {
          let taken = false;
          try { taken = Game.Religion?.hasBeenFounded?.(religion.ReligionType) === true; } catch { taken = false; }
          if (taken) continue;
          out.push({ name: religion.ReligionType, title: locText(religion.Name ?? null), available: true });
        }
      } catch { /* no religion API in this build */ }
      return out;
    },
    current: () => null,
  },
  attribute: {
    // Attribute points accumulate and are spent on tree nodes. Takes the node's ROW INDEX, not
    // its hash — another operation, another convention.
    scope: "player",
    operation: () => PlayerOperationTypes.BUY_ATTRIBUTE_TREE_NODE,
    api: () => Game.PlayerOperations,
    // What clears NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL. The game's attribute screen sends this
    // when it CLOSES (screen-attribute-trees.ts close()), buying or not — an agent that wanted to
    // bank its points had no way to say so, and the prompt blocked 30 turns, 24 never resolved.
    finish: () => ({
      operation: PlayerOperationTypes.CONSIDER_ASSIGN_ATTRIBUTE,
      args: {},
    }),
    args: (value) => {
      for (const node of GameInfo.ProgressionTreeNodes ?? []) {
        if (node.ProgressionTreeNodeType === value) return { ProgressionTreeNodeType: node.$index };
      }
      return null;
    },
    list: () => {
      const out = [];
      try {
        for (const node of GameInfo.ProgressionTreeNodes ?? []) {
          const args = { ProgressionTreeNodeType: node.$index };
          if (Game.PlayerOperations.canStart(PLAYER_ID, PlayerOperationTypes.BUY_ATTRIBUTE_TREE_NODE, args, false)?.Success === true) {
            out.push({ name: node.ProgressionTreeNodeType, available: true });
          }
        }
      } catch { /* nothing spendable */ }
      return out;
    },
    current: () => null,
  },
  capture: {
    // A settlement just taken must be kept, razed or handed back to its founder before the turn
    // ends (NOTIFICATION_CONSIDER_RAZE_CITY). The game's chooser sends CityCommandTypes.DESTROY
    // with a Directive (model-city-capture-chooser.ts); it is a HUD panel `civ screen` never
    // lists, and nothing here could send the command. In a domination match this fires on every
    // conquest.
    scope: "city",
    operation: () => CityCommandTypes.DESTROY,
    api: () => Game.CityCommands,
    args: (value) => {
      const directive = captureChoices()[String(value).toLowerCase()];
      return directive === undefined ? null : { Directive: directive };
    },
    list: () => {
      const city = findOwnCity(PLAYER_ID, TARGET_ID);
      if (!city) return [];
      return Object.entries(captureChoices()).map(([name, directive]) => {
        let check = null;
        try { check = Game.CityCommands.canStart(city.id, CityCommandTypes.DESTROY, { Directive: directive }, false); }
        catch { check = null; }
        const available = check?.Success === true;
        return { name, available, why: available ? null : needed(check) };
      });
    },
    current: () => null,
  },
  promote: {
    // A promotion needs BOTH hashes: the promotion and the discipline it belongs to
    // (panel-unit-promotion.ts). UNITCOMMAND_PROMOTE reached agents only inside the
    // "nothing here knows what arguments they take" block, so no unit was ever promoted — and
    // NOTIFICATION_UNIT_PROMOTION_AVAILABLE blocked turns that nothing could unblock.
    scope: "unit",
    operation: () => UnitCommandTypes.PROMOTE,
    api: () => Game.UnitCommands,
    // A promotion can appear under several disciplines, and only one pairing may be legal for
    // this unit. The old args() took the FIRST row matching the name, so the list could offer a
    // promotion the execution then sent with the wrong discipline and had refused. Test each
    // pairing with canStart, the same check the list uses.
    args: (name) => {
      const unit = findOwnUnit(PLAYER_ID, TARGET_ID);
      if (!unit) return null;
      for (const detail of promotionRows(unit)) {
        if (detail.UnitPromotionType !== name) continue;
        const gate = promotionGate(unit, detail.UnitPromotionDisciplineType, name);
        if (gate.ok) return gate.args;
      }
      // Not one the tree allows. The old fallback sent the first pairing anyway; canStart said
      // yes, the engine did nothing, and the agent read "ok" eleven times in one 480s turn.
      const legal = promotionChoices(unit).map((c) => c.name);
      return {
        __refuse: {
          code: "NOT_AVAILABLE",
          message: `${name} is not a promotion this unit can take now` +
            (legal.length > 0 ? `; it can take: ${legal.join(", ")}` : "; it has none to take"),
          hint: `\`civ promote ${TARGET_ID}\` lists the ones it can take, with what each does`,
        },
      };
    },
    list: () => {
      const unit = findOwnUnit(PLAYER_ID, TARGET_ID);
      return unit ? promotionChoices(unit) : [];
    },
    current: () => {
      const unit = findOwnUnit(PLAYER_ID, TARGET_ID);
      const xp = unit?.Experience;
      if (!xp) return null;
      // The engine's Experience getters are PROPERTIES, not methods — model-unit-promotion.ts reads
      // them with no parentheses. Calling them (getStoredPromotionPoints?.()) threw "is not a
      // function" and crashed the `civ promote <unit>` LIST path, so agents never saw their earned
      // promotions and invented names (13 NO_SUCH_THING failures downstream).
      const points = xp.getStoredPromotionPoints ?? 0;
      const level = xp.getLevel ?? null;
      return `level ${level ?? "?"}, ${points} promotion point${points === 1 ? "" : "s"} to spend, ` +
        `${xp.experiencePoints ?? 0}/${xp.experienceToNextLevel ?? "?"} xp`;
    },
  },
  tradition: {
    // Social policies, and the crisis cards an Age crisis deals you. Both are rows in
    // GameInfo.Traditions and both go through CHANGE_TRADITION, so the human's policy screen is
    // one screen and this is one command.
    //
    // `{ TraditionType: $index, Action: Activate|Deactivate }` — row index, not hash, plus the
    // enum. An agent that tried this by hand wrote "I need to figure out the correct syntax...
    // I'll keep experimenting", which is a turn spent on our argument shapes.
    scope: "player",
    operation: () => PlayerOperationTypes.CHANGE_TRADITION,
    api: () => Game.PlayerOperations,
    // A leading "-" drops a policy instead of adopting one. Slots are limited, so once they are
    // full the only legal move is to swap — and with no way to say "drop this", `civ tradition`
    // could only ever fail from that point on.
    args: (value) => {
      const drop = String(value).startsWith("-");
      const bare = drop ? String(value).slice(1) : String(value);
      // Accept the name with or without its TRADITION_ prefix. The drop hint says
      // `civ tradition -<name>`, and an agent that typed `-TOOL_MAKING` was told the tradition
      // did not exist while holding it.
      const wanted = bare.startsWith("TRADITION_") ? bare : `TRADITION_${bare}`;
      for (const t of GameInfo.Traditions ?? []) {
        if (t.TraditionType === bare || t.TraditionType === wanted) {
          return { TraditionType: t.$index, Action: drop ? DEACTIVATE : ACTIVATE };
        }
      }
      return null;
    },
    /**
     * Finishing with the policy screen, which is what CLEARS the notification.
     *
     * NOTIFICATION_TRADITIONS_AVAILABLE does not go away when you adopt something. The game's own
     * screen sends CONSIDER_ASSIGN_TRADITIONS when it CLOSES (model-policies.ts, onCleanup) —
     * that is the "I have looked at my policies" signal. Without it an agent adopts, sees the
     * blocker still there, adopts again, and cannot end its turn: 29 of 40 refused end-turns in
     * one run were this, with `civ tradition` tried ten times against a full board.
     */
    finish: () => ({
      operation: PlayerOperationTypes.CONSIDER_ASSIGN_TRADITIONS,
      args: {},
    }),
    list: () => {
      const culture = player?.Culture;
      if (!culture) return [];
      // Ask every slot kind and dedupe. Which query returns a card and which slot it ends up in
      // do not agree in this build — CHARISMATIC_LEADER comes back from the POLICY query and sits
      // in a TRADITION slot. The row's own CultureSlotType is the data table's answer and is the
      // one to show; the engine's counts are the one to trust for whether there is room.
      const seen = new Set();
      const out = [];
      // The policies actually held, so "no free slot" can name a concrete drop command instead
      // of a `-<name>` placeholder an agent then typed literally.
      const held = [];
      for (const [slot] of cultureSlots()) {
        try {
          for (const h of culture.getActiveTraditions?.(slot) ?? []) {
            const name = GameInfo.Traditions.lookup(h)?.TraditionType;
            if (name) held.push(name);
          }
        } catch { /* the placeholder hint still works */ }
      }
      const dropHint = held.length > 0
        ? `no free slot — drop one of yours first: ` +
          held.slice(0, 3).map((name) => `\`civ tradition -${name}\``).join(", ")
        : "no free slot — drop one with `civ tradition -<name>`";
      for (const [slot] of cultureSlots()) {
        let unlocked = [];
        try { unlocked = culture.getUnlockedTraditions?.(slot) ?? []; } catch { continue; }
        for (const hash of unlocked) {
          const def = GameInfo.Traditions.lookup(hash);
          if (!def || seen.has(def.TraditionType)) continue;
          seen.add(def.TraditionType);
          const active = culture.isTraditionActive?.(hash) === true;
          let available = active;
          if (!active) {
            try {
              available = Game.PlayerOperations.canStart(
                PLAYER_ID,
                PlayerOperationTypes.CHANGE_TRADITION,
                { TraditionType: def.$index, Action: ACTIVATE },
                false,
              )?.Success === true;
            } catch { available = false; }
          }
          out.push({
            name: def.TraditionType,
            // What the card is called and does on the human's screen. It is the whole basis for
            // choosing one, and the list used to carry neither.
            title: locText(def.Name),
            does: locText(def.Description),
            kind: def.IsCrisis ? "crisis" : def.CultureSlotType === "POLICY_CULTURE_SLOT" ? "policy" : "tradition",
            active,
            available,
            why: available || active ? null : dropHint,
          });
        }
      }
      return out;
    },
    // What the player actually holds, and how much room is left. The old version returned null,
    // so an agent could not see its own policies at all — it re-picked what it already had and
    // read the refusal as the command being broken.
    current: () => {
      const culture = player?.Culture;
      if (!culture) return null;
      const parts = [];
      for (const [slot, kind] of cultureSlots()) {
        let active = [];
        try { active = culture.getActiveTraditions?.(slot) ?? []; } catch { active = []; }
        let total = null;
        try { total = culture.getNumCultureSlots?.(slot) ?? null; } catch { total = null; }
        if (total === 0 && active.length === 0) continue;
        const names = active
          .map((h) => GameInfo.Traditions.lookup(h)?.TraditionType)
          .filter(Boolean);
        parts.push(`${kind} ${active.length}/${total ?? "?"}${names.length ? `: ${names.join(", ")}` : ""}`);
      }
      return parts.length > 0 ? parts.join(" | ") : null;
    },
  },

  age: {
    // The Age boundary has TWO steps, and this decision covers both.
    //
    // `finish`: the transition itself — { Finished: true }, the one call the game's own
    // age-transition screen makes once the civ pick is made (agefinish.js makes it for you).
    //
    // A CARD: the new Age's dedications. The dedication screen is a deck of "advanced start"
    // cards: ADVANCED_START_MODIFY_DECK adds or removes one, then USE_EFFECT per card effect and
    // ADVANCED_START_MARK_COMPLETED close it (legacies-support.ts, dedications-model.ts). None
    // of that had a command: `civ age` printed nothing while end-turn demanded `civ age finish`,
    // and agents drove the screen by hand 44 times with truncated control labels.
    scope: "player",
    operation: (value) =>
      String(value).toLowerCase() === "finish"
        ? PlayerOperationTypes.SET_AGE_TRANSITION_DATA
        : PlayerOperationTypes.ADVANCED_START_MODIFY_DECK,
    api: () => Game.PlayerOperations,
    args: (value) => {
      const typed = String(value).trim();
      if (typed.toLowerCase() === "finish") return { Finished: true };
      const drop = typed.startsWith("-");
      const id = drop ? typed.slice(1) : typed;
      const known = dedicationCards().some((card) => card.id === id) || deckCards().includes(id);
      return known ? { Type: drop ? "REMOVE" : "ADD", ID: id } : null;
    },
    list: () => {
      const out = [];
      // Offer the transition only when the engine will accept it, so it never appears as a dead option.
      let allowed = false;
      try {
        allowed = Game.PlayerOperations.canStart(PLAYER_ID, PlayerOperationTypes.SET_AGE_TRANSITION_DATA, { Finished: true }, false)?.Success === true;
      } catch { allowed = false; }
      if (allowed) out.push({ name: "finish", title: "submit the Age transition (the civilization pick is made for you)", available: true });
      const deck = deckCards();
      for (const card of dedicationCards()) {
        const held = deck.includes(card.id);
        let can = false;
        try {
          can = Game.PlayerOperations.canStart(PLAYER_ID, PlayerOperationTypes.ADVANCED_START_MODIFY_DECK, { Type: "ADD", ID: card.id }, false)?.Success === true;
        } catch { can = false; }
        out.push({ name: card.id, title: card.title, does: card.does, available: held || can, active: held, why: held || can ? null : "not affordable or the deck is full" });
      }
      return out;
    },
    current: () => {
      const deck = deckCards();
      const points = legacyPoints();
      if (deck.length === 0 && points.length === 0) return null;
      return `${deck.length > 0 ? `dedications chosen: ${deck.join(", ")}` : "no dedication chosen yet"}` +
        (points.length > 0 ? `; points to spend: ${points.join(", ")}` : "");
    },
    // Closing the dedication screen: use every effect of every card in the deck, keep the
    // capital, then mark the deck complete — confirmDeck() in dedications-model.ts, in order.
    finish: () => {
      const start = player?.AdvancedStart;
      const ops = Game.PlayerOperations;
      try {
        for (const card of start?.getCards?.() ?? []) {
          for (const effect of card?.info?.effects ?? []) {
            for (let i = 0; i < (effect?.amount ?? 1); i++) {
              const args = { ID: effect.id };
              if (ops.canStart(PLAYER_ID, PlayerOperationTypes.ADVANCED_START_USE_EFFECT, args, false)?.Success === true) {
                ops.sendRequest(PLAYER_ID, PlayerOperationTypes.ADVANCED_START_USE_EFFECT, args);
              }
            }
          }
        }
        const capital = player?.Cities?.getCapital?.();
        if (capital?.id && PlayerOperationTypes.SELECT_CAPITAL !== undefined) {
          const swap = player.previousAgeCivilizationType !== undefined && player.previousAgeCivilizationType !== player.civilizationType;
          const args = { Player1: PLAYER_ID, City: capital.id.id ?? capital.id, Swap: swap };
          if (ops.canStart(PLAYER_ID, PlayerOperationTypes.SELECT_CAPITAL, args, false)?.Success === true) {
            ops.sendRequest(PLAYER_ID, PlayerOperationTypes.SELECT_CAPITAL, args);
          }
        }
      } catch { /* the mark-completed below is what the notification waits on */ }
      return { operation: PlayerOperationTypes.ADVANCED_START_MARK_COMPLETED, args: {} };
    },
  },
  government: {
    // Row index, not hash, plus an Action enum — a different convention again.
    scope: "player",
    operation: () => PlayerOperationTypes.CHANGE_GOVERNMENT,
    api: () => Game.PlayerOperations,
    // Accept the short form too: CLASSICAL_REPUBLIC means GOVERNMENT_CLASSICAL_REPUBLIC.
    args: (name) => {
      const wanted = String(name).toUpperCase();
      for (const def of GameInfo.Governments ?? []) {
        if (def.GovernmentType === wanted || def.GovernmentType === `GOVERNMENT_${wanted}`) {
          return { GovernmentType: def.$index, Action: ACTIVATE };
        }
      }
      return null;
    },
    list: () => tableRows(GameInfo.Governments).map((d) => ({
      name: d.GovernmentType,
      title: locText(d.Name),
      does: locText(d.Description),
    })),
    current: () => {
      try {
        const h = player?.Culture?.getGovernmentType?.();
        return h === null || h === undefined || h === -1 ? null : GameInfo.Governments.lookup(h)?.GovernmentType ?? null;
      } catch { return null; }
    },
  },
};

/** The story waiting on this player, or null. */
function pendingStoryId() {
  const stories = player?.Stories;
  try { return stories?.getFirstPendingMetId?.() ?? stories?.getFirstPendingDiscoveryLastMetID?.() ?? null; }
  catch { return null; }
}

function storyDefinition() {
  const id = pendingStoryId();
  if (!id) return null;
  try {
    const story = player.Stories.find(id);
    return story ? GameInfo.NarrativeStories.lookup(story.type) ?? null : null;
  } catch { return null; }
}

function storyName() {
  return storyDefinition()?.NarrativeStoryType ?? null;
}

/** The answers to the pending story. A story with no links can only be closed. */
function storyChoices() {
  const def = storyDefinition();
  if (!def) return [];
  const links = [];
  try {
    for (const link of GameInfo.NarrativeStory_Links ?? []) {
      if (link.FromNarrativeStoryType !== def.NarrativeStoryType) continue;
      // The option TEXT, so an answer is a choice rather than an opaque id. Ids churn per story
      // instance, and a bare id list taught agents to remember ids that would never be valid
      // again.
      let title = null;
      let does = null;
      try {
        const target = GameInfo.NarrativeStories.lookup(Database.makeHash(link.ToNarrativeStoryType));
        title = locText(target?.Name ?? null);
        // A completion text the game has no string for comes back as its LOC key; that told an
        // agent nothing (105 of 129 option lines). Fall back to the description, then to nothing.
        does = [target?.Completion, target?.Description]
          .map((text) => locText(text ?? null))
          .find((text) => text && !String(text).startsWith("LOC_")) ?? null;
      } catch { /* id alone is still an answer */ }
      links.push({ name: link.ToNarrativeStoryType, title, does });
    }
  } catch { /* fall through to CLOSE */ }
  return links.length > 0 ? links : [{ name: "CLOSE" }];
}

/** A promotion and the discipline it belongs to — the pair UNITCOMMAND_PROMOTE needs. */
function promotionDetail(name) {
  for (const detail of tableRows(GameInfo.UnitPromotionDisciplineDetails)) {
    if (detail.UnitPromotionType === name) {
      return { promotion: name, discipline: detail.UnitPromotionDisciplineType };
    }
  }
  return null;
}

/** The engine's own words for why something is unavailable. */
/** The dedication cards on offer at the start of an Age, by id, with their text. */
function dedicationCards() {
  const out = [];
  try {
    const start = player?.AdvancedStart;
    if (start?.getPlacementComplete?.() === true) return out;
    for (const card of start?.getAvailableCards?.() ?? []) {
      if (!card?.id) continue;
      out.push({ id: String(card.id), title: cardText(card.name), does: cardText(card.description) });
    }
  } catch { /* no Age boundary */ }
  return out;
}

/** The ids already in the dedication deck. */
function deckCards() {
  try { return (player?.AdvancedStart?.getCards?.() ?? []).map((card) => String(card?.info?.id ?? card?.id ?? "")).filter(Boolean); }
  catch { return []; }
}

/** Legacy points still unspent, as "category N". */
function legacyPoints() {
  try {
    return (player?.AdvancedStart?.getLegacyPoints?.() ?? [])
      .filter((point) => (point?.value ?? 0) > 0)
      .map((point) => `${shortName(String(point.category ?? "")) || point.category} ${point.value}`);
  } catch { return []; }
}

/** Card text is a LOC key, or an array whose first element is the key and the rest its arguments. */
function cardText(value) {
  if (Array.isArray(value)) {
    try { return Locale.compose(...value.map((part) => (typeof part === "string" && part.startsWith("LOC_") ? Locale.compose(part) : part))); }
    catch { return value[0] ?? null; }
  }
  return locText(value ?? null);
}

/** The three answers to a conquest, by the word an agent types. */
function captureChoices() {
  if (typeof DirectiveTypes === "undefined") return {};
  return { keep: DirectiveTypes.KEEP, raze: DirectiveTypes.RAZE, liberate: DirectiveTypes.LIBERATE_FOUNDER };
}

function needed(result) {
  const req = result?.Requirements;
  if (req?.NeededPopulation) return `needs population ${req.NeededPopulation}`;
  const node = req?.NeededProgressionTreeNode;
  if (node) {
    const info = GameInfo.ProgressionTreeNodes.lookup(node);
    if (info) return `needs ${info.ProgressionTreeNodeType}`;
  }
  if (result?.InsufficientFunds) return "not enough gold";
  return "not available yet";
}

/** Available nodes on a progression tree, as names with their cost. */
function nodeList(tree) {
  const out = [];
  for (const nodeType of tree?.getAllAvailableNodeTypes?.() ?? []) {
    const def = GameInfo.ProgressionTreeNodes.lookup(nodeType);
    if (!def) continue;
    out.push({
      name: def.ProgressionTreeNodeType,
      title: locText(def.Name ?? null) || null,
      // What it unlocks, on the line. Agents read ProgressionTreeNodeUnlocks.json 179 times in
      // one night to learn this, and forgot it two turns later each time.
      does: unlocksOf(def.ProgressionTreeNodeType),
      turns: tree.getTurnsForNode?.(nodeType) ?? null,
    });
  }
  return out;
}

/** "unlocks: brickyard, granary" for a tech or civic — the names, modifiers left out. */
function unlocksOf(nodeType) {
  const names = [];
  try {
    for (const row of tableRows(GameInfo.ProgressionTreeNodeUnlocks)) {
      if (row.ProgressionTreeNodeType !== nodeType || row.Hidden || !row.TargetType) continue;
      if (row.TargetKind === "KIND_MODIFIER") continue;
      const short = shortName(row.TargetType);
      if (short && !names.includes(short)) names.push(short);
    }
  } catch { /* no unlock table */ }
  return names.length > 0 ? `unlocks ${names.join(", ")}` : null;
}

/** What a tree is working on. getResearching() returns an OBJECT whose .type is the hash. */
function nodeName(tree) {
  try {
    const active = tree?.getResearching?.();
    if (!active || active.type === undefined) return null;
    return GameInfo.ProgressionTreeNodes.lookup(active.type)?.ProgressionTreeNodeType ?? null;
  } catch { return null; }
}

// Answer whatever is holding a turn open, without being told which decision it is.
//
// A forced end-turn used to DISMISS the blocking notification. That clears an informational one —
// a natural wonder found — and does nothing at all to one that exists to make you decide.
// NOTIFICATION_TRADITIONS_AVAILABLE is not dismissible: the loop dismissed it eight times,
// sendTurnComplete was ignored with no error, and the match sat waiting on a turn that nothing
// could ever end. A decision has to be ANSWERED.
//
// Picking the first legal option is deliberate. By the time this runs the agent has already
// failed to choose, so any legal answer beats a stalled match — and the agent can change it next
// turn. It is not a substitute for the agent choosing; `civ tradition` is.
const BLOCKER_DECISIONS = [
  // A crisis deals policy CARDS into crisis culture slots, so the policy chooser answers it.
  // Listed before the generic TRADITION row only for readability; both route to the same place.
  // Without this row a crisis blocked the turn AND the forced clear had no answer for it —
  // 86 blocked turns across the runs, never once resolved.
  [/CRISIS/, "tradition"],
  [/TRADITION|POLICY|POLICIES/, "tradition"],
  [/GOVERNMENT/, "government"],
  [/PANTHEON/, "pantheon"],
  [/BELIEF/, "belief"],
  [/FOUND_RELIGION|CHOOSE_RELIGION/, "religion"],
  [/ATTRIBUTE/, "attribute"],
  [/NARRATIVE|STORY/, "story"],
  [/CELEBRATION|GOLDEN/, "celebration"],
  [/CIVIC|CULTURE/, "civic"],
  [/TECH|RESEARCH/, "tech"],
  // Not a bare /AGE/: that matched VILLAGE, PILLAGE and DAMAGE, and the misclassification hid
  // the real blocker. required.ts uses the same safe pattern.
  [/AGE_TRANSITION|AGE_ENDED|CHOOSE_AGE|ADVANCED_START|DEDICATION/, "age"],
  // Settlement- and unit-scoped decisions, with the finder that names their subject. These
  // came back NEEDS_A_TARGET before, which the forced end-turn could do nothing with: a citizen
  // to place, an empty build queue, a town focus, a promotion or a conquest each stalled the
  // seat until the harness answered "?" and gave up.
  [/RAZE_CITY/, "capture", () => justConqueredCity(PLAYER_ID)?.id ?? null],
  [/TOWN_PROJECT/, "build", () => {
    for (const cid of player?.Cities?.getCityIds?.() ?? []) {
      const city = Cities.get(cid);
      if (city?.isTown && townFocusChoices(city).length > 0) return String(cid.id ?? cid);
    }
    return null;
  }],
  [/CITY_PRODUCTION|CHOOSE_PRODUCTION/, "build", () => {
    for (const cid of player?.Cities?.getCityIds?.() ?? []) {
      const queue = Cities.get(cid)?.BuildQueue;
      let empty = false;
      try { empty = queue?.isEmpty === true || (queue?.getQueue?.() ?? []).length === 0; } catch { empty = false; }
      if (empty) return String(cid.id ?? cid);
    }
    return null;
  }],
  [/NEW_POPULATION|POPULATION_GROWTH/, "expand", () => {
    for (const cid of player?.Cities?.getCityIds?.() ?? []) {
      if (expandPlots(cid).length > 0) return String(cid.id ?? cid);
    }
    return null;
  }],
  [/UNIT_PROMOTION|PROMOTION_AVAILABLE/, "promote", () => {
    for (const cid of player?.Units?.getUnitIds?.() ?? []) {
      const xp = Units.get(cid)?.Experience;
      let can = false;
      try { can = xp?.canPromote === true || (xp?.getStoredPromotionPoints ?? 0) > 0; } catch { can = false; }
      if (can) return String(cid.id ?? cid);
    }
    return null;
  }],
];

// `typeof` because the adapter declares a const only for the values it was given, and the two
// ordinary `civ <what>` call sites do not pass this one.
if (typeof BLOCKER !== "undefined" && BLOCKER) {
  const match = BLOCKER_DECISIONS.find(([pattern]) => pattern.test(String(BLOCKER)));
  if (!match) return { ok: false, code: "NO_AUTO_ANSWER", blocker: BLOCKER };
  const what = match[1];
  const auto = DECISIONS[what];
  // A city- or unit-scoped decision needs to know WHICH subject, and a blocker name does not
  // say. The row's finder names it; the caller then lists that subject's options and picks one.
  if (auto.scope !== "player") {
    const target = match[2]?.() ?? null;
    return { ok: false, code: "NEEDS_A_TARGET", what, blocker: BLOCKER, target };
  }

  const tried = [];
  for (const item of auto.list?.() ?? []) {
    if (item.available === false) continue;
    const autoArgs = auto.args(item.name);
    if (!autoArgs) continue;
    tried.push(item.name);
    const attempt = startOperation(auto.api(), PLAYER_ID, auto.operation(item.name), autoArgs);
    if (attempt.ok) {
      // Adopting is not the same as being finished. Close the consideration too, or the blocker
      // survives the answer and the turn still cannot end.
      if (auto.finish) {
        const closing = auto.finish();
        if (closing.operation !== undefined) {
          startOperation(auto.api(), PLAYER_ID, closing.operation, closing.args);
        }
      }
      return { ok: true, answered: what, picked: item.name, blocker: BLOCKER };
    }
  }
  // Nothing could be adopted — a full board, most likely. Saying "I am finished" is still a
  // legitimate answer to "you have policies available", and it is the one that clears the turn.
  if (auto.finish) {
    const closing = auto.finish();
    if (closing.operation !== undefined) {
      const done = startOperation(auto.api(), PLAYER_ID, closing.operation, closing.args);
      if (done.ok) return { ok: true, answered: what, picked: "(nothing — finished)", blocker: BLOCKER };
    }
  }
  return { ok: false, code: "NO_OPTION_WORKED", what, blocker: BLOCKER, tried };
}

const decision = DECISIONS[WHAT];
if (!decision) {
  return { ok: false, code: "NO_SUCH_DECISION", message: `unknown decision: ${WHAT}`, options: Object.keys(DECISIONS) };
}

// No value named: say what can be picked, and never show a hash.
if (!THING) {
  const options = [];
  for (const item of decision.list?.() ?? []) {
    // Only ask when the list did not already answer. Recomputing here overwrote the build query's
    // own verdict, so an item reported "available" and "needs population 3" in the same breath.
    if (item.available !== undefined) {
      options.push(item);
      continue;
    }
    let available = true;
    const args = decision.args(item.name);
    if (args) {
      try { available = decision.api().canStart(PLAYER_ID, decision.operation(), args, false)?.Success === true; }
      catch { available = false; }
    }
    options.push({ ...item, available });
  }
  // current() reads live game state; guard it so a bad getter can never crash the whole listing —
  // the command must still return the options an agent needs.
  let current = null;
  try { current = decision.current?.() ?? null; } catch { current = null; }
  const result = { ok: true, listing: true, current, options };
  // Say in plain words why a town's list is so short.
  if (WHAT === "build" && findOwnCity(PLAYER_ID, TARGET_ID)?.isTown) {
    result.note = "this is a town: the only thing a town builds is its focus. Its units and buildings " +
      "are bought with gold — `civ buy " + String(TARGET_ID) + "` lists what it can buy";
  }
  return result;
}

// "done" closes a decision the agent has finished with, where the game has such a step.
if (decision.finish && String(THING).toLowerCase() === "done") {
  const closing = decision.finish();
  if (closing.operation === undefined) {
    return { ok: false, code: "NO_SUCH_OPERATION", message: `this build cannot close ${WHAT}` };
  }
  const done = startOperation(decision.api(), PLAYER_ID, closing.operation, closing.args);
  if (done.ok) done.note = `finished with ${WHAT}`;
  return done;
}

const args = decision.args(THING);
if (args && args.__refuse) return { ok: false, ...args.__refuse };
if (!args) {
  // Name what there IS. "This game has no story named DISCOVERY_24001C" is true and useless: the
  // agent invented the name because it had no list, and a hint that says "run the command again
  // with no value" spends another action to learn something this call already knows.
  let options = [];
  try { options = (decision.list?.() ?? []).map((item) => item.name); } catch { options = []; }
  // Story ids are per-instance: an id from an earlier story WAS valid when the harness printed
  // it. "This game has no story named X" read as a contradiction, because the hint had offered
  // that exact id a turn before. Say what actually happened.
  // A unit or building named for a town. "This game has no build named UNIT_SCOUT" is false and
  // sends the agent to try another unit.
  let townRefusal = null;
  if (WHAT === "build") {
    const kind = GameInfo.Types.lookup(THING)?.Kind;
    const city = findOwnCity(PLAYER_ID, TARGET_ID);
    if (city?.isTown && (kind === "KIND_UNIT" || kind === "KIND_CONSTRUCTIBLE")) {
      townRefusal = `${locText(city.name ?? null) || `settlement ${TARGET_ID}`} is a town, and a town builds ` +
        `no units or buildings — it buys them with gold: \`civ buy ${TARGET_ID} ${THING}\`. ` +
        `The only thing to BUILD in a town is its focus`;
    }
  }
  const message = townRefusal ? townRefusal : WHAT === "story"
    ? `${THING} is not an answer to the story waiting on you` +
      (storyName() ? ` (${storyName()})` : "") +
      ` — story ids are new for every story, so an id from an earlier one is never valid again`
    : WHAT === "tradition" && String(THING).startsWith("-")
      ? `you hold no tradition named ${String(THING).slice(1)} to drop`
      : `this game has no ${WHAT} named ${THING}`;
  return {
    ok: false,
    code: "NO_SUCH_THING",
    message,
    hint: options.length > 0
      ? `you can pick: ${options.slice(0, 12).join(", ")}` +
        (options.length > 12 ? `, and ${options.length - 12} more` : "")
      : `run \`civ ${WHAT}\` with no value to see what there is`,
  };
}

const target =
  decision.scope === "city" ? findOwnCity(PLAYER_ID, TARGET_ID)?.id
  : decision.scope === "unit" ? findOwnUnit(PLAYER_ID, TARGET_ID)?.id
  : PLAYER_ID;
if (decision.scope === "city" && !target) {
  return { ok: false, code: "NO_SUCH_CITY", message: `settlement ${TARGET_ID} not found for p${PLAYER_ID}` };
}
if (decision.scope === "unit" && !target) {
  return { ok: false, code: "NO_SUCH_UNIT", message: `you have no unit ${TARGET_ID}` };
}

const result = startOperation(decision.api(), target, decision.operation(THING), args);
if (!result.ok) {
  // A refusal the engine will not explain, on a decision whose list already knows the answer.
  // `civ tradition X` was refused with "no reason" while `civ tradition` was saying, in the same
  // breath, that every slot was full. Ask the list.
  const options = decision.list?.() ?? [];
  const listed = options.find((item) => item.name === THING);
  // "Not enough gold" with no price sent agents guessing; the list knows the price.
  if (listed?.why) {
    result.message = listed.why;
    if (WHAT === "buy" && listed.cost !== null && listed.cost !== undefined) {
      result.message += ` — it costs ${listed.cost} gold and you have ${Math.floor(player?.Treasury?.goldBalance ?? 0)}`;
    }
  }
  else if (listed?.active) result.message = `you already have ${THING}`;
  else if (!listed && options.length === 0 && WHAT === "expand") {
    // No plots at all means no citizen is waiting, not a badly chosen plot. Saying "26,25 is not
    // one of your options" invites another guess; saying there is nobody to place ends it.
    result.message = `${THING} is not available: this settlement has no citizen waiting to be placed`;
    result.hint = "a settlement grows every few turns; the turn will tell you when one is ready";
  } else if (!listed && options.length > 0) {
    // Not on the list at all. `civ expand` was refused four times in a row for tiles the city
    // could never have grown to, each answered "the game refused this action and gave no reason",
    // while the list of tiles it COULD grow to was one call away.
    const available = options.filter((item) => item.available !== false).map((item) => item.name);
    result.message = `${THING} is not one of your options for ${WHAT}`;
    // "Not one of your options" invites another guess when the real answer is "you already own
    // it" — an agent re-tried a tile it had expanded onto seven turns earlier.
    if (WHAT === "expand") {
      const m = /^(\d+)\s*,\s*(\d+)$/.exec(String(THING).trim());
      try {
        if (m && GameplayMap.getOwner(Number(m[1]), Number(m[2])) === PLAYER_ID) {
          result.message = `you already own ${THING} — a citizen goes onto a NEW plot`;
        }
      } catch { /* the generic message stands */ }
    }
    if (available.length > 0) {
      result.hint = `you can pick: ${available.slice(0, 12).join(", ")}` +
        (available.length > 12 ? `, and ${available.length - 12} more` : "");
    }
  }
  if (WHAT === "age") {
    // `civ age finish` was refused 59 times in one run, 46 of them repeats: the seat had already
    // finished, the transition's dedication screen stood open, and "no reason" sent it back to
    // the same command. Say what is left.
    const open = typeof screenInventory === "function" ? screenInventory() : [];
    const cards = dedicationCards();
    result.message = "the Age transition has nothing left for you to submit — it is already finished for " +
      "your seat, or it has not begun";
    result.hint = cards.length > 0
      ? `the new Age's dedications are what is waiting: \`civ age\` lists them, \`civ age <CARD>\` picks one (up to three), \`civ age done\` closes the choice`
      : open.length > 0
      ? `a screen is waiting on you instead: \`civ screen ${open[open.length - 1].id}\``
      : "check /current/pending.txt for what the game is waiting on";
  }
  if (!result.hint) result.hint = `run \`civ ${WHAT}\` with no value to see what there is`;
  return result;
}

// No state claim: see act.js. Reading back on this line gives the state BEFORE the engine applied
// the request, and reporting it has misled agents in three separate ways already. `civ <what>`
// with no value reads the truth a moment later, and so do the files under /current.
// `build` appends to a queue; every other decision replaces a single choice. Saying "set to"
// for a build was how an agent came to believe its order had been ignored.
if (decision.after) {
  try { decision.after(target, args); } catch { /* the notification says whether it cleared */ }
}
result.note =
  WHAT === "build" ? `${THING} added to the build queue`
  : WHAT === "buy" ? `purchase of ${THING} sent`
  : WHAT === "story" ? `story answered with ${THING}`
  : `${WHAT} set to ${THING}`;
return result;
