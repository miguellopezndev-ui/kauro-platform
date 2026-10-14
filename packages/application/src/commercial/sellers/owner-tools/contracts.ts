/**
 * The wire shapes of the B12 owner tools (lane L-OWNER; plan docs/design/B12-outreach-plan-cells.md §P): the producers of the rows the B10
 * seller and attribution commands consume and that, before this lane, only test fixtures wrote. Each producer writes exactly the row 0029
 * and its consuming command already define; no new truth rule. Every route is journaled under its own name (domain B12_PRODUCER_OPERATIONS;
 * 0072 and 0087 list them in command_journal.operation) with a REQUIRED Idempotency-Key, and has no registry row.
 *
 * Who may call (0029 policies): the corporate owner acting as itself for every onboarding, agreement, assignment, termination and allocation
 * record; the seller itself, in any state, for its own payout destination change (seller_payout_destinations_seller_change: a candidate needs
 * a verified destination to be activated and a departed seller keeps its payment route); the ACTIVE seller for its own claim evidence.
 *
 * This module imports types only from ../../contracts.js (which spreads B12_PRODUCER_COMMANDS into COMMERCIAL_COMMANDS), so no module cycle
 * is evaluated at load.
 */
import type { CommercialCommandSpec } from "../../contracts.js";
import type { B12OperationId } from "@kauro/domain";

function producer<Body>(s: {
  readonly id: B12OperationId;
  readonly path: string;
  readonly who: "OWNER" | "SELLER_SELF" | "ACTIVE_SELLER";
  readonly aggregateParam?: string;
  readonly expectedVersionRequired?: boolean;
  readonly stepUp?: boolean;
  readonly authorityHashFields?: ReadonlyArray<keyof Body & string>;
  readonly fields: ReadonlyArray<keyof Body & string>;
}): CommercialCommandSpec<Body> {
  return Object.freeze({
    id: s.id,
    name: s.id,
    method: "POST",
    path: s.path,
    role: s.who === "OWNER" ? "KAURO_OWNER" : s.who === "SELLER_SELF" ? "SELLER_SELF" : "ACTIVE_SELLER",
    principal: s.who === "OWNER" ? "CORPORATE_OPERATOR" : "SELLER",
    runtimeRole: "kauro_app",
    scope: "CORPORATE",
    aggregateParam: s.aggregateParam ?? null,
    scopeKind: null,
    expectedVersionRequired: s.expectedVersionRequired ?? false,
    authorityHashFields: s.authorityHashFields ?? [],
    fields: s.fields,
    stepUp: s.stepUp ?? false,
  } satisfies CommercialCommandSpec<Body>);
}

export type SellerClassificationInput = "INDEPENDENT_COLLABORATION" | "EMPLOYMENT" | "OTHER_REVIEWED";

// --- sellers (0029:133, policy 1280) -> CMD049 ------------------------------------------------------------------------------------------
export interface RegisterSellerCandidateBody {
  /** The corporate identity the seller acts as (one seller per identity, sellers_one_per_identity). */
  readonly userId: string;
  readonly displayLabel: string;
}
export const REGISTER_SELLER_CANDIDATE = producer<RegisterSellerCandidateBody>({ id: "RegisterSellerCandidate", path: "/api/v1/ops/sales/sellers", who: "OWNER", fields: ["userId", "displayLabel"] });

// --- seller_legal_reviews (0029:184, policy 1289) -> KC005 ------------------------------------------------------------------------------
export interface RecordSellerLegalReviewBody {
  readonly classification: SellerClassificationInput;
  readonly outcome: "CONFIRMED" | "NOT_CONFIRMED";
  /** The reviewed substance of the relationship (17 "Legal engagement packet": a label is not the classification). */
  readonly substanceHash: string;
  readonly reviewerLabel: string;
  readonly evidenceHash: string;
  readonly reviewedAt: string;
}
export const RECORD_SELLER_LEGAL_REVIEW = producer<RecordSellerLegalReviewBody>({
  id: "RecordSellerLegalReview",
  path: "/api/v1/ops/sales/sellers/{sellerId}/legal-reviews",
  who: "OWNER",
  aggregateParam: "sellerId",
  fields: ["classification", "outcome", "substanceHash", "reviewerLabel", "evidenceHash", "reviewedAt"],
});

// --- seller_agreements (0029:202, policies 1295/1297) -> CMD049 -------------------------------------------------------------------------
export interface PrepareSellerAgreementBody {
  readonly agreementVersion: string;
  /** The seller's legal review whose classification the agreement carries (seller_agreements_review_fk). */
  readonly legalReviewId: string;
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly firstBps: number;
  readonly repeatBps: number;
  readonly offsetTerms: "NONE" | "SIGNED_FUTURE_OFFSET";
  readonly retainerCentsPerMonth: number;
  readonly compensationPolicyVersion: string;
  /** The exact operative text the seller signs. */
  readonly signedTermsHash: string;
}
export const PREPARE_SELLER_AGREEMENT = producer<PrepareSellerAgreementBody>({
  id: "PrepareSellerAgreement",
  path: "/api/v1/ops/sales/sellers/{sellerId}/agreements",
  who: "OWNER",
  aggregateParam: "sellerId",
  fields: ["agreementVersion", "legalReviewId", "startsAt", "endsAt", "firstBps", "repeatBps", "offsetTerms", "retainerCentsPerMonth", "compensationPolicyVersion", "signedTermsHash"],
});

export interface RecordAgreementSignatureBody {
  readonly expectedVersion: number;
  /** The operative text the signature covers: the server compares it with the prepared one (HASH_MISMATCH). */
  readonly signedTermsHash: string;
  readonly signatureEvidenceHash: string;
}
export const RECORD_AGREEMENT_SIGNATURE = producer<RecordAgreementSignatureBody>({
  id: "RecordAgreementSignature",
  path: "/api/v1/ops/sales/agreements/{agreementId}/signature",
  who: "OWNER",
  aggregateParam: "agreementId",
  expectedVersionRequired: true,
  authorityHashFields: ["signedTermsHash"],
  fields: ["expectedVersion", "signedTermsHash", "signatureEvidenceHash"],
});

// --- seller_assessments (0029:233, policy 1304) -----------------------------------------------------------------------------------------
export interface RecordSellerAssessmentBody {
  readonly outcome: "PASSED" | "NOT_PASSED";
  readonly evidenceHash: string;
  readonly assessedAt: string;
}
export const RECORD_SELLER_ASSESSMENT = producer<RecordSellerAssessmentBody>({
  id: "RecordSellerAssessment",
  path: "/api/v1/ops/sales/sellers/{sellerId}/assessments",
  who: "OWNER",
  aggregateParam: "sellerId",
  fields: ["outcome", "evidenceHash", "assessedAt"],
});

// --- seller_confidentiality_acceptances (0029:244, policy 1310) -------------------------------------------------------------------------
export interface RecordConfidentialityAcceptanceBody {
  readonly termsHash: string;
  /** The seller's own acceptance evidence the owner records. */
  readonly evidenceHash: string;
  readonly acceptedAt: string;
}
export const RECORD_CONFIDENTIALITY_ACCEPTANCE = producer<RecordConfidentialityAcceptanceBody>({
  id: "RecordConfidentialityAcceptance",
  path: "/api/v1/ops/sales/sellers/{sellerId}/confidentiality-acceptances",
  who: "OWNER",
  aggregateParam: "sellerId",
  fields: ["termsHash", "evidenceHash", "acceptedAt"],
});

// --- seller_tax_documents (0029:255, policy 1316); content-addressed by (requirements, evidence) -------------------------------------------
export interface RecordSellerTaxDocumentBody {
  readonly jurisdiction: string;
  /** The validated requirements of the seller's profile (17 "Currency, fees and tax documentation"). */
  readonly requirementsHash: string;
  readonly evidenceHash: string;
}
export const RECORD_SELLER_TAX_DOCUMENT = producer<RecordSellerTaxDocumentBody>({
  id: "RecordSellerTaxDocument",
  path: "/api/v1/ops/sales/sellers/{sellerId}/tax-documents",
  who: "OWNER",
  aggregateParam: "sellerId",
  fields: ["jurisdiction", "requirementsHash", "evidenceHash"],
});

// --- seller_payout_destinations (0029:275, policies 1322/1327) TIER 1 money ------------------------------------------------------------
export interface ChangePayoutDestinationBody {
  /** The seller's latest destination version it read; 0 when it has none. A concurrent change answers STALE_VERSION. */
  readonly expectedDestinationVersion: number;
  readonly maskedLabel: string;
  /** The digest of the account details (the details are the payout adapter's, B15); never answered by any view. */
  readonly destinationDigest: string;
  readonly currency: "USD" | "COP";
  /** The seller's own fresh step-up (12 "Changing a payout destination requires step-up and a cooling/verification procedure"). */
  readonly assuranceProofRef: string;
}
export const CHANGE_PAYOUT_DESTINATION = producer<ChangePayoutDestinationBody>({
  id: "ChangePayoutDestination",
  path: "/api/v1/ops/sales/payout-destinations",
  who: "SELLER_SELF",
  stepUp: true,
  fields: ["expectedDestinationVersion", "maskedLabel", "destinationDigest", "currency", "assuranceProofRef"],
});

export interface VerifyPayoutDestinationBody {
  /** The destination row's version the owner read. */
  readonly expectedVersion: number;
  readonly decision: "VERIFIED" | "REJECTED";
  /** The owner's own fresh step-up, recorded on the row (0087 verification_proof_ref) and judged again at COMMIT. */
  readonly assuranceProofRef: string;
}
export const VERIFY_PAYOUT_DESTINATION = producer<VerifyPayoutDestinationBody>({
  id: "VerifyPayoutDestination",
  path: "/api/v1/ops/sales/payout-destinations/{destinationId}/verify",
  who: "OWNER",
  aggregateParam: "destinationId",
  expectedVersionRequired: true,
  stepUp: true,
  fields: ["expectedVersion", "decision", "assuranceProofRef"],
});

// --- service_assignments (0029:584, policy 1428) -> CMD048 ------------------------------------------------------------------------------
export interface PrepareServiceAssignmentBody {
  readonly agencyId: string;
  readonly compensation: "NONE" | "ASSISTANCE_AGREEMENT";
  readonly assistanceAgreementId?: string;
  readonly termsHash: string;
}
export const PREPARE_SERVICE_ASSIGNMENT = producer<PrepareServiceAssignmentBody>({
  id: "PrepareServiceAssignment",
  path: "/api/v1/ops/sales/sellers/{sellerId}/service-assignments",
  who: "OWNER",
  aggregateParam: "sellerId",
  fields: ["agencyId", "compensation", "assistanceAgreementId", "termsHash"],
});

// --- assistance_agreements (0029:503, policy 1412); signed before the work (signed_at is the server instant) -----------------------------
export interface RecordAssistanceAgreementBody {
  readonly agencyId: string;
  readonly agreementId: string;
  readonly scope: "PROJECT" | "NEXT_PURCHASE";
  readonly projectId?: string;
  readonly rateBps: number;
  readonly termsHash: string;
}
export const RECORD_ASSISTANCE_AGREEMENT = producer<RecordAssistanceAgreementBody>({
  id: "RecordAssistanceAgreement",
  path: "/api/v1/ops/sales/sellers/{sellerId}/assistance-agreements",
  who: "OWNER",
  aggregateParam: "sellerId",
  fields: ["agencyId", "agreementId", "scope", "projectId", "rateBps", "termsHash"],
});

// --- seller_terminations terms (0029:649, policy 1454) -> CMD050 terminationTermsRef -----------------------------------------------------
export interface PrepareTerminationTermsBody {
  readonly termsHash: string;
}
export const PREPARE_TERMINATION_TERMS = producer<PrepareTerminationTermsBody>({
  id: "PrepareTerminationTerms",
  path: "/api/v1/ops/sales/sellers/{sellerId}/termination-terms",
  who: "OWNER",
  aggregateParam: "sellerId",
  fields: ["termsHash"],
});

// --- termination_manifests (0029:636, policy 1448) -> CMD050 activeOpportunityManifestRef ------------------------------------------------
export interface PrepareTerminationManifestBody {
  /** Exactly the seller's ACCEPTED, unexpired claims at preparation (TAIL_NOT_ENUMERATED otherwise); the server derives the manifest hash. */
  readonly claimIds: ReadonlyArray<string>;
}
export const PREPARE_TERMINATION_MANIFEST = producer<PrepareTerminationManifestBody>({
  id: "PrepareTerminationManifest",
  path: "/api/v1/ops/sales/sellers/{sellerId}/termination-manifests",
  who: "OWNER",
  aggregateParam: "sellerId",
  fields: ["claimIds"],
});

// --- claim_evidence (0029:377, policy 1373) -> CMD046 evidenceHash ----------------------------------------------------------------------
export interface RecordClaimEvidenceBody {
  readonly evidenceHash: string;
  readonly sourceChannel: string;
  readonly firstMeaningfulContactAt: string;
  readonly qualifiedNeedHash: string;
  readonly activityKinds: ReadonlyArray<string>;
}
export const RECORD_CLAIM_EVIDENCE = producer<RecordClaimEvidenceBody>({
  id: "RecordClaimEvidence",
  path: "/api/v1/ops/sales/prospects/{prospectId}/claim-evidence",
  who: "ACTIVE_SELLER",
  aggregateParam: "prospectId",
  fields: ["evidenceHash", "sourceChannel", "firstMeaningfulContactAt", "qualifiedNeedHash", "activityKinds"],
});

// --- attribution_allocations + allocation_shares (0029:398/475, policies 1378/1405) -> CMD047 ------------------------------------------
export interface AllocationShareInput {
  readonly claimId: string;
  readonly shareBps: number;
}
export interface PrepareAttributionAllocationBody {
  readonly agencyId: string;
  readonly identityEvidenceHash: string;
  /** The ruling reason (never timestamps alone, 17 "Claim validity and conflicts"). */
  readonly rulingReason: string;
  readonly rulingEvidenceHash: string;
  readonly firstBps: number;
  readonly repeatBps: number;
  /** One share per beneficiary claim on the prospect; the shares sum to exactly 10000 bps (KC003 again at CMD047). */
  readonly shares: ReadonlyArray<AllocationShareInput>;
}
export const PREPARE_ATTRIBUTION_ALLOCATION = producer<PrepareAttributionAllocationBody>({
  id: "PrepareAttributionAllocation",
  path: "/api/v1/ops/sales/prospects/{prospectId}/allocations",
  who: "OWNER",
  aggregateParam: "prospectId",
  fields: ["agencyId", "identityEvidenceHash", "rulingReason", "rulingEvidenceHash", "firstBps", "repeatBps", "shares"],
});

/** The owner-tool routes, in plan §P order, then the two attribution producers. */
export const B12_PRODUCER_COMMANDS = Object.freeze({
  RegisterSellerCandidate: REGISTER_SELLER_CANDIDATE,
  RecordSellerLegalReview: RECORD_SELLER_LEGAL_REVIEW,
  PrepareSellerAgreement: PREPARE_SELLER_AGREEMENT,
  RecordAgreementSignature: RECORD_AGREEMENT_SIGNATURE,
  RecordSellerAssessment: RECORD_SELLER_ASSESSMENT,
  RecordConfidentialityAcceptance: RECORD_CONFIDENTIALITY_ACCEPTANCE,
  RecordSellerTaxDocument: RECORD_SELLER_TAX_DOCUMENT,
  ChangePayoutDestination: CHANGE_PAYOUT_DESTINATION,
  VerifyPayoutDestination: VERIFY_PAYOUT_DESTINATION,
  PrepareServiceAssignment: PREPARE_SERVICE_ASSIGNMENT,
  RecordAssistanceAgreement: RECORD_ASSISTANCE_AGREEMENT,
  PrepareTerminationTerms: PREPARE_TERMINATION_TERMS,
  PrepareTerminationManifest: PREPARE_TERMINATION_MANIFEST,
  RecordClaimEvidence: RECORD_CLAIM_EVIDENCE,
  PrepareAttributionAllocation: PREPARE_ATTRIBUTION_ALLOCATION,
} as const);
export type B12ProducerCommandId = keyof typeof B12_PRODUCER_COMMANDS;

/** The producer ids the api serves (spread into COMMERCIAL_SERVED_COMMAND_IDS). */
export const B12_PRODUCER_SERVED_IDS = [
  "RegisterSellerCandidate",
  "RecordSellerLegalReview",
  "PrepareSellerAgreement",
  "RecordAgreementSignature",
  "RecordSellerAssessment",
  "RecordConfidentialityAcceptance",
  "RecordSellerTaxDocument",
  "ChangePayoutDestination",
  "VerifyPayoutDestination",
  "PrepareServiceAssignment",
  "RecordAssistanceAgreement",
  "PrepareTerminationTerms",
  "PrepareTerminationManifest",
  "RecordClaimEvidence",
  "PrepareAttributionAllocation",
] as const satisfies ReadonlyArray<B12ProducerCommandId>;
