#!/usr/bin/env bash
# Installs the Relay server on the WSL Linux filesystem. Loading it from /mnt/c is slow.
set -euo pipefail
export PATH="$HOME/.local/node-24/bin:$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${RELAY_RUNTIME_DIR:-$HOME/.actorrelay/relay-runtime}"

mkdir -p "$RUNTIME_DIR"
cp "$SPIKE_DIR/package.json" "$SPIKE_DIR/bun.lock" "$RUNTIME_DIR/"
cd "$RUNTIME_DIR"
bun install --frozen-lockfile
node -e "const D=require('better-sqlite3');console.log('better-sqlite3', new D(':memory:').prepare('select sqlite_version() v').get().v)"
