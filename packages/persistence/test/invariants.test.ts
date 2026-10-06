// The self-test of the B10 state oracle (@kauro/persistence/testing invariants.ts; docs/design/B10-KIT-SUITES.md section 2.1). Positive
// controls first, built through the runtime roles exactly as the ledger tests build them: R2-102 (a partial hold withheld by its
// statement), R2-104 (a paid line refunded below what was paid: a negative balance) with example 7's offset under signed
// SIGNED_FUTURE_OFFSET terms itemized by a later statement, r3 R3-01 (basis 270 -> 260 -> 250 at shares 1000/1400/7600: the first refund
// decreases the 1000-bps line, which is offset, and the second raises it by one legal cent), and a HELD line beside its RELEASED hold
// (the interval between the release unit and the ELIGIBLE unit); nothing may fire on them. Then one negative control per id: a forged
// state, written as the superuser with triggers off (session_replication_role = replica, a unique index dropped where one stands in the
// way) inside a transaction that is rolled back, in which that id must fire; the other ids the forged state also violates are listed.
import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import type { Client } from "pg";
import { allocatePool, recomputePool, type AdjustmentReason, type BasisChange, type CommissionLineId, type EventId, type NewCommissionAdjustment } from "@kauro/domain";
import { PgCommissionLedgerRepository } from "../src/index.js";
import { clock } from "../src/testing/harness.js";
import { recordAccruedLine, recordEligibleLine, recordHold, recordIssuedStatement } from "../src/testing/index.js";
import { B10_INVARIANTS, assertInvariants, invariantRows, invariantsAfterEach, type InvariantHooks } from "../src/testing/invariants.js";
import {
  acceptAttribution,
  accrue,
  acquired,
  activeSeller,
  agencyWith,
  closeWorld,
  completion,
  convert,
  corporate,
  fixtureCalendar,
  funds,
  ids,
  makeEligible,
  openWorld,
  payLines,
  prepareAllocation,
  purchase,
  registerProspect,
  september,
  service,
  submitClaim,
  within,
  type Agency,
  type Seller,
  type World,
} from "./b10-commission-support.js";

let w: World;
invariantsAfterEach(() => w.h.oracle);
let september26: string;
let october26: string;

before(async () => {
  w = await openWorld("b10-invariants");
  const calendarId = await fixtureCalendar(w);
  september26 = await september(w, calendarId);
  october26 = await september(w, calendarId, "TEST_FIXTURE", ["2026-11-06", "2026-11-13"], "2026-10-01");
});
after(async () => {
  try {
    // derived from the negative controls that actually RAN in this file (forged() records them), not from a list written beside them
    assertEveryBranchControlled();
  } finally {
    await closeWorld(w);
  }
});

/** The ids of every invariant firing on a session. */
async function firing(c: Pick<Client, "query">): Promise<string[]> {
  const out: string[] = [];
  for (const inv of B10_INVARIANTS) if ((await invariantRows(c, inv)).length > 0) out.push(inv.id);
  return out;
}

/** The COMMISSIONS consumer's basis change of a capture in one unit of its agency: each pool recomputed by the domain kernel and applied with its adjustments. */
async function basisChange(ag: Agency, captureId: string, change: BasisChange, agreementVersion: string): Promise<void> {
  const sourceEventId = ids.next();
  await within(w.commission, service(ag.agencyId), async (c) => {
    const ledger = new PgCommissionLedgerRepository(c, ids);
    for (const { pool, lines } of await ledger.lockPoolsOfCapture(captureId as never)) {
      const recomputed = recomputePool({ basisCents: pool.basisCents, rateBps: pool.rateBps, lines: lines.map((l) => ({ lineId: l.lineId, sellerId: l.sellerId, shareBps: l.shareBps, cumulativeCents: l.cumulativeEntitlementCents })) }, change);
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
      assert.equal(result.applied, true, "the basis change is applied");
      // as the consumer does (ledger-effects.ts): a paid line with an adjustment walks to ADJUSTED, one version per edge
      const adjusted = new Set(recomputed.adjustments.map((a) => a.lineId));
      for (const before of lines) {
        const line = (await ledger.getLine(before.lineId))!;
        if (adjusted.has(line.lineId) && (line.state === "PAID" || line.state === "ADJUSTED")) {
          assert.equal((await ledger.transitionLine(line.lineId, line.version, { state: "ADJUSTED" }, clock.now())).kind, "APPLIED");
        }
      }
    }
  });
}

/** An offset of a negative line against a later line of the same seller, recorded by the commission service (D10-NEG-1). */
const offset = (seller: Seller, negativeLineId: string, againstLineId: string, cents: number): Promise<unknown> =>
  within(w.commission, corporate, (c) =>
    c.query(
      "INSERT INTO kauro.commission_offsets (offset_id, seller_id, negative_line_id, against_line_id, amount_cents, agreement_id, recorded_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), now())",
      [ids.next(), seller.sellerId, negativeLineId, againstLineId, cents, seller.agreementId],
    ),
  );

/** A single-seller agency acquired at the allocation's rates. */
async function acquiredAt(name: string, seller: Seller, terms: { readonly firstBps: number; readonly repeatBps: number }) {
  const ag = await agencyWith(w, name);
  const prospect = await registerProspect(w, seller, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`);
  const claimId = await submitClaim(w, seller, prospect);
  const allocationId = await prepareAllocation(w, ag, prospect, [{ seller, claimId, shareBps: 10000 }], terms);
  await acceptAttribution(w, ag, allocationId, [claimId]);
  const first = await purchase(w, ag, `${name}-first`);
  const entitlementId = (await convert(w, ag, allocationId)).get(seller.sellerId)!;
  return { ag, allocationId, first, entitlementId };
}

/** What the positive controls leave, for the negative controls to forge on. */
interface Built {
  r102: { statementId: string; disputedLine: string; wholeLine: string; wholeItem: string };
  r104: { repeatLine: string; firstLine: string; intentId: string; laterStatement: string; offsetItem: string; offsetLineItem: string };
  r301: { allocationId: string; a: Seller; aPaidLine: string; adjustmentSeq2: string };
  held: { lineId: string };
}
let built: Built | null = null;
const b = (): Built => {
  assert.ok(built !== null, "the positive controls ran first");
  return built;
};

const oneRow = async <T extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown>): Promise<T> => {
  const r = await w.h.oracle.query<T>(sql, [...params]);
  assert.equal(r.rows.length, 1, `exactly one row of: ${sql}`);
  return r.rows[0]!;
};

test("positive controls: R2-102 partial hold, R2-104 negative balance with example 7's offset, r3 R3-01's legal one-cent INCREASE after an offset, and a HELD line beside its RELEASED hold fire no invariant", async (t: TestContext) => {
  // --- R2-102: a 1000-cent hold of a 10000-cent line; the statement withholds it as a HOLD item, the LINE item PAYABLE 9000 held 0 ---
  const S = await activeSeller(w, "inv-r102", { firstBps: 10000, repeatBps: 400 });
  const disputed = await acquiredAt("INV R2-102 disputed", S, { firstBps: 10000, repeatBps: 400 });
  const whole = await acquiredAt("INV R2-102 whole", S, { firstBps: 10000, repeatBps: 400 });
  const lineOf = async (x: typeof disputed, basis: bigint) =>
    (await recordEligibleLine(w.h, { agencyId: x.ag.agencyId, authorizationId: x.first.authorizationId, captureId: x.first.captureId, allocationId: x.allocationId, entitlementId: x.entitlementId, sellerId: S.sellerId, rateKind: "FIRST", rateBps: 10000, basisCents: basis, poolCents: basis })).lineId;
  const L1 = await lineOf(disputed, 10000n);
  const L2 = await lineOf(whole, 50000n);
  await recordHold(w.h, { ownerUserId: w.kora, lineId: L1, amountCents: 1000n });
  const r102 = await recordIssuedStatement(w.h, { periodId: september26, sellerId: S.sellerId, cutoffAt: clock.now() });
  assert.deepEqual({ payable: r102.payableCents, held: r102.heldCents }, { payable: 59000n, held: 1000n });
  const items = await w.h.oracle.query<{ item_id: string; item_kind: string; line_id: string; held: string; payable: string }>(
    "SELECT item_id, item_kind, line_id, held_cents::text AS held, payable_cents::text AS payable FROM kauro.statement_items WHERE statement_id = $1 ORDER BY item_no",
    [r102.statementId],
  );
  assert.deepEqual(items.rows.map((i) => [i.item_kind, i.line_id, i.held, i.payable]), [["LINE", L1, "0", "9000"], ["HOLD", L1, "1000", "0"], ["LINE", L2, "0", "50000"]]);
  await assertInvariants(w.h.oracle, { label: "R2-102" });

  // --- R2-104 and example 7: a paid 4921 line refunded to 4121 (negative position 800), offset against the later 9713 line ---
  const T = await activeSeller(w, "inv-r104", { offsetTerms: "SIGNED_FUTURE_OFFSET" });
  const r104 = await acquired(w, "INV R2-104", [{ seller: T, shareBps: 10000 }], { foundingFixture: true });
  const firstPool = await accrue(w, r104.ag, r104.first, r104.allocationId, { rateKind: "FIRST", rateBps: 1000, basisCents: 97125, poolCents: 9713, sequence: 1 }, [
    { sellerId: T.sellerId, entitlementId: r104.entitlements.get(T.sellerId)!, shareBps: 10000, cents: 9713 },
  ]);
  const second = await purchase(w, r104.ag, "inv-r104-second", { qualifying: [r104.first.projectId], client: 1 });
  const repeat = await accrue(w, r104.ag, second, r104.allocationId, { rateKind: "REPEAT", rateBps: 400, basisCents: 123025, poolCents: 4921, sequence: 2 }, [
    { sellerId: T.sellerId, entitlementId: r104.entitlements.get(T.sellerId)!, shareBps: 10000, cents: 4921 },
  ]);
  const repeatLine = repeat.lineOf.get(T.sellerId)!;
  const firstLine = firstPool.lineOf.get(T.sellerId)!;
  const paid = await payLines(w, r104.ag, second, september26, [{ seller: T, lineId: repeatLine }]);
  await basisChange(r104.ag, second.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 103025n }, T.agreementVersion);
  assert.deepEqual(await oneRow("SELECT state, cumulative_entitlement_cents::int AS cumulative, paid_cents::int AS paid FROM kauro.commission_lines WHERE line_id = $1", [repeatLine]), { state: "ADJUSTED", cumulative: 4121, paid: 4921 });
  await assertInvariants(w.h.oracle, { label: "R2-104 negative balance" });
  await completion(w, r104.ag, r104.first, "FINAL");
  await funds(w, r104.ag, r104.first, "AVAILABLE", 2);
  await makeEligible(w, firstLine);
  await offset(T, repeatLine, firstLine, 800);
  const later = await recordIssuedStatement(w.h, { periodId: october26, sellerId: T.sellerId, cutoffAt: clock.now() });
  const laterItems = await w.h.oracle.query<{ item_id: string; item_kind: string; offset: string; payable: string }>(
    "SELECT item_id, item_kind, offset_cents::text AS offset, payable_cents::text AS payable FROM kauro.statement_items WHERE statement_id = $1 ORDER BY item_no",
    [later.statementId],
  );
  assert.deepEqual(laterItems.rows.map((i) => [i.item_kind, i.offset, i.payable]), [["LINE", "800", "8913"], ["OFFSET", "800", "0"], ["ADJUSTMENT", "0", "0"]], "example 7: the later line offsets the negative position, the OFFSET item reports it, the refund is reported");
  await assertInvariants(w.h.oracle, { label: "example 7 offset" });

  // --- r3 R3-01: shares 1000/1400/7600 (sellers in ascending id), basis 270 -> 260 -> 250 at 1000 bps: pools 27, 26, 25 split
  // [3,4,20], [2,4,20], [3,3,19]: the 1000-bps line, paid 3, falls to 2, its one-cent position is offset, and rises back to 3 ---
  const A = await activeSeller(w, "inv-r301-a", { offsetTerms: "SIGNED_FUTURE_OFFSET" });
  const B = await activeSeller(w, "inv-r301-b");
  const C = await activeSeller(w, "inv-r301-c");
  assert.ok(A.sellerId < B.sellerId && B.sellerId < C.sellerId, "the beneficiaries' ids ascend in creation order");
  const shares = [
    { seller: A, shareBps: 1000 },
    { seller: B, shareBps: 1400 },
    { seller: C, shareBps: 7600 },
  ];
  const r301 = await acquired(w, "INV R3-01", shares);
  const splitOf = (pool: bigint) => allocatePool(pool, shares.map((s) => ({ sellerId: s.seller.sellerId, shareBps: s.shareBps })));
  const lines = (pool: bigint) => shares.map((s) => ({ sellerId: s.seller.sellerId, entitlementId: r301.entitlements.get(s.seller.sellerId)!, shareBps: s.shareBps, cents: Number(splitOf(pool).get(s.seller.sellerId)!) }));
  assert.deepEqual([27n, 26n, 25n].map((p) => shares.map((s) => Number(splitOf(p).get(s.seller.sellerId)))), [[3, 4, 20], [2, 4, 20], [3, 3, 19]]);
  const x = await accrue(w, r301.ag, r301.first, r301.allocationId, { rateKind: "FIRST", rateBps: 1000, basisCents: 270, poolCents: 27, sequence: 1 }, lines(27n));
  const y = await purchase(w, r301.ag, "inv-r301-second", { qualifying: [r301.first.projectId], client: 1 });
  const yPool = await accrue(w, r301.ag, y, r301.allocationId, { rateKind: "REPEAT", rateBps: 400, basisCents: 123025, poolCents: 4921, sequence: 2 }, lines(4921n));
  const aPaidLine = x.lineOf.get(A.sellerId)!;
  const aLater = yPool.lineOf.get(A.sellerId)!;
  await payLines(w, r301.ag, r301.first, september26, [{ seller: A, lineId: aPaidLine }]);
  await completion(w, r301.ag, y, "FINAL");
  await funds(w, r301.ag, y, "AVAILABLE", 2);
  await makeEligible(w, aLater);
  await basisChange(r301.ag, r301.first.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 260n }, A.agreementVersion);
  await offset(A, aPaidLine, aLater, 1);
  await basisChange(r301.ag, r301.first.captureId, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 250n }, A.agreementVersion);
  const chain = await w.h.oracle.query<{ adjustment_id: string; seq: number; direction: string; amount: number; to: number }>(
    "SELECT adjustment_id, adjustment_seq AS seq, direction, amount_cents::int AS amount, new_cumulative_entitlement_cents::int AS to FROM kauro.commission_adjustments WHERE line_id = $1 ORDER BY adjustment_seq",
    [aPaidLine],
  );
  assert.deepEqual(chain.rows.map((r) => [r.seq, r.direction, r.amount, r.to]), [[1, "DECREASE", 1, 2], [2, "INCREASE", 1, 3]], "the falling basis raised the 1000-bps line by one legal cent");
  await assertInvariants(w.h.oracle, { label: "R3-01 one-cent INCREASE after an offset" });

  // --- a HELD line beside its RELEASED hold: the release unit committed, the ELIGIBLE unit not yet (S-13 legal interval) ---
  const H = await activeSeller(w, "inv-held");
  const heldAg = await acquiredAt("INV HELD", H, { firstBps: 1000, repeatBps: 400 });
  const { lineId: heldLine } = await recordAccruedLine(w.h, { agencyId: heldAg.ag.agencyId, authorizationId: heldAg.first.authorizationId, captureId: heldAg.first.captureId, allocationId: heldAg.allocationId, entitlementId: heldAg.entitlementId, sellerId: H.sellerId, rateKind: "FIRST", rateBps: 1000, basisCents: 97125n, poolCents: 9713n });
  const hold = await recordHold(w.h, { ownerUserId: w.kora, lineId: heldLine, amountCents: 9713n, reason: "FUNDS_HELD" });
  await within(w.commission, service(heldAg.ag.agencyId), async (c) => {
    const ledger = new PgCommissionLedgerRepository(c, ids);
    const line = (await ledger.lockLine(heldLine as CommissionLineId))!;
    assert.equal((await ledger.transitionLine(heldLine as CommissionLineId, line.version, { state: "HELD" }, clock.now())).kind, "APPLIED");
  });
  await within(w.commission, service(heldAg.ag.agencyId), async (c) => {
    const done = await new PgCommissionLedgerRepository(c, ids).resolveHold(hold.holdId, 1, "RELEASED", clock.now());
    assert.equal(done.kind, "APPLIED");
  });
  assert.deepEqual(await oneRow("SELECT l.state, h.state AS hold FROM kauro.commission_lines l JOIN kauro.commission_holds h ON h.line_id = l.line_id WHERE l.line_id = $1", [heldLine]), { state: "HELD", hold: "RELEASED" });

  // every positive control together, timed (design section 7: the oracle reads in tens of milliseconds)
  const started = performance.now();
  await assertInvariants(w.h.oracle, { label: "all positive controls" });
  t.diagnostic(`oracle over the positive controls: ${(performance.now() - started).toFixed(1)} ms for ${B10_INVARIANTS.length} invariants`);

  const wholeItem = items.rows.find((i) => i.line_id === L2 && i.item_kind === "LINE")!.item_id;
  const offsetItem = laterItems.rows.find((i) => i.item_kind === "OFFSET")!.item_id;
  const adjustmentSeq2 = chain.rows.find((r) => r.seq === 2)!.adjustment_id;
  built = {
    r102: { statementId: r102.statementId, disputedLine: L1, wholeLine: L2, wholeItem },
    r104: { repeatLine, firstLine, intentId: paid.get(T.sellerId)!.intentId, laterStatement: later.statementId, offsetItem, offsetLineItem: laterItems.rows.find((i) => i.item_kind === "LINE")!.item_id },
    r301: { allocationId: r301.allocationId, a: A, aPaidLine, adjustmentSeq2 },
    held: { lineId: heldLine },
  };
});

/**
 * Forges a state as the superuser inside a transaction that is rolled back (triggers off: session_replication_role = replica) and
 * requires `id` among the invariants firing on it; the others the forgery also violates are reported. `why`: the branch of a multi-branch
 * invariant the forgery is for — the rows the invariant returns must carry that branch's own text (not just fire on some other branch).
 */
/** The branches (an invariant's `whys`, or the sole condition) whose negative control ran to its assertion, by invariant id. */
const controlled = new Map<string, Set<string>>();
const SOLE = "(sole condition)";
function assertEveryBranchControlled(): void {
  const missing: string[] = [];
  for (const inv of B10_INVARIANTS) {
    for (const branch of inv.whys ?? [SOLE]) if (!(controlled.get(inv.id)?.has(branch) ?? false)) missing.push(`${inv.id} [${branch}]`);
  }
  assert.deepEqual(missing, [], "every branch of every B10 invariant has a negative control that ran in this file");
  assert.deepEqual([...controlled.keys()].filter((id) => !B10_INVARIANTS.some((i) => i.id === id)), [], "no control for an invariant that does not exist");
}

async function forged(t: TestContext, id: string, forge: (c: Client) => Promise<void>, why?: string): Promise<void> {
  const o = w.h.oracle;
  const inv = B10_INVARIANTS.find((i) => i.id === id);
  assert.ok(inv !== undefined, `${id} is a B10 invariant`);
  assert.ok(why === undefined ? inv.whys === undefined : true, `${id} has several branches: the control names the one it is for`);
  await o.query("BEGIN");
  try {
    await o.query("SET LOCAL session_replication_role = replica");
    await forge(o);
    const fired = await firing(o);
    assert.ok(fired.includes(id), `${id} fires on its forged state (fired: ${fired.join(", ") || "none"})`);
    if (why !== undefined) {
      assert.ok(inv.whys?.includes(why), `${id} declares the branch "${why}"`);
      const branch = await o.query(`SELECT * FROM (${inv.sql}) violation WHERE violation.why = $1 LIMIT 1`, [why]);
      assert.equal(branch.rows.length, 1, `${id} returns its branch "${why}" on its forged state (fired: ${fired.join(", ")})`);
    }
    controlled.set(id, (controlled.get(id) ?? new Set<string>()).add(why ?? SOLE));
    t.diagnostic(`${id}${why !== undefined ? ` [${why}]` : ""} fires; also firing on the same forged state: ${fired.filter((f) => f !== id).join(", ") || "none"}`);
  } finally {
    await o.query("ROLLBACK");
  }
  assert.deepEqual(await firing(o), [], "the rollback restored a state on which nothing fires");
}
/** `rows`: the exact count the forgery writes; -1: at least one (a forgery over every row of a kind). */
const exec = async (c: Client, sql: string, params: ReadonlyArray<unknown> = [], rows = 1): Promise<void> => {
  const r = await c.query(sql, [...params]);
  if (rows < 0) assert.ok((r.rowCount ?? 0) >= 1, `the forgery wrote a row: ${sql}`);
  else assert.equal(r.rowCount, rows, `the forgery wrote ${rows} row(s): ${sql}`);
};

/** A settlement posting entry written as the superuser with triggers off (no settlement row is needed then): the ledger's base fact. */
const entry = (c: Client, e: { readonly id: string; readonly event: string; readonly lineNo: number; readonly account: string; readonly direction: "DEBIT" | "CREDIT"; readonly cents: number; readonly reverses?: string }) =>
  exec(
    c,
    `INSERT INTO kauro.ledger_entries (entry_id, settlement_id, line_no, account_code, account_version, direction, amount_cents, currency, source_kind, source_ref, reverses_entry_id, effective_at, observed_at, posted_at, evidence_hash, policy_version)
     VALUES ($1, $2, $3, $4, 'V1', $5, $6, 'USD', 'SETTLEMENT', $2, $7, now(), now(), now(), repeat('a', 64), 'R2-INITIAL')`,
    [e.id, e.event, e.lineNo, e.account, e.direction, e.cents, e.reverses ?? null],
  );

test("INV-L-01 fires on a posting set that does not balance", (t) =>
  forged(t, "INV-L-01", async (c) => {
    const event = ids.next();
    await entry(c, { id: ids.next(), event, lineNo: 1, account: "BANK_CASH", direction: "DEBIT", cents: 100 });
    await entry(c, { id: ids.next(), event, lineNo: 2, account: "OWNER_CONTRIBUTION", direction: "CREDIT", cents: 99 });
  }));

test("INV-L-02 fires on a reversal that is not the mirror of its entry (balanced, on another account)", (t) =>
  forged(
    t,
    "INV-L-02",
    async (c) => {
      const event = ids.next();
      const reversed = ids.next();
      await entry(c, { id: reversed, event, lineNo: 1, account: "BANK_CASH", direction: "DEBIT", cents: 100 });
      await entry(c, { id: ids.next(), event, lineNo: 2, account: "OWNER_CONTRIBUTION", direction: "CREDIT", cents: 100, reverses: reversed });
    },
    "not a mirror",
  ));

test("INV-L-02 fires on an entry reversed twice (each reversal a mirror)", (t) =>
  forged(
    t,
    "INV-L-02",
    async (c) => {
      // the unique index ledger_entries_reversed_once (mig 0017) stands in the way of a second reversal: dropped inside the rolled-back forgery
      await c.query("DROP INDEX kauro.ledger_entries_reversed_once");
      const event = ids.next();
      const original = ids.next();
      await entry(c, { id: original, event, lineNo: 1, account: "BANK_CASH", direction: "DEBIT", cents: 100 });
      await entry(c, { id: ids.next(), event, lineNo: 2, account: "OWNER_CONTRIBUTION", direction: "CREDIT", cents: 100 });
      const back = ids.next();
      await entry(c, { id: ids.next(), event: back, lineNo: 1, account: "BANK_CASH", direction: "CREDIT", cents: 100, reverses: original });
      await entry(c, { id: ids.next(), event: back, lineNo: 2, account: "BANK_CASH", direction: "CREDIT", cents: 100, reverses: original });
    },
    "entry reversed more than once",
  ));

test("INV-S-01 fires on Codex r2 R4's item: payable 200 on a cumulative of 100", (t) =>
  forged(t, "INV-S-01", (c) => exec(c, "UPDATE kauro.statement_items SET cumulative_cents = 100, previously_paid_cents = 0, offset_cents = 0, payable_cents = 200 WHERE item_id = $1", [b().r102.wholeItem]), "payable not derived"));

test("INV-S-01 fires on a HOLD item of a line its statement does not itemize", (t) =>
  forged(t, "INV-S-01", (c) => exec(c, "DELETE FROM kauro.statement_items WHERE statement_id = $1 AND item_kind = 'LINE' AND line_id = $2", [b().r102.statementId, b().r102.disputedLine]), "HOLD item of a line the statement does not itemize"));

test("INV-S-02 fires on a statement whose payable is not its items' sum", (t) =>
  forged(t, "INV-S-02", (c) => exec(c, "UPDATE kauro.commission_statements SET payable_cents = payable_cents + 1 WHERE statement_id = $1", [b().r102.statementId])));

test("INV-S-02 fires on a statement whose held total is not its items' sum", (t) =>
  forged(t, "INV-S-02", (c) => exec(c, "UPDATE kauro.commission_statements SET held_cents = held_cents + 1 WHERE statement_id = $1", [b().r102.statementId])));

test("INV-S-03 fires on an intent that pays other than its statement's payable", (t) =>
  forged(t, "INV-S-03", (c) => exec(c, "UPDATE kauro.payout_intents SET amount_cents = amount_cents + 1 WHERE intent_id = $1", [b().r104.intentId])));

test("INV-S-04 fires on a second live intent of one statement", (t) =>
  forged(t, "INV-S-04", async (c) => {
    await c.query("DROP INDEX kauro.payout_intents_one_live_per_statement");
    const id = ids.next();
    await exec(
      c,
      "INSERT INTO kauro.payout_intents SELECT (jsonb_populate_record(NULL::kauro.payout_intents, to_jsonb(p) || jsonb_build_object('intent_id', $1::text, 'reference', 'kauro-payout-' || $1::text))).* FROM kauro.payout_intents p WHERE p.intent_id = $2",
      [id, b().r104.intentId],
    );
  }));

test("INV-S-05 fires on a SETTLED intent whose statement is not PAID (money: a payout settled for a statement still unpaid)", (t) =>
  forged(t, "INV-S-05", (c) => exec(c, "UPDATE kauro.commission_statements SET state = 'APPROVED', paid_at = NULL, payout_evidence_hash = NULL WHERE statement_id = (SELECT statement_id FROM kauro.payout_intents WHERE intent_id = $1)", [b().r104.intentId]), "SETTLED intent of a statement not PAID"));

test("INV-S-05 fires on a PAID statement without exactly one SETTLED intent (money: paid with no settled payout)", (t) =>
  forged(t, "INV-S-05", (c) => exec(c, "UPDATE kauro.payout_intents SET state = 'RETURNED', settled_at = NULL, returned_at = now() WHERE intent_id = $1", [b().r104.intentId]), "PAID statement without exactly one SETTLED intent"));

test("INV-S-05 fires on a line whose paid cents are not its paid statements' payable items", (t) =>
  forged(t, "INV-S-05", (c) => exec(c, "UPDATE kauro.commission_lines SET paid_cents = paid_cents + 1 WHERE line_id = $1", [b().r104.repeatLine]), "line paid cents not its paid items"));

test("INV-S-06 fires on a line itemized PAYABLE by two statements not CORRECTED", (t) =>
  forged(t, "INV-S-06", (c) =>
    exec(
      c,
      "INSERT INTO kauro.statement_items SELECT (jsonb_populate_record(NULL::kauro.statement_items, to_jsonb(i) || jsonb_build_object('item_id', $1::text, 'statement_id', $2::text, 'item_no', 99))).* FROM kauro.statement_items i WHERE i.item_id = $3",
      [ids.next(), b().r104.laterStatement, b().r102.wholeItem],
    )));

test("INV-S-07 fires on an OFFSET item whose offset differs from its durable offset", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.statement_items SET offset_cents = offset_cents + 1 WHERE item_id = $1", [b().r104.offsetItem]), "OFFSET item not its offset"));

const UNDER_TERMS = "offset not under the negative line's signed future-offset terms";
test("INV-S-07 fires on an offset whose agreement carries no signed SIGNED_FUTURE_OFFSET terms", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.seller_agreements SET offset_terms = 'NONE' WHERE agreement_id = $1", [b().r301.a.agreementId]), UNDER_TERMS));

test("INV-S-07 fires on an offset whose agreement was never signed", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.seller_agreements SET signed_at = NULL, signature_evidence_hash = NULL WHERE agreement_id = $1", [b().r301.a.agreementId]), UNDER_TERMS));

test("INV-S-07 fires on an offset recorded under another agreement than its negative line's entitlement", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.commission_offsets SET agreement_id = gen_random_uuid() WHERE seller_id = $1", [b().r301.a.sellerId]), UNDER_TERMS));

test("INV-S-07 fires on a payable item offsetting more than the durable offsets against its line (money: more taken off than owed)", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.statement_items SET offset_cents = offset_cents + 1 WHERE item_id = $1", [b().r104.offsetLineItem]), "payable item offsets beyond the durable offsets against its line"));

/** Codex r2 R3's agreed-correction chain raising a line 1000 cents. */
async function raiseByAgreedCorrections(c: Client): Promise<void> {
  const line = b().r102.wholeLine;
  for (const [seq, from, to] of [[1, 50000, 50500], [2, 50500, 51000]] as const) {
    await exec(
      c,
      `INSERT INTO kauro.commission_adjustments (adjustment_id, agency_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents, new_cumulative_entitlement_cents, new_basis_cents, source_event_id, agreement_version, created_at)
       SELECT $1, l.agency_id, l.line_id, l.seller_id, $2, 'AGREED_ERROR_CORRECTION', 'INCREASE', $4::bigint - $3::bigint, $3, $4, l.net_service_basis_cents, $5, 'V1', now() FROM kauro.commission_lines l WHERE l.line_id = $6`,
      [ids.next(), seq, from, to, ids.next(), line],
    );
  }
  await exec(c, "UPDATE kauro.commission_lines SET cumulative_entitlement_cents = 51000 WHERE line_id = $1", [line]);
}

test("INV-S-08 fires on Codex r2 R3's agreed-correction chain raising a line 1000 cents (the line is not its share of the pool)", (t) => forged(t, "INV-S-08", raiseByAgreedCorrections, "line not its share of the pool"));

test("INV-S-08 fires on a pool whose cents are not its basis rounded once", (t) =>
  forged(t, "INV-S-08", (c) => exec(c, "UPDATE kauro.commission_pools p SET pool_cents = pool_cents + 1 FROM kauro.commission_lines l WHERE l.pool_id = p.pool_id AND l.line_id = $1", [b().r104.firstLine]), "pool not rounded once"));

test("INV-S-09 fires on an agreed correction that increases (the same chain)", (t) => forged(t, "INV-S-09", raiseByAgreedCorrections, "agreed correction that increases"));

test("INV-S-09 fires on an agreed correction beyond the line's UPHELD holds (money: a decrease no reviewed decision upheld)", (t) =>
  forged(
    t,
    "INV-S-09",
    (c) =>
      exec(
        c,
        `INSERT INTO kauro.commission_adjustments (adjustment_id, agency_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents, new_cumulative_entitlement_cents, new_basis_cents, source_event_id, agreement_version, created_at)
         SELECT $1, l.agency_id, l.line_id, l.seller_id, 1, 'AGREED_ERROR_CORRECTION', 'DECREASE', 1, l.cumulative_entitlement_cents, l.cumulative_entitlement_cents - 1, l.net_service_basis_cents, $2, 'V1', now() FROM kauro.commission_lines l WHERE l.line_id = $3`,
        [ids.next(), ids.next(), b().r102.wholeLine],
      ),
    "agreed corrections beyond the upheld holds",
  ));

test("INV-S-09 fires on a refund or reversal that is not the split at its new basis (money: a line posted at another cumulative than its basis gives)", (t) =>
  forged(t, "INV-S-09", (c) => exec(c, "UPDATE kauro.commission_adjustments SET new_basis_cents = new_basis_cents + 1000 WHERE adjustment_id = $1", [b().r301.adjustmentSeq2]), "refund or reversal not the split at its new basis"));

test("INV-S-09 fires on a SPLIT_CORRECTION, which has no B10 writer", (t) =>
  forged(t, "INV-S-09", (c) => exec(c, "UPDATE kauro.commission_adjustments SET reason = 'SPLIT_CORRECTION' WHERE adjustment_id = $1", [b().r301.adjustmentSeq2]), "SPLIT_CORRECTION has no B10 writer"));

test("INV-S-10 fires on a first adjustment that does not start at the split of the initial basis", (t) =>
  forged(t, "INV-S-10", (c) => exec(c, "UPDATE kauro.commission_adjustments SET previous_cumulative_cents = previous_cumulative_cents + 1 WHERE line_id = $1 AND adjustment_seq = 1", [b().r301.aPaidLine]), "first adjustment not from the initial split"));

test("INV-S-10 fires on an adjustment that does not start where the last one ended", (t) =>
  forged(t, "INV-S-10", (c) => exec(c, "UPDATE kauro.commission_adjustments SET previous_cumulative_cents = previous_cumulative_cents + 1 WHERE adjustment_id = $1", [b().r301.adjustmentSeq2]), "adjustment not from the prior one's new cumulative"));

test("INV-S-10 fires on an adjustment whose new cumulative is not the previous moved by its amount", (t) =>
  forged(t, "INV-S-10", (c) => exec(c, "UPDATE kauro.commission_adjustments SET amount_cents = amount_cents + 1 WHERE adjustment_id = $1", [b().r301.adjustmentSeq2]), "new cumulative not previous moved by the amount"));

test("INV-S-10 fires on a last adjustment that is not the line's cumulative", (t) =>
  forged(t, "INV-S-10", (c) => exec(c, "UPDATE kauro.commission_lines SET cumulative_entitlement_cents = cumulative_entitlement_cents + 1 WHERE line_id = $1", [b().r301.aPaidLine]), "last adjustment not the line's cumulative"));

test("INV-S-11 fires on a frozen allocation whose shares do not sum to 10000 bps", (t) =>
  forged(t, "INV-S-11", (c) => exec(c, "UPDATE kauro.allocation_shares SET share_bps = share_bps - 1 WHERE allocation_id = $1 AND seller_id = $2", [b().r301.allocationId, b().r301.a.sellerId])));

/** A live reservation of a made-up agency and quote (the foreign keys stand off with the triggers) on slot 1 of the policy. */
const reservation = (c: Client): Promise<void> =>
  exec(
    c,
    "INSERT INTO kauro.founding_slot_reservations (reservation_id, agency_id, quote_id, policy_version, slot_no, version, state, ends_at, created_at, updated_at) VALUES ($1, $2, $3, 'R2-INITIAL', 1, 1, 'RESERVED', now(), now(), now())",
    [ids.next(), ids.next(), ids.next()],
  );

test("INV-S-12 fires on live reservations above the policy's slots", (t) =>
  forged(
    t,
    "INV-S-12",
    async (c) => {
      await reservation(c);
      await exec(c, "DELETE FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL'", [], -1);
    },
    "live reservations above the slots",
  ));

test("INV-S-12 fires on a live reservation that is on no slot of its agency", (t) => forged(t, "INV-S-12", reservation, "live reservation not on exactly one slot of its agency"));

test("INV-S-12 fires on a founding slot held for a reservation that is not live", (t) =>
  forged(
    t,
    "INV-S-12",
    (c) =>
      exec(c, "UPDATE kauro.founding_slots SET held = true, live_reservation_id = $1, live_agency_id = (SELECT min(agency_id::text)::uuid FROM kauro.agencies) WHERE slot_no = (SELECT min(slot_no) FROM kauro.founding_slots WHERE live_reservation_id IS NULL AND policy_version = 'R2-INITIAL') AND policy_version = 'R2-INITIAL'", [ids.next()]),
    "slot names a reservation that is not live in its agency",
  ));

test("INV-S-13 fires on a HELD line with no hold row", (t) =>
  forged(t, "INV-S-13", (c) => exec(c, "UPDATE kauro.commission_lines SET state = 'HELD' WHERE line_id = $1", [b().r102.wholeLine])));

test("INV-S-14 fires on a pool with no line", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "DELETE FROM kauro.commission_lines WHERE line_id = $1", [b().r102.wholeLine]), "pool with no line"));

test("INV-S-14 fires on a claim entitlement whose claim is not CONVERTED", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "UPDATE kauro.attribution_claims SET state = 'ACCEPTED', converted_at = NULL WHERE claim_id = (SELECT claim_id FROM kauro.commission_entitlements WHERE claim_id IS NOT NULL ORDER BY entitlement_id LIMIT 1)", []), "claim entitlement whose claim is not CONVERTED"));

test("INV-S-14 fires on a CONVERTED claim without an entitlement", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "DELETE FROM kauro.commission_entitlements WHERE entitlement_id = (SELECT entitlement_id FROM kauro.commission_entitlements WHERE claim_id IS NOT NULL ORDER BY entitlement_id LIMIT 1)", []), "CONVERTED claim without an entitlement"));

test("INV-S-14 fires on a first qualifying purchase whose capture the first designation does not name", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "DELETE FROM kauro.agency_recurrence WHERE agency_id = (SELECT agency_id FROM kauro.qualifying_purchases WHERE confirmation_seq = 1 ORDER BY authorization_id LIMIT 1)", []), "first qualifying purchase without the first designation naming its capture"));

test("INV-S-14 fires on an agencies mirror that is not the first designation", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "UPDATE kauro.agencies SET first_qualifying_capture_id = gen_random_uuid() WHERE agency_id = (SELECT agency_id FROM kauro.agencies ORDER BY agency_id LIMIT 1)", []), "agencies mirror neither NULL nor the first designation"));

test("INV-S-14 fires on a paid purchase with two non-REVOKED authorizations", (t) =>
  forged(
    t,
    "INV-S-14",
    async (c) => {
      // a second, re-bound authorization of the purchase's capture: the unique indexes commercial_authorizations_one_live_per_capture and _one_live_per_project (mig 0015) stand in its way, dropped inside the rolled-back forgery
      await c.query("DROP INDEX kauro.commercial_authorizations_one_live_per_capture");
      await c.query("DROP INDEX kauro.commercial_authorizations_one_live_per_project");
      await exec(
        c,
        "INSERT INTO kauro.commercial_authorizations SELECT (jsonb_populate_record(NULL::kauro.commercial_authorizations, to_jsonb(a) || jsonb_build_object('authorization_id', $1::text, 'quote_id', $2::text, 'rebinding_id', $3::text))).* FROM kauro.commercial_authorizations a WHERE a.state <> 'REVOKED' AND a.capture_id IS NOT NULL ORDER BY a.authorization_id LIMIT 1",
        [ids.next(), ids.next(), ids.next()],
      );
    },
    "paid purchase with two non-REVOKED authorizations",
  ));

test("INV-S-14 fires on a CORRECTED statement whose intent is neither FAILED nor RETURNED (money: a superseded statement still paying)", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "UPDATE kauro.commission_statements SET state = 'CORRECTED', corrected_at = now(), paid_at = NULL, payout_evidence_hash = NULL WHERE statement_id = (SELECT statement_id FROM kauro.payout_intents WHERE intent_id = $1)", [b().r104.intentId]), "CORRECTED statement with an intent not FAILED or RETURNED"));

test("INV-S-14 fires on a predecessor statement with two successors", (t) =>
  forged(t, "INV-S-14", async (c) => {
    // commission_statements_one_correction (mig 0031) keeps one successor per statement: dropped inside the rolled-back forgery
    await c.query("DROP INDEX kauro.commission_statements_one_correction");
    await exec(c, "UPDATE kauro.commission_statements SET corrects_statement_id = (SELECT min(statement_id::text)::uuid FROM kauro.commission_statements WHERE statement_id NOT IN ($1, $2)) WHERE statement_id IN ($1, $2)", [b().r102.statementId, b().r104.laterStatement], 2);
  }, "predecessor with two successors"));

test("the oracle runs once more in the file's after hook: an effect that settles after the last test's afterEach is still judged", async () => {
  const registered: { afterEach: Array<(t: { readonly name: string }) => Promise<void>>; after: Array<() => Promise<void>> } = { afterEach: [], after: [] };
  const hooks: InvariantHooks = { afterEach: (hook) => void registered.afterEach.push(hook), after: (hook) => void registered.after.push(hook) };
  // a stand-in oracle: every invariant returns one row once `violating` is set (a violation committed after the last test's hook ran)
  let violating = false;
  const oracle = { query: async (sql: string) => ({ rows: violating && sql.startsWith("SELECT * FROM (") ? [{ ref: "late" }] : [] }) } as unknown as Client;
  invariantsAfterEach(() => oracle, hooks);
  assert.equal(registered.afterEach.length, 1, "the per-test hook");
  assert.equal(registered.after.length, 1, "the file-level hook");
  await registered.afterEach[0]!({ name: "the last test" });
  await registered.after[0]!();
  violating = true;
  await assert.rejects(registered.after[0]!(), /B10 state invariants violated after the end of the file/);
});

test("every UNION ALL branch of an invariant is named in its whys (a branch added without its name and control would escape)", () => {
  for (const inv of B10_INVARIANTS) {
    const branches = (inv.sql.match(/UNION ALL/g) ?? []).length + 1;
    assert.equal(inv.whys?.length ?? 1, branches, `${inv.id}: ${branches} branch(es) in its SQL`);
    if (inv.whys !== undefined) assert.equal(new Set(inv.whys).size, inv.whys.length, `${inv.id}: the names are distinct`);
  }
});
