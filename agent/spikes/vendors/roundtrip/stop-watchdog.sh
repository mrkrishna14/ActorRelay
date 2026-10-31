#!/usr/bin/env bash
# Stops this spike's Relay watchdog loop only, then removes any second server it started on the same database.
pkill -f 'vendors/roundtrip/start-relay.sh'
sleep 1
pids=$(pgrep -f 'serve.js --db .*/ar-vendors/relay-8797/relaycast.db --port 8797' | sort -n)
echo "relay pids: $pids"
first=$(echo "$pids" | head -1)
for p in $pids; do [ "$p" != "$first" ] && kill -9 "$p"; done
exit 0
