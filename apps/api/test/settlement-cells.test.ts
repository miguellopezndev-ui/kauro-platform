// Lane PV1-SETTLE (PAYMENTS-V1, tier 1 MONEY): the settlement observation cells of docs/design/ACH-ROUTE.md r12 §7.25 — ST1 classify
// settlement evidence and ST2 CMD215 RecordSettlementObservation — and docs/design/PV1-SETTLE.md D-SET-1..D-SET-9. Titles follow §7:
// `<VERB> SET-M-<row>-<column> (<family>): <row label>`. Design path note (D-SET-8): §7.25 names packages/persistence/test; ST2 is an
// owner command (journal, step-up, route) and needs the composed api, bankWorld and the application's classifier, so the cells live here.
//
// CONTRACT
//   CMD215 POST /api/v1/operations/bank-accounts/{accountRef}/settlements
//     { artifactRef, evidenceHash, receipt: { artifactRef, evidenceHash } | null, authorizationRef } -> 201 { settlement }
//   locks (D-SET-5): the account's L1 OUTBOUND stream, then INBOUND, then the payout cash basis lock (CMD052's, 0043); the effect instant
//   is the database clock read after the last lock wait; ST1 reads both artifacts outside every lock.
//
// FIXTURE GAP (reported, D-SET-5): no V1 producer moves bank-route money into PSP_AVAILABLE (the D-ACH-11 availability observation is
// not built), so `providerAvailable` seeds a route's provider-available balance by an oracle posting set (a 0017 provider balance
// observation with its SETTLEMENT set DEBIT PSP_AVAILABLE / CREDIT PSP_RECEIVABLE). Without it, a live CMD215 refuses FUNDS_UNAVAILABLE.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { fakeBankReceiptBytes, fakeCreditBytes, fakeSettlementBytes } from "@kauro/application/testing";
import { connectionPid, LOCK_WAIT_OBSERVATION_MS, runCell, type FaultContext, type FaultKind, type HarnessConnection } from "@kauro/persistence/testing";
import { BANK_PAYEE_DIGEST, type HeldLock, type StoredBankArtifact } from "./bank-support.js";
import type { SqlStep } from "./fault-support.js";
import { agentOf } from "./integration-support.js";
import { freshKey, ids, type Reply } from "./support.js";
import {
  L,
  OWNER_PREREQUISITES,
  code,
  count,
  dataOf,
  holdAndWait,
  holdStream,
  onClock,
  onFresh,
  openPay,
  ownOwner,
  ownerCall,
  plusMs,
  proofOf,
  q,
  reach,
  revokeOwner,
  routeFor,
  routed,
  safe,
  startLane,
  stopLane,
  valueOf,
  type OwnerCall,
} from "./inbound-lane-support.js";

before(async () => {
  await startLane();
});
after(async () => {
  await stopLane();
});

const LOCK_TIMEOUT_MS = Math.floor(LOCK_WAIT_OBSERVATION_MS / 4);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const settleRoute = (accountRef: string): string => `/api/v1/operations/bank-accounts/${accountRef}/settlements`;
const replayedBody = (text: string): string => { try { const j = JSON.parse(text) as Record<string, unknown>; delete j["replayed"]; return JSON.stringify(j); } catch { return text; } };

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

// --- fixtures -------------------------------------------------------------------------------------------------------------------------

interface SettleRoute {
  readonly routeId: string;
  readonly accountRef: string;
  readonly paymentRouteId: string;
}
let seq = 0;
async function settleRouteFor(label: string): Promise<SettleRoute> {
  const r = await routeFor(`set-${label}`, [L().iw.w.A.agencyId]);
  const [row] = await q<{ p: string }>("SELECT payment_route_id::text AS p FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]);
  return { routeId: r.routeId, accountRef: r.accountRef, paymentRouteId: row!.p };
}
/** FIXTURE GAP (header): the route's provider-available balance, seeded by the oracle as one balanced SETTLEMENT-sourced set. */
async function providerAvailable(route: SettleRoute, cents: bigint): Promise<void> {
  const sha = (await L().bw.evidence.put({ bytes: new TextEncoder().encode(`seed-${route.accountRef}-${++seq}`), accountRef: route.accountRef as never })).sha256;
  await L().iw.h.oracle.query(
    `WITH s AS (
       INSERT INTO kauro.settlements (settlement_id, route_id, provider_balance_ref, currency, gross_cents, fee_cents, held_cents, withdrawn_cents, bank_available_cents, period_start, period_end, observed_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, 'USD', $4, 0, 0, 0, 0, now() - interval '2 days', now() - interval '1 day', now() - interval '1 day', $5, now()) RETURNING settlement_id)
     INSERT INTO kauro.ledger_entries (entry_id, settlement_id, line_no, account_code, account_version, direction, amount_cents, currency, source_kind, source_ref, effective_at, observed_at, posted_at, evidence_hash, policy_version)
     SELECT v.e, s.settlement_id, v.n, v.a, 'OPS-1', v.d, $4, 'USD', 'SETTLEMENT', s.settlement_id, now() - interval '1 day', now() - interval '1 day', now(), $5, 'B09-1'
       FROM s, (VALUES ($6::uuid, 1, 'PSP_AVAILABLE', 'DEBIT'), ($7::uuid, 2, 'PSP_RECEIVABLE', 'CREDIT')) AS v(e, n, a, d)`,
    [ids.next(), route.paymentRouteId, ids.next(), cents.toString(), sha, ids.next(), ids.next()],
  );
}
async function availableOf(route: SettleRoute): Promise<bigint> {
  const [r] = await q<{ n: string }>(
    "SELECT coalesce(sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_cents ELSE -e.amount_cents END), 0)::text AS n FROM kauro.ledger_entries e JOIN kauro.settlements s ON s.settlement_id = e.settlement_id WHERE s.route_id = $1 AND e.account_code = 'PSP_AVAILABLE'",
    [route.paymentRouteId],
  );
  return BigInt(r!.n);
}

interface WithdrawalCfg {
  readonly withdrawnCents?: bigint;
  readonly feeCents?: bigint;
  /** null: no receipt (the money is in transit). */
  readonly receivedCents?: bigint | null;
  readonly bankAvailableCents?: bigint;
  /** The provider-available balance seeded for it (default exactly withdrawn + fee); 0n seeds nothing. */
  readonly fund?: bigint;
  readonly route?: SettleRoute;
  /** The instant the evidence ends at: period end, observations, booking (default a minute ago). */
  readonly at?: string;
  /** One instant of the evidence moved off `at` (the others stay at it). */
  readonly instants?: Partial<Record<"periodEnd" | "observedAt" | "bookedAt" | "receiptObservedAt", string>>;
  readonly bankTransactionId?: string;
  readonly receivingAccountRef?: string;
}
interface Withdrawal {
  readonly route: SettleRoute;
  readonly accountRef: string;
  readonly withdrawalId: string;
  readonly withdrawnCents: bigint;
  readonly feeCents: bigint;
  readonly receivedCents: bigint | null;
  readonly bankTransactionId: string;
  readonly receivingAccountRef: string;
  readonly settlement: StoredBankArtifact;
  readonly receipt: StoredBankArtifact | null;
  run(o?: OwnerCall & { readonly variant?: boolean }): Promise<Reply>;
  effect(): Promise<string>;
}
async function store(accountRef: string, bytes: Uint8Array): Promise<StoredBankArtifact> {
  const { artifactRef, sha256 } = await L().bw.evidence.put({ bytes, accountRef: accountRef as never });
  return { artifactRef, evidenceHash: sha256 };
}
const body = (s: StoredBankArtifact, r: StoredBankArtifact | null): Record<string, unknown> => ({ artifactRef: s.artifactRef, evidenceHash: s.evidenceHash, receipt: r === null ? null : { artifactRef: r.artifactRef, evidenceHash: r.evidenceHash } });
const settle = (accountRef: string, s: StoredBankArtifact, r: StoredBankArtifact | null, o: OwnerCall = {}): Promise<Reply> => ownerCall(settleRoute(accountRef), body(s, r), o, "set");

async function withdrawal(label: string, cfg: WithdrawalCfg = {}): Promise<Withdrawal> {
  const route = cfg.route ?? (await settleRouteFor(label));
  const n = ++seq;
  const withdrawnCents = cfg.withdrawnCents ?? 100_000n;
  const feeCents = cfg.feeCents ?? 1_500n;
  const receivedCents = cfg.receivedCents === undefined ? withdrawnCents : cfg.receivedCents;
  const at = cfg.at ?? new Date(Date.now() - MINUTE).toISOString();
  const withdrawalId = `wd-${safe(label).slice(-20)}-${n}`;
  const bankTransactionId = cfg.bankTransactionId ?? `btx-${safe(label).slice(-20)}-${n}`;
  const receivingAccountRef = cfg.receivingAccountRef ?? `recv-${safe(label).slice(-20)}`;
  const fund = cfg.fund ?? withdrawnCents + feeCents;
  if (fund > 0n) await providerAvailable(route, fund);
  const i = cfg.instants ?? {};
  const settlement = await store(route.accountRef, fakeSettlementBytes(route.accountRef, { currency: "USD", periodStart: plusMs(at, -3 * HOUR), periodEnd: i.periodEnd ?? at, withdrawalId, grossCents: withdrawnCents + feeCents, feeCents, heldCents: 0n, withdrawnCents, observedAt: i.observedAt ?? at }));
  const receipt =
    receivedCents === null
      ? null
      : await store(route.accountRef, fakeBankReceiptBytes(route.accountRef, { receivingAccountRef, withdrawalId, bankTransactionId, currency: "USD", receivedCents, bankAvailableCents: cfg.bankAvailableCents ?? receivedCents + 250_000n, bookedAt: i.bookedAt ?? at, observedAt: i.receiptObservedAt ?? at }));
  return {
    route,
    accountRef: route.accountRef,
    withdrawalId,
    withdrawnCents,
    feeCents,
    receivedCents,
    bankTransactionId,
    receivingAccountRef,
    settlement,
    receipt,
    // the variant body cites the same settlement without its receipt: another request digest under the same key
    run: (o = {}) => settle(route.accountRef, settlement, o.variant === true ? null : receipt, o),
    effect: async () => ((await count("SELECT 1 FROM kauro.settlements WHERE account_ref = $1 AND withdrawal_id = $2", [route.accountRef, withdrawalId])) === 1 ? "SETTLED" : "NONE"),
  };
}

// --- the footprint oracle (superuser reads only) ---------------------------------------------------------------------------------------

interface SettlementFootprint {
  readonly settlements: ReadonlyArray<readonly [string, string, string | null, string]>;
  readonly events: number;
  readonly outbox: number;
  readonly journal: number;
  readonly ledger: ReadonlyArray<readonly [string, string, string]>;
  readonly available: string;
}
async function footprint(w: Pick<Withdrawal, "route">): Promise<SettlementFootprint> {
  const rows = await q<{ id: string; w: string; c: string; r: string | null; b: string }>(
    "SELECT settlement_id::text AS id, withdrawal_id AS w, withdrawn_cents::text AS c, received_cents::text AS r, bank_available_cents::text AS b FROM kauro.settlements WHERE account_ref = $1 ORDER BY settlement_id",
    [w.route.accountRef],
  );
  const idsOf = rows.map((r) => r.id);
  return {
    settlements: rows.map((r) => [r.w, r.c, r.r, r.b] as const),
    events: await count("SELECT 1 FROM kauro.domain_events WHERE aggregate_kind = 'settlement' AND aggregate_id::text = ANY($1::text[])", [idsOf]),
    outbox: await count("SELECT 1 FROM kauro.outbox_records o JOIN kauro.domain_events e USING (event_id) WHERE e.aggregate_kind = 'settlement' AND e.aggregate_id::text = ANY($1::text[])", [idsOf]),
    journal: await count("SELECT 1 FROM kauro.command_journal WHERE resource_id::text = ANY($1::text[])", [idsOf]),
    ledger: (await q<{ a: string; d: string; n: string }>("SELECT account_code AS a, direction AS d, amount_cents::text AS n FROM kauro.ledger_entries WHERE settlement_id::text = ANY($1::text[]) ORDER BY settlement_id, line_no", [idsOf])).map((r) => [r.a, r.d, r.n] as const),
    available: (await availableOf(w.route)).toString(),
  };
}
const sameButJournal = (a: SettlementFootprint, b: SettlementFootprint): SettlementFootprint => ({ ...a, journal: b.journal });
/** Every posting set of the route's settlements balances by itself (D-SET-6), and PSP_AVAILABLE never goes below zero. */
async function assertBalanced(w: Pick<Withdrawal, "route">, what: string): Promise<void> {
  const unbalanced = await q<{ id: string; net: string }>(
    "SELECT e.settlement_id::text AS id, sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_cents ELSE -e.amount_cents END)::text AS net FROM kauro.ledger_entries e JOIN kauro.settlements s ON s.settlement_id = e.settlement_id WHERE s.route_id = $1 GROUP BY 1 HAVING sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_cents ELSE -e.amount_cents END) <> 0",
    [w.route.paymentRouteId],
  );
  assert.deepEqual(unbalanced, [], `${what}: every settlement set balances by itself`);
  assert.ok((await availableOf(w.route)) >= 0n, `${what}: no settlement of imaginary liquidity`);
}
/** The postings of one settlement (D-SET-6): the release and fee leave PSP_AVAILABLE; only the receipt makes BANK_CASH. */
const postingsOf = (w: Withdrawal): ReadonlyArray<readonly [string, string, string]> =>
  [
    ["BANK_IN_TRANSIT", "DEBIT", w.withdrawnCents],
    ["PSP_AVAILABLE", "CREDIT", w.withdrawnCents],
    ["PROCESSOR_EXPENSE", "DEBIT", w.feeCents],
    ["PSP_AVAILABLE", "CREDIT", w.feeCents],
    ["BANK_CASH", "DEBIT", w.receivedCents ?? 0n],
    ["BANK_IN_TRANSIT", "CREDIT", w.receivedCents ?? 0n],
  ]
    .filter(([, , c]) => (c as bigint) > 0n)
    .map(([a, d, c]) => [a as string, d as string, (c as bigint).toString()] as const);

/** The payout cash basis lock (CMD052's, 0043) held by a payment-login connection standing in for a payout approval at its funds fence. */
async function holdPayoutCash(): Promise<HeldLock> {
  const connection = await openPay();
  let ended = false;
  const lock: HeldLock = {
    kind: "PAYOUT_CASH",
    pid: connectionPid(connection),
    connection,
    async release() {
      if (ended) return;
      ended = true;
      try {
        await connection.query("ROLLBACK");
      } finally {
        await connection.end();
      }
    },
  };
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('kauro.payout-cash', 0))");
  } catch (e) {
    await lock.release();
    throw e;
  }
  return lock;
}
/** What a payout approval reads at its fence once it holds the lock (commercial-statements.ts payoutCash): the latest bank cash. */
async function fenceRead(c: HarnessConnection, accountRef: string): Promise<{ readonly settled: number }> {
  await c.query("BEGIN");
  try {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('kauro.payout-cash', 0))");
    const r = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.settlements WHERE account_ref = $1", [accountRef]);
    return { settled: r.rows[0]!.n };
  } finally {
    await c.query("ROLLBACK");
  }
}

// --- ST1 classify settlement evidence -------------------------------------------------------------------------------------------------

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
      assert.equal(code(r), "503 CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE", `${which}: unread evidence settles nothing`);
      assert.equal(await w.effect(), "NONE");
      assert.deepEqual(sameButJournal(await footprint(w), before), before, `${which}: nothing written`);
    }
  });

  cell(t("DENY", "RETRY", "replay and rejected evidence"), "retry", async (ctx) => {
    const w = await withdrawal("st1-retry");
    const before = await footprint(w);
    // the same bytes classify to the same refusal, under any key (never cached: each call rereads and reclassifies)
    const now = Date.now();
    const malformed = await store(w.accountRef, fakeSettlementBytes(w.accountRef, { currency: "USD", periodStart: new Date(now - 3 * HOUR).toISOString(), periodEnd: new Date(now - HOUR).toISOString(), withdrawalId: "wd-st1-absent", grossCents: 100n, feeCents: 0n, heldCents: 0n, withdrawnCents: null, observedAt: new Date(now - HOUR).toISOString() }));
    const first = code(await ctx.attempt(() => settle(w.accountRef, malformed, null)));
    const again = code(await ctx.attempt(() => settle(w.accountRef, malformed, null)));
    assert.equal(first, again, "same digest, same result");
    assert.equal(first, "422 INTEGRITY_FAILURE MALFORMED_EVIDENCE", "an absent figure is malformed, never 0");
    // a document of another kind is not settlement evidence
    const credit = await store(w.accountRef, fakeCreditBytes(w.accountRef, { creditId: "txn-st1-credit", rail: "ACH", currency: "USD", grossCents: 100n, feeCents: 0n, netCents: 100n, payeeDigest: BANK_PAYEE_DIGEST, reference: null, payerDigest: null as never, payerEvidenceRef: null, status: "COMPLETED", bookedAt: new Date(Date.now() - HOUR).toISOString(), observedAt: new Date(Date.now() - HOUR).toISOString() }));
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, credit, null))), "422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "a credit artifact is not a settlement");
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, w.receipt!, null))), "422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "a receipt is not a settlement record");
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, w.settlement, w.settlement))), "422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "a settlement record is not a receipt");
    // the cited hash is not the stored bytes'
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, { artifactRef: w.settlement.artifactRef, evidenceHash: w.receipt!.evidenceHash }, w.receipt))), "422 INTEGRITY_FAILURE HASH_MISMATCH");
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, w.settlement, { artifactRef: w.receipt!.artifactRef, evidenceHash: w.settlement.evidenceHash }))), "422 INTEGRITY_FAILURE HASH_MISMATCH", "the receipt is re-verified too");
    // bytes replaced in the store after the owner cited them
    const replaced = await withdrawal("st1-retry-replaced");
    L().bw.evidence.corrupt(replaced.settlement.artifactRef, new TextEncoder().encode("replaced"));
    assert.equal(code(await ctx.attempt(() => replaced.run())), "422 INTEGRITY_FAILURE HASH_MISMATCH", "replaced bytes settle nothing");
    // another account's settlement is not evidence of this route
    const other = await withdrawal("st1-retry-other");
    assert.equal(code(await ctx.attempt(() => settle(w.accountRef, other.settlement, null))), "422 INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "another account's record");
    // the valid bytes classify the same way every time: the command answers them once, then replays
    const key = freshKey("st1-valid");
    const ok = await ctx.attempt(() => w.run({ key }));
    assert.equal(ok.status, 201, ok.text);
    assert.equal(replayedBody((await ctx.attempt(() => w.run({ key }))).text), replayedBody(ok.text), "same digest, same answer");
    assert.equal((await footprint(w)).settlements.length, before.settlements.length + 1, "only the valid evidence settled");
    assert.equal((await footprint(replaced)).settlements.length, 0);
  });
}

// --- ST2 CMD215 record settlement observation ------------------------------------------------------------------------------------------

{
  const t = (verb: string, col: string, family: string): string => `${verb} SET-M-ST2-${col} (${family}): Record settlement observation`;
  const LOSER = "409 PRECONDITION_FAILED WITHDRAWAL_ALREADY_SETTLED";
  const LATER_WRITES: ReadonlyArray<SqlStep> = [
    { label: "event_insert", match: /INSERT INTO kauro\.domain_events/ },
    { label: "outbox_insert", match: /INSERT INTO kauro\.outbox_records/ },
    { label: "first_line", match: /INSERT INTO kauro\.ledger_entries/, nth: 1 },
    // the last of the six posting lines (release, fee, receipt): BANK_IN_TRANSIT credit of the received money
    { label: "last_line", match: /INSERT INTO kauro\.ledger_entries/, nth: 6 },
    { label: "journal_final", match: /UPDATE kauro\.command_journal/ },
  ];

  cell(t("RACE", "RACE", "both orders"), "race", async (ctx) => {
    // (1) the same withdrawal twice, two owners: one settlement
    for (const first of ["owner A holds", "owner B holds"]) {
      const w = await withdrawal(`st2-race-same-${first}`);
      const a = await ownOwner(`st2-a-${first}`);
      const b = await ownOwner(`st2-b-${first}`);
      const [holder, waiter] = first === "owner A holds" ? [a, b] : [b, a];
      const r = await holdAndWait(ctx, `${first}: CMD215 vs CMD215 on one withdrawal`, () => w.run({ owner: holder.person, key: freshKey("holder") }), () => w.run({ owner: waiter.person, key: freshKey("waiter") }));
      assert.equal(valueOf(r.held).status, 201, `${first}: the holder commits: ${valueOf(r.held).text}`);
      assert.equal(code(valueOf(r.waited)), LOSER, `${first}: the waiter sees the committed settlement`);
      assert.equal((await footprint(w)).settlements.length, 1, `${first}: exactly one settlement`);
      await assertBalanced(w, first);
    }
    // (2) two withdrawals of one route, the provider-available balance covering one: never imaginary liquidity, both orders
    for (const first of ["first holds", "second holds"]) {
      const one = await withdrawal(`st2-race-funds-1-${first}`);
      const two = await withdrawal(`st2-race-funds-2-${first}`, { route: one.route, fund: 0n });
      const [holder, waiter] = first === "first holds" ? [one, two] : [two, one];
      const r = await holdAndWait(ctx, `${first}: two settlements, funds for one`, () => holder.run(), () => waiter.run());
      assert.equal(valueOf(r.held).status, 201, valueOf(r.held).text);
      assert.equal(code(valueOf(r.waited)), "409 PRECONDITION_FAILED FUNDS_UNAVAILABLE", `${first}: the waiter judges the balance the holder left`);
      assert.equal(await availableOf(one.route), 0n, `${first}: settled cents = provider-available, never more`);
      await assertBalanced(one, first);
    }
    // (3) vs CMD052 at the payout cash fence (0043), both orders
    {
      const w = await withdrawal("st2-race-payout-holds");
      const held = await holdPayoutCash();
      try {
        const { waiting } = await L().bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => w.run()), "CMD215 waits at the payout cash lock");
        await held.release();
        const r = valueOf(await waiting.pending);
        assert.equal(r.status, 201, `it settles once the payout fence released: ${r.text}`);
      } finally {
        await held.release();
      }
      assert.equal(await w.effect(), "SETTLED");
    }
    {
      const w = await withdrawal("st2-race-settlement-holds");
      const hc = await openPay();
      const wc = await openPay();
      try {
        const pause = ctx.points.pause("uow.before-commit");
        const running = ctx.operation("CMD215 held at its COMMIT (holder)", () => routed(ctx, hc, () => w.run()));
        await reach(pause, running, "CMD215 at its COMMIT");
        const waiting = await ctx.mustWait(L().iw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (c) => fenceRead(c, w.accountRef), "a payout fence waits for the settlement");
        pause.release();
        assert.equal((await running).status, 201);
        assert.deepEqual(valueOf(await waiting.pending), { settled: 1 }, "the fence reads the bank cash only after the settlement committed");
      } finally {
        await hc.end();
        await wc.end();
      }
    }
  });

  cell(t("RACE", "TIMEOUT", "lock and COMMIT timeout"), "race", async (ctx) => {
    const { iw } = L();
    const w = await withdrawal("st2-timeout");
    const key = freshKey("timeout");
    iw.faults.statementTimeoutMs = LOCK_TIMEOUT_MS;
    let r: Awaited<ReturnType<typeof holdAndWait<Reply, Reply>>>;
    try {
      r = await holdAndWait(ctx, "CMD215 timing out behind the holder", () => w.run({ key: freshKey("holder") }), () => w.run({ key }));
    } finally {
      iw.faults.statementTimeoutMs = null;
    }
    assert.equal(valueOf(r.held).status, 201, valueOf(r.held).text);
    const timedOut = valueOf(r.waited);
    assert.ok(timedOut.status >= 500, `the waiter timed out and wrote nothing: ${timedOut.status} ${timedOut.text}`);
    const fp = await footprint(w);
    assert.equal(fp.settlements.length, 1);
    assert.equal(code(await w.run({ key })), LOSER, "the same key, once the holder committed, is the loser's answer");
    assert.deepEqual(sameButJournal(await footprint(w), fp), fp, "the recovery wrote nothing");
  });

  cell(t("DENY", "EXPIRY", "period end and step-up"), "expiry", async (ctx) => {
    const { proof, expiresAt } = await proofOf();
    ctx.deadline(expiresAt, "the owner's step-up validity");
    const effect = plusMs(expiresAt, -1);
    // the evidence ends exactly at the effect instant (the database clock after the last lock wait, ahead of the app's clock): fresh
    const ok = await withdrawal("st2-expiry-ok", { at: effect });
    ctx.clock.set(effect);
    const fresh = await onClock(ctx, "CMD215 at the effect instant, 1 ms before the proof expires", () => ok.run({ proof }));
    assert.equal(fresh.status, 201, `an observation ending at the effect instant is recorded: ${fresh.text}`);
    // one millisecond after it: the period, an observation or a booking in the future is refused
    for (const late of ["periodEnd", "observedAt", "bookedAt", "receiptObservedAt"] as const) {
      const future = await withdrawal(`st2-expiry-future-${late}`, { at: effect, instants: { [late]: plusMs(effect, 1) } });
      const before = await footprint(future);
      assert.equal(code(await onClock(ctx, `CMD215 whose ${late} ends 1 ms after the effect instant`, () => future.run({ proof }))), "409 PRECONDITION_FAILED COVERAGE_END_IN_FUTURE", `${late} end > effectNow`);
      assert.deepEqual(sameButJournal(await footprint(future), before), before, `${late}: nothing written`);
    }
    // the proof 1 ms past its validity at the effect clock
    const stale = await withdrawal("st2-expiry-stale");
    const before = await footprint(stale);
    ctx.clock.set(plusMs(expiresAt, 1));
    assert.equal(code(await onClock(ctx, "CMD215 1 ms after the proof expired", () => stale.run({ proof }))), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "+1 ms: judged at the effect clock");
    assert.deepEqual(sameButJournal(await footprint(stale), before), before, "nothing written");
    assert.equal(await stale.effect(), "NONE");
  });

  cell(
    t("RACE", "CRASH-BEFORE", "crash before Ksettle COMMIT"),
    "crash-before-commit",
    async (ctx) => {
      const w = await withdrawal("st2-crb");
      const before = await footprint(w);
      ctx.points.crash("uow.before-commit");
      const crashed = await ctx.operation("CMD215 dying before COMMIT", () => onFresh(ctx, () => w.run()));
      assert.equal(crashed.status, 500, `the step reached its COMMIT and died there: ${crashed.text}`);
      assert.equal(await w.effect(), "NONE");
      assert.deepEqual(await footprint(w), before, "atomic: no settlement, event, outbox, journal or ledger change");
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
      assert.equal(await w.effect(), "SETTLED", "committed");
      const fp = await footprint(w);
      assert.equal(fp.events, 1, "one settlement.recorded.v1");
      assert.deepEqual(fp.ledger, postingsOf(w), "one balanced set");
      const replay = await w.run({ key });
      assert.equal(replay.status, 201, `the same key returns the committed answer: ${replay.text}`);
      assert.deepEqual(sameButJournal(await footprint(w), fp), fp, "one settlement, one event, one set");
    },
    "uow",
  );

  cell(t("RACE", "RETRY", "replay and conflict"), "retry", async (ctx) => {
    const w = await withdrawal("st2-retry");
    const key = freshKey("retry");
    const first = await ctx.attempt(() => w.run({ key }));
    const view = dataOf<{ settlement: { withdrawalId: string; withdrawnCents: string; receivedCents: string | null; bankEvidence: boolean } }>(first, 201, "CMD215").settlement;
    assert.deepEqual([view.withdrawalId, view.withdrawnCents, view.receivedCents, view.bankEvidence], [w.withdrawalId, w.withdrawnCents.toString(), w.receivedCents!.toString(), true]);
    const fp = await footprint(w);
    assert.deepEqual(fp.ledger, postingsOf(w));
    // (1) identical replay
    const replay = await ctx.attempt(() => w.run({ key }));
    assert.equal(replay.status, 201);
    assert.equal(replayedBody(replay.text), replayedBody(first.text), "the same body (the replayed flag aside)");
    assert.deepEqual(sameButJournal(await footprint(w), fp), fp, "the replay writes nothing");
    // (2) same key, other body
    assert.equal(code(await ctx.attempt(() => w.run({ key, variant: true }))), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
    // (3) a new key on the same withdrawal
    assert.equal(code(await ctx.attempt(() => w.run({ key: freshKey("again") }))), LOSER, "a new key cannot make a second settlement");
    // (4) another withdrawal whose receipt cites a bank transaction already settled
    const reused = await withdrawal("st2-retry-btx", { route: w.route, bankTransactionId: w.bankTransactionId, receivingAccountRef: w.receivingAccountRef });
    assert.equal(code(await ctx.attempt(() => reused.run())), LOSER, "one settlement per bank transaction");
    assert.equal(await reused.effect(), "NONE");
    assert.deepEqual(sameButJournal(await footprint(w), fp).settlements, fp.settlements);
    await assertBalanced(w, "retry");
  });

  cell(t("DENY", "REVOCATION", "each prerequisite"), "revocation", async (ctx) => {
    const { bw } = L();
    for (const what of OWNER_PREREQUISITES) {
      const o = await ownOwner(`st2-revoke-${what}`);
      const w = await withdrawal(`st2-revoke-${what}`);
      const before = await footprint(w);
      const { proof } = await proofOf(o.person);
      const held = await holdStream(w.accountRef, "OUTBOUND");
      try {
        const { waiting } = await bw.mustWaitOn(ctx, held, (c) => routed(ctx, c, () => w.run({ owner: o.person, proof })), "CMD215 held at its first lock");
        await ctx.revoked(`${what} while CMD215 is held`, () => revokeOwner(what, o, proof));
        await held.release();
        const expected = what === "grant" ? "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING" : what === "identity" ? "403 NOT_AUTHORIZED IDENTITY_DISABLED" : "403 ASSURANCE_REQUIRED STEP_UP_STALE";
        await ctx.fenced(`CMD215 after the ${what} was withdrawn`, () => asRefusal(waiting.pending.then(valueOf)), refusedAs(expected));
      } finally {
        await held.release();
      }
      assert.equal(await w.effect(), "NONE", `${what}: refused`);
      assert.deepEqual(sameButJournal(await footprint(w), before), before, `${what}: nothing written`);
    }
    // an agency BILLING member is no corporate owner
    const a = await agentOf(L().iw, "st2-billing");
    const w = await withdrawal("st2-revoke-billing");
    assert.equal(code(await w.run({ owner: a.billing, agency: a.s.agency.agencyId })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING", "agency billing is refused");
    assert.equal(await w.effect(), "NONE");
  });

  cell(t("RACE", "PARTIAL", "last posting line fails"), "partial", async (ctx) => {
    const { iw } = L();
    const w = await withdrawal("st2-partial");
    const before = await footprint(w);
    const key = freshKey("partial");
    const steps: ReadonlyArray<SqlStep> = [{ label: "first_write", match: /INSERT INTO kauro\.settlements/ }, ...LATER_WRITES];
    for (const at of ["last_line", "first_line", "event_insert", "outbox_insert", "journal_final"]) {
      const conn = await openPay();
      try {
        await ctx.partial(`CMD215 failing at ${at}`, `db.${at}.before`, async () => {
          const seen = iw.w.internalErrors.length;
          const r = await routed(ctx, conn, () => w.run({ key }), steps);
          if (r.status >= 500) throw iw.w.internalErrors[seen]?.error ?? new Error(String(r.status));
          return r;
        });
      } finally {
        await conn.end();
      }
      assert.deepEqual(sameButJournal(await footprint(w), before), before, `${at}: the whole footprint rolled back`);
      assert.equal(await w.effect(), "NONE", `${at}: not settled`);
    }
    const done = await w.run({ key });
    assert.equal(done.status, 201, `the same key then succeeds once: ${done.text}`);
    assert.deepEqual((await footprint(w)).ledger, postingsOf(w), "one whole set");
    await assertBalanced(w, "partial");
  });
}

