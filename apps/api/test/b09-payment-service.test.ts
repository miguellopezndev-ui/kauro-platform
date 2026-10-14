// The payment service's side in the api beyond the three command routes' case rows (package B09, stage-2 mandate M3; design §6.1,
// §8.1, §10, D-API-B1, D-PROTO-B4, D-PAY-B6, D-AUTH-B3, D-QUOTE-B6, D-CORE-B2): the manual-10 admission of the payment routes
// (the state/command matrix's "invalid schema" row of CMD030, CMD033 and CMD034 cites the first test), the routes of an edition
// that binds no payment service, the PAYMENT_SERVICE consumer's refund executor and watchdog through the payment dispatcher, the
// cancel-before-dispatch sweep, the provider query a completion without its instant asks for, the price-expiry check of the
// column-scoped purchased-subject read, and the PurchaseRebinder. Everything runs through the api the composition root builds and
// a real PostgreSQL 17; the provider, its webhooks and the service identities are M2's labelled (B07's lineage is the platform's own)
// contract fakes (CONTRACT_FAKE, SIMULATED). A later instant is a payment service built over the same pools with a clock past a
// deadline (the database's own time bounds are unaffected: nothing here claims an attempt); nothing sleeps.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, before, test } from "node:test";
import type { CreateRevisionView, ReconcilePaymentView, WebhookAck } from "@kauro/application";
import { REQUEST_LIMITS } from "@kauro/application";
import type { CausationId, Clock, PaymentOrderId, PlanId, ProjectId, QuoteId, EligibilitySnapshotId, MembershipId } from "@kauro/domain";
import { DISPATCH_DEADLINE_SECONDS, DomainFailure, toUtcInstant } from "@kauro/domain";
import { CLAIM_NEVER_COMMITTED, CLAIM_WINDOW_SECONDS, createPaymentDispatcher, createPaymentService, createPurchaseRebinder, refundExecutionKey, type PaymentService } from "../src/index.js";
import { SimulatedCrash, approvedRefund, captureRun, checkout, deliver, dispatch, paid, paymentWorld, postWebhook, reconcile, rows, serviceToken, storeQuery, type PaymentWorld } from "./payment-support.js";
import { createRevision, projectPointer } from "./source-support.js";
import { approveThroughRoute, call, clock, completed, freshKey, ids, outcome, rawEvent, rootCause, sha, type Call, type Reply } from "./support.js";
import { supersedeProject } from "./b17-target-supersession-support.js";

let pw: PaymentWorld;
let port: number;
before(async () => {
  pw = await paymentWorld();
  const address = await pw.app.listen({ host: "127.0.0.1", port: 0 });
  port = Number(new URL(address).port);
});
after(async () => {
  await pw.stop();
});

// --- helpers ---------------------------------------------------------------------------------------------------------------------

/** The tables a refusal at the boundary must leave untouched: the journal, the security facts, the inbox and the payment facts. */
const WRITTEN = ["command_journal", "security_events", "inbox_records", "inbox_body_conflicts", "payment_attempts", "capture_facts", "refunds", "domain_events", "outbox_records"] as const;

async function written(): Promise<Record<(typeof WRITTEN)[number], number>> {
  const out = {} as Record<(typeof WRITTEN)[number], number>;
  for (const table of WRITTEN) out[table] = Number((await rows<{ n: string }>(pw, `SELECT count(*)::text AS n FROM kauro.${table}`))[0]!.n);
  return out;
}

/** A payment service over the same verified pools and adapters whose clock runs `ms` ahead: the same service at a later instant. */
function laterService(ms: number): PaymentService {
  const later: Clock = { now: () => toUtcInstant(clock.nowMs() + ms), nowMs: () => clock.nowMs() + ms };
  return createPaymentService({ assembly: pw.service.runtime.assembly, environment: "LOCAL", clock: later, ids, onBackgroundFailure: (correlationId, error) => pw.backgroundFailures.push({ correlationId, error }) });
}

/** One raw HTTP/1.1 exchange on a fresh socket (a repeated header is framing that inject cannot express). */
function exchange(request: Buffer): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const received: Buffer[] = [];
    socket.on("data", (d: Buffer) => received.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(received).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      resolve({ status: Number(text.slice(0, split).split("\r\n")[0]?.split(" ")[1] ?? "0"), body: split < 0 ? "" : text.slice(split + 4) });
    });
    socket.on("connect", () => socket.write(request));
  });
}

function rawRequest(path: string, headers: ReadonlyArray<string>, body: Uint8Array): Buffer {
  const head = [`POST ${path} HTTP/1.1`, "Host: kauro.test", "Connection: close", ...headers, `Content-Length: ${body.byteLength}`, "", ""].join("\r\n");
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}

async function journalOf(key: string) {
  return (await rows<{ state: string; actor_kind: string; actor_id: string; response_status: number | null }>(pw, "SELECT state, actor_kind, actor_id, response_status FROM kauro.command_journal WHERE idempotency_key = $1", [key]))[0];
}

async function orderState(orderId: string): Promise<string | undefined> {
  return (await rows<{ state: string }>(pw, "SELECT state FROM kauro.payment_orders WHERE order_id = $1", [orderId]))[0]?.state;
}

// --- admission --------------------------------------------------------------------------------------------------------------------

test("the payment service's routes admit their requests in manual-10 order: content type, size, syntax and duplicate keys, the closed request schema, the Idempotency-Key and the path id, then the verified service identity — the first failure wins and nothing is written; the webhook refuses a repeated envelope header, an unknown provider and a body beyond the provider's bound before any verification", async () => {
  const token = serviceToken(pw);
  const services = [
    { name: "CMD033", url: `/api/v1/refunds/${ids.next()}/execute`, badPath: "/api/v1/refunds/not-an-id/execute", valid: { expectedVersion: 2 }, missing: "expectedVersion" },
    { name: "CMD034", url: `/api/v1/payment-orders/${ids.next()}/reconcile`, badPath: "/api/v1/payment-orders/not-an-id/reconcile", valid: { observationRef: ids.next() }, missing: "observationRef" },
  ] as const;
  const refused = async (what: string, c: Call): Promise<Reply> => {
    const before = await written();
    const reply = await call(pw.api, { agency: null, token, ...c });
    assert.deepEqual(await written(), before, `${what}: nothing is written`);
    return reply;
  };
  const reason = async (what: string, c: Call): Promise<string> => outcome(pw.api, await refused(what, c));
  for (const s of services) {
    const valid = JSON.stringify(s.valid);
    // each check on its own
    assert.equal(await reason(`${s.name} text/plain`, { url: s.url, contentType: "text/plain", rawBody: valid }), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED", s.name);
    assert.equal(await reason(`${s.name} over 1 MiB`, { url: s.url, rawBody: JSON.stringify({ ...s.valid, pad: "x".repeat(REQUEST_LIMITS.jsonBytes) }) }), "400 INVALID_REQUEST BODY_TOO_LARGE", s.name);
    assert.equal(await reason(`${s.name} truncated JSON`, { url: s.url, rawBody: valid.slice(0, -1) }), "400 INVALID_REQUEST JSON_SYNTAX", s.name);
    assert.equal(await reason(`${s.name} duplicate key`, { url: s.url, rawBody: `{${valid.slice(1, -1)},${valid.slice(1, -1)}}` }), "400 INVALID_REQUEST JSON_DUPLICATE_KEY", s.name);
    const unknown = await refused(`${s.name} unknown member`, { url: s.url, body: { ...s.valid, approved: true } });
    assert.equal(outcome(pw.api, unknown), "400 INVALID_REQUEST SCHEMA_VIOLATION", s.name);
    assert.deepEqual(unknown.json<{ errors: unknown }>().errors, [{ field: "approved", code: "UNKNOWN_FIELD" }], s.name);
    const missing = await refused(`${s.name} missing member`, { url: s.url, body: {} });
    assert.deepEqual(missing.json<{ errors: unknown }>().errors, [{ field: s.missing, code: "REQUIRED" }], s.name);
    assert.equal(await reason(`${s.name} no idempotency key`, { url: s.url, body: s.valid, key: null }), "400 INVALID_REQUEST IDEMPOTENCY_KEY_MISSING", s.name);
    assert.equal(await reason(`${s.name} short idempotency key`, { url: s.url, body: s.valid, key: "too short" }), "400 INVALID_REQUEST IDEMPOTENCY_KEY_INVALID", s.name);
    assert.equal(await reason(`${s.name} path id`, { url: s.badPath, body: s.valid }), "400 INVALID_REQUEST PATH_ID_INVALID", s.name);
    // the first failure wins
    assert.equal(await reason(`${s.name} schema + no key + bad path + no token`, { url: s.badPath, body: { ...s.valid, approved: true }, key: null, token: null }), "400 INVALID_REQUEST SCHEMA_VIOLATION", s.name);
    assert.equal(await reason(`${s.name} no key + bad path + no token`, { url: s.badPath, body: s.valid, key: null, token: null }), "400 INVALID_REQUEST IDEMPOTENCY_KEY_MISSING", s.name);
    assert.equal(await reason(`${s.name} bad path + no token`, { url: s.badPath, body: s.valid, token: null }), "400 INVALID_REQUEST PATH_ID_INVALID", s.name);
    // structurally admitted, no agency selector asked (the scope is the stored operation's), then the service identity: none is
    // AUTHENTICATION_REQUIRED with exactly the anonymous refusal recorded
    const before = await written();
    const anonymous = await call(pw.api, { url: s.url, agency: null, token: null, body: s.valid });
    assert.equal(outcome(pw.api, anonymous), "401 AUTHENTICATION_REQUIRED -", s.name);
    assert.deepEqual(await written(), { ...before, security_events: before.security_events + 1 }, `${s.name}: only the anonymous refusal`);
  }

  // the webhook: its identity is the provider inbox and its authentication the signature — admission refuses before either
  const order = await checkout(pw, "admission-webhook");
  const body = pw.paypal.webhookBody("CHECKOUT.ORDER.APPROVED", order.providerOrderId);
  const signed = pw.verifier.sign(body.bytes);
  const verified = pw.verifier.calls.length;
  const beforeWebhook = await written();
  const signedLines = Object.entries(signed).map(([name, value]) => `${name}: ${value}`);
  for (const header of ["Content-Type: application/json", `X-Correlation-Id: ${ids.next()}`]) {
    const repeated = await exchange(rawRequest("/api/v1/payments/webhooks/paypal", ["Content-Type: application/json", ...signedLines, `X-Correlation-Id: ${ids.next()}`, header], body.bytes));
    const problem = JSON.parse(repeated.body) as { code: string; reason?: string };
    assert.deepEqual([repeated.status, problem.code, problem.reason], [400, "INVALID_REQUEST", "HEADER_REPEATED"], header);
  }
  assert.equal(outcome(pw.api, await postWebhook(pw, body.bytes, signed, "stripe")), "404 NOT_FOUND PROVIDER_UNKNOWN");
  // beyond the provider's own bound (the verifier's), and beyond the transport's: never verified, never stored
  const oversized = new TextEncoder().encode(JSON.stringify({ id: body.eventId, pad: "x".repeat(pw.verifier.maxBodyBytes) }));
  assert.equal(outcome(pw.api, await postWebhook(pw, oversized, pw.verifier.sign(oversized))), "400 INVALID_REQUEST PROVIDER_BODY_TOO_LARGE");
  const huge = new TextEncoder().encode(JSON.stringify({ id: body.eventId, pad: "x".repeat(REQUEST_LIMITS.jsonBytes) }));
  assert.equal(outcome(pw.api, await postWebhook(pw, huge, pw.verifier.sign(huge))), "400 INVALID_REQUEST PROVIDER_BODY_TOO_LARGE");
  assert.equal(pw.verifier.calls.length, verified, "no refused delivery reached the verifier");
  assert.deepEqual(await written(), beforeWebhook, "the webhook's refusals at admission store nothing");
  // the same delivery once, admitted, is verified and stored
  const admitted = completed<WebhookAck>(await postWebhook(pw, body.bytes, signed), 200);
  assert.equal(admitted.data.received, true);
  assert.equal(pw.verifier.calls.length, verified + 1);
});

test("an edition that binds no payment service serves the payment routes all the same: the webhook knows no provider (404 PROVIDER_UNKNOWN, nothing stored) and a service route finds no verified service identity (401 AUTHENTICATION_REQUIRED, the anonymous refusal recorded)", async () => {
  const { w } = pw;
  const order = await checkout(pw, "no-service-edition");
  const body = pw.paypal.webhookBody("CHECKOUT.ORDER.APPROVED", order.providerOrderId);
  const before = await written();
  const webhook = await call(w, { url: "/api/v1/payments/webhooks/paypal", token: null, key: null, agency: null, rawBody: Buffer.from(body.bytes).toString("utf8"), headers: { ...pw.verifier.sign(body.bytes) } });
  assert.equal(outcome(w, webhook), "404 NOT_FOUND PROVIDER_UNKNOWN");
  assert.deepEqual(await written(), before);
  // a token the bound service authenticator would verify means nothing to an edition that binds none
  const execute = await call(w, { url: `/api/v1/refunds/${ids.next()}/execute`, agency: null, token: serviceToken(pw), body: { expectedVersion: 2 } });
  assert.equal(outcome(w, execute), "401 AUTHENTICATION_REQUIRED -");
  assert.deepEqual(await written(), { ...before, security_events: before.security_events + 1 });
});

// --- PAYMENT_SERVICE: the refund executor ----------------------------------------------------------------------------------------

test("the refund executor (PAYMENT_SERVICE, refund.approved.v1): the approval's delivery executes the refund under the journal key of the refund and its approved version — one provider refund — and a redelivery resumes that one operation and never refunds twice", async () => {
  const purchase = await paid(pw, "executor");
  const refundId = await approvedRefund(pw, purchase, 2_000n);
  const approval = (await rows<{ event_id: string; agency_id: string; aggregate_version: string; payload: Record<string, unknown> }>(pw, "SELECT event_id, agency_id, aggregate_version::text, payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'refund.approved.v1'", [refundId]))[0]!;
  assert.deepEqual(await rows(pw, "SELECT consumer FROM kauro.outbox_records WHERE event_id = $1 AND consumer = 'PAYMENT_SERVICE'", [approval.event_id]), [{ consumer: "PAYMENT_SERVICE" }]);
  const refundsBefore = pw.paypal.effects.refunds;

  const pass = await dispatch(pw, "PAYMENT_SERVICE");
  assert.deepEqual(pass.deliveries.filter((d) => d.eventId === approval.event_id).map((d) => d.outcome), ["APPLIED"]);
  const key = refundExecutionKey(refundId, 2);
  assert.deepEqual(await journalOf(key), { state: "COMMITTED", actor_kind: "SERVICE", actor_id: "payment-service", response_status: 200 });
  const refund = (await rows<{ state: string; version: string }>(pw, "SELECT state, version::text FROM kauro.refunds WHERE refund_id = $1", [refundId]))[0];
  assert.deepEqual(refund, { state: "COMPLETED", version: "4" });
  const attempts = await rows<{ attempt_id: string; state: string; provider_request_id: string }>(pw, "SELECT attempt_id, state, provider_request_id FROM kauro.payment_attempts WHERE refund_id = $1", [refundId]);
  assert.deepEqual(attempts.map((a) => a.state), ["CONFIRMED"]);
  assert.equal(pw.paypal.effects.refunds, refundsBefore + 1);
  const outbox = await rows<{ state: string }>(pw, "SELECT state FROM kauro.outbox_records WHERE event_id = $1 AND consumer = 'PAYMENT_SERVICE'", [approval.event_id]);
  assert.deepEqual(outbox, [{ state: "DELIVERED" }]);

  // a redelivery of the same approval (an expired claim delivered twice): the same key, the one operation replayed
  const executor = pw.service.effects.find((e) => e.consumer === "PAYMENT_SERVICE")!;
  const again = await executor.handle({ eventId: approval.event_id as never, eventType: "refund.approved.v1", agencyId: approval.agency_id as never, aggregateId: refundId, aggregateVersion: Number(approval.aggregate_version), payload: approval.payload });
  assert.equal(again, "APPLIED");
  assert.equal(pw.paypal.effects.refunds, refundsBefore + 1, "never refunded twice");
  assert.equal(pw.paypal.calls.filter((c) => c.operation === "DISPATCH CAPTURES_V2_REFUND" && c.identity === attempts[0]!.provider_request_id).length, 1);
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.command_journal WHERE idempotency_key = $1", [key])).length, 1);
});

// --- D-PAY-B6: a completion without its instant ----------------------------------------------------------------------------------

test("D-PAY-B6: a reversal that arrives before its capture was ever seen carries no completion instant — nothing of the capture is applied from the webhook; the payment service stores a provider query of the order and applies it (COMPLETED at the provider's instant, then REVERSED); a query that lacks the instant too opens COMPLETION_TIME_UNKNOWN and applies nothing", async () => {
  const order = await checkout(pw, "reversal-first");
  pw.paypal.approve(order.providerOrderId);
  const providerCaptureId = pw.paypal.captureAtProvider(order.providerOrderId);
  const completedAt = (await pw.paypal.observeOrder({ providerOrderId: order.providerOrderId })).captures[0]!.providerCompletedAt;
  assert.ok(completedAt !== null);
  pw.paypal.updateCapture(providerCaptureId, { status: "REVERSED" });

  const d = await deliver(pw, "PAYMENT.CAPTURE.REVERSED", providerCaptureId);
  completed<WebhookAck>(d.reply, 200);
  const facts = await rows<{ capture_id: string; status: string; completed_at: string; first_observation_source: string }>(
    pw,
    "SELECT capture_id, status, to_char(provider_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS completed_at, first_observation_source FROM kauro.capture_facts WHERE order_id = $1",
    [order.orderId],
  );
  assert.deepEqual(facts.map((f) => [f.status, f.completed_at, f.first_observation_source]), [["REVERSED", completedAt, "PROVIDER_QUERY"]]);
  const events = await rows<{ event_type: string; actor_kind: string }>(pw, "SELECT event_type, actor_kind FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [facts[0]!.capture_id]);
  assert.deepEqual(events.map((e) => e.event_type), ["capture.completed.v1", "capture.reversed.v1"]);
  assert.ok(events.every((e) => e.actor_kind === "SERVICE"));
  // the capture's observations are the query's alone: the webhook's appended none
  const observed = await rows<{ source: string }>(pw, "SELECT DISTINCT source FROM kauro.provider_observations WHERE order_id = $1 AND subject_kind = 'CAPTURE'", [order.orderId]);
  assert.deepEqual(observed, [{ source: "PROVIDER_QUERY" }]);
  const queries = await rows<{ state: string; actor_kind: string; actor_id: string }>(pw, "SELECT state, actor_kind, actor_id FROM kauro.command_journal WHERE idempotency_key LIKE 'completion-query-%' AND operation = 'CMD034' AND resource_id = $1", [order.orderId]);
  assert.deepEqual(queries, [{ state: "COMMITTED", actor_kind: "SERVICE", actor_id: "payment-service" }]);

  // no instant anywhere: a tax point is never invented
  const blind = await checkout(pw, "reversal-no-instant");
  pw.paypal.approve(blind.providerOrderId);
  const blindCapture = pw.paypal.captureAtProvider(blind.providerOrderId);
  pw.paypal.updateCapture(blindCapture, { status: "REVERSED", completedAt: null });
  completed<WebhookAck>((await deliver(pw, "PAYMENT.CAPTURE.REVERSED", blindCapture)).reply, 200);
  assert.deepEqual(await rows(pw, "SELECT 1 FROM kauro.capture_facts WHERE order_id = $1", [blind.orderId]), []);
  const cases = await rows<{ kind: string; detail_code: string }>(pw, "SELECT kind, detail_code FROM kauro.reconciliation_cases WHERE order_id = $1", [blind.orderId]);
  assert.deepEqual(cases, [{ kind: "PROVIDER_INCONSISTENCY", detail_code: "COMPLETION_TIME_UNKNOWN" }]);
});

// --- D-AUTH-B3 through the column-scoped purchased-subject read (D-CORE-B2) ---------------------------------------------------

test("D-AUTH-B3: a capture completed after its quote's price expired is honored when the quoted subject still binds — the entitlement issued with honoredAfterPriceExpiry, read through the column-scoped purchased-subject adapter — and one whose quoted target was superseded meanwhile is real money without authority: no entitlement, a remedy refund requested", async () => {
  const lateBy = async (seed: string) => {
    const order = await checkout(pw, seed);
    const quote = (await rows<{ expires_at: Date }>(pw, "SELECT expires_at FROM kauro.quotes WHERE quote_id = $1", [order.quoteId]))[0]!;
    return { order, afterExpiry: toUtcInstant(quote.expires_at.getTime() + 3_600_000) };
  };
  const honored = await lateBy("honored-after-expiry");
  pw.paypal.approve(honored.order.providerOrderId);
  pw.paypal.captureAtProvider(honored.order.providerOrderId, { completedAt: honored.afterExpiry });
  const view = completed<ReconcilePaymentView>(await reconcile(pw, honored.order.orderId, { observationRef: await storeQuery(pw, honored.order.providerOrderId) }), 200);
  assert.deepEqual([view.data.order.state, view.data.commercialAuthorization?.state, view.data.commercialAuthorization?.honoredAfterPriceExpiry], ["CAPTURED", "ACTIVE", true]);
  assert.deepEqual(await rows(pw, "SELECT honored_after_price_expiry FROM kauro.commercial_authorizations WHERE order_id = $1", [honored.order.orderId]), [{ honored_after_price_expiry: true }]);

  const lapsed = await lateBy("lapsed-after-expiry");
  await supersedeProject(pw.w.h.oracle, pw.w.A.agencyId, lapsed.order.projectId, pw.w.A.ownerMembershipId);
  pw.paypal.approve(lapsed.order.providerOrderId);
  pw.paypal.captureAtProvider(lapsed.order.providerOrderId, { completedAt: lapsed.afterExpiry });
  const unbound = completed<ReconcilePaymentView>(await reconcile(pw, lapsed.order.orderId, { observationRef: await storeQuery(pw, lapsed.order.providerOrderId) }), 200);
  assert.equal(unbound.data.commercialAuthorization, undefined);
  assert.deepEqual(unbound.data.captures.map((c) => c.status), ["COMPLETED"]);
  assert.deepEqual(await rows(pw, "SELECT 1 FROM kauro.commercial_authorizations WHERE order_id = $1", [lapsed.order.orderId]), []);
  assert.deepEqual(await rows(pw, "SELECT origin, state FROM kauro.refunds WHERE order_id = $1", [lapsed.order.orderId]), [{ origin: "KAURO_REMEDY", state: "REQUESTED" }]);
});

// --- D-QUOTE-B6: the PurchaseRebinder -----------------------------------------------------------------------------------------

/**
 * The replacement subject B10's replacement flow prepares before it calls the re-binder: a revision of the purchase's project that
 * supersedes the paid one — B07's CMD012 CreateRevision through its route (the paid revision SUPERSEDED, a DRAFT successor naming
 * it, the project's pointer moved), then sealed through the source lifecycle (upload, inspection, selection, evaluation, seal and
 * its retention record; the B07 + B09 merge) — a VALIDATED plan over it and the same target approved through CMD025, and the
 * replacement quote (the paid purchase's commercial terms, replacesQuoteId) issued through M1's quote adapter.
 */
async function replacementOf(purchase: Awaited<ReturnType<typeof paid>>, seed: string) {
  const { w } = pw;
  const A = w.A;
  const projectId = purchase.projectId as ProjectId;
  const replaced = (await rows<{ revision_id: string }>(pw, "SELECT revision_id FROM kauro.dataset_revisions WHERE project_id = $1 AND manifest_hash = $2", [projectId, purchase.plan.revisionHash]))[0]!.revision_id;
  const pointer = await projectPointer(w, projectId);
  const created = completed<CreateRevisionView>(await createRevision(w, projectId, pointer.version, replaced), 201);
  const revisionId = created.data.revision.revisionId;
  const sealed = await w.revision(A, projectId, "SEALED", { recent: true });
  assert.equal(sealed.revisionId, revisionId, "the source lifecycle sealed CMD012's successor");
  const revisionHash = sealed.revisionHash;
  const plan = await w.plan(A, projectId, { revisionHash, targetContractHash: purchase.plan.targetContractHash, seed, state: "VALIDATED" });
  await approveThroughRoute(w, plan);
  const quoteId = await w.h.commerce.run(w.h.tenant(A.agencyId, A.ownerUserId), async (uow) => {
    const paidQuote = await uow.commerce.quotes.get(purchase.quoteId);
    const approved = await uow.plans.get(plan.planId);
    if (paidQuote === null || approved === null || approved.approvalId === undefined) throw new Error("the paid quote or the replacement plan's approval is not visible");
    const id = uow.ids.next() as QuoteId;
    const snapshotId = uow.ids.next() as EligibilitySnapshotId;
    const issuedAt = clock.now();
    const issuedMs = Date.parse(issuedAt);
    await uow.commerce.quotes.issue(
      {
        quoteId: id,
        agencyId: A.agencyId,
        projectId,
        planId: plan.planId as PlanId,
        approvalId: approved.approvalId,
        revisionHash,
        planHash: plan.bodyHash,
        targetContractHash: plan.targetContractHash,
        billableUnits: paidQuote.billableUnits,
        mode: paidQuote.mode,
        pricePolicyVersion: paidQuote.pricePolicyVersion,
        discountPolicyVersion: paidQuote.discountPolicyVersion,
        baseServiceCents: paidQuote.baseServiceCents,
        discountBps: paidQuote.discountBps,
        discountCents: paidQuote.discountCents,
        serviceCents: paidQuote.serviceCents,
        fiscalProfileId: paidQuote.fiscalProfileId,
        issuerRef: paidQuote.issuerRef,
        tax: paidQuote.tax,
        taxCents: paidQuote.taxCents,
        totalCents: paidQuote.totalCents,
        eligibilitySnapshotId: snapshotId,
        termsHash: paidQuote.termsHash,
        termsVersion: paidQuote.termsVersion,
        issuedAt,
        expiresAt: toUtcInstant(issuedMs + 336 * 3_600_000),
        sourceAvailableUntil: toUtcInstant(issuedMs + 168 * 3_600_000),
        replacesQuoteId: purchase.quoteId,
        createdByMembershipId: A.ownerMembershipId as MembershipId,
      },
      {
        snapshotId,
        agencyId: A.agencyId,
        quoteId: id,
        projectId,
        asOf: issuedAt,
        lookbackStartsAt: toUtcInstant(issuedMs - 8760 * 3_600_000),
        qualifyingProjectIds: [],
        qualifyingCount: 0,
        repeatDiscountBps: 0,
        foundingSlotRef: uow.ids.next(),
        foundingDiscountBps: paidQuote.discountBps,
        appliedDiscountBps: paidQuote.discountBps,
        policyVersion: paidQuote.discountPolicyVersion,
      },
    );
    return id;
  });
  return { quoteId, replacedRevisionId: replaced, revisionId, revisionHash, planId: plan.planId };
}

/**
 * The re-binder in a SERVICE unit of work of the payment service under kauro_payment, under `correlationId`, adopted — as its caller
 * does (D-M3-B6) — to the paid order's scope; `adopt: false` calls it in a unit of work that adopted nothing.
 */
function rebind(purchase: Awaited<ReturnType<typeof paid>>, toQuoteId: QuoteId, correlationId = pw.w.h.service().correlationId, options: { readonly adopt?: boolean } = {}) {
  return pw.pools.commerce.run({ kind: "SERVICE", serviceId: "payment-service", correlationId }, async (uow) => {
    if (options.adopt !== false && (await uow.adoptScope("PAYMENT_ORDER", purchase.orderId)) === null) throw new Error("the payment service cannot adopt the paid order's scope");
    return pw.service.rebinder.rebind(uow, { captureId: purchase.captureId, fromQuoteId: purchase.quoteId, toQuoteId, requestedByMembershipId: pw.w.A.ownerMembershipId as MembershipId, causationId: ids.next() as CausationId, now: clock.now() });
  });
}

test("D-QUOTE-B6: the PurchaseRebinder re-binds a paid capture to the included pre-execution source replacement in one SERVICE unit of work — the re-binding, the replaced entitlement REVOKED SOURCE_REPLACED (PRE_EXECUTION), the paid quote SUPERSEDED by the replacement, the replacement ACCEPTED_FOR_CHECKOUT and its entitlement on the same capture; a unit of work that adopted no stored operation is refused before anything is read, without the source lifecycle's lineage it is LINEAGE_MISSING, and once used the allowance is spent", async () => {
  const purchase = await paid(pw, "rebind");
  const replacement = await replacementOf(purchase, "rebind-r2");
  const before = await written();
  // the payment service sees nothing of an agency before it adopts one of its stored operations (D-SCOPE-B1, D-M3-B6)
  const unadopted = await rebind(purchase, replacement.quoteId, undefined, { adopt: false }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(unadopted instanceof DomainFailure && unadopted.code === "INTEGRITY_FAILURE", String(unadopted));
  // a re-binder without the source lifecycle's lineage reader (the port unbound) finds no lineage
  const unbound = createPurchaseRebinder({});
  const withoutLineage = await pw.pools.commerce.run({ kind: "SERVICE", serviceId: "payment-service", correlationId: pw.w.h.service().correlationId }, async (uow) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", purchase.orderId)) === null) throw new Error("the payment service cannot adopt the paid order's scope");
    return unbound.rebind(uow, { captureId: purchase.captureId, fromQuoteId: purchase.quoteId, toQuoteId: replacement.quoteId, requestedByMembershipId: pw.w.A.ownerMembershipId as MembershipId, causationId: ids.next() as CausationId, now: clock.now() });
  });
  assert.deepEqual(withoutLineage, { kind: "REFUSED", blockers: ["LINEAGE_MISSING"] });
  assert.deepEqual(await written(), before, "a refused re-binding writes nothing");

  // the payment service's re-binder reads B07's lineage (CMD012's supersedes_revision_id, the platform's reader since the merge)
  const correlationId = pw.w.h.service().correlationId;
  const rebound = await rebind(purchase, replacement.quoteId, correlationId);
  assert.equal(rebound.kind, "REBOUND");
  if (rebound.kind !== "REBOUND") return;
  const rebinding = await rows<{ capture_id: string; from_quote_id: string; to_quote_id: string; from_authorization_id: string; allowance_ordinal: number; reason_code: string }>(pw, "SELECT capture_id, from_quote_id, to_quote_id, from_authorization_id, allowance_ordinal, reason_code FROM kauro.purchase_rebindings WHERE rebinding_id = $1", [rebound.rebindingId]);
  assert.deepEqual(rebinding, [{ capture_id: purchase.captureId, from_quote_id: purchase.quoteId, to_quote_id: replacement.quoteId, from_authorization_id: purchase.authorizationId, allowance_ordinal: 1, reason_code: "PRE_EXECUTION_SOURCE_REPLACEMENT" }]);
  const authorizations = await rows<{ authorization_id: string; quote_id: string; state: string; revocation_phase: string | null; revocation_code: string | null; rebinding_id: string | null; capture_id: string }>(
    pw,
    "SELECT authorization_id, quote_id, state, revocation_phase, revocation_code, rebinding_id, capture_id FROM kauro.commercial_authorizations WHERE capture_id = $1 ORDER BY created_at",
    [purchase.captureId],
  );
  assert.deepEqual(authorizations.map((a) => [a.authorization_id, a.quote_id, a.state, a.revocation_phase, a.revocation_code, a.rebinding_id]), [
    [purchase.authorizationId, purchase.quoteId, "REVOKED", "PRE_EXECUTION", "SOURCE_REPLACED", null],
    [rebound.authorizationId, replacement.quoteId, "ACTIVE", null, null, rebound.rebindingId],
  ]);
  const quotes = await rows<{ quote_id: string; state: string; superseded_by_quote_id: string | null }>(pw, "SELECT quote_id, state, superseded_by_quote_id FROM kauro.quotes WHERE quote_id IN ($1, $2) ORDER BY created_at", [purchase.quoteId, replacement.quoteId]);
  assert.deepEqual(quotes, [
    { quote_id: purchase.quoteId, state: "SUPERSEDED", superseded_by_quote_id: replacement.quoteId },
    { quote_id: replacement.quoteId, state: "ACCEPTED_FOR_CHECKOUT", superseded_by_quote_id: null },
  ]);
  // each version with its event, by the payment service; nothing charged again
  const events = await rows<{ event_type: string; actor_kind: string }>(pw, "SELECT event_type, actor_kind FROM kauro.domain_events WHERE correlation_id = $1 ORDER BY sequence", [correlationId]);
  assert.deepEqual(events.map((e) => e.event_type), ["commercial_authorization.revoked.v1", "quote.superseded.v1", "quote.accepted_for_checkout.v1", "commercial_authorization.issued.v1"]);
  assert.ok(events.every((e) => e.actor_kind === "SERVICE"));
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.payment_orders WHERE quote_id = $1", [replacement.quoteId])).length, 0, "a replacement is never paid again");

  // the one included replacement is spent
  const again = await rebind(purchase, replacement.quoteId);
  assert.equal(again.kind, "REFUSED");
  assert.ok(again.kind === "REFUSED" && again.blockers.includes("ALLOWANCE_USED"), JSON.stringify(again));
});

// --- PAYMENT_SERVICE: the watchdog, and the sweep ---------------------------------------------------------------------------------

test("the PAYMENT_SERVICE watchdog (D-PROTO-B4): an attempt whose effect is unknown is not due before its dispatch deadline — its deliveries are rescheduled at the first millisecond past it, never before the database's own deadline — and once due the payment service stores a provider query and applies it through CMD034: the capture the provider made is recorded once, the attempt CONFIRMED", async () => {
  const order = await checkout(pw, "watchdog");
  pw.paypal.approve(order.providerOrderId);
  pw.paypal.program("ORDERS_V2_CAPTURE", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "APPLIED" });
  const capturesBefore = pw.paypal.effects.captures;
  const pending = await captureRun(pw, order.orderId as PaymentOrderId, freshKey("watchdog-capture"));
  assert.equal(pending.kind, "ACCEPTED");
  assert.equal(await orderState(order.orderId), "CAPTURE_UNCERTAIN");
  const attempt = (await rows<{ attempt_id: string; state: string }>(pw, "SELECT attempt_id, state FROM kauro.payment_attempts WHERE order_id = $1 AND operation = 'CAPTURE'", [order.orderId]))[0]!;
  assert.equal(attempt.state, "UNCERTAIN");
  const watched = await rows<{ event_id: string; event_type: string }>(pw, "SELECT e.event_id, e.event_type FROM kauro.domain_events e JOIN kauro.outbox_records o ON o.event_id = e.event_id AND o.consumer = 'PAYMENT_SERVICE' WHERE e.aggregate_id = $1 ORDER BY e.aggregate_version", [attempt.attempt_id]);
  assert.deepEqual(watched.map((e) => e.event_type), ["payment_attempt.dispatching.v1", "payment_attempt.uncertain.v1"]);
  const ids_ = new Set(watched.map((e) => e.event_id));
  const queried = () => pw.paypal.calls.filter((c) => c.operation === "OBSERVE_ORDER" && c.identity === order.providerOrderId).length;
  const queriesBefore = queried();

  // before the deadline: rescheduled just past it — the first millisecond after the deadline the attempt's record names (the
  // database keeps microseconds), so never before the database's own deadline — nothing queried or applied
  const early = await dispatch(pw, "PAYMENT_SERVICE");
  assert.deepEqual(early.deliveries.filter((d) => ids_.has(d.eventId)).map((d) => d.outcome), ["RESCHEDULED", "RESCHEDULED"]);
  const rescheduled = await rows<{ state: string; last_error_code: string; just_past: boolean; not_before: boolean }>(
    pw,
    `SELECT o.state, o.last_error_code, o.next_attempt_at = date_trunc('milliseconds', a.dispatch_deadline_at) + interval '1 millisecond' AS just_past,
            o.next_attempt_at > a.dispatch_deadline_at AS not_before
       FROM kauro.outbox_records o JOIN kauro.payment_attempts a ON a.attempt_id = $2 WHERE o.consumer = 'PAYMENT_SERVICE' AND o.event_id = ANY($1::uuid[]) ORDER BY o.next_attempt_at, o.outbox_id`,
    [[...ids_], attempt.attempt_id],
  );
  assert.deepEqual(rescheduled, [
    { state: "RETRYABLE", last_error_code: "NOT_DUE", just_past: true, not_before: true },
    { state: "RETRYABLE", last_error_code: "NOT_DUE", just_past: true, not_before: true },
  ]);
  assert.equal(queried(), queriesBefore);
  assert.equal(await orderState(order.orderId), "CAPTURE_UNCERTAIN");

  // past the deadline (the same dispatcher's lease, a clock past the deadline): the first delivery settles it, the second finds
  // the attempt settled
  const later = laterService(DISPATCH_DEADLINE_SECONDS * 1000 + 5_000);
  const due = await createPaymentDispatcher(later.runtime, later.effects, { ownerId: pw.service.dispatcher.ownerId }).runOnce("PAYMENT_SERVICE", { limit: 100 });
  assert.deepEqual(due.deliveries.filter((d) => ids_.has(d.eventId)).map((d) => d.outcome), ["APPLIED", "NOT_APPLICABLE"]);
  assert.equal(queried(), queriesBefore + 1);
  assert.equal(await orderState(order.orderId), "CAPTURED");
  assert.deepEqual(await rows(pw, "SELECT state FROM kauro.payment_attempts WHERE attempt_id = $1", [attempt.attempt_id]), [{ state: "CONFIRMED" }]);
  const facts = await rows<{ status: string; first_observation_source: string }>(pw, "SELECT status, first_observation_source FROM kauro.capture_facts WHERE order_id = $1", [order.orderId]);
  assert.deepEqual(facts, [{ status: "COMPLETED", first_observation_source: "PROVIDER_QUERY" }]);
  assert.deepEqual(await rows(pw, "SELECT state FROM kauro.commercial_authorizations WHERE order_id = $1", [order.orderId]), [{ state: "ACTIVE" }]);
  const watchdogEntries = await rows<{ state: string; actor_id: string }>(pw, "SELECT j.state, j.actor_id FROM kauro.command_journal j WHERE j.idempotency_key LIKE 'watchdog-%' AND j.operation = 'CMD034' AND j.agency_id = $1 AND j.resource_id = $2", [pw.w.A.agencyId, order.orderId]);
  assert.deepEqual(watchdogEntries, [{ state: "COMMITTED", actor_id: "payment-service" }]);
  assert.equal(pw.paypal.effects.captures, capturesBefore + 1, "one capture at the provider, recorded once");
});

test("cancel before dispatch (D-PROTO-B4): an intent whose claim never committed is left alone within the claim window and cancelled by the sweep after it — CANCELLED_BEFORE_DISPATCH, no provider call was possible — and a resume of the same key answers from the cancelled operation without calling the provider", async () => {
  const order = await checkout(pw, "sweep-unclaimed");
  pw.paypal.approve(order.providerOrderId);
  const key = freshKey("sweep-capture");
  const capturesBefore = pw.paypal.effects.captures;
  const crashed = await captureRun(pw, order.orderId as PaymentOrderId, key, async (point) => {
    if (point === "AFTER_INTENT") throw new SimulatedCrash("CAPTURE AFTER_INTENT");
  }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(crashed instanceof SimulatedCrash || rootCause(crashed) instanceof SimulatedCrash, String(crashed));
  const attempt = (await rows<{ attempt_id: string; state: string }>(pw, "SELECT attempt_id, state FROM kauro.payment_attempts WHERE order_id = $1 AND operation = 'CAPTURE'", [order.orderId]))[0]!;
  assert.equal(attempt.state, "PREPARED");

  // within the window the command that recorded the intent may still be claiming it
  const early = await pw.service.runSweepPass();
  assert.ok(!early.cancelled.includes(attempt.attempt_id as never));
  // after the window
  const pass = await laterService(CLAIM_WINDOW_SECONDS * 1000 + 5_000).runSweepPass();
  assert.ok(pass.cancelled.includes(attempt.attempt_id as never), JSON.stringify(pass));
  const cancelled = await rows<{ state: string; outcome_code: string }>(pw, "SELECT state, outcome_code FROM kauro.payment_attempts WHERE attempt_id = $1", [attempt.attempt_id]);
  assert.deepEqual(cancelled, [{ state: "CANCELLED_BEFORE_DISPATCH", outcome_code: CLAIM_NEVER_COMMITTED }]);
  const events = await rows<{ event_type: string; actor_kind: string }>(pw, "SELECT event_type, actor_kind FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [attempt.attempt_id]);
  assert.deepEqual(events.map((e) => [e.event_type, e.actor_kind]), [
    ["payment_attempt.prepared.v1", "USER"],
    ["payment_attempt.cancelled_before_dispatch.v1", "SERVICE"],
  ]);
  assert.equal(await orderState(order.orderId), "CREATED", "a capture's cancelled intent leaves its order as it was");

  // the resume of the same key: the operation is settled — no claim, no provider call
  const resumed = await captureRun(pw, order.orderId as PaymentOrderId, key);
  assert.equal(resumed.kind, "COMPLETED");
  assert.equal(pw.paypal.effects.captures, capturesBefore);
  assert.equal(pw.paypal.calls.filter((c) => c.operation.includes("CAPTURE") && c.operation.startsWith("DISPATCH")).filter((c) => c.identity === `kauro-${attempt.attempt_id}`).length, 0);
  // a second pass finds nothing more to cancel
  const quiet = await laterService(CLAIM_WINDOW_SECONDS * 1000 + 5_000).runSweepPass();
  assert.ok(!quiet.cancelled.includes(attempt.attempt_id as never));
});
