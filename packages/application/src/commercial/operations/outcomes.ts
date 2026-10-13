/**
 * The command-layer outcomes of CMD056 RecordIncident and CMD057 AuthorizeRecovery (package B16/B18; B06 D-OUT-1), composed by
 * commercial/outcomes into the closed catalogue of each route. CMD056 and CMD059 also admit the operations service: OPERATIONS_SERVICE_ACCESS.
 */
import { problemOutcome as outcome, type ProblemOutcome } from "../../api/outcome-kit.js";

/** The operations service as the second principal of a route (decision B18-OPS-1): its role and environment, never another service's. */
export const OPERATIONS_SERVICE_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ACCESS", "NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED", "a verified service identity without the OPERATIONS_SERVICE role (the commission and finance services included)"),
  outcome("ACCESS", "NOT_AUTHORIZED", "SERVICE_ENVIRONMENT_MISMATCH", "the operations service identity was issued for another environment"),
]);

/** CMD056: nothing beyond the closed body: an incident is always recordable (a false positive is recorded as such). */
export const RECORD_INCIDENT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([]);

/** CMD057: the owner's step-up, then the candidate, its state and its deletion journal. */
export const AUTHORIZE_RECOVERY_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window or expired"),
  outcome("COMMAND", "NOT_FOUND", null, "the restore candidate is unknown"),
  outcome("COMMAND", "PRECONDITION_FAILED", "RECOVERY_CANDIDATE_NOT_PREPARED", "the candidate is already authorized: a restore authorizes once", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "RECOVERY_DELETION_JOURNAL_MISMATCH", "deletionJournalHash is not the candidate's own: a restore must not resurrect deleted rows"),
]);
