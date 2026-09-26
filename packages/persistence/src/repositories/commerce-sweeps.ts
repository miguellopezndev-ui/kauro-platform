/**
 * The queries behind the payment service's bounded periodic pass (package B09, stage-2 mandate M3; design §6.1 "Watchdog" and
 * "Cancel before dispatch", D-PROTO-B4): the attempts whose dispatch deadline passed while their effect is still unknown (index
 * payment_attempts_watchdog) and the intents whose claim never committed (index payment_attempts_unclaimed). The payment service
 * sees one agency at a time (D-CTX-B1): the pass reads the agencies that hold stored payment operations from the scope index,
 * which kauro_payment reads whole (migration 0009 commerce_scopes_payment_read), then adopts each agency through one of its
 * stored operations and reads that agency's due attempts under its own policies. Nothing here writes: every settlement of what
 * the pass finds is a unit of work of its own, through the reconciler (a stored provider query, CMD034) or the cancellation of an
 * unclaimed intent.
 *
 * The event-driven half of the watchdog needs none of this: the PAYMENT_SERVICE consumer receives payment_attempt.dispatching.v1,
 * .provider_pending.v1 and .uncertain.v1 with the attempt's agency and order. The periodic pass is its backstop, and the only path
 * to an intent whose claim never committed (a PREPARED attempt publishes nothing the payment service subscribes to).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyId, PaymentAttemptId, PaymentAttemptState, PaymentOperation, PaymentOrderId, RefundId } from "@kauro/domain";
import { execute, instant, type Queryable } from "../sql.js";

/** An agency holding stored payment operations, and the key of one of them (what a SERVICE unit of work adopts it through). */
export interface AgencyWithPayments {
  readonly agencyId: AgencyId;
  readonly orderKey: PaymentOrderId;
}

/** An attempt the pass settles, with what its settlement needs. */
export interface SweptAttempt {
  readonly attemptId: PaymentAttemptId;
  readonly orderId: PaymentOrderId;
  readonly refundId?: RefundId;
  readonly operation: Exclude<PaymentOperation, "WITHDRAW">;
  readonly state: PaymentAttemptState;
  readonly startedAt: UtcInstant;
  readonly dispatchDeadlineAt?: UtcInstant;
}

interface AttemptRow {
  attempt_id: string;
  order_id: string;
  refund_id: string | null;
  operation: Exclude<PaymentOperation, "WITHDRAW">;
  state: PaymentAttemptState;
  started_at: Date;
  dispatch_deadline_at: Date | null;
}

function swept(r: AttemptRow): SweptAttempt {
  return {
    attemptId: r.attempt_id as PaymentAttemptId,
    orderId: r.order_id as PaymentOrderId,
    operation: r.operation,
    state: r.state,
    startedAt: instant(r.started_at),
    ...(r.refund_id !== null ? { refundId: r.refund_id as RefundId } : {}),
    ...(r.dispatch_deadline_at !== null ? { dispatchDeadlineAt: instant(r.dispatch_deadline_at) } : {}),
  };
}

export class PgPaymentSweeps {
  constructor(private readonly db: Queryable) {}

  /** The agencies that hold stored payment operations, one order key each, in agency order after `after` (a bounded page). */
  async agenciesWithPayments(limit: number, after: AgencyId | null = null): Promise<ReadonlyArray<AgencyWithPayments>> {
    const r = await execute<{ agency_id: string; scope_key: string }>(
      this.db,
      `SELECT DISTINCT ON (agency_id) agency_id, scope_key FROM kauro.commerce_scopes
        WHERE scope_kind = 'PAYMENT_ORDER' AND ($2::uuid IS NULL OR agency_id > $2::uuid)
        ORDER BY agency_id, scope_key LIMIT $1`,
      [limit, after],
    );
    return r.rows.map((x) => ({ agencyId: x.agency_id as AgencyId, orderKey: x.scope_key as PaymentOrderId }));
  }

  /** The adopted agency's attempts whose dispatch deadline is at or before `at` while their effect is unknown (payment_attempts_watchdog). */
  async dueAttempts(at: UtcInstant, limit: number): Promise<ReadonlyArray<SweptAttempt>> {
    const r = await execute<AttemptRow>(
      this.db,
      `SELECT attempt_id, order_id, refund_id, operation, state, started_at, dispatch_deadline_at FROM kauro.payment_attempts
        WHERE state IN ('DISPATCHING', 'PROVIDER_PENDING', 'UNCERTAIN') AND dispatch_deadline_at <= $1
        ORDER BY dispatch_deadline_at, attempt_id LIMIT $2`,
      [at, limit],
    );
    return r.rows.map(swept);
  }

  /** The adopted agency's intents still PREPARED since `startedBefore` or earlier: their claim never committed (payment_attempts_unclaimed). */
  async unclaimedAttempts(startedBefore: UtcInstant, limit: number): Promise<ReadonlyArray<SweptAttempt>> {
    const r = await execute<AttemptRow>(
      this.db,
      `SELECT attempt_id, order_id, refund_id, operation, state, started_at, dispatch_deadline_at FROM kauro.payment_attempts
        WHERE state = 'PREPARED' AND started_at <= $1
        ORDER BY started_at, attempt_id LIMIT $2`,
      [startedBefore, limit],
    );
    return r.rows.map(swept);
  }
}
