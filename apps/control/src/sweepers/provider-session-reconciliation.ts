/**
 * PROVIDER_SESSION_RECONCILIATION (docs/design/B07-upload-source-lifecycle.md §12.5; decisions D-ROLE-3, D-SESSION-1, D-SESSION-3,
 * Q-B07-23; 09 "Resumable session security": if cancellation cannot be confirmed, the system records SESSION_REVOCATION_PENDING and
 * continues reconciliation until the provider lifetime ends).
 *
 * Every provider cancellation still pending — REQUESTED (the database requested it with a tombstone, no answer recorded yet) or
 * UNCERTAIN (answered without confirmation), together SESSION_REVOCATION_PENDING — whose provider horizon is still ahead on the server
 * clock is attempted again; a forward answer (CONFIRMED or UNSUPPORTED, or any answer to REQUESTED) is recorded with its event and
 * the bearer record purged once resolved. Past the horizon the session is dead and nothing is found.
 */
import type { ObjectStoragePort, SessionVaultPort, SourceSweeper } from "@kauro/application";
import type { SourceUnitOfWorkFactory } from "@kauro/domain";
import { cancelProviderSession } from "../storage-work.js";
import { SweepRun, type SweepResult, type SweeperDependencies } from "./sweep.js";

export interface ProviderSessionReconciliationDependencies extends SweeperDependencies {
  readonly storage: ObjectStoragePort;
  readonly vault: SessionVaultPort;
}

export class ProviderSessionReconciliation implements SourceSweeper {
  readonly name = "PROVIDER_SESSION_RECONCILIATION" as const;

  constructor(private readonly deps: ProviderSessionReconciliationDependencies) {}

  async sweep(units: SourceUnitOfWorkFactory, limit: number): Promise<SweepResult> {
    const run = new SweepRun("provider-session-reconciliation", this.deps.ids);
    const due = await units.runSource(run.discovery, (uow) => uow.sources.uploads.findProviderReconciliation(limit));
    let acted = 0;
    for (const found of due) {
      const recorded = await run.attempt(found.uploadId, async () => {
        const outcome = await cancelProviderSession(this.deps.storage, this.deps.vault, units, run.itemFor(found.agencyId), found.uploadId);
        if (outcome.kind === "FAILED") throw new Error(`PROVIDER_CANCELLATION_FAILED:${outcome.cause}`);
        return outcome.kind === "ANSWERED" && outcome.recorded;
      });
      if (recorded) acted += 1;
    }
    return { examined: due.length, acted, failed: run.failures };
  }
}
