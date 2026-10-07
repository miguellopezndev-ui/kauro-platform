/**
 * WebhookVerifier — PROVIDER binding of PayPal webhook verification (CMD030 precondition "Ingress authenticates provider-specific
 * signature, freshness, environment and bounded raw body before event acceptance"; 07 "A webhook is authenticated before its content
 * can establish authority"). PayPal's own verdict decides the signature: POST /v1/notifications/verify-webhook-signature
 * (https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature_post, OpenAPI notifications_webhooks_v1, retrieved
 * 2026-10-07) with the transmission headers, the environment's webhook id and the event spliced in as its exact raw bytes (a re-encoded
 * event would not be the signed one).
 *
 * Order of the checks, kept identical to the contract fake so both bindings reject the same input with the same reason:
 *  1. a body beyond the bound → PROVIDER_SIGNATURE_INVALID (the route refuses it before calling this);
 *  2. a missing transmission header, or an algorithm other than SHA256withRSA → PROVIDER_SIGNATURE_INVALID;
 *  3. a PAYPAL-CERT-URL on the other environment's host → PROVIDER_ENVIRONMENT_MISMATCH; on any other host → PROVIDER_SIGNATURE_INVALID
 *     (the certificate is never fetched from an arbitrary origin);
 *  4. PayPal's verdict: FAILURE → PROVIDER_SIGNATURE_INVALID; anything but SUCCESS or FAILURE → a thrown VERIFICATION_UNAVAILABLE (the
 *     route answers 503 and PayPal redelivers; never accepted, never rejected on a guess);
 *  5. freshness with the clock-skew policy (D-15): stale when the transmission is older than the window plus the tolerance, or further
 *     in the future than the tolerance → PROVIDER_EVENT_STALE.
 * A verified body is classified into the normalized event; an authenticated body the classifier cannot read is UNRECOGNIZED.
 */
import type { WebhookVerification, WebhookVerifier } from "@kauro/application";
import type { Clock, NormalizedProviderEvent, ObservedDispute, PaymentEnvironment } from "@kauro/domain";
import { createPayPalHttpClient, type PayPalCredentialSource } from "./client.js";
import { PayPalAdapterError } from "./errors.js";
import { PAYPAL_PROVIDER, readCapture, readRefund } from "./normalize.js";
import { PAYPAL_CLOCK_SKEW_POLICY, PAYPAL_ENVIRONMENTS, PAYPAL_WEBHOOK_AUTH_ALGO, PAYPAL_WEBHOOK_FRESHNESS_SECONDS, PAYPAL_WEBHOOK_MAX_BODY_BYTES, defaultPayPalCredentialRef } from "./policy.js";
import { TransportFailure, type HttpResponse, type HttpTransport } from "./transport.js";
import { amountOf, arr, instantOf, obj, parseObject, sha256Hex, str } from "./wire.js";

export const PAYPAL_TRANSMISSION_HEADERS = Object.freeze({
  transmissionId: "paypal-transmission-id",
  transmissionTime: "paypal-transmission-time",
  signature: "paypal-transmission-sig",
  certUrl: "paypal-cert-url",
  algorithm: "paypal-auth-algo",
});

export interface PayPalWebhookVerifierOptions {
  readonly environment: PaymentEnvironment;
  /** The webhook id PayPal registered for this application and environment. */
  readonly webhookId: string;
  readonly transport: HttpTransport;
  readonly credentials: PayPalCredentialSource;
  readonly clock: Clock;
  readonly credentialRef?: string;
  readonly freshnessSeconds?: number;
  readonly maxBodyBytes?: number;
  /** Bound of the verification postback; 10 s by default. */
  readonly verificationTimeoutMs?: number;
}

export interface PayPalWebhookVerifier extends WebhookVerifier {
  readonly integrationClass: "PROVIDER";
}

const CAPTURE_EVENTS: Readonly<Record<string, { readonly kind: NormalizedProviderEvent["kind"]; readonly status: "COMPLETED" | "PENDING" | "DENIED" | "REVERSED" }>> = Object.freeze({
  "PAYMENT.CAPTURE.COMPLETED": { kind: "CAPTURE_COMPLETED", status: "COMPLETED" },
  "PAYMENT.CAPTURE.PENDING": { kind: "CAPTURE_PENDING", status: "PENDING" },
  "PAYMENT.CAPTURE.DENIED": { kind: "CAPTURE_DENIED", status: "DENIED" },
  "PAYMENT.CAPTURE.REVERSED": { kind: "CAPTURE_REVERSED", status: "REVERSED" },
});

/**
 * Classifies a verified PayPal webhook body (event names: https://developer.paypal.com/api/rest/webhooks/event-names/). The event type
 * decides the kind; the resource supplies the identities, amounts and times. Same mapping as the contract fake's classifier, over the
 * shared capture and refund readers.
 */
export function classifyPayPalWebhook(bytes: Uint8Array, environment: PaymentEnvironment): NormalizedProviderEvent | null {
  const body = parseObject(bytes);
  if (body === null) return null;
  const eventId = str(body["id"]);
  const eventType = str(body["event_type"]);
  const resource = obj(body["resource"]);
  if (eventId === null || eventType === null || resource === null) return null;
  const bodyHash = sha256Hex(bytes);
  const providerEventAt = instantOf(body["create_time"]);
  const base = { provider: PAYPAL_PROVIDER, environment, externalEventId: eventId, bodyHash, ...(providerEventAt !== null ? { providerEventAt } : {}) };
  if (eventType === "CHECKOUT.ORDER.APPROVED" || eventType === "CHECKOUT.ORDER.VOIDED") {
    const id = str(resource["id"]);
    return id === null ? null : { ...base, kind: eventType === "CHECKOUT.ORDER.APPROVED" ? "ORDER_APPROVED" : "ORDER_VOIDED", providerOrderId: id };
  }
  const captureEvent = CAPTURE_EVENTS[eventType];
  if (captureEvent !== undefined) {
    const read = readCapture(resource, { environment, evidenceHash: bodyHash, statusOverride: captureEvent.status });
    if (read.kind !== "CAPTURE") return null;
    return { ...base, kind: captureEvent.kind, ...(read.capture.providerOrderId !== null ? { providerOrderId: read.capture.providerOrderId } : {}), capture: read.capture };
  }
  if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
    const refund = readRefund(resource, { environment, evidenceHash: bodyHash });
    if (refund === null) return null;
    return { ...base, kind: refund.status === "COMPLETED" ? "REFUND_COMPLETED" : refund.status === "PENDING" ? "REFUND_PENDING" : "REFUND_FAILED", refund };
  }
  if (eventType === "CUSTOMER.DISPUTE.CREATED" || eventType === "CUSTOMER.DISPUTE.RESOLVED") {
    const id = str(resource["dispute_id"]);
    const amount = amountOf(resource["dispute_amount"]);
    const captureId = str(obj(arr(resource["disputed_transactions"])[0])?.["seller_transaction_id"]);
    if (id === null || amount === null || captureId === null) return null;
    const won = str(obj(resource["dispute_outcome"])?.["outcome_code"]) === "RESOLVED_SELLER_FAVOUR";
    if (eventType === "CUSTOMER.DISPUTE.RESOLVED" && !won) return { ...base, kind: "UNRECOGNIZED" };
    const reason = (str(resource["reason"]) ?? "DISPUTE").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 63);
    const dispute: ObservedDispute = {
      provider: PAYPAL_PROVIDER,
      environment,
      providerCaptureId: captureId,
      providerDisputeId: id,
      status: eventType === "CUSTOMER.DISPUTE.CREATED" ? "OPEN" : "CLOSED_WON",
      amountCents: amount.cents,
      currency: amount.currency,
      reasonCode: /^[A-Z][A-Z0-9_]{2,63}$/.test(reason) ? reason : "DISPUTE",
      responseDueAt: instantOf(resource["seller_response_due_date"]),
      evidenceHash: bodyHash,
    };
    return { ...base, kind: eventType === "CUSTOMER.DISPUTE.CREATED" ? "DISPUTE_OPENED" : "DISPUTE_CLOSED", dispute };
  }
  return { ...base, kind: "UNRECOGNIZED" };
}

/** Whether a transmission instant is fresh at `receivedAtMs` under the window and the D-15 tolerance (exported for the boundary tests). */
export function isFreshTransmission(transmissionMs: number, receivedAtMs: number, freshnessSeconds: number): boolean {
  if (!Number.isFinite(transmissionMs) || !Number.isFinite(receivedAtMs)) return false;
  const tolerance = PAYPAL_CLOCK_SKEW_POLICY.toleranceSeconds * 1000;
  const age = receivedAtMs - transmissionMs;
  return age <= freshnessSeconds * 1000 + tolerance && -age <= tolerance;
}

export function createPayPalWebhookVerifier(options: PayPalWebhookVerifierOptions): PayPalWebhookVerifier {
  const { environment, webhookId, clock } = options;
  if (!/^[A-Za-z0-9]{1,50}$/.test(webhookId)) throw new TypeError("a PayPal webhook id");
  const profile = PAYPAL_ENVIRONMENTS[environment];
  const otherHosts = PAYPAL_ENVIRONMENTS[environment === "LIVE" ? "SANDBOX" : "LIVE"].certHosts;
  const credentialRef = options.credentialRef ?? defaultPayPalCredentialRef(environment);
  const freshnessSeconds = options.freshnessSeconds ?? PAYPAL_WEBHOOK_FRESHNESS_SECONDS;
  const maxBodyBytes = options.maxBodyBytes ?? PAYPAL_WEBHOOK_MAX_BODY_BYTES;
  const verificationTimeoutMs = options.verificationTimeoutMs ?? 10_000;
  const client = createPayPalHttpClient({ apiBase: profile.apiBase, transport: options.transport, credentials: options.credentials, clock });
  const invalid: WebhookVerification = { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" };

  async function verdict(fields: Readonly<Record<string, string>>, bytes: Uint8Array): Promise<"SUCCESS" | "FAILURE"> {
    // the event goes in as its exact bytes: the signature PayPal checks covers them, not a re-encoding
    const head = JSON.stringify({ ...fields, webhook_id: webhookId });
    const body = `${head.slice(0, -1)},"webhook_event":${new TextDecoder("utf-8", { fatal: true }).decode(bytes)}}`;
    let response: HttpResponse;
    try {
      response = await client.call({ method: "POST", path: "/v1/notifications/verify-webhook-signature", body, credentialRef, deadlineMs: clock.nowMs() + verificationTimeoutMs });
    } catch (error) {
      if (error instanceof TransportFailure) throw new PayPalAdapterError("VERIFICATION_UNAVAILABLE", null, { cause: error.kind });
      throw error;
    }
    const status = response.status === 200 ? str(parseObject(response.body)?.["verification_status"]) : null;
    if (status === "SUCCESS" || status === "FAILURE") return status;
    throw new PayPalAdapterError("VERIFICATION_UNAVAILABLE", response.status);
  }

  return {
    provider: PAYPAL_PROVIDER,
    environment,
    integrationClass: "PROVIDER",
    maxBodyBytes,
    freshnessSeconds,

    async verify(raw): Promise<WebhookVerification> {
      const h = PAYPAL_TRANSMISSION_HEADERS;
      if (raw.bytes.byteLength > maxBodyBytes) return invalid;
      const transmissionId = raw.headers[h.transmissionId];
      const transmissionTime = raw.headers[h.transmissionTime];
      const signature = raw.headers[h.signature];
      const certUrl = raw.headers[h.certUrl];
      if (transmissionId === undefined || transmissionTime === undefined || signature === undefined || certUrl === undefined || raw.headers[h.algorithm] !== PAYPAL_WEBHOOK_AUTH_ALGO) return invalid;
      let certHost: string;
      try {
        const url = new URL(certUrl);
        if (url.protocol !== "https:") return invalid;
        certHost = url.host;
      } catch {
        return invalid;
      }
      if (!profile.certHosts.includes(certHost)) return otherHosts.includes(certHost) ? { kind: "REJECTED", reason: "PROVIDER_ENVIRONMENT_MISMATCH" } : invalid;
      if (parseObject(raw.bytes) === null) return invalid;
      const result = await verdict({ auth_algo: PAYPAL_WEBHOOK_AUTH_ALGO, cert_url: certUrl, transmission_id: transmissionId, transmission_sig: signature, transmission_time: transmissionTime }, raw.bytes);
      if (result === "FAILURE") return invalid;
      if (!isFreshTransmission(Date.parse(transmissionTime), Date.parse(raw.receivedAt), freshnessSeconds)) return { kind: "REJECTED", reason: "PROVIDER_EVENT_STALE" };
      const event = classifyPayPalWebhook(raw.bytes, environment);
      // a signed body the classifier cannot read is still authenticated: it is an unrecognized provider event, never coerced
      return { kind: "VERIFIED", event: event ?? { kind: "UNRECOGNIZED", provider: PAYPAL_PROVIDER, environment, externalEventId: `UNREADABLE-${sha256Hex(raw.bytes).slice(0, 32)}`, bodyHash: sha256Hex(raw.bytes) } };
    },
  };
}
