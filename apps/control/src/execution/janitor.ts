/**
 * STAGING_JANITOR (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §7, D8-JAN-1, D8-STG-1,
 * D8-STG-2; S075; 09 "Derived data and worker scratch": an external janitor cleans only exact owned resources and records cost and
 * result). One ended attempt at a time, and only one whose staging no package still needs (none, or one AVAILABLE, RETIRED or
 * DELETED — its delivery copies are the package; a REVOKED package's staging is private evidence, kept, D8-VER-1):
 *   1. its provider job terminated by exactly its identity (an UNCERTAIN answer leaves the attempt for the next run: nothing is
 *      deleted under a worker that may still write), and the VM, disk and cost the host reports for it;
 *   2. exactly its prefix `staging/{agency}/{project}/{job}/{attempt}/` listed, every object deleted by generation through B07's
 *      registry pipeline (requestAndDelete: an object the registry never knew — the manifest, a failed attempt's artifact — is
 *      registered RESIDUAL at its generation first, D-OBJ-1), and the registered objects of the prefix the listing no longer shows
 *      closed by their absence; the location's retention read back first when it never was (D-OBJ-2, B07's LocationPolicy);
 *   3. exactly its scratch directory removed (@kauro/data-plane removeAttemptScratch, a link unlinked and never followed);
 *   4. one attempt_cleanups row per pass: its identity and prefix, the generations deleted, the termination's answer, the scratch, the
 *      host's report, CLEANED or PARTIAL, and SIMULATED unless both the host and the storage are real providers. A PARTIAL pass — an
 *      object or the scratch left, or the host's resource report unavailable — is retried by a later pass, at most
 *      EXECUTION_POLICY.cleanupPasses in all; CLEANED is final (B08-R2, B08-R4, D8-REV-3, D8-REV-4; migration 0024).
 * Nothing outside the prefix is listed, touched or recorded: the database refuses a cleanup naming another attempt's object (KA080).
 */
import type { ExecutionSweeper, ExecutionUnits, ObjectStoragePort, WorkerHostPort, WorkerResources } from "@kauro/application";
import { removeAttemptScratch } from "@kauro/data-plane";
import { EXECUTION_POLICY } from "@kauro/domain";
import type { AgencyId, AttemptCleanupId, CausationId, CorrelationId, IdGenerator, ProcessingAttemptId, ProjectId, RevisionId, StoredObjectId, StoredObjectRecord } from "@kauro/domain";
import { requestAndDelete } from "../storage-work.js";
import { LocationPolicy } from "../sweepers/location-policy.js";
import { SweepRun, type SweepResult } from "../sweepers/sweep.js";
import type { WorkItem } from "../work.js";
import type { JobPipeline } from "./pipeline.js";
import { EXECUTION_SERVICES, applied, refused, retry, waiting, type ExecutionStep } from "./work.js";

/** The deletion reason of an attempt's staging objects (a token). */
export const ATTEMPT_CLEANUP = "ATTEMPT_CLEANUP";

export interface StagingJanitorDependencies {
  readonly ids: IdGenerator;
  readonly units: ExecutionUnits;
  readonly pipeline: JobPipeline;
  readonly host: WorkerHostPort;
  readonly storage: ObjectStoragePort;
  /** Where the worker host keeps the attempts' scratch (the host's disk; B14 binds the Batch VM's). */
  readonly workerScratchRoot: string;
  readonly retryAfterSeconds: number;
  /** Removes exactly one attempt's scratch (@kauro/data-plane removeAttemptScratch; a test injects a file-system failure here). */
  readonly removeScratch?: (root: string, attemptId: ProcessingAttemptId) => unknown;
}

export class StagingJanitor implements ExecutionSweeper {
  readonly name = "STAGING_JANITOR" as const;
  readonly #locations: LocationPolicy;

  constructor(private readonly deps: StagingJanitorDependencies) {
    this.#locations = new LocationPolicy({ ids: deps.ids, storage: deps.storage, zones: ["STAGING"] });
  }

  async sweep(_units: ExecutionUnits, limit: number): Promise<SweepResult> {
    const run = new SweepRun(EXECUTION_SERVICES.STAGING_JANITOR, this.deps.ids);
    const due = await this.deps.pipeline.discover(EXECUTION_SERVICES.STAGING_JANITOR, (uow) => uow.executionDiscovery.attemptsToClean(limit));
    let acted = 0;
    for (const attempt of due) {
      if (await run.attempt(attempt.attemptId, async () => (await this.clean(attempt.attemptId, attempt.agencyId)).kind === "APPLIED")) acted += 1;
    }
    return { examined: due.length, acted, failed: run.failures };
  }

  /** The cleanup of one ended attempt (header). */
  async clean(attemptId: ProcessingAttemptId, agencyId: AgencyId): Promise<ExecutionStep> {
    const service = EXECUTION_SERVICES.STAGING_JANITOR;
    const p = this.deps.pipeline;
    const seen = await p.bound(service, agencyId, async (uow) => {
      const x = uow.execution;
      const attempt = await x.getAttempt(attemptId);
      if (attempt === null || !["COMMITTED", "ABANDONED", "FAILED"].includes(attempt.state)) return null;
      // a CLEANED pass is final; a PARTIAL one is retried until the passes are used (the database numbers and bounds them, KA080)
      const last = await x.cleanupOf(attemptId);
      if (last !== null && (last.result === "CLEANED" || last.pass >= EXECUTION_POLICY.cleanupPasses)) return null;
      const pkg = await x.packageOfAttempt(attemptId);
      if (pkg !== null && pkg.state !== "AVAILABLE" && pkg.state !== "RETIRED" && pkg.state !== "DELETED") return null;
      const job = await x.getJob(attempt.jobId);
      const facts = job === null ? null : await x.readAuthority(job);
      return { attempt, revisionId: (facts?.revisionId ?? undefined) as RevisionId | undefined };
    });
    if (seen === null) return refused("NOT_TO_CLEAN");
    const { attempt, revisionId } = seen;

    // 1. exactly its provider job, terminated; what the host reports it cost
    let termination;
    try {
      termination = await this.deps.host.terminate(attempt.identity);
    } catch {
      return retry("HOST_UNAVAILABLE", this.deps.retryAfterSeconds);
    }
    if (termination.outcome === "UNCERTAIN") return waiting("TERMINATION_UNCERTAIN");
    // an unanswered report is not "no report": the pass stays PARTIAL and a later one asks the host again (B08-R4)
    let reportUnavailable = false;
    const report = await this.deps.host.resources(attempt.identity).catch(() => {
      reportUnavailable = true;
      return null;
    });
    const resources: WorkerResources | null = report !== null && report.outcome === "REPORTED" ? report.resources : null;

    // 2. exactly its prefix, every generation deleted through the registry
    await this.#locations.sweep(this.deps.units, 1);
    const location = this.deps.storage.location("STAGING");
    const item: WorkItem = { serviceId: service, agencyId, correlationId: this.deps.ids.next() as CorrelationId, causationId: this.deps.ids.next() as CausationId };
    const listed: Array<{ readonly objectName: string; readonly generation: string; readonly bytes: number }> = [];
    for (let page: string | undefined, first = true; first || page !== undefined; first = false) {
      const batch = await this.deps.storage.list(location, attempt.stagingPrefix, page);
      page = batch.next;
      for (const o of batch.objects) if (o.objectName.startsWith(attempt.stagingPrefix)) listed.push(o);
    }
    const registered = await this.deps.units.runSource({ kind: "SYSTEM", serviceId: service, correlationId: item.correlationId, agencyId }, async (uow) => {
      const rows: StoredObjectRecord[] = [];
      for (const o of listed) {
        const known = (await uow.sources.objects.findByName(location.provider, location.locationRef, o.objectName)).find((r) => r.generation === o.generation);
        if (known !== undefined) {
          rows.push(known);
          continue;
        }
        // an object the registry never knew under this generation (the manifest, a failed or lost attempt's artifact): registered
        // RESIDUAL at its generation, in the attempt's scope, before it is deleted (D-OBJ-1)
        const now = await uow.serverInstant();
        rows.push(
          await uow.sources.objects.register({
            objectId: uow.ids.next() as StoredObjectId,
            agencyId,
            projectId: attempt.projectId as ProjectId,
            ...(revisionId === undefined ? {} : { revisionId }),
            zone: "STAGING",
            dataClass: "RESIDUAL",
            provider: location.provider,
            locationRef: location.locationRef,
            objectName: o.objectName,
            createdBy: { kind: "SERVICE", serviceId: service },
            createdAt: now,
            observed: { generation: o.generation, bytes: o.bytes, observedAt: now, late: false },
          }),
        );
      }
      // the registered objects of the prefix the listing no longer shows: their deletion is recorded by their absence
      const listedKeys = new Set(listed.map((o) => `${o.objectName}#${o.generation}`));
      const scope = await uow.sources.objects.inventory({ projectId: attempt.projectId as ProjectId, ...(revisionId === undefined ? {} : { revisionId }) });
      for (const r of scope) {
        if (r.zone === "STAGING" && r.objectName.startsWith(attempt.stagingPrefix) && r.state !== "DELETED" && !listedKeys.has(`${r.objectName}#${r.generation ?? ""}`)) rows.push(r);
      }
      return rows;
    });
    const outcomes = await requestAndDelete(this.deps.storage, this.deps.units, item, registered, ATTEMPT_CLEANUP);
    const deletedObjects = outcomes
      .filter((o) => o.outcome.kind === "RECORDED" && o.outcome.record.state === "DELETED" && o.outcome.record.generation !== undefined)
      .map((o) => {
        const record = (o.outcome as { readonly record: StoredObjectRecord }).record;
        return { objectId: record.objectId as StoredObjectId, objectName: record.objectName, generation: record.generation as string };
      });
    const allDeleted = deletedObjects.length === registered.filter((r) => r.state !== "DELETED").length;

    // 3. exactly its scratch
    let scratchDeleted = false;
    try {
      (this.deps.removeScratch ?? removeAttemptScratch)(this.deps.workerScratchRoot, attempt.attemptId);
      scratchDeleted = true;
    } catch {
      scratchDeleted = false;
    }

    // 4. one cleanup record of exactly this attempt: this pass
    const cleaned = allDeleted && scratchDeleted && !reportUnavailable;
    const evidenceClass = this.deps.host.evidenceClass === "EXECUTED_PROVIDER" && this.deps.storage.evidenceClass === "EXECUTED_PROVIDER" ? "EXECUTED_PROVIDER" : "SIMULATED";
    await p.bound(service, agencyId, async (uow) => {
      await uow.execution.recordCleanup({
        cleanupId: uow.ids.next() as AttemptCleanupId,
        attemptId: attempt.attemptId,
        deletedObjects,
        terminationResult: termination.outcome,
        scratchDeleted,
        resources,
        ...(reportUnavailable ? { resourceReport: "UNAVAILABLE" as const } : {}),
        result: cleaned ? "CLEANED" : "PARTIAL",
        evidenceClass,
      });
    });
    return applied(cleaned ? "CLEANED" : "PARTIAL");
  }
}
