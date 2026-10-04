/**
 * ATTEMPT_MONITOR (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §4.3, §7; decisions D8-ATT-1,
 * D8-ATT-2, D8-HOST-1): one pass over the uncancelled ADMITTED or RUNNING jobs holding the ACTIVE slot, one step per job
 * (JobPipeline.observe) — a CLAIMED attempt launched, an uncertain launch reconciled by observing its identity before any other
 * create, a live worker heartbeated under its fence, a silent one whose lease lapsed terminated, abandoned and taken over at fence + 1,
 * a finished one submitted, a failed one ended with its classified cause. Then the ACTIVE slot is handed on if it was released.
 * Heartbeats reach the lease only through this observation: the worker opens no SQL pool (D8-ATT-2).
 */
import type { ExecutionSweeper, ExecutionUnits } from "@kauro/application";
import type { IdGenerator } from "@kauro/domain";
import { SweepRun, type SweepResult } from "../sweepers/sweep.js";
import type { JobPipeline } from "./pipeline.js";
import { EXECUTION_SERVICES } from "./work.js";

export class AttemptMonitor implements ExecutionSweeper {
  readonly name = "ATTEMPT_MONITOR" as const;

  constructor(private readonly deps: { readonly ids: IdGenerator; readonly pipeline: JobPipeline }) {}

  async sweep(_units: ExecutionUnits, limit: number): Promise<SweepResult> {
    const run = new SweepRun(EXECUTION_SERVICES.ATTEMPT_MONITOR, this.deps.ids);
    const p = this.deps.pipeline;
    const jobs = await p.discover(EXECUTION_SERVICES.ATTEMPT_MONITOR, (uow) => uow.executionDiscovery.monitoredJobs(limit));
    let acted = 0;
    for (const job of jobs) {
      if (await run.attempt(job.jobId, async () => (await p.observe(job.jobId, job.agencyId)).kind === "APPLIED")) acted += 1;
    }
    if (await run.attempt("launch", async () => (await p.launchNext()).kind === "APPLIED")) acted += 1;
    return { examined: jobs.length, acted, failed: run.failures };
  }
}
