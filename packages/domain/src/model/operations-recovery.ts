/**
 * Operations and recovery (package B16/B18; registry commands CMD056 RecordIncident and CMD057 AuthorizeRecovery, gate G-RECOVERY; and the
 * operations service principal of CMD056 and CMD059 RestrictCapability, role OPERATIONS_SERVICE_OR_OWNER).
 *
 * An incident is recorded from evidence of an ACTUAL event with a safe affected scope, or recorded as the FALSE_POSITIVE it is (registry
 * failure: "A monitoring false positive is recorded as such; it cannot be fabricated as a resolved production outage"): an actual incident
 * is born DETECTED (containment, restoration and customer communication are separately evidenced later: registry Incident invariant) with
 * its three responsibilities and the next accountable checkpoint stamped by the database; a false positive is born CLOSED with none, and no
 * command here ever moves an incident to RECOVERING, MONITORING or a resolved CLOSED.
 *
 * A recovery is authorized over a restore candidate the platform PREPARED (plan, costs, side effects, deletion tombstones and financial
 * reconciliation are the preparer's): the owner names the candidate and the deletion journal hash the restore must honour; a candidate
 * authorizes once, and only when the owner's hash is the candidate's own, so a restore can neither run twice nor resurrect deleted rows.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { VersionedWrite } from "../ports/repositories.js";
import type { IncidentId, RecoveryId, RestoreCandidateId, UserId } from "./ids.js";

/** Who acted: a corporate person (the owner) or the operations service. */
export type OperationsActor = { readonly kind: "USER"; readonly userId: UserId } | { readonly kind: "SERVICE"; readonly serviceId: string };

/** Reasons of CMD057 (appended to the closed FAILURE_REASONS of model/errors.ts). */
export const RECOVERY_FAILURE_REASONS = [
  // the candidate is not PREPARED (it was already authorized): a restore authorizes once
  "RECOVERY_CANDIDATE_NOT_PREPARED",
  // the deletion journal hash is not the candidate's own: a restore could resurrect rows the journal deleted
  "RECOVERY_DELETION_JOURNAL_MISMATCH",
] as const;
export type RecoveryFailureReason = (typeof RECOVERY_FAILURE_REASONS)[number];

export const INCIDENT_SEVERITIES = ["S1", "S2", "S3", "S4"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
/** What CMD056 accepts as the severity label: an actual severity or the recorded false positive. */
export const INCIDENT_INTAKE_SEVERITIES = [...INCIDENT_SEVERITIES, "FALSE_POSITIVE"] as const;
export type IncidentIntakeSeverity = (typeof INCIDENT_INTAKE_SEVERITIES)[number];

/** Hours from the database's instant to the first accountable checkpoint of an actual incident. */
export const INCIDENT_CHECKPOINT_HOURS: Readonly<Record<IncidentSeverity, number>> = Object.freeze({ S1: 1, S2: 4, S3: 24, S4: 72 });
/** The severities whose customer communication needs the owner's review (a claim of sending is never automatic). */
export const COMMUNICATION_REVIEW_SEVERITIES: ReadonlySet<IncidentSeverity> = new Set<IncidentSeverity>(["S1", "S2"]);

export const INCIDENT_RESPONSIBILITIES = ["CONTAINMENT", "RECOVERY", "COMMUNICATION"] as const;
export type IncidentResponsibility = (typeof INCIDENT_RESPONSIBILITIES)[number];

export interface IncidentRecord {
  readonly incidentId: IncidentId;
  readonly kind: "ACTUAL" | "FALSE_POSITIVE";
  /** Null for a false positive. */
  readonly severity: IncidentSeverity | null;
  readonly state: "DETECTED" | "CLOSED";
  readonly affectedScopes: ReadonlyArray<string>;
  readonly communicationState: "NOT_REQUIRED" | "REVIEW_REQUIRED";
  /** The responsibilities opened with the incident (empty for a false positive). */
  readonly responsibilities: ReadonlyArray<IncidentResponsibility>;
  readonly startedAt: UtcInstant;
  readonly reviewAt: UtcInstant;
}

export type RestoreCandidateRecord = {
  readonly candidateId: RestoreCandidateId;
  readonly state: "PREPARED" | "AUTHORIZED";
  readonly deletionJournalHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly revision: number;
};

export interface RecoveryRecord {
  readonly recoveryId: RecoveryId;
  readonly candidateId: RestoreCandidateId;
  readonly deletionJournalHash: Sha256Hex;
  readonly authorizationRef: string;
  readonly authorizedAt: UtcInstant;
  readonly candidateRevision: number;
}

export interface OperationsRepository {
  /** Records an incident with the responsibilities and checkpoint the severity implies (the database stamps every instant). */
  recordIncident(input: {
    readonly incidentId: IncidentId;
    readonly severity: IncidentIntakeSeverity;
    readonly affectedScopes: ReadonlyArray<string>;
    readonly summary: string;
    readonly by: OperationsActor;
  }): Promise<IncidentRecord>;
  /** The restore candidate FOR UPDATE (held to COMMIT); null when it does not exist. The owner's request session only. */
  lockCandidate(candidateId: RestoreCandidateId): Promise<RestoreCandidateRecord | null>;
  /** PREPARED -> AUTHORIZED with the recovery record; STALE when the candidate moved under the lock the caller holds (never expected). */
  authorizeRecovery(input: {
    readonly recoveryId: RecoveryId;
    readonly candidate: RestoreCandidateRecord;
    readonly authorizationRef: string;
    readonly by: UserId;
  }): Promise<VersionedWrite<RecoveryRecord>>;
}
