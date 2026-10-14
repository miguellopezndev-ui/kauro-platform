// Lane PV1-SETTLE (PAYMENTS-V1, tier 1 MONEY), two-step (docs/design/PV1-SETTLE-two-step.md D-SET-10, §4 matrix, §5 cells 1-21): ST1
// classify settlement evidence, ST2 CMD215 records the owner's intent (kauro_app), ST3 the PAYMENT_SERVICE consumer applies it
// (kauro_payment, applySettlement). Titles: `<VERB> SET-M-<row>-<COL> (<family>): <row label>`. Lock traces: §3.2 R / §3.3 A steps.
//
// CONTRACT
//   CMD215 POST /api/v1/operations/bank-accounts/{accountRef}/settlements
//     { artifactRef, evidenceHash, receipt: { artifactRef, evidenceHash } | null, authorizationRef }
//     -> 201 { settlementRequest: { requestId, accountRef, withdrawalId, state: "RECORDED", requestedAt } }
//     R2 INBOUND stream lock, R3 hold bank:settlement-locked, R5 a live intent/settlement of the withdrawal or bank tx -> 409
//     WITHDRAWAL_ALREADY_SETTLED (a 23505 of either live index mapped the same), R8 INSERT + recorded.v1 + outbox + journal; no money.
//   ST3 on settlement_request.recorded.v1: A1 read (absent NOT_APPLICABLE, consumed DUPLICATE), A1b re-verify (EVIDENCE_MISMATCH),
//     A2 L1 OUTBOUND, A3 INBOUND, A4 payout-cash, A5 row FOR NO KEY UPDATE, A6 at = uow.effectNow() (µs), A7 refusals in order, A8 apply.
//   GET .../settlements/{requestId} (outcome) and GET .../settlements?cursor= (in transit).
// Fixture notes: settlement-support.ts header (FIXTURE GAP of the provider-available balance; the lane dispatcher).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { fakeCreditBytes, fakeSettlementBytes } from "@kauro/application/testing";
import { LOCK_WAIT_OBSERVATION_MS, connectionPid, openConnection, runCell, type FaultContext, type FaultKind, type HarnessConnection } from "@kauro/persistence/testing";
import type { PayoutIntentView, PeriodCloseView } from "@kauro/application";
import { paymentServiceEffect } from "../src/payments/consumers.js";
import { DISPATCH_LEASE_SECONDS, OUTBOX_CLAIM_SECONDS } from "../src/payments/dispatcher.js";
import { BANK_PAYEE_DIGEST } from "./bank-support.js";
import type { SqlStep } from "./fault-support.js";
import { agentOf } from "./integration-support.js";
import { approvePayout, bankCash, claimedCents, closeMonth, eligibleLines, intentOf, reconcilePayout, scriptEvidence, seller, statementsOfSeller } from "./statements-support.js";
import { completed, freshKey, ids, type Reply } from "./support.js";
import {
  L,
  OWNER_PREREQUISITES,
  code,
  holdAndWait,
  holdStream,
  onClock,
  onFresh,
  openApp,
  openPay,
  ownOwner,
  ownerGet,
  plusMs,
  proofOf,
  q,
  reach,
  revokeOwner,
  routed,
  startLane,
  stopLane,
  valueOf,
} from "./inbound-lane-support.js";
import {
  HOUR,
  MINUTE,
  STALE_AFTER_MS,
  advance,
  assertBalanced,
  availableOf,
  casesOf,
  crossHold,
  deliver,
  deliveryIn,
  directRequest,
  dispatchPayment,
  drain,
  fenceRead,
  footprint,
  getRequest,
  holdPayoutCash,
  inTransit,
  laneRuntime,
  outboxOf,
  outcomeOf,
  payoutBasis,
  postingsOf,
  providerAvailable,
  recordOf,
  recorded,
  recordedEventOf,
  replayedBody,
  requestRoute,
  requestRow,
  requestsOf,
  sameButJournal,
  settle,
  settledOf,
  store,
  takeOver,
  twoStep,
  withdrawal,
  type Withdrawal,
} from "./settlement-support.js";

before(async () => {
  await startLane();
});
after(async () => {
  await stopLane();
});

const LOCK_TIMEOUT_MS = Math.floor(LOCK_WAIT_OBSERVATION_MS / 4);
const LOSER = "409 PRECONDITION_FAILED WITHDRAWAL_ALREADY_SETTLED";
const INSERT_REQUEST: SqlStep = { label: "first_write", match: /INSERT INTO kauro\.settlement_requests/ };
const SETTLEMENT_INSERT: SqlStep = { label: "settlement_insert", match: /INSERT INTO kauro\.settlements/ };
const CASE_INSERT: SqlStep = { label: "case_insert", match: /INSERT INTO kauro\.bank_review_cases/ };
const REQUEST_UPDATE: SqlStep = { label: "request_update", match: /UPDATE kauro\.settlement_requests/ };

function cell(title: string, fault: FaultKind, body: (ctx: FaultContext) => Promise<void>, at?: string): void {
  test(title, async () => {
    await runCell({ id: title.split(" ")[1]!, step: title, fault, ...(at === undefined ? {} : { at }), expect: title.slice(title.indexOf(": ") + 2) }, body);
  });
}
class Refused extends Error {
  constructor(readonly reply: Reply) {
    super(`${reply.status} ${reply.text}`);
  }
}
const refusedAs = (expected: string) => (e: unknown): boolean => e instanceof Refused && code(e.reply) === expected;
const asRefusal = async (p: Promise<Reply>): Promise<Reply> => {
  const r = await p;
  if (r.status >= 400) throw new Refused(r);
  return r;
};
/** An apply that ended in a refusal, as an error (ctx.fenced needs the refused operation to reject). */
class ApplyRefused extends Error {
  constructor(readonly reason: string | null) {
    super(`the apply refused the intent: ${String(reason)}`);
  }
}
const refusedApply = async (requestId: string, run: () => Promise<string>): Promise<string> => {
  const out = await run();
  const r = await requestRow(requestId);
  if (r.state === "REFUSED") throw new ApplyRefused(r.reason);
  return out;
};
class Held extends Error {}
const isoMs = (text: string): string => new Date(Date.parse(text)).toISOString();
const settlementOf = async (w: Pick<Withdrawal, "accountRef" | "withdrawalId">): Promise<{ readonly id: string; readonly createdAt: string; readonly recordedBy: string; readonly requestId: string | null } | undefined> =>
  (
    await q<{ id: string; c: string; by: string; r: string | null }>(
      `SELECT settlement_id::text AS id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS c, recorded_by::text AS by, request_id::text AS r
         FROM kauro.settlements WHERE account_ref = $1 AND withdrawal_id = $2`,
      [w.accountRef, w.withdrawalId],
    )
  ).map((r) => ({ id: r.id, createdAt: r.c, recordedBy: r.by, requestId: r.r }))[0];

// --- ST1 classify settlement evidence (cell 1) ----------------------------------------------------------------------------------------

{
  const t = (verb: string, col: string, family: string): string => `${verb} SET-M-ST1-${col} (${family}): Classify settlement evidence`;
  async function withStoreHook<T>(artifactRef: string, hook: () => Promise<void>, fn: () => Promise<T>): Promise<T> {
    const evidence = L().bw.evidence as unknown as { get: (ref: string) => Promise<unknown> };
    const real = evidence.get;
    evidence.get = async (ref: string) => {
      if (ref === artifactRef) await hook();
      return real.call(L().bw.evidence, ref);
    };
    try {
      return await fn();
    } finally {
      evidence.get = real;
    }
  }

  cell(t("RACE", "TIMEOUT", "store timeout"), "timeout", async (ctx) => {
    for (const which of ["settlement", "receipt"] as const) {
      const w = await withdrawal(`st1-timeout-${which}`);
      const before = await footprint(w);
      const deadline = ctx.deadline(ctx.clock.at(PROVIDER_CALL_TIMEOUT_MS), `the ${which} read's bound`);
      const ref = which === "settlement" ? w.settlement.artifactRef : w.receipt!.artifactRef;
      const r = await withStoreHook(ref, async () => { ctx.clock.past(deadline); await new Promise((res) => setTimeout(res, 120)); }, () => onClock(ctx, `CMD215 whose ${which} read outlives its bound`, () => w.run()));
      assert.equal(code(r), "503 CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE", `${which}: unread evidence records nothing`);
      assert.equal(await w.effect(), "NONE");
      assert.deepEqual(sameButJournal(await footprint(w), before), before, `${which}: nothing written, no intent`);
    }
  });

  cell(t("DENY", "RETRY", "replay and rejected evidence"), "retry", async (ctx) => {
    const w = await withdrawal("st1-retry");
    const before = await footprint(w);
    const now = Date.now();
    const malformed = await store(w.accountRef, fakeSettlementBytes(w.accountRef, { currency: "USD", periodStart: new Date(now - 3 * HOUR).toISOString(), periodEnd: new Date(now - HOUR).toISOString(), withdrawalId: "wd-st1-absent", grossCents: 100n, feeCents: 0n, heldCents: 0n, withdrawnCents: null, observedAt: new Date(now - HOUR).toISOString() }));
    const first = code(await ctx.attempt(() => settle(w.accountRef, malformed, null)));
    const again = code(await ctx.attempt(() => settle(w.accountRef, malformed, null)));
    assert.equal(first, again, "same digest, same result");
    assert.equal(first, "422 INTEGRITY_FAILURE MALFORMED_EVIDENCE", "an absent figure is malformed, never 0");
    const credit = await store(w.accountRef, fakeCreditBytes(w.accountRef, { creditId: "txn-st1-credit", rail: "ACH", currency: "USD", grossCents: 100n, feeCents: 0n, netCents: 100n, payeeDigest: BANK_PAYEE_DIGEST, reference: null, payerDigest: null as never, payerEvidenceRef: null, status: "COMPLETED", bookedAt: new Date(Date.now() - HOUR).toISOString(), observedAt: new Date(Date.now() - HOUR).toISOString() }));
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, credit, null))), "422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "a credit artifact is not a settlement");
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, w.receipt!, null))), "422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "a receipt is not a settlement record");
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, w.settlement, w.settlement))), "422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "a settlement record is not a receipt");
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, { artifactRef: w.settlement.artifactRef, evidenceHash: w.receipt!.evidenceHash }, w.receipt))), "422 INTEGRITY_FAILURE HASH_MISMATCH");
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, w.settlement, { artifactRef: w.receipt!.artifactRef, evidenceHash: w.settlement.evidenceHash }))), "422 INTEGRITY_FAILURE HASH_MISMATCH", "the receipt is re-verified too");
    const replaced = await withdrawal("st1-retry-replaced");
    L().bw.evidence.corrupt(replaced.settlement.artifactRef, new TextEncoder().encode("replaced"));
    assert.equal(code(await ctx.attempt(() => replaced.run())), "422 INTEGRITY_FAILURE HASH_MISMATCH", "replaced bytes record nothing");
    const other = await withdrawal("st1-retry-other");
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, other.settlement, null))), "422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "another account's record");
    assert.deepEqual(sameButJournal(await footprint(w), before), before, "no refused evidence left an intent");
    // the valid bytes classify the same way every time: the command answers them once (one intent, no money), then replays
    const key = freshKey("st1-valid");
    const ok = await ctx.attempt(() => w.run({ key }));
    recordOf(ok, w);
    assert.equal(replayedBody((await ctx.attempt(() => w.run({ key }))).text), replayedBody(ok.text), "same digest, same answer");
    const fp = await footprint(w);
    assert.deepEqual(fp.requests, [["RECORDED", null]], "only the valid evidence recorded an intent");
    assert.deepEqual(fp.settlements, before.settlements, "the record step settles nothing");
    assert.deepEqual(await requestsOf(replaced), []);
  });
}

// --- ST2 CMD215 record the settlement intent (cells 2-9) ----------------------------------------------------------------------------

{
  const t = (verb: string, col: string, family: string): string => `${verb} SET-M-ST2-${col} (${family}): Record settlement observation`;
  const LATER_WRITES: ReadonlyArray<SqlStep> = [
    { label: "event_insert", match: /INSERT INTO kauro\.domain_events/ },
    { label: "outbox_insert", match: /INSERT INTO kauro\.outbox_records/ },
    { label: "journal_final", match: /UPDATE kauro\.command_journal/ },
  ];

  cell(t("RACE", "RACE", "both orders"), "race", async (ctx) => {
    // (1) one withdrawal, two owners: the holder paused at R3 (INBOUND held, nothing inserted), the waiter observed waiting at R2
    for (const first of ["owner A holds", "owner B holds"]) {
      const w = await withdrawal(`st2-race-same-${first}`);
      const a = await ownOwner(`st2-a-${first}`);
      const b = await ownOwner(`st2-b-${first}`);
      const [holder, waiter] = first === "owner A holds" ? [a, b] : [b, a];
      const r = await holdAndWait(ctx, `${first}: CMD215 vs CMD215 on one withdrawal`, () => w.run({ owner: holder.person, key: freshKey("holder") }), () => w.run({ owner: waiter.person, key: freshKey("waiter") }), "bank:settlement-locked");
      recordOf(valueOf(r.held), w, `${first}: the holder`);
      assert.equal(code(valueOf(r.waited)), LOSER, `${first}: the waiter sees the holder's live intent`);
      assert.deepEqual(await requestsOf(w), [["RECORDED", null]], `${first}: exactly one intent`);
      assert.deepEqual((await footprint(w)).settlements, [], `${first}: the record step moves no money`);
    }
    // (2) a record vs the consumer refusing the previous intent of the same withdrawal (it holds A2-A4, INBOUND among them), both orders
    {
      const { w, requestId } = await recorded("st2-race-refusing-holds", { fund: 0n });
      const r = await crossHold(ctx, "the consumer refusing the previous intent holds INBOUND; CMD215 waits at R2", { side: "pay", at: "db.request_update.before", steps: [REQUEST_UPDATE], run: () => deliver(requestId) }, { side: "app", run: () => w.run() });
      assert.equal(valueOf(r.held), "APPLIED", "the refusal is the consumer's applied outcome");
      assert.deepEqual([(await requestRow(requestId)).state, (await requestRow(requestId)).reason], ["REFUSED", "FUNDS_UNAVAILABLE"]);
      recordOf(valueOf(r.waited), w, "the record after the refusal committed (no live intent left)");
      assert.deepEqual(await requestsOf(w), [["REFUSED", "FUNDS_UNAVAILABLE"], ["RECORDED", null]]);
    }
    {
      const { w, requestId } = await recorded("st2-race-record-holds", { fund: 0n });
      const r = await crossHold(ctx, "CMD215 holds INBOUND at R3; the consumer waits at A3", { side: "app", at: "bank:settlement-locked", run: () => w.run() }, { side: "pay", run: () => deliver(requestId) });
      assert.equal(code(valueOf(r.held)), LOSER, "the record judged the intent still live");
      assert.equal(valueOf(r.waited), "APPLIED");
      assert.deepEqual(await requestsOf(w), [["REFUSED", "FUNDS_UNAVAILABLE"]], "one intent, refused after the record released INBOUND");
    }
    // (3) two accounts citing one receiving bank transaction: the waiter blocks in R8 on the cross-account live index
    {
      const one = await withdrawal("st2-race-btx-a");
      const two = await withdrawal("st2-race-btx-b", { bankTransactionId: one.bankTransactionId, receivingAccountRef: one.receivingAccountRef });
      assert.notEqual(one.accountRef, two.accountRef, "two provider accounts");
      const r = await holdAndWait(ctx, "two accounts, one bank transaction: the waiter blocks on the live index", () => one.run(), () => two.run());
      recordOf(valueOf(r.held), one, "the holder");
      assert.equal(code(valueOf(r.waited)), LOSER, "the 23505 of the live bank-transaction index is the loser's 409, never a 500");
      assert.deepEqual([await requestsOf(one), await requestsOf(two)], [[["RECORDED", null]], []]);
    }
    {
      const one = await withdrawal("st2-race-btx-killed-a");
      const two = await withdrawal("st2-race-btx-killed-b", { bankTransactionId: one.bankTransactionId, receivingAccountRef: one.receivingAccountRef });
      const r = await crossHold(ctx, "the holder of the bank transaction killed before COMMIT", { side: "app", at: "uow.before-commit", run: () => one.run() }, { side: "app", run: () => two.run() }, "kill");
      assert.ok(r.held.status === "rejected" || valueOf(r.held).status >= 500, "the killed holder recorded nothing");
      recordOf(valueOf(r.waited), two, "the waiter, once the holder's entry vanished");
      assert.deepEqual([await requestsOf(one), await requestsOf(two)], [[], [["RECORDED", null]]]);
    }
  });

  cell(t("RACE", "TIMEOUT", "lock and COMMIT timeout"), "race", async (ctx) => {
    const { iw } = L();
    const w = await withdrawal("st2-timeout");
    const key = freshKey("timeout");
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    let r: Awaited<ReturnType<typeof holdAndWait<Reply, Reply>>>;
    try {
      r = await holdAndWait(ctx, "CMD215 timing out at R2 behind the holder", () => w.run({ key: freshKey("holder") }), () => w.run({ key }));
    } finally {
      iw.faults.statementTimeoutMs = null;
    }
    recordOf(valueOf(r.held), w, "the holder");
    const timedOut = valueOf(r.waited);
    assert.ok(timedOut.status >= 500, `the waiter timed out and wrote nothing: ${timedOut.status} ${timedOut.text}`);
    const fp = await footprint(w);
    assert.deepEqual(fp.requests, [["RECORDED", null]], "only the holder's intent");
    assert.equal(code(await w.run({ key })), LOSER, "the same key, once the holder committed, is the loser's answer");
    assert.deepEqual(sameButJournal(await footprint(w), fp), fp, "the recovery wrote nothing");
  });

  cell(t("DENY", "EXPIRY", "period end and step-up"), "expiry", async (ctx) => {
    const { proof, expiresAt } = await proofOf();
    ctx.deadline(expiresAt, "the owner's step-up validity");
    const effect = plusMs(expiresAt, -1);
    const ok = await withdrawal("st2-expiry-ok", { at: effect });
    ctx.clock.set(effect);
    const fresh = await onClock(ctx, "CMD215 at the effect instant, 1 ms before the proof expires", () => ok.run({ proof }));
    recordOf(fresh, ok, "an observation ending at the effect instant");
    for (const late of ["periodEnd", "observedAt", "bookedAt", "receiptObservedAt"] as const) {
      const future = await withdrawal(`st2-expiry-future-${late}`, { at: effect, instants: { [late]: plusMs(effect, 1) } });
      const before = await footprint(future);
      assert.equal(code(await onClock(ctx, `CMD215 whose ${late} ends 1 ms after the effect instant`, () => future.run({ proof }))), "409 PRECONDITION_FAILED COVERAGE_END_IN_FUTURE", `${late} end > effectNow`);
      assert.deepEqual(sameButJournal(await footprint(future), before), before, `${late}: nothing written, no intent`);
    }
    const stale = await withdrawal("st2-expiry-stale");
    const before = await footprint(stale);
    ctx.clock.set(plusMs(expiresAt, 1));
    assert.equal(code(await onClock(ctx, "CMD215 1 ms after the proof expired", () => stale.run({ proof }))), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "+1 ms: judged at the effect clock");
    assert.deepEqual(sameButJournal(await footprint(stale), before), before, "nothing written, no intent");
    assert.equal(await stale.effect(), "NONE");
  });

  cell(
    t("RACE", "CRASH-BEFORE", "crash before Krecord COMMIT"),
    "crash-before-commit",
    async (ctx) => {
      const w = await withdrawal("st2-crb");
      const key = freshKey("crb");
      const before = await footprint(w);
      ctx.points.crash("uow.before-commit");
      const crashed = await ctx.operation("CMD215 dying before COMMIT", () => onFresh(ctx, () => w.run({ key })));
      assert.equal(crashed.status, 500, `the step reached its COMMIT and died there: ${crashed.text}`);
      assert.equal(await w.effect(), "NONE");
      assert.deepEqual(await footprint(w), before, "atomic: no intent, event, outbox, journal");
      const again = await w.run({ key });
      recordOf(again, w, "the same key after the crash");
      assert.deepEqual((await footprint(w)).requests, [["RECORDED", null]], "then exactly one intent");
      assert.deepEqual((await footprint(w)).settlements, [], "and no money moved by the record");
    },
    "uow",
  );

  cell(
    t("RACE", "CRASH-AFTER", "lost answer"),
    "crash-after-commit",
    async (ctx) => {
      const w = await withdrawal("st2-cra");
      const key = freshKey("cra");
      ctx.points.crash("uow.after-commit");
      const lost = await ctx.operation("CMD215 answer lost", () => onFresh(ctx, () => w.run({ key })));
      assert.equal(lost.status, 500, `the answer was lost after COMMIT: ${lost.text}`);
      assert.equal(await w.effect(), "RECORDED", "the intent committed");
      const fp = await footprint(w);
      assert.deepEqual([fp.requests, fp.settlements, fp.ledger, fp.requestEvents], [[["RECORDED", null]], [], [], 1], "an intent and its recorded.v1, no settlement, no posting");
      const replay = await w.run({ key });
      const view = recordOf(replay, w, "the same key returns the committed intent");
      assert.deepEqual(sameButJournal(await footprint(w), fp), fp, "the replay wrote nothing");
      assert.equal(await deliver(view.requestId), "APPLIED", "delivered: applied once");
      assert.deepEqual((await footprint(w)).ledger, postingsOf(w), "one balanced set");
      assert.equal(await deliver(view.requestId), "DUPLICATE", "delivered again: nothing more");
      assert.equal((await footprint(w)).settlements.length, 1);
    },
    "uow",
  );

  cell(t("RACE", "RETRY", "replay and conflict"), "retry", async (ctx) => {
    const w = await withdrawal("st2-retry");
    const key = freshKey("retry");
    const first = await ctx.attempt(() => w.run({ key }));
    const view = recordOf(first, w);
    const fp = await footprint(w);
    // (1) identical replay
    const replay = await ctx.attempt(() => w.run({ key }));
    assert.equal(replayedBody(replay.text), replayedBody(first.text), "the same body (the replayed flag aside)");
    assert.deepEqual(sameButJournal(await footprint(w), fp), fp, "the replay writes nothing");
    // (2) same key, other body
    assert.equal(code(await ctx.attempt(() => w.run({ key, variant: true }))), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
    // (3) a new key while the intent is RECORDED, then after it was APPLIED
    assert.equal(code(await ctx.attempt(() => w.run({ key: freshKey("again-recorded") }))), LOSER, "a live intent: no second one");
    assert.equal(await deliver(view.requestId), "APPLIED");
    assert.equal(code(await ctx.attempt(() => w.run({ key: freshKey("again-applied") }))), LOSER, "an applied intent: no second settlement");
    // (4) another withdrawal whose receipt cites the bank transaction already applied
    const reused = await withdrawal("st2-retry-btx", { route: w.route, bankTransactionId: w.bankTransactionId, receivingAccountRef: w.receivingAccountRef });
    assert.equal(code(await ctx.attempt(() => reused.run())), LOSER, "one settlement per bank transaction");
    assert.equal(await reused.effect(), "NONE");
    // (5) after a REFUSED intent the owner may record again
    const { w: refused, requestId } = await recorded("st2-retry-refused", { fund: 0n });
    assert.equal(await deliver(requestId), "APPLIED");
    assert.deepEqual(await requestsOf(refused), [["REFUSED", "FUNDS_UNAVAILABLE"]]);
    const again = recordOf(await ctx.attempt(() => refused.run({ key: freshKey("after-refused") })), refused, "a new intent after the refusal");
    assert.notEqual(again.requestId, requestId);
    assert.deepEqual(await requestsOf(refused), [["REFUSED", "FUNDS_UNAVAILABLE"], ["RECORDED", null]]);
    assert.deepEqual((await footprint(w)).ledger, postingsOf(w), "exactly one set for the applied withdrawal");
    await assertBalanced(w, "retry");
  });

  cell(t("DENY", "REVOCATION", "each prerequisite"), "revocation", async (ctx) => {
    const { bw } = L();
    for (const what of OWNER_PREREQUISITES) {
      const o = await ownOwner(`st2-revoke-${what}`);
      const w = await withdrawal(`st2-revoke-${what}`);
      const before = await footprint(w);
      const { proof } = await proofOf(o.person);
      // R2: INBOUND is CMD215's first lock (OUTBOUND is the apply's)
      const held = await holdStream(w.accountRef, "INBOUND");
      try {
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => w.run({ owner: o.person, proof })), "CMD215 held at its first lock", "kauro_app_test");
        await ctx.revoked(`${what} while CMD215 is held`, () => revokeOwner(what, o, proof));
        await held.release();
        const expected = what === "grant" ? "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING" : what === "identity" ? "403 NOT_AUTHORIZED IDENTITY_DISABLED" : "403 ASSURANCE_REQUIRED STEP_UP_STALE";
        await ctx.fenced(`CMD215 after the ${what} was withdrawn`, () => asRefusal(waiting.pending.then(valueOf)), refusedAs(expected));
      } finally {
        await held.release();
      }
      assert.equal(await w.effect(), "NONE", `${what}: refused`);
      assert.deepEqual(sameButJournal(await footprint(w), before), before, `${what}: nothing written, no intent`);
      recordOf(await w.run(), w, `${what}: the lane owner then records the intent`);
    }
    const a = await agentOf(L().iw, "st2-billing");
    const w = await withdrawal("st2-revoke-billing");
    assert.equal(code(await w.run({ owner: a.billing, agency: a.s.agency.agencyId })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING", "agency billing is refused");
    assert.equal(await w.effect(), "NONE");
  });

  cell(t("RACE", "PARTIAL", "later write fails"), "partial", async (ctx) => {
    await twoStep();
    const { iw } = L();
    const w = await withdrawal("st2-partial");
    const before = await footprint(w);
    const key = freshKey("partial");
    const steps: ReadonlyArray<SqlStep> = [INSERT_REQUEST, ...LATER_WRITES];
    for (const at of ["event_insert", "outbox_insert", "journal_final"]) {
      const conn = await openApp();
      try {
        const failure = await ctx.partial(`CMD215 failing at ${at}`, `db.${at}.before`, async () => {
          const seen = iw.w.internalErrors.length;
          const r = await routed(ctx, conn, () => w.run({ key }), steps);
          if (r.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(String(r.status));
          return r;
        });
        assert.match(String(failure), new RegExp(`db\\.${at}\\.before`), `${at}: the injected step fired`);
      } finally {
        await conn.end();
      }
      assert.deepEqual(sameButJournal(await footprint(w), before), before, `${at}: the whole footprint rolled back (intent, event, outbox)`);
      assert.equal(await w.effect(), "NONE", `${at}: no intent`);
    }
    recordOf(await w.run({ key }), w, "the same key then records once");
    assert.deepEqual((await footprint(w)).requests, [["RECORDED", null]]);
    assert.equal((await footprint(w)).requestEvents, 1, "one recorded.v1");
  });
}

// --- ST3 apply the settlement intent (cells 10-21) ------------------------------------------------------------------------------------

{
  const t = (verb: string, col: string, family: string): string => `${verb} SET-M-ST3-${col} (${family}): Apply settlement request`;

  cell(t("RACE", "RACE", "two deliveries, dispatcher takeover"), "race", async (ctx) => {
    // 10(a): D1 claims and holds U1 at its settlement write (A2-A5 held); its lease and claim lapse; D2 takes over, claims, U2 blocks at A2
    const { w, requestId } = await recorded("st3-race-takeover");
    await drain();
    const { rival, stale } = takeOver((Math.max(DISPATCH_LEASE_SECONDS, OUTBOX_CLAIM_SECONDS) + 1) * 1000);
    const r = await holdAndWait(
      ctx,
      "the taken-over dispatcher's apply vs the rival's redelivery",
      () => stale.runOnce("PAYMENT_SERVICE", { limit: 100 }),
      () => rival.runOnce("PAYMENT_SERVICE", { limit: 100 }),
      "db.settlement_insert.after",
      [SETTLEMENT_INSERT],
    );
    const stalePass = valueOf(r.held);
    const rivalPass = valueOf(r.waited);
    assert.equal((await deliveryIn(stalePass, requestId)).outcome, "FENCED", "the taken-over dispatcher settles nothing");
    assert.equal((await deliveryIn(rivalPass, requestId)).outcome, "DUPLICATE", "the rival's U2 found the intent consumed at A5");
    assert.deepEqual([(await outboxOf(requestId)).state, (await outboxOf(requestId)).attempts], ["DELIVERED", 2], "delivered under the rival's attempt");
    const fp = await footprint(w);
    assert.deepEqual([fp.settlements.length, fp.events, fp.ledger], [1, 1, postingsOf(w)], "one settlement, one event, one set");
    assert.equal((await requestRow(requestId)).state, "APPLIED");
  });

  cell(t("RACE", "RACE", "L1, two intents funded for one"), "race", async (ctx) => {
    // 10(b): one account (one bank route per payment route), the provider-available balance covering one; both orders via the handler
    for (const first of ["first holds", "second holds"]) {
      const a = await recorded(`st3-race-l1-1-${first}`);
      const b = await recorded(`st3-race-l1-2-${first}`, { route: a.w.route, fund: 0n });
      const [holder, waiter] = first === "first holds" ? [a, b] : [b, a];
      const r = await holdAndWait(ctx, `${first}: two applies of one account, funds for one`, () => deliver(holder.requestId), () => deliver(waiter.requestId), "db.settlement_insert.after", [SETTLEMENT_INSERT]);
      assert.deepEqual([valueOf(r.held), valueOf(r.waited)], ["APPLIED", "APPLIED"]);
      assert.equal((await requestRow(holder.requestId)).state, "APPLIED", `${first}: the holder applied`);
      const lost = await requestRow(waiter.requestId);
      assert.deepEqual([lost.state, lost.reason], ["REFUSED", "FUNDS_UNAVAILABLE"], `${first}: the waiter judged the balance the holder left (read after A4)`);
      assert.deepEqual(await casesOf(a.w), [["SETTLEMENT_REFUSED", "OPEN", "FUNDS_UNAVAILABLE"]], `${first}: one open case`);
      assert.equal(await availableOf(a.w.route), 0n, `${first}: applied cents = provider-available, never more`);
      await assertBalanced(a.w, first);
    }
  });

  cell(t("RACE", "RACE", "vs CMD052 at the payout cash fence"), "race", async (ctx) => {
    // 10(c): the apply waits at A4 behind a held payout fence; a payout fence waits behind an apply holding A4
    {
      const { w, requestId } = await recorded("st3-race-payout-holds");
      const held = await holdPayoutCash();
      try {
        const { waiting } = await L().bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => deliver(requestId)), "the apply waits at A4 (payout cash)");
        await held.release();
        assert.equal(valueOf(await waiting.pending), "APPLIED", "it applies once the payout fence released");
      } finally {
        await held.release();
      }
      assert.equal(await w.effect(), "SETTLED");
    }
    {
      const { w, requestId } = await recorded("st3-race-apply-holds");
      const hc = await openPay();
      const wc = await openPay();
      try {
        const pause = ctx.points.pause("db.settlement_insert.after");
        const running = ctx.operation("the apply held after its settlement write (holder)", () => routed(ctx, hc, () => deliver(requestId), [SETTLEMENT_INSERT]));
        await reach(pause, running, "the apply at its settlement write");
        const waiting = await ctx.mustWait(L().iw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (c) => fenceRead(c, w.accountRef), "a payout fence waits for the apply");
        pause.release();
        assert.equal(await running, "APPLIED");
        assert.deepEqual(valueOf(await waiting.pending), { settled: 1 }, "the fence reads the bank cash only after the apply committed");
      } finally {
        await hc.end();
        await wc.end();
      }
    }
  });

  cell(t("RACE", "RACE", "vs CMD053 settling a payout intent"), "race", async (ctx) => {
    // 10(d): CMD053 (transitionIntent -> SETTLED: statement row, then payout cash) and the apply serialize on payout cash, both orders;
    // the payout cash basis afterwards equals the serial result (the newest bank-evidenced observation, the SETTLED intent still claimed)
    const sw = L().iw;
    const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
    async function approvedIntent(month: string, label: string) {
      const s = await seller(sw, label, WHOLE);
      await eligibleLines(sw, `${label} ${month}`, s, WHOLE, [{ basisCents: 5_000n, poolCents: 5_000n }]);
      const { periodId, reply } = await closeMonth(sw, month);
      completed<PeriodCloseView>(reply, 200);
      const st = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === periodId);
      assert.ok(st !== undefined, "the close issued the seller's statement");
      await bankCash(sw, (await claimedCents(sw)) + BigInt(st.payable_cents));
      completed<PayoutIntentView>(await approvePayout(sw, st.statement_id, { expectedVersion: Number(st.version), payeeRef: s.destinationId, authorizationRef: await sw.w.stepUp(sw.owner) }), 200);
      return { statementId: st.statement_id, intent: await intentOf(sw, st.statement_id) };
    }
    const reconcile = (c: HarnessConnection, a: Awaited<ReturnType<typeof approvedIntent>>): Promise<Reply> =>
      sw.faults.on(c, "kauro_commission", ctx.points, [], () => reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: scriptEvidence(sw, sw.payouts.matching({ reference: a.intent.reference, destinationDigest: a.intent.destinationDigest, amountCents: a.intent.amount, currency: a.intent.currency }, "SETTLED")) }));
    const openCommission = (): Promise<HarnessConnection> => openConnection(sw.h.pg.clientConfig("kauro_commission_test"));
    for (const [first, month] of [["CMD053 holds", "2026-01"], ["the apply holds", "2026-02"]] as const) {
      const x = await approvedIntent(month, `st3-cmd053-${month}`);
      // the evidence ends after the approval's bank cash observation: the settlement is the newest bank-evidenced observation
      const { w, requestId } = await recorded(`st3-race-cmd053-${month}`, { at: new Date().toISOString() });
      const hc = first === "CMD053 holds" ? await openCommission() : await openPay();
      const wc = first === "CMD053 holds" ? await openPay() : await openCommission();
      try {
        if (first === "CMD053 holds") {
          const pause = ctx.points.pause("uow.before-commit");
          const running = ctx.operation("CMD053 held at its COMMIT, payout cash held (holder)", () => reconcile(hc, x));
          await reach(pause, running, "CMD053 at its COMMIT");
          const waiting = await ctx.mustWait(sw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (c) => routed(ctx, c, () => deliver(requestId)), "the apply waits at A4 behind CMD053");
          pause.release();
          completed(await running, 200);
          assert.equal(valueOf(await waiting.pending), "APPLIED");
        } else {
          const pause = ctx.points.pause("db.settlement_insert.after");
          const running = ctx.operation("the apply held after its settlement write (holder)", () => routed(ctx, hc, () => deliver(requestId), [SETTLEMENT_INSERT]));
          await reach(pause, running, "the apply at its settlement write");
          const waiting = await ctx.mustWait(sw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (c) => reconcile(c, x), "CMD053 waits in lockPayoutCash behind the apply");
          pause.release();
          assert.equal(await running, "APPLIED");
          completed(valueOf(await waiting.pending), 200);
        }
      } finally {
        await hc.end();
        await wc.end();
      }
      assert.equal((await q<{ s: string }>("SELECT state AS s FROM kauro.payout_intents WHERE intent_id = $1", [x.intent.intentId]))[0]!.s, "SETTLED", `${first}: CMD053 settled the intent`);
      assert.equal(await w.effect(), "SETTLED", `${first}: the apply settled the withdrawal`);
      assert.deepEqual(await payoutBasis(), { bankAvailableCents: w.facts.bankAvailableCents.toString(), unsettledAuthorizedCents: x.intent.amount.toString() }, `${first}: the basis equals the serial result`);
    }
  });

  cell(t("RACE", "TIMEOUT", "lock timeout under the real dispatcher"), "race", async (ctx) => {
    // 11: the apply times out at A2 behind a held OUTBOUND stream: FAILED, retried later, never dead-lettered for it
    const { iw, bw } = L();
    const { w, requestId } = await recorded("st3-timeout");
    await drain();
    const held = await holdStream(w.accountRef, "OUTBOUND");
    let pass: Awaited<ReturnType<typeof dispatchPayment>>;
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    try {
      const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => dispatchPayment()), "the apply waits at A2 until its statement timeout");
      pass = valueOf(await waiting.pending);
    } finally {
      iw.faults.statementTimeoutMs = null;
      await held.release();
    }
    assert.equal((await deliveryIn(pass, requestId)).outcome, "FAILED", "a timed-out apply is a retryable failure");
    const ob = await outboxOf(requestId);
    assert.deepEqual([ob.state, ob.attempts], ["RETRYABLE", 1], "retried later, not dead-lettered");
    assert.ok(ob.dueInMs > 0, "its retryAt is set ahead");
    assert.equal((await requestRow(requestId)).state, "RECORDED", "the intent is untouched");
    assert.deepEqual((await footprint(w)).settlements, []);
    advance(301_000);
    assert.equal((await deliveryIn(await dispatchPayment(), requestId)).outcome, "APPLIED", "past retryAt it applies");
    assert.deepEqual([(await outboxOf(requestId)).state, (await outboxOf(requestId)).attempts], ["DELIVERED", 2]);
    assert.equal((await requestRow(requestId)).state, "APPLIED");
  });

  cell(t("DENY", "EXPIRY", "coverage end at the effect instant"), "expiry", async (ctx) => {
    // 12(i): the evidence ends at P (within 900 s of the intent); delivered at the step clock P - 1 ms: REFUSED; a sibling at P: APPLIED
    const P = new Date(Date.now() + MINUTE).toISOString();
    const early = await withdrawal("st3-expiry-early", { at: P });
    const sibling = await withdrawal("st3-expiry-sibling", { at: P, route: early.route });
    const earlyId = await directRequest(early);
    const siblingId = await directRequest(sibling);
    ctx.deadline(P, "the evidence's period end");
    ctx.clock.set(plusMs(P, -1));
    assert.equal(await onClock(ctx, "the apply 1 ms before the period end", () => deliver(earlyId)), "APPLIED");
    const r = await requestRow(earlyId);
    assert.deepEqual([r.state, r.reason], ["REFUSED", "COVERAGE_END_IN_FUTURE"], "period_end > at: refused");
    assert.deepEqual(await casesOf(early), [["SETTLEMENT_REFUSED", "OPEN", "COVERAGE_END_IN_FUTURE"]], "and a review case");
    assert.equal(await early.effect(), "REFUSED");
    ctx.clock.set(P);
    assert.equal(await onClock(ctx, "the apply at the period end", () => deliver(siblingId)), "APPLIED");
    assert.equal((await requestRow(siblingId)).state, "APPLIED", "period_end = at: applied");
    assert.deepEqual((await footprint(sibling)).ledger, postingsOf(sibling), "the sibling's whole set, the refused one's none");
  });

  cell(t("RACE", "EXPIRY", "TIME-AFTER-AWAIT"), "race", async (ctx) => {
    // 12(ii): the effect instant is read after the last lock wait (A6 after A4): the clock moved during the wait is the one applied
    const { w, requestId } = await recorded("st3-time-after-await");
    const T1 = new Date(Date.now() + 1_000).toISOString();
    const T2 = plusMs(T1, 5_000);
    ctx.clock.set(T1);
    const held = await holdPayoutCash();
    let out: string;
    try {
      const { waiting } = await L().bw.mustWaitOn(
        ctx,
        held,
        (c) =>
          ctx.operation("the apply waiting at A4 on the step clock", async (op) => {
            L().iw.faults.clock = op.clock;
            try {
              return await routed(ctx, c, () => deliver(requestId));
            } finally {
              L().iw.faults.clock = null;
            }
          }),
        "the apply waits at payout cash",
      );
      ctx.clock.set(T2);
      await held.release();
      out = valueOf(await waiting.pending);
    } finally {
      await held.release();
    }
    assert.equal(out, "APPLIED");
    const s = await settlementOf(w);
    assert.ok(s !== undefined, "applied");
    assert.equal(isoMs(s.createdAt), T2, "created_at is the instant after the wait (T2), never one read before A4 (T1)");
  });

  test("DENY SET-M-ST3-EXPIRY (microsecond bound in SQL): Apply settlement request", async () => {
    // 12(iii): kauro.settlement_request_refusal judges at microseconds, never rounded (F8); the 900 s bound is inclusive
    const P = new Date(Date.now() + MINUTE).toISOString();
    const w = await withdrawal("st3-expiry-sql", { at: P });
    const requestId = await directRequest(w);
    const { requestedAt } = await requestRow(requestId);
    const c = await openPay();
    try {
      const at = async (instant: string, shift: string): Promise<string | null> =>
        (await c.query<{ r: string | null }>("SELECT kauro.settlement_request_refusal($1, $2::timestamptz + $3::interval, interval '900 seconds') AS r", [requestId, instant, shift])).rows[0]!.r;
      assert.equal(await at(P, "-500 microseconds"), "COVERAGE_END_IN_FUTURE", "T - 0.5 ms: the period still ends in the future");
      assert.equal(await at(P, "0"), null, "at T: none");
      assert.equal(await at(requestedAt, "900 seconds"), null, "requested_at + 900 s: not stale yet");
      assert.equal(await at(requestedAt, "900 seconds 1 microsecond"), "REQUEST_STALE", "one microsecond later: stale");
    } finally {
      await c.end();
    }
  });

  cell(t("DENY", "EXPIRY", "REQUEST_STALE bound"), "expiry", async (ctx) => {
    // 12(iv): at = requested_at + 900 s applies; at = requested_at + 900 s + 1 ms is REFUSED REQUEST_STALE with its case
    const a = await recorded("st3-stale-at-bound");
    const b = await recorded("st3-stale-past-bound", { route: a.w.route });
    const ra = (await requestRow(a.requestId)).requestedAt;
    const rb = (await requestRow(b.requestId)).requestedAt;
    const bound = plusMs(isoMs(rb), STALE_AFTER_MS + 1);
    ctx.deadline(bound, "the intent's 900 s staleness bound");
    ctx.clock.set(plusMs(isoMs(ra), STALE_AFTER_MS));
    assert.equal(await onClock(ctx, "the apply exactly 900 s after the record", () => deliver(a.requestId)), "APPLIED");
    assert.equal((await requestRow(a.requestId)).state, "APPLIED", "at the bound: applied");
    ctx.clock.set(bound);
    assert.equal(await onClock(ctx, "the apply 900 s + 1 ms after the record", () => deliver(b.requestId)), "APPLIED");
    const r = await requestRow(b.requestId);
    assert.deepEqual([r.state, r.reason], ["REFUSED", "REQUEST_STALE"], "past the bound: refused");
    assert.deepEqual(await casesOf(b.w), [["SETTLEMENT_REFUSED", "OPEN", "REQUEST_STALE"]]);
    assert.equal(await b.w.effect(), "REFUSED");
  });

  /** Crash at the apply's own COMMIT (`uow.<boundary>` armed once the unit wrote `step`). */
  async function crashedAt(ctx: FaultContext, what: string, boundary: "before-commit" | "after-commit", step: SqlStep, run: () => Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
    const pause = ctx.points.pause(`db.${step.label}.after`);
    const running = ctx.operation(what, () => onFresh(ctx, run, [step]));
    const settled = settledOf(running);
    await reach(pause, running, what);
    ctx.points.crash(`uow.${boundary}`);
    pause.release();
    return settled;
  }

  cell(
    t("RACE", "CRASH-BEFORE", "crash before Kapply COMMIT"),
    "crash-before-commit",
    async (ctx) => {
      // 13: apply and refusal each die at their COMMIT: RECORDED, nothing else; the next delivery applies once
      const ok = await recorded("st3-crb-apply");
      const before = await footprint(ok.w);
      const crashed = await crashedAt(ctx, "the apply dying before COMMIT", "before-commit", SETTLEMENT_INSERT, () => deliver(ok.requestId));
      assert.equal(crashed.status, "rejected", "the apply died at its COMMIT");
      assert.deepEqual(await footprint(ok.w), before, "atomic: RECORDED, no settlement, event, set or case");
      assert.equal(await deliver(ok.requestId), "APPLIED");
      assert.deepEqual((await footprint(ok.w)).ledger, postingsOf(ok.w), "then applied once");
      const no = await recorded("st3-crb-refusal", { fund: 0n });
      const beforeRefusal = await footprint(no.w);
      const died = await crashedAt(ctx, "the refusal dying before COMMIT", "before-commit", CASE_INSERT, () => deliver(no.requestId));
      assert.equal(died.status, "rejected");
      assert.deepEqual(await footprint(no.w), beforeRefusal, "atomic: RECORDED, no case, no refused.v1");
      assert.equal(await deliver(no.requestId), "APPLIED");
      assert.deepEqual([await requestsOf(no.w), await casesOf(no.w)], [[["REFUSED", "FUNDS_UNAVAILABLE"]], [["SETTLEMENT_REFUSED", "OPEN", "FUNDS_UNAVAILABLE"]]], "then refused once");
    },
    "uow",
  );

  cell(
    t("RACE", "CRASH-AFTER", "settle lost after Kapply COMMIT"),
    "crash-after-commit",
    async (ctx) => {
      // 14: the apply (and a refusal) committed, the dispatcher's settle lost: redelivery DUPLICATE, outbox DELIVERED, GET the committed state
      for (const [label, fund, step] of [["applied", undefined, SETTLEMENT_INSERT], ["refused", 0n, CASE_INSERT]] as const) {
        const { w, requestId } = await recorded(`st3-cra-${label}`, fund === undefined ? {} : { fund });
        await drain();
        const lost = await crashedAt(ctx, `the ${label} delivery whose settle is lost`, "after-commit", step, () => dispatchPayment());
        assert.equal(lost.status, "fulfilled", `${label}: the dispatcher survived the lost answer`);
        const committed = await requestRow(requestId);
        assert.equal(committed.state, label === "applied" ? "APPLIED" : "REFUSED", `${label}: committed`);
        assert.deepEqual([(await outboxOf(requestId)).state, (await outboxOf(requestId)).attempts], ["RETRYABLE", 1], `${label}: the delivery is retried`);
        const fp = await footprint(w);
        advance(301_000);
        assert.equal((await deliveryIn(await dispatchPayment(), requestId)).outcome, "DUPLICATE", `${label}: redelivered, nothing more`);
        assert.deepEqual([(await outboxOf(requestId)).state, (await outboxOf(requestId)).attempts], ["DELIVERED", 2]);
        assert.deepEqual(sameButJournal(await footprint(w), fp), fp, `${label}: one effect`);
        const view = await outcomeOf(w.accountRef, requestId);
        assert.deepEqual([view.state, view.reason], [committed.state, committed.reason], `${label}: GET returns the committed state`);
      }
    },
    "uow",
  );

  cell(t("RACE", "RETRY", "redelivery"), "retry", async (ctx) => {
    // 15: sequential redeliveries are DUPLICATE; funds seeded after a refusal do not revive it; an unknown intent is NOT_APPLICABLE
    const ok = await recorded("st3-retry-applied");
    assert.equal(await ctx.attempt(() => deliver(ok.requestId)), "APPLIED");
    const fp = await footprint(ok.w);
    assert.equal(await ctx.attempt(() => deliver(ok.requestId)), "DUPLICATE", "the identical event redelivered");
    assert.deepEqual(sameButJournal(await footprint(ok.w), fp), fp, "nothing more");
    const no = await recorded("st3-retry-refused", { fund: 0n });
    assert.equal(await ctx.attempt(() => deliver(no.requestId)), "APPLIED");
    await providerAvailable(no.w.route, no.w.withdrawnCents + no.w.feeCents);
    assert.equal(await ctx.attempt(() => deliver(no.requestId)), "DUPLICATE", "a refused intent stays refused once funds arrive");
    assert.deepEqual([await requestsOf(no.w), (await footprint(no.w)).settlements], [[["REFUSED", "FUNDS_UNAVAILABLE"]], []]);
    const unknown = ids.next();
    const out = await paymentUnknown(unknown, no.w.settlement.evidenceHash);
    assert.equal(out, "NOT_APPLICABLE", "no intent of that id: nothing to apply");
  });
  async function paymentUnknown(requestId: string, evidenceHash: string): Promise<string> {
    return paymentServiceEffect(laneRuntime()).handle({ eventId: ids.next() as never, eventType: "settlement_request.recorded.v1", agencyId: null as never, aggregateId: requestId, aggregateVersion: 1, payload: { requestId, evidenceHash } } as never);
  }

  cell(t("DENY", "REVOCATION", "owner prerequisites and staleness"), "revocation", async (ctx) => {
    // 16(a): the owner's grant, identity or step-up revoked after the record: the service applies within 900 s, as itself
    for (const what of OWNER_PREREQUISITES) {
      const o = await ownOwner(`st3-revoke-${what}`);
      const { proof } = await proofOf(o.person);
      const { w, requestId } = await recorded(`st3-revoke-${what}`, {}, { owner: o.person, proof });
      await ctx.revoked(`${what} after the record`, () => revokeOwner(what, o, proof));
      assert.equal(await deliver(requestId), "APPLIED", `${what}: applied within 900 s`);
      const s = await settlementOf(w);
      assert.ok(s !== undefined, `${what}: settled`);
      assert.equal(s.recordedBy, o.person.userId, `${what}: recorded_by is the owner who recorded`);
      const [e] = await q<{ k: string; c: string | null }>("SELECT actor_kind AS k, causation_id::text AS c FROM kauro.domain_events WHERE aggregate_kind = 'settlement' AND aggregate_id::text = $1", [s.id]);
      assert.deepEqual([e?.k, e?.c], ["SERVICE", await recordedEventOf(requestId)], `${what}: settlement.recorded.v1 by the service, caused by the delivery`);
    }
    // 16(d): revoked and delivered past 900 s: REFUSED REQUEST_STALE (bounded, never applied on a stale intent)
    const o = await ownOwner("st3-revoke-stale");
    const { proof } = await proofOf(o.person);
    const { w, requestId } = await recorded("st3-revoke-stale", {}, { owner: o.person, proof });
    await ctx.revoked("the grant after the record", () => revokeOwner("grant", o, proof));
    ctx.clock.set(plusMs(isoMs((await requestRow(requestId)).requestedAt), STALE_AFTER_MS + 1));
    await ctx.fenced("the apply of the revoked owner's intent past 900 s", () => refusedApply(requestId, () => onClock(ctx, "the apply past the bound", () => deliver(requestId))), (e) => e instanceof ApplyRefused && e.reason === "REQUEST_STALE");
    assert.deepEqual([await w.effect(), await casesOf(w)], ["REFUSED", [["SETTLEMENT_REFUSED", "OPEN", "REQUEST_STALE"]]]);
  });

  cell(t("DENY", "REVOCATION", "dispatcher lease taken over"), "revocation", async (ctx) => {
    // 16(b): a dispatcher whose lease was taken over finds it HELD; the intent is applied once, by the rival
    const { w, requestId } = await recorded("st3-revoke-lease");
    await drain();
    const { rival, stale } = takeOver((DISPATCH_LEASE_SECONDS + 1) * 1000);
    await ctx.revoked("the lease taken over by a rival", async () => {
      const pass = await rival.runOnce("PAYMENT_SERVICE", { limit: 100 });
      assert.equal(pass.held, false);
      assert.equal((await deliveryIn(pass, requestId)).outcome, "APPLIED");
    });
    await ctx.fenced("the taken-over dispatcher's next pass", async () => {
      const pass = await stale.runOnce("PAYMENT_SERVICE", { limit: 100 });
      if (pass.held) throw new Held("HELD");
      return pass;
    }, (e) => e instanceof Held);
    assert.equal((await footprint(w)).settlements.length, 1, "one application");
  });

  test("DENY SET-M-ST3-REVOCATION (the owner role holds no apply privilege): Apply settlement request", async () => {
    // 16(c): kauro_app writes no money, consumes no intent, publishes no apply event and marks no delivery
    const { w, requestId } = await recorded("st3-app-privileges");
    const eventId = await recordedEventOf(requestId);
    const c = await openApp();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('kauro.user_id', $1, true)", [L().owner.userId]);
      const attempt = async (what: string, sql: string, params: ReadonlyArray<unknown> = []): Promise<string> => {
        await c.query("SAVEPOINT p");
        try {
          const r = await c.query(sql, [...params]);
          await c.query("RELEASE SAVEPOINT p");
          return `rows ${r.rowCount ?? 0}`;
        } catch (e) {
          await c.query("ROLLBACK TO SAVEPOINT p");
          return `error ${(e as { code?: string }).code ?? "?"}`;
        } finally {
          void what;
        }
      };
      const refused = (r: string): boolean => r === "error 42501" || r === "rows 0";
      const checks: ReadonlyArray<readonly [string, string, ReadonlyArray<unknown>]> = [
        ["INSERT a settlement", "INSERT INTO kauro.settlements (settlement_id, route_id, provider_balance_ref, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, bank_available_cents, period_start, period_end, observed_at, evidence_hash, created_at) VALUES ($1, $2, $1, 'USD', 1, 0, 0, 0, 0, now(), now(), now(), $3, now())", [ids.next(), w.route.paymentRouteId, w.settlement.evidenceHash]],
        ["INSERT a ledger line", "INSERT INTO kauro.ledger_entries (entry_id, settlement_id, line_no, account_code, account_version, direction, amount_cents, currency, source_kind, source_ref, effective_at, observed_at, posted_at, evidence_hash, policy_version) VALUES ($1, $1, 1, 'BANK_CASH', 'OPS-1', 'DEBIT', 1, 'USD', 'SETTLEMENT', $1, now(), now(), now(), $2, 'B09-1')", [ids.next(), w.settlement.evidenceHash]],
        ["UPDATE the intent", "UPDATE kauro.settlement_requests SET outcome = 'APPLIED' WHERE request_id = $1", [requestId]],
        ["INSERT applied.v1", "INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at) VALUES ($1, 'settlement_request', $2, 2, NULL, 'settlement_request.applied.v1', 'USER', $3, NULL, $1, '{}'::jsonb, $4, 1, now())", [ids.next(), requestId, L().owner.userId, w.settlement.evidenceHash]],
        ["UPDATE its outbox record", "UPDATE kauro.outbox_records SET state = 'DELIVERED', delivered_at = now() WHERE event_id = $1", [eventId]],
        ["EXECUTE route_provider_available_cents", "SELECT kauro.route_provider_available_cents($1, 'USD')", [w.route.paymentRouteId]],
        ["EXECUTE settlement_request_refusal", "SELECT kauro.settlement_request_refusal($1, now(), interval '900 seconds')", [requestId]],
      ];
      for (const [what, sql, params] of checks) {
        const r = await attempt(what, sql, params);
        assert.ok(refused(r), `kauro_app: ${what} is refused (42501 or 0 rows), got ${r}`);
      }
      await c.query("ROLLBACK");
    } finally {
      await c.end();
    }
    assert.equal((await requestRow(requestId)).state, "RECORDED", "the intent is untouched");
    assert.deepEqual((await outboxOf(requestId)).state, "PENDING");
  });

  cell(t("RACE", "PARTIAL", "later write fails"), "partial", async (ctx) => {
    await twoStep();
    // 17: the apply (settlement first; then event, outbox, first/last line, intent update, case resolve) rolls back whole at each later write
    const { w, requestId: first } = await recorded("st3-partial", { fund: 0n });
    assert.equal(await deliver(first), "APPLIED");
    assert.deepEqual(await casesOf(w), [["SETTLEMENT_REFUSED", "OPEN", "FUNDS_UNAVAILABLE"]], "an open case of the earlier refusal");
    await providerAvailable(w.route, w.withdrawnCents + w.feeCents);
    const requestId = recordOf(await w.run(), w, "re-recorded").requestId;
    const before = await footprint(w);
    const steps: ReadonlyArray<SqlStep> = [
      SETTLEMENT_INSERT,
      { label: "event_insert", match: /INSERT INTO kauro\.domain_events/ },
      { label: "outbox_insert", match: /INSERT INTO kauro\.outbox_records/ },
      { label: "first_line", match: /INSERT INTO kauro\.ledger_entries/, nth: 1 },
      { label: "last_line", match: /INSERT INTO kauro\.ledger_entries/, nth: 6 },
      REQUEST_UPDATE,
      { label: "case_resolve", match: /UPDATE kauro\.bank_review_cases/ },
    ];
    for (const at of ["event_insert", "outbox_insert", "first_line", "last_line", "request_update", "case_resolve"]) {
      const conn = await openPay();
      try {
        const failure = await ctx.partial(`the apply failing at ${at}`, `db.${at}.before`, () => routed(ctx, conn, () => deliver(requestId), steps));
        assert.match(String(failure), new RegExp(`db\\.${at}\\.before`), `${at}: the injected step fired`);
      } finally {
        await conn.end();
      }
      assert.deepEqual(await footprint(w), before, `${at}: the whole footprint rolled back (RECORDED, case OPEN)`);
    }
    assert.equal(await deliver(requestId), "APPLIED", "then applied once");
    assert.deepEqual((await footprint(w)).ledger, postingsOf(w));
    assert.deepEqual(await casesOf(w), [["SETTLEMENT_REFUSED", "RESOLVED", "FUNDS_UNAVAILABLE"]], "the earlier refusal's case resolved by the apply");
    await assertBalanced(w, "partial");
    // (r) the refusal: case first; then intent update, event, outbox
    const r = await recorded("st3-partial-refusal", { fund: 0n });
    const beforeRefusal = await footprint(r.w);
    const refusalSteps: ReadonlyArray<SqlStep> = [CASE_INSERT, REQUEST_UPDATE, { label: "event_insert", match: /INSERT INTO kauro\.domain_events/ }, { label: "outbox_insert", match: /INSERT INTO kauro\.outbox_records/ }];
    for (const at of ["request_update", "event_insert", "outbox_insert"]) {
      const conn = await openPay();
      try {
        const failure = await ctx.partial(`the refusal failing at ${at}`, `db.${at}.before`, () => routed(ctx, conn, () => deliver(r.requestId), refusalSteps));
        assert.match(String(failure), new RegExp(`db\\.${at}\\.before`), `(r) ${at}: the injected step fired`);
      } finally {
        await conn.end();
      }
      assert.deepEqual(await footprint(r.w), beforeRefusal, `(r) ${at}: RECORDED, no case, no refused.v1`);
    }
    assert.equal(await deliver(r.requestId), "APPLIED");
    assert.deepEqual([await requestsOf(r.w), await casesOf(r.w)], [[["REFUSED", "FUNDS_UNAVAILABLE"]], [["SETTLEMENT_REFUSED", "OPEN", "FUNDS_UNAVAILABLE"]]], "(r) then refused once");
  });

  test("DENY SET-M-ST3-BIND (forged rows are refused by the database): Apply settlement request", async () => {
    // 18: oracle-forged writes (superuser: no grant or RLS in the way, every trigger and CHECK still binds)
    const { w, requestId } = await recorded("st3-bind");
    const oracle = L().iw.h.oracle;
    const forged = async (sql: string, params: ReadonlyArray<unknown>): Promise<string> => {
      await oracle.query("BEGIN");
      try {
        await oracle.query("SELECT set_config('kauro.user_id', $1, true)", [L().owner.userId]);
        await oracle.query(sql, [...params]);
        await oracle.query("SET CONSTRAINTS ALL IMMEDIATE");
        return "accepted";
      } catch (e) {
        return (e as { code?: string }).code ?? "?";
      } finally {
        await oracle.query("ROLLBACK");
      }
    };
    const [b] = await q<{ r: string; p: string }>("SELECT route_id::text AS r, payment_route_id::text AS p FROM kauro.bank_routes WHERE account_ref = $1", [w.accountRef]);
    const settlementSql = (withdrawn: string, request: string | null): readonly [string, ReadonlyArray<unknown>] => [
      `INSERT INTO kauro.settlements (settlement_id, route_id, provider_balance_ref, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, bank_available_cents, period_start, period_end, observed_at, evidence_hash, created_at,
         environment, account_ref, withdrawal_id, artifact_ref, receiving_account_ref, bank_transaction_id, receipt_artifact_ref, received_cents, bank_evidence_hash, normalizer_version, recorded_by, request_id)
       SELECT $1, $2, $3, r.currency, r.gross_cents, r.fee_cents, r.held_cents, $4::bigint, r.bank_available_cents, r.period_start, r.period_end, r.receipt_observed_at, r.evidence_hash, now(),
         r.environment, r.account_ref, r.withdrawal_id, r.artifact_ref, r.receiving_account_ref, r.bank_transaction_id, r.receipt_artifact_ref, r.received_cents, r.receipt_evidence_hash, r.normalizer_version, r.requested_by, $5::uuid
         FROM kauro.settlement_requests r WHERE r.request_id = $6`,
      [ids.next(), b!.p, b!.r, withdrawn, request, requestId],
    ];
    assert.equal(await forged(...settlementSql((w.withdrawnCents + 1n).toString(), requestId)), "KA006", "withdrawn + 1 vs its intent");
    assert.equal(await forged(...settlementSql(w.withdrawnCents.toString(), null)), "23514", "a bank settlement without its intent");
    assert.equal(await forged("UPDATE kauro.settlement_requests SET outcome = 'APPLIED' WHERE request_id = $1", [requestId]), "23514", "APPLIED without a settlement");
    assert.equal(await forged("UPDATE kauro.settlement_requests SET outcome = 'REFUSED', refusal_reason = 'FUNDS_UNAVAILABLE' WHERE request_id = $1", [requestId]), "23514", "REFUSED without a case");
    assert.equal(await forged("INSERT INTO kauro.settlement_requests (request_id, environment, account_ref, withdrawal_id, artifact_ref, evidence_hash, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, period_start, period_end, observed_at, normalizer_version, consumed_at) SELECT $1, environment, account_ref, withdrawal_id || '-x', artifact_ref, evidence_hash, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, period_start, period_end, observed_at, normalizer_version, now() FROM kauro.settlement_requests WHERE request_id = $2", [ids.next(), requestId]), "KA006", "an INSERT with consumed_at");
    assert.equal(await deliver(requestId), "APPLIED");
    assert.equal(await forged("UPDATE kauro.settlement_requests SET withdrawn_cents = withdrawn_cents + 1 WHERE request_id = $1", [requestId]), "KA004", "a consumed intent's fact never changes");
    assert.equal((await requestRow(requestId)).state, "APPLIED", "the forgeries left the applied intent as it was");
  });

  test("OK SET-M-ST3-OK (deliver and read): Apply settlement request", async () => {
    // 19: RECORDED -> deliver -> APPLIED with its SettlementView; receipt-null: BANK_IN_TRANSIT only; non-owner 403, other account 404
    const { w, requestId } = await recorded("st3-ok");
    const pending = await outcomeOf(w.accountRef, requestId);
    assert.deepEqual([pending.state, pending.reason, pending.consumedAt, pending.settlement, pending.delivery], ["RECORDED", null, null, null, "PENDING"]);
    assert.equal(await deliver(requestId), "APPLIED");
    const done = await outcomeOf(w.accountRef, requestId);
    assert.deepEqual([done.state, done.reason, done.reviewCaseId], ["APPLIED", null, null]);
    assert.ok(done.consumedAt !== null, "consumed");
    assert.deepEqual([done.settlement?.withdrawalId, done.settlement?.withdrawnCents, done.settlement?.receivedCents, done.settlement?.bankEvidence], [w.withdrawalId, w.withdrawnCents.toString(), w.receivedCents!.toString(), true]);
    assert.deepEqual((await footprint(w)).ledger, postingsOf(w), "the six lines of D-SET-6");
    await assertBalanced(w, "ok");
    const transit = await recorded("st3-ok-in-transit", { receivedCents: null });
    assert.equal(await deliver(transit.requestId), "APPLIED");
    const lines = (await footprint(transit.w)).ledger;
    assert.deepEqual(lines, postingsOf(transit.w), "release and fee only");
    assert.ok(!lines.some(([a]) => a === "BANK_CASH"), "no receipt: BANK_IN_TRANSIT only, never bank cash");
    const t2 = await outcomeOf(transit.w.accountRef, transit.requestId);
    assert.deepEqual([t2.settlement?.receivedCents, t2.settlement?.bankEvidence], [null, false]);
    const a = await agentOf(L().iw, "st3-ok-billing");
    assert.equal(code(await getRequest(w.accountRef, requestId, a.billing)), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING", "a non-owner reads nothing");
    assert.equal((await ownerGet(requestRoute(transit.w.accountRef, requestId))).status, 404, "another account's intent is not found");
  });

  test("DENY SET-M-ST3-EVIDENCE (re-verified at the apply): Apply settlement request", async () => {
    // 20(a) an inflated frozen figure; (b) a changed withdrawn figure and another account's artifact: EVIDENCE_MISMATCH, case, no money
    const cases: ReadonlyArray<readonly [string, (w: Withdrawal, other: Withdrawal) => Record<string, string | null>]> = [
      ["bank_available_cents inflated", (w) => ({ bank_available_cents: (w.facts.bankAvailableCents + 1n).toString() })],
      ["withdrawn_cents changed", (w) => ({ withdrawn_cents: (w.withdrawnCents - 1n).toString() })],
      ["another account's artifact", (_w, other) => ({ artifact_ref: other.settlement.artifactRef, evidence_hash: other.settlement.evidenceHash, withdrawal_id: other.withdrawalId, receipt_artifact_ref: other.receipt!.artifactRef, receipt_evidence_hash: other.receipt!.evidenceHash, bank_transaction_id: other.bankTransactionId, receiving_account_ref: other.receivingAccountRef })],
    ];
    for (const [what, over] of cases) {
      const w = await withdrawal(`st3-evidence-${what}`);
      const other = await withdrawal(`st3-evidence-other-${what}`);
      const requestId = await directRequest(w, over(w, other));
      assert.equal(await deliver(requestId), "APPLIED", `${what}: the refusal is the consumer's outcome`);
      const r = await requestRow(requestId);
      assert.deepEqual([r.state, r.reason], ["REFUSED", "EVIDENCE_MISMATCH"], `${what}: the frozen facts are not the artifacts'`);
      assert.deepEqual(await casesOf(w), [["SETTLEMENT_REFUSED", "OPEN", "EVIDENCE_MISMATCH"]], `${what}: a review case`);
      const fp = await footprint(w);
      assert.deepEqual([fp.settlements, fp.ledger], [[], []], `${what}: no settlement, no posting`);
    }
    // 20(c): the store not bound: CAPACITY_UNAVAILABLE, retried, never refused
    const { w, requestId } = await recorded("st3-evidence-unbound");
    await drain();
    const pass = await dispatchPayment({ bank: false });
    const d = await deliveryIn(pass, requestId);
    assert.deepEqual([d.outcome, d.errorCode], ["FAILED", "CAPACITY_UNAVAILABLE"], "an unbound store is capacity, not evidence");
    assert.deepEqual([(await outboxOf(requestId)).state, (await outboxOf(requestId)).attempts], ["RETRYABLE", 1]);
    assert.deepEqual([(await requestRow(requestId)).state, await casesOf(w)], ["RECORDED", []], "never REFUSED for it");
    advance(301_000);
    assert.equal((await deliveryIn(await dispatchPayment(), requestId)).outcome, "APPLIED", "bound again: applied");
  });

  test("OK SET-M-ST3-CASE (refusal case and the in-transit page): Apply settlement request", async () => {
    // 21: a refusal opens SETTLEMENT_REFUSED; the page lists RECORDED and REFUSED with its figures and age; re-record + apply resolves it
    const no = await recorded("st3-case-refused", { fund: 0n });
    const pending = await recorded("st3-case-pending", { route: no.w.route, receivedCents: null });
    assert.equal(await deliver(no.requestId), "APPLIED");
    const refused = await requestRow(no.requestId);
    const [c] = await q<{ id: string; k: string; s: string; sk: string; si: string; d: string; e: string | null }>("SELECT case_id::text AS id, kind AS k, state AS s, source_kind AS sk, source_id::text AS si, detail_code AS d, evidence_hash AS e FROM kauro.bank_review_cases WHERE account_ref = $1", [no.w.accountRef]);
    assert.deepEqual([c?.k, c?.s, c?.sk, c?.si, c?.d, c?.e], ["SETTLEMENT_REFUSED", "OPEN", "SETTLEMENT_REQUEST", no.requestId, "FUNDS_UNAVAILABLE", no.w.settlement.evidenceHash], "the case names the intent, its reason and its evidence");
    assert.equal(refused.reviewCaseId, c?.id, "the intent cites its case");
    const page = await inTransit(no.w.accountRef);
    const [dbAge] = await q<{ a: string }>("SELECT extract(epoch FROM clock_timestamp() - requested_at)::text AS a FROM kauro.settlement_requests WHERE request_id = $1", [pending.requestId]);
    assert.deepEqual(
      page.items.map((i) => [i.requestId, i.state, i.reason, i.withdrawnCents, i.receivedCents, i.feeCents, i.reviewCaseId]),
      [
        [no.requestId, "REFUSED", "FUNDS_UNAVAILABLE", no.w.withdrawnCents.toString(), no.w.receivedCents!.toString(), no.w.feeCents.toString(), c?.id],
        [pending.requestId, "RECORDED", null, pending.w.withdrawnCents.toString(), null, pending.w.feeCents.toString(), null],
      ],
      "both, in record order, with their figures",
    );
    const age = page.items[1]!.ageSeconds;
    assert.ok(typeof age === "number" && age >= 0 && age <= Number(dbAge!.a), `ageSeconds is the DB clock minus requested_at: ${age} <= ${dbAge!.a}`);
    assert.equal(page.items[1]!.delivery, "PENDING");
    assert.equal(page.nextCursor, null);
    await providerAvailable(no.w.route, no.w.withdrawnCents + no.w.feeCents);
    const again = recordOf(await no.w.run(), no.w, "re-recorded after the refusal").requestId;
    assert.equal(await deliver(again), "APPLIED");
    assert.equal(await deliver(pending.requestId), "APPLIED");
    assert.deepEqual(await casesOf(no.w), [["SETTLEMENT_REFUSED", "RESOLVED", "FUNDS_UNAVAILABLE"]], "the apply of the same withdrawal resolved the case");
    assert.deepEqual((await inTransit(no.w.accountRef)).items, [], "nothing in transit once applied and resolved");
  });
}
