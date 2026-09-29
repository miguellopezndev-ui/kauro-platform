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

/**
 * What a blocked backend waits for: the states of the backends holding what it needs (pg_blocking_pids). A reservation that waits
 * on the other unit of work's row lock is blocked by exactly that transaction, idle while the test holds it open.
 */
async function blockersOf(pid: number): Promise<ReadonlyArray<string>> {
  const r = await h.oracle.query<{ state: string }>("SELECT a.state FROM pg_stat_activity a WHERE a.pid = ANY (pg_blocking_pids($1)) ORDER BY a.pid", [pid]);
  return r.rows.map((x) => x.state);
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
    scanner: { engine: "contract-fake-scanner", engineVersion: "SIMULATED-1", signatureVersion: "SIG-1", signaturesPublishedAt: new Date(Date.parse(now) - HOUR_MS).toISOString(), signatureMaxAgeSeconds: 86_400, configHash: textDigest("contract-fake-scanner-config"), scannedAt: now, exitCode: 0, verdict: "CLEAN" },
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

/** CMD015 (or CMD012 on a replaced revision): the tombstone, its event and INTAKE_CANCELLED anchor; no provider-cancellation column. */
async function cancelVia(s: SourceStore, emit: Emit, t: Tenant, up: Reserved, expectedVersion: number, reason = "CANCELLED_BY_REQUESTER"): Promise<UploadSessionRecord> {
  const cancelled = applied(await s.uploads.transition(up.uploadId, expectedVersion, { event: "cancel_upload", byMembershipId: t.ag.ownerMembershipId, reason }), "cancel_upload");
  await emit("upload_session", up.uploadId, cancelled.version, "upload_session.cancelled.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: up.revisionId, cancelledByMembershipId: t.ag.ownerMembershipId, reasonCode: reason, providerCancellationState: cancelled.providerCancellationState });
  await s.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId: up.projectId, revisionId: up.revisionId, uploadId: up.uploadId, kind: "INTAKE_CANCELLED", sourceEvidenceHash: null });
  return cancelled;
}

/** An operations change of the agency's concurrent-session limit (the control plane's column; D-UP-3). */
async function setSessionLimit(t: Tenant, limit: number): Promise<void> {
  await rawTx(h.controlPool, t.ag.agencyId, "", (c) =>
    c.query("INSERT INTO kauro.upload_capacity (agency_id, active_sessions, session_limit, updated_at) VALUES ($1, 0, $2, now()) ON CONFLICT (agency_id) DO UPDATE SET session_limit = EXCLUDED.session_limit, updated_at = now()", [t.ag.agencyId, limit]),
  );
}

/** A rejecting receipt of an attempt (a structure refusal: nothing scanned, nothing promoted). */
function rejectingReceipt(t: Tenant, up: Reserved, fence: number, startedAt: string, completedAt: string, generation: string, bytes: number) {
  return {
    receiptId: ids.next() as InspectionReceiptId,
    agencyId: t.ag.agencyId,
    uploadId: up.uploadId,
    revisionId: up.revisionId,
    receiptHash: inspectionReceiptHashOf({ uploadId: up.uploadId, inspectionFence: fence, observedGeneration: generation, observedBytes: bytes, outcome: "REJECTED", rejectionClass: "CORRUPT_STRUCTURE" }),
    inspectionFence: fence,
    quarantineObjectId: up.objectId,
    observedGeneration: generation,
    observedBytes: bytes,
    completionClaimDigest: textDigest(`contract-fake-completion-${up.uploadId}`),
    claimConsistent: true,
    declaredFormat: "CSV",
    detectedFormat: "CSV",
    structureStatus: "STRUCTURE_INVALID",
    scanState: "NOT_SCANNED",
    semanticStatus: "SEMANTIC_NOT_YET_PROFILED",
    expectedParts: 0,
    expectedBytes: 0,
    scannedParts: 0,
    scannedBytes: 0,
    coverage: [],
    problems: [{ code: "CSV_UNTERMINATED_QUOTE" }],
    inspectorVersion: "data-plane-0.1.0",
    outcome: "REJECTED",
    rejectionClass: "CORRUPT_STRUCTURE",
    startedAt,
    completedAt,
  } as const;
}

interface SelectedFile {
  readonly fileId: SourceFileId;
  readonly tableId: SourceTableId;
  readonly structureHash: Sha256Hex;
  readonly origin: "THIS_REVISION" | "REUSED";
}

interface Bound {
  readonly selection: SelectionManifestDocument;
  readonly selectionManifestId: SelectionManifestId;
  readonly selectionHash: Sha256Hex;
  readonly inventoryHash: Sha256Hex;
  readonly version: number;
}

/**
 * The selection manifest intake and CMD016 through the adapters: the manifest made against the revision's current inventory
 * (SourceRevisionRepository.inventory), stored content-idempotently, bound after the revision row — all_uploads_completed from
 * UPLOADING, previously_admitted_inputs_selected from DRAFT, selection_changes from READY_TO_SEAL, selection_rebound while INSPECTING.
 */
async function bindVia(s: SourceStore, emit: Emit, t: Tenant, projectId: ProjectId, revisionId: RevisionId, file: SelectedFile, projectionKey = "CONTACT"): Promise<Bound> {
  const inventoryHash = inventoryHashOf(await s.revisions.inventory(revisionId));
  const base = fixtureSelection(revisionId, file, inventoryHash);
  const selection: SelectionManifestDocument = { ...base, projections: base.projections.map((x) => ({ ...x, projectionKey })) };
  const selectionHash = selectionHashOf(selection);
  const { record } = await s.selections.put({ selectionManifestId: ids.next() as SelectionManifestId, agencyId: t.ag.agencyId, projectId, revisionId, body: selection, bodyHash: selectionHash, createdByMembershipId: t.ag.ownerMembershipId, createdAt: CALLER_INSTANT });
  const revision = await s.revisions.lock(revisionId);
  assert.ok(revision);
  const binding = { selectionManifestId: record.selectionManifestId, selectionHash, inventoryHash };
  const change =
    revision.state === "UPLOADING"
      ? ({ event: "all_uploads_completed", selection: binding } as const)
      : revision.state === "DRAFT"
        ? ({ event: "previously_admitted_inputs_selected", selection: binding } as const)
        : revision.state === "READY_TO_SEAL"
          ? ({ event: "selection_changes", selection: binding } as const)
          : ({ event: "selection_rebound", selection: binding } as const);
  const bound = applied(await s.revisions.transition(revisionId, revision.version, change), change.event);
  await emit("dataset_revision", revisionId, bound.version, "dataset_revision.selection_changed.v1", {
    revisionId,
    agencyId: t.ag.agencyId,
    projectId,
    selectionManifestId: record.selectionManifestId,
    selectionHash,
    inventoryHash,
    previousState: revision.state,
    state: "INSPECTING",
    includedFileCount: 1,
    includedTableCount: 1,
    reusedFileIds: file.origin === "REUSED" ? [file.fileId] : [],
  });
  return { selection, selectionManifestId: record.selectionManifestId, selectionHash, inventoryHash, version: bound.version };
}

const COUNTS = { physicalSourceRows: 120, logicalSourceRecords: 120, billableSourceUnits: 120, associationEdges: 0 } as const;

interface Counted {
  readonly evaluationId: EvaluationId;
  readonly evaluationHash: Sha256Hex;
  readonly version: number;
}

/** SELECTION_EVALUATION through the adapters (revision row first): the complete evaluation and all_selected_inputs_admitted. */
async function evaluateVia(
  s: SourceStore,
  emit: Emit,
  t: Tenant,
  projectId: ProjectId,
  revisionId: RevisionId,
  bound: Bound,
  file: { readonly fileId: SourceFileId; readonly tableId: SourceTableId; readonly generation: string; readonly sha256: Sha256Hex; readonly bytes: number },
  now: string,
): Promise<Counted> {
  const revision = await s.revisions.lock(revisionId);
  assert.ok(revision);
  const evaluationId = ids.next() as EvaluationId;
  const files = [{ fileId: file.fileId, generation: file.generation, sha256: file.sha256, bytes: file.bytes }];
  const evaluationHash = evaluationHashOf({ revisionId, selectionHash: bound.selectionHash, files, populations: COUNTS });
  await s.evaluations.append({
    evaluationId,
    agencyId: t.ag.agencyId,
    revisionId,
    selectionManifestId: bound.selectionManifestId,
    selectionHash: bound.selectionHash,
    evaluationHash,
    result: "COMPLETE",
    populations: COUNTS,
    fileCount: 1,
    totalBytes: file.bytes,
    files,
    tables: [{ tableId: file.tableId, physicalRows: 120, columnCount: 2, excludedHiddenRows: 0, issues: [] }],
    projections: [{ projectionKey: "CONTACT", objectKind: "CONTACT", logicalRecords: 120, billable: true }],
    failures: [],
    pricingDefinition: PRICING_DEFINITION,
    evaluatorVersion: "data-plane-0.1.0",
    startedAt: now,
    completedAt: now,
  });
  const ready = applied(await s.revisions.transition(revisionId, revision.version, { event: "all_selected_inputs_admitted", evaluationId, evaluationHash, populations: COUNTS }), "all_selected_inputs_admitted");
  await emit("dataset_revision", revisionId, ready.version, "dataset_revision.ready_to_seal.v1", { revisionId, agencyId: t.ag.agencyId, projectId, selectionHash: bound.selectionHash, evaluationHash, ...COUNTS });
  return { evaluationId, evaluationHash, version: ready.version };
}

/** The fixture shape the sealed documents are composed from (sealedManifestOf of @kauro/persistence/testing). */
function readyOf(t: Tenant, revisionId: RevisionId, file: { readonly fileId: string; readonly tableId: string; readonly generation: string; readonly sha256: string; readonly bytes: number; readonly structureHash: string; readonly parserProfileHash: string; readonly receiptHash: string }, bound: Bound, counted: Counted): ReadySourceFixture {
  return {
    revisionId,
    clientId: t.clientId,
    revisionVersion: counted.version,
    uploadId: ids.next(),
    quarantineObjectId: ids.next(),
    acceptedObjectId: ids.next(),
    fileId: file.fileId,
    tableId: file.tableId,
    bytes: file.bytes,
    acceptedGeneration: file.generation,
    sha256: file.sha256,
    receiptHash: file.receiptHash,
    structureHash: file.structureHash,
    parserProfileHash: file.parserProfileHash,
    initiatedAt: new Date(),
    selection: bound.selection,
    selectionManifestId: bound.selectionManifestId,
    selectionHash: bound.selectionHash,
    inventoryHash: bound.inventoryHash,
    evaluationId: counted.evaluationId,
    evaluationHash: counted.evaluationHash,
    counts: COUNTS,
  };
}

/**
 * CMD017 through the adapters (revision row first): the first seal of the bytes read, the sealed manifest and subject with the
 * file set, the REVISION_SEALED anchor, the UNPAID record — anchored on the first seal of the bytes, or (`THIS_SEAL`) on this seal
 * to show the database refuses a restarted clock — and seal_command, each with its event.
 */
async function sealVia(s: SourceStore, emit: Emit, t: Tenant, projectId: ProjectId, ready: ReadySourceFixture, anchorOn: "FIRST_SEAL" | "THIS_SEAL" = "FIRST_SEAL") {
  const revisionId = ready.revisionId as RevisionId;
  const revision = await s.revisions.lock(revisionId);
  assert.ok(revision);
  const firsts = await s.seals.firstSeals([ready.fileId as SourceFileId]);
  const docs = sealedManifestOf(scopeOf(t, projectId), ready, ids.next());
  const sealed = await s.seals.insert(
    { revisionId, agencyId: t.ag.agencyId, projectId, manifestHash: docs.manifestHash, projectionHash: docs.projectionHash, selectionHash: ready.selectionHash as Sha256Hex, evaluationHash: ready.evaluationHash as Sha256Hex, subjectHash: docs.subjectHash, manifest: docs.manifest, subject: docs.subject },
    [{ fileId: ready.fileId as SourceFileId, ordinal: 0, disposition: "INCLUDED", providerGeneration: ready.acceptedGeneration, sha256: ready.sha256 as Sha256Hex, bytes: ready.bytes }],
  );
  const anchor = await s.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId, revisionId, kind: "REVISION_SEALED", sourceEvidenceHash: docs.manifestHash });
  const first = firsts.find((f) => f.fileId === ready.fileId);
  const retentionId = ids.next() as RetentionId;
  const record = await s.retention.insertUnpaidRecord({ retentionId, agencyId: t.ag.agencyId, clientId: t.clientId, projectId, revisionId, anchorId: anchorOn === "FIRST_SEAL" && first !== undefined ? first.anchorId : anchor.anchorId, policyVersion: RETENTION_POLICY_VERSION });
  await emit("retention_record", retentionId, 1, "retention_record.created.v1", { retentionId, agencyId: t.ag.agencyId, projectId, revisionId, retentionClass: "UNPAID", anchorEvidenceHash: record.anchorEvidenceHash, policyVersion: RETENTION_POLICY_VERSION });
  const moved = applied(await s.revisions.transition(revisionId, revision.version, { event: "seal_command", manifestHash: docs.manifestHash, projectionHash: docs.projectionHash, sealedFileCount: 1, sealedBytes: ready.bytes }), "seal_command");
  await emit("dataset_revision", revisionId, moved.version, "dataset_revision.sealed.v1", {
    revisionId,
    agencyId: t.ag.agencyId,
    projectId,
    manifestHash: docs.manifestHash,
    projectionHash: docs.projectionHash,
    selectionHash: ready.selectionHash,
    evaluationHash: ready.evaluationHash,
    ...COUNTS,
    fileCount: 1,
    sealedBytes: ready.bytes,
    retentionId,
  });
  return { sealed, anchor, record, revision: moved, firsts, manifest: docs.manifest };
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
    assert.deepEqual([receipt.outcome, receipt.startedAt, receipt.scanState, receipt.accepted?.generation, receipt.scanner?.signatureMaxAgeSeconds, receipt.scanner?.exitCode, receipt.scanner?.verdict], ["ADMITTED", claim.claimedAt, "COVERED_CLEAN", admitted.acceptedGeneration, 86_400, 0, "CLEAN"]);
    assert.deepEqual((await uow.sources.inspections.forUpload(reserved.uploadId)).map((r) => r.receiptHash), [admitted.receiptHash]);
    const file = await uow.sources.files.get(admitted.fileId);
    assert.ok(file);
    assert.deepEqual([file.state, file.admitted, file.version, file.storageRef, file.providerGeneration, file.bytes], ["ADMITTED", true, 1, admitted.acceptedObjectId, admitted.acceptedGeneration, bytes]);
    // the same record after the file's shared transition lock (CMD017 reads each included file so, D-CMD-7)
    assert.deepEqual(await uow.sources.files.lockShared(admitted.fileId), file);
    assert.equal(await uow.sources.files.lockShared("0190c7a2-0000-7000-8000-0000000000ff" as SourceFileId), null);
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

test("R2-052 through UploadSessionRepository.insert: two reservations that each fit alone serialize on the revision row (the wait observed in pg_stat_activity) and the loser is PRECONDITION_FAILED REVISION_QUOTA_EXCEEDED; the exact fit commits, the fifty-first file is REVISION_FILE_LIMIT and a file above 2e9 bytes is FILE_TOO_LARGE", async () => {
  const t = await tenant("r2-052");
  // concurrency is not the subject: operations raise the agency's session limit so only the byte and file envelope decides
  await setSessionLimit(t, 64);
  const p = await project(t);
  const firstIn = barrier();
  const proceed = barrier();
  // neither writer takes the revision row itself (lockRevision false): the insert's own trigger serializes them on it, and the
  // ledger CHECK decides on the committed total — the database's decision, whatever a handler read (R2-052, D-UP-2)
  const a = h.app.runSource(asOwner(t), async (uow) => {
    await reserveVia(uow.sources, emitOf(uow, t), t, p, 1.5 * GB, { first: true, lockRevision: false });
    firstIn.open();
    await proceed.wait;
    // while the second waits, this unit of work reserves another 2e9 (1.5e9 + 2e9 = 3.5e9 fits) and commits
    await reserveVia(uow.sources, emitOf(uow, t), t, p, 2 * GB, { lockRevision: false });
  });
  await firstIn.wait;
  // the second reservation, checked alone, fits (0 + 2e9 <= 5e9 in its snapshot)
  const b = h.app.runSource(asOwner(t), async (uow) => {
    assert.equal((await uow.sources.uploads.quota(p.revisionId)).reservedBytes, 0, "the second writer's own read cannot see the first reservation");
    return reserveVia(uow.sources, emitOf(uow, t), t, p, 2 * GB, { lockRevision: false });
  });
  try {
    const pid = await waitForLockWait(h.oracle, API, "INSERT INTO kauro.upload_sessions");
    // the second reservation's insert takes the revision row in its trigger (FOR NO KEY UPDATE, D-LOCK-1), which the first holds
    assert.deepEqual(await blockersOf(pid), ["idle in transaction"], "the second reservation waits for the first unit of work");
  } finally {
    proceed.open();
  }
  await a;
  // 3.5e9 + 2e9 = 5.5e9 > 5e9: the typed loser, refused by the ledger CHECK on the committed total, not by a read
  await assert.rejects(b, refused("PRECONDITION_FAILED", "REVISION_QUOTA_EXCEEDED", "23514"));
  await h.app.runSource(asOwner(t), async (uow) => {
    assert.deepEqual(await uow.sources.uploads.quota(p.revisionId), { revisionId: p.revisionId, reservedBytes: 3.5 * GB, fileCount: 2 });
    assert.equal((await uow.sources.uploads.listByRevision(p.revisionId, { limit: 10 })).length, 2);
  });
  // the exact fit commits (5e9); one byte more is refused
  await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 1.5 * GB));
  assert.deepEqual(await h.app.runSource(asOwner(t), (uow) => uow.sources.uploads.quota(p.revisionId)), { revisionId: p.revisionId, reservedBytes: 5 * GB, fileCount: 3 });
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 1)), refused("PRECONDITION_FAILED", "REVISION_QUOTA_EXCEEDED", "23514"));
  // the per-file envelope, wherever the file goes
  const other = await project(t);
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, other, 2 * GB + 1, { first: true })), refused("PRECONDITION_FAILED", "FILE_TOO_LARGE", "23514"));
  // the file envelope: fifty files commit, the fifty-first is refused
  await h.app.runSource(asOwner(t), async (uow) => {
    for (let i = 0; i < 50; i++) await reserveVia(uow.sources, emitOf(uow, t), t, other, 1, { first: i === 0 });
  });
  assert.deepEqual(await h.app.runSource(asOwner(t), (uow) => uow.sources.uploads.quota(other.revisionId)), { revisionId: other.revisionId, reservedBytes: 50, fileCount: 50 });
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, other, 1)), refused("PRECONDITION_FAILED", "REVISION_FILE_LIMIT", "23514"));
  assert.deepEqual(await oracle("SELECT reserved_bytes::text AS bytes, file_count FROM kauro.revision_quota WHERE revision_id = $1", [p.revisionId]), { bytes: "5000000000", file_count: 3 });
});

test("the capacity race through UploadSessionRepository.insert: two reservations for the agency's last session slot serialize on its capacity ledger (the wait observed in pg_stat_activity) and the loser is ADMISSION_LIMITED UPLOAD_CONCURRENCY_LIMITED; a tombstoned upload frees its slot and its bytes exactly once", async () => {
  const t = await tenant("capacity");
  const [p1, p2, p3] = [await project(t), await project(t), await project(t)];
  const first = await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p1, 10, { first: true }));
  const holding = barrier();
  const release = barrier();
  // one slot left: two reservations on different revisions each see a free slot and serialize on the agency's capacity row
  const a = h.app.runSource(asOwner(t), async (uow) => {
    await reserveVia(uow.sources, emitOf(uow, t), t, p2, 10, { first: true });
    holding.open();
    await release.wait;
  });
  await holding.wait;
  const b = h.app.runSource(asOwner(t), async (uow) => {
    assert.deepEqual(await uow.sources.uploads.capacity(t.ag.agencyId), { agencyId: t.ag.agencyId, activeSessions: 1, sessionLimit: 2 }, "the loser read a free slot");
    return reserveVia(uow.sources, emitOf(uow, t), t, p3, 10, { first: true });
  });
  try {
    const pid = await waitForLockWait(h.oracle, API, "INSERT INTO kauro.upload_sessions");
    // different revisions: the only row both reservations update is the agency's capacity ledger
    assert.deepEqual(await blockersOf(pid), ["idle in transaction"], "the second reservation waits for the first unit of work");
  } finally {
    release.open();
  }
  await a;
  await assert.rejects(b, (e: unknown) => {
    refused("ADMISSION_LIMITED", "UPLOAD_CONCURRENCY_LIMITED", "23514")(e);
    assert.equal(failure(e).retryable, true, "a slot frees when a live session ends");
    return true;
  });
  assert.deepEqual(await h.app.runSource(asOwner(t), (uow) => uow.sources.uploads.capacity(t.ag.agencyId)), { agencyId: t.ag.agencyId, activeSessions: 2, sessionLimit: 2 });
  // cancelling the first releases its slot and its bytes exactly once
  await h.app.runSource(asOwner(t), (uow) => cancelVia(uow.sources, emitOf(uow, t), t, first, 1));
  await h.app.runSource(asOwner(t), async (uow) => {
    assert.equal((await uow.sources.uploads.capacity(t.ag.agencyId)).activeSessions, 1);
    assert.deepEqual(await uow.sources.uploads.quota(p1.revisionId), { revisionId: p1.revisionId, reservedBytes: 0, fileCount: 0 });
  });
  // the freed slot is usable exactly once more
  await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p3, 10, { first: true }));
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p1, 10)), refused("ADMISSION_LIMITED", "UPLOAD_CONCURRENCY_LIMITED", "23514"));
  assert.deepEqual(await oracle("SELECT active_sessions, session_limit FROM kauro.upload_capacity WHERE agency_id = $1", [t.ag.agencyId]), { active_sessions: 2, session_limit: 2 });
});

test("D-PAIR-1 through UploadSessionRepository.insert: a request handler reserves only as the acting person through their own live OWNER, ADMIN or OPERATOR membership — another member's membership, a pair of one member's membership with another person and a VIEWER's own membership are refused, and nothing of them commits", async () => {
  const t = await tenant("pair");
  await setSessionLimit(t, 8);
  const p = await project(t);
  const operatorUser = await h.person(`b07-adapters-pair-operator-${tenants}`);
  const operator: Requester = { membershipId: await h.addMember(t.ag, operatorUser, "OPERATOR"), userId: operatorUser };
  const viewerUser = await h.person(`b07-adapters-pair-viewer-${tenants}`);
  const viewer: Requester = { membershipId: await h.addMember(t.ag, viewerUser, "VIEWER"), userId: viewerUser };
  const owner: Requester = { membershipId: t.ag.ownerMembershipId, userId: t.ag.ownerUserId };
  const as = (who: Requester): TenantContext => h.tenant(t.ag.agencyId, who.userId);
  // the operator, acting as themselves through their own membership: committed
  const own = await h.app.runSource(as(operator), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 10, { first: true, requester: operator }));
  assert.deepEqual([own.record.requestedByMembershipId, own.record.requestedByUserId], [operator.membershipId, operator.userId]);
  // the owner naming the operator (membership and person): not the acting person
  await assert.rejects(h.app.runSource(as(owner), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 10, { requester: operator })), refused("NOT_FOUND", "TENANT_CONTEXT_MISSING", "42501"));
  // the owner as the person, but through the operator's membership: not their own membership
  await assert.rejects(h.app.runSource(as(owner), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 10, { requester: { membershipId: operator.membershipId, userId: owner.userId } })), refused("NOT_FOUND", "TENANT_CONTEXT_MISSING", "42501"));
  // a VIEWER through their own live membership: not an operator role (CMD013 is AGENCY_OPERATOR)
  await assert.rejects(h.app.runSource(as(viewer), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 10, { requester: viewer })), refused("NOT_FOUND", "TENANT_CONTEXT_MISSING", "42501"));
  // the owner as themselves: committed
  await h.app.runSource(as(owner), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 10, { requester: owner }));
  assert.deepEqual(
    await oracle<{ uploads: string; objects: string }>(
      "SELECT (SELECT string_agg(requested_by_membership_id::text, ',' ORDER BY created_at) FROM kauro.upload_sessions WHERE revision_id = $1) AS uploads, (SELECT count(*)::text FROM kauro.stored_objects WHERE revision_id = $1) AS objects",
      [p.revisionId],
    ),
    { uploads: `${operator.membershipId},${owner.membershipId}`, objects: "2" },
    "no refused reservation left an upload or an intent behind",
  );
});

test("compare-and-swap and fences: a stale version answers STALE with the current version and state and writes nothing; a session issue or an inspection outcome of an attempt that no longer holds its fence is FENCE_DISCIPLINE; claimInspectionAttempt returns the database's claim instant exactly, and a receipt of an earlier attempt or one not starting at its claim is refused", async () => {
  const t = await tenant("fences");
  const p = await project(t);
  const generation = "1700000000000077";
  const bytes = 777;
  const up = await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 1_000, { first: true }));
  // a retry resumed under a new fence (D-RUN-2): the abandoned attempt can no longer issue a session
  assert.equal(await h.app.runSource(asOwner(t), (uow) => uow.sources.uploads.claimSessionAttempt(up.uploadId)), 2);
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => issueVia(uow.sources, emitOf(uow, t), t, up, 1, 1)), refused("PRECONDITION_FAILED", "FENCE_DISCIPLINE"));
  const issued = await h.app.runSource(asOwner(t), (uow) => issueVia(uow.sources, emitOf(uow, t), t, up, 2, 1));
  assert.deepEqual([issued.state, issued.version, issued.sessionAttempt], ["UPLOADING", 2, 2]);
  // a stale expectation: STALE with the current version and state, nothing written
  const stale = await h.app.runSource(asOwner(t), (uow) => uow.sources.uploads.transition(up.uploadId, 1, { event: "cancel_upload", byMembershipId: t.ag.ownerMembershipId, reason: "CANCELLED_BY_REQUESTER" }));
  assert.deepEqual(stale, { kind: "STALE", currentVersion: 2, currentState: "UPLOADING" });
  assert.equal(await h.app.runSource(asOwner(t), (uow) => uow.sources.uploads.claimSessionAttempt(up.uploadId)), null, "no issuance fence once the session is issued");
  const revision = await h.app.runSource(asOwner(t), (uow) => uow.sources.revisions.get(p.revisionId));
  assert.ok(revision);
  assert.deepEqual(await h.app.runSource(asOwner(t), (uow) => uow.sources.revisions.transition(p.revisionId, revision.version - 1, { event: "upload_reserved", firstUploadId: up.uploadId })), { kind: "STALE", currentVersion: revision.version, currentState: "UPLOADING" });
  await h.app.runSource(asOwner(t), (uow) => reportVia(uow.sources, emitOf(uow, t), t, up, generation, bytes));
  // attempt 1 claims and observes; attempt 2 (a retried inspection) claims again, at its own server instant
  const claim1 = await h.control.runSource(asControl(t), (uow) => claimAndObserveVia(uow.sources, emitOf(uow, t), t, up, generation, bytes));
  const claim2 = await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    const c = await uow.sources.uploads.claimInspectionAttempt(up.uploadId);
    assert.deepEqual(c, { inspectionFence: 2, claimedAt: now });
    return c as { readonly inspectionFence: number; readonly claimedAt: string };
  });
  assert.ok(claim2.claimedAt > claim1.claimedAt);
  assert.equal((await oracle<{ t: string; fence: number; version: string }>(`SELECT ${exactSql("inspection_claimed_at")} AS t, inspection_fence AS fence, version::text AS version FROM kauro.upload_sessions WHERE upload_id = $1`, [up.uploadId])).t, claim2.claimedAt);
  // the stale attempt attaches no receipt (KA071); the current one only from its own claim instant (KA072, D-INSP-4)
  await assert.rejects(
    h.control.runSource(asControl(t), async (uow) => uow.sources.inspections.append(rejectingReceipt(t, up, 1, claim1.claimedAt, await uow.serverInstant(), generation, bytes))),
    refused("PRECONDITION_FAILED", "FENCE_DISCIPLINE", "KA071"),
  );
  await assert.rejects(
    h.control.runSource(asControl(t), async (uow) => uow.sources.inspections.append(rejectingReceipt(t, up, 2, claim1.claimedAt, await uow.serverInstant(), generation, bytes))),
    refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"),
  );
  // the outcome of the stale attempt is FENCE_DISCIPLINE; the current attempt rejects the upload
  const rejected = await h.control.runSource(asControl(t), async (uow) => {
    const receipt = rejectingReceipt(t, up, 2, claim2.claimedAt, await uow.serverInstant(), generation, bytes);
    assert.ok(await uow.sources.revisions.lock(p.revisionId));
    await uow.sources.inspections.append(receipt);
    const current = await uow.sources.uploads.lock(up.uploadId);
    assert.ok(current);
    await assert.rejects(uow.sources.uploads.transition(up.uploadId, current.version, { event: "inspection_rejected", receiptHash: receipt.receiptHash, rejectionClass: "CORRUPT_STRUCTURE", inspectionFence: 1 }), refused("PRECONDITION_FAILED", "FENCE_DISCIPLINE"));
    const w = applied(await uow.sources.uploads.transition(up.uploadId, current.version, { event: "inspection_rejected", receiptHash: receipt.receiptHash, rejectionClass: "CORRUPT_STRUCTURE", inspectionFence: 2 }), "inspection_rejected");
    await emitOf(uow, t)("upload_session", up.uploadId, w.version, "upload_session.rejected.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: p.revisionId, inspectionReceiptHash: receipt.receiptHash, rejectionClass: "CORRUPT_STRUCTURE", scanState: "NOT_SCANNED" });
    await uow.sources.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, uploadId: up.uploadId, kind: "INTAKE_REJECTED", sourceEvidenceHash: receipt.receiptHash });
    assert.equal(await uow.sources.uploads.claimInspectionAttempt(up.uploadId), null, "a decided upload yields no attempt");
    return w;
  });
  assert.deepEqual([rejected.state, rejected.terminalReason, rejected.inspectionFence, rejected.version], ["REJECTED", "CORRUPT_STRUCTURE", 2, 5]);
  // a retried anchor of the same subject and kind returns the stored one and never moves it
  const retried = await h.control.runSource(asControl(t), (uow) => uow.sources.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, uploadId: up.uploadId, kind: "INTAKE_REJECTED", sourceEvidenceHash: null }));
  assert.equal(retried.occurredAt, rejected.rejectedAt);
  assert.deepEqual(await oracle("SELECT count(*)::int AS n FROM kauro.retention_anchors WHERE upload_id = $1 AND anchor_kind = 'INTAKE_REJECTED'", [up.uploadId]), { n: 1 });
});

test("cancel_upload writes no provider-cancellation column: the database requests the provider cancellation with the tombstone of an issued session at the tombstone's instant, the control plane alone records the answer (UNCERTAIN, then CONFIRMED) and purges the secret, and an unissued reservation's cancellation requests nothing (D-ROLE-3)", async () => {
  const t = await tenant("cancel");
  const p = await project(t);
  const unissued = await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 10, { first: true }));
  const live = await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 10));
  await h.app.runSource(asOwner(t), (uow) => issueVia(uow.sources, emitOf(uow, t), t, live));
  // no session was issued: nothing to request from the provider
  const quiet = await h.app.runSource(asOwner(t), (uow) => cancelVia(uow.sources, emitOf(uow, t), t, unissued, 1));
  assert.deepEqual([quiet.state, quiet.providerCancellationState, quiet.providerCancellationAt, quiet.cancelledByMembershipId, quiet.terminalReason], ["CANCELLED", "NOT_REQUESTED", undefined, t.ag.ownerMembershipId, "CANCELLED_BY_REQUESTER"]);
  // an issued session: the database stamps REQUESTED at the tombstone's own server instant
  const cancelled = await h.app.runSource(asOwner(t), async (uow) => {
    const now = await uow.serverInstant();
    const c = await cancelVia(uow.sources, emitOf(uow, t), t, live, 2);
    assert.deepEqual([c.state, c.cancelledAt, c.providerCancellationState, c.providerCancellationAt], ["CANCELLED", now, "REQUESTED", now]);
    assert.equal(await uow.sources.sessionSecrets.readOwn(live.uploadId), null, "a tombstoned session is never delivered again");
    return c;
  });
  // the request handlers hold no grant on the provider's answer
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => uow.sources.uploads.recordProviderCancellation(live.uploadId, cancelled.version, "CONFIRMED")), refused("NOT_FOUND", "TENANT_CONTEXT_MISSING", "42501"));
  // discovery: the pending cancellation is reconciled until the provider horizon
  assert.ok((await h.control.runSource(asControl(null), (uow) => uow.sources.uploads.findProviderReconciliation(1000))).some((x) => x.uploadId === live.uploadId && x.agencyId === t.ag.agencyId));
  const emitControl = (uow: SourceUnitOfWork) => emitOf(uow, t);
  const uncertain = await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    const secret = await uow.sources.sessionSecrets.readForRevocation(live.uploadId);
    assert.deepEqual([secret?.uploadId, secret?.sessionAttempt, secret?.keyRef], [live.uploadId, 1, "contract-fake-vault/test-key:1"]);
    assert.ok(await uow.sources.revisions.lock(p.revisionId));
    const w = applied(await uow.sources.uploads.recordProviderCancellation(live.uploadId, cancelled.version, "UNCERTAIN"), "UNCERTAIN");
    await emitControl(uow)("upload_session", live.uploadId, w.version, "upload_session.provider_cancellation_recorded.v1", { uploadId: live.uploadId, agencyId: t.ag.agencyId, revisionId: p.revisionId, providerCancellationState: "UNCERTAIN" });
    assert.deepEqual([w.providerCancellationState, w.providerCancellationAt, w.cancelledAt], ["UNCERTAIN", now, cancelled.cancelledAt]);
    return w;
  });
  const confirmed = await h.control.runSource(asControl(t), async (uow) => {
    const w = applied(await uow.sources.uploads.recordProviderCancellation(live.uploadId, uncertain.version, "CONFIRMED"), "CONFIRMED");
    await emitControl(uow)("upload_session", live.uploadId, w.version, "upload_session.provider_cancellation_recorded.v1", { uploadId: live.uploadId, agencyId: t.ag.agencyId, revisionId: p.revisionId, providerCancellationState: "CONFIRMED" });
    assert.equal(await uow.sources.sessionSecrets.purge(live.uploadId), true);
    assert.equal(await uow.sources.sessionSecrets.purge(live.uploadId), false, "purged once");
    assert.equal(await uow.sources.sessionSecrets.readForRevocation(live.uploadId), null);
    return w;
  });
  assert.equal(confirmed.providerCancellationState, "CONFIRMED");
  // the result only moves forward (KA008)
  await assert.rejects(h.control.runSource(asControl(t), (uow) => uow.sources.uploads.recordProviderCancellation(live.uploadId, confirmed.version, "UNCERTAIN")), refused("PRECONDITION_FAILED", "UNLISTED_TRANSITION", "KA008"));
  assert.ok(!(await h.control.runSource(asControl(null), (uow) => uow.sources.uploads.findProviderReconciliation(1000))).some((x) => x.uploadId === live.uploadId), "a resolved cancellation is reconciled no more");
  assert.deepEqual(await oracle("SELECT count(*)::int AS n FROM kauro.upload_session_secrets WHERE upload_id = $1", [live.uploadId]), { n: 0 });
});

test("the deadline edges on the server clock: findDeadlinePassed finds live and unsealed-admitted uploads past their deadline across agencies (never a sealed one), reservation_expired and intake_deadline_reached commit only at or after the deadline — requesting the provider cancellation of an issued session — and nothing is accepted after it", async () => {
  const t = await tenant("deadlines");
  const other = await tenant("deadlines-other");
  await setSessionLimit(t, 8);
  const p = await project(t);
  // reserved (and one issued) a day and an hour ago, through the adapters at that instant of the TEST CLOCK
  const dayAgo = new Date(Date.now() - 25 * HOUR_MS);
  const stale = await storeAt("REQUEST", t, dayAgo, (s, emit) => reserveVia(s, emit, t, p, 100, { first: true }));
  const issued = await storeAt("REQUEST", t, new Date(dayAgo.getTime() + 1_000), (s, emit) => reserveVia(s, emit, t, p, 100));
  await storeAt("REQUEST", t, new Date(dayAgo.getTime() + 2_000), (s, emit) => issueVia(s, emit, t, issued));
  const fresh = await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 100));
  // in another agency: an admitted file two days old that no seal included, and one sealed fifteen days ago
  const q = await project(other);
  const unsealed = await admitSourceFile(sessionsOf(other), scopeOf(other, q.projectId), { seed: "deadline-unsealed", base: new Date(Date.now() - 2 * DAY_MS) });
  const q2 = await project(other);
  const sealed = await sealSourceRevision(sessionsOf(other), scopeOf(other, q2.projectId), { seed: "deadline-sealed" });
  // discovery across agencies, no customer text, on the server clock
  const due = await h.control.runSource(asControl(null), (uow) => uow.sources.uploads.findDeadlinePassed(1000));
  const stateOf = (uploadId: string): string | undefined => due.find((d) => d.uploadId === uploadId)?.state;
  assert.deepEqual([stateOf(stale.uploadId), stateOf(issued.uploadId), stateOf(unsealed.uploadId)], ["RESERVED", "UPLOADING", "ADMITTED"]);
  assert.equal(stateOf(fresh.uploadId), undefined, "a window still open");
  assert.equal(stateOf(sealed.uploadId), undefined, "a sealed file follows its seal's retention, not the window");
  // nothing is accepted after the deadline: no issuance fence, no session issue, no completion report (KA072)
  assert.equal(await h.app.runSource(asOwner(t), (uow) => uow.sources.uploads.claimSessionAttempt(stale.uploadId)), null);
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => issueVia(uow.sources, emitOf(uow, t), t, stale)), refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"));
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => reportVia(uow.sources, emitOf(uow, t), t, issued, "1700000000000009", 10)), refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"));
  // nothing expires before its deadline (KA072)
  await assert.rejects(h.control.runSource(asControl(t), (uow) => uow.sources.uploads.transition(fresh.uploadId, 1, { event: "reservation_expired", reason: "RESERVATION_EXPIRED", providerCancellation: "NOT_REQUESTED" })), refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"));
  // at or after it the control plane expires them, the revision row first, requesting the provider cancellation of the issued one
  await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    const emit = emitOf(uow, t);
    assert.ok(await uow.sources.revisions.lock(p.revisionId));
    for (const [up, version, providerCancellation] of [[stale, 1, "NOT_REQUESTED"], [issued, 2, "REQUESTED"]] as const) {
      const e = applied(await uow.sources.uploads.transition(up.uploadId, version, { event: "reservation_expired", reason: "RESERVATION_EXPIRED", providerCancellation }), "reservation_expired");
      assert.deepEqual([e.state, e.expiredAt, e.terminalReason, e.providerCancellationState, e.providerCancellationAt], ["EXPIRED", now, "RESERVATION_EXPIRED", providerCancellation, providerCancellation === "REQUESTED" ? now : undefined]);
      await emit("upload_session", up.uploadId, e.version, "upload_session.expired.v1", { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: p.revisionId, previousState: version === 1 ? "RESERVED" : "UPLOADING", reasonCode: "RESERVATION_EXPIRED", releasedBytes: 100, providerCancellationState: providerCancellation });
      await uow.sources.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, uploadId: up.uploadId, kind: "INTAKE_EXPIRED", sourceEvidenceHash: null });
    }
    assert.deepEqual(await uow.sources.uploads.quota(p.revisionId), { revisionId: p.revisionId, reservedBytes: 100, fileCount: 1 }, "only the fresh reservation still holds");
  });
  // an admitted upload past its window: intake_deadline_reached; its file stays named on the row (the admission is revoked on the file)
  const expired = await h.control.runSource(asControl(other), async (uow) => {
    assert.ok(await uow.sources.revisions.lock(unsealed.revisionId as RevisionId));
    const e = applied(await uow.sources.uploads.transition(unsealed.uploadId as UploadId, 5, { event: "intake_deadline_reached", reason: "INTAKE_DEADLINE" }), "intake_deadline_reached");
    await emitOf(uow, other)("upload_session", unsealed.uploadId, e.version, "upload_session.expired.v1", { uploadId: unsealed.uploadId, agencyId: other.ag.agencyId, revisionId: unsealed.revisionId, previousState: "ADMITTED", reasonCode: "INTAKE_DEADLINE", releasedBytes: unsealed.bytes, providerCancellationState: "NOT_REQUESTED", fileId: unsealed.fileId });
    await uow.sources.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: other.ag.agencyId, projectId: q.projectId, revisionId: unsealed.revisionId as RevisionId, uploadId: unsealed.uploadId as UploadId, kind: "INTAKE_EXPIRED", sourceEvidenceHash: null });
    return e;
  });
  assert.deepEqual([expired.state, expired.fileId], ["EXPIRED", unsealed.fileId]);
  const after = new Set<string>((await h.control.runSource(asControl(null), (uow) => uow.sources.uploads.findDeadlinePassed(1000))).map((d) => d.uploadId));
  assert.ok(![stale.uploadId, issued.uploadId, unsealed.uploadId].some((id) => after.has(id)), "an expired upload is due no more");
  assert.ok((await h.control.runSource(asControl(null), (uow) => uow.sources.uploads.findProviderReconciliation(1000))).some((x) => x.uploadId === issued.uploadId), "the expired session is reconciled until its provider horizon");
});

test("recordDeletion records the provider residual the latest location read-back implies, at the server's instant — refused at a location never read back; recordLocationPolicy and locationPolicyAt answer the read-back as stored; a failed deletion is retried; recordProviderResidual records the provider-reported expiry; the inventory enumerates raw, derived and residual objects", async () => {
  const t = await tenant("deletion");
  const p = await project(t);
  const reserved = await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 10, { first: true }));
  const orphan = (s: SourceStore, zone: "QUARANTINE" | "ACCEPTED", locationRef: string, generation: string) => {
    const objectId = ids.next() as StoredObjectId;
    return s.objects.register({
      objectId,
      agencyId: t.ag.agencyId,
      projectId: p.projectId,
      revisionId: p.revisionId,
      zone,
      dataClass: "RESIDUAL",
      provider: STORAGE,
      locationRef,
      objectName: `${zone.toLowerCase()}/${t.ag.agencyId}/${p.projectId}/${ids.next()}`,
      createdBy: { kind: "SERVICE", serviceId: SERVICE },
      createdAt: CALLER_INSTANT,
      observed: { generation, bytes: 64, observedAt: CALLER_INSTANT, late: true },
    });
  };
  // the read-backs: seven days of soft-delete retention at one location, none at another, a third location never read back
  const readBack = await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    const kept = await uow.sources.objects.recordLocationPolicy({ observationId: ids.next(), provider: STORAGE, locationRef: "QUARANTINE_T10", softDeleteRetentionSeconds: 604_800, objectVersioning: true, evidenceHash: textDigest("read-back-kept"), evidenceClass: "SIMULATED" });
    const none = await uow.sources.objects.recordLocationPolicy({ observationId: ids.next(), provider: STORAGE, locationRef: "ACCEPTED_T10", softDeleteRetentionSeconds: 0, objectVersioning: false, evidenceHash: textDigest("read-back-none"), evidenceClass: "SIMULATED" });
    assert.deepEqual([kept.observedAt, none.observedAt, kept.evidenceClass], [now, now, "SIMULATED"]);
    return kept;
  });
  await h.control.runSource(asControl(t), async (uow) => {
    assert.deepEqual(await uow.sources.objects.locationPolicyAt(STORAGE, "QUARANTINE_T10", readBack.observedAt), readBack, "the read-back as stored, found at its own instant");
    assert.equal(await uow.sources.objects.locationPolicyAt(STORAGE, "QUARANTINE_T10", CALLER_INSTANT), null, "no read-back before it");
    assert.equal(await uow.sources.objects.locationPolicyAt(STORAGE, "NEVER_READ_T10", await uow.serverInstant()), null);
  });
  // objects: residuals found at each location, and a derived object
  const objects = await h.control.runSource(asControl(t), async (uow) => {
    const kept = await orphan(uow.sources, "QUARANTINE", "QUARANTINE_T10", "1700000000000101");
    const none = await orphan(uow.sources, "ACCEPTED", "ACCEPTED_T10", "1700000000000102");
    const unread = await orphan(uow.sources, "QUARANTINE", "NEVER_READ_T10", "1700000000000103");
    const failing = await orphan(uow.sources, "QUARANTINE", "QUARANTINE_T10", "1700000000000104");
    const derived = await uow.sources.objects.register({
      objectId: ids.next() as StoredObjectId,
      agencyId: t.ag.agencyId,
      projectId: p.projectId,
      revisionId: p.revisionId,
      zone: "PROFILE",
      dataClass: "DERIVED",
      provider: STORAGE,
      locationRef: "PROFILE_T10",
      objectName: `profile/${t.ag.agencyId}/${p.projectId}/${ids.next()}`,
      createdBy: { kind: "SERVICE", serviceId: SERVICE },
      createdAt: CALLER_INSTANT,
    });
    assert.deepEqual([kept.state, kept.late, kept.dataClass, kept.generation], ["PRESENT", true, "RESIDUAL", "1700000000000101"]);
    // a generation is observed once
    await assert.rejects(uow.sources.objects.observe(kept.objectId, { generation: "1700000000000999", bytes: 1, observedAt: CALLER_INSTANT, late: true }), refused("PRECONDITION_FAILED", "UNLISTED_TRANSITION"));
    const now = await uow.serverInstant();
    assert.equal(await uow.sources.objects.requestDeletion([kept.objectId, none.objectId, unread.objectId, failing.objectId], "ORPHAN_OBJECT", CALLER_INSTANT), 4);
    assert.equal(await uow.sources.objects.requestDeletion([kept.objectId], "ORPHAN_OBJECT", CALLER_INSTANT), 0, "a repeated request changes nothing");
    assert.equal((await uow.sources.objects.get(kept.objectId))?.deletionRequestedAt, now);
    return { kept, none, unread, failing, derived, requestedAt: now };
  });
  // a deletion at a location never read back cannot be recorded (KA072)
  await assert.rejects(h.control.runSource(asControl(t), (uow) => uow.sources.objects.recordDeletion(objects.unread.objectId, "DELETED")), refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"));
  const deleted = await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    const kept = await uow.sources.objects.recordDeletion(objects.kept.objectId, "DELETED");
    assert.deepEqual([kept.state, kept.deletedAt, kept.deletionResult, kept.deletionAttempts, kept.providerResidual], ["DELETED", now, "DELETED", 1, { basis: "LOCATION_POLICY", until: await plusSeconds(now, 604_800) }]);
    const none = await uow.sources.objects.recordDeletion(objects.none.objectId, "ALREADY_ABSENT");
    assert.deepEqual([none.state, none.deletionResult, none.providerResidual], ["DELETED", "ALREADY_ABSENT", { basis: "LOCATION_POLICY" }], "a location that retains nothing leaves no residual expiry");
    const failed = await uow.sources.objects.recordDeletion(objects.failing.objectId, "PROVIDER_ERROR");
    assert.deepEqual([failed.state, failed.deletionResult, failed.deletionAttempts, failed.providerResidual], ["DELETION_FAILED", "PROVIDER_ERROR", 1, undefined]);
    return kept;
  });
  assert.deepEqual(await oracle<{ ok: boolean }>("SELECT provider_residual_until = deleted_at + interval '604800 seconds' AS ok FROM kauro.stored_objects WHERE object_id = $1", [deleted.objectId]), { ok: true });
  // the pending deletions (discovery), the retry of the failed one, and its second attempt
  const pending = new Set((await h.control.runSource(asControl(null), (uow) => uow.sources.objects.pendingDeletion(1000))).map((x) => x.objectId));
  assert.ok(pending.has(objects.failing.objectId) && pending.has(objects.unread.objectId) && !pending.has(objects.kept.objectId));
  await h.control.runSource(asControl(t), async (uow) => {
    const retried = await uow.sources.objects.retryDeletion(objects.failing.objectId, CALLER_INSTANT);
    assert.deepEqual([retried.state, retried.deletionRequestedAt, retried.deletionAttempts], ["DELETION_REQUESTED", objects.requestedAt, 1], "the first request's instant stays");
    const again = await uow.sources.objects.recordDeletion(objects.failing.objectId, "DELETED");
    assert.deepEqual([again.state, again.deletionAttempts], ["DELETED", 2]);
    await assert.rejects(uow.sources.objects.retryDeletion(objects.kept.objectId, CALLER_INSTANT), refused("PRECONDITION_FAILED", "UNLISTED_TRANSITION"));
  });
  // a generation provider inventory found already soft-deleted: registered, requested and DELETED with the provider's own expiry
  const providerExpiresAt = new Date(Date.now() + 3 * DAY_MS).toISOString();
  const residual = await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    const r = await uow.sources.objects.recordProviderResidual({
      objectId: ids.next() as StoredObjectId,
      agencyId: t.ag.agencyId,
      projectId: p.projectId,
      revisionId: p.revisionId,
      zone: "QUARANTINE",
      dataClass: "RESIDUAL",
      provider: STORAGE,
      locationRef: "QUARANTINE_T10",
      objectName: `quarantine/${t.ag.agencyId}/${p.projectId}/${ids.next()}`,
      createdBy: { kind: "SERVICE", serviceId: SERVICE },
      createdAt: CALLER_INSTANT,
      generation: "1700000000000105",
      softDeletedAt: CALLER_INSTANT,
      providerExpiresAt,
    });
    assert.deepEqual([r.state, r.deletionResult, r.deletedAt, r.deletionAttempts, r.deletionReason, r.providerResidual?.basis], ["DELETED", "ALREADY_ABSENT", now, 0, "PROVIDER_SOFT_DELETED", "PROVIDER_REPORTED"]);
    assert.equal(Date.parse(r.providerResidual?.until ?? ""), Date.parse(providerExpiresAt));
    return r;
  });
  // a residual at a location never read back is refused as well
  await assert.rejects(
    h.control.runSource(asControl(t), (uow) =>
      uow.sources.objects.recordProviderResidual({ objectId: ids.next() as StoredObjectId, agencyId: t.ag.agencyId, projectId: p.projectId, zone: "QUARANTINE", dataClass: "RESIDUAL", provider: STORAGE, locationRef: "NEVER_READ_T10", objectName: `quarantine/${t.ag.agencyId}/${p.projectId}/${ids.next()}`, createdBy: { kind: "SERVICE", serviceId: SERVICE }, createdAt: CALLER_INSTANT, generation: "1700000000000106", softDeletedAt: CALLER_INSTANT, providerExpiresAt }),
    ),
    refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"),
  );
  // the deletion inventory of the project: raw, derived and residual, each with its state and result (G-UPLOAD evidence rule)
  const inventory = await h.app.runSource(asOwner(t), (uow) => uow.sources.objects.inventory({ projectId: p.projectId }));
  const byId = new Map(inventory.map((o) => [o.objectId, o]));
  assert.deepEqual(
    [reserved.objectId, objects.derived.objectId, deleted.objectId, objects.unread.objectId, residual.objectId].map((id) => [byId.get(id)?.dataClass, byId.get(id)?.state]),
    [["RAW", "INTENDED"], ["DERIVED", "INTENDED"], ["RESIDUAL", "DELETED"], ["RESIDUAL", "DELETION_REQUESTED"], ["RESIDUAL", "DELETED"]],
  );
  assert.deepEqual((await h.app.runSource(asOwner(t), (uow) => uow.sources.objects.inventory({ projectId: p.projectId, uploadId: reserved.uploadId }))).map((o) => o.objectId), [reserved.objectId]);
  // an accepted generation whose admission stands is retained: its deletion is refused until the admission is revoked
  const admitted = await admittedThroughAdapters(t);
  await assert.rejects(h.control.runSource(asControl(t), (uow) => uow.sources.objects.requestDeletion([admitted.acceptedObjectId], "INTAKE_EXPIRED", CALLER_INSTANT)), refused("PRECONDITION_FAILED", "UNLISTED_TRANSITION"));
});

test("revokeAdmission commits only with its event: INTAKE_EXPIRED is refused KA072 while the upload's window is open and once a real seal included the file, RETENTION_EXPIRED while an including revision holds an ACTIVE record ahead; after the window or the retention ended each commits at the server's instant with source_file.admission_revoked.v1 naming the revisions that selected or sealed the file", async () => {
  const t = await tenant("revocation");
  const revoke = (fileId: string, version: number, reason: "INTAKE_EXPIRED" | "RETENTION_EXPIRED" | "GENERATION_MISSING", projectId: string) =>
    h.control.runSource(asControl(t), async (uow) => {
      const now = await uow.serverInstant();
      const w = applied(await uow.sources.files.revokeAdmission(fileId as SourceFileId, version, reason), reason);
      const selectedBy = await uow.sources.files.selectedBy(fileId as SourceFileId);
      const sealedBy = await uow.sources.files.sealedBy(fileId as SourceFileId);
      await emitOf(uow, t)("source_file", fileId, w.version, "source_file.admission_revoked.v1", { fileId, agencyId: t.ag.agencyId, projectId, revocationReason: reason, selectedByRevisionIds: [...selectedBy], sealedByRevisionIds: [...sealedBy] });
      assert.deepEqual([w.state, w.admitted, w.revokedAt, w.revocationReason, w.version], ["ADMISSION_REVOKED", false, now, reason, version + 1]);
      return { record: w, selectedBy, sealedBy };
    });
  const refusedRevocation = (fileId: string, version: number, reason: "INTAKE_EXPIRED" | "RETENTION_EXPIRED") =>
    assert.rejects(h.control.runSource(asControl(t), (uow) => uow.sources.files.revokeAdmission(fileId as SourceFileId, version, reason)), refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"), reason);
  // the upload's window is still open: the unsealed intake is not expired yet
  const pOpen = await project(t);
  const open = await admitSourceFile(sessionsOf(t), scopeOf(t, pOpen.projectId), { seed: "revoke-open", base: new Date(Date.now() - HOUR_MS) });
  await refusedRevocation(open.fileId, 1, "INTAKE_EXPIRED");
  // the window closed and no seal included the file: without its event nothing commits (KA003), with it the revocation commits
  const pClosed = await project(t);
  const closed = await admitSourceFile(sessionsOf(t), scopeOf(t, pClosed.projectId), { seed: "revoke-closed", base: new Date(Date.now() - 2 * DAY_MS) });
  await assert.rejects(h.control.runSource(asControl(t), (uow) => uow.sources.files.revokeAdmission(closed.fileId as SourceFileId, 1, "INTAKE_EXPIRED")), refused("INTEGRITY_FAILURE", "EVENT_MISSING", "KA003"));
  const intake = await revoke(closed.fileId, 1, "INTAKE_EXPIRED", pClosed.projectId);
  assert.deepEqual([intake.selectedBy, intake.sealedBy], [[], []]);
  assert.deepEqual(await h.control.runSource(asControl(t), (uow) => uow.sources.files.revokeAdmission(closed.fileId as SourceFileId, 1, "INTAKE_EXPIRED")), { kind: "STALE", currentVersion: 2, currentState: "ADMISSION_REVOKED" });
  assert.deepEqual((await h.app.runSource(asOwner(t), (uow) => uow.sources.files.listReusable(pClosed.projectId as ProjectId))).map((f) => f.fileId), [], "a revoked file is reusable no more");
  // sealed two days ago: its UNPAID record is ACTIVE ahead, so neither the intake window nor the retention ends the admission
  const pYoung = await project(t);
  const young = await sealSourceRevision(sessionsOf(t), scopeOf(t, pYoung.projectId), { seed: "revoke-young", base: new Date(Date.now() - 2 * DAY_MS) });
  await refusedRevocation(young.fileId, 1, "INTAKE_EXPIRED");
  await refusedRevocation(young.fileId, 1, "RETENTION_EXPIRED");
  // a lost generation is revoked whatever retains it
  const lost = await revoke(young.fileId, 1, "GENERATION_MISSING", pYoung.projectId);
  assert.deepEqual([lost.selectedBy, lost.sealedBy], [[young.revisionId], [young.revisionId]]);
  // sealed fifteen days ago: the seal governs (INTAKE_EXPIRED refused), and its retention ended (RETENTION_EXPIRED commits)
  const pOld = await project(t);
  const old = await sealSourceRevision(sessionsOf(t), scopeOf(t, pOld.projectId), { seed: "revoke-old" });
  await refusedRevocation(old.fileId, 1, "INTAKE_EXPIRED");
  const retention = await revoke(old.fileId, 1, "RETENTION_EXPIRED", pOld.projectId);
  assert.deepEqual([retention.selectedBy, retention.sealedBy], [[old.revisionId], [old.revisionId]]);
  assert.deepEqual(await oracle("SELECT count(*)::int AS n FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'source_file.admission_revoked.v1' AND actor_kind = 'SERVICE'", [old.fileId]), { n: 1 });
});

test("SelectionManifestRepository.put is content-idempotent: the same body again answers the stored manifest with created false whatever id and instant the caller minted, another body is another manifest, and a body hash that is not the body's digest is refused", async () => {
  const t = await tenant("manifest");
  const p = await project(t);
  const body = fixtureSelection(p.revisionId, { fileId: ids.next(), tableId: ids.next(), structureHash: textDigest("structure"), origin: "THIS_REVISION" }, textDigest("inventory"));
  const bodyHash = selectionHashOf(body);
  const put = (id: string, document: SelectionManifestDocument, hash: Sha256Hex = selectionHashOf(document)) =>
    h.app.runSource(asOwner(t), async (uow) => ({ now: await uow.serverInstant(), out: await uow.sources.selections.put({ selectionManifestId: id as SelectionManifestId, agencyId: t.ag.agencyId, projectId: p.projectId, revisionId: p.revisionId, body: document, bodyHash: hash, createdByMembershipId: t.ag.ownerMembershipId, createdAt: CALLER_INSTANT }) }));
  const firstId = ids.next();
  const first = await put(firstId, body);
  assert.deepEqual([first.out.created, first.out.record.selectionManifestId, first.out.record.bodyHash, first.out.record.createdAt], [true, firstId, bodyHash, first.now]);
  // the same content, members in another order, another id: the stored manifest, created false
  const reordered = Object.fromEntries(Object.entries(body).reverse()) as unknown as SelectionManifestDocument;
  const againId = ids.next();
  const again = await put(againId, reordered);
  assert.deepEqual([again.out.created, again.out.record.selectionManifestId, again.out.record.createdAt], [false, firstId, first.now]);
  await h.app.runSource(asOwner(t), async (uow) => {
    const stored = await uow.sources.selections.get(p.revisionId, firstId as SelectionManifestId);
    assert.ok(stored);
    assert.deepEqual(stored.body, body);
    assert.equal(selectionHashOf(stored.body), bodyHash, "the stored document is the one its hash names");
    assert.equal(await uow.sources.selections.get(p.revisionId, againId as SelectionManifestId), null, "the second id was never stored");
    const elsewhere = await project(t);
    assert.equal(await uow.sources.selections.get(elsewhere.revisionId, firstId as SelectionManifestId), null, "a manifest is read only under its own revision");
  });
  // another body is another manifest
  const changed: SelectionManifestDocument = { ...body, projections: body.projections.map((x) => ({ ...x, projectionKey: "PERSON" })) };
  const third = await put(ids.next(), changed);
  assert.equal(third.out.created, true);
  assert.notEqual(third.out.record.bodyHash, bodyHash);
  // a hash that is not the body's digest is never stored under it
  await assert.rejects(put(ids.next(), changed, textDigest("another document")), refused("INTEGRITY_FAILURE", "HASH_MISMATCH"));
  assert.deepEqual(await oracle("SELECT count(*)::int AS n FROM kauro.selection_manifests WHERE revision_id = $1", [p.revisionId]), { n: 2 });
});

test("the revision lifecycle through SourceRevisionRepository, SelectionEvaluationRepository, SealedManifestRepository and RetentionRepository: the selection made against the revision's own inventory closes the intake (all_uploads_completed), is rebound and changed, the evaluation counts it READY_TO_SEAL, and the seal commits the manifest, the file set, the seal anchor and the UNPAID record of new bytes — every instant the server's", async () => {
  const t = await tenant("revision-lifecycle");
  const admitted = await admittedThroughAdapters(t);
  const { projectId, revisionId } = admitted;
  const file: SelectedFile = { fileId: admitted.fileId, tableId: admitted.tableId, structureHash: admitted.structureHash, origin: "THIS_REVISION" };
  // the inventory is the revision's own uploads and files, ids and digests only (KAURO_SOURCE_INVENTORY_V1)
  const inventory = await h.app.runSource(asOwner(t), (uow) => uow.sources.revisions.inventory(revisionId));
  assert.deepEqual(inventory, {
    revisionId,
    uploads: [{ uploadId: admitted.uploadId, state: "ADMITTED", fileId: admitted.fileId, inspectionReceiptHash: admitted.receiptHash }],
    files: [{ fileId: admitted.fileId, generation: admitted.acceptedGeneration, sha256: admitted.sha256, bytes: admitted.bytes, tables: [{ tableId: admitted.tableId, ordinal: 0, structureHash: admitted.structureHash }] }],
  });
  // CMD016 on the UPLOADING revision: the agency's explicit closing of the intake, at the server's instant
  const bound = await h.app.runSource(asOwner(t), async (uow) => {
    const now = await uow.serverInstant();
    const b = await bindVia(uow.sources, emitOf(uow, t), t, projectId, revisionId, file);
    const revision = await uow.sources.revisions.get(revisionId);
    assert.deepEqual([revision?.state, revision?.selectedAt, revision?.selectionHash, revision?.inventoryHash, revision?.selectionManifestId, revision?.populations], ["INSPECTING", now, b.selectionHash, inventoryHashOf(inventory), b.selectionManifestId, undefined]);
    return b;
  });
  // a new selection while INSPECTING: selection_rebound, still INSPECTING
  const rebound = await h.app.runSource(asOwner(t), (uow) => bindVia(uow.sources, emitOf(uow, t), t, projectId, revisionId, file, "PERSON"));
  assert.notEqual(rebound.selectionHash, bound.selectionHash);
  assert.equal(rebound.version, bound.version + 1);
  // SELECTION_EVALUATION counts the bound selection
  const counted = await h.control.runSource(asControl(t), async (uow) => {
    const c = await evaluateVia(uow.sources, emitOf(uow, t), t, projectId, revisionId, rebound, { fileId: admitted.fileId, tableId: admitted.tableId, generation: admitted.acceptedGeneration, sha256: admitted.sha256, bytes: admitted.bytes }, await uow.serverInstant());
    const latest = await uow.sources.evaluations.latestFor(revisionId, rebound.selectionHash);
    assert.deepEqual([latest?.evaluationId, latest?.result, latest?.populations], [c.evaluationId, "COMPLETE", COUNTS]);
    assert.equal(await uow.sources.evaluations.latestFor(revisionId, bound.selectionHash), null, "no evaluation of the superseded selection");
    assert.equal((await uow.sources.evaluations.get(c.evaluationId))?.evaluationHash, c.evaluationHash);
    return c;
  });
  // selection_changes from READY_TO_SEAL clears the counts; the new selection is counted again
  const changed = await h.app.runSource(asOwner(t), async (uow) => {
    const b = await bindVia(uow.sources, emitOf(uow, t), t, projectId, revisionId, file);
    const revision = await uow.sources.revisions.get(revisionId);
    assert.deepEqual([revision?.state, revision?.evaluationId, revision?.populations], ["INSPECTING", undefined, undefined], "the counts are cleared with the new selection");
    return b;
  });
  assert.equal(changed.selectionManifestId, bound.selectionManifestId, "the first body again is the first manifest (content-idempotent intake)");
  const recounted = await h.control.runSource(asControl(t), async (uow) => evaluateVia(uow.sources, emitOf(uow, t), t, projectId, revisionId, changed, { fileId: admitted.fileId, tableId: admitted.tableId, generation: admitted.acceptedGeneration, sha256: admitted.sha256, bytes: admitted.bytes }, await uow.serverInstant()));
  assert.notEqual(recounted.evaluationId, counted.evaluationId);
  // CMD017: new bytes, so this seal is the first seal of the bytes
  const ready = readyOf(t, revisionId, { fileId: admitted.fileId, tableId: admitted.tableId, generation: admitted.acceptedGeneration, sha256: admitted.sha256, bytes: admitted.bytes, structureHash: admitted.structureHash, parserProfileHash: admitted.parserProfileHash, receiptHash: admitted.receiptHash }, changed, recounted);
  const seal = await h.app.runSource(asOwner(t), async (uow) => {
    const sealedAt = await uow.serverInstant();
    const out = await sealVia(uow.sources, emitOf(uow, t), t, projectId, ready);
    assert.deepEqual(out.firsts, [], "bytes no real seal included before");
    assert.deepEqual([out.sealed.sealedAt, out.anchor.occurredAt, out.revision.sealedAt, out.revision.state], [sealedAt, sealedAt, sealedAt, "SEALED"]);
    assert.deepEqual([out.record.class, out.record.state, out.record.softDeadline, out.record.hardDeadline, out.record.effectiveDeadline, out.record.anchorId, out.record.version], ["UNPAID", "ACTIVE", undefined, await plusSeconds(sealedAt, 1_209_600), await plusSeconds(sealedAt, 1_209_600), out.anchor.anchorId, 1]);
    return out;
  });
  // read back: the manifest (its hash recomputed from the stored preimage), the first seal, the anchors, the records, availability
  await h.app.runSource(asOwner(t), async (uow) => {
    const stored = await uow.sources.seals.get(revisionId);
    assert.ok(stored);
    assert.equal(sourceRevisionManifestHashOf(stored.manifest), stored.manifestHash, "the stored manifest is exactly HASHING's preimage of its hash");
    assert.deepEqual(stored.subject.revisionId, revisionId);
    assert.deepEqual(await uow.sources.seals.firstSeals([admitted.fileId]), [{ fileId: admitted.fileId, revisionId, sealedAt: seal.sealed.sealedAt, anchorId: seal.anchor.anchorId }]);
    assert.deepEqual((await uow.sources.retention.anchorsOf(revisionId)).map((a) => a.kind), ["UPLOAD_INITIATED", "INPUT_ADMITTED", "REVISION_SEALED"]);
    assert.deepEqual((await uow.sources.retention.recordFor(revisionId, "UNPAID"))?.retentionId, seal.record.retentionId);
    assert.equal(await uow.sources.retention.recordFor(revisionId, "PAID_ORDINARY"), null);
    assert.deepEqual((await uow.sources.retention.recordsFor(revisionId)).map((r) => r.retentionId), [seal.record.retentionId]);
    assert.deepEqual(await uow.sources.availability.availabilityOf(revisionId), { revisionId, state: "SEALED", manifestHash: stored.manifestHash, availableUntil: seal.record.effectiveDeadline, retentionId: seal.record.retentionId });
    assert.deepEqual([await uow.sources.files.selectedBy(admitted.fileId), await uow.sources.files.sealedBy(admitted.fileId)], [[revisionId], [revisionId]]);
    const revision = await uow.sources.revisions.get(revisionId);
    assert.deepEqual([revision?.sealedFileCount, revision?.sealedBytes, revision?.manifestHash, revision?.populations], [1, admitted.bytes, stored.manifestHash, COUNTS]);
  });
  // the evidence anchor digest covers the anchor's exact server instant (KAURO_RETENTION_ANCHOR_V1)
  const anchorRow = await oracle<{ occurred_at: string; evidence_hash: string }>(`SELECT ${exactSql("occurred_at")} AS occurred_at, evidence_hash FROM kauro.retention_anchors WHERE anchor_id = $1`, [seal.anchor.anchorId]);
  assert.deepEqual(anchorRow, { occurred_at: seal.anchor.occurredAt, evidence_hash: seal.anchor.evidenceHash });
});

test("CMD012 through the adapters and firstSeals of reused bytes: the successor supersedes its sealed predecessor, the project pointer moves, the impact map names the plans bound to the old manifest, and a seal of the reused file is anchored on the first seal of the bytes with its fourteen days — a record restarting the clock at this seal is refused; replacementsSince and availabilityOf answer from the lineage and the records", async () => {
  const t = await tenant("lineage");
  const p = await project(t);
  const a = await sealSourceRevision(sessionsOf(t), scopeOf(t, p.projectId), { seed: "lineage-a", base: new Date(Date.now() - 3 * DAY_MS) });
  const target = await targetContract(rawApp, t.ag, p.projectId, "lineage");
  const boundPlan = await plan({ app: rawApp, control: rawControl }, t.ag, p.projectId, "DRAFT", "lineage", undefined, { revisionHash: a.manifestHash, targetContractHash: target.bodyHash });
  const owner = t.ag.ownerMembershipId;
  // CMD012: project first, predecessor row next (D-LOCK-1), the successor, the supersession with its impact map, the pointer
  const b = await h.app.runSource(asOwner(t), async (uow) => {
    const now = await uow.serverInstant();
    const emit = emitOf(uow, t);
    const projectRecord = await uow.projects.lock(p.projectId);
    assert.ok(projectRecord);
    const predecessor = await uow.sources.revisions.lock(a.revisionId as RevisionId);
    assert.ok(predecessor?.manifestHash);
    const impact = await uow.sources.authority.boundTo(predecessor.manifestHash);
    assert.deepEqual(impact, { planIds: [boundPlan.planId as PlanId], approvalIds: [] });
    const successorId = uow.ids.next() as RevisionId;
    const successor = await uow.sources.revisions.insertSuccessor({ revisionId: successorId, agencyId: t.ag.agencyId, projectId: p.projectId, supersedesRevisionId: predecessor.revisionId, createdByMembershipId: owner, createdAt: CALLER_INSTANT });
    assert.deepEqual([successor.state, successor.version, successor.supersedesRevisionId, successor.createdAt, successor.createdByMembershipId], ["DRAFT", 1, a.revisionId, now, owner]);
    await emit("dataset_revision", successorId, 1, "dataset_revision.created.v1", { revisionId: successorId, agencyId: t.ag.agencyId, projectId: p.projectId, state: "DRAFT", supersedesRevisionId: predecessor.revisionId, createdByMembershipId: owner });
    const superseded = applied(await uow.sources.revisions.transition(predecessor.revisionId, predecessor.version, { event: "new_revision_explicitly_supersedes", successorRevisionId: successorId }), "supersede");
    assert.deepEqual([superseded.state, superseded.supersededByRevisionId, superseded.supersededAt, superseded.sealedAt], ["SUPERSEDED", successorId, now, predecessor.sealedAt]);
    await emit("dataset_revision", predecessor.revisionId, superseded.version, "dataset_revision.superseded.v1", { revisionId: predecessor.revisionId, agencyId: t.ag.agencyId, projectId: p.projectId, successorRevisionId: successorId, manifestHash: predecessor.manifestHash, affectedPlanIds: [...impact.planIds], affectedApprovalIds: [...impact.approvalIds], affectedCommercialAuthorizationIds: [] });
    assert.deepEqual(await uow.sources.projects.switchCurrentRevision(p.projectId, projectRecord.version - 1, successorId, CALLER_INSTANT), { kind: "STALE", currentVersion: projectRecord.version, currentState: "OPEN" });
    const moved = applied(await uow.sources.projects.switchCurrentRevision(p.projectId, projectRecord.version, successorId, CALLER_INSTANT), "switch");
    assert.equal(moved.currentRevisionId, successorId);
    await emit("project", p.projectId, moved.version, "project.current_revision_changed.v1", { projectId: p.projectId, agencyId: t.ag.agencyId, currentRevisionId: successorId, previousRevisionId: predecessor.revisionId, changedByMembershipId: owner });
    return successor;
  });
  await h.app.runSource(asOwner(t), async (uow) => {
    assert.deepEqual(await uow.sources.lineage.replacementsSince(a.revisionId as RevisionId), [{ revisionId: b.revisionId, supersedesRevisionId: a.revisionId, predecessorOutcome: "SUPERSEDED", createdAt: b.createdAt }]);
    assert.deepEqual(await uow.sources.lineage.replacementsSince(b.revisionId), []);
    assert.deepEqual(await uow.sources.availability.availabilityOf(a.revisionId as RevisionId), { revisionId: a.revisionId, state: "SUPERSEDED", manifestHash: a.manifestHash, availableUntil: null, retentionId: null }, "nothing of a superseded source is available");
  });
  // the successor reuses the predecessor's admitted file (previously_admitted_inputs_selected): an explicit selection from DRAFT
  const reused = await h.app.runSource(asOwner(t), async (uow) => {
    const f = await uow.sources.files.get(a.fileId as SourceFileId);
    const [table] = await uow.sources.files.tables(a.fileId as SourceFileId);
    assert.ok(f && table);
    assert.deepEqual((await uow.sources.files.listReusable(p.projectId)).map((x) => x.fileId), [a.fileId]);
    assert.deepEqual(await uow.sources.revisions.inventory(b.revisionId), { revisionId: b.revisionId, uploads: [], files: [] }, "the successor has no upload of its own");
    const bound = await bindVia(uow.sources, emitOf(uow, t), t, p.projectId, b.revisionId, { fileId: f.fileId, tableId: table.tableId, structureHash: table.structureHash, origin: "REUSED" });
    return { f, table, bound };
  });
  const counted = await h.control.runSource(asControl(t), async (uow) => evaluateVia(uow.sources, emitOf(uow, t), t, p.projectId, b.revisionId, reused.bound, { fileId: reused.f.fileId, tableId: reused.table.tableId, generation: reused.f.providerGeneration, sha256: reused.f.sha256, bytes: reused.f.bytes }, await uow.serverInstant()));
  const ready = readyOf(t, b.revisionId, { fileId: reused.f.fileId, tableId: reused.table.tableId, generation: reused.f.providerGeneration, sha256: reused.f.sha256, bytes: reused.f.bytes, structureHash: reused.table.structureHash, parserProfileHash: reused.f.parserProfileHash, receiptHash: reused.f.inspectionReceiptHash }, reused.bound, counted);
  // a record anchored on this seal would restart the bytes' fourteen days: refused at COMMIT (D-RET-3, KA072), nothing sealed
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => sealVia(uow.sources, emitOf(uow, t), t, p.projectId, ready, "THIS_SEAL")), refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"));
  assert.equal((await h.app.runSource(asOwner(t), (uow) => uow.sources.revisions.get(b.revisionId)))?.state, "READY_TO_SEAL");
  // anchored on the first seal of the bytes: the predecessor's seal, found through firstSeals
  const seal = await h.app.runSource(asOwner(t), (uow) => sealVia(uow.sources, emitOf(uow, t), t, p.projectId, ready, "FIRST_SEAL"));
  const aAnchor = (await h.app.runSource(asOwner(t), (uow) => uow.sources.retention.anchorsOf(a.revisionId as RevisionId))).find((x) => x.kind === "REVISION_SEALED");
  assert.deepEqual(seal.firsts, [{ fileId: a.fileId, revisionId: a.revisionId, sealedAt: a.sealedAt, anchorId: aAnchor?.anchorId }]);
  const hard = await plusSeconds(a.sealedAt, 1_209_600);
  assert.deepEqual([seal.record.anchorId, seal.record.hardDeadline, seal.record.effectiveDeadline], [aAnchor?.anchorId, hard, hard], "the hard cap belongs to the bytes: the first seal + fourteen days");
  assert.ok(seal.sealed.sealedAt > a.sealedAt);
  // the bytes now carry two real seals (the superseded predecessor's keeps its instant): the first is still the predecessor's
  assert.deepEqual(await h.app.runSource(asOwner(t), (uow) => uow.sources.seals.firstSeals([a.fileId as SourceFileId])), [{ fileId: a.fileId, revisionId: a.revisionId, sealedAt: a.sealedAt, anchorId: aAnchor?.anchorId }]);
  const availability = await h.app.runSource(asOwner(t), (uow) => uow.sources.availability.availabilityOf(b.revisionId));
  assert.deepEqual([availability?.state, availability?.availableUntil, availability?.retentionId], ["SEALED", hard, seal.record.retentionId]);
});

test("CMD012 over a mutable predecessor through the adapters: cancel_revision cancels it with its uploads in flight, releases their quota and names the successor (replacementsSince CANCELLED); a second mutable revision is REVISION_NOT_MUTABLE and a second successor of one predecessor PREDECESSOR_NOT_CURRENT", async () => {
  const t = await tenant("replace-mutable");
  const p = await project(t);
  const reservedOnly = await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 10, { first: true }));
  const uploading = await h.app.runSource(asOwner(t), (uow) => reserveVia(uow.sources, emitOf(uow, t), t, p, 20));
  await h.app.runSource(asOwner(t), (uow) => issueVia(uow.sources, emitOf(uow, t), t, uploading));
  const successor = (uow: SourceUnitOfWork, revisionId: RevisionId, supersedes: RevisionId) =>
    uow.sources.revisions.insertSuccessor({ revisionId, agencyId: t.ag.agencyId, projectId: p.projectId, supersedesRevisionId: supersedes, createdByMembershipId: t.ag.ownerMembershipId, createdAt: CALLER_INSTANT });
  // a project holds one mutable revision (dataset_revisions_one_mutable_per_project)
  await assert.rejects(h.app.runSource(asOwner(t), (uow) => successor(uow, uow.ids.next() as RevisionId, p.revisionId)), refused("PRECONDITION_FAILED", "REVISION_NOT_MUTABLE", "23505"));
  const replacement = await h.app.runSource(asOwner(t), async (uow) => {
    const emit = emitOf(uow, t);
    const projectRecord = await uow.projects.lock(p.projectId);
    const predecessor = await uow.sources.revisions.lock(p.revisionId);
    assert.ok(projectRecord && predecessor);
    const inFlight = await uow.sources.uploads.inStates(p.revisionId, ["RESERVED", "UPLOADING", "VERIFYING"]);
    assert.deepEqual(inFlight.map((u) => u.uploadId).sort(), [reservedOnly.uploadId, uploading.uploadId].sort());
    for (const u of inFlight) await cancelVia(uow.sources, emit, t, { ...reservedOnly, uploadId: u.uploadId, objectId: u.quarantineObjectId, record: u }, u.version, "REVISION_REPLACED");
    const successorId = uow.ids.next() as RevisionId;
    const cancelled = applied(await uow.sources.revisions.transition(p.revisionId, predecessor.version, { event: "cancel_revision", reason: "REPLACED_BY_NEW_REVISION", successorRevisionId: successorId }), "cancel_revision");
    assert.deepEqual([cancelled.state, cancelled.terminalReason, cancelled.supersededByRevisionId, cancelled.cancelledAt], ["CANCELLED", "REPLACED_BY_NEW_REVISION", successorId, await uow.serverInstant()]);
    await emit("dataset_revision", p.revisionId, cancelled.version, "dataset_revision.cancelled.v1", { revisionId: p.revisionId, agencyId: t.ag.agencyId, projectId: p.projectId, previousState: "UPLOADING", reasonCode: "REPLACED_BY_NEW_REVISION", successorRevisionId: successorId, cancelledUploadIds: inFlight.map((u) => u.uploadId) });
    const created = await successor(uow, successorId, p.revisionId);
    await emit("dataset_revision", successorId, 1, "dataset_revision.created.v1", { revisionId: successorId, agencyId: t.ag.agencyId, projectId: p.projectId, state: "DRAFT", supersedesRevisionId: p.revisionId, createdByMembershipId: t.ag.ownerMembershipId });
    const moved = applied(await uow.sources.projects.switchCurrentRevision(p.projectId, projectRecord.version, successorId, CALLER_INSTANT), "switch");
    await emit("project", p.projectId, moved.version, "project.current_revision_changed.v1", { projectId: p.projectId, agencyId: t.ag.agencyId, currentRevisionId: successorId, previousRevisionId: p.revisionId, changedByMembershipId: t.ag.ownerMembershipId });
    return created;
  });
  await h.app.runSource(asOwner(t), async (uow) => {
    assert.deepEqual((await uow.sources.uploads.inStates(p.revisionId, ["CANCELLED"])).map((u) => [u.uploadId, u.providerCancellationState, u.terminalReason]).sort(), [[reservedOnly.uploadId, "NOT_REQUESTED", "REVISION_REPLACED"], [uploading.uploadId, "REQUESTED", "REVISION_REPLACED"]].sort());
    assert.deepEqual(await uow.sources.uploads.quota(p.revisionId), { revisionId: p.revisionId, reservedBytes: 0, fileCount: 0 });
    assert.equal((await uow.sources.uploads.capacity(t.ag.agencyId)).activeSessions, 0);
    assert.deepEqual(await uow.sources.lineage.replacementsSince(p.revisionId), [{ revisionId: replacement.revisionId, supersedesRevisionId: p.revisionId, predecessorOutcome: "CANCELLED", createdAt: replacement.createdAt }]);
    assert.deepEqual((await uow.sources.retention.anchorsOf(p.revisionId)).filter((x) => x.kind === "INTAKE_CANCELLED").length, 2);
  });
  // a predecessor is replaced once (dataset_revisions_supersedes_once), even when the first successor no longer blocks as mutable
  await assert.rejects(
    h.app.runSource(asOwner(t), async (uow) => {
      const first = await uow.sources.revisions.lock(replacement.revisionId);
      assert.ok(first);
      applied(await uow.sources.revisions.transition(replacement.revisionId, first.version, { event: "cancel_revision", reason: "WITHDRAWN_BY_AGENCY" }), "cancel");
      await successor(uow, uow.ids.next() as RevisionId, p.revisionId);
    }),
    refused("PRECONDITION_FAILED", "PREDECESSOR_NOT_CURRENT", "23505"),
  );
});

test("no early expireRecord: a record whose effective deadline lies ahead is neither due nor expirable (LIFECYCLE_BINDING_MISSING) and its revision not due for retention_expires, while one whose deadline passed expires at the server's instant with its event, and the revision then expires by retention_expires and is available no more", async () => {
  const t = await tenant("expiry");
  const pYoung = await project(t);
  const young = await sealSourceRevision(sessionsOf(t), scopeOf(t, pYoung.projectId), { seed: "expiry-young", base: new Date(Date.now() - HOUR_MS) });
  const pOld = await project(t);
  const old = await sealSourceRevision(sessionsOf(t), scopeOf(t, pOld.projectId), { seed: "expiry-old" });
  const dueRecords = new Set((await h.control.runSource(asControl(null), (uow) => uow.sources.retention.findDue(1000))).map((x) => x.retentionId));
  const dueRevisions = new Set((await h.control.runSource(asControl(null), (uow) => uow.sources.revisions.findRetentionDue(1000))).map((x) => x.revisionId));
  assert.deepEqual([dueRecords.has(old.retentionId as RetentionId), dueRecords.has(young.retentionId as RetentionId)], [true, false]);
  assert.deepEqual([dueRevisions.has(old.revisionId as RevisionId), dueRevisions.has(young.revisionId as RevisionId)], [true, false]);
  // never early: the record (the CHECK on the server's instant) and the revision (KA072)
  await assert.rejects(h.control.runSource(asControl(t), (uow) => uow.sources.retention.expireRecord(young.retentionId as RetentionId, 1)), refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "23514"));
  await assert.rejects(h.control.runSource(asControl(t), (uow) => uow.sources.revisions.transition(young.revisionId as RevisionId, young.version, { event: "retention_expires", reason: "RETENTION_DEADLINE" })), refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"));
  const youngRecord = await h.app.runSource(asOwner(t), (uow) => uow.sources.retention.recordFor(young.revisionId as RevisionId, "UNPAID"));
  assert.deepEqual([youngRecord?.state, youngRecord?.expiredAt], ["ACTIVE", undefined]);
  // past its effective deadline: the record expires at the server's instant, and then the revision
  await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    const emit = emitOf(uow, t);
    const revision = await uow.sources.revisions.lock(old.revisionId as RevisionId);
    assert.ok(revision);
    const before = await uow.sources.retention.recordFor(old.revisionId as RevisionId, "UNPAID");
    assert.ok(before);
    const expired = applied(await uow.sources.retention.expireRecord(old.retentionId as RetentionId, before.version), "expireRecord");
    assert.deepEqual([expired.state, expired.expiredAt, expired.version, expired.hardDeadline, expired.effectiveDeadline], ["EXPIRED", now, before.version + 1, before.hardDeadline, before.effectiveDeadline]);
    await emit("retention_record", old.retentionId, expired.version, "retention_record.expired.v1", { retentionId: old.retentionId, agencyId: t.ag.agencyId, projectId: pOld.projectId, revisionId: old.revisionId, retentionClass: "UNPAID" });
    assert.deepEqual(await uow.sources.retention.expireRecord(old.retentionId as RetentionId, before.version), { kind: "STALE", currentVersion: expired.version, currentState: "EXPIRED" });
    const gone = applied(await uow.sources.revisions.transition(revision.revisionId, revision.version, { event: "retention_expires", reason: "RETENTION_DEADLINE" }), "retention_expires");
    assert.deepEqual([gone.state, gone.expiredAt, gone.terminalReason, gone.sealedAt], ["EXPIRED", now, "RETENTION_DEADLINE", revision.sealedAt]);
    await emit("dataset_revision", revision.revisionId, gone.version, "dataset_revision.expired.v1", { revisionId: revision.revisionId, agencyId: t.ag.agencyId, projectId: pOld.projectId, previousState: "SEALED", reasonCode: "RETENTION_DEADLINE", retentionId: old.retentionId });
  });
  await h.app.runSource(asOwner(t), async (uow) => {
    assert.deepEqual(await uow.sources.availability.availabilityOf(old.revisionId as RevisionId), { revisionId: old.revisionId, state: "EXPIRED", manifestHash: old.manifestHash, availableUntil: null, retentionId: null });
    const youngAvailability = await uow.sources.availability.availabilityOf(young.revisionId as RevisionId);
    assert.deepEqual([youngAvailability?.state, youngAvailability?.availableUntil, youngAvailability?.retentionId], ["SEALED", youngRecord?.effectiveDeadline, young.retentionId]);
  });
  assert.ok(!(await h.control.runSource(asControl(null), (uow) => uow.sources.retention.findDue(1000))).some((x) => x.retentionId === old.retentionId));
});

test("FINAL-N2: retention_expires takes a REJECTED revision to EXPIRED once every intake window closed and keeps the rejection's reason — refused while a window is open — and a re-explained reason is refused KA004", async () => {
  const t = await tenant("rejected-expiry");
  /** A revision whose bound selection failed its evaluation (fatal_input_rejection by the control plane), intake begun at `base`. */
  const rejectedRevision = async (seed: string, base: Date) => {
    const p = await project(t);
    const bound = await bindSourceSelection(sessionsOf(t), scopeOf(t, p.projectId), await admitSourceFile(sessionsOf(t), scopeOf(t, p.projectId), { seed, base }));
    const revisionId = bound.revisionId as RevisionId;
    const rejected = await h.control.runSource(asControl(t), async (uow) => {
      const now = await uow.serverInstant();
      const revision = await uow.sources.revisions.lock(revisionId);
      assert.ok(revision);
      const evaluationId = ids.next() as EvaluationId;
      const evaluationHash = evaluationHashOf({ revisionId, selectionHash: bound.selectionHash, failures: ["FORMULA_ERROR_VALUES"] });
      await uow.sources.evaluations.append({
        evaluationId,
        agencyId: t.ag.agencyId,
        revisionId,
        selectionManifestId: bound.selectionManifestId as SelectionManifestId,
        selectionHash: bound.selectionHash as Sha256Hex,
        evaluationHash,
        result: "ADMISSION_FAILED",
        files: [],
        tables: [],
        projections: [],
        failures: [{ code: "FORMULA_ERROR_VALUES", tableId: bound.tableId as SourceTableId }],
        pricingDefinition: PRICING_DEFINITION,
        evaluatorVersion: "data-plane-0.1.0",
        startedAt: now,
        completedAt: now,
      });
      const w = applied(await uow.sources.revisions.transition(revisionId, revision.version, { event: "fatal_input_rejection", reason: "SELECTED_INPUT_REJECTED" }), "fatal_input_rejection");
      await emitOf(uow, t)("dataset_revision", revisionId, w.version, "dataset_revision.rejected.v1", { revisionId, agencyId: t.ag.agencyId, projectId: p.projectId, selectionHash: bound.selectionHash, evaluationHash, reasonCode: "SELECTED_INPUT_REJECTED" });
      assert.deepEqual([w.state, w.rejectedAt, w.terminalReason], ["REJECTED", now, "SELECTED_INPUT_REJECTED"]);
      return w;
    });
    return { p, rejected };
  };
  // the intake window of the rejected input is still open: not due, and refused (KA072)
  const young = await rejectedRevision("rejected-young", new Date(Date.now() - HOUR_MS));
  assert.ok(!(await h.control.runSource(asControl(null), (uow) => uow.sources.revisions.findRetentionDue(1000))).some((x) => x.revisionId === young.rejected.revisionId));
  await assert.rejects(h.control.runSource(asControl(t), (uow) => uow.sources.revisions.transition(young.rejected.revisionId, young.rejected.version, { event: "retention_expires", reason: "RETENTION_DEADLINE" })), refused("INTEGRITY_FAILURE", "LIFECYCLE_BINDING_MISSING", "KA072"));
  // every window closed: due, and the expiry commits keeping the rejection's reason (terminal facts are set once)
  const old = await rejectedRevision("rejected-old", new Date(Date.now() - 2 * DAY_MS));
  assert.ok((await h.control.runSource(asControl(null), (uow) => uow.sources.revisions.findRetentionDue(1000))).some((x) => x.revisionId === old.rejected.revisionId));
  const expired = await h.control.runSource(asControl(t), async (uow) => {
    const now = await uow.serverInstant();
    const w = applied(await uow.sources.revisions.transition(old.rejected.revisionId, old.rejected.version, { event: "retention_expires", reason: "RETENTION_DEADLINE" }), "retention_expires");
    await emitOf(uow, t)("dataset_revision", w.revisionId, w.version, "dataset_revision.expired.v1", { revisionId: w.revisionId, agencyId: t.ag.agencyId, projectId: old.p.projectId, previousState: "REJECTED", reasonCode: "SELECTED_INPUT_REJECTED" });
    assert.deepEqual([w.state, w.expiredAt, w.rejectedAt, w.terminalReason], ["EXPIRED", now, old.rejected.rejectedAt, "SELECTED_INPUT_REJECTED"]);
    return w;
  });
  // the reason is never re-explained, whoever writes it (KA004)
  await assert.rejects(
    rawTx(h.controlPool, t.ag.agencyId, "", (c) => c.query("UPDATE kauro.dataset_revisions SET terminal_reason = 'RETENTION_DEADLINE', version = version + 1 WHERE revision_id = $1", [expired.revisionId])),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, "KA004");
      return true;
    },
  );
});

test("tenant isolation of runSource: a request handler finds, locks and moves nothing of another agency's uploads, objects, receipts, files, revisions, anchors or lineage, cannot reserve into its revision, and the control plane bound to one agency neither sees nor revokes another's", async () => {
  const a = await tenant("isolation-a");
  const b = await tenant("isolation-b");
  const admitted = await admittedThroughAdapters(a);
  await h.app.runSource(asOwner(b), async (uow) => {
    const s = uow.sources;
    assert.equal(await s.uploads.get(admitted.uploadId), null);
    assert.equal(await s.uploads.lock(admitted.uploadId), null);
    assert.deepEqual(await s.uploads.listByRevision(admitted.revisionId, { limit: 10 }), []);
    assert.deepEqual(await s.uploads.quota(admitted.revisionId), { revisionId: admitted.revisionId, reservedBytes: 0, fileCount: 0 });
    assert.equal(await s.revisions.get(admitted.revisionId), null);
    assert.equal(await s.revisions.lock(admitted.revisionId), null);
    assert.deepEqual(await s.revisions.inventory(admitted.revisionId), { revisionId: admitted.revisionId, uploads: [], files: [] });
    assert.equal(await s.files.get(admitted.fileId), null);
    assert.deepEqual(await s.files.tables(admitted.fileId), []);
    assert.deepEqual(await s.files.columns(admitted.tableId), []);
    assert.deepEqual(await s.files.listReusable(admitted.projectId), []);
    assert.equal(await s.objects.get(admitted.acceptedObjectId), null);
    assert.deepEqual(await s.objects.inventory({ projectId: admitted.projectId }), []);
    assert.equal(await s.inspections.getByHash(admitted.receiptHash), null);
    assert.deepEqual(await s.retention.anchorsOf(admitted.revisionId), []);
    assert.equal(await s.availability.availabilityOf(admitted.revisionId), null);
    assert.deepEqual(await s.lineage.replacementsSince(admitted.revisionId), []);
    assert.equal(await s.sessionSecrets.readOwn(admitted.uploadId), null);
  });
  await assert.rejects(h.app.runSource(asOwner(b), (uow) => uow.sources.uploads.transition(admitted.uploadId, 5, { event: "cancel_upload", byMembershipId: b.ag.ownerMembershipId, reason: "CANCELLED_BY_REQUESTER" })), refused("NOT_FOUND"));
  await assert.rejects(h.app.runSource(asOwner(b), (uow) => uow.sources.revisions.transition(admitted.revisionId, 2, { event: "cancel_revision", reason: "REPLACED_BY_NEW_REVISION" })), refused("NOT_FOUND"));
  // a reservation of B into A's revision: the composite keys bind the tenant (07 "Database representation")
  await assert.rejects(h.app.runSource(asOwner(b), (uow) => reserveVia(uow.sources, emitOf(uow, b), b, { projectId: admitted.projectId, revisionId: admitted.revisionId }, 10, { lockRevision: false })), refused("INVALID_REQUEST", "UNKNOWN_REFERENCE", "23503"));
  // the control plane bound to B: nothing of A
  await h.control.runSource(asControl(b), async (uow) => {
    assert.equal(await uow.sources.uploads.get(admitted.uploadId), null);
    assert.equal(await uow.sources.files.get(admitted.fileId), null);
    assert.equal(await uow.sources.revisions.get(admitted.revisionId), null);
    assert.equal(await uow.sources.inspections.getByHash(admitted.receiptHash), null);
  });
  await assert.rejects(h.control.runSource(asControl(b), (uow) => uow.sources.files.revokeAdmission(admitted.fileId, 1, "GENERATION_MISSING")), refused("NOT_FOUND"));
  // bound to A it sees A's rows (and could move them)
  assert.equal((await h.control.runSource(asControl(a), (uow) => uow.sources.files.get(admitted.fileId)))?.state, "ADMITTED");
  assert.deepEqual(await oracle("SELECT state, version::int AS version FROM kauro.upload_sessions WHERE upload_id = $1", [admitted.uploadId]), { state: "ADMITTED", version: 5 });
});
