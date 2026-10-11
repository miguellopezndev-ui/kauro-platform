/**
 * The inbound side of the bank-transfer route over `pg` (migration 0057, lane PV1-INBOUND; docs/design/ACH-ROUTE.md r12 §7.5-§7.12,
 * §7.23, §7.28): credits, the account's stream locks, an instruction found by its reference, the bank order state, statement imports,
 * their coverage and lines, and the route-scope review cases. Every statement runs in the caller's unit of work under its policies: the
 * payment service's pool (kauro_payment) for the owner's commands and for the service steps alike.
 *
 * Locks: `lockStream` is the account's INBOUND or OUTBOUND stream advisory lock (kauro.bank_stream_lock_key, §7.28 L1/L2); the credit
 * identity lock Lc is the credit's row lock (`lockCredit`), taken after the stream lock.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { BankCreditRecord, BankTransferInstructionRecord } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { ConstraintViolation, execute, instant, int, type Queryable } from "../sql.js";

interface CreditRow {
  bank_credit_id: string;
  environment: "SANDBOX" | "LIVE";
  account_ref: string;
  bank_transaction_id: string;
  state: BankCreditRecord["state"];
  version: string;
  rail: BankCreditRecord["rail"];
  currency: "USD";
  gross_cents: string;
  net_cents: string | null;
  fee_cents: string | null;
  reference: string | null;
  booked_at: Date | null;
  evidence_hash: string;
  payer_digest: string | null;
  payee_digest: string | null;
  artifact_ref: string | null;
  order_id: string | null;
  capture_id: string | null;
}
const CREDIT_COLUMNS =
  "bank_credit_id, environment, account_ref, bank_transaction_id, state, version, rail, currency, gross_cents, net_cents, fee_cents, reference, booked_at, evidence_hash, payer_digest, payee_digest, artifact_ref, order_id, capture_id";

function creditOf(r: CreditRow): BankCreditRecord {
  return {
    creditId: r.bank_credit_id,
    environment: r.environment,
    accountRef: r.account_ref,
    bankTransactionId: r.bank_transaction_id,
    state: r.state,
    version: int(r.version),
    rail: r.rail,
    currency: r.currency,
    grossCents: BigInt(r.gross_cents),
    netCents: r.net_cents === null ? null : BigInt(r.net_cents),
    feeCents: r.fee_cents === null ? null : BigInt(r.fee_cents),
    reference: r.reference,
    bookedAt: r.booked_at === null ? null : instant(r.booked_at),
    evidenceHash: r.evidence_hash as Sha256Hex,
    payerDigest: r.payer_digest as Sha256Hex | null,
    payeeDigest: r.payee_digest as Sha256Hex | null,
    artifactRef: r.artifact_ref,
    orderId: r.order_id,
    captureId: r.capture_id,
  };
}

export interface NewBankCredit {
  readonly creditId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly bankTransactionId: string;
  readonly state: "DRAFT_MANUAL" | "OBSERVED";
  readonly rail: BankCreditRecord["rail"];
  readonly grossCents: bigint;
  readonly netCents: bigint | null;
  readonly feeCents: bigint | null;
  readonly reference: string | null;
  readonly bookedAt: string | null;
  readonly evidenceHash: string;
  readonly payerDigest: string | null;
  readonly payeeDigest: string | null;
  readonly artifactRef: string | null;
  readonly createdBy: string | null;
}

/** The columns a credit's change may set; unnamed ones stay. */
export interface BankCreditChange {
  readonly state: BankCreditRecord["state"];
  readonly netCents?: bigint | null;
  readonly feeCents?: bigint | null;
  readonly payerDigest?: string | null;
  readonly payeeDigest?: string | null;
  readonly reference?: string | null;
  readonly bookedAt?: string | null;
  readonly orderId?: string;
  readonly captureId?: string;
}

export type BankCreditWrite = { readonly kind: "APPLIED"; readonly record: BankCreditRecord } | { readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string };

interface InstructionRow {
  order_id: string;
  agency_id: string;
  route_id: string;
  route_version: number;
  environment: "SANDBOX" | "LIVE";
  account_ref: string;
  reference: string;
  amount_cents: string;
  currency: "USD";
  order_state: string;
  transfer_expires_at: Date;
  send_by: Date;
  issued_at: Date;
  version: string;
}
const INSTRUCTION_COLUMNS = "order_id, agency_id, route_id, route_version, environment, account_ref, reference, amount_cents, currency, order_state, transfer_expires_at, send_by, issued_at, version";
const instructionOf = (r: InstructionRow): BankTransferInstructionRecord => ({
  orderId: r.order_id,
  agencyId: r.agency_id,
  routeId: r.route_id,
  routeVersion: int(r.route_version),
  environment: r.environment,
  accountRef: r.account_ref,
  reference: r.reference,
  amountCents: BigInt(r.amount_cents),
  currency: r.currency,
  orderState: r.order_state,
  transferExpiresAt: instant(r.transfer_expires_at),
  sendBy: instant(r.send_by),
  issuedAt: instant(r.issued_at),
  version: int(r.version),
});

export type BankStream = "INBOUND" | "OUTBOUND";

export class PgBankCredits {
  constructor(private readonly db: Queryable) {}

  /** The account's stream lock (pg_advisory_xact_lock of kauro.bank_stream_lock_key), held to COMMIT (or the enclosing savepoint's rollback). */
  async lockStream(environment: string, accountRef: string, stream: BankStream): Promise<void> {
    await execute(this.db, "SELECT pg_advisory_xact_lock(kauro.bank_stream_lock_key($1, $2, $3))", [environment, accountRef, stream]);
  }

  async credit(creditId: string): Promise<BankCreditRecord | null> {
    const r = await execute<CreditRow>(this.db, `SELECT ${CREDIT_COLUMNS} FROM kauro.bank_credits WHERE bank_credit_id = $1`, [creditId]);
    return r.rows[0] ? creditOf(r.rows[0]) : null;
  }

  /** The credit identity lock Lc: the credit's row, FOR UPDATE, held to COMMIT. */
  async lockCredit(creditId: string): Promise<BankCreditRecord | null> {
    const r = await execute<CreditRow>(this.db, `SELECT ${CREDIT_COLUMNS} FROM kauro.bank_credits WHERE bank_credit_id = $1 FOR UPDATE`, [creditId]);
    return r.rows[0] ? creditOf(r.rows[0]) : null;
  }

  async creditByTransaction(environment: string, accountRef: string, bankTransactionId: string, lock = false): Promise<BankCreditRecord | null> {
    const r = await execute<CreditRow>(
      this.db,
      `SELECT ${CREDIT_COLUMNS} FROM kauro.bank_credits WHERE environment = $1 AND account_ref = $2 AND bank_transaction_id = $3${lock ? " FOR UPDATE" : ""}`,
      [environment, accountRef, bankTransactionId],
    );
    return r.rows[0] ? creditOf(r.rows[0]) : null;
  }

  /** The draft or the observed credit; false when another credit of the account carries the bank transaction id. */
  async insertCredit(c: NewBankCredit): Promise<BankCreditRecord | null> {
    const r = await execute<CreditRow>(
      this.db,
      `INSERT INTO kauro.bank_credits (bank_credit_id, environment, account_ref, bank_transaction_id, state, version, rail, currency, gross_cents, net_cents, fee_cents, reference, booked_at,
         evidence_hash, payer_digest, payee_digest, artifact_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, 1, $6, 'USD', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (environment, account_ref, bank_transaction_id) DO NOTHING RETURNING ${CREDIT_COLUMNS}`,
      [
        c.creditId,
        c.environment,
        c.accountRef,
        c.bankTransactionId,
        c.state,
        c.rail,
        c.grossCents.toString(),
        c.netCents === null ? null : c.netCents.toString(),
        c.feeCents === null ? null : c.feeCents.toString(),
        c.reference,
        c.bookedAt,
        c.evidenceHash,
        c.payerDigest,
        c.payeeDigest,
        c.artifactRef,
        c.createdBy,
      ],
    );
    return r.rows[0] ? creditOf(r.rows[0]) : null;
  }

  /** Compare-and-swap at `expectedVersion`: the credit's next version with the change; STALE answers the row as it stands. */
  async transitionCredit(creditId: string, expectedVersion: number, change: BankCreditChange): Promise<BankCreditWrite> {
    const sets: string[] = ["state = $3", "version = version + 1"];
    const params: unknown[] = [creditId, expectedVersion, change.state];
    const set = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.netCents !== undefined) set("net_cents", change.netCents === null ? null : change.netCents.toString());
    if (change.feeCents !== undefined) set("fee_cents", change.feeCents === null ? null : change.feeCents.toString());
    if (change.payerDigest !== undefined) set("payer_digest", change.payerDigest);
    if (change.payeeDigest !== undefined) set("payee_digest", change.payeeDigest);
    if (change.reference !== undefined) set("reference", change.reference);
    if (change.bookedAt !== undefined) set("booked_at", change.bookedAt);
    if (change.orderId !== undefined) set("order_id", change.orderId);
    if (change.captureId !== undefined) set("capture_id", change.captureId);
    try {
      const r = await execute<CreditRow>(this.db, `UPDATE kauro.bank_credits SET ${sets.join(", ")} WHERE bank_credit_id = $1 AND version = $2 RETURNING ${CREDIT_COLUMNS}`, params);
      if (r.rows[0]) return { kind: "APPLIED", record: creditOf(r.rows[0]) };
    } catch (e) {
      if (e instanceof ConstraintViolation) throw new DomainFailure("PRECONDITION_FAILED", "the credit cannot leave its state this way", { reason: "UNLISTED_TRANSITION" });
      throw e;
    }
    const now = await this.credit(creditId);
    if (now === null) throw new DomainFailure("INTEGRITY_FAILURE", "the credit vanished under its lock");
    return { kind: "STALE", currentVersion: now.version, currentState: now.state };
  }

  /** The sum already applied to an order by credits other than `exceptCreditId` (principal, gross). */
  async appliedCentsOf(orderId: string, exceptCreditId: string): Promise<bigint> {
    const r = await execute<{ s: string }>(this.db, "SELECT coalesce(sum(gross_cents), 0)::text AS s FROM kauro.bank_credits WHERE order_id = $1 AND state = 'APPLIED' AND bank_credit_id <> $2", [orderId, exceptCreditId]);
    return BigInt(r.rows[0]!.s);
  }

  // --- instructions ---------------------------------------------------------------------------------------------------------------

  /** M1's lookup: the order the 23-character reference names on this account (before any agency is adopted). */
  async instructionByReference(environment: string, accountRef: string, reference: string): Promise<BankTransferInstructionRecord | null> {
    const r = await execute<InstructionRow>(
      this.db,
      `SELECT ${INSTRUCTION_COLUMNS} FROM kauro.bank_transfer_instructions WHERE environment = $1 AND account_ref = $2 AND reference = $3`,
      [environment, accountRef, reference],
    );
    return r.rows[0] ? instructionOf(r.rows[0]) : null;
  }

  async instruction(orderId: string, lock = false): Promise<BankTransferInstructionRecord | null> {
    const r = await execute<InstructionRow>(this.db, `SELECT ${INSTRUCTION_COLUMNS} FROM kauro.bank_transfer_instructions WHERE order_id = $1${lock ? " FOR UPDATE" : ""}`, [orderId]);
    return r.rows[0] ? instructionOf(r.rows[0]) : null;
  }

  /** The instructions whose deadline passed and whose bank order state is still open (E1's candidates), oldest first. */
  async expiredCandidates(now: UtcInstant, limit: number): Promise<ReadonlyArray<BankTransferInstructionRecord>> {
    const r = await execute<InstructionRow>(
      this.db,
      `SELECT ${INSTRUCTION_COLUMNS} FROM kauro.bank_transfer_instructions WHERE order_state IN ('AWAITING_TRANSFER', 'PARTIALLY_RECEIVED') AND transfer_expires_at <= $1 ORDER BY transfer_expires_at, order_id LIMIT $2`,
      [now, limit],
    );
    return r.rows.map(instructionOf);
  }

  /** The bank order state's next version (one event per version is the caller's); STALE-free: the caller holds the order's lock. */
  async setOrderState(orderId: string, expectedVersion: number, orderState: string): Promise<BankTransferInstructionRecord> {
    const r = await execute<InstructionRow>(
      this.db,
      `UPDATE kauro.bank_transfer_instructions SET order_state = $3, version = version + 1 WHERE order_id = $1 AND version = $2 RETURNING ${INSTRUCTION_COLUMNS}`,
      [orderId, expectedVersion, orderState],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("STALE_VERSION", "the bank order changed concurrently", {}, true);
    return instructionOf(row);
  }

  /** The environments an account ref is a route of (one in practice; the caller refuses an ambiguous ref). */
  async environmentsOfAccount(accountRef: string): Promise<ReadonlyArray<"SANDBOX" | "LIVE">> {
    const r = await execute<{ environment: "SANDBOX" | "LIVE" }>(this.db, "SELECT environment FROM kauro.bank_routes WHERE account_ref = $1 ORDER BY environment", [accountRef]);
    return r.rows.map((x) => x.environment);
  }

  /** The accepted billing identity (sha256) the order's instructions froze at issuance, null when none was frozen. */
  async acceptedPayerDigestOf(orderId: string): Promise<Sha256Hex | null> {
    const r = await execute<{ d: string | null }>(this.db, "SELECT accepted_payer_digest AS d FROM kauro.bank_transfer_instructions WHERE order_id = $1", [orderId]);
    return (r.rows[0]?.d ?? null) as Sha256Hex | null;
  }

  // --- route-scope review cases -----------------------------------------------------------------------------------------------------

  /** Opens the credit's review case of `kind`; false when one is already open for it (the unique index of migration 0045). */
  async openCreditCase(caseId: string, kind: "MATCH_REVIEW" | "PROVIDER_TIME_UNVERIFIED", credit: Pick<BankCreditRecord, "creditId" | "environment" | "accountRef" | "evidenceHash">, detailCode: string): Promise<boolean> {
    const r = await execute(
      this.db,
      `INSERT INTO kauro.bank_review_cases (case_id, kind, environment, account_ref, source_kind, source_id, detail_code, evidence_hash)
       VALUES ($1, $2, $3, $4, 'BANK_CREDIT', $5, $6, $7) ON CONFLICT DO NOTHING`,
      [caseId, kind, credit.environment, credit.accountRef, credit.creditId, detailCode, credit.evidenceHash],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Resolves the open review cases of the credit (its owner attribution or return decided them). */
  async resolveCreditCases(creditId: string): Promise<number> {
    const r = await execute(this.db, "UPDATE kauro.bank_review_cases SET state = 'RESOLVED', resolved_at = kauro.server_now() WHERE source_kind = 'BANK_CREDIT' AND source_id = $1 AND state = 'OPEN'", [creditId]);
    return r.rowCount ?? 0;
  }

  /** Runs `work` under a savepoint rolled back once it settled: every lock it took is released, nothing it wrote survives. */
  async released<T>(work: () => Promise<T>): Promise<T> {
    await execute(this.db, "SAVEPOINT kauro_bank_inbound_released");
    try {
      return await work();
    } finally {
      await execute(this.db, "ROLLBACK TO SAVEPOINT kauro_bank_inbound_released");
      await execute(this.db, "RELEASE SAVEPOINT kauro_bank_inbound_released");
    }
  }
}
