#!/usr/bin/env bash
# Starts a private copy of the whole stack on side ports, runs the e2e against it, and stops it again. It never touches the
# ports or data of a demo. From PowerShell:
#   wsl.exe -d Ubuntu --cd /tmp -- bash "/mnt/c/Users/zubai/Haunted Hacks/Factoryio/glue/stack-wsl.sh"
# STACK_KEEP=1 leaves it running after the e2e. Other env: STACK_TERSE_PORT, STACK_GLUE_PORT, STACK_BRIDGE_PORT, STACK_ROOT.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/node-24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
ROOT="${STACK_ROOT:-$HOME/ar-glue-stack}"
TERSE_PORT="${STACK_TERSE_PORT:-7176}"
GLUE_PORT="${STACK_GLUE_PORT:-7276}"
AGENT_PORT="$((GLUE_PORT + 1))"
BRIDGE_PORT="${STACK_BRIDGE_PORT:-7376}"
STAMP="$(date +%H%M%S)"
RUN="$ROOT/run-$STAMP"
GLUE_URL="http://127.0.0.1:$GLUE_PORT"
TERSE_URL="http://127.0.0.1:$TERSE_PORT"
BRIDGE_URL="http://127.0.0.1:$BRIDGE_PORT"
mkdir -p "$RUN/logs"
export RELAY_KEY_FILE="$RUN/relay-key"
export RELAY_URL="${RELAY_URL:-http://127.0.0.1:8787}"

PIDS=()
stop() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -9 -- "-$pid" 2>/dev/null; done
}
[ "${STACK_KEEP:-0}" = 1 ] || trap stop EXIT

wait_for() { # url seconds label
  for _ in $(seq 1 "$(( $2 * 2 ))"); do
    curl -s -o /dev/null -m 1 "$1" && return 0
    sleep 0.5
  done
  echo "$3 did not come up at $1"
  return 1
}

curl -s -o /dev/null -m 2 "$RELAY_URL/health" || { echo "Relay is not up on $RELAY_URL: start agent/spikes/relay/start-relay.sh"; exit 2; }

echo "[stack] actors: building on $TERSE_PORT"
mkdir -p "$RUN/app"
tar -C "$REPO" --exclude=node_modules --exclude=.durable-actors --exclude=tests --exclude=generated --exclude=adapter -cf - actor shared | tar -C "$RUN/app" -xf -
ln -s "$HOME/terse-probe/node_modules" "$RUN/app/actor/node_modules"
(cd "$RUN/app/actor" && DURABLE_ACTORS_DATA_DIR="$RUN/data" TERSE_ACTOR_PORT="$TERSE_PORT" GLUE_URL="$GLUE_URL" DURABLE_ACTORS_CONTROL_PLANE_URL="$TERSE_URL" \
  exec setsid "$HOME/terse-probe/node_modules/.bin/terse" actor dev --port "$TERSE_PORT" >"$RUN/logs/terse.log" 2>&1) &
PIDS+=($!)
wait_for "$TERSE_URL/healthz" 240 Terse || { tail -30 "$RUN/logs/terse.log"; exit 3; }

echo "[stack] simulator on $BRIDGE_PORT"
mkdir -p "$RUN/bridge"
cp "$REPO"/bridge/*.ts "$RUN/bridge/"
mkdir -p "$RUN/shared" && cp "$REPO"/shared/* "$RUN/shared/"
(cd "$RUN" && BRIDGE_PORT="$BRIDGE_PORT" GLUE_URL="$GLUE_URL" exec setsid bun run bridge/live_sim.ts >"$RUN/logs/bridge.log" 2>&1) &
PIDS+=($!)
wait_for "$BRIDGE_URL/health" 30 simulator || { tail -20 "$RUN/logs/bridge.log"; exit 3; }

echo "[stack] glue on $GLUE_PORT"
mkdir -p "$ROOT/glue-run/glue"
[ -e "$ROOT/glue-run/glue/node_modules" ] || ln -s "$HOME/.actorrelay/agent-run/agent/node_modules" "$ROOT/glue-run/glue/node_modules"
(GLUE_RUN_DIR="$ROOT/glue-run" GLUE_PORT="$GLUE_PORT" TERSE_URL="$TERSE_URL" BRIDGE_URL="$BRIDGE_URL" RELAY_SYSTEM_TOKEN_FILE="$RUN/system-token.json" \
  exec setsid bash "$REPO/glue/run-wsl.sh" >"$RUN/logs/glue.log" 2>&1) &
PIDS+=($!)
wait_for "$GLUE_URL/health" 60 glue || { tail -20 "$RUN/logs/glue.log"; exit 3; }
for _ in $(seq 1 60); do
  curl -s -m 1 "$GLUE_URL/health" | grep -q '"relay":true' && break
  sleep 0.5
done

echo "[stack] agents, health on $AGENT_PORT"
mkdir -p "$ROOT/agent-run/agent"
[ -e "$ROOT/agent-run/agent/node_modules" ] || ln -s "$HOME/.actorrelay/agent-run/agent/node_modules" "$ROOT/agent-run/agent/node_modules"
(AGENT_RUN_DIR="$ROOT/agent-run" GLUE_URL="$GLUE_URL" AGENT_HEALTH_PORT="$AGENT_PORT" RELAY_TOKENS_FILE="$RUN/agent-tokens.json" \
  exec setsid bash "$REPO/agent/run-wsl.sh" >"$RUN/logs/agents.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 240); do
  grep -q "^ready:" "$RUN/logs/agents.log" 2>/dev/null && break
  sleep 0.5
done
grep "^ready:" "$RUN/logs/agents.log" || { echo "agents did not become ready"; tail -20 "$RUN/logs/agents.log" | cut -c1-240; exit 4; }

echo "[stack] warm-up reset: the first call to each actor starts its host process"
curl -s -m 60 -X POST -H 'content-type: application/json' -d '{}' "$GLUE_URL/reset" | cut -c1-200
echo
sleep 3

echo "[stack] e2e"
cd "$ROOT/glue-run/glue"
GLUE_URL="$GLUE_URL" BRIDGE_URL="$BRIDGE_URL" E2E_REPORT="${E2E_REPORT:-$RUN/e2e.md}" bun run e2e.ts
code=$?

if [ -n "${STACK_CONTRACT:-}" ]; then
  echo "[stack] contract, live glue"
  CONTRACT_GLUE_URL="$GLUE_URL" bash "$REPO/actor/tests/contract/run.sh" glue-live 2>&1 | tail -12
fi

echo "[stack] logs in $RUN/logs"
grep -E "voted|countered|calibrated|failed|rejected" "$RUN/logs/agents.log" | tail -30 | cut -c1-200
grep -vE '^\s*$' "$RUN/logs/glue.log" | tail -15 | cut -c1-220
exit $code
