// The B07 migrations (0008..0011) against a real PostgreSQL 17 (07 "Acceptance obligations": real PostgreSQL for tenant
// constraints, transactions, migrations and concurrency). Every write below goes through the runtime login roles under a bound
// context — kauro_app_test as a request handler, kauro_control_test as the control plane bound to one agency (D-CTRL-1) — so the
// positive path proves the policies admit the legitimate lifecycle (21 "Positive and negative symmetry"); the superuser is the
// oracle only. The schema is judged against the registry (enum vocabularies) and the domain (machines, events, aggregate kinds).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { registryJson } from "@kauro/contracts";
import { AGGREGATE_KINDS, SOURCE_LIFECYCLE_STATE_MACHINES } from "@kauro/domain";
import { startTemporaryPostgres, waitForLockWait, type TemporaryPostgres } from "../src/index.js";
import { agency, endClient, event, ids, offeredCapability, person, processingAuthority, project, sha, tx, type AgencyFixture, type Context, type Person } from "./support.js";

let pg: TemporaryPostgres;
let su: Client;
let app: Client;
let app2: Client;
let control: Client;
let owner: Person;
let A: AgencyFixture;
let B: AgencyFixture;
let capabilityId: string;
let clientA: string;
let clientB: string;

before(async () => {
  pg = await startTemporaryPostgres();
  su = await pg.connect("postgres");
  app = await pg.connect("kauro_app_test");
  app2 = await pg.connect("kauro_app_test");
  control = await pg.connect("kauro_control_test");
  owner = await person(app, "b07-owner");
  const ownerB = await person(app, "b07-owner-b");
  A = await agency(app, owner, "Agency A");
  B = await agency(app, ownerB, "Agency B");
  capabilityId = await offeredCapability(control, "CLEAN");
  clientA = await endClient(app, A, await processingAuthority(app, A));
  clientB = await endClient(app, B, await processingAuthority(app, B));
});

after(async () => {
  await control.end();
  await app2.end();
  await app.end();
  await su.end();
  await pg.stop();
});

const GiB = 1_000_000_000;
const as = (ag: AgencyFixture): Context => ({ agencyId: ag.agencyId, userId: ag.ownerUserId });

/** A SYSTEM unit of work of the control plane bound to one agency (kauro.agency_id set, no user). */
async function controlTx<T>(agencyId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  await control.query("BEGIN");
  try {
    await control.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [agencyId ?? ""]);
    const out = await fn(control);
    await control.query("COMMIT");
    return out;
  } catch (e) {
    await control.query("ROLLBACK");
    throw e;
  }
}

function serviceEvent(c: Client, e: { aggregateKind: string; aggregateId: string; aggregateVersion: number; agencyId: string; eventType: string; payload?: Record<string, unknown> }): Promise<string> {
  return event(c, { ...e, actorUserId: null });
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

interface Reserved {
  readonly uploadId: string;
  readonly objectId: string;
  readonly revisionId: string;
  readonly projectId: string;
}

/** ReserveUpload's first unit of work as the handler performs it: quarantine intent, RESERVED upload, event, DRAFT -> UPLOADING. */
async function reserveIn(c: Client, ag: AgencyFixture, projectId: string, revisionId: string, bytes: number): Promise<Reserved> {
  const uploadId = ids.next();
  const objectId = ids.next();
  await c.query(
    `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, state, created_by_kind, created_by_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RAW', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $6, 'INTENDED', 'MEMBERSHIP', $7, now(), now())`,
    [objectId, ag.agencyId, projectId, revisionId, uploadId, `quarantine/${ag.agencyId}/${projectId}/${revisionId}/${uploadId}`, ag.ownerMembershipId],
  );
  await c.query(
    `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, display_name, declared_format, reserved_bytes, quarantine_object_id, requested_by_membership_id, requested_by_user_id, application_expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'contacts export.csv', 'CSV', $5, $6, $7, $8, now() + interval '86400 seconds', now(), now())`,
    [uploadId, ag.agencyId, projectId, revisionId, bytes, objectId, ag.ownerMembershipId, ag.ownerUserId],
  );
  await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 1, agencyId: ag.agencyId, eventType: "upload_session.reserved.v1", actorUserId: ag.ownerUserId, payload: { uploadId, reservedBytes: bytes } });
  return { uploadId, objectId, revisionId, projectId };
}

async function toUploading(c: Client, ag: AgencyFixture, revisionId: string, firstUploadId: string): Promise<void> {
  const r = await c.query("UPDATE kauro.dataset_revisions SET state = 'UPLOADING', version = version + 1 WHERE revision_id = $1 AND state = 'DRAFT' RETURNING version", [revisionId]);
  assert.equal(r.rowCount, 1);
  await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(r.rows[0].version), agencyId: ag.agencyId, eventType: "dataset_revision.uploading.v1", actorUserId: ag.ownerUserId, payload: { revisionId, firstUploadId } });
}

async function freshProject(ag: AgencyFixture, clientId: string): Promise<{ projectId: string; revisionId: string }> {
  return project(app, ag, clientId, capabilityId);
}

/** An operations change of the agency's concurrent-session limit (control plane only; request handlers cannot write it). */
async function setSessionLimit(ag: AgencyFixture, limit: number): Promise<void> {
  await controlTx(ag.agencyId, (c) =>
    c.query(
      "INSERT INTO kauro.upload_capacity (agency_id, active_sessions, session_limit, updated_at) VALUES ($1, 0, $2, now()) ON CONFLICT (agency_id) DO UPDATE SET session_limit = EXCLUDED.session_limit, updated_at = now()",
      [ag.agencyId, limit],
    ),
  );
}

async function oracleRow<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await su.query<T>(sql, params);
  assert.equal(r.rows.length, 1, sql);
  return r.rows[0] as T;
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

// ---------------------------------------------------------------------------------------------------------------------------------

test("B07 tables force row-level security, belong to the migrator, grant no DELETE to request handlers and never show customer text to the control plane", async () => {
  const tables = [
    "aggregate_kinds", "stored_objects", "revision_quota", "upload_capacity", "upload_sessions", "upload_session_secrets", "inspection_receipts",
    "source_files", "source_tables", "source_table_columns", "selection_manifests", "selection_evaluations", "sealed_manifests",
    "sealed_revision_files", "retention_anchor_kinds", "retention_anchors", "retention_records",
  ];
  const r = await su.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'kauro' AND c.relname = ANY($1)`,
    [tables],
  );
  assert.equal(r.rows.length, tables.length);
  for (const t of r.rows) {
    assert.equal(t.relrowsecurity && t.relforcerowsecurity, true, `${t.relname} must force RLS`);
    assert.equal(t.owner, "kauro_owner", t.relname);
  }
  const deletes = await su.query("SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'kauro_app' AND privilege_type = 'DELETE' AND table_schema = 'kauro'");
  assert.deepEqual(deletes.rows, []);
  // the control plane may delete only the temporary session record (09: a temporary control record)
  const controlDeletes = await su.query<{ table_name: string }>("SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'kauro_control' AND privilege_type = 'DELETE' AND table_schema = 'kauro' ORDER BY 1");
  assert.deepEqual(controlDeletes.rows.map((x) => x.table_name), ["leases", "upload_session_secrets"]);
  // customer text is never readable by the control plane; the inspection pipeline writes it but cannot read it back
  for (const [table, column] of [["upload_sessions", "display_name"], ["source_tables", "name_display"], ["source_table_columns", "label_display"]] as const) {
    const can = await oracleRow<{ read: boolean }>("SELECT has_column_privilege('kauro_control', $1, $2, 'SELECT') AS read", [`kauro.${table}`, column]);
    assert.equal(can.read, false, `${table}.${column}`);
    const tenant = await oracleRow<{ read: boolean }>("SELECT has_column_privilege('kauro_app', $1, $2, 'SELECT') AS read", [`kauro.${table}`, column]);
    assert.equal(tenant.read, true, `${table}.${column} is the tenant's own data`);
  }
  // request handlers cannot raise their own concurrent-session limit
  const limit = await oracleRow<{ update: boolean }>("SELECT has_column_privilege('kauro_app', 'kauro.upload_capacity', 'session_limit', 'UPDATE') AS update");
  assert.equal(limit.update, false);
  // still no SECURITY DEFINER anywhere
  const definers = await su.query("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'kauro' AND p.prosecdef");
  assert.deepEqual(definers.rows, []);
});

test("state and enum CHECKs of the B07 tables carry exactly the registry vocabularies", async () => {
  const expect: Array<[string, string, string, string]> = [
    ["upload_sessions", "state", "UploadSession", "state"],
    ["upload_sessions", "provider_cancellation_state", "UploadSession", "providerCancellationState"],
    ["upload_sessions", "declared_format", "FileManifest", "format"],
    ["source_files", "format", "FileManifest", "format"],
    ["source_files", "scan_state", "FileManifest", "scanState"],
    ["inspection_receipts", "scan_state", "FileManifest", "scanState"],
    ["retention_records", "class", "RetentionRecord", "class"],
    ["retention_records", "state", "RetentionRecord", "state"],
  ];
  for (const [table, column, contract, field] of expect) {
    const r = await su.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'kauro' AND t.relname = $1 AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ ('^CHECK \\(\\(' || $2 || ' = ANY')`,
      [table, column],
    );
    assert.equal(r.rows.length, 1, `${table}.${column} has no enum CHECK`);
    const values = [...r.rows[0]!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]);
    assert.deepEqual(values, registryEnum(contract, field), `${table}.${column}`);
  }
});

test("the listed-transition seed of UploadSession, StoredObject and SourceFile equals the domain machines; aggregate kinds equal the domain", async () => {
  for (const m of SOURCE_LIFECYCLE_STATE_MACHINES) {
    const expected = [...new Set(m.transitions.map((t) => `${t.from}>${t.to}`))].sort();
    const r = await su.query<{ edge: string }>("SELECT from_state || '>' || to_state AS edge FROM kauro.state_transitions WHERE machine = $1 ORDER BY 1", [m.contract]);
    assert.deepEqual(r.rows.map((x) => x.edge), expected, m.contract);
  }
  const kinds = await su.query<{ aggregate_kind: string }>("SELECT aggregate_kind FROM kauro.aggregate_kinds ORDER BY 1");
  assert.deepEqual(kinds.rows.map((x) => x.aggregate_kind), [...AGGREGATE_KINDS].sort());
  // an event of an unregistered aggregate kind is refused by the registry, not by a rewritten CHECK list
  await assert.rejects(
    tx(app, as(A), (c) => event(c, { aggregateKind: "quote", aggregateId: ids.next(), aggregateVersion: 1, agencyId: A.agencyId, eventType: "project.created.v1", actorUserId: owner.userId })),
    refusedWith("23503", "domain_events_aggregate_kind_fkey"),
  );
});

test("the legitimate lifecycle passes every guard: reserve, issue, report, observe, admit, select, evaluate, seal, retain", async () => {
  const { projectId, revisionId } = await freshProject(A, clientA);
  const bytes = 1_234;
  const generation = "1726000000123456";
  const sha256 = sha("the complete object bytes");
  // --- CMD013 phase 1 and phase 2 (request handler) ---
  const up = await tx(app, as(A), async (c) => {
    const reserved = await reserveIn(c, A, projectId, revisionId, 4_096);
    await toUploading(c, A, revisionId, reserved.uploadId);
    await c.query(
      `INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, 'UPLOAD_INITIATED', now(), $6, now())`,
      [ids.next(), A.agencyId, projectId, revisionId, reserved.uploadId, sha("anchor-" + reserved.uploadId)],
    );
    return reserved;
  });
  await tx(app, as(A), async (c) => {
    const fence = await c.query("UPDATE kauro.upload_sessions SET session_attempt = session_attempt + 1 WHERE upload_id = $1 AND state = 'RESERVED' RETURNING session_attempt", [up.uploadId]);
    assert.equal(fence.rows[0].session_attempt, 1, "the fence moves without a version bump");
    await c.query(
      `UPDATE kauro.upload_sessions SET state = 'UPLOADING', version = 2, session_issued_at = now(), provider_session_digest = $2, provider_session_expires_at = now() + interval '7 days'
        WHERE upload_id = $1 AND version = 1`,
      [up.uploadId, sha("session-uri")],
    );
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "upload_session.session_issued.v1", actorUserId: owner.userId });
    await c.query(
      `INSERT INTO kauro.upload_session_secrets (upload_id, agency_id, requested_by_user_id, session_attempt, key_ref, nonce, ciphertext, created_at)
       VALUES ($1, $2, $3, 1, 'local-aead:key-1', $4, $5, now())`,
      [up.uploadId, A.agencyId, owner.userId, Buffer.alloc(12, 7), Buffer.alloc(48, 9)],
    );
  });
  // --- CMD014 (request handler): the claim is recorded, nothing is admitted ---
  await tx(app, as(A), async (c) => {
    await c.query(
      `UPDATE kauro.upload_sessions SET state = 'VERIFYING', version = 3, completion_reported_at = now(), completion_claim_digest = $2, claimed_generation = $3, claimed_bytes = $4
        WHERE upload_id = $1 AND version = 2`,
      [up.uploadId, sha("completion-ref"), generation, bytes],
    );
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 3, agencyId: A.agencyId, eventType: "upload_session.completion_reported.v1", actorUserId: owner.userId });
  });
  // --- UPLOAD_INSPECTION (control plane bound to A): observe, then inspect, promote, admit ---
  await controlTx(A.agencyId, async (c) => {
    const fence = await c.query("UPDATE kauro.upload_sessions SET inspection_fence = inspection_fence + 1 WHERE upload_id = $1 AND state = 'VERIFYING' RETURNING inspection_fence", [up.uploadId]);
    assert.equal(fence.rows[0].inspection_fence, 1);
    await c.query("UPDATE kauro.upload_sessions SET version = 4, completion_observed_at = now(), observed_generation = $2, observed_bytes = $3 WHERE upload_id = $1 AND version = 3", [up.uploadId, generation, bytes]);
    await serviceEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 4, agencyId: A.agencyId, eventType: "upload_session.completion_observed.v1" });
    await c.query("UPDATE kauro.stored_objects SET state = 'PRESENT', generation = $2, bytes = $3, observed_at = now() WHERE object_id = $1", [up.objectId, generation, bytes]);
    await c.query("UPDATE kauro.stored_objects SET state = 'VERIFIED', sha256 = $2, verified_at = now() WHERE object_id = $1", [up.objectId, sha256]);
    const rev = await c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', version = version + 1 WHERE revision_id = $1 AND state = 'UPLOADING' RETURNING version", [revisionId]);
    await serviceEvent(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(rev.rows[0].version), agencyId: A.agencyId, eventType: "dataset_revision.inspecting.v1" });
  });
  const fileId = ids.next();
  const tableId = ids.next();
  const acceptedObjectId = ids.next();
  const acceptedGeneration = "1726000000999999";
  const receiptHash = sha("receipt-" + up.uploadId);
  await controlTx(A.agencyId, async (c) => {
    await c.query(
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, file_id, zone, data_class, provider, location_ref, object_name, generation, bytes, sha256, state, created_by_kind, created_by_ref, observed_at, verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACCEPTED', 'RAW', 'contract-fake-storage', 'ACCEPTED_PRIMARY', $7, $8, $9, $10, 'VERIFIED', 'SERVICE', 'upload-inspection', now(), now(), now(), now())`,
      [acceptedObjectId, A.agencyId, projectId, revisionId, up.uploadId, fileId, `accepted/${A.agencyId}/${projectId}/${fileId}`, acceptedGeneration, bytes, sha256],
    );
    await c.query(
      `INSERT INTO kauro.inspection_receipts (receipt_id, agency_id, upload_id, revision_id, receipt_hash, inspection_fence, quarantine_object_id, observed_generation, observed_bytes, sha256,
          completion_claim_digest, claim_consistent, declared_format, detected_format, structure_status, scan_state, scanner_engine, scanner_engine_version, signature_version,
          signatures_published_at, signature_max_age_seconds, scanner_config_hash, scanned_at, expected_parts, expected_bytes, scanned_parts, scanned_bytes, coverage, problems,
          parser_profile_hash, inspector_version, outcome, accepted_object_id, accepted_generation, accepted_sha256, started_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, true, 'CSV', 'CSV', 'STRUCTURE_VALID', 'COVERED_CLEAN', 'contract-fake-scanner', 'SIMULATED-1', 'SIG-2026-09-24',
          now() - interval '1 hour', 86400, $11, now(), 1, $8, 1, $8, '[]', '[]', $12, 'data-plane-0.1.0', 'ADMITTED', $13, $14, $9, now(), now(), now())`,
      [ids.next(), A.agencyId, up.uploadId, revisionId, receiptHash, up.objectId, generation, bytes, sha256, sha("completion-ref"), sha("scanner-config"), sha("parser-profile"), acceptedObjectId, acceptedGeneration],
    );
    await c.query(
      `INSERT INTO kauro.source_files (file_id, agency_id, project_id, origin_revision_id, origin_upload_id, accepted_object_id, provider_generation, sha256, bytes, format, scan_state, parser_profile_hash, inspection_receipt_hash, admitted, admitted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CSV', 'COVERED_CLEAN', $10, $11, true, now(), now(), now())`,
      [fileId, A.agencyId, projectId, revisionId, up.uploadId, acceptedObjectId, acceptedGeneration, sha256, bytes, sha("parser-profile"), receiptHash],
    );
    await c.query(
      `INSERT INTO kauro.source_tables (table_id, agency_id, file_id, ordinal, kind, name_display, name_digest, visibility, column_count, row_estimate, has_formulas, formula_cache, structure_hash, created_at)
       VALUES ($1, $2, $3, 0, 'CSV_TABLE', NULL, $4, 'VISIBLE', 2, 10, false, 'NOT_APPLICABLE', $5, now())`,
      [tableId, A.agencyId, fileId, sha(""), sha("table-structure")],
    );
    await c.query(
      `INSERT INTO kauro.source_table_columns (table_id, ordinal, agency_id, label_display, label_digest, label_state) VALUES ($1, 0, $2, 'Email', $3, 'PRESENT'), ($1, 1, $2, 'Email', $4, 'DUPLICATE_LABEL')`,
      [tableId, A.agencyId, sha("Email"), sha("Email")],
    );
    await c.query(
      "UPDATE kauro.upload_sessions SET state = 'ADMITTED', version = 5, admitted_at = now(), file_id = $2, inspection_receipt_hash = $3 WHERE upload_id = $1 AND version = 4",
      [up.uploadId, fileId, receiptHash],
    );
    await serviceEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 5, agencyId: A.agencyId, eventType: "upload_session.admitted.v1" });
  });
  // the admitted upload holds its observed bytes (not its reservation) and no longer holds a session slot
  assert.deepEqual(await oracleRow("SELECT reserved_bytes::int AS bytes, file_count AS files FROM kauro.revision_quota WHERE revision_id = $1", [revisionId]), { bytes, files: 1 });
  assert.deepEqual(await oracleRow("SELECT active_sessions FROM kauro.upload_capacity WHERE agency_id = $1", [A.agencyId]), { active_sessions: 0 });
  // --- CMD016 (request handler): an immutable selection manifest bound in place (INSPECTING) ---
  const manifestId = ids.next();
  const body = { schemaVersion: 1, revisionId, inventoryHash: sha("inventory"), files: [{ fileId, origin: "THIS_REVISION", disposition: "INCLUDE" }], tables: [], projections: [], associations: [] };
  const selectionHash = sha(JSON.stringify(body));
  await tx(app, as(A), async (c) => {
    await c.query(
      "INSERT INTO kauro.selection_manifests (selection_manifest_id, agency_id, project_id, revision_id, schema_version, body, body_hash, created_by_membership_id, created_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now())",
      [manifestId, A.agencyId, projectId, revisionId, JSON.stringify(body), selectionHash, A.ownerMembershipId],
    );
    const rev = await c.query(
      "UPDATE kauro.dataset_revisions SET selection_manifest_id = $2, selection_hash = $3, selected_at = now(), version = version + 1 WHERE revision_id = $1 AND state = 'INSPECTING' RETURNING version",
      [revisionId, manifestId, selectionHash],
    );
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(rev.rows[0].version), agencyId: A.agencyId, eventType: "dataset_revision.selection_changed.v1", actorUserId: owner.userId });
  });
  // --- SELECTION_EVALUATION (control plane): counts, then all_selected_inputs_admitted ---
  const evaluationId = ids.next();
  const evaluationHash = sha("evaluation-" + evaluationId);
  await controlTx(A.agencyId, async (c) => {
    await c.query(
      `INSERT INTO kauro.selection_evaluations (evaluation_id, agency_id, revision_id, selection_manifest_id, selection_hash, evaluation_hash, result, physical_source_rows, logical_source_records, billable_source_units, association_edges,
          file_count, total_bytes, files, tables, projections, pricing_definition, evaluator_version, started_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETE', 10, 12, 12, 10, 1, $7, $8, '[]', '[]', 'R2-INITIAL', 'data-plane-0.1.0', now(), now(), now())`,
      [evaluationId, A.agencyId, revisionId, manifestId, selectionHash, evaluationHash, bytes, JSON.stringify([{ fileId, generation: acceptedGeneration, sha256, bytes }])],
    );
    const rev = await c.query(
      `UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = version + 1, evaluation_id = $2, evaluation_hash = $3, physical_source_rows = 10, logical_source_records = 12, billable_source_units = 12, association_edges = 10
        WHERE revision_id = $1 AND state = 'INSPECTING' RETURNING version`,
      [revisionId, evaluationId, evaluationHash],
    );
    await serviceEvent(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(rev.rows[0].version), agencyId: A.agencyId, eventType: "dataset_revision.ready_to_seal.v1" });
  });
  // --- CMD017 (request handler): sealed manifest, file set, SEALED, retention anchor and record, all in one transaction ---
  const manifestHash = sha("manifest-" + revisionId);
  const projectionHash = sha("projection-" + revisionId);
  const retentionId = ids.next();
  await tx(app, as(A), async (c) => {
    const sealedAt = (await c.query<{ now: Date }>("SELECT now()")).rows[0]!.now;
    await c.query(
      `INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, canonical_version, manifest, sealed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, '{"canonicalVersion":1}', $8)`,
      [revisionId, A.agencyId, projectId, manifestHash, projectionHash, selectionHash, evaluationHash, sealedAt],
    );
    await c.query(
      "INSERT INTO kauro.sealed_revision_files (revision_id, file_id, agency_id, project_id, ordinal, disposition, provider_generation, sha256, bytes) VALUES ($1, $2, $3, $4, 0, 'INCLUDED', $5, $6, $7)",
      [revisionId, fileId, A.agencyId, projectId, acceptedGeneration, sha256, bytes],
    );
    const rev = await c.query(
      `UPDATE kauro.dataset_revisions SET state = 'SEALED', version = version + 1, manifest_hash = $2, projection_hash = $3, sealed_at = $4, sealed_file_count = 1, sealed_bytes = $5
        WHERE revision_id = $1 AND state = 'READY_TO_SEAL' RETURNING version`,
      [revisionId, manifestHash, projectionHash, sealedAt, bytes],
    );
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(rev.rows[0].version), agencyId: A.agencyId, eventType: "dataset_revision.sealed.v1", actorUserId: owner.userId });
    const anchorId = ids.next();
    const anchorHash = sha("seal-anchor-" + revisionId);
    await c.query(
      "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, 'REVISION_SEALED', $5, $6, now())",
      [anchorId, A.agencyId, projectId, revisionId, sealedAt, anchorHash],
    );
    await c.query(
      `INSERT INTO kauro.retention_records (retention_id, agency_id, client_id, project_id, revision_id, class, anchor_id, anchor_evidence_hash, hard_deadline, effective_deadline, policy_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'UNPAID', $6, $7, $8::timestamptz + interval '14 days', $8::timestamptz + interval '14 days', 'R2-RETENTION-1', now(), now())`,
      [retentionId, A.agencyId, clientA, projectId, revisionId, anchorId, anchorHash, sealedAt],
    );
    await event(c, { aggregateKind: "retention_record", aggregateId: retentionId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "retention_record.created.v1", actorUserId: owner.userId });
  });
  assert.deepEqual(
    await oracleRow("SELECT state, sealed_file_count, billable_source_units::int AS billable FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId]),
    { state: "SEALED", sealed_file_count: 1, billable: 12 },
  );
  // --- the sealed subject is frozen, and a file admitted from it cannot be re-admitted or re-bound ---
  await assert.rejects(
    tx(app, as(A), async (c) => {
      await c.query("UPDATE kauro.dataset_revisions SET selection_hash = $2, version = version + 1 WHERE revision_id = $1", [revisionId, sha("another selection")]);
    }),
    refusedWith("KA004"),
  );
  // the hard cap never moves: request handlers cannot write a retention record at all, and even a privileged writer (the
  // superuser, which bypasses row security but not triggers) is refused by the immutability trigger
  const extend = "UPDATE kauro.retention_records SET hard_deadline = hard_deadline + interval '1 day', effective_deadline = effective_deadline + interval '1 day', version = 2 WHERE retention_id = $1";
  await assert.rejects(tx(app, as(A), (c) => c.query(extend, [retentionId])), refusedWith("42501"));
  await assert.rejects(su.query(extend, [retentionId]), refusedWith("KA004"));
  // the secret was readable only while UPLOADING; the upload is ADMITTED now
  const secret = await tx(app, as(A), (c) => c.query("SELECT upload_id FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId]));
  assert.equal(secret.rowCount, 0);
  // no customer text reached an event of this lifecycle
  const payloads = await su.query<{ payload: unknown }>("SELECT payload FROM kauro.domain_events WHERE agency_id = $1", [A.agencyId]);
  for (const p of payloads.rows) assert.ok(!JSON.stringify(p.payload).includes("contacts export"), "display names never enter events");
});

test("R2-052: two reservations that each fit alone serialize on the revision ledger; only the combination within five billion bytes commits", async () => {
  // concurrency is not the subject here: operations raise A's session limit so only the byte envelope decides
  await setSessionLimit(A, 8);
  const { projectId, revisionId } = await freshProject(A, clientA);
  await app.query("BEGIN");
  await app2.query("BEGIN");
  try {
    await app.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [A.agencyId, A.ownerUserId]);
    await app2.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [A.agencyId, A.ownerUserId]);
    await reserveIn(app, A, projectId, revisionId, 1_500_000_000);
    // the second request, checked alone, fits (0 + 1.5e9 <= 5e9 from its snapshot); the database decides on the ledger row
    const second = (async () => {
      const objectId = ids.next();
      const uploadId = ids.next();
      await app2.query(
        `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, state, created_by_kind, created_by_ref, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RAW', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $6, 'INTENDED', 'MEMBERSHIP', $7, now(), now())`,
        [objectId, A.agencyId, projectId, revisionId, uploadId, `quarantine/${A.agencyId}/${projectId}/${revisionId}/${uploadId}`, A.ownerMembershipId],
      );
      await app2.query(
        `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, display_name, declared_format, reserved_bytes, quarantine_object_id, requested_by_membership_id, requested_by_user_id, application_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'accounts.xlsx', 'XLSX', 2000000000, $5, $6, $7, now() + interval '86400 seconds', now(), now())`,
        [uploadId, A.agencyId, projectId, revisionId, objectId, A.ownerMembershipId, A.ownerUserId],
      );
    })();
    // while the second waits on the ledger row, the first reserves another 2e9 (1.5e9 + 2e9 = 3.5e9 fits) and commits
    await waitForLockWait(su, "kauro-test-kauro_app_test", "INSERT INTO kauro.upload_sessions");
    await reserveIn(app, A, projectId, revisionId, 2_000_000_000);
    await app.query("COMMIT");
    // the second transaction resumes on the committed ledger: 3.5e9 + 2e9 = 5.5e9 > 5e9 — refused by the CHECK, not by a read
    await assert.rejects(second, refusedWith("23514", "revision_quota_bytes_within_envelope"));
    await app2.query("ROLLBACK");
  } catch (e) {
    await app.query("ROLLBACK").catch(() => undefined);
    await app2.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
  const ledger = await oracleRow<{ bytes: string; files: number }>("SELECT reserved_bytes::text AS bytes, file_count AS files FROM kauro.revision_quota WHERE revision_id = $1", [revisionId]);
  assert.deepEqual(ledger, { bytes: "3500000000", files: 2 });
  const uploads = await oracleRow<{ n: number; total: string }>("SELECT count(*)::int AS n, sum(reserved_bytes)::text AS total FROM kauro.upload_sessions WHERE revision_id = $1", [revisionId]);
  assert.deepEqual(uploads, { n: 2, total: "3500000000" });
  // positive neighbour: the combination that fits exactly the envelope commits
  await tx(app, as(A), (c) => reserveIn(c, A, projectId, revisionId, 1_500_000_000));
  assert.equal((await oracleRow<{ bytes: string }>("SELECT reserved_bytes::text AS bytes FROM kauro.revision_quota WHERE revision_id = $1", [revisionId])).bytes, "5000000000");
  // one byte more is refused, a file above 2e9 is refused by the per-file envelope
  await assert.rejects(tx(app, as(A), (c) => reserveIn(c, A, projectId, revisionId, 1)), refusedWith("23514", "revision_quota_bytes_within_envelope"));
  const other = await freshProject(A, clientA);
  await assert.rejects(tx(app, as(A), (c) => reserveIn(c, A, other.projectId, other.revisionId, 2 * GiB + 1)), refusedWith("23514"));
});

test("the agency admits two concurrent upload sessions; the third is refused by the capacity ledger and a terminal upload frees its slot once", async () => {
  const B2 = B;
  const p1 = await freshProject(B2, clientB);
  const p2 = await freshProject(B2, clientB);
  const first = await tx(app, as(B2), (c) => reserveIn(c, B2, p1.projectId, p1.revisionId, 10));
  await tx(app, as(B2), (c) => reserveIn(c, B2, p2.projectId, p2.revisionId, 10));
  await assert.rejects(tx(app, as(B2), (c) => reserveIn(c, B2, p1.projectId, p1.revisionId, 10)), refusedWith("23514", "upload_capacity_within_limit"));
  // cancelling the first releases its slot and its bytes exactly once; a late completion cannot resurrect it
  await tx(app, as(B2), async (c) => {
    await c.query(
      "UPDATE kauro.upload_sessions SET state = 'CANCELLED', version = 2, cancelled_at = now(), cancelled_by_membership_id = $2, terminal_reason = 'CANCELLED_BY_REQUESTER' WHERE upload_id = $1 AND version = 1",
      [first.uploadId, B2.ownerMembershipId],
    );
    await event(c, { aggregateKind: "upload_session", aggregateId: first.uploadId, aggregateVersion: 2, agencyId: B2.agencyId, eventType: "upload_session.cancelled.v1", actorUserId: B2.ownerUserId });
  });
  assert.deepEqual(await oracleRow("SELECT active_sessions FROM kauro.upload_capacity WHERE agency_id = $1", [B2.agencyId]), { active_sessions: 1 });
  assert.deepEqual(await oracleRow("SELECT reserved_bytes::int AS bytes, file_count AS files FROM kauro.revision_quota WHERE revision_id = $1", [p1.revisionId]), { bytes: 0, files: 0 });
  for (const target of ["VERIFYING", "UPLOADING", "ADMITTED", "RESERVED"]) {
    await assert.rejects(
      tx(app, as(B2), async (c) => {
        await c.query("UPDATE kauro.upload_sessions SET state = $2, version = 3 WHERE upload_id = $1", [first.uploadId, target]);
      }),
      refusedWith("KA008"),
      `CANCELLED -> ${target} must be unlisted`,
    );
  }
  // the freed slot is usable exactly once more
  await tx(app, as(B2), (c) => reserveIn(c, B2, p1.projectId, p1.revisionId, 10));
  await assert.rejects(tx(app, as(B2), (c) => reserveIn(c, B2, p1.projectId, p1.revisionId, 10)), refusedWith("23514", "upload_capacity_within_limit"));
  // an operations limit change is the only way to admit more; the ledger itself stays exact
  await setSessionLimit(B2, 8);
  await tx(app, as(B2), (c) => reserveIn(c, B2, p1.projectId, p1.revisionId, 10));
  assert.deepEqual(await oracleRow("SELECT active_sessions, session_limit FROM kauro.upload_capacity WHERE agency_id = $1", [B2.agencyId]), { active_sessions: 3, session_limit: 8 });
});

test("late results cannot attach to a cancelled upload: receipts, files and fences are refused by the database", async () => {
  const { projectId, revisionId } = await freshProject(A, clientA);
  const up = await tx(app, as(A), async (c) => {
    const r = await reserveIn(c, A, projectId, revisionId, 100);
    await toUploading(c, A, revisionId, r.uploadId);
    return r;
  });
  await tx(app, as(A), async (c) => {
    await c.query(
      `UPDATE kauro.upload_sessions SET state = 'UPLOADING', version = 2, session_attempt = 1, session_issued_at = now(), provider_session_digest = $2, provider_session_expires_at = now() + interval '7 days' WHERE upload_id = $1`,
      [up.uploadId, sha("s")],
    );
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "upload_session.session_issued.v1", actorUserId: owner.userId });
  });
  await tx(app, as(A), async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET state = 'VERIFYING', version = 3, completion_reported_at = now(), completion_claim_digest = $2 WHERE upload_id = $1", [up.uploadId, sha("ref")]);
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 3, agencyId: A.agencyId, eventType: "upload_session.completion_reported.v1", actorUserId: owner.userId });
  });
  // the inspection claims its attempt, then the cancellation wins the transaction (cancellation remains valid while verification races)
  await controlTx(A.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET inspection_fence = 1 WHERE upload_id = $1", [up.uploadId]));
  await tx(app, as(A), async (c) => {
    await c.query(
      "UPDATE kauro.upload_sessions SET state = 'CANCELLED', version = 4, cancelled_at = now(), cancelled_by_membership_id = $2, terminal_reason = 'CANCELLED_BY_REQUESTER', provider_cancellation_state = 'REQUESTED' WHERE upload_id = $1 AND version = 3",
      [up.uploadId, A.ownerMembershipId],
    );
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 4, agencyId: A.agencyId, eventType: "upload_session.cancelled.v1", actorUserId: owner.userId });
  });
  // the stale inspection attempt tries to record its receipt: refused (KA010), whatever it observed
  await assert.rejects(
    controlTx(A.agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.inspection_receipts (receipt_id, agency_id, upload_id, revision_id, receipt_hash, inspection_fence, quarantine_object_id, observed_generation, observed_bytes,
            completion_claim_digest, claim_consistent, declared_format, detected_format, structure_status, scan_state, inspector_version, outcome, rejection_class, started_at, completed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6, '17', 100, $7, true, 'CSV', 'CSV', 'STRUCTURE_VALID', 'NOT_SCANNED', 'data-plane-0.1.0', 'REJECTED', 'INCOMPLETE_SCAN', now(), now(), now())`,
        [ids.next(), A.agencyId, up.uploadId, revisionId, sha("late-receipt"), up.objectId, sha("ref")],
      ),
    ),
    refusedWith("KA010"),
  );
  // fences never move backwards; the provider cancellation result only moves forward
  await assert.rejects(controlTx(A.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET inspection_fence = 0 WHERE upload_id = $1", [up.uploadId])), refusedWith("KA010"));
  await controlTx(A.agencyId, async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'UNCERTAIN', provider_cancellation_at = now(), version = 5 WHERE upload_id = $1 AND version = 4", [up.uploadId]);
    await serviceEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 5, agencyId: A.agencyId, eventType: "upload_session.provider_cancellation_recorded.v1" });
  });
  await assert.rejects(
    controlTx(A.agencyId, async (c) => {
      await c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'NOT_REQUESTED', version = 6 WHERE upload_id = $1", [up.uploadId]);
    }),
    refusedWith("KA008"),
  );
  // the quota was released once, by the cancellation
  assert.deepEqual(await oracleRow("SELECT reserved_bytes::int AS bytes, file_count AS files FROM kauro.revision_quota WHERE revision_id = $1", [revisionId]), { bytes: 0, files: 0 });
});

test("the quota ledgers cannot be edited around the uploads they summarize (KA009 at commit)", async () => {
  const { projectId, revisionId } = await freshProject(A, clientA);
  await tx(app, as(A), (c) => reserveIn(c, A, projectId, revisionId, 1_000));
  await assert.rejects(tx(app, as(A), (c) => c.query("UPDATE kauro.revision_quota SET reserved_bytes = 0 WHERE revision_id = $1", [revisionId])), refusedWith("KA009"));
  await assert.rejects(tx(app, as(A), (c) => c.query("UPDATE kauro.upload_capacity SET active_sessions = 0 WHERE agency_id = $1", [A.agencyId])), refusedWith("KA009"));
});

test("S054 at the database: COVERED_CLEAN requires complete coverage by fresh signatures; admission requires every separate result and binds the file to its receipt", async () => {
  const { projectId, revisionId } = await freshProject(B, clientB);
  const up = await tx(app, as(B), (c) => reserveIn(c, B, projectId, revisionId, 100));
  await tx(app, as(B), async (c) => {
    await c.query("UPDATE kauro.dataset_revisions SET state = 'UPLOADING', version = version + 1 WHERE revision_id = $1", [revisionId]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 2, agencyId: B.agencyId, eventType: "dataset_revision.uploading.v1", actorUserId: B.ownerUserId });
    await c.query(`UPDATE kauro.upload_sessions SET state = 'UPLOADING', version = 2, session_issued_at = now(), provider_session_digest = $2, provider_session_expires_at = now() + interval '7 days' WHERE upload_id = $1`, [up.uploadId, sha("s2")]);
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 2, agencyId: B.agencyId, eventType: "upload_session.session_issued.v1", actorUserId: B.ownerUserId });
  });
  await tx(app, as(B), async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET state = 'VERIFYING', version = 3, completion_reported_at = now(), completion_claim_digest = $2 WHERE upload_id = $1", [up.uploadId, sha("ref2")]);
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 3, agencyId: B.agencyId, eventType: "upload_session.completion_reported.v1", actorUserId: B.ownerUserId });
  });
  await controlTx(B.agencyId, async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET inspection_fence = 1 WHERE upload_id = $1", [up.uploadId]);
    await c.query("UPDATE kauro.upload_sessions SET version = 4, completion_observed_at = now(), observed_generation = '42', observed_bytes = 100 WHERE upload_id = $1", [up.uploadId]);
    await serviceEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 4, agencyId: B.agencyId, eventType: "upload_session.completion_observed.v1" });
  });
  const receipt = (over: Record<string, unknown>) => {
    const r: Record<string, unknown> = {
      receipt_id: ids.next(), agency_id: B.agencyId, upload_id: up.uploadId, revision_id: revisionId, receipt_hash: sha("r-" + ids.next()), inspection_fence: 1,
      quarantine_object_id: up.objectId, observed_generation: "42", observed_bytes: 100, sha256: sha("bytes"), completion_claim_digest: sha("ref2"), claim_consistent: true,
      declared_format: "CSV", detected_format: "CSV", structure_status: "STRUCTURE_INVALID", scan_state: "COVERED_CLEAN", scanner_engine: "contract-fake-scanner",
      scanner_engine_version: "SIMULATED-1", signature_version: "SIG-1", signatures_published_at: new Date(Date.now() - 3_600_000), signature_max_age_seconds: 86400,
      scanner_config_hash: sha("cfg"), scanned_at: new Date(), expected_parts: 1, expected_bytes: 100, scanned_parts: 1, scanned_bytes: 100, parser_profile_hash: sha("pp"),
      inspector_version: "data-plane-0.1.0", outcome: "REJECTED", rejection_class: "CORRUPT_STRUCTURE", started_at: new Date(), completed_at: new Date(), created_at: new Date(),
      ...over,
    };
    const cols = Object.keys(r);
    return controlTx(B.agencyId, (c) => c.query(`INSERT INTO kauro.inspection_receipts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => r[k])));
  };
  // the ClamAV skip: the engine read nothing of the part but a receipt tries to store COVERED_CLEAN
  await assert.rejects(receipt({ scanned_bytes: 0, scanned_parts: 0 }), refusedWith("23514", "inspection_receipts_clean_means_covered"));
  // stale signatures cannot produce COVERED_CLEAN
  await assert.rejects(receipt({ signatures_published_at: new Date(Date.now() - 3 * 86_400_000) }), refusedWith("23514", "inspection_receipts_clean_means_covered"));
  // nothing expected is not coverage
  await assert.rejects(receipt({ expected_parts: 0, expected_bytes: 0, scanned_parts: 0, scanned_bytes: 0 }), refusedWith("23514", "inspection_receipts_clean_means_covered"));
  // admission with a scan that is not COVERED_CLEAN, or with an inconsistent claim, is refused
  await assert.rejects(receipt({ structure_status: "STRUCTURE_VALID", scan_state: "NOT_SCANNED", scanned_parts: 0, scanned_bytes: 0, outcome: "ADMITTED", rejection_class: null }), refusedWith("23514", "inspection_receipts_admission_complete"));
  await assert.rejects(receipt({ structure_status: "STRUCTURE_VALID", claim_consistent: false, outcome: "ADMITTED", rejection_class: null }), refusedWith("23514", "inspection_receipts_admission_complete"));
  // a skipped scan is NOT_SCANNED, never "clean with a warning"; a detection is BLOCKED and nothing else is
  await assert.rejects(receipt({ rejection_class: "INCOMPLETE_SCAN" }), refusedWith("23514", "inspection_receipts_incomplete_is_not_scanned"));
  await assert.rejects(receipt({ rejection_class: "DETECTED_MALWARE" }), refusedWith("23514", "inspection_receipts_blocked_is_detection"));
  // positive neighbour: a complete scan that found malware is a legitimate (rejecting) receipt
  await receipt({ receipt_hash: sha("the malware receipt"), structure_status: "STRUCTURE_VALID", scan_state: "BLOCKED", rejection_class: "DETECTED_MALWARE" });
  const stored = await oracleRow<{ n: number }>("SELECT count(*)::int AS n FROM kauro.inspection_receipts WHERE upload_id = $1", [up.uploadId]);
  assert.equal(stored.n, 1);
});

test("the session secret is readable by its requester only while UPLOADING, by the control plane only when bound to the agency, and by nobody else", async () => {
  const { projectId, revisionId } = await freshProject(A, clientA);
  const colleague = await person(app, "b07-colleague");
  const colleagueMembership = ids.next();
  await tx(app, as(A), async (c) => {
    await c.query(
      "INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, accepted_at, created_at, updated_at) VALUES ($1, $2, $3, 'OPERATOR', 'ACTIVE', 'MFA_REQUIRED', now(), now(), now())",
      [colleagueMembership, A.agencyId, colleague.userId],
    );
    await event(c, { aggregateKind: "membership", aggregateId: colleagueMembership, aggregateVersion: 1, agencyId: A.agencyId, eventType: "membership.created.v1", actorUserId: owner.userId });
  });
  const up = await tx(app, as(A), (c) => reserveIn(c, A, projectId, revisionId, 10));
  await tx(app, as(A), async (c) => {
    await c.query(`UPDATE kauro.upload_sessions SET state = 'UPLOADING', version = 2, session_attempt = 1, session_issued_at = now(), provider_session_digest = $2, provider_session_expires_at = now() + interval '7 days' WHERE upload_id = $1`, [up.uploadId, sha("s3")]);
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "upload_session.session_issued.v1", actorUserId: owner.userId });
    await c.query(
      "INSERT INTO kauro.upload_session_secrets (upload_id, agency_id, requested_by_user_id, session_attempt, key_ref, nonce, ciphertext, created_at) VALUES ($1, $2, $3, 1, 'local-aead:key-1', $4, $5, now())",
      [up.uploadId, A.agencyId, owner.userId, Buffer.alloc(12, 1), Buffer.alloc(40, 2)],
    );
  });
  const read = (ctx: Context) => tx(app, ctx, (c) => c.query("SELECT upload_id FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId]));
  assert.equal((await read(as(A))).rowCount, 1, "the requester reads it while UPLOADING");
  assert.equal((await read({ agencyId: A.agencyId, userId: colleague.userId })).rowCount, 0, "a colleague of the same agency does not");
  assert.equal((await read({ agencyId: B.agencyId, userId: B.ownerUserId })).rowCount, 0, "another agency does not");
  // nobody inserts a secret for someone else's upload
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: colleague.userId }, (c) =>
      c.query("INSERT INTO kauro.upload_session_secrets (upload_id, agency_id, requested_by_user_id, session_attempt, key_ref, nonce, ciphertext, created_at) VALUES ($1, $2, $3, 2, 'local-aead:key-1', $4, $5, now())", [up.uploadId, A.agencyId, owner.userId, Buffer.alloc(12, 1), Buffer.alloc(40, 2)]),
    ),
    refusedWith("42501"),
  );
  assert.equal((await controlTx(null, (c) => c.query("SELECT upload_id FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId]))).rowCount, 0, "the unbound control plane does not");
  assert.equal((await controlTx(B.agencyId, (c) => c.query("SELECT upload_id FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId]))).rowCount, 0, "the control plane bound elsewhere does not");
  assert.equal((await controlTx(A.agencyId, (c) => c.query("SELECT upload_id FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId]))).rowCount, 1, "the control plane bound to A does (provider cancellation)");
  // once acceptance is tombstoned the requester can no longer read it; the control plane purges it
  await tx(app, as(A), async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET state = 'CANCELLED', version = 3, cancelled_at = now(), cancelled_by_membership_id = $2, terminal_reason = 'CANCELLED_BY_REQUESTER', provider_cancellation_state = 'REQUESTED' WHERE upload_id = $1", [up.uploadId, A.ownerMembershipId]);
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 3, agencyId: A.agencyId, eventType: "upload_session.cancelled.v1", actorUserId: owner.userId });
  });
  assert.equal((await read(as(A))).rowCount, 0);
  await assert.rejects(tx(app, as(A), (c) => c.query("DELETE FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId])), refusedWith("42501"));
  const purged = await controlTx(A.agencyId, (c) => c.query("DELETE FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId]));
  assert.equal(purged.rowCount, 1);
});

test("the control plane writes only rows of the agency it is bound to; unbound it may only discover work", async () => {
  const { projectId, revisionId } = await freshProject(B, clientB);
  const up = await tx(app, as(B), (c) => reserveIn(c, B, projectId, revisionId, 10));
  const discover = await controlTx(null, (c) => c.query("SELECT upload_id, state FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]));
  assert.equal(discover.rowCount, 1, "unbound discovery sees the non-text columns");
  await assert.rejects(controlTx(null, (c) => c.query("SELECT display_name FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId])), refusedWith("42501"));
  const unbound = await controlTx(null, (c) => c.query("UPDATE kauro.upload_sessions SET inspection_fence = inspection_fence + 1 WHERE upload_id = $1", [up.uploadId]));
  assert.equal(unbound.rowCount, 0, "an unbound control unit of work changes nothing");
  const elsewhere = await controlTx(A.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET inspection_fence = inspection_fence + 1 WHERE upload_id = $1", [up.uploadId]));
  assert.equal(elsewhere.rowCount, 0, "bound to another agency it changes nothing");
  await assert.rejects(
    controlTx(A.agencyId, (c) =>
      c.query(
        `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, zone, data_class, provider, location_ref, object_name, state, created_by_kind, created_by_ref, created_at, updated_at)
         VALUES ($1, $2, $3, 'QUARANTINE', 'RESIDUAL', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $4, 'INTENDED', 'SERVICE', 'sweeper', now(), now())`,
        [ids.next(), B.agencyId, projectId, `quarantine/${B.agencyId}/${projectId}/${ids.next()}`],
      ),
    ),
    refusedWith("42501"),
  );
});

test("revisions accept uploads only while DRAFT or UPLOADING, one mutable revision per project, and object names are opaque and scoped", async () => {
  const { projectId, revisionId } = await freshProject(A, clientA);
  // a second mutable revision of the same project is refused
  await assert.rejects(
    tx(app, as(A), async (c) => {
      const second = ids.next();
      await c.query("INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, created_at, updated_at) VALUES ($1, $2, $3, now(), now())", [second, A.agencyId, projectId]);
      await event(c, { aggregateKind: "dataset_revision", aggregateId: second, aggregateVersion: 1, agencyId: A.agencyId, eventType: "dataset_revision.created.v1", actorUserId: owner.userId });
    }),
    refusedWith("23505", "dataset_revisions_one_mutable_per_project"),
  );
  // an INSPECTING revision accepts no new upload
  await tx(app, as(A), async (c) => {
    await c.query("UPDATE kauro.dataset_revisions SET state = 'UPLOADING', version = 2 WHERE revision_id = $1", [revisionId]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "dataset_revision.uploading.v1", actorUserId: owner.userId });
    await c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', version = 3 WHERE revision_id = $1", [revisionId]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 3, agencyId: A.agencyId, eventType: "dataset_revision.inspecting.v1", actorUserId: owner.userId });
  });
  await assert.rejects(tx(app, as(A), (c) => reserveIn(c, A, projectId, revisionId, 10)), refusedWith("KA011"));
  // a name carrying a filename, or another agency's id, is not an object name of this agency
  for (const name of [`quarantine/${A.agencyId}/contacts.csv`, `quarantine/${B.agencyId}/${projectId}/${revisionId}`, `accepted/${A.agencyId}/${projectId}`]) {
    await assert.rejects(
      tx(app, as(A), (c) =>
        c.query(
          `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, zone, data_class, provider, location_ref, object_name, state, created_by_kind, created_by_ref, created_at, updated_at)
           VALUES ($1, $2, $3, 'QUARANTINE', 'RAW', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $4, 'INTENDED', 'MEMBERSHIP', $5, now(), now())`,
          [ids.next(), A.agencyId, projectId, name, A.ownerMembershipId],
        ),
      ),
      refusedWith("23514"),
      name,
    );
  }
});

test("entering READY_TO_SEAL or SEALED without the facts the registry guard names is refused; retention anchors happen once", async () => {
  const { projectId, revisionId } = await freshProject(B, clientB);
  await tx(app, as(B), async (c) => {
    await c.query("UPDATE kauro.dataset_revisions SET state = 'UPLOADING', version = 2 WHERE revision_id = $1", [revisionId]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 2, agencyId: B.agencyId, eventType: "dataset_revision.uploading.v1", actorUserId: B.ownerUserId });
    await c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', version = 3 WHERE revision_id = $1", [revisionId]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 3, agencyId: B.agencyId, eventType: "dataset_revision.inspecting.v1", actorUserId: B.ownerUserId });
  });
  // READY_TO_SEAL without a complete evaluation of the current selection is refused by the lifecycle guard (and the CHECK behind it)
  await assert.rejects(
    tx(app, as(B), async (c) => {
      await c.query("UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = 4 WHERE revision_id = $1", [revisionId]);
    }),
    refusedWith("KA011"),
  );
  // CANCELLED records when and why
  await assert.rejects(
    tx(app, as(B), async (c) => {
      await c.query("UPDATE kauro.dataset_revisions SET state = 'CANCELLED', version = 4 WHERE revision_id = $1", [revisionId]);
    }),
    refusedWith("KA011"),
  );
  await tx(app, as(B), async (c) => {
    await c.query("UPDATE kauro.dataset_revisions SET state = 'CANCELLED', version = 4, cancelled_at = now(), terminal_reason = 'REPLACED_BY_NEW_REVISION' WHERE revision_id = $1", [revisionId]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: 4, agencyId: B.agencyId, eventType: "dataset_revision.cancelled.v1", actorUserId: B.ownerUserId });
    const anchor = { id: ids.next(), hash: sha("cancel-anchor-" + revisionId) };
    await c.query(
      "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, 'INTAKE_CANCELLED', now(), $5, now())",
      [anchor.id, B.agencyId, projectId, revisionId, anchor.hash],
    );
  });
  // a retry cannot produce a later anchor of the same kind for the same subject
  await assert.rejects(
    tx(app, as(B), (c) =>
      c.query(
        "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, 'INTAKE_CANCELLED', now() + interval '1 day', $5, now())",
        [ids.next(), B.agencyId, projectId, revisionId, sha("retry-anchor")],
      ),
    ),
    refusedWith("23505", "retention_anchors_once_per_revision"),
  );
});
