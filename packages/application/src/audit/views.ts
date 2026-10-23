/**
 * The safe DTOs of the audit package (B08; docs/design/B08-audit-approval-jobs.md §12, D8-API-1; 10 "Responses and safe errors": never
 * a provider identity, a prompt or a customer value). They are the TypeScript shapes of the closed AuditView and
 * DecisionArtifactIntakeView schemas of audit/response-views (the first derived from the registry Audit contract); a test keeps the
 * two member for member.
 *
 * The audit's phase, its deadlines, its grant's classification and its pending decisions are what a member sees. The revision and target
 * hashes, the requesting membership, the profile evidence, the steps, the model tasks and the pool the grant was carved from stay with
 * the control plane: the view names the sealed source and the target by id only.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AuditState, CostGrantState, DecisionArtifactKind, ImportStageState, ReceiptResult, ServiceMode, TargetContractState } from "@kauro/domain";

/** The operations a caller may issue on an audit (informative, never authority; B06 D-PERM-1). */
export const AUDIT_RESOURCE_ACTIONS = ["CancelAudit", "CreatePlan"] as const;
export type AuditResourceAction = (typeof AUDIT_RESOURCE_ACTIONS)[number];

/** How the audit's grant is classified for the customer: every audit of this edition runs on a free AUDIT grant carved from the platform's pool. */
export const AUDIT_GRANT_CLASSES = ["FREE_AUDIT"] as const;
export type AuditGrantClass = (typeof AUDIT_GRANT_CLASSES)[number];

/** The operations a caller may issue on a target contract (informative, never authority; B06 D-PERM-1). */
export const TARGET_CONTRACT_ACTIONS = ["ConfirmTargetContract"] as const;
export type TargetContractAction = (typeof TARGET_CONTRACT_ACTIONS)[number];

/**
 * A target contract version (B17: CMD018's answer and CMD019's): its bindings and its digest, never its metadata body (the objects stay
 * in the contract; the confirming actor is shown the body and its digest, and confirms exactly that digest).
 */
export interface TargetContractView {
  readonly contractId: string;
  readonly projectId: string;
  readonly mode: ServiceMode;
  readonly instanceId: string;
  readonly importerProfileId: string;
  readonly importerVersion: string;
  readonly bodyHash: string;
  readonly observedAt: UtcInstant;
  readonly confirmedAt?: UtcInstant;
  readonly authorityEvidenceHash: string;
  readonly capabilityVersion: string;
  readonly version: number;
  readonly state: TargetContractState;
  readonly objectCount: number;
  /**
   * What this confirmation superseded (R2-026, decision D-R3-1): every current contract of the project, each with its instant. Present on a
   * confirmation that superseded at least one contract, with the re-check plan ids and the paths the agency keeps.
   */
  readonly supersedes?: ReadonlyArray<{ readonly contractId: string; readonly supersededAt: UtcInstant }>;
  /** One re-check plan per APPROVED plan bound to a superseded contract, born VALIDATION_REQUIRED; its approval is never automatic. */
  readonly recheckPlanIds?: ReadonlyArray<string>;
  /** The paths a paid scope keeps after a supersession: REPAIR (re-bind through the re-check plan), REQUEST_REFUND, NEW_SCOPE. */
  readonly includedPaths?: ReadonlyArray<TargetDriftPath>;
  readonly permittedActions: ReadonlyArray<TargetContractAction>;
}

/** The paths a paid scope keeps after its target was superseded (R2-026): never an automatic survival of the approval. */
export const TARGET_DRIFT_PATHS = ["REPAIR", "REQUEST_REFUND", "NEW_SCOPE"] as const;
export type TargetDriftPath = (typeof TARGET_DRIFT_PATHS)[number];

export interface AuditView {
  readonly auditId: string;
  readonly revisionId: string;
  /** Absent for a CLEAN audit under the candidate activation (CP-02.01); the in-force view always carries it. */
  readonly targetContractId?: string;
  readonly state: AuditState;
  readonly version: number;
  readonly startedAt: UtcInstant;
  /** Stamped once the audit reaches INTERPRETING (first INTERPRETING plus the interpretation window): absent before, kept afterwards. */
  readonly interpretationDeadlineAt?: UtcInstant;
  /** No successful finalization at or after it (the start plus the absolute window). */
  readonly absoluteDeadline: UtcInstant;
  readonly grantId: string;
  readonly grantClass: AuditGrantClass;
  readonly grantState: CostGrantState;
  /** The complete expected candidate set, once planned. */
  readonly candidateManifestHash?: string;
  /** How many cancellations the audit recorded (CMD021 moves it once). */
  readonly cancelVersion: number;
  /** The decisions the customer owes, as stable finding codes (NEEDS_DECISION only). */
  readonly pendingDecisions?: ReadonlyArray<string>;
  /** The capabilities the audit could not plan, as stable finding codes (UNSUPPORTED only). */
  readonly unsupportedCapabilities?: ReadonlyArray<string>;
  /** The classified cause of a FAILED, EXPIRED or CANCELLED audit. */
  readonly terminalReason?: string;
  /** The system draft plan of a DRAFT_READY audit. */
  readonly draftPlanId?: string;
  readonly permittedActions: ReadonlyArray<AuditResourceAction>;
}

/** What the decision-artifact intake answers: the artifact's reference and content identity, and whether this call stored it. */
export interface DecisionArtifactIntakeView {
  readonly artifactRef: string;
  readonly auditId: string;
  readonly kind: DecisionArtifactKind;
  readonly contentHash: string;
  readonly created: boolean;
}

/** The operations a caller may issue on an import stage (informative, never authority; B06 D-PERM-1). */
export const IMPORT_STAGE_ACTIONS = ["SubmitStageReceipt", "ContinueStage"] as const;
export type ImportStageAction = (typeof IMPORT_STAGE_ACTIONS)[number];

/**
 * An import stage (B17: CMD040's answer and CMD041's): its dependency order, target object and operation, state, exact package and
 * deadline, and the summary of its latest validated receipt (the digest of the identity mapping and the counts). The stage's source
 * identities and the receipt's source-to-target mapping stay in the stage and the receipt, never in the view.
 */
export interface ImportStageView {
  readonly stageId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly objectApiName: string;
  readonly operation: "CREATE_ONLY" | "UPDATE_ONLY" | "UPSERT" | "ASSOCIATION_ONLY";
  readonly state: ImportStageState;
  readonly parentStageIds: ReadonlyArray<string>;
  readonly packageHash: string;
  readonly receiptRequired: boolean;
  readonly expiresAt: UtcInstant;
  readonly version: number;
  readonly receiptRevision?: number;
  readonly receiptResult?: ReceiptResult;
  readonly identityMappingHash?: string;
  readonly matchedRows?: number;
  readonly failedRows?: number;
  readonly unresolvedRows?: number;
  readonly continuedAt?: UtcInstant;
  /** The reconciliation request a differing receipt for the finalized stage opened (R2-025); the stage's identity is unchanged. */
  readonly reconciliation?: ImportStageReconciliationView;
  readonly permittedActions: ReadonlyArray<ImportStageAction>;
}

export interface ImportStageReconciliationView {
  readonly reconciliationId: string;
  readonly state: "OPEN";
  readonly contentHash: string;
  readonly openedAt: UtcInstant;
}
