// Is the match actually playing, or only returning ok?
//
// Every wrong claim made about this project came from trusting a return value. `civ research`
// returned ok for weeks while SET_TECH_TREE_TARGET_NODE quietly did nothing; an action-surface
// audit counted that operation as working because canStart said Success. Tests pass against a
// fake game, and log lines scroll whether or not the agent inside is playing.
//
// So this asks the GAME what is true, and reports one line per claim. Run it against a live match.
import { loadEnv } from "../../src/config/env.ts";
import { listTargets, CdpBridge } from "../../src/adapter/cdp.ts";

loadEnv();

const targets = await listTargets(9444);
const game = targets.find((t) => t.url.includes("root-game"));
if (!game) {
  console.log("FAIL  no gameplay context — no match is running");
  process.exit(1);
}
const bridge = await CdpBridge.connect(game.webSocketDebuggerUrl);

const state = await bridge.eval<{
  turn: number;
  players: Array<{
    id: number;
    researching: string | null;
    progress: number | null;
    civics: string | null;
    cities: number;
    units: number;
    building: string | null;
    met: number;
  }>;
}>(`
  const name = (hash) => {
    try { return (GameInfo.ProgressionTreeNodes.lookup(hash) || {}).ProgressionTreeNodeType || null; }
    catch (e) { return null; }
  };
  const nodeOf = (tree) => {
    try { const r = tree && tree.getResearching && tree.getResearching(); return r ? r : null; }
    catch (e) { return null; }
  };
  const players = [];
  for (const p of Players.getAlive() || []) {
    if (!(p.isMajor ?? true)) continue;
    const tech = nodeOf(p.Techs);
    const civic = nodeOf(p.Culture);
    const cityIds = (p.Cities && p.Cities.getCityIds && p.Cities.getCityIds()) || [];
    let building = null;
    try {
      const c = cityIds.length ? Cities.get(cityIds[0]) : null;
      const h = c && c.BuildQueue ? c.BuildQueue.currentProductionTypeHash : null;
      // -1 is Civ's "none" sentinel. Treating it as a value reported an empty queue as healthy.
      if (h && h !== -1) {
        const u = GameInfo.Units.lookup(h) || GameInfo.Constructibles.lookup(h) || GameInfo.Projects.lookup(h);
        building = u ? (u.UnitType || u.ConstructibleType || u.ProjectType) : String(h);
      }
    } catch (e) { building = "err"; }
    let met = 0;
    try { for (const q of Players.getAlive() || []) if (q.id !== p.id && p.Diplomacy && p.Diplomacy.hasMet && p.Diplomacy.hasMet(q.id)) met++; }
    catch (e) { met = -1; }
    players.push({
      id: p.id,
      researching: tech ? name(tech.type) : null,
      progress: tech ? tech.progress : null,
      civics: civic ? name(civic.type) : null,
      cities: cityIds.length,
      units: ((p.Units && p.Units.getUnitIds && p.Units.getUnitIds()) || []).length,
      building,
      met,
    });
  }
  return { turn: Game.turn, players };
`);
await bridge.close();

console.log(`turn ${state.turn}\n`);
let failures = 0;
const check = (ok: boolean, label: string, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(28)} ${detail}`);
};

for (const p of state.players) {
  console.log(`-- player ${p.id}`);
  check(p.cities > 0, "has a settlement", `${p.cities} cities`);
  check(p.units > 0, "has units", `${p.units} units`);
  check(p.researching !== null, "is researching something", p.researching ?? "NOTHING");
  check(p.civics !== null, "has a civic in progress", p.civics ?? "NOTHING");
  check(p.building !== null, "is building something", p.building ?? "NOTHING");
  // Not a failure: contact takes many turns, and this is the number that gates chat and trade.
  console.log(`      met                          ${p.met} other civs`);
}

console.log(`\n${failures === 0 ? "all claims hold" : `${failures} claims FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
