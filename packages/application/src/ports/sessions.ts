/**
 * Ports of the browser session boundary (B11 design D-AUTH-1..5; 08 "Authentication and assurance": authentication produces an
 * identity reference and assurance facts; session cookies are Secure, HttpOnly and have a deliberate SameSite policy).
 *
 *  - IdentityTokenVerifier: the api's verification of an identity provider's ID token (D-AUTH-3). The browser obtains the token
 *    from Identity Platform (or, in LOCAL, from the contract fake) and hands it to POST /api/v1/sessions or
 *    POST /api/v1/assurance/step-ups exactly once; the verifier decides. Its defects are named for the server's log and tests
 *    only: on the wire every defect is the one 401 IDENTITY_TOKEN_INVALID (no account enumeration, D-AUTH-4). A key source that
 *    cannot be read is UNAVAILABLE — the caller's credentials were not judged, so the answer is a retryable 503, never a 401.
 *  - WebSessionStore: the sessions of the authentication boundary group (kauro_assurance, migration 0025 web_sessions). The store
 *    keeps only the SHA-256 of a session secret; a transaction sees exactly the session whose secret hash it presents. It also
 *    records a step-up proof (the B06 assurance_proofs row, D-EVID-1) and, for a cookie session, the session's latest step-up,
 *    in one transaction of the same group.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AssuranceProof, CorrelationId, UserId } from "@kauro/domain";

/** The facts a verified ID token establishes (the documented Identity Platform claim shape). */
export interface VerifiedIdentityToken {
  /** The provider the subject belongs to; the platform's user id is UUIDv5(provider, subject) (D-ID-2). */
  readonly provider: string;
  /** `sub`: the provider's user id (1..128 characters). Never leaves the authentication boundary except as its SHA-256. */
  readonly subject: string;
  /** `email_verified`. */
  readonly emailVerified: boolean;
  /** `firebase.sign_in_second_factor` (e.g. "totp"), or null for a single-factor sign-in. */
  readonly secondFactor: string | null;
  /** `auth_time`: when the person last authenticated (a re-authentication moves it). */
  readonly authTime: UtcInstant;
  /** `iat`. */
  readonly issuedAt: UtcInstant;
  /** `exp`. */
  readonly expiresAt: UtcInstant;
}

/** Why a token was refused (server-side diagnostics and tests; never on the wire). */
export type IdentityTokenDefect =
  | "MALFORMED"
  | "ALGORITHM"
  | "UNKNOWN_KEY"
  | "SIGNATURE"
  | "ISSUER"
  | "AUDIENCE"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "AUTH_TIME"
  | "SUBJECT"
  | "CLAIM";

export type IdentityTokenVerification =
  | { readonly kind: "VERIFIED"; readonly token: VerifiedIdentityToken }
  | { readonly kind: "REJECTED"; readonly defect: IdentityTokenDefect }
  | { readonly kind: "UNAVAILABLE" };

export interface IdentityTokenVerifier {
  verify(idToken: string): Promise<IdentityTokenVerification>;
}

/** A web session as the boundary stores it (the secret itself is never stored). */
export interface WebSessionRecord {
  readonly sessionId: string;
  readonly userId: UserId;
  readonly provider: string;
  readonly subjectHash: Sha256Hex;
  /** The e-mail verification the token asserted at sign-in (its `iat`), or null. */
  readonly emailVerifiedAt: UtcInstant | null;
  /** When the sign-in's second factor was performed (`auth_time` of a second-factor token), or null. */
  readonly mfaAt: UtcInstant | null;
  readonly createdAt: UtcInstant;
  readonly lastSeenAt: UtcInstant;
  readonly idleExpiresAt: UtcInstant;
  readonly absoluteExpiresAt: UtcInstant;
  readonly stepUpProofId: string | null;
  readonly stepUpFreshUntil: UtcInstant | null;
  readonly revokedAt: UtcInstant | null;
  readonly revokeReason: string | null;
}

export type NewWebSession = Omit<WebSessionRecord, "stepUpProofId" | "stepUpFreshUntil" | "revokedAt" | "revokeReason">;

export interface WebSessionStore {
  /** Records a new session under the identity it binds; `secretSha256` is the SHA-256 of the secret the cookie carries. */
  open(session: NewWebSession, secretSha256: Sha256Hex, correlationId: CorrelationId): Promise<void>;
  /**
   * The session the secret hash names, as it stands after this call: when it is live at `now` and its last-seen instant is at
   * least `touchSeconds` old, last-seen moves to `now` and the idle deadline to min(now + idleSeconds, the absolute deadline)
   * first. Null when no session has that hash. Liveness is the caller's decision on the returned record.
   */
  resume(secretSha256: Sha256Hex, now: UtcInstant, idleSeconds: number, touchSeconds: number): Promise<WebSessionRecord | null>;
  /**
   * Ends the session the hash names, once: REVOKED (with its person) when it was live at `at`; ENDED when it was already revoked
   * or past a deadline (nothing changes); UNKNOWN when no session has that hash.
   */
  revoke(secretSha256: Sha256Hex, at: UtcInstant, reason: string): Promise<{ readonly outcome: "REVOKED"; readonly userId: UserId } | { readonly outcome: "ENDED" | "UNKNOWN" }>;
  /** Records a step-up proof of `proof.userId` and, when `sessionSha256` is given, makes it that session's latest step-up. */
  recordStepUp(proof: AssuranceProof, correlationId: CorrelationId, recordedAt: UtcInstant, sessionSha256: Sha256Hex | null): Promise<void>;
}
