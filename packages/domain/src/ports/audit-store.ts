/**
 * The audit store (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §6, §7, §9, §10): the port
 * over migration 0021 through which the request handlers start and cancel audits (CMD020, CMD021), store decision artifacts (the
 * intake of D8-PLAN-1) and record ValidatePlan's intent (CMD024), and the control plane claims and records the audit's steps, plans
 * and dispatches its model tasks, drafts and validates the system plan and reconciles the grants. It extends the B06/B07/B09/B08
 * foundation and never forks it: an AuditUnitOfWork IS an ExecutionUnitOfWork (D8-XPKG-10) — the same transaction, context binding,
 * event publisher, journals, leases and repositories on one connection — with this store on that connection.
 *
 * Every write is one listed edge (or one evidence row) with the event of each aggregate version it makes; the database is the
 * authority: its guards refuse a step, a journal event or a dispatch intent that is not under the audit's current fence (KA080), an
 * edge the audit's state, cancellation or deadlines no longer admit (KA081), and an audit or a dispatch intent without a funded grant
 * with room under its ceiling (KA083); it stamps every lifecycle instant and deadline with kauro.server_now() (D8-CLOCK-1) — no method
 * takes an instant from its caller. Lease operations pass the server instant in SQL. The pg implementation is @kauro/persistence's.
 */
import type { Id, Sha256Hex } from "@kauro/contracts";
import type { PlanBody } from "../model/aggregates.js";
import type { AgencyId, ArtifactRef, LeaseOwnerId, MembershipId, PlanId, ProjectId, RequestId, RevisionId, TargetContractId } from "../model/ids.js";
import type { ExecutionContext } from "../model/tenant.js";
import type { CancellationActor } from "../model/execution/records.js";
import type { AuditId, AuditStepId, CostGrantId, ModelTaskId, PlanValidationId } from "../model/audit/ids.js";
import type {
  AuditRecord,
  AuditStepKind,
  AuditStepOutcome,
  AuditStepRecord,
  CostGrantRecord,
  DecisionArtifactKind,
  DecisionArtifactRecord,
  ModelTaskJournalEntry,
  ModelTaskRecord,
  PlanValidationRecord,
  PlanValidationResult,
} from "../model/audit/records.js";
import type { AuditDiscovery } from "./audit-discovery.js";
import type { ExecutionUnitOfWork, ExecutionUnitOfWorkFactory } from "./execution-store.js";
import type { LeaseRecord } from "./lease-store.js";
import type { VersionedWrite } from "./repositories.js";
import type { RequestJournalRecord } from "./request-journal.js";
import type { SourceUnitOfWork } from "./source-store.js";
import type { UnitOfWorkOptions } from "./unit-of-work.js";

/** StartAudit's writes (CMD020; D8-GRANT-1): the audit of a sealed revision and a confirmed target, funded by a free AUDIT grant. */
export interface NewAudit {
  readonly auditId: AuditId;
  /** The AUDIT grant carved for it from the platform's pool. */
  readonly grantId: CostGrantId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly revisionHash: Sha256Hex;
  readonly targetContractId: TargetContractId;
  readonly targetContractHash: Sha256Hex;
  readonly auditPolicyVersion: string;
  /** The acting operator's own membership: the audit's requester and the creator of its system draft. */
  readonly requestedByMembershipId: MembershipId;
  /** The AUDIT grant's ceiling (at most AUDIT_POLICY.freeAuditCeilingCents) and the dated price profile it was sized under. */
  readonly ceilingCents: bigint;
  readonly priceProfileHash: Sha256Hex;
}

/** What StartAudit committed: the audit QUEUED, its AUDIT grant AUTHORIZED, and the pool that holds the grant's ceiling. */
export interface StartedAudit {
  readonly audit: AuditRecord;
  readonly grant: CostGrantRecord;
  readonly pool: CostGrantRecord;
}

/** CancelAudit (a person) or EXECUTION_CONTROL for a lost source (a service), with its reason token (D8-CANCEL-1, D8-CANCEL-2). */
export interface AuditCancellation {
  readonly actor: CancellationActor;
  readonly reasonCode: string;
}

/** A step claimed at the audit's next fence, and the audit after it (QUEUED -> PROFILING on the first PROFILE claim). */
export interface StepClaim {
  readonly step: AuditStepRecord;
  readonly audit: AuditRecord;
}

/** What a step's port call returned, recorded once under the step's fence. */
export interface StepResult {
  readonly outcome: AuditStepOutcome;
  readonly evidenceHash: Sha256Hex | null;
  readonly evidenceClass: "EXECUTED_LOCAL" | "SIMULATED";
}

/** The audit's orchestration edges (design §8.1), each from the step of its kind recorded under the audit's current fence. */
export type AuditEdge =
  | { readonly to: "INTERPRETING"; readonly profileEvidenceHash: Sha256Hex; readonly candidateManifestHash: Sha256Hex }
  | { readonly to: "VALIDATING" }
  | { readonly to: "NEEDS_DECISION" | "UNSUPPORTED"; readonly findingCodes: ReadonlyArray<string> }
  | { readonly to: "FAILED"; readonly reasonCode: string }
  | { readonly to: "DRAFT_READY"; readonly draftPlanId: PlanId }
  | { readonly to: "EXPIRED"; readonly reasonCode: string };

/** The system draft plan of a validating audit (D8-AUD-4): created DRAFT, compiled, and admitted to validation with its intent. */
export interface SystemDraft {
  readonly planId: PlanId;
  readonly validationId: PlanValidationId;
  readonly body: PlanBody;
  /** KAURO_PLAN_BODY_V1 of the body (B06 D-PLAN-5), which the receipt must name. */
  readonly bodyHash: Sha256Hex;
}

export interface SystemDraftRecord {
  readonly planId: PlanId;
  readonly planVersion: number;
  readonly planState: "VALIDATING";
  readonly validation: PlanValidationRecord;
}

/** ValidatePlan's intent (CMD024; D8-PLAN-2): VALIDATION_REQUIRED -> VALIDATING at the plan's version, with the intent's own fence. */
export interface ValidationRequest {
  readonly validationId: PlanValidationId;
  readonly planId: PlanId;
  readonly expectedVersion: number;
  readonly requestedByMembershipId: MembershipId;
}

/** The receipt the validator (kauro_validator) recorded for an intent, or none for a null or corrupt one (ERROR, CANCELLED). */
export interface ValidationSettlement {
  readonly result: PlanValidationResult;
  readonly receiptHash: Sha256Hex | null;
}

/** A settled intent; `current` says whether it was the plan's latest and so moved the plan (VALIDATED or back to VALIDATION_REQUIRED). */
export interface ValidationSettled {
  readonly validation: PlanValidationRecord;
  readonly current: boolean;
  readonly planState: string;
  readonly planVersion: number;
}

/** A model task planned by the INTERPRET step at `stepFence` (registry ModelTask; D8-AUD-3). */
export interface NewModelTask {
  readonly modelTaskId: ModelTaskId;
  readonly auditId: AuditId;
  readonly stepFence: number;
  readonly taskKey: Sha256Hex;
  readonly candidateManifestHash: Sha256Hex;
  readonly policyHash: Sha256Hex;
  readonly minimizedRequestHash: Sha256Hex;
  readonly providerProfileId: Id;
  readonly maximumCostCents: bigint;
}

/** One dispatch intent of a model task: the physical attempt the MODEL_TASK lease's owner reserves before any send. */
export interface DispatchIntent {
  readonly requestId: RequestId;
  readonly ownerId: LeaseOwnerId;
  readonly requestHash: Sha256Hex;
  readonly reservedCents: bigint;
}

/**
 * The answer to a dispatch intent (D8-AUD-3): a response already stored for the task is returned before any new intent
 * (STORED_RESPONSE); an attempt of the lease's current fence is answered as it stands (IN_FLIGHT); another owner's live lease is HELD;
 * otherwise the intent is RESERVED on the audit's grant at the lease's fence.
 */
export type DispatchOutcome =
  | { readonly kind: "STORED_RESPONSE"; readonly request: RequestJournalRecord }
  | { readonly kind: "IN_FLIGHT"; readonly request: RequestJournalRecord; readonly lease: LeaseRecord }
  | { readonly kind: "HELD"; readonly lease: LeaseRecord }
  | { readonly kind: "RESERVED"; readonly request: RequestJournalRecord; readonly lease: LeaseRecord };

/** One event appended to the core's journal of `runId` by the INTERPRET step at `stepFence`, when the journal has `expectedLength`. */
export interface JournalAppend {
  readonly runId: Id;
  readonly auditId: AuditId;
  readonly stepFence: number;
  readonly event: Readonly<Record<string, unknown>>;
  readonly expectedLength: number;
}

/** The shape of @kauro/application's ModelTaskJournalAppendOutcome (a fenced append). */
export type JournalAppendOutcome = { readonly ok: true; readonly length: number } | { readonly ok: false; readonly conflict: "LENGTH_MISMATCH"; readonly actualLength: number };

/** The content-idempotent intake of a decision document (D8-PLAN-1). */
export interface NewDecisionArtifact {
  readonly artifactRef: ArtifactRef;
  readonly agencyId: AgencyId;
  readonly auditId: AuditId;
  readonly kind: DecisionArtifactKind;
  readonly document: Readonly<Record<string, unknown>>;
  readonly createdByMembershipId: MembershipId;
}

/** The stored artifact: created now, or the one already stored for the same document (`created: false`). */
export interface StoredDecisionArtifact {
  readonly artifact: DecisionArtifactRecord;
  readonly created: boolean;
}

/** GRANT_RECONCILIATION's edges of a grant (design §8.1). */
export type GrantEdge = "EXHAUSTED" | "AUTHORIZED" | "EXPIRED" | "CLOSED";

export interface AuditStore {
  // --- reads -------------------------------------------------------------------------------------------------------------------
  getAudit(auditId: AuditId): Promise<AuditRecord | null>;
  /** The audit row under its row lock (FOR UPDATE): the serialization point of CancelAudit and the orchestration's edges. */
  lockAudit(auditId: AuditId): Promise<AuditRecord | null>;
  getGrant(grantId: CostGrantId): Promise<CostGrantRecord | null>;
  stepsOf(auditId: AuditId): Promise<ReadonlyArray<AuditStepRecord>>;
  modelTasksOf(auditId: AuditId): Promise<ReadonlyArray<ModelTaskRecord>>;
  /** The core's journal of `runId`, in append order. */
  journalOf(runId: Id): Promise<ReadonlyArray<ModelTaskJournalEntry>>;
  getDecisionArtifact(artifactRef: ArtifactRef): Promise<DecisionArtifactRecord | null>;
  validationsOf(planId: PlanId): Promise<ReadonlyArray<PlanValidationRecord>>;

  // --- request handlers (CMD020, CMD021, CMD024, the decision-artifact intake) ----------------------------------------------------
  /**
   * CMD020 (D8-GRANT-1): an AUTHORIZED, unexpired platform pool with room for the grant's ceiling, under the pool's row lock; the AUDIT
   * grant born PREPARED and AUTHORIZED (the pool holds its ceiling); the audit born QUEUED with audit.queued.v1 to AUDIT_ORCHESTRATION.
   * Without a funded pool: BUDGET_EXHAUSTED / NO_FUNDED_GRANT with nothing written.
   */
  startAudit(audit: NewAudit): Promise<StartedAudit>;
  /** cancellation_wins at expectedVersion: CANCELLED, the cancellation version + 1, recorded once. */
  cancelAudit(auditId: AuditId, expectedVersion: number, cancellation: AuditCancellation): Promise<VersionedWrite<AuditRecord>>;
  storeDecisionArtifact(artifact: NewDecisionArtifact): Promise<StoredDecisionArtifact>;
  requestValidation(request: ValidationRequest): Promise<VersionedWrite<PlanValidationRecord>>;

  // --- control plane (AUDIT_ORCHESTRATION, PLAN_VALIDATION, AUDIT_DEADLINES, GRANT_RECONCILIATION) ------------------------------------
  /** A step claims the audit's fence + 1 (D8-AUD-2); the first PROFILE claim takes QUEUED -> PROFILING. */
  claimStep(auditId: AuditId, kind: AuditStepKind, stepId: AuditStepId): Promise<StepClaim>;
  /** Records the step's result once, only under the audit's current fence (KA080). */
  recordStep(stepId: AuditStepId, result: StepResult): Promise<AuditStepRecord>;
  advanceAudit(auditId: AuditId, expectedVersion: number, edge: AuditEdge): Promise<VersionedWrite<AuditRecord>>;
  recordSystemDraft(auditId: AuditId, draft: SystemDraft): Promise<SystemDraftRecord>;
  settleValidation(validationId: PlanValidationId, settlement: ValidationSettlement): Promise<ValidationSettled>;
  /** The task of the audit's current INTERPRET step; an existing task of the same key, candidate set and policy is answered as is. */
  createModelTask(task: NewModelTask): Promise<ModelTaskRecord>;
  beginDispatch(modelTaskId: ModelTaskId, dispatch: DispatchIntent): Promise<DispatchOutcome>;
  appendJournal(append: JournalAppend): Promise<JournalAppendOutcome>;
  /** GRANT_RECONCILIATION's edge of a grant at expectedVersion; the database refuses an early expiry and a close over uncertain usage. */
  transitionGrant(grantId: CostGrantId, expectedVersion: number, to: GrantEdge): Promise<VersionedWrite<CostGrantRecord>>;
  /** A request's known usage settled: its reservation leaves the grant's reserved cents and `actualCents` joins its spend. */
  reconcileRequest(requestId: RequestId, actualCents: bigint): Promise<CostGrantRecord>;
}

/**
 * A unit of work of audit authority: the execution unit of work with the audit store on the same connection. It also exposes the
 * source store (the class of every unit of work of this package carries it, B07): CMD020 reads the availability of the revision it
 * audits through it (D8-CMA-9).
 */
export interface AuditUnitOfWork extends ExecutionUnitOfWork, Pick<SourceUnitOfWork, "sources"> {
  readonly audits: AuditStore;
  /** The control plane's discovery reads of audit work (mandate B08-CONTROL-AUDIT, D8-CAU-1). */
  readonly auditDiscovery: AuditDiscovery;
}

export interface AuditUnitOfWorkFactory extends ExecutionUnitOfWorkFactory {
  run<T>(context: ExecutionContext, work: (uow: AuditUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
