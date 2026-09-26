/**
 * LOCATION_POLICY (docs/design/B07-upload-source-lifecycle.md §12.5; decision D-OBJ-2; 09 "Soft delete, versioning and holds": the
 * effective setting is verified after provisioning, and the actual residual expiry is recorded rather than a claim that the object
 * vanished).
 *
 * Reads back the effective soft-delete retention and object versioning of every storage location the source lifecycle writes and
 * appends the read-back to kauro.storage_location_policies at the server's instant, with its evidence hash and class (a contract
 * fake's read-back is SIMULATED, never EXECUTED_PROVIDER). Load-bearing: a deletion cannot be recorded at a location never read back
 * (the database refuses it, KA072). It reads a location back at start — when it has no read-back — and whenever its latest one is
 * older than `maxAgeSeconds` (daily by default).
 */
import type { ObjectStoragePort, SourceSweeper } from "@kauro/application";
import type { SourceUnitOfWorkFactory, StorageZone } from "@kauro/domain";
import { isAfter, microsOf } from "../work.js";
import { SweepRun, type SweepResult, type SweeperDependencies } from "./sweep.js";

export interface LocationPolicyDependencies extends SweeperDependencies {
  readonly storage: ObjectStoragePort;
  /** The zones whose locations are read back (default: QUARANTINE and ACCEPTED, the zones the source lifecycle writes). */
  readonly zones?: ReadonlyArray<StorageZone>;
  /** A read-back older than this is renewed (default 86,400 s). */
  readonly maxAgeSeconds?: number;
}

export class LocationPolicy implements SourceSweeper {
  readonly name = "LOCATION_POLICY" as const;

  constructor(private readonly deps: LocationPolicyDependencies) {}

  async sweep(units: SourceUnitOfWorkFactory, _limit: number): Promise<SweepResult> {
    const run = new SweepRun("location-policy", this.deps.ids);
    const zones = this.deps.zones ?? ["QUARANTINE", "ACCEPTED"];
    const maxAgeMicros = BigInt(this.deps.maxAgeSeconds ?? 86_400) * 1_000_000n;
    let acted = 0;
    for (const zone of zones) {
      const location = this.deps.storage.location(zone);
      const done = await run.attempt(`${location.provider}/${location.locationRef}`, async () => {
        const fresh = await units.runSource(run.discovery, async (uow) => {
          const now = await uow.serverInstant();
          const latest = await uow.sources.objects.locationPolicyAt(location.provider, location.locationRef, now);
          return latest !== null && isAfter(latest.observedAt, now) === false && microsOf(now) - microsOf(latest.observedAt) < maxAgeMicros;
        });
        if (fresh) return false;
        const readBack = await this.deps.storage.readRetentionPolicy(location);
        await units.runSource(run.discovery, (uow) =>
          uow.sources.objects.recordLocationPolicy({
            observationId: uow.ids.next(),
            provider: location.provider,
            locationRef: location.locationRef,
            softDeleteRetentionSeconds: readBack.softDeleteRetentionSeconds,
            objectVersioning: readBack.objectVersioning,
            evidenceHash: readBack.evidenceHash,
            evidenceClass: this.deps.storage.evidenceClass,
          }),
        );
        return true;
      });
      if (done) acted += 1;
    }
    return { examined: zones.length, acted, failed: run.failures };
  }
}
