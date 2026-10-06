// The 6a cells of the B10 failure matrix on CMD027's included-replacement protocol (docs/design/B10-failure-matrix.md "CMD027 included-replacement
// protocol"; GAP codes REPL_RACE, REPL_CRB, REPL_COMPLETE, REPL_PAR, REPL_REFUSE, REPL_POST, REPL_REVOKE, REPL_TMO and the replacement row of
// QUOTE_PAR), each a cell of the common fault harness (docs/design/FAULT-HARNESS.md). The REAL CreateQuote route runs its three steps: the tenant
// units (S1 intent, S3 completion or S2r withdrawal) over a connection the harness opened (`faults.on`), the payment service's SERVICE unit of the
// re-binding (S2) bounded by the cell's commit points and its repositories traced as `pay.<repository>.<method>` (`faults.onPayment`). Every
// purchase is bought through the public commands of the integration world (CMD027, CMD028, CMD029) and every replacement plan is a corrected,
// sealed revision approved through CMD025. A refused re-binding is the payment service's real PurchaseRebinder bound without B07's lineage
// reader (LINEAGE_MISSING), swapped in on the payment service's own re-binder for the cell only. PostgreSQL 17 through the runtime login roles;
// the superuser only reads. Nothing sleeps, except the bounded real-time wait of a timeout cell for an answer that must come.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { CreateQuoteView, PurchaseRebinder } from "@kauro/application";
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { admitJob, faultCell, queueJob, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { createPurchaseRebinder } from "../src/index.js";
import { agentOf, bought, integrationWorld, oracleRows, refundedThrough, replacementPlanOf, type Agent, type IntegrationWorld, type Paid } from "./integration-support.js";
import { bindCells, contend, open } from "./b10-cells-support.js";
import type { SqlStep } from "./fault-support.js";
import { call, completed, freshKey, ids, outcome, replayTextOf, type PlanFixture, type Reply } from "./support.js";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
  bindCells(iw);
});
after(async () => {
  await iw.stop();
});

// --- the world of a replacement ------------------------------------------------------------------------------------------------------

interface Fixture {
  readonly a: Agent;
  readonly paid: Paid & { readonly plan: PlanFixture };
  readonly plan: PlanFixture;
}

/** An agency's paid project (50,000 HubSpot units, bought through the public commands) and an approved replacement plan in the same band. */
async function fixture(label: string, units = 45_000): Promise<Fixture> {
  const a = await agentOf(iw, label);
  const paid = await bought(iw, a, `${label}-paid`, { units: 50_000 });
  const plan = await replacementPlanOf(iw, a, paid, { units, seed: `${label}-replacement` });
  return { a, paid, plan };
}

const quoteCall = (a: Agent, plan: { readonly planId: string; readonly projectId: string }, key: string): Promise<Reply> =>
  call(iw.w, { url: `/api/v1/projects/${plan.projectId}/quotes`, token: a.billing.token, agency: a.s.agency.agencyId, key, body: { planId: plan.planId, billingProfileRef: a.s.profileId } });

/** CreateQuote with its tenant units routed over `conn` (the cell's `uow.*` points and statement steps). */
const quoteOn = (ctx: FaultContext, conn: HarnessConnection, x: Fixture, key: string, steps: ReadonlyArray<SqlStep> = [], plan: PlanFixture = x.plan): Promise<Reply> =>
  iw.faults.on(conn, "kauro_app", ctx.points, steps, () => quoteCall(x.a, plan, key));

interface ReplacementState {
  /** Each re-binding of the paid capture: the quote it re-bound from, to, and its allowance ordinal. */
  readonly rebindings: ReadonlyArray<readonly [string, string, number]>;
  /** Each entitlement of the paid capture, oldest first: its quote, state and revocation code. */
  readonly authorizations: ReadonlyArray<readonly [string, string, string | null]>;
  readonly paidQuote: string;
  /** The states of the replacement quotes of the paid quote, oldest first. */
  readonly replacements: ReadonlyArray<string>;
  /** The journal entry of the request's key (null: none). */
  readonly journal: string | null;
}

async function stateOf(x: Fixture, key: string): Promise<ReplacementState> {
  const p = x.paid.purchase;
  const rebindings = await oracleRows<{ from_quote_id: string; to_quote_id: string; allowance_ordinal: number }>(iw, "SELECT from_quote_id, to_quote_id, allowance_ordinal FROM kauro.purchase_rebindings WHERE capture_id = $1 ORDER BY created_at", [p.captureId]);
  const authorizations = await oracleRows<{ quote_id: string; state: string; revocation_code: string | null }>(iw, "SELECT quote_id, state, revocation_code FROM kauro.commercial_authorizations WHERE capture_id = $1 ORDER BY created_at", [p.captureId]);
  const paidQuote = (await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.quotes WHERE quote_id = $1", [p.quoteId]))[0]!.state;
  const replacements = await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.quotes WHERE replaces_quote_id = $1 ORDER BY created_at", [p.quoteId]);
  return {
    rebindings: rebindings.map((r) => [r.from_quote_id, r.to_quote_id, r.allowance_ordinal] as const),
    authorizations: authorizations.map((a) => [a.quote_id, a.state, a.revocation_code] as const),
    paidQuote,
    replacements: replacements.map((r) => r.state),
    journal: (await iw.w.journal(key))?.state ?? null,
  };
}

/** The paid purchase untouched: no re-binding, its entitlement ACTIVE, its quote ACCEPTED_FOR_CHECKOUT. */
function untouched(x: Fixture, s: ReplacementState): void {
  assert.deepEqual(s.rebindings, [], "no re-binding: the allowance is unspent");
  assert.deepEqual(s.authorizations, [[x.paid.purchase.quoteId, "ACTIVE", null]], "the paid entitlement is ACTIVE and the only one");
  assert.equal(s.paidQuote, "ACCEPTED_FOR_CHECKOUT", "the paid quote still stands");
}

/** The one re-binding the protocol makes: ordinal 1, the old entitlement REVOKED SOURCE_REPLACED, the new one ACTIVE on the replacement. */
function reboundOnce(x: Fixture, s: ReplacementState, replacementQuoteId: string, newState = "ACTIVE"): void {
  assert.deepEqual(s.rebindings, [[x.paid.purchase.quoteId, replacementQuoteId, 1]], "exactly one re-binding with allowance ordinal 1");
  assert.deepEqual(s.authorizations, [
    [x.paid.purchase.quoteId, "REVOKED", "SOURCE_REPLACED"],
    [replacementQuoteId, newState, null],
  ], "the old entitlement REVOKED SOURCE_REPLACED (never revived), the re-bound one on the replacement");
  assert.equal(s.paidQuote, "SUPERSEDED");
}

const replacementOf = async (x: Fixture): Promise<string> => (await oracleRows<{ quote_id: string }>(iw, "SELECT quote_id FROM kauro.quotes WHERE replaces_quote_id = $1 ORDER BY created_at DESC LIMIT 1", [x.paid.purchase.quoteId]))[0]!.quote_id;
const withdrawnEvents = async (quoteId: string): Promise<number> => (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'quote.withdrawn.v1'", [quoteId]))[0]!.n;

/** The view of a replacement answered 201. */
const view = (reply: Reply): CreateQuoteView => completed<CreateQuoteView>(reply, 201).data;

/** Runs `run` as the operation that must fail at `at` after an earlier step of it completed; a 500 is the failure the api hid. */
async function failsAt(ctx: FaultContext, what: string, at: string, run: () => Promise<Reply>): Promise<void> {
  await ctx.partial(what, at, async () => {
    const seen = iw.w.internalErrors.length;
    const reply = await run();
    if (reply.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(`the request failed: ${reply.status} ${reply.text}`);
    return reply;
  });
}

// the payment service's own re-binder, swapped for the cell only: B09's PurchaseRebinder without B07's lineage reader refuses LINEAGE_MISSING
const rebinderOfService = (): { rebind: PurchaseRebinder["rebind"] } => iw.pw.service.rebinder as { rebind: PurchaseRebinder["rebind"] };
const withoutLineage = createPurchaseRebinder({});
async function withRebinder<T>(rebind: PurchaseRebinder["rebind"], fn: () => Promise<T>): Promise<T> {
  const bound = rebinderOfService();
  const original = bound.rebind;
  bound.rebind = rebind;
  try {
    return await fn();
  } finally {
    bound.rebind = original;
  }
}
const refusing = <T>(fn: () => Promise<T>): Promise<T> => withRebinder((uow, input) => withoutLineage.rebind(uow, input), fn);

const JOURNAL_COMMIT: SqlStep = { label: "journal_commit", match: /UPDATE kauro\.command_journal SET state = 'COMMITTED'/ };
const QUOTE_INSERT: SqlStep = { label: "quote_insert", match: /INSERT INTO kauro\.quotes \(/ };
const ISSUANCE: SqlStep = { label: "issuance", match: /INSERT INTO kauro\.quote_issuances/ };
const WITHDRAWAL: SqlStep = { label: "withdrawal", match: /UPDATE kauro\.quotes AS q SET/, when: (p) => p[2] === "WITHDRAWN" };
const WITHDRAWN_EVENT: SqlStep = { label: "withdrawn_event", match: /INSERT INTO kauro\.domain_events/, when: (p) => p.includes("quote.withdrawn.v1") };

// --- REPL_RACE ---------------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "REPL_RACE",
    step: "CMD027 included-replacement protocol / RACE: S1 intent, two keys contending for the one paid allowance",
    fault: "race",
    expect:
      "RACE (replacement): hold one replacement before its settlement and start another key on the same paid purchase, in both orders: exactly one re-binding and one allowance ordinal, the other refused with nothing written and, retried, REPLACEMENT_ALLOWANCE_SPENT",
  },
  async (ctx) => {
    // one corrected revision is current at a time, so both keys replace with the one approved plan; each order is its own paid purchase
    for (const order of ["key A holds", "key B holds"] as const) {
      const x = await fixture(`repl-race-${order === "key A holds" ? "a" : "b"}`);
      const keyA = freshKey("repl-race-a");
      const keyB = freshKey("repl-race-b");
      const [holderKey, waiterKey] = order === "key A holds" ? [keyA, keyB] : [keyB, keyA];
      const waiterPlan = x.plan;
      const raced = await contend(
        ctx,
        // the holder stops before its intent's COMMIT: its replacement ISSUED and the paid quote's row locked
        { name: `the replacement of ${order}`, login: "kauro_app_test", holdAt: "uow.before-commit", run: (conn) => quoteOn(ctx, conn, x, holderKey) },
        { name: "the other key's replacement", login: "kauro_app_test", holdAt: "-", run: (conn) => quoteOn(ctx, conn, x, waiterKey) },
        `two replacement intents on one paid purchase (${order})`,
      );
      assert.equal(raced.holder.status, "fulfilled");
      const held = view(raced.holder.status === "fulfilled" ? (raced.holder.value as Reply) : (undefined as never));
      assert.equal(held.replacement?.outcome, "REBOUND", "the holder re-binds the purchase");
      assert.equal(raced.waiter.status, "fulfilled");
      const waited = raced.waiter.status === "fulfilled" ? (raced.waiter.value as Reply) : (undefined as never);
      assert.ok(
        ["409 PRECONDITION_FAILED OPERATION_PENDING", "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT"].includes(outcome(iw.w, waited)),
        `the waiter is refused, never a second replacement: ${outcome(iw.w, waited)}`,
      );
      const s = await stateOf(x, waiterKey);
      reboundOnce(x, s, held.quote.quoteId);
      assert.deepEqual(s.replacements, ["ACCEPTED_FOR_CHECKOUT"], "one replacement quote: the waiter wrote none");
      assert.equal(s.journal, null, "the refused key journaled nothing");
      // the same key again, the race over: the allowance is spent and nothing is written
      assert.equal(outcome(iw.w, await quoteCall(x.a, waiterPlan, waiterKey)), "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT");
      reboundOnce(x, await stateOf(x, waiterKey), held.quote.quoteId);
    }
  },
);

faultCell(
  {
    id: "REPL_RACE",
    step: "CMD027 included-replacement protocol / RACE: S2 settle, the same key's recovery against the first request",
    fault: "race",
    expect:
      "RACE (replacement): the same key recovered concurrently, held before the first intent commits and while the first completes, makes exactly one re-binding and one allowance ordinal and answers REBOUND",
  },
  async (ctx) => {
    // 1. the first request held before its intent COMMIT (its journal entry inserted): the recovery waits on that entry, then both settle
    {
      const x = await fixture("repl-race-recover-intent");
      const key = freshKey("repl-race-recover-intent");
      const raced = await contend(
        ctx,
        { name: "the first request", login: "kauro_app_test", holdAt: "uow.before-commit", run: (conn) => quoteOn(ctx, conn, x, key) },
        { name: "the same key's recovery", login: "kauro_app_test", holdAt: "-", run: (conn) => quoteOn(ctx, conn, x, key) },
        "the same key recovered while the first intent is open",
      );
      const answers = [raced.holder, raced.waiter].map((r) => (r.status === "fulfilled" ? (r.value as Reply) : null));
      const s = await stateOf(x, key);
      const replacement = await replacementOf(x);
      reboundOnce(x, s, replacement);
      assert.deepEqual(s.replacements, ["ACCEPTED_FOR_CHECKOUT"], "one replacement quote");
      // every answer that is not a refusal is the REBOUND replacement; the key converges to it
      for (const a of answers) if (a !== null && a.status === 201) assert.equal(view(a).replacement?.outcome, "REBOUND");
      const final = view(await quoteCall(x.a, x.plan, key));
      assert.deepEqual([final.replacement?.outcome, final.quote.quoteId], ["REBOUND", replacement]);
      reboundOnce(x, await stateOf(x, key), replacement);
      assert.equal((await stateOf(x, key)).journal, "COMMITTED");
    }
    // 2. the first request held in its completion, its journal entry updated and not committed: the recovery waits on it and replays its answer
    {
      const x = await fixture("repl-race-recover-complete");
      const key = freshKey("repl-race-recover-complete");
      const raced = await contend(
        ctx,
        { name: "the first request's completion", login: "kauro_app_test", holdAt: "db.journal_commit.after", run: (conn) => quoteOn(ctx, conn, x, key, [JOURNAL_COMMIT]) },
        { name: "the same key's recovery", login: "kauro_app_test", holdAt: "-", run: (conn) => quoteOn(ctx, conn, x, key) },
        "the same key recovered while the first completes",
      );
      assert.ok(raced.holder.status === "fulfilled" && raced.waiter.status === "fulfilled");
      const first = raced.holder.value as Reply;
      const second = raced.waiter.value as Reply;
      assert.equal(view(first).replacement?.outcome, "REBOUND");
      assert.equal(second.text, replayTextOf(first), "the recovery replays the committed answer byte for byte");
      reboundOnce(x, await stateOf(x, key), view(first).quote.quoteId);
    }
  },
);

// --- REPL_CRB, REPL_COMPLETE ---------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "REPL_CRB",
    step: "CMD027 included-replacement protocol / CRASH-BEFORE: S2 settle, after the rebinder's last write and before the SERVICE COMMIT",
    fault: "crash-before-commit",
    at: "uow",
    expect:
      "RACE (crash before COMMIT): a crash injected inside the SERVICE transaction after the old-authorization revocation, the replacement acceptance and the allowance record leaves no re-binding and the old entitlement ACTIVE; the same key then re-binds once",
  },
  async (ctx) => {
    const x = await fixture("repl-crb");
    const key = freshKey("repl-crb");
    untouched(x, await stateOf(x, key));
    // only the payment service's units are bounded by the cell's points here: the first to reach its COMMIT is the re-binding's SERVICE unit
    ctx.points.crash("uow.before-commit");
    const crashed = await ctx.operation("the replacement whose re-binding dies before its SERVICE COMMIT", () => iw.faults.onPayment(ctx.points, () => quoteCall(x.a, x.plan, key)));
    assert.equal(outcome(iw.w, crashed), "500 INTERNAL_ERROR -");
    // the rebinder had done every write of the re-binding inside that unit before the crash
    const passed = ctx.points.passed;
    for (const write of ["pay.rebindings.record.after", "pay.authorizations.transition.after", "pay.quotes.transition.after", "pay.authorizations.issue.after"]) assert.ok(passed.includes(write), `the re-binding wrote ${write} before the crash`);
    const s = await stateOf(x, key);
    untouched(x, s);
    assert.deepEqual(s.replacements, ["ISSUED"], "the intent's replacement stays ISSUED, not accepted");
    assert.equal(s.journal, "RESERVED", "the intent's journal entry stays open");
    const resumed = view(await quoteCall(x.a, x.plan, key));
    assert.equal(resumed.replacement?.outcome, "REBOUND");
    assert.equal(resumed.replacement?.revokedAuthorizationId, x.paid.purchase.authorizationId);
    const after = await stateOf(x, key);
    reboundOnce(x, after, resumed.quote.quoteId);
    assert.equal(after.journal, "COMMITTED");
  },
);

faultCell(
  {
    id: "REPL_COMPLETE",
    step: "CMD027 included-replacement protocol / CRASH-BEFORE: S3 completion, after the journal update and before its COMMIT",
    fault: "crash-before-commit",
    at: "uow",
    expect:
      "RACE (crash before COMMIT): a crash injected after the journal update and before the completion COMMIT resumes to the committed re-binding and its new authorization, without reviving the old authorization or resetting the allowance",
  },
  async (ctx) => {
    const x = await fixture("repl-complete");
    const key = freshKey("repl-complete");
    const conn = await open("kauro_app_test");
    try {
      // the completion stops right after its journal UPDATE; the crash is armed for its COMMIT boundary (the intent unit passed its own unarmed)
      const pause = ctx.points.pause("db.journal_commit.after");
      const running = ctx.operation("the replacement whose completion dies before its COMMIT", () => quoteOn(ctx, conn, x, key, [JOURNAL_COMMIT]));
      await pause.reachedBy(running);
      ctx.points.crash("uow.before-commit");
      pause.release();
      assert.equal(outcome(iw.w, await running), "500 INTERNAL_ERROR -");
    } finally {
      await conn.end();
    }
    const s = await stateOf(x, key);
    const replacement = await replacementOf(x);
    reboundOnce(x, s, replacement);
    assert.deepEqual(s.replacements, ["ACCEPTED_FOR_CHECKOUT"]);
    assert.equal(s.journal, "RESERVED", "the completion rolled back: the journal entry is open");
    const resumed = view(await quoteCall(x.a, x.plan, key));
    assert.deepEqual([resumed.replacement?.outcome, resumed.quote.quoteId, resumed.replacement?.revokedAuthorizationId], ["REBOUND", replacement, x.paid.purchase.authorizationId]);
    const after = await stateOf(x, key);
    reboundOnce(x, after, replacement);
    assert.equal(after.journal, "COMMITTED");
  },
);

// --- REPL_PAR ----------------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "REPL_PAR",
    step: "CMD027 included-replacement protocol / PARTIAL: S2 settle, a failure between the rebinder's writes",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the old authorization's revocation, after the replacement's acceptance and after the allowance record rolls the re-binding back atomically; the allowance stays unspent and the same key re-binds once",
  },
  async (ctx) => {
    const members = [
      { label: "repl-par-record", at: "pay.rebindings.record.after", what: "the re-binding failing right after the allowance ordinal is recorded" },
      { label: "repl-par-revoke", at: "pay.authorizations.transition.after", what: "the re-binding failing right after the old entitlement is revoked" },
      { label: "repl-par-accept", at: "pay.authorizations.issue.before", what: "the re-binding failing after the replacement is accepted and before its entitlement is issued" },
    ];
    for (const m of members) {
      const x = await fixture(m.label);
      const key = freshKey(m.label);
      await failsAt(ctx, m.what, m.at, () => iw.faults.onPayment(ctx.points, () => quoteCall(x.a, x.plan, key)));
      const s = await stateOf(x, key);
      untouched(x, s);
      assert.deepEqual(s.replacements, ["ISSUED"], `${m.label}: the replacement is not accepted`);
      assert.equal(s.journal, "RESERVED");
      const resumed = view(await quoteCall(x.a, x.plan, key));
      assert.equal(resumed.replacement?.outcome, "REBOUND");
      reboundOnce(x, await stateOf(x, key), resumed.quote.quoteId);
    }
  },
);

// --- QUOTE_PAR (replacement intent) ---------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "QUOTE_PAR",
    step: "CMD027 included-replacement protocol / PARTIAL: S1 intent, a failure between the replacement insert, quote_issuances and the journal entry",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the replacement insert and before quote_issuances, and after quote_issuances before the intent COMMIT, rolls the replacement, its issuance and the journal entry back; the same key then replaces once",
  },
  async (ctx) => {
    const members = [
      { label: "quote-par-repl-insert", at: "db.issuance.before", what: "the intent failing after the replacement insert and before quote_issuances" },
      { label: "quote-par-repl-issuance", at: "uow.before-commit", what: "the intent failing after quote_issuances and before its COMMIT" },
    ];
    for (const m of members) {
      const x = await fixture(m.label);
      const key = freshKey(m.label);
      const conn = await open("kauro_app_test");
      try {
        await failsAt(ctx, m.what, m.at, () => quoteOn(ctx, conn, x, key, [QUOTE_INSERT, ISSUANCE]));
      } finally {
        await conn.end();
      }
      const s = await stateOf(x, key);
      untouched(x, s);
      assert.deepEqual(s.replacements, [], `${m.label}: no replacement quote`);
      assert.equal(s.journal, null, "no journal entry");
      assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS n FROM kauro.quote_issuances WHERE replaced_quote_id = $1", [x.paid.purchase.quoteId]), [{ n: 0 }], "no issuance");
      const done = view(await quoteCall(x.a, x.plan, key));
      assert.equal(done.replacement?.outcome, "REBOUND");
      reboundOnce(x, await stateOf(x, key), done.quote.quoteId);
    }
  },
);

// --- REPL_REFUSE ---------------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "REPL_REFUSE",
    step: "CMD027 included-replacement protocol / CRASH-BEFORE: S2r withdrawal, after the refusal and before its COMMIT",
    fault: "crash-before-commit",
    at: "uow",
    expect:
      "RACE (replacement refusal): stopped after the refusal and before the withdrawal commits, the same key resumes from the journal entry, re-asks the rebinder by identity and repeats the refusal and withdraws (WITHDRAWN 201) without re-binding and without an orphan ISSUED replacement",
  },
  async (ctx) => {
    const x = await fixture("repl-refuse-crash");
    const key = freshKey("repl-refuse-crash");
    const conn = await open("kauro_app_test");
    try {
      await refusing(async () => {
        const pause = ctx.points.pause("db.journal_commit.after");
        const running = ctx.operation("the refused replacement whose withdrawal dies before its COMMIT", () => quoteOn(ctx, conn, x, key, [JOURNAL_COMMIT]));
        await pause.reachedBy(running);
        ctx.points.crash("uow.before-commit");
        pause.release();
        assert.equal(outcome(iw.w, await running), "500 INTERNAL_ERROR -");
      });
    } finally {
      await conn.end();
    }
    const s = await stateOf(x, key);
    untouched(x, s);
    assert.deepEqual(s.replacements, ["ISSUED"], "the withdrawal rolled back: the replacement is ISSUED under an open journal entry");
    assert.equal(s.journal, "RESERVED");
    const replacement = await replacementOf(x);
    assert.equal(await withdrawnEvents(replacement), 0, "no quote.withdrawn.v1");
    const resumed = view(await refusing(() => quoteCall(x.a, x.plan, key)));
    assert.deepEqual([resumed.replacement?.outcome, resumed.replacement?.reason, resumed.quote.state, resumed.quote.quoteId], ["WITHDRAWN", "LINEAGE_MISSING", "WITHDRAWN", replacement]);
    const after = await stateOf(x, key);
    untouched(x, after);
    assert.deepEqual([after.replacements, after.journal], [["WITHDRAWN"], "COMMITTED"], "never an ISSUED replacement under a COMMITTED journal");
    assert.equal(await withdrawnEvents(replacement), 1);
  },
);

faultCell(
  {
    id: "REPL_REFUSE",
    step: "CMD027 included-replacement protocol / RETRY: S2r withdrawal answered, then retried",
    fault: "retry",
    expect:
      "RACE (replacement refusal): a retry after the withdrawal replays the 201 WITHDRAWN byte for byte and does not re-bind even once the re-binding could succeed; the same key with another planId is 409 IDEMPOTENCY_CONFLICT",
  },
  async (ctx) => {
    const x = await fixture("repl-refuse-retry");
    const key = freshKey("repl-refuse-retry");
    const first = await ctx.attempt(() => refusing(() => quoteCall(x.a, x.plan, key)));
    const answered = view(first);
    assert.deepEqual([answered.replacement?.outcome, answered.replacement?.reason, answered.quote.state], ["WITHDRAWN", "LINEAGE_MISSING", "WITHDRAWN"]);
    const before = await stateOf(x, key);
    untouched(x, before);
    assert.deepEqual([before.replacements, before.journal], [["WITHDRAWN"], "COMMITTED"]);
    // the identical retry, the payment service now able to re-bind: the journaled 201 WITHDRAWN, nothing re-bound
    const replay = await ctx.attempt(() => quoteCall(x.a, x.plan, key));
    assert.equal(replay.status, 201);
    assert.equal(replay.text, replayTextOf(first), "the replay answers the journaled 201 WITHDRAWN byte for byte");
    assert.deepEqual(await stateOf(x, key), before, "the replay wrote nothing and did not re-bind");
    // the same key with another body (another billing profile reference) is another request
    const conflict = await ctx.attempt(() =>
      call(iw.w, { url: `/api/v1/projects/${x.plan.projectId}/quotes`, token: x.a.billing.token, agency: x.a.s.agency.agencyId, key, body: { planId: x.plan.planId, billingProfileRef: ids.next() } }),
    );
    assert.equal(outcome(iw.w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
    assert.deepEqual(await stateOf(x, key), before, "the conflict wrote nothing");
  },
);

faultCell(
  {
    id: "REPL_REFUSE",
    step: "CMD027 included-replacement protocol / PARTIAL: S2r withdrawal, a failure between the withdrawal, quote.withdrawn and the journal completion",
    fault: "partial",
    expect:
      "RACE (replacement refusal): a failure after the withdrawal and before quote.withdrawn.v1, and after quote.withdrawn.v1 and before the journal completion, rolls the withdrawal back (the replacement ISSUED, the entry RESERVED); the same key recovers the refusal once (WITHDRAWN 201, one quote.withdrawn.v1) without re-binding",
  },
  async (ctx) => {
    const members = [
      { label: "repl-refuse-par-event", at: "db.withdrawn_event.before", what: "the withdrawal failing before quote.withdrawn.v1 is published" },
      { label: "repl-refuse-par-journal", at: "db.journal_commit.before", what: "the withdrawal failing after quote.withdrawn.v1 and before the journal completion" },
    ];
    for (const m of members) {
      const x = await fixture(m.label);
      const key = freshKey(m.label);
      const conn = await open("kauro_app_test");
      try {
        await refusing(() => failsAt(ctx, m.what, m.at, () => quoteOn(ctx, conn, x, key, [WITHDRAWAL, WITHDRAWN_EVENT, JOURNAL_COMMIT])));
      } finally {
        await conn.end();
      }
      const replacement = await replacementOf(x);
      const s = await stateOf(x, key);
      untouched(x, s);
      assert.deepEqual([s.replacements, s.journal], [["ISSUED"], "RESERVED"], `${m.label}: the withdrawal rolled back with the journal completion`);
      assert.equal(await withdrawnEvents(replacement), 0);
      const resumed = view(await refusing(() => quoteCall(x.a, x.plan, key)));
      assert.deepEqual([resumed.replacement?.outcome, resumed.quote.state], ["WITHDRAWN", "WITHDRAWN"]);
      const after = await stateOf(x, key);
      untouched(x, after);
      assert.deepEqual([after.replacements, after.journal], [["WITHDRAWN"], "COMMITTED"]);
      assert.equal(await withdrawnEvents(replacement), 1, "one quote.withdrawn.v1");
    }
  },
);

// --- REPL_REVOKE, REPL_POST ----------------------------------------------------------------------------------------------------------

/** Execution admitted on an entitlement: the job queued (CMD036's write) and admitted (JOB_ADMISSION): the entitlement CONSUMED. */
async function executionStarted(x: Fixture, authorizationId: string): Promise<void> {
  const job = await queueJob(iw.h, x.a.s.agency, authorizationId);
  await admitJob(iw.h, x.a.s.agency, job.jobId);
}
const authorizationState = async (authorizationId: string): Promise<string> => (await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [authorizationId]))[0]!.state;

/** A replacement held between its intent COMMIT and its re-binding (the first tenant unit's after-commit), `revoke` run there, then let go. */
async function revokedBetween(ctx: FaultContext, x: Fixture, key: string, what: string, revoke: () => Promise<void>): Promise<Reply> {
  const conn = await open("kauro_app_test");
  try {
    const pause = ctx.points.pause("uow.after-commit");
    const running = ctx.operation(`the replacement held after its intent (${what})`, () => quoteOn(ctx, conn, x, key));
    await pause.reachedBy(running);
    const held = await stateOf(x, key);
    assert.deepEqual([held.replacements, held.journal], [["ISSUED"], "RESERVED"], "the intent committed, not yet re-bound");
    await ctx.revoked(what, revoke);
    pause.release();
    let reply: Reply | undefined;
    await ctx.fenced(
      `the re-binding after ${what}`,
      async () => {
        reply = await running;
        const v = view(reply);
        if (v.replacement?.outcome === "WITHDRAWN") throw Object.assign(new Error(`withdrawn ${v.replacement.reason ?? ""}`), { reason: v.replacement.reason });
        return v;
      },
      (e) => ["EXECUTION_STARTED", "PURCHASE_NOT_INTACT"].includes((e as { reason?: string }).reason ?? ""),
    );
    return reply!;
  } finally {
    await conn.end();
  }
}

faultCell(
  {
    id: "REPL_REVOKE",
    step: "CMD027 included-replacement protocol / REVOCATION: execution starting between S1 and S2",
    fault: "revocation",
    expect:
      "RACE (replacement): execution starting between the replacement's intent and its re-binding withdraws the replacement with EXECUTION_STARTED, the old entitlement stays CONSUMED, the allowance is not spent",
  },
  async (ctx) => {
    const x = await fixture("repl-revoke-exec");
    const key = freshKey("repl-revoke-exec");
    const reply = await revokedBetween(ctx, x, key, "the paid entitlement consumed by the execution's admission", () => executionStarted(x, x.paid.purchase.authorizationId));
    const v = view(reply);
    assert.deepEqual([v.replacement?.outcome, v.replacement?.reason, v.quote.state], ["WITHDRAWN", "EXECUTION_STARTED", "WITHDRAWN"]);
    const s = await stateOf(x, key);
    assert.deepEqual(s.rebindings, [], "the allowance is not spent");
    assert.deepEqual(s.authorizations, [[x.paid.purchase.quoteId, "CONSUMED", null]], "the old entitlement stays CONSUMED as the admission committed it (never ACTIVE, never revoked)");
    assert.deepEqual([s.paidQuote, s.replacements, s.journal], ["ACCEPTED_FOR_CHECKOUT", ["WITHDRAWN"], "COMMITTED"]);
  },
);

faultCell(
  {
    id: "REPL_REVOKE",
    step: "CMD027 included-replacement protocol / REVOCATION: a full service refund completed between S1 and S2",
    fault: "revocation",
    expect:
      "RACE (replacement): a full service refund completed between the intent and the re-binding withdraws the replacement, the old entitlement stays as the refund left it (REVOKED, never reverted to ACTIVE), the allowance is not spent",
  },
  async (ctx) => {
    const x = await fixture("repl-revoke-refund");
    const key = freshKey("repl-revoke-refund");
    let refunded: string | null = null;
    const reply = await revokedBetween(ctx, x, key, "the paid order's full service refund", async () => {
      await refundedThrough(iw, x.a, x.paid.purchase, BigInt(x.paid.quote.quote.serviceCents));
      refunded = await authorizationState(x.paid.purchase.authorizationId);
    });
    const v = view(reply);
    assert.equal(v.replacement?.outcome, "WITHDRAWN");
    assert.equal(refunded, "REVOKED", "the full service refund revoked the paid entitlement");
    const s = await stateOf(x, key);
    assert.deepEqual(s.rebindings, [], "the allowance is not spent");
    assert.equal(s.authorizations.length, 1, "no entitlement issued");
    assert.equal(s.authorizations[0]![1], "REVOKED", "the refunded entitlement stays REVOKED (never reverted to ACTIVE)");
    assert.notEqual(s.authorizations[0]![2], "SOURCE_REPLACED", "revoked by the refund, not by a re-binding");
    assert.deepEqual([s.replacements, s.journal], [["WITHDRAWN"], "COMMITTED"]);
  },
);

faultCell(
  {
    id: "REPL_POST",
    step: "CMD027 included-replacement protocol / REVOCATION: execution reaching the new authorization after the durable re-binding and before S3",
    fault: "revocation",
    expect:
      "RACE (replacement): after the re-binding committed, execution consuming the re-bound entitlement before the journal completes: recovery completes the journal with the committed re-binding, the old entitlement stays REVOKED SOURCE_REPLACED and the allowance spent; a further replacement is refused",
  },
  async (ctx) => {
    const x = await fixture("repl-post");
    const key = freshKey("repl-post");
    // only the payment service's units are bounded here: the first after-commit is the re-binding's SERVICE unit (the purchase re-bound)
    const pause = ctx.points.pause("uow.after-commit");
    const running = ctx.operation("the replacement held after its re-binding committed", () => iw.faults.onPayment(ctx.points, () => quoteCall(x.a, x.plan, key)));
    await pause.reachedBy(running);
    const replacement = await replacementOf(x);
    const held = await stateOf(x, key);
    reboundOnce(x, held, replacement);
    assert.equal(held.journal, "RESERVED", "the journal entry is open");
    const newAuthorization = (await oracleRows<{ authorization_id: string }>(iw, "SELECT authorization_id FROM kauro.commercial_authorizations WHERE quote_id = $1", [replacement]))[0]!.authorization_id;
    await ctx.revoked("the re-bound entitlement consumed by the execution's admission", () => executionStarted(x, newAuthorization));
    pause.release();
    const v = view(await running);
    assert.deepEqual([v.replacement?.outcome, v.quote.quoteId, v.replacement?.revokedAuthorizationId], ["REBOUND", replacement, x.paid.purchase.authorizationId], "the journal completes with the committed re-binding");
    const s = await stateOf(x, key);
    reboundOnce(x, s, replacement, "CONSUMED");
    assert.equal(s.journal, "COMMITTED");
    // the old authorization is never revived and the allowance never reset: a further replacement of the purchase is refused, writing nothing
    const further = await replacementPlanOf(iw, x.a, { purchase: x.paid.purchase, plan: x.plan }, { units: 46_000, seed: "repl-post-further" });
    await ctx.fenced(
      "a further replacement of the consumed purchase",
      async () => {
        const r = await quoteCall(x.a, further, freshKey("repl-post-further"));
        if (r.status !== 201) throw Object.assign(new Error(outcome(iw.w, r)), { outcome: outcome(iw.w, r) });
        return r;
      },
      (e) => ["409 PRECONDITION_FAILED EXECUTION_STARTED", "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT"].includes((e as { outcome?: string }).outcome ?? ""),
    );
    assert.deepEqual(await stateOf(x, key), s, "nothing written by the refused replacement");
  },
);

// --- REPL_TMO ----------------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "REPL_TMO",
    step: "CMD027 included-replacement protocol / TIMEOUT: S2 PurchaseRebinder never answering",
    fault: "timeout",
    expect:
      "RACE (replacement): a re-binding that times out leaves the replacement ISSUED with its journal entry open, the same key observes the re-binding by its identity and never re-binds twice, and the answer is the retriable 202",
  },
  async (ctx) => {
    const x = await fixture("repl-tmo");
    const key = freshKey("repl-tmo");
    // the re-binder never answers; the cell crosses the provider-call bound on its clock and then gives the application time to answer
    const deadline = ctx.deadline(ctx.clock.at(PROVIDER_CALL_TIMEOUT_MS), "the re-binding's call bound");
    let called!: () => void;
    const reached = new Promise<void>((resolve) => (called = resolve));
    let abandon!: (e: Error) => void;
    const hung = new Promise<never>((_resolve, reject) => (abandon = reject));
    hung.catch(() => undefined);
    let reply: Reply | undefined;
    try {
      await withRebinder(
        () => {
          called();
          return hung;
        },
        async () => {
          const running = ctx.operation("the replacement whose re-binding never answers", () => quoteCall(x.a, x.plan, key));
          await reached;
          ctx.clock.past(deadline);
          const settled = await Promise.race([running.then((r) => r), new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))]);
          if (settled === null) {
            // no bound fired: let the hung call fail so the SERVICE transaction rolls back, then report the gap
            abandon(new Error("the test abandoned the re-binder that never answered"));
            await running.catch(() => undefined);
            assert.fail(`CreateQuote did not answer within 5 s after the re-binding's ${PROVIDER_CALL_TIMEOUT_MS} ms bound was crossed: PurchaseRebinder has no bound (expected the retriable 202 with the replacement ISSUED and the journal entry open)`);
          }
          reply = settled;
        },
      );
    } finally {
      abandon(new Error("cleanup"));
    }
    assert.equal(reply!.status, 202, `the retriable answer: ${reply!.text}`);
    const s = await stateOf(x, key);
    untouched(x, s);
    assert.deepEqual([s.replacements, s.journal], [["ISSUED"], "RESERVED"]);
    const resumed = view(await quoteCall(x.a, x.plan, key));
    assert.equal(resumed.replacement?.outcome, "REBOUND");
    reboundOnce(x, await stateOf(x, key), resumed.quote.quoteId);
  },
);
