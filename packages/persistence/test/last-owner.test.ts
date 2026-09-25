// R2-043 "Concurrent final-owner removal": two owners each remove the other while reading two active owners. Expected:
// serialize the invariant so at least one valid owner remains, or use explicit closure authority (07 "Agency and membership
// states"; 21 "Concurrency and crash matrix": last-owner removal with a preserved deterministic interleaving).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";
import { agency, bind, event, member, person, sqlState, tx, type AgencyFixture, type Person } from "./support.js";

let pg: TemporaryPostgres;
let app: Client;
let oracle: Client;

before(async () => {
  pg = await startTemporaryPostgres();
  app = await pg.connect("kauro_app_test");
  oracle = await pg.connect("postgres");
});
after(async () => {
  await app.end();
  await oracle.end();
  await pg.stop();
});

async function revoke(c: Client, ag: AgencyFixture, actor: Person, membershipId: string, expectedVersion: number): Promise<void> {
  const r = await c.query(
    "UPDATE kauro.memberships SET state = 'REVOKED', revoked_at = now(), version = version + 1 WHERE membership_id = $1 AND version = $2 RETURNING version",
    [membershipId, expectedVersion],
  );
  assert.equal(r.rowCount, 1);
  await event(c, { aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: r.rows[0].version, agencyId: ag.agencyId, eventType: "membership.revoked.v1", actorUserId: actor.userId, payload: { membershipId, agencyId: ag.agencyId, reasonCode: "TEAM_CHANGE" } });
}

async function waitForLockWait(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await oracle.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}

test("two owners removing each other: one transition commits, the other is refused with LAST_OWNER (KA001); one owner remains", async () => {
  const alice = await person(app, "alice-race");
  const bob = await person(app, "bob-race");
  const ag = await agency(app, alice, "Race Agency");
  const bobMembership = await member(app, ag, bob, "OWNER");
  const c1 = await pg.connect("kauro_app_test");
  const c2 = await pg.connect("kauro_app_test");
  try {
    const pid2 = (await c2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await c1.query("BEGIN");
    await c2.query("BEGIN");
    await bind(c1, { agencyId: ag.agencyId, userId: alice.userId });
    await bind(c2, { agencyId: ag.agencyId, userId: bob.userId });
    // both read two active owners (the stale read of the scenario)
    for (const c of [c1, c2]) {
      const n = await c.query("SELECT count(*)::int AS n FROM kauro.memberships WHERE role = 'OWNER' AND state = 'ACTIVE'");
      assert.equal(n.rows[0].n, 2);
    }
    // T1 (alice) revokes bob: the owner-count trigger takes the agency row lock and sees one owner remaining
    await revoke(c1, ag, alice, bobMembership, 1);
    // T2 (bob) revokes alice: blocks on the agency row lock held by T1
    const t2 = revoke(c2, ag, bob, ag.ownerMembershipId, 1);
    await waitForLockWait(pid2);
    await c1.query("COMMIT");
    await assert.rejects(t2, (e: unknown) => sqlState(e) === "KA001");
    await c2.query("ROLLBACK");
  } finally {
    await c1.end();
    await c2.end();
  }
  const owners = await oracle.query("SELECT membership_id, state FROM kauro.memberships WHERE agency_id = $1 AND role = 'OWNER' ORDER BY created_at", [ag.agencyId]);
  assert.deepEqual(owners.rows, [
    { membership_id: ag.ownerMembershipId, state: "ACTIVE" },
    { membership_id: bobMembership, state: "REVOKED" },
  ]);
  const count = await oracle.query("SELECT active_owner_count FROM kauro.agencies WHERE agency_id = $1", [ag.agencyId]);
  assert.equal(count.rows[0].active_owner_count, 1);
  const events = await oracle.query("SELECT event_type FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY sequence", [bobMembership]);
  assert.deepEqual(events.rows.map((e) => e.event_type), ["membership.created.v1", "membership.revoked.v1"]);
});

test("the sole owner cannot revoke themselves; a non-owner can be revoked; closure authority permits the removal", async () => {
  const dana = await person(app, "dana-solo");
  const eve = await person(app, "eve-viewer");
  const ag = await agency(app, dana, "Solo Agency");
  const eveMembership = await member(app, ag, eve, "VIEWER");
  await assert.rejects(
    tx(app, { agencyId: ag.agencyId, userId: dana.userId }, (c) => revoke(c, ag, dana, ag.ownerMembershipId, 1)),
    (e: unknown) => sqlState(e) === "KA001",
  );
  const still = await oracle.query("SELECT state, version FROM kauro.memberships WHERE membership_id = $1", [ag.ownerMembershipId]);
  assert.deepEqual(still.rows[0], { state: "ACTIVE", version: "1" });
  await tx(app, { agencyId: ag.agencyId, userId: dana.userId }, (c) => revoke(c, ag, dana, eveMembership, 1));
  // explicit closure authority (CMD043 territory): DRAFT -> CLOSING is a listed edge; then the last owner may leave
  await tx(app, { agencyId: ag.agencyId, userId: dana.userId }, async (c) => {
    await c.query("UPDATE kauro.agencies SET state = 'CLOSING', version = 2 WHERE agency_id = $1", [ag.agencyId]);
    await event(c, { aggregateKind: "agency", aggregateId: ag.agencyId, aggregateVersion: 2, agencyId: ag.agencyId, eventType: "agency.closing.v1", actorUserId: dana.userId, payload: { agencyId: ag.agencyId } });
    await revoke(c, ag, dana, ag.ownerMembershipId, 1);
  });
  const closed = await oracle.query("SELECT active_owner_count, state FROM kauro.agencies WHERE agency_id = $1", [ag.agencyId]);
  assert.deepEqual(closed.rows[0], { active_owner_count: 0, state: "CLOSING" });
});

test("a suspension of the last owner is refused the same way (the invariant covers every listed edge)", async () => {
  const frank = await person(app, "frank-suspend");
  const ag = await agency(app, frank, "Suspend Agency");
  await assert.rejects(
    tx(app, { agencyId: ag.agencyId, userId: frank.userId }, async (c) => {
      await c.query("UPDATE kauro.memberships SET state = 'SUSPENDED', version = 2 WHERE membership_id = $1", [ag.ownerMembershipId]);
    }),
    (e: unknown) => sqlState(e) === "KA001",
  );
});
