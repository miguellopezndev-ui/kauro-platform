// CMD034 ReconcilePayment — POST /api/v1/payment-orders/{orderId}/reconcile (package B09, stage-2 mandate M3; design §8 CMD034,
// §6.3, D-PAY-B3, D-LEDGER-B5, D-SETTLE-B1; docs/design/B09-case-map.md CMD034-OK/DENY/RACE). Through the real route of the api the
// composition root builds, M2's reconciler bound to the column-scoped purchased-subject read, M1's commerce unit of work and a real
// PostgreSQL 17. The stored provider queries are the payment service's own (storeProviderQuery: the provider fake's authenticated
// view of an order, kept in the evidence store fake — CONTRACT_FAKE, SIMULATED; real provider queries are package B15's).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ReconcilePaymentView, WebhookAck } from "@kauro/application";
import type { PaymentOrderId } from "@kauro/domain";
import { waitForLockWait } from "@kauro/persistence/testing";
import { PAYMENT_APPLICATION_NAME } from "../src/index.js";
import { captureRun, checkout, deliver, dispatch, paid, paymentWorld, reconcile, rows, serviceToken, storeQuery, type PaymentWorld } from "./payment-support.js";
import { completed, freshKey, outcome } from "./support.js";

let pw: PaymentWorld;
before(async () => {
  pw = await paymentWorld();
});
after(async () => {
  await pw.stop();
});

async function orderRow(orderId: string) {
  return (await rows<{ state: string; version: string }>(pw, "SELECT state, version::text FROM kauro.payment_orders WHERE order_id = $1", [orderId]))[0];
}

async function capturesOf(orderId: string) {
  return rows<{ capture_id: string; status: string; amount_cents: string; allocated_service_cents: string; funds_state: string; first_observation_source: string }>(
    pw,
    "SELECT capture_id, status, amount_cents::text, allocated_service_cents::text, funds_state, first_observation_source FROM kauro.capture_facts WHERE order_id = $1 ORDER BY first_observed_at",
    [orderId],
  );
}

async function observationsOf(orderId: string, artifactRef?: string) {
  return rows<{ source: string; subject_kind: string; effect: string; artifact_ref: string | null }>(
    pw,
    `SELECT source, subject_kind, effect, artifact_ref FROM kauro.provider_observations WHERE order_id = $1 ${artifactRef !== undefined ? "AND artifact_ref = $2" : ""} ORDER BY observed_at, subject_kind`,
    artifactRef !== undefined ? [orderId, artifactRef] : [orderId],
  );
}

/** An order whose capture the provider made while the capture command's response was lost: CAPTURE_UNCERTAIN, attempt UNCERTAIN. */
async function uncertainCapture(seed: string) {
  const order = await checkout(pw, seed);
  pw.paypal.approve(order.providerOrderId);
  pw.paypal.program("ORDERS_V2_CAPTURE", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "APPLIED" });
  const pending = await captureRun(pw, order.orderId as PaymentOrderId, freshKey(`${seed}-capture`));
  assert.equal(pending.kind, "ACCEPTED");
  assert.equal((await orderRow(order.orderId))?.state, "CAPTURE_UNCERTAIN");
  return order;
}

test("OK: a stored provider query advances an uncertain capture to CAPTURED with its authorization and records a partial capture of the same query as an AMOUNT_MISMATCH case", async () => {
  // the uncertain capture: the provider's authenticated view settles it — the fact, the attempt CONFIRMED, the order CAPTURED, one entitlement
  const uncertain = await uncertainCapture("reconcile-ok");
  const artifactRef = await storeQuery(pw, uncertain.providerOrderId);
  const reconciled = completed<ReconcilePaymentView>(await reconcile(pw, uncertain.orderId, { observationRef: artifactRef }), 200);
  assert.deepEqual([reconciled.data.order.state, reconciled.data.order.paymentStatus, reconciled.version], ["CAPTURED", "CONFIRMED", Number((await orderRow(uncertain.orderId))!.version)]);
  assert.deepEqual(reconciled.data.captures.map((c) => [c.status, c.amountCents, c.allocated.serviceCents, c.allocated.excessCents]), [["COMPLETED", "97125", "97125", "0"]]);
  assert.equal(reconciled.data.commercialAuthorization?.state, "ACTIVE");
  assert.ok(reconciled.data.effects.some((e) => e.about === "CAPTURE" && e.effect === "ADVANCED"));
  assert.deepEqual(reconciled.data.openCases.map((c) => c.kind), ["UNCERTAIN_EFFECT"], "the uncertainty stays visible for the owner's review");
  const attempts = await rows<{ state: string }>(pw, "SELECT state FROM kauro.payment_attempts WHERE order_id = $1 AND operation = 'CAPTURE'", [uncertain.orderId]);
  assert.deepEqual(attempts, [{ state: "CONFIRMED" }]);
  assert.deepEqual((await observationsOf(uncertain.orderId, artifactRef)).map((o) => [o.source, o.subject_kind, o.effect]), [["PROVIDER_QUERY", "CAPTURE", "ADVANCED"]]);
  const [fact] = await capturesOf(uncertain.orderId);
  assert.equal(fact?.first_observation_source, "PROVIDER_QUERY");

  // a partial capture of an order, in a stored query of that order: real money recorded with its allocation, never authority —
  // an AMOUNT_MISMATCH case with the partial amount and a KAURO_REMEDY request (S058)
  const partial = await checkout(pw, "reconcile-partial");
  pw.paypal.approve(partial.providerOrderId);
  pw.paypal.captureAtProvider(partial.providerOrderId, { amountCents: 50_000n });
  const partialRef = await storeQuery(pw, partial.providerOrderId);
  const mismatch = completed<ReconcilePaymentView>(await reconcile(pw, partial.orderId, { observationRef: partialRef }), 200);
  assert.deepEqual([mismatch.data.order.state, mismatch.data.commercialAuthorization], ["CAPTURED", undefined]);
  assert.deepEqual(mismatch.data.captures.map((c) => [c.status, c.amountCents, c.allocated.serviceCents]), [["COMPLETED", "50000", "50000"]]);
  assert.deepEqual(mismatch.data.openCases.map((c) => c.kind), ["AMOUNT_MISMATCH"]);
  const cases = await rows<{ kind: string; detail_code: string; amount_cents: string }>(pw, "SELECT kind, detail_code, amount_cents::text FROM kauro.reconciliation_cases WHERE order_id = $1", [partial.orderId]);
  assert.deepEqual(cases, [{ kind: "AMOUNT_MISMATCH", detail_code: "PARTIAL_CAPTURE", amount_cents: "50000" }]);
  const remedy = await rows<{ origin: string; state: string }>(pw, "SELECT origin, state FROM kauro.refunds WHERE order_id = $1", [partial.orderId]);
  assert.deepEqual(remedy, [{ origin: "KAURO_REMEDY", state: "REQUESTED" }]);
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.commercial_authorizations WHERE order_id = $1", [partial.orderId])).length, 0);
});

test("DENY: an order of a foreign tenant is NOT_FOUND, a wrong service identity is NOT_AUTHORIZED, and one missing prerequisite (no stored evidence; evidence of another order) is refused; a held or pending provider balance stays HELD and is never bank cash", async () => {
  const order = await checkout(pw, "reconcile-deny");
  const other = await checkout(pw, "reconcile-deny-other");
  const artifactRef = await storeQuery(pw, order.providerOrderId);
  const journalRows = async () => Number((await rows<{ n: string }>(pw, "SELECT count(*)::text AS n FROM kauro.command_journal WHERE operation = 'CMD034'"))[0]!.n);
  const before = await journalRows();

  // a foreign tenant of the payment service: an id the scope index does not hold as a payment order (another kind, or none)
  for (const foreign of [order.quoteId, "0190d9a1-0000-7000-8000-000000000002"]) {
    assert.equal(outcome(pw.api, await reconcile(pw, foreign, { observationRef: artifactRef })), "404 NOT_FOUND -");
  }
  // a wrong service identity: without PAYMENT_SERVICE, or issued for another environment
  assert.equal(outcome(pw.api, await reconcile(pw, order.orderId, { observationRef: artifactRef }, { token: serviceToken(pw, { serviceId: "fiscal-service" }) })), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  assert.equal(outcome(pw.api, await reconcile(pw, order.orderId, { observationRef: artifactRef }, { token: serviceToken(pw, { environment: "SANDBOX" }) })), "403 NOT_AUTHORIZED SERVICE_ENVIRONMENT_MISMATCH");
  // one missing prerequisite: no stored evidence under the reference; a stored query of another order
  assert.equal(outcome(pw.api, await reconcile(pw, order.orderId, { observationRef: "0190d9a1-0000-7000-8000-000000000003" })), "404 NOT_FOUND EVIDENCE_NOT_FOUND");
  const foreignQuery = await storeQuery(pw, other.providerOrderId);
  assert.equal(outcome(pw.api, await reconcile(pw, order.orderId, { observationRef: foreignQuery })), "409 PRECONDITION_FAILED OBSERVATION_SUBJECT_MISMATCH");
  // nothing written on a refusal: no journal entry, no observation, the order as it was
  assert.equal(await journalRows(), before);
  assert.equal((await observationsOf(order.orderId)).length, 0);
  assert.equal((await orderRow(order.orderId))?.state, "CREATED");

  // a provider balance reported held stays HELD: the funds move between the provider's balances only, never into bank money
  const purchase = await paid(pw, "reconcile-held");
  pw.paypal.updateCapture(purchase.providerCaptureId, { disbursement: "DELAYED" });
  const heldRef = await storeQuery(pw, purchase.providerOrderId);
  const held = completed<ReconcilePaymentView>(await reconcile(pw, purchase.orderId, { observationRef: heldRef }), 200);
  assert.ok(held.data.effects.some((e) => e.about === "CAPTURE" && e.effect === "ADVANCED"));
  const [capture] = await capturesOf(purchase.orderId);
  assert.equal(capture?.funds_state, "HELD");
  const funds = await rows<{ event_id: string; payload: Record<string, unknown> }>(pw, "SELECT event_id, payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'capture.funds_observed.v1'", [purchase.captureId]);
  assert.deepEqual(funds.map((e) => [e.payload["previousFundsState"], e.payload["fundsState"], e.payload["amountCents"]]), [["UNKNOWN", "HELD", 97125]]);
  await dispatch(pw, "FINANCE");
  const lines = await rows<{ account_code: string; direction: string; amount_cents: string }>(pw, "SELECT account_code, direction, amount_cents::text FROM kauro.ledger_entries WHERE event_id = $1 ORDER BY line_no", [funds[0]!.event_id]);
  assert.deepEqual(lines, [
    { account_code: "PSP_HELD", direction: "DEBIT", amount_cents: "97125" },
    { account_code: "PSP_RECEIVABLE", direction: "CREDIT", amount_cents: "97125" },
  ]);
  const bank = await rows<{ n: string }>(pw, "SELECT count(*)::text AS n FROM kauro.ledger_entries WHERE source_ref = $1 AND account_code IN ('BANK_IN_TRANSIT', 'BANK_CASH')", [purchase.captureId]);
  assert.equal(bank[0]!.n, "0", "no provider state is ever bank cash");
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.settlements")).length, 0, "bank-available money exists only in a settlement with bank evidence (B15)");
});

test("RACE: an identical retry replays, the same key with another observationRef is 409 IDEMPOTENCY_CONFLICT with no effect, a crash at the intent/commit boundary applies the artifact once on retry, and reconciliation racing the webhook of the same capture yields one fact", async () => {
  // an identical retry replays; the same key with another stored query conflicts and applies nothing
  const replayed = await uncertainCapture("race-replay");
  const firstRef = await storeQuery(pw, replayed.providerOrderId);
  const key = freshKey("race-replay");
  const first = completed<ReconcilePaymentView>(await reconcile(pw, replayed.orderId, { observationRef: firstRef }, { key }), 200);
  const again = completed<ReconcilePaymentView>(await reconcile(pw, replayed.orderId, { observationRef: firstRef }, { key }), 200);
  assert.deepEqual([again.replayed, again.data], [true, first.data]);
  const secondRef = await storeQuery(pw, replayed.providerOrderId);
  assert.notEqual(secondRef, firstRef);
  assert.equal(outcome(pw.api, await reconcile(pw, replayed.orderId, { observationRef: secondRef }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await observationsOf(replayed.orderId, secondRef)).length, 0);

  // a crash at the intent/commit boundary: nothing commits; the retry under the same key applies the artifact once
  const crashed = await uncertainCapture("race-crash");
  const crashRef = await storeQuery(pw, crashed.providerOrderId);
  const crashKey = freshKey("race-crash");
  pw.holds.arm("CMD034", "INTENT_BEFORE_COMMIT", "CRASH");
  assert.equal(outcome(pw.api, await reconcile(pw, crashed.orderId, { observationRef: crashRef }, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.deepEqual([(await capturesOf(crashed.orderId)).length, (await observationsOf(crashed.orderId, crashRef)).length, (await orderRow(crashed.orderId))?.state], [0, 0, "CAPTURE_UNCERTAIN"]);
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.command_journal WHERE idempotency_key = $1", [crashKey])).length, 0);
  assert.equal(completed<ReconcilePaymentView>(await reconcile(pw, crashed.orderId, { observationRef: crashRef }, { key: crashKey }), 200).data.order.state, "CAPTURED");
  assert.equal((await capturesOf(crashed.orderId)).length, 1);
  assert.deepEqual((await observationsOf(crashed.orderId, crashRef)).map((o) => o.subject_kind), ["CAPTURE"], "the artifact applied once per subject");
  // another key over the same artifact adds nothing: an artifact applies once per subject (provider_observations_once_per_artifact)
  const repeat = completed<ReconcilePaymentView>(await reconcile(pw, crashed.orderId, { observationRef: crashRef }), 200);
  assert.deepEqual(repeat.data.effects.filter((e) => e.about === "CAPTURE").map((e) => e.effect), ["DUPLICATE"]);
  assert.equal((await capturesOf(crashed.orderId)).length, 1);

  // reconciliation racing the webhook of the same capture: the order's row lock orders them; the second sees the first's fact
  const raced = await checkout(pw, "race-webhook");
  pw.paypal.approve(raced.providerOrderId);
  const providerCaptureId = pw.paypal.captureAtProvider(raced.providerOrderId);
  const racedRef = await storeQuery(pw, raced.providerOrderId);
  const hold = pw.holds.arm("CMD034", "INTENT_BEFORE_COMMIT", "WAIT");
  const reconciling = reconcile(pw, raced.orderId, { observationRef: racedRef });
  await hold.reached;
  const delivery = deliver(pw, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
  await waitForLockWait(pw.w.h.oracle, `${PAYMENT_APPLICATION_NAME}-service`, "FROM kauro.payment_orders WHERE order_id = $1 FOR UPDATE");
  hold.release();
  const [query, webhook] = await Promise.all([reconciling, delivery]);
  assert.equal(completed<ReconcilePaymentView>(query, 200).data.order.state, "CAPTURED");
  assert.equal(completed<WebhookAck>(webhook.reply, 200).data.inboxState, "IGNORED", "the delivery that waited found the capture already recorded");
  const facts = await capturesOf(raced.orderId);
  assert.deepEqual(facts.map((f) => [f.status, f.first_observation_source]), [["COMPLETED", "PROVIDER_QUERY"]]);
  assert.deepEqual((await observationsOf(raced.orderId)).filter((o) => o.subject_kind === "CAPTURE").map((o) => [o.source, o.effect]).sort(), [["PROVIDER_QUERY", "ADVANCED"], ["WEBHOOK", "DUPLICATE"]]);
  assert.equal((await rows(pw, "SELECT 1 FROM kauro.commercial_authorizations WHERE order_id = $1", [raced.orderId])).length, 1);
});
