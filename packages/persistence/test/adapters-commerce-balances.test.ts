// A capture's money at the provider across its fee, its refunds and its chargeback, on real PostgreSQL 17 through the runtime logins
// (package B09, stage-1 integration of the implementation mandates; design D-LEDGER-B5, D-LEDGER-B6, D-REF-B7; the re-check's
// residual N4): the events that take money out of a capture carry the capture's movable balance before them, the completions of one
// capture's refunds are ordered by the capture's refund lock — observed waiting in pg_stat_activity, never by a sleep — and the
// FINANCE posting sets built from those payloads leave the capture's receivable at zero and exactly the fee the provider kept on the
// merchant's available balance.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import {
  capturePostings,
  providerFeePostings,
  returnPostings,
  type AgencyId,
  type CaptureId,
  type CommerceUnitOfWork,
  type CommercialAuthorizationId,
  type DomainEventRecord,
  type EventId,
  type FundsState,
  type LedgerSourceKind,
  type PaymentAttemptId,
  type PaymentOrderId,
  type PostingLine,
  type RefundId,
} from "@kauro/domain";
import { backendPid, barrier, clock, sha, settlesOrWaits, waitForLockWait } from "../src/testing/harness.js";
import { closeCommerceEnv, openCommerceEnv, paid, type CommerceEnv } from "./commerce-adapter-support.js";
import { ENVIRONMENT, PROVIDER, approveRefund, bindCommerce, commerceEvent, requestRefund, service, PAYMENT_SERVICE } from "./commerce-support.js";

let env: CommerceEnv;
let second: Client;

before(async () => {
  env = await openCommerceEnv("balances");
  second = await env.h.pg.connect("kauro_payment_test");
});
after(async () => {
  await second.end();
  await closeCommerceEnv(env);
});

type Sale = Awaited<ReturnType<typeof paid>>;

async function adopted<T>(orderId: string, work: (uow: CommerceUnitOfWork) => Promise<T>): Promise<T> {
  return env.h.commerce.run(env.h.service(), async (uow) => {
    assert.ok(await uow.adoptScope("PAYMENT_ORDER", orderId));
    return work(uow);
  });
}

/** A customer refund of the capture requested by the agency and approved by the corporate owner (CMD031, CMD032). */
async function approved(sale: Sale, serviceCents: number): Promise<RefundId> {
  const refundId = (await requestRefund(env.app, env.A, sale.order, sale.captureId, { serviceCents, taxCents: 0 })) as RefundId;
  await approveRefund(env.app, env.assurance, env.kora, env.A, refundId, { serviceCents, taxCents: 0 });
  return refundId;
}

/** CMD033's T1 and T2 through the adapters: the REFUND attempt PREPARED, the refund SUBMITTING, the attempt claimed. */
async function submitting(sale: Sale, refundId: RefundId): Promise<PaymentAttemptId> {
  return adopted(sale.order.orderId, async (uow) => {
    const attemptId = uow.ids.next() as PaymentAttemptId;
    const now = clock.now();
    await uow.commerce.attempts.prepare({ attemptId, agencyId: env.A.agencyId, orderId: sale.order.orderId as PaymentOrderId, refundId, operation: "REFUND", ordinal: 1, provider: PROVIDER, environment: ENVIRONMENT, requestHash: sha(`refund-${refundId}`), providerRequestId: `kauro-${attemptId}`, startedAt: now });
    assert.equal((await uow.commerce.refunds.transition(refundId, 2, { state: "SUBMITTING" }, now)).kind, "APPLIED");
    assert.equal((await uow.commerce.attempts.transition(attemptId, 1, { state: "DISPATCHING", lastObservedAt: now }, now)).kind, "APPLIED");
    return attemptId;
  });
}

/** CMD033's T3: the provider's authenticated completion of the refund under the attempt's identity. */
async function completeRefund(uow: CommerceUnitOfWork, refundId: RefundId, attemptId: PaymentAttemptId): Promise<DomainEventRecord> {
  const now = clock.now();
  assert.equal((await uow.commerce.attempts.transition(attemptId, 2, { state: "CONFIRMED", lastObservedAt: now, evidenceHash: sha(`refund-evidence-${refundId}`) }, now)).kind, "APPLIED");
  assert.equal((await uow.commerce.refunds.transition(refundId, 3, { state: "COMPLETED", providerRefundId: `RF-${refundId.slice(-12)}`, evidenceHash: sha(`refund-evidence-${refundId}`), completedAt: now }, now)).kind, "APPLIED");
  const event = uow.events.appended.find((e) => e.eventType === "refund.completed.v1");
  assert.ok(event);
  return event;
}

async function eventOf(aggregateId: string, eventType: string): Promise<{ readonly eventId: EventId; readonly payload: Readonly<Record<string, unknown>> }> {
  const r = await env.h.oracle.query<{ event_id: EventId; payload: Record<string, unknown> }>("SELECT event_id, payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = $2", [aggregateId, eventType]);
  assert.equal(r.rows.length, 1, `one ${eventType} of ${aggregateId}`);
  return { eventId: r.rows[0]!.event_id, payload: r.rows[0]!.payload };
}

const cents = (payload: Readonly<Record<string, unknown>>, key: string): bigint => {
  const v = payload[key];
  assert.equal(typeof v, "number", `${key} is a count`);
  return BigInt(v as number);
};

/** The FINANCE consumer's set of one event, from the event's payload alone (design §8.1; the domain's posting functions). */
async function post(orderId: string, eventId: EventId, sourceKind: LedgerSourceKind, sourceRef: string, lines: ReadonlyArray<PostingLine>): Promise<void> {
  const posted = await adopted(orderId, (uow) =>
    uow.commerce.ledger.post({ agencyId: env.A.agencyId as AgencyId, source: { kind: "EVENT", eventId }, sourceKind, sourceRef, currency: "USD", effectiveAt: clock.now(), observedAt: clock.now(), evidenceHash: sha(`set-${eventId}`), lines }, clock.now()),
  );
  assert.equal(posted.posted, true);
}

test("D-LEDGER-B6 and D-REF-B7 (the re-check's residual N4): the events that take money out of a capture carry its movable balance before them — a fee, two refund completions ordered by the capture's refund lock (the second observed waiting in pg_stat_activity, then counting the first) and a chargeback of the rest — and the FINANCE sets posted from those payloads leave the capture's receivable at zero and exactly the kept fee on the merchant's available balance", async () => {
  const { h } = env;
  const sale = await paid(env, env.A, "balances-n4");
  const captureId = sale.captureId as CaptureId;
  const orderId = sale.order.orderId;
  const fee = 5275n;

  // the fee the provider reports after the completion, while the funds are UNKNOWN: nothing returned yet, the whole amount movable
  const feeEvent = await adopted(orderId, async (uow) => {
    assert.equal((await uow.commerce.captures.observeFee(captureId, 1, { providerFeeCents: fee, observedAt: clock.now(), evidenceHash: sha(`fee-${captureId}`) }, clock.now())).kind, "APPLIED");
    return uow.events.appended.find((e) => e.eventType === "capture.fee_observed.v1")!;
  });
  assert.deepEqual([feeEvent.payload["providerFeeCents"], feeEvent.payload["fundsState"], feeEvent.payload["movableBalanceCents"]], [5275, "UNKNOWN", 97125]);

  // two approved refunds of the capture complete side by side: the first holds its completion open, the second waits for it on the
  // capture's refund lock (refunds_completion_order) and then counts it
  const first = await approved(sale, 1000);
  const firstAttempt = await submitting(sale, first);
  const secondRefund = await approved(sale, 2000);
  const secondAttempt = await submitting(sale, secondRefund);
  const hold = barrier();
  const inFlight = barrier();
  const firstCompletion = adopted(orderId, async (uow) => {
    const event = await completeRefund(uow, first, firstAttempt);
    inFlight.open();
    await hold.wait;
    return event;
  });
  await inFlight.wait;
  const secondCompletion = adopted(orderId, (uow) => completeRefund(uow, secondRefund, secondAttempt));
  await waitForLockWait(h.oracle, "kauro-test-payment", "UPDATE kauro.refunds AS t");
  hold.open();
  const [one, two] = await Promise.all([firstCompletion, secondCompletion]);
  assert.deepEqual([one.payload["serviceBasisAfterCents"], one.payload["movableBalanceCents"], one.payload["fundsState"]], [96125, 91850, "UNKNOWN"], "the first: 97125 less its 1000; the amount less the fee");
  assert.deepEqual([two.payload["serviceBasisAfterCents"], two.payload["movableBalanceCents"], two.payload["fundsState"]], [94125, 90850, "UNKNOWN"], "the second counts the first: 97125 less 3000; the amount less the fee and the first's 1000");

  // the chargeback of the rest, with the entitlement revoked in the same transaction: the unrefunded 94125 against a movable 88850
  await adopted(orderId, async (uow) => {
    const now = clock.now();
    assert.equal((await uow.commerce.captures.advance(captureId, 2, { status: "REVERSED", observedAt: now, evidenceHash: sha(`chargeback-${captureId}`) }, now)).kind, "APPLIED");
    assert.equal((await uow.commerce.authorizations.transition(sale.authorizationId as CommercialAuthorizationId, 1, { state: "REVOKED", revocation: { at: now, phase: "PRE_EXECUTION", code: "CAPTURE_REVERSED" } }, now)).kind, "APPLIED");
  });
  const reversal = await eventOf(captureId, "capture.reversed.v1");
  assert.deepEqual([reversal.payload["reversedServiceCents"], reversal.payload["fundsState"], reversal.payload["movableBalanceCents"]], [94125, "UNKNOWN", 88850]);

  // the FINANCE sets of the five events, each built from its own payload (the order of the posts does not matter)
  const completion = await eventOf(captureId, "capture.completed.v1");
  const fundsOf = (payload: Readonly<Record<string, unknown>>): FundsState => payload["fundsState"] as FundsState;
  const service = (payload: Readonly<Record<string, unknown>>, key: string) => ({ serviceCents: cents(payload, key), taxCents: 0n, excessCents: 0n });
  await post(orderId, reversal.eventId, "CHARGEBACK", captureId, returnPostings(service(reversal.payload, "reversedServiceCents"), fundsOf(reversal.payload), cents(reversal.payload, "movableBalanceCents")));
  await post(orderId, two.eventId, "REFUND", secondRefund, returnPostings(service(two.payload, "serviceCents"), fundsOf(two.payload), cents(two.payload, "movableBalanceCents")));
  await post(orderId, completion.eventId, "CAPTURE", captureId, capturePostings(service(completion.payload, "allocatedServiceCents")));
  await post(orderId, feeEvent.eventId, "FEE", captureId, providerFeePostings(cents(feeEvent.payload, "providerFeeCents"), fundsOf(feeEvent.payload), cents(feeEvent.payload, "movableBalanceCents")));
  await post(orderId, one.eventId, "REFUND", first, returnPostings(service(one.payload, "serviceCents"), fundsOf(one.payload), cents(one.payload, "movableBalanceCents")));

  const balances = await h.oracle.query<{ account_code: string; net: string }>(
    `SELECT account_code, sum(CASE direction WHEN 'DEBIT' THEN amount_cents ELSE -amount_cents END)::text AS net
       FROM kauro.ledger_entries WHERE event_id = ANY ($1::uuid[]) GROUP BY account_code ORDER BY account_code`,
    [[completion.eventId, feeEvent.eventId, one.eventId, two.eventId, reversal.eventId]],
  );
  const net = new Map(balances.rows.map((r) => [r.account_code, BigInt(r.net)]));
  assert.deepEqual(
    ["PSP_RECEIVABLE", "PSP_HELD", "PSP_AVAILABLE", "PROCESSOR_EXPENSE", "CONTRACT_LIABILITY"].map((a) => net.get(a) ?? 0n),
    [0n, 0n, -fee, fee, 0n],
    "the receivable ends at zero (before D-LEDGER-B6 at -5275); the merchant's available balance carries the fee the provider kept",
  );
  assert.ok(![...net.keys()].some((a) => a === "BANK_CASH" || a === "BANK_IN_TRANSIT"), "none of it is bank money");
});

test("D-REF-B7: the database orders the completions of one capture's refunds whatever writes them — with the full-service check run at once in both transactions, the second completion waits for the first on the capture's refund lock (pg_stat_activity) and then sees it, so a full service refund that leaves the entitlement live is refused KP006 and nothing of the second commits", async () => {
  const { h } = env;
  const sale = await paid(env, env.A, "balances-order");
  // two halves of the whole service: together they refund it fully, so the one that completes second must revoke the entitlement
  const a = await approved(sale, 48563);
  await submitting(sale, a);
  const b = await approved(sale, 48562);
  await submitting(sale, b);

  const complete = async (c: Client, refundId: RefundId): Promise<void> => {
    await c.query("UPDATE kauro.refunds SET state = 'COMPLETED', version = 4, completed_at = now(), provider_refund_id = $2, evidence_hash = $3 WHERE refund_id = $1", [refundId, `RF-${refundId.slice(-12)}`, sha(`refund-${refundId}`)]);
    await commerceEvent(c, "refund", refundId, 4, env.A.agencyId, "refund.completed.v1", PAYMENT_SERVICE);
  };
  const begin = async (c: Client): Promise<void> => {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await bindCommerce(c, service(env.A.agencyId));
    // the deferred check of kauro.full_service_refund_revokes_authority runs at each statement's end instead of at COMMIT
    await c.query("SET CONSTRAINTS kauro.refunds_full_service_revokes IMMEDIATE");
  };

  await begin(env.payment);
  await complete(env.payment, a);
  await begin(second);
  const pid = await backendPid(second);
  const observation = await settlesOrWaits(h.oracle, pid, complete(second, b), "the second completion of the capture");
  if (observation.kind !== "WAITING") assert.fail("the second completion of the capture did not wait for the first on the capture's refund lock");
  await env.payment.query("COMMIT");
  const outcome = await observation.pending;
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.status === "rejected" ? (outcome.reason as { code?: string }).code : null, "KP006", "a full service refund that leaves the entitlement live");
  await second.query("ROLLBACK");

  const refunds = await h.oracle.query<{ refund_id: string; state: string }>("SELECT refund_id, state FROM kauro.refunds WHERE refund_id = ANY ($1::uuid[])", [[a, b]]);
  assert.deepEqual(new Map(refunds.rows.map((r) => [r.refund_id, r.state])), new Map([[a, "COMPLETED"], [b, "SUBMITTING"]]));
  const authorization = await h.oracle.query<{ state: string }>("SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [sale.authorizationId]);
  assert.equal(authorization.rows[0]?.state, "ACTIVE");
});
