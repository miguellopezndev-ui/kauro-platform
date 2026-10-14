/**
 * The wire contract of the agency recurrence and commission domain (package B10; docs/design/B10-commercial-domain.md §13,
 * D10-API-1): the closed view definitions of every DTO the twelve commercial commands and the commission statement read answer,
 * the COMPLETED envelopes of the commands and the READ envelope of the statement — in the exact form of the B06 and B09 response
 * contracts (decision D-RESP-1): a view that projects a registry contract (Prospect, AttributionClaim, CommissionStatement) takes
 * every selected member from the generated registry bundle and withholds every other member with its reason; platform members are
 * declared in the field vocabulary of reference/FIELD_CONTRACTS.md; every object is closed.
 *
 * On top of the B06 forbidden members (tokens, secrets, proof references) this package forbids a set of its own
 * (COMMERCIAL_FORBIDDEN_MEMBERS): contact details, payout destination digests, bank and tax identifiers. A view that declared one
 * is refused when the schemas are built, so no route can ever serve it.
 *
 * `buildCommercialResponseSchemas` takes the definitions of the earlier packages (`shared`: B06, B07 and B09) so a view may
 * reference AgencyView and QuoteView without redeclaring them, and refuses a name that collides with a registry definition or with
 * an earlier package's, a name defined twice, a reference nothing defines, a forbidden member and an open object.
 */
import { DomainFailure, SERVICE_MODES } from "@kauro/domain";
import {
  FORBIDDEN_RESPONSE_FIELDS,
  RESPONSE_FIELD_VOCABULARY,
  RESPONSE_SCHEMA_PREFIX,
  declaredMembers,
  openObjects,
  viewSchemaOf,
  type JsonSchema,
  type RegistryBundle,
  type ViewDefinition,
} from "../api/response-schemas.js";
import { VIEW_MEMBER_KIT } from "../api/view-kit.js";
import { MONEY_PATTERN } from "../commerce/response-schemas.js";
import { COMMERCIAL_VIEW_VOCABULARY as V } from "./vocabulary.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const { ID, VERSION, HASH, UTC, COUNT, UUID_PATTERN } = RESPONSE_FIELD_VOCABULARY;
const { registry, platform, ref, NARROW_ID, NARROW_LABEL } = VIEW_MEMBER_KIT;
const MONEY = Object.freeze({ type: "string", pattern: MONEY_PATTERN });
const TOKEN = Object.freeze({ type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" });
const BPS = Object.freeze({ type: "integer", minimum: 0, maximum: 10000 });
/** A calendar date in the jurisdiction's calendar (YYYY-MM-DD), the shape of a due date and of a review date. */
const DATE = Object.freeze({ type: "string", pattern: "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$" });
/** A calendar version token: a recorded version of a banking calendar (D10-CAL-1). */
const CALENDAR_VERSION = Object.freeze({ type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" });
const BOOLEAN = Object.freeze({ type: "boolean" });
const NARROW_MONEY = Object.freeze({ maxLength: 16 });
const enumOf = (values: ReadonlyArray<string>): JsonSchema => ({ type: "string", enum: [...values] });
const CAPABILITY_STATES = ["DESIGN", "IMPLEMENTED_UNACCEPTED", "QUALIFIED_INTERNAL", "AVAILABLE_LIMITED", "AVAILABLE", "SUSPENDED"] as const;

/**
 * Member names no commercial response may declare, with the authority that forbids them. The B06 list applies too (tokens, secrets,
 * proof references); these are the members specific to this package's data: a seller's prospects, payout destinations and payees.
 */
export const COMMERCIAL_FORBIDDEN_MEMBERS: Readonly<Record<string, string>> = Object.freeze({
  destinationDigest: "D10-API-1 and D10-PAY-1: the payout destination is a stored, versioned record; only the provider evidence and the intent compare its digest, no caller reads it",
  payoutDestination: "D10-API-1: a payout destination is never answered, only whether one is verified",
  businessContactRef: "registry Prospect.businessContactRef \"Restricted contact record, not raw details in reports\"; D10-API-1",
  contactRef: "registry Prospect.businessContactRef \"Restricted contact record, not raw details in reports\"; D10-API-1",
  contactEmail: "owner manual 18: prospect data remains limited to lawful commercial context; contact details never leave the restricted record",
  contactPhone: "owner manual 18: prospect data remains limited to lawful commercial context; contact details never leave the restricted record",
  email: "owner manual 18: prospect data remains limited to lawful commercial context; contact details never leave the restricted record",
  phone: "owner manual 18: prospect data remains limited to lawful commercial context; contact details never leave the restricted record",
  telephone: "owner manual 18: prospect data remains limited to lawful commercial context; contact details never leave the restricted record",
  mobile: "owner manual 18: prospect data remains limited to lawful commercial context; contact details never leave the restricted record",
  bankAccount: "D10-API-1: no bank details in any commercial answer",
  bankAccountNumber: "D10-API-1: no bank details in any commercial answer",
  accountNumber: "D10-API-1: no bank details in any commercial answer",
  routingNumber: "D10-API-1: no bank details in any commercial answer",
  iban: "D10-API-1: no bank details in any commercial answer",
  taxIdentifier: "D10-API-1: a seller's or a buyer's tax identifier stays in the reviewed private record",
  taxId: "D10-API-1: a seller's or a buyer's tax identifier stays in the reviewed private record",
});

/** Every B10 DTO definition, in OpenAPI component order. Each is closed; a member not listed never reaches the wire. */
export const COMMERCIAL_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
  {
    name: "AgencyActivationView",
    description: "CMD002: the activated agency (B06 AgencyView), the instant the terms and privacy versions were accepted, and the service modes now offered.",
    contract: null,
    withheld: {},
    members: {
      agency: platform(true, ref("AgencyView"), "The agency in state ACTIVE, exactly as the B06 views answer it."),
      acceptedAt: platform(true, UTC, "The instant the terms version and the privacy agreement version were recorded as accepted."),
      offeredModes: platform(true, { type: "array", maxItems: SERVICE_MODES.length, items: enumOf(SERVICE_MODES) }, "The service modes the activated agency may be sold."),
    },
  },
  {
    name: "QuoteEligibilityView",
    description: "How the quote's discount was decided (design §3.2, §3.3; 16 \"the highest eligible rate, never a sum\"): the repeat lookback and the founding offer.",
    contract: null,
    withheld: {},
    members: {
      qualifyingProjectCount: platform(true, COUNT, "Qualifying completed purchases of this agency inside the lookback window."),
      repeatDiscountBps: platform(true, BPS, "The discount the repeat rule allowed, in basis points."),
      foundingOffer: platform(true, enumOf(V.foundingOffers), "What the founding offer did: reserved a slot, the agency was not eligible, or no slot remained."),
      appliedDiscountBps: platform(true, BPS, "The one discount applied to the quote: the highest eligible rate."),
      lookbackStartsAt: platform(true, UTC, "The start of the repeat lookback window."),
    },
  },
  {
    name: "QuoteReplacementView",
    description: "A superseded quote and the authorization its replacement revoked, when a new quote replaces one already paid (design §3.4).",
    contract: null,
    withheld: {},
    members: {
      replacedQuoteId: platform(true, ID, "The quote the new one replaces."),
      revokedAuthorizationId: platform(false, ID, "The commercial authorization revoked by the replacement; absent when the re-binding was refused."),
      approvalRequired: platform(true, BOOLEAN, "The new plan must be approved again before it can be paid."),
      outcome: platform(true, enumOf(["REBOUND", "WITHDRAWN"]), "REBOUND: the paid purchase stands on the replacement. WITHDRAWN: the payment service refused the re-binding and the replacement was withdrawn."),
      reason: platform(false, TOKEN, "The first blocker that refused the re-binding, as the payment service names it."),
    },
  },
  {
    name: "CreateQuoteView",
    description: "CMD027: the issued quote (B09 QuoteView), how its discount was decided, and any quote it superseded.",
    contract: null,
    withheld: {},
    members: {
      quote: platform(true, ref("QuoteView"), "The quote, exactly as the B09 views answer it."),
      eligibility: platform(true, ref("QuoteEligibilityView"), "The discount decision."),
      supersededQuoteId: platform(false, ID, "The still-open quote this one superseded."),
      replacement: platform(false, ref("QuoteReplacementView"), "Present when the new quote replaced a paid one."),
    },
  },
  {
    name: "AgencyClosureObligationsView",
    description: "What closing the agency left open, as counts and one amount (design §3.5): the owner sees how much remains, never another party's records.",
    contract: null,
    withheld: {},
    members: {
      openQuotesWithdrawn: platform(true, COUNT, "Open quotes withdrawn by the closure."),
      liveAuthorizations: platform(true, COUNT, "Commercial authorizations still live: their delivery is finished or refunded before deletion."),
      openRefunds: platform(true, COUNT, "Refunds not yet terminal."),
      nonTerminalTaxDocuments: platform(true, COUNT, "Tax documents not yet terminal."),
      openReconciliationCases: platform(true, COUNT, "Reconciliation cases still open."),
      activeWorkItems: platform(true, COUNT, "Work items still active."),
      openReconciliationCents: platform(true, MONEY, "The exact amount still under reconciliation, in minor units."),
    },
  },
  {
    name: "AgencyClosureView",
    description: "CMD043: the agency in state CLOSING, the closure request and its obligations.",
    contract: null,
    withheld: {},
    members: {
      agency: platform(true, ref("AgencyView"), "The agency, exactly as the B06 views answer it."),
      closureId: platform(true, ID, "The closure request."),
      requestedAt: platform(true, UTC, "The closure request instant."),
      obligations: platform(true, ref("AgencyClosureObligationsView"), "What the closure left open."),
      deletionScheduledFor: platform(false, UTC, "The instant the agency's data is scheduled for deletion, once no obligation remains."),
    },
  },
  {
    name: "ProspectView",
    description: "A prospect of the commercial pipeline (owner manual 18): limited to lawful commercial context; the restricted contact record it refers to is never answered.",
    contract: "Prospect",
    withheld: {
      businessContactRef: "Reference to the restricted contact record: contact details never leave it and are never named in a report (D10-API-1).",
    },
    members: {
      prospectId: registry(true, NARROW_ID),
      organizationLabel: registry(true, NARROW_LABEL),
      sourceEvidenceHash: registry(true),
      jurisdiction: registry(true, NARROW_LABEL),
      state: registry(true),
      suppressed: registry(true),
      ownerSellerId: registry(false, NARROW_ID),
    },
  },
  {
    name: "AttributionClaimView",
    description: "A seller's claim to a prospect (owner manual 17): accepted acquisition rights differ from current account servicing.",
    contract: "AttributionClaim",
    withheld: {},
    members: {
      claimId: registry(true, NARROW_ID),
      prospectId: registry(true, NARROW_ID),
      sellerId: registry(true, NARROW_ID),
      acceptedAt: registry(false),
      expiresAt: registry(true),
      evidenceHash: registry(true),
      state: registry(true),
      agreementVersion: registry(true, NARROW_LABEL),
      version: platform(true, VERSION, "Claim version."),
    },
  },
  {
    name: "AttributionView",
    description: "CMD047: the accepted claim and the allocation it created; the other claims are counted, never listed.",
    contract: null,
    withheld: {},
    members: {
      claim: platform(true, ref("AttributionClaimView"), "The accepted claim."),
      allocationId: platform(true, ID, "The share allocation created by the acceptance."),
      agencyId: platform(true, ID, "The agency the attribution binds."),
      decisionReason: platform(true, TOKEN, "Why this claim was accepted (a server token)."),
      beneficiaryCount: platform(true, COUNT, "How many sellers share the allocation."),
      rejectedClaimCount: platform(true, COUNT, "How many competing claims the acceptance rejected."),
    },
  },
  {
    name: "SalesAccountView",
    description: "CMD048: the agency's account assignment after the owner assigned a seller to service it.",
    contract: null,
    withheld: {},
    members: {
      agencyId: platform(true, ID, "The assigned agency."),
      version: platform(true, VERSION, "Assignment version."),
      sellerId: platform(true, ID, "The seller who services the account."),
      assignedAt: platform(true, UTC, "The assignment instant."),
      newWorkCompensation: platform(true, enumOf(V.newWorkCompensation), "Whether the new seller earns anything for new work of the account."),
      assistanceAgreementId: platform(false, ID, "The assistance agreement, present when new work is compensated as assistance."),
    },
  },
  {
    name: "SellerView",
    description: "CMD049: the seller after activation. Whether a payout destination is verified, never the destination.",
    contract: null,
    withheld: {},
    members: {
      sellerId: platform(true, ID, "The seller."),
      version: platform(true, VERSION, "Seller version."),
      state: platform(true, enumOf(V.sellerStates), "Seller lifecycle state: only ACTIVE may act."),
      agreementId: platform(true, ID, "The signed seller agreement."),
      classification: platform(true, enumOf(V.sellerClassifications), "The reviewed classification of the relationship."),
      activatedAt: platform(false, UTC, "The activation instant."),
      payoutDestinationVerified: platform(true, BOOLEAN, "A payout destination is verified for this seller; the destination itself is never answered."),
    },
  },
  {
    name: "SellerTerminationView",
    description: "CMD050: the terminated seller and what the termination did to the seller's claims, prospects, assignments and entitlements.",
    contract: null,
    withheld: {},
    members: {
      sellerId: platform(true, ID, "The terminated seller."),
      version: platform(true, VERSION, "Seller version."),
      state: platform(true, enumOf(V.sellerStates), "Seller lifecycle state after the command."),
      effectiveAt: platform(true, UTC, "The termination instant."),
      tailEndsAt: platform(true, UTC, "The instant the tail of residual entitlements ends."),
      tailEntries: platform(true, COUNT, "Entitlements that continue through the tail."),
      entitlementsResidual: platform(true, COUNT, "Entitlements that remain payable."),
      claimsExpired: platform(true, COUNT, "Claims the termination expired."),
      prospectsUnassigned: platform(true, COUNT, "Prospects returned to the pool."),
      assignmentsEnded: platform(true, COUNT, "Account assignments the termination ended."),
    },
  },
  {
    name: "CommissionPeriodView",
    description: "A commission period with the calendar it was closed against (design §8, D10-CAL-1). A period closed on a test fixture says so.",
    contract: null,
    withheld: {},
    members: {
      periodId: platform(true, ID, "The period."),
      version: platform(true, VERSION, "Period version."),
      periodStart: platform(true, UTC, "Inclusive period boundary."),
      periodEnd: platform(true, UTC, "Exclusive period boundary."),
      state: platform(true, enumOf(V.periodStates), "Period lifecycle state."),
      closeDueOn: platform(true, DATE, "The fifth banking day after the period end: when the close is due."),
      payDueOn: platform(true, DATE, "The tenth banking day after the period end: when payment is due."),
      calendarVersion: platform(true, CALENDAR_VERSION, "The banking calendar version the due dates were computed with."),
      calendarSource: platform(true, enumOf(V.calendarSources), "Where that calendar came from."),
      simulated: platform(true, BOOLEAN, "True when the calendar was the controlled test fixture: the dates are then a simulation, never a promise."),
    },
  },
  {
    name: "PeriodCloseView",
    description: "CMD051: the closed period and the close's totals. Per-seller rows are not a member: a seller reads only their own statement.",
    contract: null,
    withheld: {},
    members: {
      period: platform(true, ref("CommissionPeriodView"), "The period, CLOSED."),
      ledgerCutoffHash: platform(true, HASH, "The digest of the exact ledger the close computed over."),
      statementCount: platform(true, COUNT, "Statements the close issued."),
      payableTotalCents: platform(true, MONEY, "The total payable across the issued statements, in minor units."),
      heldTotalCents: platform(true, MONEY, "The total held across the issued statements, in minor units."),
      guardReviewCount: platform(true, COUNT, "Statements a guard held for review: a count, never the finding."),
    },
  },
  {
    name: "StatementItemView",
    description: "One commission line of a statement: the purchase's basis, the rate and share, the cumulative entitlement, what was paid before, the adjustment and what is held (design §6).",
    contract: null,
    withheld: {},
    members: {
      lineId: platform(true, ID, "The line."),
      agencyId: platform(true, ID, "The agency whose purchase the line commissions."),
      projectId: platform(true, ID, "The purchased project."),
      sequence: platform(true, enumOf(V.commissionSequences), "The agency's first qualifying purchase or a repeat."),
      netServiceBasisCents: platform(true, MONEY, "The net service basis in minor units: excess capture and tax are never basis."),
      rateBps: platform(true, BPS, "The commission rate in basis points."),
      shareBps: platform(true, BPS, "The seller's share of the entitlement in basis points."),
      cumulativeEntitlementCents: platform(true, MONEY, "The cumulative entitlement of the line, in minor units."),
      previouslyPaidCents: platform(true, MONEY, "What earlier statements already paid."),
      adjustmentCents: platform(true, MONEY, "The adjustment of this statement, in minor units."),
      adjustmentDirection: platform(false, enumOf(V.adjustmentDirections), "Whether the adjustment raises or lowers the payable amount; absent when there is none."),
      heldCents: platform(true, MONEY, "What is held from this line."),
      holdReason: platform(false, TOKEN, "Why an amount is held (a server token); present with a hold."),
      holdReviewOn: platform(false, DATE, "The date a hold is reviewed; present with a hold."),
      payableCents: platform(true, MONEY, "What this line pays."),
    },
  },
  {
    name: "StatementBalanceItemView",
    description: "An unrecovered balance a statement carries and what it waits on (design §6).",
    contract: null,
    withheld: {},
    members: {
      kind: platform(true, enumOf(V.balanceItemKinds), "What the balance waits on: an offset, a repayment review, a write-off or a dispute."),
      lineId: platform(true, ID, "The line the balance came from."),
      amountCents: platform(true, MONEY, "The balance in minor units."),
    },
  },
  {
    name: "CommissionStatementView",
    description: "A seller's own commission statement (owner manual 17): each project and adjustment revealed without exposing customer CRM data. The owner reads any; a seller reads only their own.",
    contract: "CommissionStatement",
    withheld: {},
    members: {
      statementId: registry(true, NARROW_ID),
      sellerId: registry(true, NARROW_ID),
      periodStart: registry(true),
      periodEnd: registry(true),
      lineIds: registry(true),
      payableCents: registry(true, NARROW_MONEY),
      heldCents: registry(true, NARROW_MONEY),
      state: registry(true),
      payoutEvidenceHash: registry(false),
      version: platform(true, VERSION, "Statement version."),
      periodId: platform(true, ID, "The commission period the statement belongs to."),
      items: platform(true, { type: "array", maxItems: 10000, items: ref("StatementItemView") }, "The statement's commission lines."),
      balanceItems: platform(true, { type: "array", maxItems: 1000, items: ref("StatementBalanceItemView") }, "The unrecovered balances the statement carries."),
      calendarVersion: platform(true, CALENDAR_VERSION, "The banking calendar version the period was closed against."),
      payDueOn: platform(true, DATE, "The payment due date."),
      simulated: platform(true, BOOLEAN, "True when the due dates rest on the controlled test fixture: the statement is then a simulation, never a promise."),
      issuedAt: platform(true, UTC, "The issuance instant."),
    },
  },
  {
    name: "PayoutIntentView",
    description: "CMD052: the payout the owner authorized — the statement's own amount under one reference. No destination and no destination digest (D10-PAY-1).",
    contract: null,
    withheld: {},
    members: {
      intentId: platform(true, ID, "The payout intent."),
      statementId: platform(true, ID, "The statement being paid."),
      state: platform(true, enumOf(V.payoutIntentStates), "Payout intent lifecycle: AUTHORIZED until the provider's evidence says otherwise."),
      amountCents: platform(true, MONEY, "The statement's payable amount, in minor units."),
      currency: platform(true, { type: "string", const: "USD" }, "The payout currency."),
      feeBearer: platform(true, { type: "string", const: "KAURO" }, "Kauro bears the provider's payout fee: the seller receives the whole amount."),
      reference: platform(true, { type: "string", pattern: `^kauro-payout-${UUID_PATTERN.slice(1)}` }, "The one reference the provider's evidence must name."),
      destinationVersion: platform(true, VERSION, "The version of the stored destination the intent is bound to; never the destination."),
      authorizedAt: platform(true, UTC, "The authorization instant."),
      version: platform(true, VERSION, "Intent version."),
      statementState: platform(true, enumOf(V.statementStates), "The statement's state after the authorization."),
    },
  },
  {
    name: "PayoutReconciliationView",
    description: "CMD053: the payout after the authenticated evidence was applied — the intent's and the statement's states and how many lines were paid or held.",
    contract: null,
    withheld: {},
    members: {
      intentId: platform(true, ID, "The payout intent."),
      statementId: platform(true, ID, "The statement."),
      intentState: platform(true, enumOf(V.payoutIntentStates), "The intent's state after the evidence."),
      statementState: platform(true, enumOf(V.statementStates), "The statement's state after the evidence."),
      payoutEvidenceHash: platform(false, HASH, "The digest of the settled evidence; present once a payout settled."),
      settledAt: platform(false, UTC, "The instant the provider says the payout settled."),
      linesPaid: platform(true, COUNT, "Lines the payout paid."),
      linesHeld: platform(true, COUNT, "Lines that remain held."),
      reviewOn: platform(false, DATE, "The date a failed or returned payout is reviewed."),
      version: platform(true, VERSION, "Intent version."),
    },
  },
  {
    name: "BreakglassGrantView",
    description: "CMD054: the breakglass grant as opened: one project, a bounded preview only, expiring 1800 seconds after the database's instant of its opening (08 Breakglass).",
    contract: null,
    withheld: {},
    members: {
      grantId: platform(true, ID, "The grant."),
      scopeRef: platform(true, ID, "The one project the grant covers."),
      agencyId: platform(true, ID, "The agency of that project."),
      purpose: platform(true, { type: "string", minLength: 1, maxLength: 200 }, "The purpose the owner recorded."),
      authorizationRef: platform(true, ID, "The support case or incident that justifies the grant."),
      authorizationKind: platform(true, enumOf(["SUPPORT_CASE", "INCIDENT"]), "What the authorization is."),
      state: platform(true, enumOf(["ACTIVE"]), "The grant state at its opening."),
      openedAt: platform(true, UTC, "The instant the database opened the grant."),
      expiresAt: platform(true, UTC, "The instant the grant expires (1800 seconds after its opening)."),
      access: platform(true, enumOf(["PREVIEW_ONLY"]), "What the grant reads: the bounded preview of the project's admitted tables, nothing else."),
      version: platform(true, VERSION, "The grant revision."),
    },
  },
  {
    name: "BreakglassRevocationView",
    description: "CMD055: the grant after its revocation. Every new read under it is refused at once; a bearer capability already issued may live until residualBearerUntil, which is never claimed to be zero.",
    contract: null,
    withheld: {},
    members: {
      grantId: platform(true, ID, "The revoked grant."),
      state: platform(true, enumOf(["REVOKED"]), "The grant state after the revocation."),
      revokedAt: platform(true, UTC, "The instant the database recorded the revocation."),
      refreshRevoked: platform(true, { type: "boolean", const: true }, "No new read or capability is issued under the grant."),
      residualBearerLifetimeSeconds: platform(true, { type: "integer", minimum: 1, maximum: 900 }, "The longest an already issued bearer capability may still live."),
      residualBearerUntil: platform(true, UTC, "revokedAt plus the residual bearer lifetime."),
      version: platform(true, VERSION, "The grant revision after the revocation."),
    },
  },
  {
    name: "BreakglassPreviewView",
    description: "The breakglass preview: a bounded sample of an admitted table of the grant's project (at most 20 rows of at most 50 cells of at most 200 characters), read by the grant's holder while it is live, every read recorded; never cached, never logged.",
    contract: null,
    withheld: {},
    members: {
      grantId: platform(true, ID, "The grant read under."),
      tableId: platform(true, ID, "The table."),
      fileId: platform(true, ID, "Its admitted file."),
      rows: platform(true, { type: "array", maxItems: 20, items: { type: "array", maxItems: 50, items: { type: ["string", "null"], maxLength: 200 } } }, "Decoded cell text per row, null for an empty cell; formula text is inert text."),
      truncated: platform(true, BOOLEAN, "Whether rows, columns or cells were cut to the bounds."),
      expiresAt: platform(true, UTC, "When the grant expires."),
    },
  },
  {
    name: "IncidentView",
    description: "CMD056: the incident as recorded. A false positive is CLOSED, says so in its severity and opens no responsibility; an actual incident is DETECTED with its open responsibilities and its next checkpoint.",
    contract: null,
    withheld: {},
    members: {
      incidentId: platform(true, ID, "The incident."),
      severity: platform(true, enumOf(["S1", "S2", "S3", "S4", "FALSE_POSITIVE"]), "The recorded severity, or FALSE_POSITIVE for a monitoring false positive."),
      state: platform(true, enumOf(["DETECTED", "CLOSED"]), "The incident phase at birth."),
      affectedScopeRefs: platform(true, { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } }, "The safe scope identifiers the incident affects."),
      communicationState: platform(true, enumOf(["NOT_REQUIRED", "REVIEW_REQUIRED"]), "Customer communication is reviewed by the owner for S1 and S2; nothing is sent automatically."),
      openResponsibilities: platform(true, { type: "array", maxItems: 3, items: enumOf(["CONTAINMENT", "RECOVERY", "COMMUNICATION"]) }, "The responsibilities still to be evidenced separately."),
      startedAt: platform(true, UTC, "The instant the database recorded the incident."),
      reviewAt: platform(true, UTC, "The next accountable checkpoint."),
    },
  },
  {
    name: "RecoveryAuthorizationView",
    description: "CMD057: the recovery authorized for a prepared restore candidate. The restore is run and released by the control plane after its integrity, tenant, deletion and financial checks.",
    contract: null,
    withheld: {},
    members: {
      recoveryId: platform(true, ID, "The recovery authorization."),
      restoreCandidateRef: platform(true, ID, "The restore candidate authorized."),
      state: platform(true, enumOf(["AUTHORIZED"]), "The recovery state."),
      authorizedAt: platform(true, UTC, "The instant the database recorded the authorization."),
      version: platform(true, VERSION, "The restore candidate version after the authorization."),
    },
  },
  {
    name: "CapabilityVersionView",
    description: "CMD058: the PROSPECTIVE version recorded for a capability. The capability state is shown and never moved by the command.",
    contract: null,
    withheld: {},
    members: {
      capabilityId: platform(true, ID, "The capability."),
      version: platform(true, VERSION, "The capability version (revision) the new prospective version reached."),
      status: platform(true, enumOf(["PROSPECTIVE"]), "A recorded version is PROSPECTIVE: it is not offered."),
      state: platform(true, enumOf(CAPABILITY_STATES), "The capability state, unchanged by the command."),
      profileHash: platform(true, HASH, "The profile hash of the version."),
      qualificationEvidenceCount: platform(true, COUNT, "How many qualification evidence hashes the version cites."),
      createdAt: platform(true, UTC, "The instant the database recorded the version."),
    },
  },
  {
    name: "CapabilityRestrictionView",
    description: "CMD059: the capability after its restriction. New admission is closed; no project row was changed.",
    contract: null,
    withheld: {},
    members: {
      capabilityId: platform(true, ID, "The restricted capability."),
      version: platform(true, VERSION, "The capability version (revision) after the restriction."),
      state: platform(true, enumOf(["SUSPENDED"]), "The capability state after the restriction."),
      priorState: platform(true, enumOf(CAPABILITY_STATES), "The state the capability left."),
      restrictionId: platform(true, ID, "The restriction evidence record."),
      incidentRef: platform(true, ID, "The incident the restriction names."),
      restrictedAt: platform(true, UTC, "The instant the database recorded the restriction."),
      newAdmissionBlocked: platform(true, BOOLEAN, "New admission of the capability is closed."),
    },
  },
] satisfies ReadonlyArray<ViewDefinition>);

/** The success reply of each B10 command: status and the view its COMPLETED envelope carries. B10 answers synchronously, except CMD027's replacement whose re-binding timed out (ACCEPTED). */
export const COMMERCIAL_COMMAND_RESPONSES = Object.freeze({
  CMD002: { status: 200, view: "AgencyActivationView", accepted: false },
  // an included replacement whose re-binding does not answer within its bound answers the retriable 202 (D10-GAP-6a, B10 REPL_TMO)
  CMD027: { status: 201, view: "CreateQuoteView", accepted: true },
  CMD043: { status: 200, view: "AgencyClosureView", accepted: false },
  CMD045: { status: 201, view: "ProspectView", accepted: false },
  CMD046: { status: 201, view: "AttributionClaimView", accepted: false },
  CMD047: { status: 200, view: "AttributionView", accepted: false },
  CMD048: { status: 200, view: "SalesAccountView", accepted: false },
  CMD049: { status: 200, view: "SellerView", accepted: false },
  CMD050: { status: 200, view: "SellerTerminationView", accepted: false },
  CMD051: { status: 200, view: "PeriodCloseView", accepted: false },
  CMD052: { status: 200, view: "PayoutIntentView", accepted: false },
  CMD053: { status: 200, view: "PayoutReconciliationView", accepted: false },
  CMD054: { status: 201, view: "BreakglassGrantView", accepted: false },
  CMD055: { status: 200, view: "BreakglassRevocationView", accepted: false },
  CMD056: { status: 201, view: "IncidentView", accepted: false },
  CMD057: { status: 200, view: "RecoveryAuthorizationView", accepted: false },
  CMD058: { status: 200, view: "CapabilityVersionView", accepted: false },
  CMD059: { status: 200, view: "CapabilityRestrictionView", accepted: false },
} as const);
export type CommercialServedCommandId = keyof typeof COMMERCIAL_COMMAND_RESPONSES;

/** The B10 read (design §13): the commission statement, the seller's own or any for the owner. */
export const COMMERCIAL_READ_ROUTES = Object.freeze({
  GetCommissionStatement: {
    path: "/api/v1/sales/statements/{statementId}",
    scope: "CORPORATE",
    role: "SELLER_OR_KAURO_OWNER",
    view: "CommissionStatementView",
    action: "READ_COMMISSION_STATEMENT",
    summary: "A commission statement with each project and adjustment; a seller reads only their own, the corporate owner reads any",
    authority: 'owner manual 17 "Statements reveal each project and adjustment without exposing customer CRM data"; design §13, D10-API-1',
  },
  PreviewTableUnderBreakglass: {
    path: "/api/v1/operations/breakglass-grants/{grantId}/tables/{tableId}/preview",
    scope: "CORPORATE",
    role: "KAURO_OWNER",
    view: "BreakglassPreviewView",
    action: "BREAKGLASS_PREVIEW",
    summary: "The bounded preview of an admitted table of the project a live breakglass grant covers, read by the grant's holder and recorded",
    authority: '08 "Breakglass": short-lived audited least-privilege access; registry CMD054 effect, case S071; mandate B16-REST-PLAN §2 GAP-BG-1..8',
  },
} as const);
export type CommercialReadOperationId = keyof typeof COMMERCIAL_READ_ROUTES;

export function commercialCommandResponseSchemaId(command: CommercialServedCommandId): string {
  return `${RESPONSE_SCHEMA_PREFIX}${command}`;
}

export function commercialReadResponseSchemaId(operationId: CommercialReadOperationId): string {
  return `${RESPONSE_SCHEMA_PREFIX}read:${operationId}`;
}

function refuse(message: string): never {
  throw new DomainFailure("INTEGRITY_FAILURE", `commercial response schemas: ${message}`);
}

function completedEnvelope(command: CommercialServedCommandId): JsonSchema {
  return {
    $schema: DIALECT,
    $id: commercialCommandResponseSchemaId(command),
    title: `${command} COMPLETED`,
    description: "Synchronous success: the validated DTO and the version of the aggregate the command edited or created (10 \"Responses and safe errors\"); replayed is true when an idempotent replay returned the journaled result (10 \"Idempotency contract\").",
    type: "object",
    additionalProperties: false,
    required: ["kind", "version", "replayed", "data"],
    properties: {
      kind: { type: "string", const: "COMPLETED" },
      version: VERSION,
      replayed: { type: "boolean" },
      data: ref(COMMERCIAL_COMMAND_RESPONSES[command].view),
    },
  };
}

function readEnvelope(operationId: CommercialReadOperationId): JsonSchema {
  return {
    $schema: DIALECT,
    $id: commercialReadResponseSchemaId(operationId),
    title: `${operationId} READ`,
    description: "A read: the safe projection the caller may see, with the version of every resource that edits compare (10).",
    type: "object",
    additionalProperties: false,
    required: ["kind", "data"],
    properties: { kind: { type: "string", const: "READ" }, data: ref(COMMERCIAL_READ_ROUTES[operationId].view) },
  };
}

/** Every `$ref` target name a schema mentions (`#/$defs/Name`). */
function referencedDefinitions(schema: unknown): ReadonlyArray<string> {
  const found: string[] = [];
  const walk = (s: unknown): void => {
    if (Array.isArray(s)) {
      s.forEach(walk);
      return;
    }
    if (typeof s !== "object" || s === null) return;
    for (const [k, v] of Object.entries(s)) {
      if (k === "$ref" && typeof v === "string") found.push(v.replace(/^#\/\$defs\//, ""));
      else if (k !== "enum" && k !== "const") walk(v);
    }
  };
  walk(schema);
  return found;
}

/**
 * The B10 schemas, derived and checked under the B06 rules. `shared` holds the definitions of the earlier packages (B06, B07 and B09
 * views) that these views may reference. Refuses a name that collides with a registry or an earlier package's definition, a name
 * defined twice, a reference nothing defines, a forbidden member (the B06 list and COMMERCIAL_FORBIDDEN_MEMBERS) and an open object.
 */
export function buildCommercialResponseSchemas(
  bundle: RegistryBundle,
  shared: Readonly<Record<string, JsonSchema>>,
  views: ReadonlyArray<ViewDefinition> = COMMERCIAL_VIEW_DEFINITIONS,
): { readonly defs: Readonly<Record<string, JsonSchema>>; readonly roots: Readonly<Record<string, JsonSchema>> } {
  const defs: Record<string, JsonSchema> = {};
  for (const view of views) {
    if (view.name in bundle.$defs) refuse(`view ${view.name} collides with a registry definition`);
    if (view.name in shared) refuse(`view ${view.name} collides with an earlier package's definition`);
    if (view.name in defs) refuse(`view ${view.name} is defined twice`);
    defs[view.name] = viewSchemaOf(bundle, view);
  }
  const roots: Record<string, JsonSchema> = {};
  for (const command of Object.keys(COMMERCIAL_COMMAND_RESPONSES) as CommercialServedCommandId[]) {
    if (!(COMMERCIAL_COMMAND_RESPONSES[command].view in defs)) refuse(`${command} names an unknown view`);
    roots[commercialCommandResponseSchemaId(command)] = completedEnvelope(command);
  }
  for (const operationId of Object.keys(COMMERCIAL_READ_ROUTES) as CommercialReadOperationId[]) {
    if (!(COMMERCIAL_READ_ROUTES[operationId].view in defs)) refuse(`${operationId} names an unknown view`);
    roots[commercialReadResponseSchemaId(operationId)] = readEnvelope(operationId);
  }
  const forbidden: Readonly<Record<string, string>> = { ...FORBIDDEN_RESPONSE_FIELDS, ...COMMERCIAL_FORBIDDEN_MEMBERS };
  for (const [where, schema] of [...Object.entries(defs), ...Object.entries(roots)]) {
    for (const member of declaredMembers(schema)) {
      if (member.name in forbidden) refuse(`${where}${member.path} declares the forbidden member ${member.name} (${forbidden[member.name]})`);
    }
    for (const name of referencedDefinitions(schema)) {
      if (!(name in defs) && !(name in shared) && !(name in bundle.$defs)) refuse(`${where} references ${name}, which no definition provides`);
    }
    const open = openObjects(schema);
    if (open.length > 0) refuse(`${where} is not closed at ${open.join(", ")}`);
  }
  return { defs, roots };
}
