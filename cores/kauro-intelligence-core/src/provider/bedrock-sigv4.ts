/**
 * AWS Signature Version 4, in house over node:crypto (B04 §4.1, as D4-WIRE-1:
 * no SDK). Pure: the caller hands the time, the credentials and the exact
 * body bytes; nothing is read from the environment and nothing is written.
 * The canonical URI of a non-S3 service is the request path URI-encoded once
 * more, segment by segment (a profile id `...-v1:0` travels as `%3A` and is
 * signed as `%253A`).
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The session token of temporary credentials; null only for the documented test vector. */
  readonly sessionToken: string | null;
}

export interface SignedRequest {
  /** The headers to send: the caller's, plus host, x-amz-date, x-amz-security-token (when temporary) and authorization. */
  readonly headers: Readonly<Record<string, string>>;
  readonly canonicalRequestSha256: string;
  readonly signature: string;
  readonly signedHeaders: string;
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as SigV4 defines it: every byte but the unreserved set is %XX, upper case. */
function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The path as sent, each segment encoded once more (non-S3 services). */
export function canonicalUri(path: string): string {
  if (path === '' || path === '/') return '/';
  return path.split('/').map((segment) => uriEncode(segment)).join('/');
}

function canonicalQuery(search: URLSearchParams): string {
  const pairs = [...search.entries()].map(([key, value]) => [uriEncode(key), uriEncode(value)] as const);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

/** yyyyMMddTHHmmssZ of an instant. */
export function amzDateOf(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error('sigv4: the signing time is not a time');
  return new Date(ms).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
}

const AMZ_DATE = /^\d{8}T\d{6}Z$/u;
const ACCESS_KEY = /^[A-Z0-9]{8,128}$/u;
const SCOPE_WORD = /^[a-z0-9-]{1,64}$/u;

export function signV4(input: {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
  readonly credentials: AwsCredentials;
  readonly region: string;
  readonly service: string;
  readonly amzDate: string;
}): SignedRequest {
  const { credentials } = input;
  if (!AMZ_DATE.test(input.amzDate)) throw new Error('sigv4: the signing time is not yyyyMMddTHHmmssZ');
  if (!ACCESS_KEY.test(credentials.accessKeyId)) throw new Error('sigv4: the access key id is not of the AWS alphabet');
  if (typeof credentials.secretAccessKey !== 'string' || credentials.secretAccessKey === '') throw new Error('sigv4: no secret access key');
  if (!SCOPE_WORD.test(input.region) || !SCOPE_WORD.test(input.service)) throw new Error('sigv4: the region or service is not a scope word');
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') throw new Error('sigv4: only a plain https URL is signed');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    const key = name.toLowerCase();
    if (key === 'authorization' || key === 'x-amz-date' || key === 'x-amz-security-token' || key === 'host') throw new Error(`sigv4: the caller may not set ${key}`);
    headers[key] = value;
  }
  headers['host'] = url.host;
  headers['x-amz-date'] = input.amzDate;
  if (credentials.sessionToken !== null) headers['x-amz-security-token'] = credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${(headers[name] ?? '').trim().replace(/\s+/gu, ' ')}\n`).join('');
  const canonicalRequest = [input.method.toUpperCase(), canonicalUri(url.pathname), canonicalQuery(url.searchParams), canonicalHeaders, signedHeaders, sha256(input.body)].join('\n');
  const canonicalRequestSha256 = sha256(canonicalRequest);
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, canonicalRequestSha256].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequestSha256, signature, signedHeaders };
}
