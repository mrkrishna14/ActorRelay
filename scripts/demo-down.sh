#!/usr/bin/env bash
# Stop the processes demo-up.sh starts (local only). State in .durable-actors / glue journal is kept.
set -uo pipefail
stop() { if pkill -f "$2" 2>/dev/null; then echo "  stopped $1"; else echo "  $1 not running"; fi; }
stop web       "next dev --hostname 127.0.0.1 --port 3000"
stop agents    "bun src/spawn.ts"
stop glue      "bun server.ts"
stop sim       "bridge/live_sim.py"
stop actors    "terse actor dev"
stop actors-rt "durable-actors dev --project-id local"
