/**
 * The closed outcome catalogues of the B10 routes (B06 D-OUT-1; design §12, §13; decision D10-API-1), composed from the pipeline's shared
 * entries exactly as B06 and B09 compose theirs (api/outcome-kit): every problem a served route may answer is one entry — code,
 * reason, field codes, whether it carries the current safe version. A catalogue exists for each command a command lane serves; the
 * api's send guard refuses any other problem, the OpenAPI document lists them per status and the state/command/event matrix is
 * generated from them. B10-AGENCY-LIFECYCLE serves CMD002 and CMD043; each later lane adds the catalogues of its own commands here.
 */
import { OUTCOME_BLOCKS, closedCatalogue, problemOutcome as outcome, type ProblemOutcome } from "../api/outcome-kit.js";
import { CREATE_QUOTE_OUTCOMES } from "./quotes/outcomes.js";
import type { CommercialServedRouteCommandId } from "./served.js";

const { EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER } = OUTCOME_BLOCKS;

const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });

/** The command-layer outcomes of each served B10 command (design §4, §12; reference/COMMAND_CATALOGUE preconditions and failures). */
const COMMAND_SPECIFIC: Readonly<Record<"CMD002" | "CMD043", ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  // CMD002: the path agency's OWNER; the version, then DRAFT, then the agreements, then the billing profile (D10-AGY-1)
  CMD002: [
    STALE("agency"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_DRAFT", "the agency is not DRAFT: it was already activated, restricted or closed", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGREEMENT_VERSION_NOT_PUBLISHED", "the terms or privacy version is not the PUBLISHED version of its kind (an unknown or retired version; no default, no implicit signature)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "BILLING_PROFILE_MISMATCH", "billingProfileRef is not the agency's current fiscal profile (another agency's, an unknown or a superseded one)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "FISCAL_TREATMENT_UNREVIEWED", "the agency's current fiscal profile carries no reviewed treatment (R2-082): activation does not rest on an unknown treatment"),
  ],
  // CMD043: the path agency's OWNER with a fresh step-up; the step-up, then the version, then the state, then the obligations (D10-AGY-2, D10-AGY-4)
  CMD043: [
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window or expired"),
    STALE("agency"),
    outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the agency is CLOSING or CLOSED: closure is requested from DRAFT, ACTIVE or RESTRICTED only", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "CLOSURE_OBLIGATIONS_UNRECONCILED", "a payment order or refund of the agency is in flight or uncertain: it is settled or reconciled before the agency can close (open reconciliation cases do not refuse the request; they refuse the CLOSED edge)", { current: "ALWAYS" }),
  ],
});

/** A tenant command whose path names the agency: the authorizer's membership decisions and the path id, no agency selector. */
const agencyPathCommand = (id: "CMD002" | "CMD043") => closedCatalogue(id, [...EVERY_ROUTE, ...PATH_IDS, ...TENANT, ...COMMAND_SPECIFIC[id]]);

/** The closed problem catalogue of each served B10 command route. */
export const COMMERCIAL_COMMAND_OUTCOMES: Readonly<Record<CommercialServedRouteCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD002: agencyPathCommand("CMD002"),
  CMD043: agencyPathCommand("CMD043"),
  // CreateQuote (B10-COMMANDS-QUOTE): the agency is selected by the header and the project is the path id
  CMD027: closedCatalogue("CMD027", [...EVERY_ROUTE, ...PATH_IDS, ...TENANT, ...AGENCY_HEADER, ...CREATE_QUOTE_OUTCOMES]),
});
