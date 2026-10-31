#!/usr/bin/env bash
# Runs the agents inside WSL, next to Relay and the actors. Code is copied to the Linux filesystem first,
# because loading node_modules from /mnt/c takes minutes. Re-running picks up the latest code.
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${AGENT_RUN_DIR:-$HOME/.actorrelay/agent-run}"

mkdir -p "$RUN_DIR/agent/roles" "$RUN_DIR/shared"
cp "$REPO"/agent/*.ts "$REPO"/agent/physics.md "$REPO"/agent/package.json "$RUN_DIR/agent/"
cp "$REPO"/agent/roles/*.md "$RUN_DIR/agent/roles/"
cp "$REPO"/shared/* "$RUN_DIR/shared/"
if [ -f "$REPO/.env" ]; then install -m 600 "$REPO/.env" "$RUN_DIR/.env"; fi

cd "$RUN_DIR/agent"
[ -d node_modules ] || bun install
exec bun run spawn.ts
