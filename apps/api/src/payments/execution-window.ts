/**
 * X2 the manual execution window (Payments V1, lane L-REFUND slice 2; docs/design/ACH-ROUTE.md r12 §7.21, DV1-08): a DECLARED attempt whose
 * window (declaredAt + the manual execution window of the account's route version in force) has passed at the database clock lapses to
 * UNCERTAIN, its refund with it (CAPTURE: the refund SUBMITTING → UNCERTAIN; BANK_CREDIT: the treasury refund), and one UNCERTAIN_EFFECT
 * review case opens. Nothing is released: the source's share stays held and nothing is ever resent (NEVER-RESEND); only a record (G2/G4)
 * or the owner's resolution (X3) moves the attempt on.
 *
 * Registered as the EXECUTION_WINDOW bank sweep of the payment service's periodic pass. Each attempt lapses in its own SERVICE unit, which
 * finds the next due attempt this pass has not judged yet (newest first; the pass drains them all), adopts its scope (CAPTURE), locks its
 * row (L3; the sweep never takes L1, §7.28), judges the window again at the effect clock after that lock wait (a record that committed
 * meanwhile, or a pass that already lapsed it, leaves it alone), then writes the lapse, its events and the case, atomically. A failed unit
 * never stops the others; the pass rejects with the first failure once every due attempt was judged (the bank sweep runner reports it).
 *
 * GAP (reported): the pass runs under the payment service's sweep; it does not re-check the dispatcher lease fence before its COMMIT.
 */
import type { UtcInstant } from "@kauro/contracts";
import { publishAttemptEvent, publishTreasuryRefundEvent } from "@kauro/application";
import type { CausationId, CorrelationId, RefundId, ServiceContext } from "@kauro/domain";
import { StaleVersionFailure } from "@kauro/domain";
import { bankRefundsOf, effectInstantOf } from "@kauro/persistence";
import type { PaymentRuntime } from "./runtime.js";
import { causedBy } from "./runtime.js";
import { registerBankSweep } from "./sweep.js";

/** The detail code of the UNCERTAIN_EFFECT case the lapse opens (a server token). */
export const EXECUTION_WINDOW_LAPSED = "EXECUTION_WINDOW_LAPSED";
/** A bound on the units of one pass (a runaway guard: the pass drains every due attempt, one unit each; the next pass takes any rest). */
export const EXECUTION_WINDOW_BATCH = 500;

function serviceContext(rt: PaymentRuntime): ServiceContext {
  return { kind: "SERVICE", serviceId: rt.self.serviceId, correlationId: rt.ids.next() as CorrelationId };
}

const lapsedAt = (declaredAt: string, windowMs: number | null, at: UtcInstant): boolean => windowMs === null || Date.parse(declaredAt) + windowMs <= Date.parse(at);

type Uow = Parameters<Parameters<PaymentRuntime["assembly"]["commerce"]["run"]>[1]>[0];

/** Lapses one attempt if it is still DECLARED past its window at the effect clock; answers whether it lapsed. */
export async function lapseAttempt(rt: PaymentRuntime, attemptId: string): Promise<boolean> {
  const context = serviceContext(rt);
  return rt.assembly.commerce.run(context, (uow) => lapseIn(uow, context, attemptId));
}

async function lapseIn(uow: Uow, context: ServiceContext, attemptId: string): Promise<boolean> {
  const repo = bankRefundsOf(uow);
  const seen = await repo.attempt(attemptId);
  if (seen === null) return false;
  if (seen.sourceKind === "CAPTURE" && (await uow.adoptScope("REFUND", seen.refundId as RefundId)) === null) return false;
  const attempt = await repo.lockAttempt(attemptId);
  if (attempt === null || attempt.state !== "DECLARED") return false;
  const windowMs = await repo.executionWindowMs(attempt.environment, attempt.accountRef);
  const at = await effectInstantOf(uow);
  if (!lapsedAt(attempt.declaredAt, windowMs, at)) return false;
  causedBy(uow, attempt.attemptId);
  const causationId = attempt.attemptId as string as CausationId;
  const lapsed = await repo.lapseAttempt(attempt.attemptId, attempt.version);
  if (lapsed === null) throw new StaleVersionFailure(attempt.version, attempt.state);
  await publishAttemptEvent(uow, context, causationId, lapsed, "outbound.uncertain.v1", { previousState: attempt.state });
  if (attempt.kind === "RETURN") {
    if (attempt.sourceKind === "CAPTURE") {
      const c = uow.commerce;
      const refund = (await c.refunds.lock(attempt.refundId as RefundId)) ?? (await c.refunds.get(attempt.refundId as RefundId));
      if (refund !== null && refund.state === "SUBMITTING") {
        const w = await c.refunds.transition(refund.refundId, refund.version, { state: "UNCERTAIN" }, at);
        if (w.kind === "STALE") throw new StaleVersionFailure(w.currentVersion, w.currentState);
      }
    } else {
      const t = await repo.lockTreasuryRefund(attempt.treasuryRefundId!);
      if (t !== null && t.state === "SUBMITTING") {
        const moved = await repo.transitionTreasuryRefund(t.treasuryRefundId, t.version, "UNCERTAIN");
        if (moved === null) throw new StaleVersionFailure(t.version, t.state);
        await publishTreasuryRefundEvent(uow, context, causationId, moved, "treasury_refund.uncertain.v1", { attemptId: attempt.attemptId, previousState: moved.previousState });
      }
    }
  }
  await repo.openCaseIfNone({
    caseId: uow.ids.next() as string,
    kind: "UNCERTAIN_EFFECT",
    environment: attempt.environment,
    accountRef: attempt.accountRef,
    attemptId: attempt.attemptId,
    sourceKind: attempt.sourceKind,
    sourceId: attempt.sourceId,
    detailCode: EXECUTION_WINDOW_LAPSED,
    evidenceHash: null,
  });
  return true;
}

/**
 * One pass: one SERVICE unit per due attempt, each listing (at its own effect clock) the newest due attempt the pass has not judged and
 * lapsing it in that same unit. A unit that fails after picking its attempt never stops the rest; one that fails before picking ends the
 * pass (nothing was judged, the next pass retries). Answers the lapsed ids; rejects with the first failure after the drain.
 */
export async function executionWindowPass(rt: PaymentRuntime): Promise<ReadonlyArray<string>> {
  const seen = new Set<string>();
  const lapsed: string[] = [];
  let first: { readonly error: unknown } | null = null;
  for (let unit = 0; unit < EXECUTION_WINDOW_BATCH; unit++) {
    const context = serviceContext(rt);
    let picked: string | null = null;
    try {
      const did = await rt.assembly.commerce.run(context, async (uow) => {
        const due = await bankRefundsOf(uow).dueAttempts(await effectInstantOf(uow), seen.size + 1);
        picked = due.find((d) => !seen.has(d.attemptId))?.attemptId ?? null;
        return picked === null ? false : lapseIn(uow, context, picked);
      });
      if (picked === null) break;
      seen.add(picked);
      if (did) lapsed.push(picked);
    } catch (e) {
      first ??= { error: e };
      if (picked === null) break;
      seen.add(picked);
    }
  }
  if (first !== null) throw first.error;
  return lapsed;
}

registerBankSweep("EXECUTION_WINDOW", async (rt) => {
  await executionWindowPass(rt);
});
