/**
 * The closed outcome catalogues of the execution package's routes (B08; docs/design/B08-audit-approval-jobs.md §12, D8-API-1),
 * composed from the pipeline's shared entries exactly as B06 and B07 compose their own (api/outcome-kit, decision D-OUT-1 of B06):
 * every problem a route may answer is one entry — code, reason, field codes, whether it carries the current safe version. They are
 * part of COMMAND_OUTCOMES / READ_OUTCOMES (api/outcomes): the api's send guard refuses any other problem, the OpenAPI document
 * lists them per status and the state/command/event matrix is generated from them.
 *
 * The reasons are the FAILURE_REASONS of @kauro/domain; the codes are manual 10's stable codes plus B06's PRECONDITION_FAILED and
 * CAPACITY_UNAVAILABLE (B06 D-ERR-1..3). No entry names a provider, an object name, a prompt or a raw customer value.
 */
import { OUTCOME_BLOCKS, closedCatalogue, problemOutcome as outcome, type ProblemOutcome } from "../api/outcome-kit.js";
import type { ExecutionCommandId, ExecutionRouteId } from "./contracts.js";

const { EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER, EVERY_READ, TENANT_READ, NO_QUERY, COOKIE_CSRF } = OUTCOME_BLOCKS;

const NOT_VISIBLE = (what: string): ProblemOutcome => outcome("COMMAND", "NOT_FOUND", null, `${what} is not visible to the caller's agency`);
const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });

/** The command-specific outcomes, by command (design §12; reference/COMMAND_CATALOGUE preconditions and failures). */
const COMMAND_SPECIFIC: Readonly<Record<ExecutionCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD036: [
    NOT_VISIBLE("the project or the authorization"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_ACTIVE", "customer data is processed only in an ACTIVE agency (07: DRAFT permits identity and agreement setup, not customer-data execution; B06 D-CMD-2)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "PROJECT_NOT_OPEN", "the project is not OPEN (closed or being deleted): it starts no execution", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "AUTHORIZATION_REVOKED", "the commercial authorization is no longer ACTIVE (revoked before admission is PRE_EXECUTION): no job is bound to it (D8-AUTH-1); current names its version and state", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_NOT_APPROVED", "the authorization's approval is no longer live on an APPROVED plan (withdrawn or superseded)", { current: "ALWAYS" }),
    outcome("COMMAND", "SOURCE_EXPIRED", null, "the authorization's source revision is no longer SEALED and available (its retention deadline was reached, D8-STALE-1)"),
    outcome("COMMAND", "TARGET_STALE", null, "the authorization's target contract is not confirmed and current (D8-STALE-1)"),
    outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "MODE_NOT_OFFERED", "the authorization's mode is no longer offered (09: the mode capability is checked before work is queued)"),
    outcome("COMMAND", "CAPACITY_UNAVAILABLE", "EXECUTION_QUEUE_FULL", "the agency already holds its live jobs (policy capacity.heavyQueued, 3, D8-CAP-2): nothing was written and the authorization stays ACTIVE; retry with the same key"),
  ],
  CMD037: [
    NOT_VISIBLE("the job"),
    STALE("job"),
    outcome("COMMAND", "PRECONDITION_FAILED", "JOB_TERMINAL", "the job already ended (FAILED, CANCELLED or EXPIRED): a cancellation has nothing left to stop", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "JOB_ALREADY_READY", "the publication committed first (S062): the job is READY and current names its package; a cancellation never rolls a package back", { current: "ALWAYS" }),
  ],
  CMD038: [
    NOT_VISIBLE("the package"),
    outcome("COMMAND", "NOT_FOUND", "ARTIFACT_NOT_FOUND", "an artifact id is not a delivery copy of this package (another package's and a nonexistent one look alike): nothing is granted"),
    // the step-up a download needs (the same three refusals as CMD025's)
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window or expired"),
    outcome("COMMAND", "PRECONDITION_FAILED", "PROJECT_NOT_OPEN", "the package's project is not OPEN (closed or being deleted, CMD042): no new URL"),
    outcome("COMMAND", "PRECONDITION_FAILED", "PACKAGE_NOT_AVAILABLE", "the package is not AVAILABLE (revoked, retired or deleted): no new URL; a URL issued earlier keeps its disclosed residual lifetime"),
    outcome("COMMAND", "PRECONDITION_FAILED", "ARTIFACT_UNAVAILABLE", "a requested artifact's object is deleted, being deleted or quarantined: the whole request is refused, nothing is granted"),
    outcome("COMMAND", "PRECONDITION_FAILED", "RETENTION_EXPIRED", "the governing retention record's effective deadline is reached on the database clock (judged after its lock): no new URL"),
    outcome("COMMAND", "PRECONDITION_FAILED", "DOWNLOAD_AUTHORIZATION_EXPIRED", "a retry with the same key after the grant's expiry: the grant is never re-signed beyond expiresAt; request a new one with a new key"),
    outcome("COMMAND", "NOT_AUTHORIZED", "MEMBERSHIP_CHANGED", "the requester's membership changed after the grant was recorded (R2-048): no URL is signed for it"),
    outcome("COMMAND", "CAPACITY_UNAVAILABLE", "SIGNING_UNCERTAIN", "the provider did not answer the signing within its bound: the grant is recorded ISSUE_UNCERTAIN; retry with the same key to re-sign the same scope at the same expiry"),
    outcome("COMMAND", "CAPACITY_UNAVAILABLE", "DOWNLOAD_SIGNER_UNAVAILABLE", "no read signer is bound in this deployment: nothing was written"),
  ],
});

function commandCatalogue(command: ExecutionCommandId): ReadonlyArray<ProblemOutcome> {
  return closedCatalogue(command, [...EVERY_ROUTE, ...COOKIE_CSRF, ...PATH_IDS, ...TENANT, ...AGENCY_HEADER, ...COMMAND_SPECIFIC[command]]);
}

/** The closed problem catalogue of each execution command. */
export const EXECUTION_COMMAND_OUTCOMES: Readonly<Record<ExecutionCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD036: commandCatalogue("CMD036"),
  CMD037: commandCatalogue("CMD037"),
  CMD038: commandCatalogue("CMD038"),
});

/** The closed problem catalogue of each read of the package (a job of another agency and a nonexistent one answer alike). */
export const EXECUTION_ROUTE_OUTCOMES: Readonly<Record<ExecutionRouteId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  GetJob: closedCatalogue("GetJob", [...EVERY_READ, ...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the job")]),
});
