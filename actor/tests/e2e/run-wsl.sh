#!/bin/bash
# Runs the e2e inside WSL, because Terse and the actor decorators need Bun 1.4. From PowerShell:
#   wsl.exe -d Ubuntu -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/e2e/run-wsl.sh" [--phase=attacks,demo]
# Env passes through: E2E_ACTORS, E2E_AGENTS, E2E_TERSE_URL, E2E_PUBLISH_URL, FAKE_GLUE_PORT, FAKE_PLANT_PORT.
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")" || exit 1
exec bun run run.ts "$@"
