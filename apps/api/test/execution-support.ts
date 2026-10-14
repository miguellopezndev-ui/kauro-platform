/**
 * The shared steps of the request side's execution tests (package B08, mandate B08-COMMANDS-EXECUTION; docs/design/B08-audit-approval-jobs.md
 * §4 ExecuteProject, §5 cancellation, §12 the served routes): the routes and their call wrappers, the local shapes of the wire views,
 * the oracles over the job rows and the control plane's steps between commands.
 *
 * The control plane's steps (admission, launch, staging, verification, publication, ending a job) are written through the product's
 * adapters in control-plane units of work bound to the agency (B07 D-CMD-15, B08 D8-ROLE-1): a request handler holds no grant on
 * attempts, staging, read-backs, verifications or packages (D8-ROLE-2), so these are the only way a test can move a job past QUEUED.
 * The purchases are B09's `paidPurchase` fixture (commerce-support); the revocation of an authorization is B09's own payment-service
 * write (`authorizations.transition` in a payment-order scope, as the reconciler of the settle step performs it). No fake of this
 * mandate exists: the provider's launch, staging and verification are the persistence fixtures' labelled steps (SIMULATED).
 */
import assert from "node:assert/strict";
import { deliveryManifestHashOf, toUtcInstant, type PublicationOutcome } from "@kauro/domain";
import type { ProcessingJobId } from "@kauro/domain";
import { admitJob, barrier, controlOf, endJob, launchJob, stageJob, verifyJob } from "@kauro/persistence/testing";
import { accepted, read, readData, type PaymentsWorld } from "./commerce-support.js";
import { call, freshKey, ids, rawEvent, routes, type Reply } from "./support.js";
import { supersedeProject } from "./b17-target-supersession-support.js";
import { controlWriter, tenantWriter } from "./writers.js";

// --- routes and the wire shapes ------------------------------------------------------------------------------------------------------

export const executionRoutes = {
  executeProject: (projectId: string) => `/api/v1/projects/${projectId}/execute`,
  cancelJob: (jobId: string) => `/api/v1/jobs/${jobId}/cancel`,
  getJob: (jobId: string) => `/api/v1/jobs/${jobId}`,
};

/** The JobView as a customer reads it (design §12): no provider identity, no object name, no fence, no lease. */
export type JobView = {
  readonly jobId: string;
  readonly projectId: string;
  readonly authorizationId: string;
  readonly state: string;
  readonly version: number;
  readonly attempt: number;
  readonly queuedAt: string;
  readonly deliveryDeadlineAt: string;
  readonly executionDeadlineAt?: string;
  readonly cancelVersion: number;
  readonly cancelRequestedAt?: string;
  readonly activeProviderState?: string;
  readonly publishedPackageId?: string;
  readonly permittedActions: ReadonlyArray<string>;
};

/** A purchase paid by one capture, its plan approved through CMD025 (commerce-support `paidProject`). */
export type Sale = Awaited<ReturnType<PaymentsWorld["paidProject"]>>;

interface CallOptions {
  readonly key?: string;
  readonly token?: string;
  readonly agency?: string;
}

/** CMD036 ExecuteProject as an operator of agency A (the OPERATOR member) unless told otherwise. */
export function execute(pw: PaymentsWorld, sale: Pick<Sale, "projectId" | "authorizationId">, options: CallOptions & { readonly authorizationId?: string } = {}): Promise<Reply> {
  return call(pw.w, {
    url: executionRoutes.executeProject(sale.projectId),
    token: options.token ?? pw.w.operator.token,
    key: options.key ?? freshKey("cmd036"),
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body: { commercialAuthorizationId: options.authorizationId ?? sale.authorizationId },
  });
}

/** CMD037 CancelJob as an operator of agency A unless told otherwise. */
export function cancel(pw: PaymentsWorld, jobId: string, body: { readonly expectedVersion: number; readonly reasonCode: string }, options: CallOptions = {}): Promise<Reply> {
  return call(pw.w, {
    url: executionRoutes.cancelJob(jobId),
    token: options.token ?? pw.w.operator.token,
    key: options.key ?? freshKey("cmd037"),
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    body,
  });
}

/** GetJob as a member of agency A (a VIEWER by default: every membership role reads). */
export function getJob(pw: PaymentsWorld, jobId: string, token: string = pw.w.viewer.token, agency?: string): Promise<Reply> {
  return read(pw.w, executionRoutes.getJob(jobId), token, agency);
}

export function viewOf(reply: Reply): JobView {
  return readData<JobView>(reply);
}

/** The 202 of an accepted ExecuteProject: the job's identity. */
export function jobIdOf(reply: Reply): string {
  return accepted(reply).operationId;
}

/**
 * How the job row lock (PgExecutionStore.lockJob: SELECT ... FROM kauro.processing_jobs WHERE job_id = $1 FOR UPDATE) shows in pg_stat_activity: the
 * statement is cut at track_activity_query_size (1,024 bytes) before its FROM clause, so the head of its select list identifies it; a plain read
 * of the same columns never waits on a lock, so a backend in a lock wait on this head is waiting for the job row.
 */
export const JOB_ROW_LOCK = "SELECT job_id, agency_id, project_id, authorization_id, capture_id";

// --- oracles ---------------------------------------------------------------------------------------------------------------------------

export type JobRow = {
  job_id: string;
  agency_id: string;
  project_id: string;
  authorization_id: string;
  capture_id: string;
  plan_id: string;
  plan_hash: string;
  approval_id: string;
  approval_hash: string;
  revision_hash: string;
  target_contract_hash: string;
  capability_id: string;
  capability_version: string;
  mode: string;
  validation_receipt_hash: string;
  core_package_hash: string;
  input_binding_hash: string;
  version: string;
  state: string;
  holds: string;
  attempt_count: number;
  fence: string;
  delivery_deadline_at: Date;
  execution_deadline_at: Date | null;
  queued_at: Date;
  cancel_requested_at: Date | null;
  cancel_version: string;
  cancel_actor_kind: string | null;
  cancel_actor_id: string | null;
  cancel_reason_code: string | null;
  published_package_id: string | null;
  created_by_membership_id: string;
};

export async function jobRow(pw: PaymentsWorld, jobId: string): Promise<JobRow> {
  const row = await pw.w.row<JobRow>("processing_jobs", "job_id = $1", [jobId]);
  assert.ok(row !== null, `job ${jobId} exists`);
  return row;
}

/** Every job of an authorization (at most one, D8-JOB-1). */
export async function jobsOfAuthorization(pw: PaymentsWorld, authorizationId: string): Promise<ReadonlyArray<string>> {
  const r = await pw.w.h.oracle.query<{ job_id: string }>("SELECT job_id FROM kauro.processing_jobs WHERE authorization_id = $1 ORDER BY created_at", [authorizationId]);
  return r.rows.map((x) => x.job_id);
}

export type AuthorizationRow = { authorization_id: string; state: string; version: string; job_ref: string | null };

export async function authorizationRow(pw: PaymentsWorld, authorizationId: string): Promise<AuthorizationRow> {
  const row = await pw.w.row<AuthorizationRow>("commercial_authorizations", "authorization_id = $1", [authorizationId]);
  assert.ok(row !== null, `authorization ${authorizationId} exists`);
  return row;
}

/** The agency's live-job count of its ledger row (D8-CAP-2), 0 when it has none yet. */
export async function agencyLiveJobs(pw: PaymentsWorld, agencyId: string = pw.w.A.agencyId): Promise<number> {
  const r = await pw.w.h.oracle.query<{ live_jobs: number }>("SELECT live_jobs FROM kauro.agency_execution_capacity WHERE agency_id = $1", [agencyId]);
  return r.rows[0]?.live_jobs ?? 0;
}

/**
 * The "nothing written" oracle of a refusal: the commerce and effect tables' row counts (domain events, outbox records, journal
 * entries, provider calls) and the execution tables' — the security event of a denial is its own record, written after the rollback
 * (D-FACT-1), so it is left out.
 */
export async function footprint(pw: PaymentsWorld): Promise<Readonly<Record<string, number | string>>> {
  const effects = await pw.effects();
  const r = await pw.w.h.oracle.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM kauro.processing_jobs)::text AS jobs,
            (SELECT coalesce(sum(live_jobs), 0) FROM kauro.agency_execution_capacity)::text AS live_jobs,
            (SELECT count(*) FROM kauro.processing_attempts)::text AS attempts,
            (SELECT count(*) FROM kauro.package_versions)::text AS packages`,
  );
  return { ...effects, security_events: 0, ...(r.rows[0] ?? {}) };
}

/** The events of a job, in version order, and the consumers of each one's outbox records. */
export async function jobEvents(pw: PaymentsWorld, jobId: string): Promise<ReadonlyArray<{ readonly version: number; readonly type: string; readonly payload: Record<string, unknown>; readonly consumers: ReadonlyArray<string> }>> {
  const events = await pw.w.events("processing_job", jobId);
  const out = [];
  for (const e of events) out.push({ version: e.version, type: e.type, payload: e.payload, consumers: [...(await pw.w.outbox(e.eventId))].sort() });
  return out;
}

// --- the jobs the tests need ------------------------------------------------------------------------------------------------------------

/** A paid purchase and its job queued through the real CMD036 route. */
export async function queuedThroughRoute(pw: PaymentsWorld, label: string, options: CallOptions = {}): Promise<{ readonly sale: Sale; readonly jobId: string }> {
  const sale = await pw.paidProject(label);
  const reply = await execute(pw, sale, options);
  return { sale, jobId: jobIdOf(reply) };
}

/** The job admitted (the platform's ledger, attempt 1 CLAIMED) and launched (STARTING, LAUNCHED, RUNNING) by the control plane. */
export async function runningJob(pw: PaymentsWorld, label: string): Promise<{ readonly sale: Sale; readonly jobId: string }> {
  const queued = await queuedThroughRoute(pw, label);
  await admitJob(pw.w.h, pw.w.A, queued.jobId);
  await launchJob(pw.w.h, pw.w.A, queued.jobId);
  return queued;
}

/** The job staged, verified and its delivery copies made: VERIFYING with a VERIFIED_PRIVATE package, ready for the publication. */
export async function verifyingJob(pw: PaymentsWorld, label: string): Promise<{ readonly sale: Sale; readonly jobId: string; readonly packageId: string }> {
  const running = await runningJob(pw, label);
  await stageJob(pw.w.h, pw.w.A, running.jobId);
  const pkg = await verifyJob(pw.w.h, pw.w.A, running.jobId);
  return { ...running, packageId: pkg.packageVersionId };
}

/** Ends every live job of agency A as the control plane does, so the platform's slots and the agency's bound are free again. */
export async function endLiveJobs(pw: PaymentsWorld): Promise<void> {
  const r = await pw.w.h.oracle.query<{ job_id: string }>("SELECT job_id FROM kauro.processing_jobs WHERE agency_id = $1 AND holds <> 'NONE' ORDER BY created_at", [pw.w.A.agencyId]);
  for (const row of r.rows) await endJob(pw.w.h, pw.w.A, row.job_id);
}

/** The payment service's revocation of a purchase's authorization (B09's own write; PRE_EXECUTION, the authorization still ACTIVE). */
export function revoke(pw: PaymentsWorld, sale: Pick<Sale, "orderId" | "authorizationId">, expectedVersion = 1): Promise<unknown> {
  return pw.w.h.commerce.run(pw.w.h.service(), async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", sale.orderId);
    const now = toUtcInstant(Date.now());
    return uow.commerce.authorizations.transition(sale.authorizationId, expectedVersion, { state: "REVOKED", revocation: { at: now, phase: "PRE_EXECUTION", code: "OPERATOR_REVOKED" } }, now);
  });
}

/** The same revocation, held open after its write until `release` (the authorization's exclusive transition lock is held to COMMIT). */
export function heldRevocation(pw: PaymentsWorld, sale: Pick<Sale, "orderId" | "authorizationId">): { readonly written: Promise<void>; release(): void; readonly done: Promise<unknown> } {
  const inFlight = barrier();
  const hold = barrier();
  const done = pw.w.h.commerce.run(pw.w.h.service(), async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", sale.orderId);
    const now = toUtcInstant(Date.now());
    const revoked = await uow.commerce.authorizations.transition(sale.authorizationId, 1, { state: "REVOKED", revocation: { at: now, phase: "PRE_EXECUTION", code: "OPERATOR_REVOKED" } }, now);
    inFlight.open();
    await hold.wait;
    return revoked;
  });
  return { written: inFlight.wait, release: () => hold.open(), done };
}

/**
 * The publication of D8-PUB-2 as JOB_EXECUTION takes it (persistence-fixtures `publishJob`), held open after its writes until `release`:
 * the job row lock and the authorization's exclusive half are held to COMMIT. `written` resolves when the publication wrote (or was
 * refused); `outcome` is the unit's result.
 */
export function heldPublication(pw: PaymentsWorld, jobId: string): { readonly written: Promise<void>; release(): void; readonly outcome: Promise<PublicationOutcome> } {
  const inFlight = barrier();
  const hold = barrier();
  const outcome = pw.w.h.execution.run(controlOf(pw.w.A.agencyId), async (uow) => {
    const job = await uow.execution.getJob(jobId as ProcessingJobId);
    if (job === null || job.currentAttemptId === undefined) throw new Error(`job ${jobId} has no attempt`);
    const pkg = await uow.execution.packageOfAttempt(job.currentAttemptId);
    if (pkg === null) throw new Error(`job ${jobId} has no package version`);
    const copies = await uow.execution.deliveryArtifactsOf(pkg.packageVersionId);
    const deliveryManifestHash = deliveryManifestHashOf({
      packageId: pkg.packageVersionId,
      revisionHash: job.revisionHash,
      planHash: job.planHash,
      targetContractHash: job.targetContractHash,
      corePackageHash: job.corePackageHash,
      validationReceiptHash: job.validationReceiptHash,
      artifacts: copies.map((c) => ({ role: c.role, objectName: c.objectName, generation: c.generation, sha256: c.sha256, byteLength: c.byteLength })),
      // the store records the manifest's digest and never reads its contents: a fixed, labelled RowCounts stands in for the one
      // the control plane issues (ROWCOUNTS-PRODUCER, apps/control pipeline.ts issuedDeliveryManifestOf)
      counts: FIXTURE_ISSUED_COUNTS,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      manifestVersion: "1",
    });
    const result = await uow.execution.publish({ jobId: job.jobId, packageVersionId: pkg.packageVersionId, deliveryManifestHash, anchorId: uow.ids.next() });
    inFlight.open();
    await hold.wait;
    return result;
  });
  // a unit that failed before it wrote never opens the barrier: the test then fails on `outcome` instead of hanging on `written`
  const written = Promise.race([inFlight.wait, outcome.then(() => undefined)]);
  return { written, release: () => hold.open(), outcome };
}

/** What a JobView must never carry, whatever the state of the job: the provider's identity, the object names, the fence, the lease. */
export async function forbiddenTokensOf(pw: PaymentsWorld, jobId: string): Promise<ReadonlyArray<string>> {
  const job = await jobRow(pw, jobId);
  const attempts = await pw.w.h.oracle.query<{ attempt_id: string; identity: string; staging_prefix: string; manifest_object_name: string | null; provider_job_id: string | null }>(
    "SELECT attempt_id, identity, staging_prefix, manifest_object_name, provider_job_id FROM kauro.processing_attempts WHERE job_id = $1",
    [jobId],
  );
  const packages = await pw.w.h.oracle.query<{ delivery_prefix: string }>("SELECT delivery_prefix FROM kauro.package_versions WHERE job_id = $1", [jobId]);
  const tokens = [job.input_binding_hash, job.core_package_hash, job.validation_receipt_hash, "providerJobId", "provider_job_id", "inputBindingHash", "objectName", "manifestObjectName", "stagingPrefix", "\"fence\"", "\"lease\""];
  for (const a of attempts.rows) tokens.push(a.attempt_id, a.identity, a.staging_prefix, ...(a.manifest_object_name !== null ? [a.manifest_object_name] : []), ...(a.provider_job_id !== null ? [a.provider_job_id] : []));
  for (const p of packages.rows) tokens.push(p.delivery_prefix);
  return tokens;
}

// --- the prerequisites of an execution, each broken on its own ---------------------------------------------------------------------------

/** The source revision a purchase rests on (its plan's revision hash within the project). */
export async function revisionIdOf(pw: PaymentsWorld, sale: Pick<Sale, "projectId" | "plan">): Promise<string> {
  const r = await pw.w.h.oracle.query<{ revision_id: string }>("SELECT revision_id FROM kauro.dataset_revisions WHERE project_id = $1 AND manifest_hash = $2", [sale.projectId, sale.plan.revisionHash]);
  const row = r.rows[0];
  assert.ok(row !== undefined, "the purchase's revision exists");
  return row.revision_id;
}

/** CMD026 as the approving actor: the approval of the purchase's plan withdrawn (the plan WITHDRAWN). */
export async function withdrawApproval(pw: PaymentsWorld, sale: Pick<Sale, "plan">): Promise<Reply> {
  const plan = await pw.w.row<{ version: string }>("plans", "plan_id = $1", [sale.plan.planId]);
  assert.ok(plan !== null, "the plan exists");
  return call(pw.w, { url: routes.withdrawApproval(sale.plan.planId), token: pw.w.approver.token, key: freshKey("cmd026"), body: { expectedVersion: Number(plan.version), reasonCode: "SCOPE_CHANGED" } });
}

/** The target contract of the purchase superseded, as a newer confirmation of the project's contract would (B08 observation and confirmation). */
export async function supersedeTarget(pw: PaymentsWorld, sale: Pick<Sale, "projectId">): Promise<void> {
  await supersedeProject(pw.w.h.oracle, pw.w.A.agencyId, sale.projectId, pw.w.A.ownerMembershipId);
}

/** Agency A moved to a state by its owner acting as itself (the agency machine's edges; the transition lock is taken by the database). */
async function moveAgency(pw: PaymentsWorld, to: "RESTRICTED" | "ACTIVE"): Promise<void> {
  const writer = await tenantWriter(pw.w, pw.w.A);
  try {
    const moved = await writer.query<{ version: string }>("UPDATE kauro.agencies SET state = $2, version = version + 1 WHERE agency_id = $1 RETURNING version::text AS version", [pw.w.A.agencyId, to]);
    const version = Number(moved.rows[0]?.version);
    await rawEvent(writer.client, {
      aggregateKind: "agency",
      aggregateId: pw.w.A.agencyId,
      aggregateVersion: version,
      agencyId: pw.w.A.agencyId,
      eventType: to === "RESTRICTED" ? "agency.restricted.v1" : "agency.restriction_remedied.v1",
      actorUserId: pw.w.A.ownerUserId,
      payload: { agencyId: pw.w.A.agencyId, incidentId: ids.next() },
    });
    await writer.commit();
  } finally {
    await writer.close();
  }
}

export const restrictAgency = (pw: PaymentsWorld): Promise<void> => moveAgency(pw, "RESTRICTED");
export const remedyAgency = (pw: PaymentsWorld): Promise<void> => moveAgency(pw, "ACTIVE");

/** The capability of the CLEAN mode suspended by the control plane (the offered mode is gone for every agency: the world's last step). */
export async function suspendCapability(pw: PaymentsWorld): Promise<void> {
  const writer = await controlWriter(pw.w);
  try {
    await writer.query("UPDATE kauro.capabilities SET state = 'SUSPENDED' WHERE capability_id = $1", [pw.w.cleanCapabilityId]);
    await writer.commit();
  } finally {
    await writer.close();
  }
}

/** The outbox record of an event for one consumer. */
export async function outboxRecord(pw: PaymentsWorld, eventId: string, consumer: string): Promise<{ readonly state: string; readonly attempts: number; readonly delivered_at: Date | null; readonly next_attempt_at: Date } | null> {
  const r = await pw.w.h.oracle.query<{ state: string; attempts: number; delivered_at: Date | null; next_attempt_at: Date }>("SELECT state, attempts, delivered_at, next_attempt_at FROM kauro.outbox_records WHERE event_id = $1 AND consumer = $2", [eventId, consumer]);
  return r.rows[0] ?? null;
}

/** A labelled fixture RowCounts for publications a fixture makes as JOB_EXECUTION (the store never reads the manifest's contents). */
const FIXTURE_ISSUED_COUNTS = Object.freeze({ physicalSourceRows: 10, logicalSourceRecords: 10, billableSourceUnits: 10, associationEdges: 0, emittedRepresentatives: 10, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: 10 });
