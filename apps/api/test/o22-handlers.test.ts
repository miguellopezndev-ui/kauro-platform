// Order 22's handlers and routes (candidate CP-02.07, .09, .11, .14) over an in-memory store that keeps the row policies' visibility
// (an owner reads every seller, a seller its own rows; the database proofs are packages/persistence/test/o22-seller-money-claims.test.ts):
// the routes are not registered at all with the activation OFF; each operation refuses the wrong standing before any effect; replays
// answer the stored record; a seller never reads a reason, evidence, note or another seller's claim.
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { o22 } from "@kauro/domain";
import type { ClaimRow, RefusalRow, ReviewRow } from "@kauro/persistence";
import { claimHistory, decideClaimReview, getMyMoney, listMyAlerts, listMyClaims, listSellerMoney, refuseAttribution, requestClaimReview, type O22Store, type RunAs } from "../src/o22/handlers.js";
import { registerO22Routes } from "../src/o22/routes.js";
import type { RouteKit } from "../src/server.js";

const OWNER = "owner-user";
const S1 = { userId: "seller-1-user", sellerId: "seller-1" };
const S2 = { userId: "seller-2-user", sellerId: "seller-2" };
const NOW = "2026-06-15T15:00:00.000Z";
const PERIOD = "0194f7a0-0000-7000-8000-0000000000aa";
const EV = "0194f7a0-0000-7000-8000-000000000001";

interface World {
  claims: ClaimRow[];
  refusals: Array<RefusalRow & { readonly userId: string; readonly key: string; readonly sellerId: string }>;
  reviews: Array<ReviewRow & { readonly key: string }>;
  decisions: Array<{ readonly reviewId: string; readonly userId: string; readonly key: string }>;
  entries: Array<o22.ClaimDecisionEntry & { readonly sellerId: string }>;
  writes: number;
  rows: o22.SellerMoneyRows;
}

const claim = (claimId: string, sellerId: string, extra: Partial<ClaimRow> = {}): ClaimRow => ({
  claimId,
  sellerId,
  prospectId: `prospect-${claimId}`,
  state: "SUBMITTED",
  version: 1,
  submittedAt: "2026-06-01T15:00:00.000Z",
  acceptedAt: null,
  expiresAt: null,
  reviewDeadlineAt: "2026-08-30T15:00:00.000Z",
  refusalId: null,
  ...extra,
});

function world(): World {
  return {
    claims: [claim("c1", S1.sellerId), claim("c2", S2.sellerId), claim("c3", S1.sellerId, { state: "ACCEPTED", acceptedAt: "2026-03-20T15:00:00.000Z", expiresAt: "2026-06-18T15:00:00.000Z" })],
    refusals: [],
    reviews: [],
    decisions: [],
    entries: [],
    writes: 0,
    rows: {
      basis: [{ poolId: "P", captureId: "C", source: "ACQUISITION", previousBasisCents: null, newBasisCents: 100_000n, changedAt: "2026-06-02T15:00:00.000Z" }],
      lines: [
        { lineId: "L1", sellerId: S1.sellerId, poolId: "P", captureId: "C", shareBps: 6000, previousPostedCents: 6_000n, cumulativeEntitlementCents: 6_000n, paidCents: 0n, state: "ACCRUED_PENDING", createdAt: "2026-06-02T15:00:00.000Z" },
        { lineId: "L2", sellerId: S2.sellerId, poolId: "P", captureId: "C", shareBps: 4000, previousPostedCents: 4_000n, cumulativeEntitlementCents: 4_000n, paidCents: 0n, state: "ACCRUED_PENDING", createdAt: "2026-06-02T15:00:00.000Z" },
      ],
      adjustments: [],
      holds: [],
      offsets: [],
      releases: [],
      payouts: [],
      funds: [],
      credit: [],
    },
  };
}

/** The store as the caller's policies let it see the world. */
function storeOf(w: World, userId: string): O22Store {
  const owner = userId === OWNER;
  const seller = userId === S1.userId ? S1.sellerId : userId === S2.userId ? S2.sellerId : null;
  const visible = (sellerId: string): boolean => owner || sellerId === seller;
  const s = {
    standing: async () => ({ owner, sellerId: seller, activeSellerId: seller }),
    period: async (id: string) => (id === PERIOD && (owner || seller !== null) ? { startsAt: "2026-06-01T05:00:00.000Z", endsAt: "2026-07-01T05:00:00.000Z" } : null),
    sellerMoneyRows: async (sellerId: string | null) => {
      const lines = w.rows.lines.filter((l) => visible(l.sellerId) && (sellerId === null || l.sellerId === sellerId));
      return { ...w.rows, lines, basis: w.rows.basis.filter((b) => lines.some((l) => l.poolId === b.poolId)) };
    },
    now: async () => NOW,
    claim: async (id: string) => w.claims.find((c) => c.claimId === id && visible(c.sellerId)) ?? null,
    claimForDecision: async (id: string) => (owner ? (w.claims.find((c) => c.claimId === id) ?? null) : null),
    claimsOf: async (sellerId: string | null) => w.claims.filter((c) => visible(c.sellerId) && (sellerId === null || c.sellerId === sellerId)),
    ownerRules: async () => [],
    refusalByKey: async (u: string, key: string) => (owner ? (w.refusals.find((r) => r.userId === u && r.key === key) ?? null) : null),
    refusal: async (id: string) => (owner ? (w.refusals.find((r) => r.refusalId === id) ?? null) : null),
    recordRefusal: async (input: { claim: ClaimRow; refusal: o22.ValidatedRefusal; userId: string; idempotencyKey: string }) => {
      w.writes++;
      const r = { refusalId: `r${w.refusals.length + 1}`, claimId: input.claim.claimId, reasonCode: input.refusal.reason.code, listVersion: input.refusal.listVersion, evidenceRef: input.refusal.evidenceRef, ownerRuleRef: null, note: input.refusal.note, sellerMessage: input.refusal.sellerMessage, refusedAt: NOW, userId: input.userId, key: input.idempotencyKey, sellerId: input.claim.sellerId };
      w.refusals.push(r);
      const i = w.claims.findIndex((c) => c.claimId === input.claim.claimId);
      w.claims[i] = { ...(w.claims[i] as ClaimRow), state: "REJECTED", refusalId: r.refusalId, version: input.claim.version + 1 };
      w.entries.push({ claimId: r.claimId, sequence: w.entries.length + 1, kind: "REFUSED", at: NOW, actorKind: "KAURO_OWNER", reasonCode: r.reasonCode, evidenceRef: r.evidenceRef, ...(r.note === null ? {} : { note: r.note }), sellerMessage: r.sellerMessage, sellerId: r.sellerId });
      return r;
    },
    reviewByKey: async (sellerId: string, key: string) => w.reviews.find((r) => r.sellerId === sellerId && r.key === key && visible(r.sellerId)) ?? null,
    reviewsOf: async (claimId: string) => w.reviews.filter((r) => r.claimId === claimId && visible(r.sellerId)),
    review: async (id: string) => w.reviews.find((r) => r.reviewId === id && visible(r.sellerId)) ?? null,
    reviewForDecision: async (id: string) => (owner ? (w.reviews.find((r) => r.reviewId === id && r.state === "REQUESTED") ?? null) : null),
    requestReview: async (input: { claim: ClaimRow; refusalId: string; note: string | null; idempotencyKey: string }) => {
      w.writes++;
      const r = { reviewId: `v${w.reviews.length + 1}`, claimId: input.claim.claimId, sellerId: input.claim.sellerId, refusalId: input.refusalId, state: "REQUESTED" as const, requestedAt: NOW, decidedAt: null, version: 1, key: input.idempotencyKey };
      w.reviews.push(r);
      return r;
    },
    decideReview: async (input: { review: ReviewRow; claim: ClaimRow; next: ReturnType<typeof o22.decideReview>; userId: string; idempotencyKey: string }) => {
      w.writes++;
      w.decisions.push({ reviewId: input.review.reviewId, userId: input.userId, key: input.idempotencyKey });
      const i = w.reviews.findIndex((r) => r.reviewId === input.review.reviewId);
      w.reviews[i] = { ...(w.reviews[i] as ReviewRow & { key: string }), state: input.next.review, decidedAt: NOW, version: input.review.version + 1 };
      return w.reviews[i] as ReviewRow;
    },
    decisionByKey: async (u: string, key: string) => w.decisions.find((d) => d.userId === u && d.key === key)?.reviewId ?? null,
    history: async (claimId: string, ownerView: boolean) => w.entries.filter((e) => e.claimId === claimId && visible(e.sellerId)).map(({ sellerId: _s, ...e }) => (ownerView ? e : { claimId: e.claimId, sequence: e.sequence, kind: e.kind, at: e.at, actorKind: e.actorKind, ...(e.sellerMessage === undefined ? {} : { sellerMessage: e.sellerMessage }) })),
    latestSellerMessages: async (ids: ReadonlyArray<string>) => new Map(w.entries.filter((e) => ids.includes(e.claimId) && visible(e.sellerId) && e.sellerMessage !== undefined).map((e) => [e.claimId, e.sellerMessage as string] as const)),
    reviewsOfClaims: async (ids: ReadonlyArray<string>) => w.reviews.filter((r) => ids.includes(r.claimId) && visible(r.sellerId)),
    statementForBalance: async () => null,
    retainerAccruals: async () => [],
  };
  return s as unknown as O22Store;
}

const runAsIn = (w: World): RunAs => (userId, _cid, fn) => fn(storeOf(w, userId));
const failureOf = (result: unknown): string => {
  const r = result as { readonly kind: string; readonly failure?: { readonly code: string; readonly reason?: string | undefined } };
  return r.kind === "FAILURE" ? `${r.failure?.code}/${r.failure?.reason ?? "-"}` : "OK";
};
const noLabels = async () => new Map<string, string>();

test("activation OFF: not one Order 22 route is registered, so the served inventory is unchanged; ON registers the candidate's ten", async () => {
  const kit = {} as RouteKit;
  const off = Fastify();
  registerO22Routes(off, kit, { enabled: false, runAs: runAsIn(world()), refuseUnauthenticated: async () => ({}) as never });
  await off.ready();
  for (const [m, u] of [["GET", "/api/v1/ops/sales/money"], ["GET", "/api/v1/sales/money"], ["POST", "/api/v1/sales/claims/:claimId/refuse"], ["POST", "/api/v1/sales/claim-reviews/:reviewId/decide"], ["GET", "/api/v1/ops/alerts"], ["GET", "/api/v1/sales/alerts"]] as const) {
    assert.equal(off.hasRoute({ method: m, url: u }), false, `${m} ${u} with the activation OFF`);
  }
  const on = Fastify();
  registerO22Routes(on, kit, { enabled: true, runAs: runAsIn(world()), refuseUnauthenticated: async () => ({}) as never });
  await on.ready();
  assert.equal(on.hasRoute({ method: "POST", url: "/api/v1/sales/claims/:claimId/refuse" }), true);
  assert.equal(on.hasRoute({ method: "GET", url: "/api/v1/sales/alerts" }), true);
  await off.close();
  await on.close();
});

test("seller money: the owner's list carries the total first and every seller; a seller reads only its own row; the wrong standing is refused", async () => {
  const w = world();
  const list = await listSellerMoney(runAsIn(w), OWNER, "c", PERIOD);
  assert.equal(list.kind, "READ");
  const items = (list as { data: { items: ReadonlyArray<o22.SellerMoneySummaryView> } }).data.items;
  assert.equal(items[0]?.sellerId, undefined, "the total row comes first, without a seller");
  assert.equal(items[0]?.netAttributableRevenueCents, "100000", "the capture counts once in the total");
  assert.deepEqual(items.slice(1).map((i) => [i.sellerId, i.netAttributableRevenueCents, i.commissionHeldCents]), [[S1.sellerId, "60000", "6000"], [S2.sellerId, "40000", "4000"]]);
  assert.equal(failureOf(await listSellerMoney(runAsIn(w), S1.userId, "c", PERIOD)), "NOT_AUTHORIZED/-", "a seller never reads the owner's list");
  const mine = await getMyMoney(runAsIn(w), S1.userId, "c", PERIOD);
  assert.equal((mine as { data: o22.SellerMoneySummaryView }).data.sellerId, S1.sellerId);
  assert.equal((mine as { data: o22.SellerMoneySummaryView }).data.netAttributableRevenueCents, "60000");
  assert.equal(failureOf(await getMyMoney(runAsIn(w), OWNER, "c", PERIOD)), "NOT_AUTHORIZED/-", "the owner is not a seller");
  assert.equal(failureOf(await getMyMoney(runAsIn(w), S1.userId, "c", "0194f7a0-0000-7000-8000-0000000000bb")), "NOT_FOUND/-");
});

test("refusal, review and decision through the handlers: standing, replays, versions, and what the seller reads", async () => {
  const w = world();
  const run = runAsIn(w);
  const body = { expectedVersion: 1, reasonCode: "OTHER", listVersion: "CLAIM-REFUSAL-1", evidenceRef: EV, note: "internal: inbound lead" };
  assert.equal(failureOf(await refuseAttribution(run, S1.userId, "c", "c1", body, "key-0001")), "NOT_AUTHORIZED/-", "a seller never refuses");
  assert.equal(w.writes, 0);
  assert.equal(failureOf(await refuseAttribution(run, OWNER, "c", "c1", { ...body, expectedVersion: 9 }, "key-0001")), "STALE_VERSION/-");
  assert.equal(failureOf(await refuseAttribution(run, OWNER, "c", "c1", { ...body, note: undefined } as never, "key-0001")), "INVALID_REQUEST/NOTE_REQUIRED");
  assert.equal(failureOf(await refuseAttribution(run, OWNER, "c", "c3", { ...body }, "key-0002")), "PRECONDITION_FAILED/CLAIM_NOT_REFUSABLE", "an accepted claim is not refused");
  assert.equal(w.writes, 0, "no refusal was written by any refused attempt");
  const done = await refuseAttribution(run, OWNER, "c", "c1", body, "key-0001");
  assert.equal(done.kind, "COMPLETED");
  const again = await refuseAttribution(run, OWNER, "c", "c1", body, "key-0001");
  assert.equal(again.kind === "COMPLETED" && again.replayed, true, "the same key answers the stored refusal");
  assert.equal(w.writes, 1);
  assert.equal(failureOf(await refuseAttribution(run, OWNER, "c", "c2", body, "key-0001")), "IDEMPOTENCY_CONFLICT/-");

  // the seller's list and history carry the neutral message only
  const claims = await listMyClaims(run, S1.userId, "c", noLabels);
  const c1 = (claims as { data: { items: ReadonlyArray<{ claimId: string; sellerMessage?: string; reviewAvailable: boolean; state: string }> } }).data.items.find((c) => c.claimId === "c1");
  assert.deepEqual([c1?.state, c1?.sellerMessage, c1?.reviewAvailable], ["REJECTED", "Not available to claim", true]);
  assert.ok(!JSON.stringify(claims).includes("internal") && !JSON.stringify(claims).includes(EV) && !JSON.stringify(claims).includes("OTHER"));
  assert.ok(!JSON.stringify(claims).includes("c2"), "never another seller's claim");
  const sellerHistory = await claimHistory(run, S1.userId, "c", "c1", "SELLER");
  assert.ok(!JSON.stringify(sellerHistory).includes("internal") && !JSON.stringify(sellerHistory).includes(EV));
  const ownerHistory = await claimHistory(run, OWNER, "c", "c1", "KAURO_OWNER");
  assert.ok(JSON.stringify(ownerHistory).includes("internal"), "the owner reads the note");
  assert.equal(failureOf(await claimHistory(run, S2.userId, "c", "c1", "SELLER")), "NOT_FOUND/-", "another seller's claim answers as not found");
  assert.equal(failureOf(await claimHistory(run, S1.userId, "c", "c1", "KAURO_OWNER")), "NOT_AUTHORIZED/-");

  // the review: another seller's claim is not found; one per refusal; the owner decides once
  assert.equal(failureOf(await requestClaimReview(run, S2.userId, "c", "c1", { expectedVersion: 2 }, "rv-00001")), "NOT_FOUND/-");
  assert.equal(failureOf(await requestClaimReview(run, S1.userId, "c", "c3", { expectedVersion: 1 }, "rv-00002")), "PRECONDITION_FAILED/CLAIM_NOT_REVIEWABLE");
  const rv = await requestClaimReview(run, S1.userId, "c", "c1", { expectedVersion: 2, note: "We met them first" }, "rv-00003");
  assert.equal(rv.kind, "COMPLETED");
  assert.equal(failureOf(await requestClaimReview(run, S1.userId, "c", "c1", { expectedVersion: 2 }, "rv-00004")), "PRECONDITION_FAILED/REVIEW_ALREADY_REQUESTED");
  const reviewId = (rv as { data: { reviewId: string } }).data.reviewId;
  assert.equal(failureOf(await decideClaimReview(run, S1.userId, "c", reviewId, { expectedVersion: 1, decision: "CHANGE", reasonCode: "NEW_EVIDENCE" }, "dc-00001")), "NOT_AUTHORIZED/-");
  assert.equal(failureOf(await decideClaimReview(run, OWNER, "c", reviewId, { expectedVersion: 1, decision: "UPHOLD", reasonCode: "MADE_UP" }, "dc-00001")), "PRECONDITION_FAILED/REFUSAL_REASON_UNKNOWN");
  assert.equal(failureOf(await decideClaimReview(run, OWNER, "c", reviewId, { expectedVersion: 1, decision: "UPHOLD", reasonCode: "OWNER_RULE" }, "dc-00001")), "PRECONDITION_FAILED/REFUSAL_REASON_UNKNOWN", "review F-2: an UPHOLD keeps the refusal's own code");
  assert.equal(w.writes, 2, "no refused decision wrote anything");
  const decided = await decideClaimReview(run, OWNER, "c", reviewId, { expectedVersion: 1, decision: "CHANGE", reasonCode: "NEW_EVIDENCE" }, "dc-00001");
  assert.equal((decided as { data: { state: string } }).data.state, "CHANGED");
  assert.equal(w.claims.find((c) => c.claimId === "c1")?.state, "REJECTED", "CHANGE withdraws the refusal; the claim is never ACCEPTED by it (G-O22-01)");
  const afterChange = await listMyClaims(run, S1.userId, "c", noLabels);
  const c1After = (afterChange as { data: { items: ReadonlyArray<{ claimId: string; sellerMessage?: string; reviewState: string; reviewAvailable: boolean }> } }).data.items.find((c) => c.claimId === "c1");
  assert.deepEqual([c1After?.reviewState, c1After?.sellerMessage, c1After?.reviewAvailable], ["CHANGED", undefined, false], "a withdrawn refusal's message is no longer shown");
  assert.equal(failureOf(await decideClaimReview(run, OWNER, "c", reviewId, { expectedVersion: 2, decision: "UPHOLD", reasonCode: "OTHER" }, "dc-00002")), "PRECONDITION_FAILED/REVIEW_NOT_OPEN");
  const replay = await decideClaimReview(run, OWNER, "c", reviewId, { expectedVersion: 1, decision: "CHANGE", reasonCode: "NEW_EVIDENCE" }, "dc-00001");
  assert.equal(replay.kind === "COMPLETED" && replay.replayed, true);
});

test("a seller's alerts are its own claim ends, 14 and 3 days before and once passed", async () => {
  const w = world();
  const mine = await listMyAlerts(runAsIn(w), S1.userId, "c");
  const items = (mine as { data: { items: ReadonlyArray<o22.SellerAlertView> } }).data.items;
  assert.deepEqual(items.map((a) => [a.claimId, a.kind, a.conditionCode]), [["c3", "DEADLINE_SOON", "CLAIM_END"]], "c3 ends in 3 days; c1's review deadline is weeks away");
  const theirs = await listMyAlerts(runAsIn(w), S2.userId, "c");
  assert.equal((theirs as { data: { items: ReadonlyArray<unknown> } }).data.items.length, 0);
  assert.equal(failureOf(await listMyAlerts(runAsIn(w), OWNER, "c")), "NOT_AUTHORIZED/-");
});
