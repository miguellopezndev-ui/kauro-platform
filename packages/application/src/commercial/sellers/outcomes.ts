/**
 * The command-layer outcomes of the seller commands CMD048, CMD049 and CMD050 (B06 D-OUT-1; design §12; mandate B10-COMMANDS-SELLERS),
 * composed by commercial/outcomes into the closed catalogue of each route with the transport, admission and authentication fragments and
 * the corporate owner's access. A seller's refusal reveals nothing about another seller's state: every entry is a reason the owner —
 * the only caller admitted — is entitled to read.
 */
import { problemOutcome as outcome, type ProblemOutcome } from "../../api/outcome-kit.js";

const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });
const SELLER_NOT_FOUND = outcome("COMMAND", "NOT_FOUND", null, "the seller is unknown");

/** The corporate owner (KAURO_OWNER; D10-CTX-1): identity status, then the caller's own ACTIVE grant. A tenant member and a seller are both refused here. */
export const CORPORATE_OWNER_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([outcome("ACCESS", "NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING", "the caller holds no ACTIVE KAURO_OWNER grant (read after its transition lock): an agency member, a seller and an unknown caller are refused alike")]);

/** CMD048: the seller, then the account's version, then the seller ACTIVE, then the prepared service assignment (D10-ASSIGN-1). */
export const ASSIGN_ACCOUNT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  SELLER_NOT_FOUND,
  STALE("sales account"),
  outcome("COMMAND", "PRECONDITION_FAILED", "SELLER_NOT_ACTIVE", "the seller is not ACTIVE (a CANDIDATE, SUSPENDED or TERMINATED seller is given no agency)"),
  outcome("COMMAND", "PRECONDITION_FAILED", "SERVICE_ASSIGNMENT_UNPREPARED", "no service assignment prepared for this seller and this agency states the compensation of the new work (none, or an assistance agreement)"),
]);

/** CMD049: the owner's step-up, then the seller CANDIDATE, then the agreement, then every activation fact (D10-SELL-1, D10-SELL-3). */
export const ACTIVATE_SELLER_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window or expired"),
  SELLER_NOT_FOUND,
  outcome("COMMAND", "PRECONDITION_FAILED", "SELLER_NOT_ACTIVATABLE", "the seller is not a CANDIDATE, or an activation prerequisite is missing: a signed agreement, a legal review confirming its classification, a passed assessment, confidentiality, tax documentation, a verified payout destination or a verified identity with MFA (KC005)", {
    current: "SOMETIMES",
  }),
  outcome("COMMAND", "PRECONDITION_FAILED", "AGREEMENT_VERSION_MISMATCH", "agreementId is not an agreement of this seller"),
]);

/** CMD050: the seller, then its version and state, then the prepared terms, then the enumerated manifest (D10-TERM-1, KC011). */
export const TERMINATE_SELLER_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  SELLER_NOT_FOUND,
  STALE("seller"),
  outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the seller is not ACTIVE or SUSPENDED: it was already terminated or never engaged", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "TERMINATION_TERMS_UNPREPARED", "no termination terms prepared for this seller are waiting to take effect (unknown, another seller's or already effective)"),
  outcome("COMMAND", "PRECONDITION_FAILED", "TAIL_NOT_ENUMERATED", "the manifest is not enumerable: an entry is not an accepted, unexpired claim of this seller, or its agency already made a qualifying purchase (KC011)"),
]);
