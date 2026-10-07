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
import { after, before, test } from "node:test";
import type { CreateQuoteView, PurchaseRebinder } from "@kauro/application";
import { PROVIDER_CALL_TIMEOUT_MS, StaleVersionFailure } from "@kauro/domain";
import { admitJob, faultCell, queueJob, simulatedCrashOf, type FaultContext, type HarnessConnection, invariantsAfterEach } from "@kauro/persistence/testing";
import { createPurchaseRebinder } from "../src/index.js";
import { agentOf, bought, integrationWorld, oracleRows, refundedThrough, replacementPlanOf, type Agent, type IntegrationWorld, type Paid } from "./integration-support.js";
import { bindCells, contend, open } from "./b10-cells-support.js";
import { blockedBy } from "./b10-cells-6a-support.js";
import type { SqlStep } from "./fault-support.js";
import { paymentRoutes } from "./commerce-support.js";
import { execute } from "./payment-support.js";
import { sellingAgency } from "./commission-support.js";
import { asProblem, call, completed, freshKey, ids, outcome, replayTextOf, type PlanFixture, type Reply } from "./support.js";

let iw: IntegrationWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => iw.h.oracle);
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
  // states in state order, never created_at order (a host clock can step back, ADV-17): the lists compared hold at most one replacement
  const replacements = await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.quotes WHERE replaces_quote_id = $1 ORDER BY state, quote_id", [p.quoteId]);
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

/** The paid quote's one replacement (every caller has exactly one; never "the latest by created_at", a host clock can step back, ADV-17). */
const replacementOf = async (x: Fixture): Promise<string> => {
  const rows = await oracleRows<{ quote_id: string }>(iw, "SELECT quote_id FROM kauro.quotes WHERE replaces_quote_id = $1", [x.paid.purchase.quoteId]);
  assert.equal(rows.length, 1, "the paid quote has exactly one replacement");
  return rows[0]!.quote_id;
};
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

/** The project's live-quote read of CreateQuote (a plain read; the FOR UPDATE of the quote it names follows in the next statement). */
const LIVE_READ: SqlStep = { label: "live_read", match: /^SELECT quote_id FROM kauro\.quotes\s+WHERE agency_id = \$1 AND project_id = \$2\s+AND \(\(replaces_quote_id IS NULL AND state IN/ };
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
      "RACE (replacement): hold one replacement before its settlement and start another key on the same paid purchase, in both orders: exactly one re-binding and one allowance ordinal, the other refused with nothing written (OPERATION_PENDING retryable, or REPLACEMENT_ALLOWANCE_SPENT) and, retried, REPLACEMENT_ALLOWANCE_SPENT; and with the other key's live-quote read before the first key's re-binding and its lock after it, in both orders, the late key is refused REPLACEMENT_ALLOWANCE_SPENT on the quote live at its lock, never 422 INTEGRITY_FAILURE, and a retry under the same or a fresh key writes nothing",
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
      // a replacement still pending is retryable: the same key retries once the pending one settles (and then reads the allowance spent)
      if (outcome(iw.w, waited) === "409 PRECONDITION_FAILED OPERATION_PENDING") assert.equal(asProblem(iw.w, waited).retryable, true, "OPERATION_PENDING is retryable");
      const s = await stateOf(x, waiterKey);
      reboundOnce(x, s, held.quote.quoteId);
      assert.deepEqual(s.replacements, ["ACCEPTED_FOR_CHECKOUT"], "one replacement quote: the waiter wrote none");
      assert.equal(s.journal, null, "the refused key journaled nothing");
      // the same key again, the race over: the allowance is spent and nothing is written
      assert.equal(outcome(iw.w, await quoteCall(x.a, waiterPlan, waiterKey)), "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT");
      reboundOnce(x, await stateOf(x, waiterKey), held.quote.quoteId);
    }
    // the same contention where the other key read the project's live quote before the first key's re-binding committed and locks it after
    // (main run 37557133856, Windows: the live-quote read is not a lock, and the re-binding may update the paid quote's row before a waiter
    // woken by the intent's COMMIT takes it): the late key must conclude from the quote that is live once its lock is held, never from the
    // superseded paid quote it read before, so it is refused REPLACEMENT_ALLOWANCE_SPENT with nothing written, never a second quote
    for (const order of ["key A late", "key B late"] as const) {
      const x = await fixture(`repl-race-late-${order === "key A late" ? "a" : "b"}`);
      const keyA = freshKey("repl-race-late-a");
      const keyB = freshKey("repl-race-late-b");
      const [lateKey, firstKey] = order === "key A late" ? [keyA, keyB] : [keyB, keyA];
      const lateConn = await open("kauro_app_test");
      try {
        const read = ctx.points.pause("db.live_read.after");
        const late = ctx.operation(`the replacement of ${order}, held after its live-quote read`, () => quoteOn(ctx, lateConn, x, lateKey, [LIVE_READ])).then(
          (v): PromiseSettledResult<Reply> => ({ status: "fulfilled", value: v }),
          (reason: unknown): PromiseSettledResult<Reply> => ({ status: "rejected", reason }),
        );
        await read.reachedBy(late);
        // the first key's whole replacement runs meanwhile: intent, re-binding (the paid quote SUPERSEDED) and completion
        const first = await ctx.operation("the first key's replacement, run to its answer", () => quoteCall(x.a, x.plan, firstKey));
        const done = view(first);
        assert.equal(done.replacement?.outcome, "REBOUND", "the first key re-binds the purchase while the late key holds its live-quote read");
        assert.equal((await stateOf(x, firstKey)).paidQuote, "SUPERSEDED", "the paid quote the late key read is superseded before it locks it");
        read.release();
        const answered = await late;
        assert.equal(answered.status, "fulfilled");
        const refused = answered.status === "fulfilled" ? answered.value : (undefined as never);
        assert.equal(outcome(iw.w, refused), "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT", `the late key is refused on the quote live at its lock, never a second replacement: ${outcome(iw.w, refused)}`);
        const s = await stateOf(x, lateKey);
        reboundOnce(x, s, done.quote.quoteId);
        assert.deepEqual(s.replacements, ["ACCEPTED_FOR_CHECKOUT"], "one replacement quote: the late key wrote none");
        assert.equal(s.journal, null, "the refused key journaled nothing");
        assert.equal((await stateOf(x, firstKey)).journal, "COMMITTED");
        // retried with the same key and with a fresh key, the race over: the same refusal, nothing written
        assert.equal(outcome(iw.w, await quoteCall(x.a, x.plan, lateKey)), "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT");
        const fresh = freshKey("repl-race-late-fresh");
        assert.equal(outcome(iw.w, await quoteCall(x.a, x.plan, fresh)), "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT");
        const after = await stateOf(x, fresh);
        reboundOnce(x, after, done.quote.quoteId);
        assert.deepEqual(after.replacements, ["ACCEPTED_FOR_CHECKOUT"]);
        assert.equal(after.journal, null);
        assert.equal((await stateOf(x, lateKey)).journal, null);
      } finally {
        await lateConn.end();
      }
    }
  },
);

faultCell(
  {
    id: "REPL_RACE",
    step: "CMD027 included-replacement protocol / RACE: S2 settle, the same key's recovery against the first request",
    fault: "race",
    expect:
      "RACE (replacement): the same key recovered concurrently, held before the first intent commits, while the first completes, and between its own ordinary reads while the first commits (a refusal over a re-bound purchase is REBOUND by identity), makes exactly one re-binding and one allowance ordinal and answers REBOUND",
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
    // 3. the first request live (its bound not crossed), held after its allowance record; the same key's recovery runs its ordinary reads up to its
    //    allowance read and is held there; the first's SERVICE unit COMMITs and the first is held right after that COMMIT, before its completion;
    //    the recovery then reads the allowance spent (Codex F1): its rebinder refuses (ALLOWANCE_USED) over a purchase that IS re-bound, and it
    //    completes the still-open journal entry itself: the key must converge to REBOUND, exactly one re-binding, never WITHDRAWN
    {
      const x = await fixture("repl-race-recover-between-reads");
      const key = freshKey("repl-race-recover-between-reads");
      const hold = ctx.points.pause("pay.rebindings.record.after");
      const first = ctx.operation("the first request, held after its allowance record", () => iw.faults.onPayment(ctx.points, () => quoteCall(x.a, x.plan, key)));
      first.catch(() => undefined);
      await hold.reachedBy(first);
      const between = ctx.points.pause("pay.rebindings.listForCapture.before");
      const recovery = ctx.operation("the same key's recovery, held between its reads", () => iw.faults.onPayment(ctx.points, () => quoteCall(x.a, x.plan, key))).then(
        (v): PromiseSettledResult<Reply> => ({ status: "fulfilled", value: v }),
        (reason: unknown): PromiseSettledResult<Reply> => ({ status: "rejected", reason }),
      );
      await between.reachedBy(recovery);
      const committed = ctx.points.pause("uow.after-commit");
      hold.release();
      await committed.reachedBy(first);
      assert.equal((await stateOf(x, key)).rebindings.length, 1, "the first's SERVICE unit committed the re-binding; its journal entry is still open");
      assert.equal((await stateOf(x, key)).journal, "RESERVED");
      between.release();
      const answer = await recovery;
      assert.equal(answer.status, "fulfilled");
      if (answer.status === "fulfilled" && answer.value.status !== 201) assert.fail(`the recovery answered ${answer.value.status} ${answer.value.text}`);
      const resumed = view(answer.status === "fulfilled" ? answer.value : (undefined as never));
      assert.equal(resumed.replacement?.outcome, "REBOUND", `the recovery converged to the re-binding, never ${resumed.replacement?.outcome} (${resumed.replacement?.reason ?? "no reason"})`);
      assert.equal((await stateOf(x, key)).journal, "COMMITTED", "the recovery completed the entry itself");
      committed.release();
      const firstReply = await first;
      assert.equal(firstReply.status, 201, `the first request then answers the committed entry: ${firstReply.text}`);
      assert.equal(view(firstReply).replacement?.outcome, "REBOUND");
      const s = await stateOf(x, key);
      reboundOnce(x, s, resumed.quote.quoteId);
      assert.deepEqual(s.replacements, ["ACCEPTED_FOR_CHECKOUT"], "one replacement quote, never withdrawn");
      assert.equal(s.journal, "COMMITTED");
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

/** Polls the oracle until `check` holds (the abandoned SERVICE unit's own COMMIT or ROLLBACK is not a statement the harness routes). */
async function until(what: string, check: () => Promise<boolean>, limitMs = 10_000): Promise<void> {
  const limit = Date.now() + limitMs;
  while (!(await check())) {
    if (Date.now() > limit) assert.fail(`${what}: not seen within ${limitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A replacement whose re-binding runs for real (the payment service's own PurchaseRebinder, in its SERVICE unit) and is held right after its
 * allowance record: the cell crosses the provider-call bound on its clock, so the application gives that unit up and answers the retriable 202.
 * The abandoned unit keeps running to its COMMIT or ROLLBACK once the cell lets it, whatever the caller was told.
 */
async function abandonedRebinding(ctx: FaultContext, x: Fixture, key: string, label: string): Promise<{ readonly pause: ReturnType<FaultContext["points"]["pause"]>; readonly reply: Reply }> {
  const deadline = ctx.deadline(ctx.clock.at(PROVIDER_CALL_TIMEOUT_MS), `the re-binding's call bound (${label})`);
  const pause = ctx.points.pause("pay.rebindings.record.after");
  const running = ctx.operation(`the replacement whose re-binding is held after its allowance record (${label})`, () => iw.faults.onPayment(ctx.points, () => quoteCall(x.a, x.plan, key)));
  await pause.reachedBy(running);
  ctx.clock.past(deadline);
  const settled = await Promise.race([running, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))]);
  if (settled === null) {
    pause.release();
    await running.catch(() => undefined);
    assert.fail(`${label}: CreateQuote did not answer within 5 s after the re-binding's ${PROVIDER_CALL_TIMEOUT_MS} ms bound was crossed (expected the retriable 202 with the replacement ISSUED and the journal entry open)`);
  }
  assert.equal(settled.status, 202, `${label}: the retriable answer: ${settled.text}`);
  const s = await stateOf(x, key);
  untouched(x, s);
  assert.deepEqual([s.replacements, s.journal], [["ISSUED"], "RESERVED"], `${label}: nothing concluded while the abandoned unit is open`);
  return { pause, reply: settled };
}

faultCell(
  {
    id: "REPL_TMO",
    step: "CMD027 included-replacement protocol / TIMEOUT: S2 PurchaseRebinder held past its bound, its unit abandoned",
    fault: "timeout",
    expect:
      "RACE (replacement): a re-binding that outlives its bound answers the retriable 202 with the replacement ISSUED and the journal entry open, and the abandoned SERVICE unit still ends: its late COMMIT before the retry, or racing it, or its late failure (reported, not swallowed) before the retry or under a retry already waiting on its locks, or its late COMMIT landing between the retry's ordinary reads (a refusal over a re-bound purchase is REBOUND by identity), leaves the same key observing the final state by identity: exactly one re-binding, allowance ordinal 1, never re-bound twice",
  },
  async (ctx) => {
    // 1. the abandoned unit commits after the 202, then the same key retries: the re-binding it made is observed by its identity
    {
      const x = await fixture("repl-tmo-late-commit");
      const key = freshKey("repl-tmo-late-commit");
      const { pause } = await abandonedRebinding(ctx, x, key, "late commit");
      pause.release();
      await until("the abandoned re-binding committed", async () => (await stateOf(x, key)).rebindings.length === 1);
      const replacement = await replacementOf(x);
      const landed = await stateOf(x, key);
      reboundOnce(x, landed, replacement);
      assert.deepEqual([landed.replacements, landed.journal], [["ACCEPTED_FOR_CHECKOUT"], "RESERVED"], "the late commit re-bound the purchase; the 202 journaled nothing, the entry is still open");
      const first = await quoteCall(x.a, x.plan, key);
      const resumed = view(first);
      assert.deepEqual([resumed.replacement?.outcome, resumed.quote.quoteId, resumed.replacement?.revokedAuthorizationId], ["REBOUND", replacement, x.paid.purchase.authorizationId], "the same key answers the committed re-binding");
      const after = await stateOf(x, key);
      reboundOnce(x, after, replacement);
      assert.equal(after.journal, "COMMITTED");
      assert.equal((await quoteCall(x.a, x.plan, key)).text, replayTextOf(first), "and replays it byte for byte");
      assert.deepEqual(iw.lateFailures.filter((l) => l.call === "CMD027.rebind"), [], "a late COMMIT is no failure");
    }
    // 2. the same key retried while the abandoned unit is still in flight (holding the re-binding's locks): the retry waits on it, then observes its commit
    {
      const x = await fixture("repl-tmo-in-flight");
      const key = freshKey("repl-tmo-in-flight");
      const { pause } = await abandonedRebinding(ctx, x, key, "retry in flight");
      const holder = await oracleRows<{ pid: number }>(iw, "SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'kauro-api-payment%' AND state = 'idle in transaction'");
      assert.equal(holder.length, 1, "the abandoned SERVICE unit stands open with its writes");
      const retry = ctx.operation("the same key retried while the abandoned re-binding is in flight", () => quoteCall(x.a, x.plan, key)).then(
        (v): PromiseSettledResult<Reply> => ({ status: "fulfilled", value: v }),
        (reason: unknown): PromiseSettledResult<Reply> => ({ status: "rejected", reason }),
      );
      const waiting = await blockedBy(iw.h.oracle, holder[0]!.pid, "kauro-api-payment");
      assert.match(waiting.application, /^kauro-api-payment/, "the retry's re-binding waits on the abandoned unit's locks");
      pause.release();
      const answer = await retry;
      assert.equal(answer.status, "fulfilled");
      if (answer.status === "fulfilled" && answer.value.status !== 201) assert.fail(`the retry answered ${answer.value.status} ${answer.value.text}: ${JSON.stringify(iw.w.internalErrors.slice(-2).map((e) => String((e.error as Error)?.message ?? e.error)))}`);
      const resumed = view(answer.status === "fulfilled" ? answer.value : (undefined as never));
      assert.equal(resumed.replacement?.outcome, "REBOUND", "the retry observes the committed re-binding by its identity");
      const after = await stateOf(x, key);
      reboundOnce(x, after, resumed.quote.quoteId);
      assert.equal(after.journal, "COMMITTED");
    }
    // 3. the abandoned unit fails late and rolls back: nothing was re-bound, the failure is reported (never swallowed), the same key then re-binds once
    {
      const x = await fixture("repl-tmo-late-failure");
      const key = freshKey("repl-tmo-late-failure");
      const lateBefore = iw.lateFailures.length;
      const { pause } = await abandonedRebinding(ctx, x, key, "late failure");
      pause.crash();
      await until("the abandoned re-binding's failure was reported", async () => iw.lateFailures.length > lateBefore);
      const [late] = iw.lateFailures.slice(lateBefore);
      assert.equal(late!.call, "CMD027.rebind");
      assert.equal(simulatedCrashOf(late!.error)?.point, "pay.rebindings.record.after", "the reported failure is the one that ended the abandoned unit");
      await until("the abandoned unit rolled back", async () => (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'kauro-api-payment%' AND state = 'idle in transaction'"))[0]!.n === 0);
      const s = await stateOf(x, key);
      untouched(x, s);
      assert.deepEqual([s.replacements, s.journal], [["ISSUED"], "RESERVED"], "the rolled-back unit left the replacement ISSUED and the entry open");
      const resumed = view(await quoteCall(x.a, x.plan, key));
      assert.equal(resumed.replacement?.outcome, "REBOUND");
      reboundOnce(x, await stateOf(x, key), resumed.quote.quoteId);
    }
    // 5. the abandoned unit COMMITs between the retry's ordinary reads (Codex F1): the retry read the replacement ISSUED and the purchase intact,
    //    then the late COMMIT lands, and its allowance read sees the re-binding. The rebinder answers REFUSED (ALLOWANCE_USED): the same key
    //    must still answer REBOUND, observed by the replacement's identity, never journal WITHDRAWN over a re-bound purchase
    {
      const x = await fixture("repl-tmo-commit-between-reads");
      const key = freshKey("repl-tmo-commit-between-reads");
      const { pause } = await abandonedRebinding(ctx, x, key, "late commit between the retry's reads");
      const between = ctx.points.pause("pay.rebindings.listForCapture.before");
      const retry = ctx.operation("the same key retried, held between the rebinder's reads", () => iw.faults.onPayment(ctx.points, () => quoteCall(x.a, x.plan, key))).then(
        (v): PromiseSettledResult<Reply> => ({ status: "fulfilled", value: v }),
        (reason: unknown): PromiseSettledResult<Reply> => ({ status: "rejected", reason }),
      );
      await between.reachedBy(retry);
      pause.release();
      await until("the abandoned re-binding committed between the retry's reads", async () => (await stateOf(x, key)).rebindings.length === 1);
      between.release();
      const answer = await retry;
      assert.equal(answer.status, "fulfilled");
      if (answer.status === "fulfilled" && answer.value.status !== 201) assert.fail(`the retry answered ${answer.value.status} ${answer.value.text}`);
      const resumed = view(answer.status === "fulfilled" ? answer.value : (undefined as never));
      assert.equal(resumed.replacement?.outcome, "REBOUND", `the purchase was re-bound by the late commit: the answer is REBOUND, never ${resumed.replacement?.outcome} (${resumed.replacement?.reason ?? "no reason"})`);
      const after = await stateOf(x, key);
      reboundOnce(x, after, resumed.quote.quoteId);
      assert.equal(after.journal, "COMMITTED");
      assert.deepEqual(after.replacements, ["ACCEPTED_FOR_CHECKOUT"], "the replacement stays accepted for checkout, never withdrawn");
      assert.equal(view(await quoteCall(x.a, x.plan, key)).replacement?.outcome, "REBOUND", "and the replay says so");
    }
    // 4. the retry waits on the abandoned unit's locks and the unit ROLLS BACK (member 2 is the COMMIT): the retry re-binds exactly once, ordinal 1,
    //    and never enters the observation branch (nothing was re-bound by the abandoned unit); the late failure is reported once
    {
      const x = await fixture("repl-tmo-retry-waits-rollback");
      const key = freshKey("repl-tmo-retry-waits-rollback");
      const lateBefore = iw.lateFailures.length;
      const { pause } = await abandonedRebinding(ctx, x, key, "retry waits, abandoned unit rolls back");
      const holder = await oracleRows<{ pid: number }>(iw, "SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'kauro-api-payment%' AND state = 'idle in transaction'");
      assert.equal(holder.length, 1, "the abandoned SERVICE unit stands open with its writes");
      const passes = (point: string): number => ctx.points.passed.filter((p) => p === point).length;
      const [reads0, observed0] = [passes("pay.rebindings.listForCapture.before"), passes("pay.rebindings.findTo.before")];
      const retry = ctx.operation("the same key retried while the abandoned re-binding is in flight and about to roll back", () => iw.faults.onPayment(ctx.points, () => quoteCall(x.a, x.plan, key))).then(
        (v): PromiseSettledResult<Reply> => ({ status: "fulfilled", value: v }),
        (reason: unknown): PromiseSettledResult<Reply> => ({ status: "rejected", reason }),
      );
      const waiting = await blockedBy(iw.h.oracle, holder[0]!.pid, "kauro-api-payment");
      assert.match(waiting.application, /^kauro-api-payment/, "the retry's re-binding waits on the abandoned unit's locks");
      pause.crash();
      const answer = await retry;
      assert.equal(answer.status, "fulfilled");
      if (answer.status === "fulfilled" && answer.value.status !== 201) assert.fail(`the retry answered ${answer.value.status} ${answer.value.text}: ${JSON.stringify(iw.w.internalErrors.slice(-2).map((e) => String((e.error as Error)?.message ?? e.error)))}`);
      const resumed = view(answer.status === "fulfilled" ? answer.value : (undefined as never));
      assert.equal(resumed.replacement?.outcome, "REBOUND", "the retry re-bound the purchase itself");
      // by itself, not by observation: the retry's rebinder ran exactly once (one allowance read) and the identity observation (findTo) never ran
      assert.equal(passes("pay.rebindings.listForCapture.before") - reads0, 1, "the retry's rebinder ran exactly once");
      assert.equal(passes("pay.rebindings.findTo.before") - observed0, 0, "the observation branch was not entered: nothing was re-bound by the abandoned unit");
      const after = await stateOf(x, key);
      reboundOnce(x, after, resumed.quote.quoteId);
      assert.equal(after.journal, "COMMITTED");
      await until("the abandoned re-binding's failure was reported", async () => iw.lateFailures.length > lateBefore);
      const late = iw.lateFailures.slice(lateBefore).filter((l) => l.call === "CMD027.rebind");
      assert.equal(late.length, 1, "one late failure, the abandoned unit's");
      assert.equal(simulatedCrashOf(late[0]!.error)?.point, "pay.rebindings.record.after", "the reported failure is the one that ended the abandoned unit");
    }
  },
);

// --- REPL_REFUND_SUPERSEDE, REPL_CRB corrupt entry (D10-GAP-25, adversary ADV-6, ADV-8) -------------------------------------------

/** Every money and entitlement row of this file's database: what an ordinary issuance over a refunded replacement must leave as it is. */
const moneyRows = async (): Promise<Record<string, unknown>> =>
  (
    await oracleRows(
      iw,
      `SELECT (SELECT count(*) FROM kauro.payment_orders)::int AS orders, (SELECT count(*) FROM kauro.capture_facts)::int AS captures,
              (SELECT string_agg(state, ',' ORDER BY created_at) FROM kauro.refunds) AS refunds, (SELECT count(*) FROM kauro.ledger_entries)::int AS ledger,
              (SELECT string_agg(state || ':' || coalesce(revocation_code, '-'), ',' ORDER BY created_at) FROM kauro.commercial_authorizations) AS authorizations,
              (SELECT count(*) FROM kauro.purchase_rebindings)::int AS rebindings`,
    )
  )[0]!;

test(
  "REPL_REVOKE (sequence, no fault injected) CMD027 included-replacement protocol / REVOCATION: an ordinary CreateQuote over a re-bound replacement whose entitlement a full refund revoked -> RACE (replacement): after the re-binding, a full service refund of the purchase approved and not yet executed leaves the re-bound entitlement ACTIVE (B09 design CommercialAuthorization: authority_revoked on a full service refund, at its completion; 0016 quotes_release_guard reads COMPLETED refunds), so CreateQuote of the project is the replacement protocol's 409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT with nothing written; once the refund completed (the entitlement REVOKED) it issues 201 superseding the replacement exactly once; no capture, refund, ledger, entitlement or re-binding row changes in either phase and the allowance stays spent",
  async () => {
    const x = await fixture("repl-refund-supersede");
    const rebound = view(await quoteCall(x.a, x.plan, freshKey("repl-refund-rebind")));
    assert.equal(rebound.replacement?.outcome, "REBOUND");
    const replacementId = rebound.quote.quoteId;
    const p = x.paid.purchase;
    // a full service refund of the purchase, approved and not executed
    const requested = completed<{ refund: { refundId: string } }>(
      await call(iw.w, { url: paymentRoutes.requestRefund(p.projectId), token: x.a.billing.token, agency: x.a.s.agency.agencyId, key: freshKey("repl-refund-request"), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }),
      201,
    );
    const refundId = requested.data.refund.refundId;
    const approved = await call(iw.w, {
      url: paymentRoutes.approveRefund(refundId),
      token: iw.owner.token,
      agency: null,
      key: freshKey("repl-refund-approve"),
      body: { expectedVersion: 1, serviceCents: x.paid.quote.quote.serviceCents, taxCents: "0", authorizationRef: await iw.w.stepUp(iw.owner) },
    });
    assert.equal(approved.status, 200, approved.text);
    const live = (await oracleRows<{ authorization_id: string; state: string }>(iw, "SELECT authorization_id, state FROM kauro.commercial_authorizations WHERE quote_id = $1", [replacementId]))[0]!;
    assert.equal(live.state, "ACTIVE", "an approved refund not yet executed leaves the re-bound entitlement ACTIVE (B09 CommercialAuthorization: revoked at the full refund's completion)");
    // (a) the refund not executed: the paid purchase stands and its one included replacement is spent
    const before = await moneyRows();
    const refusedKey = freshKey("repl-refund-before");
    const refused = await quoteCall(x.a, x.plan, refusedKey);
    assert.equal(outcome(iw.w, refused), "409 PRECONDITION_FAILED REPLACEMENT_ALLOWANCE_SPENT", `the paid purchase stands: ${refused.status >= 400 ? "" : refused.text}`);
    assert.equal((await iw.w.journal(refusedKey))?.state ?? null, null, "nothing journaled");
    assert.deepEqual((await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.quotes WHERE quote_id = $1", [replacementId])).map((r) => r.state), ["ACCEPTED_FOR_CHECKOUT"]);
    assert.deepEqual(await stateOf(x, refusedKey).then((s) => s.replacements), ["ACCEPTED_FOR_CHECKOUT"], "no quote written");
    assert.deepEqual(await moneyRows(), before, "no money or entitlement row changed");
    // (b) the refund completed: the ordinary issuance supersedes the refunded replacement, money untouched, the allowance still spent
    const executed = await execute(iw.pw, refundId, { expectedVersion: 2 });
    assert.equal(executed.status, 200, executed.text);
    assert.equal(await authorizationState(live.authorization_id), "REVOKED", "the completed full refund revoked the re-bound entitlement");
    const afterRefund = await moneyRows();
    const issuedKey = freshKey("repl-refund-after");
    const issued = view(await quoteCall(x.a, x.plan, issuedKey));
    assert.equal(issued.supersededQuoteId, replacementId, "the refunded replacement is superseded");
    assert.equal(issued.replacement, undefined, "an ordinary quote, not a replacement");
    assert.deepEqual(await moneyRows(), afterRefund, "no capture, refund, ledger, entitlement or re-binding row changed");
    const s = await stateOf(x, issuedKey);
    assert.deepEqual(s.rebindings, [[p.quoteId, replacementId, 1]], "the allowance stays spent: one re-binding, ordinal 1");
    assert.deepEqual(s.replacements, ["SUPERSEDED"]);
    assert.equal(s.journal, "COMMITTED");
    const issuances = await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.quote_issuances WHERE quote_id = $1", [issued.quote.quoteId]);
    assert.equal(issuances[0]!.n, 1, "one issuance of the new quote");
    assert.equal(view(await quoteCall(x.a, x.plan, issuedKey)).quote.quoteId, issued.quote.quoteId, "the same key replays its one quote: superseded exactly once");
  },
);


test("ADV-9/ADV-11: a STALE_VERSION of the payment service's re-binder (the real shape: the version and state of the authorization it lost on) that is not a re-binding observed by identity is answered as the retryable STALE_VERSION of CMD027 with the project's live quote as current, never the authorization's version and state; the same key then re-binds once", async () => {
  const x = await fixture("repl-rebinder-stale");
  const key = freshKey("repl-rebinder-stale");
  // the re-binder's revoke lost its CAS on the paid authorization (an execution admission CONSUMED it meanwhile): StaleVersionFailure of that row
  const reply = await withRebinder(async () => {
    throw new StaleVersionFailure(7, "CONSUMED");
  }, () => quoteCall(x.a, x.plan, key));
  assert.equal(reply.status >= 400 ? outcome(iw.w, reply) : `${reply.status} ${reply.text}`, "409 STALE_VERSION -");
  const problem = asProblem(iw.w, reply);
  assert.equal(problem.retryable, true);
  const paid = (await oracleRows<{ version: number; state: string }>(iw, "SELECT version::int AS version, state FROM kauro.quotes WHERE quote_id = $1", [x.paid.purchase.quoteId]))[0]!;
  assert.deepEqual(problem.current, { version: paid.version, state: paid.state }, "current is the project's live quote (the paid quote), never the authorization's {7, CONSUMED}");
  const s = await stateOf(x, key);
  untouched(x, s);
  assert.deepEqual([s.replacements, s.journal], [["ISSUED"], "RESERVED"], "the intent stays open, nothing re-bound");
  const resumed = view(await quoteCall(x.a, x.plan, key));
  assert.equal(resumed.replacement?.outcome, "REBOUND");
  reboundOnce(x, await stateOf(x, key), resumed.quote.quoteId);
});


test("REPL_REVOKE (sequence, taxed purchase, ADV-10): after the re-binding, a single full SERVICE refund of a taxed purchase that returns no tax is refused at approval 409 PRECONDITION_FAILED REFUND_TAX_INCONSISTENT (0016 refunds_commitment_ceiling, KP012: the tax follows the service cumulatively, a refund leaving no service basis returns the whole remaining tax) and the entitlement stays ACTIVE (not covered here, GAP lane B09-TAX-ROUNDING: the KP012 remainder after a failed booked refund and the chargeback path); the full refund with its tax, once completed, lets CreateQuote supersede the replacement exactly once (201) with no money or entitlement row changed", async () => {
  const s0 = await sellingAgency(iw as never, "repl-refund-taxed", { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1900 });
  iw.buyers.set(s0.agency.agencyId, "AGENCY");
  const billing = await iw.w.person("repl-refund-taxed-billing");
  await iw.h.addMember(s0.agency, billing.userId, "BILLING");
  const a = { s: s0, billing } as Agent;
  const paid = await bought(iw, a, "repl-refund-taxed-paid", { units: 50_000 });
  assert.ok(BigInt(paid.quote.quote.taxCents) > 0n, `the purchase is taxed: ${paid.quote.quote.taxCents}`);
  const plan = await replacementPlanOf(iw, a, paid, { units: 45_000, seed: "repl-refund-taxed-replacement" });
  const x: Fixture = { a, paid, plan };
  const rebound = view(await quoteCall(a, plan, freshKey("repl-refund-taxed-rebind")));
  assert.equal(rebound.replacement?.outcome, "REBOUND");
  const replacementId = rebound.quote.quoteId;
  const p = paid.purchase;
  const requested = completed<{ refund: { refundId: string } }>(
    await call(iw.w, { url: paymentRoutes.requestRefund(p.projectId), token: billing.token, agency: s0.agency.agencyId, key: freshKey("repl-refund-taxed-request"), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }),
    201,
  );
  const refundId = requested.data.refund.refundId;
  const approve = async (taxCents: string): Promise<Reply> =>
    call(iw.w, { url: paymentRoutes.approveRefund(refundId), token: iw.owner.token, agency: null, key: freshKey("repl-refund-taxed-approve"), body: { expectedVersion: 1, serviceCents: paid.quote.quote.serviceCents, taxCents, authorizationRef: await iw.w.stepUp(iw.owner) } });
  const before = await moneyRows();
  const serviceOnly = await approve("0");
  assert.equal(serviceOnly.status >= 400 ? outcome(iw.w, serviceOnly) : `${serviceOnly.status}`, "409 PRECONDITION_FAILED REFUND_TAX_INCONSISTENT", "a full service refund that returns no tax is refused at approval");
  assert.deepEqual(await moneyRows(), before, "nothing committed");
  const live = (await oracleRows<{ authorization_id: string; state: string }>(iw, "SELECT authorization_id, state FROM kauro.commercial_authorizations WHERE quote_id = $1", [replacementId]))[0]!;
  assert.equal(live.state, "ACTIVE", "the re-bound entitlement stands");
  const withTax = await approve(paid.quote.quote.taxCents);
  assert.equal(withTax.status, 200, withTax.text);
  const executed = await execute(iw.pw, refundId, { expectedVersion: 2 });
  assert.equal(executed.status, 200, executed.text);
  assert.equal(await authorizationState(live.authorization_id), "REVOKED");
  const afterRefund = await moneyRows();
  const issuedKey = freshKey("repl-refund-taxed-after");
  const issued = view(await quoteCall(a, plan, issuedKey));
  assert.equal(issued.supersededQuoteId, replacementId, "the wholly refunded replacement is superseded");
  assert.deepEqual(await moneyRows(), afterRefund, "no capture, refund, ledger, entitlement or re-binding row changed");
  const s = await stateOf(x, issuedKey);
  assert.deepEqual(s.rebindings, [[p.quoteId, replacementId, 1]], "the allowance stays spent");
  assert.deepEqual(s.replacements, ["SUPERSEDED"]);
  assert.equal(view(await quoteCall(a, plan, issuedKey)).quote.quoteId, issued.quote.quoteId, "superseded exactly once: the same key replays");
});

faultCell(
  {
    id: "REPL_CRB",
    step: "CMD027 included-replacement protocol / CRASH-BEFORE: S2 settle, the open journal entry found without its issuance",
    fault: "crash-before-commit",
    at: "uow",
    expect:
      "DEFENCE (forced state after a crash before COMMIT): a replacement left open by a crash before its SERVICE COMMIT whose journal entry then has no issuance (an invariant breach, injected) is answered 422 INTEGRITY_FAILURE, not retryable, never a retryable OPERATION_PENDING a client would retry forever; nothing is written",
  },
  async (ctx) => {
    const x = await fixture("repl-corrupt-entry");
    const key = freshKey("repl-corrupt-entry");
    ctx.points.crash("uow.before-commit");
    const crashed = await ctx.operation("the replacement whose re-binding dies before its SERVICE COMMIT", () => iw.faults.onPayment(ctx.points, () => quoteCall(x.a, x.plan, key)));
    assert.equal(outcome(iw.w, crashed), "500 INTERNAL_ERROR -");
    assert.equal((await stateOf(x, key)).journal, "RESERVED", "the intent's journal entry stays open");
    const replacementId = await replacementOf(x);
    // the injected breach: the entry's issuance gone (the database owner, triggers off; never a product step)
    const owner = await iw.h.pg.connect("postgres");
    try {
      await owner.query("BEGIN");
      await owner.query("SET LOCAL session_replication_role = replica");
      await owner.query("DELETE FROM kauro.quote_issuances WHERE quote_id = $1", [replacementId]);
      await owner.query("COMMIT");
    } finally {
      await owner.end();
    }
    const before = await moneyRows();
    const reply = await quoteCall(x.a, x.plan, key);
    assert.equal(outcome(iw.w, reply), "422 INTEGRITY_FAILURE -", `an open entry without its issuance is an integrity failure: ${reply.text}`);
    assert.equal(asProblem(iw.w, reply).retryable, false, "not retryable: the state never clears by itself");
    assert.equal((await stateOf(x, key)).journal, "RESERVED");
    assert.deepEqual(await moneyRows(), before);
  },
);
