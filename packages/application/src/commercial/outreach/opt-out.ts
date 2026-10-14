/**
 * The public opt-out (plan docs/design/B12-outreach-plan.md "Public opt-out", GAP-API-B12-3/4, D-B12O-12/13/21; A14). The token in a
 * message's List-Unsubscribe URI is `<keyVersion>.<intent id, 32 hex>.<HMAC-SHA256(secret of that version, intent id), base64url>`: it is the
 * capability of exactly one intent, so a message carries no address, and a forged or altered token is a miss. The dispatcher's MIME builder
 * (lane L-SEND) mints it with mintOptOutToken; the route reads it with readOptOutToken.
 *
 * The POST acts only on the token: the store suppresses the CONTACT key of the token's intent (L8 X, then the suppression row and the
 * SUPPRESSED activity, both ON CONFLICT DO NOTHING; the outreach service never updates a prospect, A17) and answers the same 200 for a
 * known and an unknown token. Only token lookups that MISS are counted, per client network, at the database's instant: the 21st miss in
 * 60 s is LIMITED (429 ADMISSION_LIMITED); a valid token is never counted or limited.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** One generation of the signing secret; the newest signs, every listed version verifies. At least 32 bytes. */
export interface OptOutKey {
  readonly version: string;
  readonly secret: Uint8Array;
}

const VERSION = /^[a-z0-9]{1,8}$/;
const INTENT_HEX = /^[0-9a-f]{32}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

/** The misses one network may make in the window before the answer is 429. */
export const OPT_OUT_MISS_LIMIT = 20;
export const OPT_OUT_MISS_WINDOW_SECONDS = 60;

function macOf(key: OptOutKey, intentHex: string): string {
  return createHmac("sha256", key.secret).update(`kauro-outreach-opt-out:${key.version}:${intentHex}`).digest("base64url");
}

function assertKey(key: OptOutKey): void {
  if (!VERSION.test(key.version)) throw new RangeError("the opt-out key version is 1-8 lowercase letters or digits");
  if (key.secret.byteLength < 32) throw new RangeError("the opt-out secret must be at least 32 bytes");
}

/** The token of an intent (uuid with or without hyphens), signed by `key`. */
export function mintOptOutToken(key: OptOutKey, intentId: string): string {
  assertKey(key);
  const hex = intentId.replaceAll("-", "").toLowerCase();
  if (!INTENT_HEX.test(hex)) throw new RangeError("the opt-out token names an intent id");
  return `${key.version}.${hex}.${macOf(key, hex)}`;
}

function uuidOf(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The intent id a token names, or null when it is malformed, of an unknown key version, or its MAC does not verify. */
export function readOptOutToken(keys: ReadonlyArray<OptOutKey>, token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, hex, mac] = parts as [string, string, string];
  if (!VERSION.test(version) || !INTENT_HEX.test(hex) || !MAC.test(mac)) return null;
  const key = keys.find((k) => k.version === version);
  if (key === undefined) return null;
  const expected = Buffer.from(macOf(key, hex));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return uuidOf(hex);
}

/** What the store did for a token that names an intent. */
export type OptOutOutcome = "SUPPRESSED" | "UNKNOWN_INTENT";

/** The outreach service's unit of work for the opt-out (kauro_outreach; @kauro/persistence PgOptOutStore). */
export interface OptOutStore {
  /** Suppresses the contact of the intent (idempotent); UNKNOWN_INTENT when no such intent exists, writing nothing. */
  suppressContactOfIntent(intentId: string): Promise<OptOutOutcome>;
  /** Counts one MISS of the network at the database's instant and answers how many misses it made in the last window, this one included. */
  recordMiss(networkDigest: string): Promise<number>;
}

export interface OptOutDependencies {
  readonly keys: ReadonlyArray<OptOutKey>;
  readonly store: OptOutStore;
}

export type OptOutAnswer = { readonly kind: "DONE" } | { readonly kind: "LIMITED" };

/** The digest of a client network that the limiter stores (never the address itself). */
export function networkDigestOf(keys: ReadonlyArray<OptOutKey>, network: string | null): string {
  const first = keys[0];
  if (first === undefined) throw new RangeError("at least one opt-out key is required");
  return createHmac("sha256", first.secret).update(`kauro-outreach-opt-out-network:${network ?? "unknown"}`).digest("hex");
}

/** The POST: acts on the token alone. A known token suppresses; a miss is counted and, past the limit, LIMITED; the rest answers DONE. */
export async function optOutByToken(deps: OptOutDependencies, token: string, network: string | null): Promise<OptOutAnswer> {
  const intentId = readOptOutToken(deps.keys, token);
  if (intentId !== null && (await deps.store.suppressContactOfIntent(intentId)) === "SUPPRESSED") return { kind: "DONE" };
  const misses = await deps.store.recordMiss(networkDigestOf(deps.keys, network));
  return misses > OPT_OUT_MISS_LIMIT ? { kind: "LIMITED" } : { kind: "DONE" };
}

/** sha256 hex of a token: the form in which a token may be logged or compared, never the token itself. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
