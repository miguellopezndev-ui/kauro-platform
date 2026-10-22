// The sales side of the canonical world: four sellers (Daniel Kim, busy; Amara Okafor, with a signed retainer of USD 150 a month and a
// refund offset; Lucía Ferrer, new and still onboarding; Tomás Vidal, without relevant progress since Oct 5), their attribution claims,
// prospects, commission lines, retainer lines, offsets, monthly statements and payouts. The owner's rules of 2026-10-21 apply: sellers see
// both net attributable revenue and commission (generated, pending, paid); never an invoice as a collection, never tax as revenue, never
// one collection twice; a retainer is zero unless signed, and shown when it is not; an offset shows its basis, what was applied and the
// balance; a refused claim reads neutrally. The rules' legal validation is pending, and the screens say so.
import { SELLER, WS } from "./people.ts";
import { PRJ } from "./projects.ts";
import type { AttributionClaim, CommissionLine, Offset, Payout, Prospect, RetainerLine, Seller, Statement } from "./types.ts";

export const SELLERS: readonly Seller[] = [
  {
    id: SELLER.daniel,
    name: "Daniel Kim",
    email: "daniel.kim@sellers.example",
    state: "ACTIVE",
    since: "2026-07-01",
    agreement: { name: "Seller agreement 2026-07", signedOn: "2026-07-01", firstRateBps: 1000, repeatRateBps: 400, retainerMinorPerMonth: 0, retainerFrom: null },
    pilot: { from: "2026-07-01", to: "2026-12-31" },
    setup: { done: 9, total: 9 },
    lastProgressOn: "2026-10-22",
  },
  {
    id: SELLER.amara,
    name: "Amara Okafor",
    email: "amara.okafor@sellers.example",
    state: "ACTIVE",
    since: "2026-08-17",
    agreement: { name: "Seller agreement 2026-08", signedOn: "2026-08-17", firstRateBps: 1000, repeatRateBps: 400, retainerMinorPerMonth: 15_000, retainerFrom: "2026-09-01" },
    pilot: { from: "2026-08-17", to: "2027-02-16" },
    setup: { done: 9, total: 9 },
    lastProgressOn: "2026-10-15",
  },
  {
    id: SELLER.lucia,
    name: "Lucía Ferrer",
    email: "lucia.ferrer@sellers.example",
    state: "CANDIDATE",
    since: "2026-10-06",
    agreement: { name: "Seller agreement 2026-10", signedOn: null, firstRateBps: 1000, repeatRateBps: 400, retainerMinorPerMonth: 0, retainerFrom: null },
    pilot: null,
    setup: { done: 3, total: 9 },
    lastProgressOn: null,
  },
  {
    id: SELLER.tomas,
    name: "Tomás Vidal",
    email: "tomas.vidal@sellers.example",
    state: "ACTIVE",
    since: "2026-07-01",
    agreement: { name: "Seller agreement 2026-07", signedOn: "2026-07-01", firstRateBps: 1000, repeatRateBps: 400, retainerMinorPerMonth: 0, retainerFrom: null },
    pilot: { from: "2026-07-01", to: "2026-12-31" },
    setup: { done: 9, total: 9 },
    lastProgressOn: "2026-10-05",
  },
];

const NEUTRAL = "Not available to claim";

type ClaimInput = Omit<AttributionClaim, "reason" | "sellerMessage" | "reviewRequested" | "convertedOn" | "workspaceId"> & Partial<Pick<AttributionClaim, "reason" | "sellerMessage" | "reviewRequested" | "convertedOn" | "workspaceId">>;
const claim = (one: ClaimInput): AttributionClaim => ({ reason: null, sellerMessage: null, reviewRequested: false, convertedOn: null, workspaceId: null, ...one });

/** Accepted claims last 90 days from the decision; a claim converts on its organisation's first confirmed payment. */
export const CLAIMS: readonly AttributionClaim[] = [
  claim({ id: "c-01", sellerId: SELLER.daniel, organisation: "Fernhill Growth Partners", kind: "AGENCY", state: "SUBMITTED", submittedOn: "2026-10-20", decidedOn: null, endsOn: null, evidence: "Its own site and the HubSpot partner directory, seen on Oct 14, 2026" }),
  claim({ id: "c-02", sellerId: SELLER.amara, organisation: "Brightwater Collective", kind: "AGENCY", state: "ACCEPTED", submittedOn: "2026-08-21", decidedOn: "2026-08-22", endsOn: "2026-11-20", evidence: "Its own site, seen on Aug 19, 2026" }),
  claim({ id: "c-03", sellerId: SELLER.daniel, organisation: "Ostra Revenue Ops", kind: "AGENCY", state: "ACCEPTED", submittedOn: "2026-10-01", decidedOn: "2026-10-02", endsOn: "2026-12-31", evidence: "A published conference speaker list, seen on Sep 30, 2026" }),
  claim({ id: "c-04", sellerId: SELLER.tomas, organisation: "Marlow & Pike", kind: "COMPANY", state: "ACCEPTED", submittedOn: "2026-07-25", decidedOn: "2026-07-26", endsOn: "2026-10-24", evidence: "Its own careers page (CRM administrator role), seen on Jul 24, 2026" }),
  claim({ id: "c-05", sellerId: SELLER.daniel, organisation: "Saltmarsh Digital", kind: "AGENCY", state: "ACCEPTED", submittedOn: "2026-10-08", decidedOn: "2026-10-09", endsOn: "2027-01-07", evidence: "Its own site, seen on Oct 6, 2026" }),
  claim({ id: "c-06", sellerId: SELLER.daniel, organisation: "Larkspur Home Goods", kind: "COMPANY", workspaceId: WS.larkspur, state: "CONVERTED", submittedOn: "2026-09-21", decidedOn: "2026-09-22", endsOn: "2026-12-21", convertedOn: "2026-10-22", evidence: "Its own site, seen on Sep 18, 2026" }),
  claim({ id: "c-07", sellerId: SELLER.amara, organisation: "Halden Outdoor", kind: "COMPANY", workspaceId: WS.halden, state: "CONVERTED", submittedOn: "2026-08-24", decidedOn: "2026-08-25", endsOn: "2026-11-23", convertedOn: "2026-09-26", evidence: "Its own careers page, seen on Aug 20, 2026" }),
  claim({ id: "c-08", sellerId: SELLER.daniel, organisation: "Juniper Digital", kind: "AGENCY", workspaceId: WS.juniper, state: "ACCEPTED", submittedOn: "2026-09-27", decidedOn: "2026-09-28", endsOn: "2026-12-27", evidence: "Its own site, seen on Jul 27, 2026" }),
  claim({ id: "c-09", sellerId: SELLER.amara, organisation: "Fjordline Media", kind: "AGENCY", workspaceId: WS.fjordline, state: "CONVERTED", submittedOn: "2026-08-18", decidedOn: "2026-08-19", endsOn: "2026-11-17", convertedOn: "2026-09-02", evidence: "Its own site, seen on Aug 17, 2026" }),
  claim({ id: "c-10", sellerId: SELLER.daniel, organisation: "Coastline Analytics", kind: "AGENCY", workspaceId: WS.coastline, state: "CONVERTED", submittedOn: "2026-07-17", decidedOn: "2026-07-18", endsOn: "2026-10-16", convertedOn: "2026-08-26", evidence: "Its own site, seen on Jul 9, 2026" }),
  claim({ id: "c-11", sellerId: SELLER.tomas, organisation: "Quillon Partners", kind: "AGENCY", workspaceId: WS.quillon, state: "ACCEPTED", submittedOn: "2026-08-02", decidedOn: "2026-08-03", endsOn: "2026-11-01", evidence: "Its own site, seen on Aug 1, 2026" }),
  claim({
    id: "c-12",
    sellerId: SELLER.amara,
    organisation: "Pinewood Analytics",
    kind: "AGENCY",
    state: "REJECTED",
    submittedOn: "2026-09-14",
    decidedOn: "2026-09-18",
    endsOn: null,
    evidence: "Its own site, seen on Sep 12, 2026",
    reason: "CUSTOMER_OR_DIRECT",
    sellerMessage: NEUTRAL,
    reviewRequested: true,
  }),
];

const prospect = (id: string, sellerId: string, name: string, segment: Prospect["segment"], country: string, state: Prospect["state"], observedOn: string, lastActivityOn: string, claimId: string | null = null): Prospect => ({ id, sellerId, name, segment, country, state, observedOn, lastActivityOn, claimId });

export const PROSPECTS: readonly Prospect[] = [
  prospect("p-01", SELLER.daniel, "Fernhill Growth Partners", "AGENCY", "GB", "QUALIFIED", "2026-10-14", "2026-10-20", "c-01"),
  prospect("p-02", SELLER.daniel, "Saltmarsh Digital", "AGENCY", "IE", "CONTACTED", "2026-10-06", "2026-10-20", "c-05"),
  prospect("p-03", SELLER.daniel, "Ostra Revenue Ops", "AGENCY", "NL", "ENGAGED", "2026-09-30", "2026-10-20", "c-03"),
  prospect("p-04", SELLER.daniel, "Bellweather Outdoor", "COMPANY", "US", "RESEARCHED", "2026-10-09", "2026-10-09"),
  prospect("p-05", SELLER.daniel, "Kestrel & Lowe", "AGENCY", "GB", "SUPPRESSED", "2026-09-28", "2026-10-01"),
  prospect("p-06", SELLER.daniel, "Coastline Analytics", "AGENCY", "US", "WON", "2026-07-09", "2026-10-20", "c-10"),
  prospect("p-07", SELLER.daniel, "Juniper Digital", "AGENCY", "CA", "OPPORTUNITY", "2026-07-27", "2026-10-05", "c-08"),
  prospect("p-08", SELLER.daniel, "Larkspur Home Goods", "COMPANY", "US", "WON", "2026-09-18", "2026-10-22", "c-06"),
  prospect("p-11", SELLER.amara, "Brightwater Collective", "AGENCY", "AU", "CONTACTED", "2026-08-19", "2026-10-15", "c-02"),
  prospect("p-12", SELLER.amara, "Copperline Freight", "COMPANY", "US", "RESEARCHED", "2026-10-13", "2026-10-13"),
  prospect("p-13", SELLER.amara, "Fjordline Media", "AGENCY", "NO", "WON", "2026-08-17", "2026-09-02", "c-09"),
  prospect("p-14", SELLER.amara, "Halden Outdoor", "COMPANY", "CO", "WON", "2026-08-20", "2026-09-26", "c-07"),
  prospect("p-15", SELLER.amara, "Pinewood Analytics", "AGENCY", "US", "LOST", "2026-09-12", "2026-09-18", "c-12"),
  prospect("p-21", SELLER.tomas, "Marlow & Pike", "COMPANY", "US", "CONTACTED", "2026-07-24", "2026-10-05", "c-04"),
  prospect("p-22", SELLER.tomas, "Quillon Partners", "AGENCY", "US", "OPPORTUNITY", "2026-08-01", "2026-10-05", "c-11"),
];

/** One line per confirmed payment of an acquired customer: the rate on the service collected after discount, without tax. */
export const COMMISSION_LINES: readonly CommissionLine[] = [
  { id: "DK-L1", sellerId: SELLER.daniel, workspaceId: WS.coastline, projectId: PRJ.coAccounts, paymentId: "pay-2026-0062", sequence: "FIRST", rateBps: 1000, basisMinor: 229_500, amountMinor: 22_950, completedOn: "2026-08-28", payableFrom: "2026-09-27", state: "PAID", statementId: "st-dk-2026-09", hold: null },
  { id: "DK-L2", sellerId: SELLER.daniel, workspaceId: WS.coastline, projectId: PRJ.coQ4, paymentId: "pay-2026-0128", sequence: "REPEAT", rateBps: 400, basisMinor: 123_025, amountMinor: 4_921, completedOn: null, payableFrom: null, state: "ACCRUED", statementId: null, hold: null },
  { id: "DK-L3", sellerId: SELLER.daniel, workspaceId: WS.larkspur, projectId: PRJ.lkCustomerList, paymentId: "pay-2026-0134", sequence: "FIRST", rateBps: 1000, basisMinor: 69_500, amountMinor: 6_950, completedOn: null, payableFrom: null, state: "ACCRUED", statementId: null, hold: null },
  {
    id: "AO-L1",
    sellerId: SELLER.amara,
    workspaceId: WS.fjordline,
    projectId: PRJ.fjContacts,
    paymentId: "pay-2026-0071",
    sequence: "FIRST",
    rateBps: 1000,
    basisMinor: 129_500,
    amountMinor: 12_950,
    completedOn: "2026-09-10",
    payableFrom: "2026-10-10",
    state: "HELD",
    statementId: "st-ao-2026-10",
    hold: { reason: "A defect report on this project is open (support case 115); held until it is resolved.", reviewOn: "2026-11-04", supportCaseId: "case-115" },
  },
  { id: "AO-L2", sellerId: SELLER.amara, workspaceId: WS.halden, projectId: PRJ.hoDealers, paymentId: "pay-2026-0093", sequence: "FIRST", rateBps: 1000, basisMinor: 69_500, amountMinor: 6_950, completedOn: "2026-09-26", payableFrom: "2026-10-26", state: "ACCRUED", statementId: "st-ao-2026-10", hold: null },
];

export const RETAINER_LINES: readonly RetainerLine[] = [
  { id: "RT-AO-2026-09", sellerId: SELLER.amara, month: "2026-09", amountMinor: 15_000, statementId: "st-ao-2026-09", state: "PAID" },
  { id: "RT-AO-2026-10", sellerId: SELLER.amara, month: "2026-10", amountMinor: 15_000, statementId: "st-ao-2026-10", state: "ACCRUED" },
];

const OFFSET_RULE = "The seller agreement counts commission on the service collected net of refunds; an offset is applied against the next payable commission, never against a retainer.";

export const OFFSETS: readonly Offset[] = [
  // nothing of Daniel's is payable yet, so the whole basis is carried as a balance
  { id: "OF-DK-0007", sellerId: SELLER.daniel, refundId: "RF-2026-0007", adjustsLineId: "DK-L1", rateBps: 1000, basisMinor: 3_000, appliedMinor: 0, balanceMinor: 3_000, statementId: "st-dk-2026-10", rule: OFFSET_RULE },
  // the tax refunded to Halden (USD 19.00) is not part of the basis: only the service refunded is
  { id: "OF-AO-0009", sellerId: SELLER.amara, refundId: "RF-2026-0009", adjustsLineId: "AO-L2", rateBps: 1000, basisMinor: 1_000, appliedMinor: 1_000, balanceMinor: 0, statementId: "st-ao-2026-10", rule: OFFSET_RULE },
];

/** A month's statement is issued on the 5th business day of the next month and paid by the 10th (Bogotá calendar). */
export const STATEMENTS: readonly Statement[] = [
  { id: "st-dk-2026-09", sellerId: SELLER.daniel, period: "2026-09", state: "PAID", issuedOn: "2026-10-07", payDue: "2026-10-15", paidOn: "2026-10-15", reference: "KAU-CP-2026-09-001", commissionMinor: 22_950, heldMinor: 0, offsetAppliedMinor: 0, retainerMinor: 0, totalMinor: 22_950 },
  { id: "st-ao-2026-09", sellerId: SELLER.amara, period: "2026-09", state: "PAID", issuedOn: "2026-10-07", payDue: "2026-10-15", paidOn: "2026-10-15", reference: "KAU-CP-2026-09-002", commissionMinor: 0, heldMinor: 0, offsetAppliedMinor: 0, retainerMinor: 15_000, totalMinor: 15_000 },
  { id: "st-dk-2026-10", sellerId: SELLER.daniel, period: "2026-10", state: "DRAFT", issuedOn: "2026-11-09", payDue: "2026-11-17", paidOn: null, reference: null, commissionMinor: 0, heldMinor: 0, offsetAppliedMinor: 0, retainerMinor: 0, totalMinor: 0 },
  { id: "st-ao-2026-10", sellerId: SELLER.amara, period: "2026-10", state: "DRAFT", issuedOn: "2026-11-09", payDue: "2026-11-17", paidOn: null, reference: null, commissionMinor: 6_950, heldMinor: 12_950, offsetAppliedMinor: 1_000, retainerMinor: 15_000, totalMinor: 20_950 },
];

export const PAYOUTS: readonly Payout[] = [
  { id: "PAYOUT-2026-09-001", sellerId: SELLER.daniel, statementId: "st-dk-2026-09", amountMinor: 22_950, sentOn: "2026-10-15", confirmedOn: "2026-10-15", reference: "KAU-CP-2026-09-001" },
  { id: "PAYOUT-2026-09-002", sellerId: SELLER.amara, statementId: "st-ao-2026-09", amountMinor: 15_000, sentOn: "2026-10-15", confirmedOn: "2026-10-15", reference: "KAU-CP-2026-09-002" },
];
