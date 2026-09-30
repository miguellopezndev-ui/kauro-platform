/**
 * CMD024 ValidatePlan — POST /api/v1/plans/{planId}/validate — AGENCY_OPERATOR (design B08 §7, §12; D8-PLAN-2, D8-LOCK-1, D8-CAU-3,
 * D8-CAU-4; Plan machine edge `validation_requested` VALIDATION_REQUIRED → VALIDATING; catalogue "Request validation of a frozen plan
 * body; the receipt binds the plan hash").
 *
 * Order: authorize → reserve → the plan row under its lock (NOT_FOUND; a foreign and a nonexistent plan answer alike) → the caller's
 * view of the plan: expectedVersion (STALE_VERSION), then the body hash the caller reviewed (STALE_VERSION naming planHash as the
 * mismatch: a body that changed is never validated unseen) → the plan is VALIDATION_REQUIRED (PLAN_NOT_VALIDATABLE naming where it
 * stands) → the store's validation request: the plan VALIDATING and one validation intent (origin COMMAND) for the control plane's
 * PLAN_VALIDATION worker, with its outbox record in the same statement → journal 202 ACCEPTED (operationId = the plan, statusPath =
 * its read).
 *
 * The request calls no core and spends no budget: the validation itself — deterministic local work over the frozen body — runs after
 * commit, and its receipt settles the intent (D8-PLAN-2).
 */
import type { PlanId, PlanValidationId } from "@kauro/domain";
import { DomainFailure, StaleVersionFailure } from "@kauro/domain";
import type { AcceptedOutcome } from "../../commands/runtime.js";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { AUDIT_POLL_AFTER_SECONDS, VALIDATE_PLAN, type ValidatePlanBody, type ValidatePlanHandler } from "../contracts.js";
import { runAuditCommand, type AuditRuntime } from "./shared.js";

export function validatePlanHandler(runtime: AuditRuntime): ValidatePlanHandler {
  return {
    spec: VALIDATE_PLAN,
    execute: (envelope) =>
      runAuditCommand<ValidatePlanBody, never>(
        VALIDATE_PLAN,
        runtime,
        envelope,
        async (uow, ctx): Promise<AcceptedOutcome> => {
          const membership = requireMembership(ctx);
          const planId = envelope.path["planId"] as PlanId;
          const plan = await uow.plans.lock(planId);
          if (!plan || plan.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "plan not visible");

          checkExpectedVersion(plan, envelope.body.expectedVersion);
          if (envelope.body.planHash !== plan.bodyHash) throw new StaleVersionFailure(plan.version, plan.state, { mismatch: ["planHash"] });
          if (plan.state !== "VALIDATION_REQUIRED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the plan is not awaiting validation", { reason: "PLAN_NOT_VALIDATABLE", currentVersion: plan.version, currentState: plan.state });
          }

          applied(
            await uow.audits.requestValidation({
              validationId: uow.ids.next() as PlanValidationId,
              planId,
              expectedVersion: envelope.body.expectedVersion,
              requestedByMembershipId: membership.membershipId,
            }),
          );
          return {
            status: 202,
            accepted: { operationId: planId, state: "VALIDATING", statusPath: `/api/v1/plans/${planId}`, pollAfterSeconds: AUDIT_POLL_AFTER_SECONDS },
            resourceKind: "plan",
            resourceId: planId,
          };
        },
        () => {
          throw new DomainFailure("INTEGRITY_FAILURE", "an ACCEPTED answer carries no aggregate version");
        },
      ),
  };
}
