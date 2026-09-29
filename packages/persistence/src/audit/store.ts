/**
 * The audit store over `pg` (package B08, mandate B08-PERSISTENCE-AUDIT; @kauro/domain ports/audit-store.ts;
 * docs/design/B08-audit-approval-jobs.md §3, §6, §7, §9; migration 0021).
 *
 * Each method is one edge or one evidence row, written in the caller's unit of work with the event of every aggregate version it
 * makes (audit.*, cost_grant.* of an agency's grant, B06's plan.* of a system draft or a validation), through the unit of work's
 * publisher and provenance. The database decides: its guards stamp every instant and deadline with kauro.server_now() (D8-CLOCK-1),
 * refuse a step, a journal event or a dispatch intent off the audit's current fence (KA080), an edge the audit's state, cancellation
 * or deadlines no longer admit (KA081), and an audit or a dispatch intent without a funded grant with room (KA083); a refusal reaches
 * the caller as the typed failure of sqlstate.ts. Lease calls pass the server instant in SQL. No method takes an instant from its
 * caller.
 */
import type { Id, Sha256Hex } from "@kauro/contracts";
import {
  AUDIT_POLICY,
  DomainFailure,
  NotFoundFailure,
  decisionArtifactHashOf,
  modelTaskJournalEventHashOf,
  auditEventTypeOf,
  costGrantEventTypeOf,
  type AggregateKind,
  type AgencyId,
  type ArtifactRef,
  type AuditCancellation,
  type AuditEdge,
  type AuditId,
  type AuditRecord,
  type AuditStepId,
  type AuditStepKind,
  type AuditStepRecord,
  type AuditStore,
  type CostGrantId,
  type CostGrantRecord,
  type DecisionArtifactRecord,
  type DispatchIntent,
  type DispatchOutcome,
  type EventPayload,
  type EventProvenance,
  type EventPublisher,
  type EventType,
  type GrantEdge,
  type IdGenerator,
  type JournalAppend,
  type JournalAppendOutcome,
  type LeaseRecord,
  type ModelTaskId,
  type ModelTaskJournalEntry,
  type ModelTaskRecord,
  type NewAudit,
  type NewDecisionArtifact,
  type NewModelTask,
  type PlanId,
  type PlanValidationId,
  type PlanValidationRecord,
  type RequestId,
  type ResourceId,
  type StartedAudit,
  type StepClaim,
  type StepResult,
  type StoredDecisionArtifact,
  type SystemDraft,
  type SystemDraftRecord,
  type TaskId,
  type ValidationRequest,
  type ValidationSettled,
  type ValidationSettlement,
  type VersionedWrite,
} from "@kauro/domain";
import { PgLeaseStore } from "../lease-store.js";
import { PgRequestJournal } from "../request-journal.js";
import { ConstraintViolation, execute, int, type Queryable } from "../sql.js";
import { missedWrite, notAvailable, one, serverInstantOf, str } from "../source/rows.js";
import {
  ARTIFACT_COLUMNS,
  AUDIT_COLUMNS,
  GRANT_COLUMNS,
  JOURNAL_COLUMNS,
  MODEL_TASK_COLUMNS,
  STEP_COLUMNS,
  VALIDATION_COLUMNS,
  artifactRecord,
  auditColumnsOf,
  auditRecord,
  cents,
  grantColumnsOf,
  grantRecord,
  journalEntry,
  modelTaskRecord,
  stepRecord,
  validationRecord,
  type Row,
} from "./rows.js";

/** What the audit store writes through: the unit of work's connection, id generator, publisher and provenance. */
export interface AuditWriteContext {
  readonly db: Queryable;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
  readonly provenance: () => EventProvenance;
}

const LEASE_COLUMNS = "resource_kind, resource_id, owner_id, fence, expires_at, heartbeat_at, cancel_version, deadline_at, subject_hash, cost_authority_id, checkpoint_hash";

/** The audit's identity keys every audit event carries (model/audit/events.ts). */
function auditKeys(a: AuditRecord, previousState: string): EventPayload {
  return { auditId: a.auditId, agencyId: a.agencyId, projectId: a.projectId, revisionId: a.revisionId, targetContractId: a.targetContractId, grantId: a.grantId, fence: a.fence, previousState, state: a.state };
}

/** Money as a payload count: a grant's cents stay far inside the safe integers (its ceiling is an owner's monthly statement). */
function centsCount(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new DomainFailure("INTEGRITY_FAILURE", "a grant's cents are a non-negative safe integer");
  return n;
}

export class PgAuditStore implements AuditStore {
  readonly #leases: PgLeaseStore;
  readonly #requests: PgRequestJournal;

  constructor(private readonly ctx: AuditWriteContext) {
    this.#leases = new PgLeaseStore(ctx.db);
    this.#requests = new PgRequestJournal(ctx.db);
  }

  private get db(): Queryable {
    return this.ctx.db;
  }

  /** Publishes the event of one aggregate version with the unit of work's provenance (its outbox rows from the subscriptions). */
  private async emit(aggregateKind: AggregateKind, aggregateId: string, agencyId: AgencyId, aggregateVersion: number, eventType: EventType, payload: EventPayload): Promise<void> {
    const p = this.ctx.provenance();
    await this.ctx.events.publish({ aggregateKind, aggregateId, aggregateVersion, agencyId, eventType, actor: p.actor, causationId: p.causationId, correlationId: p.correlationId, payload });
  }

  private async grantEvent(grant: CostGrantRecord, previousState: string): Promise<void> {
    if (grant.agencyId === undefined) return; // a platform pool publishes no event (it has no agency; decision D8-PAU-1)
    const type = costGrantEventTypeOf(grant.state);
    const payload: EventPayload =
      type === "cost_grant.prepared.v1" || type === "cost_grant.authorized.v1"
        ? { grantId: grant.grantId, agencyId: grant.agencyId, grantKind: grant.kind, ...(grant.poolGrantId === undefined ? {} : { poolGrantId: grant.poolGrantId }), ceilingCents: centsCount(grant.ceilingCents), ...(type === "cost_grant.authorized.v1" ? { previousState } : {}), state: grant.state }
        : { grantId: grant.grantId, agencyId: grant.agencyId, reservedCents: centsCount(grant.reservedCents), reconciledSpendCents: centsCount(grant.reconciledSpendCents), previousState, state: grant.state };
    await this.emit("cost_grant", grant.grantId, grant.agencyId, grant.version, type, payload);
  }

  // --- reads ------------------------------------------------------------------------------------------------------------------------

  async getAudit(auditId: AuditId): Promise<AuditRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${AUDIT_COLUMNS} FROM kauro.audits WHERE audit_id = $1`, [auditId]);
    return r.rows[0] ? auditRecord(r.rows[0]) : null;
  }

  async lockAudit(auditId: AuditId): Promise<AuditRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${AUDIT_COLUMNS} FROM kauro.audits WHERE audit_id = $1 FOR UPDATE`, [auditId]);
    return r.rows[0] ? auditRecord(r.rows[0]) : null;
  }

  async getGrant(grantId: CostGrantId): Promise<CostGrantRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${GRANT_COLUMNS} FROM kauro.cost_grants WHERE grant_id = $1`, [grantId]);
    return r.rows[0] ? grantRecord(r.rows[0]) : null;
  }

  async stepsOf(auditId: AuditId): Promise<ReadonlyArray<AuditStepRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${STEP_COLUMNS} FROM kauro.audit_steps WHERE audit_id = $1 ORDER BY fence`, [auditId]);
    return r.rows.map(stepRecord);
  }

  async modelTasksOf(auditId: AuditId): Promise<ReadonlyArray<ModelTaskRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${MODEL_TASK_COLUMNS} FROM kauro.model_tasks WHERE audit_id = $1 ORDER BY created_at, model_task_id`, [auditId]);
    return r.rows.map(modelTaskRecord);
  }

  async journalOf(runId: Id): Promise<ReadonlyArray<ModelTaskJournalEntry>> {
    const r = await execute<Row>(this.db, `SELECT ${JOURNAL_COLUMNS} FROM kauro.model_task_journal WHERE run_id = $1 ORDER BY position`, [runId]);
    return r.rows.map(journalEntry);
  }

  async getDecisionArtifact(artifactRef: ArtifactRef): Promise<DecisionArtifactRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${ARTIFACT_COLUMNS} FROM kauro.decision_artifacts WHERE artifact_id = $1`, [artifactRef]);
    return r.rows[0] ? artifactRecord(r.rows[0]) : null;
  }

  async validationsOf(planId: PlanId): Promise<ReadonlyArray<PlanValidationRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${VALIDATION_COLUMNS} FROM kauro.plan_validations WHERE plan_id = $1 ORDER BY fence`, [planId]);
    return r.rows.map(validationRecord);
  }

  // --- request handlers -----------------------------------------------------------------------------------------------------------

  async startAudit(audit: NewAudit): Promise<StartedAudit> {
    // the funded pools under their row locks (D8-GRANT-1): a second StartAudit for the same cents waits here and then reads what the
    // first one left; the statement is short so the lock wait names it in pg_stat_activity
    const pools = await execute<{ grant_id: string; ceiling: string; reserved: string; spent: string }>(
      this.db,
      `SELECT grant_id, ceiling_cents::text AS ceiling, reserved_cents::text AS reserved, reconciled_spend_cents::text AS spent
         FROM kauro.cost_grants WHERE grant_kind = 'PLATFORM_MONTHLY' AND state = 'AUTHORIZED' AND expires_at > kauro.server_now()
        ORDER BY expires_at, grant_id FOR UPDATE`,
    );
    const pool = pools.rows.find((p) => cents(p.ceiling) - cents(p.reserved) - cents(p.spent) >= audit.ceilingCents);
    if (pool === undefined) throw new DomainFailure("BUDGET_EXHAUSTED", "no funded platform pool holds a free audit grant now", { reason: "NO_FUNDED_GRANT" });
    // the AUDIT grant, born PREPARED and authorized by its pool, which then holds its ceiling (the database's hold, a level deeper)
    const prepared = await execute<Row>(
      this.db,
      `INSERT INTO kauro.cost_grants (grant_id, agency_id, grant_kind, pool_grant_id, currency, ceiling_cents, price_profile_hash)
       VALUES ($1, $2, 'AUDIT', $3, $4, $5, $6) RETURNING ${GRANT_COLUMNS}`,
      [audit.grantId, audit.agencyId, pool.grant_id, AUDIT_POLICY.currency, audit.ceilingCents.toString(), audit.priceProfileHash],
    );
    const preparedGrant = grantRecord(one(prepared.rows, "the AUDIT grant"));
    await this.grantEvent(preparedGrant, "PREPARED");
    const authorized = await execute<Row>(
      this.db,
      `UPDATE kauro.cost_grants SET version = version + 1, state = 'AUTHORIZED', authorization_ref = pool_grant_id WHERE grant_id = $1 AND state = 'PREPARED' RETURNING ${GRANT_COLUMNS}`,
      [audit.grantId],
    );
    const grant = grantRecord(one(authorized.rows, "the authorized AUDIT grant"));
    await this.grantEvent(grant, "PREPARED");
    const inserted = await execute<Row>(
      this.db,
      `INSERT INTO kauro.audits (audit_id, agency_id, project_id, revision_id, revision_hash, target_contract_id, target_contract_hash, audit_policy_version, requested_by_membership_id, grant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${AUDIT_COLUMNS}`,
      [audit.auditId, audit.agencyId, audit.projectId, audit.revisionId, audit.revisionHash, audit.targetContractId, audit.targetContractHash, audit.auditPolicyVersion, audit.requestedByMembershipId, audit.grantId],
    );
    const record = auditRecord(one(inserted.rows, "the queued audit"));
    await this.emit("audit", record.auditId, record.agencyId, record.version, "audit.queued.v1", {
      auditId: record.auditId,
      agencyId: record.agencyId,
      projectId: record.projectId,
      revisionId: record.revisionId,
      revisionHash: record.revisionHash,
      targetContractId: record.targetContractId,
      targetContractHash: record.targetContractHash,
      grantId: record.grantId,
      state: record.state,
    });
    const held = await this.getGrant(pool.grant_id as CostGrantId);
    if (held === null) throw new DomainFailure("INTEGRITY_FAILURE", "the pool of the AUDIT grant is not visible");
    return { audit: record, grant, pool: held };
  }

  async cancelAudit(auditId: AuditId, expectedVersion: number, cancellation: AuditCancellation): Promise<VersionedWrite<AuditRecord>> {
    const actorId = cancellation.actor.kind === "USER" ? cancellation.actor.userId : cancellation.actor.serviceId;
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.audits AS t
          SET version = t.version + 1, state = 'CANCELLED', cancel_version = t.cancel_version + 1, cancel_actor_kind = $3, cancel_actor_id = $4, terminal_reason = $5
         FROM kauro.audits AS o
        WHERE t.audit_id = $1 AND t.version = $2 AND o.audit_id = t.audit_id AND t.state IN ('QUEUED', 'PROFILING', 'INTERPRETING', 'VALIDATING')
       RETURNING ${auditColumnsOf("t")}, o.state AS previous_state`,
      [auditId, expectedVersion, cancellation.actor.kind, actorId, cancellation.reasonCode],
    );
    const row = r.rows[0];
    if (!row) return missedWrite(this.db, "audits", "audit_id", auditId, expectedVersion, "audit", ({ state }) => notAvailable("the audit", state));
    const record = auditRecord(row);
    await this.emit("audit", record.auditId, record.agencyId, record.version, "audit.cancelled.v1", {
      ...auditKeys(record, str(row["previous_state"])),
      cancelVersion: record.cancelVersion,
      actorKind: cancellation.actor.kind,
      reasonCode: cancellation.reasonCode,
    });
    return { kind: "APPLIED", record };
  }

  async storeDecisionArtifact(artifact: NewDecisionArtifact): Promise<StoredDecisionArtifact> {
    const contentHash = decisionArtifactHashOf(artifact.kind, artifact.document);
    const inserted = await execute<Row>(
      this.db,
      `INSERT INTO kauro.decision_artifacts (artifact_id, agency_id, audit_id, kind, document, content_hash, created_by_membership_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) ON CONFLICT (agency_id, audit_id, kind, content_hash) DO NOTHING RETURNING ${ARTIFACT_COLUMNS}`,
      [artifact.artifactRef, artifact.agencyId, artifact.auditId, artifact.kind, JSON.stringify(artifact.document), contentHash, artifact.createdByMembershipId],
    );
    if (inserted.rows[0]) return { artifact: artifactRecord(inserted.rows[0]), created: true };
    const stored = await execute<Row>(
      this.db,
      `SELECT ${ARTIFACT_COLUMNS} FROM kauro.decision_artifacts WHERE agency_id = $1 AND audit_id = $2 AND kind = $3 AND content_hash = $4`,
      [artifact.agencyId, artifact.auditId, artifact.kind, contentHash],
    );
    return { artifact: artifactRecord(one(stored.rows, "the stored decision artifact")), created: false };
  }

  async requestValidation(request: ValidationRequest): Promise<VersionedWrite<PlanValidationRecord>> {
    // the plan under its row lock at its version (CMD024's compare-and-swap), still requiring validation
    const locked = await execute<{ agency_id: string; version: string; state: string; body_hash: string; revision_hash: string; target_contract_hash: string }>(
      this.db,
      "SELECT agency_id, version::text AS version, state, body_hash, revision_hash, target_contract_hash FROM kauro.plans WHERE plan_id = $1 FOR UPDATE",
      [request.planId],
    );
    const plan = locked.rows[0];
    if (!plan) throw new NotFoundFailure("plan");
    if (int(plan.version) !== request.expectedVersion) return { kind: "STALE", currentVersion: int(plan.version), currentState: plan.state };
    if (plan.state !== "VALIDATION_REQUIRED") throw notAvailable("the plan", plan.state);
    const validation = await this.insertIntent(request.validationId, request.planId, plan, { origin: "COMMAND", requestedByMembershipId: request.requestedByMembershipId });
    await this.movePlan(request.planId, plan.agency_id as AgencyId, int(plan.version), "VALIDATING", { bodyHash: plan.body_hash });
    return { kind: "APPLIED", record: validation };
  }

  /** The plan's next validation intent (the database checks the fence and the plan's state, D8-PLAN-2). */
  private async insertIntent(
    validationId: PlanValidationId,
    planId: PlanId,
    plan: { readonly agency_id: string; readonly body_hash: string; readonly revision_hash: string; readonly target_contract_hash: string },
    origin: { readonly origin: "COMMAND"; readonly requestedByMembershipId: string } | { readonly origin: "AUDIT"; readonly auditId: AuditId },
  ): Promise<PlanValidationRecord> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.plan_validations (validation_id, agency_id, plan_id, plan_hash, revision_hash, target_contract_hash, fence, origin, ${origin.origin === "COMMAND" ? "requested_by_membership_id" : "audit_id"})
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(v.fence), 0) + 1 FROM kauro.plan_validations v WHERE v.plan_id = $3), $7, $8) RETURNING ${VALIDATION_COLUMNS}`,
      [validationId, plan.agency_id, planId, plan.body_hash, plan.revision_hash, plan.target_contract_hash, origin.origin, origin.origin === "COMMAND" ? origin.requestedByMembershipId : origin.auditId],
    );
    return validationRecord(one(r.rows, "the validation intent"));
  }

  /** One validation edge of a plan at its version, with B06's event of the version it reaches. */
  private async movePlan(planId: PlanId, agencyId: AgencyId, fromVersion: number, to: "VALIDATION_REQUIRED" | "VALIDATING" | "VALIDATED", payload: { readonly bodyHash: string; readonly validationReceiptHash?: Sha256Hex }): Promise<number> {
    const r = await execute<{ version: string }>(
      this.db,
      `UPDATE kauro.plans SET version = version + 1, state = $3${to === "VALIDATED" ? ", validation_receipt_hash = $4" : ""} WHERE plan_id = $1 AND version = $2 RETURNING version::text AS version`,
      to === "VALIDATED" ? [planId, fromVersion, to, payload.validationReceiptHash] : [planId, fromVersion, to],
    );
    const version = int(one(r.rows, "the plan's validation edge").version);
    const type: EventType = to === "VALIDATED" ? "plan.validated.v1" : to === "VALIDATING" ? "plan.validating.v1" : "plan.validation_required.v1";
    await this.emit("plan", planId, agencyId, version, type, {
      planId,
      agencyId,
      bodyHash: payload.bodyHash,
      ...(to === "VALIDATED" && payload.validationReceiptHash !== undefined ? { validationReceiptHash: payload.validationReceiptHash } : {}),
    });
    return version;
  }

  // --- the control plane ----------------------------------------------------------------------------------------------------------

  async claimStep(auditId: AuditId, kind: AuditStepKind, stepId: AuditStepId): Promise<StepClaim> {
    const audit = await this.lockAudit(auditId);
    if (audit === null) throw new NotFoundFailure("audit");
    const inserted = await execute<Row>(
      this.db,
      `INSERT INTO kauro.audit_steps (step_id, agency_id, audit_id, kind, fence) VALUES ($1, $2, $3, $4, $5) RETURNING ${STEP_COLUMNS}`,
      [stepId, audit.agencyId, auditId, kind, audit.fence + 1],
    );
    const step = stepRecord(one(inserted.rows, "the claimed step"));
    if (kind === "PROFILE" && audit.state === "QUEUED") {
      // profile_worker_claims: QUEUED -> PROFILING with the claim (the database checks the step at the new fence)
      const moved = await execute<Row>(this.db, `UPDATE kauro.audits SET version = version + 1, state = 'PROFILING' WHERE audit_id = $1 AND version = $2 RETURNING ${AUDIT_COLUMNS}`, [auditId, audit.version]);
      const profiling = auditRecord(one(moved.rows, "the profiling audit"));
      await this.emit("audit", profiling.auditId, profiling.agencyId, profiling.version, "audit.profiling.v1", auditKeys(profiling, audit.state));
      return { step, audit: profiling };
    }
    const current = await this.getAudit(auditId);
    if (current === null) throw new NotFoundFailure("audit");
    return { step, audit: current };
  }

  async recordStep(stepId: AuditStepId, result: StepResult): Promise<AuditStepRecord> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.audit_steps SET outcome = $2, evidence_hash = $3, evidence_class = $4 WHERE step_id = $1 RETURNING ${STEP_COLUMNS}`,
      [stepId, result.outcome, result.evidenceHash, result.evidenceClass],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundFailure("audit step");
    return stepRecord(row);
  }

  async advanceAudit(auditId: AuditId, expectedVersion: number, edge: AuditEdge): Promise<VersionedWrite<AuditRecord>> {
    const sets: string[] = ["version = t.version + 1", "state = $3"];
    const params: unknown[] = [auditId, expectedVersion, edge.to];
    if (edge.to === "INTERPRETING") {
      params.push(edge.profileEvidenceHash, edge.candidateManifestHash);
      sets.push("profile_evidence_hash = $4", "candidate_manifest_hash = $5");
    } else if (edge.to === "NEEDS_DECISION" || edge.to === "UNSUPPORTED") {
      params.push(JSON.stringify(edge.findingCodes));
      sets.push("finding_codes = $4::jsonb");
    } else if (edge.to === "FAILED" || edge.to === "EXPIRED") {
      params.push(edge.reasonCode);
      sets.push("terminal_reason = $4");
    } else if (edge.to === "DRAFT_READY") {
      params.push(edge.draftPlanId);
      sets.push("draft_plan_id = $4");
    }
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.audits AS t SET ${sets.join(", ")} FROM kauro.audits AS o
        WHERE t.audit_id = $1 AND t.version = $2 AND o.audit_id = t.audit_id
       RETURNING ${auditColumnsOf("t")}, o.state AS previous_state`,
      params,
    );
    const row = r.rows[0];
    if (!row) return missedWrite(this.db, "audits", "audit_id", auditId, expectedVersion, "audit", ({ state }) => notAvailable("the audit", state));
    const record = auditRecord(row);
    const keys = auditKeys(record, str(row["previous_state"]));
    const extra: EventPayload =
      edge.to === "INTERPRETING"
        ? { profileEvidenceHash: edge.profileEvidenceHash, candidateManifestHash: edge.candidateManifestHash }
        : edge.to === "NEEDS_DECISION" || edge.to === "UNSUPPORTED"
          ? { findingCount: edge.findingCodes.length }
          : edge.to === "FAILED" || edge.to === "EXPIRED"
            ? { reasonCode: edge.reasonCode }
            : edge.to === "DRAFT_READY"
              ? { draftPlanId: edge.draftPlanId }
              : {};
    await this.emit("audit", record.auditId, record.agencyId, record.version, auditEventTypeOf(record.state), { ...keys, ...extra });
    return { kind: "APPLIED", record };
  }

  async recordSystemDraft(auditId: AuditId, draft: SystemDraft): Promise<SystemDraftRecord> {
    const audit = await this.getAudit(auditId);
    if (audit === null) throw new NotFoundFailure("audit");
    // the draft DRAFT (v1) of exactly the audit's subject, created by the audit's requester (the database checks both, D8-AUD-4)
    await execute(
      this.db,
      `INSERT INTO kauro.plans (plan_id, agency_id, project_id, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, kauro.server_now(), kauro.server_now())`,
      [draft.planId, audit.agencyId, audit.projectId, audit.revisionHash, audit.targetContractHash, draft.body.policyHash, JSON.stringify(draft.body), draft.bodyHash, audit.requestedByMembershipId],
    );
    await this.emit("plan", draft.planId, audit.agencyId, 1, "plan.created.v1", { planId: draft.planId, agencyId: audit.agencyId, projectId: audit.projectId, bodyHash: draft.bodyHash, createdByMembershipId: audit.requestedByMembershipId });
    // compiled_or_edited (v2), then validation_admitted (v3) with the draft's first validation intent
    const required = await this.movePlan(draft.planId, audit.agencyId, 1, "VALIDATION_REQUIRED", { bodyHash: draft.bodyHash });
    const validation = await this.insertIntent(draft.validationId, draft.planId, { agency_id: audit.agencyId, body_hash: draft.bodyHash, revision_hash: audit.revisionHash, target_contract_hash: audit.targetContractHash }, { origin: "AUDIT", auditId });
    const validating = await this.movePlan(draft.planId, audit.agencyId, required, "VALIDATING", { bodyHash: draft.bodyHash });
    return { planId: draft.planId, planVersion: validating, planState: "VALIDATING", validation };
  }

  async settleValidation(validationId: PlanValidationId, settlement: ValidationSettlement): Promise<ValidationSettled> {
    const settled = await execute<Row>(
      this.db,
      `UPDATE kauro.plan_validations SET result = $2, receipt_hash = $3 WHERE validation_id = $1 AND result IS NULL RETURNING ${VALIDATION_COLUMNS}`,
      [validationId, settlement.result, settlement.receiptHash],
    );
    const row = settled.rows[0];
    if (!row) throw new NotFoundFailure("unsettled validation intent");
    const validation = validationRecord(row);
    const latest = await execute<{ fence: string }>(this.db, "SELECT max(fence)::text AS fence FROM kauro.plan_validations WHERE plan_id = $1", [validation.planId]);
    const current = int(one(latest.rows, "the plan's latest intent").fence) === validation.fence;
    const plan = await execute<{ version: string; state: string }>(this.db, "SELECT version::text AS version, state FROM kauro.plans WHERE plan_id = $1", [validation.planId]);
    const p = one(plan.rows, "the validated plan");
    if (!current || p.state !== "VALIDATING") return { validation, current, planState: p.state, planVersion: int(p.version) };
    // only the current intent moves the plan (D8-PLAN-2): VALIDATED on its VALID receipt, back to VALIDATION_REQUIRED otherwise
    const to = settlement.result === "VALID" ? "VALIDATED" : "VALIDATION_REQUIRED";
    const version = await this.movePlan(validation.planId, validation.agencyId, int(p.version), to, {
      bodyHash: validation.planHash,
      ...(settlement.receiptHash === null ? {} : { validationReceiptHash: settlement.receiptHash }),
    });
    return { validation, current, planState: to, planVersion: version };
  }

  async createModelTask(task: NewModelTask): Promise<ModelTaskRecord> {
    const audit = await this.getAudit(task.auditId);
    if (audit === null) throw new NotFoundFailure("audit");
    const inserted = await execute<Row>(
      this.db,
      `INSERT INTO kauro.model_tasks (model_task_id, agency_id, audit_id, grant_id, step_fence, task_key, candidate_manifest_hash, policy_hash, minimized_request_hash, provider_profile_id, maximum_cost_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (audit_id, task_key) DO NOTHING RETURNING ${MODEL_TASK_COLUMNS}`,
      [
        task.modelTaskId,
        audit.agencyId,
        task.auditId,
        audit.grantId,
        task.stepFence,
        task.taskKey,
        task.candidateManifestHash,
        task.policyHash,
        task.minimizedRequestHash,
        task.providerProfileId,
        task.maximumCostCents.toString(),
      ],
    );
    if (inserted.rows[0]) return modelTaskRecord(inserted.rows[0]);
    // the same task planned again (a redelivered INTERPRET): its candidate set and policy are its idempotency identity
    const stored = await execute<Row>(this.db, `SELECT ${MODEL_TASK_COLUMNS} FROM kauro.model_tasks WHERE audit_id = $1 AND task_key = $2`, [task.auditId, task.taskKey]);
    const existing = modelTaskRecord(one(stored.rows, "the planned model task"));
    if (existing.candidateManifestHash !== task.candidateManifestHash || existing.policyHash !== task.policyHash) {
      throw new DomainFailure("INTEGRITY_FAILURE", `model task ${task.taskKey} of audit ${task.auditId} was planned over another candidate set or policy`);
    }
    return existing;
  }

  /** The MODEL_TASK lease claimed on the server clock (its deadline the interpretation deadline, its cost the audit's grant). */
  private async claimTaskLease(task: ModelTaskRecord, ownerId: string): Promise<LeaseRecord> {
    await execute(this.db, "SAVEPOINT kauro_model_task_lease");
    try {
      await execute(
        this.db,
        `SELECT ${LEASE_COLUMNS} FROM kauro.claim_lease('MODEL_TASK', $1, $2, $3, $4::timestamptz, $5, $6, NULL, kauro.server_now())`,
        [task.modelTaskId, ownerId, AUDIT_POLICY.modelTaskLeaseSeconds, task.interpretationDeadlineAt, task.taskKey, task.grantId],
      );
      await execute(this.db, "RELEASE SAVEPOINT kauro_model_task_lease");
    } catch (e) {
      await execute(this.db, "ROLLBACK TO SAVEPOINT kauro_model_task_lease");
      throw e;
    }
    const lease = await this.#leases.get("MODEL_TASK", task.modelTaskId as string as ResourceId);
    if (lease === null) throw new DomainFailure("INTEGRITY_FAILURE", "claim_lease returned no lease");
    return lease;
  }

  async beginDispatch(modelTaskId: ModelTaskId, dispatch: DispatchIntent): Promise<DispatchOutcome> {
    const found = await execute<Row>(this.db, `SELECT ${MODEL_TASK_COLUMNS} FROM kauro.model_tasks WHERE model_task_id = $1`, [modelTaskId]);
    if (!found.rows[0]) throw new NotFoundFailure("model task");
    const task = modelTaskRecord(found.rows[0]);
    const taskId = modelTaskId as string as TaskId;
    // a response already stored for the task is compiled before any new dispatch intent (D8-AUD-3)
    const stored = await execute<{ request_id: string }>(
      this.db,
      "SELECT request_id FROM kauro.request_journal WHERE task_id = $1 AND state IN ('RESPONSE_STORED', 'CONSUMED') ORDER BY fence DESC LIMIT 1",
      [modelTaskId],
    );
    if (stored.rows[0]) {
      const request = await this.#requests.get(stored.rows[0].request_id as RequestId);
      if (request === null) throw new DomainFailure("INTEGRITY_FAILURE", "the stored response's request is not visible");
      return { kind: "STORED_RESPONSE", request };
    }
    const lease = await this.claimTaskLease(task, dispatch.ownerId);
    if (lease.ownerId !== (dispatch.ownerId as string)) return { kind: "HELD", lease };
    // an attempt at the lease's current fence answers as it stands (sent, uncertain or merely reserved): no second intent per fence
    const current = await execute<{ request_id: string }>(this.db, "SELECT request_id FROM kauro.request_journal WHERE task_id = $1 AND fence = $2", [modelTaskId, lease.fence]);
    if (current.rows[0]) {
      const request = await this.#requests.get(current.rows[0].request_id as RequestId);
      if (request === null) throw new DomainFailure("INTEGRITY_FAILURE", "the current attempt is not visible");
      return { kind: "IN_FLIGHT", request, lease };
    }
    // the intent reserves on the audit's grant under the grant's row lock (the database's reservation, KA083)
    const request = await this.#requests.reserve({
      requestId: dispatch.requestId,
      taskId,
      agencyId: task.agencyId,
      requestHash: dispatch.requestHash,
      fence: lease.fence,
      reservedCents: dispatch.reservedCents.toString(),
      costGrantId: task.grantId,
      upstreamRequestIds: [],
      reservedAt: await serverInstantOf(this.db),
    });
    return { kind: "RESERVED", request, lease };
  }

  async appendJournal(append: JournalAppend): Promise<JournalAppendOutcome> {
    const audit = await this.getAudit(append.auditId);
    if (audit === null) throw new NotFoundFailure("audit");
    const eventHash = modelTaskJournalEventHashOf(append.event);
    await execute(this.db, "SAVEPOINT kauro_journal_append");
    let appended: boolean;
    try {
      const r = await execute<{ position: number }>(
        this.db,
        `INSERT INTO kauro.model_task_journal (run_id, position, agency_id, audit_id, step_fence, event, event_hash)
         SELECT $1::uuid, $2::integer, $3::uuid, $4::uuid, $5::bigint, $6::jsonb, $7::text WHERE (SELECT count(*)::integer FROM kauro.model_task_journal j WHERE j.run_id = $1::uuid) = $2::integer RETURNING position`,
        [append.runId, append.expectedLength, audit.agencyId, append.auditId, append.stepFence, JSON.stringify(append.event), eventHash],
      );
      await execute(this.db, "RELEASE SAVEPOINT kauro_journal_append");
      appended = r.rows.length === 1;
    } catch (e) {
      await execute(this.db, "ROLLBACK TO SAVEPOINT kauro_journal_append");
      // another append took this position first (the key waited for it): the caller's length is stale
      if (!(e instanceof ConstraintViolation && e.constraint === "model_task_journal_pkey")) throw e;
      appended = false;
    }
    if (appended) return { ok: true, length: append.expectedLength + 1 };
    const length = await execute<{ n: string }>(this.db, "SELECT count(*)::text AS n FROM kauro.model_task_journal WHERE run_id = $1", [append.runId]);
    return { ok: false, conflict: "LENGTH_MISMATCH", actualLength: int(one(length.rows, "the journal's length").n) };
  }

  async transitionGrant(grantId: CostGrantId, expectedVersion: number, to: GrantEdge): Promise<VersionedWrite<CostGrantRecord>> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.cost_grants AS t SET version = t.version + 1, state = $3 FROM kauro.cost_grants AS o
        WHERE t.grant_id = $1 AND t.version = $2 AND o.grant_id = t.grant_id
       RETURNING ${grantColumnsOf("t")}, o.state AS previous_state`,
      [grantId, expectedVersion, to],
    );
    const row = r.rows[0];
    if (!row) return missedWrite(this.db, "cost_grants", "grant_id", grantId, expectedVersion, "grant", ({ state }) => notAvailable("the grant", state));
    const grant = grantRecord(row);
    await this.grantEvent(grant, str(row["previous_state"]));
    return { kind: "APPLIED", record: grant };
  }

  async reconcileRequest(requestId: RequestId, actualCents: bigint): Promise<CostGrantRecord> {
    if (actualCents < 0n) throw new DomainFailure("INVALID_REQUEST", "a reconciled usage is non-negative");
    const r = await execute<{ cost_grant_id: string; reserved: string }>(
      this.db,
      `UPDATE kauro.request_journal SET usage_state = 'RECONCILED', actual_cents = $2 WHERE request_id = $1 AND usage_state <> 'RECONCILED'
       RETURNING cost_grant_id, reserved_cents::text AS reserved`,
      [requestId, actualCents.toString()],
    );
    const settled = r.rows[0];
    if (!settled) throw new DomainFailure("PRECONDITION_FAILED", `request ${requestId} is not visible or already reconciled`, { reason: "UNLISTED_TRANSITION" });
    // its reservation leaves the grant and its actual usage joins the grant's spend (GRANT_RECONCILIATION, D8-GRANT-2)
    const g = await execute<Row>(
      this.db,
      `UPDATE kauro.cost_grants SET reserved_cents = reserved_cents - $2, reconciled_spend_cents = reconciled_spend_cents + $3 WHERE grant_id = $1 RETURNING ${GRANT_COLUMNS}`,
      [settled.cost_grant_id, settled.reserved, actualCents.toString()],
    );
    return grantRecord(one(g.rows, "the reconciled grant"));
  }
}
