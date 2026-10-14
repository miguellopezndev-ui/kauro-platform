# B10 STEPUP-AT-COMMIT: failure-mode matrix (tier 1, authority)

Lane `b10/stepup-at-commit`, base `0e5466c8`. Columns and cell grammar: `docs/design/FAILURE-MATRIX-TEMPLATE.md`. The template has no
rules 24/24a-c or 25 on this base; the governing family rules are 15 (TIME-AFTER-AWAIT), 16 (authority judged under a conflicting lock,
effect before release) and 23 (windows on the database clock). Pattern: PV1R-01/03 (`beforeCommitOf`, `effectNowOf`,
`assureStepUpAtCommit` in `packages/application/src/ports/assurance-and-admission.ts`).

Verification against the code on the base: all five findings were already fixed by `5110a41e` ("platform STEPUP-AT-COMMIT", 2026-10-11,
whose message records the tests that failed on its own base). This lane re-verified each one (sweep: no handler calls
`assurance.verifyStepUp` directly except the bank-route `assuredAt`, which follows PV1R-03 itself), and closed the one cell left
unasserted: the commit-time refusal being audited (F1 EXPIRY, CMD043).

Shorthand: `api/` = `apps/api/test/`, `app/` = `packages/application/test/`, `authz/` = `packages/authorization/test/`,
`pers/` = `packages/persistence/test/`.

## F1. Step-up judged at the DB clock and re-judged at COMMIT (CMD043 close-agency, CMD049 activate-seller, CMD052 approve-payout, CommerceAuthorizer.assureOperator, Authorizer.assure)

| Column | Cell |
|---|---|
| RACE | C: api/cmd043-close-agency.test.ts :: "STEPUP-AT-COMMIT RACE (EXPIRY): a step-up proof that expires while the closure waits on the agency's exclusive half — fresh when the body checked it — is refused ASSURANCE_REQUIRED STEP_UP_STALE at the commit and nothing changes (the agency ACTIVE, no closure); the same closure with a proof still fresh at its commit is 200"; api/b10-failure-cells-pay.test.ts PAY_REV "RACE: a step-up proof that expires while ApproveCommissionPayout waits on its statement's row lock ..." |
| TIMEOUT | N/A: the judgment is a database read in the unit; a lock or statement timeout rolls the unit back (nothing commits), the step-up is not consumed and the retry is judged afresh. |
| EXPIRY | C: authz/authorizer.test.ts :: "step-up at COMMIT: a proof that expires between the assurance check and the COMMIT rolls the unit back with ASSURANCE_REQUIRED STEP_UP_STALE; one still fresh at the commit commits; the boundary is exclusive"; api/b10-failure-cells-pay.test.ts PAY_REV "EXPIRY: a step-up proof fresh at the intent and APPROVED writes that expires before ApproveCommissionPayout commits ..." (pause at `uow.before-commit`, DB clock moved); api/b10-failure-cells-sales.test.ts "DENY: a step-up that passes its window between the guard and COMMIT is 403 ..."; audited refusal: the CMD043 test above now asserts exactly one `DENY STEP_UP_STALE STEP_UP` fact of the owner in the agency's stream (this lane). |
| CRASH-BEFORE | C: the commit check throws inside the unit, so a crash or refusal before COMMIT leaves nothing (the CMD043 footprint deepEqual; CMD052/CMD049 "RACE: ... a crash before COMMIT leaves ..." in api/cmd052-approve-commission-payout.test.ts and api/cmd049-activate-seller.test.ts). |
| CRASH-AFTER | N/A for this lane: after COMMIT the proof was fresh at the commit; replay is the journal's (existing CMD043/049/052 RACE retry cells). |
| RETRY | C: an identical retry after a commit-time refusal runs as a new execution (the refusal rolled the journal reservation back); the CMD043 test's final call with a fresh proof is 200. A replay of a committed result does not judge the step-up again (journal replay, existing cells). |
| REVOCATION | C: the step-up is the revocable authority here; a proof that ceases to be FRESH (expiry, rule 8) between the check and COMMIT is the EXPIRY cell; another person's proof is STEP_UP_NOT_OWNED at both judgments (app/commerce-core.test.ts :: "CommerceAuthorizer.assureOperator — D-REF-B4 ..." asserts the proof is read again for the COMMIT judgment). |
| PARTIAL | C: the commit check runs after the last write and before COMMIT; a throw rolls back every write of the unit (CMD043 footprint: agency, closures, quotes, reservations, orders, refunds, authorizations, events, journal; CMD052 PAY_REV: no intent, statement ISSUED). |

The DB clock: `assureStepUpAtCommit` judges at max(`kauro.effect_now()` rounded up, process clock), read after the proof read (rule 15);
CMD052 has a database backstop at COMMIT too (migration 0040, KC020). The recorded `authorizedAt` of CMD052 stays the unit's instant by
design (migration 0038 header: "the recorded instants stay the transaction's server instant"), so the old ":94 same pre-read sample"
item is fixed (its judgment now goes through `assureStepUpAtCommit`) and nothing else is changed.

## F2. Effect instant rounded to the millisecond (`packages/persistence/src/unit-of-work.ts` `PgUnitOfWork.effectInstant`)

| Column | Cell |
|---|---|
| EXPIRY | C: pers/adapters-commerce-unit-of-work.test.ts :: "STEPUP-AT-COMMIT: the effect instant is rounded UP to the millisecond, never down — an instant read after the database's own microsecond instant is never earlier than it (a proof never passes up to one millisecond late)" (`date_trunc('milliseconds', effect_now() + 999 us)`). |
| RACE, TIMEOUT, CRASH-BEFORE, CRASH-AFTER, RETRY, REVOCATION, PARTIAL | N/A: a single read-only statement inside the caller's unit. |

## F3. Commissions service route, legacy method-less adapter (`apps/api/src/commissions/routes.ts` `registerServiceCommand`)

| Column | Cell |
|---|---|
| RACE, TIMEOUT, EXPIRY, CRASH-BEFORE, CRASH-AFTER, PARTIAL | N/A: the refusal is decided before any unit of work; the only write is the refusal fact. |
| RETRY | C: every repetition of a cross-site request is refused alike with no row (the loop in the test below runs four variants). |
| REVOCATION | C: api/cmd051-close-commission-period.test.ts :: "STEPUP-AT-COMMIT DENY (cross-site cookie at the service route): a browser request that fails the Origin, Sec-Fetch-Site or session CSRF rule is answered as an unauthenticated request and writes no row into the victim's security log; the same-origin request with the session's own CSRF token is the wrong principal (SERVICE_NOT_PERMITTED, one DENY fact of that person)". The route authenticates through `kit.authentication({ method: request.method, headers })`, the shared boundary's method/CSRF guard. |

## F4. B09 checkout clock sampled before the proof/availability read (`packages/application/src/commerce/request/checkout.ts`)

| Column | Cell |
|---|---|
| EXPIRY | C: app/commerce-core.test.ts :: "revisionForCheckout with the process clock: a source deadline that passes while the availability read waits expires the revision (EXPIRED), judged after the read, not at the instant sampled before it". Provider paths (`create-payment-order.ts`, `capture-payment.ts`) pass `runtime.clock`; the bank path judges at `bank.effectNow` read after the reads and again at COMMIT (PV1R-03); `quoteViewOf` is a read (no effect). |
| RACE, TIMEOUT, CRASH-BEFORE, CRASH-AFTER, RETRY, REVOCATION, PARTIAL | N/A here: the facts are reads; the checkout command's own rows are in the B09 matrix. |

## F5. B11 web-sessions `revoke(at)` reports REVOKED for a session that expired during the wait (`packages/persistence/src/web-sessions.ts`)

| Column | Cell |
|---|---|
| EXPIRY | C: pers/session-fence.test.ts :: "STEPUP-AT-COMMIT F7 EXPIRY (revoke behind a fence past the session's idle deadline): a session that expired during the wait is ENDED, never REVOKED, and the row stays unrevoked". The row is locked FOR UPDATE, then the instant is read, then the UPDATE judges both deadlines at it (rule 16). |
| RACE | C: same test (the revoke waits behind a fence holder; `waitersOf` asserts the wait). |
| TIMEOUT, CRASH-BEFORE, CRASH-AFTER, RETRY, REVOCATION, PARTIAL | N/A here: one UPDATE in one transaction; the session-fence T-cells of pers/session-fence.test.ts cover the fence timeouts. |

## Gaps

None open. The CMD043 RACE cell keeps its bounded 4.5 s wall-clock wait from `5110a41e` (the DB clock is the real server clock there);
moving it to the fault harness's controlled clock (`ctx.points.pause("uow.before-commit")` + `ctx.clock.past`, as PAY_REV does) is a
test-speed improvement, not a coverage gap.
