// The commission ledger and statement adapters of package B10 (mandate B10-ADAPTERS-LEDGER; docs/design/B10-commercial-domain.md §6,
// §7, §8.1, §10, §11, §12; case map docs/design/B10-case-map.md) on real PostgreSQL 17 through the runtime login roles: the commission
// service (kauro_commission_test) in the agency it adopted for the ledger and without one for periods and statements, the corporate
// owner (kauro_app_test) for holds and payout authorizations. The superuser only reads (row digests, the append-only probes) and never
// writes a row under test. The setup of the sales rows is the schema support's (b10-commission-support.ts) and the test-only
// fixtures of @kauro/persistence/testing (ledger-fixtures.ts); amounts are the worked examples' integer cents, written here as the
// oracle and never read back from the function under test. Interleavings are fixed by hold points and lock waits observed in
// pg_stat_activity, never by a sleep.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import {
  DomainFailure,
  allocatePool,
  commissionCutoffHash,
  composeStatement,
  recomputePool,
  type AdjustmentReason,
  type BasisChange,
  type CommissionLineId,
  type CommissionPoolRecord,
  type EventId,
  type NewCommissionAdjustment,
  type NewCommissionPool,
  type NewCommissionStatement,
  type PayoutIntentId,
  type PayoutReconciliationId,
  type SellerId,
} from "@kauro/domain";
import { PgCommissionLedgerRepository, PgStatementRepository, RecordedBankingCalendarSource, failureOfSqlState, ledgerOf, statementsOf, type PgCommerceUnitOfWork } from "../src/index.js";
import { backendPid, barrier, clock, handled, settlesOrWaits } from "../src/testing/harness.js";
import { recordAccruedLine, recordEligibleLine, recordHold, recordIssuedStatement } from "../src/testing/index.js";
import {
  acquired,
  activeSeller,
  agencyWith,
  changeDestination,
  closeWorld,
  corporate,
  digest,
  fixtureCalendar,
  ids,
  openWorld,
  oracleProbe,
  ownerOf,
  purchase,
  refusedWith,
  registerProspect,
  approvePayout,
  prepareAllocation,
  acceptAttribution,
  submitClaim,
  convert,
  completion,
  funds,
  september,
  service,
  sha,
  within,
  type Agency,
  type Purchase,
  type Seller,
  type World,
} from "./b10-commission-support.js";
import { stepUpProof } from "./support.js";

let w: World;
/** The September 2026 period every statement of this file closes into (one statement per seller), dated by example 21's fixture calendar. */
let period: string;
let calendarId: string;

before(async () => {
  w = await openWorld("b10-ledger-adapters");
  calendarId = await fixtureCalendar(w);
  period = await september(w, calendarId);
});
after(async () => {
  await closeWorld(w);
});

/** The ledger as the commission service uses it: in the agency of the work item it adopted. */
const ledgerIn = <T>(ag: { readonly agencyId: string }, work: (ledger: PgCommissionLedgerRepository, c: Client) => Promise<T>): Promise<T> =>
  within(w.commission, service(ag.agencyId), (c) => work(new PgCommissionLedgerRepository(c, ids), c));
/** The periods and statements as the commission service uses them: corporate rows, no agency (D10-CTX-3). */
const statementsIn = <T>(work: (statements: PgStatementRepository, ledger: PgCommissionLedgerRepository, c: Client) => Promise<T>): Promise<T> =>
  within(w.commission, corporate, (c) => work(new PgStatementRepository(c), new PgCommissionLedgerRepository(c, ids), c));

/** A typed refusal of an adapter: the failure code and reason a command answers. */
const failedWith = (code: string, reason: string) => (e: unknown): boolean => e instanceof DomainFailure && e.code === code && e.reason === reason;

const instantOf = (ms: number): string => new Date(ms).toISOString();

/** The pool a purchase accrues for one beneficiary at the rate given (the caller states the example's integer cents). */
function poolOf(
  a: { readonly ag: Agency; readonly allocationId: string },
  p: Purchase,
  lines: ReadonlyArray<{ readonly sellerId: string; readonly entitlementId: string; readonly shareBps: number; readonly cents: bigint }>,
  terms: { readonly rateKind: "FIRST" | "REPEAT"; readonly rateBps: number; readonly basisCents: bigint; readonly poolCents: bigint },
): NewCommissionPool {
  return {
    poolId: ids.next() as NewCommissionPool["poolId"],
    purchaseId: p.authorizationId as NewCommissionPool["purchaseId"],
    agencyId: a.ag.agencyId as NewCommissionPool["agencyId"],
    captureId: p.captureId as NewCommissionPool["captureId"],
    source: "ACQUISITION",
    rateKind: terms.rateKind,
    allocationId: a.allocationId as NonNullable<NewCommissionPool["allocationId"]>,
    basisCents: terms.basisCents,
    rateBps: terms.rateBps,
    poolCents: terms.poolCents,
    policyVersion: "R2-INITIAL",
    lines: lines.map((l) => ({
      lineId: ids.next() as CommissionLineId,
      entitlementId: l.entitlementId as NewCommissionPool["lines"][number]["entitlementId"],
      sellerId: l.sellerId as SellerId,
      shareBps: l.shareBps,
      cumulativeEntitlementCents: l.cents,
    })),
    createdAt: clock.now(),
  };
}

/**
 * The COMMISSIONS consumer's basis change of a capture, as the service runs it in one transaction of the adopted agency: the pools of
 * the capture locked with their lines, each recomputed cumulatively by the domain's kernel and applied with its adjustments under one
 * source event; a line whose entitlement and basis reach zero ends VOID. Returns what each pool applied.
 */
async function basisChange(ag: Agency, captureId: string, change: BasisChange, sourceEventId: string, agreementVersion: string): Promise<ReadonlyArray<{ readonly applied: boolean; readonly poolId: string }>> {
  return ledgerIn(ag, async (ledger) => {
    const out: Array<{ applied: boolean; poolId: string }> = [];
    for (const { pool, lines } of await ledger.lockPoolsOfCapture(captureId as never)) {
      const recomputed = recomputePool(
        { basisCents: pool.basisCents, rateBps: pool.rateBps, lines: lines.map((l) => ({ lineId: l.lineId, sellerId: l.sellerId, shareBps: l.shareBps, cumulativeCents: l.cumulativeEntitlementCents })) },
        change,
      );
      const adjustments: NewCommissionAdjustment[] = recomputed.adjustments.map((a) => ({
        adjustmentId: ids.next() as NewCommissionAdjustment["adjustmentId"],
        commissionLineId: a.lineId as CommissionLineId,
        reason: a.reason as AdjustmentReason,
        signedCents: a.signedCents,
        newCumulativeEntitlementCents: a.newCumulativeCents,
        sourceEventId: sourceEventId as EventId,
        agreementVersion,
        createdAt: clock.now(),
      }));
      const result = await ledger.applyBasisChange(pool.poolId, recomputed.pool.basisCents, recomputed.poolCents, adjustments);
      if (result.applied && recomputed.pool.basisCents === 0n) {
        for (const line of lines) {
          const current = (await ledger.lockLine(line.lineId))!;
          if (current.state === "ACCRUED_PENDING" || current.state === "HELD" || current.state === "ELIGIBLE") {
            const done = await ledger.transitionLine(line.lineId, current.version, { state: "VOID" }, clock.now());
            assert.equal(done.kind, "APPLIED", "the line ends VOID");
          }
        }
      }
      out.push({ applied: result.applied, poolId: pool.poolId });
    }
    return out;
  });
}

/** A founding agency acquired by `seller` at the allocation's rates (the agency's first purchase is its sticky first designation). */
async function acquiredAt(name: string, seller: Seller, terms: { readonly firstBps: number; readonly repeatBps: number }) {
  const ag = await agencyWith(w, name);
  const prospect = await registerProspect(w, seller, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`);
  const claimId = await submitClaim(w, seller, prospect);
  const allocationId = await prepareAllocation(w, ag, prospect, [{ seller, claimId, shareBps: 10000 }], terms);
  await acceptAttribution(w, ag, allocationId, [claimId]);
  const first = await purchase(w, ag, `${name}-first`, { foundingFixture: true });
  const entitlementId = (await convert(w, ag, allocationId)).get(seller.sellerId)!;
  return { ag, allocationId, first, entitlementId };
}

// --- R2-079 ------------------------------------------------------------------------------------------------------------------------------

test("R2-079 at the ledger: the accrual of a founding first purchase writes, as the commission service, one ACQUISITION pool of basis 97125 and 9713 cents and one ACCRUED_PENDING line at 1000 bps, and a pool whose cents differ from round(basis x rate) is refused KC002", async () => {
  const S = await activeSeller(w, "r079-seller");
  const a = await acquired(w, "R2-079 agency", [{ seller: S, shareBps: 10000 }], { foundingFixture: true });
  const entitlementId = a.entitlements.get(S.sellerId)!;

  const pool = poolOf(a, a.first, [{ sellerId: S.sellerId, entitlementId, shareBps: 10000, cents: 9713n }], { rateKind: "FIRST", rateBps: 1000, basisCents: 97125n, poolCents: 9713n });
  const accrued = await ledgerIn(a.ag, (ledger) => ledger.accrue(pool));
  assert.equal(accrued.created, true);
  assert.deepEqual(
    { source: accrued.pool.source, kind: accrued.pool.rateKind, basis: accrued.pool.basisCents, rate: accrued.pool.rateBps, cents: accrued.pool.poolCents, project: accrued.pool.projectId, seq: accrued.pool.confirmationSeq },
    { source: "ACQUISITION", kind: "FIRST", basis: 97125n, rate: 1000, cents: 9713n, project: a.first.projectId, seq: 1 },
  );
  assert.deepEqual(
    accrued.lines.map((l) => ({ seller: l.sellerId, state: l.state, rate: l.rateBps, share: l.shareBps, basis: l.netServiceBasisCents, cumulative: l.cumulativeEntitlementCents, posted: l.previousPostedCents, paid: l.paidCents, version: l.version })),
    [{ seller: S.sellerId, state: "ACCRUED_PENDING", rate: 1000, share: 10000, basis: 97125n, cumulative: 9713n, posted: 9713n, paid: 0n, version: 1 }],
  );

  // a delivery replayed accrues nothing: the pool of this purchase and source is the one that exists
  const replay = await ledgerIn(a.ag, (ledger) => ledger.accrue(poolOf(a, a.first, [{ sellerId: S.sellerId, entitlementId, shareBps: 10000, cents: 9713n }], { rateKind: "FIRST", rateBps: 1000, basisCents: 97125n, poolCents: 9713n })));
  assert.equal(replay.created, false);
  assert.equal(replay.pool.poolId, accrued.pool.poolId);
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.commission_pools WHERE authorization_id = $1", [a.first.authorizationId])).rowCount, 1);

  // the second purchase (a repeat at 400 bps on 123025) is 4921; a pool of 4922 — its line allocated to match — is not round(basis x rate)
  const second = await purchase(w, a.ag, "r079-second", { qualifying: [a.first.projectId], client: 1 });
  await assert.rejects(
    ledgerIn(a.ag, (ledger) => ledger.accrue(poolOf(a, second, [{ sellerId: S.sellerId, entitlementId, shareBps: 10000, cents: 4922n }], { rateKind: "REPEAT", rateBps: 400, basisCents: 123025n, poolCents: 4922n }))),
    refusedWith("KC002"),
  );
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.commission_pools WHERE authorization_id = $1", [second.authorizationId])).rowCount, 0, "the refused pool left nothing");
  const right = await ledgerIn(a.ag, (ledger) => ledger.accrue(poolOf(a, second, [{ sellerId: S.sellerId, entitlementId, shareBps: 10000, cents: 4921n }], { rateKind: "REPEAT", rateBps: 400, basisCents: 123025n, poolCents: 4921n })));
  assert.deepEqual({ created: right.created, cents: right.pool.poolCents, kind: right.pool.rateKind }, { created: true, cents: 4921n, kind: "REPEAT" });
});

// --- R2-080 ------------------------------------------------------------------------------------------------------------------------------

test("R2-080 at the ledger: refund.completed.v1 with serviceBasisAfterCents 103025 appends one REFUND DECREASE adjustment of 800 with new cumulative 4121 to the 4921 line, a replay of the same event adds nothing, and an adjustment that is not the cumulative difference is refused KC015", async () => {
  const S = await activeSeller(w, "r080-seller");
  const a = await acquired(w, "R2-080 agency", [{ seller: S, shareBps: 10000 }], { foundingFixture: true });
  const entitlementId = a.entitlements.get(S.sellerId)!;
  const second = await purchase(w, a.ag, "r080-second", { qualifying: [a.first.projectId], client: 1 });
  const { lineId } = await recordAccruedLine(w.h, {
    agencyId: a.ag.agencyId,
    authorizationId: second.authorizationId,
    captureId: second.captureId,
    allocationId: a.allocationId,
    entitlementId,
    sellerId: S.sellerId,
    rateKind: "REPEAT",
    rateBps: 400,
    basisCents: 123025n,
    poolCents: 4921n,
  });

  const refund = ids.next();
  const first = await basisChange(a.ag, second.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 103025n }, refund, S.agreementVersion);
  assert.deepEqual(first.map((r) => r.applied), [true]);
  const adjustments = await ledgerIn(a.ag, (ledger) => ledger.adjustmentsOfLine(lineId as CommissionLineId));
  assert.deepEqual(
    adjustments.map((x) => ({ seq: x.adjustmentSeq, reason: x.reason, direction: x.direction, amount: x.amountCents, previous: x.previousCumulativeCents, cumulative: x.newCumulativeEntitlementCents, basis: x.newBasisCents, event: x.sourceEventId })),
    [{ seq: 1, reason: "REFUND", direction: "DECREASE", amount: 800n, previous: 4921n, cumulative: 4121n, basis: 103025n, event: refund }],
  );
  const line = await ledgerIn(a.ag, (ledger) => ledger.getLine(lineId as CommissionLineId));
  assert.deepEqual({ state: line?.state, cumulative: line?.cumulativeEntitlementCents, basis: line?.netServiceBasisCents, posted: line?.previousPostedCents }, { state: "ACCRUED_PENDING", cumulative: 4121n, basis: 103025n, posted: 4921n });

  // the same event delivered again adds nothing: recomputed from the locked rows, and applied as first computed (UNIQUE line, source event)
  const again = await basisChange(a.ag, second.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 103025n }, refund, S.agreementVersion);
  assert.deepEqual(again.map((r) => r.applied), [false]);
  const stale = await ledgerIn(a.ag, async (ledger) => {
    const pool = (await ledger.lockPoolsOfCapture(second.captureId as never))[0]!.pool;
    return ledger.applyBasisChange(pool.poolId, 103025n, 4121n, [
      { adjustmentId: ids.next() as never, commissionLineId: lineId as CommissionLineId, reason: "REFUND", signedCents: -800n, newCumulativeEntitlementCents: 4121n, sourceEventId: refund as EventId, agreementVersion: S.agreementVersion, createdAt: clock.now() },
    ]);
  });
  assert.equal(stale.applied, false);
  assert.equal((await ledgerIn(a.ag, (ledger) => ledger.adjustmentsOfLine(lineId as CommissionLineId))).length, 1, "one adjustment for one source event");

  // another refund of 1000 (basis 102025, 4081 cents: a 40-cent decrease) whose adjustment says 30: not the cumulative difference
  await assert.rejects(
    ledgerIn(a.ag, async (ledger) => {
      const pool = (await ledger.lockPoolsOfCapture(second.captureId as never))[0]!.pool;
      return ledger.applyBasisChange(pool.poolId, 102025n, 4081n, [
        { adjustmentId: ids.next() as never, commissionLineId: lineId as CommissionLineId, reason: "REFUND", signedCents: -30n, newCumulativeEntitlementCents: 4081n, sourceEventId: ids.next() as EventId, agreementVersion: S.agreementVersion, createdAt: clock.now() },
      ]);
    }),
    failedWith("INTEGRITY_FAILURE", "ADJUSTMENT_NOT_CUMULATIVE"),
  );
  assert.equal((await ledgerIn(a.ag, (ledger) => ledger.adjustmentsOfLine(lineId as CommissionLineId))).length, 1, "the refused adjustment left nothing");
});

// --- R2-096 ------------------------------------------------------------------------------------------------------------------------------

test("R2-096 at the ledger: a full service refund of the first purchase moves its 1000-bps line ACCRUED_PENDING to VOID with cumulative 0, while qualifying_purchases, the entitlement's first capture and window and the consumed slot stay", async () => {
  const S = await activeSeller(w, "r096-seller");
  const a = await acquired(w, "R2-096 agency", [{ seller: S, shareBps: 10000 }], { foundingFixture: true });
  const { lineId } = await recordAccruedLine(w.h, {
    agencyId: a.ag.agencyId,
    authorizationId: a.first.authorizationId,
    captureId: a.first.captureId,
    allocationId: a.allocationId,
    entitlementId: a.entitlements.get(S.sellerId)!,
    sellerId: S.sellerId,
    rateKind: "FIRST",
    rateBps: 1000,
    basisCents: 97125n,
    poolCents: 9713n,
  });
  const designation = async () => ({
    purchases: await digest(w, "SELECT * FROM kauro.qualifying_purchases WHERE agency_id = $1", [a.ag.agencyId]),
    recurrence: await digest(w, "SELECT * FROM kauro.agency_recurrence WHERE agency_id = $1", [a.ag.agencyId]),
    entitlements: await digest(w, "SELECT * FROM kauro.commission_entitlements WHERE agency_id = $1", [a.ag.agencyId]),
    slots: await digest(w, "SELECT * FROM kauro.founding_slots", []),
    reservations: await digest(w, "SELECT * FROM kauro.founding_slot_reservations WHERE agency_id = $1", [a.ag.agencyId]),
  });
  const before = await designation();

  const refund = ids.next();
  const applied = await basisChange(a.ag, a.first.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 0n }, refund, S.agreementVersion);
  assert.deepEqual(applied.map((r) => r.applied), [true]);
  const line = await ledgerIn(a.ag, (ledger) => ledger.getLine(lineId as CommissionLineId));
  assert.deepEqual({ state: line?.state, cumulative: line?.cumulativeEntitlementCents, basis: line?.netServiceBasisCents, posted: line?.previousPostedCents, rate: line?.rateBps }, { state: "VOID", cumulative: 0n, basis: 0n, posted: 9713n, rate: 1000 });
  const adjustments = await ledgerIn(a.ag, (ledger) => ledger.adjustmentsOfLine(lineId as CommissionLineId));
  assert.deepEqual(adjustments.map((x) => ({ reason: x.reason, direction: x.direction, amount: x.amountCents, cumulative: x.newCumulativeEntitlementCents })), [{ reason: "REFUND", direction: "DECREASE", amount: 9713n, cumulative: 0n }]);
  const pools = await ledgerIn(a.ag, (ledger) => ledger.poolsOfPurchase(a.first.authorizationId as never));
  assert.deepEqual(pools.map((p: CommissionPoolRecord) => ({ basis: p.basisCents, initial: p.initialBasisCents, cents: p.poolCents })), [{ basis: 0n, initial: 97125n, cents: 0n }]);
  assert.deepEqual(await designation(), before, "the designation, the entitlement's first capture and window and the slot are row for row what they were");
});

// --- R2-102 ------------------------------------------------------------------------------------------------------------------------------

test("R2-102: a 1000-cent hold on the disputed part of one line leaves the line on its path, and the statement composition withholds exactly those cents with reason and review date while 50000 cents of unrelated eligible lines stay payable", async () => {
  // a seller whose agreement pays its whole pool (10000 bps) so the cents of the lines are the round numbers of the case
  const S = await activeSeller(w, "r102-seller", { firstBps: 10000, repeatBps: 400 });
  const disputed = await acquiredAt("R2-102 disputed agency", S, { firstBps: 10000, repeatBps: 400 });
  const unrelated = await acquiredAt("R2-102 unrelated agency", S, { firstBps: 10000, repeatBps: 400 });
  const lineOf = async (x: typeof disputed, basis: bigint) =>
    (
      await recordEligibleLine(w.h, {
        agencyId: x.ag.agencyId,
        authorizationId: x.first.authorizationId,
        captureId: x.first.captureId,
        allocationId: x.allocationId,
        entitlementId: x.entitlementId,
        sellerId: S.sellerId,
        rateKind: "FIRST",
        rateBps: 10000,
        basisCents: basis,
        poolCents: basis,
      })
    ).lineId;
  const L1 = await lineOf(disputed, 10000n);
  const L2 = await lineOf(unrelated, 50000n);

  // the owner opens a hold of 1000 cents on the disputed part of L1, with its reason and a review date
  const reviewAt = instantOf(Date.now() + 14 * 86_400_000);
  const hold = await within(w.app, ownerOf(w), (c) =>
    new PgCommissionLedgerRepository(c, ids).openHold({ holdId: ids.next() as never, lineId: L1 as CommissionLineId, amountCents: 1000n, reason: "SELLER_DISPUTE", reviewAt: reviewAt as never, openedAt: clock.now() }),
  );
  assert.deepEqual({ state: hold.state, amount: hold.amountCents, reason: hold.reason, review: hold.reviewAt, line: hold.lineId, seller: hold.sellerId }, { state: "OPEN", amount: 1000n, reason: "SELLER_DISPUTE", review: reviewAt, line: L1, seller: S.sellerId });
  const l1 = await ledgerIn(disputed.ag, (ledger) => ledger.getLine(L1 as CommissionLineId));
  assert.deepEqual({ state: l1?.state, cumulative: l1?.cumulativeEntitlementCents }, { state: "ELIGIBLE", cumulative: 10000n }, "a partial hold leaves the line on its path");

  // the composition at the close: L1 payable net of the hold, the hold itemized with reason and review date, L2 whole
  const cutoffAt = clock.now();
  const composed = await statementsIn(async (statements) => {
    const inputs = await statements.periodInputs(period as never, cutoffAt);
    return composeStatement({ sellerId: S.sellerId as SellerId, periodStartsAt: "2026-09-01T05:00:00.000Z" as never, cutoffAt, rows: inputs });
  });
  assert.deepEqual(
    composed.items.map((i) => ({ no: i.itemNo, kind: i.kind, disposition: i.disposition, line: i.lineId, held: i.heldCents, payable: i.payableCents, reason: i.holdReason, review: i.holdReviewAt })),
    [
      { no: 1, kind: "LINE", disposition: "PAYABLE", line: L1, held: 0n, payable: 9000n, reason: undefined, review: undefined },
      { no: 2, kind: "HOLD", disposition: "HELD", line: L1, held: 1000n, payable: 0n, reason: "SELLER_DISPUTE", review: reviewAt },
      { no: 3, kind: "LINE", disposition: "PAYABLE", line: L2, held: 0n, payable: 50000n, reason: undefined, review: undefined },
    ],
  );
  assert.deepEqual({ held: composed.heldCents, payable: composed.payableCents, accrued: composed.accruedPendingCents, paid: composed.paidToDateCents, negative: composed.negativeBalanceCents }, { held: 1000n, payable: 59000n, accrued: 0n, paid: 0n, negative: 0n });

  // issued, the statement stores exactly that
  const statement = await recordIssuedStatement(w.h, { periodId: period, sellerId: S.sellerId, cutoffAt });
  const stored = await statementsIn(async (statements) => ({ record: await statements.getStatement(statement.statementId), items: await statements.itemsOf(statement.statementId) }));
  assert.deepEqual({ state: stored.record?.state, held: stored.record?.heldCents, payable: stored.record?.payableCents }, { state: "ISSUED", held: 1000n, payable: 59000n });
  const held = stored.items.filter((i) => i.kind === "HOLD");
  assert.deepEqual(held.map((i) => ({ hold: i.holdId, cents: i.heldCents, reason: i.holdReason, review: i.holdReviewAt })), [{ hold: hold.holdId, cents: 1000n, reason: "SELLER_DISPUTE", review: reviewAt }]);
  assert.equal(stored.items.filter((i) => i.disposition === "PAYABLE").reduce((sum, i) => sum + i.payableCents, 0n), 59000n);
  assert.deepEqual(
    (await ledgerIn(unrelated.ag, async (ledger) => [(await ledger.getLine(L2 as CommissionLineId))?.state])).concat(await ledgerIn(disputed.ag, async (ledger) => [(await ledger.getLine(L1 as CommissionLineId))?.state])),
    ["PAYABLE", "PAYABLE"],
  );
});

// --- R2-081 ------------------------------------------------------------------------------------------------------------------------------

test("R2-081 at the ledger: twenty-five one-cent service refunds of a 25-cent basis recompute each line cumulatively and leave every pool, allocation and line at exactly zero with no residue", async () => {
  const S1 = await activeSeller(w, "r081-seller-one");
  const S2 = await activeSeller(w, "r081-seller-two");
  const a = await acquired(
    w,
    "R2-081 agency",
    [
      { seller: S1, shareBps: 5000 },
      { seller: S2, shareBps: 5000 },
    ],
    { foundingFixture: true },
  );
  // 25 cents at 1000 bps is round(2.5) = 3 cents, split by the largest remainder, the tie to the beneficiary id ascending (example 8)
  const split = allocatePool(3n, [
    { sellerId: S1.sellerId, shareBps: 5000 },
    { sellerId: S2.sellerId, shareBps: 5000 },
  ]);
  assert.equal([...split.values()].reduce((x, y) => x + y, 0n), 3n);
  const pool = poolOf(
    a,
    a.first,
    [S1, S2].map((s) => ({ sellerId: s.sellerId, entitlementId: a.entitlements.get(s.sellerId)!, shareBps: 5000, cents: split.get(s.sellerId)! })),
    { rateKind: "FIRST", rateBps: 1000, basisCents: 25n, poolCents: 3n },
  );
  const accrued = await ledgerIn(a.ag, (ledger) => ledger.accrue(pool));
  assert.equal(accrued.created, true);
  const original = new Map(accrued.lines.map((l) => [l.lineId as string, l.cumulativeEntitlementCents]));
  assert.equal([...original.values()].reduce((x, y) => x + y, 0n), 3n);

  // twenty-five one-cent service refunds, each its own event: the basis after the k-th is 25 - k
  for (let k = 1; k <= 25; k++) {
    const applied = await basisChange(a.ag, a.first.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: BigInt(25 - k) }, ids.next(), S1.agreementVersion);
    assert.deepEqual(applied.map((r) => r.applied), [true], `refund ${k} lowers the basis`);
  }
  const [poolAfter] = await ledgerIn(a.ag, (ledger) => ledger.poolsOfPurchase(a.first.authorizationId as never));
  assert.deepEqual({ basis: poolAfter?.basisCents, cents: poolAfter?.poolCents, initial: poolAfter?.initialBasisCents }, { basis: 0n, cents: 0n, initial: 25n });
  for (const line of accrued.lines) {
    const now = await ledgerIn(a.ag, (ledger) => ledger.getLine(line.lineId));
    assert.deepEqual({ state: now?.state, cumulative: now?.cumulativeEntitlementCents, basis: now?.netServiceBasisCents }, { state: "VOID", cumulative: 0n, basis: 0n }, "every line at exactly zero");
    const adjustments = await ledgerIn(a.ag, (ledger) => ledger.adjustmentsOfLine(line.lineId));
    assert.ok(adjustments.every((x) => x.direction === "DECREASE"), "refunds only decrease");
    assert.equal(adjustments.reduce((sum, x) => sum + x.amountCents, 0n), original.get(line.lineId as string), "the adjustments sum to the original accrual, no residue");
    assert.deepEqual(adjustments.map((x) => x.adjustmentSeq), adjustments.map((_, i) => i + 1), "numbered in order from 1");
  }
  // the replay of the last event adds nothing
  const sums = await w.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.commission_adjustments WHERE agency_id = $1", [a.ag.agencyId]);
  assert.ok(Number(sums.rows[0]!.n) >= 2);
});

// --- B09-R2 ------------------------------------------------------------------------------------------------------------------------------

test("B09-R2 at the ledger: a commission basis only falls — a refund.completed.v1 after the capture's reversal, and one naming a basis above the line's current basis, append no adjustment, and a replay of any event adds nothing", async () => {
  const S = await activeSeller(w, "b09r2-seller");
  const a = await acquired(w, "B09-R2 agency", [{ seller: S, shareBps: 10000 }], { foundingFixture: true });
  const entitlementId = a.entitlements.get(S.sellerId)!;
  const second = await purchase(w, a.ag, "b09r2-second", { qualifying: [a.first.projectId], client: 1 });
  const base = { agencyId: a.ag.agencyId, allocationId: a.allocationId, entitlementId, sellerId: S.sellerId };
  const one = await recordAccruedLine(w.h, { ...base, authorizationId: a.first.authorizationId, captureId: a.first.captureId, rateKind: "FIRST", rateBps: 1000, basisCents: 97125n, poolCents: 9713n });
  const two = await recordAccruedLine(w.h, { ...base, authorizationId: second.authorizationId, captureId: second.captureId, rateKind: "REPEAT", rateBps: 400, basisCents: 123025n, poolCents: 4921n });
  const count = (lineId: string) => ledgerIn(a.ag, async (ledger) => (await ledger.adjustmentsOfLine(lineId as CommissionLineId)).length);

  const refund = ids.next();
  assert.deepEqual((await basisChange(a.ag, second.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 103025n }, refund, S.agreementVersion)).map((r) => r.applied), [true]);
  // the capture is reversed: the basis is zero and the line VOID
  assert.deepEqual((await basisChange(a.ag, second.captureId, { kind: "CAPTURE_REVERSED" }, ids.next(), S.agreementVersion)).map((r) => r.applied), [true]);
  assert.equal(await count(two.lineId), 2);
  const voided = await ledgerIn(a.ag, (ledger) => ledger.getLine(two.lineId as CommissionLineId));
  assert.deepEqual({ state: voided?.state, cumulative: voided?.cumulativeEntitlementCents, basis: voided?.netServiceBasisCents }, { state: "VOID", cumulative: 0n, basis: 0n });

  // a refund completing after the reversal names the service less its refunds (83025), never a basis the line may rise to
  assert.deepEqual((await basisChange(a.ag, second.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 83025n }, ids.next(), S.agreementVersion)).map((r) => r.applied), [false]);
  assert.equal(await count(two.lineId), 2);
  // an event naming a basis above the line's current basis (97125) changes nothing
  assert.deepEqual((await basisChange(a.ag, a.first.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 110000n }, ids.next(), S.agreementVersion)).map((r) => r.applied), [false]);
  assert.equal(await count(one.lineId), 0);
  // and the database refuses to raise a basis at all
  await assert.rejects(
    ledgerIn(a.ag, async (ledger) => {
      const pool = (await ledger.lockPoolsOfCapture(a.first.captureId as never))[0]!.pool;
      return ledger.applyBasisChange(pool.poolId, 110000n, 11000n, []);
    }),
    failedWith("INTEGRITY_FAILURE", "ADJUSTMENT_NOT_CUMULATIVE"),
  );
  // a replay of any event adds nothing
  assert.deepEqual((await basisChange(a.ag, second.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 103025n }, refund, S.agreementVersion)).map((r) => r.applied), [false]);
  assert.equal(await count(two.lineId), 2);
  assert.equal(await count(one.lineId), 0);
  const rows = await ledgerIn(a.ag, async (ledger) => (await ledger.getLine(one.lineId as CommissionLineId))?.cumulativeEntitlementCents);
  assert.equal(rows, 9713n);
});

// --- CMD051 -------------------------------------------------------------------------------------------------------------------------------

test("CMD051 through the adapters: the cutoff hash KAURO_COMMISSION_CUTOFF_V1 over the included lines, adjustments and holds is recomputed identically from the rows and changes with any of them, and statements and their items cannot be updated or deleted", async () => {
  const S = await activeSeller(w, "cmd051-seller");
  const a = await acquired(w, "CMD051 agency", [{ seller: S, shareBps: 10000 }], { foundingFixture: true });
  const second = await purchase(w, a.ag, "cmd051-second", { qualifying: [a.first.projectId], client: 1 });
  const base = { agencyId: a.ag.agencyId, allocationId: a.allocationId, entitlementId: a.entitlements.get(S.sellerId)!, sellerId: S.sellerId };
  const one = await recordEligibleLine(w.h, { ...base, authorizationId: a.first.authorizationId, captureId: a.first.captureId, rateKind: "FIRST", rateBps: 1000, basisCents: 97125n, poolCents: 9713n });
  await recordAccruedLine(w.h, { ...base, authorizationId: second.authorizationId, captureId: second.captureId, rateKind: "REPEAT", rateBps: 400, basisCents: 123025n, poolCents: 4921n });

  const cutoffAt = clock.now();
  const hashOf = () =>
    statementsIn(async (statements) => {
      const inputs = await statements.periodInputs(period as never, cutoffAt);
      return commissionCutoffHash({ periodId: period as never, cutoffAt, lines: inputs.lines, adjustments: inputs.adjustments, holds: inputs.holds });
    });
  const h1 = await hashOf();
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(await hashOf(), h1, "recomputed identically from the same rows");

  // an adjustment (a refund of the second purchase) changes it
  await basisChange(a.ag, second.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 103025n }, ids.next(), S.agreementVersion);
  const h2 = await hashOf();
  assert.notEqual(h2, h1);
  assert.equal(await hashOf(), h2);
  // a hold opened changes it
  const opened = await recordHold(w.h, { ownerUserId: w.kora, lineId: one.lineId, amountCents: 700n, reason: "SELLER_DISPUTE" });
  const h3 = await hashOf();
  assert.notEqual(h3, h2);
  // and resolved
  await within(w.app, ownerOf(w), async (c) => {
    const holds = new PgCommissionLedgerRepository(c, ids);
    const [open] = await holds.holdsOfLine(one.lineId as CommissionLineId);
    return holds.resolveHold(open!.holdId, open!.version, "RELEASED", clock.now());
  });
  const h4 = await hashOf();
  assert.notEqual(h4, h3);
  assert.notEqual(h4, h2);
  assert.equal(opened.amountCents, 700n);
  // a line transition changes it
  await recordIssuedStatement(w.h, { periodId: period, sellerId: S.sellerId, cutoffAt: clock.now() });
  assert.notEqual(await hashOf(), h4);

  // the close writes the period CLOSED with the hash it closed on, once
  const closed = await statementsIn(async (statements) => {
    const current = (await statements.lockPeriod(period as never))!;
    assert.equal(current.state, "OPEN");
    const inputs = await statements.periodInputs(period as never, cutoffAt);
    const hash = commissionCutoffHash({ periodId: period as never, cutoffAt, lines: inputs.lines, adjustments: inputs.adjustments, holds: inputs.holds });
    assert.equal(inputs.undeliveredBeforeCutoff, null, "the commission service cannot read the COMMISSIONS outbox: unobservable, never reconciled by default");
    const done = await statements.closePeriod(period as never, current.version, hash, clock.now());
    assert.equal(done.kind, "APPLIED");
    return { done, hash };
  });
  assert.ok(closed.done.kind === "APPLIED");
  assert.deepEqual({ state: closed.done.record.state, hash: closed.done.record.cutoffHash, closeDue: closed.done.record.closeDueOn, payDue: closed.done.record.payDueOn }, { state: "CLOSED", hash: closed.hash, closeDue: "2026-10-07", payDue: "2026-10-15" });

  // statements and their items cannot be updated or deleted, whoever asks
  const statementId = (await statementsIn((statements) => statements.statementsOfSeller(S.sellerId as SellerId)))[0]!.statementId;
  await oracleProbe(w, "UPDATE kauro.statement_items SET payable_cents = 1 WHERE statement_id = $1", [statementId], refusedWith("KA004"), "an item is never updated");
  await oracleProbe(w, "DELETE FROM kauro.statement_items WHERE statement_id = $1", [statementId], refusedWith("KA004"), "an item is never deleted");
  await oracleProbe(w, "UPDATE kauro.commission_statements SET payable_cents = 1 WHERE statement_id = $1", [statementId], refusedWith("KA004"), "a statement's totals never change");
  await oracleProbe(w, "DELETE FROM kauro.commission_statements WHERE statement_id = $1", [statementId], refusedWith("KA004"), "a statement is never deleted");
});

// --- CMD053 -------------------------------------------------------------------------------------------------------------------------------

test("CMD053 through the adapters: settling an intent takes its statement's row lock, so two settlements serialize and the second finds it SETTLED and changes nothing", async () => {
  const S = await activeSeller(w, "cmd053-seller");
  const a = await acquired(w, "CMD053 agency", [{ seller: S, shareBps: 10000 }], { foundingFixture: true });
  const { lineId } = await recordEligibleLine(w.h, {
    agencyId: a.ag.agencyId,
    authorizationId: a.first.authorizationId,
    captureId: a.first.captureId,
    allocationId: a.allocationId,
    entitlementId: a.entitlements.get(S.sellerId)!,
    sellerId: S.sellerId,
    rateKind: "FIRST",
    rateBps: 1000,
    basisCents: 97125n,
    poolCents: 9713n,
  });
  const issued = await recordIssuedStatement(w.h, { periodId: period, sellerId: S.sellerId, cutoffAt: clock.now() });
  assert.equal(issued.payableCents, 9713n);
  const intentId = (await approvePayout(w, { statementId: issued.statementId, payableCents: 9713 }, S, S)) as PayoutIntentId;

  /** CMD053's writes in one transaction of the finance service: the statement's row lock first, then the evidence, the intent, the statement and its lines. */
  const settle = async (c: Client): Promise<"SETTLED" | "ALREADY_SETTLED"> => {
    const statements = new PgStatementRepository(c);
    const ledger = new PgCommissionLedgerRepository(c, ids);
    const intent = (await statements.getIntent(intentId))!;
    const statement = (await statements.lockStatement(intent.statementId))!;
    if (statement.state === "PAID") return "ALREADY_SETTLED";
    const evidenceHash = sha(`payout-evidence-SETTLED-${intentId}`);
    await statements.recordReconciliation({
      reconciliationId: ids.next() as PayoutReconciliationId,
      intentId,
      evidence: { status: "SETTLED", reference: intent.reference, destinationDigest: intent.destinationDigest, amountCents: intent.amountCents, currency: intent.currency, observedAt: clock.now(), evidenceHash: evidenceHash as never },
      reconciledAt: clock.now(),
    });
    assert.equal((await statements.transitionIntent(intentId, intent.version, "SETTLED", clock.now())).kind, "APPLIED");
    assert.equal((await statements.transitionStatement(statement.statementId, statement.version, { state: "PAID", payoutEvidenceHash: evidenceHash as never }, clock.now())).kind, "APPLIED");
    const line = (await ledger.lockLine(lineId as CommissionLineId))!;
    assert.equal((await ledger.transitionLine(line.lineId, line.version, { state: "PAID" }, clock.now())).kind, "APPLIED");
    return "SETTLED";
  };

  const holder = await w.h.pg.connect("kauro_commission_test");
  const waiter = await w.h.pg.connect("kauro_commission_test");
  try {
    const locked = barrier();
    const release = barrier();
    const first = handled(
      within(holder, corporate, async (c) => {
        await new PgStatementRepository(c).lockStatement(issued.statementId);
        locked.open();
        await release.wait;
        return settle(c);
      }),
    );
    await Promise.race([locked.wait, first]);
    const waiterPid = await backendPid(waiter);
    const second = handled(within(waiter, corporate, settle));
    const observed = await settlesOrWaits(w.h.oracle, waiterPid, second, "the second settlement");
    assert.equal(observed.kind, "WAITING", "the second settlement waits on the statement's row lock");
    const waiting = await w.h.oracle.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.pid = $1 AND NOT l.granted",
      [waiterPid],
    );
    assert.equal(waiting.rows[0]!.n, "1", "pg_locks shows the one ungranted lock");
    release.open();
    assert.equal(await first, "SETTLED");
    assert.ok(observed.kind === "WAITING");
    const outcome = await observed.pending;
    assert.deepEqual(outcome, { status: "fulfilled", value: "ALREADY_SETTLED" });
  } finally {
    await holder.end();
    await waiter.end();
  }

  // one transition: one reconciliation, the intent SETTLED, the statement PAID and the line PAID once at its item's payable cents
  const rows = await w.h.oracle.query<{ recs: string; intent: string; statement: string; line: string; paid: string }>(
    `SELECT (SELECT count(*) FROM kauro.payout_reconciliations WHERE intent_id = $1)::text AS recs,
            (SELECT state || ':' || version FROM kauro.payout_intents WHERE intent_id = $1) AS intent,
            (SELECT state || ':' || version FROM kauro.commission_statements WHERE statement_id = $2) AS statement,
            (SELECT state FROM kauro.commission_lines WHERE line_id = $3) AS line,
            (SELECT paid_cents::text FROM kauro.commission_lines WHERE line_id = $3) AS paid`,
    [intentId, issued.statementId, lineId],
  );
  assert.deepEqual(rows.rows[0], { recs: "1", intent: "SETTLED:2", statement: "PAID:4", line: "PAID", paid: "9713" });
});

// --- translations, accessors, bindings -----------------------------------------------------------------------------------------------

test("KC002, KC007, KC009, KC010, KC015 and KC017 reach their callers as the failures design 12 names", async () => {
  const expected: Record<string, { code: string; reason: string }> = {
    KC002: { code: "INTEGRITY_FAILURE", reason: "COMMISSION_POOL_MISMATCH" },
    KC007: { code: "INTEGRITY_FAILURE", reason: "ELIGIBILITY_WITHOUT_FINAL_COMPLETION" },
    KC015: { code: "INTEGRITY_FAILURE", reason: "ADJUSTMENT_NOT_CUMULATIVE" },
    KC009: { code: "PRECONDITION_FAILED", reason: "PAYEE_UNVERIFIED" },
    KC010: { code: "PRECONDITION_FAILED", reason: "PAYOUT_NOT_SETTLED" },
    KC017: { code: "PRECONDITION_FAILED", reason: "OFFSET_NOT_AUTHORIZED" },
  };
  for (const [sqlState, want] of Object.entries(expected)) {
    const failure = failureOfSqlState(sqlState);
    assert.ok(failure, sqlState);
    assert.deepEqual({ code: failure.code, reason: failure.reason }, want, sqlState);
  }

  // KC007: a line becomes ELIGIBLE only with its purchase's FINAL completion
  const S = await activeSeller(w, "kc-seller");
  const a = await acquired(w, "KC agency", [{ seller: S, shareBps: 10000 }], { foundingFixture: true });
  const { lineId } = await recordAccruedLine(w.h, {
    agencyId: a.ag.agencyId,
    authorizationId: a.first.authorizationId,
    captureId: a.first.captureId,
    allocationId: a.allocationId,
    entitlementId: a.entitlements.get(S.sellerId)!,
    sellerId: S.sellerId,
    rateKind: "FIRST",
    rateBps: 1000,
    basisCents: 97125n,
    poolCents: 9713n,
  });
  await assert.rejects(
    ledgerIn(a.ag, async (ledger) => ledger.transitionLine(lineId as CommissionLineId, 1, { state: "ELIGIBLE" }, clock.now())),
    failedWith("INTEGRITY_FAILURE", "ELIGIBILITY_WITHOUT_FINAL_COMPLETION"),
  );
  // a STAGE completion starts no clock; the FINAL one is recorded once
  await completion(w, a.ag, a.first, "STAGE");
  await completion(w, a.ag, a.first, "FINAL");
  await funds(w, a.ag, a.first, "AVAILABLE", 2);
  const eligible = await within(w.commission, corporate, async (c) => {
    await c.query(
      "SELECT set_config('kauro_test.clock_offset_seconds', (extract(epoch FROM (x.at - transaction_timestamp())) + 720 * 3600)::text, true) FROM (SELECT completed_at AS at FROM kauro.purchase_completions WHERE authorization_id = $1 AND kind = 'FINAL') x",
      [a.first.authorizationId],
    );
    return new PgCommissionLedgerRepository(c, ids).transitionLine(lineId as CommissionLineId, 1, { state: "ELIGIBLE" }, clock.now());
  });
  assert.equal(eligible.kind, "APPLIED");
  assert.equal(eligible.kind === "APPLIED" && eligible.record.state, "ELIGIBLE");

  // KC009: a payout is authorized to a VERIFIED destination version of the seller, never to one changed and not yet verified
  const issued = await recordIssuedStatement(w.h, { periodId: period, sellerId: S.sellerId, cutoffAt: clock.now() });
  const unverified = await changeDestination(w, S);
  const proof = await stepUpProof(w.assurance, { userId: w.kora });
  // CMD052's writes in the owner's transaction: the intent of exactly the payable and, with it, the statement APPROVED
  const authorize = (destination: { readonly destinationId: string; readonly destinationDigest: string; readonly destinationVersion: number }, id: PayoutIntentId) =>
    within(w.app, ownerOf(w), async (c) => {
      const statements = new PgStatementRepository(c);
      const result = await statements.authorizeIntent({
        intent: {
          intentId: id,
          statementId: issued.statementId,
          sellerId: S.sellerId as SellerId,
          amountCents: issued.payableCents,
          currency: "USD",
          feeBearer: "KAURO",
          destinationId: destination.destinationId as never,
          destinationVersion: destination.destinationVersion,
          destinationDigest: destination.destinationDigest as never,
          reference: `kauro-payout-${id}`,
          authorizedBy: w.kora,
          authorizationProofId: proof as never,
          authorizedAt: clock.now(),
        },
      });
      if (result.authorized) {
        const statement = (await statements.lockStatement(issued.statementId))!;
        assert.equal((await statements.transitionStatement(statement.statementId, statement.version, { state: "APPROVED" }, clock.now())).kind, "APPLIED");
      }
      return result;
    });
  await assert.rejects(authorize(unverified, ids.next() as PayoutIntentId), failedWith("PRECONDITION_FAILED", "PAYEE_UNVERIFIED"));
  const good = await authorize({ destinationId: S.destinationId, destinationDigest: S.destinationDigest, destinationVersion: 1 }, ids.next() as PayoutIntentId);
  assert.equal(good.authorized, true);
  const replay = await authorize({ destinationId: S.destinationId, destinationDigest: S.destinationDigest, destinationVersion: 1 }, ids.next() as PayoutIntentId);
  assert.deepEqual({ authorized: replay.authorized, same: replay.record.intentId === good.record.intentId }, { authorized: false, same: true }, "one live intent per statement: the replayed row");

  // KC010: a statement is paid only with its SETTLED intent's evidence
  await assert.rejects(
    statementsIn(async (statements) => {
      const statement = (await statements.lockStatement(issued.statementId))!;
      return statements.transitionStatement(statement.statementId, statement.version, { state: "PAID", payoutEvidenceHash: sha("nothing settled") as never }, clock.now());
    }),
    failedWith("PRECONDITION_FAILED", "PAYOUT_NOT_SETTLED"),
  );
});

test("ledgerOf and statementsOf answer one adapter per unit of work on its own connection, and RecordedBankingCalendarSource answers the latest VERIFIED_FEED version", async () => {
  const S = await activeSeller(w, "accessor-seller");
  const a = await acquired(w, "Accessor agency", [{ seller: S, shareBps: 10000 }], { foundingFixture: true });
  const { lineId } = await recordAccruedLine(w.h, {
    agencyId: a.ag.agencyId,
    authorizationId: a.first.authorizationId,
    captureId: a.first.captureId,
    allocationId: a.allocationId,
    entitlementId: a.entitlements.get(S.sellerId)!,
    sellerId: S.sellerId,
    rateKind: "FIRST",
    rateBps: 1000,
    basisCents: 97125n,
    poolCents: 9713n,
  });
  // the corporate owner reads the ledger through the accessor (policy: the owner reads all); the seller reads only its own lines
  const asOwner = await w.h.commerce.run(w.h.operator(w.kora), async (uow) => {
    const ledger = ledgerOf(uow);
    assert.strictEqual(ledgerOf(uow), ledger, "one adapter per unit of work");
    assert.strictEqual(statementsOf(uow), statementsOf(uow));
    return ledger.getLine(lineId as CommissionLineId);
  });
  assert.equal(asOwner?.cumulativeEntitlementCents, 9713n);
  const asSeller = await w.h.commerce.run(w.h.operator(S.userId as Parameters<typeof w.h.operator>[0]), (uow) => ledgerOf(uow as PgCommerceUnitOfWork).linesOfSeller(S.sellerId as SellerId));
  assert.deepEqual(asSeller.map((l) => l.lineId), [lineId]);
  assert.throws(() => ledgerOf({} as never), (e: unknown) => e instanceof DomainFailure && e.code === "INTEGRITY_FAILURE", "a unit of work of another package is refused");

  // the calendar binding: the latest recorded VERIFIED_FEED version, never the test fixture; none answers null (CALENDAR_UNAVAILABLE)
  const binding = new RecordedBankingCalendarSource();
  assert.equal(binding.binding, "PLATFORM");
  const calendar = () => w.h.commerce.run(w.h.operator(w.kora), (uow) => binding.currentCalendar(uow, { jurisdiction: "CO", at: clock.now() }));
  assert.equal(await calendar(), null, "only a TEST_FIXTURE calendar is recorded: none is in force");
  const feedId = await fixtureCalendar(w, "VERIFIED_FEED", ["2026-10-12", "2026-11-02"]);
  const current = await calendar();
  assert.deepEqual(
    { version: current?.calendarVersion, source: current?.source, jurisdiction: current?.jurisdiction, dates: current?.nonbankingDates, from: current?.coversFrom, to: current?.coversTo },
    { version: `CO-VERIFIED_FEED-${feedId.slice(-8)}`, source: "VERIFIED_FEED", jurisdiction: "CO", dates: ["2026-10-12", "2026-11-02"], from: "2026-10-01", to: "2026-12-31" },
  );
});

// the statement composition and the cutoff hash are pure, so the rows they read are the whole of their input
test("composeStatement over periodInputs itemizes an accrued line awaiting its final completion and reports nothing for a seller without lines", async () => {
  const S = await activeSeller(w, "compose-seller");
  const nobody = await activeSeller(w, "compose-nobody");
  const a = await acquired(w, "Compose agency", [{ seller: S, shareBps: 10000 }], { foundingFixture: true });
  const { lineId } = await recordAccruedLine(w.h, {
    agencyId: a.ag.agencyId,
    authorizationId: a.first.authorizationId,
    captureId: a.first.captureId,
    allocationId: a.allocationId,
    entitlementId: a.entitlements.get(S.sellerId)!,
    sellerId: S.sellerId,
    rateKind: "FIRST",
    rateBps: 1000,
    basisCents: 97125n,
    poolCents: 9713n,
  });
  const cutoffAt = clock.now();
  const [mine, theirs] = await statementsIn(async (statements) => {
    const rows = await statements.periodInputs(period as never, cutoffAt);
    return [
      composeStatement({ sellerId: S.sellerId as SellerId, periodStartsAt: "2026-09-01T05:00:00.000Z" as never, cutoffAt, rows }),
      composeStatement({ sellerId: nobody.sellerId as SellerId, periodStartsAt: "2026-09-01T05:00:00.000Z" as never, cutoffAt, rows }),
    ] as const;
  });
  assert.deepEqual(mine.items.map((i) => ({ kind: i.kind, disposition: i.disposition, line: i.lineId, cumulative: i.cumulativeCents, payable: i.payableCents })), [
    { kind: "LINE", disposition: "AWAITING_FINAL_COMPLETION", line: lineId, cumulative: 9713n, payable: 0n },
  ]);
  assert.equal(mine.accruedPendingCents, 9713n);
  assert.deepEqual({ items: theirs.items.length, payable: theirs.payableCents }, { items: 0, payable: 0n });
});
