#!/usr/bin/env bash
# Brings the whole demo up after a reboot: Relay, dashboard, then actors, simulator, glue and agents.
REPO="/mnt/c/Users/zubai/Haunted Hacks/Factoryio"
curl -s -o /dev/null -m 2 http://127.0.0.1:8787/health || bash "$REPO/agent/spikes/relay/start-relay.sh" --detach
for i in $(seq 1 90); do
  curl -s -o /dev/null -m 2 http://127.0.0.1:8787/health && { echo "relay up after ${i}s"; break; }
  sleep 1
done
bash "$REPO/scripts/web-wsl.sh"
bash "$REPO/scripts/demo-restart.sh"
