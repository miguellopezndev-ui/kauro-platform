/**
 * The durable records of audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §8.1,
 * §9; registry contracts Audit, CostGrant, ModelTask, ValidationReceipt): what the adapters of migration 0021 read and write. Instants
 * are the server's (kauro.server_now(), D8-CLOCK-1): every lifecycle instant and deadline below is stamped by the database, never
 * supplied by a writer. Money is BIGINT cents (07 "Database representation"), read as bigint like package B09's.
 */
import type { Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, ArtifactRef, MembershipId, PlanId, ProjectId, RevisionId, TargetContractId } from "../ids.js";
import type { CancellationActor } from "../execution/records.js";
import type { AuditId, AuditStepId, CostGrantId, ModelTaskId, PlanValidationId } from "./ids.js";

// --- the cost grant -----------------------------------------------------------------------------------------------------------

/** Registry CostGrant.state. */
export const COST_GRANT_STATES = ["PREPARED", "AUTHORIZED", "EXHAUSTED", "EXPIRED", "CLOSED"] as const;
export type CostGrantState = (typeof COST_GRANT_STATES)[number];

/**
 * What a grant funds (D8-GRANT-1): the platform's monthly model pool (no agency; funded by the owner's operations act, Q8-1) or a free
 * AUDIT grant of one agency carved from it by StartAudit, whose whole ceiling the pool holds while it lives.
 */
export const COST_GRANT_KINDS = ["PLATFORM_MONTHLY", "AUDIT"] as const;
export type CostGrantKind = (typeof COST_GRANT_KINDS)[number];

export interface CostGrantRecord {
  readonly grantId: CostGrantId;
  /** The agency of an AUDIT grant; absent for the platform's pool. */
  readonly agencyId?: AgencyId;
  readonly kind: CostGrantKind;
  /** The pool an AUDIT grant is carved from (and authorized by). */
  readonly poolGrantId?: CostGrantId;
  readonly currency: "USD";
  /** Total authorized maximum liability. */
  readonly ceilingCents: bigint;
  /** Possible in-flight liability: dispatch intents not reconciled yet and, on a pool, the ceilings of its live AUDIT grants. */
  readonly reservedCents: bigint;
  /** Known consumption under the actual tariff. */
  readonly reconciledSpendCents: bigint;
  readonly priceProfileHash: Sha256Hex;
  /** The funding evidence: the owner's authorization of a pool, the pool itself for an AUDIT grant (absent while PREPARED). */
  readonly authorizationRef?: Id;
  /** No new spend at or after it: the pool's statement; an AUDIT grant's is its audit's window (never past its pool's). */
  readonly expiresAt: UtcInstant;
  readonly state: CostGrantState;
  readonly version: number;
  readonly authorizedAt?: UtcInstant;
  readonly expiredAt?: UtcInstant;
  readonly closedAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

// --- the audit -----------------------------------------------------------------------------------------------------------------

/** Registry Audit.state ("Durable visible phase"). */
export const AUDIT_STATES = ["QUEUED", "PROFILING", "INTERPRETING", "VALIDATING", "DRAFT_READY", "NEEDS_DECISION", "UNSUPPORTED", "FAILED", "CANCELLED", "EXPIRED"] as const;
export type AuditState = (typeof AUDIT_STATES)[number];
export const LIVE_AUDIT_STATES: ReadonlyArray<AuditState> = Object.freeze(["QUEUED", "PROFILING", "INTERPRETING", "VALIDATING"]);
export const TERMINAL_AUDIT_STATES: ReadonlyArray<AuditState> = Object.freeze(["DRAFT_READY", "NEEDS_DECISION", "UNSUPPORTED", "FAILED", "CANCELLED", "EXPIRED"]);

export interface AuditRecord {
  readonly auditId: AuditId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  /** The sealed revision's manifest hash (KAURO_SOURCE_REVISION_V1). */
  readonly revisionHash: Sha256Hex;
  readonly targetContractId: TargetContractId;
  /** The confirmed target contract's body hash (KAURO_TARGET_BODY_V1). */
  readonly targetContractHash: Sha256Hex;
  readonly auditPolicyVersion: string;
  /** The operator who started it: the creator of its system draft plan. */
  readonly requestedByMembershipId: MembershipId;
  readonly grantId: CostGrantId;
  readonly state: AuditState;
  readonly version: number;
  /** The fence of the audit's current step (0 before its first claim; D8-AUD-2). */
  readonly fence: number;
  readonly cancelVersion: number;
  readonly cancelActor?: CancellationActor;
  /** Original logical start. */
  readonly startedAt: UtcInstant;
  /** startedAt + auditAbsoluteSeconds: no successful finalization at or after it. */
  readonly absoluteDeadlineAt: UtcInstant;
  /** First INTERPRETING + interpretationSeconds (never past the absolute deadline), set once: no new semantic dispatch afterwards. */
  readonly interpretationDeadlineAt?: UtcInstant;
  readonly profileEvidenceHash?: Sha256Hex;
  /** Complete expected candidate set after planning. */
  readonly candidateManifestHash?: Sha256Hex;
  /** The system draft plan a DRAFT_READY audit publishes (D8-AUD-4). */
  readonly draftPlanId?: PlanId;
  /** The pending decisions of NEEDS_DECISION, or the unsupported capabilities of UNSUPPORTED (tokens). */
  readonly findingCodes: ReadonlyArray<string>;
  /** The classified cause of FAILED, EXPIRED or CANCELLED (a token). */
  readonly terminalReason?: string;
  readonly profilingAt?: UtcInstant;
  readonly interpretingAt?: UtcInstant;
  readonly validatingAt?: UtcInstant;
  readonly terminalAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

// --- the steps -----------------------------------------------------------------------------------------------------------------

export const AUDIT_STEP_KINDS = ["PROFILE", "INTERPRET", "VALIDATE"] as const;
export type AuditStepKind = (typeof AUDIT_STEP_KINDS)[number];

/** What each step may record (design §3): the outcome decides the audit's next edge. */
export const AUDIT_STEP_OUTCOMES = Object.freeze({
  PROFILE: ["COMPLETED", "FAILED"],
  INTERPRET: ["COMPILED", "NEEDS_DECISION", "UNSUPPORTED", "FAILED"],
  VALIDATE: ["VALID", "NEEDS_DECISION", "FAILED"],
} as const);
export type AuditStepOutcome = (typeof AUDIT_STEP_OUTCOMES)[AuditStepKind][number];

export interface AuditStepRecord {
  readonly stepId: AuditStepId;
  readonly agencyId: AgencyId;
  readonly auditId: AuditId;
  readonly kind: AuditStepKind;
  /** The audit's fence this step claimed (audits.fence + 1 at its claim). */
  readonly fence: number;
  readonly claimedAt: UtcInstant;
  readonly outcome?: AuditStepOutcome;
  readonly evidenceHash?: Sha256Hex;
  readonly evidenceClass?: "EXECUTED_LOCAL" | "SIMULATED";
  readonly recordedAt?: UtcInstant;
}

// --- model tasks and their journal ---------------------------------------------------------------------------------------------

export interface ModelTaskRecord {
  readonly modelTaskId: ModelTaskId;
  readonly agencyId: AgencyId;
  readonly auditId: AuditId;
  /** The audit's AUDIT grant: every dispatch intent of the task reserves on it (D8-GRANT-2). */
  readonly grantId: CostGrantId;
  /** The fence of the INTERPRET step that planned it. */
  readonly stepFence: number;
  /** The core's stable identity of the task within the audit (with the candidate set and policy, its idempotency identity). */
  readonly taskKey: Sha256Hex;
  readonly candidateManifestHash: Sha256Hex;
  readonly policyHash: Sha256Hex;
  readonly minimizedRequestHash: Sha256Hex;
  readonly providerProfileId: Id;
  /** Conservative worst-case reservation of one dispatch. */
  readonly maximumCostCents: bigint;
  readonly interpretationDeadlineAt: UtcInstant;
  readonly auditDeadlineAt: UtcInstant;
  readonly createdAt: UtcInstant;
}

/** One event of the core's fenced journal (ModelTaskJournalPort), opaque to the platform. */
export interface ModelTaskJournalEntry {
  readonly runId: Id;
  readonly position: number;
  readonly auditId: AuditId;
  readonly stepFence: number;
  readonly event: Readonly<Record<string, unknown>>;
  readonly eventHash: Sha256Hex;
  readonly appendedAt: UtcInstant;
}

// --- decision artifacts and validation intents -----------------------------------------------------------------------------------

/** CMD022's candidate decisions over an audit's candidates, CMD023's typed decision patch (D8-PLAN-1). */
export const DECISION_ARTIFACT_KINDS = ["CANDIDATE_DECISIONS", "DECISION_PATCH"] as const;
export type DecisionArtifactKind = (typeof DECISION_ARTIFACT_KINDS)[number];

export interface DecisionArtifactRecord {
  readonly artifactRef: ArtifactRef;
  readonly agencyId: AgencyId;
  readonly auditId: AuditId;
  readonly kind: DecisionArtifactKind;
  /** The closed decision document, as the intake stored it. */
  readonly document: Readonly<Record<string, unknown>>;
  /** KAURO_DECISION_ARTIFACT_V1 over (kind, document): the artifact's content identity. */
  readonly contentHash: Sha256Hex;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
}

/** Who asked for a validation: an operator's CMD024, or an audit's system draft (D8-PLAN-2). */
export const PLAN_VALIDATION_ORIGINS = ["COMMAND", "AUDIT"] as const;
export type PlanValidationOrigin = (typeof PLAN_VALIDATION_ORIGINS)[number];
/** The receipt result an intent settles with (registry ValidationReceipt.result). */
export const PLAN_VALIDATION_RESULTS = ["VALID", "INVALID", "CANCELLED", "ERROR"] as const;
export type PlanValidationResult = (typeof PLAN_VALIDATION_RESULTS)[number];

export interface PlanValidationRecord {
  readonly validationId: PlanValidationId;
  readonly agencyId: AgencyId;
  readonly planId: PlanId;
  readonly planHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  /** The plan's n-th intent: only the latest moves the plan. */
  readonly fence: number;
  readonly origin: PlanValidationOrigin;
  readonly requestedByMembershipId?: MembershipId;
  readonly auditId?: AuditId;
  readonly requestedAt: UtcInstant;
  readonly result?: PlanValidationResult;
  readonly receiptHash?: Sha256Hex;
  readonly settledAt?: UtcInstant;
}
