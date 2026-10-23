/**
 * The step-up policy of sensitive actions (O23A; 08 "Authentication and assurance": sensitive actions require a fresh second
 * factor; B11 SESSION_POLICY.stepUpReauthenticationSeconds; ASVS 4.0.3 V4.3.1 / V2.8). Pure: it judges the session the boundary
 * resumed at an instant the caller reads after its last await, and answers why a step-up is needed.
 *
 *  - every sensitive action needs a verified e-mail and an enrolled second factor (the session's sign-in mfaAt);
 *  - each action names how fresh the proof must be: a step-up proof of this session that is still fresh, or, for the actions that
 *    accept it, a second-factor sign-in at most `signInMaxAgeSeconds` old;
 *  - a session without a live step-up is STEP_UP_MISSING; one whose proof aged is STEP_UP_STALE.
 */
import type { WebSessionRecord } from "@kauro/application";

export type SensitiveAction =
  | "PAYMENT_AUTHORIZE"
  | "MEMBERSHIP_ROLE_CHANGE"
  | "MFA_CHANGE"
  | "RECOVERY_CODES_REGENERATE"
  | "EMAIL_CHANGE"
  | "DATA_EXPORT"
  | "ACCOUNT_DELETE"
  | "SESSIONS_REVOKE_ALL";

export interface StepUpRule {
  /** A second-factor sign-in at most this old also satisfies the rule (null: only an explicit step-up proof does). */
  readonly signInMaxAgeSeconds: number | null;
}

export const STEP_UP_RULES: Readonly<Record<SensitiveAction, StepUpRule>> = Object.freeze({
  PAYMENT_AUTHORIZE: { signInMaxAgeSeconds: null },
  MEMBERSHIP_ROLE_CHANGE: { signInMaxAgeSeconds: null },
  MFA_CHANGE: { signInMaxAgeSeconds: null },
  RECOVERY_CODES_REGENERATE: { signInMaxAgeSeconds: null },
  EMAIL_CHANGE: { signInMaxAgeSeconds: null },
  ACCOUNT_DELETE: { signInMaxAgeSeconds: null },
  DATA_EXPORT: { signInMaxAgeSeconds: 300 },
  SESSIONS_REVOKE_ALL: { signInMaxAgeSeconds: 300 },
});

export type StepUpReason = "EMAIL_NOT_VERIFIED" | "MFA_NOT_ENROLLED" | "STEP_UP_MISSING" | "STEP_UP_STALE";

export type StepUpDecision = { readonly kind: "ALLOWED"; readonly by: "STEP_UP_PROOF" | "RECENT_MFA_SIGN_IN" } | { readonly kind: "STEP_UP_REQUIRED"; readonly reason: StepUpReason };

export type StepUpSession = Pick<WebSessionRecord, "emailVerifiedAt" | "mfaAt" | "stepUpProofId" | "stepUpFreshUntil" | "revokedAt">;

export function judgeStepUp(session: StepUpSession, action: SensitiveAction, nowMs: number): StepUpDecision {
  if (session.revokedAt !== null) throw new Error("a revoked session is never judged for a step-up: the boundary refuses it first");
  if (session.emailVerifiedAt === null) return { kind: "STEP_UP_REQUIRED", reason: "EMAIL_NOT_VERIFIED" };
  if (session.mfaAt === null) return { kind: "STEP_UP_REQUIRED", reason: "MFA_NOT_ENROLLED" };
  if (session.stepUpFreshUntil !== null && nowMs < Date.parse(session.stepUpFreshUntil)) return { kind: "ALLOWED", by: "STEP_UP_PROOF" };
  const rule = STEP_UP_RULES[action];
  if (rule.signInMaxAgeSeconds !== null && nowMs - Date.parse(session.mfaAt) <= rule.signInMaxAgeSeconds * 1000) return { kind: "ALLOWED", by: "RECENT_MFA_SIGN_IN" };
  return { kind: "STEP_UP_REQUIRED", reason: session.stepUpProofId === null ? "STEP_UP_MISSING" : "STEP_UP_STALE" };
}
