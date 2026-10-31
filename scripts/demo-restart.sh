#!/usr/bin/env bash
# Restarts the demo stack: stops whatever holds the demo ports, then starts the full stack and leaves it running.
uptime | cut -c30-
echo "terse processes: $(pgrep -fc durable-actors)"
for port in 7190 7200 7201 7300; do
  pid=$(ss -ltnp 2>/dev/null | grep ":$port " | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "stopped demo port $port"
done
sleep 2
STACK_KEEP=1 STACK_GLUE_PORT=7200 STACK_BRIDGE_PORT=7300 STACK_TERSE_PORT=7190 STACK_AGENT_PORT=7201 \
  bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/glue/stack-wsl.sh"
