/**
 * PaymentProviderAdapter — PROVIDER binding of PayPal Orders v2 and Payments v2 (package B15; 10 "Provider adapter contract"; 15
 * "Capture and authority"). Wire contract: https://developer.paypal.com/docs/api/orders/v2/ and
 * https://developer.paypal.com/docs/api/payments/v2/ (OpenAPI 2.32 / 2.12 of github.com/paypal/paypal-rest-api-specifications,
 * retrieved 2026-10-07; the recorded fixtures under test/fixtures/wire carry the URL, version and digest of each example).
 *
 * What one dispatch proves (10: timeout, reset, rejection, pending, unknown and confirmed are distinct):
 *  - 200/201 with the documented resource → ORDER_CREATED / CAPTURE_OBSERVED / REFUND_OBSERVED (the 200 is PayPal's idempotent replay
 *    of the same PayPal-Request-Id and answers the first request's result);
 *  - 400, 404, 422 → PROVED_NO_EFFECT with the provider's issue as outcome code (an authenticated refusal of this request);
 *  - 5xx → AMBIGUOUS PROVIDER_5XX; a timeout, reset or unreadable body → AMBIGUOUS with that reason; nothing sent after the deadline;
 *  - 401 twice, 403, 409, 429 → a thrown PayPalAdapterError (no proof either way: the attempt stays on its ambiguous path);
 *  - any other answer, or a documented one with an unknown status → UNRECOGNIZED, never coerced.
 *
 * PayPal documents no read-only lookup of an order or a refund by PayPal-Request-Id: those observations answer NOT_FOUND with
 * `absenceIsProof: false` and call nothing (finding F-PP-1 of B15-adapters.md; the contract fake proves absence there).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CaptureIntent, CreateOrderIntent, PaymentProviderAdapter, ProviderDispatchResult, ProviderOrderObservation, RefundIntent, StoredEvidence } from "@kauro/application";
import type { Clock, ObservedCapture, ObservedRefund, PaymentEnvironment, ProviderRequest } from "@kauro/domain";
import { createPayPalHttpClient, type PayPalCredentialSource } from "./client.js";
import { PayPalAdapterError } from "./errors.js";
import { readCapture, readRefund, PAYPAL_PROVIDER } from "./normalize.js";
import { PAYPAL_ENVIRONMENTS, defaultPayPalCredentialRef } from "./policy.js";
import { TransportFailure, type HttpResponse, type HttpTransport } from "./transport.js";
import { arr, decimalOf, linkOf, obj, parseObject, sha256Hex, str, tokenOf, type Json } from "./wire.js";

export type PayPalEndpointProfile = "ORDERS_V2_CREATE" | "ORDERS_V2_CAPTURE" | "CAPTURES_V2_REFUND";

export interface PayPalOrdersAdapterOptions {
  readonly environment: PaymentEnvironment;
  /** The merchant (payee) of the platform's route; its SHA-256 is the route's payee digest. */
  readonly merchantId: string;
  /** The web surface's allowlisted https origin the return and cancel paths resolve against. */
  readonly returnOrigin: string;
  readonly transport: HttpTransport;
  readonly credentials: PayPalCredentialSource;
  readonly clock: Clock;
  readonly credentialRef?: string;
  /** Bound of one observation (a read has no caller deadline); 15 s by default. */
  readonly observationTimeoutMs?: number;
}

export interface PayPalOrdersAdapter extends PaymentProviderAdapter {
  readonly integrationClass: "PROVIDER";
  readonly merchantId: string;
  readonly payeeDigest: string;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;
const FORWARDED_HEADERS = ["PayPal-Request-Id", "Prefer"] as const;

function requireUsd(currency: string): void {
  if (currency !== "USD") throw new TypeError("the PayPal route of this edition charges USD only");
}

/** One digest over the exact bytes of every response an answer was read from, in order. */
function evidenceOf(responses: ReadonlyArray<HttpResponse>): string {
  return responses.length === 1 ? sha256Hex(responses[0]!.body) : sha256Hex(responses.map((r) => sha256Hex(r.body)).join("\n"));
}

export function createPayPalOrdersAdapter(options: PayPalOrdersAdapterOptions): PayPalOrdersAdapter {
  const { environment, merchantId, clock } = options;
  const profile = PAYPAL_ENVIRONMENTS[environment];
  const credentialRef = options.credentialRef ?? defaultPayPalCredentialRef(environment);
  const observationTimeoutMs = options.observationTimeoutMs ?? 15_000;
  const origin = new URL(options.returnOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.returnOrigin) throw new TypeError("the return origin is an exact https origin");
  if (!/^[A-Z0-9]{5,32}$/.test(merchantId)) throw new TypeError("a PayPal merchant id");
  const client = createPayPalHttpClient({ apiBase: profile.apiBase, transport: options.transport, credentials: options.credentials, clock });

  const pathOf = (path: string): string => {
    if (!path.startsWith("/") || path.startsWith("//")) throw new TypeError("a return or cancel path is absolute on the configured origin");
    return `${origin.origin}${path}`;
  };

  const approvalUrlOf = (resource: Json): string | null => {
    const href = linkOf(resource, ["approve", "payer-action"]);
    if (href === null) return null;
    try {
      const url = new URL(href);
      return url.protocol === "https:" && profile.approvalHosts.includes(url.host) ? href : null;
    } catch {
      return null;
    }
  };

  /** A read under its own bound; a transport failure or a 5xx is an OBSERVATION_FAILED error (a read never proves anything by failing). */
  async function read(path: string, deadlineMs = clock.nowMs() + observationTimeoutMs): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await client.call({ method: "GET", path, credentialRef, deadlineMs });
    } catch (error) {
      if (error instanceof TransportFailure) throw new PayPalAdapterError("OBSERVATION_FAILED", null, { cause: error.kind });
      throw error;
    }
    if (response.status >= 500) throw new PayPalAdapterError("OBSERVATION_FAILED", response.status);
    refuseUnauthorized(response);
    return response;
  }

  function refuseUnauthorized(response: HttpResponse): void {
    if (response.status === 403) throw new PayPalAdapterError("PERMISSION_DENIED", 403);
    if (response.status === 409) throw new PayPalAdapterError("REQUEST_IN_PROGRESS", 409);
    if (response.status === 429) throw new PayPalAdapterError("RATE_LIMITED", 429);
  }

  type Completed = { readonly kind: "CAPTURE"; readonly capture: ObservedCapture; readonly extra: HttpResponse | null } | { readonly kind: "UNRECOGNIZED" };

  /** A capture named inside an order; when neither it nor its unit names the payee, the capture resource itself is read. */
  async function completeCapture(resource: Json, unitPayee: string | null, orderId: string | null, evidence: (extra: HttpResponse | null) => string, deadlineMs?: number): Promise<Completed> {
    const first = readCapture(resource, { environment, evidenceHash: evidence(null), fallbackPayee: unitPayee, fallbackOrderId: orderId });
    if (first.kind === "CAPTURE") return { kind: "CAPTURE", capture: first.capture, extra: null };
    if (first.kind === "UNRECOGNIZED") return first;
    const response = await read(`/v2/payments/captures/${encodeURIComponent(first.captureId)}`, deadlineMs);
    const body = response.status === 200 ? parseObject(response.body) : null;
    if (body === null || str(body["id"]) !== first.captureId) return { kind: "UNRECOGNIZED" };
    const second = readCapture(body, { environment, evidenceHash: evidence(response), fallbackOrderId: orderId });
    return second.kind === "CAPTURE" ? { kind: "CAPTURE", capture: second.capture, extra: response } : { kind: "UNRECOGNIZED" };
  }

  interface UnitPayment {
    readonly resource: Json;
    readonly unitPayee: string | null;
  }

  function paymentsOf(order: Json, key: "captures" | "refunds"): ReadonlyArray<UnitPayment> {
    return arr(order["purchase_units"]).flatMap((u) => {
      const unit = obj(u);
      const unitPayee = str(obj(unit?.["payee"])?.["merchant_id"]);
      return arr(obj(unit?.["payments"])?.[key]).map((p) => ({ resource: obj(p) ?? {}, unitPayee }));
    });
  }

  const ORDER_STATUS: Readonly<Record<string, ProviderOrderObservation["orderStatus"]>> = Object.freeze({ CREATED: "CREATED", APPROVED: "APPROVED", VOIDED: "VOIDED", COMPLETED: "COMPLETED" });

  async function observationOf(response: HttpResponse): Promise<ProviderOrderObservation> {
    const observedAt = clock.now();
    const order = parseObject(response.body);
    const unrecognized = (responses: ReadonlyArray<HttpResponse>): ProviderOrderObservation => ({ providerOrderId: str(order?.["id"]), orderStatus: "UNRECOGNIZED", captures: [], refunds: [], absenceIsProof: false, observedAt, evidenceHash: evidenceOf(responses) });
    if (order === null) return unrecognized([response]);
    const id = str(order["id"]);
    const status = ORDER_STATUS[str(order["status"]) ?? ""];
    if (id === null || status === undefined) return unrecognized([response]);
    const responses: HttpResponse[] = [response];
    const captures: ObservedCapture[] = [];
    // every capture first, so the evidence hash covers each capture read the observation needed
    const pending: Array<Promise<Completed>> = paymentsOf(order, "captures").map((p) => completeCapture(p.resource, p.unitPayee, id, () => ""));
    for (const done of await Promise.all(pending)) {
      if (done.kind === "UNRECOGNIZED") return unrecognized(responses);
      if (done.extra !== null) responses.push(done.extra);
      captures.push(done.capture);
    }
    const evidenceHash = evidenceOf(responses);
    const refunds: ObservedRefund[] = [];
    for (const p of paymentsOf(order, "refunds")) {
      const refund = readRefund(p.resource, { environment, evidenceHash });
      if (refund === null) return unrecognized(responses);
      refunds.push(refund);
    }
    const approvalUrl = approvalUrlOf(order);
    return {
      providerOrderId: id,
      ...(approvalUrl !== null ? { approvalUrl } : {}),
      orderStatus: status,
      captures: captures.map((c) => ({ ...c, evidenceHash })),
      refunds,
      // a read of the order by its id lists every capture and refund of the order: what it does not show did not happen
      absenceIsProof: true,
      observedAt,
      evidenceHash,
    };
  }

  async function classify(endpoint: PayPalEndpointProfile, response: HttpResponse, pathIds: Readonly<Record<string, string>>, deadlineMs: number): Promise<ProviderDispatchResult> {
    const evidenceHash = sha256Hex(response.body);
    if (response.status >= 500) return { kind: "AMBIGUOUS", reason: "PROVIDER_5XX" };
    refuseUnauthorized(response);
    if (response.status === 400 || response.status === 404 || response.status === 422) {
      const error = parseObject(response.body);
      const issue = str(obj(arr(error?.["details"])[0])?.["issue"]) ?? str(error?.["name"]);
      return { kind: "PROVED_NO_EFFECT", outcomeCode: tokenOf(issue, `HTTP_${response.status}`), evidenceHash };
    }
    if (response.status !== 200 && response.status !== 201) return { kind: "UNRECOGNIZED", evidenceHash };
    const body = parseObject(response.body);
    if (body === null) return { kind: "AMBIGUOUS", reason: "UNREADABLE_RESPONSE" };
    switch (endpoint) {
      case "ORDERS_V2_CREATE": {
        const id = str(body["id"]);
        const status = str(body["status"]);
        const approvalUrl = approvalUrlOf(body);
        // the minimal representation may omit the status; when present it is CREATED (application_context, no payment_source)
        if (id === null || !ID.test(id) || approvalUrl === null || (status !== null && status !== "CREATED")) return { kind: "UNRECOGNIZED", evidenceHash };
        return { kind: "ORDER_CREATED", providerOrderId: id, approvalUrl, evidenceHash };
      }
      case "ORDERS_V2_CAPTURE": {
        const captures = paymentsOf(body, "captures");
        if (captures.length !== 1) return { kind: "UNRECOGNIZED", evidenceHash };
        const only = captures[0]!;
        let done: Completed;
        try {
          done = await completeCapture(only.resource, only.unitPayee, str(body["id"]) ?? pathIds["order_id"]!, (extra) => (extra === null ? evidenceHash : evidenceOf([response, extra])), deadlineMs);
        } catch (error) {
          // the capture happened; only its payee could not be read yet: the reconciler binds it from an observation of the order
          if (error instanceof PayPalAdapterError && error.code === "OBSERVATION_FAILED") return { kind: "AMBIGUOUS", reason: "OBSERVATION_LOST" };
          throw error;
        }
        return done.kind === "CAPTURE" ? { kind: "CAPTURE_OBSERVED", capture: done.capture } : { kind: "UNRECOGNIZED", evidenceHash };
      }
      case "CAPTURES_V2_REFUND": {
        const refund = readRefund(body, { environment, evidenceHash, captureId: pathIds["capture_id"]! });
        return refund === null ? { kind: "UNRECOGNIZED", evidenceHash } : { kind: "REFUND_OBSERVED", refund };
      }
    }
  }

  function routeOf(request: ProviderRequest): { readonly endpoint: PayPalEndpointProfile; readonly path: string; readonly json: string; readonly ids: Readonly<Record<string, string>> } {
    const body = obj(request.body);
    const path = obj(body?.["path"]) ?? {};
    const json = obj(body?.["json"]);
    if (json === null || request.method !== "POST") throw new PayPalAdapterError("INVALID_REQUEST");
    const idOf = (key: string): string => {
      const v = str(path[key]);
      if (v === null || !ID.test(v)) throw new PayPalAdapterError("INVALID_REQUEST");
      return v;
    };
    switch (request.endpointProfile) {
      case "ORDERS_V2_CREATE":
        return { endpoint: "ORDERS_V2_CREATE", path: "/v2/checkout/orders", json: JSON.stringify(json), ids: {} };
      case "ORDERS_V2_CAPTURE": {
        const orderId = idOf("order_id");
        return { endpoint: "ORDERS_V2_CAPTURE", path: `/v2/checkout/orders/${orderId}/capture`, json: JSON.stringify(json), ids: { order_id: orderId } };
      }
      case "CAPTURES_V2_REFUND": {
        const captureId = idOf("capture_id");
        return { endpoint: "CAPTURES_V2_REFUND", path: `/v2/payments/captures/${captureId}/refund`, json: JSON.stringify(json), ids: { capture_id: captureId } };
      }
      default:
        throw new PayPalAdapterError("INVALID_REQUEST");
    }
  }

  const notLookedUp = (requestId: string): string => sha256Hex(`paypal|${environment}|NO_DOCUMENTED_LOOKUP_BY_REQUEST_ID|${requestId}`);

  return {
    provider: PAYPAL_PROVIDER,
    environment,
    integrationClass: "PROVIDER",
    merchantId,
    payeeDigest: sha256Hex(merchantId),
    approvalHosts: profile.approvalHosts,

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
            // application_context (not payment_source.paypal.experience_context): the order is then CREATED with an `approve` link,
            // the state the port names; experience_context answers PAYER_ACTION_REQUIRED, which the port does not (B15-adapters.md)
            application_context: { return_url: pathOf(intent.returnPath), cancel_url: pathOf(intent.cancelPath), user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" },
          },
        },
        headers: { "PayPal-Request-Id": intent.providerRequestId, Prefer: "return=representation" },
        credentialRef,
      };
    },

    prepareCapture(intent: CaptureIntent): ProviderRequest {
      requireUsd(intent.currency);
      if (!ID.test(intent.providerOrderId)) throw new TypeError("a PayPal order id");
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
      if (!ID.test(intent.providerCaptureId)) throw new TypeError("a PayPal capture id");
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
      const deadlineMs = Date.parse(deadline);
      if (requestId === undefined || requestId.length === 0 || requestId.length > 108 || !Number.isFinite(deadlineMs)) throw new PayPalAdapterError("INVALID_REQUEST");
      const route = routeOf(request);
      // the adapter never sends past its deadline: nothing reached the provider (D-PROTO-B4)
      if (clock.nowMs() > deadlineMs) return { kind: "AMBIGUOUS", reason: "TIMEOUT" };
      const headers: Record<string, string> = {};
      for (const name of FORWARDED_HEADERS) {
        const v = request.headers[name];
        if (v !== undefined) headers[name] = v;
      }
      let response: HttpResponse;
      try {
        response = await client.call({ method: "POST", path: route.path, body: route.json, headers, credentialRef: request.credentialRef, deadlineMs });
      } catch (error) {
        if (error instanceof TransportFailure) return { kind: "AMBIGUOUS", reason: error.kind };
        throw error;
      }
      return classify(route.endpoint, response, route.ids, deadlineMs);
    },

    async observeOrder(ref): Promise<ProviderOrderObservation> {
      if (!("providerOrderId" in ref)) {
        return { providerOrderId: null, orderStatus: "NOT_FOUND", captures: [], refunds: [], absenceIsProof: false, observedAt: clock.now(), evidenceHash: notLookedUp(ref.providerRequestId) };
      }
      if (!ID.test(ref.providerOrderId)) throw new TypeError("a PayPal order id");
      const response = await read(`/v2/checkout/orders/${ref.providerOrderId}`);
      if (response.status === 404) return { providerOrderId: null, orderStatus: "NOT_FOUND", captures: [], refunds: [], absenceIsProof: true, observedAt: clock.now(), evidenceHash: sha256Hex(response.body) };
      if (response.status !== 200) return { providerOrderId: null, orderStatus: "UNRECOGNIZED", captures: [], refunds: [], absenceIsProof: false, observedAt: clock.now(), evidenceHash: sha256Hex(response.body) };
      return observationOf(response);
    },

    async observeRefund(ref) {
      if (!("providerRefundId" in ref)) return { kind: "NOT_FOUND" as const, absenceIsProof: false, evidenceHash: notLookedUp(ref.providerRequestId) };
      if (!ID.test(ref.providerRefundId)) throw new TypeError("a PayPal refund id");
      const response = await read(`/v2/payments/refunds/${ref.providerRefundId}`);
      if (response.status === 404) return { kind: "NOT_FOUND" as const, absenceIsProof: true, evidenceHash: sha256Hex(response.body) };
      const body = response.status === 200 ? parseObject(response.body) : null;
      const refund = body === null ? null : readRefund(body, { environment, evidenceHash: sha256Hex(response.body) });
      if (refund === null) throw new PayPalAdapterError("UNRECOGNIZED_PROVIDER_STATE", response.status);
      return refund;
    },

    classifyOrderObservation(stored: StoredEvidence): ProviderOrderObservation {
      const normalized = stored.normalized;
      if (stored.provider !== PAYPAL_PROVIDER || stored.environment !== environment || !("orderStatus" in normalized)) throw new TypeError("the stored evidence is not a PayPal order observation of this environment");
      return normalized;
    },
  };
}
