/**
 * Orchestration contracts of processing authority's control plane (package B08, mandate B08-CONTROL-EXECUTION; types and the sweeper
 * list only — the implementations are apps/control's; docs/design/B08-audit-approval-jobs.md §4..§7, §11).
 *
 * The consumers JOB_EXECUTION and EXECUTION_CONTROL are B07's `OutboxConsumer`s over B07's dispatcher (D8-CONS-1): at least once,
 * in SYSTEM units bound to the event's agency, idempotent by their fences and the listed transitions (D8-DUP-1). The sweepers below
 * run on the server clock in SYSTEM units bound to each work item's agency, with discovery unbound (D-CTRL-1; D8-PEX-6).
 *
 * EXECUTION_SWEEPERS is §11's list as this mandate builds it: JOB_ADMISSION (the fair round under the global ledger, D8-SCHED-1,
 * D8-LOCK-1, and the hand-over of the ACTIVE slot), ATTEMPT_MONITOR (observe by identity, heartbeat under the fence, the ambiguous
 * launch reconciled before any create, the lapsed lease abandoned after its provider job is terminal, the takeover at fence + 1;
 * D8-ATT-1, D8-ATT-2, D8-HOST-1), JOB_DEADLINES (never early, the exact provider job terminated first; D8-DL-1) and STAGING_JANITOR
 * (one attempt, its exact prefix, its scratch, one cleanup record; D8-JAN-1). B08-CONTROL-AUDIT adds AUDIT_DEADLINES and
 * GRANT_RECONCILIATION (decision D8-CEX-2).
 */
import type { ExecutionUnitOfWorkFactory, SourceUnitOfWorkFactory } from "@kauro/domain";

export const EXECUTION_SWEEPERS = Object.freeze(["JOB_ADMISSION", "ATTEMPT_MONITOR", "JOB_DEADLINES", "STAGING_JANITOR"] as const);
export type ExecutionSweeperName = (typeof EXECUTION_SWEEPERS)[number];

/** The units of work the execution control plane runs: the execution factory, which also opens source units (D8-XPKG-10). */
export type ExecutionUnits = ExecutionUnitOfWorkFactory & SourceUnitOfWorkFactory;

/** Periodic execution work with no triggering event, on the server clock (D8-CLOCK-1), each item in a unit bound to its agency. */
export interface ExecutionSweeper {
  readonly name: ExecutionSweeperName;
  sweep(units: ExecutionUnits, limit: number): Promise<{ readonly examined: number; readonly acted: number }>;
}
