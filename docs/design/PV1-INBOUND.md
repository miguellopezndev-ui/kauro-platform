# PV1-INBOUND: which pool runs the owner's inbound commands (D-INB-CTX-1)

Status: approved by the coordinator 2026-10-13 (CMD214 through the payment service's consumption); building. Origin: verify 111c568, `b09-migrations.test.ts` D-CTX-B1 red ("Missing expected rejection: SELECT 1 FROM
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

## CMD214 through the payment service's consumption (D-INB-CTX-2)

- **Record (CMD214, TENANT unit on `kauro_app`).** Order: membership pre-check in a released savepoint, then the order's row lock, then
  the member's access decision (judged after that wait), then the instruction read. If the instruction is open (AWAITING_TRANSFER or
  PARTIALLY_RECEIVED) and has no retirement yet, the unit inserts one `kauro.bank_checkout_retirements` row: order, agency, requesting
  user, reason, `requested_at` (DB clock), `consumed_at` NULL. Answer: 201 `{ retirement: { orderId, state: "RECORDED", requestedAt } }` (built as 201, not 202: in this API a 202 is the
  ACCEPTED envelope of an operation with a status path and a null view, and the journal stores 200/201 replies; the retirement is a
  created resource, replayed by its key). `requested_at` is truncated to the millisecond (the pass cursor's precision).
  The request handler writes no instruction state, no expiry cause and no slot.
- **Consumption (the TRANSFER_EXPIRY pass, SERVICE units on `kauro_payment`, first in the pass, oldest `requested_at` first).** Order:
  adopt the order's agency, then the order's row lock, then the instruction's, then the retirement row FOR UPDATE. If `consumed_at` is
  already set, the unit changes nothing. Otherwise: an open order becomes EXPIRED with cause RETIRED, the slot is released, and one
  order-state event is published (CHECKOUT_RETIRED), with outcome RETIRED. A closed order is left as it is, with outcome NOT_OPEN.
  Either way `consumed_at` is set once, in the same unit.
- **The retirement takes effect at its consumption.** A credit that P1 applies between the record and the consumption is honored (the
  order is CAPTURED and the consumption finds it NOT_OPEN). After the consumption, a later credit is return-only, as before.

### Failure matrix: E1r, the record -> consumption edge

| Cell | Row |
|---|---|
| ACH-M-E1R-RACE | Two retirements of one order serialize on the order lock and the retirement primary key: one row. A P1 apply against the consumption: whichever holds the order lock first decides (apply first: CAPTURED, outcome NOT_OPEN; consumption first: EXPIRED RETIRED, the credit is return-only). Covered by ACH-M-E1-RACE (sweep vs apply), whose pass now consumes first. |
| ACH-M-E1R-TIMEOUT | A consumption that times out behind a held order lock rolls back whole. The retirement stays pending and the next pass consumes it. Covered by ACH-M-E1-TIMEOUT's pass. |
| ACH-M-E1R-EXPIRY | A retirement has no deadline of its own. The consumption judges the order's state after its last lock, so an order the deadline expired first stays DEADLINE (outcome NOT_OPEN, one expiry, one event). |
| ACH-M-E1R-CRASH-BEFORE | CMD214 dying before COMMIT leaves no retirement row and no journal entry, and the order stays open. A consumption dying before COMMIT leaves the retirement pending and the order open. |
| ACH-M-E1R-CRASH-AFTER | **New cell.** CMD214's answer is lost after COMMIT: the retirement is recorded, the order is still open and the slot is held. The same key replays the journaled 201. The next pass consumes it once: EXPIRED RETIRED, slot released, one event. |
| ACH-M-E1R-RETRY | **New cell.** A duplicate consumption applies once: two passes, sequential and concurrent, give one version bump, one CHECKOUT_RETIRED event and one `consumed_at`. The same CMD214 key replays; a new key for a recorded or consumed retirement is 409 ORDER_NOT_CAPTURABLE. |
| ACH-M-E1R-REVOCATION | The member is judged after the order-lock wait, so a member withdrawn meanwhile is refused and nothing is recorded (existing cell ACH-M-E1-REVOCATION, now on `kauro_app`). A withdrawal after the record does not undo it: the decision was authorized at its effect instant. A stale service cannot consume, by the service authority of the pass. |
| ACH-M-E1R-PARTIAL | A consumption failing at a later write (the event insert) rolls back the expiry, the slot and `consumed_at` together. The next pass consumes it. |
| ACH-M-E1R-OK | **New cell.** The record runs on `kauro_app` (proven by ACH-M-E1-REVOCATION, which routes CMD214 over the app login alone: a unit of another role is refused by the harness), answers 201 and changes no order state. The pass applies it. |
