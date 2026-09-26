// CMD010 ArchiveClient — POST /api/v1/clients/{clientId}/archive — AGENCY_ADMIN (registry cases CMD010-OK / -DENY / -RACE;
// design §8, D-CMD-3; 10 "Archiving a client stops new projects but does not delete active paid work implicitly"; catalogue
// failure "Archiving cannot become an implicit deletion or refund"). Real route, real authorizer, real pg adapters, oracle.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ArchiveClientView, EndClientView, ProjectView } from "@kauro/application";
import { SimulatedCrash, asProblem, call, completed, freshKey, outcome, replayTextOf, rootCause, routes, waitForApiLockWait, world, type World } from "./support.js";
import type { ClientId, ProjectId } from "@kauro/domain";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

async function freshClient(label: string): Promise<ClientId> {
  const created = completed<EndClientView>(await call(w, { url: routes.createClient(w.A.agencyId), agency: null, body: { displayName: label, processingAuthorityRef: w.authorityA } }), 201);
  return created.data.clientId as ClientId;
}

test("OK: an ADMIN archives an ACTIVE client; CreateProject on it is then refused; projects, revisions, approvals and receipts remain", async () => {
  const clientId = await freshClient("Archive Me");
  // active work: a project created through the route, and its plan chain written by the fixtures
  const project = completed<ProjectView>(await call(w, { url: routes.createProject(clientId), token: w.operator.token, body: { mode: "CLEAN", purpose: "Cleanup" } }), 201);
  const plan = await w.approvable(w.A, project.data.projectId as ProjectId, "archive-ok");
  const before = {
    projects: await w.count("projects", "client_id = $1", [clientId]),
    revisions: await w.count("dataset_revisions", "project_id = $1", [project.data.projectId]),
    plans: await w.count("plans", "project_id = $1", [project.data.projectId]),
    receipts: await w.count("validation_receipts", "plan_id = $1", [plan.planId]),
  };
  assert.deepEqual(before, { projects: 1, revisions: 2, plans: 1, receipts: 1 });

  const key = freshKey("cmd010-ok");
  const archived = completed<ArchiveClientView>(await call(w, { url: routes.archiveClient(clientId), token: w.admin.token, key, body: { expectedVersion: 1 } }), 200);
  assert.equal(archived.version, 2);
  assert.equal(archived.replayed, false);
  assert.equal(archived.data.client.state, "ARCHIVED");
  assert.equal(archived.data.client.version, 2);
  assert.ok(archived.data.client.archivedAt);
  assert.deepEqual(archived.data.retainedActiveWork, { openProjects: 1, activeJobs: 0, liveCommercialAuthorizations: 0 });
  assert.deepEqual(Object.keys(archived.data).sort(), ["client", "retainedActiveWork"], "the response names retained work; it has no deletion, refund or rollback member");

  // oracle: the client row moved to ARCHIVED version 2; nothing else changed (no deletion, no refund)
  const row = await w.row<{ state: string; version: string; archived_at: Date | null }>("end_clients", "client_id = $1", [clientId]);
  assert.equal(row?.state, "ARCHIVED");
  assert.equal(row?.version, "2");
  assert.ok(row?.archived_at);
  assert.deepEqual(
    {
      projects: await w.count("projects", "client_id = $1", [clientId]),
      revisions: await w.count("dataset_revisions", "project_id = $1", [project.data.projectId]),
      plans: await w.count("plans", "project_id = $1", [project.data.projectId]),
      receipts: await w.count("validation_receipts", "plan_id = $1", [plan.planId]),
    },
    before,
  );
  assert.equal((await w.row<{ state: string }>("projects", "project_id = $1", [project.data.projectId]))?.state, "OPEN", "the open project is retained, not closed");
  const events = await w.events("end_client", clientId);
  assert.deepEqual(events.map((e) => [e.version, e.type]), [[1, "end_client.created.v1"], [2, "end_client.archived.v1"]]);
  assert.deepEqual(events[1]?.payload, { clientId, agencyId: w.A.agencyId, openProjects: 1, archivedByMembershipId: w.memberships.admin });
  assert.deepEqual(await w.outbox(events[1]!.eventId), []);
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 200, kind: "end_client", id: clientId });

  // new project creation on the archived client is refused with the current safe state; the archive itself is not repeatable
  const refused = await call(w, { url: routes.createProject(clientId), token: w.operator.token, body: { mode: "CLEAN", purpose: "Late" } });
  assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED CLIENT_ARCHIVED");
  assert.deepEqual(asProblem(w, refused).current, { version: 2, state: "ARCHIVED" });
  const again = await call(w, { url: routes.archiveClient(clientId), token: w.admin.token, body: { expectedVersion: 2 } });
  assert.equal(outcome(w, again), "409 PRECONDITION_FAILED CLIENT_ARCHIVED");
  assert.equal(await w.count("projects", "client_id = $1", [clientId]), 1);
});

test("DENY: OPERATOR → 403; foreign client → 404; stale expectedVersion → 409 STALE_VERSION with current", async () => {
  const clientId = await freshClient("Keep Me");
  const denialsBefore = (await w.securityEvents("CMD010")).length;
  const journalBefore = await w.count("command_journal");
  const snapshot = async () => ({
    client: await w.row<{ state: string; version: string; archived_at: Date | null }>("end_clients", "client_id = $1", [clientId]),
    events: await w.count("domain_events", "aggregate_id = $1", [clientId]),
    clients: await w.count("end_clients"),
  });
  const before = await snapshot();

  const operator = await call(w, { url: routes.archiveClient(clientId), token: w.operator.token, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, operator), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  for (const person of [w.approver, w.viewer]) {
    assert.equal(outcome(w, await call(w, { url: routes.archiveClient(clientId), token: person.token, body: { expectedVersion: 1 } })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  }
  // the stranger (owner of B) selects B and names A's client: invisible under B's context; the owner of A selecting B has no membership there
  const foreign = await call(w, { url: routes.archiveClient(clientId), token: w.stranger.token, agency: w.B.agencyId, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, foreign), "404 NOT_FOUND -");
  const wrongSelector = await call(w, { url: routes.archiveClient(clientId), token: w.owner.token, agency: w.B.agencyId, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, wrongSelector), "404 NOT_FOUND NOT_A_MEMBER");
  const ownerOnB = await call(w, { url: routes.archiveClient(w.clientB), token: w.owner.token, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, ownerOnB), "404 NOT_FOUND -");
  // a stale expected version answers the current safe version and state with RELOAD / COMPARE_VERSIONS
  const stale = await call(w, { url: routes.archiveClient(clientId), token: w.admin.token, body: { expectedVersion: 7 } });
  assert.equal(outcome(w, stale), "409 STALE_VERSION -");
  const p = asProblem(w, stale);
  assert.deepEqual(p.current, { version: 1, state: "ACTIVE" });
  assert.deepEqual(p.nextActions.map((n) => n.action), ["RELOAD", "COMPARE_VERSIONS"]);

  // oracle: no state change, no deletion, no journal row; the role denials are durable facts; the archived-at column is null
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.client?.archived_at, null);
  assert.equal(await w.count("command_journal"), journalBefore);
  const denials = (await w.securityEvents("CMD010")).slice(denialsBefore);
  assert.equal(denials.length, 4);
  assert.ok(denials.every((d) => d.outcome === "DENY"));
  assert.deepEqual(denials.filter((d) => d.reason === "ROLE_INSUFFICIENT").map((d) => d.agencyId), [w.A.agencyId, w.A.agencyId, w.A.agencyId]);
  // the owner of A selecting B is no member of B: the fact is the owner's own, never B's (review R2, R26)
  assert.deepEqual(denials.filter((d) => d.reason === "NOT_A_MEMBER").map((d) => [d.agencyId, d.actorId]), [[null, w.owner.userId]]);
  // no deletion request, refund or job is written as a side effect: the tables that store them (package B09 adds refunds and
  // standing refund policies; B06 stores none) hold no row
  const tables = await w.h.oracle.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'kauro' AND (table_name LIKE '%deletion%' OR table_name LIKE '%refund%' OR table_name LIKE '%job%') ORDER BY 1");
  for (const t of tables.rows) {
    const rows = await w.h.oracle.query<{ n: number }>(`SELECT count(*)::int AS n FROM kauro.${t.table_name}`);
    assert.equal(rows.rows[0]?.n, 0, `${t.table_name} holds no row`);
  }
});

test("RACE: two archive calls with the same expectedVersion → one 200, one 409; identical retry replays; the same key with another expectedVersion or another client → 409 IDEMPOTENCY_CONFLICT; a crash before COMMIT leaves the client ACTIVE and the same key then archives it; a response lost after COMMIT is recovered by the key", async () => {
  // registry CMD010-RACE: "Identical retry, conflicting same-key request and crash at the intent/commit boundary of
  // ArchiveClient" → "Preserve one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate
  // authority" (10 "Idempotency contract"; 07 "Transaction discipline": state, event and outbox commit atomically, and a
  // response lost after commit is recovered by the same idempotency identity)
  const clientId = await freshClient("Race Me");
  const keyA = freshKey("cmd010-race-a");
  const keyB = freshKey("cmd010-race-b");
  const bodyA = { expectedVersion: 1 };
  // A locks the client row and holds inside the active-work inspection; B blocks on the row lock (FOR UPDATE, observed in
  // pg_stat_activity); A commits version 2; B reads the row at version 2 and answers STALE_VERSION with the current state
  const hold = w.holds.arm("collaborator");
  const requestA = call(w, { url: routes.archiveClient(clientId), token: w.admin.token, key: keyA, body: bodyA });
  await hold.reached;
  const requestB = call(w, { url: routes.archiveClient(clientId), token: w.owner.token, key: keyB, body: { expectedVersion: 1 } });
  try {
    await waitForApiLockWait(w, "FOR UPDATE");
  } finally {
    // a wait that never happens fails the test above; A is released either way so no transaction outlives the test
    hold.release();
  }
  const [a, b] = await Promise.all([requestA, requestB]);
  const winner = completed<ArchiveClientView>(a, 200);
  assert.equal(winner.data.client.version, 2);
  assert.equal(outcome(w, b), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, b).current, { version: 2, state: "ARCHIVED" });
  // oracle: the ARCHIVED transition happened exactly once, one archived event, one journal row (the loser left none)
  const archiveFacts = async (id: string) => {
    const row = await w.row<{ state: string; version: string }>("end_clients", "client_id = $1", [id]);
    return { row: row && { state: row.state, version: row.version }, events: (await w.events("end_client", id)).map((e) => e.type) };
  };
  const archivedOnce = { row: { state: "ARCHIVED", version: "2" }, events: ["end_client.created.v1", "end_client.archived.v1"] };
  const untouched = { row: { state: "ACTIVE", version: "1" }, events: ["end_client.created.v1"] };
  assert.deepEqual(await archiveFacts(clientId), archivedOnce);
  assert.equal(await w.journal(keyB), null);
  const journalA = await w.journal(keyA);
  assert.deepEqual(journalA && { state: journalA.state, status: journalA.status, id: journalA.resourceId }, { state: "COMMITTED", status: 200, id: clientId });

  // identical retry: the key and body of the winner replay the journaled 200 byte for byte, with no second effect
  const replay = await call(w, { url: routes.archiveClient(clientId), token: w.admin.token, key: keyA, body: bodyA });
  assert.equal(replay.status, 200);
  assert.equal(replay.text, replayTextOf(a));
  // conflicting same-key requests: another expectedVersion (a body member) and another client (a path id) under the key of
  // the winner are typed conflicts with no effect — the key names one logical operation, never a second one
  const otherClient = await freshClient("Race Me Too");
  const otherBody = await call(w, { url: routes.archiveClient(clientId), token: w.admin.token, key: keyA, body: { expectedVersion: 2 } });
  assert.equal(outcome(w, otherBody), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  const otherPath = await call(w, { url: routes.archiveClient(otherClient), token: w.admin.token, key: keyA, body: bodyA });
  assert.equal(outcome(w, otherPath), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await archiveFacts(clientId), archivedOnce);
  assert.deepEqual(await archiveFacts(otherClient), untouched);
  assert.deepEqual(await w.journal(keyA), journalA, "the journal entry of the key is unchanged");

  // crash at the intent/commit boundary, before COMMIT: the intent was reserved, the client row updated and the archived event
  // appended inside the transaction, then the process dies where the journal entry would complete. Nothing is committed: the
  // client is ACTIVE at version 1 with no archived event and no journal row, and the same key is then the first execution of
  // that logical operation (replayed false), which archives the client exactly once
  const crashKey = freshKey("cmd010-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await call(w, { url: routes.archiveClient(otherClient), token: w.admin.token, key: crashKey, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(asProblem(w, crashed).nextActions, [{ action: "RETRY_SAME_KEY" }]);
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  const crashedRow = await w.row<{ state: string; version: string; archived_at: Date | null }>("end_clients", "client_id = $1", [otherClient]);
  assert.deepEqual(crashedRow && { state: crashedRow.state, version: crashedRow.version, archivedAt: crashedRow.archived_at }, { state: "ACTIVE", version: "1", archivedAt: null });
  assert.deepEqual(await archiveFacts(otherClient), untouched);
  assert.equal(await w.journal(crashKey), null);
  const retried = completed<ArchiveClientView>(await call(w, { url: routes.archiveClient(otherClient), token: w.admin.token, key: crashKey, body: { expectedVersion: 1 } }), 200);
  assert.equal(retried.replayed, false);
  assert.deepEqual([retried.data.client.state, retried.data.client.version], ["ARCHIVED", 2]);
  assert.deepEqual(await archiveFacts(otherClient), archivedOnce);

  // crash after COMMIT, before the answer leaves (a lost response): the archive is durable with its journal entry; the retry
  // with the same key answers exactly the journaled 200 (replayed) and performs no second transition or event
  const lostClient = await freshClient("Race Me Lost");
  const lostKey = freshKey("cmd010-lost");
  w.holds.arm("after.commit", { fail: new SimulatedCrash("response lost after COMMIT") });
  const lost = await call(w, { url: routes.archiveClient(lostClient), token: w.admin.token, key: lostKey, body: { expectedVersion: 1 } });
  assert.equal(outcome(w, lost), "500 INTERNAL_ERROR -");
  assert.deepEqual(asProblem(w, lost).nextActions, [{ action: "RETRY_SAME_KEY" }]);
  assert.deepEqual(await archiveFacts(lostClient), archivedOnce);
  const lostJournal = await w.journal(lostKey);
  assert.deepEqual(lostJournal && { state: lostJournal.state, status: lostJournal.status, id: lostJournal.resourceId }, { state: "COMMITTED", status: 200, id: lostClient });
  const recovered = completed<ArchiveClientView>(await call(w, { url: routes.archiveClient(lostClient), token: w.admin.token, key: lostKey, body: { expectedVersion: 1 } }), 200);
  assert.equal(recovered.replayed, true);
  assert.deepEqual(recovered.data, lostJournal?.body);
  assert.deepEqual(await archiveFacts(lostClient), archivedOnce);
});
