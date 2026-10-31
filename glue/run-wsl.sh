#!/usr/bin/env bash
# Runs glue inside WSL, next to Relay and the actors. Code is copied to the Linux filesystem first, because loading
# node_modules from /mnt/c takes minutes. Re-running picks up the latest code.
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${GLUE_RUN_DIR:-$HOME/.actorrelay/glue-run}"

mkdir -p "$RUN_DIR/glue" "$RUN_DIR/shared" "$RUN_DIR/actor/tests/fixtures-gen"
cp "$REPO"/glue/*.ts "$REPO"/glue/package.json "$RUN_DIR/glue/"
cp "$REPO"/shared/* "$RUN_DIR/shared/"
cp "$REPO"/actor/tests/fixtures-gen/history.json "$RUN_DIR/actor/tests/fixtures-gen/"

cd "$RUN_DIR/glue"
[ -d node_modules ] || bun install
exec bun run "${1:-server.ts}"
