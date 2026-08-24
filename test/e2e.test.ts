// One full turn through the real stack: fake game -> adapter -> match server -> dump on disk
// -> tinysandbox -> the agent's own shell tools -> the civ command (docs/PLAN.md §9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameAdapter } from "../src/adapter/game.ts";
import { FakeBridge, makeWorld } from "../src/test-support/fake-game.ts";
import { MatchServer } from "../src/server/match.ts";
import { createAgentSandbox } from "../src/agent/sandbox.ts";

async function setup() {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-e2e-"));
  const world = makeWorld();
  world.met[0] = [1];
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes-alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);
  return { runDir, server, hud, session };
}

test("the turn writes a dump the agent can grep", async () => {
  const { runDir, hud } = await setup();
  const tiles = readFileSync(join(runDir, "agents/alpha/turns/t0042/tiles.txt"), "utf8");
  assert.match(tiles, /^tile 1,1 /m);
  assert.match(tiles, /vis=visible/);
  assert.match(tiles, /vis=fogged/);
  assert.match(hud, /turn 42\/250/);
});

test("the agent reads its dump with ordinary shell tools", async () => {
  const { session } = await setup();
  const grep = await session.exec("grep -c vis=fogged /run/turns/t0042/tiles.txt");
  assert.equal(grep.exitCode, 0, grep.stderr);
  assert.equal(grep.stdout.trim(), "1");

  const wc = await session.exec("wc -l < /run/turns/t0042/tiles.txt");
  assert.equal(wc.stdout.trim(), "3");
});

test("jq works on the JSONL twin, which is why we skip awk", async () => {
  const { session } = await setup();
  const result = await session.exec(
    "cat /run/turns/t0042/units.jsonl | jq -r 'select(.owner==0) | .id'",
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), "10");
});

test("the civ command is a real binary in the sandbox", async () => {
  const { session } = await setup();
  const which = await session.exec("which civ");
  assert.equal(which.exitCode, 0, "civ must resolve via which and compose in pipes");
  const help = await session.exec("civ help");
  assert.match(help.stdout, /civ end-turn/);
});

test("/run refuses writes, so an agent cannot doctor its record", async () => {
  const { session } = await setup();
  const write = await session.exec("echo tampered > /run/turns/t0042/tiles.txt");
  assert.notEqual(write.exitCode, 0, "writing to /run must fail");
});

test("/notes is writable, because it is the agent's memory", async () => {
  const { session } = await setup();
  const write = await session.exec("echo 'plan: expand south' >> /notes/notes.md");
  assert.equal(write.exitCode, 0, write.stderr);
  const read = await session.exec("cat /notes/notes.md");
  assert.match(read.stdout, /expand south/);
});

test("another agent's directory is not addressable", async () => {
  const { session } = await setup();
  const peek = await session.exec("ls /run/../agents");
  assert.notEqual(peek.exitCode, 0, "`..` must not climb out of the mount");
  const events = await session.exec("cat /run/../events.jsonl");
  assert.notEqual(events.exitCode, 0, "the event log must be unreachable");
});

test("civ end-turn reaches the game and is logged", async () => {
  const { session, runDir } = await setup();
  // The game refuses to end a turn while any unit still has moves, so park the unit first.
  await session.exec("civ skip 10");
  const result = await session.exec("civ end-turn");
  assert.equal(result.exitCode, 0, result.stderr);
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"turn_end"/);
});

// GameContext.sendTurnComplete() is silently ignored when the game would refuse the same click
// from a human — no error, no reason. Reporting ok anyway left a seat active in the game while
// the match moved on, and the round then waited forever for a turn that could not advance.
test("a turn that cannot end says so, and names the unit holding it open", async () => {
  const { session } = await setup();
  const refused = await session.exec("civ end-turn");
  assert.notEqual(refused.exitCode, 0, "ending a turn with an idle unit must fail, not silently pass");
  assert.match(refused.stderr, /still (has|have) moves/);
  assert.match(refused.stderr, /\b10\b/, "it must name the unit that is holding the turn open");

  // And the turn must still be endable afterwards: a refusal is not the end of the turn.
  await session.exec("civ skip 10");
  const ended = await session.exec("civ end-turn");
  assert.equal(ended.exitCode, 0, ended.stderr);
});

// The regression that cost ten minutes of turn 1.
//
// CITYOPERATION_BUILD takes { UnitType | ConstructibleType | ProjectType: <hashed int> } — the key
// depends on what the thing is, and the engine returns no FailureReasons when it is wrong. An agent
// guessed argument names 25 times in one turn and never built anything. These tests pin the shape.
test("civ build sends the argument key the engine actually wants", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-build-"));
  const world = makeWorld();
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes-alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const built = await session.exec("civ build 30 UNIT_WARRIOR");
  assert.equal(built.exitCode, 0, built.stderr);

  const sent = world.cityRequests.at(-1)!;
  assert.deepEqual(Object.keys(sent), ["UnitType"], "a unit builds under UnitType, not Type or name");
  assert.equal(typeof sent.UnitType, "number", "the engine wants the hash, not the readable name");

  // A building takes a different key entirely, which is the whole reason `civ build` exists.
  await session.exec("civ build 30 BUILDING_GRANARY");
  assert.deepEqual(Object.keys(world.cityRequests.at(-1)!), ["ConstructibleType"]);
});

test("a name the game does not have is refused with a way to find the real ones", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-build-bad-"));
  const world = makeWorld();
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes-alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const bad = await session.exec("civ build 30 SOMETHING_INVENTED");
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /civ build/, "a refusal must name the command that lists the options");
  assert.equal(world.cityRequests.length, 0, "an unknown name must never reach the engine");
});

test("agents never see a hash, so they never try to invert one", async () => {
  const { session } = await setup();
  const listing = await session.exec("civ build 30");
  assert.equal(listing.exitCode, 0, listing.stderr);
  assert.doesNotMatch(listing.stdout, /\b-?\d{6,}\b/, "a hash must never reach the agent");
  // A live run printed "civ build 65536 [object Object]" for every option, so the agent fell back
  // to recalling unit names from memory and got one of them wrong.
  assert.doesNotMatch(listing.stdout, /\[object Object\]/, "every option must render as its name");
  // The other half: why something is unavailable, in the engine's own words.
  assert.match(listing.stdout, /not yet:/);
  assert.match(listing.stdout, /needs population 3/);
  const offers = listing.stdout.split("\n").filter((l) => l.trim().startsWith("civ build 30 "));
  assert.ok(offers.length > 0, "produce must offer something, or this test proves nothing");
  // Every offered line must be runnable as printed.
  for (const line of offers) {
    assert.match(line, /^ *civ build 30 [A-Z][A-Z0-9_]*(\s|$)/, `not runnable as printed: ${line}`);
  }
});

// The briefing used to tell agents "NO GLOBS", and they typed them anyway.
test("globs work, because every shell the agent has seen has them", async () => {
  const { session, runDir } = await setup();
  const dir = join(runDir, "agents/alpha/turns/t0042");
  const txt = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
  assert.ok(txt.length > 1, "this test needs several files to be worth anything");

  const globbed = await session.exec("cat /run/turns/t0042/*.txt | wc -l");
  assert.equal(globbed.exitCode, 0, globbed.stderr);
  const named = await session.exec(
    `cat ${txt.map((f) => `/run/turns/t0042/${f}`).join(" ")} | wc -l`,
  );
  assert.equal(globbed.stdout.trim(), named.stdout.trim(), "a glob must match naming the files");

  // A quoted pattern is a literal, and a pattern matching nothing stays as typed — so the error
  // the agent reads still names what they wrote.
  const missing = await session.exec("cat /current/nothing-here-*.txt");
  assert.match(missing.stderr, /nothing-here-\*/);
});

// Agents were reassembling hex geometry in prose before every decision. `civ near` answers it.
test("civ near reports the neighbourhood without the agent doing hex arithmetic", async () => {
  const { session } = await setup();
  const near = await session.exec("civ near 10 1");
  assert.equal(near.exitCode, 0, near.stderr);
  // The fake world puts p0's unit 10 at 1,1 with 2,1 revealed adjacent and 6,6 far away.
  assert.match(near.stdout, /here\s+tile 1,1 /, "the centre tile must be marked");
  assert.match(near.stdout, /d=1\s+tile 2,1 /, "an adjacent revealed tile must appear");
  // Civ's grid has six directions and no north or south, so no compass label is printed.
  assert.doesNotMatch(near.stdout, /d=1 [NS]/, "a N/S bearing would be a lie on a hex grid");
  assert.doesNotMatch(near.stdout, /tile 6,6 /, "a tile outside the radius must not appear");

  // Centring on a plot works too, and the radius is respected.
  const byPlot = await session.exec("civ near 1,1 1");
  assert.equal(byPlot.exitCode, 0, byPlot.stderr);
  assert.match(byPlot.stdout, /tile 1,1 /);
});

test("civ near cannot show a tile the agent has not revealed", async () => {
  const { session } = await setup();
  // 6,6 is p1's area: revealed for p1, never for p0. A radius wide enough to cover it must
  // still show nothing there, because near reads the same fog-filtered dump the agent reads.
  const wide = await session.exec("civ near 1,1 6");
  assert.equal(wide.exitCode, 0, wide.stderr);
  assert.doesNotMatch(wide.stdout, /tile 6,6 /);
});

// A refusal must never guess at its own cause.
//
// The engine returns no FailureReasons when a unit is simply out of moves. A message reading
// "check the argument names and values" sent one agent into 23 consecutive argument guesses for
// an action whose arguments were already correct.
test("a reasonless refusal points at what-can instead of blaming the arguments", async () => {
  const { session } = await setup();
  // The fake refuses every UnitCommand with a reason, and every UnitOperation shape it does not
  // know without one — either way the wording must not send the agent hunting for arguments.
  const refused = await session.exec("civ do unit-cmd 10 UNITCOMMAND_PROMOTE");
  assert.notEqual(refused.exitCode, 0);
  assert.doesNotMatch(
    refused.stderr,
    /argument names|check the argument/i,
    "never tell an agent the arguments are wrong unless the engine said so",
  );
});

// Research was silently never set. SET_TECH_TREE_TARGET_NODE with no arguments returns Success
// and does nothing — the game's own UI calls it that way to CLEAR a target — so agents saw "ok"
// and believed they had chosen a technology for the rest of the match.
test("civ tech lists what is available as commands you can run", async () => {
  const { session } = await setup();
  const listing = await session.exec("civ tech");
  assert.equal(listing.exitCode, 0, listing.stderr);
  assert.match(listing.stdout, /tech now: nothing/);
  const offers = listing.stdout.split("\n").filter((l) => l.trim().startsWith("civ tech"));
  assert.ok(offers.length > 0, "it must offer something, or this test proves nothing");
  for (const line of offers) {
    assert.match(line, /^ *civ tech NODE_[A-Z0-9_]+/, `not runnable as printed: ${line}`);
  }
  assert.doesNotMatch(listing.stdout, /\b\d{6,}\b/, "a node hash must never reach the agent");
});

test("civ tech picks a node, and refuses one the game does not have", async () => {
  const { runDir, session } = await setup();
  const chosen = await session.exec("civ tech NODE_TECH_501");
  assert.equal(chosen.exitCode, 0, chosen.stderr);
  // The note reports what the GAME says afterwards, not what we asked for.
  assert.match(chosen.stdout, /tech is now NODE_TECH_501/);

  const bogus = await session.exec("civ tech NODE_INVENTED");
  assert.notEqual(bogus.exitCode, 0);
  assert.match(bogus.stderr, /civ tech/, "a refusal must name how to find the real options");

  // Choosing spends an action and is logged; listing does not.
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"choose"/);
});

// A syntax error in the briefing takes down every run, and nothing else imports it — an
// unescaped backtick shipped once and 81 tests still passed. This is that guard.
test("the briefing loads, and says what the agent can actually do", async () => {
  const { BRIEFING } = await import("../src/agent/briefing.ts");
  assert.ok(BRIEFING.length > 4000, "the briefing must survive being a template literal");
  // Prompt caching needs a prefix above ~1024 tokens or the API declines to cache it.
  assert.ok(BRIEFING.length / 3.7 > 1024, "too short to be cached, which makes every turn dearer");
  // Every command the briefing advertises must exist, or it sends agents after ghosts.
  const { runCivCommand } = await import("../src/cli/civ.ts");
  const usage = await runCivCommand(null as never, 0, ["help"], () => "");
  for (const line of BRIEFING.split("\n")) {
    const m = /^ {2}civ ([a-z-]+)/.exec(line);
    if (m) assert.match(usage.stdout, new RegExp(`civ ${m[1]}\\b`), `briefing offers \`civ ${m[1]}\`, usage does not`);
  }
});

// Two decisions that block the end of a turn in the real game. A city that grows must place its
// new citizen, and a narrative event must be answered. Neither had a command, so a live match
// stalled on NOTIFICATION_NEW_POPULATION with no unit able to move and nothing able to clear it.
test("civ expand offers the plots a grown city can take", async () => {
  const { session } = await setup();
  const listing = await session.exec("civ expand 30");
  assert.equal(listing.exitCode, 0, listing.stderr);
  const offers = listing.stdout.split("\n").filter((l) => l.trim().startsWith("civ expand 30 "));
  assert.ok(offers.length > 0, "a grown city must be offered somewhere to put the citizen");
  for (const line of offers) {
    assert.match(line, /civ expand 30 \d+,\d+/, `not runnable as printed: ${line}`);
  }
});

test("civ story shows the narrative event and takes an answer", async () => {
  const { session } = await setup();
  const listing = await session.exec("civ story");
  assert.equal(listing.exitCode, 0, listing.stderr);
  assert.match(listing.stdout, /STORY_FAKE_DISCOVERY/, "it must name the story waiting on you");
  assert.match(listing.stdout, /civ story STORY_FAKE_ACCEPT/, "and offer its answers as commands");

  const answered = await session.exec("civ story STORY_FAKE_ACCEPT");
  assert.equal(answered.exitCode, 0, answered.stderr);
  // The story is answered, so nothing is pending: the effect, not the return value.
  const after = await session.exec("civ story");
  assert.doesNotMatch(after.stdout, /STORY_FAKE_ACCEPT/, "an answered story must stop being offered");
});
