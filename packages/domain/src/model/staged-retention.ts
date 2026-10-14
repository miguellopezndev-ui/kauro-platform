/**
 * PAID_STAGED retention deadlines of a staged CRM import workflow (package B16 lane L7, cases R2-054 and R2-055; manual 09 "Retention
 * schedule" and "Quotes, reuploads and retention"). The pure mirror of migration 0062 (kauro.staged_retention_windows, whose triggers
 * compute the deadlines on the server's clock and are the authority): what the read model and its tests compute from the same anchors.
 *
 *   hard deadline          = capture + 30 d (never moves)
 *   stage continuation     = min(first release + 21 d, hard deadline)
 *   final download         = min(final completion + 7 d, hard deadline), only for a completion before the continuation deadline
 *
 * A late completion creates no final-delivery allowance; at a deadline the window is EXPIRED (one microsecond before, open). The
 * remaining time shown is the actual remaining time, never an automatic extension. Instants are epoch microseconds (the database's
 * precision), so the boundary is exact.
 */

export const STAGED_RETENTION_POLICY = Object.freeze({
  stageContinuationSeconds: 1_814_400,
  captureHardCapSeconds: 2_592_000,
  finalDownloadSeconds: 604_800,
} as const);

const MICROS = 1_000_000n;
const DAY_MICROS = 86_400n * MICROS;
const CONTINUATION = BigInt(STAGED_RETENTION_POLICY.stageContinuationSeconds) * MICROS;
const HARD_CAP = BigInt(STAGED_RETENTION_POLICY.captureHardCapSeconds) * MICROS;
const FINAL = BigInt(STAGED_RETENTION_POLICY.finalDownloadSeconds) * MICROS;

export type StagedRetentionPhase = "AWAITING_RELEASE" | "CONTINUATION_OPEN" | "FINAL_DOWNLOAD_OPEN" | "EXPIRED";

/** The server-clock anchors of a window (epoch microseconds). */
export interface StagedRetentionAnchors {
  readonly capturedAtMicros: bigint;
  readonly firstReleasedAtMicros?: bigint;
  readonly finalCompletedAtMicros?: bigint;
}

export interface StagedRetentionDeadlines {
  readonly hardDeadlineMicros: bigint;
  readonly continuationDeadlineMicros?: bigint;
  readonly finalDownloadDeadlineMicros?: bigint;
}

export type StagedRetentionRefusal = "RELEASE_BEFORE_CAPTURE" | "RELEASE_AFTER_HARD_DEADLINE" | "COMPLETION_BEFORE_RELEASE" | "COMPLETION_AFTER_WORKFLOW_EXPIRY";

export type StagedRetentionOutcome =
  | { readonly kind: "DEADLINES"; readonly deadlines: StagedRetentionDeadlines }
  | { readonly kind: "REFUSED"; readonly reason: StagedRetentionRefusal };

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The deadlines that follow from the anchors, or the reason the anchors cannot stand (the database refuses the same writes, KA072). */
export function stagedRetentionDeadlines(a: StagedRetentionAnchors): StagedRetentionOutcome {
  const hardDeadlineMicros = a.capturedAtMicros + HARD_CAP;
  if (a.firstReleasedAtMicros === undefined) {
    if (a.finalCompletedAtMicros !== undefined) return { kind: "REFUSED", reason: "COMPLETION_BEFORE_RELEASE" };
    return { kind: "DEADLINES", deadlines: { hardDeadlineMicros } };
  }
  if (a.firstReleasedAtMicros < a.capturedAtMicros) return { kind: "REFUSED", reason: "RELEASE_BEFORE_CAPTURE" };
  if (a.firstReleasedAtMicros >= hardDeadlineMicros) return { kind: "REFUSED", reason: "RELEASE_AFTER_HARD_DEADLINE" };
  const continuationDeadlineMicros = min(a.firstReleasedAtMicros + CONTINUATION, hardDeadlineMicros);
  if (a.finalCompletedAtMicros === undefined) return { kind: "DEADLINES", deadlines: { hardDeadlineMicros, continuationDeadlineMicros } };
  if (a.finalCompletedAtMicros < a.firstReleasedAtMicros) return { kind: "REFUSED", reason: "COMPLETION_BEFORE_RELEASE" };
  if (a.finalCompletedAtMicros >= continuationDeadlineMicros) return { kind: "REFUSED", reason: "COMPLETION_AFTER_WORKFLOW_EXPIRY" };
  const finalDownloadDeadlineMicros = min(a.finalCompletedAtMicros + FINAL, hardDeadlineMicros);
  return { kind: "DEADLINES", deadlines: { hardDeadlineMicros, continuationDeadlineMicros, finalDownloadDeadlineMicros } };
}

export interface StagedRetentionStanding {
  readonly phase: StagedRetentionPhase;
  readonly governingDeadlineMicros: bigint;
  readonly remainingMicros: bigint;
  /** Whole days shown to the customer, rounded up: one day and less is 1, an expired window 0. */
  readonly remainingDays: number;
}

/** The phase at `atMicros` (kauro.staged_retention_phase): EXPIRED at the governing deadline, open before it with the exact remainder. */
export function stagedRetentionStanding(d: StagedRetentionDeadlines, atMicros: bigint): StagedRetentionStanding {
  const open: StagedRetentionPhase = d.finalDownloadDeadlineMicros !== undefined ? "FINAL_DOWNLOAD_OPEN" : d.continuationDeadlineMicros !== undefined ? "CONTINUATION_OPEN" : "AWAITING_RELEASE";
  const governingDeadlineMicros = d.finalDownloadDeadlineMicros ?? d.continuationDeadlineMicros ?? d.hardDeadlineMicros;
  if (atMicros >= governingDeadlineMicros) return { phase: "EXPIRED", governingDeadlineMicros, remainingMicros: 0n, remainingDays: 0 };
  const remainingMicros = governingDeadlineMicros - atMicros;
  return { phase: open, governingDeadlineMicros, remainingMicros, remainingDays: Number((remainingMicros + DAY_MICROS - 1n) / DAY_MICROS) };
}
