/**
 * Agency aggregate (07 "Aggregate ownership": Agency owns the tenant's legal and commercial identity, active state and policy
 * acceptance; 07 "Agency and membership states": DRAFT permits identity and agreement setup but not customer-data execution,
 * ACTIVE permits capabilities subject to their own gates, RESTRICTED can block new purchases or data operations, CLOSING
 * revokes new work, CLOSED retains only allowed residual records; registry machine Agency, reference/TRANSITIONS "Agency").
 *
 * Every operation is pure: it takes the current record, checks the expected version (10 "Concurrency and preconditions"),
 * asks the registry machine for the listed edge (an unlisted edge is PRECONDITION_FAILED / UNLISTED_TRANSITION), applies the
 * guard the edge names, and yields the record at version + 1 with the event of that version (07 "Transaction discipline":
 * state, event and outbox commit atomically — the handler publishes the event inside the same unit of work).
 */
import type { Agency, UtcInstant } from "@kauro/contracts";
import { AGENCY_OPEN_STATES, type AgencyRecord } from "./aggregates.js";
import { PreconditionFailure } from "./errors.js";
import { type AggregateEvent, aggregateEvent } from "./events.js";
import { assertAggregateId, assertLabel } from "./fields.js";
import type { AgencyId, UserId } from "./ids.js";
import { transition } from "./state-machines.js";
import { assertExpectedVersion, nextVersion } from "./versioning.js";

export type AgencyState = Agency["state"];

/** States in which the closure procedure is the explicit authority that lets the last owner leave (07). */
export const AGENCY_CLOSURE_STATES: ReadonlySet<AgencyState> = new Set<AgencyState>(["CLOSING", "CLOSED"]);

export interface AgencyOutcome {
  readonly agency: AgencyRecord;
  readonly event: AggregateEvent;
}

export interface CreateAgencyInput {
  readonly agencyId: AgencyId;
  readonly displayName: string;
  readonly createdByUserId: UserId;
  readonly now: UtcInstant;
}

/**
 * CMD001 effect: one DRAFT agency at version 1. Nothing else is activated (registry effect: "do not activate contracts or
 * billing automatically"); the owner membership is a Membership operation the handler performs in the same transaction.
 * The display name is a safe label, "not a unique legal identity" (contract Agency): two agencies may share it.
 */
export function createAgency(input: CreateAgencyInput): AgencyOutcome {
  const displayName = assertLabel("displayName", input.displayName);
  const agency: AgencyRecord = Object.freeze({
    agencyId: input.agencyId,
    version: 1,
    displayName,
    state: "DRAFT",
    createdByUserId: input.createdByUserId,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return {
    agency,
    event: aggregateEvent({
      aggregateKind: "agency",
      aggregateId: agency.agencyId,
      aggregateVersion: 1,
      agencyId: agency.agencyId,
      eventType: "agency.created.v1",
      payload: { agencyId: agency.agencyId, createdByUserId: agency.createdByUserId, state: agency.state },
    }),
  };
}

export interface ActivateAgencyInput {
  readonly expectedVersion: number;
  readonly termsVersion: string;
  readonly privacyAgreementVersion: string;
  readonly legalProfileRef: string;
  /** The agreement versions the launch policy currently requires; an older acceptance is not "present" (edge guard). */
  readonly required: { readonly termsVersion: string; readonly privacyAgreementVersion: string };
  readonly now: UtcInstant;
}

/**
 * Edge DRAFT -> ACTIVE (agreements_and_profile_accepted). Guard: "Verified owner, legal/billing profile and required agreement
 * versions are present" — the owner and step-up are the authorizer's; the profile and agreement versions are checked here.
 * Effect: "activation does not create payment or import authority" — the record gains no capability.
 */
export function activateAgency(agency: AgencyRecord, input: ActivateAgencyInput): AgencyOutcome {
  assertExpectedVersion(agency, input.expectedVersion);
  const to = transition("Agency", agency.state, "agreements_and_profile_accepted") as AgencyState;
  const termsVersion = assertLabel("termsVersion", input.termsVersion);
  const privacyAgreementVersion = assertLabel("privacyAgreementVersion", input.privacyAgreementVersion);
  const legalProfileRef = assertAggregateId("legalProfileRef", input.legalProfileRef);
  if (termsVersion !== input.required.termsVersion || privacyAgreementVersion !== input.required.privacyAgreementVersion) {
    throw new PreconditionFailure("AGREEMENTS_INCOMPLETE", `agency ${agency.agencyId}: accepted agreement versions are not the required ones`, { currentState: agency.state });
  }
  const next: AgencyRecord = Object.freeze({ ...agency, state: to, version: nextVersion(agency), termsVersion, privacyAgreementVersion, legalProfileRef, updatedAt: input.now });
  return { agency: next, event: lifecycleEvent(next, "agency.activated.v1", {}) };
}

/** Edge ACTIVE -> RESTRICTED (material_risk_or_account_failure). Guard: a documented incident justifies the restriction. */
export function restrictAgency(agency: AgencyRecord, input: { readonly expectedVersion: number; readonly incidentId: string; readonly now: UtcInstant }): AgencyOutcome {
  assertExpectedVersion(agency, input.expectedVersion);
  const to = transition("Agency", agency.state, "material_risk_or_account_failure") as AgencyState;
  const incidentId = assertAggregateId("incidentId", input.incidentId);
  const next: AgencyRecord = Object.freeze({ ...agency, state: to, version: nextVersion(agency), updatedAt: input.now });
  return { agency: next, event: lifecycleEvent(next, "agency.restricted.v1", { incidentId }) };
}

/** Edge RESTRICTED -> ACTIVE (restriction_remedied). Effect: "old invalid approvals remain invalid" — nothing is restored here. */
export function remedyRestriction(agency: AgencyRecord, input: { readonly expectedVersion: number; readonly incidentId: string; readonly now: UtcInstant }): AgencyOutcome {
  assertExpectedVersion(agency, input.expectedVersion);
  const to = transition("Agency", agency.state, "restriction_remedied") as AgencyState;
  const incidentId = assertAggregateId("incidentId", input.incidentId);
  const next: AgencyRecord = Object.freeze({ ...agency, state: to, version: nextVersion(agency), updatedAt: input.now });
  return { agency: next, event: lifecycleEvent(next, "agency.restriction_remedied.v1", { incidentId }) };
}

/** Edges ACTIVE/RESTRICTED -> CLOSING (owner_requests_closure): stop new work and revoke new access grants (CMD043). */
export function requestClosure(agency: AgencyRecord, input: { readonly expectedVersion: number; readonly now: UtcInstant }): AgencyOutcome {
  assertExpectedVersion(agency, input.expectedVersion);
  const to = transition("Agency", agency.state, "owner_requests_closure") as AgencyState;
  const next: AgencyRecord = Object.freeze({ ...agency, state: to, version: nextVersion(agency), updatedAt: input.now });
  return { agency: next, event: lifecycleEvent(next, "agency.closing.v1", {}) };
}

/** Edge DRAFT -> CLOSING (owner_abandons_setup): no customer charge exists; setup data is deleted under its policy. */
export function abandonSetup(agency: AgencyRecord, input: { readonly expectedVersion: number; readonly now: UtcInstant }): AgencyOutcome {
  assertExpectedVersion(agency, input.expectedVersion);
  const to = transition("Agency", agency.state, "owner_abandons_setup") as AgencyState;
  const next: AgencyRecord = Object.freeze({ ...agency, state: to, version: nextVersion(agency), updatedAt: input.now });
  return { agency: next, event: lifecycleEvent(next, "agency.closing.v1", {}) };
}

/** Edge CLOSING -> CLOSED (closure_obligations_completed): the control plane records that every residual class is accounted for. */
export function completeClosure(agency: AgencyRecord, input: { readonly expectedVersion: number; readonly now: UtcInstant }): AgencyOutcome {
  assertExpectedVersion(agency, input.expectedVersion);
  const to = transition("Agency", agency.state, "closure_obligations_completed") as AgencyState;
  const next: AgencyRecord = Object.freeze({ ...agency, state: to, version: nextVersion(agency), updatedAt: input.now });
  return { agency: next, event: lifecycleEvent(next, "agency.closed.v1", {}) };
}

/** Setup work (clients, projects, invitations) is permitted while DRAFT or ACTIVE (decision D-CMD-2). */
export function isAgencyOpen(agency: Pick<AgencyRecord, "state">): boolean {
  return AGENCY_OPEN_STATES.has(agency.state);
}

export function assertAgencyOpen(agency: AgencyRecord): AgencyRecord {
  if (!isAgencyOpen(agency)) throw new PreconditionFailure("AGENCY_NOT_OPEN", `agency ${agency.agencyId} is ${agency.state}`, { currentState: agency.state, currentVersion: agency.version });
  return agency;
}

/** Customer-data execution (uploads, jobs, later packages) requires ACTIVE (07: DRAFT permits setup only). */
export function assertAgencyActive(agency: AgencyRecord): AgencyRecord {
  if (agency.state !== "ACTIVE") throw new PreconditionFailure("AGENCY_NOT_ACTIVE", `agency ${agency.agencyId} is ${agency.state}`, { currentState: agency.state, currentVersion: agency.version });
  return agency;
}

/** True when the closure procedure is the explicit authority under which the last owner may leave (07, R2-043). */
export function isUnderClosureAuthority(agency: Pick<AgencyRecord, "state">): boolean {
  return AGENCY_CLOSURE_STATES.has(agency.state);
}

function lifecycleEvent(agency: AgencyRecord, eventType: AggregateEvent["eventType"], extra: Readonly<Record<string, string>>): AggregateEvent {
  return aggregateEvent({
    aggregateKind: "agency",
    aggregateId: agency.agencyId,
    aggregateVersion: agency.version,
    agencyId: agency.agencyId,
    eventType,
    payload: { agencyId: agency.agencyId, ...extra },
  });
}
