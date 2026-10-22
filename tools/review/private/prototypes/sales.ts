// The sales side of the review's world (Order 11, round 2): four independent sellers, the customers they brought, every commission line
// and statement, the claims and the outreach drafts. One world feeds the owner's console (Today, Sellers, a seller, Payouts, Customers,
// Claims, Settings) and the seller's (Today, Prospects, Outreach, Commissions, Resources), so a figure reads the same on every page.
//
// The shapes are the api's (SellerView, SellerAgreementRecordView, PayoutDestinationStatusView, CommissionStatementView and its items,
// AttributionClaimView, ProspectView, OutreachDraftView, SalesResourceView); the lists across sellers are not: the api has no read that
// lists sellers, a seller's customers or statements across sellers (owner-console.md §2.2), so the owner's pages are drawn from this
// fixture and the gaps are recorded in docs/design/ORDER11-ROUND2-OPS.md.
//
// The rules are the vendored policy's commission block: 10% of the service collected on a customer's first project and 4% on its repeats
// for 12 calendar months from the first confirmed payment, after discount, net of refunds and without tax; an accepted claim lasts 90 days;
// a line becomes payable 30 days after the project's final completion; a month's statement is issued on the 5th business day of the next
// month and paid by the 10th, on the Bogotá calendar (September 2026: Oct 7 and Oct 15; October 2026: Nov 9 and Nov 17; Oct 12, Nov 2 and
// Nov 16 are holidays). The review's "now" is Wednesday, Oct 21, 2026, 09:12 in Bogotá. Every person, company and amount is synthetic.
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";

export const FIRST_RATE = 10;
export const REPEAT_RATE = 4;
export const CLAIM_DAYS = 90;
export const ELIGIBLE_DAYS = 30;
export const WINDOW_MONTHS = 12;
export const TAIL_DAYS = 90;
/** A month's statement is issued on its next month's 5th business day and paid by the 10th, on the Bogotá calendar. */
export const STATEMENT_BUSINESS_DAY = 5;
export const PAYOUT_BUSINESS_DAY = 10;
/** The review's "now", as the owner's pages state it. */
export const TODAY = "Wednesday, Oct 21, 2026";
export const AS_OF = "09:12 Bogotá";

/** "USD 1,295.00": money in a sentence. */
export const usd = (cents: number): string => (cents < 0 ? `\u2212USD ${amount(-cents)}` : `USD ${amount(cents)}`);
/** "1,295.00": money in a table cell, its currency in the column's header. */
export const amount = (cents: number): string => `${cents < 0 ? "\u2212" : ""}${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const commissionOf = (basisCents: number, rate: number): number => Math.round((basisCents * rate) / 100);

export type Service = "CLEAN" | "HUBSPOT" | "SALESFORCE";
/** The services' names wherever a person reads them; the api's value CLEAN is never shown. */
export const SERVICE_NAME: Readonly<Record<Service, string>> = { CLEAN: "Clean your data", HUBSPOT: "Prepare for HubSpot", SALESFORCE: "Prepare for Salesforce" };

// ---- sellers ---------------------------------------------------------------------------------------------------------------------------

export type SellerState = "CANDIDATE" | "ACTIVE" | "SUSPENDED" | "TERMINATED";
export interface Seller {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly state: SellerState;
  /** Invited on (a candidate) or active since. */
  readonly since: string;
  readonly agreement: string;
  readonly signed: string | null;
  readonly endedOn?: string;
  readonly tailUntil?: string;
  readonly payout: { readonly label: string; readonly currency: "USD" | "COP"; readonly state: "VERIFIED" | "PENDING_VERIFICATION" | "NONE"; readonly verifiedOn?: string };
  readonly sender?: { readonly address: string; readonly route: "GMAIL_API" | "RESEND_TRANSACTIONAL"; readonly state: "VERIFIED" | "PENDING_VERIFICATION" | "REVOKED" };
  readonly legalReview?: string;
  readonly assessment?: string;
  readonly training?: string;
  readonly taxDocument?: string;
  readonly pilot?: string;
  /** The agreement's fixed monthly payment (retainerCentsPerMonth): 0 unless a signed agreement sets one (owner, 2026-10-21). */
  readonly retainerCents: number;
  readonly retainerFrom?: string;
}

const uuid = (tail: string): string => `0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e${tail}`;
export const SELLER_ID = { daniel: uuid("7c01"), amara: uuid("7c02"), lucia: uuid("7c03"), tomas: uuid("7c04") } as const;

export const SELLERS: readonly Seller[] = [
  {
    id: SELLER_ID.daniel,
    name: "Daniel Kim",
    email: "daniel.kim@sellers.example",
    state: "ACTIVE",
    since: "Jul 1, 2026",
    agreement: "Seller agreement 2026-07",
    signed: "Jul 1, 2026",
    payout: { label: "··4821", currency: "USD", state: "VERIFIED", verifiedOn: "Sep 5, 2026" },
    sender: { address: "daniel.kim@sales.kauro.example", route: "GMAIL_API", state: "VERIFIED" },
    legalReview: "Independent contractor in Colombia, reviewed by counsel on Jun 24, 2026",
    assessment: "Product and English, Jun 12, 2026",
    training: "Offer, data handling and outreach rules, Jul 4, 2026",
    taxDocument: "RUT on file since Jun 28, 2026",
    pilot: "Jul 1 to Dec 31, 2026; its review is prepared from Dec 17, 14 days before it ends",
    retainerCents: 0,
  },
  {
    id: SELLER_ID.amara,
    name: "Amara Okafor",
    email: "amara.okafor@sellers.example",
    state: "ACTIVE",
    since: "Aug 17, 2026",
    agreement: "Seller agreement 2026-08",
    signed: "Aug 17, 2026",
    payout: { label: "··3307", currency: "USD", state: "VERIFIED", verifiedOn: "Aug 28, 2026" },
    sender: { address: "amara.okafor@sales.kauro.example", route: "GMAIL_API", state: "VERIFIED" },
    legalReview: "Independent contractor in Colombia, reviewed by counsel on Aug 10, 2026",
    assessment: "Product and English, Aug 4, 2026",
    training: "Offer, data handling and outreach rules, Aug 19, 2026",
    taxDocument: "RUT on file since Aug 12, 2026",
    pilot: "Aug 17, 2026 to Feb 16, 2027; its review is prepared from Feb 2, 2027, 14 days before it ends",
    retainerCents: 15_000,
    retainerFrom: "Sep 1, 2026",
  },
  {
    id: SELLER_ID.lucia,
    name: "Lucía Ferrer",
    email: "lucia.ferrer@sellers.example",
    state: "CANDIDATE",
    since: "Oct 6, 2026",
    agreement: "Seller agreement 2026-10",
    signed: null,
    payout: { label: "—", currency: "USD", state: "NONE" },
    legalReview: "Independent contractor in Colombia, reviewed by counsel on Oct 9, 2026",
    retainerCents: 0,
  },
  {
    id: SELLER_ID.tomas,
    name: "Tomás Vidal",
    email: "tomas.vidal@sellers.example",
    state: "TERMINATED",
    since: "Jul 1, 2026",
    agreement: "Seller agreement 2026-07",
    signed: "Jul 1, 2026",
    endedOn: "Sep 30, 2026",
    tailUntil: "Dec 29, 2026",
    payout: { label: "··9150", currency: "USD", state: "VERIFIED", verifiedOn: "Jul 8, 2026" },
    sender: { address: "tomas.vidal@sales.kauro.example", route: "GMAIL_API", state: "REVOKED" },
    legalReview: "Independent contractor in Colombia, reviewed by counsel on Jun 24, 2026",
    assessment: "Product and English, Jun 15, 2026",
    training: "Offer, data handling and outreach rules, Jul 4, 2026",
    taxDocument: "RUT on file since Jun 30, 2026",
    retainerCents: 0,
  },
];
/** The seller the seller's console is signed in as (the review's "Seller" person). */
export const SELLER = SELLERS[0] as Seller;
export const sellerById = (id: string | null | undefined): Seller | undefined => SELLERS.find((one) => one.id === id);

export const SELLER_STATE_WORD: Readonly<Record<SellerState, string>> = { CANDIDATE: "Onboarding", ACTIVE: "Active", SUSPENDED: "Suspended", TERMINATED: "Ended" };
export const SELLER_STATE_TONE: Readonly<Record<SellerState, "success" | "info" | "warning" | "neutral">> = { CANDIDATE: "info", ACTIVE: "success", SUSPENDED: "warning", TERMINATED: "neutral" };

// ---- customers -------------------------------------------------------------------------------------------------------------------------

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly kind: "Agency" | "Company";
  /** The seller who acquired it (an accepted claim, converted), or null for a customer that came direct. */
  readonly acquiredBy: string | null;
  /** The seller who serves it now, or null when the owner does. */
  readonly servedBy: string | null;
  readonly firstPaid: string;
  readonly repeatsUntil: string | null;
  readonly projects: number;
  readonly collectedCents: number;
  readonly lastPaid: string;
}
export const CUSTOMER_ID = { coastline: uuid("7c01"), juniper: uuid("7c11"), larkspur: uuid("7c12"), fjordline: uuid("7c14"), quillon: uuid("7c15"), northwind: uuid("5fa1"), halden: uuid("5fb9") } as const;

export const CUSTOMERS: readonly Customer[] = [
  { id: CUSTOMER_ID.northwind, name: "Northwind Data", kind: "Agency", acquiredBy: null, servedBy: null, firstPaid: "Aug 4, 2026", repeatsUntil: null, projects: 6, collectedCents: 744_625, lastPaid: "Oct 16, 2026" },
  { id: CUSTOMER_ID.coastline, name: "Coastline Analytics", kind: "Agency", acquiredBy: SELLER_ID.daniel, servedBy: SELLER_ID.daniel, firstPaid: "Aug 26, 2026", repeatsUntil: "Aug 26, 2027", projects: 2, collectedCents: 322_525, lastPaid: "Oct 14, 2026" },
  { id: CUSTOMER_ID.juniper, name: "Juniper Digital", kind: "Agency", acquiredBy: SELLER_ID.daniel, servedBy: SELLER_ID.daniel, firstPaid: "Sep 3, 2026", repeatsUntil: "Sep 3, 2027", projects: 1, collectedCents: 129_500, lastPaid: "Sep 3, 2026" },
  { id: CUSTOMER_ID.larkspur, name: "Larkspur Home Goods", kind: "Company", acquiredBy: SELLER_ID.daniel, servedBy: SELLER_ID.daniel, firstPaid: "Oct 19, 2026", repeatsUntil: "Oct 19, 2027", projects: 1, collectedCents: 69_500, lastPaid: "Oct 19, 2026" },
  { id: CUSTOMER_ID.fjordline, name: "Fjordline Media", kind: "Agency", acquiredBy: SELLER_ID.amara, servedBy: SELLER_ID.amara, firstPaid: "Sep 2, 2026", repeatsUntil: "Sep 2, 2027", projects: 1, collectedCents: 129_500, lastPaid: "Sep 2, 2026" },
  { id: CUSTOMER_ID.halden, name: "Halden Outdoor", kind: "Company", acquiredBy: SELLER_ID.amara, servedBy: SELLER_ID.amara, firstPaid: "Sep 18, 2026", repeatsUntil: "Sep 18, 2027", projects: 1, collectedCents: 69_500, lastPaid: "Sep 18, 2026" },
  { id: CUSTOMER_ID.quillon, name: "Quillon Partners", kind: "Agency", acquiredBy: SELLER_ID.tomas, servedBy: null, firstPaid: "Jul 20, 2026", repeatsUntil: "Jul 20, 2027", projects: 1, collectedCents: 199_500, lastPaid: "Jul 20, 2026" },
];
export const customerById = (id: string | null | undefined): Customer | undefined => CUSTOMERS.find((one) => one.id === id);
export const customerByName = (name: string): Customer | undefined => CUSTOMERS.find((one) => one.name === name);

/** A customer's paid projects, as the owner's customer page lists them (service, never a file or a record). */
export interface PaidProject {
  readonly customerId: string;
  readonly name: string;
  readonly service: Service;
  readonly paidOn: string;
  readonly collectedCents: number;
  readonly discount: string | null;
  readonly state: "Preparing" | "Delivered";
  /** A refund on this project: what was paid back, when, and its reference (the collected figure is net of it). */
  readonly refund?: { readonly cents: number; readonly on: string; readonly reference: string };
}
export const PAID_PROJECTS: readonly PaidProject[] = [
  { customerId: CUSTOMER_ID.northwind, name: "Opportunities", service: "SALESFORCE", paidOn: "Oct 16, 2026", collectedCents: 142_025, discount: "5% repeat discount", state: "Preparing" },
  { customerId: CUSTOMER_ID.northwind, name: "Newsletter list", service: "CLEAN", paidOn: "Oct 5, 2026", collectedCents: 66_025, discount: "5% repeat discount", state: "Delivered" },
  { customerId: CUSTOMER_ID.northwind, name: "Contacts", service: "HUBSPOT", paidOn: "Sep 24, 2026", collectedCents: 123_025, discount: "5% repeat discount", state: "Delivered" },
  { customerId: CUSTOMER_ID.northwind, name: "Archive clean-up", service: "CLEAN", paidOn: "Sep 8, 2026", collectedCents: 66_025, discount: "5% repeat discount", state: "Delivered" },
  { customerId: CUSTOMER_ID.northwind, name: "Accounts migration", service: "SALESFORCE", paidOn: "Aug 20, 2026", collectedCents: 218_025, discount: "5% repeat discount", state: "Delivered" },
  { customerId: CUSTOMER_ID.northwind, name: "First import", service: "HUBSPOT", paidOn: "Aug 4, 2026", collectedCents: 129_500, discount: null, state: "Delivered" },
  { customerId: CUSTOMER_ID.coastline, name: "Q4 contacts", service: "HUBSPOT", paidOn: "Oct 14, 2026", collectedCents: 123_025, discount: "5% repeat discount", state: "Preparing" },
  { customerId: CUSTOMER_ID.coastline, name: "Accounts and contacts", service: "SALESFORCE", paidOn: "Aug 26, 2026", collectedCents: 199_500, discount: null, state: "Delivered", refund: { cents: 30_000, on: "Oct 13, 2026", reference: "RF-2026-0007" } },
  { customerId: CUSTOMER_ID.juniper, name: "HubSpot contacts", service: "HUBSPOT", paidOn: "Sep 3, 2026", collectedCents: 129_500, discount: null, state: "Delivered" },
  { customerId: CUSTOMER_ID.larkspur, name: "Customer list", service: "CLEAN", paidOn: "Oct 19, 2026", collectedCents: 69_500, discount: null, state: "Preparing" },
  { customerId: CUSTOMER_ID.fjordline, name: "Contacts", service: "HUBSPOT", paidOn: "Sep 2, 2026", collectedCents: 129_500, discount: null, state: "Delivered" },
  { customerId: CUSTOMER_ID.halden, name: "Dealer list", service: "CLEAN", paidOn: "Sep 18, 2026", collectedCents: 69_500, discount: null, state: "Delivered" },
  { customerId: CUSTOMER_ID.quillon, name: "Contacts and deals", service: "HUBSPOT", paidOn: "Jul 20, 2026", collectedCents: 199_500, discount: null, state: "Delivered" },
];

// ---- commission lines and statements ---------------------------------------------------------------------------------------------------

export type LineState = "ACCRUED_PENDING" | "HELD" | "ELIGIBLE" | "PAYABLE" | "PAID" | "ADJUSTED" | "VOID";
export interface Line {
  readonly id: string;
  readonly sellerId: string;
  readonly customer: string;
  readonly project: string;
  readonly service: Service;
  /** FIRST and REPEAT earn the rate; ADJUSTMENT offsets an earlier line after a refund; RETAINER is the agreement's fixed monthly payment. */
  readonly sequence: "FIRST" | "REPEAT" | "ADJUSTMENT" | "RETAINER";
  readonly basisCents: number;
  readonly rate: number;
  readonly paidOn: string;
  readonly completedOn: string | null;
  readonly payableFrom: string | null;
  readonly state: LineState;
  readonly statement: string | null;
  readonly hold?: { readonly reason: string; readonly review: string };
  /** An offset after a refund: which refund, which line it adjusts, the rule it applies (owner, 2026-10-21). */
  readonly offset?: { readonly refund: string; readonly refundCents: number; readonly approvedOn: string; readonly adjusts: string; readonly rule: string };
  /** A retainer's fixed amount (no rate). */
  readonly fixedCents?: number;
}
const line = (one: Omit<Line, "rate">): Line => ({ ...one, rate: one.sequence === "REPEAT" ? REPEAT_RATE : one.sequence === "RETAINER" ? 0 : FIRST_RATE });
export const LINES: readonly Line[] = [
  line({ id: "l-01", sellerId: SELLER_ID.daniel, customer: "Coastline Analytics", project: "Accounts and contacts", service: "SALESFORCE", sequence: "FIRST", basisCents: 229_500, paidOn: "Aug 26, 2026", completedOn: "Aug 28, 2026", payableFrom: "Sep 27, 2026", state: "PAID", statement: "st-dk-2026-09" }),
  line({ id: "l-02", sellerId: SELLER_ID.daniel, customer: "Juniper Digital", project: "HubSpot contacts", service: "HUBSPOT", sequence: "FIRST", basisCents: 129_500, paidOn: "Sep 3, 2026", completedOn: "Sep 15, 2026", payableFrom: "Oct 15, 2026", state: "ELIGIBLE", statement: "st-dk-2026-10" }),
  line({ id: "l-03", sellerId: SELLER_ID.daniel, customer: "Coastline Analytics", project: "Q4 contacts", service: "HUBSPOT", sequence: "REPEAT", basisCents: 123_025, paidOn: "Oct 14, 2026", completedOn: null, payableFrom: null, state: "ACCRUED_PENDING", statement: null }),
  line({ id: "l-04", sellerId: SELLER_ID.daniel, customer: "Larkspur Home Goods", project: "Customer list", service: "CLEAN", sequence: "FIRST", basisCents: 69_500, paidOn: "Oct 19, 2026", completedOn: null, payableFrom: null, state: "ACCRUED_PENDING", statement: null }),
  line({ id: "l-05", sellerId: SELLER_ID.amara, customer: "Fjordline Media", project: "Contacts", service: "HUBSPOT", sequence: "FIRST", basisCents: 129_500, paidOn: "Sep 2, 2026", completedOn: "Sep 10, 2026", payableFrom: "Oct 10, 2026", state: "HELD", statement: "st-ao-2026-10", hold: { reason: "A defect report on this project is open (support case 115); held until it is resolved", review: "Nov 4, 2026" } }),
  line({ id: "l-06", sellerId: SELLER_ID.amara, customer: "Halden Outdoor", project: "Dealer list", service: "CLEAN", sequence: "FIRST", basisCents: 69_500, paidOn: "Sep 18, 2026", completedOn: "Sep 28, 2026", payableFrom: "Oct 28, 2026", state: "ELIGIBLE", statement: "st-ao-2026-10" }),
  line({
    id: "l-08",
    sellerId: SELLER_ID.daniel,
    customer: "Coastline Analytics",
    project: "Accounts and contacts",
    service: "SALESFORCE",
    sequence: "ADJUSTMENT",
    basisCents: -30_000,
    paidOn: "Oct 13, 2026",
    completedOn: null,
    payableFrom: null,
    state: "ADJUSTED",
    statement: "st-dk-2026-10",
    offset: { refund: "RF-2026-0007", refundCents: 30_000, approvedOn: "Oct 13, 2026", adjusts: "l-01", rule: "Seller agreement 2026-07: commission is counted on the service collected net of refunds" },
  }),
  line({ id: "l-09", sellerId: SELLER_ID.amara, customer: "Monthly retainer", project: "September 2026", service: "CLEAN", sequence: "RETAINER", basisCents: 0, fixedCents: 15_000, paidOn: "Sep 30, 2026", completedOn: null, payableFrom: null, state: "PAID", statement: "st-ao-2026-09" }),
  line({ id: "l-10", sellerId: SELLER_ID.amara, customer: "Monthly retainer", project: "October 2026", service: "CLEAN", sequence: "RETAINER", basisCents: 0, fixedCents: 15_000, paidOn: "Oct 31, 2026", completedOn: null, payableFrom: null, state: "ELIGIBLE", statement: "st-ao-2026-10" }),
  line({ id: "l-07", sellerId: SELLER_ID.tomas, customer: "Quillon Partners", project: "Contacts and deals", service: "HUBSPOT", sequence: "FIRST", basisCents: 199_500, paidOn: "Jul 20, 2026", completedOn: "Jul 28, 2026", payableFrom: "Aug 27, 2026", state: "PAID", statement: "st-tv-2026-08" }),
];
export const earnedOf = (one: Line): number => one.fixedCents ?? commissionOf(one.basisCents, one.rate);
export const isRetainer = (one: Line): boolean => one.sequence === "RETAINER";
export const linesOf = (sellerId: string): readonly Line[] => LINES.filter((one) => one.sellerId === sellerId);

export type StatementState = "DRAFT" | "ISSUED" | "DISPUTED" | "APPROVED" | "PAID" | "CORRECTED";
export interface Statement {
  readonly id: string;
  readonly sellerId: string;
  readonly period: string;
  readonly state: StatementState;
  readonly issuedOn: string;
  readonly payDue: string;
  readonly paidOn: string | null;
  readonly reference: string | null;
}
export const STATEMENTS: readonly Statement[] = [
  { id: "st-dk-2026-10", sellerId: SELLER_ID.daniel, period: "October 2026", state: "DRAFT", issuedOn: "Nov 9, 2026", payDue: "Nov 17, 2026", paidOn: null, reference: null },
  { id: "st-ao-2026-10", sellerId: SELLER_ID.amara, period: "October 2026", state: "DRAFT", issuedOn: "Nov 9, 2026", payDue: "Nov 17, 2026", paidOn: null, reference: null },
  { id: "st-dk-2026-09", sellerId: SELLER_ID.daniel, period: "September 2026", state: "PAID", issuedOn: "Oct 7, 2026", payDue: "Oct 15, 2026", paidOn: "Oct 15, 2026", reference: "KAU-CP-2026-09-001" },
  { id: "st-ao-2026-09", sellerId: SELLER_ID.amara, period: "September 2026", state: "PAID", issuedOn: "Oct 7, 2026", payDue: "Oct 15, 2026", paidOn: "Oct 15, 2026", reference: "KAU-CP-2026-09-002" },
  { id: "st-tv-2026-08", sellerId: SELLER_ID.tomas, period: "August 2026", state: "PAID", issuedOn: "Sep 7, 2026", payDue: "Sep 14, 2026", paidOn: "Sep 14, 2026", reference: "KAU-CP-2026-08-001" },
];
export const statementLines = (statement: Statement): readonly Line[] => LINES.filter((one) => one.statement === statement.id);
export const payableOf = (lines: readonly Line[]): number => lines.filter((one) => one.state !== "HELD" && one.state !== "ACCRUED_PENDING" && one.state !== "VOID").reduce((sum, one) => sum + earnedOf(one), 0);
export const heldOf = (lines: readonly Line[]): number => lines.filter((one) => one.state === "HELD").reduce((sum, one) => sum + earnedOf(one), 0);
export const statementsOf = (sellerId: string): readonly Statement[] => STATEMENTS.filter((one) => one.sellerId === sellerId);

export const STATEMENT_WORD: Readonly<Record<StatementState, string>> = { DRAFT: "Draft", ISSUED: "Issued", DISPUTED: "Contested", APPROVED: "Approved", PAID: "Paid", CORRECTED: "Corrected" };
export const STATEMENT_TONE: Readonly<Record<StatementState, "neutral" | "info" | "warning" | "success">> = { DRAFT: "neutral", ISSUED: "info", DISPUTED: "warning", APPROVED: "info", PAID: "success", CORRECTED: "info" };

/** The seller-facing word of a line's state (seller-portal.md §3.3), one word per contract state, defined once on Commissions. */
export function lineWord(one: Line): string {
  switch (one.state) {
    case "ACCRUED_PENDING":
      return one.payableFrom === null ? "Earned · waits for the project to finish" : `Earned · payable from ${one.payableFrom}`;
    case "HELD":
      return one.hold === undefined ? "Held" : `Held · review on ${one.hold.review}`;
    case "ELIGIBLE":
      return "Payable · on the next statement";
    case "PAYABLE":
      return "On statement";
    case "PAID":
      return "Paid";
    case "ADJUSTED":
      return "Adjusted";
    case "VOID":
      return "Void";
  }
}

/**
 * A seller's money, by state, from the lines (the owner's Sellers and Seller pages). Net revenue is what the seller's customers actually
 * paid for the service, net of refunds and without tax, each collection counted once, in the month it happened (a refund in the month of
 * the refund). Commission generated, pending and paid leave the retainer out; the retainer is kept apart and never hidden.
 * `month` ("Oct", "Sep") narrows revenue, commission generated and paid to that month; pending is always as of now.
 */
export function moneyOf(sellerId: string, month: string | null = null) {
  const all = linesOf(sellerId);
  const lines = all.filter((one) => !isRetainer(one));
  const retainers = all.filter(isRetainer);
  const statementOf = (one: Line): Statement | undefined => STATEMENTS.find((statement) => statement.id === one.statement);
  const inMonth = (one: Line): boolean => month === null || one.paidOn.startsWith(month);
  const isPaid = (one: Line): boolean => one.state === "PAID" || statementOf(one)?.state === "PAID";
  const paidIn = (one: Line): boolean => month === null || (statementOf(one)?.paidOn ?? "").startsWith(month);
  const open = STATEMENTS.filter((one) => one.sellerId === sellerId && one.state !== "PAID");
  const onOpen = lines.filter((one) => open.some((statement) => statement.id === one.statement));
  const sum = (list: readonly Line[]): number => list.reduce((total, one) => total + earnedOf(one), 0);
  return {
    collected: lines.filter(inMonth).reduce((total, one) => total + one.basisCents, 0),
    earned: sum(lines.filter(inMonth)),
    payable: payableOf(onOpen),
    held: heldOf(lines),
    accruing: sum(lines.filter((one) => one.state === "ACCRUED_PENDING")),
    pending: sum(lines.filter((one) => !isPaid(one))),
    paid: sum(lines.filter((one) => isPaid(one) && paidIn(one))),
    offsets: sum(lines.filter((one) => one.sequence === "ADJUSTMENT")),
    retainerPending: sum(retainers.filter((one) => !isPaid(one))),
    retainerPaid: sum(retainers.filter((one) => isPaid(one) && paidIn(one))),
  };
}

// ---- claims, prospects, outreach -------------------------------------------------------------------------------------------------------

export type ClaimState = "SUBMITTED" | "DISPUTED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CONVERTED";
export interface Claim {
  readonly id: string;
  readonly organisation: string;
  readonly kind: "Agency" | "Company";
  readonly sellerId: string;
  readonly state: ClaimState;
  readonly submitted: string;
  readonly decided: string | null;
  readonly ends: string | null;
  readonly evidence: string;
  /** The internal reason of a refusal, from the closed list (owner only), with its evidence; the seller reads only its message. */
  readonly reason?: ClaimReasonKey;
  readonly reasonEvidence?: string;
  readonly reasonNote?: string;
  /** Every decision on the claim, oldest first (owner only). */
  readonly history?: readonly (readonly [date: string, event: string])[];
}

/**
 * The closed list of reasons a claim can be refused for (owner, 2026-10-21: approved; the legal validation of the contractual claim rules is
 * still pending). Each has its internal label (the owner's) and the message the seller reads, which never reveals a commercial relationship
 * or another seller's claim. "Other" is the one documented exception and needs a written note.
 */
export type ClaimReasonKey = "CUSTOMER_OR_DIRECT" | "OTHER_CLAIM" | "OWNER_RULE" | "EVIDENCE" | "AGREEMENT_SCOPE" | "DUPLICATE" | "OTHER";
export const CLAIM_REASONS: readonly { readonly key: ClaimReasonKey; readonly internal: string; readonly seller: string; readonly note: boolean }[] = [
  { key: "CUSTOMER_OR_DIRECT", internal: "Already a customer, or already in direct contact with Kauro", seller: "Not available to claim", note: false },
  { key: "OTHER_CLAIM", internal: "Another seller holds a live claim on it", seller: "Not available to claim", note: false },
  { key: "OWNER_RULE", internal: "Excluded by a recorded owner rule", seller: "Not available to claim", note: false },
  { key: "EVIDENCE", internal: "Not enough evidence of the seller's own work", seller: "Not enough evidence of your own work", note: false },
  { key: "AGREEMENT_SCOPE", internal: "Outside the seller agreement (for example a consumer)", seller: "Outside your seller agreement", note: false },
  { key: "DUPLICATE", internal: "Duplicate of the seller's own claim", seller: "Duplicate of a claim you already made", note: false },
  { key: "OTHER", internal: "Other", seller: "Not available to claim", note: true },
];
export const claimReason = (key: ClaimReasonKey | undefined) => CLAIM_REASONS.find((one) => one.key === key);
export const CLAIMS: readonly Claim[] = [
  { id: "c-01", organisation: "Fernhill Growth Partners", kind: "Agency", sellerId: SELLER_ID.daniel, state: "SUBMITTED", submitted: "Oct 20, 2026", decided: null, ends: null, evidence: "Its own site and the HubSpot partner directory, seen on Oct 14, 2026; qualified on Oct 19 (runs HubSpot migrations for clients)", history: [["Oct 20, 2026", "Claim submitted by Daniel Kim, with the source"], ["Oct 20, 2026", "Checked against Kauro's records: no other claim, no customer, no fit inquiry"]] },
  { id: "c-02", organisation: "Brightwater Collective", kind: "Agency", sellerId: SELLER_ID.amara, state: "ACCEPTED", submitted: "Aug 21, 2026", decided: "Aug 22, 2026", ends: "Nov 20, 2026", evidence: "Its own site, seen on Aug 19, 2026" },
  { id: "c-03", organisation: "Ostra Revenue Ops", kind: "Agency", sellerId: SELLER_ID.daniel, state: "ACCEPTED", submitted: "Oct 1, 2026", decided: "Oct 2, 2026", ends: "Dec 31, 2026", evidence: "A published conference speaker list, seen on Sep 30, 2026" },
  { id: "c-04", organisation: "Marlow & Pike", kind: "Company", sellerId: SELLER_ID.tomas, state: "ACCEPTED", submitted: "Sep 1, 2026", decided: "Sep 2, 2026", ends: "Dec 1, 2026", evidence: "Its own careers page (CRM administrator role), seen on Aug 31, 2026" },
  { id: "c-05", organisation: "Saltmarsh Digital", kind: "Agency", sellerId: SELLER_ID.daniel, state: "ACCEPTED", submitted: "Oct 8, 2026", decided: "Oct 9, 2026", ends: "Jan 7, 2027", evidence: "Its own site, seen on Oct 6, 2026" },
  { id: "c-06", organisation: "Larkspur Home Goods", kind: "Company", sellerId: SELLER_ID.daniel, state: "CONVERTED", submitted: "Sep 21, 2026", decided: "Sep 22, 2026", ends: "Oct 19, 2026", evidence: "Its own site, seen on Sep 18, 2026" },
  { id: "c-07", organisation: "Halden Outdoor", kind: "Company", sellerId: SELLER_ID.amara, state: "CONVERTED", submitted: "Aug 24, 2026", decided: "Aug 25, 2026", ends: "Sep 18, 2026", evidence: "Its own careers page, seen on Aug 20, 2026" },
  { id: "c-08", organisation: "Juniper Digital", kind: "Agency", sellerId: SELLER_ID.daniel, state: "CONVERTED", submitted: "Jul 28, 2026", decided: "Jul 29, 2026", ends: "Sep 3, 2026", evidence: "Its own site, seen on Jul 27, 2026" },
  { id: "c-09", organisation: "Fjordline Media", kind: "Agency", sellerId: SELLER_ID.amara, state: "CONVERTED", submitted: "Aug 18, 2026", decided: "Aug 19, 2026", ends: "Sep 2, 2026", evidence: "Its own site, seen on Aug 17, 2026" },
  { id: "c-10", organisation: "Coastline Analytics", kind: "Agency", sellerId: SELLER_ID.daniel, state: "CONVERTED", submitted: "Jul 17, 2026", decided: "Jul 18, 2026", ends: "Aug 26, 2026", evidence: "Its own site, seen on Jul 9, 2026" },
  { id: "c-11", organisation: "Quillon Partners", kind: "Agency", sellerId: SELLER_ID.tomas, state: "CONVERTED", submitted: "Jul 6, 2026", decided: "Jul 7, 2026", ends: "Jul 20, 2026", evidence: "Its own site, seen on Jul 3, 2026" },
  {
    id: "c-12",
    organisation: "Pinewood Analytics",
    kind: "Agency",
    sellerId: SELLER_ID.amara,
    state: "REJECTED",
    submitted: "Sep 14, 2026",
    decided: "Sep 18, 2026",
    ends: null,
    evidence: "Its own site, seen on Sep 12, 2026",
    reason: "CUSTOMER_OR_DIRECT",
    reasonEvidence: "Pinewood Analytics sent Kauro's contact form on Sep 10, 2026, four days before the claim (fit inquiry FI-2026-0031)",
    history: [
      ["Sep 14, 2026", "Claim submitted by Amara Okafor, with the source"],
      ["Sep 15, 2026", "Refused: already in direct contact with Kauro. Amara Okafor read: Not available to claim"],
      ["Sep 16, 2026", "Amara Okafor asked for a review"],
      ["Sep 18, 2026", "Review: refusal upheld, with the same reason; the fit inquiry predates the claim"],
    ],
  },
];
export const claimsOf = (sellerId: string): readonly Claim[] => CLAIMS.filter((one) => one.sellerId === sellerId);

export type ProspectState = "RESEARCHED" | "QUALIFIED" | "CONTACTED" | "ENGAGED" | "OPPORTUNITY" | "WON" | "LOST" | "SUPPRESSED";
export interface Prospect {
  readonly id: string;
  readonly name: string;
  readonly segment: "Agency" | "Company";
  readonly jurisdiction: string;
  readonly sellerId: string;
  readonly source: string;
  readonly observed: string;
  readonly state: ProspectState;
  readonly fit: string;
  readonly next: string;
  readonly claim: string;
  readonly last: string;
}
export const PROSPECTS: readonly Prospect[] = [
  { id: "p-04", name: "Bellweather Outdoor", segment: "Company", jurisdiction: "United States", sellerId: SELLER_ID.daniel, source: "Its own careers page (CRM administrator role)", observed: "Oct 9, 2026", state: "RESEARCHED", fit: "Not checked yet: is a migration planned?", next: "Check the fit before any message", claim: "None", last: "Oct 9, 2026" },
  { id: "p-03", name: "Ostra Revenue Ops", segment: "Agency", jurisdiction: "Netherlands", sellerId: SELLER_ID.daniel, source: "A published conference speaker list", observed: "Sep 30, 2026", state: "ENGAGED", fit: "Salesforce consultancy; asked for the worked example on Oct 16", next: "Send the authorised message by Oct 23", claim: "Ends Dec 31, 2026", last: "Oct 20, 2026" },
  { id: "p-02", name: "Saltmarsh Digital", segment: "Agency", jurisdiction: "Ireland", sellerId: SELLER_ID.daniel, source: "Its own site", observed: "Oct 6, 2026", state: "CONTACTED", fit: "Builds CRM setups for small firms", next: "Follow-up waits for Kauro's authorisation", claim: "Ends Jan 7, 2027", last: "Oct 20, 2026" },
  { id: "p-01", name: "Fernhill Growth Partners", segment: "Agency", jurisdiction: "United Kingdom", sellerId: SELLER_ID.daniel, source: "Its own site and the HubSpot partner directory", observed: "Oct 14, 2026", state: "QUALIFIED", fit: "HubSpot partner; runs migrations for clients", next: "Claim waits for Kauro's decision", claim: "In review", last: "Oct 20, 2026" },
  { id: "p-06", name: "Coastline Analytics", segment: "Agency", jurisdiction: "United States", sellerId: SELLER_ID.daniel, source: "Its own site", observed: "Jul 9, 2026", state: "WON", fit: "Two paid projects", next: "None: a customer", claim: "Won Aug 26, 2026", last: "Oct 14, 2026" },
  { id: "p-07", name: "Juniper Digital", segment: "Agency", jurisdiction: "Canada", sellerId: SELLER_ID.daniel, source: "Its own site", observed: "Jul 27, 2026", state: "WON", fit: "One paid project", next: "None: a customer", claim: "Won Sep 3, 2026", last: "Sep 15, 2026" },
  { id: "p-08", name: "Larkspur Home Goods", segment: "Company", jurisdiction: "United States", sellerId: SELLER_ID.daniel, source: "Its own site", observed: "Sep 18, 2026", state: "WON", fit: "One paid project", next: "None: a customer", claim: "Won Oct 19, 2026", last: "Oct 19, 2026" },
  { id: "p-05", name: "Kestrel & Lowe", segment: "Agency", jurisdiction: "United Kingdom", sellerId: SELLER_ID.daniel, source: "Its own site", observed: "Sep 28, 2026", state: "SUPPRESSED", fit: "Sets up HubSpot for clients", next: "Do not contact", claim: "None", last: "Oct 1, 2026" },
  { id: "p-11", name: "Brightwater Collective", segment: "Agency", jurisdiction: "Australia", sellerId: SELLER_ID.amara, source: "Its own site", observed: "Aug 19, 2026", state: "CONTACTED", fit: "HubSpot onboarding for clients", next: "Waiting for a reply since Oct 15", claim: "Ends Nov 20, 2026", last: "Oct 15, 2026" },
  { id: "p-12", name: "Copperline Freight", segment: "Company", jurisdiction: "United States", sellerId: SELLER_ID.amara, source: "Its own careers page (CRM administrator role)", observed: "Oct 13, 2026", state: "RESEARCHED", fit: "Not checked yet", next: "Check the fit before any message", claim: "None", last: "Oct 13, 2026" },
];

export type DraftState = "DRAFT" | "AUTHORIZED" | "SUBMITTING" | "PROVIDER_ACCEPTED" | "SEND_UNCERTAIN" | "BOUNCED" | "REPLIED" | "SUPPRESSED" | "CANCELLED";
export type Purpose = "REQUESTED_REPLY" | "INDIVIDUAL_PROSPECT_CONTACT" | "FOLLOW_UP";
export const PURPOSE_WORD: Readonly<Record<Purpose, string>> = { REQUESTED_REPLY: "Reply they asked for", INDIVIDUAL_PROSPECT_CONTACT: "First contact", FOLLOW_UP: "Follow-up" };
/** The seller-facing words of a draft's state (seller-portal.md §6.3): the contract's states, and only those. */
export const DRAFT_WORD: Readonly<Record<DraftState, string>> = {
  DRAFT: "Draft · not authorised",
  AUTHORIZED: "Authorised",
  SUBMITTING: "Sending",
  PROVIDER_ACCEPTED: "Sent",
  SEND_UNCERTAIN: "Not known yet",
  BOUNCED: "Not delivered",
  REPLIED: "Replied",
  SUPPRESSED: "Stopped · do not contact",
  CANCELLED: "Cancelled",
};
export const DRAFT_TONE: Readonly<Record<DraftState, "neutral" | "info" | "success" | "warning" | "danger">> = {
  DRAFT: "neutral",
  AUTHORIZED: "info",
  SUBMITTING: "info",
  PROVIDER_ACCEPTED: "success",
  SEND_UNCERTAIN: "warning",
  BOUNCED: "warning",
  REPLIED: "success",
  SUPPRESSED: "danger",
  CANCELLED: "neutral",
};
export interface Draft {
  readonly id: string;
  readonly prospect: string;
  readonly sellerId: string;
  readonly purpose: Purpose;
  readonly state: DraftState;
  readonly until: string | null;
  readonly changed: string;
}
export const DRAFTS: readonly Draft[] = [
  { id: "d-01", prospect: "Ostra Revenue Ops", sellerId: SELLER_ID.daniel, purpose: "REQUESTED_REPLY", state: "AUTHORIZED", until: "Oct 23, 2026", changed: "Oct 20, 2026" },
  { id: "d-02", prospect: "Saltmarsh Digital", sellerId: SELLER_ID.daniel, purpose: "FOLLOW_UP", state: "DRAFT", until: null, changed: "Oct 20, 2026" },
  { id: "d-03", prospect: "Saltmarsh Digital", sellerId: SELLER_ID.daniel, purpose: "INDIVIDUAL_PROSPECT_CONTACT", state: "PROVIDER_ACCEPTED", until: null, changed: "Oct 12, 2026" },
  { id: "d-04", prospect: "Juniper Digital", sellerId: SELLER_ID.daniel, purpose: "INDIVIDUAL_PROSPECT_CONTACT", state: "REPLIED", until: null, changed: "Aug 3, 2026" },
  { id: "d-05", prospect: "Kestrel & Lowe", sellerId: SELLER_ID.daniel, purpose: "INDIVIDUAL_PROSPECT_CONTACT", state: "SUPPRESSED", until: null, changed: "Oct 1, 2026" },
  { id: "d-06", prospect: "Brightwater Collective", sellerId: SELLER_ID.amara, purpose: "FOLLOW_UP", state: "PROVIDER_ACCEPTED", until: null, changed: "Oct 15, 2026" },
];

// ---- resources -------------------------------------------------------------------------------------------------------------------------

export interface Resource {
  readonly family: string;
  readonly purpose: "Explain" | "Answer" | "Limits";
  readonly version: number;
  readonly state: "CURRENT" | "SUPERSEDED";
  readonly since: string;
  readonly what: string;
  readonly replacedBy?: string;
  readonly replacedOn?: string;
}
export const RESOURCES: readonly Resource[] = [
  { family: "Offer sheet", purpose: "Explain", version: 3, state: "CURRENT", since: "Oct 12, 2026", what: "What Kauro does and does not do, the three services, the price bands and the free data health check" },
  { family: "Worked example", purpose: "Explain", version: 2, state: "CURRENT", since: "Oct 5, 2026", what: "The public site's synthetic project, step by step, for a demonstration" },
  { family: "Questions buyers ask", purpose: "Answer", version: 2, state: "CURRENT", since: "Oct 12, 2026", what: "Answers to the usual questions, each with the page of the public site that backs it" },
  { family: "What a seller may promise", purpose: "Limits", version: 1, state: "CURRENT", since: "Jul 1, 2026", what: "The contract's limits: no discount, no date and no result you cannot show" },
  { family: "Offer sheet", purpose: "Explain", version: 2, state: "SUPERSEDED", since: "Jul 1, 2026", what: "Its price wording was replaced by the current price bands", replacedBy: "Offer sheet version 3", replacedOn: "Oct 12, 2026" },
];

/** The policy's repeat ladder, as the offer sheet quotes it (a buyer's own discount, never the seller's to give). */
export const REPEAT_TIERS = POLICY_SNAPSHOT.repeatTiers;
