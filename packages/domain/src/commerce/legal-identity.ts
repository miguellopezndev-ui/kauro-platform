/**
 * The legal identity of a fiscal issuer as a verifiable document (B13 x B09; docs/design/B13-report-inputs.md §3).
 *
 * `kauro.fiscal_issuers.legal_identity_hash` (migration 0013) names the contracting and invoicing entity by a hash, and the quote's
 * KAURO_QUOTE_TERMS_V1 preimage names that issuer (`issuerRef`). This module is the document the hash is the SHA-256 of: the closed
 * wrapper {domain: KAURO_LEGAL_IDENTITY_V1, version: 1, payload} under the canonical profile, so whoever holds the bytes can check them
 * against the recorded hash, and nothing else can stand in for them (a display name, a brand, a fixture).
 *
 * Nothing here knows Kauro's identity: the platform records the owner's document (migration 0095, kauro.legal_identity_snapshots) and
 * reads it back. A field that is not a recorded fact — empty, a placeholder ("[NIT]", "REQUIRES_REVIEW", "PENDING"), a control or
 * markup-significant character — is refused, so an incomplete identity never becomes a document.
 */
import { canonicalBytes, parseCanonical, rawDigest, type Sha256Hex } from "@kauro/contracts";

export const LEGAL_IDENTITY_DOMAIN = "KAURO_LEGAL_IDENTITY_V1";

/**
 * The facts of manual 19 "BusinessProfile and legal facts" a contracting entity is named by; every one is required. The legal
 * representative is not one of them: a person's name is kept outside the platform (owner decision D-16) and no report prints it.
 */
export interface LegalIdentity {
  /** Razón social, exactly as registered. */
  readonly legalName: string;
  /** The legal form (e.g. the company type the registry states). */
  readonly entityType: string;
  /** ISO 3166-1 alpha-2 of the registering state; equals the issuer row's `jurisdiction`. */
  readonly jurisdiction: string;
  /** The tax identification number (in Colombia, the NIT with its check digit), as the tax authority issued it. */
  readonly taxId: string;
  /** The commercial registry number (in Colombia, the matrícula mercantil). */
  readonly commercialRegistrationId: string;
  /** The registered address (domicilio). */
  readonly registeredAddress: string;
}

export const LEGAL_IDENTITY_FIELDS = ["legalName", "entityType", "jurisdiction", "taxId", "commercialRegistrationId", "registeredAddress"] as const;

const MAX_LENGTH: Readonly<Record<(typeof LEGAL_IDENTITY_FIELDS)[number], number>> = Object.freeze({
  legalName: 200,
  entityType: 100,
  jurisdiction: 2,
  taxId: 100,
  commercialRegistrationId: 100,
  registeredAddress: 300,
});

/** The same fence as the report model's issuer text (S069), so a recorded identity is always printable: controls, format characters, separators and markup. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>"'&`]/u;
/** What a template or a gap leaves behind instead of a fact. */
const PLACEHOLDER = /[[\]{}]|^(?:REQUIRES_REVIEW|PENDING|TBD|TODO|UNKNOWN|NONE|NULL|N\/A)$/i;
const ISO_3166_ALPHA_2 = /^[A-Z]{2}$/;

/** Why a field is not a recorded fact, or null when it is one. */
function fieldProblem(name: (typeof LEGAL_IDENTITY_FIELDS)[number], value: unknown): string | null {
  if (typeof value !== "string") return "NOT_TEXT";
  if (value.trim().length === 0 || value !== value.trim()) return "EMPTY_OR_PADDED";
  if (value.length > MAX_LENGTH[name]) return "TOO_LONG";
  if (value !== value.normalize("NFC")) return "NOT_NFC";
  if (UNSAFE.test(value)) return "UNSAFE_TEXT";
  if (PLACEHOLDER.test(value)) return "PLACEHOLDER";
  if (name === "jurisdiction" && !ISO_3166_ALPHA_2.test(value)) return "NOT_ISO_3166_ALPHA_2";
  return null;
}

/** The problems of an identity, one `<field>:<problem>` each (empty exactly when every field is a recorded fact). */
export function legalIdentityProblems(identity: unknown): readonly string[] {
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) return ["IDENTITY_NOT_AN_OBJECT"];
  const record = identity as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join() !== [...LEGAL_IDENTITY_FIELDS].sort().join()) return ["IDENTITY_NOT_CLOSED"];
  return LEGAL_IDENTITY_FIELDS.flatMap((name) => {
    const problem = fieldProblem(name, record[name]);
    return problem === null ? [] : [`${name}:${problem}`];
  });
}

/** The canonical bytes of an identity: their SHA-256 is the issuer's `legal_identity_hash`. Throws on an identity that is not complete. */
export function legalIdentityBytesOf(identity: LegalIdentity): Uint8Array {
  const problems = legalIdentityProblems(identity);
  if (problems.length > 0) throw new TypeError(`the legal identity is not a complete set of recorded facts: ${problems.join(", ")}`);
  const payload = Object.fromEntries(LEGAL_IDENTITY_FIELDS.map((name) => [name, identity[name]]));
  return canonicalBytes({ domain: LEGAL_IDENTITY_DOMAIN, version: 1, payload });
}

export type LegalIdentityReading =
  | { readonly ok: true; readonly identity: LegalIdentity; readonly sha256: Sha256Hex }
  | { readonly ok: false; readonly problem: string };

const closed = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).sort().join() === [...keys].sort().join();

/** Reads a document back: the closed wrapper, a complete identity, and the bytes exactly its canonical form (no second spelling). */
export function readLegalIdentity(bytes: Uint8Array): LegalIdentityReading {
  const refuse = (problem: string): LegalIdentityReading => ({ ok: false, problem });
  let doc: unknown;
  try {
    doc = parseCanonical(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refuse("NOT_CANONICAL");
  }
  if (!closed(doc, ["domain", "payload", "version"]) || doc["domain"] !== LEGAL_IDENTITY_DOMAIN || doc["version"] !== 1) return refuse("NOT_A_LEGAL_IDENTITY");
  const problems = legalIdentityProblems(doc["payload"]);
  if (problems.length > 0) return refuse(`INCOMPLETE[${problems.join(",")}]`);
  const identity = doc["payload"] as unknown as LegalIdentity;
  const again = legalIdentityBytesOf(identity);
  if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) return refuse("NOT_THE_CANONICAL_FORM");
  return { ok: true, identity: Object.freeze({ ...identity }), sha256: rawDigest(bytes) as Sha256Hex };
}
