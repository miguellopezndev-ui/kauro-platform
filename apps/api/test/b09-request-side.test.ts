// The request side's boundary and reads (package B09, implementation mandate M4; design §10, D-API-B1, D-REQ-B7; 10 "Request
// envelope", "Version and validation", "Quote and payment routes", "Refund request, review, execute and reconcile"). The payment
// routes are admitted by the same manual-10 pipeline as B06's: a malformed request is refused at the boundary with its reason and no
// unit of work opens. The reads answer the closed views under the caller's own context: an agency reads its quote with checkout
// readiness and its permitted actions, its order and its refund; a foreign or nonexistent id answers NOT_FOUND alike; the owner's
// review is the corporate owner's alone. Real routes, the pg units of work, PostgreSQL 17, the labelled contract fakes (SIMULATED).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CreatePaymentOrderView, KnownSchemaId, PaymentOrderDetailView, QuoteView, RefundReviewView, RefundView, RequestRefundView } from "@kauro/application";
import { REQUEST_SCHEMA_PREFIX } from "@kauro/application";
import { paymentRoutes, paymentsWorld, read, readData, type PaymentsWorld } from "./commerce-support.js";
import { asProblem, call, completed, freshKey, ids, outcome, sha, type Call, type Reply } from "./support.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

/** The security fact a reply recorded, by its correlation id. */
async function factOf(reply: Reply): Promise<{ action: string; reason: string | null; agencyId: string | null; requestedAgencyId: string | null } | null> {
  const r = await pw.w.h.oracle.query<{ action: string; reason_code: string | null; agency_id: string | null; requested_agency_id: string | null }>(
    "SELECT action, reason_code, agency_id, requested_agency_id FROM kauro.security_events WHERE correlation_id = $1",
    [String(reply.headers["x-correlation-id"])],
  );
  const row = r.rows[0];
  return row ? { action: row.action, reason: row.reason_code, agencyId: row.agency_id, requestedAgencyId: row.requested_agency_id } : null;
}

/** Runs `refused` and asserts it opened no unit of work and changed nothing. */
async function atTheBoundary(what: string, c: Call): Promise<Reply> {
  const { w } = pw;
  const runs = w.stats.runs;
  const before = await pw.effects();
  const reply = await call(w, c);
  assert.equal(w.stats.runs, runs, `${what}: no unit of work opened`);
  assert.deepEqual(await pw.effects(), before, `${what}: nothing written`);
  return reply;
}

test("B09 admission: each served payment command refuses a malformed body at the boundary — an unknown member, a wrong type, a missing field, a label with a control character — 400 INVALID_REQUEST SCHEMA_VIOLATION with the validator's own verdict, and a missing idempotency key, a malformed path id and a missing agency selector with their reasons; no unit of work opens", async () => {
  const { w } = pw;
  const id = ids.next();
  const cases: ReadonlyArray<{ readonly command: string; readonly url: string; readonly agency: string | null; readonly token: string; readonly body: Record<string, unknown>; readonly field: string }> = [
    { command: "CMD028", url: paymentRoutes.createPaymentOrder(id), agency: w.A.agencyId, token: w.billing.token, body: { termsHash: sha("terms"), paid: true }, field: "paid" },
    { command: "CMD028", url: paymentRoutes.createPaymentOrder(id), agency: w.A.agencyId, token: w.billing.token, body: { termsHash: "not-a-hash" }, field: "termsHash" },
    { command: "CMD029", url: paymentRoutes.capturePayment(id), agency: w.A.agencyId, token: w.billing.token, body: { providerApprovalRef: 42 }, field: "providerApprovalRef" },
    { command: "CMD031", url: paymentRoutes.requestRefund(id), agency: w.A.agencyId, token: w.billing.token, body: { reasonCode: "Cancelled\u0007", evidenceRef: ids.next() }, field: "reasonCode" },
    { command: "CMD031", url: paymentRoutes.requestRefund(id), agency: w.A.agencyId, token: w.billing.token, body: { reasonCode: "Cancelled" }, field: "evidenceRef" },
    { command: "CMD032", url: paymentRoutes.approveRefund(id), agency: null, token: pw.kora.token, body: { expectedVersion: 1, serviceCents: 1000, taxCents: "0", authorizationRef: ids.next() }, field: "serviceCents" },
    { command: "CMD032", url: paymentRoutes.approveRefund(id), agency: null, token: pw.kora.token, body: { expectedVersion: "1", serviceCents: "1000", taxCents: "0", authorizationRef: ids.next() }, field: "expectedVersion" },
  ];
  for (const c of cases) {
    const what = `${c.command} ${JSON.stringify(c.body)}`;
    const reply = await atTheBoundary(what, { url: c.url, agency: c.agency, token: c.token, body: c.body });
    assert.equal(outcome(w, reply), "400 INVALID_REQUEST SCHEMA_VIOLATION", what);
    const verdict = w.validator.validate(`${REQUEST_SCHEMA_PREFIX}${c.command}` as KnownSchemaId, c.body);
    assert.equal(verdict.kind, "INVALID", what);
    assert.deepEqual(asProblem(w, reply).errors, verdict.kind === "INVALID" ? verdict.fields : null, what);
    assert.ok(asProblem(w, reply).errors?.some((e) => e.field === c.field), `${what} names ${c.field}`);
  }
  // the envelope checks of manual 10, in its order, on the payment routes as on B06's
  const valid = { termsHash: sha("terms") };
  assert.equal(outcome(w, await atTheBoundary("no idempotency key", { url: paymentRoutes.createPaymentOrder(id), token: w.billing.token, key: null, body: valid })), "400 INVALID_REQUEST IDEMPOTENCY_KEY_MISSING");
  assert.equal(outcome(w, await atTheBoundary("malformed path id", { url: paymentRoutes.createPaymentOrder("not-an-id"), token: w.billing.token, body: valid })), "400 INVALID_REQUEST PATH_ID_INVALID");
  assert.equal(outcome(w, await atTheBoundary("no agency selector", { url: paymentRoutes.createPaymentOrder(id), token: w.billing.token, agency: null, body: valid })), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  assert.equal(outcome(w, await atTheBoundary("the operator's malformed path id", { url: paymentRoutes.approveRefund("not-an-id"), token: pw.kora.token, agency: null, body: { expectedVersion: 1, serviceCents: "1", taxCents: "0", authorizationRef: ids.next() } })), "400 INVALID_REQUEST PATH_ID_INVALID");
  assert.equal(outcome(w, await atTheBoundary("the operator's missing key", { url: paymentRoutes.approveRefund(id), token: pw.kora.token, agency: null, key: null, body: { expectedVersion: 1, serviceCents: "1", taxCents: "0", authorizationRef: ids.next() } })), "400 INVALID_REQUEST IDEMPOTENCY_KEY_MISSING");
  // a read carries no body and no key; its path id is checked the same way
  assert.equal(outcome(w, await atTheBoundary("a read's malformed path id", { method: "GET", url: paymentRoutes.getQuote("not-an-id"), token: w.viewer.token, key: null, contentType: null })), "400 INVALID_REQUEST PATH_ID_INVALID");
});

test("B09 reads: an agency reads its quote with checkout readiness and the actions its role permits, its order and its refund; a foreign agency's resource answers NOT_FOUND like a nonexistent one and writes nothing, a non-member is refused with the denial recorded under the read's action; the owner's review is the corporate owner's alone — an agency OWNER without a grant is NOT_AUTHORIZED CORPORATE_ROLE_MISSING, recorded", async () => {
  const { w } = pw;
  const quote = await pw.readyQuote("b09-reads");
  const silently = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    const before = await pw.effects();
    const out = await run();
    assert.deepEqual(await pw.effects(), before, `${what}: a read writes nothing`);
    return out;
  };

  // the quote: its terms and both expiries, ready for checkout, and CMD028 permitted to AGENCY_BILLING only
  const asViewer = await silently("GetQuote", async () => readData<QuoteView>(await read(w, paymentRoutes.getQuote(quote.quoteId), w.viewer.token)));
  assert.deepEqual(
    [asViewer.quoteId, asViewer.projectId, asViewer.state, asViewer.termsHash, asViewer.totalCents, asViewer.checkoutReady, asViewer.checkoutBlockers, asViewer.permittedActions],
    [quote.quoteId, quote.projectId, "ISSUED", quote.termsHash, quote.totalCents.toString(), true, [], []],
  );
  assert.notEqual(asViewer.expiresAt, asViewer.sourceAvailableUntil, "price expiry and source availability are separate dates");
  const asBilling = readData<QuoteView>(await read(w, paymentRoutes.getQuote(quote.quoteId), w.billing.token));
  assert.deepEqual(asBilling.permittedActions, ["CMD028"]);
  // once its order is open the quote is accepted for checkout and offers no second checkout
  const created = completed<CreatePaymentOrderView>(await call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: w.billing.token, key: freshKey("b09-reads"), body: { termsHash: quote.termsHash } }), 201);
  const accepted = readData<QuoteView>(await read(w, paymentRoutes.getQuote(quote.quoteId), w.billing.token));
  assert.deepEqual([accepted.state, accepted.permittedActions], ["ACCEPTED_FOR_CHECKOUT", []]);
  // the order: the reconciled payment state, the approval to seek at the provider, no capture and no authorization yet
  const order = await silently("GetPaymentOrder", async () => readData<PaymentOrderDetailView>(await read(w, paymentRoutes.getPaymentOrder(created.data.order.orderId), w.viewer.token)));
  assert.deepEqual(order.order, created.data.order);

  // a foreign agency's quote, order and refund are NOT_FOUND like nonexistent ones: the caller's access to its own agency stands, the
  // resource is outside its scope (as B06's GetProject), and nothing is written; a caller who is no member of the selected agency is
  // refused before any resource is read, and that denial is a durable fact under the read's action token
  const paid = await pw.paidProject("b09-reads-refund");
  const refund = completed<RequestRefundView>(await call(w, { url: paymentRoutes.requestRefund(paid.projectId), token: w.billing.token, key: freshKey("b09-reads-refund"), body: { reasonCode: "Cancelled before execution", evidenceRef: ids.next() } }), 201).data.refund;
  for (const [what, action, foreign] of [
    ["GetQuote", "READ_QUOTE", paymentRoutes.getQuote(quote.quoteId)],
    ["GetPaymentOrder", "READ_PAYMENT_ORDER", paymentRoutes.getPaymentOrder(created.data.order.orderId)],
    ["GetRefund", "READ_REFUND", paymentRoutes.getRefund(refund.refundId)],
  ] as const) {
    const denied = await silently(what, () => read(w, foreign, w.stranger.token, w.B.agencyId));
    assert.equal(outcome(w, denied), "404 NOT_FOUND -", what);
    const nonexistent = await silently(what, () => read(w, foreign.replace(/[0-9a-f-]{36}$/, ids.next()), w.stranger.token, w.B.agencyId));
    assert.deepEqual({ ...asProblem(w, denied), correlationId: "" }, { ...asProblem(w, nonexistent), correlationId: "" }, `${what}: a foreign and a nonexistent id answer alike`);
    const outsider = await read(w, foreign, w.stranger.token, w.A.agencyId);
    assert.equal(outcome(w, outsider), "404 NOT_FOUND NOT_A_MEMBER", what);
    assert.deepEqual(await factOf(outsider), { action, reason: "NOT_A_MEMBER", agencyId: null, requestedAgencyId: w.A.agencyId }, what);
  }
  assert.deepEqual(readData<RefundView>(await read(w, paymentRoutes.getRefund(refund.refundId), w.viewer.token)), refund);

  // the owner's review: the corporate owner reads it through the refund's stored operation, with no agency selector
  const review = await silently("GetRefundReview", async () => readData<RefundReviewView>(await read(w, paymentRoutes.getRefundReview(refund.refundId), pw.kora.token, null)));
  assert.equal(review.refund.refundId, refund.refundId);
  assert.equal(review.refund.state, "REQUESTED");
  // the agency's own OWNER holds no corporate grant: the review is not the agency's to read (Private Owner has no bypass; 08)
  const ownerDenied = await read(w, paymentRoutes.getRefundReview(refund.refundId), w.owner.token, null);
  assert.equal(outcome(w, ownerDenied), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual(await factOf(ownerDenied), { action: "READ_REFUND_REVIEW", reason: "CORPORATE_ROLE_MISSING", agencyId: null, requestedAgencyId: null }, "the operator's own stream, naming no agency");
  // a refund no stored operation names is NOT_FOUND to the corporate owner too
  assert.equal(outcome(w, await read(w, paymentRoutes.getRefundReview(ids.next()), pw.kora.token, null)), "404 NOT_FOUND -");
});

test("D-REQ-B1: the composition root binds the payment collaborators a deployment supplies and names the ones it does not — with no capacity binding at all, checkout answers 503 CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE; with the capacity bound, as this edition deploys B08's own, and still no provider adapter or payment service, CreatePaymentOrder answers 422 INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE; the quote shows no merchant route, nothing is written and no provider is called", async () => {
  const deployments = [
    // B07's source availability is the edition's own since the B07 + B09 merge (the platform's reader): bound in both deployments
    { what: "a deployment that binds no capacity", unbound: ["payment", "provider"], withoutCapacity: true, blockers: ["DELIVERY_CAPACITY_UNAVAILABLE", "PAYMENT_ROUTE_UNQUALIFIED"], answer: "503 CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE" },
    // B08's capacity is the edition's own since its commands are served (D8-XPKG-4): the agency's live-job ledger answers, and it has room
    { what: "the edition as deployed", unbound: ["payment", "provider", "capacity"], withoutCapacity: false, blockers: ["PAYMENT_ROUTE_UNQUALIFIED"], answer: "422 INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE" },
    { what: "a capacity a deployment binds itself", unbound: ["payment", "provider"], withoutCapacity: false, blockers: ["PAYMENT_ROUTE_UNQUALIFIED"], answer: "422 INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE" },
  ] as const;
  for (const d of deployments) {
    const edition = await paymentsWorld({ unbound: d.unbound, withoutCapacity: d.withoutCapacity });
    try {
      const { w } = edition;
      const quote = await edition.readyQuote(`d-req-b1-${deployments.indexOf(d)}`);
      // the read names the missing merchant route (no adapter, so no provider or environment to qualify) and, unbound, the capacity
      const view = readData<QuoteView>(await read(w, paymentRoutes.getQuote(quote.quoteId), w.billing.token));
      assert.deepEqual([view.checkoutReady, view.checkoutBlockers], [false, d.blockers], d.what);
      const before = await edition.effects();
      const reply = await call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: w.billing.token, key: freshKey("d-req-b1"), body: { termsHash: quote.termsHash } });
      assert.equal(outcome(w, reply), d.answer, `${d.what}: ${reply.text}`);
      assert.deepEqual(await edition.effects(), before, `${d.what}: no quote acceptance, order, attempt, journal entry, event, fact or provider call`);
      assert.equal(await w.count("payment_orders", "quote_id = $1", [quote.quoteId]), 0, d.what);
      assert.equal(edition.provider.calls.length, 0, `${d.what}: the provider fake is not bound, and nothing reached it`);
      assert.deepEqual(w.internalErrors, [], d.what);
    } finally {
      await edition.stop();
    }
  }
});
