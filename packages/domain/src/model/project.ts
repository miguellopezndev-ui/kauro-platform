/**
 * Project identity (07 "Aggregate ownership": Project owns purchased business intent and its revision lineage; SourceRevision
 * owns immutable selected inputs; CMD011 CreateProject: "The client is active; the requested mode is offered and target scope
 * is declared without claiming qualification", effect "Create a project with a draft revision and visible readiness blockers",
 * failure "An unavailable mode returns CAPABILITY_UNAVAILABLE before quoting or charging"; 02 "Service modes": CLEAN needs
 * no live CRM contract, HUBSPOT/SALESFORCE need a declared target; decision D-AGG-1 fixes the states, D-CMD-4 the target rule).
 *
 * B06 creates OPEN projects with their DRAFT revision; the closure and deletion edges are listed (platform machine Project)
 * and guarded by `transition`, their commands arrive with the delivery and lifecycle packages. Readiness blockers are computed
 * by the read model from durable facts (application views), never stored on the record.
 */
import type { UtcInstant } from "@kauro/contracts";
import { type AgencyRecord, type CapabilityRecord, type DatasetRevisionRecord, type EndClientRecord, type MembershipRecord, type ProjectRecord, SERVICE_MODES, type ServiceMode, isOffered } from "./aggregates.js";
import { assertAgencyOpen } from "./agency.js";
import { assertActorInAgency, assertClientActive } from "./end-client.js";
import { DomainFailure, InvalidRequestFailure, NotFoundFailure } from "./errors.js";
import { type AggregateEvent, aggregateEvent, isSafeToken } from "./events.js";
import { assertExternalRef, assertLabel } from "./fields.js";
import type { ProjectId, RevisionId, TargetInstanceRef } from "./ids.js";

export function isServiceMode(value: unknown): value is ServiceMode {
  return typeof value === "string" && (SERVICE_MODES as ReadonlyArray<string>).includes(value);
}

export interface CreateProjectInput {
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly mode: string;
  readonly purpose: string;
  readonly targetInstanceRef?: string;
  readonly now: UtcInstant;
}

export interface CreateProjectContext {
  readonly agency: AgencyRecord;
  readonly client: EndClientRecord;
  readonly actor: MembershipRecord;
  /** The published MODE capability for the requested mode (capabilities.findMode), null when none exists. */
  readonly capability: CapabilityRecord | null;
}

export interface ProjectOutcome {
  readonly project: ProjectRecord;
  readonly revision: DatasetRevisionRecord;
  readonly events: ReadonlyArray<AggregateEvent>;
}

/**
 * Check order (CMD011): actor authority, client visible and ACTIVE, agency open, mode and purpose well-formed, mode offered
 * (before any quote or charge could exist), target declared for CRM modes. The pair project + draft revision is one outcome;
 * the persistence adapter inserts both under the deferred foreign key so a project never exists without its revision.
 */
export function createProject(input: CreateProjectInput, ctx: CreateProjectContext): ProjectOutcome {
  const { agency, client, actor } = ctx;
  assertActorInAgency(actor, agency, "CMD011");
  if (client.agencyId !== agency.agencyId) throw new NotFoundFailure("client", "CROSS_AGENCY");
  assertClientActive(client);
  assertAgencyOpen(agency);
  if (typeof input.mode !== "string") throw new InvalidRequestFailure([{ field: "mode", code: "TYPE" }]);
  if (!isServiceMode(input.mode)) throw new InvalidRequestFailure([{ field: "mode", code: "ENUM" }]);
  const mode = input.mode;
  const purpose = assertLabel("purpose", input.purpose);
  const capability = ctx.capability;
  if (capability === null || !isOffered(capability)) {
    throw new DomainFailure("CAPABILITY_UNAVAILABLE", `mode ${mode} has no offered capability`, { reason: "MODE_NOT_OFFERED" });
  }
  if (capability.kind !== "MODE" || capability.mode !== mode) {
    throw new DomainFailure("CAPABILITY_UNAVAILABLE", `capability ${capability.capabilityId} is not the MODE capability of ${mode}`, { reason: "CAPABILITY_MODE_MISMATCH" });
  }
  // The capability version is snapshotted on the project and carried in the event: it is a platform-published token
  // (control plane), never customer text; anything else is a publication defect, not a request error.
  if (!isSafeToken(capability.version)) throw new DomainFailure("INTEGRITY_FAILURE", `capability ${capability.capabilityId} has a version that is not a safe token`);
  let targetInstanceRef: TargetInstanceRef | undefined;
  if (mode !== "CLEAN") {
    if (input.targetInstanceRef === undefined) throw new InvalidRequestFailure([{ field: "targetInstanceRef", code: "REQUIRED" }], "TARGET_INSTANCE_REQUIRED");
    targetInstanceRef = assertExternalRef("targetInstanceRef", input.targetInstanceRef) as TargetInstanceRef;
  } else if (input.targetInstanceRef !== undefined) {
    targetInstanceRef = assertExternalRef("targetInstanceRef", input.targetInstanceRef) as TargetInstanceRef;
  }

  const project: ProjectRecord = Object.freeze({
    projectId: input.projectId,
    agencyId: agency.agencyId,
    clientId: client.clientId,
    version: 1,
    state: "OPEN",
    mode,
    purpose,
    ...(targetInstanceRef !== undefined ? { targetInstanceRef } : {}),
    capabilityId: capability.capabilityId,
    capabilityVersion: capability.version,
    currentRevisionId: input.revisionId,
    createdByMembershipId: actor.membershipId,
    createdAt: input.now,
    updatedAt: input.now,
  });
  const revision: DatasetRevisionRecord = Object.freeze({
    revisionId: input.revisionId,
    agencyId: agency.agencyId,
    projectId: project.projectId,
    scope: { agencyId: agency.agencyId, clientId: client.clientId, projectId: project.projectId },
    version: 1,
    state: "DRAFT",
    createdAt: input.now,
    updatedAt: input.now,
  });
  return {
    project,
    revision,
    events: [
      aggregateEvent({
        aggregateKind: "project",
        aggregateId: project.projectId,
        aggregateVersion: 1,
        agencyId: project.agencyId,
        eventType: "project.created.v1",
        payload: {
          projectId: project.projectId,
          agencyId: project.agencyId,
          clientId: project.clientId,
          mode,
          capabilityId: capability.capabilityId,
          capabilityVersion: capability.version,
          initialRevisionId: revision.revisionId,
          createdByMembershipId: actor.membershipId,
        },
      }),
      aggregateEvent({
        aggregateKind: "dataset_revision",
        aggregateId: revision.revisionId,
        aggregateVersion: 1,
        agencyId: revision.agencyId,
        eventType: "dataset_revision.created.v1",
        payload: { revisionId: revision.revisionId, agencyId: revision.agencyId, projectId: project.projectId, state: revision.state },
      }),
    ],
  };
}
