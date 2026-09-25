// CMD001 CreateAgency — POST /api/v1/agencies — VERIFIED_USER (registry cases CMD001-OK / -DENY / -RACE; design §8; 10
// "POST /agencies creates a draft agency under an authenticated verified identity"; 07 Agency machine initial DRAFT).
// Real HTTP route, real authorizer, real pg adapters on a PostgreSQL 17 cluster this file starts; the superuser oracle
// counts rows across tenants before and after every call ("No unauthorized committed state or external effect").
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgencyView, MembershipView } from "@kauro/application";
import { SimulatedCrash, asProblem, call, completed, freshKey, outcome, rootCause, routes, waitForApiLockWait, world, type World } from "./support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

type View = { agency: AgencyView; membership: MembershipView };

test("OK: a verified identity creates one DRAFT agency and one ACTIVE OWNER membership in one transaction", async () => {
  // the newcomer has never been seen by the platform: the identity row is synced inside the same unit of work (I-ENV-1)
  const newcomer = await w.person("newcomer", { sync: false });
  const agenciesBefore = await w.count("agencies");
  const key = freshKey("cmd001-ok");
  const reply = completed<View>(await call(w, { url: routes.createAgency(), token: newcomer.token, agency: null, key, body: { displayName: "Newcomer Agency" } }), 201);
  assert.equal(reply.version, 1);
  assert.equal(reply.replayed, false);
  const { agency, membership } = reply.data;
  assert.equal(agency.state, "DRAFT");
  assert.equal(agency.version, 1);
  assert.equal(agency.displayName, "Newcomer Agency");
  assert.equal(agency.termsVersion, undefined);
  assert.ok(agency.permittedActions.includes("MANAGE_AGENCY") && agency.permittedActions.includes("APPROVE_PLANS"));
  assert.equal(membership.role, "OWNER");
  assert.equal(membership.state, "ACTIVE");
  assert.equal(membership.version, 1);
  assert.equal(membership.userId, newcomer.userId);
  assert.equal(membership.agencyId, agency.agencyId);
  assert.ok(membership.acceptedAt);

  // oracle: exactly one agency and one membership row, both at version 1; the agency is DRAFT with no agreements, no
  // legal profile and one active owner; nothing activated a contract or billing
  assert.equal(await w.count("agencies"), agenciesBefore + 1);
  const agencyRow = await w.row<{ state: string; version: string; terms_version: string | null; privacy_agreement_version: string | null; legal_profile_ref: string | null; active_owner_count: string; created_by_user_id: string }>("agencies", "agency_id = $1", [agency.agencyId]);
  assert.deepEqual(agencyRow && { state: agencyRow.state, version: agencyRow.version, terms: agencyRow.terms_version, privacy: agencyRow.privacy_agreement_version, legal: agencyRow.legal_profile_ref, owners: agencyRow.active_owner_count, creator: agencyRow.created_by_user_id }, {
    state: "DRAFT",
    version: "1",
    terms: null,
    privacy: null,
    legal: null,
    owners: 1,
    creator: newcomer.userId,
  });
  assert.equal(await w.count("memberships", "agency_id = $1", [agency.agencyId]), 1);
  const membershipRow = await w.row<{ role: string; state: string; version: string; assurance_policy: string }>("memberships", "membership_id = $1", [membership.membershipId]);
  assert.deepEqual(membershipRow && { role: membershipRow.role, state: membershipRow.state, version: membershipRow.version, policy: membershipRow.assurance_policy }, { role: "OWNER", state: "ACTIVE", version: "1", policy: "MFA_REQUIRED" });
  const identity = await w.row<{ state: string; subject_hash: string; email_verified_at: Date | null }>("identities", "user_id = $1", [newcomer.userId]);
  assert.equal(identity?.subject_hash, newcomer.subject.subjectHash);
  assert.ok(identity?.email_verified_at);
  // events and outbox: agency.created.v1 (NOTIFICATIONS) and membership.created.v1, both version 1
  const agencyEvents = await w.events("agency", agency.agencyId);
  assert.deepEqual(agencyEvents.map((e) => [e.version, e.type]), [[1, "agency.created.v1"]]);
  assert.deepEqual(agencyEvents[0]?.payload, { agencyId: agency.agencyId, createdByUserId: newcomer.userId, state: "DRAFT" });
  assert.deepEqual(await w.outbox(agencyEvents[0]!.eventId), ["NOTIFICATIONS"]);
  const membershipEvents = await w.events("membership", membership.membershipId);
  assert.deepEqual(membershipEvents.map((e) => [e.version, e.type]), [[1, "membership.created.v1"]]);
  assert.deepEqual(await w.outbox(membershipEvents[0]!.eventId), []);
  // journal: COMMITTED with the response snapshot and the resource link
  const journal = await w.journal(key);
  assert.equal(journal?.state, "COMMITTED");
  assert.equal(journal?.status, 201);
  assert.equal(journal?.resourceKind, "agency");
  assert.equal(journal?.resourceId, agency.agencyId);
  assert.deepEqual(journal?.body, reply.data);
  // nothing else was activated: the agency stays DRAFT (activation needs the agreements, agencies_activation_requires_agreements)
  // and the transaction wrote exactly the rows counted above — two events, one outbox row, one journal entry
  assert.equal(await w.count("domain_events", "correlation_id = (SELECT correlation_id FROM kauro.command_journal WHERE idempotency_key = $1)", [key]), 2);
  assert.equal(await w.count("outbox_records", "event_id IN (SELECT event_id FROM kauro.domain_events WHERE correlation_id = (SELECT correlation_id FROM kauro.command_journal WHERE idempotency_key = $1))", [key]), 1);
});

test("DENY: unverified identity → 403 NOT_AUTHORIZED IDENTITY_UNVERIFIED; unauthenticated → 401; a second DRAFT for the same creator → 429 ADMISSION_LIMITED DRAFT_AGENCY_EXISTS", async () => {
  const agenciesBefore = await w.count("agencies");
  const denialsBefore = (await w.securityEvents("CMD001")).length;
  const journalBefore = await w.count("command_journal");

  const unverifiedKey = freshKey("cmd001-unverified");
  const unverified = await call(w, { url: routes.createAgency(), token: w.unverified.token, agency: null, key: unverifiedKey, body: { displayName: "No MFA Co" } });
  assert.equal(outcome(w, unverified), "403 NOT_AUTHORIZED IDENTITY_UNVERIFIED");
  assert.equal(asProblem(w, unverified).retryable, false);

  const anonymousKey = freshKey("cmd001-anonymous");
  const anonymous = await call(w, { url: routes.createAgency(), token: null, agency: null, key: anonymousKey, body: { displayName: "Anonymous Co" } });
  assert.equal(outcome(w, anonymous), "401 AUTHENTICATION_REQUIRED -");
  assert.deepEqual(asProblem(w, anonymous).nextActions, [{ action: "REAUTHENTICATE" }]);
  const badToken = await call(w, { url: routes.createAgency(), token: "unknown-token-0123456789", agency: null, body: { displayName: "Anonymous Co" } });
  assert.equal(badToken.status, 401);

  // the owner of agency A holds a DRAFT agency: the structural limit (agencies_one_draft_per_creator) answers
  const secondKey = freshKey("cmd001-second-draft");
  const second = await call(w, { url: routes.createAgency(), token: w.owner.token, agency: null, key: secondKey, body: { displayName: "Second Draft" } });
  assert.equal(outcome(w, second), "429 ADMISSION_LIMITED DRAFT_AGENCY_EXISTS");
  assert.deepEqual(asProblem(w, second).nextActions, [{ action: "RETRY_LATER" }]);

  // oracle: no agency, no membership, no journal row for any denied request; the denial is a durable security fact
  assert.equal(await w.count("agencies"), agenciesBefore);
  assert.equal(await w.count("agencies", "created_by_user_id = $1", [w.owner.userId]), 1);
  assert.equal(await w.count("memberships", "user_id = $1", [w.unverified.userId]), 0);
  for (const key of [unverifiedKey, anonymousKey, secondKey]) assert.equal(await w.journal(key), null, `no journal row for ${key}`);
  assert.equal(await w.count("command_journal"), journalBefore);
  const denials = (await w.securityEvents("CMD001")).slice(denialsBefore);
  // the unverified identity's denial is its own identity-stream fact; each unauthenticated request leaves an anonymous one
  // (no actor, no agency; review record B06-review/A-pipeline-authorization.md, R26)
  assert.deepEqual(denials.map((d) => [d.outcome, d.reason, d.agencyId, d.actorId, d.policyVersion]), [
    ["DENY", "IDENTITY_UNVERIFIED", null, w.unverified.userId, "B06-1"],
    ["DENY", "SUBJECT_UNAUTHENTICATED", null, null, "B06-1"],
    ["DENY", "SUBJECT_UNAUTHENTICATED", null, null, "B06-1"],
  ]);
});

test("RACE: identical retry replays the same agency; same key with another displayName → 409 IDEMPOTENCY_CONFLICT; crash before COMMIT leaves nothing; response lost after COMMIT is recovered by the key", async () => {
  // --- two identical requests in parallel: A reserves the journal row and holds; B waits on the identity index (observed in
  // pg_stat_activity); A commits; B reads the committed entry and replays it. One agency, one journal row, two 201s.
  const racer = await w.person("racer");
  const key = freshKey("cmd001-race");
  const body = { displayName: "Racer Agency" };
  const hold = w.holds.arm("journal.reserved");
  const requestA = call(w, { url: routes.createAgency(), token: racer.token, agency: null, key, body });
  await hold.reached;
  const requestB = call(w, { url: routes.createAgency(), token: racer.token, agency: null, key, body });
  await waitForApiLockWait(w, "command_journal");
  hold.release();
  const [a, b] = await Promise.all([requestA, requestB]);
  const first = completed<View>(a, 201);
  const second = completed<View>(b, 201);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.data, first.data, "the duplicate receives the same durable result");
  assert.equal(await w.count("agencies", "created_by_user_id = $1", [racer.userId]), 1);
  assert.equal(await w.count("command_journal", "idempotency_key = $1", [key]), 1);
  assert.equal(await w.count("domain_events", "aggregate_id = $1", [first.data.agency.agencyId]), 1);

  // --- the same key with another body is a typed conflict with no effect (S052)
  const conflict = await call(w, { url: routes.createAgency(), token: racer.token, agency: null, key, body: { displayName: "Racer Agency (edited)" } });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("agencies", "created_by_user_id = $1", [racer.userId]), 1);
  // a sequential identical retry replays as well
  const again = completed<View>(await call(w, { url: routes.createAgency(), token: racer.token, agency: null, key, body }), 201);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.data, first.data);

  // --- crash before COMMIT: the process dies after the agency, membership and events were written and before the journal
  // entry is completed; the transaction rolls back and the oracle finds nothing (journal, rows, events, outbox are one unit)
  const crasher = await w.person("crasher");
  const crashKey = freshKey("cmd001-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await call(w, { url: routes.createAgency(), token: crasher.token, agency: null, key: crashKey, body: { displayName: "Crasher Agency" } });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(asProblem(w, crashed).retryable, true);
  assert.deepEqual(asProblem(w, crashed).nextActions, [{ action: "RETRY_SAME_KEY" }]);
  assert.ok(!crashed.text.includes("simulated"), "the message stays server-side");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true, "the sink received the classified failure with the crash as its cause");
  assert.equal(await w.count("agencies", "created_by_user_id = $1", [crasher.userId]), 0);
  assert.equal(await w.count("memberships", "user_id = $1", [crasher.userId]), 0);
  assert.equal(await w.journal(crashKey), null);
  assert.equal(await w.count("domain_events", "actor_id = $1", [crasher.userId]), 0);
  // the retry with the same key is the first request of that key and creates the agency
  const retried = completed<View>(await call(w, { url: routes.createAgency(), token: crasher.token, agency: null, key: crashKey, body: { displayName: "Crasher Agency" } }), 201);
  assert.equal(retried.replayed, false);
  assert.equal(await w.count("agencies", "created_by_user_id = $1", [crasher.userId]), 1);

  // --- response lost after COMMIT: the transaction committed, the client never received the 201; the retry with the same
  // key recovers the journaled result instead of creating a second tenant (10 "Idempotency contract")
  const loser = await w.person("lost-response");
  const lostKey = freshKey("cmd001-lost");
  w.holds.arm("after.commit", { fail: new SimulatedCrash("after COMMIT") });
  const lost = await call(w, { url: routes.createAgency(), token: loser.token, agency: null, key: lostKey, body: { displayName: "Lost Response Agency" } });
  assert.equal(lost.status, 500);
  const journaled = await w.journal(lostKey);
  assert.equal(journaled?.state, "COMMITTED");
  assert.equal(await w.count("agencies", "created_by_user_id = $1", [loser.userId]), 1);
  const recovered = completed<View>(await call(w, { url: routes.createAgency(), token: loser.token, agency: null, key: lostKey, body: { displayName: "Lost Response Agency" } }), 201);
  assert.equal(recovered.replayed, true);
  assert.deepEqual(recovered.data, journaled?.body);
  assert.equal(await w.count("agencies", "created_by_user_id = $1", [loser.userId]), 1);
});
