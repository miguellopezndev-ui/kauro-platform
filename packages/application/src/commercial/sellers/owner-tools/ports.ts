/**
 * The port of the owner tools (lane L-OWNER; plan companion §P): the locks, reads and writes the handlers run on, bound by a deployment
 * to @kauro/persistence ownerToolsOf(uow) (PgOwnerToolStore, which satisfies this interface structurally). Every instant a write records
 * and every clock guard a read answers (the cooling period, an agreement in force, a claim's window) is the database's own.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { UnitOfWork } from "@kauro/domain";
import type { AssuranceVerifier } from "../../../ports/assurance-and-admission.js";
import type { CommercialAuthorizer } from "../../authorizer.js";

export type OwnerToolSellerState = "CANDIDATE" | "ACTIVE" | "SUSPENDED" | "TERMINATED";

export interface OwnerToolSeller {
  readonly sellerId: string;
  readonly userId: string;
  readonly state: OwnerToolSellerState;
  readonly version: number;
}

export interface OwnerToolAgreement {
  readonly agreementId: string;
  readonly sellerId: string;
  readonly agreementVersion: string;
  readonly signedTermsHash: string;
  readonly firstBps: number;
  readonly repeatBps: number;
  readonly version: number;
  readonly signedAt?: UtcInstant;
  readonly createdAt: UtcInstant;
}

export type PayoutDestinationState = "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "SUPERSEDED";

export interface OwnerToolDestination {
  readonly destinationId: string;
  readonly sellerId: string;
  readonly destinationVersion: number;
  readonly version: number;
  readonly state: PayoutDestinationState;
  readonly maskedLabel: string;
  readonly currency: "USD" | "COP";
  readonly changedByUserId: string;
  readonly changeProofCarried: boolean;
  readonly coolingPassed: boolean;
  readonly superseded: boolean;
  readonly changedAt: UtcInstant;
  readonly verifiableFrom: UtcInstant;
  readonly verifiedAt?: UtcInstant;
  readonly rejectedAt?: UtcInstant;
}

export interface OwnerToolRecord {
  readonly recordId: string;
  readonly sellerId: string;
  readonly recordedAt: UtcInstant;
}

export interface ShareClaim {
  readonly claimId: string;
  readonly sellerId: string;
  readonly state: string;
  readonly agreementId: string;
  readonly agreementVersion: string;
  readonly firstBps: number;
  readonly repeatBps: number;
  readonly agreementInForce: boolean;
}

export interface OwnerToolStore {
  lockSeller(sellerId: string): Promise<OwnerToolSeller | null>;
  holdOwnSeller(sellerId: string): Promise<OwnerToolSeller | null>;
  sellerFacts(sellerId: string): Promise<OwnerToolSeller | null>;
  lockProspectClaims(prospectIds: ReadonlyArray<string>): Promise<void>;
  lockIdentity(userId: string): Promise<void>;
  identityExists(userId: string): Promise<boolean>;
  sellerOfIdentity(userId: string): Promise<string | null>;
  legalReview(sellerId: string, reviewId: string): Promise<{ readonly classification: string; readonly outcome: string } | null>;
  agreementVersionTaken(sellerId: string, agreementVersion: string): Promise<boolean>;
  agreement(agreementId: string, lock: boolean): Promise<OwnerToolAgreement | null>;
  latestDestination(sellerId: string): Promise<OwnerToolDestination | null>;
  sellerOfDestination(destinationId: string): Promise<string | null>;
  lockDestination(destinationId: string): Promise<OwnerToolDestination | null>;
  agencyExists(agencyId: string): Promise<boolean>;
  assistanceAgreementExists(agencyId: string, assistanceAgreementId: string, sellerId: string): Promise<boolean>;
  projectOfAgency(agencyId: string, projectId: string): Promise<boolean>;
  effectiveTermination(sellerId: string): Promise<boolean>;
  prospectsOfClaims(sellerId: string, claimIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>>;
  acceptedLiveClaims(sellerId: string): Promise<ReadonlyArray<string>>;
  prospectExists(prospectId: string): Promise<boolean>;
  shareClaims(prospectId: string, claimIds: ReadonlyArray<string>): Promise<ReadonlyArray<ShareClaim>>;
  frozenAllocationOfAgency(agencyId: string): Promise<boolean>;

  registerSeller(userId: string, displayLabel: string): Promise<{ readonly sellerId: string; readonly version: number; readonly createdAt: UtcInstant }>;
  recordLegalReview(sellerId: string, b: { classification: string; outcome: string; substanceHash: string; reviewerLabel: string; evidenceHash: string; reviewedAt: string }): Promise<OwnerToolRecord>;
  prepareAgreement(
    sellerId: string,
    a: {
      readonly agreementVersion: string;
      readonly legalReviewId: string;
      readonly classification: string;
      readonly startsAt: UtcInstant;
      readonly endsAt: UtcInstant | null;
      readonly firstBps: number;
      readonly repeatBps: number;
      readonly offsetTerms: "NONE" | "SIGNED_FUTURE_OFFSET";
      readonly retainerCentsPerMonth: number;
      readonly compensationPolicyVersion: string;
      readonly signedTermsHash: string;
    },
  ): Promise<OwnerToolAgreement>;
  signAgreement(agreementId: string, expectedVersion: number, signatureEvidenceHash: string): Promise<OwnerToolAgreement | null>;
  recordAssessment(sellerId: string, b: { outcome: string; evidenceHash: string; assessedAt: string }): Promise<OwnerToolRecord>;
  recordConfidentialityAcceptance(sellerId: string, b: { termsHash: string; evidenceHash: string; acceptedAt: string }): Promise<OwnerToolRecord>;
  recordTaxDocument(sellerId: string, b: { jurisdiction: string; requirementsHash: string; evidenceHash: string }): Promise<OwnerToolRecord>;
  changeDestination(sellerId: string, destinationVersion: number, b: { maskedLabel: string; destinationDigest: string; currency: string; proofId: string }): Promise<OwnerToolDestination>;
  verifyDestination(destination: OwnerToolDestination, expectedVersion: number, proofId: string): Promise<OwnerToolDestination | null>;
  rejectDestination(destinationId: string, expectedVersion: number): Promise<OwnerToolDestination | null>;
  prepareServiceAssignment(sellerId: string, b: { agencyId: string; compensation: string; assistanceAgreementId: string | null; termsHash: string }): Promise<OwnerToolRecord>;
  recordAssistanceAgreement(sellerId: string, b: { agencyId: string; agreement: OwnerToolAgreement; scope: string; projectId: string | null; rateBps: number; termsHash: string }): Promise<OwnerToolRecord>;
  prepareTerminationTerms(sellerId: string, termsHash: string): Promise<OwnerToolRecord>;
  prepareTerminationManifest(sellerId: string, claimIds: ReadonlyArray<string>): Promise<OwnerToolRecord>;
  recordClaimEvidence(
    sellerId: string,
    prospectId: string,
    b: { evidenceHash: string; sourceChannel: string; firstMeaningfulContactAt: string; qualifiedNeedHash: string; activityKinds: ReadonlyArray<string> },
  ): Promise<OwnerToolRecord | null>;
  prepareAllocation(a: {
    readonly prospectId: string;
    readonly agencyId: string;
    readonly identityEvidenceHash: string;
    readonly rulingReason: string;
    readonly rulingEvidenceHash: string;
    readonly firstBps: number;
    readonly repeatBps: number;
    readonly shares: ReadonlyArray<{ readonly claim: ShareClaim; readonly shareBps: number }>;
  }): Promise<{ readonly allocationId: string; readonly version: number; readonly preparedAt: UtcInstant }>;
}

/** What the owner tools' handlers run on: the store of a unit of work, the commercial authorizer and B06's step-up verifier. */
export interface OwnerToolCollaborators {
  readonly tools: (uow: UnitOfWork) => OwnerToolStore;
  readonly authorizer: CommercialAuthorizer;
  readonly assurance: AssuranceVerifier;
}

