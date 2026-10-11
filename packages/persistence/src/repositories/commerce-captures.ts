/**
 * Capture facts, commercial authorizations and purchase re-bindings over `pg` (package B09; migration 0015; design §4.3, §6.3,
 * D-MACH-B3, D-MACH-B4, D-INIT-B1, D-PAY-B1, D-PAY-B5, D-EVT-B2, D-EVT-B3, D-LEDGER-B5, D-AUTH-B1..B4, D-QUOTE-B6).
 *
 * A capture fact is born at the status of its first authenticated observation with its funds UNKNOWN (D-INIT-B1), and every later
 * version records exactly one thing: one listed status edge (advance), or one provider fact learned after the status — the funds'
 * availability (observeFunds, capture.funds_observed.v1) or the fee (observeFee, capture.fee_observed.v1), never both (D-EVT-B3).
 * A capture first seen REVERSED is inserted COMPLETED and then advanced to REVERSED in the same unit of work (D-PAY-B5): two
 * versions, two events, its completion instant kept as the tax point. The events that move money name the provider balance it is
 * taken from (D-LEDGER-B5): capture.fee_observed.v1 and capture.reversed.v1 carry the capture's funds state at that version and the
 * capture's movable balance before the money left (movableBalanceCents, D-LEDGER-B6: what the fee or the chargeback takes beyond it
 * is the fee the provider keeps, taken from the merchant's available balance), and capture.funds_observed.v1 carries the capture's
 * movable balance as its amountCents — each computed under the capture's row lock (the version's own UPDATE, or SELECT ... FOR
 * UPDATE) so that a refund completing concurrently (which holds FOR SHARE of the row) is either seen or ordered after it.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  movableBalanceOf,
  returnedCentsOf,
  type AgencyId,
  type ApprovalId,
  type AuthorizationChange,
  type CapabilityId,
  type CaptureAdvance,
  type CaptureFactRecord,
  type CaptureFactRepository,
  type CaptureId,
  type CaptureStatus,
  type CommercialAuthorizationId,
  type CommercialAuthorizationRecord,
  type CommercialAuthorizationRepository,
  type CommercialAuthorizationState,
  type FundsState,
  type MembershipId,
  type MerchantRef,
  type NewCaptureFact,
  type NewCommercialAuthorization,
  type PaymentEnvironment,
  type PaymentOrderId,
  type PlanId,
  type ProjectId,
  type PurchaseRebindingId,
  type PurchaseRebindingRecord,
  type PurchaseRebindingRepository,
  type QuoteId,
  type RefundComponents,
  type RevocationPhase,
  type ServiceMode,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, type Queryable } from "../sql.js";
import { cents, defined, optionalCents, publishVersion, staleOf, type CommerceWriteContext } from "./commerce-shared.js";

/** The refund states whose approved components are committed against a capture (refunds_commitment_ceiling). */
export const COMMITTING_REFUND_STATE_LIST = ["APPROVED", "SUBMITTING", "UNCERTAIN", "COMPLETED"] as const;

// --- capture facts ---------------------------------------------------------------------------------------------------------------------

interface CaptureRow {
  capture_id: string;
  agency_id: string;
  order_id: string;
  version: string;
  status: CaptureStatus;
  provider: string;
  environment: PaymentEnvironment;
  provider_capture_id: string;
  merchant_ref: string;
  payee_digest: string;
  amount_cents: string;
  currency: "USD";
  allocated_service_cents: string;
  allocated_tax_cents: string;
  excess_cents: string;
  funds_state: FundsState;
  provider_fee_cents: string | null;
  provider_completed_at: Date | null;
  first_observation_source: CaptureFactRecord["firstObservationSource"];
  first_observed_at: Date;
  observed_at: Date;
  evidence_hash: string;
  attempt_id: string | null;
}

const CAPTURE_FIELDS = [
  "capture_id",
  "agency_id",
  "order_id",
  "version",
  "status",
  "provider",
  "environment",
  "provider_capture_id",
  "merchant_ref",
  "payee_digest",
  "amount_cents",
  "currency",
  "allocated_service_cents",
  "allocated_tax_cents",
  "excess_cents",
  "funds_state",
  "provider_fee_cents",
  "provider_completed_at",
  "first_observation_source",
  "first_observed_at",
  "observed_at",
  "evidence_hash",
  "attempt_id",
];
const CAPTURE_COLUMNS = CAPTURE_FIELDS.join(", ");
const T_CAPTURE_COLUMNS = CAPTURE_FIELDS.map((c) => `t.${c}`).join(", ");

function captureRecord(r: CaptureRow): CaptureFactRecord {
  return defined<CaptureFactRecord>(
    {
      captureId: r.capture_id as CaptureId,
      agencyId: r.agency_id as AgencyId,
      orderId: r.order_id as PaymentOrderId,
      version: int(r.version),
      status: r.status,
      provider: r.provider,
      environment: r.environment,
      providerCaptureId: r.provider_capture_id,
      merchantRef: r.merchant_ref as MerchantRef,
      payeeDigest: r.payee_digest,
      amountCents: cents(r.amount_cents),
      currency: r.currency,
      allocation: { serviceCents: cents(r.allocated_service_cents), taxCents: cents(r.allocated_tax_cents), excessCents: cents(r.excess_cents) },
      fundsState: r.funds_state,
      firstObservationSource: r.first_observation_source,
      firstObservedAt: instant(r.first_observed_at),
      observedAt: instant(r.observed_at),
      evidenceHash: r.evidence_hash,
    },
    { providerFeeCents: optionalCents(r.provider_fee_cents), providerCompletedAt: optionalInstant(r.provider_completed_at), attemptId: optionalText(r.attempt_id) },
  );
}

type Candidate = Readonly<Record<string, string | number | bigint | boolean | null | undefined>>;

function captureCandidate(c: CaptureFactRecord, extra: Candidate): Candidate {
  return {
    captureId: c.captureId,
    agencyId: c.agencyId,
    orderId: c.orderId,
    amountCents: c.amountCents,
    currency: c.currency,
    allocatedServiceCents: c.allocation.serviceCents,
    allocatedTaxCents: c.allocation.taxCents,
    excessCents: c.allocation.excessCents,
    providerFeeCents: c.providerFeeCents,
    fundsState: c.fundsState,
    evidenceHash: c.evidenceHash,
    ...extra,
  };
}

/** Sums of the approved components of a capture's refunds in the given states (the money committed or returned). */
async function refundSums(db: Queryable, captureId: CaptureId, states: ReadonlyArray<string>): Promise<RefundComponents> {
  const r = await execute<{ service: string; tax: string; excess: string }>(
    db,
    `SELECT coalesce(sum(approved_service_cents), 0)::text AS service, coalesce(sum(approved_tax_cents), 0)::text AS tax, coalesce(sum(approved_excess_cents), 0)::text AS excess
       FROM kauro.refunds WHERE capture_id = $1 AND state = ANY ($2::text[])`,
    [captureId, [...states]],
  );
  const row = r.rows[0];
  return row ? { serviceCents: cents(row.service), taxCents: cents(row.tax), excessCents: cents(row.excess) } : { serviceCents: 0n, taxCents: 0n, excessCents: 0n };
}

/** The purchase a capture belongs to (its order's project and quote), for the events of its completion and reversal. */
async function purchaseOf(db: Queryable, orderId: PaymentOrderId): Promise<{ readonly projectId?: string; readonly quoteId?: string }> {
  const r = await execute<{ project_id: string; quote_id: string }>(db, "SELECT project_id, quote_id FROM kauro.payment_orders WHERE order_id = $1", [orderId]);
  const row = r.rows[0];
  return row ? { projectId: row.project_id, quoteId: row.quote_id } : {};
}

function zeroOrPositive(v: bigint): bigint {
  return v > 0n ? v : 0n;
}

export class PgCaptureFactRepository implements CaptureFactRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  async get(captureId: CaptureId): Promise<CaptureFactRecord | null> {
    const r = await execute<CaptureRow>(this.ctx.db, `SELECT ${CAPTURE_COLUMNS} FROM kauro.capture_facts WHERE capture_id = $1`, [captureId]);
    return r.rows[0] ? captureRecord(r.rows[0]) : null;
  }

  async lock(captureId: CaptureId): Promise<CaptureFactRecord | null> {
    const r = await execute<CaptureRow>(this.ctx.db, `SELECT ${CAPTURE_COLUMNS} FROM kauro.capture_facts WHERE capture_id = $1 FOR NO KEY UPDATE`, [captureId]);
    return r.rows[0] ? captureRecord(r.rows[0]) : null;
  }

  async findByProviderCapture(provider: string, environment: PaymentEnvironment, providerCaptureId: string): Promise<CaptureFactRecord | null> {
    const r = await execute<CaptureRow>(this.ctx.db, `SELECT ${CAPTURE_COLUMNS} FROM kauro.capture_facts WHERE provider = $1 AND environment = $2 AND provider_capture_id = $3`, [provider, environment, providerCaptureId]);
    return r.rows[0] ? captureRecord(r.rows[0]) : null;
  }

  async listForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<CaptureFactRecord>> {
    const r = await execute<CaptureRow>(this.ctx.db, `SELECT ${CAPTURE_COLUMNS} FROM kauro.capture_facts WHERE order_id = $1 ORDER BY first_observed_at, capture_id`, [orderId]);
    return r.rows.map(captureRecord);
  }

  async committedRefunds(captureId: CaptureId): Promise<RefundComponents> {
    return refundSums(this.ctx.db, captureId, COMMITTING_REFUND_STATE_LIST);
  }

  /**
   * Births the fact at its first observed status (version 1) and publishes that status's event. The database allocates a
   * COMPLETED birth against the order (KP002 for anything but min(amount, owed)), refuses a birth two edges from PENDING (KA008)
   * and a birth with known funds (KA003 at COMMIT: an availability is a version of its own).
   */
  async insert(fact: NewCaptureFact): Promise<CaptureFactRecord> {
    const now = this.ctx.clock.now();
    const r = await execute<CaptureRow>(
      this.ctx.db,
      `INSERT INTO kauro.capture_facts (capture_id, agency_id, order_id, status, provider, environment, provider_capture_id, merchant_ref, payee_digest, amount_cents, currency, allocated_service_cents, allocated_tax_cents, excess_cents,
                                        funds_state, provider_fee_cents, provider_completed_at, first_observation_source, first_observed_at, observed_at, evidence_hash, attempt_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'USD', $11, $12, $13, $14, $15, $16, $17, $18, $18, $19, $20, $21, $21) RETURNING ${CAPTURE_COLUMNS}`,
      [
        fact.captureId,
        fact.agencyId,
        fact.orderId,
        fact.status,
        fact.provider,
        fact.environment,
        fact.providerCaptureId,
        fact.merchantRef,
        fact.payeeDigest,
        fact.amountCents,
        fact.allocation.serviceCents,
        fact.allocation.taxCents,
        fact.allocation.excessCents,
        fact.fundsState,
        fact.providerFeeCents ?? null,
        fact.providerCompletedAt ?? null,
        fact.firstObservationSource,
        fact.observedAt,
        fact.evidenceHash,
        fact.attemptId ?? null,
        now,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "capture fact insert returned no row");
    const record = captureRecord(row);
    const purchase = record.status === "COMPLETED" ? await purchaseOf(this.ctx.db, record.orderId) : {};
    await publishVersion(
      this.ctx,
      "capture",
      { id: record.captureId, agencyId: record.agencyId, version: record.version },
      { previousState: null, state: record.status },
      captureCandidate(record, { ...purchase, source: record.firstObservationSource }),
    );
    return record;
  }

  /**
   * One listed status edge at expectedVersion + 1 (KA008 for an unlisted one; KP005 for an allocation outside PENDING -> COMPLETED).
   * A completion may carry the fee the provider reported with it (capture.completed.v1 names it); the observation time only moves
   * forward. A reversal names the unrefunded components it returns and the funds state they are taken from (D-LEDGER-B5).
   */
  async advance(captureId: CaptureId, expectedVersion: number, change: CaptureAdvance, _now: UtcInstant): Promise<VersionedWrite<CaptureFactRecord>> {
    const params: unknown[] = [captureId, expectedVersion, change.status, change.observedAt, change.evidenceHash];
    const sets = ["version = t.version + 1", "status = $3", "observed_at = greatest(t.observed_at, $4::timestamptz)", "evidence_hash = $5"];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.allocation !== undefined) {
      add("allocated_service_cents", change.allocation.serviceCents);
      add("allocated_tax_cents", change.allocation.taxCents);
      add("excess_cents", change.allocation.excessCents);
    }
    if (change.providerFeeCents !== undefined) add("provider_fee_cents", change.providerFeeCents);
    if (change.providerCompletedAt !== undefined) add("provider_completed_at", change.providerCompletedAt);
    if (change.attemptId !== undefined) add("attempt_id", change.attemptId);
    const r = await execute<CaptureRow & { previous_status: CaptureStatus; previous_fee: string | null }>(
      this.ctx.db,
      `UPDATE kauro.capture_facts AS t SET ${sets.join(", ")} FROM kauro.capture_facts AS o
        WHERE t.capture_id = $1 AND t.version = $2 AND o.capture_id = t.capture_id
       RETURNING ${T_CAPTURE_COLUMNS}, o.status AS previous_status, o.provider_fee_cents AS previous_fee`,
      params,
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "capture_facts", "capture_id", "status", captureId, "capture fact");
    const record = captureRecord(row);
    const feeChanged = row.previous_fee === null && record.providerFeeCents !== undefined;
    let extra: Candidate = { previousStatus: row.previous_status, source: record.firstObservationSource };
    if (record.status === "COMPLETED" || record.status === "REVERSED") extra = { ...extra, ...(await purchaseOf(this.ctx.db, record.orderId)) };
    if (record.status === "REVERSED") {
      // the chargeback returns the components no completed refund returned already, from the balance the funds sit in now, up to
      // the capture's movable balance before it (D-LEDGER-B6)
      const returned = await refundSums(this.ctx.db, record.captureId, ["COMPLETED"]);
      extra = {
        ...extra,
        reversedServiceCents: zeroOrPositive(record.allocation.serviceCents - returned.serviceCents),
        reversedTaxCents: zeroOrPositive(record.allocation.taxCents - returned.taxCents),
        reversedExcessCents: zeroOrPositive(record.allocation.excessCents - returned.excessCents),
        movableBalanceCents: movableBalanceOf({ amountCents: record.amountCents, providerFeeCents: record.providerFeeCents ?? 0n, returnedCents: returned.serviceCents + returned.taxCents + returned.excessCents }),
      };
    }
    await publishVersion(
      this.ctx,
      "capture",
      { id: record.captureId, agencyId: record.agencyId, version: record.version },
      { previousState: row.previous_status, state: record.status, feeChanged },
      captureCandidate(record, extra),
    );
    return { kind: "APPLIED", record };
  }

  /**
   * A provider-reported change of the funds' availability at expectedVersion + 1 (capture.funds_observed.v1, FINANCE only). The
   * capture row is locked first (SELECT ... FOR UPDATE), then the movable balance — the amount less the reported fee and the money
   * completed refunds returned (commerce/ledger movableBalanceOf) — is read and published as the event's amountCents: a refund
   * completing concurrently took the row's shared lock (RefundRepository.transition) and is either seen here or ordered after this
   * version. An observation of the availability already recorded is not a new fact: it answers the current record unchanged.
   */
  async observeFunds(captureId: CaptureId, expectedVersion: number, change: { readonly fundsState: Exclude<FundsState, "UNKNOWN">; readonly observedAt: UtcInstant; readonly evidenceHash: Sha256Hex }, _now: UtcInstant): Promise<VersionedWrite<CaptureFactRecord>> {
    const current = await this.lock(captureId);
    if (current === null) throw new DomainFailure("NOT_FOUND", "capture fact is not visible in this context");
    if (current.version !== expectedVersion) return { kind: "STALE", currentVersion: current.version, currentState: current.status };
    if (current.fundsState === change.fundsState) return { kind: "APPLIED", record: current };
    const r = await execute<CaptureRow>(
      this.ctx.db,
      `UPDATE kauro.capture_facts SET version = version + 1, funds_state = $3, observed_at = greatest(observed_at, $4::timestamptz), evidence_hash = $5
        WHERE capture_id = $1 AND version = $2 RETURNING ${CAPTURE_COLUMNS}`,
      [captureId, expectedVersion, change.fundsState, change.observedAt, change.evidenceHash],
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "capture_facts", "capture_id", "status", captureId, "capture fact");
    const record = captureRecord(row);
    const returned = await refundSums(this.ctx.db, record.captureId, ["COMPLETED"]);
    const movable = movableBalanceOf({ amountCents: record.amountCents, providerFeeCents: record.providerFeeCents ?? 0n, returnedCents: returnedCentsOf(record, returned.serviceCents + returned.taxCents + returned.excessCents) });
    await publishVersion(
      this.ctx,
      "capture",
      { id: record.captureId, agencyId: record.agencyId, version: record.version },
      { previousState: record.status, state: record.status, fundsChanged: true },
      captureCandidate(record, { amountCents: movable, previousFundsState: current.fundsState, source: record.firstObservationSource }),
    );
    return { kind: "APPLIED", record };
  }

  /**
   * The fee the provider reported after the completion — with or after a reversal too (B09-R4) — learned once at expectedVersion + 1
   * (capture.fee_observed.v1, FINANCE only; never a second capture.completed.v1). Read under the capture's row lock, the event names
   * the funds state the fee is taken from and the capture's movable balance before the fee — its amount less the money completed
   * refunds returned, or nothing once the capture is reversed (D-LEDGER-B6, D-LEDGER-B7).
   * The fee already recorded answers the current record unchanged; another fee is refused (KA004: learned once) — a contradiction
   * the reconciler records as a case.
   */
  async observeFee(captureId: CaptureId, expectedVersion: number, change: { readonly providerFeeCents: bigint; readonly observedAt: UtcInstant; readonly evidenceHash: Sha256Hex }, _now: UtcInstant): Promise<VersionedWrite<CaptureFactRecord>> {
    const current = await this.lock(captureId);
    if (current === null) throw new DomainFailure("NOT_FOUND", "capture fact is not visible in this context");
    if (current.version !== expectedVersion) return { kind: "STALE", currentVersion: current.version, currentState: current.status };
    if (current.providerFeeCents === change.providerFeeCents) return { kind: "APPLIED", record: current };
    const r = await execute<CaptureRow>(
      this.ctx.db,
      `UPDATE kauro.capture_facts SET version = version + 1, provider_fee_cents = $3, observed_at = greatest(observed_at, $4::timestamptz), evidence_hash = $5
        WHERE capture_id = $1 AND version = $2 RETURNING ${CAPTURE_COLUMNS}`,
      [captureId, expectedVersion, change.providerFeeCents, change.observedAt, change.evidenceHash],
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "capture_facts", "capture_id", "status", captureId, "capture fact");
    const record = captureRecord(row);
    const returned = await refundSums(this.ctx.db, record.captureId, ["COMPLETED"]);
    // a reversed capture returned all its money: a fee learned with or after the reversal is the kept fee, taken whole from the
    // merchant's available balance (movable 0; D-LEDGER-B6, D-LEDGER-B7; B09-R4)
    const movable = movableBalanceOf({ amountCents: record.amountCents, providerFeeCents: current.providerFeeCents ?? 0n, returnedCents: returnedCentsOf(record, returned.serviceCents + returned.taxCents + returned.excessCents) });
    await publishVersion(
      this.ctx,
      "capture",
      { id: record.captureId, agencyId: record.agencyId, version: record.version },
      { previousState: record.status, state: record.status, feeChanged: true },
      captureCandidate(record, { movableBalanceCents: movable, source: record.firstObservationSource }),
    );
    return { kind: "APPLIED", record };
  }
}

// --- commercial authorizations ----------------------------------------------------------------------------------------------------------

interface AuthorizationRow {
  authorization_id: string;
  agency_id: string;
  project_id: string;
  quote_id: string;
  order_id: string;
  order_quote_id: string;
  capture_id: string;
  rebinding_id: string | null;
  approval_id: string;
  approval_hash: string;
  plan_id: string;
  plan_hash: string;
  revision_hash: string;
  target_contract_hash: string;
  capability_id: string;
  capability_version: string;
  mode: ServiceMode;
  billable_units: string;
  version: string;
  state: CommercialAuthorizationState;
  honored_after_price_expiry: boolean;
  job_ref: string | null;
  consumed_at: Date | null;
  delivered_at: Date | null;
  revoked_at: Date | null;
  revocation_phase: RevocationPhase | null;
  revocation_code: string | null;
  created_at: Date;
}

const AUTHORIZATION_FIELDS = [
  "authorization_id",
  "agency_id",
  "project_id",
  "quote_id",
  "order_id",
  "order_quote_id",
  "capture_id",
  "rebinding_id",
  "approval_id",
  "approval_hash",
  "plan_id",
  "plan_hash",
  "revision_hash",
  "target_contract_hash",
  "capability_id",
  "capability_version",
  "mode",
  "billable_units",
  "version",
  "state",
  "honored_after_price_expiry",
  "job_ref",
  "consumed_at",
  "delivered_at",
  "revoked_at",
  "revocation_phase",
  "revocation_code",
  "created_at",
];
const AUTHORIZATION_COLUMNS = AUTHORIZATION_FIELDS.join(", ");
const T_AUTHORIZATION_COLUMNS = AUTHORIZATION_FIELDS.map((c) => `t.${c}`).join(", ");

function authorizationRecord(r: AuthorizationRow): CommercialAuthorizationRecord {
  return defined<CommercialAuthorizationRecord>(
    {
      authorizationId: r.authorization_id as CommercialAuthorizationId,
      agencyId: r.agency_id as AgencyId,
      projectId: r.project_id as ProjectId,
      quoteId: r.quote_id as QuoteId,
      orderId: r.order_id as PaymentOrderId,
      orderQuoteId: r.order_quote_id as QuoteId,
      captureId: r.capture_id as CaptureId,
      approvalId: r.approval_id as ApprovalId,
      approvalHash: r.approval_hash,
      planId: r.plan_id as PlanId,
      planHash: r.plan_hash,
      revisionHash: r.revision_hash,
      targetContractHash: r.target_contract_hash,
      capabilityId: r.capability_id as CapabilityId,
      capabilityVersion: r.capability_version,
      mode: r.mode,
      billableUnits: int(r.billable_units),
      version: int(r.version),
      state: r.state,
      honoredAfterPriceExpiry: r.honored_after_price_expiry,
      createdAt: instant(r.created_at),
    },
    {
      rebindingId: optionalText(r.rebinding_id),
      jobRef: optionalText(r.job_ref),
      consumedAt: optionalInstant(r.consumed_at),
      deliveredAt: optionalInstant(r.delivered_at),
      revokedAt: optionalInstant(r.revoked_at),
      revocationPhase: r.revocation_phase ?? undefined,
      revocationCode: optionalText(r.revocation_code),
    },
  );
}

function authorizationCandidate(a: CommercialAuthorizationRecord, previousState: CommercialAuthorizationState | null): Candidate {
  return {
    authorizationId: a.authorizationId,
    agencyId: a.agencyId,
    projectId: a.projectId,
    quoteId: a.quoteId,
    orderId: a.orderId,
    orderQuoteId: a.orderQuoteId,
    captureId: a.captureId,
    rebindingId: a.rebindingId,
    approvalId: a.approvalId,
    approvalHash: a.approvalHash,
    planHash: a.planHash,
    revisionHash: a.revisionHash,
    targetContractHash: a.targetContractHash,
    capabilityId: a.capabilityId,
    capabilityVersion: a.capabilityVersion,
    mode: a.mode,
    billableUnits: a.billableUnits,
    honoredAfterPriceExpiry: a.honoredAfterPriceExpiry,
    jobRef: a.jobRef,
    phase: a.revocationPhase,
    revocationCode: a.revocationCode,
    previousState,
  };
}

export class PgCommercialAuthorizationRepository implements CommercialAuthorizationRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  async get(authorizationId: CommercialAuthorizationId): Promise<CommercialAuthorizationRecord | null> {
    const r = await execute<AuthorizationRow>(this.ctx.db, `SELECT ${AUTHORIZATION_COLUMNS} FROM kauro.commercial_authorizations WHERE authorization_id = $1`, [authorizationId]);
    return r.rows[0] ? authorizationRecord(r.rows[0]) : null;
  }

  async lock(authorizationId: CommercialAuthorizationId): Promise<CommercialAuthorizationRecord | null> {
    const r = await execute<AuthorizationRow>(this.ctx.db, `SELECT ${AUTHORIZATION_COLUMNS} FROM kauro.commercial_authorizations WHERE authorization_id = $1 FOR NO KEY UPDATE`, [authorizationId]);
    return r.rows[0] ? authorizationRecord(r.rows[0]) : null;
  }

  async findByQuote(quoteId: QuoteId): Promise<CommercialAuthorizationRecord | null> {
    const r = await execute<AuthorizationRow>(this.ctx.db, `SELECT ${AUTHORIZATION_COLUMNS} FROM kauro.commercial_authorizations WHERE quote_id = $1`, [quoteId]);
    return r.rows[0] ? authorizationRecord(r.rows[0]) : null;
  }

  async findLiveByCapture(captureId: CaptureId): Promise<CommercialAuthorizationRecord | null> {
    const r = await execute<AuthorizationRow>(this.ctx.db, `SELECT ${AUTHORIZATION_COLUMNS} FROM kauro.commercial_authorizations WHERE capture_id = $1 AND state <> 'REVOKED'`, [captureId]);
    return r.rows[0] ? authorizationRecord(r.rows[0]) : null;
  }

  /**
   * The live entitlements of an agency bound to a sealed revision by its manifest hash (B09's own query behind the source
   * lifecycle's impact map; design §15 item 6): the integrator binds B07's CommercialScopeInspector to it. Never a B07 table.
   */
  async findLiveByRevisionHash(agencyId: AgencyId, revisionHash: Sha256Hex): Promise<ReadonlyArray<CommercialAuthorizationRecord>> {
    const r = await execute<AuthorizationRow>(
      this.ctx.db,
      `SELECT ${AUTHORIZATION_COLUMNS} FROM kauro.commercial_authorizations WHERE agency_id = $1 AND revision_hash = $2 AND state <> 'REVOKED' ORDER BY created_at, authorization_id`,
      [agencyId, revisionHash],
    );
    return r.rows.map(authorizationRecord);
  }

  /** Payment service only: ACTIVE at version 1 with commercial_authorization.issued.v1; the database re-checks the capture (KP004). */
  async issue(a: NewCommercialAuthorization): Promise<CommercialAuthorizationRecord> {
    const r = await execute<AuthorizationRow>(
      this.ctx.db,
      `INSERT INTO kauro.commercial_authorizations (authorization_id, agency_id, project_id, quote_id, order_id, order_quote_id, capture_id, rebinding_id, approval_id, approval_hash, plan_id, plan_hash, revision_hash, target_contract_hash,
                                                    capability_id, capability_version, mode, billable_units, honored_after_price_expiry, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20) RETURNING ${AUTHORIZATION_COLUMNS}`,
      [
        a.authorizationId,
        a.agencyId,
        a.projectId,
        a.quoteId,
        a.orderId,
        a.orderQuoteId,
        a.captureId,
        a.rebindingId ?? null,
        a.approvalId,
        a.approvalHash,
        a.planId,
        a.planHash,
        a.revisionHash,
        a.targetContractHash,
        a.capabilityId,
        a.capabilityVersion,
        a.mode,
        a.billableUnits,
        a.honoredAfterPriceExpiry,
        a.createdAt,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "commercial authorization insert returned no row");
    const record = authorizationRecord(row);
    await publishVersion(this.ctx, "commercial_authorization", { id: record.authorizationId, agencyId: record.agencyId, version: record.version }, { previousState: null, state: record.state }, authorizationCandidate(record, null));
    return record;
  }

  /**
   * A listed move at expectedVersion + 1: the payment service's revocation (with the phase of the state it leaves; KA008
   * otherwise), or — through the processing package's role (B08) — consumption and delivery.
   */
  async transition(authorizationId: CommercialAuthorizationId, expectedVersion: number, change: AuthorizationChange, _now: UtcInstant): Promise<VersionedWrite<CommercialAuthorizationRecord>> {
    const params: unknown[] = [authorizationId, expectedVersion, change.state];
    const sets = ["version = t.version + 1", "state = $3"];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.jobRef !== undefined) add("job_ref", change.jobRef);
    if (change.consumedAt !== undefined) add("consumed_at", change.consumedAt);
    if (change.deliveredAt !== undefined) add("delivered_at", change.deliveredAt);
    if (change.revocation !== undefined) {
      add("revoked_at", change.revocation.at);
      add("revocation_phase", change.revocation.phase);
      add("revocation_code", change.revocation.code);
    }
    const r = await execute<AuthorizationRow & { previous_state: CommercialAuthorizationState }>(
      this.ctx.db,
      `UPDATE kauro.commercial_authorizations AS t SET ${sets.join(", ")} FROM kauro.commercial_authorizations AS o
        WHERE t.authorization_id = $1 AND t.version = $2 AND o.authorization_id = t.authorization_id
       RETURNING ${T_AUTHORIZATION_COLUMNS}, o.state AS previous_state`,
      params,
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "commercial_authorizations", "authorization_id", "state", authorizationId, "commercial authorization");
    const record = authorizationRecord(row);
    await publishVersion(
      this.ctx,
      "commercial_authorization",
      { id: record.authorizationId, agencyId: record.agencyId, version: record.version },
      { previousState: row.previous_state, state: record.state },
      authorizationCandidate(record, row.previous_state),
    );
    return { kind: "APPLIED", record };
  }
}

// --- purchase re-bindings (D-QUOTE-B6) ------------------------------------------------------------------------------------------------

interface RebindingRow {
  rebinding_id: string;
  agency_id: string;
  project_id: string;
  order_id: string;
  capture_id: string;
  from_quote_id: string;
  from_authorization_id: string;
  to_quote_id: string;
  allowance_ordinal: number;
  reason_code: "PRE_EXECUTION_SOURCE_REPLACEMENT";
  lineage_evidence_hash: string;
  requested_by_membership_id: string;
  created_at: Date;
}

const REBINDING_COLUMNS = "rebinding_id, agency_id, project_id, order_id, capture_id, from_quote_id, from_authorization_id, to_quote_id, allowance_ordinal, reason_code, lineage_evidence_hash, requested_by_membership_id, created_at";

function rebindingRecord(r: RebindingRow): PurchaseRebindingRecord {
  return {
    rebindingId: r.rebinding_id as PurchaseRebindingId,
    agencyId: r.agency_id as AgencyId,
    projectId: r.project_id as ProjectId,
    orderId: r.order_id as PaymentOrderId,
    captureId: r.capture_id as CaptureId,
    fromQuoteId: r.from_quote_id as QuoteId,
    fromAuthorizationId: r.from_authorization_id as CommercialAuthorizationId,
    toQuoteId: r.to_quote_id as QuoteId,
    allowanceOrdinal: int(r.allowance_ordinal),
    reasonCode: r.reason_code,
    lineageEvidenceHash: r.lineage_evidence_hash,
    requestedByMembershipId: r.requested_by_membership_id as MembershipId,
    createdAt: instant(r.created_at),
  };
}

export class PgPurchaseRebindingRepository implements PurchaseRebindingRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Payment service only; append-only: the guard (KP013) checks the allowance, the intact purchase, the replacement and the
   * lineage; the same unit of work then revokes, supersedes, accepts and issues (purchase_rebindings_complete at COMMIT).
   */
  async record(b: PurchaseRebindingRecord): Promise<PurchaseRebindingRecord> {
    const r = await execute<RebindingRow>(
      this.db,
      `INSERT INTO kauro.purchase_rebindings (rebinding_id, agency_id, project_id, order_id, capture_id, from_quote_id, from_authorization_id, to_quote_id, allowance_ordinal, reason_code, lineage_evidence_hash, requested_by_membership_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${REBINDING_COLUMNS}`,
      [b.rebindingId, b.agencyId, b.projectId, b.orderId, b.captureId, b.fromQuoteId, b.fromAuthorizationId, b.toQuoteId, b.allowanceOrdinal, b.reasonCode, b.lineageEvidenceHash, b.requestedByMembershipId, b.createdAt],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "purchase re-binding insert returned no row");
    return rebindingRecord(row);
  }

  async listForCapture(captureId: CaptureId): Promise<ReadonlyArray<PurchaseRebindingRecord>> {
    const r = await execute<RebindingRow>(this.db, `SELECT ${REBINDING_COLUMNS} FROM kauro.purchase_rebindings WHERE capture_id = $1 ORDER BY allowance_ordinal`, [captureId]);
    return r.rows.map(rebindingRecord);
  }

  async findTo(quoteId: QuoteId): Promise<PurchaseRebindingRecord | null> {
    const r = await execute<RebindingRow>(this.db, `SELECT ${REBINDING_COLUMNS} FROM kauro.purchase_rebindings WHERE to_quote_id = $1`, [quoteId]);
    return r.rows[0] ? rebindingRecord(r.rows[0]) : null;
  }
}
