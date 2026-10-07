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

## Lock order (rule 13) recorded in 0046

Kroute (enable, disable) takes the route row FOR UPDATE before the owner's access decision.

Kinstructions takes locks in this order:
1. the quote row FOR UPDATE;
2. the route row FOR SHARE;
3. the access decision.

The RACE and REVOCATION cells already cover this order: ACH-M-R2-REVOCATION, ACH-M-I1-REVOCATION and ACH-M-I2-REVOCATION.

Reads of the internal evidence store happen inside the transaction where the cells require it (decision c): Kroute enable after the lock, and I3 before its access decision.
