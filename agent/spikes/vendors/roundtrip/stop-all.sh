#!/usr/bin/env bash
# Stops everything this spike started in WSL and frees its RAM disk. Touches only its own ports and paths.
root="$HOME/ar-vendors"
[ -f "$root/terse.pid" ] && kill -9 -- -"$(cat "$root/terse.pid")" 2>/dev/null
rm -f "$root/terse.pid"
pkill -f 'vendors/roundtrip/start-relay.sh' 2>/dev/null
pkill -9 -f 'serve.js --db .*/ar-vendors/relay-8797/relaycast.db' 2>/dev/null
pkill -9 -f 'roundtrip/drive.ts' 2>/dev/null
pkill -9 -f 'roundtrip/timing-preload.ts' 2>/dev/null
pkill -9 -f 'ar-vendors/run' 2>/dev/null
sleep 1
rm -rf /dev/shm/ar-vendors /dev/shm/ar-vendors-fsync
out="/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/vendors/results/rt-status.txt"
{
  date '+%H:%M:%S'
  for p in 8797/health 7130/healthz 7230/health 7330/health 7231/health; do echo "$p $(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$p")"; done
  cat /proc/loadavg
  echo "terse hosts on 7130: $(grep -lz 'DURABLE_ACTORS_CONTROL_PLANE_URL=http://127.0.0.1:7130' /proc/[0-9]*/environ 2>/dev/null | wc -l)"
  echo "processes with ar-vendors in args: $(ps -eo args | grep ar-vendors | grep -v grep | wc -l)"
} >"$out" 2>&1
