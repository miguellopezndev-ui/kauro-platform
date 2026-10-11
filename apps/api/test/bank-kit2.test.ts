// Payments V1, lane KIT-2: the seams the red-first lanes (L-INBOUND, L-REFUND) stand on work as they will use them (S1..S7, IN1, the
// sessions-enabled bankWorld). These cells prove the harness and nothing of the lanes' behaviour: a purchase is paid by one exact credit
// through the REAL route commands, an unassigned credit and its treasury refund exist, the fingerprinter is keyed and versioned, a
// reversal needs its consumer, the route timings are the route version's columns, a superseded FINANCE worker is FENCED, and the
// commission world pays a purchase by bank transfer with the same cents as the provider rail.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { bankWorld, type BankWorld } from "./bank-support.js";
import { agentOf, bought, integrationWorld } from "./integration-support.js";
import { commissionWorld, oracleRows, purchase, sellingAgency } from "./commission-support.js";

let bw: BankWorld;
before(async () => {
  bw = await bankWorld({ world: await integrationWorld({ bankEvidence: true }) });
});
after(async () => {
  await bw?.stop();
  await bw?.iw.stop();
});

const q = <T extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> => bw.iw.h.oracle.query<T>(sql, [...params]).then((r) => r.rows);

test("OK S3 integrationWorld({ bankEvidence }) binds one CONTRACT_FAKE store to the api and carries the keyed test fingerprinter", async () => {
  const be = bw.iw.bankEvidence;
  assert.ok(be !== undefined);
  assert.equal(bw.evidence, be.evidence, "bankWorld reuses the world's store: one store per world");
  assert.equal(bw.iw.w.bank.evidence, be.evidence, "the api reads the bytes the cells store");
  assert.deepEqual(be.fingerprinter.current(), { keyId: "test-key", keyVersion: 1, normVersion: "destination-norm-v1" });
  const dest = { routingNumber: "021000021", accountNumber: "12341234", holderName: "Alice Smith" };
  const a = await be.fingerprinter.fingerprint(dest, be.fingerprinter.current());
  assert.deepEqual([a.keyId, a.keyVersion, a.normVersion], ["test-key", 1, "destination-norm-v1"]);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await be.fingerprinter.fingerprint(dest, be.fingerprinter.current())).fingerprint, a.fingerprint, "deterministic");
  assert.notEqual((await be.fingerprinter.fingerprint({ ...dest, accountNumber: "12341235" }, be.fingerprinter.current())).fingerprint, a.fingerprint, "another destination, another value");
  assert.notEqual((await be.fingerprinter.fingerprint(dest, { ...be.fingerprinter.current(), keyVersion: 2 })).fingerprint, a.fingerprint, "a rotated key yields another value");
  const collisionA = await be.fingerprinter.fingerprint({ routingNumber: "021000021", accountNumber: "12341234", holderName: "1234M" }, be.fingerprinter.current());
  const collisionB = await be.fingerprinter.fingerprint({ routingNumber: "021000021", accountNumber: "123412341234", holderName: "M" }, be.fingerprinter.current());
  assert.notEqual(collisionA.fingerprint, collisionB.fingerprint, "the concatenation-collision twins are other destinations (DV1-11)");
  const plain = await integrationWorld();
  try {
    assert.equal(plain.bankEvidence, undefined, "absent by default");
  } finally {
    await plain.stop();
  }
});

test("OK S1 paidByBankTransfer: the order was issued by CMD028 on a BANK_TRANSFER route and its capture COMPLETED from one applied exact credit", async () => {
  const a = await agentOf(bw.iw, "kit2-s1");
  const p = await bw.paidByBankTransfer(a, "kit2-s1");
  const [order] = await q<{ state: string; route_kind: string }>(
    "SELECT o.state, (SELECT 'BANK_TRANSFER' FROM kauro.bank_routes r WHERE r.payment_route_id = o.route_id) AS route_kind FROM kauro.payment_orders o WHERE o.order_id = $1",
    [p.orderId],
  );
  assert.deepEqual(order, { state: "CAPTURED", route_kind: "BANK_TRANSFER" });
  assert.deepEqual(await q("SELECT order_state FROM kauro.bank_transfer_instructions WHERE order_id = $1", [p.orderId]), [{ order_state: "CAPTURED" }]);
  assert.deepEqual(await q("SELECT status, amount_cents::text FROM kauro.capture_facts WHERE capture_id = $1", [p.captureId]), [{ status: "COMPLETED", amount_cents: p.totalCents.toString() }]);
  assert.deepEqual(await q("SELECT state, gross_cents::text, order_id::text, capture_id::text FROM kauro.bank_credits WHERE capture_id = $1", [p.captureId]), [{ state: "APPLIED", gross_cents: p.totalCents.toString(), order_id: p.orderId, capture_id: p.captureId }]);
  assert.deepEqual(await q("SELECT state FROM kauro.commercial_authorizations WHERE authorization_id = $1", [p.authorizationId]), [{ state: "ACTIVE" }]);
  // a second agency joins the same route
  const b = await agentOf(bw.iw, "kit2-s1b");
  const p2 = await bw.paidByBankTransfer(b, "kit2-s1b");
  assert.notEqual(p2.captureId, p.captureId);
  assert.equal((await q("SELECT 1 FROM kauro.bank_routes WHERE account_ref = $1", [bw.accountRef])).length, 1, "one lane route");
});

test("OK S2 unassignedCredit: a RETURN_REVIEW credit with a REQUESTED treasury refund of its whole gross, in route scope", async () => {
  const c = await bw.unassignedCredit(25_000n, "kit2-s2");
  assert.deepEqual(await q("SELECT state, gross_cents::text, order_id, capture_id FROM kauro.bank_credits WHERE bank_credit_id = $1", [c.bankCreditId]), [{ state: "RETURN_REVIEW", gross_cents: "25000", order_id: null, capture_id: null }]);
  assert.deepEqual(await q("SELECT state, version::text, amount_cents::text, bank_credit_id::text FROM kauro.treasury_refunds WHERE treasury_refund_id = $1", [c.treasuryRefundId]), [{ state: "REQUESTED", version: "1", amount_cents: "25000", bank_credit_id: c.bankCreditId }]);
  const other = await bw.unassignedCredit(100n, "kit2-s2b");
  assert.notEqual(other.bankCreditId, c.bankCreditId);
});

test("OK S4 storeRecipientRecord stores a RECIPIENT artifact whose hash is the digest of the stored bytes", async () => {
  const stored = await bw.storeRecipientRecord({ recipientRef: "recipient-kit2", recipientVersion: "v1", full: { routingNumber: "021000021", accountNumber: "123412341234", holderName: "M" } });
  const envelope = await bw.evidence.get(stored.artifactRef);
  assert.ok(envelope);
  assert.equal(envelope.sha256, stored.evidenceHash);
  assert.equal(createHash("sha256").update(envelope.bytes).digest("hex"), stored.evidenceHash);
  assert.equal(JSON.parse(new TextDecoder().decode(envelope.bytes)).kind, "RECIPIENT");
});

test("OK S5 reverseCredit stores the reversal version and hands it to the bound inbound consumer; unbound it refuses loudly", async () => {
  const c = await bw.unassignedCredit(7_000n, "kit2-s5");
  await assert.rejects(() => bw.reverseCredit(c.bankCreditId, 7_000n), /SEAM S5 not bound/);
  const seen: unknown[] = [];
  bw.fixtures.creditVersionConsumer = async (v) => void seen.push(v);
  try {
    await bw.reverseCredit(c.bankCreditId, 7_000n);
    assert.equal(seen.length, 1);
    const v = seen[0] as { kind: string; reversedCents: bigint; bankCreditId: string; artifactRef: string };
    assert.deepEqual([v.kind, v.reversedCents, v.bankCreditId], ["REVERSAL", 7_000n, c.bankCreditId]);
    const classified = bw.evidence.classifyCredit((await bw.evidence.get(v.artifactRef))!);
    assert.equal(classified.kind === "CLASSIFIED" ? classified.value.status : null, "REVERSED");
    // by the capture it paid
    const a = await agentOf(bw.iw, "kit2-s5b");
    const p = await bw.paidByBankTransfer(a, "kit2-s5b");
    await bw.reverseCredit(p.captureId, p.totalCents);
    assert.equal(seen.length, 2);
  } finally {
    bw.fixtures.creditVersionConsumer = undefined;
  }
});

test("OK S6 routeTiming is the route version in force", async () => {
  await bw.unassignedCredit(1n, "kit2-s6");
  const t = bw.routeTiming();
  assert.ok(t.manualExecutionWindowMs > 0 && t.coverageLagMs >= 0);
  const rows = await q<{ w: string; l: string }>(
    "SELECT v.manual_execution_window_ms::text AS w, v.coverage_lag_ms::text AS l FROM kauro.bank_route_versions v JOIN kauro.bank_routes r ON r.route_id = v.route_id AND r.current_version = v.route_version WHERE r.account_ref = $1",
    [bw.accountRef],
  );
  assert.deepEqual(rows, [{ w: String(t.manualExecutionWindowMs), l: String(t.coverageLagMs) }]);
});

test("OK S7 staleFinanceWorker: a FINANCE worker superseded at the lease is driven by the dispatcher itself and reports FENCED", async () => {
  const stale = await bw.staleFinanceWorker();
  assert.equal(stale.currentFence, stale.staleFence + 1);
  const a = await agentOf(bw.iw, "kit2-s7");
  await bought(bw.iw, a, "kit2-s7");
  const pass = await stale.dispatcher.runOnce("FINANCE", { limit: 100 });
  assert.equal(pass.held, false, "the stale worker believes it holds the lease");
  assert.ok(pass.deliveries.length > 0, "a FINANCE delivery was due");
  assert.deepEqual([...new Set(pass.deliveries.map((d) => d.outcome))], ["FENCED"], "every settlement of the stale worker is fenced");
});

test("OK the sessions-enabled bankWorld serves the browser session boundary (route I3)", async () => {
  const sessions = await bankWorld({ sessions: true });
  try {
    const session = await sessions.iw.w.identity().signIn(sessions.iw.owner);
    assert.ok(session.cookie.length > 0, "a cookie session exists on the bank world");
  } finally {
    await sessions.stop();
  }
});

// --- IN1: the commission world's bank rail ---------------------------------------------------------------------------------------------

test("OK IN1 commissionWorld({ bankEvidence }) pays a purchase by bank transfer with the provider rail's cents", async () => {
  const cw = await commissionWorld({ bankEvidence: true });
  try {
    assert.ok(cw.bank !== undefined);
    const sp = await sellingAgency(cw, "kit2-in1-provider");
    const sb = await sellingAgency(cw, "kit2-in1-bank");
    const provider = await purchase(cw, sp, "kit2-in1-provider");
    const bank = await cw.bank.purchase(sb, "kit2-in1-bank");
    assert.deepEqual([bank.serviceCents, bank.taxCents, bank.totalCents], [provider.serviceCents, provider.taxCents, provider.totalCents], "the same cents on both rails");
    assert.deepEqual(await oracleRows(cw, "SELECT status FROM kauro.capture_facts WHERE capture_id = $1", [bank.captureId]), [{ status: "COMPLETED" }]);
    assert.deepEqual(await oracleRows(cw, "SELECT state FROM kauro.bank_credits WHERE capture_id = $1", [bank.captureId]), [{ state: "APPLIED" }]);
    await assert.rejects(() => cw.bank!.funds(bank, "HELD"), /SEAM IN1 not bound/);
  } finally {
    await cw.stop();
  }
});
