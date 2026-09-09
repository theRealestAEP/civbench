import { scoreAgent } from "../src/score/metrics.ts";
import type { Event } from "../src/server/events.ts";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { GameAdapter } from "../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../src/test-support/fake-game.ts";
import { MatchServer, type ActionResult } from "../src/server/match.ts";
import { createAgentSandbox } from "../src/agent/sandbox.ts";
import type { PendingItem } from "../src/dump/types.ts";

type ScreenResult = ActionResult & { screens: PendingItem[] };

function setup() {
  const window = new Window();
  const document = window.document;
  document.body.innerHTML = `<div class="fxs-popups"><advisor-council-popup>
    <h1>Choose advisors</h1><p>Follow advisors to receive guidance.</p>
    <div class="advisor-card"><div data-activatable="true" role="button">Science</div></div>
    <fxs-button caption="Confirm">Confirm</fxs-button>
    <fxs-reward-button disabled="true">Unavailable reward</fxs-reward-button>
    <div hidden><button>Hidden secret</button></div>
    </advisor-council-popup></div>`;
  const world = makeWorld();
  const context = { localPlayerID: 0 };
  const adapter = new GameAdapter(new FakeBridge(world, {
    document, GameContext: context, getComputedStyle: window.getComputedStyle.bind(window),
    CustomEvent: window.CustomEvent, InputActionStatuses: { FINISH: 2 },
  }));
  const read = (player = 0) => adapter.run<ScreenResult>("screen", player, { TARGET_ID: null, ARGS: {} });
  const activate = (screen: PendingItem, control: string, player = 0) =>
    adapter.run<ActionResult>("screen", player, { TARGET_ID: screen.id, ARGS: { control } });
  return { window, document, world, context, adapter, read, activate };
}

test("popup text and controls reach pending, while hidden text and other seats stay private", async () => {
  const { adapter, read } = setup();
  const [screen] = (await read()).screens;
  assert.match(screen.message!, /Follow advisors/);
  assert.doesNotMatch(screen.message!, /Hidden secret/);
  assert.deepEqual(screen.controls!.map(c => c.label), ["Science", "Confirm", "Unavailable reward"]);
  assert.equal((await adapter.pending(0)).items.at(-1)?.message, screen.message);
  assert.equal((await read(1)).code, "SCREEN_WRONG_SEAT");
  assert.equal((await adapter.pending(1)).items.some(i => i.type?.startsWith("SCREEN_")), false);
});

test("Solid and legacy controls receive one engine activation; disabled and stale controls cannot act", async () => {
  const { document, read, activate } = setup();
  let activations = 0;
  for (const el of document.querySelectorAll('[data-activatable], fxs-button')) {
    el.addEventListener("engine-input", event => { activations++; event.preventDefault(); });
  }
  const [screen] = (await read()).screens;
  const [science, confirm, disabled] = screen.controls!;
  assert.equal((await activate(screen, science.id)).ok, true);
  assert.equal((await activate(screen, confirm.id)).ok, true);
  assert.equal(activations, 2);
  assert.equal((await activate(screen, disabled.id)).code, "CONTROL_DISABLED");
  document.querySelector('fxs-button')!.outerHTML = '<fxs-button>Different choice</fxs-button>';
  assert.equal((await activate(screen, confirm.id)).code, "CONTROL_STALE");
  assert.equal(activations, 2);
  document.querySelector('advisor-council-popup')!.remove();
  assert.equal((await activate(screen, science.id)).code, "SCREEN_STALE");
});

test("covered screens and controls that ignore input return explicit errors", async () => {
  const { document, read, activate } = setup();
  const [screen] = (await read()).screens;
  assert.equal((await activate(screen, screen.controls![0].id)).code, "SCREEN_INPUT_IGNORED");
  document.querySelector('.fxs-popups')!.insertAdjacentHTML('beforeend', '<small-narrative-event><button>Answer</button></small-narrative-event>');
  assert.equal((await activate(screen, screen.controls![0].id)).code, "SCREEN_COVERED");
});

test("both cleanup paths leave advisor and narrative choices intact", async () => {
  const { document, adapter } = setup();
  let clicked = 0;
  document.querySelector('.fxs-popups')!.insertAdjacentHTML('beforeend', '<small-narrative-event><button>Continue</button><fxs-button>OK</fxs-button></small-narrative-event>');
  for (const el of document.querySelectorAll('button, fxs-button')) el.addEventListener('click', () => clicked++);
  for (const name of ['handoff', 'uncurtain']) {
    document.body.insertAdjacentHTML('beforeend', '<hotseat-curtain id="hotseat-screen-curtain"></hotseat-curtain>');
    await adapter.run(name, 0);
    assert.equal(document.querySelector('hotseat-curtain'), null);
    assert.ok(document.querySelector('advisor-council-popup'));
    assert.ok(document.querySelector('small-narrative-event'));
  }
  assert.equal(clicked, 0);
});

test("screen command reads without budget, logs activation, and refreshes the saved observation", async () => {
  const { document, adapter } = setup();
  const runDir = mkdtempSync(join(tmpdir(), 'civbench-screens-'));
  const server = new MatchServer(adapter, runDir, [{ slot: 0, playerId: 0, name: 'alpha', actionsPerTurn: 5, secondsPerTurn: 60 }]);
  const hud = await server.beginTurn(0);
  const notes = join(runDir, 'notes', 'alpha');
  mkdirSync(notes, { recursive: true });
  const session = createAgentSandbox(server, 0, notes, () => hud);
  const result = await session.exec('civ screen');
  assert.equal(result.exitCode, 0, result.stderr);
  // SAFETY: the screen command serializes the adapter's ScreenResult.
  const [screen] = (JSON.parse(result.stdout) as ScreenResult).screens;
  document.querySelector('fxs-button')!.addEventListener('engine-input', e => {
    e.preventDefault(); document.querySelector('advisor-council-popup')!.remove();
  });
  const act = await session.exec(`civ screen ${screen.id} ${screen.controls![1].id}`);
  assert.equal(act.exitCode, 0, act.stdout);
  const refreshed = await session.exec('cat /current/pending.txt');
  assert.doesNotMatch(refreshed.stdout, /advisor-council-popup/);
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
  assert.equal(events.split('\n').filter(l => l.includes('"kind":"screen"')).length, 1);
  assert.match(events, /"actionsUsed":1/);
});

test("notification dismiss redirects screen ids to the screen command", async () => {
  const { adapter } = setup();
  const result = await adapter.run<ActionResult>('notify', 0, { TARGET_ID: 'screen:advisor-council-popup', MODE: 'dismiss' });
  assert.equal(result.code, 'USE_SCREEN');
  assert.match(result.hint!, /civ screen/);
});

test("named layout slots expose chooser controls and popup overlays take precedence", async () => {
  const { document, read, activate } = setup();
  document.body.insertAdjacentHTML('afterbegin', '<div id="target-slot-screen-tech-tree-chooser"><screen-tech-tree-chooser><button>Research pottery</button></screen-tech-tree-chooser></div>');
  const [panel] = (await read()).screens;
  assert.match(panel.message!, /Research pottery/);
  assert.equal((await activate(panel, panel.controls![0].id)).code, 'SCREEN_COVERED');
  document.querySelector('advisor-council-popup')!.remove();
  let clicked = 0;
  document.querySelector('button')!.addEventListener('click', () => clicked++);
  assert.equal((await activate(panel, panel.controls![0].id)).ok, true);
  assert.equal(clicked, 1);
});

test("unhandled value inputs are reported in the screen record", async () => {
  const { document, read } = setup();
  document.querySelector('advisor-council-popup')!.insertAdjacentHTML('beforeend', '<input value="10"><div role="slider"></div>');
  const [screen] = (await read()).screens;
  assert.equal(screen.interfaceGaps?.length, 2);
});

test("a reused control with a different choice invalidates the old id", async () => {
  const { document, read, activate } = setup();
  const [screen] = (await read()).screens;
  document.querySelector('[data-activatable]')!.textContent = 'Military';
  assert.equal((await activate(screen, screen.controls![0].id)).code, 'CONTROL_STALE');
});

test("audit reports missing popup content even when there are no actions", () => {
  const runDir = mkdtempSync(join(tmpdir(), 'civbench-screen-audit-'));
  const dir = join(runDir, 'agents', 'alpha', 'turns', 't0001');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pending.jsonl'), JSON.stringify({ id: 'screen:advisor-council-popup', type: 'SCREEN_ADVISOR_COUNCIL_POPUP', summary: 'open', message: null }) + '\n');
  const output = execFileSync(process.execPath, ['tools/audit.ts', runDir], { encoding: 'utf8' });
  assert.match(output, /HIGH.*screen text missing/);
  assert.match(output, /HIGH.*screen controls missing/);
});

test("advisor follow controls retain the advisor name and checkbox selections are readable", async () => {
  const { document, read } = setup();
  document.querySelector('.advisor-card')!.innerHTML = '<div class="advisor-card-title">Science Advisor</div><div data-activatable="true">Follow</div><fxs-checkbox selected="true">Show advice</fxs-checkbox>';
  const [screen] = (await read()).screens;
  assert.equal(screen.controls![0].label, 'Follow');
  assert.equal(screen.controls![0].context, 'Science Advisor');
  assert.equal(screen.controls![1].selected, 'true');
});

test("observed interface gaps persist after the screen closes and exclude the run from scoring", async () => {
  const { document, adapter } = setup();
  document.querySelector('advisor-council-popup')!.insertAdjacentHTML('beforeend', '<input value="10">');
  const runDir = mkdtempSync(join(tmpdir(), 'civbench-gap-log-'));
  const server = new MatchServer(adapter, runDir, [{ slot: 0, playerId: 0, name: 'alpha', actionsPerTurn: 5, secondsPerTurn: 60 }]);
  await server.beginTurn(0);
  document.querySelector('advisor-council-popup')!.remove();
  // SAFETY: the server writes typed Event records to events.jsonl.
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Event);
  assert.equal(events.filter(e => e.kind === 'interface_gap').length, 1);
  const cleanTurns: Event[] = Array.from({ length: 50 }, (_, turn) => ({ turn, player: 1, playerName: 'beta', kind: 'turn_begin' }));
  assert.equal(scoreAgent(runDir, 'beta', cleanTurns).admissible, true);
  const affected = scoreAgent(runDir, 'beta', [...cleanTurns, ...events]);
  assert.equal(affected.admissible, false);
  assert.match(affected.inadmissibleBecause.join(' '), /interface gap/);
  const output = execFileSync(process.execPath, ['tools/audit.ts', runDir], { encoding: 'utf8' });
  assert.match(output, /HIGH.*value input requires interface support/);
});
