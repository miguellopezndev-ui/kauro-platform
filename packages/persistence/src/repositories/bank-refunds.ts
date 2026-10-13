/**
 * The manual-assisted refund tables of the bank-transfer route over `pg` (migrations 0045, 0055, 0057; lane L-REFUND; docs/design/ACH-ROUTE.md
 * r12 §7.13-§7.22, D-24 A): the outbound stream lock L1, the corporate owner's authority verdict (kauro.bank_owner_authority, the one
 * SECURITY DEFINER judgment of identity, grant and step-up at the database clock), the treasury refund of an unassigned credit and the captured
 * refund destination. Every statement runs in the caller's SERVICE unit of work (kauro_payment) under its policies.
 *
 * Lock order (§7.28): L1 (the account's OUTBOUND advisory lock) first, then the definer's transition locks of the owner's identity and grant,
 * then the refund row. No statement here names a full routing or account number: a destination row carries its keyed fingerprint, the last
 * four of the account and the holder's display name only (DV1-10, DV1-11).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { execute, instant, int, type Queryable } from "../sql.js";

/** The corporate owner's authority as the definer judged it at the database clock (an act row recorded for OK). */
export interface OwnerAuthorityRow {
  readonly verdict: "OK" | "IDENTITY_DISABLED" | "CORPORATE_ROLE_MISSING" | "STEP_UP_MISSING" | "STEP_UP_NOT_OWNED" | "STEP_UP_STALE";
  readonly issuedAt: UtcInstant | null;
  readonly expiresAt: UtcInstant | null;
}

export interface TreasuryRefundRow {
  readonly treasuryRefundId: string;
  readonly routeId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly bankCreditId: string;
  readonly amountCents: bigint;
  readonly state: "REQUESTED" | "APPROVED" | "SUBMITTING" | "UNCERTAIN" | "COMPLETED" | "FAILED" | "REJECTED";
  readonly version: number;
  readonly approvedByUserId: string | null;
  readonly approvedAt: UtcInstant | null;
}

export interface NewRefundDestination {
  readonly destinationId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly sourceKind: "CAPTURE" | "BANK_CREDIT";
  readonly agencyId: string | null;
  readonly refundId: string | null;
  readonly treasuryRefundId: string | null;
  readonly evidenceArtifactRef: string;
  readonly evidenceHash: string;
  readonly fingerprint: Sha256Hex;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly normVersion: string;
  readonly accountLast4: string;
  readonly holderName: string;
  readonly capturedBy: string;
}

export interface TreasuryApproval {
  readonly approvedByUserId: string;
  readonly authorizationProofRef: string;
  readonly authorizationHash: Sha256Hex;
  readonly approvedAt: UtcInstant;
}

interface TreasuryRow {
  treasury_refund_id: string;
  route_id: string;
  environment: "SANDBOX" | "LIVE";
  account_ref: string;
  bank_credit_id: string;
  amount_cents: string;
  state: TreasuryRefundRow["state"];
  version: string;
  approved_by_user_id: string | null;
  approved_at: Date | null;
}
const TREASURY_COLUMNS = "treasury_refund_id, route_id, environment, account_ref, bank_credit_id, amount_cents::text AS amount_cents, state, version, approved_by_user_id, approved_at";

function treasuryOf(r: TreasuryRow): TreasuryRefundRow {
  return {
    treasuryRefundId: r.treasury_refund_id,
    routeId: r.route_id,
    environment: r.environment,
    accountRef: r.account_ref,
    bankCreditId: r.bank_credit_id,
    amountCents: BigInt(r.amount_cents),
    state: r.state,
    version: int(r.version),
    approvedByUserId: r.approved_by_user_id,
    approvedAt: r.approved_at === null ? null : instant(r.approved_at),
  };
}

export class PgBankRefunds {
  constructor(private readonly db: Queryable) {}

  /** L1: the account's OUTBOUND stream lock (transaction-scoped advisory lock; §7.28), the first lock of every owner refund command. */
  async lockOutboundStream(environment: string, accountRef: string): Promise<void> {
    await execute(this.db, "SELECT pg_advisory_xact_lock(kauro.bank_stream_lock_key($1, $2, 'OUTBOUND'))", [environment, accountRef]);
  }

  /**
   * The owner's authority judged by the definer at the database clock after its transition locks (identity, then grant): OK records the
   * act of this transaction that the journal, the refund review trigger and the treasury trigger require. A proof id that is not a UUID is
   * passed as NULL (STEP_UP_MISSING).
   */
  async ownerAuthority(userId: string, proofId: string | null, freshnessSeconds: number): Promise<OwnerAuthorityRow> {
    const r = await execute<{ verdict: OwnerAuthorityRow["verdict"]; issued_at: Date | null; expires_at: Date | null }>(
      this.db,
      "SELECT verdict, issued_at, expires_at FROM kauro.bank_owner_authority($1::uuid, $2::uuid, $3::integer)",
      [userId, proofId, freshnessSeconds],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error("the owner authority answered no verdict");
    return { verdict: row.verdict, issuedAt: row.issued_at === null ? null : instant(row.issued_at), expiresAt: row.expires_at === null ? null : instant(row.expires_at) };
  }

  async treasuryRefund(treasuryRefundId: string): Promise<TreasuryRefundRow | null> {
    const r = await execute<TreasuryRow>(this.db, `SELECT ${TREASURY_COLUMNS} FROM kauro.treasury_refunds WHERE treasury_refund_id = $1`, [treasuryRefundId]);
    return r.rows[0] ? treasuryOf(r.rows[0]) : null;
  }

  async lockTreasuryRefund(treasuryRefundId: string): Promise<TreasuryRefundRow | null> {
    const r = await execute<TreasuryRow>(this.db, `SELECT ${TREASURY_COLUMNS} FROM kauro.treasury_refunds WHERE treasury_refund_id = $1 FOR UPDATE`, [treasuryRefundId]);
    return r.rows[0] ? treasuryOf(r.rows[0]) : null;
  }

  /** REQUESTED → APPROVED at expectedVersion (+1); null when the row moved meanwhile (the caller answers its current version). */
  async approveTreasuryRefund(treasuryRefundId: string, expectedVersion: number, approval: TreasuryApproval): Promise<TreasuryRefundRow | null> {
    const r = await execute<TreasuryRow>(
      this.db,
      `UPDATE kauro.treasury_refunds SET state = 'APPROVED', version = version + 1, approved_by_user_id = $3, authorization_proof_ref = $4, authorization_hash = $5, approved_at = $6
        WHERE treasury_refund_id = $1 AND version = $2 AND state = 'REQUESTED'
        RETURNING ${TREASURY_COLUMNS}`,
      [treasuryRefundId, expectedVersion, approval.approvedByUserId, approval.authorizationProofRef, approval.authorizationHash, approval.approvedAt],
    );
    return r.rows[0] ? treasuryOf(r.rows[0]) : null;
  }

  /** The captured destination of a refund (CAPTURE) or treasury refund (BANK_CREDIT): its fingerprint parameters, never the numbers. */
  async destinationOf(sourceKind: "CAPTURE" | "BANK_CREDIT", id: string): Promise<{ readonly destinationId: string; readonly fingerprint: Sha256Hex; readonly keyId: string; readonly keyVersion: number; readonly normVersion: string; readonly accountLast4: string } | null> {
    const column = sourceKind === "CAPTURE" ? "refund_id" : "treasury_refund_id";
    const r = await execute<{ destination_id: string; destination_fingerprint: string; fingerprint_key_id: string; fingerprint_key_version: number; fingerprint_norm_version: string; account_last4: string }>(
      this.db,
      `SELECT destination_id, destination_fingerprint, fingerprint_key_id, fingerprint_key_version, fingerprint_norm_version, account_last4 FROM kauro.refund_destinations WHERE ${column} = $1`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined
      ? null
      : { destinationId: row.destination_id, fingerprint: row.destination_fingerprint as Sha256Hex, keyId: row.fingerprint_key_id, keyVersion: int(row.fingerprint_key_version), normVersion: row.fingerprint_norm_version, accountLast4: row.account_last4 };
  }

  async insertDestination(d: NewRefundDestination): Promise<void> {
    await execute(
      this.db,
      `INSERT INTO kauro.refund_destinations (destination_id, environment, source_kind, agency_id, refund_id, treasury_refund_id, evidence_artifact_ref, evidence_hash,
         destination_fingerprint, fingerprint_key_id, fingerprint_key_version, fingerprint_norm_version, account_last4, holder_name, captured_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [d.destinationId, d.environment, d.sourceKind, d.agencyId, d.refundId, d.treasuryRefundId, d.evidenceArtifactRef, d.evidenceHash, d.fingerprint, d.keyId, d.keyVersion, d.normVersion, d.accountLast4, d.holderName, d.capturedBy],
    );
  }
}
