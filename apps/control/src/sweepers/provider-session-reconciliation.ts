/**
 * PROVIDER_SESSION_RECONCILIATION (docs/design/B07-upload-source-lifecycle.md §12.5; decisions D-ROLE-3, D-SESSION-1, D-SESSION-3,
 * D-CTRL-7, Q-B07-23; 09 "Resumable session security": if cancellation cannot be confirmed, the system records
 * SESSION_REVOCATION_PENDING and continues reconciliation until the provider lifetime ends).
 *
 * Every provider cancellation still pending — REQUESTED (the database requested it with a tombstone, no answer recorded yet) or
 * UNCERTAIN (answered without confirmation), together SESSION_REVOCATION_PENDING — whose provider horizon is still ahead on the server
 * clock is attempted again; a forward answer (CONFIRMED or UNSUPPORTED, or any answer to REQUESTED) is recorded with its event and
 * the bearer record purged once resolved.
 *
 * Past the horizon the session is dead: no provider is asked and no answer is invented, but a pending cancellation's bearer record
 * still stored is purged (B07-R4: a cancellation left UNCERTAIN until its horizon passed would otherwise keep its encrypted session
 * reference with nothing scheduled to remove it). The records are readable by the control plane only bound to their agency, so the
 * unbound discovery names the agencies with a lapsed pending cancellation and each agency's unit of work finds its records still
 * held; each is purged by the same step that purges a lapsed session met on any other path (cancelProviderSession: HORIZON_PASSED).
 */
import type { ObjectStoragePort, SessionVaultPort, SourceSweeper } from "@kauro/application";
import type { AgencyId, SourceUnitOfWorkFactory, UploadId } from "@kauro/domain";
import { cancelProviderSession } from "../storage-work.js";
import { boundTo } from "../work.js";
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
    // B07-R4: the bearer records of pending cancellations whose provider horizon passed, found per agency and purged. The agencies
    // are paged in id order until `limit` records are found or none is left, so an agency whose records were purged earlier never
    // hides one after it; the next run starts again from the first (its purged agencies then yield nothing)
    const lapsed: Array<{ readonly uploadId: UploadId; readonly agencyId: AgencyId }> = [];
    let after: AgencyId | undefined;
    while (lapsed.length < limit) {
      const cursor = after;
      const agencies = await units.runSource(run.discovery, (uow) => uow.sources.uploads.findAgenciesWithLapsedCancellations(limit, cursor));
      for (const agencyId of agencies) {
        if (lapsed.length >= limit) break;
        // one agency's failure to list its records is reported and leaves the others to run (found again by the next run)
        await run.attempt(agencyId, async () => {
          const found = await units.runSource(boundTo(run.itemFor(agencyId)), (uow) => uow.sources.uploads.findLapsedSessionSecrets(limit - lapsed.length));
          lapsed.push(...found);
          return found.length > 0;
        });
      }
      if (agencies.length < limit) break;
      after = agencies.at(-1);
    }
    for (const found of lapsed) {
      const purged = await run.attempt(found.uploadId, async () => (await cancelProviderSession(this.deps.storage, this.deps.vault, units, run.itemFor(found.agencyId), found.uploadId)).kind === "HORIZON_PASSED");
      if (purged) acted += 1;
    }
    return { examined: due.length + lapsed.length, acted, failed: run.failures };
  }
}
