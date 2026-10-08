/**
 * Authentication at the HTTP edge (08 "Identity is not permission": authentication produces an identity reference and
 * assurance facts; nothing more). The Authenticator turns request headers into an AuthenticatedSubject or null; the API then
 * resolves membership and capability server-side per command. The provider subject never leaves this module: the platform
 * carries only the derived UUIDv5 user id and the SHA-256 of the subject.
 *
 * `createBearerTokenAuthenticator` binds opaque bearer tokens to subjects for the LOCAL environment and for tests
 * (`loadBearerTokenFile` reads the closed LOCAL file the configuration names); the Identity Platform token verifier (issuer,
 * audience, signature, MFA and email claims) is the identity package's adapter and implements this same interface.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AuthenticatedSubject } from "@kauro/application";
import { isCalendarDateTime } from "@kauro/application";
import { identityUserId, type DomainFailure } from "@kauro/domain";

export interface Authenticator {
  authenticate(headers: Readonly<Record<string, string | undefined>>): Promise<AuthenticatedSubject | null>;
  /**
   * The request-aware form (B11 D-AUTH-5), when the authenticator has one: it sees the method as well, so it can decide the CSRF
   * rule of an unsafe cookie-authenticated request, and it can refuse the credentials themselves (AMBIGUOUS_CREDENTIALS,
   * ORIGIN_REJECTED, CSRF_TOKEN_INVALID) — decided here, before the command journal is reserved. The server prefers it.
   */
  authenticateRequest?(request: AuthenticationRequest): Promise<Authentication>;
  /**
   * The request's credential held for an effect it authorizes (FAILURE-MATRIX-TEMPLATE rule 16), when the authenticator has a lockable
   * credential: a cookie session's row locked (FOR UPDATE, the lock its revocation and every touch take) and touched as a resume touches,
   * until `release`; `liveAt` judges the row as locked at an instant the caller reads after the hold. Null when the request presents no
   * credential that names a session or subject.
   */
  holdRequest?(request: AuthenticationRequest): Promise<HeldCredential | null>;
}

/** A credential as held by holdRequest. */
export interface HeldCredential {
  readonly userId: string;
  liveAt(nowMs: number): boolean;
  release(): Promise<void>;
}

/** What authentication sees of a request: its method and its lowercased single-valued headers. */
export interface AuthenticationRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/** An authenticated subject, no credential at all, or credentials refused as such (the refusal's failure). */
export type Authentication =
  | {
      readonly kind: "SUBJECT";
      readonly subject: AuthenticatedSubject;
      readonly sessionSecret: string | null;
      /**
       * A session credential's first ended instant on the process clock (min of its idle and absolute deadlines as resumed): a caller that
       * awaits after this authentication judges the session live at an instant it reads after its own last await (TIME-AFTER-AWAIT,
       * PV1R-02 r2). Absent for a bearer credential (judged by its verifier when presented).
       */
      readonly liveUntil?: string;
    }
  | { readonly kind: "NONE" }
  | { readonly kind: "REFUSED"; readonly failure: DomainFailure };

/** The authentication of a request by an authenticator of either form. */
export async function authenticationOf(authenticator: Authenticator, request: AuthenticationRequest): Promise<Authentication> {
  if (authenticator.authenticateRequest !== undefined) return authenticator.authenticateRequest(request);
  const subject = await authenticator.authenticate(request.headers);
  return subject === null ? { kind: "NONE" } : { kind: "SUBJECT", subject, sessionSecret: null };
}

export interface SubjectFacts {
  readonly provider: string;
  readonly subject: string;
  readonly emailVerifiedAt: UtcInstant | null;
  readonly mfaEnrolledAt: UtcInstant | null;
  readonly state: "ACTIVE" | "DISABLED";
}

/** Derives the platform's view of an authenticated person from the provider facts. */
export function subjectOf(facts: SubjectFacts): AuthenticatedSubject {
  return {
    identity: {
      userId: identityUserId(facts.provider, facts.subject),
      emailVerifiedAt: facts.emailVerifiedAt,
      mfaEnrolledAt: facts.mfaEnrolledAt,
      state: facts.state,
    },
    provider: facts.provider,
    subjectHash: createHash("sha256").update(facts.subject, "utf8").digest("hex") as Sha256Hex,
  };
}

const BEARER = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,512})$/;

export function createBearerTokenAuthenticator(tokens: ReadonlyMap<string, AuthenticatedSubject>): Authenticator {
  return {
    async authenticate(headers) {
      const value = headers["authorization"];
      if (value === undefined) return null;
      const m = BEARER.exec(value);
      if (!m) return null;
      return tokens.get(m[1] as string) ?? null;
    },
  };
}

// --- LOCAL bearer-token file -------------------------------------------------------------------------------------------

/**
 * One line of the LOCAL bearer-token file: an opaque token bound to the provider facts of one person. The file is a LOCAL
 * convenience (config: KAURO_AUTH_BEARER_TOKENS_FILE is accepted in LOCAL only); SANDBOX and LIVE authenticate through the
 * Identity Platform verifier, which this edition does not bind (I-INT-3).
 */
export interface BearerTokenEntry extends SubjectFacts {
  readonly token: string;
}

export class BearerTokenFileError extends Error {
  constructor(problem: string) {
    super(`bearer token file: ${problem}`);
    this.name = "BearerTokenFileError";
  }
}

function instantOrNull(value: unknown, where: string): UtcInstant | null {
  if (value === null) return null;
  // the utc primitive (10 "Schema format execution"): a real Gregorian instant with at most millisecond precision and Z —
  // Date.parse would roll 2026-02-30 over to March, so the calendar check of the contract validator decides
  if (typeof value !== "string" || !isCalendarDateTime(value)) throw new BearerTokenFileError(`${where} must be a UTC instant or null`);
  return value as UtcInstant;
}

/** Parses the closed file shape `{ "subjects": [ { token, provider, subject, emailVerifiedAt, mfaEnrolledAt, state } ] }`. */
export function parseBearerTokenFile(text: string): ReadonlyMap<string, AuthenticatedSubject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BearerTokenFileError("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BearerTokenFileError("the document must be an object");
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "subjects") throw new BearerTokenFileError("the document carries exactly one member, subjects");
  const subjects = (parsed as { subjects: unknown }).subjects;
  if (!Array.isArray(subjects) || subjects.length === 0) throw new BearerTokenFileError("subjects must be a non-empty array");
  const out = new Map<string, AuthenticatedSubject>();
  subjects.forEach((entry: unknown, i) => {
    const where = `subjects[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new BearerTokenFileError(`${where} must be an object`);
    const e = entry as Record<string, unknown>;
    const allowed = ["token", "provider", "subject", "emailVerifiedAt", "mfaEnrolledAt", "state"];
    for (const k of Object.keys(e)) if (!allowed.includes(k)) throw new BearerTokenFileError(`${where} carries an unknown member ${k}`);
    for (const k of allowed) if (!(k in e)) throw new BearerTokenFileError(`${where} lacks ${k}`);
    if (typeof e["token"] !== "string" || !BEARER.test(`Bearer ${e["token"]}`)) throw new BearerTokenFileError(`${where}.token must be 16..512 token characters`);
    if (typeof e["provider"] !== "string" || e["provider"] === "") throw new BearerTokenFileError(`${where}.provider must be a non-empty string`);
    if (typeof e["subject"] !== "string" || e["subject"] === "") throw new BearerTokenFileError(`${where}.subject must be a non-empty string`);
    if (e["state"] !== "ACTIVE" && e["state"] !== "DISABLED") throw new BearerTokenFileError(`${where}.state must be ACTIVE or DISABLED`);
    if (out.has(e["token"])) throw new BearerTokenFileError(`${where}.token repeats an earlier token`);
    out.set(
      e["token"],
      subjectOf({
        provider: e["provider"],
        subject: e["subject"],
        emailVerifiedAt: instantOrNull(e["emailVerifiedAt"], `${where}.emailVerifiedAt`),
        mfaEnrolledAt: instantOrNull(e["mfaEnrolledAt"], `${where}.mfaEnrolledAt`),
        state: e["state"],
      }),
    );
  });
  return out;
}

/** Reads and parses the LOCAL bearer-token file; every problem names the file and the member, never a token value. */
export function loadBearerTokenFile(path: string): ReadonlyMap<string, AuthenticatedSubject> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new BearerTokenFileError(`cannot read ${path} (${e instanceof Error ? e.name : "error"})`);
  }
  return parseBearerTokenFile(text);
}
