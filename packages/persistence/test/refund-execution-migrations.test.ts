// Payments V1 lane L-REFUND slice 2 (migration 0080 sections 6-9; docs/design/ACH-ROUTE.md r12 §7.21-§7.22, DV1-08): the outbound execution
// attempt is an aggregate with the platform's guards: only the machine's edges (KA008), the columns of a declaration never change (KA004), what
// a record learns is learned once (KA004), and every version has its event in the same transaction (KA003 at COMMIT). The never-COMPLETED-
// without-evidence guards (KP014) are exercised through the real commands in apps/api (refund-generic-cells, the DB-guard cell), where the
// refund and treasury rows they judge exist with their whole history.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";
import { sqlState } from "./support.js";

let pg: TemporaryPostgres;
let oracle: Client;

before(async () => {
  pg = await startTemporaryPostgres();
  oracle = await pg.connect("postgres");
});
after(async () => {
  await oracle.end();
  await pg.stop();
});

let seq = 0;
const id = (): string => `01920000-0000-7000-8000-${(0x5c2500000000 + ++seq).toString(16).padStart(12, "0")}`;
const SHA = "b".repeat(64);
const REF = (n: number): string => `kauro-refund-01920000-0000-7000-8000-000000000002-${n}`;

/** A DECLARED attempt over a BANK_CREDIT source (route scope; the oracle writes it, its event at version 1 is not required). */
async function declaredAttempt(o: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    attempt_id: id(),
    environment: "SANDBOX",
    account_ref: "acct-refund-1",
    kind: "RETURN",
    source_kind: "BANK_CREDIT",
    bank_credit_id: id(),
    treasury_refund_id: id(),
    attempt_number: 1,
    reference: REF(++seq),
    amount_cents: 10000,
    currency: "USD",
    declared_by: id(),
    destination_fingerprint: SHA,
    fingerprint_key_id: "key-1",
    fingerprint_key_version: 1,
    fingerprint_norm_version: "destination-norm-v1",
    ...o,
  };
  const cols = Object.keys(row);
  await oracle.query(`INSERT INTO kauro.outbound_execution_attempts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => row[k]));
  return row["attempt_id"] as string;
}

async function refusedIn(statement: string, params: ReadonlyArray<unknown>, sqlstate: string, what: string): Promise<void> {
  await oracle.query("BEGIN");
  try {
    await assert.rejects(oracle.query(statement, params as unknown[]), (e: unknown) => {
      assert.equal(sqlState(e), sqlstate, `${what}: ${String(e)}`);
      return true;
    });
  } finally {
    await oracle.query("ROLLBACK");
  }
}

const RECORD = "UPDATE kauro.outbound_execution_attempts SET state = 'RECORDED', bank_execution_id = $2, destination_proof = 'DP_FULL', evidence_hash = $3, recorded_at = now() WHERE attempt_id = $1";

test("RFG-DB-ATTEMPT-EDGES an attempt moves only along the OutboundExecutionAttempt machine (KA008): DECLARED -> RECORDED and UNCERTAIN -> NOT_EXECUTED are admitted; RECORDED -> DECLARED, NOT_EXECUTED -> UNCERTAIN and RECORDED -> UNCERTAIN are refused", async () => {
  const a = await declaredAttempt();
  await oracle.query(RECORD, [a, `exec-edges-${seq}`, SHA]);
  await refusedIn("UPDATE kauro.outbound_execution_attempts SET state = 'DECLARED' WHERE attempt_id = $1", [a], "KA008", "RECORDED -> DECLARED");
  await refusedIn("UPDATE kauro.outbound_execution_attempts SET state = 'UNCERTAIN' WHERE attempt_id = $1", [a], "KA008", "RECORDED -> UNCERTAIN");
  const b = await declaredAttempt();
  await oracle.query("UPDATE kauro.outbound_execution_attempts SET state = 'UNCERTAIN' WHERE attempt_id = $1", [b]);
  await oracle.query("UPDATE kauro.outbound_execution_attempts SET state = 'NOT_EXECUTED' WHERE attempt_id = $1", [b]);
  await refusedIn("UPDATE kauro.outbound_execution_attempts SET state = 'UNCERTAIN' WHERE attempt_id = $1", [b], "KA008", "NOT_EXECUTED -> UNCERTAIN");
  const states = await oracle.query<{ state: string }>("SELECT state FROM kauro.outbound_execution_attempts WHERE attempt_id = ANY($1::uuid[]) ORDER BY attempt_id", [[a, b]]);
  assert.deepEqual(states.rows.map((r) => r.state), ["RECORDED", "NOT_EXECUTED"]);
});

test("RFG-DB-ATTEMPT-IMMUTABLE what a declaration fixed never changes (KA004): the amount, the reference, the destination fingerprint, the source, the declarer and the attempt number", async () => {
  const a = await declaredAttempt();
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["amount_cents", 10001],
    ["reference", REF(9999)],
    ["destination_fingerprint", "c".repeat(64)],
    ["treasury_refund_id", id()],
    ["declared_by", id()],
    ["attempt_number", 2],
    ["declared_at", new Date(Date.now() - 60_000).toISOString()],
  ];
  for (const [column, value] of cases) await refusedIn(`UPDATE kauro.outbound_execution_attempts SET ${column} = $2 WHERE attempt_id = $1`, [a, value], "KA004", `${column} changed`);
});

test("RFG-DB-ATTEMPT-LEARNED-ONCE what a record learns is learned once (KA004): a RECORDED attempt's execution id, proof and evidence hash are never reassigned", async () => {
  const a = await declaredAttempt();
  await oracle.query(RECORD, [a, `exec-once-${seq}`, SHA]);
  await refusedIn("UPDATE kauro.outbound_execution_attempts SET bank_execution_id = $2 WHERE attempt_id = $1", [a, `exec-other-${seq}`], "KA004", "execution id reassigned");
  await refusedIn("UPDATE kauro.outbound_execution_attempts SET destination_proof = 'DP_RECIPIENT' WHERE attempt_id = $1", [a], "KA004", "proof reassigned");
  await refusedIn("UPDATE kauro.outbound_execution_attempts SET evidence_hash = $2 WHERE attempt_id = $1", [a, "d".repeat(64)], "KA004", "evidence hash reassigned");
});

test("RFG-DB-ATTEMPT-EVENT-PER-VERSION a version of an attempt without its domain event is refused at COMMIT (KA003); the same change with its outbound event commits", async () => {
  const a = await declaredAttempt();
  await oracle.query("BEGIN");
  await oracle.query("UPDATE kauro.outbound_execution_attempts SET state = 'UNCERTAIN', version = version + 1 WHERE attempt_id = $1", [a]);
  await assert.rejects(oracle.query("COMMIT"), (e: unknown) => {
    assert.equal(sqlState(e), "KA003", String(e));
    return true;
  });
  const after = await oracle.query<{ state: string; version: string }>("SELECT state, version::text FROM kauro.outbound_execution_attempts WHERE attempt_id = $1", [a]);
  assert.deepEqual(after.rows[0], { state: "DECLARED", version: "1" }, "the refused version left nothing");
  await oracle.query("BEGIN");
  await oracle.query("UPDATE kauro.outbound_execution_attempts SET state = 'UNCERTAIN', version = version + 1 WHERE attempt_id = $1", [a]);
  await oracle.query(
    `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
     VALUES ($1, 'outbound_execution_attempt', $2, 2, NULL, 'outbound.uncertain.v1', 'SERVICE', 'payment-service', $3, $4, '{}'::jsonb, $5, '1', now())`,
    [id(), a, id(), id(), SHA],
  );
  await oracle.query("COMMIT");
  const done = await oracle.query<{ state: string; version: string }>("SELECT state, version::text FROM kauro.outbound_execution_attempts WHERE attempt_id = $1", [a]);
  assert.deepEqual(done.rows[0], { state: "UNCERTAIN", version: "2" });
});
