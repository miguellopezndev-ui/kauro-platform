// CMD028 CreatePaymentOrder through its route (package B09, implementation mandate M4; docs/design/B09-case-map.md CMD028-OK,
// CMD028-DENY, CMD028-RACE; design §8 CMD028, §6.1): the real server and composition root, the pg units of work on PostgreSQL 17 —
// the request handlers' pool (kauro_app) for the intent, the claim and the journal completion, the payment service's pool
// (kauro_payment) for the settle step — and the labelled contract fakes of the provider (PayPal Orders v2), B08's capacity and B07's
// source availability (SIMULATED, never provider evidence; D-FAKE-B1). Crashes are injected at the named points of the provider-effect
// protocol; nothing sleeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CapturePaymentView, CreatePaymentOrderView, PaymentOrderDetailView } from "@kauro/application";
import { COMMERCE_COMMAND_EVENTS } from "@kauro/application";
import { sealedAvailability } from "@kauro/application/testing";
import { accepted, paymentRoutes, paymentsWorld, read, readData, subscribersOf, type PaymentsWorld, type ReadyQuote } from "./commerce-support.js";
import { asProblem, call, completed, freshKey, ids, outcome, rawEvent, replayTextOf, sha, type Reply } from "./support.js";
import { controlWriter, tenantWriter } from "./writers.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

const HOUR_MS = 3_600_000;

function createOrder(quote: ReadyQuote, options: { readonly key?: string; readonly token?: string; readonly termsHash?: string; readonly agency?: string } = {}): Promise<Reply> {
  const { w } = pw;
  return call(w, {
    url: paymentRoutes.createPaymentOrder(quote.quoteId),
    token: options.token ?? w.billing.token,
    key: options.key ?? freshKey("cmd028"),
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body: { termsHash: options.termsHash ?? quote.termsHash },
  });
}

async function orderOf(quoteId: string): Promise<{ order_id: string; state: string; version: string; provider_order_id: string | null } | null> {
  return pw.w.row("payment_orders", "quote_id = $1", [quoteId]);
}

async function attemptsOf(orderId: string): Promise<ReadonlyArray<{ attempt_id: string; operation: string; ordinal: number; state: string; request_hash: string; provider_request_id: string }>> {
  return (await pw.w.h.oracle.query("SELECT attempt_id, operation, ordinal, state, request_hash, provider_request_id FROM kauro.payment_attempts WHERE order_id = $1 ORDER BY ordinal", [orderId])).rows;
}

const dispatchesOf = (endpoint: string) => pw.provider.calls.filter((c) => c.operation === `DISPATCH ${endpoint}`);

/** Every event the command's units of work published is one its command lists (the matrix's source, D-REQ-B7), sent to its subscribers only. */
async function assertPublishedByCommand(command: "CMD028" | "CMD029", kinds: ReadonlyArray<readonly [string, string]>): Promise<void> {
  for (const [kind, id] of kinds) {
    for (const e of await pw.events(kind, id)) {
      assert.ok(COMMERCE_COMMAND_EVENTS[command].includes(e.type as never), `${command} lists ${e.type}`);
      assert.deepEqual(await pw.w.outbox(e.eventId), subscribersOf(e.type), `${e.type}: its outbox records reach its subscribers only`);
    }
  }
}

test("OK: an AGENCY_BILLING member creates one order for an issued quote — the intent commits before the provider call, the payment service settles the provider order, one provider order, 201 with the approval page", async () => {
  const { w } = pw;
  const quote = await pw.readyQuote("cmd028-ok");
  const key = freshKey("cmd028-ok");
  const callsBefore = pw.provider.calls.length;
  // T1 committed before any call: pause the request right after the intent and read what is durable
  const hold = pw.holds.arm("CMD028", "AFTER_INTENT", "PAUSE");
  const request = createOrder(quote, { key });
  await hold.reached;
  const intent = await orderOf(quote.quoteId);
  assert.ok(intent !== null);
  assert.equal(intent.state, "INTENT_CREATED");
  assert.equal(intent.provider_order_id, null, "nothing learned from the provider");
  assert.deepEqual((await attemptsOf(intent.order_id)).map((a) => [a.operation, a.ordinal, a.state]), [["CREATE_ORDER", 1, "PREPARED"]]);
  assert.equal((await w.journal(key))?.state, "RESERVED");
  assert.equal(pw.provider.calls.length, callsBefore, "no provider call before the intent committed");
  assert.equal((await w.row<{ state: string }>("quotes", "quote_id = $1", [quote.quoteId]))?.state, "ACCEPTED_FOR_CHECKOUT");
  hold.release();
  const reply = await request;

  const done = completed<CreatePaymentOrderView>(reply, 201);
  assert.equal(done.replayed, false);
  const order = await orderOf(quote.quoteId);
  assert.ok(order !== null && order.provider_order_id !== null);
  assert.deepEqual(
    [done.data.order.orderId, done.data.order.state, done.data.order.paymentStatus, done.data.order.nextActions, done.data.order.expectedAmountCents, done.data.order.providerOrderId],
    [order.order_id, "CREATED", "PENDING", ["APPROVE_AT_PROVIDER", "CAPTURE"], quote.totalCents.toString(), order.provider_order_id],
  );
  assert.equal(done.data.order.checkout?.providerOrderId, order.provider_order_id);
  assert.match(done.data.order.checkout?.approvalUrl ?? "", /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/, "the approval page on the adapter's allowlisted host");
  assert.deepEqual([done.data.quote.quoteId, done.data.quote.state, done.data.quote.checkoutReady, done.data.quote.permittedActions], [quote.quoteId, "ACCEPTED_FOR_CHECKOUT", true, []], "an open checkout: no second order is offered");
  assert.equal(done.version, Number(order.version));

  // one provider order, created under the attempt's request identity, after the intent committed
  const attempts = await attemptsOf(order.order_id);
  assert.deepEqual(attempts.map((a) => [a.operation, a.state]), [["CREATE_ORDER", "CONFIRMED"]]);
  const attempt = attempts[0]!;
  assert.deepEqual(dispatchesOf("ORDERS_V2_CREATE").filter((c) => c.at >= quote.issuedAt).map((c) => c.identity), [`kauro-${attempt.attempt_id}`]);
  assert.equal(attempt.provider_request_id, `kauro-${attempt.attempt_id}`);
  assert.equal(pw.provider.orderByRequestId(`kauro-${attempt.attempt_id}`)?.id, order.provider_order_id);

  // each version with its event and actor: the intent and the claim are the request handlers', what the provider answered the payment service's
  assert.deepEqual((await pw.events("payment_order", order.order_id)).map((e) => [e.type, e.actor]), [
    ["payment_order.intent_created.v1", "USER"],
    ["payment_order.creating.v1", "USER"],
    ["payment_order.created.v1", "SERVICE payment-service"],
  ]);
  assert.deepEqual((await pw.events("payment_attempt", attempt.attempt_id)).map((e) => [e.type, e.actor]), [
    ["payment_attempt.prepared.v1", "USER"],
    ["payment_attempt.dispatching.v1", "USER"],
    ["payment_attempt.confirmed.v1", "SERVICE payment-service"],
  ]);
  assert.deepEqual((await pw.events("quote", quote.quoteId)).map((e) => [e.type, e.actor]).slice(-1), [["quote.accepted_for_checkout.v1", "USER"]]);
  await assertPublishedByCommand("CMD028", [["payment_order", order.order_id], ["payment_attempt", attempt.attempt_id]]);
  // the stored operation and the provider identity it learned, each indexed in the agency (D-SCOPE-B1, D-SCOPE-B2)
  assert.equal(await w.count("commerce_scopes", "order_id = $1 AND scope_kind = 'PAYMENT_ORDER'", [order.order_id]), 1);
  assert.equal(await w.count("commerce_scopes", "order_id = $1 AND scope_kind = 'PROVIDER_ORDER'", [order.order_id]), 1);
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 201, "payment_order", order.order_id]);
  // the read says the same: pending, never paid
  const detail = readData<PaymentOrderDetailView>(await read(w, paymentRoutes.getPaymentOrder(order.order_id), w.viewer.token));
  assert.deepEqual([detail.order.state, detail.order.paymentStatus, detail.captures.length, detail.commercialAuthorization], ["CREATED", "PENDING", 0, undefined]);
});

test("DENY: a foreign tenant's quote is NOT_FOUND, a wrong role (VIEWER) is NOT_AUTHORIZED, and one missing prerequisite at a time — expired source, stale terms, expired price, no deliverable capacity (CAPACITY_UNAVAILABLE), unqualified route, unreviewed treatment — is refused before any intent or provider call", async () => {
  const { w } = pw;
  const quote = await pw.readyQuote("cmd028-deny");
  const refusedWithNothing = async (what: string, request: () => Promise<Reply>, expected: string): Promise<Reply> => {
    const before = await pw.effects();
    const r = await request();
    assert.equal(outcome(w, r), expected, what);
    const after = await pw.effects();
    // no order, attempt, observation, capture, scope row, event, outbox record or journal entry, and no provider call; only the
    // durable fact of an authorization denial
    assert.deepEqual({ ...after, security_events: 0 }, { ...before, security_events: 0 }, `${what}: no committed state and no provider call`);
    assert.equal(await orderOf(quote.quoteId), null, `${what}: no order`);
    return r;
  };

  // a foreign tenant: the owner of agency B, under B's selector, cannot see A's quote — alike to a quote that does not exist
  const foreign = await refusedWithNothing("foreign tenant", () => createOrder(quote, { token: w.stranger.token, agency: w.B.agencyId }), "404 NOT_FOUND -");
  const unknown = await createOrder({ ...quote, quoteId: ids.next() } as ReadyQuote, { token: w.stranger.token, agency: w.B.agencyId });
  assert.equal(outcome(w, unknown), "404 NOT_FOUND -");
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" }, "a foreign and a nonexistent quote answer alike");
  // a wrong role: a VIEWER does not hold AGENCY_BILLING (OWNER, BILLING); the denial is a durable fact of the agency's stream
  const deniedBefore = (await w.securityEvents("CMD028")).length;
  await refusedWithNothing("wrong role", () => createOrder(quote, { token: w.viewer.token }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  const denial = (await w.securityEvents("CMD028")).slice(deniedBefore);
  assert.deepEqual(denial.map((f) => [f.outcome, f.reason, f.agencyId, f.actorId]), [["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.viewer.userId]]);

  // expired source: B07's retention record says the sealed revision's effective deadline has passed (S060)
  const sealedAt = new Date(Date.parse(quote.issuedAt) - HOUR_MS).toISOString();
  pw.sources.set(quote.revisionHash, sealedAvailability(quote.revisionId, sealedAt, new Date(Date.now() - 60_000).toISOString()));
  await refusedWithNothing("expired source", () => createOrder(quote), "422 SOURCE_EXPIRED -");
  pw.sources.set(quote.revisionHash, sealedAvailability(quote.revisionId, sealedAt, quote.sourceAvailableUntil));

  // stale terms: the terms the agency accepted are not the quote's
  const stale = await createOrder(quote, { termsHash: sha("terms the agency never saw") });
  assert.equal(outcome(w, stale), "409 STALE_VERSION HASH_MISMATCH");
  assert.deepEqual(asProblem(w, stale).current, { version: 2, state: "ISSUED", mismatch: ["termsHash"] });

  // expired price: fourteen days after issuance the price is gone (the api's clock moved; no row is backdated)
  pw.clock.offsetMs = 337 * HOUR_MS;
  try {
    const expired = await createOrder(quote);
    assert.equal(outcome(w, expired), "409 PRECONDITION_FAILED QUOTE_EXPIRED");
    assert.deepEqual(asProblem(w, expired).current, { version: 2, state: "ISSUED" });
  } finally {
    pw.clock.offsetMs = 0;
  }

  // no deliverable capacity (D-CAP-B1): B08's admission refuses, or answers nothing — both retryable
  pw.capacity.set({ available: false, reason: "ADMISSION_QUEUE_FULL" });
  await refusedWithNothing("capacity refused", () => createOrder(quote), "503 CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE");
  pw.capacity.set({ noAnswer: true });
  const unanswered = await createOrder(quote);
  assert.equal(outcome(w, unanswered), "503 CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE");
  assert.equal(asProblem(w, unanswered).retryable, true);
  pw.capacity.set({ available: true });

  // unqualified route: the control plane suspends the merchant route (route_suspended), then qualifies its successor
  const control = await controlWriter(w);
  try {
    await control.query("UPDATE kauro.payment_routes SET state = 'SUSPENDED' WHERE route_id = $1", [pw.route.routeId]);
    await control.commit();
  } finally {
    await control.close();
  }
  await refusedWithNothing("unqualified route", () => createOrder(quote), "422 CAPABILITY_UNAVAILABLE PAYMENT_ROUTE_UNQUALIFIED");
  await w.h.qualifiedPaymentRoute({ provider: pw.provider.provider, environment: pw.provider.environment, payee: pw.provider.merchantId });

  // unreviewed treatment (R2-082): a corporate owner records a REVIEW_REQUIRED version; the sale path is blocked until re-reviewed
  await pw.recordProfileVersion("REVIEW_REQUIRED");
  await refusedWithNothing("unreviewed treatment", () => createOrder(quote), "409 PRECONDITION_FAILED FISCAL_TREATMENT_UNREVIEWED");
  await pw.recordProfileVersion("EXEMPT_EXPORT");

  // with every prerequisite restored the same quote checks out: the refusals left nothing behind that blocks it
  const ok = completed<CreatePaymentOrderView>(await createOrder(quote), 201);
  assert.equal(ok.data.order.state, "CREATED");
});

test("DENY (race): a source expiry committed between the intent and the capture leaves the order without authority — the capture is reconciled and no authorization is issued", async () => {
  const { w } = pw;
  const quote = await pw.readyQuote("cmd028-source-race");
  const created = completed<CreatePaymentOrderView>(await createOrder(quote), 201);
  const orderId = created.data.order.orderId;
  const providerOrderId = created.data.order.providerOrderId!;
  pw.provider.approve(providerOrderId);
  // the capture is claimed (T2 committed) and paused before its call; meanwhile the source lifecycle (B07) expires the revision
  const hold = pw.holds.arm("CMD029", "AFTER_CLAIM", "PAUSE");
  const capture = call(w, { url: paymentRoutes.capturePayment(orderId), token: w.billing.token, key: freshKey("cmd028-race-capture"), body: { providerApprovalRef: providerOrderId } });
  await hold.reached;
  const lifecycle = await tenantWriter(w, w.A);
  try {
    const moved = await lifecycle.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'EXPIRED', version = version + 1 WHERE revision_id = $1 AND state = 'SEALED' RETURNING version", [quote.revisionId]);
    const version = Number(moved.rows[0]?.version);
    await rawEvent(lifecycle.client, { aggregateKind: "dataset_revision", aggregateId: quote.revisionId, aggregateVersion: version, agencyId: w.A.agencyId, eventType: "dataset_revision.expired.v1", actorUserId: w.A.ownerUserId, payload: { revisionId: quote.revisionId, agencyId: w.A.agencyId, projectId: quote.projectId } });
    await lifecycle.commit();
  } finally {
    await lifecycle.close();
  }
  hold.release();
  const reply = completed<CapturePaymentView>(await capture, 200);
  // the real capture is recorded and allocated, the order CAPTURED — and no authority: the subject no longer binds (S060, KP004)
  assert.deepEqual([reply.data.order.state, reply.data.capture?.status, reply.data.commercialAuthorization, reply.data.authorizationBlockers], ["CAPTURED", "COMPLETED", undefined, ["SOURCE_EXPIRED"]]);
  assert.equal(await w.count("capture_facts", "order_id = $1 AND status = 'COMPLETED'", [orderId]), 1);
  assert.equal(await w.count("commercial_authorizations", "quote_id = $1", [quote.quoteId]), 0);
  // the capture stands without authority: the case the owner reviews and the remedy refund request (15 "Price and source expiry races")
  assert.equal(await w.count("reconciliation_cases", "order_id = $1 AND kind = 'CAPTURE_WITHOUT_VALID_SUBJECT'", [orderId]), 1);
  assert.equal(await w.count("refunds", "order_id = $1 AND origin = 'KAURO_REMEDY' AND state = 'REQUESTED'", [orderId]), 1);
});

test("DENY (ambiguous): a creation timeout answers 202 and the same key observes by request identity — one provider order, never a second create", async () => {
  const { w } = pw;
  const quote = await pw.readyQuote("cmd028-ambiguous");
  const key = freshKey("cmd028-ambiguous");
  // the provider created the order but the response was lost (a timeout after the effect)
  pw.provider.program("ORDERS_V2_CREATE", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "APPLIED" });
  const createsBefore = dispatchesOf("ORDERS_V2_CREATE").length;
  const first = accepted(await createOrder(quote, { key }));
  const order = await orderOf(quote.quoteId);
  assert.ok(order !== null);
  assert.deepEqual([first.operationId, first.state, first.statusPath, first.pollAfterSeconds], [order.order_id, "CREATING", `/api/v1/payment-orders/${order.order_id}`, 5]);
  assert.equal((await w.journal(key))?.state, "UNCERTAIN");
  assert.deepEqual((await attemptsOf(order.order_id)).map((a) => [a.ordinal, a.state]), [[1, "UNCERTAIN"]]);
  assert.equal(await w.count("reconciliation_cases", "order_id = $1 AND kind = 'UNCERTAIN_EFFECT'", [order.order_id]), 1, "the unresolved effect is visible");
  const checking = readData<PaymentOrderDetailView>(await read(w, paymentRoutes.getPaymentOrder(order.order_id), w.billing.token));
  assert.deepEqual([checking.order.paymentStatus, checking.order.nextActions], ["CHECKING", ["REFRESH_STATUS", "CONTACT_SUPPORT"]], "never 'pay again' while uncertain");

  // the same key resumes: a read of the provider by the attempt's request identity, never a second create
  const resumed = completed<CreatePaymentOrderView>(await createOrder(quote, { key }), 201);
  assert.equal(resumed.data.order.state, "CREATED");
  assert.equal(dispatchesOf("ORDERS_V2_CREATE").length - createsBefore, 1, "one create call");
  const attempt = (await attemptsOf(order.order_id))[0]!;
  assert.ok(pw.provider.calls.some((c) => c.operation === "OBSERVE_ORDER_BY_REQUEST" && c.identity === `kauro-${attempt.attempt_id}`));
  assert.equal(attempt.state, "CONFIRMED");
  assert.equal((await w.journal(key))?.state, "COMMITTED");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [quote.quoteId]), 1);
});

test("RACE: an identical retry replays the one order, the same key with another termsHash is 409 IDEMPOTENCY_CONFLICT with no effect, a crash before the intent commits leaves nothing, a crash between the intent commit and the claim resumes to one provider order, a crash between the claim and the settle (after the provider call) observes the order by its request identity and never creates a second one, and a second key is 409 PAYMENT_PENDING", async () => {
  const { w } = pw;
  // the identical retry replays the journaled answer, byte for byte but the replayed flag
  const quote = await pw.readyQuote("cmd028-race-replay");
  const key = freshKey("cmd028-race");
  const first = await createOrder(quote, { key });
  completed<CreatePaymentOrderView>(first, 201);
  const creates = dispatchesOf("ORDERS_V2_CREATE").length;
  const replay = await createOrder(quote, { key });
  assert.equal(replay.status, 201);
  assert.equal(replay.text, replayTextOf(first));
  // the same key with another termsHash: the request digest differs; nothing is executed again
  const before = await pw.effects();
  const conflict = await createOrder(quote, { key, termsHash: sha("other terms") });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await pw.effects(), before, "no effect");
  assert.equal(dispatchesOf("ORDERS_V2_CREATE").length, creates, "no provider call");
  // a second key for the same project while its checkout is open: the one-open-order index decides (retry once it settles)
  const second = await createOrder(quote, { key: freshKey("cmd028-race-second") });
  assert.equal(outcome(w, second), "409 PAYMENT_PENDING CREATION_IN_PROGRESS");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [quote.quoteId]), 1);

  // a crash before the intent commits leaves nothing, and the same key is a new execution
  {
    const q = await pw.readyQuote("cmd028-race-before-commit");
    const k = freshKey("cmd028-crash-t1");
    const effects = await pw.effects();
    pw.holds.arm("CMD028", "INTENT_BEFORE_COMMIT", "CRASH");
    const crashed = await createOrder(q, { key: k });
    assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
    assert.deepEqual(await pw.effects(), effects, "no order, attempt, journal entry, event or provider call");
    assert.equal(await w.journal(k), null);
    const retried = completed<CreatePaymentOrderView>(await createOrder(q, { key: k }), 201);
    assert.equal(retried.data.order.state, "CREATED");
    assert.equal(await w.count("payment_orders", "quote_id = $1", [q.quoteId]), 1);
  }

  // a crash between the intent commit and the claim: the intent is durable, nothing was sent; the same key claims and calls once
  {
    const q = await pw.readyQuote("cmd028-race-after-intent");
    const k = freshKey("cmd028-crash-intent");
    const creates0 = dispatchesOf("ORDERS_V2_CREATE").length;
    pw.holds.arm("CMD028", "AFTER_INTENT", "CRASH");
    assert.equal(outcome(w, await createOrder(q, { key: k })), "500 INTERNAL_ERROR -");
    const order = await orderOf(q.quoteId);
    assert.equal(order?.state, "INTENT_CREATED");
    assert.deepEqual((await attemptsOf(order!.order_id)).map((a) => a.state), ["PREPARED"]);
    assert.equal((await w.journal(k))?.state, "RESERVED");
    assert.equal(dispatchesOf("ORDERS_V2_CREATE").length, creates0, "no call before the claim");
    const resumed = completed<CreatePaymentOrderView>(await createOrder(q, { key: k }), 201);
    assert.equal(resumed.data.order.state, "CREATED");
    assert.equal(dispatchesOf("ORDERS_V2_CREATE").length - creates0, 1, "one provider order");
    assert.equal((await w.journal(k))?.state, "COMMITTED");
  }

  // a crash between the claim and the settle, after the provider call: the provider made the order; the same key observes it by the
  // attempt's request identity and records it — never a second create
  {
    const q = await pw.readyQuote("cmd028-race-after-call");
    const k = freshKey("cmd028-crash-call");
    const creates0 = dispatchesOf("ORDERS_V2_CREATE").length;
    const made0 = pw.provider.effects.ordersCreated;
    pw.holds.arm("CMD028", "AFTER_CALL", "CRASH");
    assert.equal(outcome(w, await createOrder(q, { key: k })), "500 INTERNAL_ERROR -");
    const order = await orderOf(q.quoteId);
    assert.deepEqual([order?.state, order?.provider_order_id], ["CREATING", null], "nothing of the provider's answer is recorded before the settle step");
    assert.equal(pw.provider.effects.ordersCreated - made0, 1);
    const resumed = completed<CreatePaymentOrderView>(await createOrder(q, { key: k }), 201);
    assert.equal(resumed.data.order.state, "CREATED");
    const attempt = (await attemptsOf(order!.order_id))[0]!;
    assert.deepEqual(pw.provider.calls.filter((c) => c.identity === `kauro-${attempt.attempt_id}`).map((c) => c.operation), ["DISPATCH ORDERS_V2_CREATE", "OBSERVE_ORDER_BY_REQUEST"]);
    assert.equal(dispatchesOf("ORDERS_V2_CREATE").length - creates0, 1, "never a second create");
    assert.equal(pw.provider.effects.ordersCreated - made0, 1, "one provider order");
    assert.equal(await w.count("provider_observations", "order_id = $1 AND attempt_id = $2", [order!.order_id, attempt.attempt_id]), 1, "the resume's observation by request identity");
    assert.deepEqual([(await w.journal(k))?.state, attempt.state], ["COMMITTED", "CONFIRMED"]);
  }
});
