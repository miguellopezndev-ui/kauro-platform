/**
 * Authenticated calls to the PayPal REST API: the OAuth 2.0 client-credentials token (POST /v1/oauth2/token,
 * https://developer.paypal.com/api/rest/authentication/), cached per credential reference until `expires_in` minus a renewal margin
 * measured on the platform's own clock, and one renewal on a 401 (the same request, the same PayPal-Request-Id: a replay PayPal
 * answers idempotently). A credential is read from the injected source by its reference and never leaves this module: it is not
 * logged, not part of an error message and not part of a request hash (the hash carries the reference only).
 */
import type { Clock } from "@kauro/domain";
import { PayPalAdapterError } from "./errors.js";
import { PAYPAL_TOKEN_RENEWAL_MARGIN_SECONDS } from "./policy.js";
import { TransportFailure, type HttpResponse, type HttpTransport } from "./transport.js";
import { parseObject, str } from "./wire.js";

export interface PayPalClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Resolves a credential reference (a Secrets Manager name) into the client credentials; the deployment binds it (B15 live). */
export interface PayPalCredentialSource {
  read(credentialRef: string): Promise<PayPalClientCredentials>;
}

export interface PayPalCall {
  readonly method: "GET" | "POST";
  /** Path and query under the API base, e.g. /v2/checkout/orders/{id}. */
  readonly path: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentialRef: string;
  /** Epoch milliseconds after which nothing is sent and an in-flight call is aborted. */
  readonly deadlineMs: number;
}

export interface PayPalHttpClient {
  call(call: PayPalCall): Promise<HttpResponse>;
}

interface CachedToken {
  readonly token: string;
  readonly renewAtMs: number;
}

export function createPayPalHttpClient(options: { readonly apiBase: string; readonly transport: HttpTransport; readonly credentials: PayPalCredentialSource; readonly clock: Clock }): PayPalHttpClient {
  const { apiBase, transport, credentials, clock } = options;
  const tokens = new Map<string, CachedToken>();

  const signalUntil = (deadlineMs: number): AbortSignal => AbortSignal.timeout(Math.max(1, deadlineMs - clock.nowMs()));

  async function issueToken(credentialRef: string, deadlineMs: number): Promise<string> {
    const { clientId, clientSecret } = await credentials.read(credentialRef);
    const startedMs = clock.nowMs();
    let response: HttpResponse;
    try {
      response = await transport({
        method: "POST",
        url: `${apiBase}/v1/oauth2/token`,
        headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: "grant_type=client_credentials",
        signal: signalUntil(deadlineMs),
      });
    } catch (error) {
      throw new PayPalAdapterError("TOKEN_UNAVAILABLE", null, { cause: error instanceof TransportFailure ? error.kind : "TRANSPORT" });
    }
    if (response.status === 401 || response.status === 403) throw new PayPalAdapterError("CREDENTIAL_REJECTED", response.status);
    const body = response.status === 200 ? parseObject(response.body) : null;
    const token = str(body?.["access_token"]);
    const expiresIn = body?.["expires_in"];
    if (token === null || typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0 || str(body?.["token_type"])?.toLowerCase() !== "bearer") {
      throw new PayPalAdapterError("TOKEN_UNAVAILABLE", response.status);
    }
    // the lifetime counts from when the request was sent, on the platform's clock, minus the renewal margin
    tokens.set(credentialRef, { token, renewAtMs: startedMs + (expiresIn - PAYPAL_TOKEN_RENEWAL_MARGIN_SECONDS) * 1000 });
    return token;
  }

  async function tokenFor(credentialRef: string, deadlineMs: number): Promise<string> {
    const cached = tokens.get(credentialRef);
    if (cached !== undefined && clock.nowMs() < cached.renewAtMs) return cached.token;
    return issueToken(credentialRef, deadlineMs);
  }

  async function send(call: PayPalCall, token: string): Promise<HttpResponse> {
    return transport({
      method: call.method,
      url: `${apiBase}${call.path}`,
      headers: { ...(call.headers ?? {}), Authorization: `Bearer ${token}`, Accept: "application/json", ...(call.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(call.body !== undefined ? { body: call.body } : {}),
      signal: signalUntil(call.deadlineMs),
    });
  }

  return {
    async call(call) {
      const first = await send(call, await tokenFor(call.credentialRef, call.deadlineMs));
      if (first.status !== 401) return first;
      // an expired or revoked token: renew once and repeat the identical request (same PayPal-Request-Id)
      tokens.delete(call.credentialRef);
      if (clock.nowMs() >= call.deadlineMs) throw new TransportFailure("TIMEOUT");
      const second = await send(call, await issueToken(call.credentialRef, call.deadlineMs));
      if (second.status === 401) throw new PayPalAdapterError("CREDENTIAL_REJECTED", 401);
      return second;
    },
  };
}
