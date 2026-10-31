#!/usr/bin/env bash
# Freezes actor/ and shared/ onto the Linux filesystem, so an edit in the shared checkout cannot hot-reload
# or change code halfway through a crash scenario, and SQLite is not running across /mnt/c.
# Uses the runtime and packages main installed in ~/terse-probe, so this downloads nothing.
# Usage: prepare.sh [probe]
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
here="$(dirname "$(readlink -f "$0")")"
repo="$(readlink -f "$here/../../..")"
root="$HOME/ar-chaos"
modules="$HOME/terse-probe/node_modules"
mkdir -p "$root"

if [ "${1:-}" = "probe" ]; then
  target="$root/probe-project"
  rm -rf "$target"
  mkdir -p "$target"
  cp -r "$here/probe/src" "$target/src"
  cp "$repo/actor/tsconfig.json" "$target/tsconfig.json"
  printf '{ "name": "chaos-probe", "version": "0.0.0", "private": true, "type": "module" }\n' > "$target/package.json"
  ln -s "$modules" "$target/node_modules"
  echo "$target"
  exit 0
fi

stamp="$(date +%H%M%S)"
target="$root/snapshot-$stamp"
mkdir -p "$target"
tar -C "$repo" --exclude=node_modules --exclude=.durable-actors --exclude=tests --exclude=generated --exclude=adapter -cf - actor shared | tar -C "$target" -xf -
ln -s "$modules" "$target/actor/node_modules"
{
  git -C "$repo" log -1 --format='commit %h %s' -- actor || true
  git -C "$repo" status --short -- actor/src || true
  sha256sum "$target"/actor/src/*.ts "$target"/actor/src/logic/*.ts
} > "$target/SOURCE" 2>&1
ln -sfn "$target" "$root/snapshot"
echo "$target/actor"
