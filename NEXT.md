# Resume here

The turn loop works. A 6-turn match finished on 2026-08-25 with zero stalls, zero bridge errors and
zero timeouts — the first run ever to reach turn 6. `verify-live.ts` reported all claims holding
mid-match. Refusals fell from 36% across every earlier run to 8%.

## 2026-08-26: the review sweep

A full review of runs -023..-026 plus the codebase found ~40 places where the harness told agents
something false or withheld the fact that explained a refusal. All are fixed; 165 tests pass. The
big ones, so a regression is recognisable:

* The skip spiral: refusals now name a busy unit's queued operation and offer UNITCOMMAND_CANCEL;
  end-turn hints only recommend `civ skip` when canStart accepts it; engine-internal ops
  (EXECUTE_SCRIPT etc.) are refused everywhere with a plain message. Bruno's 17-turn ritual came
  from these three surfaces disagreeing.
* `civ what-can` now actually prints the engine's FailureReasons (`reasons` was dropped on the
  floor since the field was born — the renderer read `why`).
* end-turn ok is verified against the game (endcheck.js); dismissals are verified; move/build
  verdicts poll until the engine applies (the old immediate reads fabricated DID_NOT_MOVE /
  NOT_QUEUED for working orders).
* Chat: the per-turn quota resets (it never did — 5 messages per MATCH), @pN addressing works,
  met-gating is real, deals can be read and accepted (`civ deal incoming/accept/reject`).
* Sandbox: relative paths resolve, missing files error loudly, sed does s///, path traversal out
  of the mounts is closed, a timed-out brain's session goes dead instead of acting into the next
  seat's turn.
* Scoring: `illegal` and `actions` now share a denominator (events.jsonl); forced ends count once
  per turn and only when they took; harness-answered blockers are logged as `forced_answer`.

`verify-live.ts` grew a block probing the engine APIs these fixes lean on (operationQueueSize,
getWorkingDealItems on INCOMING, getTypeName on a bare type hash, hasSentTurnComplete). Run it
early in the next live match: those could not be confirmed against the fake, and a null there is
the bug.

## The one thing left that reading cannot answer

Agents have never met each other, so **messaging, trade and combat have never executed**. Contact
takes 15-25 turns. A 50-turn run is also the minimum for an admissible result.

    npm start -- --agents 3 --turns 50 --all-ages \
      --models openai/gpt-5.6-luna,openai/gpt-5.6-luna,openai/gpt-5.6-luna

Roughly $0.85 and an hour. Then, against the running game:

    node tools/dev/verify-live.ts

It now also checks the state added by reading the game's source and never confirmed against the
real API: unit combat fields, tile yields, and rival standing. A wrong accessor there returns null
rather than throwing, so silence in that output is the bug.

## What to watch in that run

* **Do they meet?** `met` in verify-live, and `players.txt` growing. Everything else waits on this.
* **Does `civ do` fall away?** It was the most-used command at 307 uses, back when it was the only
  road. Now that build/tech/civic/government/expand/story exist it should mostly vanish. If it does
  not, the purpose-built commands are not landing.
* **New end-turn blockers.** The known ones are answered. Celebrations, Age transitions, crises and
  attribute points are predicted and unhandled. The shape is always the same: a blocking
  notification is a DECISION, not a notice; find it with `endTurnBlocker()` in `_prelude.js` and add
  a row to `DECISIONS` in `choose.js`.

## Still not done

* The commentator runs but has never seen a live match. TTS is out of scope; the text is the artifact.
* Moderation for commentary before anything renders (PLAN §12.2 calls it the largest reputational
  risk). Morph Reflexes looks like the right tool: ~90ms, $0.005/request.
* ~244 anti-slop findings, concentrated in type assertions over model events and adapter results.

## The rules that cost the most to learn

**An `ok` is not evidence.** Check the game state changed, not that the call was accepted. Research
returned Success and did nothing for the project's entire history.

**Never read state immediately after asking the engine to change it.** Requests apply
asynchronously. This caused four separate bugs: a settler that still looked alive after founding, a
dismissal that reported failure on success, research reporting nothing when set, and an agent
reading `moves=` after its own move and concluding unit ids had changed.

**When an agent looks incompetent, check what the harness told it** — including the parts the
harness invented to be helpful. A hint that guesses its own cause is worse than no hint.

**Before blaming a component, count how many copies of it are running.**
