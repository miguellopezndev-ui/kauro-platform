// Existing B06-B08 race, expiry, revocation and retry tests re-expressed as failure-matrix cells of the common fault harness
// (docs/design/FAULT-HARNESS.md), each beside its original, which stays as it is:
//   B06-R1  adapters-leases.test.ts        a lease takeover without a checkpoint                         [expiry]
//   B08-R1  execution-migrations.test.ts   a revoked source admission fencing a job's publication          [revocation]
//   R2-045  execution-migrations.test.ts   the authorization's revocation vs the publication, both orders  [race]
//   B07-R1  source-adapters.test.ts        a retried release claim vs a newer hold                         [retry]
// Each cell asserts what its original asserts; the harness adds that the fault really happened (the clock moved, the wait was
// observed in pg_stat_activity in every order, the request was repeated) and fails the cell otherwise.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { Client } from "pg";
import type {
  EventProvenance,
  HoldReleaseId,
  LeaseOwnerId,
  ObjectHoldId,
  ProjectId,
  ResourceId,
  RevisionId,
  SealAttemptId,
  SourceFileId,
  StoredObjectId,
  UserId,
} from "@kauro/domain";
import { PgEventPublisher } from "../src/event-publisher.js";
import { PgExecutionStore } from "../src/execution/store.js";
import { PgSourceStore } from "../src/index.js";
import { admitJob, endJob, faultCell, launchJob, publishJob, queueJob, readySourceRevision, admitSourceFile, stageJob, verifyJob, type RaceRun } from "../src/testing/index.js";
import { commerceEvent, service } from "./commerce-support.js";
import { closeExecutionEnv, oracle, openExecutionEnv, purchase, refusedTransaction, revokeAuthorization, type ExecutionEnv } from "./execution-support.js";
import { clock, ids, project, sha, sourceSessions, sqlState, tx } from "./support.js";

let env: ExecutionEnv;

before(async () => {
  env = await openExecutionEnv("fault-cells");
});
after(async () => {
  await closeExecutionEnv(env);
});

const bindAgency = (c: Client, agencyId: string) => c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [agencyId]).then(() => undefined);
const bindPayment = (c: Client, agencyId: string) =>
  c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true), set_config('kauro.finance_agency_id', '', true)", [agencyId]).then(() => undefined);

/** The control plane's execution store on a raw connection inside a transaction the cell holds. */
function rawStore(c: Client): PgExecutionStore {
  const provenance = (): EventProvenance => ({ actor: { kind: "SERVICE", serviceId: "control-plane" }, causationId: ids.next() as EventProvenance["causationId"], correlationId: ids.next() as EventProvenance["correlationId"] });
  return new PgExecutionStore({ db: c, ids, events: new PgEventPublisher(c, ids, clock), provenance });
}

async function verifiedJob(seed: string) {
  const p = await purchase(env, env.A, seed);
  const job = await queueJob(env.h, env.A, p.authorizationId);
  await admitJob(env.h, env.A, job.jobId);
  await launchJob(env.h, env.A, job.jobId);
  await stageJob(env.h, env.A, job.jobId);
  const pkg = await verifyJob(env.h, env.A, job.jobId);
  return { p, job, pkg };
}
type VerifiedJob = Awaited<ReturnType<typeof verifiedJob>>;

const publishRaw = (c: Client, v: VerifiedJob, seed: string) => rawStore(c).publish({ jobId: v.job.jobId, packageVersionId: v.pkg.packageVersionId, deliveryManifestHash: sha(seed), anchorId: ids.next() });

/** OBJECT_INVENTORY's revocation of the first INCLUDED sealed file of the project's revision (GENERATION_CHANGED), under its transition lock. */
async function revokeIncludedFile(c: Client, agencyId: string, projectId: string): Promise<void> {
  const [f] = (
    await c.query<{ file_id: string; version: number }>(
      `SELECT s.file_id, f.version FROM kauro.sealed_revision_files s JOIN kauro.source_files f ON f.agency_id = s.agency_id AND f.file_id = s.file_id
         JOIN kauro.dataset_revisions r ON r.agency_id = s.agency_id AND r.revision_id = s.revision_id
        WHERE r.project_id = $1 AND r.state = 'SEALED' AND s.disposition = 'INCLUDED' ORDER BY s.ordinal LIMIT 1`,
      [projectId],
    )
  ).rows;
  assert.ok(f, "the revision seals an included file");
  await c.query("SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.source_files', $1::uuid::text))", [f.file_id]);
  const r = await c.query<{ version: number }>(
    `UPDATE kauro.source_files SET state = 'ADMISSION_REVOKED', admitted = false, revoked_at = kauro.server_now(), revocation_reason = 'GENERATION_CHANGED', version = $2 + 1
      WHERE file_id = $1 AND version = $2 RETURNING version`,
    [f.file_id, f.version],
  );
  assert.equal(r.rowCount, 1, "the admission is revoked");
  await commerceEvent(c, "source_file", f.file_id, Number(r.rows[0]!.version), agencyId, "source_file.admission_revoked.v1", { kind: "SERVICE", id: "object-inventory" });
}

const rejectedWith = (outcome: PromiseSettledResult<void> | null | undefined, code: string) => outcome?.status === "rejected" && sqlState(outcome.reason) === code;

// --- B06-R1 (adapters-leases.test.ts) ----------------------------------------------------------------------------------------------
faultCell(
  {
    id: "B06-R1",
    step: "LeaseStore.claim takeover of an expired JOB_ATTEMPT, MODEL_TASK or OUTBOX_DISPATCH lease that never stored a checkpoint",
    fault: "expiry",
    expect: "HELD while live; once expired a spending lease is REFUSED RESUME_WITHOUT_CHECKPOINT with none or an invented one and stays as its first owner left it; OUTBOX_DISPATCH is taken over at fence 2 without one, never with an invented one",
  },
  async (ctx) => {
    const owner1 = ids.next() as LeaseOwnerId;
    const owner2 = ids.next() as LeaseOwnerId;
    const deadline = ctx.clock.at(3_600_000);
    const expiresAt = ctx.clock.at(120_000);
    const claim = (resourceKind: "JOB_ATTEMPT" | "MODEL_TASK" | "OUTBOX_DISPATCH", resourceId: ResourceId, ownerId: LeaseOwnerId, checkpointHash: string | null) =>
      env.h.control.run(env.h.system(), (uow) =>
        uow.leases.claim({ resourceKind, resourceId, ownerId, ttlSeconds: 120, deadlineAt: deadline, subjectHash: sha(resourceKind === "OUTBOX_DISPATCH" ? "dispatch" : "subject"), costAuthorityId: resourceKind === "OUTBOX_DISPATCH" ? null : ids.next(), checkpointHash }, ctx.clock.now()),
      );
    const leaseRow = async (kind: string, resource: ResourceId) => {
      const r = await env.h.oracle.query("SELECT owner_id, fence, checkpoint_hash, expires_at FROM kauro.leases WHERE resource_kind = $1 AND resource_id = $2", [kind, resource]);
      const row = r.rows[0];
      return row ? { owner: row.owner_id, fence: Number(row.fence), checkpoint: row.checkpoint_hash, expiresAt: new Date(row.expires_at).toISOString() } : null;
    };
    const spending = (["JOB_ATTEMPT", "MODEL_TASK"] as const).map((kind) => ({ kind, resource: ids.next() as ResourceId }));
    const dispatch = ids.next() as ResourceId;
    for (const { kind, resource } of spending) {
      const first = await claim(kind, resource, owner1, null);
      assert.deepEqual(first.kind === "CLAIMED" && [first.lease.fence, first.lease.checkpointHash], [1, null], kind);
    }
    assert.equal((await claim("OUTBOX_DISPATCH", dispatch, owner1, null)).kind, "CLAIMED");
    // positive control: while the lease is live another owner gets HELD, whatever it names
    ctx.clock.advance(60_000);
    for (const { kind, resource } of spending) assert.equal((await claim(kind, resource, owner2, null)).kind, "HELD", kind);
    // past the expiry: no takeover resumes a spending lease that never checkpointed
    ctx.clock.past(expiresAt, 10_000);
    for (const { kind, resource } of spending) {
      assert.deepEqual(await claim(kind, resource, owner2, null), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" }, `${kind} without a checkpoint`);
      assert.deepEqual(await claim(kind, resource, owner2, sha("invented checkpoint")), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" }, `${kind} with an invented checkpoint`);
      assert.deepEqual(await leaseRow(kind, resource), { owner: owner1, fence: 1, checkpoint: null, expiresAt }, `${kind}: every refusal left the lease as its first owner left it`);
    }
    assert.deepEqual(await claim("OUTBOX_DISPATCH", dispatch, owner2, sha("invented checkpoint")), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" });
    const taken = await claim("OUTBOX_DISPATCH", dispatch, owner2, null);
    assert.deepEqual(taken.kind === "CLAIMED" && [taken.lease.ownerId, taken.lease.fence, taken.lease.checkpointHash], [owner2, 2, null]);
  },
);

// --- B08-R1 (execution-migrations.test.ts) -----------------------------------------------------------------------------------------
faultCell(
  {
    id: "B08-R1",
    step: "JOB_EXECUTION publication while OBJECT_INVENTORY revokes an INCLUDED sealed file's admission (the revision still SEALED)",
    fault: "revocation",
    expect: "the publication waits on the file's transition lock and is refused KA081 at COMMIT, a later one too; the package stays VERIFIED_PRIVATE, the authorization CONSUMED; an admitted neighbour publishes",
  },
  async (ctx) => {
    const revoker = await env.h.pg.connect("kauro_control_test");
    let run: RaceRun<VerifiedJob>;
    try {
      run = await ctx.inOrder<VerifiedJob>(
        {
          oracle: env.h.oracle,
          actors: [
            { name: "revocation", client: revoker, begin: (c) => bindAgency(c, env.A.agencyId), act: (c, v) => revokeIncludedFile(c, env.A.agencyId, v.p.projectId) },
            { name: "publication", client: env.control, begin: (c) => bindAgency(c, env.A.agencyId), act: (c, v) => publishRaw(c, v, "b08-r1-one") },
          ],
          setup: () => verifiedJob("cell-b08-r1-revocation-first"),
          verify({ outcomes }) {
            assert.equal(outcomes["revocation"]?.committed, true);
            assert.equal(outcomes["publication"]?.act.status, "fulfilled", "the publication writes its edges; the database decides at COMMIT");
            assert.ok(rejectedWith(outcomes["publication"]?.commit, "KA081"), "no package becomes AVAILABLE once an included file's admission is revoked");
          },
        },
        "revocation",
      );
    } finally {
      await revoker.end();
    }
    const one = run.state;
    assert.deepEqual(await oracle(env, "SELECT r.state FROM kauro.dataset_revisions r JOIN kauro.projects p ON p.current_revision_id = r.revision_id WHERE p.project_id = $1", [one.p.projectId]), [{ state: "SEALED" }], "the revision itself is still SEALED");
    assert.deepEqual(await oracle(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [one.pkg.packageVersionId]), [{ state: "VERIFIED_PRIVATE" }]);
    assert.deepEqual(await oracle(env, "SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [one.p.authorizationId]), [{ state: "CONSUMED" }], "never DELIVERED");
    await refusedTransaction(env.control, service(env.A.agencyId), (c) => publishRaw(c, one, "b08-r1-again"), "KA081", "a publication after the committed revocation");
    await endJob(env.h, env.A, one.job.jobId, "SOURCE_ADMISSION_REVOKED");
    const neighbour = await verifiedJob("cell-b08-r1-neighbour");
    assert.equal((await publishJob(env.h, env.A, neighbour.job.jobId)).kind, "PUBLISHED");
    assert.deepEqual(await oracle(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [neighbour.pkg.packageVersionId]), [{ state: "AVAILABLE" }]);
  },
);

// --- R2-045 (execution-migrations.test.ts) -----------------------------------------------------------------------------------------
faultCell(
  {
    id: "R2-045",
    step: "JOB_EXECUTION publication vs the payment service's revocation of the job's consumed authorization",
    fault: "race",
    expect: "they serialize on the authorization's transition lock in both orders: revocation first, the publication is refused KA081 at COMMIT with its evidence and private artifacts kept; publication first, the package is AVAILABLE and the revocation lands POST_DELIVERY",
  },
  async (ctx) => {
    await ctx.bothOrders<VerifiedJob>({
      oracle: env.h.oracle,
      actors: [
        { name: "revocation", client: env.payment, begin: (c) => bindPayment(c, env.A.agencyId), act: (c, v) => revokeAuthorization(c, env.A, v.p.authorizationId) },
        { name: "publication", client: env.control, begin: (c) => bindAgency(c, env.A.agencyId), act: (c, v) => publishRaw(c, v, `r2-045-${v.job.jobId}`) },
      ],
      setup: (order) => verifiedJob(`cell-r2-045-${order[0]}-first`),
      async verify({ order, state: v, outcomes }) {
        const auth = (columns: string) => oracle(env, `SELECT ${columns} FROM kauro.commercial_authorizations WHERE authorization_id = $1`, [v.p.authorizationId]);
        const pkgState = () => oracle(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [v.pkg.packageVersionId]);
        assert.equal(outcomes["revocation"]?.committed, true, "the revocation commits in either order");
        if (order[0] === "revocation") {
          assert.equal(outcomes["publication"]?.act.status, "fulfilled", "the publication writes its edges; the database decides at COMMIT");
          assert.ok(rejectedWith(outcomes["publication"]?.commit, "KA081"), "no package becomes AVAILABLE under a REVOKED authorization");
          assert.deepEqual(await auth("state, revocation_phase"), [{ state: "REVOKED", revocation_phase: "DURING_EXECUTION" }]);
          assert.deepEqual(await pkgState(), [{ state: "VERIFIED_PRIVATE" }]);
          assert.deepEqual(await oracle(env, "SELECT result FROM kauro.package_verifications WHERE package_version_id = $1", [v.pkg.packageVersionId]), [{ result: "VALID" }]);
          assert.deepEqual(
            await oracle(env, "SELECT count(*)::int AS staged, count(*) FILTER (WHERE o.state = 'VERIFIED')::int AS verified FROM kauro.staged_artifacts a JOIN kauro.stored_objects o ON o.object_id = a.object_id JOIN kauro.processing_jobs j ON j.current_attempt_id = a.attempt_id WHERE j.job_id = $1", [v.job.jobId]),
            [{ staged: 2, verified: 2 }],
          );
          assert.deepEqual(await oracle(env, "SELECT count(*)::int AS n FROM kauro.delivery_artifacts WHERE package_version_id = $1", [v.pkg.packageVersionId]), [{ n: 2 }]);
          assert.deepEqual(await oracle(env, "SELECT count(*)::int AS n FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'commercial_authorization.delivered.v1'", [v.p.authorizationId]), [{ n: 0 }]);
          await endJob(env.h, env.A, v.job.jobId, "AUTHORIZATION_REVOKED");
        } else {
          assert.equal(outcomes["publication"]?.committed, true);
          const published = outcomes["publication"]?.act;
          assert.equal(published?.status === "fulfilled" && (published.value as { kind: string }).kind, "PUBLISHED");
          assert.deepEqual(await pkgState(), [{ state: "AVAILABLE" }]);
          assert.deepEqual(await auth("state, revocation_phase, delivered_at IS NOT NULL AS delivered"), [{ state: "REVOKED", revocation_phase: "POST_DELIVERY", delivered: true }]);
        }
      },
    });
  },
);

// --- B07-R1 (source-adapters.test.ts) ----------------------------------------------------------------------------------------------
faultCell(
  {
    id: "B07-R1",
    step: "SealHolds release claim retried past its bound while a newer hold of the same object is intended",
    fault: "retry",
    expect: "a retry within the claim's bound is IN_FLIGHT; past it the retry claims anew and the first claimant's late answer is STALE; the newer hold is RELEASE_PENDING until the first claim's in-flight bound and INTENDED after it",
  },
  async (ctx) => {
    const B = env.B;
    const clientId = env.clients.get(B.agencyId);
    assert.ok(clientId);
    const p = await project(env.app, B, clientId, env.hubspot, "HUBSPOT");
    const sessions = sourceSessions({ app: env.app, control: env.control }, B);
    const scope = { agencyId: B.agencyId, projectId: p.projectId, ownerUserId: B.ownerUserId, ownerMembershipId: B.ownerMembershipId };
    const admitted = await admitSourceFile(sessions, scope, { seed: "cell-hold-claims" });
    const ready = await readySourceRevision(sessions, scope, admitted);
    const objectId = admitted.acceptedObjectId as StoredObjectId;
    const hold = () => ({
      holdId: ids.next() as ObjectHoldId,
      attemptId: ids.next() as SealAttemptId,
      agencyId: B.agencyId,
      projectId: p.projectId as ProjectId,
      revisionId: ready.revisionId as RevisionId,
      fileId: admitted.fileId as SourceFileId,
      objectId,
      generation: admitted.acceptedGeneration,
      placedByUserId: B.ownerUserId as UserId,
    });
    /** The source store as the request handlers (REQUEST) or the control plane (CONTROL); on the controlled clock when `onClock`. */
    const store = <T>(who: "REQUEST" | "CONTROL", onClock: boolean, fn: (s: PgSourceStore) => Promise<T>) =>
      tx(who === "CONTROL" ? env.control : env.app, who === "CONTROL" ? { agencyId: B.agencyId } : { agencyId: B.agencyId, userId: B.ownerUserId }, async (c) => {
        if (onClock) await ctx.clock.onServer(c);
        return fn(new PgSourceStore(c, who));
      });

    // a seal attempt that did not seal: closed, so its release is decided and claimed by the first caller
    const attempt = hold();
    await store("REQUEST", false, (s) => s.holds.intend(attempt));
    await store("REQUEST", false, (s) => s.holds.closeAttempt(attempt.attemptId));
    const first = await store("REQUEST", false, (s) => s.holds.requestRelease(objectId, ids.next() as HoldReleaseId));
    assert.equal(first.kind, "RELEASE");
    if (first.kind !== "RELEASE") throw new Error("the first caller claims the release");
    const [c1] = await store("REQUEST", false, (s) => s.holds.releasesOf(objectId));
    assert.ok(c1);
    // a retry within the claim's bound is left out
    assert.deepEqual(await store("CONTROL", false, (s) => s.holds.requestRelease(objectId, ids.next() as HoldReleaseId)), { kind: "IN_FLIGHT" });
    // past the claim's bound the retry claims anew; the first claimant's late answer records nothing
    ctx.clock.past(c1.claimExpiresAt, 1_000);
    ctx.retried();
    const second = await store("CONTROL", true, (s) => s.holds.requestRelease(objectId, ids.next() as HoldReleaseId));
    assert.equal(second.kind, "RELEASE");
    if (second.kind !== "RELEASE") throw new Error("the retry claims the release");
    assert.notEqual(second.releaseId, first.releaseId);
    ctx.clock.advance(1_000);
    assert.deepEqual(await store("REQUEST", true, (s) => s.holds.recordRelease(first.releaseId, "RELEASED")), { kind: "STALE" }, "a superseded claimant records nothing");
    ctx.clock.advance(1_000);
    assert.deepEqual(await store("CONTROL", true, (s) => s.holds.recordRelease(second.releaseId, "RELEASED")), { kind: "RECORDED", holds: 1 });
    // the first claim may still land at the provider until its in-flight bound: no newer hold before it, one after it
    ctx.clock.before(c1.inFlightUntil, 2_000);
    assert.deepEqual(await store("REQUEST", true, (s) => s.holds.intend(hold())), { kind: "RELEASE_PENDING" });
    ctx.clock.past(c1.inFlightUntil, 2_000);
    const newer = await store("REQUEST", true, (s) => s.holds.intend(hold()));
    assert.equal(newer.kind, "INTENDED", "past the in-flight bound no earlier release can land: the newer hold is intended");
  },
);
