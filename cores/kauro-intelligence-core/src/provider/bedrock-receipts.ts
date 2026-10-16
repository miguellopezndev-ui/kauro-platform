/**
 * The Bedrock half of the receipts (B04 §4.1, D4-RCPT-1..4). The receipt
 * records themselves are the Vertex module's (one protected form, one public
 * projection); this module adds what Bedrock says outside the body: the
 * x-amzn-* headers it keeps, the redaction of a SigV4 authorization and a
 * session token, the token counts Bedrock reports in headers, and the
 * reconciliation by the msg_bdrk id and x-amzn-requestid. Pure and offline.
 */
import { PROVIDER_MESSAGE_ID } from './vertex-receipts.js';
import type { ProtectedReceipt, ResponseReceipt } from './vertex-receipts.js';

const HEADER_ALLOW = /^(?:content-type|content-length|retry-after|date|x-amzn-requestid|x-amzn-errortype|x-amzn-bedrock-input-token-count|x-amzn-bedrock-output-token-count|x-amzn-bedrock-invocation-latency)$/u;

/** The response headers the receipt keeps: a short allowlist of the documented x-amzn-* ones, verbatim; cookies and the rest are dropped. */
export function allowedBedrockHeaders(headers: { forEach(callback: (value: string, key: string) => void): void }): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (HEADER_ALLOW.test(name)) out[name] = value;
  });
  return out;
}

/** The authorization is never recorded, not even the access key id or the signature: the receipt says how many bytes it had. */
export function redactedSigV4(authorization: string): string {
  return `AWS4-HMAC-SHA256 <redacted, ${String(Buffer.byteLength(authorization, 'utf8'))} bytes>`;
}

export function redactedSecret(secret: string): string {
  return `<redacted, ${String(Buffer.byteLength(secret, 'utf8'))} bytes>`;
}

const COUNT = /^(?:0|[1-9][0-9]{0,8})$/u;

/** The token counts Bedrock reports in headers; null when either is missing or not a plain count. */
export function headerUsage(headers: Readonly<Record<string, string>>): { readonly inputTokens: number; readonly outputTokens: number } | null {
  const input = headers['x-amzn-bedrock-input-token-count'];
  const output = headers['x-amzn-bedrock-output-token-count'];
  if (input === undefined || output === undefined || !COUNT.test(input.trim()) || !COUNT.test(output.trim())) return null;
  return { inputTokens: Number(input.trim()), outputTokens: Number(output.trim()) };
}

/** The AWS request id of a response receipt, when it is of the id alphabet. */
export function awsRequestIdOf(receipt: ResponseReceipt): string | null {
  const id = receipt.headers['x-amzn-requestid'];
  return id !== undefined && PROVIDER_MESSAGE_ID.test(id) ? id : null;
}

/** The documented throttling class of a Bedrock response, cut at its first ':'; null when the header is absent. */
export function bedrockErrorTypeOf(receipt: ResponseReceipt): string | null {
  const raw = receipt.headers['x-amzn-errortype'];
  if (raw === undefined || raw === '') return null;
  return raw.split(':')[0] ?? null;
}

export interface BedrockReconciliation {
  readonly idempotencyRef: string;
  readonly requests: number;
  readonly responses: number;
  /** The msg_bdrk id of the answer that arrived under this ref, or null when none did. */
  readonly providerMessageId: string | null;
  /** The x-amzn-requestid of that answer, or of the last response when no answer arrived. */
  readonly awsRequestId: string | null;
}

/** Matches receipts to a journal entry by its idempotency ref (D4-RCPT-4). Bedrock documents no idempotency key: this is the core's own ref. */
export function reconcileBedrock(receipts: readonly ProtectedReceipt[], idempotencyRef: string): BedrockReconciliation {
  const mine = receipts.filter((receipt) => receipt.idempotencyRef === idempotencyRef);
  const responses = mine.filter((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE');
  const answers = responses.filter((receipt) => receipt.status === 200 && receipt.providerMessageId !== null && PROVIDER_MESSAGE_ID.test(receipt.providerMessageId));
  const last = answers[answers.length - 1] ?? responses[responses.length - 1];
  return { idempotencyRef, requests: mine.filter((receipt) => receipt.kind === 'REQUEST').length, responses: responses.length, providerMessageId: answers[answers.length - 1]?.providerMessageId ?? null, awsRequestId: last === undefined ? null : awsRequestIdOf(last) };
}

/** The documented throttling class this reconciliation may release on, with its documentation reference (manual 06 l.182). */
export const BEDROCK_DOCUMENTED_THROTTLING = Object.freeze({ ThrottlingException: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html#API_runtime_InvokeModel_Errors' } as const);

export type HoldReconciliation =
  | { readonly decision: 'RELEASE'; readonly reason: string; readonly awsRequestId: string | null }
  | { readonly decision: 'KEEP_AMBIGUOUS'; readonly reason: string };

/**
 * G23: a hold left AMBIGUOUS by a crash before its settlement, decided from the protected receipts alone. It is released only when
 * the receipts prove the provider's documented non-acceptance: exactly one request under the ref, and its one response a 429 whose
 * x-amzn-ErrorType is ThrottlingException, whose body was read whole and that reports no usage. Anything else (no response, two
 * requests, a 200, another 429 class, a truncated body, a usage member) keeps the hold AMBIGUOUS: unknown is never free.
 */
export function reconcileAmbiguousHold(receipts: readonly ProtectedReceipt[], idempotencyRef: string): HoldReconciliation {
  const mine = receipts.filter((receipt) => receipt.idempotencyRef === idempotencyRef);
  const requests = mine.filter((receipt) => receipt.kind === 'REQUEST');
  const responses = mine.filter((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE');
  if (requests.length !== 1 || responses.length !== 1) return { decision: 'KEEP_AMBIGUOUS', reason: `${String(requests.length)} requests and ${String(responses.length)} responses under the ref; only one request answered once proves anything` };
  const response = responses[0] as ResponseReceipt;
  if (response.status !== 429) return { decision: 'KEEP_AMBIGUOUS', reason: `the response is status ${String(response.status)}, not a 429` };
  if (response.truncated) return { decision: 'KEEP_AMBIGUOUS', reason: 'the 429 body was not read whole' };
  const type = bedrockErrorTypeOf(response);
  if (type === null || !Object.hasOwn(BEDROCK_DOCUMENTED_THROTTLING, type)) return { decision: 'KEEP_AMBIGUOUS', reason: `the 429 error type ${String(type)} is not the documented throttling class` };
  let usage = false;
  try {
    const body: unknown = JSON.parse(response.bodyText);
    usage = body !== null && typeof body === 'object' && 'usage' in body;
  } catch {
    usage = false;
  }
  if (usage || headerUsage(response.headers) !== null) return { decision: 'KEEP_AMBIGUOUS', reason: 'the 429 names usage in its body or its token-count headers' };
  return { decision: 'RELEASE', reason: `PROVIDER_DOCUMENTED_NON_ACCEPTANCE:${BEDROCK_DOCUMENTED_THROTTLING.ThrottlingException}`, awsRequestId: awsRequestIdOf(response) };
}
