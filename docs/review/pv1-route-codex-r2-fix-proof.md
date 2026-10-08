# PV1 L-ROUTE Codex r2 fix: revert proof per finding (TIME-AFTER-AWAIT family)

Codex VERIFY r2 on 5bac4cf: REJECT (docs/review/pv1-route-codex-r2.json). Open: PV1R-02 (partial), PV1R-03 (partial), PV1R-06 (new).
All three are one family: a time judgment used an instant sampled BEFORE an await it was judged after. Second round of the family, so
the fix is one root rule (FAILURE-MATRIX-TEMPLATE rule 15, TIME-AFTER-AWAIT) applied everywhere in the lane, plus a sweep.

Tests commit: c55a48b (11 new cells, no src change). Fix commits: 53f6940 (session resume), 2c2bf59 (I3 order + I2 sweep),
2001f2f (step-up/details after the proof read).

Method (Windows, tsc build): red run with every r2 src file at its 5bac4cf content (tagged stash `r2-all-revert2`), then, per fix commit,
its src diff reverse-applied on the fixed head, packages rebuilt, the finding's cells run, the reversal removed by a tagged stash
(`r2-revert-A/B/C`) dropped by name, rebuilt. Tests unedited between runs.

## Red on 5bac4cf src (all fixes reverted): 0 pass / 11 fail

| Cell | First failing assertion (actual -> expected) |
|---|---|
| PV1R-02 getBankRoute, cookie resume held | `idle: the held request is answered like the next one` 200 SUCCESS -> 401 AUTHENTICATION_REQUIRED |
| PV1R-02 I3, final authentication held (live/idle/absolute) | `idle: the held read is refused like the next request` 200 SUCCESS -> 401 AUTHENTICATION_REQUIRED |
| PV1R-06 I3 instruction deadline | `the deadline crossed during the final authentication hides the instructions` 200 -> 409 INSTRUCTIONS_EXPIRED |
| PV1R-06 I3 details validity | `details expired during the final authentication hide the instructions` 200 -> 409 INSTRUCTIONS_NOT_AVAILABLE |
| PV1R-03 final proof read x4 (verify, enable, disable, replace-details) | `<cmd>: a proof expired during its final read refuses the effect` 200 -> 403 ASSURANCE_REQUIRED STEP_UP_STALE |
| PV1R-03 details during final proof read x2 (verify, enable) | `<cmd>: details expired during the final proof read refuse the effect` 200 -> 409 DETAILS_EXPIRED |
| TAA-SWEEP I2 window before COMMIT | `the window crossed before COMMIT refuses the issuance` 201 -> 409 TRANSFER_WINDOW_TOO_SHORT |

## Per fix (reverted alone on the fixed head)

| Fix | Reverted | Result | Note |
|---|---|---|---|
| A 53f6940 resume | service.ts, web-sessions.ts, ports/sessions.ts | getBankRoute cell FAIL (200 -> 401); I3 PV1R-02 cell pass | I3's own session judgment (B) still refuses: two independent guards; both reverted = red (table above) |
| B 2c2bf59 I3/I2 | instructions.ts, apps/api sessions.ts, authenticator.ts, bank-route-routes.ts | PV1R-06 x2 FAIL, TAA-SWEEP FAIL; PV1R-02 cells pass | resume fix (A) still refuses the session |
| C 2001f2f step-up | route-config.ts, authorization assurance.ts, ports/assurance-and-admission.ts | PV1R-03 r2 0 pass / 6 fail | 200 -> STEP_UP_STALE / DETAILS_EXPIRED |
| all | A+B+C | 0 / 11 | above |

With every fix: 11/11; ach-route-cells 90/90.

## How each fix meets its scope

- PV1R-02: `SessionService.resume` judges liveness at `deps.clock.now()` read after `store.resume` returned; the store takes `now` as a
  supplier read immediately before its touch statement (after pool acquisition, BEGIN and binding), so a wait for the connection never
  touches or admits an expired session (web-sessions.ts:91/:135, service.ts:202). The cookie authentication (sessions.ts:95) also returns
  the session's own end (`liveUntil` = min(idle, absolute) as resumed) and I3 judges it on the same process clock after its last await.
- PV1R-06: I3 order is final authentication -> effect clock -> details validity, instruction deadline, evidence, session `liveUntil` ->
  view built with no await in between (instructions.ts). Expiry during the auth wait answers INSTRUCTIONS_EXPIRED /
  INSTRUCTIONS_NOT_AVAILABLE with no digits and no reference, with a live session. Details-only crossing with a later deadline is not
  reachable: issuance caps transferExpiresAt at the details validity (D-ACH-04); the cell crosses the shared boundary and gets the details
  answer, which I3 judges first.
- PV1R-03: `assuredAt` (route-config.ts) reads the proof (verifier I/O) first, THEN the effect clock, then judges details validity and the
  proof's `freshUntil` (new optional field of FRESH, assurance.ts: min(issued + window + 1 ms, expiry), same window) with no await after;
  verify/enable/disable/replace-details use it in the body and in the pre-commit check, so nothing awaits between the final judgment and
  COMMIT except the other registered checks (none). A verifier without `freshUntil` is refused (fail closed).

## Sweep (grep effectNow / clock.now() / Date.now() followed by an await before the comparison)

| Place | Shape found | Action |
|---|---|---|
| instructions.ts I1/I2 issuance | effect sampled before checkoutFactsOf / sourceDeadlineMs reads, then judged | Fixed: facts at a probe, source deadline read, THEN effect; blockers/details/window at it; details + minimum window judged again before COMMIT. Cell TAA-SWEEP (red 201 without) |
| instructions.ts I3 | PV1R-02/06 | Fixed |
| route-config.ts verify/enable/disable/replace (bodies + pre-commit) | PV1R-03 | Fixed (assuredAt) |
| route-config.ts configure | no time judgment (no step-up; validity judged at verify) | none |
| bank-routes.ts (persistence) | no SQL predicate on an app-supplied instant; writes only | none |
| bank-route-routes.ts | `receivedAt` journal stamp, no judgment | none |
| commerce/core/authorizer.ts:69 `assureOperator` (B09, accepted, not used by the bank commands) | samples clock before verifyStepUp's proof read | GAP, outside lane: report to coordinator (B09 owners) |
| web-sessions.ts `revoke(at)` (B11) | `at` sampled before acquire | Not changed: logout of a session that expired during the wait reports REVOKED instead of ENDED; no disclosure, no admission |
| checkout.ts revisionForCheckout / capacityForCheckout (B09 shared) | judge at the caller's instant after their own read | In I2 superseded by the window (which includes the source deadline) judged after all reads and at COMMIT; provider path untouched: GAP listed for B09 |

## Adversary r3 on edccbba: ADV-1 (MAJOR) and ADV-3 (MINOR) closed with tests (no product change)

Cells (apps/api/test/ach-route-cells.test.ts), fails on edccbba-with-the-guard-removed, passes on 164a809 + these tests; Windows 94/94 (90 + 4).

| Finding | Cell title (prefix) | Revert | Failing assertion |
|---|---|---|---|
| ADV-1 | `ADV-1 DENY ACH-M-I3-REVOCATION (session idle deadline passes after the effect-clock read)` | delete instructions.ts:342 (`sessionLiveUntil` judgment) | `idle: a session that ended between the effect-clock read and the view gets the authentication refusal` actual `200 SUCCESS -` expected `401 AUTHENTICATION_REQUIRED -` |
| ADV-1 | `ADV-1 DENY ACH-M-I3-REVOCATION (session absolute deadline passes after the effect-clock read)` | same | `absolute: a session that ended between ...` actual `200 SUCCESS -` expected `401 AUTHENTICATION_REQUIRED -` |
| ADV-3 | `ADV-3 DENY ACH-M-I1-EXPIRY (price deadline crossed between the probe read and the effect read)` | instructions.ts:132-134 restored to the 5bac4cf order (effect, then facts, then source deadline) | `the price deadline crossed between the probe and the effect read refuses the issuance` actual `409 PRECONDITION_FAILED TRANSFER_WINDOW_TOO_SHORT` expected `409 PRECONDITION_FAILED QUOTE_EXPIRED` |
| ADV-3 | `ADV-3 DENY ACH-M-I1-EXPIRY (source deadline crossed between the probe read and the effect read)` | same | stays green on the 5bac4cf order: both orders refuse `TRANSFER_WINDOW_TOO_SHORT` (body vs the COMMIT-time re-judgment); documents the code, not a revert proof |

How the ADV-1 hold works: the `kauro.effect_now()` statement of the I3 read is held after the THIRD resume (the final authentication) answered with the session live;
the process clock moves past the idle deadline (31 min) or the absolute deadline (session kept in use until about 10 min from its absolute deadline, then +11 min);
released. SessionService.resume cannot refuse it any more (it already answered), so only the `liveUntil` judgment does. Controls (non-zero fixtures): same hold with
+1 s serves 200 with the account digits, routing number and reference; the next request after the deadline is 401.

How the ADV-3 hold works: the first effect-instant read (the probe, step clock) of the issuance is held at source deadline - 5 ms, the clock moves to price expiry + 1 ms
(source cell: source deadline + 1 ms), released. The design (ACH-ROUTE I1/I2 EXPIRY, I2Δ) names no code for a crossing between two reads: the price expiry is the checkout
blocker QUOTE_EXPIRED judged at the effect read (probe-time facts would have passed), the source deadline and the window are TRANSFER_WINDOW_TOO_SHORT (I2Δ). The price
expiry cannot be isolated from the source deadline (the fixture's source precedes the price), hence the probe before the source deadline. Controls: the same hold 10 s short
of the source deadline issues (201, one order, one instruction snapshot, accepted quote, 2 events). Reverts were made by hand-editing the file and `git checkout -- <file>`,
the package rebuilt each time; the tree was clean after each.
