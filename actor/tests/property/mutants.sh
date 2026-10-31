#!/usr/bin/env bash
# Shows the suites catch real bugs: each mutant injects one known bug into the spec
# reference, and at least one property must fail. A surviving mutant is a test gap.
cd "$(dirname "$0")" || exit 1
BUN="${BUN:-bun}"
runs="${PROP_RUNS:-400}"
mutants="
similar-no-metric-filter similar.test
similar-zero-range-nan similar.test
similar-weight-one similar.test
similar-mutates-history similar.test
similar-furthest-first similar.test
similar-k-plus-one similar.test
status-strict-critical status.test
status-strict-max status.test
calibration-keep-51 calibration.test
calibration-partial-window calibration.test
calibration-rise-inclusive calibration.test
calibration-fall-inclusive calibration.test
calibration-no-cap calibration.test
calibration-no-floor calibration.test
voters-directed voters.test
voters-include-proposer voters.test
vote-allow-late lifecycle.test
vote-allow-stranger votes.test
vote-last-wins votes.test
vote-allow-duplicate votes.test
sweep-proposer-only lifecycle.test
sweep-expiry-beats-no lifecycle.test
sweep-ignores-no lifecycle.test
sweep-no-veto-guard lifecycle.test
sweep-veto-9s lifecycle.test
veto-any-status lifecycle.test
execute-early lifecycle.test
rule-counts-safe rules.test
rule-fires-on-second rules.test
rule-no-dedupe rules.test
rule-fake-support rules.test
rule-promotes-any-model rules.test
rule-company-no-dedupe rules.test
"
actor_mutants="
similar-no-drop similar.test
similar-live-not-first similar.test
calibration-no-reset calibration.test
"
killed=0; survived=0
while read -r mutant file; do
  [ -z "$mutant" ] && continue
  if PROP_TARGET=reference PROP_MUTANT="$mutant" PROP_RUNS="$runs" "$BUN" test --timeout 120000 "./$file" >/dev/null 2>&1; then
    echo "SURVIVED $mutant ($file)"; survived=$((survived+1))
  else
    echo "killed   $mutant"; killed=$((killed+1))
  fi
done <<< "$mutants"
while read -r mutant file; do
  [ -z "$mutant" ] && continue
  if PROP_TARGET=reference PROP_TRAITS=actors PROP_MUTANT="$mutant" PROP_RUNS="$runs" "$BUN" test --timeout 120000 "./$file" >/dev/null 2>&1; then
    echo "SURVIVED $mutant ($file, actor traits)"; survived=$((survived+1))
  else
    echo "killed   $mutant (actor traits)"; killed=$((killed+1))
  fi
done <<< "$actor_mutants"
echo "mutants killed $killed, survived $survived"
[ "$survived" -eq 0 ]
