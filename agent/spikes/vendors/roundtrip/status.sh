#!/usr/bin/env bash
# Reports the spike's private services to a file, because wsl.exe console output arrives garbled.
out="/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/vendors/results/rt-status.txt"
{
  date '+%H:%M:%S'
  for p in 8797/health 7130/healthz; do echo "$p $(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$p")"; done
  cat /proc/loadavg
  ps -eo pid,etimes,args | grep -E 'serve.js.*8797|actor dev --port 7130' | grep -v grep | cut -c1-120
  tail -4 "$HOME/ar-vendors/relay-restarts.log" 2>/dev/null
} >"$out" 2>&1
