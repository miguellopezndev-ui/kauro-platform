/**
 * WebhookVerifier — CONTRACT_FAKE of the PayPal webhook verification contract (CMD030 precondition "Ingress authenticates
 * provider-specific signature, freshness, environment and bounded raw body before event acceptance"; 07 "A webhook is authenticated
 * before its content can establish authority"; decision D-FAKE-B1). Evidence class SIMULATED.
 *
 * The contract it keeps: the signature covers the exact raw bytes (an HMAC-SHA256 over the transmission id, the transmission time,
 * the environment's webhook id and the SHA-256 of the body — the shape of PayPal's signed string, with a shared secret standing in
 * for the provider's certificate chain), so a changed byte, header or environment fails; a transmission outside the freshness window
 * (Q-B09-4: 300 s by default) is stale; an event signed for the other environment's webhook is an environment mismatch, distinct
 * from a bad signature; a body beyond the bound is refused before anything is verified. A verified body is classified into the
 * normalized provider event (never the vendor schema): CHECKOUT.ORDER.APPROVED / VOIDED, PAYMENT.CAPTURE.COMPLETED / PENDING /
 * DENIED / REVERSED, PAYMENT.CAPTURE.REFUNDED (a refund), CUSTOMER.DISPUTE.CREATED / RESOLVED, and anything else UNRECOGNIZED.
 * A reversed capture's resource carries the reversal's times, not the completion's: its completion instant is unknown here (the
 * reconciler asks for a provider query, D-PAY-B6).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { UtcInstant } from "@kauro/contracts";
import type { Clock, NormalizedProviderEvent, ObservedCapture, ObservedDispute, ObservedRefund, PaymentEnvironment } from "@kauro/domain";
import type { WebhookVerification, WebhookVerifier } from "../ports.js";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, centsOf, instantOf, sha256Hex, type FakeCall } from "./labels.js";
import { PAYPAL_FAKE_PROVIDER } from "./paypal-fake.js";

export const PAYPAL_WEBHOOK_HEADERS = Object.freeze({
  transmissionId: "paypal-transmission-id",
  transmissionTime: "paypal-transmission-time",
  signature: "paypal-transmission-sig",
  algorithm: "paypal-auth-algo",
});

export interface WebhookVerifierFakeOptions {
  readonly clock: Clock;
  readonly environment?: PaymentEnvironment;
  /** The shared secret standing in for the provider's signing certificate (a test value, never a credential). */
  readonly secret?: string;
  /** The webhook ids registered per environment (PayPal registers one per application and environment). */
  readonly webhookIds?: Readonly<Record<PaymentEnvironment, string>>;
  readonly freshnessSeconds?: number;
  readonly maxBodyBytes?: number;
}

export interface WebhookVerifierFake extends WebhookVerifier {
  readonly integrationClass: typeof CONTRACT_FAKE;
  readonly evidenceClass: typeof FAKE_EVIDENCE_CLASS;
  readonly calls: ReadonlyArray<FakeCall>;
  /** Signs raw bytes as the provider would for `environment` (defaults to the verifier's) at `transmissionTime` (defaults to now). */
  sign(bytes: Uint8Array, options?: { readonly environment?: PaymentEnvironment; readonly transmissionTime?: UtcInstant; readonly transmissionId?: string }): Readonly<Record<string, string>>;
}

const CAPTURE_EVENTS: Readonly<Record<string, NormalizedProviderEvent["kind"]>> = Object.freeze({
  "PAYMENT.CAPTURE.COMPLETED": "CAPTURE_COMPLETED",
  "PAYMENT.CAPTURE.PENDING": "CAPTURE_PENDING",
  "PAYMENT.CAPTURE.DENIED": "CAPTURE_DENIED",
  "PAYMENT.CAPTURE.REVERSED": "CAPTURE_REVERSED",
});

type Json = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Classifies a verified PayPal webhook body into the normalized event (the adapter's `classify`; 10 "Provider adapter contract"). */
export function normalizePayPalWebhook(bytes: Uint8Array, environment: PaymentEnvironment): NormalizedProviderEvent | null {
  let body: Json | null;
  try {
    body = obj(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
  if (body === null) return null;
  const eventId = str(body["id"]);
  const eventType = str(body["event_type"]);
  const resource = obj(body["resource"]);
  if (eventId === null || eventType === null || resource === null) return null;
  const bodyHash = sha256Hex(bytes);
  const providerEventAt = instantOf(body["create_time"]);
  const base = { provider: PAYPAL_FAKE_PROVIDER, environment, externalEventId: eventId, bodyHash, ...(providerEventAt !== null ? { providerEventAt } : {}) };
  const amountOf = (v: unknown): { readonly cents: bigint; readonly currency: string } | null => {
    const a = obj(v);
    const cents = centsOf(a?.["value"]);
    const currency = str(a?.["currency_code"]);
    return cents === null || currency === null ? null : { cents, currency };
  };
  if (eventType === "CHECKOUT.ORDER.APPROVED" || eventType === "CHECKOUT.ORDER.VOIDED") {
    const id = str(resource["id"]);
    if (id === null) return null;
    return { ...base, kind: eventType === "CHECKOUT.ORDER.APPROVED" ? "ORDER_APPROVED" : "ORDER_VOIDED", providerOrderId: id };
  }
  const captureKind = CAPTURE_EVENTS[eventType];
  if (captureKind !== undefined) {
    const id = str(resource["id"]);
    const amount = amountOf(resource["amount"]);
    const merchant = str(obj(resource["payee"])?.["merchant_id"]);
    if (id === null || amount === null || merchant === null) return null;
    const status = captureKind === "CAPTURE_COMPLETED" ? "COMPLETED" : captureKind === "CAPTURE_PENDING" ? "PENDING" : captureKind === "CAPTURE_DENIED" ? "DENIED" : "REVERSED";
    const disbursement = str(resource["disbursement_mode"]);
    const fee = amountOf(obj(resource["seller_receivable_breakdown"])?.["paypal_fee"]);
    const relatedOrder = str(obj(obj(resource["supplementary_data"])?.["related_ids"])?.["order_id"]);
    const capture: ObservedCapture = {
      provider: PAYPAL_FAKE_PROVIDER,
      environment,
      providerOrderId: relatedOrder,
      providerCaptureId: id,
      status,
      amountCents: amount.cents,
      currency: amount.currency,
      payeeDigest: sha256Hex(merchant),
      // the completion instant of a COMPLETED capture is its last update; a reversal's resource does not carry it
      providerCompletedAt: status === "COMPLETED" ? instantOf(resource["update_time"]) : null,
      fundsState: disbursement === "INSTANT" ? "AVAILABLE" : disbursement === "DELAYED" ? "HELD" : "UNKNOWN",
      feeCents: fee?.cents ?? null,
      evidenceHash: bodyHash,
    };
    return { ...base, kind: captureKind, ...(relatedOrder !== null ? { providerOrderId: relatedOrder } : {}), capture };
  }
  if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
    const id = str(resource["id"]);
    const amount = amountOf(resource["amount"]);
    const links = Array.isArray(resource["links"]) ? (resource["links"] as unknown[]) : [];
    const up = links.map(obj).find((l) => l?.["rel"] === "up");
    const captureId = str(up?.["href"])?.split("/").pop() ?? null;
    const status = str(resource["status"]);
    if (id === null || amount === null || captureId === null || (status !== "COMPLETED" && status !== "PENDING" && status !== "FAILED")) return null;
    const refund: ObservedRefund = { provider: PAYPAL_FAKE_PROVIDER, environment, providerCaptureId: captureId, providerRefundId: id, status, amountCents: amount.cents, currency: amount.currency, evidenceHash: bodyHash };
    return { ...base, kind: status === "COMPLETED" ? "REFUND_COMPLETED" : status === "PENDING" ? "REFUND_PENDING" : "REFUND_FAILED", refund };
  }
  if (eventType === "CUSTOMER.DISPUTE.CREATED" || eventType === "CUSTOMER.DISPUTE.RESOLVED") {
    const id = str(resource["dispute_id"]);
    const amount = amountOf(resource["dispute_amount"]);
    const transactions = Array.isArray(resource["disputed_transactions"]) ? (resource["disputed_transactions"] as unknown[]) : [];
    const captureId = str(obj(transactions[0])?.["seller_transaction_id"]);
    if (id === null || amount === null || captureId === null) return null;
    const won = str(obj(resource["dispute_outcome"])?.["outcome_code"]) === "RESOLVED_SELLER_FAVOUR";
    if (eventType === "CUSTOMER.DISPUTE.RESOLVED" && !won) return { ...base, kind: "UNRECOGNIZED" };
    const reason = (str(resource["reason"]) ?? "DISPUTE").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 63);
    const dispute: ObservedDispute = {
      provider: PAYPAL_FAKE_PROVIDER,
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

export function createWebhookVerifierFake(options: WebhookVerifierFakeOptions): WebhookVerifierFake {
  const clock = options.clock;
  const environment = options.environment ?? "SANDBOX";
  const secret = options.secret ?? "contract-fake-webhook-signing-secret";
  const webhookIds = options.webhookIds ?? { SANDBOX: "WH-SANDBOX-CONTRACT-FAKE", LIVE: "WH-LIVE-CONTRACT-FAKE" };
  const freshnessSeconds = options.freshnessSeconds ?? 300;
  const maxBodyBytes = options.maxBodyBytes ?? 65_536;
  const calls: FakeCall[] = [];

  const mac = (transmissionId: string, transmissionTime: string, webhookId: string, bytes: Uint8Array): Buffer =>
    createHmac("sha256", secret).update(`${transmissionId}|${transmissionTime}|${webhookId}|${sha256Hex(bytes)}`).digest();

  const matches = (expected: Buffer, given: string): boolean => {
    const buf = Buffer.from(given, "base64");
    return buf.length === expected.length && timingSafeEqual(buf, expected);
  };

  return {
    provider: PAYPAL_FAKE_PROVIDER,
    environment,
    integrationClass: CONTRACT_FAKE,
    evidenceClass: FAKE_EVIDENCE_CLASS,
    maxBodyBytes,
    freshnessSeconds,
    get calls() {
      return calls;
    },

    async verify(raw): Promise<WebhookVerification> {
      const h = PAYPAL_WEBHOOK_HEADERS;
      const transmissionId = raw.headers[h.transmissionId];
      const transmissionTime = raw.headers[h.transmissionTime];
      const signature = raw.headers[h.signature];
      calls.push(Object.freeze({ port: "WebhookVerifier", operation: "VERIFY", identity: transmissionId ?? null, at: clock.now(), sent: true }));
      // a body beyond the bound is refused before it is verified (the route answers PROVIDER_BODY_TOO_LARGE before calling this)
      if (raw.bytes.byteLength > maxBodyBytes) return { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" };
      if (transmissionId === undefined || transmissionTime === undefined || signature === undefined || raw.headers[h.algorithm] !== "HMACSHA256") return { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" };
      const own = matches(mac(transmissionId, transmissionTime, webhookIds[environment], raw.bytes), signature);
      if (!own) {
        const other: PaymentEnvironment = environment === "LIVE" ? "SANDBOX" : "LIVE";
        return matches(mac(transmissionId, transmissionTime, webhookIds[other], raw.bytes), signature) ? { kind: "REJECTED", reason: "PROVIDER_ENVIRONMENT_MISMATCH" } : { kind: "REJECTED", reason: "PROVIDER_SIGNATURE_INVALID" };
      }
      const sent = Date.parse(transmissionTime);
      if (!Number.isFinite(sent) || Math.abs(Date.parse(raw.receivedAt) - sent) > freshnessSeconds * 1000) return { kind: "REJECTED", reason: "PROVIDER_EVENT_STALE" };
      const event = normalizePayPalWebhook(raw.bytes, environment);
      // a signed body the classifier cannot read is still authenticated: it is an unrecognized provider event, never coerced
      return { kind: "VERIFIED", event: event ?? { kind: "UNRECOGNIZED", provider: PAYPAL_FAKE_PROVIDER, environment, externalEventId: `UNREADABLE-${sha256Hex(raw.bytes).slice(0, 32)}`, bodyHash: sha256Hex(raw.bytes) } };
    },

    sign(bytes, opts = {}) {
      const env = opts.environment ?? environment;
      const transmissionId = opts.transmissionId ?? `tx-${sha256Hex(bytes).slice(0, 24)}`;
      const transmissionTime = opts.transmissionTime ?? clock.now();
      return Object.freeze({
        [PAYPAL_WEBHOOK_HEADERS.transmissionId]: transmissionId,
        [PAYPAL_WEBHOOK_HEADERS.transmissionTime]: transmissionTime,
        [PAYPAL_WEBHOOK_HEADERS.signature]: mac(transmissionId, transmissionTime, webhookIds[env], bytes).toString("base64"),
        [PAYPAL_WEBHOOK_HEADERS.algorithm]: "HMACSHA256",
      });
    },
  };
}
