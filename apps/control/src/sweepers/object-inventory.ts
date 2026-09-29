/**
 * OBJECT_INVENTORY (docs/design/B07-upload-source-lifecycle.md §12.5; decisions D-OBJ-1, D-OBJ-2, D-FILE-1, D-CTRL-5; 09 "Storage zones
 * and object registry": the registry is authoritative for intended objects, while periodic provider inventory detects objects
 * missing from that registry — both views are needed; 09 "Resumable session security": a late completed object after cancellation or
 * expiry remains quarantined and is deleted; R2-051).
 *
 * Three comparisons of the provider's listing with the registry, per inventoried zone (QUARANTINE and ACCEPTED, the zones the source
 * lifecycle writes):
 * 1. every live generation the provider lists: a registered generation is known; one the registry reserved the name for (an intent
 *    of an upload that is no longer live — cancelled, expired, rejected, or admitted by another attempt) is observed as a late residual
 *    and deleted; any other is an unregistered generation (an orphan, or a late completion through a session that outlived its
 *    upload) — registered RESIDUAL, late, in the scope its opaque name states, and deleted by generation (D-OBJ-1: a late object is
 *    RESIDUAL for good; it never enters a revision);
 * 2. every generation the provider still holds soft-deleted that the registry does not know: recorded with the expiry the provider
 *    reports (PROVIDER_REPORTED, D-OBJ-2);
 * 3. every admitted file's accepted generation (a discovery read of ids and generations only): missing at the provider →
 *    GENERATION_MISSING, another live generation under its name → GENERATION_CHANGED — the admission is revoked
 *    (source_file.admission_revoked.v1) and, for a missing one, its registry row is closed by an absence check.
 */
import type { ObjectStoragePort, SourceSweeper, StorageLocation } from "@kauro/application";
import {
  isUuidV7,
  zonePrefix,
  type AdmissionRevocationReason,
  type AgencyId,
  type ProjectId,
  type RevisionId,
  type SourceFileId,
  type SourceUnitOfWorkFactory,
  type StorageZone,
  type StoredObjectId,
  type StoredObjectRecord,
  type UploadId,
} from "@kauro/domain";
import { executeDeletion, locationOf, requestAndDelete } from "../storage-work.js";
import { applied, boundTo, publish, type WorkItem } from "../work.js";
import { SweepRun, type SweepResult, type SweeperDependencies } from "./sweep.js";

/** The deletion reason of an object the inventory found outside the registry's knowledge (a token). */
export const UNREGISTERED_GENERATION = "UNREGISTERED_GENERATION";

export interface ObjectInventoryDependencies extends SweeperDependencies {
  readonly storage: ObjectStoragePort;
  /** The zones compared with the registry (default: QUARANTINE and ACCEPTED). */
  readonly zones?: ReadonlyArray<StorageZone>;
}

export interface ObjectInventoryResult extends SweepResult {
  readonly residualsDeleted: number;
  readonly softDeletedRecorded: number;
  readonly admissionsRevoked: number;
}

/** The scope an opaque object name states (D-OBJ-1: the zone and two to five canonical UUIDs; the second is the owning agency). */
export interface NamedScope {
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly revisionId?: RevisionId;
  readonly uploadId?: UploadId;
}

export function scopeOfName(zone: StorageZone, objectName: string): NamedScope | null {
  const parts = objectName.split("/");
  if (parts[0] !== zonePrefix(zone) || !parts.slice(1).every(isUuidV7)) return null;
  const [, agencyId, projectId, third, fourth] = parts;
  if (agencyId === undefined || projectId === undefined) return null;
  // quarantine/<agency>/<project>/<revision>/<upload>; accepted/<agency>/<project>/<file> (the file of a promotion names no revision)
  if (zone === "QUARANTINE" && third !== undefined && fourth !== undefined) return { agencyId: agencyId as AgencyId, projectId: projectId as ProjectId, revisionId: third as RevisionId, uploadId: fourth as UploadId };
  return { agencyId: agencyId as AgencyId, projectId: projectId as ProjectId };
}

export class ObjectInventory implements SourceSweeper {
  readonly name = "OBJECT_INVENTORY" as const;
  readonly #zones: ReadonlyArray<StorageZone>;

  constructor(private readonly deps: ObjectInventoryDependencies) {
    this.#zones = deps.zones ?? ["QUARANTINE", "ACCEPTED"];
  }

  async sweep(units: SourceUnitOfWorkFactory, limit: number): Promise<ObjectInventoryResult> {
    const run = new SweepRun("object-inventory", this.deps.ids);
    let examined = 0;
    let residualsDeleted = 0;
    let softDeletedRecorded = 0;
    let admissionsRevoked = 0;
    for (const zone of this.#zones) {
      const location = this.deps.storage.location(zone);
      const prefix = `${zonePrefix(zone)}/`;
      // 1. live generations
      for (let page: string | undefined, first = true; first || page !== undefined; first = false) {
        const listed = await this.deps.storage.list(location, prefix, page);
        page = listed.next;
        for (const object of listed.objects) {
          examined += 1;
          const done = await run.attempt(object.objectName, () => this.#reconcileLive(units, run, zone, location, object));
          if (done) residualsDeleted += 1;
        }
      }
      // 2. soft-deleted generations the registry does not know
      for (let page: string | undefined, first = true; first || page !== undefined; first = false) {
        const listed = await this.deps.storage.listSoftDeleted(location, prefix, page);
        page = listed.next;
        for (const object of listed.objects) {
          examined += 1;
          const done = await run.attempt(object.objectName, () => this.#recordSoftDeleted(units, run, zone, location, object));
          if (done) softDeletedRecorded += 1;
        }
      }
    }
    // 3. admitted generations the provider no longer holds as admitted
    for (let after: SourceFileId | undefined, first = true; first || after !== undefined; first = false) {
      const page = await units.runSource(run.discovery, (uow) => uow.sources.files.admittedGenerations({ limit, ...(after === undefined ? {} : { after }) }));
      after = page.length === limit ? page[page.length - 1]?.fileId : undefined;
      for (const admitted of page) {
        examined += 1;
        const done = await run.attempt(admitted.fileId, () => this.#checkAdmitted(units, run.itemFor(admitted.agencyId), admitted));
        if (done) admissionsRevoked += 1;
      }
    }
    return { examined, acted: residualsDeleted + softDeletedRecorded + admissionsRevoked, failed: run.failures, residualsDeleted, softDeletedRecorded, admissionsRevoked };
  }

  /** One live generation: known, the object of a settled intent, or unregistered (registered RESIDUAL and deleted). */
  async #reconcileLive(units: SourceUnitOfWorkFactory, run: SweepRun, zone: StorageZone, location: StorageLocation, object: { readonly objectName: string; readonly generation: string; readonly bytes: number }): Promise<boolean> {
    const rows = await units.runSource(run.discovery, (uow) => uow.sources.objects.findByName(location.provider, location.locationRef, object.objectName));
    if (rows.some((r) => r.generation === object.generation)) return false;
    const scope = scopeOfName(zone, object.objectName);
    if (scope === null) throw new Error("UNPARSEABLE_OBJECT_NAME");
    const item = run.itemFor(scope.agencyId);
    const intent = rows.find((r) => r.state === "INTENDED" && r.generation === undefined);
    const residual = await units.runSource(boundTo(item), async (uow): Promise<StoredObjectRecord | null> => {
      const now = await uow.serverInstant();
      if (intent !== undefined) {
        // the object of an intent: a live upload's own completion is its inspection's to observe; any other is late
        const upload = intent.uploadId === undefined ? null : await uow.sources.uploads.get(intent.uploadId);
        if (upload !== null && (upload.state === "RESERVED" || upload.state === "UPLOADING" || upload.state === "VERIFYING")) return null;
        return uow.sources.objects.observe(intent.objectId, { generation: object.generation, bytes: object.bytes, observedAt: now, late: true });
      }
      const upload = scope.uploadId === undefined ? null : await uow.sources.uploads.get(scope.uploadId);
      if (upload !== null && (upload.state === "RESERVED" || upload.state === "UPLOADING" || upload.state === "VERIFYING")) return null;
      const known = upload !== null && upload.projectId === scope.projectId && upload.revisionId === scope.revisionId;
      return uow.sources.objects.register({
        objectId: uow.ids.next() as StoredObjectId,
        agencyId: scope.agencyId,
        projectId: scope.projectId,
        ...(known ? { revisionId: upload.revisionId, uploadId: upload.uploadId } : {}),
        zone,
        dataClass: "RESIDUAL",
        provider: location.provider,
        locationRef: location.locationRef,
        objectName: object.objectName,
        createdBy: { kind: "SERVICE", serviceId: item.serviceId },
        createdAt: now,
        observed: { generation: object.generation, bytes: object.bytes, observedAt: now, late: true },
      });
    });
    if (residual === null) return false;
    const [deleted] = await requestAndDelete(this.deps.storage, units, item, [residual], UNREGISTERED_GENERATION);
    return deleted?.outcome.kind === "RECORDED";
  }

  /** One soft-deleted generation: recorded with the provider's reported expiry unless the registry already knows it. */
  async #recordSoftDeleted(
    units: SourceUnitOfWorkFactory,
    run: SweepRun,
    zone: StorageZone,
    location: StorageLocation,
    object: { readonly objectName: string; readonly generation: string; readonly softDeletedAt: string; readonly expiresAt: string },
  ): Promise<boolean> {
    const rows = await units.runSource(run.discovery, (uow) => uow.sources.objects.findByName(location.provider, location.locationRef, object.objectName));
    if (rows.some((r) => r.generation === object.generation)) return false;
    const scope = scopeOfName(zone, object.objectName);
    if (scope === null) throw new Error("UNPARSEABLE_OBJECT_NAME");
    const item = run.itemFor(scope.agencyId);
    await units.runSource(boundTo(item), async (uow) => {
      const upload = scope.uploadId === undefined ? null : await uow.sources.uploads.get(scope.uploadId);
      const known = upload !== null && upload.projectId === scope.projectId && upload.revisionId === scope.revisionId;
      await uow.sources.objects.recordProviderResidual({
        objectId: uow.ids.next() as StoredObjectId,
        agencyId: scope.agencyId,
        projectId: scope.projectId,
        ...(known ? { revisionId: upload.revisionId, uploadId: upload.uploadId } : {}),
        zone,
        dataClass: "RESIDUAL",
        provider: location.provider,
        locationRef: location.locationRef,
        objectName: object.objectName,
        createdBy: { kind: "SERVICE", serviceId: item.serviceId },
        createdAt: await uow.serverInstant(),
        observed: { generation: object.generation, bytes: 0, observedAt: object.softDeletedAt, late: true },
        generation: object.generation,
        softDeletedAt: object.softDeletedAt,
        providerExpiresAt: object.expiresAt,
      });
    });
    return true;
  }

  /** One admitted file: its accepted generation must still be the live generation of its name (D-FILE-1). */
  async #checkAdmitted(
    units: SourceUnitOfWorkFactory,
    item: WorkItem,
    admitted: { readonly fileId: SourceFileId; readonly originRevisionId: RevisionId; readonly acceptedObjectId: StoredObjectId; readonly providerGeneration: string },
  ): Promise<boolean> {
    const object = await units.runSource(boundTo(item), (uow) => uow.sources.objects.get(admitted.acceptedObjectId));
    if (object === null) return false;
    const seen = await this.deps.storage.stat(locationOf(object), object.objectName);
    const reason: AdmissionRevocationReason | null = seen === null ? "GENERATION_MISSING" : seen.generation !== admitted.providerGeneration ? "GENERATION_CHANGED" : null;
    if (reason === null) return false;
    const revoked = await units.runSource(boundTo(item), async (uow) => {
      if ((await uow.sources.revisions.lock(admitted.originRevisionId)) === null) return false;
      const file = await uow.sources.files.get(admitted.fileId);
      if (file === null || file.state !== "ADMITTED") return false;
      const selectedBy = await uow.sources.files.selectedBy(file.fileId);
      const sealedBy = await uow.sources.files.sealedBy(file.fileId);
      const record = applied(await uow.sources.files.revokeAdmission(file.fileId, file.version, reason), "admission revocation");
      await publish(uow, item, "source_file", file.fileId, record.version, "source_file.admission_revoked.v1", {
        fileId: file.fileId,
        agencyId: item.agencyId,
        projectId: file.projectId,
        revocationReason: reason,
        selectedByRevisionIds: [...selectedBy],
        sealedByRevisionIds: [...sealedBy],
      });
      // a generation the provider no longer holds is closed by its absence; a changed one stays registered as it was (the live
      // generation under its name is unregistered and handled as one)
      if (reason === "GENERATION_MISSING") await uow.sources.objects.requestDeletion([object.objectId], reason, await uow.serverInstant());
      return true;
    });
    if (revoked && reason === "GENERATION_MISSING") await executeDeletion(this.deps.storage, units, item, object.objectId);
    return revoked;
  }
}
