// The cross-mandate scenarios of package B09 (the stage-2 integration, INT-2; docs/design/B09-case-map.md S057, S058, S059, S060,
// R2-081, R2-140; design §14 "Stage-2 integration record", D-INT2-B1..B4). One api — the one the composition root builds — serves
// the B06 routes, the request side (M4: CMD028, CMD029, CMD031, CMD032 and the four reads) and the payment service's routes (M3: the
// webhook CMD030, CMD033, CMD034) over one real PostgreSQL 17, and the request side's provider commands settle through the bound
// payment service (D-INT2-B3). The provider, its webhook verifier, the evidence store, the service authenticator and the platform
// ports of B07 (source availability) and B08 (deliverable capacity) are M2's labelled contract fakes (CONTRACT_FAKE, evidence class
// SIMULATED; D-FAKE-B1): what they answer is never a provider or platform fact, so each case stays PARTIAL with its live half named.
// Every sealed check reads durable rows through the superuser oracle — attempts, orders, captures, authorizations, refunds, cases,
// exceptions, inbox records, events and journal entries — never a browser state. Nothing sleeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ApproveRefundView, CapturePaymentView, CreatePaymentOrderView, ExecuteRefundView, PaymentOrderDetailView, QuoteView, ReconcilePaymentView, RequestRefundView, WebhookAck } from "@kauro/application";
import { COMMERCE_COMMAND_EVENTS } from "@kauro/application";
import type { Sha256Hex } from "@kauro/contracts";
import type { PlanId, ProjectId, RevisionId, UserId } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import { issueQuote, type IssuedQuote } from "@kauro/persistence/testing";
import { accepted, paymentRoutes, read, readData } from "./commerce-support.js";
import { approvedPlan, deliver, dispatch, execute, paymentWorld, postWebhook, reconcile, rows, storeQuery, type PaymentWorld } from "./payment-support.js";
import { approveThroughRoute, call, completed, freshKey, ids, outcome, sha, type Person, type PlanFixture, type Reply } from "./support.js";

let pw: PaymentWorld;
/** A corporate person with an ACTIVE KAURO_OWNER grant and a token of the world's api (the refund reviewer). */
let kora: Person;
before(async () => {
  pw = await paymentWorld({ requestSide: true });
  kora = await pw.w.person("kora-scenario-owner");
  await pw.w.h.grantKauroOwner(kora.userId as UserId);
});
after(async () => {
  await pw.stop();
});

// --- the request side through its routes ---------------------------------------------------------------------------------------

interface ReadyQuote extends IssuedQuote {
  readonly plan: PlanFixture;
  readonly revisionId: string;
}

/** The sealed revision a quote names (its source's retention is the source lifecycle's own record, B07; the B07 + B09 merge). */
async function revisionOf(revisionHash: Sha256Hex): Promise<string> {
  const revision = (await rows<{ revision_id: string }>(pw, "SELECT revision_id FROM kauro.dataset_revisions WHERE manifest_hash = $1 AND state = 'SEALED'", [revisionHash]))[0];
  if (revision === undefined) throw new Error("the quoted revision is not sealed");
  return revision.revision_id;
}

/** An ISSUED quote (CMD027 as B10 writes it) over a HUBSPOT plan approved through CMD025, its source available for the quote's promise. */
async function readyQuote(seed: string, plan?: PlanFixture): Promise<ReadyQuote> {
  const approved = plan ?? (await approvedPlan(pw, seed));
  const quote = await issueQuote(pw.w.h, { agency: pw.w.A, planId: approved.planId as PlanId, issuerRef: pw.issuerRef, profileId: pw.profileId });
  return { ...quote, plan: approved, revisionId: await revisionOf(quote.revisionHash) };
}

function createOrder(quote: Pick<IssuedQuote, "quoteId" | "termsHash">, key = freshKey("scenario-order")): Promise<Reply> {
  return call(pw.w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: pw.w.billing.token, key, body: { termsHash: quote.termsHash } });
}

/** CMD028 through its route: the order the payment service's settle step recorded CREATED with its provider order. */
async function orderOf(quote: ReadyQuote): Promise<{ readonly orderId: string; readonly providerOrderId: string }> {
  const created = completed<CreatePaymentOrderView>(await createOrder(quote), 201);
  assert.equal(created.data.order.state, "CREATED");
  return { orderId: created.data.order.orderId, providerOrderId: created.data.order.providerOrderId! };
}

function capture(orderId: string, providerApprovalRef: string, key = freshKey("scenario-capture")): Promise<Reply> {
  return call(pw.w, { url: paymentRoutes.capturePayment(orderId), token: pw.w.billing.token, key, body: { providerApprovalRef } });
}

function orderDetail(orderId: string): Promise<PaymentOrderDetailView> {
  return read(pw.w, paymentRoutes.getPaymentOrder(orderId), pw.w.billing.token).then((r) => readData<PaymentOrderDetailView>(r));
}

async function orderRow(orderId: string): Promise<{ state: string; allocated_cents: string } | undefined> {
  return (await rows<{ state: string; allocated_cents: string }>(pw, "SELECT state, allocated_cents::text FROM kauro.payment_orders WHERE order_id = $1", [orderId]))[0];
}

async function capturesOf(orderId: string) {
  return rows<{ capture_id: string; status: string; provider_capture_id: string; amount_cents: string; allocated_service_cents: string; excess_cents: string }>(
    pw,
    "SELECT capture_id, status, provider_capture_id, amount_cents::text, allocated_service_cents::text, excess_cents::text FROM kauro.capture_facts WHERE order_id = $1 ORDER BY first_observed_at, capture_id",
    [orderId],
  );
}

async function authorizationsOf(orderId: string) {
  return rows<{ authorization_id: string; state: string; capture_id: string; revocation_phase: string | null }>(pw, "SELECT authorization_id, state, capture_id, revocation_phase FROM kauro.commercial_authorizations WHERE order_id = $1 ORDER BY created_at", [orderId]);
}

async function inboxOf(eventId: string) {
  return rows<{ inbox_id: string; state: string }>(pw, "SELECT inbox_id, state FROM kauro.inbox_records WHERE provider = 'paypal' AND external_event_id = $1", [eventId]);
}

async function attemptsOf(orderId: string) {
  return rows<{ operation: string; ordinal: number; state: string }>(pw, "SELECT operation, ordinal, state FROM kauro.payment_attempts WHERE order_id = $1 ORDER BY operation, ordinal", [orderId]);
}

/** The capture calls the provider received for the order's CAPTURE attempts (each under its attempt's request identity). */
async function captureCallsOf(orderId: string): Promise<number> {
  const attempts = await rows<{ attempt_id: string }>(pw, "SELECT attempt_id FROM kauro.payment_attempts WHERE order_id = $1 AND operation = 'CAPTURE'", [orderId]);
  const identities = new Set(attempts.map((a) => `kauro-${a.attempt_id}`));
  return pw.paypal.calls.filter((c) => c.operation === "DISPATCH ORDERS_V2_CAPTURE" && c.identity !== null && identities.has(c.identity)).length;
}

// --- the seams between the stage-2 branches (D-INT2-B3, D-INT2-B4) --------------------------------------------------------------

test("INT-2 seam (D-INT2-B3): an api that binds the payment service settles the request side's provider commands through it — CreatePaymentOrder and CapturePayment through their routes answer 201 and 200, their settle step written by the payment service with its provider adapter, and the provider's own webhook of that capture is the same fact", async () => {
  const { w } = pw;
  const quote = await readyQuote("seam-b3");
  const order = await orderOf(quote);
  // the settle step of the creation: the payment service's verified identity, its provider adapter (the one its webhook trusts)
  const created = await rows<{ event_type: string; actor_kind: string; actor_id: string | null }>(pw, "SELECT event_type, actor_kind, actor_id FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [order.orderId]);
  assert.deepEqual(created.map((e) => [e.event_type, e.actor_kind, e.actor_id]), [
    ["payment_order.intent_created.v1", "USER", w.billing.userId],
    ["payment_order.creating.v1", "USER", w.billing.userId],
    ["payment_order.created.v1", "SERVICE", "payment-service"],
  ]);
  assert.equal(pw.paypal.orderByRequestId(`kauro-${(await rows<{ attempt_id: string }>(pw, "SELECT attempt_id FROM kauro.payment_attempts WHERE order_id = $1", [order.orderId]))[0]!.attempt_id}`)?.id, order.providerOrderId);
  pw.paypal.approve(order.providerOrderId);
  const captured = completed<CapturePaymentView>(await capture(order.orderId, order.providerOrderId), 200);
  assert.deepEqual([captured.data.order.state, captured.data.capture?.status, captured.data.commercialAuthorization?.state], ["CAPTURED", "COMPLETED", "ACTIVE"]);
  const [fact] = await capturesOf(order.orderId);
  // the provider's webhook of the same capture, through the payment service's route: the same fact, nothing to apply
  const d = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", fact!.provider_capture_id);
  assert.equal(completed<WebhookAck>(d.reply, 200).data.inboxState, "IGNORED");
  assert.equal((await capturesOf(order.orderId)).length, 1, "one capture fact");
  assert.equal((await authorizationsOf(order.orderId)).length, 1, "one authorization");
  assert.deepEqual(w.internalErrors, []);
});

test("INT-2 seam (D-INT2-B4): the payment service's replies and the agency's reads project one order the same way — ReconcilePayment and GetPaymentOrder answer the same order, captures and authorization, before and after the capture", async () => {
  const quote = await readyQuote("seam-b4");
  const order = await orderOf(quote);
  // a stored provider query of the order still awaiting the buyer's approval: nothing to apply, the order projected
  const pendingRef = await storeQuery(pw, order.providerOrderId);
  const pending = completed<ReconcilePaymentView>(await reconcile(pw, order.orderId, { observationRef: pendingRef }), 200);
  const pendingRead = await orderDetail(order.orderId);
  assert.equal(pending.data.order.state, "CREATED");
  assert.deepEqual(pending.data.order, pendingRead.order, "one projection of the order awaiting the buyer");
  // paid through the request side's capture route, then reconciled by the payment service
  pw.paypal.approve(order.providerOrderId);
  completed<CapturePaymentView>(await capture(order.orderId, order.providerOrderId), 200);
  const paidRef = await storeQuery(pw, order.providerOrderId);
  const paid = completed<ReconcilePaymentView>(await reconcile(pw, order.orderId, { observationRef: paidRef }), 200);
  const paidRead = await orderDetail(order.orderId);
  assert.deepEqual([paid.data.order.paymentStatus, paid.data.order.nextActions], ["CONFIRMED", []]);
  assert.deepEqual([paid.data.order, paid.data.captures, paid.data.commercialAuthorization], [paidRead.order, paidRead.captures, paidRead.commercialAuthorization], "one projection of the paid order");
});

test("INT-2 seam (D-INT2-B1): each served payment route's run publishes only the events COMMERCE_COMMAND_EVENTS lists for its command — CreatePaymentOrder, the webhook, RequestRefund, ApproveRefund, ExecuteRefund and ReconcilePayment in one purchase's life", async () => {
  const { w } = pw;
  const published = async (command: keyof typeof COMMERCE_COMMAND_EVENTS, reply: Reply): Promise<ReadonlyArray<string>> => {
    const correlationId = reply.headers["x-correlation-id"];
    const types = (await rows<{ event_type: string }>(pw, "SELECT event_type FROM kauro.domain_events WHERE correlation_id = $1 ORDER BY sequence", [correlationId])).map((e) => e.event_type);
    assert.ok(types.length > 0, `${command} published its run's events under the request's correlation id`);
    for (const type of types) assert.ok(COMMERCE_COMMAND_EVENTS[command].includes(type as never), `${command} lists ${type}`);
    return types;
  };
  const quote = await readyQuote("seam-b1");
  const createReply = await createOrder(quote);
  const created = completed<CreatePaymentOrderView>(createReply, 201).data.order;
  await published("CMD028", createReply);
  pw.paypal.approve(created.providerOrderId!);
  const captured = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", pw.paypal.captureAtProvider(created.providerOrderId!));
  assert.ok((await published("CMD030", captured.reply)).includes("commercial_authorization.issued.v1"));
  const requestReply = await call(w, { url: paymentRoutes.requestRefund(created.projectId), token: w.billing.token, key: freshKey("seam-b1-request"), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } });
  const refundId = completed<RequestRefundView>(requestReply, 201).data.refund.refundId;
  assert.deepEqual(await published("CMD031", requestReply), ["refund.requested.v1"]);
  const approveReply = await call(w, { url: paymentRoutes.approveRefund(refundId), token: kora.token, key: freshKey("seam-b1-approve"), agency: null, body: { expectedVersion: 1, serviceCents: "1000", taxCents: "0", authorizationRef: await w.stepUp(kora) } });
  completed<ApproveRefundView>(approveReply, 200);
  assert.deepEqual(await published("CMD032", approveReply), ["refund.approved.v1"]);
  const executeReply = await execute(pw, refundId, { expectedVersion: 2 });
  assert.equal(completed<ExecuteRefundView>(executeReply, 200).data.refund.state, "COMPLETED");
  assert.ok((await published("CMD033", executeReply)).includes("refund.completed.v1"));
  const reconcileReply = await reconcile(pw, created.orderId, { observationRef: await storeQuery(pw, created.providerOrderId!) });
  completed<ReconcilePaymentView>(reconcileReply, 200);
  const reconciled = (await rows<{ event_type: string }>(pw, "SELECT event_type FROM kauro.domain_events WHERE correlation_id = $1", [reconcileReply.headers["x-correlation-id"]])).map((e) => e.event_type);
  for (const type of reconciled) assert.ok(COMMERCE_COMMAND_EVENTS.CMD034.includes(type as never), `CMD034 lists ${type}`);
});

// --- S057 --------------------------------------------------------------------------------------------------------------------------

test("S057: a browser return naming the provider order without a server capture creates no capture and no authorization; the order reads PENDING, then CHECKING while the capture is uncertain", async () => {
  const { w } = pw;
  const quote = await readyQuote("s057");
  const order = await orderOf(quote);
  // the buyer approves at the provider's hosted page and the browser returns naming the provider order: the return only navigates
  // to the server's reconciled state (10 "A browser return endpoint only navigates to server-side reconciliation")
  pw.paypal.approve(order.providerOrderId);
  const returned = await orderDetail(order.orderId);
  assert.deepEqual([returned.order.state, returned.order.paymentStatus, returned.order.nextActions, returned.captures, returned.commercialAuthorization], ["CREATED", "PENDING", ["APPROVE_AT_PROVIDER", "CAPTURE"], [], undefined]);
  assert.deepEqual([(await capturesOf(order.orderId)).length, (await authorizationsOf(order.orderId)).length], [0, 0], "submitted, not captured: no capture fact, no authorization");
  // a browser echo naming another provider order is compared with the stored one, never evidence
  assert.equal(outcome(w, await capture(order.orderId, "PPO-A-BROWSER-ECHO")), "400 INVALID_REQUEST PROVIDER_REFERENCE_MISMATCH");

  // the server's capture whose answer was lost: the effect happened at the provider, nothing is known here — CHECKING, never authority
  pw.paypal.program("ORDERS_V2_CAPTURE", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "APPLIED" });
  const key = freshKey("s057-capture");
  const uncertain = accepted(await capture(order.orderId, order.providerOrderId, key));
  assert.deepEqual([uncertain.state, uncertain.statusPath], ["CAPTURE_UNCERTAIN", `/api/v1/payment-orders/${order.orderId}`]);
  assert.deepEqual((await attemptsOf(order.orderId)).map((a) => [a.operation, a.state]), [["CAPTURE", "UNCERTAIN"], ["CREATE_ORDER", "CONFIRMED"]]);
  const checking = await orderDetail(order.orderId);
  assert.deepEqual([checking.order.state, checking.order.paymentStatus, checking.order.nextActions, checking.captures, checking.commercialAuthorization], ["CAPTURE_UNCERTAIN", "CHECKING", ["REFRESH_STATUS", "CONTACT_SUPPORT"], [], undefined]);
  assert.deepEqual([(await capturesOf(order.orderId)).length, (await authorizationsOf(order.orderId)).length], [0, 0], "uncertain: no capture fact, no authorization");
  // paying again is refused while the effect is uncertain (15 "discourage paying again while uncertain")
  assert.equal(outcome(w, await capture(order.orderId, order.providerOrderId)), "409 PAYMENT_UNCERTAIN CAPTURE_UNCERTAIN");

  // the authenticated capture fact arrives through the payment service's stored provider query (CMD034): only now the authority
  const observationRef = await storeQuery(pw, order.providerOrderId);
  const reconciled = completed<ReconcilePaymentView>(await reconcile(pw, order.orderId, { observationRef }), 200);
  assert.deepEqual([reconciled.data.order.state, reconciled.data.commercialAuthorization?.state], ["CAPTURED", "ACTIVE"]);
  const confirmed = await orderDetail(order.orderId);
  assert.deepEqual([confirmed.order.paymentStatus, confirmed.captures.length, confirmed.commercialAuthorization?.state], ["CONFIRMED", 1, "ACTIVE"]);
  assert.equal(await captureCallsOf(order.orderId), 1, "the capture was sent once and never again");
});

// --- S058 --------------------------------------------------------------------------------------------------------------------------

test("S058: wrong amount, currency, payee, environment or signature — no authorization; each raises its exception or case and the order stays unpaid", async () => {
  const { w } = pw;
  // unpaid: nothing of the obligation is paid by a capture that pays it — no authorization, the obligation not allocated in full,
  // and the agency's read never says "Payment confirmed"
  const unpaid = async (orderId: string, what: string): Promise<void> => {
    const row = await orderRow(orderId);
    assert.ok(row !== undefined && BigInt(row.allocated_cents) < 97_125n, `${what}: the obligation is not paid`);
    assert.equal((await authorizationsOf(orderId)).length, 0, `${what}: no authorization`);
    const detail = await orderDetail(orderId);
    assert.notEqual(detail.order.paymentStatus, "CONFIRMED", `${what}: never CONFIRMED`);
    assert.equal(detail.commercialAuthorization, undefined, `${what}: the read shows no authorization`);
  };
  const approvedOrder = async (seed: string) => {
    const order = await orderOf(await readyQuote(seed));
    pw.paypal.approve(order.providerOrderId);
    return order;
  };

  // a wrong payee or currency is never a capture of the order: its specific exception, the record REJECTED, no capture fact
  for (const [seed, overrides, kind] of [
    ["s058-payee", { merchantId: "ANOTHERMERCHANT" }, "WRONG_PAYEE"],
    ["s058-currency", { currency: "EUR" }, "WRONG_CURRENCY"],
  ] as const) {
    const order = await approvedOrder(seed);
    const d = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", pw.paypal.captureAtProvider(order.providerOrderId, overrides));
    assert.equal(completed<WebhookAck>(d.reply, 200).data.inboxState, "REJECTED", kind);
    const [inbox] = await inboxOf(d.eventId);
    const exceptions = await rows<{ kind: string; order_id: string | null; source: string }>(pw, "SELECT kind, order_id, source FROM kauro.provider_event_exceptions WHERE inbox_id = $1", [inbox!.inbox_id]);
    assert.deepEqual(exceptions, [{ kind, order_id: order.orderId, source: "WEBHOOK" }], kind);
    assert.equal((await capturesOf(order.orderId)).length, 0, `${kind}: no capture fact of the order`);
    assert.notEqual((await orderRow(order.orderId))?.state, "CAPTURED", `${kind}: the order never reaches CAPTURED`);
    await unpaid(order.orderId, kind);
  }

  // a wrong amount is real money of the order, never its payment: the capture with its allocation and an AMOUNT_MISMATCH case
  {
    const order = await approvedOrder("s058-amount");
    const partial = pw.paypal.captureAtProvider(order.providerOrderId, { amountCents: 50_000n });
    completed<WebhookAck>((await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", partial)).reply, 200);
    const facts = await capturesOf(order.orderId);
    assert.deepEqual(facts.map((f) => [f.status, f.provider_capture_id, f.amount_cents, f.allocated_service_cents, f.excess_cents]), [["COMPLETED", partial, "50000", "50000", "0"]]);
    const cases = await rows<{ kind: string; capture_id: string | null }>(pw, "SELECT kind, capture_id FROM kauro.reconciliation_cases WHERE order_id = $1", [order.orderId]);
    assert.deepEqual(cases, [{ kind: "AMOUNT_MISMATCH", capture_id: facts[0]!.capture_id }]);
    // the provider's capture is the order's (CAPTURED, 50000 allocated), never its payment: the remedy returns the money
    assert.deepEqual(await orderRow(order.orderId), { state: "CAPTURED", allocated_cents: "50000" });
    const remedies = await rows<{ origin: string; state: string }>(pw, "SELECT origin, state FROM kauro.refunds WHERE order_id = $1", [order.orderId]);
    assert.deepEqual(remedies, [{ origin: "KAURO_REMEDY", state: "REQUESTED" }]);
    await unpaid(order.orderId, "AMOUNT_MISMATCH");
  }

  // a wrong environment and a wrong signature never pass the ingress: no inbox record, nothing stored, the anonymous denial
  {
    const order = await approvedOrder("s058-signature");
    const providerCaptureId = pw.paypal.captureAtProvider(order.providerOrderId);
    const inboxBefore = await w.count("inbox_records");
    for (const [what, options, answer] of [
      ["environment", { environment: "LIVE" }, "401 AUTHENTICATION_REQUIRED PROVIDER_ENVIRONMENT_MISMATCH"],
      ["signature", { tamper: true }, "401 AUTHENTICATION_REQUIRED PROVIDER_SIGNATURE_INVALID"],
    ] as const) {
      const d = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId, options);
      assert.equal(outcome(w, d.reply), answer, what);
      assert.equal(await w.count("inbox_records"), inboxBefore, `${what}: no inbox record`);
      const facts = await rows<{ outcome: string; actor_kind: string; agency_id: string | null }>(pw, "SELECT outcome, actor_kind, agency_id FROM kauro.security_events WHERE action = 'CMD030' AND correlation_id = $1", [d.reply.headers["x-correlation-id"]]);
      assert.deepEqual(facts, [{ outcome: "DENY", actor_kind: "ANONYMOUS", agency_id: null }], `${what}: the denial is recorded`);
    }
    assert.equal((await capturesOf(order.orderId)).length, 0, "no capture fact");
    await unpaid(order.orderId, "environment and signature");
  }
});

// --- S059 --------------------------------------------------------------------------------------------------------------------------

/**
 * B08's execution-control edges of an entitlement — consumed by a job, then its package delivered (ACTIVE → CONSUMED → DELIVERED,
 * the listed CommercialAuthorization edges) — which B08's own migration grants its execution-control role (design §15; integration
 * obligation "B08"). B08 is not on this branch: the migration owner writes the two versions and their events here, a LATER (B08)
 * precondition of the revocation after delivery and never evidence of B08's behaviour.
 */
async function deliveredByTheExecutionPackage(authorizationId: string, agencyId: string): Promise<void> {
  const { oracle } = pw.w.h;
  const event = (version: number, type: string) =>
    oracle.query(
      `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
       VALUES ($1, 'commercial_authorization', $2, $3, $4, $5, 'SERVICE', 'execution-control', $6, $7, '{}'::jsonb, $8, '1', now())`,
      [ids.next(), authorizationId, version, agencyId, type, ids.next(), ids.next(), sha("{}")],
    );
  await oracle.query("BEGIN");
  try {
    await oracle.query("UPDATE kauro.commercial_authorizations SET state = 'CONSUMED', version = 2, job_ref = $2, consumed_at = now(), updated_at = now() WHERE authorization_id = $1", [authorizationId, ids.next()]);
    await event(2, "commercial_authorization.consumed.v1");
    await oracle.query("UPDATE kauro.commercial_authorizations SET state = 'DELIVERED', version = 3, delivered_at = now(), updated_at = now() WHERE authorization_id = $1", [authorizationId]);
    await event(3, "commercial_authorization.delivered.v1");
    await oracle.query("COMMIT");
  } catch (e) {
    await oracle.query("ROLLBACK");
    throw e;
  }
}

test("S059: a reversal before the local capture observation is recorded, allocated and reversed; after delivery it revokes POST_DELIVERY; no second charge", async () => {
  // the provider completes the capture and reverses it before the platform ever observed it; its first word here is the reversal
  const early = await orderOf(await readyQuote("s059-early"));
  pw.paypal.approve(early.providerOrderId);
  const earlyCapture = pw.paypal.captureAtProvider(early.providerOrderId);
  pw.paypal.updateCapture(earlyCapture, { status: "REVERSED" });
  completed<WebhookAck>((await deliver(pw, "PAYMENT.CAPTURE.REVERSED", earlyCapture)).reply, 200);
  const [reversed, ...others] = await capturesOf(early.orderId);
  assert.equal(others.length, 0);
  assert.deepEqual([reversed?.status, reversed?.provider_capture_id, reversed?.amount_cents, reversed?.allocated_service_cents], ["REVERSED", earlyCapture, "97125", "97125"], "recorded and allocated, then reversed");
  const earlyEvents = await rows<{ event_type: string }>(pw, "SELECT event_type FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [reversed!.capture_id]);
  assert.deepEqual(earlyEvents.map((e) => e.event_type), ["capture.completed.v1", "capture.reversed.v1"]);
  assert.equal((await authorizationsOf(early.orderId)).filter((a) => a.state !== "REVOKED").length, 0, "no live authority from a reversed capture");
  // no second charge: the order keeps its one allocation, no capture attempt was ever made and the provider captured once
  assert.deepEqual(await orderRow(early.orderId), { state: "CAPTURED", allocated_cents: "97125" });
  assert.deepEqual((await attemptsOf(early.orderId)).map((a) => a.operation), ["CREATE_ORDER"]);
  assert.equal(await pw.w.count("payment_orders", "quote_id = (SELECT quote_id FROM kauro.payment_orders WHERE order_id = $1)", [early.orderId]), 1);

  // a purchase paid through the capture route, consumed and delivered by the execution package, then reversed by the provider
  const paid = await orderOf(await readyQuote("s059-delivered"));
  pw.paypal.approve(paid.providerOrderId);
  const captured = completed<CapturePaymentView>(await capture(paid.orderId, paid.providerOrderId), 200);
  const authorizationId = captured.data.commercialAuthorization!.authorizationId;
  await deliveredByTheExecutionPackage(authorizationId, pw.w.A.agencyId);
  const providerCaptureId = (await capturesOf(paid.orderId))[0]!.provider_capture_id;
  const captureCalls = await captureCallsOf(paid.orderId);
  pw.paypal.updateCapture(providerCaptureId, { status: "REVERSED" });
  completed<WebhookAck>((await deliver(pw, "PAYMENT.CAPTURE.REVERSED", providerCaptureId)).reply, 200);
  assert.deepEqual((await capturesOf(paid.orderId)).map((c) => c.status), ["REVERSED"]);
  assert.deepEqual((await authorizationsOf(paid.orderId)).map((a) => [a.authorization_id, a.state, a.revocation_phase]), [[authorizationId, "REVOKED", "POST_DELIVERY"]]);
  const revoked = await rows<{ event_type: string; actor_id: string }>(pw, "SELECT event_type, actor_id FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [authorizationId]);
  assert.deepEqual(revoked.map((e) => [e.event_type, e.actor_id]), [
    ["commercial_authorization.issued.v1", "payment-service"],
    ["commercial_authorization.consumed.v1", "execution-control"],
    ["commercial_authorization.delivered.v1", "execution-control"],
    ["commercial_authorization.revoked.v1", "payment-service"],
  ]);
  // no second charge: the order stays CAPTURED with its allocation, no new order, attempt or provider capture
  assert.deepEqual(await orderRow(paid.orderId), { state: "CAPTURED", allocated_cents: "97125" });
  assert.deepEqual((await attemptsOf(paid.orderId)).map((a) => [a.operation, a.ordinal]), [["CAPTURE", 1], ["CREATE_ORDER", 1]]);
  assert.deepEqual([captureCalls, await captureCallsOf(paid.orderId)], [1, 1], "the provider is never asked to charge again");
  assert.equal((await orderDetail(paid.orderId)).order.paymentStatus, "CONFIRMED", "the payment itself stays reconciled; the reversal is its own fact");
});

// --- S060 --------------------------------------------------------------------------------------------------------------------------

test("S060: a price-valid quote whose source expired blocks CreatePaymentOrder with SOURCE_EXPIRED; a new sealed revision of the same bytes still needs a new approval and a new quote", async () => {
  const { w } = pw;
  const quote = await readyQuote("s060");
  // the source expires within the quote's price lifetime: B07's retention sweeper expires its UNPAID record and moves the revision
  // SEALED → EXPIRED (retention_expires, the control plane on the server clock past the record's deadline; the B07 + B09 merge)
  await w.h.expireRevision(w.A, quote.projectId as ProjectId, quote.revisionId as RevisionId);
  assert.ok(Date.parse(quote.expiresAt) > Date.now(), "the price is still valid");
  const view = readData<QuoteView>(await read(w, paymentRoutes.getQuote(quote.quoteId), w.billing.token));
  assert.deepEqual([view.checkoutReady, view.checkoutBlockers.includes("SOURCE_EXPIRED" as never)], [false, true]);
  const effectsBefore = pw.paypal.calls.length;
  const refused = await createOrder(quote);
  assert.equal(outcome(w, refused), "422 SOURCE_EXPIRED -");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [quote.quoteId]), 0, "submitted: no order row");
  assert.equal((await w.row<{ state: string }>("quotes", "quote_id = $1", [quote.quoteId]))?.state, "ISSUED", "the quote stays ISSUED");
  assert.equal(pw.paypal.calls.length, effectsBefore, "no provider call");

  // the same bytes uploaded again are a new revision with its own identity: the old quote and its approval cannot bind it
  const again = await w.revision(w.A, quote.projectId, "SEALED", { recent: true });
  assert.notEqual(again.revisionId, quote.revisionId);
  assert.notEqual(again.revisionHash, quote.revisionHash);
  assert.equal(outcome(w, await createOrder(quote)), "422 SOURCE_EXPIRED -", "the old quote still names the expired source");
  // it needs a new approval of a plan over the new revision (CMD025 through its route) and a new quote before any checkout: the
  // recurrence package's CMD027 withdraws the unsellable quote and issues the new one (LATER B10; written here through the quote
  // adapter in the agency owner's unit of work, the edge CMD027 writes)
  await w.h.commerce.run(w.h.tenant(w.A.agencyId, w.A.ownerUserId), async (uow) => {
    const withdrawn = await uow.commerce.quotes.transition(quote.quoteId as never, 2, { state: "WITHDRAWN" }, toUtcInstant(Date.now()));
    assert.equal(withdrawn.kind, "APPLIED");
  });
  const plan = await w.plan(w.A, quote.projectId, { revisionHash: again.revisionHash, targetContractHash: quote.targetContractHash, seed: "s060-reupload", state: "VALIDATED" });
  const approval = await approveThroughRoute(w, plan);
  assert.notEqual(approval.data.approval.approvalId, quote.approvalId);
  const fresh = await readyQuote("s060-reupload", plan);
  assert.notEqual(fresh.quoteId, quote.quoteId);
  assert.equal(fresh.revisionHash, again.revisionHash);
  const order = completed<CreatePaymentOrderView>(await createOrder(fresh), 201);
  assert.equal(order.data.order.state, "CREATED");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [quote.quoteId]), 0, "still nothing of the old quote");
});

// --- R2-081 ------------------------------------------------------------------------------------------------------------------------

test("R2-081: one-cent refunds through CMD031–CMD033 publish serviceBasisAfterCents down to exactly zero; the 26th approval is refused REFUND_EXCEEDS_REMAINING", async () => {
  const { w } = pw;
  const order = await orderOf(await readyQuote("r2-081"));
  pw.paypal.approve(order.providerOrderId);
  const paid = completed<CapturePaymentView>(await capture(order.orderId, order.providerOrderId), 200);
  const captureId = paid.data.capture!.captureId;
  const projectId = paid.data.order.projectId;
  const service = BigInt(paid.data.capture!.allocated.serviceCents);
  assert.equal(service, 97_125n);

  const request = async (label: string): Promise<{ readonly refundId: string; readonly proposed: bigint }> => {
    const r = completed<RequestRefundView>(await call(w, { url: paymentRoutes.requestRefund(projectId), token: w.billing.token, key: freshKey(label), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }), 201);
    return { refundId: r.data.refund.refundId, proposed: BigInt(r.data.refund.serviceCents) };
  };
  const approve = async (refundId: string, serviceCents: bigint): Promise<Reply> =>
    call(w, { url: paymentRoutes.approveRefund(refundId), token: kora.token, key: freshKey("r2-081-approve"), agency: null, body: { expectedVersion: 1, serviceCents: serviceCents.toString(), taxCents: "0", authorizationRef: await w.stepUp(kora) } });
  const basisAfter = async (refundId: string): Promise<string> => {
    const e = (await rows<{ payload: Record<string, unknown> }>(pw, "SELECT payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'refund.completed.v1'", [refundId]))[0];
    return String(e?.payload["serviceBasisAfterCents"]);
  };

  // the service down to 25 cents: requested by the agency, approved by the corporate owner, executed by the payment service's refund
  // executor on the approval's delivery (PAYMENT_SERVICE reads the refund.approved.v1 CMD032 wrote; D-INT2 event seam)
  const first = await request("r2-081-first");
  assert.equal(first.proposed, service, "the proposal is the whole remaining service");
  const approved = completed<ApproveRefundView>(await approve(first.refundId, service - 25n), 200);
  assert.equal(approved.data.effects.serviceBasisAfterCents, "25");
  await dispatch(pw, "PAYMENT_SERVICE");
  assert.equal((await w.row<{ state: string }>("refunds", "refund_id = $1", [first.refundId]))?.state, "COMPLETED", "the executor ran CMD033 on the approval's delivery");
  assert.equal(await basisAfter(first.refundId), "25");

  // twenty-five one-cent refunds, each through the three routes: the basis each completion publishes goes 24, 23, ... 0
  const published: string[] = [];
  for (let i = 1; i <= 25; i++) {
    const r = await request(`r2-081-cent-${i}`);
    assert.equal(r.proposed, 26n - BigInt(i), `the ${i}th proposal is what remains`);
    if (i === 25) {
      // the extra cent: one more than remains is refused before anything is written
      const extra = await approve(r.refundId, 2n);
      assert.equal(outcome(w, extra), "409 PRECONDITION_FAILED REFUND_EXCEEDS_REMAINING");
      assert.equal((await w.row<{ state: string; version: string }>("refunds", "refund_id = $1", [r.refundId]))?.state, "REQUESTED");
    }
    completed<ApproveRefundView>(await approve(r.refundId, 1n), 200);
    const executed = completed<ExecuteRefundView>(await execute(pw, r.refundId, { expectedVersion: 2 }), 200);
    assert.equal(executed.data.refund.state, "COMPLETED");
    published.push(await basisAfter(r.refundId));
  }
  assert.deepEqual(published, Array.from({ length: 25 }, (_, k) => String(24 - k)), "serviceBasisAfterCents down to exactly zero");

  // the committed components equal the allocation, exactly: no residue, nothing beyond it
  const sums = (await rows<{ service: string; tax: string; n: string }>(pw, "SELECT sum(approved_service_cents)::text AS service, sum(approved_tax_cents)::text AS tax, count(*)::text AS n FROM kauro.refunds WHERE capture_id = $1 AND state = 'COMPLETED'", [captureId]))[0];
  assert.deepEqual(sums, { service: "97125", tax: "0", n: "26" });
  // the entitlement ended with the service that bought it (D-REF-B5), and a 26th request finds nothing to refund
  assert.deepEqual((await authorizationsOf(order.orderId)).map((a) => a.state), ["REVOKED"]);
  const after = await call(w, { url: paymentRoutes.requestRefund(projectId), token: w.billing.token, key: freshKey("r2-081-26th"), body: { reasonCode: "One more", evidenceRef: ids.next() } });
  assert.equal(outcome(w, after), "409 PRECONDITION_FAILED NOTHING_TO_REFUND");
  assert.equal(pw.paypal.effects.refunds >= 26, true);
});

// --- R2-140 ------------------------------------------------------------------------------------------------------------------------

test("R2-140: two captures of one order through the webhook — both recorded, the second as excess with an EXCESS_CAPTURE case and refund request, a repeated delivery adds nothing, one authorization", async () => {
  const order = await orderOf(await readyQuote("r2-140"));
  pw.paypal.approve(order.providerOrderId);
  const firstCapture = pw.paypal.captureAtProvider(order.providerOrderId);
  const first = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", firstCapture);
  assert.equal(completed<WebhookAck>(first.reply, 200).data.inboxState, "APPLIED");
  // the provider captures the same obligation a second time (a double submission at the provider) and reports it
  const secondCapture = pw.paypal.captureAtProvider(order.providerOrderId);
  const second = await deliver(pw, "PAYMENT.CAPTURE.COMPLETED", secondCapture);
  assert.equal(completed<WebhookAck>(second.reply, 200).data.inboxState, "APPLIED");

  const facts = await capturesOf(order.orderId);
  assert.deepEqual(
    facts.map((f) => [f.provider_capture_id, f.status, f.amount_cents, f.allocated_service_cents, f.excess_cents]),
    [
      [firstCapture, "COMPLETED", "97125", "97125", "0"],
      [secondCapture, "COMPLETED", "97125", "0", "97125"],
    ],
    "both real captures recorded; the obligation allocated once, the second entirely excess",
  );
  const excess = facts[1]!.capture_id;
  const cases = await rows<{ kind: string; capture_id: string | null }>(pw, "SELECT kind, capture_id FROM kauro.reconciliation_cases WHERE order_id = $1", [order.orderId]);
  assert.deepEqual(cases, [{ kind: "EXCESS_CAPTURE", capture_id: excess }]);
  const refunds = await rows<{ origin: string; state: string; proposed_excess_cents: string; capture_id: string }>(pw, "SELECT origin, state, proposed_excess_cents::text, capture_id FROM kauro.refunds WHERE order_id = $1", [order.orderId]);
  assert.deepEqual(refunds, [{ origin: "EXCESS_CAPTURE", state: "REQUESTED", proposed_excess_cents: "97125", capture_id: excess }]);
  const authorizations = await authorizationsOf(order.orderId);
  assert.deepEqual(authorizations.map((a) => [a.state, a.capture_id]), [["ACTIVE", facts[0]!.capture_id]], "one service entitlement, on the capture that pays");

  // a repeated delivery of the second event (the provider's retry: the same bytes, the same signature) is the same inbox record
  const replay = await postWebhook(pw, second.bytes, second.headers);
  assert.deepEqual([completed<WebhookAck>(replay, 200).data.duplicate, (await inboxOf(second.eventId)).length], [true, 1]);
  assert.equal((await capturesOf(order.orderId)).length, 2, "no third fact");
  assert.equal((await authorizationsOf(order.orderId)).length, 1, "one authorization");
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.reconciliation_cases WHERE order_id = $1", [order.orderId])).length, 1);
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.refunds WHERE order_id = $1", [order.orderId])).length, 1);
  const read = await orderDetail(order.orderId);
  assert.deepEqual([read.order.state, read.order.paymentStatus, read.captures.length, read.commercialAuthorization?.state], ["CAPTURED", "CONFIRMED", 2, "ACTIVE"]);
});
