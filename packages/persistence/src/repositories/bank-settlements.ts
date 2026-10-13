/**
 * The settlement observation of the bank-transfer route over `pg` (migration 0062, lane PV1-SETTLE; docs/design/ACH-ROUTE.md r12 §7.25,
 * docs/design/PV1-SETTLE.md D-SET-4/5): the route of an account, the settlement already recorded for a withdrawal or a bank transaction,
 * the route's provider-available balance (kauro.route_provider_available_cents) and the append of one observation. Every statement runs in
 * the caller's unit of work on the payment service's pool (kauro_payment), with no agency adopted.
 *
 * Locks: `lockFunds` is the payout cash basis lock (`kauro.payout-cash`, CMD052's, 0043); the caller takes it after the account's stream
 * locks (§7.28) and before it reads the balance it judges.
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
  readonly createdAt: UtcInstant;
}

/** One settlement per withdrawal and per bank transaction (D-SET-4): the second is refused, never a second row. */
const alreadySettled = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "the withdrawal or its bank transaction is already settled", { reason: "WITHDRAWAL_ALREADY_SETTLED" });
const UNIQUE_IDENTITIES = new Set(["settlements_one_per_withdrawal", "settlements_one_per_bank_transaction"]);

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

  async insert(s: NewBankSettlement): Promise<void> {
    try {
      await execute(
        this.db,
        `INSERT INTO kauro.settlements (settlement_id, route_id, provider_balance_ref, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, bank_available_cents,
                                        bank_evidence_hash, fx_rate, period_start, period_end, observed_at, evidence_hash, created_at,
                                        environment, account_ref, withdrawal_id, artifact_ref, receiving_account_ref, bank_transaction_id, receipt_artifact_ref, received_cents, normalizer_version, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
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
        ],
      );
    } catch (e) {
      // a concurrent observation of the same withdrawal or bank transaction committed first (this insert waited on the index)
      if (e instanceof ConstraintViolation && UNIQUE_IDENTITIES.has(e.constraint ?? "")) throw alreadySettled();
      throw e;
    }
  }
}
