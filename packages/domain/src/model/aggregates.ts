/**
 * Aggregate records as the domain sees them (07 "Aggregate ownership"; registry contracts Agency, Membership, EndClient, Plan,
 * Approval, Capability, DatasetRevision, TargetContract, ValidationReceipt). A record is the registry contract plus the columns
 * the platform needs for concurrency and lineage; the wire DTOs in @kauro/application select from these, never the reverse.
 * Project is not a registry contract (07 names the aggregate; no field contract exists) — decision D-AGG-1 fixes its shape.
 */
import type { Agency, Approval, Capability, DatasetRevision, EndClient, Membership, Plan, Sha256Hex, SupportCase, TargetContract, UtcInstant, ValidationReceipt } from "@kauro/contracts";
import type {
  AgencyId,
  ApprovalId,
  AssuranceProofId,
  CapabilityId,
  ClientId,
  InvitationId,
  MembershipId,
  PlanId,
  ProcessingAuthorityId,
  ProjectId,
  RevisionId,
  SupportCaseId,
  TargetContractId,
  TargetInstanceRef,
  UserId,
  ValidationReceiptId,
} from "./ids.js";

export interface AgencyRecord extends Agency {
  readonly agencyId: AgencyId;
  readonly createdByUserId: UserId;
  readonly updatedAt: UtcInstant;
}

export interface MembershipRecord extends Membership {
  readonly membershipId: MembershipId;
  readonly agencyId: AgencyId;
  readonly userId: UserId;
  readonly createdAt: UtcInstant;
  readonly revokedAt?: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/**
 * The envelope of a single-use invitation token (08 "Invitation, recovery and ownership transfer": one-use, time-limited
 * opaque tokens, stored hashed; the invite records agency, intended identity, role and expiry). The membership row in state
 * INVITED is the invitation; this record is its token envelope (table kauro.membership_invitations). The raw token never
 * enters the domain: only its SHA-256 does.
 */
export interface InvitationRecord {
  readonly invitationId: InvitationId;
  readonly agencyId: AgencyId;
  readonly membershipId: MembershipId;
  readonly tokenHash: Sha256Hex;
  readonly role: Membership["role"];
  readonly invitedByMembershipId: MembershipId;
  readonly expiresAt: UtcInstant;
  readonly consumedAt?: UtcInstant;
  readonly revokedAt?: UtcInstant;
  readonly createdAt: UtcInstant;
}

/** Agency evidence of authority to provide an end client's data (EndClient.processingAuthorityRef; 02 §2). */
/**
 * The end-client processing authority an agency recorded (CMD009 "records the end-client processing authority"): the
 * agency's evidence reference (the id EndClient.processingAuthorityRef names), who recorded it and when (decision D-CLIENT-1).
 */
export interface ProcessingAuthorityRecord {
  readonly processingAuthorityId: ProcessingAuthorityId;
  readonly agencyId: AgencyId;
  readonly recordedByMembershipId: MembershipId;
  readonly recordedAt: UtcInstant;
}

/** EndClient plus the optimistic version CMD010 names (decision D-AGG-2). */
export interface EndClientRecord extends EndClient {
  readonly clientId: ClientId;
  readonly agencyId: AgencyId;
  readonly processingAuthorityRef: ProcessingAuthorityId;
  readonly version: number;
  readonly createdByMembershipId: MembershipId;
  readonly archivedAt?: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export type ServiceMode = "CLEAN" | "HUBSPOT" | "SALESFORCE";
export const SERVICE_MODES: ReadonlyArray<ServiceMode> = ["CLEAN", "HUBSPOT", "SALESFORCE"];

/** Project states (decision D-AGG-1): OPEN until a later package closes, requests deletion of, or deletes the project. */
export type ProjectState = "OPEN" | "CLOSED" | "DELETION_REQUESTED" | "DELETED";
export const PROJECT_STATES: ReadonlyArray<ProjectState> = ["OPEN", "CLOSED", "DELETION_REQUESTED", "DELETED"];

export interface ProjectRecord {
  readonly projectId: ProjectId;
  readonly agencyId: AgencyId;
  readonly clientId: ClientId;
  readonly version: number;
  readonly state: ProjectState;
  readonly mode: ServiceMode;
  readonly purpose: string;
  /** Declared target scope; declaring it claims no qualification (CMD011 precondition). Absent for CLEAN. */
  readonly targetInstanceRef?: TargetInstanceRef;
  /** The mode capability consumed at creation (Capability.capabilityId / version), the "offered" evidence. */
  readonly capabilityId: CapabilityId;
  readonly capabilityVersion: string;
  readonly currentRevisionId: RevisionId;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** The registry SupportCase vocabularies (owner manual 18); CMD044 (B11) opens a case, it never takes any of these from the request but the category. */
export type SupportCategory = SupportCase["category"];
export type SupportSeverity = SupportCase["severity"];
export type SupportCaseState = SupportCase["state"];
export const SUPPORT_CATEGORIES: ReadonlyArray<SupportCategory> = ["PRODUCT_DEFECT", "IMPORT_GUIDANCE", "BILLING", "PRIVACY", "SECURITY", "GENERAL"];
export const SUPPORT_SEVERITIES: ReadonlyArray<SupportSeverity> = ["S1", "S2", "S3", "S4"];
export const SUPPORT_CASE_STATES: ReadonlyArray<SupportCaseState> = ["OPEN", "TRIAGED", "WAITING_KAURO", "WAITING_AGENCY", "RESOLVED", "CLOSED"];

/**
 * A support case: the registry SupportCase contract with the platform columns (migration 0009, D-SUP-6). The case always names a
 * project of its agency (the registry field is optional; agency-level cases have no catalogue command, Q-B11-1) and is born OPEN.
 */
export interface SupportCaseRecord extends Omit<SupportCase, "caseId" | "agencyId" | "projectId" | "evidenceRefs"> {
  readonly caseId: SupportCaseId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly createdByUserId: UserId;
  readonly createdByMembershipId: MembershipId;
  readonly version: number;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** Identity of a source revision as B06 needs it; the lifecycle (uploads, sealing) belongs to B07. */
export interface DatasetRevisionRecord extends Omit<DatasetRevision, "manifestHash" | "projectionHash" | "files"> {
  readonly revisionId: RevisionId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly manifestHash?: Sha256Hex;
  readonly projectionHash?: Sha256Hex;
  readonly supersedesRevisionId?: RevisionId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** Identity and bindings of a target contract as CMD025 needs them (TargetContract lifecycle belongs to B08). */
export interface TargetContractRecord extends Omit<TargetContract, "objects"> {
  readonly contractId: TargetContractId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly supersededAt?: UtcInstant;
}

/** A plan revision row: the registry Plan minus its body lists (stored as the closed `body` artifact) plus lineage. */
export interface PlanRecord extends Omit<Plan, "mappings" | "identities" | "transforms" | "relationships"> {
  readonly planId: PlanId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly supersedesPlanId?: PlanId;
  readonly supersededByPlanId?: PlanId;
  /** Hash of the current complete validation receipt bound to this body (VALIDATED/APPROVED only). */
  readonly validationReceiptHash?: Sha256Hex;
  readonly approvalId?: ApprovalId;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** The closed semantic body of a plan (Plan.mappings/identities/transforms/relationships) hashed under KAURO_PLAN_BODY_V1. */
export type PlanBody = Pick<Plan, "revisionHash" | "targetContractHash" | "policyHash" | "mappings" | "identities" | "transforms" | "relationships">;

export interface ValidationReceiptRecord extends ValidationReceipt {
  readonly receiptId: ValidationReceiptId;
  readonly agencyId: AgencyId;
  readonly planId: PlanId;
  readonly receiptHash: Sha256Hex;
}

export interface ApprovalRecord extends Approval {
  readonly approvalId: ApprovalId;
  readonly agencyId: AgencyId;
  readonly planId: PlanId;
  readonly actorMembershipId: MembershipId;
  /** Membership version at approval time (07 "PlanApproval records actor identity, membership version, assurance evidence"). */
  readonly actorMembershipVersion: number;
  readonly assuranceProofRef: AssuranceProofId;
  readonly approvalHash: Sha256Hex;
  readonly version: number;
  readonly withdrawnByMembershipId?: MembershipId;
  readonly withdrawReasonCode?: string;
}

export interface CapabilityRecord extends Capability {
  readonly capabilityId: CapabilityId;
  readonly kind: "MODE" | "OBJECT" | "OPERATION" | "TOOL" | "ENVELOPE";
  readonly mode?: ServiceMode;
}

/** Capability states that admit real customers (02 "Capability publication contract"). */
export const OFFERED_CAPABILITY_STATES: ReadonlySet<Capability["state"]> = new Set<Capability["state"]>(["AVAILABLE_LIMITED", "AVAILABLE"]);

export function isOffered(capability: Capability): boolean {
  return OFFERED_CAPABILITY_STATES.has(capability.state);
}

/** Agency states that permit setup work such as creating clients and projects (decision D-CMD-2). */
export const AGENCY_OPEN_STATES: ReadonlySet<Agency["state"]> = new Set<Agency["state"]>(["DRAFT", "ACTIVE"]);
