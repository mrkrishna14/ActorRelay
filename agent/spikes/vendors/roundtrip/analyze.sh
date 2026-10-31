#!/usr/bin/env bash
# Runs analyze.ts for one finished label. Usage: RT_LABEL=real-ram analyze.sh
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
here="$(dirname "$(readlink -f "$0")")"
cp "$here/analyze.ts" "$HOME/ar-vendors/run/agent/roundtrip/analyze.ts"
export RT_RESULTS="$here/../results"
cd "$HOME/ar-vendors/run/agent"
exec bun run roundtrip/analyze.ts
