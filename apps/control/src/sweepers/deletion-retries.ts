/**
 * DELETION_RETRIES (docs/design/B07-upload-source-lifecycle.md §12.5; decisions D-OBJ-1, D-OBJ-2; 09 "Acceptance and operating checks":
 * failed deletion is an operating report, the retry and the remaining object are visible to operations).
 *
 * Every object awaiting a deletion — requested and not yet recorded (a provider call that failed, a record refused because the
 * location was never read back), or DELETION_FAILED (requested again first) — is deleted by its exact generation and the provider's
 * answer recorded at the server's instant with its residual.
 */
import type { ObjectStoragePort, SourceSweeper } from "@kauro/application";
import type { SourceUnitOfWorkFactory } from "@kauro/domain";
import { executeDeletion } from "../storage-work.js";
import { SweepRun, type SweepResult, type SweeperDependencies } from "./sweep.js";

export interface DeletionRetriesDependencies extends SweeperDependencies {
  readonly storage: ObjectStoragePort;
}

export class DeletionRetries implements SourceSweeper {
  readonly name = "DELETION_RETRIES" as const;

  constructor(private readonly deps: DeletionRetriesDependencies) {}

  async sweep(units: SourceUnitOfWorkFactory, limit: number): Promise<SweepResult> {
    const run = new SweepRun("deletion-retries", this.deps.ids);
    const due = await units.runSource(run.discovery, (uow) => uow.sources.objects.pendingDeletion(limit));
    let acted = 0;
    for (const found of due) {
      const done = await run.attempt(found.objectId, async () => {
        const outcome = await executeDeletion(this.deps.storage, units, run.itemFor(found.agencyId), found.objectId);
        if (outcome.kind === "PENDING") throw new Error(`DELETION_NOT_RECORDED:${outcome.cause}`);
        return outcome.kind === "RECORDED" && outcome.record.state === "DELETED";
      });
      if (done) acted += 1;
    }
    return { examined: due.length, acted, failed: run.failures };
  }
}
