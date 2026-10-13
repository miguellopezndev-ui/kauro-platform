/**
 * Maps an Intelligence core result onto the platform's four interpretation outcomes (B05 D5-4, D5-10; cases I05, I12).
 *
 * COMPILED means a validated SYSTEM_DRAFT that came back while the run still held its authority: no revocation (cancellation, fence, a
 * refused barrier), the interpretation deadline not passed, no liability standing on the grant (D5-4: a charge above its reservation
 * blocks promotion). A result that arrives after any of them is FAILED, never COMPILED, whatever the core says.
 */
import type { IntelligenceResult } from "@kauro/intelligence-core";
import type { InterpretOutcome } from "../../../ports/index.js";
import type { RevocationReason } from "./journal-ledger.js";

export interface RunStanding {
  readonly revoked: RevocationReason | null;
  readonly deadlinePassed: boolean;
}

export function outcomeOf(result: IntelligenceResult, standing: RunStanding): InterpretOutcome {
  if (standing.revoked !== null || standing.deadlinePassed) return "FAILED";
  if (result.resourceEvidence.grant.liabilityMicros > 0) return "FAILED";
  switch (result.state) {
    case "PROPOSAL_READY": {
      const draft = result.draft;
      if (draft.status !== "SYSTEM_DRAFT") return "FAILED";
      if (draft.validation.status === "DEFERRED_FOR_AGENCY_DECISION" || draft.decisionsRequired.length > 0) return "NEEDS_DECISION";
      return draft.validation.status === "VALIDATED" && draft.configuration !== null ? "COMPILED" : "FAILED";
    }
    case "ABSTAINED_MATERIAL":
      return "NEEDS_DECISION";
    case "BLOCKED_BY_POLICY":
      return "UNSUPPORTED";
    default:
      return "FAILED";
  }
}

/** A micro-charge as whole cents, rounded up: 1 micro reserves 1 cent, 10_000k + 1 micros k + 1 cents (I11). */
export function centsOfMicros(micros: number): number {
  return Math.ceil(micros / 10_000);
}
