/**
 * CMD060 RequestRetentionExtension — POST /api/v1/projects/{projectId}/retention-extensions — AGENCY_OWNER_OR_ADMIN (B16 lane L2;
 * docs/design/B16-L2-failure-matrix.md; R2-123, R2-124; decision C1: the granted end is least(soft + requested, hard), the hard
 * deadline never moves, at most one extension per project, only PAID_ORDINARY and PAID_STAGED records are extendable).
 *
 * Order: authorize (the membership's shared transition lock) → journal reserve → the project, read without a row lock (another
 * agency's, or none, is NOT_FOUND) → the terms version the agency accepted (TERMS_VERSION_MISMATCH) → the project's shared transition lock, then the project's paid records FOR NO KEY UPDATE (none:
 * NO_EXTENDABLE_RECORD; none ACTIVE: RETENTION_EXPIRED, judged on the re-read after the lock) → the one extension already used
 * (EXTENSION_ALREADY_USED) → the version (STALE_VERSION) → no soft deadline (NO_SOFT_DEADLINE) → kauro.effect_now()
 * read in a statement after the last lock (rules 15/16): the soft deadline passed (SOFT_DEADLINE_PASSED), the hard cap already reached
 * (NO_EXTENSION_ROOM, not consumed) → the extension row and the record's soft and effective deadlines in one write sequence →
 * retention_record.extended.v1 (→ AUTHORITY_JOURNAL) → journal 200 RetentionExtensionView.
 */
import type { Id } from "@kauro/contracts";
import type { ProjectId, RetentionExtensionId, RetentionRecordRow } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { RetentionExtensionView } from "../../api/views.js";
import { REQUEST_RETENTION_EXTENSION, type RequestRetentionExtensionBody, type RequestRetentionExtensionHandler } from "../../commands/contracts.js";
import { checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { reachedOnServer, runSourceCommand, utc, type SourceRuntime } from "./shared.js";

/** The record's current safe version and state, carried by every refusal that is about the record itself (the catalogue's `current`). */
function currentOf(record: RetentionRecordRow): { readonly currentVersion: number; readonly currentState: string } {
  return { currentVersion: record.version, currentState: record.state };
}

/** The retention package's commands (B16): CMD060, served beside B07's six. */
export interface RetentionHandlers {
  readonly CMD060: RequestRetentionExtensionHandler;
}

export function requestRetentionExtensionHandler(runtime: SourceRuntime): RequestRetentionExtensionHandler {
  return {
    spec: REQUEST_RETENTION_EXTENSION,
    execute: (envelope) =>
      runSourceCommand<RequestRetentionExtensionBody, RetentionExtensionView>(
        REQUEST_RETENTION_EXTENSION,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const projectId = envelope.path["projectId"] as ProjectId;
          const project = await uow.projects.get(projectId);
          if (!project || project.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "project not visible");
          const agency = await uow.agencies.get(membership.agencyId);
          if (!agency) throw new DomainFailure("NOT_FOUND", "agency not visible");
          if (envelope.body.termsVersion !== agency.termsVersion) {
            throw new DomainFailure("PRECONDITION_FAILED", "termsVersion is not the terms version the agency accepted", { reason: "TERMS_VERSION_MISMATCH" });
          }
          const retention = uow.sources.retention;
          const records = await retention.lockPaidRecordsOfProject(projectId);
          if (records.length === 0) {
            throw new DomainFailure("PRECONDITION_FAILED", "the project has no paid retention record to extend", { reason: "NO_EXTENDABLE_RECORD" });
          }
          const record = records.find((r) => r.state === "ACTIVE");
          if (!record) {
            throw new DomainFailure("PRECONDITION_FAILED", "the retention record is no longer active; an expired scope is never extended", { reason: "RETENTION_EXPIRED", ...currentOf(records[0] as RetentionRecordRow) });
          }
          if ((await retention.extensionOfProject(projectId)) !== null) {
            throw new DomainFailure("PRECONDITION_FAILED", "the project already used its one extension", { reason: "EXTENSION_ALREADY_USED", ...currentOf(record) });
          }
          checkExpectedVersion(record, envelope.body.expectedVersion);
          if (record.softDeadline === undefined) {
            throw new DomainFailure("PRECONDITION_FAILED", "no package has been made available yet, so there is no soft deadline", { reason: "NO_SOFT_DEADLINE", ...currentOf(record) });
          }
          const now = await retention.effectInstant();
          if (reachedOnServer(record.softDeadline, now)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the soft deadline has passed", { reason: "SOFT_DEADLINE_PASSED", ...currentOf(record) });
          }
          if (reachedOnServer(record.hardDeadline, record.softDeadline)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the soft deadline is already at the hard cap", { reason: "NO_EXTENSION_ROOM", ...currentOf(record) });
          }
          const extensionId = uow.ids.next() as RetentionExtensionId;
          const { extension, record: moved } = await retention.extendSoftDeadline({
            extensionId,
            retentionId: record.retentionId,
            expectedVersion: record.version,
            requestedSeconds: envelope.body.requestedSeconds,
            purpose: envelope.body.purpose,
            termsVersion: envelope.body.termsVersion,
            membershipId: membership.membershipId,
          });
          await uow.events.publish({
            aggregateKind: "retention_record",
            aggregateId: moved.retentionId,
            aggregateVersion: moved.version,
            agencyId: moved.agencyId,
            eventType: "retention_record.extended.v1",
            actor: { kind: "USER", userId: envelope.userId },
            causationId: ctx.causationId,
            correlationId: envelope.correlationId,
            payload: {
              retentionId: moved.retentionId,
              agencyId: moved.agencyId,
              projectId: moved.projectId,
              ...(moved.revisionId === undefined ? {} : { revisionId: moved.revisionId }),
              extensionId,
              retentionClass: moved.class,
              requestedSeconds: extension.requestedSeconds,
              grantedSeconds: extension.grantedSeconds,
              cappedAtHardDeadline: extension.cappedAtHardDeadline,
            },
          });
          const view: RetentionExtensionView = {
            extensionId: extension.extensionId,
            projectId: extension.projectId,
            retentionId: extension.retentionId,
            retentionVersion: moved.version,
            requestedSeconds: extension.requestedSeconds,
            grantedSeconds: extension.grantedSeconds,
            previousSoftDeadline: utc(extension.previousSoftDeadline),
            softDeadline: utc(extension.softDeadline),
            hardDeadline: utc(extension.hardDeadline),
            effectiveDeadline: utc(moved.effectiveDeadline),
            cappedAtHardDeadline: extension.cappedAtHardDeadline,
          };
          return { status: 200, view, version: moved.version, resourceKind: "retention_record", resourceId: moved.retentionId as Id };
        },
        (view) => (view as RetentionExtensionView).retentionVersion,
      ),
  };
}
