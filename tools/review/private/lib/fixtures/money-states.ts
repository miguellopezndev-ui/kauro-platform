// The review states of the free data health check (UI18), the quote (UI23), the payment (UI24) and the processing (UI25), all for the
// review's one project: the public site's worked example, 15,684 billable source units, HubSpot, priced by the policy's band. Built with
// the web's own test fixtures, so the schema guard checks every answer; every figure is synthetic.
import type { AuditView, PaymentOrderDetailView, PaymentOrderView, QuoteView } from "@web/api/generated.ts";
import { bandIndexOf, priceOf } from "@web/public/pricing-bands.ts";
import type { WorldProject } from "../world-projects.ts";
import { audit, order, quote } from "@web-test/fixtures.ts";
import { authorization, job } from "@web-test/fixtures-processing.ts";
import { EXAMPLE } from "../../prototypes/example.ts";
import { TIMELINE } from "../../prototypes/timeline.ts";
import { QUOTE_CENTS, REPEAT_BPS } from "../../prototypes/money.ts";
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
  GetAudit: () => READ(audit({ startedAt: TIMELINE.checkStartedAt, interpretationDeadlineAt: "2026-10-20T11:02:00Z", absoluteDeadline: TIMELINE.checkDeadline, ...overrides })),
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

// a review value with a real hash's shape (the SHA-256 of a review label), never the hash of a real terms document
const TERMS_HASH = "61bd222c8dee08741f6215b10aa467fb03fba3781b6033466593e3f24094df4a";
const cents = (value: number): string => String(value);
const units = EXAMPLE.units;
const base = EXAMPLE.priceCents;
/** The amount the main project's order asks for: its quote's total, after the repeat discount (prototypes/money.ts). */
const due = QUOTE_CENTS;
const repeat = (price: number): Partial<QuoteView> => { const off = Math.round((price * REPEAT_BPS) / 10_000); return { discountCents: cents(off), serviceCents: cents(price - off), totalCents: cents(price - off), discount: { bps: REPEAT_BPS, basis: "REPEAT" } }; };

function quoteOf(agency: string, overrides: Partial<QuoteView> = {}): QuoteView {
  return quote({ agencyId: agency, billableUnits: units, baseServiceCents: cents(base), serviceCents: cents(base), totalCents: cents(base), issuedAt: TIMELINE.quoteIssuedAt, expiresAt: TIMELINE.quoteExpiresAt, sourceAvailableUntil: TIMELINE.filesKeptUntil, termsHash: TERMS_HASH, ...overrides });
}

// the quote of the project the page names: its service and that service's price for the same units (a quote is read by its own id)
const priceFor = (mode: QuoteView["mode"]): number => { const band = bandIndexOf(units); return band === null ? base : priceOf(band, mode); };
const quoteState = (overrides: (price: number) => Partial<QuoteView>) => (ctx: ReviewContext, project?: WorldProject): Script => {
  const mode = project?.mode ?? "HUBSPOT";
  const price = priceFor(mode);
  // the server permits the payment commands only to an owner or a billing member (AGENCY_BILLING): anyone else reads who can
  const pays = ctx.agency?.permittedActions.includes("MANAGE_BILLING") === true;
  return { GetQuote: () => READ(quoteOf(agencyOf(ctx), { mode, baseServiceCents: cents(price), serviceCents: cents(price), totalCents: cents(price), pricePolicyVersion: "R2-INITIAL", ...(pays ? {} : { permittedActions: [] }), ...overrides(price) })) };
};

export const UI23_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to pay", note: "Northwind Data's quote: the band's list price for 15,684 units, the 5% repeat discount it earned with its earlier paid projects, the tax treatment, the total, and the two dates side by side (the files end before the price).", script: quoteState((price) => repeat(price)) },
  { key: "first", label: "A first project", note: "A workspace's first paid project: the list price, and the line says no discount applies.", script: quoteState(() => ({})) },
  { key: "expired", label: "Expired", note: "The quote's time has passed: no Pay now, a new quote instead.", script: quoteState(() => ({ state: "EXPIRED", checkoutReady: false, checkoutBlockers: ["QUOTE_EXPIRED"], permittedActions: [] })) },
  { key: "source-expired", label: "Files no longer kept", note: "The sealed files are past their date: the page offers to upload and check again, never to pay.", script: quoteState(() => ({ checkoutReady: false, checkoutBlockers: ["SOURCE_EXPIRED"], permittedActions: [] })) },
  ...ending("GetQuote", "quote"),
];

// ---------------------------------------------------------------- UI24 the payment, by bank transfer

function orderOf(overrides: Partial<PaymentOrderView>): PaymentOrderView {
  return order({ expectedAmountCents: cents(due), createdAt: TIMELINE.orderCreatedAt, updatedAt: TIMELINE.orderCreatedAt, ...overrides });
}
const detail = (orderView: PaymentOrderView, extra: Partial<PaymentOrderDetailView> = {}): PaymentOrderDetailView => ({ order: orderView, captures: [], taxDocuments: [], ...extra });
const instructions = {
  instructions: {
    beneficiaryName: "Kauro (synthetic)",
    bankName: "Example Bank (synthetic)",
    routingNumber: "123456789",
    accountNumber: "000012345678",
    accountType: "CHECKING",
    amountCents: cents(due),
    currency: "USD",
    reference: "K0123456789ABCDEFGHJKMN",
    sendBy: TIMELINE.sendBy.replace(/Z$/, ".000Z"),
    transferExpiresAt: TIMELINE.orderClosesAt.replace(/Z$/, ".000Z"),
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
  GetJob: () => READ(job({ state, queuedAt: TIMELINE.preparationStartedAt, deliveryDeadlineAt: "2026-10-23T10:00:00Z", permittedActions: state === "QUEUED" ? ["CancelJob"] : [], ...(state === "READY" ? { publishedPackageId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6301" } : {}) })),
});

export const UI25_STATES: readonly StateDef[] = [
  { key: "normal", label: "Preparing", note: "The approved plan is being prepared on the sealed files: the page separates the stages and says honestly what an estimate is.", script: processing("RUNNING") },
  { key: "queued", label: "Queued", note: "Paid and approved, waiting for its turn; it can still be cancelled.", script: processing("QUEUED") },
  { key: "verifying", label: "Verifying", note: "Prepared; Kauro checks every file against the plan before publishing it.", script: processing("VERIFYING") },
  { key: "ready", label: "Ready", note: "The package is verified and published: the next step is the delivery.", script: processing("READY") },
  { key: "failed", label: "Failed", note: "The preparation did not finish: the page says what happens next and what is safe.", script: processing("FAILED") },
  ...ending("GetJob", "preparation"),
];
