// The IdentityClient port (design D-AUTH-2): how the browser proves who a person is to the identity provider, before the api exchanges
// that proof for a session (D-AUTH-4). Sign-in, the TOTP challenge and enrolment, e-mail verification and re-authentication are the
// port's whole surface; nothing here decides permission (08 "Identity is not permission").
//
// A provider token is a secret with one use: the credential hands it out exactly once, to the session exchange, and then it is gone. It is
// never a member the page can read, never serialised, never logged, never stored (D-PRIV-1). The live adapter (the provider's own SDK,
// in-memory persistence, signing out right after the exchange) lands with W-IDP-LIVE; until then `selectIdentityClient` says so instead of
// pretending.

export type IdentitySource = "CONTRACT_FAKE" | "LIVE";

/** What kind of evidence a sign-in through this adapter is: a simulation never counts as proof of the real provider (A2 evidence classes). */
export type IdentityEvidence = "SIMULATED" | "LIVE";

export type IdentityFailure =
  | "INVALID_CREDENTIALS"
  | "CODE_INVALID"
  | "TOO_MANY_ATTEMPTS"
  | "NO_PENDING_STEP"
  | "UNAVAILABLE"
  | "PROTOCOL_ERROR";

export interface TotpEnrolment {
  /** The `otpauth://` address the person's authenticator app is set up from. It is a secret: shown once, never kept. */
  readonly otpauthUri: string;
}

export type IdentityStep =
  | { readonly kind: "SIGNED_IN"; readonly credential: IdentityCredential }
  | { readonly kind: "TOTP_REQUIRED" }
  | { readonly kind: "TOTP_ENROLMENT_REQUIRED"; readonly enrolment: TotpEnrolment }
  | { readonly kind: "EMAIL_UNVERIFIED" }
  | { readonly kind: "VERIFICATION_SENT" }
  | { readonly kind: "FAILED"; readonly failure: IdentityFailure };

/** Why the credential is being minted: a new session, or a step-up proof for a sensitive command (D-AUTH-4). */
export type CredentialPurpose = "SESSION" | "STEP_UP";

/** The proof of a completed sign-in. Its token can be taken once; it is not an own property, not serialised and not printed. */
export class IdentityCredential {
  readonly source: IdentitySource;
  readonly purpose: CredentialPurpose;
  #token: string | null;

  constructor(source: IdentitySource, purpose: CredentialPurpose, token: string) {
    if (token.length === 0) throw new RangeError("a credential carries a token");
    this.source = source;
    this.purpose = purpose;
    this.#token = token;
  }

  /** Hands the token to its one user. A second call is a bug and throws: a token is never reused. */
  takeToken(): string {
    const token = this.#token;
    if (token === null) throw new Error("this credential's token was already taken");
    this.#token = null;
    return token;
  }

  get spent(): boolean {
    return this.#token === null;
  }

  toJSON(): { readonly source: IdentitySource; readonly purpose: CredentialPurpose; readonly spent: boolean } {
    return { source: this.source, purpose: this.purpose, spent: this.spent };
  }
}

export interface IdentityClient {
  readonly source: IdentitySource;
  readonly evidence: IdentityEvidence;
  signIn(email: string, password: string): Promise<IdentityStep>;
  /** The six-digit code of an enrolled authenticator, for the sign-in in progress. */
  submitTotp(code: string): Promise<IdentityStep>;
  /** The first code of a new authenticator, completing an enrolment. */
  enrolTotp(code: string): Promise<IdentityStep>;
  resendVerification(): Promise<IdentityStep>;
  checkVerification(): Promise<IdentityStep>;
  /** Proves the signed-in person again (password, then `submitTotp`) for a step-up proof. */
  reauthenticate(email: string, password: string): Promise<IdentityStep>;
  /** Forgets the sign-in in progress. */
  cancel(): void;
}

/**
 * What the page makes of `GET /api/v1/public/identity-config` (D-AUTH-2; W2 serves it, and refuses to announce the fake outside LOCAL):
 * the fake at the path of this origin the api announces as its endpoint, or the live provider (select.ts readIdentityConfig).
 */
export type IdentityConfig =
  | { readonly adapter: "CONTRACT_FAKE"; readonly baseUrl: string }
  | { readonly adapter: "LIVE" };

export type Selection =
  | { readonly kind: "CLIENT"; readonly client: IdentityClient }
  | { readonly kind: "LIVE_NOT_AVAILABLE" }
  /** The announcement named the fake with an address that is not a path on this origin: nothing is built. */
  | { readonly kind: "CONFIG_REFUSED" };

export const SIGN_IN_CODE = /^[0-9]{6}$/;
