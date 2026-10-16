/**
 * The Amazon Bedrock InvokeModel transport (B04 §4.1, owner decision A9). A B03
 * `Transport` over an injected `fetch`: it preflights and serializes the body
 * once, signs exactly those bytes with SigV4 (temporary credentials only,
 * never written), writes them at the one URL, hands the response body chunks
 * to the gateway undecoded (D3-PARSE-2), and classifies every failure as
 * BEFORE_SEND, AFTER_SEND or UNKNOWN. A non-200 answer carries its status, the
 * x-amzn-ErrorType class and the AWS request id, never a word of its body. It
 * never retries. No SDK, no AWS dependency, no network of its own.
 */
import { canonicalJson } from '../contracts/canonical.js';
import type { CandidateProfile } from '../gateway/candidates.js';
import { RESPONSE_BODY_MAX_BYTES, TransportError } from '../gateway/transport-gateway.js';
import type { ProviderRequest, ProviderResponse, Transport, TransportCorrelation } from '../gateway/transport-gateway.js';
import { allowedBedrockHeaders, redactedSecret, redactedSigV4 } from './bedrock-receipts.js';
import { amzDateOf, signV4 } from './bedrock-sigv4.js';
import { dispatchBedrock, toBedrockBody } from './bedrock-wire.js';
import { requestReceipt, responseReceipt } from './vertex-receipts.js';
import type { ReceiptSink } from './vertex-receipts.js';

export interface BedrockFetchInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
  readonly duplex: 'half';
  readonly redirect: 'error';
  readonly signal: AbortSignal;
}

type ByteReader = { getReader(): { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }> } };

export interface BedrockFetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null; forEach(callback: (value: string, key: string) => void): void };
  readonly body: ByteReader | AsyncIterable<Uint8Array> | null;
}

export type BedrockFetch = (url: string, init: BedrockFetchInit) => Promise<BedrockFetchResponse>;

/** Temporary credentials (STS / IAM Identity Center): a session token and an expiry are required; long-term keys are refused. */
export interface TemporaryCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
}

export type CredentialProvider = () => Promise<TemporaryCredentials>;

export interface BedrockTransportOptions {
  /** A US source region of the profile (us-east-1 unless probe P2 says us-west-2). */
  readonly region: string;
  readonly profile: CandidateProfile;
  readonly credentialProvider: CredentialProvider;
  readonly fetchImpl: BedrockFetch;
  /** The host's protected receipt store; receipts are emitted here and nowhere else. */
  readonly sink?: ReceiptSink;
  readonly now?: () => number;
  /** The host's last word on the exact bytes (the funded runner's contamination scan, D4-CAMP-7). A throw refuses BEFORE_SEND. */
  readonly beforeSend?: (bytes: string, correlation: TransportCorrelation | null) => void;
}

const MAX_TIMER_MS = 2_147_483_647;
/** Credentials that expire within this margin are not used: the request could outlive them mid-flight. */
const CREDENTIAL_MARGIN_MS = 60_000;

const before = (message: string, code: string, cause?: unknown): TransportError => new TransportError('BEFORE_SEND', message, cause === undefined ? { code } : { code, cause });

const CONNECT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function codeOf(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current !== null && typeof current === 'object' && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

async function* chunksOf(body: BedrockFetchResponse['body']): AsyncGenerator<Uint8Array> {
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

function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,7}$/u.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9]{0,63}(?::[\x21-\x7e]{0,200})?$/u;

export function bedrockTransport(options: BedrockTransportOptions): Transport {
  const now = options.now ?? Date.now;
  return async (request: ProviderRequest, deadlineAt: string, correlation?: TransportCorrelation): Promise<ProviderResponse> => {
    if (options.profile.provider !== 'AWS_BEDROCK') throw before(`the profile ${options.profile.profileId} is not served through Amazon Bedrock`, 'PROVIDER_NOT_BEDROCK');
    if (request.model !== options.profile.modelId) throw before(`the request names model ${request.model}, not the profile's ${options.profile.modelId}`, 'MODEL_NOT_PROFILE');
    const deadline = Date.parse(deadlineAt);
    if (Number.isNaN(deadline)) throw before('the deadline is not a date', 'DEADLINE_INVALID');
    if (deadline <= now()) throw before('the deadline has passed', 'DEADLINE_PASSED');
    const body = toBedrockBody(request);
    let target: { readonly url: string; readonly bytes: string } | null = null;
    dispatchBedrock(options.region, options.profile.inferenceProfileId, body, (url, bytes) => { target = { url, bytes }; });
    if (target === null) throw before('the preflight produced no bytes', 'BEDROCK_PREFLIGHT');
    const { url, bytes } = target as { readonly url: string; readonly bytes: string };
    if (bytes !== canonicalJson(body)) throw before('the bytes are not the canonical serialisation', 'BEDROCK_PREFLIGHT');
    if (options.beforeSend !== undefined) {
      try {
        options.beforeSend(bytes, correlation ?? null);
      } catch (error) {
        throw before('the host refused the request before sending', 'HOST_REFUSED', error);
      }
    }
    let credentials: TemporaryCredentials;
    try {
      credentials = await options.credentialProvider();
    } catch (error) {
      // The provider's text may carry a secret: it is withheld from the message and kept only as the cause.
      throw before('the credential provider failed; its text is withheld', 'CREDENTIALS_UNAVAILABLE', error);
    }
    const expires = Date.parse(credentials.expiresAt);
    if (typeof credentials.sessionToken !== 'string' || credentials.sessionToken === '') throw before('the credentials carry no session token: only temporary credentials are used', 'CREDENTIALS_NOT_TEMPORARY');
    if (Number.isNaN(expires) || expires - CREDENTIAL_MARGIN_MS <= now()) throw before('the credentials are expired or expire within the margin', 'CREDENTIALS_EXPIRED');
    const payload = Buffer.from(bytes, 'utf8');
    let signed: Readonly<Record<string, string>>;
    try {
      signed = signV4({ method: 'POST', url, headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(payload.byteLength) }, body: payload, credentials, region: options.region, service: 'bedrock', amzDate: amzDateOf(now()) }).headers;
    } catch (error) {
      throw before(`the request could not be signed (${error instanceof Error ? error.message.replace(/[^ -~]/gu, '').slice(0, 120) : 'error'})`, 'SIGV4_FAILED');
    }
    // fetch derives host from the URL, the same value that was signed.
    const { host: _host, ...headers } = signed;
    const idempotencyRef = correlation?.idempotencyRef ?? null;
    const runId = correlation?.runId ?? null;
    // The receipt is emitted before the send, with the authorization and the session token redacted, and carries the exact bytes.
    options.sink?.(requestReceipt({ url, headers: { ...headers, authorization: redactedSigV4(headers['authorization'] ?? ''), 'x-amz-security-token': redactedSecret(credentials.sessionToken) }, bodyBytes: bytes, idempotencyRef, runId }));
    let started = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        started = true;
        controller.enqueue(payload);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const sentAt = now();
    let response: BedrockFetchResponse;
    try {
      response = await options.fetchImpl(url, { method: 'POST', headers, body: stream, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(Math.min(MAX_TIMER_MS, Math.max(1, deadline - now()))) });
    } catch (error) {
      const code = codeOf(error);
      if (started) throw new TransportError('AFTER_SEND', 'the connection failed after the request body started; billing is unknown', { code: code ?? 'FETCH_FAILED', cause: error });
      if (code !== null && CONNECT_CODES.has(code)) throw new TransportError('BEFORE_SEND', 'the connection could not be made; nothing was written', { code, cause: error });
      throw new TransportError('UNKNOWN', 'the fetch failed and the transport cannot say whether the request left', { code: code ?? 'FETCH_FAILED', cause: error });
    }
    const responseHeaders = allowedBedrockHeaders(response.headers);
    const status = response.status;
    const requestIdHeader = response.headers.get('x-amzn-requestid');
    const requestId = requestIdHeader !== null && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(requestIdHeader) ? requestIdHeader : null;
    if (status === 200) {
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
      // The provider message id is read from the body by the gateway; the AWS request id is not passed as one.
      return { status, bodyChunks: tee() };
    }
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
    const errorType = response.headers.get('x-amzn-errortype');
    return { status, retryAfterMs: retryAfterMs(response.headers.get('retry-after'), now()), errorType: errorType !== null && ERROR_TYPE.test(errorType) ? errorType : null, requestId };
  };
}
