// The worked examples of package B10 end to end (mandate B10-INTEGRATION; docs/design/B10-case-map.md rows citing this file; design §3,
// §5, §6, §7, §10, §14, §15; decisions D10-FIRST-1, D10-RATE-1, D10-ADJ-1, D10-ADJ-2, D10-ELIG-1, D10-ASSIGN-1, D10-TERM-1, D10-STMT-1,
// D10-PAY-1, D10-PAY-2, D10-NEG-1). One cluster, one api serving every route, the payment service, the commission service with its
// COMMISSIONS dispatcher and sweeps, and one set of labelled fakes (the provider, the buyer type, the preparation completion, the
// banking calendar and the payout evidence: CONTRACT_FAKE, SIMULATED), over PostgreSQL 17 through the runtime login roles; the superuser
// only reads. The scenarios run the application's own handlers as apps/api binds them — CreateQuote, CreatePaymentOrder,
// CapturePayment, the refund commands, AcceptAttribution, AssignAccount, TerminateSeller, CloseCommissionPeriod,
// ApproveCommissionPayout, ReconcileCommissionPayout and GetCommissionStatement — each answer checked against its route contract
// (test/integration-support.ts). The worked examples' hand-calculated integer cents are written here, never read back from the code
// under test, each beside a nearby valid control. Instants are the server's: a leg that stands at another instant stands there on the
// labelled TEST CLOCK (D10-CLOCK-1). Nothing sleeps: interleavings are held at named points and every wait is observed in
// pg_stat_activity. The founding cohort's three slots serve the whole cluster, so the three titles that take them run first.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import type { CreatePaymentOrderView, CreateQuoteView, PayoutIntentView, PayoutReconciliationView } from "@kauro/application";
import { after, before, test } from "node:test";
import type { UserId } from "@kauro/domain";
import { recordAssistanceAgreement, recordServiceAssignment } from "@kauro/persistence/testing";
import type { AttributionView, SellerTerminationView, WebhookAck } from "@kauro/application";
import { handled, recordClaim, recordProspect, waitForLockWait } from "@kauro/persistence/testing";
import { prepareAllocation } from "./sales-support.js";
import { PAYMENT_APPLICATION_NAME } from "../src/index.js";
import { deliver } from "./payment-support.js";
import { deliveryOf, eventOf, type Purchase } from "./commission-support.js";
import { asProblem, call, completed, freshKey, outcome, replayTextOf, waitForApiLockWait, type Reply } from "./support.js";
import {
  acceptedThrough,
  agentOf,
  anotherClient,
  approvePayout,
  assertCohortConsumed,
  bankCash,
  capturedLater,
  claimedCents,
  intentOf,
  opportunityOf,
  orderedThrough,
  terminationBody,
  reconcilePayout,
  scriptEvidence,
  assignedThrough,
  seller,
  bought,
  claimed,
  closedAt,
  replacementPlanOf,
  madeEligible,
  statementReads,
  webhookPurchase,
  statementsOfSeller,
  type Agent,
  type Claimed,
  dispatched,
  integrationWorld,
  linesOf,
  oracleRows,
  paidThrough,
  planOf,
  poolsOf,
  providerReports,
  quoted,
  refundedThrough,
  terminatedThrough,
  type IntegrationWorld,
} from "./integration-support.js";

let iw: IntegrationWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => iw.h.oracle);
/** The agency of example 1, left by R2-079 for the titles that continue its history (examples 2 and 6). */
let example1: { readonly a: Agent; readonly attribution: Claimed; readonly firstAuthorizationId: string } | null = null;
before(async () => {
  iw = await integrationWorld();
});
after(async () => {
  await iw.stop();
});

async function adjustmentRows(lineId: string): Promise<Array<{ direction: string; amount_cents: string; new_cumulative_entitlement_cents: string; new_basis_cents: string }>> {
  return oracleRows(iw, "SELECT direction, amount_cents::text, new_cumulative_entitlement_cents::text, new_basis_cents::text FROM kauro.commission_adjustments WHERE line_id = $1 ORDER BY adjustment_seq", [lineId]);
}

test("R2-079 (example 1): a founding agency's first HubSpot purchase of 50000 units, quoted by CreateQuote at 129500 - 32375 = 97125 and paid through CreatePaymentOrder and CapturePayment, accrues one 9713-cent ACCRUED_PENDING line for its accepted seller — not payable at capture, the 5275-cent fee recorded apart, the founding slot CONSUMED", async () => {
  const a = await agentOf(iw, "ex1");
  const attribution = await claimed(iw, "ex1");
  const { allocationId } = await acceptedThrough(iw, a.s.agency.agencyId, attribution, [10_000]);

  // CreateQuote: 50,000 HubSpot units are the first band, 129,500 cents; the founding rate 2500 bps takes 32,375 (129,500 x 0.25 exactly);
  // the service is 129,500 - 32,375 = 97,125 and an exempt export adds no tax
  const paid = await bought(iw, a, "ex1", { units: 50_000 });
  const quote = paid.quote.quote;
  assert.deepEqual(
    [quote.billableUnits, quote.baseServiceCents, quote.discountCents, quote.serviceCents, quote.taxCents, quote.totalCents, quote.discount.bps, quote.discount.basis],
    [50_000, "129500", "32375", "97125", "0", "97125", 2500, "FOUNDING"],
  );
  assert.equal(paid.quote.eligibility.foundingOffer, "RESERVED");
  assert.deepEqual([paid.order.order.expectedAmountCents, paid.captured.capture?.amountCents], ["97125", "97125"]);

  // the provider reports its fee after the completion: 5,275 cents, a fact of the capture recorded apart from the basis
  await providerReports(iw, paid.purchase, { feeCents: 5_275n });
  await dispatched(iw);
  const capture = await oracleRows<{ provider_fee_cents: string | null; amount_cents: string }>(iw, "SELECT provider_fee_cents::text, amount_cents::text FROM kauro.capture_facts WHERE capture_id = $1", [paid.purchase.captureId]);
  assert.deepEqual(capture, [{ provider_fee_cents: "5275", amount_cents: "97125" }]);

  // one pool, 97,125 x 1000 bps = 9712.5 -> 9713 half up, on the full service basis (never the 91,850 net of the fee, which would be 9185)
  assert.deepEqual(
    (await poolsOf(iw, paid.purchase.authorizationId)).map((p) => [p.source, p.rate_kind, p.rate_bps, p.basis_cents, p.pool_cents, p.confirmation_seq]),
    [["ACQUISITION", "FIRST", 1000, "97125", "9713", 1]],
  );
  const lines = await linesOf(iw, paid.purchase.authorizationId);
  assert.deepEqual(lines.map((l) => [l.seller_id, l.share_bps, l.rate_bps, l.net_service_basis_cents, l.cumulative_entitlement_cents, l.state]), [[attribution.sellers[0]!.sellerId, 10_000, 1000, "97125", "9713", "ACCRUED_PENDING"]]);
  // not payable at capture: no eligibility instant, no statement item, no payout intent
  assert.deepEqual(await oracleRows(iw, "SELECT eligible_at FROM kauro.commission_lines WHERE line_id = $1", [lines[0]!.line_id]), [{ eligible_at: null }]);
  assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS n FROM kauro.statement_items WHERE line_id = $1", [lines[0]!.line_id]), [{ n: 0 }]);
  assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS n FROM kauro.payout_intents"), [{ n: 0 }]);
  // the claim converted into the seller's entitlement by the first purchase, the allocation as accepted
  assert.deepEqual(await oracleRows(iw, "SELECT state FROM kauro.attribution_claims WHERE claim_id = $1", [attribution.claimIds[0]]), [{ state: "CONVERTED" }]);
  assert.deepEqual(await oracleRows(iw, "SELECT allocation_id, state FROM kauro.commission_entitlements WHERE agency_id = $1", [a.s.agency.agencyId]), [{ allocation_id: allocationId, state: "ACTIVE" }]);
  // the founding slot of the quote is CONSUMED by the paid purchase
  assert.deepEqual(await oracleRows(iw, "SELECT r.state FROM kauro.founding_slot_reservations r WHERE r.quote_id = $1", [paid.purchase.quoteId]), [{ state: "CONSUMED" }]);

  example1 = { a, attribution, firstAuthorizationId: paid.purchase.authorizationId };

  // control: the half-up kernel at the rate's tie and a cent either side of it (97,124 -> 9712.4, 97,126 -> 9712.6)
  assert.deepEqual(await oracleRows(iw, "SELECT kauro.round_half_up_bps(97124, 1000)::text AS below, kauro.round_half_up_bps(97125, 1000)::text AS tie, kauro.round_half_up_bps(97126, 1000)::text AS above"), [{ below: "9712", tie: "9713", above: "9713" }]);
});

test("R2-080 (examples 2 and 6): the agency's second project, for another end client, is quoted at 123025 and accrues 4921 at 400 bps; RequestRefund, ApproveRefund and ExecuteRefund of 20000 service cents revise the line to 4121 with one -800 adjustment, and the owner's and the seller's statement projections show the same cents", async () => {
  assert.ok(example1 !== null, "R2-079 left the agency of example 1");
  const { a, attribution } = example1;
  const seller = attribution.sellers[0]!;
  const otherClient = await anotherClient(iw, a, "ex2 second end client");

  // the second project, for another end client: 129,500 less the recurrence discount of 500 bps (6,475 exactly) is 123,025
  const second = await bought(iw, a, "ex2", { units: 50_000, clientId: otherClient });
  const quote = second.quote.quote;
  assert.deepEqual(
    [quote.baseServiceCents, quote.discountCents, quote.serviceCents, quote.totalCents, quote.discount.bps, quote.discount.basis],
    ["129500", "6475", "123025", "123025", 500, "REPEAT"],
  );
  assert.equal(second.quote.eligibility.qualifyingProjectCount, 1, "the first purchase is the one qualifying project");
  await dispatched(iw);

  // the repeat pool: 123,025 x 400 bps = 4,921 exactly; the line follows
  assert.deepEqual(
    (await poolsOf(iw, second.purchase.authorizationId)).map((p) => [p.source, p.rate_kind, p.rate_bps, p.basis_cents, p.pool_cents, p.confirmation_seq]),
    [["ACQUISITION", "REPEAT", 400, "123025", "4921", 2]],
  );
  const [line] = await linesOf(iw, second.purchase.authorizationId);
  assert.deepEqual([line?.seller_id, line?.cumulative_entitlement_cents, line?.state], [seller.sellerId, "4921", "ACCRUED_PENDING"]);

  // the customer's refund of 20,000 service cents through the public commands: the basis falls to 103,025 and 103,025 x 400 bps = 4,121 exactly
  const refund = await refundedThrough(iw, a, second.purchase, 20_000n);
  await dispatched(iw);
  const revised = await oracleRows<{ net_service_basis_cents: string; cumulative_entitlement_cents: string; state: string }>(iw, "SELECT net_service_basis_cents::text, cumulative_entitlement_cents::text, state FROM kauro.commission_lines WHERE line_id = $1", [line!.line_id]);
  assert.deepEqual(revised, [{ net_service_basis_cents: "103025", cumulative_entitlement_cents: "4121", state: "ACCRUED_PENDING" }]);
  const adjustments = await adjustmentRows(line!.line_id);
  assert.deepEqual(adjustments, [{ direction: "DECREASE", amount_cents: "800", new_cumulative_entitlement_cents: "4121", new_basis_cents: "103025" }], "one adjustment of -800");
  assert.equal(refund.executed.refund.serviceCents, "20000");

  // control: a refund event delivered twice changes nothing (one adjustment per changed line and event)
  await dispatched(iw);
  assert.equal((await adjustmentRows(line!.line_id)).length, 1);

  // the statement: the line made ELIGIBLE the way production does, the period closed through CMD051 (a close standing after the 5th banking day)
  await madeEligible(iw, a.s.agency.agencyId, second.purchase);
  const { view } = await closedAt(iw, "2026-06", "2026-10-07T17:00:00Z");
  assert.equal(view.statementCount, 1);
  const [statement] = await statementsOfSeller(iw, seller.sellerId);
  const reads = await statementReads(iw, statement!.statement_id, seller.person.token);
  assert.deepEqual(reads.owner, reads.seller, "the owner's and the seller's projections are the same");
  const item = reads.seller.items.find((i) => i.lineId === line!.line_id);
  assert.deepEqual(
    [item?.sequence, item?.netServiceBasisCents, item?.rateBps, item?.cumulativeEntitlementCents, item?.previouslyPaidCents, item?.payableCents],
    ["REPEAT", "103025", 400, "4121", "0", "4121"],
  );
  assert.equal(reads.seller.payableCents, "4121");
  const [firstLine] = await linesOf(iw, example1.firstAuthorizationId);
  assert.deepEqual(reads.seller.items.filter((i) => i.lineId === firstLine!.line_id).map((i) => [i.cumulativeEntitlementCents, i.payableCents]), [["9713", "0"]], "the first project's 9713 cents still await their final completion: never payable");
});

test("R2-097: AcceptAttribution freezing a 6000/4000 split of two sellers' claims makes the agency's first purchase accrue one 9713-cent pool with lines of 5828 and 3885 cents, never two 10% pools", async () => {
  const a = await agentOf(iw, "ex8");
  const attribution = await claimed(iw, "ex8", 2);
  const [first, second] = attribution.sellers as [(typeof attribution.sellers)[number], (typeof attribution.sellers)[number]];
  // CMD047 freezes one allocation of the two claims at 6000 and 4000 bps: both ACCEPTED, no second full-rate pool
  const accepted = await acceptedThrough(iw, a.s.agency.agencyId, attribution, [6_000, 4_000]);
  assert.deepEqual([accepted.view.beneficiaryCount, accepted.view.rejectedClaimCount, accepted.view.decisionReason], [2, 0, "AGREED_SPLIT"]);

  const paid = await bought(iw, a, "ex8", { units: 50_000 });
  assert.deepEqual([paid.quote.quote.serviceCents, paid.quote.quote.discount.basis], ["97125", "FOUNDING"]);
  await dispatched(iw);

  // one pool: 97,125 x 1000 bps = 9,712.5 -> 9,713, shared 6000/4000 by largest remainder (5,827.8 and 3,885.2 floor to 5,827 and 3,885;
  // the one cent left goes to the larger remainder): 5,828 and 3,885 — never two 10% pools
  assert.deepEqual(
    (await poolsOf(iw, paid.purchase.authorizationId)).map((p) => [p.source, p.rate_kind, p.rate_bps, p.basis_cents, p.pool_cents]),
    [["ACQUISITION", "FIRST", 1000, "97125", "9713"]],
  );
  const lines = await linesOf(iw, paid.purchase.authorizationId);
  const bySeller = new Map(lines.map((l) => [l.seller_id, l]));
  assert.equal(lines.length, 2);
  assert.deepEqual(
    [first, second].map((s) => [bySeller.get(s.sellerId)?.share_bps, bySeller.get(s.sellerId)?.cumulative_entitlement_cents]),
    [[6_000, "5828"], [4_000, "3885"]],
  );
  assert.equal(5_828n + 3_885n, 9_713n, "the shares add up to the pool exactly");
  assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS pools FROM kauro.commission_pools WHERE agency_id = $1", [a.s.agency.agencyId]), [{ pools: 1 }]);
  // control: the half-up kernel alone rounds each share of the 9,713 pool (5,827.8 and 3,885.2) to the same two lines
  assert.deepEqual(await oracleRows(iw, "SELECT kauro.round_half_up_bps(9713, 6000)::text AS big, kauro.round_half_up_bps(9713, 4000)::text AS small"), [{ big: "5828", small: "3885" }]);
});

test("R2-096 (example 5): with the agency's first purchase fully refunded, its next purchase inside the window accrues 400 bps, never 1000; the first designation, the window and the CONSUMED founding slot are unchanged and the first line is VOID at zero", async () => {
  const a = await agentOf(iw, "ex5");
  const attribution = await claimed(iw, "ex5");
  const seller = attribution.sellers[0]!;
  await acceptedThrough(iw, a.s.agency.agencyId, attribution, [10_000]);
  const first = await bought(iw, a, "ex5-first", { units: 50_000 });
  assert.equal(first.quote.quote.serviceCents, "97125");
  await dispatched(iw);
  const [firstLine] = await linesOf(iw, first.purchase.authorizationId);
  assert.deepEqual([firstLine?.cumulative_entitlement_cents, firstLine?.state], ["9713", "ACCRUED_PENDING"]);
  const recurrence = async () => ({
    designation: await oracleRows(iw, "SELECT first_qualifying_capture_id FROM kauro.agencies WHERE agency_id = $1", [a.s.agency.agencyId]),
    window: await oracleRows(iw, "SELECT window_starts_at, window_ends_at, state FROM kauro.commission_entitlements WHERE agency_id = $1", [a.s.agency.agencyId]),
    slot: await oracleRows(iw, "SELECT r.state FROM kauro.founding_slot_reservations r WHERE r.agency_id = $1", [a.s.agency.agencyId]),
  });
  const before = await recurrence();
  assert.deepEqual(before.designation, [{ first_qualifying_capture_id: first.purchase.captureId }]);
  assert.deepEqual(before.slot, [{ state: "CONSUMED" }]);

  // the first purchase is refunded in full through the public commands: its pool falls to zero and the line is VOID at zero
  await refundedThrough(iw, a, first.purchase, 97_125n);
  await dispatched(iw);
  assert.deepEqual(
    await oracleRows(iw, "SELECT state, net_service_basis_cents::text, cumulative_entitlement_cents::text FROM kauro.commission_lines WHERE line_id = $1", [firstLine!.line_id]),
    [{ state: "VOID", net_service_basis_cents: "0", cumulative_entitlement_cents: "0" }],
  );
  assert.deepEqual(await recurrence(), before, "the first designation, the window and the CONSUMED founding slot are unchanged");

  // the agency's next purchase inside the window: the repeat rate, never the first-purchase rate again. The refunded project is not a
  // qualifying one, so the quote carries no discount: 129,500 in the first band, and 129,500 x 400 bps = 5,180 exactly (1000 bps would be 12,950)
  const next = await bought(iw, a, "ex5-next", { units: 50_000, clientId: await anotherClient(iw, a, "ex5 second end client") });
  assert.deepEqual([next.quote.quote.baseServiceCents, next.quote.quote.discountCents, next.quote.quote.serviceCents], ["129500", "0", "129500"]);
  await dispatched(iw);
  assert.deepEqual(
    (await poolsOf(iw, next.purchase.authorizationId)).map((p) => [p.source, p.rate_kind, p.rate_bps, p.basis_cents, p.pool_cents, p.confirmation_seq]),
    [["ACQUISITION", "REPEAT", 400, "129500", "5180", 2]],
  );
  assert.deepEqual((await linesOf(iw, next.purchase.authorizationId)).map((l) => [l.seller_id, l.rate_bps, l.cumulative_entitlement_cents]), [[seller.sellerId, 400, "5180"]]);
  assert.deepEqual(await recurrence(), before, "the next purchase changes none of them either");
});

test("R2-092 (example 18): a paid agency replaces its source once before execution — CreateRevision, seal, a new approval and the replacement quote — and ExecuteProject's authority is the re-bound entitlement, the old one never reusable", async () => {
  await assertCohortConsumed(iw);
  const a = await agentOf(iw, "ex18");
  const paid = await bought(iw, a, "ex18-paid", { units: 40_000 });
  assert.deepEqual([paid.quote.quote.baseServiceCents, paid.quote.quote.totalCents], ["129500", "129500"], "the paid band: 129,500 cents");
  const ordersBefore = await iw.w.count("payment_orders");
  const capturesBefore = await iw.w.count("capture_facts");

  // before execution the agency corrects its source: CreateRevision, the seal, a new approval and CreateQuote for the new plan in the same band
  const plan = await replacementPlanOf(iw, a, paid, { units: 45_000, seed: "ex18-replacement" });
  const key = freshKey("ex18");
  const request = { url: `/api/v1/projects/${plan.projectId}/quotes`, token: a.billing.token, agency: a.s.agency.agencyId, key, body: { planId: plan.planId, billingProfileRef: a.s.profileId } };
  const reply = await call(iw.w, request);
  const view = completed<CreateQuoteView>(reply, 201).data;
  assert.deepEqual([view.replacement?.outcome, view.replacement?.replacedQuoteId, view.replacement?.revokedAuthorizationId], ["REBOUND", paid.purchase.quoteId, paid.purchase.authorizationId]);
  // the replacement carries exactly the paid terms: no order, no new fee
  assert.deepEqual([view.quote.state, view.quote.baseServiceCents, view.quote.serviceCents, view.quote.totalCents], ["ACCEPTED_FOR_CHECKOUT", "129500", "129500", "129500"]);
  assert.equal(await iw.w.count("payment_orders"), ordersBefore, "no order");
  assert.equal(await iw.w.count("capture_facts"), capturesBefore, "no new capture");

  // the authorization chain: the old entitlement REVOKED SOURCE_REPLACED and never reusable, the re-bound one ACTIVE on the new quote and approval
  const chain = await oracleRows<{ authorization_id: string; quote_id: string; state: string; revocation_code: string | null; approval_id: string; rebinding_id: string | null }>(
    iw,
    "SELECT authorization_id, quote_id, state, revocation_code, approval_id, rebinding_id FROM kauro.commercial_authorizations WHERE capture_id = $1 ORDER BY created_at",
    [paid.purchase.captureId],
  );
  assert.deepEqual(chain.map((c) => [c.quote_id, c.state, c.revocation_code]), [
    [paid.purchase.quoteId, "REVOKED", "SOURCE_REPLACED"],
    [view.quote.quoteId, "ACTIVE", null],
  ]);
  assert.equal(chain[0]!.authorization_id, paid.purchase.authorizationId);
  assert.notEqual(chain[0]!.approval_id, chain[1]!.approval_id, "the new approval, not the old one");
  assert.ok(chain[1]!.rebinding_id !== null, "the live entitlement is the re-bound one");
  assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS live FROM kauro.commercial_authorizations WHERE capture_id = $1 AND state = 'ACTIVE'", [paid.purchase.captureId]), [{ live: 1 }], "the only authority ExecuteProject can read is the re-bound entitlement");
  assert.equal((await call(iw.w, request)).text, replayTextOf(reply), "the replay answers the journaled 201 byte for byte");

  // control: the allowance is spent once — a second replacement in the same band writes nothing
  const second = await replacementPlanOf(iw, a, { purchase: paid.purchase, plan }, { units: 46_000, seed: "ex18-second" });
  const refused = await call(iw.w, { url: `/api/v1/projects/${second.projectId}/quotes`, token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey("ex18-second"), body: { planId: second.planId, billingProfileRef: a.s.profileId } });
  assert.equal(outcome(iw.w, refused), "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT");
  assert.equal(await iw.w.count("capture_facts"), capturesBefore);
  assert.equal((await oracleRows(iw, "SELECT 1 FROM kauro.purchase_rebindings WHERE capture_id = $1", [paid.purchase.captureId])).length, 1, "never re-bound twice");
});
test("R2-093: the larger scope is charged only after the paid purchase is refunded and a new quote is issued and explicitly accepted by CreatePaymentOrder; no capture ever covers the difference silently", async () => {
  await assertCohortConsumed(iw);
  const a = await agentOf(iw, "ex18-larger");
  const paid = await bought(iw, a, "ex18-larger-paid", { units: 50_000 });
  assert.equal(paid.quote.quote.baseServiceCents, "129500");
  const capturesBefore = await iw.w.count("capture_facts");
  const ordersBefore = await iw.w.count("payment_orders");

  // a corrected revision of 50,001 billable units is the next band, 199,500 cents: the replacement is refused with the price comparison
  // and nothing is charged, ordered or captured for the difference
  const larger = await replacementPlanOf(iw, a, paid, { units: 50_001, seed: "ex18-larger" });
  const refused = await call(iw.w, { url: `/api/v1/projects/${larger.projectId}/quotes`, token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey("ex18-larger"), body: { planId: larger.planId, billingProfileRef: a.s.profileId } });
  assert.equal(outcome(iw.w, refused), "409 PRECONDITION_FAILED REPLACEMENT_SCOPE_CHANGED");
  assert.deepEqual((asProblem(iw.w, refused).current as { mismatch?: unknown } | undefined)?.mismatch, ["baseServiceCents", "paid129500", "replacement199500"]);
  assert.equal(await iw.w.count("capture_facts"), capturesBefore, "no capture covers the difference");
  assert.equal(await iw.w.count("payment_orders"), ordersBefore, "no order");

  // the paid purchase is refunded in full through the public commands, then the larger scope is quoted anew and explicitly accepted
  const refund = await refundedThrough(iw, a, paid.purchase, 129_500n);
  const quote = await quoted(iw, a, larger);
  assert.deepEqual([quote.quote.baseServiceCents, quote.quote.discountCents, quote.quote.serviceCents, quote.quote.state], ["199500", "0", "199500", "ISSUED"]);
  const next = await paidThrough(iw, a, quote);
  assert.deepEqual([next.order.order.expectedAmountCents, next.captured.capture?.amountCents], ["199500", "199500"]);

  // the rows in order: the refund completed, the new quote issued, the order created, the new capture observed — one capture per quote, each for its own total
  const timeline = await oracleRows<{ what: string; at: Date }>(
    iw,
    `SELECT 'REFUND' AS what, completed_at AS at FROM kauro.refunds WHERE refund_id = $1
     UNION ALL SELECT 'QUOTE', issued_at FROM kauro.quotes WHERE quote_id = $2
     UNION ALL SELECT 'ORDER', created_at FROM kauro.payment_orders WHERE quote_id = $2
     UNION ALL SELECT 'CAPTURE', observed_at FROM kauro.capture_facts WHERE capture_id = $3
     ORDER BY at`,
    [refund.refundId, quote.quote.quoteId, next.purchase.captureId],
  );
  assert.deepEqual(timeline.map((t) => t.what), ["REFUND", "QUOTE", "ORDER", "CAPTURE"]);
  const captures = await oracleRows<{ capture_id: string; amount_cents: string }>(iw, "SELECT capture_id, amount_cents::text FROM kauro.capture_facts WHERE order_id = ANY (SELECT order_id FROM kauro.payment_orders WHERE agency_id = $1) ORDER BY observed_at", [a.s.agency.agencyId]);
  assert.deepEqual(captures.map((c) => c.amount_cents), ["129500", "199500"]);
});
test("R2-095 (example 12): after AssignAccount moves A's acquired agency to seller B, the agency's next purchase inside A's window accrues A's 400-bps line and no line for B; B's assistance agreement signed before a later order accrues B's own 400-bps pool beside A's, never reducing it", async () => {
  await assertCohortConsumed(iw);
  const owner = iw.owner.userId as UserId;
  const a = await agentOf(iw, "ex12");
  const acquired = await claimed(iw, "ex12-a");
  const A = acquired.sellers[0]!;
  await acceptedThrough(iw, a.s.agency.agencyId, acquired, [10_000]);

  // seller A acquired the agency: its first purchase (no founding slot is left: 129,500 undiscounted) accrues 129,500 x 1000 bps = 12,950
  const first = await bought(iw, a, "ex12-first", { units: 50_000 });
  assert.deepEqual([first.quote.quote.serviceCents, first.quote.quote.discount.basis], ["129500", "NONE"]);
  await dispatched(iw);
  const [firstLine] = await linesOf(iw, first.purchase.authorizationId);
  assert.deepEqual([firstLine?.seller_id, firstLine?.cumulative_entitlement_cents], [A.sellerId, "12950"]);

  // the owner opens the agency's account with A, then moves it to seller B (AssignAccount through its route, both service assignments prepared)
  const B = await seller(iw, "ex12-b");
  const opened = await assignedThrough(iw, a.s.agency.agencyId, { expectedVersion: 0, sellerId: A.sellerId, serviceAssignmentRef: await recordServiceAssignment(iw.h, { ownerUserId: owner, agencyId: a.s.agency.agencyId, sellerId: A.sellerId }) });
  assert.deepEqual([opened.version, opened.sellerId], [1, A.sellerId]);
  const moved = await assignedThrough(iw, a.s.agency.agencyId, { expectedVersion: 1, sellerId: B.sellerId, serviceAssignmentRef: await recordServiceAssignment(iw.h, { ownerUserId: owner, agencyId: a.s.agency.agencyId, sellerId: B.sellerId }) });
  assert.deepEqual([moved.version, moved.sellerId, moved.newWorkCompensation], [2, B.sellerId, "NONE"]);

  // the next purchase, inside A's window: one more project, a recurrence discount of 500 bps (6,475 exactly) so 123,025, and A's 400-bps
  // line of 123,025 x 400 bps = 4,921 exactly; B signed nothing before the order, so B accrues nothing
  const next = await bought(iw, a, "ex12-next", { units: 50_000 });
  assert.deepEqual([next.quote.quote.serviceCents, next.quote.quote.discount.bps, next.quote.quote.discount.basis], ["123025", 500, "REPEAT"]);
  await dispatched(iw);
  assert.deepEqual(
    (await poolsOf(iw, next.purchase.authorizationId)).map((p) => [p.source, p.rate_kind, p.rate_bps, p.basis_cents, p.pool_cents]),
    [["ACQUISITION", "REPEAT", 400, "123025", "4921"]],
  );
  assert.deepEqual((await linesOf(iw, next.purchase.authorizationId)).map((l) => [l.seller_id, l.cumulative_entitlement_cents]), [[A.sellerId, "4921"]]);
  assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS lines FROM kauro.commission_lines WHERE seller_id = $1", [B.sellerId]), [{ lines: 0 }], "no line for B");

  // B's assistance agreement for the agency's next purchase is signed before a later order: that purchase accrues B's own 400-bps pool
  // beside A's, 4,921 each, A's never reduced
  const assistance = await recordAssistanceAgreement(iw.h, { ownerUserId: owner, agencyId: a.s.agency.agencyId, seller: B, scope: "NEXT_PURCHASE" });
  const later = await bought(iw, a, "ex12-later", { units: 50_000 });
  assert.equal(later.quote.quote.serviceCents, "123025");
  await dispatched(iw);
  assert.deepEqual(
    (await poolsOf(iw, later.purchase.authorizationId)).map((p) => [p.source, p.rate_kind, p.rate_bps, p.basis_cents, p.pool_cents]),
    [
      ["ACQUISITION", "REPEAT", 400, "123025", "4921"],
      ["ASSISTANCE", "ASSISTANCE", 400, "123025", "4921"],
    ],
  );
  assert.deepEqual(
    (await linesOf(iw, later.purchase.authorizationId)).map((l) => [l.seller_id, l.cumulative_entitlement_cents]).sort(),
    [[A.sellerId, "4921"], [B.sellerId, "4921"]].sort(),
  );
  assert.deepEqual(await oracleRows(iw, "SELECT assistance_agreement_id FROM kauro.commission_pools WHERE authorization_id = $1 AND source = 'ASSISTANCE'", [later.purchase.authorizationId]), [{ assistance_agreement_id: assistance }]);
  // A's acquisition entitlement, allocation and earlier lines are as they were
  assert.deepEqual(await oracleRows(iw, "SELECT cumulative_entitlement_cents::text AS cents FROM kauro.commission_lines WHERE line_id = $1", [firstLine!.line_id]), [{ cents: "12950" }]);
});
test("R2-098 (example 3): after the window the agency's next project is still quoted at its 500-bps recurrence discount, its capture accrues nothing for the seller, and the seller's earlier ELIGIBLE line is paid on the next statement", async () => {
  await assertCohortConsumed(iw);
  const a = await agentOf(iw, "ex3");
  const acquired = await claimed(iw, "ex3");
  const S = acquired.sellers[0]!;
  await acceptedThrough(iw, a.s.agency.agencyId, acquired, [10_000]);

  // the agency's first two projects, inside the window, through the public commands: 129,500 x 1000 bps = 12,950; then 123,025 x 400 bps = 4,921
  const first = await bought(iw, a, "ex3-first", { units: 50_000 });
  const second = await bought(iw, a, "ex3-second", { units: 50_000 });
  assert.deepEqual([first.quote.quote.serviceCents, second.quote.quote.serviceCents], ["129500", "123025"]);
  await dispatched(iw);
  const [firstLine] = await linesOf(iw, first.purchase.authorizationId);
  const [secondLine] = await linesOf(iw, second.purchase.authorizationId);
  assert.deepEqual([firstLine?.cumulative_entitlement_cents, secondLine?.cumulative_entitlement_cents], ["12950", "4921"]);
  await madeEligible(iw, a.s.agency.agencyId, first.purchase);
  assert.equal((await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.commission_lines WHERE line_id = $1", [firstLine!.line_id]))[0]?.state, "ELIGIBLE");

  // the window of twelve calendar months ends; the next project is still quoted at its recurrence discount: two qualifying projects are
  // still the 500-bps tier (the next tier starts at ten), 129,500 less 6,475 exactly is 123,025
  const [window] = await oracleRows<{ window_ends_at: Date }>(iw, "SELECT window_ends_at FROM kauro.commission_entitlements WHERE agency_id = $1", [a.s.agency.agencyId]);
  const third = await quoted(iw, a, await planOf(iw, a, "ex3-third", { units: 50_000 }));
  assert.deepEqual([third.quote.baseServiceCents, third.quote.discountCents, third.quote.serviceCents, third.quote.discount.bps, third.eligibility.qualifyingProjectCount], ["129500", "6475", "123025", 500, 2]);
  const order = await orderedThrough(iw, a, third);
  // its capture is confirmed a day after the window's end, the provider's authenticated completion exactly at it (the labelled TEST CLOCK)
  const endsAt = window!.window_ends_at.getTime();
  const purchase = await capturedLater(iw, a, third, order, { confirmedAt: new Date(endsAt + 86_400_000).toISOString(), providerCompletedAt: new Date(endsAt).toISOString() });
  await dispatched(iw);
  assert.deepEqual(await poolsOf(iw, purchase.authorizationId), [], "no acquisition pool, and no assistance pool without a prior agreement");
  assert.deepEqual(await linesOf(iw, purchase.authorizationId), [], "nothing accrues for the seller");
  assert.deepEqual(await oracleRows(iw, "SELECT confirmation_seq FROM kauro.qualifying_purchases WHERE authorization_id = $1", [purchase.authorizationId]), [{ confirmation_seq: 3 }], "still the agency's third qualifying purchase");
  assert.deepEqual(await oracleRows(iw, "SELECT cumulative_entitlement_cents::text AS cents, state FROM kauro.commission_lines WHERE line_id = ANY ($1::uuid[]) ORDER BY cents", [[firstLine!.line_id, secondLine!.line_id]]), [{ cents: "12950", state: "ELIGIBLE" }, { cents: "4921", state: "ACCRUED_PENDING" }], "the earned lines keep their path");

  // the next statement pays the earlier ELIGIBLE line: 12,950 payable, the second project's 4,921 still awaiting its final completion
  const { view } = await closedAt(iw, "2026-05", "2026-10-07T17:00:00Z");
  assert.equal(view.payableTotalCents, "12950", "of every seller's statement of the close, only this seller has a line due (the others' lines still await their completions)");
  const [statement] = await statementsOfSeller(iw, S.sellerId);
  assert.ok(statement !== undefined);
  const reads = await statementReads(iw, statement!.statement_id, S.person.token);
  assert.deepEqual(reads.owner, reads.seller);
  assert.deepEqual(reads.seller.items.map((i) => [i.lineId === firstLine!.line_id ? "FIRST" : "SECOND", i.cumulativeEntitlementCents, i.payableCents]), [["FIRST", "12950", "12950"], ["SECOND", "4921", "0"]]);
  assert.deepEqual([reads.seller.payableCents, reads.seller.heldCents], ["12950", "0"]);

  // the owner approves the payout: one AUTHORIZED intent of exactly the payable; the finance service reconciles the bank's evidence: the line PAID
  await bankCash(iw, (await claimedCents(iw)) + 12_950n);
  const approved = completed<PayoutIntentView>(await approvePayout(iw, statement!.statement_id, { expectedVersion: Number(statement!.version), payeeRef: S.destinationId, authorizationRef: await iw.w.stepUp(iw.owner) }), 200);
  assert.deepEqual([approved.data.state, approved.data.amountCents, approved.data.statementState], ["AUTHORIZED", "12950", "APPROVED"]);
  const intent = await intentOf(iw, statement!.statement_id);
  const evidence = iw.payouts.matching({ reference: intent.reference, destinationDigest: intent.destinationDigest, amountCents: intent.amount, currency: intent.currency }, "SETTLED");
  const settled = completed<PayoutReconciliationView>(await reconcilePayout(iw, statement!.statement_id, { providerPayoutEvidenceRef: scriptEvidence(iw, evidence) }), 200);
  assert.deepEqual([settled.data.intentState, settled.data.statementState, settled.data.linesPaid], ["SETTLED", "PAID", 1]);
  assert.deepEqual(await oracleRows(iw, "SELECT state, paid_cents::text FROM kauro.commission_lines WHERE line_id = $1", [firstLine!.line_id]), [{ state: "PAID", paid_cents: "12950" }]);
});
test("R2-100: an enumerated opportunity's first purchase inside the tail converts its claim and creates the departed seller's entitlement; a first purchase after the tail's end or of an unlisted agency creates none", async () => {
  await assertCohortConsumed(iw);
  const D = await seller(iw, "ex13-d");
  // three accepted opportunities of the seller: two it hands over (X, Y) and one it does not (Z)
  const x = await opportunityOf(iw, D, "ex13-x");
  const y = await opportunityOf(iw, D, "ex13-y");
  const z = await opportunityOf(iw, D, "ex13-z");
  const done = await terminatedThrough(iw, D.sellerId, await terminationBody(iw, D.sellerId, [x.claimId, y.claimId]));
  assert.equal(done.tailEntries, 2);
  const [tail] = await oracleRows<{ ends_at: Date }>(iw, "SELECT max(ends_at) AS ends_at FROM kauro.termination_tail_entries WHERE seller_id = $1", [D.sellerId]);
  assert.equal(tail!.ends_at.getTime(), Date.parse(done.tailEndsAt));
  const claimStates = async () => Object.fromEntries((await oracleRows<{ claim_id: string; state: string }>(iw, "SELECT claim_id, state FROM kauro.attribution_claims WHERE claim_id = ANY ($1::uuid[])", [[x.claimId, y.claimId, z.claimId]])).map((c) => [c.claim_id, c.state]));
  assert.deepEqual(await claimStates(), { [x.claimId]: "ACCEPTED", [y.claimId]: "ACCEPTED", [z.claimId]: "EXPIRED" }, "the listed claims run on for their tail; the unlisted one lapsed with the termination");

  // X: the first purchase inside the tail (the public commands, now): the claim converts and the departed seller's entitlement is created,
  // with the pool 129,500 x 1000 bps = 12,950 (no founding slot is left) and its line
  const paidX = await bought(iw, x.a, "ex13-x", { units: 50_000 });
  assert.equal(paidX.quote.quote.serviceCents, "129500");
  await dispatched(iw);
  assert.equal((await claimStates())[x.claimId], "CONVERTED");
  const entitlements = (agencyId: string) => oracleRows<{ seller_id: string; state: string; kind: string }>(iw, "SELECT seller_id, state, kind FROM kauro.commission_entitlements WHERE agency_id = $1", [agencyId]);
  assert.deepEqual((await entitlements(x.a.s.agency.agencyId)).map((e) => [e.seller_id, e.kind]), [[D.sellerId, "ACQUISITION"]]);
  assert.deepEqual((await linesOf(iw, paidX.purchase.authorizationId)).map((l) => [l.seller_id, l.rate_bps, l.cumulative_entitlement_cents]), [[D.sellerId, 1000, "12950"]]);

  // Y: the first purchase after the tail's end — the order is accepted now and the payment service confirms the capture a day after the
  // tail ended (the labelled TEST CLOCK): no entitlement, no pool, no line
  const quoteY = await quoted(iw, y.a, await planOf(iw, y.a, "ex13-y", { units: 50_000 }));
  const orderY = await orderedThrough(iw, y.a, quoteY);
  const purchaseY = await capturedLater(iw, y.a, quoteY, orderY, { confirmedAt: new Date(tail!.ends_at.getTime() + 86_400_000).toISOString(), providerCompletedAt: new Date(tail!.ends_at.getTime() + 3_600_000).toISOString() });
  await dispatched(iw);
  assert.deepEqual(await entitlements(y.a.s.agency.agencyId), []);
  assert.deepEqual(await poolsOf(iw, purchaseY.authorizationId), []);
  assert.deepEqual(await linesOf(iw, purchaseY.authorizationId), []);
  assert.notEqual((await claimStates())[y.claimId], "CONVERTED");

  // Z: the unlisted opportunity buys inside what would have been its window: its claim lapsed at the termination, so nothing converts
  const paidZ = await bought(iw, z.a, "ex13-z", { units: 50_000 });
  await dispatched(iw);
  assert.deepEqual(await entitlements(z.a.s.agency.agencyId), []);
  assert.deepEqual(await poolsOf(iw, paidZ.purchase.authorizationId), []);
  assert.deepEqual(await linesOf(iw, paidZ.purchase.authorizationId), []);
  assert.equal((await claimStates())[z.claimId], "EXPIRED");
  // nothing of the ledger was deleted: the one line of X is the seller's only
  assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS lines FROM kauro.commission_lines WHERE seller_id = $1", [D.sellerId]), [{ lines: 1 }]);
});
test("R2-104 (examples 7 and 25): a 20000-cent service refund after the seller was paid 4921 posts -800, the line PAID to ADJUSTED, and the next statement shows the original accrual, the payout, the adjustment and the -800 balance with its project and reason; no port can debit the seller", async () => {
  await assertCohortConsumed(iw);
  const a = await agentOf(iw, "ex7");
  const acquired = await claimed(iw, "ex7");
  const P = acquired.sellers[0]!;
  await acceptedThrough(iw, a.s.agency.agencyId, acquired, [10_000]);

  // the agency's first project accrues 12,950 and stays pending; its second, 123,025 x 400 bps = 4,921, is the one the seller is paid
  const first = await bought(iw, a, "ex7-first", { units: 50_000 });
  const second = await bought(iw, a, "ex7-second", { units: 50_000 });
  assert.deepEqual([first.quote.quote.serviceCents, second.quote.quote.serviceCents], ["129500", "123025"]);
  await dispatched(iw);
  const [firstLine] = await linesOf(iw, first.purchase.authorizationId);
  const [line] = await linesOf(iw, second.purchase.authorizationId);
  assert.deepEqual([firstLine?.cumulative_entitlement_cents, line?.cumulative_entitlement_cents], ["12950", "4921"]);
  await madeEligible(iw, a.s.agency.agencyId, second.purchase);

  // the first statement pays 4,921: approved by the owner, settled by the bank's evidence
  const closed = await closedAt(iw, "2026-04", "2026-10-07T17:00:00Z");
  assert.equal(closed.view.payableTotalCents, "4921");
  const [paidStatement] = await statementsOfSeller(iw, P.sellerId);
  await bankCash(iw, (await claimedCents(iw)) + 4_921n);
  completed<PayoutIntentView>(await approvePayout(iw, paidStatement!.statement_id, { expectedVersion: Number(paidStatement!.version), payeeRef: P.destinationId, authorizationRef: await iw.w.stepUp(iw.owner) }), 200);
  const intent = await intentOf(iw, paidStatement!.statement_id);
  const evidence = iw.payouts.matching({ reference: intent.reference, destinationDigest: intent.destinationDigest, amountCents: intent.amount, currency: intent.currency }, "SETTLED");
  completed<PayoutReconciliationView>(await reconcilePayout(iw, paidStatement!.statement_id, { providerPayoutEvidenceRef: scriptEvidence(iw, evidence) }), 200);
  assert.deepEqual(await oracleRows(iw, "SELECT state, paid_cents::text, cumulative_entitlement_cents::text AS cumulative FROM kauro.commission_lines WHERE line_id = $1", [line!.line_id]), [{ state: "PAID", paid_cents: "4921", cumulative: "4921" }]);

  // the customer is refunded 20,000 service cents of the second project through the public commands: 103,025 x 400 bps = 4,121, so the line
  // falls by 800 below what was paid — one -800 adjustment, the line PAID to ADJUSTED, the cents paid untouched
  await refundedThrough(iw, a, second.purchase, 20_000n);
  await dispatched(iw);
  assert.deepEqual(
    await oracleRows(iw, "SELECT direction, amount_cents::text, new_cumulative_entitlement_cents::text AS cumulative, new_basis_cents::text AS basis, reason FROM kauro.commission_adjustments WHERE line_id = $1", [line!.line_id]),
    [{ direction: "DECREASE", amount_cents: "800", cumulative: "4121", basis: "103025", reason: "REFUND" }],
  );
  assert.deepEqual(await oracleRows(iw, "SELECT state, paid_cents::text, cumulative_entitlement_cents::text AS cumulative FROM kauro.commission_lines WHERE line_id = $1", [line!.line_id]), [{ state: "ADJUSTED", paid_cents: "4921", cumulative: "4121" }]);

  // the next statement shows the original accrual (the first statement, immutable: 4,921 payable), the payout (previously paid 4,921), the
  // adjustment (-800 on the project) and the 800-cent balance as the owner's repayment review — nothing payable, nothing debited
  const next = await closedAt(iw, "2026-03", "2026-11-20T17:00:00Z");
  assert.equal(next.view.payableTotalCents, "0");
  const all = await statementsOfSeller(iw, P.sellerId);
  assert.equal(all.length, 2);
  const statements = [closed.periodId, next.periodId].map((periodId) => all.find((x) => x.period_id === periodId)!);
  const original = await statementReads(iw, statements[0]!.statement_id, P.person.token);
  assert.deepEqual(original.seller.items.filter((i) => i.lineId === line!.line_id).map((i) => [i.cumulativeEntitlementCents, i.payableCents]), [["4921", "4921"]]);
  const later = await statementReads(iw, statements[1]!.statement_id, P.person.token);
  assert.deepEqual(later.owner, later.seller);
  assert.deepEqual(
    later.seller.items.filter((i) => i.lineId === line!.line_id).map((i) => [i.projectId, i.netServiceBasisCents, i.cumulativeEntitlementCents, i.previouslyPaidCents, i.adjustmentCents, i.adjustmentDirection, i.payableCents]),
    [[second.purchase.projectId, "103025", "4121", "4921", "800", "DECREASE", "0"]],
  );
  assert.deepEqual(later.seller.balanceItems, [{ kind: "REPAYMENT_REVIEW", lineId: line!.line_id, amountCents: "800" }]);
  assert.deepEqual([later.seller.payableCents, later.seller.heldCents], ["0", "0"]);
  assert.deepEqual(await oracleRows(iw, "SELECT negative_balance_cents::text AS negative FROM kauro.commission_statements WHERE statement_id = $1", [statements[1]!.statement_id]), [{ negative: "800" }]);

  // no port can debit the seller: the approval of the later statement is NOTHING_PAYABLE, no intent of any sign exists beyond the one payout,
  // the database refuses a non-positive intent, and no port of the platform has a method that collects from a seller
  const refused = await approvePayout(iw, statements[1]!.statement_id, { expectedVersion: Number(statements[1]!.version), payeeRef: P.destinationId, authorizationRef: await iw.w.stepUp(iw.owner) });
  assert.equal(outcome(iw.w, refused), "409 PRECONDITION_FAILED NOTHING_PAYABLE");
  assert.deepEqual(await oracleRows(iw, "SELECT amount_cents::text AS cents, state FROM kauro.payout_intents WHERE statement_id = ANY ($1::uuid[]) ORDER BY authorized_at", [statements.map((x) => x.statement_id)]), [{ cents: "4921", state: "SETTLED" }]);
  assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS guards FROM pg_constraint WHERE conrelid = 'kauro.payout_intents'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%amount_cents > 0%'"), [{ guards: 1 }], "an intent is of a positive amount");
  const surface = [iw.payouts, iw.calendar, iw.completions].flatMap((port) => Object.getOwnPropertyNames(Object.getPrototypeOf(port) as object));
  assert.ok(surface.length > 0);
  assert.deepEqual(surface.filter((name) => /debit|charge|clawback|collect|recover|pull|bill/i.test(name)), [], "no port of the commission service can take money from a seller");
});
test("R2-137 (example 9): two projects' capture reconciliations of one agency held at the designation trigger in both interleavings end with one first project, one 1000-bps and one 400-bps pool and the same final statement projection", async () => {
  await assertCohortConsumed(iw);
  const PAYMENT_POOL = `${PAYMENT_APPLICATION_NAME}-service`;
  // two projects X and Y of one agency, both quoted and ordered through the public commands before either is captured; the provider
  // captures both and reports them through the webhook (CMD030). In each interleaving one capture reconciliation is held inside the
  // payment service just before COMMIT, after its authorization was designated, while the other waits on the agency's recurrence lock
  // (observed in pg_stat_activity): X first, then Y first. The one confirmed first is P; the one that waited is Q, whose provider
  // completion is the earlier one.
  const finals: Array<ReadonlyArray<ReadonlyArray<string>>> = [];
  const purchases: Array<{ readonly a: Agent; readonly p: Purchase; readonly q: Purchase }> = [];
  for (const interleaving of ["X_FIRST", "Y_FIRST"] as const) {
    const label = `ex9-${interleaving === "X_FIRST" ? "x" : "y"}`;
    const a = await agentOf(iw, label);
    const acquired = await claimed(iw, label);
    await acceptedThrough(iw, a.s.agency.agencyId, acquired, [10_000]);
    const quoteX = await quoted(iw, a, await planOf(iw, a, `${label}-X`, { units: 50_000 }));
    const quoteY = await quoted(iw, a, await planOf(iw, a, `${label}-Y`, { units: 50_000 }));
    assert.deepEqual([quoteX.quote.serviceCents, quoteY.quote.serviceCents], ["129500", "129500"], "both quoted before either was captured: no recurrence discount");
    const orderX = await orderedThrough(iw, a, quoteX);
    const orderY = await orderedThrough(iw, a, quoteY);
    const [first, second] = interleaving === "X_FIRST" ? [{ quote: quoteX, order: orderX }, { quote: quoteY, order: orderY }] : [{ quote: quoteY, order: orderY }, { quote: quoteX, order: orderX }];
    // the provider captures both after both orders were created (plausible): Q's capture ten milliseconds before P's, on the provider fake's own clock
    const providerOf = (o: CreatePaymentOrderView): string => {
      iw.pw.paypal.approve(o.order.providerOrderId!);
      return iw.pw.paypal.captureAtProvider(o.order.providerOrderId!);
    };
    const providerQ = providerOf(second.order);
    iw.pw.providerClock.advance(10);
    const providerP = providerOf(first.order);

    const pHeld = iw.pw.holds.arm("CMD030", "APPLICATION_BEFORE_COMMIT", "WAIT");
    const pDelivery = handled(deliver(iw.pw, "PAYMENT.CAPTURE.COMPLETED", providerP));
    await pHeld.reached;
    const qDelivery = handled(deliver(iw.pw, "PAYMENT.CAPTURE.COMPLETED", providerQ));
    const waiting = await waitForLockWait(iw.h.oracle, PAYMENT_POOL, "commercial_authorizations");
    assert.ok(waiting > 0, `${interleaving}: Q's designation waits on P's, observed in pg_stat_activity`);
    pHeld.release();
    for (const d of [await pDelivery, await qDelivery]) assert.equal(completed<WebhookAck>(d.reply, 200).data.inboxState, "APPLIED");
    const P = await webhookPurchase(iw, first.quote, first.order, providerP);
    const Q = await webhookPurchase(iw, second.quote, second.order, providerQ);

    const pEvent = await eventOf(iw, P.captureId, "capture.completed.v1");
    const qEvent = await eventOf(iw, Q.captureId, "capture.completed.v1");
    if (interleaving === "Y_FIRST") {
      // the late observation: COMMISSIONS receives Q's completion before P's
      assert.equal(await iw.service.consumer.handle(await deliveryOf(iw, qEvent)), "APPLIED");
    }
    const seen = new Map((await dispatched(iw)).filter((d) => d.eventId === pEvent || d.eventId === qEvent).map((d) => [d.eventId, d.outcome]));
    assert.deepEqual([seen.get(pEvent), seen.get(qEvent)], interleaving === "X_FIRST" ? ["APPLIED", "APPLIED"] : ["APPLIED", "DUPLICATE"]);

    // one first project, one 1000-bps pool (129,500 x 1000 bps = 12,950) and one 400-bps pool (129,500 x 400 bps = 5,180)
    const sequence = async (p: Purchase) => (await oracleRows<{ confirmation_seq: number; provider_completed_at: Date }>(iw, "SELECT confirmation_seq, provider_completed_at FROM kauro.qualifying_purchases WHERE authorization_id = $1", [p.authorizationId]))[0]!;
    assert.deepEqual([(await sequence(P)).confirmation_seq, (await sequence(Q)).confirmation_seq], [1, 2]);
    const [providerCompletedP, providerCompletedQ] = [(await sequence(P)).provider_completed_at.getTime(), (await sequence(Q)).provider_completed_at.getTime()];
    assert.ok(providerCompletedQ + 10 <= providerCompletedP, "each provider completion recorded as reported: Q's is the earlier by the ten milliseconds the provider fake's clock advanced");
    assert.deepEqual((await poolsOf(iw, P.authorizationId)).map((p) => [p.source, p.rate_kind, p.rate_bps, p.basis_cents, p.pool_cents]), [["ACQUISITION", "FIRST", 1000, "129500", "12950"]]);
    assert.deepEqual((await poolsOf(iw, Q.authorizationId)).map((p) => [p.source, p.rate_kind, p.rate_bps, p.basis_cents, p.pool_cents]), [["ACQUISITION", "REPEAT", 400, "129500", "5180"]]);
    assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS n FROM kauro.commission_pools WHERE agency_id = $1 AND rate_kind = 'FIRST'", [a.s.agency.agencyId]), [{ n: 1 }], "never a second 1000-bps pool");
    assert.deepEqual(await oracleRows(iw, "SELECT first_qualifying_capture_id FROM kauro.agencies WHERE agency_id = $1", [a.s.agency.agencyId]), [{ first_qualifying_capture_id: P.captureId }]);
    purchases.push({ a, p: P, q: Q });
  }

  // the same final statement projection in both runs: both lines of both agencies made ELIGIBLE, one period closed through CMD051, and each
  // seller's statement read through GetCommissionStatement as owner and seller
  for (const { a, p, q } of purchases) {
    await madeEligible(iw, a.s.agency.agencyId, p);
    await madeEligible(iw, a.s.agency.agencyId, q);
  }
  await closedAt(iw, "2026-02", "2026-10-07T17:00:00Z");
  for (const { p } of purchases) {
    const [line] = await oracleRows<{ seller_id: string }>(iw, "SELECT seller_id FROM kauro.commission_lines WHERE authorization_id = $1", [p.authorizationId]);
    const sellerPerson = (await oracleRows<{ statement_id: string }>(iw, "SELECT statement_id FROM kauro.commission_statements WHERE seller_id = $1", [line!.seller_id]))[0]!;
    const projection = (await statementReads(iw, sellerPerson.statement_id, iw.owner.token)).owner;
    finals.push(projection.items.map((i) => [i.sequence, i.netServiceBasisCents, String(i.rateBps), i.cumulativeEntitlementCents, i.payableCents]).sort());
  }
  assert.deepEqual(finals[0], [["FIRST", "129500", "1000", "12950", "12950"], ["REPEAT", "129500", "400", "5180", "5180"]], "the statement lines, in cents written here");
  assert.deepEqual(finals[1], finals[0], "the same final statement projection in both interleavings");
});
test("CMD050-RACE: TerminateSeller racing AcceptAttribution of the seller's unlisted claim, held at the seller row, serializes in both orders — acceptance first: the claim is ACCEPTED, then EXPIRED as unlisted by the termination; termination first: the claim is EXPIRED and AcceptAttribution is 409 CLAIM_NOT_REVIEWABLE — and no live claim of a terminated seller remains", async () => {
  // TerminateSeller (CMD050) and AcceptAttribution (CMD047) of one of the seller's claims it does not hand over, both through their routes:
  // the first to reach its journal commit is held there (the hold point) with the claim's transition lock taken; the second waits on that lock,
  // observed in pg_stat_activity — the seller row itself is only read by AcceptAttribution, so the serialization point both orders share is the claim
  for (const order of ["ACCEPT_FIRST", "TERMINATE_FIRST"] as const) {
    const label = `race-${order === "ACCEPT_FIRST" ? "a" : "t"}`;
    const D = await seller(iw, label);
    const a = await agentOf(iw, label);
    const prospect = await recordProspect(iw.h, { by: D, domain: `${label}.example` });
    const { claimId } = await recordClaim(iw.h, { seller: D, prospectId: prospect.prospectId });
    const allocationId = await prepareAllocation(iw.h, { ownerUserId: iw.owner.userId, agencyId: a.s.agency.agencyId, prospectId: prospect.prospectId, shares: [{ seller: D, claimId, shareBps: 10_000 }] });
    const termination = await terminationBody(iw, D.sellerId, []);
    const accept = (): Promise<Reply> => call(iw.w, { url: `/api/v1/sales/claims/${claimId}/accept`, token: iw.owner.token, agency: null, key: freshKey("int-race-accept"), body: { expectedVersion: 1, shareAllocationRef: allocationId } });
    const terminate = (): Promise<Reply> => call(iw.w, { url: `/api/v1/sales/sellers/${D.sellerId}/terminate`, token: iw.owner.token, agency: null, key: freshKey("int-race-terminate"), body: termination });

    const hold = iw.w.holds.arm("journal.commit");
    const winner = handled(order === "ACCEPT_FIRST" ? accept() : terminate());
    await hold.reached;
    const loser = handled(order === "ACCEPT_FIRST" ? terminate() : accept());
    try {
      assert.ok((await waitForApiLockWait(iw.w, "pg_advisory_xact_lock(kauro.transition_key('kauro.attribution_claims'")) > 0, `${order}: the second command waits on the claim's transition lock, observed in pg_stat_activity`);
    } finally {
      hold.release();
    }
    const [won, lost] = [await winner, await loser];
    const claim = async () => (await oracleRows<{ state: string; allocation_id: string | null }>(iw, "SELECT state, allocation_id FROM kauro.attribution_claims WHERE claim_id = $1", [claimId]))[0]!;
    const allocation = async () => (await oracleRows<{ frozen: boolean }>(iw, "SELECT frozen_at IS NOT NULL AS frozen FROM kauro.attribution_allocations WHERE allocation_id = $1", [allocationId]))[0]!;
    if (order === "ACCEPT_FIRST") {
      // acceptance first: the claim is ACCEPTED under the frozen allocation, then EXPIRED as unlisted by the termination
      assert.equal(completed<AttributionView>(won, 200).data.claim.state, "ACCEPTED");
      completed<SellerTerminationView>(lost, 200);
      assert.deepEqual(await claim(), { state: "EXPIRED", allocation_id: allocationId });
      assert.deepEqual(await allocation(), { frozen: true });
    } else {
      // termination first: the claim is EXPIRED and AcceptAttribution is refused, the allocation never frozen
      completed<SellerTerminationView>(won, 200);
      // the version check precedes the state check (B06's compare-and-set): the request made on the version the owner had read is stale and
      // names the claim's current state; the owner's retry on that version is the 409 CLAIM_NOT_REVIEWABLE (decision D10-INT-1)
      assert.equal(outcome(iw.w, lost), "409 STALE_VERSION -");
      const current = asProblem(iw.w, lost).current as { readonly version: number; readonly state: string };
      assert.equal(current.state, "EXPIRED");
      const retried = await call(iw.w, { url: `/api/v1/sales/claims/${claimId}/accept`, token: iw.owner.token, agency: null, key: freshKey("int-race-retry"), body: { expectedVersion: current.version, shareAllocationRef: allocationId } });
      assert.equal(outcome(iw.w, retried), "409 PRECONDITION_FAILED CLAIM_NOT_REVIEWABLE");
      assert.deepEqual(await claim(), { state: "EXPIRED", allocation_id: null });
      assert.deepEqual(await allocation(), { frozen: false });
    }
    // in both runs the seller is TERMINATED and no live claim of it remains
    assert.deepEqual(await oracleRows(iw, "SELECT state FROM kauro.sellers WHERE seller_id = $1", [D.sellerId]), [{ state: "TERMINATED" }]);
    assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS live FROM kauro.attribution_claims WHERE seller_id = $1 AND state IN ('SUBMITTED', 'ACCEPTED')", [D.sellerId]), [{ live: 0 }], "no live claim of a terminated seller remains");
    assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS entitlements FROM kauro.commission_entitlements WHERE seller_id = $1", [D.sellerId]), [{ entitlements: 0 }]);
  }

  // every scenario of the file has settled: one whole cycle of the commission service — the five sweeps and PERIODS — finds nothing to repair
  await dispatched(iw);
  const census = async () =>
    oracleRows(
      iw,
      `SELECT (SELECT count(*) FROM kauro.commission_pools)::int AS pools, (SELECT count(*) FROM kauro.commission_adjustments)::int AS adjustments,
              (SELECT count(*) FROM kauro.commission_holds)::int AS holds, (SELECT count(*) FROM kauro.commission_statements)::int AS statements,
              (SELECT count(*) FROM kauro.payout_intents)::int AS intents,
              (SELECT md5(string_agg(line_id::text || state || version::text, ',' ORDER BY line_id)) FROM kauro.commission_lines) AS lines,
              (SELECT md5(string_agg(claim_id::text || state || version::text, ',' ORDER BY claim_id)) FROM kauro.attribution_claims) AS claims,
              (SELECT md5(string_agg(entitlement_id::text || state, ',' ORDER BY entitlement_id)) FROM kauro.commission_entitlements) AS entitlements,
              (SELECT md5(string_agg(reservation_id::text || state, ',' ORDER BY reservation_id)) FROM kauro.founding_slot_reservations) AS reservations`,
    );
  const before = await census();
  const cycle = await iw.service.runCycle();
  assert.deepEqual(cycle.map((r) => r.sweep), ["QUOTE_EXPIRY", "ACCRUAL_RECONCILIATION", "CLAIM_WINDOWS", "ENTITLEMENT_WINDOWS", "ELIGIBILITY", "PERIODS"], "PERIODS joins the cycle after the five sweeps");
  // nothing to repair: no conversion, accrual, expiry, release, eligibility, completion, close or failure; the ones that look and find nothing
  // are NOTHING_TO_CONVERT, LACKING n (purchases that accrue no pool, as example 3's post-window capture), NOTHING_TO_ACCRUE and NO_COMPLETION
  const repairs = (reports: ReadonlyArray<{ readonly sweep: string; readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> }>): string[] =>
    reports.flatMap((r) => r.items.filter((i) => !/^(NOTHING_TO_CONVERT|LACKING \d+|NOTHING_TO_ACCRUE|NO_COMPLETION|OPENED \d{4}-\d{2}|EXISTS \d{4}-\d{2})$/.test(i.outcome)).map((i) => `${r.sweep} ${i.subject} ${i.outcome}`));
  assert.deepEqual(repairs(cycle), []);
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit" }).format(new Date());
  assert.deepEqual(cycle.find((r) => r.sweep === "PERIODS")?.items, [{ subject: "OPEN", outcome: `OPENED ${month}` }], "the month the server stands in is opened, and no due period is left open to close");
  assert.deepEqual(await census(), before, "the cycle changed no row of the ledger, the claims, the entitlements, the reservations or the statements");
  const again = await iw.service.runCycle();
  assert.deepEqual(repairs(again), []);
  assert.deepEqual(again.find((r) => r.sweep === "PERIODS")?.items, [{ subject: "OPEN", outcome: `EXISTS ${month}` }], "a second pass finds the month open");
  assert.deepEqual(await census(), before);
});

