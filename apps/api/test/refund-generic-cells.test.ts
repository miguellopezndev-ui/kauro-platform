// Lane L-REFUND: the REFUND-GENERIC-V1 failure cells (docs/design/ACH-ROUTE.md r12 §7.21 X1/X2/X4, §7.22 G2Δ/X3/NR, §7.22b-d destination
// proof, canonical fingerprint and durable execution offers, §7.28 lock order). Titles are the design's exact titles; each runs both source
// scopes (CAPTURE refund, BANK_CREDIT treasury refund) and, where the coverage table §7.22d says so, both attempt kinds (RETURN, RESEND).
// Every cell drives the REAL api over harness connections (refund-lane-support.ts `routed`): a race holds the named lock or COMMIT and
// observes the other actor waiting (template rule 1), a crash fires at the named unit's COMMIT boundary, a partial failure fails a later
// statement of the unit, an expiry moves the cell's controlled clock across the named deadline and the operation consumes it (rule 10).
// Design path note: the design names packages/persistence/test/refund-generic-cells.test.ts; the cells need the composed api and the KIT's
// bankWorld (apps/api/test), which packages/persistence cannot import, so they live here (reported to the coordinator).
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { laneTest as test } from "./refund-lane-support.js";
import type { UserId } from "@kauro/domain";
import { EFFECT_CLOCK_MARGIN_MS, LOCK_WAIT_OBSERVATION_MS, connectionPid, openConnection, runCell, type CellBody, type FaultContext, type FaultKind, type HarnessConnection } from "@kauro/persistence/testing";
import type { RouteRole, SqlStep } from "./fault-support.js";
import { paymentRoutes } from "./commerce-support.js";
import { dispatch, reconcile, storeQuery } from "./payment-support.js";
import { call, freshKey, type Reply } from "./support.js";
import {
  COLLISION_A,
  COLLISION_B,
  DEST,
  expireProofs,
  KINDS,
  L,
  SCOPES,
  SEAMS,
  SeamMissing,
  approveF2,
  approved,
  assertRefused,
  attemptRow,
  attemptsOf,
  bounced,
  cmd033,
  dataOf,
  declareX1,
  declareX4,
  declared,
  footprint,
  importSI2,
  lapsed,
  nextExecutionId,
  onFresh,
  openAttempt,
  openBank,
  ownOwner,
  ownerQueue,
  plusMs,
  q,
  recordG2,
  recipientBinding,
  recorded,
  refundOf,
  refusal,
  requested,
  resolveX3,
  reach,
  routeTiming,
  routed,
  secondRequest,
  sourceReserved,
  startLane,
  stopLane,
  storeExecution,
  sweepX2,
  valueOf,
  type AttemptView,
  type DeclareView,
  type Destination,
  type ExecutionOverrides,
  type Footprint,
  type Kind,
  type QueueItem,
  type RecordView,
  type Scope,
  type Source,
} from "./refund-lane-support.js";

before(async () => {
  await startLane();
});
after(async () => {
  await stopLane();
});

// --- cell plumbing ------------------------------------------------------------------------------------------------------------------

/** Registers a cell under the design's exact title; the harness checks the fault kind's evidence after the body (runCell). */
function cell(title: string, fault: FaultKind, body: CellBody, at?: string): void {
  test(title, async () => {
    await runCell({ id: title.split(" ")[1]!, step: title, fault, ...(at === undefined ? {} : { at }), expect: title.slice(title.indexOf(": ") + 2) }, body);
  });
}
const sameFootprint = (a: Footprint, b: Footprint): Footprint => ({ ...a, journal: b.journal });
/** A bound for lock-timeout cells derived from the harness's observation window (never a literal). */
const LOCK_TIMEOUT_MS = Math.floor(LOCK_WAIT_OBSERVATION_MS / 4);

interface Actor<T> {
  readonly role: RouteRole;
  readonly login: "kauro_payment_test" | "kauro_app_test";
  /** The command also opens a kauro_app unit (a statement import authorizes the owner as the app, then writes as the payment service): routed over both logins. */
  readonly alsoApp?: boolean;
  run(): Promise<T>;
}
const bank = <T>(run: () => Promise<T>): Actor<T> => ({ role: "kauro_payment", login: "kauro_payment_test", run });
const app = <T>(run: () => Promise<T>): Actor<T> => ({ role: "kauro_app", login: "kauro_app_test", run });
/** SI2 (CMD213): an owner command with a kauro_app authorization unit and a payment-service statement unit. */
const si2 = <T>(run: () => Promise<T>): Actor<T> => ({ role: "kauro_payment", login: "kauro_payment_test", alsoApp: true, run });

/** The holder held at `at` with its locks, the waiter observed waiting on the holder's backend, then the holder released (rule 1). */
async function hw<H, W>(ctx: FaultContext, what: string, holder: Actor<H>, waiter: Actor<W>, at = "uow.before-commit", steps: ReadonlyArray<SqlStep> = []): Promise<{ readonly held: PromiseSettledResult<H>; readonly waited: PromiseSettledResult<W> }> {
  const { iw } = L();
  const hc = await openConnection(iw.h.pg.clientConfig(holder.login));
  const wc = await openConnection(iw.h.pg.clientConfig(waiter.login));
  // a command with a kauro_app unit and a payment-service unit (SI2) takes its stream locks on the app connection: that one is observed
  const hApp = holder.alsoApp === true ? await openConnection(iw.h.pg.clientConfig("kauro_app_test")) : null;
  const wApp = waiter.alsoApp === true ? await openConnection(iw.h.pg.clientConfig("kauro_app_test")) : null;
  const routedOn = <T>(conn: HarnessConnection, appConn: HarnessConnection | null, a: Actor<T>, st: ReadonlyArray<SqlStep>): Promise<T> =>
    appConn === null ? iw.faults.on(conn, a.role, ctx.points, st, a.run, { payment: a.role === "kauro_payment" }) : iw.faults.onRoles({ kauro_payment: conn, kauro_app: appConn }, ctx.points, st, a.run, { payment: true });
  try {
    const pause = ctx.points.pause(at);
    // a bank actor's SERVICE units run on the payment service's factory: routed over the same connection (as refund-lane-support routed())
    const running = ctx.operation(`${what} (holder)`, () => routedOn(hc, hApp, holder, steps));
    const settled = running.then<PromiseSettledResult<H>, PromiseSettledResult<H>>((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    await reach(pause, running, what);
    const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wApp ?? wc, holder: connectionPid(hApp ?? hc) }, () => routedOn(wc, wApp, waiter, []), what);
    pause.release();
    return { held: await settled, waited: await waiting.pending };
  } finally {
    await hc.end();
    await wc.end();
    await hApp?.end();
    await wApp?.end();
  }
}

/** A command that must fail at `at` (a SqlStep's `.before` point) after an earlier statement of its unit completed (ctx.partial). */
async function failsAt(ctx: FaultContext, what: string, at: string, run: () => Promise<Reply>, steps: ReadonlyArray<SqlStep>, target?: number): Promise<void> {
  const { iw } = L();
  const conn = await openBank();
  try {
    await ctx.partial(what, at, async () => {
      const seen = iw.w.internalErrors.length;
      const r = await routed(ctx, conn, run, steps, target);
      if (r.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(`the unit failed: ${r.status}`);
      return r;
    });
  } finally {
    await conn.end();
  }
}

/** A refusal raised by an operation the harness must see rejected (ctx.fenced). */
class Refused extends Error {
  constructor(readonly reply: Reply) {
    super(refusal(reply));
  }
}
const asRefusal = async (p: Promise<Reply>): Promise<Reply> => {
  const r = await p;
  if (r.status >= 400) throw new Refused(r);
  return r;
};
const refusedWith = (expected: RegExp) => (e: unknown): boolean => e instanceof Refused && expected.test(e.message);

const JOURNAL_RESERVE: SqlStep = { label: "journal_reserve", match: /INSERT INTO kauro\.command_journal/ };
const REFUND_UPDATE: SqlStep = { label: "refund_update", match: /UPDATE kauro\.(refunds|treasury_refunds)\b/ };
const ATTEMPT_INSERT: SqlStep = { label: "attempt_insert", match: /INSERT INTO kauro\.outbound_execution_attempts/ };
const ATTEMPT_UPDATE: SqlStep = { label: "attempt_update", match: /UPDATE kauro\.outbound_execution_attempts/ };
const EVENT_INSERT: SqlStep = { label: "event_insert", match: /INSERT INTO kauro\.domain_events/ };
const OUTBOX_INSERT: SqlStep = { label: "outbox_insert", match: /INSERT INTO kauro\.outbox_records/ };
const AUDIT_INSERT: SqlStep = { label: "audit_insert", match: /INSERT INTO kauro\.(security_events|audit_records)/ };
const JOURNAL_FINAL: SqlStep = { label: "journal_final", match: /UPDATE kauro\.command_journal/ };
const CASE_INSERT: SqlStep = { label: "case_insert", match: /INSERT INTO kauro\.bank_review_cases/ };
const CASE_UPDATE: SqlStep = { label: "case_update", match: /UPDATE kauro\.bank_review_cases/ };
const OFFER_INSERT: SqlStep = { label: "offer_insert", match: /INSERT INTO kauro\.execution_offers\s/ };
const OUTCOME_INSERT: SqlStep = { label: "outcome_insert", match: /INSERT INTO kauro\.execution_offer_outcomes/ };
const X1_STEPS = [JOURNAL_RESERVE, REFUND_UPDATE, ATTEMPT_INSERT, AUDIT_INSERT, EVENT_INSERT, OUTBOX_INSERT, JOURNAL_FINAL];

const attemptState = async (attemptId: string): Promise<string | undefined> => (await attemptRow(attemptId))?.state;
const openCases = async (src: Source, kind: string): Promise<number> => (await footprint(src)).cases.filter(([k, s]) => k === kind && s === "OPEN").length;
/** A proof whose expiry is known: issued now on the DB clock (the policy validity is fifteen minutes; harness recordStepUp). */
async function proofExpiring(owner = L().owner): Promise<{ readonly proof: string; readonly expiresAt: string }> {
  const proof = await L().iw.h.recordStepUp(owner.userId as UserId);
  const row = (await q<{ expires_at: Date }>("SELECT expires_at FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]))[0]!;
  return { proof, expiresAt: row.expires_at.toISOString() };
}
/** Runs `fn` as an operation whose payment-service units stand on the cell's step clock (DB clock, rule 10). */
async function onClock<T>(ctx: FaultContext, what: string, fn: () => Promise<T>): Promise<T> {
  return ctx.operation(what, async (op) => {
    L().iw.faults.clock = op.clock;
    try {
      return await fn();
    } finally {
      L().iw.faults.clock = null;
    }
  });
}

// =====================================================================================================================================
// §7.21 X1 DeclareRefundExecution
// =====================================================================================================================================

cell("RACE RFG-M-X1-RACE (both orders): Declare manual refund execution", "race", async (ctx) => {
  for (const scope of SCOPES) {
    // X1 vs X1 under two keys, both orders: one declaration, the other EXECUTION_ATTEMPT_OPEN
    for (const order of ["k1 first", "k2 first"]) {
      const src = await approved(scope, `x1-race-${scope}-${order}`);
      const r = await hw(ctx, `${scope} ${order}: X1 vs X1`, bank(() => declareX1(src, { key: freshKey("x1-a") })), bank(() => declareX1(src, { key: freshKey("x1-b") })));
      assert.equal(valueOf(r.held).status, 201, `${scope} ${order}: the holder declares`);
      assertRefused(valueOf(r.waited), "409 EXECUTION_ATTEMPT_OPEN", `${scope} ${order}: the waiter`);
      assert.deepEqual((await attemptsOf(src)).map((a) => [a.kind, a.state, a.amount_cents]), [["RETURN", "DECLARED", src.totalCents.toString()]], `${scope}: one declaration of ${src.totalCents} cents`);
    }
    // X1 vs F2 second approval of the same source: the held share is never reserved twice
    // X1 vs F2 of a second refund of the same source, at the source booking lock (L2): the second approval asks one cent more than what
    // the first left and is refused; Σ reserved never exceeds the source's components
    const base = await requested(scope, `x1-race-f2-${scope}`);
    assert.equal((await approveF2(base, { serviceCents: base.serviceCents - 1n, taxCents: 0n })).status, 200, `${scope}: the first refund reserves all but one cent`);
    const first = { ...base, serviceCents: base.serviceCents - 1n, taxCents: 0n, totalCents: base.serviceCents - 1n };
    const second = await secondRequest(base);
    const raced = await hw(ctx, `${scope}: X1 holds L2, F2 of the second refund waits`, bank(() => declareX1(first)), app(() => approveF2(second, { serviceCents: 2n, taxCents: 0n })));
    assert.equal(valueOf(raced.held).status, 201);
    assertRefused(valueOf(raced.waited), "409 REFUND_EXCEEDS_REMAINING", `${scope}: the second approval cannot take the held share`);
    assert.equal(await sourceReserved(base), base.serviceCents - 1n, `${scope}: Σ reserved stays ${base.serviceCents - 1n}`);
    // vs G6 reversal: reversal first -> DOUBLE_RETURN_RISK refusal; X1 first -> the reversal opens DOUBLE_RETURN_RISK, refund stays SUBMITTING
    const reverse = (L().bw as unknown as { reverseCredit?: (id: string, cents: bigint) => Promise<void> }).reverseCredit;
    if (reverse === undefined) throw new SeamMissing("S5", SEAMS.S5);
    const g6First = await approved(scope, `x1-race-g6a-${scope}`);
    await reverse(g6First.sourceId, g6First.totalCents);
    assertRefused(await declareX1(g6First), "409 DOUBLE_RETURN_RISK", `${scope}: reversal first`);
    const x1First = await approved(scope, `x1-race-g6b-${scope}`);
    dataOf<DeclareView>(await declareX1(x1First), 201, `${scope}: X1 first`);
    await reverse(x1First.sourceId, x1First.totalCents);
    assert.equal((await refundOf(x1First))?.state, "SUBMITTING", `${scope}: authorization_lapsed never lapses a declared refund (K-6)`);
    assert.equal(await openCases(x1First, "DOUBLE_RETURN_RISK"), 1);
  }
});

cell("RACE RFG-M-X1-TIMEOUT (lock and COMMIT timeout): Declare manual refund execution", "race", async (ctx) => {
  const { iw, bw } = L();
  for (const scope of SCOPES) {
    const src = await approved(scope, `x1-timeout-${scope}`);
    const before = await footprint(src);
    const key = freshKey("x1-timeout");
    const held = await bw.holdOutboundStream();
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    try {
      const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => declareX1(src, { key })), `${scope}: X1 waiting on L1 past its statement timeout`);
      const timedOut = valueOf(await waiting.pending);
      assert.ok(timedOut.status === 503 || timedOut.status === 409, `${scope}: a retryable refusal, not a declaration: ${timedOut.text}`);
    } finally {
      iw.faults.statementTimeoutMs = null;
      await held.release();
    }
    assert.deepEqual(sameFootprint(await footprint(src), before), before, `${scope}: nothing written, ${src.totalCents} cents reserved unchanged`);
    // the lost COMMIT answer: the same key returns the one declaration
    ctx.points.crash("uow.after-commit");
    const lost = await ctx.operation(`${scope}: X1 whose COMMIT answer is lost`, () => onFresh(ctx, () => declareX1(src, { key })));
    assert.equal(lost.status, 500);
    const again = dataOf<DeclareView>(await declareX1(src, { key }), 201, `${scope}: same key`);
    assert.deepEqual((await attemptsOf(src)).map((a) => a.attempt_id), [again.attempt.attemptId], `${scope}: one declaration`);
  }
});

cell("DENY RFG-M-X1-EXPIRY (step-up and destination evidence validity): Declare manual refund execution", "expiry", async (ctx) => {
  for (const scope of SCOPES) {
    const { proof, expiresAt } = await proofExpiring();
    ctx.deadline(expiresAt, `${scope}: the step-up validity`);
    const ok = await approved(scope, `x1-expiry-ok-${scope}`);
    ctx.clock.set(plusMs(expiresAt, -1));
    dataOf<DeclareView>(await onClock(ctx, `${scope}: X1 at validity -1 ms`, () => onFresh(ctx, () => declareX1(ok, { proof }))), 201, `${scope}: -1 ms declares`);
    for (const offset of [0, 1]) {
      const src = await approved(scope, `x1-expiry-${offset}-${scope}`);
      const before = await footprint(src);
      ctx.clock.set(plusMs(expiresAt, offset));
      const r = await onClock(ctx, `${scope}: X1 at validity +${offset} ms`, () => onFresh(ctx, () => declareX1(src, { proof })));
      assertRefused(r, "403 STEP_UP_STALE", `${scope}: +${offset} ms`);
      assert.deepEqual(sameFootprint(await footprint(src), before), before, `${scope}: +${offset} ms: nothing declared`);
    }
  }
});

cell(
  "RACE RFG-M-X1-CRASH-BEFORE (crash before Kdeclare COMMIT): Declare manual refund execution",
  "crash-before-commit",
  async (ctx) => {
    for (const scope of SCOPES) {
      const src = await approved(scope, `x1-crb-${scope}`);
      const before = await footprint(src);
      ctx.points.crash("uow.before-commit");
      const r = await ctx.operation(`${scope}: X1 dying before COMMIT`, () => onFresh(ctx, () => declareX1(src)));
      assert.equal(r.status, 500);
      const after = await footprint(src);
      assert.deepEqual(sameFootprint(after, before), before, `${scope}: APPROVED, no attempt, reservation ${src.totalCents} unchanged`);
      assert.equal(after.refund?.state, "APPROVED");
      const queue = dataOf<{ items: QueueItem[] }>(await ownerQueue(), 200, "queue").items.filter((i) => i.reference.startsWith(`kauro-refund-${src.refundId}`));
      assert.deepEqual(queue, [], `${scope}: no send instructions visible`);
    }
  },
  "uow",
);

cell(
  "RACE RFG-M-X1-CRASH-AFTER (lost answer): Declare manual refund execution",
  "crash-after-commit",
  async (ctx) => {
    for (const scope of SCOPES) {
      const src = await approved(scope, `x1-cra-${scope}`);
      const key = freshKey("x1-cra");
      ctx.points.crash("uow.after-commit");
      const lost = await ctx.operation(`${scope}: X1 answer lost`, () => onFresh(ctx, () => declareX1(src, { key })));
      assert.equal(lost.status, 500);
      const [committed] = await attemptsOf(src);
      assert.equal(committed?.state, "DECLARED", `${scope}: the declaration committed`);
      const events = (await footprint(src)).events;
      assert.equal(events.filter((e) => e === "outbound.declared.v1").length, 1, `${scope}: one declaration event: ${JSON.stringify(events)}`);
      const replay = dataOf<DeclareView>(await declareX1(src, { key }), 201, `${scope}: replay`);
      assert.deepEqual([replay.attempt.attemptId, replay.attempt.reference, Date.parse(replay.attempt.declaredAt)], [committed!.attempt_id, committed!.reference, committed!.declared_at.getTime()], `${scope}: the same attempt, reference and declaredAt`);
      assert.deepEqual((await footprint(src)).events, events, `${scope}: the replay publishes nothing`);
    }
  },
  "uow",
);

cell("RACE RFG-M-X1-RETRY (replay and conflict): Declare manual refund execution", "retry", async (ctx) => {
  for (const scope of SCOPES) {
    const src = await approved(scope, `x1-retry-${scope}`);
    const key = freshKey("x1-retry");
    const first = dataOf<DeclareView>(await ctx.attempt(() => declareX1(src, { key })), 201, `${scope}: first`);
    const replay = dataOf<DeclareView>(await ctx.attempt(() => declareX1(src, { key })), 201, `${scope}: replay`);
    assert.equal(replay.attempt.attemptId, first.attempt.attemptId, `${scope}: same key, same body replays`);
    assertRefused(await ctx.attempt(() => declareX1(src, { key, amountCents: src.totalCents - 1n })), "409 BODY_CONFLICT", `${scope}: same key, other amount`);
    assertRefused(await ctx.attempt(() => declareX1(src)), "409 EXECUTION_ATTEMPT_OPEN", `${scope}: new key while DECLARED`);
    assert.equal((await attemptsOf(src)).length, 1, `${scope}: one attempt`);
  }
});

/** A write of the database owner with triggers off: a fault injected by a writer the product does not have (never a product step). */
async function forced(sql: string, params: ReadonlyArray<unknown>): Promise<void> {
  const owner = await L().iw.h.pg.connect("postgres");
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(sql, [...params]);
    await owner.query("COMMIT");
  } finally {
    await owner.end();
  }
}

test("GAP PRODUCTION-BANK-BINDING (the production composition, startApi, binds the destination fingerprinter and the credit classifier): Approve destination refund", async () => {
  // slice 4 replaces this body with the started API answering an owner approval 200 with a fingerprinted destination
  assert.fail("startApi passes no bank collaborators to assembleApi: every owner refund approval of a deploy answers 503 EVIDENCE_UNAVAILABLE");
});

/** A write of the database owner with every trigger on (a writer the product does not have); answers the SQLSTATE it failed with, or null. */
async function ownerWriteState(sql: string, params: ReadonlyArray<unknown>): Promise<string | null> {
  const owner = await L().iw.h.pg.connect("postgres");
  try {
    await owner.query(sql, [...params]);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  } finally {
    await owner.end();
  }
}

test("DENY database guard KP014, no design cell id (a DECLARED manual-rail refund written COMPLETED by a writer outside the commands): never COMPLETED without execution evidence", async () => {
  for (const scope of SCOPES) {
    const a = await openAttempt(scope, "RETURN", `kp014-${scope}`);
    const state = await ownerWriteState(
      scope === "CAPTURE"
        ? "UPDATE kauro.refunds SET state = 'COMPLETED', version = version + 1, provider_refund_id = 'forged-execution' WHERE refund_id = $1"
        : "UPDATE kauro.treasury_refunds SET state = 'COMPLETED', version = version + 1 WHERE treasury_refund_id = $1",
      [a.src.refundId],
    );
    assert.equal(state, "KP014", `${scope}: the database refuses the completion without a RECORDED attempt (EXECUTION_EVIDENCE_MISSING)`);
    assert.equal(await attemptState(a.attempt.attemptId), "DECLARED", `${scope}: the attempt is untouched`);
    if (scope === "CAPTURE") assert.equal((await refundOf(a.src))?.state, "SUBMITTING", "the refund stays SUBMITTING");
  }
});

/** X1 held at L1 while one prerequisite is withdrawn, then refused (the session arm is its own cell: the GAP of the SERVICE units). */
const x1Revocation = (arms: ReadonlyArray<string>): CellBody => async (ctx) => {
  const { iw, bw } = L();
  for (const scope of SCOPES) {
    const prerequisites: Array<{ readonly what: string; readonly revoke: (o: { person: import("./support.js").Person; grantId: string }, src: Source) => Promise<unknown>; readonly reason: RegExp }> = [
      { what: "owner grant", revoke: (o) => iw.h.revokeCorporateGrant(o.grantId), reason: /^403 / },
      { what: "verified identity", revoke: (o) => q("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [o.person.userId]), reason: /^403 / },
      { what: "session", revoke: (o) => q("UPDATE kauro.web_sessions SET revoked_at = now() WHERE user_id = $1", [o.person.userId]).catch(() => q("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [o.person.userId])), reason: /^403 / },
      { what: "step-up", revoke: (o) => expireProofs("user_id", o.person.userId), reason: /^403 / },
      // the approval stops being current: the refund leaves APPROVED (the reversal's authorization_lapsed of B09, written as its effect)
      { what: "approval current", revoke: (_o, src) => forced(src.scope === "CAPTURE" ? "UPDATE kauro.refunds SET state = 'FAILED', version = version + 1, failure_code = 'CAPTURE_REVERSED' WHERE refund_id = $1" : "UPDATE kauro.treasury_refunds SET state = 'FAILED', version = version + 1 WHERE treasury_refund_id = $1", [src.refundId]), reason: /^409 / },
      // the destination evidence withdrawn: its captured row gone
      { what: "destination evidence", revoke: (_o, src) => forced("DELETE FROM kauro.refund_destinations WHERE refund_id::text = $1 OR treasury_refund_id::text = $1", [src.refundId]), reason: /^409 DESTINATION/ },
    ];
    for (const p of prerequisites.filter((x) => arms.includes(x.what))) {
      const o = await ownOwner(`x1-revoke-${scope}-${p.what.replace(/ /g, "-")}`);
      const src = await approved(scope, `x1-revoke-${scope}-${p.what.replace(/ /g, "-")}`);
      const before = await footprint(src);
      const held = await bw.holdOutboundStream();
      try {
        const proof = await iw.w.stepUp(o.person);
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => declareX1(src, { owner: o.person, proof })), `${scope}: X1 held at L1 while the ${p.what} is withdrawn`);
        await ctx.revoked(`${scope}: ${p.what} withdrawn`, () => p.revoke(o, src));
        await held.release();
        await ctx.fenced(`${scope}: X1 after the ${p.what} was withdrawn`, () => asRefusal(waiting.pending.then(valueOf)), refusedWith(p.reason));
      } finally {
        await held.release();
      }
      assert.deepEqual((await attemptsOf(src)).length, 0, `${scope} ${p.what}: nothing declared`);
      assert.equal((await footprint(src)).events.length, before.events.length, `${scope} ${p.what}: no event`);
    }
  }
};
cell("DENY RFG-M-X1-REVOCATION (each prerequisite): Declare manual refund execution", "revocation", x1Revocation(["owner grant", "verified identity", "step-up", "approval current", "destination evidence"]));
cell("DENY RFG-M-X1-REVOCATION-SESSION (the session revoked while X1 waits at L1): Declare manual refund execution", "revocation", x1Revocation(["session"]));

cell("RACE RFG-M-X1-PARTIAL (later write fails): Declare manual refund execution", "partial", async (ctx) => {
  for (const scope of SCOPES) {
    const src = await approved(scope, `x1-partial-${scope}`);
    const before = await footprint(src);
    const key = freshKey("x1-partial");
    for (const step of [ATTEMPT_INSERT, JOURNAL_FINAL, AUDIT_INSERT, EVENT_INSERT, OUTBOX_INSERT]) {
      await failsAt(ctx, `${scope}: X1 failing at ${step.label}`, `db.${step.label}.before`, () => declareX1(src, { key }), X1_STEPS);
      const now = await footprint(src);
      assert.deepEqual(sameFootprint(now, before), before, `${scope} ${step.label}: full rollback, APPROVED, ${src.totalCents} reserved`);
    }
    dataOf<DeclareView>(await declareX1(src, { key }), 201, `${scope}: the same key then declares once`);
    assert.equal((await attemptsOf(src)).length, 1);
  }
});

// =====================================================================================================================================
// §7.21 X4 DeclareResendExecution
// =====================================================================================================================================

cell("RACE RFG-M-X4-RACE (both orders): Declare a resend execution", "race", async (ctx) => {
  for (const scope of SCOPES) {
    for (const order of ["a first", "b first"]) {
      const b = await bounced(scope, `x4-race-${scope}-${order}`);
      const r = await hw(ctx, `${scope} ${order}: X4 vs X4`, bank(() => declareX4(b.attempt, b.payableCents, { key: freshKey("x4-a") })), bank(() => declareX4(b.attempt, b.payableCents, { key: freshKey("x4-b") })));
      assert.equal(valueOf(r.held).status, 201);
      assertRefused(valueOf(r.waited), "409 EXECUTION_ATTEMPT_OPEN", `${scope} ${order}`);
      const open = (await attemptsOf(b.src)).filter((a) => a.state === "DECLARED" || a.state === "UNCERTAIN");
      assert.deepEqual(open.map((a) => [a.kind, a.amount_cents]), [["RESEND", b.payableCents.toString()]], `${scope}: one open attempt; the payable ${b.payableCents} covers one`);
    }
    // vs G4 recording the resend while a second X4 waits: the payable never covers two attempts
    const b = await bounced(scope, `x4-race-g4-${scope}`);
    const resend = dataOf<DeclareView>(await declareX4(b.attempt, b.payableCents), 201, `${scope}: X4`);
    const r = await hw(ctx, `${scope}: G4 holds, X4 waits`, bank(async () => recordG2(resend.attempt, await storeExecution(resend.attempt))), bank(() => declareX4(b.attempt, 1n)), "bank:outcome-locked");
    assert.equal(valueOf(r.held).status, 200);
    assert.equal((await attemptsOf(b.src)).find((x) => x.attempt_id === resend.attempt.attemptId)?.state, "RECORDED", `${scope}: the resend is RECORDED by G4: ${valueOf(r.held).text}`);
    assertRefused(valueOf(r.waited), "409 NO_RECORDED_BOUNCE", `${scope}: after G4 settled the payable, no bounce is open`);
  }
});

cell("RACE RFG-M-X4-TIMEOUT (lock and COMMIT timeout): Declare a resend execution", "race", async (ctx) => {
  const { iw, bw } = L();
  for (const scope of SCOPES) {
    const b = await bounced(scope, `x4-timeout-${scope}`);
    const before = await footprint(b.src);
    const key = freshKey("x4-timeout");
    const held = await bw.holdOutboundStream();
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    try {
      const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => declareX4(b.attempt, b.payableCents, { key })), `${scope}: X4 waiting on L1`);
      assert.ok(valueOf(await waiting.pending).status >= 400);
    } finally {
      iw.faults.statementTimeoutMs = null;
      await held.release();
    }
    assert.deepEqual(sameFootprint(await footprint(b.src), before), before, `${scope}: nothing`);
    dataOf<DeclareView>(await declareX4(b.attempt, b.payableCents, { key }), 201, `${scope}: the same key once`);
    dataOf<DeclareView>(await declareX4(b.attempt, b.payableCents, { key }), 201, `${scope}: replay`);
    assert.equal((await attemptsOf(b.src)).filter((a) => a.kind === "RESEND").length, 1);
  }
});

cell("DENY RFG-M-X4-EXPIRY (step-up and destination evidence validity): Declare a resend execution", "expiry", async (ctx) => {
  for (const scope of SCOPES) {
    const { proof, expiresAt } = await proofExpiring();
    ctx.deadline(expiresAt, `${scope}: step-up validity`);
    const ok = await bounced(scope, `x4-expiry-ok-${scope}`);
    ctx.clock.set(plusMs(expiresAt, -1));
    dataOf<DeclareView>(await onClock(ctx, `${scope}: -1 ms`, () => onFresh(ctx, () => declareX4(ok.attempt, ok.payableCents, { proof }))), 201, `${scope}: -1 ms declares`);
    for (const offset of [0, 1]) {
      const b = await bounced(scope, `x4-expiry-${offset}-${scope}`);
      ctx.clock.set(plusMs(expiresAt, offset));
      assertRefused(await onClock(ctx, `${scope}: +${offset} ms`, () => onFresh(ctx, () => declareX4(b.attempt, b.payableCents, { proof }))), "403 STEP_UP_STALE", `${scope}: +${offset} ms`);
      assert.equal((await attemptsOf(b.src)).filter((a) => a.kind === "RESEND").length, 0);
    }
  }
});

cell(
  "RACE RFG-M-X4-CRASH-BEFORE (crash before Kdeclareresend COMMIT): Declare a resend execution",
  "crash-before-commit",
  async (ctx) => {
    for (const scope of SCOPES) {
      const b = await bounced(scope, `x4-crb-${scope}`);
      const before = await footprint(b.src);
      ctx.points.crash("uow.before-commit");
      assert.equal((await ctx.operation(`${scope}: X4 dying`, () => onFresh(ctx, () => declareX4(b.attempt, b.payableCents)))).status, 500);
      assert.deepEqual(sameFootprint(await footprint(b.src), before), before, `${scope}: no attempt, payable ${b.payableCents} unchanged`);
      const queue = dataOf<{ items: QueueItem[] }>(await ownerQueue(), 200, "queue").items.filter((i) => i.reference.startsWith(`kauro-refund-${b.src.refundId}`));
      assert.deepEqual(queue, [], `${scope}: nothing shown to send`);
    }
  },
  "uow",
);

cell(
  "RACE RFG-M-X4-CRASH-AFTER (lost answer): Declare a resend execution",
  "crash-after-commit",
  async (ctx) => {
    for (const scope of SCOPES) {
      const b = await bounced(scope, `x4-cra-${scope}`);
      const key = freshKey("x4-cra");
      ctx.points.crash("uow.after-commit");
      assert.equal((await ctx.operation(`${scope}: X4 answer lost`, () => onFresh(ctx, () => declareX4(b.attempt, b.payableCents, { key })))).status, 500);
      const resend = (await attemptsOf(b.src)).find((a) => a.kind === "RESEND");
      assert.equal(resend?.state, "DECLARED");
      const replay = dataOf<DeclareView>(await declareX4(b.attempt, b.payableCents, { key }), 201, "replay");
      assert.equal(replay.attempt.attemptId, resend!.attempt_id, `${scope}: the replay returns the same attempt`);
      assert.equal(replay.attempt.reference, `kauro-refund-${b.src.refundId}-2`);
    }
  },
  "uow",
);

cell("RACE RFG-M-X4-RETRY (replay, conflict, open attempt): Declare a resend execution", "retry", async (ctx) => {
  for (const scope of SCOPES) {
    const b = await bounced(scope, `x4-retry-${scope}`);
    const key = freshKey("x4-retry");
    const first = dataOf<DeclareView>(await ctx.attempt(() => declareX4(b.attempt, b.payableCents, { key })), 201, "first");
    assert.equal(dataOf<DeclareView>(await ctx.attempt(() => declareX4(b.attempt, b.payableCents, { key })), 201, "replay").attempt.attemptId, first.attempt.attemptId);
    assertRefused(await ctx.attempt(() => declareX4(b.attempt, b.payableCents - 1n, { key })), "409 BODY_CONFLICT", `${scope}: other amount`);
    assertRefused(await ctx.attempt(() => declareX4(b.attempt, 1n)), "409 EXECUTION_ATTEMPT_OPEN", `${scope}: any key while DECLARED`);
    // no recorded bounce: a RECORDED attempt that never bounced
    const r = await recorded(scope, `x4-retry-nobounce-${scope}`);
    assertRefused(await ctx.attempt(() => declareX4(r.attempt, 1n)), "409 NO_RECORDED_BOUNCE", `${scope}: no bounce`);
    // amount > O
    const b2 = await bounced(scope, `x4-retry-over-${scope}`);
    assertRefused(await ctx.attempt(() => declareX4(b2.attempt, b2.payableCents + 1n)), "409 RESEND_EXCEEDS_PAYABLE", `${scope}: ${b2.payableCents + 1n} > O = ${b2.payableCents}`);
    assert.equal((await attemptsOf(b2.src)).filter((a) => a.kind === "RESEND").length, 0);
  }
});

cell("DENY RFG-M-X4-REVOCATION (each prerequisite): Declare a resend execution", "revocation", async (ctx) => {
  const { iw, bw } = L();
  for (const scope of SCOPES) {
    for (const what of ["grant", "identity", "session", "step-up", "destination evidence"]) {
      const o = await ownOwner(`x4-revoke-${scope}-${what.replace(/ /g, "-")}`);
      const b = await bounced(scope, `x4-revoke-${scope}-${what.replace(/ /g, "-")}`);
      const held = await bw.holdOutboundStream();
      try {
        const proof = await iw.w.stepUp(o.person);
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => declareX4(b.attempt, b.payableCents, { owner: o.person, proof })), `${scope}: X4 held at L1`);
        await ctx.revoked(`${scope}: ${what}`, async () => {
          if (what === "grant") await iw.h.revokeCorporateGrant(o.grantId);
          else if (what === "identity" || what === "session") await q("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [o.person.userId]);
          else if (what === "step-up") await expireProofs("proof_id", proof);
          else await q("DELETE FROM kauro.refund_destinations WHERE refund_id::text = $1 OR treasury_refund_id::text = $1", [b.src.refundId]);
        });
        await held.release();
        await ctx.fenced(`${scope}: X4 after ${what}`, () => asRefusal(waiting.pending.then(valueOf)), refusedWith(/^(403|409) /));
      } finally {
        await held.release();
      }
      assert.equal((await attemptsOf(b.src)).filter((a) => a.kind === "RESEND").length, 0, `${scope} ${what}: refused, nothing declared`);
    }
  }
});

cell("RACE RFG-M-X4-PARTIAL (later write fails): Declare a resend execution", "partial", async (ctx) => {
  for (const scope of SCOPES) {
    const b = await bounced(scope, `x4-partial-${scope}`);
    const before = await footprint(b.src);
    const key = freshKey("x4-partial");
    for (const step of [JOURNAL_FINAL, AUDIT_INSERT, EVENT_INSERT, OUTBOX_INSERT]) {
      await failsAt(ctx, `${scope}: X4 failing at ${step.label}`, `db.${step.label}.before`, () => declareX4(b.attempt, b.payableCents, { key }), [JOURNAL_RESERVE, ATTEMPT_INSERT, AUDIT_INSERT, EVENT_INSERT, OUTBOX_INSERT, JOURNAL_FINAL]);
      assert.deepEqual(sameFootprint(await footprint(b.src), before), before, `${scope} ${step.label}: rollback, payable ${b.payableCents} unchanged`);
    }
  }
});

// =====================================================================================================================================
// §7.21 X2 Kexecwindow sweep
// =====================================================================================================================================

async function windowEdge(ctx: FaultContext, attempt: AttemptView, offsetMs: number, what: string): Promise<void> {
  const boundary = plusMs(attempt.declaredAt, routeTiming().manualExecutionWindowMs);
  // the controlled clock never moves backwards: a cell looping its legs may already stand past this edge
  ctx.clock.set(new Date(Math.max(Date.parse(plusMs(boundary, offsetMs)), ctx.clock.nowMs())));
  await onClock(ctx, what, () => sweepX2());
}

/** An X2 cell over both kinds (the full cell, slice 3: RESEND attempts come from X4) and its RETURN legs as their own cell (slice 2). */
function x2Cell(title: string, fault: FaultKind, body: (kinds: ReadonlyArray<Kind>) => CellBody, at?: string): void {
  cell(title, fault, body(KINDS), at);
  const [verb, id, ...rest] = title.split(" ");
  cell(`${verb} [${id}] RETURN legs (slice 2): ${rest.join(" ")}`, fault, body(["RETURN"]), at);
}

x2Cell("RACE RFG-M-X2-RACE (both orders): Lapse manual execution window", "race", (kinds) => async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of kinds) {
      // record first: the pass skips RECORDED
      const a = await openAttempt(scope, kind, `x2-race-rec-${scope}-${kind}`);
      const boundary = plusMs(a.attempt.declaredAt, routeTiming().manualExecutionWindowMs);
      ctx.deadline(boundary, `${scope} ${kind} window`);
      ctx.clock.past(boundary);
      const recordFirst = await hw(ctx, `${scope} ${kind}: G2 holds the attempt row, X2 waits`, bank(() => onClock(ctx, "G2", async () => recordG2(a.attempt, await storeExecution(a.attempt)))), bank(() => onClock(ctx, "X2 pass", () => sweepX2())));
      assert.equal(valueOf(recordFirst.held).status, 200);
      assert.equal(await attemptState(a.attempt.attemptId), "RECORDED", `${scope} ${kind}: the pass skips RECORDED`);
      assert.equal(await openCases(a.src, "UNCERTAIN_EFFECT"), 0);
      // pass first: UNCERTAIN, then the record completes once and the case becomes EXPLAINED
      const b = await openAttempt(scope, kind, `x2-race-pass-${scope}-${kind}`);
      ctx.clock.past(plusMs(b.attempt.declaredAt, routeTiming().manualExecutionWindowMs));
      const passFirst = await onClock(ctx, "X2 pass and G2 on one step clock", () => hw(ctx, `${scope} ${kind}: X2 holds, G2 waits`, bank(() => sweepX2()), bank(async () => recordG2(b.attempt, await storeExecution(b.attempt)))));
      valueOf(passFirst.held);
      assert.equal(valueOf(passFirst.waited).status, 200, `${scope} ${kind}: the record completes the UNCERTAIN attempt`);
      assert.equal(await attemptState(b.attempt.attemptId), "RECORDED");
      const cases = (await footprint(b.src)).cases.filter(([k]) => k === "UNCERTAIN_EFFECT");
      assert.deepEqual(cases, [["UNCERTAIN_EFFECT", "RESOLVED"]], `${scope} ${kind}: one case, EXPLAINED`);
      if (kind === "RETURN") assert.equal((await footprint(b.src)).events.filter((e) => e.endsWith("refund.completed.v1")).length, 1, "completed once");
    }
});

x2Cell("RACE RFG-M-X2-TIMEOUT (statement timeout): Lapse manual execution window", "race", (kinds) => async (ctx) => {
  const { iw, bw } = L();
  for (const scope of SCOPES)
    for (const kind of kinds) {
      const a = await openAttempt(scope, kind, `x2-timeout-${scope}-${kind}`);
      ctx.clock.past(plusMs(a.attempt.declaredAt, routeTiming().manualExecutionWindowMs));
      const held = await bw.holdAttemptRow(a.attempt.attemptId);
      iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
      try {
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => onClock(ctx, "X2 pass", () => sweepX2())), `${scope} ${kind}: X2 waiting on the attempt row`);
        await waiting.pending;
      } finally {
        iw.faults.statementTimeoutMs = null;
        await held.release();
      }
      assert.equal(await attemptState(a.attempt.attemptId), "DECLARED", `${scope} ${kind}: nothing written by the timed-out pass`);
      assert.equal(await openCases(a.src, "UNCERTAIN_EFFECT"), 0);
      await onClock(ctx, "next pass", () => sweepX2());
      await onClock(ctx, "a further pass", () => sweepX2());
      assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN", `${scope} ${kind}: the next pass lapses it`);
      assert.equal(await openCases(a.src, "UNCERTAIN_EFFECT"), 1, `${scope} ${kind}: once`);
    }
});

x2Cell("RACE RFG-M-X2-EXPIRY (window boundary): Lapse manual execution window", "expiry", (kinds) => async (ctx) => {
  // the admit leg stands the harness margin before the boundary: the effect clock (kauro.effect_now(), rounded up to the millisecond) runs
  // on with the pass's transaction, so a -1 ms stand would be judged at or past the boundary. Every attempt is declared first (at the real
  // database clock) and the legs are judged in the order of their instants, since the controlled clock never moves backwards: a pass at an
  // earlier instant cannot lapse a later leg's attempt before that leg (its boundary is past every earlier instant)
  const OFFSETS = [-EFFECT_CLOCK_MARGIN_MS, 0, 1] as const;
  for (const kind of kinds) {
    const legs: { scope: Scope; offset: number; src: Source; attempt: AttemptView; at: number }[] = [];
    for (const scope of SCOPES)
      for (const offset of OFFSETS) {
        const a = await openAttempt(scope, kind, `x2-expiry-${offset}-${scope}-${kind}`);
        legs.push({ scope, offset, ...a, at: Date.parse(plusMs(a.attempt.declaredAt, routeTiming().manualExecutionWindowMs)) + offset });
      }
    const states = new Map<string, string[]>(SCOPES.map((sc) => [sc, []]));
    for (const leg of [...legs].sort((x, y) => x.at - y.at)) {
      const { scope, offset, src, attempt } = leg;
      if (offset === 0) ctx.deadline(plusMs(attempt.declaredAt, routeTiming().manualExecutionWindowMs), `${scope} ${kind}: declaredAt + window`);
      await windowEdge(ctx, attempt, offset, `${scope} ${kind}: X2 at window ${offset} ms`);
      states.get(scope)!.push(`${offset}:${await attemptState(attempt.attemptId)}`);
      if (offset >= 0 && kind === "RETURN") assert.equal((await refundOf(src))?.state, "UNCERTAIN");
      if (offset >= 0) assert.equal(await sourceReserved(src), src.totalCents, "the share stays held");
    }
    for (const scope of SCOPES) assert.deepEqual(states.get(scope), [`${-EFFECT_CLOCK_MARGIN_MS}:DECLARED`, "0:UNCERTAIN", "1:UNCERTAIN"], `${scope} ${kind}: DB-clock boundary`);
  }
});

x2Cell(
  "RACE RFG-M-X2-CRASH-BEFORE (crash before Kexecwindow COMMIT): Lapse manual execution window",
  "crash-before-commit",
  (kinds) => async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of kinds) {
        const a = await openAttempt(scope, kind, `x2-crb-${scope}-${kind}`);
        ctx.clock.past(plusMs(a.attempt.declaredAt, routeTiming().manualExecutionWindowMs));
        ctx.points.crash("uow.before-commit");
        await ctx.operation(`${scope} ${kind}: X2 dying before COMMIT`, (op) => onFresh(ctx, async () => { L().iw.faults.clock = op.clock; try { await sweepX2(); } finally { L().iw.faults.clock = null; } }).catch(() => undefined));
        assert.equal(await attemptState(a.attempt.attemptId), "DECLARED", `${scope} ${kind}: DECLARED`);
        assert.equal(await openCases(a.src, "UNCERTAIN_EFFECT"), 0, "no case");
      }
  },
  "uow",
);

x2Cell(
  "RACE RFG-M-X2-CRASH-AFTER (lost settle): Lapse manual execution window",
  "crash-after-commit",
  (kinds) => async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of kinds) {
        const a = await openAttempt(scope, kind, `x2-cra-${scope}-${kind}`);
        ctx.clock.past(plusMs(a.attempt.declaredAt, routeTiming().manualExecutionWindowMs));
        ctx.points.crash("uow.after-commit");
        await ctx.operation(`${scope} ${kind}: X2 settle lost`, (op) => onFresh(ctx, async () => { L().iw.faults.clock = op.clock; try { await sweepX2(); } finally { L().iw.faults.clock = null; } }).catch(() => undefined));
        assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN");
        const events = (await footprint(a.src)).events.length;
        await onClock(ctx, "the next pass", () => sweepX2());
        assert.equal(await openCases(a.src, "UNCERTAIN_EFFECT"), 1, `${scope} ${kind}: no second case`);
        assert.equal((await footprint(a.src)).events.length, events, `${scope} ${kind}: no second event`);
      }
  },
  "uow",
);

x2Cell("RACE RFG-M-X2-RETRY (two sweepers and redelivery): Lapse manual execution window", "race", (kinds) => async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of kinds) {
      const a = await openAttempt(scope, kind, `x2-retry-${scope}-${kind}`);
      ctx.clock.past(plusMs(a.attempt.declaredAt, routeTiming().manualExecutionWindowMs));
      const r = await hw(ctx, `${scope} ${kind}: two sweepers`, bank(() => onClock(ctx, "sweeper 1", () => sweepX2())), bank(() => onClock(ctx, "sweeper 2", () => sweepX2())));
      valueOf(r.held);
      valueOf(r.waited);
      assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN");
      assert.equal(await openCases(a.src, "UNCERTAIN_EFFECT"), 1, `${scope} ${kind}: one transition, one case`);
      await dispatch(L().iw.pw, "FINANCE");
      assert.equal(await openCases(a.src, "UNCERTAIN_EFFECT"), 1, "redelivery adds nothing");
    }
});

x2Cell("RACE RFG-M-X2-REVOCATION (route disabled, owner revoked, lease lost): Lapse manual execution window", "revocation", (kinds) => async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of kinds) {
      const o = await ownOwner(`x2-revoke-${scope}-${kind}`);
      const a = await openAttempt(scope, kind, `x2-revoke-${scope}-${kind}`);
      ctx.deadline(plusMs(a.attempt.declaredAt, routeTiming().manualExecutionWindowMs), `${scope} ${kind}: window`);
      await ctx.revoked(`${scope} ${kind}: the declaring owner's grant`, () => L().iw.h.revokeCorporateGrant(o.grantId));
      await windowEdge(ctx, a.attempt, 1, `${scope} ${kind}: X2 after revocation`);
      assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN", `${scope} ${kind}: still UNCERTAIN`);
      assert.equal(await sourceReserved(a.src), a.src.totalCents, `${scope} ${kind}: ${a.src.totalCents} never released`);
      // the revoked owner cannot release the held share either
      await ctx.fenced(`${scope} ${kind}: the revoked owner's NOT_EXECUTED`, () => asRefusal(resolveX3(a.attempt, "NOT_EXECUTED", null, { owner: o.person })), refusedWith(/^403 /));
      assert.equal(await sourceReserved(a.src), a.src.totalCents, `${scope} ${kind}: still ${a.src.totalCents} held`);
    }
});

x2Cell("RACE RFG-M-X2-PARTIAL (case insert fails): Lapse manual execution window", "partial", (kinds) => async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of kinds) {
      const a = await openAttempt(scope, kind, `x2-partial-${scope}-${kind}`);
      ctx.clock.past(plusMs(a.attempt.declaredAt, routeTiming().manualExecutionWindowMs));
      const conn = await openBank();
      try {
        await ctx.partial(`${scope} ${kind}: X2 failing at its case insert`, "db.case_insert.before", () => ctx.operation("X2", (op) => routed(ctx, conn, async () => { L().iw.faults.clock = op.clock; try { await sweepX2(); } finally { L().iw.faults.clock = null; } return null; }, [ATTEMPT_UPDATE, CASE_INSERT])));
      } finally {
        await conn.end();
      }
      assert.equal(await attemptState(a.attempt.attemptId), "DECLARED", `${scope} ${kind}: rollback, DECLARED`);
      assert.equal(await openCases(a.src, "UNCERTAIN_EFFECT"), 0);
    }
});

// =====================================================================================================================================
// §7.22 X3 ResolveUncertainExecution
// =====================================================================================================================================

/** A statement artifact covering the outbound stream from `from` to `to` with the given debits (CONTRACT_FAKE). */
async function statementWith(from: string, to: string, debits: ReadonlyArray<{ debitId?: string; amountCents: bigint; reference?: string | null; bankExecutionId?: string | null; full?: Destination | null; accountLast4?: string | null; recipientRef?: string | null; currency?: string; executedAt?: string }>) {
  return L().bw.storeStatement({
    coverageStart: from,
    coverageEnd: to,
    credits: [],
    debits: debits.map((d, i) => ({
      debitId: d.debitId ?? `debit-${Date.now()}-${i}-${Math.random().toString(16).slice(2, 8)}`,
      bankExecutionId: d.bankExecutionId ?? null,
      amountCents: d.amountCents,
      currency: d.currency ?? "USD",
      reference: d.reference ?? null,
      executedAt: d.executedAt ?? to,
      destination: { full: d.full ?? null, accountLast4: d.accountLast4 ?? null, recipientRef: d.recipientRef ?? null },
      status: "COMPLETED",
      observedAt: to,
    })),
  });
}
/** Moves the cell's clock past declaredAt + window + coverageLag and imports a contiguous outbound coverage up to effectNow − lag. */
async function coveredForNx(ctx: FaultContext, attempt: AttemptView, debits: Parameters<typeof statementWith>[2] = []): Promise<void> {
  const { manualExecutionWindowMs, coverageLagMs } = routeTiming();
  const nx = plusMs(attempt.declaredAt, manualExecutionWindowMs + coverageLagMs);
  ctx.clock.set(new Date(Math.max(Date.parse(nx), ctx.clock.nowMs())));
  // the coverage ends the harness margin past effectNow − lag: X3's effect clock runs on with its transaction (kauro.effect_now(), 0038)
  // its debits stand inside the judged interval [declaredAt, effectNow − lag] (at the clock − lag unless the cell places them)
  const judged = plusMs(ctx.clock.now(), -coverageLagMs);
  const stmt = await statementWith(plusMs(attempt.declaredAt, -60_000), plusMs(ctx.clock.now(), EFFECT_CLOCK_MARGIN_MS - coverageLagMs), debits.map((d) => ({ executedAt: judged, ...d })));
  // SI2 judges COVERAGE_END_IN_FUTURE at its effect instant: it imports on the cell clock the coverage ends behind
  const r = await onClock(ctx, "SI2 imports the coverage", () => importSI2(stmt));
  assert.equal(r.status, 201, `SI2 imports the coverage: ${r.text}`);
}

cell("RACE RFG-M-X3-RACE (both orders): Resolve uncertain execution", "race", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      // SI2 importing a potentially matching debit first: NOT_EXECUTED refused UNEXPLAINED_DEBIT (DV1-10 r9 replaced POTENTIAL_MATCH_UNRESOLVED), attempt UNCERTAIN
      const a = await lapsed(ctx, scope, kind, `x3-race-si2-${scope}-${kind}`);
      const { coverageLagMs } = routeTiming();
      ctx.clock.past(plusMs(a.attempt.declaredAt, routeTiming().manualExecutionWindowMs + coverageLagMs));
      const stmt = await statementWith(plusMs(a.attempt.declaredAt, -60_000), plusMs(ctx.clock.now(), -coverageLagMs), [{ amountCents: BigInt(a.attempt.amountCents), executedAt: plusMs(a.attempt.declaredAt, 1) }]);
      const si2First = await onClock(ctx, "SI2-first race", () => hw(ctx, `${scope} ${kind}: SI2 holds L1, X3 waits`, si2(() => importSI2(stmt)), bank(() => resolveX3(a.attempt, "NOT_EXECUTED", null)), "bank:statement-locked"));
      assert.equal(valueOf(si2First.held).status, 201);
      assertRefused(valueOf(si2First.waited), "409 UNEXPLAINED_DEBIT", `${scope} ${kind}: SI2 first`);
      assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN");
      // X3 first: NOT_EXECUTED commits, the import then opens REFUND_TERMINAL_CONTRADICTED with the debit orphaned
      const b = await lapsed(ctx, scope, kind, `x3-race-x3-${scope}-${kind}`);
      await coveredForNx(ctx, b.attempt);
      const stmt2 = await statementWith(plusMs(b.attempt.declaredAt, -60_000), plusMs(ctx.clock.now(), -coverageLagMs), [{ amountCents: BigInt(b.attempt.amountCents), reference: b.attempt.reference, executedAt: plusMs(b.attempt.declaredAt, 1) }]);
      const x3First = await onClock(ctx, "X3-first race", () => hw(ctx, `${scope} ${kind}: X3 holds L1, SI2 waits`, bank(() => resolveX3(b.attempt, "NOT_EXECUTED", null)), si2(() => importSI2(stmt2))));
      assert.equal(valueOf(x3First.held).status, 200);
      assert.equal(valueOf(x3First.waited).status, 201, `${scope} ${kind}: SI2 imports after X3: ${valueOf(x3First.waited).text}`);
      assert.equal(await attemptState(b.attempt.attemptId), "NOT_EXECUTED", "no committed fact changes");
      assert.equal(await openCases(b.src, "REFUND_TERMINAL_CONTRADICTED"), 1, `${scope} ${kind}: the later evidence opens REFUND_TERMINAL_CONTRADICTED`);
      // vs G2: G2 first -> X3 REFUND_NOT_UNCERTAIN
      const c = await lapsed(ctx, scope, kind, `x3-race-g2-${scope}-${kind}`);
      const g2First = await hw(ctx, `${scope} ${kind}: G2 holds, X3 waits`, bank(async () => recordG2(c.attempt, await storeExecution(c.attempt))), bank(() => resolveX3(c.attempt, "NOT_EXECUTED", null)), "bank:outcome-locked");
      assert.equal(valueOf(g2First.held).status, 200);
      assertRefused(valueOf(g2First.waited), "409 REFUND_NOT_UNCERTAIN", `${scope} ${kind}: G2 first`);
    }
});

cell("RACE RFG-M-X3-TIMEOUT (lock and COMMIT timeout): Resolve uncertain execution", "race", async (ctx) => {
  const { iw, bw } = L();
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await lapsed(ctx, scope, kind, `x3-timeout-${scope}-${kind}`);
      const receipt = await storeExecution(a.attempt);
      const key = freshKey("x3-timeout");
      const before = await footprint(a.src);
      const held = await bw.holdOutboundStream();
      iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
      try {
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => resolveX3(a.attempt, "EXECUTED", receipt, { key })), `${scope} ${kind}: X3 waiting on L1`);
        assert.ok(valueOf(await waiting.pending).status >= 400);
      } finally {
        iw.faults.statementTimeoutMs = null;
        await held.release();
      }
      assert.deepEqual(sameFootprint(await footprint(a.src), before), before, `${scope} ${kind}: nothing resolved, ${a.src.totalCents} cents held`);
      dataOf<RecordView>(await resolveX3(a.attempt, "EXECUTED", receipt, { key }), 200, "same key once");
      dataOf<RecordView>(await resolveX3(a.attempt, "EXECUTED", receipt, { key }), 200, "replay");
      assert.equal(await attemptState(a.attempt.attemptId), "RECORDED");
    }
});

cell("DENY RFG-M-X3-EXPIRY (coverage lag and step-up): Resolve uncertain execution", "expiry", async (ctx) => {
  // the controlled clock never moves backwards and an attempt is declared on the real clock: every leg is declared and lapsed first, then the
  // boundaries are judged in the order of their instants (declaredAt + window + coverageLag), each one harness margin before (the effect clock runs on with the transaction, so an exact -1 ms is not observable) and then at 0 ms
  const { manualExecutionWindowMs, coverageLagMs } = routeTiming();
  const legs: Array<{ readonly scope: Scope; readonly kind: Kind; readonly a: Awaited<ReturnType<typeof lapsed>> }> = [];
  for (const scope of SCOPES)
    for (const kind of KINDS) legs.push({ scope, kind, a: await lapsed(ctx, scope, kind, `x3-expiry-${scope}-${kind}`) });
  legs.sort((x, y) => Date.parse(x.a.attempt.declaredAt) - Date.parse(y.a.attempt.declaredAt));
  for (const { scope, kind, a } of legs) {
    const nx = plusMs(a.attempt.declaredAt, manualExecutionWindowMs + coverageLagMs);
    ctx.clock.set(new Date(Math.max(Date.parse(plusMs(nx, -EFFECT_CLOCK_MARGIN_MS)), ctx.clock.nowMs())));
    assert.ok(ctx.clock.nowMs() < Date.parse(nx), `${scope} ${kind}: the clock still stands before the instant`);
    assertRefused(await onClock(ctx, `${scope} ${kind}: NOT_EXECUTED at nx -1 ms`, () => resolveX3(a.attempt, "NOT_EXECUTED", null)), "409 NOT_EXECUTED_TOO_EARLY", `${scope} ${kind}: -1 ms`);
    ctx.deadline(nx, `${scope} ${kind}: declaredAt + window + coverageLag`);
    ctx.clock.set(new Date(Math.max(Date.parse(nx), ctx.clock.nowMs())));
    const r = await onClock(ctx, `${scope} ${kind}: NOT_EXECUTED at nx 0 ms`, () => resolveX3(a.attempt, "NOT_EXECUTED", null));
    assert.ok(r.status === 200 || refusal(r) === "409 COVERAGE_INCOMPLETE", `${scope} ${kind}: at the boundary the lag predicate holds: ${r.text}`);
  }
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await lapsed(ctx, scope, kind, `x3-expiry-stale-${scope}-${kind}`);
      assertRefused(await resolveX3(a.attempt, "EXECUTED", await storeExecution(a.attempt), { stepUp: "STALE" }), "403 STEP_UP_STALE", `${scope} ${kind}: stale step-up`);
    }
});

cell(
  "RACE RFG-M-X3-CRASH-BEFORE (crash before Kresolve COMMIT): Resolve uncertain execution",
  "crash-before-commit",
  async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of KINDS) {
        const a = await lapsed(ctx, scope, kind, `x3-crb-${scope}-${kind}`);
        const receipt = await storeExecution(a.attempt);
        ctx.points.crash("target.before-commit");
        await ctx.operation(`${scope} ${kind}: X3 dying before the outcome COMMIT`, () => onFresh(ctx, () => resolveX3(a.attempt, "EXECUTED", receipt), [], 2));
        assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN", `${scope} ${kind}: UNCERTAIN`);
        assert.equal(await sourceReserved(a.src), a.src.totalCents, "share held");
        assert.equal(await openCases(a.src, "UNCERTAIN_EFFECT"), 1, "case OPEN");
        assert.equal((await q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.security_events WHERE action = 'ResolveUncertainExecution' AND outcome = 'ALLOW' AND subject_id::text = $1", [a.attempt.attemptId]).catch(() => [{ n: "0" }]))[0]!.n, "0", "no audit row");
      }
  },
  "target",
);

cell(
  "RACE RFG-M-X3-CRASH-AFTER (lost answer): Resolve uncertain execution",
  "crash-after-commit",
  async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of KINDS) {
        const a = await lapsed(ctx, scope, kind, `x3-cra-${scope}-${kind}`);
        const receipt = await storeExecution(a.attempt);
        const key = freshKey("x3-cra");
        ctx.points.crash("target.after-commit");
        await ctx.operation(`${scope} ${kind}: X3 answer lost`, () => onFresh(ctx, () => resolveX3(a.attempt, "EXECUTED", receipt, { key }), [], 2));
        assert.equal(await attemptState(a.attempt.attemptId), "RECORDED");
        const events = (await footprint(a.src)).events.length;
        const replay = dataOf<RecordView>(await resolveX3(a.attempt, "EXECUTED", receipt, { key }), 200, "replay");
        assert.equal(replay.attempt.state, "RECORDED", `${scope} ${kind}: the replay returns the outcome`);
        assert.equal((await footprint(a.src)).events.length, events, `${scope} ${kind}: one event`);
      }
  },
  "target",
);

cell("RACE RFG-M-X3-RETRY (replay and conflict): Resolve uncertain execution", "retry", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await lapsed(ctx, scope, kind, `x3-retry-${scope}-${kind}`);
      const receipt = await storeExecution(a.attempt);
      const key = freshKey("x3-retry");
      dataOf<RecordView>(await ctx.attempt(() => resolveX3(a.attempt, "EXECUTED", receipt, { key })), 200, "first");
      dataOf<RecordView>(await ctx.attempt(() => resolveX3(a.attempt, "EXECUTED", receipt, { key })), 200, "identical replay");
      assertRefused(await ctx.attempt(() => resolveX3(a.attempt, "NOT_EXECUTED", null, { key })), "409 BODY_CONFLICT", `${scope} ${kind}: other outcome`);
      assertRefused(await ctx.attempt(async () => resolveX3(a.attempt, "EXECUTED", await storeExecution(a.attempt, { bankExecutionId: nextExecutionId("x3-other") }), { key })), "409 BODY_CONFLICT", `${scope} ${kind}: other execution id / evidence`);
      assert.equal((await footprint(a.src)).events.filter((e) => e.endsWith("refund.completed.v1")).length, 1, "the refund completed once, with its RETURN");
    }
});

cell("DENY RFG-M-X3-REVOCATION (owner authority, both orders): Resolve uncertain execution", "revocation", async (ctx) => {
  const { iw, bw } = L();
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await lapsed(ctx, scope, kind, `x3-revoke-${scope}-${kind}`);
      const receipt = await storeExecution(a.attempt);
      // non-owner and no step-up
      const agencyOwner = iw.w.owner;
      assertRefused(await resolveX3(a.attempt, "EXECUTED", receipt, { owner: agencyOwner }), "403 CORPORATE_ROLE_MISSING", `${scope} ${kind}: non-owner`);
      // owner revoked at the membership half, both orders: revocation first refuses; X3 first commits before the revocation
      const o = await ownOwner(`x3-revoke-${scope}-${kind}`);
      const held = await bw.holdOutboundStream();
      try {
        const proof = await iw.w.stepUp(o.person);
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => resolveX3(a.attempt, "EXECUTED", receipt, { owner: o.person, proof })), `${scope} ${kind}: X3 held at L1`);
        await ctx.revoked(`${scope} ${kind}: the owner's grant`, () => iw.h.revokeCorporateGrant(o.grantId));
        await held.release();
        await ctx.fenced(`${scope} ${kind}: X3 after the revocation`, () => asRefusal(waiting.pending.then(valueOf)), refusedWith(/^403 /));
      } finally {
        await held.release();
      }
      assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN", `${scope} ${kind}: NOT_AUTHORIZED, nothing resolved`);
    }
});

cell("RACE RFG-M-X3-PARTIAL (audit insert fails): Resolve uncertain execution", "partial", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await lapsed(ctx, scope, kind, `x3-partial-${scope}-${kind}`);
      await coveredForNx(ctx, a.attempt);
      const before = await footprint(a.src);
      await failsAt(ctx, `${scope} ${kind}: X3 NOT_EXECUTED failing at its audit insert`, "db.audit_insert.before", () => onClock(ctx, "X3", () => resolveX3(a.attempt, "NOT_EXECUTED", null)), [ATTEMPT_UPDATE, REFUND_UPDATE, CASE_UPDATE, AUDIT_INSERT]);
      assert.deepEqual(sameFootprint(await footprint(a.src), before), before, `${scope} ${kind}: attempt, refund, case, share (${a.src.totalCents}), money source and events rolled back`);
    }
});

// =====================================================================================================================================
// §7.22 NR, G2Δ
// =====================================================================================================================================

cell("DENY RFG-M-NR-RACE (every entry point): NEVER-RESEND while an execution attempt is DECLARED or UNCERTAIN", "race", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const key = freshKey("nr");
      const a = kind === "RETURN" ? await (async () => { const src = await approved(scope, `nr-${scope}-${kind}`); const v = dataOf<DeclareView>(await declareX1(src, { key }), 201, "X1"); return { src, attempt: v.attempt }; })() : await openAttempt(scope, kind, `nr-${scope}-${kind}`);
      for (const phase of ["DECLARED", "UNCERTAIN"]) {
        if (phase === "UNCERTAIN") await windowEdge(ctx, a.attempt, 1, `${scope} ${kind}: lapse`);
        assert.equal(await attemptState(a.attempt.attemptId), phase);
        if (kind === "RETURN") {
          assertRefused(await declareX1(a.src), "409 EXECUTION_ATTEMPT_OPEN", `${scope} ${phase}: X1 new key`);
          assert.equal(dataOf<DeclareView>(await declareX1(a.src, { key }), 201, "X1 replay").attempt.attemptId, a.attempt.attemptId, `${scope} ${phase}: X1 replay returns the one attempt`);
          assertRefused(await cmd033(a.src, (await refundOf(a.src))!.version), "409 MANUAL_RAIL_NO_AUTOMATED_OUTBOUND", `${scope} ${phase}: CMD033`);
        } else {
          assertRefused(await declareX4({ ...a.attempt, attemptId: (await attemptsOf(a.src))[0]!.attempt_id }, 1n), "409 EXECUTION_ATTEMPT_OPEN", `${scope} ${phase}: X4 new key`);
        }
        assert.equal(await sourceReserved(a.src), a.src.totalCents, `${scope} ${kind} ${phase}: a second approval cannot reserve the held share`);
        const items = dataOf<{ items: QueueItem[] }>(await ownerQueue(), 200, "queue").items.filter((i) => i.attemptId === a.attempt.attemptId);
        assert.equal(items.length, phase === "DECLARED" ? 1 : 0, `${scope} ${kind} ${phase}: send details only for the one DECLARED attempt`);
        const before = (await attemptsOf(a.src)).length;
        await dispatch(L().iw.pw, "FINANCE");
        await dispatch(L().iw.pw, "FISCAL");
        await sweepX2();
        assert.equal((await attemptsOf(a.src)).length, before, `${scope} ${kind} ${phase}: X2 and every refund.* consumer redelivery emit no instruction`);
      }
      // G4 without a DECLARED/UNCERTAIN RESEND attempt: refused (a RECORDED RETURN that never bounced)
      const r = await recorded(scope, `nr-g4-${scope}-${kind}`);
      assert.ok((await recordG2(r.attempt, await storeExecution(r.attempt))).status >= 400, "a record of a RECORDED attempt is no resend");
    }
  // the interleavings themselves are the X1/X4/X2/X3 RACE cells (rule 1); one observed wait here: X1 vs X1 at L1
  const src = await approved("CAPTURE", "nr-wait");
  const r = await hw(ctx, "NR: X1 vs X1", bank(() => declareX1(src)), bank(() => declareX1(src)));
  assert.equal(valueOf(r.held).status, 201);
  assertRefused(valueOf(r.waited), "409 EXECUTION_ATTEMPT_OPEN", "the waiter");
});

cell("RACE RFG-M-G2D-RACE (both orders): Record a declared execution", "race", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS)
      for (const order of ["G2 first", "SI2 first"]) {
        const a = await openAttempt(scope, kind, `g2d-race-${scope}-${kind}-${order}`);
        const executionId = nextExecutionId("g2d");
        const receipt = await storeExecution(a.attempt, { bankExecutionId: executionId });
        const stmt = await statementWith(plusMs(a.attempt.declaredAt, -60_000), plusMs(a.attempt.declaredAt, 60_000), [{ amountCents: BigInt(a.attempt.amountCents), bankExecutionId: executionId, reference: a.attempt.reference, full: DEST }]);
        const g2 = bank(() => recordG2(a.attempt, receipt));
        const si2 = bank(() => importSI2(stmt));
        const r = order === "G2 first" ? await hw(ctx, `${scope} ${kind} ${order}`, g2, si2, "uow.before-commit") : await hw(ctx, `${scope} ${kind} ${order}`, si2, g2);
        valueOf(r.held);
        valueOf(r.waited);
        assert.equal(await attemptState(a.attempt.attemptId), "RECORDED", `${scope} ${kind} ${order}: one RECORDED attempt`);
        assert.equal((await q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.statement_lines WHERE linked_attempt_id = $1", [a.attempt.attemptId]))[0]!.n, "1", "one link");
        if (kind === "RETURN") assert.equal((await footprint(a.src)).events.filter((e) => e.endsWith("refund.completed.v1")).length, 1, "one refund.completed");
      }
  // X3 vs G2 linking the same debit is RFG-M-X3-RACE's G2 arm
});

test("DENY RFG-M-G2D-CRASH-BEFORE (execution before declaration): Record a declared execution", async () => {
  await runCell({ id: "RFG-M-G2D-CRASH-BEFORE", step: "X1 dies before COMMIT after money was sent", fault: "crash-before-commit", at: "uow", expect: "EXECUTION_PRECEDES_DECLARATION / NO_DECLARED_ATTEMPT" }, async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of KINDS) {
        // money sent, then the declaration crashes before COMMIT: no attempt -> NO_DECLARED_ATTEMPT
        const src = await approved(scope, `g2d-crb-${scope}-${kind}`);
        const sentAt = new Date().toISOString();
        ctx.points.crash("uow.before-commit");
        await ctx.operation(`${scope} ${kind}: X1 dying`, () => onFresh(ctx, () => declareX1(src)));
        assert.equal((await attemptsOf(src)).length, 0);
        // X1 runs later: evidence executedAt < declaredAt -> EXECUTION_PRECEDES_DECLARATION, nothing recorded
        const later = dataOf<DeclareView>(await declareX1(src), 201, "the later declaration");
        const early = await storeExecution(later.attempt, { executedAt: sentAt });
        assertRefused(await recordG2(later.attempt, early), "409 EXECUTION_PRECEDES_DECLARATION", `${scope} ${kind}`);
        assert.deepEqual([await attemptState(later.attempt.attemptId), (await refundOf(src))?.state], ["DECLARED", "SUBMITTING"], "nothing recorded");
        assert.equal(await sourceReserved(src), src.totalCents);
      }
  });
});

// =====================================================================================================================================
// Predicate controls (rule 12): one forged control each, G2 and G4 in both scopes and X3-EXECUTED for both kinds; then the unforged control
// =====================================================================================================================================

interface Forge {
  readonly title: string;
  /** The refusal the forged evidence gets (`${status} ${reason}`). */
  readonly refusal: string;
  /** The forged execution artifact for the attempt. */
  forge(attempt: AttemptView, src: Source): Promise<ExecutionOverrides> | ExecutionOverrides;
  /** The review case the outcome opens (default DESTINATION_UNPROVEN for destination predicates, else none asserted). */
  readonly caseKind?: string;
  /** The destination captured at F2 (default DEST). */
  readonly approval?: Destination;
  /** Undoes a forge that changed the attempt itself (not its evidence), so the unforged control judges the attempt as declared. */
  restore?(src: Source): Promise<unknown>;
  /** DP-RECIPIENT (S4): the recipient record bound at X1/X4 (version v1); the unforged control then proves through that record. */
  readonly recipient?: string;
  /** DP-RECIPIENT (S4): a recipient-record artifact with these full details is refused at X1 and X4 (RECIPIENT_ALIAS) before the legs run. */
  readonly alias?: Destination;
}

/**
 * X1 (RETURN) or X4 (RESEND) refuses to bind a recipient record whose full details do not give the captured fingerprint: RECIPIENT_ALIAS,
 * nothing declared; the control on the same source binds a record with the approved details and declares (the attempt carries the binding).
 */
async function aliasRefused(scope: Scope, kind: Kind, label: string, approval: Destination | undefined, alias: Destination): Promise<void> {
  const ref = `recipient-${label}`.replace(/[^A-Za-z0-9._:-]/g, "-");
  const forged = await recipientBinding(ref, "v1", alias);
  const good = await recipientBinding(ref, "v1", approval ?? DEST);
  const approved_ = approval === undefined ? {} : { destination: approval };
  if (kind === "RETURN") {
    const src = await approved(scope, label, approved_);
    assertRefused(await declareX1(src, { recipient: forged }), "409 RECIPIENT_ALIAS", `${scope} X1`);
    assert.deepEqual([(await attemptsOf(src)).length, (await refundOf(src))?.state], [0, "APPROVED"], `${scope} X1: nothing declared`);
    const ok = dataOf<DeclareView>(await declareX1(src, { recipient: good }), 201, `${scope} X1 control`);
    assert.deepEqual(await boundRecipient(ok.attempt.attemptId), [ref, "v1"], `${scope} X1 control: the recipient is bound`);
    return;
  }
  const b = await bounced(scope, label, approved_);
  const before = (await attemptsOf(b.src)).length;
  assertRefused(await declareX4(b.attempt, b.payableCents, { recipient: forged }), "409 RECIPIENT_ALIAS", `${scope} X4`);
  assert.equal((await attemptsOf(b.src)).length, before, `${scope} X4: nothing declared`);
  const ok = dataOf<DeclareView>(await declareX4(b.attempt, b.payableCents, { recipient: good }), 201, `${scope} X4 control`);
  assert.deepEqual(await boundRecipient(ok.attempt.attemptId), [ref, "v1"], `${scope} X4 control: the recipient is bound`);
}
/** The recipient record and version an attempt froze at its declaration ([null, null]: none). */
async function boundRecipient(attemptId: string): Promise<[string | null, string | null]> {
  const row = (await q<{ recipient_ref: string | null; recipient_version: string | null }>("SELECT recipient_ref, recipient_version FROM kauro.outbound_execution_attempts WHERE attempt_id = $1", [attemptId]))[0]!;
  return [row.recipient_ref, row.recipient_version];
}

/** The legs a slice built so far runs as its own cell ([id] RETURN x RECORD, both scopes); the full cell keeps every leg (slice 3). */
const RETURN_RECORD_LEGS: ReadonlyArray<readonly [Kind, "RECORD"]> = [["RETURN", "RECORD"]];
const titleOfLegs = (title: string): string => {
  const [verb, id, ...rest] = title.split(" ");
  return `${verb} [${id}] RETURN x RECORD legs (slice 2): ${rest.join(" ")}`;
};

/** Runs one forged control through G2/G4 (both scopes, both kinds) and X3 EXECUTED (both kinds), then the unforged control records. */
function predicateControl(f: Forge): void {
  const all: ReadonlyArray<readonly [Kind, "RECORD" | "RESOLVE_EXECUTED"]> = KINDS.flatMap((k) => [[k, "RECORD"] as const, [k, "RESOLVE_EXECUTED"] as const]);
  predicateLegs(f, f.title, all);
  predicateLegs(f, titleOfLegs(f.title), RETURN_RECORD_LEGS);
}
function predicateLegs(f: Forge, title: string, legs: ReadonlyArray<readonly [Kind, "RECORD" | "RESOLVE_EXECUTED"]>): void {
  test(title, async () => {
    // the RECORD-only legs declare no deadline: each forged request is retried with unforged evidence (two counted requests per leg)
    const fault: FaultKind = legs.some(([, c]) => c === "RESOLVE_EXECUTED") ? "expiry" : "retry";
    await runCell({ id: f.title.split(" ")[1]!, step: title, fault, expect: f.refusal }, async (ctx) => {
      if (f.alias !== undefined)
        for (const scope of SCOPES) for (const kind of new Set(legs.map(([k]) => k))) await aliasRefused(scope, kind, `alias-${scope}-${kind}`, f.approval, f.alias);
      for (const scope of SCOPES)
        for (const [kind, command] of legs) {
            const approval = f.approval === undefined ? {} : { destination: f.approval };
            const declare = f.recipient === undefined ? {} : { recipient: await recipientBinding(f.recipient, "v1", f.approval ?? DEST) };
            const a = command === "RECORD" ? await openAttempt(scope, kind, `pred-${scope}-${kind}`, approval, declare) : await lapsed(ctx, scope, kind, `pred-x3-${scope}-${kind}`, approval, declare);
            if (f.recipient !== undefined) assert.deepEqual(await boundRecipient(a.attempt.attemptId), [f.recipient, "v1"], `${scope} ${kind}: the recipient record is bound at declaration`);
            const reserved = await sourceReserved(a.src);
            const before = await footprint(a.src);
            const forged = await storeExecution(a.attempt, await f.forge(a.attempt, a.src));
            const r = command === "RECORD" ? await ctx.attempt(() => recordG2(a.attempt, forged)) : await resolveX3(a.attempt, "EXECUTED", forged);
            assertRefused(r, f.refusal, `${scope} ${kind} ${command}`);
            const after = await footprint(a.src);
            assert.deepEqual([after.refund?.state, after.attempts.map(([k, s]) => `${k}:${s}`)], [before.refund?.state, before.attempts.map(([k, s]) => `${k}:${s}`)], `${scope} ${kind} ${command}: no attempt or refund state change`);
            assert.equal(await sourceReserved(a.src), reserved, `${scope} ${kind} ${command}: ${reserved} cents still held`);
            assert.deepEqual([after.offers - before.offers, after.outcomes - before.outcomes], [1, 1], `${scope} ${kind} ${command}: the offer and its REVIEW outcome are durable`);
            if (f.caseKind !== undefined) assert.ok(after.cases.some(([k, s]) => k === f.caseKind && s === "OPEN"), `${scope} ${kind} ${command}: a ${f.caseKind} case: ${JSON.stringify(after.cases)}`);
            const completions = (e: ReadonlyArray<string>): number => e.filter((x) => x.endsWith("refund.completed.v1")).length;
            assert.equal(completions(after.events), completions(before.events), `${scope} ${kind} ${command}: no new completion (a RESEND source already completed with its RETURN)`);
            // the control: unforged evidence records the same attempt
            await f.restore?.(a.src);
            const ok = await storeExecution(a.attempt, { bankExecutionId: nextExecutionId("control"), ...(f.recipient !== undefined ? { full: null, accountLast4: null, recipientRef: f.recipient, recipientVersion: "v1" } : f.approval === undefined ? {} : { full: f.approval }) });
            const good = command === "RECORD" ? await ctx.attempt(() => recordG2(a.attempt, ok)) : await resolveX3(a.attempt, "EXECUTED", ok);
            assert.equal(dataOf<RecordView>(good, 200, `${scope} ${kind} ${command}: the unforged control`).attempt.state, "RECORDED");
          }
    });
  });
}

const DIGEST_OTHER = "e".repeat(64);
predicateControl({ title: "DENY RFG-P-E-ID (execution id absent or used in either scope): Record a declared execution", refusal: "409 EXECUTION_ID_INVALID", forge: async () => ({ bankExecutionId: (await recorded("BANK_CREDIT", "e-id-used").catch(async () => recorded("CAPTURE", "e-id-used"))).executionId }) });
predicateControl({ title: "DENY RFG-P-E-AMT (amount or currency differs from the attempt): Record a declared execution", refusal: "409 EXECUTION_AMOUNT_MISMATCH", forge: (a) => ({ amountCents: BigInt(a.amountCents) - 1n }) });
predicateControl({ title: "DENY RFG-P-E-TIME (executedAt absent, or before declaredAt by 1 ms): Record a declared execution", refusal: "409 EXECUTION_PRECEDES_DECLARATION", forge: (a) => ({ executedAt: plusMs(a.declaredAt, -1) }) });
predicateControl({ title: "DENY RFG-P-E-DEST-UNPROVEN (all destination fields null, or only last4 present): Record a declared execution", refusal: "409 DESTINATION_UNPROVEN", caseKind: "DESTINATION_UNPROVEN", forge: () => ({ full: null, accountLast4: DEST.accountNumber.slice(-4) }) });
predicateControl({ title: "DENY RFG-P-E-DEST-CONFLICT (one present destination field differs): Record a declared execution", refusal: "409 DESTINATION_CONFLICT", forge: () => ({ full: null, accountLast4: "9999" }) });
predicateControl({ title: "DENY RFG-P-E-REF-CONFLICT (a present reference differs from the attempt's): Record a declared execution", refusal: "409 EXECUTION_REFERENCE_CONFLICT", forge: (a) => ({ reference: `${a.reference}0` }) });
predicateControl({ title: "DENY RFG-P-DEST-SAME-LAST4 (a different full account sharing routing and last four): Record a declared execution", refusal: "409 DESTINATION_CONFLICT", forge: () => ({ full: { ...DEST, accountNumber: `9${DEST.accountNumber}` } }) });
predicateControl({ title: "DENY RFG-P-DEST-ROUTING (same account number, different routing number): Record a declared execution", refusal: "409 DESTINATION_CONFLICT", forge: () => ({ full: { ...DEST, routingNumber: "011000015" } }) });
predicateControl({ title: "DENY RFG-P-DEST-NAME (same routing and account, different normalized holder name): Record a declared execution", refusal: "409 DESTINATION_CONFLICT", forge: () => ({ full: { ...DEST, holderName: "Alice Smyth" } }) });
predicateControl({ title: "DENY RFG-P-DEST-RECIPIENT-CHANGED (recipient record bound at declaration, execution evidence carries another recipient version): Record a declared execution", refusal: "409 DESTINATION_UNPROVEN", caseKind: "DESTINATION_UNPROVEN", recipient: "recipient-1", forge: () => ({ full: null, accountLast4: null, recipientRef: "recipient-1", recipientVersion: "v2" }) });
predicateControl({ title: "DENY RFG-P-DEST-RECIPIENT-UNVERSIONED (recipient id without a version): Record a declared execution", refusal: "409 DESTINATION_UNPROVEN", caseKind: "DESTINATION_UNPROVEN", recipient: "recipient-1", forge: () => ({ full: null, accountLast4: null, recipientRef: "recipient-1", recipientVersion: null }) });
predicateControl({ title: "DENY RFG-P-DEST-ABSENT (send receipt with no destination fields): Record a declared execution — attempt stays DECLARED or UNCERTAIN, DESTINATION_UNPROVEN case, share held", refusal: "409 DESTINATION_UNPROVEN", caseKind: "DESTINATION_UNPROVEN", forge: () => ({ full: null, accountLast4: null }) });
predicateControl({ title: "DENY RFG-P-DEST-PARTIAL-ONLY (last four and routing only, both equal): Record a declared execution", refusal: "409 DESTINATION_UNPROVEN", caseKind: "DESTINATION_UNPROVEN", forge: () => ({ full: null, accountLast4: DEST_LAST4_OF(), routingDigest: "a".repeat(64) }) });
predicateControl({
  title: "DENY RFG-P-DF-KEY-VERSION (a fingerprint under another key id, key version or normalizer version never compares equal): Record a declared execution",
  refusal: "409 DESTINATION_UNPROVEN",
  forge: async (_a, src) => {
    await q("UPDATE kauro.outbound_execution_attempts SET fingerprint_key_version = fingerprint_key_version + 1 WHERE source_id = $1 AND state IN ('DECLARED','UNCERTAIN')", [src.sourceId]);
    return {};
  },
  // the forge changed the attempt, not its evidence: the unforged control judges the attempt under the key version it was declared with
  restore: (src) => q("UPDATE kauro.outbound_execution_attempts SET fingerprint_key_version = fingerprint_key_version - 1 WHERE source_id = $1 AND state IN ('DECLARED','UNCERTAIN')", [src.sourceId]),
});
predicateControl({ title: "DENY RFG-P-DF-INVALID-EVIDENCE (DP-FULL evidence or a recipient artifact whose holder normalizes to 141 code points or whose routing fails the ABA check): Record a declared execution — DESTINATION_UNPROVEN", refusal: "409 DESTINATION_UNPROVEN", forge: () => ({ full: { ...DEST, holderName: "A".repeat(141) } }) });
predicateControl({ title: "DENY RFG-P-DF-UNICODE-DIGITS-EVIDENCE (DP-FULL evidence or a recipient artifact whose routing or account uses Arabic-Indic or full-width digits): Record a declared execution — DESTINATION_UNPROVEN, and X1 and X4 refuse the binding", refusal: "409 DESTINATION_UNPROVEN", alias: { ...DEST, routingNumber: "٠٢١٠٠٠٠٢١" }, forge: () => ({ full: { ...DEST, routingNumber: "٠٢١٠٠٠٠٢١" } }) });
predicateControl({ title: "DENY RFG-P-DF-CONCAT-COLLISION (routing 021000021, account 12341234, holder 1234M versus account 123412341234, holder M): distinct destinations give distinct fingerprints", refusal: "409 DESTINATION_CONFLICT", approval: COLLISION_A, forge: () => ({ full: COLLISION_B }) });
predicateControl({ title: "DENY RFG-P-DF-HYPHEN (holder A-B captured at F2 versus AB in DP-FULL evidence and in a recipient artifact): one outcome — distinct fingerprints, DP-FULL E-DEST-CONFLICT, X1 and X4 RECIPIENT_ALIAS", refusal: "409 DESTINATION_CONFLICT", approval: { ...DEST, holderName: "A-B" }, alias: { ...DEST, holderName: "AB" }, forge: () => ({ full: { ...DEST, holderName: "AB" } }) });
predicateControl({ title: "DENY RFG-P-DF-FULLWIDTH (holder in full-width letters versus ASCII letters): one outcome — distinct fingerprints under NFC, DP-FULL E-DEST-CONFLICT, X1 and X4 RECIPIENT_ALIAS", refusal: "409 DESTINATION_CONFLICT", alias: { ...DEST, holderName: "Ａlice Smith" }, forge: () => ({ full: { ...DEST, holderName: "Ａlice Smith" } }) });
function DEST_LAST4_OF(): string {
  return DEST.accountNumber.slice(-4);
}

/** The positive controls: the evidence satisfies every predicate (rule 12's OK side), G2/G4 both scopes and X3 EXECUTED both kinds. */
/** A recipient record bound at X1/X4 (DP-RECIPIENT, S4): its id (version v1) and the full details of its artifact. */
interface BoundRecipient {
  readonly ref: string;
  readonly full: Destination;
}
const ALL_LEGS: ReadonlyArray<readonly [Kind, "RECORD" | "RESOLVE_EXECUTED"]> = KINDS.flatMap((k) => [[k, "RECORD"] as const, [k, "RESOLVE_EXECUTED"] as const]);
function positiveControl(title: string, evidence: (a: AttemptView) => ExecutionOverrides, approval?: Destination, recipient?: BoundRecipient): void {
  positiveLegs(title, title, evidence, ALL_LEGS, approval, recipient);
  positiveLegs(title, titleOfLegs(title), evidence, RETURN_RECORD_LEGS, approval, recipient);
}
function positiveLegs(id: string, title: string, evidence: (a: AttemptView) => ExecutionOverrides, legs: ReadonlyArray<readonly [Kind, "RECORD" | "RESOLVE_EXECUTED"]>, approval?: Destination, recipient?: BoundRecipient): void {
  test(title, async () => {
    const fault: FaultKind = legs.some(([, c]) => c === "RESOLVE_EXECUTED") ? "expiry" : "retry";
    await runCell({ id: id.split(" ")[1]!, step: title, fault, expect: "RECORDED" }, async (ctx) => {
      for (const scope of SCOPES)
        for (const [kind, command] of legs) {
            const approved_ = approval === undefined ? {} : { destination: approval };
            const declare = recipient === undefined ? {} : { recipient: await recipientBinding(recipient.ref, "v1", recipient.full) };
            const a = command === "RECORD" ? await openAttempt(scope, kind, `ok-${scope}-${kind}`, approved_, declare) : await lapsed(ctx, scope, kind, `ok-x3-${scope}-${kind}`, approved_, declare);
            // X1 and X4 bind the recipient record (its details give the captured fingerprint)
            if (recipient !== undefined) assert.deepEqual(await boundRecipient(a.attempt.attemptId), [recipient.ref, "v1"], `${scope} ${kind}: the recipient record is bound`);
            const stored = await storeExecution(a.attempt, evidence(a.attempt));
            const key = freshKey("ok");
            const r = command === "RECORD" ? await ctx.attempt(() => recordG2(a.attempt, stored, { key })) : await resolveX3(a.attempt, "EXECUTED", stored);
            const view = dataOf<RecordView>(r, 200, `${scope} ${kind} ${command}`);
            if (command === "RECORD") {
              // the lost answer retried: the same key and body replays the recorded answer, nothing moves again
              const again = dataOf<RecordView>(await ctx.attempt(() => recordG2(a.attempt, stored, { key })), 200, `${scope} ${kind}: the replay`);
              assert.deepEqual(again, view, `${scope} ${kind}: the replay answers the recorded view`);
            }
            assert.equal(view.attempt.state, "RECORDED");
            if (kind === "RETURN") assert.equal(view.refund?.state, "COMPLETED", `${scope}: COMPLETED with ${a.attempt.amountCents} cents`);
            const proof = (await q<{ destination_proof: string }>("SELECT destination_proof FROM kauro.outbound_execution_attempts WHERE attempt_id = $1", [a.attempt.attemptId]))[0]!.destination_proof;
            assert.equal(proof, evidence(a.attempt).full === null ? "DP_RECIPIENT" : "DP_FULL", `${scope} ${kind} ${command}: the proof recorded`);
          }
    });
  });
}
positiveControl("OK RFG-P-E-ALL (every predicate holds; reference null): Record a declared execution", () => ({ reference: null }));
positiveControl("OK RFG-P-DEST-FULL (full recipient details whose keyed fingerprint equals the approved one): Record a declared execution", () => ({}));
positiveControl("OK RFG-P-DF-EQUIV-CASE (holder ALICE SMITH at approval, alice smith in DP-FULL evidence and in a recipient record): same fingerprint — recording succeeds and X1 and X4 bind the recipient", () => ({ full: { ...DEST, holderName: "alice smith" } }), { ...DEST, holderName: "ALICE SMITH" }, { ref: "recipient-equiv-case", full: { ...DEST, holderName: "alice smith" } });
positiveControl("OK RFG-P-DF-EQUIV-NFC (holder with precomposed U+00E9 at approval, e followed by U+0301 in DP-FULL evidence and in a recipient record): same fingerprint — recording succeeds and X1 and X4 bind the recipient", () => ({ full: { ...DEST, holderName: "Renée Smith" } }), { ...DEST, holderName: "Renée Smith" }, { ref: "recipient-equiv-nfc", full: { ...DEST, holderName: "Renée Smith" } });
positiveControl("OK RFG-P-DF-EQUIV-WHITESPACE (holder with leading, trailing and inner White_Space runs including a tab and U+00A0 at approval, single spaces in DP-FULL evidence and in a recipient record): same fingerprint — recording succeeds and X1 and X4 bind the recipient", () => ({ full: { ...DEST, holderName: "Alice Smith" } }), { ...DEST, holderName: " Alice	  Smith " }, { ref: "recipient-equiv-ws", full: { ...DEST, holderName: "Alice Smith" } });

// DP-RECIPIENT: the receipt carries no destination field but the bound recipient id and version (G2/G4 both scopes, X3 EXECUTED both kinds)
positiveLegs(
  "OK RFG-P-DEST-RECIPIENT (bound recipient record, same version at execution): Record a declared execution",
  "OK RFG-P-DEST-RECIPIENT (bound recipient record, same version at execution): Record a declared execution",
  () => ({ full: null, accountLast4: null, recipientRef: "recipient-ok", recipientVersion: "v1" }),
  ALL_LEGS,
  undefined,
  { ref: "recipient-ok", full: DEST },
);

// --- NOT_EXECUTED predicate controls --------------------------------------------------------------------------------------------------

function nxControl(title: string, refusalText: string, debits: (a: AttemptView) => Promise<Parameters<typeof statementWith>[2]> | Parameters<typeof statementWith>[2], options: { readonly gapDay?: boolean; readonly early?: boolean; readonly recipient?: string } = {}): void {
  test(title, async () => {
    await runCell({ id: title.split(" ")[1]!, step: title, fault: "expiry", expect: refusalText }, async (ctx) => {
      // a control: a clean attempt with clean coverage is NOT_EXECUTED (RETURN: FAILED, share released)
      const control = async (scope: Scope, kind: Kind, c: { readonly src: Source; readonly attempt: AttemptView }): Promise<void> => {
        await coveredForNx(ctx, c.attempt);
        const ok = dataOf<{ attempt: AttemptView; refund: { state: string } | null }>(await onClock(ctx, "control", () => resolveX3(c.attempt, "NOT_EXECUTED", null)), 200, `${scope} ${kind}: control`);
        assert.equal(ok.attempt.state, "NOT_EXECUTED");
        if (kind === "RETURN") assert.deepEqual([ok.refund?.state, await sourceReserved(c.src)], ["FAILED", 0n], `${scope}: FAILED owner_attested_no_effect, share released`);
      };
      if (options.early === true) {
        // the controlled clock never moves backwards: every attempt (and its control) is declared and lapsed first, then the legs are judged in the
        // order of their instants, each the effect-clock margin before declaredAt + window + coverageLag (the clock-run margin X2-EXPIRY uses)
        const legs: { scope: Scope; kind: Kind; a: Awaited<ReturnType<typeof lapsed>>; c: Awaited<ReturnType<typeof lapsed>> }[] = [];
        for (const scope of SCOPES)
          for (const kind of KINDS) legs.push({ scope, kind, a: await lapsed(ctx, scope, kind, `nx-${scope}-${kind}`), c: await lapsed(ctx, scope, kind, `nx-control-${scope}-${kind}`) });
        const { manualExecutionWindowMs, coverageLagMs } = routeTiming();
        const instant = (x: AttemptView): number => Date.parse(plusMs(x.declaredAt, manualExecutionWindowMs + coverageLagMs));
        for (const { scope, kind, a } of [...legs].sort((x, y) => instant(x.a.attempt) - instant(y.a.attempt))) {
          ctx.clock.set(new Date(Math.max(instant(a.attempt) - EFFECT_CLOCK_MARGIN_MS, ctx.clock.nowMs())));
          assert.ok(ctx.clock.nowMs() < instant(a.attempt), `${scope} ${kind}: the clock stands before declaredAt + window + coverageLag`);
          const before = await footprint(a.src);
          assertRefused(await onClock(ctx, `${scope} ${kind}: NOT_EXECUTED`, () => resolveX3(a.attempt, "NOT_EXECUTED", null)), refusalText, `${scope} ${kind}`);
          assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN", `${scope} ${kind}: stays UNCERTAIN`);
          assert.equal(await sourceReserved(a.src), a.src.totalCents, `${scope} ${kind}: ${a.src.totalCents} cents held`);
          assert.equal((await footprint(a.src)).refund?.state, before.refund?.state);
        }
        for (const { scope, kind, c } of [...legs].sort((x, y) => instant(x.c.attempt) - instant(y.c.attempt))) await control(scope, kind, c);
        return;
      }
      for (const scope of SCOPES)
        for (const kind of KINDS) {
          const declare = options.recipient === undefined ? {} : { recipient: await recipientBinding(options.recipient, "v1") };
          const a = await lapsed(ctx, scope, kind, `nx-${scope}-${kind}`, {}, declare);
          if (options.recipient !== undefined) assert.deepEqual(await boundRecipient(a.attempt.attemptId), [options.recipient, "v1"], `${scope} ${kind}: the attempt binds the recipient`);
          const { manualExecutionWindowMs, coverageLagMs } = routeTiming();
          const nx = plusMs(a.attempt.declaredAt, manualExecutionWindowMs + coverageLagMs);
          ctx.clock.set(new Date(Math.max(Date.parse(nx), ctx.clock.nowMs())));
          // the coverage ends the harness margin past effectNow − lag: X3's effect clock runs on with its transaction (kauro.effect_now(), 0038)
          const to = plusMs(ctx.clock.now(), EFFECT_CLOCK_MARGIN_MS - coverageLagMs);
          if (options.gapDay === true) {
            const s1 = await statementWith(plusMs(a.attempt.declaredAt, -60_000), plusMs(a.attempt.declaredAt, 3_600_000), []);
            assert.equal((await onClock(ctx, "SI2 before the gap", () => importSI2(s1))).status, 201);
            // the judged interval is [declaredAt, effectNow - lag] (about window long): the gap stands inside it, between the first coverage and ten minutes before its end
            const s2 = await statementWith(plusMs(to, -600_000), to, []);
            assert.equal((await onClock(ctx, "SI2 after the gap", () => importSI2(s2))).status, 201);
          } else {
            const s3 = await statementWith(plusMs(a.attempt.declaredAt, -60_000), to, (await debits(a.attempt)).map((d) => ({ executedAt: plusMs(a.attempt.declaredAt, 1), ...d })));
            assert.equal((await onClock(ctx, "SI2 imports the coverage", () => importSI2(s3))).status, 201);
          }
          const before = await footprint(a.src);
          const r = await onClock(ctx, `${scope} ${kind}: NOT_EXECUTED`, () => resolveX3(a.attempt, "NOT_EXECUTED", null));
          assertRefused(r, refusalText, `${scope} ${kind}`);
          assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN", `${scope} ${kind}: stays UNCERTAIN`);
          assert.equal(await sourceReserved(a.src), a.src.totalCents, `${scope} ${kind}: ${a.src.totalCents} cents held`);
          assert.equal((await footprint(a.src)).refund?.state, before.refund?.state);
          await control(scope, kind, await lapsed(ctx, scope, kind, `nx-control-${scope}-${kind}`));
        }
    });
  });
}
nxControl("DENY RFG-P-NX-LAG (one ms before declaredAt + window + coverageLag): Resolve uncertain execution", "409 NOT_EXECUTED_TOO_EARLY", () => [], { early: true });
nxControl("DENY RFG-P-NX-COVERAGE (a one-day gap in imported coverage): Resolve uncertain execution", "409 COVERAGE_INCOMPLETE", () => [], { gapDay: true });
nxControl("DENY RFG-P-NX-POTENTIAL (one unlinked debit with null reference and null destination in the interval): Resolve uncertain execution", "409 UNEXPLAINED_DEBIT", (a) => [{ amountCents: BigInt(a.amountCents) }]);
nxControl("DENY RFG-P-NX-CORR-REF (a debit with the attempt's reference and a conflicting destination): Resolve uncertain execution", "409 CONTRADICTORY_EVIDENCE", (a) => [{ amountCents: 1n, reference: a.reference, full: COLLISION_B }]);
nxControl("DENY RFG-P-NX-CORR-LINKED (a debit linked to another RECORDED attempt but carrying this attempt's reference): Resolve uncertain execution", "409 CONTRADICTORY_EVIDENCE", async (a) => {
  const other = await recorded("CAPTURE", "nx-linked-other");
  return [{ amountCents: BigInt(other.attempt.amountCents), bankExecutionId: other.executionId, reference: a.reference }];
});
nxControl("DENY RFG-P-NX-CORR-OFFERED (a debit whose execution id was offered for this attempt and refused): Resolve uncertain execution", "409 CONTRADICTORY_EVIDENCE", async (a) => {
  const id = nextExecutionId("offered");
  assert.ok((await recordG2(a, await storeExecution(a, { bankExecutionId: id, full: null, accountLast4: null }))).status >= 400, "the offer is refused on destination proof");
  return [{ amountCents: BigInt(a.amountCents), bankExecutionId: id }];
});
nxControl("DENY RFG-P-NX-CORR-RECIPIENT (a debit carrying the bound recipient id with no reference and no destination fields): Resolve uncertain execution", "409 CONTRADICTORY_EVIDENCE", () => [{ amountCents: 5n, recipientRef: "recipient-bound" }], { recipient: "recipient-bound" });
nxControl("DENY RFG-P-NX-CORR-DF (a debit whose full destination gives the attempt's fingerprint, other amount, no reference): Resolve uncertain execution", "409 CONTRADICTORY_EVIDENCE", () => [{ amountCents: 7n, full: DEST }]);
nxControl("DENY RFG-P-NX-OTHER-CURRENCY (an unexplained debit in another currency): Resolve uncertain execution", "409 UNEXPLAINED_DEBIT", (a) => [{ amountCents: BigInt(a.amountCents), currency: "EUR" }]);
nxControl("DENY RFG-P-NX-UNEXPLAINED (an unexplained debit of another amount with a conflicting destination): Resolve uncertain execution", "409 UNEXPLAINED_DEBIT", () => [{ amountCents: 11n, full: COLLISION_B }]);
nxControl("DENY RFG-P-NX-CORR-OFFERED-REPRO (X offered for A and refused on destination proof, X then recorded for B, its debit imported without reference or recipient): Resolve uncertain execution — NOT_EXECUTED of A refused CONTRADICTORY_EVIDENCE", "409 CONTRADICTORY_EVIDENCE", async (a) => {
  const x = nextExecutionId("repro");
  assert.ok((await recordG2(a, await storeExecution(a, { bankExecutionId: x, full: null, accountLast4: null }))).status >= 400, "X offered for A, refused");
  const b = await declared("CAPTURE", "nx-repro-b");
  dataOf<RecordView>(await recordG2(b.attempt, await storeExecution(b.attempt, { bankExecutionId: x })), 200, "X recorded for B");
  return [{ amountCents: BigInt(b.attempt.amountCents), bankExecutionId: x }];
});

test("OK RFG-P-NX-EXPLAINED (only debits linked to other RECORDED attempts or a recorded settlement, none correlated): Resolve uncertain execution", async () => {
  await runCell({ id: "RFG-P-NX-EXPLAINED", step: "X3 NOT_EXECUTED with explained debits only", fault: "expiry", expect: "NOT_EXECUTED" }, async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of KINDS) {
        const a = await lapsed(ctx, scope, kind, `nx-explained-${scope}-${kind}`);
        const other = await recorded("CAPTURE", `nx-explained-other-${scope}-${kind}`);
        await coveredForNx(ctx, a.attempt, [{ amountCents: BigInt(other.attempt.amountCents), bankExecutionId: other.executionId, reference: other.attempt.reference }]);
        const ok = dataOf<{ attempt: AttemptView }>(await onClock(ctx, "X3", () => resolveX3(a.attempt, "NOT_EXECUTED", null)), 200, `${scope} ${kind}`);
        assert.equal(ok.attempt.state, "NOT_EXECUTED");
      }
  });
});

test("DENY RFG-P-X3-EXECUTED-PARTIAL (owner resolution offering only last four and routing): Resolve uncertain execution — stays UNCERTAIN", async () => {
  await runCell({ id: "RFG-P-X3-EXECUTED-PARTIAL", step: "X3 EXECUTED with partial destination", fault: "expiry", expect: "UNCERTAIN" }, async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of KINDS) {
        const a = await lapsed(ctx, scope, kind, `x3-partial-dest-${scope}-${kind}`);
        assertRefused(await resolveX3(a.attempt, "EXECUTED", await storeExecution(a.attempt, { full: null, accountLast4: DEST.accountNumber.slice(-4), routingDigest: "a".repeat(64) })), "409 DESTINATION_UNPROVEN", `${scope} ${kind}`);
        assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN");
        assert.equal(await sourceReserved(a.src), a.src.totalCents);
      }
  });
});

// --- destination capture (F2) and binding (X1/X4) -------------------------------------------------------------------------------------

/** F2 with a forged destination: refused DESTINATION_INVALID, nothing written (REQUESTED, no destination row); the DEST control then approves. */
function captureControl(title: string, destination: Destination | ((d: Destination) => Destination), ok = false): void {
  test(title, async () => {
    for (const scope of SCOPES) {
      const src = await requested(scope, `capture-${scope}`);
      const before = await footprint(src);
      const d = typeof destination === "function" ? destination(DEST) : destination;
      const r = await approveF2(src, { destination: d });
      if (ok) {
        assert.equal(r.status, 200, `${scope}: ${JSON.stringify(d)} is captured: ${r.text}`);
        const row = (await q<{ destination_fingerprint: string; account_last4: string; fingerprint_norm_version: string }>("SELECT destination_fingerprint, account_last4, fingerprint_norm_version FROM kauro.refund_destinations WHERE refund_id::text = $1 OR treasury_refund_id::text = $1", [src.refundId]))[0];
        assert.equal(row?.account_last4, d.accountNumber.replace(/[ -]/g, "").slice(-4));
        assert.equal(row?.fingerprint_norm_version, "destination-norm-v1");
        continue;
      }
      assertRefused(r, "422 DESTINATION_INVALID", `${scope}: ${JSON.stringify(d)}`);
      const after = await footprint(src);
      assert.deepEqual([after.refund?.state, after.destinations, after.refund?.reservedCents], ["REQUESTED", 0, 0n], `${scope}: nothing approved, no destination, nothing reserved`);
      assert.equal(after.events.length, before.events.length);
      assert.equal((await approveF2(src)).status, 200, `${scope}: the valid destination control approves`);
    }
  });
}
captureControl("OK RFG-P-DF-BOUNDS (routing of 9 digits with a valid ABA check digit, account of 1 and of 17 digits, holder of 1 and of 140 code points after normalization): Capture approved destination", { routingNumber: "021000021", accountNumber: "12345678901234567", holderName: "Z".repeat(140) }, true);
captureControl("DENY RFG-P-DF-ROUTING-LENGTH (routing of 8 and of 10 digits): Capture approved destination", (d) => ({ ...d, routingNumber: "02100002" }));
captureControl("DENY RFG-P-DF-ROUTING-ABA (9 digits with a wrong ABA check digit): Capture approved destination", (d) => ({ ...d, routingNumber: "021000022" }));
captureControl("DENY RFG-P-DF-ACCOUNT-EMPTY (account empty after removing spaces and hyphens): Capture approved destination", (d) => ({ ...d, accountNumber: " - - " }));
captureControl("DENY RFG-P-DF-ACCOUNT-18 (account of 18 digits): Capture approved destination", (d) => ({ ...d, accountNumber: "123456789012345678" }));
captureControl("DENY RFG-P-DF-ACCOUNT-NONDIGIT (account with a letter): Capture approved destination", (d) => ({ ...d, accountNumber: "1234A678" }));
captureControl("DENY RFG-P-DF-HOLDER-EMPTY (holder empty after normalization): Capture approved destination", (d) => ({ ...d, holderName: " \t  " }));
captureControl("DENY RFG-P-DF-HOLDER-141 (holder of 141 code points after normalization): Capture approved destination", (d) => ({ ...d, holderName: "Z".repeat(141) }));
captureControl("DENY RFG-P-DF-ROUTING-UNICODE-DIGITS (routing written with Arabic-Indic digits and with full-width digits): Capture approved destination — DESTINATION_INVALID", (d) => ({ ...d, routingNumber: "０２１００００２１" }));
captureControl("DENY RFG-P-DF-ACCOUNT-UNICODE-DIGITS (account written with Arabic-Indic digits and with full-width digits): Capture approved destination — DESTINATION_INVALID", (d) => ({ ...d, accountNumber: "١٢٣٤" }));

test("OK RFG-P-DF-NORMALIZATION (spaces and hyphens in routing and account, NFC-equivalent and case variants of the holder give one fingerprint; leading zeros stay significant)", async () => {
  for (const scope of SCOPES) {
    const fp = async (d: Destination): Promise<string> => {
      const src = await requested(scope, `norm-${scope}`);
      assert.equal((await approveF2(src, { destination: d })).status, 200, `${scope}: ${JSON.stringify(d)}`);
      return (await q<{ f: string }>("SELECT destination_fingerprint AS f FROM kauro.refund_destinations WHERE refund_id::text = $1 OR treasury_refund_id::text = $1", [src.refundId]))[0]!.f;
    };
    const base = await fp(DEST);
    assert.equal(await fp({ routingNumber: "021-000 021", accountNumber: "1234 1234", holderName: "ALICE  SMITH" }), base, `${scope}: spaces, hyphens and case give one fingerprint`);
    assert.notEqual(await fp({ ...DEST, accountNumber: `0${DEST.accountNumber}` }), base, `${scope}: a leading zero is significant`);
  }
});

test("DENY RFG-P-DEST-NOT-CAPTURED (approval without a captured destination fingerprint): Declare manual refund execution", async () => {
  for (const scope of SCOPES) {
    const src = await requested(scope, `not-captured-${scope}`);
    const approvedWithout = await approveF2(src, { destination: null, evidence: null });
    if (approvedWithout.status === 200) {
      assertRefused(await declareX1(src), "409 DESTINATION_NOT_CAPTURED", `${scope}: X1`);
      assert.deepEqual([(await attemptsOf(src)).length, (await refundOf(src))?.state], [0, "APPROVED"]);
    } else assertRefused(approvedWithout, "422 DESTINATION_NOT_CAPTURED", `${scope}: an approval without its destination`);
    // control: the captured destination declares
    const ok = await approved(scope, `not-captured-control-${scope}`);
    dataOf<DeclareView>(await declareX1(ok), 201, `${scope}: the control declares`);
  }
});

for (const [title, x4] of [
  ["DENY RFG-P-DEST-RECIPIENT-ALIAS (a recipient record whose full details give another fingerprint, including the concatenation-collision pair): Declare manual refund execution", false],
  ["DENY RFG-P-DEST-RECIPIENT-ALIAS-RESEND (the same alias cases): Declare a resend execution", true],
] as const) {
  test(title, async () => {
    for (const scope of SCOPES) {
      const src = await approved(scope, `alias-${scope}`, { destination: COLLISION_A });
      const target = x4 ? (await bounced(scope, `alias-x4-${scope}`)).attempt : null;
      const s4 = (L().bw as unknown as { storeRecipientRecord?: (r: { recipientRef: string; recipientVersion: string; full: Destination }) => Promise<import("./bank-support.js").StoredBankArtifact> }).storeRecipientRecord;
      // the declaration itself must exist before the alias guard can be asked
      if (!x4) dataOf<DeclareView>(await declareX1(await approved(scope, `alias-control-${scope}`)), 201, `${scope}: X1 control`);
      if (s4 === undefined) throw new SeamMissing("S4", SEAMS.S4);
      const artifact = await s4({ recipientRef: `recipient-${scope}`, recipientVersion: "v1", full: COLLISION_B });
      const r = x4 ? await declareX4(target!, 1n, { recipient: { recipientRef: `recipient-${scope}`, recipientVersion: "v1", artifact } }) : await declareX1(src, { recipient: { recipientRef: `recipient-${scope}`, recipientVersion: "v1", artifact } });
      assertRefused(r, "409 RECIPIENT_ALIAS", `${scope}: the collision twin is another destination`);
    }
  });
}

test("DENY RFG-P-FINGERPRINT-SECRECY (no full routing or account number in responses, logs, events, outbox, telemetry or the owner queue; fingerprints keyed and versioned): Declare manual refund execution", async () => {
  for (const scope of SCOPES) {
    const { src, attempt } = await declared(scope, `secrecy-${scope}`);
    const texts: string[] = [];
    texts.push(JSON.stringify(attempt), (await ownerQueue()).text);
    texts.push(JSON.stringify(await q("SELECT payload FROM kauro.domain_events WHERE aggregate_id::text = ANY($1::text[])", [[src.refundId, attempt.attemptId, src.sourceId]])));
    texts.push(JSON.stringify(await q("SELECT o.* FROM kauro.outbox_records o JOIN kauro.domain_events e USING (event_id) WHERE e.aggregate_id::text = ANY($1::text[])", [[src.refundId, attempt.attemptId]])));
    texts.push(JSON.stringify(await q("SELECT * FROM kauro.refund_destinations WHERE refund_id::text = $1 OR treasury_refund_id::text = $1", [src.refundId])));
    texts.push(JSON.stringify(await q("SELECT * FROM kauro.security_events ORDER BY occurred_at DESC LIMIT 50")));
    texts.push(JSON.stringify(L().iw.w.internalErrors));
    for (const t of texts) {
      assert.doesNotMatch(t, new RegExp(DEST.accountNumber), `${scope}: the full account number never appears`);
      assert.doesNotMatch(t, new RegExp(DEST.routingNumber), `${scope}: the full routing number never appears`);
    }
    const row = (await q<{ fingerprint_key_id: string; fingerprint_key_version: number; fingerprint_norm_version: string; destination_fingerprint: string }>("SELECT fingerprint_key_id, fingerprint_key_version, fingerprint_norm_version, destination_fingerprint FROM kauro.outbound_execution_attempts WHERE attempt_id = $1", [attempt.attemptId]))[0]!;
    assert.equal(row.fingerprint_norm_version, "destination-norm-v1");
    const { createHash } = await import("node:crypto");
    assert.notEqual(row.destination_fingerprint, createHash("sha256").update(`${DEST.routingNumber}${DEST.accountNumber}${DEST.holderName}`).digest("hex"), "keyed, never a bare digest of the numbers");
  }
});

// --- destination races with the statement import (L1, both orders) ------------------------------------------------------------------

for (const [title, full, expectRecorded] of [
  ["RACE RFG-M-DEST-SI2 (both orders): Record a declared execution with partial-destination evidence against a statement import of its debit — in neither order is the attempt recorded; the debit stays correlated, NOT_EXECUTED is refused, the share stays held", false, false],
  ["RACE RFG-M-DEST-SI2-FULL (both orders): Record a declared execution with full-destination evidence against a statement import of its debit — one RECORDED attempt, one link, one refund.completed", true, true],
] as const) {
  cell(title, "race", async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of KINDS)
        for (const order of ["G2 first", "SI2 first"]) {
          const a = await openAttempt(scope, kind, `dest-si2-${scope}-${kind}`);
          const id = nextExecutionId("dest-si2");
          const receipt = await storeExecution(a.attempt, full ? { bankExecutionId: id } : { bankExecutionId: id, full: null, accountLast4: DEST.accountNumber.slice(-4), routingDigest: "a".repeat(64) });
          const stmt = await statementWith(plusMs(a.attempt.declaredAt, -60_000), plusMs(a.attempt.declaredAt, 60_000), [{ amountCents: BigInt(a.attempt.amountCents), bankExecutionId: id, reference: a.attempt.reference }]);
          const g2 = bank(() => recordG2(a.attempt, receipt));
          const si2 = bank(() => importSI2(stmt));
          const r = order === "G2 first" ? await hw(ctx, `${scope} ${kind} ${order}`, g2, si2) : await hw(ctx, `${scope} ${kind} ${order}`, si2, g2);
          valueOf(r.held);
          valueOf(r.waited);
          assert.equal(await attemptState(a.attempt.attemptId), expectRecorded ? "RECORDED" : "DECLARED", `${scope} ${kind} ${order}`);
          if (expectRecorded) {
            if (kind === "RETURN") assert.equal((await footprint(a.src)).events.filter((e) => e.endsWith("refund.completed.v1")).length, 1);
          } else {
            assert.equal(await sourceReserved(a.src), a.src.totalCents, "the share stays held");
            assert.ok((await q<{ n: string }>("SELECT count(*)::text AS n FROM kauro.execution_correlations WHERE attempt_id = $1", [a.attempt.attemptId]))[0]!.n !== "0", "the debit stays correlated");
          }
        }
  });
}

cell("RACE RFG-M-DEST-RECIPIENT (both orders): a recipient-record artifact with a new version imported against G2 recording through DP-RECIPIENT — G2 first records only on the declared version carried by the execution evidence; artifact first changes no bound version and G2 still requires the declared version", "race", async (ctx) => {
  // the new version is bound by another declaration of the same account (X1 of a second refund binding v2 under L1), against G2 of the
  // attempt bound to v1 with a receipt carrying v1: in both orders the attempt records DP-RECIPIENT on v1, its bound version never moves,
  // and a receipt carrying v2 proves nothing for it; the second attempt holds v2 and a v1 receipt proves nothing for it either
  for (const scope of SCOPES)
    for (const order of ["G2 first", "new version first"] as const) {
      const ref = `recipient-race-${scope}-${order === "G2 first" ? "g" : "v"}`;
      const a = await openAttempt(scope, "RETURN", `dest-rcp-a-${scope}-${order}`, {}, { recipient: await recipientBinding(ref, "v1") });
      const other = await approved(scope, `dest-rcp-b-${scope}-${order}`);
      const v2 = await recipientBinding(ref, "v2");
      const storedV1 = await storeExecution(a.attempt, { full: null, accountLast4: null, recipientRef: ref, recipientVersion: "v1" });
      const g2 = bank(() => recordG2(a.attempt, storedV1));
      const x1 = bank(() => declareX1(other, { recipient: v2 }));
      const r = order === "G2 first" ? await hw(ctx, `${scope} ${order}`, g2, x1) : await hw(ctx, `${scope} ${order}`, x1, g2);
      const g2Reply = valueOf(order === "G2 first" ? r.held : r.waited) as Reply;
      const x1Reply = valueOf(order === "G2 first" ? r.waited : r.held) as Reply;
      assert.equal(dataOf<RecordView>(g2Reply, 200, `${scope} ${order}: G2 on v1`).attempt.state, "RECORDED");
      const b = dataOf<DeclareView>(x1Reply, 201, `${scope} ${order}: X1 binds v2`).attempt;
      assert.deepEqual(await boundRecipient(a.attempt.attemptId), [ref, "v1"], `${scope} ${order}: the bound version never moves`);
      assert.deepEqual(await boundRecipient(b.attemptId), [ref, "v2"], `${scope} ${order}: the second attempt holds v2`);
      assert.equal((await q<{ destination_proof: string }>("SELECT destination_proof FROM kauro.outbound_execution_attempts WHERE attempt_id = $1", [a.attempt.attemptId]))[0]!.destination_proof, "DP_RECIPIENT");
      // G2 still requires the declared version: a v1 receipt for the v2-bound attempt proves nothing (its share stays held)
      assertRefused(await recordG2(b, await storeExecution(b, { full: null, accountLast4: null, recipientRef: ref, recipientVersion: "v1" })), "409 DESTINATION_UNPROVEN", `${scope} ${order}: v1 for the v2 attempt`);
      assert.equal(await attemptState(b.attemptId), "DECLARED");
      assert.equal(await sourceReserved(other), other.totalCents);
    }
});

cell("RACE RFG-M-NX-SI2-CORR (both orders): X3 NOT_EXECUTED against a statement import of a correlated debit with a conflicting destination — import first: NOT_EXECUTED refused CONTRADICTORY_EVIDENCE; X3 first: NOT_EXECUTED commits, the import opens REFUND_TERMINAL_CONTRADICTED and freezes every open refund of the source (no further share is released)", "race", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await lapsed(ctx, scope, kind, `nx-si2-a-${scope}-${kind}`);
      const { coverageLagMs } = routeTiming();
      await coveredForNx(ctx, a.attempt);
      const stmtA = await statementWith(plusMs(ctx.clock.now(), -coverageLagMs - 1000), plusMs(ctx.clock.now(), -coverageLagMs), [{ amountCents: 3n, reference: a.attempt.reference, full: COLLISION_B }]);
      const importFirst = await hw(ctx, `${scope} ${kind}: import first`, bank(() => importSI2(stmtA)), bank(() => onClock(ctx, "X3", () => resolveX3(a.attempt, "NOT_EXECUTED", null))));
      valueOf(importFirst.held);
      assertRefused(valueOf(importFirst.waited), "409 CONTRADICTORY_EVIDENCE", `${scope} ${kind}: import first`);
      const b = await lapsed(ctx, scope, kind, `nx-si2-b-${scope}-${kind}`);
      await coveredForNx(ctx, b.attempt);
      const stmtB = await statementWith(plusMs(ctx.clock.now(), -coverageLagMs - 1000), plusMs(ctx.clock.now(), -coverageLagMs), [{ amountCents: 3n, reference: b.attempt.reference, full: COLLISION_B }]);
      const x3First = await hw(ctx, `${scope} ${kind}: X3 first`, bank(() => onClock(ctx, "X3", () => resolveX3(b.attempt, "NOT_EXECUTED", null))), bank(() => importSI2(stmtB)));
      assert.equal(valueOf(x3First.held).status, 200);
      assert.equal(await openCases(b.src, "REFUND_TERMINAL_CONTRADICTED"), 1);
      assert.equal((await footprint(b.src)).freezes, 1, `${scope} ${kind}: every open refund of the source frozen`);
    }
});

// --- durable execution offers (DV1-11) -----------------------------------------------------------------------------------------------

type Gate = { readonly title: string; readonly prepare: (a: AttemptView) => Promise<import("./bank-support.js").StoredBankArtifact> };
const GATES: ReadonlyArray<Gate> = [
  { title: "DENY RFG-P-OFFER-GATE-RECORDED (classified, every predicate holds): an authorized offer is committed before classification", prepare: (a) => storeExecution(a) },
  { title: "DENY RFG-P-OFFER-GATE-PREDICATE (classified, a recording predicate fails): an authorized offer is committed before classification and blocks NOT_EXECUTED", prepare: (a) => storeExecution(a, { amountCents: BigInt(a.amountCents) - 1n }) },
  { title: "DENY RFG-P-OFFER-GATE-UNKNOWN (UNKNOWN_EVIDENCE): an authorized offer is committed before classification and blocks NOT_EXECUTED", prepare: async () => { const s = await L().bw.evidence.put({ bytes: new TextEncoder().encode("unknown-format/9\n{}") }); return { artifactRef: s.artifactRef, evidenceHash: s.sha256 }; } },
  { title: "DENY RFG-P-OFFER-GATE-MALFORMED (MALFORMED_EVIDENCE): an authorized offer is committed before classification and blocks NOT_EXECUTED", prepare: async (a) => { const s = await storeExecution(a); const env = await L().bw.evidence.get(s.artifactRef); const bytes = env!.bytes.slice(0, Math.floor(env!.bytes.length / 2)); const t = await L().bw.evidence.put({ bytes }); return { artifactRef: t.artifactRef, evidenceHash: t.sha256 }; } },
  { title: "DENY RFG-P-OFFER-GATE-HASH (HASH_MISMATCH): an authorized offer is committed before classification and blocks NOT_EXECUTED", prepare: async (a) => { const s = await storeExecution(a); L().bw.evidence.corrupt(s.artifactRef, new TextEncoder().encode("swapped")); return s; } },
  { title: "DENY RFG-P-OFFER-GATE-UNAUTHENTICATED (UNAUTHENTICATED_EVIDENCE): an authorized offer is committed before classification and blocks NOT_EXECUTED", prepare: async (a) => { const s = await storeExecution(a); const env = await L().bw.evidence.get(s.artifactRef); const t = await L().bw.evidence.put({ bytes: env!.bytes, authenticatedBy: "NONE" as never }); return { artifactRef: t.artifactRef, evidenceHash: t.sha256 }; } },
  { title: "DENY RFG-P-OFFER-GATE-STORE (evidence store refusal and store timeout): an authorized offer is committed before classification and blocks NOT_EXECUTED", prepare: async () => ({ artifactRef: "01a00000-0000-7000-8000-00000000abcd", evidenceHash: "f".repeat(64) as never }) },
];
for (const g of GATES) {
  test(g.title, async () => {
    await runCell({ id: g.title.split(" ")[1]!, step: g.title, fault: "expiry", expect: "the offer row precedes the gate" }, async (ctx) => {
      for (const scope of SCOPES)
        for (const kind of KINDS)
          for (const command of ["RECORD", "RESOLVE_EXECUTED"] as const) {
            const a = command === "RECORD" ? await openAttempt(scope, kind, `gate-${scope}-${kind}`) : await lapsed(ctx, scope, kind, `gate-x3-${scope}-${kind}`);
            const stored = await g.prepare(a.attempt);
            const offersBefore = (await footprint(a.src)).offers;
            const paused = ctx.points.pause("bank:offer-committed");
            const running = onFresh(ctx, () => (command === "RECORD" ? recordG2(a.attempt, stored) : resolveX3(a.attempt, "EXECUTED", stored)));
            await reach(paused, running, `${scope} ${kind} ${command}: the offer point`);
            assert.equal((await footprint(a.src)).offers, offersBefore + 1, `${scope} ${kind} ${command}: the offer is committed before the evidence is read`);
            paused.release();
            await running;
            const outcomes = await q<{ gate_outcome: string; footprint: string }>("SELECT x.gate_outcome, x.footprint FROM kauro.execution_offer_outcomes x JOIN kauro.execution_offers o USING (offer_id) WHERE o.attempt_id = $1", [a.attempt.attemptId]);
            assert.equal(outcomes.length, 1, `${scope} ${kind} ${command}: one outcome row`);
            if (await attemptState(a.attempt.attemptId) !== "RECORDED") {
              if (command === "RECORD") await windowEdge(ctx, a.attempt, 1, `${scope} ${kind}: lapse before NOT_EXECUTED`);
              await coveredForNx(ctx, a.attempt);
              assertRefused(await onClock(ctx, "X3 NOT_EXECUTED", () => resolveX3(a.attempt, "NOT_EXECUTED", null)), "409 CONTRADICTORY_EVIDENCE", `${scope} ${kind} ${command}: the offer blocks NOT_EXECUTED`);
            }
          }
    });
  });
}

cell("RACE RFG-M-OFFER-RACE (both orders): Koffer for attempt A against X3 NOT_EXECUTED of A — Koffer first: NOT_EXECUTED refused CONTRADICTORY_EVIDENCE; X3 first: NOT_EXECUTED commits, then Koffer commits its row, opens REFUND_TERMINAL_CONTRADICTED and freezes the open refunds of the source", "race", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await lapsed(ctx, scope, kind, `offer-race-a-${scope}-${kind}`);
      await coveredForNx(ctx, a.attempt);
      const koffer = await hw(ctx, `${scope} ${kind}: Koffer first`, bank(() => onClock(ctx, "Koffer", async () => recordG2(a.attempt, await storeExecution(a.attempt, { full: null, accountLast4: null })))), bank(() => onClock(ctx, "X3", () => resolveX3(a.attempt, "NOT_EXECUTED", null))), "uow.before-commit", [], );
      valueOf(koffer.held);
      assertRefused(valueOf(koffer.waited), "409 CONTRADICTORY_EVIDENCE", `${scope} ${kind}: Koffer first`);
      const b = await lapsed(ctx, scope, kind, `offer-race-b-${scope}-${kind}`);
      await coveredForNx(ctx, b.attempt);
      const x3 = await hw(ctx, `${scope} ${kind}: X3 first`, bank(() => onClock(ctx, "X3", () => resolveX3(b.attempt, "NOT_EXECUTED", null))), bank(() => onClock(ctx, "Koffer", async () => recordG2(b.attempt, await storeExecution(b.attempt)))));
      assert.equal(valueOf(x3.held).status, 200);
      assert.equal((await footprint(b.src)).offers, 1, "Koffer commits its row");
      assert.equal(await openCases(b.src, "REFUND_TERMINAL_CONTRADICTED"), 1);
      assert.equal((await footprint(b.src)).freezes, 1);
    }
});

cell("RACE RFG-M-OFFER-OUTCOME-RACE (both orders): the outcome transaction of A against X3 NOT_EXECUTED of A — NOT_EXECUTED refused in both orders because the offer row exists", "race", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS)
      for (const order of ["outcome first", "X3 first"]) {
        const a = await lapsed(ctx, scope, kind, `outcome-race-${scope}-${kind}`);
        await coveredForNx(ctx, a.attempt);
        const rec = bank(() => onClock(ctx, "outcome", async () => recordG2(a.attempt, await storeExecution(a.attempt, { full: null, accountLast4: null }))));
        const x3 = bank(() => onClock(ctx, "X3", () => resolveX3(a.attempt, "NOT_EXECUTED", null)));
        if (order === "outcome first") {
          const r = await hw(ctx, `${scope} ${kind} ${order}`, rec, x3, "bank:outcome-locked");
          assertRefused(valueOf(r.waited) as Reply, "409 CONTRADICTORY_EVIDENCE", `${scope} ${kind} ${order}`);
        } else {
          // X3 first: the Koffer row is committed (the record stands between its offer and its outcome) when X3 judges the attempt
          const paused = ctx.points.pause("bank:gate-read");
          const running = onClock(ctx, "Koffer", () => onFresh(ctx, async () => recordG2(a.attempt, await storeExecution(a.attempt, { full: null, accountLast4: null }))));
          await reach(paused, running, `${scope} ${kind} ${order}: the offer point`);
          assertRefused(await onClock(ctx, "X3", () => resolveX3(a.attempt, "NOT_EXECUTED", null)), "409 CONTRADICTORY_EVIDENCE", `${scope} ${kind} ${order}`);
          paused.release();
          await running;
        }
        assert.equal(await attemptState(a.attempt.attemptId), "UNCERTAIN");
      }
});

cell("RACE RFG-M-OFFER-TIMEOUT (Koffer lock or COMMIT timeout): Record a declared execution — no row or the one committed row; the same key finds it", "race", async (ctx) => {
  const { iw, bw } = L();
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await openAttempt(scope, kind, `offer-timeout-${scope}-${kind}`);
      const receipt = await storeExecution(a.attempt);
      const key = freshKey("offer-timeout");
      const held = await bw.holdOutboundStream();
      iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
      try {
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => recordG2(a.attempt, receipt, { key })), `${scope} ${kind}: Koffer waiting on L1`);
        assert.ok(valueOf(await waiting.pending).status >= 400);
      } finally {
        iw.faults.statementTimeoutMs = null;
        await held.release();
      }
      assert.equal((await footprint(a.src)).offers, 0, `${scope} ${kind}: no row`);
      dataOf<RecordView>(await recordG2(a.attempt, receipt, { key }), 200, "same key");
      dataOf<RecordView>(await recordG2(a.attempt, receipt, { key }), 200, "replay");
      assert.equal((await footprint(a.src)).offers, 1, `${scope} ${kind}: the one committed row`);
    }
});

cell(
  "RACE RFG-M-OFFER-CRASH-BEFORE (crash before the Koffer COMMIT): Record a declared execution — no offer row; the replay writes exactly one",
  "crash-before-commit",
  async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of KINDS) {
        const a = await openAttempt(scope, kind, `offer-crb-${scope}-${kind}`);
        const receipt = await storeExecution(a.attempt);
        const key = freshKey("offer-crb");
        ctx.points.crash("target.before-commit");
        await ctx.operation(`${scope} ${kind}: Koffer dying`, () => onFresh(ctx, () => recordG2(a.attempt, receipt, { key }), [], 1));
        assert.equal((await footprint(a.src)).offers, 0, "no offer row");
        dataOf<RecordView>(await recordG2(a.attempt, receipt, { key }), 200, "replay");
        assert.equal((await footprint(a.src)).offers, 1, "exactly one");
      }
  },
  "target",
);

cell(
  "RACE RFG-M-OFFER-CRASH-BETWEEN (crash after the Koffer COMMIT, before the outcome COMMIT): Record a declared execution — the offer row stands and blocks NOT_EXECUTED; the replay reruns G1 and writes one outcome",
  "crash-after-commit",
  async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of KINDS) {
        const a = await lapsed(ctx, scope, kind, `offer-between-${scope}-${kind}`);
        const receipt = await storeExecution(a.attempt);
        const key = freshKey("offer-between");
        ctx.points.crash("target.after-commit");
        await ctx.operation(`${scope} ${kind}: crash between`, () => onFresh(ctx, () => recordG2(a.attempt, receipt, { key }), [], 1));
        const fp = await footprint(a.src);
        assert.deepEqual([fp.offers, fp.outcomes], [1, 0], `${scope} ${kind}: the offer stands, no outcome`);
        await coveredForNx(ctx, a.attempt);
        assertRefused(await onClock(ctx, "X3", () => resolveX3(a.attempt, "NOT_EXECUTED", null)), "409 CONTRADICTORY_EVIDENCE", "the offer blocks NOT_EXECUTED");
        dataOf<RecordView>(await recordG2(a.attempt, receipt, { key }), 200, "replay");
        assert.deepEqual([(await footprint(a.src)).offers, (await footprint(a.src)).outcomes], [1, 1], "one outcome");
      }
  },
  "target",
);

cell(
  "RACE RFG-M-OFFER-CRASH-AFTER (lost outcome answer): Record a declared execution — the replay returns the committed outcome",
  "crash-after-commit",
  async (ctx) => {
    for (const scope of SCOPES)
      for (const kind of KINDS) {
        const a = await openAttempt(scope, kind, `offer-cra-${scope}-${kind}`);
        const receipt = await storeExecution(a.attempt);
        const key = freshKey("offer-cra");
        ctx.points.crash("target.after-commit");
        await ctx.operation(`${scope} ${kind}: outcome answer lost`, () => onFresh(ctx, () => recordG2(a.attempt, receipt, { key }), [], 2));
        assert.equal(await attemptState(a.attempt.attemptId), "RECORDED");
        const replay = dataOf<RecordView>(await recordG2(a.attempt, receipt, { key }), 200, "replay");
        assert.equal(replay.attempt.state, "RECORDED");
        assert.deepEqual([(await footprint(a.src)).offers, (await footprint(a.src)).outcomes], [1, 1]);
      }
  },
  "target",
);

cell("RACE RFG-M-OFFER-RETRY (same key replay, same evidence under another key): Record a declared execution — one offer row per key; the replay adds none", "retry", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await openAttempt(scope, kind, `offer-retry-${scope}-${kind}`);
      const receipt = await storeExecution(a.attempt, { full: null, accountLast4: null });
      const key = freshKey("offer-retry");
      await ctx.attempt(() => recordG2(a.attempt, receipt, { key }));
      await ctx.attempt(() => recordG2(a.attempt, receipt, { key }));
      assert.equal((await footprint(a.src)).offers, 1, `${scope} ${kind}: the replay adds none`);
      await ctx.attempt(() => recordG2(a.attempt, receipt));
      assert.equal((await footprint(a.src)).offers, 2, `${scope} ${kind}: another key adds its own offer`);
    }
});

cell("RACE RFG-M-OFFER-PARTIAL (a later write of Koffer fails; a later write of the outcome step fails): Record a declared execution — Koffer rolls back whole; the outcome step rolls back whole and leaves the offer", "partial", async (ctx) => {
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await openAttempt(scope, kind, `offer-partial-${scope}-${kind}`);
      const receipt = await storeExecution(a.attempt);
      const key = freshKey("offer-partial");
      await failsAt(ctx, `${scope} ${kind}: Koffer failing after its offer insert`, "db.audit_insert.before", () => recordG2(a.attempt, receipt, { key }), [OFFER_INSERT, AUDIT_INSERT], 1);
      assert.equal((await footprint(a.src)).offers, 0, "Koffer rolls back whole");
      await failsAt(ctx, `${scope} ${kind}: the outcome step failing after its outcome insert`, "db.event_insert.before", () => recordG2(a.attempt, receipt, { key }), [OUTCOME_INSERT, ATTEMPT_UPDATE, EVENT_INSERT], 2);
      const fp = await footprint(a.src);
      assert.deepEqual([fp.offers, fp.outcomes, await attemptState(a.attempt.attemptId)], [1, 0, a.attempt.state], `${scope} ${kind}: the offer stays, the outcome rolled back`);
    }
});

cell("DENY RFG-M-OFFER-UNAUTHORIZED (non-owner, no step-up, revoked grant at the Koffer lock): Record a declared execution — no offer row; DENY fact only", "revocation", async (ctx) => {
  const { iw, bw } = L();
  for (const scope of SCOPES)
    for (const kind of KINDS) {
      const a = await openAttempt(scope, kind, `offer-unauth-${scope}-${kind}`);
      const receipt = await storeExecution(a.attempt);
      assertRefused(await recordG2(a.attempt, receipt, { owner: iw.w.owner }), "403 CORPORATE_ROLE_MISSING", `${scope} ${kind}: non-owner`);
      assertRefused(await recordG2(a.attempt, receipt, { stepUp: "STALE" }), "403 STEP_UP_STALE", `${scope} ${kind}: no step-up`);
      const o = await ownOwner(`offer-unauth-${scope}-${kind}`);
      const held = await bw.holdOutboundStream();
      try {
        const proof = await iw.w.stepUp(o.person);
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => recordG2(a.attempt, receipt, { owner: o.person, proof })), `${scope} ${kind}: Koffer at L1`);
        await ctx.revoked(`${scope} ${kind}: grant`, () => iw.h.revokeCorporateGrant(o.grantId));
        await held.release();
        await ctx.fenced(`${scope} ${kind}: Koffer after the revocation`, () => asRefusal(waiting.pending.then(valueOf)), refusedWith(/^403 /));
      } finally {
        await held.release();
      }
      assert.equal((await footprint(a.src)).offers, 0, `${scope} ${kind}: no offer row`);
    }
});

// --- §7.28 lock order ------------------------------------------------------------------------------------------------------------------

cell("RACE RFG-M-LOCK-L1 (opposite order): an actor holding a source booking lock never waits for the outbound-stream lock — G6 holds L2 while SI2 holds L1 and wants L2, both orders, no 40P01", "race", async (ctx) => {
  const reverse = (L().bw as unknown as { reverseCredit?: (id: string, cents: bigint) => Promise<void> }).reverseCredit;
  for (const scope of SCOPES) {
    const { src, attempt } = await declared(scope, `lock-l1-${scope}`);
    const stmt = await statementWith(plusMs(attempt.declaredAt, -60_000), plusMs(attempt.declaredAt, 60_000), [{ amountCents: BigInt(attempt.amountCents), reference: attempt.reference }]);
    // X1 of another refund holds L1 then L2 (DECLARE_LOCKED); SI2 waits on L1, never the reverse
    const other = await approved(scope, `lock-l1-other-${scope}`);
    const r = await hw(ctx, `${scope}: X1 holds L1->L2, SI2 waits on L1`, bank(() => declareX1(other)), bank(() => importSI2(stmt)), "bank:declare-locked");
    assert.equal(valueOf(r.held).status, 201);
    assert.notEqual(valueOf(r.waited).status, 500, `${scope}: no 40P01 deadlock`);
    if (reverse === undefined) throw new SeamMissing("S5", SEAMS.S5);
    await reverse(src.sourceId, src.totalCents);
  }
});

cell("RACE RFG-M-LOCK-L3 (sweep without L1): X2 and authorization_lapsed hold an attempt or refund row while X1 holds L1 and L2 and wants it, both orders, no 40P01", "race", async (ctx) => {
  for (const scope of SCOPES) {
    // X2 half: X2 holds the refund/attempt rows it lapses (L3 only), X1 of the same source (L1 -> L2 -> L3) waits; no 40P01
    const first = await declared(scope, `lock-l3-${scope}`);
    ctx.deadline(plusMs(first.attempt.declaredAt, routeTiming().manualExecutionWindowMs), `${scope}: window`);
    ctx.clock.past(plusMs(first.attempt.declaredAt, routeTiming().manualExecutionWindowMs));
    const x2First = await hw(ctx, `${scope}: X2 holds L3, X1 waits`, bank(() => onClock(ctx, "X2", () => sweepX2())), bank(() => declareX1(first.src)));
    valueOf(x2First.held);
    assertRefused(valueOf(x2First.waited), "409 EXECUTION_ATTEMPT_OPEN", `${scope}: X1 after X2, no deadlock`);
    assert.equal(await attemptState(first.attempt.attemptId), "UNCERTAIN");
    // authorization_lapsed half, both orders: the source's reversal lapses an APPROVED refund (B09), never a declared one (K-6)
    const lapse = async (src: Source): Promise<Reply> => {
      if (src.scope === "BANK_CREDIT") {
        const reverse = (L().bw as unknown as { reverseCredit?: (id: string, cents: bigint) => Promise<void> }).reverseCredit;
        if (reverse === undefined) throw new SeamMissing("S5", SEAMS.S5);
        await reverse(src.sourceId, src.totalCents);
        return { status: 200, headers: {}, contentType: undefined, text: "", json: <T>() => ({}) as T };
      }
      const { iw } = L();
      iw.pw.paypal.updateCapture(src.purchase!.providerCaptureId, { status: "REVERSED" });
      return reconcile(iw.pw, src.purchase!.orderId, { observationRef: await storeQuery(iw.pw, src.purchase!.providerOrderId) });
    };
    const lapsedFirst = await approved(scope, `lock-l3-lapse-a-${scope}`);
    const a = await hw(ctx, `${scope}: authorization_lapsed holds the refund row, X1 waits`, bank(() => lapse(lapsedFirst)), bank(() => declareX1(lapsedFirst)));
    valueOf(a.held);
    assert.ok(valueOf(a.waited).status === 409, `${scope}: X1 after the lapse is refused, no 40P01: ${valueOf(a.waited).text}`);
    assert.equal((await refundOf(lapsedFirst))?.state, "FAILED");
    const declaredFirst = await approved(scope, `lock-l3-lapse-b-${scope}`);
    const b = await hw(ctx, `${scope}: X1 holds L1 -> L3, authorization_lapsed waits`, bank(() => declareX1(declaredFirst)), bank(() => lapse(declaredFirst)), "bank:declare-locked");
    assert.equal(valueOf(b.held).status, 201, `${scope}: no 40P01`);
    valueOf(b.waited);
    assert.equal((await refundOf(declaredFirst))?.state, "SUBMITTING", `${scope}: authorization_lapsed skips the declared refund (K-6)`);
  }
});

// keep the imports this file names for the lane's builder in use
void [cmd033, KINDS, call, paymentRoutes, connectionPid, openConnection];
export type { HarnessConnection, Kind, Scope };
