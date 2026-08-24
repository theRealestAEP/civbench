// Does the engine accept a STRING for every operation kind, or only for units?
// If strings work everywhere, the whole name<->hash mapping layer can be deleted.
import { listTargets, CdpBridge } from "../../src/adapter/cdp.ts";

const target = (await listTargets(9444, 8000)).find((t) => t.url.includes("root-game"));
if (!target) { console.error("no gameplay context — start a match first"); process.exit(1); }
const bridge = await CdpBridge.connect(target.webSocketDebuggerUrl);

console.log(await bridge.eval(`
  const me = GameContext.localPlayerID;
  const player = Players.get(me);
  const cityId = (player?.Cities?.getCityIds?.() ?? [])[0];
  const unitId = (player?.Units?.getUnitIds?.() ?? [])[0];
  const out = {};

  const tryIt = (label, fn) => { try { const r = fn(); out[label] = r?.Success === undefined ? String(r) : r.Success; } catch (e) { out[label] = "threw: " + String(e).slice(0,60); } };

  if (cityId) {
    tryIt("city: string name", () => Game.CityOperations.canStart(cityId, "CITYOPERATION_BUILD", {}, false));
    tryIt("city: enum member", () => Game.CityOperations.canStart(cityId, CityOperationTypes.BUILD, {}, false));
    out.enumValue = String(CityOperationTypes.BUILD);
  }
  if (unitId) {
    tryIt("unit: string name", () => Game.UnitOperations.canStart(unitId, "UNITOPERATION_SKIP_TURN", {}, false));
    tryIt("unit: enum member", () => Game.UnitOperations.canStart(unitId, UnitOperationTypes.SKIP_TURN, {}, false));
    out.unitEnumValue = String(UnitOperationTypes.SKIP_TURN);
  }
  tryIt("player: string name", () => Game.PlayerOperations.canStart(me, "SET_TECH_TREE_NODE", {}, false));
  tryIt("player: enum member", () => Game.PlayerOperations.canStart(me, PlayerOperationTypes.SET_TECH_TREE_NODE, {}, false));
  out.playerEnumValue = String(PlayerOperationTypes.SET_TECH_TREE_NODE);
  return out;
`));
await bridge.close();
