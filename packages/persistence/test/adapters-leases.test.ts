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

/** The lease row as the superuser oracle reads it (independent of the adapter under test). */
async function leaseRow(kind: string, resource: ResourceId): Promise<{ owner: string; fence: number; checkpoint: string | null; expiresAt: string } | null> {
  const r = await h.oracle.query("SELECT owner_id, fence, checkpoint_hash, expires_at FROM kauro.leases WHERE resource_kind = $1 AND resource_id = $2", [kind, resource]);
  const row = r.rows[0];
  return row ? { owner: row.owner_id, fence: Number(row.fence), checkpoint: row.checkpoint_hash, expiresAt: new Date(row.expires_at).toISOString() } : null;
}

test("B06-R1: an expired JOB_ATTEMPT or MODEL_TASK lease that never stored a checkpoint cannot be resumed — another owner's takeover with no checkpoint or an invented one is REFUSED RESUME_WITHOUT_CHECKPOINT and the lease stays as its first owner left it; an OUTBOX_DISPATCH lease, which spends nothing, is still taken over without one, never with an invented one", async () => {
  // Review finding B06-R1 (first half): S090 "RESUME lacks a checkpoint → reject restart; preserve original subject, clock, cost
  // and checkpoint identity". A spending operation that never checkpointed has nothing to resume from: restarting it under the
  // same lease would spend its cost identity again from nothing (R2-076: recover only from a durable checkpoint, or rerun as a
  // new attempt under the same authorized job — a new lease, never a takeover of this one). The instants are the lease
  // functions' own clock parameter (p_now): the lease expires at t0 + 120 s and every claim below states when it happens.
  const t0 = Date.now();
  const deadline = at(t0, 3_600_000);
  const owner1 = ids.next() as LeaseOwnerId;
  const owner2 = ids.next() as LeaseOwnerId;
  for (const resourceKind of ["JOB_ATTEMPT", "MODEL_TASK"] as const) {
    const resource = ids.next() as ResourceId;
    const cost = ids.next();
    const claim = (ownerId: LeaseOwnerId, now: string, checkpointHash: string | null) =>
      h.control.run(h.system(), (uow) => uow.leases.claim({ resourceKind, resourceId: resource, ownerId, ttlSeconds: 120, deadlineAt: deadline, subjectHash: sha("subject"), costAuthorityId: cost, checkpointHash }, now));
    const first = await claim(owner1, at(t0, 0), null);
    assert.deepEqual(first.kind === "CLAIMED" && [first.lease.fence, first.lease.checkpointHash], [1, null], resourceKind);
    // positive control: while the lease is live another owner gets HELD, whatever it names
    assert.equal((await claim(owner2, at(t0, 60_000), null)).kind, "HELD", resourceKind);
    // the lease expired (t0 + 120 s) without a checkpoint: no takeover resumes it, with nothing or with a checkpoint never stored
    assert.deepEqual(await claim(owner2, at(t0, 130_000), null), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" }, `${resourceKind} without a checkpoint`);
    assert.deepEqual(await claim(owner2, at(t0, 130_000), sha("invented checkpoint")), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" }, `${resourceKind} with an invented checkpoint`);
    assert.deepEqual(await leaseRow(resourceKind, resource), { owner: owner1, fence: 1, checkpoint: null, expiresAt: at(t0, 120_000) }, `${resourceKind}: every refusal left the lease as its first owner left it`);
  }
  // an OUTBOX_DISPATCH lease spends nothing: an expired one is taken over without a checkpoint (fence 1 -> 2), but a claim that
  // names a checkpoint the lease never stored is still no resume of it
  const dispatch = ids.next() as ResourceId;
  const claimDispatch = (ownerId: LeaseOwnerId, now: string, checkpointHash: string | null) =>
    h.control.run(h.system(), (uow) => uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId: dispatch, ownerId, ttlSeconds: 120, deadlineAt: deadline, subjectHash: sha("dispatch"), costAuthorityId: null, checkpointHash }, now));
  assert.equal((await claimDispatch(owner1, at(t0, 0), null)).kind, "CLAIMED");
  assert.deepEqual(await claimDispatch(owner2, at(t0, 130_000), sha("invented checkpoint")), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" });
  const taken = await claimDispatch(owner2, at(t0, 130_000), null);
  assert.deepEqual(taken.kind === "CLAIMED" && [taken.lease.ownerId, taken.lease.fence, taken.lease.checkpointHash], [owner2, 2, null]);
});

test("B06-R1: an expired owner re-claiming its own lease is a resume, not a renewal — without the stored checkpoint or with another it is REFUSED RESUME_WITHOUT_CHECKPOINT and keeps no fence; with the stored checkpoint it resumes under a new fence (1 -> 2) that fences its old one out; while the lease is live the holder's re-claim keeps its fence only when it names the stored checkpoint", async () => {
  // Review finding B06-R1 (second half): claim_lease's same-owner branch ran before the expiry check and ignored p_checkpoint,
  // so an expired owner restarted with a missing or wrong checkpoint and kept its old fence. The reviewer's reproduction comes
  // first: a checkpoint stored during the first live lease, then the original owner's claim after expiry.
  const t0 = Date.now();
  const deadline = at(t0, 3_600_000);
  const owner1 = ids.next() as LeaseOwnerId;
  const resource = ids.next() as ResourceId;
  const subject = sha("subject");
  const cost = ids.next();
  const claim = (now: string, checkpointHash: string | null, resourceId: ResourceId = resource) =>
    h.control.run(h.system(), (uow) => uow.leases.claim({ resourceKind: "JOB_ATTEMPT", resourceId, ownerId: owner1, ttlSeconds: 120, deadlineAt: deadline, subjectHash: subject, costAuthorityId: cost, checkpointHash }, now));
  const storeCheckpoint = (resourceId: ResourceId, checkpointHash: string, now: string) =>
    h.control.run(h.system(), async (uow) => assert.equal((await uow.leases.checkpoint("JOB_ATTEMPT", resourceId, owner1, 1, checkpointHash, now))?.checkpointHash, checkpointHash));
  assert.equal((await claim(at(t0, 0), null)).kind, "CLAIMED");
  const checkpoint = sha("checkpoint-1");
  await storeCheckpoint(resource, checkpoint, at(t0, 10_000));
  // expired (t0 + 120 s): the owner's own restart without the checkpoint or with another is refused and changes nothing
  assert.deepEqual(await claim(at(t0, 200_000), null), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" }, "expired re-claim without the checkpoint");
  assert.deepEqual(await claim(at(t0, 200_000), sha("another checkpoint")), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" }, "expired re-claim with another checkpoint");
  assert.deepEqual(await leaseRow("JOB_ATTEMPT", resource), { owner: owner1, fence: 1, checkpoint, expiresAt: at(t0, 120_000) }, "the refusals left the lease as its owner left it");
  // with the stored checkpoint it resumes: a new fence, the same subject, clock, cost and checkpoint identity
  const resumed = await claim(at(t0, 200_000), checkpoint);
  assert.equal(resumed.kind, "CLAIMED");
  if (resumed.kind === "CLAIMED") {
    assert.deepEqual([resumed.lease.ownerId, resumed.lease.fence, resumed.lease.checkpointHash, resumed.lease.deadlineAt, resumed.lease.subjectHash, resumed.lease.costAuthorityId], [owner1, 2, checkpoint, deadline, subject, cost]);
    assert.equal(resumed.lease.expiresAt, at(t0, 320_000));
  }
  await h.control.run(h.system(), async (uow) => {
    assert.equal(await uow.leases.heartbeat("JOB_ATTEMPT", resource, owner1, 1, 120, at(t0, 201_000)), null, "the attempt that expired under fence 1 is fenced out");
    assert.equal(await uow.leases.checkpoint("JOB_ATTEMPT", resource, owner1, 1, sha("late checkpoint"), at(t0, 201_000)), null, "and cannot publish a checkpoint");
    assert.equal((await uow.leases.heartbeat("JOB_ATTEMPT", resource, owner1, 2, 120, at(t0, 201_000)))?.fence, 2);
  });
  // a spending lease its owner let expire before any checkpoint: the owner's own restart is refused too
  const bare = ids.next() as ResourceId;
  assert.equal((await claim(at(t0, 0), null, bare)).kind, "CLAIMED");
  assert.deepEqual(await claim(at(t0, 130_000), null, bare), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" }, "own restart of a spending lease that never checkpointed");
  assert.deepEqual(await leaseRow("JOB_ATTEMPT", bare), { owner: owner1, fence: 1, checkpoint: null, expiresAt: at(t0, 120_000) });
  // live (expires at t0 + 120 s): a re-claim that lacks the stored checkpoint or names another is a restart, refused; one
  // naming it renews under the same fence
  const held = ids.next() as ResourceId;
  assert.equal((await claim(at(t0, 0), null, held)).kind, "CLAIMED");
  await storeCheckpoint(held, checkpoint, at(t0, 10_000));
  assert.deepEqual(await claim(at(t0, 20_000), null, held), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" }, "live re-claim without the checkpoint");
  assert.deepEqual(await claim(at(t0, 20_000), sha("another checkpoint"), held), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" }, "live re-claim with another checkpoint");
  const renewed = await claim(at(t0, 20_000), checkpoint, held);
  assert.deepEqual(renewed.kind === "CLAIMED" && [renewed.lease.fence, renewed.lease.expiresAt, renewed.lease.checkpointHash], [1, at(t0, 140_000), checkpoint], "the live holder renews under its fence");
  // OUTBOX_DISPATCH (spends nothing, never checkpoints): its owner's claim after expiry is a takeover too — fence 1 -> 2
  const dispatch = ids.next() as ResourceId;
  const claimDispatch = (now: string) =>
    h.control.run(h.system(), (uow) => uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId: dispatch, ownerId: owner1, ttlSeconds: 120, deadlineAt: deadline, subjectHash: sha("dispatch"), costAuthorityId: null, checkpointHash: null }, now));
  assert.equal((await claimDispatch(at(t0, 0))).kind, "CLAIMED");
  const live = await claimDispatch(at(t0, 60_000));
  assert.deepEqual(live.kind === "CLAIMED" && live.lease.fence, 1, "a live re-claim renews under the same fence");
  const again = await claimDispatch(at(t0, 200_000));
  assert.deepEqual(again.kind === "CLAIMED" && again.lease.fence, 2, "a re-claim after expiry is a new attempt");
  await h.control.run(h.system(), async (uow) => assert.equal(await uow.leases.heartbeat("OUTBOX_DISPATCH", dispatch, owner1, 1, 120, at(t0, 201_000)), null));
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
