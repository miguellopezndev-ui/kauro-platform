/**
 * The destination normalization destination-norm-v1 and the canonical encoding M of a destination fingerprint (lane L-REFUND; DV1-10,
 * DV1-11; ACH-ROUTE r12 §7.22c). Pure functions: the keyed HMAC lives in the application's DestinationFingerprinter, the key never here.
 *
 *   routing  9 ASCII digits after removing spaces and hyphens, with a valid ABA check digit (weights 3,7,1; sum mod 10 = 0).
 *   account  1..17 ASCII digits after removing spaces and hyphens; leading zeros kept (they are part of the account).
 *   holder   NFC, lower-cased, every run of White_Space (tab, NBSP included) collapsed to one space and trimmed; 1..140 code points;
 *            NFC (not NFKC): a full-width letter stays distinct; hyphens are kept.
 *   Any non-ASCII digit (full-width, Arabic-Indic) in routing or account is DESTINATION_INVALID, never folded.
 *
 * M = enc("kauro.destination-fingerprint") ‖ enc(normVersion) ‖ enc(keyId) ‖ enc(decimal keyVersion) ‖ enc(routing) ‖ enc(account) ‖
 * enc(holder), enc(s) = 4-byte big-endian length of UTF-8(s) then the bytes: injective, so no concatenation collision.
 */
import { DESTINATION_NORM_VERSION } from "./records.js";

export interface DestinationInput {
  readonly routingNumber: string;
  readonly accountNumber: string;
  readonly holderName: string;
}
export interface NormalizedDestination {
  readonly routing: string;
  readonly account: string;
  readonly holder: string;
}
export type DestinationNormalization = ({ readonly kind: "OK" } & NormalizedDestination) | { readonly kind: "INVALID" };
/** The four values a fingerprint is computed under; fingerprints are comparable only when all four are equal. */
export interface FingerprintParameters {
  readonly normVersion: string;
  readonly keyId: string;
  readonly keyVersion: number;
}

export const DESTINATION_FINGERPRINT_DOMAIN = "kauro.destination-fingerprint";
export const HOLDER_NAME_MAX_CODE_POINTS = 140;

const SEPARATORS = /[ \-]/g;

function abaValid(routing: string): boolean {
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += w[i]! * (routing.charCodeAt(i) - 48);
  return sum % 10 === 0;
}

export function normalizeDestination(input: DestinationInput): DestinationNormalization {
  if (typeof input?.routingNumber !== "string" || typeof input.accountNumber !== "string" || typeof input.holderName !== "string") return { kind: "INVALID" };
  const routing = input.routingNumber.replace(SEPARATORS, "");
  const account = input.accountNumber.replace(SEPARATORS, "");
  if (!/^[0-9]{9}$/.test(routing) || !abaValid(routing)) return { kind: "INVALID" };
  if (!/^[0-9]{1,17}$/.test(account)) return { kind: "INVALID" };
  const holder = input.holderName.normalize("NFC").toLowerCase().replace(/\p{White_Space}+/gu, " ").trim();
  const length = [...holder].length;
  if (length < 1 || length > HOLDER_NAME_MAX_CODE_POINTS) return { kind: "INVALID" };
  // a control character other than white space (already collapsed) is never part of a name
  if (/\p{Cc}/u.test(holder)) return { kind: "INVALID" };
  return { kind: "OK", routing, account, holder };
}

function enc(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}

export function canonicalDestinationMessage(under: FingerprintParameters, n: NormalizedDestination): Uint8Array {
  if (!Number.isSafeInteger(under.keyVersion) || under.keyVersion < 1) throw new TypeError("a fingerprint key version is a positive integer");
  const parts = [DESTINATION_FINGERPRINT_DOMAIN, under.normVersion, under.keyId, String(under.keyVersion), n.routing, n.account, n.holder].map(enc);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export { DESTINATION_NORM_VERSION };
