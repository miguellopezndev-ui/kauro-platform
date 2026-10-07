/**
 * One contract table, two bindings (B15 rule 2): every row runs against the CONTRACT_FAKE of @kauro/application (SIMULATED) and the
 * PROVIDER adapter of this package against the recorded wire (EXECUTED_LOCAL: official PayPal examples, no network). A row that the two
 * bindings answer differently names its finding (F-PP-n, docs/design/B15-adapters.md) and asserts each binding's answer, so the
 * divergence is visible and cannot drift silently.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PaymentProviderAdapter, ProviderDispatchResult, WebhookVerifier } from "@kauro/application";
import { createPayPalContractFake, createWebhookVerifierFake, normalizePayPalWebhook } from "@kauro/application/testing";
import type { PaymentEnvironment } from "@kauro/domain";
import { classifyPayPalWebhook, createPayPalOrdersAdapter, createPayPalWebhookVerifier, PAYPAL_TRANSMISSION_HEADERS } from "../src/index.js";
import { DOC_CREDENTIALS, RecordedWire, fixedClock, fixtureBytes } from "./support/recorded-wire.js";

const MERCHANT = "YXZY75W2GKDQE"; // the payee of PayPal's capture example
const ORIGIN = "https://app.kauro.test";
const ENV: PaymentEnvironment = "LIVE"; // the official examples name the live hosts
const ATTEMPT = "kauro-01920000-0000-7000-8000-000000000001";
const ATTEMPT_2 = "kauro-01920000-0000-7000-8000-000000000002";
const DOC_ORDER = "5O190127TN364715T";
const DOC_CAPTURE_FOR_REFUND = "2GG279541U471931P";
const ERROR_422 = (issue: string): { status: number; json: unknown } => ({ status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue, description: "constructed from the documented error schema" }], message: "The requested action could not be performed, semantically incorrect, or failed business validation.", debug_id: "constructed" } });
const NOT_FOUND_404 = { status: 404, json: { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID", description: "Specified resource ID does not exist." }], message: "The specified resource does not exist.", debug_id: "constructed" } };

type Clock = ReturnType<typeof fixedClock>;

interface Binding {
  readonly name: "CONTRACT_FAKE" | "PROVIDER";
  readonly adapter: PaymentProviderAdapter & { readonly payeeDigest: string };
  readonly clock: Clock;
  /** Provider-side state: an order the buyer approved; returns its provider id. */
  approvedOrder(): Promise<string>;
  /** Provider-side state: a completed capture of a fresh order; returns the capture id. */
  completedCapture(): Promise<string>;
  /** The number of requests that reached the provider (sent dispatches and observations, not token calls). */
  sent(): number;
}

const intentOf = (providerRequestId = ATTEMPT) => ({ orderId: "01920000-0000-7000-8000-0000000000a1", attemptId: "01920000-0000-7000-8000-000000000001", providerRequestId, amountCents: 10_000n, currency: "USD" as const, description: "KAURO_PROJECT_PREPARATION" as const, returnPath: "/checkout/return", cancelPath: "/checkout/cancel" });
const captureIntent = (providerOrderId: string, providerRequestId = ATTEMPT_2) => ({ orderId: "01920000-0000-7000-8000-0000000000a1", attemptId: "01920000-0000-7000-8000-000000000002", providerRequestId, providerOrderId, amountCents: 10_000n, currency: "USD" as const });
const refundIntent = (providerCaptureId: string) => ({ refundId: "INVOICE-123", attemptId: "01920000-0000-7000-8000-000000000003", providerRequestId: "kauro-01920000-0000-7000-8000-000000000003", providerCaptureId, amountCents: 1_099n, currency: "USD" as const });
const later = (clock: Clock, ms = 30_000): string => new Date(clock.nowMs() + ms).toISOString();

/** Each row arranges both bindings itself, so the arrangement is explicit per binding and the act/expect part is shared. */
interface Row {
  readonly title: string;
  readonly wire: (wire: RecordedWire) => void;
  readonly fake?: (fake: ReturnType<typeof createPayPalContractFake>) => void;
  readonly run: (b: Binding) => Promise<void>;
}

function fakeBinding(arrange?: Row["fake"]): Binding {
  const clock = fixedClock();
  const fake = createPayPalContractFake({ clock, environment: ENV, merchantId: MERCHANT, returnOrigin: ORIGIN });
  arrange?.(fake);
  return {
    name: "CONTRACT_FAKE",
    adapter: fake,
    clock,
    async approvedOrder() {
      const created = await fake.dispatch(fake.prepareCreateOrder(intentOf("kauro-setup-order")), later(clock));
      assert.equal(created.kind, "ORDER_CREATED");
      const id = (created as Extract<ProviderDispatchResult, { kind: "ORDER_CREATED" }>).providerOrderId;
      fake.approve(id);
      return id;
    },
    async completedCapture() {
      const order = await this.approvedOrder();
      fake.program("ORDERS_V2_CAPTURE", { kind: "CAPTURE_OBSERVED", capture: { feeCents: 300n } });
      const captured = await fake.dispatch(fake.prepareCapture(captureIntent(order, "kauro-setup-capture")), later(clock));
      return (captured as Extract<ProviderDispatchResult, { kind: "CAPTURE_OBSERVED" }>).capture.providerCaptureId;
    },
    sent: () => fake.calls.filter((c) => c.sent).length,
  };
}

function wireBinding(arrange: Row["wire"]): Binding & { readonly wire: RecordedWire } {
  const clock = fixedClock();
  const wire = new RecordedWire();
  arrange(wire);
  const adapter = createPayPalOrdersAdapter({ environment: ENV, merchantId: MERCHANT, returnOrigin: ORIGIN, transport: wire.transport, credentials: DOC_CREDENTIALS, clock });
  return {
    name: "PROVIDER",
    adapter,
    clock,
    wire,
    approvedOrder: async () => DOC_ORDER,
    completedCapture: async () => DOC_CAPTURE_FOR_REFUND,
    sent: () => wire.apiRequests.length,
  };
}

const CAPTURED = [{ fixture: "orders.post.201.00_orders_capture.json" }] as const;
const CAPTURE_GET = { fixture: "derived.payments.get.200.capture-3C679366HH908993F.json" } as const;

const ROWS: ReadonlyArray<Row> = [
  {
    title: "OK create order: ORDER_CREATED with an approval page on an allowlisted host",
    wire: (w) => w.on("POST", /^\/v2\/checkout\/orders$/, { fixture: "orders.post.201.orders_create_simple.json" }),
    async run(b) {
      const r = await b.adapter.dispatch(b.adapter.prepareCreateOrder(intentOf()), later(b.clock));
      assert.equal(r.kind, "ORDER_CREATED");
      const created = r as Extract<ProviderDispatchResult, { kind: "ORDER_CREATED" }>;
      assert.ok(b.adapter.approvalHosts.includes(new URL(created.approvalUrl).host));
      assert.match(created.providerOrderId, /^[A-Za-z0-9-]+$/);
    },
  },
  {
    title: "RETRY create order: the same PayPal-Request-Id answers the first order and makes no second one",
    wire: (w) => w.on("POST", /^\/v2\/checkout\/orders$/, { fixture: "orders.post.201.orders_create_simple.json" }, { fixture: "orders.post.200.00_orders_create.json" }),
    async run(b) {
      const request = b.adapter.prepareCreateOrder(intentOf());
      const first = await b.adapter.dispatch(request, later(b.clock));
      const second = await b.adapter.dispatch(request, later(b.clock));
      assert.equal(first.kind, "ORDER_CREATED");
      assert.equal(second.kind, "ORDER_CREATED");
      assert.equal((second as { providerOrderId: string }).providerOrderId, (first as { providerOrderId: string }).providerOrderId);
    },
  },
  {
    title: "OK capture: CAPTURE_OBSERVED COMPLETED with the provider's fee, the route's payee, the order and a completion instant",
    wire: (w) => w.on("POST", /\/capture$/, ...CAPTURED).on("GET", /^\/v2\/payments\/captures\//, CAPTURE_GET),
    async run(b) {
      const order = await b.approvedOrder();
      if (b.name === "CONTRACT_FAKE") (b.adapter as ReturnType<typeof createPayPalContractFake>).program("ORDERS_V2_CAPTURE", { kind: "CAPTURE_OBSERVED", capture: { feeCents: 300n } });
      const r = await b.adapter.dispatch(b.adapter.prepareCapture(captureIntent(order)), later(b.clock));
      assert.equal(r.kind, "CAPTURE_OBSERVED");
      const c = (r as Extract<ProviderDispatchResult, { kind: "CAPTURE_OBSERVED" }>).capture;
      assert.deepEqual([c.status, c.amountCents, c.currency, c.feeCents, c.payeeDigest, c.providerOrderId, c.fundsState], ["COMPLETED", 10_000n, "USD", 300n, b.adapter.payeeDigest, order, "UNKNOWN"]);
      assert.notEqual(c.providerCompletedAt, null);
    },
  },
  {
    title: "DENY capture of an order the buyer has not approved: PROVED_NO_EFFECT ORDER_NOT_APPROVED",
    wire: (w) => w.on("POST", /\/capture$/, ERROR_422("ORDER_NOT_APPROVED")),
    async run(b) {
      let order = DOC_ORDER;
      if (b.name === "CONTRACT_FAKE") order = ((await b.adapter.dispatch(b.adapter.prepareCreateOrder(intentOf("kauro-unapproved")), later(b.clock))) as { providerOrderId: string }).providerOrderId;
      const r = await b.adapter.dispatch(b.adapter.prepareCapture(captureIntent(order)), later(b.clock));
      assert.deepEqual([r.kind, (r as { outcomeCode?: string }).outcomeCode], ["PROVED_NO_EFFECT", "ORDER_NOT_APPROVED"]);
    },
  },
  {
    title: "DENY capture of an unknown order: PROVED_NO_EFFECT, nothing captured",
    wire: (w) => w.on("POST", /\/capture$/, NOT_FOUND_404),
    async run(b) {
      const r = await b.adapter.dispatch(b.adapter.prepareCapture(captureIntent("UNKNOWN0RDER0000")), later(b.clock));
      assert.equal(r.kind, "PROVED_NO_EFFECT");
    },
  },
  {
    title: "OK refund: REFUND_OBSERVED of the capture, naming the platform refund id as its invoice",
    wire: (w) => w.on("POST", /\/refund$/, { fixture: "payments.post.201.captures_refund_with_prefer_header.json" }),
    async run(b) {
      const capture = await b.completedCapture();
      const r = await b.adapter.dispatch(b.adapter.prepareRefund(refundIntent(capture)), later(b.clock));
      assert.equal(r.kind, "REFUND_OBSERVED");
      const f = (r as Extract<ProviderDispatchResult, { kind: "REFUND_OBSERVED" }>).refund;
      assert.deepEqual([f.providerCaptureId, f.status, f.amountCents, f.currency, f.platformRefundRef], [capture, "COMPLETED", 1_099n, "USD", "INVOICE-123"]);
    },
  },
  {
    title: "RACE (timeout): a capture whose answer never arrives is AMBIGUOUS TIMEOUT; the order read by id then shows the capture",
    wire: (w) => w.on("POST", /\/capture$/, { hang: true }).on("GET", /^\/v2\/checkout\/orders\//, { fixture: "derived.orders.get.200.completed.json" }),
    async run(b) {
      const order = await b.approvedOrder();
      if (b.name === "CONTRACT_FAKE") (b.adapter as ReturnType<typeof createPayPalContractFake>).program("ORDERS_V2_CAPTURE", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "APPLIED" });
      const r = await b.adapter.dispatch(b.adapter.prepareCapture(captureIntent(order)), later(b.clock, 50));
      assert.deepEqual(r, { kind: "AMBIGUOUS", reason: "TIMEOUT" });
      const seen = await b.adapter.observeOrder({ providerOrderId: order });
      assert.deepEqual([seen.orderStatus, seen.captures.length, seen.captures[0]?.status, seen.absenceIsProof], ["COMPLETED", 1, "COMPLETED", true]);
    },
  },
  {
    title: "TIMEOUT a dispatch past its deadline sends nothing and is AMBIGUOUS TIMEOUT",
    wire: () => undefined,
    async run(b) {
      const before = b.sent();
      const r = await b.adapter.dispatch(b.adapter.prepareCapture(captureIntent(DOC_ORDER)), new Date(b.clock.nowMs() - 1).toISOString());
      assert.deepEqual(r, { kind: "AMBIGUOUS", reason: "TIMEOUT" });
      assert.equal(b.sent(), before);
    },
  },
  {
    title: "RACE (timeout): a provider 5xx is AMBIGUOUS PROVIDER_5XX, never no effect",
    wire: (w) => w.on("POST", /\/capture$/, { status: 503, json: { name: "SERVICE_UNAVAILABLE", debug_id: "constructed" } }),
    async run(b) {
      const order = await b.approvedOrder();
      if (b.name === "CONTRACT_FAKE") (b.adapter as ReturnType<typeof createPayPalContractFake>).program("ORDERS_V2_CAPTURE", { kind: "AMBIGUOUS", reason: "PROVIDER_5XX", effect: "NOT_APPLIED" });
      assert.deepEqual(await b.adapter.dispatch(b.adapter.prepareCapture(captureIntent(order)), later(b.clock)), { kind: "AMBIGUOUS", reason: "PROVIDER_5XX" });
    },
  },
  {
    title: "OK observe an unknown order id: NOT_FOUND and absence is proof",
    wire: (w) => w.on("GET", /^\/v2\/checkout\/orders\//, NOT_FOUND_404),
    async run(b) {
      const seen = await b.adapter.observeOrder({ providerOrderId: "UNKNOWN0RDER0000" });
      assert.deepEqual([seen.orderStatus, seen.providerOrderId, seen.absenceIsProof, seen.captures.length], ["NOT_FOUND", null, true, 0]);
    },
  },
  {
    title: "OK observe an order with a refund: the refund is listed against its capture with the platform refund id",
    wire: (w) => w.on("GET", /^\/v2\/checkout\/orders\//, { fixture: "derived.orders.get.200.completed-refunded.json" }),
    async run(b) {
      let order = DOC_ORDER;
      let capture = "3C679366HH908993F";
      if (b.name === "CONTRACT_FAKE") {
        const fake = b.adapter as ReturnType<typeof createPayPalContractFake>;
        order = await b.approvedOrder();
        capture = fake.captureAtProvider(order);
        fake.refundAtProvider(capture, 1_099n, "COMPLETED", { invoiceId: "INVOICE-123" });
      }
      const seen = await b.adapter.observeOrder({ providerOrderId: order });
      assert.equal(seen.refunds.length, 1);
      assert.deepEqual([seen.refunds[0]!.providerCaptureId, seen.refunds[0]!.platformRefundRef, seen.refunds[0]!.amountCents, seen.refunds[0]!.status], [capture, "INVOICE-123", 1_099n, "COMPLETED"]);
    },
  },
  {
    title: "OK observe a refund by its provider id",
    wire: (w) => w.on("GET", /^\/v2\/payments\/refunds\//, { fixture: "payments.get.200.refunds_get_platform_fees.json" }),
    async run(b) {
      let refundId = "1JU08902781691411";
      let capture = DOC_CAPTURE_FOR_REFUND;
      if (b.name === "CONTRACT_FAKE") {
        const fake = b.adapter as ReturnType<typeof createPayPalContractFake>;
        capture = await b.completedCapture();
        refundId = fake.refundAtProvider(capture, 1_099n, "COMPLETED", { invoiceId: "INVOICE-123" });
      }
      const seen = await b.adapter.observeRefund({ providerRefundId: refundId });
      assert.ok(!("kind" in seen));
      assert.deepEqual([seen.providerRefundId, seen.providerCaptureId, seen.status, seen.amountCents, seen.platformRefundRef], [refundId, capture, "COMPLETED", 1_099n, "INVOICE-123"]);
    },
  },
  {
    title: "F-PP-1 observe a creation by its request identity: the fake proves absence, PayPal documents no such lookup",
    wire: () => undefined,
    async run(b) {
      const seen = await b.adapter.observeOrder({ providerRequestId: "kauro-never-sent" });
      assert.equal(seen.orderStatus, "NOT_FOUND");
      assert.equal(seen.absenceIsProof, b.name === "CONTRACT_FAKE", "F-PP-1: only the fake claims a provable absence by request id");
      const refund = await b.adapter.observeRefund({ providerCaptureId: DOC_CAPTURE_FOR_REFUND, providerRequestId: "kauro-never-sent" });
      assert.deepEqual([("kind" in refund) && refund.kind, ("kind" in refund) && refund.absenceIsProof], ["NOT_FOUND", b.name === "CONTRACT_FAKE"]);
    },
  },
];

describe("PaymentProviderAdapter contract — CONTRACT_FAKE and PROVIDER (recorded wire)", () => {
  for (const row of ROWS) {
    it(`${row.title} [CONTRACT_FAKE]`, async () => row.run(fakeBinding(row.fake)));
    it(`${row.title} [PROVIDER]`, async () => row.run(wireBinding(row.wire)));
  }
});

// --- webhook verification ------------------------------------------------------------------------------------------------------

interface VerifierBinding {
  readonly name: "CONTRACT_FAKE" | "PROVIDER";
  readonly verifier: WebhookVerifier;
  readonly clock: Clock;
  /** The headers the provider sends with `bytes` at `transmissionTime`, signed for `environment` (a bad signature when `forge`). */
  deliver(bytes: Uint8Array, options?: { readonly environment?: PaymentEnvironment; readonly transmissionTime?: string; readonly forge?: boolean }): Readonly<Record<string, string>>;
}

function fakeVerifier(): VerifierBinding {
  const clock = fixedClock();
  const verifier = createWebhookVerifierFake({ clock, environment: ENV });
  return {
    name: "CONTRACT_FAKE",
    verifier,
    clock,
    deliver(bytes, o = {}) {
      const headers = verifier.sign(bytes, { ...(o.environment !== undefined ? { environment: o.environment } : {}), ...(o.transmissionTime !== undefined ? { transmissionTime: o.transmissionTime } : {}) });
      return o.forge === true ? { ...headers, [PAYPAL_TRANSMISSION_HEADERS.signature]: Buffer.alloc(32, 7).toString("base64") } : headers;
    },
  };
}

function wireVerifier(): VerifierBinding & { readonly wire: RecordedWire } {
  const clock = fixedClock();
  const wire = new RecordedWire();
  let forged = false;
  // PayPal's verdict: FAILURE for a forged signature, SUCCESS otherwise (the postback is the authority; tests do not re-implement RSA)
  wire.on("POST", /^\/v1\/notifications\/verify-webhook-signature$/, { status: 200, json: { verification_status: "SUCCESS" } });
  const transport = wire.transport;
  const verifier = createPayPalWebhookVerifier({ environment: ENV, webhookId: "8PT597110X687430LKGECATA", transport: async (r) => (forged && r.url.endsWith("/verify-webhook-signature") ? { status: 200, headers: {}, body: new TextEncoder().encode('{"verification_status":"FAILURE"}') } : transport(r)), credentials: DOC_CREDENTIALS, clock });
  return {
    name: "PROVIDER",
    verifier,
    clock,
    wire,
    deliver(_bytes, o = {}) {
      forged = o.forge === true;
      const host = (o.environment ?? ENV) === "LIVE" ? "api.paypal.com" : "api.sandbox.paypal.com";
      return {
        [PAYPAL_TRANSMISSION_HEADERS.transmissionId]: "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
        [PAYPAL_TRANSMISSION_HEADERS.transmissionTime]: o.transmissionTime ?? clock.now(),
        [PAYPAL_TRANSMISSION_HEADERS.signature]: "lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz",
        [PAYPAL_TRANSMISSION_HEADERS.certUrl]: `https://${host}/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77`,
        [PAYPAL_TRANSMISSION_HEADERS.algorithm]: "SHA256withRSA",
      };
    },
  };
}

const CAPTURE_EVENT = fixtureBytes("derived.webhook.payment-capture-completed.json");
const REFUND_EVENT = fixtureBytes("derived.webhook.payment-capture-refunded.json");
const at = (clock: Clock, offsetSeconds: number): string => new Date(clock.nowMs() + offsetSeconds * 1000).toISOString();

interface VerifierRow {
  readonly title: string;
  readonly run: (b: VerifierBinding) => Promise<void>;
}

const VERIFIER_ROWS: ReadonlyArray<VerifierRow> = [
  {
    title: "OK a signed capture event is VERIFIED as CAPTURE_COMPLETED with the classifier's exact normalized capture",
    async run(b) {
      const r = await b.verifier.verify({ bytes: CAPTURE_EVENT, headers: b.deliver(CAPTURE_EVENT), receivedAt: b.clock.now() });
      assert.equal(r.kind, "VERIFIED");
      const event = (r as { event: unknown }).event;
      assert.deepEqual(event, normalizePayPalWebhook(CAPTURE_EVENT, ENV));
      assert.deepEqual(event, classifyPayPalWebhook(CAPTURE_EVENT, ENV));
    },
  },
  {
    title: "OK a signed refund event is VERIFIED as REFUND_COMPLETED naming the platform refund id",
    async run(b) {
      const r = await b.verifier.verify({ bytes: REFUND_EVENT, headers: b.deliver(REFUND_EVENT), receivedAt: b.clock.now() });
      assert.equal(r.kind, "VERIFIED");
      const event = (r as { event: { kind: string; refund?: { platformRefundRef: string | null; providerCaptureId: string } } }).event;
      assert.deepEqual([event.kind, event.refund?.platformRefundRef, event.refund?.providerCaptureId], ["REFUND_COMPLETED", "INVOICE-123", "3C679366HH908993F"]);
      assert.deepEqual(event, normalizePayPalWebhook(REFUND_EVENT, ENV));
    },
  },
  {
    title: "DENY a forged signature is PROVIDER_SIGNATURE_INVALID",
    async run(b) {
      assert.deepEqual(await b.verifier.verify({ bytes: CAPTURE_EVENT, headers: b.deliver(CAPTURE_EVENT, { forge: true }), receivedAt: b.clock.now() }), { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" });
    },
  },
  {
    title: "DENY an event signed for the other environment is PROVIDER_ENVIRONMENT_MISMATCH",
    async run(b) {
      assert.deepEqual(await b.verifier.verify({ bytes: CAPTURE_EVENT, headers: b.deliver(CAPTURE_EVENT, { environment: "SANDBOX" }), receivedAt: b.clock.now() }), { kind: "REJECTED", reason: "PROVIDER_ENVIRONMENT_MISMATCH" });
    },
  },
  {
    title: "DENY a body beyond the bound is refused before verification",
    async run(b) {
      const big = new Uint8Array(b.verifier.maxBodyBytes + 1).fill(0x20);
      assert.deepEqual(await b.verifier.verify({ bytes: big, headers: b.deliver(CAPTURE_EVENT), receivedAt: b.clock.now() }), { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" });
    },
  },
  {
    title: "EXPIRY a transmission older than the window plus the D-15 tolerance is stale; one inside the window is verified",
    async run(b) {
      const old = await b.verifier.verify({ bytes: CAPTURE_EVENT, headers: b.deliver(CAPTURE_EVENT, { transmissionTime: at(b.clock, -(300 + 10 + 1)) }), receivedAt: b.clock.now() });
      assert.deepEqual(old, { kind: "REJECTED", reason: "PROVIDER_EVENT_STALE" });
      const fresh = await b.verifier.verify({ bytes: CAPTURE_EVENT, headers: b.deliver(CAPTURE_EVENT, { transmissionTime: at(b.clock, -299) }), receivedAt: b.clock.now() });
      assert.equal(fresh.kind, "VERIFIED");
    },
  },
  {
    title: "F-PP-2 a transmission 11 s in the future: the fake accepts it, the D-15 tolerance (10 s) refuses it",
    async run(b) {
      const r = await b.verifier.verify({ bytes: CAPTURE_EVENT, headers: b.deliver(CAPTURE_EVENT, { transmissionTime: at(b.clock, 11) }), receivedAt: b.clock.now() });
      assert.equal(r.kind, b.name === "CONTRACT_FAKE" ? "VERIFIED" : "REJECTED", "F-PP-2: the fake applies the freshness window symmetrically and no skew tolerance");
    },
  },
];

describe("WebhookVerifier contract — CONTRACT_FAKE and PROVIDER (recorded wire)", () => {
  for (const row of VERIFIER_ROWS) {
    it(`${row.title} [CONTRACT_FAKE]`, async () => row.run(fakeVerifier()));
    it(`${row.title} [PROVIDER]`, async () => row.run(wireVerifier()));
  }
});
