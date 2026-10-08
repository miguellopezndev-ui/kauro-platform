# PV1 L-ROUTE internal adversary, round 3 (VERIFY of the Codex r2 fix), candidate edccbba

Delta reviewed: 5bac4cf..edccbba. Family: TIME-AFTER-AWAIT. Verdict: FAIL (1 MAJOR, 2 MINOR). Findings JSON (Codex schema):
`.kauro/reviews/pv1-route-r3-edccbba-adversary.json` (receipt kind adversary, FAIL, bound to edccbba).

## Per finding of Codex r2

| Finding | Verdict | Evidence |
|---|---|---|
| PV1R-02 | FIXED | service.ts:203-206 judges after the store returns; web-sessions.ts:139 reads the instant after acquire and bind; getBankRoute and I3 cells red 200 -> 401 without it (builder proof). |
| PV1R-03 | FIXED | `assuredAt` (route-config.ts:207-217): proof read, then effect clock, then details and `freshUntil` judged with no await; same helper in body and pre-commit for verify, enable, disable, replace-details. Re-done revert below. |
| PV1R-06 | FIXED | instructions.ts:324-343: final authentication, effectNow, judgments, view, no await between. Details-only crossing is unreachable (issuance caps the deadline at the details validity; CHECK minimum_transfer_window_ms > 0). |
| Sweep I1/I2 | FIXED | instructions.ts:132-170: facts, source deadline, then effect; blockers, details and window at it; details and minimum window re-judged in beforeCommitOf. |

## Re-done revert (PV1R-03), Windows, tsc build

Files copied from 5bac4cf over the working copy: `route-config.ts`, `authorization/src/assurance.ts`, `ports/assurance-and-admission.ts`; packages rebuilt;
`node --test --test-name-pattern="PV1R-03 DENY ACH-M-R[12]-EXPIRY \(.*final proof read" dist/test/ach-route-cells.test.js`:
0 pass / 6 fail. First assertion (all six): `<cmd>: a proof expired during its final read refuses the effect` actual `200 SUCCESS -`, expected
`403 ASSURANCE_REQUIRED STEP_UP_STALE` (verify, enable, disable, replace-details); `<cmd>: details expired during the final proof read refuse the effect`
actual `200 SUCCESS -`, expected `409 PRECONDITION_FAILED DETAILS_EXPIRED` (verify, enable). Restored with `git checkout -- <files>`, rebuilt, 6/6 pass, `git status` clean.

Second probe (ADV-1): deleting instructions.ts:342 (the session `liveUntil` judgment) alone: 15/15 session and expiry cells still pass. Restored, clean.

## Clock-sample sites (no await between the sample and the judgment or effect)

| Site | Result |
|---|---|
| route-config.ts:211 verifier argument (pre-read sample S1) | OK: only the verifier input; the caller re-judges at S2 |
| route-config.ts:212-216 `at` then details validity, outcome, `freshUntil` | OK, sync; undefined or unparsable `freshUntil` refuses (fail closed) |
| route-config.ts verify body :341, enable :379/:383, disable :422, replace :453, `judgedAtCommit` :227 | OK (same helper); pre-commit runs last before COMMIT |
| instructions.ts:132 probe instant | OK as probe only; revision and capacity stay judged at it (ADV-3, mitigated by window) |
| instructions.ts:134-170 effect, blockers, details, window, beforeCommitOf :161-166 | OK; COMMIT-time re-judgment |
| instructions.ts:336-342 I3 effect, deadlines, details, session `liveUntil` | OK, sync; the :342 judgment is untested (ADV-1) |
| service.ts:203/206, web-sessions.ts:139 | OK |
| sessions.ts:95-99, bank-route-routes.ts:156-159 | OK (carry `liveUntil`, no judgment) |
| bank-route-routes.ts:105 `receivedAt` | OK (journal stamp) |
| service.ts:168/219/241, authorizer.ts:69, authorization/authorizer.ts:134, close-agency.ts:69, activate-seller.ts:49, approve-payout.ts:65/:94 | Outside the delta; pre-await samples (ADV-2 asks for the full list) |

## `freshUntil` and other callers

`freshUntil` is optional and additive; only `assuredAt` reads it and an absent or NaN value refuses (STEP_UP_STALE). Window arithmetic matches the verifier
(`now - issued > window` stale, so fresh until issued + window + 1 ms; `now >= expires` stale). authorizer.ts:69, checkout.ts and web-sessions `revoke(at)` are
not in the diff; the B05/B09/B11 hunks are additive or signature-only (`resume` takes a supplier). No fail-open found.

## Family-coverage table (scope path -> covering test; becomes evidence.md of the Codex verification)

| Scope path | Covering test (fails without the fix) |
|---|---|
| route-config.ts `assuredAt` + 4 command sites + `judgedAtCommit` | PV1R-03 ACH-M-R2-EXPIRY x4 (final proof read) and ACH-M-R1-EXPIRY x2: re-done revert 0/6 |
| authorization/src/assurance.ts:28-30 `freshUntil`, ports/assurance-and-admission.ts | same 6 cells (fix C reverted together) |
| service.ts:203-206, web-sessions.ts:139, ports/sessions.ts:91 | PV1R-02 ACH-M-R2-EXPIRY (getBankRoute) per builder proof (not re-run) |
| instructions.ts:324-341 (PV1R-06 order) | PV1R-06 ACH-M-I3-EXPIRY x2 per builder proof (not re-run) |
| instructions.ts:161-166 (I2 before COMMIT) | TAA-SWEEP ACH-M-I2-EXPIRY per builder proof (not re-run) |
| instructions.ts:132-134 (I1/I2 read order) | none of its own (ADV-3, MINOR) |
| instructions.ts:334/342, sessions.ts:96-99, authenticator.ts:45, bank-route-routes.ts:156-159 (`liveUntil`) | NONE: ADV-1 (MAJOR) |

## Linux evidence

tools/ci-local/logs/pv1-route-edccbbaebcb4b01f50e1b078b175ec92b1062fa6-linux.log: exit 0; matrix check ok; migrations 8/8; persistence 30/30; api focused 42/42;
ach-route-cells 90/90.

## Findings

- ADV-1 MAJOR (revocation): the I3 `liveUntil` guard has no cell. Needed: hold the `effect_now` statement after the third resume, cross the idle or absolute deadline, assert 401 with no digits; must fail with instructions.ts:342 deleted.
- ADV-2 MINOR (evidence): the sweep names one other step-up caller; list authorization/authorizer.ts:134, close-agency.ts:69, activate-seller.ts:49, approve-payout.ts:65/:94 for the coordinator.
- ADV-3 MINOR (time): the I1/I2 read reorder has no cell; revision and capacity facts remain judged at the probe instant (refused by the window, with TRANSFER_WINDOW_TOO_SHORT).
