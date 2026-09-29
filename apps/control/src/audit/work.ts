/**
 * The discipline of the control plane's audit work (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md
 * §3, §6, §7, §11; decisions D8-AUD-2, D8-CANCEL-1, D8-DUP-1, D8-CLOCK-1, D8-CAU-1, D8-CAU-8), on the execution work's (work.ts of
 * ../execution): every write in a SYSTEM unit of work of the audit units (`AuditUnits`, D8-PAU-9) bound to the agency of the audit,
 * plan or grant, as the control-plane service whose edge it is (the actor of its events); discovery across agencies unbound, ids and
 * states only; no transaction spans a core call — a unit claims the step, the core runs outside, the next unit re-reads the audit under
 * its row lock and records the answer only if nothing moved (§6). A refusal of the database because the subject moved (KA080, KA081,
 * KA007, KA008, a stale version) is the subject settled by another writer: REFUSED, never retried against the new state.
 */
import type { AuditUnits, CancellationChannel, CancellationState } from "@kauro/application";
import type { UtcInstant } from "@kauro/contracts";
import { NotFoundFailure, type AgencyId, type AuditUnitOfWork, type IdGenerator } from "@kauro/domain";
import { StepRefused, boundSystem, microsOfInstant, refusalOf, refused, retry, type ExecutionStep } from "../execution/work.js";

/** The units, ids and retry hint every piece of audit work shares. */
export interface AuditWorkDependencies {
  readonly units: AuditUnits;
  readonly ids: IdGenerator;
  /** When a core's transient failure is retried (seconds). */
  readonly retryAfterSeconds: number;
}

/** A SYSTEM unit of `service` bound to the agency (D-CTRL-1), on the audit units. */
export function inAgency<T>(deps: AuditWorkDependencies, service: string, agencyId: AgencyId, work: (uow: AuditUnitOfWork) => Promise<T>): Promise<T> {
  return deps.units.run(boundSystem(service, agencyId, deps.ids.next() as never), work);
}

/** The unbound SYSTEM unit of cross-agency discovery (ids and states only). */
export function acrossAgencies<T>(deps: AuditWorkDependencies, service: string, work: (uow: AuditUnitOfWork) => Promise<T>): Promise<T> {
  return deps.units.run({ kind: "SYSTEM", serviceId: service, correlationId: deps.ids.next() as never }, work);
}

/** The database's own transaction time in a unit bound to the agency (D8-CLOCK-1; the TEST CLOCK in tests). */
export function serverNowIn(deps: AuditWorkDependencies, service: string, agencyId: AgencyId): Promise<UtcInstant> {
  return inAgency(deps, service, agencyId, (uow) => uow.executionDiscovery.serverNow());
}

/** `now` at or past `deadline`, exact to the microsecond on the server clock (never early, D8-DL-1). */
export function reached(now: string, deadline: string): boolean {
  return microsOfInstant(now) >= microsOfInstant(deadline);
}

/**
 * Runs a step whose units may be refused because the subject moved: the refusal is the step's answer (D8-DUP-1); a core's transient
 * failure is RETRY after the hint; anything else is thrown (the dispatcher retries the delivery, whose next claim takes fence + 1).
 */
export async function guarded(retryAfterSeconds: number, work: () => Promise<ExecutionStep>): Promise<ExecutionStep> {
  try {
    return await work();
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { transient?: unknown }).transient === true) return retry("CORE_UNAVAILABLE", retryAfterSeconds);
    const reason = refusalOf(e);
    if (reason !== null) return refused(reason);
    // an intent another delivery settled first (the store's `WHERE result IS NULL` missed it): the subject moved
    if (e instanceof NotFoundFailure || (e instanceof Error && e.cause instanceof NotFoundFailure)) return refused("SETTLED_ELSEWHERE");
    throw e;
  }
}

/**
 * The cancellation channel of a core call (D8-CANCEL-1): each check is a unit re-reading the subject — FENCED once another claim
 * took the fence, CANCELLED once the subject was cancelled, expired or moved on, CONTINUE otherwise.
 */
export function channelOf(deps: AuditWorkDependencies, service: string, agencyId: AgencyId, judge: (uow: AuditUnitOfWork) => Promise<CancellationState>): CancellationChannel {
  return { check: () => inAgency(deps, service, agencyId, judge) };
}

export { StepRefused };
