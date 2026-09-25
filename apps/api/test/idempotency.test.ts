// S052 at the command level — "One idempotency key carries different payloads. Conflict; identical replay recovers the
// original durable result." (registry S052; 10 "Idempotency contract": the identity includes environment, authenticated
// subject, agency, operation and key; the stored request digest includes every material command field; reusing the key with
// another digest returns IDEMPOTENCY_CONFLICT and performs no new effect; a concurrent duplicate receives the same durable
// final result; a response lost after commit is recovered by the same key; design D-IDEM-1..2, D-JOURNAL-1, D-PORT-2).
//
// Every command of B06 is exercised through its real route over the real journal (kauro.command_journal on PostgreSQL 17).
// "Byte-equal" is literal: the answer of the first execution is the journaled record (D-PORT-2), so a replay differs from it
// only in the `replayed` flag, and both equal the journal row the superuser oracle reads.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ProjectId } from "@kauro/domain";
import {
  SimulatedCrash,
  approvalBodyOf,
  approveThroughRoute,
  asProblem,
  call,
  completed,
  effectCounts,
  freshKey,
  outcome,
  replayTextOf,
  rootCause,
  routes,
  sha,
  waitForApiLockWait,
  world,
  type Call,
  type Reply,
  type World,
} from "./support.js";

let w: World;
let projectId: ProjectId;
before(async () => {
  w = await world();
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

/** One logical operation of a command: its request (key included) and requests that reuse the key with another digest. */
interface Operation {
  readonly command: string;
  readonly status: 200 | 201;
  readonly request: Call;
  /** Same actor, same key, another material field (a body member or a path-bound aggregate id). */
  readonly conflicting: ReadonlyArray<{ readonly what: string; readonly request: Call }>;
}

/** A fresh logical operation of each of the seven B06 commands, on fixtures of its own. */
async function sevenOperations(label: string): Promise<ReadonlyArray<Operation>> {
  const key = (command: string) => freshKey(`${label}-${command}`);
  const founder = await w.person(`${label}-founder`);
  const toArchive = await w.h.endClient(w.A, w.authorityA, `${label} archive`);
  const otherClient = await w.h.endClient(w.A, w.authorityA, `${label} other`);
  const toRevise = await w.approvable(w.A, projectId, `${label}-revise`);
  const toApprove = await w.approvable(w.A, projectId, `${label}-approve`);
  const proof = await w.stepUp(w.approver);
  const toWithdraw = await w.approvable(w.A, projectId, `${label}-withdraw`);
  await approveThroughRoute(w, toWithdraw);
  const patch = (reasonCode: string) => w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode });

  const cmd001: Call = { url: routes.createAgency(), token: founder.token, agency: null, key: key("cmd001"), body: { displayName: `${label} Agency` } };
  const cmd009: Call = { url: routes.createClient(w.A.agencyId), token: w.operator.token, agency: null, key: key("cmd009"), body: { displayName: `${label} client`, processingAuthorityRef: w.authorityA } };
  const cmd010: Call = { url: routes.archiveClient(toArchive), token: w.admin.token, key: key("cmd010"), body: { expectedVersion: 1 } };
  const cmd011: Call = { url: routes.createProject(w.clientA), token: w.operator.token, key: key("cmd011"), body: { mode: "CLEAN", purpose: `${label} project` } };
  const cmd023: Call = { url: routes.revisePlan(toRevise.planId), token: w.operator.token, key: key("cmd023"), body: { expectedVersion: 4, decisionPatchArtifactRef: patch("AGENCY_DECISION") } };
  const cmd025: Call = { url: routes.approvePlan(toApprove.planId), token: w.approver.token, key: key("cmd025"), body: approvalBodyOf(toApprove, proof) };
  const cmd026: Call = { url: routes.withdrawApproval(toWithdraw.planId), token: w.approver.token, key: key("cmd026"), body: { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" } };
  return [
    { command: "CMD001", status: 201, request: cmd001, conflicting: [{ what: "displayName", request: { ...cmd001, body: { displayName: `${label} Agency (edited)` } } }] },
    { command: "CMD009", status: 201, request: cmd009, conflicting: [{ what: "displayName", request: { ...cmd009, body: { displayName: `${label} client (edited)`, processingAuthorityRef: w.authorityA } } }] },
    {
      command: "CMD010",
      status: 200,
      request: cmd010,
      conflicting: [
        { what: "expectedVersion", request: { ...cmd010, body: { expectedVersion: 2 } } },
        { what: "path clientId", request: { ...cmd010, url: routes.archiveClient(otherClient) } },
      ],
    },
    { command: "CMD011", status: 201, request: cmd011, conflicting: [{ what: "purpose", request: { ...cmd011, body: { mode: "CLEAN", purpose: `${label} project (edited)` } } }] },
    { command: "CMD023", status: 201, request: cmd023, conflicting: [{ what: "decisionPatchArtifactRef", request: { ...cmd023, body: { expectedVersion: 4, decisionPatchArtifactRef: patch("OTHER_DECISION") } } }] },
    { command: "CMD025", status: 201, request: cmd025, conflicting: [{ what: "disclosuresHash", request: { ...cmd025, body: { ...approvalBodyOf(toApprove, proof), disclosuresHash: sha(`${label} other disclosures`) } } }] },
    { command: "CMD026", status: 200, request: cmd026, conflicting: [{ what: "reasonCode", request: { ...cmd026, body: { expectedVersion: 5, reasonCode: "CHANGED_MIND" } } }] },
  ];
}

interface JournalEntryParts {
  readonly state: string;
  readonly status: number | null;
  readonly digest: string;
  readonly body: unknown;
  readonly correlationId: string;
}

/** Superuser oracle: the one journal row of an idempotency key, with its digest (never more than one row per key here). */
async function journalOf(key: string): Promise<JournalEntryParts> {
  const r = await w.h.oracle.query<{ state: string; response_status: number | null; request_digest: string; response_body: unknown; correlation_id: string }>(
    "SELECT state, response_status, request_digest, response_body, correlation_id FROM kauro.command_journal WHERE idempotency_key = $1",
    [key],
  );
  assert.equal(r.rows.length, 1, `exactly one journal row for ${key}`);
  const row = r.rows[0]!;
  return { state: row.state, status: row.response_status, digest: row.request_digest, body: row.response_body, correlationId: row.correlation_id };
}

/** The exact bytes of a COMPLETED answer that carries the journaled body `data`. */
function wireOf(reply: Reply, data: unknown, replayed: boolean): string {
  const version = reply.json<{ version: number }>().version;
  return JSON.stringify({ kind: "COMPLETED", version, replayed, data });
}

function keyOf(c: Call): string {
  if (typeof c.key !== "string") throw new Error("an operation carries its idempotency key");
  return c.key;
}

test("same key + different body → 409 IDEMPOTENCY_CONFLICT and no effect", async () => {
  for (const op of await sevenOperations("conflict")) {
    const first = await call(w, op.request);
    assert.equal(first.status, op.status, `${op.command}: ${first.text}`);
    const journaled = await journalOf(keyOf(op.request));
    const counts = await effectCounts(w);
    for (const c of op.conflicting) {
      const conflict = await call(w, c.request);
      assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS", `${op.command} ${c.what}`);
      const problem = asProblem(w, conflict);
      assert.equal(problem.retryable, false);
      assert.deepEqual(problem.nextActions, []);
      assert.equal(problem.current, undefined, "a conflict reveals nothing of the first operation");
      // no effect: no row, event, outbox record, journal row or security fact anywhere; the journal entry keeps the first
      // request's digest and response
      assert.deepEqual(await effectCounts(w), counts, `${op.command} ${c.what}: no effect`);
      assert.deepEqual(await journalOf(keyOf(op.request)), journaled);
    }
    // the first operation is still what the key names: the identical request replays it
    const replay = await call(w, op.request);
    assert.equal(replay.text, replayTextOf(first), op.command);
  }

  // the conflict is scoped by the identity (environment, actor, agency, operation, key): the same key used by the same operator
  // for another operation, or by another actor for the same operation, is another logical operation
  const shared = freshKey("conflict-shared");
  const client = completed<{ clientId: string }>(await call(w, { url: routes.createClient(w.A.agencyId), token: w.operator.token, agency: null, key: shared, body: { displayName: "Shared key client", processingAuthorityRef: w.authorityA } }), 201);
  const project = completed<{ projectId: string }>(await call(w, { url: routes.createProject(client.data.clientId), token: w.operator.token, key: shared, body: { mode: "CLEAN", purpose: "Shared key project" } }), 201);
  assert.equal(project.replayed, false, "another operation under the same key");
  const byOwner = completed<{ clientId: string }>(await call(w, { url: routes.createClient(w.A.agencyId), token: w.owner.token, agency: null, key: shared, body: { displayName: "Shared key client", processingAuthorityRef: w.authorityA } }), 201);
  assert.equal(byOwner.replayed, false, "another actor under the same key");
  assert.notEqual(byOwner.data.clientId, client.data.clientId);
  assert.equal(await w.count("command_journal", "idempotency_key = $1", [shared]), 3);
});

test("same key + same body → 200/201 replayed:true with the original body", async () => {
  for (const op of await sevenOperations("replay")) {
    const first = await call(w, op.request);
    const original = completed<unknown>(first, op.status);
    assert.equal(original.replayed, false, op.command);
    // the first answer is the journaled record itself (D-PORT-2)
    const journaled = await journalOf(keyOf(op.request));
    assert.deepEqual([journaled.state, journaled.status], ["COMMITTED", op.status]);
    assert.equal(first.text, wireOf(first, journaled.body, false), `${op.command}: the first answer carries the journaled bytes`);
    const counts = await effectCounts(w);
    // the identical request (a fresh correlation id, the same key and body) replays: same status, same bytes but the flag
    const replay = await call(w, op.request);
    assert.equal(replay.status, op.status, op.command);
    assert.equal(replay.text, replayTextOf(first), `${op.command}: byte-equal replay`);
    assert.notEqual(replay.headers["x-correlation-id"], first.headers["x-correlation-id"], "each request has its own correlation id");
    assert.deepEqual(await effectCounts(w), counts, `${op.command}: a replay has no effect`);
    assert.deepEqual(await journalOf(keyOf(op.request)), journaled);
  }

  // the replay recovers the ORIGINAL durable result even after the aggregate moved on: an approval replayed after its
  // withdrawal still answers the approval as it was committed (plan APPROVED at version 5), not the current state
  const plan = await w.approvable(w.A, projectId, "replay-after-change");
  const approve: Call = { url: routes.approvePlan(plan.planId), token: w.approver.token, key: freshKey("replay-after-change"), body: approvalBodyOf(plan, await w.stepUp(w.approver)) };
  const first = await call(w, approve);
  assert.equal(completed<{ plan: { state: string } }>(first, 201).data.plan.state, "APPROVED");
  completed(await call(w, { url: routes.withdrawApproval(plan.planId), token: w.approver.token, body: { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" } }), 200);
  assert.equal((await w.row<{ state: string }>("plans", "plan_id = $1", [plan.planId]))?.state, "WITHDRAWN");
  const replay = await call(w, approve);
  assert.equal(replay.text, replayTextOf(first));
});

test("response lost after commit → retry with the same key returns the journaled result", async () => {
  for (const op of await sevenOperations("lost")) {
    // the transaction commits; the process dies before the answer leaves (after.commit): the client receives nothing useful
    w.holds.arm("after.commit", { fail: new SimulatedCrash("response lost after COMMIT") });
    const lost = await call(w, op.request);
    assert.equal(outcome(w, lost), "500 INTERNAL_ERROR -", op.command);
    assert.deepEqual(asProblem(w, lost).nextActions, [{ action: "RETRY_SAME_KEY" }]);
    assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
    // "An unexpected 500 does not automatically mean a command did not commit": the effect and its journal entry are durable
    const journaled = await journalOf(keyOf(op.request));
    assert.deepEqual([journaled.state, journaled.status], ["COMMITTED", op.status], op.command);
    const counts = await effectCounts(w);
    // the retry with the same key recovers the journaled answer byte for byte and performs no second effect
    const recovered = await call(w, op.request);
    assert.equal(recovered.status, op.status, `${op.command}: ${recovered.text}`);
    assert.equal(recovered.text, wireOf(recovered, journaled.body, true), `${op.command}: the recovered answer is the journaled record`);
    assert.deepEqual(await effectCounts(w), counts, `${op.command}: no second effect`);
    // the lost operation cannot be turned into another one under its key
    const c = op.conflicting[0];
    if (c === undefined) throw new Error(`${op.command} names a conflicting request`);
    assert.equal(outcome(w, await call(w, c.request)), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS", op.command);
    assert.deepEqual(await effectCounts(w), counts);
  }
});

test("concurrent duplicate: two in-flight identical requests → exactly one effect and the same durable answer; after the first rolls back, the duplicate proceeds as the first", async () => {
  // A reserves the journal row of the key and holds (its transaction open); B, identical, blocks on the identity index
  // (observed waiting in pg_stat_activity); A commits; B reads the committed row and answers the same durable result
  const plan = await w.approvable(w.A, projectId, "concurrent");
  const request: Call = { url: routes.approvePlan(plan.planId), token: w.approver.token, key: freshKey("concurrent"), body: approvalBodyOf(plan, await w.stepUp(w.approver)) };
  const hold = w.holds.arm("journal.reserved");
  const requestA = call(w, request);
  await hold.reached;
  const requestB = call(w, request);
  try {
    await waitForApiLockWait(w, "command_journal");
  } finally {
    // a wait that never happens fails the test above; the held request is let go either way, so no transaction outlives it
    hold.release();
  }
  const [a, b] = await Promise.all([requestA, requestB]);
  const first = completed<{ approval: { approvalId: string } }>(a, 201);
  assert.equal(first.replayed, false);
  assert.equal(b.status, 201);
  assert.equal(b.text, replayTextOf(a), "the duplicate answers the first execution's durable result, byte for byte");
  // exactly one effect: one approval, one approval.created.v1 (one NOTIFICATIONS outbox row), one plan.approved.v1, one entry
  assert.equal(await w.count("approvals", "plan_id = $1", [plan.planId]), 1);
  const approvalEvents = await w.events("approval", first.data.approval.approvalId);
  assert.deepEqual(approvalEvents.map((e) => e.type), ["approval.created.v1"]);
  assert.deepEqual(await w.outbox(approvalEvents[0]!.eventId), ["NOTIFICATIONS"]);
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'plan.approved.v1'", [plan.planId]), 1);
  const journaled = await journalOf(keyOf(request));
  assert.equal(a.text, wireOf(a, journaled.body, false));
  assert.equal(journaled.correlationId, a.headers["x-correlation-id"], "the entry is the first request's");

  // after a rollback the duplicate proceeds as the first request: A reserves and holds, B blocks on the identity index, A dies
  // where it waits (before COMMIT: nothing of A persists), B's insert proceeds and B performs the one effect
  const second = await w.approvable(w.A, projectId, "concurrent-rollback");
  const retry: Call = { url: routes.approvePlan(second.planId), token: w.approver.token, key: freshKey("concurrent-rollback"), body: approvalBodyOf(second, await w.stepUp(w.approver)) };
  const holdFirst = w.holds.arm("journal.reserved");
  const dying = call(w, retry);
  await holdFirst.reached;
  const duplicate = call(w, retry);
  try {
    await waitForApiLockWait(w, "command_journal");
  } finally {
    // a wait that never happens fails the test above; the held request is let go either way, so no transaction outlives it
    holdFirst.abort(new SimulatedCrash("after the reservation, before COMMIT"));
  }
  const [died, proceeded] = await Promise.all([dying, duplicate]);
  assert.equal(outcome(w, died), "500 INTERNAL_ERROR -");
  const winner = completed<{ approval: { approvalId: string } }>(proceeded, 201);
  assert.equal(winner.replayed, false, "the duplicate is the first execution of the key once the first rolled back");
  assert.equal(await w.count("approvals", "plan_id = $1", [second.planId]), 1);
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'plan.approved.v1'", [second.planId]), 1);
  const entry = await journalOf(keyOf(retry));
  assert.equal(entry.correlationId, proceeded.headers["x-correlation-id"], "the surviving entry belongs to the duplicate");
  assert.equal(proceeded.text, wireOf(proceeded, entry.body, false));
});
