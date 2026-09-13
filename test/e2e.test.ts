// One full turn through the real stack: fake game -> adapter -> match server -> dump on disk
// -> tinysandbox -> the agent's own shell tools -> the civ command (docs/PLAN.md §9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameAdapter } from "../src/adapter/game.ts";
import { FakeBridge, makeWorld, hashOf } from "../src/test-support/fake-game.ts";
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
  // Same path run.ts uses. A test that mounts somewhere else cannot catch a path bug.
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);
  return { runDir, server, hud, session, world };
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
  assert.equal(result.turnEnded, true, "the exec result must signal the turn actually ended");
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"turn_end"/);
});

// `echo "then civ end-turn" >> /notes/notes.md` used to end the agent's turn: the brain inferred
// the end from the command TEXT plus the compound exit code. The signal now comes from the `civ`
// command itself, so text that merely mentions end-turn cannot fire it.
test("writing about end-turn in a note does not end the turn", async () => {
  const { session } = await setup();
  const written = await session.exec("echo 'then civ end-turn' >> /notes/notes.md");
  assert.equal(written.exitCode, 0);
  assert.ok(!written.turnEnded, "mentioning end-turn is not ending the turn");
  const grepped = await session.exec("grep 'civ end-turn' /notes/notes.md");
  assert.ok(!grepped.turnEnded);
});

// GameContext.sendTurnComplete() is silently ignored when the game would refuse the same click
// from a human — no error, no reason. Reporting ok anyway left a seat active in the game while
// the match moved on, and the round then waited forever for a turn that could not advance.
//
// "needs orders" rather than "has moves" is the game's own distinction, and it is not wording.
// A unit told to sleep or fortify keeps its moves and blocks nothing. Reading it as "has moves"
// refused end-turns the engine was willing to accept.
test("a turn that cannot end says so, and names the unit holding it open", async () => {
  const { session } = await setup();
  const refused = await session.exec("civ end-turn");
  assert.notEqual(refused.exitCode, 0, "ending a turn with an idle unit must fail, not silently pass");
  assert.match(refused.stdout, /needs orders/);
  assert.match(refused.stdout, /\b10\b/, "it must name the unit that is holding the turn open");

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
  // Same path run.ts uses. A test that mounts somewhere else cannot catch a path bug.
  const notesDir = join(runDir, "notes", "alpha");
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
  // Same path run.ts uses. A test that mounts somewhere else cannot catch a path bug.
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const bad = await session.exec("civ build 30 SOMETHING_INVENTED");
  assert.notEqual(bad.exitCode, 0);
  // Naming the real options beats naming the command that would list them: the agent invented
  // this name because it had no list, and another round-trip to get one costs it an action.
  assert.match(bad.stdout, /UNIT_|BUILDING_|civ build/, "a refusal must show a way forward");
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
  const chosen = await session.exec("civ tech NODE_TECH_502");
  assert.equal(chosen.exitCode, 0, chosen.stderr);
  // Assert the EFFECT, not the reply. The reply cannot know what happened: the engine applies a
  // request asynchronously, so anything read back on that line is the state BEFORE the action.
  // Deliberately not the first node in the list either — the fake's hashes used to collide, so
  // any input read back as NODE_TECH_501 and this assertion could not fail.
  assert.match(chosen.stdout, /set to NODE_TECH_502/, "it confirms what it sent");
  const now = await session.exec("civ tech");
  assert.match(now.stdout, /tech now: NODE_TECH_502/, "and the game must actually report it");

  const bogus = await session.exec("civ tech NODE_INVENTED");
  assert.notEqual(bogus.exitCode, 0);
  assert.match(bogus.stdout, /NODE_TECH_|civ tech/, "a refusal must show a way forward");

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
  // SAFETY: `civ help` never touches the server — it prints the usage text and returns. Passing
  // a real MatchServer would mean standing up a game to read a string.
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

// The briefing calls /notes/notes.md "your journal — the ONLY thing you keep between turns".
// It was seeded into the read-only mount instead, so the first read of it always failed and a
// decoy copy sat in /run where the agent could see it but never write to it.
test("the journal exists and is writable on the first turn", async () => {
  const { session } = await setup();
  const read = await session.exec("cat /notes/notes.md");
  assert.equal(read.exitCode, 0, `the journal must exist before the agent's first read: ${read.stderr}`);

  const write = await session.exec("echo 'plan: settle the river' >> /notes/notes.md");
  assert.equal(write.exitCode, 0, write.stderr);
  const again = await session.exec("cat /notes/notes.md");
  assert.match(again.stdout, /settle the river/);

  // And no decoy in the read-only mount to mislead it.
  const decoy = await session.exec("cat /run/notes.md");
  assert.notEqual(decoy.exitCode, 0, "a read-only notes.md in /run is a decoy");
});

// The failure that has ended every live match: a notification that blocks the end of a turn.
//
// GameContext.sendTurnComplete() is silently ignored when the game would refuse the same click
// from a human, so the harness reported the turn ended while the seat stayed active and the round
// waited forever. None of this was reachable in tests until the fake grew a notification queue.
test("a blocking notification stops the turn ending, and says which", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-block-"));
  const world = makeWorld();
  // A DECISION: blocking, and dismissal does not clear it. This is the shape that broke forced
  // end-turn — it dismissed in a loop, nothing changed, and it sent anyway.
  world.notifications.set(0, [
    { id: 501, name: "NOTIFICATION_NEW_POPULATION", typeHash: 442844772, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  await session.exec("civ skip 10"); // park the unit, so only the notification is left
  const refused = await session.exec("civ end-turn");
  assert.notEqual(refused.exitCode, 0, "a blocked turn must not report itself ended");
  // The SETTLEMENT and the PLOTS, not the notification's internal name. An agent told
  // "NOTIFICATION_NEW_POPULATION" guesses a coordinate — three of ten failures in a clean run
  // were exactly that — while the legal list was one call away.
  assert.match(refused.stdout, /citizen to place|NEW_POPULATION/, "it must name what is blocking");
  assert.match(refused.stdout, /civ expand \d+ \d+,\d+/, "and give a command that runs as written");
});

test("a dismissible notice can be cleared, and then the turn ends", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-notice-"));
  const world = makeWorld();
  world.notifications.set(0, [
    { id: 502, name: "NOTIFICATION_LEGACY_COMPLETED", typeHash: 99887766, blocking: true, dismissible: true },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  await session.exec("civ skip 10");
  assert.notEqual((await session.exec("civ end-turn")).exitCode, 0, "blocked before dismissal");
  const cleared = await session.exec("civ dismiss");
  assert.equal(cleared.exitCode, 0, cleared.stderr);
  const ended = await session.exec("civ end-turn");
  assert.equal(ended.exitCode, 0, `the turn must end once the notice is cleared: ${ended.stderr}`);
});

// Commands that change the game must spend budget and appear in the event log. metrics.ts scores
// hygiene from `kind === "action"` events alone, so an unlogged mutation is invisible: a seat
// could spend a whole turn clearing notifications and its record would read spotless.
test("clearing a notification costs an action and is recorded", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-budget-"));
  const world = makeWorld();
  world.notifications.set(0, [
    { id: 601, name: "NOTIFICATION_LEGACY_COMPLETED", typeHash: 5150, blocking: true, dismissible: true },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const before = server.turnStats(0)!.actionsUsed;
  const cleared = await session.exec("civ dismiss");
  assert.equal(cleared.exitCode, 0, cleared.stderr);
  assert.equal(server.turnStats(0)!.actionsUsed, before + 1, "it must spend an action");

  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"action"/);
  assert.match(events, /"kind":"notify"|"actionType":"dismiss"/, "and be visible to scoring");
});

// The briefing lists `sed`, but the sandbox only handled `s///` — so the two commonest ways to
// read part of a file both failed on a tool agents were told they had.
test("sed reads line ranges, which is what the briefing promises", async () => {
  const { session } = await setup();
  const range = await session.exec("sed -n '1,2p' /run/turns/t0042/tiles.txt");
  assert.equal(range.exitCode, 0, range.stderr);
  assert.equal(range.stdout.trim().split("\n").length, 2, "1,2p must give exactly two lines");

  const one = await session.exec("sed -n '1p' /run/turns/t0042/tiles.txt");
  assert.equal(one.exitCode, 0, one.stderr);
  assert.equal(one.stdout.trim().split("\n").length, 1);

  const dropped = await session.exec("sed 1d /run/turns/t0042/tiles.txt | wc -l");
  assert.equal(dropped.exitCode, 0, dropped.stderr);
  const total = await session.exec("wc -l < /run/turns/t0042/tiles.txt");
  assert.equal(Number(dropped.stdout.trim()), Number(total.stdout.trim()) - 1, "1d drops one line");

  // An unsupported script says so rather than failing mutely.
  const odd = await session.exec("sed -n '/foo/p' /run/turns/t0042/tiles.txt");
  assert.notEqual(odd.exitCode, 0);
  assert.match(odd.stderr, /supported/);
});

// Agents guessed operation names because nothing told them what was legal now.
// /run/rules/operations.txt listed 229 operations written once at match start, including ones
// that cannot apply this Age. 36% of every action ever taken was refused, and the commonest
// refusal carried no reason, because the engine gives none for a wrong argument.
test("actions.txt lists what the engine will accept, as runnable commands", async () => {
  const { session } = await setup();
  const listing = await session.exec("cat /current/actions.txt");
  assert.equal(listing.exitCode, 0, `the turn must write actions.txt: ${listing.stderr}`);

  // Every offered line must be a command the agent can run as printed.
  const offers = listing.stdout.split("\n").filter((l) => l.trim().startsWith("civ "));
  assert.ok(offers.length > 0, "it must offer something, or it proves nothing");
  for (const line of offers) {
    assert.match(line, /^\s+civ [a-z-]+/, `not runnable as printed: ${line}`);
  }

  // And it must be greppable for a specific unit, which is the point of it being a file.
  const forUnit = await session.exec("grep -A5 'unit 10' /current/actions.txt");
  assert.equal(forUnit.exitCode, 0, "an agent must be able to grep its own unit's actions");
  assert.match(forUnit.stdout, /civ /);
});

// Our end-turn used to be stricter than the game's. panel-action.ts blocks only on a unit that
// `canMove && !hasMoved` — one that has not moved at all. We blocked on any unit with moves left,
// so a scout that moved one tile of three held the turn open and cost a wasted `civ skip`, every
// turn, on every partially-moved unit.
test("a unit that has already moved does not block the end of the turn", async () => {
  const { session } = await setup();
  const moved = await session.exec("civ move 10 2,1");
  assert.equal(moved.exitCode, 0, moved.stderr);

  // It still has moves left, and the game would not block on it. Neither should we.
  const units = await session.exec("grep 'engine_id=10 ' /current/units.txt");
  assert.match(units.stdout, /moves=1/, "this test needs the unit to have moves left");

  const ended = await session.exec("civ end-turn");
  assert.equal(ended.exitCode, 0, `a partially moved unit must not block the turn: ${ended.stderr}`);
});

// A dropped debug socket used to leave every in-flight request hanging for its full 30s timeout,
// and every later call hung for 30s too, because nothing recorded that the socket had gone. The
// repeated "CDP Runtime.evaluate timed out after 30000ms" in the logs was this, not a busy game.
test("a closed bridge fails immediately instead of waiting for a timeout", async () => {
  const { CdpBridge } = await import("../src/adapter/cdp.ts");
  // BridgeError lives in bridge.ts; cdp.ts imports it rather than re-exporting it.
  const { BridgeError } = await import("../src/adapter/bridge.ts");
  // Build one around a fake socket so the test needs no game.
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const fakeSocket = {
    addEventListener: (name: string, fn: (ev: unknown) => void) => {
      (listeners[name] ??= []).push(fn);
    },
    send: () => {},
    close: () => {},
  };
  // SAFETY: CdpBridge's constructor is private so a real one can only be built by connecting to a
  // game. The point of this test is the socket lifecycle, which needs no game — so the private
  // constructor is called directly with a stand-in socket. InstanceType cannot be used on a class
  // with a private constructor, so the instance type is named directly.
  type Bridge = Awaited<ReturnType<typeof CdpBridge.connect>>;
  const build = CdpBridge as unknown as new (ws: unknown) => Bridge;
  const bridge = new build(fakeSocket);

  assert.equal(bridge.alive, true, "a fresh bridge is usable");

  const inFlight = bridge.eval("return 1");
  for (const fn of listeners.close ?? []) fn({});

  await assert.rejects(inFlight, BridgeError, "an in-flight call must reject when the socket closes");
  assert.equal(bridge.alive, false, "and the bridge must know it is gone");

  const started = Date.now();
  await assert.rejects(bridge.eval("return 1"), BridgeError);
  assert.ok(Date.now() - started < 1000, "a later call must fail at once, not after the 30s timeout");
});

// `civ dismiss` with nothing blocking is a careful agent checking, not a mistake. It used to
// return an error, which counted against the seat's illegal-action rate — the metric meant to
// catch flailing. Penalising a defensive check makes the metric measure the wrong thing.
test("clearing nothing is not an error", async () => {
  const { session, server } = await setup();
  const before = server.turnStats(0)!.illegalCount;
  const result = await session.exec("civ dismiss");
  assert.equal(result.exitCode, 0, "checking for a blocker must not fail");
  assert.match(result.stdout, /nothing was blocking/);
  assert.equal(server.turnStats(0)!.illegalCount, before, "and must not count as an illegal action");
});

// An agent acts, then reads the result with grep or cat rather than a civ command. The engine
// applies requests asynchronously, so the refresh straight after an action can capture the state
// before it — and one agent, seeing `moves=` unchanged after a successful move, spent its turn
// wondering whether unit ids had changed underneath it.
test("a shell read after an action sees the result, not the state before it", async () => {
  const { session } = await setup();
  // Units now lead with a readable handle; the engine id is on the same line as engine_id.
  const before = await session.exec("grep 'engine_id=10 ' /current/units.txt");
  assert.match(before.stdout, /moves=2/, "this test needs the unit to start with its moves");

  const moved = await session.exec("civ move 10 2,1");
  assert.equal(moved.exitCode, 0, moved.stderr);

  // Read with the shell, not with `civ` — this is the path that was missing the refresh.
  const after = await session.exec("grep 'engine_id=10 ' /current/units.txt");
  assert.match(after.stdout, /moves=1/, "a plain grep must show what the action did");
});

// Civ blocks the end of a turn until certain decisions are made. That was shown as one item in a
// list of three, mid-way down a stats line, with no command to answer it — so an agent could not
// tell "you must do this" from "here is a thing that happened", and then could not end its turn.
test("a mandatory action is stated as mandatory, with the command that answers it", async () => {
  const { renderHud } = await import("../src/dump/hud.ts");
  const header = {
    turn: 4, maxTurns: 20, age: "antiquity", ageProgress: null, playerId: 0, civ: "EGYPT",
    leader: "HATSHEPSUT", isHuman: true, gold: 10, yields: {},
    happiness: { net: 0, hasUnrest: false, turnsOfUnrest: 0 },
    settlements: { cities: 1, towns: 0, total: 1, cap: 3, population: 2 },
    unitCount: 1, legacy: [], government: null,
  };
  const pending = {
    blockingType: "NOTIFICATION_CHOOSE_TECH",
    items: [
      { id: "1", type: "NOTIFICATION_CHOOSE_TECH", summary: "Choose a new Technology.", blocking: true },
      { id: "2", type: "NOTIFICATION_SOMETHING", summary: "A thing happened.", blocking: false },
    ],
  };
  // SAFETY: both are partial fixtures — this test is about which HUD lines appear, so it builds
  // only the fields those lines read rather than a whole snapshot.
  const hud = renderHud(
    header as never,
    pending as never,
    { tilesChanged: 0, unitsChanged: 0, settlementsChanged: 0 },
    0,
    { deltaText: "a scout appeared to the north" },
  );

  assert.match(hud, /YOU MUST DO THIS BEFORE THE TURN CAN END/);
  assert.match(hud, /civ tech/, "it must name the command that answers the blocker");
  // The requirement comes before the narrative of what changed, because it gates the turn.
  assert.ok(
    hud.indexOf("YOU MUST") < hud.indexOf("What changed"),
    "the requirement must come before everything optional",
  );
  // And the merely informational item is not promoted alongside it.
  const must = hud.slice(hud.indexOf("YOU MUST"), hud.indexOf("What changed"));
  assert.doesNotMatch(must, /A thing happened/, "only blocking items belong in the must-do list");
});

// The briefing is the highest-leverage file here: every agent reads it before doing anything.
// It had drifted badly — naming a rules file that had been replaced, missing actions.txt, and
// showing example lines without the fields the writer now produces. Nothing catches that by
// reading, so this checks the prompt against what a turn actually writes.
test("every file the briefing promises is actually written", async () => {
  const { BRIEFING } = await import("../src/agent/briefing.ts");
  const { runDir } = await setup();
  const turnDir = join(runDir, "agents", "alpha", "turns", "t0042");
  const written = new Set(readdirSync(turnDir));

  const promised = [...BRIEFING.matchAll(/\/current\/([a-z_]+\.(?:txt|md))/g)].map((m) => m[1]!);
  assert.ok(promised.length > 3, "this test needs the briefing to name some files");
  for (const file of new Set(promised)) {
    assert.ok(written.has(file), `the briefing promises /current/${file}, but no turn writes it`);
  }
});

test("the example lines in the briefing use fields the writer can actually produce", async () => {
  const { BRIEFING } = await import("../src/agent/briefing.ts");
  const { runDir } = await setup();
  const turnDir = join(runDir, "agents", "alpha", "turns", "t0042");

  // Only the structural fields, on purpose. The briefing describes the real game, which holds more
  // per unit than the fake models — demanding an exact match would force the prompt to describe
  // the fake instead of Civ. What must never drift is the SHAPE: the fields that identify a thing
  // and are always emitted. A rename like prod_turns_left -> building is caught here.
  const STRUCTURAL: Record<string, string[]> = {
    unit: ["owner", "type", "at", "hp", "moves"],
    // `name` is no longer a field: a settlement line LEADS with its name, the way a human sees it.
    settlement: ["kind", "engine_id", "owner", "at", "pop"],
    tile: ["terrain", "biome", "vis"],
  };
  for (const [kind, fields] of Object.entries(STRUCTURAL)) {
    // Match the indented `kind <id> key=` example form, not prose that happens to start with the
    // word. "settlement becomes." is a sentence, not a sample line.
    // Match the indented `kind <id> key=` example form, not prose that happens to start with the
    // word, and join its wrapped continuation lines — the tile example runs to three.
    const all = BRIEFING.split("\n");
    const start = all.findIndex((l) => new RegExp(`^\\s+${kind} \\S+ \\w+=`).test(l));
    let example: string | undefined;
    if (start >= 0) {
      const parts = [all[start]!];
      for (let i = start + 1; i < all.length && /^\s{6,}\S+=/.test(all[i]!); i++) parts.push(all[i]!);
      example = parts.join(" ");
    }
    assert.ok(example, `the briefing must show an example ${kind} line`);
    const file = { unit: "units.txt", settlement: "settlements.txt", tile: "tiles.txt" }[kind]!;
    const real = readFileSync(join(turnDir, file), "utf8").split("\n")[0] ?? "";
    for (const field of fields) {
      assert.ok(example!.includes(`${field}=`), `the ${kind} example must show ${field}=`);
      assert.ok(real.includes(`${field}=`), `${file} must emit ${field}=, which the briefing shows`);
    }
  }
});

// `civ hud` replayed the string built at turn start, so an agent that acted and then asked where
// it stood was shown where it stood before acting — in the one command whose whole job is that.
test("civ hud shows the situation now, not at the start of the turn", async () => {
  const { session } = await setup();
  const before = await session.exec("civ hud");
  assert.match(before.stdout, /moves=2/, "this test needs the unit to start with its moves");

  const moved = await session.exec("civ move 10 2,1");
  assert.equal(moved.exitCode, 0, moved.stderr);

  const after = await session.exec("civ hud");
  assert.match(after.stdout, /moves=1/, "the HUD must reflect what the agent just did");
  // The delta is the deliberate exception: what changed since LAST turn does not change mid-turn.
  assert.match(after.stdout, /## What changed/);
});

// actions.txt offered `civ do player-op CHANGE_TRADITION` with no arguments, and an agent
// reasonably concluded it should experiment — spending its turn on our argument shapes rather
// than on the game.
//
// Operations we cannot call are still listed, because hiding what exists is a handicap. They are
// listed LAST, in their own section. Inline, they dominated: a settlement's three lines were all
// unknown and the player section opened with twenty — CREATE_ELEMENT, EXECUTE_SCRIPT and other
// engine internals no human sees a button for. As a menu that is a list of traps, since each is
// refused with no reason at all.
test("the action list says which lines are ready to run and which are not", async () => {
  const { actionLines } = await import("../src/dump/actions.ts");
  const lines = actionLines({
    units: [{ id: "10", type: "scout", at: "1,1", moves: 2, operations: ["UNITOPERATION_MOVE_TO", "UNITOPERATION_ALERT"], commands: [] }],
    settlements: [],
    player: ["CHANGE_TRADITION", "ASSIGN_WORKER"],
  });
  const text = lines.join("\n");

  // Operations with a purpose-built command are named, ready to run, and carry no warning.
  assert.match(text, /civ move 10 <x,y>$/m);
  assert.match(text, /civ tradition <TYPE>$/m);

  // The ones we cannot call are still present.
  assert.match(text, /UNITOPERATION_ALERT/);
  assert.match(text, /ASSIGN_WORKER/);

  // But below the divider, and the divider says why they are not to be tried.
  const divider = text.indexOf("nothing here knows what");
  assert.ok(divider > 0, "the unusable operations need a section that explains itself");
  assert.ok(text.indexOf("civ move 10") < divider, "runnable commands come first");
  assert.ok(text.indexOf("ASSIGN_WORKER") > divider, "unusable ones must not sit in the menu");
});

// Never desynced: whatever an agent reads, by any route, reflects everything it has done.
// The engine applies requests asynchronously, so this is not free — it is why the dump settles
// before every command rather than being refreshed eagerly after each action.
test("every route to the state shows the same, current answer", async () => {
  const { session } = await setup();
  await session.exec("civ move 10 2,1");

  // Four different ways an agent can ask where its unit is. They must agree.
  const grepped = await session.exec("grep 'engine_id=10 ' /current/units.txt");
  const jq = await session.exec("jq -r 'select(.id==\"10\") | .movesRemaining' /current/units.jsonl");
  const hud = await session.exec("civ hud");
  const actions = await session.exec("cat /current/actions.txt");

  assert.match(grepped.stdout, /moves=1/, "the text dump");
  assert.equal(jq.stdout.trim(), "1", "the JSONL twin");
  assert.match(hud.stdout, /moves=1/, "the HUD");
  assert.match(actions.stdout, /unit 10 .*moves=1/, "and the action list");
});

// A turn's archived files should show how the turn actually ended, since the replay and the run
// report read them after the fact.
test("the turn's files reflect the final state once the turn ends", async () => {
  const { session, runDir } = await setup();
  await session.exec("civ move 10 2,1");
  await session.exec("civ skip 10");
  await session.exec("civ end-turn");

  const units = readFileSync(join(runDir, "agents/alpha/turns/t0042/units.txt"), "utf8");
  assert.match(units, /moves=0/, "the archived dump must show the unit as finished");
});

// The stall that ended the marathon run at turn 4, and the 50-turn run at turn 10.
//
// A blocking notification comes in two kinds and the difference decides everything. An alert (a
// natural wonder found) clears when you dismiss it. A DECISION —
// NOTIFICATION_TRADITIONS_AVAILABLE — exists to make you choose, and ignores dismissal entirely.
// The forced end-turn only knew how to dismiss, so it dismissed a decision eight times,
// sendTurnComplete was refused without a word, and the seat stayed active until the run was
// killed. The log said "no seat became active" for hours.
test("a forced end-turn answers a decision notification instead of dismissing it", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-blocker-"));
  const world = makeWorld();
  world.notifications.set(0, [
    {
      id: 900,
      name: "NOTIFICATION_TRADITIONS_AVAILABLE",
      typeHash: 9001,
      blocking: true,
      dismissible: false,
    },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);

  // The agent's own end-turn is refused, and says why.
  const refused = await server.endTurn(0);
  assert.equal(refused.ok, false, "a blocking decision must refuse the agent's end-turn");
  assert.match(String(refused.message), /NOTIFICATION_TRADITIONS_AVAILABLE/);

  // The forced one gets through, by adopting a tradition — the only thing that clears it.
  const forced = await server.endTurn(0, true);
  assert.equal(forced.ok, true, "the forced end-turn must clear the decision and send");
  assert.deepEqual(
    world.notifications.get(0),
    [],
    "dismissal cannot clear a decision; answering it must",
  );
  assert.equal(
    (world.traditions.get(0) ?? []).length,
    1,
    "answering the traditions decision means actually adopting one",
  );
});

// Traditions are addressed by ROW INDEX plus an Action enum, not by the type hash every other
// operation takes. Sending the hash returned ok and changed nothing, so two agents went twelve
// turns with no social policy while the harness reported each attempt as a success.
test("adopting a tradition sends its row index, not its hash", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-tradition-"));
  const world = makeWorld();
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  await server.choose(0, "tradition", "TRADITION_FAKE_ISONOMY");
  assert.deepEqual(
    world.traditions.get(0),
    [1],
    "TRADITION_FAKE_ISONOMY is row index 1; a hash here means the engine silently ignores it",
  );
});

// The human's policy screen shows what you hold and how many slots are left. Ours showed neither:
// `current` returned null, so an agent could not see its own policies, re-picked one it already
// had, and read the refusal as the command being broken. With slots full there was also no way to
// swap — `civ tradition` could only fail from that point on.
test("civ tradition shows what is held, and can drop one to make room", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-policy-"));
  const world = makeWorld();
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 9, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  await server.choose(0, "tradition", "TRADITION_FAKE_ISONOMY");

  const held = await server.choose(0, "tradition");
  assert.match(String(held.current), /TRADITION_FAKE_ISONOMY/, "an agent must see its own policies");
  assert.match(String(held.current), /tradition 1\/2/, "and how much room is left");

  await server.choose(0, "tradition", "-TRADITION_FAKE_ISONOMY");
  assert.deepEqual(world.traditions.get(0), [], "a leading - must drop the policy, not adopt it");
});

// Diplomacy and trade, which no live match had ever reached. Both were written from the game's
// source and never run, and both were broken.
async function diplomacySetup() {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-diplo-"));
  const world = makeWorld();
  world.met[0] = [1];
  world.met[1] = [0];
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 20, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  return { server, world };
}

// `Number(null)` is 0, not NaN. `civ diplomacy` with no target read as "target player 0", so the
// who-have-you-met listing was unreachable and an agent asking who it knew got a list of offers
// against seat 0 — sometimes itself.
test("civ diplomacy with no target lists who you have met", async () => {
  const { server } = await diplomacySetup();
  const known = await server.diplomacy(0);
  assert.deepEqual(
    (known.players ?? []).map((p) => p.player),
    ["p1"],
    "no target must list met civs, not target player 0",
  );
});

// MAKE_PEACE does not end in DIPLOMATIC_ACTION and was not in the explicit operation list, so no
// command could reach it: an agent could declare war and was stuck in it for the whole match.
test("war can be declared and then ended", async () => {
  const { server, world } = await diplomacySetup();
  const war = await server.diplomacy(0, 1, "DIPLOMACY_ACTION_DECLARE_WAR");
  assert.equal(war.ok, true, "declaring war must reach the engine");
  assert.ok(world.atWar.has("0-1"), "and must actually start a war");

  const peace = await server.diplomacy(0, 1, "DIPLOMACY_ACTION_MAKE_PEACE");
  assert.equal(peace.ok, true, "MAKE_PEACE must be reachable, or a war can never end");
  assert.equal(world.atWar.has("0-1"), false, "and must actually end it");
});

// Every call in deal.js had the wrong signature, there was no way to add an item, and the harness
// reported an empty deal as sent. Trade has never worked and could not have.
test("a trade deal carries its items and is sent with a proposal action", async () => {
  const { server, world } = await diplomacySetup();
  const offerable = await server.deal(0, "items", 1);
  assert.ok((offerable.offerable ?? []).length > 0, "the engine must offer something to trade");

  const added = await server.deal(0, "offer", 1, { kind: "GOLD", amount: 100 });
  assert.equal(added.ok, true, "an item must actually go onto the working deal");
  assert.equal(world.dealItems.length, 1, "and the engine must receive it");

  const sent = await server.deal(0, "send", 1);
  assert.equal(sent.ok, true, "sending must succeed");
  assert.deepEqual(world.dealsSent, [{ from: 0, to: 1, items: 1 }], "the deal must go out with its item");
});

// The failure that did the most damage in this project, and was completely silent.
//
// actions.js called .map on a GameInfo table. No GameInfo table has .map, so it threw on every
// call, and beginTurn wrote actions.txt inside an empty catch. The file was NEVER WRITTEN — 0 of
// 33 turn directories in a live run had one — while the briefing tells agents four times to read
// it and "never guess an action name or its arguments". They had nothing to read, so they
// guessed, and 43 of 52 failures in ten turns answered "the game refused this action and gave no
// reason". Existence alone is not enough here: the catch now writes an explanation into the same
// file, and that must not count as success.
test("actions.txt lists real actions, not a harness error", async () => {
  const { runDir } = await setup();
  const actions = readFileSync(join(runDir, "agents/alpha/turns/t0042/actions.txt"), "utf8");
  assert.doesNotMatch(actions, /harness could not read/, "the legal action list must actually build");
  const real = actions.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  assert.ok(real.length > 0, "an agent with no legal actions listed will guess, and guessing is the bug");
  assert.match(actions, /civ /, "each line must name a command the agent can actually type");
});

// "The game refused this action and gave no reason" was the answer to 43 of 52 failures in ten
// turns. It is unanswerable: one agent wrote "maybe it's a small technical hiccup that will clear
// up on its own" and moved on. Most of those were a unit that had simply finished its turn — a
// fact the engine states plainly the moment anything asks it.
test("a refused action says what it can see, never just 'no reason'", async () => {
  const { session } = await setup();
  await session.exec("civ skip 10");
  // An order the unit cannot take. `civ skip` on a finished unit is now a success — that is the
  // state the command asks for — so this uses an operation the engine actually refuses.
  const refused = await session.exec("civ do unit-op 10 UNITOPERATION_FORTIFY");
  assert.notEqual(refused.exitCode, 0, "an order a finished unit cannot take is not a success");
  assert.match(refused.stdout, /state:/, "the engine's own facts must reach the agent");
  assert.doesNotMatch(refused.stdout, /standing orders \(AWAKE\)/, "AWAKE is not a standing order");
});

// Notification ids come and go DURING a turn, so an agent acting on one it read a moment earlier
// gets a miss. "You have no notification 28" gave it nowhere to go.
test("a stale notification id says what is pending instead of dead-ending", async () => {
  const { session } = await setup();
  const missing = await session.exec("civ dismiss 9999");
  assert.notEqual(missing.exitCode, 0);
  assert.match(missing.stdout, /cleared earlier this turn|nothing is pending|pending right now/);
});

// `civ move` answered "ok" and nothing else. A move order spends the movement a unit has and then
// stops, so a distant target ends the turn short of it. With only "ok" an agent cannot tell
// arrival from a partial move, and one spent a whole turn writing "I need to look into movement
// mechanics, possibly considering how movement only consumes one tile" instead of playing.
test("civ move says where the unit ended up and what it has left", async () => {
  const { session } = await setup();
  const moved = await session.exec("civ move 10 2,1");
  assert.equal(moved.exitCode, 0, moved.stderr);
  assert.match(moved.stdout, /is at \d+,\d+/, "it must say where the unit actually is");
  assert.match(moved.stdout, /moves? left/, "and how much movement remains");
});

// Three different situations used to print the same line: a failed read, a seat that has already
// played this round, and a genuinely idle game. An hour of a live run was spent reading "the game
// may be waiting on something" at a healthy game whose socket had dropped.
//
// The first fix threw instead — which killed a healthy run at turn 14, because "the game is on p1
// while we wait for p2" is an ordinary transient that resolves itself. Say which it is; carry on.
test("waiting for a seat says which of the three it is, and does not throw", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-seat-"));
  const world = makeWorld();
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  // Seat 99 is not in this game, so nothing of ours is ever active.
  const seat = await server.activeSeat([99], 1200);
  assert.equal(seat, null, "a seat that is not ours is not our seat");
  assert.match(server.lastSeatWait, /already played this round/, "it must say the game moved on");
  assert.match(server.lastSeatWait, /p99/, "and name the seat we are actually waiting for");
});

// A deadlock the harness caused itself.
//
// If a seat's end-turn does not take — a blocking notification, a unit the engine still wants
// orders for — the game offers it the same turn again. The round saw "already played this turn"
// and waited for the turn to advance, but nothing advances a turn that no one is ending. A live
// run printed "already played" against "the game is on p1" until it was killed. End it for them.
test("a seat the game offers twice gets its turn ended, not waited on", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-twice-"));
  const world = makeWorld();
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);

  // A blocking decision the agent never answered, so its own end-turn is refused.
  world.notifications.set(0, [
    { id: 900, name: "NOTIFICATION_TRADITIONS_AVAILABLE", typeHash: 9001, blocking: true, dismissible: false },
  ]);
  const refused = await server.endTurn(0);
  assert.equal(refused.ok, false, "a blocking decision must refuse the agent's own end-turn");

  // The forced end-turn is the way out, and it must actually work from this state.
  const forced = await server.endTurn(0, true);
  assert.equal(forced.ok, true, "the harness must be able to end a turn the agent could not");
});

// CITYOPERATION_BUILD APPENDS to a queue; it does not replace what is in progress. The harness
// showed only `currentProductionTypeHash` and answered "build set to X", so an agent that queued
// a granary behind a scout saw the scout, concluded the order had not stuck, and queued the
// granary again — three times in one turn, in a run where every one of those orders had worked.
// A town builds nothing but its focus. One seat, told only `civ build <town>`, queued seventeen
// scouts across two towns in a single turn against a prompt that only a focus answers.
test("a town offers only its focus, refuses units in plain words, and sends the focus exclusive", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-town-"));
  const world = makeWorld();
  world.cities.push({ id: 50, owner: 0, name: "Ajaccio", x: 2, y: 2, isTown: true });
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 10, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const town = await session.exec("civ build 50");
  assert.match(town.stdout, /civ build 50 PROJECT_TOWN_TEST/, "the focus is offered as a runnable command");
  assert.doesNotMatch(town.stdout, /UNIT_|BUILDING_|PROJECT_TEST\b/, "nothing a town cannot build is listed");
  assert.match(town.stdout, /this is a town/, "and the listing says why in plain words");

  const city = await session.exec("civ build 30");
  assert.match(city.stdout, /PROJECT_TEST/, "a city keeps its own projects");
  assert.doesNotMatch(city.stdout, /PROJECT_TOWN_TEST/, "and never a town's focus");

  const unit = await session.exec("civ build 50 UNIT_WARRIOR");
  assert.notEqual(unit.exitCode, 0, "a unit in a town is refused");
  assert.match(unit.stdout, /Ajaccio is a town/, "with the reason, not 'no such build'");

  const focus = await session.exec("civ build 50 PROJECT_TOWN_TEST");
  assert.equal(focus.exitCode, 0, focus.stdout);
  const sent = world.cityRequests.at(-1)!;
  assert.equal(sent.ProjectType, 2, "the project goes by row index");
  assert.equal(sent.InsertMode, 1, "and replaces the queue, as the game's own chooser sends it");
});

test("a move with no path is refused before it is sent, with the reason", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-path-"));
  const world = makeWorld();
  world.unreachable.add("7,7");
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 10, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const refused = await session.exec("civ move 10 7,7");
  assert.notEqual(refused.exitCode, 0, "no path means no order");
  assert.match(refused.stdout, /NO_PATH/);
  assert.match(refused.stdout, /no path from 1,1 to 7,7/, "it says where from and where to");
  assert.equal(world.unitMoves.size, 0, "nothing reached the engine");

  const fine = await session.exec("civ move 10 2,1");
  assert.equal(fine.exitCode, 0, fine.stdout);
});

test("a town buys with gold: the list prices it, the purchase is sent, and the treasury proves it", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-buy-"));
  const world = makeWorld();
  world.cities.push({ id: 50, owner: 0, name: "Ajaccio", x: 2, y: 2, isTown: true });
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 10, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const listing = await session.exec("civ buy 50");
  assert.match(listing.stdout, /civ buy 50 UNIT_WARRIOR\s+# 60 gold/, "the price sits beside the runnable command");
  assert.match(listing.stdout, /100 gold in the treasury/);

  const bought = await session.exec("civ buy 50 UNIT_WARRIOR");
  assert.equal(bought.exitCode, 0, bought.stdout);
  assert.match(bought.stdout, /bought UNIT_WARRIOR for 60 gold; 40 gold left/);
  assert.equal(world.purchases.length, 1, "one purchase reached the engine");
  assert.ok(Number.isInteger(world.purchases[0]!.args.UnitType), "a unit goes by its type hash, as the game's chooser sends it");
});

test("a town-focus blocker names the town and the focus choices when the turn is refused", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-focus-"));
  const world = makeWorld();
  world.cities.push({ id: 50, owner: 0, name: "Ajaccio", x: 2, y: 2, isTown: true });
  world.notifications.set(0, [
    { id: 503, name: "NOTIFICATION_CHOOSE_TOWN_PROJECT", typeHash: 77001, blocking: true, dismissible: false, target: { id: 50, owner: 0 } },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  await session.exec("civ skip 10");
  const refused = await session.exec("civ end-turn");
  assert.notEqual(refused.exitCode, 0, "the focus prompt blocks the turn");
  assert.match(refused.stdout, /Ajaccio has grown enough to choose its town focus/, "the town is named in plain words");
  assert.match(refused.stdout, /civ build 50 PROJECT_TOWN_TEST/, "and the answer is a runnable command");
});

test("civ build says it joined a queue, and shows the queue", async () => {
  const { session } = await setup();
  const first = await session.exec("civ build 30 UNIT_WARRIOR");
  assert.equal(first.exitCode, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /build set to/, "a build joins a queue rather than replacing");
  assert.match(first.stdout, /added to the build queue/);

  const listing = await session.exec("civ build 30");
  assert.equal(listing.exitCode, 0, listing.stderr);
  assert.match(listing.stdout, /UNIT_WARRIOR/, "the queued item must be visible to the agent");
});

// Half of all end-turn attempts in a live run were refused, and every one was told to run
// `civ dismiss` — which does nothing at all to a decision notification. The table that knows the
// right command per blocker already existed; it was only being used to build the turn-start HUD,
// which is stale by the time an agent actually tries to end its turn.
test("a refused end-turn names the command that answers the blocker", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-answer-"));
  const world = makeWorld();
  world.notifications.set(0, [
    { id: 900, name: "NOTIFICATION_TRADITIONS_AVAILABLE", typeHash: 9001, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);

  const refused = await server.endTurn(0);
  assert.equal(refused.ok, false);
  assert.match(String(refused.hint), /civ tradition/, "it must name the command that answers it");
  assert.doesNotMatch(String(refused.hint), /dismiss/, "dismiss cannot clear a decision");
});

// The loop that cost a live run half its end-turns.
//
// NOTIFICATION_TRADITIONS_AVAILABLE does not clear when you adopt a policy. The game's own policy
// screen sends CONSIDER_ASSIGN_TRADITIONS when it CLOSES — that is the "I have looked" signal the
// notification waits for. Without it an agent adopts, sees the blocker still there, adopts again:
// 29 of 40 refused end-turns in one run, with `civ tradition` tried ten times against a full board.
test("adopting a policy does not clear the blocker, but finishing does", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-finish-"));
  const world = makeWorld();
  world.notifications.set(0, [
    { id: 900, name: "NOTIFICATION_TRADITIONS_AVAILABLE", typeHash: 9001, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 9, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);

  await server.choose(0, "tradition", "TRADITION_FAKE_ISONOMY");
  assert.deepEqual(world.traditions.get(0), [1], "the policy is adopted");
  assert.equal(
    (world.notifications.get(0) ?? []).length,
    1,
    "and the notification is STILL there — this is what the loop was",
  );

  const done = await server.choose(0, "tradition", "done");
  assert.equal((done as { ok?: boolean }).ok, true, "`done` must be accepted");
  assert.deepEqual(world.notifications.get(0), [], "finishing is what clears it");
});

// Four rounds of correct commands against a requirement the agent was never told the subject of.
//
// NOTIFICATION_COMMAND_UNITS means "a unit needs orders". The refusal named the NOTIFICATION and
// hinted `civ move <unit> <x,y>` — a literal placeholder. Ada moved all three of its units, was
// refused, moved them again, tried WAIT_FOR, and was refused again. The engine knows which unit
// it is waiting on; the harness just never asked.
test("a turn blocked on units names the unit, not the notification", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-whichunit-"));
  const world = makeWorld();
  world.notifications.set(0, [
    { id: 901, name: "NOTIFICATION_COMMAND_UNITS", typeHash: 9002, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);

  const refused = await server.endTurn(0);
  assert.equal(refused.ok, false);
  const said = `${refused.message} ${refused.hint}`;
  assert.match(said, /unit 10\b/, "it must name the unit the game is actually waiting on");
  assert.doesNotMatch(String(refused.hint), /<unit>/, "a placeholder is not an answer");
  assert.match(String(refused.hint), /civ skip 10/, "and give a command that can be run as written");
});

// Eighteen turns blocked on NOTIFICATION_CHOOSE_CITY_PRODUCTION, answered with the
// notification's name. With more than one settlement an agent cannot tell which is idle — the
// same disease that cost ninety-two turns on COMMAND_UNITS.
test("a turn blocked on production names the settlement with the empty queue", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-whichcity-"));
  const world = makeWorld();
  world.notifications.set(0, [
    { id: 902, name: "NOTIFICATION_CHOOSE_CITY_PRODUCTION", typeHash: 9003, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);

  const refused = await server.endTurn(0);
  assert.equal(refused.ok, false);
  const said = `${refused.message} ${refused.hint}`;
  assert.match(said, /Waset|build queue/, "it must point at the settlement, not the notification");
  assert.match(String(refused.hint), /civ build 30/, "and give a command that runs as written");
});

// The biggest single lie the harness told: 88 of 144 moves in one run went nowhere and reported
// `ok`. The engine ACCEPTS a move order it cannot carry out — unreachable plot, blocked path —
// and does nothing. We printed `ok` followed by the unit's ORIGIN, which reads exactly like a
// successful move. One agent wrote "it seems the move didn't work... so nothing has changed"
// while the harness was still saying ok.
test("a move that goes nowhere is reported as a failure, not as ok", async () => {
  const { session } = await setup();
  const real = await session.exec("civ move 10 2,1");
  assert.equal(real.exitCode, 0, real.stderr);
  assert.match(real.stdout, /is at 2,1/, "a move that works reports where it arrived");

  // Same plot again: the unit is already there, so the engine accepts and moves nothing.
  const nowhere = await session.exec("civ move 10 9,9");
  if (nowhere.exitCode === 0) {
    assert.doesNotMatch(nowhere.stdout, /is at 2,1\b/, "reporting the origin as success is the bug");
  } else {
    assert.match(nowhere.stdout, /DID_NOT_MOVE|still at/, "and a no-op must say so plainly");
  }
});

for (const moves of [0, 2]) {
  test(`an accepted stalled move reports ${moves} remaining movement and the matching next step`, async () => {
    const { session, world } = await setup();
    world.unitMoves.set(10, moves);
    world.stalledMoves.add(10);

    const result = await session.exec("civ move 10 2,1");
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /DID_NOT_MOVE/);
    assert.match(result.stdout, new RegExp(`${moves} movement remaining`));
    assert.doesNotMatch(result.stdout, /movement unspent|probably unreachable/);
    if (moves === 0) {
      assert.match(result.stdout, /another move next turn/);
      assert.doesNotMatch(result.stdout, /civ near/);
    } else {
      assert.match(result.stdout, /civ near 10 2/);
      assert.doesNotMatch(result.stdout, /finished moving for this turn/);
    }
  });
}

// 36 of 41 journal writes across three runs used `>` instead of `>>`, so six of nine agents
// finished a fifteen-turn game with one line of memory and three with none — in the one file the
// briefing calls "the only thing that survives between turns". `civ note` cannot overwrite.
test("civ note appends to the journal and never overwrites it", async () => {
  const { session, runDir } = await setup();
  const notes = join(runDir, "notes", "alpha", "notes.md");
  const before = readFileSync(notes, "utf8");

  await session.exec("civ note 'settled on the river at 47,16'");
  await session.exec("civ note 'salt at 48,12 was refused as a city site'");

  const after = readFileSync(notes, "utf8");
  assert.ok(after.startsWith(before), "everything already written must survive");
  assert.match(after, /settled on the river at 47,16/);
  assert.match(after, /salt at 48,12 was refused/, "the second note must not replace the first");
});

// FOUND_CITY takes no arguments, so `civ do unit-op <id> UNITOPERATION_FOUND_CITY` runs exactly
// as printed. It was filed under the "nothing here knows what arguments they take — do not try
// these" divider, which is where the most important action in the game does not belong. One agent
// lost three consecutive turns to it.
test("argument-free operations are offered as runnable, not as do-not-try", async () => {
  const { actionLines } = await import("../src/dump/actions.ts");
  const lines = actionLines({
    units: [{ id: "10", type: "founder", at: "1,1", moves: 3, operations: ["UNITOPERATION_FOUND_CITY"], commands: [] }],
    settlements: [],
    player: [],
  });
  const text = lines.join("\n");
  const divider = text.indexOf("nothing here knows what");
  const found = text.indexOf("UNITOPERATION_FOUND_CITY");
  assert.ok(found > 0, "founding must be offered at all");
  assert.ok(divider === -1 || found < divider, "and above the do-not-try divider");
});

// "An ok is not evidence." The engine accepts CITYOPERATION_BUILD with the wrong argument
// encoding and queues nothing, so a live turn printed "BUILDING_GRANARY added to the build queue"
// and "Pārsa has nothing in its build queue" — both from this harness, in the same turn.
//
// The encoding is the bug; this is the check that would have caught it whatever the bug was.
test("civ build refuses to claim anything that is not in the queue afterwards", async () => {
  const { session } = await setup();
  const ok = await session.exec("civ build 30 BUILDING_GRANARY");
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.match(ok.stdout, /BUILDING_GRANARY/, "a real queue must be reported back");

  const listing = await session.exec("civ build 30");
  assert.match(listing.stdout, /BUILDING_GRANARY/, "and the item must actually be in the queue");
});

// The loop every transcript reader found: end-turn says "give unit X an order: `civ skip X`",
// the agent runs exactly that, and it fails — because the unit already has orders or has spent
// its moves. The harness was refusing the command it had just recommended. Being already
// finished is the state `civ skip` asks for, so it is a success.
test("civ skip on a unit that is already finished succeeds", async () => {
  const { session } = await setup();
  const first = await session.exec("civ skip 10");
  assert.equal(first.exitCode, 0, first.stdout);

  const again = await session.exec("civ skip 10");
  assert.equal(again.exitCode, 0, "asking for a state the unit is already in is not a failure");
  assert.match(again.stdout, /does not need orders/);
});

// Civ addresses units by ComponentID — 65536, 131072. A human never sees one, and handing them to
// agents did what you would expect: "I need to build a city ID, which I think is likely around
// 65536", ids invented by adding 65536 to the last one, and `civ near 65536` answering "you have
// no unit 65536" because 65536 was a city. The settler is unit 65536 and the city it founds is
// settlement 65536, which is how one agent came to believe they were the same thing.
test("units have readable names, and commands take them", async () => {
  const { session, runDir } = await setup();
  const units = readFileSync(join(runDir, "agents/alpha/turns/t0042/units.txt"), "utf8");
  assert.match(units, /^unit \w+-\d+ /m, "a unit line must lead with a readable handle");
  assert.match(units, /engine_id=\d+/, "and still carry the engine's own id");

  const byHandle = await session.exec("civ move warrior-1 2,1");
  assert.equal(byHandle.exitCode, 0, byHandle.stdout);
  assert.match(byHandle.stdout, /is at 2,1/, "a handle must work wherever an id does");
});

// `civ say`, `civ diplomacy` and `civ deal` were used ZERO times across three runs and 83 turns.
// The briefing's strongest instruction is "never guess an action name — actions.txt lists
// everything the engine will accept", and actions.txt only listed per-unit and per-settlement
// operations. The agents obeyed, and the entire social half of the benchmark went unused.
test("actions.txt lists the commands that are always available", async () => {
  const { runDir } = await setup();
  const actions = readFileSync(join(runDir, "agents/alpha/turns/t0042/actions.txt"), "utf8");
  for (const command of ["civ say", "civ diplomacy", "civ deal", "civ note"]) {
    assert.ok(actions.includes(command), `actions.txt must offer ${command}, or nobody uses it`);
  }
  const divider = actions.indexOf("nothing here knows what");
  if (divider > 0) {
    assert.ok(actions.indexOf("civ say") < divider, "and offer it as usable, not as do-not-try");
  }
});

// Some units refuse SKIP, SLEEP, FORTIFY and ALERT with no reason at all. Agents brute-forced
// their way out — one needed nine commands to find UNITOPERATION_EXECUTE_SCRIPT, and that stopped
// working the next turn. The engine will list what it accepts if asked.
test("a turn blocked on a unit says what the engine will accept for it", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-stuck-"));
  const world = makeWorld();
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  const refused = await server.endTurn(0);
  assert.equal(refused.ok, false, "an unordered unit blocks the turn");
  assert.match(
    String(refused.hint),
    /the engine will accept these for unit/,
    "a dead end must be turned into a list of what works",
  );
});

// "legacy: none" printed on every turn of every run, in a benchmark whose stated goal is winning
// the Age. The harness read getEnabledLegacyPaths(), which returns [] in a real game; the game's
// own victory manager iterates GameInfo.LegacyPaths instead. Two more faults hid behind that: the
// target was matched by comparing a string against a hash, and it summed age-progression points
// rather than the final milestone's RequiredPathPoints.
test("the HUD shows progress toward winning the Age", async () => {
  const { hud } = await setup();
  assert.doesNotMatch(hud, /legacy: none/, "a benchmark about winning must show progress to a win");
  assert.match(hud, /legacy:.*\d+\/\d+/, "each path needs a score and the score that wins it");
});

// The mid-turn refresh rewrote units.txt without handles, so `unit scout-1 ...` became
// `unit 131072 ...` on the first settle of every turn — the names existed only until the agent
// did anything. Every route to the state must show the same names.
test("unit names survive the mid-turn refresh", async () => {
  const { session, runDir } = await setup();
  const path = join(runDir, "agents/alpha/turns/t0042/units.txt");
  assert.match(readFileSync(path, "utf8"), /^unit \w+-\d+ /m, "named at turn start");

  await session.exec("civ move warrior-1 2,1");
  assert.match(readFileSync(path, "utf8"), /^unit \w+-\d+ /m, "and still named after acting");
});

// "26,25 is not one of your options for expand" invites another guess. When there are no options
// at all it is because no citizen is waiting to be placed — a different thing entirely, and the
// commonest remaining failure in a clean run.
test("expanding with no citizen to place says so, rather than listing nothing", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-nogrow-"));
  const world = makeWorld();
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  const refused = (await server.choose(0, "expand", "9,9", "30")) as { ok?: boolean; message?: string };
  if (refused.ok !== false) return; // the fake allows it; nothing to assert
  assert.match(
    String(refused.message),
    /no citizen waiting|not one of your options/,
    "a refusal must distinguish 'wrong plot' from 'nothing to place'",
  );
});

// 136 refusals across 8 units in one 26-turn run, every one "the game refused this action and
// gave no reason". The units were part-way through a multi-turn operation — auto-explore, a
// queued path — which makes them refuse every new order until they finish. Nothing on the unit
// line said so, so agents re-ordered them every turn for the rest of the match.
test("a unit's standing orders are on its line, so agents stop re-ordering it", async () => {
  const { runDir } = await setup();
  const units = readFileSync(join(runDir, "agents/alpha/turns/t0042/units.txt"), "utf8");
  const first = units.split("\n")[0] ?? "";
  // A unit awaiting orders carries neither field; the point is that a BUSY one must carry them.
  assert.ok(
    !first.includes("busy=yes") || first.includes("orders="),
    "a busy unit must say what it is doing",
  );
  const { STANDING_ORDERS_DOC } = { STANDING_ORDERS_DOC: readFileSync("src/adapter/gamejs/_prelude.js", "utf8") };
  assert.match(STANDING_ORDERS_DOC, /"OPERATION"/, "a unit mid-operation counts as already ordered");
});

// The custom shell tools (grep, head, sed, ...) resolve paths themselves. Relative paths used to
// resolve against nothing and were SKIPPED SILENTLY: `grep x tiles.txt` printed nothing and
// exited 1, which reads exactly like "no matches" — an agent concluded the thing it was looking
// for did not exist.
test("relative paths resolve against /current, and a missing file is a loud error", async () => {
  const { session } = await setup();
  const relative = await session.exec("grep -c vis= tiles.txt");
  assert.equal(relative.exitCode, 0, relative.stderr);
  assert.ok(Number(relative.stdout.trim()) > 0, "the relative read must actually see the file");

  const missing = await session.exec("grep anything /current/no-such-file.txt");
  assert.notEqual(missing.exitCode, 0);
  assert.match(missing.stderr, /No such file/, "a missing file must not read as 'no matches'");
});

// The sandbox sed only handled line ranges while its own error message claimed s/// worked.
test("sed substitution works on files and pipes", async () => {
  const { session } = await setup();
  const onFile = await session.exec("sed 's/vis=visible/SEEN/' /current/tiles.txt");
  assert.equal(onFile.exitCode, 0, onFile.stderr);
  assert.match(onFile.stdout, /SEEN/);
  const piped = await session.exec("echo hello-world | sed 's/-/ /g'");
  assert.equal(piped.stdout.trim(), "hello world");
});

// Six "ok — dismissed" answers in a row once sent an agent in circles for a whole turn: the
// engine ignores dismissal of a decision notification, and the harness never checked. The server
// now polls after the dismissal and downgrades the ok when the notification still stands.
test("a dismissal the game ignores is called out, with the command that answers it", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-dismiss-verify-"));
  const world = makeWorld();
  world.notifications.set(0, [
    { id: 601, name: "NOTIFICATION_CHOOSE_TECH", typeHash: 87654321, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const result = await session.exec("civ dismiss");
  assert.notEqual(result.exitCode, 0, "an ignored dismissal must not report ok");
  // Refused up front now (NOT_DISMISSIBLE); the post-hoc "ignored the dismissal" path still
  // backs it for decision types the up-front list does not know.
  assert.match(result.stdout, /NOT_DISMISSIBLE|ignored the dismissal/);
  assert.match(result.stdout, /civ tech/);
  assert.doesNotMatch(result.stdout, /civ dismiss/);
  assert.match(hud, /civ tech/);
});

// One engine-internal op returned ok once and taught an agent a 17-turn ritual. A human player
// has no button for these; refusing them is parity, not a limit.
test("engine-internal operations are refused with a plain explanation", async () => {
  const { session } = await setup();
  const result = await session.exec("civ do unit-op 10 UNITOPERATION_EXECUTE_SCRIPT");
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /engine plumbing/);
});

// A closed session refuses everything: withTimeout races but never cancels, so a timed-out brain
// kept acting into the NEXT seat's turn — rewriting its files from reads taken under the wrong
// local player.
test("a closed session refuses commands and tells the brain the turn is over", async () => {
  const { session } = await setup();
  session.close();
  const result = await session.exec("civ hud");
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.turnOver, true);
  assert.match(result.stderr, /your turn is over/);
});

// A BUILDING silently failed to queue for the life of the project. `civ build X BUILDING_GRANARY`
// answered "added to the build queue", the queue stayed empty, and the agent was then told
// NOT_QUEUED — two harness statements contradicting each other in one turn. Units worked, so no
// aggregate failure rate looked wrong; only segmenting builds by ARGUMENT KIND exposed it.
// The cause: a constructible occupies a tile, and the game's own production chooser never sends
// a bare build for one — it carries a plot. See choose.js build.args.
test("a building carries a plot, so it actually reaches the build queue", async () => {
  const { session } = await setup();
  const built = await session.exec("civ build 30 BUILDING_GRANARY");
  assert.equal(built.exitCode, 0, `a building must queue, not silently fail: ${built.stdout}`);
  assert.doesNotMatch(built.stdout, /NOT_QUEUED/, "the queue must actually contain it afterwards");
});

// Agents reach for raw operations that have purpose-built commands, and the raw path fails
// almost every time because each operation wants a differently encoded argument (row index vs
// hash vs a plot). Across the runs: 29/29 CHANGE_GOVERNMENT, 31/33 SET_TECH_TREE_NODE and 22/28
// CITYCOMMAND_EXPAND failed this way, while the same decisions through `civ government` /
// `civ tech` / `civ expand` succeeded ~90% of the time. Send them to the command that works.
test("a raw operation with a real command redirects instead of failing silently", async () => {
  const { session } = await setup();
  const raw = await session.exec("civ do player-op CHANGE_GOVERNMENT GovernmentType=1");
  assert.notEqual(raw.exitCode, 0);
  assert.match(raw.stdout, /USE_THE_COMMAND/);
  assert.match(raw.stdout, /civ government/, "it must name the command that knows the encoding");
});

// `civ do unit-op U UNITOPERATION_MOVE_TO x=3 y=4` used to silently do nothing: the engine's
// coordinate arguments are X and Y, the lowercase keys were passed through untouched, and the
// order was refused "with no reason" — a move to a real plot that moved nothing. Agents write
// lowercase naturally, so this footgun turned reasonable commands into unexplained no-ops.
test("civ do normalizes lowercase x/y to the engine's X/Y", async () => {
  const { session, world } = await setup();
  const unit = world.units.find((u) => u.id === 10)!;
  assert.deepEqual([unit.x, unit.y], [1, 1], "starts where the world put it");
  const r = await session.exec("civ do unit-op 10 UNITOPERATION_MOVE_TO x=3 y=4");
  assert.equal(r.exitCode, 0, r.stdout);
  assert.deepEqual([unit.x, unit.y], [3, 4], "the move must land, not silently no-op on a case mismatch");
});

// Victory is CIV's call, read from getVictories() — the harness reports it faithfully and never
// invents or suppresses one. A run once flagged a 0-legacy game "a victory claimed by team 1"
// because ANY getVictories() entry was treated as a win with `?? "a victory"` papering over a null
// type; and a later over-correction wrongly SUPPRESSED real entries. These pin both directions.
test("a CIV-declared victory is reported faithfully, with the winner named", async () => {
  const { server, world } = await setup();
  world.victories = [{ team: 0, victory: 7 }];
  const decided = await server.gameOver();
  assert.equal(decided.over, true);
  assert.equal(decided.victory, true, "a getVictories() entry is a real win");
  assert.match(String(decided.why), /CIV_0/, "the winner is named, not just 'team 0'");
});

test("the FINAL age ending with no CIV victory ends the match but is NOT a victory", async () => {
  const { server, world } = await setup();
  world.victories = [];
  world.ageOver = true;
  world.finalAge = true; // a single-age game's one age is its final age
  const decided = await server.gameOver();
  assert.equal(decided.over, true, "the final age ending ends the match");
  assert.equal(decided.victory, false, "an age-end with no CIV victory is not a win");
  assert.match(String(decided.why), /age ended/i);
});

// A non-final age ending is an age TRANSITION, not the end of the game — reporting it as game-over
// once ended a multi-age match prematurely (and the transition itself deadlocked the run loop).
test("a non-final age ending is a transition, not game-over", async () => {
  const { server, world } = await setup();
  world.victories = [];
  world.ageOver = true;
  world.finalAge = false;
  const decided = await server.gameOver();
  assert.equal(decided.over, false, "the game continues into the next age");
});

test("an ongoing game with no victory and the age not over is not decided", async () => {
  const { server, world } = await setup();
  world.victories = [];
  world.ageOver = false;
  const decided = await server.gameOver();
  assert.equal(decided.over, false);
  assert.equal(decided.victory, false);
});

// NOTIFICATION_ASSIGN_NEW_RESOURCES blocks the end of a turn until each new resource is placed in a
// settlement, and there was no command for it — so the block could only be cleared by a human.
// `civ resource` lists them and assigns one (ASSIGN_RESOURCE with the {Location, City} args the
// game itself sends, no Action field).
test("civ resource lists resources and assigns one to a settlement", async () => {
  const { session, world } = await setup();
  world.resources[0] = [{ index: 5, hash: 999 }];
  const list = await session.exec("civ resource");
  assert.match(list.stdout, /RESOURCE_999/, list.stdout);
  assert.match(list.stdout, /city:30/, "the settlements that can take it are listed");
  const assign = await session.exec("civ resource RESOURCE_999 30");
  assert.equal(assign.exitCode, 0, assign.stdout);
  assert.equal(world.resourceAssigns.length, 1, "the assign must reach the engine");
  assert.equal(world.resourceAssigns[0]!.city, 30, "assigned to the named settlement");
});

test("civ resource refuses a resource the player does not have", async () => {
  const { session, world } = await setup();
  world.resources[0] = [];
  const assign = await session.exec("civ resource RESOURCE_404 30");
  assert.notEqual(assign.exitCode, 0);
  assert.match(assign.stdout, /NO_SUCH_THING/);
});

// The turn has a wall clock, and the agent can read how much is left. Without a running clock the
// command says so rather than inventing a number; with one it reports the seat's own budget.
test("civ time reports the seat's per-turn wall clock", async () => {
  const { server, session } = await setup();
  const before = await session.exec("civ time");
  assert.equal(before.exitCode, 0, before.stderr);
  assert.match(before.stdout, /no turn is running/, "no clock means no invented number");

  server.startTurnClock(0);
  const during = await session.exec("civ time");
  assert.equal(during.exitCode, 0, during.stderr);
  // The seat's budget is 60s, so it must name 60 and report a remainder at or just under it.
  assert.match(during.stdout, /of 60s/, "it must state the seat's own limit");
  assert.match(during.stdout, /\d+s left/, "it must state seconds remaining");
  assert.match(during.stdout, /civ end-turn/, "and tell them to end before the clock runs out");
});

for (const advisor of ["MILITARY", "ECONOMIC", "CULTURE", "SCIENCE"]) {
  test(`${advisor} advisor warning can be acknowledged with no visible popup`, async () => {
    const { world, server, session, runDir } = await setup();
    const warning = { id: 601, name: `NOTIFICATION_ADVISOR_WARNING_${advisor}`, typeHash: 87654321, blocking: true, dismissible: false };
    world.notifications.set(0, [warning, { ...warning, id: 602 }]);
    world.notifications.set(1, [{ ...warning, id: 701 }]);
    const hud = await server.beginTurn(0);
    assert.match(hud, /civ dismiss/);
    const opened = await session.exec("civ open 601");
    assert.match(opened.stdout, /civ dismiss 601/);
    assert.match(opened.stdout, /no popup is visible/);
    const screens = await session.exec("civ screen");
    assert.match(screens.stdout, /"screens": \[\]/);

    const dismissed = await session.exec("civ dismiss 601");
    assert.equal(dismissed.exitCode, 0, dismissed.stdout);
    assert.deepEqual(world.notifications.get(0)?.map(n => n.id), [602]);
    assert.deepEqual(world.notifications.get(1)?.map(n => n.id), [701]);
    const blocking = await session.exec("civ dismiss");
    assert.equal(blocking.exitCode, 0, blocking.stdout);
    assert.deepEqual(world.notifications.get(0), []);
    await session.exec("civ skip 10");
    const ended = await session.exec("civ end-turn");
    assert.equal(ended.exitCode, 0, ended.stdout);
    assert.doesNotMatch(readFileSync(join(runDir, "events.jsonl"), "utf8"), /DISMISS_IGNORED/);
  });
}

test("forced end-turn uses the advisor acknowledgment and records it", async () => {
  const { world, server, runDir } = await setup();
  world.notifications.set(0, [{ id: 601, name: "NOTIFICATION_ADVISOR_WARNING_MILITARY", typeHash: 87654321, blocking: true, dismissible: false }]);
  const ended = await server.endTurn(0, true);
  assert.equal(ended.ok, true);
  assert.deepEqual(world.notifications.get(0), []);
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"forced_answer".*"ok":true.*"answered":"advisor warning"/);
});

// One agent sent its slinger at an enemy scout's tile three times in a turn. The path exists,
// the engine accepts the order, nothing moves, and DID_NOT_MOVE names no reason — while the
// scout stood in plain sight on the agent's own map.
test("a move onto another civilization's unit is refused up front, naming the unit", async () => {
  const { session, world } = await setup();
  world.units.push({ id: 21, owner: 1, type: 101, x: 2, y: 1 }); // 2,1 is visible to p0

  const refused = await session.exec("civ move 10 2,1");
  assert.notEqual(refused.exitCode, 0, "the tile is taken");
  assert.match(refused.stdout, /TILE_OCCUPIED/);
  assert.match(refused.stdout, /2,1 holds a scout of p1/, "it says who is standing there");
  assert.match(refused.stdout, /not at war/, "and whether attacking is an option");
  assert.equal(world.unitMoves.size, 0, "nothing reached the engine");

  world.atWar.add("0-1");
  const atWar = await session.exec("civ move 10 2,1");
  assert.match(atWar.stdout, /civ attack 10 2,1/, "at war, the hint is the attack command");
});

test("a unit hidden by fog is not named by the occupancy check", async () => {
  const { session, world } = await setup();
  // 1,2 is only REVEALED to p0, not visible: what stands there is not p0's to know.
  world.units.push({ id: 22, owner: 1, type: 101, x: 1, y: 2 });
  const result = await session.exec("civ move 10 1,2");
  assert.doesNotMatch(result.stdout, /TILE_OCCUPIED|holds a/, "fog stays fog");
});

// Six of one run's thirteen NO_PATH refusals were the same move retried. The message named
// "water, mountains, or a tile it may not enter" — every possibility — when the map knew.
test("a move with no path names what the destination tile is", async () => {
  const { session, world } = await setup();
  world.unreachable.add("2,1");
  world.water.add("2,1");
  const refused = await session.exec("civ move 10 2,1");
  assert.match(refused.stdout, /NO_PATH/);
  assert.match(refused.stdout, /2,1 is water/, "the tile is named for what it is");
  assert.doesNotMatch(refused.stdout, /water for a land unit, mountains, or/, "not the list of guesses");
});

// A saw pit was ordered twice, reported ok twice, and queued nothing either time. The city's
// urban tiles were full, so the engine offered only ExpandUrbanPlots — rural tiles the building
// could turn urban — and the harness read only Plots, sent the order with no plot, and the
// engine accepted it and did nothing.
test("a building goes on an expandable rural tile when every urban slot is full", async () => {
  const { session, world } = await setup();
  world.buildPlots = { Plots: [], ExpandUrbanPlots: [1 * world.width + 2] }; // plot 2,1

  const built = await session.exec("civ build 30 BUILDING_GRANARY");
  assert.equal(built.exitCode, 0, built.stdout);
  const sent = world.cityRequests.at(-1)!;
  assert.equal(sent.X, 2, "the order carries the rural plot");
  assert.equal(sent.Y, 1);
  assert.equal(world.buildQueue.get(30)?.length, 1, "and it queued");
});

test("a building with no legal plot at all is refused before it is sent", async () => {
  const { session, world } = await setup();
  world.buildPlots = { Plots: [], ExpandUrbanPlots: [] };
  const before = world.cityRequests.length;
  const refused = await session.exec("civ build 30 BUILDING_GRANARY");
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stdout, /NO_PLOT/);
  assert.equal(world.cityRequests.length, before, "nothing reached the engine");
});

// 23 of one run's 46 turns ended with "unit X is busy with an operation — it should not be
// blocking; cancel it". The unit was a scout on auto-explore that the engine listed as ready
// (its order had paused), the dump had called it busy, and the agent cancelled and re-issued
// the order every turn. The engine's end-of-turn rule decides both the flag and the hint.
test("a unit on a paused standing order shows needs_orders and end-turn says to skip it", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-ready-"));
  const world = makeWorld();
  world.unitBusy.add(10); // hasPendingOperations, and the engine still allows SKIP_TURN
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 10, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const units = readFileSync(join(runDir, "agents/alpha/turns/t0042/units.txt"), "utf8");
  const line = units.split("\n").find((l) => l.includes("engine_id=10")) ?? "";
  assert.match(line, /needs_orders=yes/, "the flag is on the line at turn start");
  assert.doesNotMatch(line, /busy=yes/, "a unit the engine wants a decision from is not 'busy'");

  const refused = await session.exec("civ end-turn");
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stdout, /civ skip 10/, "the one-command answer");
  assert.doesNotMatch(refused.stdout, /should not be blocking|UNITCOMMAND_CANCEL/);

  const skipped = await session.exec("civ skip 10");
  assert.equal(skipped.exitCode, 0, skipped.stdout);
  const ended = await session.exec("civ end-turn");
  assert.equal(ended.exitCode, 0, ended.stdout);
});

test("a unit that is busy and NOT ready keeps busy=yes and no needs_orders", async () => {
  const { runDir, world } = await setup();
  // Re-dump with the unit both mid-operation and already ordered this turn.
  world.unitBusy.add(10);
  world.unitOrdered.add(10);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 10, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  const units = readFileSync(join(runDir, "agents/alpha/turns/t0042/units.txt"), "utf8");
  const line = units.split("\n").find((l) => l.includes("engine_id=10")) ?? "";
  assert.match(line, /busy=yes/);
  assert.doesNotMatch(line, /needs_orders/);
});

// A listing that counted free slots sent an agent into five refusals and a search of the rules
// files — its turn ran out with the prompt still open. The engine is asked per settlement, so the
// listing says where each resource CAN go, a refusal says why and where else, and a settlement can
// be named as the listing prints it.
test("civ resource lists where each resource can go and explains a refusal", async () => {
  // Built by hand: the fake's settlement list is fixed when the bridge is made, so the town
  // must exist before setup.
  const runDir = mkdtempSync(join(tmpdir(), "civbench-resource-"));
  const world = makeWorld();
  world.resources[0] = [{ index: 5, hash: 999 }];
  world.cities.push({ id: 31, owner: 0, name: "Cleveland", x: 2, y: 2, isTown: true });
  world.resourceRefused.add("5:31"); // a city resource in a town
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 10, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const list = await session.exec("civ resource");
  assert.match(list.stdout, /RESOURCE_999 \(city resource\)  -> Waset city:30/, list.stdout);
  assert.doesNotMatch(list.stdout, /Cleveland city:31/, "the town is not offered for a city resource");
  assert.match(list.stdout, /towns \(no city resources\): Cleveland/);

  const refused = await session.exec("civ resource RESOURCE_999 31");
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stdout, /city resource and Cleveland is a town/, "the reason, not 'slots may be full'");
  assert.match(refused.stdout, /it can go to: Waset \(city:30\)/, "and where it can go");
  assert.equal(world.resourceAssigns.length, 0);

  const byName = await session.exec('civ resource RESOURCE_999 "waset"');
  assert.equal(byName.exitCode, 0, byName.stdout);
  assert.equal(world.resourceAssigns.at(-1)?.city, 30, "a settlement can be named");
});

test("civ resource says to finish when nothing can be placed anywhere", async () => {
  const { session, world } = await setup();
  world.resources[0] = [{ index: 5, hash: 999 }];
  world.resourceRefused.add("5:30");
  const list = await session.exec("civ resource");
  assert.match(list.stdout, /RESOURCE_999 \(city resource\)  -> nowhere right now/);
  assert.match(list.stdout, /civ resource done/);
  const refused = await session.exec("civ resource RESOURCE_999 30");
  assert.match(refused.stdout, /no settlement can take RESOURCE_999 right now/);
});

// Bruno's turns 70 and 71 each ran the 480s clock down on "the game is waiting on
// NOTIFICATION_COMMAND_UNITS" with a placeholder hint, seven and eleven times. The unit the game
// wanted had moved part-way and still had moves: skippable, so the engine counted it, but not
// "never moved", so the harness named it only when another unit was waiting too.
test("a lone unit that moved part-way is still named when units block the turn", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-loneunit-"));
  const world = makeWorld();
  world.unitMoves.set(10, 1); // moved this turn, one move left, no standing order
  world.notifications.set(0, [
    { id: 902, name: "NOTIFICATION_COMMAND_UNITS", typeHash: 9002, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  const refused = await server.endTurn(0);
  assert.equal(refused.ok, false);
  assert.match(String(refused.message), /unit 10\b/, "the unit is named even though it already moved");
  assert.doesNotMatch(String(refused.hint), /<unit>/, "no placeholder");
  assert.match(String(refused.hint), /civ skip 10/);
});

// Ada's turn 79 ran the clock down on an unspent promotion: eleven `civ promote` calls all said
// "ok — promote set to X", the engine applied none, and the point stayed unspent. canStart says
// yes to nearly any pairing; the game's own panel gates on Experience.canEarnPromotion, and the
// tree forbade every pick Ada made. The listing, the pick, and the "ok" now follow that gate.
test("civ promote lists only what the tree allows, refuses the rest, and verifies the point was spent", async () => {
  const { session, world } = await setup();
  world.promotionPoints.set(10, 1);

  const list = await session.exec("civ promote 10");
  assert.match(list.stdout, /PROMOTION_TEST_ONE/, list.stdout);
  assert.doesNotMatch(list.stdout, /PROMOTION_TEST_TWO/, "a promotion behind a prerequisite is not offered");
  assert.match(list.stdout, /1 promotion point/);

  const locked = await session.exec("civ promote 10 PROMOTION_TEST_TWO");
  assert.notEqual(locked.exitCode, 0, "the pick the tree forbids is refused, not 'ok'");
  assert.match(locked.stdout, /not a promotion this unit can take now; it can take: PROMOTION_TEST_ONE/);
  assert.equal(world.promotionPoints.get(10), 1, "nothing was spent");

  const taken = await session.exec("civ promote 10 PROMOTION_TEST_ONE");
  assert.equal(taken.exitCode, 0, taken.stdout);
  assert.equal(world.promotionPoints.get(10), 0, "the point was spent");
  assert.ok(world.promotionsTaken.has("10:PROMOTION_TEST_ONE"));
});

test("civ promote reports NOT_PROMOTED when the engine accepts a pick and applies nothing", async () => {
  const { session, world } = await setup();
  world.promotionPoints.set(10, 1);
  world.promotionsStuck = true;
  const stuck = await session.exec("civ promote 10 PROMOTION_TEST_ONE");
  assert.notEqual(stuck.exitCode, 0);
  assert.match(stuck.stdout, /NOT_PROMOTED/, stuck.stdout);
  assert.match(stuck.stdout, /still unspent/);
});

// Ten fortify orders in one turn went to settlers, merchants and cogs and came back "the game
// refused this action and gave no reason". Only a land combat unit takes a standing order.
test("fortifying a civilian unit is refused with the reason, not silence", async () => {
  const { world } = await setup();
  world.units.push({ id: 11, owner: 0, type: 102, x: 1, y: 1 });
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), mkdtempSync(join(tmpdir(), "civbench-fort-")), [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 10, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  const refused = await server.act(0, { kind: "unit_operation", targetId: "11", actionType: "UNITOPERATION_FORTIFY" });
  assert.equal(refused.ok, false);
  assert.match(String(refused.message), /a settler cannot do that — only land combat units/, String(refused.message));
  assert.match(String(refused.message), /civ skip 11/);
});

// A settler refused where it stood got "no valid constructions for this location" three times
// and then a bare "no reason" on the adjacent-plot variant. The game's own advisor knows where
// it would settle; the refusal now says so.
test("a refused founding names the advisor's recommended plots", async () => {
  const { world } = await setup();
  world.units.push({ id: 12, owner: 0, type: 102, x: 3, y: 3 });
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), mkdtempSync(join(tmpdir(), "civbench-found-")), [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 10, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  const refused = await server.act(0, { kind: "unit_operation", targetId: "12", actionType: "UNITOPERATION_FOUND_CITY" });
  assert.equal(refused.ok, false);
  assert.match(String(refused.message), /cannot found a settlement on its plot — the game's own advisor recommends: 5,3/, String(refused.message));
});

// NOTIFICATION_CHOOSE_BELIEF blocked a whole turn while an agent drove the game's own picker
// through the generic screen reader, whose belief cards carry no names. `civ belief` lists what
// the religion may claim, with what each does, and claims one with ADD_BELIEF the way the
// game's own panel does; `civ religion` founds one with FOUND_RELIGION.
test("civ belief lists claimable beliefs with what they do and claims one", async () => {
  const { session, world } = await setup();
  world.claimableBeliefs.add("BELIEF_TEST_TITHE");
  const list = await session.exec("civ belief");
  assert.equal(list.exitCode, 0, list.stdout);
  assert.match(list.stdout, /BELIEF_TEST_TITHE/, list.stdout);
  assert.match(list.stdout, /gold per follower/, "what it does rides on the line");
  assert.doesNotMatch(list.stdout, /BELIEF_TEST_LOCKED/, "an unclaimable belief is not offered");
  assert.doesNotMatch(list.stdout, /BELIEF_TEST_PANTHEON/, "pantheon beliefs belong to civ pantheon");

  const claim = await session.exec("civ belief BELIEF_TEST_TITHE");
  assert.equal(claim.exitCode, 0, claim.stdout);
  const sent = world.beliefRequests.at(-1);
  assert.equal(sent?.op, "ADD_BELIEF");
  assert.equal(sent?.args?.BeliefType, hashOf("BELIEF_TEST_TITHE"), "the belief goes by hash, as the game's own panel sends it");
});

test("civ religion lists unfounded religions and founds one", async () => {
  const { session, world } = await setup();
  const list = await session.exec("civ religion");
  assert.match(list.stdout, /RELIGION_TEST_ONE/, list.stdout);
  const found = await session.exec("civ religion RELIGION_TEST_TWO");
  assert.equal(found.exitCode, 0, found.stdout);
  assert.equal(world.beliefRequests.at(-1)?.op, "FOUND_RELIGION");
  const again = await session.exec("civ religion");
  assert.doesNotMatch(again.stdout, /RELIGION_TEST_TWO/, "a founded religion is no longer offered");
});

// "the game is waiting on NOTIFICATION_NEW_POPULATION" named no settlement and `civ expand` alone
// printed usage; an agent expanded the wrong town and the block stayed for a 480s turn. With no
// city given, expand now names every settlement with a citizen to place and where it can go.
test("civ expand with no city names the settlements that must place a citizen", async () => {
  const { session } = await setup();
  const listing = await session.exec("civ expand");
  assert.equal(listing.exitCode, 0, listing.stdout);
  assert.match(listing.stdout, /Waset \(city:30\) has a citizen to place: civ expand 30 \d+,\d+/, listing.stdout);
});

// A decision cannot be dismissed. Dismissing one used to report "ok", the game ignored it, and
// the agent learned that from a later correction. And ids are renumbered within a turn while the
// type name is stable, so a notification can be named by type.
test("civ dismiss refuses a decision up front and names the answering command", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-dismiss-"));
  const world = makeWorld();
  world.notifications.set(0, [
    { id: 701, name: "NOTIFICATION_NEW_POPULATION", typeHash: 442844772, blocking: true, dismissible: false },
    { id: 702, name: "NOTIFICATION_LEGACY_COMPLETED", typeHash: 99887766, blocking: false, dismissible: true },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 10, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const refused = await session.exec("civ dismiss NOTIFICATION_NEW_POPULATION");
  assert.notEqual(refused.exitCode, 0, refused.stdout);
  assert.match(refused.stdout, /NOT_DISMISSIBLE/);
  assert.match(refused.stdout, /civ expand/, "the command that answers it");
  assert.equal((world.notifications.get(0) ?? []).length, 2, "nothing was dismissed");

  const byName = await session.exec("civ dismiss NOTIFICATION_LEGACY_COMPLETED");
  assert.equal(byName.exitCode, 0, byName.stdout);
  assert.equal((world.notifications.get(0) ?? []).length, 1, "the alert went, by type name");
});

// Fifty-five NO_PATH refusals in one night read "X,Y is flat; the way there is impassable" for
// an adjacent tile that looked walkable. Cliffs block an edge, not a tile; say so.
test("a move blocked by a cliff names the cliff", async () => {
  const { session, world } = await setup();
  world.unreachable.add("2,1");
  world.cliffs.add("2,1");
  const refused = await session.exec("civ move 10 2,1");
  assert.match(refused.stdout, /NO_PATH/);
  assert.match(refused.stdout, /behind a cliff — there is no crossing from 1,1/, refused.stdout);
});

// The engine refuses SKIP_TURN for a unit built this turn while NOTIFICATION_COMMAND_UNITS still
// waits on it. The refusal named nobody, `civ skip` on the right unit said "needs no skip", and
// only a move ever cleared it: 68 nameless refusals across nine turns, three of them lost whole.
test("a unit the engine will not skip is still named, and skip says to move it", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-unskippable-"));
  const world = makeWorld();
  world.unitOrdered.add(10); // SKIP refused with no reason; awake, unmoved, moves left
  world.notifications.set(0, [
    { id: 700, name: "NOTIFICATION_COMMAND_UNITS", typeHash: 7001, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 8, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);

  const line = await session.exec("grep 'engine_id=10 ' /current/units.txt");
  assert.match(line.stdout, /needs_orders=yes/, "the units dump flags the unit the engine waits on");

  const refused = await session.exec("civ end-turn");
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stdout, /unit 10 .*still needs orders/, "the refusal names the unit");
  assert.match(refused.stdout, /civ move 10 <x,y>/, "and says a move is what clears it");

  const skip = await session.exec("civ skip 10");
  assert.notEqual(skip.exitCode, 0, "a skip the engine refuses is not reported as done");
  assert.match(skip.stdout, /SKIP_REFUSED/);
  assert.match(skip.stdout, /civ move 10/);

  const moved = await session.exec("civ move 10 2,1");
  assert.equal(moved.exitCode, 0, moved.stderr);
});

test("a forced end-turn steps a unit the engine will not skip", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-unskippable-forced-"));
  const world = makeWorld();
  world.unitOrdered.add(10);
  world.notifications.set(0, [
    { id: 700, name: "NOTIFICATION_COMMAND_UNITS", typeHash: 7001, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  await server.endTurn(0, true);
  const unit = world.units.find((u) => u.id === 10);
  assert.ok(unit && !(unit.x === 1 && unit.y === 1), "the stuck unit was given a real order");
});

// NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL is cleared by the attribute screen's "considered" signal
// when it closes, buying or not. The harness could buy a node and never send that signal, so an
// agent that wanted to bank its points had no way out: 30 blocks, 24 never resolved.
test("civ attribute done clears the attribute prompt, and a forced end-turn sends it too", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-attribute-"));
  const world = makeWorld();
  world.notifications.set(0, [
    { id: 710, name: "NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL", typeHash: 7101, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  assert.match(hud, /civ attribute done/, "the turn-start requirement names the closing command");
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);
  await session.exec("civ skip 10");
  assert.notEqual((await session.exec("civ end-turn")).exitCode, 0, "blocked until considered");
  const done = await session.exec("civ attribute done");
  assert.equal(done.exitCode, 0, done.stderr);
  const ended = await session.exec("civ end-turn");
  assert.equal(ended.exitCode, 0, ended.stderr);

  // And the forced path answers it the same way when the agent never did.
  const runDir2 = mkdtempSync(join(tmpdir(), "civbench-attribute-forced-"));
  const world2 = makeWorld();
  world2.notifications.set(0, [
    { id: 710, name: "NOTIFICATION_CAN_BUY_ATTRIBUTE_SKILL", typeHash: 7101, blocking: true, dismissible: false },
  ]);
  const server2 = new MatchServer(new GameAdapter(new FakeBridge(world2)), runDir2, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server2.beginTurn(0);
  const forced = await server2.endTurn(0, true);
  assert.equal(forced.ok, true, "the forced end-turn clears the attribute prompt");
  assert.equal((world2.notifications.get(0) ?? []).length, 0);
});

// A conquered settlement must be kept, razed or freed before the turn ends. The game's chooser
// is a HUD panel `civ screen` cannot see, and nothing here could send the command — in a
// domination match this fires on every conquest.
test("civ capture decides a conquered settlement's fate, and the refusal names it", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-capture-"));
  const world = makeWorld();
  world.cities.push({ id: 60, owner: 0, name: "Thebes", x: 3, y: 3, justConquered: true });
  world.notifications.set(0, [
    { id: 720, name: "NOTIFICATION_CONSIDER_RAZE_CITY", typeHash: 7201, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 6, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);
  await session.exec("civ skip 10");
  const refused = await session.exec("civ end-turn");
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stdout, /Thebes was just conquered/, "the settlement is named");
  assert.match(refused.stdout, /civ capture 60 keep/, "and the command that answers it");

  const listing = await session.exec("civ capture 60");
  assert.equal(listing.exitCode, 0, listing.stderr);
  assert.match(listing.stdout, /keep/);
  assert.match(listing.stdout, /raze/);
  assert.match(listing.stdout, /liberate.*(no|not|—)/, "liberate is listed as unavailable, with its reason");

  const kept = await session.exec("civ capture 60 keep");
  assert.equal(kept.exitCode, 0, kept.stderr);
  assert.deepEqual(world.captures, [{ city: 60, directive: 0 }]);
  const ended = await session.exec("civ end-turn");
  assert.equal(ended.exitCode, 0, ended.stderr);
});

// Every settlement- or unit-scoped blocker used to come back NEEDS_A_TARGET on the forced path,
// so the seat stalled on a citizen to place or a town focus until the harness gave up with "?".
test("a forced end-turn answers a town focus and a citizen placement for the seat", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-forced-target-"));
  const world = makeWorld();
  world.cities.push({ id: 50, owner: 0, name: "Ajaccio", x: 2, y: 2, isTown: true });
  world.notifications.set(0, [
    { id: 503, name: "NOTIFICATION_CHOOSE_TOWN_PROJECT", typeHash: 77001, blocking: true, dismissible: false, target: { id: 50, owner: 0 } },
    { id: 501, name: "NOTIFICATION_NEW_POPULATION", typeHash: 442844772, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  const forced = await server.endTurn(0, true);
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"forced_answer".*"blocking":"NOTIFICATION_CHOOSE_TOWN_PROJECT".*"ok":true.*"answered":"build for 50".*"picked":"PROJECT_TOWN_TEST"/);
  assert.match(events, /"kind":"forced_answer".*"blocking":"NOTIFICATION_NEW_POPULATION".*"ok":true.*"answered":"expand for 30".*"picked":"\d+,\d+"/);
  assert.equal(forced.ok, true, "both blockers answered, the turn ends");
});

// The Age boundary's second step. The new Age's dedications are a deck of cards the game's
// screen fills by drag-and-drop; nothing here could add a card or mark the deck complete, so
// `civ age` printed nothing while end-turn demanded `civ age finish`, and agents drove the
// screen by hand with truncated control labels.
test("civ age lists the new Age's dedications, picks one, and done closes the deck", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-dedication-"));
  const world = makeWorld();
  world.ageCards = [
    { id: "CARD_PLUS_CULTURE", name: "Patrons", description: "more culture", effects: [{ id: "EFFECT_CULTURE", amount: 1 }] },
    { id: "CARD_PLUS_GOLD", name: "Merchants", description: "more gold", effects: [{ id: "EFFECT_GOLD", amount: 2 }] },
  ];
  world.notifications.set(0, [
    { id: 730, name: "NOTIFICATION_ADVANCED_START", typeHash: 7301, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 8, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  assert.match(hud, /civ age <CARD>/, "the requirement names the dedication step, not `civ age finish`");
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);
  await session.exec("civ skip 10");

  const finish = await session.exec("civ age finish");
  assert.notEqual(finish.exitCode, 0, "the transition is already submitted");
  assert.match(finish.stdout, /dedications are what is waiting/, "and the refusal points at the deck");

  const listing = await session.exec("civ age");
  assert.equal(listing.exitCode, 0, listing.stderr);
  assert.match(listing.stdout, /civ age CARD_PLUS_CULTURE/);
  assert.match(listing.stdout, /Patrons/, "with the card's name, not only its id");
  assert.doesNotMatch(listing.stdout, /civ age finish/, "finish is not offered when the engine will refuse it");

  const picked = await session.exec("civ age CARD_PLUS_GOLD");
  assert.equal(picked.exitCode, 0, picked.stderr);
  assert.deepEqual(world.deck, ["CARD_PLUS_GOLD"]);
  const dropped = await session.exec("civ age -CARD_PLUS_GOLD");
  assert.equal(dropped.exitCode, 0, dropped.stderr);
  assert.deepEqual(world.deck, []);
  await session.exec("civ age CARD_PLUS_CULTURE");

  const done = await session.exec("civ age done");
  assert.equal(done.exitCode, 0, done.stderr);
  assert.deepEqual(world.effectsUsed, ["EFFECT_CULTURE"], "every effect of the deck is used on done");
  assert.equal(world.deckComplete, true);
  const ended = await session.exec("civ end-turn");
  assert.equal(ended.exitCode, 0, ended.stderr);
});

test("a forced end-turn fills and closes the dedication deck for the seat", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-dedication-forced-"));
  const world = makeWorld();
  world.ageCards = [{ id: "CARD_ONLY", name: "Only", description: "the one card", effects: [] }];
  world.notifications.set(0, [
    { id: 730, name: "NOTIFICATION_ADVANCED_START", typeHash: 7301, blocking: true, dismissible: false },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  const forced = await server.endTurn(0, true);
  assert.equal(forced.ok, true);
  assert.deepEqual(world.deck, ["CARD_ONLY"]);
  assert.equal(world.deckComplete, true);
});

// A galley's attack is a melee move onto the enemy, yet the engine answers the ranged query for
// it too — so `civ attack` refused every naval attack as OUT_OF_RANGE while combat-preview said
// "melee, possible". Eight turns of naval war went to that.
test("a unit that can melee attacks by moving when the plot is not a ranged target", async () => {
  const { session, world } = await setup();
  world.unitCombat.set(10, { melee: 25, rangedPlots: [] });
  const attack = await session.exec("civ attack 10 2,1");
  assert.equal(attack.exitCode, 0, attack.stdout + attack.stderr);
  assert.doesNotMatch(attack.stdout, /OUT_OF_RANGE/);
  const unit = world.units.find((u) => u.id === 10);
  assert.deepEqual([unit?.x, unit?.y], [2, 1], "the attack went out as a move onto the plot");
});

// The harness cancels carried-over standing orders when it attaches (they can crash the game),
// logged 76 times as a correction the agent never saw: delta.md said nothing, so units sat idle
// with no explanation.
test("an order the harness cancelled at attach is explained in delta.md", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-cancelled-"));
  const world = makeWorld();
  world.unitBusy.add(10);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 5, secondsPerTurn: 60 },
  ]);
  await server.beginTurn(0);
  const delta = readFileSync(join(runDir, "agents/alpha/turns/t0042/delta.md"), "utf8");
  assert.match(delta, /standing orders on unit 10 were cancelled/);
});

// A civ that has just found you waits on a greeting, and an AI's proposal waits on an answer.
// Both operations take argument shapes the generic diplomacy path never built, so neither was
// reachable: NOTIFICATION_PLAYER_MET blocked three turns with nothing to answer it.
test("civ diplomacy greets a civ that just met you and answers a proposal", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "civbench-greet-"));
  const world = makeWorld();
  world.met[0] = [1];
  world.greetingOwed.add(1);
  world.proposals.set(9001, { actionType: 3, initialPlayer: 1 });
  world.notifications.set(0, [
    { id: 740, name: "NOTIFICATION_PLAYER_MET", typeHash: 7401, blocking: true, dismissible: false },
    { id: 741, name: "NOTIFICATION_DIPLOMATIC_RESPONSE_REQUIRED", typeHash: 7411, blocking: true, dismissible: false, target: { id: 9001, owner: 1 } },
  ]);
  const server = new MatchServer(new GameAdapter(new FakeBridge(world)), runDir, [
    { slot: 0, playerId: 0, name: "alpha", actionsPerTurn: 8, secondsPerTurn: 60 },
  ]);
  const hud = await server.beginTurn(0);
  assert.match(hud, /civ diplomacy <player> greet/, "the requirement names the greeting command");
  const notesDir = join(runDir, "notes", "alpha");
  mkdirSync(notesDir, { recursive: true });
  const session = createAgentSandbox(server, 0, notesDir, () => hud);
  await session.exec("civ skip 10");

  const who = await session.exec("civ diplomacy");
  assert.equal(who.exitCode, 0, who.stderr);
  assert.match(who.stdout, /p1 .*owes a greeting: civ diplomacy p1 greet/);
  assert.match(who.stdout, /proposal 9001 from p1: DIPLOMACY_ACTION_OPEN_BORDERS +-> civ diplomacy respond 9001 accept/);

  const greeted = await session.exec("civ diplomacy p1 greet friendly");
  assert.equal(greeted.exitCode, 0, greeted.stderr);
  assert.deepEqual(world.greetings, ["1:0"]);
  const answered = await session.exec("civ diplomacy respond 9001 reject");
  assert.equal(answered.exitCode, 0, answered.stderr);
  assert.deepEqual(world.responses, ["9001:1"]);
  const ended = await session.exec("civ end-turn");
  assert.equal(ended.exitCode, 0, ended.stderr);
});

// Agents read "still needs orders" as something wrong with the unit and searched for a fix.
// Skipping is a normal order; the refusal and the resource listing both say so in plain words.
test("the end-turn refusal says skipping is a normal choice, and civ resource explains slots", async () => {
  const { session } = await setup();
  const refused = await session.exec("civ end-turn");
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stdout, /has not been given one this turn/);
  assert.match(refused.stdout, /civ skip 10.*normal, valid choice/);
  const resources = await session.exec("civ resource");
  assert.equal(resources.exitCode, 0, resources.stderr);
  assert.match(resources.stdout, /how slots work|every resource you have is already placed/);
});
