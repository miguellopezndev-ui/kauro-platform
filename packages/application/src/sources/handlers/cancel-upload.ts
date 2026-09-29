/**
 * CMD015 CancelUpload — POST /api/v1/uploads/{uploadId}/cancel — AGENCY_OPERATOR (design §11 CMD015; D-ROLE-3, D-SRC-2, D-UP-2,
 * D-ANCH-2, D-INTAKE-1, D-LOCK-1; catalogue "Tombstone application acceptance, cancel provider session where supported and clean
 * late objects"; failure "Late finalization cannot resurrect the cancelled file or consume freed quota twice").
 *
 * Order: authorize → reserve → the upload's revision row, then the upload (NOT_FOUND; D-LOCK-1: a cancellation and an inspection
 * outcome of one revision serialize on the revision row, D-LOCK-2) → requested by the caller (NOT_AUTHORIZED / UPLOAD_NOT_OWNED)
 * → its version (STALE_VERSION) → RESERVED, UPLOADING or VERIFYING (ADMITTED → UPLOAD_ADMITTED: its file leaves by an exclusion
 * or a new revision; a tombstone → UPLOAD_TERMINAL) → CANCELLED (cancel_upload, CANCELLED_BY_REQUESTER). The handler writes no
 * provider-cancellation column: the database requests the provider cancellation in the same update when a session was issued
 * (D-ROLE-3), and STORAGE_LIFECYCLE cancels it and records the provider's answer. The ledger trigger releases the reserved bytes,
 * the file and the slot exactly once (D-UP-2); the INTAKE_CANCELLED anchor; upload_session.cancelled.v1 (→ STORAGE_LIFECYCLE,
 * AUTHORITY_JOURNAL) → journal 200 CancelUploadView (releasedBytes). The revision stays UPLOADING: when this was its last open
 * upload, the agency closes the intake with its selection (D-INTAKE-1).
 */
import type { Id } from "@kauro/contracts";
import type { MembershipId, RetentionAnchorId, UploadId, UserId } from "@kauro/domain";
import { DomainFailure, UPLOAD_TOMBSTONE_STATES } from "@kauro/domain";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { CANCEL_UPLOAD, type CancelUploadBody, type CancelUploadHandler, type CancelUploadView } from "../contracts.js";
import { revisionSummary, uploadView } from "./projections.js";
import { runSourceCommand, versionAt, type SourceRuntime } from "./shared.js";

/** Why the requester's own cancellation ended the upload (the upload's terminalReason and the event's reason code). */
export const CANCELLED_BY_REQUESTER = "CANCELLED_BY_REQUESTER";

export function cancelUploadHandler(runtime: SourceRuntime): CancelUploadHandler {
  return {
    spec: CANCEL_UPLOAD,
    execute: (envelope) =>
      runSourceCommand<CancelUploadBody, CancelUploadView>(
        CANCEL_UPLOAD,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const uploadId = envelope.path["uploadId"] as UploadId;
          const found = await uow.sources.uploads.get(uploadId);
          if (!found || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "upload not visible");
          const revision = await uow.sources.revisions.lock(found.revisionId);
          const upload = await uow.sources.uploads.lock(uploadId);
          if (!revision || !upload) throw new DomainFailure("NOT_FOUND", "upload not visible");
          if (upload.requestedByUserId !== (envelope.userId as UserId)) throw new DomainFailure("NOT_AUTHORIZED", "the upload belongs to another requester", { reason: "UPLOAD_NOT_OWNED" });
          checkExpectedVersion(upload, envelope.body.expectedVersion);
          if (upload.state === "ADMITTED") {
            throw new DomainFailure("PRECONDITION_FAILED", "an admitted upload leaves by an exclusion or a new revision", { reason: "UPLOAD_ADMITTED", currentVersion: upload.version, currentState: upload.state });
          }
          if (UPLOAD_TOMBSTONE_STATES.has(upload.state)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the upload's acceptance is already tombstoned", { reason: "UPLOAD_TERMINAL", currentVersion: upload.version, currentState: upload.state });
          }
          const cancelled = applied(await uow.sources.uploads.transition(uploadId, upload.version, { event: "cancel_upload", byMembershipId: membership.membershipId as MembershipId, reason: CANCELLED_BY_REQUESTER }));
          await uow.events.publish({
            aggregateKind: "upload_session",
            aggregateId: uploadId,
            aggregateVersion: cancelled.version,
            agencyId: cancelled.agencyId,
            eventType: "upload_session.cancelled.v1",
            actor: { kind: "USER", userId: envelope.userId },
            causationId: ctx.causationId,
            correlationId: envelope.correlationId,
            payload: {
              uploadId,
              agencyId: cancelled.agencyId,
              revisionId: cancelled.revisionId,
              cancelledByMembershipId: membership.membershipId,
              reasonCode: CANCELLED_BY_REQUESTER,
              providerCancellationState: cancelled.providerCancellationState,
              releasedBytes: upload.reservedBytes,
            },
          });
          await uow.sources.retention.appendAnchor({ anchorId: uow.ids.next() as RetentionAnchorId, agencyId: cancelled.agencyId, projectId: cancelled.projectId, revisionId: cancelled.revisionId, uploadId, kind: "INTAKE_CANCELLED", sourceEvidenceHash: null });
          const view: CancelUploadView = { upload: uploadView(cancelled, membership), revision: revisionSummary(revision), releasedBytes: upload.reservedBytes };
          return { status: 200, view, version: cancelled.version, resourceKind: "upload_session", resourceId: uploadId as Id };
        },
        versionAt("upload"),
      ),
  };
}
