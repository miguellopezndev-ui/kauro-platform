// The tier-1 GAPs of the B10 failure matrix on the payout commands (docs/design/B10-failure-matrix.md "GAP list, by risk" -> "Tier 1"),
// each a cell of the common fault harness (docs/design/FAULT-HARNESS.md): the REAL route of CMD052 / CMD053 runs its REAL unit of work
// over a connection the harness opened (test/fault-support.ts), so a race cell observes the command itself waiting on the holder's
// lock, a crash cell dies at the COMMIT boundary, a partial cell fails after a statement of the unit completed. PostgreSQL 17 through
// the runtime login roles; the superuser only reads. Nothing sleeps. Titles are the matrix's proposed titles.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { PayoutIntentView, PayoutReconciliationView, PeriodCloseView } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { connectionPid, faultCell, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import {
  approvePayout,
  bankCash,
  claimedCents,
  closeMonth,
  eligibleLines,
  intentOf,
  reconcilePayout,
  rows,
  scriptEvidence,
  seller,
  statementsOfSeller,
  statementsWorld,
  type LineSpec,
  type StatementsWorld,
} from "./statements-support.js";
import { completed, freshKey, outcome, type Person, type Reply } from "./support.js";
import type { SqlStep } from "./fault-support.js";

let sw: StatementsWorld;
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
type Seller = Awaited<ReturnType<typeof seller>>;
interface Issued {
  readonly s: Seller;
  readonly statementId: string;
  readonly version: number;
  readonly payable: bigint;
  readonly lineIds: string[];
}

/** One seller per spec, each with its lines; the month closed through CMD051: each seller's ISSUED statement. */
async function issued(month: string, specs: ReadonlyArray<ReadonlyArray<LineSpec>>, label: string): Promise<Issued[]> {
  const sellers: Array<{ s: Seller; lines: string[] }> = [];
  for (let i = 0; i < specs.length; i++) {
    const s = await seller(sw, `${label}-${i}`, WHOLE);
    const sold = await eligibleLines(sw, `${label}-${i} ${month}`, s, WHOLE, specs[i]!);
    sellers.push({ s, lines: sold.lines.map((l) => l.lineId) });
  }
  const { periodId, reply } = await closeMonth(sw, month);
  completed<PeriodCloseView>(reply, 200);
  const out: Issued[] = [];
  for (const { s, lines } of sellers) {
    const st = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === periodId);
    assert.ok(st !== undefined, "the close issued the seller's statement");
    out.push({ s, statementId: st.statement_id, version: Number(st.version), payable: BigInt(st.payable_cents), lineIds: lines });
  }
  return out;
}

const approveBody = async (st: Issued, payeeRef = st.s.destinationId, who: Person = sw.owner) => ({ expectedVersion: st.version, payeeRef, authorizationRef: await sw.w.stepUp(who) });
const intentCount = async (statementId: string): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.payout_intents WHERE statement_id = $1", [statementId]))[0]!.n);
const statementState = async (statementId: string): Promise<string> => (await rows<{ state: string }>(sw, "SELECT state FROM kauro.commission_statements WHERE statement_id = $1", [statementId]))[0]!.state;

/** The real CMD052 route for `st`, its units of work on `conn`, the harness's `uow.*` points of the cell around its COMMIT. */
async function approveOn(ctx: FaultContext, conn: HarnessConnection, st: Issued, options: { readonly key?: string; readonly payeeRef?: string; readonly steps?: ReadonlyArray<SqlStep>; readonly owner?: Person; readonly body?: Awaited<ReturnType<typeof approveBody>> } = {}): Promise<Reply> {
  const who = options.owner ?? sw.owner;
  const body = options.body ?? (await approveBody(st, options.payeeRef, who));
  return sw.faults.on(conn, "kauro_app", ctx.points, options.steps ?? [], () => approvePayout(sw, st.statementId, body, { token: who.token, ...(options.key === undefined ? {} : { key: options.key }) }));
}

type Login = "kauro_app_test" | "kauro_payment_test" | "kauro_commission_test" | "kauro_control_test";
interface Actor<T> {
  readonly login: Login;
  run(conn: HarnessConnection): Promise<T>;
}
const actor = <T>(login: Login, run: (conn: HarnessConnection) => Promise<T>): Actor<T> => ({ login, run });
const asApp = <T>(run: (conn: HarnessConnection) => Promise<T>): Actor<T> => actor("kauro_app_test", run);
const open = (login: Login): Promise<HarnessConnection> => openConnection(sw.h.pg.clientConfig(login));

/**
 * The holder's real command held at a point of the cell (default: its COMMIT, every write done and every lock kept), and a second actor
 * observed waiting on it (ctx.mustWait: its own statement blocked by the holder's backend); then the holder goes on. Both outcomes come back.
 */
async function holdAndWait<H, W>(ctx: FaultContext, what: string, holder: Actor<H>, waiter: Actor<W>, at = "uow.before-commit"): Promise<{ readonly held: PromiseSettledResult<H>; readonly waited: PromiseSettledResult<W> }> {
  const hc = await open(holder.login);
  const wc = await open(waiter.login);
  try {
    const pause = ctx.points.pause(at);
    const running = ctx.operation(`${what} (holder)`, () => holder.run(hc));
    const settledHolder = running.then<PromiseSettledResult<H>, PromiseSettledResult<H>>((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    await pause.reachedBy(running);
    const waiting = await ctx.mustWait(sw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (c) => waiter.run(c), what);
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

// --- 1. PAY_CASH_RACE ---------------------------------------------------------------------------------------------------------------

let month = 0;
const nextMonth = (): string => `2026-${String(++month).padStart(2, "0")}`;

faultCell(
  {
    id: "PAY_CASH_RACE",
    step: "CMD052 ApproveCommissionPayout, bank-available cash read of two statements",
    fault: "race",
    expect: "RACE: two ApproveCommissionPayout calls on two statements whose payables each fit the bank-available cash but not together admit one intent and refuse the other FUNDS_UNAVAILABLE, in both orders",
  },
  async (ctx) => {
    const [a, b, c, d] = await issued(nextMonth(), [[{ basisCents: 6_000n, poolCents: 6_000n }], [{ basisCents: 6_000n, poolCents: 6_000n }], [{ basisCents: 6_000n, poolCents: 6_000n }], [{ basisCents: 6_000n, poolCents: 6_000n }]], "cash-race");
    for (const [first, second] of [[a!, b!], [d!, c!]] as const) {
      // cash for one of the two payables and not for both
      await bankCash(sw, (await claimedCents(sw)) + 6_000n + 5_999n);
      const { held, waited } = await holdAndWait(
        ctx,
        `the approval of ${second.statementId} while the approval of ${first.statementId} holds the cash`,
        asApp((conn) => approveOn(ctx, conn, first)),
        asApp((conn) => approveOn(ctx, conn, second)),
      );
      completed<PayoutIntentView>(value(held), 200);
      assert.equal(outcome(sw.w, value(waited)), "409 PRECONDITION_FAILED FUNDS_UNAVAILABLE", "the second approval finds the first one's claim and the cash does not cover both");
      assert.equal(await intentCount(first.statementId), 1);
      assert.equal(await intentCount(second.statementId), 0);
      assert.equal(await statementState(second.statementId), "ISSUED");
    }
  },
);

// --- 2. PAY_CASH_BASIS --------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "PAY_CASH_BASIS",
    step: "CMD052 ApproveCommissionPayout, bank-available cash against a newer bank-evidenced settlement",
    fault: "race",
    expect:
      "RACE: a settlement that lowers the bank-available cash committing while ApproveCommissionPayout holds its cash read, in both orders: the approval uses one consistent cash basis and is FUNDS_UNAVAILABLE rather than spending cash shown only by the stale snapshot",
  },
  async (ctx) => {
    const [a, b] = await issued(nextMonth(), [[{ basisCents: 7_000n, poolCents: 7_000n }], [{ basisCents: 7_000n, poolCents: 7_000n }]], "cash-basis");
    const settle = (cents: bigint) => actor("kauro_payment_test", (conn) => bankCash(sw, cents, sw.faults.unit(conn, "kauro_payment", ctx.points) as never));

    // approval first (holding the cash it read), the lowering settlement observed waiting for it: the approval spent the basis it read, consistently
    await bankCash(sw, (await claimedCents(sw)) + 7_000n);
    const first = await holdAndWait(ctx, "the settlement lowering the cash while the approval holds its cash read", asApp((conn) => approveOn(ctx, conn, a!)), settle((await claimedCents(sw)) - 1n));
    completed<PayoutIntentView>(value(first.held), 200);
    value(first.waited);
    assert.equal(await intentCount(a!.statementId), 1, "the approval committed on the basis it read; the settlement then landed after it");

    // settlement first (holding its lock), the approval observed waiting: it reads the lowered cash and is refused
    const claimed = await claimedCents(sw);
    const second = await holdAndWait(ctx, "the approval while the settlement lowering the cash is held", settle(claimed + 6_999n), asApp((conn) => approveOn(ctx, conn, b!)));
    value(second.held);
    assert.equal(outcome(sw.w, value(second.waited)), "409 PRECONDITION_FAILED FUNDS_UNAVAILABLE", "the lowered cash is the basis: one cent short of the payable");
    assert.equal(await intentCount(b!.statementId), 0);
    assert.equal(await statementState(b!.statementId), "ISSUED");
  },
);

// --- CMD053 on the real route -------------------------------------------------------------------------------------------------------

interface Approved extends Issued {
  readonly intent: Awaited<ReturnType<typeof intentOf>>;
}

/** Statements of a month, each approved through the real CMD052 route to its seller's VERIFIED destination (cash made to cover it). */
async function approvedMonth(month: string, label: string, cents: ReadonlyArray<bigint>): Promise<Approved[]> {
  const all = await issued(month, cents.map((c) => [{ basisCents: c, poolCents: c }]), label);
  const out: Approved[] = [];
  for (const st of all) {
    await bankCash(sw, (await claimedCents(sw)) + st.payable);
    completed<PayoutIntentView>(await approvePayout(sw, st.statementId, await approveBody(st)), 200);
    out.push({ ...st, intent: await intentOf(sw, st.statementId) });
  }
  return out;
}

const factsOf = (a: Approved) => ({ reference: a.intent.reference, destinationDigest: a.intent.destinationDigest, amountCents: a.intent.amount, currency: a.intent.currency });
const commission = (run: (conn: HarnessConnection) => Promise<Reply>): Actor<Reply> => actor("kauro_commission_test", run);

/** The real CMD053 route for `a` with evidence of `status`, its units of work on `conn` (the verifier answers before the unit opens). */
function reconcileOn(ctx: FaultContext, conn: HarnessConnection, a: Approved, status: "SETTLED" | "FAILED" | "RETURNED", options: { readonly key?: string; readonly steps?: ReadonlyArray<SqlStep>; readonly ref?: string } = {}): Promise<Reply> {
  const ref = options.ref ?? scriptEvidence(sw, sw.payouts.matching(factsOf(a), status));
  return sw.faults.on(conn, "kauro_commission", ctx.points, options.steps ?? [], () => reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: ref }, options.key === undefined ? {} : { key: options.key }));
}

const intentState = async (intentId: string): Promise<string> => (await rows<{ state: string }>(sw, "SELECT state FROM kauro.payout_intents WHERE intent_id = $1", [intentId]))[0]!.state;

// --- 3. PAY_INTENT_BASIS ------------------------------------------------------------------------------------------------------------

const INTENTS_READ: SqlStep = { label: "intents", match: /coalesce\(sum\(amount_cents\)/ };

faultCell(
  {
    id: "PAY_INTENT_BASIS",
    step: "CMD052 ApproveCommissionPayout against CMD053 changing the unsettled authorized intents",
    fault: "race",
    expect:
      "RACE: ReconcileCommissionPayout of an earlier intent committing while ApproveCommissionPayout is held after its cash and intents reads, in both orders: coverage is computed on one consistent cash and unsettled-intent basis, never double counting a settled intent nor freeing cash a returned one does not",
  },
  async (ctx) => {
    const [e1, e2, s1, s2] = await (async () => {
      const month = nextMonth();
      const all = await approvedMonth(month, "intent-basis", [5_000n, 5_000n]);
      // the next month's statements stay ISSUED (a second close of another month, its own lines)
      const later = await issued(nextMonth(), [[{ basisCents: 5_000n, poolCents: 5_000n }], [{ basisCents: 5_000n, poolCents: 5_000n }]], "intent-basis-next");
      return [all[0]!, all[1]!, later[0]!, later[1]!] as const;
    })();

    // reconciliation first (held at its COMMIT), the approval observed waiting: the earlier intent is no longer unsettled, so the cash covers the approval
    await bankCash(sw, (await claimedCents(sw)) + 4_999n);
    const afterReconcile = await holdAndWait(ctx, "the approval while the reconciliation of the earlier intent is held", commission((conn) => reconcileOn(ctx, conn, e1, "FAILED")), asApp((conn) => approveOn(ctx, conn, s1)));
    completed<PayoutReconciliationView>(value(afterReconcile.held), 200);
    completed<PayoutIntentView>(value(afterReconcile.waited), 200);
    assert.equal(await intentState(e1.intent.intentId), "FAILED");
    assert.equal(await intentCount(s1.statementId), 1, "the approval counted the reconciled intent out: one basis");

    // approval first (held after its cash and intents reads), the reconciliation observed waiting: the approval counted the earlier intent in, so it is refused
    await bankCash(sw, (await claimedCents(sw)) + 4_999n);
    const beforeReconcile = await holdAndWait(
      ctx,
      "the reconciliation of the earlier intent while the approval is held after its reads",
      asApp((conn) => approveOn(ctx, conn, s2, { steps: [INTENTS_READ] })),
      commission((conn) => reconcileOn(ctx, conn, e2, "FAILED")),
      "db.intents.after",
    );
    assert.equal(outcome(sw.w, value(beforeReconcile.held)), "409 PRECONDITION_FAILED FUNDS_UNAVAILABLE", "the approval keeps the basis it read: the earlier intent was still unsettled");
    completed<PayoutReconciliationView>(value(beforeReconcile.waited), 200);
    assert.equal(await intentCount(s2.statementId), 0);
    assert.equal(await intentState(e2.intent.intentId), "FAILED");
  },
);

// --- 4. PAY_REV (the owner's grant) -------------------------------------------------------------------------------------------------

const REVOKE_GRANT = "UPDATE kauro.corporate_roles SET state = 'REVOKED', revoked_at = now() WHERE grant_id = $1 AND state = 'ACTIVE'";

faultCell(
  {
    id: "PAY_REV",
    step: "CMD052 ApproveCommissionPayout, the KAURO_OWNER grant revoked",
    fault: "revocation",
    expect:
      "RACE: a KAURO_OWNER grant revoked while ApproveCommissionPayout waits on the grant's transition lock refuses with NOT_AUTHORIZED and writes no intent; an approval holding the grant commits first and the revocation lands after it, and every approval after the revocation is refused",
  },
  async (ctx) => {
    const [a, b, c] = await issued(nextMonth(), [[{ basisCents: 3_000n, poolCents: 3_000n }], [{ basisCents: 3_000n, poolCents: 3_000n }], [{ basisCents: 3_000n, poolCents: 3_000n }]], "rev");
    const ownerWithGrant = async (name: string) => {
      const person = await sw.w.person(name);
      return { person, grantId: await sw.h.grantKauroOwner(person.userId as UserId) };
    };
    await bankCash(sw, (await claimedCents(sw)) + 9_000n);

    // revocation first, uncommitted: the approval waits on the grant's transition lock; the revocation commits; the approval finds the grant revoked
    const early = await ownerWithGrant("pay-rev-early");
    const rc = await open("kauro_control_test");
    const wc = await open("kauro_app_test");
    try {
      await rc.query("BEGIN");
      await rc.query(REVOKE_GRANT, [early.grantId]);
      const waiting = await ctx.mustWait(sw.h.oracle, { waiter: wc, holder: connectionPid(rc) }, (conn) => approveOn(ctx, conn, a!, { owner: early.person }), "the approval while the owner's grant revocation is uncommitted");
      await ctx.revoked("the owner's grant", () => rc.query("COMMIT"));
      const refused = value(await waiting.pending);
      assert.match(outcome(sw.w, refused), /^403 NOT_AUTHORIZED /, "the approval that waited finds the grant revoked");
      assert.equal(await intentCount(a!.statementId), 0);
      assert.equal(await statementState(a!.statementId), "ISSUED");
    } finally {
      await rc.end();
      await wc.end();
    }

    // approval first (held at its COMMIT, holding the grant's shared half): the revocation waits and lands after it
    const late = await ownerWithGrant("pay-rev-late");
    const grant = await holdAndWait(ctx, "the grant revocation while the owner's approval is held", asApp((conn) => approveOn(ctx, conn, b!, { owner: late.person })), actor("kauro_control_test", (conn) => conn.query(REVOKE_GRANT, [late.grantId])));
    completed<PayoutIntentView>(value(grant.held), 200);
    await ctx.revoked("the owner's grant", async () => assert.equal(value(grant.waited).rowCount, 1));
    assert.equal(await intentCount(b!.statementId), 1, "the approval that held the grant committed before the revocation");

    // after the revocation, every approval of that owner is refused and writes nothing
    const fc = await open("kauro_app_test");
    try {
      await ctx.fenced(
        "an approval by the revoked owner",
        async () => {
          const reply = await approveOn(ctx, fc, c!, { owner: late.person });
          if (reply.status === 403) throw new Refused(outcome(sw.w, reply));
          throw new Error(`the revoked owner was not refused: ${reply.status}`);
        },
        (e) => e instanceof Refused && /^403 NOT_AUTHORIZED /.test(e.message),
      );
    } finally {
      await fc.end();
    }
    assert.equal(await intentCount(c!.statementId), 0);
  },
);

class Refused extends Error {}

// --- 5. PAY_SETTLE_FLIP -------------------------------------------------------------------------------------------------------------

const lineStatesOf = async (a: Approved): Promise<string[]> => (await rows<{ state: string }>(sw, "SELECT state FROM kauro.commission_lines WHERE line_id = ANY ($1::uuid[]) ORDER BY line_id", [a.lineIds])).map((r) => r.state);
const reconciliationsOf = async (a: Approved): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.payout_reconciliations WHERE intent_id = $1", [a.intent.intentId]))[0]!.n);

faultCell(
  {
    id: "PAY_SETTLE_FLIP",
    step: "CMD053 ReconcileCommissionPayout, SETTLED and RETURNED evidence of one intent",
    fault: "race",
    expect:
      "RACE: SETTLED and RETURNED evidence for one intent delivered in both orders: the first terminal state stands, the second is refused 409 UNLISTED_TRANSITION naming the intent's state, no line leaves PAID and nothing of the second is recorded",
  },
  async (ctx) => {
    const [x, y] = await approvedMonth(nextMonth(), "flip", [4_000n, 4_000n]);
    // SETTLED first (held at its COMMIT), the RETURNED evidence observed waiting on the statement's lock
    const settledFirst = await holdAndWait(ctx, "the RETURNED evidence while the SETTLED evidence is held", commission((conn) => reconcileOn(ctx, conn, x!, "SETTLED")), commission((conn) => reconcileOn(ctx, conn, x!, "RETURNED")));
    completed<PayoutReconciliationView>(value(settledFirst.held), 200);
    const late = value(settledFirst.waited);
    assert.equal(outcome(sw.w, late), "409 PRECONDITION_FAILED UNLISTED_TRANSITION");
    assert.deepEqual([await intentState(x!.intent.intentId), await statementState(x!.statementId), await lineStatesOf(x!), await reconciliationsOf(x!)], ["SETTLED", "PAID", ["PAID"], 1], "no line leaves PAID");

    // RETURNED first, the SETTLED evidence waiting
    const returnedFirst = await holdAndWait(ctx, "the SETTLED evidence while the RETURNED evidence is held", commission((conn) => reconcileOn(ctx, conn, y!, "RETURNED")), commission((conn) => reconcileOn(ctx, conn, y!, "SETTLED")));
    completed<PayoutReconciliationView>(value(returnedFirst.held), 200);
    assert.equal(outcome(sw.w, value(returnedFirst.waited)), "409 PRECONDITION_FAILED UNLISTED_TRANSITION");
    assert.deepEqual([await intentState(y!.intent.intentId), await statementState(y!.statementId), await lineStatesOf(y!), await reconciliationsOf(y!)], ["RETURNED", "ISSUED", ["HELD"], 1], "the returned payout stays held for review");
  },
);

// --- 6. PAY_APPROVE_VS_FAIL ---------------------------------------------------------------------------------------------------------

const STATEMENT_LOCK: SqlStep = { label: "statement", match: /FROM kauro\.commission_statements s WHERE s\.statement_id = \$1 FOR UPDATE OF s/ };
const statementVersion = async (statementId: string): Promise<number> => Number((await rows<{ version: string }>(sw, "SELECT version::text FROM kauro.commission_statements WHERE statement_id = $1", [statementId]))[0]!.version);
const liveIntents = async (statementId: string): Promise<number> =>
  Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.payout_intents WHERE statement_id = $1 AND state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'SETTLED')", [statementId]))[0]!.n);

faultCell(
  {
    id: "PAY_APPROVE_VS_FAIL",
    step: "CMD052 ApproveCommissionPayout racing the FAILED reconciliation of the statement's earlier intent",
    fault: "race",
    expect: "RACE: ApproveCommissionPayout racing the FAILED reconciliation of the statement's earlier intent yields at most one live intent in both orders",
  },
  async (ctx) => {
    const [x, y] = await approvedMonth(nextMonth(), "approve-vs-fail", [2_000n, 2_000n]);
    const racing = async (a: Approved): Promise<Issued> => ({ ...a, version: await statementVersion(a.statementId) });

    // the FAILED reconciliation first (held at its COMMIT, the statement locked): the second approval, naming the APPROVED version it saw, finds the version moved
    const seenX = await racing(x!);
    const failedFirst = await holdAndWait(ctx, "the second approval while the FAILED reconciliation is held", commission((conn) => reconcileOn(ctx, conn, x!, "FAILED")), asApp((conn) => approveOn(ctx, conn, seenX)));
    completed<PayoutReconciliationView>(value(failedFirst.held), 200);
    assert.equal(outcome(sw.w, value(failedFirst.waited)), "409 STALE_VERSION -");
    assert.equal(await liveIntents(x!.statementId), 0, "the failed intent is not live and the stale approval wrote none");
    // the statement is ISSUED again at its new version: one fresh approval authorizes exactly one live intent
    await bankCash(sw, (await claimedCents(sw)) + x!.payable);
    completed<PayoutIntentView>(await approvePayout(sw, x!.statementId, await approveBody(await racing(x!))), 200);
    assert.equal(await liveIntents(x!.statementId), 1);

    // the second approval first (held right after it locked the statement): it finds the statement APPROVED; the FAILED reconciliation waits, then lands
    const seenY = await racing(y!);
    const approvalFirst = await holdAndWait(
      ctx,
      "the FAILED reconciliation while the second approval holds the statement",
      asApp((conn) => approveOn(ctx, conn, seenY, { steps: [STATEMENT_LOCK] })),
      commission((conn) => reconcileOn(ctx, conn, y!, "FAILED")),
      "db.statement.after",
    );
    assert.equal(outcome(sw.w, value(approvalFirst.held)), "409 PRECONDITION_FAILED UNLISTED_TRANSITION");
    completed<PayoutReconciliationView>(value(approvalFirst.waited), 200);
    assert.equal(await liveIntents(y!.statementId), 0);
    assert.equal(await statementState(y!.statementId), "ISSUED");
  },
);

// --- 7. PAY_PAR and SETTLE_PAR: a failure injected after a statement of the unit completed ----------------------------------------------

const INTENT_INSERT: SqlStep = { label: "intent_insert", match: /INSERT INTO kauro\.payout_intents/ };
const STATEMENT_UPDATE: SqlStep = { label: "statement_update", match: /UPDATE kauro\.commission_statements s SET/ };
const INTENT_UPDATE: SqlStep = { label: "intent_update", match: /UPDATE kauro\.payout_intents p SET state/ };
const LINE_UPDATE: SqlStep = { label: "line_update", match: /UPDATE kauro\.commission_lines l SET/ };
const HOLD_INSERT: SqlStep = { label: "hold_insert", match: /INSERT INTO kauro\.commission_holds/ };
const journalState = async (key: string): Promise<string | null> => (await sw.w.journal(key))?.state ?? null;

/** Runs `run` on a fresh connection of `login` as the operation that must fail at `at`, after an earlier statement of its unit completed. */
async function failsAt(ctx: FaultContext, what: string, at: string, login: Login, run: (conn: HarnessConnection) => Promise<Reply>): Promise<void> {
  const conn = await open(login);
  try {
    await ctx.partial(what, at, async () => {
      const seen = sw.w.internalErrors.length;
      const reply = await run(conn);
      // the route answers 500 and reports the failure it hid (a crash is not a DomainFailure): the cell sees the failure itself
      if (reply.status >= 500) throw sw.w.internalErrors[seen]?.error ?? new Error(`the unit failed: ${reply.status}`);
      return reply;
    });
  } finally {
    await conn.end();
  }
}

faultCell(
  {
    id: "PAY_PAR",
    step: "CMD052 ApproveCommissionPayout, a failure after the AUTHORIZED payout_intents insert",
    fault: "partial",
    expect: "RACE (partial): a failure injected after the payout_intents insert and before the statement APPROVED commits neither; the statement stays ISSUED and the same key approves once",
  },
  async (ctx) => {
    const [st] = await issued(nextMonth(), [[{ basisCents: 8_100n, poolCents: 8_100n }]], "pay-par");
    await bankCash(sw, (await claimedCents(sw)) + st!.payable);
    const key = freshKey("pay-par");
    const body = await approveBody(st!);
    await failsAt(ctx, "the approval failing before the statement APPROVED", "db.statement_update.before", "kauro_app_test", (conn) => approveOn(ctx, conn, st!, { key, body, steps: [INTENT_INSERT, STATEMENT_UPDATE] }));
    assert.equal(await intentCount(st!.statementId), 0, "the intent insert is rolled back with the rest");
    assert.deepEqual([await statementState(st!.statementId), await statementVersion(st!.statementId)], ["ISSUED", st!.version]);
    assert.equal(await journalState(key), null, "no journal result");
    const conn = await open("kauro_app_test");
    try {
      completed<PayoutIntentView>(await approveOn(ctx, conn, st!, { key, body }), 200);
    } finally {
      await conn.end();
    }
    assert.equal(await intentCount(st!.statementId), 1, "the same key approves once");
    assert.equal(await statementState(st!.statementId), "APPROVED");
  },
);

faultCell(
  {
    id: "SETTLE_PAR",
    step: "CMD053 ReconcileCommissionPayout, a failure inside the SETTLED, FAILED or RETURNED branch",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the intent settles and before the statement PAID, after the statement and before one line update, and before the hold writes rolls the whole branch back; the same key then settles once",
  },
  async (ctx) => {
    const [a, b, c] = await approvedMonth(nextMonth(), "settle-par", [3_100n, 3_200n, 3_300n]);
    const holds = async (x: Approved): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.commission_holds WHERE line_id = ANY ($1::uuid[])", [x.lineIds]))[0]!.n);
    const untouched = async (x: Approved): Promise<void> => {
      assert.deepEqual([await intentState(x.intent.intentId), await statementState(x.statementId), await lineStatesOf(x), await reconciliationsOf(x), await holds(x)], ["AUTHORIZED", "APPROVED", ["PAYABLE"], 0, 0], "the whole branch rolled back");
    };
    const cases = [
      { x: a!, status: "SETTLED" as const, at: "db.statement_update.before", what: "the SETTLED branch failing after the intent settles and before the statement PAID", steps: [INTENT_UPDATE, STATEMENT_UPDATE] },
      { x: b!, status: "SETTLED" as const, at: "db.line_update.before", what: "the SETTLED branch failing after the statement PAID and before the line update", steps: [STATEMENT_UPDATE, LINE_UPDATE] },
      { x: c!, status: "RETURNED" as const, at: "db.hold_insert.before", what: "the RETURNED branch failing after the statement ISSUED and before the hold write", steps: [STATEMENT_UPDATE, HOLD_INSERT] },
    ];
    for (const { x, status, at, what, steps } of cases) {
      const key = freshKey("settle-par");
      const ref = scriptEvidence(sw, sw.payouts.matching(factsOf(x), status));
      await failsAt(ctx, what, at, "kauro_commission_test", (conn) => reconcileOn(ctx, conn, x, status, { key, ref, steps }));
      await untouched(x);
      assert.equal(await journalState(key), null, "no journal result");
      const conn = await open("kauro_commission_test");
      try {
        completed<PayoutReconciliationView>(await reconcileOn(ctx, conn, x, status, { key, ref }), 200);
      } finally {
        await conn.end();
      }
      assert.equal(await reconciliationsOf(x), 1, "the same key settles once");
      assert.equal(await intentState(x.intent.intentId), status);
    }
  },
);
