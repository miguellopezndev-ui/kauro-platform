// K2: command_journal.operation (0006 '^CMD[0-9]{3}$') accepts B12's registry-less operations by an EXPLICIT list (0088 tail), on real PostgreSQL 17.
// The list in the migration is the domain's B12_OPERATIONS and nothing else: a name outside it, a lower-cased one, a prefix or a pattern is
// refused with a check violation on the constraint, and every catalogue id still passes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { B12_OPERATIONS } from "@kauro/domain";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";
import { constraintOf, ids, sha, sqlState } from "./support.js";

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
/** One journal row of the operation, inside a transaction the caller rolls back; SERVICE actor, no agency (a B12 route binds none). */
function reserve(operation: string): Promise<unknown> {
  seq += 1;
  return oracle.query(
    `INSERT INTO kauro.command_journal (entry_id, environment, actor_kind, actor_id, agency_id, operation, idempotency_key, request_digest, correlation_id, reserved_at, updated_at)
     VALUES ($1, 'LOCAL', 'SERVICE', 'outreach-service', NULL, $2, $3, $4, $5, now(), now())`,
    [ids.next(), operation, `k_b12_journal_op_${String(seq).padStart(6, "0")}`, sha(`op-${seq}`), ids.next()],
  );
}

async function inRolledBack(fn: () => Promise<void>): Promise<void> {
  await oracle.query("BEGIN");
  try {
    await fn();
  } finally {
    await oracle.query("ROLLBACK");
  }
}

test("K2 journal operation: the constraint lists exactly the domain's B12 operations beside the catalogue pattern", async () => {
  const { rows } = await oracle.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'kauro.command_journal'::regclass AND c.conname = 'command_journal_operation_check'`,
  );
  assert.equal(rows.length, 1, "one operation check, under its original name");
  const def = rows[0]!.def;
  assert.ok(def.includes("^CMD[0-9]{3}$"), "the catalogue pattern stays");
  const listed = [...def.matchAll(/'([A-Za-z]+)'::text/g)].map((m) => m[1]!).filter((n) => n !== "CMD");
  assert.deepEqual([...listed].sort(), [...B12_OPERATIONS].sort(), "the migration's list is B12_OPERATIONS, no more and no fewer");
});

test("K2 journal operation: every catalogue id and every B12 operation is journaled; a name outside the list is a check violation", async () => {
  for (const operation of ["CMD001", "CMD061", "CMD064", ...B12_OPERATIONS]) {
    await inRolledBack(async () => {
      await reserve(operation);
    });
  }
  for (const operation of ["PutOutreachContents", "putOutreachContent", "PutOutreach", "CMD61", "CMD0610", "cmd061", "Put.*", "", "PutOutreachContent ", "GetOutreachDraft"]) {
    await inRolledBack(async () => {
      await assert.rejects(reserve(operation), (e: unknown) => sqlState(e) === "23514" && constraintOf(e) === "command_journal_operation_check", `"${operation}" must be refused by command_journal_operation_check`);
    });
  }
});
