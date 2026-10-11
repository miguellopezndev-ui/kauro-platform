// The 6c cells of the B10 failure matrix on the seller commands and their authority (docs/design/B10-failure-matrix.md "GAP list, by risk"
// items TERM_ACCEPT, CLAIM_LAPSE_ACCEPT (CMD050), CLAIM_LAPSE_TAIL, TERM_PAR, TAIL_PURCHASE_RACE, SELLER_IDENT_RACE, CORP_REV, CMD_EXP_ASSURE, SELLER_ACT_RACE),
// each a cell of the common fault harness (docs/design/FAULT-HARNESS.md). The REAL routes of CMD045..CMD050 run their REAL unit of work over a
// connection the harness opened (test/fault-support.ts); the payment service's REAL reconciler designates the first purchase through the REAL
// webhook. A race cell holds one actor at a named point and observes the other waiting on it in pg_stat_activity, in both orders; a revocation
// cell lets the revocation take effect and then observes the command refused; an expiry cell moves the controlled clock past the deadline and
// puts the instant on the command's own transaction; a partial cell fails a later write after an earlier one answered. PostgreSQL 17 through
// the runtime login roles; the superuser only reads (and, as the platform's security operations, disables an identity). Nothing sleeps a fixed time (a deadline crossed during a lock wait waits only the remainder the database measures, crossedWhileWaiting).
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { SellerTerminationView, WebhookAck } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { connectionPid, faultCell, openConnection, recordClaim, recordProspect, recordServiceAssignment, type FaultContext, type HarnessConnection, type RecordedSeller, invariantsAfterEach } from "@kauro/persistence/testing";
import { deliver } from "./payment-support.js";
import { agentOf, assignedThrough, claimed, integrationWorld, opportunityOf, oracleRows, orderedThrough, planOf, quoted, seller, terminationBody, type IntegrationWorld } from "./integration-support.js";
import { bindCells, contend, converting, crossedWhileWaiting, effectClockBefore, observeBlockedBy, runConsumer, type Actor } from "./b10-cells-support.js";
import type { SqlStep } from "./fault-support.js";
import { prepareAllocation, recordClaimEvidence, recordSourceEvidence } from "./sales-support.js";
import { candidateSeller } from "./sellers-support.js";
import { call, completed, freshKey, ids, outcome, type Person, type Reply } from "./support.js";

let iw: IntegrationWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => iw.h.oracle);
/** Every harness connection of these cells waits for a lock at most 60 s (lock_timeout): an ordering defect fails its cell, never hangs the file. */
const bounded = (login: Parameters<IntegrationWorld["h"]["pg"]["clientConfig"]>[0]): Promise<HarnessConnection> => openConnection({ ...iw.h.pg.clientConfig(login), options: "-c lock_timeout=60000" });
const open = bounded;
before(async () => {
  iw = await integrationWorld();
  bindCells(iw);
});
after(async () => {
  await iw.stop();
});

class Refused extends Error {}

/** An instant of the database (microseconds) as epoch milliseconds, truncated. */
const msOf = (iso: string): number => Date.parse(iso.replace(/(\.\d{3})\d*Z$/, "$1Z"));
/** The reply in a compact form: the status of a success, `status code reason` of a refusal. */
const said = (reply: Reply): string => (reply.status < 300 ? String(reply.status) : outcome(iw.w, reply));
const valueOf = <T>(r: PromiseSettledResult<T>, what: string): T => {
  if (r.status === "rejected") throw new Error(`${what} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, { cause: r.reason });
  return r.value;
};
/** Runs `fn`, then `then` whatever it did (a pause released after its waiter was observed, or failed to be). */
const afterward = async <T>(fn: () => Promise<T>, then: () => void): Promise<T> => {
  try {
    return await fn();
  } finally {
    then();
  }
};
const journalState = async (key: string): Promise<string | null> => (await iw.w.journal(key))?.state ?? null;
const routed = (ctx: Pick<FaultContext, "points">, conn: HarnessConnection, steps: ReadonlyArray<SqlStep>, request: () => Promise<Reply>): Promise<Reply> => iw.faults.on(conn, "kauro_app", ctx.points, steps, request);
/** Throws the refusal a fenced command answered (its compact form), or fails when it was admitted. */
const refusedWith = async (reply: Promise<Reply>): Promise<never> => {
  const r = await reply;
  throw new Refused(said(r));
};
const isRefusal = (pattern: RegExp) => (e: unknown): boolean => e instanceof Refused && pattern.test(e.message);

// --- the commands --------------------------------------------------------------------------------------------------------------------

const terminate = (sellerId: string, key: string, body: Record<string, unknown>): Promise<Reply> => call(iw.w, { url: `/api/v1/sales/sellers/${sellerId}/terminate`, token: iw.owner.token, agency: null, key, body });
const activate = (sellerId: string, key: string, body: Record<string, unknown>, who: Person = iw.owner): Promise<Reply> => call(iw.w, { url: `/api/v1/sales/sellers/${sellerId}/activate`, token: who.token, agency: null, key, body });
const acceptClaim = (claimId: string, allocationId: string, key: string): Promise<Reply> =>
  call(iw.w, { url: `/api/v1/sales/claims/${claimId}/accept`, token: iw.owner.token, agency: null, key, body: { expectedVersion: 1, shareAllocationRef: allocationId } });
const registerProspect = (who: Person, key: string, body: Record<string, unknown>): Promise<Reply> => call(iw.w, { url: "/api/v1/sales/prospects", token: who.token, agency: null, key, body });
const claimProspect = (who: Person, prospectId: string, key: string, body: Record<string, unknown>): Promise<Reply> => call(iw.w, { url: `/api/v1/sales/prospects/${prospectId}/claims`, token: who.token, agency: null, key, body });
const assignAccount = (agencyId: string, key: string, body: Record<string, unknown>): Promise<Reply> => call(iw.w, { url: `/api/v1/sales/agencies/${agencyId}/assignment`, token: iw.owner.token, agency: null, key, body });

const appActor = (ctx: FaultContext, name: string, run: () => Promise<Reply>, holdAt = "uow.before-commit", steps: ReadonlyArray<SqlStep> = []): Actor => ({ name, login: "kauro_app_test", holdAt, run: (conn) => routed(ctx, conn, steps, run) });

// --- what the superuser reads ----------------------------------------------------------------------------------------------------------

const sellerRow = async (sellerId: string): Promise<{ readonly state: string; readonly version: number }> => {
  const [r] = await oracleRows<{ state: string; version: string }>(iw, "SELECT state, version::text FROM kauro.sellers WHERE seller_id = $1", [sellerId]);
  return { state: r!.state, version: Number(r!.version) };
};
const claimStates = async (claimIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const rows = await oracleRows<{ claim_id: string; state: string }>(iw, "SELECT claim_id, state FROM kauro.attribution_claims WHERE claim_id = ANY ($1::uuid[])", [claimIds]);
  return claimIds.map((id) => rows.find((r) => r.claim_id === id)!.state);
};
const tailsOf = async (sellerId: string): Promise<number> => (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.termination_tail_entries WHERE seller_id = $1", [sellerId]))[0]!.n;
const frozen = async (allocationId: string): Promise<boolean> => (await oracleRows<{ f: boolean }>(iw, "SELECT frozen_at IS NOT NULL AS f FROM kauro.attribution_allocations WHERE allocation_id = $1", [allocationId]))[0]!.f;

// =====================================================================================================================================
// TERM_PAR: TerminateSeller, a failure injected after each write and before the next
// =====================================================================================================================================

const TERMS_UPDATE: SqlStep = { label: "terms_update", match: /UPDATE kauro\.seller_terminations SET manifest_id/ };
const TAIL_INSERT: SqlStep = { label: "tail_insert", match: /INSERT INTO kauro\.termination_tail_entries/ };
const SELLER_UPDATE: SqlStep = { label: "seller_update", match: /UPDATE kauro\.sellers AS s SET/ };
const CLAIM_EXPIRE: SqlStep = { label: "claim_expire", match: /UPDATE kauro\.attribution_claims AS c SET/ };
const ENTITLEMENT_UPDATE: SqlStep = { label: "entitlement_update", match: /UPDATE kauro\.commission_entitlements AS e SET/ };
const PROSPECTS_UPDATE: SqlStep = { label: "prospects_update", match: /UPDATE kauro\.prospects SET owner_seller_id = NULL/ };
const LINK_INSERT: SqlStep = { label: "link_insert", match: /INSERT INTO kauro\.account_assignments/ };
const ACCOUNT_MOVE: SqlStep = { label: "account_move", match: /UPDATE kauro\.sales_accounts SET current_assignment_id/ };
const JOURNAL_COMMIT: SqlStep = { label: "journal_commit", match: /UPDATE kauro\.command_journal SET state = 'COMMITTED'/ };

interface Terminable {
  readonly s: RecordedSeller;
  /** The converted claim (its agency bought: an ACTIVE entitlement), the listed ACCEPTED claim and the unlisted SUBMITTED claim. */
  readonly claimIds: readonly [string, string, string];
  readonly agencyId: string;
  readonly body: Record<string, unknown>;
}

/** A seller with every kind of row CMD050 writes: an ACTIVE entitlement, a listed ACCEPTED claim, an unlisted SUBMITTED claim, three owned prospects and the converted agency's current assignment. */
async function terminable(label: string): Promise<Terminable> {
  const c = await converting(`${label}-conv`, [10_000]);
  assert.equal(await runConsumer(c.delivery), "APPLIED", "the first purchase converts the claim and creates the entitlement");
  const s = c.att.sellers[0]!;
  const listed = await opportunityOf(iw, s, `${label}-listed`);
  const p3 = await recordProspect(iw.h, { by: s, domain: `${label}-unlisted.example` });
  const { claimId: unlisted } = await recordClaim(iw.h, { seller: s, prospectId: p3.prospectId });
  await assignedThrough(iw, c.agencyId, { expectedVersion: 0, sellerId: s.sellerId, serviceAssignmentRef: await recordServiceAssignment(iw.h, { ownerUserId: iw.owner.userId as UserId, agencyId: c.agencyId, sellerId: s.sellerId }) });
  return { s, claimIds: [c.att.claimIds[0]!, listed.claimId, unlisted], agencyId: c.agencyId, body: await terminationBody(iw, s.sellerId, [listed.claimId]) };
}

/** Everything CMD050 writes for the seller, read by the superuser. */
async function footprintOf(t: Terminable): Promise<unknown> {
  const q = async (sql: string): Promise<unknown> => oracleRows(iw, sql, [t.s.sellerId]);
  return {
    seller: await sellerRow(t.s.sellerId),
    terminations: await q("SELECT version::text, effective_at IS NOT NULL AS effective FROM kauro.seller_terminations WHERE seller_id = $1 ORDER BY termination_id"),
    tails: await tailsOf(t.s.sellerId),
    claims: await claimStates(t.claimIds),
    entitlements: await q("SELECT state, version::text FROM kauro.commission_entitlements WHERE seller_id = $1 ORDER BY entitlement_id"),
    prospectsOwned: await q("SELECT count(*)::int AS n FROM kauro.prospects WHERE owner_seller_id = $1"),
    account: await oracleRows(iw, "SELECT s.version::text, c.reason, c.seller_id FROM kauro.sales_accounts s JOIN kauro.account_assignments c ON c.assignment_id = s.current_assignment_id WHERE s.agency_id = $1", [t.agencyId]),
    links: await oracleRows(iw, "SELECT count(*)::int AS n FROM kauro.account_assignments WHERE agency_id = $1", [t.agencyId]),
  };
}

faultCell(
  {
    id: "TERM_PAR",
    step: "CMD050 TerminateSeller / PARTIAL: W seller + assignments + prospects + entitlements + claims + tail entries (one COMMIT)",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the termination record and tail entry and before the seller TERMINATED, then after the seller is TERMINATED and before each later write (the unlisted claim EXPIRED, the entitlement TERMINATED_WITH_RESIDUAL, the prospects unassigned, the SELLER_TERMINATED link, the account moved, the journal's COMMITTED write) rolls everything back: the seller ACTIVE at its version, the terms not effective, no tail entry, the claims CONVERTED/ACCEPTED/SUBMITTED, the entitlement ACTIVE, three prospects owned, the seller's assignment current, no journal entry; the same key then terminates once: one tail entry, one claim EXPIRED, one entitlement TERMINATED_WITH_RESIDUAL, three prospects unassigned, one assignment ended",
  },
  async (ctx) => {
    const cases = [
      { label: "before-seller", at: "db.seller_update.before", steps: [TERMS_UPDATE, TAIL_INSERT, SELLER_UPDATE], done: "db.tail_insert.after" },
      { label: "before-claims", at: "db.claim_expire.before", steps: [SELLER_UPDATE, CLAIM_EXPIRE], done: "db.seller_update.after" },
      { label: "before-entitlements", at: "db.entitlement_update.before", steps: [CLAIM_EXPIRE, ENTITLEMENT_UPDATE], done: "db.claim_expire.after" },
      { label: "before-prospects", at: "db.prospects_update.before", steps: [ENTITLEMENT_UPDATE, PROSPECTS_UPDATE], done: "db.entitlement_update.after" },
      { label: "before-link", at: "db.link_insert.before", steps: [PROSPECTS_UPDATE, LINK_INSERT], done: "db.prospects_update.after" },
      { label: "before-account", at: "db.account_move.before", steps: [LINK_INSERT, ACCOUNT_MOVE], done: "db.link_insert.after" },
      { label: "before-journal", at: "db.journal_commit.before", steps: [ACCOUNT_MOVE, JOURNAL_COMMIT], done: "db.account_move.after" },
    ] as const;
    for (const c of cases) {
      const t = await terminable(`term-par-${c.label}`);
      const before = await footprintOf(t);
      assert.deepEqual((before as { claims: unknown }).claims, ["CONVERTED", "ACCEPTED", "SUBMITTED"]);
      const key = freshKey(`term-par-${c.label}`);
      const conn = await open("kauro_app_test");
      const passedBefore = ctx.points.passed.length;
      try {
        await ctx.partial(`TerminateSeller failing ${c.label}`, c.at, async () => {
          const seen = iw.w.internalErrors.length;
          const reply = await routed(ctx, conn, c.steps, () => terminate(t.s.sellerId, key, t.body));
          if (reply.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(`the unit failed: ${reply.status}`);
          return reply;
        });
      } finally {
        await conn.end();
      }
      assert.ok(ctx.points.passed.slice(passedBefore).includes(c.done), `${c.label}: ${c.done} answered before the failure`);
      assert.deepEqual(await footprintOf(t), before, `${c.label}: every write rolled back`);
      assert.equal(await journalState(key), null, `${c.label}: no journal entry`);

      const done = completed<SellerTerminationView>(await terminate(t.s.sellerId, key, t.body), 200);
      assert.deepEqual(
        [done.replayed, done.data.state, done.data.tailEntries, done.data.claimsExpired, done.data.entitlementsResidual, done.data.prospectsUnassigned, done.data.assignmentsEnded],
        [false, "TERMINATED", 1, 1, 1, 3, 1],
        `${c.label}: the same key terminates once`,
      );
      assert.deepEqual(await claimStates(t.claimIds), ["CONVERTED", "ACCEPTED", "EXPIRED"], `${c.label}: the listed claim kept for its tail, the unlisted one EXPIRED`);
      assert.deepEqual(await oracleRows(iw, "SELECT state FROM kauro.commission_entitlements WHERE seller_id = $1", [t.s.sellerId]), [{ state: "TERMINATED_WITH_RESIDUAL" }]);
      assert.equal(await tailsOf(t.s.sellerId), 1);
    }
  },
);

// =====================================================================================================================================
// TERM_ACCEPT: TerminateSeller racing AcceptAttribution of the seller's claim, in both orders
// =====================================================================================================================================

/** The refusal of an acceptance whose own claim the termination moved on: its expected version is stale (B06 order: expectedVersion before the state checks). */
const STALE_CLAIM = /^409 STALE_VERSION -$/;
/** The refusal of an acceptance whose allocation names the terminated seller's claim (EXPIRED by the termination, its deadline far off): not under review. */
const SHARE_NOT_REVIEWABLE = /^409 PRECONDITION_FAILED CLAIM_NOT_REVIEWABLE$/;

faultCell(
  {
    id: "TERM_ACCEPT",
    step: "CMD047 AcceptAttribution / REVOCATION: W allocation + shares + claims state + pools terms (one COMMIT)",
    fault: "revocation",
    expect:
      "RACE: TerminateSeller racing AcceptAttribution of the seller's claim in both orders with the lock wait observed: an acceptance that committed first is ruled by the termination (its claim, not in the manifest, EXPIRED with the seller: no live share, no tail, no entitlement for the TERMINATED seller); an acceptance that waited on the termination is refused 409 STALE_VERSION (the claim the termination moved on; expectedVersion is checked first) with the allocation unfrozen; every acceptance after the termination is refused 409 STALE_VERSION the same way",
  },
  async (ctx) => {
    for (const order of ["ACCEPT_FIRST", "TERMINATION_FIRST"] as const) {
      const label = `term-accept-1-${order === "ACCEPT_FIRST" ? "a" : "t"}`;
      const s = await seller(iw, label);
      const op = await opportunityOf(iw, s, label, { accept: false });
      const allocationId = await prepareAllocation(iw.h, { ownerUserId: iw.owner.userId, agencyId: op.a.s.agency.agencyId, prospectId: op.prospectId, shares: [{ seller: s, claimId: op.claimId, shareBps: 10_000 }] });
      const body = await terminationBody(iw, s.sellerId, []);
      const accept = appActor(ctx, "AcceptAttribution", () => acceptClaim(op.claimId, allocationId, freshKey(label)));
      const term = appActor(ctx, "TerminateSeller", () => terminate(s.sellerId, freshKey(label), body));
      const out = order === "ACCEPT_FIRST" ? await contend(ctx, accept, term, `${order}`) : await contend(ctx, term, accept, `${order}`);
      const [accepted, terminated] = order === "ACCEPT_FIRST" ? [out.holder, out.waiter] : [out.waiter, out.holder];
      const t = completed<SellerTerminationView>(valueOf(terminated as PromiseSettledResult<Reply>, "TerminateSeller"), 200);
      await ctx.revoked(`the seller's termination (${order})`, async () => assert.equal((await sellerRow(s.sellerId)).state, "TERMINATED"));
      if (order === "ACCEPT_FIRST") {
        assert.equal(said(valueOf(accepted as PromiseSettledResult<Reply>, "AcceptAttribution")), "200", "the acceptance committed before the termination");
        assert.deepEqual([t.data.claimsExpired, t.data.tailEntries], [1, 0], "the termination expires the accepted, unlisted claim");
        assert.equal(await frozen(allocationId), true);
      } else {
        assert.match(said(valueOf(accepted as PromiseSettledResult<Reply>, "AcceptAttribution")), STALE_CLAIM, "the acceptance that waited is refused: its claim moved on");
        assert.equal(await frozen(allocationId), false, "no allocation frozen");
      }
      assert.deepEqual(await claimStates([op.claimId]), ["EXPIRED"], `${order}: no live share for the TERMINATED seller`);
      assert.deepEqual([await tailsOf(s.sellerId), (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.commission_entitlements WHERE seller_id = $1", [s.sellerId]))[0]!.n], [0, 0], `${order}: no tail, no entitlement`);
    }
    // after the termination: another claim of the terminated seller is accepted by no one
    const s = await seller(iw, "term-accept-1-after");
    const op = await opportunityOf(iw, s, "term-accept-1-after", { accept: false });
    const allocationId = await prepareAllocation(iw.h, { ownerUserId: iw.owner.userId, agencyId: op.a.s.agency.agencyId, prospectId: op.prospectId, shares: [{ seller: s, claimId: op.claimId, shareBps: 10_000 }] });
    completed<SellerTerminationView>(await terminate(s.sellerId, freshKey("term-accept-1-after"), await terminationBody(iw, s.sellerId, [])), 200);
    await ctx.fenced("an acceptance of the terminated seller's claim", () => refusedWith(acceptClaim(op.claimId, allocationId, freshKey("term-accept-1-fenced"))), isRefusal(STALE_CLAIM));
    assert.equal(await frozen(allocationId), false);
  },
);

faultCell(
  {
    id: "TERM_ACCEPT",
    step: "CMD050 TerminateSeller / REVOCATION: W seller + assignments + prospects + entitlements + claims + tail entries (one COMMIT)",
    fault: "revocation",
    expect:
      "RACE: AcceptAttribution of a 6000/4000 split landing while one of its two sellers is terminated, in both orders with the lock wait observed: accepted first, the terminated seller's unlisted claim EXPIRED by the termination and the other seller's claim ACCEPTED under the frozen allocation (no live share and no tail for the TERMINATED seller); terminated first, the acceptance naming the terminated seller's share is refused 409 PRECONDITION_FAILED CLAIM_NOT_REVIEWABLE (X's claim EXPIRED by the termination) and nothing is frozen, the other seller's claim left SUBMITTED",
  },
  async (ctx) => {
    for (const order of ["ACCEPT_FIRST", "TERMINATION_FIRST"] as const) {
      const label = `term-accept-2-${order === "ACCEPT_FIRST" ? "a" : "t"}`;
      const a = await agentOf(iw, label);
      const att = await claimed(iw, label, 2);
      const [x, y] = [att.sellers[0]!, att.sellers[1]!];
      const allocationId = await prepareAllocation(iw.h, {
        ownerUserId: iw.owner.userId,
        agencyId: a.s.agency.agencyId,
        prospectId: att.prospectId,
        shares: [
          { seller: x, claimId: att.claimIds[0]!, shareBps: 6_000 },
          { seller: y, claimId: att.claimIds[1]!, shareBps: 4_000 },
        ],
      });
      const body = await terminationBody(iw, x.sellerId, []);
      const accept = appActor(ctx, "AcceptAttribution", () => acceptClaim(att.claimIds[1]!, allocationId, freshKey(label)));
      const term = appActor(ctx, "TerminateSeller", () => terminate(x.sellerId, freshKey(label), body));
      const out = order === "ACCEPT_FIRST" ? await contend(ctx, accept, term, order) : await contend(ctx, term, accept, order);
      const [accepted, terminated] = order === "ACCEPT_FIRST" ? [out.holder, out.waiter] : [out.waiter, out.holder];
      completed<SellerTerminationView>(valueOf(terminated as PromiseSettledResult<Reply>, "TerminateSeller"), 200);
      await ctx.revoked(`seller X's termination (${order})`, async () => assert.equal((await sellerRow(x.sellerId)).state, "TERMINATED"));
      if (order === "ACCEPT_FIRST") {
        assert.equal(said(valueOf(accepted as PromiseSettledResult<Reply>, "AcceptAttribution")), "200");
        assert.deepEqual([await frozen(allocationId), ...(await claimStates(att.claimIds))], [true, "EXPIRED", "ACCEPTED"], "X's share EXPIRED with X, Y's ACCEPTED");
      } else {
        assert.match(said(valueOf(accepted as PromiseSettledResult<Reply>, "AcceptAttribution")), SHARE_NOT_REVIEWABLE, "the acceptance naming X's expired share");
        assert.deepEqual([await frozen(allocationId), ...(await claimStates(att.claimIds))], [false, "EXPIRED", "SUBMITTED"], "nothing frozen; X's claim EXPIRED, Y's left SUBMITTED");
      }
      assert.equal(await tailsOf(x.sellerId), 0, `${order}: no tail for X`);
      if (order === "TERMINATION_FIRST") {
        await ctx.fenced("the split's acceptance after X's termination", () => refusedWith(acceptClaim(att.claimIds[1]!, allocationId, freshKey(`${label}-fenced`))), isRefusal(SHARE_NOT_REVIEWABLE));
        assert.equal(await frozen(allocationId), false);
      }
    }
  },
);

// =====================================================================================================================================
// TAIL_PURCHASE_RACE: the agency's first-purchase designation racing TerminateSeller whose manifest names the agency's claim
// =====================================================================================================================================

/** An agency whose seller's claim is ACCEPTED (listed by the termination), with an order the provider captured: only the webhook is left. */
async function listedWithCapture(label: string): Promise<{ readonly s: RecordedSeller; readonly claimId: string; readonly agencyId: string; readonly providerCaptureId: string; readonly body: Record<string, unknown> }> {
  const s = await seller(iw, label);
  const op = await opportunityOf(iw, s, label);
  const quote = await quoted(iw, op.a, await planOf(iw, op.a, label, { units: 50_000 }));
  const order = await orderedThrough(iw, op.a, quote);
  iw.pw.paypal.approve(order.order.providerOrderId!);
  const providerCaptureId = iw.pw.paypal.captureAtProvider(order.order.providerOrderId!);
  return { s, claimId: op.claimId, agencyId: op.a.s.agency.agencyId, providerCaptureId, body: await terminationBody(iw, s.sellerId, [op.claimId]) };
}
const purchasesOf = async (agencyId: string): Promise<number> => (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.qualifying_purchases WHERE agency_id = $1", [agencyId]))[0]!.n;

/** The backend holding the agency's designation lock (the writer's half of kauro.agency_recurrence the designation trigger takes). */
async function designationHolder(agencyId: string): Promise<number> {
  const rows = await oracleRows<{ pid: number }>(
    iw,
    `SELECT l.pid FROM pg_locks l, (SELECT kauro.transition_key('kauro.agency_recurrence', $1) AS k) x
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 AND l.classid::text::bigint = ((x.k >> 32) & 4294967295) AND l.objid::text::bigint = (x.k & 4294967295)`,
    [agencyId],
  );
  assert.equal(rows.length, 1, "one backend holds the agency's designation lock");
  return rows[0]!.pid;
}

faultCell(
  {
    id: "TAIL_PURCHASE_RACE",
    step: "CMD050 TerminateSeller / RACE: X manifest entry whose claim lapses or whose agency purchases mid-way",
    fault: "race",
    expect:
      "RACE: an agency's first-purchase designation racing TerminateSeller whose manifest names that agency's claim, in both orders with the lock wait observed: the designation holding the agency first, the termination waits and its entry is 409 TAIL_NOT_ENUMERATED (the seller stays ACTIVE, no tail); the termination holding its tail entry first, the designation waits and lands after it: one tail entry whose effective instant precedes the purchase's confirmation",
  },
  async (ctx) => {
    // the designation first: held right after the authorization insert (its designation trigger complete, the agency's lock taken)
    {
      const x = await listedWithCapture("tail-race-purchase-first");
      const pause = ctx.points.pause("pay.authorizations.issue.after");
      const delivering = ctx.operation("the reconciler designating the first purchase (holder)", () => iw.faults.onPayment(ctx.points, () => deliver(iw.pw, "PAYMENT.CAPTURE.COMPLETED", x.providerCaptureId)));
      const wc = await open("kauro_app_test");
      try {
        await pause.reachedBy(delivering);
        const holder = await designationHolder(x.agencyId);
        const waiting = await afterward(() => ctx.mustWait(iw.h.oracle, { waiter: wc, holder }, (conn) => routed(ctx, conn, [], () => terminate(x.s.sellerId, freshKey("tail-race-1"), x.body)), "TerminateSeller while the designation holds the agency"), () => pause.release());
        assert.equal(completed<WebhookAck>((await delivering).reply, 200).data.inboxState, "APPLIED");
        assert.equal(said(valueOf(await waiting.pending, "TerminateSeller")), "409 PRECONDITION_FAILED TAIL_NOT_ENUMERATED", "a manifest entry of an agency that bought is not enumerable");
      } finally {
        await wc.end();
      }
      assert.deepEqual([await purchasesOf(x.agencyId), await tailsOf(x.s.sellerId), (await sellerRow(x.s.sellerId)).state], [1, 0, "ACTIVE"]);
    }
    // the termination first: held at its COMMIT with its tail entry written; the designation must wait for it
    {
      const x = await listedWithCapture("tail-race-term-first");
      const hc = await open("kauro_app_test");
      try {
        const pause = ctx.points.pause("uow.before-commit");
        const holding = ctx.operation("TerminateSeller (holder)", () => routed(ctx, hc, [], () => terminate(x.s.sellerId, freshKey("tail-race-2"), x.body)));
        await pause.reachedBy(holding);
        const delivering = deliver(iw.pw, "PAYMENT.CAPTURE.COMPLETED", x.providerCaptureId);
        let finished = false;
        void delivering.then(() => (finished = true), () => (finished = true));
        // the reconciler runs on the payment service's own pool (no harness connection for ctx.mustWait): observed within the harness bounds
        const blocked = await afterward(() => observeBlockedBy(connectionPid(hc), "kauro_payment_test", () => finished, "the designation while the termination holds the listed agency's tail entry"), () => pause.release());
        const t = completed<SellerTerminationView>(await holding, 200);
        assert.equal(completed<WebhookAck>((await delivering).reply, 200).data.inboxState, "APPLIED");
        assert.ok(blocked > 0, "the designation waited on the termination holding the listed agency's tail entry (it committed without waiting otherwise)");
        assert.equal(t.data.tailEntries, 1);
        const [order] = await oracleRows<{ precedes: boolean }>(
          iw,
          "SELECT t.effective_at < q.confirmed_at AS precedes FROM kauro.termination_tail_entries t JOIN kauro.qualifying_purchases q ON q.agency_id = t.agency_id WHERE t.claim_id = $1",
          [x.claimId],
        );
        assert.deepEqual(order, { precedes: true }, "the tail precedes the purchase");
      } finally {
        await hc.end();
      }
    }
  },
);

// =====================================================================================================================================
// CLAIM_LAPSE_ACCEPT (CMD050 X / EXPIRY): a listed claim expiring at the termination's effective instant
// =====================================================================================================================================

const SELLER_LOCK: SqlStep = { label: "seller_lock", match: /FROM kauro\.sellers WHERE seller_id = \$1 FOR NO KEY UPDATE/ };

faultCell(
  {
    id: "CLAIM_LAPSE_ACCEPT",
    step: "CMD050 TerminateSeller / EXPIRY: X manifest entry whose claim lapses or whose agency purchases mid-way",
    fault: "expiry",
    expect:
      "DENY: a manifest entry whose ACCEPTED claim's 2160-hour acceptance window ends at the termination's effective instant on the database clock is not enumerable: 409 TAIL_NOT_ENUMERATED, the seller stays ACTIVE at its version, the claim ACCEPTED, no tail entry, no committed journal answer",
  },
  async (ctx) => {
    const s = await seller(iw, "lapse-at-effective");
    const op = await opportunityOf(iw, s, "lapse-at-effective");
    const [row] = await oracleRows<{ expires_at: string }>(iw, `SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at FROM kauro.attribution_claims WHERE claim_id = $1`, [op.claimId]);
    const expiresAt = row!.expires_at;
    const firstNotBefore = msOf(expiresAt) + (/\.\d{3}000Z$/.test(expiresAt) ? 0 : 1);
    ctx.deadline(firstNotBefore, "the listed claim's acceptance window's end");
    const body = await terminationBody(iw, s.sellerId, [op.claimId]);
    const before = await sellerRow(s.sellerId);
    ctx.clock.set(firstNotBefore);
    const key = freshKey("lapse-at-effective");
    const conn = await open("kauro_app_test");
    let reply: Reply;
    try {
      const pause = ctx.points.pause("db.seller_lock.before");
      reply = await ctx.operation("the termination, its database clock at the claim's end", async (opn) => {
        const running = routed(ctx, conn, [SELLER_LOCK], () => terminate(s.sellerId, key, body));
        try {
          await pause.reachedBy(running);
          await opn.clock.onServer(conn);
        } finally {
          pause.release();
        }
        return running;
      });
    } finally {
      await conn.end();
    }
    assert.equal(said(reply), "409 PRECONDITION_FAILED TAIL_NOT_ENUMERATED", "a claim ending at the effective instant has no tail");
    assert.deepEqual(await sellerRow(s.sellerId), before, "the seller stays ACTIVE at its version");
    assert.deepEqual([...(await claimStates([op.claimId])), await tailsOf(s.sellerId)], ["ACCEPTED", 0]);
    assert.notEqual(await journalState(key), "COMMITTED");
  },
);


// CLAIM_LAPSE_TAIL (X, ADV-1, ADV-7): the listed claim's acceptance window ending after the termination's KC011 judgement began, during its
// wait on the agency's recurrence lock, or between its tail entry and its COMMIT (0049 termination_tail_entries_in_window)
faultCell(
  {
    id: "CLAIM_LAPSE_TAIL",
    step: "CMD050 TerminateSeller / RACE: X manifest entry whose claim lapses while the termination waits on the agency's recurrence lock",
    fault: "race",
    expect:
      "RACE: TerminateSeller whose database clock stands before its listed ACCEPTED claim's acceptance-window end when it starts, and that waits on the agency's recurrence lock (held exclusively, as a refund's completion or a capture's reversal holds it, 0028) until the window has ended, writes no tail entry: 409 TAIL_NOT_ENUMERATED, the seller ACTIVE at its version, the claim ACCEPTED, no tail; KC011 judges the window at the instant of its statement after the wait (kauro.effect_now()) and again at COMMIT",
  },
  async (ctx) => {
    const s = await seller(iw, "lapse-during-wait");
    const op = await opportunityOf(iw, s, "lapse-during-wait");
    const [row] = await oracleRows<{ expires_at: string }>(iw, `SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at FROM kauro.attribution_claims WHERE claim_id = $1`, [op.claimId]);
    const expiresAt = row!.expires_at;
    const body = await terminationBody(iw, s.sellerId, [op.claimId]);
    const before = await sellerRow(s.sellerId);
    const holder = await open("kauro_app_test");
    const waiter = await open("kauro_app_test");
    const key = freshKey("lapse-during-wait");
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.agency_recurrence', $1))", [op.a.s.agency.agencyId]);
      const pause = ctx.points.pause("db.seller_lock.before");
      let instant = "";
      const waiting = await ctx.mustWait(iw.h.oracle, { waiter, holder: connectionPid(holder) }, async (conn) => {
        const running = routed(ctx, conn, [SELLER_LOCK], () => terminate(s.sellerId, key, body));
        try {
          await pause.reachedBy(running);
          // the termination's effect clock the harness margin before the window's end at its seller lock (ADV-8: no literal margin)
          instant = await effectClockBefore(ctx, conn, expiresAt);
        } finally {
          pause.release();
        }
        return running;
      }, "the termination while the agency's recurrence lock is held");
      // the claim's window ends while the termination waits: its effect clock, measured on the database, runs past it (never a fixed sleep)
      await crossedWhileWaiting(waiter, holder, instant, expiresAt, "the termination waiting on the agency's recurrence lock");
      await holder.query("COMMIT");
      assert.equal(said(valueOf(await waiting.pending, "TerminateSeller")), "409 PRECONDITION_FAILED TAIL_NOT_ENUMERATED", "a window that ended during the wait enumerates no tail");
    } finally {
      await holder.end();
      await waiter.end();
    }
    assert.deepEqual(await sellerRow(s.sellerId), before, "the seller stays ACTIVE at its version");
    assert.deepEqual([...(await claimStates([op.claimId])), await tailsOf(s.sellerId)], ["ACCEPTED", 0]);
    assert.notEqual(await journalState(key), "COMMITTED");
  },
);

faultCell(
  {
    id: "CLAIM_LAPSE_TAIL",
    step: "CMD050 TerminateSeller / EXPIRY: X manifest entry whose claim's window ends between its tail entry and the COMMIT",
    fault: "expiry",
    expect:
      "DENY: TerminateSeller whose listed ACCEPTED claim's acceptance window was still running when its tail entry was written (KC011 judged at the insert) and ends while the termination stands at its COMMIT is 409 PRECONDITION_FAILED TAIL_NOT_ENUMERATED (the COMMIT judge termination_tail_entries_in_window) and commits nothing: the seller ACTIVE at its version, the claim ACCEPTED, no tail entry, no committed journal answer",
  },
  async (ctx) => {
    const s = await seller(iw, "lapse-at-commit");
    const op = await opportunityOf(iw, s, "lapse-at-commit");
    const [row] = await oracleRows<{ expires_at: string }>(iw, `SELECT to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at FROM kauro.attribution_claims WHERE claim_id = $1`, [op.claimId]);
    const expiresAt = row!.expires_at;
    ctx.deadline(msOf(expiresAt) + (/\.\d{3}000Z$/.test(expiresAt) ? 0 : 1), "the listed claim's acceptance window's end");
    const body = await terminationBody(iw, s.sellerId, [op.claimId]);
    const before = await sellerRow(s.sellerId);
    const key = freshKey("lapse-at-commit");
    const conn = await open("kauro_app_test");
    let reply: Reply;
    try {
      const pause = ctx.points.pause("uow.before-commit");
      const passedBefore = ctx.points.passed.length;
      reply = await ctx.operation("the termination, its database clock moved past the claim's window end at its COMMIT", async (opn) => {
        const running = routed(ctx, conn, [TAIL_INSERT], () => terminate(s.sellerId, key, body));
        try {
          await pause.reachedBy(running);
          assert.ok(ctx.points.passed.slice(passedBefore).includes("db.tail_insert.after"), "the tail entry was written (KC011 admitted it) before the COMMIT");
          const ahead = await conn.query<{ ahead: boolean }>("SELECT kauro.effect_now() < $1::timestamptz AS ahead", [expiresAt]);
          assert.equal(ahead.rows[0]!.ahead, true, "the claim's window is still running when the termination reaches its COMMIT");
          ctx.clock.past(expiresAt);
          await opn.clock.onServer(conn);
          const crossed = await conn.query<{ crossed: boolean }>("SELECT kauro.effect_now() >= $1::timestamptz AS crossed", [expiresAt]);
          assert.equal(crossed.rows[0]!.crossed, true, "the database clock crossed the window's end before the COMMIT");
        } finally {
          pause.release();
        }
        return running;
      });
    } finally {
      await conn.end();
    }
    assert.equal(said(reply), "409 PRECONDITION_FAILED TAIL_NOT_ENUMERATED", "a window that ended before the COMMIT enumerates no tail");
    assert.deepEqual(await sellerRow(s.sellerId), before, "the seller stays ACTIVE at its version");
    assert.deepEqual([...(await claimStates([op.claimId])), await tailsOf(s.sellerId)], ["ACCEPTED", 0], "the claim ACCEPTED, no tail entry");
    assert.notEqual(await journalState(key), "COMMITTED", "no committed answer is journaled");
  },
);
// =====================================================================================================================================
// CMD049 ActivateSeller: SELLER_IDENT_RACE, CORP_REV, CMD_EXP_ASSURE
// =====================================================================================================================================

/** A CANDIDATE seller with every activation fact (the person its token names exists first) and CMD049's body with a fresh step-up of `who`. */
async function candidate(label: string, who: Person = iw.owner): Promise<{ readonly sellerId: string; readonly userId: string; readonly agreementId: string; readonly person: Person; readonly body: () => Promise<Record<string, unknown>> }> {
  const person = await iw.w.person(`seller-${label}`);
  const c = await candidateSeller(iw.h, iw.owner.userId as UserId, label);
  assert.equal(person.userId, c.userId);
  return { sellerId: c.sellerId, userId: c.userId, agreementId: c.agreementId, person, body: async () => ({ agreementId: c.agreementId, assessmentEvidenceRef: c.assessmentRef, assuranceProofRef: await iw.w.stepUp(who) }) };
}

const DISABLE_IDENTITY = "UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1";
/** The seller's own identity sync withdrawing its MFA enrolment (its kauro_app session, identities_self_sync), on `conn`, left open. */
async function withdrawMfa(conn: HarnessConnection, userId: string): Promise<void> {
  await conn.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await conn.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [userId]);
  const r = await conn.query("UPDATE kauro.identities SET mfa_enrolled_at = NULL, updated_at = now() WHERE user_id = $1", [userId]);
  assert.equal(r.rowCount, 1);
}
const platformConn = (): Promise<HarnessConnection> => bounded("postgres");

/** The holder held at `at`, the waiter observed waiting on it, then both settle (the waiter's operation on a harness connection of its own). */
async function holdAndWait<W>(ctx: FaultContext, what: string, holder: { readonly login: "kauro_app_test"; run(conn: HarnessConnection): Promise<Reply> }, waiterConn: HarnessConnection, waiter: (conn: HarnessConnection) => Promise<W>, at = "uow.before-commit"): Promise<{ readonly held: Reply; readonly waited: PromiseSettledResult<W> }> {
  const hc = await open(holder.login);
  try {
    const pause = ctx.points.pause(at);
    const holding = ctx.operation(`${what} (holder)`, () => holder.run(hc));
    await pause.reachedBy(holding);
    const waiting = await afterward(() => ctx.mustWait(iw.h.oracle, { waiter: waiterConn, holder: connectionPid(hc) }, waiter, what), () => pause.release());
    const held = await holding;
    return { held, waited: await waiting.pending };
  } finally {
    await hc.end();
  }
}

faultCell(
  {
    id: "SELLER_IDENT_RACE",
    step: "CMD049 ActivateSeller / RACE: I candidate seller's ACTIVE verified identity with verified e-mail and MFA, read through the owner's policy",
    fault: "race",
    expect:
      "RACE: deactivating the target seller's identity or removing its MFA while ActivateSeller waits, in both orders with the lock wait observed: the activation committed first is followed by the withdrawal and handled by it (a disabled identity's seller is refused 403 IDENTITY_DISABLED), a withdrawal committed first refuses the activation 409 SELLER_NOT_ACTIVATABLE with the seller left CANDIDATE: never an activation resting on stale identity authority",
  },
  async (ctx) => {
    // identity disabled (the platform's security operation), activation first: the disable waits for it and then restricts the new seller
    {
      const c = await candidate("ident-race-disable-a");
      const pc = await platformConn();
      try {
        const r = await holdAndWait(ctx, "the identity disable while the activation holds the identity's shared half", { login: "kauro_app_test", run: (conn) => routed(ctx, conn, [], async () => activate(c.sellerId, freshKey("ident-race-1"), await c.body())) }, pc, (conn) => conn.query(DISABLE_IDENTITY, [c.userId]));
        assert.equal(said(r.held), "200");
        assert.equal(valueOf(r.waited, "the disable").rowCount, 1);
      } finally {
        await pc.end();
      }
      assert.equal((await sellerRow(c.sellerId)).state, "ACTIVE");
      const after = await registerProspect(c.person, freshKey("ident-race-1-after"), { organizationLabel: "ident-race-after.example", businessContactRef: ids.next(), sourceEvidenceHash: "0".repeat(64), jurisdiction: "United States" });
      assert.equal(said(after), "403 NOT_AUTHORIZED IDENTITY_DISABLED", "the activated seller of a disabled identity acts on nothing");
    }
    // identity disabled first (uncommitted): the activation waits on the identity's lock, then is refused
    {
      const c = await candidate("ident-race-disable-b");
      const pc = await platformConn();
      const wc = await open("kauro_app_test");
      try {
        await pc.query("BEGIN");
        await pc.query(DISABLE_IDENTITY, [c.userId]);
        const body = await c.body();
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(pc) }, (conn) => routed(ctx, conn, [], () => activate(c.sellerId, freshKey("ident-race-2"), body)), "the activation while the identity disable is uncommitted");
        await pc.query("COMMIT");
        assert.equal(said(valueOf(await waiting.pending, "the activation")), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE");
      } finally {
        await pc.end();
        await wc.end();
      }
      assert.equal((await sellerRow(c.sellerId)).state, "CANDIDATE");
    }
    // MFA withdrawn by the identity's own sync, activation first: the withdrawal must wait for the activation
    {
      const c = await candidate("ident-race-mfa-a");
      const sc = await open("kauro_app_test");
      try {
        const r = await holdAndWait(ctx, "the MFA withdrawal while the activation holds", { login: "kauro_app_test", run: (conn) => routed(ctx, conn, [], async () => activate(c.sellerId, freshKey("ident-race-3"), await c.body())) }, sc, async (conn) => {
          await withdrawMfa(conn, c.userId);
          await conn.query("COMMIT");
        });
        assert.equal(said(r.held), "200");
        valueOf(r.waited, "the MFA withdrawal");
      } finally {
        await sc.end();
      }
    }
    // MFA withdrawn first (uncommitted): the activation must wait for it, then is refused
    {
      const c = await candidate("ident-race-mfa-b");
      const sc = await open("kauro_app_test");
      const wc = await open("kauro_app_test");
      try {
        await withdrawMfa(sc, c.userId);
        const body = await c.body();
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(sc) }, (conn) => routed(ctx, conn, [], () => activate(c.sellerId, freshKey("ident-race-4"), body)), "the activation while the MFA withdrawal is uncommitted");
        await sc.query("COMMIT");
        assert.equal(said(valueOf(await waiting.pending, "the activation")), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE");
      } finally {
        await sc.end();
        await wc.end();
      }
      assert.equal((await sellerRow(c.sellerId)).state, "CANDIDATE");
    }
  },
);

faultCell(
  {
    id: "SELLER_IDENT_RACE",
    step: "CMD049 ActivateSeller / REVOCATION: I candidate seller's ACTIVE verified identity with verified e-mail and MFA, read through the owner's policy",
    fault: "revocation",
    expect:
      "DENY: the target identity's MFA withdrawn after ActivateSeller read its prerequisites and before its write, and the identity disabled while the activation waits on it, each refuse the activation 409 SELLER_NOT_ACTIVATABLE at the write by the database's re-check (KC005): the seller stays CANDIDATE at version 1",
  },
  async (ctx) => {
    // MFA withdrawn between the prerequisite read and the seller's UPDATE
    {
      const c = await candidate("ident-rev-mfa");
      const conn = await open("kauro_app_test");
      const sc = await open("kauro_app_test");
      try {
        const pause = ctx.points.pause("db.seller_update.before");
        const body = await c.body();
        const running = ctx.operation("the activation, paused before its write", () => routed(ctx, conn, [SELLER_UPDATE], () => activate(c.sellerId, freshKey("ident-rev-1"), body)));
        try {
          await pause.reachedBy(running);
          await ctx.revoked("the seller's MFA enrolment", async () => {
            await withdrawMfa(sc, c.userId);
            await sc.query("COMMIT");
          });
        } finally {
          pause.release();
        }
        await ctx.fenced("the activation resting on the withdrawn MFA", () => refusedWith(running), isRefusal(/^409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE$/));
      } finally {
        await conn.end();
        await sc.end();
      }
      assert.deepEqual(await sellerRow(c.sellerId), { state: "CANDIDATE", version: 1 });
    }
    // the identity disabled while the activation waits on the identity's lock
    {
      const c = await candidate("ident-rev-disable");
      const pc = await platformConn();
      const wc = await open("kauro_app_test");
      try {
        await pc.query("BEGIN");
        await pc.query(DISABLE_IDENTITY, [c.userId]);
        const body = await c.body();
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(pc) }, (conn) => routed(ctx, conn, [], () => activate(c.sellerId, freshKey("ident-rev-2"), body)), "the activation while the identity disable is uncommitted");
        await ctx.revoked("the seller's identity", () => pc.query("COMMIT"));
        await ctx.fenced("the activation that waited on the disabled identity", async () => refusedWith(Promise.resolve(valueOf(await waiting.pending, "the activation"))), isRefusal(/^409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE$/));
      } finally {
        await pc.end();
        await wc.end();
      }
      assert.deepEqual(await sellerRow(c.sellerId), { state: "CANDIDATE", version: 1 });
    }
  },
);

const REVOKE_GRANT = "UPDATE kauro.corporate_roles SET state = 'REVOKED', revoked_at = now() WHERE grant_id = $1 AND state = 'ACTIVE'";
const WITHDRAW_AGREEMENT = "UPDATE kauro.seller_agreements SET ends_at = now(), version = version + 1 WHERE agreement_id = $1";

faultCell(
  {
    id: "CORP_REV",
    step: "CMD049 ActivateSeller / REVOCATION: W seller ACTIVE (one COMMIT; KC005 checked at the database)",
    fault: "revocation",
    expect:
      "RACE: a KAURO_OWNER grant revoked while ActivateSeller waits on the grant's transition lock refuses with 403 NOT_AUTHORIZED and writes nothing (the seller CANDIDATE); an activation holding the grant commits first and the revocation lands after it; every activation by the revoked owner after it is refused; the candidate's agreement withdrawn by the owner while the activation runs is ordered with it in both orders: withdrawn first, the activation waits and is 409 SELLER_NOT_ACTIVATABLE; activated first, the withdrawal waits for the activation (a VERIFIED destination is superseded only by a later VERIFIED version, so the destination prerequisite cannot be withdrawn mid-way)",
  },
  async (ctx) => {
    const ownerWithGrant = async (name: string) => {
      const person = await iw.w.person(name);
      return { person, grantId: await iw.h.grantKauroOwner(person.userId as UserId) };
    };
    // the revocation first, uncommitted: the activation waits on the grant's transition lock, then finds the grant revoked
    {
      const early = await ownerWithGrant("corp-rev-early");
      const c = await candidate("corp-rev-early-seller", early.person);
      const body = await c.body();
      const rc = await bounded("kauro_control_test");
      const wc = await open("kauro_app_test");
      try {
        await rc.query("BEGIN");
        await rc.query(REVOKE_GRANT, [early.grantId]);
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(rc) }, (conn) => routed(ctx, conn, [], () => activate(c.sellerId, freshKey("corp-rev-1"), body, early.person)), "the activation while the owner's grant revocation is uncommitted");
        await ctx.revoked("the owner's grant", () => rc.query("COMMIT"));
        assert.match(said(valueOf(await waiting.pending, "the activation")), /^403 NOT_AUTHORIZED /);
      } finally {
        await rc.end();
        await wc.end();
      }
      assert.deepEqual(await sellerRow(c.sellerId), { state: "CANDIDATE", version: 1 });
    }
    // the activation first (held at its COMMIT, holding the grant's shared half): the revocation waits and lands after it
    {
      const late = await ownerWithGrant("corp-rev-late");
      const c = await candidate("corp-rev-late-seller", late.person);
      const body = await c.body();
      const rc = await bounded("kauro_control_test");
      try {
        const r = await holdAndWait(ctx, "the grant revocation while the owner's activation is held", { login: "kauro_app_test", run: (conn) => routed(ctx, conn, [], () => activate(c.sellerId, freshKey("corp-rev-2"), body, late.person)) }, rc, (conn) => conn.query(REVOKE_GRANT, [late.grantId]));
        assert.equal(said(r.held), "200");
        await ctx.revoked("the owner's grant", async () => assert.equal(valueOf(r.waited, "the revocation").rowCount, 1));
      } finally {
        await rc.end();
      }
      assert.equal((await sellerRow(c.sellerId)).state, "ACTIVE", "the activation that held the grant committed before the revocation");
      const next = await candidate("corp-rev-after-seller", late.person);
      const nextBody = await next.body();
      await ctx.fenced("an activation by the revoked owner", () => refusedWith(activate(next.sellerId, freshKey("corp-rev-3"), nextBody, late.person)), isRefusal(/^403 NOT_AUTHORIZED /));
      assert.equal((await sellerRow(next.sellerId)).state, "CANDIDATE");
    }
    // the agreement withdrawn first (uncommitted): the activation must wait for it, then is refused
    {
      const c = await candidate("corp-rev-agreement-b");
      const body = await c.body();
      const oc = await open("kauro_app_test");
      const wc = await open("kauro_app_test");
      try {
        await oc.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await oc.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [iw.owner.userId]);
        assert.equal((await oc.query(WITHDRAW_AGREEMENT, [c.agreementId])).rowCount, 1);
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(oc) }, (conn) => routed(ctx, conn, [], () => activate(c.sellerId, freshKey("corp-rev-4"), body)), "the activation while the agreement's withdrawal is uncommitted");
        await oc.query("COMMIT");
        assert.equal(said(valueOf(await waiting.pending, "the activation")), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE");
      } finally {
        await oc.end();
        await wc.end();
      }
      assert.deepEqual(await sellerRow(c.sellerId), { state: "CANDIDATE", version: 1 });
    }
    // the activation first: the agreement's withdrawal must wait for it
    {
      const c = await candidate("corp-rev-agreement-a");
      const body = await c.body();
      const oc = await open("kauro_app_test");
      try {
        const r = await holdAndWait(ctx, "the agreement's withdrawal while the activation is held", { login: "kauro_app_test", run: (conn) => routed(ctx, conn, [], () => activate(c.sellerId, freshKey("corp-rev-5"), body)) }, oc, async (conn) => {
          await conn.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await conn.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [iw.owner.userId]);
          await conn.query(WITHDRAW_AGREEMENT, [c.agreementId]);
          await conn.query("COMMIT");
        });
        assert.equal(said(r.held), "200");
        valueOf(r.waited, "the withdrawal");
      } finally {
        await oc.end();
      }
    }
  },
);

faultCell(
  {
    id: "CMD_EXP_ASSURE",
    step: "CMD049 ActivateSeller / EXPIRY: W seller ACTIVE (one COMMIT; KC005 checked at the database)",
    fault: "expiry",
    expect:
      "DENY: a step-up that passes its window between the guard and COMMIT is 403 ASSURANCE_REQUIRED STEP_UP_STALE and the seller stays CANDIDATE at version 1: the database judges the owner's step-up again at the COMMIT instant",
  },
  async (ctx) => {
    const c = await candidate("exp-assure");
    const api = iw.w.processClock;
    // a proof of the owner fresh now (issued 14 minutes ago on the api clock) that expires one minute from now
    const proof = await iw.h.recordStepUp(iw.owner.userId as UserId, { issuedAt: new Date(api.nowMs() - 14 * 60_000).toISOString() as never });
    const [row] = await oracleRows<{ expires_at: Date }>(iw, "SELECT expires_at FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]);
    const expiresAt = row!.expires_at.toISOString();
    ctx.deadline(expiresAt, "the owner's step-up proof's expiry");
    const body = { agreementId: c.agreementId, assessmentEvidenceRef: (await oracleRows<{ assessment_id: string }>(iw, "SELECT assessment_id FROM kauro.seller_assessments WHERE seller_id = $1", [c.sellerId]))[0]!.assessment_id, assuranceProofRef: proof };
    const conn = await open("kauro_app_test");
    let reply: Reply;
    try {
      const pause = ctx.points.pause("uow.before-commit");
      reply = await ctx.operation("the activation, its database clock moved past the proof's expiry before its COMMIT", async (op) => {
        const running = routed(ctx, conn, [], () => activate(c.sellerId, freshKey("exp-assure"), body));
        try {
          await pause.reachedBy(running);
          const fresh = await conn.query<{ fresh: boolean }>("SELECT kauro.effect_now() < $1::timestamptz AS fresh", [expiresAt]);
          assert.equal(fresh.rows[0]!.fresh, true, "the proof is fresh when the activation reaches its COMMIT");
          ctx.clock.past(expiresAt, 1_000);
          await op.clock.onServer(conn);
          const crossed = await conn.query<{ crossed: boolean }>("SELECT kauro.effect_now() > $1::timestamptz AS crossed", [expiresAt]);
          assert.equal(crossed.rows[0]!.crossed, true, "the database clock crossed the proof's expiry before the COMMIT");
        } finally {
          pause.release();
        }
        return running;
      });
    } finally {
      await conn.end();
    }
    assert.equal(said(reply), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "an expired step-up admits no activation");
    assert.deepEqual(await sellerRow(c.sellerId), { state: "CANDIDATE", version: 1 });
  },
);

// =====================================================================================================================================
// SELLER_ACT_RACE: TerminateSeller racing RegisterProspect, ClaimProspect or AssignAccount of the seller, in both orders
// =====================================================================================================================================

const REFUSED_SELLER = /^403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING$/;

faultCell(
  {
    id: "SELLER_ACT_RACE",
    step: "CMD045 RegisterProspect / REVOCATION: W prospect + source-evidence binding (one COMMIT)",
    fault: "revocation",
    expect:
      "RACE: TerminateSeller racing RegisterProspect of the seller in both orders with the lock wait observed: a registration that committed first is handled by the termination (the prospect left unowned, counted in prospectsUnassigned); a registration that waited on the termination is refused 403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING (a seller who may not act: the seller authorizer, packages/application/src/commercial/authorizer.ts) and writes no prospect; every registration of the terminated seller after it is refused the same way",
  },
  async (ctx) => {
    for (const order of ["WRITE_FIRST", "TERMINATION_FIRST"] as const) {
      const label = `act-race-register-${order === "WRITE_FIRST" ? "w" : "t"}`;
      const s = await seller(iw, label);
      const domain = `${label}.example`;
      const evidence = await recordSourceEvidence(iw.h, { userId: s.userId, sellerId: s.sellerId }, { domain });
      const regBody = { organizationLabel: domain, businessContactRef: evidence.contactRef, sourceEvidenceHash: evidence.sourceEvidenceHash, jurisdiction: "United States" };
      const body = await terminationBody(iw, s.sellerId, []);
      const write = appActor(ctx, "RegisterProspect", () => registerProspect(s.person, freshKey(label), regBody));
      const term = appActor(ctx, "TerminateSeller", () => terminate(s.sellerId, freshKey(label), body));
      const out = order === "WRITE_FIRST" ? await contend(ctx, write, term, order) : await contend(ctx, term, write, order);
      const [w, t] = order === "WRITE_FIRST" ? [out.holder, out.waiter] : [out.waiter, out.holder];
      const termination = completed<SellerTerminationView>(valueOf(t as PromiseSettledResult<Reply>, "TerminateSeller"), 200);
      await ctx.revoked(`the seller's termination (${order})`, async () => assert.equal((await sellerRow(s.sellerId)).state, "TERMINATED"));
      const prospects = await oracleRows<{ owner_seller_id: string | null }>(iw, "SELECT owner_seller_id FROM kauro.prospects WHERE registered_by_seller_id = $1 AND organization_label = $2", [s.sellerId, domain]);
      if (order === "WRITE_FIRST") {
        assert.equal(said(valueOf(w as PromiseSettledResult<Reply>, "RegisterProspect")), "201");
        assert.deepEqual(prospects, [{ owner_seller_id: null }], "the prospect registered first is unassigned by the termination");
        assert.ok(termination.data.prospectsUnassigned >= 1);
      } else {
        assert.match(said(valueOf(w as PromiseSettledResult<Reply>, "RegisterProspect")), REFUSED_SELLER);
        assert.deepEqual(prospects, [], "no prospect written");
        await ctx.fenced("a registration by the terminated seller", () => refusedWith(registerProspect(s.person, freshKey(`${label}-after`), regBody)), isRefusal(REFUSED_SELLER));
      }
    }
  },
);

faultCell(
  {
    id: "SELLER_ACT_RACE",
    step: "CMD046 ClaimProspect / REVOCATION: W claim + deadline + conflict review (one COMMIT)",
    fault: "revocation",
    expect:
      "RACE: TerminateSeller racing ClaimProspect of the seller in both orders with the lock wait observed: a claim that committed first is handled by the termination (EXPIRED with its unlisted seller, counted in claimsExpired: never a live claim of a TERMINATED seller without tail); a claim that waited on the termination is refused 403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING and writes nothing; every claim of the terminated seller after it is refused the same way",
  },
  async (ctx) => {
    for (const order of ["WRITE_FIRST", "TERMINATION_FIRST"] as const) {
      const label = `act-race-claim-${order === "WRITE_FIRST" ? "w" : "t"}`;
      const s = await seller(iw, label);
      const prospect = await recordProspect(iw.h, { by: s, domain: `${label}.example` });
      const evidenceHash = await recordClaimEvidence(iw.h, s, prospect.prospectId);
      const claimBody = { evidenceHash, agreementVersion: s.agreementVersion };
      const body = await terminationBody(iw, s.sellerId, []);
      const write = appActor(ctx, "ClaimProspect", () => claimProspect(s.person, prospect.prospectId, freshKey(label), claimBody));
      const term = appActor(ctx, "TerminateSeller", () => terminate(s.sellerId, freshKey(label), body));
      const out = order === "WRITE_FIRST" ? await contend(ctx, write, term, order) : await contend(ctx, term, write, order);
      const [w, t] = order === "WRITE_FIRST" ? [out.holder, out.waiter] : [out.waiter, out.holder];
      const termination = completed<SellerTerminationView>(valueOf(t as PromiseSettledResult<Reply>, "TerminateSeller"), 200);
      await ctx.revoked(`the seller's termination (${order})`, async () => assert.equal((await sellerRow(s.sellerId)).state, "TERMINATED"));
      const claims = await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.attribution_claims WHERE prospect_id = $1", [prospect.prospectId]);
      if (order === "WRITE_FIRST") {
        assert.equal(said(valueOf(w as PromiseSettledResult<Reply>, "ClaimProspect")), "201");
        assert.deepEqual([claims, termination.data.claimsExpired], [[{ state: "EXPIRED" }], 1], "the claim submitted first is EXPIRED by the termination");
      } else {
        assert.match(said(valueOf(w as PromiseSettledResult<Reply>, "ClaimProspect")), REFUSED_SELLER);
        assert.deepEqual(claims, [], "no claim written");
        await ctx.fenced("a claim by the terminated seller", () => refusedWith(claimProspect(s.person, prospect.prospectId, freshKey(`${label}-after`), claimBody)), isRefusal(REFUSED_SELLER));
      }
    }
  },
);

faultCell(
  {
    id: "SELLER_ACT_RACE",
    step: "CMD048 AssignAccount / REVOCATION: W end previous assignment + append new current + service assignment link (one COMMIT)",
    fault: "revocation",
    expect:
      "RACE: TerminateSeller racing AssignAccount to the seller in both orders with the lock wait observed: an assignment that committed first is ended by the termination (a SELLER_TERMINATED link current, assignmentsEnded 1); an assignment that waited on the termination is 409 SELLER_NOT_ACTIVE and opens no account; every assignment to the terminated seller after it is refused the same way",
  },
  async (ctx) => {
    for (const order of ["WRITE_FIRST", "TERMINATION_FIRST"] as const) {
      const label = `act-race-assign-${order === "WRITE_FIRST" ? "w" : "t"}`;
      const s = await seller(iw, label);
      const a = await agentOf(iw, label);
      const agencyId = a.s.agency.agencyId;
      const assignBody = { expectedVersion: 0, sellerId: s.sellerId, serviceAssignmentRef: await recordServiceAssignment(iw.h, { ownerUserId: iw.owner.userId as UserId, agencyId, sellerId: s.sellerId }) };
      const body = await terminationBody(iw, s.sellerId, []);
      const write = appActor(ctx, "AssignAccount", () => assignAccount(agencyId, freshKey(label), assignBody));
      const term = appActor(ctx, "TerminateSeller", () => terminate(s.sellerId, freshKey(label), body));
      const out = order === "WRITE_FIRST" ? await contend(ctx, write, term, order) : await contend(ctx, term, write, order);
      const [w, t] = order === "WRITE_FIRST" ? [out.holder, out.waiter] : [out.waiter, out.holder];
      const termination = completed<SellerTerminationView>(valueOf(t as PromiseSettledResult<Reply>, "TerminateSeller"), 200);
      await ctx.revoked(`the seller's termination (${order})`, async () => assert.equal((await sellerRow(s.sellerId)).state, "TERMINATED"));
      const current = await oracleRows<{ reason: string; seller_id: string | null }>(iw, "SELECT c.reason, c.seller_id FROM kauro.sales_accounts s JOIN kauro.account_assignments c ON c.assignment_id = s.current_assignment_id WHERE s.agency_id = $1", [agencyId]);
      if (order === "WRITE_FIRST") {
        assert.equal(said(valueOf(w as PromiseSettledResult<Reply>, "AssignAccount")), "200");
        assert.deepEqual([current, termination.data.assignmentsEnded], [[{ reason: "SELLER_TERMINATED", seller_id: null }], 1], "the assignment made first is ended by the termination");
      } else {
        assert.equal(said(valueOf(w as PromiseSettledResult<Reply>, "AssignAccount")), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVE");
        assert.deepEqual(current, [], "no account opened");
        await ctx.fenced("an assignment to the terminated seller", () => refusedWith(assignAccount(agencyId, freshKey(`${label}-after`), assignBody)), isRefusal(/^409 PRECONDITION_FAILED SELLER_NOT_ACTIVE$/));
      }
    }
  },
);

