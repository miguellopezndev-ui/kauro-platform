/**
 * The Vertex fetch transport (B04 D4-WIRE-1, D4-TX-1..4). A B03 `Transport`
 * over an injected `fetch`: it preflights and serializes the body once, writes
 * exactly those bytes at the one URL, hands the response body chunks to the
 * gateway undecoded (D3-PARSE-2), and classifies every failure as BEFORE_SEND,
 * AFTER_SEND or UNKNOWN. It never retries: the kernel's recovery rule and the
 * grant decide any second request. No SDK, no Google dependency, no network of
 * its own: the fetch and the token provider are injected.
 */
import { canonicalJson } from '../contracts/canonical.js';
import type { CandidateProfile } from '../gateway/candidates.js';
import { RESPONSE_BODY_MAX_BYTES, TransportError } from '../gateway/transport-gateway.js';
import type { ProviderRequest, ProviderResponse, Transport, TransportCorrelation } from '../gateway/transport-gateway.js';
import { allowedHeaders, redactedAuthorization, requestReceipt, responseReceipt } from './vertex-receipts.js';
import type { ReceiptSink } from './vertex-receipts.js';
import { dispatchVertex, toVertexBody } from './vertex-wire.js';

/** What the transport hands to fetch. The body is a stream so the transport can tell whether the provider began to read it. */
export interface VertexFetchInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
  readonly duplex: 'half';
  readonly redirect: 'error';
  readonly signal: AbortSignal;
}

type ByteReader = { getReader(): { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }> } };

/** The part of a fetch Response this transport reads. */
export interface VertexFetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null; forEach(callback: (value: string, key: string) => void): void };
  readonly body: ByteReader | AsyncIterable<Uint8Array> | null;
}

export type VertexFetch = (url: string, init: VertexFetchInit) => Promise<VertexFetchResponse>;

/** The credential source: injected, so the package carries no Google dependency. The token is never recorded. */
export type TokenProvider = () => Promise<{ readonly token: string; readonly expiresAt: string }>;

export interface VertexTransportOptions {
  readonly project: string;
  readonly profile: CandidateProfile;
  readonly tokenProvider: TokenProvider;
  readonly fetchImpl: VertexFetch;
  /** The host's protected receipt store; receipts are emitted here and nowhere else. */
  readonly sink?: ReceiptSink;
  readonly now?: () => number;
  /**
   * The host's last word on the exact bytes, after the preflight and before the token, the receipt and the fetch (the funded
   * runner's contamination scan, D4-CAMP-7). A throw refuses the request BEFORE_SEND: nothing is written.
   */
  readonly beforeSend?: (bytes: string, correlation: TransportCorrelation | null) => void;
}

/** The largest delay a timer takes without overflowing to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

const before = (message: string, code: string, cause?: unknown): TransportError => new TransportError('BEFORE_SEND', message, cause === undefined ? { code } : { code, cause });

/** Error codes a fetch raises while it is still connecting: no byte of the body can have left. */
const CONNECT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function codeOf(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current !== null && typeof current === 'object' && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

async function* chunksOf(body: VertexFetchResponse['body']): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ByteReader).getReader();
  for (;;) {
    const step = await reader.read();
    if (step.done) return;
    if (step.value !== undefined) yield step.value;
  }
}

/** retry-after as milliseconds: delta-seconds or an HTTP date; anything else is no advice. */
function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,7}$/u.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function vertexTransport(options: VertexTransportOptions): Transport {
  const now = options.now ?? Date.now;
  return async (request: ProviderRequest, deadlineAt: string, correlation?: TransportCorrelation): Promise<ProviderResponse> => {
    // Everything up to the fetch can be refused for free: nothing has been written.
    if (request.model !== options.profile.modelId) throw before(`the request names model ${request.model}, not the profile's ${options.profile.modelId}`, 'MODEL_NOT_PROFILE');
    const deadline = Date.parse(deadlineAt);
    if (Number.isNaN(deadline)) throw before('the deadline is not a date', 'DEADLINE_INVALID');
    if (deadline <= now()) throw before('the deadline has passed', 'DEADLINE_PASSED');
    const body = toVertexBody(request);
    let target: { readonly url: string; readonly bytes: string } | null = null;
    dispatchVertex(options.project, options.profile.modelId, body, (url, bytes) => { target = { url, bytes }; });
    if (target === null) throw before('the preflight produced no bytes', 'VERTEX_PREFLIGHT');
    const { url, bytes } = target as { readonly url: string; readonly bytes: string };
    if (bytes !== canonicalJson(body)) throw before('the bytes are not the canonical serialisation', 'VERTEX_PREFLIGHT');
    if (options.beforeSend !== undefined) {
      try {
        options.beforeSend(bytes, correlation ?? null);
      } catch (error) {
        throw before('the host refused the request before sending', 'HOST_REFUSED', error);
      }
    }
    let credential: { readonly token: string; readonly expiresAt: string };
    try {
      credential = await options.tokenProvider();
    } catch (error) {
      throw before('the token provider failed; its text is withheld', 'TOKEN_UNAVAILABLE', error);
    }
    const expires = Date.parse(credential.expiresAt);
    if (typeof credential.token !== 'string' || credential.token === '' || Number.isNaN(expires) || expires <= now()) throw before('the token is missing or expired', 'TOKEN_EXPIRED');
    const payload = Buffer.from(bytes, 'utf8');
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(payload.byteLength), authorization: `Bearer ${credential.token}` };
    const idempotencyRef = correlation?.idempotencyRef ?? null;
    const runId = correlation?.runId ?? null;
    // The receipt is emitted before the send, with the token redacted, and carries the exact bytes.
    options.sink?.(requestReceipt({ url, headers: { ...headers, authorization: redactedAuthorization(credential.token) }, bodyBytes: bytes, idempotencyRef, runId }));
    let started = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        started = true;
        controller.enqueue(payload);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const sentAt = now();
    let response: VertexFetchResponse;
    try {
      response = await options.fetchImpl(url, { method: 'POST', headers, body: stream, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(Math.min(MAX_TIMER_MS, Math.max(1, deadline - now()))) });
    } catch (error) {
      // Once the body stream was pulled the provider may have the request; before that only a connect-phase failure is provably free.
      const code = codeOf(error);
      if (started) throw new TransportError('AFTER_SEND', 'the connection failed after the request body started; billing is unknown', { code: code ?? 'FETCH_FAILED', cause: error });
      if (code !== null && CONNECT_CODES.has(code)) throw new TransportError('BEFORE_SEND', 'the connection could not be made; nothing was written', { code, cause: error });
      throw new TransportError('UNKNOWN', 'the fetch failed and the transport cannot say whether the request left', { code: code ?? 'FETCH_FAILED', cause: error });
    }
    const responseHeaders = allowedHeaders(response.headers);
    const status = response.status;
    if (status === 200) {
      // The chunks go to the gateway as they come; the receipt is emitted when the body ends or fails.
      const recorded: Uint8Array[] = [];
      let length = 0;
      let truncated = false;
      const emit = (): void => {
        options.sink?.(responseReceipt({ status, headers: responseHeaders, bodyText: Buffer.concat(recorded).toString('utf8'), bodyLength: length, truncated, latencyMs: Math.max(0, now() - sentAt), idempotencyRef, runId }));
      };
      async function* tee(): AsyncGenerator<Uint8Array> {
        try {
          for await (const chunk of chunksOf(response.body)) {
            recorded.push(chunk);
            length += chunk.byteLength;
            yield chunk;
          }
        } catch (error) {
          truncated = true;
          throw error;
        } finally {
          emit();
        }
      }
      return { status, bodyChunks: tee() };
    }
    // Any other status: the body is read only into the protected record; the response carries the status and the retry advice, never a word of the body.
    const recorded: Uint8Array[] = [];
    let length = 0;
    let truncated = false;
    try {
      for await (const chunk of chunksOf(response.body)) {
        length += chunk.byteLength;
        if (length > RESPONSE_BODY_MAX_BYTES) {
          truncated = true;
          break;
        }
        recorded.push(chunk);
      }
    } catch {
      truncated = true;
    }
    options.sink?.(responseReceipt({ status, headers: responseHeaders, bodyText: Buffer.concat(recorded).toString('utf8'), bodyLength: length, truncated, latencyMs: Math.max(0, now() - sentAt), idempotencyRef, runId }));
    return { status, retryAfterMs: retryAfterMs(response.headers.get('retry-after'), now()) };
  };
}
