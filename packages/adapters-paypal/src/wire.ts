/**
 * Small, total readers of PayPal JSON. Each returns null for anything that is not exactly the documented shape; the classifiers turn a
 * null into UNRECOGNIZED, never into a default.
 */
import { createHash } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";

export type Json = Readonly<Record<string, unknown>>;

export const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
export const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
export const arr = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : []);

export function sha256Hex(data: string | Uint8Array): Sha256Hex {
  return createHash("sha256").update(data).digest("hex");
}

/** Two-decimal string of minor units (USD). */
export function decimalOf(cents: bigint): string {
  if (cents < 0n) throw new RangeError("an amount is non-negative");
  const s = cents.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/**
 * A provider USD amount as exact minor units: an integer or up to two decimals ("100.00", "10.99", and PayPal's documented "0" on a
 * refund's fee). Anything else (three decimals, exponent, sign, number type) is null: an amount is never rounded.
 */
export function centsOf(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,13})(\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(frac.padEnd(2, "0"));
}

/** A provider timestamp (RFC 3339) as the platform's canonical instant, or null. */
export function instantOf(value: unknown): UtcInstant | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function amountOf(v: unknown): { readonly cents: bigint; readonly currency: string } | null {
  const a = obj(v);
  const cents = centsOf(a?.["value"]);
  const currency = str(a?.["currency_code"]);
  return cents === null || currency === null || !/^[A-Z]{3}$/.test(currency) ? null : { cents, currency };
}

/** Parses exact UTF-8 JSON bytes into an object, or null. */
export function parseObject(bytes: Uint8Array): Json | null {
  try {
    return obj(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}

/** The href of the first HATEOAS link with one of the given relations. */
export function linkOf(resource: Json, rels: ReadonlyArray<string>): string | null {
  for (const l of arr(resource["links"])) {
    const link = obj(l);
    const rel = str(link?.["rel"]);
    if (rel !== null && rels.includes(rel)) return str(link?.["href"]);
  }
  return null;
}

/** The last path segment of a provider URL whose host is one of `hosts` (e.g. the capture id of a refund's `up` link). */
export function lastSegmentOn(href: string | null, hosts: ReadonlyArray<string>): string | null {
  if (href === null) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !hosts.includes(url.host)) return null;
  const segment = url.pathname.split("/").filter((s) => s.length > 0).pop() ?? null;
  return segment !== null && /^[A-Za-z0-9-]{1,64}$/.test(segment) ? segment : null;
}

/** A provider token (an issue or error name) as a server token `[A-Z0-9_]{3,63}`, or the fallback. */
export function tokenOf(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  const t = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 63);
  return /^[A-Z][A-Z0-9_]{2,62}$/.test(t) ? t : fallback;
}
