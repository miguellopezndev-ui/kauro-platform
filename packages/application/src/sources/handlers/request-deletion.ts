/**
 * CMD042 RequestDeletion — POST /api/v1/projects/{projectId}/deletion-requests — AGENCY_OWNER_OR_ADMIN with a fresh step-up (B16 lane L3;
 * docs/design/B16-L3-failure-matrix.md; 09 Early deletion, Deletion receipts). The REQUEST half only: it tombstones the project's authority
 * and queues the work; the DELETION_EXECUTOR (apps/control) deletes objects, inventories the provider and writes the receipt.
 *
 * Order: authorize (the step-up proof judged here and again at the COMMIT by the database, KC020) → journal reserve → the project, read
 * without a row lock (another agency's, or none, is NOT_FOUND) → already DELETION_REQUESTED or DELETED (PROJECT_DELETION_REQUESTED) →
 * the version (STALE_VERSION) → the project DELETION_REQUESTED at the next version (its exclusive transition lock first) → the one
 * deletion request → project.deletion_requested.v1 (→ DELETION_EXECUTOR, AUTHORITY_JOURNAL) → the project's retention records
 * FOR NO KEY UPDATE, each ACTIVE or EXPIRED one DELETING with retention_record.deleting.v1 → journal 200 DeletionRequestView.
 * Lock order: project → deletion row → revisions → records (the executor takes deletion row → project → revisions → records → packages).
 */
import type { Id } from "@kauro/contracts";
import type { DeletionId, MembershipId, ProjectId, RevisionId } from "@kauro/domain";
import { DomainFailure, REVISION_MUTABLE_STATES, StaleVersionFailure, UPLOAD_LIVE_STATES } from "@kauro/domain";
import type { DeletionRequestView } from "../../api/views.js";
import { REQUEST_DELETION, type RequestDeletionBody, type RequestDeletionHandler } from "../../commands/contracts.js";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { runSourceCommand, utc, type SourceRuntime } from "./shared.js";

/** The reason of the uploads a project's deletion cancels (the cancelled event's reasonCode). */
export const PROJECT_DELETION_REQUESTED_UPLOAD = "PROJECT_DELETION_REQUESTED";

const refused = (state: string, version: number): DomainFailure =>
  new DomainFailure("PRECONDITION_FAILED", "the project's deletion was already requested", { reason: "PROJECT_DELETION_REQUESTED", currentVersion: version, currentState: state });

export function requestDeletionHandler(runtime: SourceRuntime): RequestDeletionHandler {
  return {
    spec: REQUEST_DELETION,
    execute: (envelope) =>
      runSourceCommand<RequestDeletionBody, DeletionRequestView>(
        REQUEST_DELETION,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const projectId = envelope.path["projectId"] as ProjectId;
          const project = await uow.projects.get(projectId);
          if (!project || project.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "project not visible");
          if (project.state === "DELETION_REQUESTED" || project.state === "DELETED") throw refused(project.state, project.version);
          checkExpectedVersion(project, envelope.body.expectedVersion);
          const now = await uow.serverInstant();
          const write = await uow.projects.transition(projectId, project.version, { state: "DELETION_REQUESTED" }, utc(now));
          if (write.kind === "STALE") {
            if (write.currentState === "DELETION_REQUESTED" || write.currentState === "DELETED") throw refused(write.currentState, write.currentVersion);
            throw new StaleVersionFailure(write.currentVersion, write.currentState);
          }
          const moved = write.record;
          const deletions = uow.sources.deletions;
          const deletionId = uow.ids.next() as DeletionId;
          const request = await deletions.insertRequest({
            deletionId,
            projectId,
            reasonCode: envelope.body.reasonCode,
            membershipId: membership.membershipId,
            assuranceProofRef: envelope.body.assuranceProofRef,
          });
          await uow.events.publish({
            aggregateKind: "project",
            aggregateId: projectId,
            aggregateVersion: moved.version,
            agencyId: moved.agencyId,
            eventType: "project.deletion_requested.v1",
            actor: { kind: "USER", userId: envelope.userId },
            causationId: ctx.causationId,
            correlationId: envelope.correlationId,
            payload: { projectId, agencyId: moved.agencyId, deletionId, reasonCode: request.reasonCode },
          });
          // lock order: project, deletion row, revisions, records (the retention sweeper takes a revision, then its records)
          // the uploads in flight end with the project: each cancelled after its revision's and its own row lock (D-LOCK-1), so the provider
          // session is cancelled by STORAGE_LIFECYCLE (the tombstone's consumer) and no byte arrives for a deleting project
          const scope = await deletions.scopeOf(projectId);
          for (const revisionId of scope.revisionIds) {
            const revision = await uow.sources.revisions.lock(revisionId as RevisionId);
            if (!revision) throw new DomainFailure("INTEGRITY_FAILURE", "a revision of the project vanished under the deletion");
            const live = await uow.sources.uploads.inStates(revisionId as RevisionId, [...UPLOAD_LIVE_STATES] as ReadonlyArray<"RESERVED" | "UPLOADING" | "VERIFYING">);
            const cancelledUploadIds: string[] = [];
            for (const found of live) {
              const upload = await uow.sources.uploads.lock(found.uploadId);
              if (!upload || !UPLOAD_LIVE_STATES.has(upload.state)) continue;
              const cancelled = applied(await uow.sources.uploads.transition(upload.uploadId, upload.version, { event: "cancel_upload", byMembershipId: membership.membershipId as MembershipId, reason: PROJECT_DELETION_REQUESTED_UPLOAD }));
              await uow.events.publish({
                aggregateKind: "upload_session",
                aggregateId: upload.uploadId,
                aggregateVersion: cancelled.version,
                agencyId: moved.agencyId,
                eventType: "upload_session.cancelled.v1",
                actor: { kind: "USER", userId: envelope.userId },
                causationId: ctx.causationId,
                correlationId: envelope.correlationId,
                payload: {
                  uploadId: upload.uploadId,
                  agencyId: moved.agencyId,
                  revisionId,
                  cancelledByMembershipId: membership.membershipId,
                  reasonCode: PROJECT_DELETION_REQUESTED_UPLOAD,
                  providerCancellationState: cancelled.providerCancellationState,
                  releasedBytes: upload.reservedBytes,
                },
              });
              cancelledUploadIds.push(upload.uploadId);
            }
            // a mutable revision (DRAFT, UPLOADING, INSPECTING, READY_TO_SEAL) takes the registry edge cancel_revision in this same transaction, so
            // a project is never half deleted. SEALED and REJECTED have no deletion edge and R2 does not date their deadline "now": they stay
            // (their reads and execution end through the project's DELETION_REQUESTED fact) and the receipt names them a residual.
            if (REVISION_MUTABLE_STATES.has(revision.state)) {
              const cancelled = applied(await uow.sources.revisions.transition(revision.revisionId, revision.version, { event: "cancel_revision", reason: PROJECT_DELETION_REQUESTED_UPLOAD }));
              await uow.events.publish({
                aggregateKind: "dataset_revision",
                aggregateId: revision.revisionId,
                aggregateVersion: cancelled.version,
                agencyId: moved.agencyId,
                eventType: "dataset_revision.cancelled.v1",
                actor: { kind: "USER", userId: envelope.userId },
                causationId: ctx.causationId,
                correlationId: envelope.correlationId,
                payload: { revisionId: revision.revisionId, agencyId: moved.agencyId, projectId, previousState: revision.state, reasonCode: PROJECT_DELETION_REQUESTED_UPLOAD, cancelledUploadIds },
              });
            }
          }
          for (const record of await deletions.lockRecordsOfProject(projectId)) {
            if (record.state !== "ACTIVE" && record.state !== "EXPIRED") continue;
            const deleting = await deletions.moveRecordToDeleting(record.retentionId, record.version);
            if (!deleting) throw new DomainFailure("INTEGRITY_FAILURE", "a locked retention record changed under its lock");
            await uow.events.publish({
              aggregateKind: "retention_record",
              aggregateId: deleting.retentionId,
              aggregateVersion: deleting.version,
              agencyId: moved.agencyId,
              eventType: "retention_record.deleting.v1",
              actor: { kind: "USER", userId: envelope.userId },
              causationId: ctx.causationId,
              correlationId: envelope.correlationId,
              payload: { retentionId: deleting.retentionId, agencyId: moved.agencyId, projectId, deletionId },
            });
          }
          const view: DeletionRequestView = {
            deletionId,
            projectId,
            state: "REQUESTED",
            reasonCode: request.reasonCode,
            requestedAt: utc(request.requestedAt),
            projectState: "DELETION_REQUESTED",
            projectVersion: moved.version,
            scope,
            receiptScope: "COMPLETE_FOR_MANAGED_SCOPE",
            excludedFromManagedScope: ["CUSTOMER_DOWNLOADED_COPIES", "EXTERNAL_CRM_IMPORTS"],
          };
          return { status: 200, view, version: moved.version, resourceKind: "project", resourceId: projectId as Id };
        },
        (view) => (view as DeletionRequestView).projectVersion,
      ),
  };
}
