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
import type { AuditState, CostGrantState, DecisionArtifactKind } from "@kauro/domain";

/** The operations a caller may issue on an audit (informative, never authority; B06 D-PERM-1). */
export const AUDIT_RESOURCE_ACTIONS = ["CancelAudit", "CreatePlan"] as const;
export type AuditResourceAction = (typeof AUDIT_RESOURCE_ACTIONS)[number];

/** How the audit's grant is classified for the customer: every audit of this edition runs on a free AUDIT grant carved from the platform's pool. */
export const AUDIT_GRANT_CLASSES = ["FREE_AUDIT"] as const;
export type AuditGrantClass = (typeof AUDIT_GRANT_CLASSES)[number];

export interface AuditView {
  readonly auditId: string;
  readonly revisionId: string;
  readonly targetContractId: string;
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
