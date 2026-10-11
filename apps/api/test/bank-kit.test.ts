// Payments V1, lane KIT: `bankWorld` (test/bank-support.ts) works as the lanes will use it. These cells prove the harness and nothing of the
// lanes' behaviour: stored artifacts classify through the world's port, the hold points really hold the locks of ACH-ROUTE §7.28 (the
// waiter is observed in pg_stat_activity, never slept on), a different account's stream is not blocked, and a released holder lets the
// waiter proceed exactly once.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mustWait } from "@kauro/persistence/testing";
import { BANK_ACCOUNT, BANK_ENVIRONMENT, BANK_HOLD_POINTS, BANK_PAYEE_DIGEST, bankWorld, type BankWorld } from "./bank-support.js";

let bw: BankWorld;
before(async () => {
  bw = await bankWorld();
});
after(async () => {
  await bw.stop();
});

const ctx = { mustWait };
const uid = (n: number): string => `01920000-0000-7000-8000-${(0x4b2700000000 + n).toString(16).padStart(12, "0")}`;

test("OK bankWorld stores an owner artifact and the port classifies exactly the stored bytes (CONTRACT_FAKE, SIMULATED)", async () => {
  const stored = await bw.storeCredit({ creditId: "credit-kit-1", currency: "USD", payeeDigest: BANK_PAYEE_DIGEST, grossCents: 25000n, status: "COMPLETED", rail: "ACH", observedAt: "2026-10-07T11:00:00.000Z" });
  const envelope = await bw.evidence.get(stored.artifactRef);
  assert.ok(envelope);
  assert.equal(envelope.sha256, stored.evidenceHash);
  const classified = bw.evidence.classifyCredit(envelope);
  assert.equal(classified.kind, "CLASSIFIED");
  assert.equal(classified.kind === "CLASSIFIED" ? classified.value.grossCents : null, 25000n);
  assert.equal(bw.evidence.integrationClass, "CONTRACT_FAKE");
  assert.equal(bw.accountRef, BANK_ACCOUNT);
  assert.equal(bw.environment, BANK_ENVIRONMENT);
  assert.ok(Object.values(BANK_HOLD_POINTS).every((p) => p.startsWith("bank:")));
});

test("RACE hold point L1: a holder of the account's outbound stream blocks a second taker (observed waiting), another account's stream and the inbound stream are free, and release lets the waiter through once", async () => {
  const held = await bw.holdOutboundStream();
  try {
    const { waiting } = await bw.mustWaitOn(
      ctx,
      held,
      async (c) => {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(kauro.bank_stream_lock_key($1, $2, 'OUTBOUND'))", [BANK_ENVIRONMENT, BANK_ACCOUNT]);
        await c.query("COMMIT");
        return "through";
      },
      "a second taker of L1 while L1 is held",
    );
    // while the holder holds, an unrelated stream is free
    const other = await bw.iw.h.oracle.query<{ got: boolean }>("SELECT pg_try_advisory_lock(kauro.bank_stream_lock_key($1, 'acct-another', 'OUTBOUND')) AS got", [BANK_ENVIRONMENT]);
    assert.equal(other.rows[0]!.got, true);
    await bw.iw.h.oracle.query("SELECT pg_advisory_unlock(kauro.bank_stream_lock_key($1, 'acct-another', 'OUTBOUND'))", [BANK_ENVIRONMENT]);
    const inbound = await bw.iw.h.oracle.query<{ got: boolean }>("SELECT pg_try_advisory_lock(kauro.bank_stream_lock_key($1, $2, 'INBOUND')) AS got", [BANK_ENVIRONMENT, BANK_ACCOUNT]);
    assert.equal(inbound.rows[0]!.got, true, "the inbound stream is a different lock");
    await bw.iw.h.oracle.query("SELECT pg_advisory_unlock(kauro.bank_stream_lock_key($1, $2, 'INBOUND'))", [BANK_ENVIRONMENT, BANK_ACCOUNT]);
    await held.release();
    const settled = await waiting.pending;
    assert.deepEqual(settled, { status: "fulfilled", value: "through" });
  } finally {
    await held.release();
  }
});

test("RACE hold point L3: a held attempt row blocks a writer of that row (observed waiting) until released; the inbound stream holder is its own lock", async () => {
  const attemptId = uid(1);
  await bw.iw.h.oracle.query(
    `INSERT INTO kauro.outbound_execution_attempts (attempt_id, environment, account_ref, kind, source_kind, bank_credit_id, treasury_refund_id, attempt_number, reference, amount_cents, currency, declared_by,
       destination_fingerprint, fingerprint_key_id, fingerprint_key_version, fingerprint_norm_version)
     VALUES ($1, $2, $3, 'RETURN', 'BANK_CREDIT', $4, $5, 1, $6, 100, 'USD', $7, $8, 'key-1', 1, 'destination-norm-v1')`,
    [attemptId, BANK_ENVIRONMENT, BANK_ACCOUNT, uid(2), uid(3), "kauro-refund-01920000-0000-7000-8000-000000000009-1", uid(4), "d".repeat(64)],
  );
  const held = await bw.holdAttemptRow(attemptId);
  const inbound = await bw.holdInboundStream();
  try {
    assert.equal(held.kind, "L3_ATTEMPT_ROW");
    assert.notEqual(held.pid, inbound.pid);
    const { waiting } = await bw.mustWaitOn(
      ctx,
      held,
      async (c) => {
        const r = await c.query("UPDATE kauro.outbound_execution_attempts SET state = 'UNCERTAIN', version = version + 1 WHERE attempt_id = $1", [attemptId]);
        return r.rowCount;
      },
      "a writer of an attempt row while L3 is held",
    );
    await held.release();
    assert.deepEqual(await waiting.pending, { status: "fulfilled", value: 1 });
    const row = await bw.iw.h.oracle.query<{ state: string; version: string }>("SELECT state, version::text FROM kauro.outbound_execution_attempts WHERE attempt_id = $1", [attemptId]);
    assert.deepEqual(row.rows, [{ state: "UNCERTAIN", version: "2" }]);
  } finally {
    await held.release();
    await inbound.release();
  }
});

test("DENY holding an attempt that does not exist fails and leaves no open transaction behind", async () => {
  await assert.rejects(bw.holdAttemptRow(uid(99)), /no attempt/);
  const open = await bw.iw.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = current_database()");
  assert.equal(open.rows[0]!.n, "0");
});

test("DENY registration seams: one handler per bank event type and one pass per bank sweep, a second registration is refused (two lanes never both act on one delivery)", async () => {
  const { registerBankDeliveryHandler, registerBankSweep, BANK_SWEEP_NAMES } = await import("../src/payments/index.js");
  registerBankDeliveryHandler("outbound.bounced.v1", async () => "NOT_APPLICABLE");
  assert.throws(() => registerBankDeliveryHandler("outbound.bounced.v1", async () => "APPLIED"), /already registered/);
  assert.deepEqual([...BANK_SWEEP_NAMES], ["TRANSFER_EXPIRY", "EXECUTION_WINDOW"]);
  registerBankSweep("EXECUTION_WINDOW", async () => undefined);
  assert.throws(() => registerBankSweep("EXECUTION_WINDOW", async () => undefined), /already registered/);
});
