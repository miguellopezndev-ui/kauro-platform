/**
 * Domain-separated digests (authority: reference/HASHING_AND_ACCOUNTING_RULES.md).
 *
 * Every structured digest is SHA-256 over the UTF-8 bytes of a closed wrapper {domain, version, payload} serialized under the
 * canonical profile. The domain string prevents the same bytes from being read as another authority class. A raw file hash is
 * SHA-256 over the file bytes (domain RAW_BYTES) and is never interchangeable with a structured digest.
 *
 * Brand note: the R2 text names the domains KAVO_*; the product is Kauro and every identifier this platform emits is KAURO_*
 * (amendment A2, docs/BRAND_AMENDMENT_A2.md). The mapping is one-to-one and recorded in DOMAINS.
 */
import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";

export const DOMAINS = {
  RAW_BYTES: "RAW_BYTES",
  SOURCE_REVISION: "KAURO_SOURCE_REVISION_V1",
  TARGET_BODY: "KAURO_TARGET_BODY_V1",
  PLAN_BODY: "KAURO_PLAN_BODY_V1",
  CONFIG_FRAGMENT: "KAURO_CONFIG_FRAGMENT_V1",
  DECISION_EVIDENCE: "KAURO_DECISION_EVIDENCE_V1",
  PLAN_APPROVAL: "KAURO_PLAN_APPROVAL_V1",
  PROVIDER_REQUEST: "KAURO_PROVIDER_REQUEST_V1",
  QUOTE_TERMS: "KAURO_QUOTE_TERMS_V1",
  DELIVERY_MANIFEST: "KAURO_DELIVERY_MANIFEST_V1",
  REPORT_MODEL: "KAURO_REPORT_MODEL_V1",
  STAGE_IDENTITY_MAPPING: "KAURO_STAGE_IDENTITY_MAPPING_V1",
  STAGE_CORRELATION: "KAURO_STAGE_CORRELATION_V1",
} as const;

export type DigestDomain = (typeof DOMAINS)[keyof typeof DOMAINS];

/** The R2 (KAVO_*) domain names and their Kauro equivalents, for readers of the authority text. */
export const R2_DOMAIN_ALIASES: Readonly<Record<string, DigestDomain>> = Object.freeze({
  KAVO_SOURCE_REVISION_V1: DOMAINS.SOURCE_REVISION,
  KAVO_TARGET_BODY_V1: DOMAINS.TARGET_BODY,
  KAVO_PLAN_BODY_V1: DOMAINS.PLAN_BODY,
  KAVO_CONFIG_FRAGMENT_V1: DOMAINS.CONFIG_FRAGMENT,
  KAVO_DECISION_EVIDENCE_V1: DOMAINS.DECISION_EVIDENCE,
  KAVO_PLAN_APPROVAL_V1: DOMAINS.PLAN_APPROVAL,
  KAVO_PROVIDER_REQUEST_V1: DOMAINS.PROVIDER_REQUEST,
  KAVO_QUOTE_TERMS_V1: DOMAINS.QUOTE_TERMS,
  KAVO_DELIVERY_MANIFEST_V1: DOMAINS.DELIVERY_MANIFEST,
});

const HEX64 = /^[0-9a-f]{64}$/;

export function isSha256Hex(s: unknown): s is string {
  return typeof s === "string" && HEX64.test(s);
}

/** Exact preimage bytes of a structured digest: the closed wrapper under the canonical profile. */
export function structuredPreimage(domain: DigestDomain, version: number, payload: unknown): Uint8Array {
  if (domain === DOMAINS.RAW_BYTES) throw new TypeError("RAW_BYTES digests are over file bytes, not a structured wrapper");
  if (!Number.isInteger(version) || version < 1) throw new TypeError("version must be a positive integer");
  return canonicalBytes({ domain, version, payload });
}

/** SHA-256 (lowercase hex) of a structured payload under its domain. */
export function structuredDigest(domain: DigestDomain, version: number, payload: unknown): string {
  return createHash("sha256").update(structuredPreimage(domain, version, payload)).digest("hex");
}

/** SHA-256 (lowercase hex) over raw bytes — file contents, archive bytes, stored artifacts. */
export function rawDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Constant-time comparison of two hex digests (both must be well-formed). */
export function digestEquals(a: string, b: string): boolean {
  if (!isSha256Hex(a) || !isSha256Hex(b)) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
