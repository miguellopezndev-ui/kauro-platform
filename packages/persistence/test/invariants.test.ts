// The self-test of the B10 state oracle (@kauro/persistence/testing invariants.ts; docs/design/B10-KIT-SUITES.md section 2.1). Positive
// controls first, built through the runtime roles exactly as the ledger tests build them: R2-102 (a partial hold withheld by its
// statement), R2-104 (a paid line refunded below what was paid: a negative balance) with example 7's offset under signed
// SIGNED_FUTURE_OFFSET terms itemized by a later statement, r3 R3-01 (basis 270 -> 260 -> 250 at shares 1000/1400/7600: the first refund
// decreases the 1000-bps line, which is offset, and the second raises it by one legal cent), and a HELD line beside its RELEASED hold
// (the interval between the release unit and the ELIGIBLE unit); nothing may fire on them. Then one negative control per atomic predicate: a forged
// state that fires that predicate alone among its invariant's branches (or the ones it declares), written as the superuser with triggers off
// (session_replication_role = replica, a unique index dropped where one stands in the
// way) inside a transaction that is rolled back, in which that id must fire; the other ids the forged state also violates are listed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

async function forged(t: TestContext, id: string, forge: (c: Client) => Promise<void>, why?: string, also: ReadonlyArray<string> = []): Promise<void> {
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
      // the forgery forges ONLY its own predicate: no other branch of the invariant fires on it, unless the control declares it (a state
      // that cannot exist without it), so a control never passes on a neighbour's predicate
      const whys = await o.query<{ why: string }>(`SELECT DISTINCT violation.why FROM (${inv.sql}) violation ORDER BY 1`);
      assert.deepEqual(whys.rows.map((r) => r.why), [why, ...also].sort(), `${id}: the forged state fires its branch "${why}"${also.length > 0 ? ` and only the declared ${also.join("; ")}` : " alone"}`);
    } else assert.deepEqual(also, [], `${id} is one predicate: nothing else of it to declare`);
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
const entry = (c: Client, e: { readonly id: string; readonly event: string; readonly lineNo: number; readonly account: string; readonly direction: "DEBIT" | "CREDIT"; readonly cents: number; readonly reverses?: string; readonly currency?: string }) =>
  exec(
    c,
    `INSERT INTO kauro.ledger_entries (entry_id, settlement_id, line_no, account_code, account_version, direction, amount_cents, currency, source_kind, source_ref, reverses_entry_id, effective_at, observed_at, posted_at, evidence_hash, policy_version)
     VALUES ($1, $2, $3, $4, 'V1', $5, $6, $8, 'SETTLEMENT', $2, $7, now(), now(), now(), repeat('a', 64), 'R2-INITIAL')`,
    [e.id, e.event, e.lineNo, e.account, e.direction, e.cents, e.reverses ?? null, e.currency ?? "USD"],
  );

test("INV-L-01 fires on a posting set that does not balance", (t) =>
  forged(t, "INV-L-01", async (c) => {
    const event = ids.next();
    await entry(c, { id: ids.next(), event, lineNo: 1, account: "BANK_CASH", direction: "DEBIT", cents: 100 });
    await entry(c, { id: ids.next(), event, lineNo: 2, account: "OWNER_CONTRIBUTION", direction: "CREDIT", cents: 99 });
  }, "debits and credits differ"));

// the absent side of the balance is its own predicate: a posting set of one direction only (ADV-16)
test("INV-L-01 fires on a posting set of debits with no credit (money: cash in with no source)", (t) =>
  forged(t, "INV-L-01", (c) => entry(c, { id: ids.next(), event: ids.next(), lineNo: 1, account: "BANK_CASH", direction: "DEBIT", cents: 100 }), "debits with no credit"));

test("INV-L-01 fires on a posting set of credits with no debit", (t) =>
  forged(t, "INV-L-01", (c) => entry(c, { id: ids.next(), event: ids.next(), lineNo: 1, account: "OWNER_CONTRIBUTION", direction: "CREDIT", cents: 100 }), "credits with no debit"));

test("INV-L-02 fires on a reversal on another account than its entry (balanced)", (t) =>
  forged(
    t,
    "INV-L-02",
    async (c) => {
      const event = ids.next();
      const reversed = ids.next();
      await entry(c, { id: reversed, event, lineNo: 1, account: "BANK_CASH", direction: "DEBIT", cents: 100 });
      await entry(c, { id: ids.next(), event, lineNo: 2, account: "OWNER_CONTRIBUTION", direction: "CREDIT", cents: 100, reverses: reversed });
    },
    "reversal on another account",
  ));

/** An entry of 100 USD DEBIT on BANK_CASH and its reversal (in a set of its own) changed as `reversal` says: the other facts mirror it. */
const reversalOf = (c: Client, reversal: { readonly currency?: string; readonly cents?: number; readonly direction?: "DEBIT" | "CREDIT"; readonly orphan?: true }) => {
  const original = ids.next();
  const reversed = reversal.orphan === true ? ids.next() : original;
  return (async () => {
    const event = ids.next();
    await entry(c, { id: original, event, lineNo: 1, account: "BANK_CASH", direction: "DEBIT", cents: 100 });
    await entry(c, { id: ids.next(), event, lineNo: 2, account: "OWNER_CONTRIBUTION", direction: "CREDIT", cents: 100 });
    await entry(c, { id: ids.next(), event: ids.next(), lineNo: 1, account: "BANK_CASH", direction: reversal.direction ?? "CREDIT", cents: reversal.cents ?? 100, reverses: reversed, ...(reversal.currency !== undefined ? { currency: reversal.currency } : {}) });
  })();
};

test("INV-L-02 fires on a reversal of an entry that does not exist", (t) => forged(t, "INV-L-02", (c) => reversalOf(c, { orphan: true }), "reversal of no entry"));

test("INV-L-02 fires on a reversal in another currency than its entry (money: a USD entry reversed in EUR)", (t) => forged(t, "INV-L-02", (c) => reversalOf(c, { currency: "EUR" }), "reversal in another currency"));

test("INV-L-02 fires on a reversal of another amount than its entry (money: 100 reversed by 99)", (t) => forged(t, "INV-L-02", (c) => reversalOf(c, { cents: 99 }), "reversal of another amount"));

test("INV-L-02 fires on a reversal in the same direction as its entry (money: a DEBIT doubled instead of undone)", (t) => forged(t, "INV-L-02", (c) => reversalOf(c, { direction: "DEBIT" }), "reversal in the same direction"));

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
  forged(t, "INV-S-01", (c) => exec(c, "UPDATE kauro.statement_items SET cumulative_cents = 100, previously_paid_cents = 0, offset_cents = 0, payable_cents = 200 WHERE item_id = $1", [b().r102.wholeItem]), "payable not derived (its line has no HOLD item)"));

test("INV-S-01 fires on a payable item whose derivation is negative, its payable equal to it (money: an item that takes from the seller)", (t) =>
  forged(
    t,
    "INV-S-01",
    async (c) => {
      // the column's own money check (statement_items_payable_cents_check) stands in the way of a negative payable: dropped inside the rolled-back forgery
      await c.query("ALTER TABLE kauro.statement_items DROP CONSTRAINT statement_items_payable_cents_check");
      await exec(c, "UPDATE kauro.statement_items SET cumulative_cents = 100, previously_paid_cents = 0, held_cents = 0, offset_cents = 150, payable_cents = -50 WHERE item_id = $1", [b().r102.wholeItem]);
    },
    "derived payable negative (its line has no HOLD item)",
  ));

/** The R2-102 statement's LINE item of the disputed line, whose 1000-cent hold the same statement withholds as a HOLD item. */
const disputedItem = "statement_id = $1 AND item_kind = 'LINE' AND line_id = $2";

test("INV-S-01 fires on a payable item of a line with HOLD items whose payable is not derived net of them (money: the held cents paid too)", (t) =>
  forged(t, "INV-S-01", (c) => exec(c, `UPDATE kauro.statement_items SET payable_cents = payable_cents + 1 WHERE ${disputedItem}`, [b().r102.statementId, b().r102.disputedLine]), "payable not derived (its line has HOLD items)"));

test("INV-S-01 fires on a payable item of a line with HOLD items whose derivation net of them is negative, its payable equal to it", (t) =>
  forged(
    t,
    "INV-S-01",
    async (c) => {
      await c.query("ALTER TABLE kauro.statement_items DROP CONSTRAINT statement_items_payable_cents_check");
      // cumulative 100, the statement's HOLD item withholds 1000 of the line: derived 100 - 1000 = -900
      await exec(c, `UPDATE kauro.statement_items SET cumulative_cents = 100, previously_paid_cents = 0, held_cents = 0, offset_cents = 0, payable_cents = -900 WHERE ${disputedItem}`, [b().r102.statementId, b().r102.disputedLine]);
    },
    "derived payable negative (its line has HOLD items)",
  ));

test("INV-S-01 fires on a PAYABLE line item without a cumulative (the absent case is not read as zero)", (t) =>
  forged(t, "INV-S-01", (c) => exec(c, "UPDATE kauro.statement_items SET cumulative_cents = NULL WHERE item_id = $1", [b().r102.wholeItem]), "PAYABLE line item without a cumulative"));

test("INV-S-01 fires on a PAYABLE line item without its previously paid (the absent case is not read as zero)", (t) =>
  forged(t, "INV-S-01", (c) => exec(c, "UPDATE kauro.statement_items SET previously_paid_cents = NULL WHERE item_id = $1", [b().r102.wholeItem]), "PAYABLE line item without its previously paid"));

test("INV-S-01 fires on a HOLD item of a line its statement does not itemize", (t) =>
  forged(t, "INV-S-01", (c) => exec(c, "DELETE FROM kauro.statement_items WHERE statement_id = $1 AND item_kind = 'LINE' AND line_id = $2", [b().r102.statementId, b().r102.disputedLine]), "HOLD item of a line the statement does not itemize"));

test("INV-S-01 fires on a HOLD item whose hold row is absent (not a line the statement fails to itemize)", (t) =>
  forged(
    t,
    "INV-S-01",
    // statement_items_hold_fk (mig 0031: FOREIGN KEY (hold_id, seller_id) REFERENCES commission_holds) keeps a HOLD item on a real hold: its
    // trigger stands off under session_replication_role = replica, as the forged state needs. The item's hold no longer joins, so its line
    // loses its derived HOLD sum, which the control declares (a state that cannot exist without it)
    (c) => exec(c, "UPDATE kauro.statement_items SET hold_id = gen_random_uuid() WHERE statement_id = $1 AND item_kind = 'HOLD'", [b().r102.statementId]),
    "HOLD item with no hold row",
    ["payable not derived (its line has no HOLD item)"],
  ));

test("INV-S-02 fires on a statement whose payable is not its items' sum", (t) =>
  forged(t, "INV-S-02", (c) => exec(c, "UPDATE kauro.commission_statements SET payable_cents = payable_cents + 1 WHERE statement_id = $1", [b().r102.statementId]), "payable total not its items' sum"));

test("INV-S-02 fires on a statement whose held total is not its items' sum", (t) =>
  forged(t, "INV-S-02", (c) => exec(c, "UPDATE kauro.commission_statements SET held_cents = held_cents + 1 WHERE statement_id = $1", [b().r102.statementId]), "held total not its items' sum"));

test("INV-S-02 fires on a statement with no item and a payable total (money: a payout with nothing itemized)", (t) =>
  forged(t, "INV-S-02", async (c) => {
    await exec(c, "DELETE FROM kauro.statement_items WHERE statement_id = $1", [b().r102.statementId], -1);
    await exec(c, "UPDATE kauro.commission_statements SET held_cents = 0 WHERE statement_id = $1", [b().r102.statementId]);
  }, "payable total of a statement with no item"));

test("INV-S-02 fires on a statement with no item and a held total", (t) =>
  forged(t, "INV-S-02", async (c) => {
    await exec(c, "DELETE FROM kauro.statement_items WHERE statement_id = $1", [b().r102.statementId], -1);
    await exec(c, "UPDATE kauro.commission_statements SET payable_cents = 0 WHERE statement_id = $1", [b().r102.statementId]);
  }, "held total of a statement with no item"));

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

/** A copy of R2-104's SETTLED intent under a new id and reference, with the columns given changed. */
const copyIntent = (c: Client, change: Readonly<Record<string, string>>): Promise<void> => {
  const id = ids.next();
  return exec(
    c,
    "INSERT INTO kauro.payout_intents SELECT (jsonb_populate_record(NULL::kauro.payout_intents, to_jsonb(p) || jsonb_build_object('intent_id', $1::text, 'reference', 'kauro-payout-' || $1::text) || $3::jsonb)).* FROM kauro.payout_intents p WHERE p.intent_id = $2",
    [id, b().r104.intentId, JSON.stringify(change)],
  );
};

test("INV-S-05 fires on a SETTLED intent whose statement is not PAID (money: a payout settled for a statement still unpaid)", (t) =>
  forged(t, "INV-S-05", (c) => copyIntent(c, { statement_id: b().r102.statementId }), "SETTLED intent of a statement not PAID"));

test("INV-S-05 fires on a PAID statement without a SETTLED intent (money: paid with no settled payout)", (t) =>
  forged(t, "INV-S-05", (c) => exec(c, "UPDATE kauro.payout_intents SET state = 'RETURNED', settled_at = NULL, returned_at = now() WHERE intent_id = $1", [b().r104.intentId]), "PAID statement without a SETTLED intent"));

test("INV-S-05 fires on a PAID statement with two SETTLED intents (money: one statement settled twice)", (t) =>
  forged(
    t,
    "INV-S-05",
    async (c) => {
      // payout_intents_one_live_per_statement (mig 0031) keeps one live intent per statement: dropped inside the rolled-back forgery
      await c.query("DROP INDEX kauro.payout_intents_one_live_per_statement");
      await copyIntent(c, {});
    },
    "PAID statement with several SETTLED intents",
  ));

test("INV-S-05 fires on a line whose paid cents are not its paid statements' payable items", (t) =>
  forged(t, "INV-S-05", (c) => exec(c, "UPDATE kauro.commission_lines SET paid_cents = paid_cents + 1 WHERE line_id = $1", [b().r104.repeatLine]), "line paid cents not its paid items"));

test("INV-S-05 fires on a line with paid cents and no paid statement item (money: paid with nothing itemized)", (t) =>
  forged(t, "INV-S-05", (c) => exec(c, "UPDATE kauro.commission_lines SET paid_cents = 100, paid_at = now() WHERE line_id = $1", [b().r102.wholeLine]), "line paid with no paid item"));

test("INV-S-05 fires on a line never paid whose payable item a PAID statement carries (money: a payout the line does not record)", (t) =>
  forged(t, "INV-S-05", (c) => exec(c, "UPDATE kauro.commission_lines SET paid_cents = NULL, paid_at = NULL, state = 'PAYABLE' WHERE line_id = $1", [b().r104.repeatLine]), "line never paid with paid items"));

test("INV-S-06 fires on a line itemized PAYABLE by two statements not CORRECTED", (t) =>
  forged(t, "INV-S-06", (c) =>
    exec(
      c,
      "INSERT INTO kauro.statement_items SELECT (jsonb_populate_record(NULL::kauro.statement_items, to_jsonb(i) || jsonb_build_object('item_id', $1::text, 'statement_id', $2::text, 'item_no', 99))).* FROM kauro.statement_items i WHERE i.item_id = $3",
      [ids.next(), b().r104.laterStatement, b().r102.wholeItem],
    )));

test("INV-S-07 fires on an OFFSET item whose offset differs from its durable offset", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.statement_items SET offset_cents = offset_cents + 1 WHERE item_id = $1", [b().r104.offsetItem]), "OFFSET item not its offset"));

test("INV-S-07 fires on an offset whose agreement carries no signed SIGNED_FUTURE_OFFSET terms", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.seller_agreements SET offset_terms = 'NONE' WHERE agreement_id = $1", [b().r301.a.agreementId]), "offset agreement terms not SIGNED_FUTURE_OFFSET"));

test("INV-S-07 fires on an offset whose agreement was never signed", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.seller_agreements SET signed_at = NULL, signature_evidence_hash = NULL WHERE agreement_id = $1", [b().r301.a.agreementId]), "offset agreement never signed"));

test("INV-S-07 fires on an offset recorded under ANOTHER real, signed SIGNED_FUTURE_OFFSET agreement of the same seller than its negative line's entitlement (KC017 authority)", (t) =>
  forged(
    t,
    "INV-S-07",
    async (c) => {
      const other = ids.next();
      // a second agreement of seller A, a copy of its signed future-offset one under a new id and version
      await exec(
        c,
        "INSERT INTO kauro.seller_agreements SELECT (jsonb_populate_record(NULL::kauro.seller_agreements, to_jsonb(g) || jsonb_build_object('agreement_id', $1::text, 'agreement_version', g.agreement_version || '-OTHER'))).* FROM kauro.seller_agreements g WHERE g.agreement_id = $2",
        [other, b().r301.a.agreementId],
      );
      await exec(c, "UPDATE kauro.commission_offsets SET agreement_id = $1 WHERE seller_id = $2", [other, b().r301.a.sellerId]);
    },
    "offset under another agreement than its negative line's",
  ));

test("INV-S-07 fires on an offset whose agreement does not exist for its seller (its entitlement naming the same missing agreement)", (t) =>
  forged(t, "INV-S-07", async (c) => {
    const missing = ids.next();
    await exec(c, "UPDATE kauro.commission_offsets SET agreement_id = $1 WHERE seller_id = $2", [missing, b().r301.a.sellerId]);
    await exec(c, "UPDATE kauro.commission_entitlements SET agreement_id = $1 WHERE entitlement_id = (SELECT entitlement_id FROM kauro.commission_lines WHERE line_id = $2)", [missing, b().r301.aPaidLine]);
  }, "offset agreement absent for its seller"));

test("INV-S-07 fires on a payable item offsetting more than the durable offsets against its line (money: more taken off than owed)", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.statement_items SET offset_cents = offset_cents + 1 WHERE item_id = $1", [b().r104.offsetLineItem]), "payable item offsets beyond the durable offsets against its line"));

test("INV-S-07 fires on a payable item offsetting a line no durable offset is against (money: taken off with no offset at all)", (t) =>
  forged(t, "INV-S-07", (c) => exec(c, "UPDATE kauro.statement_items SET offset_cents = 50 WHERE item_id = $1", [b().r102.wholeItem]), "payable item offsets a line no offset is against"));

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

/** An AGREED_ERROR_CORRECTION decrease of `cents` posted as seq 1 of a line without moving the line's cumulative. */
const agreedDecrease = (c: Client, lineId: string, cents: number): Promise<void> =>
  exec(
    c,
    `INSERT INTO kauro.commission_adjustments (adjustment_id, agency_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents, new_cumulative_entitlement_cents, new_basis_cents, source_event_id, agreement_version, created_at)
     SELECT $1, l.agency_id, l.line_id, l.seller_id, 1, 'AGREED_ERROR_CORRECTION', 'DECREASE', $3, l.cumulative_entitlement_cents, l.cumulative_entitlement_cents - $3::bigint, l.net_service_basis_cents, $2, 'V1', now() FROM kauro.commission_lines l WHERE l.line_id = $4`,
    [ids.next(), ids.next(), cents, lineId],
  );

/** An UPHELD hold of `cents` on a line (the reviewed decision B12 writes; no B10 writer). */
const upheldHold = (c: Client, lineId: string, cents: number): Promise<void> =>
  exec(
    c,
    `INSERT INTO kauro.commission_holds (hold_id, agency_id, line_id, seller_id, amount_cents, reason, review_at, state, opened_at, upheld_at, created_at, updated_at)
     SELECT $1, l.agency_id, l.line_id, l.seller_id, $2, 'FUNDS_HELD', now() + interval '1 day', 'UPHELD', now(), now(), now(), now() FROM kauro.commission_lines l WHERE l.line_id = $3`,
    [ids.next(), cents, lineId],
  );

test("INV-S-08 fires on Codex r2 R3's agreed-correction chain raising a line 1000 cents (the line is not its share of the pool; an INCREASE is no agreed decrease)", (t) => forged(t, "INV-S-08", raiseByAgreedCorrections, "line not its share of the pool (no agreed correction)"));

test("INV-S-08 fires on a line not its share less its agreed corrections (money: a 1-cent agreed decrease never taken off the line)", (t) =>
  forged(t, "INV-S-08", (c) => agreedDecrease(c, b().r102.wholeLine, 1), "line not its share of the pool less its agreed corrections"));

test("INV-S-08 fires on a pool whose cents are not its basis rounded once", (t) =>
  // the basis moved, the pool kept: the lines are still the split of the pool they were cut from, only the rounding predicate fires
  forged(t, "INV-S-08", (c) => exec(c, "UPDATE kauro.commission_pools p SET basis_cents = basis_cents - 1000 FROM kauro.commission_lines l WHERE l.pool_id = p.pool_id AND l.line_id = $1", [b().r104.firstLine]), "pool not rounded once"));

test("INV-S-09 fires on an agreed correction that increases (the same chain)", (t) => forged(t, "INV-S-09", raiseByAgreedCorrections, "agreed correction that increases"));

test("INV-S-09 fires on an agreed correction on a line with no UPHELD hold (money: a decrease no reviewed decision upheld)", (t) =>
  forged(t, "INV-S-09", (c) => agreedDecrease(c, b().r102.wholeLine, 1), "agreed corrections on a line with no upheld hold"));

test("INV-S-09 fires on agreed corrections beyond the line's UPHELD holds (money: 2 cents taken off on a 1-cent upheld decision)", (t) =>
  forged(t, "INV-S-09", async (c) => {
    await upheldHold(c, b().r102.wholeLine, 1);
    await agreedDecrease(c, b().r102.wholeLine, 2);
  }, "agreed corrections beyond the upheld holds"));

test("INV-S-09 fires on a refund or reversal that is not the split at its new basis (money: a line posted at another cumulative than its basis gives)", (t) =>
  forged(t, "INV-S-09", (c) => exec(c, "UPDATE kauro.commission_adjustments SET new_basis_cents = new_basis_cents + 1000 WHERE adjustment_id = $1", [b().r301.adjustmentSeq2]), "refund or reversal not the split at its new basis (no earlier agreed correction)"));

test("INV-S-09 fires on a refund not the split at its new basis less the line's earlier agreed correction (money: the agreed cent given back by the refund)", (t) =>
  forged(t, "INV-S-09", async (c) => {
    // R3-01's seq 1 (a 1-cent DECREASE) becomes an agreed correction, upheld by a 1-cent hold: seq 2 (REFUND, posted 3) should be 3 - 1 = 2
    await exec(c, "UPDATE kauro.commission_adjustments SET reason = 'AGREED_ERROR_CORRECTION' WHERE line_id = $1 AND adjustment_seq = 1", [b().r301.aPaidLine]);
    await upheldHold(c, b().r301.aPaidLine, 1);
  }, "refund or reversal not the split at its new basis less the earlier agreed corrections"));

test("INV-S-09 fires on a SPLIT_CORRECTION, which has no B10 writer", (t) =>
  forged(t, "INV-S-09", (c) => exec(c, "UPDATE kauro.commission_adjustments SET reason = 'SPLIT_CORRECTION' WHERE adjustment_id = $1", [b().r301.adjustmentSeq2]), "SPLIT_CORRECTION has no B10 writer"));

test("INV-S-10 fires on a first adjustment that does not start at the split of the initial basis", (t) =>
  // seq 1 is a DECREASE: its previous and its amount both one higher still land on its new cumulative, so only the start predicate fires
  forged(t, "INV-S-10", (c) => exec(c, "UPDATE kauro.commission_adjustments SET previous_cumulative_cents = previous_cumulative_cents + 1, amount_cents = amount_cents + 1 WHERE line_id = $1 AND adjustment_seq = 1", [b().r301.aPaidLine]), "first adjustment not from the initial split"));

test("INV-S-10 fires on an adjustment chain that does not start at seq 1 (a gap: seq 2 with seq 1 absent)", (t) =>
  forged(
    t,
    "INV-S-10",
    // the KC015 trigger (mig 0030, ADJUSTMENT_NOT_CUMULATIVE: NEW.adjustment_seq <> latest seq + 1) and the append-only trigger keep a chain
    // gapless in production: both stand off under session_replication_role = replica, so seq 1 can be deleted from under seq 2
    (c) => exec(c, "DELETE FROM kauro.commission_adjustments WHERE adjustment_seq = 1 AND line_id = (SELECT line_id FROM kauro.commission_adjustments WHERE adjustment_id = $1)", [b().r301.adjustmentSeq2]),
    "adjustment chain not starting at seq 1",
  ));

test("INV-S-10 fires on an adjustment that does not start where the last one ended", (t) =>
  // seq 2 is an INCREASE: its previous one lower and its amount one higher still land on its new cumulative, so only the chaining predicate fires
  forged(t, "INV-S-10", (c) => exec(c, "UPDATE kauro.commission_adjustments SET previous_cumulative_cents = previous_cumulative_cents - 1, amount_cents = amount_cents + 1 WHERE adjustment_id = $1", [b().r301.adjustmentSeq2]), "adjustment not from the prior one's new cumulative"));

test("INV-S-10 fires on an adjustment whose new cumulative is not the previous moved by its amount", (t) =>
  forged(t, "INV-S-10", (c) => exec(c, "UPDATE kauro.commission_adjustments SET amount_cents = amount_cents + 1 WHERE adjustment_id = $1", [b().r301.adjustmentSeq2]), "new cumulative not previous moved by the amount"));

test("INV-S-10 fires on a last adjustment that is not the line's cumulative", (t) =>
  forged(t, "INV-S-10", (c) => exec(c, "UPDATE kauro.commission_lines SET cumulative_entitlement_cents = cumulative_entitlement_cents + 1 WHERE line_id = $1", [b().r301.aPaidLine]), "last adjustment not the line's cumulative"));

test("INV-S-11 fires on a frozen allocation whose shares do not sum to 10000 bps", (t) =>
  forged(t, "INV-S-11", (c) => exec(c, "UPDATE kauro.allocation_shares SET share_bps = share_bps - 1 WHERE allocation_id = $1 AND seller_id = $2", [b().r301.allocationId, b().r301.a.sellerId]), "frozen allocation shares not 10000 bps"));

test("INV-S-11 fires on a frozen allocation with no share (the absent sum is its own predicate, not read as zero)", (t) =>
  forged(t, "INV-S-11", (c) => exec(c, "DELETE FROM kauro.allocation_shares WHERE allocation_id = $1", [b().r301.allocationId], -1), "frozen allocation with no share"));

/** A live reservation of a made-up agency and quote (the foreign keys stand off with the triggers) on slot 1 of the policy. */
const reservation = async (c: Client): Promise<{ readonly reservationId: string; readonly agencyId: string }> => {
  const reservationId = ids.next();
  const agencyId = ids.next();
  await exec(
    c,
    "INSERT INTO kauro.founding_slot_reservations (reservation_id, agency_id, quote_id, policy_version, slot_no, version, state, ends_at, created_at, updated_at) VALUES ($1, $2, $3, 'R2-INITIAL', 1, 1, 'RESERVED', now(), now(), now())",
    [reservationId, agencyId, ids.next()],
  );
  return { reservationId, agencyId };
};

test("INV-S-12 fires on live reservations above the policy's slots", (t) =>
  forged(
    t,
    "INV-S-12",
    async (c) => {
      await reservation(c);
      await exec(c, "DELETE FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL'", [], -1);
    },
    "live reservations above the slots",
    // a reservation above every slot is on none of them: the two predicates cannot be forged apart
    ["live reservation on no slot of its agency"],
  ));

test("INV-S-12 fires on a live reservation that is on no slot of its agency", (t) => forged(t, "INV-S-12", (c) => reservation(c).then(() => undefined), "live reservation on no slot of its agency"));

test("INV-S-12 fires on a live reservation that two slots of its agency name (a reservation counted twice against the cap)", (t) =>
  forged(
    t,
    "INV-S-12",
    async (c) => {
      const { reservationId, agencyId } = await reservation(c);
      await exec(
        c,
        "UPDATE kauro.founding_slots SET held = true, live_reservation_id = $1, live_agency_id = $2 WHERE policy_version = 'R2-INITIAL' AND slot_no IN (SELECT slot_no FROM kauro.founding_slots WHERE live_reservation_id IS NULL AND policy_version = 'R2-INITIAL' ORDER BY slot_no LIMIT 2)",
        [reservationId, agencyId],
        2,
      );
    },
    "live reservation on several slots of its agency",
  ));

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

test("INV-S-14 fires on a claim entitlement whose claim does not exist", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "DELETE FROM kauro.attribution_claims WHERE claim_id = (SELECT claim_id FROM kauro.commission_entitlements WHERE claim_id IS NOT NULL ORDER BY entitlement_id LIMIT 1)", []), "claim entitlement whose claim does not exist"));

test("INV-S-14 fires on a CONVERTED claim without an entitlement", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "DELETE FROM kauro.commission_entitlements WHERE entitlement_id = (SELECT entitlement_id FROM kauro.commission_entitlements WHERE claim_id IS NOT NULL ORDER BY entitlement_id LIMIT 1)", []), "CONVERTED claim without an entitlement"));

test("INV-S-14 fires on a first qualifying purchase whose capture the first designation does not name", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "DELETE FROM kauro.agency_recurrence WHERE agency_id = (SELECT agency_id FROM kauro.qualifying_purchases WHERE confirmation_seq = 1 ORDER BY authorization_id LIMIT 1)", []), "first qualifying purchase without the first designation naming its capture"));

test("INV-S-14 fires on an agencies mirror that is not the first designation", (t) =>
  forged(t, "INV-S-14", (c) => exec(c, "UPDATE kauro.agencies SET first_qualifying_capture_id = gen_random_uuid() WHERE agency_id = (SELECT agency_id FROM kauro.agency_recurrence ORDER BY agency_id LIMIT 1)", []), "agencies mirror not the first designation"));

test("INV-S-14 fires on an agencies mirror of an agency with no first designation (the designation's purchase is no longer its first)", (t) =>
  forged(t, "INV-S-14", async (c) => {
    const agencyId = (await c.query<{ agency_id: string }>("SELECT agency_id FROM kauro.agency_recurrence ORDER BY agency_id LIMIT 1")).rows[0]!.agency_id;
    await exec(c, "UPDATE kauro.agencies SET first_qualifying_capture_id = gen_random_uuid() WHERE agency_id = $1", [agencyId]);
    await exec(c, "DELETE FROM kauro.agency_recurrence WHERE agency_id = $1", [agencyId]);
    // the first purchase renumbered, so the forgery fires the mirror predicate alone, not the first purchase's
    await exec(c, "UPDATE kauro.qualifying_purchases SET confirmation_seq = confirmation_seq + 1000 WHERE agency_id = $1", [agencyId], -1);
  }, "agencies mirror without a first designation"));

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

/** The comparison operators a scalar subquery may stand beside (longest first). */
const COMPARISON = /(<>|!=|<=|>=|=|<|>)/;

/**
 * The only CASEs with an ELSE the oracle uses, matched on their ENTIRE body (the SQL with literals blanked), so nothing can ride along:
 * (1) a simple CASE over ch.direction (a NOT NULL column of the chain CTE, bound below) with literal WHEN arms, plain operands and no nested CASE;
 * (2) the split's one-cent bit, exactly as the oracle writes it, over NOT NULL operands (INV-S-08 split CTE).
 */
const DIRECTION_CASE = /^\s*ch\.direction(?:\s+WHEN\s+''\s+THEN\s+-?[\w.]+)+\s+ELSE\s+-?[\w.]+\s*$/i;
const SPLIT_ONE_CENT_CASE = /^\s*WHEN\s+row_number\(\)\s+OVER\s*\(\s*PARTITION\s+BY\s+k\s+ORDER\s+BY\s+rem\s+DESC\s*,\s*seller_id::text\s+COLLATE\s+""\s*\)\s*<=\s*total\s*-\s*sum\(fl\)\s+OVER\s*\(\s*PARTITION\s+BY\s+k\s*\)\s+THEN\s+1\s+ELSE\s+0\s*$/i;

/** The SQL with comments, quoted literals and quoted identifiers blanked: only keywords and operators are left to match, whatever their case or spacing. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** Every CASE ... END, balanced (a nested CASE is its own entry and also part of its parent's body); an unclosed CASE runs to the end. */
function caseBodies(sql: string): string[] {
  const bodies: string[] = [];
  const open: number[] = [];
  for (const m of sql.matchAll(/\b(CASE|END)\b/gi)) {
    if (m[1]!.toUpperCase() === "CASE") open.push(m.index + 4);
    else {
      const start = open.pop();
      if (start !== undefined) bodies.push(sql.slice(start, m.index));
    }
  }
  for (const start of open) bodies.push(sql.slice(start));
  return bodies;
}

/** `ch` is the NOT NULL chain CTE only when it aliases `chain` in FROM or an inner JOIN, and nothing outer-joins or re-aliases it. */
function chBoundToChain(sql: string): boolean {
  const bound = /(?:\bFROM|\bJOIN|,)\s+chain\s+(?:AS\s+)?ch\b/i.test(sql);
  const outer = /\b(?:LEFT|RIGHT|FULL)\s+(?:OUTER\s+)?JOIN\s+(?:[\w.]+|\([\s\S]*?\))\s+(?:AS\s+)?ch\b/i.test(sql);
  const otherTable = [...sql.matchAll(/(?:\bFROM|\bJOIN|,)\s+([\w.]+|\))\s+(?:AS\s+)?ch\b/gi)].some((m) => m[1]!.toLowerCase() !== "chain");
  const nullsTheChain = /\b(?:RIGHT|FULL)\s+(?:OUTER\s+)?JOIN\b/i.test(sql);
  return bound && !outer && !otherTable && !nullsTheChain;
}

/** The balanced "( ... )" starting at sql[open] === "(": its inside, or undefined when unclosed. */
function balanced(sql: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  return undefined;
}

/**
 * Scalar subqueries, as an ALLOWLIST (ADV-22): a "(SELECT" is permitted only (a) directly after EXISTS, IN, FROM, JOIN, LATERAL or AS (a CTE
 * body), where it is a row source and not a value, or (b) when its WHOLE text is exactly one count: count(...) [FILTER (WHERE ...)] FROM
 * <table> [alias] [WHERE ...] (never NULL; no LIMIT, OFFSET, FETCH, set operation, GROUP BY, HAVING, WINDOW or nested parenthesis), optionally
 * cast directly (")::text", ")::bigint"), and then not an operand of arithmetic. Everything else is a value that can be NULL or rewritten.
 */
const COUNT_ONLY = /^SELECT\s+count\s*\([^()]*\)(?:\s+FILTER\s*\(\s*WHERE\s+[^()]*\))?\s+FROM\s+[\w.]+(?:\s+(?:AS\s+)?(?!WHERE\b)\w+)?(?:\s+WHERE\s+[^()]*)?$/i;
const COUNT_FORBIDDEN = /\b(?:LIMIT|OFFSET|FETCH|UNION|EXCEPT|INTERSECT|GROUP|HAVING|WINDOW|SELECT)\b/i;
/** A select whose top level has an aggregate with neither GROUP BY nor OVER: one row, NULL over an absent input (a scalar in disguise). */
function ungroupedAggregate(text: string): boolean {
  let skeleton = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") {
      const inner = balanced(text, i);
      if (inner === undefined) return true;
      skeleton += "(~)";
      i += inner.length + 1;
    } else skeleton += text[i];
  }
  if (/\bGROUP\s+BY\b/i.test(skeleton)) return false;
  for (const m of skeleton.matchAll(/\b(?:count|sum|avg|min|max|bool_and|bool_or|every|array_agg|string_agg|json_agg|jsonb_agg|xmlagg)\s*\(~\)(\s*FILTER\s*\(~\))?(\s*OVER\b)?/gi)) {
    if (m[2] === undefined) return true;
  }
  return false;
}
function scalarSubqueryHits(sql: string): string[] {
  const found: string[] = [];
  for (const m of sql.matchAll(/\(\s*SELECT\b/gi)) {
    const inner = balanced(sql, m.index);
    const text = (inner ?? sql.slice(m.index + 1)).trim();
    const before = sql.slice(0, m.index).trimEnd();
    if (/\b(?:EXISTS|IN|FROM|JOIN|LATERAL|AS)$/i.test(before) && !/\bNOT\s+IN$/i.test(before)) {
      if (ungroupedAggregate(text)) found.push("a row source that is an ungrouped aggregate: " + text.slice(0, 40));
      continue;
    }
    const countOnly = inner !== undefined && COUNT_ONLY.test(text) && !COUNT_FORBIDDEN.test(text.replace(/^SELECT\b/i, ""));
    if (!countOnly) {
      found.push(text.slice(0, 40));
      continue;
    }
    let b = before;
    let after = sql.slice(m.index + inner.length + 2).trimStart();
    while (b.endsWith("(") && after.startsWith(")")) {
      b = b.slice(0, -1).trimEnd();
      after = after.slice(1).trimStart();
    }
    after = after.replace(/^::\s*(?:text|bigint|integer|int|numeric)\b/i, "").trimStart();
    if (/[-+*/%]$/.test(b) || /^[-+*/%]/.test(after)) found.push(text.slice(0, 40));
  }
  return found;
}

/** Pinned shared CTEs (whitespace-collapsed, literals blanked). The CASE allowlists above rely on their columns being NOT NULL, which holds only
 *  because each comes from a NOT NULL column read through an INNER join (migration 0030: commission_adjustments.direction / amount_cents /
 *  line_id / adjustment_seq, commission_lines.seller_id / share_bps / pool_id, commission_pools.pool_cents / basis / rate are all NOT NULL):
 *  any edit of these texts fails the lint until the new text is reviewed and re-pinned here. */
const SHARED_CTES: Readonly<Record<string, string>> = {
  split_in: "SELECT b.k, l.line_id, l.seller_id, b.total::bigint AS total, l.share_bps::bigint AS w, (sum(l.share_bps) OVER (PARTITION BY b.k))::bigint AS ws FROM (<bases>) b JOIN kauro.commission_lines l ON l.pool_id = b.pool_id",
  split_fl: "SELECT k, line_id, seller_id, total, (total * w) / ws AS fl, (total * w) % ws AS rem FROM split_in",
  split: "SELECT k, line_id, seller_id, fl + CASE WHEN row_number() OVER (PARTITION BY k ORDER BY rem DESC, seller_id::text COLLATE \"\") <= total - sum(fl) OVER (PARTITION BY k) THEN 1 ELSE 0 END AS share FROM split_fl",
  chain: "SELECT a.*, lag(a.new_cumulative_entitlement_cents) OVER (PARTITION BY a.line_id ORDER BY a.adjustment_seq) AS prior_new, lag(a.adjustment_seq) OVER (PARTITION BY a.line_id ORDER BY a.adjustment_seq) AS prior_seq, max(a.adjustment_seq) OVER (PARTITION BY a.line_id) AS last_seq FROM kauro.commission_adjustments a",
};
/** The bases the oracle feeds the split (each selects k, pool_id and a NOT NULL total from NOT NULL columns through inner joins). */
const SPLIT_BASES: ReadonlyArray<string> = [
  "SELECT p.pool_id AS k, p.pool_id, p.pool_cents AS total FROM kauro.commission_pools p",
  "SELECT a.adjustment_id AS k, l.pool_id, ((a.new_basis_cents)::bigint * (p.rate_bps)::bigint + 5000) / 10000 AS total FROM kauro.commission_adjustments a JOIN kauro.commission_lines l ON l.line_id = a.line_id JOIN kauro.commission_pools p ON p.pool_id = l.pool_id WHERE a.reason IN ('', '')",
  "SELECT p.pool_id AS k, p.pool_id, ((p.initial_basis_cents)::bigint * (p.rate_bps)::bigint + 5000) / 10000 AS total FROM kauro.commission_pools p",
];
function sharedCtes(sql: string): Array<{ name: string; body: string; bases?: string }> {
  const out: Array<{ name: string; body: string; bases?: string }> = [];
  const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
  for (const m of sql.matchAll(/\b(chain|split_in|split_fl|split)\s*(?:\([^()]*\)\s*)?AS\b(?:\s+(?:NOT\s+)?MATERIALIZED)?\s*\(/gi)) {
    const name = m[1]!.toLowerCase();
    const body = balanced(sql, m.index + m[0].length - 1);
    if (body === undefined) {
      out.push({ name, body: "<unclosed>" });
      continue;
    }
    const from = name === "split_in" ? /\bFROM\s*\(/i.exec(body) : null;
    const bases = from === null ? undefined : balanced(body, from.index + from[0].length - 1);
    if (bases !== undefined) out.push({ name, body: norm(body.replace(bases, "<bases>")), bases: norm(bases) });
    else out.push({ name, body: norm(body) });
  }
  return out;
}

/** A CTE named chain or split* defined anywhere other than as its exact pinned text; a second ch alias in one branch. */
function sharedViolations(sql: string): string[] {
  const hit: string[] = [];
  for (const c of sharedCtes(sql)) {
    if (SHARED_CTES[c.name] !== c.body) hit.push(`CTE ${c.name} is not its pinned text`);
    if (c.bases !== undefined && !SPLIT_BASES.includes(c.bases)) hit.push("split basis is not one of the pinned bases");
  }
  const aliases = [...sql.matchAll(/(?:\b[\w.]+|\))\s+(?:AS\s+)?ch\b(?!\s*\.)/gi)].filter((m) => !/^(?:AS|ON|AND|OR|WHERE|SELECT|THEN|ELSE|WHEN|BY|IS|NOT|NULL|FROM|JOIN)\s/i.test(m[0]));
  if (aliases.length > 1) hit.push("a second ch alias in one branch");
  return hit;
}

/** The forms that make a branch more than one atomic predicate, or read an absent case as a value (template rule 12): token-based, case-insensitive, on the SQL without its literals. */
function nonAtomic(branch: string): string[] {
  const sql = stripLiterals(branch);
  const hit: string[] = [];
  // a double-quoted identifier can name or hide anything (a CTE "chain", an alias "ch"): refused, except the one COLLATE "C" the split uses
  if (/""/.test(stripLiterals(branch.replace(/\bCOLLATE\s+"C"/gi, " ")))) hit.push("a quoted identifier");
  const has = (what: string, pattern: RegExp): void => {
    if (pattern.test(sql)) hit.push(what);
  };
  has("OR", /\bOR\b/i);
  has("an outer join (a nullable column reaches a comparison)", /\b(?:LEFT|RIGHT|FULL|OUTER)\s+(?:OUTER\s+)?JOIN\b/i);
  has("a count compared with <> 1 or != 1", /(<>|!=)\s*1(?![0-9])/);
  has("!=", /!=/);
  has("IS DISTINCT FROM", /\bIS\s+(NOT\s+)?DISTINCT\s+FROM\b/i);
  has("COALESCE", /\bCOALESCE\s*\(/i);
  has("IFNULL", /\bIFNULL\s*\(/i);
  has("NULLIF", /\bNULLIF\s*\(/i);
  has("GREATEST", /\bGREATEST\s*\(/i);
  has("LEAST", /\bLEAST\s*\(/i);
  has("postfix ISNULL / NOTNULL", /\b(ISNULL|NOTNULL)\b/i);
  has("CASE WHEN ... IS NULL", /\bCASE\b(?:(?!\bEND\b)[\s\S])*?\bIS\s+(NOT\s+)?NULL\b/i);
  has("NOT IN (SELECT", /\bNOT\s+IN\s*\(\s*SELECT\b/i);
  // a CASE with an ELSE is a default for the absent case unless its whole body is one of the two allowed shapes (nested CASEs are checked as their own entries)
  for (const body of caseBodies(sql)) {
    if (!/\bELSE\b/i.test(body)) continue;
    const allowed = (DIRECTION_CASE.test(body) && chBoundToChain(sql)) || SPLIT_ONE_CENT_CASE.test(body);
    if (!allowed) hit.push("CASE ... ELSE as a default");
  }
  has("LIMIT / OFFSET / FETCH / EXCEPT / INTERSECT", /\b(?:LIMIT|OFFSET|FETCH|EXCEPT|INTERSECT)\b/i);
  if (scalarSubqueryHits(sql).length > 0) hit.push("a scalar subquery that is not a row source or one exact count");
  hit.push(...sharedViolations(sql));
  return hit;
}

test("every UNION ALL branch of an invariant is named in its whys and is ONE atomic predicate (a disjunction inside a branch would let a control pass on a neighbour's predicate)", () => {
  // a disjunction: OR; a count compared with exactly one ("none" or "several"); IS DISTINCT FROM ("absent" or "different"); COALESCE,
  // IFNULL, NULLIF or CASE WHEN ... IS NULL ("absent" read as a value): the absent case is its own branch (ADV-16). Anywhere in the branch,
  // its CTEs and select list included: a coalesced value computed in a CTE still decides the predicate that reads it.
  let predicates = 0;
  for (const inv of B10_INVARIANTS) {
    const branches = inv.sql.split(/\bUNION ALL\b/);
    assert.equal(inv.whys?.length ?? 1, branches.length, `${inv.id}: ${branches.length} branch(es) in its SQL`);
    if (inv.whys !== undefined) assert.equal(new Set(inv.whys).size, inv.whys.length, `${inv.id}: the names are distinct`);
    for (const [i, branch] of branches.entries()) {
      assert.deepEqual(nonAtomic(branch), [], `${inv.id} branch ${i + 1} (${inv.whys?.[i] ?? "sole"}) is not one atomic predicate: split it into one branch per predicate, each with its why and its control`);
    }
    predicates += branches.length;
  }
  assert.equal(predicates, B10_INVARIANTS.reduce((n, inv) => n + (inv.whys?.length ?? 1), 0), "one why (or sole condition) per atomic predicate");
});

test("the structural check refuses a branch that joins two predicates with OR, compares a count with <> 1, uses IS DISTINCT FROM or reads an absent case as a value (COALESCE, IFNULL, NULLIF, GREATEST, LEAST, ISNULL, NOTNULL, CASE ... ELSE, NOT IN (SELECT, a nullable scalar subquery)", () => {
  const atomic = (sql: string) => nonAtomic(sql).length === 0;
  assert.equal(atomic("SELECT 1 FROM t LEFT JOIN u ON true WHERE t.x > coalesce(u.x, 0)"), false);
  assert.equal(atomic("SELECT 1 FROM t GROUP BY t.k HAVING COALESCE (sum(t.x), 0) <> 0"), false);
  assert.equal(atomic("SELECT 1 FROM t WHERE ifnull(t.x, 0) > 0"), false);
  assert.equal(atomic("SELECT 1 FROM t WHERE nullif(t.x, 0) > 0"), false);
  assert.equal(atomic("SELECT 1 FROM t LEFT JOIN u ON true WHERE t.x > CASE WHEN u.x IS NULL THEN 0 ELSE u.x END"), false);
  assert.equal(atomic("SELECT 1 FROM t WHERE t.x IS NULL AND NOT EXISTS (SELECT 1 FROM u)"), true, "a NULL test of its own is one predicate");
  assert.equal(atomic("SELECT 1 FROM chain ch WHERE ch.y > CASE ch.direction WHEN 'INCREASE' THEN 1 ELSE -1 END AND ch.z IS NULL"), true, "a CASE over a NOT NULL column is not an absent case");
  assert.equal(atomic("SELECT 1 FROM t WHERE a <> b OR c < 0"), false);
  assert.equal(atomic("SELECT 1 FROM t WHERE (SELECT count(*) FROM u) <> 1"), false);
  assert.equal(atomic("SELECT 1 FROM t LEFT JOIN u ON true WHERE t.x IS DISTINCT FROM u.x"), false);
  assert.equal(atomic("SELECT 1 FROM t WHERE a <> b ORDER BY a"), true, "ORDER is not OR");
  assert.equal(atomic("SELECT 1 FROM t WHERE (SELECT count(*) FROM u) <> 10"), true);
  assert.equal(atomic("SELECT 1 FROM t WHERE t.x > (SELECT count(*) FROM u)"), true, "a count is never NULL");
  assert.equal(atomic("SELECT 1 FROM t WHERE t.k = 'a or b' AND t.j <> 'GREATEST('"), true, "words inside a quoted literal are not operators");
});

test("the structural check refuses every bypass of the ban found by the adversary (ADV-19): one forged snippet each, in any case and spacing", () => {
  const bypasses: ReadonlyArray<readonly [string, string]> = [
    ["lowercase or", "SELECT 1 FROM t WHERE a <> b or c < 0"],
    ["mixed-case Or across a newline", "SELECT 1 FROM t WHERE a <> b\n  Or\n c < 0"],
    ["or in a CTE", "WITH w AS (SELECT 1 FROM t WHERE a = 1 or b = 2) SELECT 1 FROM w WHERE true"],
    ["or behind a comment", "SELECT 1 FROM t WHERE a = 1 /* x */ or b = 2"],
    ["!= on a scalar count", "SELECT 1 FROM t WHERE (SELECT count(*) FROM u) != 1"],
    ["!= alone", "SELECT 1 FROM t WHERE a != b"],
    ["<> 1 without spacing", "SELECT 1 FROM t GROUP BY k HAVING count(*)<>1"],
    ["GREATEST", "SELECT 1 FROM t JOIN u ON true WHERE t.x > GREATEST(t.a, u.x)"],
    ["lowercase least", "SELECT 1 FROM t JOIN u ON true WHERE t.x > least (t.a, u.x)"],
    ["postfix ISNULL", "SELECT 1 FROM t LEFT JOIN u ON true WHERE t.y > CASE WHEN u.x ISNULL THEN 0 ELSE u.x END"],
    ["postfix NOTNULL", "SELECT 1 FROM t WHERE u.x NOTNULL AND t.y > 0"],
    ["bare lowercase isnull", "SELECT 1 FROM t WHERE u.x isnull"],
    ["CASE WHEN ... ELSE default", "SELECT 1 FROM t LEFT JOIN u ON true WHERE t.y > CASE WHEN u.x > 0 THEN u.x ELSE 0 END"],
    ["simple CASE over a nullable column with ELSE", "SELECT 1 FROM t LEFT JOIN u ON true WHERE t.y > CASE u.x WHEN 1 THEN 5 ELSE 0 END"],
    ["NOT IN (SELECT", "SELECT 1 FROM t WHERE t.x NOT IN (SELECT u.n FROM u)"],
    ["lowercase not in ( select", "SELECT 1 FROM t WHERE t.x not in ( select u.n FROM u)"],
    ["scalar subquery on the right of a comparison", "SELECT 1 FROM t WHERE t.x <> (SELECT u.amount FROM u WHERE u.k = t.k)"],
    ["scalar subquery on the left of a comparison", "SELECT 1 FROM t WHERE (SELECT max(u.amount) FROM u WHERE u.k = t.k) < t.x"],
    ["scalar subquery inside HAVING", "SELECT 1 FROM t GROUP BY k HAVING sum(t.x) >= (SELECT u.cap FROM u WHERE u.k = t.k)"],
  ];
  for (const [what, sql] of bypasses) assert.notDeepEqual(nonAtomic(sql), [], `refused: ${what}`);
});

test("the structural check refuses the six residual bypasses of the allowlists (ADV-21): one forged snippet each", () => {
  const bypasses: ReadonlyArray<readonly [string, string]> = [
    ["a nullable CASE ... ELSE nested inside the ch.direction CASE", "SELECT 1 FROM chain ch LEFT JOIN u ON true WHERE ch.x > CASE ch.direction WHEN 'INCREASE' THEN CASE WHEN u.x > 0 THEN u.x ELSE 0 END ELSE -1 END"],
    ["the row_number() prefix followed by more conditions", "SELECT 1 FROM t LEFT JOIN u ON true WHERE t.y > CASE WHEN row_number() OVER (PARTITION BY k ORDER BY rem DESC) <= 1 AND u.x > 0 THEN 1 ELSE 0 END"],
    ["count(*) ... GROUP BY", "SELECT 1 FROM t WHERE t.x > (SELECT count(*) FROM u WHERE u.k = t.k GROUP BY u.j)"],
    ["count(*) ... HAVING", "SELECT 1 FROM t WHERE t.x > (SELECT count(*) FROM u WHERE u.k = t.k HAVING sum(u.n) > 5)"],
    ["count(*) + max(x)", "SELECT 1 FROM t WHERE t.x > (SELECT count(*) + max(u.x) FROM u WHERE u.k = t.k)"],
    ["a count subquery wrapped in arithmetic", "SELECT 1 FROM t WHERE t.x > (SELECT count(*) FROM u) + 1"],
    ["a max subquery wrapped in arithmetic", "SELECT 1 FROM t WHERE ((SELECT max(u.x) FROM u WHERE u.k = t.k) + 0) > t.x"],
    ["the alias ch on a nullable LEFT JOIN table", "SELECT 1 FROM t LEFT JOIN u ch ON true WHERE t.y > CASE ch.direction WHEN 'INCREASE' THEN 1 ELSE -1 END"],
    ["the alias ch on a table other than the chain CTE", "SELECT 1 FROM u ch WHERE 1 > CASE ch.direction WHEN 'INCREASE' THEN 1 ELSE -1 END"],
  ];
  for (const [what, sql] of bypasses) assert.notDeepEqual(nonAtomic(sql), [], `refused: ${what}`);
});

test("the structural check refuses every ADV-22 variant of the scalar-subquery and alias bypasses: one forged snippet each (allowlist, not denylist)", () => {
  const w = "SELECT 1 FROM t WHERE ";
  const bypasses: ReadonlyArray<readonly [string, string]> = [
    ["a count subquery with LIMIT 0", `${w}t.x > (SELECT count(*) FROM u LIMIT 0)`],
    ["a count subquery with OFFSET 1", `${w}t.x > (SELECT count(*) FROM u OFFSET 1)`],
    ["a count subquery with FETCH FIRST 0 ROWS", `${w}t.x > (SELECT count(*) FROM u FETCH FIRST 0 ROWS ONLY)`],
    ["a count subquery with EXCEPT", `${w}t.x > (SELECT count(*) FROM u EXCEPT SELECT count(*) FROM v)`],
    ["a non-count subquery cast and compared (the ::bigint <)", `${w}(SELECT max(u.x) FROM u WHERE u.k = t.k)::bigint < t.x`],
    ["a scalar subquery inside a function (abs((SELECT)))", `${w}t.x > abs((SELECT max(u.x) FROM u WHERE u.k = t.k))`],
    ["a scalar subquery as a BETWEEN bound", `${w}t.x BETWEEN (SELECT max(u.a) FROM u) AND (SELECT max(u.b) FROM u)`],
    ["a scalar subquery inside an IN list", `${w}t.x IN ((SELECT max(u.x) FROM u), 1)`],
    ["= ANY (SELECT", `${w}t.x = ANY (SELECT u.x FROM u WHERE u.k = t.k)`],
    ["a scalar subquery after ||", `${w}t.x::text = 'a' || (SELECT max(u.x) FROM u WHERE u.k = t.k)`],
    ["NOT (SELECT", `${w}NOT (SELECT bool_and(u.ok) FROM u WHERE u.k = t.k)`],
    ["a count subquery cast then compared with arithmetic", `${w}t.x > (SELECT count(*) FROM u)::bigint + 1`],
    ["a nested re-alias of ch", `SELECT 1 FROM chain ch WHERE 1 > CASE ch.direction WHEN 'INCREASE' THEN 1 ELSE -1 END AND EXISTS (SELECT 1 FROM chain ch JOIN u ON true WHERE u.x IS NULL)`],
    ["a CTE chain redefined over a join", `WITH chain AS (SELECT a.* FROM kauro.commission_adjustments a JOIN u ON true) SELECT 1 FROM chain ch WHERE 1 > CASE ch.direction WHEN 'INCREASE' THEN 1 ELSE -1 END`],
    ["a quoted CTE name", `WITH "chain" AS (SELECT a.* FROM u a JOIN v ON true) SELECT 1 FROM "chain" ch WHERE ch.x > 0`],
    ["a quoted alias", `SELECT 1 FROM t JOIN u "ch" ON true WHERE "ch".x > 0`],
    ["a CTE split redefined", `WITH split AS (SELECT 1 AS k, 1 AS share) SELECT 1 FROM split WHERE true`],
  ];
  for (const [what, sql] of bypasses) assert.notDeepEqual(nonAtomic(sql), [], `refused: ${what}`);
  // the oracle's own forms stay permitted
  const ok = [
    `${w}NOT EXISTS (SELECT 1 FROM u WHERE u.k = t.k)`,
    `${w}t.k IN (SELECT u.k FROM u)`,
    `${w}t.x > (SELECT count(*) FROM u WHERE u.k = t.k)`,
    `${w}t.x > (SELECT count(*) FILTER (WHERE u.s = 'a') FROM kauro.u u WHERE u.k = t.k)`,
    `SELECT (SELECT count(*) FROM u WHERE u.k = t.k)::text FROM t`,
    `SELECT count(*)::text || ' live, ' || (SELECT count(*) FROM kauro.u f WHERE f.k = t.k) || ' slots' FROM t`,
    `SELECT 1 FROM t JOIN LATERAL (SELECT c.line_id, sum(c.amount_cents) AS cents FROM u c GROUP BY c.line_id) e ON true`,
  ];
  for (const sql of ok) assert.deepEqual(nonAtomic(sql), [], `permitted: ${sql}`);
});

test("the shared chain and split CTEs the CASE allowlists rely on are the pinned text (their columns are NOT NULL by construction), in every invariant that reads them (ADV-22)", () => {
  let users = 0;
  for (const inv of B10_INVARIANTS) {
    const sql = stripLiterals(inv.sql);
    const defined = new Set(sharedCtes(sql).map((c) => c.name));
    for (const name of ["chain", "split"]) {
      if ((name === "chain" ? /\b(?:FROM|JOIN)\s+chain\b/i : /\b(?:FROM|JOIN)\s+split\b/i).test(sql)) {
        users++;
        assert.ok(defined.has(name), `${inv.id} reads ${name} without defining it`);
      }
    }
    for (const c of sharedCtes(sql)) assert.equal(SHARED_CTES[c.name], c.body, `${inv.id}: CTE ${c.name} differs from its pinned text: review its NOT NULL columns, then re-pin`);
  }
  assert.ok(users >= 2, "the oracle reads both shared CTEs");
  assert.deepEqual(Object.keys(SHARED_CTES).sort(), ["chain", "split", "split_fl", "split_in"]);
  assert.match(SHARED_CTES["chain"]!, /^SELECT a\.\*, .* FROM kauro\.commission_adjustments a$/, "chain is a bare read of the adjustments table: no join that could null a column");
  assert.doesNotMatch(Object.values(SHARED_CTES).join(" "), /\b(?:LEFT|RIGHT|FULL|OUTER)\b/i, "no outer join in a shared CTE");
});

test("the structural check refuses a LIMIT, OFFSET, FETCH or set operation anywhere, a row source that is an ungrouped aggregate, and an outer join (ADV-23, ADV-24)", () => {
  const bypasses: ReadonlyArray<readonly [string, string]> = [
    ["OFFSET in EXISTS", "SELECT 1 FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.k = t.k AND u.x > t.cap OFFSET 1)"],
    ["LIMIT in a LATERAL row source", "SELECT 1 FROM t JOIN LATERAL (SELECT u.x FROM u WHERE u.k = t.k ORDER BY u.seq LIMIT 1) s ON true WHERE s.x > t.cap"],
    ["FETCH FIRST in IN", "SELECT 1 FROM t WHERE t.k IN (SELECT u.k FROM u FETCH FIRST 1 ROWS ONLY)"],
    ["EXCEPT in EXISTS", "SELECT 1 FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.k = t.k EXCEPT SELECT 1 FROM v WHERE v.k = t.k)"],
    ["top-level LIMIT 0", "SELECT 1 FROM t WHERE t.x > 0 LIMIT 0"],
    ["a LATERAL max() row source", "SELECT 1 FROM t JOIN LATERAL (SELECT max(u.x) AS m FROM u WHERE u.k = t.k) s ON true WHERE t.x > s.m"],
    ["a CTE max() row source", "WITH s AS (SELECT max(u.x) AS m FROM u) SELECT 1 FROM t, s WHERE t.x > s.m"],
    ["IN (SELECT max(...))", "SELECT 1 FROM t WHERE t.x IN (SELECT max(u.x) FROM u WHERE u.k = t.k)"],
    ["a LEFT JOIN compared", "SELECT 1 FROM t LEFT JOIN u ON u.k = t.k WHERE t.x > u.x"],
  ];
  for (const [what, sql] of bypasses) assert.notDeepEqual(nonAtomic(sql), [], `refused: ${what}`);
  assert.deepEqual(nonAtomic("SELECT 1 FROM t JOIN (SELECT u.k, sum(u.x) AS s FROM u GROUP BY u.k) g ON g.k = t.k WHERE t.x > g.s"), [], "a grouped aggregate row source is permitted");
  assert.deepEqual(nonAtomic("WITH w AS (SELECT u.k, sum(u.x) OVER (PARTITION BY u.k) AS s FROM u) SELECT 1 FROM w WHERE w.s > 0"), [], "a windowed aggregate is permitted");
});

test("the lint source files contain no control bytes other than tab, newline and carriage return (ADV-23: a backspace had replaced a regex word boundary)", () => {
  for (const url of [new URL(import.meta.url), new URL("../../src/testing/invariants.js", import.meta.url)]) {
    const path = fileURLToPath(url).replace(/[\\/]dist[\\/]/, "/").replace(/\.js$/, ".ts");
    const bytes = readFileSync(path);
    for (const [i, b] of bytes.entries()) if (b < 32 && b !== 9 && b !== 10 && b !== 13) assert.fail(`${path}: control byte 0x${b.toString(16)} at offset ${i}`);
  }
});
