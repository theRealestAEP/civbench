// Runs inside Civ 7. Every "pick a thing" decision, in one place.
//
// Civ hashes each type string to an int, and operations disagree on which encoding they want:
// CITYOPERATION_BUILD wants GameInfo.Types .Hash under a key that depends on what the thing IS,
// while CHANGE_GOVERNMENT wants a table ROW INDEX plus an Action enum. There is no introspection,
// so somewhere has to know. This is the only place that does.
//
// It replaced build.js, research.js and government.js — three scripts with the same shape and
// three chances to get it subtly wrong. Adding a decision is a row in DECISIONS, not a new file.
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
    // What this settlement can build right now. canStartQuery returns [{ index, result }] where
    // index is a row index into GameInfo — not a hash, and there is no .Items wrapper.
    list: () => {
      const out = [];
      const city = findOwnCity(PLAYER_ID, TARGET_ID);
      if (!city || typeof CityQueryType === "undefined") return out;
      for (const [query, table, field] of [
        [CityQueryType.Unit, "Units", "UnitType"],
        [CityQueryType.Constructible, "Constructibles", "ConstructibleType"],
        [CityQueryType.Project, "Projects", "ProjectType"],
      ]) {
        let rows = [];
        try { rows = Game.CityOperations.canStartQuery(city.id, CityOperationTypes.BUILD, query) ?? []; }
        catch { rows = []; }
        for (const row of rows) {
          if (row?.result?.Requirements?.FullFailure || row?.result?.Requirements?.Obsolete) continue;
          const def = GameInfo[table]?.lookup?.(row?.index);
          if (!def?.[field]) continue;
          out.push({
            name: def[field],
            turns: city.BuildQueue?.getTurnsLeft?.(def[field]) ?? null,
            available: row?.result?.Success === true,
            why: row?.result?.Success ? null : needed(row?.result),
          });
        }
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
      if (row.Kind === "KIND_UNIT") return { UnitType: row.Hash };
      for (const [table, key] of [["Constructibles", "ConstructibleType"], ["Projects", "ProjectType"]]) {
        for (const def of GameInfo[table] ?? []) {
          if (def[key] !== name) continue;
          const base = { [key]: def.$index };
          // Projects are placed by the engine; only constructibles want a plot.
          if (key !== "ConstructibleType") return base;
          const city = findOwnCity(PLAYER_ID, TARGET_ID);
          if (!city) return base;
          let check = null;
          try { check = Game.CityOperations.canStart(city.id, CityOperationTypes.BUILD, base, false); }
          catch { check = null; }
          const plots = check?.Plots ?? [];
          if (plots.length === 0) return base;
          // An explicit "THING at x,y" wins when the agent named one and it is legal.
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
        }
      }
      return null;
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
  attribute: {
    // Attribute points accumulate and are spent on tree nodes. Takes the node's ROW INDEX, not
    // its hash — another operation, another convention.
    scope: "player",
    operation: () => PlayerOperationTypes.BUY_ATTRIBUTE_TREE_NODE,
    api: () => Game.PlayerOperations,
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
      let fallback = null;
      for (const detail of tableRows(GameInfo.UnitPromotionDisciplineDetails)) {
        if (detail.UnitPromotionType !== name) continue;
        const candidate = {
          PromotionType: Database.makeHash(name),
          PromotionDisciplineType: Database.makeHash(detail.UnitPromotionDisciplineType),
        };
        fallback ??= candidate;
        if (!unit) continue;
        try {
          if (Game.UnitCommands.canStart(unit.id, UnitCommandTypes.PROMOTE, candidate, false)?.Success === true) {
            return candidate;
          }
        } catch { /* try the next discipline */ }
      }
      return fallback;
    },
    list: () => {
      const unit = findOwnUnit(PLAYER_ID, TARGET_ID);
      if (!unit) return [];
      const seen = new Set();
      const out = [];
      for (const detail of tableRows(GameInfo.UnitPromotionDisciplineDetails)) {
        const name = detail.UnitPromotionType;
        if (!name || seen.has(name)) continue;
        const args = {
          PromotionType: Database.makeHash(name),
          PromotionDisciplineType: Database.makeHash(detail.UnitPromotionDisciplineType),
        };
        let available = false;
        try { available = Game.UnitCommands.canStart(unit.id, UnitCommandTypes.PROMOTE, args, false)?.Success === true; }
        catch { available = false; }
        if (!available) continue;
        seen.add(name);
        const def = GameInfo.UnitPromotions?.lookup?.(Database.makeHash(name));
        out.push({ name, title: locText(def?.Name ?? null), does: locText(def?.Description ?? null), available: true });
      }
      return out;
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
    // Finishing an Age transition. The only call the game's own age-transition screen makes is
    // { Finished: true } — the civ and bonus picks go through their own choosers first, and this
    // says "I am done". Nothing else takes an argument, so this decision takes no value.
    scope: "player",
    operation: () => PlayerOperationTypes.SET_AGE_TRANSITION_DATA,
    api: () => Game.PlayerOperations,
    args: () => ({ Finished: true }),
    list: () => {
      // Offer it only when the engine will accept it, so it never appears as a dead option.
      let allowed = false;
      try {
        allowed = Game.PlayerOperations.canStart(PLAYER_ID, PlayerOperationTypes.SET_AGE_TRANSITION_DATA, { Finished: true }, false)?.Success === true;
      } catch { allowed = false; }
      return allowed ? [{ name: "finish", available: true }] : [];
    },
    current: () => null,
  },
  government: {
    // Row index, not hash, plus an Action enum — a different convention again.
    scope: "player",
    operation: () => PlayerOperationTypes.CHANGE_GOVERNMENT,
    api: () => Game.PlayerOperations,
    args: (name) => {
      for (const def of GameInfo.Governments ?? []) {
        if (def.GovernmentType === name) return { GovernmentType: def.$index, Action: ACTIVATE };
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
        does = locText(target?.Completion ?? target?.Description ?? null);
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
    if (def) out.push({ name: def.ProgressionTreeNodeType, turns: tree.getTurnsForNode?.(nodeType) ?? null });
  }
  return out;
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
  [/ATTRIBUTE/, "attribute"],
  [/NARRATIVE|STORY/, "story"],
  [/CELEBRATION|GOLDEN/, "celebration"],
  [/CIVIC|CULTURE/, "civic"],
  [/TECH|RESEARCH/, "tech"],
  // Not a bare /AGE/: that matched VILLAGE, PILLAGE and DAMAGE, and the misclassification hid
  // the real blocker. required.ts uses the same safe pattern.
  [/AGE_TRANSITION|AGE_ENDED|CHOOSE_AGE/, "age"],
];

// `typeof` because the adapter declares a const only for the values it was given, and the two
// ordinary `civ <what>` call sites do not pass this one.
if (typeof BLOCKER !== "undefined" && BLOCKER) {
  const match = BLOCKER_DECISIONS.find(([pattern]) => pattern.test(String(BLOCKER)));
  if (!match) return { ok: false, code: "NO_AUTO_ANSWER", blocker: BLOCKER };
  const what = match[1];
  const auto = DECISIONS[what];
  // A city-scoped decision needs to know WHICH settlement, and a blocker name does not say.
  if (auto.scope !== "player") return { ok: false, code: "NEEDS_A_TARGET", what, blocker: BLOCKER };

  const tried = [];
  for (const item of auto.list?.() ?? []) {
    if (item.available === false) continue;
    const autoArgs = auto.args(item.name);
    if (!autoArgs) continue;
    tried.push(item.name);
    const attempt = startOperation(auto.api(), PLAYER_ID, auto.operation(), autoArgs);
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
  return { ok: true, listing: true, current, options };
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
if (!args) {
  // Name what there IS. "This game has no story named DISCOVERY_24001C" is true and useless: the
  // agent invented the name because it had no list, and a hint that says "run the command again
  // with no value" spends another action to learn something this call already knows.
  let options = [];
  try { options = (decision.list?.() ?? []).map((item) => item.name); } catch { options = []; }
  // Story ids are per-instance: an id from an earlier story WAS valid when the harness printed
  // it. "This game has no story named X" read as a contradiction, because the hint had offered
  // that exact id a turn before. Say what actually happened.
  const message = WHAT === "story"
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

const result = startOperation(decision.api(), target, decision.operation(), args);
if (!result.ok) {
  // A refusal the engine will not explain, on a decision whose list already knows the answer.
  // `civ tradition X` was refused with "no reason" while `civ tradition` was saying, in the same
  // breath, that every slot was full. Ask the list.
  const options = decision.list?.() ?? [];
  const listed = options.find((item) => item.name === THING);
  if (listed?.why) result.message = listed.why;
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
  if (!result.hint) result.hint = `run \`civ ${WHAT}\` with no value to see what there is`;
  return result;
}

// No state claim: see act.js. Reading back on this line gives the state BEFORE the engine applied
// the request, and reporting it has misled agents in three separate ways already. `civ <what>`
// with no value reads the truth a moment later, and so do the files under /current.
// `build` appends to a queue; every other decision replaces a single choice. Saying "set to"
// for a build was how an agent came to believe its order had been ignored.
result.note =
  WHAT === "build" ? `${THING} added to the build queue`
  : WHAT === "story" ? `story answered with ${THING}`
  : `${WHAT} set to ${THING}`;
return result;
