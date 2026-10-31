#!/usr/bin/env bash
# Runs the local Relay server inside WSL. Code and data stay on the Linux filesystem.
# Run setup-runtime.sh once first. Loading the server from /mnt/c took over six minutes here.
# --detach returns once the server is healthy and leaves it running after this shell exits.
set -euo pipefail
export PATH="$HOME/.local/node-24/bin:$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

PORT="${RELAY_PORT:-8787}"
RUNTIME_DIR="${RELAY_RUNTIME_DIR:-$HOME/.actorrelay/relay-runtime}"
DATA_DIR="${RELAY_DATA_DIR:-$HOME/.actorrelay/relay-$PORT}"

mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

if [ "${1:-}" = "--detach" ]; then
  setsid nohup "${BASH_SOURCE[0]}" >> "$DATA_DIR/server.log" 2>&1 < /dev/null &
  for _ in $(seq 1 240); do
    if curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/health"; then
      echo "relay up on 127.0.0.1:$PORT, log $DATA_DIR/server.log"
      exit 0
    fi
    sleep 0.5
  done
  echo "relay did not become healthy, see $DATA_DIR/server.log" >&2
  exit 1
fi

exec node "$RUNTIME_DIR/node_modules/@relaycast/engine/dist/bin/serve.js" \
  --db "$DATA_DIR/relaycast.db" --port "$PORT" --env development
