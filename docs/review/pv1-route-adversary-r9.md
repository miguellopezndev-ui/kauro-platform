# PV1 route internal adversary r9 on e4202bd (delta 3e6068e..e4202bd, test+doc only)

Verdict: FAIL (1 MAJOR, family time: the r7 299 s control is intermittently red, 2 of 10 runs on Windows).
r8 ADV-1 itself is closed: the mutation proof reproduces.

## Mutation proof redone (r8 ADV-1)
- web-sessions.ts:294 `const issuedMs = Math.min(authMs, atMs);` -> `const issuedMs = atMs;`, persistence rebuilt, only `--test-name-pattern="C r7"` of
  dist/test/ach-route-cells.test.js: RED, `control: created_at - issued_at is the re-authentication's age at the recording instant, in [299000, 300000] ms (was 0)`.
- `git checkout -- packages/persistence/src/web-sessions.ts`, rebuilt: green; step-up pattern over ach-route-cells + b11-sessions: 22/22; git status clean.
- The new assertions are real: lower bound is exact (the cell advances the shared movable clock by 299000 after the token is minted, clock = Date.now()+offset),
  upper bound is implied by the store's own STALE judgment (age > 300000 refuses), expires_at - issued_at === 900000 is exact arithmetic.

## ADV-1 (MAJOR, time/evidence): the 299 s control leaves a 1000 ms margin, below the harness latency plus the whole-second truncation of auth_time
Reproduction: from apps/api, `node --test --test-name-pattern="C r7" dist/test/ach-route-cells.test.js` repeated: failures on run 3 of 3 and run 4 of 6
(about 2 in 10; a failing run took 27.9 s against the usual 9.8 s). Failure is the PRE-EXISTING assertion (line 3135, not the new r8 ones):
`control: a re-authentication 299 s old at the post-lock instant is recorded` actual `403 ASSURANCE_REQUIRED STEP_UP_STALE`, expected `201 SUCCESS -`.
Cause: identity-verifier.ts:216 takes auth_time as a whole-second numeric date (up to 999 ms older than the mint instant) and the harness spends real time between
minting the token and the store's post-lock instant (sign-in, holder connection, blockedBehind polling, load); age = 299000 + truncation + harness time must stay
<= 300000, a margin of 1000 ms. The r8 bound [299000, 300000] states that same margin, so it inherits the flake and makes it the evidence. Rule 6 of CLAUDE.md:
an intermittent failure is a defect, never a retry. (The defect predates this delta, introduced with the r7 cell at 3e6068e; the delta makes the margin the
documented acceptance bound.)
acceptance_criterion: the control is deterministic under load: the wait leaves at least 30 s of margin (for example stepUpBlocked(240_000) with the bound
[240000, 300000]) and the 301 s cell stays; 20 consecutive runs of the C r7 cell green; the mutation (issuedMs = atMs) still red with "(was 0)".
failing_test: C r7 DENY ACH-M-R2-EXPIRY ... (apps/api/test/ach-route-cells.test.ts:3132).
scope (family sweep): ach-route-cells.test.ts:3134 (299_000 control, the flake), :3138-:3144 (new bound repeating the 299000 floor/300000 ceiling),
docs/review/pv1-route-codex-r3-fix-proof.md:119-124 (states the 299 s window). Other clock-advance cells checked, none with a margin under 5 s:
:3079 (5 s on a 300 s window), :3090 (31 min vs 30 min idle), :3099 (revoke), :3145 (301 s, stale on either side, cannot flake),
:2326-:2570, :2704-:2712, :2960 (61 s touch interval, due-direction only).
Status OPEN; reviewer_omission false.

## Family-coverage table (scope path -> covering test)
| scope path | covering test | fails without the fix |
|---|---|---|
| web-sessions.ts:294 issuedMs = min(authMs, atMs) | C r7 ... new pin (created_at - issued_at) | yes, "(was 0)" |
| web-sessions.ts:299 expiresAt = issuedMs + freshness | C r7 ... expires_at - issued_at === 900000 | not mutated (not required by r8) |
| web-sessions.ts:~285 age judged after the lock | C r7 301 s cell | yes (r8 revert proof) |
