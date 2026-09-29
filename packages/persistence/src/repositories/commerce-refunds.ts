/**
 * Refunds, reconciliation cases and provider event exceptions over `pg` (package B09; migration 0016; design §4.4, D-MACH-B5,
 * D-MACH-B6, D-REF-B1..B6, D-AUTHZ-B2, D-ING-B2, D-ING-B3, D-LEDGER-B5).
 *
 * The agency files its own request (CMD031), the payment service files the reconciler's server requests with INSERT ... ON
 * CONFLICT DO NOTHING against refunds_one_requested_per_origin (a repeated or concurrent filing can never abort the transaction
 * that records the capture it follows; B09-F3), a corporate owner in the finance scope reviews a REQUESTED refund (the database
 * checks the grant, segregation, the ceiling and the tax rule: KP007, KP008, KP003, KP009, KP010, KP012), and the payment service
 * executes an approved one. A completion reads the capture's funds state after SELECT ... FOR SHARE of the capture row, so its
 * refund.completed.v1 names the provider balance the money is returned from (D-LEDGER-B5); the completions of one capture then take
 * the capture's refund lock in turn (0016 refunds_completion_order, D-REF-B7), so the service basis and the movable balance the event
 * carries (R2-081, D-LEDGER-B6) count every completion of the capture committed before it. Cases open once per kind and subject.
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type AgencyId,
  type AssuranceProofId,
  type CaptureId,
  type DeliveryPhase,
  type EvidenceArtifactRef,
  type EvidenceRef,
  type InboxId,
  type MembershipId,
  type NewReconciliationCase,
  type NewRefundRequest,
  type PaymentAttemptId,
  type PaymentOrderId,
  type ProjectId,
  type ProviderEventExceptionRecord,
  type ProviderExceptionId,
  type ProviderExceptionRepository,
  type ReconciliationCaseId,
  type ReconciliationCaseRecord,
  type ReconciliationCaseRepository,
  type RefundApprovalRecord,
  type RefundChange,
  type RefundId,
  type RefundOrigin,
  type RefundPolicyId,
  type RefundRecord,
  type RefundRepository,
  type RefundState,
  type UserId,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, type Queryable } from "../sql.js";
import { cents, defined, optionalCents, publishVersion, staleOf, type CommerceWriteContext } from "./commerce-shared.js";

type Candidate = Readonly<Record<string, string | number | bigint | boolean | null | undefined>>;

// --- refunds -----------------------------------------------------------------------------------------------------------------------

interface RefundRow {
  refund_id: string;
  agency_id: string;
  project_id: string;
  order_id: string;
  capture_id: string;
  version: string;
  state: RefundState;
  origin: RefundOrigin;
  reason_code: string;
  evidence_ref: string | null;
  terms_hash: string;
  delivery_phase: DeliveryPhase;
  proposed_service_cents: string;
  proposed_tax_cents: string;
  proposed_excess_cents: string;
  requested_by_membership_id: string | null;
  requested_by_user_id: string | null;
  requested_at: Date;
  approved_service_cents: string | null;
  approved_tax_cents: string | null;
  approved_excess_cents: string | null;
  authorization_kind: RefundApprovalRecord["authorizationKind"] | null;
  authorization_proof_ref: string | null;
  authorization_policy_id: string | null;
  authorization_hash: string | null;
  effects_hash: string | null;
  credit_note_required: boolean | null;
  approved_by_user_id: string | null;
  approved_at: Date | null;
  rejection_code: string | null;
  rejected_by_user_id: string | null;
  rejected_at: Date | null;
  provider_refund_id: string | null;
  evidence_hash: string | null;
  completed_at: Date | null;
  failure_code: string | null;
}

const REFUND_FIELDS = [
  "refund_id",
  "agency_id",
  "project_id",
  "order_id",
  "capture_id",
  "version",
  "state",
  "origin",
  "reason_code",
  "evidence_ref",
  "terms_hash",
  "delivery_phase",
  "proposed_service_cents",
  "proposed_tax_cents",
  "proposed_excess_cents",
  "requested_by_membership_id",
  "requested_by_user_id",
  "requested_at",
  "approved_service_cents",
  "approved_tax_cents",
  "approved_excess_cents",
  "authorization_kind",
  "authorization_proof_ref",
  "authorization_policy_id",
  "authorization_hash",
  "effects_hash",
  "credit_note_required",
  "approved_by_user_id",
  "approved_at",
  "rejection_code",
  "rejected_by_user_id",
  "rejected_at",
  "provider_refund_id",
  "evidence_hash",
  "completed_at",
  "failure_code",
];
const REFUND_COLUMNS = REFUND_FIELDS.join(", ");
const T_REFUND_COLUMNS = REFUND_FIELDS.map((c) => `t.${c}`).join(", ");

function approvalOf(r: RefundRow): RefundApprovalRecord | undefined {
  if (r.approved_at === null) return undefined;
  if (r.approved_service_cents === null || r.approved_tax_cents === null || r.approved_excess_cents === null || r.authorization_kind === null || r.authorization_hash === null || r.effects_hash === null || r.credit_note_required === null || r.approved_by_user_id === null) {
    throw new DomainFailure("INTEGRITY_FAILURE", "stored refund intent is incomplete");
  }
  return defined<RefundApprovalRecord>(
    {
      amounts: { serviceCents: cents(r.approved_service_cents), taxCents: cents(r.approved_tax_cents), excessCents: cents(r.approved_excess_cents) },
      authorizationKind: r.authorization_kind,
      authorizationHash: r.authorization_hash,
      effectsHash: r.effects_hash,
      creditNoteRequired: r.credit_note_required,
      approvedByUserId: r.approved_by_user_id as UserId,
      approvedAt: instant(r.approved_at),
    },
    { authorizationProofRef: optionalText(r.authorization_proof_ref) as AssuranceProofId | undefined, authorizationPolicyId: optionalText(r.authorization_policy_id) as RefundPolicyId | undefined },
  );
}

function refundRecord(r: RefundRow): RefundRecord {
  return defined<RefundRecord>(
    {
      refundId: r.refund_id as RefundId,
      agencyId: r.agency_id as AgencyId,
      projectId: r.project_id as ProjectId,
      orderId: r.order_id as PaymentOrderId,
      captureId: r.capture_id as CaptureId,
      version: int(r.version),
      state: r.state,
      origin: r.origin,
      reasonCode: r.reason_code,
      termsHash: r.terms_hash,
      deliveryPhase: r.delivery_phase,
      proposed: { serviceCents: cents(r.proposed_service_cents), taxCents: cents(r.proposed_tax_cents), excessCents: cents(r.proposed_excess_cents) },
      requestedAt: instant(r.requested_at),
    },
    {
      evidenceRef: optionalText(r.evidence_ref) as EvidenceRef | undefined,
      requestedByMembershipId: optionalText(r.requested_by_membership_id) as MembershipId | undefined,
      requestedByUserId: optionalText(r.requested_by_user_id) as UserId | undefined,
      approved: approvalOf(r),
      rejected: r.rejected_at === null ? undefined : { code: r.rejection_code ?? "", byUserId: (r.rejected_by_user_id ?? "") as UserId, at: instant(r.rejected_at) },
      providerRefundId: optionalText(r.provider_refund_id),
      evidenceHash: optionalText(r.evidence_hash),
      completedAt: optionalInstant(r.completed_at),
      failureCode: optionalText(r.failure_code),
    },
  );
}

/** What a refund event may carry (the reason is a label and never enters a payload; B06 D-API-1, D-LABEL-B1). */
function refundCandidate(f: RefundRecord, previousState: RefundState | null, extra: Candidate = {}): Candidate {
  return {
    refundId: f.refundId,
    agencyId: f.agencyId,
    projectId: f.projectId,
    orderId: f.orderId,
    captureId: f.captureId,
    origin: f.origin,
    deliveryPhase: f.deliveryPhase,
    proposedServiceCents: f.proposed.serviceCents,
    proposedTaxCents: f.proposed.taxCents,
    proposedExcessCents: f.proposed.excessCents,
    serviceCents: f.approved?.amounts.serviceCents,
    taxCents: f.approved?.amounts.taxCents,
    excessCents: f.approved?.amounts.excessCents,
    authorizationKind: f.approved?.authorizationKind,
    authorizationHash: f.approved?.authorizationHash,
    effectsHash: f.approved?.effectsHash,
    creditNoteRequired: f.approved?.creditNoteRequired,
    rejectionCode: f.rejected?.code,
    failureCode: f.failureCode,
    evidenceHash: f.evidenceHash,
    previousState,
    ...extra,
  };
}

const REQUEST_INSERT = `INSERT INTO kauro.refunds (refund_id, agency_id, project_id, order_id, capture_id, provider, environment, origin, reason_code, evidence_ref, terms_hash, delivery_phase,
                                   proposed_service_cents, proposed_tax_cents, proposed_excess_cents, requested_by_membership_id, requested_by_user_id, requested_at, created_at, updated_at)
  SELECT $1, $2, $3, $4, $5, o.provider, o.environment, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $16
    FROM kauro.payment_orders o WHERE o.agency_id = $2 AND o.order_id = $4`;

function requestParams(f: NewRefundRequest): unknown[] {
  return [
    f.refundId,
    f.agencyId,
    f.projectId,
    f.orderId,
    f.captureId,
    f.origin,
    f.reasonCode,
    f.evidenceRef ?? null,
    f.termsHash,
    f.deliveryPhase,
    f.proposed.serviceCents,
    f.proposed.taxCents,
    f.proposed.excessCents,
    f.requestedByMembershipId ?? null,
    f.requestedByUserId ?? null,
    f.requestedAt,
  ];
}

export class PgRefundRepository implements RefundRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  async get(refundId: RefundId): Promise<RefundRecord | null> {
    const r = await execute<RefundRow>(this.ctx.db, `SELECT ${REFUND_COLUMNS} FROM kauro.refunds WHERE refund_id = $1`, [refundId]);
    return r.rows[0] ? refundRecord(r.rows[0]) : null;
  }

  async lock(refundId: RefundId): Promise<RefundRecord | null> {
    const r = await execute<RefundRow>(this.ctx.db, `SELECT ${REFUND_COLUMNS} FROM kauro.refunds WHERE refund_id = $1 FOR UPDATE`, [refundId]);
    return r.rows[0] ? refundRecord(r.rows[0]) : null;
  }

  async listForCapture(captureId: CaptureId): Promise<ReadonlyArray<RefundRecord>> {
    const r = await execute<RefundRow>(this.ctx.db, `SELECT ${REFUND_COLUMNS} FROM kauro.refunds WHERE capture_id = $1 ORDER BY requested_at, refund_id`, [captureId]);
    return r.rows.map(refundRecord);
  }

  async findOpenForCapture(captureId: CaptureId, origin: RefundOrigin): Promise<RefundRecord | null> {
    const r = await execute<RefundRow>(this.ctx.db, `SELECT ${REFUND_COLUMNS} FROM kauro.refunds WHERE capture_id = $1 AND origin = $2 AND state = 'REQUESTED'`, [captureId, origin]);
    return r.rows[0] ? refundRecord(r.rows[0]) : null;
  }

  /**
   * CMD031: REQUESTED at version 1 with refund.requested.v1 (the provider and environment are the order's own, refunds_order_fk); a
   * second open customer request of the capture fails refunds_one_requested_per_origin (PRECONDITION_FAILED REFUND_REQUEST_OPEN).
   */
  async request(refund: NewRefundRequest): Promise<RefundRecord> {
    const r = await execute<RefundRow>(this.ctx.db, `${REQUEST_INSERT} RETURNING ${REFUND_COLUMNS}`, requestParams(refund));
    const row = r.rows[0];
    if (!row) throw new DomainFailure("NOT_FOUND", "the order of the refund is not visible in this context");
    const record = refundRecord(row);
    await publishVersion(this.ctx, "refund", { id: record.refundId, agencyId: record.agencyId, version: record.version }, { previousState: null, state: record.state }, refundCandidate(record, null));
    return record;
  }

  /**
   * The reconciler's server-originated request (EXCESS_CAPTURE, KAURO_REMEDY), filed with INSERT ... ON CONFLICT DO NOTHING against
   * refunds_one_requested_per_origin: an open request of the same capture and origin is the answer (filed false) and nothing is
   * published; a filing never aborts the transaction that records the capture (B09-F3). The REFUND scope row is the caller's.
   */
  async fileServerRequest(refund: NewRefundRequest): Promise<{ readonly filed: boolean; readonly record: RefundRecord }> {
    const r = await execute<RefundRow>(this.ctx.db, `${REQUEST_INSERT} ON CONFLICT (agency_id, capture_id, origin) WHERE state = 'REQUESTED' DO NOTHING RETURNING ${REFUND_COLUMNS}`, requestParams(refund));
    const row = r.rows[0];
    if (row) {
      const record = refundRecord(row);
      await publishVersion(this.ctx, "refund", { id: record.refundId, agencyId: record.agencyId, version: record.version }, { previousState: null, state: record.state }, refundCandidate(record, null));
      return { filed: true, record };
    }
    const open = await this.findOpenForCapture(refund.captureId, refund.origin);
    if (open === null) throw new DomainFailure("NOT_FOUND", "the order of the refund is not visible in this context");
    return { filed: false, record: open };
  }

  /**
   * REQUESTED -> APPROVED with the immutable intent (CMD032), under the database's review authority (KP007, KP008, KP010) and
   * commitment ceiling (READ COMMITTED only, KP009; KP003; KP012), publishing refund.approved.v1 to the executor.
   */
  async approve(refundId: RefundId, expectedVersion: number, approval: RefundApprovalRecord, _now: UtcInstant): Promise<VersionedWrite<RefundRecord>> {
    const r = await execute<RefundRow & { previous_state: RefundState }>(
      this.ctx.db,
      `UPDATE kauro.refunds AS t SET version = t.version + 1, state = 'APPROVED', approved_service_cents = $3, approved_tax_cents = $4, approved_excess_cents = $5,
              authorization_kind = $6, authorization_proof_ref = $7, authorization_policy_id = $8, authorization_hash = $9, effects_hash = $10,
              credit_note_required = $11, approved_by_user_id = $12, approved_at = $13
         FROM kauro.refunds AS o
        WHERE t.refund_id = $1 AND t.version = $2 AND o.refund_id = t.refund_id
       RETURNING ${T_REFUND_COLUMNS}, o.state AS previous_state`,
      [
        refundId,
        expectedVersion,
        approval.amounts.serviceCents,
        approval.amounts.taxCents,
        approval.amounts.excessCents,
        approval.authorizationKind,
        approval.authorizationProofRef ?? null,
        approval.authorizationPolicyId ?? null,
        approval.authorizationHash,
        approval.effectsHash,
        approval.creditNoteRequired,
        approval.approvedByUserId,
        approval.approvedAt,
      ],
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "refunds", "refund_id", "state", refundId, "refund");
    const record = refundRecord(row);
    await publishVersion(this.ctx, "refund", { id: record.refundId, agencyId: record.agencyId, version: record.version }, { previousState: row.previous_state, state: record.state }, refundCandidate(record, row.previous_state));
    return { kind: "APPLIED", record };
  }

  /**
   * Every other listed move at expectedVersion + 1: the review's rejection (the finance scope), the execution's edges (the payment
   * service). A completion first takes SELECT ... FOR SHARE of its capture row (the capture before the refund, design §6.2); its
   * update then waits for any other completion of the capture in flight (refunds_completion_order, D-REF-B7), and it publishes
   * refund.completed.v1 with the funds state read under the row lock, the capture's remaining service basis (R2-081) and the capture's
   * movable balance before this refund — its amount less the reported fee and the money the completions before it returned — read
   * after that wait (D-LEDGER-B6).
   */
  async transition(refundId: RefundId, expectedVersion: number, change: RefundChange, _now: UtcInstant): Promise<VersionedWrite<RefundRecord>> {
    let fundsState: string | undefined;
    if (change.state === "COMPLETED") {
      const funds = await execute<{ funds_state: string }>(
        this.ctx.db,
        "SELECT c.funds_state FROM kauro.capture_facts c WHERE c.capture_id = (SELECT f.capture_id FROM kauro.refunds f WHERE f.refund_id = $1) FOR SHARE",
        [refundId],
      );
      fundsState = funds.rows[0]?.funds_state;
      if (fundsState === undefined) throw new DomainFailure("NOT_FOUND", "the refund or its capture is not visible in this context");
    }
    const params: unknown[] = [refundId, expectedVersion, change.state];
    const sets = ["version = t.version + 1", "state = $3"];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.providerRefundId !== undefined) add("provider_refund_id", change.providerRefundId);
    if (change.evidenceHash !== undefined) add("evidence_hash", change.evidenceHash);
    if (change.completedAt !== undefined) add("completed_at", change.completedAt);
    if (change.failureCode !== undefined) add("failure_code", change.failureCode);
    if (change.rejected !== undefined) {
      add("rejection_code", change.rejected.code);
      add("rejected_by_user_id", change.rejected.byUserId);
      add("rejected_at", change.rejected.at);
    }
    const r = await execute<RefundRow & { previous_state: RefundState }>(
      this.ctx.db,
      `UPDATE kauro.refunds AS t SET ${sets.join(", ")} FROM kauro.refunds AS o
        WHERE t.refund_id = $1 AND t.version = $2 AND o.refund_id = t.refund_id
       RETURNING ${T_REFUND_COLUMNS}, o.state AS previous_state`,
      params,
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "refunds", "refund_id", "state", refundId, "refund");
    const record = refundRecord(row);
    let extra: Candidate = {};
    if (record.state === "COMPLETED") {
      const balance = await execute<{ basis: string; movable: string }>(
        this.ctx.db,
        `SELECT greatest(c.allocated_service_cents - coalesce(sum(r.approved_service_cents), 0), 0)::text AS basis,
                greatest(c.amount_cents - coalesce(c.provider_fee_cents, 0)
                         - coalesce(sum(r.approved_service_cents + r.approved_tax_cents + r.approved_excess_cents) FILTER (WHERE r.refund_id <> $2), 0), 0)::text AS movable
           FROM kauro.capture_facts c LEFT JOIN kauro.refunds r ON r.capture_id = c.capture_id AND r.state = 'COMPLETED'
          WHERE c.capture_id = $1
          GROUP BY c.capture_id, c.allocated_service_cents, c.amount_cents, c.provider_fee_cents`,
        [record.captureId, record.refundId],
      );
      const sums = balance.rows[0];
      extra = { fundsState, serviceBasisAfterCents: sums ? cents(sums.basis) : undefined, movableBalanceCents: sums ? cents(sums.movable) : undefined };
    }
    await publishVersion(this.ctx, "refund", { id: record.refundId, agencyId: record.agencyId, version: record.version }, { previousState: row.previous_state, state: record.state }, refundCandidate(record, row.previous_state, extra));
    return { kind: "APPLIED", record };
  }
}

// --- reconciliation cases -------------------------------------------------------------------------------------------------------------

interface CaseRow {
  case_id: string;
  agency_id: string;
  order_id: string | null;
  capture_id: string | null;
  refund_id: string | null;
  kind: ReconciliationCaseRecord["kind"];
  version: string;
  state: ReconciliationCaseRecord["state"];
  detail_code: string;
  amount_cents: string | null;
  currency: string | null;
  evidence_hash: string;
  opened_at: Date;
  resolved_at: Date | null;
  resolution_code: string | null;
}

const CASE_FIELDS = ["case_id", "agency_id", "order_id", "capture_id", "refund_id", "kind", "version", "state", "detail_code", "amount_cents", "currency", "evidence_hash", "opened_at", "resolved_at", "resolution_code"];
const CASE_COLUMNS = CASE_FIELDS.join(", ");
const T_CASE_COLUMNS = CASE_FIELDS.map((c) => `t.${c}`).join(", ");

function caseRecord(r: CaseRow): ReconciliationCaseRecord {
  return defined<ReconciliationCaseRecord>(
    {
      caseId: r.case_id as ReconciliationCaseId,
      agencyId: r.agency_id as AgencyId,
      kind: r.kind,
      version: int(r.version),
      state: r.state,
      detailCode: r.detail_code,
      evidenceHash: r.evidence_hash,
      openedAt: instant(r.opened_at),
    },
    {
      orderId: optionalText(r.order_id),
      captureId: optionalText(r.capture_id),
      refundId: optionalText(r.refund_id),
      amountCents: optionalCents(r.amount_cents),
      currency: optionalText(r.currency),
      resolvedAt: optionalInstant(r.resolved_at),
      resolutionCode: optionalText(r.resolution_code),
    },
  );
}

function caseCandidate(c: ReconciliationCaseRecord): Candidate {
  return {
    caseId: c.caseId,
    agencyId: c.agencyId,
    orderId: c.orderId,
    captureId: c.captureId,
    refundId: c.refundId,
    kind: c.kind,
    detailCode: c.detailCode,
    amountCents: c.amountCents,
    currency: c.currency,
    resolutionCode: c.resolutionCode,
  };
}

export class PgReconciliationCaseRepository implements ReconciliationCaseRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  /**
   * Opens a case (payment service only), or answers the open case of the same kind and subject (reconciliation_cases_one_open): a
   * repeated observation adds history, never a second case, and publishes nothing.
   */
  async open(entry: NewReconciliationCase): Promise<{ readonly opened: boolean; readonly record: ReconciliationCaseRecord }> {
    const r = await execute<CaseRow>(
      this.ctx.db,
      `INSERT INTO kauro.reconciliation_cases (case_id, agency_id, order_id, capture_id, refund_id, kind, detail_code, amount_cents, currency, evidence_hash, opened_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $11)
       ON CONFLICT (agency_id, kind, coalesce(order_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(capture_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(refund_id, '00000000-0000-0000-0000-000000000000'::uuid))
         WHERE state = 'OPEN' DO NOTHING
       RETURNING ${CASE_COLUMNS}`,
      [entry.caseId, entry.agencyId, entry.orderId ?? null, entry.captureId ?? null, entry.refundId ?? null, entry.kind, entry.detailCode, entry.amountCents ?? null, entry.currency ?? null, entry.evidenceHash, entry.openedAt],
    );
    const row = r.rows[0];
    if (row) {
      const record = caseRecord(row);
      await publishVersion(this.ctx, "reconciliation_case", { id: record.caseId, agencyId: record.agencyId, version: record.version }, { previousState: null, state: record.state }, caseCandidate(record));
      return { opened: true, record };
    }
    const open = await execute<CaseRow>(
      this.ctx.db,
      `SELECT ${CASE_COLUMNS} FROM kauro.reconciliation_cases
        WHERE agency_id = $1 AND kind = $2 AND order_id IS NOT DISTINCT FROM $3::uuid AND capture_id IS NOT DISTINCT FROM $4::uuid AND refund_id IS NOT DISTINCT FROM $5::uuid AND state = 'OPEN'`,
      [entry.agencyId, entry.kind, entry.orderId ?? null, entry.captureId ?? null, entry.refundId ?? null],
    );
    const existing = open.rows[0];
    if (!existing) throw new DomainFailure("INTEGRITY_FAILURE", "a case of this kind and subject conflicted but is not visible");
    return { opened: false, record: caseRecord(existing) };
  }

  /** OPEN -> RESOLVED by the finance scope's person (resolved_by_user_id is the session's own; the policy checks it). */
  async resolve(caseId: ReconciliationCaseId, expectedVersion: number, resolutionCode: string, now: UtcInstant): Promise<VersionedWrite<ReconciliationCaseRecord>> {
    const r = await execute<CaseRow>(
      this.ctx.db,
      `UPDATE kauro.reconciliation_cases AS t SET version = t.version + 1, state = 'RESOLVED', resolved_at = $3, resolution_code = $4, resolved_by_user_id = kauro.current_user_id()
        WHERE t.case_id = $1 AND t.version = $2 RETURNING ${T_CASE_COLUMNS}`,
      [caseId, expectedVersion, now, resolutionCode],
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "reconciliation_cases", "case_id", "state", caseId, "reconciliation case");
    const record = caseRecord(row);
    await publishVersion(this.ctx, "reconciliation_case", { id: record.caseId, agencyId: record.agencyId, version: record.version }, { previousState: "OPEN", state: record.state }, caseCandidate(record));
    return { kind: "APPLIED", record };
  }

  async listOpenForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<ReconciliationCaseRecord>> {
    const r = await execute<CaseRow>(this.ctx.db, `SELECT ${CASE_COLUMNS} FROM kauro.reconciliation_cases WHERE order_id = $1 AND state = 'OPEN' ORDER BY opened_at, case_id`, [orderId]);
    return r.rows.map(caseRecord);
  }
}

// --- provider event exceptions ---------------------------------------------------------------------------------------------------------

interface ExceptionRow {
  exception_id: string;
  source: ProviderEventExceptionRecord["source"];
  agency_id: string | null;
  order_id: string | null;
  inbox_id: string | null;
  attempt_id: string | null;
  artifact_ref: string | null;
  provider: string;
  environment: ProviderEventExceptionRecord["environment"];
  kind: ProviderEventExceptionRecord["kind"];
  provider_ref: string | null;
  amount_cents: string | null;
  currency: string | null;
  evidence_hash: string;
  observed_at: Date;
}

const EXCEPTION_COLUMNS = "exception_id, source, agency_id, order_id, inbox_id, attempt_id, artifact_ref, provider, environment, kind, provider_ref, amount_cents, currency, evidence_hash, observed_at";

function exceptionRecord(r: ExceptionRow): ProviderEventExceptionRecord {
  return defined<ProviderEventExceptionRecord>(
    { exceptionId: r.exception_id as ProviderExceptionId, source: r.source, provider: r.provider, environment: r.environment, kind: r.kind, evidenceHash: r.evidence_hash, observedAt: instant(r.observed_at) },
    {
      agencyId: optionalText(r.agency_id) as AgencyId | undefined,
      orderId: optionalText(r.order_id) as PaymentOrderId | undefined,
      inboxId: optionalText(r.inbox_id) as InboxId | undefined,
      attemptId: optionalText(r.attempt_id) as PaymentAttemptId | undefined,
      artifactRef: optionalText(r.artifact_ref) as EvidenceArtifactRef | undefined,
      providerRef: optionalText(r.provider_ref),
      amountCents: optionalCents(r.amount_cents),
      currency: optionalText(r.currency),
    },
  );
}

export class PgProviderExceptionRepository implements ProviderExceptionRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  /**
   * Records an authenticated observation no order can take (payment service; with no agency adopted for an unattributed webhook),
   * idempotent per source and kind: the recorded row is the answer to a repetition (recorded false).
   */
  async record(e: Omit<ProviderEventExceptionRecord, "exceptionId">): Promise<{ readonly recorded: boolean; readonly record: ProviderEventExceptionRecord }> {
    const r = await execute<ExceptionRow>(
      this.ctx.db,
      `INSERT INTO kauro.provider_event_exceptions (exception_id, source, agency_id, order_id, inbox_id, attempt_id, artifact_ref, provider, environment, kind, provider_ref, amount_cents, currency, evidence_hash, observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT DO NOTHING RETURNING ${EXCEPTION_COLUMNS}`,
      [
        this.ctx.ids.next(),
        e.source,
        e.agencyId ?? null,
        e.orderId ?? null,
        e.inboxId ?? null,
        e.attemptId ?? null,
        e.artifactRef ?? null,
        e.provider,
        e.environment,
        e.kind,
        e.providerRef ?? null,
        e.amountCents ?? null,
        e.currency ?? null,
        e.evidenceHash,
        e.observedAt,
        this.ctx.clock.now(),
      ],
    );
    const row = r.rows[0];
    if (row) return { recorded: true, record: exceptionRecord(row) };
    const existing = await execute<ExceptionRow>(
      this.ctx.db,
      `SELECT ${EXCEPTION_COLUMNS} FROM kauro.provider_event_exceptions
        WHERE kind = $1 AND ((inbox_id IS NOT NULL AND inbox_id = $2::uuid) OR (attempt_id IS NOT NULL AND attempt_id = $3::uuid) OR (artifact_ref IS NOT NULL AND artifact_ref = $4::uuid))`,
      [e.kind, e.inboxId ?? null, e.attemptId ?? null, e.artifactRef ?? null],
    );
    const found = existing.rows[0];
    if (!found) throw new DomainFailure("INTEGRITY_FAILURE", "a provider exception of this source and kind conflicted but is not visible");
    return { recorded: false, record: exceptionRecord(found) };
  }
}
