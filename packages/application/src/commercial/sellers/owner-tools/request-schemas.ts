/**
 * Closed request schemas of the owner tools (lane L-OWNER; plan companion §P), in the vocabulary of commercial/request-schemas (closed
 * objects, no coercion, no defaults, unknown fields reject). Spread into COMMERCIAL_REQUEST_SCHEMAS. Instants are the caller's observed
 * times of a recorded fact (a review, an assessment, an acceptance); every instant the database judges is its own (server_now).
 */
import { LABEL_PATTERN, REQUEST_SCHEMA_PREFIX, type RequestSchema } from "../../../api/request-schemas.js";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;
const DESTINATION_VERSION = { type: "integer", minimum: 0, maximum: 2147483647 } as const;
const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const LABEL = { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN } as const;
const TOKEN = { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" } as const;
const BPS = { type: "integer", minimum: 0, maximum: 10000 } as const;
const SHARE_BPS = { type: "integer", minimum: 1, maximum: 10000 } as const;
const CENTS = { type: "integer", minimum: 0, maximum: 9007199254740991 } as const;
const UTC_INSTANT = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$" } as const;
const CLASSIFICATION = { type: "string", enum: ["INDEPENDENT_COLLABORATION", "EMPLOYMENT", "OTHER_REVIEWED"] } as const;

function schema(command: string, required: ReadonlyArray<string>, properties: RequestSchema["properties"]): RequestSchema {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: REQUEST_SCHEMA_PREFIX + command, type: "object", additionalProperties: false, required, properties };
}

export const B12_PRODUCER_REQUEST_SCHEMAS = Object.freeze({
  /** RegisterSellerCandidate: the corporate identity and the seller's display label. */
  RegisterSellerCandidate: schema("RegisterSellerCandidate", ["userId", "displayLabel"], { userId: ID, displayLabel: LABEL }),
  /** RecordSellerLegalReview: the reviewed classification of the relationship's substance and its evidence. */
  RecordSellerLegalReview: schema("RecordSellerLegalReview", ["classification", "outcome", "substanceHash", "reviewerLabel", "evidenceHash", "reviewedAt"], {
    classification: CLASSIFICATION,
    outcome: { type: "string", enum: ["CONFIRMED", "NOT_CONFIRMED"] },
    substanceHash: HASH,
    reviewerLabel: LABEL,
    evidenceHash: HASH,
    reviewedAt: UTC_INSTANT,
  }),
  /** PrepareSellerAgreement: the agreement version, the review it carries, its term, the pool terms, the retainer and the operative text. */
  PrepareSellerAgreement: schema(
    "PrepareSellerAgreement",
    ["agreementVersion", "legalReviewId", "startsAt", "firstBps", "repeatBps", "offsetTerms", "retainerCentsPerMonth", "compensationPolicyVersion", "signedTermsHash"],
    {
      agreementVersion: LABEL,
      legalReviewId: ID,
      startsAt: UTC_INSTANT,
      endsAt: UTC_INSTANT,
      firstBps: BPS,
      repeatBps: BPS,
      offsetTerms: { type: "string", enum: ["NONE", "SIGNED_FUTURE_OFFSET"] },
      retainerCentsPerMonth: CENTS,
      compensationPolicyVersion: LABEL,
      signedTermsHash: HASH,
    },
  ),
  /** RecordAgreementSignature: the agreement version read, the operative text signed and the signature's evidence. */
  RecordAgreementSignature: schema("RecordAgreementSignature", ["expectedVersion", "signedTermsHash", "signatureEvidenceHash"], { expectedVersion: VERSION, signedTermsHash: HASH, signatureEvidenceHash: HASH }),
  /** RecordSellerAssessment: the outcome of the capability assessment and its evidence. */
  RecordSellerAssessment: schema("RecordSellerAssessment", ["outcome", "evidenceHash", "assessedAt"], { outcome: { type: "string", enum: ["PASSED", "NOT_PASSED"] }, evidenceHash: HASH, assessedAt: UTC_INSTANT }),
  /** RecordConfidentialityAcceptance: the confidentiality and data-handling terms and the seller's acceptance evidence. */
  RecordConfidentialityAcceptance: schema("RecordConfidentialityAcceptance", ["termsHash", "evidenceHash", "acceptedAt"], { termsHash: HASH, evidenceHash: HASH, acceptedAt: UTC_INSTANT }),
  /** RecordSellerTaxDocument: the profile's validated requirements and the evidence they are met. */
  RecordSellerTaxDocument: schema("RecordSellerTaxDocument", ["jurisdiction", "requirementsHash", "evidenceHash"], { jurisdiction: { type: "string", pattern: "^[A-Z]{2}$" }, requirementsHash: HASH, evidenceHash: HASH }),
  /** ChangePayoutDestination: the version read, the masked label, the details' digest, the currency and the seller's own step-up proof. */
  ChangePayoutDestination: schema("ChangePayoutDestination", ["expectedDestinationVersion", "maskedLabel", "destinationDigest", "currency", "assuranceProofRef"], {
    expectedDestinationVersion: DESTINATION_VERSION,
    maskedLabel: LABEL,
    destinationDigest: HASH,
    currency: { type: "string", enum: ["USD", "COP"] },
    assuranceProofRef: ID,
  }),
  /** VerifyPayoutDestination: the row version read, the owner's decision and the owner's own step-up proof. */
  VerifyPayoutDestination: schema("VerifyPayoutDestination", ["expectedVersion", "decision", "assuranceProofRef"], { expectedVersion: VERSION, decision: { type: "string", enum: ["VERIFIED", "REJECTED"] }, assuranceProofRef: ID }),
  /** PrepareServiceAssignment: the agency, the compensation of the new work and, for an assistance agreement, which one. */
  PrepareServiceAssignment: schema("PrepareServiceAssignment", ["agencyId", "compensation", "termsHash"], {
    agencyId: ID,
    compensation: { type: "string", enum: ["NONE", "ASSISTANCE_AGREEMENT"] },
    assistanceAgreementId: ID,
    termsHash: HASH,
  }),
  /** RecordAssistanceAgreement: the agency, the seller's agreement, the scope (a project or the next purchase), the rate and the terms. */
  RecordAssistanceAgreement: schema("RecordAssistanceAgreement", ["agencyId", "agreementId", "scope", "rateBps", "termsHash"], {
    agencyId: ID,
    agreementId: ID,
    scope: { type: "string", enum: ["PROJECT", "NEXT_PURCHASE"] },
    projectId: ID,
    rateBps: SHARE_BPS,
    termsHash: HASH,
  }),
  /** PrepareTerminationTerms: the operative termination terms. */
  PrepareTerminationTerms: schema("PrepareTerminationTerms", ["termsHash"], { termsHash: HASH }),
  /** PrepareTerminationManifest: the seller's accepted claims handed over. */
  PrepareTerminationManifest: schema("PrepareTerminationManifest", ["claimIds"], { claimIds: { type: "array", minItems: 0, maxItems: 10000, items: ID } }),
  /** RecordClaimEvidence: the substantive evidence of the seller's work on the prospect. */
  RecordClaimEvidence: schema("RecordClaimEvidence", ["evidenceHash", "sourceChannel", "firstMeaningfulContactAt", "qualifiedNeedHash", "activityKinds"], {
    evidenceHash: HASH,
    sourceChannel: TOKEN,
    firstMeaningfulContactAt: UTC_INSTANT,
    qualifiedNeedHash: HASH,
    activityKinds: { type: "array", minItems: 1, maxItems: 20, items: TOKEN },
  }),
  /** PrepareAttributionAllocation: the agency the prospect is, the ruling, the pool terms and the shares (one per beneficiary claim). */
  PrepareAttributionAllocation: schema("PrepareAttributionAllocation", ["agencyId", "identityEvidenceHash", "rulingReason", "rulingEvidenceHash", "firstBps", "repeatBps", "shares"], {
    agencyId: ID,
    identityEvidenceHash: HASH,
    rulingReason: LABEL,
    rulingEvidenceHash: HASH,
    firstBps: BPS,
    repeatBps: BPS,
    shares: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "object", additionalProperties: false, required: ["claimId", "shareBps"], properties: { claimId: ID, shareBps: SHARE_BPS } },
    },
  }),
} as const);
