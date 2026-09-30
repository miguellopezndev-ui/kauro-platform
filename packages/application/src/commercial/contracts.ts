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
} from "./views.js";

export type CommercialCommandId = "CMD002" | "CMD027" | "CMD043" | "CMD045" | "CMD046" | "CMD047" | "CMD048" | "CMD049" | "CMD050" | "CMD051" | "CMD052" | "CMD053";

export type CommercialPrincipalKind = "AGENCY_MEMBER" | "SELLER" | "SELLER_OR_OWNER" | "CORPORATE_OPERATOR" | "COMMERCIAL_SERVICE";

export type CommercialScope = "AGENCY_PATH" | "AGENCY_HEADER" | "CORPORATE" | "STORED_OPERATION";

export interface CommercialCommandSpec<Body> {
  readonly id: CommercialCommandId;
  readonly name: string;
  readonly method: "POST";
  readonly path: string;
  /** The catalogue role (commands.json through @kauro/contracts, brand-mapped: KAURO_OWNER). */
  readonly role: "AGENCY_OWNER" | "AGENCY_BILLING" | "ACTIVE_SELLER_OR_OWNER" | "ACTIVE_SELLER" | "KAURO_OWNER" | "COMMISSION_SERVICE" | "FINANCE_SERVICE";
  readonly principal: CommercialPrincipalKind;
  /**
   * The database role of the command's unit of work: kauro_app for a request handler (TENANT for an agency member, OPERATOR for a
   * seller or the owner) and kauro_commission for the two services (D10-CTX-2).
   */
  readonly runtimeRole: "kauro_app" | "kauro_commission";
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
} as const);
