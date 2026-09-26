// The checkout adapters on real PostgreSQL 17 through the runtime logins (package B09, implementation mandate M1; design §4.2, §4.3,
// §6.1, §6.3, D-PROTO-B1..B6, D-INIT-B1, D-PAY-B5, D-EVT-B2, D-EVT-B3, D-LEDGER-B5, D-QUOTE-B6, D-FISC-B6): quotes, orders, attempts,
// captures, observations, exceptions, authorizations and re-bindings through the commerce unit of work, each version published with
// the event commerceVersionEventType names and its outbox records addressed to exactly that type's subscribers; a compare-and-swap
// loser answered STALE; an out-of-order reversal posted CAPTURE then CHARGEBACK; the platform's configuration read after its locks.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  capturePostings,
  paymentIntentHash,
  providerScopeKey,
  returnPostings,
  toUtcInstant,
  type AgencyId,
  type ApprovalId,
  type CapabilityId,
  type CaptureId,
  type CommerceUnitOfWork,
  type CommercialAuthorizationId,
  type EligibilitySnapshotId,
  type EventId,
  type EvidenceArtifactRef,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type FundsState,
  type InboxId,
  type JournalEntryId,
  type MembershipId,
  type PaymentAttemptId,
  type PaymentOrderId,
  type PlanId,
  type ProjectId,
  type PurchaseRebindingId,
  type QuoteId,
  type RefundPolicyId,
  type UserId,
} from "@kauro/domain";
import type { UtcInstant } from "@kauro/contracts";
import { barrier, clock, ids, sha, waitForLockWait } from "../src/testing/harness.js";
import { assertVersionEvents, closeCommerceEnv, failure, openCommerceEnv, paid, quoted, type CommerceEnv } from "./commerce-adapter-support.js";
import { ENVIRONMENT, PROVIDER, approvedSubject, createdOrder, issuedQuote, replacementSource, type OrderFixture, type QuoteFixture } from "./commerce-support.js";
import { project } from "./support.js";

let env: CommerceEnv;

before(async () => {
  env = await openCommerceEnv("checkout");
});
after(async () => {
  await closeCommerceEnv(env);
});

const HOUR = 3_600_000;
const instantAt = (offsetMs: number): UtcInstant => toUtcInstant(Date.now() + offsetMs);
const tenantOf = (ag: CommerceEnv["A"]) => env.h.tenant(ag.agencyId, ag.ownerUserId);

/** T1 of CreatePaymentOrder through the adapters: the journal entry, the quote's acceptance, the order, its first attempt, its scope row. */
async function intent(quote: QuoteFixture): Promise<{ readonly entryId: JournalEntryId; readonly orderId: PaymentOrderId; readonly attemptId: PaymentAttemptId; readonly events: ReadonlyArray<import("@kauro/domain").DomainEventRecord> }> {
  const { h, A } = env;
  return h.commerce.run(tenantOf(A), async (uow) => {
    const r = await uow.journal.reserve({ environment: "LOCAL", actor: { kind: "USER", userId: A.ownerUserId }, agencyId: A.agencyId, operation: "CMD028", key: `k_intent_${ids.next().replace(/-/g, "")}` }, sha(`intent-${quote.quoteId}`), uow.context.correlationId);
    if (r.kind !== "RESERVED") throw new Error("the intent's journal entry was not reserved");
    const now = clock.now();
    const accepted = await uow.commerce.quotes.transition(quote.quoteId as QuoteId, 2, { state: "ACCEPTED_FOR_CHECKOUT" }, now);
    assert.equal(accepted.kind, "APPLIED");
    const route = await uow.commerce.routes.findQualified(PROVIDER, ENVIRONMENT);
    assert.ok(route, "the qualified route of the provider and environment");
    const orderId = uow.ids.next() as PaymentOrderId;
    const attemptId = uow.ids.next() as PaymentAttemptId;
    await uow.commerce.orders.insert({
      orderId,
      agencyId: A.agencyId,
      projectId: quote.projectId as ProjectId,
      quoteId: quote.quoteId as QuoteId,
      approvalId: quote.subject.approvalId as ApprovalId,
      route,
      expectedAmountCents: BigInt(quote.totalCents),
      expectedServiceCents: BigInt(quote.serviceCents),
      expectedTaxCents: BigInt(quote.taxCents),
      termsHash: quote.termsHash,
      idempotencyHash: paymentIntentHash({ quoteId: quote.quoteId, termsHash: quote.termsHash, expectedAmountCents: String(quote.totalCents), currency: "USD", routeId: route.routeId, provider: route.provider, environment: route.environment }),
      createdByMembershipId: A.ownerMembershipId,
      intentEntryId: r.entryId,
      createdAt: now,
    });
    await uow.commerce.attempts.prepare({ attemptId, agencyId: A.agencyId, orderId, operation: "CREATE_ORDER", ordinal: 1, provider: PROVIDER, environment: ENVIRONMENT, requestHash: sha(`create-${orderId}`), providerRequestId: `kauro-${attemptId}`, intentEntryId: r.entryId, startedAt: now });
    await uow.scopes.record({ kind: "PAYMENT_ORDER", key: orderId, agencyId: A.agencyId, orderId }, now);
    return { entryId: r.entryId, orderId, attemptId, events: [...uow.events.appended] };
  });
}

async function adopted<T>(orderId: string, work: (uow: CommerceUnitOfWork) => Promise<T>): Promise<T> {
  return env.h.commerce.run(env.h.service(), async (uow) => {
    assert.equal(await uow.adoptScope("PAYMENT_ORDER", orderId), env.A.agencyId);
    return work(uow);
  });
}

test("the checkout through the commerce adapters: a quote issued (drafted, issued) and accepted, an order INTENT_CREATED then CREATING, its CREATE_ORDER attempt PREPARED then DISPATCHING with the database's deadline — now() + 60 s whatever the caller asks — and the payment service's CONFIRMED and CREATED with the provider identity learned once; every published event is the type commerceVersionEventType names and its outbox records go to exactly its subscribers", async () => {
  const { h, A } = env;
  const { projectId } = await project(env.app, A, env.clients.get(A.agencyId)!, env.hubspot, "HUBSPOT");
  const subject = await approvedSubject(env.app, env.validator, env.assurance, A, projectId, "checkout");
  const quoteId = ids.next() as QuoteId;
  const snapshotId = ids.next() as EligibilitySnapshotId;
  const issued = await h.commerce.run(tenantOf(A), async (uow) => {
    const issuedAt = clock.now();
    const ms = Date.parse(issuedAt);
    const record = await uow.commerce.quotes.issue(
      {
        quoteId,
        agencyId: A.agencyId,
        projectId: projectId as ProjectId,
        planId: subject.planId as PlanId,
        approvalId: subject.approvalId as ApprovalId,
        revisionHash: subject.revisionHash,
        planHash: subject.planHash,
        targetContractHash: subject.targetContractHash,
        billableUnits: 40000,
        mode: "HUBSPOT",
        pricePolicyVersion: "R2-INITIAL",
        discountPolicyVersion: "R2-INITIAL",
        baseServiceCents: 129500n,
        discountBps: 2500,
        discountCents: 32375n,
        serviceCents: 97125n,
        fiscalProfileId: env.profiles.get(A.agencyId)! as FiscalProfileId,
        issuerRef: env.routes.issuerRef as FiscalIssuerRef,
        tax: { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 },
        taxCents: 0n,
        totalCents: 97125n,
        eligibilitySnapshotId: snapshotId,
        termsHash: sha(`terms-${quoteId}`),
        termsVersion: "TERMS-2026-01",
        issuedAt,
        expiresAt: toUtcInstant(ms + 336 * HOUR),
        sourceAvailableUntil: toUtcInstant(ms + 168 * HOUR),
        createdByMembershipId: A.ownerMembershipId,
      },
      { snapshotId, agencyId: A.agencyId, quoteId, projectId: projectId as ProjectId, asOf: issuedAt, lookbackStartsAt: toUtcInstant(ms - 8760 * HOUR), qualifyingProjectIds: [], qualifyingCount: 0, repeatDiscountBps: 0, foundingSlotRef: ids.next(), foundingDiscountBps: 2500, appliedDiscountBps: 2500, policyVersion: "R2-INITIAL" },
    );
    return { record, events: [...uow.events.appended], snapshot: await uow.commerce.quotes.snapshot(quoteId), locked: await uow.commerce.quotes.lock(quoteId) };
  });
  assert.deepEqual([issued.record.state, issued.record.version, issued.record.discountCents, issued.record.serviceCents, issued.record.totalCents], ["ISSUED", 2, 32375n, 97125n, 97125n]);
  assert.deepEqual([issued.snapshot?.appliedDiscountBps, issued.snapshot?.asOf], [2500, issued.record.issuedAt]);
  assert.equal(issued.locked?.version, 2);
  await assertVersionEvents(h, issued.events, [
    ["quote", quoteId, 1, { previousState: null, state: "DRAFT" }],
    ["quote", quoteId, 2, { previousState: "DRAFT", state: "ISSUED" }],
  ]);
  assert.deepEqual(issued.events[1]!.payload, {
    quoteId, agencyId: A.agencyId, projectId, planId: subject.planId, approvalId: subject.approvalId, planHash: subject.planHash, revisionHash: subject.revisionHash,
    targetContractHash: subject.targetContractHash, mode: "HUBSPOT", billableUnits: 40000, discountBps: 2500, baseServiceCents: 129500, discountCents: 32375, serviceCents: 97125,
    taxCents: 0, totalCents: 97125, currency: "USD", termsHash: issued.record.termsHash, eligibilitySnapshotId: snapshotId, fiscalProfileId: issued.record.fiscalProfileId,
    taxTreatment: "EXEMPT_EXPORT", pricePolicyVersion: "R2-INITIAL", discountPolicyVersion: "R2-INITIAL", previousState: "DRAFT",
  });
  const quote: QuoteFixture = { quoteId, projectId, subject, serviceCents: 97125, taxCents: 0, totalCents: 97125, termsHash: issued.record.termsHash, billableUnits: 40000, mode: "HUBSPOT", profileId: issued.record.fiscalProfileId };

  // T1: the intent is durable before any provider call is possible
  const t1 = await intent(quote);
  await assertVersionEvents(h, t1.events, [
    ["quote", quoteId, 3, { previousState: "ISSUED", state: "ACCEPTED_FOR_CHECKOUT" }],
    ["payment_order", t1.orderId, 1, { previousState: null, state: "INTENT_CREATED" }],
    ["payment_attempt", t1.attemptId, 1, { previousState: null, state: "PREPARED" }],
  ]);

  // T2: the claim, asking for a deadline a century away — the database's own deadline is written
  const t2 = await h.commerce.run(tenantOf(A), async (uow) => {
    const byEntry = await uow.commerce.attempts.findByIntentEntry(t1.entryId);
    const live = await uow.commerce.attempts.findLive({ orderId: t1.orderId, operation: "CREATE_ORDER" });
    const count = await uow.commerce.attempts.countFor({ orderId: t1.orderId, operation: "CREATE_ORDER" });
    const now = clock.now();
    const claim = await uow.commerce.attempts.transition(t1.attemptId, 1, { state: "DISPATCHING", dispatchDeadlineAt: instantAt(876_000 * HOUR), lastObservedAt: now }, now);
    const creating = await uow.commerce.orders.transition(t1.orderId, 1, { state: "CREATING" }, now);
    return { byEntry, live, count, claim, creating, events: [...uow.events.appended], order: await uow.commerce.orders.findByIntentEntry(t1.entryId) };
  });
  assert.deepEqual([t2.byEntry?.attemptId, t2.live?.attemptId, t2.count, t2.order?.orderId], [t1.attemptId, t1.attemptId, 1, t1.orderId]);
  assert.equal(t2.claim.kind === "APPLIED" ? t2.claim.record.state : t2.claim.kind, "DISPATCHING");
  const deadline = await h.oracle.query<{ ahead: string; far: boolean }>("SELECT extract(epoch FROM dispatch_deadline_at - updated_at)::text AS ahead, dispatch_deadline_at > now() + interval '1 hour' AS far FROM kauro.payment_attempts WHERE attempt_id = $1", [t1.attemptId]);
  assert.deepEqual(deadline.rows[0], { ahead: "60.000000", far: false }, "the claim's deadline is the database's now() + 60 s");
  await assertVersionEvents(h, t2.events, [
    ["payment_attempt", t1.attemptId, 2, { previousState: "PREPARED", state: "DISPATCHING" }],
    ["payment_order", t1.orderId, 2, { previousState: "INTENT_CREATED", state: "CREATING" }],
  ]);

  // T3: the payment service applies the provider's authenticated creation in the order's agency
  const providerOrderId = `PO-${t1.orderId.slice(-12)}`;
  const t3 = await adopted(t1.orderId, async (uow) => {
    const now = clock.now();
    const confirmed = await uow.commerce.attempts.transition(t1.attemptId, 2, { state: "CONFIRMED", lastObservedAt: now, evidenceHash: sha(`create-evidence-${t1.orderId}`) }, now);
    const created = await uow.commerce.orders.transition(t1.orderId, 2, { state: "CREATED", providerOrderId, providerApprovalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${providerOrderId}` }, now);
    await uow.scopes.record({ kind: "PROVIDER_ORDER", key: providerScopeKey(PROVIDER, ENVIRONMENT, providerOrderId), agencyId: A.agencyId, orderId: t1.orderId }, now);
    return { confirmed, created, events: [...uow.events.appended], live: await uow.commerce.attempts.findLive({ orderId: t1.orderId, operation: "CREATE_ORDER" }), open: await uow.commerce.orders.findOpenForProject(projectId as ProjectId), attempts: await uow.commerce.attempts.listForOrder(t1.orderId) };
  });
  assert.equal(t3.created.kind === "APPLIED" ? t3.created.record.providerOrderId : null, providerOrderId);
  assert.deepEqual([t3.live, t3.open?.state, t3.attempts.map((a) => a.state)], [null, "CREATED", ["CONFIRMED"]]);
  await assertVersionEvents(h, t3.events, [
    ["payment_attempt", t1.attemptId, 3, { previousState: "DISPATCHING", state: "CONFIRMED" }],
    ["payment_order", t1.orderId, 3, { previousState: "CREATING", state: "CREATED" }],
  ]);
  // the provider identity is learned once (KA004), and the request handlers cannot learn it at all
  await assert.rejects(adopted(t1.orderId, (uow) => uow.commerce.orders.transition(t1.orderId, 3, { state: "APPROVED", providerOrderId: "PO-OTHER" }, clock.now())), (e: unknown) => failure(e).code === "INTEGRITY_FAILURE" && failure(e).details.reason === "IMMUTABLE_COLUMN");
  await assert.rejects(h.commerce.run(tenantOf(A), (uow) => uow.commerce.orders.transition(t1.orderId, 3, { state: "APPROVED" }, clock.now())), (e: unknown) => failure(e).code === "NOT_FOUND");
});

test("a compare-and-swap loser answers STALE with the current version and state: two claims of one PREPARED attempt — the second waits on the row, observed in pg_stat_activity, then finds version 2 DISPATCHING and publishes nothing; a write from a stale version answers STALE and writes nothing", async () => {
  const { h, A } = env;
  const quote = await quoted(env, A, "stale");
  const t1 = await intent(quote);
  const claim = (uow: CommerceUnitOfWork) => uow.commerce.attempts.transition(t1.attemptId, 1, { state: "DISPATCHING", lastObservedAt: clock.now() }, clock.now());
  const hold = barrier();
  const claimed = barrier();
  const first = h.commerce.run(tenantOf(A), async (uow) => {
    const r = await claim(uow);
    claimed.open();
    await hold.wait;
    return r;
  });
  await claimed.wait;
  const second = h.commerce.run(tenantOf(A), async (uow) => ({ outcome: await claim(uow), published: uow.events.appended.length }));
  await waitForLockWait(h.oracle, "kauro-test-api", "UPDATE kauro.payment_attempts AS t");
  hold.open();
  const [won, lost] = await Promise.all([first, second]);
  assert.equal(won.kind, "APPLIED");
  assert.deepEqual(lost, { outcome: { kind: "STALE", currentVersion: 2, currentState: "DISPATCHING" }, published: 0 });
  const events = await h.oracle.query<{ event_type: string }>("SELECT event_type FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [t1.attemptId]);
  assert.deepEqual(events.rows.map((r) => r.event_type), ["payment_attempt.prepared.v1", "payment_attempt.dispatching.v1"]);
  // the order's claim from version 1 after it moved on: STALE with the current version and state, nothing written
  await h.commerce.run(tenantOf(A), (uow) => uow.commerce.orders.transition(t1.orderId, 1, { state: "CREATING" }, clock.now()));
  const stale = await h.commerce.run(tenantOf(A), async (uow) => ({ outcome: await uow.commerce.orders.transition(t1.orderId, 1, { state: "CREATING" }, clock.now()), published: uow.events.appended.length }));
  assert.deepEqual(stale, { outcome: { kind: "STALE", currentVersion: 2, currentState: "CREATING" }, published: 0 });
});

test("a capture's versions record one fact each: born PENDING with its funds UNKNOWN, completed with its allocation (capture.completed.v1 names the purchase), its fee learned once (capture.fee_observed.v1 names the funds state it is taken from), its funds observed under the row lock (capture.funds_observed.v1 carries the movable balance, the amount less the fee and the money returned); a repeated fact is no new version, another fee is refused KA004; its entitlement issued, found by capture, quote and revision hash, and revoked with the phase of the state it leaves", async () => {
  const { h, A } = env;
  const quote = await quoted(env, A, "capture-versions");
  const order = await createdOrder(env.app, A, quote, env.routes, { payment: env.payment });
  const orderId = order.orderId as PaymentOrderId;
  const captureId = ids.next() as CaptureId;
  const authorizationId = ids.next() as CommercialAuthorizationId;
  const providerCaptureId = `CAP-${captureId.slice(-12)}`;
  const completedAt = clock.now();
  const born = await adopted(orderId, async (uow) => {
    const pending = await uow.commerce.captures.insert({
      captureId, agencyId: A.agencyId, orderId, status: "PENDING", provider: PROVIDER, environment: ENVIRONMENT, providerCaptureId, merchantRef: env.routes.merchantRef as never, payeeDigest: env.routes.payeeDigest,
      amountCents: 97125n, allocation: { serviceCents: 0n, taxCents: 0n, excessCents: 0n }, fundsState: "UNKNOWN", firstObservationSource: "PROVIDER_QUERY", observedAt: clock.now(), evidenceHash: sha(`pending-${captureId}`),
    });
    const completed = await uow.commerce.captures.advance(captureId, pending.version, { status: "COMPLETED", allocation: { serviceCents: 97125n, taxCents: 0n, excessCents: 0n }, providerCompletedAt: completedAt, observedAt: clock.now(), evidenceHash: sha(`completed-${captureId}`) }, clock.now());
    const captured = await uow.commerce.orders.transition(orderId, 3, { state: "CAPTURED" }, clock.now());
    assert.equal(captured.kind, "APPLIED");
    const s = quote.subject;
    const authorization = await uow.commerce.authorizations.issue({
      authorizationId, agencyId: A.agencyId, projectId: quote.projectId as ProjectId, quoteId: quote.quoteId as QuoteId, orderId, orderQuoteId: quote.quoteId as QuoteId, captureId,
      approvalId: s.approvalId as ApprovalId, approvalHash: s.approvalHash, planId: s.planId as PlanId, planHash: s.planHash, revisionHash: s.revisionHash, targetContractHash: s.targetContractHash,
      capabilityId: env.hubspot as CapabilityId, capabilityVersion: "R2-INITIAL", mode: "HUBSPOT", billableUnits: quote.billableUnits, honoredAfterPriceExpiry: false, createdAt: clock.now(),
    });
    return {
      completed,
      authorization,
      events: [...uow.events.appended],
      byProvider: await uow.commerce.captures.findByProviderCapture(PROVIDER, ENVIRONMENT, providerCaptureId),
      listed: await uow.commerce.captures.listForOrder(orderId),
      committed: await uow.commerce.captures.committedRefunds(captureId),
      live: await uow.commerce.authorizations.findLiveByCapture(captureId),
      byQuote: await uow.commerce.authorizations.findByQuote(quote.quoteId as QuoteId),
      byRevision: await uow.commerce.authorizations.findLiveByRevisionHash(A.agencyId, s.revisionHash),
      otherRevision: await uow.commerce.authorizations.findLiveByRevisionHash(A.agencyId, sha("another revision")),
    };
  });
  await assertVersionEvents(h, born.events, [
    ["capture", captureId, 1, { previousState: null, state: "PENDING" }],
    ["capture", captureId, 2, { previousState: "PENDING", state: "COMPLETED" }],
    ["payment_order", orderId, 4, { previousState: "CREATED", state: "CAPTURED" }],
    ["commercial_authorization", authorizationId, 1, { previousState: null, state: "ACTIVE" }],
  ]);
  assert.deepEqual(born.events[1]!.payload, {
    captureId, agencyId: A.agencyId, orderId, projectId: quote.projectId, quoteId: quote.quoteId, amountCents: 97125, currency: "USD", allocatedServiceCents: 97125, allocatedTaxCents: 0,
    excessCents: 0, previousStatus: "PENDING", evidenceHash: sha(`completed-${captureId}`), source: "PROVIDER_QUERY",
  });
  assert.deepEqual([born.byProvider?.captureId, born.listed.map((c) => c.status), born.committed], [captureId, ["COMPLETED"], { serviceCents: 0n, taxCents: 0n, excessCents: 0n }]);
  assert.deepEqual([born.live?.authorizationId, born.byQuote?.authorizationId, born.byRevision.map((a) => a.authorizationId), born.otherRevision], [authorizationId, authorizationId, [authorizationId], []]);
  assert.equal((await h.oracle.query("SELECT allocated_cents FROM kauro.payment_orders WHERE order_id = $1", [orderId])).rows[0].allocated_cents, "97125");

  // the fee the provider reported after the completion: one version, its own event, the funds state it is taken from
  const fee = await adopted(orderId, async (uow) => {
    const learned = await uow.commerce.captures.observeFee(captureId, 2, { providerFeeCents: 5275n, observedAt: clock.now(), evidenceHash: sha(`fee-${captureId}`) }, clock.now());
    const again = await uow.commerce.captures.observeFee(captureId, 3, { providerFeeCents: 5275n, observedAt: clock.now(), evidenceHash: sha(`fee-again-${captureId}`) }, clock.now());
    return { learned, again, events: [...uow.events.appended] };
  });
  assert.deepEqual([fee.learned.kind === "APPLIED" && fee.learned.record.version, fee.again.kind === "APPLIED" && fee.again.record.version], [3, 3], "the same fee again is not a new version");
  await assertVersionEvents(h, fee.events, [["capture", captureId, 3, { previousState: "COMPLETED", state: "COMPLETED", feeChanged: true }]]);
  assert.deepEqual([fee.events[0]!.payload["providerFeeCents"], fee.events[0]!.payload["fundsState"]], [5275, "UNKNOWN"]);
  await assert.rejects(adopted(orderId, (uow) => uow.commerce.captures.observeFee(captureId, 3, { providerFeeCents: 6000n, observedAt: clock.now(), evidenceHash: sha("other fee") }, clock.now())), (e: unknown) => failure(e).details.reason === "IMMUTABLE_COLUMN");

  // the funds' availability: a version of its own under the row lock, carrying the movable balance
  const funds = await adopted(orderId, async (uow) => {
    const held = await uow.commerce.captures.observeFunds(captureId, 3, { fundsState: "HELD", observedAt: clock.now(), evidenceHash: sha(`held-${captureId}`) }, clock.now());
    const heldAgain = await uow.commerce.captures.observeFunds(captureId, 4, { fundsState: "HELD", observedAt: clock.now(), evidenceHash: sha(`held-again-${captureId}`) }, clock.now());
    const stale = await uow.commerce.captures.observeFunds(captureId, 3, { fundsState: "AVAILABLE", observedAt: clock.now(), evidenceHash: sha(`available-${captureId}`) }, clock.now());
    return { held, heldAgain, stale, events: [...uow.events.appended] };
  });
  assert.equal(funds.heldAgain.kind === "APPLIED" && funds.heldAgain.record.version, 4);
  assert.deepEqual(funds.stale, { kind: "STALE", currentVersion: 4, currentState: "COMPLETED" });
  await assertVersionEvents(h, funds.events, [["capture", captureId, 4, { previousState: "COMPLETED", state: "COMPLETED", fundsChanged: true }]]);
  assert.deepEqual([funds.events[0]!.payload["fundsState"], funds.events[0]!.payload["previousFundsState"], funds.events[0]!.payload["amountCents"]], ["HELD", "UNKNOWN", 91850], "the movable balance: 97125 less the reported fee 5275");

  // the entitlement revoked with the phase of the state it leaves; a revocation recording another phase is refused (KA008)
  await assert.rejects(adopted(orderId, (uow) => uow.commerce.authorizations.transition(authorizationId, 1, { state: "REVOKED", revocation: { at: clock.now(), phase: "POST_DELIVERY", code: "OPERATOR_REVOKED" } }, clock.now())), (e: unknown) => failure(e).details.reason === "UNLISTED_TRANSITION");
  const revoked = await adopted(orderId, async (uow) => ({
    outcome: await uow.commerce.authorizations.transition(authorizationId, 1, { state: "REVOKED", revocation: { at: clock.now(), phase: "PRE_EXECUTION", code: "OPERATOR_REVOKED" } }, clock.now()),
    events: [...uow.events.appended],
    live: await uow.commerce.authorizations.findLiveByCapture(captureId),
    byRevision: await uow.commerce.authorizations.findLiveByRevisionHash(A.agencyId, quote.subject.revisionHash),
    stored: await uow.commerce.authorizations.get(authorizationId),
  }));
  await assertVersionEvents(h, revoked.events, [["commercial_authorization", authorizationId, 2, { previousState: "ACTIVE", state: "REVOKED" }]]);
  assert.deepEqual([revoked.events[0]!.payload["phase"], revoked.events[0]!.payload["revocationCode"], revoked.live, revoked.byRevision, revoked.stored?.revocationPhase], ["PRE_EXECUTION", "OPERATOR_REVOKED", null, [], "PRE_EXECUTION"]);
});

test("an out-of-order reversal: a capture first seen REVERSED is inserted COMPLETED and advanced to REVERSED in one unit of work — capture.completed.v1 then capture.reversed.v1, the reversal naming the components it returns and the funds state they leave — and the ledger posts it CAPTURE then CHARGEBACK from those two events: the receivable nets to zero", async () => {
  const { h, A } = env;
  const quote = await quoted(env, A, "out-of-order");
  const order = await createdOrder(env.app, A, quote, env.routes, { payment: env.payment });
  const orderId = order.orderId as PaymentOrderId;
  const captureId = ids.next() as CaptureId;
  const completedAt = clock.now();
  const reversed = await adopted(orderId, async (uow) => {
    const completed = await uow.commerce.captures.insert({
      captureId, agencyId: A.agencyId, orderId, status: "COMPLETED", provider: PROVIDER, environment: ENVIRONMENT, providerCaptureId: `CAP-${captureId.slice(-12)}`, merchantRef: env.routes.merchantRef as never,
      payeeDigest: env.routes.payeeDigest, amountCents: 97125n, allocation: { serviceCents: 97125n, taxCents: 0n, excessCents: 0n }, fundsState: "UNKNOWN", providerCompletedAt: completedAt,
      firstObservationSource: "WEBHOOK", observedAt: completedAt, evidenceHash: sha(`reversal-${captureId}`),
    });
    const r = await uow.commerce.captures.advance(captureId, completed.version, { status: "REVERSED", observedAt: clock.now(), evidenceHash: sha(`reversal-${captureId}`) }, clock.now());
    await uow.commerce.orders.transition(orderId, 3, { state: "CAPTURED" }, clock.now());
    return { record: r.kind === "APPLIED" ? r.record : null, events: [...uow.events.appended] };
  });
  await assertVersionEvents(h, reversed.events, [
    ["capture", captureId, 1, { previousState: null, state: "COMPLETED" }],
    ["capture", captureId, 2, { previousState: "COMPLETED", state: "REVERSED" }],
    ["payment_order", orderId, 4, { previousState: "CREATED", state: "CAPTURED" }],
  ]);
  assert.deepEqual([reversed.record?.status, reversed.record?.providerCompletedAt, reversed.record?.allocation.serviceCents], ["REVERSED", completedAt, 97125n], "the completion instant stays the sale's tax point");
  const [completion, reversal] = reversed.events;
  const p = reversal!.payload;
  assert.deepEqual([p["reversedServiceCents"], p["reversedTaxCents"], p["reversedExcessCents"], p["fundsState"], p["movableBalanceCents"], p["previousStatus"]], [97125, 0, 0, "UNKNOWN", 97125, "COMPLETED"]);
  // the FINANCE consumer's postings, each set sourced by its own event with the capture as the source reference
  const posted = await adopted(orderId, async (uow) => {
    const set = (eventId: EventId, sourceKind: "CAPTURE" | "CHARGEBACK", lines: ReturnType<typeof capturePostings>) =>
      uow.commerce.ledger.post({ agencyId: A.agencyId, source: { kind: "EVENT", eventId }, sourceKind, sourceRef: captureId, currency: "USD", effectiveAt: completedAt, observedAt: clock.now(), evidenceHash: sha(`${sourceKind}-${captureId}`), lines }, clock.now());
    const capture = await set(completion!.eventId, "CAPTURE", capturePostings({ serviceCents: 97125n, taxCents: 0n, excessCents: 0n }));
    const chargeback = await set(reversal!.eventId, "CHARGEBACK", returnPostings({ serviceCents: BigInt(p["reversedServiceCents"] as number), taxCents: BigInt(p["reversedTaxCents"] as number), excessCents: BigInt(p["reversedExcessCents"] as number) }, p["fundsState"] as FundsState, BigInt(p["movableBalanceCents"] as number)));
    return { capture, chargeback, bySource: await uow.commerce.ledger.listForSource("CHARGEBACK", captureId) };
  });
  assert.deepEqual([posted.capture.posted, posted.chargeback.posted], [true, true]);
  assert.deepEqual(posted.bySource.map((e) => [e.accountCode, e.direction, e.amountCents]), [["CONTRACT_LIABILITY", "DEBIT", 97125n], ["PSP_RECEIVABLE", "CREDIT", 97125n]]);
  const net = await h.oracle.query<{ net: string }>("SELECT sum(CASE direction WHEN 'DEBIT' THEN amount_cents ELSE -amount_cents END)::text AS net FROM kauro.ledger_entries WHERE source_ref = $1 AND account_code = 'PSP_RECEIVABLE'", [captureId]);
  assert.equal(net.rows[0]!.net, "0");
});

test("provider observations and exceptions: the latest applied observation of a subject ignores history effects; an exception is recorded once per source and kind — a repetition answers the recorded row — and a webhook no order can take is recorded with no agency adopted", async () => {
  const { h, A } = env;
  const quote = await quoted(env, A, "observations");
  const order: OrderFixture = await createdOrder(env.app, A, quote, env.routes, { payment: env.payment });
  const orderId = order.orderId as PaymentOrderId;
  const t1 = instantAt(-2 * HOUR);
  const t2 = instantAt(-HOUR);
  const artifact = ids.next() as EvidenceArtifactRef;
  const observed = await adopted(orderId, async (uow) => {
    await uow.commerce.observations.append({ agencyId: A.agencyId, orderId, source: "DISPATCH_RESPONSE", attemptId: order.createAttemptId as PaymentAttemptId, subjectKind: "ORDER", providerRef: order.providerOrderId, observedStatus: "CREATED", observedAt: t1, evidenceHash: sha("created"), effect: "ADVANCED" });
    await uow.commerce.observations.append({ agencyId: A.agencyId, orderId, source: "PROVIDER_QUERY", artifactRef: artifact, subjectKind: "ORDER", providerRef: order.providerOrderId, observedStatus: "CREATED", amountCents: 97125n, currency: "USD", payeeDigest: env.routes.payeeDigest, observedAt: t2, evidenceHash: sha("stale"), effect: "STALE_IGNORED" });
    const exception = { source: "DISPATCH_RESPONSE" as const, agencyId: A.agencyId, orderId, attemptId: order.createAttemptId as PaymentAttemptId, provider: PROVIDER, environment: ENVIRONMENT as "SANDBOX", kind: "WRONG_PAYEE" as const, providerRef: "CAP-WRONG", amountCents: 97125n, currency: "USD", evidenceHash: sha("wrong payee"), observedAt: clock.now() };
    const first = await uow.commerce.exceptions.record(exception);
    const again = await uow.commerce.exceptions.record({ ...exception, evidenceHash: sha("wrong payee again") });
    return { latest: await uow.commerce.observations.latestAppliedAt(orderId, "ORDER", order.providerOrderId), none: await uow.commerce.observations.latestAppliedAt(orderId, "CAPTURE", "CAP-NONE"), listed: await uow.commerce.observations.listForOrder(orderId), first, again };
  });
  assert.equal(observed.latest, t1, "a stale observation is history, never the subject's latest applied one");
  assert.equal(observed.none, null);
  assert.deepEqual(observed.listed.map((o) => [o.source, o.effect, o.amountCents ?? null]), [["DISPATCH_RESPONSE", "ADVANCED", null], ["PROVIDER_QUERY", "STALE_IGNORED", 97125n]]);
  assert.deepEqual([observed.first.recorded, observed.again.recorded, observed.again.record.exceptionId, observed.again.record.evidenceHash], [true, false, observed.first.record.exceptionId, sha("wrong payee")]);
  // a delivered event naming no known order: the ingress records it, the payment service keeps the exception at the platform level
  const inboxId = ids.next() as InboxId;
  const delivered = await h.inboxIngress.record({ inboxId, provider: PROVIDER, environment: ENVIRONMENT, externalEventId: `evt-${inboxId}`, bodyHash: sha(`body-${inboxId}`), receivedAt: clock.now() });
  assert.equal(delivered.kind, "RECORDED");
  const platform = await h.commerce.run(h.service(), async (uow) => {
    assert.equal(await uow.adoptScope("PROVIDER_ORDER", providerScopeKey(PROVIDER, ENVIRONMENT, "PO-UNKNOWN")), null);
    return uow.commerce.exceptions.record({ source: "WEBHOOK", inboxId, provider: PROVIDER, environment: ENVIRONMENT, kind: "UNKNOWN_PROVIDER_REFERENCE", providerRef: "PO-UNKNOWN", evidenceHash: sha("unknown"), observedAt: clock.now() });
  });
  assert.deepEqual([platform.recorded, platform.record.agencyId, platform.record.inboxId], [true, undefined, inboxId]);
  assert.equal((await h.oracle.query("SELECT agency_id FROM kauro.provider_event_exceptions WHERE inbox_id = $1", [inboxId])).rows[0].agency_id, null);
});

test("the platform's configuration read after its transition locks: the qualified route of a provider and environment, a fiscal issuer, the agency's current profile and the version of a sale's tax point (saleProfileAt over every version: the current reviewed one, or a later review reaching back that resolves an unknown), a re-review superseding at its own recorded instant, the caller's own corporate grant, a standing refund policy and the known price policy", async () => {
  const { h, A } = env;
  const routes = await h.commerce.run(tenantOf(A), async (uow) => ({
    qualified: await uow.commerce.routes.findQualified(PROVIDER, ENVIRONMENT),
    live: await uow.commerce.routes.findQualified(PROVIDER, "LIVE"),
    byId: await uow.commerce.routes.get(env.routes.routeId as never),
    issuer: await uow.commerce.fiscal.getIssuer(env.routes.issuerRef as FiscalIssuerRef),
    current: await uow.commerce.fiscal.currentProfile(A.agencyId),
    profile: await uow.commerce.fiscal.getProfile(env.profiles.get(A.agencyId)! as FiscalProfileId),
    price: await uow.commerce.pricePolicies.get("R2-INITIAL"),
    unknownPrice: await uow.commerce.pricePolicies.get("R2-UNKNOWN"),
  }));
  assert.deepEqual([routes.qualified?.routeId, routes.qualified?.state, routes.qualified?.integrationClass, routes.live, routes.byId?.payeeDigest], [env.routes.routeId, "QUALIFIED", "CONTRACT_FAKE", null, env.routes.payeeDigest]);
  assert.deepEqual([routes.issuer?.routeState, routes.issuer?.legalFactStatus, routes.issuer?.numberingAuthorizationRef], ["QUALIFIED", "PROFESSIONALLY_CONFIRMED", "DIAN-18764000001"]);
  assert.deepEqual([routes.current?.profileId, routes.profile?.taxTreatment, routes.profile?.exportEvidenceHash !== undefined], [env.profiles.get(A.agencyId), "EXEMPT_EXPORT", true]);
  assert.deepEqual(routes.price, { policyVersion: "R2-INITIAL", quoteSeconds: 1209600, repeatLookbackSeconds: 31536000, foundingDiscountBps: 2500, preExecutionReplacementsIncluded: 1, unpaidSourceHardSeconds: 1209600 });
  assert.equal(routes.unknownPrice, null);

  // one lineage per agency, recorded at explicit instants: the version of a sale's tax point is the domain's saleProfileAt
  const record = (ag: CommerceEnv["A"], p: { id: string; treatment: "REVIEW_REQUIRED" | "EXEMPT_EXPORT"; recordedAt: UtcInstant; validFrom: UtcInstant; supersedes?: string }) =>
    h.commerce.run(h.operator(env.kora), async (uow) => {
      await uow.adoptFinanceScope(ag.agencyId);
      const reviewed = p.treatment === "EXEMPT_EXPORT";
      return uow.commerce.fiscal.recordProfile({
        profileId: p.id as FiscalProfileId, agencyId: ag.agencyId, operatorLegalRef: env.routes.issuerRef as FiscalIssuerRef, customerLegalRef: ids.next(), serviceClassification: "Data services", territory: "Colombia and abroad",
        taxTreatment: p.treatment, taxRule: reviewed ? "ZERO_REVIEWED" : "UNRESOLVED", taxRateBps: 0, evidenceHash: sha(`evidence-${p.id}`), validFrom: p.validFrom, recordedAt: p.recordedAt,
        ...(reviewed ? { exportEvidenceHash: sha(`export-${p.id}`), reviewedByUserId: env.kora } : {}),
        ...(p.supersedes === undefined ? {} : { supersedesProfileId: p.supersedes as FiscalProfileId }),
      });
    });
  const G = await h.createAgency(await h.person("gina-fiscal"), "Fiscal G");
  const [g1, g2] = [ids.next(), ids.next()];
  await record(G, { id: g1, treatment: "EXEMPT_EXPORT", recordedAt: instantAt(-3 * HOUR), validFrom: instantAt(-4 * HOUR) });
  const taxPoint = instantAt(-2 * HOUR);
  const successor = await record(G, { id: g2, treatment: "EXEMPT_EXPORT", recordedAt: instantAt(-HOUR), validFrom: instantAt(-HOUR), supersedes: g1 });
  const readG = await h.commerce.run(h.operator(env.kora), async (uow) => {
    await uow.adoptFinanceScope(G.agencyId);
    return { atSale: await uow.commerce.fiscal.saleProfileAt(G.agencyId, taxPoint), now: await uow.commerce.fiscal.saleProfileAt(G.agencyId, clock.now()), current: await uow.commerce.fiscal.currentProfile(G.agencyId), first: await uow.commerce.fiscal.getProfile(g1 as FiscalProfileId) };
  });
  assert.deepEqual([readG.atSale?.profileId, readG.now?.profileId, readG.current?.profileId], [g1, g2, g2]);
  assert.equal(readG.first?.supersededAt, successor.recordedAt, "superseded at exactly the successor's recorded instant");
  // an unknown treatment at the sale, resolved by a later review whose validity reaches back to it
  const H = await h.createAgency(await h.person("hugo-fiscal"), "Fiscal H");
  const [h1, h2] = [ids.next(), ids.next()];
  await record(H, { id: h1, treatment: "REVIEW_REQUIRED", recordedAt: instantAt(-3 * HOUR), validFrom: instantAt(-4 * HOUR) });
  await record(H, { id: h2, treatment: "EXEMPT_EXPORT", recordedAt: instantAt(-HOUR), validFrom: instantAt(-5 * HOUR), supersedes: h1 });
  const readH = await h.commerce.run(h.operator(env.kora), async (uow) => {
    await uow.adoptFinanceScope(H.agencyId);
    return uow.commerce.fiscal.saleProfileAt(H.agencyId, taxPoint);
  });
  assert.equal(readH?.profileId, h2);
  // the payment service reads the profile versions of the agency it adopted (the fiscal drafter)
  const sale = await paid(env, A, "fiscal-read");
  const drafterView = await adopted(sale.order.orderId, (uow) => uow.commerce.fiscal.saleProfileAt(A.agencyId, clock.now()));
  assert.equal(drafterView?.profileId, env.profiles.get(A.agencyId));

  // a person reads only its own corporate grant
  const grants = await h.commerce.run(h.operator(env.kora), async (uow) => ({ own: await uow.commerce.corporateGrants.activeGrant(env.kora, "KAURO_OWNER"), other: await uow.commerce.corporateGrants.activeGrant(A.ownerUserId as UserId, "KAURO_OWNER") }));
  assert.deepEqual([grants.own?.grantId, grants.own?.state, grants.other], [env.koraGrant, "ACTIVE", null]);
  // a standing refund policy the control plane recorded under its authorizing owner's own step-up
  const proof = await h.recordStepUp(env.kora);
  const policyId = ids.next() as RefundPolicyId;
  await env.control.query(
    `INSERT INTO kauro.refund_policies (policy_id, policy_kind, policy_version, refund_scope, max_refund_cents, applies_to_phase, applies_to_origin, conditions_hash, authorized_by_user_id, authorization_proof_ref, valid_from, created_at, updated_at)
     VALUES ($1, 'PRE_EXECUTION_CANCELLATION', 'RP-1', 'BOUNDED', 5000, 'PRE_EXECUTION', 'CUSTOMER_REQUEST', $2, $3, $4, now(), now(), now())`,
    [policyId, sha("policy-conditions"), env.kora, proof],
  );
  const policy = await h.commerce.run(tenantOf(A), (uow) => uow.commerce.refundPolicies.get(policyId));
  assert.deepEqual([policy?.refundScope, policy?.maxRefundCents, policy?.state, policy?.authorizationProofRef], ["BOUNDED", 5000n, "ACTIVE", proof]);
});

test("the included source replacement through the adapters: in one unit of work the payment service records the re-binding, revokes the replaced entitlement SOURCE_REPLACED, supersedes the replaced quote by the replacement, accepts the replacement and issues its entitlement on the same capture; the re-binding is found by its capture and by its replacement quote", async () => {
  const { h, A } = env;
  const first = await paid(env, A, "rebind");
  const q1 = first.order.quote;
  const r2 = await replacementSource(env.app, A, q1.projectId, q1.subject.revisionId, "rebind-r2");
  const s2 = await approvedSubject(env.app, env.validator, env.assurance, A, q1.projectId, "rebind-s2", r2);
  const q2 = await issuedQuote(env.app, A, s2, env.profiles.get(A.agencyId)!, env.routes.issuerRef, { replacesQuoteId: q1.quoteId });
  const rebindingId = ids.next() as PurchaseRebindingId;
  const replacementAuthorization = ids.next() as CommercialAuthorizationId;
  const captureId = first.captureId as CaptureId;
  const rebound = await adopted(first.order.orderId, async (uow) => {
    const now = clock.now();
    await uow.commerce.rebindings.record({
      rebindingId, agencyId: A.agencyId, projectId: q1.projectId as ProjectId, orderId: first.order.orderId as PaymentOrderId, captureId, fromQuoteId: q1.quoteId as QuoteId,
      fromAuthorizationId: first.authorizationId as CommercialAuthorizationId, toQuoteId: q2.quoteId as QuoteId, allowanceOrdinal: 1, reasonCode: "PRE_EXECUTION_SOURCE_REPLACEMENT",
      lineageEvidenceHash: sha(`lineage-${rebindingId}`), requestedByMembershipId: A.ownerMembershipId as MembershipId, createdAt: now,
    });
    const revoked = await uow.commerce.authorizations.transition(first.authorizationId as CommercialAuthorizationId, 1, { state: "REVOKED", revocation: { at: now, phase: "PRE_EXECUTION", code: "SOURCE_REPLACED" } }, now);
    const superseded = await uow.commerce.quotes.transition(q1.quoteId as QuoteId, 3, { state: "SUPERSEDED", supersededByQuoteId: q2.quoteId as QuoteId }, now);
    const accepted = await uow.commerce.quotes.transition(q2.quoteId as QuoteId, 2, { state: "ACCEPTED_FOR_CHECKOUT" }, now);
    assert.deepEqual([revoked.kind, superseded.kind, accepted.kind], ["APPLIED", "APPLIED", "APPLIED"]);
    const issued = await uow.commerce.authorizations.issue({
      authorizationId: replacementAuthorization, agencyId: A.agencyId, projectId: q2.projectId as ProjectId, quoteId: q2.quoteId as QuoteId, orderId: first.order.orderId as PaymentOrderId, orderQuoteId: q1.quoteId as QuoteId,
      captureId, rebindingId, approvalId: s2.approvalId as ApprovalId, approvalHash: s2.approvalHash, planId: s2.planId as PlanId, planHash: s2.planHash, revisionHash: s2.revisionHash,
      targetContractHash: s2.targetContractHash, capabilityId: env.hubspot as CapabilityId, capabilityVersion: "R2-INITIAL", mode: "HUBSPOT", billableUnits: q2.billableUnits, honoredAfterPriceExpiry: false, createdAt: now,
    });
    return { issued, events: [...uow.events.appended], byCapture: await uow.commerce.rebindings.listForCapture(captureId), to: await uow.commerce.rebindings.findTo(q2.quoteId as QuoteId), from: await uow.commerce.rebindings.findTo(q1.quoteId as QuoteId) };
  });
  await assertVersionEvents(h, rebound.events, [
    ["commercial_authorization", first.authorizationId, 2, { previousState: "ACTIVE", state: "REVOKED" }],
    ["quote", q1.quoteId, 4, { previousState: "ACCEPTED_FOR_CHECKOUT", state: "SUPERSEDED" }],
    ["quote", q2.quoteId, 3, { previousState: "ISSUED", state: "ACCEPTED_FOR_CHECKOUT" }],
    ["commercial_authorization", replacementAuthorization, 1, { previousState: null, state: "ACTIVE" }],
  ]);
  assert.deepEqual([rebound.events[1]!.payload["successorQuoteId"], rebound.events[3]!.payload["rebindingId"], rebound.events[3]!.payload["orderQuoteId"]], [q2.quoteId, rebindingId, q1.quoteId]);
  assert.deepEqual([rebound.issued.rebindingId, rebound.byCapture.map((b) => b.rebindingId), rebound.to?.fromAuthorizationId, rebound.from], [rebindingId, [rebindingId], first.authorizationId, null]);
  assert.equal((await h.oracle.query("SELECT agency_id FROM kauro.purchase_rebindings WHERE rebinding_id = $1", [rebindingId])).rows[0].agency_id, A.agencyId as AgencyId);
});
