// The funds fence of the commission ledger (docs/design/B10-failure-matrix.md items 30 and 31; Codex r1 of lane 5, B10G5-R1 and B10G5-R3;
// decision D10-GAP-23): a line that became ELIGIBLE while the capture's funds were AVAILABLE is never paid while the capture's latest funds
// observation is no longer AVAILABLE. No line edge goes back to HELD; the fence is at the close (the statement does not make the line PAYABLE)
// and at the payout (CMD052 refuses a statement whose payable line's funds are not AVAILABLE). The cells run the whole path through the public
// commands, as the worked examples do: the real consumer, the ELIGIBILITY pass, CMD051, CMD052 and CMD053 on a seller with a nonzero line.
// The ELIGIBLE-then-HELD interleaving itself (the sweep committing before the HELD fact) is the ELIG_REV cell `[geligfact]`.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PayoutIntentView, PayoutReconciliationView } from "@kauro/application";
import { faultCell } from "@kauro/persistence/testing";
import { acceptedThrough, agentOf, approvePayout, bankCash, bought, claimed, claimedCents, closedAt, dispatched, integrationWorld, intentOf, madeEligible, oracleRows, reconcilePayout, scriptEvidence, statementReads, statementsOfSeller, type IntegrationWorld } from "./integration-support.js";
import type { Purchase } from "./commission-support.js";
import { bindCells, eventsOf, fundsReport, ledgerOfPurchase, runConsumer, stateOf } from "./b10-cells-support.js";
import { itemsOf } from "./statements-support.js";
import { completed, outcome } from "./support.js";
import { providerReports } from "./integration-support.js";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
  bindCells(iw);
});
after(async () => {
  await iw.stop();
});

/** A seller's nonzero line (one beneficiary, 129,500 x 1000 bps), ELIGIBLE under funds AVAILABLE through the production path. */
async function eligible(label: string): Promise<{ readonly agencyId: string; readonly seller: Awaited<ReturnType<typeof claimed>>["sellers"][number]; readonly purchase: Purchase; readonly lineId: string; readonly cents: string }> {
  const a = await agentOf(iw, label);
  const acquired = await claimed(iw, label);
  await acceptedThrough(iw, a.s.agency.agencyId, acquired, [10_000]);
  const paid = await bought(iw, a, label, { units: 50_000 });
  await dispatched(iw);
  await madeEligible(iw, a.s.agency.agencyId, paid.purchase);
  const ledger = await ledgerOfPurchase(paid.purchase);
  assert.deepEqual([ledger.lines.map(stateOf), ledger.facts.map((f) => f[1]).slice(-1)], [["ELIGIBLE"], ["AVAILABLE"]], `${label}: ELIGIBLE under AVAILABLE funds`);
  assert.ok(BigInt(ledger.lines[0]!.cumulative) > 0n, `${label}: a nonzero line`);
  return { agencyId: a.s.agency.agencyId, seller: acquired.sellers[0]!, purchase: paid.purchase, lineId: ledger.lines[0]!.lineId, cents: ledger.lines[0]!.cumulative };
}
/** The provider holds the capture's proceeds after the line became eligible; COMMISSIONS applies the observation (the ELIGIBLE line is not moved: no edge back to HELD). */
async function heldAfterwards(e: Awaited<ReturnType<typeof eligible>>): Promise<void> {
  await providerReports(iw, e.purchase, { disbursement: "DELAYED" });
  await dispatched(iw);
  const ledger = await ledgerOfPurchase(e.purchase);
  assert.deepEqual([ledger.facts.map((f) => f[1]).slice(-1), ledger.lines.map(stateOf), ledger.lines[0]!.holds], [["HELD"], ["ELIGIBLE"], []], "the capture's latest funds are HELD, the line is still ELIGIBLE with no hold");
}
const available = async (e: Awaited<ReturnType<typeof eligible>>): Promise<void> => {
  await providerReports(iw, e.purchase, { disbursement: "INSTANT" });
  await dispatched(iw);
};

test("DENY (funds fence at the close): an ELIGIBLE line whose capture's latest funds observation became HELD after the ELIGIBILITY pass is itemized AWAITING_FUNDS by CMD051, never PAYABLE (line still ELIGIBLE, nothing payable), and the next close after the funds are AVAILABLE again makes it PAYABLE [gfundsfenceclose]", async () => {
  const e = await eligible("fence-close");
  await heldAfterwards(e);
  await closedAt(iw, "2026-09", "2026-10-07T17:00:00Z");
  const [statement] = await statementsOfSeller(iw, e.seller.sellerId);
  assert.ok(statement !== undefined);
  assert.deepEqual([statement!.payable_cents, statement!.held_cents], ["0", "0"], "nothing payable, nothing withheld by a hold");
  assert.deepEqual((await itemsOf(iw, statement!.statement_id)).filter((i) => i.item_kind === "LINE").map((i) => [i.line_id, i.disposition, i.payable_cents]), [[e.lineId, "AWAITING_FUNDS", "0"]], "the line is itemized AWAITING_FUNDS with nothing payable");
  assert.deepEqual((await ledgerOfPurchase(e.purchase)).lines.map(stateOf), ["ELIGIBLE"], "the line stays ELIGIBLE: no PAYABLE owner");
  const reads = await statementReads(iw, statement!.statement_id, e.seller.person.token);
  assert.deepEqual(reads.owner, reads.seller);
  assert.equal(reads.seller.payableCents, "0");

  await available(e);
  await closedAt(iw, "2026-08", "2026-10-07T17:00:00Z");
  const statements = await statementsOfSeller(iw, e.seller.sellerId);
  const later = statements.find((s) => s.statement_id !== statement!.statement_id);
  assert.ok(later !== undefined);
  assert.deepEqual([later!.payable_cents, (await ledgerOfPurchase(e.purchase)).lines.map(stateOf)], [e.cents, ["PAYABLE"]], "funds AVAILABLE again: the next close makes it PAYABLE");
});

test("DENY (funds fence at the payout): a statement closed with the line PAYABLE under funds AVAILABLE, the capture's funds then HELD before CMD052: the approval is 409 STALE_VERSION LEDGER_CHANGED, no intent, the statement ISSUED; once the funds are AVAILABLE the same approval pays it [gfundsfencepay]", async () => {
  const e = await eligible("fence-pay");
  await closedAt(iw, "2026-07", "2026-10-07T17:00:00Z");
  const [statement] = await statementsOfSeller(iw, e.seller.sellerId);
  assert.deepEqual([statement!.payable_cents, statement!.state], [e.cents, "ISSUED"]);
  assert.deepEqual((await ledgerOfPurchase(e.purchase)).lines.map(stateOf), ["PAYABLE"]);
  await heldAfterwardsPayable(e);
  await bankCash(iw, (await claimedCents(iw)) + BigInt(e.cents));
  const body = { expectedVersion: Number(statement!.version), payeeRef: e.seller.destinationId, authorizationRef: await iw.w.stepUp(iw.owner) };
  assert.equal(outcome(iw.w, await approvePayout(iw, statement!.statement_id, body)), "409 STALE_VERSION LEDGER_CHANGED", "held funds are never authorized");
  assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS n FROM kauro.payout_intents WHERE statement_id = $1", [statement!.statement_id]), [{ n: 0 }], "no intent");
  assert.deepEqual((await statementsOfSeller(iw, e.seller.sellerId))[0]!.state, "ISSUED");
  assert.deepEqual((await ledgerOfPurchase(e.purchase)).lines.map(stateOf), ["PAYABLE"], "the line is still PAYABLE");

  await available(e);
  const again = { ...body, authorizationRef: await iw.w.stepUp(iw.owner) };
  const approved = completed<PayoutIntentView>(await approvePayout(iw, statement!.statement_id, again), 200);
  assert.deepEqual([approved.data.state, approved.data.amountCents], ["AUTHORIZED", e.cents], "funds AVAILABLE again: the payout is authorized");
});
/** The funds turn HELD while the line is PAYABLE: the consumer records the fact and leaves the line. */
async function heldAfterwardsPayable(e: Awaited<ReturnType<typeof eligible>>): Promise<void> {
  await providerReports(iw, e.purchase, { disbursement: "DELAYED" });
  await dispatched(iw);
  const ledger = await ledgerOfPurchase(e.purchase);
  assert.deepEqual([ledger.facts.map((f) => f[1]).slice(-1), ledger.lines.map(stateOf)], [["HELD"], ["PAYABLE"]]);
}

// =====================================================================================================================================
// B10G5-R3: FUNDS_RETRY on a PAID line
// =====================================================================================================================================

faultCell(
  {
    id: "FUNDS_RETRY",
    step: "COMMISSIONS consumer capture.funds_observed.v1 HELD (F3: the affected lines' HELD transition) on a PAID line: a late HELD observation of a capture whose nonzero line was paid through CMD051, CMD052 and a settled CMD053, delivered twice",
    fault: "retry",
    expect:
      "DENY: a late HELD observation delivered twice leaves the PAID line as it was (state PAID, version, paid cents = the line, cumulative, no hold), the payout intent SETTLED and the statement PAID unchanged; the observation is recorded once (APPLIED, then DUPLICATE)",
  },
  async (ctx) => {
    const e = await eligible("fence-paid");
    await closedAt(iw, "2026-06", "2026-10-07T17:00:00Z");
    const [statement] = await statementsOfSeller(iw, e.seller.sellerId);
    await bankCash(iw, (await claimedCents(iw)) + BigInt(e.cents));
    completed<PayoutIntentView>(await approvePayout(iw, statement!.statement_id, { expectedVersion: Number(statement!.version), payeeRef: e.seller.destinationId, authorizationRef: await iw.w.stepUp(iw.owner) }), 200);
    const intent = await intentOf(iw, statement!.statement_id);
    const evidence = iw.payouts.matching({ reference: intent.reference, destinationDigest: intent.destinationDigest, amountCents: intent.amount, currency: intent.currency }, "SETTLED");
    const settled = completed<PayoutReconciliationView>(await reconcilePayout(iw, statement!.statement_id, { providerPayoutEvidenceRef: scriptEvidence(iw, evidence) }), 200);
    assert.deepEqual([settled.data.intentState, settled.data.statementState, settled.data.linesPaid], ["SETTLED", "PAID", 1]);

    // the provider holds the proceeds afterwards: the observation is reported, not yet delivered to COMMISSIONS (the dispatcher would deliver it)
    const late = await fundsReport(e.purchase, "DELAYED");
    const paidState = async () => ({
      ledger: await ledgerOfPurchase(e.purchase),
      line: await oracleRows(iw, "SELECT state, version::text, paid_cents::text, cumulative_entitlement_cents::text AS cumulative, payable_statement_id FROM kauro.commission_lines WHERE line_id = $1", [e.lineId]),
      intents: await oracleRows(iw, "SELECT intent_id, state, amount_cents::text, version::text FROM kauro.payout_intents WHERE statement_id = $1 ORDER BY intent_id", [statement!.statement_id]),
      statement: (await statementsOfSeller(iw, e.seller.sellerId)).map((s) => [s.statement_id, s.state, s.version, s.payable_cents, s.paid_to_date_cents]),
    });
    const before = await paidState();
    assert.deepEqual(before.ledger.lines.map((l) => [l.state, l.holds.length]), [["PAID", 0]]);
    assert.deepEqual(before.line.map((l) => [l["state"], l["paid_cents"]]), [["PAID", e.cents]]);
    const snapshots: Array<Awaited<ReturnType<typeof paidState>>> = [];
    const answers = await ctx.sequentially(2, async () => {
      const out = await runConsumer(late);
      snapshots.push(await paidState());
      return out;
    });
    assert.deepEqual(answers.map((r) => (r.status === "fulfilled" ? r.value : r.reason)), ["APPLIED", "DUPLICATE"]);
    assert.deepEqual(snapshots[0]!.ledger.facts.map((f) => f[1]).slice(-1), ["HELD"], "the late observation is recorded once");
    assert.equal(snapshots[0]!.ledger.facts.length, before.ledger.facts.length + 1);
    for (const [i, s] of snapshots.entries()) {
      assert.deepEqual([s.line, s.intents, s.statement], [before.line, before.intents, before.statement], `delivery ${i + 1}: the PAID line, its payout and its statement are unchanged`);
      assert.deepEqual(s.ledger.lines, before.ledger.lines, `delivery ${i + 1}: no hold, version unchanged`);
    }
    assert.equal((await eventsOf(e.purchase.captureId, "capture.funds_observed.v1")).length >= 2, true);
  },
);
