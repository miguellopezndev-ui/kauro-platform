/**
 * CMD014 CompleteUpload — POST /api/v1/uploads/{uploadId}/complete — AGENCY_OPERATOR (design §11 CMD014; D-RUN-1, D-SAPI-3,
 * D-SAPI-5, D-SRC-2, D-LOCK-1, D-CLOCK-1; catalogue "Observes provider generation/length/hash, scan coverage and structure before
 * admission; completion remains asynchronous"; failure "Declared size/hash or browser completion alone cannot mark the file ready").
 *
 * The request records the browser's claim and schedules verification; the provider observation, the digest, the inspection and the
 * scan are the control plane's (UPLOAD_INSPECTION, §12.1). Order: authorize → reserve → the upload's revision row, then the upload
 * (NOT_FOUND; D-LOCK-1, so a completion and a cancellation of one upload serialize on the revision row) → requested by the caller
 * (NOT_AUTHORIZED / UPLOAD_NOT_OWNED, a recorded denial) → its state: RESERVED → SESSION_NOT_ISSUED; CANCELLED → UPLOAD_CANCELLED;
 * EXPIRED, or UPLOADING at or after its deadline on the server clock → RESERVATION_EXPIRED; REJECTED → UPLOAD_TERMINAL; ADMITTED →
 * UPLOAD_ADMITTED → the reference parsed into a claim by the storage port (pure; MALFORMED → COMPLETION_REF_MALFORMED) and digested →
 * VERIFYING under the same claim: the same 202 without effect, under another claim: COMPLETION_CLAIM_CONFLICT (D-SAPI-5) → UPLOADING →
 * VERIFYING with the claim (upload_session.completion_reported.v1 → UPLOAD_INSPECTION) → journal 202 ACCEPTED (operationId = the
 * upload, state VERIFYING, statusPath /api/v1/uploads/{uploadId}, pollAfterSeconds 5). A replay answers the journaled 202.
 */
import type { Id } from "@kauro/contracts";
import type { UploadId, UserId } from "@kauro/domain";
import { COMPLETION_POLL_AFTER_SECONDS, DomainFailure, textDigest } from "@kauro/domain";
import { requireMembership } from "../../commands/handlers/shared.js";
import type { AcceptedOutcome } from "../../commands/runtime.js";
import { COMPLETE_UPLOAD, type CompleteUploadBody, type CompleteUploadHandler } from "../contracts.js";
import { reachedOnServer, requireProviders, runSourceCommand, type B07Collaborators, type SourceRuntime } from "./shared.js";

/** The status path of an upload's verification: GetUpload (design §9.1). */
export function uploadStatusPath(uploadId: string): string {
  return `/api/v1/uploads/${uploadId}`;
}

export function completeUploadHandler(runtime: SourceRuntime, collaborators: B07Collaborators): CompleteUploadHandler {
  return {
    spec: COMPLETE_UPLOAD,
    execute: (envelope) =>
      runSourceCommand<CompleteUploadBody, never>(
        COMPLETE_UPLOAD,
        runtime,
        envelope,
        async (uow, ctx): Promise<AcceptedOutcome> => {
          const membership = requireMembership(ctx);
          const storage = requireProviders(collaborators).storage;
          const uploadId = envelope.path["uploadId"] as UploadId;
          const found = await uow.sources.uploads.get(uploadId);
          if (!found || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "upload not visible");
          // the revision row first, then the upload (D-LOCK-1): a cancellation or an inspection outcome of this revision is ordered
          await uow.sources.revisions.lock(found.revisionId);
          const upload = await uow.sources.uploads.lock(uploadId);
          if (!upload) throw new DomainFailure("NOT_FOUND", "upload not visible");
          if (upload.requestedByUserId !== (envelope.userId as UserId)) throw new DomainFailure("NOT_AUTHORIZED", "the upload belongs to another requester", { reason: "UPLOAD_NOT_OWNED" });
          const current = { currentVersion: upload.version, currentState: upload.state };
          const serverNow = await uow.serverInstant();
          switch (upload.state) {
            case "RESERVED":
              throw new DomainFailure("PRECONDITION_FAILED", "no provider session was issued for the upload yet", { reason: "SESSION_NOT_ISSUED", ...current });
            case "CANCELLED":
              throw new DomainFailure("PRECONDITION_FAILED", "the upload was cancelled", { reason: "UPLOAD_CANCELLED", ...current });
            case "EXPIRED":
              throw new DomainFailure("PRECONDITION_FAILED", "the application deadline passed", { reason: "RESERVATION_EXPIRED", ...current });
            case "REJECTED":
              throw new DomainFailure("PRECONDITION_FAILED", "inspection rejected the upload", { reason: "UPLOAD_TERMINAL", ...current });
            case "ADMITTED":
              throw new DomainFailure("PRECONDITION_FAILED", "the upload was already admitted", { reason: "UPLOAD_ADMITTED", ...current });
            case "UPLOADING":
              // nothing is accepted at or after the deadline on the server clock (D-CLOCK-1; the database refuses it too, KA072)
              if (reachedOnServer(upload.applicationExpiresAt, serverNow)) {
                throw new DomainFailure("PRECONDITION_FAILED", "the application deadline passed", { reason: "RESERVATION_EXPIRED", ...current });
              }
              break;
            case "VERIFYING":
              break;
          }
          const parsed = storage.parseCompletionClaim(envelope.body.providerCompletionRef);
          if (parsed.kind === "MALFORMED") {
            throw new DomainFailure("INVALID_REQUEST", "the reference is not a completion of this provider", { reason: "COMPLETION_REF_MALFORMED", fields: [{ field: "providerCompletionRef", code: "FORMAT" }] });
          }
          const claimDigest = textDigest(envelope.body.providerCompletionRef);
          const accepted: AcceptedOutcome = {
            status: 202,
            accepted: { operationId: uploadId, state: "VERIFYING", statusPath: uploadStatusPath(uploadId), pollAfterSeconds: COMPLETION_POLL_AFTER_SECONDS },
            resourceKind: "upload_session",
            resourceId: uploadId as Id,
          };
          if (upload.state === "VERIFYING") {
            // D-SAPI-5: idempotent by upload and claim — the same claim answers the same 202 and changes nothing
            if (upload.completionClaimDigest === claimDigest) return accepted;
            throw new DomainFailure("PRECONDITION_FAILED", "the upload is being verified under another completion claim", { reason: "COMPLETION_CLAIM_CONFLICT", ...current });
          }
          // the upload row is locked by this unit of work: its version cannot move under the write (CMD014 carries no expectedVersion)
          const write = await uow.sources.uploads.transition(uploadId, upload.version, { event: "completion_reported", claimDigest, claim: parsed.claim });
          if (write.kind === "STALE") throw new DomainFailure("INTEGRITY_FAILURE", "the locked upload changed under its lock");
          const reported = write.record;
          await uow.events.publish({
            aggregateKind: "upload_session",
            aggregateId: uploadId,
            aggregateVersion: reported.version,
            agencyId: reported.agencyId,
            eventType: "upload_session.completion_reported.v1",
            actor: { kind: "USER", userId: envelope.userId },
            causationId: ctx.causationId,
            correlationId: envelope.correlationId,
            payload: { uploadId, agencyId: reported.agencyId, revisionId: reported.revisionId, completionClaimDigest: claimDigest, reportedByMembershipId: membership.membershipId },
          });
          return accepted;
        },
        () => {
          throw new DomainFailure("INTEGRITY_FAILURE", "CompleteUpload journals an ACCEPTED answer, never a COMPLETED view");
        },
      ),
  };
}
