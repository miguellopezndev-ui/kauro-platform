/**
 * Lease store port (contract Lease; 07 "Job and attempt states": a claim creates a monotonically increasing fence and a lease;
 * an old live worker cannot publish after another owner advances the fence).
 *
 * A lease binds a logical operation (resourceKind, resourceId) to one owner attempt under a fence. The database owns the
 * invariants (table kauro.leases and functions kauro.claim_lease / kauro.heartbeat_lease): the fence strictly increases on
 * every owner change; the absolute deadline and the immutable subject cannot change after the first claim; a renewal cannot
 * extend a lease past the deadline; the cost identity (the funding authority the operation spends against) cannot change
 * after the first claim; a resume that omits or swaps the stored checkpoint identity is refused
 * (S090: reject restart; preserve original subject, clock, cost and checkpoint identity). The expiry decides what a claim is
 * (review finding B06-R1, decision D-LEASE-3): a live lease is HELD for another owner and renewed under the same fence for its
 * holder; an expired lease is resumed by whoever claims it — its former owner included — as a new attempt under the next fence,
 * and only with the stored checkpoint; a spending operation (MODEL_TASK, JOB_ATTEMPT) that expired before storing a checkpoint
 * cannot be resumed at all (it is rerun as a new attempt, under a new lease, through its own admission).
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
  /**
   * Cost identity: the funding authority the leased operation spends against — the CostGrant of a MODEL_TASK, the
   * CommercialAuthorization of a JOB_ATTEMPT; null for OUTBOX_DISPATCH and SWEEP, which spend nothing. Immutable after the
   * first claim, so a takeover continues under the same grant or entitlement (07 "CommercialAuthorization").
   */
  readonly costAuthorityId: string | null;
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
  /** Required for MODEL_TASK and JOB_ATTEMPT, null otherwise; must equal the stored value on every later claim. */
  readonly costAuthorityId: string | null;
  /**
   * The checkpoint the claim continues from: null on the first claim; on every later claim — a renewal by the live holder or a
   * resume of an expired lease — exactly the checkpoint stored (null only when none was stored, which a spending operation
   * cannot resume from). Anything else is REFUSED RESUME_WITHOUT_CHECKPOINT.
   */
  readonly checkpointHash: Sha256Hex | null;
}

export type ClaimOutcome =
  | { readonly kind: "CLAIMED"; readonly lease: LeaseRecord }
  | { readonly kind: "HELD"; readonly lease: LeaseRecord }
  | { readonly kind: "REFUSED"; readonly reason: "RESUME_WITHOUT_CHECKPOINT" | "DEADLINE_IMMUTABLE" | "SUBJECT_IMMUTABLE" | "COST_IMMUTABLE" | "DEADLINE_PASSED" | "CANCELLED" };

export interface LeaseStore {
  /**
   * Atomically claims a free lease (fence 1), renews the caller's own live lease (same fence), resumes an expired lease — the
   * caller's own included — under the next fence, or returns HELD with another owner's live lease.
   */
  claim(claim: LeaseClaim, now: UtcInstant): Promise<ClaimOutcome>;
  /** Renews the lease if the caller still holds the fence; null when fenced out (the caller must stop publishing). */
  heartbeat(resourceKind: LeaseResourceKind, resourceId: ResourceId, ownerId: LeaseOwnerId, fence: number, ttlSeconds: number, now: UtcInstant): Promise<LeaseRecord | null>;
  /** Stores a checkpoint identity under the fence the caller holds; null when fenced out. */
  checkpoint(resourceKind: LeaseResourceKind, resourceId: ResourceId, ownerId: LeaseOwnerId, fence: number, checkpointHash: Sha256Hex, now: UtcInstant): Promise<LeaseRecord | null>;
  /** Advances the cancellation generation the owner must observe (07 cancellation fence). */
  cancel(resourceKind: LeaseResourceKind, resourceId: ResourceId, now: UtcInstant): Promise<LeaseRecord | null>;
  get(resourceKind: LeaseResourceKind, resourceId: ResourceId): Promise<LeaseRecord | null>;
}
