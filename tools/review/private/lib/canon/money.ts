// The canonical world's money on the customer side: quotes with their band, repeat discount, tax line and validity; payment orders and
// their send-by dates; the one pending-transfer hold; the confirmed payments (each collection once); refunds; and two refund requests,
// one with counsel and one refused in neutral words. All amounts are USD minor units. Tax is its own figure on every record and is never
// part of the service amount that revenue and commission are counted on. reconcile.ts re-derives every amount from the policy.
import { P, uid, WS } from "./people.ts";
import { PRJ } from "./projects.ts";
import type { Hold, Payment, PaymentOrder, Quote, Refund, RefundClaim } from "./types.ts";

/** The main project's quote and order keep the web fixtures' ids (apps/web/test/support/fixtures.ts QUOTE and ORDER). */
export const MAIN_QUOTE = uid("5fa3");
export const MAIN_ORDER = uid("5fa4");

type QuoteInput = Omit<Quote, "scheduleVersion" | "illustrative">;
const q = (one: QuoteInput, illustrative = false): Quote => ({ ...one, scheduleVersion: "R2-INITIAL", illustrative });

export const QUOTES: readonly Quote[] = [
  q({ id: "q-2026-0137", number: "Q-2026-0137", projectId: PRJ.rfMembers, service: "CLEAN", units: 11_092, band: 0, listMinor: 69_500, priorPaidProjects: 0, discountPercent: 0, discountMinor: 0, serviceMinor: 69_500, taxRateBps: 0, taxMinor: 0, totalMinor: 69_500, issuedAt: "2026-10-18T14:00:00Z", expiresAt: "2026-11-01T14:00:00Z", state: "ISSUED" }),
  q({ id: MAIN_QUOTE, number: "Q-2026-0131", projectId: PRJ.nwMain, service: "HUBSPOT", units: 15_684, band: 0, listMinor: 129_500, priorPaidProjects: 2, discountPercent: 5, discountMinor: 6_475, serviceMinor: 123_025, taxRateBps: 0, taxMinor: 0, totalMinor: 123_025, issuedAt: "2026-10-20T13:00:00Z", expiresAt: "2026-11-03T13:00:00Z", state: "ORDERED" }),
  q({ id: "q-2026-0124", number: "Q-2026-0124", projectId: PRJ.boCustomers, service: "HUBSPOT", units: 38_530, band: 0, listMinor: 129_500, priorPaidProjects: 0, discountPercent: 0, discountMinor: 0, serviceMinor: 129_500, taxRateBps: 1900, taxMinor: 24_605, totalMinor: 154_105, issuedAt: "2026-10-15T18:30:00Z", expiresAt: "2026-10-29T18:30:00Z", state: "ORDERED" }),
  q({ id: "q-2026-0134", number: "Q-2026-0134", projectId: PRJ.lkCustomerList, service: "CLEAN", units: 9_120, band: 0, listMinor: 69_500, priorPaidProjects: 0, discountPercent: 0, discountMinor: 0, serviceMinor: 69_500, taxRateBps: 0, taxMinor: 0, totalMinor: 69_500, issuedAt: "2026-10-21T18:00:00Z", expiresAt: "2026-11-04T18:00:00Z", state: "PAID" }),
  q({ id: "q-2026-0128", number: "Q-2026-0128", projectId: PRJ.coQ4, service: "HUBSPOT", units: 26_715, band: 0, listMinor: 129_500, priorPaidProjects: 1, discountPercent: 5, discountMinor: 6_475, serviceMinor: 123_025, taxRateBps: 0, taxMinor: 0, totalMinor: 123_025, issuedAt: "2026-10-19T15:00:00Z", expiresAt: "2026-11-02T15:00:00Z", state: "PAID" }),
  q({ id: "q-2026-0119", number: "Q-2026-0119", projectId: PRJ.nwOpportunities, service: "SALESFORCE", units: 4_150, band: 0, listMinor: 149_500, priorPaidProjects: 1, discountPercent: 5, discountMinor: 7_475, serviceMinor: 142_025, taxRateBps: 0, taxMinor: 0, totalMinor: 142_025, issuedAt: "2026-10-15T13:00:00Z", expiresAt: "2026-10-29T13:00:00Z", state: "PAID" }),
  q({ id: "q-2026-0108", number: "Q-2026-0108", projectId: PRJ.nwTidewellContacts, service: "HUBSPOT", units: 11_952, band: 0, listMinor: 129_500, priorPaidProjects: 0, discountPercent: 0, discountMinor: 0, serviceMinor: 129_500, taxRateBps: 0, taxMinor: 0, totalMinor: 129_500, issuedAt: "2026-10-08T15:00:00Z", expiresAt: "2026-10-22T15:00:00Z", state: "PAID" }),
  q({ id: "q-2026-0062", number: "Q-2026-0062", projectId: PRJ.coAccounts, service: "SALESFORCE", units: 71_380, band: 1, listMinor: 229_500, priorPaidProjects: 0, discountPercent: 0, discountMinor: 0, serviceMinor: 229_500, taxRateBps: 0, taxMinor: 0, totalMinor: 229_500, issuedAt: "2026-08-25T16:00:00Z", expiresAt: "2026-09-08T16:00:00Z", state: "PAID" }),
  q({ id: "q-2026-0071", number: "Q-2026-0071", projectId: PRJ.fjContacts, service: "HUBSPOT", units: 34_710, band: 0, listMinor: 129_500, priorPaidProjects: 0, discountPercent: 0, discountMinor: 0, serviceMinor: 129_500, taxRateBps: 0, taxMinor: 0, totalMinor: 129_500, issuedAt: "2026-09-01T14:00:00Z", expiresAt: "2026-09-15T14:00:00Z", state: "PAID" }),
  q({ id: "q-2026-0093", number: "Q-2026-0093", projectId: PRJ.hoDealers, service: "CLEAN", units: 3_980, band: 0, listMinor: 69_500, priorPaidProjects: 0, discountPercent: 0, discountMinor: 0, serviceMinor: 69_500, taxRateBps: 1900, taxMinor: 13_205, totalMinor: 82_705, issuedAt: "2026-09-25T14:00:00Z", expiresAt: "2026-10-09T14:00:00Z", state: "PAID" }),
  // the public sample: the band's price as How it works shows it (USD 1,295, up to 50,000 units); an illustration, never an issued quote
  q({ id: "q-example", number: "Example", projectId: PRJ.example, service: "HUBSPOT", units: 15_684, band: 0, listMinor: 129_500, priorPaidProjects: 0, discountPercent: 0, discountMinor: 0, serviceMinor: 129_500, taxRateBps: 0, taxMinor: 0, totalMinor: 129_500, issuedAt: "2026-10-01T11:00:00Z", expiresAt: "2026-10-15T11:00:00Z", state: "ISSUED" }, true),
];

/** Payment orders. The send-by date is four days before the earlier of the quote's expiry and the files' end, at 23:59:59 UTC. */
export const ORDERS: readonly PaymentOrder[] = [
  { id: MAIN_ORDER, reference: "KAU-PO-2026-0131", quoteId: MAIN_QUOTE, projectId: PRJ.nwMain, amountMinor: 123_025, createdAt: "2026-10-20T13:10:00Z", sendBy: "2026-10-23T23:59:59Z", state: "AWAITING_TRANSFER" },
  { id: "ord-2026-0124", reference: "KAU-PO-2026-0124", quoteId: "q-2026-0124", projectId: PRJ.boCustomers, amountMinor: 154_105, createdAt: "2026-10-16T10:00:00Z", sendBy: "2026-10-17T23:59:59Z", state: "HELD_PENDING_TRANSFER" },
  { id: "ord-2026-0134", reference: "KAU-PO-2026-0134", quoteId: "q-2026-0134", projectId: PRJ.lkCustomerList, amountMinor: 69_500, createdAt: "2026-10-21T18:05:00Z", sendBy: "2026-10-24T23:59:59Z", state: "PAID" },
  { id: "ord-2026-0128", reference: "KAU-PO-2026-0128", quoteId: "q-2026-0128", projectId: PRJ.coQ4, amountMinor: 123_025, createdAt: "2026-10-19T15:10:00Z", sendBy: "2026-10-21T23:59:59Z", state: "PAID" },
  { id: "ord-2026-0119", reference: "KAU-PO-2026-0119", quoteId: "q-2026-0119", projectId: PRJ.nwOpportunities, amountMinor: 142_025, createdAt: "2026-10-15T13:10:00Z", sendBy: "2026-10-17T23:59:59Z", state: "PAID" },
  { id: "ord-2026-0108", reference: "KAU-PO-2026-0108", quoteId: "q-2026-0108", projectId: PRJ.nwTidewellContacts, amountMinor: 129_500, createdAt: "2026-10-08T15:10:00Z", sendBy: "2026-10-10T23:59:59Z", state: "PAID" },
  { id: "ord-2026-0062", reference: "KAU-PO-2026-0062", quoteId: "q-2026-0062", projectId: PRJ.coAccounts, amountMinor: 229_500, createdAt: "2026-08-25T16:10:00Z", sendBy: "2026-08-27T23:59:59Z", state: "PAID" },
  { id: "ord-2026-0071", reference: "KAU-PO-2026-0071", quoteId: "q-2026-0071", projectId: PRJ.fjContacts, amountMinor: 129_500, createdAt: "2026-09-01T14:10:00Z", sendBy: "2026-09-03T23:59:59Z", state: "PAID" },
  { id: "ord-2026-0093", reference: "KAU-PO-2026-0093", quoteId: "q-2026-0093", projectId: PRJ.hoDealers, amountMinor: 82_705, createdAt: "2026-09-25T14:10:00Z", sendBy: "2026-09-27T23:59:59Z", state: "PAID" },
];

/** Brindle & Oak proved its transfer on Oct 20, before its files would have gone (Oct 21): held five business days, not paid. */
export const HOLDS: readonly Hold[] = [
  { id: "hold-2026-0003", orderId: "ord-2026-0124", projectId: PRJ.boCustomers, proofAt: "2026-10-20T15:00:00Z", trace: "4410029387", givenBy: P.camila, until: "2026-10-27T15:00:00Z", ceiling: "2026-11-07T16:00:00Z", state: "ACTIVE" },
];

export const PAYMENTS: readonly Payment[] = [
  { id: "pay-2026-0062", orderId: "ord-2026-0062", projectId: PRJ.coAccounts, workspaceId: WS.coastline, receivedAt: "2026-08-26T15:00:00Z", amountMinor: 229_500, serviceMinor: 229_500, taxMinor: 0, invoice: "KAU-2026-000071" },
  { id: "pay-2026-0071", orderId: "ord-2026-0071", projectId: PRJ.fjContacts, workspaceId: WS.fjordline, receivedAt: "2026-09-02T15:00:00Z", amountMinor: 129_500, serviceMinor: 129_500, taxMinor: 0, invoice: "KAU-2026-000078" },
  { id: "pay-2026-0093", orderId: "ord-2026-0093", projectId: PRJ.hoDealers, workspaceId: WS.halden, receivedAt: "2026-09-26T14:00:00Z", amountMinor: 82_705, serviceMinor: 69_500, taxMinor: 13_205, invoice: "KAU-2026-000096" },
  { id: "pay-2026-0108", orderId: "ord-2026-0108", projectId: PRJ.nwTidewellContacts, workspaceId: WS.northwind, receivedAt: "2026-10-09T14:00:00Z", amountMinor: 129_500, serviceMinor: 129_500, taxMinor: 0, invoice: "KAU-2026-000109" },
  { id: "pay-2026-0119", orderId: "ord-2026-0119", projectId: PRJ.nwOpportunities, workspaceId: WS.northwind, receivedAt: "2026-10-16T15:00:00Z", amountMinor: 142_025, serviceMinor: 142_025, taxMinor: 0, invoice: "KAU-2026-000114" },
  { id: "pay-2026-0128", orderId: "ord-2026-0128", projectId: PRJ.coQ4, workspaceId: WS.coastline, receivedAt: "2026-10-20T16:00:00Z", amountMinor: 123_025, serviceMinor: 123_025, taxMinor: 0, invoice: "KAU-2026-000119" },
  { id: "pay-2026-0134", orderId: "ord-2026-0134", projectId: PRJ.lkCustomerList, workspaceId: WS.larkspur, receivedAt: "2026-10-22T12:40:00Z", amountMinor: 69_500, serviceMinor: 69_500, taxMinor: 0, invoice: "KAU-2026-000124" },
];

export const REFUNDS: readonly Refund[] = [
  { id: "RF-2026-0007", paymentId: "pay-2026-0062", projectId: PRJ.coAccounts, serviceMinor: 30_000, taxMinor: 0, approvedAt: "2026-10-13T15:00:00Z", paidAt: "2026-10-14T15:00:00Z", reason: "A verified Kauro defect: 1,240 contacts were linked to the wrong account (support case 104).", supportCaseId: "case-104" },
  { id: "RF-2026-0009", paymentId: "pay-2026-0093", projectId: PRJ.hoDealers, serviceMinor: 10_000, taxMinor: 1_900, approvedAt: "2026-10-06T15:00:00Z", paidAt: "2026-10-07T15:00:00Z", reason: "A verified Kauro defect: 412 dealer names lost their accents (support case 109).", supportCaseId: "case-109" },
];

export const REFUND_CLAIMS: readonly RefundClaim[] = [
  {
    id: "RC-2026-0004",
    projectId: PRJ.fjContacts,
    paymentId: "pay-2026-0071",
    requestedAt: "2026-10-12T16:00:00Z",
    requestedBy: P.siobhan,
    serviceMinor: 129_500,
    state: "PENDING_LEGAL_REVIEW",
    decidedAt: null,
    internalReason: "A full refund asked for 379 contacts HubSpot refused at import; whether a refusal by the destination is a Kauro defect is with counsel.",
    customerMessage: "Your request is being reviewed. We will write to you by Nov 4, 2026.",
  },
  {
    id: "RC-2026-0005",
    projectId: PRJ.nwTidewellContacts,
    paymentId: "pay-2026-0108",
    requestedAt: "2026-10-19T10:00:00Z",
    requestedBy: P.ines,
    serviceMinor: 129_500,
    state: "REFUSED",
    decidedAt: "2026-10-20T10:00:00Z",
    internalReason: "The package was delivered as approved and imported; the request names no defect (a change of plan after delivery).",
    customerMessage: "This request is outside the refund terms for a delivered package. You can ask for a review, or open a support case if something in the package is wrong.",
  },
];
