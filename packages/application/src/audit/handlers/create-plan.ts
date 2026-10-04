/**
 * CMD022 CreatePlan — POST /api/v1/audits/{auditId}/plans — AGENCY_OPERATOR (design B08 §7, §12; D8-PLAN-1, D8-PORT-1, D8-LOCK-1;
 * Plan machine edges `compiled_or_edited` from the new plan and `validation_required`; catalogue "Compile the agency's decisions over the
 * audit's candidates into a plan body; freeze its hash").
 *
 * Order: authorize → reserve → the audit row (NOT_FOUND; a foreign and a nonexistent audit answer alike) under its row lock, so a
 * cancellation or an orchestration edge issued meanwhile waits and the state read is the state compiled against → the audit awaits the
 * agency's decisions (NEEDS_DECISION, else 409 AUDIT_NOT_DECIDABLE naming where it stands) → the agency's CANDIDATE_DECISIONS artifact of
 * this audit (UNKNOWN_REFERENCE: a foreign, a missing and a wrong-kind artifact answer alike) → the Intelligence core's plan compiler over
 * the artifact's document (INVALID_REQUEST with the compiler's reason when it rejects) → the body's KAURO_PLAN_BODY_V1 digest recomputed,
 * never taken from the compiler (INTEGRITY_FAILURE BODY_DIGEST_MISMATCH), and the plan's subject the audit's own revision and target
 * (PATCH_EFFECT_NOT_PERMITTED) → INSERT the plan (DRAFT v1) → VALIDATION_REQUIRED (v2) → plan.created.v1, plan.validation_required.v1 →
 * journal 201 with the plan.
 *
 * The audit is not written: the plan is the agency's own draft, and an audit may back several plans (each revision of the decisions is a
 * new plan; the audit row lock only orders them). A deployment without the cores answers CORE_SERVICES_UNAVAILABLE at the compiler, inside
 * the unit of work, with nothing written (D8-PORT-1).
 */
import type { ArtifactRef, AuditId, FailureReason, PlanId, TypedPatchFieldCode } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { planActions } from "../../api/permitted-actions.js";
import { planView } from "../../api/projections.js";
import type { PlanView } from "../../api/views.js";
import { planBodyDigest, requireMembership } from "../../commands/handlers/shared.js";
import type { PlanCompilerPort } from "../../ports/core-ports.js";
import type { PatchCompilation } from "../../ports/plan-services.js";
import { CREATE_PLAN, type CreatePlanBody, type CreatePlanHandler } from "../contracts.js";
import { runAuditCommand, versionAt, type AuditRuntime } from "./shared.js";

const REF_FIELD = "candidateDecisionArtifactRef";

/** Compiler rejection → problem reason, which is also the field code on the artifact reference (the same vocabulary as CMD023). */
const COMPILER_REASON: Readonly<Record<Extract<PatchCompilation, { kind: "REJECTED" }>["reason"], FailureReason & TypedPatchFieldCode>> = Object.freeze({
  UNKNOWN_CANDIDATE: "PATCH_UNKNOWN_CANDIDATE",
  UNKNOWN_FIELD: "PATCH_UNKNOWN_FIELD",
  EFFECT_NOT_PERMITTED: "PATCH_EFFECT_NOT_PERMITTED",
  MALFORMED_PATCH: "PATCH_MALFORMED",
});

export function createPlanHandler(runtime: AuditRuntime, compiler: PlanCompilerPort): CreatePlanHandler {
  return {
    spec: CREATE_PLAN,
    execute: (envelope) =>
      runAuditCommand<CreatePlanBody, PlanView>(
        CREATE_PLAN,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const auditId = envelope.path["auditId"] as AuditId;

          // the audit under its row lock; an audit of another agency is the answer of one that never existed
          const found = await uow.audits.getAudit(auditId);
          if (!found || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "audit not visible");
          const audit = await uow.audits.lockAudit(auditId);
          if (!audit) throw new DomainFailure("NOT_FOUND", "audit not visible");
          if (audit.state !== "NEEDS_DECISION") {
            throw new DomainFailure("PRECONDITION_FAILED", "the audit has no candidate decisions awaiting the agency", { reason: "AUDIT_NOT_DECIDABLE", currentVersion: audit.version, currentState: audit.state });
          }

          // the agency's candidate decisions of this audit: a reference outside it is unknown, never revealed
          const artifact = await uow.audits.getDecisionArtifact(envelope.body.candidateDecisionArtifactRef as ArtifactRef);
          if (!artifact || artifact.agencyId !== membership.agencyId || artifact.auditId !== auditId || artifact.kind !== "CANDIDATE_DECISIONS") {
            throw new DomainFailure("INVALID_REQUEST", "candidate decision artifact not visible", { reason: "UNKNOWN_REFERENCE", fields: [{ field: REF_FIELD, code: "UNKNOWN_REFERENCE" }] });
          }

          const compilation = await compiler.compile(artifact.document, null);
          if (compilation.kind === "REJECTED") {
            const reason = COMPILER_REASON[compilation.reason];
            throw new DomainFailure("INVALID_REQUEST", "candidate decisions rejected", { reason, fields: [{ field: REF_FIELD, code: reason }] });
          }
          // N10: the plan's hash is the KAURO_PLAN_BODY_V1 digest of the compiled body, computed here; a compiler that claims another hash
          // is an integrity failure, never a stored hash that describes other content
          const bodyHash = planBodyDigest(compilation.body);
          if (compilation.bodyHash !== bodyHash) throw new DomainFailure("INTEGRITY_FAILURE", "the compiled body's digest differs from the hash the compiler claimed", { reason: "BODY_DIGEST_MISMATCH" });
          // the decisions compile a plan of the audit's own source and target, never of another
          if (compilation.body.revisionHash !== audit.revisionHash || compilation.body.targetContractHash !== audit.targetContractHash) {
            throw new DomainFailure("INVALID_REQUEST", "the candidate decisions compile a plan of another source or target than the audit's", {
              reason: "PATCH_EFFECT_NOT_PERMITTED",
              fields: [{ field: REF_FIELD, code: "PATCH_EFFECT_NOT_PERMITTED" }],
            });
          }

          const planId = uow.ids.next() as PlanId;
          const draft = await uow.plans.insert({ planId, agencyId: membership.agencyId, projectId: audit.projectId, body: compilation.body, createdByMembershipId: membership.membershipId, createdAt: ctx.now });
          if (draft.bodyHash !== bodyHash) throw new DomainFailure("INTEGRITY_FAILURE", "the stored plan hash is not the digest of its body", { reason: "BODY_DIGEST_MISMATCH" });
          // the plan was inserted in this unit of work: nobody else holds its version, so a stale transition is an integrity failure, never a 409
          const moved = await uow.plans.transition(planId, draft.version, { state: "VALIDATION_REQUIRED" }, ctx.now);
          if (moved.kind === "STALE") throw new DomainFailure("INTEGRITY_FAILURE", "a plan inserted in this unit of work changed before it left DRAFT");
          const plan = moved.record;

          const actor = { kind: "USER", userId: envelope.userId } as const;
          await uow.events.publish({
            aggregateKind: "plan",
            aggregateId: planId,
            aggregateVersion: draft.version,
            agencyId: membership.agencyId,
            eventType: "plan.created.v1",
            actor,
            causationId: ctx.causationId,
            correlationId: envelope.correlationId,
            payload: { planId, agencyId: membership.agencyId, projectId: audit.projectId, bodyHash, createdByMembershipId: membership.membershipId },
          });
          await uow.events.publish({
            aggregateKind: "plan",
            aggregateId: planId,
            aggregateVersion: plan.version,
            agencyId: membership.agencyId,
            eventType: "plan.validation_required.v1",
            actor,
            causationId: ctx.causationId,
            correlationId: envelope.correlationId,
            payload: { planId, agencyId: membership.agencyId, bodyHash },
          });
          return { status: 201 as const, view: planView(plan, planActions(membership.role, plan, false)), version: plan.version, resourceKind: "plan", resourceId: planId };
        },
        versionAt(),
      ),
  };
}
