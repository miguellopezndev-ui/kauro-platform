/**
 * The settlement observation of the bank-transfer route over `pg` (migration 0079, lane PV1-SETTLE; docs/design/ACH-ROUTE.md r12 §7.25,
 * docs/design/PV1-SETTLE.md D-SET-4/5, docs/design/PV1-SETTLE-two-step.md D-SET-10): the route of an account, the settlement or live intent
 * already recorded for a withdrawal or a bank transaction, the route's provider-available balance (kauro.route_provider_available_cents),
 * the owner's recorded intents (kauro.settlement_requests: CMD215 inserts one on kauro_app), their consumption by the payment service
 * (kauro_payment: the settlement, or a refusal with its review case) and the owner's reads of them. Every statement runs in the caller's
 * unit of work, with no agency adopted.
 *
 * Locks: `lockFunds` is the payout cash basis lock (`kauro.payout-cash`, CMD052's, 0043); the caller takes it after the account's stream
 * locks (§7.28) and before it reads the balance it judges. `lockRequest` is the intent's row (FOR NO KEY UPDATE), the apply's last lock.
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure } from "@kauro/domain";
import { ConstraintViolation, execute, lockPayoutCash, type Queryable } from "../sql.js";

/** The bank route of an account in an environment: its own id and the payment route its settlements belong to. */
export interface BankSettlementRoute {
  readonly bankRouteId: string;
  readonly paymentRouteId: string;
  readonly currency: string;
}

export interface NewBankSettlement {
  readonly settlementId: string;
  /** The intent the settlement is born of (0071 settlements_request_birth). */
  readonly requestId: string;
  readonly paymentRouteId: string;
  readonly bankRouteId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly withdrawalId: string;
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly currency: string;
  readonly grossCents: bigint;
  readonly feeCents: bigint;
  readonly heldCents: bigint;
  readonly withdrawnCents: bigint;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly observedAt: string;
  readonly normalizerVersion: string;
  readonly recordedBy: string;
  readonly receipt: {
    readonly receivingAccountRef: string;
    readonly bankTransactionId: string;
    readonly artifactRef: string;
    readonly evidenceHash: string;
    readonly receivedCents: bigint;
    readonly bankAvailableCents: bigint;
  } | null;
  /** The apply's exact effect instant (µs); the row keeps it to the millisecond (date_trunc, plan §3.3 A8). */
  readonly createdAt: string;
}

/** The receipt facts an intent freezes (all or none, 0071 settlement_requests_receipt_group). */
export interface SettlementRequestReceipt {
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly receivingAccountRef: string;
  readonly bankTransactionId: string;
  readonly receivedCents: bigint;
  readonly bankAvailableCents: bigint;
  readonly bookedAt: string;
  readonly observedAt: string;
}

/** The facts the owner's intent freezes (CMD215 R8): what the classified artifacts state. */
export interface NewSettlementRequest {
  readonly requestId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly withdrawalId: string;
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly currency: string;
  readonly grossCents: bigint;
  readonly feeCents: bigint;
  readonly heldCents: bigint;
  readonly withdrawnCents: bigint;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly observedAt: string;
  readonly normalizerVersion: string;
  readonly receipt: SettlementRequestReceipt | null;
}

export type SettlementRequestOutcome = "APPLIED" | "REFUSED";
export type SettlementRefusalReason = "EVIDENCE_MISMATCH" | "REQUEST_STALE" | "COVERAGE_END_IN_FUTURE" | "CURRENCY_MISMATCH" | "WITHDRAWAL_ALREADY_SETTLED" | "FUNDS_UNAVAILABLE";

/** An intent as the table holds it (instants as ISO text to the millisecond; requested_at is stamped to the millisecond). */
export interface SettlementRequestRow extends NewSettlementRequest {
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly consumedAt: string | null;
  readonly outcome: SettlementRequestOutcome | null;
  readonly refusalReason: SettlementRefusalReason | null;
  readonly settlementId: string | null;
  readonly reviewCaseId: string | null;
}

/** The owner's read of an intent: the row, its PAYMENT_SERVICE delivery state and its settlement (APPLIED). */
export interface SettlementRequestOutcomeRead {
  readonly request: SettlementRequestRow;
  readonly delivery: string;
  readonly settlement: {
    readonly settlementId: string;
    readonly withdrawalId: string;
    readonly currency: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly withdrawnCents: bigint;
    readonly feeCents: bigint;
    readonly receivedCents: bigint | null;
    readonly bankAvailableCents: bigint;
    readonly bankEvidence: boolean;
    readonly observedAt: string;
  } | null;
}

/** One line of the in-transit page (plan §3.5). */
export interface SettlementRequestPageItem {
  readonly requestId: string;
  readonly withdrawalId: string;
  readonly state: "RECORDED" | "REFUSED" | "APPLIED";
  readonly reason: SettlementRefusalReason | null;
  readonly withdrawnCents: bigint;
  readonly receivedCents: bigint | null;
  readonly feeCents: bigint;
  readonly requestedAt: string;
  readonly ageSeconds: number;
  readonly delivery: string;
  readonly reviewCaseId: string | null;
}

/** One settlement per withdrawal and per bank transaction (D-SET-4), one live intent of each: the second is refused, never a second row. */
const alreadySettled = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "the withdrawal or its bank transaction is already settled", { reason: "WITHDRAWAL_ALREADY_SETTLED" });
const UNIQUE_IDENTITIES = new Set(["settlements_one_per_withdrawal", "settlements_one_per_bank_transaction"]);
const LIVE_REQUEST_IDENTITIES = new Set(["settlement_requests_live_withdrawal", "settlement_requests_live_bank_transaction"]);

const ISO_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string, alias: string): string => `to_char(${column} AT TIME ZONE 'UTC', ${ISO_MS}) AS ${alias}`;

const REQUEST_COLUMNS = `r.request_id::text AS request_id, r.environment, r.account_ref, r.withdrawal_id, r.artifact_ref, r.evidence_hash, r.currency,
  r.gross_cents::text AS gross_cents, r.fee_cents::text AS fee_cents, r.held_cents::text AS held_cents, r.withdrawn_cents::text AS withdrawn_cents,
  ${iso("r.period_start", "period_start")}, ${iso("r.period_end", "period_end")}, ${iso("r.observed_at", "observed_at")}, r.normalizer_version,
  r.receipt_artifact_ref, r.receipt_evidence_hash, r.receiving_account_ref, r.bank_transaction_id, r.received_cents::text AS received_cents,
  r.bank_available_cents::text AS bank_available_cents, ${iso("r.booked_at", "booked_at")}, ${iso("r.receipt_observed_at", "receipt_observed_at")},
  r.requested_by::text AS requested_by, ${iso("r.requested_at", "requested_at")}, ${iso("r.consumed_at", "consumed_at")}, r.outcome, r.refusal_reason,
  r.settlement_id::text AS settlement_id, r.review_case_id::text AS review_case_id`;

type RequestDbRow = Record<"request_id" | "environment" | "account_ref" | "withdrawal_id" | "artifact_ref" | "evidence_hash" | "currency" | "gross_cents" | "fee_cents" | "held_cents" | "withdrawn_cents" | "period_start" | "period_end" | "observed_at" | "normalizer_version" | "requested_by" | "requested_at", string> &
  Record<"receipt_artifact_ref" | "receipt_evidence_hash" | "receiving_account_ref" | "bank_transaction_id" | "received_cents" | "bank_available_cents" | "booked_at" | "receipt_observed_at" | "consumed_at" | "outcome" | "refusal_reason" | "settlement_id" | "review_case_id", string | null>;

function requestOfRow(r: RequestDbRow): SettlementRequestRow {
  return {
    requestId: r.request_id,
    environment: r.environment as "SANDBOX" | "LIVE",
    accountRef: r.account_ref,
    withdrawalId: r.withdrawal_id,
    artifactRef: r.artifact_ref,
    evidenceHash: r.evidence_hash,
    currency: r.currency,
    grossCents: BigInt(r.gross_cents),
    feeCents: BigInt(r.fee_cents),
    heldCents: BigInt(r.held_cents),
    withdrawnCents: BigInt(r.withdrawn_cents),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    observedAt: r.observed_at,
    normalizerVersion: r.normalizer_version,
    receipt:
      r.receipt_artifact_ref === null
        ? null
        : {
            artifactRef: r.receipt_artifact_ref,
            evidenceHash: r.receipt_evidence_hash!,
            receivingAccountRef: r.receiving_account_ref!,
            bankTransactionId: r.bank_transaction_id!,
            receivedCents: BigInt(r.received_cents!),
            bankAvailableCents: BigInt(r.bank_available_cents!),
            bookedAt: r.booked_at!,
            observedAt: r.receipt_observed_at!,
          },
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    consumedAt: r.consumed_at,
    outcome: r.outcome as SettlementRequestOutcome | null,
    refusalReason: r.refusal_reason as SettlementRefusalReason | null,
    settlementId: r.settlement_id,
    reviewCaseId: r.review_case_id,
  };
}

/** The PAYMENT_SERVICE outbox state of an intent's recorded.v1 (the delivery the owner sees, plan §3.5). */
const DELIVERY_OF = (alias: string): string => `coalesce((SELECT o.state FROM kauro.domain_events e JOIN kauro.outbox_records o ON o.event_id = e.event_id AND o.consumer = 'PAYMENT_SERVICE'
     WHERE e.aggregate_kind = 'settlement_request' AND e.aggregate_id = ${alias}.request_id AND e.event_type = 'settlement_request.recorded.v1' LIMIT 1), 'NONE')`;

export class PgBankSettlements {
  constructor(private readonly db: Queryable) {}

  async routeOfAccount(environment: string, accountRef: string): Promise<BankSettlementRoute | null> {
    const r = await execute<{ route_id: string; payment_route_id: string; currency: string }>(
      this.db,
      "SELECT route_id, payment_route_id, currency FROM kauro.bank_routes WHERE environment = $1 AND account_ref = $2",
      [environment, accountRef],
    );
    const row = r.rows[0];
    return row === undefined ? null : { bankRouteId: row.route_id, paymentRouteId: row.payment_route_id, currency: row.currency };
  }

  /** The payout cash basis lock (CMD052's): held to COMMIT. */
  async lockFunds(): Promise<void> {
    await lockPayoutCash(this.db);
  }

  /** Σ PSP_AVAILABLE of the payment route in the currency, over every agency's and the route's own posting sets (the definer function). */
  async providerAvailableCents(paymentRouteId: string, currency: string): Promise<bigint> {
    const r = await execute<{ n: string }>(this.db, "SELECT kauro.route_provider_available_cents($1, $2)::text AS n", [paymentRouteId, currency]);
    return BigInt(r.rows[0]?.n ?? "0");
  }

  /** The settlement already recorded for the withdrawal of the account, or for the receiving bank's transaction. */
  async settledAs(environment: string, accountRef: string, withdrawalId: string, receipt: { readonly receivingAccountRef: string; readonly bankTransactionId: string } | null): Promise<string | null> {
    const r = await execute<{ settlement_id: string }>(
      this.db,
      `SELECT settlement_id FROM kauro.settlements
        WHERE (environment = $1 AND account_ref = $2 AND withdrawal_id = $3)
           OR ($4::text IS NOT NULL AND environment = $1 AND receiving_account_ref = $4 AND bank_transaction_id = $5)
        ORDER BY settlement_id LIMIT 1`,
      [environment, accountRef, withdrawalId, receipt?.receivingAccountRef ?? null, receipt?.bankTransactionId ?? null],
    );
    return r.rows[0]?.settlement_id ?? null;
  }

  /** A live intent (unconsumed or APPLIED) of the withdrawal of the account, or of the receiving bank's transaction (CMD215 R5). */
  async liveRequestOf(environment: string, accountRef: string, withdrawalId: string, receipt: { readonly receivingAccountRef: string; readonly bankTransactionId: string } | null): Promise<string | null> {
    const r = await execute<{ request_id: string }>(
      this.db,
      `SELECT request_id::text AS request_id FROM kauro.settlement_requests
        WHERE (outcome IS NULL OR outcome = 'APPLIED')
          AND ((environment = $1 AND account_ref = $2 AND withdrawal_id = $3)
            OR ($4::text IS NOT NULL AND environment = $1 AND receiving_account_ref = $4 AND bank_transaction_id = $5))
        ORDER BY request_id LIMIT 1`,
      [environment, accountRef, withdrawalId, receipt?.receivingAccountRef ?? null, receipt?.bankTransactionId ?? null],
    );
    return r.rows[0]?.request_id ?? null;
  }

  /**
   * CMD215 R8: records the owner's intent (the session's person and the database clock are stamped by the table's guard) and returns its
   * record instant. A live intent of the same withdrawal or bank transaction committed first (this insert waited on the live index) is
   * the loser's WITHDRAWAL_ALREADY_SETTLED, never a 500.
   */
  async insertRequest(s: NewSettlementRequest): Promise<{ readonly requestedAt: string }> {
    try {
      const r = await execute<{ requested_at: string }>(
        this.db,
        `INSERT INTO kauro.settlement_requests (request_id, environment, account_ref, withdrawal_id, artifact_ref, evidence_hash, currency, gross_cents, fee_cents, held_cents,
                                               withdrawn_cents, period_start, period_end, observed_at, normalizer_version, receipt_artifact_ref, receipt_evidence_hash,
                                               receiving_account_ref, bank_transaction_id, received_cents, bank_available_cents, booked_at, receipt_observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         RETURNING ${iso("requested_at", "requested_at")}`,
        [
          s.requestId,
          s.environment,
          s.accountRef,
          s.withdrawalId,
          s.artifactRef,
          s.evidenceHash,
          s.currency,
          s.grossCents,
          s.feeCents,
          s.heldCents,
          s.withdrawnCents,
          s.periodStart,
          s.periodEnd,
          s.observedAt,
          s.normalizerVersion,
          s.receipt?.artifactRef ?? null,
          s.receipt?.evidenceHash ?? null,
          s.receipt?.receivingAccountRef ?? null,
          s.receipt?.bankTransactionId ?? null,
          s.receipt?.receivedCents ?? null,
          s.receipt?.bankAvailableCents ?? null,
          s.receipt?.bookedAt ?? null,
          s.receipt?.observedAt ?? null,
        ],
      );
      const at = r.rows[0]?.requested_at;
      if (at === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the intent was not recorded");
      return { requestedAt: at };
    } catch (e) {
      if (e instanceof ConstraintViolation && LIVE_REQUEST_IDENTITIES.has(e.constraint ?? "")) throw alreadySettled();
      throw e;
    }
  }

  /** The intent (no lock). */
  async requestOf(requestId: string): Promise<SettlementRequestRow | null> {
    const r = await execute<RequestDbRow>(this.db, `SELECT ${REQUEST_COLUMNS} FROM kauro.settlement_requests r WHERE r.request_id = $1`, [requestId]);
    return r.rows[0] === undefined ? null : requestOfRow(r.rows[0]);
  }

  /** The intent's row lock (FOR NO KEY UPDATE), the apply's last lock (A5): every writer of the row holds the account's locks first. */
  async lockRequest(requestId: string): Promise<SettlementRequestRow | null> {
    const r = await execute<RequestDbRow>(this.db, `SELECT ${REQUEST_COLUMNS} FROM kauro.settlement_requests r WHERE r.request_id = $1 FOR NO KEY UPDATE`, [requestId]);
    return r.rows[0] === undefined ? null : requestOfRow(r.rows[0]);
  }

  /** The database's time judgment of the intent at the exact effect instant (kauro.settlement_request_refusal, µs). */
  async timeRefusal(requestId: string, at: string, staleAfterSeconds: number): Promise<SettlementRefusalReason | null> {
    const r = await execute<{ reason: string | null }>(this.db, "SELECT kauro.settlement_request_refusal($1, $2::timestamptz, make_interval(secs => $3)) AS reason", [requestId, at, staleAfterSeconds]);
    return (r.rows[0]?.reason ?? null) as SettlementRefusalReason | null;
  }

  /** The refusal's review case (SETTLEMENT_REFUSED, the intent its subject, the reason its detail, the settlement record its evidence). */
  async openRefusalCase(caseId: string, request: Pick<SettlementRequestRow, "requestId" | "environment" | "accountRef" | "evidenceHash">, reason: SettlementRefusalReason): Promise<void> {
    await execute(
      this.db,
      `INSERT INTO kauro.bank_review_cases (case_id, kind, environment, account_ref, source_kind, source_id, detail_code, evidence_hash)
       VALUES ($1, 'SETTLEMENT_REFUSED', $2, $3, 'SETTLEMENT_REQUEST', $4, $5, $6)`,
      [caseId, request.environment, request.accountRef, request.requestId, reason, request.evidenceHash],
    );
  }

  /** Consumes the intent as REFUSED with its reason and case (the guard stamps consumed_at and version 2). */
  async refuse(requestId: string, reason: SettlementRefusalReason, caseId: string): Promise<void> {
    const r = await execute(this.db, "UPDATE kauro.settlement_requests SET outcome = 'REFUSED', refusal_reason = $2, review_case_id = $3 WHERE request_id = $1 AND consumed_at IS NULL", [requestId, reason, caseId]);
    if ((r.rowCount ?? 0) !== 1) throw new DomainFailure("STALE_VERSION", "the intent was consumed by another apply");
  }

  /** Consumes the intent as APPLIED with its settlement. */
  async markApplied(requestId: string, settlementId: string): Promise<void> {
    const r = await execute(this.db, "UPDATE kauro.settlement_requests SET outcome = 'APPLIED', settlement_id = $2 WHERE request_id = $1 AND consumed_at IS NULL", [requestId, settlementId]);
    if ((r.rowCount ?? 0) !== 1) throw new DomainFailure("STALE_VERSION", "the intent was consumed by another apply");
  }

  /**
   * Resolves the open SETTLEMENT_REFUSED cases of the earlier refused intents of the same withdrawal (the apply decided them), except
   * EVIDENCE_MISMATCH (ADV-7): artifacts that did not match their frozen facts may be tampering, a later correct apply does not supersede
   * that finding, so the case stays OPEN for a human.
   */
  async resolveRefusedCases(environment: string, accountRef: string, withdrawalId: string): Promise<number> {
    const r = await execute(
      this.db,
      `UPDATE kauro.bank_review_cases c SET state = 'RESOLVED', resolved_at = kauro.server_now()
        WHERE c.kind = 'SETTLEMENT_REFUSED' AND c.state = 'OPEN' AND c.source_kind = 'SETTLEMENT_REQUEST'
          AND c.detail_code IS DISTINCT FROM 'EVIDENCE_MISMATCH'
          AND c.source_id IN (SELECT r.request_id FROM kauro.settlement_requests r WHERE r.environment = $1 AND r.account_ref = $2 AND r.withdrawal_id = $3 AND r.outcome = 'REFUSED')`,
      [environment, accountRef, withdrawalId],
    );
    return r.rowCount ?? 0;
  }

  async insert(s: NewBankSettlement): Promise<void> {
    try {
      await execute(
        this.db,
        `INSERT INTO kauro.settlements (settlement_id, route_id, provider_balance_ref, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, bank_available_cents,
                                        bank_evidence_hash, fx_rate, period_start, period_end, observed_at, evidence_hash, created_at,
                                        environment, account_ref, withdrawal_id, artifact_ref, receiving_account_ref, bank_transaction_id, receipt_artifact_ref, received_cents, normalizer_version, recorded_by, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, $13, $14, date_trunc('milliseconds', $15::timestamptz), $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
        [
          s.settlementId,
          s.paymentRouteId,
          s.bankRouteId,
          s.currency,
          s.grossCents,
          s.feeCents,
          s.heldCents,
          s.withdrawnCents,
          s.receipt?.bankAvailableCents ?? 0n,
          s.receipt?.evidenceHash ?? null,
          s.periodStart,
          s.periodEnd,
          s.observedAt,
          s.evidenceHash,
          s.createdAt,
          s.environment,
          s.accountRef,
          s.withdrawalId,
          s.artifactRef,
          s.receipt?.receivingAccountRef ?? null,
          s.receipt?.bankTransactionId ?? null,
          s.receipt?.artifactRef ?? null,
          s.receipt?.receivedCents ?? null,
          s.normalizerVersion,
          s.recordedBy,
          s.requestId,
        ],
      );
    } catch (e) {
      // a concurrent observation of the same withdrawal or bank transaction committed first (this insert waited on the index)
      if (e instanceof ConstraintViolation && UNIQUE_IDENTITIES.has(e.constraint ?? "")) throw alreadySettled();
      throw e;
    }
  }

  /** The owner's read of one intent of the account (null: no intent of that account). */
  async outcomeOf(environment: string, accountRef: string, requestId: string): Promise<SettlementRequestOutcomeRead | null> {
    const r = await execute<RequestDbRow & { delivery: string }>(
      this.db,
      `SELECT ${REQUEST_COLUMNS}, ${DELIVERY_OF("r")} AS delivery FROM kauro.settlement_requests r WHERE r.request_id = $1 AND r.environment = $2 AND r.account_ref = $3`,
      [requestId, environment, accountRef],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const request = requestOfRow(row);
    let settlement: SettlementRequestOutcomeRead["settlement"] = null;
    if (request.settlementId !== null) {
      const s = await execute<{ settlement_id: string; withdrawal_id: string; currency: string; period_start: string; period_end: string; withdrawn_cents: string; fee_cents: string; received_cents: string | null; bank_available_cents: string; bank: boolean; observed_at: string }>(
        this.db,
        `SELECT settlement_id::text AS settlement_id, withdrawal_id, currency, ${iso("period_start", "period_start")}, ${iso("period_end", "period_end")}, withdrawn_cents::text AS withdrawn_cents,
                fee_cents::text AS fee_cents, received_cents::text AS received_cents, bank_available_cents::text AS bank_available_cents, bank_evidence_hash IS NOT NULL AS bank, ${iso("observed_at", "observed_at")}
           FROM kauro.settlements WHERE settlement_id = $1`,
        [request.settlementId],
      );
      const x = s.rows[0];
      if (x !== undefined) {
        settlement = {
          settlementId: x.settlement_id,
          withdrawalId: x.withdrawal_id,
          currency: x.currency,
          periodStart: x.period_start,
          periodEnd: x.period_end,
          withdrawnCents: BigInt(x.withdrawn_cents),
          feeCents: BigInt(x.fee_cents),
          receivedCents: x.received_cents === null ? null : BigInt(x.received_cents),
          bankAvailableCents: BigInt(x.bank_available_cents),
          bankEvidence: x.bank,
          observedAt: x.observed_at,
        };
      }
    }
    return { request, delivery: row.delivery, settlement };
  }

  /**
   * The account's intents in transit (plan §3.5, coordinator ruling 2026-10-14): every unconsumed intent, whatever its delivery state (a
   * dead letter stays visible), every REFUSED intent whose review case is not RESOLVED, and every APPLIED intent without a receipt (ADV-8: its
   * withdrawal sits in BANK_IN_TRANSIT and no later intent can clear it, one live intent per withdrawal); in record order after the cursor, at most
   * `limit`. The age is the database clock minus the record instant (one clock).
   */
  async inTransit(environment: string, accountRef: string, after: { readonly requestedAt: string; readonly requestId: string } | null, limit: number): Promise<ReadonlyArray<SettlementRequestPageItem>> {
    const r = await execute<{ request_id: string; withdrawal_id: string; outcome: string | null; refusal_reason: string | null; withdrawn_cents: string; received_cents: string | null; fee_cents: string; requested_at: string; age: string; delivery: string; review_case_id: string | null }>(
      this.db,
      `SELECT r.request_id::text AS request_id, r.withdrawal_id, r.outcome, r.refusal_reason, r.withdrawn_cents::text AS withdrawn_cents, r.received_cents::text AS received_cents,
              r.fee_cents::text AS fee_cents, ${iso("r.requested_at", "requested_at")}, extract(epoch FROM kauro.effect_now() - r.requested_at)::text AS age,
              ${DELIVERY_OF("r")} AS delivery, r.review_case_id::text AS review_case_id
         FROM kauro.settlement_requests r
         LEFT JOIN kauro.bank_review_cases c ON c.case_id = r.review_case_id
        WHERE r.environment = $1 AND r.account_ref = $2
          AND (r.outcome IS NULL OR (r.outcome = 'REFUSED' AND c.state IS DISTINCT FROM 'RESOLVED') OR (r.outcome = 'APPLIED' AND r.received_cents IS NULL))
          AND ($3::timestamptz IS NULL OR (r.requested_at, r.request_id) > ($3::timestamptz, $4::uuid))
        ORDER BY r.requested_at, r.request_id
        LIMIT $5`,
      [environment, accountRef, after?.requestedAt ?? null, after?.requestId ?? null, limit],
    );
    return r.rows.map((x) => ({
      requestId: x.request_id,
      withdrawalId: x.withdrawal_id,
      state: x.outcome === "REFUSED" || x.outcome === "APPLIED" ? x.outcome : "RECORDED",
      reason: x.refusal_reason as SettlementRefusalReason | null,
      withdrawnCents: BigInt(x.withdrawn_cents),
      receivedCents: x.received_cents === null ? null : BigInt(x.received_cents),
      feeCents: BigInt(x.fee_cents),
      requestedAt: x.requested_at,
      ageSeconds: Math.max(0, Math.floor(Number(x.age))),
      delivery: x.delivery,
      reviewCaseId: x.review_case_id,
    }));
  }
}

export type { UtcInstant };
