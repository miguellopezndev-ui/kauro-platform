// Tenant isolation through the repository adapters on real PostgreSQL 17 (08 "Database isolation": RLS applies visibility
// and writes; a request without valid context fails closed; foreign keys bind tenant and parent identity — a row-level
// filter cannot stop a child from linking to another tenant's parent, the composite key does. 07 "Database representation":
// composite foreign keys prevent a project in one agency from referencing another agency's client. G-TENANT).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isDomainFailure, type CausationId, type ClientId, type DomainFailure, type ProcessingAuthorityId, type ProjectId, type RevisionId, type UserId } from "@kauro/domain";
import { clock, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";

let h: Harness;
let alice: UserId;
let bob: UserId;
let A: AgencyFixture;
let B: AgencyFixture;
let authorityA: ProcessingAuthorityId;
let authorityB: ProcessingAuthorityId;
let clientA: ClientId;
let capability: string;

before(async () => {
  h = await start();
  alice = await h.person("alice-iso");
  bob = await h.person("bob-iso");
  A = await h.createAgency(alice, "Agency A");
  B = await h.createAgency(bob, "Agency B");
  authorityA = await h.processingAuthority(A);
  authorityB = await h.processingAuthority(B);
  clientA = await h.endClient(A, authorityA, "Shared Label");
  capability = await h.offeredCapability("CLEAN");
});
after(async () => {
  await h.stop();
});

function failure(e: unknown): DomainFailure {
  assert.ok(isDomainFailure(e), `expected a DomainFailure, got ${String(e)}`);
  return e;
}

test("S089/S090-style cross-agency reads: agency B's context finds none of A's rows by id, by lock, by list or by hash; the oracle sees both", async () => {
  const all = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients");
  assert.equal(all.rows[0].n, 1);
  await h.app.run(h.tenant(B.agencyId, bob), async (uow) => {
    assert.equal(await uow.endClients.get(clientA), null);
    assert.equal(await uow.endClients.lock(clientA), null);
    assert.equal(await uow.agencies.get(A.agencyId), null);
    assert.equal(await uow.memberships.get(A.ownerMembershipId), null);
    assert.equal(await uow.processingAuthorities.get(authorityA), null);
    assert.deepEqual(await uow.endClients.list(B.agencyId, { limit: 25 }), []);
    // even naming A's agency id in a list call yields nothing: the policy, not the parameter, decides
    assert.deepEqual(await uow.endClients.list(A.agencyId, { limit: 25 }), []);
    assert.equal(await uow.memberships.findLive(A.agencyId, alice), null);
  });
  await h.app.run(h.tenant(A.agencyId, alice), async (uow) => {
    const mine = await uow.endClients.list(A.agencyId, { limit: 25 });
    assert.deepEqual(mine.map((c) => c.clientId), [clientA]);
    const me = await uow.memberships.findLive(A.agencyId, alice);
    assert.equal(me?.role, "OWNER");
  });
});

test("cross-agency writes: a row whose agency_id is not the bound context fails WITH CHECK before any FK; the compare-and-swap of a foreign row is NOT_FOUND", async () => {
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, alice), async (uow) => {
      await uow.endClients.insert({ clientId: uow.ids.next() as ClientId, agencyId: B.agencyId, displayName: "Smuggled", processingAuthorityRef: authorityB, createdByMembershipId: B.ownerMembershipId, createdAt: clock.now() });
    }),
    (e: unknown) => failure(e).code === "NOT_FOUND" && failure(e).details.reason === "TENANT_CONTEXT_MISSING",
  );
  await assert.rejects(
    h.app.run(h.tenant(B.agencyId, bob), (uow) => uow.endClients.archive(clientA, 1, clock.now())),
    (e: unknown) => failure(e).code === "NOT_FOUND",
  );
  const untouched = await h.oracle.query("SELECT state, version FROM kauro.end_clients WHERE client_id = $1", [clientA]);
  assert.deepEqual(untouched.rows[0], { state: "ACTIVE", version: "1" });
  const smuggled = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients WHERE display_name = 'Smuggled'");
  assert.equal(smuggled.rows[0].n, 0);
});

test("composite foreign keys (R2-058/R2-059 as designed): a project of B referencing A's client, and a client of B referencing A's authority, are refused as INVALID_REQUEST / UNKNOWN_REFERENCE even inside B's valid context", async () => {
  await assert.rejects(
    h.app.run(h.tenant(B.agencyId, bob), async (uow) => {
      await uow.projects.insertWithDraftRevision({
        projectId: uow.ids.next() as ProjectId,
        agencyId: B.agencyId,
        clientId: clientA,
        mode: "CLEAN",
        purpose: "Cross-tenant project",
        capabilityId: capability as never,
        capabilityVersion: "R2-INITIAL",
        initialRevisionId: uow.ids.next() as RevisionId,
        createdByMembershipId: B.ownerMembershipId,
        createdAt: clock.now(),
      });
    }),
    (e: unknown) => failure(e).code === "INVALID_REQUEST" && failure(e).details.reason === "UNKNOWN_REFERENCE",
  );
  await assert.rejects(
    h.app.run(h.tenant(B.agencyId, bob), async (uow) => {
      await uow.endClients.insert({ clientId: uow.ids.next() as ClientId, agencyId: B.agencyId, displayName: "Borrowed authority", processingAuthorityRef: authorityA, createdByMembershipId: B.ownerMembershipId, createdAt: clock.now() });
    }),
    (e: unknown) => failure(e).code === "INVALID_REQUEST" && failure(e).details.reason === "UNKNOWN_REFERENCE",
  );
  // and B's own membership cannot be named as the creator of a row in A (the composite key on memberships)
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, alice), async (uow) => {
      await uow.endClients.insert({ clientId: uow.ids.next() as ClientId, agencyId: A.agencyId, displayName: "Foreign creator", processingAuthorityRef: authorityA, createdByMembershipId: B.ownerMembershipId, createdAt: clock.now() });
    }),
    (e: unknown) => failure(e).code === "INVALID_REQUEST" && failure(e).details.reason === "UNKNOWN_REFERENCE",
  );
  const projects = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.projects");
  assert.equal(projects.rows[0].n, 0);
  const clients = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients");
  assert.equal(clients.rows[0].n, 1);
});

test("a valid project pair commits together: project + DRAFT revision, current_revision bound by the deferred key, events for both versions", async () => {
  const created = await h.app.run(h.tenant(A.agencyId, alice), async (uow) => {
    const projectId = uow.ids.next() as ProjectId;
    const revisionId = uow.ids.next() as RevisionId;
    const pair = await uow.projects.insertWithDraftRevision({
      projectId,
      agencyId: A.agencyId,
      clientId: clientA,
      mode: "CLEAN",
      purpose: "Quarterly cleanup",
      capabilityId: capability as never,
      capabilityVersion: "R2-INITIAL",
      initialRevisionId: revisionId,
      createdByMembershipId: A.ownerMembershipId,
      createdAt: clock.now(),
    });
    assert.equal(pair.project.currentRevisionId, revisionId);
    assert.equal(pair.revision.state, "DRAFT");
    assert.equal(pair.project.state, "OPEN");
    assert.ok(!("targetInstanceRef" in pair.project), "CLEAN carries no target reference member");
    const actor = { kind: "USER", userId: alice } as const;
    await uow.events.publish({ aggregateKind: "project", aggregateId: projectId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "project.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { projectId, agencyId: A.agencyId, clientId: clientA, mode: "CLEAN", initialRevisionId: revisionId } });
    await uow.events.publish({ aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "dataset_revision.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { revisionId, agencyId: A.agencyId, projectId, state: "DRAFT" } });
    return pair;
  });
  await h.app.run(h.tenant(A.agencyId, alice), async (uow) => {
    assert.equal(await uow.endClients.countOpenProjects(clientA), 1);
    const revision = await uow.revisions.get(created.revision.revisionId);
    assert.equal(revision?.projectId, created.project.projectId);
    const mode = await uow.capabilities.findMode("CLEAN");
    assert.equal(mode?.state, "AVAILABLE_LIMITED");
    assert.equal(await uow.capabilities.findMode("SALESFORCE"), null);
  });
  await h.app.run(h.tenant(B.agencyId, bob), async (uow) => {
    assert.equal(await uow.projects.get(created.project.projectId), null);
    assert.equal(await uow.revisions.get(created.revision.revisionId), null);
  });
});

test("an IDENTITY context sees its own identity facts, memberships and agencies and nothing else; a member of another agency has no live membership here", async () => {
  const carol = await h.person("carol-iso");
  await h.addMember(A, carol, "VIEWER");
  await h.app.run(h.identity(carol), async (uow) => {
    assert.equal((await uow.identities.getOwn(carol))?.userId, carol);
    assert.equal(await uow.identities.getOwn(alice), null, "another person's identity facts are never visible");
    assert.deepEqual((await uow.memberships.listOwn(carol)).map((m) => [m.agencyId, m.role]), [[A.agencyId, "VIEWER"]]);
    assert.deepEqual(await uow.agencies.listOwnAgencies(carol), [{ agencyId: A.agencyId, displayName: "Agency A", state: "DRAFT" }]);
    assert.equal(await uow.endClients.get(clientA), null, "an identity context is not a tenant context");
  });
  await h.app.run(h.tenant(B.agencyId, bob), async (uow) => {
    assert.equal(await uow.memberships.findLive(B.agencyId, carol), null);
  });
  const unverified = await h.person("dave-unverified", false);
  await h.app.run(h.identity(unverified), async (uow) => {
    const facts = await uow.identities.getOwn(unverified);
    assert.deepEqual(facts, { userId: unverified, state: "ACTIVE", emailVerifiedAt: null, mfaEnrolledAt: null });
  });
});

test("the control plane (kauro_control) has no policy on tenant aggregates: a SYSTEM context reads no agency, membership or client and cannot write one", async () => {
  // each refusal (42501: no policy for kauro_control) aborts its transaction, so every probe is its own unit of work
  const refused = (e: unknown): boolean => failure(e).code === "NOT_FOUND" && failure(e).details.reason === "TENANT_CONTEXT_MISSING";
  await assert.rejects(h.control.run(h.system(), (uow) => uow.agencies.get(A.agencyId)), refused);
  await assert.rejects(h.control.run(h.system(), (uow) => uow.memberships.findLive(A.agencyId, alice)), refused);
  await assert.rejects(h.control.run(h.system(), (uow) => uow.endClients.get(clientA)), refused);
  await assert.rejects(
    h.control.run(h.system(), (uow) => uow.endClients.insert({ clientId: uow.ids.next() as ClientId, agencyId: A.agencyId, displayName: "From control", processingAuthorityRef: authorityA, createdByMembershipId: A.ownerMembershipId, createdAt: clock.now() })),
    refused,
  );
  // capabilities are the control plane's own table and readable by every runtime role
  await h.control.run(h.system(), async (uow) => {
    const all = await uow.capabilities.list();
    assert.equal(all.length, 1);
    assert.deepEqual(await uow.capabilities.list({ state: "AVAILABLE" }), []);
  });
});

test("keyset pagination inside the tenant: a total ordering by (createdAt, clientId) with a cursor that cannot cross the agency", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(await h.endClient(A, authorityA, `Page ${i}`));
  await h.endClient(B, authorityB, "B only");
  await h.app.run(h.tenant(A.agencyId, alice), async (uow) => {
    const first = await uow.endClients.list(A.agencyId, { limit: 3 });
    assert.equal(first.length, 3);
    const last = first[2]!;
    const second = await uow.endClients.list(A.agencyId, { limit: 3, after: { createdAt: last.createdAt, clientId: last.clientId } });
    const seen = [...first, ...second].map((c) => c.clientId);
    assert.equal(new Set(seen).size, seen.length, "no client appears twice across pages");
    assert.equal(seen.length, 6, "the agency holds the shared-label client plus five paged clients");
    assert.ok(seen.every((id) => id === clientA || ids.includes(id)), "no client of agency B leaks through the cursor");
    await assert.rejects(uow.endClients.list(A.agencyId, { limit: 101 }), (e: unknown) => failure(e).code === "INVALID_REQUEST");
  });
});
