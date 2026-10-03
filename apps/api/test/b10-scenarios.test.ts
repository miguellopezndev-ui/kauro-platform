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
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  acceptedThrough,
  agentOf,
  anotherClient,
  assignedThrough,
  bought,
  claimed,
  closedAt,
  madeEligible,
  statementReads,
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
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-093: the larger scope is charged only after the paid purchase is refunded and a new quote is issued and explicitly accepted by CreatePaymentOrder; no capture ever covers the difference silently", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-095 (example 12): after AssignAccount moves A's acquired agency to seller B, the agency's next purchase inside A's window accrues A's 400-bps line and no line for B; B's assistance agreement signed before a later order accrues B's own 400-bps pool beside A's, never reducing it", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-098 (example 3): after the window the agency's next project is still quoted at its 500-bps recurrence discount, its capture accrues nothing for the seller, and the seller's earlier ELIGIBLE line is paid on the next statement", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-100: an enumerated opportunity's first purchase inside the tail converts its claim and creates the departed seller's entitlement; a first purchase after the tail's end or of an unlisted agency creates none", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-104 (examples 7 and 25): a 20000-cent service refund after the seller was paid 4921 posts -800, the line PAID to ADJUSTED, and the next statement shows the original accrual, the payout, the adjustment and the -800 balance with its project and reason; no port can debit the seller", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("R2-137 (example 9): two projects' capture reconciliations of one agency held at the designation trigger in both interleavings end with one first project, one 1000-bps and one 400-bps pool and the same final statement projection", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

test("CMD050-RACE: TerminateSeller racing AcceptAttribution of the seller's unlisted claim, held at the seller row, serializes in both orders — acceptance first: the claim is ACCEPTED, then EXPIRED as unlisted by the termination; termination first: the claim is EXPIRED and AcceptAttribution is 409 CLAIM_NOT_REVIEWABLE — and no live claim of a terminated seller remains", async () => {
  assert.ok(iw !== undefined);
  assert.fail("planned: this scenario is written by the mandate");
});

