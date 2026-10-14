/**
 * CMD019 ConfirmTargetContract — POST /api/v1/target-contracts/{contractId}/confirm — AGENCY_APPROVER (registry command CMD019, gate
 * G-VENDOR; "Record confirmation of that exact contract without altering its body"; failure "A reused digest over changed metadata or
 * future observation rejects").
 *
 * Order (B17 L1, docs/design/B15-B17-B18-local-plan.md section 3, decision D-R3-1): authorize (an approving role of an ACTIVE membership:
 * the stored authority) → reserve → the contract (NOT_FOUND; a foreign and a nonexistent contract answer alike) → the project row
 * (FOR NO KEY UPDATE: the serialization point of two confirmations of one project, and of ExecuteProject) → the contract row (FOR NO KEY
 * UPDATE) → the contract decided on the locked record (below) → the stored body → the evidence → the project's current contracts (FOR NO KEY
 * UPDATE, ascending) → the exclusive transition halves of those and of this contract, ascending → the APPROVED plans bound to them (the last
 * await) → the effect clock → the judgments:
 *
 *   - SUPERSEDED: 409 TARGET_STALE; CONFIRMED: 409 PRECONDITION_FAILED TARGET_ALREADY_CONFIRMED naming where it stands, answered
 *     before the version is compared, so the loser of a race is told what became of the contract, not that it is stale;
 *   - a version other than the one read: 409 STALE_VERSION;
 *   - the stored body digest recomputed (BODY_DIGEST_MISMATCH when it is not the stored hash) and the caller bodyHash compared with it in
 *     constant time: a digest that is not this body is 409 STALE_VERSION (mismatch bodyHash), never a confirmation of unseen content;
 *   - the observation judged on the database's effect clock: dated ahead of it OBSERVATION_IN_FUTURE, older than the freshness window
 *     OBSERVATION_NOT_FRESH;
 *   - the evidence a CONFIRMATION_EVIDENCE artifact of this contract project (UNKNOWN_REFERENCE);
 *   - a current contract of the project observed at or after this one: TARGET_STALE (only a later observation supersedes);
 *   - otherwise every current contract of the project is superseded by this one (the database stamps the instant), the DRAFT to CONFIRMED
 *     edge is recorded (the confirmation instant stamped by the database, the confirming membership and the evidence, the version + 1, the
 *     body untouched), and each APPROVED plan bound to a superseded contract gets one re-check plan in VALIDATION_REQUIRED (its body with
 *     only targetContractHash replaced; R2 05:121 "a previously approved CRM plan does not automatically survive"; its approval is never
 *     automatic) → journal 200 with the contract, what it superseded, the re-check plan ids and the included paths.
 */
import type { ArtifactRef, PlanId, TargetContractId, TargetContractRecord } from "@kauro/domain";
import { DomainFailure, StaleVersionFailure, TARGET_OBSERVATION_FRESHNESS_SECONDS, effectNowOf, targetBodyDigest } from "@kauro/domain";
import { digestEquals } from "@kauro/contracts";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { CONFIRM_TARGET_CONTRACT, type ConfirmTargetContractBody, type ConfirmTargetContractHandler } from "../contracts.js";
import type { TargetContractView } from "../views.js";
import { targetContractView } from "./projections.js";
import { runAuditCommand, versionAt, type AuditRuntime } from "./shared.js";

export function confirmTargetContractHandler(runtime: AuditRuntime): ConfirmTargetContractHandler {
  return {
    spec: CONFIRM_TARGET_CONTRACT,
    execute: (envelope) =>
      runAuditCommand<ConfirmTargetContractBody, TargetContractView>(
        CONFIRM_TARGET_CONTRACT,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const contractId = envelope.path["contractId"] as TargetContractId;

          const found = await uow.targetContracts.getLifecycle(contractId);
          if (!found || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "target contract not visible");
          // the lock order of section 3 (acyclic with ExecuteProject and CreateTargetContract, which take the project row first too)
          await uow.projects.lock(found.projectId);
          const contract = await uow.targetContracts.lockLifecycle(contractId);
          if (!contract) throw new DomainFailure("NOT_FOUND", "target contract not visible");

          if (contract.state === "SUPERSEDED") throw new DomainFailure("TARGET_STALE", "the target contract was superseded");
          if (contract.state === "CONFIRMED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the target contract is already confirmed", { reason: "TARGET_ALREADY_CONFIRMED", currentVersion: contract.version, currentState: contract.state });
          }
          checkExpectedVersion(contract, envelope.body.expectedVersion);

          // the digest of the stored body, recomputed: a stored hash that is not it is an integrity failure, a caller digest that is not it is stale
          const stored = await uow.targetContracts.getBody(contractId);
          if (!stored) throw new DomainFailure("NOT_FOUND", "target contract not visible");
          const recomputed = targetBodyDigest(stored.body);
          if (!digestEquals(recomputed, stored.bodyHash)) throw new DomainFailure("INTEGRITY_FAILURE", "the stored target body is not the body its digest names", { reason: "BODY_DIGEST_MISMATCH" });
          if (!digestEquals(envelope.body.bodyHash, recomputed)) throw new StaleVersionFailure(contract.version, contract.state, { mismatch: ["bodyHash"] });

          // what the confirming actor was shown; the project's current contracts this confirmation supersedes (D-R3-1: every one, no
          // equivalence branch), their exclusive transition halves and this contract's, ascending; then the APPROVED plans bound to them
          const evidence = await uow.targetContracts.getArtifact(envelope.body.confirmationEvidenceRef as ArtifactRef);
          const priors = await uow.targetContracts.lockCurrentOfProject(membership.agencyId, contract.projectId, contractId);
          await uow.targetContracts.holdTransitions([...priors.map((p) => p.contractId), contractId]);
          const bound = await uow.targetContracts.approvedPlansBoundTo(membership.agencyId, contract.projectId, priors.map((p) => p.bodyHash));
          // r15/r25: the clock is read after the last await, and nothing is awaited between the judgments and the effect
          const nowMs = Date.parse(await effectNowOf(uow));

          const observedMs = Date.parse(stored.body.observedAt);
          if (observedMs > nowMs) throw new DomainFailure("PRECONDITION_FAILED", "the observation is dated after the database clock", { reason: "OBSERVATION_IN_FUTURE" });
          if (nowMs - observedMs > TARGET_OBSERVATION_FRESHNESS_SECONDS * 1000) {
            throw new DomainFailure("PRECONDITION_FAILED", "the observation is older than the freshness window", { reason: "OBSERVATION_NOT_FRESH" });
          }
          if (!evidence || evidence.agencyId !== membership.agencyId || evidence.kind !== "CONFIRMATION_EVIDENCE" || evidence.projectId !== contract.projectId) {
            throw new DomainFailure("INVALID_REQUEST", "the confirmation evidence is not visible", { reason: "UNKNOWN_REFERENCE", fields: [{ field: "confirmationEvidenceRef", code: "UNKNOWN_REFERENCE" }] });
          }
          // a confirmation supersedes only older observations: a current contract observed at or after this one makes this one stale
          if (priors.some((p) => Date.parse(p.observedAt) >= observedMs)) throw new DomainFailure("TARGET_STALE", "a later observation of the target is already the project's current contract");

          // the effect: the priors superseded one by one ascending, then this contract confirmed, then one re-check plan per bound APPROVED plan
          const superseded: TargetContractRecord[] = [];
          for (const prior of priors) superseded.push(await uow.targetContracts.supersede(prior.contractId, contractId));
          const confirmed = applied(
            await uow.targetContracts.confirm(contractId, envelope.body.expectedVersion, { membershipId: membership.membershipId, evidenceRef: evidence.artifactRef }),
          );
          const actor = { kind: "USER", userId: envelope.userId } as const;
          const recheckPlanIds: PlanId[] = [];
          for (const plan of bound) {
            const planId = uow.ids.next() as PlanId;
            const draft = await uow.targetContracts.insertRecheckPlan({
              planId,
              agencyId: membership.agencyId,
              projectId: contract.projectId,
              recheckOfPlanId: plan.planId,
              body: { ...plan.body, targetContractHash: confirmed.bodyHash },
              createdByMembershipId: membership.membershipId,
            });
            const moved = await uow.plans.transition(planId, draft.version, { state: "VALIDATION_REQUIRED" }, ctx.now);
            if (moved.kind === "STALE") throw new DomainFailure("INTEGRITY_FAILURE", "a re-check plan inserted in this unit of work changed before it left DRAFT");
            await uow.events.publish({
              aggregateKind: "plan",
              aggregateId: planId,
              aggregateVersion: draft.version,
              agencyId: membership.agencyId,
              eventType: "plan.created.v1",
              actor,
              causationId: ctx.causationId,
              correlationId: envelope.correlationId,
              payload: { planId, agencyId: membership.agencyId, projectId: contract.projectId, bodyHash: draft.bodyHash, createdByMembershipId: membership.membershipId },
            });
            await uow.events.publish({
              aggregateKind: "plan",
              aggregateId: planId,
              aggregateVersion: moved.record.version,
              agencyId: membership.agencyId,
              eventType: "plan.validation_required.v1",
              actor,
              causationId: ctx.causationId,
              correlationId: envelope.correlationId,
              payload: { planId, agencyId: membership.agencyId, bodyHash: draft.bodyHash },
            });
            recheckPlanIds.push(planId);
          }
          return {
            status: 200 as const,
            view: targetContractView(confirmed, stored.body.objects.length, membership.role, { superseded, recheckPlanIds }),
            version: confirmed.version,
            resourceKind: "target_contract",
            resourceId: confirmed.contractId,
          };
        },
        versionAt(),
      ),
  };
}
