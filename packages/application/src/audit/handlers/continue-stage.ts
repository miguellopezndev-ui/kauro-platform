/**
 * CMD041 ContinueStage — POST /api/v1/projects/{projectId}/import-stages/{stageId}/continue — AGENCY_APPROVER (registry command CMD041,
 * gate G-VENDOR; "Prepare the next stage from verified identities without reimporting parents"; failure "Expired workflow or mismatched
 * target requires explicit recovery, not guessed IDs").
 *
 * Order: authorize (an approving role of an ACTIVE membership: the stored authority) → reserve → the stage (NOT_FOUND; a foreign stage,
 * another project's stage and a nonexistent one answer alike) and its row lock (FOR NO KEY UPDATE) → the stage judged on the locked record
 * (continued, version), then the reads and locks of section 4 (receipt; parents FOR SHARE ascending; their open reconciliations; the plan
 * row; its approval's shared half; the plan's target after its shared half, the last await) → the effect clock → the judgments:
 *
 *   - already continued: 409 STAGE_ALREADY_CONTINUED naming where it stands, answered before the version is compared, so the loser of a
 *     race is told what became of the stage, not that it is stale;
 *   - a version other than the one read: 409 STALE_VERSION;
 *   - past its bounded deadline on the database clock: 409 STAGE_EXPIRED (explicit recovery, never a guessed continuation);
 *   - a state other than VERIFIED_SUCCESS and RECEIPT_VALIDATING (a fully accounted partial receipt awaiting this approval):
 *     409 STAGE_NOT_CONTINUABLE;
 *   - the latest receipt's identity mapping digest recomputed from the stored mapping (RECEIPT_DIGEST_MISMATCH when it is not the stored
 *     digest) and the caller's validatedReceiptHash compared with it in constant time: a digest that is not the stage's current validated
 *     receipt is 409 STALE_VERSION (mismatch validatedReceiptHash), never a continuation of unseen identities;
 *   - every parent stage verified and inside its deadline (PARENT_STAGE_NOT_VERIFIED), no parent under an open receipt reconciliation
 *     (PARENT_IDENTITY_UNDER_RECONCILIATION), the stage's plan APPROVED (CHILD_PLAN_NOT_APPROVED), the plan's target contract confirmed and
 *     current (TARGET_STALE, R2-026) and the stage's target instance its instance (STAGE_TARGET_MISMATCH);
 *   - otherwise the continuation is recorded once with the approver's membership and the receipt digest, the database stamping the instant;
 *     a partial receipt's stage moves RECEIPT_VALIDATING to VERIFIED_PARTIAL (approved_partial_scope_accounted) → journal 200 with the stage.
 */
import { digestEquals } from "@kauro/contracts";
import type { ImportStageState, PlanId } from "@kauro/domain";
import { DomainFailure, StaleVersionFailure, effectNowOf, stageIdentityMappingDigest } from "@kauro/domain";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { CONTINUE_STAGE, type ContinueStageBody, type ContinueStageHandler } from "../contracts.js";
import type { ImportStageView } from "../views.js";
import { importStageView } from "./projections.js";
import { parentsVerified } from "./submit-stage-receipt.js";
import { runAuditCommand, versionAt, type AuditRuntime } from "./shared.js";

export function continueStageHandler(runtime: AuditRuntime): ContinueStageHandler {
  return {
    spec: CONTINUE_STAGE,
    execute: (envelope) =>
      runAuditCommand<ContinueStageBody, ImportStageView>(
        CONTINUE_STAGE,
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

          if (stage.continuedAt !== undefined) {
            throw new DomainFailure("PRECONDITION_FAILED", "the stage was already continued", { reason: "STAGE_ALREADY_CONTINUED", currentVersion: stage.version, currentState: stage.state });
          }
          checkExpectedVersion(stage, envelope.body.expectedVersion);

          // the reads and locks, in the order of section 4 (CST): the receipt, the parents FOR SHARE ascending with their latest receipts and
          // open reconciliations, the plan row (the lock CMD026 takes), its approval's shared transition half, then the plan's target
          // contract after its shared transition half (the last await)
          const receipt = await uow.importStages.latestReceipt(stage.stageId);
          const parents = await uow.importStages.lockParents(stage.parentStageIds);
          const reconciling = await uow.importStages.stagesUnderReconciliation(stage.parentStageIds);
          const plan = await uow.plans.lock(stage.planId as PlanId);
          if (plan?.approvalId !== undefined) await uow.execution.awaitTransition({ kind: "APPROVAL", key: plan.approvalId });
          const target = plan ? await uow.targetContracts.lockCurrentByHash(membership.agencyId, stage.projectId, plan.targetContractHash) : null;
          // r15/r25: the clock is read after the last await, and nothing is awaited between the judgments and the effect
          const nowMs = Date.parse(await effectNowOf(uow));

          if (stage.state === "EXPIRED" || Date.parse(stage.expiresAt) <= nowMs) {
            throw new DomainFailure("PRECONDITION_FAILED", "the stage workflow expired", { reason: "STAGE_EXPIRED" });
          }
          if (stage.state !== "VERIFIED_SUCCESS" && stage.state !== "RECEIPT_VALIDATING") {
            throw new DomainFailure("PRECONDITION_FAILED", "the stage is not verified", { reason: "STAGE_NOT_CONTINUABLE", currentVersion: stage.version, currentState: stage.state });
          }

          // the digest of the stored mapping, recomputed: a stored digest that is not it is an integrity failure, a caller digest that is not it is stale
          if (receipt === null) throw new StaleVersionFailure(stage.version, stage.state, { mismatch: ["validatedReceiptHash"] });
          const recomputed = stageIdentityMappingDigest({ stageId: stage.stageId, instanceId: receipt.instanceId, sourcePackageHash: receipt.sourcePackageHash, mapping: receipt.mapping });
          if (!digestEquals(recomputed, receipt.identityMappingHash)) throw new DomainFailure("INTEGRITY_FAILURE", "the stored receipt mapping is not the mapping its digest names", { reason: "RECEIPT_DIGEST_MISMATCH" });
          if (!digestEquals(envelope.body.validatedReceiptHash, recomputed)) throw new StaleVersionFailure(stage.version, stage.state, { mismatch: ["validatedReceiptHash"] });

          // the parents the stage depends on (verified, inside their deadline, their identities settled), the plan it belongs to and its target
          if (!parentsVerified(stage, parents, nowMs)) throw new DomainFailure("PRECONDITION_FAILED", "a required parent stage is not verified", { reason: "PARENT_STAGE_NOT_VERIFIED" });
          if (reconciling.length > 0) throw new DomainFailure("PRECONDITION_FAILED", "a parent stage's identity is under reconciliation", { reason: "PARENT_IDENTITY_UNDER_RECONCILIATION" });
          if (!plan || plan.agencyId !== membership.agencyId || plan.projectId !== stage.projectId || plan.state !== "APPROVED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the stage plan is not approved", { reason: "CHILD_PLAN_NOT_APPROVED" });
          }
          if (target === null || target.confirmedAt === undefined || target.supersededAt !== undefined) throw new DomainFailure("TARGET_STALE", "the plan's target contract is not confirmed and current");
          if (target.instanceId !== stage.instanceId) throw new DomainFailure("PRECONDITION_FAILED", "the stage target is not the plan's current target", { reason: "STAGE_TARGET_MISMATCH" });

          const to: ImportStageState = stage.state === "RECEIPT_VALIDATING" ? "VERIFIED_PARTIAL" : "VERIFIED_SUCCESS";
          const continued = applied(await uow.importStages.recordContinuation(stage.stageId, envelope.body.expectedVersion, to, { membershipId: membership.membershipId, receiptHash: receipt.identityMappingHash }));
          return {
            status: 200 as const,
            view: importStageView(continued, receipt, membership.role),
            version: continued.version,
            resourceKind: "import_stage",
            resourceId: continued.stageId,
          };
        },
        versionAt(),
      ),
  };
}
