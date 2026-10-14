// The DELETION_EXECUTOR consumer of a requested project deletion (package B16 lane L3; docs/design/B16-L3-failure-matrix.md rows R2;
// manual 09 "Early deletion" and "Deletion receipts"; plan .kauro/mandates/B16-REST-PLAN.md section 2 "CMD042"). Written before the
// product (tests first). One real PostgreSQL 17 cluster through the runtime login roles and the control plane assembled by this
// package's own composition root; outside the platform only the labelled contract fakes of the execution world (SIMULATED, never
// EXECUTED_PROVIDER): B07's ContractFakeObjectStorage (its hold points, scripted faults, retention policies and out-of-band edits are
// the provider's own behaviour) and ContractFakeAuthorityJournal (read here through a second reader over the world's journal file).
//
// The request half: CMD042's route is apps/api's (cmd042-request-deletion.test.ts). Here `requestAsHandler` performs exactly the writes
// CMD042's COMMIT leaves (docs/design/B16-L3-failure-matrix.md "Contract"), as the request handlers' role kauro_app in the owner's
// tenant context, with the events through @kauro/persistence's PgEventPublisher — a fixture of the request side, never a write of the
// control plane. A step-up proof of the owner is recorded first and named by the request (the COMMIT re-judges it). The superuser is
// the oracle only, except where a test says it forges a row (a forged deleted_at, a prevention state).
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { OutboxConsumer } from "@kauro/application";
import { ContractFakeAuthorityJournal } from "@kauro/application/testing";
import { centsOfMicros, type AgencyId, type AuditId, type AuditStepId, type DomainEventRecord, type LeaseOwnerId, type ModelTaskId, type ProcessingJobId, type RequestId } from "@kauro/domain";
import { PgEventPublisher } from "@kauro/persistence";
import { FaultPoints, barrier, crashableFactory, type AgencyFixture } from "@kauro/persistence/testing";
import { openAuditWorld, type AuditWorld } from "./support/audit-world.js";
import { clock, heldUnits, ids, sha, startExecutionWorld, verifiedPrivate, type AuditSubject, type ExecutionWorld, type Purchase } from "./support/execution-world.js";

let w: ExecutionWorld;
let a: AuditWorld;
let journal: ContractFakeAuthorityJournal;
before(async () => {
  w = await startExecutionWorld("b16-deletion");
  a = await openAuditWorld(w);
  // a second reader of the world's journal file (execution-world.ts: <scratch>/authority-journal.jsonl, scratchRoot = <scratch>/workers)
  journal = new ContractFakeAuthorityJournal({ path: join(dirname(w.scratchRoot), "authority-journal.jsonl") });
  await w.plane.sweepers.locationPolicy.sweep(w.plane.units, 10);
});
after(async () => {
  await w.stop();
});
afterEach(async () => {
  await w.quiesce();
});

// --- the consumer and its tables -----------------------------------------------------------------------------------------------------

/** The plane's DELETION_EXECUTOR consumer (composition.ts), looked up by its name among the source and execution consumers. */
function executorOf(plane = w.plane): OutboxConsumer {
  const all = [...Object.values(plane.consumers as unknown as Record<string, OutboxConsumer>), ...Object.values((plane.execution?.consumers ?? {}) as unknown as Record<string, OutboxConsumer>)];
  const found = all.find((c) => (c.consumer as string) === "DELETION_EXECUTOR");
  assert.ok(found !== undefined, "the control plane composes the DELETION_EXECUTOR consumer");
  return found;
}

async function tableExists(name: string): Promise<boolean> {
  return (await w.h.oracle.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [`kauro.${name}`])).rows[0]?.present === true;
}

/** The objects the executor needs: migration b16_deletion's two tables and the consumer itself. */
async function prerequisites(): Promise<OutboxConsumer> {
  assert.equal(await tableExists("deletion_requests"), true, "migration b16_deletion creates kauro.deletion_requests");
  assert.equal(await tableExists("deletion_receipts"), true, "migration b16_deletion creates kauro.deletion_receipts");
  return executorOf();
}

// --- the request half (CMD042's COMMIT, as kauro_app) -------------------------------------------------------------------------------

interface Requested {
  readonly deletionId: string;
  readonly projectVersion: number;
  readonly retentionIds: ReadonlyArray<string>;
}

interface RequestOptions {
  readonly reasonCode?: string;
  /** The request's backend pid, once its connection is open (before any statement of the transaction). */
  readonly started?: (pid: number) => void;
  /** Called when every write is done and the transaction is still open; `hold` then keeps it open. */
  readonly written?: () => void;
  readonly hold?: Promise<void>;
}

/** CMD042's COMMIT for the project of `agency` (see the header): one transaction of kauro_app in the owner's tenant context. */
async function requestAsHandler(agency: AgencyFixture, projectId: string, options: RequestOptions = {}): Promise<Requested> {
  const proof = await w.h.recordStepUp(agency.ownerUserId);
  const c = await w.h.appPool.connectUnverified();
  let destroy: Error | undefined;
  try {
    const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    options.started?.(pid);
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agency.agencyId, agency.ownerUserId]);
    const moved = await c.query<{ version: string }>(
      "UPDATE kauro.projects SET state = 'DELETION_REQUESTED', version = version + 1 WHERE agency_id = $1 AND project_id = $2 AND state = 'OPEN' RETURNING version::text AS version",
      [agency.agencyId, projectId],
    );
    assert.equal(moved.rowCount, 1, "the project was OPEN");
    const projectVersion = Number(moved.rows[0]!.version);
    const deletionId = ids.next();
    const reasonCode = options.reasonCode ?? "AGENCY_REQUEST";
    await c.query(
      `INSERT INTO kauro.deletion_requests (deletion_id, agency_id, project_id, reason_code, requested_by_membership_id, requested_by_user_id, assurance_proof_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [deletionId, agency.agencyId, projectId, reasonCode, agency.ownerMembershipId, agency.ownerUserId, proof],
    );
    const records = await c.query<{ retention_id: string; version: string }>(
      "UPDATE kauro.retention_records SET state = 'DELETING', version = version + 1 WHERE agency_id = $1 AND project_id = $2 AND state IN ('ACTIVE', 'EXPIRED') RETURNING retention_id::text, version::text AS version",
      [agency.agencyId, projectId],
    );
    const events = new PgEventPublisher(c as never, ids, clock);
    const correlationId = ids.next();
    const actor = { kind: "USER", userId: agency.ownerUserId } as const;
    await events.publish({
      aggregateKind: "project",
      aggregateId: projectId,
      aggregateVersion: projectVersion,
      agencyId: agency.agencyId,
      eventType: "project.deletion_requested.v1",
      actor,
      causationId: ids.next(),
      correlationId,
      payload: { projectId, agencyId: agency.agencyId, deletionId, reasonCode },
    } as never);
    for (const r of records.rows) {
      await events.publish({
        aggregateKind: "retention_record",
        aggregateId: r.retention_id,
        aggregateVersion: Number(r.version),
        agencyId: agency.agencyId,
        eventType: "retention_record.deleting.v1",
        actor,
        causationId: ids.next(),
        correlationId,
        payload: { retentionId: r.retention_id, agencyId: agency.agencyId, projectId, deletionId },
      } as never);
    }
    // the mutable revisions end CANCELLED in the same COMMIT (cancel_revision), each with its event
    const mutable = await c.query<{ revision_id: string; state: string }>(
      "SELECT revision_id::text, state FROM kauro.dataset_revisions WHERE agency_id = $1 AND project_id = $2 AND state IN ('DRAFT', 'UPLOADING', 'INSPECTING', 'READY_TO_SEAL') ORDER BY revision_id FOR NO KEY UPDATE",
      [agency.agencyId, projectId],
    );
    for (const m of mutable.rows) {
      const cancelled = await c.query<{ version: string }>(
        "UPDATE kauro.dataset_revisions SET state = 'CANCELLED', cancelled_at = kauro.server_now(), terminal_reason = 'PROJECT_DELETION_REQUESTED', version = version + 1 WHERE revision_id = $1 RETURNING version::text AS version",
        [m.revision_id],
      );
      await events.publish({
        aggregateKind: "dataset_revision",
        aggregateId: m.revision_id,
        aggregateVersion: Number(cancelled.rows[0]!.version),
        agencyId: agency.agencyId,
        eventType: "dataset_revision.cancelled.v1",
        actor,
        causationId: ids.next(),
        correlationId,
        payload: { revisionId: m.revision_id, agencyId: agency.agencyId, projectId, previousState: m.state, reasonCode: "PROJECT_DELETION_REQUESTED", cancelledUploadIds: [] },
      } as never);
    }
    options.written?.();
    if (options.hold !== undefined) await options.hold;
    await c.query("COMMIT");
    return { deletionId, projectVersion, retentionIds: records.rows.map((r) => r.retention_id) };
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch (rollbackError) {
      destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw e;
  } finally {
    c.release(destroy);
  }
}

/** The backend `pid` is observed blocked on a lock (pg_stat_activity) while `operation` is still pending; a settled operation fails. */
async function blockedOnLock(pid: () => number | undefined, operation: Promise<unknown>, what: string): Promise<void> {
  let settled = false;
  operation.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 500; i++) {
    if (settled) assert.fail(`${what} settled without waiting on a lock`);
    const p = pid();
    if (p !== undefined) {
      await w.h.oracle.query("SELECT pg_stat_clear_snapshot()");
      const r = await w.h.oracle.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [p]);
      if (r.rows.length === 1) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${what} was never observed waiting on a lock`);
}

/** Resolves `reached`; an operation that settles first fails the test naming `what`. */
async function reachedBefore(reached: Promise<void>, operation: Promise<unknown>, what: string): Promise<void> {
  const first = await Promise.race([reached.then(() => "REACHED" as const), operation.then((x) => ({ settled: x }), (e: unknown) => ({ failed: String(e) }))]);
  if (first !== "REACHED") assert.fail(`${what} settled before its hold point: ${JSON.stringify(first)}`);
}

// --- reads -------------------------------------------------------------------------------------------------------------------------

interface ObjectRow {
  readonly object_id: string;
  readonly zone: string;
  readonly location_ref: string;
  readonly object_name: string;
  readonly generation: string | null;
  readonly state: string;
  readonly deletion_result: string | null;
  readonly deletion_attempts: number;
}

async function objectsOf(projectId: string): Promise<ReadonlyArray<ObjectRow>> {
  return (
    await w.h.oracle.query<ObjectRow>(
      "SELECT object_id::text, zone, location_ref, object_name, generation, state, deletion_result, deletion_attempts FROM kauro.stored_objects WHERE project_id = $1 ORDER BY object_id",
      [projectId],
    )
  ).rows;
}

/** The generations the provider still holds LIVE for the project's registered objects (`name#generation`). */
async function liveAtProvider(projectId: string): Promise<ReadonlyArray<string>> {
  const out: string[] = [];
  for (const o of await objectsOf(projectId)) {
    if (o.generation === null) continue;
    for (const g of w.storage.generationsOf(w.storage.location(o.zone as never), o.object_name)) if (g.generation === o.generation && g.status === "LIVE") out.push(`${o.object_name}#${o.generation}`);
  }
  return out.sort();
}

interface Residual {
  readonly objectId: string;
  readonly generation: string;
  readonly cause: string;
  readonly retry: string;
}

interface ReceiptBody {
  readonly objects: ReadonlyArray<{ readonly objectId: string; readonly zone: string; readonly generation: string; readonly result: string }>;
  readonly residuals: ReadonlyArray<Residual>;
  readonly providerResiduals: ReadonlyArray<{ readonly objectName: string; readonly generation: string; readonly expiresAt: string }>;
  readonly derived: ReadonlyArray<{ readonly kind: string; readonly id: string }>;
  readonly excluded: ReadonlyArray<string>;
}

async function receiptsOf(deletionId: string): Promise<ReadonlyArray<{ readonly status: string; readonly body: ReceiptBody }>> {
  return (await w.h.oracle.query<{ status: string; body: ReceiptBody }>("SELECT status, body FROM kauro.deletion_receipts WHERE deletion_id = $1 ORDER BY created_at, receipt_id", [deletionId])).rows;
}

async function deletionState(deletionId: string): Promise<string | undefined> {
  return (await w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.deletion_requests WHERE deletion_id = $1", [deletionId])).rows[0]?.state;
}

async function projectState(projectId: string): Promise<string | undefined> {
  return (await w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.projects WHERE project_id = $1", [projectId])).rows[0]?.state;
}

async function recordStates(projectId: string): Promise<ReadonlyArray<string>> {
  return (await w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.retention_records WHERE project_id = $1 ORDER BY retention_id", [projectId])).rows.map((r) => r.state);
}

const deleteCalls = (): number => w.storage.calls("delete").length;

/** A paid purchase executed and published: its package AVAILABLE, its job READY. */
async function published(label: string): Promise<{ readonly p: Purchase; readonly jobId: string; readonly packageId: string }> {
  const p = await w.paid(w.A, label);
  const { jobId } = await verifiedPrivate(w, p);
  assert.deepEqual(await w.x.pipeline.publish(jobId as ProcessingJobId), { kind: "APPLIED", what: "PUBLISHED" });
  const [pkg] = await w.packages(jobId);
  assert.equal(pkg?.state, "AVAILABLE");
  // the fixture admits the source file in the registry without this fake (admitSourceFile): the provider holds what the registry names
  // (plantGeneration: the fake's own provision for exactly that), so the deletion has the source generations to delete by name
  for (const o of await objectsOf(p.projectId)) {
    if (o.generation === null || (o.zone !== "QUARANTINE" && o.zone !== "ACCEPTED")) continue;
    const location = w.storage.location(o.zone as never);
    if (w.storage.generationsOf(location, o.object_name).length === 0) w.storage.plantGeneration(location, o.object_name, new TextEncoder().encode(`source ${o.object_id}`), o.generation);
  }
  return { p, jobId, packageId: pkg.package_version_id };
}

/** The executor's event of the deletion (project.deletion_requested.v1 at the request's project version). */
const requestEvent = (projectId: string): Promise<DomainEventRecord> => w.eventOf(projectId, "project.deletion_requested.v1");

const EXCLUDED = ["CUSTOMER_DOWNLOADED_COPIES", "EXTERNAL_CRM_IMPORTS"];

// --- OK ------------------------------------------------------------------------------------------------------------------------------

test("CMD042-OK: the executor of a requested deletion deletes every registered object of the project by its generation, closes the published package DELETED and the records DELETED, completes the request and the project DELETED — tombstone journaled before any object delete; receipt COMPLETE_FOR_MANAGED_SCOPE excludes downloaded copies and CRM imports", async () => {
  const executor = await prerequisites();
  const { p, packageId } = await published("del-ok");
  const before = await objectsOf(p.projectId);
  assert.ok(before.some((o) => o.zone === "DELIVERY"), "the published package's delivery copies are registered objects of the project");
  const live = await liveAtProvider(p.projectId);
  assert.ok(live.length > 0, "the provider holds the project's generations");
  const r = await requestAsHandler(p.agency, p.projectId);

  // the first object delete is held: at that instant the restore journal already holds the project's tombstone
  const first = w.storage.holdNext("delete");
  const draining = w.drain(executor);
  await reachedBefore(first.reached, draining, "the executor");
  const tombstones = (await journal.list(p.agency.agencyId, 0)).filter((t) => (t.subjectId as string) === p.projectId);
  first.release();
  assert.deepEqual(tombstones.map((t) => [t.kind, t.state]), [["PROJECT_DELETION_REQUESTED", "DELETION_REQUESTED"]], "the tombstone is journaled before the first object delete");
  const counts = await draining;
  assert.equal(counts.deadLettered, 0);

  // every registered object closed by its generation (deleted, or absent at the provider: an absence success)
  const after = await objectsOf(p.projectId);
  assert.deepEqual(after.map((o) => o.object_id), before.map((o) => o.object_id), "no object is registered or dropped by the deletion");
  for (const o of after) {
    assert.equal(o.state, "DELETED", `object ${o.object_id} (${o.zone}) is DELETED`);
    assert.ok(o.deletion_result === "DELETED" || o.deletion_result === "ALREADY_ABSENT", `object ${o.object_id}: ${o.deletion_result}`);
  }
  assert.deepEqual(await liveAtProvider(p.projectId), [], "the provider holds no live generation of the project");
  for (const call of w.storage.calls("delete").slice(-before.length)) assert.notEqual(call.request["generation"] ?? null, null, "every delete names its generation");
  assert.equal((await w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [packageId])).rows[0]?.state, "DELETED");

  // the receipt: complete for the managed scope, every object with its result, the exclusions named
  const receipts = await receiptsOf(r.deletionId);
  assert.deepEqual(receipts.map((x) => x.status), ["COMPLETE_FOR_MANAGED_SCOPE"]);
  const body = receipts[0]!.body;
  assert.deepEqual(body.objects.map((o) => [o.objectId, o.generation, o.result]), after.map((o) => [o.object_id, o.generation, o.deletion_result]));
  assert.deepEqual(body.residuals, [], "no residual");
  assert.deepEqual([...body.excluded].sort(), EXCLUDED, "downloaded copies and CRM imports are excluded by name");
  assert.equal(await deletionState(r.deletionId), "COMPLETED");
  assert.equal(await projectState(p.projectId), "DELETED");
  for (const s of await recordStates(p.projectId)) assert.ok(s === "DELETED" || s === "DELETED_WITH_RESIDUALS", `record ${s}`);
});

// --- prevention (GAP-DEL-P3; P1, P2 and P4 are the api's: cmd042-request-deletion.test.ts) -------------------------------------------------

interface Interpreting {
  readonly ag: AgencyFixture;
  readonly subject: AuditSubject;
  readonly auditId: string;
  readonly stepFence: number;
  readonly owner: LeaseOwnerId;
  readonly manifest: string;
}

/** An audit of a fresh project INTERPRETING with its INTERPRET step claimed (AUDIT_ORCHESTRATION over the labelled fakes). */
async function interpreting(label: string): Promise<Interpreting> {
  const ag = await w.agency(label);
  const subject = await w.subject(ag, label);
  const started = await a.start(subject);
  const auditId = started.audit.auditId as string;
  assert.deepEqual(await w.redeliver(w.x.consumers.auditOrchestration, await w.eventOf(auditId, "audit.queued.v1")), { kind: "DONE" });
  const row = await a.audit(auditId);
  assert.equal(row.state, "INTERPRETING");
  assert.ok(row.candidate_manifest_hash !== null);
  const step = await a.control(ag.agencyId, (uow) => uow.audits.claimStep(auditId as AuditId, "INTERPRET", ids.next() as AuditStepId));
  return { ag, subject, auditId, stepFence: step.step.fence, owner: step.step.stepId as string as LeaseOwnerId, manifest: row.candidate_manifest_hash };
}

let reservationSeq = 0;
/** The Intelligence core adapter's admission of one model task: createModelTask, then beginDispatch (RESERVED before the provider call). */
async function admitModelTask(run: Interpreting): Promise<{ readonly taskId: string; readonly requestId: string; readonly outcome: string }> {
  reservationSeq += 1;
  const taskId = ids.next() as ModelTaskId;
  const requestId = ids.next() as RequestId;
  const maxChargeMicros = 200_000n;
  try {
    const out = await a.control(run.ag.agencyId, async (uow) => {
      await uow.audits.createModelTask({
        modelTaskId: taskId,
        auditId: run.auditId as AuditId,
        stepFence: run.stepFence,
        taskKey: sha(`del-task-${reservationSeq}-${run.auditId}`),
        candidateManifestHash: run.manifest as never,
        policyHash: sha("model-policy"),
        minimizedRequestHash: sha(`request-${reservationSeq}`),
        core: { runId: run.auditId as never, requestKey: sha(`del-key-${reservationSeq}`) },
        providerProfileId: ids.next() as never,
        maximumCostCents: 40n,
      });
      return uow.audits.beginDispatch(taskId, {
        requestId,
        ownerId: run.owner,
        requestHash: sha(`request-${reservationSeq}`),
        reservedCents: centsOfMicros(maxChargeMicros),
        stepFence: run.stepFence,
        core: { runId: run.auditId as never, reservationId: `del-${reservationSeq}`, requestKey: sha(`del-key-${reservationSeq}`), maxChargeMicros },
      });
    });
    return { taskId, requestId, outcome: out.kind };
  } catch (e) {
    const f = e as { code?: string; details?: { reason?: string }; cause?: { code?: string } };
    return { taskId, requestId, outcome: `${f.code ?? "?"} ${f.details?.reason ?? f.cause?.code ?? "-"}` };
  }
}

/** The superuser places the project DELETION_REQUESTED with triggers off (the state CMD042's COMMIT leaves; the guard reads only it). */
async function placeDeletionRequested(projectId: string): Promise<void> {
  const c = w.h.oracle;
  try {
    await c.query("SET session_replication_role = replica");
    const r = await c.query("UPDATE kauro.projects SET state = 'DELETION_REQUESTED', version = version + 1 WHERE project_id = $1 AND state = 'OPEN'", [projectId]);
    assert.equal(r.rowCount, 1);
  } finally {
    await c.query("RESET session_replication_role");
  }
}

test("CMD042-DENY (prevention): after DELETION_REQUESTED a model dispatch is refused PROJECT_DELETION_REQUESTED", async () => {
  // the control: an admission of the same audit before the deletion request is RESERVED
  const run = await interpreting("del-prevent-dispatch");
  const before = await admitModelTask(run);
  assert.equal(before.outcome, "RESERVED", "a model task of an OPEN project is admitted");
  await placeDeletionRequested(run.subject.projectId);
  const refused = await admitModelTask(run);
  assert.equal(refused.outcome, "PRECONDITION_FAILED PROJECT_DELETION_REQUESTED", "no model dispatch for a project whose deletion was requested (KA087)");
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.model_tasks WHERE model_task_id = $1", [refused.taskId])).rowCount, 0, "no model task written");
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.request_journal WHERE request_id = $1", [refused.requestId])).rowCount, 0, "no reservation journaled");
  // the reservation made before the request is not dispatched either: its DISPATCHING edge is refused and it stays RESERVED
  let dispatching = "NONE";
  try {
    const r = await a.control(run.ag.agencyId, (uow) => uow.requestJournal.markDispatching(before.requestId as RequestId, 1, "provider-del-prevent", w.now()));
    dispatching = String(r?.state ?? "null");
  } catch (e) {
    const f = e as { code?: string; details?: { reason?: string } };
    dispatching = `${f.code ?? "?"} ${f.details?.reason ?? "-"}`;
  }
  assert.equal(dispatching, "PRECONDITION_FAILED PROJECT_DELETION_REQUESTED");
  assert.equal((await a.request(before.requestId)).state, "RESERVED");
});

// --- RACE (GAP-DEL-1) ------------------------------------------------------------------------------------------------------------------

test("CMD042-RACE: deletion held at the project transition lock against a publication and a job admission, both orders — a package published first is enumerated and deleted, one published second never becomes AVAILABLE", async () => {
  const executor = await prerequisites();
  const available = async (packageId: string): Promise<boolean> => (await w.events(packageId)).some((e) => e.event_type === "package_version.available.v1");
  const packageState = async (packageId: string): Promise<string | undefined> => (await w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [packageId])).rows[0]?.state;

  // publication, the deletion first: the request holds the project's exclusive transition half (uncommitted); the publication's guard
  // waits at the project's shared half; the request commits; the publication finds the project no longer OPEN and is refused
  {
    const p = await w.paid(w.A, "del-race-pub-1");
    const { jobId } = await verifiedPrivate(w, p);
    const gate = barrier();
    const written = barrier();
    const req = requestAsHandler(p.agency, p.projectId, { written: written.open, hold: gate.wait });
    let publishing: Promise<unknown> | null = null;
    try {
      await reachedBefore(written.wait, req, "the deletion request");
      publishing = w.x.pipeline.publish(jobId as ProcessingJobId);
      const waiting = w.lockWait("kauro.await_transition");
      waiting.catch(() => undefined);
      const first = await Promise.race([waiting, publishing.then((x) => ({ settled: x }))]);
      if (typeof first !== "number") assert.fail(`the publication settled without waiting on the project: ${JSON.stringify(first)}`);
    } finally {
      gate.open();
    }
    const r = await req;
    const step = (await publishing!) as { kind: string };
    assert.equal(step.kind, "REFUSED", "the publication after the deletion request is refused");
    const [pkg] = await w.packages(jobId);
    assert.equal(await available(pkg!.package_version_id), false, "never AVAILABLE");
    await w.drain(executor);
    assert.equal(await packageState(pkg!.package_version_id), "DELETED", "its private copies are deleted with the project");
    assert.equal((await receiptsOf(r.deletionId)).at(-1)?.status, "COMPLETE_FOR_MANAGED_SCOPE");
  }

  // publication, the publication first: held after its publish statement (the project's shared half held, uncommitted); the request
  // waits at the exclusive half; the publication commits AVAILABLE; the request commits; the executor enumerates and deletes the package
  {
    const p = await w.paid(w.A, "del-race-pub-2");
    const { jobId } = await verifiedPrivate(w, p);
    const held = heldUnits(w.units, "publish", "AFTER");
    const other = w.planeWith({ units: held.units }).execution;
    assert.ok(other !== null);
    const publishing = other.pipeline.publish(jobId as ProcessingJobId);
    let pid: number | undefined;
    let req: Promise<Requested> | null = null;
    try {
      await reachedBefore(held.hold.reached, publishing, "the publication");
      req = requestAsHandler(p.agency, p.projectId, { started: (x) => (pid = x) });
      await blockedOnLock(() => pid, req, "the deletion request behind the publication");
    } finally {
      held.hold.release();
    }
    assert.deepEqual(await publishing, { kind: "APPLIED", what: "PUBLISHED" });
    const r = await req!;
    const [pkg] = await w.packages(jobId);
    assert.equal(await available(pkg!.package_version_id), true, "published first");
    const delivery = (await objectsOf(p.projectId)).filter((o) => o.zone === "DELIVERY");
    assert.ok(delivery.length > 0);
    await w.drain(executor);
    assert.equal(await packageState(pkg!.package_version_id), "DELETED");
    const receipt = (await receiptsOf(r.deletionId)).at(-1);
    assert.equal(receipt?.status, "COMPLETE_FOR_MANAGED_SCOPE");
    for (const o of delivery) assert.ok(receipt!.body.objects.some((x) => x.objectId === o.object_id && (x.result === "DELETED" || x.result === "ALREADY_ABSENT")), `delivery copy ${o.object_id} enumerated and deleted`);
    assert.deepEqual(await liveAtProvider(p.projectId), []);
  }

  // admission, the deletion first: the admission never waits (D8-LOCK-1): it defers the job while the request holds the project, and
  // nothing is admitted or consumed; after the COMMIT the executor's cancellation ends the QUEUED job
  {
    const p = await w.paid(w.A, "del-race-adm-1");
    const job = await w.queue(p);
    const gate = barrier();
    const written = barrier();
    const req = requestAsHandler(p.agency, p.projectId, { written: written.open, hold: gate.wait });
    try {
      await reachedBefore(written.wait, req, "the deletion request");
      const round = await w.withoutWaiting(w.x.sweepers.jobAdmission.admitRound(), "the admission round");
      assert.deepEqual([round.admitted, round.deferred.includes(job.jobId)], [[], true], "deferred, never admitted, while the deletion holds the project");
    } finally {
      gate.open();
    }
    await req;
    await w.drain(executor);
    await w.drain(w.x.consumers.executionControl);
    assert.equal((await w.job(job.jobId)).state, "CANCELLED", "the queued job of the deleted project is cancelled");
    assert.equal((await w.authorization(p.authorizationId)).state, "ACTIVE", "nothing consumed");
    assert.deepEqual(await w.attempts(job.jobId), []);
  }

  // admission, the admission first: held after its admit statement (the project's shared half held); the request waits at the exclusive
  // half; the admission commits; the request commits; the executor cancels the admitted job before any launch
  {
    const p = await w.paid(w.A, "del-race-adm-2");
    const job = await w.queue(p);
    const held = heldUnits(w.units, "admit", "AFTER");
    const other = w.planeWith({ units: held.units }).execution;
    assert.ok(other !== null);
    const admitting = other.sweepers.jobAdmission.admitRound();
    let pid: number | undefined;
    let req: Promise<Requested> | null = null;
    try {
      await reachedBefore(held.hold.reached, admitting, "the admission");
      req = requestAsHandler(p.agency, p.projectId, { started: (x) => (pid = x) });
      await blockedOnLock(() => pid, req, "the deletion request behind the admission");
    } finally {
      held.hold.release();
    }
    assert.deepEqual((await admitting).admitted, [job.jobId]);
    await req!;
    await w.drain(executor);
    await w.drain(w.x.consumers.executionControl);
    const row = await w.job(job.jobId);
    assert.equal(row.state, "CANCELLED", "the admitted job of the deleted project is cancelled before its launch");
    assert.deepEqual(await w.packages(job.jobId), [], "no package");
  }
});

// --- TIMEOUT (GAP-DEL-2) -------------------------------------------------------------------------------------------------------------

test("RACE (timeout): a provider delete that times out records DELETION_FAILED with the object as residual; DELETION_RETRIES finishes it", async () => {
  const executor = await prerequisites();
  const { p } = await published("del-timeout");
  const r = await requestAsHandler(p.agency, p.projectId);
  const callsBefore = deleteCalls();
  w.storage.failNext("delete", { code: "TIMEOUT", applied: false });
  await w.drain(executor);

  // the bound fired at the provider: the first delete of the run answered TIMEOUT; its object is DELETION_FAILED, the others closed
  const timedOut = w.storage.calls("delete")[callsBefore];
  assert.equal(timedOut?.outcome, "FAILED TIMEOUT", "the executor's first delete timed out at the provider");
  const objects = await objectsOf(p.projectId);
  const failed = objects.filter((o) => o.state !== "DELETED");
  assert.deepEqual(
    failed.map((o) => [o.object_name, o.generation, o.state, o.deletion_result, o.deletion_attempts]),
    [[timedOut.request["objectName"], timedOut.request["generation"], "DELETION_FAILED", "PROVIDER_ERROR", 1]],
    "exactly the timed-out object is DELETION_FAILED",
  );
  const residual = failed[0]!;
  const [partial] = await receiptsOf(r.deletionId);
  assert.equal(partial?.status, "PARTIAL");
  assert.deepEqual(partial!.body.residuals, [{ objectId: residual.object_id, generation: residual.generation, cause: "PROVIDER_ERROR", retry: "DELETION_RETRIES" }], "the residual and its retry are named");
  assert.equal(await deletionState(r.deletionId), "FAILED_RETRYABLE");
  assert.equal(await projectState(p.projectId), "DELETION_REQUESTED", "never DELETED with a residual");

  // DELETION_RETRIES deletes it under its exact generation; the executor's next delivery then completes the receipt
  const retried = await w.plane.sweepers.deletionRetries.sweep(w.plane.units, 100);
  assert.deepEqual([retried.acted, retried.failed], [1, []]);
  const done = (await objectsOf(p.projectId)).find((o) => o.object_id === residual.object_id);
  assert.deepEqual([done?.state, done?.deletion_result, done?.deletion_attempts], ["DELETED", "DELETED", 2]);
  assert.deepEqual(await w.redeliver(executor, await requestEvent(p.projectId)), { kind: "DONE" });
  assert.deepEqual((await receiptsOf(r.deletionId)).map((x) => x.status), ["PARTIAL", "COMPLETE_FOR_MANAGED_SCOPE"]);
  assert.equal(await deletionState(r.deletionId), "COMPLETED");
  assert.equal(await projectState(p.projectId), "DELETED");
});

// --- CRASH-AFTER (GAP-DEL-5) -------------------------------------------------------------------------------------------------------------

test("RACE (crash after COMMIT): executor crash between object deletions resumes from recorded results; a missing object is an absence success, never recreated", async () => {
  await prerequisites();
  const { p } = await published("del-crash");
  const live = await liveAtProvider(p.projectId);
  assert.ok(live.length >= 2, `the project holds at least two provider generations (${live.length})`);
  const r = await requestAsHandler(p.agency, p.projectId);

  // a second control-plane process whose units crash at a commit: the first delete is recorded (committed); the second delete reaches
  // the provider, and the unit recording its result dies before its COMMIT — the provider deleted it, the registry does not know
  const points = new FaultPoints();
  const crashing = crashableFactory(w.units, points, "deletion", ["run", "runSource"] as never);
  const other = w.planeWith({ units: crashing as never });
  const first = w.storage.holdNext("delete");
  const draining = other.drain(executorOf(other), w.now()).catch((e: unknown) => e);
  await reachedBefore(first.reached, draining, "the executor's first delete");
  first.release();
  const second = w.storage.holdNext("delete");
  await reachedBefore(second.reached, draining, "the executor's second delete");
  const recorded = (await objectsOf(p.projectId)).filter((o) => o.state === "DELETED");
  assert.equal(recorded.length, 1, "the first object's result is committed before the second delete");
  points.crash("deletion.before-commit");
  second.release();
  await draining;
  assert.ok(points.crashes.includes("deletion.before-commit"), "the executor died at the commit of the second object's result");
  const secondName = String(w.storage.calls("delete").at(-1)?.request["objectName"]);
  const lost = (await objectsOf(p.projectId)).find((o) => o.object_name === secondName);
  assert.notEqual(lost?.state, "DELETED", "the second result never committed");

  // the delivery again (at-least-once): the recorded first object is not deleted again, the second is absent at the provider and
  // closed ALREADY_ABSENT, nothing is recreated, and the receipt completes once
  const callsBefore = w.storage.calls("delete").map((c) => `${c.request["objectName"]}#${c.request["generation"]}`);
  assert.deepEqual(await w.redeliver(executorOf(), await requestEvent(p.projectId)), { kind: "DONE" });
  const resumed = w.storage.calls("delete").slice(callsBefore.length).map((c) => `${c.request["objectName"]}#${c.request["generation"]}`);
  assert.equal(resumed.includes(`${recorded[0]!.object_name}#${recorded[0]!.generation}`), false, "the recorded deletion is not repeated");
  const after = await objectsOf(p.projectId);
  assert.deepEqual([after.find((o) => o.object_name === secondName)?.state, after.find((o) => o.object_name === secondName)?.deletion_result], ["DELETED", "ALREADY_ABSENT"], "the missing object is an absence success");
  assert.equal(w.storage.calls("copy").filter((c) => String(c.request["objectName"] ?? c.request["destinationName"] ?? "").includes(p.projectId)).length, 0, "nothing recreated");
  assert.deepEqual(await liveAtProvider(p.projectId), []);
  assert.deepEqual((await receiptsOf(r.deletionId)).map((x) => x.status), ["COMPLETE_FOR_MANAGED_SCOPE"]);
});

// --- RETRY (GAP-DEL-6, the consumer half) -----------------------------------------------------------------------------------------------

test("RETRY (redelivery): a duplicate project.deletion_requested.v1 delivery after the deletion completed deletes nothing twice and appends no second receipt", async () => {
  const executor = await prerequisites();
  const { p } = await published("del-redelivery");
  const r = await requestAsHandler(p.agency, p.projectId);
  await w.drain(executor);
  assert.deepEqual((await receiptsOf(r.deletionId)).map((x) => x.status), ["COMPLETE_FOR_MANAGED_SCOPE"]);
  const objects = JSON.stringify(await objectsOf(p.projectId));
  const calls = deleteCalls();
  const tombstones = (await journal.list(p.agency.agencyId, 0)).length;
  assert.deepEqual(await w.redeliver(executor, await requestEvent(p.projectId)), { kind: "DONE" });
  assert.equal(deleteCalls(), calls, "no provider delete on the duplicate");
  assert.equal(JSON.stringify(await objectsOf(p.projectId)), objects, "the registry is unchanged");
  assert.deepEqual((await receiptsOf(r.deletionId)).map((x) => x.status), ["COMPLETE_FOR_MANAGED_SCOPE"], "one receipt");
  assert.equal((await journal.list(p.agency.agencyId, 0)).length, tombstones, "no second tombstone");
  assert.deepEqual([await deletionState(r.deletionId), await projectState(p.projectId)], ["COMPLETED", "DELETED"]);
});

// --- PARTIAL (GAP-DEL-8, S064) ---------------------------------------------------------------------------------------------------------

test("S064: provider refuses one of three generations: receipt PARTIAL names the residual and the retry; never COMPLETE from deleted_at", async () => {
  const executor = await prerequisites();
  const { p } = await published("del-s064");
  const held = (await objectsOf(p.projectId)).filter((o) => o.generation !== null && w.storage.generationsOf(w.storage.location(o.zone as never), o.object_name).some((g) => g.generation === o.generation && g.status === "LIVE"));
  assert.ok(held.length >= 3, `the provider holds at least three generations of the project (${held.length})`);
  const refused = held[1]!;
  const location = w.storage.location(refused.zone as never);
  // the provider refuses to delete this generation (a temporary hold: Cloud Storage answers 403 "Object is under active Temporary hold")
  const placed = await w.storage.placeHold(location, refused.object_name, refused.generation!);
  assert.ok(placed !== null);
  const r = await requestAsHandler(p.agency, p.projectId);
  await w.drain(executor);

  const after = await objectsOf(p.projectId);
  assert.deepEqual(after.filter((o) => o.state !== "DELETED").map((o) => [o.object_id, o.state, o.deletion_result]), [[refused.object_id, "DELETION_FAILED", "PROVIDER_ERROR"]], "only the refused generation is left");
  assert.equal(after.filter((o) => o.state === "DELETED").length, after.length - 1, "every other object is deleted");
  const [partial] = await receiptsOf(r.deletionId);
  assert.equal(partial?.status, "PARTIAL");
  assert.deepEqual(partial!.body.residuals, [{ objectId: refused.object_id, generation: refused.generation, cause: "PROVIDER_ERROR", retry: "DELETION_RETRIES" }]);
  assert.equal(partial!.body.objects.filter((o) => o.result === "DELETED" || o.result === "ALREADY_ABSENT").length, after.length - 1);
  assert.deepEqual([await deletionState(r.deletionId), await projectState(p.projectId)], ["FAILED_RETRYABLE", "DELETION_REQUESTED"]);
  assert.ok((await recordStates(p.projectId)).every((s) => s === "DELETING"), "the records stay DELETING");

  // a forged deleted_at on the refused object (the superuser, triggers off) never makes the receipt COMPLETE: the executor compares
  // with the provider, which still holds the generation
  const c = w.h.oracle;
  try {
    await c.query("SET session_replication_role = replica");
    await c.query("UPDATE kauro.stored_objects SET state = 'DELETED', deletion_result = 'DELETED', deleted_at = now(), provider_residual_basis = 'LOCATION_POLICY' WHERE object_id = $1", [refused.object_id]);
  } finally {
    await c.query("RESET session_replication_role");
  }
  const retry = await w.redeliver(executor, await requestEvent(p.projectId));
  assert.equal(retry.kind, "RETRY");
  assert.ok("afterSeconds" in retry && retry.afterSeconds > 0, "the retry names when");
  assert.ok("reason" in retry && retry.reason === "DELETION_RESIDUALS", "the retry names why: the residual the receipt lists");
  assert.deepEqual((await receiptsOf(r.deletionId)).map((x) => x.status), ["PARTIAL", "PARTIAL"], "a deleted_at alone never produces a complete receipt");
  assert.equal(await projectState(p.projectId), "DELETION_REQUESTED");

  // the database refuses a COMPLETE receipt while an object of the deletion is a residual (KA088), whoever writes it
  try {
    await c.query("SET session_replication_role = replica");
    await c.query("UPDATE kauro.stored_objects SET state = 'DELETION_FAILED', deletion_result = 'PROVIDER_ERROR', deleted_at = NULL, provider_residual_basis = NULL WHERE object_id = $1", [refused.object_id]);
  } finally {
    await c.query("RESET session_replication_role");
  }
  const forged = await w.h.controlPool.connectUnverified();
  let code: unknown = "NONE";
  try {
    await forged.query("BEGIN");
    await forged.query("SELECT set_config('kauro.agency_id', $1, true)", [p.agency.agencyId]);
    await forged.query("INSERT INTO kauro.deletion_receipts (receipt_id, deletion_id, agency_id, project_id, status, body) VALUES ($1, $2, $3, $4, 'COMPLETE_FOR_MANAGED_SCOPE', $5::jsonb)", [
      ids.next(),
      r.deletionId,
      p.agency.agencyId,
      p.projectId,
      JSON.stringify({ objects: [], residuals: [], providerResiduals: [], derived: [], excluded: EXCLUDED }),
    ]);
  } catch (e) {
    code = (e as { code?: unknown }).code;
  } finally {
    await forged.query("ROLLBACK").catch(() => undefined);
    forged.release();
  }
  assert.equal(code, "KA088", "a COMPLETE receipt with a residual object is refused");

  // the hold released, DELETION_RETRIES deletes the generation and the next delivery completes the receipt
  const view = w.storage.generationsOf(location, refused.object_name).find((g) => g.generation === refused.generation);
  await w.storage.releaseHold(location, refused.object_name, refused.generation!, view!.metageneration);
  assert.equal((await w.plane.sweepers.deletionRetries.sweep(w.plane.units, 100)).acted, 1);
  assert.deepEqual(await w.redeliver(executor, await requestEvent(p.projectId)), { kind: "DONE" });
  assert.deepEqual((await receiptsOf(r.deletionId)).map((x) => x.status), ["PARTIAL", "PARTIAL", "COMPLETE_FOR_MANAGED_SCOPE"]);
  assert.deepEqual([await deletionState(r.deletionId), await projectState(p.projectId)], ["COMPLETED", "DELETED"]);
});

// --- R2-056 ----------------------------------------------------------------------------------------------------------------------------

test("R2-056 (SIM): noncurrent versions left by an earlier policy are inventoried with their actual expiry, never reported vanished", async () => {
  const executor = await prerequisites();
  const { p } = await published("del-r2-056");
  const location = w.storage.location("ACCEPTED");
  try {
    // an earlier policy (30-day soft delete) leaves a deleted generation under the project's prefix, its expiry fixed at its deletion
    w.storage.setRetentionPolicy("ACCEPTED", { softDeleteRetentionSeconds: 30 * 86_400, objectVersioning: false });
    await w.plane.sweepers.locationPolicy.sweep(w.plane.units, 10);
    const name = `accepted/${p.agency.agencyId}/${p.projectId}/${ids.next()}`;
    const planted = w.storage.plantObject(location, name, new TextEncoder().encode("r2-056 earlier generation"));
    assert.equal(w.storage.deleteOutOfBand(location, name)?.generation, planted.generation);
    const left = w.storage.generationsOf(location, name).find((g) => g.generation === planted.generation);
    assert.equal(left?.status, "SOFT_DELETED");
    const actualExpiry = left!.softDeleteExpiresAt!;
    // the current policy is shorter (one day): it never shortens what the provider already holds
    w.storage.setRetentionPolicy("ACCEPTED", { softDeleteRetentionSeconds: 86_400, objectVersioning: false });
    await w.plane.sweepers.locationPolicy.sweep(w.plane.units, 10);

    const listedBefore = w.storage.calls("listSoftDeleted").length;
    const r = await requestAsHandler(p.agency, p.projectId);
    await w.drain(executor);
    assert.ok(
      w.storage.calls("listSoftDeleted").slice(listedBefore).some((c) => String(c.request["prefix"]).startsWith(`accepted/${p.agency.agencyId}/${p.projectId}/`)),
      "the executor compares the provider's inventory of the project's prefix",
    );
    const receipt = (await receiptsOf(r.deletionId)).at(-1);
    assert.equal(receipt?.status, "COMPLETE_FOR_MANAGED_SCOPE");
    assert.deepEqual(
      receipt!.body.providerResiduals.filter((x) => x.objectName === name).map((x) => [x.generation, Date.parse(x.expiresAt)]),
      [[planted.generation, Date.parse(actualExpiry)]],
      "the generation left by the earlier policy is reported with the provider's own expiry (30 days, not the current 1 day)",
    );
    assert.ok((await recordStates(p.projectId)).every((s) => s === "DELETED_WITH_RESIDUALS"), "the records name their provider residuals");
  } finally {
    w.storage.setRetentionPolicy("ACCEPTED", { softDeleteRetentionSeconds: 604_800, objectVersioning: false });
    await w.plane.sweepers.locationPolicy.sweep(w.plane.units, 10);
  }
});

// --- R2-057 ----------------------------------------------------------------------------------------------------------------------------

test("R2-057 (deletion half): audit model context and derived rows of the project are enumerated and tombstoned", async () => {
  const executor = await prerequisites();
  const run = await interpreting("del-r2-057");
  const task = await admitModelTask(run);
  assert.equal(task.outcome, "RESERVED");
  const r = await requestAsHandler(run.ag, run.subject.projectId);
  await w.drain(executor);
  const receipt = (await receiptsOf(r.deletionId)).at(-1);
  assert.ok(receipt !== undefined, "the deletion has a receipt");
  const derived = receipt.body.derived.map((d) => `${d.kind}:${d.id}`).sort();
  assert.deepEqual(derived, [`AUDIT:${run.auditId}`, `MODEL_TASK:${task.taskId}`].sort(), "the audit and its model context are enumerated");
  const audit = await a.audit(run.auditId);
  assert.deepEqual([audit.state, audit.cancel_actor_kind], ["CANCELLED", "SERVICE"], "the live audit of the project is ended by the executor");
  assert.notEqual((await a.request(task.requestId)).state, "RESERVED", "the model reservation is released, never dispatched");
  for (const o of await objectsOf(run.subject.projectId)) assert.equal(o.state, "DELETED", `derived object ${o.object_id} (${o.zone}) deleted`);
  const tomb = (await journal.list(run.ag.agencyId as AgencyId, 0)).filter((t) => (t.subjectId as string) === run.subject.projectId).map((t) => t.kind);
  assert.deepEqual(tomb, ["PROJECT_DELETION_REQUESTED"], "the project's authority is tombstoned");
});

// --- retained by policy (09 "Storage zones": LEGAL_FINANCE and SECURITY hold separately classified residual records) ---------------------

test("CMD042-OK (retained by policy): a registered LEGAL_FINANCE or SECURITY object of the project is named in the receipt as retained by policy and never deleted", async () => {
  const executor = await prerequisites();
  const { p } = await published("del-retained");
  const quarantine = (await objectsOf(p.projectId)).find((o) => o.zone === "QUARANTINE");
  assert.ok(quarantine !== undefined);
  const c = w.h.oracle;
  const retained: Array<{ id: string; zone: string }> = [];
  for (const zone of ["LEGAL_FINANCE", "SECURITY"]) {
    const id = ids.next();
    await c.query("CREATE TEMP TABLE b16_retained_copy AS SELECT * FROM kauro.stored_objects WHERE object_id = $1", [quarantine.object_id]);
    await c.query(
      "UPDATE b16_retained_copy SET object_id = $1, zone = $2, object_name = $3, generation = NULL, state = 'INTENDED', upload_id = NULL, file_id = NULL, bytes = NULL, sha256 = NULL, observed_at = NULL, verified_at = NULL, location_ref = $4",
      [id, zone, `${zone.toLowerCase().replace("_", "-")}/${p.agency.agencyId}/${p.projectId}/${id}`, `${zone}_PRIMARY`],
    );
    await c.query("INSERT INTO kauro.stored_objects SELECT * FROM b16_retained_copy");
    await c.query("DROP TABLE b16_retained_copy");
    retained.push({ id, zone });
  }
  const r = await requestAsHandler(p.agency, p.projectId);
  await w.drain(executor);
  const [receipt] = await receiptsOf(r.deletionId);
  assert.equal(receipt?.status, "COMPLETE_FOR_MANAGED_SCOPE", "the managed scope is complete: the retained zones are not part of it");
  const named = (receipt!.body as unknown as { retainedByPolicy: ReadonlyArray<{ objectId: string; zone: string; basis: string }> }).retainedByPolicy;
  assert.deepEqual(
    named.map((x) => [x.objectId, x.zone, x.basis]).sort(),
    retained.map((x) => [x.id, x.zone, x.zone === "LEGAL_FINANCE" ? "LEGAL_FINANCE_RETENTION" : "SECURITY_EVIDENCE_RETENTION"]).sort(),
    "named, with the policy that retains them",
  );
  for (const x of retained) assert.equal((await objectsOf(p.projectId)).find((o) => o.object_id === x.id)?.state, "INTENDED", `the ${x.zone} object is left as registered`);
  assert.ok(!receipt!.body.objects.some((o) => retained.some((x) => x.id === o.objectId)), "never listed among the deleted objects");
});

// --- the revisions (coordinator decision 2026-10-14: R2 state_transitions DatasetRevision) --------------------------------------------------

/** A revision of the project placed by the superuser with triggers off (the states the writers reach only through other commands). */
async function placeRevision(p: { readonly agency: AgencyFixture; readonly projectId: string }, state: "DRAFT" | "CANCELLED" | "EXPIRED" | "REJECTED"): Promise<string> {
  const id = ids.next();
  const c = w.h.oracle;
  const at = state === "CANCELLED" ? "cancelled_at" : state === "EXPIRED" ? "expired_at" : state === "REJECTED" ? "rejected_at" : null;
  try {
    await c.query("SET session_replication_role = replica");
    await c.query(
      `INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, version, state, created_by_membership_id, created_at, updated_at${at === null ? "" : `, ${at}, terminal_reason`})
       VALUES ($1, $2, $3, 1, $4, $5, now() - interval '1 day', now() - interval '1 day'${at === null ? "" : ", now() - interval '1 hour', 'TEST_PLACED'"})`,
      [id, p.agency.agencyId, p.projectId, state, p.agency.ownerMembershipId],
    );
  } finally {
    await c.query("RESET session_replication_role");
  }
  return id;
}

async function revisionStates(projectId: string): Promise<Readonly<Record<string, { readonly state: string; readonly version: number; readonly deleted: boolean }>>> {
  const r = await w.h.oracle.query<{ revision_id: string; state: string; version: string; deleted: boolean }>("SELECT revision_id::text, state, version::text AS version, deleted_at IS NOT NULL AS deleted FROM kauro.dataset_revisions WHERE project_id = $1", [projectId]);
  return Object.fromEntries(r.rows.map((x) => [x.revision_id, { state: x.state, version: x.version === undefined ? 0 : Number(x.version), deleted: x.deleted }]));
}

const statesOnly = (all: Readonly<Record<string, { readonly state: string }>>): Record<string, string> => Object.fromEntries(Object.entries(all).map(([id, x]) => [id, x.state]));

test("CMD042-OK (revisions) and CRASH-AFTER-COMMIT-BEFORE-EXECUTOR: the request leaves CANCELLED and EXPIRED revisions; the redelivered executor, once cleanup is verified, moves exactly those to DELETED; SEALED and REJECTED stay and are named in the receipt; DENY: no path moves a SEALED revision", async () => {
  const executor = await prerequisites();
  const { p } = await published("del-revisions");
  const draft = await placeRevision(p, "DRAFT");
  const cancelled = await placeRevision(p, "CANCELLED");
  const expired = await placeRevision(p, "EXPIRED");
  const rejected = await placeRevision(p, "REJECTED");
  const before = await revisionStates(p.projectId);
  const sealed = Object.keys(before).find((id) => before[id]!.state === "SEALED")!;
  assert.ok(sealed !== undefined && before[draft]?.state === "DRAFT");
  const countEvents = async (): Promise<number> => (await w.h.oracle.query("SELECT 1 FROM kauro.domain_events WHERE aggregate_id = ANY($1::uuid[])", [[sealed, rejected]])).rowCount ?? -1;
  const eventsBefore = await countEvents();
  const r = await requestAsHandler(p.agency, p.projectId);

  // the request's COMMIT is done and the executor has not run: the mutable revision is CANCELLED, nothing else moved, nothing deleted
  const committed = await revisionStates(p.projectId);
  assert.deepEqual(statesOnly(committed), { [sealed]: "SEALED", [draft]: "CANCELLED", [cancelled]: "CANCELLED", [expired]: "EXPIRED", [rejected]: "REJECTED" });
  assert.equal(committed[sealed]!.version, before[sealed]!.version, "the SEALED revision is untouched by the request");

  // a first delivery that cannot finish (a provider delete times out) leaves the revisions CANCELLED / EXPIRED, never DELETED
  w.storage.failNext("delete", { code: "TIMEOUT", applied: false });
  await w.drain(executor);
  assert.equal(await projectState(p.projectId), "DELETION_REQUESTED");
  const interrupted = await revisionStates(p.projectId);
  for (const id of [draft, cancelled, expired]) assert.equal(interrupted[id]?.deleted, false, "not DELETED before the cleanup is verified");

  // the redelivered executor finishes them
  await w.plane.sweepers.deletionRetries.sweep(w.plane.units, 100);
  assert.deepEqual(await w.redeliver(executor, await requestEvent(p.projectId)), { kind: "DONE" });
  const done = await revisionStates(p.projectId);
  assert.deepEqual(
    statesOnly(done),
    { [sealed]: "SEALED", [draft]: "DELETED", [cancelled]: "DELETED", [expired]: "DELETED", [rejected]: "REJECTED" },
    "CANCELLED and EXPIRED -> DELETED through managed_cleanup_verified; SEALED and REJECTED stay",
  );
  assert.equal(done[sealed]!.version, before[sealed]!.version, "DENY: the SEALED revision's version never moved");
  assert.equal(done[rejected]!.version, 1);

  // the events: dataset_revision.deleted.v1 for those three only
  const deletedEvents = await w.h.oracle.query<{ aggregate_id: string }>(
    "SELECT aggregate_id::text FROM kauro.domain_events WHERE event_type = 'dataset_revision.deleted.v1' AND aggregate_id = ANY($1::uuid[]) ORDER BY aggregate_id::text",
    [Object.keys(done)],
  );
  assert.deepEqual(deletedEvents.rows.map((x) => x.aggregate_id), [draft, cancelled, expired].sort());
  assert.equal(await countEvents(), eventsBefore, "the request and the executor published no event naming the SEALED or the REJECTED revision");

  // the receipt names them with the registry citation
  const receipts = await receiptsOf(r.deletionId);
  const named = (receipts.at(-1)!.body as unknown as { retainedRevisions: ReadonlyArray<{ revisionId: string; state: string; basis: string }> }).retainedRevisions;
  assert.deepEqual(
    named.map((x) => [x.revisionId, x.state, x.basis]).sort(),
    [[sealed, "SEALED", "NO_DELETION_EDGE_FROM_SEALED"], [rejected, "REJECTED", "NO_DELETION_EDGE_FROM_REJECTED"]].sort(),
  );
});

test("CMD042-DENY (revisions): the control role cannot take a SEALED revision to DELETED, nor a CANCELLED one before its project's deletion completed", async () => {
  const { p } = await published("del-revisions-deny");
  const cancelled = await placeRevision(p, "CANCELLED");
  const states = await revisionStates(p.projectId);
  const sealedId = Object.keys(states).find((id) => states[id]!.state === "SEALED")!;
  for (const [id, expect] of [[sealedId, /row-level security|KA008|KA088|DELETION_EVIDENCE|permission denied/i], [cancelled, /KA088|DELETION_EVIDENCE/]] as const) {
    const c = await w.h.controlPool.connectUnverified();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [p.agency.agencyId]);
      await assert.rejects(c.query("UPDATE kauro.dataset_revisions SET state = 'DELETED', deleted_at = kauro.server_now(), version = version + 1 WHERE revision_id = $1", [id]), expect);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  assert.equal((await revisionStates(p.projectId))[sealedId]?.state, "SEALED");
});
