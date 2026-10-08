# PV1 route internal adversary r10 on 1b5b536 (delta e778df2..1b5b536, test+doc only)

Verdict: PASS (0 findings). Closes r9 ADV-1 (family time: the C r7 299 s control rode a 1000 ms margin).

## Delta
`git diff --stat e778df2 1b5b536`: apps/api/test/ach-route-cells.test.ts (12 lines) and docs/review/pv1-route-codex-r3-fix-proof.md (+7). No src change.
The control advances 240 s (60 s margin), asserts created_at - issued_at in [240000, 300000] ms and expires_at - issued_at === 900000; the 301 s refusal cell is unchanged.

## Checks
- Mutation redone: web-sessions.ts:294 `const issuedMs = Math.min(authMs, atMs);` -> `const issuedMs = atMs;`, persistence rebuilt, `--test-name-pattern="C r7"`:
  RED `control: created_at - issued_at ... in [240000, 300000] ms (was 0)`. Restored with `git checkout -- <file>`, rebuilt: C r7 1/1, b11-sessions 13/13.
- Step-up cells (3 A r6 + C r7, 4 tests) 5 consecutive runs on Windows, 4/4 green each, wall time 38, 40, 35, 35, 36 s (first runs of the session were 78/47 s under load, also green).
- 301 s cannot flake the other way: age at the post-lock instant = 301000 + auth_time truncation (0..999 ms older than the mint) + harness real time (>= 0), all
  non-negative, so it is always > 300000 and refused; the proof-count assertion is exact. The 240 s control: 240000 + <1000 + harness time stays far below 300000
  unless the harness stalls 59 s (the cell itself is bounded by test timeouts well under that).
- Family sweep: other clock-advance cells (5 s on a 300 s window, 31 min vs 30 min idle, revoke, 61 s touch interval) were checked in r9, none with a margin under 5 s;
  the r3-fix-proof r8 section still states 299000 as history and the new r9 section supersedes it explicitly.

## Family-coverage table (scope path -> covering test)
| scope path | covering test | fails without the fix |
|---|---|---|
| ach-route-cells.test.ts:3134 control (240 s) | C r7 DENY ACH-M-R2-EXPIRY | flake removed: 5/5 runs green (builder 20/20) |
| ach-route-cells.test.ts:3138-3144 bound | same cell | yes, "(was 0)" with issuedMs = atMs |
| pv1-route-codex-r3-fix-proof.md r8/r9 sections | doc | n/a (consistent) |
