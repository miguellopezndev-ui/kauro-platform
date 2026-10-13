/**
 * Payment orders, payment attempts and provider observations over `pg` (package B09; migration 0015; design §4.3, §6.1,
 * D-MACH-B2, D-PROTO-B1..B6, D-PAY-B3, D-AUTH-B4).
 *
 * The request handlers insert the order INTENT_CREATED and its CREATE_ORDER or CAPTURE attempt PREPARED (T1) and take the claim
 * edges (T2); the payment service applies every provider result. The claim PREPARED -> DISPATCHING writes its dispatch deadline as
 * now() + DISPATCH_DEADLINE_SECONDS in the claim's own statement, on the database's clock (D-PROTO-B6; B09-N7): a caller's deadline
 * is never written, and payment_attempts_dispatch_deadline_bound refuses any other. Every versioned write is a compare-and-swap that
 * publishes the event of the state it reaches.
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  DISPATCH_DEADLINE_SECONDS,
  DomainFailure,
  type AgencyId,
  type ApprovalId,
  type AttemptChange,
  type EvidenceArtifactRef,
  type InboxId,
  type JournalEntryId,
  type MembershipId,
  type MerchantRef,
  type NewPaymentAttempt,
  type NewPaymentOrder,
  type NewProviderObservation,
  type ObservationId,
  type PaymentAttemptId,
  type PaymentAttemptRecord,
  type PaymentAttemptRepository,
  type PaymentAttemptState,
  type PaymentEnvironment,
  type PaymentOrderChange,
  type PaymentOrderId,
  type PaymentOrderRecord,
  type PaymentOrderRepository,
  type PaymentOrderState,
  type PaymentRouteId,
  type ProjectId,
  type ProviderObservationRecord,
  type ProviderObservationRepository,
  type QuoteId,
  type RefundId,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, type Queryable } from "../sql.js";
import { cents, defined, optionalCents, publishVersion, staleOf, type CommerceWriteContext } from "./commerce-shared.js";

/** The states of an order whose checkout is still open (payment_orders_one_open_per_project), unless its expired bank order released it (0057). */
export const OPEN_ORDER_STATES: ReadonlyArray<PaymentOrderState> = ["INTENT_CREATED", "CREATING", "CREATED", "APPROVED", "CAPTURING", "CAPTURE_UNCERTAIN"];
/** The states of a live attempt (payment_attempts_one_live_order, payment_attempts_one_live_refund). */
export const LIVE_ATTEMPT_STATES: ReadonlyArray<PaymentAttemptState> = ["PREPARED", "DISPATCHING", "PROVIDER_PENDING", "UNCERTAIN"];

// --- payment orders --------------------------------------------------------------------------------------------------------------

interface OrderRow {
  order_id: string;
  agency_id: string;
  project_id: string;
  quote_id: string;
  approval_id: string;
  version: string;
  state: PaymentOrderState;
  provider: string;
  environment: PaymentEnvironment;
  route_id: string;
  merchant_ref: string;
  payee_digest: string;
  provider_order_id: string | null;
  provider_approval_url: string | null;
  expected_amount_cents: string;
  expected_service_cents: string;
  expected_tax_cents: string;
  currency: "USD";
  terms_hash: string;
  idempotency_hash: string;
  allocated_cents: string;
  created_by_membership_id: string;
  intent_entry_id: string;
  created_at: Date;
  updated_at: Date;
}

const ORDER_FIELDS = [
  "order_id",
  "agency_id",
  "project_id",
  "quote_id",
  "approval_id",
  "version",
  "state",
  "provider",
  "environment",
  "route_id",
  "merchant_ref",
  "payee_digest",
  "provider_order_id",
  "provider_approval_url",
  "expected_amount_cents",
  "expected_service_cents",
  "expected_tax_cents",
  "currency",
  "terms_hash",
  "idempotency_hash",
  "allocated_cents",
  "created_by_membership_id",
  "intent_entry_id",
  "created_at",
  "updated_at",
];
const ORDER_COLUMNS = ORDER_FIELDS.join(", ");
const T_ORDER_COLUMNS = ORDER_FIELDS.map((c) => `t.${c}`).join(", ");

function orderRecord(r: OrderRow): PaymentOrderRecord {
  return defined<PaymentOrderRecord>(
    {
      orderId: r.order_id as PaymentOrderId,
      agencyId: r.agency_id as AgencyId,
      projectId: r.project_id as ProjectId,
      quoteId: r.quote_id as QuoteId,
      approvalId: r.approval_id as ApprovalId,
      version: int(r.version),
      state: r.state,
      provider: r.provider,
      environment: r.environment,
      routeId: r.route_id as PaymentRouteId,
      merchantRef: r.merchant_ref as MerchantRef,
      payeeDigest: r.payee_digest,
      expectedAmountCents: cents(r.expected_amount_cents),
      expectedServiceCents: cents(r.expected_service_cents),
      expectedTaxCents: cents(r.expected_tax_cents),
      currency: r.currency,
      termsHash: r.terms_hash,
      idempotencyHash: r.idempotency_hash,
      allocatedCents: cents(r.allocated_cents),
      createdByMembershipId: r.created_by_membership_id as MembershipId,
      intentEntryId: r.intent_entry_id as JournalEntryId,
      createdAt: instant(r.created_at),
      updatedAt: instant(r.updated_at),
    },
    { providerOrderId: optionalText(r.provider_order_id), providerApprovalUrl: optionalText(r.provider_approval_url) },
  );
}

function orderCandidate(o: PaymentOrderRecord, previousState: PaymentOrderState | null): Readonly<Record<string, string | number | bigint | null | undefined>> {
  return {
    orderId: o.orderId,
    agencyId: o.agencyId,
    projectId: o.projectId,
    quoteId: o.quoteId,
    environment: o.environment,
    expectedAmountCents: o.expectedAmountCents,
    currency: o.currency,
    idempotencyHash: o.idempotencyHash,
    previousState,
  };
}

export class PgPaymentOrderRepository implements PaymentOrderRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  async get(orderId: PaymentOrderId): Promise<PaymentOrderRecord | null> {
    const r = await execute<OrderRow>(this.ctx.db, `SELECT ${ORDER_COLUMNS} FROM kauro.payment_orders WHERE order_id = $1`, [orderId]);
    return r.rows[0] ? orderRecord(r.rows[0]) : null;
  }

  async lock(orderId: PaymentOrderId): Promise<PaymentOrderRecord | null> {
    const r = await execute<OrderRow>(this.ctx.db, `SELECT ${ORDER_COLUMNS} FROM kauro.payment_orders WHERE order_id = $1 FOR UPDATE`, [orderId]);
    return r.rows[0] ? orderRecord(r.rows[0]) : null;
  }

  async findByIntentEntry(entryId: JournalEntryId): Promise<PaymentOrderRecord | null> {
    const r = await execute<OrderRow>(this.ctx.db, `SELECT ${ORDER_COLUMNS} FROM kauro.payment_orders WHERE intent_entry_id = $1`, [entryId]);
    return r.rows[0] ? orderRecord(r.rows[0]) : null;
  }

  async findOpenForProject(projectId: ProjectId): Promise<PaymentOrderRecord | null> {
    const r = await execute<OrderRow>(this.ctx.db, `SELECT ${ORDER_COLUMNS} FROM kauro.payment_orders WHERE project_id = $1 AND state = ANY ($2::text[]) AND bank_slot_released_at IS NULL`, [projectId, [...OPEN_ORDER_STATES]]);
    return r.rows[0] ? orderRecord(r.rows[0]) : null;
  }

  /** T1: INTENT_CREATED at version 1 with payment_order.intent_created.v1 (a second open order fails payment_orders_one_open_per_project). */
  async insert(order: NewPaymentOrder): Promise<PaymentOrderRecord> {
    const r = await execute<OrderRow>(
      this.ctx.db,
      `INSERT INTO kauro.payment_orders (order_id, agency_id, project_id, quote_id, approval_id, provider, environment, route_id, merchant_ref, payee_digest, expected_amount_cents, expected_service_cents, expected_tax_cents,
                                         currency, terms_hash, idempotency_hash, created_by_membership_id, intent_entry_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19) RETURNING ${ORDER_COLUMNS}`,
      [
        order.orderId,
        order.agencyId,
        order.projectId,
        order.quoteId,
        order.approvalId,
        order.route.provider,
        order.route.environment,
        order.route.routeId,
        order.route.merchantRef,
        order.route.payeeDigest,
        order.expectedAmountCents,
        order.expectedServiceCents,
        order.expectedTaxCents,
        order.route.currency,
        order.termsHash,
        order.idempotencyHash,
        order.createdByMembershipId,
        order.intentEntryId,
        order.createdAt,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "payment order insert returned no row");
    const record = orderRecord(row);
    await publishVersion(this.ctx, "payment_order", { id: record.orderId, agencyId: record.agencyId, version: record.version }, { previousState: null, state: record.state }, orderCandidate(record, null));
    return record;
  }

  /** A listed move at expectedVersion + 1; the provider identity and approval URL are learned once (KA004 on a re-point). */
  async transition(orderId: PaymentOrderId, expectedVersion: number, change: PaymentOrderChange, _now: UtcInstant): Promise<VersionedWrite<PaymentOrderRecord>> {
    const params: unknown[] = [orderId, expectedVersion, change.state];
    const sets = ["version = t.version + 1", "state = $3"];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.providerOrderId !== undefined) add("provider_order_id", change.providerOrderId);
    if (change.providerApprovalUrl !== undefined) add("provider_approval_url", change.providerApprovalUrl);
    const r = await execute<OrderRow & { previous_state: PaymentOrderState }>(
      this.ctx.db,
      `UPDATE kauro.payment_orders AS t SET ${sets.join(", ")} FROM kauro.payment_orders AS o
        WHERE t.order_id = $1 AND t.version = $2 AND o.order_id = t.order_id
       RETURNING ${T_ORDER_COLUMNS}, o.state AS previous_state`,
      params,
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "payment_orders", "order_id", "state", orderId, "payment order");
    const record = orderRecord(row);
    await publishVersion(this.ctx, "payment_order", { id: record.orderId, agencyId: record.agencyId, version: record.version }, { previousState: row.previous_state, state: record.state }, orderCandidate(record, row.previous_state));
    return { kind: "APPLIED", record };
  }
}

// --- payment attempts ------------------------------------------------------------------------------------------------------------------

interface AttemptRow {
  attempt_id: string;
  agency_id: string;
  order_id: string;
  refund_id: string | null;
  operation: PaymentAttemptRecord["operation"];
  ordinal: number;
  version: string;
  state: PaymentAttemptState;
  provider: string;
  environment: PaymentEnvironment;
  request_hash: string;
  provider_request_id: string;
  dispatch_deadline_at: Date | null;
  started_at: Date;
  last_observed_at: Date;
  evidence_hash: string | null;
  outcome_code: string | null;
  intent_entry_id: string | null;
}

const ATTEMPT_FIELDS = [
  "attempt_id",
  "agency_id",
  "order_id",
  "refund_id",
  "operation",
  "ordinal",
  "version",
  "state",
  "provider",
  "environment",
  "request_hash",
  "provider_request_id",
  "dispatch_deadline_at",
  "started_at",
  "last_observed_at",
  "evidence_hash",
  "outcome_code",
  "intent_entry_id",
];
const ATTEMPT_COLUMNS = ATTEMPT_FIELDS.join(", ");
const T_ATTEMPT_COLUMNS = ATTEMPT_FIELDS.map((c) => `t.${c}`).join(", ");

function attemptRecord(r: AttemptRow): PaymentAttemptRecord {
  return defined<PaymentAttemptRecord>(
    {
      attemptId: r.attempt_id as PaymentAttemptId,
      agencyId: r.agency_id as AgencyId,
      orderId: r.order_id as PaymentOrderId,
      operation: r.operation,
      ordinal: int(r.ordinal),
      version: int(r.version),
      state: r.state,
      provider: r.provider,
      environment: r.environment,
      requestHash: r.request_hash,
      providerRequestId: r.provider_request_id,
      startedAt: instant(r.started_at),
      lastObservedAt: instant(r.last_observed_at),
    },
    {
      refundId: optionalText(r.refund_id),
      dispatchDeadlineAt: optionalInstant(r.dispatch_deadline_at),
      evidenceHash: optionalText(r.evidence_hash),
      outcomeCode: optionalText(r.outcome_code),
      intentEntryId: optionalText(r.intent_entry_id),
    },
  );
}

function attemptCandidate(a: PaymentAttemptRecord, previousState: PaymentAttemptState | null): Readonly<Record<string, string | number | null | undefined>> {
  return {
    attemptId: a.attemptId,
    agencyId: a.agencyId,
    orderId: a.orderId,
    refundId: a.refundId,
    operation: a.operation,
    ordinal: a.ordinal,
    requestHash: a.requestHash,
    evidenceHash: a.evidenceHash,
    outcomeCode: a.outcomeCode,
    previousState,
  };
}

type AttemptTarget = { readonly orderId: PaymentOrderId; readonly operation: "CREATE_ORDER" | "CAPTURE" } | { readonly refundId: RefundId };

function targetClause(target: AttemptTarget): { readonly where: string; readonly params: unknown[] } {
  return "refundId" in target
    ? { where: "refund_id = $1", params: [target.refundId] }
    : { where: "order_id = $1 AND operation = $2 AND refund_id IS NULL", params: [target.orderId, target.operation] };
}

export class PgPaymentAttemptRepository implements PaymentAttemptRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  async get(attemptId: PaymentAttemptId): Promise<PaymentAttemptRecord | null> {
    const r = await execute<AttemptRow>(this.ctx.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.payment_attempts WHERE attempt_id = $1`, [attemptId]);
    return r.rows[0] ? attemptRecord(r.rows[0]) : null;
  }

  async lock(attemptId: PaymentAttemptId): Promise<PaymentAttemptRecord | null> {
    const r = await execute<AttemptRow>(this.ctx.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.payment_attempts WHERE attempt_id = $1 FOR UPDATE`, [attemptId]);
    return r.rows[0] ? attemptRecord(r.rows[0]) : null;
  }

  async findByIntentEntry(entryId: JournalEntryId): Promise<PaymentAttemptRecord | null> {
    const r = await execute<AttemptRow>(this.ctx.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.payment_attempts WHERE intent_entry_id = $1`, [entryId]);
    return r.rows[0] ? attemptRecord(r.rows[0]) : null;
  }

  async findLive(target: AttemptTarget): Promise<PaymentAttemptRecord | null> {
    const t = targetClause(target);
    const r = await execute<AttemptRow>(this.ctx.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.payment_attempts WHERE ${t.where} AND state = ANY ($${t.params.length + 1}::text[])`, [...t.params, [...LIVE_ATTEMPT_STATES]]);
    return r.rows[0] ? attemptRecord(r.rows[0]) : null;
  }

  async countFor(target: AttemptTarget): Promise<number> {
    const t = targetClause(target);
    const r = await execute<{ n: string }>(this.ctx.db, `SELECT count(*)::text AS n FROM kauro.payment_attempts WHERE ${t.where}`, t.params);
    return int(r.rows[0]?.n ?? "0");
  }

  async listForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<PaymentAttemptRecord>> {
    const r = await execute<AttemptRow>(this.ctx.db, `SELECT ${ATTEMPT_COLUMNS} FROM kauro.payment_attempts WHERE order_id = $1 ORDER BY started_at, attempt_id`, [orderId]);
    return r.rows.map(attemptRecord);
  }

  /** The durable intent: PREPARED at version 1 with payment_attempt.prepared.v1, before any provider call is possible. */
  async prepare(attempt: NewPaymentAttempt): Promise<PaymentAttemptRecord> {
    const r = await execute<AttemptRow>(
      this.ctx.db,
      `INSERT INTO kauro.payment_attempts (attempt_id, agency_id, order_id, refund_id, operation, ordinal, provider, environment, request_hash, provider_request_id, started_at, last_observed_at, intent_entry_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $11, $11) RETURNING ${ATTEMPT_COLUMNS}`,
      [attempt.attemptId, attempt.agencyId, attempt.orderId, attempt.refundId ?? null, attempt.operation, attempt.ordinal, attempt.provider, attempt.environment, attempt.requestHash, attempt.providerRequestId, attempt.startedAt, attempt.intentEntryId ?? null],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "payment attempt insert returned no row");
    const record = attemptRecord(row);
    await publishVersion(this.ctx, "payment_attempt", { id: record.attemptId, agencyId: record.agencyId, version: record.version }, { previousState: null, state: record.state }, attemptCandidate(record, null));
    return record;
  }

  /**
   * A listed move at expectedVersion + 1. The claim (PREPARED -> DISPATCHING) writes only its state and the database's deadline,
   * now() + DISPATCH_DEADLINE_SECONDS, in this statement (D-PROTO-B6): `change.dispatchDeadlineAt` is never written, and the
   * request handlers' column grant holds nothing else. Every result (the payment service's) records its observation time, its
   * evidence and its outcome token.
   */
  async transition(attemptId: PaymentAttemptId, expectedVersion: number, change: AttemptChange, _now: UtcInstant): Promise<VersionedWrite<PaymentAttemptRecord>> {
    const params: unknown[] = [attemptId, expectedVersion, change.state];
    const sets = ["version = t.version + 1", "state = $3"];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.state === "DISPATCHING") {
      params.push(DISPATCH_DEADLINE_SECONDS);
      sets.push(`dispatch_deadline_at = now() + make_interval(secs => $${params.length}::double precision)`);
    } else {
      params.push(change.lastObservedAt);
      sets.push(`last_observed_at = greatest(t.last_observed_at, $${params.length}::timestamptz)`);
      if (change.evidenceHash !== undefined) add("evidence_hash", change.evidenceHash);
      if (change.outcomeCode !== undefined) add("outcome_code", change.outcomeCode);
    }
    const r = await execute<AttemptRow & { previous_state: PaymentAttemptState }>(
      this.ctx.db,
      `UPDATE kauro.payment_attempts AS t SET ${sets.join(", ")} FROM kauro.payment_attempts AS o
        WHERE t.attempt_id = $1 AND t.version = $2 AND o.attempt_id = t.attempt_id
       RETURNING ${T_ATTEMPT_COLUMNS}, o.state AS previous_state`,
      params,
    );
    const row = r.rows[0];
    if (!row) return staleOf(this.ctx.db, "payment_attempts", "attempt_id", "state", attemptId, "payment attempt");
    const record = attemptRecord(row);
    await publishVersion(this.ctx, "payment_attempt", { id: record.attemptId, agencyId: record.agencyId, version: record.version }, { previousState: row.previous_state, state: record.state }, attemptCandidate(record, row.previous_state));
    return { kind: "APPLIED", record };
  }
}

// --- provider observations (history; D-PAY-B3) -----------------------------------------------------------------------------------------

interface ObservationRow {
  observation_id: string;
  agency_id: string;
  order_id: string;
  source: ProviderObservationRecord["source"];
  inbox_id: string | null;
  attempt_id: string | null;
  artifact_ref: string | null;
  subject_kind: ProviderObservationRecord["subjectKind"];
  provider_ref: string;
  observed_status: string;
  amount_cents: string | null;
  currency: string | null;
  payee_digest: string | null;
  provider_event_at: Date | null;
  observed_at: Date;
  evidence_hash: string;
  effect: ProviderObservationRecord["effect"];
}

const OBSERVATION_COLUMNS =
  "observation_id, agency_id, order_id, source, inbox_id, attempt_id, artifact_ref, subject_kind, provider_ref, observed_status, amount_cents, currency, payee_digest, provider_event_at, observed_at, evidence_hash, effect";

function observationRecord(r: ObservationRow): ProviderObservationRecord {
  return defined<ProviderObservationRecord>(
    {
      observationId: r.observation_id as ObservationId,
      agencyId: r.agency_id as AgencyId,
      orderId: r.order_id as PaymentOrderId,
      source: r.source,
      subjectKind: r.subject_kind,
      providerRef: r.provider_ref,
      observedStatus: r.observed_status,
      observedAt: instant(r.observed_at),
      evidenceHash: r.evidence_hash,
      effect: r.effect,
    },
    {
      inboxId: optionalText(r.inbox_id) as InboxId | undefined,
      attemptId: optionalText(r.attempt_id) as PaymentAttemptId | undefined,
      artifactRef: optionalText(r.artifact_ref) as EvidenceArtifactRef | undefined,
      amountCents: optionalCents(r.amount_cents),
      currency: optionalText(r.currency),
      payeeDigest: optionalText(r.payee_digest),
      providerEventAt: optionalInstant(r.provider_event_at),
    },
  );
}

/** The effects of observations that were applied to their subject (the state they report was taken as current). */
const APPLIED_EFFECTS = ["ADVANCED", "NO_CHANGE"] as const;

export class PgProviderObservationRepository implements ProviderObservationRepository {
  constructor(private readonly ctx: CommerceWriteContext) {}

  /** Appends one observation with its effect (payment service only); a webhook event and a query artifact apply once per subject. */
  async append(o: NewProviderObservation): Promise<ProviderObservationRecord> {
    const r = await execute<ObservationRow>(
      this.ctx.db,
      `INSERT INTO kauro.provider_observations (observation_id, agency_id, order_id, source, inbox_id, attempt_id, artifact_ref, subject_kind, provider_ref, observed_status, amount_cents, currency, payee_digest, provider_event_at, observed_at, evidence_hash, effect, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING ${OBSERVATION_COLUMNS}`,
      [
        this.ctx.ids.next(),
        o.agencyId,
        o.orderId,
        o.source,
        o.inboxId ?? null,
        o.attemptId ?? null,
        o.artifactRef ?? null,
        o.subjectKind,
        o.providerRef,
        o.observedStatus,
        o.amountCents ?? null,
        o.currency ?? null,
        o.payeeDigest ?? null,
        o.providerEventAt ?? null,
        o.observedAt,
        o.evidenceHash,
        o.effect,
        this.ctx.clock.now(),
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "provider observation insert returned no row");
    return observationRecord(row);
  }

  async listForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<ProviderObservationRecord>> {
    const r = await execute<ObservationRow>(this.ctx.db, `SELECT ${OBSERVATION_COLUMNS} FROM kauro.provider_observations WHERE order_id = $1 ORDER BY observed_at, observation_id`, [orderId]);
    return r.rows.map(observationRecord);
  }

  /** The latest observation time of a subject whose observation was applied (ADVANCED or NO_CHANGE); history effects never count. */
  async latestAppliedAt(orderId: PaymentOrderId, subjectKind: "ORDER" | "CAPTURE" | "REFUND", providerRef: string): Promise<UtcInstant | null> {
    const r = await execute<{ at: Date | null }>(
      this.ctx.db,
      "SELECT max(observed_at) AS at FROM kauro.provider_observations WHERE order_id = $1 AND subject_kind = $2 AND provider_ref = $3 AND effect = ANY ($4::text[])",
      [orderId, subjectKind, providerRef, [...APPLIED_EFFECTS]],
    );
    const at = r.rows[0]?.at ?? null;
    return at === null ? null : instant(at);
  }
}
