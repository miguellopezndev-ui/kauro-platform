// Contract tests of the labelled contract fakes of implementation mandate M2 (design §5 "Contract fakes", decision D-FAKE-B1): each
// fake implements the documented contract of the port it stands for — the PayPal Orders v2 shapes of the payment provider, the
// webhook signature over the exact raw bytes with freshness and environment, the immutable content-addressed evidence store, the
// fiscal bridge's pure `prepare`, the service authenticator's issuer/audience/identity/environment, and the platform ports of B07
// and B08 — declares CONTRACT_FAKE and the evidence class SIMULATED, and keeps a call log. None of this is integration evidence
// (21 "Evidence classes": the real adapters are B15's, B07's and B08's). The last test proves the fakes are test-only: no module the
// production entry point reaches is one of them, and no production source of the workspace imports the test-only subpath.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { UtcInstant } from "@kauro/contracts";
import type { CorrelationId, FiscalIssuerRef, FiscalProfileId, PaymentOrderId, TaxDocumentId, TaxDocumentRecord } from "@kauro/domain";
import { providerRequestHash, providerRequestIdOf } from "@kauro/domain";
import { checkoutPaths, createInMemoryPorts, emptyStore, fixedClock, sequentialIds } from "../src/index.js";
import {
  CONTRACT_FAKE,
  CapacityUnansweredError,
  FAKE_EVIDENCE_CLASS,
  PAYPAL_WEBHOOK_HEADERS,
  createDeliveryCapacityFake,
  createEvidenceStoreFake,
  createFiscalBridgeFake,
  createPayPalContractFake,
  createServiceAuthenticatorFake,
  createSourceAvailabilityFake,
  createSourceLineageFake,
  createWebhookVerifierFake,
  normalizePayPalWebhook,
  sealedAvailability,
} from "../src/commerce/testing/index.js";

const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
const HOUR = 3_600_000;

function world() {
  const clock = fixedClock();
  const ids = sequentialIds(clock);
  const paypal = createPayPalContractFake({ clock });
  return { clock, ids, paypal };
}

type World = ReturnType<typeof world>;

function createIntent(w: World, amountCents = 115579n) {
  const orderId = w.ids.next() as PaymentOrderId;
  const attemptId = w.ids.next();
  return { orderId, attemptId, providerRequestId: providerRequestIdOf(attemptId), amountCents, currency: "USD" as const, description: "KAURO_PROJECT_PREPARATION" as const, ...checkoutPaths(orderId) };
}

const inFuture = (w: World, ms = 60_000): UtcInstant => new Date(w.clock.nowMs() + ms).toISOString();

/** Creates and approves a provider order through the fake's own contract; returns its provider id. */
async function approvedOrder(w: World): Promise<string> {
  const created = await w.paypal.dispatch(w.paypal.prepareCreateOrder(createIntent(w)), inFuture(w));
  assert.equal(created.kind, "ORDER_CREATED");
  if (created.kind !== "ORDER_CREATED") throw new Error("unreachable");
  w.paypal.approve(created.providerOrderId);
  return created.providerOrderId;
}

test("PayPal Orders v2 contract fake: labelled CONTRACT_FAKE / SIMULATED; prepare is pure and exact — the Orders v2 body, the attempt's PayPal-Request-Id kauro-<attemptId> and a credential reference, never a credential; one dispatch per request identity (a replayed id answers the first result and makes no second effect), nothing is sent past the deadline, and every call is logged", async () => {
  const w = world();
  const p = w.paypal;
  assert.equal(p.integrationClass, CONTRACT_FAKE);
  assert.equal(p.evidenceClass, FAKE_EVIDENCE_CLASS);
  assert.equal(p.provider, "paypal");
  assert.equal(p.payeeDigest, sha(p.merchantId), "the route's payee digest is the SHA-256 of the merchant id (S058)");

  const intent = createIntent(w);
  const request = p.prepareCreateOrder(intent);
  assert.deepEqual(p.prepareCreateOrder(intent), request, "prepare is pure");
  assert.equal(providerRequestHash(p.prepareCreateOrder(intent)), providerRequestHash(request), "the attempt's request hash is reproducible from durable facts");
  assert.equal(request.method, "POST");
  assert.equal(request.endpointProfile, "ORDERS_V2_CREATE");
  assert.deepEqual(request.headers, { "PayPal-Request-Id": `kauro-${intent.attemptId}`, Prefer: "return=representation" });
  const json = (request.body as unknown as { json: { intent: string; purchase_units: Array<{ reference_id: string; amount: { currency_code: string; value: string }; payee: { merchant_id: string } }>; application_context: { return_url: string; cancel_url: string } } }).json;
  assert.equal(json.intent, "CAPTURE");
  assert.deepEqual(json.purchase_units[0]!.amount, { currency_code: "USD", value: "1155.79" }, "money as the provider's exact two-decimal string");
  assert.equal(json.purchase_units[0]!.reference_id, intent.orderId);
  assert.equal(json.purchase_units[0]!.payee.merchant_id, p.merchantId);
  assert.equal(json.application_context.return_url, `https://app.kauro.test/app/checkout/${intent.orderId}/return`);
  assert.match(request.credentialRef, /^secret-manager:\/\//, "a reference to the secret manager, never the secret itself");
  assert.throws(() => p.prepareCreateOrder({ ...intent, currency: "EUR" as "USD" }), /USD only/);
  const otherAmount = p.prepareCreateOrder({ ...intent, amountCents: 115578n });
  assert.notEqual(providerRequestHash(otherAmount), providerRequestHash(request), "a request whose content differs has another digest");

  const created = await p.dispatch(request, inFuture(w));
  assert.equal(created.kind, "ORDER_CREATED");
  if (created.kind !== "ORDER_CREATED") return;
  assert.equal(new URL(created.approvalUrl).hostname, p.approvalHosts[0], "the approval page is on the allowlisted host");
  assert.equal(p.effects.ordersCreated, 1);
  // the same request identity again (a retry of the same attempt): the first result, no second effect
  assert.deepEqual(await p.dispatch(request, inFuture(w)), created);
  assert.equal(p.effects.ordersCreated, 1);
  assert.deepEqual(p.orderByRequestId(intent.providerRequestId), { id: created.providerOrderId, status: "CREATED" });
  assert.deepEqual(
    p.calls.map((c) => [c.port, c.operation, c.identity, c.sent]),
    [
      ["PaymentProviderAdapter", "DISPATCH ORDERS_V2_CREATE", `kauro-${intent.attemptId}`, true],
      ["PaymentProviderAdapter", "DISPATCH ORDERS_V2_CREATE", `kauro-${intent.attemptId}`, true],
    ],
  );

  // past its deadline the adapter sends nothing: AMBIGUOUS TIMEOUT, logged as not sent, no order at the provider
  const late = createIntent(w);
  const timedOut = await p.dispatch(p.prepareCreateOrder(late), new Date(w.clock.nowMs() - 1).toISOString());
  assert.deepEqual(timedOut, { kind: "AMBIGUOUS", reason: "TIMEOUT" });
  assert.equal(p.calls.at(-1)!.sent, false);
  assert.equal(p.orderByRequestId(late.providerRequestId), null);
  assert.equal(p.effects.ordersCreated, 1);
  const byRequest = await p.observeOrder({ providerRequestId: late.providerRequestId });
  assert.deepEqual([byRequest.orderStatus, byRequest.providerOrderId, byRequest.absenceIsProof], ["NOT_FOUND", null, true], "the documented lookup by request identity proves absence");
});

test("PayPal Orders v2 contract fake: programmable ORDER_CREATED, PROVED_NO_EFFECT, AMBIGUOUS (a lost response whose effect happened, or not) and UNRECOGNIZED; a lost creation is found by its request identity and never created twice", async () => {
  const w = world();
  const p = w.paypal;
  p.program("ORDERS_V2_CREATE", { kind: "PROVED_NO_EFFECT", outcomeCode: "VALIDATION_ERROR" });
  const refused = createIntent(w);
  const r1 = await p.dispatch(p.prepareCreateOrder(refused), inFuture(w));
  assert.equal(r1.kind, "PROVED_NO_EFFECT");
  assert.equal(r1.kind === "PROVED_NO_EFFECT" ? r1.outcomeCode : null, "VALIDATION_ERROR");
  assert.equal(p.orderByRequestId(refused.providerRequestId), null);

  p.program("ORDERS_V2_CREATE", { kind: "AMBIGUOUS", reason: "CONNECTION_RESET", effect: "APPLIED" });
  const lost = createIntent(w);
  assert.deepEqual(await p.dispatch(p.prepareCreateOrder(lost), inFuture(w)), { kind: "AMBIGUOUS", reason: "CONNECTION_RESET" });
  const found = await p.observeOrder({ providerRequestId: lost.providerRequestId });
  assert.equal(found.orderStatus, "CREATED", "the lost response's order exists at the provider and is found by the attempt's request identity");
  assert.ok(found.providerOrderId !== null && found.approvalUrl !== undefined);
  // the retry of the same attempt (same request id) answers the order the provider made; still one order
  const replay = await p.dispatch(p.prepareCreateOrder(lost), inFuture(w));
  assert.equal(replay.kind === "ORDER_CREATED" ? replay.providerOrderId : null, found.providerOrderId);
  assert.equal(p.effects.ordersCreated, 1);

  p.program("ORDERS_V2_CREATE", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "NOT_APPLIED" });
  const notMade = createIntent(w);
  assert.equal((await p.dispatch(p.prepareCreateOrder(notMade), inFuture(w))).kind, "AMBIGUOUS");
  assert.equal((await p.observeOrder({ providerRequestId: notMade.providerRequestId })).orderStatus, "NOT_FOUND");

  p.program("ORDERS_V2_CREATE", { kind: "UNRECOGNIZED" });
  assert.equal((await p.dispatch(p.prepareCreateOrder(createIntent(w)), inFuture(w))).kind, "UNRECOGNIZED");
  // the queue is FIFO and empties back to the provider's default behaviour
  assert.equal((await p.dispatch(p.prepareCreateOrder(createIntent(w)), inFuture(w))).kind, "ORDER_CREATED");
});

test("PayPal Orders v2 contract fake: capture behaves as the provider — an order the buyer has not approved is PROVED_NO_EFFECT, an approved one yields the authenticated capture (payee digest, currency, amount, completion instant), a second capture is refused; captures deviate only as programmed (S058 shapes); the order view carries its captures and refunds", async () => {
  const w = world();
  const p = w.paypal;
  const created = await p.dispatch(p.prepareCreateOrder(createIntent(w)), inFuture(w));
  if (created.kind !== "ORDER_CREATED") throw new Error("the fake creates by default");
  const orderId = created.providerOrderId;
  const capture = (attemptId = w.ids.next()) => p.prepareCapture({ orderId: "x", attemptId, providerRequestId: providerRequestIdOf(attemptId), providerOrderId: orderId, amountCents: 115579n, currency: "USD" });
  const early = await p.dispatch(capture(), inFuture(w));
  assert.equal(early.kind === "PROVED_NO_EFFECT" ? early.outcomeCode : early.kind, "ORDER_NOT_APPROVED");
  p.approve(orderId);
  const request = capture();
  assert.equal(request.endpointProfile, "ORDERS_V2_CAPTURE");
  const captured = await p.dispatch(request, inFuture(w));
  assert.equal(captured.kind, "CAPTURE_OBSERVED");
  if (captured.kind !== "CAPTURE_OBSERVED") return;
  const c = captured.capture;
  assert.deepEqual([c.provider, c.environment, c.providerOrderId, c.status, c.amountCents, c.currency, c.payeeDigest, c.providerCompletedAt, c.fundsState, c.feeCents], ["paypal", "SANDBOX", orderId, "COMPLETED", 115579n, "USD", p.payeeDigest, w.clock.now(), "UNKNOWN", null]);
  assert.deepEqual(await p.dispatch(request, inFuture(w)), captured, "a replayed capture request answers the same capture");
  assert.equal(p.effects.captures, 1);
  const again = await p.dispatch(capture(), inFuture(w));
  assert.equal(again.kind === "PROVED_NO_EFFECT" ? again.outcomeCode : again.kind, "ORDER_ALREADY_CAPTURED");

  // provider-side facts learned later: a reported fee, a delayed disbursement (held funds), a reversal keeping the completion
  p.updateCapture(c.providerCaptureId, { feeCents: 5275n, disbursement: "DELAYED" });
  const view = await p.observeOrder({ providerOrderId: orderId });
  assert.equal(view.orderStatus, "COMPLETED");
  assert.deepEqual([view.captures[0]!.feeCents, view.captures[0]!.fundsState], [5275n, "HELD"]);
  w.clock.advance(HOUR);
  p.updateCapture(c.providerCaptureId, { status: "REVERSED" });
  const reversed = (await p.observeOrder({ providerOrderId: orderId })).captures[0]!;
  assert.deepEqual([reversed.status, reversed.providerCompletedAt], ["REVERSED", c.providerCompletedAt], "a reversal keeps the completion instant (the sale's tax point)");

  // a capture deviating from the order exactly as programmed (another payee, a partial amount)
  const w2 = world();
  const order2 = await approvedOrder(w2);
  w2.paypal.program("ORDERS_V2_CAPTURE", { kind: "CAPTURE_OBSERVED", capture: { merchantId: "ANOTHERMERCHANT", amountCents: 50000n } });
  const attemptId = w2.ids.next();
  const odd = await w2.paypal.dispatch(w2.paypal.prepareCapture({ orderId: "x", attemptId, providerRequestId: providerRequestIdOf(attemptId), providerOrderId: order2, amountCents: 115579n, currency: "USD" }), inFuture(w2));
  assert.ok(odd.kind === "CAPTURE_OBSERVED" && odd.capture.payeeDigest === sha("ANOTHERMERCHANT") && odd.capture.amountCents === 50000n);
});

test("PayPal Orders v2 contract fake: a refund is dispatched once per request identity and observed by provider id or by the capture and request identity (absence is proof); stored query evidence re-classifies into the same observation without the network", async () => {
  const w = world();
  const p = w.paypal;
  const orderId = await approvedOrder(w);
  const captureId = p.captureAtProvider(orderId);
  const attemptId = w.ids.next();
  const refundId = w.ids.next();
  const request = p.prepareRefund({ refundId, attemptId, providerRequestId: providerRequestIdOf(attemptId), providerCaptureId: captureId, amountCents: 1190n, currency: "USD" });
  assert.equal(request.endpointProfile, "CAPTURES_V2_REFUND");
  assert.deepEqual((request.body as unknown as { json: unknown }).json, { amount: { currency_code: "USD", value: "11.90" }, invoice_id: refundId });
  const done = await p.dispatch(request, inFuture(w));
  assert.equal(done.kind, "REFUND_OBSERVED");
  if (done.kind !== "REFUND_OBSERVED") return;
  assert.deepEqual([done.refund.providerCaptureId, done.refund.status, done.refund.amountCents, done.refund.currency], [captureId, "COMPLETED", 1190n, "USD"]);
  await p.dispatch(request, inFuture(w));
  assert.equal(p.effects.refunds, 1, "one refund per request identity");
  assert.deepEqual(await p.observeRefund({ providerCaptureId: captureId, providerRequestId: providerRequestIdOf(attemptId) }), done.refund);
  assert.deepEqual(await p.observeRefund({ providerRefundId: done.refund.providerRefundId }), done.refund);
  const elsewhere = await p.observeRefund({ providerCaptureId: "PPC99999999999999", providerRequestId: providerRequestIdOf(attemptId) });
  assert.ok("kind" in elsewhere && elsewhere.kind === "NOT_FOUND" && elsewhere.absenceIsProof);
  // a programmed answer: the provider accepted the refund but has not completed it yet (PENDING)
  p.program("CAPTURES_V2_REFUND", { kind: "REFUND_OBSERVED", status: "PENDING" });
  const pendingAttempt = w.ids.next();
  const pending = await p.dispatch(p.prepareRefund({ refundId: w.ids.next(), attemptId: pendingAttempt, providerRequestId: providerRequestIdOf(pendingAttempt), providerCaptureId: captureId, amountCents: 500n, currency: "USD" }), inFuture(w));
  assert.deepEqual(pending.kind === "REFUND_OBSERVED" ? [pending.refund.status, pending.refund.amountCents] : pending.kind, ["PENDING", 500n]);
  const view = await p.observeOrder({ providerOrderId: orderId });
  assert.deepEqual(view.refunds.map((r) => [r.providerRefundId, r.status]), [[done.refund.providerRefundId, "COMPLETED"], [pending.kind === "REFUND_OBSERVED" ? pending.refund.providerRefundId : "", "PENDING"]]);

  const stored = { artifactRef: "a", kind: "PROVIDER_QUERY" as const, provider: "paypal", environment: "SANDBOX" as const, sha256: sha("q"), capturedAt: w.clock.now(), authenticatedBy: "PROVIDER_API_RESPONSE" as const, normalized: view, integrationClass: CONTRACT_FAKE };
  assert.deepEqual(p.classifyOrderObservation(stored), view);
  assert.throws(() => p.classifyOrderObservation({ ...stored, provider: "stripe" }), /not a PayPal order observation/);
});

test("WebhookVerifier contract fake: the signature covers the exact raw bytes, the transmission and the environment's webhook — a changed byte or header is PROVIDER_SIGNATURE_INVALID, an event signed for the other environment PROVIDER_ENVIRONMENT_MISMATCH, a transmission outside the freshness window PROVIDER_EVENT_STALE, a body beyond the bound is refused; a verified body is classified into the normalized event, never the vendor schema", async () => {
  const w = world();
  const verifier = createWebhookVerifierFake({ clock: w.clock });
  assert.equal(verifier.integrationClass, CONTRACT_FAKE);
  assert.equal(verifier.evidenceClass, FAKE_EVIDENCE_CLASS);
  assert.equal(verifier.freshnessSeconds, 300, "Q-B09-4: 300 s by default");
  const orderId = await approvedOrder(w);
  const captureId = w.paypal.captureAtProvider(orderId, { feeCents: 5275n, disbursement: "INSTANT" });
  const { bytes, eventId } = w.paypal.webhookBody("PAYMENT.CAPTURE.COMPLETED", captureId);
  const headers = verifier.sign(bytes);
  const ok = await verifier.verify({ bytes, headers, receivedAt: w.clock.now() });
  assert.equal(ok.kind, "VERIFIED");
  if (ok.kind !== "VERIFIED") return;
  assert.deepEqual([ok.event.kind, ok.event.provider, ok.event.environment, ok.event.externalEventId, ok.event.bodyHash, ok.event.providerOrderId], ["CAPTURE_COMPLETED", "paypal", "SANDBOX", eventId, sha(bytes), orderId]);
  const c = ok.event.capture!;
  assert.deepEqual([c.providerCaptureId, c.status, c.amountCents, c.currency, c.payeeDigest, c.feeCents, c.fundsState, c.providerCompletedAt], [captureId, "COMPLETED", 115579n, "USD", w.paypal.payeeDigest, 5275n, "AVAILABLE", w.clock.now()]);

  const tampered = Uint8Array.from(bytes);
  tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
  assert.deepEqual(await verifier.verify({ bytes: tampered, headers, receivedAt: w.clock.now() }), { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" });
  assert.deepEqual(await verifier.verify({ bytes, headers: { ...headers, [PAYPAL_WEBHOOK_HEADERS.transmissionId]: "tx-other" }, receivedAt: w.clock.now() }), { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" });
  assert.deepEqual(await verifier.verify({ bytes, headers: { ...headers, [PAYPAL_WEBHOOK_HEADERS.algorithm]: "SHA256withRSA" }, receivedAt: w.clock.now() }), { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" });
  assert.deepEqual(await verifier.verify({ bytes, headers: { [PAYPAL_WEBHOOK_HEADERS.transmissionId]: "tx" }, receivedAt: w.clock.now() }), { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" });
  assert.deepEqual(await verifier.verify({ bytes, headers: createWebhookVerifierFake({ clock: w.clock, secret: "another-secret" }).sign(bytes), receivedAt: w.clock.now() }), { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" });
  assert.deepEqual(await verifier.verify({ bytes, headers: verifier.sign(bytes, { environment: "LIVE" }), receivedAt: w.clock.now() }), { kind: "REJECTED", reason: "PROVIDER_ENVIRONMENT_MISMATCH" });
  const sentAt = w.clock.now();
  const fresh = verifier.sign(bytes, { transmissionTime: sentAt });
  assert.equal((await verifier.verify({ bytes, headers: fresh, receivedAt: new Date(Date.parse(sentAt) + 299_000).toISOString() })).kind, "VERIFIED");
  assert.deepEqual(await verifier.verify({ bytes, headers: fresh, receivedAt: new Date(Date.parse(sentAt) + 301_000).toISOString() }), { kind: "REJECTED", reason: "PROVIDER_EVENT_STALE" });
  const bounded = createWebhookVerifierFake({ clock: w.clock, maxBodyBytes: 64 });
  assert.equal((await bounded.verify({ bytes, headers: bounded.sign(bytes), receivedAt: w.clock.now() })).kind, "REJECTED", "a body beyond the bound is refused before anything is trusted");
  assert.equal(verifier.calls.length, 9);
  assert.ok(verifier.calls.every((call) => call.port === "WebhookVerifier" && call.operation === "VERIFY"));
});

test("WebhookVerifier contract fake: the classifier maps the provider's events to the normalized vocabulary — a reversal carries no completion instant (D-PAY-B6), a refund names its capture, a dispute its disputed amount, an unknown type or an unreadable signed body is UNRECOGNIZED, never coerced", async () => {
  const w = world();
  const verifier = createWebhookVerifierFake({ clock: w.clock });
  const orderId = await approvedOrder(w);
  const captureId = w.paypal.captureAtProvider(orderId);
  const verified = async (bytes: Uint8Array) => {
    const r = await verifier.verify({ bytes, headers: verifier.sign(bytes), receivedAt: w.clock.now() });
    assert.equal(r.kind, "VERIFIED");
    return r.kind === "VERIFIED" ? r.event : null;
  };
  const approved = await verified(w.paypal.webhookBody("CHECKOUT.ORDER.APPROVED", orderId).bytes);
  assert.deepEqual([approved?.kind, approved?.providerOrderId], ["ORDER_APPROVED", orderId]);
  w.paypal.updateCapture(captureId, { status: "REVERSED" });
  const reversal = await verified(w.paypal.webhookBody("PAYMENT.CAPTURE.REVERSED", captureId).bytes);
  assert.deepEqual([reversal?.kind, reversal?.capture?.status, reversal?.capture?.providerCompletedAt], ["CAPTURE_REVERSED", "REVERSED", null]);
  const refundId = w.paypal.refundAtProvider(captureId, 1190n);
  const refund = await verified(w.paypal.webhookBody("PAYMENT.CAPTURE.REFUNDED", refundId).bytes);
  assert.deepEqual([refund?.kind, refund?.refund?.providerRefundId, refund?.refund?.providerCaptureId, refund?.refund?.amountCents], ["REFUND_COMPLETED", refundId, captureId, 1190n]);
  w.paypal.dispute(captureId, { status: "OPEN", amountCents: 20000n });
  const opened = await verified(w.paypal.webhookBody("CUSTOMER.DISPUTE.CREATED", captureId).bytes);
  assert.deepEqual([opened?.kind, opened?.dispute?.providerCaptureId, opened?.dispute?.amountCents, opened?.dispute?.status], ["DISPUTE_OPENED", captureId, 20000n, "OPEN"]);
  w.paypal.dispute(captureId, { status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" });
  assert.equal((await verified(w.paypal.webhookBody("CUSTOMER.DISPUTE.RESOLVED", captureId).bytes))?.kind, "DISPUTE_CLOSED");
  w.paypal.dispute(captureId, { status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR" });
  assert.equal((await verified(w.paypal.webhookBody("CUSTOMER.DISPUTE.RESOLVED", captureId).bytes))?.kind, "UNRECOGNIZED", "a loss arrives as a reversal; the resolution alone is not coerced");
  assert.equal((await verified(w.paypal.webhookBody("PAYMENT.PAYOUTS-ITEM.UNCLAIMED", "X1").bytes))?.kind, "UNRECOGNIZED");
  const unreadable = new TextEncoder().encode("not json at all");
  const opaque = await verified(unreadable);
  assert.deepEqual([opaque?.kind, opaque?.bodyHash], ["UNRECOGNIZED", sha(unreadable)]);
  assert.equal(normalizePayPalWebhook(new TextEncoder().encode("{}"), "SANDBOX"), null);
});

test("ProviderEvidenceStore contract fake: immutable and content-addressed — the same bytes answer the same reference and a second put never replaces what was stored; what get returns is frozen, its digest is the bytes' SHA-256, an unknown reference is null", async () => {
  const w = world();
  const store = createEvidenceStoreFake({ clock: w.clock });
  assert.equal(store.integrationClass, CONTRACT_FAKE);
  assert.equal(store.evidenceClass, FAKE_EVIDENCE_CLASS);
  const bytes = new TextEncoder().encode('{"id":"WH-1"}');
  const meta = { kind: "WEBHOOK_BODY" as const, provider: "paypal", environment: "SANDBOX" as const, capturedAt: w.clock.now(), authenticatedBy: "WEBHOOK_SIGNATURE" as const, normalized: { kind: "UNRECOGNIZED" as const, provider: "paypal", environment: "SANDBOX" as const, externalEventId: "WH-1", bodyHash: sha(bytes) }, integrationClass: CONTRACT_FAKE };
  const first = await store.put({ ...meta, bytes });
  assert.equal(first.sha256, sha(bytes));
  assert.match(first.artifactRef, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a UUIDv8 content address");
  const second = await store.put({ ...meta, kind: "PROVIDER_QUERY", bytes: Uint8Array.from(bytes) });
  assert.deepEqual(second, first);
  const got = await store.get(first.artifactRef);
  assert.equal(got?.kind, "WEBHOOK_BODY", "the first stored evidence is never replaced");
  assert.ok(got !== null && Object.isFrozen(got) && Object.isFrozen(got.normalized));
  const copy = store.bytesOf(first.artifactRef)!;
  copy[0] = 0;
  assert.equal(sha(store.bytesOf(first.artifactRef)!), first.sha256, "the stored bytes cannot be changed through a read");
  assert.equal(await store.get("00000000-0000-8000-8000-000000000000"), null);
  assert.deepEqual(store.calls.map((c) => c.operation), ["PUT", "PUT", "GET", "GET"]);
});

test("FiscalDocumentBridge contract fake: prepare only — the issuance packet of a VALIDATED, unblocked document carries exactly its reviewed fiscal snapshot and a deterministic request digest; a draft, a snapshot other than the document's and a credit note without its invoice's legal number are refused; submit and observe are the issuance command's (B15) and refused here", async () => {
  const w = world();
  const bridge = createFiscalBridgeFake();
  assert.equal(bridge.integrationClass, CONTRACT_FAKE);
  assert.equal(bridge.evidenceClass, FAKE_EVIDENCE_CLASS);
  const issuerRef = w.ids.next() as FiscalIssuerRef;
  const profile = { profileId: w.ids.next() as FiscalProfileId, agencyId: w.ids.next() as never, operatorLegalRef: issuerRef, customerLegalRef: "c", serviceClassification: "DATA_PREPARATION", territory: "CO", taxTreatment: "DOMESTIC_TAXABLE" as const, taxRule: "RATE_HALF_UP" as const, taxRateBps: 1900, evidenceHash: sha("p"), validFrom: w.clock.now(), recordedAt: w.clock.now() };
  const issuer = { issuerRef, jurisdiction: "CO", legalIdentityHash: sha("i"), legalFactStatus: "OBSERVED" as const, routeKind: "PROVIDER_API" as const, integrationClass: CONTRACT_FAKE, routeState: "QUALIFIED" as const, numberingAuthorizationRef: "NUM-1", validFrom: w.clock.now() };
  const invoice: TaxDocumentRecord = { documentId: w.ids.next() as TaxDocumentId, agencyId: profile.agencyId, orderId: w.ids.next() as never, captureId: w.ids.next() as never, kind: "INVOICE", version: 2, state: "VALIDATED", fiscalProfileId: profile.profileId, issuerRef, taxTreatment: "DOMESTIC_TAXABLE", serviceCents: 97125n, taxCents: 18454n, currency: "USD" };
  const packet = bridge.prepare(invoice, { profile, issuer });
  assert.deepEqual(packet, bridge.prepare(invoice, { profile, issuer }), "pure");
  assert.deepEqual([packet.kind, packet.treatment, packet.serviceCents, packet.taxCents, packet.currency], ["INVOICE", "DOMESTIC_TAXABLE", 97125n, 18454n, "USD"]);
  assert.match(packet.issueRequestHash, /^[0-9a-f]{64}$/);
  assert.notEqual(bridge.prepare({ ...invoice, taxCents: 18453n }, { profile, issuer }).issueRequestHash, packet.issueRequestHash);
  assert.throws(() => bridge.prepare({ ...invoice, state: "DRAFT" }, { profile, issuer }), /VALIDATED/);
  assert.throws(() => bridge.prepare(invoice, { profile: { ...profile, taxTreatment: "EXEMPT_EXPORT" }, issuer }), /fiscal snapshot/);
  assert.throws(() => bridge.prepare(invoice, { profile, issuer: { ...issuer, issuerRef: w.ids.next() as FiscalIssuerRef } }), /issuer/);
  const creditNote: TaxDocumentRecord = { ...invoice, documentId: w.ids.next() as TaxDocumentId, kind: "CREDIT_NOTE", refundId: w.ids.next() as never, serviceCents: 1000n, taxCents: 190n, correctsDocumentId: invoice.documentId };
  assert.throws(() => bridge.prepare(creditNote, { profile, issuer, original: invoice }), /legal number/);
  assert.equal(bridge.prepare(creditNote, { profile, issuer, original: { ...invoice, state: "ISSUED", legalNumber: "SETP-1" } }).correctsLegalNumber, "SETP-1");
  await assert.rejects(bridge.submit(packet, inFuture(w)), /CMD035/);
  await assert.rejects(bridge.observe({ issueRequestHash: packet.issueRequestHash }), /CMD035/);
});

test("ServiceAuthenticator contract fake: a signed service token verifies to its identity only with this deployment's issuer and audience, the bytes it was signed over and an unexpired lifetime; the environment it was issued for is carried to the authorizer", async () => {
  const w = world();
  const auth = createServiceAuthenticatorFake({ clock: w.clock });
  assert.equal(auth.integrationClass, CONTRACT_FAKE);
  assert.equal(auth.evidenceClass, FAKE_EVIDENCE_CLASS);
  const identity = { serviceId: "payment-service", audience: "kauro-api", environment: "SANDBOX" as const };
  assert.deepEqual(await auth.authenticate({ authorization: auth.mint(identity) }), identity);
  assert.deepEqual(await auth.authenticate({ authorization: auth.mint({ ...identity, environment: "LIVE" }) }), { ...identity, environment: "LIVE" });
  assert.equal(await auth.authenticate({ authorization: auth.mint({ ...identity, audience: "another-api" }) }), null, "another audience");
  assert.equal(await auth.authenticate({ authorization: auth.mint(identity, { issuer: "https://attacker.example" }) }), null, "another issuer");
  assert.equal(await auth.authenticate({ authorization: auth.mint(identity, { secret: "not-the-signing-key" }) }), null, "a signature this deployment does not trust");
  assert.equal(await auth.authenticate({ authorization: auth.mint(identity, { expiresAt: w.clock.now() }) }), null, "an expired token");
  const token = auth.mint(identity);
  const [payload, signature] = token.slice("Bearer ".length).split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")), sub: "fiscal-service" })).toString("base64url");
  assert.equal(await auth.authenticate({ authorization: `Bearer ${forged}.${signature}` }), null, "a changed claim breaks the signature");
  assert.equal(await auth.authenticate({ authorization: `${token}.extra` }), null);
  assert.equal(await auth.authenticate({}), null);
  assert.equal(auth.calls.length, 9);
});

test("platform contract fakes of B07 and B08 (binding CONTRACT_FAKE until their package is on main): source availability and lineage answer what was programmed and null otherwise, the capacity admission answers capacity, a stated refusal or nothing at all; each is read inside the caller's unit of work and logs it", async () => {
  const w = world();
  const ports = createInMemoryPorts(w.clock, w.ids, emptyStore());
  const availability = createSourceAvailabilityFake({ clock: w.clock });
  const lineage = createSourceLineageFake({ clock: w.clock });
  const capacity = createDeliveryCapacityFake({ clock: w.clock });
  for (const f of [availability, lineage, capacity]) {
    assert.equal(f.binding, CONTRACT_FAKE);
    assert.equal(f.evidenceClass, FAKE_EVIDENCE_CLASS);
  }
  const agencyId = w.ids.next() as never;
  const projectId = w.ids.next() as never;
  const context = { kind: "TENANT" as const, agencyId, userId: w.ids.next() as never, correlationId: w.ids.next() as CorrelationId };
  const revisionHash = sha("manifest");
  await ports.unitOfWork.run(context, async (uow) => {
    assert.equal(await availability.availabilityOf(uow, { agencyId, projectId, revisionHash }), null);
    availability.set(revisionHash, sealedAvailability("rev-1", w.clock.now(), inFuture(w, 7 * 24 * HOUR)));
    const a = await availability.availabilityOf(uow, { agencyId, projectId, revisionHash });
    assert.deepEqual([a?.state, a?.effectiveDeadline], ["SEALED", inFuture(w, 7 * 24 * HOUR)]);
    assert.match(a?.evidenceHash ?? "", /^[0-9a-f]{64}$/);
    availability.set(revisionHash, null);
    assert.equal(await availability.availabilityOf(uow, { agencyId, projectId, revisionHash }), null, "a revision the lifecycle no longer knows");

    const replacement = sha("manifest-2");
    assert.equal(await lineage.replacementOf(uow, { agencyId, projectId, replacedRevisionHash: revisionHash, replacementRevisionHash: replacement }), null);
    lineage.set(revisionHash, replacement, { replacedRevisionId: "rev-1", replacementRevisionId: "rev-2", replacementSealed: true });
    assert.equal((await lineage.replacementOf(uow, { agencyId, projectId, replacedRevisionHash: revisionHash, replacementRevisionHash: replacement }))?.replacementRevisionId, "rev-2");

    const request = { agencyId, projectId, mode: "CLEAN" as const, billableUnits: 1000, at: w.clock.now() };
    const yes = await capacity.checkoutCapacity(uow, request);
    assert.ok(yes.available && /^[0-9a-f]{64}$/.test(yes.evidenceHash));
    capacity.set({ available: false, reason: "ADMISSION_QUEUE_FULL" });
    assert.deepEqual(await capacity.checkoutCapacity(uow, request), { available: false, reason: "ADMISSION_QUEUE_FULL" });
    capacity.set({ noAnswer: true });
    await assert.rejects(capacity.checkoutCapacity(uow, request), CapacityUnansweredError);
  });
  assert.deepEqual(availability.calls.map((c) => c.operation), ["AVAILABILITY_OF TENANT", "AVAILABILITY_OF TENANT", "AVAILABILITY_OF TENANT"]);
  assert.deepEqual(capacity.calls.map((c) => c.operation), ["CHECKOUT_CAPACITY TENANT", "CHECKOUT_CAPACITY TENANT", "CHECKOUT_CAPACITY TENANT"]);
  assert.equal(lineage.calls.length, 2);
});

// --- the fakes are test-only (architecture.rules.json testOnlySubpaths; D-FAKE-B1) --------------------------------------------------

const packageRoot = resolve(import.meta.dirname, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const IMPORT = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** The source modules the production entry point reaches through relative imports (the whole shipped graph of the package). */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2];
      if (spec === undefined || !spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(target)) visit(target);
    }
  };
  visit(entry);
  return seen;
}

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "test") continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) sourcesUnder(path, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

test("D-FAKE-B1: no contract fake is reachable from production wiring — the package's entry point never reaches the test-only commerce/testing modules, which only the ./testing subpath exports, and no production source of the workspace imports @kauro/application/testing", () => {
  const testingDir = join(packageRoot, "src", "commerce", "testing") + (process.platform === "win32" ? "\\" : "/");
  const reachable = [...reachableFrom(join(packageRoot, "src", "index.ts"))];
  assert.ok(reachable.some((f) => f.endsWith(join("commerce", "core", "provider-effects.ts"))), "the walk follows the entry point's graph");
  assert.deepEqual(reachable.filter((f) => f.startsWith(testingDir)), []);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { exports: Record<string, { default: string }> };
  assert.equal(manifest.exports["./testing"]?.default, "./dist/src/commerce/testing/index.js");
  const rules = JSON.parse(readFileSync(join(repoRoot, "architecture.rules.json"), "utf8")) as { testOnlySubpaths: string[] };
  assert.ok(rules.testOnlySubpaths.includes("/testing"));
  const production = [...sourcesUnder(join(repoRoot, "packages")), ...sourcesUnder(join(repoRoot, "apps"))];
  assert.ok(production.length > 50);
  const offenders = production.filter((f) => /["']@kauro\/application\/testing["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});
