// The pool factory and the unit of work on real PostgreSQL 17 (08 "Database isolation": runtime roles are not owners,
// superusers or BYPASSRLS; tenant context is set transaction-locally and cleared on pool return; tests include aborted
// transactions, exceptions, retry paths and concurrent pooled requests. 07 "Transaction discipline": state, event and
// outbox commit atomically; read committed with locks and constraints, bounded serializable retries where chosen).
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { after, before, test } from "node:test";
import { DomainFailure, abandonWorkOf, isDomainFailure, type AgencyId, type CausationId, type ClientId, type MembershipId, type UserId } from "@kauro/domain";
import { PrivilegedRoleError, createPool, listMigrations } from "../src/index.js";
import { ROLES } from "../src/testing/index.js";
import { barrier, clock, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";

let h: Harness;
let owner: UserId;
let A: AgencyFixture;

before(async () => {
  h = await start();
  owner = await h.person("owner-uow");
  A = await h.createAgency(owner, "Unit Of Work Agency");
});
after(async () => {
  await h.stop();
});

function failure(e: unknown): DomainFailure {
  assert.ok(isDomainFailure(e), `expected a DomainFailure, got ${String(e)}`);
  return e;
}

test("the harness applied every migration from an empty cluster and the pools run as unprivileged members of one runtime group", async () => {
  assert.equal(h.pg.migrations.applied.length, listMigrations().length);
  assert.equal(h.pg.migrations.skipped.length, 0);
  const app = await h.appPool.acquire();
  assert.deepEqual(app.connection, { role: "kauro_app", loginRole: ROLES.appLogin });
  app.client.release();
  const control = await h.controlPool.acquire();
  assert.deepEqual(control.connection, { role: "kauro_control", loginRole: ROLES.controlLogin });
  control.client.release();
});

test("a pool refuses a superuser login and the owner login before any statement runs (08: privileged roles never serve requests)", async () => {
  for (const user of [ROLES.superuser, ROLES.owner]) {
    const pool = createPool({ host: "127.0.0.1", port: h.pg.port, database: ROLES.database, user, max: 1, applicationName: "kauro-test-privileged" });
    try {
      await assert.rejects(pool.acquire(), (e: unknown) => e instanceof PrivilegedRoleError, user);
      assert.equal(pool.totalCount, 0, "the privileged connection was destroyed, not pooled");
    } finally {
      await pool.end();
    }
  }
  assert.throws(() => createPool({ host: "127.0.0.1", port: h.pg.port, database: ROLES.database, user: ROLES.appLogin, max: 25, applicationName: "x" }), RangeError);
});

test("a context runs only on the pool of its role: SYSTEM is refused on the request pool, TENANT and IDENTITY on the control pool", async () => {
  await assert.rejects(
    h.app.run(h.system(), async () => undefined),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
  );
  await assert.rejects(
    h.control.run(h.tenant(A.agencyId, owner), async () => undefined),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
  );
  await assert.rejects(
    h.control.run(h.identity(owner), async () => undefined),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
  );
});

test("commit persists everything; a thrown DomainFailure rolls everything back and is rethrown as the business outcome", async () => {
  const authority = await h.processingAuthority(A);
  const before = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients");
  const rejection = new DomainFailure("PRECONDITION_FAILED", "handler refused after the write", { reason: "AGENCY_NOT_OPEN" });
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
      const clientId = uow.ids.next() as ClientId;
      await uow.endClients.insert({ clientId, agencyId: A.agencyId, displayName: "Rolled back", processingAuthorityRef: authority, createdByMembershipId: A.ownerMembershipId, createdAt: clock.now() });
      throw rejection;
    }),
    (e: unknown) => e === rejection,
  );
  const after = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients");
  assert.equal(after.rows[0].n, before.rows[0].n);
  const clientId = await h.endClient(A, authority, "Committed");
  const committed = await h.oracle.query("SELECT display_name, version FROM kauro.end_clients WHERE client_id = $1", [clientId]);
  assert.deepEqual(committed.rows[0], { display_name: "Committed", version: "1" });
});

test("an unexpected exception becomes INTERNAL_ERROR carrying only the correlation id; the cause stays server-side", async () => {
  const context = h.tenant(A.agencyId, owner);
  const boom = new Error("connection to the CRM exploded: SELECT secret FROM customers");
  let caught: unknown;
  try {
    await h.app.run(context, async () => {
      throw boom;
    });
  } catch (e) {
    caught = e;
  }
  const f = failure(caught);
  assert.equal(f.code, "INTERNAL_ERROR");
  assert.equal(f.retryable, true);
  assert.ok(f.message.includes(context.correlationId));
  assert.ok(!f.message.includes("SELECT"), "the message never carries the original text");
  assert.equal(f.cause, boom);
});

test("a connection returned to the pool carries no context after commit, rollback and exception (08: cleared on pool return)", async () => {
  await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    assert.notEqual(await uow.agencies.get(A.agencyId), null);
  });
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), async () => {
      throw new DomainFailure("NOT_FOUND", "rolled back on purpose");
    }),
  );
  // the same physical connections: max is 4 and nothing else is running, so every one of them served a unit of work above
  for (let i = 0; i < 4; i++) {
    const { client } = await h.appPool.acquire();
    try {
      const r = await client.query("SELECT current_setting('kauro.agency_id', true) AS a, current_setting('kauro.user_id', true) AS u, (SELECT count(*)::int FROM kauro.agencies) AS visible");
      assert.deepEqual(r.rows[0], { a: "", u: "", visible: 0 });
    } finally {
      client.release();
    }
  }
});

test("the deferred event-per-version rule fires at COMMIT: an aggregate written without its event is refused as INTEGRITY_FAILURE / EVENT_MISSING and nothing persists", async () => {
  const authority = await h.processingAuthority(A);
  let minted: string | undefined;
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
      const clientId = uow.ids.next() as ClientId;
      minted = clientId;
      await uow.endClients.insert({ clientId, agencyId: A.agencyId, displayName: "No event", processingAuthorityRef: authority, createdByMembershipId: A.ownerMembershipId, createdAt: clock.now() });
    }),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE" && failure(e).details.reason === "EVENT_MISSING",
  );
  const rows = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients WHERE client_id = $1", [minted]);
  assert.equal(rows.rows[0].n, 0);
});

test("adoptTenant: only an IDENTITY context, only once, only with an id minted in this unit of work; resolveMembership: TENANT only, once", async () => {
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.adoptTenant(uow.ids.next() as AgencyId)),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
    "TENANT context cannot adopt",
  );
  await assert.rejects(
    h.app.run(h.identity(owner), (uow) => uow.adoptTenant(A.agencyId)),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
    "an existing agency id was not minted here",
  );
  await assert.rejects(
    h.app.run(h.identity(owner), async (uow) => {
      await uow.adoptTenant(uow.ids.next() as AgencyId);
      await uow.adoptTenant(uow.ids.next() as AgencyId);
    }),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
    "adopts at most once",
  );
  await assert.rejects(
    h.app.run(h.identity(owner), async (uow) => uow.resolveMembership(A.ownerMembershipId)),
    (e: unknown) => failure(e).code === "INTEGRITY_FAILURE",
  );
  await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    assert.equal(uow.resolvedMembershipId, null);
    uow.resolveMembership(A.ownerMembershipId);
    assert.equal(uow.resolvedMembershipId, A.ownerMembershipId);
    assert.throws(() => uow.resolveMembership(A.ownerMembershipId), (e: unknown) => failure(e).code === "INTEGRITY_FAILURE");
    assert.equal(uow.userId, owner);
  });
});

test("CreateAgency through the adapters (CMD001-OK shape): one DRAFT agency, one ACTIVE OWNER membership, two events, one outbox row, journal COMMITTED, all in one transaction", async () => {
  const creator = await h.person("creator-uow");
  const created = await h.createAgency(creator, "Fresh Agency");
  const agency = await h.oracle.query("SELECT state, version, active_owner_count, terms_version, legal_profile_ref FROM kauro.agencies WHERE agency_id = $1", [created.agencyId]);
  assert.deepEqual(agency.rows[0], { state: "DRAFT", version: "1", active_owner_count: 1, terms_version: null, legal_profile_ref: null });
  const membership = await h.oracle.query("SELECT role, state, version FROM kauro.memberships WHERE membership_id = $1", [created.ownerMembershipId]);
  assert.deepEqual(membership.rows[0], { role: "OWNER", state: "ACTIVE", version: "1" });
  const events = await h.oracle.query("SELECT event_type FROM kauro.domain_events WHERE agency_id = $1 ORDER BY sequence", [created.agencyId]);
  assert.deepEqual(events.rows.map((r) => r.event_type), ["agency.created.v1", "membership.created.v1"]);
  const outbox = await h.oracle.query("SELECT o.consumer, o.state FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE e.agency_id = $1", [created.agencyId]);
  assert.deepEqual(outbox.rows, [{ consumer: "NOTIFICATIONS", state: "PENDING" }]);
  const journal = await h.oracle.query("SELECT state, response_status, resource_kind, resource_id, agency_id FROM kauro.command_journal WHERE operation = 'CMD001' AND actor_id = $1", [creator]);
  assert.deepEqual(journal.rows[0], { state: "COMMITTED", response_status: 201, resource_kind: "agency", resource_id: created.agencyId, agency_id: null });
  // a second DRAFT for the same creator is refused by the database as ADMISSION_LIMITED / DRAFT_AGENCY_EXISTS (D-CMD-1)
  await assert.rejects(h.createAgency(creator, "Second Draft"), (e: unknown) => failure(e).code === "ADMISSION_LIMITED" && failure(e).details.reason === "DRAFT_AGENCY_EXISTS");
  const count = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.agencies WHERE created_by_user_id = $1", [creator]);
  assert.equal(count.rows[0].n, 1);
});

test("SERIALIZABLE with bounded retries: a serialization failure re-runs the work in a fresh transaction and both units of work commit exactly once", async () => {
  const authority = await h.processingAuthority(A);
  const gate = barrier();
  const t1Read = barrier();
  let attemptsOfT2 = 0;
  const insertClient = async (uow: Parameters<Parameters<typeof h.app.run>[1]>[0], label: string): Promise<void> => {
    const clientId = uow.ids.next() as ClientId;
    await uow.endClients.insert({ clientId, agencyId: A.agencyId, displayName: label, processingAuthorityRef: authority, createdByMembershipId: A.ownerMembershipId, createdAt: clock.now() });
    await uow.events.publish({ aggregateKind: "end_client", aggregateId: clientId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "end_client.created.v1", actor: { kind: "USER", userId: owner }, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { clientId, agencyId: A.agencyId } });
  };
  // T1 and T2 both read the client list (a predicate), then both insert: a classic write skew that SERIALIZABLE refuses for one
  const t1 = h.app.run(
    h.tenant(A.agencyId, owner),
    async (uow) => {
      await uow.endClients.list(A.agencyId, { limit: 100 });
      t1Read.open();
      await gate.wait;
      await insertClient(uow, "serializable-1");
    },
    { isolation: "SERIALIZABLE", maxRetries: 0 },
  );
  await t1Read.wait;
  const t2 = h.app.run(
    h.tenant(A.agencyId, owner),
    async (uow) => {
      attemptsOfT2 += 1;
      await uow.endClients.list(A.agencyId, { limit: 100 });
      if (attemptsOfT2 === 1) {
        gate.open();
        await t1;
      }
      await insertClient(uow, "serializable-2");
    },
    { isolation: "SERIALIZABLE", maxRetries: 2 },
  );
  await t1;
  await t2;
  assert.equal(attemptsOfT2, 2, "the second unit of work was retried once after serialization_failure");
  const rows = await h.oracle.query("SELECT display_name FROM kauro.end_clients WHERE display_name LIKE 'serializable-%' ORDER BY 1");
  assert.deepEqual(rows.rows.map((r) => r.display_name), ["serializable-1", "serializable-2"]);
  // without retries the same interleaving surfaces as CAPACITY_UNAVAILABLE (retryable) — the caller's retry policy decides
  const gate2 = barrier();
  const read2 = barrier();
  const u1 = h.app.run(
    h.tenant(A.agencyId, owner),
    async (uow) => {
      await uow.endClients.list(A.agencyId, { limit: 100 });
      read2.open();
      await gate2.wait;
      await insertClient(uow, "serializable-3");
    },
    { isolation: "SERIALIZABLE", maxRetries: 0 },
  );
  await read2.wait;
  await assert.rejects(
    h.app.run(
      h.tenant(A.agencyId, owner),
      async (uow) => {
        await uow.endClients.list(A.agencyId, { limit: 100 });
        gate2.open();
        await u1;
        await insertClient(uow, "serializable-4");
      },
      { isolation: "SERIALIZABLE", maxRetries: 0 },
    ),
    (e: unknown) => failure(e).code === "CAPACITY_UNAVAILABLE" && failure(e).retryable,
  );
});

test("statement_timeout is transaction-local: a lock wait past the ceiling fails that unit of work as CAPACITY_UNAVAILABLE, the holder proceeds, and the connection returns without the setting", async () => {
  const locked = barrier();
  const release = barrier();
  const holder = h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    assert.notEqual(await uow.agencies.lock(A.agencyId), null);
    locked.open();
    await release.wait;
  });
  await locked.wait;
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.agencies.lock(A.agencyId), { statementTimeoutMs: 200 }),
    (e: unknown) => failure(e).code === "CAPACITY_UNAVAILABLE" && failure(e).retryable,
  );
  release.open();
  await holder;
  for (let i = 0; i < 4; i++) {
    const { client } = await h.appPool.acquire();
    try {
      const r = await client.query("SELECT current_setting('statement_timeout') AS t");
      assert.equal(r.rows[0].t, "0", "the timeout died with the transaction");
    } finally {
      client.release();
    }
  }
});

test("work a caller gave up inside a unit of work (a bound elapsed) destroys its connection: the unit answers without waiting for the abandoned call, the backend ends, the abandoned call's next statements fail there, and later requests on the pool are unaffected (D10-GAP-6a)", async () => {
  const locked = barrier();
  const release = barrier();
  const holder = h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    assert.notEqual(await uow.agencies.lock(A.agencyId), null);
    locked.open();
    await release.wait;
  });
  await locked.wait;
  let abandonedPid = 0;
  let late: Promise<unknown> = Promise.resolve();
  const given = h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const client = (uow as unknown as { client: PoolClient }).client;
    abandonedPid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    // the call the caller starts and then gives up: it waits on the holder's lock and, were it ever answered, goes on to read
    late = uow.agencies.lock(A.agencyId).then(() => uow.endClients.countOpenProjects(uow.ids.next() as ClientId));
    late.catch(() => undefined);
    for (let seen = false; !seen; ) {
      await h.oracle.query("SELECT pg_stat_clear_snapshot()");
      seen = (await h.oracle.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [abandonedPid])).rows.length === 1;
    }
    abandonWorkOf(uow, "the bound of the call elapsed");
    throw new DomainFailure("CAPACITY_UNAVAILABLE", "the call did not answer in time", { retryAfterSeconds: 1 }, true);
  });
  given.catch(() => undefined);
  // the answer comes while the holder still holds the lock: nothing queued a ROLLBACK behind the abandoned call
  const answered = await Promise.race([given.then(() => "committed", (e: unknown) => failure(e).code), new Promise<string>((resolve) => setTimeout(() => resolve("still waiting for the abandoned call"), 5_000))]);
  assert.equal(answered, "CAPACITY_UNAVAILABLE");
  await assert.rejects(late, "the abandoned call fails on its destroyed connection, it never reads on a pooled one");
  // ADV-8: the backend of the abandoned unit ends WHILE the holder still holds the lock it waited on (release is not open yet): the abandon
  // cancelled and terminated it, it did not wait for the lock to be granted or for its statement to time out, and its locks went with it
  try {
    const gone = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < gone) {
      await h.oracle.query("SELECT pg_stat_clear_snapshot()");
      alive = (await h.oracle.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [abandonedPid])).rows.length === 1;
      if (alive) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(alive, false, "the abandoned backend is gone from pg_stat_activity before the holder releases its lock");
    assert.equal((await h.oracle.query("SELECT 1 FROM pg_locks WHERE pid = $1", [abandonedPid])).rows.length, 0, "no lock is held or awaited by the abandoned backend");
  } finally {
    release.open();
  }
  await holder;
  for (let i = 0; i < 4; i++) {
    const { client } = await h.appPool.acquire();
    try {
      assert.notEqual(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid), abandonedPid);
    } finally {
      client.release();
    }
  }
  assert.notEqual(await h.app.run(h.tenant(A.agencyId, owner), (uow) => uow.agencies.lock(A.agencyId)), null, "a later request on the pool runs unaffected");
});

test("work that returns normally after the caller gave it up is refused INTEGRITY_FAILURE before COMMIT: nothing is committed and its backend ends (D10-GAP-6a, ADV-12)", async () => {
  const authority = await h.processingAuthority(A);
  const before = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients");
  let abandonedPid = 0;
  let outcome: unknown;
  try {
    outcome = await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
      abandonedPid = Number((await (uow as unknown as { client: PoolClient }).client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const clientId = uow.ids.next() as ClientId;
      await uow.endClients.insert({ clientId, agencyId: A.agencyId, displayName: "Written by abandoned work", processingAuthorityRef: authority, createdByMembershipId: A.ownerMembershipId, createdAt: clock.now() });
      // the write is complete (state and its event, as h.endClient writes it): without the refusal the unit WOULD commit it
      await uow.events.publish({ aggregateKind: "end_client", aggregateId: clientId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "end_client.created.v1", actor: { kind: "USER", userId: owner }, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { clientId, agencyId: A.agencyId, processingAuthorityRef: authority, createdByMembershipId: A.ownerMembershipId } });
      abandonWorkOf(uow, "the bound of the call elapsed");
      return "returned normally";
    });
  } catch (e) {
    outcome = e;
  }
  assert.equal(failure(outcome).code, "INTEGRITY_FAILURE", `an abandoned unit never answers the work's result: ${String(outcome)}`);
  const after = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients");
  assert.equal(after.rows[0].n, before.rows[0].n, "the write of the abandoned unit was never committed");
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients WHERE display_name = 'Written by abandoned work'")).rows[0].n, 0);
  const gone = Date.now() + 5_000;
  let alive = true;
  while (alive && Date.now() < gone) {
    await h.oracle.query("SELECT pg_stat_clear_snapshot()");
    alive = (await h.oracle.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [abandonedPid])).rows.length === 1;
    if (alive) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(alive, false, "the abandoned unit's backend ended (its client was destroyed, never returned to the pool)");
});

test("compare-and-swap writes: a stale expected version applies nothing and returns the current safe version and state; an invisible row is NOT_FOUND", async () => {
  const authority = await h.processingAuthority(A);
  const clientId = await h.endClient(A, authority, "CAS client");
  await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const archived = await uow.endClients.archive(clientId, 1, clock.now());
    assert.equal(archived.kind, "APPLIED");
    if (archived.kind === "APPLIED") {
      assert.equal(archived.record.version, 2);
      assert.equal(archived.record.state, "ARCHIVED");
      assert.ok(archived.record.archivedAt);
    }
    await uow.events.publish({ aggregateKind: "end_client", aggregateId: clientId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "end_client.archived.v1", actor: { kind: "USER", userId: owner }, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { clientId, agencyId: A.agencyId, openProjects: 0 } });
  });
  await h.app.run(h.tenant(A.agencyId, owner), async (uow) => {
    const stale = await uow.endClients.archive(clientId, 1, clock.now());
    assert.deepEqual(stale, { kind: "STALE", currentVersion: 2, currentState: "ARCHIVED" });
    await assert.rejects(uow.endClients.archive(uow.ids.next() as ClientId, 1, clock.now()), (e: unknown) => failure(e).code === "NOT_FOUND");
  });
  const projects = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients WHERE client_id = $1 AND state = 'ARCHIVED' AND version = 2", [clientId]);
  assert.equal(projects.rows[0].n, 1);
});

test("the last active owner cannot be removed through the membership repository: PRECONDITION_FAILED / LAST_OWNER_PROTECTED (R2-043 at the adapter boundary)", async () => {
  const solo = await h.person("solo-uow");
  const ag = await h.createAgency(solo, "Solo Agency");
  await assert.rejects(
    h.app.run(h.tenant(ag.agencyId, solo), async (uow) => {
      await uow.memberships.transition(ag.ownerMembershipId, 1, { state: "REVOKED", revokedAt: clock.now() }, clock.now());
    }),
    (e: unknown) => failure(e).code === "PRECONDITION_FAILED" && failure(e).details.reason === "LAST_OWNER_PROTECTED",
  );
  const still = await h.oracle.query("SELECT state, version FROM kauro.memberships WHERE membership_id = $1", [ag.ownerMembershipId]);
  assert.deepEqual(still.rows[0], { state: "ACTIVE", version: "1" });
  // a second owner makes the removal legitimate; the counter and the events follow
  const second = await h.person("second-owner-uow");
  const secondMembership = await h.addMember(ag, second, "OWNER");
  await h.app.run(h.tenant(ag.agencyId, solo), async (uow) => {
    assert.equal(await uow.memberships.countActiveOwners(ag.agencyId), 2);
    const r = await uow.memberships.transition(ag.ownerMembershipId, 1, { state: "REVOKED", revokedAt: clock.now() }, clock.now());
    assert.equal(r.kind, "APPLIED");
    await uow.events.publish({ aggregateKind: "membership", aggregateId: ag.ownerMembershipId, aggregateVersion: 2, agencyId: ag.agencyId, eventType: "membership.revoked.v1", actor: { kind: "USER", userId: solo }, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { membershipId: ag.ownerMembershipId, agencyId: ag.agencyId, byMembershipId: secondMembership as MembershipId, reasonCode: "OWNER_LEFT" } });
    assert.equal(await uow.memberships.countActiveOwners(ag.agencyId), 1);
  });
  const count = await h.oracle.query("SELECT active_owner_count FROM kauro.agencies WHERE agency_id = $1", [ag.agencyId]);
  assert.equal(count.rows[0].active_owner_count, 1);
});
