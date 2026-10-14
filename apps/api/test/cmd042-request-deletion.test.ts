// CMD042 RequestDeletion — POST /api/v1/projects/{projectId}/deletion-requests — AGENCY_OWNER_OR_ADMIN with a fresh step-up (package B16,
// lane L3; docs/design/B16-L3-failure-matrix.md; .kauro plan B16-REST-PLAN section 2 "CMD042"). Written before the product (tests first):
// the real route over the real authorizer, journal and PostgreSQL 17 through the runtime login roles; the superuser only reads, except where
// a test says it places a state the writers reach only through another command (the prevention cells place the project DELETION_REQUESTED
// with triggers off, so each guard is proved on its own, independently of the route). The request half only: the DELETION_EXECUTOR
// consumer (object deletion, inventory, receipt) is apps/control/test/b16-deletion-executor.test.ts. The provider fakes are the labelled
// contract fakes of the world (SIMULATED).
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { PoolClient } from "pg";
import { AUTHORITY_TOMBSTONES } from "@kauro/application";
import { barrier, controlOf, controlledClock, publishJob, waitForLockWait, type SqlSession } from "@kauro/persistence/testing";
import { auditIdOf, auditsOfAgency, fundPool, startAudit, subjectOf } from "./audit-support.js";
import { paymentRoutes, paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { endLiveJobs, revisionIdOf, verifyingJob } from "./execution-support.js";
import { reserve, reserved, setSessionLimit } from "./source-support.js";
import { activePerson } from "./team-support.js";
import { SimulatedCrash, call, freshKey, ids, rawEvent, replayTextOf, rootCause, routes, waitForApiLockWait, type Hold, type Person, type Reply } from "./support.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"] });
  await setSessionLimit(pw.w, pw.w.A, 16);
});
after(async () => {
  await pw.stop();
});
afterEach(async () => {
  for (const name of pw.w.holds.armedNames) await pw.w.holds.pass(name).catch(() => undefined);
  await endLiveJobs(pw);
});

// --- the command ------------------------------------------------------------------------------------------------------------------------

const deletionRoute = (projectId: string): string => `/api/v1/projects/${projectId}/deletion-requests`;

interface DeletionView {
  readonly deletionId: string;
  readonly projectId: string;
  readonly state: string;
  readonly reasonCode: string;
  readonly requestedAt: string;
  readonly projectState: string;
  readonly projectVersion: number;
  readonly scope: { readonly revisionIds: ReadonlyArray<string>; readonly retentionIds: ReadonlyArray<string>; readonly packageVersionIds: ReadonlyArray<string> };
  readonly receiptScope: string;
  readonly excludedFromManagedScope: ReadonlyArray<string>;
}

interface RequestOptions {
  readonly key?: string;
  readonly person?: Person;
  readonly agency?: string;
  readonly expectedVersion?: number;
  readonly reasonCode?: string;
  readonly proof?: string;
}

async function projectRow(projectId: string): Promise<{ readonly state: string; readonly version: number }> {
  const r = await pw.w.h.oracle.query<{ state: string; version: string }>("SELECT state, version::text AS version FROM kauro.projects WHERE project_id = $1", [projectId]);
  assert.equal(r.rows.length, 1, "the project exists");
  return { state: r.rows[0]!.state, version: Number(r.rows[0]!.version) };
}

/** CMD042 as `person` (the owner by default), at the project's current version, with a fresh step-up of that person unless told. */
async function requestDeletion(projectId: string, options: RequestOptions = {}): Promise<Reply> {
  const person = options.person ?? pw.w.owner;
  const expectedVersion = options.expectedVersion ?? (await projectRow(projectId)).version;
  const assuranceProofRef = options.proof ?? (await pw.w.stepUp(person));
  return call(pw.w, {
    url: deletionRoute(projectId),
    token: person.token,
    agency: options.agency ?? pw.w.A.agencyId,
    key: options.key ?? freshKey("cmd042"),
    body: { expectedVersion, reasonCode: options.reasonCode ?? "AGENCY_REQUEST", assuranceProofRef },
  });
}

/** `${status} ${code} ${reason}` of any reply, never throwing (an unexpected success or a non-problem body is shown as such). */
function answer(reply: Reply): string {
  if (reply.status < 400) return `${reply.status} SUCCESS ${reply.text.slice(0, 200)}`;
  try {
    const p = reply.json<{ code?: string; reason?: string }>();
    return `${reply.status} ${p.code ?? "?"} ${p.reason ?? "-"}`;
  } catch {
    return `${reply.status} ${reply.text.slice(0, 200)}`;
  }
}

/** The COMPLETED 200 of a deletion request (an assertion failure naming the reply otherwise). */
function requested(reply: Reply): { readonly replayed: boolean; readonly data: DeletionView } {
  assert.equal(reply.status, 200, `CMD042 answered ${answer(reply)}`);
  const body = reply.json<{ kind: string; replayed: boolean; data: DeletionView }>();
  assert.equal(body.kind, "COMPLETED");
  return body;
}

async function reached(hold: Hold, reply: Promise<Reply>, what: string): Promise<void> {
  const first = await Promise.race([hold.reached.then(() => null), reply]);
  if (first !== null) assert.fail(`${what} answered ${answer(first)} before reaching its hold point`);
}

/** The api backend of `reply` is observed blocked on a lock in a statement containing `fragment` (a reply that settles first fails). */
async function waitsOn(reply: Promise<Reply>, fragment: string, what: string): Promise<number> {
  const waiting = waitForApiLockWait(pw.w, fragment);
  waiting.catch(() => undefined);
  const first = await Promise.race([waiting, reply]);
  if (typeof first !== "number") assert.fail(`${what} answered ${answer(first)} without waiting on ${fragment}`);
  return first;
}

// --- fixtures -------------------------------------------------------------------------------------------------------------------------

/** An OPEN project of agency A with its revision sealed recently (its UNPAID record ACTIVE). */
async function sealedProject(): Promise<{ readonly projectId: string; readonly revisionId: string }> {
  const { projectId } = await pw.w.project(pw.w.A, pw.w.clientA);
  const { revisionId } = await pw.w.revision(pw.w.A, projectId, "SEALED", { recent: true });
  return { projectId, revisionId };
}

/** A paid purchase executed to its first package (AVAILABLE): its project holds the UNPAID and the PAID_ORDINARY records. */
async function published(label: string): Promise<{ readonly projectId: string; readonly revisionId: string; readonly packageId: string }> {
  const v = await verifyingJob(pw, label);
  const outcome = await publishJob(pw.w.h, pw.w.A, v.jobId);
  assert.equal(outcome.kind, "PUBLISHED");
  return { projectId: v.sale.projectId, revisionId: await revisionIdOf(pw, v.sale), packageId: v.packageId };
}

/** The superuser places the project DELETION_REQUESTED with triggers off (the state CMD042's COMMIT leaves; a guard reads only it). */
async function placeDeletionRequested(projectId: string): Promise<void> {
  const c = pw.w.h.oracle;
  try {
    await c.query("SET session_replication_role = replica");
    const r = await c.query("UPDATE kauro.projects SET state = 'DELETION_REQUESTED', version = version + 1 WHERE project_id = $1 AND state = 'OPEN'", [projectId]);
    assert.equal(r.rowCount, 1, "the project was OPEN and is placed DELETION_REQUESTED");
  } finally {
    await c.query("RESET session_replication_role");
  }
  assert.equal((await projectRow(projectId)).state, "DELETION_REQUESTED");
}

// --- footprints -----------------------------------------------------------------------------------------------------------------------

async function tableExists(name: string): Promise<boolean> {
  return (await pw.w.h.oracle.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [`kauro.${name}`])).rows[0]?.present === true;
}

interface DeletionRow {
  readonly deletion_id: string;
  readonly project_id: string;
  readonly state: string;
  readonly reason_code: string;
  readonly requested_by_membership_id: string;
  readonly assurance_proof_ref: string;
}

/** The project's deletion requests; null while the table does not exist (the base). */
async function deletionsOf(projectId: string): Promise<ReadonlyArray<DeletionRow> | null> {
  if (!(await tableExists("deletion_requests"))) return null;
  return (
    await pw.w.h.oracle.query<DeletionRow>(
      "SELECT deletion_id::text, project_id::text, state, reason_code, requested_by_membership_id::text, assurance_proof_ref::text FROM kauro.deletion_requests WHERE project_id = $1 ORDER BY requested_at",
      [projectId],
    )
  ).rows;
}

async function recordsOf(projectId: string): Promise<ReadonlyArray<{ readonly retention_id: string; readonly state: string; readonly version: string; readonly class: string }>> {
  return (await pw.w.h.oracle.query<{ retention_id: string; state: string; version: string; class: string }>("SELECT retention_id::text, state, version::text AS version, class FROM kauro.retention_records WHERE project_id = $1 ORDER BY retention_id", [projectId])).rows;
}

async function objectsOf(projectId: string): Promise<string> {
  return JSON.stringify((await pw.w.h.oracle.query("SELECT object_id, state, deletion_requested_at, deleted_at FROM kauro.stored_objects WHERE project_id = $1 ORDER BY object_id", [projectId])).rows);
}

async function journalOf(key: string): Promise<ReadonlyArray<{ readonly state: string; readonly response_status: number | null }>> {
  return (await pw.w.h.oracle.query<{ state: string; response_status: number | null }>("SELECT state, response_status FROM kauro.command_journal WHERE operation = 'CMD042' AND idempotency_key = $1", [key])).rows;
}

interface Footprint {
  readonly project: string;
  readonly deletions: number;
  readonly records: string;
  readonly objects: string;
  readonly events: number;
  readonly committedCmd042: number;
}

async function footprint(projectId: string): Promise<Footprint> {
  const deletions = await deletionsOf(projectId);
  return {
    project: JSON.stringify(await projectRow(projectId)),
    deletions: deletions === null ? -1 : deletions.length,
    records: JSON.stringify(await recordsOf(projectId)),
    objects: await objectsOf(projectId),
    events: await pw.w.count("domain_events", "agency_id = $1 AND aggregate_id = $2", [pw.w.A.agencyId, projectId]),
    committedCmd042: await pw.w.count("command_journal", "operation = 'CMD042' AND agency_id = $1 AND state = 'COMMITTED'", [pw.w.A.agencyId]),
  };
}

async function ownerTx(): Promise<PoolClient> {
  const c = await pw.w.h.appPool.connectUnverified();
  await c.query("BEGIN");
  await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [pw.w.A.agencyId, pw.w.owner.userId]);
  return c as unknown as PoolClient;
}

async function end(c: PoolClient, how: "COMMIT" | "ROLLBACK"): Promise<void> {
  try {
    await c.query(how);
  } finally {
    c.release();
  }
}

/** The RETENTION sweeper's record step for one record at `atMs` on the TEST CLOCK (apps/control sweepers/retention.ts step 1). */
function sweeperExpiry(revisionId: string, retentionId: string, atMs: number, options: { readonly written?: () => void; readonly hold?: Promise<void> } = {}): Promise<string> {
  return pw.w.h.control.runSource(controlOf(pw.w.A.agencyId), async (uow) => {
    await controlledClock(atMs).onServer((uow as unknown as { readonly client: SqlSession }).client);
    if ((await uow.sources.revisions.lock(revisionId as never)) === null) return "NO_REVISION";
    const record = (await uow.sources.retention.recordsFor(revisionId as never)).find((r) => r.retentionId === retentionId);
    if (record === undefined || record.state !== "ACTIVE") return "NOT_ACTIVE";
    if (Date.parse(record.effectiveDeadline) > Date.parse(await uow.serverInstant())) return "NOT_DUE";
    const expired = await uow.sources.retention.expireRecord(record.retentionId, record.version);
    if (expired.kind !== "APPLIED") return expired.kind;
    const context = uow.context as { readonly serviceId: string; readonly correlationId: string };
    await uow.events.publish({
      aggregateKind: "retention_record",
      aggregateId: record.retentionId,
      aggregateVersion: expired.record.version,
      agencyId: pw.w.A.agencyId,
      eventType: "retention_record.expired.v1",
      actor: { kind: "SERVICE", serviceId: context.serviceId },
      causationId: ids.next() as never,
      correlationId: context.correlationId as never,
      payload: { retentionId: record.retentionId, agencyId: pw.w.A.agencyId, projectId: record.projectId, revisionId, retentionClass: record.class },
    } as never);
    options.written?.();
    if (options.hold !== undefined) await options.hold;
    return "EXPIRED";
  });
}

/**
 * The head of the revision row lock (`revisions.lock`): pg_stat_activity truncates a statement at 1024 characters, before the table name of
 * this long column list. The lock order is project, deletion row, revisions, records (the sweeper takes a revision, then its records), so
 * both orders of the expiry race now meet at the revision lock.
 */
const REVISION_LOCK_STATEMENT = "SELECT revision_id, agency_id, project_id";

async function effectiveMsOf(retentionId: string): Promise<number> {
  const r = await pw.w.h.oracle.query<{ ms: string }>("SELECT floor(extract(epoch FROM effective_deadline) * 1000)::bigint::text AS ms FROM kauro.retention_records WHERE retention_id = $1", [retentionId]);
  return Number(r.rows[0]!.ms);
}

// --- OK ----------------------------------------------------------------------------------------------------------------------------------

test("CMD042-OK (request): the OWNER with a fresh step-up requests deletion of a project with a published package — 200 with the project DELETION_REQUESTED at the next version, one REQUESTED deletion request, every retention record of the project DELETING, project.deletion_requested.v1 routed to DELETION_EXECUTOR and AUTHORITY_JOURNAL (tombstone PROJECT_DELETION_REQUESTED) and the CMD042 journal entry in one COMMIT; the request deletes no object and discloses the receipt scope COMPLETE_FOR_MANAGED_SCOPE excluding downloaded copies and CRM imports", async () => {
  const { w } = pw;
  const p = await published("cmd042-ok");
  const before = await projectRow(p.projectId);
  assert.equal(before.state, "OPEN");
  const recordsBefore = await recordsOf(p.projectId);
  assert.deepEqual(recordsBefore.map((r) => [r.class, r.state]).sort(), [["PAID_ORDINARY", "ACTIVE"], ["UNPAID", "ACTIVE"]], "the purchased project holds its UNPAID and PAID_ORDINARY records");
  const objectsBefore = await objectsOf(p.projectId);
  const proof = await w.stepUp(w.owner);
  const key = freshKey("cmd042-ok");

  const done = requested(await requestDeletion(p.projectId, { key, proof }));
  assert.equal(done.replayed, false);
  const x = done.data;
  assert.deepEqual(
    [x.projectId, x.state, x.reasonCode, x.projectState, x.projectVersion, x.receiptScope, [...x.excludedFromManagedScope].sort()],
    [p.projectId, "REQUESTED", "AGENCY_REQUEST", "DELETION_REQUESTED", before.version + 1, "COMPLETE_FOR_MANAGED_SCOPE", ["CUSTOMER_DOWNLOADED_COPIES", "EXTERNAL_CRM_IMPORTS"]],
  );
  // the exact scope is disclosed: the project's revision, both records and the published package
  assert.ok(x.scope.revisionIds.includes(p.revisionId), "the scope names the purchased revision");
  assert.deepEqual([...x.scope.retentionIds].sort(), recordsBefore.map((r) => r.retention_id).sort(), "the scope names every retention record of the project");
  assert.deepEqual([...x.scope.packageVersionIds], [p.packageId], "the scope names the published package");

  // one COMMIT: the project, one deletion request, the records DELETING (each at its next version), the events and the journal entry
  assert.deepEqual(await projectRow(p.projectId), { state: "DELETION_REQUESTED", version: before.version + 1 });
  const rows = await deletionsOf(p.projectId);
  assert.notEqual(rows, null, "migration b16_deletion creates kauro.deletion_requests");
  assert.deepEqual(
    rows!.map((r) => [r.deletion_id, r.state, r.reason_code, r.requested_by_membership_id, r.assurance_proof_ref]),
    [[x.deletionId, "REQUESTED", "AGENCY_REQUEST", w.A.ownerMembershipId, proof]],
  );
  assert.deepEqual(
    (await recordsOf(p.projectId)).map((r) => [r.retention_id, r.state, r.version]),
    recordsBefore.map((r) => [r.retention_id, "DELETING", String(Number(r.version) + 1)]),
    "every record of the project is DELETING at its next version",
  );
  for (const r of recordsBefore) {
    const last = (await w.events("retention_record", r.retention_id)).at(-1);
    assert.deepEqual([last?.type, last?.version], ["retention_record.deleting.v1", Number(r.version) + 1], `record ${r.retention_id} published its DELETING version`);
  }
  const projectEvents = await w.events("project", p.projectId);
  const event = projectEvents.at(-1);
  assert.deepEqual([event?.type, event?.version], ["project.deletion_requested.v1", before.version + 1]);
  assert.deepEqual([...(await w.outbox(event!.eventId))].sort(), ["AUTHORITY_JOURNAL", "DELETION_EXECUTOR"], "routed to the executor and to the restore journal");
  const named = (AUTHORITY_TOMBSTONES as unknown as Readonly<Record<string, { readonly kind: string; readonly state: string } | undefined>>)["project.deletion_requested.v1"];
  assert.deepEqual(named, { kind: "PROJECT_DELETION_REQUESTED", state: "DELETION_REQUESTED" }, "AUTHORITY_TOMBSTONES names the deletion's tombstone");
  assert.deepEqual(await journalOf(key), [{ state: "COMMITTED", response_status: 200 }], "the journal entry of CMD042");
  // the request tombstones authority and deletes nothing itself: every stored object of the project is as it was
  assert.equal(await objectsOf(p.projectId), objectsBefore, "no object is requested for deletion or deleted by the request");
});

// --- DENY ------------------------------------------------------------------------------------------------------------------------------

test("CMD042-DENY: foreign 404, VIEWER 403, no step-up, stale version, already DELETION_REQUESTED; a restored database replaying the journal cannot resurrect", async () => {
  const { w } = pw;
  const p = await sealedProject();
  const version = (await projectRow(p.projectId)).version;
  const before = await footprint(p.projectId);
  const refusals: ReadonlyArray<readonly [string, () => Promise<Reply>, string]> = [
    ["another agency's member", () => requestDeletion(p.projectId, { person: w.stranger, agency: w.B.agencyId }), "404 NOT_FOUND -"],
    ["a VIEWER", () => requestDeletion(p.projectId, { person: w.viewer }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT"],
    ["an OPERATOR", () => requestDeletion(p.projectId, { person: w.operator }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT"],
    ["a stale step-up", async () => requestDeletion(p.projectId, { proof: await w.stepUp(w.owner, "STALE") }), "403 ASSURANCE_REQUIRED STEP_UP_STALE"],
    ["another person's step-up", async () => requestDeletion(p.projectId, { proof: await w.stepUp(w.admin) }), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED"],
    ["a stale version", () => requestDeletion(p.projectId, { expectedVersion: version + 1 }), "409 STALE_VERSION -"],
  ];
  for (const [what, run, expected] of refusals) {
    assert.equal(answer(await run()), expected, what);
    assert.deepEqual(await footprint(p.projectId), before, `${what}: nothing written`);
  }
  // a nonexistent project answers as a foreign one
  assert.equal(answer(await requestDeletion(ids.next(), { expectedVersion: 1 })), "404 NOT_FOUND -", "a nonexistent project");

  // the request commits once; a second one of the project is refused and writes nothing
  const first = requested(await requestDeletion(p.projectId)).data;
  const deleted = await footprint(p.projectId);
  assert.equal(deleted.deletions, 1);
  assert.equal(answer(await requestDeletion(p.projectId)), "409 PRECONDITION_FAILED PROJECT_DELETION_REQUESTED", "already DELETION_REQUESTED");
  assert.deepEqual(await footprint(p.projectId), deleted, "the second request wrote nothing");

  // a restored database replaying the journal cannot resurrect: what a restore replays is the AUTHORITY_JOURNAL tombstone of the
  // request (routed once), and no request session can move the project back to OPEN (the machine has no such edge)
  const event = (await w.events("project", p.projectId)).at(-1);
  assert.equal(event?.type, "project.deletion_requested.v1");
  assert.equal(event?.payload["deletionId"], first.deletionId, "the tombstone's event names the deletion");
  assert.ok((await w.outbox(event!.eventId)).includes("AUTHORITY_JOURNAL"), "the tombstone is routed to the restore journal");
  const forged = await ownerTx();
  let code: unknown = "NONE";
  try {
    await forged.query("UPDATE kauro.projects SET state = 'OPEN', version = version + 1 WHERE project_id = $1", [p.projectId]);
  } catch (e) {
    code = (e as { code?: unknown }).code;
  } finally {
    await end(forged, "ROLLBACK");
  }
  assert.notEqual(code, "NONE", "the request role cannot move a DELETION_REQUESTED project back to OPEN");
  assert.deepEqual(await footprint(p.projectId), deleted, "the project stays DELETION_REQUESTED");
});

// --- prevention (GAP-DEL-P1..P4; P3, the model dispatch, is the control plane's: b16-deletion-executor.test.ts) ---------------------------

test("CMD042-DENY (prevention): after DELETION_REQUESTED an upload reservation is refused PROJECT_DELETION_REQUESTED", async () => {
  const { w } = pw;
  const { projectId, revisionId } = await w.project(w.A, w.clientA);
  const revisionVersion = async () => Number((await w.row<{ version: string }>("dataset_revisions", "revision_id = $1", [revisionId]))!.version);
  await placeDeletionRequested(projectId);
  const uploads = await w.count("upload_sessions", "revision_id = $1", [revisionId]);
  const reply = await reserve(w, revisionId, await revisionVersion(), { person: w.operator });
  assert.equal(answer(reply), "409 PRECONDITION_FAILED PROJECT_DELETION_REQUESTED", "no upload is accepted into a project whose deletion was requested");
  assert.equal(await w.count("upload_sessions", "revision_id = $1", [revisionId]), uploads, "no upload session reserved");
});

test("CMD042-DENY (prevention): after DELETION_REQUESTED a StartAudit is refused PROJECT_DELETION_REQUESTED", async () => {
  const { w } = pw;
  await fundPool({ w, poolId: null });
  const subject = await subjectOf(w);
  await placeDeletionRequested(subject.projectId);
  const audits = (await auditsOfAgency(w)).length;
  const reply = await startAudit(w, subject.revisionId, { targetContractId: subject.contractId });
  if (reply.status < 400) assert.fail(`StartAudit queued audit ${auditIdOf(reply)} of a project whose deletion was requested`);
  assert.equal(answer(reply), "409 PRECONDITION_FAILED PROJECT_DELETION_REQUESTED");
  assert.equal((await auditsOfAgency(w)).length, audits, "no audit queued");
});

test("CMD042-DENY (prevention): after DELETION_REQUESTED a payment order is refused PROJECT_DELETION_REQUESTED", async () => {
  const { w } = pw;
  const quote = await pw.readyQuote("cmd042-prevent-order");
  await placeDeletionRequested(quote.projectId);
  const orders = await w.count("payment_orders", "quote_id = $1", [quote.quoteId]);
  const reply = await call(w, { url: paymentRoutes.createPaymentOrder(quote.quoteId), token: w.billing.token, key: freshKey("cmd042-order"), body: { termsHash: quote.termsHash } });
  assert.equal(answer(reply), "409 PRECONDITION_FAILED PROJECT_DELETION_REQUESTED", "no payment order for a project whose deletion was requested");
  assert.equal(await w.count("payment_orders", "quote_id = $1", [quote.quoteId]), orders, "no payment order written");
});

// --- EXPIRY ----------------------------------------------------------------------------------------------------------------------------

test("RACE (expiry): RETENTION expiring a record of the project during the request, both orders — the request holding the records first: the sweeper's CAS misses and the record stays DELETING; the sweeper first: the request waits at the record lock and takes the listed EXPIRED -> DELETING edge", async () => {
  // order 1: the request holds its writes (before its journal commit); RETENTION, a second past the UNPAID record's effective
  // deadline on the TEST CLOCK, waits behind it; the request commits; the sweeper finds the record DELETING and expires nothing
  {
    const p = await sealedProject();
    const [record] = await recordsOf(p.projectId);
    assert.ok(record !== undefined && record.state === "ACTIVE");
    const atMs = (await effectiveMsOf(record.retention_id)) + 1_000;
    const hold = pw.w.holds.arm("journal.commit");
    const reply = requestDeletion(p.projectId);
    let sweeper: Promise<string> | null = null;
    try {
      await reached(hold, reply, "the deletion request");
      sweeper = sweeperExpiry(p.revisionId, record.retention_id, atMs);
      const waiting = waitForLockWait(pw.w.h.oracle, "kauro-test-control", REVISION_LOCK_STATEMENT);
      waiting.catch(() => undefined);
      const first = await Promise.race([waiting, sweeper]);
      if (typeof first !== "number") assert.fail(`RETENTION settled ${first} without waiting on the request's writes`);
    } finally {
      hold.release();
    }
    requested(await reply);
    const outcome = await sweeper;
    assert.ok(outcome === "NOT_ACTIVE" || outcome === "STALE", `the sweeper expired nothing (${outcome})`);
    const [after] = await recordsOf(p.projectId);
    assert.deepEqual([after?.state, after?.version], ["DELETING", String(Number(record.version) + 1)], "DELETING wins");
    assert.equal((await pw.w.events("retention_record", record.retention_id)).some((e) => e.type === "retention_record.expired.v1"), false);
  }
  // order 2: RETENTION holds the record EXPIRED (written, uncommitted); the request waits at the record lock; RETENTION commits; the
  // request re-reads the record after its lock and takes EXPIRED -> DELETING (0012 lists both edges into DELETING)
  {
    const p = await sealedProject();
    const [record] = await recordsOf(p.projectId);
    assert.ok(record !== undefined && record.state === "ACTIVE");
    const atMs = (await effectiveMsOf(record.retention_id)) + 1_000;
    const gate = barrier();
    const written = barrier();
    const sweeper = sweeperExpiry(p.revisionId, record.retention_id, atMs, { written: written.open, hold: gate.wait });
    let reply: Promise<Reply> | null = null;
    try {
      const first = await Promise.race([written.wait.then(() => null), sweeper]);
      if (first !== null) assert.fail(`RETENTION settled ${first} before holding the record`);
      reply = requestDeletion(p.projectId);
      await waitsOn(reply, REVISION_LOCK_STATEMENT, "the deletion request");
    } finally {
      gate.open();
    }
    assert.equal(await sweeper, "EXPIRED");
    requested(await reply!);
    const [after] = await recordsOf(p.projectId);
    assert.deepEqual([after?.state, after?.version], ["DELETING", String(Number(record.version) + 2)], "EXPIRED -> DELETING");
    const types = (await pw.w.events("retention_record", record.retention_id)).map((e) => e.type).slice(-2);
    assert.deepEqual(types, ["retention_record.expired.v1", "retention_record.deleting.v1"]);
    const expiredAt = await pw.w.row<{ expired_at: Date | null }>("retention_records", "retention_id = $1", [record.retention_id]);
    assert.notEqual(expiredAt?.expired_at ?? null, null, "the expiry instant is kept");
  }
});

// --- CRASH-BEFORE --------------------------------------------------------------------------------------------------------------------

test("RACE (crash before COMMIT): a crash after the project, the deletion request and the records DELETING are written leaves the project OPEN, the records ACTIVE and nothing tombstoned; the same key then requests the deletion once", async () => {
  const p = await sealedProject();
  const before = await footprint(p.projectId);
  const key = freshKey("cmd042-crash-before");
  const proof = await pw.w.stepUp(pw.w.owner);
  pw.w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(answer(await requestDeletion(p.projectId, { key, proof })), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(pw.w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true, "the crash fired at the journal commit");
  assert.deepEqual(await footprint(p.projectId), before, "project, deletion request, records, events and journal rolled back");
  assert.equal((await projectRow(p.projectId)).state, "OPEN");
  assert.deepEqual(await journalOf(key), [], "no journal entry survives the crash");
  const tombstones = await pw.w.count("outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id", "e.aggregate_id = $1 AND o.consumer = 'AUTHORITY_JOURNAL'", [p.projectId]);
  assert.equal(tombstones, 0, "nothing tombstoned");
  const again = requested(await requestDeletion(p.projectId, { key, proof }));
  assert.equal(again.replayed, false, "the same key executes once, afresh");
  assert.equal((await projectRow(p.projectId)).state, "DELETION_REQUESTED");
  assert.equal((await deletionsOf(p.projectId))?.length, 1);
});

// --- CRASH-AFTER (the request's COMMIT) ----------------------------------------------------------------------------------------------

test("RACE (crash after COMMIT): the request's lost answer is recovered by the key; the project is DELETION_REQUESTED once with one deletion request and one tombstone event", async () => {
  const p = await sealedProject();
  const version = (await projectRow(p.projectId)).version;
  const key = freshKey("cmd042-crash-after");
  const proof = await pw.w.stepUp(pw.w.owner);
  pw.w.holds.arm("after.commit", { fail: new SimulatedCrash("after COMMIT") });
  assert.equal(answer(await requestDeletion(p.projectId, { key, proof, expectedVersion: version })), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(pw.w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true, "the answer was lost after COMMIT");
  // committed: the project at the next version, one REQUESTED row, its event, the journal entry
  assert.deepEqual(await projectRow(p.projectId), { state: "DELETION_REQUESTED", version: version + 1 });
  const rows = await deletionsOf(p.projectId);
  assert.deepEqual(rows?.map((r) => r.state), ["REQUESTED"]);
  assert.deepEqual(await journalOf(key), [{ state: "COMMITTED", response_status: 200 }]);
  const after = await footprint(p.projectId);
  const recovered = requested(await requestDeletion(p.projectId, { key, proof, expectedVersion: version }));
  assert.equal(recovered.replayed, true, "the committed answer is recovered by the key");
  assert.deepEqual([recovered.data.deletionId, recovered.data.projectVersion, recovered.data.state], [rows![0]!.deletion_id, version + 1, "REQUESTED"]);
  assert.deepEqual(await footprint(p.projectId), after, "nothing written twice");
  assert.equal((await pw.w.events("project", p.projectId)).filter((e) => e.type === "project.deletion_requested.v1").length, 1);
});

// --- PARTIAL (the request's COMMIT) --------------------------------------------------------------------------------------------------

test("PARTIAL: a fault at the second record's retention_record.deleting.v1, after the project, the deletion request, both records and the first record's event are written, rolls back the whole footprint and the journal entry; the same key then requests the deletion once", async () => {
  const p = await published("cmd042-partial");
  const records = await recordsOf(p.projectId);
  assert.equal(records.length, 2, "the purchased project holds two records");
  const before = await footprint(p.projectId);
  const key = freshKey("cmd042-partial");
  const proof = await pw.w.stepUp(pw.w.owner);
  const o = pw.w.h.oracle;
  // the fault fires at the SECOND deleting event only (a counter in a session-independent sequence): every earlier write stands
  await o.query("CREATE SEQUENCE IF NOT EXISTS public.b16_l3_fault_seq");
  // the fault runs as the request role, which owns no privilege on a fresh sequence: its counter is granted to it (fixture only, dropped below)
  await o.query("GRANT USAGE ON SEQUENCE public.b16_l3_fault_seq TO PUBLIC");
  await o.query(`CREATE OR REPLACE FUNCTION public.b16_l3_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF nextval('public.b16_l3_fault_seq') = 2 THEN RAISE EXCEPTION 'KAURO_FAULT SECOND_DELETING_EVENT' USING ERRCODE = 'KT001'; END IF; RETURN NEW; END $$`);
  await o.query("CREATE TRIGGER b16_l3_fault BEFORE INSERT ON kauro.domain_events FOR EACH ROW WHEN (NEW.event_type = 'retention_record.deleting.v1') EXECUTE FUNCTION public.b16_l3_fault()");
  let faulted: Reply;
  try {
    faulted = await requestDeletion(p.projectId, { key, proof });
  } finally {
    await o.query("DROP TRIGGER IF EXISTS b16_l3_fault ON kauro.domain_events");
    await o.query("DROP FUNCTION IF EXISTS public.b16_l3_fault()");
    await o.query("DROP SEQUENCE IF EXISTS public.b16_l3_fault_seq");
  }
  assert.equal(answer(faulted), "500 INTERNAL_ERROR -");
  assert.equal((rootCause(pw.w.internalErrors.at(-1)?.error) as { readonly code?: unknown } | undefined)?.code, "KT001", "the fault fired at the second record's event INSERT");
  assert.deepEqual(await footprint(p.projectId), before, "the project, the deletion request, both records, every event and the journal rolled back");
  assert.deepEqual(await journalOf(key), [], "no journal entry of the faulted attempt");
  const again = requested(await requestDeletion(p.projectId, { key, proof }));
  assert.equal(again.replayed, false, "the same key executes once, afresh");
  assert.deepEqual((await recordsOf(p.projectId)).map((r) => r.state), ["DELETING", "DELETING"]);
  assert.equal((await deletionsOf(p.projectId))?.length, 1);
  assert.deepEqual(await journalOf(key), [{ state: "COMMITTED", response_status: 200 }]);
});

// --- RETRY -----------------------------------------------------------------------------------------------------------------------------

test("RETRY: an identical replay answers 200 byte for byte and writes nothing; the same key with another reasonCode is 409 IDEMPOTENCY_CONFLICT", async () => {
  const p = await sealedProject();
  const version = (await projectRow(p.projectId)).version;
  const key = freshKey("cmd042-retry");
  const proof = await pw.w.stepUp(pw.w.owner);
  const first = await requestDeletion(p.projectId, { key, proof, expectedVersion: version });
  assert.equal(requested(first).replayed, false);
  const after = await footprint(p.projectId);
  const replay = await requestDeletion(p.projectId, { key, proof, expectedVersion: version });
  assert.equal(replay.status, 200, answer(replay));
  assert.equal(replay.text, replayTextOf(first), "the replay is the first answer byte for byte");
  assert.deepEqual(await footprint(p.projectId), after, "the replay wrote nothing");
  assert.equal(answer(await requestDeletion(p.projectId, { key, proof, expectedVersion: version, reasonCode: "INCIDENT" })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await footprint(p.projectId), after, "the conflicting body wrote nothing");
});

// --- REVOCATION ------------------------------------------------------------------------------------------------------------------------

test("REVOCATION: an ADMIN demoted to VIEWER before the request is refused ROLE_INSUFFICIENT, an ADMIN suspended in flight makes the request wait on the authorizer and is refused MEMBERSHIP_SUSPENDED, and a step-up that goes stale while the request waits at the project's transition lock is refused at the COMMIT ASSURANCE_REQUIRED STEP_UP_STALE; nothing written", async () => {
  const { w } = pw;
  // an ADMIN may request a deletion (AGENCY_OWNER_OR_ADMIN): the control that the refusals below are the revocations'
  const allowed = await activePerson(w, "cmd042-admin-allowed", "ADMIN");
  const control = await sealedProject();
  requested(await requestDeletion(control.projectId, { person: allowed.person }));

  const p = await sealedProject();
  const before = await footprint(p.projectId);

  // demoted, committed first (CMD005 through its route)
  const demoted = await activePerson(w, "cmd042-admin-demoted", "ADMIN");
  const mVersion = Number((await w.row<{ version: string }>("memberships", "membership_id = $1", [demoted.membershipId]))!.version);
  const change = await call(w, { url: routes.changeMembership(demoted.membershipId), token: w.owner.token, body: { assuranceProofRef: await w.stepUp(w.owner), expectedVersion: mVersion, role: "VIEWER" } });
  assert.equal(change.status, 200, change.text);
  assert.equal(answer(await requestDeletion(p.projectId, { person: demoted.person })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual(await footprint(p.projectId), before);

  // suspended in flight: the owner's suspension is written and uncommitted; the admin's request waits on the membership; it commits
  const late = await activePerson(w, "cmd042-admin-late", "ADMIN");
  const lateProof = await w.stepUp(late.person);
  const changer = await ownerTx();
  let how: "COMMIT" | "ROLLBACK" = "ROLLBACK";
  let reply: Promise<Reply> | null = null;
  try {
    const moved = await changer.query<{ version: string }>("UPDATE kauro.memberships SET state = 'SUSPENDED', version = version + 1 WHERE membership_id = $1 RETURNING version::text AS version", [late.membershipId]);
    assert.equal(moved.rowCount, 1);
    await rawEvent(changer, { aggregateKind: "membership", aggregateId: late.membershipId, aggregateVersion: Number(moved.rows[0]!.version), agencyId: w.A.agencyId, eventType: "membership.suspended.v1", actorUserId: w.owner.userId, payload: { membershipId: late.membershipId, agencyId: w.A.agencyId, byMembershipId: w.A.ownerMembershipId } } as never);
    reply = requestDeletion(p.projectId, { person: late.person, proof: lateProof });
    await waitsOn(reply, "await_transition('kauro.memberships'", "the in-flight admin's request");
    how = "COMMIT";
  } finally {
    await end(changer, how);
  }
  assert.equal(answer(await reply!), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  assert.deepEqual(await footprint(p.projectId), before);

  // the step-up goes stale at the COMMIT: a proof issued 15 min - 4 s ago, fresh when the body checks it; the superuser holds the
  // project's SHARED transition half, the request waits at its exclusive half (the state change), the proof expires meanwhile
  const serverMs = async (): Promise<number> => (await w.h.oracle.query<{ t: Date }>("SELECT kauro.server_now() AS t")).rows[0]!.t.getTime();
  const shortLived = await w.h.recordStepUp(w.owner.userId as never, { issuedAt: new Date((await serverMs()) - 15 * 60_000 + 4_000).toISOString() as never });
  const holder = await w.h.pg.connect("postgres");
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock_shared(kauro.transition_key('kauro.projects', $1))", [p.projectId]);
    const closing = requestDeletion(p.projectId, { proof: shortLived });
    await waitsOn(closing, "kauro.projects", "the request at the project's transition lock");
    await new Promise((resolve) => setTimeout(resolve, 4_500)); // the proof's expiry passes while the request waits (a bounded wait, not a poll)
    await holder.query("COMMIT");
    assert.equal(answer(await closing), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "judged again at the COMMIT, the proof is past its expiry");
  } finally {
    await holder.end();
  }
  assert.deepEqual(await footprint(p.projectId), before, "nothing committed: the project OPEN, no deletion request, the records ACTIVE");
});

// --- A-15 ------------------------------------------------------------------------------------------------------------------------------

test("A-15: reasonCode END_OF_SERVICE records the customer's return-or-delete choice in deletion_requests", async () => {
  const p = await sealedProject();
  const x = requested(await requestDeletion(p.projectId, { reasonCode: "END_OF_SERVICE" })).data;
  assert.deepEqual([x.reasonCode, x.state], ["END_OF_SERVICE", "REQUESTED"]);
  const rows = await deletionsOf(p.projectId);
  assert.deepEqual(rows?.map((r) => [r.deletion_id, r.reason_code, r.state]), [[x.deletionId, "END_OF_SERVICE", "REQUESTED"]], "the end-of-service choice is the request's recorded reason");
  const event = (await pw.w.events("project", p.projectId)).at(-1);
  assert.deepEqual([event?.type, event?.payload["reasonCode"]], ["project.deletion_requested.v1", "END_OF_SERVICE"], "the tombstone's event carries the choice to the restore journal");
});

// --- uploads in flight (decision of the coordinator 2026-10-14: live provider sessions end with the project) ----------------------------

test("CMD042-OK (uploads): an upload in flight is cancelled in the request's COMMIT, its provider cancellation requested and its tombstone event published", async () => {
  const { w } = pw;
  const { projectId, revisionId } = await w.project(w.A, w.clientA);
  const version = Number((await w.row<{ version: string }>("dataset_revisions", "revision_id = $1", [revisionId]))!.version);
  const upload = await reserved(w, revisionId, version, { person: w.operator });
  const uploadId = upload.data.upload.uploadId as string;
  const live = await w.row<{ state: string }>("upload_sessions", "upload_id = $1", [uploadId]);
  assert.ok(live !== null && live !== undefined && ["RESERVED", "UPLOADING"].includes(live.state), "the upload is in flight before the request");
  const view = requested(await requestDeletion(projectId)).data;
  const after = await w.row<{ state: string; terminal_reason: string; provider_cancellation_state: string }>("upload_sessions", "upload_id = $1", [uploadId]);
  assert.deepEqual([after?.state, after?.terminal_reason, after?.provider_cancellation_state], ["CANCELLED", "PROJECT_DELETION_REQUESTED", "REQUESTED"], "cancelled by the deletion, the provider session's cancellation requested");
  const event = (await w.events("upload_session", uploadId)).at(-1);
  assert.deepEqual([event?.type, event?.payload["reasonCode"], event?.payload["providerCancellationState"]], ["upload_session.cancelled.v1", "PROJECT_DELETION_REQUESTED", "REQUESTED"]);
  assert.ok((await w.outbox(event!.eventId)).includes("STORAGE_LIFECYCLE"), "the tombstone is routed to the lifecycle that cancels the provider session");
  assert.equal(view.projectState, "DELETION_REQUESTED");
});

// --- revisions (coordinator decision 2026-10-14; R2 registry/state_transitions.json DatasetRevision) -----------------------------------------

/** The superuser places the project's current revision in a state the writers reach only through other commands (triggers off). */
async function placeRevisionState(revisionId: string, state: "INSPECTING" | "READY_TO_SEAL" | "REJECTED"): Promise<void> {
  const c = pw.w.h.oracle;
  const hex = "ab".repeat(32);
  const sets: Record<typeof state, string> = {
    INSPECTING: "state = 'INSPECTING'",
    READY_TO_SEAL: `state = 'READY_TO_SEAL', selection_manifest_id = gen_random_uuid(), selection_hash = '${hex}', inventory_hash = '${hex}', selected_at = now(), evaluation_id = gen_random_uuid(), evaluation_hash = '${hex}', physical_source_rows = 1, logical_source_records = 1, billable_source_units = 1, association_edges = 0`,
    REJECTED: "state = 'REJECTED', rejected_at = now(), terminal_reason = 'TEST_PLACED'",
  };
  try {
    await c.query("SET session_replication_role = replica");
    const r = await c.query(`UPDATE kauro.dataset_revisions SET ${sets[state]} WHERE revision_id = $1`, [revisionId]);
    assert.equal(r.rowCount, 1);
  } finally {
    await c.query("RESET session_replication_role");
  }
}

async function revisionRow(revisionId: string): Promise<{ readonly state: string; readonly version: number; readonly terminal_reason: string | null; readonly cancelled: boolean }> {
  const r = await pw.w.h.oracle.query<{ state: string; version: string; terminal_reason: string | null; cancelled: boolean }>("SELECT state, version::text AS version, terminal_reason, cancelled_at IS NOT NULL AS cancelled FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId]);
  return { state: r.rows[0]!.state, version: Number(r.rows[0]!.version), terminal_reason: r.rows[0]!.terminal_reason, cancelled: r.rows[0]!.cancelled };
}

test("CMD042-OK (revisions): every mutable revision (DRAFT, UPLOADING, INSPECTING, READY_TO_SEAL) is CANCELLED through cancel_revision in the request's COMMIT with its event; SEALED, REJECTED and EXPIRED are left as they are and no event names them", async () => {
  const { w } = pw;
  const mutable: Array<[string, string]> = [];
  for (const state of ["DRAFT", "UPLOADING", "INSPECTING", "READY_TO_SEAL"] as const) {
    const { projectId, revisionId } = await w.project(w.A, w.clientA);
    let uploadId: string | undefined;
    if (state === "UPLOADING") {
      const version = Number((await w.row<{ version: string }>("dataset_revisions", "revision_id = $1", [revisionId]))!.version);
      uploadId = (await reserved(w, revisionId, version, { person: w.operator })).data.upload.uploadId as string;
    } else if (state !== "DRAFT") {
      await placeRevisionState(revisionId, state);
    }
    const previous = (await revisionRow(revisionId)).state;
    assert.equal(previous, state, `placed ${state}`);
    requested(await requestDeletion(projectId));
    const after = await revisionRow(revisionId);
    assert.deepEqual([after.state, after.terminal_reason, after.cancelled], ["CANCELLED", "PROJECT_DELETION_REQUESTED", true], `${state} -> CANCELLED`);
    const event = (await w.events("dataset_revision", revisionId)).at(-1);
    assert.deepEqual([event?.type, event?.payload["previousState"], event?.payload["reasonCode"], event?.payload["successorRevisionId"]], ["dataset_revision.cancelled.v1", state, "PROJECT_DELETION_REQUESTED", undefined]);
    assert.deepEqual(event?.payload["cancelledUploadIds"], uploadId === undefined ? [] : [uploadId]);
    mutable.push([projectId, revisionId]);
  }
  // SEALED, REJECTED and EXPIRED have no edge for a deletion request (a request does not make their deadline "now"): untouched, silent
  const left: Array<[string, string, string]> = [];
  const sealed = await sealedProject();
  left.push([sealed.projectId, sealed.revisionId, "SEALED"]);
  const rejected = await w.project(w.A, w.clientA);
  await placeRevisionState(rejected.revisionId, "REJECTED");
  left.push([rejected.projectId, rejected.revisionId, "REJECTED"]);
  const expired = await w.project(w.A, w.clientA);
  const expiredRevision = await w.revision(w.A, expired.projectId, "EXPIRED", { recent: false });
  left.push([expired.projectId, expiredRevision.revisionId, "EXPIRED"]);
  for (const [projectId, revisionId, state] of left) {
    const before = await revisionRow(revisionId);
    const eventsBefore = (await w.events("dataset_revision", revisionId)).length;
    requested(await requestDeletion(projectId));
    const after = await revisionRow(revisionId);
    assert.deepEqual([after.state, after.version], [state, before.version], `${state} is untouched`);
    assert.equal((await w.events("dataset_revision", revisionId)).length, eventsBefore, `${state}: no event names it`);
  }
});

test("CMD042-DENY (revisions): a request handler cannot take a SEALED or CANCELLED revision to DELETED, nor forge dataset_revision.deleted.v1", async () => {
  const { w } = pw;
  const sealed = await sealedProject();
  const draft = await w.project(w.A, w.clientA);
  for (const id of [sealed.revisionId, draft.revisionId]) {
    const c = await ownerTx();
    try {
      await assert.rejects(c.query("UPDATE kauro.dataset_revisions SET state = 'DELETED', deleted_at = kauro.server_now(), version = version + 1 WHERE revision_id = $1", [id]), /row-level security|permission denied|KA008|KA088|DELETION_EVIDENCE/i);
    } finally {
      await end(c, "ROLLBACK");
    }
  }
  const forger = await ownerTx();
  try {
    await assert.rejects(
      forger.query(
        "INSERT INTO kauro.domain_events (event_id, agency_id, aggregate_kind, aggregate_id, aggregate_version, event_type, actor_kind, actor_id, causation_id, correlation_id, payload) SELECT gen_random_uuid(), $1, 'dataset_revision', $2, (SELECT version FROM kauro.dataset_revisions WHERE revision_id = $2), 'dataset_revision.deleted.v1', 'USER', $3, gen_random_uuid(), gen_random_uuid(), '{}'::jsonb",
        [w.A.agencyId, sealed.revisionId, w.A.ownerUserId],
      ),
      /row-level security|permission denied|violates|duplicate key|KA/i,
    );
  } finally {
    await end(forger, "ROLLBACK");
  }
  assert.equal((await revisionRow(sealed.revisionId)).state, "SEALED");
});
