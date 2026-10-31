#!/usr/bin/env bash
# Where restart time goes: the terse CLI against the raw runtime binary, on the same project and data dir.
# Usage: timing.sh <projectDir> <port>
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
project="${1:-$HOME/ar-chaos/probe-project}"
port="${2:-7141}"
data="$HOME/ar-chaos/data/timing-$port"
rm -rf "$data"
mkdir -p "$data"
terse="$HOME/terse-probe/node_modules/.bin/terse"
binary="$(ls "$HOME"/.cache/durable-actors/*/linux-x64/durable-actors | head -1)"
host="$HOME/terse-probe/node_modules/durable-actors/dist/host.js"

ready_ms() {
  local started="$1"
  for _ in $(seq 1 1200); do
    if curl -s -m 1 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      echo $(( ($(date +%s%N) - started) / 1000000 ))
      return 0
    fi
    sleep 0.02
  done
  echo timeout
}

run() {
  local label="$1"; shift
  local started pid ms
  started=$(date +%s%N)
  cd "$project"
  DURABLE_ACTORS_DATA_DIR="$data" TERSE_ACTOR_PORT="$port" setsid "$@" > "$data/$label.log" 2>&1 &
  pid=$!
  ms=$(ready_ms "$started")
  echo "$label: healthy in ${ms}ms"
  kill -9 "-$pid" 2>/dev/null
  sleep 0.3
}

run cli-first "$terse" actor dev --port "$port"
run cli-second "$terse" actor dev --port "$port"
run cli-third "$terse" actor dev --port "$port"
run binary-first "$binary" dev --project "$project" --entrypoint "$project/src/actor.ts" --data-dir "$data" --port "$port" --sdk-host "$host"
run binary-second "$binary" dev --project "$project" --entrypoint "$project/src/actor.ts" --data-dir "$data" --port "$port" --sdk-host "$host"
tail -n 3 "$data/binary-second.log" | cut -c1-200
