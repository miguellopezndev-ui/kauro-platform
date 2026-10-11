/**
 * Assurance (08 "Authentication and assurance": high-impact actions require recent step-up; the policy registry owns
 * freshness values) and admission (08 "Abuse controls": rate limiting combines identity, agency and operation; a user cannot
 * obtain a second tenant by retrying).
 *
 * The R2 policy registry carries no assurance freshness value; decision D-ASSUR-1 fixes 900 seconds for this edition and
 * names it an open question for the authority. A step-up proof is reusable inside its freshness window and is always bound to
 * the actor that obtained it.
 */
import type { CommandId, UtcInstant } from "@kauro/contracts";
import type { AgencyId, AssuranceProofId, Clock, FailureReason, UnitOfWork, UserId } from "@kauro/domain";
import { DomainFailure, beforeCommitOf, effectNowOf } from "@kauro/domain";

export const STEP_UP_FRESHNESS_SECONDS = 900;

export type AssuranceOutcome =
  | {
      readonly kind: "FRESH";
      readonly proofId: AssuranceProofId;
      readonly issuedAt: UtcInstant;
      /**
       * The first instant at which the proof no longer reads FRESH (exclusive: min(issuedAt + window + 1 ms, the proof's own expiry)). A
       * caller whose final judgment must follow this verification's own proof read judges `instant < freshUntil` at an instant it read
       * after that read (TIME-AFTER-AWAIT, PV1R-03). Absent: the verifier gives no bound and such a caller refuses.
       */
      readonly freshUntil?: UtcInstant;
    }
  | { readonly kind: "STALE"; readonly reason: Extract<FailureReason, "STEP_UP_STALE"> }
  | { readonly kind: "MISSING"; readonly reason: Extract<FailureReason, "STEP_UP_MISSING" | "STEP_UP_NOT_OWNED"> };

export interface AssuranceVerifier {
  /** Verifies that `proofRef` is a step-up proof of `userId` issued within STEP_UP_FRESHNESS_SECONDS of `now`. */
  verifyStepUp(uow: UnitOfWork, userId: UserId, proofRef: AssuranceProofId | undefined, now: UtcInstant): Promise<AssuranceOutcome>;
}

export type AdmissionSubject = { readonly userId: UserId; readonly agencyId: AgencyId | null; readonly clientAddressHash?: string };

export type Admission =
  | { readonly kind: "ADMITTED" }
  | { readonly kind: "LIMITED"; readonly reason: Extract<FailureReason, "CREATION_RATE_LIMITED" | "DRAFT_AGENCY_EXISTS">; readonly retryAfterSeconds?: number };

export interface AbuseLimiter {
  /** Decides before the command runs; the structural limits (one DRAFT agency per creator) are additionally enforced by the database. */
  admit(operation: CommandId, subject: AdmissionSubject, now: UtcInstant): Promise<Admission>;
}

/**
 * The step-up judged at the database's effect instant (or the process clock if later) and again at COMMIT (STEPUP-AT-COMMIT; the PV1R-01/03 pattern of the bank-transfer
 * route). The proof is read first (the verifier's own I/O), THEN the unit's effect clock is read and the proof's window (`freshUntil`,
 * exclusive) is judged at that last instant, so a proof that crossed its boundary while the read waited is not FRESH. A FRESH outcome
 * registers the same judgment (proof read again, clock read again) immediately before COMMIT, in the same transaction: a proof that
 * expires between this check and the commit rolls the whole unit back with ASSURANCE_REQUIRED (STEP_UP_STALE), nothing committed. A
 * non-FRESH outcome is returned for the caller to refuse in its own words; no commit check is registered for it.
 * Fails closed (INTEGRITY_FAILURE) on a unit of work with no effect clock or no commit hook.
 */
export async function assureStepUpAtCommit(uow: UnitOfWork, assurance: AssuranceVerifier, userId: UserId, proofRef: AssuranceProofId | undefined, clock: Clock): Promise<AssuranceOutcome> {
  // the judged instant is the LATER of the database's effect clock and the process clock (fail closed on skew: either clock past the
  // proof's window makes it stale; in a deployment the two agree to the skew)
  const instant = async (): Promise<UtcInstant> => new Date(Math.max(Date.parse(await effectNowOf(uow)), clock.nowMs())).toISOString() as UtcInstant;
  const judge = async (): Promise<AssuranceOutcome> => {
    const outcome = await assurance.verifyStepUp(uow, userId, proofRef, await instant());
    const at = await instant();
    // no await below this line: the judgment is at this one instant
    if (outcome.kind !== "FRESH") return outcome;
    if (outcome.freshUntil === undefined || !(Date.parse(at) < Date.parse(outcome.freshUntil))) return { kind: "STALE", reason: "STEP_UP_STALE" };
    return outcome;
  };
  const outcome = await judge();
  if (outcome.kind !== "FRESH") return outcome;
  beforeCommitOf(uow, async () => {
    const atCommit = await judge();
    if (atCommit.kind !== "FRESH") throw new DomainFailure("ASSURANCE_REQUIRED", `the step-up is no longer fresh at the commit: ${atCommit.reason}`, { reason: atCommit.reason });
  });
  return outcome;
}
