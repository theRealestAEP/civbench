# Resume here

The goal is open: agents have never reached contact, so messaging, trade and combat
are still unverified. No match has passed turn 6.

Everything below is done and tested offline (84 tests). The game was NOT run again
after the user paused work.

## The one thing to do next

    npm start -- --agents 3 --turns 20 --all-ages \\
      --models openai/gpt-5.6-luna,openai/gpt-5.6-luna,openai/gpt-5.6-luna

Watch for it to clear its own end-of-turn blockers past turn 6 unaided. That is what
has ended every previous run. Then check the game itself, never the return codes:

    node tools/dev/verify-live.ts

## Verified live before the pause

founding, movement, production, research, civics, notifications, end-turn, saves, resume.

## Never run against the real game

civ government, civ expand, civ story  -- written and covered by fake-game tests only.
messaging, trade, combat            -- need two agents to meet; 0 contacts so far.

## If it stalls, the shape is always the same

A blocking notification is a DECISION, not a notice. Dismissal clears a notice; a
decision needs its own operation. Find the blocker with endTurnBlocker(playerId) in
src/adapter/gamejs/_prelude.js, then add a row to DECISIONS in choose.js.

Known so far: NEW_POPULATION -> civ expand.  CHOOSE_DISCOVERY_STORY_DIRECTION -> civ story.
Likely next: celebrations, age transitions, crises, attribute points.

## The rule that cost the most

An 'ok' is not evidence. Check the game state changed, not that the call was accepted.
Never gate a retry on an immediate re-read of state you just asked to change -- these
operations apply asynchronously, and that trap has bitten three times.
