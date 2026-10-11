/**
 * CMD040 SubmitStageReceipt — POST /api/v1/projects/{projectId}/import-stages/{stageId}/receipts — AGENCY_OPERATOR (registry command
 * CMD040, gate G-VENDOR; "Validate exact membership and source-to-target IDs, including failed and missing records"; failure "Foreign
 * IDs, duplicate mappings or partial unresolved parents block affected child edges").
 *
 * Order: authorize → reserve → the stage (NOT_FOUND; a foreign stage, another project's stage and a nonexistent one answer alike) and its
 * row lock (FOR UPDATE: the one serialization point between two receipts, or a receipt and a continuation) → the stage judged on the
 * locked record and the database clock:
 *
 *   - EXPIRED, or past its bounded deadline: 409 STAGE_EXPIRED (no receipt is admitted after it; recovery is explicit);
 *   - any state but AWAITING_AGENCY_IMPORT and NEEDS_CORRECTION: 409 STAGE_NOT_AWAITING_RECEIPT naming where the stage stands, so the
 *     loser of a race is told what became of the stage;
 *   - the receipt upload (UNKNOWN_REFERENCE unless it is a STAGE_RECEIPT artifact of this stage's project), its instance
 *     (RECEIPT_INSTANCE_MISMATCH), the package named (RECEIPT_PACKAGE_MISMATCH), its closed shape (RECEIPT_INVALID) and bytes not
 *     submitted before (RECEIPT_ALREADY_SUBMITTED: a correction is new evidence, never a silent overwrite);
 *   - the exact membership: a source identity the stage does not contain refuses the receipt (RECEIPT_FOREIGN_IDS, nothing recorded);
 *     within it every identity is MATCHED, FAILED or UNRESOLVED (missing, duplicated, or mapped to a target identity another source
 *     claims) - an ambiguous identity is never guessed;
 *   - otherwise the next receipt revision is appended and the stage advances on its version: a complete receipt to VERIFIED_SUCCESS, a
 *     fully accounted partition with explicit failures to RECEIPT_VALIDATING (it awaits the approver's partial scope, CMD041), anything
 *     unresolved to NEEDS_CORRECTION → journal 200 with the stage.
 */
import { digestEquals } from "@kauro/contracts";
import type { ArtifactRef, ImportStageState } from "@kauro/domain";
import { DomainFailure, applyReceiptOutcome, parseStageReceipt, stageIdentityMappingDigest, validateStageReceipt } from "@kauro/domain";
import { applied, requireMembership } from "../../commands/handlers/shared.js";
import { SUBMIT_STAGE_RECEIPT, type SubmitStageReceiptBody, type SubmitStageReceiptHandler } from "../contracts.js";
import type { ImportStageView } from "../views.js";
import { importStageView } from "./projections.js";
import { runAuditCommand, versionAt, type AuditRuntime } from "./shared.js";

export function submitStageReceiptHandler(runtime: AuditRuntime): SubmitStageReceiptHandler {
  return {
    spec: SUBMIT_STAGE_RECEIPT,
    execute: (envelope) =>
      runAuditCommand<SubmitStageReceiptBody, ImportStageView>(
        SUBMIT_STAGE_RECEIPT,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const projectId = envelope.path["projectId"];
          const stageId = envelope.path["stageId"] as string;

          const found = await uow.importStages.get(stageId);
          if (!found || found.agencyId !== membership.agencyId || found.projectId !== projectId) throw new DomainFailure("NOT_FOUND", "import stage not visible");
          const stage = await uow.importStages.lock(stageId);
          if (!stage) throw new DomainFailure("NOT_FOUND", "import stage not visible");

          const awaiting = stage.state === "AWAITING_AGENCY_IMPORT" || stage.state === "NEEDS_CORRECTION";
          const nowMs = Date.parse(await uow.serverInstant());
          if (stage.state === "EXPIRED" || (awaiting && Date.parse(stage.expiresAt) <= nowMs)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the stage workflow expired", { reason: "STAGE_EXPIRED" });
          }
          if (!awaiting) {
            throw new DomainFailure("PRECONDITION_FAILED", "the stage is not awaiting a receipt", { reason: "STAGE_NOT_AWAITING_RECEIPT", currentVersion: stage.version, currentState: stage.state });
          }

          const upload = await uow.targetContracts.getArtifact(envelope.body.receiptUploadRef as ArtifactRef);
          if (!upload || upload.agencyId !== membership.agencyId || upload.kind !== "STAGE_RECEIPT" || upload.projectId !== stage.projectId) {
            throw new DomainFailure("INVALID_REQUEST", "the receipt upload is not visible", { reason: "UNKNOWN_REFERENCE", fields: [{ field: "receiptUploadRef", code: "UNKNOWN_REFERENCE" }] });
          }
          if (upload.instanceId !== stage.instanceId) throw new DomainFailure("PRECONDITION_FAILED", "the receipt is of another target instance", { reason: "RECEIPT_INSTANCE_MISMATCH" });
          if (!digestEquals(envelope.body.sourcePackageHash, stage.packageHash)) throw new DomainFailure("PRECONDITION_FAILED", "the receipt names another package than the stage's", { reason: "RECEIPT_PACKAGE_MISMATCH" });
          const parsed = parseStageReceipt(upload.document);
          if (parsed === null) throw new DomainFailure("INVALID_REQUEST", "the receipt is not the closed mapping shape", { reason: "RECEIPT_INVALID" });
          if (await uow.importStages.hasReceiptFile(stage.stageId, upload.contentHash)) {
            throw new DomainFailure("PRECONDITION_FAILED", "these receipt bytes were already submitted for the stage", { reason: "RECEIPT_ALREADY_SUBMITTED" });
          }

          const validation = validateStageReceipt(stage.sourceIds, parsed);
          if (validation.kind === "FOREIGN_IDS") throw new DomainFailure("PRECONDITION_FAILED", "the receipt names identities that are not members of the stage", { reason: "RECEIPT_FOREIGN_IDS" });

          const receipt = await uow.importStages.appendReceipt({
            receiptId: uow.ids.next(),
            agencyId: membership.agencyId,
            projectId: stage.projectId,
            stageId: stage.stageId,
            instanceId: stage.instanceId,
            sourcePackageHash: stage.packageHash,
            receiptUploadRef: upload.artifactRef,
            receiptFileHash: upload.contentHash,
            identityMappingHash: stageIdentityMappingDigest({ stageId: stage.stageId, instanceId: stage.instanceId, sourcePackageHash: stage.packageHash, mapping: validation.mapping }),
            matchedRows: validation.matchedRows,
            failedRows: validation.failedRows,
            unresolvedRows: validation.unresolvedRows,
            result: validation.result,
            mapping: validation.mapping,
            submittedByMembershipId: membership.membershipId,
          });
          const to: ImportStageState = applyReceiptOutcome(validation.result);
          const advanced = applied(await uow.importStages.advance(stage.stageId, stage.version, to));
          return {
            status: 200 as const,
            view: importStageView(advanced, receipt, membership.role),
            version: advanced.version,
            resourceKind: "import_stage",
            resourceId: advanced.stageId,
          };
        },
        versionAt(),
      ),
  };
}
