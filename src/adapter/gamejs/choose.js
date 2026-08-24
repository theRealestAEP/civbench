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
    current: () => {
      const city = findOwnCity(PLAYER_ID, TARGET_ID);
      const h = city?.BuildQueue?.currentProductionTypeHash;
      if (!h || h === -1) return null;
      return typeName("Units", h) ?? typeName("Constructibles", h) ?? typeName("Projects", h);
    },
    operation: () => CityOperationTypes.BUILD,
    api: () => Game.CityOperations,
    args: (name) => {
      const row = GameInfo.Types.lookup(name);
      const key = { KIND_UNIT: "UnitType", KIND_CONSTRUCTIBLE: "ConstructibleType", KIND_PROJECT: "ProjectType" }[row?.Kind];
      return key ? { [key]: row.Hash } : null;
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
      // Ask the engine about the plots around the city rather than guessing which are claimable.
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          const x = at.x + dx;
          const y = at.y + dy;
          if (x < 0 || y < 0) continue;
          let ok = false;
          try { ok = Game.CityCommands.canStart(city.id, CityCommandTypes.EXPAND, { X: x, Y: y }, false)?.Success === true; }
          catch { ok = false; }
          if (ok) out.push({ name: `${x},${y}`, available: true });
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
      return target ? { TargetType: value, Target: target, Action: ACTIVATE } : null;
    },
    list: () => storyChoices(),
    current: () => storyName(),
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
    list: () => (GameInfo.Governments ?? []).map((d) => ({ name: d.GovernmentType })),
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
      if (link.FromNarrativeStoryType === def.NarrativeStoryType) links.push({ name: link.ToNarrativeStoryType });
    }
  } catch { /* fall through to CLOSE */ }
  return links.length > 0 ? links : [{ name: "CLOSE" }];
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
  return { ok: true, listing: true, current: decision.current?.() ?? null, options };
}

const args = decision.args(THING);
if (!args) {
  return {
    ok: false,
    code: "NO_SUCH_THING",
    message: `this game has no ${WHAT} named ${THING}`,
    hint: `run \`civ ${WHAT}\` with no value to see what there is`,
  };
}

const target = decision.scope === "city" ? findOwnCity(PLAYER_ID, TARGET_ID)?.id : PLAYER_ID;
if (decision.scope === "city" && !target) {
  return { ok: false, code: "NO_SUCH_CITY", message: `settlement ${TARGET_ID} not found for p${PLAYER_ID}` };
}

const result = startOperation(decision.api(), target, decision.operation(), args);
if (!result.ok) {
  if (!result.hint) result.hint = `run \`civ ${WHAT}\` with no value to see what there is`;
  return result;
}

// Report what the game says, but only when it has caught up.
//
// The engine applies these asynchronously. Reading straight back reported "the game still says
// nothing" for a research choice that had in fact been set — telling an agent its choice failed
// when it worked is worse than telling it nothing. So say the new value when it is already
// visible, and otherwise just confirm the request; `civ <what>` shows the truth a moment later.
const after = decision.current?.() ?? null;
result.note = after ? `${WHAT} is now ${after}` : `${WHAT} set to ${THING}`;
return result;
