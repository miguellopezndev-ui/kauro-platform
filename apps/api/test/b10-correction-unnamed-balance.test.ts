// The correction recomposes over the predecessor's own input set (Codex r4 B10G-R9, decision D10-GAP-16): a negative balance a statement
// carries for a debt line none of its items names (SIGNED_FUTURE_OFFSET terms suppress the RECOVERY item, the refund's adjustment was
// reported by an earlier statement, no OFFSET recorded) stays with its successor, whether the statement is corrected directly (CMD051) or
// superseded in CMD053's COMMIT after its payout FAILED or RETURNED (D10-GAP-12). Its own world: three sellers go through the same three
// closes. PostgreSQL 17 through the runtime login roles; the superuser only reads.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PayoutIntentView, PayoutReconciliationView, PeriodCloseView, StatementCorrectionView } from "@kauro/application";
import { approvePayout, bankCash, claimedCents, closeMonth, commissionContext, correctStatement, StandingUnits, eligibleLines, intentOf, itemsOf, ledgerOf, reconcilePayout, rows, scriptEvidence, seller, statementsOfSeller, statementsWorld, type StatementsWorld } from "./statements-support.js";
import { completed } from "./support.js";

let sw: StatementsWorld;
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
const PAYABLE = 5_000n;
const successorsOf = (statementId: string) => rows<{ statement_id: string; state: string; payable_cents: string; negative_balance_cents: string }>(sw, "SELECT statement_id, state, payable_cents::text, negative_balance_cents::text FROM kauro.commission_statements WHERE corrects_statement_id = $1", [statementId]);
const lineState = async (lineId: string): Promise<string> => (await rows<{ state: string }>(sw, "SELECT state FROM kauro.commission_lines WHERE line_id = $1", [lineId]))[0]!.state;
const liveReports = async (adjustmentId: string): Promise<number> =>
  Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id WHERE i.adjustment_id = $1 AND i.item_kind = 'ADJUSTMENT' AND s.state <> 'CORRECTED'", [adjustmentId]))[0]!.n);

/** A refund of a PAID line as the commission consumer applies it (D10-ADJ-1): one DECREASE adjustment, the line PAID to ADJUSTED. */
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

const settle = async (statementId: string, version: string, destinationId: string, status: "SETTLED" | "FAILED" | "RETURNED"): Promise<PayoutReconciliationView> => {
  await bankCash(sw, (await claimedCents(sw)) + PAYABLE);
  completed<PayoutIntentView>(await approvePayout(sw, statementId, { expectedVersion: Number(version), payeeRef: destinationId, authorizationRef: await sw.w.stepUp(sw.owner) }), 200);
  const i = await intentOf(sw, statementId);
  return completed<PayoutReconciliationView>(await reconcilePayout(sw, statementId, { providerPayoutEvidenceRef: scriptEvidence(sw, sw.payouts.matching({ reference: i.reference, destinationDigest: i.destinationDigest, amountCents: i.amount, currency: i.currency }, status)) }), 200).data;
};

test("CORR_DUP [deny] a statement whose negative balance comes from a debt line none of its items names (signed offset terms, adjustment reported earlier) corrected directly, or superseded after its payout FAILED or RETURNED -> DENY: the successor keeps negative_balance_cents, M stays its one payable or held item, the adjustment is reported once", async () => {
  const ways = ["DIRECT", "FAILED", "RETURNED"] as const;
  const cases = [];
  for (const way of ways) {
    const s = await seller(sw, `corr-unnamed-${way.toLowerCase()}`, { ...WHOLE, offsetTerms: "SIGNED_FUTURE_OFFSET" });
    const paid = await eligibleLines(sw, `corr unnamed ${way} paid`, s, WHOLE, [{ basisCents: PAYABLE, poolCents: PAYABLE }]);
    cases.push({ way, s, lineL: paid.lines[0]!.lineId });
  }
  // S0: L paid 5,000 cents through its own statement
  const first = await closeMonth(sw, "2026-01");
  completed<PeriodCloseView>(first.reply, 200);
  for (const c of cases) {
    const s0 = (await statementsOfSeller(sw, c.s.sellerId)).find((x) => x.period_id === first.periodId)!;
    await settle(s0.statement_id, s0.version, c.s.destinationId, "SETTLED");
    assert.equal(await lineState(c.lineL), "PAID");
  }
  // L refunded to 3,000: 2,000 cents owed back under signed offset terms; B reports the adjustment (no RECOVERY item) with the balance
  const adjustments = new Map<string, string>();
  for (const c of cases) adjustments.set(c.way, await refundPaidLine(c.lineL, 3_000n));
  const second = await closeMonth(sw, "2026-02");
  completed<PeriodCloseView>(second.reply, 200);
  for (const c of cases) {
    const b = (await statementsOfSeller(sw, c.s.sellerId)).find((x) => x.period_id === second.periodId)!;
    assert.deepEqual((await itemsOf(sw, b.statement_id)).map((i) => [i.item_kind, i.line_id, i.adjustment_id]), [["ADJUSTMENT", c.lineL, adjustments.get(c.way)]]);
    assert.equal(b.negative_balance_cents, "2000");
  }
  // M earned; A itemizes only M's PAYABLE LINE and still carries L's 2,000-cent debt
  const ms = new Map<string, string>();
  for (const c of cases) ms.set(c.way, (await eligibleLines(sw, `corr unnamed ${c.way} earned`, c.s, WHOLE, [{ basisCents: PAYABLE, poolCents: PAYABLE }])).lines[0]!.lineId);
  const third = await closeMonth(sw, "2026-03");
  completed<PeriodCloseView>(third.reply, 200);
  for (const c of cases) {
    const lineM = ms.get(c.way)!;
    const a = (await statementsOfSeller(sw, c.s.sellerId)).find((x) => x.period_id === third.periodId)!;
    assert.deepEqual((await itemsOf(sw, a.statement_id)).map((i) => [i.item_kind, i.disposition, i.line_id]), [["LINE", "PAYABLE", lineM]]);
    assert.deepEqual([a.payable_cents, a.negative_balance_cents], [String(PAYABLE), "2000"]);
    if (c.way === "DIRECT") {
      const done = await correctStatement(sw, a.statement_id, { expectedVersion: Number(a.version) });
      assert.equal(done.kind, "COMPLETED", JSON.stringify(done, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)));
      assert.equal((done as { readonly view: StatementCorrectionView }).view.correctedStatementId, a.statement_id);
    } else {
      assert.equal((await settle(a.statement_id, a.version, c.s.destinationId, c.way)).statementState, "CORRECTED");
    }
    const [succ] = await successorsOf(a.statement_id);
    assert.equal(succ!.state, "ISSUED");
    assert.equal(succ!.negative_balance_cents, "2000", `${c.way}: L's debt is still reported by the successor`);
    const items = await itemsOf(sw, succ!.statement_id);
    assert.deepEqual(items.map((i) => [i.item_kind, i.disposition, i.line_id]), [["LINE", c.way === "DIRECT" ? "PAYABLE" : "HELD", lineM]], `${c.way}: L is never itemized, M is the one item`);
    assert.equal(succ!.payable_cents, c.way === "DIRECT" ? String(PAYABLE) : "0");
    assert.deepEqual([await lineState(c.lineL), await lineState(lineM)], ["ADJUSTED", c.way === "DIRECT" ? "PAYABLE" : "HELD"]);
    assert.equal(await liveReports(adjustments.get(c.way)!), 1, `${c.way}: B alone reports the adjustment`);
  }
});
