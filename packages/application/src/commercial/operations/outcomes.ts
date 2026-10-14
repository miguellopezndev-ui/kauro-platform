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

const STEP_UP: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window or expired"),
]);

/** CMD054: the owner's step-up (judged again at COMMIT), the scope and its justification, then one live grant per project, one per proof. */
export const OPEN_BREAKGLASS_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  ...STEP_UP,
  outcome("COMMAND", "PRECONDITION_FAILED", "BREAKGLASS_SCOPE_UNAUTHORIZED", "the support case or incident does not justify this project now: another project's or agency's, closed, resolved, a false positive, an incident not naming the project, a project whose deletion was requested, a closed agency, or nothing the owner may name"),
  outcome("COMMAND", "PRECONDITION_FAILED", "BREAKGLASS_GRANT_LIVE", "the project already holds a live grant; a concurrent open that lost the race answers without the current grant", { current: "SOMETIMES" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "BREAKGLASS_RENEWAL_REFUSED", "this authorization already opened a grant of the project: after its expiry a new justified grant is required, the expired record is kept (R2-050)"),
  outcome("COMMAND", "PRECONDITION_FAILED", "BREAKGLASS_PROOF_REUSED", "the step-up proof already opened a grant: a proof is never silently reused"),
]);

/** CMD055: the grant, then ACTIVE, then not expired. */
export const REVOKE_BREAKGLASS_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("COMMAND", "NOT_FOUND", null, "the grant is unknown"),
  outcome("COMMAND", "PRECONDITION_FAILED", "BREAKGLASS_GRANT_NOT_ACTIVE", "the grant is already revoked or lapsed: it is not revoked again", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "BREAKGLASS_GRANT_EXPIRED", "the grant's 1800 seconds have passed: it reads nothing and its record is kept as it was"),
]);

/** The breakglass preview: the holder's own grant, live, covering the table. */
export const BREAKGLASS_PREVIEW_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("COMMAND", "NOT_FOUND", null, "the grant is not the caller's own, or the table is not an admitted table of the grant's project: another owner's grant, another project's table and an unknown id answer alike"),
  outcome("COMMAND", "PRECONDITION_FAILED", "BREAKGLASS_GRANT_NOT_ACTIVE", "the grant was revoked or lapsed (a revocation that committed while the read waited included)"),
  outcome("COMMAND", "PRECONDITION_FAILED", "BREAKGLASS_GRANT_EXPIRED", "the grant's 1800 seconds have passed (a read whose wait on the grant crossed its expiry included)"),
  outcome("COMMAND", "PRECONDITION_FAILED", "BREAKGLASS_GRANT_UNUSABLE", "the grant's support case or incident was closed, its project's deletion requested or its agency closed: the record is kept, its use ends"),
  outcome("COMMAND", "INTEGRITY_FAILURE", "SOURCE_SERVICES_UNAVAILABLE", "no object-storage adapter or preview reader is bound in this edition"),
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
