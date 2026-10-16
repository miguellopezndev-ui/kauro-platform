#!/usr/bin/env bash
# Everything that must be true before the offline universe is launched, as a
# command with exit codes rather than a paragraph somebody has to remember.
#
# The universe checks the candidate manifest and the release provenance as two
# of its nineteen steps, so both have to be current ENTERING it. Four separate
# runs were lost to launching it after a seal or a regeneration had made one of
# them stale; sealing writes campaign.json, which the release provenance vouches
# for, so even sealing invalidates it.
#
# The order is the one in MC3_EXECUTION_STATE.md §10: manifest first, release
# provenance second, because the second hashes the first and the exclusion rule
# keeps the second out of the first.
#
# ---- what the previous version got wrong ----
#
# It piped each gate to grep. A gate that printed "DRIFT-01 = FALSE" and exited 7
# let the pipeline exit 0, because grep had found the text, and the next command
# ran. It staged with `git add -A`, so anything at all in the tree went into the
# commit it made. And it printed the count of uncommitted paths instead of
# asserting it was zero. Every one of those is a way of saying PASS without
# having checked.
set -euo pipefail

cd "$(dirname "$0")/.."

log_dir="${KAURO_PREPARE_LOG_DIR:-bench/campaign/prepare}"
mkdir -p "$log_dir"

# Run one step, keep its whole output, and stop on its exit code — never on what
# it printed.
step() {
  local name="$1"
  shift
  local log="$log_dir/$name.log"
  # The status comes from the command itself, never from the compound statement
  # around it: after an `if` whose branch was not taken, `$?` is already 0
  # whatever the command returned, and `local x=$?` reads the status of `local`.
  # The first draft of this function had exactly that bug; its own negative
  # test reported "exit 0" for a gate that had exited 7.
  local status=0
  "$@" > "$log" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    printf '  ok    %-28s %s\n' "$name" "$log"
    return 0
  fi
  printf '  FAIL  %-28s exit %d, output in %s\n' "$name" "$status" "$log" >&2
  tail -n 12 "$log" >&2 || true
  return "$status"
}

step manifest             node tools/candidate-provenance.mjs
step release-provenance   npm run --silent provenance
step manifest-check       node tools/candidate-provenance.mjs --check
step provenance-check     npm run --silent provenance:check
step drift                node tools/drift-gate.mjs

# Only the files these generators own are staged. Anything else in the tree is
# somebody's uncommitted work and is not this script's to commit.
generated=(
  qualification/candidate/manifest.json
  qualification/candidate/provenance.json
  migration-core-provenance.json
  docs/release/MIGRATION_CORE_PROVENANCE.md
)
git add -- "${generated[@]}"
if ! git diff --cached --quiet; then
  # The identity is whatever git is configured with. A name written into this
  # script would attribute every regeneration to one person regardless of who
  # ran it.
  git commit -q -m "records: regenerated in dependency order before the universe"
  printf '  committed regenerated records\n'
fi

# Asserted, not printed. A dirty tree here means something other than the
# generators changed, and the universe's sabotage step will refuse it anyway —
# better to say so now than fifty minutes in.
dirty="$(git status --porcelain | wc -l | tr -d ' ')"
if [ "$dirty" != "0" ]; then
  printf '  FAIL  the tree has %s uncommitted path(s):\n' "$dirty" >&2
  git status --porcelain >&2
  exit 3
fi

step seal-check node tools/seal-campaign.mjs --check
printf 'READY: manifest, provenance, drift and seal all hold; tree clean\n'
