/**
 * The execution store over `pg` (package B08, mandate B08-PERSISTENCE-EXECUTION; @kauro/domain ports/execution-store.ts;
 * docs/design/B08-audit-approval-jobs.md §4..§7, §9; migrations 0021 and 0022).
 *
 * Each method is one edge or one evidence row, written in the caller's unit of work with the event of every aggregate version it
 * makes (processing_job.*, package_version.*, B09's commercial_authorization.consumed/delivered, B07's retention_record.*), through
 * the unit of work's publisher and provenance. The database decides: its guards stamp every instant with kauro.server_now()
 * (D8-CLOCK-1), refuse a stale fence (KA080), a lost authority or a cancelled job (KA081), a ledger edited around its jobs (KA082)
 * and a publication without its evidence (KA084); a refusal reaches the caller as the typed failure of sqlstate.ts. Lease calls pass
 * the server instant in SQL. No method takes an instant from its caller.
 */
import type { Sha256Hex } from "@kauro/contracts";
import {
  DomainFailure,
  EXECUTION_POLICY,
  NotFoundFailure,
  jobAttemptCheckpointOf,
  jobAttemptIdentityOf,
  jobAttemptStagingPrefixOf,
  packageDeliveryPrefixOf,
  retentionAnchorHashOf,
  type AdmissionCandidate,
  type AdmissionRecord,
  type AgencyId,
  type AggregateKind,
  type ArtifactReadbackRecord,
  type AttemptCleanupRecord,
  type CleanupInput,
  type CommercialAuthorizationId,
  type DeliveryArtifactRecord,
  type DeliveryCopyInput,
  type EventPayload,
  type EventProvenance,
  type EventPublisher,
  type EventType,
  type ExecutionAuthorityFacts,
  type ExecutionCapacitySnapshot,
  type ExecutionStore,
  type IdGenerator,
  type JobCancellation,
  type JobExecutionSubject,
  type LaunchIntent,
  type LaunchState,
  type LeaseRecord,
  type ManifestSubmission,
  type NewProcessingJob,
  type PackageVerificationId,
  type PackageVerificationRecord,
  type PackageVersionId,
  type PackageVersionRecord,
  type ProcessingAttemptId,
  type ProcessingAttemptRecord,
  type ProcessingJobId,
  type ProcessingJobRecord,
  type PublicationInput,
  type PublicationOutcome,
  type ReadbackInput,
  type StagedArtifactRecord,
  type StagedManifestRecord,
  type StagingRecord,
  type TakeoverOutcome,
  type TransitionSubject,
  type VerificationInput,
  type VersionedWrite,
} from "@kauro/domain";
import { PgLeaseStore } from "../lease-store.js";
import { execute, int, type Queryable } from "../sql.js";
import { exact, missedWrite, notAvailable, one, opt, optionalInstantText, optionalString, pageLimit, serverInstantOf, str } from "../source/rows.js";
import {
  ARTIFACT_COLUMNS,
  ATTEMPT_COLUMNS,
  CLEANUP_COLUMNS,
  DELIVERY_COLUMNS,
  JOB_COLUMNS,
  MANIFEST_COLUMNS,
  PACKAGE_COLUMNS,
  READBACK_COLUMNS,
  VERIFICATION_COLUMNS,
  artifactRecord,
  attemptRecord,
  cleanupRecord,
  deliveryRecord,
  jobColumnsOf,
  packageColumnsOf,
  jobRecord,
  manifestRecord,
  packageRecord,
  readbackRecord,
  verificationRecord,
  type Row,
} from "./rows.js";

/** What the execution store writes through: the unit of work's connection, id generator, publisher and provenance. */
export interface ExecutionWriteContext {
  readonly db: Queryable;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
  readonly provenance: () => EventProvenance;
}

/** The transition-lock subjects of B06 D-TX-2 the execution facts are keyed by (0003, 0013, 0015, 0021). */
const TRANSITION_KINDS: Readonly<Record<TransitionSubject["kind"], string>> = Object.freeze({
  PROJECT: "kauro.projects",
  AUTHORIZATION: "kauro.commercial_authorizations",
  APPROVAL: "kauro.approvals",
  REVISION: "kauro.dataset_revisions",
  TARGET_CONTRACT: "kauro.target_contracts",
  CAPABILITY: "kauro.capabilities",
  AGENCY: "kauro.agencies",
});

/** The INCLUDED files of the sealed revision $1 (B08-R1: the revision's source authority is also their admission). */
const INCLUDED_FILES = "kauro.sealed_revision_files s WHERE s.revision_id = $1::uuid AND s.disposition = 'INCLUDED'";

/** The retention policy label of the records execution writes (the registry's pricing and retention schedule of this edition). */
const RETENTION_POLICY_VERSION = "R2-INITIAL";

const LEASE_COLUMNS = "resource_kind, resource_id, owner_id, fence, expires_at, heartbeat_at, cancel_version, deadline_at, subject_hash, cost_authority_id, checkpoint_hash";

function readbackResult(input: ReadbackInput): "EQUAL" | "MISMATCH" | "MISSING" {
  const o = input.observed;
  if (o === null || (o.generation === null && o.sha256 === null && o.byteLength === null)) return "MISSING";
  return o.generation === input.expected.generation && o.sha256 === input.expected.sha256 && o.byteLength === input.expected.byteLength ? "EQUAL" : "MISMATCH";
}

export class PgExecutionStore implements ExecutionStore {
  readonly #leases: PgLeaseStore;

  constructor(private readonly ctx: ExecutionWriteContext) {
    this.#leases = new PgLeaseStore(ctx.db);
  }

  private get db(): Queryable {
    return this.ctx.db;
  }

  /** Publishes the event of one aggregate version with the unit of work's provenance (its outbox rows from the subscriptions). */
  private async emit(aggregateKind: AggregateKind, aggregateId: string, agencyId: AgencyId, aggregateVersion: number, eventType: EventType, payload: EventPayload): Promise<void> {
    const p = this.ctx.provenance();
    await this.ctx.events.publish({ aggregateKind, aggregateId, aggregateVersion, agencyId, eventType, actor: p.actor, causationId: p.causationId, correlationId: p.correlationId, payload });
  }

  /** The service identity of the unit of work, the creator of the objects it registers (B07's stored_objects_creator_shape). */
  private serviceRef(): string {
    const actor = this.ctx.provenance().actor;
    if (actor.kind !== "SERVICE") throw new DomainFailure("INTEGRITY_FAILURE", "execution evidence is registered by the control plane's service identity only");
    return actor.serviceId;
  }

  // --- reads ------------------------------------------------------------------------------------------------------------------------

  async getJob(jobId: ProcessingJobId): Promise<ProcessingJobRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${JOB_COLUMNS} FROM kauro.processing_jobs WHERE job_id = $1`, [jobId]);
    return r.rows[0] ? jobRecord(r.rows[0]) : null;
  }

  async lockJob(jobId: ProcessingJobId, mode: "WAIT" | "SKIP_LOCKED" = "WAIT"): Promise<ProcessingJobRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${JOB_COLUMNS} FROM kauro.processing_jobs WHERE job_id = $1 FOR UPDATE${mode === "SKIP_LOCKED" ? " SKIP LOCKED" : ""}`, [jobId]);
    return r.rows[0] ? jobRecord(r.rows[0]) : null;
  }

  async findJobByAuthorization(authorizationId: CommercialAuthorizationId): Promise<ProcessingJobRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${JOB_COLUMNS} FROM kauro.processing_jobs WHERE authorization_id = $1`, [authorizationId]);
    return r.rows[0] ? jobRecord(r.rows[0]) : null;
  }

  async getAttempt(attemptId: ProcessingAttemptId): Promise<ProcessingAttemptRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.processing_attempts WHERE attempt_id = $1`, [attemptId]);
    return r.rows[0] ? attemptRecord(r.rows[0]) : null;
  }

  async attemptsOf(jobId: ProcessingJobId): Promise<ReadonlyArray<ProcessingAttemptRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.processing_attempts WHERE job_id = $1 ORDER BY ordinal`, [jobId]);
    return r.rows.map(attemptRecord);
  }

  async getPackage(packageVersionId: PackageVersionId): Promise<PackageVersionRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${PACKAGE_COLUMNS} FROM kauro.package_versions WHERE package_version_id = $1`, [packageVersionId]);
    return r.rows[0] ? packageRecord(r.rows[0]) : null;
  }

  async packageOfAttempt(attemptId: ProcessingAttemptId): Promise<PackageVersionRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${PACKAGE_COLUMNS} FROM kauro.package_versions WHERE attempt_id = $1`, [attemptId]);
    return r.rows[0] ? packageRecord(r.rows[0]) : null;
  }

  async stagedManifestOf(attemptId: ProcessingAttemptId): Promise<StagedManifestRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${MANIFEST_COLUMNS} FROM kauro.staged_manifests WHERE attempt_id = $1`, [attemptId]);
    return r.rows[0] ? manifestRecord(r.rows[0]) : null;
  }

  async stagedArtifactsOf(attemptId: ProcessingAttemptId): Promise<ReadonlyArray<StagedArtifactRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${ARTIFACT_COLUMNS} FROM kauro.staged_artifacts WHERE attempt_id = $1 ORDER BY object_name`, [attemptId]);
    return r.rows.map(artifactRecord);
  }

  async readbacksOf(attemptId: ProcessingAttemptId): Promise<ReadonlyArray<ArtifactReadbackRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${READBACK_COLUMNS} FROM kauro.artifact_readbacks WHERE attempt_id = $1 ORDER BY read_at, readback_id`, [attemptId]);
    return r.rows.map(readbackRecord);
  }

  async deliveryArtifactsOf(packageVersionId: PackageVersionId): Promise<ReadonlyArray<DeliveryArtifactRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${DELIVERY_COLUMNS} FROM kauro.delivery_artifacts WHERE package_version_id = $1 ORDER BY object_name`, [packageVersionId]);
    return r.rows.map(deliveryRecord);
  }

  async verificationsOf(attemptId: ProcessingAttemptId): Promise<ReadonlyArray<PackageVerificationRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${VERIFICATION_COLUMNS} FROM kauro.package_verifications WHERE attempt_id = $1 ORDER BY verified_at, verification_id`, [attemptId]);
    return r.rows.map(verificationRecord);
  }

  async cleanupOf(attemptId: ProcessingAttemptId): Promise<AttemptCleanupRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${CLEANUP_COLUMNS} FROM kauro.attempt_cleanups WHERE attempt_id = $1 ORDER BY pass DESC LIMIT 1`, [attemptId]);
    return r.rows[0] ? cleanupRecord(r.rows[0]) : null;
  }

  jobLease(jobId: ProcessingJobId): Promise<LeaseRecord | null> {
    return this.#leases.get("JOB_ATTEMPT", jobId as string as LeaseRecord["resourceId"]);
  }

  /**
   * The ledgers as any runtime group reads them: the request handlers hold SELECT on active_jobs and waiting_jobs of the platform ledger
   * only (0021), so the one-row ledger (ledger_id is CHECKed to 1) is read without naming its key column (D8-CMD-3).
   */
  async capacity(agencyId: AgencyId): Promise<ExecutionCapacitySnapshot> {
    const r = await execute<{ active: number; waiting: number; live: number }>(
      this.db,
      `SELECT (SELECT c.active_jobs FROM kauro.execution_capacity c) AS active,
              (SELECT c.waiting_jobs FROM kauro.execution_capacity c) AS waiting,
              coalesce((SELECT l.live_jobs FROM kauro.agency_execution_capacity l WHERE l.agency_id = $1), 0) AS live`,
      [agencyId],
    );
    const row = one(r.rows, "execution capacity");
    return { activeJobs: int(row.active ?? 0), waitingJobs: int(row.waiting ?? 0), agencyLiveJobs: int(row.live) };
  }

  async admissionCandidates(limit: number): Promise<ReadonlyArray<AdmissionCandidate>> {
    // D8-SCHED-1 mirrored in SQL (fairAdmissionOrder): held slots, the agency's last admission (never first), queue instant, id
    const r = await execute<Row>(
      this.db,
      `SELECT j.job_id, j.agency_id, ${exact("j.queued_at", "queued_at")},
              (SELECT count(*) FROM kauro.processing_jobs h WHERE h.agency_id = j.agency_id AND h.holds IN ('WAITING', 'ACTIVE'))::int AS held,
              ${exact("l.last_admitted_at", "last_admitted_at")}
         FROM kauro.processing_jobs j LEFT JOIN kauro.agency_execution_capacity l ON l.agency_id = j.agency_id
        WHERE j.state = 'QUEUED' AND j.cancel_version = 0
        ORDER BY held, l.last_admitted_at NULLS FIRST, j.queued_at, j.job_id
        LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({
      jobId: str<ProcessingJobId>(x["job_id"]),
      agencyId: str<AgencyId>(x["agency_id"]),
      queuedAt: str(x["queued_at"]),
      agencyHeldSlots: int(x["held"]),
      agencyLastAdmittedAt: optionalInstantText(x["last_admitted_at"]) ?? null,
    }));
  }

  // --- locks (D8-LOCK-1) -------------------------------------------------------------------------------------------------------------

  async awaitTransition(subject: TransitionSubject): Promise<void> {
    await execute(this.db, "SELECT kauro.await_transition($1, $2)", [TRANSITION_KINDS[subject.kind], subject.key]);
    // a revision's source is also its INCLUDED sealed files' admission (B08-R1): their shared transition halves, in file order, so
    // an admission revocation in flight (OBJECT_INVENTORY, RETENTION) commits before the authority is read, or waits for this one
    if (subject.kind === "REVISION") await execute(this.db, `SELECT kauro.await_transition('kauro.source_files', s.file_id::text) FROM ${INCLUDED_FILES} ORDER BY s.file_id`, [subject.key]);
  }

  async tryAwaitTransition(subject: TransitionSubject): Promise<boolean> {
    const r = await execute<{ ok: boolean }>(this.db, "SELECT kauro.try_await_transition($1, $2) AS ok", [TRANSITION_KINDS[subject.kind], subject.key]);
    if (r.rows[0]?.ok !== true) return false;
    if (subject.kind !== "REVISION") return true;
    const files = await execute<{ ok: boolean | null }>(
      this.db,
      `SELECT bool_and(t.ok) AS ok FROM (SELECT kauro.try_await_transition('kauro.source_files', s.file_id::text) AS ok FROM ${INCLUDED_FILES} ORDER BY s.file_id) t`,
      [subject.key],
    );
    return files.rows[0]?.ok !== false;
  }

  async tryTransitionExclusive(subject: TransitionSubject): Promise<boolean> {
    const r = await execute<{ ok: boolean }>(this.db, "SELECT pg_try_advisory_xact_lock(kauro.transition_key($1, $2)) AS ok", [TRANSITION_KINDS[subject.kind], subject.key]);
    return r.rows[0]?.ok === true;
  }

  async tryLockAuthorization(authorizationId: CommercialAuthorizationId): Promise<boolean> {
    const r = await execute<{ authorization_id: string }>(this.db, "SELECT authorization_id FROM kauro.commercial_authorizations WHERE authorization_id = $1 FOR NO KEY UPDATE SKIP LOCKED", [authorizationId]);
    return r.rows.length === 1;
  }

  /**
   * The authorization row before its exclusive half (the DELIVERED edge of a publication). FOR NO KEY UPDATE (rule 11a): a job inserted
   * for the authorization takes its shared half and then a KEY SHARE through processing_jobs_authorization_subject_fk, which a FOR UPDATE
   * here would make wait for a writer that itself waits for that shared half (40P01).
   */
  async lockAuthorizationRow(authorizationId: CommercialAuthorizationId): Promise<void> {
    await execute(this.db, "SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1 FOR NO KEY UPDATE", [authorizationId]);
  }

  async lockGlobalLedger(): Promise<void> {
    // Retain the row-lock label used by existing lock-wait diagnostics.
    await execute(this.db, "SELECT kauro.lock_execution_ledger() /* FROM kauro.execution_capacity WHERE ledger_id = 1 FOR UPDATE */");
  }

  async readAuthority(job: JobExecutionSubject): Promise<ExecutionAuthorityFacts> {
    const r = await execute<Row>(
      this.db,
      `SELECT (SELECT g.state FROM kauro.agencies g WHERE g.agency_id = $1) AS agency_state,
              (SELECT p.state FROM kauro.projects p WHERE p.agency_id = $1 AND p.project_id = $2) AS project_state,
              (SELECT p.client_id FROM kauro.projects p WHERE p.agency_id = $1 AND p.project_id = $2) AS project_client_id,
              (SELECT a.state FROM kauro.commercial_authorizations a WHERE a.agency_id = $1 AND a.authorization_id = $3) AS authorization_state,
              (SELECT a.job_ref FROM kauro.commercial_authorizations a WHERE a.agency_id = $1 AND a.authorization_id = $3) AS authorization_job_ref,
              EXISTS (SELECT 1 FROM kauro.approvals x WHERE x.agency_id = $1 AND x.approval_id = $4 AND x.withdrawn_at IS NULL) AS approval_live,
              (SELECT pl.state FROM kauro.plans pl WHERE pl.agency_id = $1 AND pl.plan_id = $5) AS plan_state,
              (SELECT r.revision_id FROM kauro.dataset_revisions r WHERE r.agency_id = $1 AND r.project_id = $2 AND r.manifest_hash = $6) AS revision_id,
              (SELECT r.state FROM kauro.dataset_revisions r WHERE r.agency_id = $1 AND r.project_id = $2 AND r.manifest_hash = $6) AS revision_state,
              (SELECT t.contract_id FROM kauro.target_contracts t WHERE t.agency_id = $1 AND t.project_id = $2 AND t.body_hash = $7) AS target_contract_id,
              EXISTS (SELECT 1 FROM kauro.target_contracts t WHERE t.agency_id = $1 AND t.project_id = $2 AND t.body_hash = $7 AND t.confirmed_at IS NOT NULL AND t.superseded_at IS NULL) AS target_current,
              NOT EXISTS (SELECT 1 FROM kauro.dataset_revisions r
                            JOIN kauro.sealed_revision_files s ON s.agency_id = r.agency_id AND s.revision_id = r.revision_id AND s.disposition = 'INCLUDED'
                            JOIN kauro.source_files f ON f.agency_id = s.agency_id AND f.file_id = s.file_id
                           WHERE r.agency_id = $1 AND r.project_id = $2 AND r.manifest_hash = $6 AND f.state <> 'ADMITTED') AS source_files_admitted,
              EXISTS (SELECT 1 FROM kauro.capabilities k WHERE k.capability_id = $8 AND k.state IN ('AVAILABLE_LIMITED', 'AVAILABLE')) AS capability_offered,
              (SELECT ${exact("c.provider_completed_at", "at")} FROM kauro.capture_facts c WHERE c.agency_id = $1 AND c.capture_id = $9) AS capture_completed_at,
              (SELECT to_char(max(rr.effective_deadline) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 FROM kauro.retention_records rr JOIN kauro.dataset_revisions r ON r.agency_id = rr.agency_id AND r.revision_id = rr.revision_id
                WHERE rr.agency_id = $1 AND r.project_id = $2 AND r.manifest_hash = $6 AND rr.state = 'ACTIVE') AS retention_effective_deadline,
              (SELECT rr.retention_id FROM kauro.retention_records rr JOIN kauro.dataset_revisions r ON r.agency_id = rr.agency_id AND r.revision_id = rr.revision_id
                WHERE rr.agency_id = $1 AND r.project_id = $2 AND r.manifest_hash = $6 AND rr.class = 'PAID_ORDINARY') AS paid_ordinary_retention_id`,
      [job.agencyId, job.projectId, job.authorizationId, job.approvalId, job.planId, job.revisionHash, job.targetContractHash, job.capabilityId, job.captureId],
    );
    const x = one(r.rows, "execution authority");
    return {
      agencyState: optionalString(x["agency_state"]) ?? null,
      projectState: optionalString(x["project_state"]) ?? null,
      projectClientId: optionalString(x["project_client_id"]) ?? null,
      authorizationState: optionalString(x["authorization_state"]) ?? null,
      authorizationJobRef: optionalString(x["authorization_job_ref"]) ?? null,
      approvalLive: x["approval_live"] === true,
      planState: optionalString(x["plan_state"]) ?? null,
      revisionId: optionalString(x["revision_id"]) ?? null,
      revisionState: optionalString(x["revision_state"]) ?? null,
      targetContractId: optionalString(x["target_contract_id"]) ?? null,
      targetCurrent: x["target_current"] === true,
      sourceFilesAdmitted: x["source_files_admitted"] === true,
      capabilityOffered: x["capability_offered"] === true,
      captureCompletedAt: optionalString(x["capture_completed_at"]) ?? null,
      retentionEffectiveDeadline: optionalString(x["retention_effective_deadline"]) ?? null,
      paidOrdinaryRetentionId: optionalString(x["paid_ordinary_retention_id"]) ?? null,
    };
  }

  // --- request handlers (CMD036, CMD037) -------------------------------------------------------------------------------------------

  async queueJob(job: NewProcessingJob): Promise<ProcessingJobRecord> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.processing_jobs (job_id, agency_id, project_id, authorization_id, capture_id, plan_id, plan_hash, approval_id, approval_hash, revision_hash,
          target_contract_hash, capability_id, capability_version, mode, validation_receipt_hash, core_package_hash, input_binding_hash, created_by_membership_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING ${JOB_COLUMNS}`,
      [
        job.jobId,
        job.agencyId,
        job.projectId,
        job.authorizationId,
        job.captureId,
        job.planId,
        job.planHash,
        job.approvalId,
        job.approvalHash,
        job.revisionHash,
        job.targetContractHash,
        job.capabilityId,
        job.capabilityVersion,
        job.mode,
        job.validationReceiptHash,
        job.corePackageHash,
        job.inputBindingHash,
        job.createdByMembershipId,
      ],
    );
    const record = jobRecord(one(r.rows, "queued job"));
    await this.emit("processing_job", record.jobId, record.agencyId, record.version, "processing_job.queued.v1", {
      jobId: record.jobId,
      agencyId: record.agencyId,
      projectId: record.projectId,
      authorizationId: record.authorizationId,
      inputBindingHash: record.inputBindingHash,
      state: record.state,
    });
    return record;
  }

  async requestCancellation(jobId: ProcessingJobId, expectedVersion: number, cancellation: JobCancellation): Promise<VersionedWrite<ProcessingJobRecord>> {
    const actorId = cancellation.actor.kind === "USER" ? cancellation.actor.userId : cancellation.actor.serviceId;
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.processing_jobs AS t
          SET version = t.version + 1, state = 'CANCEL_REQUESTED', cancel_version = t.cancel_version + 1,
              cancel_actor_kind = $3, cancel_actor_id = $4, cancel_reason_code = $5
         FROM kauro.processing_jobs AS o
        WHERE t.job_id = $1 AND t.version = $2 AND o.job_id = t.job_id AND t.state IN ('QUEUED', 'ADMITTED', 'RUNNING', 'VERIFYING')
       RETURNING ${jobColumnsOf("t")}, o.state AS previous_state`,
      [jobId, expectedVersion, cancellation.actor.kind, actorId, cancellation.reasonCode],
    );
    const row = r.rows[0];
    if (!row) return missedWrite(this.db, "processing_jobs", "job_id", jobId, expectedVersion, "job", ({ state }) => notAvailable("the job", state));
    const record = jobRecord(row);
    await this.emit("processing_job", record.jobId, record.agencyId, record.version, "processing_job.cancel_requested.v1", {
      jobId: record.jobId,
      agencyId: record.agencyId,
      cancelVersion: record.cancelVersion,
      previousState: str(row["previous_state"]),
      actorKind: cancellation.actor.kind,
      state: record.state,
    });
    return { kind: "APPLIED", record };
  }

  // --- the control plane ---------------------------------------------------------------------------------------------------------

  /** The job's source revision (the revision of its project whose manifest hash the job binds). */
  private async revisionOf(job: ProcessingJobRecord): Promise<string> {
    const r = await execute<{ revision_id: string }>(
      this.db,
      "SELECT revision_id FROM kauro.dataset_revisions WHERE agency_id = $1 AND project_id = $2 AND manifest_hash = $3",
      [job.agencyId, job.projectId, job.revisionHash],
    );
    return str(one(r.rows, "the job's source revision").revision_id);
  }

  /**
   * One retention anchor of `kind` for the job's revision (B07's once-per-revision index: a later execution keeps the first anchor),
   * at this transaction's server instant with its KAURO_RETENTION_ANCHOR_V1 digest over exactly that instant.
   */
  private async anchorOf(job: ProcessingJobRecord, revisionId: string, kind: "EXECUTION_ADMITTED" | "PACKAGE_AVAILABLE", anchorId: string): Promise<{ readonly anchorId: string; readonly evidenceHash: Sha256Hex; readonly created: boolean }> {
    const occurredAt = await serverInstantOf(this.db);
    const evidenceHash = retentionAnchorHashOf({ kind, agencyId: job.agencyId, projectId: job.projectId, revisionId, uploadId: null, occurredAt, sourceEvidenceHash: job.inputBindingHash });
    const r = await execute<{ anchor_id: string; evidence_hash: string }>(
      this.db,
      `INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5, kauro.server_now(), $6, kauro.server_now())
       ON CONFLICT (revision_id, anchor_kind) WHERE upload_id IS NULL DO NOTHING RETURNING anchor_id, evidence_hash`,
      [anchorId, job.agencyId, job.projectId, revisionId, kind, evidenceHash],
    );
    if (r.rows[0]) return { anchorId: r.rows[0].anchor_id, evidenceHash: r.rows[0].evidence_hash, created: true };
    const kept = await execute<{ anchor_id: string; evidence_hash: string }>(
      this.db,
      "SELECT anchor_id, evidence_hash FROM kauro.retention_anchors WHERE revision_id = $1 AND anchor_kind = $2 AND upload_id IS NULL",
      [revisionId, kind],
    );
    const row = one(kept.rows, "the revision's retention anchor");
    return { anchorId: row.anchor_id, evidenceHash: row.evidence_hash, created: false };
  }

  /**
   * The job's JOB_ATTEMPT lease claimed on the server clock with the job's checkpoint (B06-R1, D-LEASE-3; D8-LAND-2): the admission's
   * first claim stores it, and a takeover of the lapsed lease names it again, recomputed from the job's admitted input, which the
   * lease guard finds equal to the stored one — an expired lease is resumed only from its stored checkpoint, under fence + 1.
   */
  private async claimLease(job: ProcessingJobRecord, ownerId: ProcessingAttemptId): Promise<{ readonly kind: "CLAIMED" | "HELD"; readonly lease: LeaseRecord }> {
    await execute(this.db, "SAVEPOINT kauro_job_lease");
    try {
      const r = await execute<Row>(
        this.db,
        `SELECT ${LEASE_COLUMNS} FROM kauro.claim_lease('JOB_ATTEMPT', $1, $2, $3, $4::timestamptz, $5, $6, $7, kauro.server_now())`,
        [job.jobId, ownerId, EXECUTION_POLICY.leaseSeconds, job.deliveryDeadlineAt, job.inputBindingHash, job.authorizationId, jobAttemptCheckpointOf(job)],
      );
      await execute(this.db, "RELEASE SAVEPOINT kauro_job_lease");
      const lease = await this.jobLease(job.jobId);
      if (lease === null || r.rows.length === 0) throw new DomainFailure("INTEGRITY_FAILURE", "claim_lease returned no lease");
      return { kind: lease.ownerId === (ownerId as string) ? "CLAIMED" : "HELD", lease };
    } catch (e) {
      await execute(this.db, "ROLLBACK TO SAVEPOINT kauro_job_lease");
      throw e;
    }
  }

  private async insertAttempt(job: ProcessingJobRecord, attemptId: ProcessingAttemptId, ordinal: number, fence: number): Promise<ProcessingAttemptRecord> {
    await execute(
      this.db,
      `INSERT INTO kauro.processing_attempts (attempt_id, agency_id, project_id, job_id, ordinal, identity, staging_prefix) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [attemptId, job.agencyId, job.projectId, job.jobId, ordinal, jobAttemptIdentityOf(attemptId), jobAttemptStagingPrefixOf(job.agencyId, job.projectId, job.jobId, attemptId)],
    );
    const r = await execute<Row>(this.db, `UPDATE kauro.processing_attempts SET state = 'CLAIMED', fence = $2 WHERE attempt_id = $1 AND state = 'CREATED' RETURNING ${ATTEMPT_COLUMNS}`, [attemptId, fence]);
    return attemptRecord(one(r.rows, "claimed attempt"));
  }

  async admit(job: ProcessingJobRecord, attemptId: ProcessingAttemptId): Promise<AdmissionRecord> {
    // QUEUED -> ADMITTED at the job's version (the database takes the waiting slot and stamps the instant)
    const moved = await execute<Row>(
      this.db,
      `UPDATE kauro.processing_jobs SET version = version + 1, state = 'ADMITTED' WHERE job_id = $1 AND version = $2 AND state = 'QUEUED' RETURNING ${JOB_COLUMNS}`,
      [job.jobId, job.version],
    );
    const admitted = moved.rows[0];
    if (!admitted) throw new DomainFailure("PRECONDITION_FAILED", `job ${job.jobId} is no longer QUEUED at version ${job.version}`, { reason: "UNLISTED_TRANSITION" });
    const admittedJob = jobRecord(admitted);
    // the entitlement is consumed by this job in the same unit (D8-AUTH-1; bound at COMMIT, KA081)
    const consumed = await execute<{ version: string; agency_id: string }>(
      this.db,
      `UPDATE kauro.commercial_authorizations SET version = version + 1, state = 'CONSUMED', job_ref = $2, consumed_at = kauro.server_now()
        WHERE authorization_id = $1 AND state = 'ACTIVE' RETURNING version::text AS version, agency_id`,
      [job.authorizationId, job.jobId],
    );
    const auth = consumed.rows[0];
    if (!auth) throw new DomainFailure("PRECONDITION_FAILED", `authorization ${job.authorizationId} is not ACTIVE`, { reason: "EXECUTION_AUTHORITY_LOST" });
    // the anchor and the PAID_ORDINARY record of the revision (created by its first admission, kept by any later one; D8-XPKG-8)
    const revisionId = await this.revisionOf(job);
    const anchor = await this.anchorOf(job, revisionId, "EXECUTION_ADMITTED", this.ctx.ids.next());
    const existing = await execute<{ retention_id: string }>(
      this.db,
      "SELECT retention_id FROM kauro.retention_records WHERE agency_id = $1 AND revision_id = $2 AND class = 'PAID_ORDINARY'",
      [job.agencyId, revisionId],
    );
    let retentionId = existing.rows[0]?.retention_id;
    let retentionCreated = false;
    if (retentionId === undefined) {
      const created = await execute<{ retention_id: string; version: string; client_id: string }>(
        this.db,
        `INSERT INTO kauro.retention_records (retention_id, agency_id, client_id, project_id, revision_id, version, class, anchor_id, anchor_evidence_hash, soft_deadline, hard_deadline,
            effective_deadline, policy_version, created_at, updated_at)
         SELECT $1, $2, p.client_id, $3, $4, 1, 'PAID_ORDINARY', a.anchor_id, a.evidence_hash, NULL, c.provider_completed_at + interval '1209600 seconds',
                c.provider_completed_at + interval '1209600 seconds', $5, kauro.server_now(), kauro.server_now()
           FROM kauro.retention_anchors a, kauro.projects p, kauro.capture_facts c
          WHERE a.agency_id = $2 AND a.anchor_id = $6 AND p.agency_id = $2 AND p.project_id = $3 AND c.agency_id = $2 AND c.capture_id = $7
         RETURNING retention_id, version::text AS version, client_id`,
        [this.ctx.ids.next(), job.agencyId, job.projectId, revisionId, RETENTION_POLICY_VERSION, anchor.anchorId, job.captureId],
      );
      const record = one(created.rows, "PAID_ORDINARY retention record");
      retentionId = record.retention_id;
      retentionCreated = true;
      await this.emit("retention_record", record.retention_id, job.agencyId, int(record.version), "retention_record.created.v1", {
        retentionId: record.retention_id,
        agencyId: job.agencyId,
        projectId: job.projectId,
        revisionId,
        retentionClass: "PAID_ORDINARY",
        anchorEvidenceHash: anchor.evidenceHash,
        policyVersion: RETENTION_POLICY_VERSION,
      });
    }
    // the JOB_ATTEMPT lease at fence 1 (owner the attempt, subject the input binding, deadline the delivery deadline, cost the
    // authorization; D8-ATT-1) and attempt 1 CREATED -> CLAIMED under it
    const claim = await this.claimLease(admittedJob, attemptId);
    if (claim.kind !== "CLAIMED") throw new DomainFailure("PRECONDITION_FAILED", `the lease of job ${job.jobId} is held`, { reason: "EXECUTION_FENCED" });
    const attempt = await this.insertAttempt(admittedJob, attemptId, 1, claim.lease.fence);
    await this.emit("processing_job", admittedJob.jobId, admittedJob.agencyId, admittedJob.version, "processing_job.admitted.v1", {
      jobId: admittedJob.jobId,
      agencyId: admittedJob.agencyId,
      projectId: admittedJob.projectId,
      authorizationId: admittedJob.authorizationId,
      attemptId,
      fence: claim.lease.fence,
      state: admittedJob.state,
    });
    await this.emit("commercial_authorization", job.authorizationId, job.agencyId, int(auth.version), "commercial_authorization.consumed.v1", {
      authorizationId: job.authorizationId,
      agencyId: job.agencyId,
      jobRef: job.jobId,
      previousState: "ACTIVE",
    });
    const current = await this.getJob(job.jobId);
    if (current === null) throw new DomainFailure("INTEGRITY_FAILURE", "the admitted job is not visible");
    return { job: current, attempt, lease: claim.lease, anchorId: anchor.anchorId, retentionId, retentionCreated };
  }

  async takeOver(jobId: ProcessingJobId, attemptId: ProcessingAttemptId): Promise<TakeoverOutcome> {
    const job = await this.getJob(jobId);
    if (job === null) throw new NotFoundFailure("job");
    const claim = await this.claimLease(job, attemptId);
    if (claim.kind === "HELD") return { kind: "HELD", lease: claim.lease };
    const attempt = await this.insertAttempt(job, attemptId, job.attemptCount + 1, claim.lease.fence);
    return { kind: "CLAIMED", attempt, lease: claim.lease };
  }

  async recordLaunchIntent(attemptId: ProcessingAttemptId, intent: LaunchIntent): Promise<{ readonly job: ProcessingJobRecord; readonly attempt: ProcessingAttemptRecord }> {
    const attempt = await this.getAttempt(attemptId);
    if (attempt === null) throw new NotFoundFailure("attempt");
    // the ACTIVE slot (WAITING -> ACTIVE; a takeover of a running job already holds it) and the execution wall, set once
    await execute(this.db, "UPDATE kauro.processing_jobs SET holds = 'ACTIVE' WHERE job_id = $1 AND holds = 'WAITING'", [attempt.jobId]);
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.processing_attempts SET state = 'STARTING', manifest_object_name = $2 WHERE attempt_id = $1 AND state = 'CLAIMED' RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptId, intent.manifestObjectName],
    );
    const moved = r.rows[0];
    if (!moved) throw notAvailable("the attempt", attempt.state);
    const job = await this.getJob(attempt.jobId);
    if (job === null) throw new NotFoundFailure("job");
    return { job, attempt: attemptRecord(moved) };
  }

  async recordLaunch(attemptId: ProcessingAttemptId, launchState: LaunchState, providerJobId: string | null): Promise<ProcessingAttemptRecord> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.processing_attempts SET launch_state = $2, provider_job_id = coalesce($3, provider_job_id) WHERE attempt_id = $1 RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptId, launchState, providerJobId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundFailure("attempt");
    return attemptRecord(row);
  }

  async observeStart(attemptId: ProcessingAttemptId): Promise<{ readonly job: ProcessingJobRecord; readonly attempt: ProcessingAttemptRecord }> {
    const r = await execute<Row>(this.db, `UPDATE kauro.processing_attempts SET state = 'RUNNING' WHERE attempt_id = $1 AND state = 'STARTING' RETURNING ${ATTEMPT_COLUMNS}`, [attemptId]);
    const moved = r.rows[0];
    if (!moved) {
      const current = await this.getAttempt(attemptId);
      if (current === null) throw new NotFoundFailure("attempt");
      throw notAvailable("the attempt", current.state);
    }
    const attempt = attemptRecord(moved);
    const started = await execute<Row>(
      this.db,
      `UPDATE kauro.processing_jobs SET version = version + 1, state = 'RUNNING' WHERE job_id = $1 AND state = 'ADMITTED' RETURNING ${JOB_COLUMNS}`,
      [attempt.jobId],
    );
    if (started.rows[0]) {
      const job = jobRecord(started.rows[0]);
      await this.emit("processing_job", job.jobId, job.agencyId, job.version, "processing_job.running.v1", { jobId: job.jobId, agencyId: job.agencyId, attemptId, fence: attempt.fence ?? 0, state: job.state });
      return { job, attempt };
    }
    const job = await this.getJob(attempt.jobId);
    if (job === null) throw new NotFoundFailure("job");
    return { job, attempt };
  }

  async heartbeat(jobId: ProcessingJobId, attemptId: ProcessingAttemptId, fence: number): Promise<LeaseRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${LEASE_COLUMNS} FROM kauro.heartbeat_lease('JOB_ATTEMPT', $1, $2, $3, $4, kauro.server_now())`, [jobId, attemptId, fence, EXECUTION_POLICY.leaseSeconds]);
    const row = r.rows[0];
    if (!row || row["resource_id"] === null) return null;
    return this.jobLease(jobId);
  }

  async mirrorCancellation(jobId: ProcessingJobId): Promise<LeaseRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${LEASE_COLUMNS} FROM kauro.cancel_lease('JOB_ATTEMPT', $1)`, [jobId]);
    const row = r.rows[0];
    if (!row || row["resource_id"] === null) return null;
    return this.jobLease(jobId);
  }

  /** Registers one object of a zone at its generation (B07's registry: born INTENDED, then observed PRESENT; D-OBJ-1). */
  private async registerObject(input: { readonly objectId: string; readonly agencyId: AgencyId; readonly projectId: string; readonly revisionId: string | null; readonly zone: "STAGING" | "DELIVERY"; readonly provider: string; readonly locationRef: string; readonly objectName: string; readonly generation: string; readonly bytes: number }): Promise<void> {
    await execute(
      this.db,
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'DERIVED', $6, $7, $8, 'SERVICE', $9, kauro.server_now(), kauro.server_now())`,
      [input.objectId, input.agencyId, input.projectId, input.revisionId, input.zone, input.provider, input.locationRef, input.objectName, this.serviceRef()],
    );
    await execute(
      this.db,
      "UPDATE kauro.stored_objects SET state = 'PRESENT', generation = $2, bytes = $3, observed_at = kauro.server_now() WHERE object_id = $1 AND state = 'INTENDED'",
      [input.objectId, input.generation, input.bytes],
    );
  }

  async submitManifest(attemptId: ProcessingAttemptId, submission: ManifestSubmission): Promise<StagingRecord> {
    const attempt = await this.getAttempt(attemptId);
    if (attempt === null) throw new NotFoundFailure("attempt");
    const job = await this.getJob(attempt.jobId);
    if (job === null) throw new NotFoundFailure("job");
    if (attempt.fence === undefined) throw notAvailable("the attempt", attempt.state);
    const revisionId = await this.revisionOf(job);
    for (const a of submission.artifacts) {
      await this.registerObject({ objectId: a.objectId, agencyId: job.agencyId, projectId: job.projectId, revisionId, zone: "STAGING", provider: submission.location.provider, locationRef: submission.location.locationRef, objectName: a.objectName, generation: a.generation, bytes: a.byteLength });
    }
    const m = await execute<Row>(
      this.db,
      `INSERT INTO kauro.staged_manifests (attempt_id, agency_id, project_id, job_id, fence, input_binding_hash, object_name, generation, manifest_hash, artifact_count, declared_summary_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${MANIFEST_COLUMNS}`,
      [
        attemptId,
        job.agencyId,
        job.projectId,
        job.jobId,
        attempt.fence,
        job.inputBindingHash,
        submission.manifest.objectName,
        submission.manifest.generation,
        submission.manifest.manifestHash,
        submission.artifacts.length,
        submission.manifest.declaredSummaryHash,
      ],
    );
    const manifest = manifestRecord(one(m.rows, "staged manifest"));
    const artifacts: StagedArtifactRecord[] = [];
    for (const a of submission.artifacts) {
      const r = await execute<Row>(
        this.db,
        `INSERT INTO kauro.staged_artifacts (attempt_id, object_name, agency_id, job_id, role, object_id, generation, sha256, byte_length)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${ARTIFACT_COLUMNS}`,
        [attemptId, a.objectName, job.agencyId, job.jobId, a.role, a.objectId, a.generation, a.sha256, a.byteLength],
      );
      artifacts.push(artifactRecord(one(r.rows, "staged artifact")));
    }
    const staged = await execute<Row>(this.db, `UPDATE kauro.processing_attempts SET state = 'STAGED' WHERE attempt_id = $1 AND state = 'RUNNING' RETURNING ${ATTEMPT_COLUMNS}`, [attemptId]);
    const stagedAttempt = attemptRecord(one(staged.rows, "staged attempt"));
    const verifying = await execute<Row>(
      this.db,
      `UPDATE kauro.processing_jobs SET version = version + 1, state = 'VERIFYING' WHERE job_id = $1 AND state = 'RUNNING' RETURNING ${JOB_COLUMNS}`,
      [job.jobId],
    );
    const verifyingJob = verifying.rows[0] ? jobRecord(verifying.rows[0]) : null;
    if (verifyingJob === null) throw notAvailable("the job", job.state);
    const p = await execute<Row>(
      this.db,
      `INSERT INTO kauro.package_versions (package_version_id, agency_id, project_id, job_id, attempt_id, manifest_hash, artifact_count, delivery_prefix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PACKAGE_COLUMNS}`,
      [submission.packageVersionId, job.agencyId, job.projectId, job.jobId, attemptId, manifest.manifestHash, manifest.artifactCount, packageDeliveryPrefixOf(job.agencyId, job.projectId, submission.packageVersionId)],
    );
    const packageVersion = packageRecord(one(p.rows, "package version"));
    await this.emit("processing_job", verifyingJob.jobId, verifyingJob.agencyId, verifyingJob.version, "processing_job.verifying.v1", {
      jobId: verifyingJob.jobId,
      agencyId: verifyingJob.agencyId,
      attemptId,
      fence: manifest.fence,
      packageVersionId: packageVersion.packageVersionId,
      manifestHash: manifest.manifestHash,
      state: verifyingJob.state,
    });
    await this.emit("package_version", packageVersion.packageVersionId, packageVersion.agencyId, packageVersion.version, "package_version.staged.v1", {
      packageVersionId: packageVersion.packageVersionId,
      agencyId: packageVersion.agencyId,
      jobId: packageVersion.jobId,
      attemptId,
      manifestHash: packageVersion.manifestHash,
      artifactCount: packageVersion.artifactCount,
      state: packageVersion.state,
    });
    return { job: verifyingJob, attempt: stagedAttempt, manifest, artifacts, packageVersion };
  }

  async startVerification(attemptId: ProcessingAttemptId): Promise<ProcessingAttemptRecord> {
    const r = await execute<Row>(this.db, `UPDATE kauro.processing_attempts SET state = 'VERIFYING' WHERE attempt_id = $1 AND state = 'STAGED' RETURNING ${ATTEMPT_COLUMNS}`, [attemptId]);
    const row = r.rows[0];
    if (!row) {
      const current = await this.getAttempt(attemptId);
      if (current === null) throw new NotFoundFailure("attempt");
      throw notAvailable("the attempt", current.state);
    }
    return attemptRecord(row);
  }

  async recordReadback(readback: ReadbackInput): Promise<ArtifactReadbackRecord> {
    const attempt = await this.getAttempt(readback.attemptId);
    if (attempt === null) throw new NotFoundFailure("attempt");
    const result = readbackResult(readback);
    const o = result === "MISSING" ? null : readback.observed;
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.artifact_readbacks (readback_id, agency_id, job_id, attempt_id, kind, package_version_id, object_name, expected_generation, expected_sha256, expected_bytes,
          observed_generation, observed_sha256, observed_bytes, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${READBACK_COLUMNS}`,
      [
        readback.readbackId,
        attempt.agencyId,
        attempt.jobId,
        readback.attemptId,
        readback.kind,
        readback.packageVersionId ?? null,
        readback.objectName,
        readback.expected.generation,
        readback.expected.sha256,
        readback.expected.byteLength,
        o?.generation ?? null,
        o?.sha256 ?? null,
        o?.byteLength ?? null,
        result,
      ],
    );
    const record = readbackRecord(one(r.rows, "read-back"));
    if (result === "EQUAL") {
      // the registry records the digest the read-back verified (B07 D-OBJ-1: VERIFIED carries the content hash)
      await execute(
        this.db,
        `UPDATE kauro.stored_objects SET state = 'VERIFIED', sha256 = $3, verified_at = kauro.server_now()
          WHERE agency_id = $1 AND object_name = $2 AND generation = $4 AND state = 'PRESENT' AND zone = $5`,
        [attempt.agencyId, readback.objectName, readback.expected.sha256, readback.expected.generation, readback.kind],
      );
    }
    return record;
  }

  async recordVerification(verification: VerificationInput): Promise<PackageVerificationRecord> {
    const attempt = await this.getAttempt(verification.attemptId);
    if (attempt === null) throw new NotFoundFailure("attempt");
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.package_verifications (verification_id, agency_id, job_id, attempt_id, package_version_id, result, problems, evidence_class, expected_authority_hash, core_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) RETURNING ${VERIFICATION_COLUMNS}`,
      [
        verification.verificationId,
        attempt.agencyId,
        attempt.jobId,
        verification.attemptId,
        verification.packageVersionId,
        verification.result,
        JSON.stringify(verification.problems),
        verification.evidenceClass,
        verification.expectedAuthorityHash,
        verification.coreVersion,
      ],
    );
    return verificationRecord(one(r.rows, "verification"));
  }

  async markVerifiedPrivate(packageVersionId: PackageVersionId, verificationId: PackageVerificationId): Promise<PackageVersionRecord> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.package_versions SET version = version + 1, state = 'VERIFIED_PRIVATE', verification_id = $2 WHERE package_version_id = $1 AND state = 'STAGED' RETURNING ${PACKAGE_COLUMNS}`,
      [packageVersionId, verificationId],
    );
    const row = r.rows[0];
    if (!row) {
      const current = await this.getPackage(packageVersionId);
      if (current === null) throw new NotFoundFailure("package version");
      throw notAvailable("the package version", current.state);
    }
    const record = packageRecord(row);
    await this.emit("package_version", record.packageVersionId, record.agencyId, record.version, "package_version.verified_private.v1", {
      packageVersionId: record.packageVersionId,
      agencyId: record.agencyId,
      jobId: record.jobId,
      attemptId: record.attemptId,
      verificationId,
      state: record.state,
    });
    return record;
  }

  async recordDeliveryCopy(copy: DeliveryCopyInput): Promise<DeliveryArtifactRecord> {
    const pkg = await this.getPackage(copy.packageVersionId);
    if (pkg === null) throw new NotFoundFailure("package version");
    const source = await execute<Row>(this.db, `SELECT ${ARTIFACT_COLUMNS} FROM kauro.staged_artifacts WHERE attempt_id = $1 AND object_name = $2`, [pkg.attemptId, copy.sourceObjectName]);
    const staged = source.rows[0] ? artifactRecord(source.rows[0]) : null;
    if (staged === null) throw new DomainFailure("PRECONDITION_FAILED", "a delivery copy names a staged artifact of its package's attempt", { reason: "EXECUTION_FENCED" });
    const job = await this.getJob(pkg.jobId);
    if (job === null) throw new NotFoundFailure("job");
    await this.registerObject({ objectId: copy.objectId, agencyId: pkg.agencyId, projectId: pkg.projectId, revisionId: await this.revisionOf(job), zone: "DELIVERY", provider: copy.location.provider, locationRef: copy.location.locationRef, objectName: copy.objectName, generation: copy.generation, bytes: staged.byteLength });
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.delivery_artifacts (package_version_id, object_name, agency_id, job_id, attempt_id, source_object_name, role, object_id, generation, sha256, byte_length)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${DELIVERY_COLUMNS}`,
      [copy.packageVersionId, copy.objectName, pkg.agencyId, pkg.jobId, pkg.attemptId, copy.sourceObjectName, staged.role, copy.objectId, copy.generation, staged.sha256, staged.byteLength],
    );
    return deliveryRecord(one(r.rows, "delivery copy"));
  }

  async publish(publication: PublicationInput): Promise<PublicationOutcome> {
    const seen = await this.getJob(publication.jobId);
    if (seen === null) throw new NotFoundFailure("job");
    // D8-PUB-2: project (shared transition lock) -> job -> authorization (row, then its exclusive half with the edge) -> plan,
    // source, target, capability, agency (shared) -> lease -> package; the deferred guard re-reads everything at COMMIT
    await this.awaitTransition({ kind: "PROJECT", key: seen.projectId });
    const job = await this.lockJob(publication.jobId);
    if (job === null) throw new NotFoundFailure("job");
    if (job.state !== "VERIFYING" || job.cancelVersion !== 0) {
      return { kind: "REFUSED", reason: job.cancelVersion !== 0 ? "JOB_CANCELLED" : "JOB_NOT_VERIFYING", job, packageVersion: await this.getPackage(publication.packageVersionId) };
    }
    await this.lockAuthorizationRow(job.authorizationId);
    await this.awaitTransition({ kind: "APPROVAL", key: job.approvalId });
    const revisionId = await this.revisionOf(job);
    await this.awaitTransition({ kind: "REVISION", key: revisionId });
    const contract = await execute<{ contract_id: string }>(this.db, "SELECT contract_id FROM kauro.target_contracts WHERE agency_id = $1 AND project_id = $2 AND body_hash = $3", [job.agencyId, job.projectId, job.targetContractHash]);
    if (contract.rows[0]) await this.awaitTransition({ kind: "TARGET_CONTRACT", key: contract.rows[0].contract_id });
    await this.awaitTransition({ kind: "CAPABILITY", key: job.mode });
    await this.awaitTransition({ kind: "AGENCY", key: job.agencyId });
    await execute(this.db, "SELECT fence FROM kauro.leases WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1 FOR SHARE", [job.jobId]);
    const locked = await execute<Row>(this.db, `SELECT ${PACKAGE_COLUMNS} FROM kauro.package_versions WHERE package_version_id = $1 FOR UPDATE`, [publication.packageVersionId]);
    const pkg = locked.rows[0] ? packageRecord(locked.rows[0]) : null;
    if (pkg === null || pkg.jobId !== job.jobId) return { kind: "REFUSED", reason: "NOT_THE_JOBS_PACKAGE", job, packageVersion: pkg };
    if (pkg.state !== "VERIFIED_PRIVATE") return { kind: "REFUSED", reason: "PACKAGE_NOT_VERIFIED", job, packageVersion: pkg };

    // the edges, all or nothing: the attempt COMMITTED (its fence re-checked now), the package AVAILABLE, the job READY, the
    // entitlement DELIVERED, the revision's PACKAGE_AVAILABLE anchor and the first package's soft deadline
    const committed = await execute<Row>(this.db, `UPDATE kauro.processing_attempts SET state = 'COMMITTED' WHERE attempt_id = $1 AND state = 'VERIFYING' RETURNING ${ATTEMPT_COLUMNS}`, [pkg.attemptId]);
    const attempt = committed.rows[0] ? attemptRecord(committed.rows[0]) : null;
    if (attempt === null) throw new DomainFailure("PRECONDITION_FAILED", `the attempt of package ${pkg.packageVersionId} is not verifying`, { reason: "EXECUTION_FENCED" });
    const available = await execute<Row>(
      this.db,
      `UPDATE kauro.package_versions SET version = version + 1, state = 'AVAILABLE', delivery_manifest_hash = $2 WHERE package_version_id = $1 AND state = 'VERIFIED_PRIVATE' RETURNING ${PACKAGE_COLUMNS}`,
      [pkg.packageVersionId, publication.deliveryManifestHash],
    );
    const packageVersion = packageRecord(one(available.rows, "published package"));
    const ready = await execute<Row>(
      this.db,
      `UPDATE kauro.processing_jobs SET version = version + 1, state = 'READY', published_package_id = $2 WHERE job_id = $1 AND version = $3 RETURNING ${JOB_COLUMNS}`,
      [job.jobId, pkg.packageVersionId, job.version],
    );
    const readyJob = jobRecord(one(ready.rows, "ready job"));
    const delivered = await execute<{ version: string }>(
      this.db,
      `UPDATE kauro.commercial_authorizations SET version = version + 1, state = 'DELIVERED', delivered_at = kauro.server_now()
        WHERE authorization_id = $1 AND state = 'CONSUMED' AND job_ref = $2 RETURNING version::text AS version`,
      [job.authorizationId, job.jobId],
    );
    const anchor = await this.anchorOf(job, revisionId, "PACKAGE_AVAILABLE", publication.anchorId);
    await this.emit("package_version", packageVersion.packageVersionId, packageVersion.agencyId, packageVersion.version, "package_version.available.v1", {
      packageVersionId: packageVersion.packageVersionId,
      agencyId: packageVersion.agencyId,
      jobId: packageVersion.jobId,
      projectId: packageVersion.projectId,
      deliveryManifestHash: publication.deliveryManifestHash,
      artifactCount: packageVersion.artifactCount,
      state: packageVersion.state,
    });
    await this.emit("processing_job", readyJob.jobId, readyJob.agencyId, readyJob.version, "processing_job.ready.v1", {
      jobId: readyJob.jobId,
      agencyId: readyJob.agencyId,
      projectId: readyJob.projectId,
      attemptId: attempt.attemptId,
      packageVersionId: packageVersion.packageVersionId,
      deliveryManifestHash: publication.deliveryManifestHash,
      state: readyJob.state,
    });
    // a revoked (or otherwise moved) entitlement is not delivered here: the deferred guard refuses the publication (KA081)
    if (delivered.rows[0]) {
      await this.emit("commercial_authorization", job.authorizationId, job.agencyId, int(delivered.rows[0].version), "commercial_authorization.delivered.v1", {
        authorizationId: job.authorizationId,
        agencyId: job.agencyId,
        jobRef: job.jobId,
        previousState: "CONSUMED",
      });
    }
    if (anchor.created) {
      const soft = await execute<{ retention_id: string; version: string; anchor_evidence_hash: string }>(
        this.db,
        `UPDATE kauro.retention_records AS r
            SET version = r.version + 1, soft_deadline = a.occurred_at + interval '604800 seconds',
                effective_deadline = least(a.occurred_at + interval '604800 seconds', r.hard_deadline)
           FROM kauro.retention_anchors a
          WHERE r.agency_id = $1 AND r.revision_id = $2 AND r.class = 'PAID_ORDINARY' AND r.state = 'ACTIVE' AND r.soft_deadline IS NULL
            AND a.anchor_id = $3
         RETURNING r.retention_id, r.version::text AS version, r.anchor_evidence_hash`,
        [job.agencyId, revisionId, anchor.anchorId],
      );
      const record = soft.rows[0];
      if (record) {
        await this.emit("retention_record", record.retention_id, job.agencyId, int(record.version), "retention_record.soft_deadline_set.v1", {
          retentionId: record.retention_id,
          agencyId: job.agencyId,
          projectId: job.projectId,
          revisionId,
          retentionClass: "PAID_ORDINARY",
          anchorEvidenceHash: anchor.evidenceHash,
        });
      }
    }
    return { kind: "PUBLISHED", job: readyJob, packageVersion, attempt };
  }

  async revokePackage(packageVersionId: PackageVersionId, expectedVersion: number, reasonCode: string): Promise<VersionedWrite<PackageVersionRecord>> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.package_versions AS t SET version = t.version + 1, state = 'REVOKED', revocation_reason = $3
         FROM kauro.package_versions AS o WHERE t.package_version_id = $1 AND t.version = $2 AND o.package_version_id = t.package_version_id
       RETURNING ${packageColumnsOf("t")}, o.state AS previous_state`,
      [packageVersionId, expectedVersion, reasonCode],
    );
    const row = r.rows[0];
    if (!row) return missedWrite(this.db, "package_versions", "package_version_id", packageVersionId, expectedVersion, "package version", ({ state }) => notAvailable("the package version", state));
    const record = packageRecord(row);
    await this.emit("package_version", record.packageVersionId, record.agencyId, record.version, "package_version.revoked.v1", {
      packageVersionId: record.packageVersionId,
      agencyId: record.agencyId,
      jobId: record.jobId,
      reasonCode,
      previousState: str(row["previous_state"]),
      state: record.state,
    });
    return { kind: "APPLIED", record };
  }

  private async endAttempt(attemptId: ProcessingAttemptId, state: "ABANDONED" | "FAILED", cause: string): Promise<ProcessingAttemptRecord> {
    const r = await execute<Row>(this.db, `UPDATE kauro.processing_attempts SET state = $2, terminal_cause = $3 WHERE attempt_id = $1 RETURNING ${ATTEMPT_COLUMNS}`, [attemptId, state, cause]);
    const row = r.rows[0];
    if (!row) throw new NotFoundFailure("attempt");
    return attemptRecord(row);
  }

  abandonAttempt(attemptId: ProcessingAttemptId, cause: string): Promise<ProcessingAttemptRecord> {
    return this.endAttempt(attemptId, "ABANDONED", cause);
  }

  failAttempt(attemptId: ProcessingAttemptId, cause: string): Promise<ProcessingAttemptRecord> {
    return this.endAttempt(attemptId, "FAILED", cause);
  }

  /** One terminal edge of a job at its version, with the event of the state it reaches. */
  private async endJob(jobId: ProcessingJobId, expectedVersion: number, state: "FAILED" | "CANCELLED" | "EXPIRED", reasonCode: string | null): Promise<VersionedWrite<ProcessingJobRecord>> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.processing_jobs AS t SET version = t.version + 1, state = $3, terminal_reason = coalesce($4, t.terminal_reason)
         FROM kauro.processing_jobs AS o WHERE t.job_id = $1 AND t.version = $2 AND o.job_id = t.job_id
       RETURNING ${jobColumnsOf("t")}, o.state AS previous_state`,
      [jobId, expectedVersion, state, reasonCode],
    );
    const row = r.rows[0];
    if (!row) return missedWrite(this.db, "processing_jobs", "job_id", jobId, expectedVersion, "job", ({ state: current }) => notAvailable("the job", current));
    const record = jobRecord(row);
    const previousState = str(row["previous_state"]);
    const payload: EventPayload =
      state === "FAILED"
        ? { jobId: record.jobId, agencyId: record.agencyId, ...opt("attemptId", record.currentAttemptId), reasonCode: reasonCode ?? "UNSPECIFIED", previousState, state }
        : state === "CANCELLED"
          ? { jobId: record.jobId, agencyId: record.agencyId, cancelVersion: record.cancelVersion, ...opt("packageVersionId", record.publishedPackageId), state }
          : { jobId: record.jobId, agencyId: record.agencyId, reasonCode: reasonCode ?? "DEADLINE_REACHED", previousState, state };
    await this.emit("processing_job", record.jobId, record.agencyId, record.version, state === "FAILED" ? "processing_job.failed.v1" : state === "CANCELLED" ? "processing_job.cancelled.v1" : "processing_job.expired.v1", payload);
    return { kind: "APPLIED", record };
  }

  failJob(jobId: ProcessingJobId, expectedVersion: number, reasonCode: string): Promise<VersionedWrite<ProcessingJobRecord>> {
    return this.endJob(jobId, expectedVersion, "FAILED", reasonCode);
  }

  completeCancellation(jobId: ProcessingJobId, expectedVersion: number): Promise<VersionedWrite<ProcessingJobRecord>> {
    return this.endJob(jobId, expectedVersion, "CANCELLED", null);
  }

  expireJob(jobId: ProcessingJobId, expectedVersion: number, reasonCode: string): Promise<VersionedWrite<ProcessingJobRecord>> {
    return this.endJob(jobId, expectedVersion, "EXPIRED", reasonCode);
  }

  async recordCleanup(cleanup: CleanupInput): Promise<AttemptCleanupRecord> {
    const attempt = await this.getAttempt(cleanup.attemptId);
    if (attempt === null) throw new NotFoundFailure("attempt");
    const res = cleanup.resources;
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.attempt_cleanups (cleanup_id, agency_id, job_id, attempt_id, provider_identity, staging_prefix, deleted_objects, termination_result, scratch_deleted,
          machine_type, vcpus, memory_bytes, disk_bytes, peak_scratch_bytes, runtime_ms, cost_micros, currency, result, evidence_class, resource_report)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING ${CLEANUP_COLUMNS}`,
      [
        cleanup.cleanupId,
        attempt.agencyId,
        attempt.jobId,
        attempt.attemptId,
        attempt.identity,
        attempt.stagingPrefix,
        JSON.stringify(cleanup.deletedObjects.map((o) => ({ objectId: o.objectId, objectName: o.objectName, generation: o.generation }))),
        cleanup.terminationResult,
        cleanup.scratchDeleted,
        res?.machineType ?? null,
        res?.vcpus ?? null,
        res?.memoryBytes ?? null,
        res?.diskBytes ?? null,
        res?.peakScratchBytes ?? null,
        res?.runtimeMs ?? null,
        res?.costMicros ?? null,
        res?.currency ?? null,
        cleanup.result,
        cleanup.evidenceClass,
        res !== null ? "REPORTED" : (cleanup.resourceReport ?? "NOT_FOUND"),
      ],
    );
    return cleanupRecord(one(r.rows, "attempt cleanup"));
  }
}
