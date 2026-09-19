/**
 * Identity aggregate (07 "Aggregate ownership": Identity owns authentication references, verification and security status;
 * 08 "Identity is not permission": authentication produces an identity reference and assurance facts, membership and role
 * capabilities are resolved server-side for each consequential operation; 08 "Authentication and assurance": agency data
 * access requires verified email and enrolled MFA under the launch policy; high-impact actions require recent step-up).
 *
 * The record holds no credential, token or raw provider subject: user_id is UUIDv5(provider, subject) (decision D-ID-2) and
 * the subject is kept only as its SHA-256 (migration 0002 identities.subject_hash). Verification facts are what the
 * authenticator reported at the last sync; they are facts, never permissions (08).
 */
import { createHash } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DomainFailure, type FailureReason, NotAuthorizedFailure } from "./errors.js";
import { instantMs } from "./fields.js";
import { identityUserId, type AssuranceProofId, type UserId } from "./ids.js";
import { type IdentityFacts, isVerifiedIdentity } from "./tenant.js";

export type IdentityState = IdentityFacts["state"];
export const IDENTITY_STATES: ReadonlyArray<IdentityState> = ["ACTIVE", "DISABLED"];

export interface IdentityRecord extends IdentityFacts {
  readonly provider: string;
  readonly subjectHash: Sha256Hex;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** What the authenticator reports about a person at each request (08: assurance facts, produced by Identity Platform). */
export interface AuthenticatedSubject {
  readonly provider: string;
  readonly subject: string;
  readonly emailVerifiedAt: UtcInstant | null;
  readonly mfaEnrolledAt: UtcInstant | null;
  readonly state: IdentityState;
}

export function subjectDigest(subject: string): Sha256Hex {
  return createHash("sha256").update(subject, "utf8").digest("hex");
}

/** First sight of a person: the record derives its id and keeps only the subject digest. */
export function registerIdentity(subject: AuthenticatedSubject, now: UtcInstant): IdentityRecord {
  const userId = identityUserId(subject.provider, subject.subject);
  return Object.freeze({
    userId,
    provider: subject.provider,
    subjectHash: subjectDigest(subject.subject),
    state: subject.state,
    emailVerifiedAt: subject.emailVerifiedAt,
    mfaEnrolledAt: subject.mfaEnrolledAt,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Later sight: the verification facts follow the authenticator (an un-enrolled MFA is reported as such; a stale cached grant
 * is never reused, 07 "authorized_reactivation"). The identity reference itself never changes: a different provider/subject
 * is a different person and is refused as an integrity failure rather than silently re-pointed.
 */
export function syncIdentity(record: IdentityRecord, subject: AuthenticatedSubject, now: UtcInstant): IdentityRecord {
  const userId = identityUserId(subject.provider, subject.subject);
  if (userId !== record.userId) throw new DomainFailure("INTEGRITY_FAILURE", "identity sync addressed another person");
  return Object.freeze({ ...record, state: subject.state, emailVerifiedAt: subject.emailVerifiedAt, mfaEnrolledAt: subject.mfaEnrolledAt, updatedAt: now });
}

export function identityFacts(record: IdentityRecord): IdentityFacts {
  return { userId: record.userId, emailVerifiedAt: record.emailVerifiedAt, mfaEnrolledAt: record.mfaEnrolledAt, state: record.state };
}

/** The launch policy as a refusal: DISABLED beats UNVERIFIED (a disabled account never learns what else it lacks). */
export function assertVerifiedIdentity(facts: IdentityFacts): IdentityFacts {
  if (facts.state === "DISABLED") throw new NotAuthorizedFailure("IDENTITY_DISABLED", `identity ${facts.userId} is disabled`);
  if (!isVerifiedIdentity(facts)) throw new NotAuthorizedFailure("IDENTITY_UNVERIFIED", `identity ${facts.userId} lacks verified email or enrolled MFA`);
  return facts;
}

// --- step-up assurance ---------------------------------------------------------------------------------------------------

export const ASSURANCE_METHODS = ["TOTP", "WEBAUTHN", "IDP_REAUTH"] as const;
export type AssuranceMethod = (typeof ASSURANCE_METHODS)[number];

/** A recorded step-up (table kauro.assurance_proofs; append-only). */
export interface AssuranceProof {
  readonly proofId: AssuranceProofId;
  readonly userId: UserId;
  readonly kind: "STEP_UP";
  readonly method: AssuranceMethod;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export type StepUpOutcome =
  | { readonly kind: "FRESH"; readonly proofId: AssuranceProofId; readonly issuedAt: UtcInstant }
  | { readonly kind: "STALE"; readonly reason: Extract<FailureReason, "STEP_UP_STALE"> }
  | { readonly kind: "MISSING"; readonly reason: Extract<FailureReason, "STEP_UP_MISSING" | "STEP_UP_NOT_OWNED"> };

export interface StepUpCheck {
  /** The proof the caller referenced (null when absent or not visible under the self policy). */
  readonly proof: AssuranceProof | null;
  /** The actor of the command; a proof of anybody else is refused as not owned (a proof is bound to its actor, D-ASSUR-1). */
  readonly userId: UserId;
  readonly now: UtcInstant;
  /** Freshness window of the policy (D-ASSUR-1: 900 s in this edition; the policy registry owns the value). */
  readonly freshnessSeconds: number;
}

/**
 * Pure step-up evaluation: a proof is fresh when it is a STEP_UP of this actor, issued at or before now, not yet expired,
 * and issued within the freshness window. A proof issued in the future is not recent (clock skew is never trusted).
 */
export function evaluateStepUp(check: StepUpCheck): StepUpOutcome {
  if (!Number.isFinite(check.freshnessSeconds) || check.freshnessSeconds <= 0) throw new RangeError("freshnessSeconds must be positive");
  const proof = check.proof;
  if (proof === null) return { kind: "MISSING", reason: "STEP_UP_MISSING" };
  if (proof.userId !== check.userId) return { kind: "MISSING", reason: "STEP_UP_NOT_OWNED" };
  if (proof.kind !== "STEP_UP") return { kind: "MISSING", reason: "STEP_UP_MISSING" };
  const now = instantMs(check.now);
  const issued = instantMs(proof.issuedAt);
  const expires = instantMs(proof.expiresAt);
  if (issued > now) return { kind: "STALE", reason: "STEP_UP_STALE" };
  if (now >= expires) return { kind: "STALE", reason: "STEP_UP_STALE" };
  if (now - issued > check.freshnessSeconds * 1000) return { kind: "STALE", reason: "STEP_UP_STALE" };
  return { kind: "FRESH", proofId: proof.proofId, issuedAt: proof.issuedAt };
}

/** Raises ASSURANCE_REQUIRED with the narrowing reason unless the proof is fresh. */
export function assertFreshStepUp(check: StepUpCheck): Extract<StepUpOutcome, { kind: "FRESH" }> {
  const outcome = evaluateStepUp(check);
  if (outcome.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `step-up ${outcome.reason.toLowerCase()} for ${check.userId}`, { reason: outcome.reason });
  return outcome;
}
