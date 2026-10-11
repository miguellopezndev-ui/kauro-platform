/**
 * CMD018 CreateTargetContract — POST /api/v1/projects/{projectId}/target-contracts — AGENCY_OPERATOR (registry command CMD018, gate
 * G-VENDOR; "Validate metadata, scope and observed facts and create an immutable draft target version"; failure "Reject mismatched
 * CRM/object/instance and unknown fields; caller cannot set verified=true").
 *
 * Order: authorize → reserve → the project (NOT_FOUND; a foreign and a nonexistent project answer alike) and its row lock → the metadata
 * artifact (UNKNOWN_REFERENCE unless it is a METADATA artifact of this agency) → its scope (TARGET_SCOPE_MISMATCH unless it is this
 * project's, of the project's CRM mode and declared target instance, and of the instance of the project's earlier contract) → the
 * metadata as data (TARGET_METADATA_INVALID: the closed shape, no verified flag, no unknown member) → the observation not ahead of the
 * database clock (OBSERVATION_IN_FUTURE) → one DRAFT contract at version 1 whose body digest the repository derives from the stored
 * values (TARGET_CONTRACT_EXISTS when the project already holds this exact body) → journal 201 with the contract.
 *
 * The caller names the artifact and the importer profile only: the mode, the instance, the metadata, the observation and the authority
 * evidence are the artifact's and the project's, so no request can assert a fact about the target.
 */
import type { ArtifactRef, ProjectId, TargetContractId } from "@kauro/domain";
import { DomainFailure, isUtcInstant, parseTargetMetadata } from "@kauro/domain";
import { requireMembership } from "../../commands/handlers/shared.js";
import { CREATE_TARGET_CONTRACT, type CreateTargetContractBody, type CreateTargetContractHandler } from "../contracts.js";
import type { TargetContractView } from "../views.js";
import { targetContractView } from "./projections.js";
import { runAuditCommand, versionAt, type AuditRuntime } from "./shared.js";

export function createTargetContractHandler(runtime: AuditRuntime): CreateTargetContractHandler {
  return {
    spec: CREATE_TARGET_CONTRACT,
    execute: (envelope) =>
      runAuditCommand<CreateTargetContractBody, TargetContractView>(
        CREATE_TARGET_CONTRACT,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const projectId = envelope.path["projectId"] as ProjectId;

          const found = await uow.projects.get(projectId);
          if (!found || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "project not visible");
          const project = await uow.projects.lock(projectId);
          if (!project) throw new DomainFailure("NOT_FOUND", "project not visible");

          const artifact = await uow.targetContracts.getArtifact(envelope.body.metadataArtifactRef as ArtifactRef);
          if (!artifact || artifact.agencyId !== membership.agencyId || artifact.kind !== "METADATA") {
            throw new DomainFailure("INVALID_REQUEST", "the metadata artifact is not visible", { reason: "UNKNOWN_REFERENCE", fields: [{ field: "metadataArtifactRef", code: "UNKNOWN_REFERENCE" }] });
          }

          // the artifact scope is the project scope: its project, its CRM mode, the instance the project declared and the instance of the earlier contract
          const latest = await uow.targetContracts.findLatestForProject(projectId);
          if (
            artifact.projectId !== projectId ||
            artifact.mode !== project.mode ||
            (project.targetInstanceRef !== undefined && artifact.instanceId !== project.targetInstanceRef) ||
            (latest !== null && latest.instanceId !== artifact.instanceId)
          ) {
            throw new DomainFailure("PRECONDITION_FAILED", "the metadata artifact is not of this project target", { reason: "TARGET_SCOPE_MISMATCH" });
          }

          // the metadata is data: the closed shape or nothing
          const metadata = parseTargetMetadata(artifact.document);
          if (metadata === null) throw new DomainFailure("INVALID_REQUEST", "the metadata is not the closed target metadata shape", { reason: "TARGET_METADATA_INVALID" });
          const now = await uow.serverInstant();
          if (!isUtcInstant(metadata.observedAt) || Date.parse(metadata.observedAt) > Date.parse(now)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the observation is dated after the database clock", { reason: "OBSERVATION_IN_FUTURE" });
          }

          const created = await uow.targetContracts.createDraft({
            contractId: uow.ids.next() as TargetContractId,
            agencyId: membership.agencyId,
            projectId,
            artifactRef: artifact.artifactRef,
            body: {
              mode: artifact.mode,
              instanceId: artifact.instanceId,
              importerProfileId: envelope.body.importerProfileId,
              importerVersion: metadata.importerVersion,
              objects: metadata.objects,
              observedAt: metadata.observedAt,
              authorityEvidenceHash: artifact.contentHash,
              capabilityVersion: metadata.capabilityVersion,
            },
          });
          if (created === null) throw new DomainFailure("PRECONDITION_FAILED", "the project already holds this observed target body", { reason: "TARGET_CONTRACT_EXISTS" });
          return {
            status: 201 as const,
            view: targetContractView(created, metadata.objects.length, membership.role),
            version: created.version,
            resourceKind: "target_contract",
            resourceId: created.contractId,
          };
        },
        versionAt(),
      ),
  };
}
