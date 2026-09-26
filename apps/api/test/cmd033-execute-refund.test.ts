// CMD033 ExecuteRefund — POST /api/v1/refunds/{refundId}/execute (package B09, stage-2 mandate M3; design §8 CMD033, §6.1,
// D-PROTO-B1..B6, D-REF-B5, D-REF-B7; docs/design/B09-case-map.md CMD033-OK/DENY/RACE). Through the real route of the api the
// composition root builds, M2's provider-effect runtime with the payment service as its principal, M1's commerce unit of work and
// a real PostgreSQL 17. The provider is M2's labelled PayPal contract fake and the service identity is minted by M2's service
// authenticator fake (CONTRACT_FAKE, SIMULATED). The refunds are requested and approved through M1's adapters (the request side's
// writes, never M4's routes); crashes are injected at the protocol's hold points.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AcceptedResponse, ExecuteRefundView } from "@kauro/application";
import { approvedRefund, deliver, dispatch, execute, paid, paymentWorld, requestedRefund, rows, serviceToken, type PaymentWorld } from "./payment-support.js";
import { asProblem, completed, freshKey, outcome } from "./support.js";

let pw: PaymentWorld;
before(async () => {
  pw = await paymentWorld();
});
after(async () => {
  await pw.stop();
});

async function refundRow(refundId: string) {
  return (await rows<{ state: string; version: string; provider_refund_id: string | null; failure_code: string | null }>(pw, "SELECT state, version::text, provider_refund_id, failure_code FROM kauro.refunds WHERE refund_id = $1", [refundId]))[0];
}

async function refundAttempts(refundId: string) {
  return rows<{ attempt_id: string; state: string; provider_request_id: string; ordinal: number }>(pw, "SELECT attempt_id, state, provider_request_id, ordinal FROM kauro.payment_attempts WHERE refund_id = $1 ORDER BY ordinal", [refundId]);
}

async function journalOf(key: string) {
  return (await rows<{ state: string; actor_kind: string; actor_id: string; response_status: number | null }>(pw, "SELECT state, actor_kind, actor_id, response_status FROM kauro.command_journal WHERE idempotency_key = $1", [key]))[0];
}

function refundDispatches(providerRequestId?: string) {
  return pw.paypal.calls.filter((c) => c.operation === "DISPATCH CAPTURES_V2_REFUND" && (providerRequestId === undefined || c.identity === providerRequestId));
}

test("OK: the payment service executes an approved refund once — SUBMITTING, the provider refund under the attempt's identity, COMPLETED with refund.completed.v1 to FINANCE, FISCAL, COMMISSIONS and NOTIFICATIONS", async () => {
  const purchase = await paid(pw, "execute-ok");
  const refundId = await approvedRefund(pw, purchase, 1_000n);
  const effectsBefore = pw.paypal.effects.refunds;
  const key = freshKey("execute-ok");
  const executed = completed<ExecuteRefundView>(await execute(pw, refundId, { expectedVersion: 2 }, { key }), 200);
  assert.deepEqual([executed.data.refund.state, executed.data.refund.serviceCents, executed.data.refund.amountsBasis, executed.data.attemptState, executed.version], ["COMPLETED", "1000", "APPROVED", "CONFIRMED", 4]);

  // one REFUND attempt, CONFIRMED, whose provider request identity is its own; one provider refund under exactly it
  const [attempt, ...more] = await refundAttempts(refundId);
  assert.equal(more.length, 0);
  assert.deepEqual([attempt!.state, attempt!.provider_request_id, attempt!.ordinal], ["CONFIRMED", `kauro-${attempt!.attempt_id}`, 1]);
  assert.equal(refundDispatches(attempt!.provider_request_id).length, 1);
  assert.equal(pw.paypal.effects.refunds, effectsBefore + 1);
  const refund = await refundRow(refundId);
  assert.equal(refund?.state, "COMPLETED");
  assert.match(refund?.provider_refund_id ?? "", /^PPR/);

  // every version's event, by the payment service; the completion addressed to its four subscribers
  const events = await rows<{ aggregate_version: string; event_type: string; actor_kind: string; event_id: string; payload: Record<string, unknown> }>(pw, "SELECT aggregate_version::text, event_type, actor_kind, event_id, payload FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [refundId]);
  assert.deepEqual(events.map((e) => [e.aggregate_version, e.event_type, e.actor_kind]), [
    ["1", "refund.requested.v1", "USER"],
    ["2", "refund.approved.v1", "USER"],
    ["3", "refund.submitting.v1", "SERVICE"],
    ["4", "refund.completed.v1", "SERVICE"],
  ]);
  const completion = events[3]!;
  assert.deepEqual([completion.payload["serviceCents"], completion.payload["serviceBasisAfterCents"], completion.payload["fundsState"], completion.payload["movableBalanceCents"]], [1000, 96125, "UNKNOWN", 97125]);
  const consumers = await rows<{ consumer: string }>(pw, "SELECT consumer FROM kauro.outbox_records WHERE event_id = $1 ORDER BY consumer", [completion.event_id]);
  assert.deepEqual(consumers.map((c) => c.consumer), ["COMMISSIONS", "FINANCE", "FISCAL", "NOTIFICATIONS"]);
  assert.deepEqual(await journalOf(key), { state: "COMMITTED", actor_kind: "SERVICE", actor_id: "payment-service", response_status: 200 });
  const authorization = await rows<{ state: string }>(pw, "SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [purchase.authorizationId]);
  assert.deepEqual(authorization, [{ state: "ACTIVE" }], "a partial refund leaves the service basis and the entitlement");

  // the final effects follow the event once each: the ledger's return posting and the credit note draft (its invoice not issued yet)
  await dispatch(pw, "FISCAL");
  await dispatch(pw, "FINANCE");
  const posting = await rows<{ account_code: string; direction: string; amount_cents: string }>(pw, "SELECT account_code, direction, amount_cents::text FROM kauro.ledger_entries WHERE source_kind = 'REFUND' AND source_ref = $1 ORDER BY line_no", [refundId]);
  assert.ok(posting.length > 0 && posting.some((l) => l.account_code === "PSP_RECEIVABLE" && l.direction === "CREDIT" && l.amount_cents === "1000"), "the refund's money leaves the receivable it was in");
  const documents = await rows<{ kind: string; state: string; refund_id: string | null; service_cents: string }>(pw, "SELECT kind, state, refund_id, service_cents::text FROM kauro.tax_documents WHERE capture_id = $1 ORDER BY kind", [purchase.captureId]);
  assert.deepEqual(documents, [
    { kind: "CREDIT_NOTE", state: "DRAFT", refund_id: refundId, service_cents: "1000" },
    { kind: "INVOICE", state: "VALIDATED", refund_id: null, service_cents: "97125" },
  ]);
  // a redelivered approval executes nothing: the refund executor's key is the refund's version, which moved on
  await dispatch(pw, "PAYMENT_SERVICE");
  assert.equal(refundDispatches(attempt!.provider_request_id).length, 1);
  assert.equal((await refundAttempts(refundId)).length, 1);
});

test("DENY: a refund of a foreign tenant is NOT_FOUND, a wrong service identity is NOT_AUTHORIZED, and one missing prerequisite (not APPROVED; a reversed capture lapses it) is refused; a refund timeout stays UNCERTAIN (202) and a second execute is refused until reconciled — one provider refund call", async () => {
  const purchase = await paid(pw, "execute-deny");
  const refundId = await approvedRefund(pw, purchase, 1_000n);
  const serviceFacts = (correlationId: unknown) =>
    rows<{ actor_kind: string; actor_id: string; outcome: string; reason_code: string; agency_id: string | null }>(pw, "SELECT actor_kind, actor_id, outcome, reason_code, agency_id FROM kauro.security_events WHERE action = 'CMD033' AND correlation_id = $1", [correlationId]);

  // a foreign tenant of the payment service is a stored operation the scope index does not hold as a refund: another kind, or none
  for (const foreign of [purchase.orderId, "0190d9a1-0000-7000-8000-000000000001"]) {
    const denied = await execute(pw, foreign, { expectedVersion: 2 });
    assert.equal(outcome(pw.api, denied), "404 NOT_FOUND -");
    assert.deepEqual(await serviceFacts(denied.headers["x-correlation-id"]), [{ actor_kind: "SERVICE", actor_id: "payment-service", outcome: "DENY", reason_code: "NOT_FOUND", agency_id: null }]);
  }
  // the wrong role of a service: an identity without PAYMENT_SERVICE, or issued for another environment; no identity at all
  const fiscal = await execute(pw, refundId, { expectedVersion: 2 }, { token: serviceToken(pw, { serviceId: "fiscal-service" }) });
  assert.equal(outcome(pw.api, fiscal), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  assert.deepEqual(await serviceFacts(fiscal.headers["x-correlation-id"]), [{ actor_kind: "SERVICE", actor_id: "fiscal-service", outcome: "DENY", reason_code: "SERVICE_NOT_PERMITTED", agency_id: null }]);
  const elsewhere = await execute(pw, refundId, { expectedVersion: 2 }, { token: serviceToken(pw, { environment: "LIVE" }) });
  assert.equal(outcome(pw.api, elsewhere), "403 NOT_AUTHORIZED SERVICE_ENVIRONMENT_MISMATCH");
  const anonymous = await execute(pw, refundId, { expectedVersion: 2 }, { token: null });
  assert.equal(outcome(pw.api, anonymous), "401 AUTHENTICATION_REQUIRED -");
  assert.deepEqual(await refundRow(refundId), { state: "APPROVED", version: "2", provider_refund_id: null, failure_code: null });
  assert.equal((await refundAttempts(refundId)).length, 0, "no attempt, no provider call");

  // one missing prerequisite: a request nobody approved is never executed (a request is not permission for a provider transfer)
  const requested = await requestedRefund(pw, await paid(pw, "execute-deny-requested"), 1_000n);
  const notApproved = await execute(pw, requested, { expectedVersion: 1 });
  assert.equal(outcome(pw.api, notApproved), "409 PRECONDITION_FAILED REFUND_NOT_APPROVED");
  assert.deepEqual(asProblem(pw.api, notApproved).current, { version: 1, state: "REQUESTED" });

  // a reversed capture lapses the approved refund in the reversal's own transaction: nothing is left to execute
  const reversedPurchase = await paid(pw, "execute-deny-reversed");
  const lapsing = await approvedRefund(pw, reversedPurchase, 1_000n);
  pw.paypal.updateCapture(reversedPurchase.providerCaptureId, { status: "REVERSED" });
  const reversal = await deliver(pw, "PAYMENT.CAPTURE.REVERSED", reversedPurchase.providerCaptureId);
  assert.equal(reversal.reply.status, 200);
  assert.deepEqual(await refundRow(lapsing), { state: "FAILED", version: "3", provider_refund_id: null, failure_code: "CAPTURE_REVERSED" });
  const lapsed = await execute(pw, lapsing, { expectedVersion: 3 });
  assert.equal(outcome(pw.api, lapsed), "409 PRECONDITION_FAILED REFUND_NOT_APPROVED");
  assert.equal((await refundAttempts(lapsing)).length, 0);

  // a timeout stays UNCERTAIN: 202 with the durable operation, never a blind second financial effect
  const timedOut = await approvedRefund(pw, await paid(pw, "execute-deny-timeout"), 1_000n);
  pw.paypal.program("CAPTURES_V2_REFUND", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "NOT_APPLIED" });
  const key = freshKey("execute-timeout");
  const pending = await execute(pw, timedOut, { expectedVersion: 2 }, { key });
  assert.equal(pending.status, 202);
  const accepted = pending.json<AcceptedResponse>();
  assert.deepEqual([accepted.kind, accepted.operationId, accepted.state, accepted.statusPath], ["ACCEPTED", timedOut, "UNCERTAIN", `/api/v1/refunds/${timedOut}`]);
  const [uncertain] = await refundAttempts(timedOut);
  assert.equal(uncertain?.state, "UNCERTAIN");
  assert.equal((await refundRow(timedOut))?.state, "UNCERTAIN");
  assert.equal((await journalOf(key))?.state, "UNCERTAIN");
  const cases = await rows<{ kind: string; refund_id: string }>(pw, "SELECT kind, refund_id FROM kauro.reconciliation_cases WHERE refund_id = $1", [timedOut]);
  assert.deepEqual(cases, [{ kind: "UNCERTAIN_EFFECT", refund_id: timedOut }], "the unresolved effect is visible");
  const second = await execute(pw, timedOut, { expectedVersion: 4 });
  assert.equal(outcome(pw.api, second), "409 PAYMENT_UNCERTAIN REFUND_UNCERTAIN");
  const resumed = await execute(pw, timedOut, { expectedVersion: 2 }, { key });
  assert.equal(resumed.status, 202, "the same key observes the refund by its request identity and stays uncertain");
  assert.equal(refundDispatches(uncertain!.provider_request_id).length, 1, "one provider refund call");
  assert.ok(pw.paypal.calls.some((c) => c.operation === "OBSERVE_REFUND_BY_REQUEST" && c.identity === uncertain!.provider_request_id));
});

test("RACE: an identical retry resumes the one operation, the same key with another expectedVersion is 409 IDEMPOTENCY_CONFLICT with no effect, a crash before the intent commits leaves nothing, a crash between the intent commit and the claim resumes to one provider refund, a crash between the claim and the settle (after the provider call) observes the refund by its request identity and never dispatches it again, and two executions under two keys give one claim and 409 PAYMENT_PENDING", async () => {
  // an identical retry replays the one operation; the same key with another expectedVersion is a conflict with no effect
  const retried = await approvedRefund(pw, await paid(pw, "race-retry"), 1_000n);
  const key = freshKey("race-retry");
  const first = await execute(pw, retried, { expectedVersion: 2 }, { key });
  const done = completed<ExecuteRefundView>(first, 200);
  const replay = completed<ExecuteRefundView>(await execute(pw, retried, { expectedVersion: 2 }, { key }), 200);
  assert.deepEqual([replay.replayed, replay.data], [true, done.data]);
  const conflict = await execute(pw, retried, { expectedVersion: 3 }, { key });
  assert.equal(outcome(pw.api, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  const [retriedAttempt, ...retriedMore] = await refundAttempts(retried);
  assert.equal(retriedMore.length, 0);
  assert.equal(refundDispatches(retriedAttempt!.provider_request_id).length, 1);

  // a crash before the intent commits leaves nothing: no attempt, no journal entry, the refund APPROVED; the retry is a new execution
  const early = await approvedRefund(pw, await paid(pw, "race-early"), 1_000n);
  const earlyKey = freshKey("race-early");
  pw.holds.arm("CMD033", "INTENT_BEFORE_COMMIT", "CRASH");
  assert.equal(outcome(pw.api, await execute(pw, early, { expectedVersion: 2 }, { key: earlyKey })), "500 INTERNAL_ERROR -");
  assert.deepEqual([(await refundAttempts(early)).length, await journalOf(earlyKey), (await refundRow(early))?.state], [0, undefined, "APPROVED"]);
  assert.equal(completed<ExecuteRefundView>(await execute(pw, early, { expectedVersion: 2 }, { key: earlyKey }), 200).data.refund.state, "COMPLETED");

  // a crash between the intent commit and the claim: the intent is durable, nothing was dispatched; the same key resumes to one refund
  const claimless = await approvedRefund(pw, await paid(pw, "race-claim"), 1_000n);
  const claimKey = freshKey("race-claim");
  pw.holds.arm("CMD033", "AFTER_INTENT", "CRASH");
  assert.equal((await execute(pw, claimless, { expectedVersion: 2 }, { key: claimKey })).status, 500);
  const [prepared] = await refundAttempts(claimless);
  assert.deepEqual([prepared?.state, (await journalOf(claimKey))?.state, (await refundRow(claimless))?.state, refundDispatches(prepared?.provider_request_id).length], ["PREPARED", "RESERVED", "APPROVED", 0]);
  assert.equal(completed<ExecuteRefundView>(await execute(pw, claimless, { expectedVersion: 2 }, { key: claimKey }), 200).data.refund.state, "COMPLETED");
  assert.deepEqual([(await refundAttempts(claimless)).length, refundDispatches(prepared!.provider_request_id).length], [1, 1]);

  // a crash between the claim and the settle, after the provider refunded: the same key observes by request identity, never dispatches again
  const called = await approvedRefund(pw, await paid(pw, "race-call"), 1_000n);
  const callKey = freshKey("race-call");
  const refundsBefore = pw.paypal.effects.refunds;
  pw.holds.arm("CMD033", "AFTER_CALL", "CRASH");
  assert.equal((await execute(pw, called, { expectedVersion: 2 }, { key: callKey })).status, 500);
  const [dispatched] = await refundAttempts(called);
  assert.deepEqual([dispatched?.state, (await refundRow(called))?.state, pw.paypal.effects.refunds], ["DISPATCHING", "SUBMITTING", refundsBefore + 1]);
  const settled = completed<ExecuteRefundView>(await execute(pw, called, { expectedVersion: 2 }, { key: callKey }), 200);
  assert.deepEqual([settled.data.refund.state, settled.data.attemptState], ["COMPLETED", "CONFIRMED"]);
  assert.equal(refundDispatches(dispatched!.provider_request_id).length, 1, "never dispatched again");
  assert.ok(pw.paypal.calls.some((c) => c.operation === "OBSERVE_REFUND_BY_REQUEST" && c.identity === dispatched!.provider_request_id));
  assert.equal(pw.paypal.effects.refunds, refundsBefore + 1);

  // two executions under two keys: the first's intent holds the refund's one live attempt, the second is 409 PAYMENT_PENDING
  const contested = await approvedRefund(pw, await paid(pw, "race-two"), 1_000n);
  const hold = pw.holds.arm("CMD033", "AFTER_INTENT", "WAIT");
  const winner = execute(pw, contested, { expectedVersion: 2 }, { key: freshKey("race-two-a") });
  await hold.reached;
  const loser = await execute(pw, contested, { expectedVersion: 2 }, { key: freshKey("race-two-b") });
  assert.equal(outcome(pw.api, loser), "409 PAYMENT_PENDING REFUND_IN_PROGRESS");
  hold.release();
  assert.equal(completed<ExecuteRefundView>(await winner, 200).data.refund.state, "COMPLETED");
  const attempts = await refundAttempts(contested);
  assert.deepEqual(attempts.map((a) => a.state), ["CONFIRMED"], "one claim, one attempt");
  assert.equal(refundDispatches(attempts[0]!.provider_request_id).length, 1);
});
