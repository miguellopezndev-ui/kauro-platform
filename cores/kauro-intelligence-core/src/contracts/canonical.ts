/**
 * Canonical serialisation and digests.
 *
 * Every hash in this core is over the same bytes: JSON with object keys sorted
 * by code point, no whitespace, no undefined, finite numbers only, strings as
 * JSON escapes them. Two producers that agree on the value agree on the
 * digest; a value that cannot be serialised this way — a NaN, a cycle, a
 * bigint, a function — is refused rather than stringified as something else.
 */
import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalError(`${path} is not a finite number`);
      if (Object.is(value, -0)) return '0';
      return JSON.stringify(value);
    case 'undefined':
      throw new CanonicalError(`${path} is undefined; a canonical value has no undefined members`);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new CanonicalError(`${path} is a ${typeof value}, which has no canonical form`);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalJson(entry, `${path}[${String(index)}]`)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const proto = Object.getPrototypeOf(record) as unknown;
  if (proto !== Object.prototype && proto !== null) throw new CanonicalError(`${path} is not a plain object`);
  const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const members: string[] = [];
  for (const key of keys) {
    const member = record[key];
    if (member === undefined) continue;
    members.push(`${JSON.stringify(key)}:${canonicalJson(member, `${path}.${key}`)}`);
  }
  return `{${members.join(',')}}`;
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The digest of a value's canonical form. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** A stable reference: a prefix and the first sixteen hex characters of a digest. */
export function stableRef(prefix: string, value: unknown): string {
  return `${prefix}_${digestOf(value).slice(0, 16)}`;
}

export const HEX64 = /^[0-9a-f]{64}$/u;
export const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
