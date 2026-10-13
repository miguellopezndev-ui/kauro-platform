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

export interface NewStatementImport {
  readonly importId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly normalizerVersion: string;
  readonly idempotencyKey: string;
  readonly importedBy: string;
}

/** One statement line as the classified artifact states it (destination: digests, last digits and provider references only). */
export interface NewStatementLine {
  readonly lineId: string;
  readonly importId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly lineKind: "CREDIT" | "DEBIT";
  readonly bankLineId: string;
  readonly bankExecutionId: string | null;
  readonly amountCents: bigint | null;
  readonly feeCents: bigint | null;
  readonly currency: string;
  readonly reference: string | null;
  readonly status: string;
  readonly executedAt: string | null;
  readonly bookedAt: string | null;
  readonly observedAt: string;
  readonly destinationAccountDigest: string | null;
  readonly destinationAccountLast4: string | null;
  readonly destinationRoutingDigest: string | null;
  readonly recipientRef: string | null;
  readonly recipientVersion: string | null;
  readonly evidenceHash: string;
}

export type StatementLineWrite = { readonly kind: "NEW" | "SAME"; readonly lineId: string; readonly linkedAttemptId: string | null } | { readonly kind: "DIFFERENT" };

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

  /**
   * The instructions whose deadline passed and whose bank order state is still open (E1's candidates), oldest first; after `after` (the
   * last candidate a pass took, by deadline then order id) when given, so a pass never takes an order twice.
   */
  async expiredCandidates(now: UtcInstant, limit: number, after: { readonly transferExpiresAt: string; readonly orderId: string } | null = null): Promise<ReadonlyArray<BankTransferInstructionRecord>> {
    const r = await execute<InstructionRow>(
      this.db,
      `SELECT ${INSTRUCTION_COLUMNS} FROM kauro.bank_transfer_instructions WHERE order_state IN ('AWAITING_TRANSFER', 'PARTIALLY_RECEIVED') AND transfer_expires_at <= $1${after === null ? "" : " AND (transfer_expires_at, order_id) > ($3::timestamptz, $4::uuid)"} ORDER BY transfer_expires_at, order_id LIMIT $2`,
      after === null ? [now, limit] : [now, limit, after.transferExpiresAt, after.orderId],
    );
    return r.rows.map(instructionOf);
  }

  /**
   * Releases the project's open checkout of an order whose bank state is EXPIRED (payment_orders.bank_slot_released_at, migration 0057):
   * set once, in the unit that expired it, under the order's lock; a second call changes nothing.
   */
  async releaseBankSlot(orderId: string): Promise<void> {
    await execute(this.db, "UPDATE kauro.payment_orders SET bank_slot_released_at = kauro.effect_now() WHERE order_id = $1 AND bank_slot_released_at IS NULL", [orderId]);
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

  /** Sets the bank order's state to EXPIRED with its cause (one version; the caller holds the instruction's row lock and publishes the event). */
  async expireOrder(orderId: string, expectedVersion: number, cause: "DEADLINE" | "RETIRED"): Promise<BankTransferInstructionRecord> {
    const r = await execute<InstructionRow>(
      this.db,
      `UPDATE kauro.bank_transfer_instructions SET order_state = 'EXPIRED', expiry_cause = $3, version = version + 1 WHERE order_id = $1 AND version = $2 RETURNING ${INSTRUCTION_COLUMNS}`,
      [orderId, expectedVersion, cause],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("STALE_VERSION", "the bank order changed concurrently", {}, true);
    return instructionOf(row);
  }

  /** Why an EXPIRED bank order expired (its deadline or its retirement), null while it has not. */
  async expiryCauseOf(orderId: string): Promise<"DEADLINE" | "RETIRED" | null> {
    const r = await execute<{ c: "DEADLINE" | "RETIRED" | null }>(this.db, "SELECT expiry_cause AS c FROM kauro.bank_transfer_instructions WHERE order_id = $1", [orderId]);
    return r.rows[0]?.c ?? null;
  }

  /** The instant the database stamped when the credit was confirmed (OBSERVED), null for a draft. */
  async confirmedAtOf(creditId: string): Promise<UtcInstant | null> {
    const r = await execute<{ t: Date | null }>(this.db, "SELECT confirmed_at AS t FROM kauro.bank_credits WHERE bank_credit_id = $1", [creditId]);
    const t = r.rows[0]?.t ?? null;
    return t === null ? null : instant(t);
  }

  /** Whether another quote of the project holds a live (not REVOKED) entitlement: another purchase of the same project. */
  async anotherLivePurchase(agencyId: string, projectId: string, quoteId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.commercial_authorizations WHERE agency_id = $1 AND project_id = $2 AND quote_id <> $3 AND state <> 'REVOKED' LIMIT 1", [agencyId, projectId, quoteId]);
    return r.rows.length > 0;
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

  // --- statement imports (SI2, §7.23) ------------------------------------------------------------------------------------------------

  /** The import of the same artifact (its evidence hash) in the account, if any. */
  async importOfArtifact(environment: string, accountRef: string, evidenceHash: string): Promise<string | null> {
    const r = await execute<{ id: string }>(this.db, "SELECT import_id AS id FROM kauro.statement_imports WHERE environment = $1 AND account_ref = $2 AND evidence_hash = $3", [environment, accountRef, evidenceHash]);
    return r.rows[0]?.id ?? null;
  }

  /**
   * The earliest instant a statement of the account may cover: the first route version of the account in the environment, less that
   * version's provider-time tolerance (a bank's booking clock may precede the platform's by it, DV1-06); null when the account has none.
   */
  async coverageFloorOf(environment: string, accountRef: string): Promise<UtcInstant | null> {
    const r = await execute<{ t: Date | null }>(
      this.db,
      `SELECT min(v.created_at - v.provider_time_tolerance_ms * interval '1 millisecond') AS t
         FROM kauro.bank_route_versions v JOIN kauro.bank_routes r USING (route_id)
        WHERE r.environment = $1 AND r.account_ref = $2`,
      [environment, accountRef],
    );
    const t = r.rows[0]?.t ?? null;
    return t === null ? null : instant(t);
  }

  async insertImport(i: NewStatementImport): Promise<void> {
    await execute(
      this.db,
      `INSERT INTO kauro.statement_imports (import_id, environment, account_ref, artifact_ref, evidence_hash, normalizer_version, idempotency_key, imported_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [i.importId, i.environment, i.accountRef, i.artifactRef, i.evidenceHash, i.normalizerVersion, i.idempotencyKey, i.importedBy],
    );
  }

  async insertCoverage(importId: string, stream: BankStream, from: string, to: string): Promise<void> {
    await execute(this.db, "INSERT INTO kauro.statement_coverage (import_id, stream, covered_from, covered_to) VALUES ($1, $2, $3, $4)", [importId, stream, from, to]);
  }

  /**
   * Records one line by the bank's own line identity: NEW when first seen, SAME when an identical line is already recorded (nothing
   * changes), DIFFERENT when the recorded line carries other immutable money fields (never overwritten).
   */
  async recordLine(l: NewStatementLine): Promise<StatementLineWrite> {
    const amount = l.amountCents === null ? null : l.amountCents.toString();
    const inserted = await execute<{ id: string }>(
      this.db,
      `INSERT INTO kauro.statement_lines (line_id, import_id, environment, account_ref, line_kind, bank_line_id, bank_execution_id, amount_cents, fee_cents, currency, reference,
         status, executed_at, booked_at, observed_at, destination_account_digest, destination_account_last4, destination_routing_digest, recipient_ref, recipient_version, evidence_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       ON CONFLICT (environment, account_ref, line_kind, bank_line_id) DO NOTHING RETURNING line_id AS id`,
      [
        l.lineId,
        l.importId,
        l.environment,
        l.accountRef,
        l.lineKind,
        l.bankLineId,
        l.bankExecutionId,
        amount,
        l.feeCents === null ? null : l.feeCents.toString(),
        l.currency,
        l.reference,
        l.status,
        l.executedAt,
        l.bookedAt,
        l.observedAt,
        l.destinationAccountDigest,
        l.destinationAccountLast4,
        l.destinationRoutingDigest,
        l.recipientRef,
        l.recipientVersion,
        l.evidenceHash,
      ],
    );
    if (inserted.rows[0]) return { kind: "NEW", lineId: inserted.rows[0].id, linkedAttemptId: null };
    const r = await execute<{ id: string; a: string | null; c: string; x: string | null; ref: string | null; l: string | null }>(
      this.db,
      `SELECT line_id AS id, amount_cents::text AS a, currency AS c, bank_execution_id AS x, reference AS ref, linked_attempt_id::text AS l
         FROM kauro.statement_lines WHERE environment = $1 AND account_ref = $2 AND line_kind = $3 AND bank_line_id = $4 FOR UPDATE`,
      [l.environment, l.accountRef, l.lineKind, l.bankLineId],
    );
    const seen = r.rows[0];
    if (seen === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a statement line conflicted and is not readable");
    if (seen.a !== amount || seen.c !== l.currency || seen.x !== l.bankExecutionId || seen.ref !== l.reference) return { kind: "DIFFERENT" };
    return { kind: "SAME", lineId: seen.id, linkedAttemptId: seen.l };
  }

  /** The RECORDED execution attempt of the account carrying the bank execution id, locked (the execution identity lock), if any. */
  async recordedAttemptOf(environment: string, accountRef: string, bankExecutionId: string): Promise<string | null> {
    const r = await execute<{ id: string }>(
      this.db,
      "SELECT attempt_id AS id FROM kauro.outbound_execution_attempts WHERE environment = $1 AND account_ref = $2 AND bank_execution_id = $3 AND state = 'RECORDED' FOR UPDATE",
      [environment, accountRef, bankExecutionId],
    );
    return r.rows[0]?.id ?? null;
  }

  /** Whether any execution attempt was declared with the reference (a declaration precedes every Kauro refund execution). */
  async attemptDeclaredWith(reference: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.outbound_execution_attempts WHERE reference = $1", [reference]);
    return r.rows.length > 0;
  }

  /** Links a debit line to the RECORDED attempt that explains it (set once). */
  async linkLine(lineId: string, attemptId: string): Promise<void> {
    const r = await execute(this.db, "UPDATE kauro.statement_lines SET linked_attempt_id = $2 WHERE line_id = $1 AND linked_attempt_id IS NULL", [lineId, attemptId]);
    if ((r.rowCount ?? 0) !== 1) throw new DomainFailure("INTEGRITY_FAILURE", "the statement line is already linked");
  }

  /** Opens the line's review case of `kind`; false when one is already open for it. */
  async openLineCase(caseId: string, kind: "RECORD_REQUIRED" | "UNDECLARED_OUTBOUND", line: { readonly environment: string; readonly accountRef: string; readonly lineId: string; readonly evidenceHash: string }, detailCode: string): Promise<boolean> {
    const r = await execute(
      this.db,
      `INSERT INTO kauro.bank_review_cases (case_id, kind, environment, account_ref, line_id, detail_code, evidence_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [caseId, kind, line.environment, line.accountRef, line.lineId, detailCode, line.evidenceHash],
    );
    return (r.rowCount ?? 0) > 0;
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
