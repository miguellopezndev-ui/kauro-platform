#!/bin/bash
# B12 K2 (kit shared contracts): the fast gate, then the WHOLE suite of every touched package, in a clone-run clone (own PG17 via PGBIN).
# Touched: @kauro/domain, @kauro/application, @kauro/persistence, @kauro/api, @kauro/web, tools/*. Stops at the first failing step.
set -euo pipefail
pnpm run verify:fast
node tools/build-generated.mjs
pnpm --filter @kauro/domain run test
pnpm --filter @kauro/application run test
pnpm --filter @kauro/persistence run test
pnpm --filter @kauro/api run test
pnpm --filter @kauro/web run test
