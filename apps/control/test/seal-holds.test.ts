// The provider holds of a seal's accepted generations through the control plane (B07-R1; docs/design/B07-upload-source-lifecycle.md
// D-HOLD-1..D-HOLD-3, §11 CMD017, §12.5 RETENTION): SealRevision through the application's own handler (support/product.ts, as apps/api
// binds it) holds the exact accepted generation of every included file at the labelled storage fake before its unit of work (CONTRACT
// FAKE, evidence class SIMULATED: the provider honouring the hold is simulated until B15 binds Cloud Storage), and this package's
// RETENTION sweeper releases what nothing needs any more — a sealed subject's holds when the retention of its bytes ends (before the
// accepted generation is deleted: the provider refuses to delete a held generation), and the holds of a seal that died between its
// provider hold and its commit once their attempt bound passed. Both halves over one real PostgreSQL 17 cluster; a sweep that must
// run after a deadline runs on control-plane units of work whose labelled TEST CLOCK stands that far ahead (controlUnitsAhead), never
// a wait and never a back-dated row. The superuser is the oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ReserveUploadView, SealRevisionView, SelectInputTablesView, SelectionManifestIntakeView } from "@kauro/application";
import { inventoryHashOf, selectionHashOf, type AgencyId, type CorrelationId, type ExecutionContext, type ObjectHoldId, type RevisionId, type SourceUnitOfWork, type SourceUnitOfWorkFactory, type UnitOfWork, type UnitOfWorkOptions } from "@kauro/domain";
import { fixtureSelection } from "@kauro/persistence/testing";
import { clock, controlUnitsAhead, ids, rawTx, startControlEnv, type ControlEnv } from "./support/env.js";
import { asOwner, oracle, oracleRows, project, setSessionLimit, tenant, type ProjectFixture, type Tenant } from "./support/fixtures.js";
import { activate, completedView, product, type Product } from "./support/product.js";
import { buildCsv } from "./support/workbook.js";

let env: ControlEnv;
let app: Product;

before(async () => {
  env = await startControlEnv();
  app = product(env);
  // a deletion is never recorded at a location never read back (D-OBJ-2)
  await env.plane.sweepers.locationPolicy.sweep(env.plane.units, 10);
});

after(async () => {
  await env.stop();
});

const DAY_SECONDS = 86_400;
/** The seal attempt's bound (SEAL_HOLD_ATTEMPT_SECONDS; migration 0020 object_holds_attempt_bound). */
const BOUND_SECONDS = 900;

async function versionOf(revisionId: string): Promise<number> {
  return Number((await oracle<{ version: string }>(env, "SELECT version::text AS version FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId])).version);
}

/** A READY_TO_SEAL revision through the product: CMD013, the browser's upload, CMD014, UPLOAD_INSPECTION, CMD016, SELECTION_EVALUATION. */
async function readyThroughProduct(t: Tenant, p: ProjectFixture, label: string): Promise<{ readonly fileId: string; readonly generation: string; readonly objectName: string; readonly selectionHash: string }> {
  const content = buildCsv(["Email", "Name"], Array.from({ length: 3 }, (_, i) => [`${label}-${i}@example.test`, `${label} ${i}`]));
  const reserved = completedView<ReserveUploadView>(await app.command(t, "CMD013", { revisionId: p.revisionId }, { expectedVersion: await versionOf(p.revisionId), declaredBytes: content.length, declaredFormat: "CSV", displayName: "contacts.csv" }), 201);
  const session = reserved.session as { readonly uploadUrl?: string };
  assert.ok(typeof session.uploadUrl === "string");
  const written = env.storage.uploadThroughSession(session.uploadUrl, content);
  assert.equal(written.outcome, "FINALIZED");
  if (written.outcome !== "FINALIZED") throw new Error("unreachable");
  assert.equal((await app.command(t, "CMD014", { uploadId: reserved.upload.uploadId }, { providerCompletionRef: written.completionRef })).kind, "ACCEPTED");
  await env.plane.drain(env.plane.consumers.uploadInspection, clock.now());
  const file = await oracle<{ file_id: string; provider_generation: string; object_name: string; table_id: string; structure_hash: string }>(
    env,
    `SELECT f.file_id, f.provider_generation, o.object_name, t.table_id, t.structure_hash
       FROM kauro.source_files f JOIN kauro.stored_objects o ON o.object_id = f.accepted_object_id JOIN kauro.source_tables t ON t.file_id = f.file_id
      WHERE f.origin_upload_id = $1 AND f.state = 'ADMITTED'`,
    [reserved.upload.uploadId],
  );
  const inventoryHash = inventoryHashOf(await env.h.app.runSource(asOwner(env, t), (uow) => uow.sources.revisions.inventory(p.revisionId as RevisionId)));
  const document = fixtureSelection(p.revisionId, { fileId: file.file_id, tableId: file.table_id, structureHash: file.structure_hash, origin: "THIS_REVISION" }, inventoryHash);
  const stored = await app.submitManifest<SelectionManifestIntakeView>(t, p.revisionId, document);
  completedView<SelectInputTablesView>(await app.command(t, "CMD016", { revisionId: p.revisionId }, { expectedVersion: await versionOf(p.revisionId), selectionManifestRef: stored.view.selectionManifestId }), 200);
  await env.plane.drain(env.plane.consumers.selectionEvaluation, clock.now());
  assert.equal((await oracle<{ state: string }>(env, "SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [p.revisionId])).state, "READY_TO_SEAL");
  return { fileId: file.file_id, generation: file.provider_generation, objectName: file.object_name, selectionHash: selectionHashOf(document) };
}

/** The seal holds of a file (oracle), oldest first: [state, close reason, release result]. */
async function holdsOf(fileId: string): Promise<ReadonlyArray<readonly [string, string | null, string | null]>> {
  const rows = await oracleRows<{ state: string; close_reason: string | null; release_result: string | null }>(env, "SELECT state, close_reason, release_result FROM kauro.object_holds WHERE file_id = $1 ORDER BY intended_at, hold_id", [fileId]);
  return rows.map((r) => [r.state, r.close_reason, r.release_result] as const);
}

/** A file's admission and its accepted generation in the registry (oracle). */
async function acceptedOf(fileId: string): Promise<{ readonly revocation_reason: string | null; readonly object_state: string; readonly deletion_result: string | null }> {
  return oracle(env, "SELECT f.revocation_reason, o.state AS object_state, o.deletion_result FROM kauro.source_files f JOIN kauro.stored_objects o ON o.object_id = f.accepted_object_id WHERE f.file_id = $1", [fileId]);
}

/** The accepted generation at the labelled storage fake: its status and whether it is under a temporary hold. */
function atProvider(objectName: string, generation: string): { readonly status: string | undefined; readonly held: boolean | undefined } {
  const g = env.storage.generationsOf(env.storage.location("ACCEPTED"), objectName).find((x) => x.generation === generation);
  return { status: g?.status, held: g?.temporaryHold };
}

/** A process death: not a DomainFailure, so nothing of the unit of work it interrupts commits. */
class ProcessDeath extends Error {
  constructor() {
    super("the api process died");
    this.name = "ProcessDeath";
  }
}

/**
 * The request handlers' unit-of-work factory of a process that dies after its first unit of work: CMD017's first unit of work records
 * its holds INTENDED, the provider places them, and the process dies before the seal's unit of work and before the attempt's own
 * release — exactly what a crash between the hold and the commit leaves.
 */
function dyingAfterFirstUnitOfWork(inner: SourceUnitOfWorkFactory): SourceUnitOfWorkFactory {
  let runs = 0;
  const gate = (): void => {
    runs += 1;
    if (runs > 1) throw new ProcessDeath();
  };
  return {
    run<T>(context: ExecutionContext, work: (uow: UnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
      gate();
      return inner.run(context, work, options);
    },
    runSource<T>(context: ExecutionContext, work: (uow: SourceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
      gate();
      return inner.runSource(context, work, options);
    },
  };
}

test("B07-R1 RETENTION releases a sealed subject's provider hold when the retention of its bytes ends: sealed through SealRevision, the accepted generation is held and the provider refuses to delete it; before the hard deadline RETENTION releases nothing; past it (the TEST CLOCK fifteen days ahead) the file is revoked RETENTION_EXPIRED, the hold released at the provider before the deletion and the generation deleted; a release the provider does not answer leaves the hold RELEASING and the deletion DELETION_FAILED, and the next sweep past the attempt bound drives the release again so DELETION_RETRIES deletes", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "holds-retention");
  await activate(env, t);
  await setSessionLimit(env, t, 10);

  // a sealed subject: its hold is SEALED and the provider holds the generation, refusing its deletion
  const p = await project(env, t);
  const ready = await readyThroughProduct(t, p, "retention");
  completedView<SealRevisionView>(await app.command(t, "CMD017", { revisionId: p.revisionId }, { expectedVersion: await versionOf(p.revisionId), selectionHash: ready.selectionHash }), 200);
  assert.deepEqual(await holdsOf(ready.fileId), [["SEALED", null, null]]);
  assert.deepEqual(atProvider(ready.objectName, ready.generation), { status: "LIVE", held: true });
  await assert.rejects(env.storage.delete(env.storage.location("ACCEPTED"), ready.objectName, ready.generation), (e: { code?: string }) => e.code === "OBJECT_HELD", "the provider refuses to delete a held generation");

  // never early: on the real clock the record is ACTIVE, the file admitted, the hold retained
  const now = await env.plane.sweepers.retention.sweep(env.plane.units, 100);
  assert.deepEqual([now.recordsExpired, now.filesRevoked, now.holdsAbandoned, now.holdsReleased], [0, 0, 0, 0]);
  assert.deepEqual(await holdsOf(ready.fileId), [["SEALED", null, null]]);

  // past the hard deadline (the seal + fourteen days): revoked RETENTION_EXPIRED, released at the provider, then deleted
  const ahead = await controlUnitsAhead(env, 15 * DAY_SECONDS);
  try {
    const swept = await env.plane.sweepers.retention.sweep(ahead.units, 100);
    assert.deepEqual(swept.failed, []);
    assert.deepEqual([swept.recordsExpired, swept.filesRevoked, swept.revisionsExpired], [1, 1, 1]);
  } finally {
    await ahead.close();
  }
  assert.deepEqual(await acceptedOf(ready.fileId), { revocation_reason: "RETENTION_EXPIRED", object_state: "DELETED", deletion_result: "DELETED" }, "released, then deleted by its exact generation");
  assert.deepEqual(await holdsOf(ready.fileId), [["RELEASED", null, "RELEASED"]]);
  assert.equal(atProvider(ready.objectName, ready.generation).held, false);
  assert.notEqual(atProvider(ready.objectName, ready.generation).status, "LIVE");
  const order = env.storage.calls().filter((c) => c.request["objectName"] === ready.objectName && (c.operation === "releaseHold" || c.operation === "delete")).map((c) => `${c.operation} ${c.outcome.split(" ")[0] ?? ""}`);
  assert.deepEqual(order.slice(-2), ["releaseHold RELEASED", "delete DELETED"], "the hold is released before the deletion");

  // a release the provider does not answer: the hold stays RELEASING and the still-held generation refuses its deletion
  const q = await project(env, t);
  const other = await readyThroughProduct(t, q, "retention-unanswered");
  completedView<SealRevisionView>(await app.command(t, "CMD017", { revisionId: q.revisionId }, { expectedVersion: await versionOf(q.revisionId), selectionHash: other.selectionHash }), 200);
  const due = await controlUnitsAhead(env, 15 * DAY_SECONDS);
  try {
    env.storage.failNext("releaseHold", { code: "UNAVAILABLE" });
    const swept = await env.plane.sweepers.retention.sweep(due.units, 100);
    assert.deepEqual([swept.recordsExpired, swept.filesRevoked, swept.revisionsExpired, swept.holdsReleased], [1, 1, 1, 0]);
  } finally {
    await due.close();
  }
  assert.deepEqual(await acceptedOf(other.fileId), { revocation_reason: "RETENTION_EXPIRED", object_state: "DELETION_FAILED", deletion_result: "PROVIDER_ERROR" }, "the provider refused to delete the still-held generation");
  assert.deepEqual(await holdsOf(other.fileId), [["RELEASING", null, null]]);
  assert.deepEqual(atProvider(other.objectName, other.generation), { status: "LIVE", held: true });

  // the next sweep past the attempt bound drives the release again; DELETION_RETRIES then deletes the generation
  const later = await controlUnitsAhead(env, 15 * DAY_SECONDS + BOUND_SECONDS + 60);
  try {
    const again = await env.plane.sweepers.retention.sweep(later.units, 100);
    assert.deepEqual(again.failed, []);
    assert.deepEqual([again.holdsAbandoned, again.holdsReleased], [0, 1]);
    assert.deepEqual(await holdsOf(other.fileId), [["RELEASED", null, "RELEASED"]]);
    assert.equal(atProvider(other.objectName, other.generation).held, false);
    const retried = await env.plane.sweepers.deletionRetries.sweep(later.units, 100);
    assert.deepEqual(retried.failed, []);
    assert.deepEqual(await acceptedOf(other.fileId), { revocation_reason: "RETENTION_EXPIRED", object_state: "DELETED", deletion_result: "DELETED" });
    // idempotent: nothing is held, releasable or abandoned any more
    const idle = await env.plane.sweepers.retention.sweep(later.units, 100);
    assert.deepEqual([idle.holdsAbandoned, idle.holdsReleased, idle.failed.length], [0, 0, 0]);
  } finally {
    await later.close();
  }
});

test("B07-R1 crash between the provider hold and the commit: a seal whose process dies after its hold was placed — neither its unit of work nor its own release ran — leaves its hold INTENDED and the generation held (a replacement is still refused), nothing sealed; RETENTION leaves the attempt alone before its bound (and the database refuses to abandon it early) and, once the bound passed (the TEST CLOCK ahead), abandons it and releases the generation at the provider; the revision then seals with a new hold", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "holds-crash");
  await activate(env, t);
  await setSessionLimit(env, t, 10);
  const p = await project(env, t);
  const ready = await readyThroughProduct(t, p, "crash");
  const version = await versionOf(p.revisionId);

  // the process dies after CMD017's first unit of work (its holds INTENDED) and the provider placement
  const dying = product(env, { unitOfWork: dyingAfterFirstUnitOfWork(env.h.app) });
  await assert.rejects(dying.command(t, "CMD017", { revisionId: p.revisionId }, { expectedVersion: version, selectionHash: ready.selectionHash }), ProcessDeath);
  assert.deepEqual(await holdsOf(ready.fileId), [["INTENDED", null, null]]);
  assert.deepEqual(atProvider(ready.objectName, ready.generation), { status: "LIVE", held: true });
  assert.deepEqual(env.storage.calls("placeHold").filter((c) => c.request["objectName"] === ready.objectName).map((c) => c.outcome), [`HELD ${ready.generation}`]);
  assert.equal(env.storage.calls("releaseHold").filter((c) => c.request["objectName"] === ready.objectName).length, 0, "the dead process released nothing");
  const state = await oracle<{ state: string; sealed: string }>(env, "SELECT state, (SELECT count(*) FROM kauro.sealed_manifests WHERE revision_id = $1)::text AS sealed FROM kauro.dataset_revisions WHERE revision_id = $1", [p.revisionId]);
  assert.deepEqual([state.state, state.sealed], ["READY_TO_SEAL", "0"]);
  assert.throws(() => env.storage.plantObject(env.storage.location("ACCEPTED"), ready.objectName, new TextEncoder().encode("x"), { overwrite: true }), (e: { code?: string }) => e.code === "OBJECT_HELD");

  // before the bound: never early — RETENTION does nothing, and the database refuses an early abandonment
  const early = await env.plane.sweepers.retention.sweep(env.plane.units, 100);
  assert.deepEqual([early.holdsAbandoned, early.holdsReleased], [0, 0]);
  assert.deepEqual(await holdsOf(ready.fileId), [["INTENDED", null, null]]);
  const hold = await oracle<{ hold_id: string }>(env, "SELECT hold_id FROM kauro.object_holds WHERE file_id = $1", [ready.fileId]);
  const bound = { kind: "SYSTEM", serviceId: "retention", correlationId: ids.next() as CorrelationId, agencyId: t.ag.agencyId as AgencyId } as const;
  assert.equal(await env.h.control.runSource(bound, (uow) => uow.sources.holds.abandon(hold.hold_id as ObjectHoldId)), false, "the adapter abandons nothing before the bound");
  await assert.rejects(
    rawTx(env.h.controlPool, t.ag.agencyId, "", (c) => c.query("UPDATE kauro.object_holds SET state = 'CLOSED', closed_at = kauro.server_now(), close_reason = 'ABANDONED' WHERE hold_id = $1", [hold.hold_id])),
    (e: { code?: string }) => e.code === "KA072",
    "the database refuses to abandon an attempt before its bound",
  );
  assert.deepEqual(await holdsOf(ready.fileId), [["INTENDED", null, null]]);

  // past the bound: abandoned and released at the provider
  const ahead = await controlUnitsAhead(env, BOUND_SECONDS + 60);
  try {
    const swept = await env.plane.sweepers.retention.sweep(ahead.units, 100);
    assert.deepEqual(swept.failed, []);
    assert.deepEqual([swept.holdsAbandoned, swept.holdsReleased], [1, 1]);
  } finally {
    await ahead.close();
  }
  assert.deepEqual(await holdsOf(ready.fileId), [["RELEASED", "ABANDONED", "RELEASED"]]);
  assert.deepEqual(atProvider(ready.objectName, ready.generation), { status: "LIVE", held: false });

  // the positive control: the revision seals now, with a hold of its own
  completedView<SealRevisionView>(await app.command(t, "CMD017", { revisionId: p.revisionId }, { expectedVersion: version, selectionHash: ready.selectionHash }), 200);
  assert.deepEqual(await holdsOf(ready.fileId), [["RELEASED", "ABANDONED", "RELEASED"], ["SEALED", null, null]]);
  assert.deepEqual(atProvider(ready.objectName, ready.generation), { status: "LIVE", held: true });
});
