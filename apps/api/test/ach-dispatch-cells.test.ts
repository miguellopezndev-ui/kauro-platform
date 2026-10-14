// Lane PV1-SETTLE K0 (docs/design/PV1-SETTLE-two-step.md §3.0, §5 D1-D4): the payment dispatcher delivers the closed set of agency-less
// bank events to PAYMENT_SERVICE end to end (the real createPaymentDispatcher pass: lease, claim, effect, settle); any other agency-less
// event stays an INTEGRITY_FAILURE dead letter (never a blanket null agency). Row "Deliver agency-less bank event".
// Red on 5d963424: dispatcher.ts deliveryOf throws INTEGRITY_FAILURE for every event with agencyId null (:55-57).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as dispatcherModule from "../src/payments/dispatcher.js";
import { MAX_DELIVERY_ATTEMPTS } from "../src/payments/dispatcher.js";
import { L, awaitingOrder, confirmed, creditRow, exactFor, importSI2, latestEvent, q, startLane, statementArtifact, stopLane } from "./inbound-lane-support.js";
import { advance, deliveryIn, dispatchPayment, drain, inTransit, laneAllConsumersDispatcher, outboxOf, recorded, recordedEventOf, requestRow } from "./settlement-support.js";
import { ids } from "./support.js";
import { settlementOracleAfterEach } from "./settlement-oracle.js";

settlementOracleAfterEach();
before(async () => {
  await startLane();
});
after(async () => {
  await stopLane();
});

const t = (verb: string, id: string, label: string): string => `${verb} ${id} (${label}): Deliver agency-less bank event`;
const outboxOfEvent = async (eventId: string): Promise<readonly [string, number, string | null]> => {
  const [r] = await q<{ s: string; a: number; e: string | null }>("SELECT state AS s, attempts AS a, last_error_code AS e FROM kauro.outbox_records WHERE event_id = $1 AND consumer = 'PAYMENT_SERVICE'", [eventId]);
  assert.ok(r !== undefined, `${eventId} has a PAYMENT_SERVICE outbox record`);
  return [r.s, r.a, r.e] as const;
};

test(t("OK", "SET-M-DSP-OK", "settlement request recorded"), async () => {
  // D1: settlement_request.recorded.v1 through one real pass: APPLIED, DELIVERED at attempt 1
  await drain();
  const { w, requestId } = await recorded("dsp-set-ok");
  const pass = await dispatchPayment();
  const d = await deliveryIn(pass, requestId);
  assert.deepEqual([d.outcome, d.errorCode], ["APPLIED", undefined], `the agency-less intent is delivered to the service: ${JSON.stringify(d)}`);
  const ob = await outboxOf(requestId);
  assert.deepEqual([ob.state, ob.attempts, ob.error], ["DELIVERED", 1, null]);
  assert.equal((await requestRow(requestId)).state, "APPLIED");
  assert.equal(await w.effect(), "SETTLED");
});

test(t("OK", "ACH-M-DSP-OK", "bank_credit.matched.v1"), async () => {
  // D2: an exact credit: received.v1 -> MATCHED, then matched.v1 -> APPLIED with its capture, both DELIVERED, by real passes
  await drain();
  const o = await awaitingOrder("dsp-ach-ok");
  const c = await confirmed(o.route.accountRef, exactFor(o));
  const received = await latestEvent(c.creditId, "bank_credit.received.v1");
  assert.ok(received !== undefined, "C6 published bank_credit.received.v1");
  const first = (await dispatchPayment()).deliveries.find((x) => x.eventId === received);
  assert.deepEqual([first?.outcome, first?.errorCode], ["APPLIED", undefined], `received.v1 is delivered (agency null, enumerated): ${JSON.stringify(first)}`);
  assert.equal((await creditRow(c.creditId))?.state, "MATCHED", "Kmatch ran");
  const matched = await latestEvent(c.creditId, "bank_credit.matched.v1");
  assert.ok(matched !== undefined, "Kmatch published bank_credit.matched.v1");
  const second = (await dispatchPayment()).deliveries.find((x) => x.eventId === matched);
  assert.deepEqual([second?.outcome, second?.errorCode], ["APPLIED", undefined], `matched.v1 is delivered: ${JSON.stringify(second)}`);
  const row = await creditRow(c.creditId);
  assert.equal(row?.state, "APPLIED", "Kapply ran");
  assert.ok(row?.capture_id !== null && row?.capture_id !== undefined, "the order's capture exists");
  assert.deepEqual([await outboxOfEvent(received), await outboxOfEvent(matched)], [["DELIVERED", 1, null], ["DELIVERED", 1, null]]);
});

test(t("DENY", "SET-M-DSP-DEAD_LETTER", "timeout"), async () => {
  // D3: the bank binding absent: CAPACITY_UNAVAILABLE retried at each retryAt, dead-lettered at attempt 10; the page shows DEAD_LETTER
  await drain();
  const { w, requestId } = await recorded("dsp-dead-letter");
  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    const d = await deliveryIn(await dispatchPayment({ bank: false }), requestId);
    const expected = attempt < MAX_DELIVERY_ATTEMPTS ? "FAILED" : "DEAD_LETTER";
    assert.deepEqual([d.outcome, d.errorCode], [expected, "CAPACITY_UNAVAILABLE"], `attempt ${attempt}: ${JSON.stringify(d)}`);
    const ob = await outboxOf(requestId);
    assert.deepEqual([ob.state, ob.attempts, ob.error], [attempt < MAX_DELIVERY_ATTEMPTS ? "RETRYABLE" : "DEAD_LETTER", attempt, "CAPACITY_UNAVAILABLE"], `attempt ${attempt}: the outbox record`);
    // past the retryAt the dispatcher set (min(300, 2^attempt) s on its clock)
    advance(301_000);
  }
  assert.equal((await requestRow(requestId)).state, "RECORDED", "never applied, never refused for a missing binding");
  const item = (await inTransit(w.accountRef)).items.find((i) => i.requestId === requestId);
  assert.equal(item?.delivery, "DEAD_LETTER", "the owner sees the dead letter in transit");
});

test(t("DENY", "SET-M-DSP-UNLISTED", "dead letter for a non-enumerated agency-less type"), async () => {
  // D4: an agency-less event outside AGENCY_LESS_PAYMENT_EVENT_TYPES forged onto PAYMENT_SERVICE: INTEGRITY_FAILURE dead letter at 1
  const set = (dispatcherModule as unknown as Record<string, unknown>)["AGENCY_LESS_PAYMENT_EVENT_TYPES"];
  assert.deepEqual(set instanceof Set ? [...set].sort() : Array.isArray(set) ? [...(set as string[])].sort() : set, ["bank_credit.matched.v1", "bank_credit.received.v1", "settlement_request.recorded.v1"], "the closed set of agency-less PAYMENT_SERVICE event types is exported");
  await drain();
  const accountRef = (await awaitingOrder("dsp-unlisted")).route.accountRef;
  const now = Date.now();
  const st = await statementArtifact(accountRef, { from: new Date(now - 2 * 3_600_000).toISOString(), to: new Date(now - 3_600_000).toISOString(), credits: [], debits: [] });
  const imported = await importSI2(accountRef, st);
  assert.equal(imported.status, 201, imported.text);
  const [e] = await q<{ id: string }>("SELECT event_id::text AS id FROM kauro.domain_events WHERE aggregate_kind = 'statement_import' AND event_type = 'statement_import.recorded.v1' AND agency_id IS NULL ORDER BY sequence DESC LIMIT 1");
  assert.ok(e !== undefined, "SI2 published an agency-less statement_import.recorded.v1");
  await L().iw.h.oracle.query(
    "INSERT INTO kauro.outbox_records (outbox_id, event_id, consumer, state, attempts, next_attempt_at, created_at, updated_at) VALUES ($1, $2, 'PAYMENT_SERVICE', 'PENDING', 0, now() - interval '1 second', now(), now()) ON CONFLICT (event_id, consumer) DO NOTHING",
    [ids.next(), e.id],
  );
  const d = (await dispatchPayment()).deliveries.find((x) => x.eventId === e.id);
  assert.deepEqual([d?.outcome, d?.errorCode], ["DEAD_LETTER", "INTEGRITY_FAILURE"], `an unlisted agency-less type is never delivered: ${JSON.stringify(d)}`);
  assert.deepEqual(await outboxOfEvent(e.id), ["DEAD_LETTER", 1, "INTEGRITY_FAILURE"]);
});

test(t("DENY", "SET-M-DSP-CONSUMER", "agency-less events only to PAYMENT_SERVICE"), async () => {
  // D5 (ADV-5): each of the three enumerated agency-less types forged onto FINANCE and FISCAL is an INTEGRITY_FAILURE dead letter at 1:
  // the allowlist applies to PAYMENT_SERVICE only, never as a blanket null agency for another consumer
  await drain();
  for (const other of ["FINANCE", "FISCAL"] as const) {
    for (let i = 0; i < 5; i++) if ((await laneAllConsumersDispatcher().runOnce(other, { limit: 100 })).deliveries.length === 0) break;
  }
  const { requestId } = await recorded("dsp-consumer");
  const o = await awaitingOrder("dsp-consumer-credit");
  const c = await confirmed(o.route.accountRef, exactFor(o));
  const received = await latestEvent(c.creditId, "bank_credit.received.v1");
  assert.ok(received !== undefined, "C6 published bank_credit.received.v1");
  assert.equal((await dispatchPayment()).deliveries.find((x) => x.eventId === received)?.outcome, "APPLIED", "Kmatch ran");
  const matched = await latestEvent(c.creditId, "bank_credit.matched.v1");
  assert.ok(matched !== undefined, "Kmatch published bank_credit.matched.v1");
  const types = new Map<string, string>([
    ["settlement_request.recorded.v1", await recordedEventOf(requestId)],
    ["bank_credit.received.v1", received],
    ["bank_credit.matched.v1", matched],
  ]);
  assert.deepEqual([...types.keys()].sort(), [...dispatcherModule.AGENCY_LESS_PAYMENT_EVENT_TYPES].sort(), "all three enumerated types are forged");
  const effects = async (): Promise<string> =>
    JSON.stringify(
      (await q<Record<string, string>>(
        `SELECT (SELECT count(*) FROM kauro.ledger_entries)::text AS ledger, (SELECT count(*) FROM kauro.domain_events)::text AS events, (SELECT count(*) FROM kauro.capture_facts)::text AS captures,
                (SELECT coalesce(string_agg(state, ',' ORDER BY bank_credit_id), '') FROM kauro.bank_credits)::text AS credits, (SELECT coalesce(string_agg(outcome, ',' ORDER BY request_id), '-') FROM kauro.settlement_requests)::text AS requests`,
      ))[0],
    );
  for (const other of ["FINANCE", "FISCAL"] as const) {
    for (const [type, eventId] of types) {
      await L().iw.h.oracle.query(
        "INSERT INTO kauro.outbox_records (outbox_id, event_id, consumer, state, attempts, next_attempt_at, created_at, updated_at) VALUES ($1, $2, $3, 'PENDING', 0, now() - interval '1 second', now(), now()) ON CONFLICT (event_id, consumer) DO NOTHING",
        [ids.next(), eventId, other],
      );
      const before = await effects();
      const pass = await laneAllConsumersDispatcher().runOnce(other, { limit: 100 });
      const d = pass.deliveries.find((x) => x.eventId === eventId);
      assert.deepEqual([d?.outcome, d?.errorCode], ["DEAD_LETTER", "INTEGRITY_FAILURE"], `${type} on ${other} is never delivered: ${JSON.stringify(d)} in ${JSON.stringify(pass)}`);
      const [r] = await q<{ s: string; a: number; e: string | null }>("SELECT state AS s, attempts AS a, last_error_code AS e FROM kauro.outbox_records WHERE event_id = $1 AND consumer = $2", [eventId, other]);
      assert.deepEqual([r?.s, r?.a, r?.e], ["DEAD_LETTER", 1, "INTEGRITY_FAILURE"], `${type} on ${other}: the outbox record`);
      assert.equal(await effects(), before, `${type} on ${other}: no consumer effect`);
    }
  }
});
