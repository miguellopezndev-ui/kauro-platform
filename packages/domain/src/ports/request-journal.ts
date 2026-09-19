/**
 * Request journal port: the registry RequestJournal contract (owner manual 06; table kauro.request_journal) — the durable
 * record of one physical dispatch attempt of a logical task to an external provider. It is distinct from the command journal
 * (idempotency of the public command, manual 10): one committed command can produce several journaled dispatch attempts,
 * each under its own fence (decision D-IDEM-3).
 *
 * Invariants the database enforces: requestHash is a full lowercase SHA-256 (a short or foreign digest is refused);
 * reservedCents is a positive ceiling (no dispatch without a bounded liability); fence is a positive generation; requestHash,
 * taskId, fence and reservedCents are immutable after reservation; CONSUMED, FAILED and CANCELLED are terminal; updatedAt is
 * monotonic. S089 in domain terms: a dispatch cannot be materialized until its dependencies (full hashes, funded reservation)
 * are resolved.
 */
import type { MoneyMinorUnits, RequestJournal as RequestJournalRecord, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, RequestId, TaskId } from "../model/ids.js";

export type { RequestJournalRecord };

export interface RequestReservation {
  readonly requestId: RequestId;
  readonly taskId: TaskId;
  readonly agencyId: AgencyId | null;
  readonly requestHash: Sha256Hex;
  readonly fence: number;
  readonly reservedCents: MoneyMinorUnits;
  /** The funding grant this reservation draws on (CostGrant, later package); required so no spend lacks a ceiling. */
  readonly costGrantId: string;
  readonly reservedAt: UtcInstant;
}

export interface RequestJournal {
  /** RESERVED: durable intent before any external call (10 "Provider adapter contract": prepared intent is durable first). */
  reserve(reservation: RequestReservation): Promise<RequestJournalRecord>;
  markDispatching(requestId: RequestId, fence: number, providerRequestId: string | null, now: UtcInstant): Promise<RequestJournalRecord | null>;
  /** RESPONSE_STORED: the complete response artifact is durable before anything consumes it. */
  storeResponse(requestId: RequestId, fence: number, responseArtifactHash: Sha256Hex, usage: { readonly usageState: RequestJournalRecord["usageState"]; readonly actualCents?: MoneyMinorUnits }, now: UtcInstant): Promise<RequestJournalRecord | null>;
  markConsumed(requestId: RequestId, fence: number, now: UtcInstant): Promise<RequestJournalRecord | null>;
  /** UNCERTAIN is an explicit state, never a free retry (07; 21 "Unknown external effects remain uncertain and reserved"). */
  markUncertain(requestId: RequestId, fence: number, now: UtcInstant): Promise<RequestJournalRecord | null>;
  markFailed(requestId: RequestId, fence: number, now: UtcInstant): Promise<RequestJournalRecord | null>;
  markCancelled(requestId: RequestId, fence: number, now: UtcInstant): Promise<RequestJournalRecord | null>;
  reconcileUsage(requestId: RequestId, actualCents: MoneyMinorUnits, now: UtcInstant): Promise<RequestJournalRecord | null>;
  get(requestId: RequestId): Promise<RequestJournalRecord | null>;
  listByTask(taskId: TaskId): Promise<ReadonlyArray<RequestJournalRecord>>;
}
