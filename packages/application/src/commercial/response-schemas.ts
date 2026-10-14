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
import { DRAFT_STATES, DomainFailure, INTENT_STATES, OUTREACH_PURPOSES, SENDER_ROUTES, SENDER_STATES, SERVICE_MODES } from "@kauro/domain";
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
const { ID, VERSION, HASH, UTC, COUNT, LABEL, UUID_PATTERN } = RESPONSE_FIELD_VOCABULARY;
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

/** Content references are the hex SHA-256 of the stored subject and body (0088 outreach_contents.content_id), not a UUID. */
const CONTENT_REF = Object.freeze({ type: "string", pattern: "^[0-9a-f]{64}$" });
const SALES_ACTIVITY_KINDS = ["REPLIED", "BOUNCED", "SUPPRESSED", "HUMAN_SEND_OBSERVED", "PROVIDER_ACCEPTED", "SEND_UNCERTAIN"] as const;

/**
 * Package B12 (outreach) views, registered once by the kit (K2) so that the lanes replace handler bodies and never edit this table. No view
 * carries a recipient address, a subject, a body, a preview or a token: the draft and the review answer ids, hashes, states and counts
 * (plan A17; the contact label of a review item is the seller's own label for the contact, never the address).
 */
export const B12_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
  {
    name: "OutreachDraftView",
    description: "CMD061 and GetOutreachDraft: a versioned outreach draft and its content binding (registry OutreachDraft). Editing a draft never sends it and implies no recipient permission.",
    contract: null,
    withheld: {},
    members: {
      draftId: platform(true, ID, "Stable draft identity."),
      prospectId: platform(true, ID, "The prospect the draft is addressed to."),
      senderIdentityRef: platform(true, ID, "The registered human sender."),
      purpose: platform(true, enumOf(OUTREACH_PURPOSES), "The reviewed contact purpose."),
      contentHash: platform(true, HASH, "The exact binding of recipient, sender, purpose and content."),
      contentRef: platform(true, CONTENT_REF, "The stored outreach content (subject and body), never raw customer CRM."),
      provenanceEvidenceHash: platform(true, HASH, "The prospect source evidence the draft rests on."),
      version: platform(true, VERSION, "Optimistic concurrency boundary."),
      state: platform(true, enumOf(DRAFT_STATES), "The observed send state of the draft."),
      createdAt: platform(true, UTC, "The instant the database recorded the draft."),
    },
  },
  {
    name: "OutreachAuthorizationView",
    description: "CMD062 and RevokeOutreachAuthorization: the owner's bounded, revocable grant over sealed drafts (registry OutreachAuthorization).",
    contract: null,
    withheld: {},
    members: {
      authorizationId: platform(true, ID, "Immutable grant identity."),
      grantingActorId: platform(true, ID, "The authenticated owner who granted it."),
      senderIdentityRef: platform(true, ID, "The permitted sender."),
      allowedContentHashes: platform(true, { type: "array", minItems: 1, maxItems: 100, items: HASH }, "The sealed recipient and content bindings."),
      validFrom: platform(true, UTC, "Inclusive beginning (clamped to the database instant when earlier)."),
      expiresAt: platform(true, UTC, "Exclusive deadline."),
      maximumSends: platform(true, COUNT, "Bounded positive maximum, no greater than the sealed drafts."),
      permissionEvidenceHash: platform(true, HASH, "The digest of the server-issued review the owner confirmed."),
      policyVersion: platform(true, { type: "string", minLength: 1, maxLength: 64 }, "The applicable provider, suppression and contact policy."),
      revoked: platform(true, BOOLEAN, "Current server-observed revocation, checked at dispatch."),
    },
  },
  {
    name: "OutreachSendView",
    description: "CMD063: the fenced send intent queued for a sealed draft. Delivery is never inferred: the draft moves to AUTHORIZED here and to its provider states later.",
    contract: null,
    withheld: {},
    members: {
      draftId: platform(true, ID, "The draft."),
      draftState: platform(true, enumOf(DRAFT_STATES), "The draft state after the command."),
      intentId: platform(true, ID, "The queued send intent."),
      intentState: platform(true, enumOf(INTENT_STATES), "The intent state after the command (QUEUED)."),
      authorizationId: platform(true, ID, "The grant the intent is counted against."),
      payloadHash: platform(true, HASH, "The hash of the exact message the dispatcher submits."),
      queuedAt: platform(true, UTC, "The instant the database queued the intent."),
    },
  },
  {
    name: "SalesActivityView",
    description: "CMD064 and ListSalesActivities: one deduplicated, evidence-backed commercial activity (registry SalesActivity). Submission, receipt and customer response are different facts.",
    contract: null,
    withheld: {},
    members: {
      activityId: platform(true, ID, "Unique activity event."),
      prospectId: platform(true, ID, "The scoped prospect."),
      draftId: platform(false, ID, "The bound draft, when the activity belongs to one."),
      authorizationId: platform(false, ID, "The grant applied to the event, when one was."),
      kind: platform(true, enumOf(SALES_ACTIVITY_KINDS), "The exact evidence class."),
      occurredAt: platform(true, UTC, "The observed event time."),
      evidenceHash: platform(true, HASH, "The minimal safe supporting record."),
      providerMessageRef: platform(true, { type: "string", minLength: 1, maxLength: 200 }, "The opaque external identity, or NONE for a local suppression."),
      recordedAt: platform(true, UTC, "The instant the database recorded the activity."),
    },
  },
  {
    name: "SalesActivityListView",
    description: "ListSalesActivities: the newest activities of one prospect the caller may see, at most 200.",
    contract: null,
    withheld: {},
    members: { items: platform(true, { type: "array", maxItems: 200, items: ref("SalesActivityView") }, "The activities, newest first.") },
  },
  {
    name: "OutreachContentView",
    description: "PutOutreachContent: the stored outreach content, addressed by the hash of its subject and body. The same body stored twice is the same record.",
    contract: null,
    withheld: {},
    members: {
      contentRef: platform(true, CONTENT_REF, "The content-addressed reference."),
      createdAt: platform(true, UTC, "The instant the content was first stored."),
    },
  },
  {
    name: "SalesResourceView",
    description: "PublishSalesResource and GetSalesResource: one version of an approved sales resource. Superseded copy cannot be used in a new draft (R2-135).",
    contract: null,
    withheld: {},
    members: {
      resourceId: platform(true, ID, "This version of the resource."),
      familyId: platform(true, ID, "The resource family."),
      version: platform(true, VERSION, "The version inside the family."),
      state: platform(true, enumOf(["CURRENT", "SUPERSEDED"]), "CURRENT is the one version drafts may cite."),
      contentRef: platform(true, CONTENT_REF, "The stored content of this version."),
      capabilityIds: platform(true, { type: "array", maxItems: 50, items: ID }, "The capabilities the resource describes."),
      createdAt: platform(true, UTC, "The instant the version was published."),
    },
  },
  {
    name: "SenderIdentityView",
    description: "RegisterSenderIdentity, VerifySenderIdentity and RecordSenderRevocation: a registered human sender. The mailbox address is never answered.",
    contract: null,
    withheld: {},
    members: {
      senderId: platform(true, ID, "The sender identity."),
      userId: platform(true, ID, "The person the mailbox belongs to."),
      route: platform(true, enumOf(SENDER_ROUTES), "The send route: only GMAIL_API carries outreach (R2-131)."),
      state: platform(true, enumOf(SENDER_STATES), "PENDING_VERIFICATION, VERIFIED or REVOKED."),
      createdAt: platform(true, UTC, "The instant the sender was registered."),
      updatedAt: platform(true, UTC, "The instant of its last state change."),
    },
  },
  {
    name: "OutreachReviewItemView",
    description: "One draft line of an outreach review: the exact draft version and content binding the owner is shown.",
    contract: null,
    withheld: {},
    members: {
      draftId: platform(true, ID, "The draft."),
      draftVersion: platform(true, VERSION, "The draft version shown."),
      contentHash: platform(true, HASH, "The binding shown."),
      contactLabel: platform(true, LABEL, "The seller's own label for the recipient contact."),
    },
  },
  {
    name: "OutreachReviewView",
    description: "PrepareOutreachReview and GetOutreachReview: the server-issued review the owner confirms; its digest is the permission evidence of CMD062. Single use, short lived.",
    contract: null,
    withheld: {},
    members: {
      reviewId: platform(true, ID, "The review."),
      senderIdentityRef: platform(true, ID, "The sender every item belongs to."),
      digest: platform(true, HASH, "The digest of the exact items shown: the permissionEvidenceHash CMD062 carries."),
      issuedAt: platform(true, UTC, "The instant the database issued it."),
      expiresAt: platform(true, UTC, "The instant it stops being usable."),
      items: platform(true, { type: "array", minItems: 1, maxItems: 100, items: ref("OutreachReviewItemView") }, "The drafts shown."),
    },
  },
  {
    name: "OutreachChannelPolicyView",
    description: "WithdrawOutreachChannelPolicy: the policy of one jurisdiction and purpose after the owner withdrew it. Withdrawn means no new outreach intent for that recipient.",
    contract: null,
    withheld: {},
    members: {
      jurisdiction: platform(true, LABEL, "The jurisdiction of the policy."),
      purpose: platform(true, enumOf(OUTREACH_PURPOSES), "The purpose of the policy."),
      version: platform(true, VERSION, "The policy version."),
      state: platform(true, enumOf(["IN_FORCE", "WITHDRAWN"]), "The policy state after the command."),
    },
  },
  {
    name: "OutreachDiagnosisView",
    description: "RecordOutreachDiagnosis: the owner's recorded diagnosis that lifts a person's health pause.",
    contract: null,
    withheld: {},
    members: {
      diagnosisId: platform(true, ID, "The diagnosis record."),
      personUserId: platform(true, ID, "The person whose pause it lifts."),
      recordedAt: platform(true, UTC, "The instant the database recorded it."),
    },
  },
  {
    name: "OutreachMetricsView",
    description: "GetOutreachMetrics: counts of what was observed. None names delivered: delivery is never known.",
    contract: null,
    withheld: {},
    members: {
      accepted: platform(true, COUNT, "Sends the provider accepted."),
      uncertain: platform(true, COUNT, "Sends whose provider answer is unknown."),
      observedSent: platform(true, COUNT, "Sends a person observed as sent."),
      bounced: platform(true, COUNT, "Bounces recorded."),
      replied: platform(true, COUNT, "Customer replies recorded."),
      acceptedLessKnownBounces: platform(true, COUNT, "Accepted sends less the bounces known."),
      pauseNumerator: platform(true, COUNT, "Bounces in the person's latest sends."),
      pauseDenominator: platform(true, COUNT, "The sends the pause rule looks at."),
    },
  },
  {
    name: "ProspectSourceView",
    description: "RecordProspectSource: the source evidence recorded for a prospect (observation date, segment and lawful basis; never the source URL).",
    contract: null,
    withheld: {},
    members: {
      evidenceId: platform(true, ID, "The evidence record."),
      evidenceHash: platform(true, HASH, "The evidence hash CMD045 and CMD061 cite."),
      observedOn: platform(true, DATE, "The day the source was observed."),
      segment: platform(true, enumOf(["AGENCY", "COMPANY"]), "The buyer segment of the source."),
      createdAt: platform(true, UTC, "The instant the evidence was recorded."),
    },
  },
  {
    name: "ProspectContactView",
    description: "RecordProspectContact: the restricted contact record created for a prospect. Its address and key never leave the restricted record.",
    contract: null,
    withheld: {},
    members: {
      contactId: platform(true, ID, "The contact record."),
      channel: platform(true, TOKEN, "The channel of the contact."),
      createdAt: platform(true, UTC, "The instant the contact was recorded."),
    },
  },
  {
    name: "SellerHomeStatementView",
    description: "GetSellerHome: one statement line of the seller's home (the amounts of the seller's own statement; never a customer, a contact or a destination).",
    contract: null,
    withheld: {},
    members: {
      statementId: platform(true, ID, "The seller's own statement."),
      periodStart: platform(true, DATE, "First day of the statement's period."),
      periodEnd: platform(true, DATE, "Last day of the statement's period."),
      state: platform(true, enumOf(V.statementStates), "The statement's lifecycle state."),
      payableCents: platform(true, MONEY, "The statement's payable amount, in minor units."),
      heldCents: platform(true, MONEY, "The held amount, in minor units."),
    },
  },
  {
    name: "SellerHomeView",
    description: "GetSellerHome: what a seller (ACTIVE, SUSPENDED or TERMINATED) sees first: its state, the actions that state permits, its own statements and the support route (R2-066). No prospect, contact, draft or other seller's data.",
    contract: null,
    withheld: {},
    members: {
      sellerState: platform(true, enumOf(["ACTIVE", "SUSPENDED", "TERMINATED"]), "The seller's lifecycle state."),
      permittedActions: platform(true, { type: "array", maxItems: 20, items: TOKEN }, "The actions the state permits; empty for a TERMINATED seller (statements and support only)."),
      statements: platform(true, { type: "array", maxItems: 500, items: ref("SellerHomeStatementView") }, "The seller's own statements, newest first."),
      supportRoute: platform(true, { type: ["string", "null"], maxLength: 254 }, "The configured support route, or null when none is configured (shown as not configured)."),
    },
  },
] satisfies ReadonlyArray<ViewDefinition>);

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
  ...B12_VIEW_DEFINITIONS,
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
  // package B12 (outreach; K2): CMD061..CMD064 and the registry-less operations of plan companion §R, all synchronous
  CMD061: { status: 201, view: "OutreachDraftView", accepted: false },
  CMD062: { status: 201, view: "OutreachAuthorizationView", accepted: false },
  CMD063: { status: 200, view: "OutreachSendView", accepted: false },
  CMD064: { status: 201, view: "SalesActivityView", accepted: false },
  PutOutreachContent: { status: 201, view: "OutreachContentView", accepted: false },
  PublishSalesResource: { status: 201, view: "SalesResourceView", accepted: false },
  RegisterSenderIdentity: { status: 201, view: "SenderIdentityView", accepted: false },
  VerifySenderIdentity: { status: 200, view: "SenderIdentityView", accepted: false },
  RecordSenderRevocation: { status: 200, view: "SenderIdentityView", accepted: false },
  PrepareOutreachReview: { status: 201, view: "OutreachReviewView", accepted: false },
  RecordOutreachDiagnosis: { status: 201, view: "OutreachDiagnosisView", accepted: false },
  RevokeOutreachAuthorization: { status: 200, view: "OutreachAuthorizationView", accepted: false },
  WithdrawOutreachChannelPolicy: { status: 200, view: "OutreachChannelPolicyView", accepted: false },
  RecordProspectSource: { status: 201, view: "ProspectSourceView", accepted: false },
  RecordProspectContact: { status: 201, view: "ProspectContactView", accepted: false },
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
  // package B12 (outreach; K2): plan §2 "Reads" (DENY wrong role 403, foreign 404 = unknown)
  GetOutreachDraft: {
    path: "/api/v1/ops/outreach/drafts/{draftId}",
    scope: "CORPORATE",
    role: "ASSIGNED_SELLER_OR_KAURO_OWNER",
    view: "OutreachDraftView",
    action: "READ_OUTREACH_DRAFT",
    summary: "An outreach draft with its state; the assigned seller reads its own, the corporate owner reads any",
    authority: "owner manual 12 \"Outreach workspace\"; registry OutreachDraft; B12 plan §2 Reads",
  },
  GetOutreachReview: {
    path: "/api/v1/ops/outreach/reviews/{reviewId}",
    scope: "CORPORATE",
    role: "KAURO_OWNER",
    view: "OutreachReviewView",
    action: "READ_OUTREACH_REVIEW",
    summary: "The server-issued review the owner confirms before authorizing outreach",
    authority: "owner manual 18 \"Communication compliance\"; B12 plan A16, §2 Reads",
  },
  ListSalesActivities: {
    path: "/api/v1/ops/sales/prospects/{prospectId}/activities",
    scope: "CORPORATE",
    role: "ASSIGNED_SELLER_OR_KAURO_OWNER",
    view: "SalesActivityListView",
    action: "READ_SALES_ACTIVITIES",
    summary: "The newest commercial activities of one prospect (at most 200); a seller reads its own prospect's, the corporate owner any",
    authority: "owner manual 12 \"Outreach workspace\"; registry SalesActivity; B12 plan §2 Reads",
  },
  GetOutreachMetrics: {
    path: "/api/v1/ops/outreach/metrics",
    scope: "CORPORATE",
    role: "ASSIGNED_SELLER_OR_KAURO_OWNER",
    view: "OutreachMetricsView",
    action: "READ_OUTREACH_METRICS",
    summary: "Counts of what was observed (accepted, uncertain, observed sent, bounced, replied); none names delivered",
    authority: "owner manual 18 \"Outreach cadence and health\"; B12 plan §2 Reads",
  },
  GetSalesResource: {
    path: "/api/v1/ops/sales/resources/{resourceId}",
    scope: "CORPORATE",
    role: "SELLER_OR_KAURO_OWNER",
    view: "SalesResourceView",
    action: "READ_SALES_RESOURCE",
    summary: "One version of an approved sales resource and whether it is still current",
    authority: "owner manual 12 \"Resources and training\"; R2-135; B12 plan §2 Reads",
  },
  // package B12 lane L-HOME (R2-066): the seller's home, served to a seller in any state
  GetSellerHome: {
    path: "/api/v1/sales/home",
    scope: "CORPORATE",
    role: "OWN_SELLER_ANY_STATE",
    view: "SellerHomeView",
    action: "READ_SELLER_HOME",
    summary: "The seller's home: its state, permitted actions, own statements and support route; a terminated seller keeps it",
    authority: "owner manual 12 \"Seller onboarding and access lifecycle\"; R2-066; B12 plan §2 Reads",
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
