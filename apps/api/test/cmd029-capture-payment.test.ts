// CMD029 CapturePayment through its route (package B09, implementation mandate M4; docs/design/B09-case-map.md CMD029-OK,
// CMD029-DENY, CMD029-RACE; design §8 CMD029, §6.1, §6.3): the capture is dispatched by the server, its authenticated result applied
// by the payment service's settle step (kauro_payment) through the one reconciler — the only writer of a capture fact and of the
// CommercialAuthorization (D-AUTH-B4) — and the request handler completes its own journal. The provider is the labelled PayPal
// Orders v2 contract fake (SIMULATED; D-FAKE-B1); a capture racing its own webhook applies the webhook through the same reconciler
// (M2's), as CMD030's application half does. Crash points are the provider-effect protocol's; nothing sleeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CapturePaymentView, CreatePaymentOrderView, PaymentOrderDetailView } from "@kauro/application";
import { COMMERCE_COMMAND_EVENTS } from "@kauro/application";
import { createWebhookVerifierFake } from "@kauro/application/testing";
import { accepted, paymentRoutes, paymentsWorld, read, readData, subscribersOf, type PaymentsWorld } from "./commerce-support.js";
import { call, completed, freshKey, outcome, asProblem, replayTextOf, type Reply } from "./support.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

const HOUR_MS = 3_600_000;

interface ApprovedOrder {
  readonly quoteId: string;
  readonly orderId: string;
  readonly providerOrderId: string;
  readonly totalCents: bigint;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
}

/** An order created through CMD028 and approved by its buyer at the provider's hosted page. */
async function approvedOrder(label: string): Promise<ApprovedOrder> {
  const { w } = pw;
  const quote = await pw.readyQuote(label);
  const created = completed<CreatePaymentOrderView>(await call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: w.billing.token, key: freshKey(`${label}-order`), body: { termsHash: quote.termsHash } }), 201);
  const providerOrderId = created.data.order.providerOrderId!;
  pw.provider.approve(providerOrderId);
  return { quoteId: quote.quoteId, orderId: created.data.order.orderId, providerOrderId, totalCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents };
}

function capture(order: ApprovedOrder, options: { readonly key?: string; readonly token?: string; readonly ref?: string; readonly agency?: string } = {}): Promise<Reply> {
  return call(pw.w, {
    url: paymentRoutes.capturePayment(order.orderId),
    token: options.token ?? pw.w.billing.token,
    key: options.key ?? freshKey("cmd029"),
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body: { providerApprovalRef: options.ref ?? order.providerOrderId },
  });
}

async function captureAttempts(orderId: string): Promise<ReadonlyArray<{ attempt_id: string; ordinal: number; state: string }>> {
  return (await pw.w.h.oracle.query("SELECT attempt_id, ordinal, state FROM kauro.payment_attempts WHERE order_id = $1 AND operation = 'CAPTURE' ORDER BY ordinal", [orderId])).rows;
}

const captureDispatches = () => pw.provider.calls.filter((c) => c.operation === "DISPATCH ORDERS_V2_CAPTURE");

test("OK: capture through the server adapter — the payment service's settle step records the authenticated completion, the CAPTURED order and one CommercialAuthorization, and the request handler completes its journal", async () => {
  const { w } = pw;
  const order = await approvedOrder("cmd029-ok");
  const key = freshKey("cmd029-ok");
  const reply = completed<CapturePaymentView>(await capture(order, { key }), 200);
  assert.equal(reply.replayed, false);
  const data = reply.data;
  assert.deepEqual([data.order.state, data.order.paymentStatus, data.order.nextActions], ["CAPTURED", "CONFIRMED", []]);
  assert.deepEqual(
    [data.capture?.status, data.capture?.amountCents, data.capture?.allocated],
    ["COMPLETED", order.totalCents.toString(), { serviceCents: order.serviceCents.toString(), taxCents: order.taxCents.toString(), excessCents: "0" }],
  );
  assert.deepEqual([data.commercialAuthorization?.state, data.commercialAuthorization?.quoteId, data.commercialAuthorization?.captureId, data.authorizationBlockers], ["ACTIVE", order.quoteId, data.capture?.captureId, []]);

  // captured: one COMPLETED fact with its allocation, written by the payment service; one ACTIVE authorization binding the subject
  const fact = await w.row<{ capture_id: string; status: string; amount_cents: string; attempt_id: string | null; first_observation_source: string }>("capture_facts", "order_id = $1", [order.orderId]);
  assert.deepEqual([fact?.status, fact?.amount_cents, fact?.first_observation_source], ["COMPLETED", order.totalCents.toString(), "DISPATCH_RESPONSE"]);
  const attempts = await captureAttempts(order.orderId);
  assert.deepEqual(attempts.map((a) => [a.ordinal, a.state]), [[1, "CONFIRMED"]]);
  assert.equal(fact?.attempt_id, attempts[0]!.attempt_id, "the capture names the attempt of its own order (D-BIND-B2)");
  assert.deepEqual(captureDispatches().filter((c) => c.identity === `kauro-${attempts[0]!.attempt_id}`).length, 1, "dispatched once under the attempt's identity");
  const authorization = await w.row<{ authorization_id: string; state: string; capture_id: string; approval_id: string; revision_hash: string; target_contract_hash: string; mode: string }>("commercial_authorizations", "quote_id = $1", [order.quoteId]);
  assert.deepEqual([authorization?.state, authorization?.capture_id], ["ACTIVE", fact?.capture_id]);
  assert.deepEqual((await pw.events("capture", fact!.capture_id)).map((e) => [e.type, e.actor]), [["capture.completed.v1", "SERVICE payment-service"]]);
  assert.deepEqual((await pw.events("commercial_authorization", authorization!.authorization_id)).map((e) => [e.type, e.actor]), [["commercial_authorization.issued.v1", "SERVICE payment-service"]]);
  assert.deepEqual((await pw.events("payment_order", order.orderId)).map((e) => [e.type, e.actor]).slice(-2), [["payment_order.capturing.v1", "USER"], ["payment_order.captured.v1", "SERVICE payment-service"]]);
  assert.deepEqual((await pw.events("payment_attempt", attempts[0]!.attempt_id)).map((e) => [e.type, e.actor]), [
    ["payment_attempt.prepared.v1", "USER"],
    ["payment_attempt.dispatching.v1", "USER"],
    ["payment_attempt.confirmed.v1", "SERVICE payment-service"],
  ]);
  for (const [kind, id] of [["capture", fact!.capture_id], ["commercial_authorization", authorization!.authorization_id], ["payment_attempt", attempts[0]!.attempt_id]] as const) {
    for (const e of await pw.events(kind, id)) {
      assert.ok(COMMERCE_COMMAND_EVENTS.CMD029.includes(e.type as never), `CMD029 lists ${e.type}`);
      assert.deepEqual(await w.outbox(e.eventId), subscribersOf(e.type), `${e.type} reaches its subscribers only`);
    }
  }
  // the request handler completed its own journal entry from the durable result (T4)
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 200, "payment_order", order.orderId]);
  // the read: CONFIRMED only from the reconciled capture
  const detail = readData<PaymentOrderDetailView>(await read(w, paymentRoutes.getPaymentOrder(order.orderId), w.viewer.token));
  assert.deepEqual([detail.order.paymentStatus, detail.captures.length, detail.commercialAuthorization?.state], ["CONFIRMED", 1, "ACTIVE"]);
});

test("DENY: a foreign tenant's order is NOT_FOUND, a wrong role is NOT_AUTHORIZED, and one missing prerequisite — a browser echo naming another order, an expired price, no deliverable capacity — is refused before any call; a forged webhook and an unknown capture result create no authorization", async () => {
  const { w } = pw;
  const order = await approvedOrder("cmd029-deny");
  const refusedBeforeAnyCall = async (what: string, request: () => Promise<Reply>, expected: string): Promise<Reply> => {
    const before = await pw.effects();
    const r = await request();
    assert.equal(outcome(w, r), expected, what);
    assert.deepEqual({ ...(await pw.effects()), security_events: 0 }, { ...before, security_events: 0 }, `${what}: no attempt, capture, authorization, event, journal entry or provider call`);
    return r;
  };
  await refusedBeforeAnyCall("foreign tenant", () => capture(order, { token: pw.w.stranger.token, agency: w.B.agencyId }), "404 NOT_FOUND -");
  await refusedBeforeAnyCall("wrong role", () => capture(order, { token: w.viewer.token }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  // a browser echo naming another order (S057): the echo is compared with the stored provider order, never evidence
  const echo = await refusedBeforeAnyCall("echo of another order", () => capture(order, { ref: "PPO-ANOTHER-ORDER" }), "400 INVALID_REQUEST PROVIDER_REFERENCE_MISMATCH");
  assert.deepEqual(asProblem(w, echo).errors, [{ field: "providerApprovalRef", code: "UNKNOWN_REFERENCE" }]);
  // an expired price before the capture starts (15 "If the quote expires before provider capture starts, checkout is blocked")
  pw.clock.offsetMs = 337 * HOUR_MS;
  try {
    await refusedBeforeAnyCall("expired price", () => capture(order), "409 PRECONDITION_FAILED QUOTE_EXPIRED");
  } finally {
    pw.clock.offsetMs = 0;
  }
  // no deliverable capacity for the purchased scope (D-CAP-B1)
  pw.capacity.set({ available: false, reason: "OUTSIDE_QUALIFIED_ENVELOPE" });
  try {
    await refusedBeforeAnyCall("no capacity", () => capture(order), "503 CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE");
  } finally {
    pw.capacity.set({ available: true });
  }
  assert.deepEqual(await captureAttempts(order.orderId), [], "no CAPTURE attempt was ever prepared");

  // a forged webhook never passes ingress: its signature over the exact bytes does not verify, so nothing is recorded (SIMULATED
  // verifier; the webhook route is CMD030's) — no inbox record, no capture fact, no authority
  const now = pw.clock.now();
  const forged = new TextEncoder().encode(
    JSON.stringify({
      id: "WH-FORGED-0001",
      event_version: "1.0",
      create_time: now,
      resource_type: "capture",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "PPC-FORGED-0001", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" }, payee: { merchant_id: pw.provider.merchantId }, supplementary_data: { related_ids: { order_id: order.providerOrderId } }, create_time: now, update_time: now },
    }),
  );
  const attacker = createWebhookVerifierFake({ clock: pw.clock, secret: "a key the provider never issued" });
  const inboxBefore = await w.count("inbox_records");
  const verdict = await pw.verifier.verify({ bytes: forged, headers: attacker.sign(forged), receivedAt: now });
  assert.deepEqual(verdict, { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" });
  assert.equal(await w.count("inbox_records"), inboxBefore);
  assert.deepEqual([await w.count("capture_facts", "order_id = $1", [order.orderId]), await w.count("commercial_authorizations", "quote_id = $1", [order.quoteId])], [0, 0]);

  // an unknown capture result: the dispatch timed out and nothing is known — 202, the order CAPTURE_UNCERTAIN, never authority
  pw.provider.program("ORDERS_V2_CAPTURE", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "NOT_APPLIED" });
  const key = freshKey("cmd029-unknown");
  const pending = accepted(await capture(order, { key }));
  assert.deepEqual([pending.operationId, pending.state, pending.statusPath], [order.orderId, "CAPTURE_UNCERTAIN", `/api/v1/payment-orders/${order.orderId}`]);
  assert.deepEqual((await captureAttempts(order.orderId)).map((a) => a.state), ["UNCERTAIN"]);
  assert.equal((await w.journal(key))?.state, "UNCERTAIN");
  assert.deepEqual([await w.count("capture_facts", "order_id = $1", [order.orderId]), await w.count("commercial_authorizations", "quote_id = $1", [order.quoteId])], [0, 0], "no capture fact and no authorization");
  const checking = readData<PaymentOrderDetailView>(await read(w, paymentRoutes.getPaymentOrder(order.orderId), w.billing.token));
  assert.deepEqual([checking.order.state, checking.order.paymentStatus, checking.commercialAuthorization], ["CAPTURE_UNCERTAIN", "CHECKING", undefined]);
  // and while it is uncertain a new capture is refused: the effect is reconciled, never repeated
  const again = await capture(order);
  assert.equal(outcome(w, again), "409 PAYMENT_UNCERTAIN CAPTURE_UNCERTAIN", again.text + JSON.stringify(w.internalErrors.map((e) => String(e.error))));
});

test("RACE: an identical retry replays, the same key with another providerApprovalRef is 409 IDEMPOTENCY_CONFLICT with no effect, a crash before the intent commits leaves nothing, and a crash between the intent commit and the claim, one between the claim and the settle (after the provider call, observed by request identity and never dispatched again) and one between the settle and the journal completion converge to one capture and one authorization; the capture response and its webhook together yield one fact; a second capture command is 409 PAYMENT_PENDING", async () => {
  const { w } = pw;
  const oneCaptureOneAuthority = async (order: ApprovedOrder, what: string): Promise<void> => {
    assert.equal(await w.count("capture_facts", "order_id = $1", [order.orderId]), 1, `${what}: one capture fact`);
    assert.equal(await w.count("commercial_authorizations", "quote_id = $1", [order.quoteId]), 1, `${what}: one authorization`);
    assert.equal((await w.row<{ state: string }>("payment_orders", "order_id = $1", [order.orderId]))?.state, "CAPTURED");
  };

  // the identical retry replays; the same key with another echo conflicts and does nothing
  {
    const order = await approvedOrder("cmd029-race-replay");
    const key = freshKey("cmd029-race");
    const first = await capture(order, { key });
    completed<CapturePaymentView>(first, 200);
    const dispatched = captureDispatches().length;
    const replay = await capture(order, { key });
    assert.equal(replay.text, replayTextOf(first));
    const before = await pw.effects();
    assert.equal(outcome(w, await capture(order, { key, ref: "PPO-SOMETHING-ELSE" })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
    assert.deepEqual(await pw.effects(), before, "no effect");
    assert.equal(captureDispatches().length, dispatched, "no capture was sent again");
    await oneCaptureOneAuthority(order, "replay");
  }

  // a crash before the intent commits leaves nothing; the same key is then a new execution
  {
    const order = await approvedOrder("cmd029-race-t1");
    const key = freshKey("cmd029-crash-t1");
    const before = await pw.effects();
    pw.holds.arm("CMD029", "INTENT_BEFORE_COMMIT", "CRASH");
    assert.equal(outcome(w, await capture(order, { key })), "500 INTERNAL_ERROR -");
    assert.deepEqual(await pw.effects(), before, "no attempt, journal entry, event or call");
    completed<CapturePaymentView>(await capture(order, { key }), 200);
    await oneCaptureOneAuthority(order, "before the intent commits");
  }

  // a crash between the intent commit and the claim: the same key claims and dispatches once
  {
    const order = await approvedOrder("cmd029-race-intent");
    const key = freshKey("cmd029-crash-intent");
    const dispatched = captureDispatches().length;
    pw.holds.arm("CMD029", "AFTER_INTENT", "CRASH");
    assert.equal(outcome(w, await capture(order, { key })), "500 INTERNAL_ERROR -");
    assert.deepEqual((await captureAttempts(order.orderId)).map((a) => a.state), ["PREPARED"]);
    assert.equal(captureDispatches().length, dispatched);
    completed<CapturePaymentView>(await capture(order, { key }), 200);
    assert.equal(captureDispatches().length - dispatched, 1);
    await oneCaptureOneAuthority(order, "between the intent commit and the claim");
  }

  // a crash between the claim and the settle, after the provider call: the provider captured, nothing is recorded yet; the same key
  // observes the provider order and records the one capture — the capture is never dispatched again
  {
    const order = await approvedOrder("cmd029-race-call");
    const key = freshKey("cmd029-crash-call");
    const dispatched = captureDispatches().length;
    const captured = pw.provider.effects.captures;
    pw.holds.arm("CMD029", "AFTER_CALL", "CRASH");
    assert.equal(outcome(w, await capture(order, { key })), "500 INTERNAL_ERROR -");
    assert.equal(pw.provider.effects.captures - captured, 1, "the provider captured");
    assert.equal(await w.count("capture_facts", "order_id = $1", [order.orderId]), 0, "nothing of the provider's answer is recorded before the settle step");
    assert.equal((await w.row<{ state: string }>("payment_orders", "order_id = $1", [order.orderId]))?.state, "CAPTURING");
    const resumed = completed<CapturePaymentView>(await capture(order, { key }), 200);
    assert.deepEqual([resumed.data.order.state, resumed.data.commercialAuthorization?.state], ["CAPTURED", "ACTIVE"]);
    assert.equal(captureDispatches().length - dispatched, 1, "never dispatched again");
    assert.ok(pw.provider.calls.some((c) => c.operation === "OBSERVE_ORDER" && c.identity === order.providerOrderId), "the resume observed the provider order");
    assert.equal(pw.provider.effects.captures - captured, 1);
    await oneCaptureOneAuthority(order, "between the claim and the settle");
  }

  // a crash between the settle and the journal completion: the facts are settled; the same key repeats only the completion
  {
    const order = await approvedOrder("cmd029-race-settle");
    const key = freshKey("cmd029-crash-settle");
    const dispatched = captureDispatches().length;
    pw.holds.arm("CMD029", "AFTER_SETTLE", "CRASH");
    assert.equal(outcome(w, await capture(order, { key })), "500 INTERNAL_ERROR -");
    await oneCaptureOneAuthority(order, "after the settle");
    assert.equal((await w.journal(key))?.state, "RESERVED");
    const second = await capture(order, { key });
    assert.equal(completed<CapturePaymentView>(second, 200).replayed, false, "the completion is this request's, not a replay");
    assert.equal(captureDispatches().length - dispatched, 1);
    assert.deepEqual([(await w.journal(key))?.state, (await w.journal(key))?.status], ["COMMITTED", 200]);
    assert.equal((await capture(order, { key })).text, replayTextOf(second), "and from then on the journaled answer replays");
    await oneCaptureOneAuthority(order, "between the settle and the journal completion");
  }

  // the capture's response and its webhook: the webhook, applied by the payment service through the same reconciler while the
  // command is between its call and its settle, records the capture and the authorization; the settle then finds the fact (a
  // duplicate observation) — one fact, one authorization, one completion event
  {
    const order = await approvedOrder("cmd029-race-webhook");
    const hold = pw.holds.arm("CMD029", "AFTER_CALL", "PAUSE");
    const request = capture(order);
    await hold.reached;
    const view = await pw.provider.observeOrder({ providerOrderId: order.providerOrderId });
    const providerCaptureId = view.captures[0]!.providerCaptureId;
    const delivered = await pw.applyWebhook("PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
    assert.equal(delivered.outcome, "APPLIED");
    assert.equal((await w.row<{ state: string }>("inbox_records", "inbox_id = $1", [delivered.inboxId]))?.state, "APPLIED");
    await oneCaptureOneAuthority(order, "webhook first");
    hold.release();
    const reply = completed<CapturePaymentView>(await request, 200);
    assert.deepEqual([reply.data.order.state, reply.data.capture?.status, reply.data.commercialAuthorization?.state], ["CAPTURED", "COMPLETED", "ACTIVE"]);
    await oneCaptureOneAuthority(order, "response second");
    const fact = await w.row<{ capture_id: string; first_observation_source: string }>("capture_facts", "order_id = $1", [order.orderId]);
    assert.equal(fact?.first_observation_source, "WEBHOOK");
    assert.equal(await w.count("domain_events", "aggregate_kind = 'capture' AND aggregate_id = $1 AND event_type = 'capture.completed.v1'", [fact!.capture_id]), 1);
    assert.equal(await w.count("provider_observations", "order_id = $1 AND subject_kind = 'CAPTURE' AND effect = 'DUPLICATE'", [order.orderId]), 1, "the settle's observation is the duplicate");
    assert.deepEqual((await captureAttempts(order.orderId)).map((a) => a.state), ["CONFIRMED"]);
  }

  // two capture commands under two keys: while the first holds its live attempt, the second is PAYMENT_PENDING and prepares nothing
  {
    const order = await approvedOrder("cmd029-race-two-keys");
    const hold = pw.holds.arm("CMD029", "AFTER_INTENT", "PAUSE");
    const first = capture(order, { key: freshKey("cmd029-first") });
    await hold.reached;
    assert.equal(outcome(w, await capture(order, { key: freshKey("cmd029-second") })), "409 PAYMENT_PENDING CAPTURE_IN_PROGRESS");
    assert.equal((await captureAttempts(order.orderId)).length, 1);
    hold.release();
    completed<CapturePaymentView>(await first, 200);
    await oneCaptureOneAuthority(order, "two keys");
  }
});

