#!/usr/bin/env bash
# Runs groups of scenarios in parallel, each group on its own port pair and data dirs.
# Usage: batch.sh <runId> <snapshotActorDir> "<ids>" "<ids>" ...
# Optional env: CHAOS_PORT_BASE (default 0) offsets the ports, so two batches can run at once.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$(readlink -f "$0")")"
run="$1"; project="$2"; shift 2
target="real Terse dev server, real actors, fake glue and simulator"
if grep -q 'VETO_WINDOW_MS = 150_000' "$project/src/config.ts"; then
  export CHAOS_VOTE_TIMEOUT_MS=240000 CHAOS_VETO_WINDOW_MS=150000
  target="real Terse dev server, real actors with timeout constants stretched in the snapshot, fake glue and simulator"
fi
mkdir -p "$HOME/ar-chaos/batch/$run"
index="${CHAOS_PORT_BASE:-0}"
for ids in "$@"; do
  port=$((7140 + index))
  glue=$((7240 + index))
  bun run run.ts --project "$project" --runId "$run" --only "$ids" --port "$port" --gluePort "$glue" --target "$target" > "$HOME/ar-chaos/batch/$run/group-$index.log" 2>&1 &
  index=$((index + 1))
done
wait
grep -hE '^(PASS|FAIL|ERROR) +[a-z]' "$HOME/ar-chaos/batch/$run"/group-*.log | cut -c1-300
echo BATCH-DONE
