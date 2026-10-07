/**
 * @kauro/adapters-paypal — the PROVIDER bindings of the PayPal ports (package B15). Evidence class: what these adapters prove in this
 * repository's tests is EXECUTED_LOCAL against a recorded wire built from PayPal's official API examples; EXECUTED_PROVIDER needs the
 * live sandbox run (KAURO_LIVE_SANDBOX=1, B only).
 */
export { createPayPalOrdersAdapter, type PayPalOrdersAdapter, type PayPalOrdersAdapterOptions, type PayPalEndpointProfile } from "./orders-adapter.js";
export { createPayPalWebhookVerifier, classifyPayPalWebhook, isFreshTransmission, PAYPAL_TRANSMISSION_HEADERS, type PayPalWebhookVerifier, type PayPalWebhookVerifierOptions } from "./webhook-verifier.js";
export { createPayPalHttpClient, type PayPalClientCredentials, type PayPalCredentialSource, type PayPalHttpClient, type PayPalCall } from "./client.js";
export { PayPalAdapterError, type PayPalAdapterErrorCode } from "./errors.js";
export { fetchTransport, TransportFailure, type HttpRequest, type HttpResponse, type HttpTransport, type TransportFailureKind } from "./transport.js";
export { PAYPAL_PROVIDER } from "./normalize.js";
export {
  PAYPAL_CLOCK_SKEW_POLICY,
  PAYPAL_ENVIRONMENTS,
  PAYPAL_TOKEN_RENEWAL_MARGIN_SECONDS,
  PAYPAL_WEBHOOK_AUTH_ALGO,
  PAYPAL_WEBHOOK_FRESHNESS_SECONDS,
  PAYPAL_WEBHOOK_MAX_BODY_BYTES,
  defaultPayPalCredentialRef,
  type PayPalEnvironmentProfile,
} from "./policy.js";
