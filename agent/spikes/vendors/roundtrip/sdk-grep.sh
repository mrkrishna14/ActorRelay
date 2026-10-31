#!/usr/bin/env bash
# Read-only: lists actor compute docs and runtime settings in the installed Terse packages. Starts nothing.
out="/mnt/c/Users/zubai/Haunted Hacks/Factoryio/agent/spikes/vendors/results/rt-sdk-grep.txt"
base="$HOME/terse-probe/node_modules/durable-actors/dist"
bin=$(ls "$HOME"/.cache/durable-actors/*/linux-x64/durable-actors | head -1)
{
  echo '--- compute.d.ts'; sed -n 1,60p "$base/actor/compute.d.ts" | cut -c1-170
  echo '--- host idle in js'; grep -n -iE 'idle|lease|evict|retire|drain|rotate' "$base/host/actor-host.js" "$base/host/actor-runtime.js" "$base/host/protocol.js" | cut -c1-170 | sed "s#$base/##" | head -40
  echo '--- env names'; strings -n 8 "$bin" | grep -oE 'DURABLE_ACTORS_[A-Z0-9_]+' | sort -u | tr '\n' ' ' | cut -c1-2400; echo
  echo '--- time words'; strings -n 8 "$bin" | grep -iE 'checkpoint|rotation|rotate|compact|snapshot.*(interval|every)|flush.*(interval|every)|retire|evict|idle' | grep -v '^_ZN' | cut -c1-150 | sort -u | head -44
} >"$out" 2>&1
