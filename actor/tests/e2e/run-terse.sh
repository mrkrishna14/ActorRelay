#!/bin/bash
# Real Terse run. Freezes actor/ and shared/ onto the Linux filesystem, starts a private `terse actor dev`
# (own port, own data dir, never 7100), then runs the e2e against it. From PowerShell:
#   wsl.exe -d Ubuntu --cd /tmp -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/actor/tests/e2e/run-terse.sh" attacks,demo
# Pass E2E_AGENTS=relay with E2E_PUBLISH_URL to use real Relay agents.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/bin:/usr/bin:/bin"
here="$(dirname "$(readlink -f "$0")")"
repo="$(readlink -f "$here/../../..")"
phase="${1:-attacks,demo}"
port="${E2E_TERSE_PORT:-7110}"
gluePort="${FAKE_GLUE_PORT:-7210}"
root="$HOME/ar-verify"
stamp="$(date +%H%M%S)"
target="$root/snapshot-$stamp"

server=0
if [ "${E2E_ACTORS:-terse}" = "terse" ]; then
mkdir -p "$target"
tar -C "$repo" --exclude=node_modules --exclude=.durable-actors --exclude=tests --exclude=generated --exclude=adapter -cf - actor shared | tar -C "$target" -xf -
ln -s "$HOME/terse-probe/node_modules" "$target/actor/node_modules"

cd "$target/actor"
DURABLE_ACTORS_DATA_DIR="$root/data-$stamp" TERSE_ACTOR_PORT="$port" GLUE_URL="http://127.0.0.1:$gluePort" \
  DURABLE_ACTORS_CONTROL_PLANE_URL="http://127.0.0.1:$port" \
  setsid "$HOME/terse-probe/node_modules/.bin/terse" actor dev --port "$port" >"$root/terse-$stamp.log" 2>&1 &
server=$!
trap 'kill -9 -- -"$server" 2>/dev/null' EXIT

for _ in $(seq 1 120); do
  curl -sf -m 1 "http://127.0.0.1:$port/healthz" >/dev/null && break
  sleep 0.5
done
if ! curl -sf -m 1 "http://127.0.0.1:$port/healthz" >/dev/null; then
  echo "terse did not become healthy on $port"
  tail -30 "$root/terse-$stamp.log"
  exit 3
fi
echo "[terse] healthy on $port, snapshot $target"
fi

agents=0
if [ "${E2E_AGENTS:-}" = "relay" ]; then
  systemPort="${E2E_SYSTEM_PORT:-7203}"
  mkdir -p "$root/agent-run/agent"
  [ -e "$root/agent-run/agent/node_modules" ] || ln -s "$HOME/.actorrelay/agent-run/agent/node_modules" "$root/agent-run/agent/node_modules"
  AGENT_RUN_DIR="$root/agent-run" GLUE_URL="http://127.0.0.1:$gluePort" SYSTEM_PORT="$systemPort"     RELAY_TOKENS_FILE="$root/relay-tokens-$stamp.json" RELAY_WORKSPACE_NAME="ar-verify-$stamp"     setsid bash "$repo/agent/run-wsl.sh" >"$root/agents-$stamp.log" 2>&1 &
  agents=$!
  trap '[ "$server" = 0 ] || kill -9 -- -"$server" 2>/dev/null; kill -9 -- -"$agents" 2>/dev/null' EXIT
  for _ in $(seq 1 240); do
    grep -q "^ready:" "$root/agents-$stamp.log" 2>/dev/null && break
    sleep 0.5
  done
  if ! grep -q "^ready:" "$root/agents-$stamp.log"; then
    echo "agents did not become ready"
    tail -20 "$root/agents-$stamp.log" | cut -c1-240
    exit 4
  fi
  echo "[agents] $(grep '^ready:' "$root/agents-$stamp.log")"
  export E2E_PUBLISH_URL="http://127.0.0.1:$systemPort/publish"
fi

cd "$here"
E2E_SLOW="${E2E_SLOW:-4}" E2E_POLL_MS="${E2E_POLL_MS:-1000}" E2E_ACTORS="${E2E_ACTORS:-terse}" E2E_TERSE_URL="http://127.0.0.1:$port" bun run run.ts "--phase=$phase"
code=$?
if [ "$agents" != 0 ]; then
  echo "[agents] log tail:"
  grep -E "voted|countered|calibrated|refused|dropped|failed" "$root/agents-$stamp.log" | tail -30 | cut -c1-200
fi
if [ "$server" != 0 ]; then
  echo "[terse] log tail:"
  tail -15 "$root/terse-$stamp.log" | cut -c1-220
fi
exit $code
