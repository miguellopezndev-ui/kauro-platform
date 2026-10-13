// Fixtures shared by the B10-OFFSET database suites (docs/design/B10-OFFSET.md section 6): a seller under signed SIGNED_FUTURE_OFFSET terms with
// negative lines (paid, then refunded below what was paid) and ELIGIBLE receiving lines, offsets recorded as the commission service
// records them, holds opened as the owner opens them, and the live amount of an offset.
import assert from "node:assert/strict";
import type { Client } from "pg";
import { recomputePool, type AdjustmentReason, type CommissionLineId, type EventId, type NewCommissionAdjustment } from "@kauro/domain";
import { PgCommissionLedgerRepository } from "../src/index.js";
import { backendPid, barrier, clock, handled, settlesOrWaits } from "../src/testing/harness.js";
import type { LoginRole } from "../src/testing/index.js";
import {
  accrue,
  acquired,
  activeSeller,
  closeWorld,
  completion,
  corporate,
  fixtureCalendar,
  funds,
  ids,
  makeEligible,
  openWorld,
  ownerOf,
  payLines,
  purchase,
  september,
  service,
  within,
  type Agency,
  type Purchase,
  type Seller,
  type CommerceContext,
  type World,
} from "./b10-commission-support.js";

export interface OffsetWorld {
  readonly w: World;
  /** One dated period per negative line of a seller: each paid line is paid by the seller's one statement of its period. */
  readonly periods: string[];
  readonly calendarId: string;
}

export async function openOffsetWorld(label: string): Promise<OffsetWorld> {
  const w = await openWorld(label);
  const calendarId = await fixtureCalendar(w);
  const periods = [await september(w, calendarId), await september(w, calendarId, "TEST_FIXTURE", ["2026-11-06", "2026-11-13"], "2026-10-01")];
  return { w, periods, calendarId };
}

export const closeOffsetWorld = (ow: OffsetWorld): Promise<void> => closeWorld(ow.w);

/** A refund lowering a capture's basis, recomputed and applied as the COMMISSIONS consumer does, a paid line walked to ADJUSTED. */
export const refundTo = (ow: OffsetWorld, ag: Agency, p: Purchase, basisCents: bigint, agreementVersion: string): Promise<void> =>
  within(ow.w.commission, service(ag.agencyId), (c) => refundIn(c, p, basisCents, agreementVersion));

/** The refund of `refundTo` inside the commission service transaction `c` (the COMMISSIONS consumer runs in the agency of its event). */
export async function refundIn(c: Client, p: Purchase, basisCents: bigint, agreementVersion: string): Promise<void> {
  const sourceEventId = ids.next();
  {
    const ledger = new PgCommissionLedgerRepository(c, ids);
    for (const { pool, lines } of await ledger.lockPoolsOfCapture(p.captureId as never)) {
      const recomputed = recomputePool({ basisCents: pool.basisCents, rateBps: pool.rateBps, lines: lines.map((l) => ({ lineId: l.lineId, sellerId: l.sellerId, shareBps: l.shareBps, cumulativeCents: l.cumulativeEntitlementCents })) }, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: basisCents });
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
      assert.equal((await ledger.applyBasisChange(pool.poolId, recomputed.pool.basisCents, recomputed.poolCents, adjustments)).applied, true);
      for (const before of lines) {
        const line = (await ledger.getLine(before.lineId))!;
        if (line.state === "PAID" || line.state === "ADJUSTED") assert.equal((await ledger.transitionLine(line.lineId, line.version, { state: "ADJUSTED" }, clock.now())).kind, "APPLIED");
      }
    }
  }
}

export interface SellerWith {
  readonly seller: Seller;
  readonly ag: Agency;
  readonly negativeLines: string[];
  readonly receivingLines: string[];
  /** The purchase of each receiving line (the first is the agency's first purchase) and of each negative line. */
  readonly receivingPurchases: Purchase[];
  readonly negativePurchases: Purchase[];
}

/**
 * A seller under signed SIGNED_FUTURE_OFFSET terms with, on one agency: `negatives` paid lines of 4000 cents each (REPEAT 400 bps on
 * a 100000 basis) refunded to 3000 (basis 75000) - a 1000-cent negative position each - and ELIGIBLE receiving lines of the cents given (the first
 * purchase's FIRST line at 1000 bps on ten times those cents, then one REPEAT purchase at 400 bps per further receiving line).
 */
export async function sellerWith(ow: OffsetWorld, label: string, negatives: number, receiving: ReadonlyArray<number>): Promise<SellerWith> {
  const { w, periods } = ow;
  const seller = await activeSeller(w, `${label}-seller`, { offsetTerms: "SIGNED_FUTURE_OFFSET" });
  const a = await acquired(w, `${label} agency`, [{ seller, shareBps: 10000 }]);
  const entitlementId = a.entitlements.get(seller.sellerId)!;
  const line = (cents: number) => [{ sellerId: seller.sellerId, entitlementId, shareBps: 10000, cents }];
  let sequence = 1;
  // every later purchase is quoted with the agency's paid projects so far as its qualifying set (the second end client's projects)
  const paid: string[] = [a.first.projectId];
  const next = async (seed: string): Promise<Purchase> => {
    const p = await purchase(w, a.ag, seed, { qualifying: [...paid], client: 1 });
    paid.push(p.projectId);
    return p;
  };
  const receivingLines: string[] = [];
  const receivingPurchases: Purchase[] = [];
  for (const [i, cents] of receiving.entries()) {
    const p = i === 0 ? a.first : await next(`${label}-receiving-${i}`);
    const pool = await accrue(w, a.ag, p, a.allocationId, { rateKind: i === 0 ? "FIRST" : "REPEAT", rateBps: i === 0 ? 1000 : 400, basisCents: i === 0 ? cents * 10 : cents * 25, poolCents: cents, sequence: sequence++ }, line(cents));
    await completion(w, a.ag, p, "FINAL");
    await funds(w, a.ag, p, "AVAILABLE", 2);
    await makeEligible(w, pool.lineOf.get(seller.sellerId)!);
    receivingLines.push(pool.lineOf.get(seller.sellerId)!);
    receivingPurchases.push(p);
  }
  const negativeLines: string[] = [];
  const negativePurchases: Purchase[] = [];
  for (let n = 0; n < negatives; n++) {
    const p = await next(`${label}-negative-${n}`);
    const pool = await accrue(w, a.ag, p, a.allocationId, { rateKind: "REPEAT", rateBps: 400, basisCents: 100000, poolCents: 4000, sequence: sequence++ }, line(4000));
    const lineId = pool.lineOf.get(seller.sellerId)!;
    await payLines(w, a.ag, p, periods[n]!, [{ seller, lineId }]);
    await refundTo(ow, a.ag, p, 75000n, seller.agreementVersion);
    const row = (await w.h.oracle.query<{ position: number }>("SELECT (paid_cents - cumulative_entitlement_cents)::int AS position FROM kauro.commission_lines WHERE line_id = $1", [lineId])).rows[0]!;
    assert.equal(row.position, 1000, "a 1000-cent negative position");
    negativeLines.push(lineId);
    negativePurchases.push(p);
  }
  return { seller, ag: a.ag, negativeLines, receivingLines, receivingPurchases, negativePurchases };
}

/** An offset of a negative line against a receiving line of its seller, written on the given session (the commission service by default). */
export function offsetOn(c: Client, seller: Seller, negativeLineId: string, againstLineId: string, cents: number): Promise<unknown> {
  return c.query(
    "INSERT INTO kauro.commission_offsets (offset_id, seller_id, negative_line_id, against_line_id, amount_cents, agreement_id, recorded_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), now())",
    [ids.next(), seller.sellerId, negativeLineId, againstLineId, cents, seller.agreementId],
  );
}

/** The commission service records an offset in its own transaction. */
export const offset = (ow: OffsetWorld, seller: Seller, negativeLineId: string, againstLineId: string, cents: number): Promise<unknown> =>
  within(ow.w.commission, corporate, (c) => offsetOn(c, seller, negativeLineId, againstLineId, cents));

export const offsetsOf = async (ow: OffsetWorld, seller: Seller): Promise<ReadonlyArray<readonly [string, string, number]>> =>
  (await ow.w.h.oracle.query<{ n: string; a: string; cents: number }>("SELECT negative_line_id AS n, against_line_id AS a, amount_cents::int AS cents FROM kauro.commission_offsets WHERE seller_id = $1 ORDER BY recorded_at, offset_id", [seller.sellerId])).rows.map(
    (r) => [r.n, r.a, r.cents] as const,
  );

/** Live cents of every offset of a seller, in recording order. */
export const liveOf = async (ow: OffsetWorld, seller: Seller): Promise<ReadonlyArray<number>> =>
  (await ow.w.h.oracle.query<{ live: number }>(
    "SELECT (o.amount_cents - coalesce((SELECT sum(r.amount_cents) FROM kauro.commission_offset_releases r WHERE r.offset_id = o.offset_id), 0))::int AS live FROM kauro.commission_offsets o WHERE o.seller_id = $1 ORDER BY o.recorded_at, o.offset_id",
    [seller.sellerId],
  )).rows.map((r) => r.live);

/** Releases of a seller as [live-amount cause, cents], in recording order. */
export const releasesOf = async (ow: OffsetWorld, seller: Seller): Promise<ReadonlyArray<readonly [string, number]>> =>
  (await ow.w.h.oracle.query<{ cause: string; cents: number }>(
    "SELECT cause, amount_cents::int AS cents FROM kauro.commission_offset_releases WHERE seller_id = $1 ORDER BY recorded_at, release_id",
    [seller.sellerId],
  )).rows.map((r) => [r.cause, r.cents] as const);

/** The owner opens a hold of `cents` on a line (the dispute path, B12; the kit opens it as the owner). */
export function openHoldOn(c: Client, lineId: string, cents: number, reason: "SELLER_DISPUTE" | "FUNDS_HELD" = "SELLER_DISPUTE"): Promise<unknown> {
  const reviewAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
  return new PgCommissionLedgerRepository(c, ids).openHold({ holdId: ids.next() as never, lineId: lineId as CommissionLineId, amountCents: BigInt(cents), reason, reviewAt: reviewAt as never, openedAt: clock.now() });
}
export const openHold = (ow: OffsetWorld, lineId: string, cents: number): Promise<unknown> => within(ow.w.app, ownerOf(ow.w), (c) => openHoldOn(c, lineId, cents));

export type { Agency, Purchase, Seller, World };

/** A further dated period (month 2026-11, closing 2026-12-04, paying 2026-12-11) for statements of receiving lines. */
export const extraPeriod = (ow: OffsetWorld): Promise<string> => september(ow.w, ow.calendarId, "TEST_FIXTURE", ["2026-12-07", "2026-12-14"], "2026-11-01");

/** One side of a two-transaction race: the runtime role, its bound context and the work (run inside one transaction). */
export interface Op<T> {
  readonly role: LoginRole;
  readonly ctx: CommerceContext;
  readonly run: (c: Client) => Promise<T>;
}
export const asCommission = <T>(run: (c: Client) => Promise<T>, ctx: CommerceContext = corporate): Op<T> => ({ role: "kauro_commission_test", ctx, run });
export const asOwner = <T>(ow: OffsetWorld, run: (c: Client) => Promise<T>): Op<T> => ({ role: "kauro_app_test", ctx: ownerOf(ow.w), run });

export interface Raced<A, B> {
  readonly first: A;
  readonly second: PromiseSettledResult<B>;
  /** True when the second transaction was observed waiting on a lock the first held (it did not finish by itself). */
  readonly waited: boolean;
}

/**
 * Both orders of a race are fixed by running one side first: a runs its work and stays open (uncommitted); b starts on another session and is
 * observed either finishing or waiting on a lock; a commits; the outcome of b is reported (21 "Concurrency and crash matrix").
 */
export async function ordered<A, B>(ow: OffsetWorld, a: Op<A>, b: Op<B>, options: { readonly holdMs?: number } = {}): Promise<Raced<A, B>> {
  const ca = await ow.w.h.pg.connect(a.role);
  const cb = await ow.w.h.pg.connect(b.role);
  try {
    const locked = barrier();
    const release = barrier();
    const pa = handled(
      within(ca, a.ctx, async (c) => {
        const out = await a.run(c);
        locked.open();
        await release.wait;
        return out;
      }),
    );
    await Promise.race([locked.wait, pa]);
    const pidB = await backendPid(cb);
    const pb = handled(within(cb, b.ctx, b.run));
    const observed = await settlesOrWaits(ow.w.h.oracle, pidB, pb, "the second transaction");
    if (options.holdMs !== undefined && observed.kind === "WAITING") await new Promise((resolve) => setTimeout(resolve, options.holdMs));
    release.open();
    const first = await pa;
    if (observed.kind === "WAITING") return { first, second: await observed.pending, waited: true };
    return { first, second: observed.outcome, waited: false };
  } finally {
    await ca.end();
    await cb.end();
  }
}
