// Command journal, request journal and leases on real PostgreSQL 17.
// - 10 "Idempotency contract" / S052: one key with different payloads is a conflict the handler answers from the stored
//   digest; an identical replay reads the stored result; a concurrent duplicate blocks on the identity index until the first
//   transaction ends and then sees its committed row (or proceeds when it rolled back).
// - S089 (structural half): a dispatch intent with a short SHA, no funded reservation or no grant cannot be materialized.
// - S090: a resume that omits or swaps the stored checkpoint, or resets the absolute deadline, is refused; subject, clock
//   and fence identity are preserved; a fenced-out owner cannot heartbeat or checkpoint.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { commandRequestDigest } from "@kauro/domain";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/index.js";
import { agency, bind, constraintOf, ids, person, sha, sqlState, tx, type AgencyFixture, type Person } from "./support.js";

let pg: TemporaryPostgres;
let app: Client;
let control: Client;
let oracle: Client;
let owner: Person;
let A: AgencyFixture;

before(async () => {
  pg = await startTemporaryPostgres();
  app = await pg.connect("kauro_app_test");
  control = await pg.connect("kauro_control_test");
  oracle = await pg.connect("postgres");
  owner = await person(app, "owner-journal");
  A = await agency(app, owner, "Journal Agency");
});
after(async () => {
  await app.end();
  await control.end();
  await oracle.end();
  await pg.stop();
});

const KEY = "k_0123456789abcdef";

function reserve(c: Client, agencyId: string | null, key: string, digest: string, entryId = ids.next()) {
  return c.query(
    `INSERT INTO kauro.command_journal (entry_id, environment, actor_kind, actor_id, agency_id, operation, idempotency_key, request_digest, correlation_id, reserved_at, updated_at)
     VALUES ($1, 'LOCAL', 'USER', $2, $3, 'CMD009', $4, $5, $6, now(), now()) RETURNING entry_id`,
    [entryId, owner.userId, agencyId, key, digest, ids.next()],
  );
}

test("S052: the journal stores the request digest and the response; a replay reads it back; a different digest under the same key is a conflict the identity index makes unique", async () => {
  const digest = commandRequestDigest({ operation: "CMD009", aggregate: { agencyId: A.agencyId }, body: { displayName: "Client", processingAuthorityRef: ids.next() } });
  const other = commandRequestDigest({ operation: "CMD009", aggregate: { agencyId: A.agencyId }, body: { displayName: "Different", processingAuthorityRef: ids.next() } });
  const clientId = ids.next();
  await tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
    const r = await reserve(c, A.agencyId, KEY, digest);
    await c.query(
      "UPDATE kauro.command_journal SET state = 'COMMITTED', response_status = 201, response_body = $2, resource_kind = 'end_client', resource_id = $3, committed_at = now() WHERE entry_id = $1",
      [r.rows[0].entry_id, JSON.stringify({ clientId }), clientId],
    );
  });
  // replay: the handler finds the committed entry by identity and compares digests
  await tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
    const found = await c.query("SELECT request_digest, state, response_status, response_body FROM kauro.command_journal WHERE operation = 'CMD009' AND idempotency_key = $1", [KEY]);
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0].request_digest, digest);
    assert.equal(found.rows[0].state, "COMMITTED");
    assert.deepEqual(found.rows[0].response_body, { clientId });
    assert.notEqual(found.rows[0].request_digest, other, "a different payload under the same key is IDEMPOTENCY_CONFLICT");
  });
  // the same identity cannot be reserved twice (a second reservation with the other digest fails on the identity index)
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => reserve(c, A.agencyId, KEY, other)),
    (e: unknown) => sqlState(e) === "23505" && constraintOf(e) === "command_journal_identity",
  );
  // a committed entry is final: the stored response cannot be rewritten (10: deleting a cache cannot make an effect repeatable)
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => c.query("UPDATE kauro.command_journal SET response_body = '{}' WHERE idempotency_key = $1", [KEY])),
    (e: unknown) => sqlState(e) === "KA007",
  );
  // the same key in another agency is another identity (10: identity includes agency)
  const otherPerson = await person(app, "other-journal");
  const B = await agency(app, otherPerson, "Other Journal Agency");
  await tx(app, { agencyId: B.agencyId, userId: owner.userId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.command_journal (entry_id, environment, actor_kind, actor_id, agency_id, operation, idempotency_key, request_digest, correlation_id, reserved_at, updated_at)
       VALUES ($1, 'LOCAL', 'USER', $2, $3, 'CMD009', $4, $5, $6, now(), now())`,
      [ids.next(), owner.userId, B.agencyId, KEY, digest, ids.next()],
    );
  });
});

test("a concurrent duplicate blocks on the identity until the first transaction commits, then sees the committed entry; after a rollback it proceeds as first", async () => {
  const key = "k_concurrent_dup_01";
  const digest = sha("same request");
  const c1 = await pg.connect("kauro_app_test");
  const c2 = await pg.connect("kauro_app_test");
  try {
    const pid2 = (await c2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await c1.query("BEGIN");
    await c2.query("BEGIN");
    await bind(c1, { agencyId: A.agencyId, userId: owner.userId });
    await bind(c2, { agencyId: A.agencyId, userId: owner.userId });
    await reserve(c1, A.agencyId, key, digest);
    const second = reserve(c2, A.agencyId, key, digest);
    for (let i = 0; i < 200; i++) {
      const w = await oracle.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid2]);
      if (w.rows[0]?.wait_event_type === "Lock") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // first request rolls back (crash before commit): the duplicate proceeds as the first request
    await c1.query("ROLLBACK");
    const r2 = await second;
    assert.equal(r2.rowCount, 1);
    await c2.query("COMMIT");
    // now the committed identity exists: a later duplicate reservation is refused and the handler replays the entry
    await c1.query("BEGIN");
    await bind(c1, { agencyId: A.agencyId, userId: owner.userId });
    await assert.rejects(reserve(c1, A.agencyId, key, digest), (e: unknown) => sqlState(e) === "23505");
    await c1.query("ROLLBACK");
  } finally {
    await c1.end();
    await c2.end();
  }
  const rows = await oracle.query("SELECT count(*)::int AS n FROM kauro.command_journal WHERE idempotency_key = $1", [key]);
  assert.equal(rows.rows[0].n, 1);
});

test("CreateAgency reservations (no tenant) are visible to the identity that reserved them and to no other identity", async () => {
  const key = "k_create_agency_01";
  await tx(app, { userId: owner.userId }, async (c) => {
    await c.query(
      `INSERT INTO kauro.command_journal (entry_id, environment, actor_kind, actor_id, agency_id, operation, idempotency_key, request_digest, correlation_id, reserved_at, updated_at)
       VALUES ($1, 'LOCAL', 'USER', $2, NULL, 'CMD001', $3, $4, $5, now(), now())`,
      [ids.next(), owner.userId, key, sha("create agency"), ids.next()],
    );
  });
  await tx(app, { userId: owner.userId }, async (c) => {
    const mine = await c.query("SELECT count(*)::int AS n FROM kauro.command_journal WHERE idempotency_key = $1", [key]);
    assert.equal(mine.rows[0].n, 1);
  });
  const stranger = await person(app, "stranger-journal");
  await tx(app, { userId: stranger.userId }, async (c) => {
    const theirs = await c.query("SELECT count(*)::int AS n FROM kauro.command_journal WHERE idempotency_key = $1", [key]);
    assert.equal(theirs.rows[0].n, 0);
  });
});

test("S089: a request journal entry cannot be materialized with a short SHA, without a positive reservation or without a grant; the valid control commits", async () => {
  const taskId = ids.next();
  const insert = (hash: string, reserved: number, grant: string | null, fence = 1) =>
    control.query(
      `INSERT INTO kauro.request_journal (request_id, task_id, agency_id, request_hash, fence, reserved_cents, cost_grant_id, reserved_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
      [ids.next(), taskId, A.agencyId, hash, fence, reserved, grant],
    );
  await assert.rejects(insert("abc1234", 150, ids.next()), (e: unknown) => sqlState(e) === "23514", "short SHA");
  await assert.rejects(insert(sha("request"), 0, ids.next()), (e: unknown) => sqlState(e) === "23514", "no reserved ceiling");
  await assert.rejects(insert(sha("request"), 150, null), (e: unknown) => sqlState(e) === "23502", "no grant");
  await insert(sha("request"), 150, ids.next());
  await assert.rejects(insert(sha("request-2"), 150, ids.next(), 1), (e: unknown) => sqlState(e) === "23505", "one attempt per fence");
  await insert(sha("request-2"), 150, ids.next(), 2);
  // response before consume; terminal states stay terminal; the reservation is immutable
  const req = (await oracle.query("SELECT request_id FROM kauro.request_journal WHERE task_id = $1 AND fence = 1", [taskId])).rows[0].request_id as string;
  await assert.rejects(control.query("UPDATE kauro.request_journal SET state = 'CONSUMED' WHERE request_id = $1", [req]), (e: unknown) => sqlState(e) === "KA007");
  await control.query("UPDATE kauro.request_journal SET state = 'DISPATCHING' WHERE request_id = $1", [req]);
  await control.query("UPDATE kauro.request_journal SET state = 'RESPONSE_STORED', response_artifact_hash = $2, usage_state = 'KNOWN', actual_cents = 120 WHERE request_id = $1", [req, sha("response")]);
  await control.query("UPDATE kauro.request_journal SET state = 'CONSUMED' WHERE request_id = $1", [req]);
  await assert.rejects(control.query("UPDATE kauro.request_journal SET state = 'DISPATCHING' WHERE request_id = $1", [req]), (e: unknown) => sqlState(e) === "KA007");
  await assert.rejects(control.query("UPDATE kauro.request_journal SET reserved_cents = 1 WHERE request_id = $1", [req]), (e: unknown) => sqlState(e) === "KA004");
  // request handlers only read their tenant's cost rows
  await tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
    const n = await c.query("SELECT count(*)::int AS n FROM kauro.request_journal");
    assert.equal(n.rows[0].n, 2);
    await assert.rejects(c.query("UPDATE kauro.request_journal SET state = 'FAILED' WHERE request_id = $1", [req]), (e: unknown) => sqlState(e) === "42501");
  });
});

test("S090: a lease preserves subject, deadline and checkpoint identity across a takeover; a resume without the checkpoint or with a reset deadline is refused", async () => {
  const resource = ids.next();
  const subject = sha("subject");
  const deadline = new Date(Date.now() + 3_600_000);
  const owner1 = ids.next();
  const owner2 = ids.next();
  const t0 = new Date();
  const claim = (who: string, at: Date, checkpoint: string | null, dl: Date = deadline, subj: string = subject) =>
    control.query("SELECT * FROM kauro.claim_lease('JOB_ATTEMPT', $1, $2, 120, $3, $4, $5, $6)", [resource, who, dl, subj, checkpoint, at]);
  const first = (await claim(owner1, t0, null)).rows[0];
  assert.equal(first.owner_id, owner1);
  assert.equal(first.fence, "1");
  assert.equal(first.checkpoint_hash, null);
  // a live lease is HELD: the claimer gets the current holder back
  const held = (await claim(owner2, new Date(t0.getTime() + 1000), null)).rows[0];
  assert.equal(held.owner_id, owner1);
  // the holder stores a checkpoint under its fence; a fenced-out or wrong-fence caller cannot
  const cp = sha("checkpoint-1");
  const stored = await control.query("SELECT * FROM kauro.checkpoint_lease('JOB_ATTEMPT', $1, $2, 1, $3, $4)", [resource, owner1, cp, new Date(t0.getTime() + 2000)]);
  assert.equal(stored.rows[0].checkpoint_hash, cp);
  const wrongFence = await control.query("SELECT (kauro.checkpoint_lease('JOB_ATTEMPT', $1, $2, 2, $3, $4)).owner_id AS o", [resource, owner1, sha("x"), new Date(t0.getTime() + 2000)]);
  assert.equal(wrongFence.rows[0].o, null);
  // the lease expires; a takeover must carry the stored checkpoint identity
  const late = new Date(t0.getTime() + 130_000);
  await assert.rejects(claim(owner2, late, null), (e: unknown) => sqlState(e) === "KA005", "resume without checkpoint");
  await assert.rejects(claim(owner2, late, sha("other checkpoint")), (e: unknown) => sqlState(e) === "KA005", "checkpoint mismatch");
  await assert.rejects(claim(owner2, late, cp, new Date(deadline.getTime() + 60_000)), (e: unknown) => sqlState(e) === "KA004", "deadline reset");
  await assert.rejects(claim(owner2, late, cp, deadline, sha("another subject")), (e: unknown) => sqlState(e) === "KA004", "subject swap");
  const resumed = (await claim(owner2, late, cp)).rows[0];
  assert.equal(resumed.owner_id, owner2);
  assert.equal(resumed.fence, "2");
  assert.equal(resumed.checkpoint_hash, cp);
  assert.equal(new Date(resumed.deadline_at).getTime(), deadline.getTime());
  assert.equal(resumed.subject_hash, subject);
  // the old owner is fenced out: its heartbeat renews nothing
  const stale = await control.query("SELECT (kauro.heartbeat_lease('JOB_ATTEMPT', $1, $2, 1, 120, $3)).fence AS f", [resource, owner1, new Date(late.getTime() + 1000)]);
  assert.equal(stale.rows[0].f, null);
  const fresh = await control.query("SELECT * FROM kauro.heartbeat_lease('JOB_ATTEMPT', $1, $2, 2, 120, $3)", [resource, owner2, new Date(late.getTime() + 1000)]);
  assert.equal(fresh.rows[0].fence, "2");
  // a claim or renewal never extends past the deadline; a claim after the deadline is refused
  const shortResource = ids.next();
  const shortDeadline = new Date(t0.getTime() + 60_000);
  const capped = await control.query("SELECT * FROM kauro.claim_lease('JOB_ATTEMPT', $1, $2, 120, $3, $4, NULL, $5)", [shortResource, owner1, shortDeadline, subject, t0]);
  assert.equal(new Date(capped.rows[0].expires_at).getTime(), shortDeadline.getTime());
  const renewed = await control.query("SELECT * FROM kauro.heartbeat_lease('JOB_ATTEMPT', $1, $2, 1, 120, $3)", [shortResource, owner1, new Date(t0.getTime() + 30_000)]);
  assert.equal(new Date(renewed.rows[0].expires_at).getTime(), shortDeadline.getTime());
  await assert.rejects(claim(owner1, new Date(deadline.getTime() + 1), cp), (e: unknown) => sqlState(e) === "KA005");
  // cancellation advances a monotonic generation the owner must observe
  const cancelled = await control.query("SELECT * FROM kauro.cancel_lease('JOB_ATTEMPT', $1)", [resource]);
  assert.equal(cancelled.rows[0].cancel_version, "1");
  await assert.rejects(control.query("UPDATE kauro.leases SET cancel_version = 0 WHERE resource_id = $1", [resource]), (e: unknown) => sqlState(e) === "KA005");
  // request handlers have no access to leases at all
  await tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
    await assert.rejects(c.query("SELECT * FROM kauro.leases"), (e: unknown) => sqlState(e) === "42501");
  });
});
