/**
 * CMD023 RevisePlan — POST /api/v1/plans/{planId}/revisions — AGENCY_OPERATOR (design §8, D-PLAN-1; Plan machine edge
 * `new_plan_revision` from DRAFT / VALIDATION_REQUIRED / VALIDATED / APPROVED → SUPERSEDED "Keep predecessor history",
 * "Invalidate only dependent evidence with impact map", "Old approval cannot attach to new content"; then `compiled_or_edited`
 * on the successor "Freeze this version's body hash; do not inherit old validation"; catalogue failure "A stale UI cannot edit
 * or approve the previous version as if current").
 *
 * Order: reserve → authorize → lock predecessor (NOT_FOUND) → expectedVersion (STALE_VERSION carrying successorId when the
 * plan was already superseded) → listed edge (SUPERSEDED / WITHDRAWN / VALIDATING → PRECONDITION_FAILED) → resolve the typed
 * patch (UNKNOWN_REFERENCE) → compile it (rejections are INVALID_REQUEST with the compiler reason) → a body with the same hash
 * is NO_SEMANTIC_CHANGE → CAS predecessor to SUPERSEDED naming the successor → INSERT successor (DRAFT v1) → successor to
 * VALIDATION_REQUIRED (v2) → plan.superseded.v1 (impact map), plan.created.v1, plan.validation_required.v1 → journal 201.
 */
import type { ArtifactRef, FailureReason, PlanId } from "@kauro/domain";
import { DomainFailure, findTransition } from "@kauro/domain";
import { planView } from "../../api/projections.js";
import type { ArtifactResolver, PatchCompilation, PlanPatchCompiler } from "../../ports/plan-services.js";
import { REVISE_PLAN, type RevisePlanBody, type RevisePlanHandler, type RevisePlanView } from "../contracts.js";
import { runCommand, type CommandRuntime } from "../runtime.js";
import { applied, checkExpectedVersion, requireMembership } from "./shared.js";

const COMPILER_REASON: Readonly<Record<Extract<PatchCompilation, { kind: "REJECTED" }>["reason"], FailureReason>> = Object.freeze({
  UNKNOWN_CANDIDATE: "PATCH_UNKNOWN_CANDIDATE",
  UNKNOWN_FIELD: "PATCH_UNKNOWN_FIELD",
  EFFECT_NOT_PERMITTED: "PATCH_EFFECT_NOT_PERMITTED",
  MALFORMED_PATCH: "PATCH_MALFORMED",
});

/** Why a plan cannot take the edge, by its current state (the terminal states name where the content went). */
function refusalReason(state: string): FailureReason {
  if (state === "SUPERSEDED") return "PLAN_SUPERSEDED";
  if (state === "WITHDRAWN") return "PLAN_WITHDRAWN";
  return "UNLISTED_TRANSITION";
}

export function revisePlanHandler(runtime: CommandRuntime, artifacts: ArtifactResolver, compiler: PlanPatchCompiler): RevisePlanHandler {
  return {
    spec: REVISE_PLAN,
    execute: (envelope) =>
      runCommand<RevisePlanBody, RevisePlanView>(REVISE_PLAN, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const planId = envelope.path["planId"] as PlanId;
        const predecessor = await uow.plans.lock(planId);
        if (!predecessor || predecessor.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "plan not visible");
        checkExpectedVersion(predecessor, envelope.body.expectedVersion, predecessor.supersededByPlanId !== undefined ? { successorId: predecessor.supersededByPlanId } : {});
        if (findTransition("Plan", predecessor.state, "new_plan_revision") === null) {
          throw new DomainFailure("PRECONDITION_FAILED", "plan cannot be revised from its state", {
            reason: refusalReason(predecessor.state),
            currentState: predecessor.state,
            currentVersion: predecessor.version,
            ...(predecessor.supersededByPlanId !== undefined ? { successorId: predecessor.supersededByPlanId } : {}),
          });
        }
        const patch = await artifacts.resolveDecisionPatch(uow, membership.agencyId, envelope.body.decisionPatchArtifactRef as ArtifactRef);
        if (!patch) {
          throw new DomainFailure("INVALID_REQUEST", "decision patch artifact not visible", { reason: "UNKNOWN_REFERENCE", fields: [{ field: "decisionPatchArtifactRef", code: "UNKNOWN_REFERENCE" }] });
        }
        const currentBody = await uow.plans.getBody(planId);
        if (!currentBody) throw new DomainFailure("INTEGRITY_FAILURE", "locked plan has no body");
        const compilation = await compiler.apply(currentBody, patch);
        if (compilation.kind === "REJECTED") {
          throw new DomainFailure("INVALID_REQUEST", "typed patch rejected", { reason: COMPILER_REASON[compilation.reason], fields: [{ field: "decisionPatchArtifactRef", code: "UNKNOWN_REFERENCE" }] });
        }
        if (compilation.bodyHash === predecessor.bodyHash) {
          throw new DomainFailure("PRECONDITION_FAILED", "the patch changes nothing", { reason: "NO_SEMANTIC_CHANGE", currentState: predecessor.state, currentVersion: predecessor.version });
        }
        const successorId = runtime.ids.next() as PlanId;
        // serialization point: the compare-and-swap on the predecessor plus plans_supersedes_once close the race (S051)
        const superseded = applied(await uow.plans.transition(planId, envelope.body.expectedVersion, { state: "SUPERSEDED", supersededByPlanId: successorId }, ctx.now));
        const draft = await uow.plans.insert({
          planId: successorId,
          agencyId: membership.agencyId,
          projectId: predecessor.projectId,
          body: compilation.body,
          bodyHash: compilation.bodyHash,
          supersedesPlanId: planId,
          createdByMembershipId: membership.membershipId,
          createdAt: ctx.now,
        });
        const successor = applied(await uow.plans.transition(successorId, draft.version, { state: "VALIDATION_REQUIRED" }, ctx.now));
        const invalidated = {
          ...(predecessor.validationReceiptHash !== undefined ? { validationReceiptHash: predecessor.validationReceiptHash } : {}),
          ...(predecessor.approvalId !== undefined ? { approvalId: predecessor.approvalId } : {}),
        };
        const actor = { kind: "USER", userId: envelope.userId } as const;
        await uow.events.publish({
          aggregateKind: "plan",
          aggregateId: planId,
          aggregateVersion: superseded.version,
          agencyId: membership.agencyId,
          eventType: "plan.superseded.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: {
            planId,
            agencyId: membership.agencyId,
            successorPlanId: successorId,
            ...(invalidated.approvalId !== undefined ? { invalidatedApprovalId: invalidated.approvalId } : {}),
            ...(invalidated.validationReceiptHash !== undefined ? { invalidatedReceiptHash: invalidated.validationReceiptHash } : {}),
          },
        });
        await uow.events.publish({
          aggregateKind: "plan",
          aggregateId: successorId,
          aggregateVersion: draft.version,
          agencyId: membership.agencyId,
          eventType: "plan.created.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { planId: successorId, agencyId: membership.agencyId, projectId: predecessor.projectId, bodyHash: compilation.bodyHash, supersedesPlanId: planId, createdByMembershipId: membership.membershipId },
        });
        await uow.events.publish({
          aggregateKind: "plan",
          aggregateId: successorId,
          aggregateVersion: successor.version,
          agencyId: membership.agencyId,
          eventType: "plan.validation_required.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { planId: successorId, agencyId: membership.agencyId, bodyHash: compilation.bodyHash },
        });
        return {
          status: 201,
          view: {
            plan: planView(successor),
            supersededPlan: { planId, version: superseded.version, state: "SUPERSEDED" },
            invalidated,
          },
          version: successor.version,
          resourceKind: "plan",
          resourceId: successorId,
        };
      }),
  };
}
