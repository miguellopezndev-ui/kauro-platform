/**
 * Request journal port: the registry RequestJournal contract (owner manual 06; table kauro.request_journal) — the durable
 * record of one physical dispatch attempt of a logical task to an external provider. It is distinct from the command journal
 * (idempotency of the public command, manual 10): one committed command can produce several journaled dispatch attempts,
 * each under its own fence (decision D-IDEM-3).
 *
 * Invariants the database enforces: requestHash is a full lowercase SHA-256 (a short or foreign digest is refused);
 * reservedCents is a positive ceiling (no dispatch without a bounded liability); fence is a positive generation; requestHash,
 * taskId, fence, reservedCents and the upstream list are immutable after reservation; CONSUMED, FAILED and CANCELLED are
 * terminal; updatedAt is monotonic. S089 in domain terms ("reject runnable materialization until actual dependencies and
 * grants are resolved"): a reservation is refused with PRECONDITION_FAILED / UPSTREAM_UNRESOLVED unless every upstream it
 * names is a dispatch attempt of the same tenant scope whose response was stored and consumed (CONSUMED) — a failed,
 * cancelled, uncertain, unconsumed, unknown or foreign upstream blocks it. What the database does not check is that
 * costGrantId names an actual funded CostGrant with room under its ceiling: CostGrant is not a B06 contract, and grant
 * admission is the orchestrator's (registry S041 and CMD020 of B03, R2-044 of B08; docs/design/B06-case-map.md, S089).
 */
import type { MoneyMinorUnits, RequestJournal as RequestJournalRecord, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, RequestId, TaskId } from "../model/ids.js";

export type { RequestJournalRecord };

/** The three non-acceptance evidences of package B05 D5-18 (migration request_journal.non_acceptance_evidence CHECK). */
export const NON_ACCEPTANCE_EVIDENCES = Object.freeze([
  "PROVIDER_DOCUMENTED_NON_ACCEPTANCE:ThrottlingException",
  "PROVIDER_DOCUMENTED_NON_ACCEPTANCE:RESOURCE_EXHAUSTED",
  "TRANSPORT_NEVER_SENT",
] as const);
export type NonAcceptanceEvidence = (typeof NON_ACCEPTANCE_EVIDENCES)[number];

export interface RequestReservation {
  readonly requestId: RequestId;
  readonly taskId: TaskId;
  readonly agencyId: AgencyId | null;
  readonly requestHash: Sha256Hex;
  readonly fence: number;
  readonly reservedCents: MoneyMinorUnits;
  /** The funding grant this reservation draws on (CostGrant, later package); required so no spend lacks a ceiling. */
  readonly costGrantId: string;
  /**
   * The dispatch attempts whose consumed responses this request depends on (an empty list when it depends on none). Each must
   * be CONSUMED and of the same agency scope when the reservation is made; the list is immutable afterwards.
   */
  readonly upstreamRequestIds: ReadonlyArray<RequestId>;
  readonly reservedAt: UtcInstant;
  /** B05 D5-18: the admitting INTERPRET step's fence (required for a model task's request; immutable). */
  readonly stepFence?: number;
  /** B05 D5-11: the Intelligence Core's admission (run, reservation, request key, exact maximum in micros; immutable). */
  readonly core?: { readonly runId: string; readonly reservationId: string; readonly requestKey: string; readonly maxChargeMicros: bigint };
}

export interface RequestJournal {
  /**
   * RESERVED: durable intent before any external call (10 "Provider adapter contract": prepared intent is durable first).
   * Refused with PRECONDITION_FAILED / UPSTREAM_UNRESOLVED while a named upstream is not CONSUMED (S089).
   */
  reserve(reservation: RequestReservation): Promise<RequestJournalRecord>;
  markDispatching(requestId: RequestId, fence: number, providerRequestId: string | null, now: UtcInstant): Promise<RequestJournalRecord | null>;
  /** RESPONSE_STORED: the complete response artifact is durable before anything consumes it. */
  storeResponse(requestId: RequestId, fence: number, responseArtifactHash: Sha256Hex, usage: { readonly usageState: RequestJournalRecord["usageState"]; readonly actualCents?: MoneyMinorUnits }, now: UtcInstant): Promise<RequestJournalRecord | null>;
  markConsumed(requestId: RequestId, fence: number, now: UtcInstant): Promise<RequestJournalRecord | null>;
  /** UNCERTAIN is an explicit state, never a free retry (07; 21 "Unknown external effects remain uncertain and reserved"). */
  markUncertain(requestId: RequestId, fence: number, now: UtcInstant): Promise<RequestJournalRecord | null>;
  /**
   * FAILED. `evidence` (package B05 D5-18 rows 5-6) is the non-acceptance evidence of a request that left DISPATCHING without being
   * accepted (a documented throttling refusal, or the transport proving it never sent); the database records it only on
   * DISPATCHING -> FAILED with usage UNKNOWN and never rewrites it (KA007 / KA004 otherwise).
   */
  markFailed(requestId: RequestId, fence: number, now: UtcInstant, evidence?: NonAcceptanceEvidence): Promise<RequestJournalRecord | null>;
  markCancelled(requestId: RequestId, fence: number, now: UtcInstant): Promise<RequestJournalRecord | null>;
  reconcileUsage(requestId: RequestId, actualCents: MoneyMinorUnits, now: UtcInstant): Promise<RequestJournalRecord | null>;
  get(requestId: RequestId): Promise<RequestJournalRecord | null>;
  listByTask(taskId: TaskId): Promise<ReadonlyArray<RequestJournalRecord>>;
}
