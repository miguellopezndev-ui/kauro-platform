# PAYMENTS-V1 L-ROUTE: files of accepted packages touched (A6 re-review of the touched part)

Lane L-ROUTE (branch `pv1/route`, migration 0046 provisional) changes the files below that belong to ACCEPTED packages. Each entry lists what
changed. The test that covers the change follows on the next line.

## B06 (foundation: events, journal, RLS, response contract)

| File | Change |
|---|---|
| `packages/persistence/migrations/0046_bank_routes.sql` | Redefines `kauro.domain_events_bind_aggregate()` (0008) and `kauro.require_event_for_version()` (0001) to compare the agency with `IS NOT DISTINCT FROM`. An agency's rows compare exactly as before; an agency-less aggregate (`bank_route`) now binds (decision #1). |
| same | New policies `domain_events_owner_route` and `outbox_records_owner_route` (kauro_app): agency-less `bank_route` rows are visible only to `kauro.acting_corporate_owner()`. |
| `packages/domain/src/model/events.ts` | Adds the bank-route event types, aggregate kinds, payload allowlists and NOTIFICATIONS subscriptions (spread from `commerce/bank-route.ts`). |
| `packages/application/src/api/response-schemas.ts` | `OPERATIONAL_ROUTES` gains the 7 bank-route routes (`BANK_ROUTE_OPERATIONAL_ROUTES`). |
| `packages/persistence/test/migrations.test.ts` | Migration list +0046. The "no SECURITY DEFINER" assertion now pins exactly one definer, `register_bank_payment_route`, with search_path `pg_catalog, pg_temp` (decision #2, amended a). |
| `packages/persistence/test/aggregate-kinds.test.ts` | `TABLE_OF` gains `bank_route` and `bank_transfer_instruction`; they are walked by the lane's suites, not by this one. |

Tests: `packages/persistence/test/bank-route-migrations.test.ts`. It covers three facts: an agency-less event is visible to the owner only and never to an agency session; agency events bind exactly as before; the binding refuses an event ahead of the version.

## B09 (payments)

| File | Change |
|---|---|
| `packages/persistence/migrations/0046_bank_routes.sql` | `payment_routes_register_bank`: `FOR INSERT TO CURRENT_USER` (the function owner only), CONFIGURED / CONTRACT_FAKE or PROVIDER, no evidence, no valid_from. `corporate_roles_register_bank_read`: `FOR SELECT TO CURRENT_USER` (the definer reads the caller's grant under FORCE RLS). kauro_app gains no grant or policy on payment_routes. |
| `packages/persistence/src/unit-of-work.ts` | `PgCommerceUnitOfWork.bankRoutes`, `effectInstant()` (kauro.effect_now()), accessors `bankRoutesOf`, `effectInstantOf`. |
| `packages/application/src/commerce/contracts.ts`, `request-schemas.ts` | CMD028 body: optional `routeKind` ("BANK_TRANSFER") and `routeId`. The handler refuses one without the other (SCHEMA_VIOLATION). The vendored registry is unchanged. |
| `packages/application/src/commerce/views.ts`, `response-schemas.ts` | `CreatePaymentOrderView.transfer` (optional). It never carries an account or routing number. |
| `packages/application/src/commerce/outcomes.ts` | CMD028 catalogue gains ROUTE_NOT_ENABLED, OPEN_ORDER_EXISTS, PLAN_WITHDRAWN, TRANSFER_WINDOW_TOO_SHORT and CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE. |
| `packages/application/src/commerce/request/runtime.ts` | `CommerceRequestCollaborators.bank?` |
| `packages/application/src/commerce/request/create-payment-order.ts` | A bank branch is checked first. The provider path is unchanged. |
| `apps/api/src/composition.ts` | `ApiAssembly.bank?` (late-bound store and classifier); the bank collaborators; registration of the bank routes. |

Tests: `packages/persistence/test/bank-route-migrations.test.ts` covers the payment_routes refusals: a direct INSERT as kauro_app, a non-owner, an agency session, and a class other than CONTRACT_FAKE or PROVIDER. `apps/api/test/ach-route-cells.test.ts` covers the rest. The existing B09 suites (commerce, response contract) run unchanged.

## B10 test harness

| File | Change |
|---|---|
| `apps/api/test/fault-support.ts` | `effectInstant` of a unit of work is repositioned on the cell's step clock while one is set (`clock.onServer`, then `kauro.server_now()`). This applies to routed units of any context and to the api's own units. It is test-harness only. |
| `apps/api/test/support.ts` | `World.bank` (the late-bound evidence store) and `ApiAssembly.bank` with the CONTRACT_FAKE classifier. |
| `apps/api/test/bank-support.ts` (KIT) | `bankWorld` binds its evidence fake as the api's store. |
| `apps/api/test/bank-support.ts`, `integration-support.ts`, `statements-support.ts`, `payment-support.ts` (KIT; r1, coordinator ruling RR-4) | Opt-in `sessions?: boolean`, passed through to `world({ sessions: true })` (the B11 session boundary). Additive: off by default, so every existing caller builds the same world. Proof: bank-kit 5/5 before and after; ach-route-cells, the same 50 cells pass. Used only by `ADV-PV1R-6 DENY ACH-M-I3-REVOCATION (session)`. |

## Lock order (rule 13) recorded in 0046

Kroute (enable, disable) takes the route row FOR UPDATE before the owner's access decision.

Kinstructions takes locks in the bank issuance order below: the checkout facts in the B09 sequence (subject halves, then route, then quote; D-ACH-04 "locks checkout facts in B09 order"), preceded by the project row, which the provider CMD028 path never locks (r1 fix, ADV-PV1R-1):
1. the access decision (identity and membership shared halves, held to COMMIT);
2. the journal;
3. the project row FOR NO KEY UPDATE (one issuance of a project at a time; before the subject halves, as every project writer takes it:
   CreateRevision locks the project, then the agency, then the revision);
4. the purchased subject's shared halves (agency, capability, approval, source revision, target contract);
5. the route row FOR SHARE;
6. the quote row FOR UPDATE, last.

CMD043 close-agency takes the agency's exclusive half and then the quote: an issuance waits at the agency half holding no quote, so no cycle.
Covered by `ADV-PV1R-1 RACE ACH-M-I1-RACE (lock order, CMD043 close-agency vs bank issuance, both orders)` (40P01 -> 503 with the old order),
and by ACH-M-R2-REVOCATION, ACH-M-I1-REVOCATION, ACH-M-I2-REVOCATION (r1 revocation form: each withdrawal holds its own lock).

Reads of the internal evidence store happen inside the transaction where the cells require it (decision c): Kroute enable after the lock.
I3 reads the caller's membership first under a savepoint rolled back at once (no evidence read for a non-member, no membership half held
across the store read), then the artifact, then decides at the guard instant (access, session, route, allowlist, bank order, effect clock).

## Lane departures and matrix status (r1, ADV-PV1R-9)

**Wrong test path (docs lane).** The case map (ACH-01..03, ACH-case-map.md:25-27) and ACH-ROUTE.md §7.29 cite `packages/persistence/test/ach-route-cells.test.ts`. The cells are in `apps/api/test/ach-route-cells.test.ts`; the migration facts are in `packages/persistence/test/bank-route-migrations.test.ts`. Both documents belong to the docs lane (pv1/docs), not this worktree. The correction goes to that lane with this note.

**§7.1-§7.3 rows.** Each design cell R1, R2, I1, I2 and I3 x {RACE, TIMEOUT, EXPIRY, CRASH-BEFORE, CRASH-AFTER, RETRY, REVOCATION, PARTIAL} is C in `apps/api/test/ach-route-cells.test.ts` under its exact title, `<VERB> ACH-M-<row>-<column> (<family>): <row label>`, plus the r1 cells prefixed `ADV-PV1R-<n>`. Sub-cases that are not run are GAP:
- I3-EXPIRY session half: C, `ADV-PV1R-6 DENY ACH-M-I3-EXPIRY (session)` (r2).
- I3-REVOCATION session half: C, `ADV-PV1R-6 DENY ACH-M-I3-REVOCATION (session)` (RR-4). 
- R2-GENERAL with a reconciled credit (P1/P2): GAP -> L-INBOUND.
- R2-GENERAL with a refund DECLARED / UNCERTAIN / RECORDED (X1/G2): GAP -> L-REFUND. The title claims more than is run; the comment discloses it.
- I1/I2-REVOCATION capability and source withdrawals: GAP. I2-delta with a different window: GAP, because no product command changes the window (replaceDetails copies it).
- R2-REVOCATION identity and fee-config withdrawals: GAP.

**Departure 8 (undeclared until r1): the B09 payment route of a bank route stays CONFIGURED, never QUALIFIED.** D-ACH-02 says the route becomes QUALIFIED when ENABLED and SUSPENDED when disabled. The lane registers the payment_routes row as CONFIGURED (0046 `payment_routes_register_bank`) and never moves it. Instead, issuance passes `paymentRoute: { state: "QUALIFIED" }` to `checkoutBlockers` (instructions.ts:112), and the bank route's own state is the gate. Consequence: any B09 reader that requires a QUALIFIED payment route (capture, reconciliation, authorization issuance) will refuse or skip bank orders until L-INBOUND binds them. Owner: L-ROUTE (this declaration), L-INBOUND (capture path). Codex prompt: list it.

**Departure 6 consequences (no sweep for bank orders before L-INBOUND E1).** The bank order is `payment_orders.state = INTENT_CREATED` (the vendored machine is not extended). Past `transferExpiresAt` it stays INTENT_CREATED until E1 (ACH-10/11/21) runs. Until then it:
1. blocks every new order of the project (`findOpenForProject` -> `409 PAYMENT_PENDING OPEN_ORDER_EXISTS`, across routes);
2. blocks agency closure (`commercial-agency-lifecycle.ts:283`, `409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED`; asserted by `ADV-PV1R-1 RACE ACH-M-I1-RACE ...`, issuance-first order);
3. counts as open in the plan inspections (`commerce-inspections.ts:40`).
E1 removes these effects with the listed PaymentOrder edge `INTENT_CREATED -> CANCELLED` (0015 transition list) and snapshot `order_state` -> EXPIRED (`transfer_deadline_reached`). Cells: ACH-M-E1-*, L-INBOUND.

**Lock order.** Rewritten by the r1 fix (4746fb0): the section above, the 0046 comment and `bank-routes.ts` name the same order the code takes. ACH-ROUTE §7.28 (docs lane, pw-pv1-docs) still needs the Kinstructions row added: GAP -> docs lane. The red cell is `ADV-PV1R-1 RACE ACH-M-I1-RACE ...`.

**ADV-PV1R-5 / RR-6.** The allowlist version is checked twice: by isParticipant (bank-routes.ts:251) and by the tenant read policy (0046:271). The narrowing cell goes red only when both are reverted.

## r1 fix (4746fb0, 5a7c7b8): accepted-package files touched

| Package | File | Change | Covering test (red with the change reverted) |
|---|---|---|---|
| B09 | `packages/domain/src/commerce/failure-reasons.ts` | Closed set gains `INSTRUCTIONS_NOT_AVAILABLE` (RR-2), appended last. | `ADV-PV1R-3 DENY ACH-M-I3-REVOCATION (bank order state)`; `commercial-rules.test.ts` (B09 reasons stand where they stood). |
| B09 | `packages/application/src/commerce/outcomes.ts` | CMD028 catalogue gains `PRECONDITION_FAILED DETAILS_EXPIRED` (RR-1). | `ADV-PV1R-2 DENY ACH-M-I2-EXPIRY (details validity)`; `outcome-catalogue.test.ts`. |
| B06/B09 | `apps/api/openapi.json`, `apps/web/src/api/generated.ts` | Regenerated (Problem reason enum, CMD028 problem catalogue). | `pnpm run openapi`, `pnpm run web-client` checks. |
| B06 | `packages/persistence/migrations/0046_bank_routes.sql` | kauro_app column grants on `bank_routes` / `bank_route_versions` without `created_by`, `verified_by`, `verification_evidence_ref`; new column `details_valid_until` (set with the verification, whole-verification CHECK, set-once trigger). | `ADV-PV1R-10 DENY RLS (tenant columns of a bank route)`; `bank-route-migrations.test.ts` 3/3. |
| B09 lane files | `instructions.ts`, `route-config.ts`, `bank-routes.ts`, `ports.ts`, `bank-route.ts`, `bank-route-routes.ts` | Lane-owned (not accepted). | `docs/review/pv1-route-r1-fix-proof.md`. |

## Open GAPs with owner lane (r2)
- **Show remaining amount for PARTIALLY_RECEIVED** (ADV-PV1R-12): owner L-INBOUND (E1). Until then I3 excludes PARTIALLY_RECEIVED from the readable states and answers `409 PRECONDITION_FAILED INSTRUCTIONS_NOT_AVAILABLE` with no digits (cell `ADV-PV1R-12 DENY ACH-M-I3-REVOCATION (PARTIALLY_RECEIVED)`). L-INBOUND must add the cell: I3 on a PARTIALLY_RECEIVED order shows remaining = obligation - allocated, never the full obligation as the amount to send.
- **Payment order open half of I3-REVOCATION** (ADV-PV1R-3): owner L-INBOUND (E1). No writer in this lane moves a bank order's `payment_orders.state` off INTENT_CREATED, so only the snapshot `order_state` half is covered; E1 must move the snapshot and the order in one unit and add the cell.

## Codex r1 fix (6c604ac, 54260a1, 031c0e2, 3844109): accepted-package files touched

| Package | File | Change | Covering test (red with the change reverted) |
|---|---|---|---|
| B06 | `packages/domain/src/ports/unit-of-work.ts`, `packages/domain/src/ports/index.ts` | New `PreCommitChecks` port + `beforeCommitOf` (fail closed), exported. Additive; no existing implementer changed. | PV1R-03 cells (8) in `ach-route-cells.test.ts` (with route-config.ts reverted; the port alone registers nothing). |
| B06 | `packages/persistence/src/unit-of-work.ts` | `PgUnitOfWork.beforeCommit` / `runBeforeCommit`; `#once` runs registered checks after `work` returned, before COMMIT (only when the work was not abandoned). No-op for units that register none. | PV1R-03 cells; persistence 30/30, API regression 42/42. |
| B06/B11 | `apps/api/src/server.ts` | `RouteKit` gains `subjectOrRefusal` (the existing command-boundary function) and `authentication`; the kit object is built once for payment and commission routes. | PV1R-01 tests (6). |
| B06 | `apps/api/src/composition.ts` | `registerBankRouteRoutes` no longer receives `authenticator`. | PV1R-01 tests. |
| B06 | `docs/design/B06-state-command-event-matrix.md` | Regenerated (4 Refund manual edges as L-REFUND planned-not-implemented; stale PV1 error-catalogue rows). | `tools/test/matrix.test.mjs` 8/8; `pnpm run matrix`. |
| B06 | `tools/matrix.mjs` | `EDGE_OWNERS.Refund` + 4 owner entries. | `matrix.test.mjs` PV1R-05 (2). |

## Codex r2 fix (53f6940, 2c2bf59, 2001f2f): accepted-package files touched (TIME-AFTER-AWAIT, template rule 15)

| Package | File | Change | Covering test (red with the change reverted) |
|---|---|---|---|
| B06/B11 | `packages/application/src/ports/sessions.ts` | `WebSessionStore.resume` takes `now: () => UtcInstant` (read by the store immediately before its touch statement). | `PV1R-02 DENY ACH-M-R2-EXPIRY (session expires during the cookie authentication's own store wait)`; b11-sessions 41/41 with b10-family-templates. |
| B06/B11 | `packages/application/src/sessions/service.ts` | `resume` judges liveness at a clock read after the store returned (PV1R-02). | same cell (200 -> 401 reverted). |
| B06/B11 | `packages/persistence/src/web-sessions.ts` | `resume` reads its instant inside the boundary transaction, just before the touch UPDATE. | same cell. |
| B06/B11 | `apps/api/src/authenticator.ts`, `apps/api/src/sessions.ts` | `Authentication.SUBJECT` gains optional `liveUntil` (session credentials: min(idle, absolute) as resumed). Additive. | `PV1R-02 DENY ACH-M-I3-EXPIRY (... final authentication's own store wait)` (red with resume fix also reverted). |
| B05/B09 | `packages/application/src/ports/assurance-and-admission.ts` | `AssuranceOutcome.FRESH.freshUntil?` (optional, additive). | PV1R-03 r2 cells (6). |
| B05 | `packages/authorization/src/assurance.ts` | `createAssuranceVerifier` returns `freshUntil` = min(issued + window + 1 ms, expiry); verdicts unchanged. | PV1R-03 r2 cells (6); authorization tests 11/11. |
| B06 | `docs/design/FAILURE-MATRIX-TEMPLATE.md` | Rule 15 TIME-AFTER-AWAIT. | n/a (doc). |
| B09 lane files | `instructions.ts`, `route-config.ts`, `bank-route-routes.ts` | Lane-owned. | `docs/review/pv1-route-codex-r2-fix-proof.md`. |

## Codex r3 fix (b56e461, 84befca, c1e2e12 + self-wait follow-up): accepted-package files touched (template rule 16)

Every signature change below is listed for the B06/B11 re-review of the touched part (A6); no assertion was weakened.

| Package | File | Signature / behaviour change | Covering test (red with the change reverted) |
|---|---|---|---|
| B06/B11 | `packages/application/src/ports/sessions.ts`, `ports/index.ts` | New REQUIRED `WebSessionStore.hold(secretSha256, now, idleSeconds, touchSeconds): Promise<HeldWebSession \| null>`; new `HeldWebSession { session; release() }`. `resume` contract now: row locked FOR UPDATE first, `now` read after the lock. | PV1R-02 cells (get, I3 final resume); b11-sessions. |
| B06/B11 | `packages/persistence/src/web-sessions.ts`, `index.ts` | `PgWebSessionStore`: `#boundary` rebuilt on new `#begin`; new `#lockedResume` (SELECT ... FOR UPDATE, THEN `now()`, THEN the same conditional touch UPDATE); `resume` uses it; new `hold` keeps the transaction (and the row lock) open until `release` (idempotent COMMIT). `HeldStoredWebSession` exported. | PV1R-02 cells; PV1R-07 effect-hold cell; persistence tests. |
| B06/B11 | `packages/application/src/sessions/service.ts`, `index.ts` | New `SessionService.hold(secret): Promise<HeldSession \| null>`; `HeldSession extends ResumedSession { liveAt(nowMs); release() }`. `resume` judgment unchanged. | PV1R-07 cells. |
| B06 | `packages/application/src/api/authority.ts` (new), `index.ts` | `CredentialHold`, `RequestAuthority`, `credentialEnded()`, `judgedUnderHold(authority, clock, between?)` (hold, THEN between, THEN `liveAt(clock.nowMs())`). | PV1R-07 cells. |
| B06 | `packages/application/src/api/envelope.ts` | `CommandEnvelope.authority?: RequestAuthority` (optional; not part of the request digest). | PV1R-07 command and issuance cells. |
| B06/B11 | `apps/api/src/authenticator.ts` | Optional `Authenticator.holdRequest?(request): Promise<HeldCredential \| null>`; new `HeldCredential { userId; liveAt; release }`. | PV1R-07 cells. |
| B06/B11 | `apps/api/src/sessions.ts` | `createSessionAuthenticator` implements `holdRequest` (NONE -> null; BEARER -> verified as it stands, always live, no-op release; SESSION -> `service.hold`). | PV1R-07 cells. |
| B06 | `apps/api/src/request-authority.ts` (new) | `requestAuthorityOf(authenticator, request, userId, sink): RequestAuthorityHandle`; one hold per request until `release` (self-wait guard). | PV1R-07 cells; `RULE16-SELF-WAIT` cell. |
| B06/B11 | `apps/api/src/server.ts` | `RouteKit.requestAuthority(...)` added; the generic command path builds the handle, passes `authority` in the envelope and releases it in `finally` after `execute`. | PV1R-07 issuance cell. |
| B06 | `docs/design/FAILURE-MATRIX-TEMPLATE.md` | Rule 16 (lock, then clock, then judge, then effect under the same lock). | n/a (doc). |
| B09 lane files | `route-config.ts` (`judgedAtCommit` gains `authority, clock`; `get` judges under hold and records a denial also on AUTHENTICATION_REQUIRED), `instructions.ts` (I3 final hold; I1/I2 pre-commit under hold), `bank-route-routes.ts` | Lane-owned. | `docs/review/pv1-route-codex-r3-fix-proof.md`. |

## PV1R-07 r4 (session fence inside the effect's own transaction; design `pv1-route-pv1r07-design.md` §8; supersedes the r3 rows above)
| Package | File | Change | Cells |
|---|---|---|---|
| B11 (0025) / B06 | `packages/persistence/migrations/0047_session_fence.sql` (new; provisional number) | `kauro_app` gains column SELECT (`secret_sha256, user_id, revoked_at, idle_expires_at, absolute_expires_at`) and UPDATE (`session_id`) on `kauro.web_sessions`, a SELECT policy and an UPDATE policy (`WITH CHECK (false)`) limited to the session hash the transaction presents AND the person it binds. No function, no SECURITY DEFINER, no table privilege. B11 D-AUTH-1 "kauro_app has no privilege on it" becomes the lock-only path (amendment row D-AUTH-1a in `docs/design/B11-agency-app.md`). | F1-F6, T2, T3, P1 |
| B06 | `packages/persistence/test/fixtures/runtime-boundary.json`, `runtime-boundary.test.ts`, `migrations.test.ts` | Matrix: additions only (kauro_app web_sessions columns, two policies); the boundary test pins exactly them; migration list +0047. B07 definer allowlist test untouched. | P1 |
| B06 | `packages/persistence/src/unit-of-work.ts`, `index.ts`, new `session-fence.ts` | `PgUnitOfWork.sessionFence` (`PgSessionFence.lockPresented`) + `sessionFenceOf(uow)`. | F1-F6, H1-H6 |
| B06/B11 | `packages/persistence/src/web-sessions.ts` | `hold` and `HeldStoredWebSession` removed (the separate assurance transaction no longer exists). | H1-H6 |
| B06/B11 | `packages/application/src/ports/sessions.ts`, `ports/index.ts` | `WebSessionStore.hold`/`HeldWebSession` removed; new `SessionFence` port and `FencedWebSession`. | H1-H6 |
| B06/B11 | `packages/application/src/sessions/service.ts` | `hold(secret)` replaced by `holdIn(uow, secret, userId)`; `HeldSession` is `{ liveAt }`; deps gain `fence`. | H1-H6 |
| B06 | `packages/application/src/api/authority.ts` | `RequestAuthority.hold(uow)`; `judgedUnderHold(authority, uow, clock, between?)`. | H1-H6 |
| B06/B11 | `apps/api/src/authenticator.ts`, `sessions.ts`, `request-authority.ts`, `server.ts` | `holdRequest(request, uow, userId)`; `HeldCredential` without `release`; `requestAuthorityOf` has no release list, sink or cache and returns the `RequestAuthority`; `RouteKit.requestAuthority` returns it; `held.release()` and the swallow removed. | H1-H6 |
| B09 lane files | `route-config.ts`, `instructions.ts`, `bank-route-routes.ts` | Pass the unit to the judgment; no release. | H1-H7 |
| B09 (accepted; lane hunk listed at the CMD028 table above) | `packages/application/src/commerce/request/runtime.ts` | The replay judgment receives the unit (`judgedUnderHold(authority, uow, ...)`); no release. | H6, H7 |
| B11 (accepted test) | `apps/api/test/b11-sessions.test.ts` W2 boundary (:452; 81d2509, coordinator) | RULED CHANGE under D-AUTH-1a: the request role's first two assertions (`count(*)` and UPDATE refused) become: no presented secret -> 0 rows; `SELECT session_id`, UPDATE revoked_at, DELETE -> permission denied; only the presented session visible FOR SHARE; any UPDATE refused (IMMUTABLE_COLUMN); a session presented for another identity invisible. Boundary-group part unchanged. Title amended. | W2 |
| integration | `apps/api/src/composition.ts` | Passes `{ lockPresented: sessionFenceOf(uow).lockPresented }` as `fence` (own commit, Codex doc-review). | n/a |
