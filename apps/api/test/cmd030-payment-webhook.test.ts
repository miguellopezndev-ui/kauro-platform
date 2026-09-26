// CMD030 ReceivePaymentWebhook — POST /api/v1/payments/webhooks/{provider} (package B09, stage-2 mandate M3; design §8 CMD030,
// D-IDEM-B1, D-ING-B1..B3, D-FACT-B1; docs/design/B09-case-map.md CMD030-OK/DENY/RACE). Through the real route of the api the
// composition root builds, the payment service's pools, M1's commerce unit of work, M2's reconciler and a real PostgreSQL 17. The
// provider, its webhook verifier and the evidence store are M2's labelled contract fakes (CONTRACT_FAKE, SIMULATED): the webhook
// bodies are the ones the PayPal Orders v2 fake would send about its own objects, signed by the verifier fake over the exact bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { WebhookAck } from "@kauro/application";
import { uuidV8Of } from "@kauro/application/testing";
import { toUtcInstant, type PaymentOrderId } from "@kauro/domain";
import { waitForLockWait } from "@kauro/persistence/testing";
import { PAYMENT_APPLICATION_NAME } from "../src/index.js";
import { captureRun, checkout, deliver, dispatch, paymentWorld, postWebhook, rows, type PaymentWorld } from "./payment-support.js";
import { clock, completed, freshKey, outcome } from "./support.js";

let pw: PaymentWorld;
before(async () => {
  pw = await paymentWorld();
});
after(async () => {
  await pw.stop();
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function inboxOf(eventId: string) {
  return rows<{ inbox_id: string; state: string; result_event_id: string | null; body_hash: string }>(pw, "SELECT inbox_id, state, result_event_id, body_hash FROM kauro.inbox_records WHERE provider = 'paypal' AND environment = 'SANDBOX' AND external_event_id = $1", [eventId]);
}

async function capturesOf(orderId: string) {
  return rows<{ capture_id: string; status: string; provider_capture_id: string; amount_cents: string; allocated_service_cents: string; excess_cents: string; first_observation_source: string }>(
    pw,
    "SELECT capture_id, status, provider_capture_id, amount_cents::text, allocated_service_cents::text, excess_cents::text, first_observation_source FROM kauro.capture_facts WHERE order_id = $1 ORDER BY first_observed_at",
    [orderId],
  );
}

async function orderState(orderId: string): Promise<string | undefined> {
  return (await rows<{ state: string }>(pw, "SELECT state FROM kauro.payment_orders WHERE order_id = $1", [orderId]))[0]?.state;
}

async function exceptionsOf(inboxId: string) {
  return rows<{ kind: string; agency_id: string | null; order_id: string | null; source: string }>(pw, "SELECT kind, agency_id, order_id, source FROM kauro.provider_event_exceptions WHERE inbox_id = $1 ORDER BY kind", [inboxId]);
}

test("OK: a verified capture event is stored once in the inbox and applied to its order — capture fact, CAPTURED order, authorization, inbox APPLIED with the result event", async () => {
  const order = await checkout(pw, "webhook-ok");
  pw.paypal.approve(order.providerOrderId);
  const providerCaptureId = pw.paypal.captureAtProvider(order.providerOrderId);
  const d = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
  const ack = completed<WebhookAck>(d.reply, 200);
  assert.deepEqual([ack.data, ack.replayed], [{ received: true, inboxState: "APPLIED", duplicate: false, conflict: false }, false]);

  // one durable inbox entry, APPLIED with the event of the first fact the application changed
  const [inbox, ...others] = await inboxOf(d.eventId);
  assert.equal(others.length, 0);
  assert.equal(inbox?.state, "APPLIED");
  assert.equal(inbox?.body_hash, sha256(d.bytes), "the record keeps the digest of the exact verified bytes");
  const result = (await rows<{ event_type: string; aggregate_id: string; actor_kind: string; actor_id: string }>(pw, "SELECT event_type, aggregate_id, actor_kind, actor_id FROM kauro.domain_events WHERE event_id = $1", [inbox!.result_event_id]))[0];
  assert.deepEqual(result, { event_type: "payment_order.captured.v1", aggregate_id: order.orderId, actor_kind: "SERVICE", actor_id: "payment-service" });
  // the exact bytes are the restricted store's, content-addressed (the normalized command's providerEventArtifactRef)
  assert.deepEqual(pw.evidence.bytesOf(uuidV8Of(sha256(d.bytes))), d.bytes);

  // reconciled with the local order: the capture fact (born COMPLETED from the webhook), the order CAPTURED, one authorization
  const captures = await capturesOf(order.orderId);
  assert.deepEqual(
    captures.map((c) => [c.status, c.provider_capture_id, c.amount_cents, c.allocated_service_cents, c.excess_cents, c.first_observation_source]),
    [["COMPLETED", providerCaptureId, "97125", "97125", "0", "WEBHOOK"]],
  );
  assert.equal(await orderState(order.orderId), "CAPTURED");
  const authorizations = await rows<{ state: string; capture_id: string; quote_id: string }>(pw, "SELECT state, capture_id, quote_id FROM kauro.commercial_authorizations WHERE order_id = $1", [order.orderId]);
  assert.deepEqual(authorizations, [{ state: "ACTIVE", capture_id: captures[0]!.capture_id, quote_id: order.quoteId }]);
  const observations = await rows<{ source: string; inbox_id: string; subject_kind: string; effect: string }>(pw, "SELECT source, inbox_id, subject_kind, effect FROM kauro.provider_observations WHERE order_id = $1", [order.orderId]);
  assert.deepEqual(observations, [{ source: "WEBHOOK", inbox_id: inbox!.inbox_id, subject_kind: "CAPTURE", effect: "ADVANCED" }]);
  const events = await rows<{ event_type: string; causation_id: string }>(pw, "SELECT event_type, causation_id FROM kauro.domain_events WHERE aggregate_id IN ($1, $2) AND aggregate_version > 0 AND event_type IN ('capture.completed.v1', 'payment_order.captured.v1') ORDER BY sequence", [order.orderId, captures[0]!.capture_id]);
  assert.deepEqual(events.map((e) => e.event_type), ["payment_order.captured.v1", "capture.completed.v1"]);
  for (const e of events) assert.equal(e.causation_id, inbox!.inbox_id, "the application's events are caused by the inbox record (D-EVT-B4)");
  // the ingress's own facts: the acceptance of an authenticated provider event, in no agency's stream (D-FACT-B1)
  const facts = await rows<{ outcome: string; actor_kind: string; actor_id: string; reason_code: string; agency_id: string | null }>(pw, "SELECT outcome, actor_kind, actor_id, reason_code, agency_id FROM kauro.security_events WHERE action = 'CMD030' AND correlation_id = $1", [d.reply.headers["x-correlation-id"]]);
  assert.deepEqual(facts, [{ outcome: "ALLOW", actor_kind: "SERVICE", actor_id: "provider-ingress", reason_code: "PROVIDER_EVENT_AUTHENTICATED", agency_id: null }]);
});

test("DENY: an invalid signature (the wrong role of a sender) stores nothing but the denial; an event of a foreign tenant's environment or an unknown provider reference is an exception, never applied; one missing prerequisite — a wrong payee, currency, provider or order — is its specific exception and the record REJECTED; a duplicate delivery adds no capture, posting or commission event", async () => {
  const inboxCount = async () => Number((await rows<{ n: string }>(pw, "SELECT count(*)::text AS n FROM kauro.inbox_records"))[0]!.n);

  // the wrong role of a sender: a body whose signature does not verify is nobody's — no inbox row, no stored body, the anonymous denial
  const forgedOrder = await checkout(pw, "webhook-forged");
  pw.paypal.approve(forgedOrder.providerOrderId);
  const forgedCapture = pw.paypal.captureAtProvider(forgedOrder.providerOrderId);
  const before = await inboxCount();
  const forged = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", forgedCapture, { tamper: true });
  assert.equal(outcome(pw.api, forged.reply), "401 AUTHENTICATION_REQUIRED PROVIDER_SIGNATURE_INVALID");
  assert.equal(await inboxCount(), before);
  assert.equal(pw.evidence.bytesOf(uuidV8Of(sha256(forged.bytes))), null, "nothing of an unverified body is stored");
  const denials = await rows<{ actor_kind: string; actor_id: string | null; outcome: string; reason_code: string; agency_id: string | null; assurance_class: string }>(pw, "SELECT actor_kind, actor_id, outcome, reason_code, agency_id, assurance_class FROM kauro.security_events WHERE action = 'CMD030' AND correlation_id = $1", [forged.reply.headers["x-correlation-id"]]);
  assert.deepEqual(denials, [{ actor_kind: "ANONYMOUS", actor_id: null, outcome: "DENY", reason_code: "PROVIDER_SIGNATURE_INVALID", agency_id: null, assurance_class: "NONE" }]);
  assert.equal((await capturesOf(forgedOrder.orderId)).length, 0);

  // a foreign tenant's environment: the event signed for LIVE never reaches this SANDBOX deployment's inbox
  const live = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", forgedCapture, { environment: "LIVE" });
  assert.equal(outcome(pw.api, live.reply), "401 AUTHENTICATION_REQUIRED PROVIDER_ENVIRONMENT_MISMATCH");
  assert.equal(await inboxCount(), before);

  // a provider reference no order of any agency holds: an unattributed exception, never a guess from the payload, IGNORED
  const stray = pw.paypal.prepareCreateOrder({ orderId: "stray-order", attemptId: "stray", providerRequestId: `kauro-stray-${freshKey("s")}`, amountCents: 97125n, currency: "USD", description: "KAURO_PROJECT_PREPARATION", returnPath: "/r", cancelPath: "/c" });
  const strayOrder = await pw.paypal.dispatch(stray, toUtcInstant(clock.nowMs() + 60_000));
  assert.equal(strayOrder.kind, "ORDER_CREATED");
  if (strayOrder.kind !== "ORDER_CREATED") return;
  pw.paypal.approve(strayOrder.providerOrderId);
  const strayCapture = pw.paypal.captureAtProvider(strayOrder.providerOrderId);
  const unknown = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", strayCapture);
  assert.equal(completed<WebhookAck>(unknown.reply, 200).data.inboxState, "IGNORED");
  const [unknownInbox] = await inboxOf(unknown.eventId);
  assert.deepEqual(await exceptionsOf(unknownInbox!.inbox_id), [{ kind: "UNKNOWN_PROVIDER_REFERENCE", agency_id: null, order_id: null, source: "WEBHOOK" }]);
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.capture_facts WHERE provider_capture_id = $1", [strayCapture])).length, 0);

  // a wrong provider: no verifier is configured for it — nothing is verified, stored or recorded
  const otherProvider = await postWebhook(pw, unknown.bytes, unknown.headers, "stripe");
  assert.equal(outcome(pw.api, otherProvider), "404 NOT_FOUND PROVIDER_UNKNOWN");

  // one missing prerequisite at a time: the capture of another payee, or in another currency, is never a capture of the order (S058)
  for (const [seed, overrides, kind] of [
    ["webhook-payee", { merchantId: "ANOTHERMERCHANT" }, "WRONG_PAYEE"],
    ["webhook-currency", { currency: "EUR" }, "WRONG_CURRENCY"],
  ] as const) {
    const order = await checkout(pw, seed);
    pw.paypal.approve(order.providerOrderId);
    const providerCaptureId = pw.paypal.captureAtProvider(order.providerOrderId, overrides);
    const d = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
    assert.equal(completed<WebhookAck>(d.reply, 200).data.inboxState, "REJECTED", kind);
    const [inbox] = await inboxOf(d.eventId);
    assert.deepEqual(await exceptionsOf(inbox!.inbox_id), [{ kind, agency_id: pw.w.A.agencyId, order_id: order.orderId, source: "WEBHOOK" }]);
    assert.equal((await capturesOf(order.orderId)).length, 0, `${kind}: no capture fact of the order`);
    assert.equal(await orderState(order.orderId), "CREATED", `${kind}: the order is unpaid`);
    assert.equal((await rows(pw, "SELECT 1 FROM kauro.commercial_authorizations WHERE order_id = $1", [order.orderId])).length, 0);
  }

  // a wrong order: an event about a capture the platform recorded for one order, naming another order, is refused as WRONG_ORDER
  const paidOrder = await checkout(pw, "webhook-order");
  const otherOrder = await checkout(pw, "webhook-order-other");
  pw.paypal.approve(paidOrder.providerOrderId);
  const paidCapture = pw.paypal.captureAtProvider(paidOrder.providerOrderId);
  const first = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", paidCapture);
  assert.equal(completed<WebhookAck>(first.reply, 200).data.inboxState, "APPLIED");
  const misnamed = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", paidCapture, { overrides: { supplementary_data: { related_ids: { order_id: otherOrder.providerOrderId } } } });
  assert.equal(completed<WebhookAck>(misnamed.reply, 200).data.inboxState, "REJECTED");
  const [misnamedInbox] = await inboxOf(misnamed.eventId);
  assert.deepEqual(await exceptionsOf(misnamedInbox!.inbox_id), [{ kind: "WRONG_ORDER", agency_id: pw.w.A.agencyId, order_id: paidOrder.orderId, source: "WEBHOOK" }]);
  assert.equal((await capturesOf(otherOrder.orderId)).length, 0);

  // a duplicate delivery: the same inbox record, no second capture, no second completion event, no second commission record or posting
  const again = await postWebhook(pw, first.bytes, first.headers);
  assert.deepEqual(completed<WebhookAck>(again, 200).data, { received: true, inboxState: "APPLIED", duplicate: true, conflict: false });
  const captures = await capturesOf(paidOrder.orderId);
  assert.equal(captures.length, 1);
  const completions = await rows<{ event_id: string }>(pw, "SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'capture.completed.v1'", [captures[0]!.capture_id]);
  assert.equal(completions.length, 1);
  const consumers = await rows<{ consumer: string }>(pw, "SELECT consumer FROM kauro.outbox_records WHERE event_id = $1 ORDER BY consumer", [completions[0]!.event_id]);
  assert.deepEqual(consumers.map((c) => c.consumer), ["COMMISSIONS", "FINANCE", "FISCAL"], "one commission record, one posting delivery, one fiscal delivery");
  await dispatch(pw, "FINANCE");
  await postWebhook(pw, first.bytes, first.headers);
  await dispatch(pw, "FINANCE");
  const postings = await rows<{ n: string }>(pw, "SELECT count(DISTINCT event_id)::text AS n FROM kauro.ledger_entries WHERE source_ref = $1 AND source_kind = 'CAPTURE'", [captures[0]!.capture_id]);
  assert.equal(postings[0]!.n, "1", "one posting set for the one completion");
});

test("RACE: an identical retry of a delivery is the same inbox record, a delivery with another body under the same event id (the webhook's IDEMPOTENCY_CONFLICT) is a recorded conflict never APPLIED, a crash between the ingress commit and the application applies the record once, and delivery racing the capture settle yields one fact", async () => {
  // an identical retry: the same inbox record (DUPLICATE), nothing applied again
  const retried = await checkout(pw, "race-retry");
  pw.paypal.approve(retried.providerOrderId);
  const retriedCapture = pw.paypal.captureAtProvider(retried.providerOrderId);
  const first = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", retriedCapture);
  assert.equal(completed<WebhookAck>(first.reply, 200).data.inboxState, "APPLIED");
  const again = await postWebhook(pw, first.bytes, first.headers);
  assert.deepEqual(completed<WebhookAck>(again, 200).data, { received: true, inboxState: "APPLIED", duplicate: true, conflict: false });
  assert.equal((await inboxOf(first.eventId)).length, 1);
  assert.equal((await capturesOf(retried.orderId)).length, 1);

  // a crash between the ingress commit and the application: the RECEIVED record is applied once by the inbox worker
  const crashed = await checkout(pw, "race-crash");
  pw.paypal.approve(crashed.providerOrderId);
  const crashedCapture = pw.paypal.captureAtProvider(crashed.providerOrderId);
  pw.holds.arm("CMD030", "AFTER_INGRESS", "CRASH");
  const lost = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", crashedCapture);
  assert.equal(outcome(pw.api, lost.reply), "500 INTERNAL_ERROR -");
  const [received] = await inboxOf(lost.eventId);
  assert.equal(received?.state, "RECEIVED");
  assert.equal((await capturesOf(crashed.orderId)).length, 0);
  const pass = await pw.service.runInboxPass();
  assert.deepEqual(pass.applied.filter((a) => a.inboxId === received!.inbox_id), [{ inboxId: received!.inbox_id, state: "APPLIED" }]);
  assert.equal((await capturesOf(crashed.orderId)).length, 1);
  assert.equal(await orderState(crashed.orderId), "CAPTURED");
  const repeat = await pw.service.runInboxPass();
  assert.equal(repeat.applied.some((a) => a.inboxId === received!.inbox_id), false, "an applied record is never claimed again");
  assert.equal((await capturesOf(crashed.orderId)).length, 1);

  // another body under the same event id, before the first was applied: a recorded conflict, the record never APPLIED
  const conflicted = await checkout(pw, "race-conflict");
  pw.paypal.approve(conflicted.providerOrderId);
  const conflictedCapture = pw.paypal.captureAtProvider(conflicted.providerOrderId);
  pw.holds.arm("CMD030", "AFTER_INGRESS", "CRASH");
  const original = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", conflictedCapture);
  assert.equal(original.reply.status, 500);
  const other = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", conflictedCapture, { eventId: original.eventId, overrides: { update_time: "2026-09-26T00:00:00.000Z" } });
  assert.deepEqual(completed<WebhookAck>(other.reply, 200).data, { received: true, inboxState: "REJECTED", duplicate: false, conflict: true });
  const [record] = await inboxOf(original.eventId);
  assert.equal(record?.body_hash, sha256(original.bytes), "the recorded body stays the first; the other is never absorbed");
  const conflicts = await rows<{ body_hash: string }>(pw, "SELECT body_hash FROM kauro.inbox_body_conflicts WHERE inbox_id = $1", [record!.inbox_id]);
  assert.deepEqual(conflicts, [{ body_hash: sha256(other.bytes) }]);
  assert.deepEqual(await exceptionsOf(record!.inbox_id), [{ kind: "BODY_CONFLICT", agency_id: null, order_id: null, source: "WEBHOOK" }]);
  const redelivered = await postWebhook(pw, original.bytes, original.headers);
  assert.equal(completed<WebhookAck>(redelivered, 200).data.inboxState, "REJECTED", "a redelivery of the first body does not apply a conflicted record");
  await pw.service.runInboxPass();
  assert.equal((await inboxOf(original.eventId))[0]?.state, "REJECTED");
  assert.equal((await capturesOf(conflicted.orderId)).length, 0);

  // delivery racing the capture settle: both serialize on the order's row lock; the second sees the first's fact
  const raced = await checkout(pw, "race-settle");
  pw.paypal.approve(raced.providerOrderId);
  let called: () => void = () => undefined;
  const afterCall = new Promise<void>((resolve) => {
    called = resolve;
  });
  let proceed: () => void = () => undefined;
  const settleMayGo = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const capture = captureRun(pw, raced.orderId as PaymentOrderId, freshKey("race-capture"), async (point) => {
    if (point === "AFTER_CALL") {
      called();
      await settleMayGo;
    }
  });
  await afterCall;
  // the provider made the capture; its response waits in the command (the fake's view of the order names it)
  const providerCaptureId = (await pw.paypal.observeOrder({ providerOrderId: raced.providerOrderId })).captures[0]?.providerCaptureId;
  assert.ok(providerCaptureId !== undefined);
  const webhookHold = pw.holds.arm("CMD030", "APPLICATION_BEFORE_COMMIT", "WAIT");
  const delivery = deliver(pw, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
  await webhookHold.reached;
  proceed();
  await waitForLockWait(pw.w.h.oracle, `${PAYMENT_APPLICATION_NAME}-service`, "FROM kauro.payment_orders WHERE order_id = $1 FOR UPDATE");
  webhookHold.release();
  const [settled, webhook] = await Promise.all([capture, delivery]);
  assert.equal(settled.kind, "COMPLETED");
  assert.equal(completed<WebhookAck>(webhook.reply, 200).data.inboxState, "APPLIED");
  const facts = await capturesOf(raced.orderId);
  assert.equal(facts.length, 1, "one fact of the one capture");
  assert.equal(facts[0]!.first_observation_source, "WEBHOOK");
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.commercial_authorizations WHERE order_id = $1", [raced.orderId])).length, 1);
  const observations = await rows<{ source: string; effect: string }>(pw, "SELECT source, effect FROM kauro.provider_observations WHERE order_id = $1 AND subject_kind = 'CAPTURE' ORDER BY observed_at, source", [raced.orderId]);
  assert.deepEqual(observations.map((o) => o.source).sort(), ["DISPATCH_RESPONSE", "WEBHOOK"]);
  assert.equal(observations.find((o) => o.source === "DISPATCH_RESPONSE")?.effect, "DUPLICATE", "the settle that waited sees the webhook's fact");
  const attempts = await rows<{ state: string }>(pw, "SELECT state FROM kauro.payment_attempts WHERE order_id = $1 AND operation = 'CAPTURE'", [raced.orderId]);
  assert.deepEqual(attempts, [{ state: "CONFIRMED" }]);
  assert.equal(await orderState(raced.orderId), "CAPTURED");
});

