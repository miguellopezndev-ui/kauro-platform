/**
 * The outreach service's access helpers (package B12, lane K1; docs/design/B12-outreach-plan.md §L, §W):
 *
 * - holdOutreachLease (L13): the dispatcher's OUTBOX_DISPATCH lease row FOR SHARE under (resource, owner, fence) and NOT EXPIRED AT THE
 *   DATABASE'S OWN INSTANT kauro.effect_now() (never a caller instant: the B10 helper commission-service-access.ts holdDispatchLease
 *   judges `expires_at > $4`, a value the caller computed before an await, which B12 does not reuse; plan rev 3 own finding, GAP-DI-5).
 *   The share lock holds the row until COMMIT, so a takeover (claim_lease's UPDATE, 0067:20) waits for this unit and never lands between
 *   the guard and the COMMIT. No row answering is LEASE_FENCED. Grants and policies: 0072 leases_outreach_read / leases_outreach_lock.
 *
 * - OutreachLocks: the advisory subjects of §L (kauro.transition_key(kind, subject)), taken by the WRITERS only, in the one global order
 *   (L1, L2, L3, L4, L4g, L5, L6, L6p, L7, L8, L10, L13, L14). An acquisition that would go backwards in that order is refused before any
 *   SQL runs (INTEGRITY_FAILURE): every actor trace is a subsequence of the order, so no two B12 writers can deadlock. Several keys of one
 *   subject are taken in ascending key order (L10 of a review's drafts). The triggers never acquire (T2 asserts through pg_locks), except
 *   the CMD045 trigger's L8 S (0072, order-safe).
 */
import { DomainFailure, OUTREACH_LOCK_KINDS, OUTREACH_LOCK_ORDER, type OutreachLock } from "@kauro/domain";
import { execute, type Queryable } from "./sql.js";

export type OutreachLockMode = "X" | "S";

/**
 * The B12 lease fence (L13): the unit's dispatcher still holds the OUTBOX_DISPATCH lease of `resourceId` under (`ownerId`, `fence`) at
 * kauro.effect_now(), held FOR SHARE until COMMIT; otherwise PRECONDITION_FAILED with reason LEASE_FENCED (the unit rolls back).
 */
export async function holdOutreachLease(db: Queryable, resourceId: string, ownerId: string, fence: number): Promise<void> {
  const r = await execute(
    db,
    `SELECT 1 FROM kauro.leases
      WHERE resource_kind = 'OUTBOX_DISPATCH' AND resource_id = $1 AND owner_id = $2 AND fence = $3 AND expires_at > kauro.effect_now()
        FOR SHARE`,
    [resourceId, ownerId, fence],
  );
  if (r.rowCount !== 1) throw new DomainFailure("PRECONDITION_FAILED", "the outreach dispatcher no longer holds its lease under this fence at the database's instant", { reason: "LEASE_FENCED" });
}

const ADVISORY: ReadonlyArray<OutreachLock> = Object.keys(OUTREACH_LOCK_KINDS) as OutreachLock[];

function rank(lock: OutreachLock | "L13" | "L14"): number {
  return (OUTREACH_LOCK_ORDER as ReadonlyArray<string>).indexOf(lock);
}

/**
 * One unit of work's B12 acquisitions, in the global order. take() refuses a subject ranked before the last one taken (and a second key
 * of the same subject below the last key taken), so a writer whose code reorders its trace fails loudly in every test that runs it.
 */
export class OutreachLocks {
  #last = -1;
  #lastKey: string | null = null;
  readonly taken: Array<{ readonly lock: OutreachLock | "L13"; readonly subject: string; readonly mode: OutreachLockMode }> = [];

  constructor(private readonly db: Queryable) {}

  async take(lock: OutreachLock, subject: string, mode: OutreachLockMode = "X"): Promise<void> {
    if (!ADVISORY.includes(lock)) throw new DomainFailure("INTEGRITY_FAILURE", `${String(lock)} is not a B12 advisory subject`);
    this.#order(lock, subject);
    await execute(this.db, `SELECT ${mode === "X" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(kauro.transition_key($1, $2))`, [OUTREACH_LOCK_KINDS[lock], subject]);
    this.taken.push({ lock, subject, mode });
  }

  /** Several keys of one subject, ascending (L10 of a review's drafts, PrepareOutreachReview and CMD062). */
  async takeAll(lock: OutreachLock, subjects: ReadonlyArray<string>, mode: OutreachLockMode = "X"): Promise<void> {
    for (const s of [...new Set(subjects)].sort()) await this.take(lock, s, mode);
  }

  /** L13, after every advisory subject of the trace. */
  async lease(resourceId: string, ownerId: string, fence: number): Promise<void> {
    this.#order("L13", `${resourceId}:${fence}`);
    await holdOutreachLease(this.db, resourceId, ownerId, fence);
    this.taken.push({ lock: "L13", subject: resourceId, mode: "S" });
  }

  #order(lock: OutreachLock | "L13", subject: string): void {
    const r = rank(lock);
    if (r < this.#last || (r === this.#last && this.#lastKey !== null && subject < this.#lastKey)) {
      throw new DomainFailure("INTEGRITY_FAILURE", `outreach lock ${lock} taken after ${OUTREACH_LOCK_ORDER[this.#last] ?? "?"}: the trace leaves the global order (plan §L)`);
    }
    this.#last = r;
    this.#lastKey = subject;
  }
}
