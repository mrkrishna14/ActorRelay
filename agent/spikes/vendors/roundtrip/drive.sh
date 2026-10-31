#!/usr/bin/env bash
# Runs one real-stack measurement in WSL. Usage: RT_LABEL=real RT_REPEATS=10 RT_TEN=3 drive.sh
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/bin:/usr/bin:/bin"
here="$(dirname "$(readlink -f "$0")")"
repo="$(readlink -f "$here/../../../..")"
run="$HOME/ar-vendors/run"
bash "$here/prepare.sh" agent >/dev/null
[ -n "${AGENT_PATCH:-}" ] && (cd "$run/agent" && bun run roundtrip/patch.ts $AGENT_PATCH)
[ -n "${GLUE_PATCH:-}" ] && (cd "$run/glue" && bun run ../agent/roundtrip/patch.ts $GLUE_PATCH)
OPENAI_API_KEY="$(sed -n 's/^OPENAI_API_KEY=//p' "$repo/.env" | tr -d '\r')"
export OPENAI_API_KEY
export RT_RESULTS="$here/../results"
RT_ACTOR_COMMIT="$(head -1 "$HOME/ar-vendors/actor-commit.txt" 2>/dev/null)"
export RT_ACTOR_COMMIT
cd "$run/agent"
exec bun run roundtrip/drive.ts
