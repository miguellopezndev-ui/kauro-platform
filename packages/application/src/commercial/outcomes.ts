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
import { ACTIVATE_SELLER_OUTCOMES, ASSIGN_ACCOUNT_OUTCOMES, CORPORATE_OWNER_ACCESS, TERMINATE_SELLER_OUTCOMES } from "./sellers/outcomes.js";
import type { CommercialReadOperationId } from "./response-schemas.js";
import {
  APPROVE_COMMISSION_PAYOUT_OUTCOMES,
  CLOSE_COMMISSION_PERIOD_OUTCOMES,
  COMMISSION_SERVICE_ACCESS,
  EVERY_SERVICE_ROUTE,
  GET_COMMISSION_STATEMENT_OUTCOMES,
  RECONCILE_COMMISSION_PAYOUT_OUTCOMES,
} from "./statements/outcomes.js";

const { EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER, EVERY_READ, NO_QUERY } = OUTCOME_BLOCKS;

/** The corporate principals of the sales commands (D10-CTX-1, D10-CTX-2): a person without the ACTIVE seller row or owner grant the command needs. */
const CORPORATE_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ACCESS", "NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING", "the caller holds no ACTIVE seller row (or, for the owner commands, no ACTIVE KAURO_OWNER grant), read after its transition lock: an agency member, a CANDIDATE, SUSPENDED or TERMINATED seller and a revoked owner answer alike"),
]);

const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });

/** The command-layer outcomes of each served B10 command (design §4, §12; reference/COMMAND_CATALOGUE preconditions and failures). */
const COMMAND_SPECIFIC: Readonly<Record<"CMD002" | "CMD043" | "CMD045" | "CMD046" | "CMD047", ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  // CMD002: the path agency's OWNER; the version, then DRAFT, then the agreements, then the billing profile (D10-AGY-1)
  CMD002: [
    STALE("agency"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_DRAFT", "the agency is not DRAFT: it was already activated, restricted or closed", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGREEMENT_VERSION_NOT_PUBLISHED", "the terms or privacy version is not the PUBLISHED version of its kind (an unknown or retired version; no default, no implicit signature)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "BILLING_PROFILE_MISMATCH", "billingProfileRef is not the agency's current fiscal profile (another agency's, an unknown or a superseded one)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "FISCAL_TREATMENT_UNREVIEWED", "the agency's current fiscal profile carries no reviewed treatment (R2-082): activation does not rest on an unknown treatment"),
  ],
  // CMD043: the path agency's OWNER with a fresh step-up; the step-up, then the version, then the state, then the obligations (D10-AGY-2, D10-AGY-4)
  // CMD045: an ACTIVE seller or the owner; the label, then the caller's own AGENCY-segment evidence and contact, suppression, then a live duplicate (D10-PROS-1)
  CMD045: [
    outcome("COMMAND", "PRECONDITION_FAILED", "SOURCE_EVIDENCE_INVALID", "sourceEvidenceHash or businessContactRef is not the caller's own record, or the evidence is not of the AGENCY segment: another seller's record is as unknown as a missing one"),
    outcome("COMMAND", "PRECONDITION_FAILED", "PROSPECT_SUPPRESSED", "the organization key or the contact key is suppressed, however the organization is spelled (KC016)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "PROSPECT_EXISTS", "the organization already has a live prospect (the unique index answers for a prospect the caller cannot read)"),
  ],
  // CMD046: an ACTIVE seller on a prospect it owns; the agreement version, the evidence, then its own live claim (D10-CLAIM-1)
  CMD046: [
    outcome("ACCESS", "NOT_FOUND", null, "the prospect is not one the seller owns: a foreign and a nonexistent prospect answer alike"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGREEMENT_VERSION_MISMATCH", "agreementVersion is not the version of the seller's agreement in force"),
    outcome("COMMAND", "PRECONDITION_FAILED", "CLAIM_EVIDENCE_INSUFFICIENT", "evidenceHash is not the seller's own evidence for this prospect, or records only a list import or a tracking link"),
    outcome("COMMAND", "PRECONDITION_FAILED", "CLAIM_EXISTS", "the seller already has a live claim on the prospect"),
  ],
  // CMD047: the owner; the claim, the version, its state, the prepared allocation, the split, the agency's single allocation, its buyer type and its first order (D10-ATTR-1, D58)
  CMD047: [
    outcome("COMMAND", "NOT_FOUND", null, "the claim, or the allocation on its prospect, is unknown"),
    STALE("claim"),
    outcome("COMMAND", "PRECONDITION_FAILED", "CLAIM_NOT_REVIEWABLE", "the claim (or a claim the allocation names) is not SUBMITTED or DISPUTED", { current: "SOMETIMES" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "SHARES_NOT_WHOLE", "the allocation's shares do not sum to exactly 10000 basis points, or name no share for this claim (KC003)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "ATTRIBUTION_EXISTS", "the agency already has a frozen allocation: the pool does not become 10% for each seller"),
    outcome("COMMAND", "PRECONDITION_FAILED", "BUYER_TYPE_UNSET", "the agency's buyer type is not recorded (D58)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "IN_HOUSE_NOT_ATTRIBUTABLE", "the agency is an in-house tenant: no seller attribution arises from prospecting it"),
    outcome("COMMAND", "PRECONDITION_FAILED", "CLAIM_AFTER_FIRST_ORDER", "the claim was submitted after the agency's first payment order"),
  ],
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

/** A corporate command: the seller or owner access decision, the path id when the route has one, and the command's own outcomes. */
const corporateCommand = (id: "CMD045" | "CMD046" | "CMD047", pathId: boolean) => closedCatalogue(id, [...EVERY_ROUTE, ...(pathId ? PATH_IDS : []), ...CORPORATE_ACCESS, ...COMMAND_SPECIFIC[id]]);

/** The closed problem catalogue of each served B10 command route. */
export const COMMERCIAL_COMMAND_OUTCOMES: Readonly<Record<CommercialServedRouteCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD002: agencyPathCommand("CMD002"),
  CMD043: agencyPathCommand("CMD043"),
  CMD045: corporateCommand("CMD045", false),
  CMD046: corporateCommand("CMD046", true),
  CMD047: corporateCommand("CMD047", true),
  // the corporate owner's seller commands (B10-COMMANDS-SELLERS): the path id, the owner's access, the command-layer outcomes of sellers/outcomes
  CMD048: closedCatalogue("CMD048", [...EVERY_ROUTE, ...PATH_IDS, ...CORPORATE_OWNER_ACCESS, ...ASSIGN_ACCOUNT_OUTCOMES]),
  CMD049: closedCatalogue("CMD049", [...EVERY_ROUTE, ...PATH_IDS, ...CORPORATE_OWNER_ACCESS, ...ACTIVATE_SELLER_OUTCOMES]),
  CMD050: closedCatalogue("CMD050", [...EVERY_ROUTE, ...PATH_IDS, ...CORPORATE_OWNER_ACCESS, ...TERMINATE_SELLER_OUTCOMES]),
  // CreateQuote (B10-COMMANDS-QUOTE): the agency is selected by the header and the project is the path id
  CMD027: closedCatalogue("CMD027", [...EVERY_ROUTE, ...PATH_IDS, ...TENANT, ...AGENCY_HEADER, ...CREATE_QUOTE_OUTCOMES]),
  // the statement and payout commands (B10-STATEMENTS-PAYOUTS): the commission group's service routes and the owner's approval
  CMD051: closedCatalogue("CMD051", [...EVERY_SERVICE_ROUTE, ...PATH_IDS, ...COMMISSION_SERVICE_ACCESS, ...CLOSE_COMMISSION_PERIOD_OUTCOMES]),
  CMD052: closedCatalogue("CMD052", [...EVERY_ROUTE, ...PATH_IDS, ...CORPORATE_OWNER_ACCESS, ...APPROVE_COMMISSION_PAYOUT_OUTCOMES]),
  CMD053: closedCatalogue("CMD053", [...EVERY_SERVICE_ROUTE, ...PATH_IDS, ...COMMISSION_SERVICE_ACCESS, ...RECONCILE_COMMISSION_PAYOUT_OUTCOMES]),
});

/** The closed problem catalogue of each served B10 read route (GetCommissionStatement: no query, the path id, the seller's or owner's access). */
export const COMMERCIAL_READ_OUTCOMES: Readonly<Record<CommercialReadOperationId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  GetCommissionStatement: closedCatalogue("GetCommissionStatement", [...EVERY_READ, ...PATH_IDS, NO_QUERY, ...GET_COMMISSION_STATEMENT_OUTCOMES]),
});
