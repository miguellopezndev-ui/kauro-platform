// The exhaustive problem-code state table (design D-STATE-1; reference "Shared states"; 10 "frontend control flow uses the code and typed
// fields. It does not parse prose. An unexpected 500 does not automatically mean a command did not commit"). Every screen derives one of
// the 14 shared states from an api answer through this module and nowhere else:
//   - the closed Problem `code` (with, for three codes, the closed `reason`) picks the state and the one next step it offers;
//   - a reply that never arrived (network, timeout, an edge answer) is Pending "Checking", never "failed";
//   - a reply that failed the generated contract is Integrity failure, never rendered;
//   - Success comes only from a COMPLETED envelope or a re-read that found the durable result.
// The table is typed `Record<ProblemCode, …>`, so a code added to the api contract fails compilation here until it is decided.
import type { Problem } from "../api/generated.ts";
import type { ApiAnswer } from "./answer.ts";
import type { RunOutcome } from "./operation-runner.ts";

export type ProblemCode = Problem["code"];
export type ProblemReason = NonNullable<Problem["reason"]>;

export const SHARED_STATES = [
  "LOADING",
  "EMPTY",
  "READY",
  "UNSAVED",
  "STALE",
  "DENIED",
  "RESTRICTED",
  "PENDING",
  "UNCERTAIN",
  "EXPIRED",
  "CANCELLED",
  "INTEGRITY_FAILURE",
  "DELETED",
  "SUCCESS",
] as const;
export type SharedState = (typeof SHARED_STATES)[number];

/** The one control the state offers first; the screen renders it, the copy catalogue words it. */
export type NextStep =
  | "NONE"
  | "SIGN_IN"
  | "STEP_UP"
  | "FIX_FIELDS"
  | "RELOAD"
  | "COMPARE_VERSIONS"
  | "REQUERY"
  | "REQUEST_NEW_REVIEW"
  | "CHOOSE_ANOTHER_MODE"
  | "RETRY_LATER"
  | "CONTACT_SUPPORT"
  /** CONTENT_REFUSED (B11 D-SUP-2): the text looked like a secret or customer records; files go through the secure upload. */
  | "SECURE_UPLOAD";

export type FieldErrors = NonNullable<Problem["errors"]>;
export type CurrentFacts = NonNullable<Problem["current"]>;

export interface StateDecision {
  readonly state: SharedState;
  readonly next: NextStep;
  /** The typed edits of the person stay on screen (a step-up or a validation error must not lose them). */
  readonly keepsLocalEdits: boolean;
  /** The state shows the correlation id as the support reference. */
  readonly showsSupportReference: boolean;
  /** The screen discourages another payment or request ("do not pay again"). */
  readonly discouragesRepeat: boolean;
  /** The correlation id of the answer, when the state shows it; null otherwise. */
  readonly supportReference: string | null;
  readonly retryAfterSeconds: number | null;
  /** INVALID_REQUEST only: the safe field errors, as field path and code. */
  readonly fieldErrors: FieldErrors;
  /** STALE only: what the server holds now, for the comparison. */
  readonly current: CurrentFacts | null;
  /** What produced the state: a stable label for logs and tests, never shown as prose. */
  readonly cause: string;
}

interface Entry {
  readonly state: SharedState;
  readonly next: NextStep;
  readonly keepsLocalEdits?: boolean;
  readonly showsSupportReference?: boolean;
  readonly discouragesRepeat?: boolean;
}

/** One entry per stable code of the api contract (the 17 of manual 10 and the four the api adds, CONTENT_REFUSED of B11 D-SUP-2 among them). */
export const PROBLEM_STATES: Readonly<Record<ProblemCode, Entry>> = {
  INVALID_REQUEST: { state: "UNSAVED", next: "FIX_FIELDS", keepsLocalEdits: true },
  AUTHENTICATION_REQUIRED: { state: "DENIED", next: "SIGN_IN" },
  ASSURANCE_REQUIRED: { state: "DENIED", next: "STEP_UP", keepsLocalEdits: true },
  NOT_AUTHORIZED: { state: "DENIED", next: "NONE" },
  NOT_FOUND: { state: "DENIED", next: "NONE" },
  STALE_VERSION: { state: "STALE", next: "COMPARE_VERSIONS" },
  IDEMPOTENCY_CONFLICT: { state: "STALE", next: "RELOAD" },
  CAPABILITY_UNAVAILABLE: { state: "RESTRICTED", next: "CHOOSE_ANOTHER_MODE" },
  SOURCE_EXPIRED: { state: "EXPIRED", next: "REQUEST_NEW_REVIEW" },
  TARGET_STALE: { state: "STALE", next: "COMPARE_VERSIONS" },
  PLAN_NOT_VALIDATED: { state: "UNSAVED", next: "REQUEST_NEW_REVIEW", keepsLocalEdits: true },
  PAYMENT_PENDING: { state: "PENDING", next: "REQUERY", discouragesRepeat: true },
  PAYMENT_UNCERTAIN: { state: "UNCERTAIN", next: "CONTACT_SUPPORT", showsSupportReference: true, discouragesRepeat: true },
  BUDGET_EXHAUSTED: { state: "RESTRICTED", next: "CONTACT_SUPPORT" },
  CAPACITY_UNAVAILABLE: { state: "RESTRICTED", next: "RETRY_LATER" },
  INTEGRITY_FAILURE: { state: "INTEGRITY_FAILURE", next: "CONTACT_SUPPORT", showsSupportReference: true },
  OPERATION_CANCELLED: { state: "CANCELLED", next: "RELOAD" },
  PRECONDITION_FAILED: { state: "STALE", next: "RELOAD" },
  ADMISSION_LIMITED: { state: "RESTRICTED", next: "RETRY_LATER" },
  // the refused text stays on screen for the person to edit; nothing was stored or sent, and the files go through the secure upload
  CONTENT_REFUSED: { state: "UNSAVED", next: "SECURE_UPLOAD", keepsLocalEdits: true },
  INTERNAL_ERROR: { state: "PENDING", next: "REQUERY", showsSupportReference: true },
};

/**
 * The closed reasons that change a code's state. Only PRECONDITION_FAILED carries a reason that says something the code does not:
 * another request under the same key is still in flight (query it), the agency accepts no new work, or the edit changes nothing.
 * Every other reason of every code leaves the code's own entry.
 */
export const REASON_STATES: Readonly<Partial<Record<ProblemCode, Readonly<Partial<Record<ProblemReason, Entry>>>>>> = {
  PRECONDITION_FAILED: {
    OPERATION_PENDING: { state: "PENDING", next: "REQUERY" },
    AGENCY_NOT_OPEN: { state: "RESTRICTED", next: "CONTACT_SUPPORT" },
    NO_SEMANTIC_CHANGE: { state: "UNSAVED", next: "FIX_FIELDS", keepsLocalEdits: true },
  },
};

const NO_FIELD_ERRORS: FieldErrors = [];

function decide(entry: Entry, cause: string, extra: { readonly supportReference?: string | null; readonly retryAfterSeconds?: number | null; readonly fieldErrors?: FieldErrors; readonly current?: CurrentFacts | null } = {}): StateDecision {
  const showsSupportReference = entry.showsSupportReference === true;
  return {
    state: entry.state,
    next: entry.next,
    keepsLocalEdits: entry.keepsLocalEdits === true,
    showsSupportReference,
    discouragesRepeat: entry.discouragesRepeat === true,
    supportReference: showsSupportReference ? (extra.supportReference ?? null) : null,
    retryAfterSeconds: extra.retryAfterSeconds ?? null,
    fieldErrors: extra.fieldErrors ?? NO_FIELD_ERRORS,
    current: extra.current ?? null,
    cause,
  };
}

/** The state of a contract-valid Problem: by code, and for the closed reasons above by reason. Prose (title) is never read. */
export function stateOfProblem(problem: Problem): StateDecision {
  const byReason = problem.reason === undefined ? undefined : REASON_STATES[problem.code]?.[problem.reason];
  const entry = byReason ?? PROBLEM_STATES[problem.code];
  const cause = `PROBLEM:${problem.code}${byReason !== undefined && problem.reason !== undefined ? `/${problem.reason}` : ""}`;
  return decide(entry, cause, {
    supportReference: problem.correlationId,
    retryAfterSeconds: problem.retryAfterSeconds ?? null,
    fieldErrors: entry.state === "UNSAVED" ? (problem.errors ?? NO_FIELD_ERRORS) : NO_FIELD_ERRORS,
    current: entry.state === "STALE" ? (problem.current ?? null) : null,
  });
}

const CHECKING: Entry = { state: "PENDING", next: "REQUERY" };
const INTEGRITY: Entry = { state: "INTEGRITY_FAILURE", next: "CONTACT_SUPPORT", showsSupportReference: true };

/** What a screen shows while a fetch is in flight: the previous private view is cleared and the fetch is shown. */
export function loading(): StateDecision {
  return decide({ state: "LOADING", next: "NONE" }, "LOADING");
}

export interface ReadClassifiers<Body> {
  readonly isEmpty?: (body: Body) => boolean;
  readonly isDeleted?: (body: Body) => boolean;
}

/** The state of a read (or any answer): a valid body is Ready, Empty or Deleted; the other three answers are decided above. */
export function stateOfAnswer<Body>(answer: ApiAnswer<Body>, classifiers: ReadClassifiers<Body> = {}): StateDecision {
  switch (answer.kind) {
    case "REPLY":
      if (classifiers.isDeleted?.(answer.body) === true) return decide({ state: "DELETED", next: "NONE" }, "REPLY:DELETED");
      if (classifiers.isEmpty?.(answer.body) === true) return decide({ state: "EMPTY", next: "NONE" }, "REPLY:EMPTY");
      return decide({ state: "READY", next: "NONE" }, "REPLY:READY");
    case "PROBLEM":
      return stateOfProblem(answer.problem);
    case "NO_ANSWER":
      return decide(CHECKING, `NO_ANSWER:${answer.reason}`);
    case "INTEGRITY":
      return decide(INTEGRITY, `INTEGRITY:${answer.failure}`, { supportReference: answer.correlationId });
  }
}

/** The state of a finished OperationRunner run. Success only from a COMPLETED envelope or a re-read; a lost answer is Checking. */
export function stateOfRun(outcome: RunOutcome<unknown>): StateDecision {
  switch (outcome.kind) {
    case "COMPLETED":
      return decide({ state: "SUCCESS", next: "NONE" }, outcome.replayed ? "RUN:COMPLETED_REPLAYED" : "RUN:COMPLETED");
    case "RECOVERED":
      return decide({ state: "SUCCESS", next: "NONE" }, "RUN:RECOVERED");
    case "ACCEPTED":
      return decide({ state: "PENDING", next: "REQUERY" }, "RUN:ACCEPTED", { retryAfterSeconds: outcome.accepted.pollAfterSeconds });
    case "CHECKING":
      return decide(CHECKING, `RUN:CHECKING/${outcome.lastRead}`);
    case "INTEGRITY":
      return decide(INTEGRITY, `RUN:INTEGRITY/${outcome.failure}`, { supportReference: outcome.correlationId });
    case "PROBLEM":
      return stateOfProblem(outcome.problem);
  }
}
