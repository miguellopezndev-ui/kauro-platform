# PV1 L-ROUTE: internal adversary r1 (Codex dry-run, tier-1 money/authority)

Range: `git diff 1e4ca3d..a50db87` (worktree repos/pw-pv1-route, branch pv1/route). Design: ACH-ROUTE r12 (pv1/docs-r7 de42e71) §2, §7.1-§7.3, §7.12, §7.24, §7.28-§7.29.
Method: static review of the diff + touched modules (close-agency, commerce-subject, authorizer, B09 CMD028). No tests run, no stash: this worktree is read-only for the adversary. Vacuity verdicts are analytic, and each one gives the exact revert that keeps the cell green.

**Verdict: FAIL** (6 MAJOR, 5 MINOR, 0 BLOCKING).

Known, already tracked (not raised): `pnpm run matrix` crashes since KIT c890b41 (Refund edges without owner), fixed in KIT2.

## Builder-declared departures: rulings
| # | Departure | Ruling |
|---|---|---|
| 1 | Issuance locks the quote FOR UPDATE and the route FOR SHARE before the access decision | REJECTED as built: it inverts the B09 order that D-ACH-04 mandates ("locks checkout facts in B09 order") and deadlocks with CMD043 (ADV-PV1R-1). |
| 2 | Participants are append-only, keyed by route version | ACCEPTED. But no test exercises the mechanism (ADV-PV1R-5). |
| 3 | Details replacement binds the account only; full classification happens at verify | ACCEPTED, provided ADV-PV1R-4 adds the test that verify refuses unclassifiable evidence. |
| 4 | Owner commands journal as CMD201-205, outside the registry | ACCEPTED. List them in the Codex prompt. |
| 5 | GENERAL rollout always refuses until L-REFUND (fails closed) | ACCEPTED. The R2-GENERAL sub-cases still missing must appear as GAP -> L-REFUND in the matrix (ADV-PV1R-8/9). |
| 6 | No sweep for bank orders in INTENT_CREATED | ACCEPTED only as LATER -> L-INBOUND E1 (ACH-10/11/21), with its consequences disclosed (ADV-PV1R-9). |
| 7 | Ruling R-1: 404 NOT_A_MEMBER for a revoked membership | ACCEPTED. It matches accepted B06: pipeline-authorization.test.ts:220/:286 and cmd044:218. |

## Red proofs claimed by the builder
- I2D-EXPIRY (500 vs 409 TRANSFER_WINDOW_TOO_SHORT): plausible.
- Migration '=' binding: plausible. bank-route-migrations asserts KA002 and the agency-less visibility.
- R1-RACE "stale verify": INSUFFICIENT. The cell always sends expectedVersion = 1, so the `seen.currentVersion` guard is never the deciding check (ADV-PV1R-4).

## Findings (review-schema.json shape)
```json
{
  "verdict": "REJECT",
  "summary": "Tier-1 lane is close but not Codex-ready: lock order of issuance inverts B09 (deadlock with CMD043), transferExpiresAt ignores the source deadline and details validity, I3 serves account digits for orders whose bank state is closed, and four guards that carry authority (verify binding, allowlist narrowing, session) have no discriminating test.",
  "verify_observed": "n/a (static adversary review; builder reports ach-route-cells 45/45 and bank-route-migrations 3/3 green on Windows at a50db87)",
  "omissions": 0,
  "findings": [
    {
      "id": "ADV-PV1R-1", "severity": "MAJOR", "family": "concurrency",
      "title": "Kinstructions takes the quote row lock BEFORE the purchased-subject transition halves: inverted against B09 CMD028 and deadlocks with CMD043 close-agency (agency X then quote)",
      "file": "packages/application/src/commerce/bank/instructions.ts", "line": 85,
      "reproduction": "Agency with an issued quote and an ENABLED CONTROLLED route. S1 = CMD043 close-agency: authorize, lockAgencyRow + lockAgencyTransition (exclusive) at close-agency.ts:75, paused before the open-quote loop (close-agency.ts:114). S2 = bank CMD028: quotes.lock (instructions.ts:85) succeeds, route FOR SHARE, then the authorizer / readCheckoutPrerequisites -> PgPurchasedSubjects.subjectOf awaitTransition kauro.agencies (commerce-subject.ts:56) waits on S1. Resume S1: quotes.lock(quoteId) waits on S2 -> 40P01, one side answers 500. The provider CMD028 path takes the subject halves first and the quote last (create-payment-order.ts header T1, :101), so only the bank branch inverts the order. Migration 0046:18 and the B06-touch doc disagree on the subject lock (project FOR NO KEY UPDATE vs quote FOR UPDATE). PgBankRoutes.lockProject (bank-routes.ts:258) is dead code.",
      "acceptance_criterion": "Kinstructions takes every lock in one documented order that matches the B09 CMD028 order (subject halves -> route -> quote) or a rule-13 order recorded in 0046 and §7.28. No writer of agency/capability/approval/revision/contract that holds an exclusive half and then locks a quote can form a cycle with it. The migration comment, the B06-touch doc and the code name the same lock. A membership/route revocation committed during the wait is still observed at the access decision.",
      "failing_test": "New cell RACE ACH-M-I1-RACE (close-agency, both orders) or an I2-RACE extension: CMD043 close-agency vs bank issuance on one agency, holder paused via ctx.points at the first lock of each side, both orders. Assert: no 40P01/500. Either closure withdrew the quote and issuance answers 409/404 with NOTHING_ISSUED, or issuance committed and closure answers 409 CLOSURE_OBLIGATIONS_UNRECONCILED. Also run CMD026 approval withdrawal and provider CMD028 vs bank issuance, both orders (the I1/I2-RACE injections the design lists).",
      "scope": [
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 85, "why": "quote FOR UPDATE before access and the subject halves"},
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 106, "why": "readCheckoutPrerequisites shared halves taken after the quote lock"},
        {"file": "packages/application/src/commercial/agency/close-agency.ts", "line": 114, "why": "agency exclusive half (line 75) then quote FOR UPDATE: opposite order"},
        {"file": "packages/persistence/src/repositories/commerce-subject.ts", "line": 56, "why": "awaitTransition agencies: the wait closing the cycle"},
        {"file": "packages/application/src/commerce/request/create-payment-order.ts", "line": 101, "why": "B09 order (subject -> route -> quote) the bank branch must match (D-ACH-04)"},
        {"file": "packages/persistence/migrations/0046_bank_routes.sql", "line": 18, "why": "comment says project FOR NO KEY UPDATE; code locks the quote"},
        {"file": "packages/persistence/src/repositories/bank-routes.ts", "line": 258, "why": "lockProject unused"},
        {"file": "docs/review/pv1-route-touched-B06.md", "line": 42, "why": "lock-order section must match the final order"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 676, "why": "I1-RACE only vs disable; design lists PayPal checkout/sweep/approval withdrawal/source deletion"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 860, "why": "I2-RACE only bank vs bank; design lists issue/PayPal/retire/sweep"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-2", "severity": "MAJOR", "family": "time",
      "title": "transferExpiresAt = min(lifetime, price expiry) only: the source availability deadline (D-ACH-04) and the details validity are never applied; I2 and I3 never judge details validUntil",
      "file": "packages/domain/src/commerce/bank-route.ts", "line": 76,
      "reproduction": "Quote with price expiry 14 d and sourceAvailableUntil (or the B07 effectiveDeadline) 7 d. Route lifetime 10 d, window 2 d. Issue at t0: transferExpiresAt = t0 + 10 d, sendBy = t0 + 8 d, so the buyer is told to pay up to day 8 for a source that expires on day 7. The same holds with details validUntil = t0 + 5 d: I3 serves the account digits on day 6, after the owner evidence expired. Issuance checks only verifiedAt (instructions.ts:105). I3 checks route state and deadline (instructions.ts:241-243), never details.validUntil.",
      "acceptance_criterion": "transferExpiresAt = min(effectNow + lifetime, quote price expiry, source effective deadline, details validUntil, any shorter validity deadline). The window guard applies to that minimum. I2 refuses (nothing written) and I3 hides digits once effectNow >= details validUntil. Each boundary is judged at the effect instant read after the locks.",
      "failing_test": "DENY ACH-M-I1/I2-EXPIRY extended: (a) source deadline shorter than price expiry and lifetime -> transferExpiresAt = source deadline, TRANSFER_WINDOW_TOO_SHORT at window-1 ms; (b) details validUntil crosses during the route-lock wait -> 409 DETAILS_EXPIRED, NOTHING_ISSUED; (c) I3 with validUntil crossed at the artifact read -> refused, noAccountDigits.",
      "scope": [
        {"file": "packages/domain/src/commerce/bank-route.ts", "line": 76, "why": "deadline formula"},
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 122, "why": "call passes only q.expiresAt"},
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 105, "why": "issuance never judges details validity"},
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 243, "why": "I3 judges the snapshot deadline only"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 723, "why": "I1-EXPIRY price only; design: source/price/capacity independent"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 905, "why": "I2-EXPIRY price only; design: transfer/quote/source/proof"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1151, "why": "I3-EXPIRY deadline only"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-3", "severity": "MAJOR", "family": "money",
      "title": "I3 serves the account digits whatever the bank order state: CAPTURED, RECEIVED_REVIEW and EXPIRED (ROUTE_SWITCH retirement before the deadline) still get payable instructions, an invitation to pay twice",
      "file": "packages/application/src/commerce/bank/instructions.ts", "line": 241,
      "reproduction": "Issue an order. As kauro_payment (granted UPDATE of order_state) set bank_transfer_instructions.order_state to CAPTURED (or RECEIVED_REVIEW, or EXPIRED with transfer_expires_at still in the future). GET /payment-orders/{id}/transfer-instructions -> 200 with routingNumber/accountNumber. D-ACH-05: EXPIRED means stop instructions/payment claims; RECEIVED_REVIEW is closed to further instructions. Same for payment_orders.state outside the open set.",
      "acceptance_criterion": "I3 serves digits only while the snapshot order_state is AWAITING_TRANSFER or PARTIALLY_RECEIVED (the open set of the design) and the payment order is open. Every other state answers a closed refusal with no digit and no reference fragment, judged under the route guard in the same unit of work.",
      "failing_test": "DENY ACH-M-I3-REVOCATION extended with withdrawals order captured, order in review, order retired (EXPIRED before deadline), each applied while the projection is held at its artifact read, plus the next read: refused, noAccountDigits.",
      "scope": [
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 241, "why": "guard checks route state/version only"},
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 243, "why": "deadline is the only order-level check"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1216, "why": "I3-REVOCATION withdraws membership/route/artifact only"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-4", "severity": "MAJOR", "family": "evidence",
      "title": "Verify binding of the classified evidence to the version it marks verified is unproven: R1-RACE never makes the seen-version guard decide, and repair 27bfccb removed the only incomplete-details case (no MALFORMED-at-verify test anywhere)",
      "file": "packages/application/src/commerce/bank/route-config.ts", "line": 296,
      "reproduction": "(a) Delete `|| route.currentVersion !== seen.currentVersion` at route-config.ts:296. R1-RACE stays green because verifyBody(r) always sends expectedVersion = 1 (test:248), so the replace-first order is refused by the expectedVersion check alone. In production, a verify sent with expectedVersion = 2 while the replacement is in flight reads v1 evidence before the lock and then marks v2 verified (markVerified at :302) without ever classifying v2. (b) Change verify to readRouteDetails(..., {classify:false}). Every test stays green: the R1-PARTIAL repair (test:407) now uses complete details and crashes before the store read, and the repair note says the up-front refusal of incomplete details is not asserted. So a version whose evidence does not classify (departure 3) can be VERIFIED.",
      "acceptance_criterion": "Verify marks a version verified only if that exact version's evidence was read and fully classified in the same unit of work. A verify whose expectedVersion names a version committed after its evidence read is refused with STALE_VERSION. A version whose evidence is MALFORMED/incomplete is refused at verify (422) and stays unverified.",
      "failing_test": "RACE ACH-M-R1-RACE: add the order replace-holds / verify-with-expectedVersion-2 waits -> 409 STALE_VERSION ROUTE_VERSION_CHANGED, version 2 unverified (red with the seen guard removed). DENY in R1-PARTIAL or a new DENY cell: replace with routingNumber null -> 200 PENDING_VERIFICATION v2, verify -> 422 INTEGRITY_FAILURE MALFORMED_EVIDENCE, no verified_at (red with classify:false at verify).",
      "scope": [
        {"file": "packages/application/src/commerce/bank/route-config.ts", "line": 296, "why": "seen-version guard"},
        {"file": "packages/application/src/commerce/bank/route-config.ts", "line": 292, "why": "classification at verify"},
        {"file": "packages/application/src/commerce/bank/route-config.ts", "line": 406, "why": "replacement tolerates MALFORMED (departure 3): verify is its only gate"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 248, "why": "expectedVersion fixed at 1"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 407, "why": "incomplete-details fixture removed; injection before the read, not after account number read"},
        {"file": "docs/review/pv1-route-test-repairs.md", "line": 16, "why": "repair must be listed as a weakening unless the DENY above replaces it"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-5", "severity": "MAJOR", "family": "evidence",
      "title": "Allowlist narrowing (re-enable ENABLED->ENABLED without an agency), the only product path that removes a participant, is never exercised: I1/I2-REVOCATION remove participants by a raw DELETE that departure 2 forbids, so the set_version binding is unproven",
      "file": "packages/persistence/src/repositories/bank-routes.ts", "line": 251,
      "reproduction": "Change isParticipant to ignore set_version (any historical allowlist), or the same in bank_route_visible_to_tenant (0046:271). Every cell stays green, because the only removal any test makes is DELETE FROM kauro.bank_route_participants (test:810, :997), which deletes every set. In production the owner removes agency X by re-enabling with [Y]. If the binding regresses, X keeps issuing instructions on a CONTROLLED route.",
      "acceptance_criterion": "After a re-enable whose allowlist omits agency X: issuance by X answers 409 ROUTE_NOT_ENABLED with NOTHING_ISSUED, X cannot read the route row as a participant (only through its own existing instructions), and Y issues. This also holds when the re-enable commits while the issuance by X waits at the route lock.",
      "failing_test": "DENY ACH-M-I1/I2-REVOCATION: replace the raw DELETE withdrawal by a participant removal through POST /enable with participants [other], committed while the issuance waits on the route lock. Expect 409 ROUTE_NOT_ENABLED and NOTHING_ISSUED; red with isParticipant ignoring set_version.",
      "scope": [
        {"file": "packages/persistence/src/repositories/bank-routes.ts", "line": 251, "why": "isParticipant set_version binding"},
        {"file": "packages/persistence/migrations/0046_bank_routes.sql", "line": 271, "why": "tenant visibility binds participants_version"},
        {"file": "packages/application/src/commerce/bank/route-config.ts", "line": 346, "why": "participantsVersion = version + 1 on enable/re-enable"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 810, "why": "raw DELETE"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 997, "why": "raw DELETE"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-6", "severity": "MAJOR", "family": "revocation",
      "title": "I3 session prerequisite (design I3-REVOCATION membership/session/route/details; I3-EXPIRY session expiry) is neither re-checked after the held artifact read nor tested: a disclosed authority caveat without a test",
      "file": "packages/application/src/commerce/bank/instructions.ts", "line": 234,
      "reproduction": "Cookie session (B11). Hold the projection at its artifact read and revoke or expire the web session. Release. The unit of work re-checks membership (authorizeRead) but never the session, which authenticate() read once before the unit of work. The digits are served. The cell comment at test:1218 states the gap (needs a sessions-enabled bank world).",
      "acceptance_criterion": "A session revoked or expired before the I3 guard instant yields a refusal with no digits. The guard instant is the access decision after the artifact read. Alternatively, a coordinator ruling records the cell half as GAP with owner lane and date, the Codex prompt lists it, and no EXECUTED_LOCAL claim is made for I3-REVOCATION/I3-EXPIRY.",
      "failing_test": "DENY ACH-M-I3-REVOCATION session withdrawal on a sessions-enabled bank world: revoke the kauro.web_sessions row while held at the artifact read -> 401/403, noAccountDigits; I3-EXPIRY with the session expiry crossed during the hold -> refused.",
      "scope": [
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 234, "why": "access decision re-checks membership only"},
        {"file": "apps/api/src/payments/bank-route-routes.ts", "line": 148, "why": "authenticate once, before the unit of work"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1218, "why": "stated gap"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1151, "why": "I3-EXPIRY lacks the session half"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-7", "severity": "MINOR", "family": "evidence",
      "title": "Harness proxy replaces the product effectInstant (kauro.effect_now()) with its own kauro.server_now() read whenever a step clock is set: every EXPIRY cell bypasses the product SQL it claims to prove",
      "file": "apps/api/test/fault-support.ts", "line": 191,
      "reproduction": "Change PgCommerceUnitOfWork.effectInstant to transaction_timestamp(). All R1/R2/I1/I2/I2D/I3-EXPIRY cells stay green, because while op.clock is set the proxy never calls the product method.",
      "acceptance_criterion": "With a step clock set, the proxy positions the server clock (clock.onServer) and then calls the product effectInstant itself, so the product SQL is the one measured.",
      "failing_test": "Any EXPIRY cell (for example I2D-EXPIRY) goes red when effectInstant reads transaction_timestamp().",
      "scope": [
        {"file": "apps/api/test/fault-support.ts", "line": 181, "why": "repositioned()"},
        {"file": "packages/persistence/src/unit-of-work.ts", "line": 644, "why": "product effectInstant SQL"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-8", "severity": "MINOR", "family": "evidence",
      "title": "Vacuous or missing assertions inside claimed cells",
      "file": "apps/api/test/ach-route-cells.test.ts", "line": 688,
      "reproduction": "(1) events: fp.events (test:688, :803) compares the event count with itself, so a duplicated or missing issued event passes. (2) ACH-02 expired (test:1325) runs after the route was disabled, so it never reaches the expiry branch; the second re-enabled order the comment mentions does not exist. (3) No test forces a reference collision: ACH-03 (test:1349) only checks that the UNIQUE constraint holds, so the MAX_REFERENCE_DRAWS loop can be removed and everything stays green; I2-RETRY lacks the force-reference-collision injection the design lists. (4) R2-REVOCATION omits identity and fee-config withdrawals; I1/I2-REVOCATION omit identity, source, target and capability; I2-delta REVOCATION (route version replaced: window re-read) is never run with a re-verified, re-enabled version that has a different window. (5) The R2-GENERAL title claims refund sub-cases that are not run (disclosed in a comment only). (6) No configure race (two configures of one account).",
      "acceptance_criterion": "Each listed assertion goes red when its product guard is reverted: exact event counts, expiry on an ENABLED route, collision via an injected random source, and each listed withdrawal. Every sub-case not run is marked GAP with its owner lane in the matrix.",
      "failing_test": "Exact events count in I1-RACE/I1-RETRY; ACH-02 expired read with the route ENABLED; ACH-03 with bank.random stubbed to repeat the first draw -> issuance still 201 with a different reference (red with one draw); I2-REVOCATION route re-versioned -> window taken from v2.",
      "scope": [
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 688, "why": "self-equal events"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 803, "why": "self-equal events"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1325, "why": "expired after disable"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 1349, "why": "collision never forced"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 561, "why": "R2-REVOCATION withdrawals"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 992, "why": "I2-REVOCATION withdrawals / I2-delta"},
        {"file": "apps/api/test/ach-route-cells.test.ts", "line": 660, "why": "R2-GENERAL partial title"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-9", "severity": "MINOR", "family": "evidence",
      "title": "Matrix and case map dishonest or stale; one undeclared departure; the consequences of departure 6 are undisclosed",
      "file": "docs/design/ACH-case-map.md", "line": 25,
      "reproduction": "(1) The case map (ACH-01..03) and §7.29 cite packages/persistence/test/ach-route-cells.test.ts, but the file is apps/api/test/ach-route-cells.test.ts. The §7.1-§7.3 rows are still all GAP although 45 cells exist. (2) D-ACH-02 says the B09 payment route becomes QUALIFIED when ENABLED and SUSPENDED when disabled. The lane leaves it CONFIGURED forever and substitutes paymentRoute {state: QUALIFIED} in checkoutBlockers (instructions.ts:112). This departure is not declared. (3) Departure 6: until L-INBOUND E1, a bank order stays INTENT_CREATED after its deadline. It then blocks every new order of the project (findOpenForProject), agency closure (commercial-agency-lifecycle.ts:283 CLOSURE_OBLIGATIONS_UNRECONCILED) and the plan inspections (commerce-inspections.ts:40). None of this is stated, and the INTENT_CREATED->CANCELLED edge that E1 must use is not named.",
      "acceptance_criterion": "The matrix rows and the case map name the real file and the exact titles, with each cell C/GAP/N-A and a reason; counts are consistent. The undeclared departure is listed with its owner lane. Departure 6 lists its blocking effects, the L-INBOUND cells that remove them, and the edge used.",
      "failing_test": "n/a (document honesty); the anchor/case-map check resolves every cited title to an existing test.",
      "scope": [
        {"file": "docs/design/ACH-case-map.md", "line": 25, "why": "wrong path ACH-01..03 (lines 25-27)"},
        {"file": "docs/design/ACH-ROUTE.md", "line": 1257, "why": "§7.29 wrong path"},
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 112, "why": "QUALIFIED substitution"},
        {"file": "packages/persistence/src/repositories/commercial-agency-lifecycle.ts", "line": 283, "why": "closure blocked by INTENT_CREATED bank orders"},
        {"file": "packages/persistence/src/repositories/commerce-inspections.ts", "line": 40, "why": "plan inspections count them as open"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-10", "severity": "MINOR", "family": "tenant",
      "title": "Data access before authorization: I3 decrypts and classifies the account artifact, and issuance locks the quote and route of a foreign tenant, for any authenticated caller that names an agency; tenant RLS also exposes owner ids and verification references",
      "file": "packages/application/src/commerce/bank/instructions.ts", "line": 227,
      "reproduction": "A non-member sends X-Kauro-Agency: X with an orderId of X. I3 reads the snapshot under the RLS context of X, reads and decrypts the store artifact, and only then denies. An existing order is therefore slower (store read) than an unknown one, and the gap reaches PROVIDER_CALL_TIMEOUT_MS when the store stalls, giving an existence oracle. Issuance takes the quote of X FOR UPDATE before the deny. Separately, bank_route_versions_tenant_read and bank_routes_tenant_read (0046:275-278) give every agency that can see the route (every agency under GENERAL) verified_by, created_by, verification_evidence_ref and details_artifact_ref. No RLS test covers these tenant policies.",
      "acceptance_criterion": "No tenant row and no evidence byte is read for a caller whose membership in the selected agency was not first established. Keep the revocation semantics by re-checking after the read. Tenant sessions see only the columns issuance and I3 need. A persistence test proves that a non-participant agency sees no route or version row and that a participant sees no owner identifiers.",
      "failing_test": "I3-RETRY: a foreign token with the agency header of the victim makes no store GET (bw.evidence.calls unchanged). A bank-route-migrations test: SELECT verified_by FROM bank_route_versions as an agency session is denied or NULL.",
      "scope": [
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 227, "why": "artifact read before authorizeRead (line 234)"},
        {"file": "packages/application/src/commerce/bank/instructions.ts", "line": 85, "why": "locks before authorize"},
        {"file": "packages/persistence/migrations/0046_bank_routes.sql", "line": 277, "why": "versions tenant read: all columns"},
        {"file": "packages/persistence/migrations/0046_bank_routes.sql", "line": 275, "why": "routes tenant read: all columns"}
      ],
      "status": "OPEN", "reviewer_omission": false
    },
    {
      "id": "ADV-PV1R-11", "severity": "MINOR", "family": "revocation",
      "title": "Evidence binding checks account and environment only at verify/enable/replace/I3; provider and integration class are bound only at configure",
      "file": "packages/application/src/commerce/bank/route-config.ts", "line": 166,
      "reproduction": "Route configured with PROVIDER evidence. The owner replaces the details with an artifact of the same accountRef/environment whose provider or integrationClass differs (for example a CONTRACT_FAKE artifact). It then verifies and enables, and I3 serves those details. Only configure checks evidence.provider (line 242) and the fake/LIVE rule (line 243).",
      "acceptance_criterion": "Every read of route evidence (verify, enable, replace, I3) refuses an artifact whose provider or integration class differs from those of the route (DETAILS_ACCOUNT_MISMATCH), and a CONTRACT_FAKE artifact never qualifies a PROVIDER or LIVE route.",
      "failing_test": "DENY in R1-REVOCATION or R1-RETRY: replacement with a CONTRACT_FAKE artifact on a PROVIDER route -> 409 DETAILS_ACCOUNT_MISMATCH, nothing written.",
      "scope": [
        {"file": "packages/application/src/commerce/bank/route-config.ts", "line": 166, "why": "readRouteDetails binding"},
        {"file": "packages/application/src/commerce/bank/route-config.ts", "line": 242, "why": "configure-only provider check"}
      ],
      "status": "OPEN", "reviewer_omission": false
    }
  ]
}
```

## Family-coverage table (scope path -> covering test that fails without the fix)
Every row is MISSING until the fix lands. The builder fills in the test title and the red-proof sha/state. This table becomes evidence.md for the Codex verification.
| Finding | Scope path | Covering test (required) | Status |
|---|---|---|---|
| ADV-PV1R-1 | instructions.ts:85/:106 vs close-agency.ts:114 | RACE close-agency vs issuance, both orders, no 40P01 | MISSING |
| ADV-PV1R-1 | I1/I2-RACE design injections (CMD026, provider CMD028) | RACE both orders | MISSING |
| ADV-PV1R-2 | bank-route.ts:76; instructions.ts:105/:122/:243 | I1/I2/I3-EXPIRY source and details-validity boundaries | MISSING |
| ADV-PV1R-3 | instructions.ts:241 | I3-REVOCATION order-state withdrawals | MISSING |
| ADV-PV1R-4 | route-config.ts:292/:296/:406 | R1-RACE expectedVersion=2 order; MALFORMED at verify | MISSING |
| ADV-PV1R-5 | bank-routes.ts:251; 0046:271; route-config.ts:346 | I1/I2-REVOCATION re-enable narrowing | MISSING |
| ADV-PV1R-6 | instructions.ts:234; bank-route-routes.ts:148 | I3 session revocation/expiry (or ruling + GAP) | MISSING |
| ADV-PV1R-7 | fault-support.ts:181/:191 | EXPIRY cell red with transaction_timestamp() | MISSING |
| ADV-PV1R-8 | test:688/:803/:1325/:1349/:561/:992/:660 | exact counts, forced collision, listed withdrawals | MISSING |
| ADV-PV1R-9 | case map 25-27; ACH-ROUTE 1257; instructions.ts:112; lifecycle:283; inspections:40 | doc fix + anchor check | MISSING |
| ADV-PV1R-10 | instructions.ts:227/:85; 0046:275/:277 | no store GET for a foreign caller; RLS column test | MISSING |
| ADV-PV1R-11 | route-config.ts:166/:242 | class-mismatch replacement refused | MISSING |

Accepted-package touches (pv1-route-touched-B06.md):
- B06: the bind/event-per-version redefinitions are covered by bank-route-migrations (3 facts).
- B09: the CMD028 branch is covered by ach-route-cells, but its lock order is wrong (ADV-PV1R-1).
- B10 harness: see ADV-PV1R-7.
