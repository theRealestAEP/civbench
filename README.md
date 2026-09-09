# CivBench

An agent-agnostic benchmark where LLM agents play **Sid Meier's Civilization VII** against each
other, with per-agent memory, full replays, and a spectator stream.


## Try it without the game

The harness proves itself against a fake Civilization, so neither an install nor an API key is
needed to run the tests or the demo:

```sh
npm install
npm test                                   # 82 tests, including the fog-of-war leak guard
npm run match configs/duel-scripted.yaml   # a full config-driven match, report, and replay
```

That writes `runs/<runId>/` with `events.jsonl`, per-agent turn dumps, `report.txt`, and a
self-contained `replay.html`. The run id is the hash of the config, so the same config is the
same run.

## Against the real game

```sh
npm start                                    # 3 Sonnet agents, 10 turns, live
npm start -- --agents 2 --turns 20
npm start -- --models claude-sonnet-5,claude-opus-5,claude-haiku-4-5
npm start -- --config configs/live-3.yaml
npm start -- --fake                          # harness only, no Civilization needed
```

One command does the whole sequence with no idle gaps: launch, host, start the hotseat lobby,
verify the seats, run the spectator, play, then write the report and replay. It estimates cost
first and refuses to start if the game hands back fewer seats than you asked for.

**Keep the Civilization VII window in front.** macOS freezes occluded windows, which stops both
the render and the debug bridge.

`npm run live` does the whole thing in one unbroken sequence: enable the debug bridge, launch
the game, host a match with no UI, wait for the map, then play it. That matters — the Coherent
debug server is serviced on the game thread, so a game left idle behind another window stops
answering. Doing it in one pass avoids the problem.

Other entry points:

```sh
npm run enable-debug   # write UIDebugger/EnableTuner into AppOptions.txt
npm run launch         # patch options and launch, then wait for the bridge
npm run probe          # with a match running: read live state and report what works
npm run match cfg.yaml # play a config; uses the live game if it answers, else the fake
```

## How it works

```
agent (any model)  ->  tinysandbox  ->  civ command  ->  Match Server  ->  bridge  ->  Civ 7
       shell tools        /run /notes                      event log      CDP/tuner
```

An agent gets a shell, a read-only directory holding everything it is entitled to see, a
writable `notes.md`, and one command (`civ`) to act with. It reads the position itself with
`grep`, `jq`, and friends. Nothing is summarised for it, because deciding what matters is the
thing being measured.

## Popup access and interface checks

Agents use `civ screen` to read open popup and chooser text, then
`civ screen <screen-id> <control-id>` to activate a listed control. The same observations appear
in `pending.txt` and `pending.jsonl`. Hotseat cleanup leaves gameplay choices to the agent.

`npm run audit -- runs/<run-id>` reports missing screen content, unsupported inputs, and action
failures. Recorded interface gaps make the run ineligible for benchmark comparisons.
These checks cover recorded screens; unvisited interfaces still need live validation.

## Layout

| Path | What |
|---|---|
| `src/adapter/gamejs/` | JavaScript that runs **inside** Civ 7 to read state and issue orders |
| `src/adapter/` | The bridge (CDP), and the typed adapter over it |
| `src/dump/` | Fog filtering, carry-forward memory, the text + JSONL writers, the HUD |
| `src/server/` | Match Server, turn loop, watchdogs, event log, run report |
| `src/agent/` | Sandbox, read-only VFS, brains (scripted baseline and model-backed) |
| `src/cli/civ.ts` | The one command an agent may use to act |
| `src/replay/` | Self-contained HTML replay: hex map, scrubber, per-agent fog |
| `src/score/` | Metrics, Age checkpoints, admissibility, Elo |
| `src/config/` | Match config, and the rule that refuses an uncovered game mode |
| `src/test-support/` | A fake Civ 7, so the real extraction scripts are testable offline |
| `reference/game-src/` | Extracted game sources (gitignored; run `extract-sources`) |

## Operating notes

Three things about Civ 7 that are easy to lose a day to, all confirmed against a running game:

- **`UIDebugger` does not persist.** The game reads it at startup and re-comments it. Re-apply it
  before every launch.
- **Never call `Configuration.editGame().reset()`.** It strips the enabled content modules while
  TypeTags still reference them, the gameplay database fails validation, and the load silently
  drops back to the menu.
- **`Automation.setActive(true)` before hosting**, or the game waits on a *Begin Game* button that
  no one is going to press.

## Status

Phase 0 is answered against build 1.4.2 and the system runs live. Confirmed on a running game:
the CDP bridge, programmatic match setup with no UI, per-player fog across six players, the
engine's own action masking, orders accepted, turns advancing, and the scripted baseline
founding a city, research and civics set, production queued, and turns ending cleanly.

Not yet exercised in a live game: messaging, trade, and combat. All three require agents to meet
one another, and no match has yet run long enough for that to happen.

## Three invariants

**Fog of war is structural.** The extraction scripts refuse to read a plot's mutable state while
it is fogged; `src/dump/merge.ts` fills it from the player's own earlier snapshot and stamps
`last_seen`. Another agent's directory is not mounted, so it is unaddressable rather than merely
unreadable. `test/leak.test.ts` guards this.

**Parity cuts both ways.** Showing an agent less than the game's UI shows a human is as bad as
showing it more: it silently measures our adapter coverage instead of the model. That is why the
agent gets the whole ruleset database and the engine's own failure reasons.

**Clean is not the same as admissible.** A match with no timeouts still fails admissibility if it
was too short or had turns ended for it. Hygiene is printed beside every result, and an
inadmissible match cannot move the leaderboard.
