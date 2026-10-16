#!/usr/bin/env bash
# The capacity campaign, strictly sequential: two heavy loads at once would
# measure the host rather than the engine.
#
# The matrix runs first because it is the leg that has failed before and the
# cheaper one to find out about; a failed matrix ends the campaign rather than
# spending the founding hours on a candidate that will not close. The exit code
# is the campaign's verdict, so a caller that reads it never mistakes a partial
# run for a whole one.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=bench/campaign
mkdir -p "$LOG"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "campaign start $(stamp)" | tee "$LOG/timeline.txt"

echo "matrix start $(stamp)" >> "$LOG/timeline.txt"
node tools/capacity.mjs --profile P1,P2,P3,P4,P5,P6,P7,P8,P9,P10,P11,P12 --rows 1000000 --matrix > "$LOG/matrix.log" 2>&1
M=$?
echo "matrix exit=$M $(stamp)" >> "$LOG/timeline.txt"
if [ "$M" -ne 0 ]; then
  echo "campaign end matrix=$M founding=not-run $(stamp)" >> "$LOG/timeline.txt"
  exit "$M"
fi

echo "founding start $(stamp)" >> "$LOG/timeline.txt"
node tools/capacity.mjs --profile FOUNDING-CLEAN-ONLY-1M,FOUNDING-HUBSPOT-1M,FOUNDING-SALESFORCE-1M --rows 1000000 --founding > "$LOG/founding.log" 2>&1
F=$?
echo "founding exit=$F $(stamp)" >> "$LOG/timeline.txt"
echo "campaign end matrix=$M founding=$F $(stamp)" >> "$LOG/timeline.txt"
exit "$F"
