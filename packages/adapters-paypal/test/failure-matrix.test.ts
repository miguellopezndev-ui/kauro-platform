/**
 * The PayPal rows of the B15 failure matrix (docs/design/B15-adapters.md §PayPal), against the recorded wire: what each transport,
 * provider and clock failure proves, the idempotency key on every effect, the clock-skew policy at N-1/N/N+1, and that no error is
 * swallowed. Titles are cited by the matrix as `test/failure-matrix.test.ts :: "title"`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderDispatchResult } from "@kauro/application";
import { PAYPAL_CLOCK_SKEW_POLICY, PayPalAdapterError, createPayPalOrdersAdapter, createPayPalWebhookVerifier, isFreshTransmission, PAYPAL_TRANSMISSION_HEADERS } from "../src/index.js";
import { createHash } from "node:crypto";
import { DOC_CREDENTIALS, RecordedWire, fixedClock, fixture, fixtureBytes, type Answer } from "./support/recorded-wire.js";

const MERCHANT = "YXZY75W2GKDQE";
const ORDER = "5O190127TN364715T";

function setup(arrange: (w: RecordedWire) => void = () => undefined) {
  const clock = fixedClock();
  const wire = new RecordedWire();
  arrange(wire);
  const adapter = createPayPalOrdersAdapter({ environment: "LIVE", merchantId: MERCHANT, returnOrigin: "https://app.kauro.test", transport: wire.transport, credentials: DOC_CREDENTIALS, clock });
  const deadline = new Date(clock.nowMs() + 30_000).toISOString();
  const capture = (requestId = "kauro-01920000-0000-7000-8000-000000000002") => adapter.prepareCapture({ orderId: "o", attemptId: "a", providerRequestId: requestId, providerOrderId: ORDER, amountCents: 10_000n, currency: "USD" });
  const refund = () => adapter.prepareRefund({ refundId: "INVOICE-123", attemptId: "a", providerRequestId: "kauro-01920000-0000-7000-8000-000000000003", providerCaptureId: "2GG279541U471931P", amountCents: 1_099n, currency: "USD" });
  return { clock, wire, adapter, deadline, capture, refund };
}

const captureWith = (mutate: (c: Record<string, unknown>, order: Record<string, unknown>) => void): Answer => {
  const order = structuredClone(fixture("orders.post.201.00_orders_capture.json").http.body) as Record<string, unknown>;
  const c = ((order["purchase_units"] as Array<Record<string, unknown>>)[0]!["payments"] as Record<string, Array<Record<string, unknown>>>)["captures"]![0]!;
  c["payee"] = { merchant_id: MERCHANT };
  mutate(c, order);
  return { status: 201, json: order };
};

describe("PayPal failure matrix — idempotency (rule 4)", () => {
  it("RETRY every effect carries the attempt's PayPal-Request-Id, identical on a replay, never random", async () => {
    const { wire, adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, captureWith(() => undefined)));
    const request = capture();
    await adapter.dispatch(request, deadline);
    await adapter.dispatch(request, deadline);
    await adapter.dispatch(capture(), deadline);
    const ids = wire.apiRequests.map((r) => r.headers["PayPal-Request-Id"]);
    assert.deepEqual(ids, ["kauro-01920000-0000-7000-8000-000000000002", "kauro-01920000-0000-7000-8000-000000000002", "kauro-01920000-0000-7000-8000-000000000002"]);
    assert.deepEqual(adapter.prepareCapture({ orderId: "o", attemptId: "a", providerRequestId: "kauro-x", providerOrderId: ORDER, amountCents: 1n, currency: "USD" }), adapter.prepareCapture({ orderId: "o", attemptId: "a", providerRequestId: "kauro-x", providerOrderId: ORDER, amountCents: 1n, currency: "USD" }));
  });

  it("RETRY a refund replay answered 200 by PayPal is the same REFUND_OBSERVED under the same request id", async () => {
    const { wire, adapter, deadline, refund } = setup((w) => w.on("POST", /\/refund$/, { fixture: "payments.post.201.captures_refund_with_prefer_header.json" }, { fixture: "payments.post.201.captures_refund_with_prefer_header.json", status: 200 }));
    const request = refund();
    const a = await adapter.dispatch(request, deadline);
    const b = await adapter.dispatch(request, deadline);
    assert.deepEqual(a, b);
    assert.equal(wire.apiRequests[0]!.headers["PayPal-Request-Id"], wire.apiRequests[1]!.headers["PayPal-Request-Id"]);
  });

  it("RETRY (revocation): an expired or revoked token is renewed once and the identical request is repeated under the same request id", async () => {
    const { wire, adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, { status: 401, json: { error: "invalid_token" } }, captureWith(() => undefined)));
    const r = await adapter.dispatch(capture(), deadline);
    assert.equal(r.kind, "CAPTURE_OBSERVED");
    assert.equal(wire.requests.filter((q) => q.url.endsWith("/v1/oauth2/token")).length, 2);
    assert.equal(wire.apiRequests.length, 2);
    assert.equal(wire.apiRequests[0]!.body, wire.apiRequests[1]!.body);
    assert.equal(wire.apiRequests[0]!.headers["PayPal-Request-Id"], wire.apiRequests[1]!.headers["PayPal-Request-Id"]);
  });

  it("DENY (revocation): a token refused again after renewal is a thrown CREDENTIAL_REJECTED, never a result", async () => {
    const { adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, { status: 401, json: { error: "invalid_token" } }));
    await assert.rejects(adapter.dispatch(capture(), deadline), (e: unknown) => e instanceof PayPalAdapterError && e.code === "CREDENTIAL_REJECTED");
  });

  it("DENY a token endpoint that issues nothing is a thrown TOKEN_UNAVAILABLE and the target is never called", async () => {
    const { wire, adapter, deadline, capture } = setup((w) => w.token({ status: 503, json: {} }).on("POST", /\/capture$/, captureWith(() => undefined)));
    await assert.rejects(adapter.dispatch(capture(), deadline), (e: unknown) => e instanceof PayPalAdapterError && e.code === "TOKEN_UNAVAILABLE");
    assert.equal(wire.apiRequests.length, 0);
  });
});

describe("PayPal failure matrix — what a dispatch proves", () => {
  for (const [title, answer, expected] of [
    ["RACE (timeout): a connection reset is AMBIGUOUS CONNECTION_RESET", { fail: "CONNECTION_RESET" }, { kind: "AMBIGUOUS", reason: "CONNECTION_RESET" }],
    ["RACE (timeout): an unreadable 2xx body is AMBIGUOUS UNREADABLE_RESPONSE", { status: 201, raw: "{not json" }, { kind: "AMBIGUOUS", reason: "UNREADABLE_RESPONSE" }],
    ["RACE (timeout): a body the transport could not finish reading is AMBIGUOUS UNREADABLE_RESPONSE", { fail: "UNREADABLE_RESPONSE" }, { kind: "AMBIGUOUS", reason: "UNREADABLE_RESPONSE" }],
  ] as const) {
    it(title, async () => {
      const { adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, answer as Answer));
      assert.deepEqual(await adapter.dispatch(capture(), deadline), expected);
    });
  }

  for (const [status, code] of [[403, "PERMISSION_DENIED"], [409, "REQUEST_IN_PROGRESS"], [429, "RATE_LIMITED"]] as const) {
    it(`DENY HTTP ${status} on a dispatch is a thrown ${code}: no proof either way`, async () => {
      const { adapter, refund, deadline } = setup((w) => w.on("POST", /\/refund$/, status === 409 ? { fixture: "payments.post.409.captures_refund_409_conflict.json" } : { status, json: { name: "X" } }));
      await assert.rejects(adapter.dispatch(refund(), deadline), (e: unknown) => e instanceof PayPalAdapterError && e.code === code && e.httpStatus === status);
    });
  }

  for (const [title, path, name, issue] of [
    ["DENY official 422 ACTION_DOES_NOT_MATCH_INTENT is PROVED_NO_EFFECT with that outcome", /\/capture$/, "orders.post.422.capture_422_unprocessable_entity.json", "ACTION_DOES_NOT_MATCH_INTENT"],
    ["DENY official 422 PAYER_ACTION_REQUIRED is PROVED_NO_EFFECT with that outcome", /\/capture$/, "orders.post.422.capture_422_payer_action_required_cib_psd2_sca_ba_in_sc.json", "PAYER_ACTION_REQUIRED"],
    ["DENY official 422 REFUND_AMOUNT_EXCEEDED is PROVED_NO_EFFECT with that outcome", /\/refund$/, "payments.post.422.captures_refund_422_amount_exceeded.json", "REFUND_AMOUNT_EXCEEDED"],
    ["DENY official 422 TRANSACTION_DISPUTED refund is PROVED_NO_EFFECT", /\/refund$/, "payments.post.422.captures_refund_422_transaction_disputed.json", null],
    ["DENY official 400 INVALID_ARRAY_MIN_ITEMS create is PROVED_NO_EFFECT with that outcome", /^\/v2\/checkout\/orders$/, "orders.post.400.create_400_bad_request.json", "INVALID_ARRAY_MIN_ITEMS"],
  ] as const) {
    it(title, async () => {
      const { adapter, deadline, capture, refund } = setup((w) => w.on("POST", path, { fixture: name }));
      const request = String(path).includes("refund") ? refund() : String(path).includes("capture") ? capture() : adapter.prepareCreateOrder({ orderId: "o", attemptId: "a", providerRequestId: "kauro-c", amountCents: 1n, currency: "USD", description: "KAURO_PROJECT_PREPARATION", returnPath: "/r", cancelPath: "/c" });
      const r = await adapter.dispatch(request, deadline);
      assert.equal(r.kind, "PROVED_NO_EFFECT");
      const body = fixture(name).http.body as { details: Array<{ issue: string }> };
      assert.equal((r as { outcomeCode: string }).outcomeCode, issue ?? body.details[0]!.issue);
      assert.equal((r as { evidenceHash: string }).evidenceHash, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
    });
  }

  it("OK the idempotent 200 creation answer with a payer-action link is ORDER_CREATED on the allowlisted host", async () => {
    const { adapter, deadline } = setup((w) => w.on("POST", /^\/v2\/checkout\/orders$/, { fixture: "orders.post.200.00_orders_create.json" }));
    const r = await adapter.dispatch(adapter.prepareCreateOrder({ orderId: "o", attemptId: "a", providerRequestId: "kauro-c", amountCents: 1n, currency: "USD", description: "KAURO_PROJECT_PREPARATION", returnPath: "/r", cancelPath: "/c" }), deadline);
    assert.deepEqual(r.kind === "ORDER_CREATED" && [r.providerOrderId, r.approvalUrl], [ORDER, `https://www.paypal.com/checkoutnow?token=${ORDER}`]);
  });

  for (const [title, mutate] of [
    ["DENY a creation whose approval page is on a foreign host is UNRECOGNIZED", (o: Record<string, unknown>) => void (o["links"] = [{ rel: "approve", href: "https://evil.example/checkoutnow?token=X", method: "GET" }])],
    ["DENY a creation in a state the port does not name (PAYER_ACTION_REQUIRED) is UNRECOGNIZED", (o: Record<string, unknown>) => void (o["status"] = "PAYER_ACTION_REQUIRED")],
  ] as const) {
    it(title, async () => {
      const order = structuredClone(fixture("orders.post.201.orders_create_simple.json").http.body) as Record<string, unknown>;
      mutate(order);
      const { adapter, deadline } = setup((w) => w.on("POST", /^\/v2\/checkout\/orders$/, { status: 201, json: order }));
      const r = await adapter.dispatch(adapter.prepareCreateOrder({ orderId: "o", attemptId: "a", providerRequestId: "kauro-c", amountCents: 1n, currency: "USD", description: "KAURO_PROJECT_PREPARATION", returnPath: "/r", cancelPath: "/c" }), deadline);
      assert.equal(r.kind, "UNRECOGNIZED");
    });
  }

  it("PARTIAL a captured order whose capture names no payee and whose capture read fails is AMBIGUOUS OBSERVATION_LOST, never a capture", async () => {
    const { adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, { fixture: "orders.post.201.00_orders_capture.json" }).on("GET", /^\/v2\/payments\/captures\//, { fail: "CONNECTION_RESET" }));
    assert.deepEqual(await adapter.dispatch(capture(), deadline), { kind: "AMBIGUOUS", reason: "OBSERVATION_LOST" });
  });

  it("OK a capture answer whose capture names no payee is completed from the capture resource, and the evidence covers both answers", async () => {
    const { adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, { fixture: "orders.post.201.00_orders_capture.json" }).on("GET", /^\/v2\/payments\/captures\//, { fixture: "derived.payments.get.200.capture-3C679366HH908993F.json" }));
    const r = await adapter.dispatch(capture(), deadline);
    assert.equal(r.kind, "CAPTURE_OBSERVED");
    const h = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    const expected = createHash("sha256").update(`${h(fixture("orders.post.201.00_orders_capture.json").http.body)}\n${h(fixture("derived.payments.get.200.capture-3C679366HH908993F.json").http.body)}`).digest("hex");
    assert.equal((r as Extract<ProviderDispatchResult, { kind: "CAPTURE_OBSERVED" }>).capture.evidenceHash, expected);
  });

  for (const [title, mutate, expected] of [
    ["OK capture status DECLINED maps to DENIED with no completion instant", (c: Record<string, unknown>) => void (c["status"] = "DECLINED"), { status: "DENIED", completed: false }],
    ["OK capture status FAILED maps to DENIED with no completion instant", (c: Record<string, unknown>) => void (c["status"] = "FAILED"), { status: "DENIED", completed: false }],
    ["OK capture status PENDING maps to PENDING with no completion instant", (c: Record<string, unknown>) => void (c["status"] = "PENDING"), { status: "PENDING", completed: false }],
    ["OK capture status REFUNDED maps to COMPLETED with an unknown completion instant", (c: Record<string, unknown>) => void (c["status"] = "REFUNDED"), { status: "COMPLETED", completed: false }],
  ] as const) {
    it(title, async () => {
      const { adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, captureWith(mutate)));
      const r = await adapter.dispatch(capture(), deadline);
      assert.equal(r.kind, "CAPTURE_OBSERVED");
      const c = (r as Extract<ProviderDispatchResult, { kind: "CAPTURE_OBSERVED" }>).capture;
      assert.deepEqual([c.status, c.providerCompletedAt !== null], [expected.status, expected.completed]);
    });
  }

  for (const [title, mutate] of [
    ["DENY an unknown capture status is UNRECOGNIZED, never coerced", (c: Record<string, unknown>) => void (c["status"] = "ON_HOLD_NEW")],
    ["DENY a three-decimal amount is UNRECOGNIZED, never rounded", (c: Record<string, unknown>) => void (c["amount"] = { currency_code: "USD", value: "100.005" })],
    ["DENY two captures in one capture answer is UNRECOGNIZED", (_c: Record<string, unknown>, o: Record<string, unknown>) => {
      const p = ((o["purchase_units"] as Array<Record<string, unknown>>)[0]!["payments"] as Record<string, unknown[]>);
      p["captures"] = [p["captures"]![0], { ...(p["captures"]![0] as object), id: "SECONDCAPTURE0001" }];
    }],
  ] as const) {
    it(title, async () => {
      const { adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, captureWith(mutate)));
      assert.equal((await adapter.dispatch(capture(), deadline)).kind, "UNRECOGNIZED");
    });
  }

  it("OK a fee reported in another currency is null, never converted (A8: the fee is the reported one)", async () => {
    const { adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, captureWith((c) => void ((c["seller_receivable_breakdown"] as Record<string, unknown>)["paypal_fee"] = { currency_code: "EUR", value: "2.70" }))));
    const r = await adapter.dispatch(capture(), deadline);
    assert.equal((r as Extract<ProviderDispatchResult, { kind: "CAPTURE_OBSERVED" }>).capture.feeCents, null);
  });

  it("DENY a request this adapter did not prepare (no PayPal-Request-Id) is a thrown INVALID_REQUEST and nothing is sent", async () => {
    const { wire, adapter, deadline, capture } = setup();
    const { "PayPal-Request-Id": _dropped, ...headers } = capture().headers;
    await assert.rejects(adapter.dispatch({ ...capture(), headers }, deadline), (e: unknown) => e instanceof PayPalAdapterError && e.code === "INVALID_REQUEST");
    assert.equal(wire.requests.length, 0);
  });
});

describe("PayPal failure matrix — observations", () => {
  it("DENY a refund the provider reports CANCELLED is a thrown UNRECOGNIZED_PROVIDER_STATE (the port's result cannot express it)", async () => {
    const body = { ...(fixture("payments.get.200.refunds_get_platform_fees.json").http.body as object), status: "CANCELLED" };
    const { adapter } = setup((w) => w.on("GET", /^\/v2\/payments\/refunds\//, { status: 200, json: body }));
    await assert.rejects(adapter.observeRefund({ providerRefundId: "1JU08902781691411" }), (e: unknown) => e instanceof PayPalAdapterError && e.code === "UNRECOGNIZED_PROVIDER_STATE");
  });

  it("DENY an order read that fails is a thrown OBSERVATION_FAILED, never NOT_FOUND", async () => {
    for (const answer of [{ fail: "TIMEOUT" }, { status: 500, json: {} }] as const) {
      const { adapter } = setup((w) => w.on("GET", /^\/v2\/checkout\/orders\//, answer));
      await assert.rejects(adapter.observeOrder({ providerOrderId: ORDER }), (e: unknown) => e instanceof PayPalAdapterError && e.code === "OBSERVATION_FAILED");
    }
  });

  it("OK an order read without a status the port names is UNRECOGNIZED and proves no absence", async () => {
    const { adapter } = setup((w) => w.on("GET", /^\/v2\/checkout\/orders\//, { fixture: "orders.get.200.00_orders_get.json" }));
    const seen = await adapter.observeOrder({ providerOrderId: ORDER });
    assert.deepEqual([seen.orderStatus, seen.absenceIsProof], ["UNRECOGNIZED", false]);
  });

  it("OK a CREATED order read names its approval page", async () => {
    const { adapter } = setup((w) => w.on("GET", /^\/v2\/checkout\/orders\//, { fixture: "derived.orders.get.200.created.json" }));
    const seen = await adapter.observeOrder({ providerOrderId: ORDER });
    assert.deepEqual([seen.orderStatus, seen.approvalUrl, seen.captures.length, seen.absenceIsProof], ["CREATED", `https://www.paypal.com/checkoutnow?token=${ORDER}`, 0, true]);
  });
});

describe("PayPal failure matrix — clock skew (rule 5, D-15) and webhook verification", () => {
  const T = Date.UTC(2026, 9, 7, 12, 0, 0);
  const N = 300 + PAYPAL_CLOCK_SKEW_POLICY.toleranceSeconds;

  it("EXPIRY the D-15 policy is the versioned 10 s symmetric tolerance", () => {
    assert.deepEqual({ ...PAYPAL_CLOCK_SKEW_POLICY }, { id: "paypal.clock-skew", version: 1, toleranceSeconds: 10, decision: "D-15" });
  });

  it("EXPIRY past bound: a transmission N-1 s old is fresh, N s fresh, N+1 s stale (N = window + tolerance)", () => {
    assert.deepEqual([N - 1, N, N + 1].map((s) => isFreshTransmission(T - s * 1000, T, 300)), [true, true, false]);
  });

  it("EXPIRY future bound: a transmission 9 s ahead is fresh, 10 s fresh, 11 s stale; no comparison without the margin", () => {
    assert.deepEqual([9, 10, 11].map((s) => isFreshTransmission(T + s * 1000, T, 300)), [true, true, false]);
    assert.equal(isFreshTransmission(Number.NaN, T, 300), false);
  });

  function verifier(answer: Answer) {
    const clock = fixedClock();
    const wire = new RecordedWire().on("POST", /verify-webhook-signature$/, answer);
    const v = createPayPalWebhookVerifier({ environment: "LIVE", webhookId: "WEBHOOK0001", transport: wire.transport, credentials: DOC_CREDENTIALS, clock });
    const bytes = fixtureBytes("derived.webhook.payment-capture-completed.json");
    const headers = {
      [PAYPAL_TRANSMISSION_HEADERS.transmissionId]: "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
      [PAYPAL_TRANSMISSION_HEADERS.transmissionTime]: clock.now(),
      [PAYPAL_TRANSMISSION_HEADERS.signature]: "c2lnbmF0dXJl",
      [PAYPAL_TRANSMISSION_HEADERS.certUrl]: "https://api.paypal.com/v1/notifications/certs/CERT-1",
      [PAYPAL_TRANSMISSION_HEADERS.algorithm]: "SHA256withRSA",
    };
    return { clock, wire, v, bytes, headers };
  }

  it("OK the verification postback carries the event as its exact raw bytes and the environment's webhook id", async () => {
    const { wire, v, bytes, headers, clock } = verifier({ status: 200, json: { verification_status: "SUCCESS" } });
    await v.verify({ bytes, headers, receivedAt: clock.now() });
    const sent = wire.apiRequests[0]!.body!;
    assert.ok(sent.endsWith(`,"webhook_event":${new TextDecoder().decode(bytes)}}`));
    assert.equal((JSON.parse(sent) as { webhook_id: string }).webhook_id, "WEBHOOK0001");
  });

  for (const answer of [{ status: 500, json: {} }, { fail: "TIMEOUT" }, { status: 200, json: { verification_status: "MAYBE" } }] as const) {
    it(`DENY a verification postback that answers neither SUCCESS nor FAILURE (${JSON.stringify(answer)}) is a thrown VERIFICATION_UNAVAILABLE`, async () => {
      const { v, bytes, headers, clock } = verifier(answer);
      await assert.rejects(v.verify({ bytes, headers, receivedAt: clock.now() }), (e: unknown) => e instanceof PayPalAdapterError && e.code === "VERIFICATION_UNAVAILABLE");
    });
  }

  for (const [title, change] of [
    ["DENY a certificate on a foreign host is PROVIDER_SIGNATURE_INVALID and PayPal is not called", { [PAYPAL_TRANSMISSION_HEADERS.certUrl]: "https://api.paypal.com.evil.example/cert" }],
    ["DENY an algorithm other than SHA256withRSA is PROVIDER_SIGNATURE_INVALID and PayPal is not called", { [PAYPAL_TRANSMISSION_HEADERS.algorithm]: "HMACSHA256" }],
  ] as const) {
    it(title, async () => {
      const { wire, v, bytes, headers, clock } = verifier({ status: 200, json: { verification_status: "SUCCESS" } });
      assert.deepEqual(await v.verify({ bytes, headers: { ...headers, ...change }, receivedAt: clock.now() }), { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" });
      assert.equal(wire.requests.length, 0);
    });
  }

  it("RETRY a duplicate delivery of the same event is verified again with the same external event id and body hash (dedupe is the inbox's)", async () => {
    const { v, bytes, headers, clock } = verifier({ status: 200, json: { verification_status: "SUCCESS" } });
    const a = await v.verify({ bytes, headers, receivedAt: clock.now() });
    const b = await v.verify({ bytes, headers, receivedAt: clock.now() });
    assert.equal(a.kind, "VERIFIED");
    assert.deepEqual(a, b);
  });
});

describe("PayPal failure matrix — secrets", () => {
  it("DENY the client secret appears only in the token request's Basic header, never in an API request or an error message", async () => {
    const { wire, adapter, deadline, capture } = setup((w) => w.on("POST", /\/capture$/, { status: 401, json: {} }));
    const error = await adapter.dispatch(capture(), deadline).then(() => null, (e: unknown) => e as Error);
    assert.ok(error instanceof PayPalAdapterError);
    assert.ok(!error.message.includes("doc-example-secret"));
    for (const r of wire.apiRequests) assert.ok(!JSON.stringify(r).includes("doc-example-secret") && !JSON.stringify(r).includes(Buffer.from("doc-example-client:doc-example-secret").toString("base64")));
    assert.ok(!JSON.stringify(capture()).includes("doc-example"));
  });
});
