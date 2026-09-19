/**
 * Safe DTO views (10 "Read endpoints return safe projections ... never serialize these internal records wholesale";
 * reference/FIELD_CONTRACTS.md "Internal records are not automatically safe browser DTOs. Responses must select only
 * authorized fields"). Every view is a hand-picked selection from a domain record plus the version the edit commands need
 * and the permitted actions the caller may take (07 "The handoff to UI includes every state, safe field, permitted action").
 */
import type { Agency, Approval, EndClient, Membership, Plan, UtcInstant } from "@kauro/contracts";
import type { AgencyCapability, ProjectState, ServiceMode } from "@kauro/domain";

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
}

export interface ApprovalView {
  readonly approvalId: string;
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
  readonly withdrawnAt?: Approval["withdrawnAt"];
  readonly withdrawReasonCode?: string;
}
