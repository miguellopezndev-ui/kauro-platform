// The schema of B10's commission ledger, periods, statements and payouts (migrations 0030 and 0031; docs/design/B10-commercial-
// domain.md §6, §7, §8, §9; case map docs/design/B10-case-map.md) on real PostgreSQL 17 through the runtime login roles: the
// commission service (kauro_commission_test: the COMMISSIONS consumer in the agency of its event, its sweeps, CMD051 and — as the
// finance service — CMD053), the corporate owner (kauro_app_test, CMD052), the sellers, the agencies' request handlers and the payment
// service; the superuser only reads, and probes a refusal no grant stands in front of. Amounts are the worked examples' integer cents,
// written here as the oracle. Every guard is shown by the forbidden write refused beside the legitimate write that commits (21
// "Positive and negative symmetry"). The tests assert the raw KC SQLSTATEs; their translation is the stage-2 lanes' (design §12).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { STATE_MACHINES } from "@kauro/contracts";
import { COMMERCIAL_PLATFORM_MACHINES } from "@kauro/domain";
import { RUNTIME_ROLES } from "../src/index.js";
import {
  accrue,
  acquired,
  activeSeller,
  agencyWith,
  approvePayout,
  assertSeeded,
  acceptAttribution,
  changeDestination,
  closeWorld,
  completedRefund,
  completion,
  corporate,
  digest,
  fixtureCalendar,
  funds,
  ids,
  issueStatement,
  makeEligible,
  openWorld,
  oracleProbe,
  ownerOf,
  payLines,
  personOf,
  prepareAllocation,
  purchase,
  reconcile,
  reconcileIn,
  refusedWith,
  repayable,
  registerProspect,
  september,
  service,
  sha,
  statementFor,
  submitClaim,
  within,
  type Agency,
  type Purchase,
  type Seller,
  type World,
} from "./b10-commission-support.js";

let w: World;
/** The October 2026 period every payout of this file closes into (one statement per seller): dated by example 21's fixture calendar. */
let october: string;

before(async () => {
  w = await openWorld("b10-ledger");
  october = await september(w, await fixtureCalendar(w), "TEST_FIXTURE", ["2026-11-06", "2026-11-13"], "2026-10-01");
});
after(async () => {
  await closeWorld(w);
});

const platformMachine = (name: string) => {
  const m = COMMERCIAL_PLATFORM_MACHINES.find((x) => x.contract === name);
  assert.ok(m, `${name} is a platform machine of @kauro/domain`);
  return m;
};

/** The sellers in ascending id order: the largest-remainder tie goes to the first (policy splitRemainder). */
const byId = (a: Seller, b: Seller): [Seller, Seller] => (a.sellerId < b.sellerId ? [a, b] : [b, a]);

const lineRow = async (lineId: string) =>
  (await w.h.oracle.query<{ state: string; cumulative: string; paid: string | null; basis: string }>(
    "SELECT state, cumulative_entitlement_cents::text AS cumulative, paid_cents::text AS paid, net_service_basis_cents::text AS basis FROM kauro.commission_lines WHERE line_id = $1",
    [lineId],
  )).rows[0]!;

/** The first-purchase pool of example 1 for an agency acquired by one seller: basis 97125 at 1000 bps is 9713 cents. */
async function firstLine(label: string, seller: Seller): Promise<{ ag: Agency; first: Purchase; lineId: string; poolId: string }> {
  const { ag, allocationId, first, entitlements } = await acquired(w, `B10 ${label}`, [{ seller, shareBps: 10000 }], { foundingFixture: true });
  const { poolId, lineOf } = await accrue(w, ag, first, allocationId, { rateKind: "FIRST", rateBps: 1000, basisCents: 97125, poolCents: 9713, sequence: 1 }, [
    { sellerId: seller.sellerId, entitlementId: entitlements.get(seller.sellerId)!, shareBps: 10000, cents: 9713 },
  ]);
  return { ag, first, lineId: lineOf.get(seller.sellerId)!, poolId };
}

/**
 * The COMMISSIONS consumer's adjustment of one pool after a completed service refund (D10-ADJ-1), in the agency it adopted: the pool
 * and each line at the new basis and cumulative entitlement, one adjustment per changed line naming the refund's event, and a PAID
 * line walked to ADJUSTED.
 */
async function adjust(ag: Agency, poolId: string, basis: number, poolCents: number, lines: ReadonlyArray<{ readonly lineId: string; readonly sellerId: string; readonly from: number; readonly to: number }>, sourceEventId: string): Promise<void> {
  await within(w.commission, service(ag.agencyId), async (c) => {
    await c.query("UPDATE kauro.commission_pools SET basis_cents = $2, pool_cents = $3, version = version + 1 WHERE pool_id = $1", [poolId, basis, poolCents]);
    for (const l of lines) {
      await c.query(
        `INSERT INTO kauro.commission_adjustments (adjustment_id, agency_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents, new_cumulative_entitlement_cents,
           new_basis_cents, source_event_id, agreement_version, created_at)
         SELECT $1, l.agency_id, l.line_id, l.seller_id, 1, 'REFUND', 'DECREASE', $3, $4, $5, $6, $7, e.agreement_version, kauro.server_now()
           FROM kauro.commission_lines l JOIN kauro.commission_entitlements e ON e.entitlement_id = l.entitlement_id WHERE l.line_id = $2`,
        [ids.next(), l.lineId, l.from - l.to, l.from, l.to, basis, sourceEventId],
      );
      await c.query(
        "UPDATE kauro.commission_lines SET net_service_basis_cents = $2, cumulative_entitlement_cents = $3, state = CASE WHEN state = 'PAID' THEN 'ADJUSTED' ELSE state END, version = version + 1 WHERE line_id = $1",
        [l.lineId, basis, l.to],
      );
    }
  });
}

// --- R2-097 ------------------------------------------------------------------------------------------------------------------------------

test("R2-097 at the database: a pool's cents equal round(basis x rate) and its lines' allocations sum to it at COMMIT (KC002), one pool exists per purchase and source, and an allocation's shares sum to 10000 bps (KC003)", async () => {
  const registryLine = STATE_MACHINES.find((m) => m.contract === "CommissionLine")!;
  await assertSeeded(w, registryLine);
  const a = await activeSeller(w, "r097-a");
  const b = await activeSeller(w, "r097-b");
  // example 8: a first-project pool of 97125 service cents at 1000 bps, split 6000/4000
  const { ag, allocationId, first, entitlements } = await acquired(w, "B10 R2-097", [{ seller: a, shareBps: 6000 }, { seller: b, shareBps: 4000 }], { foundingFixture: true });
  const lines = (aCents: number, bCents: number) => [
    { sellerId: a.sellerId, entitlementId: entitlements.get(a.sellerId)!, shareBps: 6000, cents: aCents },
    { sellerId: b.sellerId, entitlementId: entitlements.get(b.sellerId)!, shareBps: 4000, cents: bCents },
  ];
  const pool = (poolCents: number, rateBps = 1000) => ({ rateKind: "FIRST" as const, rateBps, basisCents: 97125, poolCents, sequence: 1 });
  // 9712.5 rounds half-up once to 9713: a 9712-cent pool is refused at COMMIT, even with lines summing to it (KC002)
  await assert.rejects(accrue(w, ag, first, allocationId, pool(9712), lines(5827, 3885)), refusedWith("KC002"));
  // the lines' allocations sum to exactly the pool: 5828 + 3884 is refused (KC002)
  await assert.rejects(accrue(w, ag, first, allocationId, pool(9713), lines(5828, 3884)), refusedWith("KC002"));
  // the pool has the frozen allocation's first rate for the sticky first designation, never another
  await assert.rejects(accrue(w, ag, first, allocationId, pool(3885, 400), lines(2331, 1554)), refusedWith("23514", "commission_pools_terms"));
  // largest remainder: 5827.8 and 3885.2 floor to 5827 and 3885, and the one remaining cent goes to the larger fraction
  const accrued = await accrue(w, ag, first, allocationId, pool(9713), lines(5828, 3885));
  assert.deepEqual(
    (await w.h.oracle.query("SELECT l.seller_id, l.state, l.cumulative_entitlement_cents::int AS cents, l.previous_posted_cents::int AS posted, p.pool_cents::int AS pool FROM kauro.commission_lines l JOIN kauro.commission_pools p USING (pool_id) WHERE p.pool_id = $1 ORDER BY 3 DESC", [accrued.poolId])).rows,
    [
      { seller_id: a.sellerId, state: "ACCRUED_PENDING", cents: 5828, posted: 5828, pool: 9713 },
      { seller_id: b.sellerId, state: "ACCRUED_PENDING", cents: 3885, posted: 3885, pool: 9713 },
    ],
  );
  // one pool per purchase and source: a second ACQUISITION pool of the purchase is refused
  await assert.rejects(accrue(w, ag, first, allocationId, pool(9713), lines(5828, 3885)), refusedWith("23505", "commission_pools_one_per_purchase_source"));
  // a pool's basis, rate and cents rewritten out of step with its lines are refused at COMMIT (KC002), and a basis never rises (KC015)
  await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_pools SET pool_cents = 9714, version = version + 1 WHERE pool_id = $1", [accrued.poolId])), refusedWith("KC002"));
  await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_pools SET basis_cents = 97126, version = version + 1 WHERE pool_id = $1", [accrued.poolId])), refusedWith("KC015"));
  // only the commission service writes the ledger: the owner, a seller and the agency are refused (42501)
  for (const [ctx, who] of [[ownerOf(w), "owner"], [personOf(a.userId), "seller"]] as const) {
    await assert.rejects(within(w.app, ctx, (c) => c.query("UPDATE kauro.commission_lines SET cumulative_entitlement_cents = 0 WHERE pool_id = $1", [accrued.poolId])), refusedWith("42501"), who);
  }

  // an allocation's shares sum to exactly 10000 bps when it is frozen (KC003)
  const other = await agencyWith(w, "B10 R2-097 other");
  const prospect = await registerProspect(w, a, "r097-other.example");
  const ca = await submitClaim(w, a, prospect);
  const cb = await submitClaim(w, b, prospect);
  const uneven = await prepareAllocation(w, other, prospect, [{ seller: a, claimId: ca, shareBps: 5000 }, { seller: b, claimId: cb, shareBps: 4999 }]);
  await assert.rejects(acceptAttribution(w, other, uneven, [ca, cb]), refusedWith("KC003"));
  const even = await prepareAllocation(w, other, prospect, [{ seller: a, claimId: ca, shareBps: 5000 }, { seller: b, claimId: cb, shareBps: 5000 }]);
  await acceptAttribution(w, other, even, [ca, cb]);
});

// --- R2-101 ------------------------------------------------------------------------------------------------------------------------------

test("R2-101 at the database: a line becomes ELIGIBLE only with a FINAL completion of its purchase at least 720 hours old and its capture's funds AVAILABLE (KC007)", async () => {
  await assertSeeded(w, platformMachine("CommissionHold"));
  const s = await activeSeller(w, "r101-s");
  const { ag, first, lineId } = await firstLine("R2-101", s);
  const eligibleCiting = (completionId: string, afterSeconds: number) =>
    within(w.commission, corporate, async (c) => {
      await c.query(
        `SELECT set_config('kauro_test.clock_offset_seconds', (extract(epoch FROM (pc.completed_at - transaction_timestamp())) + $2::numeric)::text, true)
           FROM kauro.purchase_completions pc WHERE pc.completion_id = $1`,
        [completionId, afterSeconds],
      );
      return c.query(
        "UPDATE kauro.commission_lines l SET state = 'ELIGIBLE', eligible_at = pc.completed_at + interval '720 hours', final_completion_id = pc.completion_id, version = l.version + 1 FROM kauro.purchase_completions pc WHERE l.line_id = $1 AND pc.completion_id = $2",
        [lineId, completionId],
      );
    });
  // a STAGE completion starts no clock (example 15): citing it as the eligibility milestone is refused, however long after
  const stage = await completion(w, ag, first, "STAGE");
  await funds(w, ag, first, "AVAILABLE", 2);
  await assert.rejects(eligibleCiting(stage, 720 * 3600), refusedWith("KC007"), "a STAGE completion");
  // the FINAL completion, but the capture's funds held by the provider at a later capture version (example 14): refused
  const final = await completion(w, ag, first, "FINAL");
  await funds(w, ag, first, "HELD", 3);
  await assert.rejects(makeEligible(w, lineId), refusedWith("KC007"), "funds HELD");
  // the funds AVAILABLE at the next version, but a hold of the whole unpaid amount still covers the line: refused
  await funds(w, ag, first, "AVAILABLE", 4);
  const holdId = ids.next();
  await within(w.commission, corporate, (c) =>
    c.query(
      "INSERT INTO kauro.commission_holds (hold_id, agency_id, line_id, seller_id, amount_cents, reason, review_at, opened_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 9713, 'FUNDS_HELD', kauro.server_now() + interval '7 days', kauro.server_now(), now(), now())",
      [holdId, ag.agencyId, lineId, s.sellerId],
    ),
  );
  await assert.rejects(makeEligible(w, lineId), refusedWith("KC007"), "a covering hold");
  await within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_holds SET state = 'RELEASED', released_at = kauro.server_now(), version = version + 1 WHERE hold_id = $1", [holdId]));
  // a recent FINAL completion: one second short of 720 hours is refused, exactly 720 hours admitted
  await assert.rejects(makeEligible(w, lineId, 720 * 3600 - 1), refusedWith("KC007"), "719:59:59 after the FINAL completion");
  await makeEligible(w, lineId);
  const eligible = await w.h.oracle.query<{ state: string; hours: number; completion: string }>(
    "SELECT l.state, (extract(epoch FROM l.eligible_at - pc.completed_at) / 3600)::int AS hours, l.final_completion_id::text AS completion FROM kauro.commission_lines l JOIN kauro.purchase_completions pc ON pc.completion_id = l.final_completion_id WHERE l.line_id = $1",
    [lineId],
  );
  assert.deepEqual(eligible.rows, [{ state: "ELIGIBLE", hours: 720, completion: final }]);
  // a hold is at most the unpaid amount, and a line is HELD only under an OPEN hold of all of it
  await assert.rejects(
    within(w.commission, corporate, (c) =>
      c.query("INSERT INTO kauro.commission_holds (hold_id, agency_id, line_id, seller_id, amount_cents, reason, review_at, opened_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 9714, 'SELLER_DISPUTE', kauro.server_now() + interval '7 days', kauro.server_now(), now(), now())", [ids.next(), ag.agencyId, lineId, s.sellerId]),
    ),
    refusedWith("23514", "commission_holds_within_unpaid"),
  );
  // the completions are append-only facts, one FINAL per purchase
  await assert.rejects(completion(w, ag, first, "FINAL"), refusedWith("23505", "purchase_completions_one_final"));
  await oracleProbe(w, "UPDATE kauro.purchase_completions SET completed_at = now() WHERE completion_id = $1", [final], refusedWith("KA004"), "completions are append-only");
});

// --- R2-104 ------------------------------------------------------------------------------------------------------------------------------

test("R2-104 at the database: an offset against a later line is refused without SIGNED_FUTURE_OFFSET terms (KC017), a PAID line moves to ADJUSTED with an appended adjustment, and its paid cents and payout rows never change", async () => {
  const s = await activeSeller(w, "r104-s", { offsetTerms: "NONE" });
  const t = await activeSeller(w, "r104-t", { offsetTerms: "SIGNED_FUTURE_OFFSET" });
  const [lo, hi] = byId(s, t);
  const { ag, allocationId, first, entitlements } = await acquired(w, "B10 R2-104", [{ seller: s, shareBps: 5000 }, { seller: t, shareBps: 5000 }], { foundingFixture: true });
  const entitlementOf = (x: Seller) => entitlements.get(x.sellerId)!;
  // the first purchase: 9713 split 5000/5000 is 4856.5 each; the tied cent goes to the lower seller id
  const firstPool = await accrue(w, ag, first, allocationId, { rateKind: "FIRST", rateBps: 1000, basisCents: 97125, poolCents: 9713, sequence: 1 }, [
    { sellerId: lo.sellerId, entitlementId: entitlementOf(lo), shareBps: 5000, cents: 4857 },
    { sellerId: hi.sellerId, entitlementId: entitlementOf(hi), shareBps: 5000, cents: 4856 },
  ]);
  // examples 2 and 7: the second project, for another end client, quoted at 123025 (500 bps) and accruing 4921 at 400 bps
  const second = await purchase(w, ag, "r104-second", { qualifying: [first.projectId], client: 1 });
  assert.equal(second.quote.serviceCents, 123025);
  const repeat = await accrue(w, ag, second, allocationId, { rateKind: "REPEAT", rateBps: 400, basisCents: 123025, poolCents: 4921, sequence: 2 }, [
    { sellerId: lo.sellerId, entitlementId: entitlementOf(lo), shareBps: 5000, cents: 2461 },
    { sellerId: hi.sellerId, entitlementId: entitlementOf(hi), shareBps: 5000, cents: 2460 },
  ]);
  const loRepeat = repeat.lineOf.get(lo.sellerId)!;
  const hiRepeat = repeat.lineOf.get(hi.sellerId)!;
  // both repeat lines are paid: completion, available funds, eligibility, the October statement, the owner's approval, settled evidence
  const paid = await payLines(w, ag, second, october, [{ seller: lo, lineId: loRepeat }, { seller: hi, lineId: hiRepeat }]);
  assert.deepEqual([await lineRow(loRepeat), await lineRow(hiRepeat)], [
    { state: "PAID", cumulative: "2461", paid: "2461", basis: "123025" },
    { state: "PAID", cumulative: "2460", paid: "2460", basis: "123025" },
  ]);
  const payoutRows = () =>
    digest(
      w,
      `SELECT p.*, r.reconciliation_id, r.evidence_kind, r.evidence_hash AS reconciled_hash, s.state AS statement_state, s.payable_cents, s.payout_evidence_hash
         FROM kauro.payout_intents p JOIN kauro.payout_reconciliations r USING (intent_id) JOIN kauro.commission_statements s USING (statement_id) WHERE p.seller_id IN ($1, $2)`,
      [s.sellerId, t.sellerId],
    );
  const payoutsBefore = await payoutRows();

  // a 20000-cent service refund of the second project (examples 6 and 7): its basis falls to 103025 and its pool to 4121
  const refundEvent = await completedRefund(w, ag, second, 20000);
  // a PAID line walks to ADJUSTED only with an adjustment appended (KC015), and an adjustment is exactly the cumulative difference
  await assert.rejects(
    within(w.commission, service(ag.agencyId), (c) => c.query("UPDATE kauro.commission_lines SET state = 'ADJUSTED', version = version + 1 WHERE line_id = $1", [loRepeat])),
    refusedWith("KC015"),
  );
  await assert.rejects(
    within(w.commission, service(ag.agencyId), (c) =>
      c.query(
        "INSERT INTO kauro.commission_adjustments (adjustment_id, agency_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents, new_cumulative_entitlement_cents, new_basis_cents, source_event_id, agreement_version, created_at) VALUES ($1, $2, $3, $4, 1, 'REFUND', 'DECREASE', 401, 2461, 2061, 103025, $5, $6, kauro.server_now())",
        [ids.next(), ag.agencyId, loRepeat, lo.sellerId, refundEvent, lo.agreementVersion],
      ),
    ),
    refusedWith("KC015"),
    "an adjustment that is not the cumulative difference",
  );
  // the lines' new allocations sum to exactly the new pool (2061 + 2061 is refused at COMMIT, KC002)
  await assert.rejects(adjust(ag, repeat.poolId, 103025, 4121, [{ lineId: loRepeat, sellerId: lo.sellerId, from: 2461, to: 2061 }, { lineId: hiRepeat, sellerId: hi.sellerId, from: 2460, to: 2061 }], refundEvent), refusedWith("KC002"));
  // 4121 split 5000/5000 is 2060.5 each: the tied cent again to the lower id — each line decreases by exactly 400
  await adjust(ag, repeat.poolId, 103025, 4121, [{ lineId: loRepeat, sellerId: lo.sellerId, from: 2461, to: 2061 }, { lineId: hiRepeat, sellerId: hi.sellerId, from: 2460, to: 2060 }], refundEvent);
  assert.deepEqual([await lineRow(loRepeat), await lineRow(hiRepeat)], [
    { state: "ADJUSTED", cumulative: "2061", paid: "2461", basis: "103025" },
    { state: "ADJUSTED", cumulative: "2060", paid: "2460", basis: "103025" },
  ]);
  const adjustments = await w.h.oracle.query("SELECT line_id, reason, direction, amount_cents::int AS amount, previous_cumulative_cents::int AS previous, new_cumulative_entitlement_cents::int AS cumulative, source_event_id FROM kauro.commission_adjustments WHERE line_id IN ($1, $2) ORDER BY 1", [loRepeat, hiRepeat]);
  assert.deepEqual(adjustments.rows, [
    { line_id: loRepeat, reason: "REFUND", direction: "DECREASE", amount: 400, previous: 2461, cumulative: 2061, source_event_id: refundEvent },
    { line_id: hiRepeat, reason: "REFUND", direction: "DECREASE", amount: 400, previous: 2460, cumulative: 2060, source_event_id: refundEvent },
  ].sort((x, y) => (x.line_id < y.line_id ? -1 : 1)));
  // a replay of the same refund event adds nothing: one adjustment per line and source event
  await assert.rejects(
    within(w.commission, service(ag.agencyId), (c) =>
      c.query(
        "INSERT INTO kauro.commission_adjustments (adjustment_id, agency_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents, new_cumulative_entitlement_cents, new_basis_cents, source_event_id, agreement_version, created_at) VALUES ($1, $2, $3, $4, 2, 'REFUND', 'DECREASE', 1, 2061, 2060, 103025, $5, $6, kauro.server_now())",
        [ids.next(), ag.agencyId, loRepeat, lo.sellerId, refundEvent, lo.agreementVersion],
      ),
    ),
    refusedWith("23505", "commission_adjustments_one_per_line_event"),
  );

  // the negative positions (paid 2461 and 2460, entitled 2061 and 2060: -400 each) against the first project's later eligible lines
  await completion(w, ag, first, "FINAL");
  await funds(w, ag, first, "AVAILABLE", 2);
  for (const x of [s, t]) await makeEligible(w, firstPool.lineOf.get(x.sellerId)!);
  const offset = (x: Seller, amount: number) =>
    within(w.commission, corporate, (c) =>
      c.query(
        "INSERT INTO kauro.commission_offsets (offset_id, seller_id, negative_line_id, against_line_id, amount_cents, agreement_id, recorded_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), now())",
        [ids.next(), x.sellerId, repeat.lineOf.get(x.sellerId)!, firstPool.lineOf.get(x.sellerId)!, amount, x.agreementId],
      ),
    );
  // without SIGNED_FUTURE_OFFSET terms nothing is offset (KC017): the statement carries an owner recovery item instead (D10-NEG-1)
  await assert.rejects(offset(s, 400), refusedWith("KC017"));
  // under signed future-offset terms the negative position offsets the later line, never beyond it
  await offset(t, 400);
  await assert.rejects(offset(t, 1), refusedWith("23514", "commission_offsets_amount"));
  // the offset names the agreement the negative line was earned under, never another agreement of the seller (KC017)
  await assert.rejects(
    within(w.commission, corporate, (c) =>
      c.query(
        "INSERT INTO kauro.commission_offsets (offset_id, seller_id, negative_line_id, against_line_id, amount_cents, agreement_id, recorded_at, created_at) VALUES ($1, $2, $3, $4, 1, $5, kauro.server_now(), now())",
        [ids.next(), s.sellerId, repeat.lineOf.get(s.sellerId)!, firstPool.lineOf.get(s.sellerId)!, t.agreementId],
      ),
    ),
    refusedWith("KC017"),
  );

  // the paid cents and the payout rows never change: the commission service's rewrite of paid cents is refused (KA004), nobody holds
  // the intent's amount or a reconciliation (42501), and the tables refuse the change to anyone
  await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_lines SET paid_cents = 2061, version = version + 1 WHERE line_id = $1", [loRepeat])), refusedWith("KA004"));
  const intentId = paid.get(lo.sellerId)!.intentId;
  for (const [client, ctx] of [[w.commission, corporate], [w.app, ownerOf(w)]] as const) {
    await assert.rejects(within(client, ctx, (c) => c.query("UPDATE kauro.payout_intents SET amount_cents = 2061 WHERE intent_id = $1", [intentId])), refusedWith("42501"));
    await assert.rejects(within(client, ctx, (c) => c.query("UPDATE kauro.payout_reconciliations SET amount_cents = 2061 WHERE intent_id = $1", [intentId])), refusedWith("42501"));
  }
  await oracleProbe(w, "UPDATE kauro.commission_lines SET paid_cents = 2061, version = version + 1 WHERE line_id = $1", [loRepeat], refusedWith("KA004"), "paid cents");
  await oracleProbe(w, "UPDATE kauro.payout_intents SET amount_cents = 2061, version = version + 1 WHERE intent_id = $1", [intentId], refusedWith("KA004"), "the intent's amount");
  await oracleProbe(w, "UPDATE kauro.payout_reconciliations SET evidence_hash = $2 WHERE intent_id = $1", [intentId, sha("rewritten")], refusedWith("KA004"), "a reconciliation");
  assert.equal(await payoutRows(), payoutsBefore, "the payouts and their evidence are exactly as they were paid");
  assert.deepEqual((await lineRow(loRepeat)).paid, "2461");
});

// --- R2-139 ------------------------------------------------------------------------------------------------------------------------------

test("R2-139 at the database: a period's close and pay dates are stored with the calendar version they came from, and a statement closed on a TEST_FIXTURE calendar is labelled SIMULATED", async () => {
  await assertSeeded(w, platformMachine("CommissionPeriod"));
  // example 21: weekends and 2026-10-12 nonbanking, the 5th and 10th banking days after September 2026 are 2026-10-07 and 2026-10-15;
  // the same calendar without that holiday gives 2026-10-07 and 2026-10-14
  const holiday = await fixtureCalendar(w, "TEST_FIXTURE", ["2026-10-12"]);
  const noHoliday = await fixtureCalendar(w, "TEST_FIXTURE", []);
  const days = await w.h.oracle.query<{ calendar_id: string; fifth: string; tenth: string }>(
    `SELECT c.calendar_id, kauro.banking_day_after('2026-09-30', 5, c.nonbanking_dates, c.covers_from, c.covers_to)::text AS fifth,
            kauro.banking_day_after('2026-09-30', 10, c.nonbanking_dates, c.covers_from, c.covers_to)::text AS tenth
       FROM kauro.banking_calendars c WHERE c.calendar_id IN ($1, $2)`,
    [holiday, noHoliday],
  );
  const dayOf = new Map(days.rows.map((r) => [r.calendar_id, [r.fifth, r.tenth]]));
  assert.deepEqual([dayOf.get(holiday), dayOf.get(noHoliday)], [["2026-10-07", "2026-10-15"], ["2026-10-07", "2026-10-14"]]);
  // the September period stores its dates with the calendar they came from: the other calendar's pay date, a calendar named with the
  // wrong source and a calendar that does not cover the dates are refused
  await assert.rejects(september(w, holiday, "TEST_FIXTURE", ["2026-10-07", "2026-10-14"]), refusedWith("23514", "commission_periods_banking_days"));
  await assert.rejects(september(w, holiday, "VERIFIED_FEED", ["2026-10-07", "2026-10-15"]), refusedWith("23503", "commission_periods_calendar_fk"));
  await assert.rejects(september(w, holiday, "TEST_FIXTURE", ["2026-09-07", "2026-09-14"], "2026-08-01"), refusedWith("23514", "commission_periods_banking_days"), "August's dates lie before the calendar's coverage");
  const periodId = await september(w, holiday);
  const stored = await w.h.oracle.query("SELECT state, calendar_id, calendar_source, close_due_on::text AS close, pay_due_on::text AS pay, starts_at, ends_at FROM kauro.commission_periods WHERE period_id = $1", [periodId]);
  assert.deepEqual(stored.rows, [{ state: "OPEN", calendar_id: holiday, calendar_source: "TEST_FIXTURE", close: "2026-10-07", pay: "2026-10-15", starts_at: new Date("2026-09-01T05:00:00Z"), ends_at: new Date("2026-10-01T05:00:00Z") }]);
  // the dates, once stored with their calendar, never change
  await assert.rejects(
    within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_periods SET pay_due_on = '2026-10-14', version = version + 1 WHERE period_id = $1", [periodId])),
    refusedWith("23514", "commission_periods_banking_days"),
  );
  await oracleProbe(w, "UPDATE kauro.commission_periods SET calendar_id = $2, version = version + 1 WHERE period_id = $1", [periodId, noHoliday], refusedWith("23514", "commission_periods_banking_days"), "the period keeps its calendar's dates");
  await oracleProbe(w, "UPDATE kauro.commission_periods SET calendar_id = $2, pay_due_on = '2026-10-14', version = version + 1 WHERE period_id = $1", [periodId, noHoliday], refusedWith("KA004"), "even with the other calendar's own dates");

  // a statement closed on this TEST_FIXTURE calendar is labelled SIMULATED, with its period's dates and calendar
  const s = await activeSeller(w, "r139-s");
  const insertStatement = (label: string, payDate: string) =>
    within(w.commission, corporate, (c) =>
      c.query(
        `INSERT INTO kauro.commission_statements (statement_id, period_id, seller_id, period_starts_at, period_ends_at, calendar_id, calendar_source, statement_date, pay_date, label,
           accrued_pending_cents, held_cents, payable_cents, paid_to_date_cents, negative_balance_cents, cutoff_hash, created_at, updated_at)
         SELECT $1, p.period_id, $2, p.starts_at, p.ends_at, p.calendar_id, p.calendar_source, p.close_due_on, $3::date, $4, 0, 0, 0, 0, 0, $5, now(), now() FROM kauro.commission_periods p WHERE p.period_id = $6`,
        [ids.next(), s.sellerId, payDate, label, sha("cutoff"), periodId],
      ),
    );
  await assert.rejects(insertStatement("VERIFIED_CALENDAR", "2026-10-15"), refusedWith("23514", "commission_statements_simulated_label"));
  await assert.rejects(insertStatement("SIMULATED", "2026-10-14"), refusedWith("23503", "commission_statements_dates_fk"));
  const statement = await within(w.commission, corporate, (c) => statementFor(c, periodId, s, []));
  const closed = await w.h.oracle.query("SELECT state, label, statement_date::text AS statement_date, pay_date::text AS pay_date, calendar_id, calendar_source FROM kauro.commission_statements WHERE statement_id = $1", [statement.statementId]);
  assert.deepEqual(closed.rows, [{ state: "ISSUED", label: "SIMULATED", statement_date: "2026-10-07", pay_date: "2026-10-15", calendar_id: holiday, calendar_source: "TEST_FIXTURE" }]);
  // the period closes on its calendar with the cutoff hash it closed on, at the server's instant, once
  await within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_periods SET state = 'CLOSED', cutoff_hash = $2, closed_at = kauro.server_now(), version = version + 1 WHERE period_id = $1", [periodId, sha("cutoff")]));
  await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_periods SET state = 'OPEN', version = version + 1 WHERE period_id = $1", [periodId])), refusedWith("KA008"));
  await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_periods SET closed_at = NULL, version = version + 1 WHERE period_id = $1", [periodId])), refusedWith("KA004"));
  // calendars are append-only records
  await oracleProbe(w, "UPDATE kauro.banking_calendars SET nonbanking_dates = '{}' WHERE calendar_id = $1", [holiday], refusedWith("KA004"), "calendars are append-only");
});

// --- CMD050 ------------------------------------------------------------------------------------------------------------------------------

/** Every table of package B10 (migrations 0028..0031). */
const B10_TABLES = [
  "commercial_transitions", "founding_slots", "founding_slot_reservations", "agency_recurrence", "qualifying_purchases", "quote_issuances", "service_agreement_versions",
  "agency_agreement_acceptances", "agency_closures", "agency_relationship_decisions",
  "sellers", "seller_legal_reviews", "seller_agreements", "seller_assessments", "seller_confidentiality_acceptances", "seller_tax_documents", "seller_payout_destinations",
  "prospect_source_evidence", "prospect_contacts", "prospects", "prospect_suppressions", "claim_evidence", "attribution_allocations", "attribution_claims", "allocation_shares",
  "assistance_agreements", "commission_entitlements", "service_assignments", "account_assignments", "sales_accounts", "termination_manifests", "seller_terminations",
  "termination_tail_entries",
  "purchase_completions", "commission_pools", "commission_lines", "commission_adjustments", "commission_holds", "capture_funds_observations", "commission_offsets",
  "banking_calendars", "commission_periods", "commission_statements", "statement_items", "payout_intents", "payout_reconciliations", "compensation_guard_reviews",
] as const;

test("CMD050 at the database: no runtime role holds DELETE on any B10 table, and a terminated seller's lines, adjustments, statements and payout rows are unchanged by the termination", async () => {
  // the privilege matrix: no runtime group deletes or truncates a B10 row, and every B10 table refuses a delete to anyone by trigger
  const tables = await w.h.oracle.query<{ relname: string }>("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'kauro' AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY 1", [[...B10_TABLES]]);
  assert.deepEqual(tables.rows.map((r) => r.relname), [...B10_TABLES].sort(), "every B10 table exists");
  const privileges = await w.h.oracle.query<{ role: string; relname: string }>(
    `SELECT r.role, t.relname FROM unnest($1::text[]) AS r(role) CROSS JOIN unnest($2::text[]) AS t(relname)
      WHERE has_table_privilege(r.role, 'kauro.' || t.relname, 'DELETE') OR has_table_privilege(r.role, 'kauro.' || t.relname, 'TRUNCATE') ORDER BY 1, 2`,
    [[...RUNTIME_ROLES], [...B10_TABLES]],
  );
  assert.deepEqual(privileges.rows, [], "no runtime role deletes or truncates a B10 row");
  const guarded = await w.h.oracle.query<{ relname: string }>(
    `SELECT DISTINCT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'kauro' AND NOT g.tgisinternal AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 8) = 8 AND c.relname = ANY($1::text[]) ORDER BY 1`,
    [[...B10_TABLES]],
  );
  assert.deepEqual(guarded.rows.map((r) => r.relname), [...B10_TABLES].sort(), "every B10 table refuses a DELETE by trigger");

  // a seller with a paid, then refund-adjusted, first-project line (examples 1 and 7: 9713 paid, basis 77125 after a 20000 refund)
  const s = await activeSeller(w, "cmd050-s");
  const { ag, first, lineId, poolId } = await firstLine("CMD050", s);
  await payLines(w, ag, first, october, [{ seller: s, lineId }]);
  const refundEvent = await completedRefund(w, ag, first, 20000);
  await adjust(ag, poolId, 77125, 7713, [{ lineId, sellerId: s.sellerId, from: 9713, to: 7713 }], refundEvent);
  const ledgerOf = () =>
    Promise.all([
      digest(w, "SELECT * FROM kauro.commission_lines WHERE seller_id = $1", [s.sellerId]),
      digest(w, "SELECT * FROM kauro.commission_adjustments WHERE seller_id = $1", [s.sellerId]),
      digest(w, "SELECT * FROM kauro.commission_statements WHERE seller_id = $1", [s.sellerId]),
      digest(w, "SELECT * FROM kauro.statement_items WHERE seller_id = $1", [s.sellerId]),
      digest(w, "SELECT * FROM kauro.payout_intents WHERE seller_id = $1", [s.sellerId]),
      digest(w, "SELECT r.* FROM kauro.payout_reconciliations r JOIN kauro.payout_intents p USING (intent_id) WHERE p.seller_id = $1", [s.sellerId]),
    ]);
  const before_ = await ledgerOf();
  // CMD050's writes: the prepared terms and an empty manifest, the termination effective, the seller TERMINATED and its entitlement
  // keeping its residual
  const terminationId = ids.next();
  const manifestId = ids.next();
  await within(w.app, ownerOf(w), async (c) => {
    await c.query("INSERT INTO kauro.seller_terminations (termination_id, seller_id, terms_hash, prepared_by_user_id, prepared_at, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now(), now())", [terminationId, s.sellerId, sha(`terms-${terminationId}`), w.kora]);
    await c.query("INSERT INTO kauro.termination_manifests (manifest_id, seller_id, claim_ids, manifest_hash, prepared_by_user_id, prepared_at, created_at) VALUES ($1, $2, '{}'::uuid[], $3, $4, now(), now())", [manifestId, s.sellerId, sha(`manifest-${manifestId}`), w.kora]);
  });
  await within(w.app, ownerOf(w), async (c) => {
    await c.query("UPDATE kauro.seller_terminations SET manifest_id = $2, effective_at = kauro.server_now(), terminated_by_user_id = $3, version = version + 1 WHERE termination_id = $1", [terminationId, manifestId, w.kora]);
    await c.query("UPDATE kauro.sellers SET state = 'TERMINATED', terminated_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1", [s.sellerId]);
    await c.query("UPDATE kauro.commission_entitlements SET state = 'TERMINATED_WITH_RESIDUAL', terminated_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1", [s.sellerId]);
  });
  assert.deepEqual(await ledgerOf(), before_, "the termination left every ledger, statement and payout row of the seller as it was");
  assert.deepEqual((await w.h.oracle.query("SELECT state FROM kauro.commission_entitlements WHERE seller_id = $1", [s.sellerId])).rows, [{ state: "TERMINATED_WITH_RESIDUAL" }]);
  // no runtime role deletes any of them, and the terminated seller still reads its own statement (17 "Termination and tail")
  for (const [client, ctx] of [[w.app, ownerOf(w)], [w.commission, corporate]] as const) {
    for (const table of ["commission_lines", "commission_adjustments", "commission_statements", "statement_items", "payout_intents", "payout_reconciliations"]) {
      await assert.rejects(within(client, ctx, (c) => c.query(`DELETE FROM kauro.${table} WHERE true`)), refusedWith("42501"), table);
    }
  }
  assert.equal((await within(w.app, personOf(s.userId), (c) => c.query("SELECT 1 FROM kauro.commission_statements WHERE seller_id = $1", [s.sellerId]))).rowCount, 1);
  // a termination is effective once, at its own instant
  await assert.rejects(within(w.app, ownerOf(w), (c) => c.query("UPDATE kauro.seller_terminations SET effective_at = kauro.server_now() + interval '1 day', version = version + 1 WHERE termination_id = $1", [terminationId])), refusedWith("KA004"));
});

// --- CMD051 ------------------------------------------------------------------------------------------------------------------------------

test("CMD051 at the database: a line becomes PAYABLE only through an ISSUED statement item naming it, and a line without a FINAL completion 720 hours old or AVAILABLE funds cannot be ELIGIBLE (KC007)", async () => {
  await assertSeeded(w, platformMachine("CommissionStatement"));
  const s = await activeSeller(w, "cmd051-s");
  const t = await activeSeller(w, "cmd051-t");
  const { ag, first, lineId } = await firstLine("CMD051", s);
  // no ELIGIBLE line without the FINAL completion's 720 hours and the capture's AVAILABLE funds (KC007)
  await completion(w, ag, first, "FINAL");
  await assert.rejects(makeEligible(w, lineId), refusedWith("KC007"), "no funds observed");
  await funds(w, ag, first, "AVAILABLE", 2);
  await assert.rejects(makeEligible(w, lineId, 700 * 3600), refusedWith("KC007"), "700 hours after the FINAL completion");
  await makeEligible(w, lineId);

  const toPayable = (c: Client) => c.query("UPDATE kauro.commission_lines SET state = 'PAYABLE', version = version + 1 WHERE line_id = $1", [lineId]);
  // statement_closed: no statement at all, a DRAFT statement's item, and another seller's statement are refused
  await assert.rejects(within(w.commission, corporate, toPayable), refusedWith("23514", "commission_lines_payable_through_statement"), "no statement");
  await assert.rejects(
    within(w.commission, corporate, async (c) => {
      await statementFor(c, october, s, [lineId], { issue: false });
      await toPayable(c);
    }),
    refusedWith("23514", "commission_lines_payable_through_statement"),
    "a DRAFT statement's item",
  );
  await assert.rejects(within(w.commission, corporate, (c) => statementFor(c, october, t, [lineId])), refusedWith("23503", "statement_items_line_fk"), "another seller's statement");
  // an ISSUED statement's item naming the line makes it PAYABLE
  const statement = await issueStatement(w, october, s, [lineId]);
  assert.equal((await lineRow(lineId)).state, "PAYABLE");
  assert.equal(statement.payableCents, 9713);
  // the issued statement never changes: no further item, no rewritten total, nobody but the commission service writes one
  await assert.rejects(
    within(w.commission, corporate, (c) =>
      c.query("INSERT INTO kauro.statement_items (item_id, statement_id, seller_id, item_no, item_kind, disposition, line_id, payable_cents, created_at) VALUES ($1, $2, $3, 9, 'LINE', 'PAYABLE', $4, 0, now())", [ids.next(), statement.statementId, s.sellerId, lineId]),
    ),
    refusedWith("KA004"),
  );
  await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_statements SET payable_cents = 1, version = version + 1 WHERE statement_id = $1", [statement.statementId])), refusedWith("42501"));
  await oracleProbe(w, "UPDATE kauro.commission_statements SET payable_cents = 1, version = version + 1 WHERE statement_id = $1", [statement.statementId], refusedWith("KA004"), "the statement's totals");
  await oracleProbe(w, "UPDATE kauro.statement_items SET payable_cents = 1 WHERE statement_id = $1", [statement.statementId], refusedWith("KA004"), "the statement's items");
  // a statement's payable and held totals are its items' sums at its issue (named check at COMMIT): a payable no item carries is refused
  await assert.rejects(
    within(w.commission, corporate, async (c) => {
      const statementId = ids.next();
      await c.query(
        `INSERT INTO kauro.commission_statements (statement_id, period_id, seller_id, period_starts_at, period_ends_at, calendar_id, calendar_source, statement_date, pay_date, label,
           accrued_pending_cents, held_cents, payable_cents, paid_to_date_cents, negative_balance_cents, cutoff_hash, created_at, updated_at)
         SELECT $1, p.period_id, $2, p.starts_at, p.ends_at, p.calendar_id, p.calendar_source, p.close_due_on, p.pay_due_on, 'SIMULATED', 0, 0, 5, 0, 0, $3, now(), now() FROM kauro.commission_periods p WHERE p.period_id = $4`,
        [statementId, t.sellerId, sha(`cutoff-${statementId}`), october],
      );
      await c.query("UPDATE kauro.commission_statements SET state = 'ISSUED', issued_at = kauro.server_now(), version = version + 1 WHERE statement_id = $1", [statementId]);
    }),
    refusedWith("23514", "commission_statements_items_total"),
  );
  // the seller reads its statement and items; the other seller and the agency read none of them
  assert.equal((await within(w.app, personOf(s.userId), (c) => c.query("SELECT 1 FROM kauro.statement_items WHERE statement_id = $1", [statement.statementId]))).rowCount, 1);
  assert.equal((await within(w.app, personOf(t.userId), (c) => c.query("SELECT 1 FROM kauro.commission_statements WHERE statement_id = $1 UNION ALL SELECT 1 FROM kauro.commission_lines WHERE line_id = $2", [statement.statementId, lineId]))).rowCount, 0);
  assert.equal((await within(w.app, { agencyId: ag.agencyId, userId: ag.ownerUserId }, (c) => c.query("SELECT 1 FROM kauro.commission_statements UNION ALL SELECT 1 FROM kauro.commission_lines UNION ALL SELECT 1 FROM kauro.commission_pools"))).rowCount, 0);
});

// --- CMD052 ------------------------------------------------------------------------------------------------------------------------------

test("CMD052 at the database: an intent's amount equals its statement's payable, its payee is a VERIFIED destination version of the statement's seller (KC009), and one live intent exists per statement", async () => {
  await assertSeeded(w, platformMachine("PayoutIntent"));
  const s = await activeSeller(w, "cmd052-s");
  const t = await activeSeller(w, "cmd052-t");
  const { ag, first, lineId } = await firstLine("CMD052", s);
  await completion(w, ag, first, "FINAL");
  await funds(w, ag, first, "AVAILABLE", 2);
  await makeEligible(w, lineId);
  const statement = await issueStatement(w, october, s, [lineId]);
  // the amount is exactly the statement's payable (fee bearer Kauro, nothing deducted)
  await assert.rejects(approvePayout(w, statement, s, s, { amountCents: 9712 }), refusedWith("23503", "payout_intents_amount_is_payable"));
  // the payee is a VERIFIED destination version of the statement's seller (KC009): the seller's pending change and another seller's
  // verified destination are refused
  const pending = await changeDestination(w, s);
  await assert.rejects(approvePayout(w, statement, s, pending), refusedWith("KC009"), "a destination change pending verification");
  await assert.rejects(approvePayout(w, statement, s, t), refusedWith("KC009"), "another seller's verified destination");
  // the owner's intent of exactly 9713 to the verified destination: AUTHORIZED, the statement APPROVED, the stable reference
  const intentId = await approvePayout(w, statement, s, s);
  const intent = await w.h.oracle.query("SELECT state, amount_cents::int AS amount, fee_bearer, reference, destination_id, destination_digest FROM kauro.payout_intents WHERE intent_id = $1", [intentId]);
  assert.deepEqual(intent.rows, [{ state: "AUTHORIZED", amount: 9713, fee_bearer: "KAURO", reference: `kauro-payout-${intentId}`, destination_id: s.destinationId, destination_digest: s.destinationDigest }]);
  assert.deepEqual((await w.h.oracle.query("SELECT state FROM kauro.commission_statements WHERE statement_id = $1", [statement.statementId])).rows, [{ state: "APPROVED" }]);
  // one live intent per statement
  await assert.rejects(
    within(w.app, ownerOf(w), async (c) => {
      const second = ids.next();
      await c.query(
        `INSERT INTO kauro.payout_intents (intent_id, statement_id, seller_id, amount_cents, currency, fee_bearer, destination_id, destination_version, destination_digest, reference, authorized_by_user_id, authorization_proof_ref, authorized_at, created_at, updated_at)
         SELECT $1, statement_id, seller_id, amount_cents, currency, fee_bearer, destination_id, destination_version, destination_digest, $3, authorized_by_user_id, authorization_proof_ref, kauro.server_now(), now(), now()
           FROM kauro.payout_intents WHERE intent_id = $2`,
        [second, intentId, `kauro-payout-${second}`],
      );
    }),
    refusedWith("23505", "payout_intents_one_live_per_statement"),
  );
  // the transfer failed: the FAILED intent is kept with its evidence, the statement back to ISSUED, the line held for the failure ...
  await within(w.commission, corporate, async (c) => {
    await reconcileIn(c, intentId, "FAILED");
    await c.query("UPDATE kauro.commission_statements SET state = 'ISSUED', version = version + 1 WHERE statement_id = $1", [statement.statementId]);
    await c.query(
      "INSERT INTO kauro.commission_holds (hold_id, agency_id, line_id, seller_id, amount_cents, reason, review_at, opened_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 9713, 'PAYOUT_FAILED', kauro.server_now() + interval '7 days', kauro.server_now(), now(), now())",
      [ids.next(), ag.agencyId, lineId, s.sellerId],
    );
    await c.query("UPDATE kauro.commission_lines SET state = 'HELD', version = version + 1 WHERE line_id = $1", [lineId]);
  });
  // ... its held cents are never authorized again while the line is HELD under its OPEN hold (KC018, 0036, B10G-R2) ...
  await assert.rejects(approvePayout(w, statement, s, s), refusedWith("KC018"), "a failed payout's held line");
  // ... and once the hold is resolved and the line payable again, a new intent of the same statement is live again beside it
  await repayable(w, lineId);
  const again = await approvePayout(w, statement, s, s);
  const intents = await w.h.oracle.query("SELECT intent_id, state FROM kauro.payout_intents WHERE statement_id = $1 ORDER BY created_at, intent_id", [statement.statementId]);
  assert.deepEqual(intents.rows, [{ intent_id: intentId, state: "FAILED" }, { intent_id: again, state: "AUTHORIZED" }]);
  // nobody but the owner authorizes an intent — the seller's own attempt is refused as an authorization in another's name (23514) or by
  // its session's policies (42501), the commission service holds no INSERT (42501) — and an intent's payee never changes
  for (const [client, ctx] of [[w.app, personOf(s.userId)], [w.commission, corporate]] as const) {
    const attempted = ids.next();
    await assert.rejects(
      within(client, ctx, (c) =>
        c.query(
          "INSERT INTO kauro.payout_intents (intent_id, statement_id, seller_id, amount_cents, currency, fee_bearer, destination_id, destination_version, destination_digest, reference, authorized_by_user_id, authorization_proof_ref, authorized_at, created_at, updated_at) SELECT $1, statement_id, seller_id, amount_cents, currency, fee_bearer, destination_id, destination_version, destination_digest, $3, authorized_by_user_id, authorization_proof_ref, kauro.server_now(), now(), now() FROM kauro.payout_intents WHERE intent_id = $2",
          [attempted, again, `kauro-payout-${attempted}`],
        ),
      ),
      (e: unknown) => refusedWith("42501")(e) || refusedWith("23514", "payout_intents_authorization")(e),
    );
  }
  await oracleProbe(w, "UPDATE kauro.payout_intents SET destination_digest = $2, version = version + 1 WHERE intent_id = $1", [again, sha("another account")], refusedWith("KA004"), "the intent keeps its destination");
});

test("B10G-R1 at the database: a PAYABLE line is payable through one live statement item (KC019): another statement cannot itemize it PAYABLE nor take it over unless it corrects the line's owner", async () => {
  const s = await activeSeller(w, "owner-s");
  const { ag, first, lineId } = await firstLine("OWNER", s);
  await completion(w, ag, first, "FINAL");
  await funds(w, ag, first, "AVAILABLE", 2);
  await makeEligible(w, lineId);
  const a = await issueStatement(w, october, s, [lineId]);
  const owner = async (): Promise<string | null> => (await w.h.oracle.query<{ id: string | null }>("SELECT payable_statement_id AS id FROM kauro.commission_lines WHERE line_id = $1", [lineId])).rows[0]!.id;
  assert.equal(await owner(), a.statementId, "the line is payable through the statement whose PAYABLE item made it PAYABLE");
  const november = (await w.h.oracle.query<{ id: string }>("SELECT period_id AS id FROM kauro.commission_periods WHERE period_month = '2026-11-01'")).rows[0]?.id;
  const later = november ?? (await september(w, await fixtureCalendar(w), "TEST_FIXTURE", ["2026-12-07", "2026-12-14"], "2026-11-01"));
  await assert.rejects(within(w.commission, corporate, (c) => statementFor(c, later, s, [lineId], { payLines: false })), refusedWith("KC019"), "a second live statement itemizing the PAYABLE line");
  await assert.rejects(
    within(w.commission, corporate, async (c) => {
      const other = await statementFor(c, later, s, [], { issue: false });
      await c.query("UPDATE kauro.commission_lines SET payable_statement_id = $2, version = version + 1 WHERE line_id = $1", [lineId, other.statementId]);
    }),
    refusedWith("KC019"),
    "a take-over by a statement that does not correct the owner",
  );
  assert.equal(await owner(), a.statementId);
});

test("B10G-R1 r2 at the database: one live PAYABLE item per line is the statement's invariant, not the line's state (0039, KC019): while a statement that is not CORRECTED itemizes the line PAYABLE, no other statement itemizes it PAYABLE, even with the line no longer PAYABLE", async () => {
  const s = await activeSeller(w, "live-s");
  const { ag, first, lineId } = await firstLine("LIVE", s);
  await completion(w, ag, first, "FINAL");
  await funds(w, ag, first, "AVAILABLE", 2);
  await makeEligible(w, lineId);
  await issueStatement(w, october, s, [lineId]);
  // the line forced out of PAYABLE behind the machine's back (the superuser, triggers off): the old statement still itemizes it PAYABLE
  assert.match(lineId, /^[0-9a-f-]{36}$/);
  await w.h.oracle.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE kauro.commission_lines SET state = 'ELIGIBLE', payable_statement_id = NULL WHERE line_id = '${lineId}'; COMMIT;`);
  // November's period (the B10G-R1 test above records it when it runs first)
  const november = (await w.h.oracle.query<{ id: string }>("SELECT period_id AS id FROM kauro.commission_periods WHERE period_month = '2026-11-01'")).rows[0]?.id;
  const later = november ?? (await september(w, await fixtureCalendar(w), "TEST_FIXTURE", ["2026-12-07", "2026-12-14"], "2026-11-01"));
  await assert.rejects(within(w.commission, corporate, (c) => statementFor(c, later, s, [lineId], { payLines: false })), refusedWith("KC019"), "a second live statement itemizing the line PAYABLE");
});

test("B10G-R7 at the database: a step-up proof that expires during the approving transaction refuses the intent at its write (the expiry is compared with the statement's clock, not the transaction's start)", async () => {
  const s = await activeSeller(w, "expiry-s");
  const { ag, first, lineId } = await firstLine("EXPIRY", s);
  await completion(w, ag, first, "FINAL");
  await funds(w, ag, first, "AVAILABLE", 2);
  await makeEligible(w, lineId);
  const statement = await issueStatement(w, october, s, [lineId]);
  // the owner's proof: issued almost 15 minutes ago, expiring 800 ms from now
  const proofId = ids.next();
  await within(w.assurance, { userId: w.kora }, (c) =>
    c.query(
      `INSERT INTO kauro.assurance_proofs (proof_id, user_id, kind, method, issued_at, expires_at, correlation_id, created_at)
       VALUES ($1, $2, 'STEP_UP', 'TOTP', clock_timestamp() - interval '15 minutes' + interval '800 milliseconds', clock_timestamp() + interval '800 milliseconds', $3, now())`,
      [proofId, w.kora, ids.next()],
    ),
  );
  const intentId = ids.next();
  await assert.rejects(
    within(w.app, ownerOf(w), async (c) => {
      // the transaction starts while the proof is fresh; its write comes after the proof expired
      const started = await c.query<{ fresh: boolean }>("SELECT p.expires_at > transaction_timestamp() AS fresh FROM kauro.assurance_proofs p WHERE p.proof_id = $1", [proofId]);
      assert.equal(started.rows[0]!.fresh, true, "fresh at the transaction's start");
      await c.query("SELECT pg_sleep(1.2)");
      const now = await c.query<{ expired: boolean }>("SELECT p.expires_at <= clock_timestamp() AS expired FROM kauro.assurance_proofs p WHERE p.proof_id = $1", [proofId]);
      assert.equal(now.rows[0]!.expired, true, "expired at the write");
      await c.query(
        `INSERT INTO kauro.payout_intents (intent_id, statement_id, seller_id, amount_cents, currency, fee_bearer, destination_id, destination_version, destination_digest, reference,
           authorized_by_user_id, authorization_proof_ref, authorized_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'USD', 'KAURO', $5, 1, $6, $7, $8, $9, kauro.server_now(), now(), now())`,
        [intentId, statement.statementId, s.sellerId, statement.payableCents, s.destinationId, s.destinationDigest, `kauro-payout-${intentId}`, w.kora, proofId],
      );
      await c.query(
        "UPDATE kauro.commission_statements SET state = 'APPROVED', approved_by_user_id = $2, approved_at = kauro.server_now(), approval_proof_ref = $3, version = version + 1 WHERE statement_id = $1",
        [statement.statementId, w.kora, proofId],
      );
    }),
    // the intent's birth refuses the expired proof (not the COMMIT-time check of an approved statement)
    (e: unknown) => refusedWith("23514", "payout_intents_authorization")(e) && /with a fresh step-up/.test(String((e as Error).message)),
  );
});

// --- CMD053 ------------------------------------------------------------------------------------------------------------------------------

test("CMD053 at the database: a line becomes PAID only when its statement's intent is SETTLED with an evidence hash (KC010), and a FAILED or RETURNED intent is kept with its evidence", async () => {
  const s = await activeSeller(w, "cmd053-s");
  const t = await activeSeller(w, "cmd053-t");
  const [lo, hi] = byId(s, t);
  const { ag, allocationId, first, entitlements } = await acquired(w, "B10 CMD053", [{ seller: s, shareBps: 5000 }, { seller: t, shareBps: 5000 }], { foundingFixture: true });
  const pool = await accrue(w, ag, first, allocationId, { rateKind: "FIRST", rateBps: 1000, basisCents: 97125, poolCents: 9713, sequence: 1 }, [
    { sellerId: lo.sellerId, entitlementId: entitlements.get(lo.sellerId)!, shareBps: 5000, cents: 4857 },
    { sellerId: hi.sellerId, entitlementId: entitlements.get(hi.sellerId)!, shareBps: 5000, cents: 4856 },
  ]);
  await completion(w, ag, first, "FINAL");
  await funds(w, ag, first, "AVAILABLE", 2);
  const sLine = pool.lineOf.get(s.sellerId)!;
  const tLine = pool.lineOf.get(t.sellerId)!;
  for (const lineId of [sLine, tLine]) await makeEligible(w, lineId);
  const sStatement = await issueStatement(w, october, s, [sLine]);
  const tStatement = await issueStatement(w, october, t, [tLine]);
  const sIntent = await approvePayout(w, sStatement, s, s);
  const pay = (c: Client) => c.query("UPDATE kauro.commission_lines l SET state = 'PAID', paid_cents = i.payable_cents, paid_at = kauro.server_now(), version = l.version + 1 FROM kauro.statement_items i WHERE l.line_id = $1 AND i.line_id = l.line_id AND i.statement_id = $2", [sLine, sStatement.statementId]);

  // settled_payout_evidence: an AUTHORIZED intent, then a SUBMITTED one (submitting a transfer is not proof), pay no line (KC010)
  await assert.rejects(within(w.commission, corporate, pay), refusedWith("KC010"), "an AUTHORIZED intent");
  await reconcile(w, sIntent, "SUBMITTED");
  await assert.rejects(within(w.commission, corporate, pay), refusedWith("KC010"), "a SUBMITTED intent");
  await assert.rejects(
    within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_statements SET state = 'PAID', paid_at = kauro.server_now(), payout_evidence_hash = $2, version = version + 1 WHERE statement_id = $1", [sStatement.statementId, sha("submitted only")])),
    refusedWith("KC010"),
    "a statement of a SUBMITTED intent",
  );
  // SETTLED needs the evidence hash and its matching recorded evidence; evidence of another amount is never recorded
  await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.payout_intents SET state = 'SETTLED', settled_at = kauro.server_now(), version = version + 1 WHERE intent_id = $1", [sIntent])), refusedWith("23514", "payout_intents_evidence"));
  await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.payout_intents SET state = 'SETTLED', evidence_hash = $2, settled_at = kauro.server_now(), version = version + 1 WHERE intent_id = $1", [sIntent, sha("unrecorded")])), refusedWith("23514", "payout_intents_reconciled"));
  await assert.rejects(
    within(w.commission, corporate, (c) =>
      c.query(
        "INSERT INTO kauro.payout_reconciliations (reconciliation_id, intent_id, evidence_kind, evidence_hash, reference, destination_digest, amount_cents, currency, observed_at, recorded_at, created_at) SELECT $1, intent_id, 'SETTLED', $2, reference, destination_digest, amount_cents + 1, currency, now(), kauro.server_now(), now() FROM kauro.payout_intents WHERE intent_id = $3",
        [ids.next(), sha("another amount"), sIntent],
      ),
    ),
    refusedWith("23503", "payout_reconciliations_evidence_matches_intent"),
  );
  // the matching SETTLED evidence: the intent SETTLED, the statement PAID with that evidence hash, the line PAID at its item's cents
  const settledHash = await reconcile(w, sIntent, "SETTLED");
  assert.deepEqual((await w.h.oracle.query("SELECT state, payout_evidence_hash FROM kauro.commission_statements WHERE statement_id = $1", [sStatement.statementId])).rows, [{ state: "PAID", payout_evidence_hash: settledHash }]);
  assert.deepEqual(await lineRow(sLine), { state: "PAID", cumulative: String(s === lo ? 4857 : 4856), paid: String(s === lo ? 4857 : 4856), basis: "97125" });

  // the other seller's transfer failed, then its second transfer was returned: both intents are kept with their evidence
  const tFirst = await approvePayout(w, tStatement, t, t);
  await within(w.commission, corporate, async (c) => {
    await reconcileIn(c, tFirst, "FAILED");
    await c.query("UPDATE kauro.commission_statements SET state = 'ISSUED', version = version + 1 WHERE statement_id = $1", [tStatement.statementId]);
    await c.query(
      "INSERT INTO kauro.commission_holds (hold_id, agency_id, line_id, seller_id, amount_cents, reason, review_at, opened_at, created_at, updated_at) SELECT $1, agency_id, line_id, seller_id, cumulative_entitlement_cents, 'PAYOUT_FAILED', kauro.server_now() + interval '7 days', kauro.server_now(), now(), now() FROM kauro.commission_lines WHERE line_id = $2",
      [ids.next(), tLine],
    );
    await c.query("UPDATE kauro.commission_lines SET state = 'HELD', version = version + 1 WHERE line_id = $1", [tLine]);
  });
  await repayable(w, tLine);
  const tSecond = await approvePayout(w, tStatement, t, t);
  await within(w.commission, corporate, async (c) => {
    await reconcileIn(c, tSecond, "RETURNED");
    await c.query("UPDATE kauro.commission_statements SET state = 'ISSUED', version = version + 1 WHERE statement_id = $1", [tStatement.statementId]);
    await c.query(
      "INSERT INTO kauro.commission_holds (hold_id, agency_id, line_id, seller_id, amount_cents, reason, review_at, opened_at, created_at, updated_at) SELECT $1, agency_id, line_id, seller_id, cumulative_entitlement_cents, 'PAYOUT_FAILED', kauro.server_now() + interval '7 days', kauro.server_now(), now(), now() FROM kauro.commission_lines WHERE line_id = $2",
      [ids.next(), tLine],
    );
    await c.query("UPDATE kauro.commission_lines SET state = 'HELD', version = version + 1 WHERE line_id = $1", [tLine]);
  });
  const kept = await w.h.oracle.query<{ intent_id: string; state: string; evidence: boolean; reconciled: boolean }>(
    `SELECT p.intent_id, p.state, p.evidence_hash IS NOT NULL AS evidence,
            EXISTS (SELECT 1 FROM kauro.payout_reconciliations r WHERE r.intent_id = p.intent_id AND r.evidence_kind = p.state AND r.evidence_hash = p.evidence_hash) AS reconciled
       FROM kauro.payout_intents p WHERE p.statement_id = $1 ORDER BY p.created_at, p.intent_id`,
    [tStatement.statementId],
  );
  assert.deepEqual(kept.rows, [
    { intent_id: tFirst, state: "FAILED", evidence: true, reconciled: true },
    { intent_id: tSecond, state: "RETURNED", evidence: true, reconciled: true },
  ]);
  assert.deepEqual(await lineRow(tLine), { state: "HELD", cumulative: String(t === lo ? 4857 : 4856), paid: null, basis: "97125" });
  // a statement goes back to ISSUED only when its intents failed or were returned, never with one live or settled
  await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.commission_statements SET state = 'ISSUED', version = version + 1 WHERE statement_id = $1", [sStatement.statementId])), refusedWith("KA008"));
  // the kept intents and their evidence never change and are never deleted
  for (const intentId of [tFirst, tSecond]) {
    await assert.rejects(within(w.commission, corporate, (c) => c.query("UPDATE kauro.payout_intents SET evidence_hash = $2, version = version + 1 WHERE intent_id = $1", [intentId, sha("rewritten")])), refusedWith("KA004"));
    await assert.rejects(within(w.commission, corporate, (c) => c.query("DELETE FROM kauro.payout_intents WHERE intent_id = $1", [intentId])), refusedWith("42501"));
    await oracleProbe(w, "DELETE FROM kauro.payout_reconciliations WHERE intent_id = $1", [intentId], refusedWith("KA004"), "reconciliations are kept");
  }
});
