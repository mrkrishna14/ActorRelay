#!/usr/bin/env bash
# Runs the logic tests in WSL against one source copy. No server starts. Usage: run.sh <base|fixed|path>
export PATH="$HOME/.bun/bin:/usr/bin:/bin"
cd "$(dirname "$(readlink -f "$0")")/.."
case "${1:-base}" in
  base|fixed) src="$PWD/logic/.src/$1/actor/src" ;;
  *) src="$1" ;;
esac
CHAOS_SRC="$src" bun test logic/dispatch-recovery.test.ts 2>&1
