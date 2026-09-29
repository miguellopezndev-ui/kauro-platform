// The RETENTION sweeper (docs/design/B07-upload-source-lifecycle.md §12.5; decisions D-RET-1..3, D-EXP-1, D-PERS-3, D-SEAL-1; mandate
// B07-CONTROL) on a real PostgreSQL 17 through the package's sweeper (kauro_control_test, SYSTEM units of work bound to each item's
// agency, revision row first). Sources that must be older than their deadlines are sealed or rejected in the past through the
// persistence package's source-lifecycle fixture — each write by the role that owns it, at the labelled TEST CLOCK instants of its own
// transactions, never a back-dated row — and the sweeper runs on the real server clock: the database decides what is due, and
// nothing expires early. The accepted generations are deleted through the labelled storage fake of @kauro/application/testing
// (CONTRACT FAKE, evidence class SIMULATED). The superuser is the oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EVALUATOR_VERSION } from "@kauro/data-plane";
import { PRICING_DEFINITION, evaluationHashOf, isDomainFailure, type CausationId, type CorrelationId, type EvaluationId, type RetentionId, type RevisionId, type SelectionManifestId, type SourceFileId, type SourceTableId } from "@kauro/domain";
import { PgEventPublisher, PgSourceStore } from "@kauro/persistence";
import { admitSourceFile, bindSourceSelection, clockAt, type SourceFixtureSessions } from "@kauro/persistence/testing";
import { clock, ids, rawTx, startControlEnv, type ControlEnv } from "./support/env.js";
import { bindSelection, eventsOf, oracle, project, replaceRevision, sealedRevision, tenant, uploadAndReport, type ProjectFixture, type Tenant } from "./support/fixtures.js";
import { buildCsv } from "./support/workbook.js";

let env: ControlEnv;

before(async () => {
  env = await startControlEnv();
  await env.plane.sweepers.locationPolicy.sweep(env.plane.units, 10);
});

after(async () => {
  await env.stop();
});

const HOUR_MS = 3_600_000;

async function revision(revisionId: string): Promise<{ state: string; terminal_reason: string | null; expired_at: Date | null; version: string }> {
  return oracle(env, "SELECT state, terminal_reason, expired_at, version::text FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId]);
}

async function record(revisionId: string): Promise<{ state: string; expired_at: Date | null; effective_deadline: Date }> {
  return oracle(env, "SELECT state, expired_at, effective_deadline FROM kauro.retention_records WHERE revision_id = $1", [revisionId]);
}

async function file(fileId: string): Promise<{ state: string; revocation_reason: string | null; object_state: string; deletion_result: string | null; residual_basis: string | null }> {
  return oracle(
    env,
    `SELECT f.state, f.revocation_reason, o.state AS object_state, o.deletion_result, o.provider_residual_basis AS residual_basis
       FROM kauro.source_files f JOIN kauro.stored_objects o ON o.object_id = f.accepted_object_id WHERE f.file_id = $1`,
    [fileId],
  );
}

/**
 * A revision REJECTED by SELECTION_EVALUATION's edge twenty-six hours ago: one CSV admitted and its selection bound through the
 * persistence fixture, then — as the control plane, at the TEST CLOCK instant just after — an ADMISSION_FAILED evaluation of that
 * selection and fatal_input_rejection with its event. Every intake window of it has closed on the server clock.
 */
async function rejectedLongAgo(t: Tenant, p: ProjectFixture): Promise<RevisionId> {
  const base = new Date(Date.now() - 26 * HOUR_MS);
  const sessions: SourceFixtureSessions = {
    app: (fn) => rawTx(env.h.appPool, t.ag.agencyId, t.ag.ownerUserId, (c) => fn(c)),
    control: (fn) => rawTx(env.h.controlPool, t.ag.agencyId, "", (c) => fn(c)),
  };
  const scope = { agencyId: t.ag.agencyId, projectId: p.projectId, ownerUserId: t.ag.ownerUserId, ownerMembershipId: t.ag.ownerMembershipId };
  const admitted = await admitSourceFile(sessions, scope, { seed: "retention-rejected", base });
  const bound = await bindSourceSelection(sessions, scope, admitted);
  await rawTx(env.h.controlPool, t.ag.agencyId, "", async (c) => {
    const at = await clockAt(c, new Date(base.getTime() + 6 * 60_000));
    const s = new PgSourceStore(c, "CONTROL");
    const current = await s.revisions.lock(bound.revisionId as RevisionId);
    if (current === null) throw new Error("fixture: the revision is not visible");
    const body = {
      evaluationId: ids.next() as EvaluationId,
      agencyId: t.ag.agencyId,
      revisionId: bound.revisionId as RevisionId,
      selectionManifestId: bound.selectionManifestId as SelectionManifestId,
      selectionHash: bound.selectionHash,
      result: "ADMISSION_FAILED" as const,
      files: [],
      tables: [],
      projections: [],
      failures: [{ code: "PROJECTION_COLUMN_NOT_SELECTED", tableId: bound.tableId as SourceTableId }],
      pricingDefinition: PRICING_DEFINITION,
      evaluatorVersion: EVALUATOR_VERSION,
      startedAt: at,
      completedAt: at,
    };
    const evaluationHash = evaluationHashOf(body);
    await s.evaluations.append({ ...body, evaluationHash });
    const rejected = await s.revisions.transition(bound.revisionId as RevisionId, current.version, { event: "fatal_input_rejection", reason: "SELECTED_INPUT_REJECTED" });
    if (rejected.kind !== "APPLIED") throw new Error("fixture: the rejection did not apply");
    await new PgEventPublisher(c, ids, clock).publish({
      aggregateKind: "dataset_revision",
      aggregateId: bound.revisionId,
      aggregateVersion: rejected.record.version,
      agencyId: t.ag.agencyId,
      eventType: "dataset_revision.rejected.v1",
      actor: { kind: "SERVICE", serviceId: "selection-evaluation" },
      causationId: ids.next() as CausationId,
      correlationId: ids.next() as CorrelationId,
      payload: { revisionId: bound.revisionId, agencyId: t.ag.agencyId, projectId: p.projectId, selectionHash: bound.selectionHash, evaluationHash, reasonCode: "SELECTED_INPUT_REJECTED" },
    });
  });
  return bound.revisionId as RevisionId;
}

test("RETENTION on the server clock, never early: a record past its effective deadline expires and its SEALED revision after it, a sealed file whose including revisions hold no ACTIVE record ahead is revoked RETENTION_EXPIRED with its accepted generation deleted — a SUPERSEDED including revision keeps nothing admitted — and a REJECTED revision expires once its intake windows closed keeping its rejection's reason, while every record, revision and file whose deadline lies ahead is left as it is", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "retention");
  // due: sealed fifteen days ago (the UNPAID hard deadline, the seal + fourteen days, has passed)
  const pOld = await project(env, t);
  const old = await sealedRevision(env, t, pOld, "retention-old");
  // due, superseded: the successor exists, the predecessor never expires itself (D-RET-3)
  const pSup = await project(env, t);
  const sup = await sealedRevision(env, t, pSup, "retention-superseded");
  await replaceRevision(env, t, pSup, sup.revisionId as RevisionId);
  // not due: sealed an hour ago
  const pYoung = await project(env, t);
  const young = await sealedRevision(env, t, pYoung, "retention-young", new Date(Date.now() - HOUR_MS));
  // due: rejected twenty-six hours ago, every intake window closed
  const pRejectedOld = await project(env, t);
  const rejectedOld = await rejectedLongAgo(t, pRejectedOld);
  // not due: rejected now by the real pipeline (its selection projects a column it did not select), its upload's window still open
  const pRejectedNew = await project(env, t);
  const content = buildCsv(["Email", "Name"], [["r@example.test", "R"]]);
  const { up } = await uploadAndReport(env, t, pRejectedNew, content, "CSV");
  await env.plane.drain(env.plane.consumers.uploadInspection, clock.now());
  const admitted = await oracle<{ file_id: string; table_id: string; structure_hash: string }>(env, "SELECT f.file_id, t.table_id, t.structure_hash FROM kauro.source_files f JOIN kauro.source_tables t ON t.file_id = f.file_id WHERE f.origin_upload_id = $1", [up.uploadId]);
  await bindSelection(env, t, pRejectedNew, { fileId: admitted.file_id as SourceFileId, tableId: admitted.table_id as SourceTableId, structureHash: admitted.structure_hash }, (s) => ({ ...s, tables: s.tables.map((x) => ({ ...x, selectedColumns: [0] })) }));
  await env.plane.drain(env.plane.consumers.selectionEvaluation, clock.now());
  assert.equal((await revision(pRejectedNew.revisionId)).state, "REJECTED");

  // never early, at the database: the control plane itself cannot expire what is not due (D-EXP-1)
  const youngRecord = await oracle<{ retention_id: string; version: string }>(env, "SELECT retention_id, version::text FROM kauro.retention_records WHERE revision_id = $1", [young.revisionId]);
  await assert.rejects(
    env.plane.units.runSource({ kind: "SYSTEM", serviceId: "retention", correlationId: ids.next() as CorrelationId, agencyId: t.ag.agencyId }, async (uow) => {
      await uow.sources.revisions.lock(young.revisionId as RevisionId);
      return uow.sources.retention.expireRecord(youngRecord.retention_id as RetentionId, Number(youngRecord.version));
    }),
    (e: unknown) => isDomainFailure(e) && e.code === "INTEGRITY_FAILURE" && e.reason === "LIFECYCLE_BINDING_MISSING",
    "a record whose effective deadline lies ahead is refused its expiry",
  );
  await assert.rejects(
    env.plane.units.runSource({ kind: "SYSTEM", serviceId: "retention", correlationId: ids.next() as CorrelationId, agencyId: t.ag.agencyId }, async (uow) => {
      const current = await uow.sources.revisions.lock(pRejectedNew.revisionId);
      return uow.sources.revisions.transition(pRejectedNew.revisionId, current?.version ?? 0, { event: "retention_expires", reason: "RETENTION_DEADLINE" });
    }),
    (e: unknown) => isDomainFailure(e) && e.code === "INTEGRITY_FAILURE",
    "a REJECTED revision whose intake window is open is refused its expiry",
  );

  const swept = await env.plane.sweepers.retention.sweep(env.plane.units, 100);
  assert.deepEqual(swept.failed, []);
  assert.deepEqual([swept.recordsExpired, swept.filesRevoked, swept.revisionsExpired], [2, 2, 2], "two records, two files, two revisions: exactly what is due");

  // the sealed source whose retention ended: record, file and revision, each at the server's instant, never before its deadline
  const oldRecord = await record(old.revisionId);
  assert.equal(oldRecord.state, "EXPIRED");
  assert.ok(oldRecord.expired_at !== null && oldRecord.expired_at.getTime() >= oldRecord.effective_deadline.getTime());
  const oldRevision = await revision(old.revisionId);
  assert.deepEqual([oldRevision.state, oldRevision.terminal_reason], ["EXPIRED", "RETENTION_DEADLINE"]);
  assert.deepEqual(await file(old.fileId), { state: "ADMISSION_REVOKED", revocation_reason: "RETENTION_EXPIRED", object_state: "DELETED", deletion_result: "ALREADY_ABSENT", residual_basis: "LOCATION_POLICY" });
  assert.deepEqual((await eventsOf(env, old.revisionId)).at(-1)?.event_type, "dataset_revision.expired.v1");
  assert.deepEqual((await eventsOf(env, old.retentionId)).map((e) => [e.event_type, e.actor_kind, e.actor_id]).at(-1), ["retention_record.expired.v1", "SERVICE", "retention"]);
  assert.deepEqual((await eventsOf(env, old.fileId)).map((e) => e.event_type).at(-1), "source_file.admission_revoked.v1");

  // the superseded source: its record expired, the revision stays SUPERSEDED, and it keeps its bytes admitted no longer (D-RET-3)
  assert.equal((await record(sup.revisionId)).state, "EXPIRED");
  assert.equal((await revision(sup.revisionId)).state, "SUPERSEDED");
  assert.deepEqual([(await file(sup.fileId)).state, (await file(sup.fileId)).revocation_reason], ["ADMISSION_REVOKED", "RETENTION_EXPIRED"]);

  // the long-rejected revision: EXPIRED, and its terminal facts set once — the rejection's reason stays (D-PERS-3, FINAL-N2)
  const rejectedNow = await revision(rejectedOld);
  assert.deepEqual([rejectedNow.state, rejectedNow.terminal_reason], ["EXPIRED", "SELECTED_INPUT_REJECTED"]);
  const windows = await oracle<{ open: string }>(env, "SELECT count(*) FILTER (WHERE application_expires_at > $2)::text AS open FROM kauro.upload_sessions WHERE revision_id = $1", [rejectedOld, rejectedNow.expired_at]);
  assert.equal(windows.open, "0", "expired only once every intake window had closed");

  // nothing whose deadline lies ahead moved
  assert.equal((await record(young.revisionId)).state, "ACTIVE");
  assert.equal((await revision(young.revisionId)).state, "SEALED");
  assert.equal((await file(young.fileId)).state, "ADMITTED");
  assert.equal((await revision(pRejectedNew.revisionId)).state, "REJECTED");

  // idempotent: a second run finds nothing due
  const again = await env.plane.sweepers.retention.sweep(env.plane.units, 100);
  assert.deepEqual([again.examined, again.acted], [0, 0]);
  // the expiries reach STORAGE_LIFECYCLE and AUTHORITY_JOURNAL through the outbox; the accepted bytes are already released
  const cleaned = await env.plane.drain(env.plane.consumers.storageLifecycle, clock.now());
  assert.deepEqual([cleaned.retried, cleaned.deadLettered], [0, 0]);
});
