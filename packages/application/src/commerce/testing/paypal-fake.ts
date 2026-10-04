/**
 * PaymentProviderAdapter — CONTRACT_FAKE of the PayPal Orders v2 contract (15 "Capture and authority"; 10 "Provider adapter
 * contract"; decision D-FAKE-B1). Evidence class SIMULATED: nothing this fake answers is a provider fact, and no case closes on it.
 *
 * What it models faithfully, because the protocol depends on it:
 *  - the exact normalized request of each attempt (`prepare*`, pure): the Orders v2 JSON bodies (create: intent CAPTURE, one
 *    purchase unit with the platform's order as reference, the amount as a two-decimal string, the payee merchant, the return and
 *    cancel URLs on the configured origin; capture: POST /v2/checkout/orders/{id}/capture; refund: POST
 *    /v2/payments/captures/{id}/refund with the amount and the platform's refund as invoice id), the PayPal-Request-Id header
 *    (the attempt's `kauro-<attemptId>`) and a credential reference — never a credential;
 *  - provider-side state: orders (CREATED → APPROVED by the buyer → COMPLETED by a capture; VOIDED, EXPIRED), captures (with payee,
 *    currency, environment, fee, disbursement mode and completion time) and refunds;
 *  - PayPal-Request-Id idempotency: a repeated request id answers the first request's result and never makes a second effect;
 *  - the deadline: a dispatch after its deadline is not sent (answered AMBIGUOUS TIMEOUT, logged `sent: false`);
 *  - programmable results per endpoint (ORDER_CREATED, CAPTURE_OBSERVED, REFUND_OBSERVED, PROVED_NO_EFFECT, AMBIGUOUS — with or
 *    without the effect having happened at the provider, a lost response —, UNRECOGNIZED) and provider behaviour by default (a
 *    capture of an order the buyer has not approved is PROVED_NO_EFFECT ORDER_NOT_APPROVED, as the provider's 422 is);
 *  - read-only observation by provider order id and by request identity (absence is proof for a documented lookup), and of a
 *    refund by provider id or by the capture and request identity;
 *  - a call log of every dispatch and observation, and the count of effects made at the provider;
 *  - the webhook bodies the provider would send about its own state (`webhookBody`), for the verifier fake to sign.
 */
import type { UtcInstant } from "@kauro/contracts";
import type {
  AmbiguityReason,
  CaptureStatus,
  Clock,
  FundsState,
  ObservedCapture,
  ObservedRefund,
  PaymentEnvironment,
  ProviderRequest,
} from "@kauro/domain";
import type { CaptureIntent, CreateOrderIntent, PaymentProviderAdapter, ProviderDispatchResult, ProviderOrderObservation, RefundIntent, StoredEvidence } from "../ports.js";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, centsOf, decimalOf, sha256Hex, type FakeCall } from "./labels.js";

export const PAYPAL_FAKE_PROVIDER = "paypal";

export type PayPalEndpoint = "ORDERS_V2_CREATE" | "ORDERS_V2_CAPTURE" | "CAPTURES_V2_REFUND";

/** How a capture the fake makes deviates from the order (S058: another payee, currency, environment or order; a partial amount). */
export interface CaptureOverrides {
  readonly status?: CaptureStatus;
  readonly amountCents?: bigint;
  readonly currency?: string;
  readonly merchantId?: string;
  readonly environment?: PaymentEnvironment;
  readonly feeCents?: bigint | null;
  /** The provider's disbursement mode: INSTANT → funds AVAILABLE, DELAYED → funds HELD, null → unknown. */
  readonly disbursement?: "INSTANT" | "DELAYED" | null;
  /** The completion instant (defaults to now for a COMPLETED capture; null models a provider view without it). */
  readonly completedAt?: UtcInstant | null;
  /** The provider order the capture names, when it is not the dispatched one (WRONG_ORDER). */
  readonly providerOrderId?: string | null;
}

/** A programmed answer for the next dispatch of an endpoint. */
export type PayPalScript =
  | { readonly kind: "ORDER_CREATED" }
  | { readonly kind: "CAPTURE_OBSERVED"; readonly capture?: CaptureOverrides }
  | { readonly kind: "REFUND_OBSERVED"; readonly status?: "COMPLETED" | "PENDING" | "FAILED"; readonly amountCents?: bigint }
  | { readonly kind: "PROVED_NO_EFFECT"; readonly outcomeCode: string }
  /** A lost or unreadable response; `effect` says whether the provider nevertheless made the effect (lost response) or not. */
  | { readonly kind: "AMBIGUOUS"; readonly reason: AmbiguityReason; readonly effect: "APPLIED" | "NOT_APPLIED"; readonly capture?: CaptureOverrides }
  | { readonly kind: "UNRECOGNIZED" };

interface FakeOrder {
  readonly id: string;
  readonly requestId: string;
  readonly referenceId: string;
  readonly amountCents: bigint;
  readonly currency: string;
  status: "CREATED" | "APPROVED" | "COMPLETED" | "VOIDED" | "EXPIRED";
  readonly createdAt: UtcInstant;
  readonly captureIds: string[];
}

interface FakeCapture {
  readonly id: string;
  readonly orderId: string;
  readonly relatedOrderId: string | null;
  readonly requestId: string | null;
  status: CaptureStatus;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly merchantId: string;
  readonly environment: PaymentEnvironment;
  feeCents: bigint | null;
  disbursement: "INSTANT" | "DELAYED" | null;
  readonly createTime: UtcInstant;
  updateTime: UtcInstant;
  completedAt: UtcInstant | null;
  readonly refundIds: string[];
  dispute: { readonly id: string; status: "OPEN" | "RESOLVED"; readonly amountCents: bigint; readonly reason: string; readonly createTime: UtcInstant; outcome: string | null } | null;
}

interface FakeRefund {
  readonly id: string;
  readonly captureId: string;
  readonly requestId: string | null;
  readonly invoiceId: string | null;
  status: "COMPLETED" | "PENDING" | "FAILED";
  readonly amountCents: bigint;
  readonly currency: string;
  readonly createTime: UtcInstant;
}

export interface PayPalContractFakeOptions {
  readonly clock: Clock;
  readonly environment?: PaymentEnvironment;
  /** The merchant (payee) the platform's route is configured with; its SHA-256 is the route's payee digest. */
  readonly merchantId?: string;
  /** The web surface's allowlisted origin the return and cancel paths resolve against. */
  readonly returnOrigin?: string;
}

export interface PayPalContractFake extends PaymentProviderAdapter {
  readonly integrationClass: typeof CONTRACT_FAKE;
  readonly evidenceClass: typeof FAKE_EVIDENCE_CLASS;
  readonly merchantId: string;
  readonly payeeDigest: string;
  /** Every dispatch and observation, in call order. */
  readonly calls: ReadonlyArray<FakeCall>;
  /** Effects made at the provider (never counting a replayed request id). */
  readonly effects: { readonly ordersCreated: number; readonly captures: number; readonly refunds: number };
  /** Queues the answer of the next dispatch of an endpoint (FIFO); the provider's default behaviour applies when the queue is empty. */
  program(endpoint: PayPalEndpoint, script: PayPalScript): void;
  /** The buyer approves the order at the provider's hosted page (CHECKOUT.ORDER.APPROVED). */
  approve(providerOrderId: string): void;
  /** A capture made at the provider without a dispatch of the platform (a webhook-first or query-first scenario). */
  captureAtProvider(providerOrderId: string, overrides?: CaptureOverrides): string;
  /** Provider-side change of a capture: a reversal (chargeback), a fee report, a disbursement change, a completion instant. */
  updateCapture(providerCaptureId: string, change: { readonly status?: CaptureStatus; readonly feeCents?: bigint | null; readonly disbursement?: "INSTANT" | "DELAYED" | null; readonly completedAt?: UtcInstant | null }): void;
  /**
   * A refund made at the provider without a dispatch of the platform. `invoiceId` models a refund made outside the platform that
   * nevertheless carries a reference (the merchant typed one in the provider's dashboard): the provider's resource names it as its
   * invoice_id, exactly as it names the platform's refund id on a refund the platform requested.
   */
  refundAtProvider(providerCaptureId: string, amountCents: bigint, status?: "COMPLETED" | "PENDING" | "FAILED", options?: { readonly invoiceId?: string }): string;
  /** A dispute opened (or resolved) on a capture at the provider. */
  dispute(providerCaptureId: string, change: { readonly status: "OPEN" | "RESOLVED"; readonly amountCents?: bigint; readonly reason?: string; readonly outcome?: string }): void;
  /** The raw webhook body the provider would deliver about one of its objects (exact bytes; the verifier fake signs them). */
  webhookBody(eventType: string, subjectId: string, options?: { readonly eventId?: string; readonly createTime?: UtcInstant; readonly overrides?: Readonly<Record<string, unknown>> }): { readonly bytes: Uint8Array; readonly eventId: string };
  /** The provider order created under a request identity, if any (test inspection). */
  orderByRequestId(providerRequestId: string): { readonly id: string; readonly status: string } | null;
}

function counter(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${n.toString().padStart(17 - prefix.length, "0")}`;
  };
}

function requireUsd(currency: string): void {
  if (currency !== "USD") throw new TypeError("the PayPal route of this edition charges USD only");
}

export function createPayPalContractFake(options: PayPalContractFakeOptions): PayPalContractFake {
  const clock = options.clock;
  const environment = options.environment ?? "SANDBOX";
  const merchantId = options.merchantId ?? "KAUROFAKEMERCHANT";
  const origin = options.returnOrigin ?? "https://app.kauro.test";
  const approvalHost = environment === "LIVE" ? "www.paypal.com" : "www.sandbox.paypal.com";
  const apiBase = environment === "LIVE" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const credentialRef = `secret-manager://kauro/paypal/${environment.toLowerCase()}/client-credentials/v1`;
  const nextOrder = counter("PPO");
  const nextCapture = counter("PPC");
  const nextRefund = counter("PPR");
  const nextDispute = counter("PPD");
  const nextEvent = counter("WH-");

  const orders = new Map<string, FakeOrder>();
  const captures = new Map<string, FakeCapture>();
  const refunds = new Map<string, FakeRefund>();
  const byRequestId = new Map<string, ProviderDispatchResult>();
  const orderOfRequest = new Map<string, string>();
  const refundOfRequest = new Map<string, string>();
  const scripts = new Map<PayPalEndpoint, PayPalScript[]>();
  const calls: FakeCall[] = [];
  const effects = { ordersCreated: 0, captures: 0, refunds: 0 };

  const log = (operation: string, identity: string | null, sent = true): void => {
    calls.push(Object.freeze({ port: "PaymentProviderAdapter", operation, identity, at: clock.now(), sent }));
  };
  const approvalUrlOf = (id: string): string => `https://${approvalHost}/checkoutnow?token=${id}`;

  function orderResource(o: FakeOrder): Record<string, unknown> {
    return {
      id: o.id,
      status: o.status,
      intent: "CAPTURE",
      purchase_units: [{ reference_id: o.referenceId, amount: { currency_code: o.currency, value: decimalOf(o.amountCents) }, payee: { merchant_id: merchantId } }],
      links: [{ rel: "approve", href: approvalUrlOf(o.id), method: "GET" }],
      create_time: o.createdAt,
    };
  }

  function captureResource(c: FakeCapture): Record<string, unknown> {
    return {
      id: c.id,
      status: c.status,
      amount: { currency_code: c.currency, value: decimalOf(c.amountCents) },
      final_capture: true,
      ...(c.disbursement !== null ? { disbursement_mode: c.disbursement } : {}),
      ...(c.feeCents !== null
        ? { seller_receivable_breakdown: { gross_amount: { currency_code: c.currency, value: decimalOf(c.amountCents) }, paypal_fee: { currency_code: c.currency, value: decimalOf(c.feeCents) }, net_amount: { currency_code: c.currency, value: decimalOf(c.amountCents - c.feeCents) } } }
        : {}),
      payee: { merchant_id: c.merchantId },
      supplementary_data: { related_ids: c.relatedOrderId !== null ? { order_id: c.relatedOrderId } : {} },
      create_time: c.createTime,
      update_time: c.updateTime,
    };
  }

  function refundResource(r: FakeRefund): Record<string, unknown> {
    return {
      id: r.id,
      status: r.status,
      amount: { currency_code: r.currency, value: decimalOf(r.amountCents) },
      ...(r.invoiceId !== null ? { invoice_id: r.invoiceId } : {}),
      links: [{ rel: "up", href: `${apiBase}/v2/payments/captures/${r.captureId}`, method: "GET" }],
      create_time: r.createTime,
      update_time: r.createTime,
    };
  }

  const evidence = (resource: unknown): string => sha256Hex(JSON.stringify(resource));

  function observedCapture(c: FakeCapture): ObservedCapture {
    const funds: FundsState = c.disbursement === "INSTANT" ? "AVAILABLE" : c.disbursement === "DELAYED" ? "HELD" : "UNKNOWN";
    return {
      provider: PAYPAL_FAKE_PROVIDER,
      environment: c.environment,
      providerOrderId: c.relatedOrderId,
      providerCaptureId: c.id,
      status: c.status,
      amountCents: c.amountCents,
      currency: c.currency,
      payeeDigest: sha256Hex(c.merchantId),
      providerCompletedAt: c.completedAt,
      fundsState: funds,
      feeCents: c.feeCents,
      evidenceHash: evidence(captureResource(c)),
    };
  }

  function observedRefund(r: FakeRefund): ObservedRefund {
    const c = captures.get(r.captureId);
    return {
      provider: PAYPAL_FAKE_PROVIDER,
      environment: c?.environment ?? environment,
      providerCaptureId: r.captureId,
      providerRefundId: r.id,
      // the refund resource names the invoice_id its request carried (the platform's refund id), or none
      platformRefundRef: r.invoiceId,
      status: r.status,
      amountCents: r.amountCents,
      currency: r.currency,
      evidenceHash: evidence(refundResource(r)),
    };
  }

  function makeCapture(order: FakeOrder, requestId: string | null, overrides: CaptureOverrides = {}): FakeCapture {
    const now = clock.now();
    const status = overrides.status ?? "COMPLETED";
    const completedAt = overrides.completedAt !== undefined ? overrides.completedAt : status === "COMPLETED" || status === "REVERSED" ? now : null;
    const capture: FakeCapture = {
      id: nextCapture(),
      orderId: order.id,
      relatedOrderId: overrides.providerOrderId !== undefined ? overrides.providerOrderId : order.id,
      requestId,
      status,
      amountCents: overrides.amountCents ?? order.amountCents,
      currency: overrides.currency ?? order.currency,
      merchantId: overrides.merchantId ?? merchantId,
      environment: overrides.environment ?? environment,
      feeCents: overrides.feeCents ?? null,
      disbursement: overrides.disbursement ?? null,
      createTime: now,
      updateTime: now,
      completedAt,
      refundIds: [],
      dispute: null,
    };
    captures.set(capture.id, capture);
    order.captureIds.push(capture.id);
    if (status === "COMPLETED") order.status = "COMPLETED";
    effects.captures += 1;
    return capture;
  }

  function orderObservation(o: FakeOrder | null): ProviderOrderObservation {
    const now = clock.now();
    if (o === null) return { providerOrderId: null, orderStatus: "NOT_FOUND", captures: [], refunds: [], absenceIsProof: true, observedAt: now, evidenceHash: evidence({ name: "RESOURCE_NOT_FOUND", observedAt: now }) };
    const cs = o.captureIds.map((id) => captures.get(id)!).filter((c) => c !== undefined);
    const rs = cs.flatMap((c) => c.refundIds.map((id) => refunds.get(id)!));
    return {
      providerOrderId: o.id,
      approvalUrl: approvalUrlOf(o.id),
      orderStatus: o.status,
      captures: cs.map(observedCapture),
      refunds: rs.map(observedRefund),
      absenceIsProof: true,
      observedAt: now,
      evidenceHash: evidence({ order: orderResource(o), captures: cs.map(captureResource), refunds: rs.map(refundResource) }),
    };
  }

  function nextScript(endpoint: PayPalEndpoint): PayPalScript | undefined {
    return scripts.get(endpoint)?.shift();
  }

  function pathOf(request: ProviderRequest, key: string): string {
    const body = request.body as unknown as { readonly path?: Readonly<Record<string, unknown>> };
    const v = body.path?.[key];
    if (typeof v !== "string") throw new TypeError(`the ${request.endpointProfile} request names no ${key}`);
    return v;
  }

  const fake: PayPalContractFake = {
    provider: PAYPAL_FAKE_PROVIDER,
    environment,
    integrationClass: CONTRACT_FAKE,
    evidenceClass: FAKE_EVIDENCE_CLASS,
    merchantId,
    payeeDigest: sha256Hex(merchantId),
    approvalHosts: Object.freeze([approvalHost]),
    get calls() {
      return calls;
    },
    get effects() {
      return { ...effects };
    },

    prepareCreateOrder(intent: CreateOrderIntent): ProviderRequest {
      requireUsd(intent.currency);
      return {
        method: "POST",
        endpointProfile: "ORDERS_V2_CREATE",
        body: {
          path: {},
          json: {
            intent: "CAPTURE",
            purchase_units: [{ reference_id: intent.orderId, custom_id: intent.orderId, description: intent.description, amount: { currency_code: intent.currency, value: decimalOf(intent.amountCents) }, payee: { merchant_id: merchantId } }],
            application_context: { return_url: `${origin}${intent.returnPath}`, cancel_url: `${origin}${intent.cancelPath}`, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" },
          },
        },
        headers: { "PayPal-Request-Id": intent.providerRequestId, Prefer: "return=representation" },
        credentialRef,
      };
    },

    prepareCapture(intent: CaptureIntent): ProviderRequest {
      requireUsd(intent.currency);
      return {
        method: "POST",
        endpointProfile: "ORDERS_V2_CAPTURE",
        body: { path: { order_id: intent.providerOrderId }, json: {} },
        headers: { "PayPal-Request-Id": intent.providerRequestId, Prefer: "return=representation" },
        credentialRef,
      };
    },

    prepareRefund(intent: RefundIntent): ProviderRequest {
      requireUsd(intent.currency);
      return {
        method: "POST",
        endpointProfile: "CAPTURES_V2_REFUND",
        body: { path: { capture_id: intent.providerCaptureId }, json: { amount: { currency_code: intent.currency, value: decimalOf(intent.amountCents) }, invoice_id: intent.refundId } },
        headers: { "PayPal-Request-Id": intent.providerRequestId, Prefer: "return=representation" },
        credentialRef,
      };
    },

    async dispatch(request: ProviderRequest, deadline: UtcInstant): Promise<ProviderDispatchResult> {
      const requestId = request.headers["PayPal-Request-Id"];
      if (requestId === undefined) throw new TypeError("every dispatch carries its PayPal-Request-Id");
      if (clock.nowMs() > Date.parse(deadline)) {
        // the adapter never sends past its deadline: nothing reached the provider
        log(`DISPATCH ${request.endpointProfile}`, requestId, false);
        return { kind: "AMBIGUOUS", reason: "TIMEOUT" };
      }
      log(`DISPATCH ${request.endpointProfile}`, requestId);
      const prior = byRequestId.get(requestId);
      if (prior !== undefined) return prior;
      const endpoint = request.endpointProfile as PayPalEndpoint;
      switch (endpoint) {
        case "ORDERS_V2_CREATE": {
          const script = nextScript(endpoint) ?? { kind: "ORDER_CREATED" };
          if (script.kind === "PROVED_NO_EFFECT") {
            const result: ProviderDispatchResult = { kind: "PROVED_NO_EFFECT", outcomeCode: script.outcomeCode, evidenceHash: evidence({ name: script.outcomeCode, requestId }) };
            byRequestId.set(requestId, result);
            return result;
          }
          const applies = script.kind === "ORDER_CREATED" || (script.kind === "AMBIGUOUS" && script.effect === "APPLIED") || script.kind === "UNRECOGNIZED";
          if (applies) {
            const json = (request.body as unknown as { readonly json: { readonly purchase_units: ReadonlyArray<{ readonly reference_id: string; readonly amount: { readonly currency_code: string; readonly value: string } }> } }).json;
            const unit = json.purchase_units[0]!;
            const order: FakeOrder = { id: nextOrder(), requestId, referenceId: unit.reference_id, amountCents: centsOf(unit.amount.value) ?? 0n, currency: unit.amount.currency_code, status: "CREATED", createdAt: clock.now(), captureIds: [] };
            orders.set(order.id, order);
            orderOfRequest.set(requestId, order.id);
            effects.ordersCreated += 1;
            byRequestId.set(requestId, { kind: "ORDER_CREATED", providerOrderId: order.id, approvalUrl: approvalUrlOf(order.id), evidenceHash: evidence(orderResource(order)) });
          }
          if (script.kind === "AMBIGUOUS") return { kind: "AMBIGUOUS", reason: script.reason };
          if (script.kind === "UNRECOGNIZED") return { kind: "UNRECOGNIZED", evidenceHash: evidence({ status: "PAYER_ACTION_REQUIRED_UNKNOWN", requestId }) };
          return byRequestId.get(requestId)!;
        }
        case "ORDERS_V2_CAPTURE": {
          const order = orders.get(pathOf(request, "order_id"));
          if (order === undefined) return { kind: "PROVED_NO_EFFECT", outcomeCode: "RESOURCE_NOT_FOUND", evidenceHash: evidence({ name: "RESOURCE_NOT_FOUND", requestId }) };
          const script = nextScript(endpoint) ?? (order.status === "APPROVED" ? { kind: "CAPTURE_OBSERVED" } : { kind: "PROVED_NO_EFFECT", outcomeCode: order.status === "COMPLETED" ? "ORDER_ALREADY_CAPTURED" : "ORDER_NOT_APPROVED" });
          if (script.kind === "PROVED_NO_EFFECT") {
            const result: ProviderDispatchResult = { kind: "PROVED_NO_EFFECT", outcomeCode: script.outcomeCode, evidenceHash: evidence({ name: script.outcomeCode, requestId }) };
            byRequestId.set(requestId, result);
            return result;
          }
          if (script.kind === "CAPTURE_OBSERVED" || (script.kind === "AMBIGUOUS" && script.effect === "APPLIED")) {
            const capture = makeCapture(order, requestId, script.capture);
            byRequestId.set(requestId, { kind: "CAPTURE_OBSERVED", capture: observedCapture(capture) });
          }
          if (script.kind === "AMBIGUOUS") return { kind: "AMBIGUOUS", reason: script.reason };
          if (script.kind === "UNRECOGNIZED") return { kind: "UNRECOGNIZED", evidenceHash: evidence({ status: "UNKNOWN_CAPTURE_STATE", requestId }) };
          return byRequestId.get(requestId) ?? { kind: "UNRECOGNIZED", evidenceHash: evidence({ requestId }) };
        }
        case "CAPTURES_V2_REFUND": {
          const capture = captures.get(pathOf(request, "capture_id"));
          if (capture === undefined) return { kind: "PROVED_NO_EFFECT", outcomeCode: "RESOURCE_NOT_FOUND", evidenceHash: evidence({ name: "RESOURCE_NOT_FOUND", requestId }) };
          const script = nextScript(endpoint) ?? { kind: "REFUND_OBSERVED" };
          if (script.kind === "PROVED_NO_EFFECT") {
            const result: ProviderDispatchResult = { kind: "PROVED_NO_EFFECT", outcomeCode: script.outcomeCode, evidenceHash: evidence({ name: script.outcomeCode, requestId }) };
            byRequestId.set(requestId, result);
            return result;
          }
          if (script.kind === "REFUND_OBSERVED" || (script.kind === "AMBIGUOUS" && script.effect === "APPLIED")) {
            const json = (request.body as unknown as { readonly json: { readonly amount: { readonly value: string; readonly currency_code: string }; readonly invoice_id?: string } }).json;
            const refund: FakeRefund = {
              id: nextRefund(),
              captureId: capture.id,
              requestId,
              invoiceId: json.invoice_id ?? null,
              status: script.kind === "REFUND_OBSERVED" ? (script.status ?? "COMPLETED") : "COMPLETED",
              amountCents: script.kind === "REFUND_OBSERVED" && script.amountCents !== undefined ? script.amountCents : (centsOf(json.amount.value) ?? 0n),
              currency: json.amount.currency_code,
              createTime: clock.now(),
            };
            refunds.set(refund.id, refund);
            refundOfRequest.set(requestId, refund.id);
            capture.refundIds.push(refund.id);
            effects.refunds += 1;
            byRequestId.set(requestId, { kind: "REFUND_OBSERVED", refund: observedRefund(refund) });
          }
          if (script.kind === "AMBIGUOUS") return { kind: "AMBIGUOUS", reason: script.reason };
          if (script.kind === "UNRECOGNIZED") return { kind: "UNRECOGNIZED", evidenceHash: evidence({ status: "UNKNOWN_REFUND_STATE", requestId }) };
          return byRequestId.get(requestId) ?? { kind: "UNRECOGNIZED", evidenceHash: evidence({ requestId }) };
        }
        default:
          throw new TypeError(`the PayPal contract fake has no endpoint ${request.endpointProfile}`);
      }
    },

    async observeOrder(ref): Promise<ProviderOrderObservation> {
      if ("providerOrderId" in ref) {
        log("OBSERVE_ORDER", ref.providerOrderId);
        return orderObservation(orders.get(ref.providerOrderId) ?? null);
      }
      log("OBSERVE_ORDER_BY_REQUEST", ref.providerRequestId);
      const id = orderOfRequest.get(ref.providerRequestId);
      return orderObservation(id === undefined ? null : (orders.get(id) ?? null));
    },

    async observeRefund(ref) {
      let refund: FakeRefund | undefined;
      if ("providerRefundId" in ref) {
        log("OBSERVE_REFUND", ref.providerRefundId);
        refund = refunds.get(ref.providerRefundId);
      } else {
        log("OBSERVE_REFUND_BY_REQUEST", ref.providerRequestId);
        const id = refundOfRequest.get(ref.providerRequestId);
        refund = id === undefined ? undefined : refunds.get(id);
        if (refund !== undefined && refund.captureId !== ref.providerCaptureId) refund = undefined;
      }
      if (refund === undefined) return { kind: "NOT_FOUND" as const, absenceIsProof: true, evidenceHash: evidence({ name: "RESOURCE_NOT_FOUND", ref, at: clock.now() }) };
      return observedRefund(refund);
    },

    classifyOrderObservation(stored: StoredEvidence): ProviderOrderObservation {
      const normalized = stored.normalized;
      if (stored.provider !== PAYPAL_FAKE_PROVIDER || !("orderStatus" in normalized)) throw new TypeError("the stored evidence is not a PayPal order observation");
      return normalized;
    },

    program(endpoint, script) {
      const queue = scripts.get(endpoint) ?? [];
      queue.push(script);
      scripts.set(endpoint, queue);
    },

    approve(providerOrderId) {
      const order = orders.get(providerOrderId);
      if (order === undefined || order.status !== "CREATED") throw new RangeError("only a CREATED order is approved by its buyer");
      order.status = "APPROVED";
    },

    captureAtProvider(providerOrderId, overrides) {
      const order = orders.get(providerOrderId);
      if (order === undefined) throw new RangeError("unknown provider order");
      return makeCapture(order, null, overrides).id;
    },

    updateCapture(providerCaptureId, change) {
      const capture = captures.get(providerCaptureId);
      if (capture === undefined) throw new RangeError("unknown provider capture");
      if (change.status !== undefined) {
        if (change.status === "COMPLETED" && capture.completedAt === null) capture.completedAt = clock.now();
        capture.status = change.status;
      }
      if (change.feeCents !== undefined) capture.feeCents = change.feeCents;
      if (change.disbursement !== undefined) capture.disbursement = change.disbursement;
      if (change.completedAt !== undefined) capture.completedAt = change.completedAt;
      capture.updateTime = clock.now();
    },

    refundAtProvider(providerCaptureId, amountCents, status = "COMPLETED", refundOptions = {}) {
      const capture = captures.get(providerCaptureId);
      if (capture === undefined) throw new RangeError("unknown provider capture");
      const refund: FakeRefund = { id: nextRefund(), captureId: capture.id, requestId: null, invoiceId: refundOptions.invoiceId ?? null, status, amountCents, currency: capture.currency, createTime: clock.now() };
      refunds.set(refund.id, refund);
      capture.refundIds.push(refund.id);
      effects.refunds += 1;
      return refund.id;
    },

    dispute(providerCaptureId, change) {
      const capture = captures.get(providerCaptureId);
      if (capture === undefined) throw new RangeError("unknown provider capture");
      if (capture.dispute === null) {
        capture.dispute = { id: nextDispute(), status: change.status, amountCents: change.amountCents ?? capture.amountCents, reason: change.reason ?? "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", createTime: clock.now(), outcome: change.outcome ?? null };
      } else {
        capture.dispute.status = change.status;
        capture.dispute.outcome = change.outcome ?? capture.dispute.outcome;
      }
    },

    webhookBody(eventType, subjectId, opts = {}) {
      let resourceType: string;
      let resource: Record<string, unknown>;
      if (eventType.startsWith("CHECKOUT.ORDER.")) {
        const order = orders.get(subjectId);
        if (order === undefined) throw new RangeError("unknown provider order");
        resourceType = "checkout-order";
        resource = orderResource(order);
      } else if (eventType === "PAYMENT.CAPTURE.REFUNDED" || eventType.startsWith("PAYMENT.REFUND.")) {
        const refund = refunds.get(subjectId);
        if (refund === undefined) throw new RangeError("unknown provider refund");
        resourceType = "refund";
        resource = refundResource(refund);
      } else if (eventType.startsWith("PAYMENT.CAPTURE.")) {
        const capture = captures.get(subjectId);
        if (capture === undefined) throw new RangeError("unknown provider capture");
        resourceType = "capture";
        resource = captureResource(capture);
      } else if (eventType.startsWith("CUSTOMER.DISPUTE.")) {
        const capture = captures.get(subjectId);
        if (capture?.dispute == null) throw new RangeError("no dispute on this capture");
        const d = capture.dispute;
        resourceType = "dispute";
        resource = {
          dispute_id: d.id,
          create_time: d.createTime,
          update_time: clock.now(),
          reason: d.reason,
          status: d.status,
          ...(d.outcome !== null ? { dispute_outcome: { outcome_code: d.outcome } } : {}),
          dispute_amount: { currency_code: capture.currency, value: decimalOf(d.amountCents) },
          disputed_transactions: [{ seller_transaction_id: capture.id }],
        };
      } else {
        resourceType = "unknown";
        resource = { id: subjectId };
      }
      const eventId = opts.eventId ?? nextEvent();
      const body = { id: eventId, event_version: "1.0", create_time: opts.createTime ?? clock.now(), resource_type: resourceType, event_type: eventType, summary: `${eventType} (contract fake)`, resource: { ...resource, ...(opts.overrides ?? {}) } };
      return { bytes: new TextEncoder().encode(JSON.stringify(body)), eventId };
    },

    orderByRequestId(providerRequestId) {
      const id = orderOfRequest.get(providerRequestId);
      const order = id === undefined ? undefined : orders.get(id);
      return order === undefined ? null : { id: order.id, status: order.status };
    },
  };
  return fake;
}
