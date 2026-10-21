// The review states of billing (UI30), support cases (UI52) and company finance (UI39): the review project's order, its invoice and a
// refund; the project's support cases; the owner's bank route and the credits waiting to be matched. Built with the web's own test
// fixtures, so the schema guard checks every answer. Every name and figure is synthetic.
import type { SupportCaseView } from "@web/api/generated.ts";
import { order } from "@web-test/fixtures.ts";
import { capture, refund, supportCase, taxDocument } from "@web-test/fixtures-billing.ts";
import { EXAMPLE } from "../../prototypes/example.ts";
import { AGENCY_ID, type ReviewContext } from "../contexts.ts";
import type { Script } from "../fixture-fetch.ts";
import { PENDING, READ, type StateDef, UNAVAILABLE } from "../scenario.ts";
import { agencyFor } from "../world.ts";

const agencyOf = (ctx: ReviewContext): string => ctx.agency?.agencyId ?? AGENCY_ID;
const cents = (value: number): string => String(value);
const total = EXAMPLE.priceCents;

const ending = (op: string, label: string): readonly StateDef[] => [
  { key: "loading", label: "Loading", note: `The ${label} has not been read yet: the screen holds its place and says so.`, script: () => ({ [op]: PENDING }) },
  { key: "error", label: "Recoverable error", note: `The ${label} could not be read for a moment: the screen offers to try again.`, script: () => ({ [op]: UNAVAILABLE }) },
];

// ---------------------------------------------------------------- UI30 billing

const paidOrder = () => order({ state: "CAPTURED", paymentStatus: "CONFIRMED", expectedAmountCents: cents(total), createdAt: "2026-10-20T13:10:00Z", updatedAt: "2026-10-21T09:30:00Z" });
const billing = (withDocument: boolean) => (ctx: ReviewContext): Script => ({
  GetAgency: (call) => {
    const agency = agencyFor(ctx.key, call.params["agencyId"] ?? agencyOf(ctx));
    return agency === null ? { status: 403, problem: "NOT_AUTHORIZED", reason: "NOT_A_MEMBER" } : READ(agency);
  },
  GetPaymentOrder: () =>
    READ({
      order: paidOrder(),
      captures: [capture({ amountCents: cents(total), observedAt: "2026-10-21T09:30:00Z", allocated: { serviceCents: cents(total), taxCents: "0", excessCents: "0" } })],
      taxDocuments: withDocument ? [taxDocument({ serviceCents: cents(total), taxCents: "0", taxTreatment: "EXEMPT_EXPORT", legalNumber: "KAU-2026-000123", issuedAt: "2026-10-21T10:00:00Z" })] : [],
    }),
  GetRefund: () => READ(refund({ serviceCents: cents(total), taxCents: "0", requestedAt: "2026-10-22T09:00:00Z" })),
});

export const UI30_STATES: readonly StateDef[] = [
  { key: "normal", label: "Paid and invoiced", note: "The order paid by bank transfer, matched to the exact amount, and its invoice issued with its legal number.", script: billing(true) },
  { key: "invoice-pending", label: "Invoice being issued", note: "Paid, and the invoice not issued yet: the page never presents its own summary as an invoice.", script: billing(false) },
  ...ending("GetPaymentOrder", "order"),
];

// ---------------------------------------------------------------- UI52 support cases

const cases = (agency: string): readonly SupportCaseView[] => [
  supportCase({ agencyId: agency, caseId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6401", category: "BILLING", severity: "S3", state: "OPEN", summary: "Please add our VAT number to the invoice for this project.", createdAt: "2026-10-21T11:00:00Z", nextReviewAt: "2026-10-22T15:00:00Z" }),
  supportCase({ agencyId: agency, caseId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6402", category: "BILLING", severity: "S3", state: "RESOLVED", summary: "Which tax treatment applies to an agency outside the United States?", createdAt: "2026-10-18T15:20:00Z", nextReviewAt: "2026-10-19T15:20:00Z" } as Partial<SupportCaseView>),
];
const support = (list: (agency: string) => readonly SupportCaseView[]) => (ctx: ReviewContext): Script => ({
  ListSupportCases: () => READ({ items: list(agencyOf(ctx)) }),
  GetSupportCase: (call) => {
    const found = list(agencyOf(ctx)).find((item) => item.caseId === call.params["caseId"]);
    return found === undefined ? { status: 404, problem: "NOT_FOUND" } : READ(found);
  },
});

export const UI52_STATES: readonly StateDef[] = [
  { key: "normal", label: "Two cases", note: "The project's cases: one open, waiting for Kauro's next review, one resolved.", script: support(cases) },
  { key: "empty", label: "No case yet", note: "No question asked about this project: the form to open one.", script: support(() => []) },
  ...ending("ListSupportCases", "list of cases"),
];

// ---------------------------------------------------------------- UI39 company finance

export const ROUTE_ID = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6501";
const route = (state: "PENDING_VERIFICATION" | "VERIFIED" | "ENABLED" | "DISABLED") => ({
  route: { routeId: ROUTE_ID, routeVersion: 1, version: 3, state, rollout: state === "ENABLED" ? "CONTROLLED" : null, environment: "SANDBOX", accountRef: "acct-review-0001", detailsEvidenceHash: "136ccde705cf3f9b32d009ac025596158c52ca0be7686c98124a5d07825139da", verified: state !== "PENDING_VERIFICATION" },
});
const credits = {
  data: {
    credits: [
      { creditId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6511", accountRef: "acct-review-0001", bankTransactionId: "SYN-20261021-0001", state: "MATCH_REVIEW", version: 2, source: "OWNER_MANUAL", rail: "ACH", grossCents: cents(total), feeCents: "0", currency: "USD", reference: "K0123456789ABCDEFGHJKMN", orderId: null, captureId: null },
      { creditId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6512", accountRef: "acct-review-0001", bankTransactionId: "SYN-20261021-0002", state: "OBSERVED", version: 1, source: "OWNER_MANUAL", rail: "DOMESTIC_WIRE", grossCents: "98000", feeCents: "1500", currency: "USD", reference: null, orderId: null, captureId: null },
    ],
    nextCursor: null,
  },
};
// only the company's owner reads its finance: anyone else gets the server's refusal, as in production (a seller once saw the bank route
// and its controls here, because the review answered every person alike)
const REFUSED = { status: 403, problem: "NOT_AUTHORIZED", reason: "ROLE_INSUFFICIENT" } as const;
const finance = (state: "PENDING_VERIFICATION" | "VERIFIED" | "ENABLED" | "DISABLED") => (ctx: ReviewContext): Script =>
  ctx.key === "owner" ? { getBankRoute: { status: 200, body: route(state) }, listBankCredits: { status: 200, body: credits } } : { getBankRoute: REFUSED, listBankCredits: REFUSED };

export const UI39_STATES: readonly StateDef[] = [
  { key: "normal", label: "Route enabled, credits to match", note: "The bank route is enabled for a controlled rollout; two credits wait: one carries a reference, one does not.", script: finance("ENABLED") },
  { key: "pending", label: "Route waiting for verification", note: "The route's details were entered and wait for the owner's verification; nothing can be received yet.", script: finance("PENDING_VERIFICATION") },
  ...ending("getBankRoute", "bank route"),
];
