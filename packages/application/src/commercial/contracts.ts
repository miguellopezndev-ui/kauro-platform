/**
 * The twelve commercial commands of package B10 (registry commands CMD002, CMD027, CMD043 and CMD045..CMD053;
 * reference/COMMAND_CATALOGUE): body (exactly the registry fields), result view, and the spec the transport, the authorizers and the
 * runtime consume. Behaviour — reads, locks, preconditions in order, writes, events, and OK/DENY/RACE — is specified in
 * docs/design/B10-commercial-domain.md §3 to §9; the handlers implementing these contracts are the command lanes of B10.
 *
 * B10 needs things neither the B06 CommandSpec nor the B09 one describes, so its spec is its own type:
 * - the principal: an agency member (AGENCY_OWNER, AGENCY_BILLING), an active seller, a seller or the owner (CMD045 only), the
 *   corporate operator (KAURO_OWNER), or one of the two commission services (D10-CTX-1, D10-CTX-2);
 * - the runtime role its unit of work runs under: kauro_app for every request handler, kauro_commission for the two services;
 * - the scope: the agency the path names (CMD002 and CMD043: the agency is the aggregate), the active-agency header (CMD027), the
 *   corporate scope (the seller and prospect commands: no agency is bound) or the stored operation (the two service commands,
 *   whose scope is derived from the stored period or statement, never from the caller; D10-CTX-3);
 * - the assurance: CMD043, CMD049 and CMD052 need a fresh step-up of the acting person.
 *
 * Every command is gated G-COMMERCIAL and requires an Idempotency-Key (the catalogue). B10 has no provider effect of its own: the
 * one payout provider reached, the evidence verifier of CMD053, is a port that runs outside any transaction (design §11).
 */
import type { B12OperationId } from "@kauro/domain";
import { B12_PRODUCER_COMMANDS } from "./sellers/owner-tools/contracts.js";
import type {
  AgencyActivationView,
  AgencyClosureView,
  AttributionClaimView,
  AttributionView,
  CreateQuoteView,
  PayoutIntentView,
  PayoutReconciliationView,
  PeriodCloseView,
  ProspectView,
  SalesAccountView,
  SellerTerminationView,
  SellerView,
  CapabilityVersionView,
  CapabilityRestrictionView,
  IncidentView,
  RecoveryAuthorizationView,
  BreakglassGrantView,
  BreakglassRevocationView,
} from "./views.js";

export type CommercialCommandId = "CMD002" | "CMD027" | "CMD043" | "CMD045" | "CMD046" | "CMD047" | "CMD048" | "CMD049" | "CMD050" | "CMD051" | "CMD052" | "CMD053" | "CMD054" | "CMD055" | "CMD056" | "CMD057" | "CMD058" | "CMD059" | "CMD061" | "CMD062" | "CMD063" | "CMD064" | B12OperationId;

export type CommercialPrincipalKind = "AGENCY_MEMBER" | "SELLER" | "SELLER_OR_OWNER" | "CORPORATE_OPERATOR" | "COMMERCIAL_SERVICE";

export type CommercialScope = "AGENCY_PATH" | "AGENCY_HEADER" | "CORPORATE" | "STORED_OPERATION";

export interface CommercialCommandSpec<Body> {
  readonly id: CommercialCommandId;
  readonly name: string;
  readonly method: "POST";
  readonly path: string;
  /** The catalogue role (commands.json through @kauro/contracts, brand-mapped: KAURO_OWNER). */
  readonly role: "AGENCY_OWNER" | "AGENCY_BILLING" | "ACTIVE_SELLER_OR_OWNER" | "ACTIVE_SELLER" | "SELLER_SELF" | "KAURO_OWNER" | "KAURO_OWNER_OR_SECURITY_SERVICE" | "OPERATIONS_SERVICE_OR_OWNER" | "COMMISSION_SERVICE" | "FINANCE_SERVICE" | "ASSIGNED_SELLER_OR_OWNER" | "OWNER" | "ASSIGNED_SELLER_OWNER_OR_RECONCILER";
  readonly principal: CommercialPrincipalKind;
  /**
   * The database role of the command's unit of work: kauro_app for a request handler (TENANT for an agency member, OPERATOR for a
   * seller or the owner) and kauro_commission for the two services (D10-CTX-2).
   */
  readonly runtimeRole: "kauro_app" | "kauro_commission";
  /**
   * Set when a verified service identity may also act (role OPERATIONS_SERVICE_OR_OWNER): the technical role it must hold and the runtime
   * group its unit of work runs in (decision B18-OPS-1). The person path of the same route is `principal` and `runtimeRole`.
   */
  readonly service?: { readonly role: "OPERATIONS_SERVICE"; readonly runtimeRole: "kauro_commission" };
  readonly scope: CommercialScope;
  /** The path parameter naming the aggregate; null for a command that creates its aggregate (CMD045: a prospect has no identity yet). */
  readonly aggregateParam: string | null;
  /** STORED_OPERATION: the scope-index kind the path id resolves through (D10-CTX-3). */
  readonly scopeKind: "COMMISSION_PERIOD" | "COMMISSION_STATEMENT" | null;
  readonly expectedVersionRequired: boolean;
  /** Fields whose values are hashes the server recomputes and compares (10: high-impact commands name exact authority hashes). */
  readonly authorityHashFields: ReadonlyArray<keyof Body & string>;
  /** Registry field names in catalogue order (a test proves it against commands.json). */
  readonly fields: ReadonlyArray<keyof Body & string>;
  /** True when the command demands a fresh step-up of the acting person (08 "Authentication and assurance"). */
  readonly stepUp: boolean;
}

function spec<Body>(s: CommercialCommandSpec<Body>): CommercialCommandSpec<Body> {
  return Object.freeze(s);
}

// --- CMD002 ActivateAgency ---------------------------------------------------------------------------------------------------------

export interface ActivateAgencyBody {
  readonly expectedVersion: number;
  readonly termsVersion: string;
  readonly privacyAgreementVersion: string;
  readonly billingProfileRef: string;
}
export type ActivateAgencyResult = AgencyActivationView;
export const ACTIVATE_AGENCY = spec<ActivateAgencyBody>({
  id: "CMD002",
  name: "ActivateAgency",
  method: "POST",
  path: "/api/v1/agencies/{agencyId}/activate",
  role: "AGENCY_OWNER",
  principal: "AGENCY_MEMBER",
  runtimeRole: "kauro_app",
  scope: "AGENCY_PATH",
  aggregateParam: "agencyId",
  scopeKind: null,
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "termsVersion", "privacyAgreementVersion", "billingProfileRef"],
  stepUp: false,
});

// --- CMD027 CreateQuote ------------------------------------------------------------------------------------------------------------

export interface CreateQuoteBody {
  readonly planId: string;
  readonly billingProfileRef: string;
}
export type CreateQuoteResult = CreateQuoteView;
export const CREATE_QUOTE = spec<CreateQuoteBody>({
  id: "CMD027",
  name: "CreateQuote",
  method: "POST",
  path: "/api/v1/projects/{projectId}/quotes",
  role: "AGENCY_BILLING",
  principal: "AGENCY_MEMBER",
  runtimeRole: "kauro_app",
  scope: "AGENCY_HEADER",
  aggregateParam: "projectId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["planId", "billingProfileRef"],
  stepUp: false,
});

// --- CMD043 CloseAgency ------------------------------------------------------------------------------------------------------------

export interface CloseAgencyBody {
  readonly expectedVersion: number;
  /** The step-up proof of the closing owner (08). */
  readonly assuranceProofRef: string;
}
export type CloseAgencyResult = AgencyClosureView;
export const CLOSE_AGENCY = spec<CloseAgencyBody>({
  id: "CMD043",
  name: "CloseAgency",
  method: "POST",
  path: "/api/v1/agencies/{agencyId}/closure-requests",
  role: "AGENCY_OWNER",
  principal: "AGENCY_MEMBER",
  runtimeRole: "kauro_app",
  scope: "AGENCY_PATH",
  aggregateParam: "agencyId",
  scopeKind: null,
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "assuranceProofRef"],
  stepUp: true,
});

// --- CMD045 RegisterProspect -------------------------------------------------------------------------------------------------------

export interface RegisterProspectBody {
  readonly organizationLabel: string;
  /** A reference to the restricted contact record; the contact details themselves never travel in a request or a response. */
  readonly businessContactRef: string;
  readonly sourceEvidenceHash: string;
  readonly jurisdiction: string;
}
export type RegisterProspectResult = ProspectView;
export const REGISTER_PROSPECT = spec<RegisterProspectBody>({
  id: "CMD045",
  name: "RegisterProspect",
  method: "POST",
  path: "/api/v1/sales/prospects",
  role: "ACTIVE_SELLER_OR_OWNER",
  principal: "SELLER_OR_OWNER",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: null,
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["organizationLabel", "businessContactRef", "sourceEvidenceHash", "jurisdiction"],
  stepUp: false,
});

// --- CMD046 ClaimProspect ----------------------------------------------------------------------------------------------------------

export interface ClaimProspectBody {
  readonly evidenceHash: string;
  readonly agreementVersion: string;
}
export type ClaimProspectResult = AttributionClaimView;
export const CLAIM_PROSPECT = spec<ClaimProspectBody>({
  id: "CMD046",
  name: "ClaimProspect",
  method: "POST",
  path: "/api/v1/sales/prospects/{prospectId}/claims",
  role: "ACTIVE_SELLER",
  principal: "SELLER",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: "prospectId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["evidenceHash", "agreementVersion"],
  stepUp: false,
});

// --- CMD047 AcceptAttribution ------------------------------------------------------------------------------------------------------

export interface AcceptAttributionBody {
  readonly expectedVersion: number;
  readonly shareAllocationRef: string;
}
export type AcceptAttributionResult = AttributionView;
export const ACCEPT_ATTRIBUTION = spec<AcceptAttributionBody>({
  id: "CMD047",
  name: "AcceptAttribution",
  method: "POST",
  path: "/api/v1/sales/claims/{claimId}/accept",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: "claimId",
  scopeKind: null,
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "shareAllocationRef"],
  stepUp: false,
});

// --- CMD048 AssignAccount ----------------------------------------------------------------------------------------------------------

export interface AssignAccountBody {
  readonly expectedVersion: number;
  readonly sellerId: string;
  readonly serviceAssignmentRef: string;
}
export type AssignAccountResult = SalesAccountView;
export const ASSIGN_ACCOUNT = spec<AssignAccountBody>({
  id: "CMD048",
  name: "AssignAccount",
  method: "POST",
  path: "/api/v1/sales/agencies/{agencyId}/assignment",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: "agencyId",
  scopeKind: null,
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "sellerId", "serviceAssignmentRef"],
  stepUp: false,
});

// --- CMD049 ActivateSeller ---------------------------------------------------------------------------------------------------------

export interface ActivateSellerBody {
  readonly agreementId: string;
  readonly assessmentEvidenceRef: string;
  /** The step-up proof of the activating owner (08). */
  readonly assuranceProofRef: string;
}
export type ActivateSellerResult = SellerView;
export const ACTIVATE_SELLER = spec<ActivateSellerBody>({
  id: "CMD049",
  name: "ActivateSeller",
  method: "POST",
  path: "/api/v1/sales/sellers/{sellerId}/activate",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: "sellerId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["agreementId", "assessmentEvidenceRef", "assuranceProofRef"],
  stepUp: true,
});

// --- CMD050 TerminateSeller --------------------------------------------------------------------------------------------------------

export interface TerminateSellerBody {
  readonly expectedVersion: number;
  readonly terminationTermsRef: string;
  readonly activeOpportunityManifestRef: string;
}
export type TerminateSellerResult = SellerTerminationView;
export const TERMINATE_SELLER = spec<TerminateSellerBody>({
  id: "CMD050",
  name: "TerminateSeller",
  method: "POST",
  path: "/api/v1/sales/sellers/{sellerId}/terminate",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: "sellerId",
  scopeKind: null,
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "terminationTermsRef", "activeOpportunityManifestRef"],
  stepUp: false,
});

// --- CMD051 CloseCommissionPeriod --------------------------------------------------------------------------------------------------

export interface CloseCommissionPeriodBody {
  /** The digest of the exact ledger the close computes over: a ledger that moved since is refused, never silently re-cut (10). */
  readonly ledgerCutoffHash: string;
}
export type CloseCommissionPeriodResult = PeriodCloseView;
export const CLOSE_COMMISSION_PERIOD = spec<CloseCommissionPeriodBody>({
  id: "CMD051",
  name: "CloseCommissionPeriod",
  method: "POST",
  path: "/api/v1/sales/commission-periods/{periodId}/close",
  role: "COMMISSION_SERVICE",
  principal: "COMMERCIAL_SERVICE",
  runtimeRole: "kauro_commission",
  scope: "STORED_OPERATION",
  aggregateParam: "periodId",
  scopeKind: "COMMISSION_PERIOD",
  expectedVersionRequired: false,
  authorityHashFields: ["ledgerCutoffHash"],
  fields: ["ledgerCutoffHash"],
  stepUp: false,
});

// --- CMD052 ApproveCommissionPayout ------------------------------------------------------------------------------------------------

export interface ApproveCommissionPayoutBody {
  readonly expectedVersion: number;
  readonly payeeRef: string;
  /** A fresh step-up proof of the approving owner (08). */
  readonly authorizationRef: string;
}
export type ApproveCommissionPayoutResult = PayoutIntentView;
export const APPROVE_COMMISSION_PAYOUT = spec<ApproveCommissionPayoutBody>({
  id: "CMD052",
  name: "ApproveCommissionPayout",
  method: "POST",
  path: "/api/v1/sales/statements/{statementId}/approve-payout",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: "statementId",
  scopeKind: null,
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "payeeRef", "authorizationRef"],
  stepUp: true,
});

// --- CMD053 ReconcileCommissionPayout ----------------------------------------------------------------------------------------------

export interface ReconcileCommissionPayoutBody {
  /** A stored payout-evidence reference the verifier authenticates; never a claim the caller states (D10-PAY-1). */
  readonly providerPayoutEvidenceRef: string;
}
export type ReconcileCommissionPayoutResult = PayoutReconciliationView;
export const RECONCILE_COMMISSION_PAYOUT = spec<ReconcileCommissionPayoutBody>({
  id: "CMD053",
  name: "ReconcileCommissionPayout",
  method: "POST",
  path: "/api/v1/sales/statements/{statementId}/reconcile-payout",
  role: "FINANCE_SERVICE",
  principal: "COMMERCIAL_SERVICE",
  runtimeRole: "kauro_commission",
  scope: "STORED_OPERATION",
  aggregateParam: "statementId",
  scopeKind: "COMMISSION_STATEMENT",
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["providerPayoutEvidenceRef"],
  stepUp: false,
});

// --- CMD054 OpenBreakglass, CMD055 RevokeBreakglass (package B16 lane L4; gate G-SECURITY) ----------------------------------------------

export interface OpenBreakglassBody {
  /** The ONE project the grant covers (a grant is never blanket raw-data access). */
  readonly scopeRef: string;
  readonly purpose: string;
  /** A fresh step-up proof of the opening owner (08), used once. */
  readonly assuranceProofRef: string;
  /** The support case of that project, or the actual incident naming it, that justifies the grant. */
  readonly authorizationRef: string;
}
export type OpenBreakglassResult = BreakglassGrantView;
export const OPEN_BREAKGLASS = spec<OpenBreakglassBody>({
  id: "CMD054",
  name: "OpenBreakglass",
  method: "POST",
  path: "/api/v1/operations/breakglass-grants",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: null,
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["scopeRef", "purpose", "assuranceProofRef", "authorizationRef"],
  stepUp: true,
});

export interface RevokeBreakglassBody {
  readonly reasonCode: string;
}
export type RevokeBreakglassResult = BreakglassRevocationView;
/**
 * The registry role is KAURO_OWNER_OR_SECURITY_SERVICE; this lane serves the owner's path. The security service's principal (a verified
 * service identity with its own journal stream) is not bound yet: GAP-BG-SVC in docs/design/B16-case-map.md.
 */
export const REVOKE_BREAKGLASS = spec<RevokeBreakglassBody>({
  id: "CMD055",
  name: "RevokeBreakglass",
  method: "POST",
  path: "/api/v1/operations/breakglass-grants/{grantId}/revoke",
  role: "KAURO_OWNER_OR_SECURITY_SERVICE",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: "grantId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["reasonCode"],
  stepUp: false,
});

// --- CMD056 RecordIncident, CMD057 AuthorizeRecovery (package B16; gate G-RECOVERY) ------------------------------------------------

export interface RecordIncidentBody {
  readonly severity: string;
  readonly affectedScopeRefs: ReadonlyArray<string>;
  readonly summary: string;
}
export type RecordIncidentResult = IncidentView;
export const RECORD_INCIDENT = spec<RecordIncidentBody>({
  id: "CMD056",
  name: "RecordIncident",
  method: "POST",
  path: "/api/v1/operations/incidents",
  role: "OPERATIONS_SERVICE_OR_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  service: { role: "OPERATIONS_SERVICE", runtimeRole: "kauro_commission" },
  scope: "CORPORATE",
  aggregateParam: null,
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["severity", "affectedScopeRefs", "summary"],
  stepUp: false,
});

export interface AuthorizeRecoveryBody {
  readonly restoreCandidateRef: string;
  readonly deletionJournalHash: string;
  /** A fresh step-up proof of the authorizing owner (08). */
  readonly authorizationRef: string;
}
export type AuthorizeRecoveryResult = RecoveryAuthorizationView;
export const AUTHORIZE_RECOVERY = spec<AuthorizeRecoveryBody>({
  id: "CMD057",
  name: "AuthorizeRecovery",
  method: "POST",
  path: "/api/v1/operations/recoveries",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: null,
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["restoreCandidateRef", "deletionJournalHash", "authorizationRef"],
  stepUp: true,
});

// --- CMD058 ChangeCapability, CMD059 RestrictCapability (package B18; gate G-RELEASE) -----------------------------------------------

export interface ChangeCapabilityBody {
  readonly expectedVersion: number;
  readonly profileHash: string;
  readonly qualificationEvidenceRefs: ReadonlyArray<string>;
}
export type ChangeCapabilityResult = CapabilityVersionView;
export const CHANGE_CAPABILITY = spec<ChangeCapabilityBody>({
  id: "CMD058",
  name: "ChangeCapability",
  method: "POST",
  path: "/api/v1/operations/capabilities/{capabilityId}/versions",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: "capabilityId",
  scopeKind: null,
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "profileHash", "qualificationEvidenceRefs"],
  stepUp: false,
});

export interface RestrictCapabilityBody {
  readonly expectedVersion: number;
  readonly incidentRef: string;
}
export type RestrictCapabilityResult = CapabilityRestrictionView;
export const RESTRICT_CAPABILITY = spec<RestrictCapabilityBody>({
  id: "CMD059",
  name: "RestrictCapability",
  method: "POST",
  path: "/api/v1/operations/capabilities/{capabilityId}/restrict",
  role: "OPERATIONS_SERVICE_OR_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  service: { role: "OPERATIONS_SERVICE", runtimeRole: "kauro_commission" },
  scope: "CORPORATE",
  aggregateParam: "capabilityId",
  scopeKind: null,
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "incidentRef"],
  stepUp: false,
});

// --- package B12 (outreach): CMD061..CMD064 and the registry-less operations (K2) ----------------------------------------------------
// Registered once by the kit so that the lanes replace handler bodies only. CMD061..CMD064 carry the registry fields (gate G-UX_PRIVATE,
// idempotency REQUIRED; a test proves them against commands.json). The operations without a catalogue id are journaled under their own
// name (domain B12_OPERATIONS; 0088 widens command_journal.operation by that explicit list) and are specified by plan companion §R.
// Deliberate, recorded differences from the registry field lists (decisions K2-3, K2-4):
// - CMD062 also carries assuranceProofRef: the plan binds the review to the step-up proof it was issued under and judges the step-up at COMMIT,
//   and the registry lists no proof field; the proof travels like every other step-up command's, in the body.
// - contentRef is the hex SHA-256 content address of kauro.outreach_contents (0088), not a UUID.

export interface PrepareOutreachDraftBody {
  readonly prospectId: string;
  readonly senderIdentityRef: string;
  readonly purpose: "REQUESTED_REPLY" | "INDIVIDUAL_PROSPECT_CONTACT" | "FOLLOW_UP";
  readonly contentRef: string;
  readonly provenanceEvidenceHash: string;
  /** The CURRENT sales resources the draft cites (A8, R2-135; amendment of L-DRAFT to K2's body: optional, outreach_draft_resources). */
  readonly resourceIds?: ReadonlyArray<string>;
}
export const PREPARE_OUTREACH_DRAFT = spec<PrepareOutreachDraftBody>({
  id: "CMD061",
  name: "PrepareOutreachDraft",
  method: "POST",
  path: "/api/v1/ops/outreach/drafts",
  role: "ASSIGNED_SELLER_OR_OWNER",
  principal: "SELLER_OR_OWNER",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: null,
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["prospectId", "senderIdentityRef", "purpose", "contentRef", "provenanceEvidenceHash"],
  stepUp: false,
});

export interface AuthorizeOutreachBody {
  readonly senderIdentityRef: string;
  readonly allowedContentHashes: ReadonlyArray<string>;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly maximumSends: number;
  readonly permissionEvidenceHash: string;
  readonly assuranceProofRef: string;
}
export const AUTHORIZE_OUTREACH = spec<AuthorizeOutreachBody>({
  id: "CMD062",
  name: "AuthorizeOutreach",
  method: "POST",
  path: "/api/v1/ops/outreach/authorizations",
  role: "OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: null,
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: ["permissionEvidenceHash"],
  fields: ["senderIdentityRef", "allowedContentHashes", "validFrom", "expiresAt", "maximumSends", "permissionEvidenceHash", "assuranceProofRef"],
  stepUp: true,
});

export interface SendAuthorizedOutreachBody {
  readonly expectedVersion: number;
  readonly authorizationId: string;
  readonly contentHash: string;
}
export const SEND_AUTHORIZED_OUTREACH = spec<SendAuthorizedOutreachBody>({
  id: "CMD063",
  name: "SendAuthorizedOutreach",
  method: "POST",
  path: "/api/v1/ops/outreach/{draftId}/send",
  role: "ASSIGNED_SELLER_OR_OWNER",
  principal: "SELLER_OR_OWNER",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: "draftId",
  scopeKind: null,
  expectedVersionRequired: true,
  authorityHashFields: ["contentHash"],
  fields: ["expectedVersion", "authorizationId", "contentHash"],
  stepUp: false,
});

export interface SalesActivityInput {
  readonly prospectId: string;
  readonly draftId?: string;
  readonly kind: "REPLIED" | "BOUNCED" | "SUPPRESSED" | "HUMAN_SEND_OBSERVED";
  readonly occurredAt: string;
  readonly evidenceHash: string;
  readonly providerMessageRef: string;
  readonly observation?: "SENT" | "NOT_SENT";
  readonly suppressionKeyKind?: "ORGANIZATION" | "CONTACT";
  readonly suppressionReason?: "OPT_OUT" | "COMPLAINT" | "REFUSAL" | "DISQUALIFIED";
}
export interface RecordSalesActivityBody {
  readonly activity: SalesActivityInput;
}
export const RECORD_SALES_ACTIVITY = spec<RecordSalesActivityBody>({
  id: "CMD064",
  name: "RecordSalesActivity",
  method: "POST",
  path: "/api/v1/ops/sales/activities",
  role: "ASSIGNED_SELLER_OWNER_OR_RECONCILER",
  principal: "SELLER_OR_OWNER",
  runtimeRole: "kauro_app",
  scope: "CORPORATE",
  aggregateParam: null,
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["activity"],
  stepUp: false,
});

/** The operations of plan companion §R that no catalogue id names: seller or owner (content, source, contact) and owner-only (the rest). */
function b12Operation<Body>(s: {
  readonly id: B12OperationId;
  readonly path: string;
  readonly owner: boolean;
  readonly aggregateParam?: string;
  readonly expectedVersionRequired?: boolean;
  readonly stepUp?: boolean;
  readonly fields: ReadonlyArray<keyof Body & string>;
}): CommercialCommandSpec<Body> {
  return spec<Body>({
    id: s.id,
    name: s.id,
    method: "POST",
    path: s.path,
    role: s.owner ? "KAURO_OWNER" : "ACTIVE_SELLER_OR_OWNER",
    principal: s.owner ? "CORPORATE_OPERATOR" : "SELLER_OR_OWNER",
    runtimeRole: "kauro_app",
    scope: "CORPORATE",
    aggregateParam: s.aggregateParam ?? null,
    scopeKind: null,
    expectedVersionRequired: s.expectedVersionRequired ?? false,
    authorityHashFields: [],
    fields: s.fields,
    stepUp: s.stepUp ?? false,
  });
}

export interface PutOutreachContentBody {
  readonly subject: string;
  readonly body: string;
}
export const PUT_OUTREACH_CONTENT = b12Operation<PutOutreachContentBody>({ id: "PutOutreachContent", path: "/api/v1/ops/outreach/contents", owner: false, fields: ["subject", "body"] });

export interface PublishSalesResourceBody {
  readonly familyId: string;
  /** The family's current version the publisher read; 0 publishes the first version of a new family. */
  readonly expectedVersion: number;
  readonly contentRef: string;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly assuranceProofRef: string;
}
export const PUBLISH_SALES_RESOURCE = b12Operation<PublishSalesResourceBody>({
  id: "PublishSalesResource",
  path: "/api/v1/ops/sales/resources",
  owner: true,
  expectedVersionRequired: true,
  stepUp: true,
  fields: ["familyId", "expectedVersion", "contentRef", "capabilityIds", "assuranceProofRef"],
});

export interface RegisterSenderIdentityBody {
  readonly userId: string;
  readonly address: string;
  readonly route: "GMAIL_API" | "RESEND_TRANSACTIONAL";
  readonly consentEvidenceRef?: string;
  readonly assuranceProofRef: string;
}
export const REGISTER_SENDER_IDENTITY = b12Operation<RegisterSenderIdentityBody>({
  id: "RegisterSenderIdentity",
  path: "/api/v1/ops/outreach/senders",
  owner: true,
  stepUp: true,
  fields: ["userId", "address", "route", "consentEvidenceRef", "assuranceProofRef"],
});

export interface VerifySenderIdentityBody {
  readonly verificationEvidenceHash: string;
}
export const VERIFY_SENDER_IDENTITY = b12Operation<VerifySenderIdentityBody>({
  id: "VerifySenderIdentity",
  path: "/api/v1/ops/outreach/senders/{senderId}/verify",
  owner: true,
  aggregateParam: "senderId",
  fields: ["verificationEvidenceHash"],
});

export type RecordSenderRevocationBody = Record<string, never>;
export const RECORD_SENDER_REVOCATION = b12Operation<RecordSenderRevocationBody>({
  id: "RecordSenderRevocation",
  path: "/api/v1/ops/outreach/senders/{senderId}/revoke",
  owner: true,
  aggregateParam: "senderId",
  fields: [],
});

export interface PrepareOutreachReviewBody {
  readonly senderIdentityRef: string;
  readonly draftIds: ReadonlyArray<string>;
  readonly assuranceProofRef: string;
}
export const PREPARE_OUTREACH_REVIEW = b12Operation<PrepareOutreachReviewBody>({
  id: "PrepareOutreachReview",
  path: "/api/v1/ops/outreach/reviews",
  owner: true,
  stepUp: true,
  fields: ["senderIdentityRef", "draftIds", "assuranceProofRef"],
});

export interface RecordOutreachDiagnosisBody {
  readonly personUserId: string;
  readonly evidenceHash: string;
  readonly assuranceProofRef: string;
}
export const RECORD_OUTREACH_DIAGNOSIS = b12Operation<RecordOutreachDiagnosisBody>({
  id: "RecordOutreachDiagnosis",
  path: "/api/v1/ops/outreach/diagnoses",
  owner: true,
  stepUp: true,
  fields: ["personUserId", "evidenceHash", "assuranceProofRef"],
});

export type RevokeOutreachAuthorizationBody = Record<string, never>;
export const REVOKE_OUTREACH_AUTHORIZATION = b12Operation<RevokeOutreachAuthorizationBody>({
  id: "RevokeOutreachAuthorization",
  path: "/api/v1/ops/outreach/authorizations/{authorizationId}/revoke",
  owner: true,
  aggregateParam: "authorizationId",
  fields: [],
});

export interface WithdrawOutreachChannelPolicyBody {
  readonly jurisdiction: string;
  readonly purpose: "REQUESTED_REPLY" | "INDIVIDUAL_PROSPECT_CONTACT" | "FOLLOW_UP";
  readonly expectedVersion: number;
  readonly assuranceProofRef: string;
}
export const WITHDRAW_OUTREACH_CHANNEL_POLICY = b12Operation<WithdrawOutreachChannelPolicyBody>({
  id: "WithdrawOutreachChannelPolicy",
  path: "/api/v1/ops/outreach/policy-withdrawals",
  owner: true,
  expectedVersionRequired: true,
  stepUp: true,
  fields: ["jurisdiction", "purpose", "expectedVersion", "assuranceProofRef"],
});

export interface RecordProspectSourceBody {
  readonly evidenceHash: string;
  readonly sourceUrlDigest: string;
  readonly observedOn: string;
  readonly lawfulBasis: string;
  readonly segment: "AGENCY" | "COMPANY";
}
export const RECORD_PROSPECT_SOURCE = b12Operation<RecordProspectSourceBody>({
  id: "RecordProspectSource",
  path: "/api/v1/ops/prospects/{prospectId}/sources",
  owner: false,
  aggregateParam: "prospectId",
  fields: ["evidenceHash", "sourceUrlDigest", "observedOn", "lawfulBasis", "segment"],
});

export interface RecordProspectContactBody {
  readonly contactLabel: string;
  readonly roleLabel?: string;
  readonly channel: string;
  readonly address: string;
}
export const RECORD_PROSPECT_CONTACT = b12Operation<RecordProspectContactBody>({
  id: "RecordProspectContact",
  path: "/api/v1/ops/prospects/{prospectId}/contacts",
  owner: false,
  aggregateParam: "prospectId",
  fields: ["contactLabel", "roleLabel", "channel", "address"],
});

/** The B12 routes of the kit, in registration order (CMD061..CMD064 first, then plan companion §R). */
export const B12_COMMERCIAL_COMMANDS = Object.freeze({
  CMD061: PREPARE_OUTREACH_DRAFT,
  CMD062: AUTHORIZE_OUTREACH,
  CMD063: SEND_AUTHORIZED_OUTREACH,
  CMD064: RECORD_SALES_ACTIVITY,
  PutOutreachContent: PUT_OUTREACH_CONTENT,
  PublishSalesResource: PUBLISH_SALES_RESOURCE,
  RegisterSenderIdentity: REGISTER_SENDER_IDENTITY,
  VerifySenderIdentity: VERIFY_SENDER_IDENTITY,
  RecordSenderRevocation: RECORD_SENDER_REVOCATION,
  PrepareOutreachReview: PREPARE_OUTREACH_REVIEW,
  RecordOutreachDiagnosis: RECORD_OUTREACH_DIAGNOSIS,
  RevokeOutreachAuthorization: REVOKE_OUTREACH_AUTHORIZATION,
  WithdrawOutreachChannelPolicy: WITHDRAW_OUTREACH_CHANNEL_POLICY,
  RecordProspectSource: RECORD_PROSPECT_SOURCE,
  RecordProspectContact: RECORD_PROSPECT_CONTACT,
} as const);

export const COMMERCIAL_COMMANDS = Object.freeze({
  CMD002: ACTIVATE_AGENCY,
  CMD027: CREATE_QUOTE,
  CMD043: CLOSE_AGENCY,
  CMD045: REGISTER_PROSPECT,
  CMD046: CLAIM_PROSPECT,
  CMD047: ACCEPT_ATTRIBUTION,
  CMD048: ASSIGN_ACCOUNT,
  CMD049: ACTIVATE_SELLER,
  CMD050: TERMINATE_SELLER,
  CMD051: CLOSE_COMMISSION_PERIOD,
  CMD052: APPROVE_COMMISSION_PAYOUT,
  CMD053: RECONCILE_COMMISSION_PAYOUT,
  CMD054: OPEN_BREAKGLASS,
  CMD055: REVOKE_BREAKGLASS,
  CMD056: RECORD_INCIDENT,
  CMD057: AUTHORIZE_RECOVERY,
  CMD058: CHANGE_CAPABILITY,
  CMD059: RESTRICT_CAPABILITY,
  ...B12_COMMERCIAL_COMMANDS,
  // package B12 lane L-OWNER: the owner tools (plan companion §P), journaled under their own names
  ...B12_PRODUCER_COMMANDS,
} as const);
