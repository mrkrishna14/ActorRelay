#!/usr/bin/env bash
# Runs the actor probe in WSL against the private Terse. Usage: RT_LABEL=probe RT_MIRROR_MS=1000 probe.sh
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/bin:/usr/bin:/bin"
here="$(dirname "$(readlink -f "$0")")"
bash "$here/prepare.sh" agent >/dev/null
export RT_RESULTS="$here/../results"
cd "$HOME/ar-vendors/run/agent"
exec bun run roundtrip/actor-probe.ts
