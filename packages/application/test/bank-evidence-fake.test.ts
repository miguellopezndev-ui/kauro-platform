// Payments V1, lane KIT: the CONTRACT_FAKE of the bank evidence port (docs/design/ACH-ROUTE.md D-ACH-15, §6.1) behaves as the port contract
// says, because the lanes' cells will stand on it: pure and fail-closed classifiers, nulls that are never inferred, a read/classify-only
// port, scripted reads with request-bound refusals, and a content-addressed immutable store. These prove the FAKE and the contract's
// shape; the shared contract suite that also runs against the real adapter is S-B's (packages/application/test/bank-evidence-port.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import {
  BANK_FAKE_NORMALIZER,
  CONTRACT_FAKE,
  FAKE_EVIDENCE_CLASS,
  createBankEvidenceFake,
  fakeCreditBytes,
  fakeOutboundBytes,
  fakeStatementBytes,
  sha256Hex,
  type BankEvidenceFake,
  type FakeCreditFields,
} from "../src/commerce/testing/index.js";
import type { StoredBankEvidence } from "../src/commerce/ports.js";

const ACCOUNT = "acct-fake-1" as never;
const PAYEE = "c".repeat(64);
const T0 = Date.parse("2026-10-07T12:00:00.000Z");
let now = T0;
const clock: Clock = { now: () => toUtcInstant(now), nowMs: () => now };
const fake = (): BankEvidenceFake => createBankEvidenceFake({ clock, environment: "SANDBOX", accountRef: ACCOUNT, payeeDigest: PAYEE });

const credit = (o: Partial<FakeCreditFields> = {}): FakeCreditFields => ({ creditId: "credit-1", currency: "USD", payeeDigest: PAYEE, observedAt: "2026-10-07T11:00:00.000Z", ...o });

async function stored(f: BankEvidenceFake, bytes: Uint8Array): Promise<StoredBankEvidence> {
  const { artifactRef } = await f.put({ bytes });
  return (await f.get(artifactRef))!;
}

test("the fake is labelled CONTRACT_FAKE / SIMULATED, names no provider, and its port has no outbound method (D-ACH-20)", () => {
  const f = fake();
  assert.equal(f.integrationClass, CONTRACT_FAKE);
  assert.equal(f.evidenceClass, FAKE_EVIDENCE_CLASS);
  assert.doesNotMatch(f.provider, /wise|paypal/i);
  for (const outbound of ["createTransfer", "fundTransfer", "cancelTransfer", "resend", "dispatch", "prepareRefund"]) assert.equal((f as unknown as Record<string, unknown>)[outbound], undefined, outbound);
});

test("a credit artifact classifies into exactly what its bytes show: absent fields are null, an unknown fee is not zero, an observed zero is zero, and no digest is inferred", async () => {
  const f = fake();
  const sparse = f.classifyCredit(await stored(f, fakeCreditBytes(ACCOUNT, credit())));
  assert.equal(sparse.kind, "CLASSIFIED");
  if (sparse.kind !== "CLASSIFIED") return;
  assert.deepEqual([sparse.value.grossCents, sparse.value.netCents, sparse.value.feeCents, sparse.value.reference, sparse.value.payerDigest, sparse.value.bookedAt, sparse.value.reversedCents], [null, null, null, null, null, null, null]);
  assert.equal(sparse.value.status, "UNRECOGNIZED", "a status the bytes do not state is never coerced to success");
  assert.equal(sparse.value.rail, "UNKNOWN");
  const zero = f.classifyCredit(await stored(f, fakeCreditBytes(ACCOUNT, credit({ grossCents: 10000n, feeCents: 0n, netCents: 10000n, status: "COMPLETED", rail: "ACH", reference: "K1234", bookedAt: "2026-10-07T10:00:00.000Z" }))));
  assert.equal(zero.kind, "CLASSIFIED");
  if (zero.kind !== "CLASSIFIED") return;
  assert.deepEqual([zero.value.grossCents, zero.value.feeCents, zero.value.netCents, zero.value.status, zero.value.rail, zero.value.reference, zero.value.environment], [10000n, 0n, 10000n, "COMPLETED", "ACH", "K1234", "SANDBOX"]);
  assert.equal(zero.value.evidenceHash, sha256Hex(fakeCreditBytes(ACCOUNT, credit({ grossCents: 10000n, feeCents: 0n, netCents: 10000n, status: "COMPLETED", rail: "ACH", reference: "K1234", bookedAt: "2026-10-07T10:00:00.000Z" }))));
  const unknownRail = f.classifyCredit(await stored(f, fakeCreditBytes(ACCOUNT, credit({ rail: "SWIFT" }))));
  assert.deepEqual(unknownRail.kind === "CLASSIFIED" ? unknownRail.value.rail : null, "UNKNOWN");
});

test("DENY classification fails closed: unauthenticated, hash mismatch, unknown normalizer or format or kind, malformed or missing fields, a gross - fee != net conflict, another account", async () => {
  const f = fake();
  const good = fakeCreditBytes(ACCOUNT, credit({ grossCents: 100n, feeCents: 1n, netCents: 99n }));
  const code = (e: StoredBankEvidence): string => {
    const c = f.classifyCredit(e);
    return c.kind === "CLASSIFIED" ? "CLASSIFIED" : c.code;
  };
  const base = await stored(f, good);
  assert.equal(code(base), "CLASSIFIED");
  assert.equal(code({ ...base, authenticatedBy: "WEBHOOK_SIGNATURE" }), "UNAUTHENTICATED_EVIDENCE");
  assert.equal(code({ ...base, normalizerVersion: "contract-fake-bank-v0" }), "UNKNOWN_EVIDENCE");
  // bytes that no longer match their envelope digest
  assert.equal(code({ ...base, bytes: new TextEncoder().encode("{}") }), "HASH_MISMATCH");
  const reseal = async (text: string, override: Partial<StoredBankEvidence> = {}): Promise<StoredBankEvidence> => ({ ...(await stored(f, new TextEncoder().encode(text))), ...override });
  assert.equal(code(await reseal("not json")), "MALFORMED_EVIDENCE");
  assert.equal(code(await reseal("[1,2]")), "MALFORMED_EVIDENCE");
  assert.equal(code(await reseal(JSON.stringify({ format: "someone-elses/9", kind: "CREDIT", accountRef: ACCOUNT }))), "UNKNOWN_EVIDENCE");
  const outbound = await stored(f, fakeOutboundBytes(ACCOUNT, { bankExecutionId: "exec-1", amountCents: 5n, currency: "USD", observedAt: "2026-10-07T11:00:00.000Z" }));
  assert.equal(code(outbound), "UNKNOWN_EVIDENCE", "an outbound artifact is not a credit");
  assert.equal(code(await stored(f, fakeCreditBytes(ACCOUNT, credit({ grossCents: 100n, feeCents: 1n, netCents: 98n })))), "MALFORMED_EVIDENCE", "gross - fee != net is never repaired");
  assert.equal(code(await stored(f, fakeCreditBytes("acct-other" as never, credit()))), "MALFORMED_EVIDENCE", "an artifact of another account is not this account's");
  assert.equal(code(await reseal(JSON.stringify({ format: "contract-fake-bank-evidence/1", kind: "CREDIT", accountRef: ACCOUNT, credit: { creditId: "c" } }))), "MALFORMED_EVIDENCE", "a missing required field");
  assert.equal(code({ ...base, normalizerVersion: BANK_FAKE_NORMALIZER, authenticatedBy: "VERIFIED_BANK_ARTIFACT" }), "CLASSIFIED");
});

test("an outbound artifact keeps destination fields as shown: nulls stay null, last four alone proves nothing here and the full destination is carried only in its restricted field", async () => {
  const f = fake();
  const bare = f.classifyOutbound(await stored(f, fakeOutboundBytes(ACCOUNT, { bankExecutionId: "exec-1", amountCents: 500n, currency: "USD", observedAt: "2026-10-07T11:00:00.000Z" })));
  assert.equal(bare.kind, "CLASSIFIED");
  if (bare.kind !== "CLASSIFIED") return;
  assert.deepEqual(bare.value.destination, { accountDigest: null, accountLast4: null, routingDigest: null, full: null, recipientRef: null, recipientVersion: null });
  assert.deepEqual([bare.value.reference, bare.value.executedAt, bare.value.feeCents, bare.value.returnedCents], [null, null, null, null]);
  const full = f.classifyOutbound(
    await stored(f, fakeOutboundBytes(ACCOUNT, { bankExecutionId: "exec-2", amountCents: 500n, currency: "USD", executedAt: "2026-10-07T11:30:00.000Z", reference: "kauro-refund-x-1", status: "SENT", destination: { accountLast4: "6789", full: { routingNumber: "021000021", accountNumber: "123456789", holderName: "Alice Smith" }, recipientRef: "r-1", recipientVersion: "v3" }, observedAt: "2026-10-07T11:31:00.000Z" })),
  );
  assert.equal(full.kind, "CLASSIFIED");
  if (full.kind !== "CLASSIFIED") return;
  assert.equal(full.value.destination.accountLast4, "6789");
  assert.equal(full.value.destination.accountDigest, null, "no digest is derived from a full number");
  assert.deepEqual(full.value.destination.full, { routingNumber: "021000021", accountNumber: "123456789", holderName: "Alice Smith" });
  assert.deepEqual([full.value.status, full.value.executedAt, full.value.reference], ["SENT", "2026-10-07T11:30:00.000Z", "kauro-refund-x-1"]);
  // a destination whose last four is not four digits is malformed, not repaired
  const bad = f.classifyOutbound(await stored(f, fakeOutboundBytes(ACCOUNT, { bankExecutionId: "exec-3", amountCents: 5n, currency: "USD", destination: { accountLast4: "12ab" }, observedAt: "2026-10-07T11:00:00.000Z" })));
  assert.deepEqual(bad, { kind: "REJECTED", code: "MALFORMED_EVIDENCE" });
});

test("a statement artifact classifies its credits and a debit with a null execution id (an unrecorded debit by definition) and an oversized amount unchanged", async () => {
  const f = fake();
  const s = f.classifyStatement(
    await stored(
      f,
      fakeStatementBytes(ACCOUNT, {
        coverageStart: "2026-10-01T00:00:00.000Z",
        coverageEnd: "2026-10-02T00:00:00.000Z",
        credits: [credit({ grossCents: 100n, status: "COMPLETED" })],
        debits: [
          { debitId: "d-1", amountCents: 70000n, currency: "USD", observedAt: "2026-10-02T00:00:00.000Z" },
          { debitId: "d-2", bankExecutionId: "exec-9", amountCents: 100n, currency: "EUR", status: "RETURNED", returnedCents: 100n, observedAt: "2026-10-02T00:00:00.000Z" },
        ],
      }),
    ),
  );
  assert.equal(s.kind, "CLASSIFIED");
  if (s.kind !== "CLASSIFIED") return;
  assert.deepEqual([s.value.credits.length, s.value.debits.length, s.value.coverageStart, s.value.coverageEnd], [1, 2, "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]);
  assert.deepEqual([s.value.debits[0]!.bankExecutionId, s.value.debits[0]!.amountCents, s.value.debits[0]!.status], [null, 70000n, "UNRECOGNIZED"]);
  assert.deepEqual([s.value.debits[1]!.currency, s.value.debits[1]!.status, s.value.debits[1]!.returnedCents], ["EUR", "RETURNED", 100n]);
});

test("the store is content-addressed and immutable: the same bytes answer the same reference, get returns a frozen copy, corrupt makes the next read fail its digest", async () => {
  const f = fake();
  const bytes = fakeCreditBytes(ACCOUNT, credit());
  const a = await f.put({ bytes });
  const b = await f.put({ bytes });
  assert.deepEqual(a, b);
  assert.equal(a.sha256, sha256Hex(bytes));
  const got = (await f.get(a.artifactRef))!;
  assert.equal(Object.isFrozen(got), true);
  assert.equal(await f.get("00000000-0000-8000-8000-000000000000"), null);
  assert.deepEqual([got.provider, got.accountRef, got.integrationClass, got.authenticatedBy], [f.provider, ACCOUNT, CONTRACT_FAKE, "VERIFIED_BANK_ARTIFACT"]);
  f.corrupt(a.artifactRef, new TextEncoder().encode("tampered"));
  const again = (await f.get(a.artifactRef))!;
  assert.equal(again.sha256, a.sha256, "the envelope digest is unchanged");
  assert.deepEqual(f.classifyCredit(again), { kind: "REJECTED", code: "HASH_MISMATCH" });
});

test("reads: quiet defaults (empty complete page, PENDING lookup never PROVED_NO_EFFECT), request-bound REFUSED, scripted answers in order, foreign cursors refused, a deadline already passed is not sent", async () => {
  const f = fake();
  const deadline = toUtcInstant(now + 60_000);
  const page = await f.listIncomingCredits({ accountRef: ACCOUNT, since: null, limit: 10, deadline });
  assert.equal(page.kind, "COMPLETED");
  if (page.kind !== "COMPLETED") return;
  assert.deepEqual([page.value.credits.length, page.value.complete], [0, true]);
  const missing = await f.getCreditById({ accountRef: ACCOUNT, creditId: "nope" as never, deadline });
  assert.equal(missing.kind, "PENDING");
  // a cursor bound to this account, environment and normalizer is accepted; another account's is REFUSED VALIDATION_REJECTED (never a silent restart)
  const next = await f.listIncomingCredits({ accountRef: ACCOUNT, since: page.value.nextCursor, limit: 10, deadline });
  assert.equal(next.kind, "COMPLETED");
  const foreign = await f.listIncomingCredits({ accountRef: ACCOUNT, since: "acct-other|SANDBOX|contract-fake-bank-v1|0", limit: 10, deadline });
  assert.equal(foreign.kind, "REFUSED");
  // the refusal is bound to the refused request: a different request has a different hash
  const foreign2 = await f.listIncomingCredits({ accountRef: ACCOUNT, since: "acct-other|SANDBOX|contract-fake-bank-v1|1", limit: 10, deadline });
  if (foreign.kind === "REFUSED" && foreign2.kind === "REFUSED") assert.notEqual(foreign.operational.requestHash, foreign2.operational.requestHash);
  // scripted answers are consumed in order; SCA_REQUIRED on a statement read refuses with the code and the request hash
  f.script("listStatementDebits", { kind: "REFUSED", operational: { code: "SCA_REQUIRED" } });
  f.script("listStatementDebits", { kind: "AMBIGUOUS", reason: "CONNECTION_RESET" });
  const first = await f.listStatementDebits({ accountRef: ACCOUNT, since: null, limit: 5, deadline });
  assert.deepEqual(first.kind === "REFUSED" ? first.operational.code : first.kind, "SCA_REQUIRED");
  assert.deepEqual(await f.listStatementDebits({ accountRef: ACCOUNT, since: null, limit: 5, deadline }), { kind: "AMBIGUOUS", reason: "CONNECTION_RESET" });
  assert.equal((await f.listStatementDebits({ accountRef: ACCOUNT, since: null, limit: 5, deadline })).kind, "COMPLETED");
  // a deadline that has passed: not sent, AMBIGUOUS TIMEOUT, logged sent: false
  const late = await f.getAccountDetails(ACCOUNT, toUtcInstant(now - 1));
  assert.deepEqual(late, { kind: "AMBIGUOUS", reason: "TIMEOUT" });
  assert.equal(f.calls.filter((c) => !c.sent).length, 1);
  const details = await f.getAccountDetails(ACCOUNT, deadline);
  assert.equal(details.kind, "COMPLETED");
  assert.equal(details.kind === "COMPLETED" ? details.value.currency : null, "USD");
});
