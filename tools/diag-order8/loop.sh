#!/usr/bin/env bash
# Runs the ACH-M-P2 cells N times; prints PASS/FAIL per run and the totals. Usage: loop.sh N OUTDIR [extra pattern]
set -u
n=$1; outdir=$2; pattern=${3:-ACH-M-P2-(CRASH-BEFORE|PARTIAL)}
mkdir -p "$outdir"; pass=0; fail=0
for i in $(seq 1 "$n"); do
  if node --test --test-reporter=spec --test-name-pattern="$pattern" dist/test/ach-inbound-cells.test.js > "$outdir/run-$i.log" 2>&1; then pass=$((pass+1)); echo "run $i PASS"; else fail=$((fail+1)); echo "run $i FAIL"; grep -h "✖ RACE\|0n !==" "$outdir/run-$i.log" | head -4; fi
done
echo "TOTAL pass=$pass fail=$fail of $n"
