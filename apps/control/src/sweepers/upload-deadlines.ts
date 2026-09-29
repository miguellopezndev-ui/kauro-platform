/**
 * UPLOAD_DEADLINES (docs/design/B07-upload-source-lifecycle.md §12.5; decisions D-UP-1, D-RET-1, D-CLOCK-1, D-EXP-1, D-ROLE-3,
 * D-INTAKE-1; 09 "Upload reservation": reservation expiry is twenty-four hours from initiation, polling never extends it; R2-051).
 *
 * On the server clock, never early (the database refuses an expiry before the deadline, D-EXP-1):
 * - a live upload (RESERVED, UPLOADING, VERIFYING) past its application deadline → EXPIRED (reservation_expired) with its
 *   INTAKE_EXPIRED anchor; when a provider session was issued the expiry requests its cancellation (REQUESTED, D-ROLE-3), which
 *   STORAGE_LIFECYCLE carries out and records;
 * - an admitted upload past its deadline whose file no real seal ever included (D-RET-1: unsealed intake data follows its upload's
 *   window) → EXPIRED (intake_deadline_reached) and its file's admission revoked INTAKE_EXPIRED (the database refuses the revocation
 *   of a sealed file and of a window still open).
 * The revision is left as it is (D-INTAKE-1: only the agency's selection closes an intake).
 */
import type { SourceSweeper } from "@kauro/application";
import type { RetentionAnchorId, SourceUnitOfWorkFactory } from "@kauro/domain";
import { applied, boundTo, isAfter, publish } from "../work.js";
import { SweepRun, type SweepResult, type SweeperDependencies } from "./sweep.js";

/** The terminal reasons the deadline edges record (tokens). */
export const RESERVATION_EXPIRED = "RESERVATION_EXPIRED";
export const INTAKE_EXPIRED = "INTAKE_EXPIRED";

export class UploadDeadlines implements SourceSweeper {
  readonly name = "UPLOAD_DEADLINES" as const;

  constructor(private readonly deps: SweeperDependencies) {}

  async sweep(units: SourceUnitOfWorkFactory, limit: number): Promise<SweepResult> {
    const run = new SweepRun("upload-deadlines", this.deps.ids);
    const due = await units.runSource(run.discovery, (uow) => uow.sources.uploads.findDeadlinePassed(limit));
    let acted = 0;
    for (const found of due) {
      const item = run.itemFor(found.agencyId);
      const expired = await run.attempt(found.uploadId, () =>
        units.runSource(boundTo(item), async (uow) => {
          if ((await uow.sources.revisions.lock(found.revisionId)) === null) return false;
          const upload = await uow.sources.uploads.lock(found.uploadId);
          if (upload === null) return false;
          const now = await uow.serverInstant();
          if (isAfter(upload.applicationExpiresAt, now)) return false;
          if (upload.state === "RESERVED" || upload.state === "UPLOADING" || upload.state === "VERIFYING") {
            const record = applied(
              await uow.sources.uploads.transition(upload.uploadId, upload.version, { event: "reservation_expired", reason: RESERVATION_EXPIRED, providerCancellation: upload.sessionIssuedAt === undefined ? "NOT_REQUESTED" : "REQUESTED" }),
              "reservation_expired",
            );
            await publish(uow, item, "upload_session", upload.uploadId, record.version, "upload_session.expired.v1", {
              uploadId: upload.uploadId,
              agencyId: item.agencyId,
              revisionId: upload.revisionId,
              previousState: upload.state,
              reasonCode: RESERVATION_EXPIRED,
              releasedBytes: upload.reservedBytes,
              providerCancellationState: record.providerCancellationState,
            });
          } else if (upload.state === "ADMITTED" && upload.fileId !== undefined) {
            // a file some real seal included follows that seal's retention, not the intake window (D-RET-1, D-SEAL-1)
            if ((await uow.sources.files.sealedBy(upload.fileId)).length > 0) return false;
            const record = applied(await uow.sources.uploads.transition(upload.uploadId, upload.version, { event: "intake_deadline_reached", reason: INTAKE_EXPIRED }), "intake_deadline_reached");
            await publish(uow, item, "upload_session", upload.uploadId, record.version, "upload_session.expired.v1", {
              uploadId: upload.uploadId,
              agencyId: item.agencyId,
              revisionId: upload.revisionId,
              previousState: "ADMITTED",
              reasonCode: INTAKE_EXPIRED,
              releasedBytes: upload.observedBytes ?? 0,
              providerCancellationState: record.providerCancellationState,
              fileId: upload.fileId,
            });
            const file = await uow.sources.files.get(upload.fileId);
            if (file !== null && file.state === "ADMITTED") {
              const selectedBy = await uow.sources.files.selectedBy(file.fileId);
              const revoked = applied(await uow.sources.files.revokeAdmission(file.fileId, file.version, "INTAKE_EXPIRED"), "admission revocation");
              await publish(uow, item, "source_file", file.fileId, revoked.version, "source_file.admission_revoked.v1", {
                fileId: file.fileId,
                agencyId: item.agencyId,
                projectId: file.projectId,
                revocationReason: "INTAKE_EXPIRED",
                selectedByRevisionIds: [...selectedBy],
                sealedByRevisionIds: [],
              });
            }
          } else return false;
          await uow.sources.retention.appendAnchor({ anchorId: uow.ids.next() as RetentionAnchorId, agencyId: item.agencyId, projectId: upload.projectId, revisionId: upload.revisionId, uploadId: upload.uploadId, kind: "INTAKE_EXPIRED", sourceEvidenceHash: null });
          return true;
        }),
      );
      if (expired) acted += 1;
    }
    return { examined: due.length, acted, failed: run.failures };
  }
}
