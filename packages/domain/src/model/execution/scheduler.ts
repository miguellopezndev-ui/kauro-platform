/**
 * The fair scheduler of job admission (package B08; docs/design/B08-audit-approval-jobs.md D8-SCHED-1; R2-046 "enforce global
 * active/waiting limits and the documented fair scheduler; do not let one tenant create an unbounded hidden queue"; 07 "fair agency
 * scheduling").
 *
 * JOB_ADMISSION admits QUEUED jobs under the global ledger lock, one at a time, in this total order:
 *   1. the agency's held slots — its jobs WAITING or ACTIVE — fewest first (an agency already running waits behind one that is not);
 *   2. the agency's last admission — the agency that has waited longest first, an agency never admitted before any other;
 *   3. the job's queue instant, oldest first;
 *   4. the job id, as the final tie-breaker, so the order never depends on the input order.
 * This module is the pure definition; the persistence adapter orders its candidate query the same way (held, last_admitted_at NULLS
 * FIRST, queued_at, job_id), and the admission re-reads the candidates after every admission (the held slots change).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyId } from "../ids.js";
import type { ProcessingJobId } from "./ids.js";

export interface AdmissionCandidate {
  readonly jobId: ProcessingJobId;
  readonly agencyId: AgencyId;
  readonly queuedAt: UtcInstant;
  /** The agency's jobs holding a WAITING or ACTIVE slot now. */
  readonly agencyHeldSlots: number;
  /** The agency's most recent admission, or null when it was never admitted. */
  readonly agencyLastAdmittedAt: UtcInstant | null;
}

function instantOrder(a: UtcInstant, b: UtcInstant): number {
  const d = Date.parse(a) - Date.parse(b);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

/** The admission order of D8-SCHED-1 as a comparator (negative when `a` is admitted first). */
export function compareAdmissionCandidates(a: AdmissionCandidate, b: AdmissionCandidate): number {
  if (a.agencyHeldSlots !== b.agencyHeldSlots) return a.agencyHeldSlots - b.agencyHeldSlots;
  if (a.agencyLastAdmittedAt !== b.agencyLastAdmittedAt) {
    if (a.agencyLastAdmittedAt === null) return -1;
    if (b.agencyLastAdmittedAt === null) return 1;
    const waited = instantOrder(a.agencyLastAdmittedAt, b.agencyLastAdmittedAt);
    if (waited !== 0) return waited;
  }
  const queued = instantOrder(a.queuedAt, b.queuedAt);
  if (queued !== 0) return queued;
  return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
}

/** The candidates in admission order (a new array; the input is not changed). */
export function fairAdmissionOrder(candidates: ReadonlyArray<AdmissionCandidate>): AdmissionCandidate[] {
  for (const c of candidates) {
    if (!Number.isSafeInteger(c.agencyHeldSlots) || c.agencyHeldSlots < 0) throw new RangeError("an agency's held slots are a non-negative count");
    if (Number.isNaN(Date.parse(c.queuedAt)) || (c.agencyLastAdmittedAt !== null && Number.isNaN(Date.parse(c.agencyLastAdmittedAt)))) throw new RangeError("admission instants are UTC instants");
  }
  return [...candidates].sort(compareAdmissionCandidates);
}
