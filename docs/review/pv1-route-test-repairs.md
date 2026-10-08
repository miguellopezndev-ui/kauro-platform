# PV1 L-ROUTE: test repairs, round 4 (apps/api/test/ach-route-cells.test.ts)

Candidate product code (7a8f272, ddc2131, 86de0c7) unchanged. Each repair below fixes how the cell uses the harness or its fixture.
No expected outcome code, state or count changed. Design rows: docs/design/ACH-ROUTE.md r12 §7.1-§7.3 (ACH-M-R1/R2/I1/I2/I3).
Local Windows run on 86de0c7 plus this patch: 42/45 pass. bank-route-migrations: 3/3 pass.

| Cell title | Defect | Change | Why it is not a weakening |
|---|---|---|---|
| `RACE ACH-M-R1-TIMEOUT (time): Read and classify owner-supplied account-details evidence` | The clock moved before the product started its timer (`timer.start` runs inside the verify after it is dispatched), so the bound never elapsed and the cell hung. | The store hook signals when the read is reached. That happens after `timer.start` (route-config.ts readRouteDetails). The clock advances only after the signal. | The deadline, its crossing and the expected `503 CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE` plus the unqualified route are unchanged. The bound now actually fires. |
| `RACE ACH-M-I3-TIMEOUT (time): Read sensitive transfer instructions` | Same as R1-TIMEOUT. | Same fix: wait for the artifact read to start, then advance. | The expected `503 ... EVIDENCE_UNAVAILABLE` with no account digits is unchanged. |
| `RACE ACH-M-R2-TIMEOUT (time): Configure, verify, enable or disable a bank-transfer route` | The bound is the database's `statement_timeout` (SQLSTATE 57014), not a controlled-clock deadline. Run as fault `timeout`, the cell could never satisfy `ctx.deadline`. | The cell uses the kit's lock-timeout form: harness fault `race` (b10-cells-support.ts `kindOf`: lock-timeout -> race; CLOSE_TMO in b10-failure-cells-close2). The enable runs through `ctx.mustWait` on the holder's pid and is observed waiting. Its reply settles while the holder still holds the lock, so the timeout fired. | Design row: "lock/COMMIT timeout then read version with same key". Every assertion is unchanged (503/500, VERIFIED with 1 version, journal not COMMITTED, same-key recovery ENABLED with 3 events). The harness now also proves the wait. |
| `RACE ACH-M-I1-TIMEOUT (time): Read checkout readiness under the subject locks` | Same as R2-TIMEOUT (quote lock, statement timeout). | Same lock-timeout form. | The expected `503 CAPACITY_UNAVAILABLE -` and NOTHING_ISSUED are unchanged. Design: "delay capacity/read statement past bound". |
| `RACE ACH-M-I2-TIMEOUT (time): Issue transfer instructions` | Same as R2-TIMEOUT (route lock). | Same lock-timeout form. | The >=500 reply, NOTHING_ISSUED, same-key recovery and replayed reference with 1 order and 1 instruction are unchanged. Design: "statement ... timeout". |
| `RACE ACH-M-R2-PARTIAL (partial): Configure, verify, enable or disable a bank-transfer route` | The steps were listed out of the command's real order. `route_update` is the first write of enable (route-config.ts: update, appendParticipants, publish, journal), so failing it is not partial. | The steps are now listed in the real order, and the cell iterates `steps.slice(1)`, the same form as the I2-PARTIAL cell that already passes. | Design: "fail second/later config/journal/assurance/event/outbox writes". Each later write (participants, event, outbox, journal) still asserts the full footprint (VERIFIED/null/1/1/2, no participant, journal not COMMITTED) and the same-key ENABLED. |
| `RACE ACH-M-I3-PARTIAL (partial): Read sensitive transfer instructions` | The crash was armed at `db.guard.after`. A step's own `.after` is not an earlier completed step. Also, the `SimulatedCrash` thrown by hand was not a recorded point. | The steps are now `snapshot` (bank_transfer_instructions) and `guard` (bank_routes), both of which answer before the store read. The crash is armed at `details-store.decrypt`, passed from the store hook through `ctx.points.pass`. | Design: "fail artifact decrypt ...; inspect response". The expected 500, no account digits and no reference fragment are unchanged. Comment corrected: in the product the artifact read precedes authorization (instructions.ts). |
| `RACE ACH-M-R1-PARTIAL (partial): Read and classify owner-supplied account-details evidence` | The incomplete-details fixture (routingNumber null) is refused up front as malformed evidence. That is a DENY with no commit, so the crash at `uow.before-commit` was never reached. | Per packet item 4, the replacement details are complete and valid. Step `version_read` (bank_route_versions) answers first. The crash `details-read.parse` fires at the details read. | The assertions are unchanged (PENDING_VERIFICATION, current_version 2, no verified_at). Note for the coordinator: the design injection is "after account number read". The classifier is a frozen contract fake (`Object.freeze`), so there is no seam inside the parse, and the failure is injected at the read of the artifact. The up-front refusal of incomplete details is not asserted here. |
| `RACE ACH-M-I1-RACE (concurrency): Read checkout readiness under the subject locks` | `issuedFootprint` counted quotes in state `'ACCEPTED'`, which is not a quote state (0014 CHECK: ACCEPTED_FOR_CHECKOUT). | `'ACCEPTED_FOR_CHECKOUT'`. | The expected count 1 is unchanged. Every NOTHING_ISSUED assertion in the file becomes stronger (before, it was trivially 0). |
| `RACE ACH-M-I1-RETRY (retry): Read checkout readiness under the subject locks` | Same as I1-RACE. | Same. | Same. |
| `RACE ACH-M-I2-RACE (concurrency): Issue transfer instructions` | Same as I1-RACE. | Same. | Same. |
| `RACE ACH-M-I2-RETRY (retry): Issue transfer instructions` | Same as I1-RACE. | Same. | Same. |
| `DENY ACH-M-I1-REVOCATION (revocation): Read checkout readiness under the subject locks` | The membership was revoked by a raw superuser UPDATE. KA010: no actor, and no event. | `revokeBilling`: the B06 fixture pattern (pipeline-authorization `moveMembership`, cmd044). The owner's tenant context is set in the holder transaction, the ACTIVE->REVOKED update runs with its version bump, and `membership.revoked.v1` is written via `rawEvent`. It commits while the holder still holds the lock. | The harness use is repaired. **The cell still fails. RULING NEEDED** (below). |
| `DENY ACH-M-I2-REVOCATION (revocation): Issue transfer instructions` | Same as I1-REVOCATION. | Same. | Same. **RULING NEEDED.** |
| `DENY ACH-M-I3-REVOCATION (revocation): Read sensitive transfer instructions` | Same as I1-REVOCATION. The cell used a raw `oracle` UPDATE. | `bw.iw.w.asTenant(agency, revokeBilling)`. | Same. **RULING NEEDED.** |

## RULING NEEDED: the refusal code for a REVOKED billing membership (I1/I2/I3-REVOCATION)

- The cells expect `403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE`. The product answers `404 NOT_FOUND NOT_A_MEMBER`.
- The 404 is the accepted B06 behaviour for a REVOKED membership: apps/api/test/pipeline-authorization.test.ts:220 and :286 (`r9-revoked-first`), and cmd044-create-support-case.test.ts:218 ("a revoked membership").
- Proposed expectation: `404 NOT_FOUND NOT_A_MEMBER` (B06 R8: a former member gets no existence oracle).
- Probe on a temporary dist copy, since restored: with that code, all 3 cells pass, including every later withdrawal (route participant, enabled state, plan approval, details replaced, details artifact).
- Not changed here, because the change is an expectation.

## Coordinator ruling R-1 (EXPECTATION CHANGE): revoked billing membership answers 404 NOT_FOUND NOT_A_MEMBER

- **Ruling.** In I1/I2/I3-REVOCATION, the billing-membership withdrawal now expects `404 NOT_FOUND NOT_A_MEMBER` instead of `403 NOT_AUTHORIZED MEMBERSHIP_NOT_ACTIVE`.
- **This is an expectation change, not a harness repair.** It is listed for Codex.
- **Reason.** This is the accepted B06 behaviour for a revoked membership: a revoked member gets no existence signal. The route cells follow the accepted package.
  - apps/api/test/pipeline-authorization.test.ts:220 (`assert.equal(outcome(w, revoked), "404 NOT_FOUND NOT_A_MEMBER")`)
  - apps/api/test/pipeline-authorization.test.ts:286 (`r9-revoked-first`, expected `404 NOT_FOUND NOT_A_MEMBER`)
  - apps/api/test/cmd044-create-support-case.test.ts:218 ("a revoked membership" -> `404 NOT_FOUND NOT_A_MEMBER`)
- **Unchanged.** Every other withdrawal in these cells keeps its expected code, as do the NOTHING_ISSUED footprints, the next-read refusal and the no-account-digits checks.

## r1 (adversary r1, `docs/review/pv1-route-adversary-r1.md`): harness and expectation changes

Product code unchanged (a50db87). Red and guard evidence: `docs/review/pv1-route-r1-red.md`.

| Cell title | Change | Kind | Why it is not a weakening |
|---|---|---|---|
| `DENY ACH-M-I1-REVOCATION (revocation): Read checkout readiness under the subject locks` | The holder no longer holds the quote row and then revokes. Each withdrawal now holds its OWN lock and commits while the issuance waits on it (`waitBehindWithdrawal`, mustWait on the withdrawal's pid). Membership: the B06 revoke in the holder transaction (membership exclusive half). Plan approval: CMD026 paused before its COMMIT. Participant: the product re-enable with a shorter allowlist (`narrowTo`), replacing the raw `DELETE FROM kauro.bank_route_participants`. Enabled state: a raw route-row UPDATE held by the holder. | Harness: lock-order (ADV-PV1R-1); product path (ADV-PV1R-5) | Under the D-ACH-04/B09 order, the issuance holds the membership/approval shared halves before the quote. Holding the quote and then revoking forms a cycle (40P01) that tests the harness, not the product. Every expected code is unchanged. Added withdrawals: billing identity (`403 NOT_AUTHORIZED IDENTITY_DISABLED`) and target contract (`422 TARGET_STALE -`). |
| `DENY ACH-M-I2-REVOCATION (revocation): Issue transfer instructions` | Same form. Details replaced through the product replaceDetails command (was: raw `current_version + 1` UPDATE). Participant through re-enable (was: raw DELETE). Added billing identity. | Same | Same expected codes (`404 NOT_FOUND NOT_A_MEMBER`, `409 PRECONDITION_FAILED ROUTE_NOT_ENABLED`) and NOTHING_ISSUED. |
| `DENY ACH-M-I2D-EXPIRY (transfer window): Issue transfer instructions with a minimum window` | Deadline = min(price expiry, source availability deadline). It was the price expiry alone. | **EXPECTATION CHANGE** (ADV-PV1R-2) | The fixture's `sourceAvailableUntil` is about 50 min before `expiresAt`, so the old expectation encoded the defect (transferExpiresAt after the source deadline). D-ACH-04: `transferExpiresAt = min(issue + lifetime, price expiry, source availability deadline, ...)`. Red on a50db87. |
| `RACE ACH-M-I1-RACE`, `RACE ACH-M-I1-RETRY` | `events: fp.events` / a re-read count -> `ISSUED_EVENTS` (2). | Strengthening (ADV-PV1R-8) | The old value compared the count with itself. |
| `ACH-02 DENY: ...` | The expired read now runs on a SECOND order whose route stays ENABLED, and asserts `409 PRECONDITION_FAILED INSTRUCTIONS_EXPIRED`. The first order's disabled read is kept. | Strengthening (ADV-PV1R-8) | Before, the disabled route refused first, so the expiry branch was never reached. |
| `RACE ACH-M-I1-TIMEOUT`, `DENY ACH-M-I1-EXPIRY` | Unchanged: they still hold the quote row, but they revoke nothing while holding it. Under the B09 order the issuance takes its shared halves and then waits on the quote: no cycle. | None | n/a |
| (helpers) | `code()` answers `"<status> SUCCESS -"` for a 2xx. Before, `outcome()` threw "not a Problem" inside the helper, which hid what the product answered. `holdAndWait` gains `holderSteps` (the holder pauses at a `db.<label>` point). `Cfg.validUntil` sets the details artifact's validity. | Harness | A success never equals a refusal code string. No expected value changed. |
| `RACE ACH-M-R1-PARTIAL` (repair of round 4) | The incomplete-details case it removed is restored as `ADV-PV1R-4 DENY ACH-M-R1-PARTIAL (incomplete details at verify)`. | Restored case (ADV-PV1R-4) | Template rule 14. |

## r1 coordinator rulings (RR-1..RR-6), applied to tests only

- **Coordinator ruling RR-1 (I2, expired details).** `ADV-PV1R-2 DENY ACH-M-I2-EXPIRY (details validity)` expects exactly `409 PRECONDITION_FAILED DETAILS_EXPIRED`, with nothing written. Citation: ACH-ROUTE.md:368, `transferExpiresAt = min(..., any shorter legal/capability/capacity validity deadline)`; details whose validity has already passed are expired. DETAILS_EXPIRED is in the closed reason set (`packages/domain/src/commerce/failure-reasons.ts`), but it is not in the CMD028 outcome catalogue (`packages/application/src/commerce/outcomes.ts`). The builder adds it there, with a design addendum.
- **Coordinator ruling RR-2 (I3, one code).** For every not-readable reason of an existing, visible order, I3 answers exactly `409 PRECONDITION_FAILED INSTRUCTIONS_NOT_AVAILABLE` with no account digits. The reasons are: the bank order is not AWAITING_TRANSFER (CAPTURED, RECEIVED_REVIEW, or EXPIRED by retirement or deadline), or the details expired. Citation: ACH-02 ("disabled, expired ... reads expose no account details"); D-ACH-05.
  - Applied to `ADV-PV1R-2 DENY ACH-M-I3-EXPIRY (details validity)`, which no longer accepts either of two codes.
  - Applied to `ADV-PV1R-3 DENY ACH-M-I3-REVOCATION (bank order state)`, which no longer accepts any 409; it also asserts no reference fragment.
  - **INSTRUCTIONS_NOT_AVAILABLE is not in the closed reason set.** The builder adds the code to the set, with a design addendum.
  - Unchanged and left to the coordinator: I3-EXPIRY and ACH-02 keep `INSTRUCTIONS_EXPIRED` (snapshot deadline passed on an order still AWAITING_TRANSFER); the disabled-route reads keep `ROUTE_NOT_ENABLED`.
- **Coordinator ruling RR-3 (ADV-5, I3 of a dropped agency).** The answer is exactly the foreign-agency answer, `404 NOT_FOUND -`. This value was observed on a50db87 when a foreign agency's member read another agency's order; the test also asserts it at run time. No existence signal. Citation: ACH-ROUTE.md:81 (CONTROLLED allowlist); ACH-02 ("foreign reads expose no details").
- **Coordinator ruling RR-4 (ADV-6 authorized).** Opt-in `sessions: true` passed through `payment-support.ts`, `statements-support.ts`, `integration-support.ts` and `bank-support.ts`. The change is additive and off by default: no existing world changes.
  - Before/after proof: bank-kit 5/5 -> 5/5; ach-route-cells 50 pass -> the same 50 pass (61 -> 62 tests, the new one is the session cell).
  - New cell: `ADV-PV1R-6 DENY ACH-M-I3-REVOCATION (session)`. It swaps `bw` to a sessions-enabled bank world for the test, then restores `bw` and stops that world.
- **Coordinator ruling RR-5 (dissents accepted).** ADV-7 uses a real-time cell, with no harness change. ADV-1 has no CMD026 or provider-CMD028 cells. ADV-8(4), I2-delta, is GAP as unreachable. All three are recorded in `pv1-route-r1-red.md`.
- **Coordinator ruling RR-6 (ADV-5 note).** The tenant read policy (0046:271) also checks the allowlist version. The narrowing test goes red only when both checks are reverted. Recorded in `pv1-route-r1-red.md` and `pv1-route-touched-B06.md`.

### r1-fix: coordinator repair C-1 (ADV-PV1R-2 DENY ACH-M-I2-EXPIRY, details validity)
Defect: part (2) set `v2 = Date.now() + 5 d` after part (1) had advanced the controlled clock to about +5 d, so its first step
(`v2 - window - 2 ms` = +3 d) moved the clock backwards and the harness threw RangeError before the product was called.
Change: `v2 = Date.now() + 9 d` (window 2 d, so the issuance instant +7 d is after part (1)). Assertions unchanged
(transferExpiresAt = validUntil, sendBy = validUntil - window). Harness-use repair, not a weakening; found by the r1 fix builder.

## r2 (adversary r2, `docs/review/pv1-route-adversary-r2.md`): test changes
RELAXED: 0.
- ADV-PV1R-1 RACE ACH-M-I1-RACE, closure-first branch: `status === 404 || 409` -> exactly `409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE`. STRONGER.
- ADV-PV1R-10 DENY RLS: one bundled SELECT with `hidden()` (denied or all NULL) -> one statement per withheld column (versions.verified_by, versions.created_by, versions.verification_evidence_ref, routes.created_by), each must be 42501, plus a positive check that details_artifact_ref stays readable. STRONGER (re-granting any single column turns its assertion red; proven).
- ADV-PV1R-7 ... R1-EXPIRY: `validUntil = now + 4 s` -> `now + ADV7_SETUP_ALLOWANCE_MS` (20 s named constant; the kit declares no slack constant); the pre-assert now names itself a harness precondition. The product assertion (DETAILS_EXPIRED after the wait, and the database clock past validUntil) is unchanged. SETUP.
- New cells: `ADV-PV1R-12 DENY ACH-M-I3-REVOCATION (PARTIALLY_RECEIVED)`, `ADV-PV1R-6 DENY ACH-M-I3-EXPIRY (session)` (sessions opt-in, RR-4; expiry set by ageing the session row's idle_expires_at to just after last_seen_at while the read is held, because bankWorld takes no movable session clock). EQUAL (new coverage).

## PV1R-07 r4 (Codex r4 on ac9a2ed; design `pv1-route-pv1r07-design.md` §5): test repairs, written on 7bc2745 (src untouched)
RELAXED: 0. Each repair keeps every product assertion; only the arming that named the r3 implementation (a count of
authentication-boundary transactions or touch statements) is replaced by a point on the effect's OWN connection, which holds for the r3
hold and for the r4 fence alike.
- Helper `readHeldAtEffectRead`: `withResumeHeld(FINAL_I3_RESUME)` + "first effect_now once armed" -> `i3EffectRead()`: the first
  `kauro.effect_now()` on the read's connection after its route lock statement (`FROM kauro.bank_routes WHERE route_id = $1 FOR SHARE`).
  Its `reached` assertion now asserts that statement was held. Users unchanged and green on 7bc2745: ADV-1 (idle, absolute), PV1R-07
  r3 "revocation started while the final guard waits", ADV-1 r6 (x2), B r6 (x2).
- E1 replaces `PV1R-02 DENY ACH-M-I3-EXPIRY (session idle deadline crossed while the FINAL I3 resume waits on the session row lock)`
  with `PV1R-02 r4 DENY ACH-M-I3-EXPIRY (idle deadline crossed while the final session fence waits)`: the holder takes the row FOR UPDATE
  when the read's connection passes its route lock (not at the 3rd assurance acquisition); `blockedBehind(holder)`; cross by
  LEAD_MS + 2 ms; release. The idle assertions are unchanged (401, no digits, no reference, row not renewed, next 401). The live arm
  drops "the final resume renewed the live session": under r4 the final judgment does not touch (design §3.3), and renewal was never the
  claim of this cell; it still asserts 200 with the exact account, routing number and reference.
- R1 replaces `PV1R-07 DENY ACH-M-I3-REVOCATION (revocation committed before the final guard's lock)` with `PV1R-07 r4 DENY
  ACH-M-I3-REVOCATION (revocation committed before the final session fence)`: the revocation commits while the read stands at its route
  lock (instead of at the 3rd assurance acquisition). Assertions unchanged.
- RULE16-SELF-WAIT deleted (it unit-tested the `requestAuthorityOf` hold cache, which design §3.3 removes); its claim (a second judgment
  of one request never waits on its own lock; after the end of the transaction it is taken again) is F6 in
  `packages/persistence/test/session-fence.test.ts`, against PostgreSQL. Rule 14 repair.
- Not repaired here (outside this lane's packet; they arm on the r3 hold and will fail on the r4 fix, not on a defect):
  `PV1R-02 DENY ACH-M-I3-EXPIRY (session expires during the final authentication's own store wait)` and `readHeldAtFinalAuthentication`
  (PV1R-06 cells) use `withResumeHeld(FINAL_I3_RESUME)` (a third touch statement); `ADV-2 r6 DENY ACH-M-I2-REVOCATION (CMD028 replay
  judged under the session lock)` uses `withNthSessionTransaction(2)` (a second assurance transaction). Design-neutral repair: arm on the
  effect's own connection (`i3EffectRead()`; for ADV-2 r6 the journal reservation `.after`, as H7 does).

## PV1R-07 r4 (L2, on the fix): the three tests bound to the removed separate hold (coordinator assignment)
RELAXED: 0. Each keeps its security assertion (expired/revoked session -> no effect, no secrets, refusal); only the pause point moves, from a
count of authentication-boundary operations (which no longer exist in the effect's path) to a statement of the request's OWN connection.
| Test | Old pause point | New pause point |
|---|---|---|
| `PV1R-02 DENY ACH-M-I3-EXPIRY (session expires during the final authentication's own store wait)` | the 3rd `UPDATE kauro.web_sessions SET last_seen_at` on the assurance pool (`withResumeHeld(FINAL_I3_RESUME)`), answer held | the read's session fence statement (`... FROM kauro.web_sessions WHERE secret_sha256 = $1 AND user_id = $2 FOR SHARE`) on the read's own connection, held `.before` it is sent (`readHeldAtSessionFence`); the clock moves, released; the fence returns the row, the judgment runs at the later clock. Assertions unchanged (live served with exact digits and reference; idle/absolute 401, no digits, no reference, next request 401). Converted to its own `FaultPoints` (not a `runCell`), as before. |
| `PV1R-06 DENY ACH-M-I3-EXPIRY` x2 (`readHeldAtFinalAuthentication`) | the same 3rd touch statement | the same fence statement `.before`, same helper; the effect clock still crosses the deadline/validity while held. Assertions unchanged (409 INSTRUCTIONS_EXPIRED / INSTRUCTIONS_NOT_AVAILABLE, no digits, no reference; control served). `FINAL_I3_RESUME` deleted (no user left). The helper's `reached` assertion became `at.taken()` inside `readHeldAtSessionFence`. |
| `ADV-2 r6 DENY ACH-M-I2-REVOCATION (CMD028 replay judged under the session lock)` | `withNthSessionTransaction(2)`: the revocation committed on the 2nd assurance acquisition | the revocation commits while the replay stands at its `INSERT INTO kauro.command_journal` reservation on its own connection (`.after`, as H7 does), then released; the replay's fence sees the revoked row. Assertions unchanged (401, no reference, next replay 401, control replay by a live session answers the stored response). |
Narrowing (after the first green run): H1-H6 accepted `500 | 503 | 401`; every cell was observed as exactly `500 INTERNAL_ERROR -` (the unit's
connection failure, design K2), so `notServed` now accepts only `code(reply) === "500 INTERNAL_ERROR -"`.
Also (builder-owned per design §5/§9, not a repair): `runtime-boundary.test.ts` P1 assertions (kauro_app on `web_sessions`) and the
`migrations.test.ts` list (+0047).

## PV1R-07 r4 (coordinator, 81d2509): accepted B11 test W2 boundary re-ruled under D-AUTH-1a
RULED CHANGE, not a relaxation of the r4 table above (that table stays RELAXED: 0). `apps/api/test/b11-sessions.test.ts:452` asserted
`kauro_app` has no privilege on `web_sessions` (D-AUTH-1). 0047 grants the lock-only path (D-AUTH-1a), so `SELECT count(*)` returns 0 rows
instead of raising. Old: count(*) and UPDATE revoked_at -> permission denied. New (strictly more checks): no presented secret -> 0 rows;
`SELECT session_id` (non-granted column), UPDATE revoked_at, DELETE -> permission denied; presented hash + own user -> exactly that session
FOR SHARE; `UPDATE ... SET session_id = gen_random_uuid()` -> IMMUTABLE_COLUMN; presented hash + another user -> 0 rows. Boundary-group
assertions unchanged. Red on 83a51be at the old first assertion.

## Round 5: packages/application exact-inventory tests (full Linux verify 0cb5e33)

RULED CHANGE (new routes/fields of lane ACH-ROUTE), RELAXED: 0. The product was right in all three (schemas closed, CMD028 members optional, routes declared); the inventories were stale. Every equality stays an exact deepEqual/equal; items are listed by name in docs/review/pv1-route-touched-B06.md "PV1 inventory".
- commerce-contracts.test.ts, CMD028 properties +routeKind, routeId (required unchanged).
- json-schema.test.ts, counts 9 -> 16, 44 -> 49, request ids +5.
- response-schemas.test.ts, OPERATIONAL_ROUTES +7.
packages/application: 190/190 pass on Windows. (pnpm run build fails only in @kauro/web e2e: @axe-core/playwright not installed on this Windows tree; unrelated.)

## PV1 inventory (coordinator, after full Linux verify on ffb3cdd): apps/api request-validation route inventory
RULED CHANGE, RELAXED: 0. `apps/api/test/request-validation.test.ts` "exactly the fourteen catalogue routes ..." counted every POST outside
the commerce/commercial sets as exactly 22 (actual 27: the five bank-route operations). The five POSTs and the route read GET (plus the
transfer-instructions GET where the commerce read set does not already own it) are now named exactly (deepEqual on the inventory) and
excluded from the unchanged 22/16 counts.

## PV1 inventory (coordinator, after full Linux verify on 76c7905 = 36f4f13 + main 9e20ac9): tools/test/openapi.test.mjs
RULED CHANGE, RELAXED: 0. "the committed document is the generated one ..." pins two exact inventories: the composed api's registered routes
and `sources.operationalRoutes`. L-ROUTE registers seven operational routes (configureBankRoute, verify/enable/disable/details, getBankRoute,
getTransferInstructions), so both lists gain exactly those seven entries; the byte-for-byte document check and `check() == []` are unchanged and
pass (the committed document already documented them). Failing text before: `+ 'POST /api/v1/operations/bank-routes configureBankRoute'` (x7).
