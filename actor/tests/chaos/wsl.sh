#!/usr/bin/env bash
# WSL entry point. Sets PATH per RULES.md (profiles stay untouched) and runs a chaos script with bun.
# Usage from PowerShell:
#   wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/chaos/wsl.sh" lib/selftest.ts
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.terse/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$(readlink -f "$0")")"
exec bun run "$@"
