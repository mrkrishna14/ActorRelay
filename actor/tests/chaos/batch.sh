#!/usr/bin/env bash
# Runs groups of scenarios in parallel, each group on its own port pair and data dirs.
# Usage: batch.sh <runId> <snapshotActorDir> "<ids>" "<ids>" ...
# Env: CHAOS_PORT_BASE offsets the ports (default 0). CHAOS_LOAD_LIMIT stops the batch at this load (default 16),
# because other work shares this machine and it takes priority. Only ports 7140-7149 are ever touched.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$(readlink -f "$0")")"
run="$1"; project="$2"; shift 2
limit="${CHAOS_LOAD_LIMIT:-16}"
out="$HOME/ar-chaos/batch/$run"
target="real Terse dev server, real actors, fake glue and simulator"
if grep -q 'VETO_WINDOW_MS = 100_000' "$project/src/config.ts"; then
  export CHAOS_VOTE_TIMEOUT_MS=240000 CHAOS_VETO_WINDOW_MS=100000
  target="real Terse dev server, real actors with timeout constants stretched in the snapshot, fake glue and simulator"
fi
mkdir -p "$out"

load_now() { local load; load="$(cut -d' ' -f1 /proc/loadavg)"; echo "${load%%.*}"; }

if [ "$(load_now)" -ge "$limit" ]; then
  echo "LOAD-STOP: load already at $(cut -d' ' -f1 /proc/loadavg), not starting" | tee "$out/LOAD-STOP"
  exit 3
fi

pids=()
index="${CHAOS_PORT_BASE:-0}"
for ids in "$@"; do
  port=$((7140 + index))
  glue=$((7240 + index))
  bun run run.ts --project "$project" --runId "$run" --only "$ids" --port "$port" --gluePort "$glue" --target "$target" > "$out/group-$index.log" 2>&1 &
  pids+=("$!")
  index=$((index + 1))
done

(
  while sleep 5; do
    if [ "$(load_now)" -ge "$limit" ]; then
      echo "LOAD-STOP: load $(cut -d' ' -f1 /proc/loadavg) at $(date +%H:%M:%S)" > "$out/LOAD-STOP"
      bash ./stop.sh > /dev/null 2>&1
      exit 0
    fi
  done
) &
guard=$!

wait "${pids[@]}"
kill "$guard" 2>/dev/null
[ -f "$out/LOAD-STOP" ] && cat "$out/LOAD-STOP"
grep -hE '^(PASS|FAIL|ERROR) +[a-z]' "$out"/group-*.log | cut -c1-300
echo BATCH-DONE
