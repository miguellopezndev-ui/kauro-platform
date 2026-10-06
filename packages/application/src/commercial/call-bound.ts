/**
 * The bound of a collaborator call a B10 command makes (D10-GAP-6, D10-GAP-6a, B10G-R4): PROVIDER_CALL_TIMEOUT_MS on the ProviderCallTimer
 * the command's collaborators bind (realProviderCallTimer in a deployment; a fault cell binds a timer its controlled clock drives).
 */
import { DomainFailure, PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { realProviderCallTimer } from "./bindings.js";
import type { ProviderCallTimer } from "./ports.js";

export type Bounded<T> = { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

/** What became of a call after its bound gave it up: the failure nobody awaits, named by the call (a safe token) and its error. */
export interface LateFailure {
  readonly call: string;
  readonly error: unknown;
}
export type LateFailureSink = (late: LateFailure) => void;

/** The class and SQLSTATE/errno of a failure only, never its message (14 "Monitoring and service health": sinks name safe tokens). */
function safeCause(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? `${error.name} code=${String(code)}` : error.name;
}

/** The default sink: one line on stderr, like the api's other operational sinks. */
export const writeLateFailure: LateFailureSink = (late) => {
  process.stderr.write(`kauro-api call bound: abandoned call failed late call=${late.call} cause=${safeCause(late.error)}\n`);
};

/**
 * Lifts the unit's limit after an in-time answer. When the answer was delayed past the limit's margin (a long pause of the process) the
 * database has already ended the session and the lift fails: nothing of the unit committed, so the caller gets the retriable refusal of a
 * call that did not answer in time, not an internal error (D10-GAP-6a).
 */
async function liftLimit(limit: (ms: number | null) => Promise<void>): Promise<void> {
  try {
    await limit(null);
  } catch (cause) {
    const failure = new DomainFailure("CAPACITY_UNAVAILABLE", "the unit of work was ended by its time limit before the call's answer was taken; nothing changed, retry with the same key", { retryAfterSeconds: 5 }, true);
    failure.cause = cause;
    throw failure;
  }
}

export interface CallBoundOptions {
  /** The safe token naming the call in the late-failure line (e.g. "CMD043.inspectClient"). */
  readonly call: string;
  /** Where a failure of the call after its bound elapsed goes (default: writeLateFailure). */
  readonly onLateFailure?: LateFailureSink;
  /** Runs when the bound elapsed first: the caller gives up the work the call still has in flight (a unit of work destroys its connection). */
  readonly abandon?: () => void;
  /**
   * Limits the lifetime of the whole transaction the call runs in (D10-GAP-6a): armed to the bound plus LIMIT_MARGIN_MS before the call starts and
   * lifted once the call answered in time. The database then ends an abandoned unit's session at the bound whatever statement the call is in
   * and whether or not the explicit end of its backend got a connection (statement_timeout restarts with every statement).
   */
  readonly limit?: (ms: number | null) => Promise<void>;
}

/** The database's limit stands this long after the application's bound: the bound always fires first, the limit is its backstop. */
export const LIMIT_MARGIN_MS = 1_000;

/**
 * `call` within PROVIDER_CALL_TIMEOUT_MS: its value, or `{ timedOut: true }` once the bound elapsed first (after `abandon` ran). A call
 * that fails within the bound rethrows; one that fails after the bound was given up reaches the late-failure sink (nobody awaits it).
 */
export async function withinCallBound<T>(timer: ProviderCallTimer | undefined, call: () => Promise<T>, options: CallBoundOptions): Promise<Bounded<T>> {
  await options.limit?.(PROVIDER_CALL_TIMEOUT_MS + LIMIT_MARGIN_MS);
  const bound = (timer ?? realProviderCallTimer).start(PROVIDER_CALL_TIMEOUT_MS);
  const running = call();
  let given = false;
  const sink = options.onLateFailure ?? writeLateFailure;
  running.catch((error: unknown) => {
    if (given) sink({ call: options.call, error });
  });
  try {
    const outcome = await Promise.race([
      running.then((value): Bounded<T> => ({ timedOut: false, value })),
      bound.elapsed.then((): Bounded<T> => {
        given = true;
        return { timedOut: true };
      }),
    ]);
    if (outcome.timedOut) options.abandon?.();
    else if (options.limit !== undefined) await liftLimit(options.limit);
    return outcome;
  } finally {
    bound.cancel();
  }
}
