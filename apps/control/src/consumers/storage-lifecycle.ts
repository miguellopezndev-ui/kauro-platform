/**
 * STORAGE_LIFECYCLE (docs/design/B07-upload-source-lifecycle.md §12.3; decisions D-ROLE-3, D-SESSION-1, D-SESSION-3, D-OBJ-1, D-OBJ-2,
 * D-PERS-4, D-CTRL-2, D-CTRL-7; R2-051, CMD015): the consumer of the ends of application acceptance and of source authority —
 * `upload_session.cancelled.v1`, `.expired.v1`, `.rejected.v1`, `dataset_revision.cancelled.v1`, `.expired.v1`.
 *
 * It acts only for a subject whose acceptance is tombstoned (07: consumers verify state before an effect; a subject in another
 * state is an integrity incident, dead-lettered):
 *
 * - the provider session: a cancellation the database requested with the tombstone (REQUESTED) or an unconfirmed one (UNCERTAIN)
 *   is carried out with the bearer reference the vault opens, and the provider's answer — CONFIRMED, UNSUPPORTED or UNCERTAIN — is
 *   recorded with upload_session.provider_cancellation_recorded.v1 (D-ROLE-3); an UNCERTAIN one is reconciled until the provider
 *   horizon by PROVIDER_SESSION_RECONCILIATION. The temporary control record is purged once the cancellation resolved; a session
 *   that was never issued, or was finalized (the provider holds its object: a rejected upload, an admitted one past its window),
 *   needs no cancellation and its record, if any, is purged (D-SESSION-1, decision D-CTRL-7);
 * - the objects: every registered generation of the upload — the quarantine object, a late object found under its name (observed as
 *   a RESIDUAL for good), a promotion copy of a lost attempt — and, for an expired revision, the accepted generations whose
 *   admission was revoked, are requested for deletion and deleted by exact generation, each result recorded at the server's
 *   instant with the provider residual the location's read-back implies (D-OBJ-2). An accepted generation whose admission still
 *   stands is never requested (D-PERS-4: the admission is revoked first — by the deadline or retention sweeper).
 */
import type { ConsumerOutcome, ObjectStoragePort, OutboxConsumer, SessionVaultPort } from "@kauro/application";
import {
  isUuidV7,
  type CausationId,
  type DomainEventRecord,
  type RevisionId,
  type SourceFileRecord,
  type SourceUnitOfWorkFactory,
  type StoredObjectRecord,
  type SystemContext,
  type UploadId,
  type UploadSessionRecord,
} from "@kauro/domain";
import { cancelProviderSession, requestAndDelete } from "../storage-work.js";
import { boundTo, lostTheSubject, type WorkItem } from "../work.js";

export interface StorageLifecycleDependencies {
  readonly storage: ObjectStoragePort;
  readonly vault: SessionVaultPort;
  readonly retryAfterSeconds?: number;
}

const UPLOAD_TOMBSTONES: ReadonlySet<string> = new Set(["CANCELLED", "EXPIRED", "REJECTED"]);
const UPLOAD_EVENTS: Readonly<Record<string, UploadSessionRecord["state"]>> = Object.freeze({
  "upload_session.cancelled.v1": "CANCELLED",
  "upload_session.expired.v1": "EXPIRED",
  "upload_session.rejected.v1": "REJECTED",
});
const REVISION_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  "dataset_revision.cancelled.v1": "CANCELLED",
  "dataset_revision.expired.v1": "EXPIRED",
});

/** The deletion reason recorded for the objects of a tombstoned upload or revision (a token). */
export const ACCEPTANCE_TOMBSTONED = "ACCEPTANCE_TOMBSTONED";

/** Whether an accepted generation is still retained by a standing admission (never requested for deletion then, D-PERS-4). */
function retained(object: StoredObjectRecord, files: ReadonlyArray<SourceFileRecord>): boolean {
  if (object.zone !== "ACCEPTED") return false;
  return files.some((f) => f.state === "ADMITTED" && (f.storageRef === object.objectId || f.fileId === object.fileId));
}

export class StorageLifecycle implements OutboxConsumer {
  readonly consumer = "STORAGE_LIFECYCLE" as const;

  constructor(private readonly deps: StorageLifecycleDependencies) {}

  async handle(event: DomainEventRecord, context: SystemContext, units: SourceUnitOfWorkFactory): Promise<ConsumerOutcome> {
    if (context.agencyId === undefined || !isUuidV7(event.aggregateId)) return { kind: "DEAD_LETTER", reason: "EVENT_WITHOUT_SUBJECT" };
    const item: WorkItem = { serviceId: context.serviceId, agencyId: context.agencyId, correlationId: context.correlationId, causationId: event.eventId as unknown as CausationId };
    try {
      const uploadState = UPLOAD_EVENTS[event.eventType];
      if (uploadState !== undefined && event.aggregateKind === "upload_session") return await this.forUpload(item, units, event.aggregateId as UploadId, uploadState);
      const revisionState = REVISION_EVENTS[event.eventType];
      if (revisionState !== undefined && event.aggregateKind === "dataset_revision") return await this.forRevision(item, units, event.aggregateId as RevisionId, revisionState);
      return { kind: "DEAD_LETTER", reason: "EVENT_NOT_ROUTED_TO_STORAGE_LIFECYCLE" };
    } catch (e) {
      if (lostTheSubject(e)) return { kind: "DONE" };
      throw e;
    }
  }

  /** The provider session and the objects of one tombstoned upload. */
  async forUpload(item: WorkItem, units: SourceUnitOfWorkFactory, uploadId: UploadId, announced: UploadSessionRecord["state"]): Promise<ConsumerOutcome> {
    const read = await units.runSource(boundTo(item), async (uow) => {
      const upload = await uow.sources.uploads.get(uploadId);
      if (upload === null) return null;
      const files = upload.fileId === undefined ? [] : [await uow.sources.files.get(upload.fileId)].filter((f): f is SourceFileRecord => f !== null);
      const objects = await uow.sources.objects.inventory({ projectId: upload.projectId, uploadId });
      return { upload, files, objects };
    });
    if (read === null) return { kind: "DEAD_LETTER", reason: "SUBJECT_NOT_VISIBLE" };
    // verify the subject before the effect: the event announces a tombstone the upload must carry (07; §6)
    if (read.upload.state !== announced || !UPLOAD_TOMBSTONES.has(read.upload.state)) return { kind: "DEAD_LETTER", reason: "SUBJECT_NOT_TOMBSTONED" };
    const cancellation = await this.#settleSession(item, units, read.upload);
    const deletable = read.objects.filter((o) => !retained(o, read.files));
    await requestAndDelete(this.deps.storage, units, item, deletable, ACCEPTANCE_TOMBSTONED);
    if (cancellation === "FAILED") return { kind: "RETRY", afterSeconds: this.deps.retryAfterSeconds ?? 60, reason: "PROVIDER_CANCELLATION_FAILED" };
    return { kind: "DONE" };
  }

  /** The objects of a cancelled or expired revision: its tombstoned uploads' objects and the accepted bytes whose admission ended. */
  async forRevision(item: WorkItem, units: SourceUnitOfWorkFactory, revisionId: RevisionId, announced: string): Promise<ConsumerOutcome> {
    const read = await units.runSource(boundTo(item), async (uow) => {
      const revision = await uow.sources.revisions.get(revisionId);
      if (revision === null) return null;
      const own = await uow.sources.files.listForRevision(revisionId);
      const sealed = await uow.sources.seals.get(revisionId);
      const files = [...own];
      for (const f of sealed?.manifest.files ?? []) {
        if (files.some((x) => x.fileId === f.fileId)) continue;
        const file = await uow.sources.files.get(f.fileId);
        if (file !== null) files.push(file);
      }
      const objects = [...(await uow.sources.objects.inventory({ projectId: revision.projectId, revisionId }))];
      for (const file of files) {
        if (objects.some((o) => o.objectId === file.storageRef)) continue;
        const accepted = await uow.sources.objects.get(file.storageRef);
        if (accepted !== null) objects.push(accepted);
      }
      const uploads = await uow.sources.uploads.inStates(revisionId, ["CANCELLED", "EXPIRED", "REJECTED"]);
      return { revision, files, objects, tombstoned: new Set(uploads.map((u) => u.uploadId)) };
    });
    if (read === null) return { kind: "DEAD_LETTER", reason: "SUBJECT_NOT_VISIBLE" };
    if (read.revision.state !== announced) return { kind: "DEAD_LETTER", reason: "SUBJECT_NOT_TOMBSTONED" };
    const deletable = read.objects.filter((o) => {
      if (retained(o, read.files)) return false;
      if (o.zone === "ACCEPTED") return true;
      // a quarantine object of a live upload is its upload's (the upload's own tombstone cleans it)
      return o.uploadId === undefined || read.tombstoned.has(o.uploadId) || o.state === "DELETION_REQUESTED" || o.state === "DELETION_FAILED";
    });
    await requestAndDelete(this.deps.storage, units, item, deletable, ACCEPTANCE_TOMBSTONED);
    return { kind: "DONE" };
  }

  /**
   * The provider session of a tombstoned upload: carried out and recorded when the database requested it (or it is UNCERTAIN); a
   * session never issued or already finalized has nothing to cancel and its record is purged.
   */
  async #settleSession(item: WorkItem, units: SourceUnitOfWorkFactory, upload: UploadSessionRecord): Promise<"DONE" | "FAILED"> {
    if (upload.providerCancellationState === "REQUESTED" || upload.providerCancellationState === "UNCERTAIN") {
      const outcome = await cancelProviderSession(this.deps.storage, this.deps.vault, units, item, upload.uploadId);
      return outcome.kind === "FAILED" ? "FAILED" : "DONE";
    }
    if (upload.providerCancellationState === "NOT_REQUESTED") {
      await units.runSource(boundTo(item), (uow) => uow.sources.sessionSecrets.purge(upload.uploadId));
    }
    return "DONE";
  }
}
