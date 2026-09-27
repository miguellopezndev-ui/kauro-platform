// The FINANCE consumer of the payment service (package B09, stage-2 mandate M3; design §8.1, D-CONS-B1, D-LEDGER-B1..B6;
// docs/design/B09-case-map.md R2-078). The provider's capture events arrive through the webhook route of the api the composition
// root builds, and the payment dispatcher delivers their outbox records to FINANCE — claimed under kauro_control with the consumer's
// lease, each effect in a SERVICE unit of work under kauro_payment — which posts the balanced set M2's planPostings plans, sourced
// by the event. The provider and its webhooks are M2's labelled contract fakes (CONTRACT_FAKE, SIMULATED: a reported fee here is the
// fake's; actual statement fees are package B15's, R2-085).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ExecuteRefundView, ReconcilePaymentView, WebhookAck } from "@kauro/application";
import { illustrativeProcessorFee } from "@kauro/domain";
import { createPaymentDispatcher } from "../src/index.js";
import { approvedRefund, checkout, deliver, dispatch, execute, paid, paymentWorld, reconcile, rows, storeQuery, type PaymentWorld } from "./payment-support.js";
import { completed } from "./support.js";

let pw: PaymentWorld;
before(async () => {
  pw = await paymentWorld();
});
after(async () => {
  await pw.stop();
});

type Line = { readonly account_code: string; readonly direction: string; readonly amount_cents: string; readonly source_kind: string };

async function linesOf(eventId: string): Promise<Line[]> {
  return rows<Line>(pw, "SELECT account_code, direction, amount_cents::text, source_kind FROM kauro.ledger_entries WHERE event_id = $1 ORDER BY line_no", [eventId]);
}

/** The balance of an account over the postings sourced by a capture's events (debit positive). */
async function balance(captureId: string, account: string): Promise<bigint> {
  const r = await rows<{ n: string | null }>(
    pw,
    "SELECT sum(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE -amount_cents END)::text AS n FROM kauro.ledger_entries WHERE source_ref = $1 AND account_code = $2",
    [captureId, account],
  );
  return BigInt(r[0]?.n ?? "0");
}

async function paidThroughWebhook(seed: string, feeCents: bigint | null) {
  const order = await checkout(pw, seed);
  pw.paypal.approve(order.providerOrderId);
  const providerCaptureId = pw.paypal.captureAtProvider(order.providerOrderId, feeCents === null ? {} : { feeCents });
  const d = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
  assert.equal(completed<WebhookAck>(d.reply, 200).data.inboxState, "APPLIED");
  const capture = (await rows<{ capture_id: string; provider_fee_cents: string | null }>(pw, "SELECT capture_id, provider_fee_cents::text FROM kauro.capture_facts WHERE order_id = $1", [order.orderId]))[0]!;
  const completion = (await rows<{ event_id: string; payload: Record<string, unknown> }>(pw, "SELECT event_id, payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'capture.completed.v1'", [capture.capture_id]))[0]!;
  return { order, providerCaptureId, capture, completion };
}

test("R2-078: the FINANCE consumer posts the provider-reported fee of a capture, never the illustration; the net receivable is exact", async () => {
  // the R2-078 figures: a capture of 97,125 whose provider reported a fee of 5,275 leaves a receivable of exactly 91,850
  const reported = await paidThroughWebhook("ledger-reported", 5_275n);
  assert.equal(reported.capture.provider_fee_cents, "5275", "the fee is the provider's report, kept on the capture fact");
  assert.equal(reported.completion.payload["providerFeeCents"], 5275);
  const pass = await dispatch(pw, "FINANCE");
  assert.equal(pass.held, false);
  assert.ok(pass.deliveries.some((d) => d.eventId === reported.completion.event_id && d.outcome === "APPLIED"));
  assert.deepEqual(await linesOf(reported.completion.event_id), [
    { account_code: "PSP_RECEIVABLE", direction: "DEBIT", amount_cents: "97125", source_kind: "CAPTURE" },
    { account_code: "CONTRACT_LIABILITY", direction: "CREDIT", amount_cents: "97125", source_kind: "CAPTURE" },
    { account_code: "PROCESSOR_EXPENSE", direction: "DEBIT", amount_cents: "5275", source_kind: "CAPTURE" },
    { account_code: "PSP_RECEIVABLE", direction: "CREDIT", amount_cents: "5275", source_kind: "CAPTURE" },
  ]);
  assert.equal(await balance(reported.capture.capture_id, "PSP_RECEIVABLE"), 91_850n);

  // the illustration is never posted: another reported fee is posted as reported, and a capture without one posts no fee at all
  assert.equal(illustrativeProcessorFee(97_125n, { rateBps: 540, fixedCents: 30n }).feeCents, 5_275n, "the registry's illustration of this amount (540 bps + 30)");
  const other = await paidThroughWebhook("ledger-other-fee", 4_100n);
  const silent = await paidThroughWebhook("ledger-no-fee", null);
  await dispatch(pw, "FINANCE");
  assert.equal(await balance(other.capture.capture_id, "PROCESSOR_EXPENSE"), 4_100n);
  assert.equal(await balance(other.capture.capture_id, "PSP_RECEIVABLE"), 93_025n);
  assert.equal(await balance(silent.capture.capture_id, "PROCESSOR_EXPENSE"), 0n);
  assert.equal(await balance(silent.capture.capture_id, "PSP_RECEIVABLE"), 97_125n);

  // a fee the provider reports after the completion is its own event, whose set carries only the fee: the same exact net receivable
  pw.paypal.updateCapture(silent.providerCaptureId, { feeCents: 5_275n });
  const later = completed<ReconcilePaymentView>(await reconcile(pw, silent.order.orderId, { observationRef: await storeQuery(pw, silent.order.providerOrderId) }), 200);
  assert.ok(later.data.effects.some((e) => e.about === "CAPTURE" && e.effect === "ADVANCED"));
  const fee = (await rows<{ event_id: string; payload: Record<string, unknown> }>(pw, "SELECT event_id, payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'capture.fee_observed.v1'", [silent.capture.capture_id]))[0]!;
  assert.deepEqual([fee.payload["providerFeeCents"], fee.payload["fundsState"], fee.payload["movableBalanceCents"]], [5275, "UNKNOWN", 97125]);
  await dispatch(pw, "FINANCE");
  assert.deepEqual(await linesOf(fee.event_id), [
    { account_code: "PROCESSOR_EXPENSE", direction: "DEBIT", amount_cents: "5275", source_kind: "FEE" },
    { account_code: "PSP_RECEIVABLE", direction: "CREDIT", amount_cents: "5275", source_kind: "FEE" },
  ]);
  assert.equal(await balance(silent.capture.capture_id, "PSP_RECEIVABLE"), 91_850n);
  const completions = await rows<{ n: string }>(pw, "SELECT count(*)::text AS n FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'capture.completed.v1'", [silent.capture.capture_id]);
  assert.equal(completions[0]!.n, "1", "the completion is never re-published for a later fee (D-EVT-B2)");

  // at least once, posted once: a delivery of the same event again (an expired claim delivered twice) writes nothing
  const entries = async () => Number((await rows<{ n: string }>(pw, "SELECT count(*)::text AS n FROM kauro.ledger_entries"))[0]!.n);
  const before = await entries();
  const finance = pw.service.effects.find((e) => e.consumer === "FINANCE")!;
  const event = (await rows<{ event_type: string; agency_id: string; aggregate_id: string; aggregate_version: string; payload: Record<string, unknown> }>(pw, "SELECT event_type, agency_id, aggregate_id, aggregate_version::text, payload FROM kauro.domain_events WHERE event_id = $1", [reported.completion.event_id]))[0]!;
  const again = await finance.handle({ eventId: reported.completion.event_id as never, eventType: event.event_type, agencyId: event.agency_id as never, aggregateId: event.aggregate_id, aggregateVersion: Number(event.aggregate_version), payload: event.payload });
  assert.equal(again, "DUPLICATE");
  assert.equal(await entries(), before);
});

test("D-LEDGER-B6 through the FINANCE consumer: a full service refund executed after a fee the provider keeps takes the capture's movable balance from its receivable and the kept fee from the merchant's available balance — the receivable ends at exactly zero, never negative, and the entitlement is revoked", async () => {
  const purchase = await paid(pw, "ledger-kept-fee");
  // the provider reports its fee after the completion (capture.fee_observed.v1, the movable balance before it: the whole capture)
  pw.paypal.updateCapture(purchase.providerCaptureId, { feeCents: 5_275n });
  completed<ReconcilePaymentView>(await reconcile(pw, purchase.orderId, { observationRef: await storeQuery(pw, purchase.providerOrderId) }), 200);
  // the whole service goes back through the service route (the provider keeps its fee)
  const refundId = await approvedRefund(pw, purchase, 97_125n);
  const executed = completed<ExecuteRefundView>(await execute(pw, refundId, { expectedVersion: 2 }), 200);
  assert.equal(executed.data.refund.state, "COMPLETED");
  const completion = (await rows<{ event_id: string; payload: Record<string, unknown> }>(pw, "SELECT event_id, payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'refund.completed.v1'", [refundId]))[0]!;
  assert.deepEqual([completion.payload["fundsState"], completion.payload["movableBalanceCents"], completion.payload["serviceBasisAfterCents"]], ["UNKNOWN", 91850, 0], "the payload carries the movable balance before the return: the capture less the reported fee");
  await dispatch(pw, "FINANCE");
  // the return's set: the liability back, 91,850 from the capture's receivable, the kept 5,275 from the merchant's available balance
  assert.deepEqual(await linesOf(completion.event_id), [
    { account_code: "CONTRACT_LIABILITY", direction: "DEBIT", amount_cents: "97125", source_kind: "REFUND" },
    { account_code: "PSP_RECEIVABLE", direction: "CREDIT", amount_cents: "91850", source_kind: "REFUND" },
    { account_code: "PSP_AVAILABLE", direction: "CREDIT", amount_cents: "5275", source_kind: "REFUND" },
  ]);
  const across = async (account: string): Promise<bigint> => {
    const r = await rows<{ n: string | null }>(pw, "SELECT sum(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE -amount_cents END)::text AS n FROM kauro.ledger_entries WHERE source_ref IN ($1, $2) AND account_code = $3", [purchase.captureId, refundId, account]);
    return BigInt(r[0]?.n ?? "0");
  };
  assert.deepEqual(
    [await across("PSP_RECEIVABLE"), await across("PSP_AVAILABLE"), await across("PROCESSOR_EXPENSE"), await across("CONTRACT_LIABILITY")],
    [0n, -5_275n, 5_275n, 0n],
  );
  assert.deepEqual(await rows(pw, "SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [purchase.authorizationId]), [{ state: "REVOKED" }], "no service basis is left (D-REF-B5)");
});

test("the payment dispatcher holds one lease per consumer: a second dispatcher of FINANCE finds it HELD and claims nothing, and FISCAL is leased on its own", async () => {
  const order = await paidThroughWebhook("ledger-lease", 5_275n);
  const rival = pw.service.dispatcher.ownerId;
  const second = createPaymentDispatcher(pw.service.runtime, pw.service.effects);
  assert.notEqual(second.ownerId, rival);
  // the first dispatcher leases FINANCE and settles its deliveries; the second finds the lease live and does nothing
  const first = await pw.service.dispatcher.runOnce("FINANCE");
  assert.equal(first.held, false);
  assert.ok(first.deliveries.some((d) => d.eventId === order.completion.event_id));
  const blocked = await second.runOnce("FINANCE");
  assert.deepEqual([blocked.held, blocked.deliveries.length], [true, 0]);
  const fiscal = await second.runOnce("FISCAL");
  assert.equal(fiscal.held, false, "each consumer has its own lease");
  const leases = await rows<{ resource_kind: string; owner_id: string; fence: string }>(pw, "SELECT resource_kind, owner_id, fence::text FROM kauro.leases WHERE resource_kind = 'OUTBOX_DISPATCH' ORDER BY owner_id");
  assert.deepEqual(leases.map((l) => l.owner_id).sort(), [rival, second.ownerId].sort());
});
