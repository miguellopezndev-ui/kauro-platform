/**
 * The session and step-up service of the browser boundary (B11 design D-AUTH-1..4; 08 "Authentication and assurance",
 * "Identity is not permission", "Audit events and retention").
 *
 *  open    — POST /api/v1/sessions, after the route admitted the body and checked the Origin: the identity token is verified by the
 *            api (every defect is the one 401 IDENTITY_TOKEN_INVALID and an anonymous DENY fact; an unreachable key source is a
 *            retryable 503); a proven account with an unverified e-mail is 403 ASSURANCE_REQUIRED / EMAIL_NOT_VERIFIED; otherwise the
 *            request handlers record the identity reference (first sight) and the token's verification facts under the person's
 *            own context, the authentication boundary records the session (its secret's SHA-256 only), and the opening is an
 *            ALLOW fact of the person's stream. The answer is the same for a person the platform has never seen, a disabled one
 *            and a known one (R2-134): the view names the person and the session, never what the platform knows of them — a
 *            DISABLED identity is refused by every read and command that follows (the authorizer reads the stored status).
 *  resume  — every request that presents the cookie: the live session of that secret (not revoked, before its idle and
 *            absolute deadlines), its last-seen moved at most once a minute; the authenticated subject is the session's person
 *            with the facts its token proved at sign-in. No session is cached across requests: a revocation takes effect on the
 *            next one.
 *  revoke  — POST /api/v1/sessions/current/revoke: ends the session once (an ALLOW fact of the person's stream); a repeated
 *            logout, one of an expired session and one without a cookie are the same clearing answer.
 *  stepUp  — POST /api/v1/assurance/step-ups: a re-authentication token of the caller's own person, with its second factor, at
 *            most 300 s old, becomes a B06 STEP_UP proof written by the authentication boundary (kauro_assurance, D-EVID-1) and,
 *            for a cookie session, that session's latest step-up; CMD025 cites it as assuranceProofRef. Refusals are
 *            ASSURANCE_REQUIRED (STEP_UP_NOT_OWNED, STEP_UP_MISSING, STEP_UP_STALE) and DENY facts of the caller's stream.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AssuranceProofId, Clock, CorrelationId, IdGenerator, IdentityFacts, RandomBytes, UnitOfWorkFactory, UserId } from "@kauro/domain";
import { DomainFailure, identityUserId, subjectDigest, toUtcInstant } from "@kauro/domain";
import type { AuthenticatedSubject } from "../api/envelope.js";
import { problemOf, type Problem } from "../api/problems.js";
import { recordDenialFact, recordIdentityFact, refuseAnonymously } from "../commands/runtime.js";
import { STEP_UP_FRESHNESS_SECONDS } from "../ports/assurance-and-admission.js";
import type { IdentityTokenVerifier, VerifiedIdentityToken, WebSessionRecord, WebSessionStore } from "../ports/sessions.js";
import { SESSION_POLICY, csrfTokenOf, mintSessionSecret, sessionSecretDigest } from "./protocol.js";

/** The policy version every fact of this boundary names (08 "Audit events": policy version is recorded). */
export const SESSION_POLICY_VERSION = "B11-SESSION-1";

/** The action tokens of this boundary's security facts. */
export const SESSION_ACTIONS = Object.freeze({ open: "SESSION_OPEN", revoke: "SESSION_REVOKE", stepUp: "STEP_UP_ISSUE" });

/** The reason tokens of its ALLOW facts. */
export const SESSION_ALLOW_REASONS = Object.freeze({ opened: "SESSION_OPENED", revoked: "SESSION_REVOKED", stepUpIssued: "STEP_UP_ISSUED" });

/** The revocation reason a logout records. */
export const LOGOUT_REASON = "LOGOUT";

/** The revocation reason of a session the same browser replaced by signing in again (its cookie came with the sign-in). */
export const REPLACED_REASON = "REPLACED";

/** The closed view of a session (D-AUTH-4): the person and the session, with the CSRF token of this session. */
export interface SessionView {
  readonly userId: UserId;
  readonly emailVerified: boolean;
  readonly mfaEnrolled: boolean;
  /** When the sign-in's second factor was performed, or null. */
  readonly mfaAt: UtcInstant | null;
  /** Until when the session's latest step-up proof is fresh, or null when it has none or it aged. */
  readonly stepUpFreshUntil: UtcInstant | null;
  readonly idleExpiresAt: UtcInstant;
  readonly absoluteExpiresAt: UtcInstant;
  readonly csrfToken: string;
}

/** The reply of a step-up: the proof CMD025 cites and when it stops being fresh. */
export interface StepUpProofView {
  readonly proofId: AssuranceProofId;
  readonly expiresAt: UtcInstant;
}

export interface SessionServiceDependencies {
  /** The request handlers' unit of work (kauro_app): the identity reference and the security facts. */
  readonly unitOfWork: UnitOfWorkFactory;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: RandomBytes;
  readonly verifier: IdentityTokenVerifier;
  /** The authentication boundary's store (kauro_assurance). */
  readonly store: WebSessionStore;
}

export type SessionOutcome<T> = { readonly kind: "OK"; readonly value: T } | { readonly kind: "PROBLEM"; readonly problem: Problem };

export interface ResumedSession {
  readonly subject: AuthenticatedSubject;
  readonly session: WebSessionRecord;
}

/**
 * A session judged under its row lock (FAILURE-MATRIX-TEMPLATE rule 16): the holder reads its clock after the lock was granted, judges
 * `liveAt` at that instant, completes its effect and only then calls `release`; a revocation that began after the lock waits until then.
 */
export interface HeldSession extends ResumedSession {
  /** Not revoked, before the idle and the absolute deadlines of the row as locked. */
  liveAt(nowMs: number): boolean;
  release(): Promise<void>;
}

export interface SessionService {
  /** `replacing`: the secret of the session cookie the sign-in request carried, which the new session replaces (ended once open). */
  open(request: { readonly correlationId: CorrelationId; readonly idToken: string; readonly replacing?: string | null }): Promise<SessionOutcome<{ readonly secret: string; readonly view: SessionView }>>;
  /** The live session of a secret and its subject, or null; moves last-seen at most once a minute. */
  resume(secret: string): Promise<ResumedSession | null>;
  /** The session of a secret under its row lock until `release` (touched as `resume` touches), or null when no session has that secret. */
  hold(secret: string): Promise<HeldSession | null>;
  viewOf(secret: string, session: WebSessionRecord): SessionView;
  revoke(request: { readonly correlationId: CorrelationId; readonly secret: string | null }): Promise<SessionOutcome<null>>;
  stepUp(request: { readonly correlationId: CorrelationId; readonly subject: AuthenticatedSubject; readonly secret: string | null; readonly idToken: string }): Promise<SessionOutcome<StepUpProofView>>;
}

const tokenInvalid = (): DomainFailure => new DomainFailure("AUTHENTICATION_REQUIRED", "the identity token was refused", { reason: "IDENTITY_TOKEN_INVALID" });
const keysUnavailable = (): DomainFailure => new DomainFailure("CAPACITY_UNAVAILABLE", "the identity key source is unavailable", { retryAfterSeconds: 1 }, true);

function plusSeconds(instant: UtcInstant, seconds: number): UtcInstant {
  return toUtcInstant(Date.parse(instant) + seconds * 1000);
}

function earlier(a: UtcInstant, b: UtcInstant): UtcInstant {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** The identity facts a verified token proves (08: facts, never permissions; the stored security status is the authorizer's). */
function factsOf(token: VerifiedIdentityToken, userId: UserId): IdentityFacts {
  return {
    userId,
    emailVerifiedAt: token.emailVerified ? token.issuedAt : null,
    mfaEnrolledAt: token.secondFactor !== null ? token.authTime : null,
    state: "ACTIVE",
  };
}

/** The authenticated subject of a session: its person with the facts its token proved at sign-in. */
function subjectOfSession(session: WebSessionRecord): AuthenticatedSubject {
  return {
    identity: { userId: session.userId, emailVerifiedAt: session.emailVerifiedAt, mfaEnrolledAt: session.mfaAt, state: "ACTIVE" },
    provider: session.provider,
    subjectHash: session.subjectHash,
  };
}

function isLive(session: WebSessionRecord, nowMs: number): boolean {
  return session.revokedAt === null && nowMs < Date.parse(session.idleExpiresAt) && nowMs < Date.parse(session.absoluteExpiresAt);
}

export function createSessionService(deps: SessionServiceDependencies): SessionService {
  const runtime = { unitOfWork: deps.unitOfWork, clock: deps.clock };

  const outcomeOf = async <T>(correlationId: CorrelationId, work: () => Promise<SessionOutcome<T>>): Promise<SessionOutcome<T>> => {
    try {
      return await work();
    } catch (e) {
      if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
      return { kind: "PROBLEM", problem: problemOf(e, correlationId) };
    }
  };

  const viewOf = (secret: string, session: WebSessionRecord): SessionView => {
    const nowMs = deps.clock.nowMs();
    const fresh = session.stepUpFreshUntil !== null && nowMs < Date.parse(session.stepUpFreshUntil) ? session.stepUpFreshUntil : null;
    return {
      userId: session.userId,
      emailVerified: session.emailVerifiedAt !== null,
      mfaEnrolled: session.mfaAt !== null,
      mfaAt: session.mfaAt,
      stepUpFreshUntil: fresh,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      csrfToken: csrfTokenOf(secret),
    };
  };

  return {
    viewOf,

    open: ({ correlationId, idToken, replacing = null }) =>
      outcomeOf(correlationId, async () => {
        const verification = await deps.verifier.verify(idToken);
        if (verification.kind === "UNAVAILABLE") throw keysUnavailable();
        if (verification.kind === "REJECTED") {
          return { kind: "PROBLEM", problem: await refuseAnonymously(runtime, SESSION_ACTIONS.open, { correlationId, agencyId: null }, tokenInvalid(), SESSION_POLICY_VERSION) };
        }
        const token = verification.token;
        const userId = identityUserId(token.provider, token.subject);
        if (!token.emailVerified) {
          const failure = new DomainFailure("ASSURANCE_REQUIRED", "the account's e-mail is not verified", { reason: "EMAIL_NOT_VERIFIED" });
          await recordDenialFact(runtime, { kind: "IDENTITY", userId, correlationId }, SESSION_ACTIONS.open, correlationId, failure, SESSION_POLICY_VERSION);
          throw failure;
        }
        const facts = factsOf(token, userId);
        const subjectHash = subjectDigest(token.subject);
        const now = deps.clock.now();
        // the request handlers record the identity reference and the token's facts, never the security status (N1)
        await deps.unitOfWork.run({ kind: "IDENTITY", userId, correlationId }, (uow) => uow.identities.syncOwn(facts, token.provider, subjectHash, now));
        const secret = mintSessionSecret(deps.random);
        const absolute = plusSeconds(now, SESSION_POLICY.absoluteSeconds);
        const session: WebSessionRecord = {
          sessionId: deps.ids.next(),
          userId,
          provider: token.provider,
          subjectHash,
          emailVerifiedAt: facts.emailVerifiedAt,
          mfaAt: facts.mfaEnrolledAt,
          createdAt: now,
          lastSeenAt: now,
          idleExpiresAt: earlier(plusSeconds(now, SESSION_POLICY.idleSeconds), absolute),
          absoluteExpiresAt: absolute,
          stepUpProofId: null,
          stepUpFreshUntil: null,
          revokedAt: null,
          revokeReason: null,
        };
        const { stepUpProofId: _p, stepUpFreshUntil: _f, revokedAt: _r, revokeReason: _q, ...opening } = session;
        await deps.store.open(opening, sessionSecretDigest(secret), correlationId);
        await recordIdentityFact(runtime, { userId, action: SESSION_ACTIONS.open, outcome: "ALLOW", reasonCode: SESSION_ALLOW_REASONS.opened, assuranceClass: "SESSION", policyVersion: SESSION_POLICY_VERSION, correlationId });
        // the browser holds one session: the one its cookie named before this sign-in ends now (no session outlives its cookie)
        if (replacing !== null) {
          const ended = await deps.store.revoke(sessionSecretDigest(replacing), now, REPLACED_REASON);
          if (ended.outcome === "REVOKED") {
            await recordIdentityFact(runtime, { userId: ended.userId, action: SESSION_ACTIONS.revoke, outcome: "ALLOW", reasonCode: SESSION_ALLOW_REASONS.revoked, assuranceClass: "SESSION", policyVersion: SESSION_POLICY_VERSION, correlationId });
          }
        }
        return { kind: "OK", value: { secret, view: viewOf(secret, session) } };
      }),

    async resume(secret) {
      const session = await deps.store.resume(sessionSecretDigest(secret), () => deps.clock.now(), SESSION_POLICY.idleSeconds, SESSION_POLICY.touchSeconds);
      // liveness judged at an instant read after the store returned (TIME-AFTER-AWAIT, PV1R-02 r2): a session that expires while the store
      // waits (its connection, its statement) is ended, never judged at a sample taken before the wait
      if (session === null || !isLive(session, Date.parse(deps.clock.now()))) return null;
      return { subject: subjectOfSession(session), session };
    },

    async hold(secret) {
      const held = await deps.store.hold(sessionSecretDigest(secret), () => deps.clock.now(), SESSION_POLICY.idleSeconds, SESSION_POLICY.touchSeconds);
      if (held === null) return null;
      const session = held.session;
      return { subject: subjectOfSession(session), session, liveAt: (nowMs) => isLive(session, nowMs), release: () => held.release() };
    },

    revoke: ({ correlationId, secret }) =>
      outcomeOf(correlationId, async () => {
        if (secret === null) return { kind: "OK", value: null };
        // the person the fact names is the session's; a secret that names no session, or one already ended, records nothing
        const revoked = await deps.store.revoke(sessionSecretDigest(secret), deps.clock.now(), LOGOUT_REASON);
        if (revoked.outcome === "REVOKED") {
          await recordIdentityFact(runtime, { userId: revoked.userId, action: SESSION_ACTIONS.revoke, outcome: "ALLOW", reasonCode: SESSION_ALLOW_REASONS.revoked, assuranceClass: "SESSION", policyVersion: SESSION_POLICY_VERSION, correlationId });
        }
        return { kind: "OK", value: null };
      }),

    stepUp: ({ correlationId, subject, secret, idToken }) =>
      outcomeOf(correlationId, async () => {
        const userId = subject.identity.userId;
        const refuse = async (failure: DomainFailure): Promise<never> => {
          await recordDenialFact(runtime, { kind: "IDENTITY", userId, correlationId }, SESSION_ACTIONS.stepUp, correlationId, failure, SESSION_POLICY_VERSION);
          throw failure;
        };
        const verification = await deps.verifier.verify(idToken);
        if (verification.kind === "UNAVAILABLE") throw keysUnavailable();
        if (verification.kind === "REJECTED") return refuse(tokenInvalid());
        const token = verification.token;
        if (identityUserId(token.provider, token.subject) !== userId) {
          return refuse(new DomainFailure("ASSURANCE_REQUIRED", "the re-authentication is another person's", { reason: "STEP_UP_NOT_OWNED" }));
        }
        if (token.secondFactor === null) return refuse(new DomainFailure("ASSURANCE_REQUIRED", "the re-authentication has no second factor", { reason: "STEP_UP_MISSING" }));
        const now = deps.clock.now();
        if (Date.parse(now) - Date.parse(token.authTime) > SESSION_POLICY.stepUpReauthenticationSeconds * 1000) {
          return refuse(new DomainFailure("ASSURANCE_REQUIRED", "the re-authentication is too old", { reason: "STEP_UP_STALE" }));
        }
        // the proof is the re-authentication itself: issued when the person re-authenticated (never later than now), fresh for
        // the B06 window (D-ASSUR-1)
        const issuedAt = earlier(token.authTime, now);
        const proof = {
          proofId: deps.ids.next() as AssuranceProofId,
          userId,
          kind: "STEP_UP" as const,
          method: token.secondFactor === "totp" ? ("TOTP" as const) : ("IDP_REAUTH" as const),
          issuedAt,
          expiresAt: plusSeconds(issuedAt, STEP_UP_FRESHNESS_SECONDS),
        };
        await deps.store.recordStepUp(proof, correlationId, now, secret === null ? null : sessionSecretDigest(secret));
        await recordIdentityFact(runtime, { userId, action: SESSION_ACTIONS.stepUp, outcome: "ALLOW", reasonCode: SESSION_ALLOW_REASONS.stepUpIssued, assuranceClass: "STEP_UP", policyVersion: SESSION_POLICY_VERSION, correlationId });
        return { kind: "OK", value: { proofId: proof.proofId, expiresAt: proof.expiresAt } };
      }),
  };
}
