/**
 * ContractFakeIdentityIssuer — the contract fake of Identity Platform (B11 design §6; label CONTRACT_FAKE, evidence class
 * SIMULATED; one owner: mandate W2). It stands for the identity provider the browser signs in with and nothing else: accounts
 * with e-mail + password, e-mail verification, TOTP enrolment and TOTP second-factor sign-in, re-authentication, and RS256 ID
 * tokens of the documented claim shape (Firebase "Verify ID tokens using a third-party JWT library": header alg RS256 and kid;
 * payload iss https://securetoken.google.com/<project>, aud <project>, auth_time, sub = user_id, iat, exp, email,
 * email_verified, firebase.sign_in_provider, and for a second-factor sign-in firebase.sign_in_second_factor and
 * firebase.second_factor_identifier), signed by its own RSA key pair and published as a JWKS. Its clock is injected (a test
 * clock moves token instants without anyone sleeping).
 *
 * What it never does: serve outside LOCAL (the api refuses the CONTRACT_FAKE key source elsewhere), skip the api's verifier (its
 * tokens are verified by the shipped verifier exactly as a live token is), or count as live evidence.
 *
 * Failure answers follow the Identity Toolkit tokens the JS SDK maps (INVALID_LOGIN_CREDENTIALS — one answer for an unknown
 * e-mail and a wrong password, as with e-mail enumeration protection —, USER_DISABLED, INVALID_CODE,
 * INVALID_MFA_PENDING_CREDENTIAL, INVALID_ID_TOKEN, EMAIL_EXISTS, WEAK_PASSWORD, INVALID_EMAIL, INVALID_SESSION_INFO).
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import type { UtcInstant } from "@kauro/contracts";
import type { Clock } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";

export const CONTRACT_FAKE_LABEL = "CONTRACT_FAKE";
export const SIMULATED_EVIDENCE = "SIMULATED";

/** A clock a test moves: the api and the fake share one, so token ages and session deadlines move together. */
export interface TestClock extends Clock {
  advance(ms: number): void;
  set(epochMs: number): void;
}

export function testClock(startMs: number = Date.now()): TestClock {
  let now = startMs;
  return {
    now: (): UtcInstant => toUtcInstant(now),
    nowMs: () => now,
    advance(ms) {
      if (!Number.isInteger(ms) || ms < 0) throw new RangeError("a test clock only moves forward, by whole milliseconds");
      now += ms;
    },
    set(epochMs) {
      if (!Number.isInteger(epochMs) || epochMs < now) throw new RangeError("a test clock only moves forward");
      now = epochMs;
    },
  };
}

export type FakeRefusal =
  | "INVALID_LOGIN_CREDENTIALS"
  | "USER_DISABLED"
  | "INVALID_CODE"
  | "INVALID_MFA_PENDING_CREDENTIAL"
  | "INVALID_ID_TOKEN"
  | "EMAIL_EXISTS"
  | "WEAK_PASSWORD"
  | "INVALID_EMAIL"
  | "INVALID_SESSION_INFO"
  | "MFA_ALREADY_ENROLLED";

export type FakeSignIn =
  | { readonly kind: "SIGNED_IN"; readonly idToken: string; readonly localId: string }
  | { readonly kind: "MFA_REQUIRED"; readonly mfaPendingCredential: string; readonly mfaEnrollmentId: string }
  | { readonly kind: "REFUSED"; readonly code: FakeRefusal };

export type FakeTotpEnrollment =
  | { readonly kind: "STARTED"; readonly sharedSecretKey: string; readonly sessionInfo: string; readonly verificationCodeLength: 6; readonly hashingAlgorithm: "SHA1"; readonly periodSec: 30 }
  | { readonly kind: "REFUSED"; readonly code: FakeRefusal };

export interface FakeAccountSpec {
  readonly uid: string;
  readonly email: string;
  readonly password: string;
  readonly emailVerified?: boolean;
  /** Enrolled with a TOTP second factor (a fresh shared secret). */
  readonly totp?: boolean;
  readonly disabled?: boolean;
}

export interface FakeAccount {
  readonly uid: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** The TOTP shared secret (base32), or null when no second factor is enrolled. */
  readonly totpSecret: string | null;
  readonly mfaEnrollmentId: string | null;
  readonly disabled: boolean;
}

/** A token as a sign-in would issue it, with test-controlled defects. */
export interface MintOptions {
  /** Claims replacing (or adding to) the standard ones. */
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly omitClaims?: ReadonlyArray<string>;
  /** Header members replacing the standard ones (alg RS384/RS512 sign with that hash). */
  readonly header?: Readonly<Record<string, unknown>>;
  readonly omitHeader?: ReadonlyArray<string>;
  /** A single-factor sign-in of an enrolled account (no firebase.sign_in_second_factor). */
  readonly omitSecondFactor?: boolean;
  /** When the person authenticated (default: now). */
  readonly authTimeMs?: number;
}

interface StoredAccount {
  uid: string;
  email: string;
  passwordSalt: Buffer;
  passwordHash: Buffer;
  emailVerified: boolean;
  totpSecret: string | null;
  mfaEnrollmentId: string | null;
  disabled: boolean;
}

const TOKEN_LIFETIME_SECONDS = 3_600;
const PENDING_LIFETIME_MS = 300_000;
const TOTP_PERIOD_SECONDS = 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new RangeError("not a base32 secret");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) of a base32 shared secret at `atMs`. */
export function totpCode(secretBase32: string, atMs: number): string {
  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secretBase32)).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary = ((digest[offset] as number) & 0x7f) << 24 | (digest[offset + 1] as number) << 16 | (digest[offset + 2] as number) << 8 | (digest[offset + 3] as number);
  return String(binary % 1_000_000).padStart(6, "0");
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function opaque(): string {
  return randomBytes(24).toString("base64url");
}

const HASH_OF_ALG: Readonly<Record<string, string>> = Object.freeze({ RS256: "sha256", RS384: "sha384", RS512: "sha512" });

export class ContractFakeIdentityIssuer {
  readonly label = CONTRACT_FAKE_LABEL;
  readonly evidenceClass = SIMULATED_EVIDENCE;
  readonly projectId: string;
  readonly keyId: string;
  readonly clock: Clock;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #accounts = new Map<string, StoredAccount>();
  readonly #pending = new Map<string, { readonly uid: string; readonly expiresAtMs: number }>();
  readonly #enrollments = new Map<string, { readonly uid: string; readonly secret: string; readonly expiresAtMs: number }>();

  constructor(options: { readonly projectId: string; readonly clock?: Clock; readonly keyId?: string; readonly keyPair?: { readonly privateKey: KeyObject; readonly publicKey: KeyObject } }) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId)) throw new RangeError("a project id is 6..30 lowercase letters, digits and hyphens");
    this.projectId = options.projectId;
    this.clock = options.clock ?? { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() };
    const pair = options.keyPair ?? generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = pair.privateKey;
    this.#publicKey = pair.publicKey;
    this.keyId = options.keyId ?? createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 40);
  }

  /** The `iss` of every token: https://securetoken.google.com/<project>. */
  get issuer(): string {
    return `https://securetoken.google.com/${this.projectId}`;
  }

  get publicKeyPem(): string {
    return this.#publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  /** The issuer's signing key as a JSON Web Key Set (the CONTRACT_FAKE key source of the api's verifier). */
  jwks(): { readonly keys: ReadonlyArray<Readonly<Record<string, string>>> } {
    const jwk = this.#publicKey.export({ format: "jwk" }) as Record<string, string>;
    return { keys: [{ kty: jwk["kty"] as string, n: jwk["n"] as string, e: jwk["e"] as string, kid: this.keyId, alg: "RS256", use: "sig" }] };
  }

  createAccount(spec: FakeAccountSpec): FakeAccount {
    if (this.#accounts.has(spec.uid)) throw new RangeError(`the fake already has an account ${spec.uid}`);
    if (this.#byEmail(spec.email) !== null) throw new RangeError("the fake already has an account with that e-mail");
    const salt = randomBytes(16);
    const stored: StoredAccount = {
      uid: spec.uid,
      email: spec.email,
      passwordSalt: salt,
      passwordHash: this.#hash(salt, spec.password),
      emailVerified: spec.emailVerified ?? true,
      totpSecret: spec.totp === false ? null : base32Encode(randomBytes(20)),
      mfaEnrollmentId: null,
      disabled: spec.disabled ?? false,
    };
    if (stored.totpSecret !== null) stored.mfaEnrollmentId = opaque().slice(0, 20);
    this.#accounts.set(spec.uid, stored);
    return this.#public(stored);
  }

  account(uid: string): FakeAccount | null {
    const a = this.#accounts.get(uid);
    return a === undefined ? null : this.#public(a);
  }

  setDisabled(uid: string, disabled: boolean): void {
    this.#require(uid).disabled = disabled;
  }

  /** The person opened the verification link (the test stands in for them). */
  verifyEmail(email: string): boolean {
    const a = this.#byEmail(email);
    if (a === null) return false;
    a.emailVerified = true;
    return true;
  }

  signUp(email: string, password: string): FakeSignIn {
    if (!EMAIL.test(email)) return { kind: "REFUSED", code: "INVALID_EMAIL" };
    if (password.length < 6) return { kind: "REFUSED", code: "WEAK_PASSWORD" };
    if (this.#byEmail(email) !== null) return { kind: "REFUSED", code: "EMAIL_EXISTS" };
    const account = this.createAccount({ uid: opaque().slice(0, 28), email, password, emailVerified: false, totp: false });
    return { kind: "SIGNED_IN", idToken: this.mint(account.uid), localId: account.uid };
  }

  signInWithPassword(email: string, password: string): FakeSignIn {
    const a = this.#byEmail(email);
    if (a === null || !this.#passwordMatches(a, password)) return { kind: "REFUSED", code: "INVALID_LOGIN_CREDENTIALS" };
    if (a.disabled) return { kind: "REFUSED", code: "USER_DISABLED" };
    if (a.totpSecret !== null && a.mfaEnrollmentId !== null) {
      const credential = opaque();
      this.#pending.set(credential, { uid: a.uid, expiresAtMs: this.clock.nowMs() + PENDING_LIFETIME_MS });
      return { kind: "MFA_REQUIRED", mfaPendingCredential: credential, mfaEnrollmentId: a.mfaEnrollmentId };
    }
    return { kind: "SIGNED_IN", idToken: this.mint(a.uid, { omitSecondFactor: true }), localId: a.uid };
  }

  /** The second step of an MFA sign-in: the pending credential (single use, five minutes) and the current TOTP code. */
  finalizeTotp(mfaPendingCredential: string, verificationCode: string, mfaEnrollmentId?: string): FakeSignIn {
    const pending = this.#pending.get(mfaPendingCredential);
    if (pending === undefined || pending.expiresAtMs <= this.clock.nowMs()) {
      this.#pending.delete(mfaPendingCredential);
      return { kind: "REFUSED", code: "INVALID_MFA_PENDING_CREDENTIAL" };
    }
    const a = this.#require(pending.uid);
    if (a.totpSecret === null || (mfaEnrollmentId !== undefined && mfaEnrollmentId !== a.mfaEnrollmentId)) return { kind: "REFUSED", code: "INVALID_MFA_PENDING_CREDENTIAL" };
    if (!this.#codeMatches(a.totpSecret, verificationCode)) return { kind: "REFUSED", code: "INVALID_CODE" };
    this.#pending.delete(mfaPendingCredential);
    return { kind: "SIGNED_IN", idToken: this.mint(a.uid), localId: a.uid };
  }

  startTotpEnrollment(idToken: string): FakeTotpEnrollment {
    const uid = this.uidOf(idToken);
    if (uid === null) return { kind: "REFUSED", code: "INVALID_ID_TOKEN" };
    const a = this.#require(uid);
    if (a.totpSecret !== null) return { kind: "REFUSED", code: "MFA_ALREADY_ENROLLED" };
    const secret = base32Encode(randomBytes(20));
    const sessionInfo = opaque();
    this.#enrollments.set(sessionInfo, { uid, secret, expiresAtMs: this.clock.nowMs() + PENDING_LIFETIME_MS });
    return { kind: "STARTED", sharedSecretKey: secret, sessionInfo, verificationCodeLength: 6, hashingAlgorithm: "SHA1", periodSec: 30 };
  }

  finalizeTotpEnrollment(idToken: string, sessionInfo: string, verificationCode: string): FakeSignIn {
    const uid = this.uidOf(idToken);
    if (uid === null) return { kind: "REFUSED", code: "INVALID_ID_TOKEN" };
    const enrollment = this.#enrollments.get(sessionInfo);
    if (enrollment === undefined || enrollment.uid !== uid || enrollment.expiresAtMs <= this.clock.nowMs()) return { kind: "REFUSED", code: "INVALID_SESSION_INFO" };
    if (!this.#codeMatches(enrollment.secret, verificationCode)) return { kind: "REFUSED", code: "INVALID_CODE" };
    this.#enrollments.delete(sessionInfo);
    const a = this.#require(uid);
    a.totpSecret = enrollment.secret;
    a.mfaEnrollmentId = opaque().slice(0, 20);
    return { kind: "SIGNED_IN", idToken: this.mint(uid), localId: uid };
  }

  /** The code the person's authenticator app shows for a shared secret (default: now on the issuer's clock). */
  totpCodeOf(secretBase32: string, atMs: number = this.clock.nowMs()): string {
    return totpCode(secretBase32, atMs);
  }

  /** The code an account's authenticator app shows now. */
  totpCodeFor(uid: string, atMs: number = this.clock.nowMs()): string {
    const secret = this.#require(uid).totpSecret;
    if (secret === null) throw new RangeError(`${uid} has no TOTP second factor`);
    return totpCode(secret, atMs);
  }

  /** The uid of a token this issuer signed that has not expired on its clock, or null. */
  uidOf(idToken: string): string | null {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    if (!verify("sha256", Buffer.from(`${h}.${p}`), this.#publicKey, Buffer.from(s, "base64url"))) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
    const exp = payload["exp"];
    const sub = payload["sub"];
    if (typeof exp !== "number" || exp * 1000 <= this.clock.nowMs() || typeof sub !== "string" || !this.#accounts.has(sub)) return null;
    return sub;
  }

  /**
   * An ID token for the account as its sign-in would issue it now (with the second factor when the account has one), with the
   * test's defects applied. A contract fake never refuses to mint: the api's verifier is what decides.
   */
  mint(uid: string, options: MintOptions = {}): string {
    const a = this.#require(uid);
    const nowSeconds = Math.floor(this.clock.nowMs() / 1000);
    const authTime = Math.floor((options.authTimeMs ?? this.clock.nowMs()) / 1000);
    const firebase: Record<string, unknown> = { identities: { email: [a.email] }, sign_in_provider: "password" };
    if (a.totpSecret !== null && a.mfaEnrollmentId !== null && options.omitSecondFactor !== true) {
      firebase["sign_in_second_factor"] = "totp";
      firebase["second_factor_identifier"] = a.mfaEnrollmentId;
    }
    const payload: Record<string, unknown> = {
      iss: this.issuer,
      aud: this.projectId,
      auth_time: authTime,
      user_id: a.uid,
      sub: a.uid,
      iat: nowSeconds,
      exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
      email: a.email,
      email_verified: a.emailVerified,
      firebase,
      ...(options.claims ?? {}),
    };
    for (const k of options.omitClaims ?? []) delete payload[k];
    const header: Record<string, unknown> = { alg: "RS256", kid: this.keyId, typ: "JWT", ...(options.header ?? {}) };
    for (const k of options.omitHeader ?? []) delete header[k];
    const signingInput = `${b64(header)}.${b64(payload)}`;
    const hash = HASH_OF_ALG[String(header["alg"])] ?? "sha256";
    return `${signingInput}.${sign(hash, Buffer.from(signingInput), this.#privateKey).toString("base64url")}`;
  }

  #byEmail(email: string): StoredAccount | null {
    for (const a of this.#accounts.values()) if (a.email.toLowerCase() === email.toLowerCase()) return a;
    return null;
  }

  #require(uid: string): StoredAccount {
    const a = this.#accounts.get(uid);
    if (a === undefined) throw new RangeError(`the fake has no account ${uid}`);
    return a;
  }

  #hash(salt: Buffer, password: string): Buffer {
    return createHash("sha256").update(salt).update(password, "utf8").digest();
  }

  #passwordMatches(a: StoredAccount, password: string): boolean {
    return timingSafeEqual(this.#hash(a.passwordSalt, password), a.passwordHash);
  }

  /** The current code, or the previous period's (one step of drift, as authenticator apps are allowed). */
  #codeMatches(secret: string, code: string): boolean {
    const now = this.clock.nowMs();
    return code === totpCode(secret, now) || code === totpCode(secret, now - TOTP_PERIOD_SECONDS * 1000);
  }

  #public(a: StoredAccount): FakeAccount {
    return { uid: a.uid, email: a.email, emailVerified: a.emailVerified, totpSecret: a.totpSecret, mfaEnrollmentId: a.mfaEnrollmentId, disabled: a.disabled };
  }
}
