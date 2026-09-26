// The pure planners of the commerce core (implementation mandate M2; design §6.1, §6.3, §8.1): planObservation — the reconciler's
// decision over a facts snapshot and one authenticated observation —, planPostings (FINANCE), planFiscalDocument (FISCAL) and
// nextProtocolStep (the resume table). Pure units: no store, no database; every expectation is written from the design's rule it
// names (a decision of docs/design/B09-payments-fiscal.md §12), not from the implementation.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UtcInstant } from "@kauro/contracts";
import type {
  CaptureFactRecord,
  CaptureId,
  CommercialAuthorizationId,
  CommercialAuthorizationRecord,
  EventId,
  FiscalProfileRecord,
  InboxId,
  EvidenceArtifactRef,
  ObservedCapture,
  PaymentOrderRecord,
  ProviderObservationRecord,
  RefundId,
  RefundRecord,
  TaxDocumentId,
  TaxDocumentRecord,
} from "@kauro/domain";
import { COMMERCE_EVENT_PAYLOAD_ALLOWLIST, isBalanced, providerRequestHash, saleProfileAt } from "@kauro/domain";
import {
  nextProtocolStep,
  planFiscalDocument,
  planObservation,
  planPostings,
  type ObservationFacts,
  type ObservationPlan,
  type PlanStep,
  type PostingSource,
  type PurchasedSubject,
} from "../src/index.js";
import { R2_077, commerceWorld, sha, type CommerceWorld } from "./commerce-support.js";

const HOUR = 3_600_000;

function subjectOf(w: CommerceWorld, override: Partial<PurchasedSubject> = {}): PurchasedSubject {
  return {
    agencyState: "ACTIVE",
    plan: { state: "APPROVED", approvalId: w.quote.approvalId, bodyHash: w.quote.planHash },
    approval: { approvalHash: w.approvalHash },
    revision: { state: "SEALED" },
    target: { confirmed: true, superseded: false },
    capability: { capabilityId: w.capabilityId, capabilityVersion: "R2-INITIAL", state: "AVAILABLE_LIMITED" },
    ...override,
  };
}

/** The facts snapshot of an order as the reconciler reads it; `order` is taken as given (a test states the order's facts). */
function factsOf(w: CommerceWorld, order: PaymentOrderRecord, extra: Partial<ObservationFacts> = {}): ObservationFacts {
  const s = w.store();
  return {
    now: w.clock.now(),
    order,
    quote: s.quotes.get(order.quoteId)!,
    subject: subjectOf(w),
    currentProfile: w.profile,
    attempts: [...s.attempts.values()].filter((a) => a.orderId === order.orderId),
    captures: [...s.captures.values()].filter((c) => c.orderId === order.orderId),
    authorizations: [...s.authorizations.values()],
    refunds: [...s.refunds.values()].filter((r) => r.orderId === order.orderId),
    observations: s.observations.filter((o) => o.orderId === order.orderId),
    approvalHosts: w.provider.approvalHosts,
    maxAttempts: 3,
    ...extra,
  };
}

function observed(w: CommerceWorld, order: PaymentOrderRecord, overrides: Partial<ObservedCapture> = {}): ObservedCapture {
  return {
    provider: "paypal",
    environment: "SANDBOX",
    providerOrderId: order.providerOrderId ?? null,
    providerCaptureId: "PPC0000000000TEST1",
    status: "COMPLETED",
    amountCents: R2_077.total,
    currency: "USD",
    payeeDigest: w.route.payeeDigest,
    providerCompletedAt: w.clock.now(),
    fundsState: "UNKNOWN",
    feeCents: null,
    evidenceHash: sha("capture-evidence"),
    ...overrides,
  };
}

const ops = (plan: ObservationPlan): string[] => plan.steps.map((s) => s.op);
const types = (plan: ObservationPlan): string[] => plan.steps.flatMap((s) => ("event" in s ? [s.event.type] : []));
const find = <K extends PlanStep["op"]>(plan: ObservationPlan, op: K): Extract<PlanStep, { op: K }>[] => plan.steps.filter((s): s is Extract<PlanStep, { op: K }> => s.op === op);
const mint = (w: CommerceWorld) => () => w.ids.next();

function capturedRecord(w: CommerceWorld, order: PaymentOrderRecord, overrides: Partial<CaptureFactRecord> = {}): CaptureFactRecord {
  return {
    captureId: w.ids.next() as CaptureId,
    agencyId: w.agencyId,
    orderId: order.orderId,
    version: 1,
    status: "COMPLETED",
    provider: "paypal",
    environment: "SANDBOX",
    providerCaptureId: "PPC0000000000TEST1",
    merchantRef: order.merchantRef,
    payeeDigest: order.payeeDigest,
    amountCents: R2_077.total,
    currency: "USD",
    allocation: { serviceCents: R2_077.service, taxCents: R2_077.tax, excessCents: 0n },
    fundsState: "UNKNOWN",
    providerCompletedAt: w.clock.now(),
    firstObservationSource: "WEBHOOK",
    firstObservedAt: w.clock.now(),
    observedAt: w.clock.now(),
    evidenceHash: sha("capture-evidence"),
    ...overrides,
  };
}

function authorizationOf(w: CommerceWorld, order: PaymentOrderRecord, capture: CaptureFactRecord, state: CommercialAuthorizationRecord["state"]): CommercialAuthorizationRecord {
  const q = w.quote;
  return {
    authorizationId: w.ids.next() as CommercialAuthorizationId,
    agencyId: w.agencyId,
    projectId: q.projectId,
    quoteId: q.quoteId,
    orderId: order.orderId,
    orderQuoteId: q.quoteId,
    captureId: capture.captureId,
    approvalId: q.approvalId,
    approvalHash: w.approvalHash,
    planId: q.planId,
    planHash: q.planHash,
    revisionHash: q.revisionHash,
    targetContractHash: q.targetContractHash,
    capabilityId: w.capabilityId,
    capabilityVersion: "R2-INITIAL",
    mode: "CLEAN",
    billableUnits: 1000,
    version: state === "ACTIVE" ? 1 : 3,
    state,
    honoredAfterPriceExpiry: false,
    ...(state !== "ACTIVE" ? { jobRef: w.ids.next() as never, consumedAt: w.clock.now() } : {}),
    ...(state === "DELIVERED" ? { deliveredAt: w.clock.now() } : {}),
    createdAt: w.clock.now(),
  };
}

test("planObservation — a captured obligation from the capture attempt's dispatch response: the fact, its allocation, the order CAPTURED, the attempt CONFIRMED and one CommercialAuthorization, in the lock order of §6.2 with the event commerceVersionEventType names", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURING");
  const attempt = w.seedAttempt(order, "CAPTURE", "DISPATCHING");
  const plan = planObservation(factsOf(w, order), { origin: { source: "DISPATCH_RESPONSE", attemptId: attempt.attemptId }, content: { kind: "DISPATCH_RESULT", result: { kind: "CAPTURE_OBSERVED", capture: observed(w, order) } }, mint: mint(w) });
  assert.deepEqual(ops(plan), ["ORDER_TRANSITION", "ATTEMPT_TRANSITION", "CAPTURE_INSERT", "AUTHORIZATION_ISSUE", "SCOPE", "OBSERVATION"]);
  assert.deepEqual(types(plan), ["payment_order.captured.v1", "payment_attempt.confirmed.v1", "capture.completed.v1", "commercial_authorization.issued.v1"]);
  const insert = find(plan, "CAPTURE_INSERT")[0]!;
  assert.deepEqual(insert.fact.allocation, { serviceCents: R2_077.service, taxCents: R2_077.tax, excessCents: 0n });
  assert.equal(insert.fact.fundsState, "UNKNOWN", "a capture is born with its funds UNKNOWN (D-EVT-B3)");
  assert.equal(insert.fact.attemptId, attempt.attemptId);
  assert.equal(insert.event.payload["allocatedServiceCents"], 97125);
  const issue = find(plan, "AUTHORIZATION_ISSUE")[0]!;
  assert.equal(issue.authorization.captureId, insert.fact.captureId);
  assert.equal(issue.authorization.honoredAfterPriceExpiry, false);
  assert.equal(plan.authorizationIssued, issue.authorization.authorizationId);
  assert.equal(find(plan, "ORDER_TRANSITION")[0]!.change.state, "CAPTURED");
  assert.equal(find(plan, "SCOPE")[0]!.entry.kind, "PROVIDER_CAPTURE");
  assert.deepEqual(plan.effects, [{ about: "CAPTURE", effect: "ADVANCED" }]);
  // every planned payload is inside its type's allowlist (07: references and safe counts only)
  for (const s of plan.steps) if ("event" in s) for (const k of Object.keys(s.event.payload)) assert.ok(COMMERCE_EVENT_PAYLOAD_ALLOWLIST[s.event.type].includes(k), `${s.event.type}.${k}`);
});

test("planObservation — D-PAY-B5 (B09-N3): a capture first seen REVERSED is recorded COMPLETED and then REVERSED — two versions, two events, allocated, the order CAPTURED and never charged again, no entitlement, a REVERSAL case; without its completion instant nothing is applied (D-PAY-B6)", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("APPROVED");
  const inbox = w.ids.next() as InboxId;
  const reversed = observed(w, order, { status: "REVERSED", providerCompletedAt: new Date(w.clock.nowMs() - HOUR).toISOString() });
  const plan = planObservation(factsOf(w, order), { origin: { source: "WEBHOOK", inboxId: inbox }, content: { kind: "PROVIDER_EVENT", event: { kind: "CAPTURE_REVERSED", provider: "paypal", environment: "SANDBOX", externalEventId: "WH-1", capture: reversed, bodyHash: sha("body") } }, mint: mint(w) });
  assert.deepEqual(types(plan), ["payment_order.captured.v1", "capture.completed.v1", "capture.reversed.v1", "reconciliation_case.opened.v1"]);
  const insert = find(plan, "CAPTURE_INSERT")[0]!;
  const advance = find(plan, "CAPTURE_ADVANCE")[0]!;
  assert.equal(insert.fact.status, "COMPLETED");
  assert.equal(insert.fact.providerCompletedAt, reversed.providerCompletedAt, "the completion instant is kept as the sale's tax point");
  assert.equal(advance.captureId, insert.fact.captureId);
  assert.equal(advance.expectedVersion, 1);
  assert.equal(advance.change.status, "REVERSED");
  assert.equal(advance.event.version, 2);
  assert.equal(advance.event.payload["reversedServiceCents"], 97125);
  assert.equal(advance.event.payload["fundsState"], "UNKNOWN");
  assert.equal(find(plan, "AUTHORIZATION_ISSUE").length, 0);
  assert.equal(find(plan, "REFUND_FILE").length, 0, "the chargeback returned the money: nothing to refund");
  assert.deepEqual(find(plan, "CASE_OPEN").map((c) => c.entry.kind), ["REVERSAL"]);

  // D-PAY-B6 (residual FINAL-N2): the webhook's reversal resource carries no completion instant — nothing applied, not even an
  // observation row (the record stays applicable once the instant is known), and a stored provider query is asked for
  const noInstant = planObservation(factsOf(w, order), { origin: { source: "WEBHOOK", inboxId: inbox }, content: { kind: "PROVIDER_EVENT", event: { kind: "CAPTURE_REVERSED", provider: "paypal", environment: "SANDBOX", externalEventId: "WH-1", capture: { ...reversed, providerCompletedAt: null }, bodyHash: sha("body") } }, mint: mint(w) });
  assert.equal(noInstant.providerQueryRequired, true);
  assert.deepEqual(ops(noInstant), []);
  assert.deepEqual(noInstant.effects, [{ about: "CAPTURE", effect: "NO_CHANGE" }]);
  // ... and a stored query without it opens PROVIDER_INCONSISTENCY and applies nothing: a tax point is never invented
  const artifact = w.ids.next() as EvidenceArtifactRef;
  const query = planObservation(factsOf(w, order), {
    origin: { source: "PROVIDER_QUERY", artifactRef: artifact },
    content: { kind: "ORDER_OBSERVATION", observation: { providerOrderId: order.providerOrderId!, orderStatus: "COMPLETED", captures: [{ ...reversed, providerCompletedAt: null }], refunds: [], absenceIsProof: true, observedAt: w.clock.now(), evidenceHash: sha("query") } },
    mint: mint(w),
  });
  assert.equal(query.providerQueryRequired, false);
  assert.deepEqual(ops(query), ["CASE_OPEN", "OBSERVATION"]);
  assert.equal(find(query, "CASE_OPEN")[0]!.entry.kind, "PROVIDER_INCONSISTENCY");
  assert.equal(find(query, "CASE_OPEN")[0]!.entry.detailCode, "COMPLETION_TIME_UNKNOWN");
  // a COMPLETED observation without its instant follows the same rule
  const completed = planObservation(factsOf(w, order), { origin: { source: "WEBHOOK", inboxId: inbox }, content: { kind: "PROVIDER_EVENT", event: { kind: "CAPTURE_COMPLETED", provider: "paypal", environment: "SANDBOX", externalEventId: "WH-2", capture: { ...reversed, status: "COMPLETED", providerCompletedAt: null }, bodyHash: sha("body2") } }, mint: mint(w) });
  assert.equal(completed.providerQueryRequired, true);
  assert.equal(find(completed, "CAPTURE_INSERT").length, 0);
});

test("planObservation — S058: a capture of another provider, environment, order, payee or currency is its provider exception with its source; no fact of the order changes", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURING");
  const attempt = w.seedAttempt(order, "CAPTURE", "DISPATCHING");
  const cases: Array<[Partial<ObservedCapture>, string]> = [
    [{ provider: "stripe" }, "WRONG_PROVIDER"],
    [{ environment: "LIVE" }, "WRONG_ENVIRONMENT"],
    [{ providerOrderId: "PPO9999999999OTHER" }, "WRONG_ORDER"],
    [{ payeeDigest: sha("another-merchant") }, "WRONG_PAYEE"],
    [{ currency: "EUR" }, "WRONG_CURRENCY"],
  ];
  for (const [override, kind] of cases) {
    const plan = planObservation(factsOf(w, order), { origin: { source: "DISPATCH_RESPONSE", attemptId: attempt.attemptId }, content: { kind: "DISPATCH_RESULT", result: { kind: "CAPTURE_OBSERVED", capture: observed(w, order, override) } }, mint: mint(w) });
    assert.deepEqual(ops(plan), ["EXCEPTION", "OBSERVATION"], kind);
    const exception = find(plan, "EXCEPTION")[0]!.exception;
    assert.equal(exception.kind, kind);
    assert.equal(exception.source, "DISPATCH_RESPONSE");
    assert.equal(exception.attemptId, attempt.attemptId, "a dispatch response's exception is attributed to the stored operation's attempt (D-ING-B3)");
    assert.equal(exception.orderId, order.orderId);
    assert.deepEqual(plan.exceptions, [kind]);
    assert.equal(find(plan, "OBSERVATION")[0]!.observation.effect, "MISMATCH");
  }
});

test("planObservation — a wrong amount is real money without authority: a partial capture opens AMOUNT_MISMATCH and files a KAURO_REMEDY request; a second capture of a paid obligation is all excess with an EXCESS_CAPTURE case and request and no second entitlement (R2-140)", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURING");
  const attempt = w.seedAttempt(order, "CAPTURE", "DISPATCHING");
  const partial = planObservation(factsOf(w, order), { origin: { source: "DISPATCH_RESPONSE", attemptId: attempt.attemptId }, content: { kind: "DISPATCH_RESULT", result: { kind: "CAPTURE_OBSERVED", capture: observed(w, order, { amountCents: 50000n }) } }, mint: mint(w) });
  assert.equal(find(partial, "AUTHORIZATION_ISSUE").length, 0);
  const insert = find(partial, "CAPTURE_INSERT")[0]!;
  assert.equal(insert.fact.allocation.serviceCents + insert.fact.allocation.taxCents, 50000n, "min(amount, owed) pays the obligation");
  assert.deepEqual(find(partial, "CASE_OPEN").map((c) => [c.entry.kind, c.entry.detailCode, c.entry.amountCents]), [["AMOUNT_MISMATCH", "PARTIAL_CAPTURE", 50000n]]);
  const remedy = find(partial, "REFUND_FILE")[0]!;
  assert.equal(remedy.request.origin, "KAURO_REMEDY");
  assert.deepEqual(remedy.request.proposed, { serviceCents: insert.fact.allocation.serviceCents, taxCents: insert.fact.allocation.taxCents, excessCents: 0n });
  assert.equal(remedy.request.deliveryPhase, "NO_AUTHORIZATION");
  assert.equal(remedy.scope.kind, "REFUND");
  assert.equal(remedy.event.type, "refund.requested.v1");

  // R2-140: the order is already paid by its first capture and entitled
  const first = capturedRecord(w, order);
  const entitled = authorizationOf(w, order, first, "ACTIVE");
  const paidOrder = { ...order, state: "CAPTURED" as const, allocatedCents: R2_077.total };
  const second = planObservation(factsOf(w, paidOrder, { captures: [first], authorizations: [entitled] }), {
    origin: { source: "WEBHOOK", inboxId: w.ids.next() as InboxId },
    content: { kind: "PROVIDER_EVENT", event: { kind: "CAPTURE_COMPLETED", provider: "paypal", environment: "SANDBOX", externalEventId: "WH-2", capture: observed(w, order, { providerCaptureId: "PPC0000000000TEST2" }), bodyHash: sha("second") } },
    mint: mint(w),
  });
  const excess = find(second, "CAPTURE_INSERT")[0]!;
  assert.deepEqual(excess.fact.allocation, { serviceCents: 0n, taxCents: 0n, excessCents: R2_077.total });
  assert.equal(find(second, "AUTHORIZATION_ISSUE").length, 0, "one entitlement per purchase");
  assert.equal(find(second, "ORDER_TRANSITION").length, 0, "the order is never charged again");
  assert.deepEqual(find(second, "CASE_OPEN").map((c) => [c.entry.kind, c.entry.amountCents]), [["EXCESS_CAPTURE", R2_077.total]]);
  const excessRequest = find(second, "REFUND_FILE")[0]!;
  assert.equal(excessRequest.request.origin, "EXCESS_CAPTURE");
  assert.deepEqual(excessRequest.request.proposed, { serviceCents: 0n, taxCents: 0n, excessCents: R2_077.total });
});

test("planObservation — a capture whose subject no longer binds (source expired, S060) or honored after the price expiry under a changed tax rule (D-AUTH-B3) opens CAPTURE_WITHOUT_VALID_SUBJECT and files a KAURO_REMEDY request; an unchanged rule is honored and recorded so", async () => {
  const w = commerceWorld({ expiresInMs: -HOUR });
  const order = await w.seedOrder("CAPTURING");
  const attempt = w.seedAttempt(order, "CAPTURE", "DISPATCHING");
  const input = { origin: { source: "DISPATCH_RESPONSE" as const, attemptId: attempt.attemptId }, content: { kind: "DISPATCH_RESULT" as const, result: { kind: "CAPTURE_OBSERVED" as const, capture: observed(w, order) } }, mint: mint(w) };
  const expiredSource = planObservation(factsOf(w, order, { subject: subjectOf(w, { revision: { state: "EXPIRED" } }) }), input);
  assert.equal(find(expiredSource, "AUTHORIZATION_ISSUE").length, 0);
  assert.deepEqual(find(expiredSource, "CASE_OPEN").map((c) => [c.entry.kind, c.entry.detailCode]), [["CAPTURE_WITHOUT_VALID_SUBJECT", "SOURCE_EXPIRED"]]);
  assert.equal(find(expiredSource, "REFUND_FILE")[0]!.request.origin, "KAURO_REMEDY");
  assert.equal(find(expiredSource, "ORDER_TRANSITION")[0]!.change.state, "CAPTURED", "the real capture is reconciled regardless (TRANSITIONS: it cannot ignore a real capture)");

  const changed: FiscalProfileRecord = { ...w.profile, taxRateBps: 1600 };
  const changedRule = planObservation(factsOf(w, order, { currentProfile: changed }), input);
  assert.deepEqual(find(changedRule, "CASE_OPEN").map((c) => c.entry.detailCode), ["FISCAL_TREATMENT_CHANGED"]);
  assert.equal(find(changedRule, "AUTHORIZATION_ISSUE").length, 0);

  const honored = planObservation(factsOf(w, order), input);
  assert.equal(find(honored, "AUTHORIZATION_ISSUE")[0]!.authorization.honoredAfterPriceExpiry, true);
});

test("planObservation — D-EVT-B2: a fee and a funds availability learned after the completion are versions of their own — fee_observed.v1 from the balance the funds stand in, then funds_observed.v1 carrying the movable balance (the amount less the fee); a webhook seen twice is a DUPLICATE, an older one STALE_IGNORED, a contradiction PROVIDER_INCONSISTENCY", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURED");
  const capture = capturedRecord(w, order, { providerCaptureId: "PPC0000000000TEST1" });
  const paid = { ...order, allocatedCents: R2_077.total };
  const inbox = w.ids.next() as InboxId;
  const event = (c: ObservedCapture, id = "WH-3") => ({ kind: "PROVIDER_EVENT" as const, event: { kind: "CAPTURE_COMPLETED" as const, provider: "paypal", environment: "SANDBOX" as const, externalEventId: id, capture: c, bodyHash: sha(id), providerEventAt: w.clock.now() } });
  const later = planObservation(factsOf(w, paid, { captures: [capture] }), { origin: { source: "WEBHOOK", inboxId: inbox }, content: event(observed(w, order, { feeCents: 5275n, fundsState: "HELD" })), mint: mint(w) });
  assert.deepEqual(ops(later), ["CAPTURE_FEE", "CAPTURE_FUNDS", "OBSERVATION"]);
  const [fee, funds] = [find(later, "CAPTURE_FEE")[0]!, find(later, "CAPTURE_FUNDS")[0]!];
  assert.equal(fee.event.type, "capture.fee_observed.v1");
  assert.equal(fee.event.payload["fundsState"], "UNKNOWN");
  assert.equal(fee.expectedVersion, 1);
  assert.equal(funds.event.type, "capture.funds_observed.v1");
  assert.equal(funds.expectedVersion, 2);
  assert.equal(funds.event.payload["amountCents"], 115579 - 5275, "the movable balance: the amount less the reported fee (D-LEDGER-B5)");
  assert.equal(funds.event.payload["previousFundsState"], "UNKNOWN");

  // the same webhook event already applied to the subject: a DUPLICATE that appends nothing (once per event and subject)
  const applied: ProviderObservationRecord = { observationId: w.ids.next() as never, agencyId: w.agencyId, orderId: order.orderId, source: "WEBHOOK", inboxId: inbox, subjectKind: "CAPTURE", providerRef: capture.providerCaptureId, observedStatus: "COMPLETED", observedAt: w.clock.now(), evidenceHash: sha("x"), effect: "ADVANCED", providerEventAt: w.clock.now() };
  const again = planObservation(factsOf(w, paid, { captures: [capture], observations: [applied] }), { origin: { source: "WEBHOOK", inboxId: inbox }, content: event(observed(w, order)), mint: mint(w) });
  assert.deepEqual(ops(again), []);
  assert.deepEqual(again.effects, [{ about: "CAPTURE", effect: "DUPLICATE" }]);
  // an older event of the subject (provider chronology) changes nothing
  const older = { kind: "PROVIDER_EVENT" as const, event: { ...event(observed(w, order, { fundsState: "AVAILABLE" }), "WH-0").event, providerEventAt: new Date(w.clock.nowMs() - HOUR).toISOString() } };
  const stale = planObservation(factsOf(w, paid, { captures: [capture], observations: [applied] }), { origin: { source: "WEBHOOK", inboxId: w.ids.next() as InboxId }, content: older, mint: mint(w) });
  assert.deepEqual(ops(stale), ["OBSERVATION"]);
  assert.deepEqual(stale.effects, [{ about: "CAPTURE", effect: "STALE_IGNORED" }]);
  // a pending event after the completion is stale; a denial after it is a contradiction of a terminal state
  const pending = planObservation(factsOf(w, paid, { captures: [capture] }), { origin: { source: "WEBHOOK", inboxId: w.ids.next() as InboxId }, content: event(observed(w, order, { status: "PENDING" }), "WH-4"), mint: mint(w) });
  assert.deepEqual(pending.effects, [{ about: "CAPTURE", effect: "STALE_IGNORED" }]);
  const denied = planObservation(factsOf(w, paid, { captures: [capture] }), { origin: { source: "WEBHOOK", inboxId: w.ids.next() as InboxId }, content: event(observed(w, order, { status: "DENIED" }), "WH-5"), mint: mint(w) });
  assert.deepEqual(find(denied, "CASE_OPEN").map((c) => [c.entry.kind, c.entry.detailCode, c.entry.captureId, c.entry.orderId]), [["PROVIDER_INCONSISTENCY", "TERMINAL_CONTRADICTED", capture.captureId, order.orderId]]);
  // a fee that differs from the fee already learned is a PROVIDER_INCONSISTENCY case, never a second fee
  const feeKnown = { ...capture, version: 2, providerFeeCents: 5275n };
  const differs = planObservation(factsOf(w, paid, { captures: [feeKnown] }), { origin: { source: "WEBHOOK", inboxId: w.ids.next() as InboxId }, content: event(observed(w, order, { feeCents: 5000n }), "WH-6"), mint: mint(w) });
  assert.equal(find(differs, "CAPTURE_FEE").length, 0);
  assert.equal(find(differs, "CASE_OPEN")[0]!.entry.detailCode, "FEE_DIFFERS");
});

test("planObservation — S059: a reversal after delivery revokes the entitlement POST_DELIVERY and lapses the approved refunds of the capture; the order stays CAPTURED", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURED");
  const capture = capturedRecord(w, order);
  const delivered = authorizationOf(w, order, capture, "DELIVERED");
  const approved: RefundRecord = {
    refundId: w.ids.next() as RefundId,
    agencyId: w.agencyId,
    projectId: w.projectId,
    orderId: order.orderId,
    captureId: capture.captureId,
    version: 2,
    state: "APPROVED",
    origin: "CUSTOMER_REQUEST",
    reasonCode: "The customer changed plans",
    termsHash: order.termsHash,
    deliveryPhase: "POST_DELIVERY",
    proposed: { serviceCents: 1000n, taxCents: 190n, excessCents: 0n },
    requestedAt: w.clock.now(),
    approved: { amounts: { serviceCents: 1000n, taxCents: 190n, excessCents: 0n }, authorizationKind: "OWNER_STEP_UP", authorizationHash: sha("a"), effectsHash: sha("e"), creditNoteRequired: true, approvedByUserId: w.owner.userId, approvedAt: w.clock.now() },
  };
  const plan = planObservation(factsOf(w, { ...order, allocatedCents: R2_077.total }, { captures: [capture], authorizations: [delivered], refunds: [approved] }), {
    origin: { source: "WEBHOOK", inboxId: w.ids.next() as InboxId },
    content: { kind: "PROVIDER_EVENT", event: { kind: "CAPTURE_REVERSED", provider: "paypal", environment: "SANDBOX", externalEventId: "WH-9", capture: observed(w, order, { status: "REVERSED", providerCompletedAt: null }), bodyHash: sha("rev") } },
    mint: mint(w),
  });
  assert.deepEqual(ops(plan), ["CAPTURE_ADVANCE", "AUTHORIZATION_TRANSITION", "REFUND_TRANSITION", "CASE_OPEN", "OBSERVATION"]);
  const revoke = find(plan, "AUTHORIZATION_TRANSITION")[0]!;
  assert.equal(revoke.change.revocation?.phase, "POST_DELIVERY");
  assert.equal(revoke.change.revocation?.code, "CAPTURE_REVERSED");
  assert.equal(find(plan, "REFUND_TRANSITION")[0]!.change.state, "FAILED");
  assert.equal(find(plan, "REFUND_TRANSITION")[0]!.change.failureCode, "CAPTURE_REVERSED");
  assert.equal(find(plan, "ORDER_TRANSITION").length, 0);
  assert.equal(find(plan, "CAPTURE_ADVANCE")[0]!.event.payload["reversedServiceCents"], 97125, "the chargeback returns the unrefunded components");
});

test("planObservation — D-DISPUTE-B1: a dispute in progress opens DISPUTE_OPEN with its amount and records the funds HELD; the capture stays COMPLETED and its entitlement live", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURED");
  const capture = capturedRecord(w, order);
  const live = authorizationOf(w, order, capture, "ACTIVE");
  const plan = planObservation(factsOf(w, { ...order, allocatedCents: R2_077.total }, { captures: [capture], authorizations: [live] }), {
    origin: { source: "WEBHOOK", inboxId: w.ids.next() as InboxId },
    content: { kind: "PROVIDER_EVENT", event: { kind: "DISPUTE_OPENED", provider: "paypal", environment: "SANDBOX", externalEventId: "WH-D", dispute: { provider: "paypal", environment: "SANDBOX", providerCaptureId: capture.providerCaptureId, providerDisputeId: "PPD1", status: "OPEN", amountCents: 20000n, currency: "USD", reasonCode: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", responseDueAt: null, evidenceHash: sha("d") }, bodyHash: sha("d") } },
    mint: mint(w),
  });
  assert.deepEqual(ops(plan), ["CAPTURE_FUNDS", "CASE_OPEN", "OBSERVATION"]);
  assert.equal(find(plan, "CAPTURE_FUNDS")[0]!.change.fundsState, "HELD");
  const c = find(plan, "CASE_OPEN")[0]!.entry;
  assert.deepEqual([c.kind, c.captureId, c.amountCents], ["DISPUTE_OPEN", capture.captureId, 20000n]);
  assert.equal(find(plan, "AUTHORIZATION_TRANSITION").length, 0);
});

test("planObservation — a refund's provider completion confirms its attempt and completes it with the service basis left and the funds state its money is taken from; the last service refund revokes the entitlement (D-REF-B5)", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURED");
  const capture = capturedRecord(w, order, { fundsState: "HELD", version: 3 });
  const live = authorizationOf(w, order, capture, "ACTIVE");
  const refundId = w.ids.next() as RefundId;
  const refund: RefundRecord = {
    refundId,
    agencyId: w.agencyId,
    projectId: w.projectId,
    orderId: order.orderId,
    captureId: capture.captureId,
    version: 3,
    state: "SUBMITTING",
    origin: "CUSTOMER_REQUEST",
    reasonCode: "Cancelled",
    termsHash: order.termsHash,
    deliveryPhase: "PRE_EXECUTION",
    proposed: { serviceCents: R2_077.service, taxCents: R2_077.tax, excessCents: 0n },
    requestedAt: w.clock.now(),
    approved: { amounts: { serviceCents: R2_077.service, taxCents: R2_077.tax, excessCents: 0n }, authorizationKind: "OWNER_STEP_UP", authorizationHash: sha("a"), effectsHash: sha("e"), creditNoteRequired: true, approvedByUserId: w.owner.userId, approvedAt: w.clock.now() },
  };
  const attempt = { ...w.seedAttempt(order, "CAPTURE", "DISPATCHING"), operation: "REFUND" as const, refundId };
  w.store().attempts.set(attempt.attemptId, attempt);
  const plan = planObservation(factsOf(w, { ...order, allocatedCents: R2_077.total }, { captures: [capture], authorizations: [live], refunds: [refund] }), {
    origin: { source: "DISPATCH_RESPONSE", attemptId: attempt.attemptId },
    content: { kind: "DISPATCH_RESULT", result: { kind: "REFUND_OBSERVED", refund: { provider: "paypal", environment: "SANDBOX", providerCaptureId: capture.providerCaptureId, providerRefundId: "PPR1", status: "COMPLETED", amountCents: R2_077.total, currency: "USD", evidenceHash: sha("r") } } },
    mint: mint(w),
  });
  assert.deepEqual(ops(plan), ["ATTEMPT_TRANSITION", "AUTHORIZATION_TRANSITION", "REFUND_TRANSITION", "SCOPE", "OBSERVATION"]);
  const completed = find(plan, "REFUND_TRANSITION")[0]!;
  assert.equal(completed.event.type, "refund.completed.v1");
  assert.equal(completed.event.payload["serviceBasisAfterCents"], 0);
  assert.equal(completed.event.payload["fundsState"], "HELD");
  assert.equal(completed.change.providerRefundId, "PPR1");
  assert.equal(find(plan, "AUTHORIZATION_TRANSITION")[0]!.change.revocation?.code, "SERVICE_FULLY_REFUNDED");
  assert.equal(find(plan, "SCOPE")[0]!.entry.kind, "PROVIDER_REFUND");
});

test("planObservation — the protocol's own results: an ambiguous capture makes the attempt UNCERTAIN, the order CAPTURE_UNCERTAIN and a visible UNCERTAIN_EFFECT case; a proved no-effect returns the order to APPROVED (or CREATED when not approved); a created order learns its identity once with an allowlisted approval page", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURING");
  const attempt = w.seedAttempt(order, "CAPTURE", "DISPATCHING");
  const origin = { source: "DISPATCH_RESPONSE" as const, attemptId: attempt.attemptId };
  const ambiguous = planObservation(factsOf(w, order), { origin, content: { kind: "DISPATCH_RESULT", result: { kind: "AMBIGUOUS", reason: "TIMEOUT" } }, mint: mint(w) });
  assert.deepEqual(types(ambiguous), ["payment_order.capture_uncertain.v1", "payment_attempt.uncertain.v1", "reconciliation_case.opened.v1"]);
  assert.equal(find(ambiguous, "ATTEMPT_TRANSITION")[0]!.change.outcomeCode, "TIMEOUT");
  assert.equal(find(ambiguous, "CASE_OPEN")[0]!.entry.evidenceHash, attempt.requestHash, "the case names the exact request whose effect is unresolved");
  assert.equal(find(ambiguous, "OBSERVATION").length, 0, "nothing authenticated was observed");

  const noEffect = planObservation(factsOf(w, order), { origin, content: { kind: "DISPATCH_RESULT", result: { kind: "PROVED_NO_EFFECT", outcomeCode: "INSTRUMENT_DECLINED", evidenceHash: sha("422") } }, mint: mint(w) });
  assert.deepEqual(find(noEffect, "ORDER_TRANSITION").map((s) => s.change.state), ["APPROVED"]);
  assert.equal(find(noEffect, "ATTEMPT_TRANSITION")[0]!.change.state, "FAILED_NO_EFFECT");
  const unapproved = planObservation(factsOf(w, order), { origin, content: { kind: "DISPATCH_RESULT", result: { kind: "PROVED_NO_EFFECT", outcomeCode: "ORDER_NOT_APPROVED", evidenceHash: sha("422") } }, mint: mint(w) });
  assert.deepEqual(find(unapproved, "ORDER_TRANSITION").map((s) => s.change.state), ["CREATED"]);

  const creating = await w.seedOrder("CREATING");
  const create = w.seedAttempt(creating, "CREATE_ORDER", "DISPATCHING");
  const created = planObservation(factsOf(w, creating), { origin: { source: "DISPATCH_RESPONSE", attemptId: create.attemptId }, content: { kind: "DISPATCH_RESULT", result: { kind: "ORDER_CREATED", providerOrderId: "PPO00000000000077", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PPO00000000000077", evidenceHash: sha("created") } }, mint: mint(w) });
  const edge = find(created, "ORDER_TRANSITION")[0]!;
  assert.deepEqual([edge.change.state, edge.change.providerOrderId, edge.change.providerApprovalUrl], ["CREATED", "PPO00000000000077", "https://www.sandbox.paypal.com/checkoutnow?token=PPO00000000000077"]);
  assert.equal(find(created, "SCOPE")[0]!.entry.key, "paypal|SANDBOX|PPO00000000000077");
  const foreignHost = planObservation(factsOf(w, creating), { origin: { source: "DISPATCH_RESPONSE", attemptId: create.attemptId }, content: { kind: "DISPATCH_RESULT", result: { kind: "ORDER_CREATED", providerOrderId: "PPO00000000000078", approvalUrl: "https://attacker.example/checkout", evidenceHash: sha("created") } }, mint: mint(w) });
  assert.equal(find(foreignHost, "ORDER_TRANSITION")[0]!.change.providerApprovalUrl, undefined, "the browser is never sent to a host outside the allowlist (10)");
  assert.equal(find(foreignHost, "CASE_OPEN")[0]!.entry.detailCode, "APPROVAL_HOST_NOT_ALLOWED");
  // the last allowed creation attempt proving no effect fails the order (creation_proved_no_effect)
  const last = w.seedAttempt(creating, "CREATE_ORDER", "DISPATCHING", { ordinal: 3 });
  const spent = planObservation(factsOf(w, creating), { origin: { source: "DISPATCH_RESPONSE", attemptId: last.attemptId }, content: { kind: "DISPATCH_RESULT", result: { kind: "PROVED_NO_EFFECT", outcomeCode: "VALIDATION_ERROR", evidenceHash: sha("400") } }, mint: mint(w) });
  assert.deepEqual(find(spent, "ORDER_TRANSITION").map((s) => s.change.state), ["FAILED"]);
});

test("planObservation — 15 \"Unknown provider statuses become UNRECOGNIZED_PROVIDER_STATE\": an unrecognized capture result is never coerced — the attempt UNCERTAIN, the order CAPTURE_UNCERTAIN, an UNRECOGNIZED_PROVIDER_STATE case and the observation recorded as UNRECOGNIZED; an unrecognized provider event of the order opens the same case and changes no fact", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURING");
  const attempt = w.seedAttempt(order, "CAPTURE", "DISPATCHING");
  const plan = planObservation(factsOf(w, order), { origin: { source: "DISPATCH_RESPONSE", attemptId: attempt.attemptId }, content: { kind: "DISPATCH_RESULT", result: { kind: "UNRECOGNIZED", evidenceHash: sha("odd") } }, mint: mint(w) });
  assert.deepEqual(types(plan), ["payment_order.capture_uncertain.v1", "payment_attempt.uncertain.v1", "reconciliation_case.opened.v1"]);
  assert.equal(find(plan, "ATTEMPT_TRANSITION")[0]!.change.outcomeCode, "UNRECOGNIZED_PROVIDER_STATE");
  assert.deepEqual(find(plan, "CASE_OPEN").map((c) => [c.entry.kind, c.entry.orderId]), [["UNRECOGNIZED_PROVIDER_STATE", order.orderId]]);
  assert.deepEqual(find(plan, "OBSERVATION").map((o) => [o.observation.observedStatus, o.observation.effect]), [["UNRECOGNIZED", "UNRECOGNIZED"]]);
  assert.equal(find(plan, "CAPTURE_INSERT").length, 0);

  const captured = await w.seedOrder("CAPTURED");
  const event = planObservation(factsOf(w, captured), {
    origin: { source: "WEBHOOK", inboxId: w.ids.next() as InboxId },
    content: { kind: "PROVIDER_EVENT", event: { kind: "UNRECOGNIZED", provider: "paypal", environment: "SANDBOX", externalEventId: "WH-U", providerOrderId: captured.providerOrderId!, bodyHash: sha("u") } },
    mint: mint(w),
  });
  assert.deepEqual(ops(event), ["CASE_OPEN", "OBSERVATION"]);
  assert.deepEqual([find(event, "CASE_OPEN")[0]!.entry.kind, find(event, "OBSERVATION")[0]!.observation.effect], ["UNRECOGNIZED_PROVIDER_STATE", "UNRECOGNIZED"]);
});

test("planObservation — an absence proves no effect only when the view can prove absence and was taken after the attempt's dispatch deadline (D-PROTO-B6): before it, a call may still be in flight", async () => {
  const w = commerceWorld();
  const creating = await w.seedOrder("CREATING");
  const attempt = w.seedAttempt(creating, "CREATE_ORDER", "UNCERTAIN", { deadlineMs: w.clock.nowMs() + 30_000 });
  const view = (observedAt: UtcInstant) => ({ kind: "ORDER_OBSERVATION" as const, observation: { providerOrderId: null, orderStatus: "NOT_FOUND" as const, captures: [], refunds: [], absenceIsProof: true, observedAt, evidenceHash: sha(`nf-${observedAt}`) } });
  const early = planObservation(factsOf(w, creating), { origin: { source: "DISPATCH_RESPONSE", attemptId: attempt.attemptId }, content: view(w.clock.now()), mint: mint(w) });
  assert.equal(find(early, "ATTEMPT_TRANSITION").length, 0);
  assert.deepEqual(early.effects, [{ about: "ORDER", effect: "NO_CHANGE" }]);
  const late = planObservation(factsOf(w, creating), { origin: { source: "DISPATCH_RESPONSE", attemptId: attempt.attemptId }, content: view(new Date(w.clock.nowMs() + 31_000).toISOString()), mint: mint(w) });
  assert.equal(find(late, "ATTEMPT_TRANSITION")[0]!.change.state, "FAILED_NO_EFFECT");
  assert.equal(find(late, "ATTEMPT_TRANSITION")[0]!.change.outcomeCode, "NOT_FOUND_BY_REQUEST_ID");
});

// --- planPostings --------------------------------------------------------------------------------------------------------------

function source(eventType: string, payload: Record<string, unknown>, aggregateId = "01920000-0000-7000-8000-000000000c01"): PostingSource {
  return { eventId: "01920000-0000-7000-8000-0000000000e1" as EventId, eventType, aggregateId, agencyId: "01920000-0000-7000-8000-0000000000a1" as never, payload: payload as PostingSource["payload"], recordedAt: "2026-09-26T12:00:00.000Z" };
}

test("planPostings — R2-078 and D-LEDGER-B5: the completion posts the contract liability, the tax and the reported fee from the receivable (net 91850); a later fee, a funds move, a refund and a chargeback take money from the balance their event names; every set balances and is sourced by its event and aggregate", () => {
  const completed = planPostings(source("capture.completed.v1", { allocatedServiceCents: 97125, allocatedTaxCents: 0, excessCents: 0, providerFeeCents: 5275, evidenceHash: "a".repeat(64), currency: "USD" }));
  assert.equal(completed.kind, "POST");
  if (completed.kind !== "POST") return;
  assert.equal(completed.set.sourceKind, "CAPTURE");
  assert.equal(completed.set.sourceRef, "01920000-0000-7000-8000-000000000c01");
  assert.deepEqual(completed.set.source, { kind: "EVENT", eventId: "01920000-0000-7000-8000-0000000000e1" });
  const receivable = completed.set.lines.filter((l) => l.account === "PSP_RECEIVABLE").reduce((n, l) => n + (l.direction === "DEBIT" ? l.amountCents : -l.amountCents), 0n);
  assert.equal(receivable, 91850n, "R2-078: net receivable after the provider-reported fee");
  assert.ok(isBalanced(completed.set.lines));
  assert.equal(completed.set.observedAt, completed.set.effectiveAt);

  const fee = planPostings(source("capture.fee_observed.v1", { providerFeeCents: 5275, fundsState: "HELD", evidenceHash: "b".repeat(64) }));
  assert.ok(fee.kind === "POST" && fee.set.sourceKind === "FEE");
  if (fee.kind === "POST") assert.deepEqual(fee.set.lines.map((l) => [l.account, l.direction, l.amountCents]), [["PROCESSOR_EXPENSE", "DEBIT", 5275n], ["PSP_HELD", "CREDIT", 5275n]]);

  const funds = planPostings(source("capture.funds_observed.v1", { fundsState: "AVAILABLE", previousFundsState: "HELD", amountCents: 91850, evidenceHash: "c".repeat(64) }));
  assert.ok(funds.kind === "POST" && funds.set.sourceKind === "FUNDS");
  if (funds.kind === "POST") {
    assert.deepEqual(funds.set.lines.map((l) => [l.account, l.direction]), [["PSP_AVAILABLE", "DEBIT"], ["PSP_HELD", "CREDIT"]]);
    for (const l of funds.set.lines) assert.notEqual(l.account, "BANK_CASH", "a provider balance is never coerced to bank cash (CMD034)");
  }
  assert.equal(planPostings(source("capture.funds_observed.v1", { fundsState: "HELD", previousFundsState: "UNKNOWN", amountCents: 0 })).kind, "NOT_APPLICABLE", "nothing to move posts nothing");

  const refund = planPostings(source("refund.completed.v1", { serviceCents: 1000, taxCents: 190, excessCents: 0, fundsState: "AVAILABLE", evidenceHash: "d".repeat(64) }, "01920000-0000-7000-8000-000000000f01"));
  assert.ok(refund.kind === "POST" && refund.set.sourceKind === "REFUND" && refund.set.sourceRef === "01920000-0000-7000-8000-000000000f01");
  if (refund.kind === "POST") assert.deepEqual(refund.set.lines.at(-1), { account: "PSP_AVAILABLE", direction: "CREDIT", amountCents: 1190n });

  const chargeback = planPostings(source("capture.reversed.v1", { reversedServiceCents: 97125, reversedTaxCents: 18454, reversedExcessCents: 0, fundsState: "UNKNOWN", evidenceHash: "e".repeat(64) }));
  assert.ok(chargeback.kind === "POST" && chargeback.set.sourceKind === "CHARGEBACK");
  if (chargeback.kind === "POST") assert.ok(isBalanced(chargeback.set.lines));

  assert.equal(planPostings(source("capture.pending.v1", {})).kind, "NOT_APPLICABLE");
  assert.throws(() => planPostings(source("refund.completed.v1", { serviceCents: 1000, taxCents: 190, excessCents: 0 })), /fundsState/);
});

test("planPostings — Q-B09-23 (the re-check's residual N4, open for the design owner): a full refund after a reported fee returns the whole amount from the balance its event names, which leaves that provider balance negative for the capture by exactly the fee the provider kept; every set still balances and no bank account is touched", () => {
  // the capture (fee reported while funds were UNKNOWN), then the whole capture refunded while funds are still UNKNOWN
  const sets = [
    planPostings(source("capture.completed.v1", { allocatedServiceCents: 97125, allocatedTaxCents: 18454, excessCents: 0, evidenceHash: "a".repeat(64) })),
    planPostings(source("capture.fee_observed.v1", { providerFeeCents: 5275, fundsState: "UNKNOWN", evidenceHash: "b".repeat(64) })),
    planPostings(source("refund.completed.v1", { serviceCents: 97125, taxCents: 18454, excessCents: 0, fundsState: "UNKNOWN", evidenceHash: "c".repeat(64) }, "01920000-0000-7000-8000-000000000f02")),
  ];
  const lines = sets.flatMap((p) => (p.kind === "POST" ? [...p.set.lines] : []));
  assert.equal(lines.length, 8, "zero lines are never written");
  for (const p of sets) assert.ok(p.kind === "POST" && isBalanced(p.set.lines));
  const net = (account: string) => lines.filter((l) => l.account === account).reduce((n, l) => n + (l.direction === "DEBIT" ? l.amountCents : -l.amountCents), 0n);
  assert.equal(net("PSP_RECEIVABLE"), -5275n, "the receivable the capture debited is credited the fee and the whole return (Q-B09-23)");
  assert.deepEqual([net("CONTRACT_LIABILITY"), net("TAX_PAYABLE"), net("PROCESSOR_EXPENSE")], [0n, 0n, 5275n]);
  assert.ok(lines.every((l) => l.account !== "BANK_CASH" && l.account !== "BANK_IN_TRANSIT"));
});

test("planPostings — D-LEDGER-B4: a case's reviewed resolution posts mirroring reversals of the entries it corrects, keyed by line position, and its adjusting lines; without the resolution nothing posts", () => {
  const resolved = source("reconciliation_case.resolved.v1", { resolutionCode: "FEE_CORRECTED" });
  assert.equal(planPostings(resolved).kind, "NOT_APPLICABLE");
  const plan = planPostings(resolved, {
    reverse: [
      { entryId: "01920000-0000-7000-8000-0000000001e1" as never, accountCode: "PROCESSOR_EXPENSE", direction: "DEBIT", amountCents: 5275n, currency: "USD" },
      { entryId: "01920000-0000-7000-8000-0000000001e2" as never, accountCode: "PSP_RECEIVABLE", direction: "CREDIT", amountCents: 5275n, currency: "USD" },
    ],
    adjust: [
      { account: "PROCESSOR_EXPENSE", direction: "DEBIT", amountCents: 5000n },
      { account: "PSP_RECEIVABLE", direction: "CREDIT", amountCents: 5000n },
    ],
    evidenceHash: "f".repeat(64),
  });
  assert.equal(plan.kind, "POST");
  if (plan.kind !== "POST") return;
  assert.equal(plan.set.sourceKind, "CORRECTION");
  assert.deepEqual(plan.set.lines.slice(0, 2), [{ account: "PROCESSOR_EXPENSE", direction: "CREDIT", amountCents: 5275n }, { account: "PSP_RECEIVABLE", direction: "DEBIT", amountCents: 5275n }]);
  assert.deepEqual(plan.set.reverses, { 0: "01920000-0000-7000-8000-0000000001e1", 1: "01920000-0000-7000-8000-0000000001e2" });
  assert.ok(isBalanced(plan.set.lines));
});

// --- planFiscalDocument -----------------------------------------------------------------------------------------------------------

test("planFiscalDocument — R2-128 and D-FISC-B6: an unreviewed treatment is a blocked invoice draft; a reviewed exempt export validates with the collected amounts; an excess is not a sale; nothing an exemption could be inferred from is an input", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURED");
  const capture = capturedRecord(w, order);
  const unreviewed: FiscalProfileRecord = { ...w.profile, taxTreatment: "REVIEW_REQUIRED", taxRule: "UNRESOLVED", taxRateBps: 0 };
  const blocked = planFiscalDocument({ kind: "INVOICE", capture, order, priced: w.quote.tax, saleProfile: unreviewed, currentProfile: unreviewed, issuer: w.issuer, existing: null });
  assert.equal(blocked.kind, "DRAFT");
  if (blocked.kind === "DRAFT") {
    assert.equal(blocked.validate, false);
    assert.equal(blocked.document.blockedReason, "FISCAL_TREATMENT_UNREVIEWED");
    assert.equal(blocked.document.taxTreatment, "REVIEW_REQUIRED");
  }
  const exempt: FiscalProfileRecord = { ...w.profile, taxTreatment: "EXEMPT_EXPORT", taxRule: "ZERO_REVIEWED", taxRateBps: 0, exportEvidenceHash: sha("export") };
  const zeroCapture = capturedRecord(w, order, { amountCents: R2_077.service, allocation: { serviceCents: R2_077.service, taxCents: 0n, excessCents: 0n } });
  const validated = planFiscalDocument({ kind: "INVOICE", capture: zeroCapture, order, priced: { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 }, saleProfile: exempt, currentProfile: exempt, issuer: w.issuer, existing: null });
  assert.equal(validated.kind, "DRAFT");
  if (validated.kind === "DRAFT") {
    assert.equal(validated.validate, true);
    assert.equal(validated.document.blockedReason, undefined);
    assert.deepEqual([validated.document.serviceCents, validated.document.taxCents], [R2_077.service, 0n]);
  }
  const excess = capturedRecord(w, order, { allocation: { serviceCents: 0n, taxCents: 0n, excessCents: R2_077.total } });
  assert.deepEqual(planFiscalDocument({ kind: "INVOICE", capture: excess, order, priced: w.quote.tax, saleProfile: w.profile, currentProfile: w.profile, issuer: w.issuer, existing: null }), { kind: "NONE", reason: "NOT_A_SALE" });
  // a reviewed rule other than the one the sale was priced with blocks (never a silent re-tax of collected money)
  const changed = planFiscalDocument({ kind: "INVOICE", capture, order, priced: w.quote.tax, saleProfile: { ...w.profile, taxRateBps: 1600 }, currentProfile: w.profile, issuer: w.issuer, existing: null });
  assert.ok(changed.kind === "DRAFT" && changed.document.blockedReason === "FISCAL_TREATMENT_CHANGED");
});

test("planFiscalDocument — D-FISC-B5 and B09-N5: a credit note carries exactly the corrected invoice's snapshot and waits for the invoice's issuance; a blocked invoice draft is resolved by a later review that reaches back to the sale, never re-pointed away from a known treatment", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("CAPTURED");
  const capture = capturedRecord(w, order);
  const invoice: TaxDocumentRecord = { documentId: w.ids.next() as TaxDocumentId, agencyId: w.agencyId, orderId: order.orderId, captureId: capture.captureId, kind: "INVOICE", version: 2, state: "VALIDATED", fiscalProfileId: w.profile.profileId, issuerRef: w.issuer.issuerRef, taxTreatment: "DOMESTIC_TAXABLE", serviceCents: R2_077.service, taxCents: R2_077.tax, currency: "USD" };
  const refund: RefundRecord = {
    refundId: w.ids.next() as RefundId,
    agencyId: w.agencyId,
    projectId: w.projectId,
    orderId: order.orderId,
    captureId: capture.captureId,
    version: 4,
    state: "COMPLETED",
    origin: "CUSTOMER_REQUEST",
    reasonCode: "Cancelled",
    termsHash: order.termsHash,
    deliveryPhase: "PRE_EXECUTION",
    proposed: { serviceCents: 1000n, taxCents: 190n, excessCents: 0n },
    requestedAt: w.clock.now(),
    approved: { amounts: { serviceCents: 1000n, taxCents: 190n, excessCents: 0n }, authorizationKind: "OWNER_STEP_UP", authorizationHash: sha("a"), effectsHash: sha("e"), creditNoteRequired: true, approvedByUserId: w.owner.userId, approvedAt: w.clock.now() },
    providerRefundId: "PPR1",
    evidenceHash: sha("r"),
    completedAt: w.clock.now(),
  };
  assert.deepEqual(planFiscalDocument({ kind: "CREDIT_NOTE", refund, invoice: null, existing: null }), { kind: "NONE", reason: "AWAIT_INVOICE" });
  const waiting = planFiscalDocument({ kind: "CREDIT_NOTE", refund, invoice, existing: null });
  assert.ok(waiting.kind === "DRAFT" && !waiting.validate);
  if (waiting.kind === "DRAFT") {
    assert.deepEqual([waiting.document.fiscalProfileId, waiting.document.issuerRef, waiting.document.taxTreatment, waiting.document.correctsDocumentId], [invoice.fiscalProfileId, invoice.issuerRef, invoice.taxTreatment, invoice.documentId]);
    assert.deepEqual([waiting.document.serviceCents, waiting.document.taxCents], [1000n, 190n]);
  }
  const issued = { ...invoice, state: "ISSUED" as const, legalNumber: "SETP-1", issuedAt: w.clock.now(), providerDocumentId: "DOC-1", evidenceHash: sha("i") };
  const ready = planFiscalDocument({ kind: "CREDIT_NOTE", refund, invoice: issued, existing: null });
  assert.ok(ready.kind === "DRAFT" && ready.validate);
  assert.deepEqual(planFiscalDocument({ kind: "CREDIT_NOTE", refund: { ...refund, approved: { ...refund.approved!, creditNoteRequired: false } }, invoice: issued, existing: null }), { kind: "NONE", reason: "NO_CREDIT_NOTE_REQUIRED" });

  // re-evaluation of a blocked invoice draft. The sale's versions: the explicit unknown current at the tax point (the capture's
  // completion), then a reviewed version recorded after the sale whose validity reaches back to it (a later review resolving the
  // unknown), then — for a sale priced under a known treatment — a later version that would change it
  const taxPoint = capture.providerCompletedAt!;
  const before = new Date(Date.parse(taxPoint) - 48 * HOUR).toISOString();
  const after = new Date(Date.parse(taxPoint) + 24 * HOUR).toISOString();
  const unknown: FiscalProfileRecord = { ...w.profile, profileId: w.ids.next() as never, taxTreatment: "REVIEW_REQUIRED", taxRule: "UNRESOLVED", taxRateBps: 0, validFrom: before, recordedAt: before, supersededAt: after };
  const review: FiscalProfileRecord = { ...w.profile, profileId: w.ids.next() as never, validFrom: before, recordedAt: after, supersedesProfileId: unknown.profileId };
  const draft: TaxDocumentRecord = { ...invoice, version: 1, state: "DRAFT", fiscalProfileId: unknown.profileId, taxTreatment: "REVIEW_REQUIRED", blockedReason: "FISCAL_TREATMENT_UNREVIEWED" };
  assert.equal(saleProfileAt([unknown], taxPoint)?.profileId, unknown.profileId);
  const stillUnknown = planFiscalDocument({ kind: "REEVALUATE", draft, capture, priced: w.quote.tax, saleProfile: saleProfileAt([unknown], taxPoint), issuer: w.issuer, invoice: null });
  assert.deepEqual(stillUnknown, { kind: "NONE", reason: "UNCHANGED" });
  const chosen = saleProfileAt([unknown, review], taxPoint);
  assert.equal(chosen?.profileId, review.profileId, "a later review whose validity reaches back to the sale resolves its unknown treatment");
  const repointed = planFiscalDocument({ kind: "REEVALUATE", draft, capture, priced: w.quote.tax, saleProfile: chosen, issuer: w.issuer, invoice: null });
  assert.ok(repointed.kind === "REDRAFT" && repointed.validate && repointed.change.fiscalProfileId === review.profileId && repointed.change.blockedReason === null && repointed.change.taxCents === capture.allocation.taxCents);
  // a draft under the sale's known treatment is never re-pointed at a later version: saleProfileAt keeps the version current then
  const known: FiscalProfileRecord = { ...w.profile, profileId: w.ids.next() as never, validFrom: before, recordedAt: before, supersededAt: after };
  const retroactive: FiscalProfileRecord = { ...w.profile, profileId: w.ids.next() as never, taxRateBps: 1600, validFrom: before, recordedAt: after, supersedesProfileId: known.profileId };
  assert.equal(saleProfileAt([known, retroactive], taxPoint)?.profileId, known.profileId);
  const blockedByIssuer: TaxDocumentRecord = { ...draft, fiscalProfileId: known.profileId, taxTreatment: "DOMESTIC_TAXABLE", blockedReason: "ISSUER_FACTS_UNCONFIRMED" };
  assert.deepEqual(planFiscalDocument({ kind: "REEVALUATE", draft: blockedByIssuer, capture, priced: w.quote.tax, saleProfile: saleProfileAt([known, retroactive], taxPoint), issuer: null, invoice: null }), { kind: "NONE", reason: "UNCHANGED" });
  const confirmed = planFiscalDocument({ kind: "REEVALUATE", draft: blockedByIssuer, capture, priced: w.quote.tax, saleProfile: saleProfileAt([known, retroactive], taxPoint), issuer: w.issuer, invoice: null });
  assert.ok(confirmed.kind === "REDRAFT" && confirmed.validate && confirmed.change.fiscalProfileId === known.profileId && confirmed.change.blockedReason === null, "the issuer's confirmed facts unblock the draft under its own version");
  // an unblocked draft left in DRAFT validates without a re-draft
  const unblocked: TaxDocumentRecord = { ...draft, fiscalProfileId: known.profileId, taxTreatment: "DOMESTIC_TAXABLE" };
  delete (unblocked as { blockedReason?: string }).blockedReason;
  assert.deepEqual(planFiscalDocument({ kind: "REEVALUATE", draft: unblocked, capture, priced: w.quote.tax, saleProfile: known, issuer: w.issuer, invoice: null }), { kind: "VALIDATE", documentId: draft.documentId, expectedVersion: 1 });
});

// --- nextProtocolStep ---------------------------------------------------------------------------------------------------------------

test("nextProtocolStep — the resume table of §6.1: PREPARED claims, a dispatched, pending or uncertain attempt is observed (never dispatched again), a creation that proved no effect with attempts left takes a new deliberate attempt, everything else completes the journal", () => {
  const step = (state: Parameters<typeof nextProtocolStep>[0]["attempt"]["state"], effect: "CREATE_ORDER" | "CAPTURE" | "REFUND" = "CREATE_ORDER", aggregateState: Parameters<typeof nextProtocolStep>[0]["aggregateState"] = "CREATING", ordinal = 1) =>
    nextProtocolStep({ effect, attempt: { state, ordinal }, aggregateState, maxAttempts: 3 });
  assert.deepEqual(step("PREPARED"), { kind: "CLAIM" });
  for (const s of ["DISPATCHING", "PROVIDER_PENDING", "UNCERTAIN"] as const) assert.deepEqual(step(s), { kind: "OBSERVE" }, s);
  assert.deepEqual(step("FAILED_NO_EFFECT"), { kind: "NEW_ATTEMPT", ordinal: 2 });
  assert.deepEqual(step("FAILED_NO_EFFECT", "CREATE_ORDER", "CREATING", 3), { kind: "COMPLETE" }, "the attempts are spent (D-PROTO-B3)");
  assert.deepEqual(step("FAILED_NO_EFFECT", "CREATE_ORDER", "FAILED", 3), { kind: "COMPLETE" });
  assert.deepEqual(step("FAILED_NO_EFFECT", "CAPTURE", "APPROVED"), { kind: "COMPLETE" }, "a capture's new attempt is the agency's deliberate command");
  assert.deepEqual(step("FAILED_NO_EFFECT", "REFUND", "APPROVED"), { kind: "COMPLETE" }, "a refund's new attempt is the refund executor's");
  for (const s of ["CONFIRMED", "CANCELLED_BEFORE_DISPATCH"] as const) assert.deepEqual(step(s), { kind: "COMPLETE" }, s);
  // the request hash the protocol checks at the claim is the digest of the exact prepared request
  assert.match(providerRequestHash({ method: "POST", endpointProfile: "ORDERS_V2_CAPTURE", body: {}, headers: {}, credentialRef: "x" }), /^[0-9a-f]{64}$/);
});
