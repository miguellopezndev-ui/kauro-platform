/**
 * Canonical agreement and the identity bridge (B05 D5-3, S047; HASHING "Hash domain separation").
 *
 * The platform profile (`@kauro/contracts` canonicalize) and Intelligence Core's `canonicalJson` are two serializers. They give the
 * same bytes for the values the platform hashes structurally only when no member needs a rule they decide differently: IC orders
 * keys by UTF-16 unit, silently drops undefined members and accepts unsafe integers and lone surrogates; the platform orders by
 * code point and refuses the other three. `assertCanonicalAgreement` serializes under both and refuses unless both succeed and
 * the bytes are equal, so there are never two silent digests for one value.
 *
 * Three identity classes never convert into each other: RAW_BYTES (sha256 of bytes), CORE_NATIVE (a hash only the core's own
 * loader reproduces) and PLATFORM (a structured digest the platform computes). A platform record that cites a core identity
 * carries it as a string and never re-hashes it.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "@kauro/contracts";
import { canonicalJson } from "kauro-intelligence-core";

export class CanonicalAgreementError extends Error {
  readonly reason: "PLATFORM_REFUSED" | "CORE_REFUSED" | "BYTES_DIFFER";
  constructor(reason: CanonicalAgreementError["reason"], detail: string) {
    super(`canonical agreement refused (${reason}): ${detail}`);
    this.name = "CanonicalAgreementError";
    this.reason = reason;
  }
}

export class IdentityBridgeError extends Error {
  readonly from: IdentityClass;
  readonly to: IdentityClass;
  constructor(from: IdentityClass, to: IdentityClass, detail: string) {
    super(`identity bridge refused ${from} -> ${to}: ${detail}`);
    this.name = "IdentityBridgeError";
    this.from = from;
    this.to = to;
  }
}

export type IdentityClass = "RAW_BYTES" | "CORE_NATIVE" | "PLATFORM";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** The canonical text of a value both serializers agree on; throws CanonicalAgreementError otherwise (fail closed). */
export function assertCanonicalAgreement(value: unknown): string {
  let platform: string;
  try {
    platform = canonicalize(value);
  } catch (error) {
    throw new CanonicalAgreementError("PLATFORM_REFUSED", messageOf(error));
  }
  let core: string;
  try {
    core = canonicalJson(value);
  } catch (error) {
    throw new CanonicalAgreementError("CORE_REFUSED", messageOf(error));
  }
  if (platform !== core) throw new CanonicalAgreementError("BYTES_DIFFER", "the platform profile and the core's canonicalJson serialize this value differently");
  return platform;
}

/** sha256 hex of a value's agreed canonical bytes: the PLATFORM class for values built from IC output. */
export function platformDigestOfAgreed(value: unknown): string {
  return createHash("sha256").update(assertCanonicalAgreement(value), "utf8").digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** A core-native identity cited by a platform record: a 64-hex string stored verbatim (never recomputed here). */
export function citeCoreNativeIdentity(hash: unknown): string {
  if (typeof hash !== "string" || !HEX64.test(hash)) throw new IdentityBridgeError("CORE_NATIVE", "PLATFORM", "a core-native identity is cited as a 64-hex string");
  return hash;
}

/** The identity bridge: an identity keeps its class; any conversion between classes is refused. */
export function bridgeIdentity(from: IdentityClass, to: IdentityClass, hash: string): string {
  if (from !== to) throw new IdentityBridgeError(from, to, "an identity is never re-hashed or reinterpreted as another class");
  if (!HEX64.test(hash)) throw new IdentityBridgeError(from, to, "not a 64-hex digest");
  return hash;
}

/**
 * The platform digest of a record that cites core-native identities: every named field must be a verbatim 64-hex string (a
 * number, an object or a re-hashed value is refused), then the record passes the agreement and is hashed once.
 */
export function platformDigestCiting(record: Readonly<Record<string, unknown>>, coreNativeFields: readonly string[]): string {
  for (const field of coreNativeFields) citeCoreNativeIdentity(record[field]);
  return platformDigestOfAgreed(record);
}
