// UI30 Billing and UI32 Settings (design D-STATE-1, D-OPS-1, D-AUTH-4; cases CMD031, CMD043, CMD044). Three layers, tested apart: the decisions
// (model.ts), the markup (rendered on the server side of React, which is what the browser receives before any script), and the commands
// through the real api client and OperationRunner over a scripted fetch. Every fixture is validated against the generated schemas.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCHEMAS } from "../src/api/generated.ts";
import { validateAgainst } from "../src/api/schema-guard.ts";
import { IdentityCredential } from "../src/client/identity/port.ts";
import { OperationRunner } from "../src/client/operation-runner.ts";
import { stateOfRun } from "../src/client/states.ts";
import { EN } from "../src/copy/en.ts";
import { BillingScreen } from "../src/screens/billing/container.tsx";
import { billingModel, readRefund, refundInputProblems, requestRefund } from "../src/screens/billing/model.ts";
import { BillingDetails, type BillingViewProps } from "../src/screens/billing/view.tsx";
import { SettingsScreen } from "../src/screens/settings/container.tsx";
import { closeWithStepUp, settingsModel } from "../src/screens/settings/model.ts";
import { SettingsDetails } from "../src/screens/settings/view.tsx";
import { StepUpPanel } from "../src/screens/shared/step-up.tsx";
import { ShellContext } from "../src/shell/shell-context.ts";
import { AGENCY, harness, order, ORDER, PROJECT, problem, respond } from "./support/fixtures.ts";
import { agency, capture, CASE, CLOSURE, closure, orderDetail, PROOF, REFUND, refund, supportCase, taxDocument } from "./support/fixtures-billing.ts";

const NOW = Date.parse("2026-10-14T00:00:00Z");
const noop = (): void => undefined;
let entropy = 0;
const fastRunner = (): OperationRunner => new OperationRunner({ now: () => NOW, randomBytes: (n) => new Uint8Array(n).fill((entropy += 1) % 256), wait: async () => undefined });
const credential = (): IdentityCredential => new IdentityCredential("CONTRACT_FAKE", "STEP_UP", "provider-token-value");
const bodyOf = (init: { body?: string }): Record<string, unknown> => JSON.parse(init.body ?? "{}") as Record<string, unknown>;
const keyOf = (init: { headers: Readonly<Record<string, string>> }): string | undefined => init.headers["Idempotency-Key"];

const form = (overrides: Partial<BillingViewProps["form"]> = {}): BillingViewProps["form"] => ({ reason: "", details: "", problems: [], submitting: false, onReasonChange: noop, onDetailsChange: noop, onSubmit: noop, open: true, onOpen: noop, ...overrides });
const billing = (overrides: Partial<BillingViewProps> = {}): string => renderToStaticMarkup(createElement(BillingDetails, { agency: agency(), detail: orderDetail(), refund: null, form: form(), projectHref: "/agencies/a/projects/p", ...overrides }));
const settings = (overrides: Partial<Parameters<typeof SettingsDetails>[0]> = {}): string => renderToStaticMarkup(createElement(SettingsDetails, { agency: agency({ permittedActions: ["VIEW", "MANAGE_BILLING", "REQUEST_DELETION", "MANAGE_AGENCY"] }), onClose: noop, closing: false, closure: null, ...overrides }));

test("fixtures: the billing and settings DTOs are valid against the generated schemas (a drifted fixture cannot prove anything)", () => {
  const checks: readonly (readonly [string, unknown])[] = [
    ["AgencyView", agency()],
    ["CaptureView", capture()],
    ["TaxDocumentView", taxDocument()],
    ["PaymentOrderDetailView", orderDetail()],
    ["RefundView", refund()],
    ["SupportCaseView", supportCase()],
    ["AgencyClosureView", closure()],
  ];
  for (const [name, value] of checks) assert.deepEqual(validateAgainst(SCHEMAS as never, name, value), [], name);
});

test("UI30: the order shows captures, tax documents and refunds from the server only; a local summary is never called an invoice; a member without MANAGE_BILLING gets the request-to-owner text", () => {
  const html = billing();
  assert.equal(EN["screen.billing.lead.body"], "Track quotes, payments, fiscal documents and refunds.", "the registry sentence, word for word (round 2: drawn by the page header)");
  // money is the server's integer cents, formatted without arithmetic
  for (const text of ["USD 1,500.00", "USD 1,400.00", "USD 100.00", "USD 0.00"]) assert.ok(html.includes(text), text);
  assert.ok(html.includes("Payment confirmed") && html.includes("SETT-000123"), "the capture and the issued document come from the order read");
  // the issued document is the only thing called an invoice, and the order amount says it is not one
  assert.equal(html.match(/\bInvoice\b/g)?.length, 1);
  assert.ok(html.includes("not a fiscal invoice"));

  // a document that is not issued is never called an invoice and shows no legal number
  const draft = billing({ detail: orderDetail({ taxDocuments: [taxDocument({ state: "DRAFT" })] }) });
  const { legalNumber: _legalNumber, issuedAt: _issuedAt, ...unissued } = taxDocument({ state: "DRAFT" });
  const noNumber = billing({ detail: orderDetail({ taxDocuments: [unissued] }) });
  for (const text of [draft, noNumber]) {
    assert.doesNotMatch(text, /\bInvoice\b/, "no issued invoice, no invoice word");
    assert.ok(text.includes("Fiscal document not yet issued") && text.includes("Being prepared"));
  }
  assert.ok(!noNumber.includes("Legal number"));
  const none = billing({ detail: orderDetail({ captures: [], taxDocuments: [] }) });
  assert.ok(none.includes("No payment has been received for this order.") && none.includes("No fiscal document has been issued for this order yet."));
  assert.doesNotMatch(none, /\bInvoice\b/);

  // refunds are the server's: the refund read back is drawn with its own state and proposed amounts
  const refunded = billing({ refund: refund() });
  assert.ok(refunded.includes("Refund requested") && refunded.includes("USD 1,400.00") && refunded.includes("These amounts are proposed and may change when the refund is approved."));
  assert.ok(!refunded.includes('name="reason"'), "no second refund form beside a refund");
  assert.ok(billing().includes("No refund has been requested for this order."));
  // the form opens on request: closed, a button names the act and the refund terms are read first
  const closed = billing({ form: form({ open: false }) });
  assert.ok(!closed.includes('name="reason"') && closed.includes("Request a refund") && closed.includes("Before the preparation starts, a refund is full."));

  // MANAGE_BILLING decides the control; without it the owner text replaces the form, and nothing to send is offered
  const manager = billing();
  assert.ok(manager.includes('name="reason"') && manager.includes("Request refund"));
  const viewer = billing({ agency: agency({ permittedActions: ["VIEW"] }) });
  assert.ok(viewer.includes("Ask an owner to request this refund") && viewer.includes("Only members who manage billing can request a refund."));
  assert.ok(!viewer.includes('name="reason"') && !viewer.includes("Request refund"));
  assert.deepEqual(billingModel(agency({ permittedActions: ["VIEW"] }), orderDetail()), { canRequestRefund: false, mustAskOwner: true });
  assert.deepEqual(billingModel(agency(), orderDetail({ captures: [capture({ status: "PENDING" })] })), { canRequestRefund: false, mustAskOwner: false }, "no confirmed payment, no refund control");
  assert.ok(billing({ detail: orderDetail({ captures: [capture({ status: "PENDING" })] }) }).includes("A refund can be requested after a payment has been confirmed."));

  // customer strings are text, never markup
  const hostile = billing({ detail: orderDetail({ taxDocuments: [taxDocument({ blockedReason: "FISCAL_ROUTE_UNQUALIFIED" })] }) });
  assert.ok(hostile.includes("<code>FISCAL_ROUTE_UNQUALIFIED</code>"));
});

test("UI30/CMD031: a refund request first opens a BILLING support case and sends its caseId as evidenceRef under one key; a lost answer reads the refund back", async () => {
  const refundBody = { kind: "COMPLETED", version: 1, replayed: false, data: { refund: refund() } };
  let lose = true;
  const { client, sent } = harness(async (entry) => {
    if (entry.url.endsWith("/support-cases")) return respond(201, { kind: "COMPLETED", version: 1, replayed: false, data: supportCase() });
    if (entry.url.endsWith("/refund-requests")) {
      if (lose) throw new TypeError("network");
      return respond(201, { ...refundBody, replayed: true });
    }
    if (entry.url === `/api/v1/refunds/${REFUND}`) return respond(200, { kind: "READ", data: refund({ state: "APPROVED", amountsBasis: "APPROVED", serviceCents: "120000", taxCents: "8000" }) });
    return respond(404, problem(404, "NOT_FOUND"));
  });
  const runner = fastRunner();
  const forms = { caseForm: runner.openForm("CMD044"), refundForm: runner.openForm("CMD031") };
  const input = { reason: "Delivered file does not match the plan", details: "The delivered file has 40 percent fewer rows than the approved plan." };
  const detail = orderDetail();

  // the answer to the refund is lost: the state is CHECKING with the same key, never failed, never a new key
  const lost = await requestRefund(client, runner, detail.order, input, forms);
  assert.equal(lost.kind, "CHECKING");
  const cases = sent.filter((entry) => entry.url.endsWith("/support-cases"));
  const refunds = sent.filter((entry) => entry.url.endsWith("/refund-requests"));
  assert.equal(cases.length, 1, "the case is opened once");
  assert.ok(refunds.length >= 2, "the lost answer is retried");
  assert.equal(sent.indexOf(cases[0] as never) < sent.indexOf(refunds[0] as never), true, "the case comes first");
  assert.equal(cases[0]?.url, `/api/v1/projects/${PROJECT}/support-cases`);
  assert.deepEqual(bodyOf(cases[0]?.init ?? {}), { category: "BILLING", summary: input.details });
  assert.equal(refunds[0]?.url, `/api/v1/projects/${PROJECT}/refund-requests`);
  for (const request of refunds) assert.deepEqual(bodyOf(request.init), { reasonCode: input.reason, evidenceRef: CASE });
  assert.equal(new Set(refunds.map((request) => keyOf(request.init))).size, 1, "one key for the refund, whatever the retries");
  assert.match(keyOf(refunds[0]?.init ?? { headers: {} }) ?? "", /^[A-Za-z0-9_-]{16,128}$/);
  assert.notEqual(keyOf(cases[0]?.init ?? { headers: {} }), keyOf(refunds[0]?.init ?? { headers: {} }), "the two commands have their own keys");
  assert.equal(stateOfRun(lost).state, "PENDING", "the kit draws a lost answer as the Checking state (PENDING, REQUERY), never as a failure");

  // the person activates again (or reloads with the same form): same keys, the server replays, then the refund is read back from the server
  lose = false;
  const again = await requestRefund(client, runner, detail.order, input, forms);
  assert.equal(again.kind, "COMPLETED");
  if (again.kind !== "COMPLETED") return;
  assert.equal(again.replayed, true);
  assert.equal(keyOf(sent.filter((entry) => entry.url.endsWith("/refund-requests")).at(-1)?.init ?? { headers: {} }), keyOf(refunds[0]?.init ?? { headers: {} }));
  assert.equal(keyOf(sent.filter((entry) => entry.url.endsWith("/support-cases")).at(-1)?.init ?? { headers: {} }), keyOf(cases[0]?.init ?? { headers: {} }), "the case replays under its own key");
  const readBack = await readRefund(client, again.data.refund.refundId)();
  assert.equal(readBack.kind, "RESOLVED");
  if (readBack.kind === "RESOLVED") assert.equal(readBack.data.state, "APPROVED", "the state shown is the server's, not the request's");
  assert.ok(billing({ refund: readBack.kind === "RESOLVED" ? readBack.data : null }).includes("USD 1,200.00"));

  // a case that is refused ends the flow: no refund request is sent without the case
  const refused = harness(async (entry) => (entry.url.endsWith("/support-cases") ? respond(403, problem(403, "NOT_AUTHORIZED")) : respond(500, problem(500, "INTERNAL_ERROR"))));
  const denied = await requestRefund(refused.client, fastRunner(), detail.order, input, { caseForm: runner.openForm("CMD044"), refundForm: runner.openForm("CMD031") });
  assert.equal(denied.kind, "PROBLEM");
  assert.equal(refused.sent.some((entry) => entry.url.endsWith("/refund-requests")), false);

  // the request's own limits are checked before anything is sent
  assert.deepEqual(refundInputProblems(input), []);
  assert.deepEqual(refundInputProblems({ reason: " ", details: "too short" }), ["REASON", "DETAILS"]);
  assert.deepEqual(refundInputProblems({ reason: "x".repeat(201), details: "d".repeat(4001) }), ["REASON", "DETAILS"]);
});

test("UI32/CMD043: closure is separated from display edits, needs a fresh step-up, states its obligations, and an expired proof is the STEP_UP state that keeps the page", async () => {
  const html = settings();
  assert.equal(EN["screen.settings.lead.body"], "Manage agency details and safe branding.", "the registry sentence, word for word (round 2: drawn by the page header)");
  const display = html.slice(html.indexOf('id="settings-display"'), html.indexOf('id="settings-legal"'));
  const closing = html.slice(html.indexOf('data-section="closure"'));
  assert.ok(display.includes("Acme Growth Partners") && display.includes("Renaming does not reset discounts, attribution or client identity."));
  assert.ok(!display.includes("<button") && !display.includes("<input"), "the display label offers no closure control and no edit");
  assert.ok(!html.slice(0, html.indexOf('data-section="closure"')).includes("Request closure"), "closure is only in its own section");
  assert.equal(closing.match(/<button/g)?.length, 1);
  for (const text of ["It needs a fresh confirmation of your identity.", "Open quotes are withdrawn.", "Live authorizations for paid work are ended.", "stay with Kauro until they finish.", "scheduled for deletion."]) assert.ok(closing.includes(text), text);

  // only the server's permittedActions offer the control; a closing agency offers nothing
  const owner = ["MANAGE_AGENCY", "MANAGE_TEAM", "MANAGE_CLIENTS", "CREATE_CLIENTS", "OPERATE_PROJECTS", "APPROVE_PLANS", "MANAGE_BILLING", "REQUEST_DELETION", "MANAGE_BRANDING", "VIEW"] as const;
  const admin = ["MANAGE_TEAM", "MANAGE_CLIENTS", "CREATE_CLIENTS", "OPERATE_PROJECTS", "REQUEST_DELETION", "MANAGE_BRANDING", "VIEW"] as const;
  assert.deepEqual(settingsModel(agency({ permittedActions: [...owner] })), { canClose: true, closing: false, mustAskOwner: false });
  // an admin holds REQUEST_DELETION but closure (CMD043) is the owner's: it is not offered, and the page says who can
  assert.deepEqual(settingsModel(agency({ permittedActions: [...admin] })), { canClose: false, closing: false, mustAskOwner: true });
  const manager = settings({ agency: agency({ permittedActions: ["VIEW", "MANAGE_BILLING"] }) });
  assert.ok(manager.includes("Only an owner of this workspace can request its closure.") && !manager.includes("Request closure"));
  const already = settings({ agency: agency({ state: "CLOSING" }) });
  assert.ok(already.includes("It cannot be requested again.") && !already.includes("Request closure"));

  // no credential: no proof, no request
  const idle = harness(async () => respond(500, problem(500, "INTERNAL_ERROR")));
  const none = await closeWithStepUp(idle.client, fastRunner(), agency(), async () => null);
  assert.deepEqual(none, { kind: "STEP_UP", cause: "NO_CREDENTIAL" });
  assert.equal(idle.sent.length, 0);

  // a fresh proof: the identity token goes once to the step-up route; the proof reference is the closure's assuranceProofRef under the agency+version key
  const good = harness(async (entry) => (entry.url === "/api/v1/assurance/step-ups" ? respond(201, { proofId: PROOF, expiresAt: "2026-10-14T01:00:00Z" }) : respond(200, { kind: "COMPLETED", version: 5, replayed: false, data: closure() })));
  const done = await closeWithStepUp(good.client, fastRunner(), agency(), async () => credential());
  assert.equal(done.kind, "DONE");
  assert.deepEqual(good.sent.map((entry) => entry.url), ["/api/v1/assurance/step-ups", `/api/v1/agencies/${AGENCY}/closure-requests`]);
  assert.deepEqual(bodyOf(good.sent[1]?.init ?? {}), { expectedVersion: 4, assuranceProofRef: PROOF });
  assert.match(keyOf(good.sent[1]?.init ?? { headers: {} }) ?? "", /^[A-Za-z0-9_-]{16,128}$/);
  await closeWithStepUp(good.client, fastRunner(), agency(), async () => credential());
  assert.equal(good.sent.filter((entry) => entry.url === "/api/v1/assurance/step-ups").length, 2, "every closure asks for its own fresh proof");
  const keys = good.sent.filter((entry) => entry.url.endsWith("/closure-requests")).map((entry) => keyOf(entry.init));
  assert.equal(keys[0], keys[1], "the same agency version is the same intent: a reload replays");

  // the obligations the server reports are drawn after the request, money from cents
  const outcome = done.kind === "DONE" ? done.outcome : null;
  const data = outcome !== null && outcome.kind === "COMPLETED" ? outcome.data : null;
  assert.ok(data !== null);
  const result = settings({ agency: data?.agency ?? agency(), closure: data });
  for (const text of ["Closure requested", "USD 25.00", "Data deletion scheduled for", "Closing"]) assert.ok(result.includes(text), text);
  assert.equal(data?.closureId, CLOSURE);

  // an expired or refused proof is the STEP_UP state beside the page, which is not touched
  const stale = harness(async (entry) => (entry.url === "/api/v1/assurance/step-ups" ? respond(201, { proofId: PROOF, expiresAt: "2026-10-14T01:00:00Z" }) : respond(403, problem(403, "ASSURANCE_REQUIRED", { reason: "STEP_UP_STALE" }))));
  const expired = await closeWithStepUp(stale.client, fastRunner(), agency(), async () => credential());
  assert.deepEqual(expired, { kind: "STEP_UP", cause: "PROOF_STALE" });
  const kept = renderToStaticMarkup(createElement(StepUpPanel, { result: expired, onStepUp: noop }, createElement(SettingsDetails, { agency: agency({ permittedActions: ["VIEW", "MANAGE_BILLING", "REQUEST_DELETION", "MANAGE_AGENCY"] }), onClose: noop, closing: false, closure: null })));
  assert.match(kept, /data-state="STEP_UP"/);
  assert.ok(kept.includes("Confirm identity") && kept.includes("Acme Growth Partners") && kept.includes("Request closure"), "the page and its control are still there");
  assert.ok(!kept.includes("Closure requested"));

  // a version conflict is STALE, a lost answer is CHECKING with one key, never a second closure
  const conflict = harness(async (entry) => (entry.url === "/api/v1/assurance/step-ups" ? respond(201, { proofId: PROOF, expiresAt: "2026-10-14T01:00:00Z" }) : respond(409, problem(409, "STALE_VERSION", { current: { version: 6, state: "RESTRICTED" } }))));
  const staleVersion = await closeWithStepUp(conflict.client, fastRunner(), agency(), async () => credential());
  assert.equal(staleVersion.kind === "DONE" ? stateOfRun(staleVersion.outcome).state : null, "STALE");
  const lost = harness(async (entry) => {
    if (entry.url === "/api/v1/assurance/step-ups") return respond(201, { proofId: PROOF, expiresAt: "2026-10-14T01:00:00Z" });
    throw new TypeError("network");
  });
  const checking = await closeWithStepUp(lost.client, fastRunner(), agency(), async () => credential());
  assert.equal(checking.kind === "DONE" ? checking.outcome.kind : null, "CHECKING");
  const closures = lost.sent.filter((entry) => entry.url.endsWith("/closure-requests"));
  assert.ok(closures.length >= 2);
  assert.equal(new Set(closures.map((entry) => keyOf(entry.init))).size, 1);
  assert.equal(new Set(closures.map((entry) => bodyOf(entry.init)["assuranceProofRef"])).size, 1, "the proof is read once and reused by same-key retries");
});

test("UI30/UI32: both containers draw LOADING with no private value before the first answer, and an order that is not in the address reads nothing", () => {
  const { client, sent } = harness(async () => respond(500, problem(500, "INTERNAL_ERROR")));
  const shell = { client, session: {}, agency: {}, detach: noop } as never;
  const within = (child: ReturnType<typeof createElement>): string => renderToStaticMarkup(createElement(ShellContext.Provider, { value: shell }, child));
  const loadingBilling = within(createElement(BillingScreen, { agencyId: AGENCY, orderId: ORDER }));
  const loadingSettings = within(createElement(SettingsScreen, { agencyId: AGENCY }));
  for (const text of [loadingBilling, loadingSettings]) {
    assert.match(text, /data-state="LOADING"/);
    assert.ok(!text.includes("Acme Growth Partners") && !text.includes(order().orderId.slice(0, 8)));
  }
  const none = within(createElement(BillingScreen, { agencyId: AGENCY, orderId: null }));
  assert.ok(none.includes("Billing shows one order at a time") && none.includes("Go to projects"), "no order: the way to one, not a dead end");
  assert.equal(sent.length, 0, "rendering sends nothing; the reads start in effects");
});

test("UI30/UI32 copy: the registry sentences are present word for word and the screens never call the free step an audit", () => {
  assert.equal(EN["screen.billing.lead.body"], "Track quotes, payments, fiscal documents and refunds.");
  assert.equal(EN["screen.settings.lead.body"], "Manage agency details and safe branding.");
  for (const [id, text] of Object.entries(EN).filter(([id]) => id.startsWith("screen.billing.") || id.startsWith("screen.settings."))) assert.doesNotMatch(text, /\baudit|paypal|founding/i, id);
});
