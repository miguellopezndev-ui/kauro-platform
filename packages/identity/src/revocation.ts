/**
 * The revocation of every session of a person (O23A; 08 "Browser, API and cache isolation": revocation invalidates server-side
 * access immediately; ASVS 4.0.3 V3.3.3/V3.3.4: after a credential change the person can end every other session, and a
 * recovery, a second-factor change or a provider-reported credential change ends them all).
 *
 * The port is the authentication boundary's (kauro_assurance): the person its transaction binds, never another one. The
 * PostgreSQL implementation is migration 0150 (kauro.revoke_person_web_sessions); the in-memory one is @kauro/identity/testing.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { UserId } from "@kauro/domain";

/** Why every session of a person ended (revoke_reason tokens). */
export type PersonRevocationReason = "RECOVERY" | "CREDENTIAL_CHANGED" | "MFA_CHANGED" | "SIGN_OUT_EVERYWHERE" | "ACCOUNT_DISABLED";

export interface PersonSessionRevoker {
  /**
   * Ends every live session of `userId` at the instant `now` returns, read after the rows are locked; `exceptSha256` keeps the one
   * session the person acts from (SIGN_OUT_EVERYWHERE from this browser). Answers how many sessions ended.
   */
  revokeAllOf(userId: UserId, now: () => UtcInstant, reason: PersonRevocationReason, exceptSha256?: string | null): Promise<number>;
}

/** The revocations that end the acting session as well (only SIGN_OUT_EVERYWHERE may keep it). */
export function endsActingSession(reason: PersonRevocationReason): boolean {
  return reason !== "SIGN_OUT_EVERYWHERE";
}
