// The correction's inclusion set over every item of the predecessor (Codex r3 B10G-R9, decision D10-GAP-15): a statement that reports a
// refunded paid line (its adjustment, its recovery item and the negative balance) beside a payable line, its payout FAILED or RETURNED and
// superseded automatically in CMD053's COMMIT (D10-GAP-12). Its own world: the months of 2026 the fixtures close are few (January to
// September), and this file closes three per payout outcome. PostgreSQL 17 through the runtime login roles; the superuser only reads.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PayoutIntentView, PayoutReconciliationView, PeriodCloseView } from "@kauro/application";
import { approvePayout, bankCash, claimedCents, closeMonth, commissionContext, StandingUnits, eligibleLines, intentOf, itemsOf, ledgerOf, reconcilePayout, rows, scriptEvidence, seller, statementsOfSeller, statementsWorld, type StatementsWorld } from "./statements-support.js";
import { completed } from "./support.js";

let sw: StatementsWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => sw.h.oracle);
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
const PAYABLE = 5_000n;
let month = 0;
const nextMonth = (): string => `2026-${String(++month).padStart(2, "0")}`;
const successorsOf = (statementId: string) => rows<{ statement_id: string; state: string; payable_cents: string }>(sw, "SELECT statement_id, state, payable_cents::text FROM kauro.commission_statements WHERE corrects_statement_id = $1", [statementId]);
const lineState = async (lineId: string): Promise<string> => (await rows<{ state: string }>(sw, "SELECT state FROM kauro.commission_lines WHERE line_id = $1", [lineId]))[0]!.state;

// --- a statement reporting a refunded paid line beside a payable one, its payout FAILED or RETURNED (Codex r3 B10G-R9, D10-GAP-15) ---

/**
 * A refund of a PAID line as the commission consumer applies it (D10-ADJ-1, ledger-effects applyBasisChange): the pool and line at the
 * new basis, one DECREASE adjustment of the cumulative difference, the line PAID to ADJUSTED with what was paid untouched.
 */
async function refundPaidLine(lineId: string, newCents: bigint): Promise<string> {
  const [l] = await rows<{ pool_id: string; cumulative: string; agreement_version: string }>(
    sw,
    `SELECT l.pool_id, l.cumulative_entitlement_cents::text AS cumulative, e.agreement_version FROM kauro.commission_lines l JOIN kauro.commission_entitlements e ON e.entitlement_id = l.entitlement_id WHERE l.line_id = $1`,
    [lineId],
  );
  let adjustmentId = "";
  await new StandingUnits(sw.pools.pools, () => null).run(commissionContext(), async (uow) => {
    const ledger = ledgerOf(uow);
    const now = `${(await uow.serverInstant()).slice(0, 23)}Z` as never;
    adjustmentId = uow.ids.next();
    const written = await ledger.applyBasisChange(l!.pool_id as never, newCents, newCents, [
      { adjustmentId: adjustmentId as never, commissionLineId: lineId as never, reason: "REFUND", signedCents: newCents - BigInt(l!.cumulative), newCumulativeEntitlementCents: newCents, sourceEventId: uow.ids.next() as never, agreementVersion: l!.agreement_version, createdAt: now },
    ]);
    assert.equal(written.applied, true);
    const line = (await ledger.lockLine(lineId as never))!;
    assert.equal((await ledger.transitionLine(line.lineId, line.version, { state: "ADJUSTED" } as never, now)).kind, "APPLIED");
  });
  return adjustmentId;
}

/** The ADJUSTMENT items reporting `adjustmentId` in live (not CORRECTED) statements: an adjustment is reported by exactly one. */
const liveReports = async (adjustmentId: string): Promise<number> =>
  Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id WHERE i.adjustment_id = $1 AND i.item_kind = 'ADJUSTMENT' AND s.state <> 'CORRECTED'", [adjustmentId]))[0]!.n);

for (const status of ["FAILED", "RETURNED"] as const) {
  test(`CORR_DUP [deny] a statement reporting a refunded paid line's adjustment and recovery beside a payable line, its payout ${status} -> DENY: the automatic successor carries the adjustment, the recovery item and the negative balance with the payable line HELD, and a later close neither reports the adjustment again nor loses it`, async () => {
    const s = await seller(sw, `corr-recovery-${status.toLowerCase()}`, WHOLE);
    const paid = await eligibleLines(sw, `corr recovery ${status} paid`, s, WHOLE, [{ basisCents: PAYABLE, poolCents: PAYABLE }]);
    const lineL = paid.lines[0]!.lineId;
    // L is paid in full through its own statement
    const first = await closeMonth(sw, nextMonth());
    completed<PeriodCloseView>(first.reply, 200);
    const s0 = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === first.periodId)!;
    await bankCash(sw, (await claimedCents(sw)) + PAYABLE);
    completed<PayoutIntentView>(await approvePayout(sw, s0.statement_id, { expectedVersion: Number(s0.version), payeeRef: s.destinationId, authorizationRef: await sw.w.stepUp(sw.owner) }), 200);
    const i0 = await intentOf(sw, s0.statement_id);
    completed<PayoutReconciliationView>(await reconcilePayout(sw, s0.statement_id, { providerPayoutEvidenceRef: scriptEvidence(sw, sw.payouts.matching({ reference: i0.reference, destinationDigest: i0.destinationDigest, amountCents: i0.amount, currency: i0.currency }, "SETTLED")) }), 200);
    assert.equal(await lineState(lineL), "PAID");
    // refunded below what was paid: L ADJUSTED, 2,000 cents owed back with no signed offset terms; and M earned
    const adjustmentId = await refundPaidLine(lineL, 3_000n);
    const earned = await eligibleLines(sw, `corr recovery ${status} earned`, s, WHOLE, [{ basisCents: PAYABLE, poolCents: PAYABLE }]);
    const lineM = earned.lines[0]!.lineId;
    // statement A: L's ADJUSTMENT and RECOVERY, M's PAYABLE LINE, a 2,000-cent negative balance
    const second = await closeMonth(sw, nextMonth());
    completed<PeriodCloseView>(second.reply, 200);
    const a = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === second.periodId)!;
    const shape = async (statementId: string) => (await itemsOf(sw, statementId)).map((i) => [i.item_kind, i.disposition, i.line_id, i.adjustment_id]);
    assert.deepEqual(new Set(await shape(a.statement_id)), new Set([["ADJUSTMENT", "REPORTED", lineL, adjustmentId], ["RECOVERY", "REPAYMENT_REVIEW", lineL, null], ["LINE", "PAYABLE", lineM, null]]));
    assert.deepEqual([a.payable_cents, a.negative_balance_cents], [String(PAYABLE), "2000"]);
    // A approved and its payout FAILED or RETURNED: superseded in the reconciliation's COMMIT (D10-GAP-12)
    await bankCash(sw, (await claimedCents(sw)) + PAYABLE);
    completed<PayoutIntentView>(await approvePayout(sw, a.statement_id, { expectedVersion: Number(a.version), payeeRef: s.destinationId, authorizationRef: await sw.w.stepUp(sw.owner) }), 200);
    const ia = await intentOf(sw, a.statement_id);
    const done = completed<PayoutReconciliationView>(await reconcilePayout(sw, a.statement_id, { providerPayoutEvidenceRef: scriptEvidence(sw, sw.payouts.matching({ reference: ia.reference, destinationDigest: ia.destinationDigest, amountCents: ia.amount, currency: ia.currency }, status)) }), 200);
    assert.equal(done.data.statementState, "CORRECTED");
    const [succ] = await successorsOf(a.statement_id);
    assert.deepEqual([succ!.state, succ!.payable_cents], ["ISSUED", "0"]);
    // the successor carries L's adjustment and recovery and the negative balance; M is HELD under PAYOUT_FAILED
    assert.deepEqual(new Set(await shape(succ!.statement_id)), new Set([["ADJUSTMENT", "REPORTED", lineL, adjustmentId], ["RECOVERY", "REPAYMENT_REVIEW", lineL, null], ["LINE", "HELD", lineM, null]]));
    const succRow = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.statement_id === succ!.statement_id)!;
    assert.equal(succRow.negative_balance_cents, "2000", "L's debt is still reported");
    assert.deepEqual([await lineState(lineL), await lineState(lineM)], ["ADJUSTED", "HELD"]);
    assert.equal(await liveReports(adjustmentId), 1, "the adjustment is reported by the successor, and only by it");
    // a later close neither reports the adjustment a second time nor loses it
    const third = await closeMonth(sw, nextMonth());
    completed<PeriodCloseView>(third.reply, 200);
    const later = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === third.periodId);
    if (later !== undefined) assert.ok(!(await itemsOf(sw, later.statement_id)).some((i) => i.adjustment_id === adjustmentId), "the later statement does not report the adjustment again");
    assert.equal(await liveReports(adjustmentId), 1, "the adjustment is still reported exactly once");
  });
}
