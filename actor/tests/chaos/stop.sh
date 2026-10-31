#!/usr/bin/env bash
# Stops chaos runs only: anything on ports 7140-7149, plus our runner scripts. Other sessions' servers stay up.
pkill -f 'chaos/batch.sh' 2>/dev/null
pkill -f 'run.ts --project /home/zubair/ar-chaos' 2>/dev/null
pkill -f 'run.ts --suite probe' 2>/dev/null
for port in 7140 7141 7142 7143 7144 7145 7146 7147 7148 7149; do
  pid="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
  [ -z "$pid" ] && continue
  pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  [ -n "$pgid" ] && kill -9 "-$pgid" 2>/dev/null
done
sleep 1
ss -ltnH 2>/dev/null | grep -cE ':7(14[0-9]|24[0-9]) ' || true
