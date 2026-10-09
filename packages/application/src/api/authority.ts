/**
 * The request's own credential as an authority fenced inside the effect's own transaction (FAILURE-MATRIX-TEMPLATE rule 16; Codex r4
 * PV1R-07, docs/review/pv1-route-pv1r07-design.md). An effect that a cookie session authorizes is decided under the session row's lock, the one
 * its revocation and every touch take, taken FOR SHARE by the unit of work that commits the effect (or builds the view): the transport's
 * RequestAuthority locks the row in that unit (`hold(uow)`), the caller THEN reads its clock, THEN judges `liveAt` at that instant, THEN completes
 * its effect, and the unit's COMMIT is the release. A revocation that committed before the lock is seen; one that starts after it waits until
 * the unit ends; a lost backend loses the lock and the effect together.
 *
 * Lock order: the session row is the LAST lock an effect takes (access -> journal -> project -> subject -> route -> quote -> session): its
 * holder waits on no other row once it holds it (only plain reads and COMMIT follow), and the session's writers hold no app lock.
 */
import type { Clock, UnitOfWork } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";

/** A credential as held: whether it still authenticates the request's subject at an instant the caller read AFTER the hold was granted. */
export interface CredentialHold {
  liveAt(nowMs: number): boolean;
}

/** The request's credential authority (the transport owns it). */
export interface RequestAuthority {
  /**
   * A cookie session: its row locked FOR SHARE inside `uow`'s own transaction and returned as locked; a bearer credential: verified again as
   * it stands. Null when the credential no longer authenticates the request's subject. Taking it twice in one unit re-locks in the same
   * transaction (a transaction never waits on its own lock).
   */
  hold(uow: UnitOfWork): Promise<CredentialHold | null>;
}

/** The refusal of an effect whose session ended (revoked, idle or absolute deadline) before its judgment: the unauthenticated answer. */
export function credentialEnded(): DomainFailure {
  return new DomainFailure("AUTHENTICATION_REQUIRED", "the request's credential no longer authenticates it");
}

/**
 * Takes the fence in `uow`, THEN reads `between`, THEN `clock`, and judges: throws credentialEnded when the credential no longer authenticates
 * the subject at an instant read after the lock was granted. `between` runs after the lock and before the instant (the caller's effect-clock
 * read and the judgments taken at it), so the session is judged at the last instant before the effect. Nothing is locked when `authority` is
 * undefined (an in-process caller with no transport credential).
 */
export async function judgedUnderHold(authority: RequestAuthority | undefined, uow: UnitOfWork, clock: Clock, between: () => Promise<void> = async () => undefined): Promise<void> {
  if (authority === undefined) {
    await between();
    return;
  }
  const held = await authority.hold(uow);
  if (held === null) throw credentialEnded();
  await between();
  if (!held.liveAt(clock.nowMs())) throw credentialEnded();
}
