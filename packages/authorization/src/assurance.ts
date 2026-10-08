/**
 * Step-up assurance verification (08 "Authentication and assurance": high-impact actions require recent step-up; the policy
 * registry owns assurance freshness values — decision D-ASSUR-1 fixes 900 seconds for this edition, open question Q1).
 *
 * A proof is FRESH when it is a STEP_UP proof of the acting user, issued within STEP_UP_FRESHNESS_SECONDS of now, and not past
 * its own expiry. A proof of another user reads as null under the self policy and is reported as STEP_UP_NOT_OWNED only when
 * the reference is well-formed; an absent reference is STEP_UP_MISSING; an old proof is STEP_UP_STALE. The proof is reusable
 * inside its window: a second approval within 900 seconds does not require a new challenge.
 */
import type { AssuranceOutcome, AssuranceVerifier } from "@kauro/application";
import { STEP_UP_FRESHNESS_SECONDS } from "@kauro/application";
import type { UtcInstant } from "@kauro/contracts";
import { isUuidV7 } from "@kauro/domain";

export function createAssuranceVerifier(freshnessSeconds: number = STEP_UP_FRESHNESS_SECONDS): AssuranceVerifier {
  if (!Number.isInteger(freshnessSeconds) || freshnessSeconds <= 0) throw new RangeError("freshnessSeconds must be a positive integer");
  return {
    async verifyStepUp(uow, userId, proofRef, now): Promise<AssuranceOutcome> {
      if (proofRef === undefined || !isUuidV7(proofRef)) return { kind: "MISSING", reason: "STEP_UP_MISSING" };
      const proof = await uow.identities.getOwnProof(userId, proofRef);
      if (!proof || proof.userId !== userId) return { kind: "MISSING", reason: "STEP_UP_NOT_OWNED" };
      if (proof.kind !== "STEP_UP") return { kind: "MISSING", reason: "STEP_UP_MISSING" };
      const nowMs = Date.parse(now);
      const issuedMs = Date.parse(proof.issuedAt);
      const expiresMs = Date.parse(proof.expiresAt);
      if (!Number.isFinite(nowMs) || !Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) return { kind: "STALE", reason: "STEP_UP_STALE" };
      if (issuedMs > nowMs || nowMs - issuedMs > freshnessSeconds * 1000 || nowMs >= expiresMs) return { kind: "STALE", reason: "STEP_UP_STALE" };
      // the same window as a bound a caller judges at an instant read after this proof read (TIME-AFTER-AWAIT, PV1R-03)
      const freshUntil = new Date(Math.min(issuedMs + freshnessSeconds * 1000 + 1, expiresMs)).toISOString() as UtcInstant;
      return { kind: "FRESH", proofId: proof.proofId, issuedAt: proof.issuedAt, freshUntil };
    },
  };
}
