// Processing authority through the adapters (package B08, mandate B08-PERSISTENCE-EXECUTION; @kauro/persistence PgExecutionStore
// in the execution unit of work; docs/design/B08-audit-approval-jobs.md §5..§7, D8-PUB-2, D8-CANCEL-1, D8-LOCK-1, D8-JAN-1; case map
// docs/design/B08-case-map.md): the races of S062 — CancelJob's cancel_command against the publication on the job's row, and a
// deletion request against the publication on the project's transition lock — and the attempt cleanup of S075, on real PostgreSQL 17
// through the runtime login roles. Each interleaving is fixed by a hold point inside one transaction and the other's lock wait,
// observed in pg_stat_activity (waitForLockWait, settlesOrWaits), never by a sleep. The platform admits one ACTIVE job at a time, so
// each scenario ends its jobs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { EXECUTION_POLICY, isDomainFailure, jobAttemptCheckpointOf, type AttemptCleanupId, type CleanupInput, type EventProvenance, type ProcessingAttemptId, type PublicationOutcome, type StoredObjectId } from "@kauro/domain";
import { PgEventPublisher } from "../src/event-publisher.js";
import { PgExecutionStore } from "../src/execution/store.js";
import { clockAt } from "../src/testing/source-lifecycle.js";
import { backendPid, barrier, handled, settlesOrWaits, waitForLockWait } from "../src/testing/harness.js";
import { admitJob, controlOf, endJob, launchJob, queueJob, stageJob, verifyJob } from "../src/testing/execution-fixtures.js";
import { tenant, within } from "./commerce-support.js";
import { asControl, causeConstraint, causeState, closeExecutionEnv, openExecutionEnv, oracle, purchase, refused, type ExecutionEnv } from "./execution-support.js";
import { clock, event, ids, sha, sqlState } from "./support.js";

let env: ExecutionEnv;

before(async () => {
  env = await openExecutionEnv("exec-adapters");
});
after(async () => {
  await closeExecutionEnv(env);
});

/** A job of a fresh purchase of agency A, queued, admitted, launched, staged and verified with its private delivery copies. */
async function verifiedJob(seed: string) {
  const p = await purchase(env, env.A, seed);
  const queued = await queueJob(env.h, env.A, p.authorizationId);
  await admitJob(env.h, env.A, queued.jobId);
  await launchJob(env.h, env.A, queued.jobId);
  await stageJob(env.h, env.A, queued.jobId);
  const pkg = await verifyJob(env.h, env.A, queued.jobId);
  return { p, jobId: queued.jobId, pkg };
}

type Verified = Awaited<ReturnType<typeof verifiedJob>>;

/** JOB_EXECUTION's publication transaction of the job's verified package (D8-PUB-2), as one control-plane unit of work. */
function publication(job: Verified, seed: string, hold?: { readonly written: { open(): void }; readonly commit: Promise<void> }): Promise<PublicationOutcome> {
  return env.h.execution.run(controlOf(env.A.agencyId), async (uow) => {
    const out = await uow.execution.publish({ jobId: job.jobId, packageVersionId: job.pkg.packageVersionId, deliveryManifestHash: sha(`delivery-${seed}`), anchorId: uow.ids.next() });
    if (hold) {
      hold.written.open();
      await hold.commit;
    }
    return out;
  });
}

/**
 * How the job row lock (PgExecutionStore.lockJob) shows in pg_stat_activity: the statement text is cut at track_activity_query_size
 * (1024 bytes) before its FROM clause, so its select list is what identifies it; the application name and the lock wait do the rest.
 */
const JOB_ROW_LOCK = "SELECT job_id, agency_id, project_id, authorization_id, capture_id";

/** The job's row as the oracle reads it. */
async function jobRow(jobId: string) {
  const [row] = await oracle<{ state: string; version: number; cancel_version: number; published_package_id: string | null }>(
    env,
    "SELECT state, version::int AS version, cancel_version::int AS cancel_version, published_package_id FROM kauro.processing_jobs WHERE job_id = $1",
    [jobId],
  );
  assert.ok(row);
  return row;
}

async function packageState(packageVersionId: string): Promise<string | undefined> {
  return (await oracle<{ state: string }>(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [packageVersionId]))[0]?.state;
}

test("S062: cancel_command and the publication serialize on the job row in both interleavings, the wait observed in pg_stat_activity — a publication behind a committed cancellation is refused and its package stays private, a cancellation behind a committed publication finds the job READY", async () => {
  const { A } = env;
  const operator = () => env.h.tenant(A.agencyId, A.ownerUserId);

  // --- interleaving 1: CancelJob holds the job row (cancel_command written, not committed); the publication waits for it ---------------
  const one = await verifiedJob("s062-cancel-first");
  const before1 = await jobRow(one.jobId);
  const cancelled = barrier();
  const release = barrier();
  const cancellation = env.h.execution.run(operator(), async (uow) => {
    const locked = await uow.execution.lockJob(one.jobId);
    assert.ok(locked);
    const out = await uow.execution.requestCancellation(one.jobId, locked.version, { actor: { kind: "USER", userId: A.ownerUserId }, reasonCode: "CLIENT_STOPPED" });
    cancelled.open();
    await release.wait;
    return out;
  });
  await cancelled.wait;
  const refusedPublication = publication(one, "one");
  // the publication is blocked on the job row CancelJob holds (its SELECT ... FOR UPDATE)
  await waitForLockWait(env.h.oracle, "kauro-test-control", JOB_ROW_LOCK);
  release.open();
  assert.equal((await cancellation).kind, "APPLIED");
  const outcome1 = await refusedPublication;
  assert.deepEqual([outcome1.kind, outcome1.kind === "REFUSED" ? outcome1.reason : null], ["REFUSED", "JOB_CANCELLED"], "a publication behind a committed cancellation is refused");
  assert.deepEqual(await jobRow(one.jobId), { state: "CANCEL_REQUESTED", version: before1.version + 1, cancel_version: 1, published_package_id: null });
  assert.equal(await packageState(one.pkg.packageVersionId), "VERIFIED_PRIVATE", "its package stays private");
  assert.deepEqual(await oracle(env, "SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [one.p.authorizationId]), [{ state: "CONSUMED" }], "never DELIVERED");
  // EXECUTION_CONTROL completes the cancellation (the provider reconciled): the package revoked with its evidence, the slot released
  await env.h.execution.run(controlOf(A.agencyId), async (uow) => {
    const pkg = await uow.execution.getPackage(one.pkg.packageVersionId);
    assert.ok(pkg);
    assert.equal((await uow.execution.revokePackage(pkg.packageVersionId, pkg.version, "JOB_CANCELLED")).kind, "APPLIED");
  });
  assert.equal((await endJob(env.h, A, one.jobId, "CANCEL_REQUESTED_BY_AGENCY")).state, "CANCELLED");

  // --- interleaving 2: the publication holds the job row (its edges written, not committed); CancelJob waits and finds it READY -------
  const two = await verifiedJob("s062-publication-first");
  const before2 = await jobRow(two.jobId);
  const written = barrier();
  const commit = barrier();
  const published = publication(two, "two", { written, commit: commit.wait });
  await written.wait;
  const lateCancellation = env.h.execution.run(operator(), async (uow) => {
    const locked = await uow.execution.lockJob(two.jobId);
    assert.ok(locked);
    // CMD037 answers from the row it locked; a cancel_command at the version read before the publication is STALE
    return { locked, write: await uow.execution.requestCancellation(two.jobId, before2.version, { actor: { kind: "USER", userId: A.ownerUserId }, reasonCode: "CLIENT_STOPPED" }) };
  });
  await waitForLockWait(env.h.oracle, "kauro-test-api", JOB_ROW_LOCK);
  commit.open();
  assert.equal((await published).kind, "PUBLISHED");
  const late = await lateCancellation;
  assert.deepEqual([late.locked.state, late.locked.publishedPackageId], ["READY", two.pkg.packageVersionId], "a cancellation behind a committed publication finds the job READY");
  assert.deepEqual(late.write, { kind: "STALE", currentVersion: before2.version + 1, currentState: "READY" });
  assert.deepEqual(await jobRow(two.jobId), { state: "READY", version: before2.version + 1, cancel_version: 0, published_package_id: two.pkg.packageVersionId });
  assert.equal(await packageState(two.pkg.packageVersionId), "AVAILABLE");
  assert.deepEqual(await oracle(env, "SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [two.p.authorizationId]), [{ state: "DELIVERED" }]);
  // never both: of the two jobs exactly one published, and only the cancelled one has a cancellation event
  assert.deepEqual(
    await oracle(env, "SELECT aggregate_id::text AS job, event_type FROM kauro.domain_events WHERE aggregate_id = ANY($1::uuid[]) AND event_type IN ('processing_job.ready.v1', 'processing_job.cancel_requested.v1') ORDER BY event_type", [[one.jobId, two.jobId]]),
    [
      { job: one.jobId, event_type: "processing_job.cancel_requested.v1" },
      { job: two.jobId, event_type: "processing_job.ready.v1" },
    ],
  );
});

test("S062 deletion half at the database: a project entering DELETION_REQUESTED and the publication serialize on the project's transition lock in both interleavings; a publication after it is refused KA081", async () => {
  const { A } = env;
  /** The deletion request as B16's RequestDeletion (CMD042) will write it: the project OPEN -> DELETION_REQUESTED at its version. */
  const requestDeletion = async (c: Client, projectId: string): Promise<void> => {
    const r = await c.query<{ version: string }>("UPDATE kauro.projects SET state = 'DELETION_REQUESTED', version = version + 1 WHERE project_id = $1 RETURNING version::text AS version", [projectId]);
    // B16 registers the deletion's own event type with CMD042; until then the version's event is a stand-in of the project's
    // registered type (the event-per-version rule needs one; nothing consumes it here)
    await event(c, { aggregateKind: "project", aggregateId: projectId, aggregateVersion: Number(r.rows[0]?.version), agencyId: A.agencyId, eventType: "project.created.v1", actorUserId: A.ownerUserId });
  };

  // --- interleaving 1: the deletion request holds the project's exclusive transition lock; the publication waits, then is refused KA081 --
  const one = await verifiedJob("s062-deletion-first");
  let late: Promise<PublicationOutcome> | undefined;
  await within(env.app, tenant(A), async (c) => {
    await requestDeletion(c, one.p.projectId);
    late = handled(publication(one, "deleted"));
    // the publication's first lock is the project's shared transition lock (D8-PUB-2): it waits on the advisory lock
    const pid = await waitForLockWait(env.h.oracle, "kauro-test-control", "kauro.await_transition");
    assert.deepEqual(await oracle(env, "SELECT wait_event FROM pg_stat_activity WHERE pid = $1", [pid]), [{ wait_event: "advisory" }]);
  });
  assert.ok(late);
  await assert.rejects(late, (e: unknown) => isDomainFailure(e) && e.code === "PRECONDITION_FAILED" && e.reason === "EXECUTION_AUTHORITY_LOST" && causeState(e) === "KA081", "a publication after a deletion request is refused KA081");
  assert.deepEqual(await oracle(env, "SELECT state FROM kauro.projects WHERE project_id = $1", [one.p.projectId]), [{ state: "DELETION_REQUESTED" }]);
  assert.equal(await packageState(one.pkg.packageVersionId), "VERIFIED_PRIVATE");
  assert.equal((await jobRow(one.jobId)).state, "VERIFYING");
  assert.equal((await endJob(env.h, A, one.jobId, "PROJECT_DELETION_REQUESTED")).state, "FAILED");

  // --- interleaving 2: the publication holds the shared half; the deletion request waits for it and commits behind it -----------------
  const two = await verifiedJob("s062-publication-before-deletion");
  const written = barrier();
  const commit = barrier();
  const published = publication(two, "kept", { written, commit: commit.wait });
  await written.wait;
  await within(env.app, tenant(A), async (c) => {
    const pid = await backendPid(c);
    const seen = await settlesOrWaits(env.h.oracle, pid, requestDeletion(c, two.p.projectId), "the deletion request behind the uncommitted publication");
    assert.equal(seen.kind, "WAITING", "the deletion request waits for the publication");
    assert.deepEqual(await oracle(env, "SELECT wait_event FROM pg_stat_activity WHERE pid = $1", [pid]), [{ wait_event: "advisory" }], "on the project's transition lock");
    commit.open();
    assert.equal((await published).kind, "PUBLISHED");
    if (seen.kind === "WAITING") assert.equal((await seen.pending).status, "fulfilled");
  });
  assert.deepEqual(
    await oracle(env, "SELECT p.state AS project, v.state AS package, j.state AS job FROM kauro.projects p, kauro.package_versions v, kauro.processing_jobs j WHERE p.project_id = $1 AND v.package_version_id = $2 AND j.job_id = $3", [
      two.p.projectId,
      two.pkg.packageVersionId,
      two.jobId,
    ]),
    [{ project: "DELETION_REQUESTED", package: "AVAILABLE", job: "READY" }],
  );
});

test("S075 at the database: an attempt cleanup records exactly one attempt with its provider identity, staging prefix, deleted generations and the host-reported cost and result, and only objects under that attempt's prefix can be recorded as its cleanup", async () => {
  const { A, B } = env;
  // the worker of an attempt dies after writing its staging objects: the attempt is abandoned and the job fails
  const p = await purchase(env, A, "s075");
  const queued = await queueJob(env.h, A, p.authorizationId);
  await admitJob(env.h, A, queued.jobId);
  const { attempt } = await launchJob(env.h, A, queued.jobId);
  const staging = await stageJob(env.h, A, queued.jobId);
  const cleanupOf = (input: Omit<CleanupInput, "cleanupId" | "attemptId">) =>
    env.h.execution.run(controlOf(A.agencyId), (uow) => uow.execution.recordCleanup({ ...input, cleanupId: uow.ids.next() as AttemptCleanupId, attemptId: attempt.attemptId }));
  // a live attempt is never cleaned (KA080)
  await assert.rejects(
    cleanupOf({ deletedObjects: [], terminationResult: "NOT_FOUND", scratchDeleted: false, resources: null, result: "PARTIAL", evidenceClass: "SIMULATED" }),
    (e: unknown) => causeState(e) === "KA080",
    "a live attempt",
  );
  await endJob(env.h, A, queued.jobId, "WORKER_CRASHED");
  // a sibling attempt of the same agency and an attempt of agency B, each with staged objects under its own prefix, both ended
  const sibling = await purchase(env, A, "s075-sibling");
  const q2 = await queueJob(env.h, A, sibling.authorizationId);
  await admitJob(env.h, A, q2.jobId);
  await launchJob(env.h, A, q2.jobId);
  const siblingStaging = await stageJob(env.h, A, q2.jobId);
  await endJob(env.h, A, q2.jobId, "WORKER_CRASHED");
  const q3 = await queueJob(env.h, B, (await purchase(env, B, "s075-other")).authorizationId);
  await admitJob(env.h, B, q3.jobId);
  await launchJob(env.h, B, q3.jobId);
  const foreignStaging = await stageJob(env.h, B, q3.jobId);
  await endJob(env.h, B, q3.jobId, "WORKER_CRASHED");

  // STAGING_JANITOR deleted exactly the attempt's objects by generation (through the labelled storage fake; SIMULATED) and the host
  // reported the provider job's cost and termination
  type Deleted = { readonly objectId: StoredObjectId; readonly objectName: string; readonly generation: string };
  const deleted: Deleted[] = staging.artifacts.map((a) => ({ objectId: a.objectId, objectName: a.objectName, generation: a.generation }));
  const resources = { machineType: "e2-standard-8", vcpus: 8, memoryBytes: 34_359_738_368, diskBytes: 68_719_476_736, peakScratchBytes: 12_345_678, runtimeMs: 81_000, costMicros: 42_000, currency: "USD" };
  const cleaned = (objects: ReadonlyArray<Deleted>) => cleanupOf({ deletedObjects: objects, terminationResult: "TERMINATED", scratchDeleted: true, resources, result: "CLEANED", evidenceClass: "SIMULATED" });
  // only objects under that attempt's prefix: a sibling attempt's object, another agency's object, another generation of one of its
  // own and one of its own named twice are each refused (KA080)
  const siblingObject = siblingStaging.artifacts[0];
  const foreignObject = foreignStaging.artifacts[0];
  const own = deleted[0];
  assert.ok(siblingObject && foreignObject && own);
  const outsiders: ReadonlyArray<readonly [string, ReadonlyArray<Deleted>]> = [
    ["a sibling attempt's object", [...deleted, { objectId: siblingObject.objectId, objectName: siblingObject.objectName, generation: siblingObject.generation }]],
    ["another agency's object", [{ objectId: foreignObject.objectId, objectName: foreignObject.objectName, generation: foreignObject.generation }]],
    ["another generation of the attempt's object", [{ ...own, generation: "1" }]],
    ["an object named twice", [own, own]],
  ];
  for (const [what, objects] of outsiders) await assert.rejects(cleaned(objects), (e: unknown) => causeState(e) === "KA080", what);
  // the cleanup of exactly the attempt: its identity and prefix (the attempt's own, by key), its deleted generations, the host's report
  const record = await cleaned(deleted);
  const byName = (a: Deleted, b: Deleted) => a.objectName.localeCompare(b.objectName);
  assert.deepEqual(
    {
      attempt: record.attemptId,
      job: record.jobId,
      identity: record.providerIdentity,
      prefix: record.stagingPrefix,
      deleted: [...record.deletedObjects].sort(byName),
      resources: record.resources,
      termination: record.terminationResult,
      scratch: record.scratchDeleted,
      result: record.result,
      evidence: record.evidenceClass,
    },
    {
      attempt: attempt.attemptId,
      job: queued.jobId,
      identity: `kauro-attempt-${attempt.attemptId}`,
      prefix: attempt.stagingPrefix,
      deleted: [...deleted].sort(byName),
      resources,
      termination: "TERMINATED",
      scratch: true,
      result: "CLEANED",
      evidence: "SIMULATED",
    },
  );
  assert.deepEqual(await env.h.execution.run(controlOf(A.agencyId), (uow) => uow.execution.cleanupOf(attempt.attemptId)), record);
  // CLEANED is final: no pass after it (B08-R2, migration 0024; KA080)
  await assert.rejects(cleaned(deleted), (e: unknown) => causeState(e) === "KA080", "a second cleanup of a CLEANED attempt");
  // a cleanup row cannot claim another attempt's identity and prefix: they are the attempt's own by key
  await asControl(env, A, async (c) => {
    await refused(
      c,
      () =>
        c.query(
          `INSERT INTO kauro.attempt_cleanups (cleanup_id, agency_id, job_id, attempt_id, provider_identity, staging_prefix, deleted_objects, termination_result, scratch_deleted, result, evidence_class, resource_report)
           VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, 'NOT_FOUND', true, 'PARTIAL', 'SIMULATED', 'NOT_FOUND')`,
          [ids.next(), A.agencyId, q2.jobId, siblingStaging.attempt.attemptId, attempt.identity, attempt.stagingPrefix],
        ),
      "23503",
      "a cleanup naming another attempt's identity and prefix",
      "attempt_cleanups_attempt_identity_fk",
    );
  });
  // B08-R2, B08-R4 (migration 0024): the sibling's PARTIAL passes are numbered by the database, at most five; CLEANED never claims an
  // unanswered resource report
  const siblingPass = (input: Omit<CleanupInput, "cleanupId" | "attemptId">) =>
    env.h.execution.run(controlOf(A.agencyId), (uow) => uow.execution.recordCleanup({ ...input, cleanupId: uow.ids.next() as AttemptCleanupId, attemptId: siblingStaging.attempt.attemptId }));
  await assert.rejects(
    siblingPass({ deletedObjects: [], terminationResult: "NOT_FOUND", scratchDeleted: true, resources: null, resourceReport: "UNAVAILABLE", result: "CLEANED", evidenceClass: "SIMULATED" }),
    (e: unknown) => causeState(e) === "23514" && causeConstraint(e) === "attempt_cleanups_cleaned",
    "CLEANED without the host's resource report",
  );
  const passes: number[] = [];
  for (let n = 1; n <= 5; n += 1) {
    const pass = await siblingPass({ deletedObjects: [], terminationResult: "NOT_FOUND", scratchDeleted: false, resources: null, resourceReport: "UNAVAILABLE", result: "PARTIAL", evidenceClass: "SIMULATED" });
    assert.equal(pass.resourceReport, "UNAVAILABLE");
    passes.push(pass.pass);
  }
  assert.deepEqual(passes, [1, 2, 3, 4, 5]);
  await assert.rejects(
    siblingPass({ deletedObjects: [], terminationResult: "NOT_FOUND", scratchDeleted: true, resources, result: "CLEANED", evidenceClass: "SIMULATED" }),
    (e: unknown) => causeState(e) === "KA080",
    "a sixth pass",
  );
  assert.equal((await env.h.execution.run(controlOf(A.agencyId), (uow) => uow.execution.cleanupOf(siblingStaging.attempt.attemptId)))?.pass, 5, "cleanupOf reads the latest pass");
  assert.deepEqual(
    await oracle(env, "SELECT count(*)::int AS n FROM kauro.attempt_cleanups WHERE attempt_id = ANY($1::uuid[])", [[attempt.attemptId, siblingStaging.attempt.attemptId, foreignStaging.attempt.attemptId]]),
    [{ n: 6 }],
  );
});

/** PgExecutionStore on the control plane's raw transaction: the adapter ATTEMPT_MONITOR takes a lapse through, on the TEST CLOCK. */
function controlStore(c: Client): PgExecutionStore {
  const provenance = (): EventProvenance => ({ actor: { kind: "SERVICE", serviceId: "control-plane" }, causationId: ids.next() as EventProvenance["causationId"], correlationId: ids.next() as EventProvenance["correlationId"] });
  return new PgExecutionStore({ db: c, ids, events: new PgEventPublisher(c, ids, clock), provenance });
}

/** A raw claim of the job's JOB_ATTEMPT lease by a new owner naming `checkpoint`, as a savepoint probe: the refusal's label, if any. */
async function claimProbe(c: Client, jobId: string, checkpoint: string | null): Promise<string> {
  await c.query("SAVEPOINT lease_probe");
  try {
    await c.query(
      `SELECT kauro.claim_lease('JOB_ATTEMPT', j.job_id, $2, 120, j.delivery_deadline_at, j.input_binding_hash, j.authorization_id, $3, kauro.server_now())
         FROM kauro.processing_jobs j WHERE j.job_id = $1`,
      [jobId, ids.next(), checkpoint],
    );
    return "CLAIMED";
  } catch (e) {
    assert.equal(sqlState(e), "KA005", String(e));
    return (e as Error).message.split(":")[0] ?? "";
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT lease_probe");
  }
}

test("B06-R1 seam (b08/land): the JOB_ATTEMPT lease is born at admission with the job's checkpoint — KAURO_JOB_ATTEMPT_CHECKPOINT_V1 over its admitted input — so once the lease lapsed the control plane abandons attempt 1 and PgExecutionStore.takeOver resumes the lease under fence 2 naming exactly that checkpoint; while the lease is live the takeover is HELD, and a claim naming no checkpoint or another is refused (KA005) and changes nothing", async () => {
  const { A } = env;
  const p = await purchase(env, A, "b06-r1-job-lease");
  const queued = await queueJob(env.h, A, p.authorizationId);
  const jobId = queued.jobId;
  const admitted = await admitJob(env.h, A, jobId);
  const a1 = admitted.attempt.attemptId;
  const checkpoint = jobAttemptCheckpointOf(admitted.job);
  const lease = async () =>
    (await oracle<{ owner_id: string; fence: number; checkpoint_hash: string | null }>(env, "SELECT owner_id, fence::int AS fence, checkpoint_hash FROM kauro.leases WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1", [jobId]))[0];
  // the admission's first claim stores the job's checkpoint with the lease: owner attempt 1, fence 1
  assert.deepEqual([admitted.lease.fence, admitted.lease.ownerId, admitted.lease.checkpointHash], [1, a1, checkpoint]);
  assert.deepEqual(await lease(), { owner_id: a1, fence: 1, checkpoint_hash: checkpoint });
  // while attempt 1's lease is live a takeover is HELD and writes nothing
  const held = await asControl(env, A, (c) => controlStore(c).takeOver(jobId, ids.next() as ProcessingAttemptId));
  assert.equal(held.kind, "HELD");
  assert.deepEqual(await lease(), { owner_id: a1, fence: 1, checkpoint_hash: checkpoint });
  // past its time to live on the TEST CLOCK: a resume naming no checkpoint, or another one, is refused by the guard; nothing changes
  const lapsed = new Date(Date.now() + (EXECUTION_POLICY.leaseSeconds + 60) * 1000);
  await asControl(env, A, async (c) => {
    await clockAt(c, lapsed);
    assert.equal(await claimProbe(c, jobId, null), "RESUME_WITHOUT_CHECKPOINT");
    assert.equal(await claimProbe(c, jobId, sha("another checkpoint")), "CHECKPOINT_MISMATCH");
  });
  assert.deepEqual(await lease(), { owner_id: a1, fence: 1, checkpoint_hash: checkpoint });
  // the lapse as ATTEMPT_MONITOR takes it, in one unit: attempt 1 ABANDONED, the lease resumed by attempt 2 at fence 2 from the
  // stored checkpoint (the takeover recomputes it from the job's admitted input and the guard finds it equal)
  const a2 = ids.next() as ProcessingAttemptId;
  const taken = await asControl(env, A, async (c) => {
    await clockAt(c, lapsed);
    const x = controlStore(c);
    await x.abandonAttempt(a1, "LEASE_LAPSED");
    return x.takeOver(jobId, a2);
  });
  assert.deepEqual(
    taken.kind === "CLAIMED" ? [taken.attempt.attemptId, taken.attempt.ordinal, taken.attempt.state, taken.attempt.fence, taken.lease.fence, taken.lease.ownerId, taken.lease.checkpointHash] : [taken.kind],
    [a2, 2, "CLAIMED", 2, 2, a2, checkpoint],
  );
  assert.deepEqual(await lease(), { owner_id: a2, fence: 2, checkpoint_hash: checkpoint });
  assert.deepEqual(await oracle(env, "SELECT state, terminal_cause FROM kauro.processing_attempts WHERE attempt_id = $1", [a1]), [{ state: "ABANDONED", terminal_cause: "LEASE_LAPSED" }]);
  await endJob(env.h, A, jobId);
});
