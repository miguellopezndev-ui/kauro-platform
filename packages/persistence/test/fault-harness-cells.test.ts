// Existing B06-B08 race, expiry, revocation and retry tests re-expressed as failure-matrix cells of the common fault harness
// (docs/design/FAULT-HARNESS.md), each beside its original, which stays as it is:
//   B06-R1  adapters-leases.test.ts        a lease takeover without a checkpoint                         [expiry]
//   B08-R1  execution-migrations.test.ts   a revoked source admission fencing a job's publication          [revocation]
//   R2-045  execution-migrations.test.ts   the authorization's revocation vs the publication, both orders  [race]
//   B07-R1  source-adapters.test.ts        a retried release claim vs a newer hold                         [retry]
// Each cell asserts everything its original asserts; the harness adds the proof that the fault happened at the boundary the cell
// names (the clock crossed the declared deadline and the claim consumed an instant past it; the waiter's own backend was observed blocked by the
// holder's in every order; the revocation committed and the publication was refused after it; the request ran again) and fails
// the cell otherwise.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { Client } from "pg";
import { HOLD_RELEASE_CLAIM_SECONDS, PROVIDER_CALL_TIMEOUT_MS, isDomainFailure, toUtcInstant } from "@kauro/domain";
import type {
  EventProvenance,
  HoldReassertionId,
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
import { admitJob, endJob, faultCell, instrumentPort, launchJob, openConnection, publishJob, queueJob, readySourceRevision, admitSourceFile, stageJob, verifyJob, type ActorOutcome, type RaceRun } from "../src/testing/index.js";
import { commerceEvent, service, within } from "./commerce-support.js";
import { causeState, closeExecutionEnv, oracle, openExecutionEnv, purchase, revokeAuthorization, type ExecutionEnv } from "./execution-support.js";
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
    const expiresAt = ctx.deadline(ctx.clock.at(120_000), "lease's time to live");
    // the claim is the operation under test: it takes its instant (p_now) through the step clock the harness hands it
    const claim = (resourceKind: "JOB_ATTEMPT" | "MODEL_TASK" | "OUTBOX_DISPATCH", resourceId: ResourceId, ownerId: LeaseOwnerId, checkpointHash: string | null) =>
      ctx.withClock(`${resourceKind} claim`, (clock) =>
        env.h.control.run(env.h.system(), (uow) =>
          instrumentPort(uow.leases, ctx.points, "leases").claim({ resourceKind, resourceId, ownerId, ttlSeconds: 120, deadlineAt: deadline, subjectHash: sha(resourceKind === "OUTBOX_DISPATCH" ? "dispatch" : "subject"), costAuthorityId: resourceKind === "OUTBOX_DISPATCH" ? null : ids.next(), checkpointHash }, clock.now()),
        ),
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
    // both actors on connections the harness opened: the publication is the observed waiter
    const revoker = await openConnection(env.h.pg.clientConfig("kauro_control_test"));
    const publisher = await openConnection(env.h.pg.clientConfig("kauro_control_test"));
    let run: RaceRun<VerifiedJob>;
    try {
      run = await ctx.inOrder<VerifiedJob>(
        {
          oracle: env.h.oracle,
          actors: [
            { name: "revocation", client: revoker, begin: (c) => bindAgency(c, env.A.agencyId), act: (c, v) => revokeIncludedFile(c, env.A.agencyId, v.p.projectId) },
            { name: "publication", client: publisher, begin: (c) => bindAgency(c, env.A.agencyId), act: (c, v) => publishRaw(c, v, "b08-r1-one") },
          ],
          setup: () => verifiedJob("cell-b08-r1-revocation-first"),
          async verify({ outcomes }) {
            assert.equal(outcomes["revocation"]?.committed, true);
            assert.equal(outcomes["publication"]?.act.status, "fulfilled", "the publication writes its edges; the database decides at COMMIT");
            assert.ok(rejectedWith(outcomes["publication"]?.commit, "KA081"), "no package becomes AVAILABLE once an included file's admission is revoked");
            await ctx.revoked("the included file's admission", outcomes["revocation"] as ActorOutcome);
            await ctx.fenced("the publication waiting on the revocation", outcomes["publication"] as ActorOutcome, (e) => sqlState(e) === "KA081");
          },
        },
        "revocation",
      );
    } finally {
      await revoker.end();
      await publisher.end();
    }
    const one = run.state;
    assert.deepEqual(await oracle(env, "SELECT r.state FROM kauro.dataset_revisions r JOIN kauro.projects p ON p.current_revision_id = r.revision_id WHERE p.project_id = $1", [one.p.projectId]), [{ state: "SEALED" }], "the revision itself is still SEALED");
    assert.deepEqual(await oracle(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [one.pkg.packageVersionId]), [{ state: "VERIFIED_PRIVATE" }]);
    assert.deepEqual(await oracle(env, "SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [one.p.authorizationId]), [{ state: "CONSUMED" }], "never DELIVERED");
    await ctx.fenced("a publication after the committed revocation", () => within(env.control, service(env.A.agencyId), (c) => publishRaw(c, one, "b08-r1-again")), (e) => causeState(e) === "KA081");
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
    // each actor is the observed waiter in one order: both on connections the harness opened, as the payment service and the control plane
    const payment = await openConnection(env.h.pg.clientConfig("kauro_payment_test"));
    const control = await openConnection(env.h.pg.clientConfig("kauro_control_test"));
    try {
      await ctx.bothOrders<VerifiedJob>({
        oracle: env.h.oracle,
        actors: [
          { name: "revocation", client: payment, begin: (c) => bindPayment(c, env.A.agencyId), act: (c, v) => revokeAuthorization(c, env.A, v.p.authorizationId) },
          { name: "publication", client: control, begin: (c) => bindAgency(c, env.A.agencyId), act: (c, v) => publishRaw(c, v, `r2-045-${v.job.jobId}`) },
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
    } finally {
      await payment.end();
      await control.end();
    }
  },
);

// --- B07-R1 (source-adapters.test.ts, "B07-R1 (second re-check), the release claim and its in-flight bound") -----------------------
// Every assertion of the original, in its order but for one: the clock never moves backwards, so the database's refusal of a claim
// for an undecided release (the original's inFlightUntil + 5 s) runs last, after the newer hold — which is INTENDED, not RELEASING,
// so the release is still undecided there.
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const plusSeconds = async (instant: string, seconds: number): Promise<string> =>
  (await oracle<{ t: string }>(env, `SELECT to_char(($1::timestamptz + make_interval(secs => $2)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`, [instant, seconds]))[0]!.t;
const failsWith = (code: string) => (e: unknown) => sqlState(e) === code;
const refusedAs = (code: string, reason: string, state: string) => (e: unknown) =>
  isDomainFailure(e) && e.code === code && e.reason === reason && sqlState((e as { cause?: unknown }).cause) === state;

faultCell(
  {
    id: "B07-R1",
    step: "SealHolds release claim retried past its bound while a newer hold of the same object is intended",
    fault: "retry",
    expect:
      "one claim per decided release with a 900 s bound and an in-flight bound 10 s past it; a retry within the bound is IN_FLIGHT and the database refuses a second live claim; past it the retry claims anew; an unclaimed or superseded answer is STALE and refused KA071; the claimant's answer records once; a newer hold is RELEASE_PENDING (KA071) until the in-flight bound and INTENDED after it",
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
    /** One transaction as the request handlers (REQUEST) or the control plane (CONTROL); on the controlled clock when `onClock`. */
    const raw = <T>(who: "REQUEST" | "CONTROL", onClock: boolean, fn: (c: Client) => Promise<T>) =>
      tx(who === "CONTROL" ? env.control : env.app, who === "CONTROL" ? { agencyId: B.agencyId } : { agencyId: B.agencyId, userId: B.ownerUserId }, (c) =>
        // on the clock, the transaction's server clock is put on the controlled instant by the operation's own step clock
        onClock
          ? ctx.withClock(`${who} transaction`, async (clock) => {
              await clock.onServer(c);
              return fn(c);
            })
          : fn(c),
      );
    const store = <T>(who: "REQUEST" | "CONTROL", onClock: boolean, fn: (s: PgSourceStore) => Promise<T>) => raw(who, onClock, (c) => fn(new PgSourceStore(c, who)));
    const insertHold = (c: Client) =>
      c.query(
        `INSERT INTO kauro.object_holds (hold_id, attempt_id, agency_id, project_id, revision_id, file_id, object_id, generation, hold_kind, reason, placed_by_user_id, state, intended_at, attempt_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TEMPORARY', 'SEAL_INTEGRITY', $9, 'INTENDED', kauro.server_now(), kauro.server_now() + interval '900 seconds', now(), now())`,
        [ids.next(), ids.next(), B.agencyId, p.projectId, ready.revisionId, admitted.fileId, objectId, admitted.acceptedGeneration, B.ownerUserId],
      );
    const insertClaim = (c: Client, sequence: number) =>
      c.query(
        `INSERT INTO kauro.object_hold_releases (release_id, agency_id, object_id, generation, sequence, claimed_at, claim_expires_at, in_flight_until, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, kauro.server_now(), kauro.server_now() + interval '900 seconds', kauro.server_now() + interval '910 seconds', now(), now())`,
        [ids.next(), B.agencyId, objectId, admitted.acceptedGeneration, sequence],
      );
    const requestRelease = (who: "REQUEST" | "CONTROL", onClock: boolean) => ctx.attempt(() => store(who, onClock, (s) => s.holds.requestRelease(objectId, ids.next() as HoldReleaseId)));
    const holdStates = async () => (await store("REQUEST", false, (s) => s.holds.forObject(objectId))).map((x) => x.state);

    // a seal attempt that did not seal: closed, so its release is decided and claimed by the first caller
    const attempt = hold();
    await store("REQUEST", false, (s) => s.holds.intend(attempt));
    await store("REQUEST", false, (s) => s.holds.closeAttempt(attempt.attemptId));
    const first = await requestRelease("REQUEST", false);
    assert.equal(first.kind, "RELEASE");
    if (first.kind !== "RELEASE") throw new Error("the first caller claims the release");
    const [c1] = await store("REQUEST", false, (s) => s.holds.releasesOf(objectId));
    assert.ok(c1);
    assert.deepEqual([c1.releaseId, c1.sequence, c1.generation, c1.answeredAt, c1.claimedAt, c1.claimExpiresAt], [first.releaseId, 1, admitted.acceptedGeneration, undefined, first.claimedAt, first.claimExpiresAt]);
    assert.match(c1.claimedAt, EXACT);
    assert.equal(c1.claimExpiresAt, await plusSeconds(c1.claimedAt, HOLD_RELEASE_CLAIM_SECONDS), "the claim's bound");
    assert.equal(HOLD_RELEASE_CLAIM_SECONDS, 900, "a 900-second claim");
    assert.equal(c1.inFlightUntil, await plusSeconds(c1.claimExpiresAt, PROVIDER_CALL_TIMEOUT_MS / 1000), "the in-flight bound: the claim's bound plus the provider call timeout");
    assert.equal(PROVIDER_CALL_TIMEOUT_MS, 10_000, "an in-flight bound 10 seconds past the claim's");
    const claimBound = ctx.deadline(c1.claimExpiresAt, "claim's bound");
    const inFlightBound = ctx.deadline(c1.inFlightUntil, "in-flight bound");
    const at = (instant: string, seconds: number) => toUtcInstant(Date.parse(instant) + seconds * 1000);

    // exactly one caller: a second one within the claim's bound is left out, and the database refuses a second live claim
    assert.deepEqual(await requestRelease("CONTROL", false), { kind: "IN_FLIGHT" });
    await assert.rejects(raw("CONTROL", false, (c) => insertClaim(c, 2)), failsWith("KA071"), "a second live claim");
    // a caller that holds no claim records nothing: the adapter answers STALE, and the database releases no hold but under the claim
    // answered in that very transaction
    assert.deepEqual(await store("CONTROL", false, (s) => s.holds.recordRelease(ids.next() as HoldReleaseId, "RELEASED")), { kind: "STALE" });
    await assert.rejects(
      raw("CONTROL", false, (c) => c.query("UPDATE kauro.object_holds SET state = 'RELEASED', released_at = kauro.server_now(), release_result = 'RELEASED', released_by = $2 WHERE hold_id = $1", [attempt.holdId, first.releaseId])),
      failsWith("KA071"),
      "a hold released under a claim nobody answered",
    );
    assert.deepEqual(await holdStates(), ["RELEASING"]);

    // past the claim's bound the release is claimed again (a new token); the first claimant's late answer is refused
    ctx.clock.set(at(claimBound, 1));
    const second = await requestRelease("CONTROL", true);
    assert.equal(second.kind, "RELEASE");
    if (second.kind !== "RELEASE") throw new Error("the retry claims the release");
    assert.notEqual(second.releaseId, first.releaseId);
    ctx.clock.set(at(claimBound, 2));
    assert.deepEqual(await store("REQUEST", true, (s) => s.holds.recordRelease(first.releaseId, "RELEASED")), { kind: "STALE" }, "a superseded claimant records nothing");
    await assert.rejects(
      raw("REQUEST", true, (c) => c.query("UPDATE kauro.object_hold_releases SET answered_at = kauro.server_now(), release_result = 'RELEASED' WHERE release_id = $1", [first.releaseId])),
      failsWith("KA071"),
      "the database refuses the answer of a superseded claim",
    );
    assert.deepEqual(await holdStates(), ["RELEASING"]);

    // the claimant's own answer records: the claim answered, the hold RELEASED naming it; the first claim stays unanswered (evidence)
    ctx.clock.set(at(claimBound, 3));
    assert.deepEqual(await store("CONTROL", true, (s) => s.holds.recordRelease(second.releaseId, "RELEASED")), { kind: "RECORDED", holds: 1 });
    assert.deepEqual(await store("CONTROL", true, (s) => s.holds.recordRelease(second.releaseId, "RELEASED")), { kind: "STALE" }, "an answer is recorded once");
    const claims = await store("REQUEST", false, (s) => s.holds.releasesOf(objectId));
    assert.deepEqual(claims.map((x) => [x.sequence, x.releaseId, x.releaseResult ?? null]), [[1, first.releaseId, null], [2, second.releaseId, "RELEASED"]]);
    assert.deepEqual((await store("REQUEST", false, (s) => s.holds.forObject(objectId))).map((x) => [x.state, x.releaseResult, x.releasedBy]), [["RELEASED", "RELEASED", second.releaseId]]);
    await assert.rejects(
      raw("CONTROL", false, (c) => c.query("UPDATE kauro.object_hold_releases SET release_result = 'ABSENT' WHERE release_id = $1", [second.releaseId])),
      failsWith("KA004"),
      "an answer is set once",
    );

    // nothing is RELEASING, yet the first claim may still land at the provider until its in-flight bound: no hold is intended before it
    // (RELEASE_PENDING; the database refuses the row, KA071) — and one is intended after it
    ctx.clock.set(at(inFlightBound, -2));
    assert.deepEqual(await store("REQUEST", true, (s) => s.holds.intend(hold())), { kind: "RELEASE_PENDING" });
    await assert.rejects(raw("REQUEST", true, (c) => insertHold(c)), failsWith("KA071"), "a hold row before the in-flight bound");
    ctx.clock.set(at(inFlightBound, 2));
    const admittedAfter = await store("REQUEST", true, (s) => s.holds.intend(hold()));
    assert.equal(admittedAfter.kind, "INTENDED", "past the in-flight bound no earlier release can land: the hold is intended");

    // a re-assertion names a SEALED hold: the database refuses one of a hold that is only INTENDED (KA072)
    if (admittedAfter.kind !== "INTENDED") throw new Error("the newer hold is intended");
    ctx.clock.set(at(inFlightBound, 3));
    await assert.rejects(
      store("REQUEST", true, (s) => s.holds.recordReassertion({ reassertionId: ids.next() as HoldReassertionId, holdId: admittedAfter.record.holdId, result: "HELD", reassertedBy: "SEAL" })),
      refusedAs("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"),
    );
    // a claim is taken only for a decided release (no hold of the object RELEASING any more)
    ctx.clock.set(at(inFlightBound, 5));
    await assert.rejects(raw("CONTROL", true, (c) => insertClaim(c, 3)), failsWith("KA072"), "a claim for an undecided release");
  },
);
