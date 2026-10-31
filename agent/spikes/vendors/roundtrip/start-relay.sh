#!/usr/bin/env bash
# Keeps the private Relay alive for the measurement, restarting it if something kills it.
export PATH="$HOME/.local/node-24/bin:$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
root="$HOME/ar-vendors"
data="$root/relay-8797"
mkdir -p "$data"
cd "$data"
while true; do
  echo "$(date +%H:%M:%S) starting relay" >>"$root/relay-restarts.log"
  node "$HOME/.actorrelay/relay-runtime/node_modules/@relaycast/engine/dist/bin/serve.js" --db "$data/relaycast.db" --port 8797 --env development >>"$root/relay.log" 2>&1
  echo "$(date +%H:%M:%S) relay exited with $?" >>"$root/relay-restarts.log"
  sleep 1
done
