// Lane PV1-SETTLE two-step (docs/design/PV1-SETTLE-two-step.md, D-SET-10): the shared fixtures of settlement-cells.test.ts (S) and
// ach-dispatch-cells.test.ts (D). CMD215 records an owner intent (kauro.settlement_requests, kauro_app); the PAYMENT_SERVICE consumer
// applies it on delivery of settlement_request.recorded.v1 (kauro_payment, apps/api/src/payments/bank-settlement-service.ts).
//
// FIXTURE GAP (reported, D-SET-5): no V1 producer moves bank-route money into PSP_AVAILABLE (the D-ACH-11 availability observation is
// not built), so `providerAvailable` seeds a route's provider-available balance by an oracle posting set (a 0017 provider balance
// observation with its SETTLEMENT set DEBIT PSP_AVAILABLE / CREDIT PSP_RECEIVABLE). Without it, an apply refuses FUNDS_UNAVAILABLE.
//
// Dispatcher of the lane: the real createPaymentDispatcher over the world's payment runtime, its clock the process clock plus a lane
// offset (scheduling only: lease and claim instants, retryAt; never a judgment), its payment adapters' bank binding the world's
// CONTRACT_FAKE store and classifier (§3.0) or none (`bank: false`).
import assert from "node:assert/strict";
import { contractFakeBankDetailsClassifier, fakeBankReceiptBytes, fakeSettlementBytes } from "@kauro/application/testing";
import { toUtcInstant, type Clock, type LeaseOwnerId } from "@kauro/domain";
import { PgEventPublisher } from "@kauro/persistence";
import { connectionPid, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import "../src/payments/index.js";
import { paymentServiceEffect } from "../src/payments/consumers.js";
import { DISPATCH_LEASE_SECONDS, createPaymentDispatcher, type DispatchPass, type PaymentDispatcher } from "../src/payments/dispatcher.js";
import type { PaymentRuntime } from "../src/payments/runtime.js";
import type { HeldLock, StoredBankArtifact } from "./bank-support.js";
import type { SqlStep } from "./fault-support.js";
import { ids, type Person, type Reply } from "./support.js";
import { L, count, dataOf, openApp, openPay, ownerCall, ownerGet, plusMs, q, reach, routeFor, safe, type OwnerCall } from "./inbound-lane-support.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** REQUEST_STALE: an intent older than this at the apply's effect instant is refused (plan §3.3 A7, 900 s). */
export const STALE_AFTER_MS = 900_000;
export const RECORDED_EVENT = "settlement_request.recorded.v1";
export const settleRoute = (accountRef: string): string => `/api/v1/operations/bank-accounts/${accountRef}/settlements`;
export const requestRoute = (accountRef: string, requestId: string): string => `${settleRoute(accountRef)}/${requestId}`;
export const replayedBody = (text: string): string => {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    delete j["replayed"];
    return JSON.stringify(j);
  } catch {
    return text;
  }
};
export const settledOf = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> => p.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);

// --- the two-step's table must exist (an assertion, never a crash of the harness) --------------------------------------------------------

/** The lane's intent table (0071): absent, CMD215 records no intent and nothing below can be asked of it. */
export async function twoStep(): Promise<void> {
  const [r] = await q<{ t: string | null }>("SELECT to_regclass('kauro.settlement_requests')::text AS t");
  assert.ok(r?.t !== null && r?.t !== undefined, "kauro.settlement_requests exists: CMD215 records an owner intent the payment service applies (two-step, D-SET-10)");
}
const hasRequests = async (): Promise<boolean> => (await q<{ t: string | null }>("SELECT to_regclass('kauro.settlement_requests')::text AS t"))[0]?.t != null;

// --- routes and money --------------------------------------------------------------------------------------------------------------

export interface SettleRoute {
  readonly routeId: string;
  readonly accountRef: string;
  readonly paymentRouteId: string;
}
let seq = 0;
export async function settleRouteFor(label: string): Promise<SettleRoute> {
  const r = await routeFor(`set-${label}`, [L().iw.w.A.agencyId]);
  const [row] = await q<{ p: string }>("SELECT payment_route_id::text AS p FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]);
  return { routeId: r.routeId, accountRef: r.accountRef, paymentRouteId: row!.p };
}
/** FIXTURE GAP (header): the route's provider-available balance, seeded by the oracle as one balanced SETTLEMENT-sourced set. */
export async function providerAvailable(route: SettleRoute, cents: bigint): Promise<void> {
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
export async function availableOf(route: SettleRoute): Promise<bigint> {
  const [r] = await q<{ n: string }>(
    "SELECT coalesce(sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_cents ELSE -e.amount_cents END), 0)::text AS n FROM kauro.ledger_entries e JOIN kauro.settlements s ON s.settlement_id = e.settlement_id WHERE s.route_id = $1 AND e.account_code = 'PSP_AVAILABLE'",
    [route.paymentRouteId],
  );
  return BigInt(r!.n);
}

// --- withdrawals and CMD215 ----------------------------------------------------------------------------------------------------------

export interface WithdrawalCfg {
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
/** The facts the artifacts state (what an intent freezes and the apply re-verifies). */
export interface WithdrawalFacts {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly observedAt: string;
  readonly bookedAt: string;
  readonly receiptObservedAt: string;
  readonly bankAvailableCents: bigint;
}
export interface Withdrawal {
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
  readonly facts: WithdrawalFacts;
  run(o?: OwnerCall & { readonly variant?: boolean }): Promise<Reply>;
  /** NONE (no intent), RECORDED (an unconsumed intent), SETTLED (a settlement exists) or REFUSED (its latest intent was refused). */
  effect(): Promise<string>;
}
export async function store(accountRef: string, bytes: Uint8Array): Promise<StoredBankArtifact> {
  const { artifactRef, sha256 } = await L().bw.evidence.put({ bytes, accountRef: accountRef as never });
  return { artifactRef, evidenceHash: sha256 };
}
export const body = (s: StoredBankArtifact, r: StoredBankArtifact | null): Record<string, unknown> => ({ artifactRef: s.artifactRef, evidenceHash: s.evidenceHash, receipt: r === null ? null : { artifactRef: r.artifactRef, evidenceHash: r.evidenceHash } });
export const settle = (accountRef: string, s: StoredBankArtifact, r: StoredBankArtifact | null, o: OwnerCall = {}): Promise<Reply> => ownerCall(settleRoute(accountRef), body(s, r), o, "set");

export async function withdrawal(label: string, cfg: WithdrawalCfg = {}): Promise<Withdrawal> {
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
  const facts: WithdrawalFacts = {
    periodStart: plusMs(at, -3 * HOUR),
    periodEnd: i.periodEnd ?? at,
    observedAt: i.observedAt ?? at,
    bookedAt: i.bookedAt ?? at,
    receiptObservedAt: i.receiptObservedAt ?? at,
    bankAvailableCents: cfg.bankAvailableCents ?? (receivedCents ?? 0n) + 250_000n,
  };
  const settlement = await store(route.accountRef, fakeSettlementBytes(route.accountRef, { currency: "USD", periodStart: facts.periodStart, periodEnd: facts.periodEnd, withdrawalId, grossCents: withdrawnCents + feeCents, feeCents, heldCents: 0n, withdrawnCents, observedAt: facts.observedAt }));
  const receipt =
    receivedCents === null
      ? null
      : await store(route.accountRef, fakeBankReceiptBytes(route.accountRef, { receivingAccountRef, withdrawalId, bankTransactionId, currency: "USD", receivedCents, bankAvailableCents: facts.bankAvailableCents, bookedAt: facts.bookedAt, observedAt: facts.receiptObservedAt }));
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
    facts,
    // the variant body cites the same settlement without its receipt: another request digest under the same key
    run: (o = {}) => settle(route.accountRef, settlement, o.variant === true ? null : receipt, o),
    effect: async () => {
      if ((await count("SELECT 1 FROM kauro.settlements WHERE account_ref = $1 AND withdrawal_id = $2", [route.accountRef, withdrawalId])) > 0) return "SETTLED";
      if (!(await hasRequests())) return "NONE";
      const [r] = await q<{ o: string | null }>("SELECT outcome AS o FROM kauro.settlement_requests WHERE account_ref = $1 AND withdrawal_id = $2 ORDER BY requested_at DESC, request_id DESC LIMIT 1", [route.accountRef, withdrawalId]);
      return r === undefined ? "NONE" : (r.o ?? "RECORDED");
    },
  };
}

/** CMD215's 201: the recorded intent (§3.2), never a settlement. */
export interface RequestView {
  readonly requestId: string;
  readonly accountRef: string;
  readonly withdrawalId: string;
  readonly state: string;
  readonly requestedAt: string;
}
export function recordOf(r: Reply, w: Pick<Withdrawal, "accountRef" | "withdrawalId">, what = "CMD215"): RequestView {
  const data = dataOf<{ settlementRequest?: RequestView; settlement?: unknown }>(r, 201, what);
  assert.ok(data.settlementRequest !== undefined, `${what} answers the recorded intent { settlementRequest }, never a settlement it moved money for: ${r.text}`);
  const v = data.settlementRequest;
  assert.deepEqual([v.accountRef, v.withdrawalId, v.state], [w.accountRef, w.withdrawalId, "RECORDED"], `${what}: the intent of ${w.withdrawalId} is RECORDED`);
  return v;
}
/** A withdrawal whose intent CMD215 recorded (201): the intent's id. */
export async function recorded(label: string, cfg: WithdrawalCfg = {}, o: OwnerCall = {}): Promise<{ readonly w: Withdrawal; readonly requestId: string }> {
  const w = await withdrawal(label, cfg);
  return { w, requestId: recordOf(await w.run(o), w, `CMD215 records ${label}`).requestId };
}

// --- intents, cases and the footprint oracle (superuser reads only) ------------------------------------------------------------------

export interface RequestRow {
  readonly state: string;
  readonly reason: string | null;
  readonly settlementId: string | null;
  readonly reviewCaseId: string | null;
  readonly requestedAt: string;
  readonly consumedAt: string | null;
  readonly requestedBy: string;
  readonly version: number;
}
export async function requestRow(requestId: string): Promise<RequestRow> {
  await twoStep();
  const [r] = await q<{ o: string | null; reason: string | null; s: string | null; c: string | null; ra: string; ca: string | null; by: string; v: string }>(
    `SELECT outcome AS o, refusal_reason AS reason, settlement_id::text AS s, review_case_id::text AS c,
            to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ra,
            to_char(consumed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ca, requested_by::text AS by, version::text AS v
       FROM kauro.settlement_requests WHERE request_id = $1`,
    [requestId],
  );
  assert.ok(r !== undefined, `the intent ${requestId} is recorded`);
  return { state: r.o ?? "RECORDED", reason: r.reason, settlementId: r.s, reviewCaseId: r.c, requestedAt: r.ra, consumedAt: r.ca, requestedBy: r.by, version: Number(r.v) };
}
/** [state, reason] of every intent of the withdrawal, in record order. */
export async function requestsOf(w: Pick<Withdrawal, "accountRef" | "withdrawalId">): Promise<ReadonlyArray<readonly [string, string | null]>> {
  if (!(await hasRequests())) return [];
  return (await q<{ o: string | null; r: string | null }>("SELECT outcome AS o, refusal_reason AS r FROM kauro.settlement_requests WHERE account_ref = $1 AND withdrawal_id = $2 ORDER BY requested_at, request_id", [w.accountRef, w.withdrawalId])).map((x) => [x.o ?? "RECORDED", x.r] as const);
}
/** [kind, state, detail_code] of the SETTLEMENT_REFUSED cases of the account's intents (source SETTLEMENT_REQUEST). */
export async function casesOf(w: Pick<Withdrawal, "accountRef">): Promise<ReadonlyArray<readonly [string, string, string]>> {
  return (await q<{ k: string; s: string; d: string }>("SELECT kind AS k, state AS s, detail_code AS d FROM kauro.bank_review_cases WHERE account_ref = $1 AND kind = 'SETTLEMENT_REFUSED' ORDER BY opened_at, case_id", [w.accountRef])).map((x) => [x.k, x.s, x.d] as const);
}

export interface SettlementFootprint {
  readonly settlements: ReadonlyArray<readonly [string, string, string | null, string]>;
  readonly events: number;
  readonly outbox: number;
  readonly journal: number;
  readonly ledger: ReadonlyArray<readonly [string, string, string]>;
  readonly available: string;
  /** [state, reason] of the account's intents, in record order. */
  readonly requests: ReadonlyArray<readonly [string, string | null]>;
  /** The intents' own events (recorded, applied, refused). */
  readonly requestEvents: number;
  readonly cases: ReadonlyArray<readonly [string, string, string]>;
}
export async function footprint(w: Pick<Withdrawal, "route">): Promise<SettlementFootprint> {
  const rows = await q<{ id: string; w: string; c: string; r: string | null; b: string }>(
    "SELECT settlement_id::text AS id, withdrawal_id AS w, withdrawn_cents::text AS c, received_cents::text AS r, bank_available_cents::text AS b FROM kauro.settlements WHERE account_ref = $1 ORDER BY settlement_id",
    [w.route.accountRef],
  );
  const idsOf = rows.map((r) => r.id);
  const reqs = (await hasRequests())
    ? await q<{ id: string; o: string | null; r: string | null }>("SELECT request_id::text AS id, outcome AS o, refusal_reason AS r FROM kauro.settlement_requests WHERE account_ref = $1 ORDER BY requested_at, request_id", [w.route.accountRef])
    : [];
  const reqIds = reqs.map((r) => r.id);
  return {
    settlements: rows.map((r) => [r.w, r.c, r.r, r.b] as const),
    events: await count("SELECT 1 FROM kauro.domain_events WHERE aggregate_kind = 'settlement' AND aggregate_id::text = ANY($1::text[])", [idsOf]),
    outbox: await count("SELECT 1 FROM kauro.outbox_records o JOIN kauro.domain_events e USING (event_id) WHERE e.aggregate_kind = 'settlement' AND e.aggregate_id::text = ANY($1::text[])", [idsOf]),
    journal: await count("SELECT 1 FROM kauro.command_journal WHERE resource_id::text = ANY($1::text[])", [[...idsOf, ...reqIds]]),
    ledger: (await q<{ a: string; d: string; n: string }>("SELECT account_code AS a, direction AS d, amount_cents::text AS n FROM kauro.ledger_entries WHERE settlement_id::text = ANY($1::text[]) ORDER BY settlement_id, line_no", [idsOf])).map((r) => [r.a, r.d, r.n] as const),
    available: (await availableOf(w.route)).toString(),
    requests: reqs.map((r) => [r.o ?? "RECORDED", r.r] as const),
    requestEvents: await count("SELECT 1 FROM kauro.domain_events WHERE aggregate_kind = 'settlement_request' AND aggregate_id::text = ANY($1::text[])", [reqIds]),
    cases: await casesOf({ accountRef: w.route.accountRef }),
  };
}
export const sameButJournal = (a: SettlementFootprint, b: SettlementFootprint): SettlementFootprint => ({ ...a, journal: b.journal });
/** Every posting set of the route's settlements balances by itself (D-SET-6), and PSP_AVAILABLE never goes below zero. */
export async function assertBalanced(w: Pick<Withdrawal, "route">, what: string): Promise<void> {
  const unbalanced = await q<{ id: string; net: string }>(
    "SELECT e.settlement_id::text AS id, sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_cents ELSE -e.amount_cents END)::text AS net FROM kauro.ledger_entries e JOIN kauro.settlements s ON s.settlement_id = e.settlement_id WHERE s.route_id = $1 GROUP BY 1 HAVING sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_cents ELSE -e.amount_cents END) <> 0",
    [w.route.paymentRouteId],
  );
  assert.deepEqual(unbalanced, [], `${what}: every settlement set balances by itself`);
  assert.ok((await availableOf(w.route)) >= 0n, `${what}: no settlement of imaginary liquidity`);
}
/** The postings of one settlement (D-SET-6): the release and fee leave PSP_AVAILABLE; only the receipt makes BANK_CASH. */
export const postingsOf = (w: Withdrawal): ReadonlyArray<readonly [string, string, string]> =>
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

// --- locks of the other actors ---------------------------------------------------------------------------------------------------------

/** The payout cash basis lock (CMD052's, 0043) held by a payment-login connection standing in for a payout approval at its funds fence. */
export async function holdPayoutCash(): Promise<HeldLock> {
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
/** What a payout approval reads at its fence once it holds the lock (commercial-statements.ts payoutCash): the account's settlements. */
export async function fenceRead(c: HarnessConnection, accountRef: string): Promise<{ readonly settled: number }> {
  await c.query("BEGIN");
  try {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('kauro.payout-cash', 0))");
    const r = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.settlements WHERE account_ref = $1", [accountRef]);
    return { settled: r.rows[0]!.n };
  } finally {
    await c.query("ROLLBACK");
  }
}
/** The payout cash basis exactly as commercial-statements.ts:888-903 reads it (the oracle, outside every lock). */
export async function payoutBasis(): Promise<{ readonly bankAvailableCents: string; readonly unsettledAuthorizedCents: string }> {
  const [bank] = await q<{ b: string }>("SELECT bank_available_cents::text AS b FROM kauro.settlements WHERE bank_evidence_hash IS NOT NULL ORDER BY observed_at DESC, settlement_id DESC LIMIT 1");
  const [claimed] = await q<{ c: string }>(
    `SELECT coalesce(sum(p.amount_cents), 0)::text AS c FROM kauro.payout_intents p
      WHERE p.state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN')
         OR (p.state = 'SETTLED' AND NOT EXISTS (SELECT 1 FROM kauro.settlements s WHERE s.bank_evidence_hash IS NOT NULL AND s.observed_at > p.settled_at))`,
  );
  return { bankAvailableCents: bank?.b ?? "0", unsettledAuthorizedCents: claimed!.c };
}

// --- the apply: the PAYMENT_SERVICE consumer --------------------------------------------------------------------------------------------

/** The lane's dispatcher clock offset and lease owner (scheduling only). Starts past any lease the world's own dispatcher could hold. */
const lane = { ms: (DISPATCH_LEASE_SECONDS + 1) * 1000, owner: ids.next() as LeaseOwnerId };
const offsetClock = (ms: number): Clock => ({ now: () => toUtcInstant(Date.now() + ms), nowMs: () => Date.now() + ms });

export interface LaneRuntimeOptions {
  /** false: the payment adapters bind no bank store or classifier (EVIDENCE_UNAVAILABLE, retryable). */
  readonly bank?: boolean;
  /** Extra milliseconds on this dispatcher's clock (a rival past the lane owner's lease and claim). */
  readonly extraMs?: number;
}
/** The world's payment runtime with the §3.0 bank binding of its adapters and the lane's scheduling clock. */
export function laneRuntime(o: LaneRuntimeOptions = {}): PaymentRuntime {
  const rt = L().iw.pw.service.runtime;
  const bank = o.bank === false ? { evidence: () => null, classifier: () => null } : { evidence: () => L().bw.evidence, classifier: () => contractFakeBankDetailsClassifier };
  return { ...rt, clock: offsetClock(lane.ms + (o.extraMs ?? 0)), assembly: { ...rt.assembly, bank } as unknown as PaymentRuntime["assembly"] };
}
export function laneDispatcher(o: LaneRuntimeOptions & { readonly owner?: LeaseOwnerId } = {}): PaymentDispatcher {
  const rt = laneRuntime(o);
  return createPaymentDispatcher(rt, [paymentServiceEffect(rt)], { ownerId: o.owner ?? lane.owner });
}
/** One real pass of the PAYMENT_SERVICE dispatcher (every due record of the consumer), as the lane's lease owner. */
export async function dispatchPayment(o: LaneRuntimeOptions = {}): Promise<DispatchPass> {
  const pass = await laneDispatcher(o).runOnce("PAYMENT_SERVICE", { limit: 100 });
  assert.equal(pass.held, false, "the lane's dispatcher holds the PAYMENT_SERVICE lease");
  return pass;
}
/** Moves the lane's dispatcher clock on (a retryAt or a claim becoming due). */
export function advance(ms: number): void {
  lane.ms += ms;
}
/** A rival takes the lane's lease over (`extraMs` past the owner's lease and claims): the rival is the lane's owner from then on. */
export function takeOver(extraMs: number): { readonly rival: PaymentDispatcher; readonly stale: PaymentDispatcher } {
  const stale = laneDispatcher();
  const owner = ids.next() as LeaseOwnerId;
  const rival = laneDispatcher({ extraMs, owner });
  lane.ms += extraMs;
  lane.owner = owner;
  return { rival, stale };
}
/** Delivers every record due before a cell (unrouted): a cell's armed points then meet only its own delivery. */
export async function drain(): Promise<void> {
  advance((DISPATCH_LEASE_SECONDS + 1) * 1000);
  for (let i = 0; i < 5; i++) if ((await dispatchPayment()).deliveries.length === 0) return;
  assert.fail("earlier cells' PAYMENT_SERVICE records keep coming due");
}
/** The pass's delivery of the intent's recorded event. */
export async function deliveryIn(pass: DispatchPass, requestId: string): Promise<DispatchPass["deliveries"][number]> {
  const eventId = await recordedEventOf(requestId);
  const d = pass.deliveries.find((x) => x.eventId === eventId);
  assert.ok(d !== undefined, `the pass delivered ${RECORDED_EVENT} of ${requestId}: ${JSON.stringify(pass.deliveries)}`);
  return d;
}
export async function recordedEventOf(requestId: string): Promise<string> {
  const [e] = await q<{ id: string }>("SELECT event_id::text AS id FROM kauro.domain_events WHERE aggregate_kind = 'settlement_request' AND aggregate_id::text = $1 AND event_type = $2", [requestId, RECORDED_EVENT]);
  assert.ok(e !== undefined, `the intent ${requestId} published ${RECORDED_EVENT}`);
  return e.id;
}
/** The intent's recorded event handed straight to the PAYMENT_SERVICE consumer (what the dispatcher hands it: agency null). */
export async function deliver(requestId: string, o: LaneRuntimeOptions = {}): Promise<string> {
  const eventId = await recordedEventOf(requestId);
  const [e] = await q<{ v: string; p: Record<string, unknown> }>("SELECT aggregate_version::text AS v, payload AS p FROM kauro.domain_events WHERE event_id = $1", [eventId]);
  return paymentServiceEffect(laneRuntime(o)).handle({ eventId: eventId as never, eventType: RECORDED_EVENT, agencyId: null as never, aggregateId: requestId, aggregateVersion: Number(e!.v), payload: e!.p } as never);
}
/** The PAYMENT_SERVICE outbox record of the intent's recorded event. */
export async function outboxOf(requestId: string): Promise<{ readonly state: string; readonly attempts: number; readonly error: string | null; readonly dueInMs: number }> {
  const eventId = await recordedEventOf(requestId);
  const [r] = await q<{ s: string; a: number; e: string | null; d: string }>(
    "SELECT state AS s, attempts AS a, last_error_code AS e, (extract(epoch FROM next_attempt_at) * 1000)::bigint::text AS d FROM kauro.outbox_records WHERE event_id = $1 AND consumer = 'PAYMENT_SERVICE'",
    [eventId],
  );
  assert.ok(r !== undefined, `${RECORDED_EVENT} of ${requestId} has its PAYMENT_SERVICE outbox record`);
  return { state: r.s, attempts: r.a, error: r.e, dueInMs: Number(r.d) - Date.now() };
}

// --- a direct owner insert (no CMD215: facts the record step would refuse or a forged intent) ---------------------------------------

export type RequestOverrides = Partial<Record<string, string | null>>;
/**
 * The owner's own INSERT of an intent on kauro_app (RLS acting_corporate_owner), with the facts the artifacts state unless overridden,
 * and its recorded.v1 event and outbox records (PgEventPublisher on the same transaction): what CMD215 R8 writes, without its checks.
 */
export async function directRequest(w: Withdrawal, over: RequestOverrides = {}, owner: Person = L().owner): Promise<string> {
  await twoStep();
  const requestId = ids.next();
  const stored = await L().bw.evidence.get(w.settlement.artifactRef);
  assert.ok(stored !== null, "the settlement artifact is stored");
  const r = w.receipt;
  const cols: Record<string, string | null> = {
    request_id: requestId,
    environment: L().bw.environment,
    account_ref: w.accountRef,
    withdrawal_id: w.withdrawalId,
    artifact_ref: w.settlement.artifactRef,
    evidence_hash: w.settlement.evidenceHash,
    currency: "USD",
    gross_cents: (w.withdrawnCents + w.feeCents).toString(),
    fee_cents: w.feeCents.toString(),
    held_cents: "0",
    withdrawn_cents: w.withdrawnCents.toString(),
    period_start: w.facts.periodStart,
    period_end: w.facts.periodEnd,
    observed_at: w.facts.observedAt,
    normalizer_version: stored.normalizerVersion,
    receipt_artifact_ref: r?.artifactRef ?? null,
    receipt_evidence_hash: r?.evidenceHash ?? null,
    receiving_account_ref: r === null ? null : w.receivingAccountRef,
    bank_transaction_id: r === null ? null : w.bankTransactionId,
    received_cents: w.receivedCents === null ? null : w.receivedCents.toString(),
    bank_available_cents: r === null ? null : w.facts.bankAvailableCents.toString(),
    booked_at: r === null ? null : w.facts.bookedAt,
    receipt_observed_at: r === null ? null : w.facts.receiptObservedAt,
    ...over,
  };
  const names = Object.keys(cols);
  const c = await openApp();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.user_id', $1, true)", [owner.userId]);
    await c.query(`INSERT INTO kauro.settlement_requests (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, names.map((n) => cols[n]));
    await new PgEventPublisher(c as never, ids, { now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() }).publish({
      aggregateKind: "settlement_request",
      aggregateId: requestId,
      aggregateVersion: 1,
      agencyId: null,
      eventType: RECORDED_EVENT,
      actor: { kind: "USER", userId: owner.userId },
      causationId: ids.next(),
      correlationId: ids.next(),
      payload: { requestId, evidenceHash: w.settlement.evidenceHash },
    } as never);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
  return requestId;
}

// --- reads -----------------------------------------------------------------------------------------------------------------------------

export interface OutcomeView {
  readonly requestId: string;
  readonly accountRef: string;
  readonly withdrawalId: string;
  readonly state: string;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly consumedAt: string | null;
  readonly reviewCaseId: string | null;
  readonly delivery: string;
  readonly settlement: { readonly withdrawalId: string; readonly withdrawnCents: string; readonly receivedCents: string | null; readonly bankEvidence: boolean } | null;
}
export const getRequest = (accountRef: string, requestId: string, owner?: Person): Promise<Reply> => ownerGet(requestRoute(accountRef, requestId), owner);
export async function outcomeOf(accountRef: string, requestId: string): Promise<OutcomeView> {
  return dataOf<{ settlementRequest: OutcomeView }>(await getRequest(accountRef, requestId), 200, "getBankSettlementRequest").settlementRequest;
}
export interface InTransitItem {
  readonly requestId: string;
  readonly withdrawalId: string;
  readonly state: string;
  readonly reason: string | null;
  readonly withdrawnCents: string;
  readonly receivedCents: string | null;
  readonly feeCents: string;
  readonly requestedAt: string;
  readonly ageSeconds: number;
  readonly delivery: string;
  readonly reviewCaseId: string | null;
}
export async function inTransit(accountRef: string, cursor?: string): Promise<{ readonly items: ReadonlyArray<InTransitItem>; readonly nextCursor: string | null }> {
  const url = cursor === undefined ? settleRoute(accountRef) : `${settleRoute(accountRef)}?cursor=${encodeURIComponent(cursor)}`;
  return dataOf<{ items: InTransitItem[]; nextCursor: string | null }>(await ownerGet(url), 200, "listBankSettlementsInTransit");
}

// --- a holder of one role and a waiter of another (holdAndWait observes the waiter on the holder's role only) --------------------------

export type Side = "app" | "pay";
export interface CrossActor<T> {
  readonly side: Side;
  readonly run: () => Promise<T>;
}
/**
 * The holder's real step paused at `at` (its locks kept), the waiter, on its own role's connection, observed waiting on the holder's
 * backend; then the holder released (or killed: `end: "kill"`). Each side routes its units over its own pair of connections.
 */
export async function crossHold<H, W>(ctx: FaultContext, what: string, holder: CrossActor<H> & { readonly at: string; readonly steps?: ReadonlyArray<SqlStep> }, waiter: CrossActor<W>, end: "release" | "kill" = "release"): Promise<{ readonly held: PromiseSettledResult<H>; readonly waited: PromiseSettledResult<W> }> {
  const { iw } = L();
  const hc = { app: await openApp(), pay: await openPay() };
  const wc = { app: await openApp(), pay: await openPay() };
  try {
    const pause = ctx.points.pause(holder.at);
    const running = ctx.operation(`${what} (holder)`, () => iw.faults.onRoles({ kauro_app: hc.app, kauro_payment: hc.pay }, ctx.points, holder.steps ?? [], holder.run));
    const held = settledOf(running);
    await reach(pause, running, what);
    const waiting = await ctx.mustWait(iw.h.oracle, { waiter: wc[waiter.side], holder: connectionPid(hc[holder.side]) }, () => iw.faults.onRoles({ kauro_app: wc.app, kauro_payment: wc.pay }, ctx.points, [], waiter.run), what);
    if (end === "kill") await ctx.kill(iw.h.oracle as never, hc[holder.side] as never, `${what}: the holder's backend`);
    pause.release();
    return { held: await held, waited: await waiting.pending };
  } finally {
    for (const c of [hc.app, hc.pay, wc.app, wc.pay]) await c.end().catch(() => undefined);
  }
}
