/**
 * The closed outcome catalogues of the statement and payout routes (B06 D-OUT-1; design §12, §13; decisions D10-API-1, D10-STMT-4;
 * mandate B10-STATEMENTS-PAYOUTS): CMD051 and CMD053 are the commission group's service commands (a verified service identity, its
 * technical role and environment, the stored period or statement), CMD052 the corporate owner's with a fresh step-up, and
 * GetCommissionStatement a read of the statement's own seller or the owner.
 */
import { OUTCOME_BLOCKS, problemOutcome as outcome, type ProblemOutcome } from "../../api/outcome-kit.js";

const { EVERY_ROUTE } = OUTCOME_BLOCKS;

/** A person's identity outcomes: a service identity is not a person, so a service route answers SERVICE_ACCESS instead. */
const PERSON_ONLY = new Set(["AUTHENTICATION_REQUIRED/-", "AUTHENTICATION_REQUIRED/SUBJECT_UNAUTHENTICATED", "NOT_AUTHORIZED/IDENTITY_DISABLED", "NOT_AUTHORIZED/IDENTITY_UNVERIFIED"]);
const keyOf = (o: ProblemOutcome): string => `${o.code}/${o.reason ?? "-"}`;

/** Every route but a person's identity outcomes: the service routes' shared entries. */
export const EVERY_SERVICE_ROUTE: ReadonlyArray<ProblemOutcome> = Object.freeze(EVERY_ROUTE.filter((o) => !PERSON_ONLY.has(keyOf(o))));

/** The commission group's services (D10-CTX-1): a verified service identity with the command's role, in its environment; a person is none. */
export const COMMISSION_SERVICE_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("AUTHENTICATION", "AUTHENTICATION_REQUIRED", null, "no verified service identity and no person: the anonymous denial is recorded"),
  outcome("ACCESS", "NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED", "a person's token, or a verified service identity without the command's technical role (the other service of the group included)"),
  outcome("ACCESS", "NOT_AUTHORIZED", "SERVICE_ENVIRONMENT_MISMATCH", "the service identity was issued for another environment"),
]);

const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });

/** CMD051: the period, then its dates, then due, then its inputs, then the proposed ledger (design §7; D10-STMT-1, D10-STMT-4, D10-CAL-1). */
export const CLOSE_COMMISSION_PERIOD_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("COMMAND", "NOT_FOUND", null, "the period is unknown: a foreign and a nonexistent id answer alike"),
  outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the period is already CLOSED", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "CALENDAR_UNAVAILABLE", "no recorded banking calendar version covers the period's close and pay dates"),
  outcome("COMMAND", "PRECONDITION_FAILED", "PERIOD_NOT_DUE", "the period's close date (the 5th banking day after its end) has not come on the server's clock", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "INPUTS_UNRECONCILED", "a COMMISSIONS record that occurred before the period's end is not yet delivered, or cannot be observed", { current: "ALWAYS" }),
  outcome("COMMAND", "STALE_VERSION", "LEDGER_CHANGED", "ledgerCutoffHash is not KAURO_COMMISSION_CUTOFF_V1 of the ledger as it stands: the close is proposed again, never re-cut", { current: "ALWAYS" }),
]);

/** CMD052: the owner's step-up, then the statement, its version and state, the payee, the payable and the cash (D10-PAY-1). */
export const APPROVE_COMMISSION_PAYOUT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window or expired"),
  outcome("COMMAND", "NOT_FOUND", null, "the statement is unknown"),
  STALE("statement"),
  outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the statement is not ISSUED: already approved, paid, disputed or corrected", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "PAYEE_UNVERIFIED", "payeeRef is not the seller's current VERIFIED destination: a change pending verification, a superseded or another seller's destination (KC009)"),
  outcome("COMMAND", "PRECONDITION_FAILED", "NOTHING_PAYABLE", "the statement's payable is zero: the only floor (minimumPayoutCents 0)"),
  outcome("COMMAND", "PRECONDITION_FAILED", "FUNDS_UNAVAILABLE", "bank-available cash of the latest settlement with bank evidence does not cover the payable and every unsettled authorized intent"),
]);

/** CMD053: the evidence verified, then the statement, the intent it names, the match and the settlement (D10-PAY-2). */
export const RECONCILE_COMMISSION_PAYOUT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("COMMAND", "PRECONDITION_FAILED", "PAYOUT_EVIDENCE_UNAVAILABLE", "no authenticated payout evidence under this reference (no verifier is bound before B15)"),
  outcome("COMMAND", "CAPACITY_UNAVAILABLE", "PAYOUT_EVIDENCE_UNAVAILABLE", "the payout evidence verifier did not answer within its bound or failed: nothing changed and the same key retries (D10-GAP-6)"),
  outcome("COMMAND", "NOT_FOUND", null, "the statement is unknown, or the evidence names an intent of another statement"),
  outcome("COMMAND", "PRECONDITION_FAILED", "PAYOUT_EVIDENCE_MISMATCH", "the evidence differs from the statement's intent in reference, destination digest, amount or currency: nothing changes"),
  outcome("COMMAND", "PRECONDITION_FAILED", "PAYOUT_NOT_SETTLED", "the evidence shows a submitted transfer only: submission is not settlement, nothing changes", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the intent already ended otherwise (SETTLED, FAILED or RETURNED under other evidence)", { current: "ALWAYS" }),
]);

/** GetCommissionStatement: the owner's grant or the caller's own ACTIVE seller row; another seller's statement is nobody's (D10-API-1). */
export const GET_COMMISSION_STATEMENT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ACCESS", "NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING", "the caller is neither an ACTIVE seller nor holds an ACTIVE KAURO_OWNER grant (read after their transition locks)"),
  outcome("COMMAND", "NOT_FOUND", null, "the statement is not one the caller may read: another seller's and a nonexistent statement answer alike"),
]);
