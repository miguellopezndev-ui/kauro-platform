// The B07 migrations (0009..0012) against a real PostgreSQL 17 (07 "Acceptance obligations": real PostgreSQL for tenant
// constraints, transactions, migrations and concurrency). Every write goes through a runtime login role under a bound context —
// kauro_app_test as a request handler, kauro_control_test as the control plane bound to one agency (design D-CTRL-1) — so the
// positive paths prove the policies admit the legitimate lifecycle (21 "Positive and negative symmetry"); the superuser is the
// oracle only (and, where a test says so, the adversary that corrupts a ledger to show who notices). The schema is judged against
// the registry (enum vocabularies) and the domain (machines, aggregate kinds). Interleavings are fixed by lock-wait observation,
// never by time (21 "Concurrency and crash matrix"). Each case works in an agency of its own, so the agency-wide capacity ledger of
// one case never decides another. Instants are the server's (D-CLOCK-1): a case that needs a past positions the labelled TEST
// CLOCK of its own transaction (clockAt), never a back-dated row.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { registryJson } from "@kauro/contracts";
import { AGGREGATE_KINDS, SOURCE_LIFECYCLE_STATE_MACHINES, sealedSubjectHashOf, sourceRevisionManifestHashOf, type SealedSubjectDocument, type SourceRevisionManifest } from "@kauro/domain";
import {
  admitSourceFile,
  appendFixtureEvent,
  bindSourceSelection,
  clockAt,
  countSourceSelection,
  expireSealedRevision,
  fixtureSelection,
  readySourceRevision,
  sealReadyRevision,
  sealSourceRevision,
  sealStatements,
  sealedManifestOf,
  startTemporaryPostgres,
  waitForLockWait,
  type ReadySourceFixture,
  type SourceFixtureScope,
  type SourceFixtureSessions,
  type TemporaryPostgres,
} from "../src/testing/index.js";
import { handled } from "../src/testing/harness.js";
import { agency, endClient, event, ids, member, offeredCapability, person, processingAuthority, project, sha, tx, type AgencyFixture, type Context } from "./support.js";

let pg: TemporaryPostgres;
let su: Client;
let app: Client;
let app2: Client;
let control: Client;
let control2: Client;
let capabilityId: string;

before(async () => {
  pg = await startTemporaryPostgres();
  su = await pg.connect("postgres");
  app = await pg.connect("kauro_app_test");
  app2 = await pg.connect("kauro_app_test");
  control = await pg.connect("kauro_control_test");
  control2 = await pg.connect("kauro_control_test");
  capabilityId = await offeredCapability(control, "CLEAN");
});

after(async () => {
  await control2.end();
  await control.end();
  await app2.end();
  await app.end();
  await su.end();
  await pg.stop();
});

const GB = 1_000_000_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const APP_NAME = "kauro-test-kauro_app_test";
const CONTROL_NAME = "kauro-test-kauro_control_test";

/** An agency of its own with its owner and one end client. */
interface Tenant {
  readonly ag: AgencyFixture;
  readonly clientId: string;
}

let tenants = 0;
async function tenant(label: string): Promise<Tenant> {
  const owner = await person(app, `b07-${label}-${++tenants}`);
  const ag = await agency(app, owner, `Agency ${label}`);
  const clientId = await endClient(app, ag, await processingAuthority(app, ag));
  return { ag, clientId };
}

const as = (t: Tenant): Context => ({ agencyId: t.ag.agencyId, userId: t.ag.ownerUserId });

async function freshProject(t: Tenant): Promise<{ projectId: string; revisionId: string }> {
  return project(app, t.ag, t.clientId, capabilityId);
}

/** A SYSTEM unit of work of the control plane bound to one agency (kauro.agency_id set, no user), or unbound (null). */
async function controlTx<T>(agencyId: string | null, fn: (c: Client) => Promise<T>, client: Client = control): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [agencyId ?? ""]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Opens a transaction the test holds open (tenant context for kauro_app, agency-bound for kauro_control). */
async function hold(client: Client, ctx: Context): Promise<void> {
  await client.query("BEGIN");
  await client.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [ctx.agencyId ?? "", ctx.userId ?? ""]);
}

async function rollback(...clients: Client[]): Promise<void> {
  for (const c of clients) await c.query("ROLLBACK").catch(() => undefined);
}

function sessionsOf(t: Tenant): SourceFixtureSessions {
  return { app: (fn) => tx(app, as(t), fn), control: (fn) => controlTx(t.ag.agencyId, fn) };
}

function scopeOf(t: Tenant, projectId: string): SourceFixtureScope {
  return { agencyId: t.ag.agencyId, projectId, ownerUserId: t.ag.ownerUserId, ownerMembershipId: t.ag.ownerMembershipId };
}

function code(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function refusedWith(sqlState: string, constraint?: string): (e: unknown) => boolean {
  return (e) => {
    assert.equal(code(e), sqlState, e instanceof Error ? e.message : String(e));
    if (constraint !== undefined) assert.equal((e as { constraint?: string }).constraint, constraint);
    return true;
  };
}

async function oracleRow<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await su.query<T>(sql, params);
  assert.equal(r.rows.length, 1, sql);
  return r.rows[0] as T;
}

interface Reserved {
  readonly uploadId: string;
  readonly objectId: string;
}

/**
 * ReserveUpload's first unit of work as the handler performs it (design §11): the quarantine intent, the RESERVED upload holding
 * the issuance fence, its UPLOAD_INITIATED anchor, all at the server instant (`at` positions the TEST CLOCK of this transaction),
 * and its event. The revision is not moved.
 */
async function reserveIn(
  c: Client,
  t: Tenant,
  projectId: string,
  revisionId: string,
  bytes: number,
  options: { readonly anchored?: boolean; readonly at?: Date; readonly requester?: { readonly membershipId: string; readonly userId: string } } = {},
): Promise<Reserved> {
  if (options.at !== undefined) await clockAt(c, options.at);
  const uploadId = ids.next();
  const objectId = ids.next();
  const requester = options.requester ?? { membershipId: t.ag.ownerMembershipId, userId: t.ag.ownerUserId };
  await c.query(
    `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RAW', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $6, 'MEMBERSHIP', $7, kauro.server_now(), now())`,
    [objectId, t.ag.agencyId, projectId, revisionId, uploadId, `quarantine/${t.ag.agencyId}/${projectId}/${revisionId}/${uploadId}`, requester.membershipId],
  );
  await c.query(
    `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, display_name, declared_format, reserved_bytes, quarantine_object_id, requested_by_membership_id, requested_by_user_id, application_expires_at, session_attempt, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'contacts export.csv', 'CSV', $5, $6, $7, $8, kauro.server_now() + interval '86400 seconds', 1, kauro.server_now(), now())`,
    [uploadId, t.ag.agencyId, projectId, revisionId, bytes, objectId, requester.membershipId, requester.userId],
  );
  await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "upload_session.reserved.v1", actorUserId: t.ag.ownerUserId, payload: { uploadId, reservedBytes: bytes } });
  if (options.anchored !== false) {
    await c.query(
      `INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, 'UPLOAD_INITIATED', kauro.server_now(), $6, now())`,
      [ids.next(), t.ag.agencyId, projectId, revisionId, uploadId, sha("anchor-" + uploadId)],
    );
  }
  return { uploadId, objectId };
}

/** upload_reserved (DRAFT -> UPLOADING) in the reservation's own unit of work. */
async function toUploading(c: Client, t: Tenant, revisionId: string, firstUploadId: string): Promise<void> {
  const r = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'UPLOADING', version = version + 1 WHERE revision_id = $1 AND state = 'DRAFT' RETURNING version::text", [revisionId]);
  assert.equal(r.rowCount, 1);
  await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.uploading.v1", actorUserId: t.ag.ownerUserId, payload: { revisionId, firstUploadId } });
}

/** CMD013 phase 2 (request handler): the provider session is issued; RESERVED -> UPLOADING, v2 (at the server instant). */
async function issueSession(c: Client, t: Tenant, uploadId: string, at?: Date): Promise<void> {
  if (at !== undefined) await clockAt(c, at);
  await c.query(
    "UPDATE kauro.upload_sessions SET state = 'UPLOADING', version = 2, session_issued_at = kauro.server_now(), provider_session_digest = $2, provider_session_expires_at = kauro.server_now() + interval '7 days' WHERE upload_id = $1 AND version = 1",
    [uploadId, sha("session-" + uploadId)],
  );
  await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 2, agencyId: t.ag.agencyId, eventType: "upload_session.session_issued.v1", actorUserId: t.ag.ownerUserId });
}

/** CMD014 (request handler): the completion claim; UPLOADING -> VERIFYING, v3. Nothing is admitted. */
async function reportCompletion(c: Client, t: Tenant, uploadId: string, at?: Date): Promise<void> {
  if (at !== undefined) await clockAt(c, at);
  await c.query("UPDATE kauro.upload_sessions SET state = 'VERIFYING', version = 3, completion_reported_at = kauro.server_now(), completion_claim_digest = $2 WHERE upload_id = $1 AND version = 2", [uploadId, sha("claim-" + uploadId)]);
  await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 3, agencyId: t.ag.agencyId, eventType: "upload_session.completion_reported.v1", actorUserId: t.ag.ownerUserId });
}

/** UPLOAD_INSPECTION's first step as statements of a control transaction the caller holds: revision row first (D-LOCK-2), fence, observation (v4). */
async function observeIn(c: Client, t: Tenant, revisionId: string, uploadId: string, generation: string, bytes: number): Promise<void> {
  await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [revisionId]);
  await c.query("UPDATE kauro.upload_sessions SET inspection_fence = inspection_fence + 1 WHERE upload_id = $1 AND state = 'VERIFYING'", [uploadId]);
  await c.query("UPDATE kauro.upload_sessions SET version = 4, completion_observed_at = kauro.server_now(), observed_generation = $2, observed_bytes = $3 WHERE upload_id = $1 AND version = 3", [uploadId, generation, bytes]);
  await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 4, agencyId: t.ag.agencyId, eventType: "upload_session.completion_observed.v1", actorUserId: null, payload: { uploadId, observedBytes: bytes } });
}

async function claimAndObserve(t: Tenant, revisionId: string, uploadId: string, generation: string, bytes: number, at?: Date): Promise<void> {
  await controlTx(t.ag.agencyId, async (c) => {
    if (at !== undefined) await clockAt(c, at);
    await observeIn(c, t, revisionId, uploadId, generation, bytes);
  });
}

interface Verifying extends Reserved {
  readonly projectId: string;
  readonly revisionId: string;
}

/**
 * An upload of the given revision reserved, issued, reported and observed (VERIFYING, fence 1, v4); `first` also takes
 * upload_reserved (DRAFT -> UPLOADING); `at` stands the whole intake at that instant of the TEST CLOCK (one second per step).
 */
async function verifyingUploadIn(t: Tenant, projectId: string, revisionId: string, reservedBytes: number, generation: string, observedBytes: number, first: boolean, at?: Date): Promise<Verifying> {
  const step = (n: number): Date | undefined => (at === undefined ? undefined : new Date(at.getTime() + n * 1000));
  const up = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, projectId, revisionId, reservedBytes, step(0) === undefined ? {} : { at: step(0)! });
    if (first) await toUploading(c, t, revisionId, r.uploadId);
    return r;
  });
  await tx(app, as(t), (c) => issueSession(c, t, up.uploadId, step(1)));
  await tx(app, as(t), (c) => reportCompletion(c, t, up.uploadId, step(2)));
  await claimAndObserve(t, revisionId, up.uploadId, generation, observedBytes, step(3));
  return { ...up, projectId, revisionId };
}

/** A fresh project whose revision holds one upload VERIFYING, completion reported and observed (fence 1, v4). */
async function verifyingUpload(t: Tenant, reservedBytes: number, generation: string, observedBytes: number): Promise<Verifying> {
  const { projectId, revisionId } = await freshProject(t);
  return verifyingUploadIn(t, projectId, revisionId, reservedBytes, generation, observedBytes, true);
}

/**
 * The instant a receipt of the current attempt starts at (D-INSP-4): the claim the database stamped when the fence advanced. Every
 * receipt insert of this file binds the agency as $2 and the upload as $3.
 */
const CLAIMED_AT = "(SELECT u.inspection_claimed_at FROM kauro.upload_sessions u WHERE u.agency_id = $2 AND u.upload_id = $3)";

/** One complete coverage entry: the container scanned at its full observed length (S054, B07-F4). */
function containerCoverage(uploadId: string, bytes: number): string {
  return JSON.stringify([{ partDigest: sha("container-" + uploadId), partKind: "CONTAINER", expectedBytes: bytes, scannedBytes: bytes, outcome: "CLEAN" }]);
}

interface AdmittedFile {
  readonly fileId: string;
  readonly tableId: string;
  readonly structureHash: string;
  readonly generation: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * UPLOAD_INSPECTION's admission of an observed upload as statements of a control transaction the caller holds (revision row first,
 * D-LOCK-2): the promoted accepted generation, the receipt (container covered), the file and its event (B07-F9), its one table,
 * ADMITTED and its event, the INPUT_ADMITTED anchor.
 */
async function admitIn(c: Client, t: Tenant, up: Verifying, generation: string, bytes: number): Promise<AdmittedFile> {
  const acceptedId = ids.next();
  const fileId = ids.next();
  const tableId = ids.next();
  const acceptedGeneration = String(Number(generation) + 1);
  const bytesHash = sha("bytes-" + up.uploadId);
  const receiptHash = sha("receipt-" + up.uploadId);
  const structureHash = sha("structure-" + tableId);
  await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [up.revisionId]);
  await c.query("UPDATE kauro.stored_objects SET state = 'PRESENT', generation = $2, bytes = $3, observed_at = kauro.server_now() WHERE object_id = $1", [up.objectId, generation, bytes]);
  await c.query("UPDATE kauro.stored_objects SET state = 'VERIFIED', sha256 = $2, verified_at = kauro.server_now() WHERE object_id = $1", [up.objectId, bytesHash]);
  await c.query(
    `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'ACCEPTED', 'RAW', 'contract-fake-storage', 'ACCEPTED_PRIMARY', $6, 'SERVICE', 'upload-inspection', kauro.server_now(), now())`,
    [acceptedId, t.ag.agencyId, up.projectId, up.revisionId, up.uploadId, `accepted/${t.ag.agencyId}/${up.projectId}/${fileId}`],
  );
  await c.query("UPDATE kauro.stored_objects SET state = 'PRESENT', generation = $2, bytes = $3, observed_at = kauro.server_now() WHERE object_id = $1", [acceptedId, acceptedGeneration, bytes]);
  await c.query("UPDATE kauro.stored_objects SET state = 'VERIFIED', sha256 = $2, verified_at = kauro.server_now() WHERE object_id = $1", [acceptedId, bytesHash]);
  await c.query(
    `INSERT INTO kauro.inspection_receipts (receipt_id, agency_id, upload_id, revision_id, receipt_hash, inspection_fence, quarantine_object_id, observed_generation, observed_bytes, sha256,
        completion_claim_digest, claim_consistent, declared_format, detected_format, structure_status, scan_state, scanner_engine, scanner_engine_version, signature_version,
        signatures_published_at, signature_max_age_seconds, scanner_config_hash, scanned_at, expected_parts, expected_bytes, scanned_parts, scanned_bytes, coverage, parser_profile_hash,
        inspector_version, outcome, accepted_object_id, accepted_generation, accepted_sha256, started_at, completed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, true, 'CSV', 'CSV', 'STRUCTURE_VALID', 'COVERED_CLEAN', 'contract-fake-scanner', 'SIMULATED-1', 'SIG-1',
        kauro.server_now() - interval '1 hour', 86400, $11, kauro.server_now(), 1, $8, 1, $8, $12, $13, 'data-plane-0.1.0', 'ADMITTED', $14, $15, $9, ${CLAIMED_AT}, kauro.server_now(), kauro.server_now())`,
    [ids.next(), t.ag.agencyId, up.uploadId, up.revisionId, receiptHash, up.objectId, generation, bytes, bytesHash, sha("claim-" + up.uploadId), sha("scanner-config"), containerCoverage(up.uploadId, bytes), sha("parser-profile"), acceptedId, acceptedGeneration],
  );
  await c.query(
    `INSERT INTO kauro.source_files (file_id, agency_id, project_id, origin_revision_id, origin_upload_id, accepted_object_id, provider_generation, sha256, bytes, format, scan_state, parser_profile_hash, inspection_receipt_hash, admitted, admitted_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CSV', 'COVERED_CLEAN', $10, $11, true, kauro.server_now(), now(), now())`,
    [fileId, t.ag.agencyId, up.projectId, up.revisionId, up.uploadId, acceptedId, acceptedGeneration, bytesHash, bytes, sha("parser-profile"), receiptHash],
  );
  await appendFixtureEvent(c, { aggregateKind: "source_file", aggregateId: fileId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "source_file.admitted.v1", actorUserId: null, payload: { fileId } });
  await c.query(
    `INSERT INTO kauro.source_tables (table_id, agency_id, file_id, ordinal, kind, name_display, name_digest, visibility, column_count, row_estimate, has_formulas, formula_cache, structure_hash, created_at)
     VALUES ($1, $2, $3, 0, 'CSV_TABLE', NULL, $4, 'VISIBLE', 2, 10, false, 'NOT_APPLICABLE', $5, now())`,
    [tableId, t.ag.agencyId, fileId, sha(""), structureHash],
  );
  await c.query("UPDATE kauro.upload_sessions SET state = 'ADMITTED', version = 5, admitted_at = kauro.server_now(), file_id = $2, inspection_receipt_hash = $3 WHERE upload_id = $1 AND version = 4", [up.uploadId, fileId, receiptHash]);
  await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 5, agencyId: t.ag.agencyId, eventType: "upload_session.admitted.v1", actorUserId: null, payload: { uploadId: up.uploadId, fileId } });
  await c.query(
    "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, 'INPUT_ADMITTED', kauro.server_now(), $6, now())",
    [ids.next(), t.ag.agencyId, up.projectId, up.revisionId, up.uploadId, sha("admitted-" + up.uploadId)],
  );
  return { fileId, tableId, structureHash, generation: acceptedGeneration, sha256: bytesHash, bytes };
}

async function admit(t: Tenant, up: Verifying, generation: string, bytes: number, at?: Date): Promise<AdmittedFile> {
  return controlTx(t.ag.agencyId, async (c) => {
    if (at !== undefined) await clockAt(c, at);
    return admitIn(c, t, up, generation, bytes);
  });
}

/** UPLOAD_INSPECTION's rejection of an observed upload (a rejecting receipt of the current attempt, REJECTED, INTAKE_REJECTED). */
async function reject(t: Tenant, up: Verifying, generation: string, bytes: number): Promise<void> {
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [up.revisionId]);
    const receiptHash = sha("rejection-" + up.uploadId);
    await c.query(
      `INSERT INTO kauro.inspection_receipts (receipt_id, agency_id, upload_id, revision_id, receipt_hash, inspection_fence, quarantine_object_id, observed_generation, observed_bytes,
          completion_claim_digest, claim_consistent, declared_format, detected_format, structure_status, scan_state, inspector_version, outcome, rejection_class, started_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, true, 'CSV', 'CSV', 'STRUCTURE_INVALID', 'NOT_SCANNED', 'data-plane-0.1.0', 'REJECTED', 'CORRUPT_STRUCTURE', ${CLAIMED_AT}, kauro.server_now(), kauro.server_now())`,
      [ids.next(), t.ag.agencyId, up.uploadId, up.revisionId, receiptHash, up.objectId, generation, bytes, sha("claim-" + up.uploadId)],
    );
    await c.query("UPDATE kauro.upload_sessions SET state = 'REJECTED', version = 5, rejected_at = kauro.server_now(), terminal_reason = 'CORRUPT_STRUCTURE', inspection_receipt_hash = $2 WHERE upload_id = $1 AND version = 4", [up.uploadId, receiptHash]);
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 5, agencyId: t.ag.agencyId, eventType: "upload_session.rejected.v1", actorUserId: null, payload: { uploadId: up.uploadId, rejectionClass: "CORRUPT_STRUCTURE" } });
    await c.query(
      "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, 'INTAKE_REJECTED', kauro.server_now(), $6, now())",
      [ids.next(), t.ag.agencyId, up.projectId, up.revisionId, up.uploadId, receiptHash],
    );
  });
}

/**
 * CMD015 as the handler writes it: the upload tombstoned by its requester. The provider cancellation is not the handler's to write
 * (D-ROLE-3): the database requests it in the same update when a session was issued (upload_sessions_cancellation_requested).
 */
async function cancelUpload(c: Client, t: Tenant, uploadId: string, version: number, reason = "CANCELLED_BY_REQUESTER"): Promise<void> {
  const r = await c.query(
    `UPDATE kauro.upload_sessions SET state = 'CANCELLED', version = $2, cancelled_at = kauro.server_now(), cancelled_by_membership_id = $3, terminal_reason = $4
      WHERE upload_id = $1 AND version = $2 - 1`,
    [uploadId, version, t.ag.ownerMembershipId, reason],
  );
  assert.equal(r.rowCount, 1);
  await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: version, agencyId: t.ag.agencyId, eventType: "upload_session.cancelled.v1", actorUserId: t.ag.ownerUserId });
}

/** CMD012's cancellation of a mutable revision (request handler). */
async function cancelRevision(c: Client, t: Tenant, revisionId: string, reason = "REPLACED_BY_NEW_REVISION"): Promise<void> {
  const r = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'CANCELLED', cancelled_at = kauro.server_now(), terminal_reason = $2, version = version + 1 WHERE revision_id = $1 RETURNING version::text", [revisionId, reason]);
  assert.equal(r.rowCount, 1);
  await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.cancelled.v1", actorUserId: t.ag.ownerUserId });
}

interface SelectedFile {
  readonly fileId: string;
  readonly tableId: string;
  readonly structureHash: string;
  readonly origin: "THIS_REVISION" | "REUSED";
}

/**
 * The selection manifest intake and CMD016's binding as statements of a request-handler transaction the caller holds (revision row
 * first, D-LOCK-1): every file included with its one table. From UPLOADING this is all_uploads_completed (D-INTAKE-1).
 */
async function bindFilesIn(c: Client, t: Tenant, projectId: string, revisionId: string, files: ReadonlyArray<SelectedFile>, options: { readonly recordedInventory?: string; readonly tables?: ReadonlyArray<{ readonly fileId: string; readonly tableId: string; readonly structureHash: string }> } = {}): Promise<{ readonly selectionManifestId: string; readonly selectionHash: string }> {
  const inventory = sha("inventory-" + revisionId + files.map((f) => f.fileId).join(","));
  const body = {
    schemaVersion: 1,
    revisionId,
    inventoryHash: inventory,
    files: files.map((f) => ({ fileId: f.fileId, origin: f.origin, disposition: "INCLUDE" })),
    tables: (options.tables ?? files).map((f) => ({ tableId: f.tableId, fileId: f.fileId, structureHash: f.structureHash, disposition: "INCLUDE", parser: { kind: "CSV", encoding: "UTF_8", delimiter: "COMMA", quote: "DOUBLE_QUOTE", header: { mode: "FIRST_RECORD" }, blankLines: "SKIP" } })),
    projections: [],
    associations: [],
  };
  const selectionManifestId = ids.next();
  const selectionHash = sha("selection-" + selectionManifestId);
  await c.query(
    "INSERT INTO kauro.selection_manifests (selection_manifest_id, agency_id, project_id, revision_id, schema_version, body, body_hash, created_by_membership_id, created_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now())",
    [selectionManifestId, t.ag.agencyId, projectId, revisionId, JSON.stringify(body), selectionHash, t.ag.ownerMembershipId],
  );
  await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [revisionId]);
  const r = await c.query<{ version: string }>(
    "UPDATE kauro.dataset_revisions SET state = 'INSPECTING', selection_manifest_id = $2, selection_hash = $3, inventory_hash = $4, selected_at = kauro.server_now(), version = version + 1 WHERE revision_id = $1 RETURNING version::text",
    [revisionId, selectionManifestId, selectionHash, options.recordedInventory ?? inventory],
  );
  await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.selection_changed.v1", actorUserId: t.ag.ownerUserId });
  return { selectionManifestId, selectionHash };
}

/** An operations change of the agency's concurrent-session limit (the control plane; request handlers cannot write it). */
async function setSessionLimit(t: Tenant, limit: number): Promise<void> {
  await controlTx(t.ag.agencyId, (c) =>
    c.query(
      "INSERT INTO kauro.upload_capacity (agency_id, active_sessions, session_limit, updated_at) VALUES ($1, 0, $2, now()) ON CONFLICT (agency_id) DO UPDATE SET session_limit = EXCLUDED.session_limit, updated_at = now()",
      [t.ag.agencyId, limit],
    ),
  );
}

async function quotaOf(revisionId: string): Promise<{ bytes: string; files: number }> {
  return oracleRow("SELECT reserved_bytes::text AS bytes, file_count AS files FROM kauro.revision_quota WHERE revision_id = $1", [revisionId]);
}

async function stateOf(revisionId: string): Promise<string> {
  return (await oracleRow<{ state: string }>("SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId])).state;
}

interface RegistryContract {
  name: string;
  fields: Array<{ name: string; type: string }>;
}

function registryEnum(contract: string, field: string): string[] {
  const f = registryJson<RegistryContract[]>("contracts.json").find((c) => c.name === contract)?.fields.find((x) => x.name === field);
  assert.ok(f && f.type.startsWith("enum:"), `${contract}.${field}`);
  return f.type.slice(5).split(",");
}

const B07_TABLES = [
  "stored_objects", "storage_location_policies", "revision_quota", "upload_capacity", "upload_sessions", "upload_session_secrets",
  "inspection_receipts", "source_files", "source_tables", "source_table_columns", "selection_manifests", "selection_evaluations", "sealed_manifests",
  "sealed_revision_files", "retention_anchor_kinds", "retention_anchors", "retention_records", "object_holds", "object_hold_releases",
  "object_hold_reassertions",
];

// ---------------------------------------------------------------------------------------------------------------------------------

test("B07 tables force row-level security, belong to the migrator, grant no DELETE to request handlers and never show customer text to the control plane", async () => {
  const r = await su.query<{ relname: string; forced: boolean; owner: string }>(
    `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'kauro' AND c.relname = ANY($1)`,
    [B07_TABLES],
  );
  assert.equal(r.rows.length, B07_TABLES.length);
  const owners = new Set(r.rows.map((x) => x.owner));
  const b06Owner = await oracleRow<{ owner: string }>("SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'kauro.dataset_revisions'::regclass");
  assert.deepEqual([...owners], [b06Owner.owner], "the migrator owns every B07 table, as it owns B06's");
  for (const t of r.rows) assert.equal(t.forced, true, `${t.relname} must force RLS`);
  const deletable = async (role: string) =>
    (
      await su.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'kauro' AND c.relkind = 'r' AND has_table_privilege($1, c.oid, 'DELETE') ORDER BY 1`,
        [role],
      )
    ).rows.map((x) => x.relname);
  assert.deepEqual(await deletable("kauro_app"), [], "request handlers delete nothing (B06 D-RLS-2)");
  // besides B06's leases, the control plane deletes only the temporary provider-session record (09: a temporary control record)
  assert.deepEqual(await deletable("kauro_control"), ["leases", "upload_session_secrets"]);
  // customer text is never readable by the control plane; the inspection pipeline writes it but cannot read it back
  for (const [table, column] of [["upload_sessions", "display_name"], ["source_tables", "name_display"], ["source_table_columns", "label_display"]] as const) {
    const control = await oracleRow<{ read: boolean }>("SELECT has_column_privilege('kauro_control', $1, $2, 'SELECT') AS read", [`kauro.${table}`, column]);
    assert.equal(control.read, false, `${table}.${column}`);
    const tenantRead = await oracleRow<{ read: boolean }>("SELECT has_column_privilege('kauro_app', $1, $2, 'SELECT') AS read", [`kauro.${table}`, column]);
    assert.equal(tenantRead.read, true, `${table}.${column} is the tenant's own data`);
  }
  // request handlers cannot raise their own concurrent-session limit, and read nothing of the provider retention read-back
  assert.equal((await oracleRow<{ ok: boolean }>("SELECT has_column_privilege('kauro_app', 'kauro.upload_capacity', 'session_limit', 'UPDATE') AS ok")).ok, false);
  assert.equal((await oracleRow<{ ok: boolean }>("SELECT has_table_privilege('kauro_app', 'kauro.storage_location_policies', 'SELECT') AS ok")).ok, false);
  // the evidence the control plane produces is not writable by the request handlers whose gates it satisfies (B06 D-EVID-1)
  for (const table of ["inspection_receipts", "source_files", "source_tables", "source_table_columns", "selection_evaluations"]) {
    assert.equal((await oracleRow<{ ok: boolean }>("SELECT has_table_privilege('kauro_app', $1, 'INSERT') AS ok", [`kauro.${table}`])).ok, false, table);
  }
  // still no SECURITY DEFINER function anywhere, but the four the payment migrations add (the same exact allowlist as migrations.test.ts):
  // 0046's registration of a bank route's payment route, 0079's read-only provider-available balance of a payment route (PV1-SETTLE D-SET-5),
  // 0080's owner authority of a manual-rail refund and 0081's session fence of the bank owner commands, each with a pinned search_path
  const definers = await su.query<{ proname: string; proconfig: string[] | null }>("SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'kauro' AND p.prosecdef ORDER BY p.proname");
  assert.deepEqual(definers.rows, [
    { proname: "bank_owner_authority", proconfig: ["search_path=pg_catalog, pg_temp"] },
    { proname: "payment_session_fence", proconfig: ["search_path=pg_catalog, pg_temp"] },
    { proname: "register_bank_payment_route", proconfig: ["search_path=pg_catalog, pg_temp"] },
    { proname: "route_provider_available_cents", proconfig: ["search_path=pg_catalog, pg_temp"] },
  ]);
});

test("the state and enum CHECKs of the B07 tables carry exactly the registry vocabularies", async () => {
  const expected: Array<[string, string, string, string]> = [
    ["upload_sessions", "state", "UploadSession", "state"],
    ["upload_sessions", "provider_cancellation_state", "UploadSession", "providerCancellationState"],
    ["upload_sessions", "declared_format", "FileManifest", "format"],
    ["source_files", "format", "FileManifest", "format"],
    ["source_files", "scan_state", "FileManifest", "scanState"],
    ["inspection_receipts", "scan_state", "FileManifest", "scanState"],
    ["retention_records", "class", "RetentionRecord", "class"],
    ["retention_records", "state", "RetentionRecord", "state"],
  ];
  for (const [table, column, contract, field] of expected) {
    const r = await su.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'kauro' AND t.relname = $1 AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE 'CHECK ((' || $2 || ' = ANY%'`,
      [table, column],
    );
    assert.equal(r.rows.length, 1, `${table}.${column} has no enum CHECK`);
    const values = [...r.rows[0]!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]);
    assert.deepEqual(values, registryEnum(contract, field), `${table}.${column}`);
  }
});

test("UploadSession, StoredObject, SourceFile and RetentionRecord are seeded exactly as the domain machines, rows are born in their initial state, and B07's aggregate kinds are rows of the shared registry, bound through its unchanged function (B07-F7)", async () => {
  for (const m of SOURCE_LIFECYCLE_STATE_MACHINES) {
    const edges = [...new Set(m.transitions.map((e) => `${e.from}>${e.to}`))].sort();
    const r = await su.query<{ edge: string }>("SELECT from_state || '>' || to_state AS edge FROM kauro.state_transitions WHERE machine = $1 ORDER BY 1", [m.contract]);
    assert.deepEqual(r.rows.map((x) => x.edge), edges, m.contract);
    assert.equal((await oracleRow<{ initial_state: string }>("SELECT initial_state FROM kauro.state_machines WHERE machine = $1", [m.contract])).initial_state, m.initial, m.contract);
  }
  const kinds = await su.query<{ aggregate_kind: string }>("SELECT aggregate_kind FROM kauro.aggregate_kinds ORDER BY 1");
  assert.deepEqual(kinds.rows.map((x) => x.aggregate_kind), [...AGGREGATE_KINDS].sort());
  // B07 registers its three kinds by rows of the foundation's registry (0008) — owner B07, bound to their tables — and edits
  // nothing of it: the foreign key stands, and the binding is the foundation's table-driven function
  const b07 = await su.query("SELECT aggregate_kind, table_name, id_column FROM kauro.aggregate_kinds WHERE owner_package = 'B07' ORDER BY 1");
  assert.deepEqual(b07.rows, [
    { aggregate_kind: "retention_record", table_name: "retention_records", id_column: "retention_id" },
    { aggregate_kind: "source_file", table_name: "source_files", id_column: "file_id" },
    { aggregate_kind: "upload_session", table_name: "upload_sessions", id_column: "upload_id" },
  ]);
  const kindConstraints = await su.query<{ contype: string; conname: string }>(
    `SELECT c.contype, c.conname FROM pg_constraint c WHERE c.conrelid = 'kauro.domain_events'::regclass AND c.contype IN ('c', 'f')
        AND pg_get_constraintdef(c.oid) LIKE '%aggregate_kind%' ORDER BY 2`,
  );
  assert.deepEqual(kindConstraints.rows, [{ contype: "f", conname: "domain_events_aggregate_kind_fkey" }]);
  const binding = await oracleRow<{ def: string }>("SELECT pg_get_functiondef('kauro.domain_events_bind_aggregate()'::regprocedure) AS def");
  assert.ok(!/CASE NEW\.aggregate_kind/.test(binding.def) && binding.def.includes("kauro.aggregate_kinds"), "the table-driven foundation binding, never a CASE rewrite");
  // every registered kind binds: an unknown id of it is refused as not an aggregate of the agency (KA006), never as a kind
  // without a binding; an unregistered kind has no binding at all
  const t = await tenant("kinds");
  const eventOf = (kind: string) =>
    tx(app, as(t), (c) => event(c, { aggregateKind: kind, aggregateId: ids.next(), aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "project.created.v1", actorUserId: t.ag.ownerUserId }));
  for (const kind of AGGREGATE_KINDS) {
    await assert.rejects(eventOf(kind), (e: unknown) => {
      assert.equal(code(e), "KA006", String(e));
      assert.match((e as Error).message, /is not an aggregate of agency/, kind);
      return true;
    });
  }
  // a kind no package on this tree registers (package B09 registers quote since the B07+B09 merge)
  await assert.rejects(eventOf("job"), (e: unknown) => {
    assert.equal(code(e), "KA006", String(e));
    assert.match((e as Error).message, /has no binding/);
    return true;
  });
  // birth states (B06 D-INIT-1): an upload born past RESERVED and an object born past INTENDED are refused to the role that writes them
  const { projectId, revisionId } = await freshProject(t);
  await assert.rejects(
    tx(app, as(t), (c) =>
      c.query(
        `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, state, display_name, declared_format, reserved_bytes, quarantine_object_id, requested_by_membership_id, requested_by_user_id, application_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'VERIFYING', 'contacts.csv', 'CSV', 10, $5, $6, $7, now() + interval '86400 seconds', now(), now())`,
        [ids.next(), t.ag.agencyId, projectId, revisionId, ids.next(), t.ag.ownerMembershipId, t.ag.ownerUserId],
      ),
    ),
    refusedWith("KA008"),
  );
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, zone, data_class, provider, location_ref, object_name, state, generation, bytes, observed_at, created_by_kind, created_by_ref, created_at, updated_at)
         VALUES ($1, $2, $3, 'QUARANTINE', 'RESIDUAL', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $4, 'PRESENT', '7', 1, now(), 'SERVICE', 'inventory', now(), now())`,
        [ids.next(), t.ag.agencyId, projectId, `quarantine/${t.ag.agencyId}/${projectId}/${ids.next()}`],
      ),
    ),
    refusedWith("KA008"),
  );
});

test("the legitimate lifecycle passes every guard — reserve, issue, report, observe, inspect, promote, admit, select, evaluate, seal, anchor and retain — each write by the runtime role that owns it", async () => {
  const t = await tenant("lifecycle");
  const { projectId } = await freshProject(t);
  const scope = scopeOf(t, projectId);
  const admitted = await admitSourceFile(sessionsOf(t), scope, { seed: "lifecycle" });
  // the admitted upload holds its observed bytes (not its reservation) and no longer holds a session slot; the revision stays
  // UPLOADING: only the agency's selection closes the intake (D-INTAKE-1)
  assert.deepEqual(await quotaOf(admitted.revisionId), { bytes: String(admitted.bytes), files: 1 });
  assert.deepEqual(await oracleRow("SELECT active_sessions FROM kauro.upload_capacity WHERE agency_id = $1", [t.ag.agencyId]), { active_sessions: 0 });
  assert.equal(await stateOf(admitted.revisionId), "UPLOADING");
  // the reservation's deadline is exactly twenty-four hours after its initiation anchor (09 "Upload reservation")
  const anchored = await oracleRow<{ ok: boolean }>(
    `SELECT u.application_expires_at = a.occurred_at + interval '86400 seconds' AND a.occurred_at = u.created_at AS ok
       FROM kauro.upload_sessions u JOIN kauro.retention_anchors a ON a.upload_id = u.upload_id AND a.anchor_kind = 'UPLOAD_INITIATED' WHERE u.upload_id = $1`,
    [admitted.uploadId],
  );
  assert.equal(anchored.ok, true);
  const ready = await readySourceRevision(sessionsOf(t), scope, admitted);
  const sealed = await sealReadyRevision(sessionsOf(t), scope, ready);
  const row = await oracleRow(
    `SELECT r.state, r.version::text AS version, r.sealed_file_count, r.billable_source_units::int AS billable, r.manifest_hash = $2 AS manifest,
            (SELECT rr.hard_deadline = r.sealed_at + interval '1209600 seconds' FROM kauro.retention_records rr WHERE rr.revision_id = r.revision_id AND rr.class = 'UNPAID') AS hard_cap
       FROM kauro.dataset_revisions r WHERE r.revision_id = $1`,
    [sealed.revisionId, sealed.manifestHash],
  );
  // DRAFT v1 -> UPLOADING v2 -> INSPECTING v3 (all_uploads_completed with the selection) -> READY_TO_SEAL v4 -> SEALED v5
  assert.deepEqual(row, { state: "SEALED", version: "5", sealed_file_count: 1, billable: 120, manifest: true, hard_cap: true });
  // B07-F12: the stored manifest is exactly HASHING's KAURO_SOURCE_REVISION_V1 preimage (four members, no revision id, no
  // population) and hashes to the manifest hash; the sealed subject binds this revision and hashes to the subject hash
  const stored = await oracleRow<{ manifest: SourceRevisionManifest; subject: SealedSubjectDocument; subject_hash: string }>("SELECT manifest, subject, subject_hash FROM kauro.sealed_manifests WHERE revision_id = $1", [sealed.revisionId]);
  assert.deepEqual(Object.keys(stored.manifest).sort(), ["files", "parserProfile", "projection", "tableSelection"]);
  assert.equal(sourceRevisionManifestHashOf(stored.manifest), sealed.manifestHash);
  assert.equal(stored.subject.revisionId, sealed.revisionId);
  assert.equal(sealedSubjectHashOf(stored.subject), stored.subject_hash);
  assert.ok(!JSON.stringify(stored.manifest).includes("fixture source") && !JSON.stringify(stored.subject).includes("fixture source"), "a display name never enters the sealed documents");
  // the sealed subject is frozen: its selection cannot change afterwards (KA004), even for the request handlers that sealed it
  await assert.rejects(tx(app, as(t), (c) => c.query("UPDATE kauro.dataset_revisions SET selection_hash = $2, version = version + 1 WHERE revision_id = $1", [sealed.revisionId, sha("another selection")])), refusedWith("KA004"));
  // no display name reached an event of this lifecycle
  const payloads = await su.query<{ payload: unknown }>("SELECT payload FROM kauro.domain_events WHERE agency_id = $1", [t.ag.agencyId]);
  for (const p of payloads.rows) assert.ok(!JSON.stringify(p.payload).includes("fixture source"), "display names never enter events");
});

test("B07-F1: the intake closes only by the agency's explicit selection — with two concurrent sessions per agency a three-file intake stays UPLOADING across the gap between reservations, the control plane can never close it, and the selection closes it once every upload is settled", async () => {
  const t = await tenant("f1-three-files");
  const { projectId, revisionId } = await freshProject(t);
  // two sessions (the agency's limit): both reserved, issued, reported, observed and admitted
  const u1 = await verifyingUploadIn(t, projectId, revisionId, 100, "11", 64, true);
  const u2 = await verifyingUploadIn(t, projectId, revisionId, 100, "21", 64, false);
  // a third reservation now would exceed the concurrent limit; it waits for a slot, not for the revision
  await assert.rejects(tx(app, as(t), (c) => reserveIn(c, t, projectId, revisionId, 100)), refusedWith("23514", "upload_capacity_within_limit"));
  const f1 = await admit(t, u1, "11", 64);
  const f2 = await admit(t, u2, "21", 64);
  // nothing is open now — the old side effect would have closed the intake here; the revision stays UPLOADING (D-INTAKE-1)
  assert.equal(await stateOf(revisionId), "UPLOADING");
  // the control plane cannot take all_uploads_completed: without a selection the guard refuses the edge (KA072); with one it holds
  // no grant on the selection columns (42501), and its row policy admits no INSPECTING revision either
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', version = version + 1 WHERE revision_id = $1", [revisionId])), refusedWith("KA072"));
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', selection_manifest_id = $2, selection_hash = $3, inventory_hash = $3, selected_at = kauro.server_now(), version = version + 1 WHERE revision_id = $1", [revisionId, ids.next(), sha("control selection")])),
    refusedWith("42501"),
  );
  // nor can the request handlers take it without binding a selection in the same update (KA072)
  await assert.rejects(
    tx(app, as(t), async (c) => {
      const r = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', version = version + 1 WHERE revision_id = $1 RETURNING version::text", [revisionId]);
      await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.inspecting.v1", actorUserId: t.ag.ownerUserId });
    }),
    refusedWith("KA072"),
  );
  // the third file is reserved into the same, still open, intake and admitted
  const u3 = await verifyingUploadIn(t, projectId, revisionId, 100, "31", 64, false);
  const files: SelectedFile[] = [f1, f2].map((f) => ({ ...f, origin: "THIS_REVISION" }));
  // while the third upload is in flight the selection cannot close the intake (a settled inventory, D-SEL-3)
  await assert.rejects(tx(app, as(t), (c) => bindFilesIn(c, t, projectId, revisionId, files)), refusedWith("KA072"));
  const f3 = await admit(t, u3, "31", 64);
  // the agency's selection of all three closes the intake: UPLOADING -> INSPECTING (all_uploads_completed), uncounted
  await tx(app, as(t), (c) => bindFilesIn(c, t, projectId, revisionId, [...files, { ...f3, origin: "THIS_REVISION" }]));
  assert.deepEqual(await oracleRow("SELECT state, evaluation_id FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId]), { state: "INSPECTING", evaluation_id: null });
  assert.deepEqual(await quotaOf(revisionId), { bytes: "192", files: 3 });
});

test("B07-F1: the last open upload cancelled (CMD015), expired (the deadline sweeper) or rejected (an inspection outcome) never strands the revision: each leaves it UPLOADING and closable by the selection of what was admitted", async () => {
  const t = await tenant("f1-last-open");
  const scenarios: Array<[string, (up: Verifying) => Promise<void>]> = [
    ["cancelled", (up) => tx(app, as(t), async (c) => {
      await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [up.revisionId]);
      await cancelUpload(c, t, up.uploadId, 5);
    })],
    ["expired", (up) => controlTx(t.ag.agencyId, async (c) => {
      await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [up.revisionId]);
      await c.query("UPDATE kauro.upload_sessions SET state = 'EXPIRED', version = 5, expired_at = kauro.server_now(), terminal_reason = 'RESERVATION_EXPIRED', provider_cancellation_state = 'REQUESTED', provider_cancellation_at = kauro.server_now() WHERE upload_id = $1 AND version = 4", [up.uploadId]);
      await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 5, agencyId: t.ag.agencyId, eventType: "upload_session.expired.v1", actorUserId: null, payload: { uploadId: up.uploadId } });
    })],
    ["rejected", (up) => reject(t, up, "91", 64)],
  ];
  for (const [label, settle] of scenarios) {
    const { projectId, revisionId } = await freshProject(t);
    // the admitted upload and the last open one were initiated twenty-five hours ago (the expired scenario needs the deadline
    // behind it; the others do not care), on the test clock
    const base = new Date(Date.now() - 25 * HOUR_MS);
    const kept = await verifyingUploadIn(t, projectId, revisionId, 100, "81", 64, true, base);
    const file = await admit(t, kept, "81", 64, new Date(base.getTime() + 10_000));
    const open = await verifyingUploadIn(t, projectId, revisionId, 100, "91", 64, false, new Date(base.getTime() + 20_000));
    await settle(open);
    assert.equal(await stateOf(revisionId), "UPLOADING", `${label}: nothing closed the intake by itself`);
    await tx(app, as(t), (c) => bindFilesIn(c, t, projectId, revisionId, [{ ...file, origin: "THIS_REVISION" }]));
    assert.equal(await stateOf(revisionId), "INSPECTING", `${label}: the selection closed it`);
  }
});

test("R2-052: two reservations that each fit alone serialize on the revision; only a combination within five billion bytes commits, and the per-file envelope holds", async () => {
  const t = await tenant("r2-052");
  // concurrency is not the subject: operations raise the agency's session limit so only the byte envelope decides
  await setSessionLimit(t, 8);
  const { projectId, revisionId } = await freshProject(t);
  await hold(app, as(t));
  await hold(app2, as(t));
  try {
    await reserveIn(app, t, projectId, revisionId, 1.5 * GB);
    // the second request, checked alone, fits (0 + 2e9 <= 5e9 in its snapshot); the database decides on the committed ledger
    const second = handled(reserveIn(app2, t, projectId, revisionId, 2 * GB));
    try {
      await waitForLockWait(su, APP_NAME, "INSERT INTO kauro.upload_sessions");
      // while the second waits, the first reserves another 2e9 (1.5e9 + 2e9 = 3.5e9 fits) and commits
      await reserveIn(app, t, projectId, revisionId, 2 * GB);
    } finally {
      await app.query("COMMIT");
    }
    // the second resumes on the committed ledger: 3.5e9 + 2e9 = 5.5e9 > 5e9 — refused by the ledger CHECK, not by a read
    await assert.rejects(second, refusedWith("23514", "revision_quota_bytes_within_envelope"));
    await app2.query("ROLLBACK");
  } catch (e) {
    await rollback(app, app2);
    throw e;
  }
  assert.deepEqual(await quotaOf(revisionId), { bytes: "3500000000", files: 2 });
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n, sum(reserved_bytes)::text AS total FROM kauro.upload_sessions WHERE revision_id = $1", [revisionId]), { n: 2, total: "3500000000" });
  // positive neighbour: the combination that reaches the envelope exactly commits; one byte more is refused
  await tx(app, as(t), (c) => reserveIn(c, t, projectId, revisionId, 1.5 * GB));
  assert.deepEqual(await quotaOf(revisionId), { bytes: "5000000000", files: 3 });
  await assert.rejects(tx(app, as(t), (c) => reserveIn(c, t, projectId, revisionId, 1)), refusedWith("23514", "revision_quota_bytes_within_envelope"));
  // a single file above 2e9 is refused by the per-file envelope wherever it goes
  const other = await freshProject(t);
  await assert.rejects(tx(app, as(t), (c) => reserveIn(c, t, other.projectId, other.revisionId, 2 * GB + 1)), refusedWith("23514", "upload_sessions_reserved_bytes_check"));
});

test("an agency holds two concurrent upload sessions: the third is refused by the capacity ledger, two racing reservations for the last slot serialize on it, and a tombstoned upload frees its slot exactly once", async () => {
  const t = await tenant("capacity");
  const p1 = await freshProject(t);
  const p2 = await freshProject(t);
  const p3 = await freshProject(t);
  const first = await tx(app, as(t), (c) => reserveIn(c, t, p1.projectId, p1.revisionId, 10));
  // RACE: one slot left; two reservations on different revisions each see a free slot and serialize on the agency's capacity row
  await hold(app, as(t));
  await hold(app2, as(t));
  try {
    await reserveIn(app, t, p2.projectId, p2.revisionId, 10);
    const racing = handled(reserveIn(app2, t, p3.projectId, p3.revisionId, 10));
    try {
      await waitForLockWait(su, APP_NAME, "INSERT INTO kauro.upload_sessions");
    } finally {
      await app.query("COMMIT");
    }
    await assert.rejects(racing, refusedWith("23514", "upload_capacity_within_limit"));
    await app2.query("ROLLBACK");
  } catch (e) {
    await rollback(app, app2);
    throw e;
  }
  assert.deepEqual(await oracleRow("SELECT active_sessions, session_limit FROM kauro.upload_capacity WHERE agency_id = $1", [t.ag.agencyId]), { active_sessions: 2, session_limit: 2 });
  await assert.rejects(tx(app, as(t), (c) => reserveIn(c, t, p3.projectId, p3.revisionId, 10)), refusedWith("23514", "upload_capacity_within_limit"));
  // cancelling the first releases its slot and its bytes exactly once
  await tx(app, as(t), (c) => cancelUpload(c, t, first.uploadId, 2));
  assert.deepEqual(await oracleRow("SELECT active_sessions FROM kauro.upload_capacity WHERE agency_id = $1", [t.ag.agencyId]), { active_sessions: 1 });
  assert.deepEqual(await quotaOf(p1.revisionId), { bytes: "0", files: 0 });
  // a cancelled upload never comes back: every edge out of CANCELLED is unlisted
  for (const target of ["RESERVED", "UPLOADING", "VERIFYING", "ADMITTED"]) {
    await assert.rejects(tx(app, as(t), (c) => c.query("UPDATE kauro.upload_sessions SET state = $2, version = 3 WHERE upload_id = $1", [first.uploadId, target])), refusedWith("KA008"), `CANCELLED -> ${target}`);
  }
  // the freed slot is usable exactly once more
  await tx(app, as(t), (c) => reserveIn(c, t, p3.projectId, p3.revisionId, 10));
  await assert.rejects(tx(app, as(t), (c) => reserveIn(c, t, p3.projectId, p3.revisionId, 10)), refusedWith("23514", "upload_capacity_within_limit"));
  // an operations limit change is the only way to admit more; the ledger itself stays exact
  await setSessionLimit(t, 8);
  await tx(app, as(t), (c) => reserveIn(c, t, p3.projectId, p3.revisionId, 10));
  assert.deepEqual(await oracleRow("SELECT active_sessions, session_limit FROM kauro.upload_capacity WHERE agency_id = $1", [t.ag.agencyId]), { active_sessions: 3, session_limit: 8 });
});

test("cancellation wins while verification races: a stale inspection attempt can attach no receipt and admit no file; fences never move backwards; the provider cancellation result only moves forward; the quota is released once", async () => {
  const t = await tenant("cancel-race");
  const up = await verifyingUpload(t, 100, "4242", 100);
  // the inspection claimed its attempt and observed the object; the requester's cancellation then wins the upload row (CMD015)
  await tx(app, as(t), (c) => cancelUpload(c, t, up.uploadId, 5));
  // the stale attempt tries to record its receipt: refused (KA071), whatever it observed
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.inspection_receipts (receipt_id, agency_id, upload_id, revision_id, receipt_hash, inspection_fence, quarantine_object_id, observed_generation, observed_bytes,
            completion_claim_digest, claim_consistent, declared_format, detected_format, structure_status, scan_state, inspector_version, outcome, rejection_class, started_at, completed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6, '4242', 100, $7, true, 'CSV', 'CSV', 'STRUCTURE_VALID', 'NOT_SCANNED', 'data-plane-0.1.0', 'REJECTED', 'INCOMPLETE_SCAN', now(), now(), now())`,
        [ids.next(), t.ag.agencyId, up.uploadId, up.revisionId, sha("late-receipt"), up.objectId, sha("claim-" + up.uploadId)],
      ),
    ),
    refusedWith("KA071"),
  );
  // nor can it admit a file: a file is admitted only while its upload is being verified
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.source_files (file_id, agency_id, project_id, origin_revision_id, origin_upload_id, accepted_object_id, provider_generation, sha256, bytes, format, scan_state, parser_profile_hash, inspection_receipt_hash, admitted, admitted_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, '4243', $7, 100, 'CSV', 'COVERED_CLEAN', $8, $9, true, now(), now(), now())`,
        [ids.next(), t.ag.agencyId, up.projectId, up.revisionId, up.uploadId, up.objectId, sha("bytes"), sha("profile"), sha("late-receipt")],
      ),
    ),
    refusedWith("KA071"),
  );
  // a new attempt cannot be claimed once the upload left VERIFYING, and a fence never moves backwards
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET inspection_fence = 2 WHERE upload_id = $1", [up.uploadId])), refusedWith("KA071"));
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET inspection_fence = 0 WHERE upload_id = $1", [up.uploadId])), refusedWith("KA071"));
  // the provider cancellation result is recorded by the control plane and only moves forward
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'UNCERTAIN', provider_cancellation_at = kauro.server_now(), version = 6 WHERE upload_id = $1 AND version = 5", [up.uploadId]);
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 6, agencyId: t.ag.agencyId, eventType: "upload_session.provider_cancellation_recorded.v1", actorUserId: null, payload: { uploadId: up.uploadId, providerCancellationState: "UNCERTAIN" } });
  });
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'NOT_REQUESTED', provider_cancellation_at = NULL, version = 7 WHERE upload_id = $1", [up.uploadId])), refusedWith("KA008"));
  // the quota was released once, by the cancellation; nothing of the upload became a file
  assert.deepEqual(await quotaOf(up.revisionId), { bytes: "0", files: 0 });
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n FROM kauro.source_files WHERE origin_upload_id = $1", [up.uploadId]), { n: 0 });
});

test("D-LOCK-2 (B07-F14): a cancellation and an inspection outcome of the same revision are ordered by the revision row, never upload-first — whichever comes first, the other waits on the revision and then acts on the settled upload; neither deadlocks", async () => {
  const t = await tenant("lock-order");
  // (a) the inspection's admission first holds the revision row (then the upload); CMD015 waits on the revision row, then finds
  // the upload ADMITTED and cancels nothing (the handler answers UPLOAD_ADMITTED; the database refuses the edge, KA008)
  const a = await verifyingUpload(t, 100, "501", 64);
  await hold(control2, { agencyId: t.ag.agencyId });
  try {
    await admitIn(control2, t, a, "501", 64);
    await hold(app, as(t));
    const cancel = (async () => {
      await app.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [a.revisionId]);
      return app.query<{ state: string }>("SELECT state FROM kauro.upload_sessions WHERE upload_id = $1 FOR UPDATE", [a.uploadId]);
    })();
    try {
      await waitForLockWait(su, APP_NAME, "FROM kauro.dataset_revisions");
    } finally {
      await control2.query("COMMIT");
    }
    assert.deepEqual((await cancel).rows, [{ state: "ADMITTED" }], "the cancellation waited and read the settled upload");
    await assert.rejects(cancelUpload(app, t, a.uploadId, 6), refusedWith("KA008"));
    await app.query("ROLLBACK");
  } catch (e) {
    await rollback(control2, app);
    throw e;
  }
  // (b) CMD015 first holds the revision row and cancels; the inspection waits on the revision row, then finds the upload CANCELLED
  // and attaches nothing (KA071): the cancellation won, no deadlock
  const b = await verifyingUpload(t, 100, "601", 64);
  await hold(app, as(t));
  try {
    await app.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [b.revisionId]);
    await cancelUpload(app, t, b.uploadId, 5);
    await hold(control2, { agencyId: t.ag.agencyId });
    const admission = handled(admitIn(control2, t, b, "601", 64));
    try {
      await waitForLockWait(su, CONTROL_NAME, "FROM kauro.dataset_revisions");
    } finally {
      await app.query("COMMIT");
    }
    await assert.rejects(admission, (e: unknown) => ["KA071", "KA008"].includes(code(e) ?? "") || assert.fail(String(e)));
    await control2.query("ROLLBACK");
  } catch (e) {
    await rollback(app, control2);
    throw e;
  }
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.upload_sessions WHERE upload_id = $1", [b.uploadId]), { state: "CANCELLED" });
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n FROM kauro.source_files WHERE origin_upload_id = $1", [b.uploadId]), { n: 0 });
});

test("the quota ledgers cannot be edited around the uploads they summarize (KA070 at commit)", async () => {
  const t = await tenant("ledgers");
  const { projectId, revisionId } = await freshProject(t);
  await tx(app, as(t), (c) => reserveIn(c, t, projectId, revisionId, 1_000));
  await assert.rejects(tx(app, as(t), (c) => c.query("UPDATE kauro.revision_quota SET reserved_bytes = 0 WHERE revision_id = $1", [revisionId])), refusedWith("KA070"));
  await assert.rejects(tx(app, as(t), (c) => c.query("UPDATE kauro.upload_capacity SET active_sessions = 0 WHERE agency_id = $1", [t.ag.agencyId])), refusedWith("KA070"));
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.revision_quota SET file_count = 0 WHERE revision_id = $1", [revisionId])), refusedWith("KA070"));
  assert.deepEqual(await quotaOf(revisionId), { bytes: "1000", files: 1 });
});

test("B07-F10: the ledgers are checked by a write that changed what an upload holds, in one snapshot — a ledger-neutral edge commits even while a ledger disagrees (never a false, nonretryable KA070), a ledger-changing edge is still refused KA070", async () => {
  const t = await tenant("f10");
  const { projectId, revisionId } = await freshProject(t);
  const up = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, projectId, revisionId, 1_000);
    await toUploading(c, t, revisionId, r.uploadId);
    return r;
  });
  await tx(app, as(t), (c) => issueSession(c, t, up.uploadId));
  // the adversary (superuser, triggers off) leaves the revision ledger disagreeing with the uploads it summarizes
  await su.query("BEGIN");
  await su.query("SET LOCAL session_replication_role = replica");
  await su.query("UPDATE kauro.revision_quota SET reserved_bytes = 1007 WHERE revision_id = $1", [revisionId]);
  await su.query("COMMIT");
  // a completion report moves nothing a ledger counts: it commits (the check is not queued for it)
  await tx(app, as(t), (c) => reportCompletion(c, t, up.uploadId));
  // a cancellation releases bytes, a file and a slot: its check runs and names the disagreement
  await assert.rejects(tx(app, as(t), (c) => cancelUpload(c, t, up.uploadId, 4)), refusedWith("KA070"));
  // the check reads the uploads and the ledger in one statement (one snapshot, B07-F10)
  const body = await oracleRow<{ def: string }>("SELECT pg_get_functiondef('kauro.check_upload_ledgers(uuid, uuid)'::regprocedure) AS def");
  assert.equal((body.def.match(/INTO r;/g) ?? []).length, 2, "one statement per ledger");
  // the adversary's ledger restored, the cancellation commits
  await su.query("BEGIN");
  await su.query("SET LOCAL session_replication_role = replica");
  await su.query("UPDATE kauro.revision_quota SET reserved_bytes = 1000 WHERE revision_id = $1", [revisionId]);
  await su.query("COMMIT");
  await tx(app, as(t), (c) => cancelUpload(c, t, up.uploadId, 4));
  assert.deepEqual(await quotaOf(revisionId), { bytes: "0", files: 0 });
});

test("S054 at the database: COVERED_CLEAN requires complete coverage of this object by pinned, fresh signatures — a skipped part or byte, a stale or future signature database, nothing expected, a container shorter than the object, a widened signature age are never clean (B07-F4) — and admission requires every separate result", async () => {
  const t = await tenant("s054");
  const up = await verifyingUpload(t, 100, "42", 100);
  // a column value is a parameter, or a SQL expression the server evaluates in the receipt's own transaction (its clock, the claim)
  interface SqlExpr { readonly sql: string }
  const expr = (sql: string): SqlExpr => ({ sql });
  const isExpr = (v: unknown): v is SqlExpr => typeof v === "object" && v !== null && "sql" in v;
  const now = expr("kauro.server_now()");
  const receipt = (over: Record<string, unknown>) => {
    const r: Record<string, unknown> = {
      receipt_id: ids.next(), agency_id: t.ag.agencyId, upload_id: up.uploadId, revision_id: up.revisionId, receipt_hash: sha("receipt-" + ids.next()), inspection_fence: 1,
      quarantine_object_id: up.objectId, observed_generation: "42", observed_bytes: 100, sha256: sha("bytes"), completion_claim_digest: sha("claim-" + up.uploadId), claim_consistent: true,
      declared_format: "CSV", detected_format: "CSV", structure_status: "STRUCTURE_INVALID", scan_state: "COVERED_CLEAN", scanner_engine: "contract-fake-scanner",
      scanner_engine_version: "SIMULATED-1", signature_version: "SIG-1", signatures_published_at: new Date(Date.now() - HOUR_MS), signature_max_age_seconds: 86400,
      scanner_config_hash: sha("scanner-config"), scanner_exit_code: 0, scanner_verdict: "CLEAN", scanned_at: now, expected_parts: 1, expected_bytes: 100, scanned_parts: 1,
      scanned_bytes: 100, coverage: containerCoverage(up.uploadId, 100), parser_profile_hash: sha("parser-profile"), inspector_version: "data-plane-0.1.0", outcome: "REJECTED", rejection_class: "CORRUPT_STRUCTURE",
      // D-INSP-4: the attempt starts at its claim (stamped by the database with the fence), completes and is recorded now
      started_at: expr(`(SELECT u.inspection_claimed_at FROM kauro.upload_sessions u WHERE u.upload_id = '${up.uploadId}')`), completed_at: now, created_at: now,
      ...over,
    };
    const cols = Object.keys(r);
    const params: unknown[] = [];
    const values = cols.map((k) => {
      const v = r[k];
      if (isExpr(v)) return v.sql;
      params.push(v);
      return `$${params.length}`;
    });
    return controlTx(t.ag.agencyId, (c) => c.query(`INSERT INTO kauro.inspection_receipts (${cols.join(", ")}) VALUES (${values.join(", ")})`, params));
  };
  const notClean = refusedWith("23514", "inspection_receipts_clean_means_covered");
  // the scanner skip (the ClamAV archive case): exit code 0 and a CLEAN verdict, but the part was never read
  await assert.rejects(receipt({ scanned_bytes: 0, scanned_parts: 0 }), notClean);
  // a part read short is not covered either
  await assert.rejects(receipt({ scanned_bytes: 99 }), notClean);
  // stale signatures, and signatures "published" after the scan, cannot produce COVERED_CLEAN
  await assert.rejects(receipt({ signatures_published_at: new Date(Date.now() - 3 * 24 * HOUR_MS) }), notClean);
  await assert.rejects(receipt({ signatures_published_at: new Date(Date.now() + HOUR_MS) }), notClean);
  // nothing expected is not coverage, and an unpinned scanner configuration is not evidence
  await assert.rejects(receipt({ expected_parts: 0, expected_bytes: 0, scanned_parts: 0, scanned_bytes: 0, coverage: "[]" }), notClean);
  await assert.rejects(receipt({ scanner_config_hash: null }), notClean);
  // B07-F4, the critic's receipt: expected 1 part of 1 byte, 1 byte scanned, of a 100-byte object, with six-day-old signatures and
  // a widened maximum age — refused by the pinned age (the column admits only 86,400 s) and, at the pinned age, by coverage
  await assert.rejects(
    receipt({ expected_bytes: 1, scanned_bytes: 1, coverage: containerCoverage(up.uploadId, 1), signatures_published_at: new Date(Date.now() - 6 * DAY_MS), signature_max_age_seconds: 604800 }),
    refusedWith("23514"),
  );
  await assert.rejects(receipt({ signature_max_age_seconds: 604800 }), refusedWith("23514", "inspection_receipts_signature_max_age_seconds_check"));
  await assert.rejects(receipt({ expected_bytes: 1, scanned_bytes: 1, coverage: containerCoverage(up.uploadId, 1) }), notClean);
  // re-check N3 (D-INSP-4, D-CLOCK-1): the scan instant the pinned age is measured at is bounded by the server's instants. The
  // re-checker's receipt — six-day-old signatures, "scanned" an hour after their publication, i.e. before the upload existed — is
  // refused (KA072), although the age CHECK alone would pass it
  const outsideTheAttempt = refusedWith("KA072");
  await assert.rejects(
    receipt({ signatures_published_at: expr("kauro.server_now() - interval '6 days'"), scanned_at: expr("kauro.server_now() - interval '6 days' + interval '1 hour'") }),
    outsideTheAttempt,
  );
  // a scan after the attempt completed, an attempt that did not start at its claim, a completion ahead of the server clock and a
  // receipt recorded at another instant are refused the same way
  await assert.rejects(receipt({ scanned_at: expr("kauro.server_now() + interval '1 hour'") }), outsideTheAttempt);
  await assert.rejects(receipt({ started_at: now }), outsideTheAttempt);
  await assert.rejects(receipt({ scanned_at: expr("kauro.server_now() + interval '1 hour'"), completed_at: expr("kauro.server_now() + interval '1 day'") }), outsideTheAttempt);
  await assert.rejects(receipt({ created_at: expr("kauro.server_now() - interval '1 day'") }), outsideTheAttempt);
  // the claim instant is the database's stamp: the control plane cannot write it, nor move it without claiming a new attempt
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET inspection_claimed_at = kauro.server_now() - interval '6 days' WHERE upload_id = $1", [up.uploadId])), refusedWith("42501"));
  // the counts agree with themselves but no part is the container at the observed length, or the listed parts do not add up
  await assert.rejects(receipt({ coverage: JSON.stringify([{ partDigest: sha("part"), partKind: "WORKSHEET_PART", expectedBytes: 100, scannedBytes: 100, outcome: "CLEAN" }]) }), notClean);
  await assert.rejects(receipt({ expected_parts: 2, scanned_parts: 2, expected_bytes: 150, scanned_bytes: 150 }), notClean);
  await assert.rejects(receipt({ coverage: JSON.stringify([{ partDigest: sha("c"), partKind: "CONTAINER", expectedBytes: "100", scannedBytes: 100, outcome: "CLEAN" }]) }), notClean);
  // a skipped scan is NOT_SCANNED, never "clean with a warning"; a detection is BLOCKED and nothing else is
  await assert.rejects(receipt({ rejection_class: "INCOMPLETE_SCAN" }), refusedWith("23514", "inspection_receipts_incomplete_is_not_scanned"));
  await assert.rejects(receipt({ rejection_class: "DETECTED_MALWARE" }), refusedWith("23514", "inspection_receipts_blocked_is_detection"));
  // admission requires every separate result; each variant lacks exactly one
  const admission = { structure_status: "STRUCTURE_VALID", outcome: "ADMITTED", rejection_class: null, accepted_object_id: up.objectId, accepted_generation: "42", accepted_sha256: sha("bytes") };
  const notAdmissible = refusedWith("23514", "inspection_receipts_admission_complete");
  await assert.rejects(receipt({ ...admission, scan_state: "NOT_SCANNED", scanned_parts: 0, scanned_bytes: 0 }), notAdmissible);
  await assert.rejects(receipt({ ...admission, claim_consistent: false }), notAdmissible);
  await assert.rejects(receipt({ ...admission, detected_format: "XLSX" }), notAdmissible);
  await assert.rejects(receipt({ ...admission, structure_status: "NOT_EVALUATED" }), notAdmissible);
  await assert.rejects(receipt({ ...admission, accepted_sha256: sha("other bytes") }), notAdmissible);
  await assert.rejects(receipt({ ...admission, accepted_sha256: null }), notAdmissible);
  await assert.rejects(receipt({ ...admission, parser_profile_hash: null }), notAdmissible);
  // positive symmetry: the complete row passes every CHECK; only the promoted generation is not registered here (the foreign key)
  await assert.rejects(receipt(admission), refusedWith("23503"));
  // positive neighbour: an incomplete scan recorded as NOT_SCANNED rejects the input
  await receipt({ structure_status: "STRUCTURE_VALID", scan_state: "NOT_SCANNED", scanned_parts: 0, scanned_bytes: 0, rejection_class: "INCOMPLETE_SCAN" });
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n, min(scan_state) AS scan FROM kauro.inspection_receipts WHERE upload_id = $1", [up.uploadId]), { n: 1, scan: "NOT_SCANNED" });
});

test("S053 at the database: a receipt describes exactly the recorded provider observation, and an admitted file names exactly the generation, digest and length its receipt observed and promoted", async () => {
  const t = await tenant("s053");
  const rejected = await verifyingUpload(t, 100, "777", 64);
  // a receipt claiming another generation, or the browser's declared size, than the server observed is refused (KA072)
  const claimMismatch = `INSERT INTO kauro.inspection_receipts (receipt_id, agency_id, upload_id, revision_id, receipt_hash, inspection_fence, quarantine_object_id, observed_generation, observed_bytes,
      completion_claim_digest, claim_consistent, declared_format, detected_format, structure_status, scan_state, inspector_version, outcome, rejection_class, started_at, completed_at, created_at)
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, false, 'CSV', 'NOT_EVALUATED', 'NOT_EVALUATED', 'NOT_SCANNED', 'data-plane-0.1.0', 'REJECTED', 'CLAIM_MISMATCH', ${CLAIMED_AT}, kauro.server_now(), kauro.server_now())`;
  const params = (hash: string, generation: string, bytes: number) => [ids.next(), t.ag.agencyId, rejected.uploadId, rejected.revisionId, hash, rejected.objectId, generation, bytes, sha("claim-" + rejected.uploadId)];
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query(claimMismatch, params(sha("wrong generation"), "778", 64))), refusedWith("KA072"));
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query(claimMismatch, params(sha("declared size"), "777", 100))), refusedWith("KA072"));
  // the observation is set once: a second observation cannot replace it (KA004)
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET observed_generation = '999', version = 5 WHERE upload_id = $1", [rejected.uploadId])), refusedWith("KA004"));
  // the positive neighbour describes what was observed; the upload is REJECTED with it and holds nothing afterwards
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query(claimMismatch, params(sha("observed"), "777", 64));
    await c.query("UPDATE kauro.upload_sessions SET state = 'REJECTED', version = 5, rejected_at = now(), terminal_reason = 'CLAIM_MISMATCH', inspection_receipt_hash = $2 WHERE upload_id = $1 AND version = 4", [rejected.uploadId, sha("observed")]);
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: rejected.uploadId, aggregateVersion: 5, agencyId: t.ag.agencyId, eventType: "upload_session.rejected.v1", actorUserId: null, payload: { uploadId: rejected.uploadId, rejectionClass: "CLAIM_MISMATCH" } });
  });
  assert.deepEqual(await quotaOf(rejected.revisionId), { bytes: "0", files: 0 });

  // an admission: the quarantine generation is verified, promoted to a registered accepted generation, re-read and receipted
  const up = await verifyingUpload(t, 100, "901", 64);
  const acceptedId = ids.next();
  const fileId = ids.next();
  const bytesHash = sha("the observed bytes");
  const receiptHash = sha("admission receipt");
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query("UPDATE kauro.stored_objects SET state = 'PRESENT', generation = '901', bytes = 64, observed_at = now() WHERE object_id = $1", [up.objectId]);
    await c.query("UPDATE kauro.stored_objects SET state = 'VERIFIED', sha256 = $2, verified_at = now() WHERE object_id = $1", [up.objectId, bytesHash]);
    await c.query(
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ACCEPTED', 'RAW', 'contract-fake-storage', 'ACCEPTED_PRIMARY', $6, 'SERVICE', 'upload-inspection', now(), now())`,
      [acceptedId, t.ag.agencyId, up.projectId, up.revisionId, up.uploadId, `accepted/${t.ag.agencyId}/${up.projectId}/${fileId}`],
    );
    await c.query("UPDATE kauro.stored_objects SET state = 'PRESENT', generation = '902', bytes = 64, observed_at = now() WHERE object_id = $1", [acceptedId]);
    await c.query("UPDATE kauro.stored_objects SET state = 'VERIFIED', sha256 = $2, verified_at = now() WHERE object_id = $1", [acceptedId, bytesHash]);
    await c.query(
      `INSERT INTO kauro.inspection_receipts (receipt_id, agency_id, upload_id, revision_id, receipt_hash, inspection_fence, quarantine_object_id, observed_generation, observed_bytes, sha256,
          completion_claim_digest, claim_consistent, declared_format, detected_format, structure_status, scan_state, scanner_engine, scanner_engine_version, signature_version,
          signatures_published_at, signature_max_age_seconds, scanner_config_hash, scanned_at, expected_parts, expected_bytes, scanned_parts, scanned_bytes, coverage, parser_profile_hash,
          inspector_version, outcome, accepted_object_id, accepted_generation, accepted_sha256, started_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, '901', 64, $7, $8, true, 'CSV', 'CSV', 'STRUCTURE_VALID', 'COVERED_CLEAN', 'contract-fake-scanner', 'SIMULATED-1', 'SIG-1',
          now() - interval '1 hour', 86400, $9, now(), 1, 64, 1, 64, $12, $10, 'data-plane-0.1.0', 'ADMITTED', $11, '902', $7, ${CLAIMED_AT}, kauro.server_now(), kauro.server_now())`,
      [ids.next(), t.ag.agencyId, up.uploadId, up.revisionId, receiptHash, up.objectId, bytesHash, sha("claim-" + up.uploadId), sha("scanner-config"), sha("parser-profile"), acceptedId, containerCoverage(up.uploadId, 64)],
    );
  });
  const admitFile = (generation: string, digest: string, bytes: number) =>
    controlTx(t.ag.agencyId, async (c) => {
      await c.query(
        `INSERT INTO kauro.source_files (file_id, agency_id, project_id, origin_revision_id, origin_upload_id, accepted_object_id, provider_generation, sha256, bytes, format, scan_state, parser_profile_hash, inspection_receipt_hash, admitted, admitted_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CSV', 'COVERED_CLEAN', $10, $11, true, now(), now(), now())`,
        [fileId, t.ag.agencyId, up.projectId, up.revisionId, up.uploadId, acceptedId, generation, digest, bytes, sha("parser-profile"), receiptHash],
      );
      await appendFixtureEvent(c, { aggregateKind: "source_file", aggregateId: fileId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "source_file.admitted.v1", actorUserId: null, payload: { fileId } });
      await c.query("UPDATE kauro.upload_sessions SET state = 'ADMITTED', version = 5, admitted_at = now(), file_id = $2, inspection_receipt_hash = $3 WHERE upload_id = $1 AND version = 4", [up.uploadId, fileId, receiptHash]);
      await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 5, agencyId: t.ag.agencyId, eventType: "upload_session.admitted.v1", actorUserId: null, payload: { uploadId: up.uploadId, fileId } });
    });
  // the quarantine generation, a digest the receipt did not promote, and the reserved (declared) size are not what was admitted
  await assert.rejects(admitFile("901", bytesHash, 64), refusedWith("23503"));
  await assert.rejects(admitFile("902", sha("browser-reported digest"), 64), refusedWith("23503"));
  await assert.rejects(admitFile("902", bytesHash, 100), refusedWith("23503"));
  // the positive neighbour: exactly the promoted generation, its re-read digest and the observed length
  await admitFile("902", bytesHash, 64);
  assert.deepEqual(
    await oracleRow("SELECT f.provider_generation, f.bytes::int AS bytes, f.version::int AS version, u.state, u.reserved_bytes::int AS reserved FROM kauro.source_files f JOIN kauro.upload_sessions u ON u.file_id = f.file_id WHERE f.file_id = $1", [fileId]),
    { provider_generation: "902", bytes: 64, version: 1, state: "ADMITTED", reserved: 100 },
  );
  // the admitted upload holds its observed bytes, not its reservation
  assert.deepEqual(await quotaOf(up.revisionId), { bytes: "64", files: 1 });
});

test("B07-F9: an admitted file is an aggregate — its birth and its revocation each commit only with their event of kind source_file, one version per edge, appended by the control plane as a service", async () => {
  const t = await tenant("f9");
  const { projectId } = await freshProject(t);
  const admitted = await admitSourceFile(sessionsOf(t), scopeOf(t, projectId), { seed: "f9" });
  assert.deepEqual(await oracleRow("SELECT version::int AS version, state FROM kauro.source_files WHERE file_id = $1", [admitted.fileId]), { version: 1, state: "ADMITTED" });
  assert.deepEqual(
    await oracleRow("SELECT count(*)::int AS n, min(actor_kind) AS actor FROM kauro.domain_events WHERE aggregate_kind = 'source_file' AND aggregate_id = $1 AND event_type = 'source_file.admitted.v1'", [admitted.fileId]),
    { n: 1, actor: "SERVICE" },
  );
  // the intake window of this file (the fixture initiated it fifteen days ago) has closed and no seal includes it: its revocation
  // is due — without its event it cannot commit (KA003), without a version bump it cannot be written (KA002)
  const revoke = "UPDATE kauro.source_files SET state = 'ADMISSION_REVOKED', admitted = false, revoked_at = kauro.server_now(), revocation_reason = 'INTAKE_EXPIRED', version = version + 1 WHERE file_id = $1";
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query(revoke, [admitted.fileId])), refusedWith("KA003"));
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.source_files SET state = 'ADMISSION_REVOKED', admitted = false, revoked_at = kauro.server_now(), revocation_reason = 'INTAKE_EXPIRED' WHERE file_id = $1", [admitted.fileId])), refusedWith("KA002"));
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query(revoke, [admitted.fileId]);
    await appendFixtureEvent(c, { aggregateKind: "source_file", aggregateId: admitted.fileId, aggregateVersion: 2, agencyId: t.ag.agencyId, eventType: "source_file.admission_revoked.v1", actorUserId: null, payload: { fileId: admitted.fileId, revocationReason: "INTAKE_EXPIRED" } });
  });
  assert.deepEqual(await oracleRow("SELECT version::int AS version, state, revocation_reason FROM kauro.source_files WHERE file_id = $1", [admitted.fileId]), { version: 2, state: "ADMISSION_REVOKED", revocation_reason: "INTAKE_EXPIRED" });
  // a request handler can neither revoke nor record the file's events
  await assert.rejects(tx(app, as(t), (c) => c.query("UPDATE kauro.source_files SET version = version + 1 WHERE file_id = $1", [admitted.fileId])), refusedWith("42501"));
});

test("the provider session secret is readable by its requester only while UPLOADING and unexpired, by the control plane only when bound to the agency, and by nobody else", async () => {
  const t = await tenant("secret");
  const other = await tenant("secret-other");
  const colleague = await person(app, "b07-secret-colleague");
  await member(app, t.ag, colleague, "OPERATOR");
  const { projectId, revisionId } = await freshProject(t);
  const up = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, projectId, revisionId, 10);
    await toUploading(c, t, revisionId, r.uploadId);
    return r;
  });
  const insertSecret = (c: Client, attempt: number) =>
    c.query(
      "INSERT INTO kauro.upload_session_secrets (upload_id, agency_id, requested_by_user_id, session_attempt, key_ref, nonce, ciphertext, created_at) VALUES ($1, $2, $3, $4, 'local-aead:key-1', $5, $6, now())",
      [up.uploadId, t.ag.agencyId, t.ag.ownerUserId, attempt, Buffer.alloc(12, 1), Buffer.alloc(40, 2)],
    );
  await tx(app, as(t), async (c) => {
    await issueSession(c, t, up.uploadId);
    await insertSecret(c, 1);
  });
  const read = (ctx: Context) => tx(app, ctx, (c) => c.query("SELECT upload_id FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId]));
  assert.equal((await read(as(t))).rowCount, 1, "the requester reads it while UPLOADING");
  assert.equal((await read({ agencyId: t.ag.agencyId, userId: colleague.userId })).rowCount, 0, "a member of the same agency does not");
  assert.equal((await read(as(other))).rowCount, 0, "another agency does not");
  // nobody records a secret for someone else's upload
  await assert.rejects(tx(app, { agencyId: t.ag.agencyId, userId: colleague.userId }, (c) => insertSecret(c, 2)), refusedWith("42501"));
  const controlRead = (agencyId: string | null) => controlTx(agencyId, (c) => c.query("SELECT upload_id FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId]));
  assert.equal((await controlRead(null)).rowCount, 0, "the unbound control plane does not");
  assert.equal((await controlRead(other.ag.agencyId)).rowCount, 0, "the control plane bound elsewhere does not");
  assert.equal((await controlRead(t.ag.agencyId)).rowCount, 1, "the control plane bound to the agency does (provider cancellation)");
  // once acceptance is tombstoned the requester can no longer read it; request handlers cannot delete it; the control plane purges it
  await tx(app, as(t), (c) => cancelUpload(c, t, up.uploadId, 3));
  assert.equal((await read(as(t))).rowCount, 0);
  await assert.rejects(tx(app, as(t), (c) => c.query("DELETE FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId])), refusedWith("42501"));
  assert.equal((await controlTx(t.ag.agencyId, (c) => c.query("DELETE FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId]))).rowCount, 1);
});

test("request handlers never enter the control plane's states and never write its evidence: an admission, a rejection, an expiry, READY_TO_SEAL, a revision's or a record's retention expiry is refused to kauro_app", async () => {
  const t = await tenant("role-edges");
  const up = await verifyingUpload(t, 100, "5150", 100);
  // refused by the role boundary (42501) before any other constraint is consulted
  const handlerSets = (sets: string, extra: unknown[] = []) => tx(app, as(t), (c) => c.query(`UPDATE kauro.upload_sessions SET ${sets} WHERE upload_id = $1`, [up.uploadId, ...extra]));
  await assert.rejects(handlerSets("state = 'ADMITTED', version = 5, admitted_at = now(), file_id = $2, inspection_receipt_hash = $3", [ids.next(), sha("forged receipt")]), refusedWith("42501"));
  await assert.rejects(handlerSets("state = 'REJECTED', version = 5, rejected_at = now(), terminal_reason = 'CORRUPT_STRUCTURE', inspection_receipt_hash = $2", [sha("forged receipt")]), refusedWith("42501"));
  await assert.rejects(handlerSets("state = 'EXPIRED', version = 5, expired_at = now() + interval '2 days', terminal_reason = 'RESERVATION_EXPIRED'"), refusedWith("42501"));
  // nor can a handler record, or rewrite, what the provider holds: the observation is the control plane's evidence (D-ROLE-2)
  await assert.rejects(handlerSets("observed_bytes = 1"), refusedWith("42501"));
  await assert.rejects(handlerSets("inspection_fence = inspection_fence + 1"), refusedWith("42501"));
  // READY_TO_SEAL is the control plane's edge: with a bound selection and its complete evaluation (every fact the guard names),
  // the request handler taking it is refused by the role boundary alone
  const readyScope = scopeOf(t, (await freshProject(t)).projectId);
  const bound = await bindSourceSelection(sessionsOf(t), readyScope, await admitSourceFile(sessionsOf(t), readyScope, { seed: "role-edges-ready" }));
  const counted = await sessionsOf(t).control((c) => countSourceSelection(c, readyScope, bound));
  const takeReady = (c: Client) =>
    c.query(
      `UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = version + 1, evaluation_id = $2, evaluation_hash = $3,
              physical_source_rows = $4, logical_source_records = $5, billable_source_units = $6, association_edges = $7 WHERE revision_id = $1`,
      [bound.revisionId, counted.evaluationId, counted.evaluationHash, counted.counts.physicalSourceRows, counted.counts.logicalSourceRecords, counted.counts.billableSourceUnits, counted.counts.associationEdges],
    );
  await assert.rejects(tx(app, as(t), takeReady), refusedWith("42501"));
  // the same statement is the control plane's to take (positive symmetry)
  await controlTx(t.ag.agencyId, async (c) => {
    await takeReady(c);
    await appendFixtureEvent(c, { aggregateKind: "dataset_revision", aggregateId: bound.revisionId, aggregateVersion: bound.revisionVersion + 1, agencyId: t.ag.agencyId, eventType: "dataset_revision.ready_to_seal.v1", actorUserId: null, payload: { revisionId: bound.revisionId } });
  });
  // a sealed revision's retention expiry and its record's expiry are the retention sweeper's
  const sealed = await sealSourceRevision(sessionsOf(t), scopeOf(t, (await freshProject(t)).projectId), { seed: "role-edges-sealed" });
  await assert.rejects(
    tx(app, as(t), (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'EXPIRED', expired_at = now(), terminal_reason = 'RETENTION_DEADLINE', version = version + 1 WHERE revision_id = $1", [sealed.revisionId])),
    refusedWith("42501"),
  );
  await assert.rejects(tx(app, as(t), (c) => c.query("UPDATE kauro.retention_records SET state = 'EXPIRED', expired_at = now(), version = 2 WHERE retention_id = $1", [sealed.retentionId])), refusedWith("42501"));
});

test("the control plane writes only the rows of the agency it is bound to, and appends only the events of the source-lifecycle edges it owns, as a service", async () => {
  const t = await tenant("bound");
  const other = await tenant("bound-other");
  const { projectId, revisionId } = await freshProject(t);
  const up = await tx(app, as(t), (c) => reserveIn(c, t, projectId, revisionId, 10));
  const discover = await controlTx(null, (c) => c.query("SELECT upload_id, state FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]));
  assert.equal(discover.rowCount, 1, "unbound discovery sees the non-text columns");
  await assert.rejects(controlTx(null, (c) => c.query("SELECT display_name FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId])), refusedWith("42501"));
  const touch = (agencyId: string | null) => controlTx(agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET inspection_fence = inspection_fence WHERE upload_id = $1", [up.uploadId]));
  assert.equal((await touch(null)).rowCount, 0, "an unbound control unit of work changes nothing");
  assert.equal((await touch(other.ag.agencyId)).rowCount, 0, "bound to another agency it changes nothing");
  assert.equal((await touch(t.ag.agencyId)).rowCount, 1, "bound to the agency it does");
  await assert.rejects(
    controlTx(other.ag.agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
         VALUES ($1, $2, $3, 'QUARANTINE', 'RESIDUAL', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $4, 'SERVICE', 'sweeper', now(), now())`,
        [ids.next(), t.ag.agencyId, projectId, `quarantine/${t.ag.agencyId}/${projectId}/${ids.next()}`],
      ),
    ),
    refusedWith("42501"),
  );
  // events: bound, as a SERVICE, of a listed type of a B07 aggregate — nothing else (B06 R3 stays whole for every other aggregate)
  const serviceEvent = (agencyId: string | null, eventType: string, actorKind: "SERVICE" | "USER", aggregateKind = "upload_session", aggregateId = up.uploadId) =>
    controlTx(agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10, '1', now())`,
        [ids.next(), aggregateKind, aggregateId, t.ag.agencyId, eventType, actorKind, actorKind === "USER" ? t.ag.ownerUserId : "upload-inspection", ids.next(), ids.next(), sha("{}")],
      ),
    );
  await assert.rejects(serviceEvent(null, "upload_session.admitted.v1", "SERVICE"), refusedWith("42501"), "unbound");
  // bound elsewhere, the aggregate is not visible to the writer: refused exactly like an unknown id (B06 D-EVT-2)
  await assert.rejects(serviceEvent(other.ag.agencyId, "upload_session.admitted.v1", "SERVICE"), refusedWith("KA006"), "bound to another agency");
  await assert.rejects(serviceEvent(t.ag.agencyId, "upload_session.admitted.v1", "USER"), refusedWith("42501"), "as a person");
  await assert.rejects(serviceEvent(t.ag.agencyId, "upload_session.cancelled.v1", "SERVICE"), refusedWith("42501"), "an edge the request handlers own");
  await assert.rejects(serviceEvent(t.ag.agencyId, "dataset_revision.inspecting.v1", "SERVICE", "dataset_revision", revisionId), refusedWith("42501"), "closing the intake is the agency's (B07-F1)");
  await assert.rejects(serviceEvent(t.ag.agencyId, "project.created.v1", "SERVICE", "project", projectId), refusedWith("42501"), "another aggregate");
});

test("revisions accept uploads only while DRAFT or UPLOADING, a project holds one mutable revision, and object names are opaque and scoped to their zone and agency", async () => {
  const t = await tenant("scope");
  const other = await tenant("scope-other");
  const { projectId, revisionId } = await freshProject(t);
  // a second mutable revision of the same project is refused
  await assert.rejects(
    tx(app, as(t), async (c) => {
      const second = ids.next();
      await c.query("INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, created_at, updated_at) VALUES ($1, $2, $3, now(), now())", [second, t.ag.agencyId, projectId]);
      await event(c, { aggregateKind: "dataset_revision", aggregateId: second, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "dataset_revision.created.v1", actorUserId: t.ag.ownerUserId });
    }),
    refusedWith("23505", "dataset_revisions_one_mutable_per_project"),
  );
  // an INSPECTING revision (its intake closed by the agency's selection) accepts no new upload (KA072)
  const bound = await bindSourceSelection(sessionsOf(t), scopeOf(t, projectId), await admitSourceFile(sessionsOf(t), scopeOf(t, projectId), { seed: "inspecting-accepts-none" }));
  assert.equal(bound.revisionId, revisionId);
  await assert.rejects(tx(app, as(t), (c) => reserveIn(c, t, projectId, revisionId, 10)), refusedWith("KA072"));
  // a name carrying a filename, another agency's id, or another zone's prefix is not an object name of this agency and zone
  for (const name of [`quarantine/${t.ag.agencyId}/contacts.csv`, `quarantine/${other.ag.agencyId}/${projectId}/${revisionId}`, `accepted/${t.ag.agencyId}/${projectId}`]) {
    await assert.rejects(
      tx(app, as(t), (c) =>
        c.query(
          `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RAW', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $6, 'MEMBERSHIP', $7, now(), now())`,
          [ids.next(), t.ag.agencyId, projectId, revisionId, ids.next(), name, t.ag.ownerMembershipId],
        ),
      ),
      refusedWith("23514"),
      name,
    );
  }
});

test("a reservation and a revision transition are ordered by the revision row: a cancellation in flight makes a later reservation wait and refuses it; a reservation in flight makes the cancellation wait, which then must tombstone it", async () => {
  const t = await tenant("reserve-order");
  // (a) the cancellation first (CMD012 replacing a mutable revision) holds the revision uncommitted
  const first = await freshProject(t);
  await hold(app2, as(t));
  try {
    await cancelRevision(app2, t, first.revisionId);
    await hold(app, as(t));
    const late = handled(reserveIn(app, t, first.projectId, first.revisionId, 10));
    try {
      await waitForLockWait(su, APP_NAME, "INSERT INTO kauro.upload_sessions");
    } finally {
      await app2.query("COMMIT");
    }
    await assert.rejects(late, refusedWith("KA072"));
    await app.query("ROLLBACK");
  } catch (e) {
    await rollback(app2, app);
    throw e;
  }
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n FROM kauro.upload_sessions WHERE revision_id = $1", [first.revisionId]), { n: 0 });
  // (b) the reservation first: the cancellation waits for it, then reads it — a closed revision with an upload in flight cannot
  // commit (KA072); the cancellation that tombstones the upload in the same unit of work can
  const second = await freshProject(t);
  let reserved: Reserved | undefined;
  await hold(app, as(t));
  try {
    reserved = await reserveIn(app, t, second.projectId, second.revisionId, 10);
    await hold(app2, as(t));
    const cancelling = cancelRevision(app2, t, second.revisionId);
    try {
      await waitForLockWait(su, APP_NAME, "UPDATE kauro.dataset_revisions");
    } finally {
      await app.query("COMMIT");
    }
    await cancelling;
    await assert.rejects(app2.query("COMMIT"), refusedWith("KA072"));
  } catch (e) {
    await rollback(app, app2);
    throw e;
  }
  const upload = reserved;
  assert.ok(upload);
  await tx(app2, as(t), async (c) => {
    await cancelRevision(c, t, second.revisionId);
    await cancelUpload(c, t, upload.uploadId, 2, "REVISION_REPLACED");
  });
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.upload_sessions WHERE upload_id = $1", [upload.uploadId]), { state: "CANCELLED" });
});

/** The control plane's revocation of a file's admission, with its version bump and its event (B07-F9). */
async function revokeIn(c: Client, t: Tenant, fileId: string, reason: string): Promise<void> {
  const r = await c.query<{ version: string }>(
    "UPDATE kauro.source_files SET state = 'ADMISSION_REVOKED', admitted = false, revoked_at = kauro.server_now(), revocation_reason = $2, version = version + 1 WHERE file_id = $1 RETURNING version::text",
    [fileId, reason],
  );
  await appendFixtureEvent(c, { aggregateKind: "source_file", aggregateId: fileId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "source_file.admission_revoked.v1", actorUserId: null, payload: { fileId, revocationReason: reason } });
}

test("a seal and an intake-expiry revocation of its file are ordered by the file's transition lock: a seal in flight commits and the revocation that waited is refused; a revocation in flight commits and the seal that waited is refused", async () => {
  const t = await tenant("seal-order");
  // (a) the seal first holds the file's shared transition lock to COMMIT; the sweeper's revocation waits, then sees the seal
  const p1 = await freshProject(t);
  const ready1 = await readySourceRevision(sessionsOf(t), scopeOf(t, p1.projectId), await admitSourceFile(sessionsOf(t), scopeOf(t, p1.projectId), { seed: "seal-first" }));
  await hold(app, as(t));
  try {
    await sealStatements(app, scopeOf(t, p1.projectId), ready1, new Date(ready1.initiatedAt.getTime() + 600_000));
    await hold(control2, { agencyId: t.ag.agencyId });
    const revocation = handled(revokeIn(control2, t, ready1.fileId, "INTAKE_EXPIRED"));
    try {
      await waitForLockWait(su, CONTROL_NAME, "UPDATE kauro.source_files");
    } finally {
      await app.query("COMMIT");
    }
    await assert.rejects(revocation, refusedWith("KA072"));
    await control2.query("ROLLBACK");
  } catch (e) {
    await rollback(app, control2);
    throw e;
  }
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.source_files WHERE file_id = $1", [ready1.fileId]), { state: "ADMITTED" });
  // (b) the revocation first: the seal's file-set insert waits for it, then reads the file revoked and refuses the seal
  const p2 = await freshProject(t);
  const ready2 = await readySourceRevision(sessionsOf(t), scopeOf(t, p2.projectId), await admitSourceFile(sessionsOf(t), scopeOf(t, p2.projectId), { seed: "revoke-first" }));
  await hold(control2, { agencyId: t.ag.agencyId });
  try {
    await revokeIn(control2, t, ready2.fileId, "INTAKE_EXPIRED");
    await hold(app, as(t));
    const seal = handled(sealStatements(app, scopeOf(t, p2.projectId), ready2, new Date(ready2.initiatedAt.getTime() + 600_000)));
    try {
      await waitForLockWait(su, APP_NAME, "INSERT INTO kauro.sealed_revision_files");
    } finally {
      await control2.query("COMMIT");
    }
    await assert.rejects(seal, refusedWith("KA072"));
    await app.query("ROLLBACK");
  } catch (e) {
    await rollback(control2, app);
    throw e;
  }
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [ready2.revisionId]), { state: "READY_TO_SEAL" });
});

test("entering a lifecycle state without the facts its registry guard names is refused: all_uploads_completed without the agency's selection, READY_TO_SEAL without a complete evaluation, REJECTED without a failed one, a selection against another inventory or uploads in flight, SEALED without its manifest, seal anchor or retention record, a closed revision with an upload in flight", async () => {
  const t = await tenant("guards");
  // all_uploads_completed: a reported completion does not move the revision; no writer takes the edge without the selection (KA072)
  const reported = await freshProject(t);
  const pending = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, reported.projectId, reported.revisionId, 10);
    await toUploading(c, t, reported.revisionId, r.uploadId);
    return r;
  });
  await tx(app, as(t), (c) => issueSession(c, t, pending.uploadId));
  await tx(app, as(t), (c) => reportCompletion(c, t, pending.uploadId));
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', version = version + 1 WHERE revision_id = $1", [reported.revisionId])), refusedWith("KA072"));

  const p = await freshProject(t);
  const scope = scopeOf(t, p.projectId);
  const admitted = await admitSourceFile(sessionsOf(t), scope, { seed: "guards" });
  const file: SelectedFile = { fileId: admitted.fileId, tableId: admitted.tableId, structureHash: admitted.structureHash, origin: "THIS_REVISION" };
  // a selection that does not record the inventory its manifest was made against (D-SEL-3)
  await assert.rejects(tx(app, as(t), (c) => bindFilesIn(c, t, p.projectId, admitted.revisionId, [file], { recordedInventory: sha("another inventory") })), refusedWith("KA072"));
  const bound = await bindSourceSelection(sessionsOf(t), scope, admitted);
  // READY_TO_SEAL without a complete evaluation of the bound selection (the control plane's own edge still needs its facts)
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = version + 1 WHERE revision_id = $1", [bound.revisionId])), refusedWith("KA072"));
  // REJECTED without the failed evaluation of the current selection
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'REJECTED', rejected_at = now(), terminal_reason = 'SELECTED_INPUT_REJECTED', version = version + 1 WHERE revision_id = $1", [bound.revisionId])),
    refusedWith("KA072"),
  );
  const ready = await sessionsOf(t).control(async (c) => {
    const counted = await countSourceSelection(c, scope, bound);
    const r = await c.query<{ version: string }>(
      `UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = version + 1, evaluation_id = $2, evaluation_hash = $3, physical_source_rows = 120, logical_source_records = 120, billable_source_units = 120, association_edges = 0
        WHERE revision_id = $1 RETURNING version::text`,
      [bound.revisionId, counted.evaluationId, counted.evaluationHash],
    );
    await appendFixtureEvent(c, { aggregateKind: "dataset_revision", aggregateId: bound.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.ready_to_seal.v1", actorUserId: null, payload: { revisionId: bound.revisionId } });
    return { ...bound, ...counted, revisionVersion: Number(r.rows[0]!.version) } satisfies ReadySourceFixture;
  });
  // SEALED without its sealed manifest (at COMMIT)
  const sealEdge = async (c: Client, manifestHash: string, projectionHash: string): Promise<void> => {
    const r = await c.query<{ version: string }>(
      "UPDATE kauro.dataset_revisions SET state = 'SEALED', manifest_hash = $2, projection_hash = $3, sealed_at = kauro.server_now(), sealed_file_count = 1, sealed_bytes = $4, version = version + 1 WHERE revision_id = $1 RETURNING version::text",
      [ready.revisionId, manifestHash, projectionHash, ready.bytes],
    );
    await event(c, { aggregateKind: "dataset_revision", aggregateId: ready.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.sealed.v1", actorUserId: t.ag.ownerUserId });
  };
  await assert.rejects(tx(app, as(t), (c) => sealEdge(c, sha("unbacked manifest"), sha("unbacked projection"))), refusedWith("KA072"));
  // SEALED with its manifest and file set but without the seal anchor and the retention record (at COMMIT)
  await assert.rejects(
    tx(app, as(t), async (c) => {
      const documents = sealedManifestOf(scope, ready, ids.next());
      await c.query(
        `INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, subject_hash, canonical_version, manifest, subject, sealed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, kauro.server_now())`,
        [ready.revisionId, t.ag.agencyId, p.projectId, documents.manifestHash, documents.projectionHash, ready.selectionHash, ready.evaluationHash, documents.subjectHash, JSON.stringify(documents.manifest), JSON.stringify(documents.subject)],
      );
      await c.query(
        "INSERT INTO kauro.sealed_revision_files (revision_id, file_id, agency_id, project_id, ordinal, disposition, provider_generation, sha256, bytes) VALUES ($1, $2, $3, $4, 0, 'INCLUDED', $5, $6, $7)",
        [ready.revisionId, ready.fileId, t.ag.agencyId, p.projectId, ready.acceptedGeneration, ready.sha256, ready.bytes],
      );
      await sealEdge(c, documents.manifestHash, documents.projectionHash);
    }),
    refusedWith("KA072"),
  );
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [ready.revisionId]), { state: "READY_TO_SEAL" });

  // a selection bound while an upload is in flight, and a revision closed with an upload in flight
  const r = await freshProject(t);
  const live = await tx(app, as(t), (c) => reserveIn(c, t, r.projectId, r.revisionId, 10));
  await assert.rejects(tx(app, as(t), (c) => bindFilesIn(c, t, r.projectId, r.revisionId, [file])), refusedWith("KA072"));
  await assert.rejects(tx(app, as(t), (c) => cancelRevision(c, t, r.revisionId)), refusedWith("KA072"));
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.upload_sessions WHERE upload_id = $1", [live.uploadId]), { state: "RESERVED" });
});

test("B07-F11: the database compares a selection with the revision's current inventory row by row — a manifest omitting an admitted file of the revision, omitting or mis-hashing a table of an included file, naming a table of no file it names, a file of another origin or a revoked file is refused; no table or column is appended once the file's upload left VERIFYING", async () => {
  const t = await tenant("f11");
  const { projectId, revisionId } = await freshProject(t);
  const u1 = await verifyingUploadIn(t, projectId, revisionId, 100, "111", 64, true);
  const u2 = await verifyingUploadIn(t, projectId, revisionId, 100, "121", 64, false);
  const f1 = await admit(t, u1, "111", 64);
  const f2 = await admit(t, u2, "121", 64);
  const own = (f: AdmittedFile): SelectedFile => ({ fileId: f.fileId, tableId: f.tableId, structureHash: f.structureHash, origin: "THIS_REVISION" });
  const bind = (files: ReadonlyArray<SelectedFile>, tables?: ReadonlyArray<{ fileId: string; tableId: string; structureHash: string }>) =>
    tx(app, as(t), (c) => bindFilesIn(c, t, projectId, revisionId, files, tables === undefined ? {} : { tables }));
  // an admitted file of the revision left out (a missing input invalidates the selection)
  await assert.rejects(bind([own(f1)]), refusedWith("KA072"));
  // a table of an included file left out, or named at another structure (a newly changed table invalidates the selection)
  await assert.rejects(bind([own(f1), own(f2)], [own(f1)]), refusedWith("KA072"));
  await assert.rejects(bind([own(f1), own(f2)], [own(f1), { ...own(f2), structureHash: sha("changed structure") }]), refusedWith("KA072"));
  // a table of no file the manifest names
  await assert.rejects(bind([own(f1), own(f2)], [own(f1), own(f2), { fileId: ids.next(), tableId: ids.next(), structureHash: sha("phantom") }]), refusedWith("KA072"));
  // a file of this revision presented as reused
  await assert.rejects(bind([own(f1), { ...own(f2), origin: "REUSED" }]), refusedWith("KA072"));
  // the inventory of an admitted file is frozen: its upload left VERIFYING, so no table or column can be appended (KA071)
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.source_tables (table_id, agency_id, file_id, ordinal, kind, name_display, name_digest, visibility, column_count, row_estimate, has_formulas, formula_cache, structure_hash, created_at)
         VALUES ($1, $2, $3, 1, 'WORKSHEET', NULL, $4, 'HIDDEN', 1, 1, false, 'NOT_APPLICABLE', $5, now())`,
        [ids.next(), t.ag.agencyId, f1.fileId, sha("late sheet"), sha("late structure")],
      ),
    ),
    refusedWith("KA071"),
  );
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("INSERT INTO kauro.source_table_columns (table_id, ordinal, agency_id, label_display, label_digest, label_state) VALUES ($1, 5, $2, NULL, $3, 'EMPTY')", [f1.tableId, t.ag.agencyId, sha("")])),
    refusedWith("KA071"),
  );
  // a file revoked meanwhile cannot be included (its generation was lost)
  await controlTx(t.ag.agencyId, (c) => revokeIn(c, t, f2.fileId, "GENERATION_MISSING"));
  await assert.rejects(bind([own(f1), own(f2)]), refusedWith("KA072"));
  // positive neighbour: the revoked file excluded is still disposed, the admitted one included with its table — the selection binds
  await tx(app, as(t), async (c) => {
    const manifestId = ids.next();
    const body = {
      schemaVersion: 1, revisionId, inventoryHash: sha("inv"), files: [{ fileId: f1.fileId, origin: "THIS_REVISION", disposition: "INCLUDE" }, { fileId: f2.fileId, origin: "THIS_REVISION", disposition: "EXCLUDE", exclusionReason: "GENERATION_LOST" }],
      tables: [{ tableId: f1.tableId, fileId: f1.fileId, structureHash: f1.structureHash, disposition: "INCLUDE" }], projections: [], associations: [],
    };
    await c.query(
      "INSERT INTO kauro.selection_manifests (selection_manifest_id, agency_id, project_id, revision_id, schema_version, body, body_hash, created_by_membership_id, created_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now())",
      [manifestId, t.ag.agencyId, projectId, revisionId, JSON.stringify(body), sha("body-" + manifestId), t.ag.ownerMembershipId],
    );
    const r = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', selection_manifest_id = $2, selection_hash = $3, inventory_hash = $4, selected_at = kauro.server_now(), version = version + 1 WHERE revision_id = $1 RETURNING version::text", [revisionId, manifestId, sha("body-" + manifestId), sha("inv")]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.selection_changed.v1", actorUserId: t.ag.ownerUserId });
  });
  assert.equal(await stateOf(revisionId), "INSPECTING");
});

test("no CHECK passes on a missing member: a selection manifest without its revision, inventory or file list, a COMPLETE evaluation without its counts, a sealed subject that names no revision and a manifest preimage beyond HASHING's four members are refused", async () => {
  const t = await tenant("null-safety");
  const { projectId, revisionId } = await freshProject(t);
  const manifest = (body: Record<string, unknown>) =>
    tx(app, as(t), (c) =>
      c.query(
        "INSERT INTO kauro.selection_manifests (selection_manifest_id, agency_id, project_id, revision_id, schema_version, body, body_hash, created_by_membership_id, created_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now())",
        [ids.next(), t.ag.agencyId, projectId, revisionId, JSON.stringify(body), sha(JSON.stringify(body)), t.ag.ownerMembershipId],
      ),
    );
  const complete = { schemaVersion: 1, revisionId, inventoryHash: sha("inventory"), files: [] };
  const notBound = refusedWith("23514", "selection_manifests_binds_revision");
  await assert.rejects(manifest({ ...complete, revisionId: undefined }), notBound);
  await assert.rejects(manifest({ ...complete, inventoryHash: undefined }), notBound);
  await assert.rejects(manifest({ ...complete, files: undefined }), notBound);
  await assert.rejects(manifest({ ...complete, schemaVersion: undefined }), notBound);
  await manifest(complete); // positive neighbour
  // a COMPLETE evaluation must carry every count, including the file count and the byte total
  const q = await freshProject(t);
  const admitted = await admitSourceFile(sessionsOf(t), scopeOf(t, q.projectId), { seed: "null-safety" });
  const ready = await readySourceRevision(sessionsOf(t), scopeOf(t, q.projectId), admitted);
  const evaluation = (fileCount: number | null, totalBytes: number | null) =>
    controlTx(t.ag.agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.selection_evaluations (evaluation_id, agency_id, revision_id, selection_manifest_id, selection_hash, evaluation_hash, result, physical_source_rows, logical_source_records, billable_source_units, association_edges,
            file_count, total_bytes, files, tables, projections, pricing_definition, evaluator_version, started_at, completed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETE', 120, 120, 120, 0, $7, $8, $9, '[]', '[]', 'R2-INITIAL', 'data-plane-0.1.0', now(), now(), now())`,
        [ids.next(), t.ag.agencyId, ready.revisionId, ready.selectionManifestId, ready.selectionHash, sha("evaluation-" + ids.next()), fileCount, totalBytes, JSON.stringify([{ fileId: ready.fileId }])],
      ),
    );
  const incomplete = refusedWith("23514", "selection_evaluations_complete");
  await assert.rejects(evaluation(null, ready.bytes), incomplete);
  await assert.rejects(evaluation(1, null), incomplete);
  await evaluation(1, ready.bytes); // positive neighbour (a second evaluation of the same selection is evidence, not a binding)
  // the sealed documents (B07-F12): a subject that names no revision, and a manifest preimage carrying the revision id or the
  // populations HASHING excludes from it, are refused even inside a seal
  const documents = sealedManifestOf(scopeOf(t, q.projectId), ready, ids.next());
  const sealRow = (manifestDoc: unknown, subjectDoc: unknown) =>
    tx(app, as(t), (c) =>
      c.query(
        `INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, subject_hash, canonical_version, manifest, subject, sealed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, now())`,
        [ready.revisionId, t.ag.agencyId, q.projectId, documents.manifestHash, documents.projectionHash, ready.selectionHash, ready.evaluationHash, documents.subjectHash, JSON.stringify(manifestDoc), JSON.stringify(subjectDoc)],
      ),
    );
  await assert.rejects(sealRow(documents.manifest, { ...documents.subject, revisionId: undefined }), refusedWith("23514", "sealed_manifests_names_revision"));
  await assert.rejects(sealRow(documents.manifest, { ...documents.subject, manifestHash: sha("another manifest") }), refusedWith("23514", "sealed_manifests_names_revision"));
  await assert.rejects(sealRow({ ...documents.manifest, revisionId: ready.revisionId }, documents.subject), refusedWith("23514", "sealed_manifests_authority_preimage"));
  await assert.rejects(sealRow({ ...documents.manifest, populations: ready.counts }, documents.subject), refusedWith("23514", "sealed_manifests_authority_preimage"));
});

test("B07-F2: every lifecycle instant is the server's — a reservation dated ahead, an expiry at the deadline value before the deadline, a seal dated back, an anchor ahead and a record or revision expiry dated ahead are refused; nothing is accepted after the deadline; only the labelled test clock of a test cluster stands a fixture in the past", async () => {
  const t = await tenant("f2");
  // concurrency is not the subject here: several uploads of this case stay live at once
  await setSessionLimit(t, 8);
  const { projectId, revisionId } = await freshProject(t);
  // the critic's reservation one year ahead (a deadline 365 days away): refused
  await assert.rejects(
    tx(app, as(t), (c) =>
      c.query(
        `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, display_name, declared_format, reserved_bytes, quarantine_object_id, requested_by_membership_id, requested_by_user_id, application_expires_at, session_attempt, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'ahead.csv', 'CSV', 10, $5, $6, $7, now() + interval '366 days', 1, now() + interval '365 days', now())`,
        [ids.next(), t.ag.agencyId, projectId, revisionId, ids.next(), t.ag.ownerMembershipId, t.ag.ownerUserId],
      ),
    ),
    refusedWith("KA072"),
  );
  // the critic's sweeper: a one-minute-old upload "expired" with expired_at = its deadline value — refused on the server clock
  const young = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, projectId, revisionId, 10);
    await toUploading(c, t, revisionId, r.uploadId);
    return r;
  });
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET state = 'EXPIRED', version = 2, expired_at = application_expires_at, terminal_reason = 'RESERVATION_EXPIRED' WHERE upload_id = $1", [young.uploadId])),
    refusedWith("KA072"),
  );
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET state = 'EXPIRED', version = 2, expired_at = kauro.server_now(), terminal_reason = 'RESERVATION_EXPIRED' WHERE upload_id = $1", [young.uploadId])),
    refusedWith("KA072"),
  );
  // an anchor dated ahead of the transition it records (the critic's 99 days)
  await assert.rejects(
    tx(app, as(t), (c) =>
      c.query("INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, 'INTAKE_CANCELLED', now() + interval '99 days', $6, now())", [ids.next(), t.ag.agencyId, projectId, revisionId, young.uploadId, sha("ahead")]),
    ),
    refusedWith("KA072"),
  );
  // acceptance after the deadline: an upload initiated twenty-five hours ago (test clock) and still UPLOADING takes no completion
  // report now, before any sweeper ran (09 "refusing acceptance after expiry")
  const late = await freshProject(t);
  const stale = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, late.projectId, late.revisionId, 10, { at: new Date(Date.now() - 25 * HOUR_MS) });
    await toUploading(c, t, late.revisionId, r.uploadId);
    return r;
  });
  await tx(app, as(t), (c) => issueSession(c, t, stale.uploadId, new Date(Date.now() - 25 * HOUR_MS + 1_000)));
  await assert.rejects(tx(app, as(t), (c) => reportCompletion(c, t, stale.uploadId)), refusedWith("KA072"));
  // a seal dated back (the fixture's old shortcut: fifteen days in the past through kauro_app) is refused
  const p = await freshProject(t);
  const ready = await readySourceRevision(sessionsOf(t), scopeOf(t, p.projectId), await admitSourceFile(sessionsOf(t), scopeOf(t, p.projectId), { seed: "f2-backdated", base: new Date(Date.now() - HOUR_MS) }));
  await assert.rejects(
    tx(app, as(t), async (c) => {
      const r = await c.query<{ version: string }>(
        "UPDATE kauro.dataset_revisions SET state = 'SEALED', manifest_hash = $2, projection_hash = $3, sealed_at = now() - interval '15 days', sealed_file_count = 1, sealed_bytes = $4, version = version + 1 WHERE revision_id = $1 RETURNING version::text",
        [ready.revisionId, sha("m"), sha("p"), ready.bytes],
      );
      await event(c, { aggregateKind: "dataset_revision", aggregateId: ready.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.sealed.v1", actorUserId: t.ag.ownerUserId });
    }),
    refusedWith("KA072"),
  );
  // sealed now (on the real clock): its record and the revision cannot be expired by an instant the sweeper picks ahead
  const sealed = await tx(app, as(t), (c) => sealStatements(c, scopeOf(t, p.projectId), ready, null));
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.retention_records SET state = 'EXPIRED', expired_at = now() + interval '30 days', version = 2 WHERE retention_id = $1", [sealed.retentionId])), refusedWith("KA072"));
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'EXPIRED', expired_at = now() + interval '30 days', terminal_reason = 'RETENTION_DEADLINE', version = version + 1 WHERE revision_id = $1", [sealed.revisionId])),
    refusedWith("KA072"),
  );
  // negative control: the same writes on the TEST CLOCK — a fixture sealed fifteen days ago, then expired by the sweeper now
  const q = await freshProject(t);
  const old = await sealSourceRevision(sessionsOf(t), scopeOf(t, q.projectId), { seed: "f2-test-clock", state: "EXPIRED" });
  assert.deepEqual(await oracleRow("SELECT state, sealed_at < now() - interval '14 days' AS old FROM kauro.dataset_revisions WHERE revision_id = $1", [old.revisionId]), { state: "EXPIRED", old: true });
  // the clock this cluster runs is the labelled test clock; the shipped body is transaction_timestamp() (migrations.test.ts)
  assert.match((await oracleRow<{ c: string }>("SELECT obj_description('kauro.server_now()'::regprocedure, 'pg_proc') AS c")).c, /^TEST CLOCK/);
});

test("B07-F3: request handlers write no retention evidence they do not own — a far-future record of another class, an UNPAID record not anchored on this transaction's seal, and the control plane's anchors are refused — so the retention sweeper's expiry is never blocked", async () => {
  const t = await tenant("f3");
  const { projectId } = await freshProject(t);
  const sealed = await sealSourceRevision(sessionsOf(t), scopeOf(t, projectId), { seed: "f3" });
  const sealAnchor = await oracleRow<{ anchor_id: string; evidence_hash: string }>("SELECT anchor_id, evidence_hash FROM kauro.retention_anchors WHERE revision_id = $1 AND anchor_kind = 'REVISION_SEALED'", [sealed.revisionId]);
  const clientId = (await oracleRow<{ client_id: string }>("SELECT client_id FROM kauro.projects WHERE project_id = $1", [projectId])).client_id;
  const record = (klass: string, hard: string) =>
    tx(app, as(t), (c) =>
      c.query(
        `INSERT INTO kauro.retention_records (retention_id, agency_id, client_id, project_id, revision_id, class, anchor_id, anchor_evidence_hash, hard_deadline, effective_deadline, policy_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${hard}, ${hard}, 'R2-RETENTION-1', now(), now())`,
        [ids.next(), t.ag.agencyId, clientId, projectId, sealed.revisionId, klass, sealAnchor.anchor_id, sealAnchor.evidence_hash],
      ),
    );
  // the critic's record: LEGAL_FINANCIAL until 2100 on the seal anchor — refused by the role boundary (42501)
  await assert.rejects(record("LEGAL_FINANCIAL", "'2100-01-01T00:00:00Z'::timestamptz"), refusedWith("42501"));
  // an UNPAID record in a later transaction (its seal is not this transaction's), even with the formula's deadline
  const occurred = await oracleRow<{ at: string }>("SELECT occurred_at::text AS at FROM kauro.retention_anchors WHERE anchor_id = $1", [sealAnchor.anchor_id]);
  await assert.rejects(record("UNPAID", `'${occurred.at}'::timestamptz + interval '1209600 seconds'`), refusedWith("42501"));
  // the control plane's anchors (INPUT_ADMITTED, INTAKE_EXPIRED, INTAKE_REJECTED) are not the request handlers' to write — the
  // critic's pre-emption of retention_anchors_once_per_upload
  const up = { uploadId: sealed.uploadId };
  for (const kind of ["INPUT_ADMITTED", "INTAKE_EXPIRED", "INTAKE_REJECTED"]) {
    await assert.rejects(
      tx(app, as(t), (c) => c.query("INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), $7, now())", [ids.next(), t.ag.agencyId, projectId, sealed.revisionId, up.uploadId, kind, sha(kind)])),
      refusedWith("42501"),
      kind,
    );
  }
  // and the request handlers' anchors are not the control plane's
  for (const kind of ["UPLOAD_INITIATED", "INTAKE_CANCELLED", "REVISION_SEALED"]) {
    await assert.rejects(
      controlTx(t.ag.agencyId, (c) => c.query("INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), $7, now())", [ids.next(), t.ag.agencyId, projectId, sealed.revisionId, kind === "REVISION_SEALED" ? null : up.uploadId, kind, sha(kind)])),
      refusedWith("42501"),
      kind,
    );
  }
  // an anchor of the right kind but of no transition of this transaction is refused at COMMIT (bound to its transition)
  const other = await freshProject(t);
  const live = await tx(app, as(t), (c) => reserveIn(c, t, other.projectId, other.revisionId, 10));
  await assert.rejects(
    tx(app, as(t), (c) => c.query("INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, 'INTAKE_CANCELLED', kauro.server_now(), $6, now())", [ids.next(), t.ag.agencyId, other.projectId, other.revisionId, live.uploadId, sha("cancel without a cancellation")])),
    refusedWith("KA072"),
  );
  // nothing blocks the sweeper: the revision's one record is the UNPAID one of its seal, fifteen days old — it expires
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n FROM kauro.retention_records WHERE revision_id = $1", [sealed.revisionId]), { n: 1 });
  await controlTx(t.ag.agencyId, (c) => expireSealedRevision(c, scopeOf(t, projectId), sealed.revisionId));
  assert.equal(await stateOf(sealed.revisionId), "EXPIRED");
});

test("B07-F5: the unpaid hard cap belongs to the bytes — re-sealing reused bytes keeps their first seal's fourteen days, a seal whose bytes' window closed is refused, and neither a superseded revision nor its successor keeps the bytes admitted once their retention ended", async () => {
  const t = await tenant("f5");
  /** CMD012's shape: a successor DRAFT naming the sealed predecessor, the predecessor SUPERSEDED, the project pointer moved. */
  const supersede = (projectId: string, predecessor: string) =>
    tx(app, as(t), async (c) => {
      const successor = ids.next();
      await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [predecessor]);
      await c.query("INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, supersedes_revision_id, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, now(), now())", [successor, t.ag.agencyId, projectId, predecessor, t.ag.ownerMembershipId]);
      await event(c, { aggregateKind: "dataset_revision", aggregateId: successor, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "dataset_revision.created.v1", actorUserId: t.ag.ownerUserId });
      const v = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'SUPERSEDED', superseded_by_revision_id = $2, superseded_at = kauro.server_now(), version = version + 1 WHERE revision_id = $1 RETURNING version::text", [predecessor, successor]);
      await event(c, { aggregateKind: "dataset_revision", aggregateId: predecessor, aggregateVersion: Number(v.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.superseded.v1", actorUserId: t.ag.ownerUserId });
      const pv = await c.query<{ version: string }>("UPDATE kauro.projects SET current_revision_id = $2, version = version + 1 WHERE project_id = $1 RETURNING version::text", [projectId, successor]);
      await event(c, { aggregateKind: "project", aggregateId: projectId, aggregateVersion: Number(pv.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "project.current_revision_changed.v1", actorUserId: t.ag.ownerUserId });
      return successor;
    });
  /** The successor reuses the predecessor's file: selection (previously_admitted_inputs_selected), evaluation, READY_TO_SEAL. */
  const readyReuse = async (projectId: string, successor: string, file: { readonly fileId: string; readonly tableId: string; readonly structureHash: string; readonly acceptedGeneration: string; readonly sha256: string; readonly bytes: number; readonly parserProfileHash: string; readonly receiptHash: string; readonly uploadId: string; readonly initiatedAt: Date }): Promise<ReadySourceFixture> => {
    const selection = fixtureSelection(successor, { fileId: file.fileId, tableId: file.tableId, structureHash: file.structureHash, origin: "REUSED" }, sha("reuse-inventory-" + successor));
    const selectionManifestId = ids.next();
    const selectionHash = sha("reuse-selection-" + successor);
    await tx(app, as(t), async (c) => {
      await c.query(
        "INSERT INTO kauro.selection_manifests (selection_manifest_id, agency_id, project_id, revision_id, schema_version, body, body_hash, created_by_membership_id, created_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now())",
        [selectionManifestId, t.ag.agencyId, projectId, successor, JSON.stringify(selection), selectionHash, t.ag.ownerMembershipId],
      );
      await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [successor]);
      await c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', selection_manifest_id = $2, selection_hash = $3, inventory_hash = $4, selected_at = kauro.server_now(), version = 2 WHERE revision_id = $1 AND version = 1", [successor, selectionManifestId, selectionHash, selection.inventoryHash]);
      await event(c, { aggregateKind: "dataset_revision", aggregateId: successor, aggregateVersion: 2, agencyId: t.ag.agencyId, eventType: "dataset_revision.selection_changed.v1", actorUserId: t.ag.ownerUserId });
    });
    const bound = { ...file, revisionId: successor, clientId: t.clientId, revisionVersion: 2, quarantineObjectId: "", acceptedObjectId: "", selection, selectionManifestId, selectionHash, inventoryHash: selection.inventoryHash };
    const counted = await controlTx(t.ag.agencyId, async (c) => {
      const e = await countSourceSelection(c, scopeOf(t, projectId), bound);
      await c.query(
        `UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = 3, evaluation_id = $2, evaluation_hash = $3, physical_source_rows = 120, logical_source_records = 120, billable_source_units = 120, association_edges = 0 WHERE revision_id = $1 AND version = 2`,
        [successor, e.evaluationId, e.evaluationHash],
      );
      await appendFixtureEvent(c, { aggregateKind: "dataset_revision", aggregateId: successor, aggregateVersion: 3, agencyId: t.ag.agencyId, eventType: "dataset_revision.ready_to_seal.v1", actorUserId: null, payload: { revisionId: successor } });
      return e;
    });
    return { ...bound, ...counted, revisionVersion: 3 };
  };
  /** CMD017 for the successor with its UNPAID record anchored on `anchorId` (the adapter would choose the first seal). */
  const sealWith = (projectId: string, ready: ReadySourceFixture, anchorOf: (c: Client) => Promise<string>) =>
    tx(app, as(t), async (c) => {
      const documents = sealedManifestOf(scopeOf(t, projectId), ready, ids.next());
      await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [ready.revisionId]);
      await c.query(
        `INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, subject_hash, canonical_version, manifest, subject, sealed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, kauro.server_now())`,
        [ready.revisionId, t.ag.agencyId, projectId, documents.manifestHash, documents.projectionHash, ready.selectionHash, ready.evaluationHash, documents.subjectHash, JSON.stringify(documents.manifest), JSON.stringify(documents.subject)],
      );
      await c.query("INSERT INTO kauro.sealed_revision_files (revision_id, file_id, agency_id, project_id, ordinal, disposition, provider_generation, sha256, bytes) VALUES ($1, $2, $3, $4, 0, 'INCLUDED', $5, $6, $7)", [ready.revisionId, ready.fileId, t.ag.agencyId, projectId, ready.acceptedGeneration, ready.sha256, ready.bytes]);
      await c.query("INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, 'REVISION_SEALED', kauro.server_now(), $5, now())", [ids.next(), t.ag.agencyId, projectId, ready.revisionId, sha("seal-" + ready.revisionId)]);
      const anchorId = await anchorOf(c);
      const retentionId = ids.next();
      await c.query(
        `INSERT INTO kauro.retention_records (retention_id, agency_id, client_id, project_id, revision_id, class, anchor_id, anchor_evidence_hash, hard_deadline, effective_deadline, policy_version, created_at, updated_at)
         SELECT $1, $2, $3, $4, $5, 'UNPAID', a.anchor_id, a.evidence_hash, a.occurred_at + interval '1209600 seconds', a.occurred_at + interval '1209600 seconds', 'R2-RETENTION-1', now(), now() FROM kauro.retention_anchors a WHERE a.anchor_id = $6`,
        [retentionId, t.ag.agencyId, t.clientId, projectId, ready.revisionId, anchorId],
      );
      await event(c, { aggregateKind: "retention_record", aggregateId: retentionId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "retention_record.created.v1", actorUserId: t.ag.ownerUserId });
      const r = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'SEALED', manifest_hash = $2, projection_hash = $3, sealed_at = kauro.server_now(), sealed_file_count = 1, sealed_bytes = $4, version = version + 1 WHERE revision_id = $1 RETURNING version::text", [ready.revisionId, documents.manifestHash, documents.projectionHash, ready.bytes]);
      await event(c, { aggregateKind: "dataset_revision", aggregateId: ready.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.sealed.v1", actorUserId: t.ag.ownerUserId });
      return retentionId;
    });
  const firstAnchorOf = (revisionId: string) => async (c: Client) => (await c.query<{ anchor_id: string }>("SELECT anchor_id FROM kauro.retention_anchors WHERE revision_id = $1 AND anchor_kind = 'REVISION_SEALED'", [revisionId])).rows[0]!.anchor_id;

  // R1 sealed ten days ago (test clock): its file F is reused by the successor R2, sealed now
  const p = await freshProject(t);
  const admitted1 = await admitSourceFile(sessionsOf(t), scopeOf(t, p.projectId), { seed: "f5-first", base: new Date(Date.now() - 10 * DAY_MS) });
  const r1 = await sealReadyRevision(sessionsOf(t), scopeOf(t, p.projectId), await readySourceRevision(sessionsOf(t), scopeOf(t, p.projectId), admitted1));
  const r2 = await supersede(p.projectId, r1.revisionId);
  const ready2 = await readyReuse(p.projectId, r2, admitted1);
  // a re-seal that starts a new fourteen days (anchored on its own seal) is refused at COMMIT: the cap belongs to the bytes
  await assert.rejects(sealWith(p.projectId, ready2, firstAnchorOf(r2)), refusedWith("KA072"));
  // anchored on the bytes' first seal (R1's), with R1's hard deadline, the seal commits
  const record2 = await sealWith(p.projectId, ready2, firstAnchorOf(r1.revisionId));
  assert.deepEqual(
    await oracleRow(
      "SELECT r2.hard_deadline = r1.hard_deadline AS same_cap, r2.hard_deadline < now() + interval '5 days' AS within_first FROM kauro.retention_records r2, kauro.retention_records r1 WHERE r2.retention_id = $1 AND r1.retention_id = $2",
      [record2, r1.retentionId],
    ),
    { same_cap: true, within_first: true },
  );
  // while the bytes' retention runs, their admission cannot be revoked for retention, nor for an intake window (they were sealed)
  await assert.rejects(controlTx(t.ag.agencyId, (c) => revokeIn(c, t, admitted1.fileId, "RETENTION_EXPIRED")), refusedWith("KA072"));
  await assert.rejects(controlTx(t.ag.agencyId, (c) => revokeIn(c, t, admitted1.fileId, "INTAKE_EXPIRED")), refusedWith("KA072"));

  // Q sealed fifteen days ago (test clock): the successor that reuses its bytes cannot seal — their window closed
  const q = await freshProject(t);
  const admittedQ = await admitSourceFile(sessionsOf(t), scopeOf(t, q.projectId), { seed: "f5-old" });
  const q1 = await sealReadyRevision(sessionsOf(t), scopeOf(t, q.projectId), await readySourceRevision(sessionsOf(t), scopeOf(t, q.projectId), admittedQ));
  const q2 = await supersede(q.projectId, q1.revisionId);
  const readyQ2 = await readyReuse(q.projectId, q2, admittedQ);
  await assert.rejects(sealWith(q.projectId, readyQ2, firstAnchorOf(q1.revisionId)), refusedWith("KA072"));
  // the superseded predecessor never expires itself (no edge), yet it does not keep the bytes admitted: once its record's
  // deadline passed, the retention sweeper revokes the file (RETENTION_EXPIRED), and nothing can include it again
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query("UPDATE kauro.retention_records SET state = 'EXPIRED', expired_at = kauro.server_now(), version = 2 WHERE retention_id = $1", [q1.retentionId]);
    await appendFixtureEvent(c, { aggregateKind: "retention_record", aggregateId: q1.retentionId, aggregateVersion: 2, agencyId: t.ag.agencyId, eventType: "retention_record.expired.v1", actorUserId: null, payload: { retentionId: q1.retentionId } });
    await revokeIn(c, t, admittedQ.fileId, "RETENTION_EXPIRED");
  });
  assert.deepEqual(await oracleRow("SELECT state, revocation_reason FROM kauro.source_files WHERE file_id = $1", [admittedQ.fileId]), { state: "ADMISSION_REVOKED", revocation_reason: "RETENTION_EXPIRED" });
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [q1.revisionId]), { state: "SUPERSEDED" });
});

test("retention anchors survive failure: a reservation commits with its initiation anchor or not at all, each anchor is written once per subject, the hard cap never moves, and neither an upload, a record nor its revision expires before the governing deadline", async () => {
  const t = await tenant("retention");
  const p = await freshProject(t);
  // a reservation without its anchor cannot commit (KA072 at COMMIT), and nothing of it remains
  await assert.rejects(tx(app, as(t), (c) => reserveIn(c, t, p.projectId, p.revisionId, 10, { anchored: false })), refusedWith("KA072"));
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n FROM kauro.upload_sessions WHERE revision_id = $1", [p.revisionId]), { n: 0 });
  // an anchor is written once per subject: a retry or a replay cannot produce a later one
  const up = await tx(app, as(t), (c) => reserveIn(c, t, p.projectId, p.revisionId, 10));
  await assert.rejects(
    tx(app, as(t), (c) =>
      c.query(
        "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, 'UPLOAD_INITIATED', kauro.server_now(), $6, now())",
        [ids.next(), t.ag.agencyId, p.projectId, p.revisionId, up.uploadId, sha("retry anchor")],
      ),
    ),
    refusedWith("23505", "retention_anchors_once_per_upload"),
  );
  // the sweeper cannot pre-empt the reservation window: the upload expires no earlier than twenty-four hours after initiation
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET state = 'EXPIRED', version = 2, expired_at = now(), terminal_reason = 'RESERVATION_EXPIRED' WHERE upload_id = $1", [up.uploadId])),
    refusedWith("KA072"),
  );
  // a revision sealed an hour ago: its UNPAID record's hard cap lies fourteen days ahead
  const q = await freshProject(t);
  const sealed = await sealSourceRevision(sessionsOf(t), scopeOf(t, q.projectId), { seed: "fresh-seal", base: new Date(Date.now() - HOUR_MS) });
  // the hard cap never moves: request handlers cannot write a record at all, and even the owner of the table is refused by the trigger
  const extend = "UPDATE kauro.retention_records SET hard_deadline = hard_deadline + interval '1 day', effective_deadline = effective_deadline + interval '1 day', version = 2 WHERE retention_id = $1";
  await assert.rejects(tx(app, as(t), (c) => c.query(extend, [sealed.retentionId])), refusedWith("42501"));
  await assert.rejects(su.query(extend, [sealed.retentionId]), refusedWith("KA004"));
  // the sweeper can expire neither the record nor the revision before the effective deadline
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.retention_records SET state = 'EXPIRED', expired_at = now(), version = 2 WHERE retention_id = $1", [sealed.retentionId])),
    refusedWith("23514", "retention_records_expiry_not_early"),
  );
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'EXPIRED', expired_at = now(), terminal_reason = 'RETENTION_DEADLINE', version = version + 1 WHERE revision_id = $1", [sealed.revisionId])),
    refusedWith("KA072"),
  );
  // positive neighbour: a revision sealed fifteen days ago (test clock) expires, its record first (the fixture's retention sweeper)
  const r = await freshProject(t);
  const expired = await sealSourceRevision(sessionsOf(t), scopeOf(t, r.projectId), { seed: "old-seal", state: "EXPIRED" });
  assert.deepEqual(
    await oracleRow("SELECT r.state, rr.state AS record FROM kauro.dataset_revisions r JOIN kauro.retention_records rr ON rr.revision_id = r.revision_id WHERE r.revision_id = $1", [expired.revisionId]),
    { state: "EXPIRED", record: "EXPIRED" },
  );
});

test("lineage: a successor names a predecessor of its own project, a predecessor is superseded only by the successor that names it, and it is replaced at most once", async () => {
  const t = await tenant("lineage");
  const p = await freshProject(t);
  const predecessor = await sealSourceRevision(sessionsOf(t), scopeOf(t, p.projectId), { seed: "lineage" });
  const q = await freshProject(t);
  const unrelated = await sealSourceRevision(sessionsOf(t), scopeOf(t, q.projectId), { seed: "lineage-unrelated" });
  const insertSuccessor = async (c: Client, projectId: string, supersedes: string): Promise<string> => {
    const id = ids.next();
    await c.query(
      "INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, supersedes_revision_id, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, now(), now())",
      [id, t.ag.agencyId, projectId, supersedes, t.ag.ownerMembershipId],
    );
    await event(c, { aggregateKind: "dataset_revision", aggregateId: id, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "dataset_revision.created.v1", actorUserId: t.ag.ownerUserId });
    return id;
  };
  const supersede = async (c: Client, successor: string): Promise<void> => {
    const v = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'SUPERSEDED', superseded_by_revision_id = $2, superseded_at = kauro.server_now(), version = version + 1 WHERE revision_id = $1 RETURNING version::text", [predecessor.revisionId, successor]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: predecessor.revisionId, aggregateVersion: Number(v.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.superseded.v1", actorUserId: t.ag.ownerUserId });
  };
  // a predecessor of another project is refused
  await assert.rejects(tx(app, as(t), (c) => insertSuccessor(c, q.projectId, predecessor.revisionId)), refusedWith("23503", "dataset_revisions_lineage_in_project"));
  // a predecessor superseded by a revision that does not name it is refused at COMMIT
  await assert.rejects(tx(app, as(t), (c) => supersede(c, unrelated.revisionId)), refusedWith("23503", "dataset_revisions_successor_fk"));
  // CMD012's shape: the successor names the predecessor, the predecessor names the successor, the project moves its pointer
  const successor = await tx(app, as(t), async (c) => {
    const id = await insertSuccessor(c, p.projectId, predecessor.revisionId);
    await supersede(c, id);
    const pv = await c.query<{ version: string }>("UPDATE kauro.projects SET current_revision_id = $2, version = version + 1 WHERE project_id = $1 RETURNING version::text", [p.projectId, id]);
    await event(c, { aggregateKind: "project", aggregateId: p.projectId, aggregateVersion: Number(pv.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "project.current_revision_changed.v1", actorUserId: t.ag.ownerUserId });
    return id;
  });
  assert.deepEqual(await oracleRow("SELECT state, superseded_by_revision_id AS by FROM kauro.dataset_revisions WHERE revision_id = $1", [predecessor.revisionId]), { state: "SUPERSEDED", by: successor });
  // the project's current revision is one of its own revisions (deferred FK)
  await assert.rejects(
    tx(app, as(t), async (c) => {
      const pv = await c.query<{ version: string }>("UPDATE kauro.projects SET current_revision_id = $2, version = version + 1 WHERE project_id = $1 RETURNING version::text", [p.projectId, unrelated.revisionId]);
      await event(c, { aggregateKind: "project", aggregateId: p.projectId, aggregateVersion: Number(pv.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "project.current_revision_changed.v1", actorUserId: t.ag.ownerUserId });
    }),
    refusedWith("23503", "projects_current_revision_in_project_fk"),
  );
  // a predecessor is replaced once: once its successor is cancelled, a second successor naming it is refused
  await tx(app, as(t), (c) => cancelRevision(c, t, successor, "ABANDONED"));
  await assert.rejects(tx(app, as(t), (c) => insertSuccessor(c, p.projectId, predecessor.revisionId)), refusedWith("23505", "dataset_revisions_supersedes_once"));
});

test("R2-051 at the database: after the application deadline the session is tombstoned; a late object is registered as a quarantined residual and deleted under its generation; the deletion records the provider residual the location read-back implies; nothing of it is ever admitted", async () => {
  const t = await tenant("r2-051");
  const { projectId, revisionId } = await freshProject(t);
  // initiated twenty-five hours ago on the test clock: the application deadline passed an hour ago while the provider session stays
  // usable (issued a second after the reservation)
  const initiated = new Date(Date.now() - 25 * HOUR_MS);
  const up = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, projectId, revisionId, 100, { at: initiated });
    await toUploading(c, t, revisionId, r.uploadId);
    return r;
  });
  await tx(app, as(t), (c) => issueSession(c, t, up.uploadId, new Date(initiated.getTime() + 1_000)));
  // the sweeper tombstones acceptance, requests the provider cancellation and anchors the expired intake, on the server clock
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query(
      "UPDATE kauro.upload_sessions SET state = 'EXPIRED', version = 3, expired_at = kauro.server_now(), terminal_reason = 'RESERVATION_EXPIRED', provider_cancellation_state = 'REQUESTED', provider_cancellation_at = kauro.server_now() WHERE upload_id = $1 AND version = 2",
      [up.uploadId],
    );
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 3, agencyId: t.ag.agencyId, eventType: "upload_session.expired.v1", actorUserId: null, payload: { uploadId: up.uploadId, previousState: "UPLOADING", reasonCode: "RESERVATION_EXPIRED" } });
    await c.query(
      "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, 'INTAKE_EXPIRED', kauro.server_now(), $6, now())",
      [ids.next(), t.ag.agencyId, projectId, revisionId, up.uploadId, sha("expired " + up.uploadId)],
    );
  });
  // the requester's late completion report finds the upload tombstoned: no claim is recorded on it (KA004) and no edge leads out
  // of EXPIRED (KA008)
  await assert.rejects(
    tx(app, as(t), (c) => c.query("UPDATE kauro.upload_sessions SET state = 'VERIFYING', version = 4, completion_reported_at = now(), completion_claim_digest = $2 WHERE upload_id = $1", [up.uploadId, sha("late claim")])),
    refusedWith("KA004"),
  );
  await assert.rejects(tx(app, as(t), (c) => c.query("UPDATE kauro.upload_sessions SET state = 'VERIFYING', version = 4 WHERE upload_id = $1", [up.uploadId])), refusedWith("KA008"));
  // a late completion landed through the still-usable session: the storage lifecycle observes it on the registered intent, marks it
  // late and residual, and requests its deletion
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query("UPDATE kauro.stored_objects SET state = 'PRESENT', generation = '8080', bytes = 100, observed_at = now(), late = true, data_class = 'RESIDUAL' WHERE object_id = $1", [up.objectId]);
    await c.query("UPDATE kauro.stored_objects SET state = 'DELETION_REQUESTED', deletion_requested_at = now(), deletion_reason = 'LATE_OBJECT' WHERE object_id = $1", [up.objectId]);
  });
  const recordDeletion = (result: string | null, residual: string, basis: string | null = "LOCATION_POLICY", deletedAt = "kauro.server_now()") =>
    controlTx(t.ag.agencyId, (c) =>
      c.query(
        `UPDATE kauro.stored_objects SET state = 'DELETED', deleted_at = ${deletedAt}, deletion_result = $2, deletion_attempts = 1, provider_residual_until = ${residual}, provider_residual_basis = $3 WHERE object_id = $1`,
        [up.objectId, result, basis],
      ),
    );
  const sevenDays = "kauro.server_now() + interval '604800 seconds'";
  // no deletion is recorded for a location whose effective retention setting was never read back (D-OBJ-2)
  await assert.rejects(recordDeletion("DELETED", "NULL"), refusedWith("KA072"));
  const readBack = (observedAt: string, retentionSeconds: number) =>
    controlTx(t.ag.agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.storage_location_policies (observation_id, provider, location_ref, soft_delete_retention_seconds, object_versioning, evidence_hash, evidence_class, observed_at) VALUES ($1, 'contract-fake-storage', 'QUARANTINE_PRIMARY', $2, false, $3, 'SIMULATED', ${observedAt})`,
        [ids.next(), retentionSeconds, sha("contract fake retention read-back " + observedAt)],
      ),
    );
  // re-check N3 (D-CLOCK-1): a read-back is recorded at the server's instant — one dated back (here a zero retention "observed"
  // yesterday) would govern the deletion residual of every deletion since
  await assert.rejects(readBack("kauro.server_now() - interval '1 day'", 0), refusedWith("KA072"));
  await readBack("kauro.server_now()", 604800);
  // the read-back says the provider keeps a deleted generation seven days: "vanished" and any other residual are refused
  await assert.rejects(recordDeletion("DELETED", "NULL"), refusedWith("KA072"));
  await assert.rejects(recordDeletion("DELETED", "kauro.server_now() + interval '1 day'"), refusedWith("KA072"));
  // a deletion dated back (a shorter residual) is refused on the server clock (D-CLOCK-1)
  await assert.rejects(recordDeletion("DELETED", "now() - interval '1 day' + interval '604800 seconds'", "LOCATION_POLICY", "now() - interval '1 day'"), refusedWith("KA072"));
  // a deletion is recorded only with the provider's result; a failure is not a deletion
  await assert.rejects(recordDeletion(null, sevenDays), refusedWith("23514", "stored_objects_deleted_result"));
  await assert.rejects(recordDeletion("PROVIDER_ERROR", sevenDays), refusedWith("23514", "stored_objects_deleted_result"));
  // the residual names its basis; a provider-reported expiry is a provider fact and still needs the verified location setting
  await assert.rejects(recordDeletion("DELETED", sevenDays, null), refusedWith("23514", "stored_objects_residual_basis"));
  await assert.rejects(recordDeletion("DELETED", "NULL", "PROVIDER_REPORTED"), refusedWith("KA072"));
  await recordDeletion("DELETED", sevenDays);
  // the late object never comes back as raw input, and its row remains as absence evidence
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.stored_objects SET late = false WHERE object_id = $1", [up.objectId])), refusedWith("KA004"));
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.stored_objects SET state = 'PRESENT' WHERE object_id = $1", [up.objectId])), refusedWith("KA008"));
  assert.deepEqual(
    await oracleRow(
      "SELECT state, late, data_class, deletion_result, generation, provider_residual_until = deleted_at + interval '604800 seconds' AS residual FROM kauro.stored_objects WHERE object_id = $1",
      [up.objectId],
    ),
    { state: "DELETED", late: true, data_class: "RESIDUAL", deletion_result: "DELETED", generation: "8080", residual: true },
  );
  // a second late generation at the same name is registered as a residual of its own; a generation is never registered twice
  const lateObject = (c: Client) =>
    c.query(
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, late, created_by_kind, created_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RESIDUAL', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $6, true, 'SERVICE', 'storage-lifecycle', now(), now()) RETURNING object_id`,
      [ids.next(), t.ag.agencyId, projectId, revisionId, up.uploadId, `quarantine/${t.ag.agencyId}/${projectId}/${revisionId}/${up.uploadId}`],
    );
  const observe = (c: Client, objectId: string) => c.query("UPDATE kauro.stored_objects SET state = 'PRESENT', generation = '8081', bytes = 100, observed_at = now() WHERE object_id = $1", [objectId]);
  await controlTx(t.ag.agencyId, async (c) => {
    const r = await lateObject(c);
    await observe(c, String(r.rows[0]!.object_id));
  });
  await assert.rejects(
    controlTx(t.ag.agencyId, async (c) => {
      const r = await lateObject(c);
      await observe(c, String(r.rows[0]!.object_id));
    }),
    refusedWith("23505", "stored_objects_provider_generation"),
  );
  // request handlers cannot register a residual at all
  await assert.rejects(
    tx(app, as(t), (c) =>
      c.query(
        `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, late, created_by_kind, created_by_ref, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RESIDUAL', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $6, true, 'MEMBERSHIP', $7, now(), now())`,
        [ids.next(), t.ag.agencyId, projectId, revisionId, up.uploadId, `quarantine/${t.ag.agencyId}/${projectId}/${revisionId}/${ids.next()}`, t.ag.ownerMembershipId],
      ),
    ),
    refusedWith("42501"),
  );
  // nothing of the expired upload was admitted, and its quota was released once
  assert.deepEqual(await quotaOf(revisionId), { bytes: "0", files: 0 });
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n FROM kauro.source_files WHERE origin_upload_id = $1", [up.uploadId]), { n: 0 });
});

// --- the second re-check's residuals (design §18, N1..N4 at the database) -------------------------------------------------------

/** A sealed manifest (its CHECKs satisfied: HASHING's four members, a subject naming the revision and the row's hashes) sealed at `sealedAt`. */
async function forgedSealedManifest(c: Client, t: Tenant, projectId: string, revisionId: string, sealedAt: string): Promise<void> {
  const hashes = { manifestHash: sha("forged-manifest-" + revisionId + sealedAt), projectionHash: sha("forged-projection"), selectionHash: sha("forged-selection"), evaluationHash: sha("forged-evaluation") };
  await c.query(
    `INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, subject_hash, canonical_version, manifest, subject, sealed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, ${sealedAt})`,
    [
      revisionId, t.ag.agencyId, projectId, hashes.manifestHash, hashes.projectionHash, hashes.selectionHash, hashes.evaluationHash, sha("forged-subject-" + revisionId + sealedAt),
      JSON.stringify({ files: [], tableSelection: [], parserProfile: [], projection: {} }), JSON.stringify({ revisionId, canonicalVersion: 1, ...hashes }),
    ],
  );
}

/** An INCLUDED sealed file row naming a file at its exact admitted generation, digest and length. */
async function sealedFileRow(c: Client, t: Tenant, projectId: string, revisionId: string, fileId: string, ordinal: number): Promise<void> {
  await c.query(
    `INSERT INTO kauro.sealed_revision_files (revision_id, file_id, agency_id, project_id, ordinal, disposition, provider_generation, sha256, bytes)
     SELECT $1, f.file_id, f.agency_id, f.project_id, $4, 'INCLUDED', f.provider_generation, f.sha256, f.bytes FROM kauro.source_files f WHERE f.agency_id = $2 AND f.project_id = $3 AND f.file_id = $5`,
    [revisionId, t.ag.agencyId, projectId, ordinal, fileId],
  );
}

test("N1: sealed manifests and sealed file rows are the record of the seal that writes them — a file row added later to a sealed revision, a manifest dated back and a manifest or file row of a revision that is not sealing are refused, so no request handler keeps bytes admitted past their window or moves their first seal", async () => {
  const t = await tenant("n1");
  const p = await freshProject(t);
  const scope = scopeOf(t, p.projectId);
  // (a) R1 sealed fifteen days ago and expired by the retention sweeper (its record's deadline passed); R2, a younger revision of the
  // same project, genuinely sealed an hour ago
  const r1 = await sealSourceRevision(sessionsOf(t), scope, { seed: "n1-old", state: "EXPIRED" });
  const r2 = await sealSourceRevision(sessionsOf(t), scope, { seed: "n1-young", base: new Date(Date.now() - HOUR_MS) });
  // the re-checker's probe: in a later transaction a request handler adds an INCLUDED row naming R1's old file to R2 — refused at
  // COMMIT (R2's seal is not this transaction's), so the row cannot count R2's ACTIVE record against the old bytes
  await assert.rejects(tx(app, as(t), (c) => sealedFileRow(c, t, p.projectId, r2.revisionId, r1.fileId, 1)), refusedWith("KA072"));
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n FROM kauro.sealed_revision_files WHERE file_id = $1", [r1.fileId]), { n: 1 });
  // the old bytes' retention ended: the retention sweeper's RETENTION_EXPIRED revocation commits
  await controlTx(t.ag.agencyId, (c) => revokeIn(c, t, r1.fileId, "RETENTION_EXPIRED"));
  assert.deepEqual(await oracleRow("SELECT state, revocation_reason FROM kauro.source_files WHERE file_id = $1", [r1.fileId]), { state: "ADMISSION_REVOKED", revocation_reason: "RETENTION_EXPIRED" });
  // R2's own bytes keep their first seal (the hard cap of its UNPAID record is its seal + fourteen days)
  assert.deepEqual(
    await oracleRow("SELECT rr.hard_deadline = r.sealed_at + interval '1209600 seconds' AS own_cap FROM kauro.retention_records rr JOIN kauro.dataset_revisions r ON r.revision_id = rr.revision_id WHERE rr.retention_id = $1", [r2.retentionId]),
    { own_cap: true },
  );

  // (b) R3 still UPLOADING with an admitted file whose intake window closed fourteen days ago (the fixture initiated it fifteen days ago)
  const r3 = await admitSourceFile(sessionsOf(t), scope, { seed: "n1-uploading" });
  // the re-checker's second probe: a sealed manifest dated 2000-01-01 and an INCLUDED row for the UPLOADING revision — refused at
  // the manifest (the seal instant is the server's) ...
  await assert.rejects(
    tx(app, as(t), async (c) => {
      await forgedSealedManifest(c, t, p.projectId, r3.revisionId, "'2000-01-01T00:00:00Z'::timestamptz");
      await sealedFileRow(c, t, p.projectId, r3.revisionId, r3.fileId, 0);
    }),
    refusedWith("KA072"),
  );
  // ... and, at the server's instant, refused at COMMIT: the revision took no seal in this transaction
  await assert.rejects(
    tx(app, as(t), async (c) => {
      await forgedSealedManifest(c, t, p.projectId, r3.revisionId, "kauro.server_now()");
      await sealedFileRow(c, t, p.projectId, r3.revisionId, r3.fileId, 0);
    }),
    refusedWith("KA072"),
  );
  // nor can a request handler record a seal instant (or any seal fact) on a revision outside seal_command
  await assert.rejects(
    tx(app, as(t), async (c) => {
      const r = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET sealed_at = kauro.server_now(), version = version + 1 WHERE revision_id = $1 RETURNING version::text", [r3.revisionId]);
      await event(c, { aggregateKind: "dataset_revision", aggregateId: r3.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.selection_changed.v1", actorUserId: t.ag.ownerUserId });
    }),
    refusedWith("KA072"),
  );
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n FROM kauro.sealed_manifests WHERE revision_id = $1", [r3.revisionId]), { n: 0 });
  // the readers' half: rows that bypassed the write-side binding (the superuser as the adversary, triggers and foreign keys off) are
  // still no seal — the revocation guard and the first seal of the bytes count only a revision that went through SEALED at its
  // manifest's instant (kauro.is_real_seal)
  await su.query("BEGIN");
  try {
    await su.query("SET LOCAL session_replication_role = replica");
    await forgedSealedManifest(su, t, p.projectId, r3.revisionId, "'2000-01-01T00:00:00Z'::timestamptz");
    await sealedFileRow(su, t, p.projectId, r3.revisionId, r3.fileId, 0);
    await su.query("COMMIT");
  } catch (e) {
    await su.query("ROLLBACK");
    throw e;
  }
  // the unsealed intake follows its upload's window: the deadline sweeper's INTAKE_EXPIRED revocation commits (D-RET-1)
  await controlTx(t.ag.agencyId, (c) => revokeIn(c, t, r3.fileId, "INTAKE_EXPIRED"));
  assert.deepEqual(await oracleRow("SELECT state, revocation_reason FROM kauro.source_files WHERE file_id = $1", [r3.fileId]), { state: "ADMISSION_REVOKED", revocation_reason: "INTAKE_EXPIRED" });
});

test("N2: the provider-session evidence is the control plane's — a request handler's cancellation has the database request the provider cancellation, but no request handler records the provider's answer, reopens a session by an unobserved completion, or appends an event type of the control plane", async () => {
  const t = await tenant("n2");
  await setSessionLimit(t, 8);
  const { projectId, revisionId } = await freshProject(t);
  const up = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, projectId, revisionId, 100);
    await toUploading(c, t, revisionId, r.uploadId);
    return r;
  });
  await tx(app, as(t), (c) => issueSession(c, t, up.uploadId));
  // CMD015: the handler tombstones the upload; the database requests the provider cancellation in the same update, at its instant
  await tx(app, as(t), (c) => cancelUpload(c, t, up.uploadId, 3));
  assert.deepEqual(
    await oracleRow("SELECT provider_cancellation_state, provider_cancellation_at = cancelled_at AS same_instant FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]),
    { provider_cancellation_state: "REQUESTED", same_instant: true },
  );
  // the re-checker's probe: the handler records the provider's answer CONFIRMED with its event — refused (no grant on the result)
  await assert.rejects(
    tx(app, as(t), async (c) => {
      await c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'CONFIRMED', provider_cancellation_at = kauro.server_now(), version = 4 WHERE upload_id = $1 AND version = 3", [up.uploadId]);
      await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 4, agencyId: t.ag.agencyId, eventType: "upload_session.provider_cancellation_recorded.v1", actorUserId: t.ag.ownerUserId, payload: { uploadId: up.uploadId, providerCancellationState: "CONFIRMED" } });
    }),
    refusedWith("42501"),
  );
  // the same probe under an event type the handler may append (its own cancellation's): refused by the grant alone
  await assert.rejects(
    tx(app, as(t), async (c) => {
      await c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'CONFIRMED', provider_cancellation_at = kauro.server_now(), version = 4 WHERE upload_id = $1 AND version = 3", [up.uploadId]);
      await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 4, agencyId: t.ag.agencyId, eventType: "upload_session.cancelled.v1", actorUserId: t.ag.ownerUserId });
    }),
    refusedWith("42501"),
  );
  // a tombstone's facts are set once: the handler cannot re-date, re-explain or re-attribute its cancellation (KA004)
  for (const sets of ["cancelled_at = kauro.server_now()", "terminal_reason = 'SOMETHING_ELSE'", "cancelled_by_membership_id = NULL"]) {
    await assert.rejects(
      tx(app, as(t), async (c) => {
        await c.query(`UPDATE kauro.upload_sessions SET ${sets}, version = 4 WHERE upload_id = $1 AND version = 3`, [up.uploadId]);
        await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 4, agencyId: t.ag.agencyId, eventType: "upload_session.cancelled.v1", actorUserId: t.ag.ownerUserId });
      }),
      refusedWith("KA004"),
      sets,
    );
  }
  // nor in the tombstoning update itself: a second upload cancelled "already CONFIRMED" is refused the same way
  const second = await tx(app, as(t), (c) => reserveIn(c, t, projectId, revisionId, 100));
  await tx(app, as(t), (c) => issueSession(c, t, second.uploadId));
  await assert.rejects(
    tx(app, as(t), (c) => c.query("UPDATE kauro.upload_sessions SET state = 'CANCELLED', version = 3, cancelled_at = kauro.server_now(), cancelled_by_membership_id = $2, terminal_reason = 'CANCELLED_BY_REQUESTER', provider_cancellation_state = 'CONFIRMED', provider_cancellation_at = kauro.server_now() WHERE upload_id = $1", [second.uploadId, t.ag.ownerMembershipId])),
    refusedWith("42501"),
  );
  // the control plane's event types are not the request handlers' to append, not even on a version bump of their own aggregate:
  // a forged "recorded" or "expired" fact would reach its consumers (AUTHORITY_JOURNAL, STORAGE_LIFECYCLE)
  const bumpWith = (kind: "upload_session" | "dataset_revision", id: string, eventType: string) =>
    tx(app, as(t), async (c) => {
      const table = kind === "upload_session" ? "upload_sessions" : "dataset_revisions";
      const key = kind === "upload_session" ? "upload_id" : "revision_id";
      const r = await c.query<{ version: string }>(`UPDATE kauro.${table} SET version = version + 1 WHERE ${key} = $1 RETURNING version::text`, [id]);
      await event(c, { aggregateKind: kind, aggregateId: id, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType, actorUserId: t.ag.ownerUserId });
    });
  await assert.rejects(bumpWith("upload_session", up.uploadId, "upload_session.provider_cancellation_recorded.v1"), refusedWith("42501"));
  await assert.rejects(bumpWith("upload_session", up.uploadId, "upload_session.expired.v1"), refusedWith("42501"));
  await assert.rejects(bumpWith("dataset_revision", revisionId, "dataset_revision.expired.v1"), refusedWith("42501"));
  await assert.rejects(bumpWith("dataset_revision", revisionId, "dataset_revision.ready_to_seal.v1"), refusedWith("42501"));
  // a cancelled revision's terminal facts are set once as well (CMD012 cancelled it; nothing re-dates it afterwards)
  const cancelled = await freshProject(t);
  await tx(app, as(t), (c) => cancelRevision(c, t, cancelled.revisionId, "ABANDONED"));
  await assert.rejects(
    tx(app, as(t), async (c) => {
      const r = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET cancelled_at = kauro.server_now(), terminal_reason = 'REPLACED_BY_NEW_REVISION', version = version + 1 WHERE revision_id = $1 RETURNING version::text", [cancelled.revisionId]);
      await event(c, { aggregateKind: "dataset_revision", aggregateId: cancelled.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.cancelled.v1", actorUserId: t.ag.ownerUserId });
    }),
    refusedWith("KA004"),
  );
  // the list is exactly the control plane's edges of D-CTRL-2, the same list its own insert policy admits
  assert.deepEqual((await oracleRow<{ types: string[] }>("SELECT kauro.source_control_event_types() AS types")).types, [
    "upload_session.completion_observed.v1", "upload_session.completion_not_observed.v1", "upload_session.admitted.v1",
    "upload_session.rejected.v1", "upload_session.expired.v1", "upload_session.provider_cancellation_recorded.v1",
    "dataset_revision.ready_to_seal.v1", "dataset_revision.rejected.v1", "dataset_revision.expired.v1",
    "retention_record.expired.v1", "source_file.admitted.v1", "source_file.admission_revoked.v1",
  ]);
  // positive symmetry: the control plane records the provider's answer (UNCERTAIN, then CONFIRMED) with its event
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'UNCERTAIN', provider_cancellation_at = kauro.server_now(), version = 4 WHERE upload_id = $1 AND version = 3", [up.uploadId]);
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 4, agencyId: t.ag.agencyId, eventType: "upload_session.provider_cancellation_recorded.v1", actorUserId: null, payload: { uploadId: up.uploadId, providerCancellationState: "UNCERTAIN" } });
  });
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'CONFIRMED', provider_cancellation_at = kauro.server_now(), version = 5 WHERE upload_id = $1 AND version = 4", [up.uploadId]);
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 5, agencyId: t.ag.agencyId, eventType: "upload_session.provider_cancellation_recorded.v1", actorUserId: null, payload: { uploadId: up.uploadId, providerCancellationState: "CONFIRMED" } });
  });
  assert.deepEqual(await oracleRow("SELECT provider_cancellation_state FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]), { provider_cancellation_state: "CONFIRMED" });

  // completion_not_observed (VERIFYING -> UPLOADING) reopens a bearer session: the request handler cannot take it, with or without
  // the negative observation it holds no grant on; the control plane takes it with its observation
  const third = await tx(app, as(t), (c) => reserveIn(c, t, projectId, revisionId, 100));
  await tx(app, as(t), (c) => issueSession(c, t, third.uploadId));
  await tx(app, as(t), (c) => reportCompletion(c, t, third.uploadId));
  const reopen = (sets: string, eventType: string, actorUserId: string | null) => async (c: Client) => {
    await c.query(`UPDATE kauro.upload_sessions SET state = 'UPLOADING', version = 4, completion_claim_digest = NULL, completion_reported_at = NULL${sets} WHERE upload_id = $1 AND version = 3`, [third.uploadId]);
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: third.uploadId, aggregateVersion: 4, agencyId: t.ag.agencyId, eventType, actorUserId, payload: { uploadId: third.uploadId } });
  };
  // the handler, under an event type it may append, without the negative observation (KA072) and with it (no grant, 42501)
  await assert.rejects(tx(app, as(t), reopen("", "upload_session.completion_reported.v1", t.ag.ownerUserId)), refusedWith("KA072"));
  await assert.rejects(tx(app, as(t), reopen(", completion_not_observed_at = kauro.server_now()", "upload_session.completion_reported.v1", t.ag.ownerUserId)), refusedWith("42501"));
  await controlTx(t.ag.agencyId, reopen(", completion_not_observed_at = kauro.server_now()", "upload_session.completion_not_observed.v1", null));
  assert.deepEqual(await oracleRow("SELECT state, completion_not_observed_at IS NOT NULL AS observed FROM kauro.upload_sessions WHERE upload_id = $1", [third.uploadId]), { state: "UPLOADING", observed: true });
});

test("N4: tenant-scope pairs are bound by composite keys — a retention record's client is its project's client, and an upload is requested by the acting person through their own live operator membership, the pair bound for every writer", async () => {
  const t = await tenant("n4");
  // (a) the UNPAID record of a seal naming another client of the same agency: refused by the composite key to the project
  const otherClient = await endClient(app, t.ag, await processingAuthority(app, t.ag), "Client Two");
  const p = await freshProject(t);
  const scope = scopeOf(t, p.projectId);
  const ready = await readySourceRevision(sessionsOf(t), scope, await admitSourceFile(sessionsOf(t), scope, { seed: "n4" }));
  const sealedAt = new Date(ready.initiatedAt.getTime() + 600_000);
  await assert.rejects(tx(app, as(t), (c) => sealStatements(c, scope, { ...ready, clientId: otherClient }, sealedAt)), refusedWith("23503", "retention_records_project_client_fk"));
  await tx(app, as(t), (c) => sealStatements(c, scope, ready, sealedAt)); // positive neighbour: the project's own client

  // (b) the requester of an upload
  const q = await freshProject(t);
  const stranger = await person(app, "b07-n4-stranger"); // an identity with no membership in the agency
  const colleague = await person(app, "b07-n4-colleague");
  const colleagueMembershipId = await member(app, t.ag, colleague, "OPERATOR");
  const viewer = await person(app, "b07-n4-viewer");
  const viewerMembershipId = await member(app, t.ag, viewer, "VIEWER");
  // the re-checker's probe: the owner names its own membership and, as the requester, a person with no membership in the agency
  await assert.rejects(tx(app, as(t), (c) => reserveIn(c, t, q.projectId, q.revisionId, 10, { requester: { membershipId: t.ag.ownerMembershipId, userId: stranger.userId } })), refusedWith("42501"));
  // another member's membership under the actor's own person, and a VIEWER's own membership (CMD013 is AGENCY_OPERATOR)
  await assert.rejects(tx(app, as(t), (c) => reserveIn(c, t, q.projectId, q.revisionId, 10, { requester: { membershipId: colleagueMembershipId, userId: t.ag.ownerUserId } })), refusedWith("42501"));
  await assert.rejects(
    tx(app, { agencyId: t.ag.agencyId, userId: viewer.userId }, (c) => reserveIn(c, t, q.projectId, q.revisionId, 10, { requester: { membershipId: viewerMembershipId, userId: viewer.userId } })),
    refusedWith("42501"),
  );
  // the pair itself is a composite key for every writer: the superuser (the adversary here, no row security) is refused it too
  await su.query("BEGIN");
  try {
    const objectId = ids.next();
    const uploadId = ids.next();
    await su.query(
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RAW', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $6, 'MEMBERSHIP', $7, kauro.server_now(), now())`,
      [objectId, t.ag.agencyId, q.projectId, q.revisionId, uploadId, `quarantine/${t.ag.agencyId}/${q.projectId}/${q.revisionId}/${uploadId}`, t.ag.ownerMembershipId],
    );
    await assert.rejects(
      su.query(
        `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, display_name, declared_format, reserved_bytes, quarantine_object_id, requested_by_membership_id, requested_by_user_id, application_expires_at, session_attempt, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'contacts export.csv', 'CSV', 10, $5, $6, $7, kauro.server_now() + interval '86400 seconds', 1, kauro.server_now(), now())`,
        [uploadId, t.ag.agencyId, q.projectId, q.revisionId, objectId, t.ag.ownerMembershipId, stranger.userId],
      ),
      refusedWith("23503", "upload_sessions_requester_fk"),
    );
  } finally {
    await su.query("ROLLBACK");
  }
  // positive neighbour: the OPERATOR colleague reserves as themselves, through their own membership
  const own = await tx(app, { agencyId: t.ag.agencyId, userId: colleague.userId }, (c) => reserveIn(c, t, q.projectId, q.revisionId, 10, { requester: { membershipId: colleagueMembershipId, userId: colleague.userId } }));
  assert.deepEqual(await oracleRow("SELECT requested_by_membership_id AS m, requested_by_user_id AS u FROM kauro.upload_sessions WHERE upload_id = $1", [own.uploadId]), { m: colleagueMembershipId, u: colleague.userId });
});
