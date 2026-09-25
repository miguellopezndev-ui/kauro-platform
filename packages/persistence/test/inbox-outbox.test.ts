// The outbox dispatch and inbox consumer stores of the control plane on real PostgreSQL 17 (re-check finding N20; 07 "Outbox,
// inbox and event ordering": outbox dispatch is at least once, consumers deduplicate by their own durable inbox identity and
// verify state before an effect; 15 "Webhooks and reconciliation"). The stores run inside control-plane units of work (SYSTEM
// context, kauro_control); the request handlers only enqueue (with their events) and never claim or settle.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { isDomainFailure, toUtcInstant, type InboxId, type OutboxId, type UnitOfWork, type UserId } from "@kauro/domain";
import { PgOutboxDispatchStore } from "../src/index.js";
import { clock, ids, sha, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { bind, sqlState, tx } from "./support.js";

let h: Harness;
let app: Client;
let owner: UserId;
let A: AgencyFixture;

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  owner = await h.person("owner-outbox-dispatch");
  // CreateAgency publishes agency.created.v1, whose registered consumer is NOTIFICATIONS: one PENDING outbox record
  A = await h.createAgency(owner, "Dispatch A");
});
after(async () => {
  await app.end();
  await h.stop();
});

const at = (ms: number) => toUtcInstant(ms);
const control = <T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> => h.control.run(h.system(), fn);

test("N20: the dispatcher claims due records of its consumer with their event, delivers under the attempt it claimed, retries, dead-letters, and a claim that expired and was taken again settles nothing (FENCED)", async () => {
  const t0 = Date.now() + 1_000;
  const claimed = await control((uow) => uow.outboxDispatch.claim("NOTIFICATIONS", 10, at(t0), 30));
  const mine = claimed.find((d) => d.event.agencyId === A.agencyId && d.event.eventType === "agency.created.v1");
  assert.ok(mine, "the agency.created.v1 record is due for NOTIFICATIONS");
  assert.equal(mine.attempt, 1);
  assert.deepEqual([mine.event.aggregateKind, mine.event.aggregateId, mine.event.aggregateVersion], ["agency", A.agencyId, 1]);
  assert.equal(typeof mine.event.payload, "object");
  // claimed and not yet due again: another claim of the same consumer does not return it
  const again = await control((uow) => uow.outboxDispatch.claim("NOTIFICATIONS", 10, at(t0 + 1_000), 30));
  assert.equal(again.some((d) => d.outboxId === mine.outboxId), false);
  // a failure makes it RETRYABLE at the given time; claimed again when due, as attempt 2
  assert.equal(await control((uow) => uow.outboxDispatch.failed(mine.outboxId, 1, "PROVIDER_TIMEOUT", at(t0 + 5_000), at(t0 + 2_000))), "SETTLED");
  const notYet = await control((uow) => uow.outboxDispatch.claim("NOTIFICATIONS", 10, at(t0 + 4_000), 30));
  assert.equal(notYet.some((d) => d.outboxId === mine.outboxId), false);
  const second = (await control((uow) => uow.outboxDispatch.claim("NOTIFICATIONS", 10, at(t0 + 6_000), 1))).find((d) => d.outboxId === mine.outboxId);
  assert.equal(second?.attempt, 2);
  // that claim lasts one second; at t0+8s it has expired and another dispatcher claims attempt 3 — the stale attempt 2 is fenced
  const third = (await control((uow) => uow.outboxDispatch.claim("NOTIFICATIONS", 10, at(t0 + 8_000), 30))).find((d) => d.outboxId === mine.outboxId);
  assert.equal(third?.attempt, 3);
  assert.equal(await control((uow) => uow.outboxDispatch.delivered(mine.outboxId, 2, at(t0 + 9_000))), "FENCED");
  assert.equal(await control((uow) => uow.outboxDispatch.delivered(mine.outboxId, 3, at(t0 + 9_000))), "SETTLED");
  assert.equal(await control((uow) => uow.outboxDispatch.delivered(mine.outboxId, 3, at(t0 + 9_500))), "FENCED", "a delivered record is final");
  const row = await h.oracle.query("SELECT state, attempts, delivered_at IS NOT NULL AS delivered, last_error_code FROM kauro.outbox_records WHERE outbox_id = $1", [mine.outboxId]);
  assert.deepEqual(row.rows[0], { state: "DELIVERED", attempts: 3, delivered: true, last_error_code: null });
  // a record with no retry left is DEAD_LETTER
  const other = await h.createAgency(await h.person("owner-dead-letter"), "Dispatch B");
  const dead = (await control((uow) => uow.outboxDispatch.claim("NOTIFICATIONS", 10, at(t0 + 10_000), 30))).find((d) => d.event.agencyId === other.agencyId);
  assert.ok(dead);
  assert.equal(await control((uow) => uow.outboxDispatch.failed(dead.outboxId, dead.attempt, "RECIPIENT_REJECTED", null, at(t0 + 11_000))), "SETTLED");
  const deadRow = await h.oracle.query("SELECT state, last_error_code FROM kauro.outbox_records WHERE outbox_id = $1", [dead.outboxId]);
  assert.deepEqual(deadRow.rows[0], { state: "DEAD_LETTER", last_error_code: "RECIPIENT_REJECTED" });
});

test("N20: two dispatchers claiming at once take disjoint records (SKIP LOCKED), and the request handlers can neither claim nor settle a record", async () => {
  const agencies: AgencyFixture[] = [];
  for (let i = 0; i < 4; i++) agencies.push(await h.createAgency(await h.person(`owner-disjoint-${i}`), `Disjoint ${i}`));
  const t0 = Date.now() + 60_000;
  const c1 = await h.pg.connect("kauro_control_test");
  const c2 = await h.pg.connect("kauro_control_test");
  try {
    await c1.query("BEGIN");
    await c2.query("BEGIN");
    const first = await new PgOutboxDispatchStore(c1).claim("NOTIFICATIONS", 2, at(t0), 30);
    const secondClaim = await new PgOutboxDispatchStore(c2).claim("NOTIFICATIONS", 100, at(t0), 30);
    const firstIds = new Set(first.map((d) => d.outboxId));
    assert.equal(first.length, 2);
    assert.equal(secondClaim.some((d) => firstIds.has(d.outboxId)), false, "the second dispatcher skipped the rows the first holds");
    const mineInSecond = secondClaim.filter((d) => agencies.some((a) => a.agencyId === d.event.agencyId)).length;
    const mineInFirst = first.filter((d) => agencies.some((a) => a.agencyId === d.event.agencyId)).length;
    assert.equal(mineInFirst + mineInSecond, 4, "together they claimed each record once");
    await c1.query("COMMIT");
    await c2.query("COMMIT");
  } finally {
    await c1.end();
    await c2.end();
  }
  // the request handlers of the agency enqueue with their events only: no claim, no settlement
  const record = (await h.oracle.query("SELECT outbox_id FROM kauro.outbox_records r JOIN kauro.domain_events e ON e.event_id = r.event_id WHERE e.agency_id = $1 LIMIT 1", [agencies[0]!.agencyId])).rows[0].outbox_id as OutboxId;
  await assert.rejects(tx(app, { agencyId: agencies[0]!.agencyId, userId: agencies[0]!.ownerUserId }, (c) => new PgOutboxDispatchStore(c).claim("NOTIFICATIONS", 10, at(t0 + 120_000), 30)), (e: unknown) => isDomainFailure(e) && e.code === "NOT_FOUND");
  await assert.rejects(tx(app, { agencyId: agencies[0]!.agencyId, userId: agencies[0]!.ownerUserId }, (c) => c.query("UPDATE kauro.outbox_records SET state = 'DELIVERED', delivered_at = now() WHERE outbox_id = $1", [record])), (e: unknown) => sqlState(e) === "42501");
  // a SYSTEM unit of work on the request-handler pool is refused (D-CTX-1): the stores are the control plane's
  await assert.rejects(h.app.run(h.system(), (uow) => uow.outboxDispatch.claim("NOTIFICATIONS", 1, clock.now(), 30)), (e: unknown) => isDomainFailure(e) && e.code === "INTEGRITY_FAILURE");
});

test("N20: the consumer claims recorded provider events once (PROCESSING), settles them once, reclaims a stale claim, and deduplication is by provider, environment and event id", async () => {
  const record = (externalEventId: string, environment: "LIVE" | "SANDBOX" = "LIVE") =>
    h.inboxIngress.record({ inboxId: ids.next() as InboxId, provider: "paypal", environment, externalEventId, bodyHash: sha(`body-${externalEventId}-${environment}`), receivedAt: clock.now() });
  const live = await record("WH-1");
  const sandbox = await record("WH-1", "SANDBOX");
  assert.equal(live.kind, "RECORDED");
  assert.equal(sandbox.kind, "RECORDED", "sandbox and live events cannot collide (07 \"Inbox identity includes provider and environment\")");
  assert.notEqual(live.inboxId, sandbox.inboxId);
  const claimed = await control((uow) => uow.inbox.claim(10, 60));
  const ids1 = claimed.map((r) => r.inboxId);
  assert.ok(ids1.includes(live.inboxId) && ids1.includes(sandbox.inboxId));
  // claimed records are not claimed again while their claim is fresh
  const fresh = await control((uow) => uow.inbox.claim(10, 3_600));
  assert.equal(fresh.some((r) => r.inboxId === live.inboxId), false);
  // a crashed consumer's claim is stale for a sweeper that reclaims every older PROCESSING record
  const reclaimed = await control((uow) => uow.inbox.claim(10, 0));
  assert.ok(reclaimed.some((r) => r.inboxId === live.inboxId));
  assert.equal(await control((uow) => uow.inbox.settle(live.inboxId, "APPLIED", clock.now())), true);
  assert.equal(await control((uow) => uow.inbox.settle(live.inboxId, "IGNORED", clock.now())), false, "a settled record stays settled");
  await assert.rejects(h.oracle.query("UPDATE kauro.inbox_records SET state = 'RETRYABLE', applied_at = NULL WHERE inbox_id = $1", [live.inboxId]), (e: unknown) => sqlState(e) === "KA007");
  assert.equal(await control((uow) => uow.inbox.settle(sandbox.inboxId, "RETRYABLE", clock.now())), true);
  const rows = await h.oracle.query("SELECT inbox_id, state FROM kauro.inbox_records WHERE inbox_id = ANY($1::uuid[]) ORDER BY state", [[live.inboxId, sandbox.inboxId]]);
  assert.deepEqual(rows.rows, [
    { inbox_id: live.inboxId, state: "APPLIED" },
    { inbox_id: sandbox.inboxId, state: "RETRYABLE" },
  ]);
  // the consumer's claim needs the control plane: the ingress role reads references only
  const ingress = await h.pg.connect("kauro_ingress_test");
  try {
    await ingress.query("BEGIN");
    await bind(ingress, {});
    await assert.rejects(ingress.query("UPDATE kauro.inbox_records SET state = 'PROCESSING' WHERE inbox_id = $1", [sandbox.inboxId]), (e: unknown) => sqlState(e) === "42501");
    await ingress.query("ROLLBACK");
  } finally {
    await ingress.end();
  }
});
