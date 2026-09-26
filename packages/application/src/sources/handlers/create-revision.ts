/**
 * CMD012 CreateRevision — POST /api/v1/projects/{projectId}/revisions — AGENCY_OPERATOR (design §11 CMD012; D-REV-1, D-REV-2,
 * D-ROLE-3, D-ANCH-2, D-LOCK-1; catalogue "Creates new mutable input identity and explicit lineage; preserves sealed predecessor
 * bytes"; failure "Do not carry old validation, approval or paid execution authority onto changed bytes").
 *
 * Order (lock order D-LOCK-1: project row → revision row → upload rows): authorize → reserve → lock the project (NOT_FOUND) →
 * its version (STALE_VERSION) → OPEN (PROJECT_NOT_OPEN) → the agency DRAFT or ACTIVE after its transition lock (AGENCY_NOT_OPEN)
 * → lock the named predecessor: a revision of this project (INVALID_REQUEST / UNKNOWN_REFERENCE) that is the project's current
 * revision (PREDECESSOR_NOT_CURRENT, naming it) →
 *   SEALED: new_revision_explicitly_supersedes with the successor, and the impact map — the plans bound to its manifest hash and
 *           their live approvals (RevisionAuthorityInspector), the live commercial authorizations (CommercialScopeInspector) —
 *           identified in dataset_revision.superseded.v1, never transferred;
 *   mutable (DRAFT, UPLOADING, INSPECTING, READY_TO_SEAL): every upload in flight tombstoned (cancel_upload, REVISION_REPLACED; the
 *           database requests the provider cancellation of an issued session in the same update, D-ROLE-3) with its
 *           INTAKE_CANCELLED anchor and its quota released by the ledger trigger, then cancel_revision naming the successor;
 *   terminal (REJECTED, EXPIRED, DELETED): unchanged — lineage only;
 * → the successor DRAFT v1 naming its predecessor (dataset_revision.created.v1) → the project's current revision moved
 * (project.current_revision_changed.v1) → journal 201 CreateRevisionView. One transaction: a crash anywhere before COMMIT leaves
 * nothing (the deferred successor keys bind the pair at COMMIT). The replacement allowance is the commercial package's (Q-B07-17).
 */
import type { Id } from "@kauro/contracts";
import type { AgencyId, MembershipId, ProjectId, RetentionAnchorId, RevisionId, UploadId, UserId } from "@kauro/domain";
import { AGENCY_OPEN_STATES, DomainFailure, REVISION_MUTABLE_STATES, UPLOAD_LIVE_STATES } from "@kauro/domain";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { CREATE_REVISION, type CreateRevisionBody, type CreateRevisionHandler, type CreateRevisionView } from "../contracts.js";
import { readRevisionView, revisionSummary } from "./projections.js";
import { runSourceCommand, versionAt, type B07Collaborators, type SourceRuntime } from "./shared.js";

/** Why a replaced revision's uploads in flight ended (the upload's terminalReason and the cancelled event's reason code). */
export const REVISION_REPLACED = "REVISION_REPLACED";
/** Why a mutable predecessor was cancelled (the revision's terminalReason and the cancelled event's reason code). */
export const REPLACED_BY_NEW_REVISION = "REPLACED_BY_NEW_REVISION";

export function createRevisionHandler(runtime: SourceRuntime, collaborators: B07Collaborators): CreateRevisionHandler {
  return {
    spec: CREATE_REVISION,
    execute: (envelope) =>
      runSourceCommand<CreateRevisionBody, CreateRevisionView>(
        CREATE_REVISION,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const agencyId = membership.agencyId;
          const projectId = envelope.path["projectId"] as ProjectId;
          const actor = { kind: "USER", userId: envelope.userId as UserId } as const;
          const provenance = { actor, causationId: ctx.causationId, correlationId: envelope.correlationId };

          const project = await uow.projects.lock(projectId);
          if (!project || project.agencyId !== agencyId) throw new DomainFailure("NOT_FOUND", "project not visible");
          checkExpectedVersion(project, envelope.body.expectedVersion);
          if (project.state !== "OPEN") {
            throw new DomainFailure("PRECONDITION_FAILED", "the project takes no new revision", { reason: "PROJECT_NOT_OPEN", currentVersion: project.version, currentState: project.state });
          }
          const agency = await uow.agencies.lockShared(agencyId);
          if (!agency) throw new DomainFailure("NOT_FOUND", "project not visible");
          if (!AGENCY_OPEN_STATES.has(agency.state)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the agency accepts no new revision", { reason: "AGENCY_NOT_OPEN", currentVersion: agency.version, currentState: agency.state });
          }
          const predecessorId = envelope.body.supersedesRevisionId as RevisionId;
          const predecessor = await uow.sources.revisions.lock(predecessorId);
          if (!predecessor || predecessor.projectId !== projectId) {
            throw new DomainFailure("INVALID_REQUEST", "supersedesRevisionId is not a revision of this project", {
              reason: "UNKNOWN_REFERENCE",
              fields: [{ field: "supersedesRevisionId", code: "UNKNOWN_REFERENCE" }],
            });
          }
          if (predecessor.revisionId !== project.currentRevisionId) {
            throw new DomainFailure("PRECONDITION_FAILED", "supersedesRevisionId is not the project's current revision", {
              reason: "PREDECESSOR_NOT_CURRENT",
              currentVersion: predecessor.version,
              currentState: predecessor.state,
              successorId: project.currentRevisionId,
            });
          }

          const successorId = uow.ids.next() as RevisionId;
          let impact: CreateRevisionView["invalidated"] = { planIds: [], approvalIds: [], commercialAuthorizationIds: [] };
          const cancelledUploadIds: UploadId[] = [];
          let after = predecessor;
          if (predecessor.state === "SEALED") {
            if (predecessor.manifestHash === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a sealed revision has no manifest hash");
            const bound = await uow.sources.authority.boundTo(predecessor.manifestHash);
            const commercial = await collaborators.commercialScope.authorizationsBoundTo(uow, agencyId as AgencyId, predecessorId);
            impact = { planIds: [...bound.planIds], approvalIds: [...bound.approvalIds], commercialAuthorizationIds: [...commercial] };
            after = applied(await uow.sources.revisions.transition(predecessorId, predecessor.version, { event: "new_revision_explicitly_supersedes", successorRevisionId: successorId }));
            await uow.events.publish({
              aggregateKind: "dataset_revision",
              aggregateId: predecessorId,
              aggregateVersion: after.version,
              agencyId,
              eventType: "dataset_revision.superseded.v1",
              ...provenance,
              payload: {
                revisionId: predecessorId,
                agencyId,
                projectId,
                successorRevisionId: successorId,
                manifestHash: predecessor.manifestHash,
                affectedPlanIds: impact.planIds,
                affectedApprovalIds: impact.approvalIds,
                affectedCommercialAuthorizationIds: impact.commercialAuthorizationIds,
              },
            });
          } else if (REVISION_MUTABLE_STATES.has(predecessor.state)) {
            // the revision row is held; its uploads in flight are tombstoned first, each after its own row lock (D-LOCK-1)
            for (const live of await uow.sources.uploads.inStates(predecessorId, [...UPLOAD_LIVE_STATES] as ReadonlyArray<"RESERVED" | "UPLOADING" | "VERIFYING">)) {
              const upload = await uow.sources.uploads.lock(live.uploadId);
              if (!upload || !UPLOAD_LIVE_STATES.has(upload.state)) continue;
              const cancelled = applied(await uow.sources.uploads.transition(upload.uploadId, upload.version, { event: "cancel_upload", byMembershipId: membership.membershipId as MembershipId, reason: REVISION_REPLACED }));
              await uow.events.publish({
                aggregateKind: "upload_session",
                aggregateId: upload.uploadId,
                aggregateVersion: cancelled.version,
                agencyId,
                eventType: "upload_session.cancelled.v1",
                ...provenance,
                payload: {
                  uploadId: upload.uploadId,
                  agencyId,
                  revisionId: predecessorId,
                  cancelledByMembershipId: membership.membershipId,
                  reasonCode: REVISION_REPLACED,
                  providerCancellationState: cancelled.providerCancellationState,
                  releasedBytes: upload.reservedBytes,
                },
              });
              await uow.sources.retention.appendAnchor({ anchorId: uow.ids.next() as RetentionAnchorId, agencyId, projectId, revisionId: predecessorId, uploadId: upload.uploadId, kind: "INTAKE_CANCELLED", sourceEvidenceHash: null });
              cancelledUploadIds.push(upload.uploadId);
            }
            after = applied(await uow.sources.revisions.transition(predecessorId, predecessor.version, { event: "cancel_revision", reason: REPLACED_BY_NEW_REVISION, successorRevisionId: successorId }));
            await uow.events.publish({
              aggregateKind: "dataset_revision",
              aggregateId: predecessorId,
              aggregateVersion: after.version,
              agencyId,
              eventType: "dataset_revision.cancelled.v1",
              ...provenance,
              payload: { revisionId: predecessorId, agencyId, projectId, previousState: predecessor.state, reasonCode: REPLACED_BY_NEW_REVISION, successorRevisionId: successorId, cancelledUploadIds },
            });
          }

          const successor = await uow.sources.revisions.insertSuccessor({ revisionId: successorId, agencyId, projectId, supersedesRevisionId: predecessorId, createdByMembershipId: membership.membershipId, createdAt: ctx.now });
          await uow.events.publish({
            aggregateKind: "dataset_revision",
            aggregateId: successorId,
            aggregateVersion: successor.version,
            agencyId,
            eventType: "dataset_revision.created.v1",
            ...provenance,
            payload: { revisionId: successorId, agencyId, projectId, state: successor.state, supersedesRevisionId: predecessorId, createdByMembershipId: membership.membershipId },
          });
          const moved = applied(await uow.sources.projects.switchCurrentRevision(projectId, project.version, successorId, ctx.now));
          await uow.events.publish({
            aggregateKind: "project",
            aggregateId: projectId,
            aggregateVersion: moved.version,
            agencyId,
            eventType: "project.current_revision_changed.v1",
            ...provenance,
            payload: { projectId, agencyId, currentRevisionId: successorId, previousRevisionId: predecessorId, changedByMembershipId: membership.membershipId },
          });

          const view: CreateRevisionView = {
            revision: await readRevisionView(uow, successor, membership.role),
            predecessor: revisionSummary(after),
            project: { projectId, version: moved.version, currentRevisionId: moved.currentRevisionId },
            invalidated: impact,
            cancelledUploadIds,
          };
          return { status: 201, view, version: successor.version, resourceKind: "dataset_revision", resourceId: successorId as Id };
        },
        versionAt("revision"),
      ),
  };
}
