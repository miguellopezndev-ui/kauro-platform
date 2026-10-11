// UI23 Quote and UI24 Payment (design D-STATE-1, D-OPS-1; payments V1: ACH/USD bank transfer, no redirect; cases S066, R2-063). Three layers,
// tested apart: the decisions (model.ts), the markup (rendered on the server side of React, which is what the browser receives before any
// script), and the one command (CMD028) through the real api client and OperationRunner over a scripted fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type CreatePaymentOrderView, SCHEMAS } from "../src/api/generated.ts";
import { validateAgainst } from "../src/api/schema-guard.ts";
import { OperationRunner } from "../src/client/operation-runner.ts";
import { stateOfProblem } from "../src/client/states.ts";
import { EN } from "../src/copy/en.ts";
import { canCreateOrder, createPaymentOrder, instructionsRead, offersReupload, paymentModel, quoteGate } from "../src/screens/payments/model.ts";
import { PaymentDetails } from "../src/screens/payments/payment-view.tsx";
import { QuoteDetails } from "../src/screens/payments/quote-view.tsx";
import { harness, order, ORDER, problem, QUOTE, quote, respond } from "./support/fixtures.ts";

const NOW = Date.parse("2026-10-14T00:00:00Z");
const noop = (): void => undefined;
const props = (overrides: Partial<Parameters<typeof QuoteDetails>[0]> = {}) => ({
  quote: quote(),
  nowMs: NOW,
  termsAccepted: false,
  onTermsChange: noop,
  onCreate: noop,
  creating: false,
  termsHref: "/legal/terms",
  reuploadHref: "/agencies/a/projects/p/sources",
  ...overrides,
});
const render = (overrides: Partial<Parameters<typeof QuoteDetails>[0]> = {}): string => renderToStaticMarkup(createElement(QuoteDetails, props(overrides)));
const payButton = (html: string): string => /<button[^>]*>Create payment order<\/button>/.exec(html)?.[0] ?? "";

test("fixtures: the quote and the order are valid against the generated schemas (a drifted fixture cannot prove anything)", () => {
  assert.deepEqual(validateAgainst(SCHEMAS as never, "QuoteView", quote()), []);
  assert.deepEqual(validateAgainst(SCHEMAS as never, "PaymentOrderView", order()), []);
});

// ---- UI23 ----

test("UI23: the quote shows base, one discount, service, tax, total, units, terms and both expiries, with money from minor units and the exact registry sentence", () => {
  const html = render({ quote: quote({ discount: { bps: 1000, basis: "REPEAT" }, discountCents: "15000", serviceCents: "135000", taxCents: "0", totalCents: "135000" }) });
  assert.ok(html.includes("Review price, scope and availability."));
  for (const text of ["USD 1,500.00", "USD 1,350.00", "1200", "Repeat-project discount, 10 percent.", "Prepare for HubSpot", "Price valid until", "Source files kept until", "Read the service terms"]) assert.ok(html.includes(text), text);
  assert.match(html, /dateTime="2026-10-20T12:00:00.000Z"/);
  assert.match(html, /dateTime="2026-10-27T12:00:00.000Z"/);
});

test("UI23: Pay is disabled until the terms are accepted, and enabled only for an open quote; a blocker, an expired price or a replaced quote leaves no way to pay", () => {
  assert.match(payButton(render()), /disabled/, "terms not accepted");
  assert.doesNotMatch(payButton(render({ termsAccepted: true })), /disabled/, "open quote and terms accepted");
  assert.match(payButton(render({ termsAccepted: true, creating: true })), /disabled/, "while the order is being created");
  const blocked = quote({ checkoutReady: false, checkoutBlockers: ["FISCAL_TREATMENT_UNREVIEWED", "DELIVERY_CAPACITY_UNAVAILABLE"] });
  const blockedHtml = render({ quote: blocked, termsAccepted: true });
  assert.match(payButton(blockedHtml), /disabled/);
  assert.ok(blockedHtml.includes(EN["screen.quote.blocker.FISCAL_TREATMENT_UNREVIEWED"]) && blockedHtml.includes(EN["screen.quote.blocker.DELIVERY_CAPACITY_UNAVAILABLE"]));
  for (const text of [render({ quote: quote({ state: "EXPIRED" }) }), render({ nowMs: Date.parse("2026-10-20T12:00:00Z") }), render({ quote: quote({ state: "SUPERSEDED" }) })]) {
    assert.equal(payButton(text), "", "no payment control at all");
    assert.ok(!text.includes(EN["screen.quote.pay.cta"]));
  }
});

test("UI23: expired price says so and offers a new quote, never Pay now; expired data offers re-upload and revalidation", () => {
  const expired = render({ nowMs: Date.parse("2026-10-21T00:00:00Z") });
  assert.ok(expired.includes("This quote has expired"));
  assert.doesNotMatch(expired, /Pay now/i);
  const data = quote({ checkoutReady: false, checkoutBlockers: ["SOURCE_EXPIRED"] });
  assert.equal(offersReupload(data), true);
  const html = render({ quote: data, termsAccepted: true });
  assert.ok(html.includes("Upload and review the files again") && html.includes('href="/agencies/a/projects/p/sources"'));
  assert.match(payButton(html), /disabled/);
  assert.equal(offersReupload(quote()), false);
});

test("UI23: the browser clock can only disable Pay, never enable it (a clock set back does not revive a closed quote)", () => {
  const closed = quote({ checkoutReady: false, checkoutBlockers: ["QUOTE_NOT_ACTIVE"] });
  assert.equal(canCreateOrder(closed, 0, true), false);
  assert.equal(canCreateOrder(quote({ state: "EXPIRED" }), 0, true), false);
  assert.equal(canCreateOrder(quote({ permittedActions: [] }), 0, true), false, "the server does not permit CMD028");
  assert.equal(quoteGate(quote(), NOW).kind, "OPEN");
});

test("UI23 copy: no PayPal, no redirect wording, no founding line, and the free step is never called an audit anywhere in the screens' copy", () => {
  const screens = Object.entries(EN).filter(([id]) => id.startsWith("screen."));
  for (const [id, text] of screens) {
    assert.doesNotMatch(text, /paypal|redirect|pay now|founding|\baudit/i, id);
  }
});

// ---- the command (S066, R2-063) ----

const completed = (overrides: Partial<CreatePaymentOrderView> = {}): unknown => ({
  kind: "COMPLETED",
  version: 1,
  replayed: false,
  data: { order: order(), quote: quote({ state: "ACCEPTED_FOR_CHECKOUT" }), ...overrides },
});
const fastRunner = (): OperationRunner => new OperationRunner({ now: () => NOW, randomBytes: (n) => new Uint8Array(n).fill(7), wait: async () => undefined });

test("S066: CMD028 sends the quote's own terms hash for a bank transfer, and a double activation is one request under one key", async () => {
  const { client, sent } = harness(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return respond(201, completed());
  });
  const runner = fastRunner();
  const [a, b] = await Promise.all([createPaymentOrder(client, runner, quote()), createPaymentOrder(client, runner, quote())]);
  assert.equal(a.kind, "COMPLETED");
  assert.equal(b.kind, "COMPLETED");
  assert.equal(sent.length, 1, "the in-flight run is joined, never repeated");
  const [request] = sent;
  assert.equal(request?.url, `/api/v1/quotes/${QUOTE}/payment-orders`);
  assert.equal(request?.init.method, "POST");
  assert.deepEqual(JSON.parse(request?.init.body ?? "{}"), { termsHash: "c".repeat(64), routeKind: "BANK_TRANSFER" });
  assert.match(request?.init.headers["Idempotency-Key"] ?? "", /^[A-Za-z0-9_-]{16,128}$/);
});

test("S066: the same quote version always derives the same key (reload and a second tab replay), a newer version is a new intent", async () => {
  const { client, sent } = harness(async () => respond(201, completed()));
  await createPaymentOrder(client, fastRunner(), quote());
  await createPaymentOrder(client, fastRunner(), quote());
  await createPaymentOrder(client, fastRunner(), quote({ version: 4 }));
  const keys = sent.map((entry) => entry.init.headers["Idempotency-Key"]);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
});

test("S066: a lost answer retries with the SAME key and ends as Checking, never as failed and never with a new key", async () => {
  const { client, sent } = harness(async () => {
    throw new TypeError("network");
  });
  const outcome = await createPaymentOrder(client, fastRunner(), quote());
  assert.equal(outcome.kind, "CHECKING");
  assert.ok(sent.length >= 2);
  assert.equal(new Set(sent.map((entry) => entry.init.headers["Idempotency-Key"])).size, 1);
});

test("R2-063: an order refused because the quote went stale or expired is a stated problem (STALE/RESTRICTED), and no payment is faked", async () => {
  const { client } = harness(async () => respond(409, problem(409, "PRECONDITION_FAILED", { reason: "QUOTE_EXPIRED" })));
  const outcome = await createPaymentOrder(client, fastRunner(), quote());
  assert.equal(outcome.kind, "PROBLEM");
  if (outcome.kind === "PROBLEM") assert.equal(stateOfProblem(outcome.problem).state, "STALE");
});

// ---- UI24 ----

const detailsProps = (over: Partial<Parameters<typeof PaymentDetails>[0]> = {}) => ({
  order: order(),
  instructions: { kind: "NOT_SHOWN" } as const,
  onRefresh: noop,
  refreshing: false,
  hrefs: { CONTACT_SUPPORT: "/agencies/a/support", REQUEST_NEW_QUOTE: "/agencies/a/projects/p/purchase", REQUEST_NEW_REVIEW: "/agencies/a/projects/p/audit" },
  ...over,
});
const renderPayment = (over: Partial<Parameters<typeof PaymentDetails>[0]> = {}): string => renderToStaticMarkup(createElement(PaymentDetails, detailsProps(over)));
const INSTRUCTIONS = { beneficiaryName: "Kauro Data LLC", bankName: "Example Bank", routingNumber: "123456789", accountNumber: "000123456789", accountType: "CHECKING", amountCents: "150000", currency: "USD", reference: "KAU-7F3A92", sendBy: "2026-10-16T12:00:00Z", transferExpiresAt: "2026-10-20T12:00:00Z", routeVersion: 1 } as const;

test("UI24: each payment status has its own text from paymentStatus alone, and pending or checking says not to pay again", () => {
  const expectations: ReadonlyArray<readonly [Parameters<typeof order>[0] & object, string, boolean]> = [
    [{ paymentStatus: "NOT_STARTED" }, "Waiting for your transfer", false],
    [{ paymentStatus: "PENDING" }, "Payment pending", true],
    [{ paymentStatus: "CHECKING" }, "Checking payment", true],
    [{ paymentStatus: "CONFIRMED" }, "Payment confirmed", false],
    [{ paymentStatus: "FAILED" }, "Payment failed", false],
  ];
  for (const [over, label, repeat] of expectations) {
    const html = renderPayment({ order: order(over) });
    assert.ok(html.includes(label), label);
    assert.equal(html.includes("Do not pay again"), repeat, label);
    assert.ok(html.includes("Your status comes from verified payment information."));
    assert.ok(html.includes("is not payment"), "a return or screenshot is not payment");
  }
});

test("UI24: a provider state, a redirect address or a capture action is never read as payment: only paymentStatus and nextActions speak", () => {
  // state CAPTURED and a checkout address with paymentStatus PENDING: the page still says pending and offers no provider action
  const risky = order({ state: "CAPTURED", paymentStatus: "PENDING", providerOrderId: "PO-1", checkout: { approvalUrl: "https://pay.example/approve", providerOrderId: "PO-1" }, nextActions: ["APPROVE_AT_PROVIDER", "CAPTURE"] });
  const html = renderPayment({ order: risky });
  assert.ok(html.includes("Payment pending"));
  assert.doesNotMatch(html, /Payment confirmed|pay\.example|approve at|capture/i);
  assert.deepEqual(paymentModel(risky).actions, ["REFRESH_STATUS"]);
});

test("UI24: the actions are the same-operation refresh, support, and the server's new-quote or new-review steps; a settled order offers no refresh", () => {
  assert.deepEqual(paymentModel(order({ paymentStatus: "CHECKING", nextActions: ["REFRESH_STATUS", "CONTACT_SUPPORT"] })).actions, ["REFRESH_STATUS", "CONTACT_SUPPORT"]);
  assert.deepEqual(paymentModel(order({ paymentStatus: "FAILED", nextActions: ["REQUEST_NEW_QUOTE"] })).actions, ["REQUEST_NEW_QUOTE"]);
  assert.deepEqual(paymentModel(order({ paymentStatus: "CONFIRMED" })).actions, []);
  const html = renderPayment({ order: order({ paymentStatus: "FAILED", nextActions: ["REQUEST_NEW_QUOTE", "CONTACT_SUPPORT"] }) });
  assert.ok(html.includes('href="/agencies/a/projects/p/purchase"') && html.includes('href="/agencies/a/support"'));
  assert.ok(renderPayment({ order: order({ paymentStatus: "PENDING" }) }).includes("Checking again reads the same order. It never creates a new payment."));
});

test("UI24: the ACH details are shown with the reference and the exact amount while nothing is pending, and never beside a pending or checking status", () => {
  const html = renderPayment({ instructions: { kind: "READY", instructions: INSTRUCTIONS } });
  for (const text of ["Kauro Data LLC", "Example Bank", "123456789", "000123456789", "Checking", "KAU-7F3A92", "USD 1,500.00", 'dateTime="2026-10-16T12:00:00.000Z"', 'dateTime="2026-10-20T12:00:00.000Z"']) assert.ok(html.includes(text), text);
  for (const status of ["PENDING", "CHECKING", "CONFIRMED", "FAILED"] as const) {
    assert.doesNotMatch(renderPayment({ order: order({ paymentStatus: status }), instructions: { kind: "READY", instructions: INSTRUCTIONS } }), /KAU-7F3A92/, status);
  }
});

test("UI24: expired or unavailable bank details are stated and never shown; the support reference rides along", () => {
  const expired = renderPayment({ instructions: { kind: "EXPIRED" } });
  assert.ok(expired.includes("These bank details have expired") && !expired.includes("KAU-"));
  assert.deepEqual(instructionsRead({ kind: "PROBLEM", status: 409, correlationId: "c", problem: problem(409, "PRECONDITION_FAILED", { reason: "INSTRUCTIONS_EXPIRED" }) }), { kind: "EXPIRED" });
  const unavailable = instructionsRead({ kind: "PROBLEM", status: 404, correlationId: "c", problem: problem(404, "NOT_FOUND") });
  assert.equal(unavailable.kind, "UNAVAILABLE");
  assert.ok(renderPayment({ instructions: unavailable }).includes("Bank details are not available"));
  assert.equal(instructionsRead({ kind: "NO_ANSWER", reason: "NETWORK", status: null }).kind, "UNAVAILABLE");
  assert.ok(renderPayment({ instructions: { kind: "LOADING" } }).includes("Fetching the current information."));
  assert.equal(ORDER.length, 36);
});
