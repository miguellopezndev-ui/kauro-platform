/**
 * CMD019 ConfirmTargetContract — POST /api/v1/target-contracts/{contractId}/confirm — AGENCY_APPROVER (registry command CMD019, gate
 * G-VENDOR; "Record confirmation of that exact contract without altering its body"; failure "A reused digest over changed metadata or
 * future observation rejects").
 *
 * Order: authorize (an approving role of an ACTIVE membership: the stored authority) → reserve → the contract (NOT_FOUND; a foreign and a
 * nonexistent contract answer alike) and its row lock (FOR UPDATE: the one serialization point between two confirmations) → the contract
 * decided on the locked record:
 *
 *   - SUPERSEDED: 409 TARGET_STALE; CONFIRMED: 409 PRECONDITION_FAILED TARGET_ALREADY_CONFIRMED naming where it stands, answered
 *     before the version is compared, so the loser of a race is told what became of the contract, not that it is stale;
 *   - a version other than the one read: 409 STALE_VERSION;
 *   - the stored body digest recomputed (BODY_DIGEST_MISMATCH when it is not the stored hash) and the caller bodyHash compared with it in
 *     constant time: a digest that is not this body is 409 STALE_VERSION (mismatch bodyHash), never a confirmation of unseen content;
 *   - the observation judged on the database clock: dated ahead of it OBSERVATION_IN_FUTURE, older than the freshness window
 *     OBSERVATION_NOT_FRESH;
 *   - the evidence a CONFIRMATION_EVIDENCE artifact of this contract project (UNKNOWN_REFERENCE);
 *   - otherwise the DRAFT to CONFIRMED edge: the confirmation instant stamped by the database, the confirming membership and the evidence
 *     recorded, the version + 1 and the body untouched → journal 200 with the contract.
 */
import type { ArtifactRef, TargetContractId } from "@kauro/domain";
import { DomainFailure, StaleVersionFailure, TARGET_OBSERVATION_FRESHNESS_SECONDS, targetBodyDigest } from "@kauro/domain";
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

          // the observation judged on the database clock
          const nowMs = Date.parse(await uow.serverInstant());
          const observedMs = Date.parse(stored.body.observedAt);
          if (observedMs > nowMs) throw new DomainFailure("PRECONDITION_FAILED", "the observation is dated after the database clock", { reason: "OBSERVATION_IN_FUTURE" });
          if (nowMs - observedMs > TARGET_OBSERVATION_FRESHNESS_SECONDS * 1000) {
            throw new DomainFailure("PRECONDITION_FAILED", "the observation is older than the freshness window", { reason: "OBSERVATION_NOT_FRESH" });
          }

          // what the confirming actor was shown: evidence of this contract own project and agency
          const evidence = await uow.targetContracts.getArtifact(envelope.body.confirmationEvidenceRef as ArtifactRef);
          if (!evidence || evidence.agencyId !== membership.agencyId || evidence.kind !== "CONFIRMATION_EVIDENCE" || evidence.projectId !== contract.projectId) {
            throw new DomainFailure("INVALID_REQUEST", "the confirmation evidence is not visible", { reason: "UNKNOWN_REFERENCE", fields: [{ field: "confirmationEvidenceRef", code: "UNKNOWN_REFERENCE" }] });
          }

          const confirmed = applied(
            await uow.targetContracts.confirm(contractId, envelope.body.expectedVersion, { membershipId: membership.membershipId, evidenceRef: evidence.artifactRef }),
          );
          return {
            status: 200 as const,
            view: targetContractView(confirmed, stored.body.objects.length, membership.role),
            version: confirmed.version,
            resourceKind: "target_contract",
            resourceId: confirmed.contractId,
          };
        },
        versionAt(),
      ),
  };
}
