#!/usr/bin/env bash
# Freezes actor/ and shared/ onto the Linux filesystem, so an edit in the shared checkout cannot hot-reload
# or change code halfway through a crash scenario, and SQLite is not running across /mnt/c.
# Uses the runtime and packages main installed in ~/terse-probe, so this downloads nothing.
# Usage: prepare.sh [probe|stretched]
# "stretched" raises only the timeout constants, so a rebuild fits inside the vote, veto and claim windows.
# It exists to reach the survive-within-window code path; results from it are labelled.
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
# An exact commit, never the working tree: other sessions edit actor/ while these runs are going.
ref="${CHAOS_REF:-HEAD}"
git -C "$repo" archive "$ref" actor/src actor/package.json actor/tsconfig.json shared | tar -C "$target" -xf -
ln -s "$modules" "$target/actor/node_modules"
if [ "${1:-}" = "stretched" ]; then
  sed -i -E 's/VOTE_TIMEOUT_MS = 30_000/VOTE_TIMEOUT_MS = 240_000/; s/VETO_WINDOW_MS = 10_000/VETO_WINDOW_MS = 150_000/; s/CLAIM_TIMEOUT_MS = 20_000/CLAIM_TIMEOUT_MS = 240_000/' "$target/actor/src/config.ts"
fi
{
  git -C "$repo" log -1 --format='commit %h %s' "$ref" -- actor/src || true
  sha256sum "$target"/actor/src/*.ts "$target"/actor/src/logic/*.ts
} > "$target/SOURCE" 2>&1
# Runs in flight resolve this link at each start, so a stretched copy must never replace it.
[ "${1:-}" = "stretched" ] || ln -sfn "$target" "$root/snapshot"
echo "$target/actor"
