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
import type { AgencyId, AssuranceProofId, FailureReason, UnitOfWork, UserId } from "@kauro/domain";

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
