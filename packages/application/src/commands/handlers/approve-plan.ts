/**
 * CMD025 ApprovePlan — POST /api/v1/plans/{planId}/approve — AGENCY_APPROVER (design §8, D-PLAN-2, D-PLAN-3; Plan machine edge
 * `agency_approval` VALIDATED → APPROVED "Authorized actor, current assurance and exact disclosed effects match. Create
 * immutable Approval"; catalogue failure "Any changed effect, expired source or stale receipt requires new review; generic
 * cleanup approval cannot authorize undisclosed CLEAR").
 *
 * Manual 10 "Concurrency and preconditions" says "Approval commands name sourceRevisionHash, planHash and
 * targetContractHash"; the catalogue's CMD025 fields name planHash but neither source nor target hash. This edition follows
 * the catalogue (the request schema is exactly its fields) and binds source and target through the plan the approver names:
 * planHash is the Plan bodyHash, whose preimage contains revisionHash and targetContractHash (reference/HASHING_AND_ACCOUNTING_
 * RULES), the plan row's source and target columns are immutable, the approval's composite foreign key binds them to that
 * row, and expectedVersion pins the version displayed. The conflict is open question Q9 of the B06 review record
 * (docs/design/B06-review/C-handler-semantics.md, R32).
 *
 * Order: authorize → reserve → the fresh step-up (ASSURANCE_REQUIRED; its ALLOW fact commits with the approval) → lock plan (NOT_FOUND) → expectedVersion →
 * state VALIDATED (else PLAN_NOT_VALIDATED, or PRECONDITION_FAILED for SUPERSEDED / WITHDRAWN / APPROVED) → planHash equals
 * the plan body hash (else STALE_VERSION mismatch [planHash]) → the named receipt is the plan's current receipt, exists, is
 * VALID with no blocking codes and binds this body/source/target (else PLAN_NOT_VALIDATED / RECEIPT_NOT_CURRENT or
 * RECEIPT_BLOCKING) → the source revision is SEALED and its retention lies ahead on the server clock (else SOURCE_EXPIRED;
 * review finding B06-R2) → the target contract is confirmed and current
 * (else TARGET_STALE); both read after their transition locks, held to COMMIT (plan → source → target is the lock order, D-TX-2) → the server-composed disclosure set hashes to the echoed disclosuresHash (else STALE_VERSION mismatch
 * [disclosuresHash]: an approval displayed without the CLEAR set cannot authorize it) → INSERT approval (v1, actor membership
 * version, proof, five hashes, KAURO_PLAN_APPROVAL_V1 approval hash) → plan APPROVED (version + 1) → approval.created.v1 +
 * plan.approved.v1 → journal 201 {approval, plan}. The database re-checks the bindings as foreign keys.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type { ApprovalId, AssuranceProofId, PlanId } from "@kauro/domain";
import { DomainFailure, StaleVersionFailure } from "@kauro/domain";
import { approvalActions, planActions } from "../../api/permitted-actions.js";
import { approvalView, planView } from "../../api/projections.js";
import type { DisclosureComposer } from "../../ports/plan-services.js";
import { APPROVE_PLAN, type ApprovePlanBody, type ApprovePlanHandler, type ApprovePlanView } from "../contracts.js";
import { bindsCleanHash, runCommand, type CommandRuntime } from "../runtime.js";
import { applied, checkExpectedVersion, planBodyDigest, requireMembership } from "./shared.js";

/** The preimage of an approval hash (contract Approval; reference/HASHING_AND_ACCOUNTING_RULES: KAURO_PLAN_APPROVAL_V1). */
export interface ApprovalPreimage {
  readonly approvalId: string;
  readonly actorId: string;
  readonly agencyId: string;
  readonly planHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly validationReceiptHash: Sha256Hex;
  readonly disclosuresHash: Sha256Hex;
  readonly createdAt: string;
}

export function approvalHashOf(preimage: ApprovalPreimage): Sha256Hex {
  return structuredDigest(DOMAINS.PLAN_APPROVAL, 1, preimage);
}

export function approvePlanHandler(runtime: CommandRuntime, disclosures: DisclosureComposer): ApprovePlanHandler {
  return {
    spec: APPROVE_PLAN,
    execute: (envelope) =>
      runCommand<ApprovePlanBody, ApprovePlanView>(APPROVE_PLAN, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const planId = envelope.path["planId"] as PlanId;
        const plan = await uow.plans.lock(planId);
        if (!plan || plan.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "plan not visible");
        checkExpectedVersion(plan, envelope.body.expectedVersion, plan.supersededByPlanId !== undefined ? { successorId: plan.supersededByPlanId } : {});
        if (plan.state !== "VALIDATED") {
          const current = { currentState: plan.state, currentVersion: plan.version };
          if (plan.state === "SUPERSEDED") throw new DomainFailure("PRECONDITION_FAILED", "plan superseded", { reason: "PLAN_SUPERSEDED", ...current, ...(plan.supersededByPlanId !== undefined ? { successorId: plan.supersededByPlanId } : {}) });
          if (plan.state === "WITHDRAWN") throw new DomainFailure("PRECONDITION_FAILED", "plan withdrawn", { reason: "PLAN_WITHDRAWN", ...current });
          if (plan.state === "APPROVED") throw new DomainFailure("PRECONDITION_FAILED", "plan already approved", { reason: "UNLISTED_TRANSITION", ...current });
          throw new DomainFailure("PLAN_NOT_VALIDATED", "plan has no current validation", current);
        }
        if (envelope.body.planHash !== plan.bodyHash) throw new StaleVersionFailure(plan.version, plan.state, { reason: "HASH_MISMATCH", mismatch: ["planHash"] });
        // receipt: the plan's current receipt, present, VALID, non-blocking, bound to exactly this body/source/target
        if (plan.validationReceiptHash === undefined || plan.validationReceiptHash !== envelope.body.validationReceiptHash) {
          throw new DomainFailure("PLAN_NOT_VALIDATED", "receipt is not the plan's current receipt", { reason: "RECEIPT_NOT_CURRENT", currentState: plan.state, currentVersion: plan.version });
        }
        const receipt = await uow.receipts.findByHash(membership.agencyId, plan.validationReceiptHash);
        if (!receipt || receipt.planId !== planId) throw new DomainFailure("PLAN_NOT_VALIDATED", "receipt not visible", { reason: "RECEIPT_NOT_CURRENT" });
        if (receipt.result !== "VALID" || receipt.blockingIssueCodes.length > 0) throw new DomainFailure("PLAN_NOT_VALIDATED", "receipt blocks approval", { reason: "RECEIPT_BLOCKING" });
        if (receipt.planHash !== plan.bodyHash || receipt.revisionHash !== plan.revisionHash || receipt.targetContractHash !== plan.targetContractHash) {
          throw new DomainFailure("PLAN_NOT_VALIDATED", "receipt binds another subject", { reason: "RECEIPT_NOT_CURRENT" });
        }
        // the named planHash is the digest of the body this approval authorizes: recomputed from the stored body, never taken
        // from the column alone (re-check finding N10; reference/HASHING_AND_ACCOUNTING_RULES "the consumer recomputes")
        const body = await uow.plans.getBody(planId);
        if (!body) throw new DomainFailure("INTEGRITY_FAILURE", "locked plan has no body");
        if (planBodyDigest(body) !== plan.bodyHash) throw new DomainFailure("INTEGRITY_FAILURE", "the stored plan body is not the body its hash names", { reason: "BODY_DIGEST_MISMATCH" });
        // source: the plan's own project's revision (re-check finding N9) that the plan was validated against must still be
        // SEALED (not EXPIRED, SUPERSEDED, DELETED), read after its transition lock kept to COMMIT (D-TX-2): an expiry or
        // supersession issued meanwhile waits for this approval (and then sees it), one committed first is refused here —
        // never an approval committed over a source that stopped being SEALED. And it must still be available: a governing
        // retention record ACTIVE with its effective deadline ahead on the server clock (review finding B06-R2, D-SRC-1) — a
        // SEALED revision whose retention lapsed is an expired source whether or not the sweeper has taken retention_expires yet
        const source = await uow.revisions.lockSealedByHash(membership.agencyId, plan.projectId, plan.revisionHash);
        if (!source || source.state !== "SEALED") throw new DomainFailure("SOURCE_EXPIRED", "source revision is no longer sealed");
        if (source.availableUntil === null) throw new DomainFailure("SOURCE_EXPIRED", "source retention deadline has passed");
        // target: the plan's own project's contract with the plan's target hash (findings N4, N9), confirmed and unsuperseded,
        // under the same transition-lock discipline
        // a CLEAN plan binds the canonical CLEAN hash and reads no target (CP-02.01, candidate activation only)
        if (!(await bindsCleanHash(runtime, uow, { agencyId: membership.agencyId, projectId: plan.projectId, targetContractHash: plan.targetContractHash }))) {
          const target = await uow.targetContracts.lockCurrentByHash(membership.agencyId, plan.projectId, plan.targetContractHash);
          if (!target || target.confirmedAt === undefined || target.supersededAt !== undefined) throw new DomainFailure("TARGET_STALE", "target contract is not current");
        }
        // disclosures: the server composes the complete set (every CLEAR included) and the client must have displayed exactly it
        const disclosed = await disclosures.compose(uow, plan, body, receipt);
        if (disclosed.disclosuresHash !== envelope.body.disclosuresHash) {
          throw new StaleVersionFailure(plan.version, plan.state, { reason: "DISCLOSURES_INCOMPLETE", mismatch: ["disclosuresHash"] });
        }
        const approvalId = uow.ids.next() as ApprovalId;
        const preimage: ApprovalPreimage = {
          approvalId,
          actorId: envelope.userId,
          agencyId: membership.agencyId,
          planHash: plan.bodyHash,
          revisionHash: plan.revisionHash,
          targetContractHash: plan.targetContractHash,
          validationReceiptHash: receipt.receiptHash,
          disclosuresHash: disclosed.disclosuresHash,
          createdAt: ctx.now,
        };
        const approval = await uow.approvals.insert({
          approvalId,
          agencyId: membership.agencyId,
          planId,
          actorId: envelope.userId,
          actorMembershipId: membership.membershipId,
          actorMembershipVersion: membership.version,
          assuranceProofRef: envelope.body.assuranceProofRef as AssuranceProofId,
          planHash: plan.bodyHash,
          revisionHash: plan.revisionHash,
          targetContractHash: plan.targetContractHash,
          validationReceiptHash: receipt.receiptHash,
          disclosuresHash: disclosed.disclosuresHash,
          approvalHash: approvalHashOf(preimage),
          createdAt: ctx.now,
        });
        const approved = applied(await uow.plans.transition(planId, envelope.body.expectedVersion, { state: "APPROVED", approvalId }, ctx.now));
        const actor = { kind: "USER", userId: envelope.userId } as const;
        await uow.events.publish({
          aggregateKind: "approval",
          aggregateId: approvalId,
          aggregateVersion: approval.version,
          agencyId: membership.agencyId,
          eventType: "approval.created.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: {
            approvalId,
            agencyId: membership.agencyId,
            planId,
            planHash: approval.planHash,
            revisionHash: approval.revisionHash,
            targetContractHash: approval.targetContractHash,
            validationReceiptHash: approval.validationReceiptHash,
            disclosuresHash: approval.disclosuresHash,
            actorMembershipId: membership.membershipId,
            approvalHash: approval.approvalHash,
          },
        });
        await uow.events.publish({
          aggregateKind: "plan",
          aggregateId: planId,
          aggregateVersion: approved.version,
          agencyId: membership.agencyId,
          eventType: "plan.approved.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { planId, agencyId: membership.agencyId, approvalId, approvalHash: approval.approvalHash },
        });
        return { status: 201, view: { approval: approvalView(approval, approvalActions(membership, approval)), plan: planView(approved, planActions(membership.role, approved, true)) }, version: approved.version, resourceKind: "approval", resourceId: approvalId };
      }),
  };
}
