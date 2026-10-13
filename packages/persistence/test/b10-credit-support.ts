// Fixtures of the seller-credit suite (docs/design/B10-OFFSET.md section 6 F6): a line PAID with a partial hold withheld (case J: the hold's cents are
// credit once RELEASED), a line whose shares rise by one cent after it was paid (case H without the offset; the 1000/1400/7600 pool of
// invariants.test.ts), credit entries and CREDIT statement items written as the commission service writes them.
import assert from "node:assert/strict";
import type { Client } from "pg";
import { clock } from "../src/testing/harness.js";
import { recordIssuedStatement } from "../src/testing/ledger-fixtures.js";
import { acquired, accrue, activeSeller, approvePayout, completion, funds, ids, makeEligible, ownerOf, payLines, purchase, reconcile, within, corporate, type Agency, type Purchase, type Seller } from "./b10-commission-support.js";
import { allocatePool } from "@kauro/domain";
import { extraPeriod, openHoldOn, refundTo, sellerWith, type OffsetWorld } from "./b10-offset-support.js";

export interface HeldPaid {
  readonly seller: Seller;
  readonly lineId: string;
  readonly holdId: string;
  readonly holdIds: ReadonlyArray<string>;
  readonly ag: Agency;
  readonly purchase: Purchase;
  readonly statementId: string;
}

/** A 1000-cent ELIGIBLE line with a `held`-cent OPEN hold, closed (the statement withholds the hold), approved and settled: PAID at 1000 - held, the hold still OPEN. */
export async function paidWithOpenHold(ow: OffsetWorld, label: string, heldOrHolds: number | ReadonlyArray<number> = 300, period = 0): Promise<HeldPaid> {
  const holds = typeof heldOrHolds === "number" ? [heldOrHolds] : heldOrHolds;
  const held = holds.reduce((x, y) => x + y, 0);
  const { seller, ag, receivingLines: [lineId], receivingPurchases: [purchase] } = await sellerWith(ow, label, 0, [1000]);
  for (const cents of holds) await within(ow.w.app, ownerOf(ow.w), (c) => openHoldOn(c, lineId!, cents));
  const holdIds = (await ow.w.h.oracle.query<{ hold_id: string }>("SELECT hold_id FROM kauro.commission_holds WHERE line_id = $1 ORDER BY opened_at, hold_id", [lineId])).rows.map((r) => r.hold_id);
  const closed = await recordIssuedStatement(ow.w.h, { periodId: ow.periods[period]!, sellerId: seller.sellerId, cutoffAt: clock.now() });
  assert.equal(closed.payableCents, BigInt(1000 - held), "the statement pays what the hold does not withhold");
  assert.equal(closed.heldCents, BigInt(held));
  const intentId = await approvePayout(ow.w, { statementId: closed.statementId, payableCents: Number(closed.payableCents) }, seller, seller);
  await reconcile(ow.w, intentId, "SETTLED");
  const line = (await ow.w.h.oracle.query<{ state: string; paid: number }>("SELECT state, paid_cents::int AS paid FROM kauro.commission_lines WHERE line_id = $1", [lineId])).rows[0]!;
  assert.deepEqual(line, { state: "PAID", paid: 1000 - held });
  return { seller, ag, purchase: purchase!, lineId: lineId!, holdId: holdIds[0]!, holdIds, statementId: closed.statementId };
}

/** The owner RELEASES a hold. */
export const releaseHold = (ow: OffsetWorld, holdId: string): Promise<unknown> =>
  within(ow.w.app, ownerOf(ow.w), (c) => releaseHoldOn(c, holdId));
export const releaseHoldOn = (c: Client, holdId: string): Promise<unknown> =>
  c.query("UPDATE kauro.commission_holds SET state = 'RELEASED', version = version + 1, released_at = kauro.server_now() WHERE hold_id = $1", [holdId]);

/** Credit entries of a line as [kind, cents, cause], in recording order. */
export const entriesOf = async (ow: OffsetWorld, lineId: string): Promise<ReadonlyArray<readonly [string, number, string]>> =>
  (await ow.w.h.oracle.query<{ k: string; cents: number; cause: string }>(
    "SELECT entry_kind AS k, amount_cents::int AS cents, cause FROM kauro.seller_credit_entries WHERE line_id = $1 ORDER BY recorded_at, entry_id",
    [lineId],
  )).rows.map((r) => [r.k, r.cents, r.cause] as const);

/** R - V of a line. */
export const recognizedOf = async (ow: OffsetWorld, lineId: string): Promise<number> =>
  (await ow.w.h.oracle.query<{ n: number }>("SELECT kauro.commission_line_credit_recognized($1)::int AS n", [lineId])).rows[0]!.n;

/** A credit entry written directly by the commission service (the guard accepts only the difference that reconciles the line). */
export const entryOn = (c: Client, sellerId: string, lineId: string, kind: "RECOGNIZED" | "REVERSED", cents: number): Promise<unknown> =>
  c.query(
    "INSERT INTO kauro.seller_credit_entries (entry_id, line_id, seller_id, entry_kind, amount_cents, cause, recorded_at, created_at) VALUES ($1, $2, $3, $4, $5, 'LINE_SETTLED', kauro.server_now(), now())",
    [ids.next(), lineId, sellerId, kind, cents],
  );

/** An ISSUED statement of `periodId` carrying one CREDIT item of `cents` for `lineId` (CMD051's write of the item, in the commission service's transaction `c`). */
export async function creditStatementIn(c: Client, periodId: string, sellerId: string, lineId: string, cents: number): Promise<string> {
  const statementId = ids.next();
  await c.query(
    `INSERT INTO kauro.commission_statements (statement_id, period_id, seller_id, period_starts_at, period_ends_at, calendar_id, calendar_source, statement_date, pay_date, label,
       accrued_pending_cents, held_cents, payable_cents, paid_to_date_cents, negative_balance_cents, cutoff_hash, created_at, updated_at)
     SELECT $1, p.period_id, $2, p.starts_at, p.ends_at, p.calendar_id, p.calendar_source, p.close_due_on, p.pay_due_on,
            CASE WHEN p.calendar_source = 'TEST_FIXTURE' THEN 'SIMULATED' ELSE 'VERIFIED_CALENDAR' END, 0, 0, $3, 0, 0, $4, now(), now()
       FROM kauro.commission_periods p WHERE p.period_id = $5`,
    [statementId, sellerId, cents, "0".repeat(63) + (cents % 10), periodId],
  );
  await creditItemIn(c, statementId, sellerId, lineId, cents, 1);
  await c.query("UPDATE kauro.commission_statements SET state = 'ISSUED', issued_at = kauro.server_now(), version = 2 WHERE statement_id = $1", [statementId]);
  return statementId;
}

/** One CREDIT item into an existing DRAFT statement. */
export const creditItemIn = (c: Client, statementId: string, sellerId: string, lineId: string, cents: number, itemNo: number): Promise<unknown> =>
  c.query(
    "INSERT INTO kauro.statement_items (item_id, statement_id, seller_id, item_no, item_kind, disposition, line_id, payable_cents, created_at) VALUES ($1, $2, $3, $4, 'CREDIT', 'CREDIT', $5, $6, now())",
    [ids.next(), statementId, sellerId, itemNo, lineId, cents],
  );

/** A DRAFT statement of `periodId` with no item yet. */
export async function draftStatementIn(c: Client, periodId: string, sellerId: string, payable: number): Promise<string> {
  const statementId = ids.next();
  await c.query(
    `INSERT INTO kauro.commission_statements (statement_id, period_id, seller_id, period_starts_at, period_ends_at, calendar_id, calendar_source, statement_date, pay_date, label,
       accrued_pending_cents, held_cents, payable_cents, paid_to_date_cents, negative_balance_cents, cutoff_hash, created_at, updated_at)
     SELECT $1, p.period_id, $2, p.starts_at, p.ends_at, p.calendar_id, p.calendar_source, p.close_due_on, p.pay_due_on,
            CASE WHEN p.calendar_source = 'TEST_FIXTURE' THEN 'SIMULATED' ELSE 'VERIFIED_CALENDAR' END, 0, 0, $3, 0, 0, $4, now(), now()
       FROM kauro.commission_periods p WHERE p.period_id = $5`,
    [statementId, sellerId, payable, "1".repeat(63) + (payable % 10), periodId],
  );
  return statementId;
}

export interface Risen {
  readonly seller: Seller;
  readonly ag: Agency;
  readonly purchase: Purchase;
  readonly lineId: string;
  readonly holdId?: string;
  readonly agreementVersion: string;
  readonly refund: (basis: bigint) => Promise<void>;
}

async function risenPool(ow: OffsetWorld, label: string) {
  const { w } = ow;
  const A = await activeSeller(w, `${label}-a`, { offsetTerms: "SIGNED_FUTURE_OFFSET" });
  const B = await activeSeller(w, `${label}-b`);
  const C = await activeSeller(w, `${label}-c`);
  const shares = [{ seller: A, shareBps: 1000 }, { seller: B, shareBps: 1400 }, { seller: C, shareBps: 7600 }];
  const a = await acquired(w, `${label} agency`, shares);
  const split = allocatePool(27n, shares.map((s) => ({ sellerId: s.seller.sellerId, shareBps: s.shareBps })));
  const pool = await accrue(w, a.ag, a.first, a.allocationId, { rateKind: "FIRST", rateBps: 1000, basisCents: 270, poolCents: 27, sequence: 1 },
    shares.map((s) => ({ sellerId: s.seller.sellerId, entitlementId: a.entitlements.get(s.seller.sellerId)!, shareBps: s.shareBps, cents: Number(split.get(s.seller.sellerId)!) })));
  const lineId = pool.lineOf.get(A.sellerId)!;
  await refundTo(ow, a.ag, a.first, 260n, A.agreementVersion);
  assert.equal((await w.h.oracle.query<{ e: number }>("SELECT cumulative_entitlement_cents::int AS e FROM kauro.commission_lines WHERE line_id = $1", [lineId])).rows[0]!.e, 2);
  return { A, a, lineId };
}

/**
 * Shares 1000/1400/7600 of a 1000-bps pool (invariants.test.ts, r3 R3-01): the first seller line is [3, 2, 3, 2] cents at the bases 270, 260, 250, 230.
 * The line is paid at 2 cents (after the refund to 260): the refund to 250 raises it to 3, one cent above what it settled; the refund to 230 lowers it again.
 * With `hold`, a 1-cent hold of the line is OPEN when the statement closes (withheld): paid 1 cent, the hold 1.
 */
export async function risenLine(ow: OffsetWorld, label: string, options: { readonly hold?: boolean } = {}): Promise<Risen> {
  const { w } = ow;
  const { A, a, lineId } = await risenPool(ow, label);
  const refund = (basis: bigint) => refundTo(ow, a.ag, a.first, basis, A.agreementVersion);
  if (options.hold !== true) {
    await payLines(w, a.ag, a.first, ow.periods[0]!, [{ seller: A, lineId }]);
    return { seller: A, ag: a.ag, purchase: a.first, lineId, agreementVersion: A.agreementVersion, refund };
  }
  await completion(w, a.ag, a.first, "FINAL");
  await funds(w, a.ag, a.first, "AVAILABLE", 2);
  await makeEligible(w, lineId);
  await within(w.app, ownerOf(w), (c) => openHoldOn(c, lineId, 1));
  const holdId = (await w.h.oracle.query<{ hold_id: string }>("SELECT hold_id FROM kauro.commission_holds WHERE line_id = $1", [lineId])).rows[0]!.hold_id;
  const closed = await recordIssuedStatement(w.h, { periodId: ow.periods[0]!, sellerId: A.sellerId, cutoffAt: clock.now() });
  const intentId = await approvePayout(w, { statementId: closed.statementId, payableCents: Number(closed.payableCents) }, A, A);
  await reconcile(w, intentId, "SETTLED");
  return { seller: A, ag: a.ag, purchase: a.first, lineId, holdId, agreementVersion: A.agreementVersion, refund };
}

void [corporate, funds, completion, makeEligible, purchase];

export interface HeldLines {
  readonly seller: Seller;
  readonly lineIds: string[];
  readonly holdIds: string[];
}

/** One seller, `holds.length` 1000-cent ELIGIBLE lines each with its own OPEN hold, closed in one statement, approved and settled: every line PAID at 1000 minus its hold. */
export async function paidLinesWithHolds(ow: OffsetWorld, label: string, holds: ReadonlyArray<number>): Promise<HeldLines> {
  const { seller, receivingLines } = await sellerWith(ow, label, 0, holds.map(() => 1000));
  const holdIds: string[] = [];
  for (const [i, cents] of holds.entries()) {
    await within(ow.w.app, ownerOf(ow.w), (c) => openHoldOn(c, receivingLines[i]!, cents));
    holdIds.push((await ow.w.h.oracle.query<{ hold_id: string }>("SELECT hold_id FROM kauro.commission_holds WHERE line_id = $1", [receivingLines[i]])).rows[0]!.hold_id);
  }
  const closed = await recordIssuedStatement(ow.w.h, { periodId: ow.periods[0]!, sellerId: seller.sellerId, cutoffAt: clock.now() });
  const intentId = await approvePayout(ow.w, { statementId: closed.statementId, payableCents: Number(closed.payableCents) }, seller, seller);
  await reconcile(ow.w, intentId, "SETTLED");
  return { seller, lineIds: receivingLines, holdIds };
}

let extra: Promise<string> | undefined;
/** The one further dated period of a world (a period is unique per month and calendar: created once). */
export const spareFor = (ow: OffsetWorld): Promise<string> => (extra ??= extraPeriod(ow));
