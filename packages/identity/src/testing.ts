/**
 * `@kauro/identity/testing` — the TEST-ONLY subpath (architecture rule testOnlySubpaths) of the offline simulators of O23A,
 * evidence class SIMULATED. Nothing here is ever served:
 *
 *  - SimulatedCognitoIssuer: RS256 ID tokens of the documented Cognito user-pool claim shape, signed by its own key pair and
 *    published as a JWKS, on an injected clock; accounts, a second factor (under the claim the test names) and access tokens
 *    (to prove they are refused);
 *  - InMemoryWebSessions: the WebSessionStore, SessionFence and PersonSessionRevoker ports with the semantics their PostgreSQL
 *    implementations document (rows judged at an instant read after the "lock");
 *  - in-memory recovery-code vault, e-mail challenge store and a capturing outbox.
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { FencedWebSession, NewWebSession, SessionFence, WebSessionRecord, WebSessionStore } from "@kauro/application";
import type { AssuranceProof, Clock, UserId } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import { cognitoIssuer, type JsonWebKeySet } from "./providers.js";
import type { PersonRevocationReason, PersonSessionRevoker } from "./revocation.js";
import type { RecoveryCodeVault } from "./recovery.js";
import type { EmailChallengeRecord, EmailChallengeStore, EmailOutbox } from "./email-verification.js";

export const SIMULATED_EVIDENCE = "SIMULATED";

export interface SimulatedAccount {
  readonly sub: string;
  readonly email: string;
  emailVerified: boolean;
  /** The second-factor method the account signs in with (e.g. "totp"), or null. */
  secondFactor: string | null;
  disabled: boolean;
}

export class SimulatedCognitoIssuer {
  readonly evidenceClass = SIMULATED_EVIDENCE;
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly kid: string;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #clock: Clock;
  readonly #accounts = new Map<string, SimulatedAccount>();
  /** The claim this simulator writes the second factor under (what O23B would configure), or null for none. */
  readonly secondFactorClaim: string | null;

  constructor(options: { readonly clock: Clock; readonly region?: string; readonly userPoolId?: string; readonly clientId?: string; readonly secondFactorClaim?: string | null; readonly kid?: string }) {
    this.#clock = options.clock;
    this.region = options.region ?? "us-east-1";
    this.userPoolId = options.userPoolId ?? `${this.region}_SimPool01`;
    this.clientId = options.clientId ?? "simclient0123456789abcdef";
    this.secondFactorClaim = options.secondFactorClaim === undefined ? "custom:kauro_mfa" : options.secondFactorClaim;
    this.kid = options.kid ?? "sim-key-1";
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = pair.privateKey;
    this.#publicKey = pair.publicKey;
  }

  get issuer(): string {
    return cognitoIssuer(this.region, this.userPoolId);
  }

  jwks(): JsonWebKeySet {
    return { keys: [{ ...this.#publicKey.export({ format: "jwk" }), kid: this.kid, alg: "RS256", use: "sig" }] };
  }

  register(account: Omit<SimulatedAccount, "disabled"> & { readonly disabled?: boolean }): SimulatedAccount {
    if (this.#accounts.has(account.sub)) throw new Error("the simulator already has that account");
    const created: SimulatedAccount = { ...account, disabled: account.disabled ?? false };
    this.#accounts.set(account.sub, created);
    return created;
  }

  account(sub: string): SimulatedAccount {
    const a = this.#accounts.get(sub);
    if (a === undefined) throw new Error("no simulated account has that sub");
    return a;
  }

  /** An ID token of a sign-in now (or `authTimeMs`): with the second factor when the account has one and `withSecondFactor` holds. */
  async idToken(sub: string, options: { readonly withSecondFactor?: boolean; readonly authTimeMs?: number; readonly lifetimeSeconds?: number; readonly overrides?: Record<string, unknown>; readonly signWith?: KeyObject } = {}): Promise<string> {
    const a = this.account(sub);
    if (a.disabled) throw new Error("the simulator refuses a disabled account (NotAuthorizedException)");
    const nowS = Math.floor(this.#clock.nowMs() / 1000);
    const payload: Record<string, unknown> = {
      sub: a.sub,
      email: a.email,
      email_verified: a.emailVerified,
      "cognito:username": a.sub,
      token_use: "id",
      auth_time: Math.floor((options.authTimeMs ?? this.#clock.nowMs()) / 1000),
      event_id: `sim-${nowS}`,
    };
    if ((options.withSecondFactor ?? true) && a.secondFactor !== null && this.secondFactorClaim !== null) payload[this.secondFactorClaim] = a.secondFactor;
    Object.assign(payload, { iss: this.issuer, aud: this.clientId, iat: nowS, exp: nowS + (options.lifetimeSeconds ?? 3_600) }, options.overrides ?? {});
    return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: this.kid }).sign(options.signWith ?? this.#privateKey);
  }

  /** An access token (token_use "access", client_id, no aud): never a sign-in proof. */
  async accessToken(sub: string): Promise<string> {
    const nowS = Math.floor(this.#clock.nowMs() / 1000);
    return new SignJWT({ sub, token_use: "access", client_id: this.clientId, auth_time: nowS, scope: "aws.cognito.signin.user.admin" })
      .setProtectedHeader({ alg: "RS256", kid: this.kid })
      .setIssuer(this.issuer)
      .setIssuedAt(nowS)
      .setExpirationTime(nowS + 3_600)
      .sign(this.#privateKey);
  }
}

// --- sessions --------------------------------------------------------------------------------------------------------------

type StepUpRequest = Parameters<WebSessionStore["recordStepUp"]>[0];

interface Row {
  record: WebSessionRecord;
  sha: string;
}

/** The session ports in memory, with the documented semantics of the PostgreSQL store, fence and revoker. */
export class InMemoryWebSessions implements WebSessionStore, SessionFence, PersonSessionRevoker {
  readonly #rows = new Map<string, Row>();
  readonly proofs: AssuranceProof[] = [];

  #live(r: WebSessionRecord, at: UtcInstant): boolean {
    const t = Date.parse(at);
    return r.revokedAt === null && t < Date.parse(r.idleExpiresAt) && t < Date.parse(r.absoluteExpiresAt);
  }

  async open(session: NewWebSession, secretSha256: Sha256Hex): Promise<void> {
    if (this.#rows.has(secretSha256)) throw new Error("UNIQUE: secret_sha256");
    this.#rows.set(secretSha256, { sha: secretSha256, record: { ...session, stepUpProofId: null, stepUpFreshUntil: null, revokedAt: null, revokeReason: null } });
  }

  async resume(secretSha256: Sha256Hex, now: () => UtcInstant, idleSeconds: number, touchSeconds: number): Promise<WebSessionRecord | null> {
    const row = this.#rows.get(secretSha256);
    if (row === undefined) return null;
    const at = now();
    const r = row.record;
    if (this.#live(r, at) && Date.parse(at) - Date.parse(r.lastSeenAt) >= touchSeconds * 1000) {
      const idle = Math.min(Date.parse(at) + idleSeconds * 1000, Date.parse(r.absoluteExpiresAt));
      row.record = { ...r, lastSeenAt: at, idleExpiresAt: toUtcInstant(idle) };
    }
    return row.record;
  }

  async revoke(secretSha256: Sha256Hex, now: () => UtcInstant, reason: string): Promise<{ readonly outcome: "REVOKED"; readonly userId: UserId } | { readonly outcome: "ENDED" | "UNKNOWN" }> {
    const row = this.#rows.get(secretSha256);
    if (row === undefined) return { outcome: "UNKNOWN" };
    const at = now();
    if (!this.#live(row.record, at)) return { outcome: "ENDED" };
    row.record = { ...row.record, revokedAt: at, revokeReason: reason };
    return { outcome: "REVOKED", userId: row.record.userId };
  }

  async recordStepUp(request: StepUpRequest, _correlationId: unknown, now: () => UtcInstant, sessionSha256: Sha256Hex | null): Promise<{ readonly outcome: "RECORDED"; readonly proof: AssuranceProof } | { readonly outcome: "ENDED" | "STALE" }> {
    const row = sessionSha256 === null ? undefined : this.#rows.get(sessionSha256);
    if (sessionSha256 !== null && (row === undefined || row.record.userId !== request.userId)) return { outcome: "ENDED" };
    const at = now();
    if (row !== undefined && !this.#live(row.record, at)) return { outcome: "ENDED" };
    const atMs = Date.parse(at);
    const authMs = Date.parse(request.authTime);
    if (atMs - authMs > request.maxAgeSeconds * 1000) return { outcome: "STALE" };
    const issuedAt = toUtcInstant(Math.min(authMs, atMs));
    const proof: AssuranceProof = { proofId: request.proofId, userId: request.userId, kind: request.kind, method: request.method, issuedAt, expiresAt: toUtcInstant(Date.parse(issuedAt) + request.freshnessSeconds * 1000) };
    this.proofs.push(proof);
    if (row !== undefined) row.record = { ...row.record, stepUpProofId: proof.proofId, stepUpFreshUntil: proof.expiresAt };
    return { outcome: "RECORDED", proof };
  }

  async lockPresented(_uow: unknown, secretSha256: Sha256Hex, userId: UserId): Promise<FencedWebSession | null> {
    const row = this.#rows.get(secretSha256);
    if (row === undefined || row.record.userId !== userId) return null;
    return { revokedAt: row.record.revokedAt, idleExpiresAt: row.record.idleExpiresAt, absoluteExpiresAt: row.record.absoluteExpiresAt };
  }

  async revokeAllOf(userId: UserId, now: () => UtcInstant, reason: PersonRevocationReason, exceptSha256: string | null = null): Promise<number> {
    const at = now();
    let ended = 0;
    for (const row of this.#rows.values()) {
      if (row.record.userId !== userId || row.sha === exceptSha256 || !this.#live(row.record, at)) continue;
      row.record = { ...row.record, revokedAt: at, revokeReason: reason };
      ended += 1;
    }
    return ended;
  }

  /** Every session of a person (tests only: the PostgreSQL boundary can list none). */
  sessionsOf(userId: UserId): ReadonlyArray<WebSessionRecord> {
    return [...this.#rows.values()].filter((r) => r.record.userId === userId).map((r) => r.record);
  }
}

// --- recovery, e-mail ---------------------------------------------------------------------------------------------------------

export class InMemoryRecoveryVault implements RecoveryCodeVault {
  readonly #codes = new Map<UserId, Map<string, UtcInstant | null>>();

  async replace(userId: UserId, digests: ReadonlyArray<string>): Promise<void> {
    this.#codes.set(userId, new Map(digests.map((d) => [d, null])));
  }

  async consume(userId: UserId, digest: string, at: UtcInstant): Promise<"CONSUMED" | "UNKNOWN"> {
    const codes = this.#codes.get(userId);
    if (codes === undefined || !codes.has(digest) || codes.get(digest) !== null) return "UNKNOWN";
    codes.set(digest, at);
    return "CONSUMED";
  }

  async remaining(userId: UserId): Promise<number> {
    return [...(this.#codes.get(userId)?.values() ?? [])].filter((v) => v === null).length;
  }
}

export class InMemoryEmailChallenges implements EmailChallengeStore {
  readonly #open = new Map<UserId, EmailChallengeRecord>();

  async put(record: EmailChallengeRecord): Promise<void> {
    this.#open.set(record.userId, record);
  }

  async open(userId: UserId): Promise<EmailChallengeRecord | null> {
    return this.#open.get(userId) ?? null;
  }

  async confirm(userId: UserId, tokenSha256: string, at: UtcInstant): Promise<boolean> {
    const r = this.#open.get(userId);
    if (r === undefined || r.tokenSha256 !== tokenSha256 || r.confirmedAt !== null) return false;
    this.#open.set(userId, { ...r, confirmedAt: at });
    return true;
  }
}

export class CapturingOutbox implements EmailOutbox {
  readonly sent: Array<{ readonly to: string; readonly kind: "EMAIL_VERIFICATION"; readonly token: string; readonly expiresAt: UtcInstant }> = [];

  async send(message: { readonly to: string; readonly kind: "EMAIL_VERIFICATION"; readonly token: string; readonly expiresAt: UtcInstant }): Promise<void> {
    this.sent.push(message);
  }
}
