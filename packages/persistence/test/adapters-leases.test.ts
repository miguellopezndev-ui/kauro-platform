// Lease fencing through the LeaseStore adapter on real PostgreSQL 17 (contract Lease: an old live worker cannot publish
// after another owner advances the fence; 07 "Job and attempt states": a claim creates a monotonically increasing fence;
// a renewal cannot change the immutable execution subject; S090: reject a restart that lacks the checkpoint or resets the
// absolute deadline; preserve subject, clock, cost and checkpoint identity — the cost identity being the funding authority
// the operation spends against, 07 "CommercialAuthorization" and contract Audit; 21 "Concurrency and crash matrix": stale
// lease renewal). The store runs under the control plane (kauro_control); request handlers have no access to leases at all.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isDomainFailure, toUtcInstant, type DomainFailure, type LeaseOwnerId, type ResourceId, type UserId } from "@kauro/domain";
import { ids, sha, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";

let h: Harness;
let owner: UserId;
let A: AgencyFixture;

before(async () => {
  h = await start();
  owner = await h.person("owner-leases");
  A = await h.createAgency(owner, "Lease Agency");
});
after(async () => {
  await h.stop();
});

function failure(e: unknown): DomainFailure {
  assert.ok(isDomainFailure(e), `expected a DomainFailure, got ${String(e)}`);
  return e;
}

const at = (base: number, offsetMs: number) => toUtcInstant(base + offsetMs);

test("S090 through the adapter: claim, HELD, checkpoint under the fence, refused resumes (no or another checkpoint, reset deadline, another subject, another cost authority), a valid takeover that keeps subject, clock, cost and checkpoint identity, advances the fence and fences the old owner out", async () => {
  const resource = ids.next() as ResourceId;
  const subject = sha("subject");
  // the cost identity of the leased job attempt: the CommercialAuthorization its technical retries run under
  const cost = ids.next();
  const t0 = Date.now();
  const deadline = at(t0, 3_600_000);
  const owner1 = ids.next() as LeaseOwnerId;
  const owner2 = ids.next() as LeaseOwnerId;
  const claim = (ownerId: LeaseOwnerId, now: string, checkpointHash: string | null, deadlineAt = deadline, subjectHash = subject, costAuthorityId: string | null = cost) =>
    h.control.run(h.system(), (uow) => uow.leases.claim({ resourceKind: "JOB_ATTEMPT", resourceId: resource, ownerId, ttlSeconds: 120, deadlineAt, subjectHash, costAuthorityId, checkpointHash }, now));

  const first = await claim(owner1, at(t0, 0), null);
  assert.equal(first.kind, "CLAIMED");
  if (first.kind === "CLAIMED") {
    assert.equal(first.lease.fence, 1);
    assert.equal(first.lease.checkpointHash, null);
    assert.equal(first.lease.deadlineAt, deadline);
    assert.equal(first.lease.costAuthorityId, cost);
    assert.equal(first.lease.expiresAt, at(t0, 120_000));
  }
  const held = await claim(owner2, at(t0, 1_000), null);
  assert.equal(held.kind, "HELD");
  if (held.kind === "HELD") assert.equal(held.lease.ownerId, owner1);
  // the holder renews itself (same owner, same fence) and stores a checkpoint under its fence
  const renewed = await claim(owner1, at(t0, 60_000), null);
  assert.equal(renewed.kind, "CLAIMED");
  if (renewed.kind === "CLAIMED") assert.equal(renewed.lease.fence, 1);
  const checkpoint = sha("checkpoint-1");
  await h.control.run(h.system(), async (uow) => {
    const stored = await uow.leases.checkpoint("JOB_ATTEMPT", resource, owner1, 1, checkpoint, at(t0, 61_000));
    assert.equal(stored?.checkpointHash, checkpoint);
    assert.equal(await uow.leases.checkpoint("JOB_ATTEMPT", resource, owner1, 2, sha("x"), at(t0, 61_000)), null, "a wrong fence stores nothing");
    assert.equal(await uow.leases.checkpoint("JOB_ATTEMPT", resource, owner2, 1, sha("x"), at(t0, 61_000)), null, "a non-owner stores nothing");
  });
  // the lease expires; a takeover must carry the stored checkpoint identity and the original deadline and subject
  const late = at(t0, 200_000);
  assert.deepEqual(await claim(owner2, late, null), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" });
  assert.deepEqual(await claim(owner2, late, sha("other checkpoint")), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" });
  assert.deepEqual(await claim(owner2, late, checkpoint, at(t0, 7_200_000)), { kind: "REFUSED", reason: "DEADLINE_IMMUTABLE" });
  assert.deepEqual(await claim(owner2, late, checkpoint, deadline, sha("another subject")), { kind: "REFUSED", reason: "SUBJECT_IMMUTABLE" });
  // a restart under a fresh grant or entitlement would reset what the operation already spent: the cost identity is kept
  assert.deepEqual(await claim(owner2, late, checkpoint, deadline, subject, ids.next()), { kind: "REFUSED", reason: "COST_IMMUTABLE" });
  assert.deepEqual(await claim(owner2, late, checkpoint, deadline, subject, null), { kind: "REFUSED", reason: "COST_IMMUTABLE" });
  // every refusal left the lease exactly as the first owner holds it
  const untouched = await h.oracle.query("SELECT owner_id, fence, deadline_at, subject_hash, cost_authority_id, checkpoint_hash FROM kauro.leases WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1", [resource]);
  assert.deepEqual(untouched.rows.map((r) => [r.owner_id, Number(r.fence), new Date(r.deadline_at).toISOString(), r.subject_hash, r.cost_authority_id, r.checkpoint_hash]), [[owner1, 1, deadline, subject, cost, checkpoint]]);
  const resumed = await claim(owner2, late, checkpoint);
  assert.equal(resumed.kind, "CLAIMED");
  if (resumed.kind === "CLAIMED") {
    assert.equal(resumed.lease.fence, 2);
    assert.equal(resumed.lease.ownerId, owner2);
    assert.equal(resumed.lease.checkpointHash, checkpoint);
    assert.equal(resumed.lease.deadlineAt, deadline);
    assert.equal(resumed.lease.subjectHash, subject);
    assert.equal(resumed.lease.costAuthorityId, cost);
  }
  await h.control.run(h.system(), async (uow) => {
    assert.equal(await uow.leases.heartbeat("JOB_ATTEMPT", resource, owner1, 1, 120, at(t0, 201_000)), null, "the old owner is fenced out");
    assert.equal(await uow.leases.checkpoint("JOB_ATTEMPT", resource, owner1, 1, sha("late checkpoint"), at(t0, 201_000)), null, "the old owner cannot publish a checkpoint");
    const fresh = await uow.leases.heartbeat("JOB_ATTEMPT", resource, owner2, 2, 120, at(t0, 201_000));
    assert.equal(fresh?.fence, 2);
    assert.equal(fresh?.expiresAt, at(t0, 321_000));
    const cancelled = await uow.leases.cancel("JOB_ATTEMPT", resource, at(t0, 202_000));
    assert.equal(cancelled?.cancelVersion, 1);
    const read = await uow.leases.get("JOB_ATTEMPT", resource);
    assert.deepEqual({ owner: read?.ownerId, fence: read?.fence, cancel: read?.cancelVersion, checkpoint: read?.checkpointHash }, { owner: owner2, fence: 2, cancel: 1, checkpoint });
    assert.equal(await uow.leases.get("JOB_ATTEMPT", ids.next() as ResourceId), null);
  });
  // a claim after the absolute deadline is refused; expiry never extends past the deadline
  assert.deepEqual(await claim(owner1, at(t0, 3_600_001), checkpoint), { kind: "REFUSED", reason: "DEADLINE_PASSED" });
  const shortResource = ids.next() as ResourceId;
  const shortDeadline = at(t0, 60_000);
  const capped = await h.control.run(h.system(), (uow) => uow.leases.claim({ resourceKind: "SWEEP", resourceId: shortResource, ownerId: owner1, ttlSeconds: 120, deadlineAt: shortDeadline, subjectHash: subject, costAuthorityId: null, checkpointHash: null }, at(t0, 0)));
  assert.equal(capped.kind, "CLAIMED");
  if (capped.kind === "CLAIMED") assert.deepEqual([capped.lease.expiresAt, capped.lease.costAuthorityId], [shortDeadline, null]);
  // an operation that spends must name its cost identity, and one that spends nothing names none (leases_cost_authority_by_kind)
  const spending = { resourceKind: "MODEL_TASK", resourceId: ids.next() as ResourceId, ownerId: owner1, ttlSeconds: 120, deadlineAt: deadline, subjectHash: subject, checkpointHash: null } as const;
  await assert.rejects(h.control.run(h.system(), (uow) => uow.leases.claim({ ...spending, costAuthorityId: null }, at(t0, 0))), (e: unknown) => failure(e).code === "INVALID_REQUEST");
  await assert.rejects(h.control.run(h.system(), (uow) => uow.leases.claim({ ...spending, resourceKind: "OUTBOX_DISPATCH", costAuthorityId: ids.next() }, at(t0, 0))), (e: unknown) => failure(e).code === "INVALID_REQUEST");
  const grantBound = await h.control.run(h.system(), (uow) => uow.leases.claim({ ...spending, costAuthorityId: cost }, at(t0, 0)));
  assert.equal(grantBound.kind === "CLAIMED" && grantBound.lease.costAuthorityId, cost);
});

test("a refused claim does not abort the unit of work: a sweeper claims several leases in one transaction and answers each refusal on its own", async () => {
  const t0 = Date.now();
  const deadline = at(t0, 3_600_000);
  const held = ids.next() as ResourceId;
  const free = ids.next() as ResourceId;
  const first = ids.next() as LeaseOwnerId;
  const sweeper = ids.next() as LeaseOwnerId;
  await h.control.run(h.system(), async (uow) => {
    const c = await uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId: held, ownerId: first, ttlSeconds: 120, deadlineAt: deadline, subjectHash: sha("s"), costAuthorityId: null, checkpointHash: null }, at(t0, 0));
    assert.equal(c.kind, "CLAIMED");
    const stored = await uow.leases.checkpoint("OUTBOX_DISPATCH", held, first, 1, sha("cp"), at(t0, 1));
    assert.equal(stored?.checkpointHash, sha("cp"));
  });
  const outcomes = await h.control.run(h.system(), async (uow) => {
    const late = at(t0, 300_000);
    const refused = await uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId: held, ownerId: sweeper, ttlSeconds: 120, deadlineAt: deadline, subjectHash: sha("s"), costAuthorityId: null, checkpointHash: null }, late);
    const claimed = await uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId: free, ownerId: sweeper, ttlSeconds: 120, deadlineAt: deadline, subjectHash: sha("s2"), costAuthorityId: null, checkpointHash: null }, late);
    const resumed = await uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId: held, ownerId: sweeper, ttlSeconds: 120, deadlineAt: deadline, subjectHash: sha("s"), costAuthorityId: null, checkpointHash: sha("cp") }, late);
    return { refused: refused.kind, claimed: claimed.kind, resumed: resumed.kind, resumedFence: resumed.kind === "CLAIMED" ? resumed.lease.fence : null };
  });
  assert.deepEqual(outcomes, { refused: "REFUSED", claimed: "CLAIMED", resumed: "CLAIMED", resumedFence: 2 });
  const rows = await h.oracle.query("SELECT resource_id, owner_id, fence FROM kauro.leases WHERE resource_id IN ($1, $2) ORDER BY fence", [held, free]);
  assert.deepEqual(rows.rows.map((r) => [r.resource_id, r.owner_id, Number(r.fence)]), [[free, sweeper, 1], [held, sweeper, 2]]);
});

test("request handlers have no access to leases (kauro_app has no policy and no grant); a zero ttl is refused before the database", async () => {
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.leases.get("SWEEP", ids.next() as ResourceId)),
    (e: unknown) => failure(e).code === "NOT_FOUND" && failure(e).details.reason === "TENANT_CONTEXT_MISSING",
  );
  await assert.rejects(
    h.control.run(h.system(), (uow) => uow.leases.claim({ resourceKind: "SWEEP", resourceId: ids.next() as ResourceId, ownerId: ids.next() as LeaseOwnerId, ttlSeconds: 0, deadlineAt: at(Date.now(), 60_000), subjectHash: sha("s"), costAuthorityId: null, checkpointHash: null }, toUtcInstant(Date.now()))),
    (e: unknown) => failure(e).code === "INVALID_REQUEST",
  );
});
