// O27A: the generic USD receipt over a fictitious ACH account, reconciliation, late credits, duplicates, the balanced ledger, receipts,
// uncertain refunds without resend and the invoice rules (DIAN off). Simulators only: no network, no provider, 0 spend.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rawDigest, type Sha256Hex } from "@kauro/contracts";
import {
  O27A_ACTIVATION,
  SimulatedAchReceiptSource,
  SimulatedRefundRail,
  accountBalances,
  allocateReceived,
  creditNoteRequired,
  decideInvoice,
  driveRefund,
  isBalanced,
  nextRefundStep,
  reconcileReceipt,
  reconcileSource,
  unassignedRefundPostings,
  type ReceiptObservation,
  type ReceivableOrder,
  type RefundExecution,
} from "../src/index.js";

const h = (s: string): Sha256Hex => rawDigest(new TextEncoder().encode(s));
const PAYER = h("payer");
const PAYEE = h("payee");
const ACCOUNT = "acct-sim-1";

const order = (over: Partial<ReceivableOrder> = {}): ReceivableOrder => ({
  keys: {
    orderId: "order-1",
    reference: "KAURO-REF-0001",
    expectedAmountCents: 115_000n,
    currency: "USD",
    acceptedPayerDigest: PAYER,
    payeeDigest: PAYEE,
    acceptedRails: ["ACH"],
    transferExpiresAt: "2026-10-30T04:00:00.000Z",
    providerTimeToleranceMs: 10_000,
    accountRef: ACCOUNT,
  },
  serviceCents: 100_000n,
  taxCents: 15_000n,
  receivedCents: 0n,
  holdEndedUnpaid: false,
  ...over,
});

const credit = (over: Partial<ReceiptObservation> = {}): ReceiptObservation => ({
  accountRef: ACCOUNT,
  sourceRef: "bank-tx-1",
  rail: "ACH",
  status: "COMPLETED",
  currency: "USD",
  grossCents: 115_000n,
  reference: "KAURO-REF-0001",
  bookedAt: "2026-10-27T15:00:00.000Z",
  payerDigest: PAYER,
  payeeDigest: PAYEE,
  evidenceHash: h("evidence-1"),
  ...over,
});

const none = new Map<string, Sha256Hex>();

test("O27A-RCPT: a fictitious ACH credit with the exact amount applies, balanced, with a receipt that is not an invoice", () => {
  const out = reconcileReceipt(credit(), { known: none, order: order(), accountRef: ACCOUNT });
  assert.equal(out.kind, "APPLIED");
  if (out.kind !== "APPLIED") return;
  assert.equal(out.coverage, "EXACT");
  assert.equal(out.appliedServiceCents, 100_000n);
  assert.equal(out.appliedTaxCents, 15_000n);
  assert.equal(out.excessCents, 0n);
  assert.ok(isBalanced(out.postings));
  assert.equal(out.receipt.isFiscalInvoice, false);
  assert.equal(out.receipt.currency, "USD");
  // deterministic receipt id: a replay names the same receipt
  const again = reconcileReceipt(credit(), { known: none, order: order(), accountRef: ACCOUNT });
  assert.equal(again.kind === "APPLIED" && again.receipt.receiptId, out.receipt.receiptId);
});

test("O27A-RCPT: partial credits, then the remainder, then an excess that becomes a refund review, never revenue", () => {
  assert.deepEqual(allocateReceived({ serviceCents: 100_000n, taxCents: 15_000n, receivedCents: 0n }, 60_000n), { serviceCents: 60_000n, taxCents: 0n, excessCents: 0n });
  assert.deepEqual(allocateReceived({ serviceCents: 100_000n, taxCents: 15_000n, receivedCents: 60_000n }, 50_000n), { serviceCents: 40_000n, taxCents: 10_000n, excessCents: 0n });
  assert.deepEqual(allocateReceived({ serviceCents: 100_000n, taxCents: 15_000n, receivedCents: 110_000n }, 10_000n), { serviceCents: 0n, taxCents: 5_000n, excessCents: 5_000n });
  const partial = reconcileReceipt(credit({ grossCents: 60_000n }), { known: none, order: order(), accountRef: ACCOUNT });
  assert.equal(partial.kind === "APPLIED" && partial.coverage, "PARTIAL");
  const over = reconcileReceipt(credit({ grossCents: 120_000n }), { known: none, order: order(), accountRef: ACCOUNT });
  assert.equal(over.kind, "APPLIED");
  if (over.kind !== "APPLIED") return;
  assert.equal(over.coverage, "EXCESS");
  assert.equal(over.excessCents, 5_000n);
  assert.equal(accountBalances(over.postings).get("CUSTOMER_OVERPAYMENT"), -5_000n, "the excess is owed back, not revenue");
  assert.equal(accountBalances(over.postings).get("SERVICE_REVENUE"), undefined);
});

test("O27A-RCPT: duplicates are idempotent; different evidence under the same bank id is a conflict review, never an overwrite", () => {
  const known = new Map([[`${ACCOUNT}\u0000bank-tx-1`, h("evidence-1")]]);
  assert.equal(reconcileReceipt(credit(), { known, order: order(), accountRef: ACCOUNT }).kind, "DUPLICATE");
  const conflict = reconcileReceipt(credit({ evidenceHash: h("evidence-2"), grossCents: 999n }), { known, order: order(), accountRef: ACCOUNT });
  assert.deepEqual(conflict, { kind: "REVIEW", key: `${ACCOUNT}\u0000bank-tx-1`, reason: "EVIDENCE_CONFLICT" });
});

test("O27A-RCPT: only a COMPLETED USD credit on the account is money; everything else waits or goes to review without effect", () => {
  const r = (o: Partial<ReceiptObservation>, ord: ReceivableOrder | null = order()) => reconcileReceipt(credit(o), { known: none, order: ord, accountRef: ACCOUNT });
  assert.equal(r({ status: "PENDING" }).kind, "PENDING");
  for (const status of ["DENIED", "REVERSED", "UNRECOGNIZED"] as const) assert.deepEqual(r({ status }), { kind: "REVIEW", key: `${ACCOUNT}\u0000bank-tx-1`, reason: "NOT_COMPLETED" });
  assert.equal(r({ currency: "EUR" }).kind === "REVIEW" && (r({ currency: "EUR" }) as { reason: string }).reason, "CURRENCY_NOT_USD");
  assert.equal((r({ payerDigest: h("someone else") }) as { reason: string }).reason, "PAYER_MISMATCH");
  assert.equal((r({ rail: "OTHER" }) as { reason: string }).reason, "RAIL_NOT_ACCEPTED");
  assert.equal((r({ reference: null }, null) as { reason: string }).reason, "REFERENCE_MISSING");
  assert.equal((r({ accountRef: "acct-other" }) as { reason: string }).reason, "ACCOUNT_MISMATCH");
  assert.throws(() => r({ grossCents: -1n }), RangeError);
});

test("O27A-RCPT: late credits — after the deadline, after a hold ended unpaid, or unassigned — are refunded, never applied, never reviving data", () => {
  const late = reconcileReceipt(credit({ bookedAt: "2026-10-30T04:00:10.001Z" }), { known: none, order: order(), accountRef: ACCOUNT });
  assert.equal(late.kind === "REVIEW_AND_REFUND" && late.reason, "LATE_AFTER_DEADLINE");
  const tolerated = reconcileReceipt(credit({ bookedAt: "2026-10-30T04:00:10.000Z" }), { known: none, order: order(), accountRef: ACCOUNT });
  assert.equal(tolerated.kind, "APPLIED", "inside the route's named tolerance");
  const afterHold = reconcileReceipt(credit(), { known: none, order: order({ holdEndedUnpaid: true }), accountRef: ACCOUNT });
  assert.equal(afterHold.kind, "REVIEW_AND_REFUND");
  if (afterHold.kind !== "REVIEW_AND_REFUND") return;
  assert.equal(afterHold.reason, "LATE_AFTER_HOLD_ENDED");
  assert.equal(afterHold.revivesData, false);
  // the late money and its completed refund leave every account at zero
  const all = [...afterHold.postings, ...unassignedRefundPostings(afterHold.amountCents)];
  assert.ok(isBalanced(all));
  for (const [account, net] of accountBalances(all)) assert.equal(net, 0n, account);
  const unassigned = reconcileReceipt(credit({ reference: "KAURO-UNKNOWN" }), { known: none, order: null, accountRef: ACCOUNT });
  assert.equal(unassigned.kind === "REVIEW_AND_REFUND" && unassigned.reason, "UNASSIGNED");
});

test("O27A-RCPT: a whole simulated account reconciles once — replays inside the run are duplicates and the run's ledger balances", async () => {
  const source = new SimulatedAchReceiptSource(ACCOUNT);
  source.script({ ...credit(), sourceRef: "t1", grossCents: 60_000n, evidenceHash: h("e1") });
  source.script({ ...credit(), sourceRef: "t1", grossCents: 60_000n, evidenceHash: h("e1") }); // the bank shows it again
  source.script({ ...credit(), sourceRef: "t2", grossCents: 60_000n, evidenceHash: h("e2") }); // 5 000 over
  source.script({ ...credit(), sourceRef: "t3", grossCents: 7_000n, reference: "KAURO-UNKNOWN", evidenceHash: h("e3") });
  source.script({ ...credit(), sourceRef: "t4", status: "PENDING", evidenceHash: h("e4") });
  const known = new Map<string, Sha256Hex>();
  // the order as stored when the run starts: the run itself keeps its running balance (review O27A F-1)
  const run = await reconcileSource(source, {
    known,
    pageSize: 2,
    orderFor: (ref) => (ref === "KAURO-REF-0001" ? order({ receivedCents: 0n }) : null),
  });
  let received = 0n;
  for (const o of run.outcomes) if (o.kind === "APPLIED") received += o.appliedServiceCents + o.appliedTaxCents;
  assert.deepEqual(run.outcomes.map((o) => o.kind), ["APPLIED", "DUPLICATE", "APPLIED", "REVIEW_AND_REFUND", "PENDING"]);
  assert.ok(isBalanced(run.postings));
  assert.equal(source.spentCents, 0n);
  assert.ok(source.calls.every((c) => c === "list" || c === "get"));
  // a second run over the same account changes nothing
  const second = await reconcileSource(source, { known, orderFor: () => order({ receivedCents: 120_000n }) });
  assert.deepEqual(second.outcomes.map((o) => o.kind), ["DUPLICATE", "DUPLICATE", "DUPLICATE", "DUPLICATE", "PENDING"]);
  assert.equal(second.postings.length, 0);
  assert.equal(received, 115_000n, "the order is paid exactly once; the 5 000 excess is owed back");
});

const exec = (over: Partial<RefundExecution> = {}): RefundExecution => ({ refundId: "refund-1", amountCents: 5_000n, currency: "USD", state: "APPROVED", attemptDeclared: false, reconciliations: 0, ...over });

test("O27A-REFUND: SUBMIT is answered once, only from APPROVED with no attempt; SUBMITTING and UNCERTAIN only reconcile by GET", () => {
  assert.equal(nextRefundStep(exec()).kind, "SUBMIT");
  assert.equal(nextRefundStep(exec({ attemptDeclared: true })).kind, "MANUAL_RESOLUTION");
  assert.equal(nextRefundStep(exec({ state: "SUBMITTING", attemptDeclared: true })).kind, "RECONCILE_GET");
  assert.equal(nextRefundStep(exec({ state: "UNCERTAIN", attemptDeclared: true })).kind, "RECONCILE_GET");
  assert.equal(nextRefundStep(exec({ state: "UNCERTAIN", attemptDeclared: true, reconciliations: 3 })).kind, "MANUAL_RESOLUTION");
  for (const state of ["COMPLETED", "FAILED", "MANUAL_RESOLUTION"] as const) assert.equal(nextRefundStep(exec({ state })).kind, "NONE");
});

test("O27A-REFUND: an uncertain refund is never resent — executed, lagging, dropped and refused providers", async () => {
  // the provider executed it but the answer timed out: GET finds it
  const executed = new SimulatedRefundRail({ effect: "EXECUTES", answer: "TIMEOUT" });
  assert.equal((await driveRefund(exec(), executed)).state, "COMPLETED");
  assert.equal(executed.totalPosts(), 1);
  // the provider shows it only after two lookups
  const lagging = new SimulatedRefundRail({ effect: "EXECUTES", answer: "TIMEOUT", lagLookups: 2 });
  assert.equal((await driveRefund(exec(), lagging)).state, "COMPLETED");
  assert.equal(lagging.totalPosts(), 1);
  // the provider never got it: NOT_FOUND is no proof, the owner resolves it by hand; no second POST
  const dropped = new SimulatedRefundRail({ effect: "DROPS", answer: "TIMEOUT" });
  const manual = await driveRefund(exec(), dropped);
  assert.equal(manual.state, "MANUAL_RESOLUTION");
  assert.equal(dropped.totalPosts(), 1);
  assert.equal(await driveRefund(manual, dropped).then((r) => r.state), "MANUAL_RESOLUTION");
  assert.equal(dropped.totalPosts(), 1, "driving it again still never posts");
  // refused under a timeout: the GET shows the refusal
  const refused = new SimulatedRefundRail({ effect: "REFUSES", answer: "TIMEOUT" });
  assert.equal((await driveRefund(exec(), refused)).state, "FAILED");
  assert.equal(refused.totalPosts(), 1);
  // a truthful success completes at once
  const ok = new SimulatedRefundRail({ effect: "EXECUTES", answer: "TRUTHFUL" });
  assert.equal((await driveRefund(exec(), ok)).state, "COMPLETED");
  for (const rail of [executed, lagging, dropped, refused, ok]) assert.equal(rail.spentCents, 0n);
});

test("O27A-REFUND: a found refund of another amount is a manual case, never a completion", async () => {
  const rail = new SimulatedRefundRail({ effect: "EXECUTES", answer: "TIMEOUT" });
  await rail.submit((await import("../src/index.js")).refundIdempotencyKey("refund-1"), 4_999n);
  const r = await driveRefund(exec({ state: "UNCERTAIN", attemptDeclared: true }), rail);
  assert.equal(r.state, "MANUAL_RESOLUTION");
});

test("O27A-INVOICE: DIAN is off — a receipt is never an invoice and every missing prerequisite is named", () => {
  const receipt = { appliedServiceCents: 100_000n, appliedTaxCents: 15_000n, excessCents: 5_000n, currency: "USD" as const };
  const ready = { rutRegistered: true, issuerQualified: true, numberingAuthorized: true, dianVerificationRecorded: true };
  assert.deepEqual(decideInvoice(receipt, ready), { kind: "RECEIPT_ONLY", blockers: ["DIAN_NOT_ACTIVE"], receiptIsInvoice: false });
  const nothing = { rutRegistered: false, issuerQualified: false, numberingAuthorized: false, dianVerificationRecorded: false };
  assert.deepEqual(decideInvoice(receipt, nothing).kind === "RECEIPT_ONLY" && (decideInvoice(receipt, nothing) as unknown as { blockers: string[] }).blockers, [
    "DIAN_NOT_ACTIVE",
    "RUT_NOT_REGISTERED",
    "ISSUER_NOT_QUALIFIED",
    "NUMBERING_NOT_AUTHORIZED",
    "DIAN_VERIFICATION_MISSING",
  ]);
  // with every prerequisite and the activation (tests only): the applied service and tax, never the excess
  assert.deepEqual(decideInvoice(receipt, ready, { ...O27A_ACTIVATION, dianIssuance: true }), { kind: "ISSUE_ELECTRONIC_INVOICE", currency: "USD", serviceCents: 100_000n, taxCents: 15_000n, totalCents: 115_000n });
  assert.equal(decideInvoice({ ...receipt, appliedServiceCents: 0n, appliedTaxCents: 0n }, ready, { ...O27A_ACTIVATION, dianIssuance: true }).kind, "RECEIPT_ONLY");
  assert.equal(creditNoteRequired({ serviceCents: 0n, taxCents: 0n, excessCents: 5_000n }, true), false);
  assert.equal(creditNoteRequired({ serviceCents: 1n, taxCents: 0n, excessCents: 0n }, true), true);
  assert.equal(creditNoteRequired({ serviceCents: 1n, taxCents: 0n, excessCents: 0n }, false), false);
});

test("review O27A F-1: two partial credits of one order in one run — the second takes the excess, never more service", async () => {
  const source = new SimulatedAchReceiptSource(ACCOUNT);
  source.script({ ...credit(), sourceRef: "p1", grossCents: 70_000n, evidenceHash: h("p1") });
  source.script({ ...credit(), sourceRef: "p2", grossCents: 70_000n, evidenceHash: h("p2") });
  const run = await reconcileSource(source, { known: new Map(), orderFor: () => order({ receivedCents: 0n }) });
  const applied = run.outcomes.filter((o) => o.kind === "APPLIED");
  assert.equal(applied.length, 2);
  const total = applied.reduce((acc, o) => acc + (o.kind === "APPLIED" ? o.appliedServiceCents + o.appliedTaxCents : 0n), 0n);
  const due = order({ receivedCents: 0n }).serviceCents + order({ receivedCents: 0n }).taxCents;
  assert.equal(total, due, "service and tax applied exactly once across the run");
  assert.equal(applied[1]?.kind === "APPLIED" && applied[1].coverage, "EXCESS");
  assert.equal(accountBalances(run.postings).get("CUSTOMER_OVERPAYMENT"), -(140_000n - due), "the rest is owed back");
  assert.ok(isBalanced(run.postings));
  // a caller that stops the run (it could not record) gets no later outcome
  const stopper = new SimulatedAchReceiptSource(ACCOUNT);
  stopper.script({ ...credit(), sourceRef: "s1", grossCents: 1_000n, evidenceHash: h("s1") });
  stopper.script({ ...credit(), sourceRef: "s2", grossCents: 1_000n, evidenceHash: h("s2") });
  const stopped = await reconcileSource(stopper, { known: new Map(), orderFor: () => order({ receivedCents: 0n }), onOutcome: async () => false });
  assert.deepEqual([stopped.stopped, stopped.outcomes.length], [true, 1]);
});
