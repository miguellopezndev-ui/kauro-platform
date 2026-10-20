// The review states of the free data health check (UI18), the quote (UI23), the payment (UI24) and the processing (UI25), all for the
// review's one project: the public site's worked example, 15,684 billable source units, HubSpot, priced by the policy's band. Built with
// the web's own test fixtures, so the schema guard checks every answer; every figure is synthetic.
import type { AuditView, PaymentOrderDetailView, PaymentOrderView, QuoteView } from "@web/api/generated.ts";
import { audit, order, quote } from "@web-test/fixtures.ts";
import { authorization, job } from "@web-test/fixtures-processing.ts";
import { EXAMPLE } from "../../prototypes/example.ts";
import { AGENCY_ID, type ReviewContext } from "../contexts.ts";
import type { Script } from "../fixture-fetch.ts";
import { PENDING, READ, type StateDef, UNAVAILABLE } from "../scenario.ts";

const agencyOf = (ctx: ReviewContext): string => ctx.agency?.agencyId ?? AGENCY_ID;
const ending: (op: string, label: string) => readonly StateDef[] = (op, label) => [
  { key: "loading", label: "Loading", note: `The ${label} has not been read yet: the screen holds its place and says so.`, script: () => ({ [op]: PENDING }) },
  { key: "error", label: "Recoverable error", note: `The ${label} could not be read for a moment: the screen offers to try again.`, script: () => ({ [op]: UNAVAILABLE }) },
  { key: "denied", label: "Not a member", note: "A signed-in person who is not a member of this agency: the shell refuses before anything is read.", base: "AGENCY_REFUSED" },
];

// ---------------------------------------------------------------- UI18 the free data health check

const check = (overrides: Partial<AuditView>) => (): Script => ({
  GetAudit: () => READ(audit({ startedAt: "2026-10-20T10:02:00Z", interpretationDeadlineAt: "2026-10-20T11:02:00Z", absoluteDeadline: "2026-10-20T12:02:00Z", ...overrides })),
});

export const UI18_STATES: readonly StateDef[] = [
  { key: "normal", label: "Reading the full data", note: "The check reads every row of the sealed set: it runs on its own, and the page says where it is.", script: check({ state: "PROFILING" }) },
  { key: "interpreting", label: "Interpreting", note: "The full data is read; what was found is being interpreted.", script: check({ state: "INTERPRETING", version: 3 }) },
  { key: "ready", label: "Draft plan ready", note: "The check is done and a draft plan is ready: the next step is reviewing it.", script: check({ state: "DRAFT_READY", version: 5, grantState: "CLOSED", draftPlanId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6201", permittedActions: ["CreatePlan"] }) },
  { key: "decisions", label: "Needs decisions", note: "The check asks the team to decide before a plan can be drafted; each decision is named by the api.", script: check({ state: "NEEDS_DECISION", version: 5, pendingDecisions: ["DUPLICATE_POLICY", "COMPANY_DOMAIN_SOURCE"], permittedActions: [] }) },
  { key: "exhausted", label: "Allowance used up", note: "The free allowance ran out: the measured profile is kept, and the page says the interpretation is incomplete.", script: check({ state: "NEEDS_DECISION", version: 6, grantState: "EXHAUSTED", pendingDecisions: ["DUPLICATE_POLICY"], permittedActions: [] }) },
  { key: "unsupported", label: "Part not supported", note: "Something in the files is not supported for this project: it is named, never silently dropped.", script: check({ state: "UNSUPPORTED", version: 5, unsupportedCapabilities: ["CUSTOM_OBJECTS"], permittedActions: [] }) },
  { key: "failed", label: "Did not finish", note: "The check could not finish: its reason code is shown, and nothing is charged.", script: check({ state: "FAILED", version: 4, terminalReason: "PROFILE_TIMEOUT", permittedActions: [] }) },
  ...ending("GetAudit", "check"),
];

// ---------------------------------------------------------------- UI23 the quote

const cents = (value: number): string => String(value);
const units = EXAMPLE.units;
const base = EXAMPLE.priceCents;

function quoteOf(agency: string, overrides: Partial<QuoteView> = {}): QuoteView {
  return quote({ agencyId: agency, billableUnits: units, baseServiceCents: cents(base), serviceCents: cents(base), totalCents: cents(base), issuedAt: "2026-10-20T13:00:00Z", expiresAt: "2026-10-27T13:00:00Z", sourceAvailableUntil: "2026-11-03T09:00:00Z", ...overrides });
}

const quoteState = (overrides: Partial<QuoteView>) => (ctx: ReviewContext): Script => ({ GetQuote: () => READ(quoteOf(agencyOf(ctx), overrides)) });
const repeat = Math.round(base * 0.05);

export const UI23_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to pay", note: "The first project's quote: the base price for 15,684 units in the HubSpot band, no discount, the tax treatment, the total and when it expires.", script: quoteState({}) },
  { key: "repeat", label: "With the repeat discount", note: "A later project: the repeat discount on its own line, one discount only.", script: quoteState({ discountCents: cents(repeat), serviceCents: cents(base - repeat), totalCents: cents(base - repeat), discount: { bps: 500, basis: "REPEAT" } }) },
  { key: "expired", label: "Expired", note: "The quote's time has passed: no Pay now, a new quote instead.", script: quoteState({ state: "EXPIRED", checkoutReady: false, checkoutBlockers: ["QUOTE_EXPIRED"], permittedActions: [] }) },
  { key: "source-expired", label: "Files no longer kept", note: "The sealed files are past their date: the page offers to upload and check again, never to pay.", script: quoteState({ checkoutReady: false, checkoutBlockers: ["SOURCE_EXPIRED"], permittedActions: [] }) },
  ...ending("GetQuote", "quote"),
];

// ---------------------------------------------------------------- UI24 the payment, by bank transfer

function orderOf(overrides: Partial<PaymentOrderView>): PaymentOrderView {
  return order({ expectedAmountCents: cents(base), createdAt: "2026-10-20T13:10:00Z", updatedAt: "2026-10-20T13:10:00Z", ...overrides });
}
const detail = (orderView: PaymentOrderView, extra: Partial<PaymentOrderDetailView> = {}): PaymentOrderDetailView => ({ order: orderView, captures: [], taxDocuments: [], ...extra });
const instructions = {
  instructions: {
    beneficiaryName: "Kauro (synthetic)",
    bankName: "Example Bank (synthetic)",
    routingNumber: "123456789",
    accountNumber: "000012345678",
    accountType: "CHECKING",
    amountCents: cents(base),
    currency: "USD",
    reference: "K0123456789ABCDEFGHJKMN",
    sendBy: "2026-10-24T23:59:59.000Z",
    transferExpiresAt: "2026-10-27T13:00:00.000Z",
    routeVersion: 1,
  },
};
const payment = (orderView: PaymentOrderView, extra: Partial<PaymentOrderDetailView> = {}) => (): Script => ({
  GetPaymentOrder: () => READ(detail(orderView, extra)),
  getTransferInstructions: { status: 200, body: instructions },
});

export const UI24_STATES: readonly StateDef[] = [
  { key: "normal", label: "Waiting for the transfer", note: "The order exists: the bank details, the exact amount, the reference to quote and the date to send by. Nothing counts until the exact amount is matched.", script: payment(orderOf({ state: "CREATED", paymentStatus: "NOT_STARTED", nextActions: ["REFRESH_STATUS"] })) },
  { key: "pending", label: "Transfer sent, not matched yet", note: "The payer says the transfer is on its way: Kauro has not matched it yet, and the page says not to pay again.", script: payment(orderOf({ state: "CREATED", paymentStatus: "PENDING", nextActions: ["REFRESH_STATUS"] })) },
  { key: "checking", label: "Checking", note: "A transfer may have arrived: Kauro is matching it, and the page says not to pay again.", script: payment(orderOf({ state: "CAPTURE_UNCERTAIN", paymentStatus: "CHECKING", nextActions: ["REFRESH_STATUS", "CONTACT_SUPPORT"] })) },
  { key: "confirmed", label: "Confirmed", note: "The exact amount was matched: the preparation can start.", script: payment(orderOf({ state: "CAPTURED", paymentStatus: "CONFIRMED", nextActions: [] }), { commercialAuthorization: authorization({ mode: "HUBSPOT", billableUnits: units }) }) },
  { key: "failed", label: "Failed", note: "The payment did not complete: a new quote is the way forward, never a second payment on the same order.", script: payment(orderOf({ state: "FAILED", paymentStatus: "FAILED", nextActions: ["REQUEST_NEW_QUOTE", "CONTACT_SUPPORT"] })) },
  ...ending("GetPaymentOrder", "payment"),
];

// ---------------------------------------------------------------- UI25 the processing

const paid = (): PaymentOrderDetailView => detail(orderOf({ state: "CAPTURED", paymentStatus: "CONFIRMED" }), { commercialAuthorization: authorization({ mode: "HUBSPOT", billableUnits: units }) });
const processing = (state: "QUEUED" | "RUNNING" | "VERIFYING" | "READY" | "FAILED") => (): Script => ({
  GetPaymentOrder: () => READ(paid()),
  GetJob: () => READ(job({ state, queuedAt: "2026-10-20T14:00:00Z", deliveryDeadlineAt: "2026-10-22T14:00:00Z", permittedActions: state === "QUEUED" ? ["CancelJob"] : [], ...(state === "READY" ? { publishedPackageId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6301" } : {}) })),
});

export const UI25_STATES: readonly StateDef[] = [
  { key: "normal", label: "Preparing", note: "The approved plan is being prepared on the sealed files: the page separates the stages and says honestly what an estimate is.", script: processing("RUNNING") },
  { key: "queued", label: "Queued", note: "Paid and approved, waiting for its turn; it can still be cancelled.", script: processing("QUEUED") },
  { key: "verifying", label: "Verifying", note: "Prepared; Kauro checks every file against the plan before publishing it.", script: processing("VERIFYING") },
  { key: "ready", label: "Ready", note: "The package is verified and published: the next step is the delivery.", script: processing("READY") },
  { key: "failed", label: "Failed", note: "The preparation did not finish: the page says what happens next and what is safe.", script: processing("FAILED") },
  ...ending("GetJob", "preparation"),
];
