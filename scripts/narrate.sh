#!/bin/sh
# Wait for the match to create its run directory, then run the narrator: a browser transcript site
# that shows who is talking and plays the audio in the page. Used by scripts/play.sh; $1 is a marker
# file the new run must be newer than, $2 is an optional "--monologue".
cd "$(dirname "$0")/.." || exit 1
marker="$1"
mono="$2"          # "--monologue" to also have each agent speak its turn in its own voice
port=7667
echo "narrator: waiting for the match to create its run directory..."
while :; do
  d=$(ls -t runs 2>/dev/null | head -1)
  if [ -n "$d" ] && [ "runs/$d" -nt "$marker" ]; then break; fi
  sleep 5
done
echo "narrator: transcript + audio at http://localhost:$port"
( sleep 3; open "http://localhost:$port" 2>/dev/null || true ) &   # open the transcript page
exec node tools/commentate.ts "runs/$d" --follow --site --port "$port" $mono
