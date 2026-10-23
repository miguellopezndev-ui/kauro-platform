// Order 22 at the database (migration 0120; candidate CP-01.04, .05, .13, .14): seller money from confirmed collections with zero
// double counting and zero leakage between sellers, agencies and roles; the retainer held to the agreement in force and never removed;
// claim refusals with the seven neutral codes, owner rules never retroactive, one review per refusal, and a seller that never reads a
// reason, evidence or note. Every write goes through the role and session that owns it; the superuser oracle only reads and probes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { o22 } from "@kauro/domain";
import { PgO22Repository } from "../src/o22-access.js";
import {
  accrue,
  completedRefund,
  funds,
  acquired,
  activeSeller,
  closeWorld,
  ids,
  oracleProbe,
  openWorld,
  ownerOf,
  personOf,
  refusedWith,
  registerProspect,
  service,
  sha,
  submitClaim,
  tenant,
  within,
  type Seller,
  type World,
} from "./b10-commission-support.js";

let w: World;
before(async () => {
  w = await openWorld("o22");
});
after(async () => {
  await closeWorld(w);
});

const repo = (c: Client): PgO22Repository => new PgO22Repository(c, () => ids.next());
const asOwner = <T>(fn: (r: PgO22Repository, c: Client) => Promise<T>): Promise<T> => within(w.app, ownerOf(w), (c) => fn(repo(c), c));
const asSeller = <T>(s: Seller, fn: (r: PgO22Repository, c: Client) => Promise<T>): Promise<T> => within(w.app, personOf(s.userId), (c) => fn(repo(c), c));
const figuresOf = (f: o22.SellerMoneyFigures): ReadonlyArray<bigint> => [f.netAttributableRevenueCents, f.commissionGeneratedCents, f.commissionPaidCents, f.refundOffsetCents, f.commissionHeldCents, f.commissionPayableCents];

test("seller money at the database: a split pool and a later refund count once, in their own periods, and each party reads only its own", async () => {
  const a = await activeSeller(w, "o22-money-a");
  const b = await activeSeller(w, "o22-money-b");
  const outsider = await activeSeller(w, "o22-money-x");
  // example 8's first-project pool: 97125 service cents at 1000 bps is 9713, split 6000/4000 by largest remainder (5828, 3885)
  const { ag, allocationId, first, entitlements } = await acquired(w, "O22 Money", [{ seller: a, shareBps: 6000 }, { seller: b, shareBps: 4000 }], { foundingFixture: true });
  const { poolId, lineOf } = await accrue(w, ag, first, allocationId, { rateKind: "FIRST", rateBps: 1000, basisCents: 97125, poolCents: 9713, sequence: 1 }, [
    { sellerId: a.sellerId, entitlementId: entitlements.get(a.sellerId)!, shareBps: 6000, cents: 5828 },
    { sellerId: b.sellerId, entitlementId: entitlements.get(b.sellerId)!, shareBps: 4000, cents: 3885 },
  ]);
  // a 20 000-cent service refund: basis 77125, pool 7713 (4628, 3085), one adjustment per line naming the refund's event
  // the customer's refund completes first (the payment service), then the ledger processes it (the COMMISSIONS consumer, below)
  await completedRefund(w, ag, first, 20000);
  const refundEvent = ids.next();
  await within(w.commission, service(ag.agencyId), async (c) => {
    await c.query("UPDATE kauro.commission_pools SET basis_cents = 77125, pool_cents = 7713, version = version + 1 WHERE pool_id = $1", [poolId]);
    for (const [sellerId, from, to] of [[a.sellerId, 5828, 4628], [b.sellerId, 3885, 3085]] as const) {
      await c.query(
        `INSERT INTO kauro.commission_adjustments (adjustment_id, agency_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents, new_cumulative_entitlement_cents,
           new_basis_cents, source_event_id, agreement_version, created_at)
         SELECT $1, l.agency_id, l.line_id, l.seller_id, 1, 'REFUND', 'DECREASE', $3, $4, $5, 77125, $6, e.agreement_version, kauro.server_now()
           FROM kauro.commission_lines l JOIN kauro.commission_entitlements e ON e.entitlement_id = l.entitlement_id WHERE l.line_id = $2`,
        [ids.next(), lineOf.get(sellerId), from - to, from, to, refundEvent],
      );
      await c.query("UPDATE kauro.commission_lines SET net_service_basis_cents = 77125, cumulative_entitlement_cents = $2, version = version + 1 WHERE line_id = $1", [lineOf.get(sellerId), to]);
    }
  });

  const history = await w.h.oracle.query<{ previous: string | null; next: string; at: Date }>("SELECT previous_basis_cents::text AS previous, new_basis_cents::text AS next, changed_at AS at FROM kauro.commission_pool_basis_history WHERE pool_id = $1 ORDER BY changed_at, new_basis_cents DESC", [poolId]);
  assert.deepEqual(history.rows.map((r) => [r.previous, r.next]), [[null, "97125"], ["97125", "77125"]], "the pool's birth and its fall are recorded by the database, nobody else");
  // review F-1: the birth is the purchase's confirmation and the fall the refund's completion, never the instants the ledger processed them
  const facts = await w.h.oracle.query<{ confirmed: Date; accrued: Date; completed: Date; processed: Date }>(
    `SELECT q.confirmed_at AS confirmed, p.created_at AS accrued, (SELECT max(r.completed_at) FROM kauro.refunds r WHERE r.capture_id = p.capture_id AND r.state = 'COMPLETED') AS completed, p.updated_at AS processed
       FROM kauro.commission_pools p JOIN kauro.qualifying_purchases q ON q.agency_id = p.agency_id AND q.authorization_id = p.authorization_id WHERE p.pool_id = $1`,
    [poolId],
  );
  const f = facts.rows[0]!;
  assert.equal(history.rows[0]!.at.getTime(), f.confirmed.getTime(), "the collection counts at its confirmation");
  assert.ok(f.confirmed.getTime() < f.accrued.getTime(), "the accrual came later and does not move it");
  assert.equal(history.rows[1]!.at.getTime(), f.completed.getTime(), "the refund counts when it completed");
  assert.ok(f.completed.getTime() < f.processed.getTime(), "the ledger processed it later and does not move it");
  // two periods split exactly between the confirmation and the refund
  const born = history.rows[0]!.at.getTime();
  const fell = history.rows[1]!.at.getTime();
  assert.ok(fell > born);
  const split = new Date(fell).toISOString();
  const P1: o22.Period = { startsAt: new Date(born - 3_600_000).toISOString(), endsAt: split };
  const P2: o22.Period = { startsAt: split, endsAt: new Date(fell + 3_600_000).toISOString() };

  const ownerRows = await asOwner((r) => r.sellerMoneyRows(null));
  const ownersView1 = o22.sellerMoney({ ...ownerRows, lines: ownerRows.lines.filter((l) => l.poolId === poolId), adjustments: ownerRows.adjustments.filter((x) => [...lineOf.values()].includes(x.lineId)) }, P1);
  assert.equal(ownersView1.total.netAttributableRevenueCents, 97_125n, "the capture counts once in the total, not once per seller");
  assert.deepEqual(ownersView1.sellers.map((s) => [s.sellerId, s.netAttributableRevenueCents, s.commissionGeneratedCents]).sort(), [
    [a.sellerId, 58_275n, 5_828n],
    [b.sellerId, 38_850n, 3_885n],
  ].sort());
  const ownersView2 = o22.sellerMoney({ ...ownerRows, lines: ownerRows.lines.filter((l) => l.poolId === poolId), adjustments: ownerRows.adjustments.filter((x) => [...lineOf.values()].includes(x.lineId)) }, P2);
  assert.equal(ownersView2.total.netAttributableRevenueCents, -20_000n, "the refund belongs to the period it happened in");
  assert.equal(ownersView2.total.commissionGeneratedCents, -2_000n);

  // the seller's own computation equals the owner's row for that seller: same rows, same rule
  for (const s of [a, b]) {
    const mine = await asSeller(s, (r) => r.sellerMoneyRows(s.sellerId));
    assert.deepEqual(new Set(mine.lines.map((l) => l.sellerId)), new Set([s.sellerId]), "a seller reads its own lines only");
    for (const [P, owners] of [[P1, ownersView1], [P2, ownersView2]] as const) {
      const own = o22.sellerMoney(mine, P).sellers.find((x) => x.sellerId === s.sellerId)!;
      assert.deepEqual(figuresOf(own), figuresOf(owners.sellers.find((x) => x.sellerId === s.sellerId)!), "the seller's own figures equal the owner's row");
    }
    const theirs = await asSeller(s, (r) => r.sellerMoneyRows(s === a ? b.sellerId : a.sellerId));
    assert.equal(theirs.lines.length + theirs.adjustments.length + theirs.payouts.length, 0, "another seller's rows are invisible, even when asked by id");
  }
  // review F-3: the funds the close reads are the seller's to read for its own captures only
  await funds(w, ag, first, "HELD", 1);
  const aFunds = await asSeller(a, (r) => r.sellerMoneyRows(a.sellerId));
  assert.deepEqual(aFunds.funds.map((x) => [x.captureId, x.fundsState]), [[first.captureId, "HELD"]]);
  const outsiderFunds = await asSeller(outsider, (_r, c) => c.query("SELECT count(*)::int AS n FROM kauro.capture_funds_observations"));
  assert.equal(outsiderFunds.rows[0].n, 0);
  // zero leakage: an unrelated seller, the agency's own members and the agency's control session read no basis history of the pool
  const outsiderSees = await asSeller(outsider, (_r, c) => c.query("SELECT count(*)::int AS n FROM kauro.commission_pool_basis_history WHERE pool_id = $1", [poolId]));
  assert.equal(outsiderSees.rows[0].n, 0);
  const agencySees = await within(w.app, tenant(ag), (c) => c.query("SELECT count(*)::int AS n FROM kauro.commission_pool_basis_history"));
  assert.equal(agencySees.rows[0].n, 0, "an agency never reads seller or commission data");
  // append-only, even for the superuser
  await oracleProbe(w, "UPDATE kauro.commission_pool_basis_history SET new_basis_cents = 1 WHERE pool_id = $1", [poolId], (e) => e instanceof Error, "the history is never rewritten");
  await oracleProbe(w, "DELETE FROM kauro.commission_pool_basis_history WHERE pool_id = $1", [poolId], (e) => e instanceof Error, "the history is never deleted");
  // a seller reads the period dates it names
  const periodsSeen = await asSeller(a, (_r, c) => c.query("SELECT count(*)::int AS n FROM kauro.commission_periods"));
  const periodsAll = await w.h.oracle.query("SELECT count(*)::int AS n FROM kauro.commission_periods");
  assert.equal(periodsSeen.rows[0].n, periodsAll.rows[0].n);
  const agencyPeriods = await within(w.app, tenant(ag), (c) => c.query("SELECT count(*)::int AS n FROM kauro.commission_periods"));
  assert.equal(agencyPeriods.rows[0].n, 0, "an agency session reads no commission period");
});

test("the retainer at the database: held to the signed agreement in force, one per month, never removed; USD 0.00 accrues nothing", async () => {
  const paid = await activeSeller(w, "o22-retainer", { retainerCentsPerMonth: 50_000 });
  const plain = await activeSeller(w, "o22-retainer-default");
  const next = await w.h.oracle.query<{ m: Date; before: Date }>(
    "SELECT (date_trunc('month', (now() + interval '32 days') AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota') AS m, (date_trunc('month', (now() - interval '40 days') AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota') AS before",
  );
  const month = next.rows[0]!.m.toISOString();
  const earlier = next.rows[0]!.before.toISOString();
  const agreements = await asOwner((r) => r.retainerAgreements(paid.sellerId));
  const due = o22.retainerDue(paid.sellerId, month, agreements);
  assert.equal(due.amountCents, 50_000n);
  const first = await asOwner((r) => r.accrueRetainer(due));
  assert.equal(first?.amountCents, 50_000n);
  const again = await asOwner((r) => r.accrueRetainer(due));
  assert.equal(again?.accrualId, first?.accrualId, "the month accrues once; a repeat answers the stored accrual");
  // the month before the agreement was signed: the default governs, so an accrual naming the agreement is refused
  assert.equal(o22.retainerDue(paid.sellerId, earlier, agreements).amountCents, 0n);
  await assert.rejects(
    asOwner((_r, c) => c.query("INSERT INTO kauro.retainer_accruals (accrual_id, seller_id, agreement_id, month_start, amount_cents) VALUES ($1, $2, $3, $4, 50000)", [ids.next(), paid.sellerId, paid.agreementId, earlier])),
    refusedWith("23514", "retainer_accruals_governed"),
  );
  // an amount other than the agreement's, or an instant that does not start a month, is refused
  const later = new Date(Date.parse(month) + 40 * 86_400_000).toISOString();
  const laterMonth = (await w.h.oracle.query<{ m: Date }>("SELECT (date_trunc('month', $1::timestamptz AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota') AS m", [later])).rows[0]!.m.toISOString();
  await assert.rejects(
    asOwner((_r, c) => c.query("INSERT INTO kauro.retainer_accruals (accrual_id, seller_id, agreement_id, month_start, amount_cents) VALUES ($1, $2, $3, $4, 40000)", [ids.next(), paid.sellerId, paid.agreementId, laterMonth])),
    refusedWith("23514", "retainer_accruals_governed"),
  );
  await assert.rejects(
    asOwner((_r, c) => c.query("INSERT INTO kauro.retainer_accruals (accrual_id, seller_id, agreement_id, month_start, amount_cents) VALUES ($1, $2, $3, $4, 50000)", [ids.next(), paid.sellerId, paid.agreementId, later])),
    refusedWith("23514", "retainer_accruals_month_start"),
  );
  // the default seller accrues nothing
  const plainDue = o22.retainerDue(plain.sellerId, month, await asOwner((r) => r.retainerAgreements(plain.sellerId)));
  assert.equal(plainDue.amountCents, 0n, "a signed agreement at USD 0.00, like the default, owes nothing");
  assert.equal(await asOwner((r) => r.accrueRetainer(plainDue)), null);
  // never removed, never changed — not even by the superuser; each seller reads its own accruals only
  await oracleProbe(w, "DELETE FROM kauro.retainer_accruals WHERE seller_id = $1", [paid.sellerId], (e) => e instanceof Error, "an accrued obligation is never removed");
  await oracleProbe(w, "UPDATE kauro.retainer_accruals SET amount_cents = 1 WHERE seller_id = $1", [paid.sellerId], (e) => e instanceof Error, "an accrued obligation is never changed");
  const wide: o22.Period = { startsAt: "2000-01-01T00:00:00.000Z", endsAt: "2100-01-01T00:00:00.000Z" };
  assert.equal((await asSeller(paid, (r) => r.retainerAccruals(paid.sellerId, wide))).length, 1);
  assert.equal((await asSeller(plain, (r) => r.retainerAccruals(paid.sellerId, wide))).length, 0, "another seller's retainer is invisible");
  // a seller cannot accrue its own retainer
  await assert.rejects(asSeller(paid, (_r, c) => c.query("INSERT INTO kauro.retainer_accruals (accrual_id, seller_id, agreement_id, month_start, amount_cents) VALUES ($1, $2, $3, $4, 50000)", [ids.next(), paid.sellerId, paid.agreementId, laterMonth])));
});

test("claim refusals at the database: the closed list, evidence, notes, owner rules never retroactive, one review per refusal, and no reason ever reaches a seller", async () => {
  const c1 = await activeSeller(w, "o22-claims-1");
  const c2 = await activeSeller(w, "o22-claims-2");
  const prospect = await registerProspect(w, c1, "o22-claims.example");
  const claim1 = await submitClaim(w, c1, prospect);
  const prospect2 = await registerProspect(w, c2, "o22-claims-two.example");
  const claim2 = await submitClaim(w, c2, prospect2);
  const EV = ids.next();

  // OTHER without a note, a message that is not the code's, an unknown code: refused by the database itself
  const raw = (claimId: string, sellerId: string, code: string, message: string, note: string | null, key: string, rule: [string, number] | null = null) =>
    asOwner(async (_r, c) => {
      const refusalId = ids.next();
      await c.query(
        "INSERT INTO kauro.claim_refusals (refusal_id, claim_id, seller_id, list_version, reason_code, evidence_ref, note, owner_rule_id, owner_rule_version, seller_message, idempotency_key, refused_by_user_id) VALUES ($1, $2, $3, 'CLAIM-REFUSAL-1', $4, $5, $6, $7, $8, $9, $10, $11)",
        [refusalId, claimId, sellerId, code, EV, note, rule?.[0] ?? null, rule?.[1] ?? null, message, key, w.kora],
      );
      // the refusal rejects its claim in the same transaction (claim_refusals_rejects at COMMIT)
      await c.query("UPDATE kauro.attribution_claims a SET state = 'REJECTED', refusal_id = r.refusal_id, rejected_at = r.refused_at, version = a.version + 1 FROM kauro.claim_refusals r WHERE a.claim_id = $1 AND r.refusal_id = $2", [claimId, refusalId]);
      return refusalId;
    });
  await assert.rejects(raw(claim1, c1.sellerId, "OTHER", "Not available to claim", null, "k-a"), refusedWith("23514", "claim_refusals_list_rules"));
  await assert.rejects(raw(claim1, c1.sellerId, "OUTSIDE_SELLER_AGREEMENT", "You were too slow", null, "k-b"), refusedWith("23514", "claim_refusals_list_rules"));
  await assert.rejects(raw(claim1, c1.sellerId, "NOT_A_CODE", "Not available to claim", null, "k-c"));
  await assert.rejects(raw(claim1, c2.sellerId, "OTHER", "Not available to claim", "x", "k-d"), (e: unknown) => e instanceof Error, "a refusal names its claim's own seller");
  // an owner rule is never recorded retroactively, and one recorded after the claim was submitted is not in force for it
  await assert.rejects(asOwner((_r, c) => c.query("INSERT INTO kauro.owner_rules (rule_id, rule_version, in_force_from, text_hash, recorded_by_user_id) VALUES ('OR-DIRECT', 1, now() - interval '1 day', $1, $2)", [sha("rule"), w.kora])), refusedWith("23514", "owner_rules_not_retroactive"));
  await asOwner((_r, c) => c.query("INSERT INTO kauro.owner_rules (rule_id, rule_version, in_force_from, text_hash, recorded_by_user_id) VALUES ('OR-DIRECT', 1, now(), $1, $2)", [sha("rule"), w.kora]));
  await assert.rejects(raw(claim1, c1.sellerId, "OWNER_RULE", "Not available to claim", null, "k-e", ["OR-DIRECT", 1]), refusedWith("23514", "claim_refusals_rule_in_force"));
  const rules = await asOwner((r) => r.ownerRules());
  const claimRow = await asOwner((r) => r.claimForDecision(claim1));
  assert.equal(
    (() => {
      try {
        o22.validateRefusal({ claimState: claimRow!.state, factsAt: claimRow!.submittedAt, ownerRules: rules, request: { reasonCode: "OWNER_RULE", listVersion: "CLAIM-REFUSAL-1", evidenceRef: EV, ownerRuleRef: "OR-DIRECT@1" } });
        return "NO_FAILURE";
      } catch (e) {
        return (e as o22.O22Failure).reason;
      }
    })(),
    "OWNER_RULE_NOT_IN_FORCE",
    "the domain and the database agree",
  );
  // a claim submitted after the rule entered into force can be refused under it
  const prospect3 = await registerProspect(w, c1, "o22-claims-three.example");
  const claim3 = await submitClaim(w, c1, prospect3);
  const refusal3 = await raw(claim3, c1.sellerId, "OWNER_RULE", "Not available to claim", null, "k-f", ["OR-DIRECT", 1]);
  // a refusal that does not reject its claim in its transaction is refused at COMMIT
  const prospect4 = await registerProspect(w, c1, "o22-claims-four.example");
  const claim4 = await submitClaim(w, c1, prospect4);
  await assert.rejects(
    asOwner((_r, c) =>
      c.query(
        "INSERT INTO kauro.claim_refusals (refusal_id, claim_id, seller_id, list_version, reason_code, evidence_ref, seller_message, idempotency_key, refused_by_user_id) VALUES ($1, $2, $3, 'CLAIM-REFUSAL-1', 'DUPLICATE_OWN_CLAIM', $4, 'Duplicate of a claim you already made', 'k-h', $5)",
        [ids.next(), claim4, c1.sellerId, EV, w.kora],
      ),
    ),
    refusedWith("23514", "claim_refusals_rejects"),
  );

  // the owner refuses claim1 with OTHER: claim REJECTED by the refusal at its instant, one REFUSED entry with the neutral message
  const refusal = await asOwner(async (r) => {
    const claim = (await r.claimForDecision(claim1))!;
    const v = o22.validateRefusal({ claimState: claim.state, factsAt: claim.submittedAt, ownerRules: await r.ownerRules(), request: { reasonCode: "OTHER", listVersion: "CLAIM-REFUSAL-1", evidenceRef: EV, note: "internal: inbound lead of the agency itself" } });
    return r.recordRefusal({ claim, refusal: v, userId: w.kora, idempotencyKey: "refuse-1" });
  });
  const after1 = await w.h.oracle.query("SELECT state, refusal_id, rejected_at, allocation_id FROM kauro.attribution_claims WHERE claim_id = $1", [claim1]);
  assert.equal(after1.rows[0].state, "REJECTED");
  assert.equal(after1.rows[0].refusal_id, refusal.refusalId);
  assert.equal(after1.rows[0].rejected_at.toISOString(), refusal.refusedAt);
  assert.equal(after1.rows[0].allocation_id, null);
  assert.equal(await asOwner((r) => r.refusalByKey(w.kora, "refuse-1")).then((x) => x?.refusalId), refusal.refusalId, "a replay finds the stored refusal");
  // a REJECTED claim is not refused again
  await assert.rejects(raw(claim1, c1.sellerId, "OTHER", "Not available to claim", "again", "k-g"), refusedWith("23514", "claim_refusals_refusable"));

  // what the seller reads: no refusal row at all, its own entries with the neutral message only
  const sellerRefusals = await asSeller(c1, (_r, c) => c.query("SELECT count(*)::int AS n FROM kauro.claim_refusals"));
  assert.equal(sellerRefusals.rows[0].n, 0, "a seller never reads a refusal row, even its own");
  const sellerRules = await asSeller(c1, (_r, c) => c.query("SELECT count(*)::int AS n FROM kauro.owner_rules"));
  assert.equal(sellerRules.rows[0].n, 0);
  const sellerHistory = await asSeller(c1, (r) => r.history(claim1, false));
  assert.deepEqual(sellerHistory.map((e) => [e.kind, e.sellerMessage]), [["REFUSED", "Not available to claim"]]);
  assert.ok(!JSON.stringify(sellerHistory).includes("internal") && !JSON.stringify(sellerHistory).includes(EV));
  const ownerHistory = await asOwner((r) => r.history(claim1, true));
  assert.deepEqual(ownerHistory.map((e) => [e.kind, e.reasonCode, e.evidenceRef, e.note]), [["REFUSED", "OTHER", EV, "internal: inbound lead of the agency itself"]]);
  assert.equal((await asSeller(c2, (r) => r.history(claim1, false))).length, 0, "another seller reads nothing of the claim");

  // the review: the other seller cannot ask it, the claimant can once; a second review of the same refusal is refused
  await assert.rejects(asSeller(c2, (r) => r.requestReview({ claim: { ...(claimRow as NonNullable<typeof claimRow>), sellerId: c2.sellerId }, refusalId: refusal.refusalId, note: null, idempotencyKey: "rv-x" })));
  const review = await asSeller(c1, async (r) => r.requestReview({ claim: (await r.claimsOf(c1.sellerId)).find((x) => x.claimId === claim1)!, refusalId: refusal.refusalId, note: "We met them at the fair first", idempotencyKey: "rv-1" }));
  assert.equal(review.state, "REQUESTED");
  await assert.rejects(asSeller(c1, async (r) => r.requestReview({ claim: (await r.claimsOf(c1.sellerId)).find((x) => x.claimId === claim1)!, refusalId: refusal.refusalId, note: null, idempotencyKey: "rv-2" })), (e: unknown) => e instanceof Error && /claim_reviews_one_per_refusal/.test(e.message));
  assert.equal((await asSeller(c2, (r) => r.reviewsOf(claim1))).length, 0);
  // CHANGE: the refusal is withdrawn and kept in the history; the claim stays REJECTED (G-O22-01: no edge out of REJECTED is listed)
  const decided = await asOwner(async (r) => {
    const rv = (await r.reviewForDecision(review.reviewId))!;
    const claim = (await r.claimForDecision(claim1))!;
    const next = o22.decideReview(rv.state, { decision: "CHANGE", reasonCode: "NEW_EVIDENCE_ACCEPTED" }, "OTHER");
    return r.decideReview({ review: rv, claim, decision: { decision: "CHANGE", reasonCode: "NEW_EVIDENCE_ACCEPTED" }, next, note: null, userId: w.kora, idempotencyKey: "dc-1", sellerMessage: null });
  });
  assert.equal(decided.state, "CHANGED");
  const back = await w.h.oracle.query("SELECT state, refusal_id, rejected_at FROM kauro.attribution_claims WHERE claim_id = $1", [claim1]);
  assert.deepEqual([back.rows[0].state, back.rows[0].refusal_id], ["REJECTED", refusal.refusalId]);
  // the machine is the registry's: nothing walks a refused claim out of REJECTED, and its refusal is learned once
  await assert.rejects(asOwner((_r, c) => c.query("UPDATE kauro.attribution_claims SET state = 'SUBMITTED', rejected_at = NULL, version = version + 1 WHERE claim_id = $1", [claim1])));
  await assert.rejects(asOwner((_r, c) => c.query("UPDATE kauro.attribution_claims SET refusal_id = NULL, version = version + 1 WHERE claim_id = $1", [claim1])));
  assert.equal((await w.h.oracle.query("SELECT count(*)::int AS n FROM kauro.claim_refusals WHERE claim_id = $1", [claim1])).rows[0].n, 1, "the withdrawn refusal stays in the history");
  // a decided review is never decided again
  await assert.rejects(asOwner((_r, c) => c.query("INSERT INTO kauro.claim_review_decisions (review_id, decision, reason_code, idempotency_key, decided_by_user_id) VALUES ($1, 'UPHOLD', 'OTHER', 'dc-2', $2)", [review.reviewId, w.kora])), refusedWith("23505"));
  const reDecide = await asOwner((_r, c) => c.query("UPDATE kauro.claim_reviews SET state = 'UPHELD', decided_at = now(), version = version + 1 WHERE review_id = $1", [review.reviewId]));
  assert.equal(reDecide.rowCount, 0, "the owner's policy admits a decision of a REQUESTED review only");
  // an UPHOLD names a code of the list in force
  const review2 = await asSeller(c1, async (r) => r.requestReview({ claim: (await r.claimsOf(c1.sellerId)).find((x) => x.claimId === claim3)!, refusalId: refusal3, note: null, idempotencyKey: "rv-3" }));
  await assert.rejects(asOwner((_r, c) => c.query("INSERT INTO kauro.claim_review_decisions (review_id, decision, reason_code, idempotency_key, decided_by_user_id) VALUES ($1, 'UPHOLD', 'MADE_UP_CODE', 'dc-3', $2)", [review2.reviewId, w.kora])), refusedWith("23514", "claim_review_decisions_listed"));
  // review F-2: an UPHOLD keeps the refusal's own code (claim3 was refused under OWNER_RULE): never re-based on OTHER without its note
  await assert.rejects(asOwner((_r, c) => c.query("INSERT INTO kauro.claim_review_decisions (review_id, decision, reason_code, idempotency_key, decided_by_user_id) VALUES ($1, 'UPHOLD', 'OTHER', 'dc-4', $2)", [review2.reviewId, w.kora])), refusedWith("23514", "claim_review_decisions_keep_code"));
  await asOwner((_r, c) => c.query("INSERT INTO kauro.claim_review_decisions (review_id, decision, reason_code, idempotency_key, decided_by_user_id) VALUES ($1, 'UPHOLD', 'OWNER_RULE', 'dc-5', $2)", [review2.reviewId, w.kora]));
  // a REJECTED claim with neither an allocation nor a refusal cannot exist
  await oracleProbe(w, "UPDATE kauro.attribution_claims SET state = 'REJECTED', rejected_at = now(), version = version + 1 WHERE claim_id = $1", [claim2], refusedWith("23514", "attribution_claims_ruling_record"), "no rejection without its ruling");
  // the seller's entry log is append-only and the seller writes only its own REVIEW_REQUESTED entries
  await assert.rejects(asSeller(c1, (_r, c) => c.query("INSERT INTO kauro.claim_decision_entries (claim_id, sequence, seller_id, kind, actor_kind) VALUES ($1, 99, $2, 'ACCEPTED', 'SELLER')", [claim1, c1.sellerId])));
  await oracleProbe(w, "DELETE FROM kauro.claim_decision_entries WHERE claim_id = $1", [claim1], (e) => e instanceof Error, "the history is never deleted");
  const seq = await w.h.oracle.query("SELECT kind FROM kauro.claim_decision_entries WHERE claim_id = $1 ORDER BY sequence", [claim1]);
  assert.deepEqual(seq.rows.map((r) => r.kind), ["REFUSED", "REVIEW_REQUESTED", "REVIEW_CHANGED"]);
});
