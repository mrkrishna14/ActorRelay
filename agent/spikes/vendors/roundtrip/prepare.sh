#!/usr/bin/env bash
# Freezes agent/, actor/ and shared/ onto the Linux filesystem and starts a private Relay and Terse.
# Ports 8797 and 7130 and ~/ar-vendors are this spike's own; ports 7100 and 8787 are never touched.
# Usage: prepare.sh [up|agent|down]
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/bin:/usr/bin:/bin"
here="$(dirname "$(readlink -f "$0")")"
repo="$(readlink -f "$here/../../../..")"
root="$HOME/ar-vendors"
relayPort=8797
tersePort=7130
gluePort=7230
mkdir -p "$root"

freeze_agent() {
  dir="$root/run"
  mkdir -p "$dir/agent/roles" "$dir/agent/roundtrip" "$dir/shared"
  cp "$repo"/agent/*.ts "$repo"/agent/physics.md "$repo"/agent/package.json "$dir/agent/"
  cp "$repo"/agent/roles/*.md "$dir/agent/roles/"
  cp "$repo"/shared/* "$dir/shared/"
  cp "$repo"/actor/tests/fixtures-gen/history.json "$dir/shared/history.standin.json"
  mkdir -p "$dir/actor/tests/fixtures-gen" "$dir/glue" "$dir/bridge"
  cp "$repo"/actor/tests/fixtures-gen/history.json "$dir/actor/tests/fixtures-gen/"
  cp "$repo"/glue/*.ts "$repo"/glue/package.json "$dir/glue/"
  cp "$repo"/bridge/*.ts "$dir/bridge/"
  cp "$here"/*.ts "$dir/agent/roundtrip/"
  [ -e "$dir/agent/node_modules" ] || ln -s "$HOME/.actorrelay/agent-run/agent/node_modules" "$dir/agent/node_modules"
  [ -e "$dir/glue/node_modules" ] || ln -s "$HOME/.actorrelay/agent-run/agent/node_modules" "$dir/glue/node_modules"
  git -C "$repo" log -1 --format='agent at %h %s' -- agent
}

start_relay() {
  if curl -sf -m 2 "http://127.0.0.1:$relayPort/health" >/dev/null; then echo "relay already up on $relayPort"; return; fi
  RELAY_PORT="$relayPort" RELAY_DATA_DIR="$root/relay-$relayPort" setsid bash "$repo/agent/spikes/relay/start-relay.sh" >"$root/relay.log" 2>&1 &
  for _ in $(seq 1 120); do curl -sf -m 1 "http://127.0.0.1:$relayPort/health" >/dev/null && break; sleep 0.5; done
  curl -sf -m 1 "http://127.0.0.1:$relayPort/health" >/dev/null && echo "relay up on $relayPort" || { echo "relay failed"; tail -20 "$root/relay.log"; exit 3; }
}

start_terse() {
  if curl -sf -m 2 "http://127.0.0.1:$tersePort/healthz" >/dev/null; then echo "terse already up on $tersePort"; return; fi
  stamp="$(date +%H%M%S)"
  target="$root/terse-$stamp"
  mkdir -p "$target"
  tar -C "$repo" --exclude=node_modules --exclude=.durable-actors --exclude=tests --exclude=generated -cf - actor shared | tar -C "$target" -xf -
  ln -s "$HOME/terse-probe/node_modules" "$target/actor/node_modules"
  [ -n "${ACTOR_PATCH:-}" ] && (cd "$target/actor" && bun run "$here/patch-actor.ts" $ACTOR_PATCH)
  git -C "$repo" log -1 --format='%h %ci %s' -- actor/src >"$root/actor-commit.txt"
  git -C "$repo" status --short -- actor/src >>"$root/actor-commit.txt"
  cat "$root/actor-commit.txt" | cut -c1-90
  cd "$target/actor"
  dataRoot="${TERSE_DATA_ROOT:-$root}"
  mkdir -p "$dataRoot"
  DURABLE_ACTORS_DATA_DIR="$dataRoot/data-$stamp" TERSE_ACTOR_PORT="$tersePort" GLUE_URL="http://127.0.0.1:$gluePort" \
    DURABLE_ACTORS_CONTROL_PLANE_URL="http://127.0.0.1:$tersePort" \
    setsid "$HOME/terse-probe/node_modules/.bin/terse" actor dev --port "$tersePort" >"$root/terse-$stamp.log" 2>&1 &
  echo $! >"$root/terse.pid"
  for _ in $(seq 1 240); do curl -sf -m 1 "http://127.0.0.1:$tersePort/healthz" >/dev/null && break; sleep 0.5; done
  curl -sf -m 1 "http://127.0.0.1:$tersePort/healthz" >/dev/null && echo "terse up on $tersePort after ${SECONDS}s" || { echo "terse failed"; tail -30 "$root/terse-$stamp.log" | cut -c1-200; exit 4; }
}

stop_all() {
  [ -f "$root/terse.pid" ] && kill -9 -- -"$(cat "$root/terse.pid")" 2>/dev/null
  pkill -f "relay-$relayPort/relaycast.db" 2>/dev/null
  rm -f "$root/terse.pid"
  echo stopped
}

case "${1:-up}" in
  up) freeze_agent; start_relay; start_terse ;;
  agent) freeze_agent ;;
  terse) start_terse ;;
  restart-terse) [ -f "$root/terse.pid" ] && kill -9 -- -"$(cat "$root/terse.pid")" 2>/dev/null; sleep 1; rm -rf /dev/shm/ar-vendors/data-*; start_terse ;;
  down) stop_all ;;
esac
