import assert from "node:assert/strict";
// Exercise popup text and input in Gameface using a detached DOM fixture.
// The fixture never mounts in the live UI and sends no gameplay operations.
import { readFileSync } from 'node:fs';
import { listTargets, CdpBridge } from '../../src/adapter/cdp.ts';
const target = (await listTargets(9444)).find(t => t.url.includes('root-game'));
if (!target) throw new Error('no gameplay context is running');
const bridge = await CdpBridge.connect(target.webSocketDebuggerUrl);
try {
  const helper = readFileSync('src/adapter/gamejs/_screens.js', 'utf8');
  const screen = readFileSync('src/adapter/gamejs/screen.js', 'utf8');
  const result = await bridge.eval<{ record: { controls: Array<{ label: string }> }; action: { ok: boolean }; activated: number }>(`
    const realDocument = globalThis.document;
    const root = realDocument.createElement('div');
    root.className = 'fxs-popups';
    root.innerHTML = '<div><p>Choose an advisor</p><div role="button" data-activatable="true">Science</div></div>';
    const document = {querySelectorAll: (selector) => selector === '.fxs-popups' ? [root] : []};
    const PLAYER_ID = GameContext.localPlayerID;
    ${helper}
    const inventory = screenInventory();
    let activated = 0;
    root.querySelector('[role="button"]').addEventListener('engine-input', (event) => { event.preventDefault(); activated++; });
    const TARGET_ID = inventory[0].id;
    const ARGS = {control:inventory[0].controls[0].id};
    const action = (() => { ${screen} })();
    return {record:screenRecord(inventory[0]), action, activated};
  `);
  assert.equal(result.record.controls.length, 1);
  assert.equal(result.record.controls[0].label, "Science");
  assert.equal(result.action.ok, true);
  assert.equal(result.activated, 1);
  console.log("PASS: Gameface reads the control once and handles one activation.");
} finally { await bridge.close(); }
