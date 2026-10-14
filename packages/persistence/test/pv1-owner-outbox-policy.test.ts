// Payments V1, lane OWNER-OUTBOX-POLICY (migration 0072, provisional number): the corporate owner's agency-less outbox records (the
// credit and import records of 0063, the route records of 0046) are written by the owner's request handlers with INSERT only and read
// with SELECT only (event-publisher.ts: one INSERT per subscribed consumer, no RETURNING, no upsert); the dispatch columns move only under
// kauro_control (inbox-outbox.ts). So the owner's policies on kauro.outbox_records name exactly SELECT and INSERT, never FOR ALL, and the
// owner role's UPDATE and DELETE of such a row are refused.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import type { UserId } from "@kauro/domain";
import { PgEventPublisher } from "../src/event-publisher.js";
import { startHarness, type Harness } from "../src/testing/index.js";
import { clock, ids, sha, sqlState, tx } from "./support.js";

let h: Harness;
let app: Client;
let owner: UserId;

before(async () => {
  h = await startHarness();
  app = await h.pg.connect("kauro_app_test");
  owner = await h.person("outbox-policy-owner");
  await h.grantKauroOwner(owner);
});
after(async () => {
  await app.end();
  await h.stop();
});

/** A statement import recorded by the owner in its own session (agency NULL), with its event and outbox records through the real publisher. */
async function ownerImport(): Promise<{ readonly importId: string; readonly outboxIds: ReadonlyArray<string> }> {
  const importId = ids.next();
  const evidenceHash = sha(`import-${importId}`);
  const outboxIds = await tx(app, { userId: owner }, async (c) => {
    await c.query(
      "INSERT INTO kauro.statement_imports (import_id, environment, account_ref, artifact_ref, evidence_hash, normalizer_version, idempotency_key, imported_by) VALUES ($1, 'SANDBOX', $2, $3, $4, 'v1', $5, $6)",
      [importId, `acct-${importId}`, `artifact-${importId}`, evidenceHash, `import-key-${importId}`, owner],
    );
    const published = await new PgEventPublisher(c, ids, clock).publish({
      aggregateKind: "statement_import" as never,
      aggregateId: importId as never,
      aggregateVersion: 1,
      agencyId: null,
      eventType: "statement_import.recorded.v1" as never,
      actor: { kind: "USER", userId: owner },
      causationId: ids.next() as never,
      correlationId: ids.next() as never,
      payload: { importId, evidenceHash, lines: 1, newLines: 1 },
    });
    return published.outbox.map((o) => o.outboxId as string);
  });
  return { importId, outboxIds };
}

test("DENY: the owner role's UPDATE and DELETE of its own agency-less import outbox record are refused (42501) and change nothing; its INSERT (the publisher) and SELECT of the row stand", async () => {
  const { outboxIds } = await ownerImport();
  assert.ok(outboxIds.length >= 1, "the import's event has an outbox record (NOTIFICATIONS)");
  const outboxId = outboxIds[0]!;
  const seen = await tx(app, { userId: owner }, async (c) => (await c.query<{ state: string }>("SELECT state FROM kauro.outbox_records WHERE outbox_id = $1", [outboxId])).rows);
  assert.deepEqual(seen, [{ state: "PENDING" }], "the owner reads its record");
  await assert.rejects(
    tx(app, { userId: owner }, (c) => c.query("UPDATE kauro.outbox_records SET state = 'DELIVERED', delivered_at = now() WHERE outbox_id = $1", [outboxId])),
    (e) => sqlState(e) === "42501",
    "the owner never settles a dispatch",
  );
  await assert.rejects(
    tx(app, { userId: owner }, (c) => c.query("DELETE FROM kauro.outbox_records WHERE outbox_id = $1", [outboxId])),
    (e) => sqlState(e) === "42501",
    "the owner never deletes a record",
  );
  const after = await h.oracle.query<{ state: string; attempts: number }>("SELECT state, attempts FROM kauro.outbox_records WHERE outbox_id = $1", [outboxId]);
  assert.deepEqual(after.rows, [{ state: "PENDING", attempts: 0 }]);
});

test("DENY (the policies themselves): every kauro_app policy on kauro.outbox_records for the owner's agency-less records names SELECT or INSERT only, never ALL, UPDATE or DELETE; the INSERT policy keeps the agency-less kinds and the acting owner in its check", async () => {
  const policies = await h.oracle.query<{ policyname: string; cmd: string; with_check: string | null; qual: string | null }>(
    "SELECT policyname, cmd, with_check, qual FROM pg_policies WHERE schemaname = 'kauro' AND tablename = 'outbox_records' AND 'kauro_app' = ANY (roles) AND policyname LIKE 'outbox_records_owner_%' ORDER BY policyname",
  );
  assert.deepEqual(
    policies.rows.map((p) => `${p.policyname} ${p.cmd}`),
    ["outbox_records_owner_bank_read SELECT", "outbox_records_owner_bank_record INSERT", "outbox_records_owner_route_read SELECT", "outbox_records_owner_route_record INSERT"],
    "the owner's outbox policies are SELECT and INSERT only (0063:188 and 0046:256 were FOR ALL)",
  );
  for (const p of policies.rows) {
    const clause = p.cmd === "INSERT" ? p.with_check : p.qual;
    assert.match(clause ?? "", /acting_corporate_owner\(\)/, `${p.policyname} binds the acting owner`);
    assert.match(clause ?? "", /agency_id IS NULL/, `${p.policyname} binds agency-less events`);
  }
});
