/**
 * Lease store over `pg` (contract Lease: an old live worker cannot publish after another owner advances the fence;
 * 07 "Job and attempt states": a claim creates a monotonically increasing fence and a lease, a renewal cannot change the
 * immutable execution subject; S090: a resume that omits or swaps the stored checkpoint, or resets the absolute deadline, is
 * refused, and subject, clock, cost and checkpoint identity are preserved; decision D-LEASE-1; since the package-close review,
 * finding B06-R1 and decision D-LEASE-3, an expired lease is resumed — by another owner or its former one — only under the next
 * fence and with the stored checkpoint, and a spending lease that expired without one is not resumed at all). The atomic operations are the SQL functions kauro.claim_lease / heartbeat_lease /
 * checkpoint_lease / cancel_lease, run by kauro_control (SECURITY INVOKER). A claim runs under a savepoint so a refusal
 * (KA005 / KA004 raised by the guard triggers) does not abort the caller's transaction: a sweeper claims many leases in one
 * unit of work and answers each refusal on its own.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DomainFailure, type ClaimOutcome, type LeaseClaim, type LeaseOwnerId, type LeaseRecord, type LeaseResourceKind, type LeaseStore, type ResourceId } from "@kauro/domain";
import { LeaseRefusal, execute, instant, int, optionalText, type Queryable } from "./sql.js";

interface LeaseRow {
  resource_kind: LeaseResourceKind;
  resource_id: string;
  owner_id: string;
  fence: string;
  expires_at: Date;
  heartbeat_at: Date;
  cancel_version: string;
  deadline_at: Date;
  subject_hash: string;
  cost_authority_id: string | null;
  checkpoint_hash: string | null;
}

const LEASE_COLUMNS = "resource_kind, resource_id, owner_id, fence, expires_at, heartbeat_at, cancel_version, deadline_at, subject_hash, cost_authority_id, checkpoint_hash";

function leaseRecord(r: LeaseRow): LeaseRecord {
  return {
    resourceKind: r.resource_kind,
    resourceId: r.resource_id as ResourceId,
    ownerId: r.owner_id as LeaseOwnerId,
    fence: int(r.fence),
    expiresAt: instant(r.expires_at),
    heartbeatAt: instant(r.heartbeat_at),
    cancelVersion: int(r.cancel_version),
    deadlineAt: instant(r.deadline_at),
    subjectHash: r.subject_hash,
    costAuthorityId: r.cost_authority_id,
    checkpointHash: optionalText(r.checkpoint_hash) ?? null,
  };
}

/** The lease functions return a composite; when the function returns NULL every column of the row is NULL. */
function rowOrNull(rows: ReadonlyArray<LeaseRow>): LeaseRecord | null {
  const r = rows[0];
  if (!r || r.resource_id === null || r.fence === null) return null;
  return leaseRecord(r);
}

function refusalReason(refusal: LeaseRefusal): Extract<ClaimOutcome, { kind: "REFUSED" }>["reason"] {
  const m = refusal.serverMessage;
  if (m.includes("RESUME_WITHOUT_CHECKPOINT") || m.includes("CHECKPOINT_MISMATCH")) return "RESUME_WITHOUT_CHECKPOINT";
  if (m.includes("deadline_at")) return "DEADLINE_IMMUTABLE";
  if (m.includes("cost_authority_id")) return "COST_IMMUTABLE";
  if (m.includes("subject_hash")) return "SUBJECT_IMMUTABLE";
  if (m.includes("deadline of")) return "DEADLINE_PASSED";
  throw refusal;
}

export class PgLeaseStore implements LeaseStore {
  constructor(private readonly db: Queryable) {}

  async claim(claim: LeaseClaim, now: UtcInstant): Promise<ClaimOutcome> {
    if (!Number.isInteger(claim.ttlSeconds) || claim.ttlSeconds < 1) throw new DomainFailure("INVALID_REQUEST", "lease ttl must be a positive number of seconds");
    await execute(this.db, "SAVEPOINT kauro_claim_lease");
    let rows: ReadonlyArray<LeaseRow>;
    try {
      const r = await execute<LeaseRow>(
        this.db,
        `SELECT ${LEASE_COLUMNS} FROM kauro.claim_lease($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [claim.resourceKind, claim.resourceId, claim.ownerId, claim.ttlSeconds, claim.deadlineAt, claim.subjectHash, claim.costAuthorityId, claim.checkpointHash, now],
      );
      rows = r.rows;
      await execute(this.db, "RELEASE SAVEPOINT kauro_claim_lease");
    } catch (e) {
      await execute(this.db, "ROLLBACK TO SAVEPOINT kauro_claim_lease");
      if (e instanceof LeaseRefusal) return { kind: "REFUSED", reason: refusalReason(e) };
      throw e;
    }
    const lease = rowOrNull(rows);
    if (!lease) throw new DomainFailure("INTEGRITY_FAILURE", "claim_lease returned no lease");
    return lease.ownerId === claim.ownerId ? { kind: "CLAIMED", lease } : { kind: "HELD", lease };
  }

  async heartbeat(resourceKind: LeaseResourceKind, resourceId: ResourceId, ownerId: LeaseOwnerId, fence: number, ttlSeconds: number, now: UtcInstant): Promise<LeaseRecord | null> {
    const r = await execute<LeaseRow>(this.db, `SELECT ${LEASE_COLUMNS} FROM kauro.heartbeat_lease($1, $2, $3, $4, $5, $6)`, [resourceKind, resourceId, ownerId, fence, ttlSeconds, now]);
    return rowOrNull(r.rows);
  }

  async checkpoint(resourceKind: LeaseResourceKind, resourceId: ResourceId, ownerId: LeaseOwnerId, fence: number, checkpointHash: Sha256Hex, now: UtcInstant): Promise<LeaseRecord | null> {
    const r = await execute<LeaseRow>(this.db, `SELECT ${LEASE_COLUMNS} FROM kauro.checkpoint_lease($1, $2, $3, $4, $5, $6)`, [resourceKind, resourceId, ownerId, fence, checkpointHash, now]);
    return rowOrNull(r.rows);
  }

  async cancel(resourceKind: LeaseResourceKind, resourceId: ResourceId, _now: UtcInstant): Promise<LeaseRecord | null> {
    const r = await execute<LeaseRow>(this.db, `SELECT ${LEASE_COLUMNS} FROM kauro.cancel_lease($1, $2)`, [resourceKind, resourceId]);
    return rowOrNull(r.rows);
  }

  async get(resourceKind: LeaseResourceKind, resourceId: ResourceId): Promise<LeaseRecord | null> {
    const r = await execute<LeaseRow>(this.db, `SELECT ${LEASE_COLUMNS} FROM kauro.leases WHERE resource_kind = $1 AND resource_id = $2`, [resourceKind, resourceId]);
    return rowOrNull(r.rows);
  }
}
