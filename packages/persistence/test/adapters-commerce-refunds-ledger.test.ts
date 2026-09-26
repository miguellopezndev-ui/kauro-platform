// Refunds, cases, fiscal documents, the ledger, settlements and the payment inbox on real PostgreSQL 17 through the runtime logins
// (package B09, implementation mandate M1; design §4.4, §4.5, §6.2, §8.1, D-REF-B1..B6, D-LEDGER-B1..B5, D-FISC-B4..B6, D-ING-B1,
// D-BIND-B2): every write through the commerce unit of work, each version published with the event commerceVersionEventType names and
// its outbox records addressed to that type's subscribers; the approval-versus-reversal race and the completion-versus-funds ordering
// observed waiting in pg_stat_activity (hold points, no sleeps); a replayed ledger post that writes nothing.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  capturePostings,
  toUtcInstant,
  type AgencyId,
  type CaptureId,
  type CommerceUnitOfWork,
  type CommercialAuthorizationId,
  type EventId,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type InboxId,
  type PaymentAttemptId,
  type PaymentOrderId,
  type PaymentRouteId,
  type ProjectId,
  type ReconciliationCaseId,
  type RefundId,
  type SettlementId,
  type TaxDocumentId,
} from "@kauro/domain";
import { barrier, clock, ids, sha, waitForLockWait } from "../src/testing/harness.js";
import { assertVersionEvents, closeCommerceEnv, failure, openCommerceEnv, paid, type CommerceEnv } from "./commerce-adapter-support.js";
import { ENVIRONMENT, PROVIDER, activateAgency, approveRefund, approvedSubject, createdOrder, fiscalProfile, issuedQuote, observedCapture, requestRefund, type OrderFixture } from "./commerce-support.js";
import { project } from "./support.js";

let env: CommerceEnv;

before(async () => {
  env = await openCommerceEnv("refunds");
});
after(async () => {
  await closeCommerceEnv(env);
});

type Sale = Awaited<ReturnType<typeof paid>>;

async function adopted<T>(orderId: string, work: (uow: CommerceUnitOfWork) => Promise<T>): Promise<T> {
  return env.h.commerce.run(env.h.service(), async (uow) => {
    assert.ok(await uow.adoptScope("PAYMENT_ORDER", orderId));
    return work(uow);
  });
}

async function completionOf(captureId: string): Promise<EventId> {
  return (await env.h.oracle.query<{ event_id: EventId }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_kind = 'capture' AND aggregate_id = $1 AND event_type = 'capture.completed.v1'", [captureId])).rows[0]!.event_id;
}

/** CMD033's T1 and T2 through the adapters: the REFUND attempt PREPARED, the refund SUBMITTING, the attempt claimed. */
async function submitting(sale: Sale, refundId: RefundId, approvedVersion = 2): Promise<PaymentAttemptId> {
  return adopted(sale.order.orderId, async (uow) => {
    const attemptId = uow.ids.next() as PaymentAttemptId;
    const now = clock.now();
    await uow.commerce.attempts.prepare({ attemptId, agencyId: env.A.agencyId, orderId: sale.order.orderId as PaymentOrderId, refundId, operation: "REFUND", ordinal: 1, provider: PROVIDER, environment: ENVIRONMENT, requestHash: sha(`refund-${refundId}`), providerRequestId: `kauro-${attemptId}`, startedAt: now });
    assert.equal((await uow.commerce.refunds.transition(refundId, approvedVersion, { state: "SUBMITTING" }, now)).kind, "APPLIED");
    assert.equal((await uow.commerce.attempts.transition(attemptId, 1, { state: "DISPATCHING", lastObservedAt: now }, now)).kind, "APPLIED");
    return attemptId;
  });
}

/** CMD033's T3: the provider's authenticated completion of the refund under the attempt's identity. */
async function completeRefund(uow: CommerceUnitOfWork, refundId: RefundId, attemptId: PaymentAttemptId, version: number) {
  const now = clock.now();
  assert.equal((await uow.commerce.attempts.transition(attemptId, 2, { state: "CONFIRMED", lastObservedAt: now, evidenceHash: sha(`refund-evidence-${refundId}`) }, now)).kind, "APPLIED");
  return uow.commerce.refunds.transition(refundId, version, { state: "COMPLETED", providerRefundId: `RF-${refundId.slice(-12)}`, evidenceHash: sha(`refund-evidence-${refundId}`), completedAt: now }, now);
}

test("refunds through the adapters: the agency's request (refund.requested.v1 to NOTIFICATIONS, the reason kept on the row and out of the payload), the reconciler's server request filed once per capture and origin with ON CONFLICT DO NOTHING (a repetition answers the open request and publishes nothing), the corporate owner's approval with its immutable intent (refund.approved.v1 to PAYMENT_SERVICE) and rejection, and the payment service's execution to COMPLETED — refund.completed.v1 names the funds state read under the capture's share lock and the capture's remaining service basis", async () => {
  const { h, A } = env;
  const sale = await paid(env, A, "refund-lifecycle");
  const captureId = sale.captureId as CaptureId;
  const orderId = sale.order.orderId as PaymentOrderId;
  const customer = ids.next() as RefundId;
  const reason = "Client cancelled before execution";
  const requested = await h.commerce.run(h.tenant(A.agencyId, A.ownerUserId), async (uow) => {
    const now = clock.now();
    const record = await uow.commerce.refunds.request({
      refundId: customer, agencyId: A.agencyId, projectId: sale.order.quote.projectId as ProjectId, orderId, captureId, origin: "CUSTOMER_REQUEST", reasonCode: reason, evidenceRef: ids.next() as never,
      termsHash: sale.order.quote.termsHash, deliveryPhase: "PRE_EXECUTION", proposed: { serviceCents: 1000n, taxCents: 0n, excessCents: 0n }, requestedByMembershipId: A.ownerMembershipId, requestedByUserId: A.ownerUserId, requestedAt: now,
    });
    await uow.scopes.record({ kind: "REFUND", key: customer, agencyId: A.agencyId, orderId, refundId: customer }, now);
    return { record, events: [...uow.events.appended], open: await uow.commerce.refunds.findOpenForCapture(captureId, "CUSTOMER_REQUEST") };
  });
  assert.deepEqual([requested.record.state, requested.record.reasonCode, requested.open?.refundId], ["REQUESTED", reason, customer]);
  await assertVersionEvents(h, requested.events, [["refund", customer, 1, { previousState: null, state: "REQUESTED" }]]);
  assert.ok(!Object.values(requested.events[0]!.payload).includes(reason), "the reason, a label, never enters the payload");

  // the reconciler's KAURO_REMEDY request: filed once; a repetition answers the open request and publishes nothing
  const remedy = await adopted(orderId, async (uow) => {
    const request = (refundId: RefundId) => ({
      refundId, agencyId: A.agencyId, projectId: sale.order.quote.projectId as ProjectId, orderId, captureId, origin: "KAURO_REMEDY" as const, reasonCode: "KAURO_REMEDY",
      termsHash: sale.order.quote.termsHash, deliveryPhase: "PRE_EXECUTION" as const, proposed: { serviceCents: 96125n, taxCents: 0n, excessCents: 0n }, requestedAt: clock.now(),
    });
    const filed = await uow.commerce.refunds.fileServerRequest(request(uow.ids.next() as RefundId));
    await uow.scopes.record({ kind: "REFUND", key: filed.record.refundId, agencyId: A.agencyId, orderId, refundId: filed.record.refundId }, clock.now());
    const again = await uow.commerce.refunds.fileServerRequest(request(uow.ids.next() as RefundId));
    return { filed, again, events: [...uow.events.appended] };
  });
  assert.deepEqual([remedy.filed.filed, remedy.again.filed, remedy.again.record.refundId], [true, false, remedy.filed.record.refundId]);
  await assertVersionEvents(h, remedy.events, [["refund", remedy.filed.record.refundId, 1, { previousState: null, state: "REQUESTED" }]]);

  // the corporate owner reviews in the finance scope it adopted through the refund: approves the customer's, rejects the remedy
  const proof = await h.recordStepUp(env.kora);
  const approved = await h.commerce.run(h.operator(env.kora), async (uow) => {
    assert.equal(await uow.adoptScope("REFUND", customer), A.agencyId);
    const now = clock.now();
    const outcome = await uow.commerce.refunds.approve(
      customer,
      1,
      { amounts: { serviceCents: 1000n, taxCents: 0n, excessCents: 0n }, authorizationKind: "OWNER_STEP_UP", authorizationProofRef: proof, authorizationHash: sha(`authorization-${customer}`), effectsHash: sha(`effects-${customer}`), creditNoteRequired: true, approvedByUserId: env.kora, approvedAt: now },
      now,
    );
    return { outcome, events: [...uow.events.appended] };
  });
  assert.equal(approved.outcome.kind === "APPLIED" ? approved.outcome.record.approved?.amounts.serviceCents : null, 1000n);
  await assertVersionEvents(h, approved.events, [["refund", customer, 2, { previousState: "REQUESTED", state: "APPROVED" }]]);
  assert.deepEqual([approved.events[0]!.payload["serviceCents"], approved.events[0]!.payload["authorizationKind"], approved.events[0]!.payload["creditNoteRequired"]], [1000, "OWNER_STEP_UP", true]);
  const rejected = await h.commerce.run(h.operator(env.kora), async (uow) => {
    await uow.adoptScope("REFUND", remedy.filed.record.refundId);
    const outcome = await uow.commerce.refunds.transition(remedy.filed.record.refundId, 1, { state: "REJECTED", rejected: { code: "REMEDY_NOT_WARRANTED", byUserId: env.kora, at: clock.now() } }, clock.now());
    return { outcome, events: [...uow.events.appended] };
  });
  assert.equal(rejected.outcome.kind === "APPLIED" ? rejected.outcome.record.rejected?.code : null, "REMEDY_NOT_WARRANTED");
  await assertVersionEvents(h, rejected.events, [["refund", remedy.filed.record.refundId, 2, { previousState: "REQUESTED", state: "REJECTED" }]]);

  // the payment service executes the approved refund: SUBMITTING, then the provider's completion
  const attemptId = await submitting(sale, customer);
  const completed = await adopted(orderId, async (uow) => {
    const outcome = await completeRefund(uow, customer, attemptId, 3);
    return { outcome, events: [...uow.events.appended], committed: await uow.commerce.captures.committedRefunds(captureId), listed: await uow.commerce.refunds.listForCapture(captureId), live: await uow.commerce.attempts.findLive({ refundId: customer }), count: await uow.commerce.attempts.countFor({ refundId: customer }) };
  });
  await assertVersionEvents(h, completed.events, [
    ["payment_attempt", attemptId, 3, { previousState: "DISPATCHING", state: "CONFIRMED" }],
    ["refund", customer, 4, { previousState: "SUBMITTING", state: "COMPLETED" }],
  ]);
  const p = completed.events[1]!.payload;
  assert.deepEqual([p["serviceCents"], p["taxCents"], p["excessCents"], p["serviceBasisAfterCents"], p["fundsState"], p["previousState"]], [1000, 0, 0, 96125, "UNKNOWN", "SUBMITTING"]);
  assert.deepEqual(completed.committed, { serviceCents: 1000n, taxCents: 0n, excessCents: 0n });
  assert.deepEqual([completed.listed.map((r) => r.state).sort(), completed.live, completed.count], [["COMPLETED", "REJECTED"], null, 1]);
});

test("the approval-versus-reversal race: an approval of a refund waits, observed in pg_stat_activity, for the reversal of its capture that the payment service holds open, then sees it and is refused PRECONDITION_FAILED REFUND_EXCEEDS_REMAINING; the refund stays REQUESTED at version 1 and publishes nothing", async () => {
  const { h, A } = env;
  const sale = await paid(env, A, "approval-race");
  const refundId = (await requestRefund(env.app, A, sale.order, sale.captureId, { serviceCents: 97125, taxCents: 0 })) as RefundId;
  const proof = await h.recordStepUp(env.kora);
  const hold = barrier();
  const reversedInFlight = barrier();
  const reversal = adopted(sale.order.orderId, async (uow) => {
    const now = clock.now();
    assert.equal((await uow.commerce.captures.advance(sale.captureId as CaptureId, 1, { status: "REVERSED", observedAt: now, evidenceHash: sha(`chargeback-${sale.captureId}`) }, now)).kind, "APPLIED");
    assert.equal((await uow.commerce.authorizations.transition(sale.authorizationId as CommercialAuthorizationId, 1, { state: "REVOKED", revocation: { at: now, phase: "PRE_EXECUTION", code: "CAPTURE_REVERSED" } }, now)).kind, "APPLIED");
    reversedInFlight.open();
    await hold.wait;
  });
  await reversedInFlight.wait;
  const approval = h.commerce.run(h.operator(env.kora), async (uow) => {
    await uow.adoptScope("REFUND", refundId);
    const now = clock.now();
    return uow.commerce.refunds.approve(
      refundId,
      1,
      { amounts: { serviceCents: 97125n, taxCents: 0n, excessCents: 0n }, authorizationKind: "OWNER_STEP_UP", authorizationProofRef: proof, authorizationHash: sha(`authorization-${refundId}`), effectsHash: sha(`effects-${refundId}`), creditNoteRequired: true, approvedByUserId: env.kora, approvedAt: now },
      now,
    );
  });
  const observed = approval.then(
    () => ({ settled: "fulfilled" as const, reason: null }),
    (reason: unknown) => ({ settled: "rejected" as const, reason }),
  );
  await waitForLockWait(h.oracle, "kauro-test-api", "UPDATE kauro.refunds AS t");
  hold.open();
  await reversal;
  const outcome = await observed;
  assert.equal(outcome.settled, "rejected");
  assert.deepEqual([failure(outcome.reason).code, failure(outcome.reason).details.reason], ["PRECONDITION_FAILED", "REFUND_EXCEEDS_REMAINING"]);
  const refund = await h.oracle.query("SELECT state, version FROM kauro.refunds WHERE refund_id = $1", [refundId]);
  assert.deepEqual(refund.rows, [{ state: "REQUESTED", version: "1" }]);
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'refund.approved.v1'", [refundId])).rows[0].n, 0);
});

test("a refund's completion and a funds observation of its capture are ordered by the capture's row: the completion holds the row's share lock, the funds observation waits for it (pg_stat_activity) and then moves the movable balance net of the money the refund returned; the completion names the funds state it saw", async () => {
  const { h, A } = env;
  const sale = await paid(env, A, "funds-order");
  const refundId = (await requestRefund(env.app, A, sale.order, sale.captureId, { serviceCents: 1000, taxCents: 0 })) as RefundId;
  await approveRefund(env.app, env.assurance, env.kora, A, refundId, { serviceCents: 1000, taxCents: 0 });
  const attemptId = await submitting(sale, refundId);
  const hold = barrier();
  const completedInFlight = barrier();
  const completion = adopted(sale.order.orderId, async (uow) => {
    const r = await completeRefund(uow, refundId, attemptId, 3);
    completedInFlight.open();
    await hold.wait;
    return { r, events: [...uow.events.appended] };
  });
  await completedInFlight.wait;
  const funds = adopted(sale.order.orderId, async (uow) => {
    const r = await uow.commerce.captures.observeFunds(sale.captureId as CaptureId, 1, { fundsState: "HELD", observedAt: clock.now(), evidenceHash: sha(`held-${sale.captureId}`) }, clock.now());
    return { r, events: [...uow.events.appended] };
  });
  await waitForLockWait(h.oracle, "kauro-test-payment", "FROM kauro.capture_facts WHERE capture_id = $1 FOR UPDATE");
  hold.open();
  const [done, held] = await Promise.all([completion, funds]);
  assert.equal(done.events.find((e) => e.eventType === "refund.completed.v1")?.payload["fundsState"], "UNKNOWN", "the completion took its money from the balance it saw");
  await assertVersionEvents(h, held.events, [["capture", sale.captureId, 2, { previousState: "COMPLETED", state: "COMPLETED", fundsChanged: true }]]);
  assert.deepEqual([held.events[0]!.payload["amountCents"], held.events[0]!.payload["fundsState"]], [96125, "HELD"], "97125 less the 1000 the refund returned");
});

test("the ledger: a posting set is balanced in code and at COMMIT; a replayed post of the same source writes nothing and answers the entries already posted; a concurrent replay waits for the first poster on the source's index and then answers the same set; a set naming another aggregate than its source event's is refused KP001; a settlement's set is platform-level; the entries are listed by source", async () => {
  const { h, A } = env;
  const sale = await paid(env, A, "ledger");
  const completion = await completionOf(sale.captureId);
  const captureSet = (eventId: EventId, sourceRef: string) => ({
    agencyId: A.agencyId as AgencyId | null, source: { kind: "EVENT" as const, eventId }, sourceKind: "CAPTURE" as const, sourceRef, currency: "USD", effectiveAt: clock.now(), observedAt: clock.now(),
    evidenceHash: sha(`capture-set-${eventId}`), lines: capturePostings({ serviceCents: 97125n, taxCents: 0n, excessCents: 0n }),
  });
  const first = await adopted(sale.order.orderId, (uow) => uow.commerce.ledger.post(captureSet(completion, sale.captureId), clock.now()));
  const replay = await adopted(sale.order.orderId, (uow) => uow.commerce.ledger.post(captureSet(completion, sale.captureId), clock.now()));
  assert.deepEqual([first.posted, replay.posted], [true, false]);
  assert.deepEqual(replay.entries.map((e) => e.entryId), first.entries.map((e) => e.entryId), "the replay answers the entries already posted");
  assert.deepEqual(first.entries.map((e) => [e.lineNo, e.accountCode, e.direction, e.amountCents, e.eventId, e.sourceRef]), [
    [1, "PSP_RECEIVABLE", "DEBIT", 97125n, completion, sale.captureId],
    [2, "CONTRACT_LIABILITY", "CREDIT", 97125n, completion, sale.captureId],
  ]);
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.ledger_entries WHERE event_id = $1", [completion])).rows[0].n, 2);
  // an unbalanced set never reaches the database; a set attributed to another aggregate than its event's is refused there (KP001)
  await assert.rejects(adopted(sale.order.orderId, (uow) => uow.commerce.ledger.post({ ...captureSet(completion, sale.captureId), lines: [{ account: "PSP_RECEIVABLE", direction: "DEBIT", amountCents: 1n }] }, clock.now())), (e: unknown) => failure(e).details.reason === "LEDGER_UNBALANCED");
  const other = await paid(env, A, "ledger-other");
  await assert.rejects(adopted(other.order.orderId, async (uow) => uow.commerce.ledger.post(captureSet(await completionOf(other.captureId), other.order.orderId), clock.now())), (e: unknown) => failure(e).code === "INTEGRITY_FAILURE" && failure(e).details.reason === "LEDGER_UNBALANCED");
  // a concurrent replay: the second poster waits on the source's index for the first, then answers its set
  const otherCompletion = await completionOf(other.captureId);
  const hold = barrier();
  const postedInFlight = barrier();
  const poster = adopted(other.order.orderId, async (uow) => {
    const r = await uow.commerce.ledger.post(captureSet(otherCompletion, other.captureId), clock.now());
    postedInFlight.open();
    await hold.wait;
    return r;
  });
  await postedInFlight.wait;
  const replayer = adopted(other.order.orderId, (uow) => uow.commerce.ledger.post(captureSet(otherCompletion, other.captureId), clock.now()));
  await waitForLockWait(h.oracle, "kauro-test-payment", "INSERT INTO kauro.ledger_entries");
  hold.open();
  const [won, waited] = await Promise.all([poster, replayer]);
  assert.deepEqual([won.posted, waited.posted], [true, false]);
  assert.deepEqual(waited.entries.map((e) => e.entryId), won.entries.map((e) => e.entryId));
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.ledger_entries WHERE event_id = $1", [otherCompletion])).rows[0].n, 2);
  // a settlement observation (platform-level, no agency adopted) with bank evidence sources the bank's set
  const settlementId = ids.next() as SettlementId;
  const settled = await h.commerce.run(h.service(), async (uow) => {
    const now = clock.now();
    const recorded = await uow.commerce.settlements.record({
      settlementId, routeId: env.routes.routeId as PaymentRouteId, providerBalanceRef: ids.next(), currency: "USD", grossCents: 97125n, feeCents: 0n, heldCents: 0n, withdrawnCents: 97125n, bankAvailableCents: 97125n,
      bankEvidenceHash: sha("bank-statement"), fxRate: "1.0000", periodStart: toUtcInstant(Date.now() - 86_400_000), periodEnd: now, observedAt: now, evidenceHash: sha("settlement"),
    });
    const posted = await uow.commerce.ledger.post({ agencyId: null, source: { kind: "SETTLEMENT", settlementId }, sourceKind: "SETTLEMENT", sourceRef: settlementId, currency: "USD", effectiveAt: now, observedAt: now, evidenceHash: sha("settlement-posting"), lines: [{ account: "BANK_CASH", direction: "DEBIT", amountCents: 97125n }, { account: "PSP_AVAILABLE", direction: "CREDIT", amountCents: 97125n }] }, now);
    return { recorded, posted, latest: await uow.commerce.settlements.latest(env.routes.routeId as PaymentRouteId) };
  });
  assert.deepEqual([settled.recorded.bankAvailableCents, settled.recorded.fxRate, settled.latest?.settlementId, settled.posted.posted], [97125n, "1.0000", settlementId, true]);
  assert.deepEqual(settled.posted.entries.map((e) => [e.agencyId, e.eventId, e.settlementId]), [[null, null, settlementId], [null, null, settlementId]]);
  const listed = await adopted(sale.order.orderId, (uow) => uow.commerce.ledger.listForSource("CAPTURE", sale.captureId));
  assert.deepEqual(listed.map((e) => e.entryId), first.entries.map((e) => e.entryId));
});

test("reconciliation cases open once per kind and subject: a repeated opening answers the open case and publishes nothing; the finance scope's owner resolves it (reconciliation_case.resolved.v1 to FINANCE, resolved by the session's own person) and a stale resolution answers STALE; a case whose capture is not its order's is refused as an integrity failure (D-BIND-B2)", async () => {
  const { h, A } = env;
  const sale = await paid(env, A, "cases");
  const other = await paid(env, A, "cases-other");
  const orderId = sale.order.orderId as PaymentOrderId;
  const entry = (caseId: ReconciliationCaseId, captureId = sale.captureId) => ({ caseId, agencyId: A.agencyId, orderId, captureId: captureId as CaptureId, kind: "AMOUNT_MISMATCH" as const, detailCode: "PARTIAL_CAPTURE", amountCents: 100n, currency: "USD", evidenceHash: sha(`case-${caseId}`), openedAt: clock.now() });
  const caseId = ids.next() as ReconciliationCaseId;
  const opened = await adopted(orderId, async (uow) => {
    const first = await uow.commerce.cases.open(entry(caseId));
    const again = await uow.commerce.cases.open(entry(uow.ids.next() as ReconciliationCaseId));
    return { first, again, events: [...uow.events.appended], open: await uow.commerce.cases.listOpenForOrder(orderId) };
  });
  assert.deepEqual([opened.first.opened, opened.again.opened, opened.again.record.caseId, opened.open.map((c) => c.caseId)], [true, false, caseId, [caseId]]);
  await assertVersionEvents(h, opened.events, [["reconciliation_case", caseId, 1, { previousState: null, state: "OPEN" }]]);
  assert.deepEqual([opened.events[0]!.payload["kind"], opened.events[0]!.payload["amountCents"]], ["AMOUNT_MISMATCH", 100]);
  const resolved = await h.commerce.run(h.operator(env.kora), async (uow) => {
    await uow.adoptFinanceScope(A.agencyId);
    const outcome = await uow.commerce.cases.resolve(caseId, 1, "PROVIDER_CONFIRMED_PARTIAL", clock.now());
    const stale = await uow.commerce.cases.resolve(caseId, 1, "PROVIDER_CONFIRMED_PARTIAL", clock.now());
    return { outcome, stale, events: [...uow.events.appended] };
  });
  assert.equal(resolved.outcome.kind === "APPLIED" ? resolved.outcome.record.resolutionCode : null, "PROVIDER_CONFIRMED_PARTIAL");
  assert.deepEqual(resolved.stale, { kind: "STALE", currentVersion: 2, currentState: "RESOLVED" });
  await assertVersionEvents(h, resolved.events, [["reconciliation_case", caseId, 2, { previousState: "OPEN", state: "RESOLVED" }]]);
  assert.equal((await h.oracle.query("SELECT resolved_by_user_id FROM kauro.reconciliation_cases WHERE case_id = $1", [caseId])).rows[0].resolved_by_user_id, env.kora);
  assert.deepEqual(await adopted(orderId, (uow) => uow.commerce.cases.listOpenForOrder(orderId)), []);
  await assert.rejects(adopted(orderId, (uow) => uow.commerce.cases.open(entry(ids.next() as ReconciliationCaseId, other.captureId))), (e: unknown) => failure(e).code === "INTEGRITY_FAILURE");
});

test("fiscal documents: the drafter reads the sale's profile version at the capture's completion (saleProfileAt keeps the reviewed version current then, whatever was recorded later), a blocked draft is listed and re-drafted under the reviewed version (tax_document.drafted.v1 again), validated with the database's re-check and issued; a credit note of a completed refund carries the invoice's snapshot, is found by its refund and validates against the ISSUED invoice", async () => {
  const { h } = env;
  const E = await h.createAgency(await h.person("ernesto-fiscal"), "Fiscal E");
  await activateAgency(env.app, E);
  const clientE = await h.endClient(E, await h.processingAuthority(E), "Client E");
  const e1 = await fiscalProfile(env.app, env.kora, E, env.routes.issuerRef, "EXEMPT_EXPORT");
  const { projectId } = await project(env.app, E, clientE, env.hubspot, "HUBSPOT");
  const subject = await approvedSubject(env.app, env.validator, env.assurance, E, projectId, "fiscal-docs");
  const quote = await issuedQuote(env.app, E, subject, e1, env.routes.issuerRef);
  const order: OrderFixture = await createdOrder(env.app, E, quote, env.routes, { payment: env.payment });
  const { captureId } = await observedCapture(env.payment, E, order, env.routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, env.hubspot);
  // the treatment is re-reviewed after the sale: the explicit unknown is now current
  const e2 = await fiscalProfile(env.app, env.kora, E, env.routes.issuerRef, "REVIEW_REQUIRED", e1);
  const inE = <T>(work: (uow: CommerceUnitOfWork) => Promise<T>) =>
    h.commerce.run(h.service(), async (uow) => {
      assert.equal(await uow.adoptScope("PAYMENT_ORDER", order.orderId), E.agencyId);
      return work(uow);
    });
  const invoiceId = ids.next() as TaxDocumentId;
  const drafted = await inE(async (uow) => {
    const capture = await uow.commerce.captures.get(captureId as CaptureId);
    const saleVersion = await uow.commerce.fiscal.saleProfileAt(E.agencyId, capture!.providerCompletedAt!);
    const current = await uow.commerce.fiscal.currentProfile(E.agencyId);
    // a draft under the unknown is blocked with its concrete blocker (as a drafter that read the current version would leave it)
    const blocked = await uow.commerce.taxDocuments.draft({ documentId: invoiceId, agencyId: E.agencyId, orderId: order.orderId as PaymentOrderId, captureId: captureId as CaptureId, kind: "INVOICE", fiscalProfileId: e2 as FiscalProfileId, issuerRef: env.routes.issuerRef as FiscalIssuerRef, taxTreatment: "REVIEW_REQUIRED", serviceCents: 97125n, taxCents: 0n, blockedReason: "FISCAL_TREATMENT_UNREVIEWED", createdAt: clock.now() });
    return { saleVersion, current, blocked, listed: await uow.commerce.taxDocuments.listBlockedDrafts(10), events: [...uow.events.appended] };
  });
  assert.deepEqual([drafted.saleVersion?.profileId, drafted.current?.profileId], [e1, e2], "the sale keeps the reviewed version current at its tax point");
  assert.deepEqual([drafted.blocked.state, drafted.blocked.blockedReason, drafted.listed.map((d) => d.documentId)], ["DRAFT", "FISCAL_TREATMENT_UNREVIEWED", [invoiceId]]);
  await assertVersionEvents(h, drafted.events, [["tax_document", invoiceId, 1, { previousState: null, state: "DRAFT" }]]);
  const validated = await inE(async (uow) => {
    const redraft = await uow.commerce.taxDocuments.redraft(invoiceId, 1, { fiscalProfileId: e1 as FiscalProfileId, issuerRef: env.routes.issuerRef as FiscalIssuerRef, taxTreatment: "EXEMPT_EXPORT", taxCents: 0n, blockedReason: null }, clock.now());
    const valid = await uow.commerce.taxDocuments.transition(invoiceId, 2, { state: "VALIDATED" }, clock.now());
    const submitting = await uow.commerce.taxDocuments.transition(invoiceId, 3, { state: "SUBMITTING", issueRequestHash: sha(`issue-${invoiceId}`) }, clock.now());
    const issued = await uow.commerce.taxDocuments.transition(invoiceId, 4, { state: "ISSUED", providerDocumentId: `DOC-${invoiceId.slice(-12)}`, legalNumber: "SETP-990101", evidenceHash: sha(`issued-${invoiceId}`), issuedAt: clock.now() }, clock.now());
    return { redraft, valid, submitting, issued, events: [...uow.events.appended], live: await uow.commerce.taxDocuments.findLiveInvoice(captureId as CaptureId), blocked: await uow.commerce.taxDocuments.listBlockedDrafts(10) };
  });
  assert.deepEqual([validated.redraft.kind, validated.valid.kind, validated.submitting.kind, validated.issued.kind], ["APPLIED", "APPLIED", "APPLIED", "APPLIED"]);
  assert.deepEqual([validated.live?.state, validated.live?.fiscalProfileId, validated.live?.legalNumber, validated.blocked], ["ISSUED", e1, "SETP-990101", []]);
  await assertVersionEvents(h, validated.events, [
    ["tax_document", invoiceId, 2, { previousState: "DRAFT", state: "DRAFT" }],
    ["tax_document", invoiceId, 3, { previousState: "DRAFT", state: "VALIDATED" }],
    ["tax_document", invoiceId, 4, { previousState: "VALIDATED", state: "SUBMITTING" }],
    ["tax_document", invoiceId, 5, { previousState: "SUBMITTING", state: "ISSUED" }],
  ]);
  // a partial refund completes; its credit note carries exactly the invoice's snapshot and validates against the ISSUED invoice
  const refundId = (await requestRefund(env.app, E, order, captureId, { serviceCents: 1000, taxCents: 0 })) as RefundId;
  await approveRefund(env.app, env.assurance, env.kora, E, refundId, { serviceCents: 1000, taxCents: 0 });
  const attemptId = await h.commerce.run(h.service(), async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", order.orderId);
    const id = uow.ids.next() as PaymentAttemptId;
    const now = clock.now();
    await uow.commerce.attempts.prepare({ attemptId: id, agencyId: E.agencyId, orderId: order.orderId as PaymentOrderId, refundId, operation: "REFUND", ordinal: 1, provider: PROVIDER, environment: ENVIRONMENT, requestHash: sha(`refund-${refundId}`), providerRequestId: `kauro-${id}`, startedAt: now });
    await uow.commerce.refunds.transition(refundId, 2, { state: "SUBMITTING" }, now);
    await uow.commerce.attempts.transition(id, 1, { state: "DISPATCHING", lastObservedAt: now }, now);
    return id;
  });
  const creditNoteId = ids.next() as TaxDocumentId;
  const credited = await inE(async (uow) => {
    assert.equal((await completeRefund(uow, refundId, attemptId, 3)).kind, "APPLIED");
    await uow.commerce.taxDocuments.draft({ documentId: creditNoteId, agencyId: E.agencyId, orderId: order.orderId as PaymentOrderId, captureId: captureId as CaptureId, refundId, kind: "CREDIT_NOTE", fiscalProfileId: e1 as FiscalProfileId, issuerRef: env.routes.issuerRef as FiscalIssuerRef, taxTreatment: "EXEMPT_EXPORT", serviceCents: 1000n, taxCents: 0n, correctsDocumentId: invoiceId, createdAt: clock.now() });
    const valid = await uow.commerce.taxDocuments.transition(creditNoteId, 1, { state: "VALIDATED" }, clock.now());
    return { valid, found: await uow.commerce.taxDocuments.findLiveCreditNote(refundId), locked: await uow.commerce.taxDocuments.lock(creditNoteId) };
  });
  assert.deepEqual([credited.valid.kind, credited.found?.documentId, credited.found?.correctsDocumentId, credited.locked?.state], ["APPLIED", creditNoteId, invoiceId, "VALIDATED"]);
  assert.equal(credited.found?.agencyId, E.agencyId);
});

test("the payment inbox: the payment service locks a provider's record for apply and settles it APPLIED with its result event, once — a settled record stays settled (KA007) — a record with a conflicting body is never APPLIED (KA012), only rejected, and another provider's record is not the payment service's", async () => {
  const { h, A } = env;
  const sale = await paid(env, A, "inbox");
  const resultEventId = await completionOf(sale.captureId);
  const deliver = async (inboxId: InboxId, body: string, provider = PROVIDER) => h.inboxIngress.record({ inboxId, provider, environment: ENVIRONMENT, externalEventId: `evt-${inboxId}`, bodyHash: sha(body), receivedAt: clock.now() });
  const first = ids.next() as InboxId;
  assert.equal((await deliver(first, "body-1")).kind, "RECORDED");
  const applied = await h.commerce.run(h.service(), async (uow) => {
    const locked = await uow.commerce.inbox.lockForApply(first);
    const settled = await uow.commerce.inbox.settle(first, { state: "APPLIED", resultEventId }, clock.now());
    return { locked, settled };
  });
  assert.deepEqual([applied.locked?.state, applied.locked?.conflictingBodies, applied.settled.state, applied.settled.resultEventId, applied.settled.appliedAt !== undefined], ["RECEIVED", 0, "APPLIED", resultEventId, true]);
  await assert.rejects(h.commerce.run(h.service(), (uow) => uow.commerce.inbox.settle(first, { state: "IGNORED" }, clock.now())), (e: unknown) => failure(e).code === "PRECONDITION_FAILED" && failure(e).details.reason === "UNLISTED_TRANSITION");
  const conflicted = ids.next() as InboxId;
  assert.equal((await deliver(conflicted, "body-2")).kind, "RECORDED");
  assert.equal((await h.inboxIngress.record({ inboxId: ids.next() as InboxId, provider: PROVIDER, environment: ENVIRONMENT, externalEventId: `evt-${conflicted}`, bodyHash: sha("another body"), receivedAt: clock.now() })).kind, "BODY_CONFLICT");
  const locked = await h.commerce.run(h.service(), (uow) => uow.commerce.inbox.lockForApply(conflicted));
  assert.equal(locked?.conflictingBodies, 1);
  await assert.rejects(h.commerce.run(h.service(), (uow) => uow.commerce.inbox.settle(conflicted, { state: "APPLIED", resultEventId }, clock.now())), (e: unknown) => failure(e).details.reason === "INBOX_BODY_CONFLICT");
  const rejected = await h.commerce.run(h.service(), (uow) => uow.commerce.inbox.settle(conflicted, { state: "REJECTED" }, clock.now()));
  assert.deepEqual([rejected.state, rejected.appliedAt], ["REJECTED", undefined]);
  const foreign = ids.next() as InboxId;
  assert.equal((await deliver(foreign, "body-3", "other-provider")).kind, "RECORDED");
  assert.deepEqual(await h.commerce.run(h.service(), async (uow) => [await uow.commerce.inbox.lockForApply(foreign), await uow.commerce.inbox.lockForApply(ids.next() as InboxId)]), [null, null]);
});
