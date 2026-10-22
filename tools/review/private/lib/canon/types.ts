// The shapes of Kauro's canonical synthetic world (Order 11 round 3, master plan §2.1). One world, typed and frozen, that every screen and
// every document renders from. Money is always USD minor units (integers); tax is always a separate figure and never part of revenue.
// Instants are ISO 8601 in UTC ("2026-10-22T14:00:00Z"); calendar days are ISO dates ("2026-10-22"), read on the Bogotá calendar.
// Nothing here imports the web's types, so the module runs under Node's type stripping as well as under the review's tsc.

export type Service = "CLEAN" | "HUBSPOT" | "SALESFORCE";
export type Role = "OWNER" | "ADMIN" | "OPERATOR" | "APPROVER" | "BILLING" | "VIEWER";

/** The fine steps of the project path, in order (the brief's list). A project's `step` is where it is now. */
export const STEPS = [
  "SOURCES",
  "SELECTION",
  "SEAL",
  "TARGET",
  "CHECK",
  "MAPPING",
  "DUPLICATES",
  "RELATIONSHIPS",
  "APPROVAL",
  "QUOTE",
  "PAYMENT",
  "PROCESSING",
  "DELIVERY",
  "IMPORT",
  "RECEIPT",
  "RETENTION",
] as const;
export type Step = (typeof STEPS)[number];

/** The six stages the board and How it works name; each fine step belongs to one. */
export type BoardStage = "files" | "check" | "plan" | "purchase" | "preparation" | "delivery";

/** The kinds of object a source file or an output holds (the destination's own words are the screens' business). */
export type ObjectKind = "CONTACTS" | "COMPANIES" | "ACCOUNTS" | "OPPORTUNITIES" | "CONTACT_ROLES" | "DEALS";

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface Owner extends Person {
  readonly origin: "OPS";
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** AGENCY works for clients; COMPANY buys for its own data; EXAMPLE is the read-only synthetic workspace every account can open. */
  readonly kind: "AGENCY" | "COMPANY" | "EXAMPLE";
  readonly state: "ACTIVE" | "RESTRICTED" | "DRAFT";
  /** Why the workspace is restricted, in neutral words, or null. */
  readonly restriction: string | null;
  readonly createdAt: string;
  /** ISO 3166-1 alpha-2 country of the buyer; it decides the tax line (Colombia: IVA 19%; an export of services: none). */
  readonly country: string;
  readonly taxRateBps: number;
  /** The seller whose accepted claim converted on this customer's first payment, or null (direct). */
  readonly acquiredBySellerId: string | null;
  /** The seller who serves it now, or null when the owner does. */
  readonly servedBySellerId: string | null;
  /** The attribution claim behind the acquisition, or null. */
  readonly claimId: string | null;
}

export interface Membership {
  readonly personId: string;
  readonly workspaceId: string;
  readonly role: Role;
  readonly state: "ACTIVE" | "SUSPENDED";
  readonly since: string;
}

export interface Client {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  /** True when the client is the company itself (a company buying for its own data). */
  readonly self: boolean;
}

export interface SourceFile {
  readonly name: string;
  readonly object: ObjectKind;
  /** Rows counted in the file; null while the upload is still running. */
  readonly rows: number | null;
  /** Whether the team selected it into the set that is (or will be) sealed. */
  readonly selected: boolean;
}

/** Duplicate candidate groups of one object, and what the approved plan unifies. */
export interface DuplicateResult {
  readonly object: ObjectKind;
  /** The group detail, or null where only the unified count is published (the public sample's companies). */
  readonly groups: {
    readonly pairs: number;
    readonly triples: number;
    readonly keptApartPairs: number;
    readonly keptApartTriples: number;
    /** Groups demonstrated (same email and name, no blocking conflict), or null when not counted. */
    readonly demonstrated: number | null;
    /** True once every group is decided (approved to unify or kept apart). */
    readonly decided: boolean;
  } | null;
  /** Rows unified into another row with approval; null until every group is decided. */
  readonly unifiedRows: number | null;
}

export interface Relationships {
  readonly child: ObjectKind;
  readonly parent: ObjectKind;
  /** Child rows after unification that point to a parent row, and those that do not. */
  readonly linked: number;
  readonly unlinked: number;
}

export interface OutputFile {
  readonly name: string;
  readonly object: ObjectKind;
  readonly sourceRows: number;
  readonly unifiedRows: number;
  readonly rows: number;
}

export interface ImportStage {
  readonly order: number;
  readonly object: ObjectKind;
  readonly rows: number;
  readonly state: "WAITING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
  /** Rows the destination accepted and refused, once the team returns its result; null while waiting. */
  readonly succeeded: number | null;
  readonly failed: number | null;
  readonly returnedAt: string | null;
}

export interface ProjectDates {
  readonly createdAt: string;
  readonly uploadStartedAt: string | null;
  readonly sealedAt: string | null;
  readonly checkStartedAt: string | null;
  readonly checkReadyAt: string | null;
  readonly planApprovedAt: string | null;
  readonly preparationStartedAt: string | null;
  readonly packageReadyAt: string | null;
  readonly packageDeletedAt: string | null;
  /** The moment the team reported its import finished (the receipt window counts from it). */
  readonly importTerminalAt: string | null;
  readonly receiptAt: string | null;
  /** Final completion, from which a seller's line becomes payable 30 days later. */
  readonly completedAt: string | null;
  /** Every file of the project deleted (retention or a request). */
  readonly deletedAt: string | null;
  readonly lastProgressAt: string;
}

/** The date that matters: the earliest date that ends something, and what it ends. */
export interface Matters {
  readonly ends: "UPLOAD" | "RESULTS" | "FILES" | "QUOTE" | "HOLD" | "PACKAGE" | "STAGED_PACKAGE" | "RECEIPT";
  readonly at: string;
}

export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly name: string;
  readonly service: Service;
  readonly step: Step;
  /** The public site's synthetic worked example: illustrative quote, no order, no payment, never deleted. */
  readonly example: boolean;
  readonly revision: number;
  readonly sources: readonly SourceFile[];
  /** Billable source units: the rows of the sealed, selected files; null before sealing. */
  readonly units: number | null;
  readonly check: { readonly state: "RUNNING" | "READY" | "FAILED"; readonly deadline: string; readonly failure: string | null } | null;
  readonly mapping: { readonly mapped: number; readonly columns: number } | null;
  readonly duplicates: readonly DuplicateResult[];
  readonly relationships: Relationships | null;
  readonly outputs: readonly OutputFile[];
  readonly importStages: readonly ImportStage[];
  readonly dates: ProjectDates;
  readonly matters: Matters | null;
}

export interface Quote {
  readonly id: string;
  readonly number: string;
  readonly projectId: string;
  readonly service: Service;
  readonly units: number;
  /** Index into the policy's price bands. */
  readonly band: number;
  readonly scheduleVersion: string;
  readonly listMinor: number;
  /** Paid qualifying projects of the workspace in the 365 days before the quote, and the repeat discount they earn. */
  readonly priorPaidProjects: number;
  readonly discountPercent: number;
  readonly discountMinor: number;
  /** The price of the service after discount: the only figure revenue and commission are ever counted on. */
  readonly serviceMinor: number;
  readonly taxRateBps: number;
  readonly taxMinor: number;
  /** What the buyer pays: service plus tax. */
  readonly totalMinor: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: "ISSUED" | "ORDERED" | "PAID" | "EXPIRED";
  /** The public sample's quote is an illustration of the band, never an issued quote. */
  readonly illustrative: boolean;
}

export interface PaymentOrder {
  readonly id: string;
  readonly reference: string;
  readonly quoteId: string;
  readonly projectId: string;
  readonly amountMinor: number;
  readonly createdAt: string;
  /** The send-by date the transfer instructions state. */
  readonly sendBy: string;
  readonly state: "AWAITING_TRANSFER" | "HELD_PENDING_TRANSFER" | "PAID" | "CLOSED_UNPAID";
}

/** The pending-transfer hold (proposed, owner 2026-10-21): files kept while a really initiated transfer arrives. Not payment. */
export interface Hold {
  readonly id: string;
  readonly orderId: string;
  readonly projectId: string;
  readonly proofAt: string;
  readonly trace: string;
  readonly givenBy: string;
  /** Five business days from the proof (proposed), never past the ceiling. */
  readonly until: string;
  /** 24 days from sealing (proposed ceiling). */
  readonly ceiling: string;
  readonly state: "ACTIVE" | "ENDED_PAID" | "ENDED_UNPAID";
}

/** A confirmed collection. An invoice number names the document; the money is what was received, never what was invoiced. */
export interface Payment {
  readonly id: string;
  readonly orderId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly receivedAt: string;
  readonly amountMinor: number;
  readonly serviceMinor: number;
  readonly taxMinor: number;
  readonly invoice: string;
}

export interface Refund {
  readonly id: string;
  readonly paymentId: string;
  readonly projectId: string;
  readonly serviceMinor: number;
  readonly taxMinor: number;
  readonly approvedAt: string;
  readonly paidAt: string;
  readonly reason: string;
  readonly supportCaseId: string | null;
}

/** A customer's request for a refund, before or instead of a refund. */
export interface RefundClaim {
  readonly id: string;
  readonly projectId: string;
  readonly paymentId: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly serviceMinor: number;
  readonly state: "PENDING_LEGAL_REVIEW" | "REFUSED" | "APPROVED";
  readonly decidedAt: string | null;
  /** The owner's reason (never shown to the customer as such). */
  readonly internalReason: string;
  /** What the customer reads: neutral, never a third party's facts. */
  readonly customerMessage: string;
}

export interface Seller {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly state: "CANDIDATE" | "ACTIVE" | "SUSPENDED" | "TERMINATED";
  /** Invited on (a candidate) or active since. */
  readonly since: string;
  readonly agreement: {
    readonly name: string;
    readonly signedOn: string | null;
    readonly firstRateBps: number;
    readonly repeatRateBps: number;
    /** Zero by default; a signed non-zero retainer is respected and shown (owner, 2026-10-21). */
    readonly retainerMinorPerMonth: number;
    readonly retainerFrom: string | null;
  };
  readonly pilot: { readonly from: string; readonly to: string } | null;
  readonly setup: { readonly done: number; readonly total: number };
  /** The last relevant progress (a prospect moved, a message sent, a claim made); the inactivity alert counts from it. */
  readonly lastProgressOn: string | null;
}

export type ClaimReason = "CUSTOMER_OR_DIRECT" | "OTHER_CLAIM" | "OWNER_RULE" | "EVIDENCE" | "AGREEMENT_SCOPE" | "DUPLICATE" | "OTHER";

export interface AttributionClaim {
  readonly id: string;
  readonly sellerId: string;
  readonly organisation: string;
  readonly kind: "AGENCY" | "COMPANY";
  /** The workspace the organisation opened, once it has one. */
  readonly workspaceId: string | null;
  readonly state: "SUBMITTED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CONVERTED";
  readonly submittedOn: string;
  readonly decidedOn: string | null;
  /** An accepted claim lasts 90 days from its decision. */
  readonly endsOn: string | null;
  readonly convertedOn: string | null;
  readonly evidence: string;
  readonly reason: ClaimReason | null;
  /** What the seller reads on a refusal: neutral, never another seller's claim or Kauro's relationship. */
  readonly sellerMessage: string | null;
  readonly reviewRequested: boolean;
}

export interface Prospect {
  readonly id: string;
  readonly sellerId: string;
  readonly name: string;
  readonly segment: "AGENCY" | "COMPANY";
  readonly country: string;
  readonly state: "RESEARCHED" | "QUALIFIED" | "CONTACTED" | "ENGAGED" | "OPPORTUNITY" | "WON" | "LOST" | "SUPPRESSED";
  readonly observedOn: string;
  readonly lastActivityOn: string;
  readonly claimId: string | null;
}

export interface CommissionLine {
  readonly id: string;
  readonly sellerId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly paymentId: string;
  readonly sequence: "FIRST" | "REPEAT";
  readonly rateBps: number;
  /** The service collected after discount, without tax (the payment's service figure). */
  readonly basisMinor: number;
  readonly amountMinor: number;
  readonly completedOn: string | null;
  /** 30 days after final completion. */
  readonly payableFrom: string | null;
  readonly state: "ACCRUED" | "HELD" | "PAYABLE" | "PAID";
  readonly statementId: string | null;
  readonly hold: { readonly reason: string; readonly reviewOn: string; readonly supportCaseId: string } | null;
}

export interface RetainerLine {
  readonly id: string;
  readonly sellerId: string;
  readonly month: string;
  readonly amountMinor: number;
  readonly statementId: string;
  readonly state: "ACCRUED" | "PAID";
}

/** A refund's effect on a seller's commission: its basis, what has been applied, and the balance still to apply. */
export interface Offset {
  readonly id: string;
  readonly sellerId: string;
  readonly refundId: string;
  readonly adjustsLineId: string;
  readonly rateBps: number;
  readonly basisMinor: number;
  readonly appliedMinor: number;
  readonly balanceMinor: number;
  readonly statementId: string;
  readonly rule: string;
}

export interface Statement {
  readonly id: string;
  readonly sellerId: string;
  /** The month whose payable lines it gathers ("2026-09"). */
  readonly period: string;
  readonly state: "DRAFT" | "ISSUED" | "APPROVED" | "PAID";
  /** The 5th and the 10th business day of the next month, Bogotá calendar. */
  readonly issuedOn: string;
  readonly payDue: string;
  readonly paidOn: string | null;
  readonly reference: string | null;
  readonly commissionMinor: number;
  /** Held lines are listed on the statement and never added to its total. */
  readonly heldMinor: number;
  readonly offsetAppliedMinor: number;
  readonly retainerMinor: number;
  readonly totalMinor: number;
}

export interface Payout {
  readonly id: string;
  readonly sellerId: string;
  readonly statementId: string;
  readonly amountMinor: number;
  readonly sentOn: string;
  readonly confirmedOn: string | null;
  readonly reference: string;
}

export interface Job {
  readonly id: string;
  readonly kind: "HEALTH_CHECK" | "PREPARATION" | "IMPORT_READBACK" | "DELETION";
  readonly projectId: string;
  readonly state: "QUEUED" | "RUNNING" | "FAILED" | "SUCCEEDED";
  readonly attempt: number;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly failure: string | null;
}

export interface Incident {
  readonly id: string;
  readonly severity: "S1" | "S2" | "S3";
  readonly state: "OPEN" | "RESOLVED";
  readonly title: string;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
  readonly projectIds: readonly string[];
  readonly containment: string;
  readonly recovery: string;
  readonly communication: string;
}

export interface DeletionRequest {
  readonly id: string;
  readonly projectId: string;
  readonly origin: "CUSTOMER_REQUEST" | "RETENTION_SCHEDULE";
  readonly scope: "PROJECT" | "SOURCE_FILE";
  /** The file a SOURCE_FILE request names; null for the whole project. */
  readonly target: string | null;
  readonly requestedAt: string;
  /** The person who asked, or null for the retention schedule. */
  readonly requestedBy: string | null;
  readonly state: "PENDING" | "DONE";
  readonly doneAt: string | null;
  readonly receipt: string | null;
}

export interface Release {
  readonly id: string;
  readonly state: "CANDIDATE" | "HELD" | "PROMOTED";
  readonly createdAt: string;
  readonly promotedAt: string | null;
  readonly note: string;
}

export interface SupportCase {
  readonly id: string;
  readonly number: number;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly kind: "DEFECT_REPORT" | "BILLING" | "IMPORT_STEPS" | "DATA_ACCESS";
  readonly title: string;
  readonly state: "WAITING_KAURO" | "WAITING_CUSTOMER" | "RESOLVED";
  readonly openedAt: string;
  readonly openedBy: string;
  readonly nextAnswerDue: string | null;
  readonly resolvedAt: string | null;
}

/** One whole world. The canonical world and every stress variant have this shape, so one reconciliation checks them all. */
export interface World {
  readonly name: string;
  readonly asOf: string;
  readonly timezone: "America/Bogota";
  /** Non-business days besides weekends, on the Bogotá calendar. */
  readonly holidays: readonly string[];
  readonly owner: Owner;
  readonly people: readonly Person[];
  readonly workspaces: readonly Workspace[];
  readonly memberships: readonly Membership[];
  readonly clients: readonly Client[];
  readonly projects: readonly Project[];
  readonly quotes: readonly Quote[];
  readonly orders: readonly PaymentOrder[];
  readonly holds: readonly Hold[];
  readonly payments: readonly Payment[];
  readonly refunds: readonly Refund[];
  readonly refundClaims: readonly RefundClaim[];
  readonly sellers: readonly Seller[];
  readonly claims: readonly AttributionClaim[];
  readonly prospects: readonly Prospect[];
  readonly commissionLines: readonly CommissionLine[];
  readonly retainerLines: readonly RetainerLine[];
  readonly offsets: readonly Offset[];
  readonly statements: readonly Statement[];
  readonly payouts: readonly Payout[];
  readonly jobs: readonly Job[];
  readonly incidents: readonly Incident[];
  readonly deletions: readonly DeletionRequest[];
  readonly releases: readonly Release[];
  readonly supportCases: readonly SupportCase[];
}
