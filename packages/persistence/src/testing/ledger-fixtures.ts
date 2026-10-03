/**
 * Fixtures of package B10's commission ledger and statement adapters (@kauro/persistence/testing; mandate B10-ADAPTERS-LEDGER; design
 * §6, §7): an accrued line on a paid purchase, an eligible line, a hold and an issued statement. Each row is written by the runtime
 * role that owns it, under its real context, through the adapters themselves, so the fixtures also prove that the policies admit the
 * legitimate writes: the commission service through kauro_commission (the ledger in the agency it adopted; statements without one),
 * the corporate owner through kauro_app (an OPERATOR session: its person bound, no agency) for a hold. Instants are the server's
 * (kauro.server_now()); the labelled TEST CLOCK (D10-CLOCK-1) stands the eligibility transition 720 hours after its FINAL completion.
 * No fixture writes as the superuser. The purchase, its allocation and its entitlement are the caller's (the sales fixtures and the
 * payments fixtures own them).
 */
import type { Client } from "pg";
import {
  composeStatement,
  commissionCutoffHash,
  type CommissionHoldId,
  type CommissionLineId,
  type CommissionPoolId,
  type CommissionStatementId,
  type HoldReason,
  type NewCommissionPool,
  type PurchaseCompletionId,
  type EventId,
  type FundsObservationId,
  type SellerId,
} from "@kauro/domain";
import type { UtcInstant } from "@kauro/contracts";
import { PgCommissionLedgerRepository } from "../repositories/commercial-ledger.js";
import { PgStatementRepository } from "../repositories/commercial-statements.js";
import { clock, ids, sha, type Harness } from "./harness.js";

/** A person's OPERATOR session (the owner's) or the commission service's adopted agency (none for the corporate rows). */
interface Context {
  readonly userId?: string;
  readonly agencyId?: string;
}

async function within<T>(client: Client, ctx: Context, fn: (c: Client) => Promise<T>): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true), set_config('kauro.finance_agency_id', '', true)", [ctx.agencyId ?? "", ctx.userId ?? ""]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** One connection of a runtime role for the duration of a fixture. */
async function asRole<T>(h: Harness, role: "kauro_app_test" | "kauro_commission_test", ctx: Context, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await h.pg.connect(role);
  try {
    return await within(client, ctx, fn);
  } finally {
    await client.end();
  }
}

/** Stands the transaction's TEST CLOCK exactly `seconds` after the FINAL completion of a purchase. */
async function clockAfterFinal(c: Client, authorizationId: string, seconds: number): Promise<void> {
  const r = await c.query(
    "SELECT set_config('kauro_test.clock_offset_seconds', (extract(epoch FROM (x.at - transaction_timestamp())) + $2::numeric)::text, true) FROM (SELECT completed_at AS at FROM kauro.purchase_completions WHERE authorization_id = $1 AND kind = 'FINAL') x",
    [authorizationId, seconds],
  );
  if (r.rowCount !== 1) throw new Error("the FINAL completion of the purchase is not visible to the fixture");
}

/** What a ledger fixture needs of a paid purchase and the attribution it accrues under (one beneficiary at its whole share). */
export interface LedgerLineInput {
  readonly agencyId: string;
  readonly authorizationId: string;
  readonly captureId: string;
  readonly allocationId: string;
  readonly entitlementId: string;
  readonly sellerId: string;
  readonly rateKind: "FIRST" | "REPEAT";
  readonly rateBps: number;
  /** The capture's commission basis at accrual, in integer cents. */
  readonly basisCents: bigint;
  /** round_half_up_bps(basis, rate), stated by the caller as the worked example's integer cents. */
  readonly poolCents: bigint;
  readonly shareBps?: number;
}

export interface RecordedLine {
  readonly poolId: CommissionPoolId;
  readonly lineId: CommissionLineId;
}

/** An ACCRUED_PENDING line on a paid purchase: the ACQUISITION pool and its single beneficiary line, accrued by the commission service. */
export async function recordAccruedLine(h: Harness, input: LedgerLineInput): Promise<RecordedLine> {
  const poolId = ids.next() as CommissionPoolId;
  const lineId = ids.next() as CommissionLineId;
  const pool: NewCommissionPool = {
    poolId,
    purchaseId: input.authorizationId as NewCommissionPool["purchaseId"],
    agencyId: input.agencyId as NewCommissionPool["agencyId"],
    captureId: input.captureId as NewCommissionPool["captureId"],
    source: "ACQUISITION",
    rateKind: input.rateKind,
    allocationId: input.allocationId as NonNullable<NewCommissionPool["allocationId"]>,
    basisCents: input.basisCents,
    rateBps: input.rateBps,
    poolCents: input.poolCents,
    policyVersion: "R2-INITIAL",
    lines: [
      {
        lineId,
        entitlementId: input.entitlementId as NewCommissionPool["lines"][number]["entitlementId"],
        sellerId: input.sellerId as SellerId,
        shareBps: input.shareBps ?? 10000,
        cumulativeEntitlementCents: input.poolCents,
      },
    ],
    createdAt: clock.now(),
  };
  await asRole(h, "kauro_commission_test", { agencyId: input.agencyId }, (c) => new PgCommissionLedgerRepository(c, ids).accrue(pool));
  return { poolId, lineId };
}

/**
 * An ELIGIBLE line: accrued as above, its purchase's FINAL completion recorded (B09's delivered authorization), the capture's funds
 * observed AVAILABLE, and the ELIGIBILITY sweep's transition 720 hours after the completion (the labelled TEST CLOCK stands there).
 */
export async function recordEligibleLine(h: Harness, input: LedgerLineInput): Promise<RecordedLine> {
  const recorded = await recordAccruedLine(h, input);
  await asRole(h, "kauro_commission_test", { agencyId: input.agencyId }, async (c) => {
    const ledger = new PgCommissionLedgerRepository(c, ids);
    const now = clock.now();
    await ledger.recordCompletion({
      completionId: ids.next() as PurchaseCompletionId,
      purchaseId: input.authorizationId as NewCommissionPool["purchaseId"],
      agencyId: input.agencyId as NewCommissionPool["agencyId"],
      kind: "FINAL",
      completedAt: new Date(Date.now() - 60_000).toISOString() as UtcInstant,
      evidenceHash: sha(`completion-${input.authorizationId}`) as never,
      source: "AUTHORIZATION_DELIVERY",
      recordedAt: now,
    });
    await ledger.recordFundsObservation({
      observationId: ids.next() as FundsObservationId,
      agencyId: input.agencyId as NewCommissionPool["agencyId"],
      captureId: input.captureId as NewCommissionPool["captureId"],
      captureVersion: 2,
      fundsState: "AVAILABLE",
      sourceEventId: ids.next() as EventId,
      observedAt: now,
    });
  });
  await asRole(h, "kauro_commission_test", { agencyId: input.agencyId }, async (c) => {
    await clockAfterFinal(c, input.authorizationId, 720 * 3600);
    const ledger = new PgCommissionLedgerRepository(c, ids);
    const line = (await ledger.lockLine(recorded.lineId))!;
    const done = await ledger.transitionLine(recorded.lineId, line.version, { state: "ELIGIBLE" }, clock.now());
    if (done.kind !== "APPLIED") throw new Error("the line did not become ELIGIBLE");
  });
  return recorded;
}

/** An OPEN hold of exactly `amountCents` on a line, opened by the corporate owner with its reason and a review date (default 14 days ahead). */
export async function recordHold(
  h: Harness,
  input: { readonly ownerUserId: string; readonly lineId: string; readonly amountCents: bigint; readonly reason?: HoldReason; readonly reviewInHours?: number },
): Promise<{ readonly holdId: CommissionHoldId; readonly amountCents: bigint; readonly reviewAt: UtcInstant }> {
  const reviewAt = new Date(Date.now() + (input.reviewInHours ?? 14 * 24) * 3_600_000).toISOString() as UtcInstant;
  const holdId = ids.next() as CommissionHoldId;
  const hold = await asRole(h, "kauro_app_test", { userId: input.ownerUserId }, (c) =>
    new PgCommissionLedgerRepository(c, ids).openHold({ holdId, lineId: input.lineId as CommissionLineId, amountCents: input.amountCents, reason: input.reason ?? "SELLER_DISPUTE", reviewAt, openedAt: clock.now() }),
  );
  return { holdId: hold.holdId, amountCents: hold.amountCents, reviewAt: hold.reviewAt };
}

/**
 * An ISSUED statement of one seller in a dated period, as CMD051 writes it for that seller: the ledger read at the cutoff, the statement
 * composed from those rows and issued with its items (DRAFT to ISSUED in one transaction), and each PAYABLE item's line ELIGIBLE to
 * PAYABLE. The period and its calendar are the caller's (a TEST_FIXTURE calendar closes SIMULATED).
 */
export async function recordIssuedStatement(
  h: Harness,
  input: { readonly periodId: string; readonly sellerId: string; readonly cutoffAt: UtcInstant },
): Promise<{ readonly statementId: CommissionStatementId; readonly payableCents: bigint; readonly heldCents: bigint }> {
  return asRole(h, "kauro_commission_test", {}, async (c) => {
    const statements = new PgStatementRepository(c);
    const ledger = new PgCommissionLedgerRepository(c, ids);
    const period = await statements.getPeriod(input.periodId as never);
    if (period === null || period.calendarVersionId === undefined || period.calendarSource === undefined || period.closeDueOn === undefined || period.payDueOn === undefined) {
      throw new Error("the period is not visible or not dated");
    }
    const rows = await statements.periodInputs(period.periodId, input.cutoffAt);
    const seller = input.sellerId as SellerId;
    const composed = composeStatement({ sellerId: seller, periodStartsAt: period.startsAt, cutoffAt: input.cutoffAt, rows });
    const statementId = ids.next() as CommissionStatementId;
    const cutoffHash = commissionCutoffHash({ periodId: period.periodId, cutoffAt: input.cutoffAt, lines: rows.lines, adjustments: rows.adjustments, holds: rows.holds });
    const issued = await statements.issueStatement({
      statement: {
        statementId,
        periodId: period.periodId,
        sellerId: seller,
        periodStart: period.startsAt,
        periodEnd: period.endsAt,
        lineIds: composed.lineIds,
        accruedPendingCents: composed.accruedPendingCents,
        heldCents: composed.heldCents,
        payableCents: composed.payableCents,
        paidToDateCents: composed.paidToDateCents,
        negativeBalanceCents: composed.negativeBalanceCents,
        calendarVersionId: period.calendarVersionId,
        calendarSource: period.calendarSource,
        label: period.calendarSource === "TEST_FIXTURE" ? "SIMULATED" : "VERIFIED_CALENDAR",
        statementDate: period.closeDueOn,
        payDueOn: period.payDueOn,
        cutoffHash,
      },
      items: composed.items.map((item) => ({ ...item, itemId: ids.next() as never, statementId })),
    });
    for (const item of composed.items) {
      if (item.kind !== "LINE" || item.disposition !== "PAYABLE" || item.lineId === undefined) continue;
      const line = (await ledger.lockLine(item.lineId))!;
      const done = await ledger.transitionLine(item.lineId, line.version, { state: "PAYABLE" }, clock.now());
      if (done.kind !== "APPLIED") throw new Error("the line did not become PAYABLE");
    }
    return { statementId: issued.record.statementId, payableCents: issued.record.payableCents, heldCents: issued.record.heldCents };
  });
}
