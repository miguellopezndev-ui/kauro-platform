#!/usr/bin/env bash
# Proof that bench/prepare-universe.sh stops on a failed gate.
#
# The function under test is read out of the launcher itself, not copied here:
# a copy would prove the copy. Each case is a command with a known exit code,
# some of them printing the text a passing gate prints, and the launcher must
# exit with that code and never reach the line after the failed step. The two
# exit-0 cases are there to show the wrapper still lets a passing step through.
#
# The first draft of step() captured `$?` after an `if` statement and reported
# exit 0 for a gate that had exited 7. This file is what found it.
set -euo pipefail

cd "$(dirname "$0")/.."

launcher="bench/prepare-universe.sh"
step_source="$(sed -n '/^step() {/,/^}/p' "$launcher")"
if [ -z "$step_source" ]; then
  printf 'no step() function in %s\n' "$launcher" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
run_case() {
  local name="$1" body="$2" expected="$3"
  local cmd="$work/$name.sh"
  printf '#!/usr/bin/env bash\n%s\n' "$body" > "$cmd"
  local out status continued
  set +e
  out="$(bash -c "set -euo pipefail; log_dir='$work'; $step_source; step $name bash '$cmd'; echo REACHED_THE_NEXT_STEP" 2>&1)"
  status=$?
  set -e
  continued=$(printf '%s' "$out" | grep -c REACHED_THE_NEXT_STEP || true)
  local want_continue=0
  [ "$expected" -eq 0 ] && want_continue=1
  if [ "$status" -eq "$expected" ] && [ "$continued" -eq "$want_continue" ]; then
    printf '  ok    %-24s exit %-3s continued=%s\n' "$name" "$status" "$continued"
  else
    printf '  FALSE %-24s exit %-3s (expected %s) continued=%s (expected %s)\n' "$name" "$status" "$expected" "$continued" "$want_continue" >&2
    failures=$((failures + 1))
  fi
}

# A gate that prints what a passing gate prints and exits non-zero is the case
# the previous launcher got wrong.
run_case pass-text-exit-7   'printf "DRIFT-01 = PASS over 12 rules\n"; exit 7' 7
run_case silent-exit-1      'exit 1' 1
run_case partial-json-exit-2 'printf "{\"verdict\":"; exit 2' 2
run_case missing-command    'exec /nonexistent/gate' 127
run_case killed-by-sigterm  'kill -TERM $$' 143
run_case clean-exit-0       'printf "ok\n"; exit 0' 0
# Text is not the contract. A gate that says FALSE and exits 0 is a broken gate,
# and the launcher is not where that gets caught; every gate it runs exits
# non-zero on its own FALSE, which tools/evidence-selftest.mjs proves per rule.
run_case false-text-exit-0  'printf "DRIFT-01 = FALSE\n"; exit 0' 0

if [ "$failures" -ne 0 ]; then
  printf 'LAUNCHER-STOPS-01 = FALSE (%d case(s))\n' "$failures" >&2
  exit 1
fi
printf 'LAUNCHER-STOPS-01 = PASS over 7 cases\n'
