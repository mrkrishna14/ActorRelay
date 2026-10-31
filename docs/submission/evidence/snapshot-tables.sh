#!/usr/bin/env bash
# E2E tables are overwritten by every run. This keeps a dated copy of each one, so a cited result stays checkable.
cd "/c/Users/zubai/Haunted Hacks/Factoryio" || exit 1
OUT=docs/submission/evidence
declare -A seen
while [ "$(date +%H%M)" -lt 1550 ]; do
  for f in actor/tests/e2e/last-run-*.md glue/tests/*last-run*.md; do
    [ -f "$f" ] || continue
    stamp=$(grep -m1 -oE 'Generated [0-9T:.Z-]+' "$f" | cut -d' ' -f2)
    [ -n "$stamp" ] || continue
    key="$f|$stamp"
    [ -n "${seen[$key]}" ] && continue
    seen[$key]=1
    name="$(date -d "$stamp" +%H%M%S 2>/dev/null || echo "$stamp" | tr -d ':.-')-$(basename "$f")"
    [ -f "$OUT/$name" ] || cp "$f" "$OUT/$name"
  done
  sleep 20
done
