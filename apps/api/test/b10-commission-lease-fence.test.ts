// B10-T1-b gaps D (RACE, EXPIRY) and L2 (RACE; docs/design/B10-failure-matrix.md rows D and L2; decisions D-LEASE-1, D-LEASE-3): every claim
// and every COMMIT of the COMMISSIONS dispatcher is fenced by its lease inside the database transaction that makes it. A dispatcher
// whose lease expired, or that another owner took over under the next fence, claims no batch and commits no effect: the pass ends in a
// typed LEASE_FENCED (batch claim) or a FENCED delivery (effect COMMIT), and nothing it held back is lost for the next owner. Interleavings
// are fixed at named hold points; nothing sleeps. Over PostgreSQL 17 through the runtime login roles, as b10-commission-service.test.ts.
import { invariantsAfterEach, handled } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DomainFailure, type CorrelationId, type LeaseOwnerId, type SystemContext } from "@kauro/domain";
import { DISPATCH_LEASE_DEADLINE, DISPATCH_LEASE_SECONDS, commissionLeaseResource } from "../src/index.js";
import { acceptAttribution, claimsOn, commissionWorld, eventOf, oracleRows, purchase, sellingAgency, type CommissionWorld } from "./commission-support.js";
import { ids } from "./support.js";

let cw: CommissionWorld;
invariantsAfterEach(() => cw.h.oracle);
before(async () => {
  cw = await commissionWorld();
});
after(async () => {
  await cw.stop();
});

const isFenced = (e: unknown): boolean => e instanceof DomainFailure && e.code === "PRECONDITION_FAILED" && e.details.reason === "LEASE_FENCED";

/** Two purchases whose capture.completed.v1 records are the only due COMMISSIONS work, and the lease and records the test watches. */
async function scenario(label: string) {
  for (;;) {
    const pass = await cw.service.dispatcher.runOnce({ limit: 100 });
    if (pass.held || pass.deliveries.length < 100) break;
  }
  const s = await sellingAgency(cw, label);
  const a = await claimsOn(cw, label, 1);
  await acceptAttribution(cw, s.agency.agencyId, a, [10_000], null);
  const first = await purchase(cw, s, `${label}-1`);
  const second = await purchase(cw, s, `${label}-2`);
  const ours = [await eventOf(cw, first.captureId, "capture.completed.v1"), await eventOf(cw, second.captureId, "capture.completed.v1")];
  const lease = async () => (await oracleRows<{ owner_id: string; fence: string; subject_hash: string }>(cw, "SELECT owner_id, fence::text, subject_hash FROM kauro.leases WHERE resource_kind = 'OUTBOX_DISPATCH' AND resource_id = $1", [commissionLeaseResource()]))[0]!;
  const records = async () => oracleRows<{ state: string; attempts: number }>(cw, "SELECT state, attempts FROM kauro.outbox_records WHERE consumer = 'COMMISSIONS' AND event_id = ANY ($1::uuid[]) ORDER BY event_id", [ours]);
  const before = Number((await lease()).fence);
  // the service's own dispatcher held the lease: once it expired, the dispatchers of the test take it
  cw.clock.advance((DISPATCH_LEASE_SECONDS + 1) * 1000);
  return { ours, lease, records, before, a: cw.service.dispatcherOf(), b: cw.service.dispatcherOf() };
}

const outcomesOf = (pass: { readonly deliveries: ReadonlyArray<{ readonly eventId: string; readonly outcome: string }> }, ours: ReadonlyArray<string>) => pass.deliveries.filter((d) => ours.includes(d.eventId)).map((d) => d.outcome);

test("D RACE: a dispatcher that holds the lease but is stalled before its batch claim, while another owner takes the lease over and claims the batch, claims nothing: its pass is refused LEASE_FENCED and each record is claimed once, by the new owner", async () => {
  const { ours, lease, records, before, a, b } = await scenario("d-race");
  const hold = cw.holds.arm("BATCH_BEFORE_CLAIM");
  const passA = handled(a.runOnce({ limit: 100 }));
  await hold.reached;
  const held = await lease();
  assert.deepEqual([held.owner_id, held.fence], [a.ownerId, String(before + 1)]);
  cw.clock.advance(300_000);
  const takeover = await b.runOnce({ limit: 100 });
  assert.deepEqual([takeover.held, takeover.fence], [false, before + 2]);
  assert.deepEqual(outcomesOf(takeover, ours), ["APPLIED", "APPLIED"]);
  const settled = await records();
  assert.deepEqual(settled, [{ state: "DELIVERED", attempts: 1 }, { state: "DELIVERED", attempts: 1 }], "each record was claimed once");
  hold.release();
  await assert.rejects(passA, isFenced, "the stale dispatcher's batch claim raises LEASE_FENCED");
  assert.deepEqual(await records(), settled, "the stale claim changed no record");
  assert.equal(Number((await lease()).fence), before + 2);
});

test("D EXPIRY: a dispatcher whose lease expired between its lease claim and its batch claim claims no record: LEASE_FENCED, the records stay unclaimed and the next owner delivers them", async () => {
  const { ours, lease, records, before, a, b } = await scenario("d-expiry");
  const hold = cw.holds.arm("BATCH_BEFORE_CLAIM");
  const passA = handled(a.runOnce({ limit: 100 }));
  await hold.reached;
  cw.clock.advance((DISPATCH_LEASE_SECONDS + 1) * 1000);
  hold.release();
  await assert.rejects(passA, isFenced);
  assert.deepEqual(await records(), [{ state: "PENDING", attempts: 0 }, { state: "PENDING", attempts: 0 }], "nothing was claimed");
  assert.equal(Number((await lease()).fence), before + 1, "the refused heartbeat renewed nothing");
  const next = await b.runOnce({ limit: 100 });
  assert.equal(next.fence, before + 2);
  assert.deepEqual(outcomesOf(next, ours), ["APPLIED", "APPLIED"]);
  assert.deepEqual(await records(), [{ state: "DELIVERED", attempts: 1 }, { state: "DELIVERED", attempts: 1 }]);
});

test("L2 EXPIRY: an effect whose dispatcher's lease expired mid-effect does not commit: the delivery is FENCED, the record stays CLAIMED and the next owner applies the effect for the first time", async () => {
  const { ours, records, before, a, b } = await scenario("l2-expiry");
  const hold = cw.holds.arm("DELIVERY_BEFORE_COMMIT");
  const passA = handled(a.runOnce({ limit: 100 }));
  await hold.reached;
  cw.clock.advance((DISPATCH_LEASE_SECONDS + 1) * 1000);
  hold.release();
  const resultA = await passA;
  assert.deepEqual(resultA.deliveries.map((d) => [d.outcome, d.errorCode]), [["FENCED", "LEASE_FENCED"]], "the late COMMIT is fenced and the pass stops");
  assert.deepEqual(await records(), [{ state: "CLAIMED", attempts: 1 }, { state: "CLAIMED", attempts: 1 }], "no record was settled");
  cw.clock.advance(300_000);
  const next = await b.runOnce({ limit: 100 });
  assert.equal(next.fence, before + 2);
  assert.deepEqual(outcomesOf(next, ours), ["APPLIED", "APPLIED"], "the fenced effect left nothing behind");
});

test("L2 RACE: an effect whose dispatcher lost the lease to another owner mid-effect does not commit: the delivery is FENCED and the new owner's fence stands", async () => {
  const { ours, lease, records, before, a, b } = await scenario("l2-race");
  const hold = cw.holds.arm("DELIVERY_BEFORE_COMMIT");
  const passA = handled(a.runOnce({ limit: 100 }));
  await hold.reached;
  // the lease expires and another owner takes it over under the next fence while A's effect waits before its COMMIT
  cw.clock.advance((DISPATCH_LEASE_SECONDS + 1) * 1000);
  const control: SystemContext = { kind: "SYSTEM", serviceId: "commission-dispatcher", correlationId: ids.next() as CorrelationId };
  const stored = await lease();
  const other = b.ownerId as LeaseOwnerId;
  const claim = await cw.pools.units.run(control, (uow) =>
    uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId: commissionLeaseResource(), ownerId: other, ttlSeconds: DISPATCH_LEASE_SECONDS, deadlineAt: DISPATCH_LEASE_DEADLINE, subjectHash: stored.subject_hash, costAuthorityId: null, checkpointHash: null }, cw.clock.now()),
  );
  assert.equal(claim.kind, "CLAIMED");
  const taken = await lease();
  assert.deepEqual([taken.owner_id, taken.fence], [other, String(before + 2)]);
  hold.release();
  const resultA = await passA;
  assert.deepEqual(resultA.deliveries.map((d) => [d.outcome, d.errorCode]), [["FENCED", "LEASE_FENCED"]]);
  assert.deepEqual(await records(), [{ state: "CLAIMED", attempts: 1 }, { state: "CLAIMED", attempts: 1 }], "A settled nothing");
  const after = await lease();
  assert.deepEqual([after.owner_id, after.fence], [other, String(before + 2)], "the new owner's fence stands");
  cw.clock.advance(300_000);
  const next = await b.runOnce({ limit: 100 });
  assert.equal(next.fence, before + 3);
  assert.deepEqual(outcomesOf(next, ours), ["APPLIED", "APPLIED"], "the fenced effect left nothing behind");
});
