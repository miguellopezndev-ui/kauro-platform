/**
 * The manual-assisted refund tables of the bank-transfer route over `pg` (migrations 0045, 0055, 0071; lane L-REFUND; docs/design/ACH-ROUTE.md
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

export interface CapturedDestinationRow {
  readonly destinationId: string;
  readonly fingerprint: Sha256Hex;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly normVersion: string;
  readonly accountLast4: string;
  readonly holderName: string;
}

/** One outbound execution attempt (migration 0045; DV1-08): what its declaration froze and what its record learned. */
export interface ExecutionAttemptRow {
  readonly attemptId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly kind: "RETURN" | "RESEND";
  readonly state: "DECLARED" | "UNCERTAIN" | "RECORDED" | "NOT_EXECUTED";
  readonly version: number;
  readonly sourceKind: "CAPTURE" | "BANK_CREDIT";
  readonly agencyId: string | null;
  readonly captureId: string | null;
  readonly refundId: string | null;
  readonly bankCreditId: string | null;
  readonly treasuryRefundId: string | null;
  readonly sourceId: string;
  /** RESEND: the bounce whose payable it re-sends; RETURN: null. */
  readonly parentBounceId: string | null;
  readonly attemptNumber: number;
  readonly reference: string;
  readonly amountCents: bigint;
  readonly currency: "USD";
  readonly declaredAt: UtcInstant;
  readonly declaredBy: string;
  readonly destinationFingerprint: Sha256Hex;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly normVersion: string;
  /** The DP-RECIPIENT binding frozen at declaration (both null: none). */
  readonly recipientRef: string | null;
  readonly recipientVersion: string | null;
  readonly bankExecutionId: string | null;
  readonly destinationProof: "DP_FULL" | "DP_RECIPIENT" | null;
  readonly evidenceHash: string | null;
  readonly recordedAt: UtcInstant | null;
}

export interface NewExecutionAttempt {
  readonly attemptId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly kind: "RETURN" | "RESEND";
  readonly sourceKind: "CAPTURE" | "BANK_CREDIT";
  readonly agencyId: string | null;
  readonly captureId: string | null;
  readonly refundId: string | null;
  readonly bankCreditId: string | null;
  readonly treasuryRefundId: string | null;
  readonly parentBounceId?: string | null;
  readonly attemptNumber: number;
  readonly reference: string;
  readonly amountCents: bigint;
  readonly declaredAt: UtcInstant;
  readonly declaredBy: string;
  readonly destinationFingerprint: Sha256Hex;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly normVersion: string;
  readonly recipientRef?: string | null;
  readonly recipientVersion?: string | null;
}

/** The bounce of a RECORDED transfer (G3): once per transfer; its cents are the REFUND_PAYABLE its resends settle. */
export interface ReturnBounceRow {
  readonly bounceId: string;
  readonly attemptId: string;
  readonly bouncedCents: bigint;
  readonly evidenceHash: string;
}

export interface ExecutionOfferRow {
  readonly offerId: string;
  readonly attemptId: string;
  readonly command: "RECORD_RETURN" | "RECORD_RESEND" | "RESOLVE_EXECUTED";
  readonly idempotencyKey: string;
  readonly requestedArtifactRef: string;
  readonly expectedEvidenceHash: string;
  readonly actorUserId: string;
}

export interface ExecutionOutcomeRow {
  readonly outcomeId: string;
  readonly offerId: string;
  readonly gateOutcome: "CLASSIFIED" | "UNKNOWN_EVIDENCE" | "MALFORMED_EVIDENCE" | "HASH_MISMATCH" | "UNAUTHENTICATED_EVIDENCE" | "EVIDENCE_UNAVAILABLE";
  readonly bankExecutionId: string | null;
  readonly outcomeCode: string;
  readonly footprint: "RECORDED" | "REVIEW";
  readonly reviewCaseKind: string | null;
}

export interface NewBankReviewCase {
  readonly caseId: string;
  readonly kind: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly attemptId: string | null;
  readonly sourceKind: "CAPTURE" | "BANK_CREDIT" | null;
  readonly sourceId: string | null;
  readonly detailCode: string;
  readonly evidenceHash: string | null;
}

/** A DECLARED attempt with what the owner sends (the owner queue; kauro_app under acting_corporate_owner()). */
export interface QueuedAttemptRow {
  readonly attemptId: string;
  readonly kind: "RETURN" | "RESEND";
  readonly state: string;
  readonly sourceKind: "CAPTURE" | "BANK_CREDIT";
  readonly refundId: string | null;
  readonly treasuryRefundId: string | null;
  readonly reference: string;
  readonly amountCents: bigint;
  readonly declaredAt: UtcInstant;
  readonly accountLast4: string;
  readonly holderName: string;
}

interface AttemptDbRow {
  attempt_id: string;
  environment: "SANDBOX" | "LIVE";
  account_ref: string;
  kind: "RETURN" | "RESEND";
  state: ExecutionAttemptRow["state"];
  version: string;
  source_kind: "CAPTURE" | "BANK_CREDIT";
  agency_id: string | null;
  capture_id: string | null;
  refund_id: string | null;
  bank_credit_id: string | null;
  treasury_refund_id: string | null;
  source_id: string;
  parent_bounce_id: string | null;
  attempt_number: number;
  reference: string;
  amount_cents: string;
  currency: "USD";
  declared_at: Date;
  declared_by: string;
  destination_fingerprint: string;
  fingerprint_key_id: string;
  fingerprint_key_version: number;
  fingerprint_norm_version: string;
  recipient_ref: string | null;
  recipient_version: string | null;
  bank_execution_id: string | null;
  destination_proof: "DP_FULL" | "DP_RECIPIENT" | null;
  evidence_hash: string | null;
  recorded_at: Date | null;
}
const ATTEMPT_COLUMNS =
  "attempt_id, environment, account_ref, kind, state, version, source_kind, agency_id, capture_id, refund_id, bank_credit_id, treasury_refund_id, source_id, parent_bounce_id, attempt_number, reference, amount_cents::text AS amount_cents, currency, declared_at, declared_by, destination_fingerprint, fingerprint_key_id, fingerprint_key_version, fingerprint_norm_version, recipient_ref, recipient_version, bank_execution_id, destination_proof, evidence_hash, recorded_at";

function attemptOf(r: AttemptDbRow): ExecutionAttemptRow {
  return {
    attemptId: r.attempt_id,
    environment: r.environment,
    accountRef: r.account_ref,
    kind: r.kind,
    state: r.state,
    version: int(r.version),
    sourceKind: r.source_kind,
    agencyId: r.agency_id,
    captureId: r.capture_id,
    refundId: r.refund_id,
    bankCreditId: r.bank_credit_id,
    treasuryRefundId: r.treasury_refund_id,
    sourceId: r.source_id,
    parentBounceId: r.parent_bounce_id,
    attemptNumber: int(r.attempt_number),
    reference: r.reference,
    amountCents: BigInt(r.amount_cents),
    currency: r.currency,
    declaredAt: instant(r.declared_at),
    declaredBy: r.declared_by,
    destinationFingerprint: r.destination_fingerprint as Sha256Hex,
    keyId: r.fingerprint_key_id,
    keyVersion: int(r.fingerprint_key_version),
    normVersion: r.fingerprint_norm_version,
    recipientRef: r.recipient_ref,
    recipientVersion: r.recipient_version,
    bankExecutionId: r.bank_execution_id,
    destinationProof: r.destination_proof,
    evidenceHash: r.evidence_hash,
    recordedAt: r.recorded_at === null ? null : instant(r.recorded_at),
  };
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

  /** The captured destination of a refund (CAPTURE) or treasury refund (BANK_CREDIT): its fingerprint parameters and display fields, never the numbers. */
  async destinationOf(sourceKind: "CAPTURE" | "BANK_CREDIT", id: string): Promise<CapturedDestinationRow | null> {
    const column = sourceKind === "CAPTURE" ? "refund_id" : "treasury_refund_id";
    const r = await execute<{ destination_id: string; destination_fingerprint: string; fingerprint_key_id: string; fingerprint_key_version: number; fingerprint_norm_version: string; account_last4: string; holder_name: string }>(
      this.db,
      `SELECT destination_id, destination_fingerprint, fingerprint_key_id, fingerprint_key_version, fingerprint_norm_version, account_last4, holder_name FROM kauro.refund_destinations WHERE ${column} = $1`,
      [id],
    );
    const row = r.rows[0];
    return row === undefined
      ? null
      : { destinationId: row.destination_id, fingerprint: row.destination_fingerprint as Sha256Hex, keyId: row.fingerprint_key_id, keyVersion: int(row.fingerprint_key_version), normVersion: row.fingerprint_norm_version, accountLast4: row.account_last4, holderName: row.holder_name };
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

  // --- slice 2: the source booking lock L2, the attempt (L3), the offers and outcomes, the review cases (§7.21-§7.22d, §7.28) ------------

  /**
   * L2 of a CAPTURE source: the shared half of the capture's transition, then the capture's refund booking lock (the same exclusive
   * advisory lock refunds_completion_order and the F2 ceiling take), so a declaration or a completion of the source serializes with them.
   */
  async lockCaptureRefunds(captureId: string): Promise<void> {
    await execute(this.db, "SELECT kauro.await_transition('kauro.capture_facts', $1::text)", [captureId]);
    await execute(this.db, "SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.capture_refunds', $1::text))", [captureId]);
  }

  /** The shared half of a live authorization's transition (taken before its row lock when a completion revokes it). */
  async awaitAuthorization(authorizationId: string): Promise<void> {
    await execute(this.db, "SELECT kauro.await_transition('kauro.commercial_authorizations', $1::text)", [authorizationId]);
  }

  /** L2 of a BANK_CREDIT source: the credit row (FOR NO KEY UPDATE); false when it is not visible. */
  async lockBankCredit(bankCreditId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.bank_credits WHERE bank_credit_id = $1 FOR NO KEY UPDATE", [bankCreditId]);
    return r.rows.length === 1;
  }

  async attempt(attemptId: string): Promise<ExecutionAttemptRow | null> {
    const r = await execute<AttemptDbRow>(this.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.outbound_execution_attempts WHERE attempt_id = $1`, [attemptId]);
    return r.rows[0] ? attemptOf(r.rows[0]) : null;
  }

  /** L3: the attempt row FOR NO KEY UPDATE. */
  async lockAttempt(attemptId: string): Promise<ExecutionAttemptRow | null> {
    const r = await execute<AttemptDbRow>(this.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.outbound_execution_attempts WHERE attempt_id = $1 FOR NO KEY UPDATE`, [attemptId]);
    return r.rows[0] ? attemptOf(r.rows[0]) : null;
  }

  /** Whether a debit contradicted a terminal attempt of this source: X1/X4 refuse EXECUTION_FROZEN (FC-G5 resolves it, LATER). */
  async isFrozen(sourceKind: "CAPTURE" | "BANK_CREDIT", sourceId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.bank_source_freezes WHERE source_kind = $1 AND source_id = $2", [sourceKind, sourceId]);
    return r.rows.length > 0;
  }

  /** The open (DECLARED or UNCERTAIN) attempt of a source, if any (the NEVER-RESEND fence's row). */
  async openAttemptOf(sourceKind: "CAPTURE" | "BANK_CREDIT", sourceId: string): Promise<ExecutionAttemptRow | null> {
    const r = await execute<AttemptDbRow>(
      this.db,
      `SELECT ${ATTEMPT_COLUMNS} FROM kauro.outbound_execution_attempts WHERE source_kind = $1 AND source_id = $2 AND state IN ('DECLARED', 'UNCERTAIN')`,
      [sourceKind, sourceId],
    );
    return r.rows[0] ? attemptOf(r.rows[0]) : null;
  }

  /** The attempts of one refund (CAPTURE) or treasury refund (BANK_CREDIT), in attempt order. */
  async attemptsOfRefund(sourceKind: "CAPTURE" | "BANK_CREDIT", id: string): Promise<ReadonlyArray<ExecutionAttemptRow>> {
    const column = sourceKind === "CAPTURE" ? "refund_id" : "treasury_refund_id";
    const r = await execute<AttemptDbRow>(this.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.outbound_execution_attempts WHERE ${column} = $1 ORDER BY attempt_number`, [id]);
    return r.rows.map(attemptOf);
  }

  /** The next attempt number of a source (dense per source: 1 for its first). */
  async nextAttemptNumber(sourceKind: "CAPTURE" | "BANK_CREDIT", sourceId: string): Promise<number> {
    const r = await execute<{ n: number }>(this.db, "SELECT coalesce(max(attempt_number), 0) + 1 AS n FROM kauro.outbound_execution_attempts WHERE source_kind = $1 AND source_id = $2", [sourceKind, sourceId]);
    return int(r.rows[0]!.n);
  }

  async insertAttempt(a: NewExecutionAttempt): Promise<ExecutionAttemptRow> {
    const r = await execute<AttemptDbRow>(
      this.db,
      `INSERT INTO kauro.outbound_execution_attempts (attempt_id, environment, account_ref, kind, source_kind, agency_id, capture_id, refund_id, bank_credit_id, treasury_refund_id,
         attempt_number, reference, amount_cents, currency, declared_at, declared_by, destination_fingerprint, fingerprint_key_id, fingerprint_key_version, fingerprint_norm_version, parent_bounce_id, recipient_ref, recipient_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'USD', $14, $15, $16, $17, $18, $19, $20, $21, $22)
       RETURNING ${ATTEMPT_COLUMNS}`,
      [a.attemptId, a.environment, a.accountRef, a.kind, a.sourceKind, a.agencyId, a.captureId, a.refundId, a.bankCreditId, a.treasuryRefundId, a.attemptNumber, a.reference, a.amountCents, a.declaredAt, a.declaredBy, a.destinationFingerprint, a.keyId, a.keyVersion, a.normVersion, a.parentBounceId ?? null, a.recipientRef ?? null, a.recipientVersion ?? null],
    );
    return attemptOf(r.rows[0]!);
  }

  /** DECLARED or UNCERTAIN → RECORDED at expectedVersion (+1); null when the row moved meanwhile. */
  async recordAttempt(attemptId: string, expectedVersion: number, record: { readonly bankExecutionId: string; readonly proof: "DP_FULL" | "DP_RECIPIENT"; readonly evidenceHash: string; readonly recordedAt: UtcInstant }): Promise<ExecutionAttemptRow | null> {
    const r = await execute<AttemptDbRow>(
      this.db,
      `UPDATE kauro.outbound_execution_attempts SET state = 'RECORDED', version = version + 1, bank_execution_id = $3, destination_proof = $4, evidence_hash = $5, recorded_at = $6, updated_at = now()
        WHERE attempt_id = $1 AND version = $2 AND state IN ('DECLARED', 'UNCERTAIN')
        RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptId, expectedVersion, record.bankExecutionId, record.proof, record.evidenceHash, record.recordedAt],
    );
    return r.rows[0] ? attemptOf(r.rows[0]) : null;
  }

  /** The bounce of a RECORDED transfer, if G3 recorded one. */
  async bounceOf(attemptId: string): Promise<ReturnBounceRow | null> {
    const r = await execute<{ bounce_id: string; attempt_id: string; bounced_cents: string; evidence_hash: string }>(
      this.db,
      "SELECT bounce_id, attempt_id, bounced_cents::text AS bounced_cents, evidence_hash FROM kauro.outbound_return_bounces WHERE attempt_id = $1",
      [attemptId],
    );
    const b = r.rows[0];
    return b ? { bounceId: b.bounce_id, attemptId: b.attempt_id, bouncedCents: BigInt(b.bounced_cents), evidenceHash: b.evidence_hash } : null;
  }

  async bounceById(bounceId: string): Promise<ReturnBounceRow | null> {
    const r = await execute<{ bounce_id: string; attempt_id: string; bounced_cents: string; evidence_hash: string }>(
      this.db,
      "SELECT bounce_id, attempt_id, bounced_cents::text AS bounced_cents, evidence_hash FROM kauro.outbound_return_bounces WHERE bounce_id = $1",
      [bounceId],
    );
    const b = r.rows[0];
    return b ? { bounceId: b.bounce_id, attemptId: b.attempt_id, bouncedCents: BigInt(b.bounced_cents), evidenceHash: b.evidence_hash } : null;
  }

  async insertBounce(b: { readonly bounceId: string; readonly attempt: ExecutionAttemptRow; readonly bouncedCents: bigint; readonly evidenceHash: string; readonly recordedBy: string }): Promise<void> {
    await execute(
      this.db,
      "INSERT INTO kauro.outbound_return_bounces (bounce_id, attempt_id, environment, account_ref, source_kind, source_id, bounced_cents, evidence_hash, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [b.bounceId, b.attempt.attemptId, b.attempt.environment, b.attempt.accountRef, b.attempt.sourceKind, b.attempt.sourceId, b.bouncedCents, b.evidenceHash, b.recordedBy],
    );
  }

  /** The open REFUND_PAYABLE of a bounce: its cents less the RESEND attempts of it that are RECORDED or still open. */
  async bouncePayable(bounceId: string): Promise<bigint> {
    const r = await execute<{ o: string }>(
      this.db,
      `SELECT (b.bounced_cents - coalesce((SELECT sum(a.amount_cents) FROM kauro.outbound_execution_attempts a WHERE a.parent_bounce_id = b.bounce_id AND a.state IN ('DECLARED', 'UNCERTAIN', 'RECORDED')), 0))::text AS o
         FROM kauro.outbound_return_bounces b WHERE b.bounce_id = $1`,
      [bounceId],
    );
    return r.rows[0] ? BigInt(r.rows[0].o) : 0n;
  }

  /** G3: the RECORDED attempt's version moves (its event is the bounce's); null when the row moved meanwhile. */
  async bounceAttempt(attemptId: string, expectedVersion: number): Promise<ExecutionAttemptRow | null> {
    const r = await execute<AttemptDbRow>(
      this.db,
      `UPDATE kauro.outbound_execution_attempts SET version = version + 1, updated_at = now() WHERE attempt_id = $1 AND version = $2 AND state = 'RECORDED' RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptId, expectedVersion],
    );
    return r.rows[0] ? attemptOf(r.rows[0]) : null;
  }

  /** X2: DECLARED → UNCERTAIN at expectedVersion (+1); null when the row moved meanwhile. */
  async lapseAttempt(attemptId: string, expectedVersion: number): Promise<ExecutionAttemptRow | null> {
    const r = await execute<AttemptDbRow>(
      this.db,
      `UPDATE kauro.outbound_execution_attempts SET state = 'UNCERTAIN', version = version + 1, updated_at = now() WHERE attempt_id = $1 AND version = $2 AND state = 'DECLARED' RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptId, expectedVersion],
    );
    return r.rows[0] ? attemptOf(r.rows[0]) : null;
  }

  /** E-ID: whether an execution id is already the record of an attempt of the account and environment (either source scope). */
  async executionIdUsed(environment: string, accountRef: string, bankExecutionId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.outbound_execution_attempts WHERE environment = $1 AND account_ref = $2 AND bank_execution_id = $3", [environment, accountRef, bankExecutionId]);
    return r.rows.length > 0;
  }

  async findOffer(attemptId: string, command: ExecutionOfferRow["command"], idempotencyKey: string): Promise<ExecutionOfferRow | null> {
    const r = await execute<{ offer_id: string; attempt_id: string; command: ExecutionOfferRow["command"]; idempotency_key: string; requested_artifact_ref: string; expected_evidence_hash: string; actor_user_id: string }>(
      this.db,
      "SELECT offer_id, attempt_id, command, idempotency_key, requested_artifact_ref, expected_evidence_hash, actor_user_id FROM kauro.execution_offers WHERE attempt_id = $1 AND command = $2 AND idempotency_key = $3",
      [attemptId, command, idempotencyKey],
    );
    const o = r.rows[0];
    return o === undefined
      ? null
      : { offerId: o.offer_id, attemptId: o.attempt_id, command: o.command, idempotencyKey: o.idempotency_key, requestedArtifactRef: o.requested_artifact_ref, expectedEvidenceHash: o.expected_evidence_hash, actorUserId: o.actor_user_id };
  }

  async insertOffer(o: ExecutionOfferRow): Promise<void> {
    await execute(
      this.db,
      "INSERT INTO kauro.execution_offers (offer_id, attempt_id, command, idempotency_key, requested_artifact_ref, expected_evidence_hash, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [o.offerId, o.attemptId, o.command, o.idempotencyKey, o.requestedArtifactRef, o.expectedEvidenceHash, o.actorUserId],
    );
  }

  async outcomeOf(offerId: string): Promise<ExecutionOutcomeRow | null> {
    const r = await execute<{ outcome_id: string; offer_id: string; gate_outcome: ExecutionOutcomeRow["gateOutcome"]; bank_execution_id: string | null; outcome_code: string; footprint: "RECORDED" | "REVIEW"; review_case_kind: string | null }>(
      this.db,
      "SELECT outcome_id, offer_id, gate_outcome, bank_execution_id, outcome_code, footprint, review_case_kind FROM kauro.execution_offer_outcomes WHERE offer_id = $1",
      [offerId],
    );
    const o = r.rows[0];
    return o === undefined ? null : { outcomeId: o.outcome_id, offerId: o.offer_id, gateOutcome: o.gate_outcome, bankExecutionId: o.bank_execution_id, outcomeCode: o.outcome_code, footprint: o.footprint, reviewCaseKind: o.review_case_kind };
  }

  async insertOutcome(o: ExecutionOutcomeRow): Promise<void> {
    await execute(
      this.db,
      "INSERT INTO kauro.execution_offer_outcomes (outcome_id, offer_id, gate_outcome, bank_execution_id, outcome_code, footprint, review_case_kind) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [o.outcomeId, o.offerId, o.gateOutcome, o.bankExecutionId, o.outcomeCode, o.footprint, o.reviewCaseKind],
    );
  }

  /** Opens a review case unless one of the same kind and subject is OPEN (one open per kind and subject); answers whether it opened. */
  async openCaseIfNone(c: NewBankReviewCase): Promise<boolean> {
    const r = await execute(
      this.db,
      `INSERT INTO kauro.bank_review_cases (case_id, kind, environment, account_ref, attempt_id, source_kind, source_id, detail_code, evidence_hash)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
        WHERE NOT EXISTS (SELECT 1 FROM kauro.bank_review_cases x WHERE x.state = 'OPEN' AND x.kind = $2 AND x.environment = $3 AND x.account_ref = $4
                            AND x.attempt_id IS NOT DISTINCT FROM $5::uuid AND x.line_id IS NULL AND x.source_id IS NOT DISTINCT FROM $7::uuid)`,
      [c.caseId, c.kind, c.environment, c.accountRef, c.attemptId, c.sourceKind, c.sourceId, c.detailCode, c.evidenceHash],
    );
    return (r.rowCount ?? 0) === 1;
  }

  /** Resolves the OPEN cases of one kind about an attempt (the record that settles them); answers how many. */
  async resolveOpenCases(kind: string, attemptId: string, at: UtcInstant): Promise<number> {
    const r = await execute(this.db, "UPDATE kauro.bank_review_cases SET state = 'RESOLVED', resolved_at = $3 WHERE kind = $1 AND attempt_id = $2 AND state = 'OPEN'", [kind, attemptId, at]);
    return r.rowCount ?? 0;
  }

  /** A treasury refund's execution move at expectedVersion (+1): APPROVED → SUBMITTING, → UNCERTAIN, → COMPLETED or FAILED (X3); null when it moved. */
  async transitionTreasuryRefund(treasuryRefundId: string, expectedVersion: number, state: "SUBMITTING" | "UNCERTAIN" | "COMPLETED" | "FAILED"): Promise<(TreasuryRefundRow & { readonly previousState: TreasuryRefundRow["state"] }) | null> {
    const r = await execute<TreasuryRow & { previous_state: TreasuryRefundRow["state"] }>(
      this.db,
      `UPDATE kauro.treasury_refunds AS t SET state = $3, version = t.version + 1 FROM kauro.treasury_refunds AS o
        WHERE t.treasury_refund_id = $1 AND t.version = $2 AND o.treasury_refund_id = t.treasury_refund_id
        RETURNING ${TREASURY_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")}, o.state AS previous_state`,
      [treasuryRefundId, expectedVersion, state],
    );
    const row = r.rows[0];
    return row === undefined ? null : { ...treasuryOf(row), previousState: row.previous_state };
  }

  /**
   * X2: the DECLARED attempts whose manual execution window lapsed at `at` (declared_at + the window of the account's route version in
   * force; an account with no route row is judged lapsed, the safe side: an UNCERTAIN attempt is never re-instructed). Newest first: the pass drains every due attempt, so the
   * order only decides which lapses first.
   */
  async dueAttempts(at: UtcInstant, limit: number): Promise<ReadonlyArray<{ readonly attemptId: string; readonly sourceKind: "CAPTURE" | "BANK_CREDIT"; readonly refundId: string | null }>> {
    const r = await execute<{ attempt_id: string; source_kind: "CAPTURE" | "BANK_CREDIT"; refund_id: string | null }>(
      this.db,
      `SELECT a.attempt_id, a.source_kind, a.refund_id
         FROM kauro.outbound_execution_attempts a
         LEFT JOIN kauro.bank_routes r ON r.environment = a.environment AND r.account_ref = a.account_ref
         LEFT JOIN kauro.bank_route_versions v ON v.route_id = r.route_id AND v.route_version = r.current_version
        WHERE a.state = 'DECLARED' AND (v.manual_execution_window_ms IS NULL OR a.declared_at + v.manual_execution_window_ms * interval '1 millisecond' <= $1::timestamptz)
        ORDER BY a.declared_at DESC, a.attempt_id DESC
        LIMIT $2`,
      [at, limit],
    );
    return r.rows.map((x) => ({ attemptId: x.attempt_id, sourceKind: x.source_kind, refundId: x.refund_id }));
  }

  /** The manual execution window of the account's route version in force (ms); null when the account has no route row. */
  async executionWindowMs(environment: string, accountRef: string): Promise<number | null> {
    const r = await execute<{ w: string }>(
      this.db,
      `SELECT v.manual_execution_window_ms::text AS w FROM kauro.bank_routes r JOIN kauro.bank_route_versions v ON v.route_id = r.route_id AND v.route_version = r.current_version
        WHERE r.environment = $1 AND r.account_ref = $2`,
      [environment, accountRef],
    );
    return r.rows[0] === undefined ? null : Number(r.rows[0].w);
  }

  /** The owner queue: the DECLARED attempts with what to send (kauro_app, the corporate owner's reads; never an offer or the evidence). */
  async ownerQueue(limit: number): Promise<ReadonlyArray<QueuedAttemptRow>> {
    const r = await execute<{ attempt_id: string; kind: "RETURN" | "RESEND"; state: string; source_kind: "CAPTURE" | "BANK_CREDIT"; refund_id: string | null; treasury_refund_id: string | null; reference: string; amount_cents: string; declared_at: Date; account_last4: string; holder_name: string }>(
      this.db,
      `SELECT a.attempt_id, a.kind, a.state, a.source_kind, a.refund_id, a.treasury_refund_id, a.reference, a.amount_cents::text AS amount_cents, a.declared_at, d.account_last4, d.holder_name
         FROM kauro.outbound_execution_attempts a
         JOIN kauro.refund_destinations d ON (a.source_kind = 'CAPTURE' AND d.refund_id = a.refund_id) OR (a.source_kind = 'BANK_CREDIT' AND d.treasury_refund_id = a.treasury_refund_id)
        WHERE a.state = 'DECLARED'
        ORDER BY a.declared_at, a.attempt_id
        LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({
      attemptId: x.attempt_id,
      kind: x.kind,
      state: x.state,
      sourceKind: x.source_kind,
      refundId: x.refund_id,
      treasuryRefundId: x.treasury_refund_id,
      reference: x.reference,
      amountCents: BigInt(x.amount_cents),
      declaredAt: instant(x.declared_at),
      accountLast4: x.account_last4,
      holderName: x.holder_name,
    }));
  }

  /** X3 NOT_EXECUTED: UNCERTAIN → NOT_EXECUTED at expectedVersion (+1); null when the row moved meanwhile. */
  async notExecuteAttempt(attemptId: string, expectedVersion: number): Promise<ExecutionAttemptRow | null> {
    const r = await execute<AttemptDbRow>(
      this.db,
      `UPDATE kauro.outbound_execution_attempts SET state = 'NOT_EXECUTED', version = version + 1, updated_at = now() WHERE attempt_id = $1 AND version = $2 AND state = 'UNCERTAIN' RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptId, expectedVersion],
    );
    return r.rows[0] ? attemptOf(r.rows[0]) : null;
  }

  /** An execution offer committed on a NOT_EXECUTED attempt: the same contradiction as a late debit (REFUND_TERMINAL_CONTRADICTED case and the source freeze), in the offer's own COMMIT. */
  async contradictOffered(caseId: string, freezeId: string, a: { readonly attemptId: string; readonly environment: string; readonly accountRef: string; readonly sourceKind: string; readonly sourceId: string }, evidenceHash: string): Promise<void> {
    await execute(
      this.db,
      `INSERT INTO kauro.bank_review_cases (case_id, kind, environment, account_ref, attempt_id, source_kind, source_id, detail_code, evidence_hash)
       VALUES ($1, 'REFUND_TERMINAL_CONTRADICTED', $2, $3, $4, $5, $6, 'OFFER_AFTER_NOT_EXECUTED', $7) ON CONFLICT DO NOTHING`,
      [caseId, a.environment, a.accountRef, a.attemptId, a.sourceKind, a.sourceId, evidenceHash],
    );
    await execute(
      this.db,
      `INSERT INTO kauro.bank_source_freezes (freeze_id, environment, account_ref, source_kind, source_id, reason)
       VALUES ($1, $2, $3, $4, $5, 'REFUND_TERMINAL_CONTRADICTED') ON CONFLICT DO NOTHING`,
      [freezeId, a.environment, a.accountRef, a.sourceKind, a.sourceId],
    );
  }

  /** CORR-OFFERED (DV1-11): whether any execution offer exists for the attempt (any command, with or without an outcome). */
  async anyOfferFor(attemptId: string): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.execution_offers WHERE attempt_id = $1 LIMIT 1", [attemptId]);
    return r.rows.length > 0;
  }

  /** The manual execution window and the coverage lag of the account's route version in force (null: the account has no route). */
  async routeTimingOf(environment: string, accountRef: string): Promise<{ readonly windowMs: number; readonly coverageLagMs: number } | null> {
    const r = await execute<{ w: string; l: string }>(
      this.db,
      `SELECT v.manual_execution_window_ms::text AS w, v.coverage_lag_ms::text AS l FROM kauro.bank_routes r JOIN kauro.bank_route_versions v ON v.route_id = r.route_id AND v.route_version = r.current_version
        WHERE r.environment = $1 AND r.account_ref = $2`,
      [environment, accountRef],
    );
    const row = r.rows[0];
    return row === undefined ? null : { windowMs: Number(row.w), coverageLagMs: Number(row.l) };
  }

  /** NX-COVERAGE: the imported OUTBOUND coverage intervals of the account that overlap [from, to], by start. */
  async outboundCoverage(environment: string, accountRef: string, from: UtcInstant, to: UtcInstant): Promise<ReadonlyArray<{ readonly from: UtcInstant; readonly to: UtcInstant }>> {
    const r = await execute<{ f: Date; t: Date }>(
      this.db,
      `SELECT c.covered_from AS f, c.covered_to AS t FROM kauro.statement_coverage c JOIN kauro.statement_imports i USING (import_id)
        WHERE i.environment = $1 AND i.account_ref = $2 AND c.stream = 'OUTBOUND' AND c.covered_to >= $3 AND c.covered_from <= $4
        ORDER BY c.covered_from, c.covered_to`,
      [environment, accountRef, from, to],
    );
    return r.rows.map((x) => ({ from: instant(x.f), to: instant(x.t) }));
  }

  /**
   * NX-NO-POTENTIAL (DV1-10): every debit line of the account in [from, to] (its execution instant, else its booking, else its observation)
   * as the X3 judgment needs it: whether it is correlated with the attempt (CORR-REF: its reference is the attempt's; CORR-RECIPIENT: its
   * recipient is the bound one; a recorded correlation of the line with the attempt) and whether it is explained (linked by execution id to
   * another RECORDED attempt).
   */
  async debitsAgainst(attemptId: string, environment: string, accountRef: string, from: UtcInstant, to: UtcInstant): Promise<ReadonlyArray<{ readonly lineId: string; readonly correlated: boolean; readonly explained: boolean }>> {
    const r = await execute<{ line_id: string; correlated: boolean; explained: boolean }>(
      this.db,
      `SELECT l.line_id,
              (l.reference IS NOT DISTINCT FROM a.reference
               OR (a.recipient_ref IS NOT NULL AND l.recipient_ref IS NOT DISTINCT FROM a.recipient_ref)
               OR l.linked_attempt_id IS NOT DISTINCT FROM a.attempt_id
               OR EXISTS (SELECT 1 FROM kauro.execution_correlations x WHERE x.line_id = l.line_id AND x.attempt_id = a.attempt_id)) AS correlated,
              (l.linked_attempt_id IS NOT NULL AND l.linked_attempt_id <> a.attempt_id
               AND EXISTS (SELECT 1 FROM kauro.outbound_execution_attempts o WHERE o.attempt_id = l.linked_attempt_id AND o.state = 'RECORDED')) AS explained
         FROM kauro.statement_lines l
         JOIN kauro.outbound_execution_attempts a ON a.attempt_id = $1
        WHERE l.environment = $2 AND l.account_ref = $3 AND l.line_kind = 'DEBIT'
          AND coalesce(l.executed_at, l.booked_at, l.observed_at) >= $4 AND coalesce(l.executed_at, l.booked_at, l.observed_at) <= $5
        ORDER BY l.line_id`,
      [attemptId, environment, accountRef, from, to],
    );
    return r.rows.map((x) => ({ lineId: x.line_id, correlated: x.correlated === true, explained: x.explained === true }));
  }
}
