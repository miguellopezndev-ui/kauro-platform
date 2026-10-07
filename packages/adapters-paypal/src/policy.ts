/**
 * Versioned constants of the PayPal binding. Every value names its source; none is a tariff (A8: the fee of a capture is the one the
 * provider reports on that capture, `seller_receivable_breakdown.paypal_fee`, never a constant here).
 */
import type { PaymentEnvironment } from "@kauro/domain";

/**
 * Tolerance of PayPal's clock against the platform's (decision D-15: 10 s, symmetric). A provider instant is never compared with the
 * platform's clock without it: a webhook transmission time may lie up to `toleranceSeconds` in the future, and up to the freshness
 * window plus `toleranceSeconds` in the past. Owner decision D-15 places it in the commission policy; until that policy carries it,
 * this versioned constant is the single source the adapters read (B15-adapters.md, "Integración que pido a B" I-PP-5).
 */
export const PAYPAL_CLOCK_SKEW_POLICY = Object.freeze({
  id: "paypal.clock-skew",
  version: 1,
  toleranceSeconds: 10,
  decision: "D-15",
});

/** Freshness window of a webhook transmission (Q-B09-4; the same 300 s the contract fake applies). */
export const PAYPAL_WEBHOOK_FRESHNESS_SECONDS = 300;

/** The raw body bound of a webhook (the contract fake's 64 KiB; the route refuses a larger body before calling the verifier). */
export const PAYPAL_WEBHOOK_MAX_BODY_BYTES = 65_536;

/** The only signature algorithm PayPal documents for webhook transmissions (verify-webhook-signature `auth_algo`). */
export const PAYPAL_WEBHOOK_AUTH_ALGO = "SHA256withRSA";

/** A cached OAuth token is renewed this long before PayPal's `expires_in` ends (local clock only: never a provider instant). */
export const PAYPAL_TOKEN_RENEWAL_MARGIN_SECONDS = 60;

export interface PayPalEnvironmentProfile {
  /** REST API base (https://developer.paypal.com/api/rest/requests/ : api-m.sandbox.paypal.com / api-m.paypal.com). */
  readonly apiBase: string;
  /** Hosts of the buyer approval page the order's approve link may name. */
  readonly approvalHosts: ReadonlyArray<string>;
  /** Hosts a webhook's PAYPAL-CERT-URL may name for this environment (the other environment's hosts prove an environment mismatch). */
  readonly certHosts: ReadonlyArray<string>;
}

export const PAYPAL_ENVIRONMENTS: Readonly<Record<PaymentEnvironment, PayPalEnvironmentProfile>> = Object.freeze({
  SANDBOX: Object.freeze({
    apiBase: "https://api-m.sandbox.paypal.com",
    approvalHosts: Object.freeze(["www.sandbox.paypal.com"]),
    certHosts: Object.freeze(["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"]),
  }),
  LIVE: Object.freeze({
    apiBase: "https://api-m.paypal.com",
    approvalHosts: Object.freeze(["www.paypal.com"]),
    certHosts: Object.freeze(["api.paypal.com", "api-m.paypal.com"]),
  }),
});

/** The default credential reference (the same name the contract fake prepares; B decides the scheme, AWS-DELTA §2.6). */
export function defaultPayPalCredentialRef(environment: PaymentEnvironment): string {
  return `secret-manager://kauro/paypal/${environment.toLowerCase()}/client-credentials/v1`;
}
