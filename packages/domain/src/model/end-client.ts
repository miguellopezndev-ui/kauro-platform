/**
 * EndClient aggregate (07 "Aggregate ownership": ClientWorkspace owns a scoped end-client label and purpose, without creating a
 * global CRM identity; contract EndClient: "Client labels are presentation; legal and data boundaries remain explicit";
 * CMD009 CreateClient, CMD010 ArchiveClient; 10 "Client and project routes": archiving a client stops new projects but does
 * not delete active paid work implicitly).
 *
 * The record carries a version the registry contract lacks (decision D-AGG-2) because CMD010 names expectedVersion; the only
 * listed edge is ACTIVE -> ARCHIVED (platform machine EndClient). Labels are never merged or made unique: two clients with the
 * same display name are two workspaces with distinct ids (CMD009 failure clause).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyRecord, EndClientRecord, MembershipRecord, ProcessingAuthorityRecord } from "./aggregates.js";
import { assertAgencyOpen } from "./agency.js";
import { InvalidRequestFailure, NotAuthorizedFailure, NotFoundFailure, PreconditionFailure } from "./errors.js";
import { type AggregateEvent, aggregateEvent } from "./events.js";
import { assertLabel } from "./fields.js";
import type { ClientId, MembershipId, ProcessingAuthorityId } from "./ids.js";
import { commandRole, roleSatisfies } from "./roles.js";
import { transition } from "./state-machines.js";
import { assertExpectedVersion, nextVersion } from "./versioning.js";

export interface EndClientOutcome {
  readonly client: EndClientRecord;
  readonly event: AggregateEvent;
}

export interface CreateEndClientInput {
  readonly clientId: ClientId;
  readonly displayName: string;
  readonly processingAuthorityRef: ProcessingAuthorityId;
  readonly now: UtcInstant;
}

export interface CreateEndClientContext {
  readonly agency: AgencyRecord;
  readonly actor: MembershipRecord;
  /**
   * The processing authority CMD009 recorded — or found recorded by this agency — for the reference the caller named (null
   * when another agency recorded that reference: foreign references reject; decision D-CLIENT-1).
   */
  readonly processingAuthority: ProcessingAuthorityRecord | null;
}

/**
 * CMD009 effect: one scoped workspace with stable identity separate from its display name, recording the end-client
 * processing authority. A foreign authority reference is INVALID_REQUEST / UNKNOWN_REFERENCE (the composite foreign key
 * (agency_id, processing_authority_ref) is the second line of defence, 08 "Database isolation").
 */
export function createEndClient(input: CreateEndClientInput, ctx: CreateEndClientContext): EndClientOutcome {
  const { agency, actor } = ctx;
  assertActorInAgency(actor, agency, "CMD009");
  assertAgencyOpen(agency);
  const displayName = assertLabel("displayName", input.displayName);
  const authority = ctx.processingAuthority;
  if (authority === null || authority.agencyId !== agency.agencyId || authority.processingAuthorityId !== input.processingAuthorityRef) {
    throw new InvalidRequestFailure([{ field: "processingAuthorityRef", code: "UNKNOWN_REFERENCE" }], "UNKNOWN_REFERENCE");
  }
  const client: EndClientRecord = Object.freeze({
    clientId: input.clientId,
    agencyId: agency.agencyId,
    displayName,
    state: "ACTIVE",
    processingAuthorityRef: authority.processingAuthorityId,
    version: 1,
    createdByMembershipId: actor.membershipId,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return {
    client,
    event: aggregateEvent({
      aggregateKind: "end_client",
      aggregateId: client.clientId,
      aggregateVersion: 1,
      agencyId: client.agencyId,
      eventType: "end_client.created.v1",
      payload: { clientId: client.clientId, agencyId: client.agencyId, processingAuthorityRef: client.processingAuthorityRef, createdByMembershipId: actor.membershipId },
    }),
  };
}

export interface ArchiveEndClientInput {
  readonly client: EndClientRecord;
  readonly expectedVersion: number;
  readonly actor: MembershipRecord;
  readonly agency: AgencyRecord;
  /** Open projects retained under their own policies (ActiveWorkInspector; decision D-CMD-3: reported, never deleted). */
  readonly openProjects: number;
  readonly now: UtcInstant;
}

/**
 * CMD010: edge ACTIVE -> ARCHIVED. Effect: stop new project creation while retaining active work and lawful history; failure
 * clause: "Archiving cannot become an implicit deletion or refund" — the outcome touches the client record only.
 */
export function archiveEndClient(input: ArchiveEndClientInput): EndClientOutcome {
  const { client, actor, agency } = input;
  if (client.agencyId !== agency.agencyId) throw new NotFoundFailure("client", "CROSS_AGENCY");
  assertActorInAgency(actor, agency, "CMD010");
  assertExpectedVersion(client, input.expectedVersion);
  if (client.state === "ARCHIVED") throw new PreconditionFailure("CLIENT_ARCHIVED", `client ${client.clientId} is already archived`, { currentState: client.state, currentVersion: client.version });
  const to = transition("EndClient", client.state, "archive_client") as EndClientRecord["state"];
  if (!Number.isSafeInteger(input.openProjects) || input.openProjects < 0) throw new RangeError("openProjects must be a non-negative integer");
  const next: EndClientRecord = Object.freeze({ ...client, state: to, version: nextVersion(client), archivedAt: input.now, updatedAt: input.now });
  return {
    client: next,
    event: aggregateEvent({
      aggregateKind: "end_client",
      aggregateId: next.clientId,
      aggregateVersion: next.version,
      agencyId: next.agencyId,
      eventType: "end_client.archived.v1",
      payload: { clientId: next.clientId, agencyId: next.agencyId, openProjects: input.openProjects, archivedByMembershipId: actor.membershipId },
    }),
  };
}

/** New projects require an ACTIVE client (CMD011 precondition; CMD010 effect). */
export function assertClientActive(client: EndClientRecord): EndClientRecord {
  if (client.state !== "ACTIVE") throw new PreconditionFailure("CLIENT_ARCHIVED", `client ${client.clientId} is ${client.state}`, { currentState: client.state, currentVersion: client.version });
  return client;
}

/** The actor is an ACTIVE member of this agency whose role satisfies the command role of `command` (08 default deny). */
export function assertActorInAgency(actor: MembershipRecord, agency: Pick<AgencyRecord, "agencyId">, command: "CMD009" | "CMD010" | "CMD011"): MembershipId {
  if (actor.agencyId !== agency.agencyId) throw new NotFoundFailure("agency", "NOT_A_MEMBER");
  if (actor.state === "SUSPENDED") throw new NotAuthorizedFailure("MEMBERSHIP_SUSPENDED", `membership ${actor.membershipId} is suspended`);
  if (actor.state !== "ACTIVE") throw new NotAuthorizedFailure("MEMBERSHIP_NOT_ACTIVE", `membership ${actor.membershipId} is ${actor.state}`);
  const role = commandRole(command);
  if (!roleSatisfies(role, actor.role)) throw new NotAuthorizedFailure("ROLE_INSUFFICIENT", `membership ${actor.membershipId} (${actor.role}) does not satisfy ${role}`);
  return actor.membershipId;
}
