// O27A application services: the simulated ACH account reconciled into a journal (idempotent, balanced, refused in LIVE and for a real
// source while PV1 is not met) and refund execution under the never-resend fence (two racing executors post once; UNCERTAIN only GETs;
// the ledger records a refund only when it COMPLETED). No network, no provider, 0 spend.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rawDigest, type Sha256Hex } from "@kauro/contracts";
import { SimulatedAchReceiptSource, SimulatedRefundRail, accountBalances, isBalanced, unassignedRefundPostings, type ReceiptObservation, type ReceivableOrder, type RefundExecution, type ReceiptSource } from "@kauro/domain";
import { InMemoryReceiptJournal, InMemoryRefundStore, executeRefund, reconcileReceipts } from "../src/index.js";

const h = (s: string): Sha256Hex => rawDigest(new TextEncoder().encode(s));
const PAYER = h("payer");
const ACCOUNT = "acct-sim-app";

const order = (receivedCents: bigint): ReceivableOrder => ({
  keys: {
    orderId: "order-app-1",
    reference: "KAURO-APP-0001",
    expectedAmountCents: 50_000n,
    currency: "USD",
    acceptedPayerDigest: PAYER,
    payeeDigest: null,
    acceptedRails: ["ACH"],
    transferExpiresAt: "2026-11-01T00:00:00.000Z",
    providerTimeToleranceMs: 10_000,
    accountRef: ACCOUNT,
  },
  serviceCents: 50_000n,
  taxCents: 0n,
  receivedCents,
  holdEndedUnpaid: false,
});

const credit = (sourceRef: string, grossCents: bigint, over: Partial<ReceiptObservation> = {}): Omit<ReceiptObservation, "accountRef"> => ({
  sourceRef,
  rail: "ACH",
  status: "COMPLETED",
  currency: "USD",
  grossCents,
  reference: "KAURO-APP-0001",
  bookedAt: "2026-10-27T15:00:00.000Z",
  payerDigest: PAYER,
  payeeDigest: null,
  evidenceHash: h(`ev-${sourceRef}-${grossCents}`),
  ...over,
});

test("O27A-APP: a simulated ACH account reconciles into a balanced journal once; a second run records nothing", async () => {
  const source = new SimulatedAchReceiptSource(ACCOUNT);
  source.script(credit("tx-1", 30_000n));
  source.script(credit("tx-1", 30_000n));
  source.script(credit("tx-2", 25_000n)); // 5 000 over
  source.script(credit("tx-3", 9_000n, { reference: "KAURO-NOBODY" }));
  const journal = new InMemoryReceiptJournal();
  let received = 0n;
  const run = async () =>
    reconcileReceipts({
      source,
      environment: "SANDBOX",
      store: journal,
      orderFor: (ref) => (ref === "KAURO-APP-0001" ? order(received) : null),
      onApplied: (o) => {
        received += o.appliedServiceCents + o.appliedTaxCents;
      },
    });
  const first = await run();
  assert.equal(first.kind, "DONE");
  if (first.kind !== "DONE") return;
  assert.equal(first.recorded, 3);
  assert.ok(isBalanced(journal.postings));
  const balances = accountBalances(journal.postings);
  assert.equal(balances.get("CONTRACT_LIABILITY"), -50_000n, "the order is paid exactly once");
  assert.equal(balances.get("CUSTOMER_OVERPAYMENT"), -14_000n, "the 5 000 excess and the 9 000 unassigned are owed back");
  assert.equal(balances.get("PSP_AVAILABLE"), 64_000n);
  const second = await run();
  assert.equal(second.kind === "DONE" && second.recorded, 0);
  assert.equal(received, 50_000n);
  assert.equal(source.spentCents, 0n);
});

test("O27A-APP: the simulator never runs in LIVE and a real source stays off until PV1", async () => {
  const journal = new InMemoryReceiptJournal();
  const sim = new SimulatedAchReceiptSource(ACCOUNT);
  assert.deepEqual(await reconcileReceipts({ source: sim, environment: "LIVE", store: journal, orderFor: () => null }), { kind: "REFUSED", reason: "SIMULATOR_NOT_IN_LIVE" });
  const real = { kind: "WISE", accountRef: ACCOUNT, list: async () => ({ items: [], next: null }), get: async () => null } as unknown as ReceiptSource;
  assert.deepEqual(await reconcileReceipts({ source: real, environment: "SANDBOX", store: journal, orderFor: () => null }), { kind: "REFUSED", reason: "REAL_SOURCE_NOT_ACTIVE" });
  assert.equal(journal.entries.size, 0);
});

const approved = (refundId: string): RefundExecution => ({ refundId, amountCents: 14_000n, currency: "USD", state: "APPROVED", attemptDeclared: false, reconciliations: 0 });

test("O27A-APP: two executors racing on one refund post once; the loser writes nothing", async () => {
  const store = new InMemoryRefundStore();
  await store.create(approved("r-race"));
  const rail = new SimulatedRefundRail({ effect: "EXECUTES", answer: "TIMEOUT", lagLookups: 1 });
  const [a, b] = await Promise.all([executeRefund({ refundId: "r-race", rail, store }), executeRefund({ refundId: "r-race", rail, store })]);
  assert.equal(rail.totalPosts(), 1);
  assert.ok([a.state, b.state].includes("COMPLETED"));
  assert.equal((await store.load("r-race"))?.state, "COMPLETED");
  assert.equal(store.completions.size, 1);
  // driving it again after completion does nothing
  await executeRefund({ refundId: "r-race", rail, store });
  assert.equal(rail.totalPosts(), 1);
});

test("O27A-APP: an uncertain refund is never resent and records no ledger effect until it is found; a dropped one goes to the owner", async () => {
  const store = new InMemoryRefundStore();
  await store.create(approved("r-drop"));
  const dropped = new SimulatedRefundRail({ effect: "DROPS", answer: "TIMEOUT" });
  const r = await executeRefund({ refundId: "r-drop", rail: dropped, store });
  assert.equal(r.state, "MANUAL_RESOLUTION");
  assert.equal(dropped.totalPosts(), 1);
  assert.equal(store.completions.size, 0, "no postings for a refund that is not known to have happened");
  for (let i = 0; i < 3; i += 1) await executeRefund({ refundId: "r-drop", rail: dropped, store });
  assert.equal(dropped.totalPosts(), 1, "re-driving never posts again");
  // an executor that tries to reset the fence is refused by the store
  const now = (await store.loadVersioned("r-drop"))!;
  await assert.rejects(store.transition("r-drop", now.version, { ...approved("r-drop") }, null));
});

test("O27A-APP: a late credit and its completed refund leave the journal balanced with every account at zero", async () => {
  const source = new SimulatedAchReceiptSource(ACCOUNT);
  source.script(credit("tx-late", 50_000n, { bookedAt: "2026-11-01T00:00:10.001Z" }));
  const journal = new InMemoryReceiptJournal();
  const run = await reconcileReceipts({ source, environment: "SANDBOX", store: journal, orderFor: () => order(0n) });
  assert.equal(run.kind === "DONE" && run.outcomes[0]?.kind, "REVIEW_AND_REFUND");
  const store = new InMemoryRefundStore();
  await store.create({ ...approved("r-late"), amountCents: 50_000n });
  const done = await executeRefund({ refundId: "r-late", rail: new SimulatedRefundRail({ effect: "EXECUTES", answer: "TRUTHFUL" }), store });
  assert.equal(done.state, "COMPLETED");
  const all = [...journal.postings, ...(store.completions.get("r-late") ?? [])];
  assert.ok(isBalanced(all));
  for (const [account, net] of accountBalances(all)) assert.equal(net, 0n, account);
});

test("review O27A F-1: two concurrent runs over one journal record each credit once and fire onApplied only for what they recorded", async () => {
  const journal = new InMemoryReceiptJournal();
  const sourceA = new SimulatedAchReceiptSource(ACCOUNT);
  const sourceB = new SimulatedAchReceiptSource(ACCOUNT);
  for (const s of [sourceA, sourceB]) s.script(credit("tx-c", 30_000n));
  let fired = 0;
  const run = (source: SimulatedAchReceiptSource) =>
    reconcileReceipts({ source, environment: "SANDBOX", store: journal, orderFor: () => order(0n), onApplied: () => { fired += 1; } });
  const [x, y] = await Promise.all([run(sourceA), run(sourceB)]);
  const recorded = (x.kind === "DONE" ? x.recorded : 0) + (y.kind === "DONE" ? y.recorded : 0);
  assert.equal(recorded, 1);
  assert.equal(fired, 1, "onApplied fires only for the run whose record succeeded");
  assert.equal(accountBalances(journal.postings).get("CONTRACT_LIABILITY"), -30_000n);
  // a later credit is allocated against the journal's recorded balance: 20 000 service, 10 000 excess
  const later = new SimulatedAchReceiptSource(ACCOUNT);
  later.script(credit("tx-d", 30_000n));
  await reconcileReceipts({ source: later, environment: "SANDBOX", store: journal, orderFor: () => order(0n) });
  const balances = accountBalances(journal.postings);
  assert.equal(balances.get("CONTRACT_LIABILITY"), -50_000n, "never more service than the order's obligation");
  assert.equal(balances.get("CUSTOMER_OVERPAYMENT"), -10_000n, "the excess is owed back");
});

test("review O27A M-1: a stale executor's write is refused; a completion and its postings are one atomic step", async () => {
  const store = new InMemoryRefundStore();
  await store.create(approved("r-cas"));
  // executor A declares the attempt (and posts)
  const v0 = (await store.loadVersioned("r-cas"))!;
  assert.equal(await store.declareAttempt("r-cas", v0.version), true);
  // executor B reads the row now: APPROVED with an attempt declared, so it would hand the refund to the owner
  const seenByB = (await store.loadVersioned("r-cas"))!;
  // A's rail answered: COMPLETED with its postings, in one call
  assert.equal(await store.transition("r-cas", seenByB.version, { ...seenByB.execution, state: "COMPLETED" }, unassignedRefundPostings(14_000n)), true);
  // B's MANUAL_RESOLUTION at the version it read is refused: the row stays COMPLETED with its one completion
  assert.equal(await store.transition("r-cas", seenByB.version, { ...seenByB.execution, state: "MANUAL_RESOLUTION" }, null), false);
  assert.equal((await store.load("r-cas"))?.state, "COMPLETED");
  assert.equal(store.completions.size, 1);
  // a COMPLETED without its postings, or postings without COMPLETED, is refused
  await store.create(approved("r-atomic"));
  const a0 = (await store.loadVersioned("r-atomic"))!;
  await assert.rejects(store.transition("r-atomic", a0.version, { ...a0.execution, state: "COMPLETED", attemptDeclared: true }, null));
  await assert.rejects(store.transition("r-atomic", a0.version, { ...a0.execution, state: "UNCERTAIN", attemptDeclared: true }, unassignedRefundPostings(14_000n)));
  // executeRefund itself stops without writing when its version is stale
  const rail = new SimulatedRefundRail({ effect: "EXECUTES", answer: "TRUTHFUL" });
  const done = await executeRefund({ refundId: "r-atomic", rail, store });
  assert.equal(done.state, "COMPLETED");
  assert.equal(rail.totalPosts(), 1);
  assert.equal(store.completions.size, 2);
});
