/**
 * The HTTP transport every PayPal call goes through. It is injected (B15 rule: no runtime dependency, no network in tests): production
 * binds `fetchTransport()` over the platform's global fetch, tests bind a recorded wire. The transport never follows a redirect (a
 * provider answer is the answer of the host that was called) and classifies what it could not read into the three transport failures
 * the adapters map onto the port's AmbiguityReason; it never retries (a retry is the caller's decision, under the same request id).
 */

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Aborts the call at the caller's deadline; an aborted call is a TIMEOUT whose effect is unknown. */
  readonly signal: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The exact response bytes (their SHA-256 is the evidence hash). */
  readonly body: Uint8Array;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export type TransportFailureKind = "TIMEOUT" | "CONNECTION_RESET" | "UNREADABLE_RESPONSE";

/** A call whose outcome the transport could not read: never proof of no effect. */
export class TransportFailure extends Error {
  readonly kind: TransportFailureKind;
  constructor(kind: TransportFailureKind, options?: { readonly cause?: unknown }) {
    super(`provider transport failure: ${kind}`, options);
    this.name = "TransportFailure";
    this.kind = kind;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** The production transport over a fetch implementation (the global fetch by default). */
export function fetchTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return async (request) => {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        redirect: "error",
        signal: request.signal,
      });
    } catch (error) {
      throw new TransportFailure(isAbort(error) || request.signal.aborted ? "TIMEOUT" : "CONNECTION_RESET", { cause: error });
    }
    let body: Uint8Array;
    try {
      body = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new TransportFailure(isAbort(error) || request.signal.aborted ? "TIMEOUT" : "UNREADABLE_RESPONSE", { cause: error });
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, headers, body };
  };
}
