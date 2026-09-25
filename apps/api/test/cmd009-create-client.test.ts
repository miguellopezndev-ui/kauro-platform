// CMD009 CreateClient — POST /api/v1/agencies/{agencyId}/clients — AGENCY_OPERATOR (registry cases CMD009-OK / -DENY /
// -RACE; design §8; 10 "POST /agencies/{agencyId}/clients creates a scoped client workspace"; catalogue: "Create one scoped
// workspace with stable identity separate from its display name. Duplicate labels are not merged by inference; a foreign
// authority reference rejects"). Real route, real authorizer, real pg adapters, superuser oracle.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { EndClientView } from "@kauro/application";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, rootCause, routes, sortedFacts, waitForApiLockWait, world, type World } from "./support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

test("OK: an OPERATOR creates a client; two clients may share a label and keep distinct ids", async () => {
  const url = routes.createClient(w.A.agencyId);
  const key = freshKey("cmd009-ok");
  const body = { displayName: "Same Label", processingAuthorityRef: w.authorityA };
  const first = completed<EndClientView>(await call(w, { url, token: w.operator.token, agency: null, key, body }), 201);
  assert.equal(first.version, 1);
  assert.equal(first.replayed, false);
  assert.equal(first.data.state, "ACTIVE");
  assert.equal(first.data.version, 1);
  assert.equal(first.data.agencyId, w.A.agencyId);
  assert.equal(first.data.displayName, "Same Label");
  assert.equal(first.data.processingAuthorityRef, w.authorityA);
  assert.equal(first.data.archivedAt, undefined);
  // the second client with the same label is another workspace with its own stable identity
  const second = completed<EndClientView>(await call(w, { url, token: w.operator.token, agency: null, key: freshKey("cmd009-ok-2"), body }), 201);
  assert.notEqual(second.data.clientId, first.data.clientId);
  assert.equal(second.data.displayName, first.data.displayName);
  // oracle: rows under the agency of the path, one event each, journal COMMITTED with the resource link
  const row = await w.row<{ agency_id: string; state: string; version: string; created_by_membership_id: string; processing_authority_ref: string }>("end_clients", "client_id = $1", [first.data.clientId]);
  assert.deepEqual(row && { agency: row.agency_id, state: row.state, version: row.version, by: row.created_by_membership_id, authority: row.processing_authority_ref }, {
    agency: w.A.agencyId,
    state: "ACTIVE",
    version: "1",
    by: w.memberships.operator,
    authority: w.authorityA,
  });
  assert.equal(await w.count("end_clients", "agency_id = $1 AND display_name = $2", [w.A.agencyId, "Same Label"]), 2);
  const events = await w.events("end_client", first.data.clientId);
  assert.deepEqual(events.map((e) => [e.version, e.type]), [[1, "end_client.created.v1"]]);
  assert.deepEqual(events[0]?.payload, { clientId: first.data.clientId, agencyId: w.A.agencyId, processingAuthorityRef: w.authorityA, createdByMembershipId: w.memberships.operator });
  assert.deepEqual(await w.outbox(events[0]!.eventId), []);
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 201, kind: "end_client", id: first.data.clientId });
  assert.deepEqual(journal?.body, first.data);
});

test("OK (deployment path): CreateClient records the end-client processing authority in its own unit of work — an agency created through the route creates its first client with nothing recorded beforehand; its reference binds a second workspace; another agency cannot record or use it", async () => {
  // Catalogue CMD009 precondition "Active agency membership permits client creation and records the end-client processing
  // authority"; playbook FLOW01 step 1 "Add the end-client workspace with its processing authority"; failure "a foreign
  // authority reference rejects". Review finding R22: no fixture writes a processing authority here — the product path alone
  // (CreateAgency, then CreateClient) must be able to create a client, as a deployment of this edition must.
  const founder = await w.person("r22-founder");
  const agency = completed<{ agency: { agencyId: string }; membership: { membershipId: string } }>(await call(w, { url: routes.createAgency(), token: founder.token, agency: null, body: { displayName: "Founded Agency" } }), 201).data;
  const agencyId = agency.agency.agencyId;
  const evidenceRef = ids.next();
  assert.equal(await w.count("processing_authorities", "processing_authority_id = $1", [evidenceRef]), 0, "nothing recorded the reference beforehand");
  const url = routes.createClient(agencyId);

  // a crash before COMMIT records nothing: neither the authority nor the client
  const crashKey = freshKey("cmd009-r22-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(outcome(w, await call(w, { url, token: founder.token, agency: null, key: crashKey, body: { displayName: "Crashed Workspace", processingAuthorityRef: evidenceRef } })), "500 INTERNAL_ERROR -");
  assert.equal(await w.count("processing_authorities", "processing_authority_id = $1", [evidenceRef]), 0);
  assert.equal(await w.count("end_clients", "agency_id = $1", [agencyId]), 0);

  const key = freshKey("cmd009-r22");
  const created = completed<EndClientView>(await call(w, { url, token: founder.token, agency: null, key, body: { displayName: "First Workspace", processingAuthorityRef: evidenceRef } }), 201);
  assert.equal(created.data.processingAuthorityRef, evidenceRef);
  // oracle: the authority is recorded for this agency by the member who created the client, in the same transaction as the
  // client that binds it (the composite key (agency_id, processing_authority_ref) holds)
  const authority = await w.row<{ agency_id: string; recorded_by_membership_id: string; recorded_at: Date }>("processing_authorities", "processing_authority_id = $1", [evidenceRef]);
  assert.deepEqual(authority && { agency: authority.agency_id, by: authority.recorded_by_membership_id }, { agency: agencyId, by: agency.membership.membershipId });
  assert.equal(authority?.recorded_at.toISOString(), created.data.createdAt);
  const client = await w.row<{ agency_id: string; processing_authority_ref: string }>("end_clients", "client_id = $1", [created.data.clientId]);
  assert.deepEqual(client && { agency: client.agency_id, authority: client.processing_authority_ref }, { agency: agencyId, authority: evidenceRef });
  assert.deepEqual((await w.events("end_client", created.data.clientId))[0]?.payload, { clientId: created.data.clientId, agencyId, processingAuthorityRef: evidenceRef, createdByMembershipId: agency.membership.membershipId });
  assert.equal((await w.journal(key))?.status, 201);

  // the same agency binds the same recorded authority to another workspace: one authority record, two clients
  const second = completed<EndClientView>(await call(w, { url, token: founder.token, agency: null, body: { displayName: "Second Workspace", processingAuthorityRef: evidenceRef } }), 201);
  assert.notEqual(second.data.clientId, created.data.clientId);
  assert.equal(await w.count("processing_authorities", "processing_authority_id = $1", [evidenceRef]), 1);
  assert.equal(await w.count("end_clients", "processing_authority_ref = $1", [evidenceRef]), 2);

  // another agency naming that reference is refused, with the answer an unknown reference gets; nothing is recorded for it
  const clientsOfB = await w.count("end_clients", "agency_id = $1", [w.B.agencyId]);
  const foreign = await call(w, { url: routes.createClient(w.B.agencyId), token: w.stranger.token, agency: null, body: { displayName: "Borrowed Authority", processingAuthorityRef: evidenceRef } });
  assert.equal(outcome(w, foreign), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  assert.deepEqual(asProblem(w, foreign).errors, [{ field: "processingAuthorityRef", code: "UNKNOWN_REFERENCE" }]);
  assert.equal(await w.count("end_clients", "agency_id = $1", [w.B.agencyId]), clientsOfB);
  assert.equal((await w.row<{ agency_id: string }>("processing_authorities", "processing_authority_id = $1", [evidenceRef]))?.agency_id, agencyId);
});

test("DENY: member of another agency → 404; VIEWER → 403 ROLE_INSUFFICIENT; processingAuthorityRef of another agency → 400 UNKNOWN_REFERENCE", async () => {
  const url = routes.createClient(w.A.agencyId);
  const clientsBefore = await w.count("end_clients");
  const journalBefore = await w.count("command_journal");
  const denialsBefore = (await w.securityEvents("CMD009")).length;
  const body = { displayName: "Denied Client", processingAuthorityRef: w.authorityA };

  // the stranger owns agency B and addresses A's path: foreign and nonexistent look alike (D-AUTHZ-4)
  const stranger = await call(w, { url, token: w.stranger.token, agency: null, key: freshKey("cmd009-stranger"), body });
  assert.equal(outcome(w, stranger), "404 NOT_FOUND NOT_A_MEMBER");
  // a suspended member is denied without a cached grant (07 "do not reuse stale cached grants")
  const suspended = await call(w, { url, token: w.suspended.token, agency: null, key: freshKey("cmd009-suspended"), body });
  assert.equal(outcome(w, suspended), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  const viewer = await call(w, { url, token: w.viewer.token, agency: null, key: freshKey("cmd009-viewer"), body });
  assert.equal(outcome(w, viewer), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  for (const person of [w.approver, w.viewer]) {
    const denied = await call(w, { url, token: person.token, agency: null, key: freshKey("cmd009-role"), body });
    assert.equal(outcome(w, denied), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  }
  // an authority record of agency B named from agency A: invisible under A's context → UNKNOWN_REFERENCE, no row
  const foreign = await call(w, { url, token: w.operator.token, agency: null, key: freshKey("cmd009-foreign-authority"), body: { displayName: "Foreign Authority", processingAuthorityRef: w.authorityB } });
  assert.equal(outcome(w, foreign), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  assert.deepEqual(asProblem(w, foreign).errors, [{ field: "processingAuthorityRef", code: "UNKNOWN_REFERENCE" }]);
  // the agency in the path must be the one the caller is a member of; B's path with A's operator is not found either
  const wrongPath = await call(w, { url: routes.createClient(w.B.agencyId), token: w.operator.token, agency: null, key: freshKey("cmd009-wrong-path"), body });
  assert.equal(outcome(w, wrongPath), "404 NOT_FOUND NOT_A_MEMBER");

  // oracle: no end_clients row for any denied call, no journal row, and the denials are durable security facts
  assert.equal(await w.count("end_clients"), clientsBefore);
  assert.equal(await w.count("command_journal"), journalBefore);
  const denials = (await w.securityEvents("CMD009")).slice(denialsBefore);
  assert.deepEqual(
    sortedFacts(denials.map((d) => [d.reason, d.agencyId, d.actorId])),
    sortedFacts([
      ["MEMBERSHIP_SUSPENDED", w.A.agencyId, w.suspended.userId],
      ["ROLE_INSUFFICIENT", w.A.agencyId, w.viewer.userId],
      ["ROLE_INSUFFICIENT", w.A.agencyId, w.approver.userId],
      ["ROLE_INSUFFICIENT", w.A.agencyId, w.viewer.userId],
      // a non-member's probe is a fact of the prober's own identity stream, never of the probed agency's (review R2, R26)
      ["NOT_A_MEMBER", null, w.stranger.userId],
      ["NOT_A_MEMBER", null, w.operator.userId],
    ]),
  );
  assert.ok(denials.every((d) => d.outcome === "DENY" && d.policyVersion === "B06-1" && d.assuranceClass === "SESSION"));

  // the composite foreign key refuses the foreign reference even when the handler is bypassed (07 "Application checks
  // improve messages but cannot be the sole protection"): a direct insert as the runtime role under A's context
  await assert.rejects(
    w.asTenant(w.A, (c) =>
      c.query(
        `INSERT INTO kauro.end_clients (client_id, agency_id, display_name, processing_authority_ref, created_by_membership_id, created_at, updated_at)
         VALUES ($4, $1, 'Bypassed', $2, $3, now(), now())`,
        [w.A.agencyId, w.authorityB, w.A.ownerMembershipId, ids.next()],
      ),
    ),
    (e: unknown) => typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "23503" && (e as { constraint?: string }).constraint === "end_clients_agency_id_processing_authority_ref_fkey",
  );
  assert.equal(await w.count("end_clients"), clientsBefore);
});

test("RACE: identical retry replays; conflicting same key → 409; crash at the commit boundary leaves no client and no event", async () => {
  const url = routes.createClient(w.A.agencyId);
  const key = freshKey("cmd009-race");
  const body = { displayName: "Raced Client", processingAuthorityRef: w.authorityA };
  // A reserves the journal row and holds; B blocks on the identity index; A commits; B replays the committed entry
  const hold = w.holds.arm("journal.reserved");
  const requestA = call(w, { url, token: w.operator.token, agency: null, key, body });
  await hold.reached;
  const requestB = call(w, { url, token: w.operator.token, agency: null, key, body });
  try {
    await waitForApiLockWait(w, "command_journal");
  } finally {
    // a wait that never happens fails the test above; the held request is let go either way, so no transaction outlives it
    hold.release();
  }
  const [a, b] = await Promise.all([requestA, requestB]);
  const first = completed<EndClientView>(a, 201);
  const second = completed<EndClientView>(b, 201);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(await w.count("end_clients", "agency_id = $1 AND display_name = $2", [w.A.agencyId, "Raced Client"]), 1);
  assert.equal(await w.count("command_journal", "idempotency_key = $1", [key]), 1);
  assert.deepEqual((await w.events("end_client", first.data.clientId)).map((e) => e.type), ["end_client.created.v1"]);
  // conflicting same key: a typed conflict, no second workspace
  const conflict = await call(w, { url, token: w.operator.token, agency: null, key, body: { ...body, displayName: "Raced Client 2" } });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("end_clients", "agency_id = $1 AND display_name LIKE $2", [w.A.agencyId, "Raced Client%"]), 1);
  // the same key from another actor is another logical operation (the identity includes the actor), so the owner's request
  // with the operator's key creates a second workspace under its own journal entry
  const other = completed<EndClientView>(await call(w, { url, token: w.owner.token, agency: null, key, body }), 201);
  assert.notEqual(other.data.clientId, first.data.clientId);
  // crash at the commit boundary: the client row and its event were written, the journal was about to be completed
  const crashKey = freshKey("cmd009-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await call(w, { url, token: w.operator.token, agency: null, key: crashKey, body: { displayName: "Crashed Client", processingAuthorityRef: w.authorityA } });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.equal(await w.count("end_clients", "display_name = $1", ["Crashed Client"]), 0);
  assert.equal(await w.journal(crashKey), null);
  assert.equal(await w.count("domain_events", "event_type = 'end_client.created.v1' AND agency_id = $1", [w.A.agencyId]), await w.count("end_clients", "agency_id = $1", [w.A.agencyId]), "events and rows agree");
});
