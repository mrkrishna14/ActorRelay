#!/usr/bin/env bash
# One line per service, then the latest proposals per plant.
set -uo pipefail
rid() { uuidgen | tr 'A-Z' 'a-z'; }
line() { printf '%-10s %-6s %-5s %s\n' "$1" "$2" "$3" "$4"; }
line SERVICE PORT STATE DETAIL

if curl -s -m 2 -X POST http://127.0.0.1:7100/v1/projects/local/actors/Company/company/invoke -H 'content-type: application/json' -d "{\"requestId\":\"$(rid)\",\"method\":\"read\",\"args\":[]}" | grep -q '"completed"'; then line actors 7100 up "local Terse runtime (project local)"; else line actors 7100 DOWN "start: cd actor && terse actor dev"; fi

snap=$(curl -s -m 2 "http://127.0.0.1:7300/snapshot?plantId=plant-a")
SIM_PY='import json,sys
d=json.load(sys.stdin); p=d["plant-a/P-100"]["speedPct"]; v=d["plant-a/LV-101"]["positionPct"]; h=d["plant-a/TV-101"].get("headerBarg", 0)
print("plant-a P-100 %.0f%%  LV-101 %.1f%%  header %.2f barg" % (p, v, h))'
detail=$(printf '%s' "$snap" | python3 -c "$SIM_PY" 2>/dev/null)
if [ -n "$snap" ]; then line sim 7300 up "$detail"; else line sim 7300 DOWN "start: bridge/.venv/bin/python bridge/live_sim.py"; fi

h=$(curl -s -m 2 http://127.0.0.1:7200/health)
GLUE_PY='import json,sys
d=json.load(sys.stdin); i=d.get("integrations") or dict()
print("mode %s  actors %s  relay %s  simulation %s" % (d.get("mode"), i.get("actors"), i.get("relay"), i.get("simulation")))'
detail=$(printf '%s' "$h" | python3 -c "$GLUE_PY" 2>/dev/null)
if [ -n "$h" ]; then line glue 7200 up "$detail"; else line glue 7200 DOWN "start: cd glue && GLUE_MODE=live ... bun run start"; fi

a=$(curl -s -m 2 http://127.0.0.1:7201/health)
AG_PY='import json,sys
d=json.load(sys.stdin)
print("%s agents  backend %s  relay %s" % (d.get("agents"), d.get("backend"), d.get("relay")))'
detail=$(printf '%s' "$a" | python3 -c "$AG_PY" 2>/dev/null)
if [ -n "$a" ]; then line agents 7201 up "$detail"; else line agents 7201 DOWN "start: cd agent && GLUE_URL=http://127.0.0.1:7200 bun src/spawn.ts"; fi

code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/)
if [ "$code" = "200" ]; then line web 3000 up "http://127.0.0.1:3000"; else line web 3000 DOWN "start: cd web && bun run dev"; fi

PROPS_PY='import json,sys
p=sys.argv[1]
d=json.load(sys.stdin); props=(d.get("plant") or dict()).get("proposals") or []
props=props[-3:]
print(p + ": " + ("no proposals" if not props else "   ".join("%s %g→%g %s" % (x["id"], x["from"], x["to"], x["status"]) for x in props)))'
if [ -n "$h" ]; then
  echo
  for p in plant-a plant-b; do
    curl -s -m 5 "http://127.0.0.1:7200/state?plantId=$p" | python3 -c "$PROPS_PY" "$p" 2>/dev/null
  done
fi
