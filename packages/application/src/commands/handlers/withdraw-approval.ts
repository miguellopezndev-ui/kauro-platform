/**
 * CMD026 WithdrawApproval — POST /api/v1/plans/{planId}/withdraw — AGENCY_APPROVER (design §8, D-AUTHZ-3; Plan machine edge
 * `withdraw_approval` APPROVED → WITHDRAWN "Current organization authority withdraws future use. Cancel/reconcile active work
 * under its own state machine"; catalogue: "The actor controls this approval; already completed external/customer actions are
 * identified separately"; failure "Do not delete history or promise rollback of an agency-performed CRM import").
 *
 * Order: authorize (OWNER/APPROVER) → reserve → lock plan (NOT_FOUND) → the caller controls the plan's approval — its
 * approving actor or an OWNER (else NOT_AUTHORIZED / NOT_APPROVAL_CONTROLLER, before any version or state answer; a plan that
 * never carried an approval has no controller to check) → expectedVersion → state APPROVED (else PRECONDITION_FAILED /
 * PLAN_NOT_APPROVED) → that approval is live (an APPROVED plan without one is an integrity failure) → completed external
 * actions identified → approval withdrawn once (withdrawn_at/by/reason, version 2) → plan WITHDRAWN (version + 1) →
 * approval.withdrawn.v1 + plan.withdrawn.v1 (NOTIFICATIONS + EXECUTION_CONTROL route active work through
 * cancellation/reconciliation; the reason is a label and stays on the approval row, D-API-1) → journal 200
 * {approval, plan, completedExternalActions}. The approval row and the receipts stay; nothing promises a rollback.
 * The controller rule (D-AUTHZ-3) is the one RevisePlan applies to an APPROVED predecessor (`controlsApproval`, D-PLAN-4).
 */
import type { PlanId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { approvalActions, planActions } from "../../api/permitted-actions.js";
import { approvalView, planView } from "../../api/projections.js";
import type { ExternalActionInspector } from "../../ports/work-inspectors.js";
import { WITHDRAW_APPROVAL, type WithdrawApprovalBody, type WithdrawApprovalHandler, type WithdrawApprovalView } from "../contracts.js";
import { runCommand, type CommandRuntime } from "../runtime.js";
import { applied, checkExpectedVersion, controlsApproval, requireMembership } from "./shared.js";

export function withdrawApprovalHandler(runtime: CommandRuntime, inspector: ExternalActionInspector): WithdrawApprovalHandler {
  return {
    spec: WITHDRAW_APPROVAL,
    execute: (envelope) =>
      runCommand<WithdrawApprovalBody, WithdrawApprovalView>(WITHDRAW_APPROVAL, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const planId = envelope.path["planId"] as PlanId;
        const plan = await uow.plans.lock(planId);
        if (!plan || plan.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "plan not visible");
        // resource relationship before version and state (design §6.1, step 9 before step 10): the approval this command controls
        // is the plan's — live, or the one it carried before a withdrawal — and only its approving actor or an OWNER controls it
        // (D-AUTHZ-3); anyone else is refused before learning the plan's version or state. A plan that never carried an approval
        // puts nobody's control at stake, and its version and state answer.
        const controlled = plan.approvalId !== undefined ? await uow.approvals.get(plan.approvalId) : null;
        if (plan.approvalId !== undefined && (!controlled || controlled.planId !== planId)) throw new DomainFailure("INTEGRITY_FAILURE", "the plan's approval is not visible");
        if (controlled && !controlsApproval(controlled, membership)) {
          throw new DomainFailure("NOT_AUTHORIZED", "caller does not control this approval", { reason: "NOT_APPROVAL_CONTROLLER" });
        }
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
        if (!approval || !controlled || approval.approvalId !== controlled.approvalId) throw new DomainFailure("INTEGRITY_FAILURE", "approved plan has no live approval");
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
          // the reason is a label (decision D-API-1): recorded on the approval row, never carried by an event payload
          payload: {
            approvalId: approval.approvalId,
            agencyId: membership.agencyId,
            planId,
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
          payload: { planId, agencyId: membership.agencyId, approvalId: approval.approvalId },
        });
        return {
          status: 200,
          view: { approval: approvalView(withdrawn.record, approvalActions(membership, withdrawn.record)), plan: planView(withdrawnPlan, planActions(membership.role, withdrawnPlan, false)), completedExternalActions: completed },
          version: withdrawnPlan.version,
          resourceKind: "plan",
          resourceId: planId,
        };
      }),
  };
}
