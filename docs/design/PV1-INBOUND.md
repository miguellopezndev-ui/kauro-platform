# PV1-INBOUND: which pool runs the owner's inbound commands (D-INB-CTX-1)

Status: PLAN, not built. Origin: verify 111c568, `b09-migrations.test.ts` D-CTX-B1 red ("Missing expected rejection: SELECT 1 FROM
kauro.memberships").

## Finding

- On main (a474494) the owner commands run on the request-handler pool `kauro_app`. This holds for the L-ROUTE bank-route commands
  (`createBankRouteHandlers(commerceRuntime, bank)` in apps/api/src/composition.ts) and for CMD052 (`operatorContextOf`, no pool, in
  packages/application/src/commercial/statements/approve-payout.ts). `runtimeRoleOf` (packages/persistence/src/unit-of-work.ts:139)
  maps OPERATOR and TENANT to `kauro_app`. Identity, step-up proofs, corporate roles and session are read through `kauro_app`'s own-row
  policies (0002, 0013, 0025, 0047). `kauro_payment` never reads a person table, which is what D-CTX-B1 proves.
- ACH-ROUTE.md D-ACH-16 says the same: "Preserve the `kauro_app` versus `kauro_payment` boundary: the owner writes draft/confirmation/
  verification decisions; only a service-authorized consumption of those decisions writes captures, observations and
  CommercialAuthorization."
- This lane departed from that rule. It added `pool: "PAYMENT"` to the OPERATOR and TENANT contexts (runtimeRoleOf, inbound.ts:138, :575,
  :619) and, in 0062, gave `kauro_payment` own-row reads of identities, assurance_proofs, corporate_roles, web_sessions and memberships,
  plus owner and member journal/security-event policies (0062 lines 133-150 and 199-215). D-CTX-B1 rejects that. A column grant cannot
  save it, because the probe `SELECT 1` passes with any column privilege.

## Plan (the existing mechanism; no new role, no definer)

1. CMD210 enter, CMD211 confirm, CMD212 attribute and CMD213 statement run as OPERATOR units on `kauro_app` (drop `pool: "PAYMENT"`;
   composition binds `commerceRuntime`, not the payment runtime). The authorizer, step-up and session fence are unchanged; they already
   work on `kauro_app`.
2. 0062 drops every `kauro_payment` person/journal/security-event grant and policy listed above, and the TENANT/OPERATOR branch of
   runtimeRoleOf.
3. 0062 gives `kauro_app` exactly what those decisions write, agency-less and owner-scoped (`agency_id IS NULL`, no tenant policy):
   INSERT of a DRAFT_MANUAL bank_credit; the confirm, attribute and version columns of bank_credits (the existing guard triggers still
   bound every edge); INSERT of statement_imports and their lines and coverage; domain_events/outbox for the kinds bank_credit and
   statement_import; the route read and lock it needs; the instruction lookup by reference (M2). `kauro_payment` keeps its 0055 service
   policies for P1 (apply) and E1 (expiry), which stay SERVICE units.
4. CMD214 (the agency billing member retires the checkout) becomes a TENANT unit on `kauro_app`. The member check uses the app's
   membership policies, as on main. The payment-service columns it changes today (instruction order_state/expiry_cause, the
   payment_orders slot) are written by the payment service consuming the member's recorded retirement, per D-ACH-16. Alternative: grant
   `kauro_app` column UPDATE of `expiry_cause` and `bank_slot_released_at` under the existing set-once triggers. That is smaller, but it
   moves a money state write to the request handler. Recommended: the consumption.
5. Tests: inbound-lane-support.ts ROLE/LOGIN becomes `kauro_app` for owner units and stays `kauro_payment` for service steps. The B07-F7
   change a5999140 is reverted (the kinds bind for `kauro_app` again, as the original test asserts). runtime-boundary.json is regenerated.
   The D-CTX-B1 test is unchanged.
6. PV1-SETTLE CMD215 has the same defect (it runs on the inbound runtime, and `route_provider_available_cents` is EXECUTE for
   `kauro_payment`). It follows the same split after inbound.

Estimate: 3-4 h of build plus focused cells. The test contract of the lane's cells changes (pool per unit).
