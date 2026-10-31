#!/usr/bin/env bash
# Runs groups of scenarios in parallel, each group on its own port pair and data dirs.
# Usage: batch.sh <runId> <snapshotActorDir> "<ids>" "<ids>" ...
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$(readlink -f "$0")")"
run="$1"; project="$2"; shift 2
mkdir -p "$HOME/ar-chaos/batch/$run"
index=0
for ids in "$@"; do
  port=$((7140 + index))
  glue=$((7240 + index))
  bun run run.ts --project "$project" --runId "$run" --only "$ids" --port "$port" --gluePort "$glue" > "$HOME/ar-chaos/batch/$run/group-$index.log" 2>&1 &
  index=$((index + 1))
done
wait
cat "$HOME/ar-chaos/batch/$run"/group-*.log | grep -E '^(PASS|FAIL|ERROR) |^(FAIL|PASS|ERROR)  ?[a-z]|^=== |  FAIL |  NOTE RUNTIME|  ERROR ' | cut -c1-400
echo BATCH-DONE
