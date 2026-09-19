// Tenant isolation on real PostgreSQL 17 (08 "Database isolation": RLS applies visibility and writes through USING and WITH
// CHECK; tenant context is set transaction-locally and cleared on pool return; a connection reused from agency A to agency B
// cannot inherit the context of A; a request without valid context fails closed; foreign keys bind tenant and parent
// identity; tests include aborted transactions, exceptions and concurrent pooled requests).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/index.js";
import { agency, bind, constraintOf, endClient, ids, member, person, processingAuthority, sqlState, tx, type AgencyFixture } from "./support.js";

let pg: TemporaryPostgres;
let app: Client;
let oracle: Client;
let A: AgencyFixture;
let B: AgencyFixture;
let authorityA: string;
let clientA: string;

before(async () => {
  pg = await startTemporaryPostgres();
  app = await pg.connect("kauro_app_test");
  oracle = await pg.connect("postgres");
  const alice = await person(app, "alice");
  const bob = await person(app, "bob");
  A = await agency(app, alice, "Agency A");
  B = await agency(app, bob, "Agency B");
  authorityA = await processingAuthority(app, A);
  clientA = await endClient(app, A, authorityA, "Shared Label");
});
after(async () => {
  await app.end();
  await oracle.end();
  await pg.stop();
});

test("the oracle sees both tenants; the runtime role without context sees nothing and cannot write (fail closed)", async () => {
  const all = await oracle.query("SELECT count(*)::int AS n FROM kauro.agencies");
  assert.equal(all.rows[0].n, 2);
  const none = await app.query("SELECT count(*)::int AS n FROM kauro.agencies");
  assert.equal(none.rows[0].n, 0);
  const clients = await app.query("SELECT count(*)::int AS n FROM kauro.end_clients");
  assert.equal(clients.rows[0].n, 0);
  await app.query("BEGIN");
  try {
    await assert.rejects(
      app.query("INSERT INTO kauro.agencies (agency_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, 'Ghost', $2, now(), now())", [ids.next(), A.ownerUserId]),
      (e: unknown) => sqlState(e) === "42501",
    );
  } finally {
    await app.query("ROLLBACK");
  }
  await app.query("BEGIN");
  try {
    await bind(app, { agencyId: "not-a-uuid" });
    await assert.rejects(app.query("SELECT count(*) FROM kauro.agencies"), (e: unknown) => sqlState(e) === "22P02");
  } finally {
    await app.query("ROLLBACK");
  }
});

test("a tenant context sees exactly its own rows and cannot select, update or insert rows of the other tenant", async () => {
  await tx(app, { agencyId: A.agencyId, userId: A.ownerUserId }, async (c) => {
    const mine = await c.query("SELECT agency_id, display_name FROM kauro.agencies");
    assert.deepEqual(mine.rows, [{ agency_id: A.agencyId, display_name: "Agency A" }]);
    const other = await c.query("SELECT count(*)::int AS n FROM kauro.agencies WHERE agency_id = $1", [B.agencyId]);
    assert.equal(other.rows[0].n, 0, "foreign agency is invisible even when addressed by id");
    const upd = await c.query("UPDATE kauro.agencies SET display_name = 'Hijacked', version = version + 1 WHERE agency_id = $1", [B.agencyId]);
    assert.equal(upd.rowCount, 0, "an update against the other tenant touches nothing");
    const members = await c.query("SELECT agency_id FROM kauro.memberships");
    assert.ok(members.rows.every((m) => m.agency_id === A.agencyId));
    await assert.rejects(
      c.query(
        "INSERT INTO kauro.end_clients (client_id, agency_id, display_name, processing_authority_ref, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, 'Smuggled', $3, $4, now(), now())",
        [ids.next(), B.agencyId, authorityA, A.ownerMembershipId],
      ),
      (e: unknown) => sqlState(e) === "42501",
      "WITH CHECK refuses a row whose agency_id is not the bound context",
    );
  });
  const untouched = await oracle.query("SELECT display_name FROM kauro.agencies WHERE agency_id = $1", [B.agencyId]);
  assert.equal(untouched.rows[0].display_name, "Agency B");
});

test("composite foreign keys refuse a child that references another tenant's parent even inside a valid context", async () => {
  // Agency B tries to create a client with the processing authority of agency A (CMD009 "a foreign authority reference rejects")
  await app.query("BEGIN");
  try {
    await bind(app, { agencyId: B.agencyId, userId: B.ownerUserId });
    await assert.rejects(
      app.query(
        "INSERT INTO kauro.end_clients (client_id, agency_id, display_name, processing_authority_ref, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, 'Client', $3, $4, now(), now())",
        [ids.next(), B.agencyId, authorityA, B.ownerMembershipId],
      ),
      (e: unknown) => sqlState(e) === "23503" && constraintOf(e) === "end_clients_agency_id_processing_authority_ref_fkey",
    );
  } finally {
    await app.query("ROLLBACK");
  }
  // and a project of B cannot point at a client of A
  await app.query("BEGIN");
  try {
    await bind(app, { agencyId: B.agencyId, userId: B.ownerUserId });
    const capability = ids.next();
    await assert.rejects(
      app.query(
        "INSERT INTO kauro.projects (project_id, agency_id, client_id, mode, purpose, capability_id, capability_version, current_revision_id, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, $3, 'CLEAN', 'p', $4, 'v', $5, $6, now(), now())",
        [ids.next(), B.agencyId, clientA, capability, ids.next(), B.ownerMembershipId],
      ),
      (e: unknown) => sqlState(e) === "23503",
    );
  } finally {
    await app.query("ROLLBACK");
  }
  const count = await oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients");
  assert.equal(count.rows[0].n, 1);
});

test("the same connection carries no context after commit, after rollback and after an exception", async () => {
  await tx(app, { agencyId: A.agencyId, userId: A.ownerUserId }, async (c) => {
    const n = await c.query("SELECT count(*)::int AS n FROM kauro.end_clients");
    assert.equal(n.rows[0].n, 1);
  });
  const afterCommit = await app.query("SELECT current_setting('kauro.agency_id', true) AS a, count(*)::int AS n FROM kauro.end_clients");
  assert.equal(afterCommit.rows[0].a, "");
  assert.equal(afterCommit.rows[0].n, 0);
  await app.query("BEGIN");
  await bind(app, { agencyId: A.agencyId, userId: A.ownerUserId });
  await app.query("ROLLBACK");
  const afterRollback = await app.query("SELECT count(*)::int AS n FROM kauro.end_clients");
  assert.equal(afterRollback.rows[0].n, 0);
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: A.ownerUserId }, async (c) => {
      await c.query("SELECT 1 FROM kauro.end_clients");
      throw new Error("handler failure");
    }),
    /handler failure/,
  );
  const afterException = await app.query("SELECT current_setting('kauro.agency_id', true) AS a, count(*)::int AS n FROM kauro.end_clients");
  assert.equal(afterException.rows[0].a, "");
  assert.equal(afterException.rows[0].n, 0);
});

test("two pooled connections in different contexts interleave without leaking", async () => {
  const c1 = await pg.connect("kauro_app_test");
  const c2 = await pg.connect("kauro_app_test");
  try {
    await c1.query("BEGIN");
    await c2.query("BEGIN");
    await bind(c1, { agencyId: A.agencyId, userId: A.ownerUserId });
    await bind(c2, { agencyId: B.agencyId, userId: B.ownerUserId });
    const [a, b] = await Promise.all([c1.query("SELECT display_name FROM kauro.agencies"), c2.query("SELECT display_name FROM kauro.agencies")]);
    assert.deepEqual(a.rows, [{ display_name: "Agency A" }]);
    assert.deepEqual(b.rows, [{ display_name: "Agency B" }]);
    await c1.query("COMMIT");
    await c2.query("COMMIT");
    const [a2, b2] = await Promise.all([c1.query("SELECT count(*)::int AS n FROM kauro.agencies"), c2.query("SELECT count(*)::int AS n FROM kauro.agencies")]);
    assert.equal(a2.rows[0].n, 0);
    assert.equal(b2.rows[0].n, 0);
  } finally {
    await c1.end();
    await c2.end();
  }
});

test("a person sees their own memberships and the agencies they belong to without a tenant context, and nothing else", async () => {
  const carol = await person(app, "carol");
  await member(app, A, carol, "VIEWER");
  await tx(app, { userId: carol.userId }, async (c) => {
    const memberships = await c.query("SELECT agency_id, role FROM kauro.memberships");
    assert.deepEqual(memberships.rows, [{ agency_id: A.agencyId, role: "VIEWER" }]);
    const agencies = await c.query("SELECT agency_id FROM kauro.agencies ORDER BY 1");
    assert.deepEqual(agencies.rows, [{ agency_id: A.agencyId }]);
    const identities = await c.query("SELECT user_id FROM kauro.identities");
    assert.deepEqual(identities.rows, [{ user_id: carol.userId }], "another person's identity facts are never visible");
    const clients = await c.query("SELECT count(*)::int AS n FROM kauro.end_clients");
    assert.equal(clients.rows[0].n, 0, "an identity context is not a tenant context");
  });
  await tx(app, { userId: B.ownerUserId }, async (c) => {
    const agencies = await c.query("SELECT agency_id FROM kauro.agencies");
    assert.deepEqual(agencies.rows, [{ agency_id: B.agencyId }]);
  });
});

test("duplicate client labels are two workspaces (labels are presentation, identity is stable)", async () => {
  const second = await endClient(app, A, authorityA, "Shared Label");
  assert.notEqual(second, clientA);
  const rows = await oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients WHERE agency_id = $1 AND display_name = 'Shared Label'", [A.agencyId]);
  assert.equal(rows.rows[0].n, 2);
});
