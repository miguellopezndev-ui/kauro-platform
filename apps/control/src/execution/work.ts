/**
 * The discipline of the execution control plane's work (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-
 * jobs.md §4..§7; decisions D8-CANCEL-1, D8-DUP-1, D8-LOCK-1, D8-CLOCK-1), on B07's (work.ts: D-CTRL-1, D-CTRL-2).
 *
 * - Every write runs in a SYSTEM unit of work bound to the job's agency, as the control-plane service whose edge it is (the actor of
 *   its events; B07 D-CTRL-2): JOB_ADMISSION admits, JOB_EXECUTION launches, submits, verifies and publishes, ATTEMPT_MONITOR
 *   observes and takes over, EXECUTION_CONTROL cancels, JOB_DEADLINES expires, STAGING_JANITOR cleans. Discovery across agencies runs
 *   unbound and reads ids and states only.
 * - No transaction spans a provider or core call (07): a unit records an intent, the call runs outside, the next unit re-reads the
 *   job under its row lock and records the answer only if nothing moved — the check after every await (D8-CANCEL-1, §6).
 * - A step the database refuses because its subject moved (a spent fence, KA080; a lost authority or a cancellation, KA081; an
 *   unlisted edge, KA008; a stale version) is the subject settled by another writer: REFUSED, never retried against the new state
 *   (D8-DUP-1). A provider's transient failure is RETRY; everything else is thrown.
 */
import { isDomainFailure, type AgencyId, type CorrelationId, type IdGenerator, type SystemContext } from "@kauro/domain";

/** The service identity of each piece of execution work (a SERVICE actor; `^[a-z][a-z0-9_-]{1,63}$`). */
export const EXECUTION_SERVICES = Object.freeze({
  JOB_ADMISSION: "job-admission",
  JOB_EXECUTION: "job-execution",
  EXECUTION_CONTROL: "execution-control",
  ATTEMPT_MONITOR: "attempt-monitor",
  JOB_DEADLINES: "job-deadlines",
  STAGING_JANITOR: "staging-janitor",
} as const);

/**
 * What one step of execution work did: APPLIED an edge (`what`); REFUSED because its subject moved, was cancelled or lost its
 * authority (nothing written); WAITING because nothing is due yet (a busy slot, an uncertain launch inside its horizon); RETRY after
 * a provider's transient failure or an answer that is still uncertain.
 */
export type ExecutionStep =
  | { readonly kind: "APPLIED"; readonly what: string }
  | { readonly kind: "REFUSED"; readonly reason: string }
  | { readonly kind: "WAITING"; readonly reason: string }
  | { readonly kind: "RETRY"; readonly reason: string; readonly afterSeconds: number };

export const applied = (what: string): ExecutionStep => ({ kind: "APPLIED", what });
export const refused = (reason: string): ExecutionStep => ({ kind: "REFUSED", reason });
export const waiting = (reason: string): ExecutionStep => ({ kind: "WAITING", reason });
export const retry = (reason: string, afterSeconds: number): ExecutionStep => ({ kind: "RETRY", reason, afterSeconds });

/** A SYSTEM context of `serviceId` bound to `agencyId` (D-CTRL-1). */
export function boundSystem(serviceId: string, agencyId: AgencyId, correlationId: CorrelationId): SystemContext {
  return { kind: "SYSTEM", serviceId, correlationId, agencyId };
}

/** The unbound SYSTEM context of cross-agency discovery. */
export function unboundSystem(serviceId: string, ids: IdGenerator): SystemContext {
  return { kind: "SYSTEM", serviceId, correlationId: ids.next() as CorrelationId };
}

/** Thrown inside a unit of work to roll it back when its subject moved; answered REFUSED with its reason. */
export class StepRefused extends Error {
  constructor(readonly reason: string) {
    super(`execution step refused: ${reason}`);
    this.name = "StepRefused";
  }
}

/** The failure reasons meaning the subject was settled by another writer or lost its authority (the database's verdict). */
const LOST = new Set(["EXECUTION_FENCED", "EXECUTION_AUTHORITY_LOST", "UNLISTED_TRANSITION", "FENCE_DISCIPLINE", "LEASE_FENCED"]);

/**
 * The reason a unit of work was refused because its subject moved: a StepRefused it threw (the unit wraps it), a refusal of the
 * database (KA080, KA081, KA008, KA071, KA005) or a stale version; null for any other failure (the caller rethrows it).
 */
export function refusalOf(e: unknown): string | null {
  if (e instanceof StepRefused) return e.reason;
  if (!isDomainFailure(e)) return null;
  if (e.cause instanceof StepRefused) return e.cause.reason;
  if (e.code === "STALE_VERSION") return "STALE_VERSION";
  if (e.reason !== undefined && LOST.has(e.reason)) return e.reason;
  return null;
}

/** A safe token of a problem string (kauro.is_token): `MISSING_ARTIFACT:role:name:gen` -> MISSING_ARTIFACT. */
export function problemToken(problem: string): string {
  const head = problem.split(":")[0] ?? problem;
  const token = head.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^[^A-Z]+/, "");
  return token.length >= 3 ? token.slice(0, 64) : "VERIFIER_PROBLEM";
}

/** Microseconds of an exact server instant (up to six fractional digits), for deadline arithmetic on the server clock. */
export function microsOfInstant(instant: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(instant);
  if (m === null || m[1] === undefined) throw new RangeError(`not an ISO-8601 UTC instant: ${instant}`);
  return BigInt(Date.parse(`${m[1]}Z`)) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}
