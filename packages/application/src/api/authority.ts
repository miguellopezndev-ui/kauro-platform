/**
 * The request's own credential as an authority judged under the lock of its writer (FAILURE-MATRIX-TEMPLATE rule 16; Codex r3 PV1R-02,
 * PV1R-07). An effect that a cookie session authorizes is decided under the session row's lock, the one its revocation and every touch
 * take: the transport's RequestAuthority locks the row (`hold`), the caller THEN reads its clock, THEN judges `liveAt` at that instant,
 * THEN completes its effect (its view built, its unit committed), and only then does the transport release the lock. A revocation that
 * committed before the lock is seen; one that starts after it waits until the effect is complete — reordering awaits is not a fix.
 *
 * Lock order: the session row is the LAST lock an effect takes (access -> journal -> project -> subject -> route -> quote -> session): its
 * holder waits on no other row once it holds it, and the session's writers (revoke, touch, step-up) hold no other row.
 */
import type { Clock } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";

/** A credential as held: whether it still authenticates the request's subject at an instant the caller read AFTER the hold was granted. */
export interface CredentialHold {
  liveAt(nowMs: number): boolean;
}

/** The request's credential authority (the transport owns it and releases every hold once the request's work returned). */
export interface RequestAuthority {
  /**
   * A cookie session: its row locked (FOR UPDATE) and touched as a resume touches, held until the transport releases it; a bearer credential:
   * verified again as it stands. Null when the credential no longer authenticates the request's subject.
   */
  hold(): Promise<CredentialHold | null>;
}

/** The refusal of an effect whose session ended (revoked, idle or absolute deadline) before its judgment: the unauthenticated answer. */
export function credentialEnded(): DomainFailure {
  return new DomainFailure("AUTHENTICATION_REQUIRED", "the request's credential no longer authenticates it");
}

/**
 * Takes the hold, THEN reads `clock`, THEN judges: throws credentialEnded when the credential no longer authenticates the subject at an
 * instant read after the lock was granted. `between` runs after the lock and before the instant (the caller's effect-clock read and the
 * judgments taken at it), so the session is judged at the last instant before the effect. Nothing is held when `authority` is undefined
 * (an in-process caller with no transport credential).
 */
export async function judgedUnderHold(authority: RequestAuthority | undefined, clock: Clock, between: () => Promise<void> = async () => undefined): Promise<void> {
  if (authority === undefined) {
    await between();
    return;
  }
  const held = await authority.hold();
  if (held === null) throw credentialEnded();
  await between();
  if (!held.liveAt(clock.nowMs())) throw credentialEnded();
}
