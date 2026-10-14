/**
 * DELETION_EXECUTOR (package B16 lane L3; docs/design/B16-L3-failure-matrix.md; manual 09 "Early deletion" and "Deletion receipts"): the
 * consumer of `project.deletion_requested.v1`, the second half of CMD042 RequestDeletion. The request already left the project
 * DELETION_REQUESTED, one REQUESTED deletion request and the retention records DELETING in one COMMIT; this consumer, per delivery
 * (at-least-once, resumable from the recorded results):
 *
 *   1. tombstones the project's authority in the restore journal BEFORE the first delete (AUTHORITY_JOURNAL's own handler, idempotent by
 *      event id) and moves the request REQUESTED -> AUTHORITY_REVOKED -> DELETING (FAILED_RETRYABLE -> DELETING on a later delivery);
 *   2. ends what still relies on the project: the live jobs (EXECUTION_CONTROL's cancel_command) and the live audits of its revisions,
 *      then their grants; a cancellation still settling is a RETRY, no object is deleted under a running attempt;
 *   3. requests the deletion of every managed registered object (every zone but LEGAL_FINANCE and SECURITY, whose copies are lawful
 *      residuals named in the receipt) and deletes each by its exact generation, each result in its own unit of work; a
 *      DELETION_FAILED object is DELETION_RETRIES' (09: retried by the sweeper, never in a loop here);
 *   4. compares the registry with the provider: the live generations and the soft-deleted ones under the project's prefixes. A
 *      `deleted_at` alone never completes a receipt (S064): a registered generation the provider still holds live is a residual;
 *   5. appends a receipt every attempt (PARTIAL while a residual stands; COMPLETE_FOR_MANAGED_SCOPE when none does) and, only with a
 *      complete one, closes in ONE unit of work (lock order: deletion row, project, revisions, records, packages): the request COMPLETED, the
 *      project DELETED, each DELETING record DELETED (DELETED_WITH_RESIDUALS when the provider still holds soft-deleted generations),
 *      the private packages REVOKED and the packages DELETED. The database refuses each of those writes without the completed
 *      request of the same transaction (KA088).
 */
import { createHash } from "node:crypto";
import type { ConsumerOutcome, ObjectStoragePort, OutboxConsumer } from "@kauro/application";
import {
  zonePrefix,
  type AgencyId,
  type CausationId,
  type DeletionReceiptBody,
  type DeletionReceiptId,
  type DeletionRequestRow,
  type DomainEventRecord,
  type ProjectId,
  type SourceRevisionRecord,
  type SourceUnitOfWork,
  type SourceUnitOfWorkFactory,
  type StorageZone,
  type StoredObjectRecord,
  type SystemContext,
} from "@kauro/domain";
import type { ExecutionPlane } from "../execution/plane.js";
import { locationOf, requestAndDelete } from "../storage-work.js";
import type { LocationPolicy } from "../sweepers/location-policy.js";
import { boundTo, publish, type WorkItem } from "../work.js";
import type { AuthorityJournal } from "./authority-journal.js";

export interface DeletionExecutorDependencies {
  readonly storage: ObjectStoragePort;
  /** The restore journal's handler: the tombstone of the request is appended through it, before any object is deleted. */
  readonly journal: AuthorityJournal;
  /** Cancellation of the jobs and audits relying on the project, and the grants' reconciliation; null when no execution providers are bound. */
  readonly execution: () => ExecutionPlane | null;
  /** Reads back the retention of every managed zone's location (a deletion cannot be recorded at a location never read back, KA072). */
  readonly locationPolicy: LocationPolicy;
  readonly retryAfterSeconds?: number;
}

/** What the receipt always names as outside the managed scope (09 "Deletion receipts"). */
const EXCLUDED = ["CUSTOMER_DOWNLOADED_COPIES", "EXTERNAL_CRM_IMPORTS"] as const;
/** The zones the executor deletes in; LEGAL_FINANCE and SECURITY copies are lawful residuals of a deletion (09), named by the contract and never deleted here. */
export const MANAGED_ZONES: ReadonlyArray<StorageZone> = ["QUARANTINE", "ACCEPTED", "PROFILE", "MINIMIZED", "STAGING", "DELIVERY", "IMPORT_RECEIPT"];
const DELETION_REASON = "PROJECT_DELETION_REQUESTED";

/** The retry the dispatcher reads: when and why. */
function retryAnswer(afterSeconds: number, reason: string): ConsumerOutcome {
  return { kind: "RETRY", afterSeconds, reason };
}

interface Inventory {
  readonly live: ReadonlyArray<{ readonly objectName: string; readonly generation: string }>;
  readonly softDeleted: ReadonlyArray<{ readonly objectName: string; readonly generation: string; readonly expiresAt: string }>;
}

export class DeletionExecutor implements OutboxConsumer {
  readonly consumer = "DELETION_EXECUTOR" as const;

  constructor(private readonly deps: DeletionExecutorDependencies) {}

  async handle(event: DomainEventRecord, context: SystemContext, units: SourceUnitOfWorkFactory): Promise<ConsumerOutcome> {
    if (event.eventType !== "project.deletion_requested.v1" || event.aggregateKind !== "project" || context.agencyId === undefined) return { kind: "DEAD_LETTER", reason: "EVENT_WITHOUT_SUBJECT" };
    const retryAfter = this.deps.retryAfterSeconds ?? 60;
    const agencyId = context.agencyId;
    const projectId = event.aggregateId as ProjectId;
    const item: WorkItem = { serviceId: context.serviceId, agencyId, correlationId: context.correlationId, causationId: event.eventId as unknown as CausationId };
    const request = await units.runSource(boundTo(item), (uow) => uow.sources.deletions.forProject(projectId));
    if (request === null || request.deletionId !== (event.payload["deletionId"] as string)) return { kind: "DEAD_LETTER", reason: "DELETION_NOT_FOUND" };
    if (request.state === "COMPLETED") return { kind: "DONE" };

    // 1. the tombstone before any effect (idempotent by the event id)
    const tombstoned = await this.deps.journal.handle(event, context, units);
    if (tombstoned.kind !== "DONE") return tombstoned;
    await units.runSource(boundTo(item), async (uow) => {
      const deletions = uow.sources.deletions;
      const locked = await deletions.lock(request.deletionId);
      if (locked === null) return;
      if (locked.state === "REQUESTED") await deletions.advance(request.deletionId, ["REQUESTED"], "AUTHORITY_REVOKED");
      await deletions.advance(request.deletionId, ["AUTHORITY_REVOKED", "FAILED_RETRYABLE", "RESIDUAL_HOLD", "VERIFYING"], "DELETING");
    });

    // 2. what relies on the project ends first
    const settling = await this.#endReliance(agencyId, projectId, item, units);
    if (settling !== null) return retryAnswer(retryAfter, settling);

    // 3. the managed objects, each by its exact generation (every zone's location read back first, then the provider's unregistered live generations removed too)
    await this.deps.locationPolicy.sweep(units, MANAGED_ZONES.length);
    const managed = await units.runSource(boundTo(item), (uow) => uow.sources.deletions.managedObjects(projectId));
    const candidates = managed.filter((o) => o.state !== "DELETED" && o.state !== "DELETION_FAILED");
    const deleted = await requestAndDelete(this.deps.storage, units, item, candidates, DELETION_REASON, true);
    if (deleted.some((d) => d.outcome.kind === "PENDING")) return retryAnswer(retryAfter, "DELETION_RESULT_UNRECORDED");

    await this.#removeUnregistered(agencyId, projectId, item, units, managed);

    // 4. the registry against the provider
    const after = await units.runSource(boundTo(item), async (uow) => ({
      objects: await uow.sources.deletions.managedObjects(projectId),
      retained: await uow.sources.deletions.retainedObjects(projectId),
      derived: await uow.sources.deletions.derivedOf(projectId),
    }));
    let inventory: Inventory;
    try {
      inventory = await this.#inventory(agencyId, projectId);
    } catch {
      return retryAnswer(retryAfter, "PROVIDER_INVENTORY_UNAVAILABLE");
    }
    const body: DeletionReceiptBody = {
      objects: after.objects.map((o) => ({ objectId: o.objectId, zone: o.zone, generation: o.generation ?? null, result: o.deletionResult ?? o.state })),
      residuals: residualsOf(after.objects, inventory.live),
      providerResiduals: inventory.softDeleted,
      derived: [...after.derived.audits.map((a) => ({ kind: "AUDIT", id: a.auditId as string })), ...after.derived.modelTaskIds.map((id) => ({ kind: "MODEL_TASK", id }))],
      excluded: [...EXCLUDED],
      retainedByPolicy: after.retained.map((o) => ({ objectId: o.objectId as string, zone: o.zone, basis: o.zone === "LEGAL_FINANCE" ? "LEGAL_FINANCE_RETENTION" : "SECURITY_EVIDENCE_RETENTION" })),
      retainedRevisions: [],
    };

    // 5. one receipt per attempt; only a complete one closes the deletion
    const complete = body.residuals.length === 0;
    await units.runSource(boundTo(item), async (uow) => {
      const deletions = uow.sources.deletions;
      const locked = await deletions.lock(request.deletionId);
      if (locked === null || locked.state === "COMPLETED") return;
      // lock order: deletion row, project, revisions, records, packages. The revisions are read under their lock so the receipt names exactly the
      // ones the close leaves (a retention sweep cannot move a SEALED one to EXPIRED between the receipt and the close)
      await deletions.projectState(projectId, true);
      const lockedRevisions = await deletions.lockRevisionsOfProject(projectId);
      await deletions.lockRecordsOfProject(projectId);
      const receipted: DeletionReceiptBody = { ...body, retainedRevisions: lockedRevisions.filter((r) => RETAINED_REVISION_BASIS[r.state] !== undefined).map((r) => ({ revisionId: r.revisionId as string, state: r.state, basis: RETAINED_REVISION_BASIS[r.state] as string })) };
      const receiptId = uow.ids.next() as DeletionReceiptId;
      await deletions.advance(request.deletionId, ["DELETING"], "VERIFYING");
      if (!complete) {
        await deletions.appendReceipt({ receiptId, deletionId: request.deletionId, projectId, status: "PARTIAL", body: receipted });
        await deletions.advance(request.deletionId, ["VERIFYING"], "FAILED_RETRYABLE");
        return;
      }
      await deletions.appendReceipt({ receiptId, deletionId: request.deletionId, projectId, status: "COMPLETE_FOR_MANAGED_SCOPE", body: receipted });
      await deletions.advance(request.deletionId, ["VERIFYING"], "COMPLETED");
      await this.#close(uow, item, request, projectId, body.providerResiduals.length > 0, after.objects, after.retained);
    });
    return complete ? { kind: "DONE" } : retryAnswer(retryAfter, "DELETION_RESIDUALS");
  }

  /** The jobs and audits relying on the project cancelled; the reason a cancellation is still settling, or null when nothing is. */
  async #endReliance(agencyId: AgencyId, projectId: ProjectId, item: WorkItem, units: SourceUnitOfWorkFactory): Promise<string | null> {
    const execution = this.deps.execution();
    if (execution === null) return null;
    const steps = [...(await execution.cancellations.cancelRelying(agencyId, { kind: "PROJECT", projectId }, DELETION_REASON))];
    const derived = await units.runSource(boundTo(item), (uow) => uow.sources.deletions.derivedOf(projectId));
    for (const revisionId of new Set(derived.audits.map((a) => a.revisionId))) steps.push(...(await execution.auditCancellations.cancelOfRevision(agencyId, revisionId as never, DELETION_REASON)));
    for (const grantId of new Set(derived.audits.map((a) => a.grantId))) await execution.sweepers.grantReconciliation.reconcile({ grantId: grantId as never, agencyId });
    return steps.some((s) => s.kind === "RETRY" || s.kind === "WAITING") ? "CANCELLATION_SETTLING" : null;
  }

  /**
   * The live generations under the project's prefixes that no registry row names (a worker's manifest in staging, an object a lost answer
   * left): the project's data all the same, so they are deleted by their exact generation; a failed delete leaves the generation live and
   * the inventory below reports it as a residual.
   */
  async #removeUnregistered(agencyId: AgencyId, projectId: ProjectId, item: WorkItem, units: SourceUnitOfWorkFactory, managed: ReadonlyArray<StoredObjectRecord>): Promise<void> {
    const known = new Set(managed.filter((o) => o.generation !== undefined).map((o) => `${o.objectName}#${o.generation}`));
    for (const zone of MANAGED_ZONES) {
      const location = this.deps.storage.location(zone);
      const prefix = `${zonePrefix(zone)}/${agencyId}/${projectId}/`;
      let page: string | undefined;
      for (;;) {
        let listed;
        try {
          listed = await this.deps.storage.list(location, prefix, page);
        } catch {
          return; // the inventory below fails the same way and answers RETRY
        }
        for (const o of listed.objects) {
          if (known.has(`${o.objectName}#${o.generation}`)) continue;
          try {
            await this.deps.storage.delete(location, o.objectName, o.generation);
          } catch {
            // stays live: reported as a residual by the inventory
          }
        }
        if (listed.next === undefined) break;
        page = listed.next;
      }
    }
    void item;
    void units;
  }

  /** What the provider holds under the project's prefixes: the live generations and the soft-deleted ones with their own expiry. */
  async #inventory(agencyId: AgencyId, projectId: ProjectId): Promise<Inventory> {
    const live: Array<{ objectName: string; generation: string }> = [];
    const softDeleted: Array<{ objectName: string; generation: string; expiresAt: string }> = [];
    for (const zone of MANAGED_ZONES) {
      const location = this.deps.storage.location(zone);
      const prefix = `${zonePrefix(zone)}/${agencyId}/${projectId}/`;
      let page: string | undefined;
      for (;;) {
        const listed = await this.deps.storage.list(location, prefix, page);
        for (const o of listed.objects) live.push({ objectName: o.objectName, generation: o.generation });
        if (listed.next === undefined) break;
        page = listed.next;
      }
      page = undefined;
      for (;;) {
        const listed = await this.deps.storage.listSoftDeleted(location, prefix, page);
        for (const o of listed.objects) softDeleted.push({ objectName: o.objectName, generation: o.generation, expiresAt: o.expiresAt as string });
        if (listed.next === undefined) break;
        page = listed.next;
      }
    }
    softDeleted.sort((a, b) => (a.objectName + a.generation < b.objectName + b.generation ? -1 : 1));
    return { live, softDeleted };
  }

  /** The close, in the order of the lock hierarchy: project, records, packages. Runs in the unit that completed the request. */
  async #close(uow: SourceUnitOfWork, item: WorkItem, request: DeletionRequestRow, projectId: ProjectId, withResiduals: boolean, objects: ReadonlyArray<StoredObjectRecord>, retained: ReadonlyArray<StoredObjectRecord>): Promise<void> {
    const deletions = uow.sources.deletions;
    const project = await deletions.projectState(projectId);
    if (project !== null && project.state === "DELETION_REQUESTED") {
      const deleted = await deletions.markProjectDeleted(projectId, project.version);
      if (deleted === null) throw new Error("the project changed under the deletion's close");
      await publish(uow, item, "project", projectId, deleted.version, "project.deleted.v1", { projectId, agencyId: item.agencyId, deletionId: request.deletionId });
    }
    // the revisions the registry gives a deletion edge (managed_cleanup_verified: CANCELLED and EXPIRED -> DELETED), once cleanup is verified;
    // SEALED, REJECTED and SUPERSEDED have none and stay, named in the receipt (retainedRevisions)
    for (const revision of await deletions.lockRevisionsOfProject(projectId)) {
      if (revision.state !== "CANCELLED" && revision.state !== "EXPIRED") continue;
      const write = await uow.sources.revisions.transition(revision.revisionId, revision.version, { event: "managed_cleanup_verified" });
      if (write.kind !== "APPLIED") throw new Error("a revision changed under the deletion's close");
      const own = objects.filter((o) => o.revisionId === revision.revisionId);
      await publish(uow, item, "dataset_revision", revision.revisionId, write.record.version, "dataset_revision.deleted.v1", {
        revisionId: revision.revisionId,
        agencyId: item.agencyId,
        projectId,
        deletedObjectCount: own.filter((o) => o.state === "DELETED").length,
        residualObjectCount: retained.filter((o) => o.revisionId === revision.revisionId).length,
        tombstoneHash: tombstoneHashOf(request.deletionId, revision, own),
      });
    }
    for (const record of await deletions.lockRecordsOfProject(projectId)) {
      if (record.state !== "DELETING") continue;
      const closed = await deletions.closeRecord(record.retentionId, record.version, withResiduals);
      if (closed === null) throw new Error("a retention record changed under the deletion's close");
      await publish(uow, item, "retention_record", record.retentionId, closed.version, "retention_record.deleted.v1", {
        retentionId: record.retentionId,
        agencyId: item.agencyId,
        projectId,
        deletionId: request.deletionId,
        withResiduals,
      });
    }
    for (const pkg of await deletions.lockPackagesOfProject(projectId)) {
      let current = pkg;
      if (current.state === "STAGED" || current.state === "VERIFIED_PRIVATE") {
        const revoked = await deletions.movePackage(current.packageVersionId, current.version, "REVOKED", DELETION_REASON);
        if (revoked === null) throw new Error("a package version changed under the deletion's close");
        await publish(uow, item, "package_version", current.packageVersionId, revoked.version, "package_version.revoked.v1", {
          packageVersionId: current.packageVersionId,
          agencyId: item.agencyId,
          jobId: current.jobId,
          reasonCode: DELETION_REASON,
          previousState: current.state,
          state: "REVOKED",
        });
        current = revoked;
      }
      if (current.state === "DELETED") continue;
      const gone = await deletions.movePackage(current.packageVersionId, current.version, "DELETED", DELETION_REASON);
      if (gone === null) throw new Error("a package version changed under the deletion's close");
      await publish(uow, item, "package_version", current.packageVersionId, gone.version, "package_version.deleted.v1", { packageVersionId: current.packageVersionId, agencyId: item.agencyId, jobId: current.jobId, state: "DELETED" });
    }
  }
}

/** Why a revision outlives the deletion (R2 registry/state_transitions.json DatasetRevision: no deletion edge from these states; 09 "Early deletion" does not date their deadline "now"). */
const RETAINED_REVISION_BASIS: Readonly<Record<string, string | undefined>> = {
  SEALED: "NO_DELETION_EDGE_FROM_SEALED",
  REJECTED: "NO_DELETION_EDGE_FROM_REJECTED",
  SUPERSEDED: "SUPERSEDED_OWNED_BY_RETENTION",
};

/** The evidence hash of one revision's deletion: the deletion, the revision and the exact generations deleted for it. */
function tombstoneHashOf(deletionId: string, revision: SourceRevisionRecord, own: ReadonlyArray<StoredObjectRecord>): string {
  const generations = own.map((o) => `${o.objectId}#${o.generation ?? ""}`).sort();
  return createHash("sha256").update(JSON.stringify({ deletionId, revisionId: revision.revisionId, previousState: revision.state, generations })).digest("hex");
}

/** The residuals: a registered object not DELETED (its recorded cause and who retries it), a registered generation the provider still holds live, a live generation nothing registered. */
function residualsOf(objects: ReadonlyArray<StoredObjectRecord>, live: Inventory["live"]): DeletionReceiptBody["residuals"] {
  const out: Array<DeletionReceiptBody["residuals"][number]> = [];
  const registered = new Set<string>();
  for (const o of objects) {
    if (o.generation !== undefined) registered.add(`${o.objectName}#${o.generation}`);
    if (o.state !== "DELETED") {
      out.push({ objectId: o.objectId, generation: o.generation ?? null, cause: o.deletionResult ?? "NOT_DELETED", retry: o.state === "DELETION_FAILED" ? "DELETION_RETRIES" : "DELETION_EXECUTOR" });
    } else if (o.generation !== undefined && live.some((l) => l.objectName === o.objectName && l.generation === o.generation)) {
      out.push({ objectId: o.objectId, generation: o.generation, cause: "STILL_LIVE_AT_PROVIDER", retry: "DELETION_EXECUTOR" });
    }
  }
  for (const l of live) if (!registered.has(`${l.objectName}#${l.generation}`)) out.push({ objectId: l.objectName, generation: l.generation, cause: "UNREGISTERED_AT_PROVIDER", retry: "OBJECT_INVENTORY" });
  return out;
}
