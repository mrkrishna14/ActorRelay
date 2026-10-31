#!/usr/bin/env bash
# Read-only: summarises slow request lines in the newest stored Terse log. Starts nothing.
out="/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/vendors/results/rt-terse-slow.txt"
log=$(ls -t "$HOME"/ar-vendors/terse-*.log | head -1)
{
  echo "$log $(wc -l <"$log") lines"
  echo '--- request lines by route'
  grep -E '^ *[0-9]{3}  (POST|GET)' "$log" | sed -E 's/^ *([0-9]{3})  (POST|GET) +[0-9.]+ (ms|s)  /\1 /; s/plant-[ab]/plant/; s/\.[A-Z0-9-]+-[0-9]+/.X/' | cut -c1-70 | sort | uniq -c | sort -rn | head -14
  echo '--- Runtime Execute latency buckets'
  grep 'Runtime' "$log" | awk '{v=$3; if ($4=="s") v*=1000; if (v<5) a++; else if (v<100) b++; else if (v<1000) c++; else if (v<5000) d++; else e++} END {print "<5ms",a,"5-100ms",b,"100ms-1s",c,"1-5s",d,">5s",e}'
  echo '--- longest Runtime Execute'
  grep 'Runtime' "$log" | awk '{v=$3; if ($4=="s") v*=1000; print v}' | sort -rn | head -8 | tr '\n' ' '; echo
  echo '--- other lines'
  grep -vE '^ *[0-9]{3}  (POST|GET)|^$' "$log" | sed -E 's/count=[0-9]+/count=N/' | cut -c1-140 | sort | uniq -c | sort -rn | head -14
  echo '--- line numbers of slow invokes'
  grep -n -E 'Plant/plant-[ab]|Component/' "$log" | awk '{ v=$4; if ($5=="s") v*=1000; if (v>=2400) print $1, v, $7 }' | cut -c1-60 | awk 'NR%6==1' | head -40
} >"$out" 2>&1
