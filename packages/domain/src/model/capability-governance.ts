/**
 * Capability governance (package B18; registry commands CMD058 ChangeCapability and CMD059 RestrictCapability, gate G-RELEASE):
 * the PROSPECTIVE version a change records, the restriction a restrict records, the states each command admits and its reasons.
 *
 * A version never promotes: the capability's own state moves only through the listed Capability edges with their gates' evidence,
 * and CMD058 is allowed only over a capability whose acceptance is already independent (QUALIFIED_INTERNAL or beyond, or SUSPENDED
 * where a new version is how sale eligibility is restored). A restriction closes admission of new work and never edits a project:
 * a project keeps the capability version it was created under (an immutable column), so a paid project's scope cannot change.
 */
import type { Capability, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { VersionedWrite } from "../ports/repositories.js";
import type { CapabilityId, UserId } from "./ids.js";
import type { OperationsActor } from "./operations-recovery.js";

/** Reasons of CMD058 and CMD059 (appended to the closed FAILURE_REASONS of model/errors.ts). */
export const CAPABILITY_FAILURE_REASONS = [
  // CMD058: the capability has no independent acceptance yet (DESIGN or IMPLEMENTED_UNACCEPTED): a version cannot stand in for it
  "CAPABILITY_NOT_ACCEPTED",
  // CMD058: the profile hash is the capability's current profile (a version changes something) or one it already holds
  "CAPABILITY_PROFILE_UNCHANGED",
  // CMD059: the capability is already SUSPENDED, or still in DESIGN: nothing to restrict
  "CAPABILITY_NOT_RESTRICTABLE",
  // CMD058 (S078; the qualification predicates, one reason each): a cited ref no vendor_qualifications row carries; a qualification of another
  // tool; of another profile than the version's; without the export-back evidence; whose result is not PASS
  "QUALIFICATION_EVIDENCE_UNKNOWN",
  "QUALIFICATION_TOOL_MISMATCH",
  "QUALIFICATION_PROFILE_MISMATCH",
  "QUALIFICATION_EXPORT_BACK_MISSING",
  "QUALIFICATION_FAILED",
] as const;
export type CapabilityFailureReason = (typeof CAPABILITY_FAILURE_REASONS)[number];

/** The states over which CMD058 may record a prospective version. */
export const VERSIONABLE_CAPABILITY_STATES: ReadonlySet<Capability["state"]> = new Set<Capability["state"]>(["QUALIFIED_INTERNAL", "AVAILABLE_LIMITED", "AVAILABLE", "SUSPENDED"]);
/** The states CMD059 may restrict (the Capability machine's edges into SUSPENDED). */
export const RESTRICTABLE_CAPABILITY_STATES: ReadonlySet<Capability["state"]> = new Set<Capability["state"]>(["IMPLEMENTED_UNACCEPTED", "QUALIFIED_INTERNAL", "AVAILABLE_LIMITED", "AVAILABLE"]);

/** A capability with the revision both commands compare (expectedVersion): every recorded version or restriction advances it. */
export interface CapabilityGovernanceRecord {
  readonly capabilityId: CapabilityId;
  readonly revision: number;
  readonly state: Capability["state"];
  readonly profileHash: Sha256Hex;
  /** The capability kind and (MODE only) its mode: the scope of the S078 qualification predicates. */
  readonly kind: "MODE" | "OBJECT" | "OPERATION" | "TOOL" | "ENVELOPE";
  readonly mode: "CLEAN" | "HUBSPOT" | "SALESFORCE" | null;
}

/**
 * S078 scope: the five qualification predicates apply to every capability except a CLEAN mode (kind MODE, mode CLEAN: no importer tool and
 * no export-back; 0003 capabilities_mode_kind: only MODE rows carry a mode). A TOOL, OBJECT, OPERATION, ENVELOPE or CRM-mode capability is gated.
 */
export function requiresVendorQualification(capability: Pick<CapabilityGovernanceRecord, "kind" | "mode">): boolean {
  return !(capability.kind === "MODE" && capability.mode === "CLEAN");
}

/** One vendor_qualifications row (0073): the independent acceptance a version's evidence hash resolves to. */
export interface VendorQualificationRecord {
  readonly evidenceHash: Sha256Hex;
  /** The capability (the tool) the acceptance was made for. */
  readonly capabilityId: CapabilityId;
  readonly profileHash: Sha256Hex;
  readonly exportBackEvidenceHash: Sha256Hex | null;
  readonly result: "PASS" | "FAIL";
}

export interface CapabilityVersionRecord {
  readonly capabilityId: CapabilityId;
  readonly versionNo: number;
  readonly status: "PROSPECTIVE";
  readonly profileHash: Sha256Hex;
  readonly qualificationEvidenceHashes: ReadonlyArray<Sha256Hex>;
  readonly createdAt: UtcInstant;
}

export interface CapabilityRestrictionRecord {
  readonly restrictionId: string;
  readonly capabilityId: CapabilityId;
  readonly incidentRef: string;
  readonly priorState: Capability["state"];
  readonly revisionAfter: number;
  readonly createdAt: UtcInstant;
}

export interface CapabilityGovernanceRepository {
  /** The capability row FOR UPDATE (held to COMMIT); null when it does not exist. The owner's request session only. */
  lockCapability(capabilityId: CapabilityId): Promise<CapabilityGovernanceRecord | null>;
  /** The qualifications carrying these evidence hashes (those that exist; a hash with no row is absent from the answer). Owner session read. */
  qualificationsOf(evidenceHashes: ReadonlyArray<Sha256Hex>): Promise<ReadonlyArray<VendorQualificationRecord>>;
  /** Whether the capability already holds a version (prospective or the current profile) with this profile hash. */
  holdsProfile(capabilityId: CapabilityId, profileHash: Sha256Hex): Promise<boolean>;
  /** Appends the prospective version numbered revision + 1 and advances the revision (compare-and-swap on the revision the caller read). */
  recordVersion(input: { readonly capabilityId: CapabilityId; readonly expectedRevision: number; readonly profileHash: Sha256Hex; readonly evidenceHashes: ReadonlyArray<Sha256Hex>; readonly by: UserId }): Promise<VersionedWrite<CapabilityVersionRecord>>;
  /** Suspends the capability (a listed edge), advances the revision and appends the restriction evidence; STALE when the revision moved. */
  restrict(input: { readonly restrictionId: string; readonly capabilityId: CapabilityId; readonly expectedRevision: number; readonly incidentRef: string; readonly priorState: Capability["state"]; readonly by: OperationsActor }): Promise<VersionedWrite<CapabilityRestrictionRecord>>;
}
