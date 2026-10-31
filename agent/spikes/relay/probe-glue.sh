#!/usr/bin/env bash
# Copies glue/ to the Linux filesystem, then runs probe-glue.mjs against the Relay server on 8787.
# Last run against the glue at commit bcfd064. Needs a glue/ with the same environment contract.
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SPIKE_DIR/../../.." && pwd)"
PROBE_DIR="${PROBE_DIR:-$HOME/.actorrelay/glue-probe}"
GLUE_DIR="$PROBE_DIR/glue"
GLUE_PORT="${GLUE_PORT:-7200}"

if ss -ltn | grep -q ":$GLUE_PORT "; then
  echo "port $GLUE_PORT is in use inside WSL, not probing" >&2
  exit 3
fi

mkdir -p "$GLUE_DIR" "$PROBE_DIR/shared"
cp "$REPO"/glue/*.ts "$REPO"/glue/package.json "$REPO"/glue/bun.lock "$REPO"/glue/mock-plants.json "$GLUE_DIR/"
cp "$REPO"/shared/* "$PROBE_DIR/shared/"
(cd "$GLUE_DIR" && bun install --frozen-lockfile 2>&1 | tail -2)

export GLUE_DIR PROBE_DIR GLUE_PORT
cd "$SPIKE_DIR"
exec bun run probe-glue.mjs
