/**
 * Safe DTO views (10 "Read endpoints return safe projections ... never serialize these internal records wholesale";
 * reference/FIELD_CONTRACTS.md "Internal records are not automatically safe browser DTOs. Responses must select only
 * authorized fields"). Every view is a hand-picked selection from a domain record plus the version the edit commands need
 * and the permitted actions the caller may take (07 "The handoff to UI includes every state, safe field, permitted action").
 * These interfaces are the compile-time shape; the wire contract is the closed schema of each view in api/response-schemas,
 * which every reply is validated against before it is sent (10 "TypeScript types alone are insufficient runtime validation").
 */
import type { Agency, Approval, EndClient, Membership, Plan, UtcInstant } from "@kauro/contracts";
import type { AgencyCapability, ProjectState, ServiceMode } from "@kauro/domain";
import type { ResourceAction } from "./permitted-actions.js";

export interface AgencyView {
  readonly agencyId: string;
  readonly version: number;
  readonly displayName: string;
  readonly state: Agency["state"];
  readonly termsVersion?: string;
  readonly privacyAgreementVersion?: string;
  readonly createdAt: UtcInstant;
  /** The capabilities of the caller inside this agency (derived from the role, never a browser claim). */
  readonly permittedActions: ReadonlyArray<AgencyCapability>;
}

/** Team information appropriate to the caller: no authentication tokens, recovery settings or security evidence (10). */
export interface MembershipView {
  readonly membershipId: string;
  readonly agencyId: string;
  readonly userId: string;
  readonly role: Membership["role"];
  readonly state: Membership["state"];
  readonly version: number;
  readonly assurancePolicy: string;
  readonly acceptedAt?: UtcInstant;
}

export interface EndClientView {
  readonly clientId: string;
  readonly agencyId: string;
  readonly version: number;
  readonly displayName: string;
  readonly state: EndClient["state"];
  readonly processingAuthorityRef: string;
  readonly createdAt: UtcInstant;
  readonly archivedAt?: UtcInstant;
  /** The served commands the caller may issue on this client (api/permitted-actions; re-check finding N16). */
  readonly permittedActions: ReadonlyArray<ResourceAction>;
}

export const READINESS_BLOCKERS = [
  "AGENCY_NOT_ACTIVE",
  "NO_SEALED_REVISION",
  "TARGET_CONTRACT_MISSING",
  "TARGET_CONTRACT_UNCONFIRMED",
  "PLAN_MISSING",
  "PLAN_NOT_VALIDATED",
  "PLAN_NOT_APPROVED",
  "CAPABILITY_RESTRICTED",
] as const;
export type ReadinessBlocker = (typeof READINESS_BLOCKERS)[number];

export interface ProjectView {
  readonly projectId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly version: number;
  readonly state: ProjectState;
  readonly mode: ServiceMode;
  readonly purpose: string;
  readonly targetInstanceRef?: string;
  readonly capabilityVersion: string;
  readonly currentRevision: { readonly revisionId: string; readonly state: string; readonly version: number };
  /** Visible readiness blockers (CMD011 effect): computed from durable facts at read time, never stored as a flag. */
  readonly readinessBlockers: ReadonlyArray<ReadinessBlocker>;
  readonly createdAt: UtcInstant;
  /** The served commands the caller may issue on this project: none in this edition (api/permitted-actions; N16). */
  readonly permittedActions: ReadonlyArray<ResourceAction>;
}

export interface PlanView {
  readonly planId: string;
  readonly agencyId: string;
  readonly projectId: string;
  readonly version: number;
  readonly state: Plan["state"];
  readonly bodyHash: string;
  readonly revisionHash: string;
  readonly targetContractHash: string;
  readonly policyHash: string;
  readonly validationReceiptHash?: string;
  readonly approvalId?: string;
  readonly supersedesPlanId?: string;
  readonly supersededByPlanId?: string;
  readonly createdAt: UtcInstant;
  /** The served commands the caller may issue on this revision (api/permitted-actions; N16). */
  readonly permittedActions: ReadonlyArray<ResourceAction>;
}

/**
 * Every member of the registry Approval contract, so a consumer recomputes `approvalHash` from the DTO alone
 * (reference/HASHING_AND_ACCOUNTING_RULES: KAURO_PLAN_APPROVAL_V1 over approvalId, actorId, agencyId, planHash, revisionHash,
 * targetContractHash, validationReceiptHash, disclosuresHash and createdAt; "the consumer recomputes the relevant preimage").
 */
export interface ApprovalView {
  readonly approvalId: string;
  /** The approving person's identity reference (registry Approval.actorId, "Authenticated actor with approval capability"). */
  readonly actorId: string;
  readonly agencyId: string;
  readonly planId: string;
  readonly version: number;
  readonly actorMembershipId: string;
  readonly planHash: string;
  readonly revisionHash: string;
  readonly targetContractHash: string;
  readonly validationReceiptHash: string;
  readonly disclosuresHash: string;
  readonly approvalHash: string;
  readonly createdAt: UtcInstant;
  /** Withdrawal (CMD026) — when, by which membership and why; all three or none (approvals_withdrawal_complete). */
  readonly withdrawnAt?: Approval["withdrawnAt"];
  readonly withdrawnByMembershipId?: string;
  readonly withdrawReasonCode?: string;
  /** The served commands the caller may issue on this approval (api/permitted-actions; N16). */
  readonly permittedActions: ReadonlyArray<ResourceAction>;
}

// --- the manual-10 reads (re-check finding N16) ---------------------------------------------------------------------------

/** GET /agencies: one of the caller's actual memberships (ACTIVE or SUSPENDED) with its agency. */
export interface AgencyMembershipView {
  readonly agencyId: string;
  readonly displayName: string;
  readonly state: Agency["state"];
  readonly version: number;
  readonly membershipId: string;
  readonly role: Membership["role"];
  readonly membershipState: Membership["state"];
  /** The caller's capabilities in the agency (none while the membership is SUSPENDED). */
  readonly permittedActions: ReadonlyArray<AgencyCapability>;
}

/**
 * GET /agencies/{agencyId}/members: a teammate as the caller may see it. A caller who manages the team (MANAGE_TEAM) sees every
 * membership with its lifecycle times; any other member sees the ACTIVE team's roles. Never an identity reference of another
 * person, an authentication fact, a token or security evidence (10 "Agency and team routes").
 */
export interface TeamMemberView {
  readonly membershipId: string;
  readonly role: Membership["role"];
  readonly state: Membership["state"];
  readonly version: number;
  /** Whether this is the caller's own membership. */
  readonly self: boolean;
  readonly createdAt?: UtcInstant;
  readonly acceptedAt?: UtcInstant;
}

/** A page of a list read: at most the page size, and the cursor of the next page when there may be one. */
export interface Page<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly nextCursor?: string;
}
