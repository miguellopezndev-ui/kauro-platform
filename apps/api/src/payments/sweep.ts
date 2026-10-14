/**
 * The payment service's bounded periodic pass (docs/design/B09-payments-fiscal.md §6.1 "Watchdog" and "Cancel before dispatch",
 * D-PROTO-B4; stage-2 mandate M3): the backstop of the event-driven watchdog and the only path to an intent whose claim never
 * committed. Agency by agency (the payment service sees one agency at a time, D-CTX-B1), it
 *
 *  - cancels every intent still PREPARED after the claim window (index payment_attempts_unclaimed): no provider call was possible,
 *    since the claim (T2) is the only path to a call — the attempt PREPARED → CANCELLED_BEFORE_DISPATCH and an order still
 *    INTENT_CREATED → CANCELLED, one unit of work each, under the order's row lock and the attempt's (a claim racing the sweep
 *    takes the same locks: the compare-and-swap admits one), so a later resume of the same key finds the operation cancelled and
 *    answers it;
 *  - settles every attempt whose dispatch deadline passed while its effect is unknown (index payment_attempts_watchdog): a stored
 *    provider query applied through CMD034 (watchAttempt).
 */
import type { UtcInstant } from "@kauro/contracts";
import { publishVersionEvent, versionEvent } from "@kauro/application";
import type { AgencyId, CorrelationId, PaymentAttemptId, PaymentOrderId, ServiceContext } from "@kauro/domain";
import { DISPATCH_DEADLINE_SECONDS, DomainFailure, toUtcInstant } from "@kauro/domain";
import { paymentSweepsOf, type SweptAttempt } from "@kauro/persistence";
import type { PaymentRuntime } from "./runtime.js";
import { causedBy } from "./runtime.js";
import { NotDueYet, watchAttempt } from "./service-commands.js";

/**
 * How long an intent may stay PREPARED before the sweep cancels it: the dispatch deadline a claim would have recorded (D-PROTO-B6).
 * The command that recorded the intent claims it at once (T2 follows T1 in the same request); an intent older than this was left by
 * a request that died between them and whose client did not resume it (decision D-M3-B4).
 */
export const CLAIM_WINDOW_SECONDS = DISPATCH_DEADLINE_SECONDS;

/** The outcome code of an intent the sweep cancelled (a server token; payment_attempt.cancelled_before_dispatch.v1). */
export const CLAIM_NEVER_COMMITTED = "CLAIM_NEVER_COMMITTED";

export interface SweepPass {
  readonly agencies: number;
  readonly cancelled: ReadonlyArray<PaymentAttemptId>;
  readonly watched: ReadonlyArray<{ readonly attemptId: PaymentAttemptId; readonly outcome: "APPLIED" | "NOT_APPLICABLE" | "NOT_DUE" | "FAILED" }>;
}

function serviceContext(rt: PaymentRuntime): ServiceContext {
  return { kind: "SERVICE", serviceId: rt.self.serviceId, correlationId: rt.ids.next() as CorrelationId };
}

/**
 * Cancels one intent whose claim never committed (PREPARED → CANCELLED_BEFORE_DISPATCH; an order still INTENT_CREATED →
 * CANCELLED), in one SERVICE unit of work that adopted the order's agency, under the order's row lock and then the attempt's.
 * Answers whether it cancelled (an attempt claimed or settled meanwhile is left alone).
 */
export async function cancelUnclaimed(rt: PaymentRuntime, orderId: PaymentOrderId, attemptId: PaymentAttemptId, startedBefore: UtcInstant): Promise<boolean> {
  return rt.assembly.commerce.run(serviceContext(rt), async (uow) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", orderId)) === null) return false;
    const c = uow.commerce;
    const order = await c.orders.lock(orderId);
    const attempt = await c.attempts.lock(attemptId);
    if (order === null || attempt === null || attempt.orderId !== orderId) return false;
    if (attempt.state !== "PREPARED" || Date.parse(attempt.startedAt) > Date.parse(startedBefore)) return false;
    causedBy(uow, attempt.intentEntryId ?? attemptId);
    const now = rt.clock.now();
    const w = await c.attempts.transition(attemptId, attempt.version, { state: "CANCELLED_BEFORE_DISPATCH", lastObservedAt: now, outcomeCode: CLAIM_NEVER_COMMITTED }, now);
    if (w.kind === "STALE") return false;
    const causation = (attempt.intentEntryId ?? attemptId) as string as Parameters<typeof publishVersionEvent>[2];
    await publishVersionEvent(
      uow,
      versionEvent("payment_attempt", attemptId, w.record.version, order.agencyId, { previousState: "PREPARED", state: "CANCELLED_BEFORE_DISPATCH" }, {
        attemptId,
        agencyId: order.agencyId,
        orderId,
        refundId: attempt.refundId,
        operation: attempt.operation,
        ordinal: attempt.ordinal,
        outcomeCode: CLAIM_NEVER_COMMITTED,
        previousState: "PREPARED",
      }),
      causation,
    );
    if (attempt.operation === "CREATE_ORDER" && order.state === "INTENT_CREATED") {
      const o = await c.orders.transition(orderId, order.version, { state: "CANCELLED" }, now);
      if (o.kind === "STALE") throw new DomainFailure("STALE_VERSION", "the order changed under its row lock", { currentVersion: o.currentVersion, currentState: o.currentState }, true);
      await publishVersionEvent(
        uow,
        versionEvent("payment_order", orderId, o.record.version, order.agencyId, { previousState: "INTENT_CREATED", state: "CANCELLED" }, { orderId, agencyId: order.agencyId, attemptId, outcomeCode: CLAIM_NEVER_COMMITTED, previousState: "INTENT_CREATED" }),
        causation,
      );
    }
    return true;
  });
}

// --- Payments V1 registration seam (lane KIT; docs/design/ACH-ROUTE.md §7.12, §7.21) --------------------------------------------------

/** The sweeps of the bank-transfer route: E1 the transfer-deadline expiry and X2 the manual execution window. */
export const BANK_SWEEP_NAMES = ["TRANSFER_EXPIRY", "EXECUTION_WINDOW"] as const;
export type BankSweepName = (typeof BANK_SWEEP_NAMES)[number];
/** One bounded pass of a bank sweep under the payment service's identity and fenced lease; it takes its own locks (ACH-ROUTE §7.28). */
export type BankSweep = (rt: PaymentRuntime) => Promise<void>;

const bankSweeps = new Map<BankSweepName, BankSweep>();

/** Registers the one pass of a bank sweep; a second registration of a name is refused. With nothing registered runSweepPass is unchanged. */
export function registerBankSweep(name: BankSweepName, sweep: BankSweep): void {
  if (bankSweeps.has(name)) throw new Error(`the bank sweep ${name} is already registered`);
  bankSweeps.set(name, sweep);
}

async function runBankSweeps(rt: PaymentRuntime): Promise<void> {
  for (const sweep of bankSweeps.values()) {
    try {
      await sweep(rt);
    } catch (e) {
      rt.onBackgroundFailure(rt.ids.next(), e);
    }
  }
}

/** One bounded pass over up to `agencies` agencies holding stored payment operations, up to `limit` attempts of each. */
export async function runSweepPass(rt: PaymentRuntime, options: { readonly agencies?: number; readonly limit?: number; readonly after?: AgencyId } = {}): Promise<SweepPass> {
  // the bank sweeps first: each takes its own locks in its first unit of work (ACH-ROUTE §7.28), the card attempts' pass follows
  await runBankSweeps(rt);
  const now = rt.clock.now();
  const startedBefore = toUtcInstant(Date.parse(now) - CLAIM_WINDOW_SECONDS * 1000);
  const agencies = await rt.assembly.commerce.run(serviceContext(rt), (uow) => paymentSweepsOf(uow).agenciesWithPayments(options.agencies ?? 50, options.after ?? null));
  const cancelled: PaymentAttemptId[] = [];
  const watched: Array<SweepPass["watched"][number]> = [];
  for (const agency of agencies) {
    const found = await rt.assembly.commerce.run(serviceContext(rt), async (uow): Promise<{ readonly due: ReadonlyArray<SweptAttempt>; readonly unclaimed: ReadonlyArray<SweptAttempt> } | null> => {
      if ((await uow.adoptScope("PAYMENT_ORDER", agency.orderKey)) !== agency.agencyId) return null;
      const sweeps = paymentSweepsOf(uow);
      return { due: await sweeps.dueAttempts(now, options.limit ?? 25), unclaimed: await sweeps.unclaimedAttempts(startedBefore, options.limit ?? 25) };
    });
    if (found === null) continue;
    for (const a of found.unclaimed) {
      try {
        if (await cancelUnclaimed(rt, a.orderId, a.attemptId, startedBefore)) cancelled.push(a.attemptId);
      } catch (e) {
        rt.onBackgroundFailure(rt.ids.next(), e);
      }
    }
    for (const a of found.due) {
      try {
        watched.push({ attemptId: a.attemptId, outcome: await watchAttempt(rt, a.orderId, a.attemptId) });
      } catch (e) {
        if (e instanceof NotDueYet) watched.push({ attemptId: a.attemptId, outcome: "NOT_DUE" });
        else {
          watched.push({ attemptId: a.attemptId, outcome: "FAILED" });
          rt.onBackgroundFailure(rt.ids.next(), e);
        }
      }
    }
  }
  return { agencies: agencies.length, cancelled, watched };
}
