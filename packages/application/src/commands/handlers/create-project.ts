/**
 * CMD011 CreateProject — POST /api/v1/clients/{clientId}/projects — AGENCY_OPERATOR (design §8, D-CMD-4; 10 "POST /clients/
 * {clientId}/projects records mode, purpose and target reference"; catalogue precondition "The client is active; the requested
 * mode is offered and target scope is declared without claiming qualification"; failure "An unavailable mode returns
 * CAPABILITY_UNAVAILABLE before quoting or charging").
 *
 * Order: authorize → reserve → share-lock the agency, lock the client (NOT_FOUND / CLIENT_ARCHIVED) → agency DRAFT or ACTIVE
 * (AGENCY_NOT_OPEN) → mode capability offered, read under a share lock (AVAILABLE_LIMITED or AVAILABLE, else
 * CAPABILITY_UNAVAILABLE / MODE_NOT_OFFERED — no quote, no charge exists yet) → CRM modes declare a targetInstanceRef
 * (INVALID_REQUEST / TARGET_INSTANCE_REQUIRED; the declaration claims no qualification) → INSERT project (OPEN v1, capability id + version snapshot) with its DRAFT revision (deferred FK pair) →
 * project.created.v1 + dataset_revision.created.v1 → journal 201 ProjectView with readiness blockers computed from facts.
 *
 * Locks (07 "Transaction discipline": preconditions are rechecked inside the transaction; multi-row invariants use explicit
 * locking): the agency (FOR SHARE), the client (FOR UPDATE) and the capability (FOR SHARE) are held to COMMIT, in that order
 * (parent before child; the platform-wide capability last). A concurrent agency transition (RESTRICTED, CLOSING) or capability
 * suspension either waits until this project committed or committed first and is refused here: a project is never admitted
 * on an agency or a capability that stopped admitting new work while the command was in flight. Share locks keep concurrent
 * project creations of one agency (or one mode, across agencies) from serializing on each other.
 */
import type { ClientId, ProjectId, RevisionId, TargetInstanceRef } from "@kauro/domain";
import { AGENCY_OPEN_STATES, DomainFailure, isOffered } from "@kauro/domain";
import { projectActions } from "../../api/permitted-actions.js";
import { projectView, readinessBlockersOf } from "../../api/projections.js";
import type { ProjectView } from "../../api/views.js";
import { CREATE_PROJECT, type CreateProjectBody, type CreateProjectHandler } from "../contracts.js";
import { runCommand, type CommandRuntime } from "../runtime.js";
import { requireMembership } from "./shared.js";

export function createProjectHandler(runtime: CommandRuntime): CreateProjectHandler {
  return {
    spec: CREATE_PROJECT,
    execute: (envelope) =>
      runCommand<CreateProjectBody, ProjectView>(CREATE_PROJECT, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const clientId = envelope.path["clientId"] as ClientId;
        const agency = await uow.agencies.lockShared(membership.agencyId);
        const client = await uow.endClients.lock(clientId);
        if (!client || client.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "client not visible");
        if (client.state !== "ACTIVE") {
          throw new DomainFailure("PRECONDITION_FAILED", "client is archived", { reason: "CLIENT_ARCHIVED", currentState: client.state, currentVersion: client.version });
        }
        if (!agency) throw new DomainFailure("NOT_FOUND", "agency not visible");
        if (!AGENCY_OPEN_STATES.has(agency.state)) {
          throw new DomainFailure("PRECONDITION_FAILED", "agency does not accept new projects", { reason: "AGENCY_NOT_OPEN", currentState: agency.state, currentVersion: agency.version });
        }
        const capability = await uow.capabilities.lockMode(envelope.body.mode);
        if (!capability || !isOffered(capability)) {
          throw new DomainFailure("CAPABILITY_UNAVAILABLE", "requested mode is not offered", { reason: "MODE_NOT_OFFERED" });
        }
        const targetInstanceRef = envelope.body.targetInstanceRef as TargetInstanceRef | undefined;
        if (envelope.body.mode !== "CLEAN" && targetInstanceRef === undefined) {
          throw new DomainFailure("INVALID_REQUEST", "CRM modes declare a target instance", { reason: "TARGET_INSTANCE_REQUIRED", fields: [{ field: "targetInstanceRef", code: "REQUIRED" }] });
        }
        const projectId = uow.ids.next() as ProjectId;
        const revisionId = uow.ids.next() as RevisionId;
        const { project, revision } = await uow.projects.insertWithDraftRevision({
          projectId,
          agencyId: membership.agencyId,
          clientId,
          mode: envelope.body.mode,
          purpose: envelope.body.purpose,
          ...(targetInstanceRef !== undefined ? { targetInstanceRef } : {}),
          capabilityId: capability.capabilityId,
          capabilityVersion: capability.version,
          initialRevisionId: revisionId,
          createdByMembershipId: membership.membershipId,
          createdAt: ctx.now,
        });
        const actor = { kind: "USER", userId: envelope.userId } as const;
        await uow.events.publish({
          aggregateKind: "project",
          aggregateId: projectId,
          aggregateVersion: project.version,
          agencyId: membership.agencyId,
          eventType: "project.created.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: {
            projectId,
            agencyId: membership.agencyId,
            clientId,
            mode: project.mode,
            capabilityId: capability.capabilityId,
            capabilityVersion: capability.version,
            initialRevisionId: revisionId,
            createdByMembershipId: membership.membershipId,
          },
        });
        await uow.events.publish({
          aggregateKind: "dataset_revision",
          aggregateId: revisionId,
          aggregateVersion: revision.version,
          agencyId: membership.agencyId,
          eventType: "dataset_revision.created.v1",
          actor,
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          payload: { revisionId, agencyId: membership.agencyId, projectId, state: revision.state },
        });
        const blockers = readinessBlockersOf({ agency, capability, currentRevision: revision, targetContract: null, plan: null });
        return { status: 201, view: projectView(project, revision, blockers, projectActions()), version: project.version, resourceKind: "project", resourceId: projectId };
      }),
  };
}
