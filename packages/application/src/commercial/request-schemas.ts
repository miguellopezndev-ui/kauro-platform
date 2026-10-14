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
import { LABEL_PATTERN, REQUEST_SCHEMA_PREFIX, TEXT_PATTERN, type RequestSchema } from "../api/request-schemas.js";
import { OUTREACH_PURPOSES } from "@kauro/domain";
import { B12_PRODUCER_REQUEST_SCHEMAS } from "./sellers/owner-tools/request-schemas.js";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;
/** CMD048 only: an agency with no sales account is at version 0 and its first assignment opens the account (D10-ASSIGN-3). */
const ACCOUNT_VERSION = { type: "integer", minimum: 0, maximum: 9007199254740991 } as const;
const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const LABEL = { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN } as const;
const PURPOSE = { type: "string", enum: [...OUTREACH_PURPOSES] } as const;
/** A UTC instant with up to microsecond precision (B12 judges at the microsecond; plan §W). */
const UTC_INSTANT = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$" } as const;

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
  // --- package B12 (outreach; K2) ---------------------------------------------------------------------------------------------------
  /** PrepareOutreachDraft: the prospect, the registered sender, the reviewed purpose, the stored content and the source evidence the draft rests on. */
  CMD061: schema("CMD061", ["prospectId", "senderIdentityRef", "purpose", "contentRef", "provenanceEvidenceHash"], {
    prospectId: ID,
    senderIdentityRef: ID,
    purpose: PURPOSE,
    contentRef: HASH,
    provenanceEvidenceHash: HASH,
  }),
  /** AuthorizeOutreach: the sender, the sealed drafts' content bindings, the window, the bound count, the review digest and the owner's step-up proof. */
  CMD062: schema("CMD062", ["senderIdentityRef", "allowedContentHashes", "validFrom", "expiresAt", "maximumSends", "permissionEvidenceHash", "assuranceProofRef"], {
    senderIdentityRef: ID,
    allowedContentHashes: { type: "array", minItems: 1, maxItems: 100, items: HASH },
    validFrom: UTC_INSTANT,
    expiresAt: UTC_INSTANT,
    maximumSends: { type: "integer", minimum: 1, maximum: 100 },
    permissionEvidenceHash: HASH,
    assuranceProofRef: ID,
  }),
  /** SendAuthorizedOutreach: the draft version read, the grant it is sent under and the content binding the server recomputes. */
  CMD063: schema("CMD063", ["expectedVersion", "authorizationId", "contentHash"], { expectedVersion: VERSION, authorizationId: ID, contentHash: HASH }),
  /** RecordSalesActivity: one evidence-backed activity; the prospect and kind decide which of the optional members the kind needs. */
  CMD064: schema("CMD064", ["activity"], {
    activity: {
      type: "object",
      additionalProperties: false,
      required: ["prospectId", "kind", "occurredAt", "evidenceHash", "providerMessageRef"],
      properties: {
        prospectId: ID,
        draftId: ID,
        kind: { type: "string", enum: ["REPLIED", "BOUNCED", "SUPPRESSED", "HUMAN_SEND_OBSERVED"] },
        occurredAt: UTC_INSTANT,
        evidenceHash: HASH,
        providerMessageRef: { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN },
        observation: { type: "string", enum: ["SENT", "NOT_SENT"] },
        suppressionKeyKind: { type: "string", enum: ["ORGANIZATION", "CONTACT"] },
        suppressionReason: { type: "string", enum: ["OPT_OUT", "COMPLAINT", "REFUSAL", "DISQUALIFIED"] },
      },
    },
  }),
  /** PutOutreachContent: the subject (one line) and the plain-text body; the content is addressed by their hash. */
  PutOutreachContent: schema("PutOutreachContent", ["subject", "body"], {
    subject: { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN },
    body: { type: "string", minLength: 1, maxLength: 20000, pattern: TEXT_PATTERN },
  }),
  /** PublishSalesResource: the family, the version read (0 for a new family), the stored content, the capabilities it describes and the owner's step-up proof. */
  PublishSalesResource: schema("PublishSalesResource", ["familyId", "expectedVersion", "contentRef", "capabilityIds", "assuranceProofRef"], {
    familyId: ID,
    expectedVersion: ACCOUNT_VERSION,
    contentRef: HASH,
    capabilityIds: { type: "array", minItems: 1, maxItems: 50, items: ID },
    assuranceProofRef: ID,
  }),
  /** RegisterSenderIdentity: the person, the mailbox, the route, the person's consent evidence (required for GMAIL_API) and the owner's step-up proof. */
  RegisterSenderIdentity: schema("RegisterSenderIdentity", ["userId", "address", "route", "assuranceProofRef"], {
    userId: ID,
    address: { type: "string", minLength: 3, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+$" },
    route: { type: "string", enum: ["GMAIL_API", "RESEND_TRANSACTIONAL"] },
    consentEvidenceRef: HASH,
    assuranceProofRef: ID,
  }),
  /** VerifySenderIdentity: the evidence that the person controls the mailbox. */
  VerifySenderIdentity: schema("VerifySenderIdentity", ["verificationEvidenceHash"], { verificationEvidenceHash: HASH }),
  /** RecordSenderRevocation: nothing but the path's sender. */
  RecordSenderRevocation: schema("RecordSenderRevocation", [], {}),
  /** PrepareOutreachReview: the sender, the drafts to show the owner and the owner's step-up proof the review is bound to. */
  PrepareOutreachReview: schema("PrepareOutreachReview", ["senderIdentityRef", "draftIds", "assuranceProofRef"], {
    senderIdentityRef: ID,
    draftIds: { type: "array", minItems: 1, maxItems: 100, items: ID },
    assuranceProofRef: ID,
  }),
  /** RecordOutreachDiagnosis: the person whose pause the owner lifts, the diagnosis evidence and the owner's step-up proof. */
  RecordOutreachDiagnosis: schema("RecordOutreachDiagnosis", ["personUserId", "evidenceHash", "assuranceProofRef"], { personUserId: ID, evidenceHash: HASH, assuranceProofRef: ID }),
  /** RevokeOutreachAuthorization: nothing but the path's grant. */
  RevokeOutreachAuthorization: schema("RevokeOutreachAuthorization", [], {}),
  /** WithdrawOutreachChannelPolicy: the policy's jurisdiction and purpose, the version read and the owner's step-up proof. */
  WithdrawOutreachChannelPolicy: schema("WithdrawOutreachChannelPolicy", ["jurisdiction", "purpose", "expectedVersion", "assuranceProofRef"], {
    jurisdiction: LABEL,
    purpose: PURPOSE,
    expectedVersion: VERSION,
    assuranceProofRef: ID,
  }),
  /** RecordProspectSource: the collection evidence of a prospect (the source URL travels as a digest only). */
  RecordProspectSource: schema("RecordProspectSource", ["evidenceHash", "sourceUrlDigest", "observedOn", "lawfulBasis", "segment"], {
    evidenceHash: HASH,
    sourceUrlDigest: HASH,
    observedOn: { type: "string", pattern: "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$" },
    lawfulBasis: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" },
    segment: { type: "string", enum: ["AGENCY", "COMPANY"] },
  }),
  /** RecordProspectContact: the seller's label for the contact, its role, the channel and the address (stored in the restricted record only). */
  RecordProspectContact: schema("RecordProspectContact", ["contactLabel", "channel", "address"], {
    contactLabel: LABEL,
    roleLabel: LABEL,
    channel: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" },
    address: { type: "string", minLength: 3, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+$" },
  }),
  // package B12 lane L-OWNER: the owner tools (plan companion §P)
  ...B12_PRODUCER_REQUEST_SCHEMAS,
} as const);

export type CommercialRequestSchemaCommand = keyof typeof COMMERCIAL_REQUEST_SCHEMAS;
