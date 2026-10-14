// Payments V1, lane PV1-SETTLE slice 1 (docs/design/PV1-SETTLE.md; ACH-ROUTE r7 §7.25 ST1; R2-085): the settlement evidence is
// classified purely and fail-closed from hash-verified stored bytes, read under the provider-call bound, checked for consistency
// before any write, and a settlement observation posts exactly the release, the withdrawal's fee and the bank receipt — bank cash
// only from a receipt (D-LEDGER-B5). The SET-M cells that drive the owner command run in apps/api/test/settlement-cells.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "@kauro/domain";
import { DomainFailure, settlementPostings, toUtcInstant } from "@kauro/domain";
import { readSettlementEvidence, type SettlementEvidenceCollaborators } from "../src/commerce/bank/index.js";
import {
  createBankEvidenceFake,
  fakeBankReceiptBytes,
  fakeSettlementBytes,
  type BankEvidenceFake,
  type FakeBankReceiptFields,
  type FakeSettlementFields,
} from "../src/commerce/testing/index.js";
import type { StoredBankEvidence } from "../src/commerce/ports.js";

const ACCOUNT = "acct-settle-1" as never;
const PAYEE = "c".repeat(64);
const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const clock: Clock = { now: () => toUtcInstant(T0), nowMs: () => T0 };
const fake = (): BankEvidenceFake => createBankEvidenceFake({ clock, environment: "SANDBOX", accountRef: ACCOUNT, payeeDigest: PAYEE });
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const settlement = (o: Partial<FakeSettlementFields> = {}): FakeSettlementFields => ({
  currency: "USD",
  periodStart: "2026-10-12T00:00:00.000Z",
  periodEnd: "2026-10-13T00:00:00.000Z",
  withdrawalId: "wd-1",
  grossCents: 50_000n,
  feeCents: 150n,
  heldCents: 2_000n,
  withdrawnCents: 40_000n,
  observedAt: "2026-10-13T01:00:00.000Z",
  ...o,
});
const receipt = (o: Partial<FakeBankReceiptFields> = {}): FakeBankReceiptFields => ({
  receivingAccountRef: "bank-acct-co-1",
  withdrawalId: "wd-1",
  bankTransactionId: "btx-co-1",
  currency: "USD",
  receivedCents: 40_000n,
  bankAvailableCents: 125_000n,
  bookedAt: "2026-10-13T02:00:00.000Z",
  observedAt: "2026-10-13T03:00:00.000Z",
  ...o,
});

async function stored(f: BankEvidenceFake, bytes: Uint8Array, extra: { readonly authenticatedBy?: StoredBankEvidence["authenticatedBy"]; readonly accountRef?: never } = {}): Promise<{ readonly artifactRef: string; readonly evidenceHash: string; readonly evidence: StoredBankEvidence }> {
  const { artifactRef, sha256 } = await f.put({ bytes, ...extra });
  return { artifactRef, evidenceHash: sha256, evidence: (await f.get(artifactRef))! };
}

/** The ST1 collaborators: the fake's store and classifiers, a timer that fires only when a test asks it to. */
function collaborators(f: BankEvidenceFake, timer: { fire?: () => void } = {}): SettlementEvidenceCollaborators {
  return {
    evidence: () => f,
    settlementClassifier: () => f,
    timer: {
      start: () => {
        let cancel = (): void => undefined;
        const elapsed = new Promise<void>((resolve) => {
          timer.fire = resolve;
          cancel = () => undefined;
        });
        return { elapsed, cancel: () => cancel() };
      },
    },
  };
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    assert.ok(e instanceof DomainFailure, String(e));
    return `${e.code} ${String((e.details as { reason?: string } | undefined)?.reason)}`;
  }
};

test("settlementPostings: the release and the withdrawal fee leave PSP_AVAILABLE, only a receipt makes BANK_CASH, every set balances", () => {
  const sum = (ls: ReadonlyArray<{ direction: string; amountCents: bigint }>, d: string): bigint => ls.filter((l) => l.direction === d).reduce((a, l) => a + l.amountCents, 0n);
  const withReceipt = settlementPostings(40_000n, 150n, 40_000n);
  assert.deepEqual(withReceipt.map((l) => [l.account, l.direction, l.amountCents]), [
    ["BANK_IN_TRANSIT", "DEBIT", 40_000n],
    ["PSP_AVAILABLE", "CREDIT", 40_000n],
    ["PROCESSOR_EXPENSE", "DEBIT", 150n],
    ["PSP_AVAILABLE", "CREDIT", 150n],
    ["BANK_CASH", "DEBIT", 40_000n],
    ["BANK_IN_TRANSIT", "CREDIT", 40_000n],
  ]);
  assert.equal(sum(withReceipt, "DEBIT"), sum(withReceipt, "CREDIT"));
  // R2-085: withdrawal submitted, bank not yet credited — in transit, no bank cash, no zero lines
  const inTransit = settlementPostings(40_000n, 0n, 0n);
  assert.deepEqual(inTransit.map((l) => [l.account, l.direction, l.amountCents]), [
    ["BANK_IN_TRANSIT", "DEBIT", 40_000n],
    ["PSP_AVAILABLE", "CREDIT", 40_000n],
  ]);
  assert.ok(!inTransit.some((l) => l.account === "BANK_CASH"));
  assert.throws(() => settlementPostings(40_000n, 0n, 40_001n), RangeError, "a receipt beyond the withdrawal is refused");
  assert.throws(() => settlementPostings(0n, 0n, 0n), RangeError, "no settlement without a withdrawal");
  assert.throws(() => settlementPostings(-1n, 0n, 0n));
});

test("ST1 classify: the same digest gives the same result; absent figures, an inverted period, unknown formats, unauthenticated or tampered bytes are REJECTED", async () => {
  const f = fake();
  const s = await stored(f, fakeSettlementBytes(ACCOUNT, settlement()));
  const once = f.classifySettlement(s.evidence);
  assert.deepEqual(f.classifySettlement((await f.get(s.artifactRef))!), once, "same digest, same result");
  assert.equal(once.kind, "CLASSIFIED");
  if (once.kind === "CLASSIFIED") {
    assert.deepEqual(
      [once.value.withdrawalId, once.value.grossCents, once.value.feeCents, once.value.heldCents, once.value.withdrawnCents, once.value.evidenceHash],
      ["wd-1", 50_000n, 150n, 2_000n, 40_000n, s.evidenceHash],
    );
  }
  const r = await stored(f, fakeBankReceiptBytes(ACCOUNT, receipt()));
  const classified = f.classifyBankReceipt(r.evidence);
  assert.equal(classified.kind, "CLASSIFIED");
  if (classified.kind === "CLASSIFIED") assert.deepEqual([classified.value.accountRef, classified.value.bankTransactionId, classified.value.receivedCents, classified.value.bankAvailableCents], ["bank-acct-co-1", "btx-co-1", 40_000n, 125_000n]);
  const rejected = async (bytes: Uint8Array, extra: { readonly authenticatedBy?: StoredBankEvidence["authenticatedBy"] } = {}, as: "SETTLEMENT" | "RECEIPT" = "SETTLEMENT"): Promise<string> => {
    const e = (await stored(f, bytes, extra)).evidence;
    const c = as === "SETTLEMENT" ? f.classifySettlement(e) : f.classifyBankReceipt(e);
    return c.kind === "REJECTED" ? c.code : "CLASSIFIED";
  };
  assert.equal(await rejected(fakeSettlementBytes(ACCOUNT, settlement({ withdrawnCents: null }))), "MALFORMED_EVIDENCE", "an absent withdrawal is never zero");
  assert.equal(await rejected(fakeSettlementBytes(ACCOUNT, settlement({ feeCents: null }))), "MALFORMED_EVIDENCE", "an absent fee is never zero");
  assert.equal(await rejected(fakeSettlementBytes(ACCOUNT, settlement({ periodStart: "2026-10-13T00:00:00.000Z", periodEnd: "2026-10-12T00:00:00.000Z" }))), "MALFORMED_EVIDENCE");
  assert.equal(await rejected(fakeBankReceiptBytes(ACCOUNT, receipt({ receivedCents: null })), {}, "RECEIPT"), "MALFORMED_EVIDENCE");
  assert.equal(await rejected(enc(JSON.stringify({ format: "other-bank/9", kind: "SETTLEMENT" }))), "UNKNOWN_EVIDENCE");
  assert.equal(await rejected(fakeBankReceiptBytes(ACCOUNT, receipt())), "UNKNOWN_EVIDENCE", "a receipt is not a settlement record");
  assert.equal(await rejected(enc('{"format":"contract-fake-bank-evidence/1","kind":"SETTLEMENT","settlement":{')), "MALFORMED_EVIDENCE");
  assert.equal(await rejected(fakeSettlementBytes(ACCOUNT, settlement({ withdrawalId: "wd-unauth" })), { authenticatedBy: "OWNER_DECLARED" as never }), "UNAUTHENTICATED_EVIDENCE");
  const tampered = await stored(f, fakeSettlementBytes(ACCOUNT, settlement({ withdrawalId: "wd-tampered" })));
  f.corrupt(tampered.artifactRef, enc("x"));
  const read = f.classifySettlement((await f.get(tampered.artifactRef))!);
  assert.deepEqual(read, { kind: "REJECTED", code: "HASH_MISMATCH" });
});

test("ST1 read: bounded by the provider-call timer (EVIDENCE_UNAVAILABLE), re-verified by hash, of this account only, and consistent before any write", async () => {
  const f = fake();
  const s = await stored(f, fakeSettlementBytes(ACCOUNT, settlement()));
  const r = await stored(f, fakeBankReceiptBytes(ACCOUNT, receipt()));
  const body = (o: { receipt?: { artifactRef: string; evidenceHash: string } | null; artifactRef?: string; evidenceHash?: string } = {}) => ({
    artifactRef: o.artifactRef ?? s.artifactRef,
    evidenceHash: o.evidenceHash ?? s.evidenceHash,
    receipt: o.receipt === undefined ? { artifactRef: r.artifactRef, evidenceHash: r.evidenceHash } : o.receipt,
  });
  const ok = await readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body());
  assert.deepEqual([ok.settlement.withdrawnCents, ok.receipt?.receivedCents, ok.receipt?.bankTransactionId], [40_000n, 40_000n, "btx-co-1"]);
  const transit = await readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ receipt: null }));
  assert.equal(transit.receipt, null, "R2-085: released, not yet received");

  // TIMEOUT: a store read that outlives its bound answers EVIDENCE_UNAVAILABLE (retryable), never a classification
  const timer: { fire?: () => void } = {};
  const slow = collaborators(f, timer);
  const real = f.get.bind(f);
  const hanging = { ...slow, evidence: () => ({ ...f, get: (ref: string) => new Promise<StoredBankEvidence | null>((resolve) => { timer.fire?.(); setTimeout(() => void real(ref).then(resolve), 50); }) }) as never };
  assert.equal(await reasonOf(readSettlementEvidence(hanging, ACCOUNT, "SANDBOX", body())), "CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE");
  assert.equal(await reasonOf(readSettlementEvidence({ ...collaborators(f), settlementClassifier: () => null }, ACCOUNT, "SANDBOX", body())), "CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE");
  assert.equal(await reasonOf(readSettlementEvidence({ ...collaborators(f), evidence: () => null }, ACCOUNT, "SANDBOX", body())), "CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE");

  // identity and integrity
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ evidenceHash: "d".repeat(64) }))), "INTEGRITY_FAILURE HASH_MISMATCH");
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), "acct-other" as never, "SANDBOX", body())), "INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "another account's artifact");
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "LIVE", body())), "INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "another environment's artifact");
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ artifactRef: r.artifactRef, evidenceHash: r.evidenceHash }))), "INTEGRITY_FAILURE UNKNOWN_EVIDENCE", "a receipt cited as the settlement");
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ artifactRef: "01920000-0000-8000-8000-000000000000" }))), "NOT_FOUND EVIDENCE_NOT_FOUND");

  // consistency (D-SET-3), before any write
  const receiptOf = async (o: Partial<FakeBankReceiptFields>) => {
    const x = await stored(f, fakeBankReceiptBytes(ACCOUNT, receipt(o)));
    return { artifactRef: x.artifactRef, evidenceHash: x.evidenceHash };
  };
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ receipt: await receiptOf({ withdrawalId: "wd-other" }) }))), "PRECONDITION_FAILED RECEIPT_MISMATCH");
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ receipt: await receiptOf({ receivedCents: 40_001n }) }))), "PRECONDITION_FAILED SETTLEMENT_INCONSISTENT", "received beyond withdrawn");
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ receipt: await receiptOf({ bankAvailableCents: 39_999n }) }))), "PRECONDITION_FAILED SETTLEMENT_INCONSISTENT", "a balance below the receipt");
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ receipt: await receiptOf({ currency: "COP" }) }))), "PRECONDITION_FAILED CURRENCY_MISMATCH", "V1 has no FX");
  const cop = await stored(f, fakeSettlementBytes(ACCOUNT, settlement({ currency: "COP", withdrawalId: "wd-cop" })));
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ artifactRef: cop.artifactRef, evidenceHash: cop.evidenceHash, receipt: null }))), "PRECONDITION_FAILED CURRENCY_MISMATCH");
  const empty = await stored(f, fakeSettlementBytes(ACCOUNT, settlement({ withdrawnCents: 0n, withdrawalId: "wd-zero" })));
  assert.equal(await reasonOf(readSettlementEvidence(collaborators(f), ACCOUNT, "SANDBOX", body({ artifactRef: empty.artifactRef, evidenceHash: empty.evidenceHash, receipt: null }))), "PRECONDITION_FAILED SETTLEMENT_INCONSISTENT", "no withdrawal released");
});
