// Processing authority at the database (package B08, mandate B08-PERSISTENCE-EXECUTION; migrations 0019 and 0020;
// docs/design/B08-audit-approval-jobs.md §4, §5, §8, §9; case map docs/design/B08-case-map.md): jobs, attempts, the capacity ledgers,
// staging, read-back, verification and publication on real PostgreSQL 17 through the runtime login roles. Every guard is proven by
// the forbidden write performed AS THE ROLE that would perform it — the request handlers (kauro_app_test), the control plane bound
// to the agency (kauro_control_test), the payment service (kauro_payment_test) — and refused beside the legitimate write that commits
// (21 "Positive and negative symmetry"; 07 "application checks improve messages but cannot be the sole protection"). The platform
// admits one ACTIVE and three WAITING heavy jobs at a time, so every test ends the jobs it started (execution fixture endJob).
// Interleavings are fixed by lock waits observed in pg_stat_activity (settlesOrWaits), never by a sleep.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { STATE_MACHINES } from "@kauro/contracts";
import { EXECUTION_AGGREGATE_KINDS, EXECUTION_EVENT_TYPES, EXECUTION_PLATFORM_MACHINES, EXECUTION_POLICY, JOB_EVENT_TYPES, PACKAGE_EVENT_TYPES, fairAdmissionOrder, isDomainFailure, jobInputBindingHashOf, type CommerceUnitOfWork, type EventProvenance, type ProcessingJobId } from "@kauro/domain";
import { PgEventPublisher } from "../src/event-publisher.js";
import { PgExecutionStore } from "../src/execution/store.js";
import { executionReadsOf } from "../src/unit-of-work.js";
import { backendPid, settlesOrWaits } from "../src/testing/harness.js";
import { clockAt } from "../src/testing/source-lifecycle.js";
import {
  admitJob,
  controlOf,
  endJob,
  fixtureArtifacts,
  fixtureGeneration,
  launchJob,
  queueJob,
  stageJob,
  verifyJob,
} from "../src/testing/execution-fixtures.js";
import { approvedSubject, commerceEvent, issuedQuote, replacementSource, service, tenant, within } from "./commerce-support.js";
import {
  asControl,
  causeConstraint,
  causeState,
  closeExecutionEnv,
  jobSubjectOf,
  openExecutionEnv,
  oracle,
  purchase,
  refused,
  refusedTransaction,
  revokeAuthorization,
  revokeCommitted,
  type ExecutionEnv,
} from "./execution-support.js";
import { clock, ids, sha, sqlState } from "./support.js";

let env: ExecutionEnv;

before(async () => {
  env = await openExecutionEnv("exec-mig");
});
after(async () => {
  await closeExecutionEnv(env);
});

/** The job row a request handler would insert for a subject (the BEFORE guard stamps its instants and deadline). */
async function insertJobRow(c: Client, subject: Record<string, string>, overrides: Record<string, string> = {}): Promise<string> {
  const s = { ...subject, ...overrides };
  const jobId = ids.next();
  const binding = jobInputBindingHashOf({
    agencyId: s["agency_id"],
    projectId: s["project_id"],
    authorizationId: s["authorization_id"],
    captureId: s["capture_id"],
    planId: s["plan_id"],
    planHash: s["plan_hash"],
    approvalId: s["approval_id"],
    approvalHash: s["approval_hash"],
    revisionHash: s["revision_hash"],
    targetContractHash: s["target_contract_hash"],
    capabilityId: s["capability_id"],
    capabilityVersion: s["capability_version"],
    mode: s["mode"],
    validationReceiptHash: s["validation_receipt_hash"],
    corePackageHash: s["core_package_hash"],
  } as never);
  await c.query(
    `INSERT INTO kauro.processing_jobs (job_id, agency_id, project_id, authorization_id, capture_id, plan_id, plan_hash, approval_id, approval_hash, revision_hash,
        target_contract_hash, capability_id, capability_version, mode, validation_receipt_hash, core_package_hash, input_binding_hash, created_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      jobId,
      s["agency_id"],
      s["project_id"],
      s["authorization_id"],
      s["capture_id"],
      s["plan_id"],
      s["plan_hash"],
      s["approval_id"],
      s["approval_hash"],
      s["revision_hash"],
      s["target_contract_hash"],
      s["capability_id"],
      s["capability_version"],
      s["mode"],
      s["validation_receipt_hash"],
      s["core_package_hash"],
      overrides["input_binding_hash"] ?? binding,
      overrides["created_by_membership_id"] ?? env.A.ownerMembershipId,
    ],
  );
  return jobId;
}

/** The queued event of a job version 1 and, unless told otherwise, its JOB_EXECUTION outbox record (what the publisher writes). */
async function queuedEvent(c: Client, agencyId: string, jobId: string, withOutbox: boolean, userId: string): Promise<void> {
  const eventId = await commerceEvent(c, "processing_job", jobId, 1, agencyId, "processing_job.queued.v1", { kind: "USER", id: userId });
  if (withOutbox) {
    await c.query("INSERT INTO kauro.outbox_records (outbox_id, event_id, consumer, state, attempts, next_attempt_at, created_at, updated_at) VALUES ($1, $2, 'JOB_EXECUTION', 'PENDING', 0, now(), now(), now())", [ids.next(), eventId]);
  }
}

/** The platform's and the agency's ledgers as stored, beside what the jobs hold (oracle). */
async function ledgers(agencyId: string) {
  const [row] = await oracle<{ active: number; waiting: number; live: number; jobs_waiting: number; jobs_active: number; jobs_live: number }>(
    env,
    `SELECT (SELECT active_jobs FROM kauro.execution_capacity) AS active, (SELECT waiting_jobs FROM kauro.execution_capacity) AS waiting,
            coalesce((SELECT live_jobs FROM kauro.agency_execution_capacity WHERE agency_id = $1), 0) AS live,
            (SELECT count(*)::int FROM kauro.processing_jobs WHERE holds = 'WAITING') AS jobs_waiting,
            (SELECT count(*)::int FROM kauro.processing_jobs WHERE holds = 'ACTIVE') AS jobs_active,
            (SELECT count(*)::int FROM kauro.processing_jobs WHERE agency_id = $1 AND holds <> 'NONE') AS jobs_live`,
    [agencyId],
  );
  assert.ok(row);
  return row;
}

/** A store on a raw connection inside a transaction the test holds (the control plane's own adapter, for an interleaving). */
function rawStore(c: Client, serviceId = "control-plane"): PgExecutionStore {
  const provenance = (): EventProvenance => ({ actor: { kind: "SERVICE", serviceId }, causationId: ids.next() as EventProvenance["causationId"], correlationId: ids.next() as EventProvenance["correlationId"] });
  return new PgExecutionStore({ db: c, ids, events: new PgEventPublisher(c, ids, clock), provenance });
}

/** Takes the job's lease over for a new owner at fence + 1 inside the caller's transaction (its TEST CLOCK past the lease's expiry). */
async function takeOverLease(c: Client, jobId: string): Promise<string> {
  await clockAt(c, new Date(Date.now() + (EXECUTION_POLICY.leaseSeconds + 60) * 1000));
  const newOwner = ids.next();
  // the lease's subject, deadline and cost authority exactly as stored (a takeover names them again; they never change)
  const claimed = await c.query<{ owner_id: string; fence: string }>(
    `SELECT l.owner_id, l.fence FROM kauro.processing_jobs j,
            LATERAL kauro.claim_lease('JOB_ATTEMPT', j.job_id, $2, 120, j.delivery_deadline_at, j.input_binding_hash, j.authorization_id, NULL, kauro.server_now()) l
      WHERE j.job_id = $1`,
    [jobId, newOwner],
  );
  assert.equal(claimed.rows[0]?.owner_id, newOwner, "the lapsed lease is taken over");
  return newOwner;
}

test("S055 at the database: a job commits only with its processing_job.queued.v1 event and its outbox record, one job per commercial authorization and one live job per project", async () => {
  const { A } = env;
  const first = await purchase(env, A, "s055-first");
  const subject = await jobSubjectOf(env, first.authorizationId);
  // without its event, and with its event but without the JOB_EXECUTION outbox record, the job cannot commit (KA003)
  await refusedTransaction(env.app, tenant(A), (c) => insertJobRow(c, subject), "KA003", "a job without its queued event");
  await refusedTransaction(
    env.app,
    tenant(A),
    async (c) => {
      const jobId = await insertJobRow(c, subject);
      await queuedEvent(c, A.agencyId, jobId, false, A.ownerUserId);
    },
    "KA003",
    "a job whose queued event has no JOB_EXECUTION outbox record",
  );
  assert.deepEqual(await oracle(env, "SELECT count(*)::int AS n FROM kauro.processing_jobs WHERE authorization_id = $1", [first.authorizationId]), [{ n: 0 }], "nothing of the refused jobs remains");
  // with both, it commits: one QUEUED job at version 1 with its event and one due outbox record
  const jobId = await within(env.app, tenant(A), async (c) => {
    const id = await insertJobRow(c, subject);
    await queuedEvent(c, A.agencyId, id, true, A.ownerUserId);
    return id;
  });
  const [committed] = await oracle<{ state: string; version: string; holds: string; outbox: number }>(
    env,
    `SELECT j.state, j.version::text AS version, j.holds,
            (SELECT count(*)::int FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id
              WHERE e.aggregate_id = j.job_id AND e.event_type = 'processing_job.queued.v1' AND o.consumer = 'JOB_EXECUTION' AND o.state = 'PENDING') AS outbox
       FROM kauro.processing_jobs j WHERE j.job_id = $1`,
    [jobId],
  );
  assert.deepEqual(committed, { state: "QUEUED", version: "1", holds: "BACKLOG", outbox: 1 });
  // one job per commercial authorization, for good (D8-JOB-1)
  await within(env.app, tenant(A), async (c) => {
    await refused(c, () => insertJobRow(c, subject), "23505", "a second job of one authorization", "processing_jobs_one_per_authorization");
  });
  // one live job per project: the included source replacement re-binds the paid capture to a new authorization of the same project
  // while the first job is still QUEUED (the payment service revokes the replaced entitlement SOURCE_REPLACED, D-QUOTE-B6)
  const q1 = await oracle<{ quote_id: string; revision_id: string }>(
    env,
    "SELECT a.quote_id, r.revision_id FROM kauro.commercial_authorizations a JOIN kauro.dataset_revisions r ON r.agency_id = a.agency_id AND r.project_id = a.project_id AND r.manifest_hash = a.revision_hash WHERE a.authorization_id = $1",
    [first.authorizationId],
  );
  const r2 = await replacementSource({ app: env.app, control: env.control }, A, first.projectId, q1[0]!.revision_id, "s055-r2");
  const s2 = await approvedSubject({ app: env.app, control: env.control }, env.validator, env.assurance, A, first.projectId, "s055-s2", r2);
  const q2 = await issuedQuote(env.app, A, s2, env.profiles.get(A.agencyId)!, env.routes.issuerRef, { replacesQuoteId: q1[0]!.quote_id });
  const secondAuthorization = ids.next();
  await env.h.commerce.run(env.h.service(), async (uow: CommerceUnitOfWork) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", first.orderId)) === null) throw new Error("the payment service did not adopt the order's scope");
    const now = clock.now();
    const rebindingId = uow.ids.next();
    await uow.commerce.rebindings.record({
      rebindingId: rebindingId as never,
      agencyId: A.agencyId,
      projectId: first.projectId as never,
      orderId: first.orderId as never,
      captureId: first.captureId as never,
      fromQuoteId: q1[0]!.quote_id as never,
      fromAuthorizationId: first.authorizationId as never,
      toQuoteId: q2.quoteId as never,
      allowanceOrdinal: 1,
      reasonCode: "PRE_EXECUTION_SOURCE_REPLACEMENT",
      lineageEvidenceHash: sha(`lineage-${rebindingId}`),
      requestedByMembershipId: A.ownerMembershipId as never,
      createdAt: now,
    });
    await uow.commerce.authorizations.transition(first.authorizationId as never, 1, { state: "REVOKED", revocation: { at: now, phase: "PRE_EXECUTION", code: "SOURCE_REPLACED" } }, now);
    await uow.commerce.quotes.transition(q1[0]!.quote_id as never, 3, { state: "SUPERSEDED", supersededByQuoteId: q2.quoteId as never }, now);
    await uow.commerce.quotes.transition(q2.quoteId as never, 2, { state: "ACCEPTED_FOR_CHECKOUT" }, now);
    await uow.commerce.authorizations.issue({
      authorizationId: secondAuthorization as never,
      agencyId: A.agencyId,
      projectId: first.projectId as never,
      quoteId: q2.quoteId as never,
      orderId: first.orderId as never,
      orderQuoteId: q1[0]!.quote_id as never,
      captureId: first.captureId as never,
      rebindingId: rebindingId as never,
      approvalId: s2.approvalId as never,
      approvalHash: s2.approvalHash,
      planId: s2.planId as never,
      planHash: s2.planHash,
      revisionHash: s2.revisionHash,
      targetContractHash: s2.targetContractHash,
      capabilityId: env.hubspot as never,
      capabilityVersion: "R2-INITIAL",
      mode: "HUBSPOT",
      billableUnits: q2.billableUnits,
      honoredAfterPriceExpiry: false,
      createdAt: now,
    });
  });
  const secondSubject = await jobSubjectOf(env, secondAuthorization);
  await within(env.app, tenant(A), async (c) => {
    await refused(c, () => insertJobRow(c, secondSubject), "23505", "a second live job of one project", "processing_jobs_one_live_per_project");
  });
  // the neighbour: once the first job ends (EXECUTION_CONTROL cancels it for its revoked entitlement), the project's next job commits
  await endJob(env.h, A, jobId, "AUTHORIZATION_REVOKED");
  const second = await queueJob(env.h, A, secondAuthorization);
  assert.equal(second.state, "QUEUED");
  await endJob(env.h, A, second.jobId);
});

test("S056 at the database: a staged manifest, a verification or a publication of an attempt whose fence is not its job lease's current fence is refused KA080, and an attempt's provider job identity is its own deterministic identity, learned once", async () => {
  const { A } = env;
  const p = await purchase(env, A, "s056");
  const queued = await queueJob(env.h, A, p.authorizationId);
  const admitted = await admitJob(env.h, A, queued.jobId);
  assert.deepEqual([admitted.attempt.state, admitted.attempt.fence, admitted.lease.fence, admitted.lease.ownerId], ["CLAIMED", 1, 1, admitted.attempt.attemptId]);
  const a1 = admitted.attempt.attemptId;
  // the identity and the prefix are the attempt's own, by CHECK: a second attempt named otherwise is refused (23514)
  await asControl(env, A, async (c) => {
    const other = ids.next();
    await refused(
      c,
      () =>
        c.query("INSERT INTO kauro.processing_attempts (attempt_id, agency_id, project_id, job_id, ordinal, identity, staging_prefix) VALUES ($1, $2, $3, $4, 2, 'kauro-attempt-other', $5)", [
          other,
          A.agencyId,
          p.projectId,
          queued.jobId,
          `staging/${A.agencyId}/${p.projectId}/${queued.jobId}/${other}/`,
        ]),
      "23514",
      "an attempt whose identity is not kauro-attempt-<its id>",
      "processing_attempts_identity",
    );
  });
  // the launch intent records the manifest name inside the attempt's prefix; the provider job the host reports is the identity itself
  await env.h.execution.run({ kind: "SYSTEM", serviceId: "control-plane", correlationId: ids.next() as never, agencyId: A.agencyId }, async (uow) => {
    await uow.execution.recordLaunchIntent(a1, { manifestObjectName: `${admitted.attempt.stagingPrefix}${ids.next()}` });
  });
  await asControl(env, A, async (c) => {
    await refused(c, () => c.query("UPDATE kauro.processing_attempts SET launch_state = 'LAUNCHED', provider_job_id = $2 WHERE attempt_id = $1", [a1, `kauro-attempt-${ids.next()}`]), "23514", "another provider job than the attempt's identity", "processing_attempts_provider_identity");
    await c.query("UPDATE kauro.processing_attempts SET launch_state = 'LAUNCHED', provider_job_id = identity WHERE attempt_id = $1", [a1]);
  });
  // learned once: a second provider job id is refused (KA004), even an UNCERTAIN relaunch cannot re-point it
  await asControl(env, A, async (c) => {
    await refused(c, () => c.query("UPDATE kauro.processing_attempts SET provider_job_id = 'kauro-attempt-' || $2 WHERE attempt_id = $1", [a1, ids.next()]), "KA004", "a second provider job id");
  });
  await env.h.execution.run({ kind: "SYSTEM", serviceId: "control-plane", correlationId: ids.next() as never, agencyId: A.agencyId }, (uow) => uow.execution.observeStart(a1));
  assert.deepEqual(await oracle(env, "SELECT provider_job_id = identity AS own, launch_state FROM kauro.processing_attempts WHERE attempt_id = $1", [a1]), [{ own: true, launch_state: "LAUNCHED" }]);

  // a staged manifest of the attempt after its lease was taken over at fence 2 (the old worker survives the takeover): KA080
  const attempt = await oracle<{ manifest_object_name: string; staging_prefix: string }>(env, "SELECT manifest_object_name, staging_prefix FROM kauro.processing_attempts WHERE attempt_id = $1", [a1]);
  await refusedTransaction(
    env.control,
    service(A.agencyId),
    async (c) => {
      await takeOverLease(c, queued.jobId);
      await c.query(
        `INSERT INTO kauro.staged_manifests (attempt_id, agency_id, project_id, job_id, fence, input_binding_hash, object_name, generation, manifest_hash, artifact_count, declared_summary_hash)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, 1, $9)`,
        [a1, A.agencyId, p.projectId, queued.jobId, queued.inputBindingHash, attempt[0]!.manifest_object_name, fixtureGeneration(), sha("stale-manifest"), sha("summary")],
      );
    },
    "KA080",
    "a staged manifest of the attempt whose lease another owner took over",
  );
  // the current owner stages; a verification after a takeover is refused KA080
  const staging = await stageJob(env.h, A, queued.jobId);
  await env.h.execution.run({ kind: "SYSTEM", serviceId: "control-plane", correlationId: ids.next() as never, agencyId: A.agencyId }, async (uow) => {
    await uow.execution.startVerification(a1);
    for (const a of staging.artifacts) {
      await uow.execution.recordReadback({ readbackId: ids.next() as never, attemptId: a1, kind: "STAGING", objectName: a.objectName, expected: { generation: a.generation, sha256: a.sha256, byteLength: a.byteLength }, observed: { generation: a.generation, sha256: a.sha256, byteLength: a.byteLength } });
    }
  });
  await refusedTransaction(
    env.control,
    service(A.agencyId),
    async (c) => {
      await takeOverLease(c, queued.jobId);
      await c.query(
        `INSERT INTO kauro.package_verifications (verification_id, agency_id, job_id, attempt_id, package_version_id, result, problems, evidence_class, expected_authority_hash, core_version)
         VALUES ($1, $2, $3, $4, $5, 'VALID', '[]'::jsonb, 'SIMULATED', $6, 'contract-fake-migration-core-2.0.3')`,
        [ids.next(), A.agencyId, queued.jobId, a1, staging.packageVersion.packageVersionId, sha("expected")],
      );
    },
    "KA080",
    "a verification of the attempt whose lease another owner took over",
  );
  // the current owner verifies and copies; a publication after a takeover is refused KA080, and the package stays private
  await env.h.execution.run({ kind: "SYSTEM", serviceId: "control-plane", correlationId: ids.next() as never, agencyId: A.agencyId }, async (uow) => {
    const v = await uow.execution.recordVerification({ verificationId: ids.next() as never, attemptId: a1, packageVersionId: staging.packageVersion.packageVersionId, result: "VALID", problems: [], evidenceClass: "SIMULATED", expectedAuthorityHash: sha("expected"), coreVersion: "contract-fake-migration-core-2.0.3" });
    await uow.execution.markVerifiedPrivate(staging.packageVersion.packageVersionId, v.verificationId);
  });
  await refusedTransaction(
    env.control,
    service(A.agencyId),
    async (c) => {
      await takeOverLease(c, queued.jobId);
      await rawStore(c).publish({ jobId: queued.jobId, packageVersionId: staging.packageVersion.packageVersionId, deliveryManifestHash: sha("delivery"), anchorId: ids.next() });
    },
    "KA080",
    "a publication of the attempt whose lease another owner took over",
  );
  assert.deepEqual(await oracle(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [staging.packageVersion.packageVersionId]), [{ state: "VERIFIED_PRIVATE" }]);
  assert.deepEqual(await oracle(env, "SELECT owner_id, fence::int AS fence FROM kauro.leases WHERE resource_id = $1", [queued.jobId]), [{ owner_id: a1, fence: 1 }], "every takeover rolled back with its refusal");
  await endJob(env.h, A, queued.jobId);
});

test("S061 at the database: a package version becomes AVAILABLE only when every artifact of its staged manifest was read back at exactly its generation, sha256 and length from the attempt's own staging prefix, every delivery copy likewise, and the verification is VALID; a partial or foreign read-back is refused KA084", async () => {
  const { A } = env;
  const p = await purchase(env, A, "s061");
  const queued = await queueJob(env.h, A, p.authorizationId);
  await admitJob(env.h, A, queued.jobId);
  const { attempt } = await launchJob(env.h, A, queued.jobId);
  const staging = await stageJob(env.h, A, queued.jobId, fixtureArtifacts(attempt, 2));
  const [first, second] = staging.artifacts;
  assert.ok(first && second);
  const pkg = staging.packageVersion.packageVersionId;
  const control = { kind: "SYSTEM" as const, serviceId: "control-plane", correlationId: ids.next() as never, agencyId: A.agencyId };
  await env.h.execution.run(control, (uow) => uow.execution.startVerification(attempt.attemptId));
  const readback = (c: Client, a: { objectName: string; generation: string; sha256: string; byteLength: number }, observed: { generation: string; sha256: string; bytes: number } | null, kind: "STAGING" | "DELIVERY" = "STAGING", packageVersionId: string | null = null) =>
    c.query(
      `INSERT INTO kauro.artifact_readbacks (readback_id, agency_id, job_id, attempt_id, kind, package_version_id, object_name, expected_generation, expected_sha256, expected_bytes,
          observed_generation, observed_sha256, observed_bytes, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        ids.next(),
        A.agencyId,
        queued.jobId,
        attempt.attemptId,
        kind,
        packageVersionId,
        a.objectName,
        a.generation,
        a.sha256,
        a.byteLength,
        observed?.generation ?? null,
        observed?.sha256 ?? null,
        observed?.bytes ?? null,
        observed === null ? "MISSING" : observed.generation === a.generation && observed.sha256 === a.sha256 && observed.bytes === a.byteLength ? "EQUAL" : "MISMATCH",
      ],
    );
  const valid = (c: Client) =>
    c.query(
      `INSERT INTO kauro.package_verifications (verification_id, agency_id, job_id, attempt_id, package_version_id, result, problems, evidence_class, expected_authority_hash, core_version)
       VALUES ($1, $2, $3, $4, $5, 'VALID', '[]'::jsonb, 'SIMULATED', $6, 'contract-fake-migration-core-2.0.3')`,
      [ids.next(), A.agencyId, queued.jobId, attempt.attemptId, pkg, sha("expected")],
    );
  const exact = (a: typeof first) => ({ generation: a.generation, sha256: a.sha256, bytes: a.byteLength });
  // a partial blob (fewer bytes than the manifest names), an overwritten or foreign generation, a missing object: the VALID
  // verification is refused KA084 (each probe in a transaction that rolls back its read-backs)
  for (const [what, observed] of [
    ["a partial blob", { ...exact(second), bytes: second.byteLength - 1 }],
    ["a foreign generation", { ...exact(second), generation: fixtureGeneration() }],
    ["another digest", { ...exact(second), sha256: sha("tampered") }],
    ["a missing object", null],
  ] as const) {
    await refusedTransaction(
      env.control,
      service(A.agencyId),
      async (c) => {
        await readback(c, first, exact(first));
        await readback(c, second, observed);
        await valid(c);
      },
      "KA084",
      `a VALID verification over ${what}`,
    );
  }
  // one artifact read back is not every artifact
  await refusedTransaction(env.control, service(A.agencyId), async (c) => {
    await readback(c, first, exact(first));
    await valid(c);
  }, "KA084", "a VALID verification with an artifact never read back");
  // a read-back of an object that is not an artifact of the attempt's own staged manifest (another prefix, or other values) is
  // refused before it is recorded (KA080)
  await asControl(env, A, async (c) => {
    await refused(c, () => readback(c, { ...first, objectName: `staging/${A.agencyId}/${p.projectId}/${queued.jobId}/${ids.next()}/${ids.next()}` }, exact(first)), "KA080", "a read-back of a foreign object");
    await refused(c, () => readback(c, { ...first, generation: fixtureGeneration() }, exact(first)), "KA080", "a read-back expecting another generation than the staged one");
  });
  // every staging read-back equal: VALID and VERIFIED_PRIVATE commit
  const verification = await within(env.control, service(A.agencyId), async (c) => {
    await readback(c, first, exact(first));
    await readback(c, second, exact(second));
    const id = ids.next();
    await c.query(
      `INSERT INTO kauro.package_verifications (verification_id, agency_id, job_id, attempt_id, package_version_id, result, problems, evidence_class, expected_authority_hash, core_version)
       VALUES ($1, $2, $3, $4, $5, 'VALID', '[]'::jsonb, 'SIMULATED', $6, 'contract-fake-migration-core-2.0.3')`,
      [id, A.agencyId, queued.jobId, attempt.attemptId, pkg, sha("expected")],
    );
    return id;
  });
  await env.h.execution.run(control, (uow) => uow.execution.markVerifiedPrivate(pkg as never, verification as never));
  // the delivery copies, each read back; a partial copy or a missing copy's read-back refuses the publication at COMMIT (KA084)
  const copies = await env.h.execution.run(control, async (uow) => {
    const out = [];
    for (const a of [first, second]) {
      out.push(await uow.execution.recordDeliveryCopy({ packageVersionId: pkg as never, location: { provider: "contract-fake-storage", locationRef: "DELIVERY_PRIMARY" }, sourceObjectName: a.objectName, objectId: ids.next() as never, objectName: `${staging.packageVersion.deliveryPrefix}${ids.next()}`, generation: fixtureGeneration() }));
    }
    return out;
  });
  const [copy1, copy2] = copies;
  assert.ok(copy1 && copy2);
  await refusedTransaction(env.control, service(A.agencyId), async (c) => {
    await readback(c, copy1, { generation: copy1.generation, sha256: copy1.sha256, bytes: copy1.byteLength }, "DELIVERY", pkg);
    await readback(c, copy2, { generation: copy2.generation, sha256: copy2.sha256, bytes: copy2.byteLength - 10 }, "DELIVERY", pkg);
    await rawStore(c).publish({ jobId: queued.jobId, packageVersionId: pkg as never, deliveryManifestHash: sha("delivery"), anchorId: ids.next() });
  }, "KA084", "a publication over a partial delivery copy");
  await refusedTransaction(env.control, service(A.agencyId), async (c) => {
    await readback(c, copy1, { generation: copy1.generation, sha256: copy1.sha256, bytes: copy1.byteLength }, "DELIVERY", pkg);
    await rawStore(c).publish({ jobId: queued.jobId, packageVersionId: pkg as never, deliveryManifestHash: sha("delivery"), anchorId: ids.next() });
  }, "KA084", "a publication with a delivery copy never read back");
  assert.deepEqual(await oracle(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [pkg]), [{ state: "VERIFIED_PRIVATE" }], "the refused publications left the package private");
  // the complete neighbour: every staging and delivery read-back equal, VALID — the publication commits
  await within(env.control, service(A.agencyId), async (c) => {
    await readback(c, copy1, { generation: copy1.generation, sha256: copy1.sha256, bytes: copy1.byteLength }, "DELIVERY", pkg);
    await readback(c, copy2, { generation: copy2.generation, sha256: copy2.sha256, bytes: copy2.byteLength }, "DELIVERY", pkg);
    const outcome = await rawStore(c).publish({ jobId: queued.jobId, packageVersionId: pkg as never, deliveryManifestHash: sha("delivery"), anchorId: ids.next() });
    assert.equal(outcome.kind, "PUBLISHED");
  });
  assert.deepEqual(await oracle(env, "SELECT p.state AS package, j.state AS job, a.state AS authorization FROM kauro.package_versions p JOIN kauro.processing_jobs j ON j.job_id = p.job_id JOIN kauro.commercial_authorizations a ON a.authorization_id = j.authorization_id WHERE p.package_version_id = $1", [pkg]), [
    { package: "AVAILABLE", job: "READY", authorization: "DELIVERED" },
  ]);
});

test("R2-045 at the database: a package version cannot become AVAILABLE while its job's commercial authorization is REVOKED, its verification evidence and private artifacts remain, and the revocation and the publication serialize on the authorization's transition lock in both interleavings", async () => {
  const { A } = env;
  const verifiedJob = async (seed: string) => {
    const p = await purchase(env, A, seed);
    const job = await queueJob(env.h, A, p.authorizationId);
    await admitJob(env.h, A, job.jobId);
    await launchJob(env.h, A, job.jobId);
    const staging = await stageJob(env.h, A, job.jobId);
    const pkg = await verifyJob(env.h, A, job.jobId);
    return { p, job, pkg, staging };
  };
  // --- interleaving 1: the payment service's revocation (a reversal during execution) holds the authorization first ----------------
  const one = await verifiedJob("r2-045-revocation-first");
  await env.payment.query("BEGIN");
  let revoked = false;
  try {
    await env.payment.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true), set_config('kauro.finance_agency_id', '', true)", [A.agencyId]);
    await revokeAuthorization(env.payment, A, one.p.authorizationId);
    await env.control.query("BEGIN");
    try {
      await env.control.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [A.agencyId]);
      const pid = await backendPid(env.control);
      const publication = rawStore(env.control).publish({ jobId: one.job.jobId, packageVersionId: one.pkg.packageVersionId, deliveryManifestHash: sha("delivery-1"), anchorId: ids.next() });
      const seen = await settlesOrWaits(env.h.oracle, pid, publication, "the publication behind the uncommitted revocation");
      assert.equal(seen.kind, "WAITING", "the publication waits for the revocation on the authorization");
      await env.payment.query("COMMIT");
      revoked = true;
      if (seen.kind === "WAITING") {
        const settled = await seen.pending;
        assert.equal(settled.status, "fulfilled", "the publication writes its edges; the database decides at COMMIT");
      }
      await assert.rejects(env.control.query("COMMIT"), (e: unknown) => sqlState(e) === "KA081", "no package becomes AVAILABLE under a REVOKED authorization");
    } catch (e) {
      await env.control.query("ROLLBACK");
      throw e;
    }
  } finally {
    if (!revoked) await env.payment.query("ROLLBACK");
  }
  assert.deepEqual(await oracle(env, "SELECT state, revocation_phase FROM kauro.commercial_authorizations WHERE authorization_id = $1", [one.p.authorizationId]), [{ state: "REVOKED", revocation_phase: "DURING_EXECUTION" }]);
  // the evidence and the private artifacts remain for reconciliation
  assert.deepEqual(await oracle(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [one.pkg.packageVersionId]), [{ state: "VERIFIED_PRIVATE" }]);
  assert.deepEqual(await oracle(env, "SELECT result FROM kauro.package_verifications WHERE package_version_id = $1", [one.pkg.packageVersionId]), [{ result: "VALID" }]);
  assert.deepEqual(
    await oracle(env, "SELECT count(*)::int AS staged, count(*) FILTER (WHERE o.state = 'VERIFIED')::int AS verified FROM kauro.staged_artifacts a JOIN kauro.stored_objects o ON o.object_id = a.object_id WHERE a.attempt_id = $1", [one.job.currentAttemptId ?? (await jobAttempt(one.job.jobId))]),
    [{ staged: 2, verified: 2 }],
  );
  assert.deepEqual(await oracle(env, "SELECT count(*)::int AS n FROM kauro.delivery_artifacts WHERE package_version_id = $1", [one.pkg.packageVersionId]), [{ n: 2 }]);
  assert.deepEqual(await oracle(env, "SELECT count(*)::int AS n FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'commercial_authorization.delivered.v1'", [one.p.authorizationId]), [{ n: 0 }]);
  await endJob(env.h, A, one.job.jobId, "AUTHORIZATION_REVOKED");

  // --- interleaving 2: the publication holds the authorization first; the revocation waits and then revokes after delivery ----------
  const two = await verifiedJob("r2-045-publication-first");
  await env.control.query("BEGIN");
  let published = false;
  try {
    await env.control.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [A.agencyId]);
    const outcome = await rawStore(env.control).publish({ jobId: two.job.jobId, packageVersionId: two.pkg.packageVersionId, deliveryManifestHash: sha("delivery-2"), anchorId: ids.next() });
    assert.equal(outcome.kind, "PUBLISHED");
    await env.payment.query("BEGIN");
    try {
      await env.payment.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true), set_config('kauro.finance_agency_id', '', true)", [A.agencyId]);
      const pid = await backendPid(env.payment);
      const revocation = revokeAuthorization(env.payment, A, two.p.authorizationId);
      const seen = await settlesOrWaits(env.h.oracle, pid, revocation, "the revocation behind the uncommitted publication");
      assert.equal(seen.kind, "WAITING", "the revocation waits for the publication on the authorization");
      await env.control.query("COMMIT");
      published = true;
      if (seen.kind === "WAITING") assert.equal((await seen.pending).status, "fulfilled");
      await env.payment.query("COMMIT");
    } catch (e) {
      await env.payment.query("ROLLBACK");
      throw e;
    }
  } finally {
    if (!published) await env.control.query("ROLLBACK");
  }
  assert.deepEqual(await oracle(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [two.pkg.packageVersionId]), [{ state: "AVAILABLE" }]);
  assert.deepEqual(await oracle(env, "SELECT state, revocation_phase, delivered_at IS NOT NULL AS delivered FROM kauro.commercial_authorizations WHERE authorization_id = $1", [two.p.authorizationId]), [
    { state: "REVOKED", revocation_phase: "POST_DELIVERY", delivered: true },
  ]);
});

async function jobAttempt(jobId: string): Promise<string> {
  const [row] = await oracle<{ current_attempt_id: string }>(env, "SELECT current_attempt_id FROM kauro.processing_jobs WHERE job_id = $1", [jobId]);
  assert.ok(row);
  return row.current_attempt_id;
}

test("R2-046 at the database: the ledgers admit at most one ACTIVE and three WAITING jobs globally and three live jobs per agency, a fourth live job of one agency is refused, and the ledgers cannot be edited around the jobs they summarize (KA082)", async () => {
  const { A, B } = env;
  assert.deepEqual([EXECUTION_POLICY.heavyActive, EXECUTION_POLICY.heavyQueued, EXECUTION_POLICY.agencyLiveJobs], [1, 3, 3]);
  const before = await ledgers(A.agencyId);
  assert.deepEqual([before.active, before.waiting, before.live], [0, 0, 0], "the earlier tests ended every job they started");
  const purchases: Awaited<ReturnType<typeof purchase>>[] = [];
  for (const seed of ["r2-046-a1", "r2-046-a2", "r2-046-a3", "r2-046-a4"]) purchases.push(await purchase(env, A, seed));
  const other = await purchase(env, B, "r2-046-b1");
  // three live jobs of agency A; the fourth is refused with nothing written and its authorization ACTIVE (CAPACITY_UNAVAILABLE)
  const jobs: Awaited<ReturnType<typeof queueJob>>[] = [];
  for (const p of purchases.slice(0, 3)) jobs.push(await queueJob(env.h, A, p.authorizationId));
  // the adapters read the same ledgers: checkout sees agency A's bound reached and agency B's free (D8-CAP-2), the control plane's
  // snapshot counts the three, and its admission candidates come in the pure scheduler's order (D8-SCHED-1)
  const checkout = (ag: typeof A) => env.h.execution.run(env.h.tenant(ag.agencyId, ag.ownerUserId), (uow) => executionReadsOf(uow).checkoutCapacity({ agencyId: ag.agencyId }));
  assert.deepEqual(await checkout(A), { available: false, reason: "ADMISSION_QUEUE_FULL" });
  assert.equal((await checkout(B)).available, true);
  const seen = await env.h.execution.run(controlOf(A.agencyId), async (uow) => ({ snapshot: await uow.execution.capacity(A.agencyId), candidates: await uow.execution.admissionCandidates(10) }));
  assert.deepEqual(seen.snapshot, { activeJobs: 0, waitingJobs: 0, agencyLiveJobs: 3 });
  assert.deepEqual(seen.candidates.map((c) => c.jobId), jobs.map((j) => j.jobId), "one agency's jobs by their queue instants");
  assert.deepEqual(fairAdmissionOrder(seen.candidates), seen.candidates);
  await assert.rejects(queueJob(env.h, A, purchases[3]!.authorizationId), (e: unknown) => isDomainFailure(e) && e.code === "CAPACITY_UNAVAILABLE" && e.reason === "EXECUTION_QUEUE_FULL" && causeConstraint(e) === "agency_execution_capacity_live_within_limit");
  assert.deepEqual(await oracle(env, "SELECT state, (SELECT count(*)::int FROM kauro.processing_jobs WHERE authorization_id = $1) AS jobs FROM kauro.commercial_authorizations WHERE authorization_id = $1", [purchases[3]!.authorizationId]), [{ state: "ACTIVE", jobs: 0 }]);
  // three admissions fill the platform's three WAITING slots; another agency's fourth admission is refused
  for (const j of jobs) await admitJob(env.h, A, j.jobId);
  const queuedB = await queueJob(env.h, B, other.authorizationId);
  await assert.rejects(admitJob(env.h, B, queuedB.jobId), (e: unknown) => causeState(e) === "23514" && causeConstraint(e) === "execution_capacity_waiting_within_limit");
  assert.deepEqual(await oracle(env, "SELECT state, holds FROM kauro.processing_jobs WHERE job_id = $1", [queuedB.jobId]), [{ state: "QUEUED", holds: "BACKLOG" }]);
  // the one ACTIVE slot: the first launch takes it (a waiting slot frees), the second launch is refused
  await launchJob(env.h, A, jobs[0]!.jobId);
  await admitJob(env.h, B, queuedB.jobId);
  await assert.rejects(launchJob(env.h, A, jobs[1]!.jobId), (e: unknown) => causeState(e) === "23514" && causeConstraint(e) === "execution_capacity_active_within_limit");
  const full = await ledgers(A.agencyId);
  assert.deepEqual([full.active, full.waiting, full.live], [1, 3, 3]);
  assert.deepEqual([full.jobs_active, full.jobs_waiting, full.jobs_live], [1, 3, 3], "the ledgers equal what the jobs hold");
  // the ledgers cannot be edited around the jobs they summarize: at COMMIT (the one-snapshot check), whoever writes them (KA082)
  await refusedTransaction(env.control, service(A.agencyId), (c) => c.query("UPDATE kauro.execution_capacity SET waiting_jobs = waiting_jobs - 1 WHERE ledger_id = 1"), "KA082", "the control plane frees a waiting slot no job released");
  await refusedTransaction(env.app, tenant(A), (c) => c.query("UPDATE kauro.agency_execution_capacity SET live_jobs = live_jobs - 1 WHERE agency_id = $1", [A.agencyId]), "KA082", "a request handler frees its agency's live slot");
  await refusedTransaction(env.control, service(A.agencyId), (c) => c.query("UPDATE kauro.agency_execution_capacity SET last_admitted_at = now() - interval '1 year' WHERE agency_id = $1", [A.agencyId]), "KA082", "an agency moved ahead in the fair order by its own ledger");
  // a job cannot move its slot beside its state either (KA082), nor launch without an admission
  await asControl(env, A, async (c) => {
    await refused(c, () => c.query("UPDATE kauro.processing_jobs SET holds = 'NONE' WHERE job_id = $1", [jobs[1]!.jobId]), "KA082", "a waiting job released outside its edges");
  });
  // ending the jobs releases every slot once
  for (const j of [...jobs, queuedB]) await endJob(env.h, j.agencyId === B.agencyId ? B : A, j.jobId);
  const after = await ledgers(A.agencyId);
  assert.deepEqual([after.active, after.waiting, after.live, after.jobs_active, after.jobs_waiting], [0, 0, 0, 0, 0]);
});

test("CMD036 at the database: a job binds exactly its authorization's project, plan, approval, source, target and capability, only while the authorization is ACTIVE, and request handlers can neither admit, consume, launch nor publish", async () => {
  const { A } = env;
  const p = await purchase(env, A, "cmd036");
  const subject = await jobSubjectOf(env, p.authorizationId);
  const otherProject = (await purchase(env, A, "cmd036-other")).projectId;
  // every binding of the subject is the authorization's (a mismatched key is 23503)
  await within(env.app, tenant(A), async (c) => {
    for (const [column, value] of [
      ["project_id", otherProject],
      ["plan_hash", sha("another-plan")],
      ["approval_hash", sha("another-approval")],
      ["revision_hash", sha("another-source")],
      ["target_contract_hash", sha("another-target")],
      ["capability_version", "R2-OTHER"],
    ] as const) {
      await refused(c, () => insertJobRow(c, subject, { [column]: value }), "23503", `a job naming another ${column}`, column === "project_id" ? undefined : "processing_jobs_authorization_subject_fk");
    }
    await refused(c, () => insertJobRow(c, subject, { core_package_hash: sha("another-core") }), "23503", "a job naming another core package than its receipt's", "processing_jobs_receipt_fk");
  });
  // only while the authorization is ACTIVE: a revoked entitlement binds no job (KA081)
  const revokedPurchase = await purchase(env, A, "cmd036-revoked");
  await revokeCommitted(env, A, revokedPurchase.authorizationId, "CUSTOMER_CANCELLED");
  const revokedSubject = await jobSubjectOf(env, revokedPurchase.authorizationId);
  await refusedTransaction(env.app, tenant(A), (c) => insertJobRow(c, revokedSubject), "KA081", "a job of a REVOKED authorization");
  // the legitimate job commits through the adapter (its event and outbox record)
  const job = await queueJob(env.h, A, p.authorizationId);
  assert.equal(job.inputBindingHash, jobInputBindingHashOf({ ...job } as never));
  // request handlers can neither admit, consume, launch nor publish (42501), nor publish the control plane's events
  await within(env.app, tenant(A), async (c) => {
    await refused(c, () => c.query("UPDATE kauro.processing_jobs SET version = 2, state = 'ADMITTED' WHERE job_id = $1", [job.jobId]), "42501", "a request handler admits a job");
    await refused(c, () => c.query("UPDATE kauro.processing_jobs SET holds = 'ACTIVE' WHERE job_id = $1", [job.jobId]), "42501", "a request handler takes a slot");
    await refused(c, () => c.query("UPDATE kauro.commercial_authorizations SET version = 2, state = 'CONSUMED', job_ref = $2, consumed_at = now() WHERE authorization_id = $1", [p.authorizationId, job.jobId]), "42501", "a request handler consumes the entitlement");
    const rogue = ids.next();
    await refused(c, () => c.query("INSERT INTO kauro.processing_attempts (attempt_id, agency_id, project_id, job_id, ordinal, identity, staging_prefix) VALUES ($1, $2, $3, $4, 1, $5, 'staging/')", [rogue, A.agencyId, p.projectId, job.jobId, `kauro-attempt-${rogue}`]), "42501", "a request handler launches an attempt");
    await refused(c, () => c.query("UPDATE kauro.package_versions SET state = 'AVAILABLE' WHERE job_id = $1", [job.jobId]), "42501", "a request handler publishes a package");
    await refused(c, () => c.query("INSERT INTO kauro.staged_manifests (attempt_id, agency_id, project_id, job_id, fence, input_binding_hash, object_name, generation, manifest_hash, artifact_count, declared_summary_hash) VALUES ($1, $2, $3, $4, 1, $5, 'staging/x/y', '1', $5, 1, $5)", [ids.next(), A.agencyId, p.projectId, job.jobId, sha("x")]), "42501", "a request handler stages a manifest");
    for (const type of [...JOB_EVENT_TYPES.filter((t) => t !== "processing_job.queued.v1" && t !== "processing_job.cancel_requested.v1"), ...PACKAGE_EVENT_TYPES]) {
      await refused(c, () => commerceEvent(c, "processing_job", job.jobId, 1, A.agencyId, type, { kind: "USER", id: A.ownerUserId }), "42501", `a request handler publishes ${type}`);
    }
  });
  assert.deepEqual(await oracle(env, "SELECT state, version::int AS version FROM kauro.commercial_authorizations WHERE authorization_id = $1", [p.authorizationId]), [{ state: "ACTIVE", version: 1 }]);
  await endJob(env.h, A, job.jobId);
});

test("CMD037 at the database: after cancel_command no attempt of the job is created, launched, submitted or published, and a cancellation is recorded once with its actor, reason and version", async () => {
  const { A } = env;
  const tenantOf = () => env.h.tenant(A.agencyId as never, A.ownerUserId as never);
  const cancel = (job: { jobId: ProcessingJobId }, version: number, reasonCode = "Client asked to stop") =>
    env.h.execution.run(tenantOf(), (uow) => uow.execution.requestCancellation(job.jobId, version, { actor: { kind: "USER", userId: A.ownerUserId }, reasonCode }));
  // an admitted job (attempt 1 CLAIMED at fence 1) cancelled by the agency's operator: recorded once, with its actor, reason and version
  const p1 = await purchase(env, A, "cmd037-admitted");
  const j1 = await queueJob(env.h, A, p1.authorizationId);
  const admitted = await admitJob(env.h, A, j1.jobId);
  const cancelled = await cancel(j1, admitted.job.version);
  assert.equal(cancelled.kind, "APPLIED");
  assert.deepEqual(
    await oracle(env, "SELECT state, version::int AS version, cancel_version::int AS cancel_version, cancel_actor_kind, cancel_actor_id, cancel_reason_code, cancel_requested_at IS NOT NULL AS stamped FROM kauro.processing_jobs WHERE job_id = $1", [j1.jobId]),
    [{ state: "CANCEL_REQUESTED", version: 3, cancel_version: 1, cancel_actor_kind: "USER", cancel_actor_id: A.ownerUserId, cancel_reason_code: "Client asked to stop", stamped: true }],
  );
  assert.deepEqual(await oracle(env, "SELECT event_type FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [j1.jobId]), [
    { event_type: "processing_job.queued.v1" },
    { event_type: "processing_job.admitted.v1" },
    { event_type: "processing_job.cancel_requested.v1" },
  ]);
  // nothing after cancel_command: no new attempt, no launch (KA081); the cancellation is recorded once (KA004), never re-counted
  await asControl(env, A, async (c) => {
    const late = ids.next();
    await refused(c, () => c.query("INSERT INTO kauro.processing_attempts (attempt_id, agency_id, project_id, job_id, ordinal, identity, staging_prefix) VALUES ($1, $2, $3, $4, 2, $5, $6)", [late, A.agencyId, p1.projectId, j1.jobId, `kauro-attempt-${late}`, `staging/${A.agencyId}/${p1.projectId}/${j1.jobId}/${late}/`]), "KA081", "an attempt after cancel_command");
    await refused(c, () => c.query("UPDATE kauro.processing_jobs SET holds = 'ACTIVE' WHERE job_id = $1", [j1.jobId]), "KA081", "the active slot of a cancelled job");
    await refused(c, () => c.query("UPDATE kauro.processing_attempts SET state = 'STARTING', manifest_object_name = staging_prefix || $2 WHERE attempt_id = $1", [admitted.attempt.attemptId, ids.next()]), "KA081", "a launch intent after cancel_command");
    await refused(c, () => c.query("UPDATE kauro.processing_jobs SET cancel_reason_code = 'Another reason' WHERE job_id = $1", [j1.jobId]), "KA004", "a second reason for one cancellation");
    await refused(c, () => c.query("UPDATE kauro.processing_jobs SET cancel_actor_kind = 'SERVICE', cancel_actor_id = 'control-plane' WHERE job_id = $1", [j1.jobId]), "KA004", "another actor for one cancellation");
    await refused(c, () => c.query("UPDATE kauro.processing_jobs SET cancel_version = cancel_version + 1, version = version + 1 WHERE job_id = $1", [j1.jobId]), "KA081", "a cancellation version moved without cancel_command");
  });
  // a second cancel_command finds the job already cancelling (the listed edge does not exist from CANCEL_REQUESTED)
  await assert.rejects(cancel(j1, 3), (e: unknown) => isDomainFailure(e) && e.code === "PRECONDITION_FAILED" && e.reason === "UNLISTED_TRANSITION");
  await endJob(env.h, A, j1.jobId);
  assert.deepEqual(await oracle(env, "SELECT state, cancel_version::int AS cv, holds FROM kauro.processing_jobs WHERE job_id = $1", [j1.jobId]), [{ state: "CANCELLED", cv: 1, holds: "NONE" }]);

  // a running job cancelled: its manifest is submitted no more (KA081)
  const p2 = await purchase(env, A, "cmd037-running");
  const j2 = await queueJob(env.h, A, p2.authorizationId);
  await admitJob(env.h, A, j2.jobId);
  const running = await launchJob(env.h, A, j2.jobId);
  await cancel(j2, running.job.version);
  await asControl(env, A, async (c) => {
    await refused(
      c,
      () =>
        c.query(
          `INSERT INTO kauro.staged_manifests (attempt_id, agency_id, project_id, job_id, fence, input_binding_hash, object_name, generation, manifest_hash, artifact_count, declared_summary_hash)
           VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, 1, $9)`,
          [running.attempt.attemptId, A.agencyId, p2.projectId, j2.jobId, j2.inputBindingHash, running.attempt.manifestObjectName, fixtureGeneration(), sha("late-manifest"), sha("summary")],
        ),
      "KA081",
      "a manifest submitted after cancel_command",
    );
  });
  await endJob(env.h, A, j2.jobId);

  // a verified job cancelled before its publication: its publication is refused (KA081) and its package stays private
  const p3 = await purchase(env, A, "cmd037-verified");
  const j3 = await queueJob(env.h, A, p3.authorizationId);
  await admitJob(env.h, A, j3.jobId);
  await launchJob(env.h, A, j3.jobId);
  await stageJob(env.h, A, j3.jobId);
  const pkg = await verifyJob(env.h, A, j3.jobId);
  const verifying = await env.h.execution.run(tenantOf(), (uow) => uow.execution.getJob(j3.jobId));
  await cancel(j3, verifying!.version);
  await asControl(env, A, async (c) => {
    await refused(c, () => c.query("UPDATE kauro.processing_attempts SET state = 'COMMITTED' WHERE attempt_id = $1", [pkg.attemptId]), "KA081", "the commit of a cancelled job's attempt");
    await refused(c, () => c.query("UPDATE kauro.processing_jobs SET version = version + 1, state = 'READY', published_package_id = $2 WHERE job_id = $1", [j3.jobId, pkg.packageVersionId]), "KA008", "READY after cancel_command");
    const outcome = await rawStore(c).publish({ jobId: j3.jobId, packageVersionId: pkg.packageVersionId, deliveryManifestHash: sha("delivery"), anchorId: ids.next() });
    assert.deepEqual([outcome.kind, outcome.kind === "REFUSED" ? outcome.reason : null], ["REFUSED", "JOB_CANCELLED"]);
  });
  assert.deepEqual(await oracle(env, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [pkg.packageVersionId]), [{ state: "VERIFIED_PRIVATE" }]);
  await endJob(env.h, A, j3.jobId);
});

test("B08 seeds: the Job edges and initial state equal the registry and the ProcessingAttempt and PackageVersion seeds equal the domain's platform machines; the execution event types and aggregate kinds are registered with their tables", async () => {
  const job = STATE_MACHINES.find((m) => m.contract === "Job");
  assert.ok(job);
  for (const m of [job, ...EXECUTION_PLATFORM_MACHINES]) {
    const edges = await oracle<{ edge: string }>(env, "SELECT from_state || '>' || to_state AS edge FROM kauro.state_transitions WHERE machine = $1 ORDER BY 1", [m.contract]);
    assert.deepEqual(edges.map((r) => r.edge), [...new Set(m.transitions.map((t) => `${t.from}>${t.to}`))].sort(), m.contract);
    assert.deepEqual(await oracle(env, "SELECT initial_state FROM kauro.state_machines WHERE machine = $1", [m.contract]), [{ initial_state: m.initial }], m.contract);
  }
  const types = new Set((await oracle<{ event_type: string }>(env, "SELECT event_type FROM kauro.event_types")).map((r) => r.event_type));
  for (const t of EXECUTION_EVENT_TYPES) assert.ok(types.has(t), t);
  assert.deepEqual(
    await oracle(env, "SELECT aggregate_kind, table_name, id_column FROM kauro.aggregate_kinds WHERE aggregate_kind = ANY($1::text[]) ORDER BY 1", [[...EXECUTION_AGGREGATE_KINDS]]),
    [
      { aggregate_kind: "package_version", table_name: "package_versions", id_column: "package_version_id" },
      { aggregate_kind: "processing_job", table_name: "processing_jobs", id_column: "job_id" },
    ],
  );
});
