/**
 * Closed request schemas (JSON Schema 2020-12) of the commercial commands CMD002, CMD027, CMD043 and CMD045..CMD053 (10 "Version and
 * validation": closed objects, no coercion, no defaults, unknown fields reject; COMMAND_CATALOGUE "Request fields ... Extra fields
 * reject"). Property names are exactly the registry field names (a test proves it against commands.json) and every catalogue field
 * is required. Scalar shapes follow the vocabulary of the B06 and B09 request schemas: id = lowercase RFC 9562 UUID, version =
 * positive safe integer, hash = lowercase SHA-256, label = 1..200 characters without a Unicode Cc code point (B06 D-LABEL-1).
 *
 * What is absent is as deliberate as what is present (D10-API-1): no request carries an amount (a payout is the statement's own
 * amount), a destination digest (the destination is a stored, versioned record the owner's `payeeRef` names), contact details (they
 * travel as `businessContactRef`, a reference to the restricted contact record) or, but for the assignment, a seller identity (the
 * seller is the caller; the claim is the caller's own).
 *
 * Registering these beside REQUEST_SCHEMAS (widening the validator's known schema ids) is the command lanes' step when they serve
 * the routes; the `$id`s do not clash with the B06 or B09 ones.
 */
import { LABEL_PATTERN, REQUEST_SCHEMA_PREFIX, type RequestSchema } from "../api/request-schemas.js";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;
/** CMD048 only: an agency with no sales account is at version 0 and its first assignment opens the account (D10-ASSIGN-3). */
const ACCOUNT_VERSION = { type: "integer", minimum: 0, maximum: 9007199254740991 } as const;
const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const LABEL = { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN } as const;

function schema(command: string, required: ReadonlyArray<string>, properties: RequestSchema["properties"]): RequestSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: REQUEST_SCHEMA_PREFIX + command,
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

export const COMMERCIAL_REQUEST_SCHEMAS = Object.freeze({
  /** ActivateAgency: the accepted terms and privacy versions and the reviewed billing profile the activation binds. */
  CMD002: schema("CMD002", ["expectedVersion", "termsVersion", "privacyAgreementVersion", "billingProfileRef"], {
    expectedVersion: VERSION,
    termsVersion: LABEL,
    privacyAgreementVersion: LABEL,
    billingProfileRef: ID,
  }),
  /** CreateQuote: the approved plan and the billing profile whose treatment prices it. */
  CMD027: schema("CMD027", ["planId", "billingProfileRef"], { planId: ID, billingProfileRef: ID }),
  /** CloseAgency: the agency version and the closing owner's step-up proof. */
  CMD043: schema("CMD043", ["expectedVersion", "assuranceProofRef"], { expectedVersion: VERSION, assuranceProofRef: ID }),
  /** RegisterProspect: the organization, the reference to its restricted contact record, the collection evidence and the territory. */
  CMD045: schema("CMD045", ["organizationLabel", "businessContactRef", "sourceEvidenceHash", "jurisdiction"], {
    organizationLabel: LABEL,
    businessContactRef: ID,
    sourceEvidenceHash: HASH,
    jurisdiction: LABEL,
  }),
  /** ClaimProspect: the acquisition evidence and the signed agreement version the claim is made under. */
  CMD046: schema("CMD046", ["evidenceHash", "agreementVersion"], { evidenceHash: HASH, agreementVersion: LABEL }),
  /** AcceptAttribution: the claim version the owner reviewed and the share allocation it commits to. */
  CMD047: schema("CMD047", ["expectedVersion", "shareAllocationRef"], { expectedVersion: VERSION, shareAllocationRef: ID }),
  /** AssignAccount: the agency assignment version, the seller who services the account and the assignment record. */
  CMD048: schema("CMD048", ["expectedVersion", "sellerId", "serviceAssignmentRef"], { expectedVersion: ACCOUNT_VERSION, sellerId: ID, serviceAssignmentRef: ID }),
  /** ActivateSeller: the signed agreement, the reviewed classification evidence and the activating owner's step-up proof. */
  CMD049: schema("CMD049", ["agreementId", "assessmentEvidenceRef", "assuranceProofRef"], { agreementId: ID, assessmentEvidenceRef: ID, assuranceProofRef: ID }),
  /** TerminateSeller: the seller version, the termination terms and the manifest of the seller's active opportunities. */
  CMD050: schema("CMD050", ["expectedVersion", "terminationTermsRef", "activeOpportunityManifestRef"], {
    expectedVersion: VERSION,
    terminationTermsRef: ID,
    activeOpportunityManifestRef: ID,
  }),
  /** CloseCommissionPeriod: the exact ledger cutoff the close computes over. */
  CMD051: schema("CMD051", ["ledgerCutoffHash"], { ledgerCutoffHash: HASH }),
  /** ApproveCommissionPayout: the statement version, the stored payee record and the owner's fresh step-up proof. */
  CMD052: schema("CMD052", ["expectedVersion", "payeeRef", "authorizationRef"], { expectedVersion: VERSION, payeeRef: ID, authorizationRef: ID }),
  /** ReconcileCommissionPayout: the stored payout evidence the verifier authenticates. */
  CMD053: schema("CMD053", ["providerPayoutEvidenceRef"], { providerPayoutEvidenceRef: ID }),
  /** RecordIncident: the severity label (S1..S4, or FALSE_POSITIVE for a monitoring false positive), the safe scopes it affects and a short summary. */
  CMD056: schema("CMD056", ["severity", "affectedScopeRefs", "summary"], {
    severity: { type: "string", enum: ["S1", "S2", "S3", "S4", "FALSE_POSITIVE"] },
    affectedScopeRefs: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", pattern: "^(platform|agency|capability|project|provider|route|worker):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" } },
    summary: { type: "string", minLength: 1, maxLength: 500, pattern: LABEL_PATTERN },
  }),
  /** OpenBreakglass: ONE project id (no list, no wildcard), the purpose, the owner's fresh step-up proof and the support case or incident. */
  CMD054: schema("CMD054", ["scopeRef", "purpose", "assuranceProofRef", "authorizationRef"], { scopeRef: ID, purpose: LABEL, assuranceProofRef: ID, authorizationRef: ID }),
  /** RevokeBreakglass: the reason recorded with the revocation. A caller states no residual lifetime: the platform does. */
  CMD055: schema("CMD055", ["reasonCode"], { reasonCode: LABEL }),
  /** AuthorizeRecovery: the prepared restore candidate, the deletion journal hash the restore must honour and the owner's step-up proof. */
  CMD057: schema("CMD057", ["restoreCandidateRef", "deletionJournalHash", "authorizationRef"], { restoreCandidateRef: ID, deletionJournalHash: HASH, authorizationRef: ID }),
  /** ChangeCapability: the capability version read, the new profile hash and the qualification evidence hashes it cites (1..50; a repeated hash is recorded once). */
  CMD058: schema("CMD058", ["expectedVersion", "profileHash", "qualificationEvidenceRefs"], {
    expectedVersion: VERSION,
    profileHash: HASH,
    qualificationEvidenceRefs: { type: "array", minItems: 1, maxItems: 50, items: HASH },
  }),
  /** RestrictCapability: the capability version read and the incident that shows unsafe or unavailable behavior. */
  CMD059: schema("CMD059", ["expectedVersion", "incidentRef"], { expectedVersion: VERSION, incidentRef: ID }),
} as const);

export type CommercialRequestSchemaCommand = keyof typeof COMMERCIAL_REQUEST_SCHEMAS;
