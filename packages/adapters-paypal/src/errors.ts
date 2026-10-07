/**
 * The typed errors of the PayPal binding (B15 rule 6, N13/R23: an error is never logged and swallowed; it is thrown with a catalogued
 * code, or returned as a typed port result). Every code is a state in which the adapter has no authenticated provider answer to give:
 * the caller keeps the attempt in its ambiguous path (the dispatch watchdog, then an observation) and never reads it as no effect.
 */

export type PayPalAdapterErrorCode =
  /** PayPal refused the client credentials (401 after one renewal of the token) or the token endpoint did. */
  | "CREDENTIAL_REJECTED"
  /** The OAuth token endpoint did not issue a token (transport failure, 5xx, unreadable answer): nothing was sent to the target. */
  | "TOKEN_UNAVAILABLE"
  /** The credentials are valid but lack the permission for this call (403). */
  | "PERMISSION_DENIED"
  /** A previous request with the same PayPal-Request-Id is still being processed (409): its effect is unknown. */
  | "REQUEST_IN_PROGRESS"
  /** PayPal rate-limited the call (429): not processed, retriable under the same request id. */
  | "RATE_LIMITED"
  /** An observation (a read) could not be completed: a transport failure or a 5xx of a GET. */
  | "OBSERVATION_FAILED"
  /** A provider state the port's result type cannot express (e.g. a CANCELLED refund on observeRefund): never coerced. */
  | "UNRECOGNIZED_PROVIDER_STATE"
  /** The webhook verification postback did not answer SUCCESS or FAILURE (a transport failure, a non-200). */
  | "VERIFICATION_UNAVAILABLE"
  /** The request handed to dispatch is not one this adapter prepared (no request id, an unknown endpoint profile). */
  | "INVALID_REQUEST";

export class PayPalAdapterError extends Error {
  readonly code: PayPalAdapterErrorCode;
  /** The HTTP status that produced the error, when one did. */
  readonly httpStatus: number | null;
  constructor(code: PayPalAdapterErrorCode, httpStatus: number | null = null, options?: { readonly cause?: unknown }) {
    super(`PayPal adapter: ${code}${httpStatus !== null ? ` (HTTP ${httpStatus})` : ""}`, options);
    this.name = "PayPalAdapterError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
