#!/usr/bin/env bash
# Runs one round-trip measurement in WSL. Usage: RT_LABEL=baseline RT_REPEATS=12 RT_TEN=6 run.sh
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/bin:/usr/bin:/bin"
here="$(dirname "$(readlink -f "$0")")"
repo="$(readlink -f "$here/../../../..")"
run="$HOME/ar-vendors/run"
bash "$here/prepare.sh" agent >/dev/null
[ -n "${AGENT_PATCH:-}" ] && (cd "$run/agent" && bash -c "$AGENT_PATCH")
OPENAI_API_KEY="$(sed -n 's/^OPENAI_API_KEY=//p' "$repo/.env" | tr -d '\r')"
export OPENAI_API_KEY
export RT_RESULTS="$here/../results"
cd "$run/agent"
exec bun run roundtrip/roundtrip.ts
