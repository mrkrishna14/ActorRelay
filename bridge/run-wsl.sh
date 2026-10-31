#!/usr/bin/env bash
# Starts the live plant inside WSL, next to glue, actors and agents. WSL cannot reach a Windows 127.0.0.1 service, and
# glue reaches this one on 127.0.0.1:7300, so run it here. The bridge has no dependencies, so /mnt/c is fine.
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
exec bun run bridge/live_sim.ts
