// The pg adapters of the B07 source-store ports (packages/persistence/src/source/*; mandate B07-PERSISTENCE of
// docs/design/B07-upload-source-lifecycle.md §15) on a real PostgreSQL 17 (07 "Acceptance obligations"). Every repository method
// runs through the unit of work of its runtime role — `runSource` on the request-handler pool (kauro_app_test, a TENANT context)
// or the control-plane pool (kauro_control_test, a SYSTEM context bound to the work item's agency, D-CTRL-1) — so the adapters are
// judged by the same policies, grants and guards the product meets; the superuser is the oracle only. Every instant is the
// server's (D-CLOCK-1): the adapters write kauro.server_now() in SQL, and the tests hand them caller instants that are plainly wrong
// (CALLER_INSTANT) to show none of them reaches a column. A fixture that must stand in the past (an upload initiated a day ago, a
// source sealed fifteen days ago) runs the same adapters, or the @kauro/persistence/testing source-lifecycle fixture, inside a
// transaction whose labelled TEST CLOCK it positions (clockAt) — never a back-dated row. Interleavings are fixed by lock waits
// observed in pg_stat_activity, never by time. Provider facts (generations, the scanner's report, a read-back) are those of the
// labelled contract fakes (contract-fake-*, evidence class SIMULATED); no provider port is reached here.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { Client, PoolClient } from "pg";
import type { Sha256Hex } from "@kauro/contracts";
import {
  PROVIDER_SESSION_LIFETIME_SECONDS,
  RETENTION_POLICY_VERSION,
  PRICING_DEFINITION,
  acceptedObjectName,
  actorOf,
  evaluationHashOf,
  inspectionReceiptHashOf,
  inventoryHashOf,
  isDomainFailure,
  parserProfileHashOf,
  quarantineObjectName,
  selectionHashOf,
  sourceRevisionManifestHashOf,
  tableStructureHashOf,
  textDigest,
  type ActingContext,
  type ActorRef,
  type AgencyId,
  type AggregateKind,
  type CausationId,
  type ClientId,
  type DomainFailure,
  type EvaluationId,
  type EventPayload,
  type EventPublisher,
  type EventType,
  type InspectionReceiptId,
  type MembershipId,
  type PlanId,
  type ProjectId,
  type ProjectionId,
  type RetentionAnchorId,
  type RetentionId,
  type RevisionId,
  type SelectionManifestDocument,
  type SelectionManifestId,
  type SourceFileId,
  type SourceStore,
  type SourceTableId,
  type SourceUnitOfWork,
  type StoredObjectId,
  type SystemContext,
  type TenantContext,
  type UploadId,
  type UploadSessionRecord,
  type UserId,
  type VersionedWrite,
} from "@kauro/domain";
import { PgEventPublisher, PgSourceStore, SOURCE_CONSTRAINT_FAILURES, failureOfSqlState, type KauroPool, type SourceAudience } from "../src/index.js";
import { barrier, clock, correlation, ids, start, waitForLockWait, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import {
  admitSourceFile,
  bindSourceSelection,
  clockAt,
  fixtureSelection,
  sealSourceRevision,
  sealedManifestOf,
  type AdmittedSourceFixture,
  type ReadySourceFixture,
  type SourceFixtureScope,
  type SourceFixtureSessions,
} from "../src/testing/source-lifecycle.js";
import { plan, targetContract } from "./support.js";

let h: Harness;
let capabilityId: string;
let rawApp: Client;
let rawControl: Client;

before(async () => {
  h = await start();
  capabilityId = await h.offeredCapability("CLEAN");
  rawApp = await h.pg.connect("kauro_app_test");
  rawControl = await h.pg.connect("kauro_control_test");
});

after(async () => {
  await rawControl.end();
  await rawApp.end();
  await h.stop();
});

const GB = 1_000_000_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The application name of the request-handler pool of the harness (pg_stat_activity). */
const API = "kauro-test-api";
/** A caller instant no adapter may write: every stamp is the server's (D-CLOCK-1). */
const CALLER_INSTANT = "2000-01-01T00:00:00.000Z";
const SERVICE = "upload-inspection";
const STORAGE = "contract-fake-storage";
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// --- tenants, contexts and events ------------------------------------------------------------------------------------------------

/** An agency of its own (so the agency-wide capacity ledger of one case never decides another) with its owner and one client. */
interface Tenant {
  readonly ag: AgencyFixture;
  readonly clientId: ClientId;
}

let tenants = 0;
async function tenant(label: string): Promise<Tenant> {
  const owner = await h.person(`b07-adapters-${label}-${++tenants}`);
  const ag = await h.createAgency(owner, `Agency ${label}`);
  const clientId = await h.endClient(ag, await h.processingAuthority(ag));
  return { ag, clientId };
}

function asOwner(t: Tenant): TenantContext {
  return h.tenant(t.ag.agencyId, t.ag.ownerUserId);
}

function asControl(t: Tenant | null): SystemContext {
  return t === null ? { kind: "SYSTEM", serviceId: SERVICE, correlationId: correlation() } : { kind: "SYSTEM", serviceId: SERVICE, correlationId: correlation(), agencyId: t.ag.agencyId };
}

type Emit = (kind: AggregateKind, id: string, version: number, type: EventType, payload: EventPayload) => Promise<void>;

function emitterOf(events: EventPublisher, actor: ActorRef, agencyId: AgencyId, correlationId = correlation()): Emit {
  return async (kind, id, version, type, payload) => {
    await events.publish({ aggregateKind: kind, aggregateId: id, aggregateVersion: version, agencyId, eventType: type, actor, causationId: ids.next() as CausationId, correlationId, payload });
  };
}

function emitOf(uow: SourceUnitOfWork, t: Tenant): Emit {
  return emitterOf(uow.events, actorOf(uow.context as ActingContext), t.ag.agencyId, uow.context.correlationId);
}

/** A project of the tenant with its DRAFT revision (CMD011 as its handler writes it, with both events). */
async function project(t: Tenant): Promise<{ readonly projectId: ProjectId; readonly revisionId: RevisionId }> {
  return h.app.run(asOwner(t), async (uow) => {
    const projectId = uow.ids.next() as ProjectId;
    const revisionId = uow.ids.next() as RevisionId;
    await uow.projects.insertWithDraftRevision({ projectId, agencyId: t.ag.agencyId, clientId: t.clientId, mode: "CLEAN", purpose: "Source adapters", capabilityId: capabilityId as never, capabilityVersion: "R2-INITIAL", initialRevisionId: revisionId, createdByMembershipId: t.ag.ownerMembershipId, createdAt: clock.now() });
    const actor = { kind: "USER", userId: t.ag.ownerUserId } as const;
    await uow.events.publish({ aggregateKind: "project", aggregateId: projectId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "project.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { projectId, agencyId: t.ag.agencyId, clientId: t.clientId, mode: "CLEAN", initialRevisionId: revisionId } });
    await uow.events.publish({ aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "dataset_revision.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { revisionId, agencyId: t.ag.agencyId, projectId, state: "DRAFT" } });
    return { projectId, revisionId };
  });
}

/** One raw transaction on a runtime pool with the context bound (fixtures that position the TEST CLOCK). */
async function rawTx<T>(pool: KauroPool, agencyId: string, userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.raw.connect();
  let destroy: Error | undefined;
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agencyId, userId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
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

/**
 * The same source adapters inside a transaction the test holds at `at` on the labelled TEST CLOCK (null: the real clock): a
 * fixture in the past written by the adapters themselves, each write by the role that owns it.
 */
async function storeAt<T>(who: SourceAudience, t: Tenant, at: Date | null, fn: (s: PgSourceStore, emit: Emit, c: PoolClient) => Promise<T>): Promise<T> {
  const pool = who === "CONTROL" ? h.controlPool : h.appPool;
  return rawTx(pool, t.ag.agencyId, who === "CONTROL" ? "" : t.ag.ownerUserId, async (c) => {
    if (at !== null) await clockAt(c, at);
    const actor: ActorRef = who === "CONTROL" ? { kind: "SERVICE", serviceId: SERVICE } : { kind: "USER", userId: t.ag.ownerUserId };
    return fn(new PgSourceStore(c, who), emitterOf(new PgEventPublisher(c, ids, clock), actor, t.ag.agencyId), c);
  });
}

function sessionsOf(t: Tenant): SourceFixtureSessions {
  return {
    app: (fn) => rawTx(h.appPool, t.ag.agencyId, t.ag.ownerUserId, (c) => fn(c)),
    control: (fn) => rawTx(h.controlPool, t.ag.agencyId, "", (c) => fn(c)),
  };
}

function scopeOf(t: Tenant, projectId: string): SourceFixtureScope {
  return { agencyId: t.ag.agencyId, projectId, ownerUserId: t.ag.ownerUserId, ownerMembershipId: t.ag.ownerMembershipId };
}

// --- assertions -------------------------------------------------------------------------------------------------------------------

function failure(e: unknown): DomainFailure {
  assert.ok(isDomainFailure(e), `expected a DomainFailure, got ${e instanceof Error ? e.stack : String(e)}`);
  return e;
}

function sqlStateOf(e: unknown): string | undefined {
  const cause = (e as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code: unknown }).code) : undefined;
}

/** The typed failure a refusal becomes: its code, its reason and (when given) the database refusal behind it. */
function refused(code: string, reason?: string, sqlState?: string): (e: unknown) => boolean {
  return (e) => {
    const f = failure(e);
    assert.equal(f.code, code, `${f.code} ${f.reason ?? ""}: ${f.message}`);
    if (reason !== undefined) assert.equal(f.reason, reason, f.message);
    if (sqlState !== undefined) assert.equal(sqlStateOf(e), sqlState, f.message);
    return true;
  };
}

function applied<T>(w: VersionedWrite<T>, what: string): T {
  assert.equal(w.kind, "APPLIED", `${what}: ${JSON.stringify(w)}`);
  return (w as { readonly record: T }).record;
}

async function oracle<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await h.oracle.query<T>(sql, params);
  assert.equal(r.rows.length, 1, sql);
  return r.rows[0] as T;
}

/** An instant of the oracle, exactly as the adapters format it. */
function exactSql(expression: string): string {
  return `to_char((${expression}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function plusSeconds(instant: string, seconds: number): Promise<string> {
  return oracle<{ t: string }>(`SELECT ${exactSql("$1::timestamptz + make_interval(secs => $2)")} AS t`, [instant, seconds]).then((r) => r.t);
}

// --- the source lifecycle through the adapters -----------------------------------------------------------------------------------

interface Reserved {
  readonly uploadId: UploadId;
  readonly objectId: StoredObjectId;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly record: UploadSessionRecord;
}

interface Requester {
  readonly membershipId: MembershipId;
  readonly userId: UserId;
}

/**
 * CMD013's first unit of work through the adapters: the revision row first (D-LOCK-1, unless `lockRevision` is false to show the
 * database serializes a writer that skipped it), the quarantine intent, the RESERVED upload, its event and UPLOAD_INITIATED anchor,
 * and — for the revision's first upload — upload_reserved. The caller instants it hands the ports are CALLER_INSTANT.
 */
async function reserveVia(
  s: SourceStore,
  emit: Emit,
  t: Tenant,
  p: { readonly projectId: ProjectId; readonly revisionId: RevisionId },
  bytes: number,
  options: { readonly first?: boolean; readonly lockRevision?: boolean; readonly requester?: Requester } = {},
): Promise<Reserved> {
  const requester = options.requester ?? { membershipId: t.ag.ownerMembershipId, userId: t.ag.ownerUserId };
  const uploadId = ids.next() as UploadId;
  const objectId = ids.next() as StoredObjectId;
  if (options.lockRevision !== false) assert.ok(await s.revisions.lock(p.revisionId), "the revision is visible");
  await s.objects.register({
    objectId,
    agencyId: t.ag.agencyId,
    projectId: p.projectId,
    revisionId: p.revisionId,
    uploadId,
    zone: "QUARANTINE",
    dataClass: "RAW",
    provider: STORAGE,
    locationRef: "QUARANTINE_PRIMARY",
    objectName: quarantineObjectName(t.ag.agencyId, p.projectId, p.revisionId, uploadId),
    createdBy: { kind: "MEMBERSHIP", membershipId: requester.membershipId },
    createdAt: CALLER_INSTANT,
  });
  const record = await s.uploads.insert({
    uploadId,
    agencyId: t.ag.agencyId,
    projectId: p.projectId,
    revisionId: p.revisionId,
    displayName: "contacts export.csv",
    declaredFormat: "CSV",
    reservedBytes: bytes,
    quarantineObjectId: objectId,
    requestedByMembershipId: requester.membershipId,
    requestedByUserId: requester.userId,
  });
  await emit("upload_session", uploadId, 1, "upload_session.reserved.v1", { uploadId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, reservedBytes: bytes, declaredFormat: "CSV", requestedByMembershipId: requester.membershipId, state: "RESERVED" });
  await s.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, uploadId, kind: "UPLOAD_INITIATED", sourceEvidenceHash: null });
  if (options.first === true) {
    const revision = await s.revisions.get(p.revisionId);
    assert.ok(revision);
    const moved = applied(await s.revisions.transition(p.revisionId, revision.version, { event: "upload_reserved", firstUploadId: uploadId }), "upload_reserved");
    await emit("dataset_revision", p.revisionId, moved.version, "dataset_revision.uploading.v1", { revisionId: p.revisionId, agencyId: t.ag.agencyId, projectId: p.projectId, firstUploadId: uploadId, state: "UPLOADING" });
  }
  return { uploadId, objectId, projectId: p.projectId, revisionId: p.revisionId, record };
}

/** CMD013's second unit of work: the session issued under the attempt's fence and its sealed reference stored for the requester. */
async function issueVia(s: SourceStore, emit: Emit, t: Tenant, up: Reserved, attempt = 1, expectedVersion = 1): Promise<UploadSessionRecord> {
  const providerSessionDigest = textDigest(`contract-fake-session-${up.uploadId}-${attempt}`);
  const issued = applied(await s.uploads.transition(up.uploadId, expectedVersion, { event: "session_issued", sessionAttempt: attempt, providerSessionDigest, providerSessionLifetimeSeconds: PROVIDER_SESSION_LIFETIME_SECONDS }), "session_issued");
  await s.sessionSecrets.store({ uploadId: up.uploadId, agencyId: t.ag.agencyId, requestedByUserId: issued.requestedByUserId, sessionAttempt: attempt, keyRef: "contract-fake-vault/test-key:1", nonce: new Uint8Array(randomBytes(12)), ciphertext: new Uint8Array(randomBytes(64)), createdAt: CALLER_INSTANT });
  await emit("upload_session", up.uploadId, issued.version, "upload_session.session_issued.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: up.revisionId, sessionAttempt: attempt, providerSessionDigest });
  return issued;
}

/** CMD014: the completion claim recorded (UPLOADING -> VERIFYING); nothing is admitted by the request. */
async function reportVia(s: SourceStore, emit: Emit, t: Tenant, up: Reserved, generation: string, bytes: number, expectedVersion = 2): Promise<UploadSessionRecord> {
  const claimDigest = textDigest(`contract-fake-completion-${up.uploadId}`);
  const reported = applied(await s.uploads.transition(up.uploadId, expectedVersion, { event: "completion_reported", claimDigest, claim: { generation, bytes } }), "completion_reported");
  await emit("upload_session", up.uploadId, reported.version, "upload_session.completion_reported.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: up.revisionId, completionClaimDigest: claimDigest, reportedByMembershipId: t.ag.ownerMembershipId });
  return reported;
}

/** UPLOAD_INSPECTION step 1-2: the revision row first (D-LOCK-2), the attempt claimed, the provider observation recorded. */
async function claimAndObserveVia(s: SourceStore, emit: Emit, t: Tenant, up: Reserved, generation: string, bytes: number): Promise<{ readonly inspectionFence: number; readonly claimedAt: string }> {
  assert.ok(await s.revisions.lock(up.revisionId));
  const claim = await s.uploads.claimInspectionAttempt(up.uploadId);
  assert.ok(claim, "a VERIFYING upload yields an attempt");
  const current = await s.uploads.lock(up.uploadId);
  assert.ok(current);
  const observed = applied(await s.uploads.recordObservation(up.uploadId, current.version, { generation, bytes }), "observation");
  await emit("upload_session", up.uploadId, observed.version, "upload_session.completion_observed.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: up.revisionId, observedBytes: bytes, claimConsistent: true });
  await s.objects.observe(up.objectId, { generation, bytes, observedAt: CALLER_INSTANT, late: false });
  return claim;
}

interface Admitted extends Reserved {
  readonly fileId: SourceFileId;
  readonly tableId: SourceTableId;
  readonly acceptedObjectId: StoredObjectId;
  readonly acceptedGeneration: string;
  readonly sha256: Sha256Hex;
  readonly bytes: number;
  readonly receiptHash: Sha256Hex;
  readonly structureHash: Sha256Hex;
  readonly parserProfileHash: Sha256Hex;
}

/**
 * UPLOAD_INSPECTION steps 4-5 in one control-plane unit of work (revision row first): the quarantine digest verified, the accepted
 * generation registered, observed and verified, the receipt of the claimed attempt (its start is the claim instant exactly, its
 * scan and completion this transaction's server instant), the file with its one CSV table, ADMITTED and INPUT_ADMITTED.
 */
async function admitVia(s: SourceStore, emit: Emit, t: Tenant, up: Reserved, claim: { readonly inspectionFence: number; readonly claimedAt: string }, generation: string, bytes: number, now: string): Promise<Admitted> {
  const fileId = ids.next() as SourceFileId;
  const tableId = ids.next() as SourceTableId;
  const acceptedObjectId = ids.next() as StoredObjectId;
  const acceptedGeneration = String(BigInt(generation) + 1n);
  const sha256 = textDigest(`bytes-${up.uploadId}`);
  const structureHash = tableStructureHashOf({ fileId, ordinal: 0, kind: "CSV_TABLE", nameDigest: textDigest(""), visibility: "VISIBLE", columnCount: 2, columnLabelDigests: [textDigest("Email"), textDigest("Name")], hasFormulas: false, formulaCache: "NOT_APPLICABLE", mergedCellCount: 0, hiddenRowCount: 0, hiddenColumnCount: 0, issues: [] });
  const parserProfileHash = parserProfileHashOf({ inspector: "data-plane-0.1.0", format: "CSV", encoding: "UTF_8", delimiter: "COMMA" });
  const receiptHash = inspectionReceiptHashOf({ uploadId: up.uploadId, inspectionFence: claim.inspectionFence, observedGeneration: generation, observedBytes: bytes, sha256, outcome: "ADMITTED", acceptedGeneration });
  assert.ok(await s.revisions.lock(up.revisionId));
  await s.objects.verify(up.objectId, sha256, CALLER_INSTANT);
  await s.objects.register({
    objectId: acceptedObjectId,
    agencyId: t.ag.agencyId,
    projectId: up.projectId,
    revisionId: up.revisionId,
    uploadId: up.uploadId,
    fileId,
    zone: "ACCEPTED",
    dataClass: "RAW",
    provider: STORAGE,
    locationRef: "ACCEPTED_PRIMARY",
    objectName: acceptedObjectName(t.ag.agencyId, up.projectId, fileId),
    createdBy: { kind: "SERVICE", serviceId: SERVICE },
    createdAt: CALLER_INSTANT,
    observed: { generation: acceptedGeneration, bytes, observedAt: CALLER_INSTANT, late: false },
  });
  await s.objects.verify(acceptedObjectId, sha256, CALLER_INSTANT);
  await s.inspections.append({
    receiptId: ids.next() as InspectionReceiptId,
    agencyId: t.ag.agencyId,
    uploadId: up.uploadId,
    revisionId: up.revisionId,
    receiptHash,
    inspectionFence: claim.inspectionFence,
    quarantineObjectId: up.objectId,
    observedGeneration: generation,
    observedBytes: bytes,
    sha256,
    completionClaimDigest: textDigest(`contract-fake-completion-${up.uploadId}`),
    claimConsistent: true,
    declaredFormat: "CSV",
    detectedFormat: "CSV",
    structureStatus: "STRUCTURE_VALID",
    scanState: "COVERED_CLEAN",
    semanticStatus: "SEMANTIC_NOT_YET_PROFILED",
    scanner: { engine: "contract-fake-scanner", engineVersion: "SIMULATED-1", signatureVersion: "SIG-1", signaturesPublishedAt: new Date(Date.parse(now) - HOUR_MS).toISOString(), signatureMaxAgeSeconds: 86_400, configHash: textDigest("contract-fake-scanner-config"), scannedAt: now },
    expectedParts: 1,
    expectedBytes: bytes,
    scannedParts: 1,
    scannedBytes: bytes,
    coverage: [{ partDigest: textDigest(`container-${up.uploadId}`), partKind: "CONTAINER", expectedBytes: bytes, scannedBytes: bytes, outcome: "CLEAN" }],
    problems: [],
    parserProfileHash,
    inspectorVersion: "data-plane-0.1.0",
    outcome: "ADMITTED",
    accepted: { objectId: acceptedObjectId, generation: acceptedGeneration, sha256 },
    startedAt: claim.claimedAt,
    completedAt: now,
  });
  await s.files.admit(
    { fileId, storageRef: acceptedObjectId, agencyId: t.ag.agencyId, projectId: up.projectId, originRevisionId: up.revisionId, originUploadId: up.uploadId, inspectionReceiptHash: receiptHash, providerGeneration: acceptedGeneration, sha256, bytes, format: "CSV", scanState: "COVERED_CLEAN", parserProfileHash },
    [
      {
        tableId,
        agencyId: t.ag.agencyId,
        fileId,
        ordinal: 0,
        kind: "CSV_TABLE",
        nameDigest: textDigest(""),
        visibility: "VISIBLE",
        columnCount: 2,
        rowEstimate: 120,
        hasFormulas: false,
        formulaCache: "NOT_APPLICABLE",
        mergedCellCount: 0,
        hiddenRowCount: 0,
        hiddenColumnCount: 0,
        issues: [],
        structureHash,
        columns: [
          { tableId, ordinal: 0, labelDisplay: "Email", labelDigest: textDigest("Email"), labelState: "PRESENT" },
          { tableId, ordinal: 1, labelDisplay: "Name", labelDigest: textDigest("Name"), labelState: "PRESENT" },
        ],
      },
    ],
  );
  await emit("source_file", fileId, 1, "source_file.admitted.v1", { fileId, agencyId: t.ag.agencyId, projectId: up.projectId, originRevisionId: up.revisionId, originUploadId: up.uploadId, inspectionReceiptHash: receiptHash, bytes, format: "CSV" });
  const current = await s.uploads.lock(up.uploadId);
  assert.ok(current);
  const admittedUpload = applied(await s.uploads.transition(up.uploadId, current.version, { event: "inspection_admitted", fileId, receiptHash, inspectionFence: claim.inspectionFence }), "inspection_admitted");
  await emit("upload_session", up.uploadId, admittedUpload.version, "upload_session.admitted.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: up.revisionId, fileId, inspectionReceiptHash: receiptHash, observedBytes: bytes, scanState: "COVERED_CLEAN", detectedFormat: "CSV" });
  await s.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId: up.projectId, revisionId: up.revisionId, uploadId: up.uploadId, kind: "INPUT_ADMITTED", sourceEvidenceHash: receiptHash });
  return { ...up, fileId, tableId, acceptedObjectId, acceptedGeneration, sha256, bytes, receiptHash, structureHash, parserProfileHash };
}

/** A fresh project whose revision holds one file admitted entirely through the adapters (the revision stays UPLOADING). */
async function admittedThroughAdapters(t: Tenant, bytes = 1_234): Promise<Admitted> {
  const p = await project(t);
  const generation = String(1_700_000_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const reserved = await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 4_096, { first: true }));
  await h.app.runSource(asOwner(t), (uow) => issueVia(uow.sources, emitOf(uow, t), t, reserved));
  await h.app.runSource(asOwner(t), (uow) => reportVia(uow.sources, emitOf(uow, t), t, reserved, generation, bytes));
  const claim = await h.control.runSource(asControl(t), (uow) => claimAndObserveVia(uow.sources, emitOf(uow, t), t, reserved, generation, bytes));
  return h.control.runSource(asControl(t), async (uow) => admitVia(uow.sources, emitOf(uow, t), t, reserved, claim, generation, bytes, await uow.serverInstant()));
}

// ---------------------------------------------------------------------------------------------------------------------------------

test("the refusal translation of design §3.3: the envelope, capacity, one-mutable and supersedes-once constraints, the deadline checks and KA070..KA072 become their typed failures", () => {
  const expected: ReadonlyArray<readonly [string, string | undefined, string, string, boolean]> = [
    ["23514", "revision_quota_bytes_within_envelope", "PRECONDITION_FAILED", "REVISION_QUOTA_EXCEEDED", false],
    ["23514", "revision_quota_files_within_envelope", "PRECONDITION_FAILED", "REVISION_FILE_LIMIT", false],
    ["23514", "upload_sessions_reserved_bytes_check", "PRECONDITION_FAILED", "FILE_TOO_LARGE", false],
    ["23514", "upload_capacity_within_limit", "ADMISSION_LIMITED", "UPLOAD_CONCURRENCY_LIMITED", true],
    ["23505", "dataset_revisions_one_mutable_per_project", "PRECONDITION_FAILED", "REVISION_NOT_MUTABLE", false],
    ["23505", "dataset_revisions_supersedes_once", "PRECONDITION_FAILED", "PREDECESSOR_NOT_CURRENT", false],
    ["23514", "retention_records_expiry_not_early", "INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", false],
    ["23514", "upload_sessions_expiry_not_early", "INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", false],
    ["KA070", undefined, "INTEGRITY_FAILURE", "QUOTA_LEDGER", false],
    ["KA071", undefined, "PRECONDITION_FAILED", "FENCE_DISCIPLINE", false],
    ["KA072", undefined, "INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", false],
  ];
  for (const [state, constraint, code, reason, retryable] of expected) {
    const f = failureOfSqlState(state, constraint);
    assert.ok(f, `${state} ${constraint ?? ""}`);
    assert.deepEqual([f.code, f.reason, f.retryable], [code, reason, retryable], `${state} ${constraint ?? ""}`);
  }
  assert.deepEqual(Object.keys(SOURCE_CONSTRAINT_FAILURES).sort(), expected.filter((x) => x[1] !== undefined).map((x) => x[1]).sort());
  // the display name keeps B06's label translation (SCHEMA_VIOLATION on the field); another CHECK stays a reasonless INVALID_REQUEST
  const label = failureOfSqlState("23514", "upload_sessions_display_name_label");
  assert.deepEqual([label?.code, label?.reason, label?.details.fields?.[0]?.field], ["INVALID_REQUEST", "SCHEMA_VIOLATION", "displayName"]);
  assert.equal(failureOfSqlState("23514", "stored_objects_name_scope")?.reason, undefined);
  // a constraint name under another SQLSTATE is not the source refusal
  assert.equal(failureOfSqlState("23505", "revision_quota_bytes_within_envelope"), null);
});

test("runSource binds the context of its unit of work: serverInstant() is the database's transaction time to the microsecond and every stamp the adapters write equals it — no caller instant reaches SQL; a SYSTEM context binds the agency of its work item, and an unbound one discovers work but registers nothing", async () => {
  const t = await tenant("run-source");
  const p = await project(t);
  const reserved = await h.app.runSource(asOwner(t), async (uow) => {
    const first = await uow.serverInstant();
    assert.match(first, EXACT);
    assert.equal(await uow.serverInstant(), first, "one transaction, one server instant");
    const up = await reserveVia(uow.sources, emitOf(uow, t), t, p, 1_000, { first: true });
    // the stamps are the server's, never the caller's CALLER_INSTANT
    assert.equal(up.record.createdAt, first);
    assert.equal(up.record.applicationExpiresAt, await plusSeconds(first, 86_400));
    assert.equal(up.record.displayName, "contacts export.csv", "the request handlers read the display name");
    const intent = await uow.sources.objects.get(up.objectId);
    assert.equal(intent?.createdAt, first);
    const [anchor] = await uow.sources.retention.anchorsOf(p.revisionId);
    assert.equal(anchor?.occurredAt, first);
    const revision = await uow.sources.revisions.get(p.revisionId);
    assert.equal(revision?.state, "UPLOADING");
    return up;
  });
  const stored = await oracle<{ created_at: string; expires: string; object_created: string; anchor_at: string }>(
    `SELECT ${exactSql("u.created_at")} AS created_at, ${exactSql("u.application_expires_at")} AS expires, ${exactSql("o.created_at")} AS object_created, ${exactSql("a.occurred_at")} AS anchor_at
       FROM kauro.upload_sessions u JOIN kauro.stored_objects o ON o.object_id = u.quarantine_object_id
       JOIN kauro.retention_anchors a ON a.upload_id = u.upload_id AND a.anchor_kind = 'UPLOAD_INITIATED' WHERE u.upload_id = $1`,
    [reserved.uploadId],
  );
  assert.deepEqual(stored, { created_at: reserved.record.createdAt, expires: reserved.record.applicationExpiresAt, object_created: reserved.record.createdAt, anchor_at: reserved.record.createdAt });
  assert.notEqual(stored.created_at.slice(0, 4), "2000", "the caller's instant was not written");

  // a SYSTEM context bound to the agency (D-CTRL-1): it sees the tenant's upload, but not its display name (customer text)
  const seen = await h.control.runSource(asControl(t), (uow) => uow.sources.uploads.get(reserved.uploadId));
  assert.equal(seen?.uploadId, reserved.uploadId);
  assert.equal(seen?.displayName, undefined, "the control plane reads no customer text");
  assert.equal(await h.control.run(asControl(t), async () => "the B06 run path binds it too"), "the B06 run path binds it too");
  // bound to another agency it sees nothing of this one
  const other = await tenant("run-source-other");
  assert.equal(await h.control.runSource(asControl(other), (uow) => uow.sources.uploads.get(reserved.uploadId)), null);
  // unbound, it discovers work across tenants through its granted columns, but registers nothing (no agency to write for)
  const unbound = asControl(null);
  await h.control.runSource(unbound, async (uow) => {
    assert.equal((await uow.sources.uploads.get(reserved.uploadId))?.revisionId, p.revisionId);
    assert.ok(Array.isArray(await uow.sources.uploads.findDeadlinePassed(10)));
  });
  await assert.rejects(
    h.control.runSource(unbound, (uow) =>
      uow.sources.objects.register({
        objectId: ids.next() as StoredObjectId,
        agencyId: t.ag.agencyId,
        projectId: p.projectId,
        zone: "QUARANTINE",
        dataClass: "RESIDUAL",
        provider: STORAGE,
        locationRef: "QUARANTINE_PRIMARY",
        objectName: `quarantine/${t.ag.agencyId}/${p.projectId}/${ids.next()}`,
        createdBy: { kind: "SERVICE", serviceId: SERVICE },
        createdAt: CALLER_INSTANT,
      }),
    ),
    refused("NOT_FOUND", "TENANT_CONTEXT_MISSING", "42501"),
  );
  // a SYSTEM context naming something other than a platform agency id binds nothing and runs nothing
  await assert.rejects(h.control.runSource({ ...asControl(t), agencyId: "not-an-agency" as AgencyId }, async () => undefined), refused("INTEGRITY_FAILURE"));
  // a TENANT context runs on the request pool only, a SYSTEM context on the control pool only (B06 D-CTX-1)
  await assert.rejects(h.app.runSource(asControl(t), async () => undefined), refused("INTEGRITY_FAILURE"));
  await assert.rejects(h.control.runSource(asOwner(t), async () => undefined), refused("INTEGRITY_FAILURE"));
});

test("the upload lifecycle through every UploadSessionRepository, SessionSecretRepository, StoredObjectRepository, InspectionReceiptRepository and SourceFileRepository method — reserve, attach, issue, report, claim, observe, inspect, promote, admit — each write by the runtime role that owns it, every instant the server's, the inventory frozen and customer text withheld from the control plane", async () => {
  const t = await tenant("lifecycle");
  const p = await project(t);
  const generation = "1700000000000001";
  const bytes = 1_234;
  // CMD013 unit of work 1: the journal entry reserved first, then the intent, the reservation, and the entry linked to the upload
  const { reserved, entryId } = await h.app.runSource(asOwner(t), async (uow) => {
    const reservation = await uow.journal.reserve(
      { environment: "LOCAL", actor: { kind: "USER", userId: t.ag.ownerUserId }, agencyId: t.ag.agencyId, operation: "CMD013", key: `adapters_${ids.next().replace(/-/g, "")}` },
      textDigest("reserve-request"),
      uow.context.correlationId,
    );
    assert.equal(reservation.kind, "RESERVED");
    if (reservation.kind !== "RESERVED") throw new Error("unreachable");
    const up = await reserveVia(uow.sources, emitOf(uow, t), t, p, 4_096, { first: true });
    await uow.sources.operations.attach(reservation.entryId, "upload_session", up.uploadId);
    // attaching again to the same upload is idempotent
    await uow.sources.operations.attach(reservation.entryId, "upload_session", up.uploadId);
    return { reserved: up, entryId: reservation.entryId };
  });
  assert.deepEqual(await oracle("SELECT state, resource_kind, resource_id::text AS resource_id FROM kauro.command_journal WHERE entry_id = $1", [entryId]), { state: "RESERVED", resource_kind: "upload_session", resource_id: reserved.uploadId });
  // linking the pending entry to another resource is refused
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => uow.sources.operations.attach(entryId, "upload_session", ids.next())), refused("INTEGRITY_FAILURE"));
  assert.equal(reserved.record.state, "RESERVED");
  assert.equal(reserved.record.sessionAttempt, 1, "the first attempt holds issuance fence 1 (D-RUN-2)");
  assert.equal(reserved.record.providerCancellationState, "NOT_REQUESTED");

  // CMD013 unit of work 2: the session issued, its horizon the server's issue instant + the lifetime, the sealed reference stored
  const issued = await h.app.runSource(asOwner(t), async (uow) => {
    const now = await uow.serverInstant();
    const record = await issueVia(uow.sources, emitOf(uow, t), t, reserved);
    assert.equal(record.sessionIssuedAt, now);
    assert.equal(record.providerSessionExpiresAt, await plusSeconds(now, PROVIDER_SESSION_LIFETIME_SECONDS));
    const secret = await uow.sources.sessionSecrets.readOwn(reserved.uploadId);
    assert.ok(secret, "the requester reads the secret while UPLOADING");
    assert.equal(secret.createdAt, now);
    assert.equal(secret.sessionAttempt, 1);
    assert.equal(secret.nonce.length, 12);
    assert.ok(secret.nonce instanceof Uint8Array && !Buffer.isBuffer(secret.nonce), "a plain Uint8Array");
    return record;
  });
  assert.equal(issued.state, "UPLOADING");
  assert.equal(issued.version, 2);

  // reads: get, lock, the page, the state filter, the ledgers
  const pristine = await project(t);
  await h.app.runSource(asOwner(t), async (uow) => {
    assert.equal((await uow.sources.uploads.lock(reserved.uploadId))?.state, "UPLOADING");
    const page = await uow.sources.uploads.listByRevision(p.revisionId, { limit: 10 });
    assert.deepEqual(page.map((u) => u.uploadId), [reserved.uploadId]);
    const last = page[0];
    assert.ok(last);
    assert.deepEqual(await uow.sources.uploads.listByRevision(p.revisionId, { limit: 10, after: { createdAt: last.createdAt, uploadId: last.uploadId } }), [], "the exact cursor excludes the row it names");
    assert.deepEqual((await uow.sources.uploads.inStates(p.revisionId, ["UPLOADING", "VERIFYING"])).map((u) => u.uploadId), [reserved.uploadId]);
    assert.deepEqual(await uow.sources.uploads.inStates(p.revisionId, ["ADMITTED"]), []);
    assert.deepEqual(await uow.sources.uploads.quota(p.revisionId), { revisionId: p.revisionId, reservedBytes: 4_096, fileCount: 1 });
    assert.deepEqual(await uow.sources.uploads.capacity(t.ag.agencyId), { agencyId: t.ag.agencyId, activeSessions: 1, sessionLimit: 2 });
    assert.deepEqual(await uow.sources.uploads.quota(pristine.revisionId), { revisionId: pristine.revisionId, reservedBytes: 0, fileCount: 0 });
  });

  // CMD014: the completion claim, recorded as a claim
  const reported = await h.app.runSource(asOwner(t), (uow) => reportVia(uow.sources, emitOf(uow, t), t, reserved, generation, bytes));
  assert.deepEqual([reported.state, reported.claim], ["VERIFYING", { generation, bytes }]);
  assert.equal(await h.app.runSource(asOwner(t), (uow) => uow.sources.sessionSecrets.readOwn(reserved.uploadId)), null, "no secret once the upload left UPLOADING");

  // UPLOAD_INSPECTION: the claim (its instant returned exactly as the database stamped it) and the observation, in one unit of work
  const claim = await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    const c = await claimAndObserveVia(uow.sources, emitOf(uow, t), t, reserved, generation, bytes);
    assert.deepEqual(c, { inspectionFence: 1, claimedAt: now });
    const quarantine = await uow.sources.objects.get(reserved.objectId);
    assert.deepEqual([quarantine?.state, quarantine?.generation, quarantine?.bytes, quarantine?.observedAt], ["PRESENT", generation, bytes, now]);
    return c;
  });
  assert.equal((await oracle<{ t: string }>(`SELECT ${exactSql("inspection_claimed_at")} AS t FROM kauro.upload_sessions WHERE upload_id = $1`, [reserved.uploadId])).t, claim.claimedAt);
  // the receipt, promotion and admission in a later unit of work: the receipt starts at the claim instant exactly (D-INSP-4)
  const admitted = await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    assert.ok(now > claim.claimedAt);
    const a = await admitVia(uow.sources, emitOf(uow, t), t, reserved, claim, generation, bytes, now);
    const upload = await uow.sources.uploads.get(reserved.uploadId);
    assert.deepEqual([upload?.state, upload?.admittedAt, upload?.fileId, upload?.inspectionReceiptHash, upload?.displayName], ["ADMITTED", now, a.fileId, a.receiptHash, undefined]);
    return a;
  });

  // the evidence read back: receipts, the file, its tables and columns — by the request handlers with the display text, by the
  // control plane without it
  await h.app.runSource(asOwner(t), async (uow) => {
    const receipt = await uow.sources.inspections.getByHash(admitted.receiptHash);
    assert.ok(receipt);
    assert.deepEqual([receipt.outcome, receipt.startedAt, receipt.scanState, receipt.accepted?.generation, receipt.scanner?.signatureMaxAgeSeconds], ["ADMITTED", claim.claimedAt, "COVERED_CLEAN", admitted.acceptedGeneration, 86_400]);
    assert.deepEqual((await uow.sources.inspections.forUpload(reserved.uploadId)).map((r) => r.receiptHash), [admitted.receiptHash]);
    const file = await uow.sources.files.get(admitted.fileId);
    assert.ok(file);
    assert.deepEqual([file.state, file.admitted, file.version, file.storageRef, file.providerGeneration, file.bytes], ["ADMITTED", true, 1, admitted.acceptedObjectId, admitted.acceptedGeneration, bytes]);
    assert.deepEqual((await uow.sources.files.listForRevision(p.revisionId)).map((f) => f.fileId), [admitted.fileId]);
    assert.deepEqual((await uow.sources.files.listReusable(p.projectId)).map((f) => f.fileId), [admitted.fileId]);
    const [table] = await uow.sources.files.tables(admitted.fileId);
    assert.deepEqual([table?.tableId, table?.structureHash, table?.nameDisplay, table?.rowEstimate], [admitted.tableId, admitted.structureHash, undefined, 120]);
    assert.deepEqual((await uow.sources.files.columns(admitted.tableId)).map((c) => [c.ordinal, c.labelDisplay, c.labelState]), [[0, "Email", "PRESENT"], [1, "Name", "PRESENT"]]);
    const upload = await uow.sources.uploads.get(reserved.uploadId);
    assert.equal(upload?.displayName, "contacts export.csv");
    // the ledgers hold the observed bytes of the admitted upload and release its slot
    assert.deepEqual(await uow.sources.uploads.quota(p.revisionId), { revisionId: p.revisionId, reservedBytes: bytes, fileCount: 1 });
    assert.equal((await uow.sources.uploads.capacity(t.ag.agencyId)).activeSessions, 0);
    const objects = await uow.sources.objects.inventory({ projectId: p.projectId, revisionId: p.revisionId });
    assert.deepEqual(objects.map((o) => [o.zone, o.dataClass, o.state]).sort(), [["ACCEPTED", "RAW", "VERIFIED"], ["QUARANTINE", "RAW", "VERIFIED"]]);
    const byName = await uow.sources.objects.findByName(STORAGE, "ACCEPTED_PRIMARY", acceptedObjectName(t.ag.agencyId, p.projectId, admitted.fileId));
    assert.deepEqual(byName.map((o) => o.objectId), [admitted.acceptedObjectId]);
  });
  await h.control.runSource(asControl(t), async (uow) => {
    const columns = await uow.sources.files.columns(admitted.tableId);
    assert.deepEqual(columns.map((c) => [c.ordinal, c.labelDisplay, c.labelDigest]), [[0, undefined, textDigest("Email")], [1, undefined, textDigest("Name")]], "the control plane reads digests, never labels");
  });
  // the inventory of an admitted generation is frozen: nothing is admitted or appended once its upload left VERIFYING (KA071)
  await assert.rejects(
    h.control.runSource(asControl(t), (uow) =>
      uow.sources.files.admit(
        { fileId: ids.next() as SourceFileId, storageRef: admitted.acceptedObjectId, agencyId: t.ag.agencyId, projectId: p.projectId, originRevisionId: p.revisionId, originUploadId: reserved.uploadId, inspectionReceiptHash: admitted.receiptHash, providerGeneration: admitted.acceptedGeneration, sha256: admitted.sha256, bytes, format: "CSV", scanState: "COVERED_CLEAN", parserProfileHash: admitted.parserProfileHash },
        [],
      ),
    ),
    refused("PRECONDITION_FAILED", "FENCE_DISCIPLINE", "KA071"),
  );
  // every stamp of the chain is a server instant (the oracle compares the columns with each other, never with a caller value)
  const chain = await oracle<{ ok: boolean }>(
    `SELECT (u.created_at < u.session_issued_at AND u.session_issued_at < u.completion_reported_at AND u.completion_reported_at < u.inspection_claimed_at
             AND u.completion_observed_at = u.inspection_claimed_at AND u.admitted_at > u.inspection_claimed_at
             AND f.admitted_at = u.admitted_at AND r.created_at = u.admitted_at AND r.started_at = u.inspection_claimed_at
             AND s.created_at = u.session_issued_at AND o.verified_at = u.admitted_at AND o.observed_at = u.completion_observed_at) AS ok
       FROM kauro.upload_sessions u JOIN kauro.source_files f ON f.origin_upload_id = u.upload_id
       JOIN kauro.inspection_receipts r ON r.upload_id = u.upload_id JOIN kauro.upload_session_secrets s ON s.upload_id = u.upload_id
       JOIN kauro.stored_objects o ON o.object_id = u.quarantine_object_id WHERE u.upload_id = $1`,
    [reserved.uploadId],
  );
  assert.deepEqual(chain, { ok: true });
});
