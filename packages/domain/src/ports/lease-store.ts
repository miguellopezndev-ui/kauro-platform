/**
 * Lease store port (contract Lease; 07 "Job and attempt states": a claim creates a monotonically increasing fence and a lease;
 * an old live worker cannot publish after another owner advances the fence).
 *
 * A lease binds a logical operation (resourceKind, resourceId) to one owner attempt under a fence. The database owns the
 * invariants (table kauro.leases and functions kauro.claim_lease / kauro.heartbeat_lease): the fence strictly increases on
 * every owner change; the absolute deadline and the immutable subject cannot change after the first claim; a renewal cannot
 * extend a lease past the deadline; a resume that omits or swaps the stored checkpoint identity is refused
 * (S090: reject restart; preserve original subject, clock, cost and checkpoint identity).
 */
import type { Lease, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { LeaseOwnerId, ResourceId } from "../model/ids.js";

export type LeaseResourceKind = "OUTBOX_DISPATCH" | "MODEL_TASK" | "JOB_ATTEMPT" | "SWEEP";

export interface LeaseRecord extends Lease {
  readonly resourceKind: LeaseResourceKind;
  readonly resourceId: ResourceId;
  readonly ownerId: LeaseOwnerId;
  /** Absolute boundary of the logical operation; immutable after the first claim. */
  readonly deadlineAt: UtcInstant;
  /** Digest of the immutable execution subject (source, plan, target, core, policy bundle where applicable). */
  readonly subjectHash: Sha256Hex;
  /** Identity of the last durable checkpoint the previous owner stored; a resume must present exactly this one. */
  readonly checkpointHash: Sha256Hex | null;
}

export interface LeaseClaim {
  readonly resourceKind: LeaseResourceKind;
  readonly resourceId: ResourceId;
  readonly ownerId: LeaseOwnerId;
  readonly ttlSeconds: number;
  /** Required on the first claim; must equal the stored value on every later claim. */
  readonly deadlineAt: UtcInstant;
  readonly subjectHash: Sha256Hex;
  /** Present on a resume: must equal the checkpoint the previous owner stored (null means a fresh start with no checkpoint). */
  readonly checkpointHash: Sha256Hex | null;
}

export type ClaimOutcome =
  | { readonly kind: "CLAIMED"; readonly lease: LeaseRecord }
  | { readonly kind: "HELD"; readonly lease: LeaseRecord }
  | { readonly kind: "REFUSED"; readonly reason: "RESUME_WITHOUT_CHECKPOINT" | "DEADLINE_IMMUTABLE" | "SUBJECT_IMMUTABLE" | "DEADLINE_PASSED" | "CANCELLED" };

export interface LeaseStore {
  /** Atomically claims a free or expired lease (fence + 1) or returns HELD with the live lease. */
  claim(claim: LeaseClaim, now: UtcInstant): Promise<ClaimOutcome>;
  /** Renews the lease if the caller still holds the fence; null when fenced out (the caller must stop publishing). */
  heartbeat(resourceKind: LeaseResourceKind, resourceId: ResourceId, ownerId: LeaseOwnerId, fence: number, ttlSeconds: number, now: UtcInstant): Promise<LeaseRecord | null>;
  /** Stores a checkpoint identity under the fence the caller holds; null when fenced out. */
  checkpoint(resourceKind: LeaseResourceKind, resourceId: ResourceId, ownerId: LeaseOwnerId, fence: number, checkpointHash: Sha256Hex, now: UtcInstant): Promise<LeaseRecord | null>;
  /** Advances the cancellation generation the owner must observe (07 cancellation fence). */
  cancel(resourceKind: LeaseResourceKind, resourceId: ResourceId, now: UtcInstant): Promise<LeaseRecord | null>;
  get(resourceKind: LeaseResourceKind, resourceId: ResourceId): Promise<LeaseRecord | null>;
}
