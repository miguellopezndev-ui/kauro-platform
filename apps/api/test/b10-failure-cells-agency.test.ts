// The 6a cells of the B10 failure matrix on the agency lifecycle (docs/design/B10-failure-matrix.md "CMD002 ActivateAgency", "CMD043 CloseAgency"
// and the S2r/S3 rows of "CMD027 included-replacement protocol"; GAP codes QUOTE_CLOSE, CLOSE_INFLIGHT, CLOSE_PAR, INSPECT_FAIL, ACT_PAR and
// AGREEMENT_EXP for CMD002), each a cell of the common fault harness (docs/design/FAULT-HARNESS.md): the REAL routes of CMD043, CMD002, CMD027,
// CMD011 and CMD031 run their REAL units of work over connections the harness opened (`faults.on`), so a race cell observes one command waiting
// on the other's lock in pg_stat_activity, a partial cell fails after a statement of the unit completed. B06's ActiveWorkInspector is the
// edition's: its timeout cell holds a REAL lock (another session's LOCK TABLE) its first read waits on. PostgreSQL 17 through the runtime login
// roles; the superuser only reads. Nothing sleeps, except the bounded real-time wait of a timeout cell for an answer that must come.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { AgencyClosureView, CreateQuoteView } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { connectionPid, faultCell, openConnection, publishAgreementVersions, raceStatementTimeoutMs, recordReviewedFiscalProfile, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { createPurchaseRebinder } from "../src/index.js";
import type { PurchaseRebinder } from "@kauro/application";
import { agentOf, anotherClient, bought, integrationWorld, oracleRows, planOf, quoted, replacementPlanOf, type Agent, type IntegrationWorld } from "./integration-support.js";
import { bindCells, open } from "./b10-cells-support.js";
import { paymentRoutes } from "./commerce-support.js";
import type { SqlStep } from "./fault-support.js";
import { blockedBy, routedUnitsIssueWithTheRegistryPolicy } from "./b10-cells-6a-support.js";
import { call, completed, freshKey, ids, outcome, routes, type Person, type PlanFixture, type Reply } from "./support.js";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
  bindCells(iw);
  routedUnitsIssueWithTheRegistryPolicy();
  await publishAgreementVersions(iw.h, { terms: "TERMS-6A-1", privacy: "PRIVACY-6A-1" });
});
after(async () => {
  await iw.stop();
});

type Login = "kauro_app_test" | "kauro_payment_test" | "kauro_commission_test" | "kauro_control_test";
const connect = (login: Login): Promise<HarnessConnection> => openConnection(iw.h.pg.clientConfig(login));

/** Holds `holder` at `at` on its own connection, observes `waiter` waiting on it (pg_stat_activity, pg_blocking_pids), then lets both settle. */
async function holdAndWait<H, W>(ctx: FaultContext, what: string, holder: { readonly login: Login; run(c: HarnessConnection): Promise<H> }, waiter: { readonly login: Login; run(c: HarnessConnection): Promise<W> }, at: string): Promise<{ readonly held: PromiseSettledResult<H>; readonly waited: PromiseSettledResult<W> }> {
  const hc = await connect(holder.login);
  const wc = await connect(waiter.login);
  try {
    const pause = ctx.points.pause(at);
    const running = ctx.operation(`${what} (holder)`, () => holder.run(hc));
    const settledHolder = running.then<PromiseSettledResult<H>, PromiseSettledResult<H>>((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    await pause.reachedBy(running);
    const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (c) => waiter.run(c), what);
    pause.release();
    return { held: await settledHolder, waited: await waiting.pending };
  } finally {
    await hc.end();
    await wc.end();
  }
}
const value = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status !== "fulfilled") throw r.reason;
  return r.value;
};

/** Runs `run` as the operation that must fail at `at` after an earlier step of it completed; a 500 is the failure the api hid. */
async function failsAt(ctx: FaultContext, what: string, at: string, run: () => Promise<Reply>): Promise<void> {
  await ctx.partial(what, at, async () => {
    const seen = iw.w.internalErrors.length;
    const reply = await run();
    if (reply.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(`the request failed: ${reply.status} ${reply.text}`);
    return reply;
  });
}

// --- CloseAgency ---------------------------------------------------------------------------------------------------------------------

const agencyOf = async (agencyId: string): Promise<{ readonly state: string; readonly version: number }> => {
  const r = (await oracleRows<{ state: string; version: string }>(iw, "SELECT state, version::text AS version FROM kauro.agencies WHERE agency_id = $1", [agencyId]))[0]!;
  return { state: r.state, version: Number(r.version) };
};

async function closureBody(a: Agent): Promise<{ readonly expectedVersion: number; readonly assuranceProofRef: string }> {
  return { expectedVersion: (await agencyOf(a.s.agency.agencyId)).version, assuranceProofRef: await iw.w.stepUp(a.s.owner) };
}
const closeCall = (a: Agent, key: string, body: Record<string, unknown>): Promise<Reply> =>
  call(iw.w, { url: `/api/v1/agencies/${a.s.agency.agencyId}/closure-requests`, token: a.s.owner.token, agency: null, key, body });
const closeOn = (ctx: FaultContext, conn: HarnessConnection, a: Agent, key: string, body: Record<string, unknown>, steps: ReadonlyArray<SqlStep> = []): Promise<Reply> =>
  iw.faults.on(conn, "kauro_app", ctx.points, steps, () => closeCall(a, key, body));
const closed = (reply: Reply): AgencyClosureView => completed<AgencyClosureView>(reply, 200).data;

const quoteCall = (a: Agent, plan: { readonly planId: string; readonly projectId: string }, key: string): Promise<Reply> =>
  call(iw.w, { url: `/api/v1/projects/${plan.projectId}/quotes`, token: a.billing.token, agency: a.s.agency.agencyId, key, body: { planId: plan.planId, billingProfileRef: a.s.profileId } });
const quoteOn = (ctx: FaultContext, conn: HarnessConnection, a: Agent, plan: PlanFixture, key: string, steps: ReadonlyArray<SqlStep> = []): Promise<Reply> =>
  iw.faults.on(conn, "kauro_app", ctx.points, steps, () => quoteCall(a, plan, key));

interface Closing {
  readonly agency: { readonly state: string; readonly version: number };
  readonly quotes: ReadonlyArray<readonly [string, string]>;
  readonly reservations: ReadonlyArray<readonly [string, string, string | null]>;
  readonly heldSlots: number;
  readonly closures: number;
  readonly journal: string | null;
}
/** What a closure writes or leaves for the agency: its state and version, each quote's state, each reservation, the slots it holds, its closure records, the key's journal entry. */
async function closingOf(a: Agent, key: string): Promise<Closing> {
  const agencyId = a.s.agency.agencyId;
  const quotes = await oracleRows<{ quote_id: string; state: string }>(iw, "SELECT quote_id, state FROM kauro.quotes WHERE agency_id = $1 ORDER BY quote_id", [agencyId]);
  const reservations = await oracleRows<{ quote_id: string; state: string; release_reason: string | null }>(iw, "SELECT quote_id, state, release_reason FROM kauro.founding_slot_reservations WHERE agency_id = $1 ORDER BY created_at", [agencyId]);
  const held = await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.founding_slots WHERE live_agency_id = $1 AND held", [agencyId]);
  const closures = await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.agency_closures WHERE agency_id = $1", [agencyId]);
  return {
    agency: await agencyOf(agencyId),
    quotes: quotes.map((q) => [q.quote_id, q.state] as const),
    reservations: reservations.map((r) => [r.quote_id, r.state, r.release_reason] as const),
    heldSlots: held[0]!.n,
    closures: closures[0]!.n,
    journal: (await iw.w.journal(key))?.state ?? null,
  };
}
const freeSlots = async (): Promise<number> => (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL' AND NOT held"))[0]!.n;

/** An agency with two ISSUED quotes through CMD027: the first holding a founding reservation (when a slot is free), the second standard. */
async function withTwoQuotes(label: string): Promise<{ readonly a: Agent; readonly founding: string; readonly standard: string }> {
  assert.ok((await freeSlots()) >= 1, "a founding slot is free for the cell");
  const a = await agentOf(iw, label);
  const first = await quoted(iw, a, await planOf(iw, a, `${label}-1`, { units: 40_000 }));
  assert.equal(first.eligibility.foundingOffer, "RESERVED");
  const second = await quoted(iw, a, await planOf(iw, a, `${label}-2`, { units: 40_000 }));
  return { a, founding: first.quote.quoteId, standard: second.quote.quoteId };
}

const WITHDRAW_1: SqlStep = { label: "withdraw_1", match: /UPDATE kauro\.quotes AS q SET/, when: (p) => p[2] === "WITHDRAWN", nth: 1 };
const WITHDRAW_2: SqlStep = { label: "withdraw_2", match: /UPDATE kauro\.quotes AS q SET/, when: (p) => p[2] === "WITHDRAWN", nth: 2 };
const CLOSURE_INSERT: SqlStep = { label: "closure", match: /INSERT INTO kauro\.agency_closures/ };
const releaseOf = (quoteId: string): SqlStep => ({ label: "release", match: /UPDATE kauro\.founding_slot_reservations SET state = 'RELEASED'/, when: (p) => p[0] === quoteId });
const INSPECTION = (nth: number): SqlStep => ({ label: `inspect_${nth}`, match: /FROM kauro\.projects WHERE client_id = \$1 AND state = 'OPEN'/, nth });

// --- CLOSE_PAR ---------------------------------------------------------------------------------------------------------------------

/** One member of a CLOSE_PAR cell: the closure fails at `at`, nothing of it remains, the same key then closes once. */
async function closureFailsAt(ctx: FaultContext, label: string, what: string, at: string, steps: (x: { readonly founding: string }) => ReadonlyArray<SqlStep>): Promise<void> {
  const x = await withTwoQuotes(label);
  const key = freshKey(label);
  const before = await closingOf(x.a, key);
  assert.deepEqual([before.agency.state, before.quotes.map((q) => q[1]), before.reservations.map((r) => r[1]), before.heldSlots, before.closures], ["ACTIVE", ["ISSUED", "ISSUED"], ["RESERVED"], 1, 0]);
  const body = await closureBody(x.a);
  const conn = await open("kauro_app_test");
  try {
    await failsAt(ctx, what, at, () => closeOn(ctx, conn, x.a, key, body, steps(x)));
  } finally {
    await conn.end();
  }
  assert.deepEqual(await closingOf(x.a, key), before, `${label}: the agency ACTIVE, both quotes ISSUED, the reservation RESERVED with its slot held, no closure record, no journal result`);
  const done = closed(await closeCall(x.a, key, body));
  assert.deepEqual([done.agency.state, done.obligations.openQuotesWithdrawn], ["CLOSING", 2], "the same key closes once, withdrawing both quotes");
  const after = await closingOf(x.a, key);
  assert.deepEqual([after.quotes.map((q) => q[1]), after.reservations, after.heldSlots, after.closures, after.journal], [["WITHDRAWN", "WITHDRAWN"], [[x.founding, "RELEASED", "QUOTE_WITHDRAWN"]], 0, 1, "COMMITTED"]);
}

faultCell(
  {
    id: "CLOSE_PAR",
    step: "CMD043 CloseAgency / PARTIAL: W1 open quotes withdrawn and their reservations released",
    fault: "partial",
    expect: "RACE (partial): a failure injected after a quote's withdrawal and before its reservation release, and between two quotes' withdrawals, rolls back; the agency is ACTIVE, quotes ISSUED, reservations and slots held, no closure record, no journal result; the same key closes once",
  },
  async (ctx) => {
    await closureFailsAt(ctx, "close-par-release", "the closure failing after the founding quote's withdrawal and before its reservation release", "db.release.before", (x) => [WITHDRAW_1, WITHDRAW_2, releaseOf(x.founding)]);
    await closureFailsAt(ctx, "close-par-between", "the closure failing between the two quotes' withdrawals", "db.withdraw_2.before", () => [WITHDRAW_1, WITHDRAW_2]);
  },
);

faultCell(
  {
    id: "CLOSE_PAR",
    step: "CMD043 CloseAgency / PARTIAL: W2 closure record, agency CLOSING and agency.closing.v1",
    fault: "partial",
    expect: "RACE (partial): a failure injected after the quote withdrawals and before the closure record, and after the closure record and before CLOSING, rolls back the whole transaction: agency ACTIVE, quotes ISSUED, reservations held, no closure record; the same key closes once",
  },
  async (ctx) => {
    await closureFailsAt(ctx, "close-par-record", "the closure failing after the withdrawals and releases and before the closure record", "db.closure.before", () => [WITHDRAW_1, CLOSURE_INSERT]);
    await closureFailsAt(ctx, "close-par-closing", "the closure failing after the closure record and before the agency CLOSING", "db.closure.after", () => [WITHDRAW_1, CLOSURE_INSERT]);
  },
);

// --- INSPECT_FAIL ------------------------------------------------------------------------------------------------------------------

/** An agency with a second end client (each client inspected by B06's ActiveWorkInspector) and one ISSUED quote. */
async function twoClients(label: string): Promise<{ readonly a: Agent; readonly quoteId: string }> {
  const a = await agentOf(iw, label);
  await anotherClient(iw, a, `${label} second client`);
  const q = await quoted(iw, a, await planOf(iw, a, label, { units: 40_000 }));
  return { a, quoteId: q.quote.quoteId };
}
const openProjectsOf = async (agencyId: string): Promise<number> => (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.projects WHERE agency_id = $1 AND state = 'OPEN'", [agencyId]))[0]!.n;

faultCell(
  {
    id: "INSPECT_FAIL",
    step: "CMD043 CloseAgency / PARTIAL: W0 ActiveWorkInspector failing after inspecting one client",
    fault: "partial",
    expect: "RACE (partial): an inspector that fails after inspecting one client refuses the closure with no quote withdrawn and no closure committed, never a closure over a partial inventory; the same key then closes once over the whole inventory",
  },
  async (ctx) => {
    const x = await twoClients("inspect-fail-partial");
    const key = freshKey("inspect-fail-partial");
    const before = await closingOf(x.a, key);
    const body = await closureBody(x.a);
    const conn = await open("kauro_app_test");
    try {
      await failsAt(ctx, "the inventory failing at the second client's inspection", "db.inspect_2.before", () => closeOn(ctx, conn, x.a, key, body, [INSPECTION(1), INSPECTION(2)]));
    } finally {
      await conn.end();
    }
    assert.deepEqual(await closingOf(x.a, key), before, "nothing withdrawn, no closure, no journal result");
    const done = closed(await closeCall(x.a, key, body));
    assert.equal(done.agency.state, "CLOSING");
    assert.equal(done.obligations.activeWorkItems, await openProjectsOf(x.a.s.agency.agencyId), "the closure's inventory counts every client's work");
    assert.equal(done.obligations.openQuotesWithdrawn, 1);
  },
);

faultCell(
  {
    id: "INSPECT_FAIL",
    step: "CMD043 CloseAgency / TIMEOUT: W0 ActiveWorkInspector waiting on a lock another session holds",
    fault: "timeout",
    expect: "RACE (timeout): an inspector whose read waits on a lock another session holds ends, once the call bound elapses, in a retriable refusal within the bound, nothing withdrawn and no closure, and its abandoned call fails late instead of running on a pooled connection; a timed-out inventory is never read as zero",
  },
  async (ctx) => {
    const x = await twoClients("inspect-fail-timeout");
    const key = freshKey("inspect-fail-timeout");
    const before = await closingOf(x.a, key);
    const body = await closureBody(x.a);
    const deadline = ctx.deadline(ctx.clock.at(PROVIDER_CALL_TIMEOUT_MS), "the inspector call's bound");
    // the bound is below the statement timeout the unit runs under: the bound ends the wait, not the database
    assert.ok((iw.faults.statementTimeoutMs ?? raceStatementTimeoutMs()) > PROVIDER_CALL_TIMEOUT_MS, "the unit's statement timeout is above the call bound");
    // a real lock wait: another session holds the projects table, so the inspector's first read (B06's own SQL) waits on it
    const lock = await openConnection(iw.h.pg.clientConfig("kauro_owner"));
    const conn = await connect("kauro_app_test");
    const lateBefore = iw.lateFailures.length;
    let reply: Reply;
    try {
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE kauro.projects IN ACCESS EXCLUSIVE MODE");
      reply = await ctx.operation("the closure whose inspection waits on a lock another session holds", async () => {
        const waiting = await ctx.mustWait(iw.h.oracle, { waiter: conn, holder: connectionPid(lock) }, (c) => closeOn(ctx, c, x.a, key, body, [INSPECTION(1)]), "the closure's first client inspection waiting on the lock another session holds");
        assert.ok(ctx.points.passed.includes("db.inspect_1.before") && !ctx.points.passed.includes("db.inspect_1.after"), "the wait is the inspector's own first read");
        ctx.clock.past(deadline);
        return value(await waiting.pending);
      });
      assert.equal(reply.status, 503, `a retriable refusal: ${reply.text}`);
      assert.equal(outcome(iw.w, reply), "503 CAPACITY_UNAVAILABLE -");
      // the pool destroys the abandoned unit's connection (client.release(error), proved on a real pool in adapters-unit-of-work.test.ts): here the
      // harness connection is ended, so the inspector's statement still waiting on the lock fails there and is reported, never answered
      await conn.end();
      for (let i = 0; iw.lateFailures.length === lateBefore; i++) {
        assert.ok(i < 1_000, "the abandoned inspector call failed and was reported");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await lock.query("ROLLBACK");
      await lock.end();
      await conn.end().catch(() => undefined);
    }
    assert.deepEqual(iw.lateFailures.slice(lateBefore).map((l) => l.call), ["CMD043.inspectClient"], "the abandoned call's failure was logged, not swallowed");
    assert.deepEqual(await closingOf(x.a, key), before, "nothing withdrawn, no closure");
    const done = closed(await closeCall(x.a, key, body));
    assert.equal(done.obligations.activeWorkItems, await openProjectsOf(x.a.s.agency.agencyId));
  },
);

// --- QUOTE_CLOSE ---------------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "QUOTE_CLOSE",
    step: "CMD043 CloseAgency / RACE: W1 CreateQuote racing the closure of its agency",
    fault: "race",
    expect: "RACE: CreateQuote racing CloseAgency of the same agency in both orders: the quote commits first and is WITHDRAWN by the closure with its reservation released, or the closure commits first and the quote is AGENCY_NOT_ACTIVE",
  },
  async (ctx) => {
    // the quote first: held before its COMMIT (the agency's shared half held); the closure waits for the exclusive half, then withdraws it
    {
      assert.ok((await freeSlots()) >= 1, "a founding slot is free for the cell");
      const a = await agentOf(iw, "quote-close-quote-first");
      const plan = await planOf(iw, a, "quote-close-quote-first", { units: 40_000 });
      const key = freshKey("quote-close-quote-first");
      const body = await closureBody(a);
      const raced = await holdAndWait(
        ctx,
        "CloseAgency while CreateQuote holds the agency's shared half",
        { login: "kauro_app_test", run: (c) => quoteOn(ctx, c, a, plan, freshKey("quote-close-q")) },
        { login: "kauro_app_test", run: (c) => closeOn(ctx, c, a, key, body) },
        "uow.before-commit",
      );
      const q = completed<CreateQuoteView>(value(raced.held), 201).data;
      assert.equal(q.eligibility.foundingOffer, "RESERVED");
      const c = closed(value(raced.waited));
      assert.deepEqual([c.agency.state, c.obligations.openQuotesWithdrawn], ["CLOSING", 1]);
      const s = await closingOf(a, key);
      assert.deepEqual([s.quotes, s.reservations, s.heldSlots], [[[q.quote.quoteId, "WITHDRAWN"]], [[q.quote.quoteId, "RELEASED", "QUOTE_WITHDRAWN"]], 0], "the quote withdrawn by the closure, its slot released");
    }
    // the closure first: held before its COMMIT (the agency's exclusive half held); CreateQuote waits, then is AGENCY_NOT_ACTIVE with nothing written
    {
      const a = await agentOf(iw, "quote-close-closure-first");
      const plan = await planOf(iw, a, "quote-close-closure-first", { units: 40_000 });
      const key = freshKey("quote-close-closure-first");
      const body = await closureBody(a);
      const raced = await holdAndWait(
        ctx,
        "CreateQuote while CloseAgency holds the agency's exclusive half",
        { login: "kauro_app_test", run: (c) => closeOn(ctx, c, a, key, body) },
        { login: "kauro_app_test", run: (c) => quoteOn(ctx, c, a, plan, freshKey("quote-close-q2")) },
        "uow.before-commit",
      );
      assert.equal(closed(value(raced.held)).agency.state, "CLOSING");
      assert.equal(outcome(iw.w, value(raced.waited)), "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE");
      const s = await closingOf(a, key);
      assert.deepEqual([s.quotes, s.reservations, s.heldSlots], [[], [], 0], "no quote, reservation or slot written");
    }
  },
);

// the payment service's own re-binder, swapped for the cell only: B09's PurchaseRebinder without B07's lineage reader refuses LINEAGE_MISSING
const withoutLineage = createPurchaseRebinder({});
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  const bound = iw.pw.service.rebinder as { rebind: PurchaseRebinder["rebind"] };
  const original = bound.rebind;
  bound.rebind = (uow, input) => withoutLineage.rebind(uow, input);
  try {
    return await fn();
  } finally {
    bound.rebind = original;
  }
}
const JOURNAL_COMMIT: SqlStep = { label: "journal_commit", match: /UPDATE kauro\.command_journal SET state = 'COMMITTED'/ };

/** A paid project (bought through the public commands) and an approved replacement plan in the same band. */
async function replacing(label: string): Promise<{ readonly a: Agent; readonly plan: PlanFixture; readonly paidQuoteId: string }> {
  const a = await agentOf(iw, label);
  const paid = await bought(iw, a, `${label}-paid`, { units: 50_000 });
  return { a, plan: await replacementPlanOf(iw, a, paid, { units: 45_000, seed: `${label}-replacement` }), paidQuoteId: paid.purchase.quoteId };
}
const replacementsOf = async (paidQuoteId: string): Promise<string[]> => (await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.quotes WHERE replaces_quote_id = $1 ORDER BY created_at", [paidQuoteId])).map((q) => q.state);

/** A replacement whose intent committed and whose answer was lost (a crash right after the intent's COMMIT): the key's entry RESERVED, the replacement ISSUED. */
async function intentOnly(ctx: FaultContext, x: { readonly a: Agent; readonly plan: PlanFixture; readonly paidQuoteId: string }, key: string): Promise<void> {
  const conn = await open("kauro_app_test");
  try {
    ctx.points.crash("uow.after-commit");
    assert.equal(outcome(iw.w, await quoteOn(ctx, conn, x.a, x.plan, key)), "500 INTERNAL_ERROR -");
  } finally {
    await conn.end();
  }
  assert.deepEqual(await replacementsOf(x.paidQuoteId), ["ISSUED"]);
  assert.equal((await iw.w.journal(key))?.state, "RESERVED");
}

faultCell(
  {
    id: "QUOTE_CLOSE",
    step: "CMD027 included-replacement protocol / RACE: S2r refusal withdrawal racing CloseAgency",
    fault: "race",
    expect: "RACE: CloseAgency racing the withdrawal of a refused replacement in both orders: the replacement is withdrawn once (by the closure or by S2r), the key's answer is the 201 WITHDRAWN, never an ISSUED orphan replacement; a refused closure wrote nothing and closes on retry",
  },
  async (ctx) => {
    // the closure first: it holds the ISSUED replacement it withdrew; the same key's recovery, refused by the payment service, waits on that quote
    {
      const x = await replacing("quote-close-s2r-closure");
      const key = freshKey("quote-close-s2r-closure");
      await intentOnly(ctx, x, key);
      const closeKey = freshKey("quote-close-s2r-close");
      const body = await closureBody(x.a);
      // the recovery's re-binding runs in the payment service's own SERVICE unit (its pool, which the harness cannot route over a connection of
      // its own): that unit is what waits on the closure, observed here in pg_stat_activity; the harness-counted wait is the other order's
      const hc = await connect("kauro_app_test");
      const wc = await connect("kauro_app_test");
      const raced = await refusing(async () => {
        try {
          const pause = ctx.points.pause("uow.before-commit");
          const closing = ctx.operation("CloseAgency holding the ISSUED replacement it withdrew (holder)", () => closeOn(ctx, hc, x.a, closeKey, body));
          await pause.reachedBy(closing);
          const recovering = ctx.operation("the same key's recovery, refused by the payment service", () => quoteOn(ctx, wc, x.a, x.plan, key)).then(
            (v): PromiseSettledResult<Reply> => ({ status: "fulfilled", value: v }),
            (reason: unknown): PromiseSettledResult<Reply> => ({ status: "rejected", reason }),
          );
          const waiting = await blockedBy(iw.h.oracle, connectionPid(hc), "kauro-api-payment");
          assert.match(waiting.application, /^kauro-api-payment/, "the payment service's re-binding waits on the closure");
          pause.release();
          return { held: { status: "fulfilled", value: await closing } as PromiseSettledResult<Reply>, waited: await recovering };
        } finally {
          await hc.end();
          await wc.end();
        }
      });
      const c = closed(value(raced.held));
      assert.deepEqual([c.agency.state, c.obligations.openQuotesWithdrawn], ["CLOSING", 1], "the closure withdrew the ISSUED replacement");
      assert.deepEqual(await replacementsOf(x.paidQuoteId), ["WITHDRAWN"]);
      // the key's answer: the recovery's own, or (if it was refused by the race) the next recovery's
      const recovered = raced.waited.status === "fulfilled" && raced.waited.value.status === 201 ? raced.waited.value : await refusing(() => quoteCall(x.a, x.plan, key));
      const v = completed<CreateQuoteView>(recovered, 201).data;
      assert.deepEqual([v.replacement?.outcome, v.quote.state], ["WITHDRAWN", "WITHDRAWN"]);
      assert.equal((await iw.w.journal(key))?.state, "COMMITTED");
      assert.deepEqual(await replacementsOf(x.paidQuoteId), ["WITHDRAWN"], "withdrawn once, never ISSUED under a COMMITTED journal");
    }
    // the withdrawal first: S2r holds its withdrawal (the journal updated, not committed); the closure waits on the replacement's row
    {
      const x = await replacing("quote-close-s2r-withdrawal");
      const key = freshKey("quote-close-s2r-withdrawal");
      const closeKey = freshKey("quote-close-s2r-close2");
      const body = await closureBody(x.a);
      const raced = await refusing(() =>
        holdAndWait(
          ctx,
          "CloseAgency while the refused replacement's withdrawal holds it",
          { login: "kauro_app_test", run: (c) => quoteOn(ctx, c, x.a, x.plan, key, [JOURNAL_COMMIT]) },
          { login: "kauro_app_test", run: (c) => closeOn(ctx, c, x.a, closeKey, body) },
          "db.journal_commit.after",
        ),
      );
      const v = completed<CreateQuoteView>(value(raced.held), 201).data;
      assert.deepEqual([v.replacement?.outcome, v.quote.state], ["WITHDRAWN", "WITHDRAWN"]);
      assert.deepEqual(await replacementsOf(x.paidQuoteId), ["WITHDRAWN"]);
      const closure = value(raced.waited);
      if (closure.status !== 200) {
        assert.deepEqual([(await agencyOf(x.a.s.agency.agencyId)).state, (await closingOf(x.a, closeKey)).closures], ["ACTIVE", 0], `a refused closure (${outcome(iw.w, closure)}) wrote nothing`);
        assert.equal(closed(await closeCall(x.a, freshKey("quote-close-s2r-close3"), await closureBody(x.a))).agency.state, "CLOSING");
      } else {
        assert.equal(closed(closure).agency.state, "CLOSING");
      }
    }
  },
);

faultCell(
  {
    id: "QUOTE_CLOSE",
    step: "CMD027 included-replacement protocol / RACE: S3 completion racing CloseAgency",
    fault: "race",
    expect: "RACE: CloseAgency racing the completion of a re-bound replacement: the closure lists the re-bound entitlement in its inventory and never withdraws the accepted replacement, the completion answers the committed REBOUND",
  },
  async (ctx) => {
    const x = await replacing("quote-close-s3");
    const key = freshKey("quote-close-s3");
    // the completion lost (a crash before its COMMIT): the re-binding committed, the journal entry open
    const conn = await open("kauro_app_test");
    try {
      const pause = ctx.points.pause("db.journal_commit.after");
      const running = quoteOn(ctx, conn, x.a, x.plan, key, [JOURNAL_COMMIT]);
      await pause.reachedBy(running);
      ctx.points.crash("uow.before-commit");
      pause.release();
      assert.equal(outcome(iw.w, await running), "500 INTERNAL_ERROR -");
    } finally {
      await conn.end();
    }
    assert.deepEqual(await replacementsOf(x.paidQuoteId), ["ACCEPTED_FOR_CHECKOUT"]);
    const closeKey = freshKey("quote-close-s3-close");
    const body = await closureBody(x.a);
    const raced = await holdAndWait(
      ctx,
      "the replacement's completion while CloseAgency holds the agency",
      { login: "kauro_app_test", run: (c) => closeOn(ctx, c, x.a, closeKey, body) },
      { login: "kauro_app_test", run: (c) => quoteOn(ctx, c, x.a, x.plan, key) },
      "uow.before-commit",
    );
    const c = closed(value(raced.held));
    assert.deepEqual([c.agency.state, c.obligations.openQuotesWithdrawn, c.obligations.liveAuthorizations], ["CLOSING", 0, 1], "the accepted replacement is not withdrawn; its entitlement is inventoried");
    const v = completed<CreateQuoteView>(value(raced.waited), 201).data;
    assert.equal(v.replacement?.outcome, "REBOUND");
    assert.deepEqual(await replacementsOf(x.paidQuoteId), ["ACCEPTED_FOR_CHECKOUT"]);
  },
);

// --- CLOSE_INFLIGHT ----------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "CLOSE_INFLIGHT",
    step: "CMD043 CloseAgency / RACE: W0 work started on a client between its inspection and the closure's COMMIT",
    fault: "race",
    expect: "RACE: CreateProject racing CloseAgency in both orders: the project committed first is in the closure's active-work inventory, or the closure committed first and CreateProject is AGENCY_NOT_OPEN with nothing written",
  },
  async (ctx) => {
    const operatorOf = async (a: Agent, label: string): Promise<Person> => {
      const p = await iw.w.person(`${label}-operator`);
      await iw.h.addMember(a.s.agency, p.userId, "OPERATOR");
      return p;
    };
    const createProject = (a: Agent, who: Person) => (c: HarnessConnection) =>
      iw.faults.on(c, "kauro_app", ctx.points, [], () => call(iw.w, { url: routes.createProject(a.s.clientId), token: who.token, agency: a.s.agency.agencyId, key: freshKey("close-inflight-project"), body: { mode: "CLEAN", purpose: "Dedupe contacts" } }));
    // the project first: the closure waits, then counts it
    {
      const a = await agentOf(iw, "close-inflight-project-first");
      const who = await operatorOf(a, "close-inflight-project-first");
      const before = await openProjectsOf(a.s.agency.agencyId);
      const key = freshKey("close-inflight-project-first");
      const body = await closureBody(a);
      const raced = await holdAndWait(ctx, "CloseAgency while CreateProject holds the agency", { login: "kauro_app_test", run: createProject(a, who) }, { login: "kauro_app_test", run: (c) => closeOn(ctx, c, a, key, body) }, "uow.before-commit");
      assert.equal(value(raced.held).status, 201, "the project committed");
      const c = closed(value(raced.waited));
      assert.equal(c.obligations.activeWorkItems, before + 1, "the closure's inventory includes the project that committed first");
    }
    // the closure first: CreateProject waits, then is refused
    {
      const a = await agentOf(iw, "close-inflight-closure-first");
      const who = await operatorOf(a, "close-inflight-closure-first");
      const before = await openProjectsOf(a.s.agency.agencyId);
      const key = freshKey("close-inflight-closure-first");
      const body = await closureBody(a);
      const raced = await holdAndWait(ctx, "CreateProject while CloseAgency holds the agency", { login: "kauro_app_test", run: (c) => closeOn(ctx, c, a, key, body) }, { login: "kauro_app_test", run: createProject(a, who) }, "uow.before-commit");
      assert.equal(closed(value(raced.held)).obligations.activeWorkItems, before);
      assert.equal(outcome(iw.w, value(raced.waited)), "409 PRECONDITION_FAILED AGENCY_NOT_OPEN");
      assert.equal(await openProjectsOf(a.s.agency.agencyId), before, "no project written");
    }
  },
);

faultCell(
  {
    id: "CLOSE_INFLIGHT",
    step: "CMD043 CloseAgency / RACE: W3 a refund request landing between the obligations inventory and COMMIT",
    fault: "race",
    expect: "RACE: a refund request filed while CloseAgency runs, in both orders: the closure committed after it lists it in its inventory (openRefunds 1), or the closure committed first and the request is answered after it; never a closure that omits a live obligation",
  },
  async (ctx) => {
    const refundRequest = (a: Agent, projectId: string) => (c: HarnessConnection) =>
      iw.faults.on(c, "kauro_app", ctx.points, [], () => call(iw.w, { url: paymentRoutes.requestRefund(projectId), token: a.billing.token, agency: a.s.agency.agencyId, key: freshKey("close-inflight-refund"), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }));
    const openRefunds = async (agencyId: string): Promise<number> => (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.refunds WHERE agency_id = $1 AND state IN ('REQUESTED', 'APPROVED')", [agencyId]))[0]!.n;
    // the refund request first: the closure waits, then inventories it
    {
      const a = await agentOf(iw, "close-inflight-refund-first");
      const paid = await bought(iw, a, "close-inflight-refund-first", { units: 50_000 });
      const key = freshKey("close-inflight-refund-first");
      const body = await closureBody(a);
      const raced = await holdAndWait(ctx, "CloseAgency while the refund request holds the agency", { login: "kauro_app_test", run: refundRequest(a, paid.purchase.projectId) }, { login: "kauro_app_test", run: (c) => closeOn(ctx, c, a, key, body) }, "uow.before-commit");
      assert.equal(value(raced.held).status, 201, "the refund request committed");
      const c = closed(value(raced.waited));
      assert.deepEqual([c.obligations.openRefunds, c.obligations.liveAuthorizations], [1, 1], "the closure lists the refund request that committed before it");
      assert.equal(await openRefunds(a.s.agency.agencyId), 1);
    }
    // the closure first: the refund request waits, then lands after the closure (a closing agency keeps its customers' refund rights)
    {
      const a = await agentOf(iw, "close-inflight-closure-first-refund");
      const paid = await bought(iw, a, "close-inflight-closure-first-refund", { units: 50_000 });
      const key = freshKey("close-inflight-closure-first-refund");
      const body = await closureBody(a);
      const raced = await holdAndWait(ctx, "the refund request while CloseAgency holds the agency", { login: "kauro_app_test", run: (c) => closeOn(ctx, c, a, key, body) }, { login: "kauro_app_test", run: refundRequest(a, paid.purchase.projectId) }, "uow.before-commit");
      const c = closed(value(raced.held));
      assert.deepEqual([c.obligations.openRefunds, c.obligations.liveAuthorizations], [0, 1], "nothing was requested before the closure committed");
      const request = value(raced.waited);
      assert.ok(request.status === 201 || request.status === 409, `the request is answered after the closure: ${request.status} ${request.text}`);
      assert.equal(await openRefunds(a.s.agency.agencyId), request.status === 201 ? 1 : 0);
    }
  },
);

// --- CMD002: ACT_PAR, AGREEMENT_EXP ---------------------------------------------------------------------------------------------------

interface Draft {
  readonly agencyId: string;
  readonly owner: Person;
  readonly profileId: string;
}
async function draftAgency(label: string): Promise<Draft> {
  const owner = await iw.w.person(`${label}-owner`);
  const agency = await iw.h.createAgency(owner.userId, `Agency ${label}`);
  const profileId = await recordReviewedFiscalProfile(iw.h, { operatorUserId: iw.pw.kora as UserId, agencyId: agency.agencyId, issuerRef: iw.pw.issuerRef });
  return { agencyId: agency.agencyId, owner, profileId };
}
const published = async (): Promise<{ readonly terms: string; readonly privacy: string }> => {
  const r = await oracleRows<{ agreement_kind: string; version: string }>(iw, "SELECT agreement_kind, version FROM kauro.service_agreement_versions WHERE state = 'PUBLISHED'");
  return { terms: r.find((v) => v.agreement_kind === "TERMS")!.version, privacy: r.find((v) => v.agreement_kind === "PRIVACY")!.version };
};
const activationBody = async (d: Draft): Promise<Record<string, unknown>> => {
  const v = await published();
  return { expectedVersion: 1, termsVersion: v.terms, privacyAgreementVersion: v.privacy, billingProfileRef: d.profileId };
};
const activateCall = (d: Draft, key: string, body: Record<string, unknown>): Promise<Reply> => call(iw.w, { url: `/api/v1/agencies/${d.agencyId}/activate`, token: d.owner.token, agency: null, key, body });
const activateOn = (ctx: FaultContext, conn: HarnessConnection, d: Draft, key: string, body: Record<string, unknown>, steps: ReadonlyArray<SqlStep> = []): Promise<Reply> =>
  iw.faults.on(conn, "kauro_app", ctx.points, steps, () => activateCall(d, key, body));
async function activationOf(d: Draft, key: string): Promise<Record<string, unknown>> {
  const agency = (await oracleRows<{ state: string; version: string; terms_version: string | null }>(iw, "SELECT state, version::text AS version, terms_version FROM kauro.agencies WHERE agency_id = $1", [d.agencyId]))[0]!;
  const acceptances = await oracleRows<{ terms_version: string }>(iw, "SELECT terms_version FROM kauro.agency_agreement_acceptances WHERE agency_id = $1", [d.agencyId]);
  const events = await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'agency.activated.v1'", [d.agencyId]);
  return { state: agency.state, version: Number(agency.version), terms: agency.terms_version, acceptances: acceptances.map((x) => x.terms_version), activatedEvents: events[0]!.n, journal: (await iw.w.journal(key))?.state ?? null };
}

const PUBLISHED_READ: SqlStep = { label: "published", match: /FROM kauro\.service_agreement_versions WHERE agreement_kind = \$1 AND version = \$2/ };
const ACCEPTANCE_INSERT: SqlStep = { label: "acceptance", match: /INSERT INTO kauro\.agency_agreement_acceptances/ };

faultCell(
  {
    id: "ACT_PAR",
    step: "CMD002 ActivateAgency / PARTIAL: W acceptance insert then agency ACTIVE",
    fault: "partial",
    expect: "RACE (partial): a failure injected after the acceptance insert and before the agency ACTIVE leaves the agency DRAFT with no acceptance; the same key then activates once with one acceptance",
  },
  async (ctx) => {
    const d = await draftAgency("act-par");
    const key = freshKey("act-par");
    const body = await activationBody(d);
    const before = await activationOf(d, key);
    assert.deepEqual(before, { state: "DRAFT", version: 1, terms: null, acceptances: [], activatedEvents: 0, journal: null });
    const conn = await open("kauro_app_test");
    try {
      await failsAt(ctx, "the activation failing right after the acceptance insert answered", "db.acceptance.after", () => activateOn(ctx, conn, d, key, body, [PUBLISHED_READ, ACCEPTANCE_INSERT]));
    } finally {
      await conn.end();
    }
    assert.deepEqual(await activationOf(d, key), before, "the agency DRAFT, no acceptance, no agency.activated.v1, no journal result");
    completed(await activateCall(d, key, body), 200);
    assert.deepEqual(await activationOf(d, key), { state: "ACTIVE", version: 2, terms: body["termsVersion"], acceptances: [body["termsVersion"]], activatedEvents: 1, journal: "COMMITTED" });
  },
);

/** The control plane's publication of a new terms version (the published one RETIRED first, its transition lock taken), held at `retirement.before-commit`. */
async function publishNewTerms(ctx: FaultContext, c: HarnessConnection, version: string): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query("UPDATE kauro.service_agreement_versions SET state = 'RETIRED', retired_at = now() WHERE agreement_kind = 'TERMS' AND state = 'PUBLISHED'");
    await c.query("INSERT INTO kauro.service_agreement_versions (agreement_kind, version, document_hash, published_at, created_at, updated_at) VALUES ('TERMS', $1, encode(sha256(convert_to($1, 'UTF8')), 'hex'), now(), now(), now())", [version]);
    await ctx.points.pass("retirement.before-commit");
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

faultCell(
  {
    id: "AGREEMENT_EXP",
    step: "CMD002 ActivateAgency / EXPIRY: W the published terms version superseded while the activation waits",
    fault: "race",
    expect: "RACE: a new agreement version published while the command waits: the command binds the version published at its locks, or is AGREEMENT_VERSION_NOT_PUBLISHED with nothing written, in both orders",
  },
  async (ctx) => {
    // the activation first: held before its COMMIT with the versions' shared halves; the retirement waits, then commits after it
    {
      const d = await draftAgency("agreement-exp-activation");
      const key = freshKey("agreement-exp-activation");
      const body = await activationBody(d);
      const raced = await holdAndWait(
        ctx,
        "the terms retirement while the activation holds the published version's shared half",
        { login: "kauro_app_test", run: (c) => activateOn(ctx, c, d, key, body) },
        { login: "kauro_control_test", run: (c) => publishNewTerms(ctx, c, "TERMS-6A-2") },
        "uow.before-commit",
      );
      completed(value(raced.held), 200);
      value(raced.waited);
      const s = await activationOf(d, key);
      assert.deepEqual([s["state"], s["terms"], s["acceptances"]], ["ACTIVE", body["termsVersion"], [body["termsVersion"]]], "the activation binds the version published at its locks");
      assert.equal((await published()).terms, "TERMS-6A-2", "the new version is published after it");
    }
    // the retirement first: held before its COMMIT; the activation of the retiring version waits on its lock, then is refused
    {
      const d = await draftAgency("agreement-exp-retirement");
      const key = freshKey("agreement-exp-retirement");
      const body = await activationBody(d);
      assert.equal(body["termsVersion"], "TERMS-6A-2");
      const raced = await holdAndWait(
        ctx,
        "the activation while the terms version it names is being retired",
        { login: "kauro_control_test", run: (c) => publishNewTerms(ctx, c, "TERMS-6A-3") },
        { login: "kauro_app_test", run: (c) => activateOn(ctx, c, d, key, body) },
        "retirement.before-commit",
      );
      value(raced.held);
      assert.equal(outcome(iw.w, value(raced.waited)), "409 PRECONDITION_FAILED AGREEMENT_VERSION_NOT_PUBLISHED");
      assert.deepEqual(await activationOf(d, key), { state: "DRAFT", version: 1, terms: null, acceptances: [], activatedEvents: 0, journal: null }, "nothing written");
    }
  },
);
