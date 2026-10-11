# PV1 L-ROUTE: internal adversary r2 (verify round of the r1 findings)

Range: `git diff a50db87..abd5555` (cef344f, 0861a46, de934d2, 4746fb0, 5a7c7b8, 9bbd9da, abd5555). r1: `pv1-route-adversary-r1.md`.
Method: static review of the fix diff and the touched lock paths (close-agency, create-quote, replacement, withdraw-approval,
execute-project, create-support-case, create-revision, tenancy.findLive, sessions.resume, 0046 grants/policies).
Revert spot-checks (findings 1, 3, 10) were NOT executed: a scratch worktree needs a full pnpm install + build + PostgreSQL (a node_modules
junction is unsafe for pnpm). Judged by reading instead. For each of the three, the revert named in `pv1-route-r1-fix-proof.md` must
turn its cell red, for the reason given in the r1 status table below.

**Verdict: PASS_WITH_MINOR** (0 BLOCKING, 0 MAJOR). Open: 3 new MINOR, plus 2 r1 residuals (ADV-PV1R-6 and ADV-PV1R-9, MINOR).

## r1 findings: status
| r1 id | Status | Evidence |
|---|---|---|
| ADV-PV1R-1 | FIXED | Order: access, journal, project NO KEY UPDATE, shared halves, route FOR SHARE, quote FOR UPDATE last (instructions.ts:108-117). The 0046 comment, bank-routes.ts and touched-B06 all name this same order. lockProject is now used. Swept every quotes.lock caller (close-agency:114, create-quote:137, replacement:279, provider CMD028:101) and every project-row locker (execute-project:56, create-support-case:51, create-revision:49): none holds an exclusive half or a quote and then waits on a lock that issuance takes earlier. Cell ADV-PV1R-1 RACE ACH-M-I1-RACE covers both orders. With the a50db87 order, closing first forms a cycle (agency half, then quote) -> 40P01 -> red. Nits: the closure-first assertion accepts 404 or 409, so pin the exact code (AGENCY_NOT_ACTIVE). "the B09 order of the provider CMD028" is loose, because the provider takes no project row lock. |
| ADV-PV1R-2 | FIXED | transferWindowOf takes min(lifetime, price, source deadline, details_valid_until). DETAILS_EXPIRED is checked at issuance and I3 hides expired details. Covered by the I2-EXPIRY source and details-validity cells, the I3-EXPIRY details cell, and the I2D-EXPIRY expectation change. The C-1 repair is a harness-use repair, not a weakening. The availability.effectiveDeadline term is not discriminated by any cell: quote.sourceAvailableUntil already equals min(price, effectiveDeadline) at CMD027, so that term is unreachable unless B07 shortens a deadline. Observation only. |
| ADV-PV1R-3 | FIXED | I3 re-reads the snapshot at the guard instant and serves only AWAITING_TRANSFER and PARTIALLY_RECEIVED. Covered by the I3-REVOCATION bank-order-state cell (CAPTURED, RECEIVED_REVIEW and EXPIRED, held read and next read). Removing the check makes the held read return 200 -> red. The criterion's "payment order open" half is unreachable in this lane: no writer moves a bank order's payment_orders.state off INTENT_CREATED. List it as GAP -> L-INBOUND E1, which must move the snapshot and the order in one unit. |
| ADV-PV1R-4 | FIXED (test-only) | Two cells: ADV-PV1R-4 R1-RACE (expectedVersion 2) and ADV-PV1R-4 R1-PARTIAL (MALFORMED at verify). Both reverts are probed and red (r1-red guards). |
| ADV-PV1R-5 | FIXED | Participants are now narrowed through the product re-enable (narrowTo) in the I1 and I2 cells. The I2 cell is red only with both bindings reverted (RR-6): isParticipant and the policy at 0046:271. The new I3 allowlist check returns the foreign answer (RR-3); in the I3 cell the route stays visible through the instructions branch, so isParticipant alone decides there. |
| ADV-PV1R-6 | PARTIAL | Revocation half FIXED: stillAuthenticated re-runs the B11 authenticator (assurance pool, so no same-pool nesting) after the guard's access decision, and ADV-PV1R-6 I3-REVOCATION (session) is red without it. Expiry half: the code path is the same (resume -> isLive at the clock read on the second call), but no cell exercises it. The GAP has no owner lane and no date, contrary to the r1 criterion -> ADV-PV1R-6 below. |
| ADV-PV1R-7 | FIXED (dissent RR-5 accepted) | The real-time cell is red when effectInstant reads transaction_timestamp(). The dissent holds: positioning the step clock and then calling the product SQL would add the lock-wait time and break the exact-boundary cells. Robustness of the cell -> ADV-PV1R-14. |
| ADV-PV1R-8 | FIXED / GAP declared | (1) exact ISSUED_EVENTS; (2) ACH-02 expired read with the route ENABLED; (3) collision forced by a one-shot trigger, red with MAX_REFERENCE_DRAWS = 1; (6) R2-RACE configure race. (4) The identity, target and B06-revoke withdrawals were added. I2-delta, capability and source are GAP: unreachable, or covered on the shared readCheckoutPrerequisites by the B09/B10 provider cells. (5) Disclosed. |
| ADV-PV1R-9 | PARTIAL (deferred) | Departure 8 (payment route stays CONFIGURED) is declared. The consequences of departure 6 and the E1 edge are listed in touched-B06. The wrong test path in ACH-case-map.md:25-27 and ACH-ROUTE section 7.29, and the missing Kinstructions row in section 7.28, are handed to the docs lane but not fixed. They must be fixed before package close. |
| ADV-PV1R-10 | FIXED | I1: authorize runs in access() before any tenant row (cell ADV-PV1R-10 I1-RETRY: no wait on the victim's quote row). I3: findLive runs under a savepoint that is rolled back. The xact advisory half it takes is released on subtransaction abort. The I3-REVOCATION membership cell committing during the held read confirms the release. Cell ADV-PV1R-10 I3-RETRY: no store GET. 0046 column grants: cell ADV-PV1R-10 RLS. |
| ADV-PV1R-11 | FIXED | readRouteDetails binds provider and integration class at verify (route-config:310), enable (:358), replace (:424) and I3 (instructions:287). Configure keeps its own check. Cell ADV-PV1R-11 covers the class and the provider. Because versions are immutable and replacement is now refused, the verify, enable and I3 bindings are defence in depth. |

## Builder decisions (packet a-f)
- (a) ACCEPTED. The order matches D-ACH-04 and rule 13. Closing first answers AGENCY_NOT_ACTIVE, with the agency version and state, as the provider CMD028 answers it. Pin that code in the cell.
- (b) ACCEPTED. details_valid_until is set by verify from the classified, hash-bound artifact. It is immutable, set once, and checked as part of the whole-verification CHECK. 0046 is not on main, so editing it in place is safe.
- (c) ACCEPTED with condition -> ADV-PV1R-12. The design keeps PARTIALLY_RECEIVED payable (ACH-ROUTE:379-383), but I3 then shows the full obligation amountCents with no received or remaining amount.
- (d) EQUIVALENT for non-members. The pre-check reads only the caller's own membership, so it reveals nothing about the order and offers no timing oracle. No membership half is held across the store read. Residual: identity status is judged only at the guard, so an ACTIVE member with a disabled identity has the artifact decrypted server-side but receives nothing. Not raised.
- (e) NO other read path. bank_route_visible_to_tenant is SECURITY INVOKER and returns a boolean. register_bank_payment_route (SECURITY DEFINER) only writes payment_routes. Route events are agency-less and owner-only (0046:253-258). No migration has DEFAULT PRIVILEGES or ON ALL TABLES. kauro_payment has no grant on routes or versions. Tenants cannot use UPDATE ... SET col = col, because there is no tenant UPDATE policy on versions and the routes policy is WITH CHECK false. The test is too coarse -> ADV-PV1R-13.
- (f) MINOR, not acceptable as an anonymous GAP -> ADV-PV1R-6.

## Findings (review-schema.json shape)
```json
{
  "verdict": "ACCEPT_WITH_MINOR",
  "summary": "r1 fix verified: 8 FIXED, ADV-6 and ADV-9 PARTIAL (MINOR residuals). Lock order, deadlines, I3 order-state, authorize-before-read and column grants hold. New MINORs: PARTIALLY_RECEIVED served with the full amount, a coarse RLS column test, a tight real-time cell margin.",
  "verify_observed": "not run by the adversary (read-only, no scratch build); builder: ach-route-cells 61/62 on 9bbd9da + C-1 verified, persistence 13/13, regression 42/42",
  "omissions": 0,
  "findings": [
    {
      "id": "ADV-PV1R-12", "severity": "MINOR", "family": "money",
      "title": "I3 serves PARTIALLY_RECEIVED instructions with the full obligation amountCents and no received/remaining cents: an invitation to pay the whole amount again once a partial credit lands",
      "file": "packages/application/src/commerce/bank/instructions.ts", "line": 236,
      "reproduction": "Snapshot order_state = PARTIALLY_RECEIVED (written by L-INBOUND partial_credit_applied, or as kauro_payment). GET transfer-instructions -> 200 with amountCents = snapshot.amountCents (the full obligation). ACH-ROUTE:379 says PARTIALLY_RECEIVED carries received/remaining cents. No cell covers this state.",
      "acceptance_criterion": "Either PARTIALLY_RECEIVED stays out of the open set until L-INBOUND provides remaining cents (fail closed), or the I3 view in PARTIALLY_RECEIVED carries the remaining amount (never the full obligation as the amount to send). In both cases the state is listed as GAP -> L-INBOUND with the cell that L-INBOUND must add.",
      "failing_test": "L-INBOUND cell: I3 on a PARTIALLY_RECEIVED order shows remaining = obligation - allocated. Or, in this lane, DENY I3 PARTIALLY_RECEIVED -> INSTRUCTIONS_NOT_AVAILABLE until then.",
      "scope": [
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 236, "why": "OPEN_BANK_ORDER_STATES includes PARTIALLY_RECEIVED"},
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 317, "why": "amountCents = current.amountCents (full obligation)"},
        {"file": "docs/review/pv1-route-r1-fix-proof.md", "line": 51, "why": "GAP stated without owner cell or amount rule"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-13", "severity": "MINOR", "family": "evidence",
      "title": "RLS column test selects verified_by, created_by and verification_evidence_ref in ONE statement: re-granting any single withheld column keeps the cell green",
      "file": "apps/api/test/ach-route-cells.test.ts", "line": 1760,
      "reproduction": "Add GRANT SELECT (created_by) ON kauro.bank_route_versions TO kauro_app (or verification_evidence_ref). The bundled SELECT still fails 42501 on verified_by, so hidden() passes and the column leaks. Only the all-columns table grant (the probed revert) is detected.",
      "acceptance_criterion": "Each withheld column has its own SELECT as a participant agency session, and each one is denied (42501): versions.verified_by, versions.created_by, versions.verification_evidence_ref, routes.created_by.",
      "failing_test": "ADV-PV1R-10 DENY RLS split into one assertion per column; red with a single-column re-grant.",
      "scope": [
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1760, "why": "bundled versions SELECT"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1761, "why": "routes: created_by only, fine; keep per-column form"},
        {"file": "packages/persistence/migrations/0046_bank_routes.sql", "line": 300, "why": "column grant lists"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-14", "severity": "MINOR", "family": "time",
      "title": "ADV-PV1R-7 real-time cell gives configure + step-up + verifyBody + mustWait only 4 s of wall clock before validUntil: on a loaded Windows leg it fails in setup, an intermittent main red (rule 6)",
      "file": "apps/api/test/ach-route-cells.test.ts", "line": 1649,
      "reproduction": "validUntil = Date.now() + 4000 is fixed before configured(), which itself judges DETAILS_EXPIRED at its effect instant. The test then needs a verify proof, two connections and a mustWait poll before asserting Date.now() < validUntil. Any setup stall over about 4 s fails the cell without involving the product.",
      "acceptance_criterion": "The margin covers the measured setup time with headroom (for example 20 s, or validUntil derived from a measured setup duration). If setup outruns the margin, the cell refuses as a harness precondition with a clear message, never as a product assertion.",
      "failing_test": "n/a (robustness); the cell stays red with effectInstant = transaction_timestamp().",
      "scope": [
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1649, "why": "4 s margin"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1658, "why": "pre-assert fails on slow setup"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-6", "severity": "MINOR", "family": "revocation",
      "title": "(r1 residual) I3 session-EXPIRY half: no cell, and the GAP has no owner lane or date",
      "file": "apps/api/src/payments/bank-route-routes.ts", "line": 152,
      "reproduction": "The revocation half is proven. Expiry relies on the same resume/isLive call, judged at the session service clock on the second authenticate, but no cell advances the session clock past idle or absolute expiry during the held read.",
      "acceptance_criterion": "Preferred: a cell on the sessions-enabled world, held at the artifact read, with the session clock moved past idle_expires_at -> 401 with no digits. Otherwise: a coordinator ruling records GAP with owner lane and date, I3-EXPIRY makes no EXECUTED_LOCAL claim for the session half, and the Codex prompt lists it.",
      "failing_test": "ADV-PV1R-6 DENY ACH-M-I3-EXPIRY (session): red with stillAuthenticated removed.",
      "scope": [
        {"file": "apps/api/src/payments/bank-route-routes.ts", "line": 152, "why": "stillAuthenticated"},
        {"file": "docs/review/pv1-route-touched-B06.md", "line": 76, "why": "GAP without lane/date"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-9", "severity": "MINOR", "family": "evidence",
      "title": "(r1 residual) case map and ACH-ROUTE 7.29 still cite packages/persistence/test/ach-route-cells.test.ts; 7.28 lacks the Kinstructions order",
      "file": "docs/review/pv1-route-touched-B06.md", "line": 73,
      "reproduction": "Handed to the docs lane, not fixed in any reviewed commit.",
      "acceptance_criterion": "The docs lane commit fixes ACH-case-map.md:25-27, the ACH-ROUTE 7.29 path and the 7.28 row before the package-close review; the Codex prompt names it.",
      "failing_test": "n/a (document honesty; anchor check resolves the titles)",
      "scope": [
        {"file": "docs/review/pv1-route-touched-B06.md", "line": 73, "why": "hand-off note"},
        {"file": "docs/review/pv1-route-touched-B06.md", "line": 90, "why": "7.28 GAP -> docs lane"}
      ],
      "status": "OPEN", "reviewer_omission": false
    }
  ]
}
```

## Family-coverage table (scope path -> covering test, red without the fix)
| Finding | Scope path | Covering test | Red proof |
|---|---|---|---|
| ADV-PV1R-1 | instructions.ts:108-117; close-agency.ts:114; 0046 header; bank-routes.ts lockProject | ADV-PV1R-1 RACE ACH-M-I1-RACE (both orders) | fix-proof #1 (5a7c7b8, 503 with the old order) |
| ADV-PV1R-1 | CMD026, provider CMD028 | none: RR-5, no cycle (verified by reading) | n/a |
| ADV-PV1R-2 | bank-route.ts transferWindowOf; instructions.ts window/DETAILS_EXPIRED; I3 validity | ADV-PV1R-2 I2-EXPIRY source and details cells; I2D-EXPIRY; ADV-PV1R-2 I3-EXPIRY | fix-proof #3-#6 |
| ADV-PV1R-3 | instructions.ts OPEN_BANK_ORDER_STATES guard | ADV-PV1R-3 DENY I3-REVOCATION (bank order state) | fix-proof #7 |
| ADV-PV1R-4 | route-config.ts seen guard / classify at verify | ADV-PV1R-4 R1-RACE; ADV-PV1R-4 R1-PARTIAL | r1-red guards (probed) |
| ADV-PV1R-5 | bank-routes isParticipant; 0046:271; I3 allowlist check | ADV-PV1R-5 I2-REVOCATION; ADV-PV1R-5 I3-REVOCATION; I1/I2-REVOCATION (narrowTo) | r1-red (both bindings); fix-proof #8 |
| ADV-PV1R-6 | bank-route-routes.ts stillAuthenticated | ADV-PV1R-6 I3-REVOCATION (session); expiry half MISSING | fix-proof #9 |
| ADV-PV1R-7 | unit-of-work effectInstant | ADV-PV1R-7 R1-EXPIRY (real time) | r1-red (probed) |
| ADV-PV1R-8 | test strengthening (events, ACH-02, ACH-03, R2-RACE) | named cells | r1-red (probed except events/R2-RACE) |
| ADV-PV1R-10 | access() authorize first; I3 savepoint pre-check; 0046 column grants | ADV-PV1R-10 I1-RETRY, I3-RETRY, RLS | fix-proof #2, #10, #11 |
| ADV-PV1R-11 | readRouteDetails binding (verify/enable/replace/I3) | ADV-PV1R-11 R1-RETRY (replace path) | fix-proof #12 |
| ADV-PV1R-12 | PARTIALLY_RECEIVED in open set | MISSING (GAP -> L-INBOUND or fail closed) | - |
| ADV-PV1R-13 | 0046 per-column grants | MISSING (per-column assertions) | - |

## r3 micro-verify ef79a2e

Delta `abd5555..ef79a2e` only (src: instructions.ts open set + doc comment; test: ach-route-cells.test.ts; docs). Verdict: **PASS**.

| Item | Status | Evidence |
|---|---|---|
| ADV-PV1R-12 | CLOSED | `OPEN_BANK_ORDER_STATES = {AWAITING_TRANSFER}` (instructions.ts:240), judged at the guard re-read (:308); cell red on abd5555 (r2-red.md, read answered 200 with full amount), green on Linux. Sweep: the only other bankState emitter is the CMD028 create view (instructions.ts:217), issuance-time AWAITING_TRANSFER, committed-result replay, no account digits. GAP (remaining amount) owned by L-INBOUND E1 in touched-B06. |
| ADV-PV1R-13 | CLOSED | One SELECT per withheld column, each `assert.equal(got, "42501")` (strictly stronger than the old denied-or-NULL); red with single-column re-grant of created_by. Positive check on details_artifact_ref matches the 0046:302 grant list (column already granted; not new exposure). |
| ADV-PV1R-14 | CLOSED | 20 s named allowance bounds setup only; validUntil still crosses during the lock wait (DB `clock_timestamp() > validUntil` asserted) and the verify txn starts before validUntil, so effectInstant = transaction_timestamp() stays red. Per-test timeout 150 s; no product assertion changed. |
| ADV-PV1R-6 expiry | CLOSED | Only mutation is `idle_expires_at = last_seen_at + 1 ms` (no revoked_at), held at the artifact read; guard re-auth (bank-route-routes.ts:152) refuses; next read 401 proves the authenticator judges idle expiry. Red with the re-auth disabled. Distinct from the revocation cell. |
| ADV-PV1R-1 nit | CLOSED | `code(issued) === "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE"` (was 404-or-409); touched-B06 lock-order wording corrected. |
| finding-3 GAP owner | CLOSED | "Open GAPs with owner lane": PARTIALLY_RECEIVED remaining amount and payment_orders open half, both L-INBOUND E1, with the cell E1 must add. |
| Relaxations | NONE | test-repairs r2 RELAXED 0 confirmed against the diff. |
| Linux counts | CONFIRMED (nit) | 29 / 42 / 64 pass, 0 fail, in tools/ci-local/logs/pv1-route-ef79a2e...-linux.log (receipt verify-linux-pv1-route-focused, exit 0). The cited heavy log holds only the exit line; cite the clone log in evidence. |
| New issues in delta | NONE | Design ACH-ROUTE:379-383 (PARTIALLY_RECEIVED payable) now deliberately narrower: list it as a disclosed caveat with cell ADV-PV1R-12 in the Codex prompt. |
