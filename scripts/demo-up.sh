#!/usr/bin/env bash
# Start the full ActorRelay demo stack, in order, skipping anything already running.
#   scripts/demo-up.sh            start everything, reset the demo, print status
#   scripts/demo-up.sh --check    only report what is up / would be started
#   scripts/demo-up.sh --no-reset start without resetting the demo state
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.runtime/logs"
mkdir -p "$LOGS"
CHECK=0; RESET=1
for a in "$@"; do case "$a" in --check) CHECK=1;; --no-reset) RESET=0;; esac; done

rid() { uuidgen | tr 'A-Z' 'a-z'; }
actors_up() { curl -s -m 2 -X POST http://127.0.0.1:7100/v1/projects/local/actors/Company/company/invoke -H 'content-type: application/json' -d "{\"requestId\":\"$(rid)\",\"method\":\"read\",\"args\":[]}" | grep -q '"outcome"'; }
sim_up()    { curl -s -m 2 "http://127.0.0.1:7300/snapshot?plantId=plant-a" | grep -q 'P-100'; }
glue_up()   { curl -s -m 2 http://127.0.0.1:7200/health | grep -q '"mode":"live"'; }
agents_up() { curl -s -m 2 http://127.0.0.1:7201/health | grep -q '"ok":true'; }
web_up()    { curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ | grep -q '^200$'; }

wait_for() { # name check timeout_s
  local name=$1 check=$2 timeout=$3 t=0
  while ! $check; do
    sleep 1; t=$((t + 1))
    if [ $t -ge "$timeout" ]; then echo "FAILED: $name not ready after ${timeout}s — see $LOGS/$name.log" >&2; tail -20 "$LOGS/$name.log" >&2 2>/dev/null; exit 1; fi
  done
  echo "  $name ready (${t}s)"
}

start() { # name check timeout dir cmd...
  local name=$1 check=$2 timeout=$3 dir=$4; shift 4
  if $check; then echo "  $name already running — skipped"; return; fi
  if [ $CHECK = 1 ]; then echo "  $name DOWN — would start: (cd $dir && $*)"; return; fi
  echo "  starting $name → $LOGS/$name.log"
  (cd "$dir" && nohup "$@" > "$LOGS/$name.log" 2>&1 &)
  wait_for "$name" "$check" "$timeout"
}

echo "ActorRelay demo-up ($( [ $CHECK = 1 ] && echo check only || echo start ))"

# a. actors (local Terse runtime)
start actors actors_up 90 "$ROOT/actor" terse actor dev

# b. simulator (python venv on first run)
if [ ! -x "$ROOT/bridge/.venv/bin/python" ] && [ $CHECK = 0 ]; then
  echo "  creating bridge/.venv"
  python3 -m venv "$ROOT/bridge/.venv" && "$ROOT/bridge/.venv/bin/pip" install -q -r "$ROOT/bridge/requirements.txt" || { echo "FAILED: bridge venv" >&2; exit 1; }
fi
start sim sim_up 30 "$ROOT" env GLUE_URL=http://127.0.0.1:7200 "$ROOT/bridge/.venv/bin/python" bridge/live_sim.py

# c. glue (live mode). CORS already allows http://127.0.0.1:3000 and http://localhost:3000.
start glue glue_up 30 "$ROOT/glue" env GLUE_MODE=live ACTOR_CLIENT_MODULE="$ROOT/actor/client/port.ts" \
  RELAY_PUBLISH_URL=http://127.0.0.1:7201/publish BRIDGE_PUSHES_MIRROR=1 bun run start

# d. point both Plant actors at glue (execute → /execute-callback)
if [ $CHECK = 0 ]; then
  (cd "$ROOT" && bun -e '
    const port = (await import(process.cwd() + "/actor/client/port.ts")).default
    for (const id of ["plant-a", "plant-b"]) await port.call("Plant", id, "configure", [{ glueUrl: "http://127.0.0.1:7200" }])
    console.log("  plants configured: glueUrl=http://127.0.0.1:7200")
  ') || { echo "FAILED: Plant.configure" >&2; exit 1; }
fi

# e. agents (10 component agents + publish bridge on 7201)
start agents agents_up 30 "$ROOT/agent" env GLUE_URL=http://127.0.0.1:7200 bun src/spawn.ts

# f. dashboard
if ! web_up && [ $CHECK = 0 ]; then (cd "$ROOT/web" && bun install --frozen-lockfile > "$LOGS/web-install.log" 2>&1) || { echo "FAILED: web install — see $LOGS/web-install.log" >&2; exit 1; }; fi
start web web_up 60 "$ROOT/web" bun run dev

# g. reset the demo to the design point
if [ $CHECK = 0 ] && [ $RESET = 1 ]; then
  if curl -s -m 30 -X POST http://127.0.0.1:7200/reset -H 'content-type: application/json' -d '{}' > "$LOGS/reset.json"; then echo "  demo reset"; else echo "WARNING: reset failed — see $LOGS/reset.json" >&2; fi
fi

echo
"$ROOT/scripts/demo-status.sh"
echo
echo "Open http://127.0.0.1:3000   (runbook: DEMO-RUNBOOK.md)"
