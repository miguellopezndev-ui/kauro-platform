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
import {
  inventoryHashOf,
  selectionHashOf,
  type AgencyId,
  type CausationId,
  type CommandJournal,
  type CorrelationId,
  type ExecutionContext,
  type HoldReassertionId,
  type ObjectHoldId,
  type RevisionId,
  type SourceUnitOfWork,
  type SourceUnitOfWorkFactory,
  type StoredObjectId,
  type UnitOfWork,
  type UnitOfWorkOptions,
} from "@kauro/domain";
import { fixtureSelection } from "@kauro/persistence/testing";
import { releaseObjectHolds, type WorkItem } from "../src/index.js";
import { appUnitsAhead, clock, controlUnitsAhead, ids, rawTx, startControlEnv, type ControlEnv } from "./support/env.js";
import { asOwner, oracle, oracleRows, project, setSessionLimit, tenant, type ProjectFixture, type Tenant } from "./support/fixtures.js";
import { activate, completedView, problemOf, product, type Product } from "./support/product.js";
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

/** A simulated failure of the seal's unit of work before its COMMIT (not a DomainFailure: nothing of it commits). */
class SealFailure extends Error {
  constructor() {
    super("the seal failed before its COMMIT");
    this.name = "SealFailure";
  }
}

/** A one-shot hold point inside a unit of work: `reached` once a unit of work arrived there, which then waits for `release()`. */
interface UnitHold {
  readonly reached: Promise<void>;
  release(): void;
}

/**
 * The request handlers' unit-of-work factory with a hold point at the journal commit (the seal's whole unit of work written, its
 * provider holds placed, before COMMIT) — the api world's `journal.commit` hold point, for the product the control-plane tests
 * drive. Armed with `fail`, the unit of work throws there instead (a seal failing before its COMMIT). Unarmed, it passes through.
 */
function journalCommitHolds(inner: SourceUnitOfWorkFactory): { readonly units: SourceUnitOfWorkFactory; arm(options?: { readonly fail?: Error }): UnitHold } {
  let armed: { readonly signal: () => void; readonly released: Promise<void>; readonly fail: Error | undefined } | null = null;
  const pass = async (): Promise<void> => {
    const hold = armed;
    if (hold === null) return;
    armed = null;
    hold.signal();
    if (hold.fail !== undefined) throw hold.fail;
    await hold.released;
  };
  const decorate = <U extends UnitOfWork>(uow: U): U => {
    const journal: CommandJournal = {
      reserve: (identity, digest, correlationId) => uow.journal.reserve(identity, digest, correlationId),
      async commit(entryId, result) {
        await pass();
        return uow.journal.commit(entryId, result);
      },
      markUncertain: (entryId) => uow.journal.markUncertain(entryId),
      find: (identity) => uow.journal.find(identity),
    };
    return new Proxy(uow, {
      get(target, property) {
        if (property === "journal") return journal;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  return {
    units: {
      run<T>(context: ExecutionContext, work: (uow: UnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
        return inner.run(context, (uow) => work(decorate(uow)), options);
      },
      runSource<T>(context: ExecutionContext, work: (uow: SourceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
        return inner.runSource(context, (uow) => work(decorate(uow)), options);
      },
    },
    arm(options = {}) {
      let signal: () => void = () => undefined;
      let release: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      armed = { signal, released, fail: options.fail };
      return { reached, release };
    },
  };
}

/** The accepted object id of a file (oracle). */
async function acceptedObjectIdOf(fileId: string): Promise<StoredObjectId> {
  return (await oracle<{ accepted_object_id: string }>(env, "SELECT accepted_object_id FROM kauro.source_files WHERE file_id = $1", [fileId])).accepted_object_id as StoredObjectId;
}

/** One control-plane work item of the tenant (the RETENTION sweeper's provenance). */
function retentionItem(t: Tenant): WorkItem {
  return { serviceId: "retention", agencyId: t.ag.agencyId as AgencyId, correlationId: ids.next() as CorrelationId, causationId: ids.next() as CausationId };
}

/** Replaces the accepted object at the labelled storage fake out of band; the provider's refusal code, or null when it replaced it. */
function replaceAtProvider(objectName: string, label: string): string | null {
  try {
    env.storage.plantObject(env.storage.location("ACCEPTED"), objectName, new TextEncoder().encode(`Email,Name\n${label}@example.com,Replaced\n`), { overwrite: true });
    return null;
  } catch (e) {
    return String((e as { code?: unknown }).code ?? e);
  }
}

/** The live generations under an accepted name at the labelled storage fake. */
function liveGenerationsOf(objectName: string): ReadonlyArray<string> {
  return env.storage
    .generationsOf(env.storage.location("ACCEPTED"), objectName)
    .filter((g) => g.status === "LIVE")
    .map((g) => g.generation);
}

/** What a seal of the revision wrote (oracle): sealed manifests and the revision's state. */
async function sealedOf(revisionId: string): Promise<{ readonly state: string; readonly manifests: string }> {
  return oracle(env, "SELECT state, (SELECT count(*) FROM kauro.sealed_manifests WHERE revision_id = $1)::text AS manifests FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId]);
}

test("B07-R1 release retries, the reviewer's reproduction of the re-check of 77d5fa6: a failed seal's release left RELEASING (the provider did not answer), the file still ADMITTED and the revision READY_TO_SEAL; past the claim's bound two release retries run — the first held at the provider (storage.holdNext releaseHold), the second finds the release claimed by the first and leaves it (IN_FLIGHT), recording nothing; a new SealRevision meanwhile places no hold while a release of the generation may still land (503 GENERATION_NOT_OBSERVED, nothing sealed); the first release then lands and is recorded by its claimant, the accepted object is overwritten and the seal resumed: nothing seals a generation that vanished (on 77d5fa6 the second retry recorded RELEASED, the seal held the generation, the late release cleared that hold, the overwrite succeeded and the seal committed the vanished generation)", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "holds-release-retries");
  await activate(env, t);
  await setSessionLimit(env, t, 10);
  const p = await project(env, t);
  const ready = await readyThroughProduct(t, p, "release-retries");
  const body = { expectedVersion: await versionOf(p.revisionId), selectionHash: ready.selectionHash };
  const objectId = await acceptedObjectIdOf(ready.fileId);

  // a failed seal whose cleanup stays RELEASING: the seal fails before its COMMIT and the provider does not answer its release
  const failing = journalCommitHolds(env.h.app);
  failing.arm({ fail: new SealFailure() });
  env.storage.failNext("releaseHold", { code: "UNAVAILABLE" });
  await assert.rejects(product(env, { unitOfWork: failing.units }).command(t, "CMD017", { revisionId: p.revisionId }, body), (e: { cause?: unknown }) => e instanceof SealFailure || e.cause instanceof SealFailure);
  assert.deepEqual(await holdsOf(ready.fileId), [["RELEASING", "REFUSED", null]]);
  assert.deepEqual(atProvider(ready.objectName, ready.generation), { status: "LIVE", held: true });
  assert.deepEqual(await sealedOf(p.revisionId), { state: "READY_TO_SEAL", manifests: "0" });

  // past the bound (control-plane units of work whose TEST CLOCK stands 960 s ahead): two release retries of the same generation
  const ahead = await controlUnitsAhead(env, BOUND_SECONDS + 60);
  let secondKind = "";
  let firstKind = "";
  let sealReachedCommit = false;
  let overwrite: string | null = null;
  let sealAnswer: Awaited<ReturnType<Product["command"]>> | undefined;
  const placementsBefore = env.storage.calls("placeHold").filter((c) => c.request["objectName"] === ready.objectName).length;
  try {
    const firstAtProvider = env.storage.holdNext("releaseHold");
    const first = releaseObjectHolds(env.storage, ahead.units, retentionItem(t), objectId);
    await firstAtProvider.reached;
    secondKind = (await releaseObjectHolds(env.storage, ahead.units, retentionItem(t), objectId)).kind;

    // a new SealRevision, held at its journal commit once its unit of work is written (after any hold it placed)
    const retry = journalCommitHolds(env.h.app);
    const atCommit = retry.arm();
    const sealing = product(env, { unitOfWork: retry.units }).command<typeof body, SealRevisionView>(t, "CMD017", { revisionId: p.revisionId }, body);
    sealReachedCommit = (await Promise.race([atCommit.reached.then(() => true), sealing.then(() => false, () => false)])) === true;

    // the first release lands at the provider now, then the accepted object is overwritten, then the seal resumes
    firstAtProvider.release();
    firstKind = (await first).kind;
    overwrite = replaceAtProvider(ready.objectName, "after-late-release");
    atCommit.release();
    sealAnswer = await sealing;
  } finally {
    await ahead.close();
  }

  // the invariant: a seal that committed names the generation the provider still holds live, and the overwrite was refused
  const sealed = await sealedOf(p.revisionId);
  if (sealAnswer?.kind === "COMPLETED" || sealed.state === "SEALED") {
    assert.deepEqual(liveGenerationsOf(ready.objectName), [ready.generation], "the seal committed a generation the provider no longer holds");
    assert.equal(overwrite, "OBJECT_HELD");
  }
  // how it holds now: the second retry left the claimed release to its claimant; the seal placed no hold while a release of the
  // generation could still land and answered 503 GENERATION_NOT_OBSERVED with nothing sealed; the claimant recorded its answer
  assert.equal(secondKind, "IN_FLIGHT", "a release claimed by another caller is left to it");
  assert.equal(sealReachedCommit, false, "the seal did not reach its commit");
  assert.ok(sealAnswer !== undefined);
  assert.deepEqual(problemOf(sealAnswer), { status: 503, code: "CAPACITY_UNAVAILABLE", reason: "GENERATION_NOT_OBSERVED" });
  assert.equal(env.storage.calls("placeHold").filter((c) => c.request["objectName"] === ready.objectName).length, placementsBefore, "no hold was placed while a release could still land");
  assert.equal(firstKind, "RELEASED");
  assert.deepEqual(await holdsOf(ready.fileId), [["RELEASED", "REFUSED", "RELEASED"]]);
  assert.deepEqual(sealed, { state: "READY_TO_SEAL", manifests: "0" });
  assert.equal(overwrite, null, "nothing held the generation any more");
  const claims = await oracleRows<{ sequence: number; result: string | null }>(env, "SELECT sequence, release_result AS result FROM kauro.object_hold_releases WHERE object_id = $1 ORDER BY sequence", [objectId]);
  assert.deepEqual(claims.map((c) => [c.sequence, c.result]), [[1, null], [2, "RELEASED"]], "the failed seal's claim lapsed unanswered; the first retry's claim recorded the answer");

  // the failed seal's own claim may still land until its in-flight bound: a seal now places no hold (503) ...
  assert.deepEqual(problemOf(await app.command(t, "CMD017", { revisionId: p.revisionId }, body)), { status: 503, code: "CAPACITY_UNAVAILABLE", reason: "GENERATION_NOT_OBSERVED" });
  // ... and once that bound passed (request handlers whose TEST CLOCK stands 920 s ahead) it places one, which meets the changed
  // generation: 409 GENERATION_CHANGED, nothing sealed
  const later = await appUnitsAhead(env, BOUND_SECONDS + 20);
  try {
    assert.deepEqual(problemOf(await product(env, { unitOfWork: later.units }).command(t, "CMD017", { revisionId: p.revisionId }, body)), { status: 409, code: "PRECONDITION_FAILED", reason: "GENERATION_CHANGED" });
  } finally {
    await later.close();
  }
  assert.deepEqual(await sealedOf(p.revisionId), { state: "READY_TO_SEAL", manifests: "0" });
  assert.equal(env.storage.calls("placeHold").filter((c) => c.request["objectName"] === ready.objectName).at(-1)?.outcome, "GENERATION_NOT_LIVE");
});

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

/** The recorded re-assertions of a file's sealed holds (oracle), oldest first: [result, by whom]. */
async function reassertionsOf(fileId: string): Promise<ReadonlyArray<readonly [string, string]>> {
  const rows = await oracleRows<{ result: string; reasserted_by: string }>(
    env,
    "SELECT a.result, a.reasserted_by FROM kauro.object_hold_reassertions a JOIN kauro.object_holds h ON h.hold_id = a.hold_id WHERE h.file_id = $1 ORDER BY a.observed_at, a.reassertion_id",
    [fileId],
  );
  return rows.map((r) => [r.result, r.reasserted_by] as const);
}

/** The provider's hold placements on an accepted name, in call order (their outcomes). */
function placementsOn(objectName: string): ReadonlyArray<string> {
  return env.storage
    .calls("placeHold")
    .filter((c) => c.request["objectName"] === objectName)
    .map((c) => c.outcome.split(" ")[0] ?? "");
}

test("B07-R1 (second re-check) the seal re-asserts its holds after its commit and never answers a vanished generation silently: (a) a hold removed at the provider after the placement — outside every claim, even again while the re-assertion observes it — is placed again until the provider reports the live generation held (recorded HELD; a replacement is refused); (b) a generation released and replaced before the commit is recorded GENERATION_NOT_LIVE and handed to OBJECT_INVENTORY, which re-asserts it and revokes the file naming the sealed revision (GENERATION_MISSING: its first comparison already deleted the unregistered replacement); (c) a re-assertion the provider did not answer is left unconfirmed and OBJECT_INVENTORY re-asserts it once the attempt bound passed (never before); each runtime records only its own re-assertions", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "holds-reassert");
  await activate(env, t);
  await setSessionLimit(env, t, 10);
  const accepted = env.storage.location("ACCEPTED");

  // (a) the hold vanishes at the provider between the placement and the commit, and again while the re-assertion observes it
  const pa = await project(env, t);
  const a = await readyThroughProduct(t, pa, "reassert-missing");
  const holdingA = journalCommitHolds(env.h.app);
  const commitA = holdingA.arm();
  const sealingA = product(env, { unitOfWork: holdingA.units }).command<{ expectedVersion: number; selectionHash: string }, SealRevisionView>(t, "CMD017", { revisionId: pa.revisionId }, { expectedVersion: await versionOf(pa.revisionId), selectionHash: a.selectionHash });
  const observing = env.storage.holdNext("stat");
  try {
    await commitA.reached;
    assert.equal(await env.storage.releaseHold(accepted, a.objectName, a.generation), "RELEASED", "a release no claim fences, outside the platform's discipline");
  } finally {
    commitA.release();
  }
  await observing.reached;
  // the re-assertion placed the hold again and is observing it: the hold is removed once more before the observation lands
  assert.equal(atProvider(a.objectName, a.generation).held, true);
  await env.storage.releaseHold(accepted, a.objectName, a.generation);
  observing.release();
  assert.equal(completedView<SealRevisionView>(await sealingA, 200).revision.state, "SEALED");
  assert.deepEqual(placementsOn(a.objectName), ["HELD", "HELD", "HELD"], "the seal's placement, the re-assertion, and the hold placed again once found missing");
  assert.deepEqual(await reassertionsOf(a.fileId), [["HELD", "SEAL"]]);
  assert.deepEqual(atProvider(a.objectName, a.generation), { status: "LIVE", held: true });
  assert.equal(replaceAtProvider(a.objectName, "after-reassertion"), "OBJECT_HELD");

  // (b) the generation released and replaced at the provider before the commit: the seal commits (its answer is the journaled 200),
  // its re-assertion finds the generation not live and records it — handed to OBJECT_INVENTORY, which revokes the file
  const pb = await project(env, t);
  const b = await readyThroughProduct(t, pb, "reassert-replaced");
  const holdingB = journalCommitHolds(env.h.app);
  const commitB = holdingB.arm();
  const sealingB = product(env, { unitOfWork: holdingB.units }).command<{ expectedVersion: number; selectionHash: string }, SealRevisionView>(t, "CMD017", { revisionId: pb.revisionId }, { expectedVersion: await versionOf(pb.revisionId), selectionHash: b.selectionHash });
  try {
    await commitB.reached;
    await env.storage.releaseHold(accepted, b.objectName, b.generation);
    assert.equal(replaceAtProvider(b.objectName, "before-commit"), null);
  } finally {
    commitB.release();
  }
  completedView<SealRevisionView>(await sealingB, 200);
  assert.deepEqual(await reassertionsOf(b.fileId), [["GENERATION_NOT_LIVE", "SEAL"]], "never a silent success: the finding is recorded before the answer");
  assert.deepEqual(placementsOn(b.objectName), ["HELD", "GENERATION_NOT_LIVE"]);
  const inventory = await env.plane.sweepers.objectInventory.sweep(env.plane.units, 100);
  assert.deepEqual(inventory.failed, []);
  assert.ok(inventory.holdsReasserted >= 1 && inventory.admissionsRevoked >= 1);
  assert.deepEqual(await reassertionsOf(b.fileId), [["GENERATION_NOT_LIVE", "SEAL"], ["GENERATION_NOT_LIVE", "OBJECT_INVENTORY"]]);
  // the inventory's first comparison registered the replacement as an unregistered generation and deleted it, so the sealed
  // generation is missing at the provider when the hand-off reaches the revocation
  assert.equal((await oracle<{ revocation_reason: string | null }>(env, "SELECT revocation_reason FROM kauro.source_files WHERE file_id = $1", [b.fileId])).revocation_reason, "GENERATION_MISSING");
  const revocation = await oracle<{ payload: { sealedByRevisionIds?: ReadonlyArray<string>; revocationReason?: string } }>(
    env,
    "SELECT payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'source_file.admission_revoked.v1'",
    [b.fileId],
  );
  assert.deepEqual([revocation.payload.revocationReason, revocation.payload.sealedByRevisionIds], ["GENERATION_MISSING", [pb.revisionId]], "the revocation names the sealed revision");
  assert.deepEqual(await reassertionsOf(a.fileId), [["HELD", "SEAL"]], "a confirmed hold is not re-asserted again");

  // (c) the provider does not answer the re-assertion: nothing is recorded, the seal answers its journaled 200; OBJECT_INVENTORY
  // leaves the hold alone before the attempt bound and re-asserts it after it (control-plane units of work 960 s ahead)
  const pc = await project(env, t);
  const c = await readyThroughProduct(t, pc, "reassert-unanswered");
  const holdingC = journalCommitHolds(env.h.app);
  const commitC = holdingC.arm();
  const sealingC = product(env, { unitOfWork: holdingC.units }).command<{ expectedVersion: number; selectionHash: string }, SealRevisionView>(t, "CMD017", { revisionId: pc.revisionId }, { expectedVersion: await versionOf(pc.revisionId), selectionHash: c.selectionHash });
  try {
    await commitC.reached;
    env.storage.failNext("placeHold", { code: "UNAVAILABLE" });
  } finally {
    commitC.release();
  }
  completedView<SealRevisionView>(await sealingC, 200);
  assert.deepEqual(await reassertionsOf(c.fileId), []);
  await env.plane.sweepers.objectInventory.sweep(env.plane.units, 100);
  assert.deepEqual(await reassertionsOf(c.fileId), [], "never before the attempt bound");
  const ahead = await controlUnitsAhead(env, BOUND_SECONDS + 60);
  try {
    const swept = await env.plane.sweepers.objectInventory.sweep(ahead.units, 100);
    assert.deepEqual(swept.failed, []);
  } finally {
    await ahead.close();
  }
  assert.deepEqual(await reassertionsOf(c.fileId), [["HELD", "OBJECT_INVENTORY"]]);
  assert.deepEqual(atProvider(c.objectName, c.generation), { status: "LIVE", held: true });

  // each runtime records only its own re-assertions (row security): a request handler never OBJECT_INVENTORY's, the control plane
  // never the seal's
  const sealedHold = (await oracle<{ hold_id: string }>(env, "SELECT hold_id FROM kauro.object_holds WHERE file_id = $1 AND state = 'SEALED'", [c.fileId])).hold_id as ObjectHoldId;
  const record = (by: "SEAL" | "OBJECT_INVENTORY") => (uow: SourceUnitOfWork) => uow.sources.holds.recordReassertion({ reassertionId: ids.next() as HoldReassertionId, holdId: sealedHold, result: "HELD", reassertedBy: by });
  const sqlState = (e: unknown): string | undefined => String((e as { cause?: { code?: unknown } }).cause?.code ?? (e as { code?: unknown }).code);
  await assert.rejects(env.h.app.runSource(asOwner(env, t), record("OBJECT_INVENTORY")), (e: unknown) => sqlState(e) === "42501");
  const bound = { kind: "SYSTEM", serviceId: "object-inventory", correlationId: ids.next() as CorrelationId, agencyId: t.ag.agencyId as AgencyId } as const;
  await assert.rejects(env.h.control.runSource(bound, record("SEAL")), (e: unknown) => sqlState(e) === "42501");
});
