// The independent package-close review of B09 (docs/design/B09-payments-fiscal.md "Review findings"; B09-R1..B09-R4): each finding
// reproduced through the routes the composition root builds, the payment service's commands, consumers and watchdog, M1's commerce
// unit of work and a real PostgreSQL 17. The provider, its webhooks and the service identities are M2's labelled contract fakes
// (CONTRACT_FAKE, SIMULATED); the provider's later view is its fake's own clock moved forward, and a later payment service is the
// same service over the same pools with a clock past a deadline. Interleavings are hold points; nothing sleeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ExecuteRefundView, ReconcilePaymentView, WebhookAck } from "@kauro/application";
import { planPostings } from "@kauro/application";
import type { AgencyId, Clock, EventId, EventPayload, PaymentAttemptId, PaymentOrderId } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import { createPaymentService, recordedAtOf, watchAttempt, type PaymentService } from "../src/index.js";
import { approvedRefund, deliver, dispatch, execute, paid, paymentWorld, reconcile, rows, storeQuery, type PaidPurchase, type PaymentWorld } from "./payment-support.js";
import { clock, completed, freshKey, ids } from "./support.js";

let pw: PaymentWorld;
before(async () => {
  pw = await paymentWorld();
});
after(async () => {
  await pw.stop();
});

// --- helpers ---------------------------------------------------------------------------------------------------------------------

type Purchase = PaidPurchase & { readonly providerCaptureId: string };

async function refundRow(refundId: string) {
  return (await rows<{ state: string; provider_refund_id: string | null }>(pw, "SELECT state, provider_refund_id FROM kauro.refunds WHERE refund_id = $1", [refundId]))[0];
}

async function attemptsOf(refundId: string) {
  return rows<{ attempt_id: string; state: string; provider_request_id: string; ordinal: number }>(pw, "SELECT attempt_id, state, provider_request_id, ordinal FROM kauro.payment_attempts WHERE refund_id = $1 ORDER BY ordinal", [refundId]);
}

async function captureOf(purchase: Purchase) {
  return (await rows<{ status: string; provider_fee_cents: string | null; version: string }>(pw, "SELECT status, provider_fee_cents::text, version::text FROM kauro.capture_facts WHERE capture_id = $1", [purchase.captureId]))[0];
}

/** The provider refund the attempt's own request made (the fake's lookup by the capture and the attempt's request identity). */
async function providerRefundOf(purchase: Purchase, providerRequestId: string): Promise<string> {
  const found = await pw.paypal.observeRefund({ providerCaptureId: purchase.providerCaptureId, providerRequestId });
  if ("kind" in found) throw new Error(`the provider made no refund under ${providerRequestId}`);
  return found.providerRefundId;
}

/** A stored provider query of the purchase's order applied through CMD034 (the service route). */
async function query(purchase: Purchase): Promise<ReconcilePaymentView> {
  return completed<ReconcilePaymentView>(await reconcile(pw, purchase.orderId, { observationRef: await storeQuery(pw, purchase.providerOrderId) }, { key: freshKey("review-query") }), 200).data;
}

/** The provider reverses the capture (a chargeback) and delivers its PAYMENT.CAPTURE.REVERSED webhook. */
async function reverse(purchase: Purchase, change: { readonly feeCents?: bigint } = {}): Promise<void> {
  pw.paypal.updateCapture(purchase.providerCaptureId, { status: "REVERSED", ...change });
  const d = await deliver(pw, "PAYMENT.CAPTURE.REVERSED", purchase.providerCaptureId);
  assert.equal(completed<WebhookAck>(d.reply, 200).data.inboxState, "APPLIED");
}

const LEDGER_TYPES = ["capture.completed.v1", "capture.fee_observed.v1", "capture.funds_observed.v1", "capture.reversed.v1", "refund.completed.v1"];

/** The ledger's balance of every account over the postings of a capture and of its refunds (debit positive; zero balances omitted). */
async function ledgerOf(purchase: Purchase): Promise<Record<string, bigint>> {
  const r = await rows<{ account_code: string; n: string }>(
    pw,
    `SELECT account_code, sum(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE -amount_cents END)::text AS n FROM kauro.ledger_entries
      WHERE source_ref = $1 OR source_ref IN (SELECT refund_id FROM kauro.refunds WHERE capture_id = $1) GROUP BY account_code ORDER BY account_code`,
    [purchase.captureId],
  );
  return Object.fromEntries(r.filter((x) => BigInt(x.n) !== 0n).map((x) => [x.account_code, BigInt(x.n)]));
}

/** The money-moving events of a capture and of its refunds, as the FINANCE consumer receives them. */
async function ledgerEventsOf(purchase: Purchase) {
  return rows<{ event_id: string; event_type: string; aggregate_id: string; agency_id: string; payload: EventPayload }>(
    pw,
    `SELECT event_id, event_type, aggregate_id, agency_id, payload FROM kauro.domain_events
      WHERE event_type = ANY($2::text[]) AND (aggregate_id = $1 OR aggregate_id IN (SELECT refund_id FROM kauro.refunds WHERE capture_id = $1)) ORDER BY sequence`,
    [purchase.captureId, LEDGER_TYPES],
  );
}

function permutations<T>(list: ReadonlyArray<T>): T[][] {
  if (list.length <= 1) return [[...list]];
  const out: T[][] = [];
  list.forEach((head, i) => {
    for (const rest of permutations([...list.slice(0, i), ...list.slice(i + 1)])) out.push([head, ...rest]);
  });
  return out;
}

/**
 * Order independence over the events of a scenario: the posting sets the FINANCE consumer's planner makes of the scenario's events,
 * folded in every order in which a consumer could deliver them, leave the same balances — the ones the ledger holds.
 */
async function assertOrderIndependent(purchase: Purchase, what: string): Promise<void> {
  const events = await ledgerEventsOf(purchase);
  const posted = await ledgerOf(purchase);
  for (const order of permutations(events)) {
    const balances = new Map<string, bigint>();
    for (const e of order) {
      const plan = planPostings({ eventId: e.event_id as EventId, eventType: e.event_type, aggregateId: e.aggregate_id, agencyId: e.agency_id as AgencyId, payload: e.payload, recordedAt: recordedAtOf(e.event_id as EventId) });
      if (plan.kind === "NOT_APPLICABLE") continue;
      for (const l of plan.set.lines) balances.set(l.account, (balances.get(l.account) ?? 0n) + (l.direction === "DEBIT" ? l.amountCents : -l.amountCents));
    }
    const folded = Object.fromEntries([...balances].filter(([, n]) => n !== 0n).sort(([a], [b]) => a.localeCompare(b)));
    assert.deepEqual(folded, posted, `${what}: the events ${order.map((e) => e.event_type).join(" → ")} post the ledger's balances`);
  }
}

/** The same payment service over the same pools and adapters whose clock runs `ms` ahead. */
function laterService(ms: number): PaymentService {
  const later: Clock = { now: () => toUtcInstant(clock.nowMs() + ms), nowMs: () => clock.nowMs() + ms };
  return createPaymentService({ assembly: pw.service.runtime.assembly, environment: "LOCAL", clock: later, ids, onBackgroundFailure: (correlationId, error) => pw.backgroundFailures.push({ correlationId, error }) });
}

// --- B09-R1 ----------------------------------------------------------------------------------------------------------------------

test("B09-R1: a provider refund is bound to a local refund only by its provider identity or its own request's evidence — a separate same-amount provider refund delivered while CMD033 waits between its call and its settle is an UNKNOWN_REFUND case with its own amount and never completes the local refund, which completes with the refund its own request made; a later provider refund claiming the completed refund's reference is a case of its own, never a silent NO_CHANGE", async () => {
  const purchase = await paid(pw, "review-r1");
  const refundId = await approvedRefund(pw, purchase, 1_000n);
  // a separate 1000-cent refund of the same capture made at the provider outside the platform; its webhook is delayed
  const separate = pw.paypal.refundAtProvider(purchase.providerCaptureId, 1_000n);
  const effectsBefore = pw.paypal.effects.refunds;

  // CMD033 calls the provider and waits before its settle: the provider made the local request's own refund
  const hold = pw.holds.arm("CMD033", "AFTER_CALL", "WAIT");
  const executing = execute(pw, refundId, { expectedVersion: 2 }, { key: freshKey("review-r1") });
  await hold.reached;
  const [attempt] = await attemptsOf(refundId);
  const own = await providerRefundOf(purchase, attempt!.provider_request_id);
  assert.notEqual(own, separate);
  assert.deepEqual(await refundRow(refundId), { state: "SUBMITTING", provider_refund_id: null });

  // the separate refund's webhook: same capture, same amount, no reference of the platform — money no local refund explains
  const delayed = await deliver(pw, "PAYMENT.CAPTURE.REFUNDED", separate);
  assert.equal(delayed.reply.status, 200);
  assert.deepEqual(await refundRow(refundId), { state: "SUBMITTING", provider_refund_id: null }, "an amount is not an identity: the local refund is not completed by another provider refund");
  const unknown = await rows<{ kind: string; detail_code: string; amount_cents: string; capture_id: string; refund_id: string | null; provider_ref: string | null }>(
    pw,
    "SELECT kind, detail_code, amount_cents::text, capture_id, refund_id, provider_ref FROM kauro.reconciliation_cases WHERE capture_id = $1 AND detail_code = 'UNKNOWN_REFUND' AND state = 'OPEN' ORDER BY opened_at, case_id",
    [purchase.captureId],
  );
  assert.deepEqual(unknown, [{ kind: "PROVIDER_INCONSISTENCY", detail_code: "UNKNOWN_REFUND", amount_cents: "1000", capture_id: purchase.captureId, refund_id: null, provider_ref: separate }]);

  // the settle applies the local request's own answer: the local refund completes with its own provider refund
  hold.release();
  const done = completed<ExecuteRefundView>(await executing, 200);
  assert.deepEqual([done.data.refund.state, done.data.attemptState], ["COMPLETED", "CONFIRMED"]);
  assert.deepEqual(await refundRow(refundId), { state: "COMPLETED", provider_refund_id: own });
  const observed = await rows<{ provider_ref: string; source: string; effect: string; amount_cents: string }>(
    pw,
    "SELECT provider_ref, source, effect, amount_cents::text FROM kauro.provider_observations WHERE order_id = $1 AND subject_kind = 'REFUND' ORDER BY observed_at, observation_id",
    [purchase.orderId],
  );
  assert.deepEqual(observed, [
    { provider_ref: separate, source: "WEBHOOK", effect: "NO_CHANGE", amount_cents: "1000" },
    { provider_ref: own, source: "DISPATCH_RESPONSE", effect: "ADVANCED", amount_cents: "1000" },
  ]);
  // the provider returned 2000 cents: 1000 by the local refund's completion, 1000 held open for review with its own amount
  assert.equal(pw.paypal.effects.refunds, effectsBefore + 1, "one refund made by the platform's request");
  const completions = await rows<{ n: string }>(pw, "SELECT count(*)::text AS n FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'refund.completed.v1'", [refundId]);
  assert.equal(completions[0]!.n, "1");

  // a later provider refund that names the completed refund's reference is not that refund (it completed with its own): its own case
  const claiming = pw.paypal.refundAtProvider(purchase.providerCaptureId, 500n, "COMPLETED", { invoiceId: refundId });
  const claimed = await deliver(pw, "PAYMENT.CAPTURE.REFUNDED", claiming);
  assert.equal(claimed.reply.status, 200);
  assert.deepEqual(await refundRow(refundId), { state: "COMPLETED", provider_refund_id: own });
  const cases = await rows<{ amount_cents: string; provider_ref: string | null }>(pw, "SELECT amount_cents::text, provider_ref FROM kauro.reconciliation_cases WHERE capture_id = $1 AND detail_code = 'UNKNOWN_REFUND' AND state = 'OPEN' ORDER BY opened_at, case_id", [purchase.captureId]);
  assert.deepEqual(cases, [{ amount_cents: "1000", provider_ref: separate }, { amount_cents: "500", provider_ref: claiming }], "each provider refund no local refund explains is its own incident with its own amount");
  // a repeated delivery of the same provider refund adds history, never a second case
  await deliver(pw, "PAYMENT.CAPTURE.REFUNDED", separate);
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.reconciliation_cases WHERE capture_id = $1 AND detail_code = 'UNKNOWN_REFUND'", [purchase.captureId])).length, 2);
});

// --- B09-R2 ----------------------------------------------------------------------------------------------------------------------

type Order = "REFUND_THEN_REVERSAL" | "REVERSAL_THEN_REFUND" | "ONE_QUERY";

/**
 * A 97,125-cent capture (with a 5,275-cent fee the provider reported after the completion, when `feeCents`), a 1,000-cent refund of
 * it and the provider's reversal of the rest, observed in one of three orders: the refund completed before the reversal; the
 * reversal's webhook before the delayed observation of a refund whose response was lost; one provider query showing both.
 */
async function returned(seed: string, order: Order, feeCents: bigint | null): Promise<{ readonly purchase: Purchase; readonly refundId: string }> {
  const purchase = await paid(pw, seed);
  if (feeCents !== null) {
    pw.paypal.updateCapture(purchase.providerCaptureId, { feeCents });
    await query(purchase);
    assert.equal((await captureOf(purchase))?.provider_fee_cents, feeCents.toString());
  }
  const refundId = await approvedRefund(pw, purchase, 1_000n);
  switch (order) {
    case "REFUND_THEN_REVERSAL":
      assert.equal(completed<ExecuteRefundView>(await execute(pw, refundId, { expectedVersion: 2 }), 200).data.refund.state, "COMPLETED");
      await reverse(purchase);
      break;
    case "REVERSAL_THEN_REFUND": {
      // the provider refunds, its answer is lost (UNCERTAIN); it then reverses the rest; the reversal's webhook arrives first
      pw.paypal.program("CAPTURES_V2_REFUND", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "APPLIED" });
      assert.equal((await execute(pw, refundId, { expectedVersion: 2 })).status, 202);
      const [attempt] = await attemptsOf(refundId);
      const providerRefund = await providerRefundOf(purchase, attempt!.provider_request_id);
      await reverse(purchase);
      assert.equal((await refundRow(refundId))?.state, "UNCERTAIN", "a refund in flight does not lapse with the reversal");
      const late = await deliver(pw, "PAYMENT.CAPTURE.REFUNDED", providerRefund);
      assert.equal(completed<WebhookAck>(late.reply, 200).data.inboxState, "APPLIED");
      break;
    }
    case "ONE_QUERY": {
      // the refund is SUBMITTING: its successful answer was lost with the process between the call and the settle
      pw.holds.arm("CMD033", "AFTER_CALL", "CRASH");
      assert.equal((await execute(pw, refundId, { expectedVersion: 2 })).status, 500);
      assert.equal((await refundRow(refundId))?.state, "SUBMITTING");
      pw.paypal.updateCapture(purchase.providerCaptureId, { status: "REVERSED" });
      await query(purchase);
      break;
    }
  }
  assert.equal((await refundRow(refundId))?.state, "COMPLETED");
  assert.equal((await captureOf(purchase))?.status, "REVERSED");
  await dispatch(pw, "FINANCE");
  return { purchase, refundId };
}

test("B09-R2: a reversal observed together with or before the completion of a refund in flight nets every return against the capture exactly once — whatever the observation order the ledger returns the capture once: the receivable, the contract liability and the provider balances end at zero (with a kept fee, exactly the fee on the merchant's available balance and the processor expense), and the events of each scenario post the same balances in every delivery order", async () => {
  const expected = { withoutFee: {}, withFee: { PROCESSOR_EXPENSE: 5_275n, PSP_AVAILABLE: -5_275n } };
  const orders: ReadonlyArray<Order> = ["ONE_QUERY", "REVERSAL_THEN_REFUND", "REFUND_THEN_REVERSAL"];
  for (const feeCents of [null, 5_275n] as const) {
    for (const order of orders) {
      const what = `${order}${feeCents === null ? "" : " after a kept fee"}`;
      const { purchase, refundId } = await returned(`review-r2-${order.toLowerCase()}-${feeCents === null ? "nofee" : "fee"}`, order, feeCents);
      assert.deepEqual(await ledgerOf(purchase), feeCents === null ? expected.withoutFee : expected.withFee, `${what}: the capture is returned exactly once`);
      // what each event returns: the reversal the components no completed refund returned, a refund completed after the reversal nothing more
      const [reversal] = await rows<{ payload: EventPayload }>(pw, "SELECT payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'capture.reversed.v1'", [purchase.captureId]);
      const [completion] = await rows<{ payload: EventPayload }>(pw, "SELECT payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'refund.completed.v1'", [refundId]);
      const byReversal = Number(reversal!.payload["reversedServiceCents"]);
      const byRefund = Number(completion!.payload["returnedServiceCents"]);
      assert.equal(byReversal + byRefund, 97_125, `${what}: the returns of the capture sum to its service exactly once`);
      assert.equal(completion!.payload["serviceCents"], 1000, `${what}: the refund's approved components stay the credit note's and the commissions' basis`);
      await assertOrderIndependent(purchase, what);
    }
  }
});

// --- B09-R4 ----------------------------------------------------------------------------------------------------------------------

test("B09-R4: a provider fee learned with a reversal, or after it, is a fact of the capture and is posted — the REVERSED observation's fee and a fee a later query reports for a reversed capture are each a capture.fee_observed.v1 version taken from the merchant's available balance (the reversal returned the capture's movable balance), a repeated observation adds nothing, and the kept fee ends on the processor expense", async () => {
  const kept = { PROCESSOR_EXPENSE: 5_275n, PSP_AVAILABLE: -5_275n };
  const feeEvents = (purchase: Purchase) =>
    rows<{ payload: EventPayload }>(pw, "SELECT payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'capture.fee_observed.v1' ORDER BY aggregate_version", [purchase.captureId]);

  // the fee arrives with the reversal: a stored query of a capture the provider reversed and whose fee it reports
  const withReversal = await paid(pw, "review-r4-with");
  pw.paypal.updateCapture(withReversal.providerCaptureId, { status: "REVERSED", feeCents: 5_275n });
  const applied = await query(withReversal);
  assert.ok(applied.effects.some((e) => e.about === "CAPTURE" && e.effect === "ADVANCED"));
  assert.deepEqual(await captureOf(withReversal), { status: "REVERSED", provider_fee_cents: "5275", version: "3" }, "the reversal, then the fee: one fact per version");
  assert.deepEqual((await feeEvents(withReversal)).map((e) => [e.payload["providerFeeCents"], e.payload["fundsState"], e.payload["movableBalanceCents"]]), [[5275, "UNKNOWN", 0]]);
  // the same provider view again is a duplicate: no second fee
  await query(withReversal);
  assert.equal((await feeEvents(withReversal)).length, 1);

  // the fee arrives after the reversal: the reversal's webhook first, then a query reporting the fee of the reversed capture
  const afterReversal = await paid(pw, "review-r4-after");
  await reverse(afterReversal);
  assert.deepEqual(await captureOf(afterReversal), { status: "REVERSED", provider_fee_cents: null, version: "2" });
  pw.paypal.updateCapture(afterReversal.providerCaptureId, { feeCents: 5_275n });
  await query(afterReversal);
  assert.deepEqual((await feeEvents(afterReversal)).map((e) => [e.payload["providerFeeCents"], e.payload["movableBalanceCents"]]), [[5275, 0]]);

  // the reversal's own webhook reporting the fee
  const byWebhook = await paid(pw, "review-r4-webhook");
  await reverse(byWebhook, { feeCents: 5_275n });
  assert.deepEqual(await captureOf(byWebhook), { status: "REVERSED", provider_fee_cents: "5275", version: "3" });

  await dispatch(pw, "FINANCE");
  for (const [what, purchase] of [["with the reversal", withReversal], ["after the reversal", afterReversal], ["with the reversal's webhook", byWebhook]] as const) {
    assert.deepEqual(await ledgerOf(purchase), kept, `${what}: the capture returned once, the kept fee the merchant's`);
    await assertOrderIndependent(purchase, what);
  }
});

// --- B09-R3 (last: it moves the provider fake's clock past the dispatch deadlines) ------------------------------------------------

test("B09-R3: the watchdog judges absence per refund — an authoritative provider view taken after the deadlines that shows an earlier completed refund of the same capture, and neither the refund whose request timed out without effect nor the one claimed but never sent, proves both had no effect: their attempts FAILED_NO_EFFECT, the refunds APPROVED again for a later deliberate attempt, the earlier refund untouched", async () => {
  const purchase = await paid(pw, "review-r3");
  const earlier = await approvedRefund(pw, purchase, 1_000n);
  assert.equal(completed<ExecuteRefundView>(await execute(pw, earlier, { expectedVersion: 2 }), 200).data.refund.state, "COMPLETED");
  const effectsBefore = pw.paypal.effects.refunds;

  // a refund whose request timed out and made nothing at the provider: UNCERTAIN
  const timedOut = await approvedRefund(pw, purchase, 2_000n);
  pw.paypal.program("CAPTURES_V2_REFUND", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "NOT_APPLIED" });
  assert.equal((await execute(pw, timedOut, { expectedVersion: 2 })).status, 202);
  assert.equal((await refundRow(timedOut))?.state, "UNCERTAIN");
  // a refund claimed and never sent: the process died between the claim and the call (SUBMITTING, DISPATCHING)
  const neverSent = await approvedRefund(pw, purchase, 3_000n);
  pw.holds.arm("CMD033", "AFTER_CLAIM", "CRASH");
  assert.equal((await execute(pw, neverSent, { expectedVersion: 2 })).status, 500);
  assert.equal((await refundRow(neverSent))?.state, "SUBMITTING");
  assert.equal(pw.paypal.effects.refunds, effectsBefore, "neither made anything at the provider");

  // the provider's view is taken after both dispatch deadlines, by a payment service whose clock is past them
  const due = await rows<{ attempt_id: string; late_ms: string }>(
    pw,
    "SELECT attempt_id, ceil(extract(epoch FROM (dispatch_deadline_at - now())) * 1000)::bigint::text AS late_ms FROM kauro.payment_attempts WHERE refund_id = ANY($1::uuid[]) ORDER BY dispatch_deadline_at",
    [[timedOut, neverSent]],
  );
  const ahead = Math.max(...due.map((d) => Number(d.late_ms))) + 1_000;
  pw.providerClock.advance(ahead);
  const later = laterService(ahead);
  for (let pass = 0; pass < 2; pass++) {
    for (const d of due) await watchAttempt(later.runtime, purchase.orderId as PaymentOrderId, d.attempt_id as PaymentAttemptId);
  }

  for (const refundId of [timedOut, neverSent]) {
    assert.deepEqual(await refundRow(refundId), { state: "APPROVED", provider_refund_id: null }, "the absence of this refund's own identity proves it had no effect");
    assert.deepEqual((await attemptsOf(refundId)).map((a) => a.state), ["FAILED_NO_EFFECT"]);
  }
  assert.equal((await refundRow(earlier))?.state, "COMPLETED");
  assert.equal(pw.paypal.effects.refunds, effectsBefore, "the watchdog only reads");
});
