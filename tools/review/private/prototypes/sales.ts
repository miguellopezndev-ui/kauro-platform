// The sales side of the review's world (Order 11, groups D and E): one independent seller, Daniel Kim, and the agencies he found. The shapes
// are the api's (ProspectView, AttributionClaimView, CommissionStatementView and its items, SalesResourceView, the outreach views); the rules
// are the vendored policy's commission block: 10% of the service collected on an agency's first project and 4% on its repeats for 12 months
// from the first confirmed capture, after discount, net of refunds and without tax; an accepted claim lasts 90 days; a line becomes eligible
// 30 days after the project's final completion; the statement is issued on the 5th business day and paid on the 10th, in Bogotá's calendar
// (October 2026: the 7th and the 15th, the 12th being a holiday). Every name and amount is synthetic.
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";

export const SELLER = Object.freeze({ name: "Daniel Kim", since: "2026-07-01T00:00:00Z", agreement: "Seller agreement 2026-07" });
export const FIRST_RATE = 10;
export const REPEAT_RATE = 4;
export const CLAIM_DAYS = 90;
export const ELIGIBLE_DAYS = 30;
export const WINDOW_MONTHS = 12;
/** A month's statement is issued on its next month's 5th business day and paid on the 10th, on the Bogotá calendar. */
export const STATEMENT_BUSINESS_DAY = 5;
export const PAYOUT_BUSINESS_DAY = 10;

export type ProspectState = "RESEARCHED" | "QUALIFIED" | "CONTACTED" | "ENGAGED" | "OPPORTUNITY" | "WON" | "LOST" | "SUPPRESSED";
export interface Prospect {
  readonly id: string;
  readonly name: string;
  readonly segment: "Agency" | "Company";
  readonly jurisdiction: string;
  readonly source: string;
  readonly observed: string;
  readonly state: ProspectState;
  readonly fit: string;
  readonly next: string;
  readonly claim?: string | undefined;
}
export const PROSPECTS: readonly Prospect[] = [
  { id: "p-01", name: "Fernhill Growth Partners", segment: "Agency", jurisdiction: "United Kingdom", source: "Its own site, the HubSpot partner directory", observed: "2026-10-14", state: "QUALIFIED", fit: "HubSpot partner; runs migrations for clients", next: "Write the first message" },
  { id: "p-02", name: "Saltmarsh Digital", segment: "Agency", jurisdiction: "Ireland", source: "Its own site", observed: "2026-10-09", state: "CONTACTED", fit: "Builds CRM setups for small firms", next: "No reply yet: follow up from Oct 23", claim: "Claim accepted, until Jan 7, 2027" },
  { id: "p-03", name: "Ostra Revenue Ops", segment: "Agency", jurisdiction: "Netherlands", source: "A conference speaker list, published", observed: "2026-10-02", state: "ENGAGED", fit: "Salesforce consultancy; asked for the worked example", next: "Send the worked example they asked for", claim: "Claim accepted, until Dec 31, 2026" },
  { id: "p-04", name: "Bellweather Outdoor", segment: "Company", jurisdiction: "United States", source: "Its own careers page (CRM admin role)", observed: "2026-10-16", state: "RESEARCHED", fit: "Not checked yet: is there a migration?", next: "Check the fit before any message" },
  { id: "p-05", name: "Kestrel & Lowe", segment: "Agency", jurisdiction: "United Kingdom", source: "Its own site", observed: "2026-09-28", state: "SUPPRESSED", fit: "Sets up HubSpot for clients", next: "None: suppressed on every channel" },
];

export interface StatementLine {
  readonly agency: string;
  readonly project: string;
  readonly sequence: "FIRST" | "REPEAT";
  readonly basisCents: number;
  readonly rate: number;
  readonly heldCents: number;
  readonly hold?: string;
  readonly payableCents: number;
}
export interface Statement {
  readonly period: string;
  readonly state: "DRAFT" | "ISSUED" | "DISPUTED" | "APPROVED" | "PAID" | "CORRECTED";
  readonly issued: string | null;
  readonly payDue: string;
  readonly paid: string | null;
  readonly lines: readonly StatementLine[];
}
const line = (agency: string, project: string, sequence: "FIRST" | "REPEAT", basisCents: number, hold?: string): StatementLine => {
  const rate = sequence === "FIRST" ? FIRST_RATE : REPEAT_RATE;
  const entitled = Math.round((basisCents * rate) / 100);
  return hold === undefined ? { agency, project, sequence, basisCents, rate, heldCents: 0, payableCents: entitled } : { agency, project, sequence, basisCents, rate, heldCents: entitled, hold, payableCents: 0 };
};
export const STATEMENTS: readonly Statement[] = [
  {
    period: "October 2026",
    state: "DRAFT",
    issued: null,
    payDue: "Nov 17, 2026",
    paid: null,
    lines: [line("Juniper Digital", "HubSpot contacts", "FIRST", 129_500), line("Coastline Analytics", "Q4 contacts", "REPEAT", 123_025, "Eligible 30 days after the project is complete; it is not complete yet")],
  },
  {
    period: "September 2026",
    state: "PAID",
    issued: "Oct 7, 2026",
    payDue: "Oct 15, 2026",
    paid: "Oct 15, 2026",
    lines: [line("Coastline Analytics", "Accounts and contacts", "FIRST", 229_500), line("Juniper Digital", "HubSpot contacts", "FIRST", 129_500, "Eligible on Oct 15, 2026, 30 days after the project was complete")],
  },
];
export const sumOf = (lines: readonly StatementLine[], key: "payableCents" | "heldCents" | "basisCents"): number => lines.reduce((sum, one) => sum + one[key], 0);
export const usd = (cents: number): string => `USD ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface Resource {
  readonly family: string;
  readonly version: number;
  readonly state: "CURRENT" | "SUPERSEDED";
  readonly since: string;
  readonly what: string;
  readonly replacedBy?: string;
}
export const RESOURCES: readonly Resource[] = [
  { family: "Offer sheet", version: 3, state: "CURRENT", since: "2026-10-12", what: "What Kauro does and does not do, the price bands and the free check, in English" },
  { family: "Worked example", version: 2, state: "CURRENT", since: "2026-10-05", what: "The synthetic project of the public site, step by step, for a demonstration" },
  { family: "Questions buyers ask", version: 2, state: "CURRENT", since: "2026-10-12", what: "Answers to the usual objections, each with the page of the site that backs it" },
  { family: "What a seller may promise", version: 1, state: "CURRENT", since: "2026-07-01", what: "The contract's limits: no discount, no deadline and no result you cannot show" },
  { family: "Offer sheet", version: 2, state: "SUPERSEDED", since: "2026-07-01", what: "Named an introductory discount that no longer exists", replacedBy: "Offer sheet version 3, on Oct 12, 2026" },
];

/** The policy's repeat ladder, as the offer sheet quotes it (a buyer's own discount, never the seller's to give). */
export const REPEAT_TIERS = POLICY_SNAPSHOT.repeatTiers;
