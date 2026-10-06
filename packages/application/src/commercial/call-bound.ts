/**
 * The bound of a collaborator call a B10 command makes (D10-GAP-6, D10-GAP-6a, B10G-R4): PROVIDER_CALL_TIMEOUT_MS on the ProviderCallTimer
 * the command's collaborators bind (realProviderCallTimer in a deployment; a fault cell binds a timer its controlled clock drives).
 */
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
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

export interface CallBoundOptions {
  /** The safe token naming the call in the late-failure line (e.g. "CMD043.inspectClient"). */
  readonly call: string;
  /** Where a failure of the call after its bound elapsed goes (default: writeLateFailure). */
  readonly onLateFailure?: LateFailureSink;
  /** Runs when the bound elapsed first: the caller gives up the work the call still has in flight (a unit of work destroys its connection). */
  readonly abandon?: () => void;
}

/**
 * `call` within PROVIDER_CALL_TIMEOUT_MS: its value, or `{ timedOut: true }` once the bound elapsed first (after `abandon` ran). A call
 * that fails within the bound rethrows; one that fails after the bound was given up reaches the late-failure sink (nobody awaits it).
 */
export async function withinCallBound<T>(timer: ProviderCallTimer | undefined, call: () => Promise<T>, options: CallBoundOptions): Promise<Bounded<T>> {
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
    return outcome;
  } finally {
    bound.cancel();
  }
}
