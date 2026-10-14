/**
 * The command-layer outcomes of the owner tools (lane L-OWNER; plan companion §P), composed by commercial/outcomes into each route's closed
 * catalogue with the transport, admission, authentication and access fragments. Every reason is one of the closed FAILURE_REASONS; a foreign
 * row answers NOT_FOUND like an unknown one.
 */
import type { FailureReason } from "@kauro/domain";
import { problemOutcome as outcome, type ProblemOutcome } from "../../../api/outcome-kit.js";
import type { B12ProducerCommandId } from "./contracts.js";

const STEP_UP: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window, expired, or expired before the COMMIT"),
]);
const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `the version read is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });
const NOT_FOUND = (what: string): ProblemOutcome => outcome("COMMAND", "NOT_FOUND", null, `${what} is unknown, or a row the caller may not see: a foreign and a nonexistent row answer alike`);
const PRE = (reason: FailureReason, why: string, current?: "ALWAYS" | "SOMETIMES"): ProblemOutcome => outcome("COMMAND", "PRECONDITION_FAILED", reason, why, current !== undefined ? { current } : undefined);

const SELLER_UNKNOWN = NOT_FOUND("the seller");
const SELLER_TERMINATED = PRE("SELLER_NOT_ACTIVE", "the seller is TERMINATED: no new onboarding, agreement or assignment record is written for it", "ALWAYS");

/** The seller itself in any state (the payout destination change; 0029 seller_payout_destinations_seller_change). */
export const SELLER_SELF_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ACCESS", "NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING", "the caller has no seller row (in any state): an agency member, the owner acting as itself and an unknown caller are refused alike"),
]);

/** The ACTIVE seller (claim evidence; 0029 claim_evidence_seller_record). */
export const ACTIVE_SELLER_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ACCESS", "NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING", "the caller holds no ACTIVE seller row, read after its transition lock: a CANDIDATE, SUSPENDED or TERMINATED seller is refused"),
]);

export const B12_PRODUCER_OUTCOMES: Readonly<Record<B12ProducerCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  RegisterSellerCandidate: [NOT_FOUND("the identity"), PRE("UNLISTED_TRANSITION", "the identity already has a seller row: a seller is born once per corporate identity", "SOMETIMES")],
  RecordSellerLegalReview: [SELLER_UNKNOWN, SELLER_TERMINATED],
  PrepareSellerAgreement: [
    SELLER_UNKNOWN,
    SELLER_TERMINATED,
    PRE("UNKNOWN_REFERENCE", "legalReviewId is not a legal review of this seller"),
    PRE("AGREEMENT_VERSION_MISMATCH", "the seller already has an agreement of this version"),
    PRE("COMMISSION_POOL_MISMATCH", "the term ends before it starts"),
  ],
  RecordAgreementSignature: [
    NOT_FOUND("the agreement"),
    STALE("agreement"),
    PRE("UNLISTED_TRANSITION", "the agreement is already signed: it is signed once", "ALWAYS"),
    PRE("HASH_MISMATCH", "signedTermsHash is not the operative text the agreement was prepared with"),
    SELLER_TERMINATED,
  ],
  RecordSellerAssessment: [SELLER_UNKNOWN, SELLER_TERMINATED],
  RecordConfidentialityAcceptance: [SELLER_UNKNOWN, SELLER_TERMINATED],
  RecordSellerTaxDocument: [SELLER_UNKNOWN, SELLER_TERMINATED],
  ChangePayoutDestination: [...STEP_UP, STALE("seller's latest destination")],
  VerifyPayoutDestination: [
    ...STEP_UP,
    NOT_FOUND("the destination"),
    STALE("destination"),
    PRE("UNLISTED_TRANSITION", "the destination is not PENDING_VERIFICATION, or a later version of the seller's destination exists", "ALWAYS"),
    PRE("PAYEE_UNVERIFIED", "the change carried no seller step-up, or its 172800 s cooling period has not passed on the database clock"),
    PRE("SELF_TARGET", "the verifier is the person who changed the destination"),
  ],
  PrepareServiceAssignment: [NOT_FOUND("the seller or the agency"), SELLER_TERMINATED, PRE("UNKNOWN_REFERENCE", "assistanceAgreementId is not an assistance agreement of this seller and agency, or is given with compensation NONE")],
  RecordAssistanceAgreement: [
    NOT_FOUND("the seller or the agency"),
    SELLER_TERMINATED,
    PRE("AGREEMENT_VERSION_MISMATCH", "agreementId is not a signed agreement of this seller"),
    PRE("CROSS_AGENCY", "projectId is not a project of the agency, or is given for NEXT_PURCHASE"),
  ],
  PrepareTerminationTerms: [SELLER_UNKNOWN, PRE("UNLISTED_TRANSITION", "the seller is already TERMINATED or has an effective termination", "ALWAYS")],
  PrepareTerminationManifest: [
    SELLER_UNKNOWN,
    PRE("UNLISTED_TRANSITION", "the seller is already TERMINATED", "ALWAYS"),
    PRE("TAIL_NOT_ENUMERATED", "claimIds is not exactly the seller's ACCEPTED, unexpired claims at preparation, read under each prospect's claims lock"),
  ],
  RecordClaimEvidence: [NOT_FOUND("the prospect"), PRE("CLAIM_EVIDENCE_INSUFFICIENT", "the first meaningful contact is after the database instant of the record (17: backdated notes create no entitlement)")],
  PrepareAttributionAllocation: [
    NOT_FOUND("the prospect or the agency"),
    PRE("CLAIM_NOT_REVIEWABLE", "a share names a claim that is not a SUBMITTED or DISPUTED claim on this prospect, or two shares name one seller"),
    PRE("SHARES_NOT_WHOLE", "the shares do not sum to exactly 10000 basis points"),
    PRE("COMMISSION_POOL_MISMATCH", "the pool terms are not every beneficiary's signed agreement terms"),
    PRE("ATTRIBUTION_EXISTS", "the agency already has a frozen allocation"),
  ],
});

export const B12_PRODUCER_STEP_UP_OUTCOMES = STEP_UP;
