/**
 * What lane L-AUTH's handlers run on (package B12; docs/design/B12-outreach-plan.md §L, §2): the unit-of-work accessor of the review, grant,
 * revocation and policy-withdrawal SQL (@kauro/persistence PgOutreachAuth, bound by the composition as `outreachAuthOf`), the commercial
 * authorizer (the corporate owner's ACTIVE grant, read after its L1 lock) and B06's step-up verifier. The store's lock methods take the
 * advisory subjects of a trace in the one global order; its writers refuse to run before the subjects 0072's T2 asserts are held.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { OutreachPurpose, SenderRoute, SenderState, UnitOfWork } from "@kauro/domain";
import type { AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { CommercialAuthorizer } from "../authorizer.js";

export interface AuthSenderRecord {
  readonly senderId: string;
  readonly state: SenderState;
  readonly route: SenderRoute;
}
export interface AuthDraftRecord {
  readonly draftId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly state: string;
  readonly senderId: string;
  readonly purpose: OutreachPurpose;
  readonly contactLabel: string | null;
  readonly policyInForce: boolean;
  readonly complianceConfigured: boolean;
}
export interface AuthReviewItem {
  readonly draftId: string;
  readonly draftVersion: number;
  readonly contentHash: string;
  readonly contactLabel: string;
}
export interface AuthReviewRecord {
  readonly reviewId: string;
  readonly ownerUserId: string;
  readonly proofId: string;
  readonly senderId: string;
  readonly digest: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly items: ReadonlyArray<AuthReviewItem>;
}
export interface AuthGrantFacts {
  readonly reviewLive: boolean;
  readonly reviewConsumed: boolean;
  readonly windowOk: boolean;
  readonly judgedAt: UtcInstant;
  readonly sender: AuthSenderRecord | null;
  readonly drafts: ReadonlyArray<AuthDraftRecord>;
  readonly resourcesNotCurrent: number;
  readonly capabilitiesRestricted: number;
}
export interface AuthGrantRecord {
  readonly authorizationId: string;
  readonly reviewId: string;
  readonly grantingUserId: string;
  readonly senderId: string;
  readonly validFrom: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly maximumSends: number;
  readonly permissionEvidenceHash: string;
  readonly policyVersion: string;
  readonly revoked: boolean;
  readonly allowedContentHashes: ReadonlyArray<string>;
}
export interface AuthPolicyRecord {
  readonly jurisdiction: string;
  readonly purpose: OutreachPurpose;
  readonly version: number;
  readonly state: "IN_FORCE" | "WITHDRAWN";
}

/** The SQL of lane L-AUTH on the unit of work's own connection (one instance, one lock order, per unit of work). */
export interface OutreachAuthStore {
  senderOf(senderId: string): Promise<AuthSenderRecord | null>;
  lockDraftsShared(draftIds: ReadonlyArray<string>): Promise<void>;
  draftsOf(draftIds: ReadonlyArray<string>): Promise<ReadonlyArray<AuthDraftRecord>>;
  issueReview(r: {
    readonly reviewId: string;
    readonly ownerUserId: string;
    readonly proofId: string;
    readonly senderId: string;
    readonly digest: string;
    readonly items: ReadonlyArray<AuthReviewItem>;
  }): Promise<{ readonly issuedAt: UtcInstant; readonly expiresAt: UtcInstant }>;
  reviewById(reviewId: string): Promise<AuthReviewRecord | null>;
  reviewByDigest(digest: string): Promise<AuthReviewRecord | null>;
  lockGrantSet(draftIds: ReadonlyArray<string>, senderId: string): Promise<void>;
  grantFacts(q: { readonly reviewId: string; readonly draftIds: ReadonlyArray<string>; readonly senderId: string; readonly validFrom: string; readonly expiresAt: string }): Promise<AuthGrantFacts>;
  insertGrant(g: {
    readonly authorizationId: string;
    readonly reviewId: string;
    readonly grantingUserId: string;
    readonly senderId: string;
    readonly proofId: string;
    readonly validFrom: string;
    readonly expiresAt: string;
    readonly maximumSends: number;
    readonly permissionEvidenceHash: string;
    readonly policyVersion: string;
    readonly seals: ReadonlyArray<{ readonly draftId: string; readonly contentHash: string }>;
  }): Promise<AuthGrantRecord>;
  lockGrant(authorizationId: string): Promise<void>;
  authorizationById(authorizationId: string): Promise<AuthGrantRecord | null>;
  revokeGrant(authorizationId: string, byUserId: string): Promise<boolean>;
  lockPolicy(jurisdiction: string, purpose: string): Promise<void>;
  latestPolicy(jurisdiction: string, purpose: string): Promise<AuthPolicyRecord | null>;
  withdrawPolicy(p: { readonly jurisdiction: string; readonly purpose: string; readonly version: number; readonly byUserId: string }): Promise<boolean>;
}

/** The collaborators of CMD062, PrepareOutreachReview, GetOutreachReview, RevokeOutreachAuthorization and WithdrawOutreachChannelPolicy. */
export interface OutreachAuthCollaborators {
  readonly store: (uow: UnitOfWork) => OutreachAuthStore;
  readonly authorizer: CommercialAuthorizer;
  /** B06's step-up verifier (08): the owner's assuranceProofRef. */
  readonly assurance: AssuranceVerifier;
}
