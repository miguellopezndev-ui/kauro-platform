/**
 * CMD026 WithdrawApproval — POST /api/v1/plans/{planId}/withdraw — AGENCY_APPROVER (design §8, D-AUTHZ-3; Plan machine edge
 * `withdraw_approval` APPROVED → WITHDRAWN "Current organization authority withdraws future use. Cancel/reconcile active work
 * under its own state machine"; catalogue: "The actor controls this approval; already completed external/customer actions are
 * identified separately"; failure "Do not delete history or promise rollback of an agency-performed CRM import").
 *
 * Order: reserve → authorize (OWNER/APPROVER) → lock plan (NOT_FOUND) → expectedVersion → state APPROVED (else
 * PRECONDITION_FAILED / PLAN_NOT_APPROVED) → live approval (an APPROVED plan without one is an integrity failure) → the caller
 * is the approving actor or an OWNER (else NOT_AUTHORIZED / NOT_APPROVAL_CONTROLLER) → completed external actions identified →
 * approval withdrawn once (withdrawn_at/by/reason, version 2) → plan WITHDRAWN (version + 1) → approval.withdrawn.v1 +
 * plan.withdrawn.v1 (NOTIFICATIONS + EXECUTION_CONTROL route active work through cancellation/reconciliation) → journal 200
 * {approval, plan, completedExternalActions}. The approval row and the receipts stay; nothing promises a rollback.
 */
import type { PlanId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { approvalView, planView } from "../../api/projections.js";
import type { ExternalActionInspector } from "../../ports/work-inspectors.js";
import { WITHDRAW_APPROVAL, type WithdrawApprovalBody, type WithdrawApprovalHandler, type WithdrawApprovalView } from "../contracts.js";
import { runCommand, type CommandRuntime } from "../runtime.js";
import { applied, checkExpectedVersion, requireMembership } from "./shared.js";

export function withdrawApprovalHandler(runtime: CommandRuntime, inspector: ExternalActionInspector): WithdrawApprovalHandler {
  return {
    spec: WITHDRAW_APPROVAL,
    execute: (envelope) =>
      runCommand<WithdrawApprovalBody, WithdrawApprovalView>(WITHDRAW_APPROVAL, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const planId = envelope.path["planId"] as PlanId;
        const plan = await uow.plans.lock(planId);
        if (!plan || plan.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "plan not visible");
        checkExpectedVersion(plan, envelope.body.expectedVersion, plan.supersededByPlanId !== undefined ? { successorId: plan.supersededByPlanId } : {});
        if (plan.state !== "APPROVED") {
          throw new DomainFailure("PRECONDITION_FAILED", "plan is not approved", {
            reason: "PLAN_NOT_APPROVED",
            currentState: plan.state,
            currentVersion: plan.version,
            ...(plan.supersededByPlanId !== undefined ? { successorId: plan.supersededByPlanId } : {}),
          });
        }
        const approval = await uow.approvals.findLiveByPlan(planId);
        if (!approval || approval.planId !== planId) throw new DomainFailure("INTEGRITY_FAILURE", "approved plan has no live approval");
        if (approval.actorMembershipId !== membership.membershipId && membership.role !== "OWNER") {
          throw new DomainFailure("NOT_AUTHORIZED", "caller does not control this approval", { reason: "NOT_APPROVAL_CONTROLLER" });
        }
        const completed = await inspector.completedForPlan(uow, planId);
        const withdrawn = await uow.approvals.withdraw(approval.approvalId, approval.version, { membershipId: membership.membershipId, reasonCode: envelope.body.reasonCode }, ctx.now);
        if (withdrawn.kind === "STALE") throw new DomainFailure("INTEGRITY_FAILURE", "live approval changed under the plan lock");
        const withdrawnPlan = applied(await uow.plans.transition(planId, envelope.body.expectedVersion, { state: "WITHDRAWN" }, ctx.now));
        const actor = { kind: "USER", userId: envelope.userId } as const;
        await uow.events.publish({
          aggregateKind: "approval",
          aggregateId: approval.approvalId,
          aggregateVersion: withdrawn.record.version,
          agencyId: membership.agencyId,
          eventType: "approval.withdrawn.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: {
            approvalId: approval.approvalId,
            agencyId: membership.agencyId,
            planId,
            reasonCode: envelope.body.reasonCode,
            withdrawnByMembershipId: membership.membershipId,
            completedExternalActions: completed.map((a) => a.referenceId),
          },
        });
        await uow.events.publish({
          aggregateKind: "plan",
          aggregateId: planId,
          aggregateVersion: withdrawnPlan.version,
          agencyId: membership.agencyId,
          eventType: "plan.withdrawn.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { planId, agencyId: membership.agencyId, approvalId: approval.approvalId, reasonCode: envelope.body.reasonCode },
        });
        return {
          status: 200,
          view: { approval: approvalView(withdrawn.record), plan: planView(withdrawnPlan), completedExternalActions: completed },
          version: withdrawnPlan.version,
          resourceKind: "plan",
          resourceId: planId,
        };
      }),
  };
}
