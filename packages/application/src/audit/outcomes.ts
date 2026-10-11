/**
 * The closed outcome catalogues of the audit package's routes (B08; docs/design/B08-audit-approval-jobs.md §12, D8-API-1), composed
 * from the pipeline's shared entries exactly as B06, B07 and the execution package compose their own (api/outcome-kit, decision D-OUT-1
 * of B06): every problem a route may answer is one entry — code, reason, field codes, whether it carries the current safe version.
 * They are part of COMMAND_OUTCOMES / READ_OUTCOMES / INTAKE_OUTCOMES (api/outcomes): the api's send guard refuses any other problem,
 * the OpenAPI document lists them per status and the state/command/event matrix is generated from them.
 *
 * The reasons are the FAILURE_REASONS of @kauro/domain; the codes are manual 10's stable codes plus B06's PRECONDITION_FAILED and
 * ADMISSION_LIMITED (B06 D-ERR-1..3). No entry names a provider, an object name, a prompt or a raw customer value.
 */
import { OUTCOME_BLOCKS, closedCatalogue, problemOutcome as outcome, type ProblemOutcome } from "../api/outcome-kit.js";
import type { AuditCommandId, AuditIntakeId, AuditRouteId } from "./contracts.js";

const { EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER, EVERY_READ, TENANT_READ, NO_QUERY, COOKIE_CSRF } = OUTCOME_BLOCKS;

const NOT_VISIBLE = (what: string): ProblemOutcome => outcome("COMMAND", "NOT_FOUND", null, `${what} is not visible to the caller's agency`);
const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });
/** No adapter of the Intelligence core is bound: CMD022 and CMD023 refuse inside their unit of work (D8-PORT-1). */
export const CORE_SERVICES_UNAVAILABLE = outcome("COMMAND", "INTEGRITY_FAILURE", "CORE_SERVICES_UNAVAILABLE", "no adapter of the Intelligence core is bound in this edition (D8-PORT-1): nothing was written");

/** The command-specific outcomes, by command (design §12; reference/COMMAND_CATALOGUE preconditions and failures). */
const COMMAND_SPECIFIC: Readonly<Record<AuditCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD018: [
    NOT_VISIBLE("the project"),
    outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "the metadata artifact is not a METADATA artifact of this agency", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
    outcome("COMMAND", "PRECONDITION_FAILED", "TARGET_SCOPE_MISMATCH", "the artifact belongs to another project, CRM mode or target instance than the project's (or than its earlier contract's)"),
    outcome("COMMAND", "INVALID_REQUEST", "TARGET_METADATA_INVALID", "the metadata document is not the closed target metadata shape (an unknown member or a verified flag is refused)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "OBSERVATION_IN_FUTURE", "the observation is dated after the database's clock"),
    outcome("COMMAND", "PRECONDITION_FAILED", "TARGET_CONTRACT_EXISTS", "the project already holds this exact observed body: one contract per body, nothing was written"),
  ],
  CMD019: [
    NOT_VISIBLE("the target contract"),
    outcome("COMMAND", "STALE_VERSION", null, "expectedVersion is not the contract's current version, or bodyHash is not the digest of its stored body (a reused digest over changed metadata is never a confirmation); the current safe version and state come back", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "the confirmation evidence is not a CONFIRMATION_EVIDENCE artifact of this contract's project", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
    outcome("COMMAND", "PRECONDITION_FAILED", "TARGET_ALREADY_CONFIRMED", "the contract is already confirmed: a confirmation is recorded once; current names its version and state", { current: "ALWAYS" }),
    outcome("COMMAND", "TARGET_STALE", null, "the contract was superseded: a superseded version is never confirmed"),
    outcome("COMMAND", "PRECONDITION_FAILED", "OBSERVATION_IN_FUTURE", "the observation is dated after the database's clock"),
    outcome("COMMAND", "PRECONDITION_FAILED", "OBSERVATION_NOT_FRESH", "the observation is older than the freshness window: observe the target again"),
    outcome("COMMAND", "INTEGRITY_FAILURE", "BODY_DIGEST_MISMATCH", "the stored body is not the body its digest names"),
  ],
  CMD040: [
    NOT_VISIBLE("the import stage"),
    outcome("COMMAND", "STALE_VERSION", null, "the stage changed between the read and the write: the current safe version and state come back", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "the receipt upload is not a STAGE_RECEIPT artifact of this stage's project", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
    outcome("COMMAND", "PRECONDITION_FAILED", "STAGE_NOT_AWAITING_RECEIPT", "the stage is not awaiting a receipt (only AWAITING_AGENCY_IMPORT and NEEDS_CORRECTION accept one); current names its version and state", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "STAGE_EXPIRED", "the stage's bounded workflow deadline passed on the database's clock: no receipt is admitted after it, recovery is explicit"),
    outcome("COMMAND", "PRECONDITION_FAILED", "RECEIPT_INSTANCE_MISMATCH", "the receipt was produced for another target instance than the stage's"),
    outcome("COMMAND", "PRECONDITION_FAILED", "RECEIPT_PACKAGE_MISMATCH", "sourcePackageHash is not the stage's exact package"),
    outcome("COMMAND", "INVALID_REQUEST", "RECEIPT_INVALID", "the receipt document is not the closed source-to-target mapping shape"),
    outcome("COMMAND", "PRECONDITION_FAILED", "RECEIPT_FOREIGN_IDS", "the receipt names source identities that are not members of the stage: nothing was recorded"),
    outcome("COMMAND", "PRECONDITION_FAILED", "RECEIPT_ALREADY_SUBMITTED", "these exact receipt bytes were already submitted for the stage: a correction is new evidence"),
  ],
  CMD041: [
    NOT_VISIBLE("the import stage"),
    outcome("COMMAND", "STALE_VERSION", null, "expectedVersion is not the stage's current version, or validatedReceiptHash is not the digest of its latest validated receipt; the current safe version and state come back", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "STAGE_ALREADY_CONTINUED", "the continuation was already recorded: it is recorded once; current names its version and state", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "STAGE_NOT_CONTINUABLE", "the stage is not verified (or awaiting the approver's partial scope): it needs its receipt, a correction or an explicit recovery; current names its version and state", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "STAGE_EXPIRED", "the stage's bounded workflow deadline passed on the database's clock: continuation needs explicit recovery, never guessed identities"),
    outcome("COMMAND", "PRECONDITION_FAILED", "PARENT_STAGE_NOT_VERIFIED", "a required parent stage is not verified, or its workflow lapsed"),
    outcome("COMMAND", "PRECONDITION_FAILED", "CHILD_PLAN_NOT_APPROVED", "the plan the stage belongs to is not an APPROVED plan"),
    outcome("COMMAND", "INTEGRITY_FAILURE", "RECEIPT_DIGEST_MISMATCH", "the stored receipt mapping is not the mapping its digest names"),
    outcome("COMMAND", "PRECONDITION_FAILED", "STAGE_TARGET_MISMATCH", "the stage's target instance is not the project's current target: explicit recovery, not guessed IDs"),
  ],
  CMD020: [
    NOT_VISIBLE("the revision"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REVISION_NOT_SEALED", "the revision is not SEALED: a draft, a locked or a rejected revision has no immutable manifest to audit; current names its version and state", { current: "ALWAYS" }),
    outcome("COMMAND", "SOURCE_EXPIRED", null, "the sealed revision is no longer available (EXPIRED, DELETED, or its retention deadline was reached, D8-STALE-1)"),
    outcome("COMMAND", "TARGET_STALE", null, "the target contract is not a confirmed, current contract of the revision's project (D8-STALE-1)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AUDIT_EXISTS", "the revision was already audited against this target contract: one audit per subject, for good (D8-AUD-1); a retry is not a new free audit"),
    outcome("COMMAND", "ADMISSION_LIMITED", "AUDIT_CONCURRENCY_LIMITED", "the agency already holds its live audits (policy capacity.agencyAudits, 1): retry once one ends"),
    outcome("COMMAND", "BUDGET_EXHAUSTED", "NO_FUNDED_GRANT", "no funded platform pool can carve the audit's grant (R2-044): nothing was written"),
  ],
  CMD021: [
    NOT_VISIBLE("the audit"),
    STALE("audit"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AUDIT_TERMINAL", "the audit already ended: a cancellation has nothing left to stop; current names its version and state", { current: "ALWAYS" }),
  ],
  CMD022: [
    NOT_VISIBLE("the audit"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AUDIT_NOT_DECIDABLE", "the audit is not NEEDS_DECISION: it has no candidate decisions awaiting the agency; current names its version and state", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "the candidate decision artifact is not a CANDIDATE_DECISIONS artifact of this audit", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
    outcome("COMMAND", "INVALID_REQUEST", "PATCH_UNKNOWN_CANDIDATE", "the candidate decisions name a candidate the audit does not have", { fieldCodes: ["PATCH_UNKNOWN_CANDIDATE"] }),
    outcome("COMMAND", "INVALID_REQUEST", "PATCH_UNKNOWN_FIELD", "the candidate decisions name a field the audit does not have", { fieldCodes: ["PATCH_UNKNOWN_FIELD"] }),
    outcome("COMMAND", "INVALID_REQUEST", "PATCH_EFFECT_NOT_PERMITTED", "the candidate decisions ask for an effect the plan does not permit, or compile to a plan of another source or target than the audit's (N10)", { fieldCodes: ["PATCH_EFFECT_NOT_PERMITTED"] }),
    outcome("COMMAND", "INVALID_REQUEST", "PATCH_MALFORMED", "the candidate decisions are not a decisions document", { fieldCodes: ["PATCH_MALFORMED"] }),
    outcome("COMMAND", "INTEGRITY_FAILURE", "BODY_DIGEST_MISMATCH", "a compiled plan body is not the body its KAURO_PLAN_BODY_V1 hash names (N10)"),
    CORE_SERVICES_UNAVAILABLE,
  ],
  CMD024: [
    NOT_VISIBLE("the plan"),
    outcome("COMMAND", "STALE_VERSION", null, "expectedVersion is not the plan's current version, or planHash is not its body hash (current.mismatch names it); the current safe version and state come back", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_NOT_VALIDATABLE", "the plan is not VALIDATION_REQUIRED: only that state takes a validation intent; current names its version and state", { current: "ALWAYS" }),
  ],
});

function commandCatalogue(command: AuditCommandId): ReadonlyArray<ProblemOutcome> {
  return closedCatalogue(command, [...EVERY_ROUTE, ...COOKIE_CSRF, ...PATH_IDS, ...TENANT, ...AGENCY_HEADER, ...COMMAND_SPECIFIC[command]]);
}

/** The closed problem catalogue of each audit command. */
export const AUDIT_COMMAND_OUTCOMES: Readonly<Record<AuditCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD018: commandCatalogue("CMD018"),
  CMD019: commandCatalogue("CMD019"),
  CMD040: commandCatalogue("CMD040"),
  CMD041: commandCatalogue("CMD041"),
  CMD020: commandCatalogue("CMD020"),
  CMD021: commandCatalogue("CMD021"),
  CMD022: commandCatalogue("CMD022"),
  CMD024: commandCatalogue("CMD024"),
});

/** The closed problem catalogue of the audit read (an audit of another agency and a nonexistent one answer alike). */
export const AUDIT_ROUTE_OUTCOMES: Readonly<Record<AuditRouteId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  GetAudit: closedCatalogue("GetAudit", [...EVERY_READ, ...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the audit")]),
});

/**
 * The decision-artifact intake: non-journaled and content-idempotent (D8-PLAN-1), so a body admission route without an idempotency key.
 * It answers for an audit in any state of the caller's agency (a plan may be revised long after the audit ended).
 */
export const AUDIT_INTAKE_OUTCOMES: Readonly<Record<AuditIntakeId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  SubmitDecisionArtifact: closedCatalogue("SubmitDecisionArtifact", [
    ...EVERY_ROUTE.filter((o) => o.layer !== "IDEMPOTENCY" && o.reason !== "IDEMPOTENCY_KEY_MISSING" && o.reason !== "IDEMPOTENCY_KEY_INVALID"),
    // the cookie CSRF rule of an unsafe route a person authenticates for (B11 D-AUTH-5, D-INT1-2; joined by the trunk sync, D11-SYNC-1)
    ...COOKIE_CSRF,
    ...PATH_IDS,
    ...TENANT,
    ...AGENCY_HEADER,
    NOT_VISIBLE("the audit"),
  ]),
});
