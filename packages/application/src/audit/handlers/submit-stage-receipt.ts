/**
 * CMD040 SubmitStageReceipt — POST /api/v1/projects/{projectId}/import-stages/{stageId}/receipts — AGENCY_OPERATOR (registry command
 * CMD040, gate G-VENDOR; "Validate exact membership and source-to-target IDs, including failed and missing records"; failure "Foreign
 * IDs, duplicate mappings or partial unresolved parents block affected child edges").
 *
 * Order (B17 L1, docs/design/B15-B17-B18-local-plan.md sections 4 and 5 M1; r15/r25: the last await, then the clock, then the judgment, then
 * the effect): authorize → reserve → the stage (NOT_FOUND; a foreign stage, another project's stage and a nonexistent one answer alike) →
 * its row lock (FOR NO KEY UPDATE: the one serialization point between two receipts, or a receipt and a continuation) → the receipt upload →
 * the parent stages FOR SHARE in ascending stage_id → the latest receipt of the stage and of each parent → what the stage already holds for
 * these exact bytes (`receiptStatus`, the last await) → the database's effect clock → the judgments, on the locked record and that instant:
 *
 *   - EXPIRED, or awaiting past its bounded deadline: 409 STAGE_EXPIRED (no receipt is admitted after it; recovery is explicit);
 *   - a CANCELLED stage: 409 STAGE_NOT_AWAITING_RECEIPT naming where it stands;
 *   - the receipt upload (UNKNOWN_REFERENCE unless it is a STAGE_RECEIPT artifact of this stage's project), its instance
 *     (RECEIPT_INSTANCE_MISMATCH), the package named (RECEIPT_PACKAGE_MISMATCH), its closed shape (RECEIPT_INVALID);
 *   - a row whose correlation key is not this stage's for its source identity: 409 RECEIPT_FOREIGN_STAGE (R2-024, nothing recorded);
 *   - a source identity the stage does not contain: 409 RECEIPT_FOREIGN_IDS (nothing recorded);
 *   - bytes the stage already holds, as a receipt revision or as a reconciliation: 200 with the stage and that reconciliation, nothing
 *     written (R2-025 "idempotent by stage and content hash", under any key);
 *   - any other stage that is neither awaiting a receipt nor finalized: 409 STAGE_NOT_AWAITING_RECEIPT naming where it stands;
 *   - a finalized stage (VERIFIED_SUCCESS, VERIFIED_PARTIAL) and differing bytes: one reconciliation is opened and the stage's identity is
 *     never overwritten (R2-025 "a reconciliation request, not an overwrite") → 200 with the stage and the reconciliation;
 *   - an awaiting stage: every parent verified and inside its deadline (PARENT_STAGE_NOT_VERIFIED); a child source whose parent identity is
 *     not MATCHED is BLOCKED_BY_PARENT, and a receipt claiming MATCHED for it is refused (CHILD_EDGE_BLOCKED, R2-023); within the exact
 *     membership every identity is MATCHED, FAILED, BLOCKED_BY_PARENT or UNRESOLVED (never guessed); the next receipt revision is
 *     appended and the stage advances on its version: complete to VERIFIED_SUCCESS, a fully accounted partition with failures to
 *     RECEIPT_VALIDATING (it awaits the approver's partial scope, CMD041), anything unresolved to NEEDS_CORRECTION → journal 200.
 */
import { digestEquals } from "@kauro/contracts";
import type { ArtifactRef, ImportStageRecord, ImportStageState, ReceiptMappingRow, StageReceiptStatus } from "@kauro/domain";
import {
  DomainFailure,
  applyReceiptOutcome,
  blockedChildSources,
  effectNowOf,
  parseStageReceipt,
  receiptOfAnotherStage,
  stageIdentityMappingDigest,
  validateStageReceipt,
} from "@kauro/domain";
import { applied, requireMembership } from "../../commands/handlers/shared.js";
import { SUBMIT_STAGE_RECEIPT, type SubmitStageReceiptBody, type SubmitStageReceiptHandler } from "../contracts.js";
import type { ImportStageView } from "../views.js";
import { importStageView } from "./projections.js";
import { runAuditCommand, versionAt, type AuditRuntime } from "./shared.js";

const AWAITING: ReadonlyArray<ImportStageState> = ["AWAITING_AGENCY_IMPORT", "NEEDS_CORRECTION"];
const FINALIZED: ReadonlyArray<ImportStageState> = ["VERIFIED_SUCCESS", "VERIFIED_PARTIAL"];
const NOTHING_HELD: StageReceiptStatus = { receipt: null, reconciliation: null };

/** Every parent the stage names exists in its project, is verified and is inside its bounded deadline at `nowMs`. */
export function parentsVerified(stage: ImportStageRecord, parents: ReadonlyArray<ImportStageRecord>, nowMs: number): boolean {
  return (
    parents.length === new Set(stage.parentStageIds).size &&
    parents.every((p) => p.projectId === stage.projectId && FINALIZED.includes(p.state) && Date.parse(p.expiresAt) > nowMs)
  );
}

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
          const upload = await uow.targetContracts.getArtifact(envelope.body.receiptUploadRef as ArtifactRef);
          const parents = await uow.importStages.lockParents(stage.parentStageIds);
          const receipts = await uow.importStages.latestReceipts([stage.stageId, ...stage.parentStageIds]);
          const held = upload === null ? NOTHING_HELD : await uow.importStages.receiptStatus(stage.stageId, upload.contentHash);
          // r15/r25: the clock is read after the last await, and nothing is awaited between the judgments and the effect
          const nowMs = Date.parse(await effectNowOf(uow));

          const awaiting = AWAITING.includes(stage.state);
          const finalized = FINALIZED.includes(stage.state);
          if (stage.state === "EXPIRED" || (awaiting && Date.parse(stage.expiresAt) <= nowMs)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the stage workflow expired", { reason: "STAGE_EXPIRED" });
          }
          if (stage.state === "CANCELLED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the stage is not awaiting a receipt", { reason: "STAGE_NOT_AWAITING_RECEIPT", currentVersion: stage.version, currentState: stage.state });
          }
          if (!upload || upload.agencyId !== membership.agencyId || upload.kind !== "STAGE_RECEIPT" || upload.projectId !== stage.projectId) {
            throw new DomainFailure("INVALID_REQUEST", "the receipt upload is not visible", { reason: "UNKNOWN_REFERENCE", fields: [{ field: "receiptUploadRef", code: "UNKNOWN_REFERENCE" }] });
          }
          if (upload.instanceId !== stage.instanceId) throw new DomainFailure("PRECONDITION_FAILED", "the receipt is of another target instance", { reason: "RECEIPT_INSTANCE_MISMATCH" });
          if (!digestEquals(envelope.body.sourcePackageHash, stage.packageHash)) throw new DomainFailure("PRECONDITION_FAILED", "the receipt names another package than the stage's", { reason: "RECEIPT_PACKAGE_MISMATCH" });
          const parsed = parseStageReceipt(upload.document);
          if (parsed === null) throw new DomainFailure("INVALID_REQUEST", "the receipt is not the closed mapping shape", { reason: "RECEIPT_INVALID" });
          if (receiptOfAnotherStage(stage, parsed)) throw new DomainFailure("PRECONDITION_FAILED", "the receipt was produced for another stage", { reason: "RECEIPT_FOREIGN_STAGE" });
          if (validateStageReceipt(stage.sourceIds, parsed).kind === "FOREIGN_IDS") {
            throw new DomainFailure("PRECONDITION_FAILED", "the receipt names identities that are not members of the stage", { reason: "RECEIPT_FOREIGN_IDS" });
          }

          const latest = receipts.get(stage.stageId) ?? null;
          const answer = (record: ImportStageRecord) => ({ status: 200 as const, version: record.version, resourceKind: "import_stage", resourceId: record.stageId });
          // identical content is idempotent on any key: the stage as it stands (with the reconciliation these bytes opened), nothing written
          if (held.receipt !== null || held.reconciliation !== null) return { ...answer(stage), view: importStageView(stage, latest, membership.role, held.reconciliation) };
          if (!awaiting && !finalized) {
            throw new DomainFailure("PRECONDITION_FAILED", "the stage is not awaiting a receipt", { reason: "STAGE_NOT_AWAITING_RECEIPT", currentVersion: stage.version, currentState: stage.state });
          }

          if (!finalized && !parentsVerified(stage, parents, nowMs)) throw new DomainFailure("PRECONDITION_FAILED", "a required parent stage is not verified", { reason: "PARENT_STAGE_NOT_VERIFIED" });
          const parentMappings = new Map<string, ReadonlyArray<ReceiptMappingRow>>(stage.parentStageIds.map((id) => [id, receipts.get(id)?.mapping ?? []]));
          const validation = validateStageReceipt(stage.sourceIds, parsed, blockedChildSources(stage.parentEdges, parentMappings));
          if (!finalized && validation.kind === "CHILD_EDGE_BLOCKED") throw new DomainFailure("PRECONDITION_FAILED", "the receipt claims a child whose parent identity is not matched", { reason: "CHILD_EDGE_BLOCKED" });
          if (!finalized && validation.kind !== "VALIDATED") throw new DomainFailure("PRECONDITION_FAILED", "the receipt names identities that are not members of the stage", { reason: "RECEIPT_FOREIGN_IDS" });

          // the effect: a differing receipt for a finalized stage opens one reconciliation request (never an overwrite of the identity it
          // verified); an awaiting stage appends the next revision and advances on its version
          const written = await (finalized || validation.kind !== "VALIDATED"
            ? uow.importStages.openReconciliation({
                reconciliationId: uow.ids.next(),
                agencyId: membership.agencyId,
                projectId: stage.projectId,
                stageId: stage.stageId,
                contentHash: upload.contentHash,
                receiptUploadRef: upload.artifactRef,
                openedByMembershipId: membership.membershipId,
              })
            : uow.importStages.appendReceipt({
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
              }));
          if ("reconciliationId" in written) return { ...answer(stage), view: importStageView(stage, latest, membership.role, written) };
          const advanced = applied(await uow.importStages.advance(stage.stageId, stage.version, applyReceiptOutcome(written.result)));
          return { ...answer(advanced), view: importStageView(advanced, written, membership.role) };
        },
        versionAt(),
      ),
  };
}
