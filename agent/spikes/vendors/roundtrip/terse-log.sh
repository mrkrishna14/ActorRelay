#!/usr/bin/env bash
# Writes the interesting parts of the newest private Terse log to a file the Windows side can read.
out="/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/vendors/results/rt-terse-tail.txt"
log=$(ls -t "$HOME"/ar-vendors/terse-*.log | head -1)
{
  echo "$log"; wc -l "$log"
  echo '--- not request lines'
  grep -n -vE 'Runtime|Execute|^ *[0-9]{3}  POST|^ *[0-9]{3}  GET|^$' "$log" | cut -c1-230 | head -40
  echo '--- non-200 by route'
  grep -E '^ *[3-5][0-9][0-9] ' "$log" | sed -E 's/ +[0-9.]+ (ms|s) / /' | cut -c1-90 | sort | uniq -c | sort -rn | head -12
  echo '--- slowest plant invokes'
  grep -E 'Plant/plant-[ab]' "$log" | awk '{ v=$3; if ($4=="s") v=v*1000; print v, $0 }' | sort -rn | head -14 | cut -c1-120
  echo '--- invoke counts'
  grep -oE '(Plant|Component|Company)/[a-zA-Z0-9.-]+ . invoke' "$log" | sort | uniq -c | sort -rn | head -14
  curl -s -o /dev/null -m 3 -w 'health %{http_code}\n' http://127.0.0.1:7130/healthz
  cat /proc/loadavg
} >"$out" 2>&1
