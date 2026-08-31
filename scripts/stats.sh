#!/bin/sh
# Wait for the match to create its run directory, then serve the live stats panel and open it.
# Used by scripts/play.sh; the argument is a marker file the new run must be newer than.
cd "$(dirname "$0")/.." || exit 1
marker="$1"
port="${2:-7666}"
echo "stats: waiting for the match to create its run directory..."
while :; do
  d=$(ls -t runs 2>/dev/null | head -1)
  if [ -n "$d" ] && [ "runs/$d" -nt "$marker" ]; then break; fi
  sleep 5
done
echo "stats: serving runs/$d at http://localhost:$port"
( sleep 2; open "http://localhost:$port" 2>/dev/null || true ) &   # open the panel once it is up
exec node tools/stats-page.ts "runs/$d" --serve --port "$port"
