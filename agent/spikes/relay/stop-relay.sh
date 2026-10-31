#!/usr/bin/env bash
# SIGTERM closes the database, then hangs on any open WebSocket, so it is followed by SIGKILL.
set -uo pipefail

PORT="${RELAY_PORT:-8787}"
PATTERN="serve.js --db .* --port $PORT "

pid="$(pgrep -f "$PATTERN" | head -1)"
if [ -z "$pid" ]; then
  echo "no relay server on port $PORT"
  exit 0
fi

kill -TERM "$pid"
for _ in 1 2 3 4 5 6; do
  kill -0 "$pid" 2>/dev/null || { echo "relay $pid stopped"; exit 0; }
  sleep 0.5
done
kill -KILL "$pid"
echo "relay $pid killed after SIGTERM did not exit"
