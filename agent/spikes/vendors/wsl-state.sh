#!/usr/bin/env bash
# Shows what is running in WSL: listening ports, runtimes, load and memory. Prints no secrets.
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:$HOME/.local/bin:$HOME/.terse/bin:$PATH"
date '+%H:%M:%S %Z'; uptime; free -m | head -2
echo "--- listening"; ss -ltnp 2>/dev/null | awk 'NR>1{print $4, $6}' | sed -E 's/users:\(\("([^"]+)",pid=([0-9]+).*/\1 pid=\2/' | sort -u | head -30
echo "--- procs"; ps -eo pid,etimes,pcpu,rss,args --sort=-pcpu | grep -E 'terse|relay|serve.js|spawn.ts|bun |node ' | grep -v grep | cut -c1-150 | head -24
echo "--- actorrelay"; ls -la ~/.actorrelay 2>&1 | cut -c1-90 | head -30
which terse bun node 2>&1; terse --version 2>&1 | head -1
for p in 7100 7110 7120 7200 7201 7300 8787 8788 8797; do code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$p/health"); echo "port $p health=$code"; done
