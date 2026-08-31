#!/bin/sh
# Kick off a full narrated match in tmux: the game in one pane, the narrator in the other.
#
#   npm run play                          default config, WAIT at the READY prompt (press Enter)
#   npm run play -- configs/your.yaml     any config, still waits at READY
#   npm run play -- --go                  skip the wait, drop straight into play
#   npm run play -- configs/your.yaml --go
#   npm run play -- --monologue          each agent also speaks its turn in its own voice
#
# One session named `civbench`, two panes side by side. The left pane runs the match; the right
# pane waits for it to create its run directory, then follows it aloud. The script attaches you to
# the session at the end. Detach with Ctrl-b then d; the match keeps running.
#
# By default the match holds at "▶ READY — press Enter" so you can arrange the window and start
# when you are set. Pass --go to skip that.
set -e
cd "$(dirname "$0")/.." || exit 1

# Config is the one non-flag argument; every flag (e.g. --go, --turns=50) passes through to the
# match. Order does not matter: `--go configs/x.yaml` and `configs/x.yaml --go` both work.
CONFIG=""
EXTRA=""
MONO=""
for arg in "$@"; do
  case "$arg" in
    --monologue) MONO="--monologue" ;;   # a narrator flag, not a match flag
    -*) EXTRA="$EXTRA $arg" ;;
    *)  CONFIG="$arg" ;;
  esac
done
CONFIG="${CONFIG:-configs/domination-3.yaml}"

if [ ! -f "$CONFIG" ]; then
  echo "no such config: $CONFIG" >&2
  exit 1
fi

SESSION=civbench
# A marker the narrator uses to tell OUR run from any older one: it waits for a run directory
# newer than this file. Kept in the repo's tmp so it survives, unlike the session scratchpad.
mkdir -p .tmp
MARKER=.tmp/play-marker
touch "$MARKER"

# Start clean: one match at a time.
tmux kill-session -t "$SESSION" 2>/dev/null || true

# EXTRA carries --go through to the match when the user asked for it; without it, start.ts holds
# at the READY prompt in this pane, which is a TTY, so Enter starts the match.
tmux new-session -d -s "$SESSION" -x 220 -y 50
tmux send-keys -t "$SESSION" "npm start -- --config $CONFIG$EXTRA" C-m

tmux split-window -h -t "$SESSION"
tmux send-keys -t "$SESSION" "sh scripts/narrate.sh $MARKER $MONO" C-m

# A third pane keeps the live stats page current and opens it in the browser.
tmux split-window -v -t "$SESSION"
tmux send-keys -t "$SESSION" "sh scripts/stats.sh $MARKER" C-m

tmux select-pane -t "$SESSION".0
case "$EXTRA" in
  *--go*) echo "match + narrator launching in tmux '$SESSION' — starting immediately, attaching now" ;;
  *)      echo "match + narrator launching in tmux '$SESSION' — press Enter in the LEFT pane at ▶ READY to start" ;;
esac
echo "(Ctrl-b then d to detach; the match keeps running)"
exec tmux attach -t "$SESSION"
