/**
 * RETENTION (docs/design/B07-upload-source-lifecycle.md §12.5; decisions D-RET-1..3, D-EXP-1, D-PERS-3, D-SEAL-1, D-CLOCK-1, D-CTRL-8,
 * D-HOLD-3; 09 "Retention schedule": unpaid sources no later than fourteen days from sealing; HASHING "Retention formulas": nothing
 * resets a hard clock; registry RetentionRecord: "a record expires no earlier than its effective deadline").
 *
 * Four steps, each decided by the database clock and never early (the database refuses an early one, D-EXP-1):
 * 1. ACTIVE records past their effective deadline → EXPIRED (effective_deadline_reached; retention_record.expired.v1);
 * 2. sealed files whose including revisions hold no ACTIVE record ahead → admission revoked RETENTION_EXPIRED (D-RET-3: a SUPERSEDED
 *    revision, which never expires itself, does not keep the bytes admitted and reusable), with the deletion of the accepted
 *    generation requested and carried out (the admission no longer retains it, D-PERS-4);
 * 3. SEALED revisions with no ACTIVE record ahead, and REJECTED revisions whose every intake window closed → EXPIRED
 *    (retention_expires; dataset_revision.expired.v1 → STORAGE_LIFECYCLE, EXECUTION_CONTROL, AUTHORITY_JOURNAL). A REJECTED revision
 *    keeps its rejection's reason: a revision's terminal facts are set once (D-PERS-3, re-check residual FINAL-N2).
 * 4. the seal holds (B07-R1; decisions D-HOLD-1..D-HOLD-3): a hold still INTENDED past its attempt bound — a seal that crashed between
 *    its provider hold and its commit — is abandoned (CLOSED, ABANDONED), and every object whose holds nothing needs any more (no
 *    attempt in flight, no seal retaining it: its file's admission ended) is released at the provider and the answer recorded; a
 *    release requested longer than the bound ago and never recorded is driven again. A sealed file's own hold is released in step 2,
 *    by the deletion of its accepted generation (the provider refuses to delete a held generation), when its retention ends.
 * Records first, then files, then revisions, then holds, so an expired revision's accepted bytes are already released when its event
 * is handled, and a hold is released in the run that ended what needed it.
 */
import type { ObjectStoragePort, SourceSweeper } from "@kauro/application";
import type { RetentionRecordRow, SourceUnitOfWorkFactory } from "@kauro/domain";
import { executeDeletion, releaseObjectHolds } from "../storage-work.js";
import { applied, boundTo, isAfter, publish } from "../work.js";
import { SweepRun, type SweepResult, type SweeperDependencies } from "./sweep.js";

/** The reason an expiry records for a revision without one (SEALED → EXPIRED); a REJECTED revision keeps its own (D-PERS-3). */
export const RETENTION_DEADLINE = "RETENTION_DEADLINE";
/** The deletion reason of an accepted generation whose retention ended. */
export const RETENTION_ENDED = "RETENTION_ENDED";

export interface RetentionDependencies extends SweeperDependencies {
  readonly storage: ObjectStoragePort;
}

export interface RetentionSweepResult extends SweepResult {
  readonly recordsExpired: number;
  readonly filesRevoked: number;
  readonly revisionsExpired: number;
  /** Seal holds abandoned past their attempt bound (a crash between the hold and the commit). */
  readonly holdsAbandoned: number;
  /** Objects whose seal holds were released at the provider and recorded. */
  readonly holdsReleased: number;
}

export class RetentionSweeper implements SourceSweeper {
  readonly name = "RETENTION" as const;

  constructor(private readonly deps: RetentionDependencies) {}

  async sweep(units: SourceUnitOfWorkFactory, limit: number): Promise<RetentionSweepResult> {
    const run = new SweepRun("retention", this.deps.ids);
    let examined = 0;

    // 1. records past their effective deadline
    const records = await units.runSource(run.discovery, (uow) => uow.sources.retention.findDue(limit));
    examined += records.length;
    let recordsExpired = 0;
    for (const found of records) {
      const item = run.itemFor(found.agencyId);
      const done = await run.attempt(found.retentionId, () =>
        units.runSource(boundTo(item), async (uow) => {
          const revisionId = found.revisionId;
          if (revisionId === undefined) return false;
          if ((await uow.sources.revisions.lock(revisionId)) === null) return false;
          const record: RetentionRecordRow | undefined = (await uow.sources.retention.recordsFor(revisionId)).find((r) => r.retentionId === found.retentionId);
          if (record === undefined || record.state !== "ACTIVE" || isAfter(record.effectiveDeadline, await uow.serverInstant())) return false;
          const expired = applied(await uow.sources.retention.expireRecord(record.retentionId, record.version), "retention record expiry");
          await publish(uow, item, "retention_record", record.retentionId, expired.version, "retention_record.expired.v1", {
            retentionId: record.retentionId,
            agencyId: item.agencyId,
            projectId: record.projectId,
            revisionId,
            retentionClass: record.class,
          });
          return true;
        }),
      );
      if (done) recordsExpired += 1;
    }

    // 2. sealed files whose retention ended (their accepted generation is released with the revocation)
    const files = await units.runSource(run.discovery, (uow) => uow.sources.files.findRetentionEnded(limit));
    examined += files.length;
    let filesRevoked = 0;
    for (const found of files) {
      const item = run.itemFor(found.agencyId);
      const revoked = await run.attempt(found.fileId, () =>
        units.runSource(boundTo(item), async (uow) => {
          if ((await uow.sources.revisions.lock(found.originRevisionId)) === null) return null;
          const file = await uow.sources.files.get(found.fileId);
          if (file === null || file.state !== "ADMITTED") return null;
          const selectedBy = await uow.sources.files.selectedBy(file.fileId);
          const sealedBy = await uow.sources.files.sealedBy(file.fileId);
          const record = applied(await uow.sources.files.revokeAdmission(file.fileId, file.version, "RETENTION_EXPIRED"), "admission revocation");
          await publish(uow, item, "source_file", file.fileId, record.version, "source_file.admission_revoked.v1", {
            fileId: file.fileId,
            agencyId: item.agencyId,
            projectId: file.projectId,
            revocationReason: "RETENTION_EXPIRED",
            selectedByRevisionIds: [...selectedBy],
            sealedByRevisionIds: [...sealedBy],
          });
          const accepted = await uow.sources.objects.get(file.storageRef);
          if (accepted !== null && accepted.state !== "DELETED" && accepted.state !== "DELETION_REQUESTED" && accepted.state !== "DELETION_FAILED") {
            await uow.sources.objects.requestDeletion([accepted.objectId], RETENTION_ENDED, await uow.serverInstant());
          }
          return file.storageRef;
        }).then(async (objectId) => {
          if (objectId === null) return false;
          await executeDeletion(this.deps.storage, units, item, objectId);
          return true;
        }),
      );
      if (revoked) filesRevoked += 1;
    }

    // 3. revisions whose governing retention ended (SEALED) or whose intake windows all closed (REJECTED)
    const revisions = await units.runSource(run.discovery, (uow) => uow.sources.revisions.findRetentionDue(limit));
    examined += revisions.length;
    let revisionsExpired = 0;
    for (const found of revisions) {
      const item = run.itemFor(found.agencyId);
      const done = await run.attempt(found.revisionId, () =>
        units.runSource(boundTo(item), async (uow) => {
          const revision = await uow.sources.revisions.lock(found.revisionId);
          if (revision === null || (revision.state !== "SEALED" && revision.state !== "REJECTED")) return false;
          const records = await uow.sources.retention.recordsFor(found.revisionId);
          const now = await uow.serverInstant();
          if (records.some((r) => r.state === "ACTIVE" && isAfter(r.effectiveDeadline, now))) return false;
          const expired = applied(await uow.sources.revisions.transition(found.revisionId, revision.version, { event: "retention_expires", reason: RETENTION_DEADLINE }), "retention_expires");
          const governing = records.filter((r) => r.state !== "ACTIVE").sort((a, b) => (isAfter(a.effectiveDeadline, b.effectiveDeadline) ? -1 : 1))[0];
          await publish(uow, item, "dataset_revision", found.revisionId, expired.version, "dataset_revision.expired.v1", {
            revisionId: found.revisionId,
            agencyId: item.agencyId,
            projectId: revision.projectId,
            previousState: revision.state,
            reasonCode: expired.terminalReason ?? RETENTION_DEADLINE,
            ...(governing === undefined ? {} : { retentionId: governing.retentionId }),
          });
          return true;
        }),
      );
      if (done) revisionsExpired += 1;
    }
    // 4. seal holds: an attempt that never ended is abandoned past its bound; what nothing needs any more is released (D-HOLD-3)
    const abandoned = await units.runSource(run.discovery, (uow) => uow.sources.holds.findAbandoned(limit));
    examined += abandoned.length;
    let holdsAbandoned = 0;
    for (const found of abandoned) {
      const item = run.itemFor(found.agencyId);
      if (await run.attempt(found.holdId, () => units.runSource(boundTo(item), (uow) => uow.sources.holds.abandon(found.holdId)))) holdsAbandoned += 1;
    }
    const releasable = await units.runSource(run.discovery, (uow) => uow.sources.holds.findReleasable(limit));
    examined += releasable.length;
    let holdsReleased = 0;
    for (const found of releasable) {
      const item = run.itemFor(found.agencyId);
      const released = await run.attempt(found.objectId, async () => {
        const outcome = await releaseObjectHolds(this.deps.storage, units, item, found.objectId);
        if (outcome.kind === "PENDING") throw Object.assign(new Error("the provider release of a seal hold did not complete"), { name: "HoldReleasePending", code: outcome.cause });
        return outcome.kind === "RELEASED";
      });
      if (released) holdsReleased += 1;
    }
    return {
      examined,
      acted: recordsExpired + filesRevoked + revisionsExpired + holdsAbandoned + holdsReleased,
      failed: run.failures,
      recordsExpired,
      filesRevoked,
      revisionsExpired,
      holdsAbandoned,
      holdsReleased,
    };
  }
}
