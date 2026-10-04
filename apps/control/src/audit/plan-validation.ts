/**
 * PLAN_VALIDATION (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §8.1 Plan valid_receipt and
 * invalid_receipt_result, §11; decisions D8-PLAN-2, D8-PAU-6, D8-CAU-3, D8-CAU-7; supporting B01's CMD024 and B03's IC-03).
 *
 * ValidatePlan (CMD024) records the plan's next validation intent and moves it VALIDATION_REQUIRED -> VALIDATING with
 * `plan.validating.v1`; this consumer validates the plan's current intent: in a unit bound to the plan's agency it reads the plan and its
 * latest intent (an intent already settled, one of a system draft — AUDIT_ORCHESTRATION's own — or a plan no longer VALIDATING is DONE),
 * then outside any transaction `ValidatePort` runs on exactly the intent's stored body (its digest recomputed first), source and target;
 * the answer is judged against them and the core the platform binds, a well-formed receipt recorded by the validator's own pool
 * (receipts.ts), and in a last unit the intent settles — only if it is still unsettled — VALID with its receipt (the plan VALIDATED) or
 * INVALID or ERROR (the plan back to VALIDATION_REQUIRED, never an old VALIDATED status). A late answer of an intent another delivery
 * settled, or of a plan revised meanwhile, leaves its receipt as evidence of what the validator saw and moves nothing: only the current
 * intent moves the plan (the database's plans_validation_intent, KA080).
 */
import type { ConsumerOutcome, OutboxConsumer } from "@kauro/application";
import type { AgencyId, DomainEventRecord, PlanBody, PlanId, PlanValidationRecord, SystemContext, ValidationReceiptId, ValidationSubject } from "@kauro/domain";
import { EXECUTION_SERVICES, applied, type ExecutionStep } from "../execution/work.js";
import type { PlanValidator } from "./receipts.js";
import { StepRefused, channelOf, guarded, inAgency, serverNowIn, type AuditWorkDependencies } from "./work.js";

const SERVICE = EXECUTION_SERVICES.PLAN_VALIDATION;

export interface PlanValidationDependencies extends AuditWorkDependencies {
  readonly validator: PlanValidator;
}

export class PlanValidation implements OutboxConsumer {
  readonly consumer = "PLAN_VALIDATION" as const;

  constructor(private readonly deps: PlanValidationDependencies) {}

  async handle(event: DomainEventRecord, _context: SystemContext): Promise<ConsumerOutcome> {
    if (event.eventType !== "plan.validating.v1" || event.agencyId === undefined || event.agencyId === null) return { kind: "DONE" };
    const step = await this.validatePlan(event.aggregateId as PlanId, event.agencyId as AgencyId);
    return step.kind === "RETRY" ? { kind: "RETRY", afterSeconds: step.afterSeconds, reason: step.reason } : { kind: "DONE" };
  }

  /** The plan's current intent validated and settled (header). */
  async validatePlan(planId: PlanId, agencyId: AgencyId): Promise<ExecutionStep> {
    return guarded(this.deps.retryAfterSeconds, async () => {
      const seen = await inAgency(this.deps, SERVICE, agencyId, async (uow) => {
        const subject = await uow.auditDiscovery.validationSubject(planId);
        if (subject === null) throw new StepRefused("PLAN_NOT_FOUND");
        const intent = subject.current;
        if (intent === null || intent.result !== undefined) throw new StepRefused("NO_OPEN_INTENT");
        // a system draft's intent is its audit's VALIDATE step's (AUDIT_ORCHESTRATION), never validated twice
        if (intent.origin !== "COMMAND") throw new StepRefused("SYSTEM_DRAFT_INTENT");
        if (subject.planState !== "VALIDATING") throw new StepRefused("PLAN_NOT_VALIDATING");
        return { subject, intent, startedAt: await uow.executionDiscovery.serverNow() };
      });
      const judged = await this.deps.validator.run({
        subject: { agencyId, planId, planHash: seen.intent.planHash, revisionHash: seen.intent.revisionHash, targetContractHash: seen.intent.targetContractHash },
        body: seen.subject.body as PlanBody,
        receiptId: this.deps.ids.next() as ValidationReceiptId,
        startedAt: seen.startedAt,
        cancellation: this.channel(seen.subject, seen.intent),
        completedAt: () => serverNowIn(this.deps, SERVICE, agencyId),
      });
      const settlement = judged.kind === "RECEIPT" ? { result: judged.receipt.result, receiptHash: judged.receipt.receiptHash } : { result: "ERROR" as const, receiptHash: null };
      return inAgency(this.deps, SERVICE, agencyId, async (uow) => {
        // only the intent still unsettled settles; the store's own update settles it once (a concurrent settlement misses it)
        const current = (await uow.audits.validationsOf(planId)).find((v) => v.validationId === seen.intent.validationId);
        if (current === undefined || current.result !== undefined) throw new StepRefused("INTENT_SETTLED");
        const settled = await uow.audits.settleValidation(seen.intent.validationId, settlement);
        return applied(settled.current ? settled.planState : "INTENT_SETTLED_NOT_CURRENT");
      });
    });
  }

  /** The check after the validator's await: the intent still unsettled and the plan's latest (D8-CANCEL-1, D8-PLAN-2). */
  private channel(subject: ValidationSubject, intent: PlanValidationRecord) {
    return channelOf(this.deps, SERVICE, subject.agencyId, async (uow) => {
      const intents = await uow.audits.validationsOf(subject.planId);
      const mine = intents.find((v) => v.validationId === intent.validationId);
      if (mine === undefined || mine.result !== undefined) return "CANCELLED";
      return intents.some((v) => v.fence > mine.fence) ? "FENCED" : "CONTINUE";
    });
  }
}
