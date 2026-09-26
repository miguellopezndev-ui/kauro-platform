// The B07 migrations (0008..0011) against a real PostgreSQL 17 (07 "Acceptance obligations": real PostgreSQL for tenant
// constraints, transactions, migrations and concurrency). Every write goes through a runtime login role under a bound context —
// kauro_app_test as a request handler, kauro_control_test as the control plane bound to one agency (design D-CTRL-1) — so the
// positive paths prove the policies admit the legitimate lifecycle (21 "Positive and negative symmetry"); the superuser is the
// oracle only. The schema is judged against the registry (enum vocabularies) and the domain (machines, aggregate kinds).
// Interleavings are fixed by lock-wait observation, never by time (21 "Concurrency and crash matrix"). Each case works in an
// agency of its own, so the agency-wide capacity ledger of one case never decides another.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { registryJson } from "@kauro/contracts";
import { AGGREGATE_KINDS, SOURCE_LIFECYCLE_STATE_MACHINES, sourceRevisionManifestHashOf, type SealedManifestDocument } from "@kauro/domain";
import {
  admitSourceFile,
  appendFixtureEvent,
  bindSourceSelection,
  countSourceSelection,
  readySourceRevision,
  sealReadyRevision,
  sealSourceRevision,
  sealStatements,
  startTemporaryPostgres,
  waitForLockWait,
  type SourceFixtureScope,
  type SourceFixtureSessions,
  type TemporaryPostgres,
} from "../src/testing/index.js";
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
 * ReserveUpload's first unit of work as the handler performs it (design §8.2): the quarantine intent, the RESERVED upload holding
 * the issuance fence, its UPLOAD_INITIATED anchor at the creation instant and its event. The revision is not moved.
 */
async function reserveIn(
  c: Client,
  t: Tenant,
  projectId: string,
  revisionId: string,
  bytes: number,
  options: { readonly anchored?: boolean; readonly createdAt?: Date } = {},
): Promise<Reserved> {
  const uploadId = ids.next();
  const objectId = ids.next();
  const createdAt = (options.createdAt ?? new Date()).toISOString();
  await c.query(
    `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RAW', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $6, 'MEMBERSHIP', $7, $8, now())`,
    [objectId, t.ag.agencyId, projectId, revisionId, uploadId, `quarantine/${t.ag.agencyId}/${projectId}/${revisionId}/${uploadId}`, t.ag.ownerMembershipId, createdAt],
  );
  await c.query(
    `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, display_name, declared_format, reserved_bytes, quarantine_object_id, requested_by_membership_id, requested_by_user_id, application_expires_at, session_attempt, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'contacts export.csv', 'CSV', $5, $6, $7, $8, $9::timestamptz + interval '86400 seconds', 1, $9, now())`,
    [uploadId, t.ag.agencyId, projectId, revisionId, bytes, objectId, t.ag.ownerMembershipId, t.ag.ownerUserId, createdAt],
  );
  await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "upload_session.reserved.v1", actorUserId: t.ag.ownerUserId, payload: { uploadId, reservedBytes: bytes } });
  if (options.anchored !== false) {
    await c.query(
      `INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, 'UPLOAD_INITIATED', $6, $7, now())`,
      [ids.next(), t.ag.agencyId, projectId, revisionId, uploadId, createdAt, sha("anchor-" + uploadId)],
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

/** CMD013 phase 2 (request handler): the provider session is issued; RESERVED -> UPLOADING, v2. */
async function issueSession(c: Client, t: Tenant, uploadId: string): Promise<void> {
  await c.query(
    "UPDATE kauro.upload_sessions SET state = 'UPLOADING', version = 2, session_issued_at = now(), provider_session_digest = $2, provider_session_expires_at = now() + interval '7 days' WHERE upload_id = $1 AND version = 1",
    [uploadId, sha("session-" + uploadId)],
  );
  await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 2, agencyId: t.ag.agencyId, eventType: "upload_session.session_issued.v1", actorUserId: t.ag.ownerUserId });
}

/** CMD014 (request handler): the completion claim; UPLOADING -> VERIFYING, v3. Nothing is admitted. */
async function reportCompletion(c: Client, t: Tenant, uploadId: string): Promise<void> {
  await c.query("UPDATE kauro.upload_sessions SET state = 'VERIFYING', version = 3, completion_reported_at = now(), completion_claim_digest = $2 WHERE upload_id = $1 AND version = 2", [uploadId, sha("claim-" + uploadId)]);
  await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 3, agencyId: t.ag.agencyId, eventType: "upload_session.completion_reported.v1", actorUserId: t.ag.ownerUserId });
}

/** UPLOAD_INSPECTION's first step (control plane): the attempt's fence (1), then the provider observation (v4). */
async function claimAndObserve(t: Tenant, uploadId: string, generation: string, bytes: number): Promise<void> {
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query("UPDATE kauro.upload_sessions SET inspection_fence = inspection_fence + 1 WHERE upload_id = $1 AND state = 'VERIFYING'", [uploadId]);
    await c.query("UPDATE kauro.upload_sessions SET version = 4, completion_observed_at = now(), observed_generation = $2, observed_bytes = $3 WHERE upload_id = $1 AND version = 3", [uploadId, generation, bytes]);
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 4, agencyId: t.ag.agencyId, eventType: "upload_session.completion_observed.v1", actorUserId: null, payload: { uploadId, observedBytes: bytes } });
  });
}

interface Verifying extends Reserved {
  readonly projectId: string;
  readonly revisionId: string;
}

/** A fresh project whose revision holds one upload VERIFYING, completion reported and observed (fence 1, v4). */
async function verifyingUpload(t: Tenant, reservedBytes: number, generation: string, observedBytes: number): Promise<Verifying> {
  const { projectId, revisionId } = await freshProject(t);
  const up = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, projectId, revisionId, reservedBytes);
    await toUploading(c, t, revisionId, r.uploadId);
    return r;
  });
  await tx(app, as(t), (c) => issueSession(c, t, up.uploadId));
  await tx(app, as(t), (c) => reportCompletion(c, t, up.uploadId));
  await claimAndObserve(t, up.uploadId, generation, observedBytes);
  return { ...up, projectId, revisionId };
}

/** CMD015 as the handler writes it: the upload tombstoned by its requester (provider cancellation requested once a session exists). */
async function cancelUpload(c: Client, t: Tenant, uploadId: string, version: number, providerSession: boolean, reason = "CANCELLED_BY_REQUESTER"): Promise<void> {
  const r = await c.query(
    `UPDATE kauro.upload_sessions SET state = 'CANCELLED', version = $2, cancelled_at = now(), cancelled_by_membership_id = $3, terminal_reason = $4,
            provider_cancellation_state = CASE WHEN $5::boolean THEN 'REQUESTED' ELSE provider_cancellation_state END,
            provider_cancellation_at = CASE WHEN $5::boolean THEN now() ELSE provider_cancellation_at END
      WHERE upload_id = $1 AND version = $2 - 1`,
    [uploadId, version, t.ag.ownerMembershipId, reason, providerSession],
  );
  assert.equal(r.rowCount, 1);
  await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: version, agencyId: t.ag.agencyId, eventType: "upload_session.cancelled.v1", actorUserId: t.ag.ownerUserId });
}

/** CMD012's cancellation of a mutable revision (request handler). */
async function cancelRevision(c: Client, t: Tenant, revisionId: string, reason = "REPLACED_BY_NEW_REVISION"): Promise<void> {
  const r = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'CANCELLED', cancelled_at = now(), terminal_reason = $2, version = version + 1 WHERE revision_id = $1 RETURNING version::text", [revisionId, reason]);
  assert.equal(r.rowCount, 1);
  await event(c, { aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.cancelled.v1", actorUserId: t.ag.ownerUserId });
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
  "aggregate_kinds", "stored_objects", "storage_location_policies", "revision_quota", "upload_capacity", "upload_sessions", "upload_session_secrets",
  "inspection_receipts", "source_files", "source_tables", "source_table_columns", "selection_manifests", "selection_evaluations", "sealed_manifests",
  "sealed_revision_files", "retention_anchor_kinds", "retention_anchors", "retention_records",
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
  // still no SECURITY DEFINER function anywhere
  const definers = await su.query("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'kauro' AND p.prosecdef");
  assert.deepEqual(definers.rows, []);
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

test("UploadSession, StoredObject, SourceFile and RetentionRecord are seeded exactly as the domain machines, rows are born in their initial state, and every registered aggregate kind equals the domain and is bound", async () => {
  for (const m of SOURCE_LIFECYCLE_STATE_MACHINES) {
    const edges = [...new Set(m.transitions.map((e) => `${e.from}>${e.to}`))].sort();
    const r = await su.query<{ edge: string }>("SELECT from_state || '>' || to_state AS edge FROM kauro.state_transitions WHERE machine = $1 ORDER BY 1", [m.contract]);
    assert.deepEqual(r.rows.map((x) => x.edge), edges, m.contract);
    assert.equal((await oracleRow<{ initial_state: string }>("SELECT initial_state FROM kauro.state_machines WHERE machine = $1", [m.contract])).initial_state, m.initial, m.contract);
  }
  const kinds = await su.query<{ aggregate_kind: string }>("SELECT aggregate_kind FROM kauro.aggregate_kinds ORDER BY 1");
  assert.deepEqual(kinds.rows.map((x) => x.aggregate_kind), [...AGGREGATE_KINDS].sort());
  // the kind is a foreign key to the registry table, not a CHECK list a later package would have to rewrite (D-MIG-1)
  const kindConstraints = await su.query<{ contype: string; conname: string }>(
    `SELECT c.contype, c.conname FROM pg_constraint c WHERE c.conrelid = 'kauro.domain_events'::regclass AND c.contype IN ('c', 'f')
        AND pg_get_constraintdef(c.oid) LIKE '%aggregate_kind%' ORDER BY 2`,
  );
  assert.deepEqual(kindConstraints.rows, [{ contype: "f", conname: "domain_events_aggregate_kind_fkey" }]);
  // every registered kind has an arm in kauro.domain_events_bind_aggregate: an unknown id of it is refused as not an aggregate
  // of the agency (KA006), never as a kind without a binding; an unregistered kind has no arm at all
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
  await assert.rejects(eventOf("quote"), (e: unknown) => {
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
  // the admitted upload holds its observed bytes (not its reservation) and no longer holds a session slot
  assert.deepEqual(await quotaOf(admitted.revisionId), { bytes: String(admitted.bytes), files: 1 });
  assert.deepEqual(await oracleRow("SELECT active_sessions FROM kauro.upload_capacity WHERE agency_id = $1", [t.ag.agencyId]), { active_sessions: 0 });
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
  assert.deepEqual(row, { state: "SEALED", version: "6", sealed_file_count: 1, billable: 120, manifest: true, hard_cap: true });
  // the stored manifest document is the preimage of the manifest hash (KAURO_SOURCE_REVISION_V1) and names no customer text
  const stored = await oracleRow<{ manifest: SealedManifestDocument }>("SELECT manifest FROM kauro.sealed_manifests WHERE revision_id = $1", [sealed.revisionId]);
  assert.equal(sourceRevisionManifestHashOf(stored.manifest), sealed.manifestHash);
  assert.ok(!JSON.stringify(stored.manifest).includes("fixture source"), "a display name never enters the sealed manifest");
  // the sealed subject is frozen: its selection cannot change afterwards (KA004), even for the request handlers that sealed it
  await assert.rejects(tx(app, as(t), (c) => c.query("UPDATE kauro.dataset_revisions SET selection_hash = $2, version = version + 1 WHERE revision_id = $1", [sealed.revisionId, sha("another selection")])), refusedWith("KA004"));
  // no display name reached an event of this lifecycle
  const payloads = await su.query<{ payload: unknown }>("SELECT payload FROM kauro.domain_events WHERE agency_id = $1", [t.ag.agencyId]);
  for (const p of payloads.rows) assert.ok(!JSON.stringify(p.payload).includes("fixture source"), "display names never enter events");
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
    const second = reserveIn(app2, t, projectId, revisionId, 2 * GB);
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
    const racing = reserveIn(app2, t, p3.projectId, p3.revisionId, 10);
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
  await tx(app, as(t), (c) => cancelUpload(c, t, first.uploadId, 2, false));
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
  await tx(app, as(t), (c) => cancelUpload(c, t, up.uploadId, 5, true));
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
    await c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'UNCERTAIN', provider_cancellation_at = now(), version = 6 WHERE upload_id = $1 AND version = 5", [up.uploadId]);
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 6, agencyId: t.ag.agencyId, eventType: "upload_session.provider_cancellation_recorded.v1", actorUserId: null, payload: { uploadId: up.uploadId, providerCancellationState: "UNCERTAIN" } });
  });
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET provider_cancellation_state = 'NOT_REQUESTED', provider_cancellation_at = NULL, version = 7 WHERE upload_id = $1", [up.uploadId])), refusedWith("KA008"));
  // the quota was released once, by the cancellation; nothing of the upload became a file
  assert.deepEqual(await quotaOf(up.revisionId), { bytes: "0", files: 0 });
  assert.deepEqual(await oracleRow("SELECT count(*)::int AS n FROM kauro.source_files WHERE origin_upload_id = $1", [up.uploadId]), { n: 0 });
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

test("S054 at the database: COVERED_CLEAN requires complete coverage by pinned, fresh signatures — a skipped part or byte, a stale or future signature database, or nothing expected is never clean — and admission requires every separate result", async () => {
  const t = await tenant("s054");
  const up = await verifyingUpload(t, 100, "42", 100);
  const receipt = (over: Record<string, unknown>) => {
    const r: Record<string, unknown> = {
      receipt_id: ids.next(), agency_id: t.ag.agencyId, upload_id: up.uploadId, revision_id: up.revisionId, receipt_hash: sha("receipt-" + ids.next()), inspection_fence: 1,
      quarantine_object_id: up.objectId, observed_generation: "42", observed_bytes: 100, sha256: sha("bytes"), completion_claim_digest: sha("claim-" + up.uploadId), claim_consistent: true,
      declared_format: "CSV", detected_format: "CSV", structure_status: "STRUCTURE_INVALID", scan_state: "COVERED_CLEAN", scanner_engine: "contract-fake-scanner",
      scanner_engine_version: "SIMULATED-1", signature_version: "SIG-1", signatures_published_at: new Date(Date.now() - HOUR_MS), signature_max_age_seconds: 86400,
      scanner_config_hash: sha("scanner-config"), scanner_exit_code: 0, scanner_verdict: "CLEAN", scanned_at: new Date(), expected_parts: 1, expected_bytes: 100, scanned_parts: 1,
      scanned_bytes: 100, parser_profile_hash: sha("parser-profile"), inspector_version: "data-plane-0.1.0", outcome: "REJECTED", rejection_class: "CORRUPT_STRUCTURE",
      started_at: new Date(Date.now() - 1_000), completed_at: new Date(), created_at: new Date(),
      ...over,
    };
    const cols = Object.keys(r);
    return controlTx(t.ag.agencyId, (c) => c.query(`INSERT INTO kauro.inspection_receipts (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => r[k])));
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
  await assert.rejects(receipt({ expected_parts: 0, expected_bytes: 0, scanned_parts: 0, scanned_bytes: 0 }), notClean);
  await assert.rejects(receipt({ scanner_config_hash: null }), notClean);
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
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, false, 'CSV', 'NOT_EVALUATED', 'NOT_EVALUATED', 'NOT_SCANNED', 'data-plane-0.1.0', 'REJECTED', 'CLAIM_MISMATCH', now(), now(), now())`;
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
          signatures_published_at, signature_max_age_seconds, scanner_config_hash, scanned_at, expected_parts, expected_bytes, scanned_parts, scanned_bytes, parser_profile_hash,
          inspector_version, outcome, accepted_object_id, accepted_generation, accepted_sha256, started_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, '901', 64, $7, $8, true, 'CSV', 'CSV', 'STRUCTURE_VALID', 'COVERED_CLEAN', 'contract-fake-scanner', 'SIMULATED-1', 'SIG-1',
          now() - interval '1 hour', 86400, $9, now(), 1, 64, 1, 64, $10, 'data-plane-0.1.0', 'ADMITTED', $11, '902', $7, now(), now(), now())`,
      [ids.next(), t.ag.agencyId, up.uploadId, up.revisionId, receiptHash, up.objectId, bytesHash, sha("claim-" + up.uploadId), sha("scanner-config"), sha("parser-profile"), acceptedId],
    );
  });
  const admitFile = (generation: string, digest: string, bytes: number) =>
    controlTx(t.ag.agencyId, async (c) => {
      await c.query(
        `INSERT INTO kauro.source_files (file_id, agency_id, project_id, origin_revision_id, origin_upload_id, accepted_object_id, provider_generation, sha256, bytes, format, scan_state, parser_profile_hash, inspection_receipt_hash, admitted, admitted_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CSV', 'COVERED_CLEAN', $10, $11, true, now(), now(), now())`,
        [fileId, t.ag.agencyId, up.projectId, up.revisionId, up.uploadId, acceptedId, generation, digest, bytes, sha("parser-profile"), receiptHash],
      );
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
    await oracleRow("SELECT f.provider_generation, f.bytes::int AS bytes, u.state, u.reserved_bytes::int AS reserved FROM kauro.source_files f JOIN kauro.upload_sessions u ON u.file_id = f.file_id WHERE f.file_id = $1", [fileId]),
    { provider_generation: "902", bytes: 64, state: "ADMITTED", reserved: 100 },
  );
  // the admitted upload holds its observed bytes, not its reservation
  assert.deepEqual(await quotaOf(up.revisionId), { bytes: "64", files: 1 });
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
  await tx(app, as(t), (c) => cancelUpload(c, t, up.uploadId, 3, true));
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
  // an INSPECTING revision accepts no new upload (KA072)
  const admitted = await admitSourceFile(sessionsOf(t), scopeOf(t, projectId), { seed: "inspecting-accepts-none" });
  assert.equal(admitted.revisionId, revisionId);
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
    const late = reserveIn(app, t, first.projectId, first.revisionId, 10);
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
    await cancelUpload(c, t, upload.uploadId, 2, false, "REVISION_REPLACED");
  });
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.upload_sessions WHERE upload_id = $1", [upload.uploadId]), { state: "CANCELLED" });
});

test("a seal and an intake-expiry revocation of its file are ordered by the file's transition lock: a seal in flight commits and the revocation that waited is refused; a revocation in flight commits and the seal that waited is refused", async () => {
  const t = await tenant("seal-order");
  const revoke = (c: Client, fileId: string) =>
    c.query("UPDATE kauro.source_files SET state = 'ADMISSION_REVOKED', admitted = false, revoked_at = now(), revocation_reason = 'INTAKE_EXPIRED' WHERE file_id = $1", [fileId]);
  // (a) the seal first holds the file's shared transition lock to COMMIT; the sweeper's revocation waits, then sees the seal
  const p1 = await freshProject(t);
  const ready1 = await readySourceRevision(sessionsOf(t), scopeOf(t, p1.projectId), await admitSourceFile(sessionsOf(t), scopeOf(t, p1.projectId), { seed: "seal-first" }));
  await hold(app, as(t));
  try {
    await sealStatements(app, scopeOf(t, p1.projectId), ready1, new Date(ready1.initiatedAt.getTime() + 600_000));
    await hold(control2, { agencyId: t.ag.agencyId });
    const revocation = revoke(control2, ready1.fileId);
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
    await revoke(control2, ready2.fileId);
    await hold(app, as(t));
    const seal = sealStatements(app, scopeOf(t, p2.projectId), ready2, new Date(ready2.initiatedAt.getTime() + 600_000));
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

test("entering a lifecycle state without the facts its registry guard names is refused: INSPECTING before every completion is observed, READY_TO_SEAL without a complete evaluation, REJECTED without a failed one, a selection against another inventory or uploads in flight, SEALED without its manifest or retention record, a closed revision with an upload in flight", async () => {
  const t = await tenant("guards");
  // all_uploads_completed: a reported completion the provider was not yet observed to hold does not move the revision
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
  // READY_TO_SEAL without a complete evaluation of a bound selection (the control plane's own edge still needs its facts)
  await assert.rejects(controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = version + 1 WHERE revision_id = $1", [admitted.revisionId])), refusedWith("KA072"));
  // REJECTED without the failed evaluation of the current selection
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.dataset_revisions SET state = 'REJECTED', rejected_at = now(), terminal_reason = 'SELECTED_INPUT_REJECTED', version = version + 1 WHERE revision_id = $1", [admitted.revisionId])),
    refusedWith("KA072"),
  );
  // CMD016's binding (the manifest intake, then the revision names it); `enter` also moves a DRAFT revision to INSPECTING
  const bindSelection = async (c: Client, projectId: string, revisionId: string, manifestInventory: string, recordedInventory: string, enter: boolean): Promise<void> => {
    const manifestId = ids.next();
    const bodyHash = sha("selection body " + manifestId);
    const body = { schemaVersion: 1, revisionId, inventoryHash: manifestInventory, files: [], tables: [], projections: [], associations: [] };
    await c.query(
      "INSERT INTO kauro.selection_manifests (selection_manifest_id, agency_id, project_id, revision_id, schema_version, body, body_hash, created_by_membership_id, created_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now())",
      [manifestId, t.ag.agencyId, projectId, revisionId, JSON.stringify(body), bodyHash, t.ag.ownerMembershipId],
    );
    await c.query(
      `UPDATE kauro.dataset_revisions SET state = CASE WHEN $5::boolean THEN 'INSPECTING' ELSE state END, selection_manifest_id = $2, selection_hash = $3, inventory_hash = $4, selected_at = now(), version = version + 1
        WHERE revision_id = $1`,
      [revisionId, manifestId, bodyHash, recordedInventory, enter],
    );
  };
  // a selection that does not record the inventory its manifest was made against (D-SEL-3)
  await assert.rejects(tx(app, as(t), (c) => bindSelection(c, p.projectId, admitted.revisionId, sha("inventory"), sha("another inventory"), false)), refusedWith("KA072"));

  // SEALED without its sealed manifest (at COMMIT)
  const ready = await readySourceRevision(sessionsOf(t), scope, admitted);
  await assert.rejects(
    tx(app, as(t), async (c) => {
      const r = await c.query<{ version: string }>(
        "UPDATE kauro.dataset_revisions SET state = 'SEALED', manifest_hash = $2, projection_hash = $3, sealed_at = now(), sealed_file_count = 1, sealed_bytes = $4, version = version + 1 WHERE revision_id = $1 RETURNING version::text",
        [ready.revisionId, sha("unbacked manifest"), sha("unbacked projection"), ready.bytes],
      );
      await event(c, { aggregateKind: "dataset_revision", aggregateId: ready.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.sealed.v1", actorUserId: t.ag.ownerUserId });
    }),
    refusedWith("KA072"),
  );
  // SEALED with its manifest and file set but without the retention record anchored on the seal (at COMMIT)
  await assert.rejects(
    tx(app, as(t), async (c) => {
      const sealedAt = new Date(ready.initiatedAt.getTime() + 600_000);
      await c.query(
        "INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, canonical_version, manifest, sealed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)",
        [ready.revisionId, t.ag.agencyId, p.projectId, sha("manifest without retention"), sha("projection without retention"), ready.selectionHash, ready.evaluationHash, JSON.stringify({ canonicalVersion: 1, revisionId: ready.revisionId }), sealedAt.toISOString()],
      );
      await c.query(
        "INSERT INTO kauro.sealed_revision_files (revision_id, file_id, agency_id, project_id, ordinal, disposition, provider_generation, sha256, bytes) VALUES ($1, $2, $3, $4, 0, 'INCLUDED', $5, $6, $7)",
        [ready.revisionId, ready.fileId, t.ag.agencyId, p.projectId, ready.acceptedGeneration, ready.sha256, ready.bytes],
      );
      const r = await c.query<{ version: string }>(
        "UPDATE kauro.dataset_revisions SET state = 'SEALED', manifest_hash = $2, projection_hash = $3, sealed_at = $4, sealed_file_count = 1, sealed_bytes = $5, version = version + 1 WHERE revision_id = $1 RETURNING version::text",
        [ready.revisionId, sha("manifest without retention"), sha("projection without retention"), sealedAt.toISOString(), ready.bytes],
      );
      await event(c, { aggregateKind: "dataset_revision", aggregateId: ready.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.sealed.v1", actorUserId: t.ag.ownerUserId });
    }),
    refusedWith("KA072"),
  );
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [ready.revisionId]), { state: "READY_TO_SEAL" });

  // a selection bound while an upload is in flight, and a revision closed with an upload in flight
  const r = await freshProject(t);
  const live = await tx(app, as(t), (c) => reserveIn(c, t, r.projectId, r.revisionId, 10));
  await assert.rejects(tx(app, as(t), (c) => bindSelection(c, r.projectId, r.revisionId, sha("inventory"), sha("inventory"), true)), refusedWith("KA072"));
  await assert.rejects(tx(app, as(t), (c) => cancelRevision(c, t, r.revisionId)), refusedWith("KA072"));
  assert.deepEqual(await oracleRow("SELECT state FROM kauro.upload_sessions WHERE upload_id = $1", [live.uploadId]), { state: "RESERVED" });
});

test("no CHECK passes on a missing member: a selection manifest without its revision, inventory or file list, a COMPLETE evaluation without its counts, and a sealed manifest that names no revision are refused", async () => {
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
  // a sealed manifest document that names no revision is refused even inside a seal
  await assert.rejects(
    tx(app, as(t), (c) =>
      c.query(
        "INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, canonical_version, manifest, sealed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, now())",
        [ready.revisionId, t.ag.agencyId, q.projectId, sha("m"), sha("p"), ready.selectionHash, ready.evaluationHash, JSON.stringify({ canonicalVersion: 1 })],
      ),
    ),
    refusedWith("23514", "sealed_manifests_names_revision"),
  );
});

test("retention anchors survive failure: a reservation commits with its initiation anchor or not at all, each anchor is written once per subject, the hard cap never moves, and neither a record nor its revision expires before the governing deadline", async () => {
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
        "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, 'UPLOAD_INITIATED', now() + interval '1 day', $6, now())",
        [ids.next(), t.ag.agencyId, p.projectId, p.revisionId, up.uploadId, sha("retry anchor")],
      ),
    ),
    refusedWith("23505", "retention_anchors_once_per_upload"),
  );
  // the sweeper cannot pre-empt the reservation window: the upload expires no earlier than twenty-four hours after initiation
  await assert.rejects(
    controlTx(t.ag.agencyId, (c) => c.query("UPDATE kauro.upload_sessions SET state = 'EXPIRED', version = 2, expired_at = now(), terminal_reason = 'RESERVATION_EXPIRED' WHERE upload_id = $1", [up.uploadId])),
    refusedWith("23514", "upload_sessions_expiry_not_early"),
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
  // positive neighbour: a revision sealed fifteen days ago expires, its record first (the fixture's retention sweeper)
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
    const v = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'SUPERSEDED', superseded_by_revision_id = $2, superseded_at = now(), version = version + 1 WHERE revision_id = $1 RETURNING version::text", [predecessor.revisionId, successor]);
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
  // initiated twenty-five hours ago: the application deadline passed an hour ago while the provider session stays usable
  const up = await tx(app, as(t), async (c) => {
    const r = await reserveIn(c, t, projectId, revisionId, 100, { createdAt: new Date(Date.now() - 25 * HOUR_MS) });
    await toUploading(c, t, revisionId, r.uploadId);
    return r;
  });
  await tx(app, as(t), (c) => issueSession(c, t, up.uploadId));
  // the sweeper tombstones acceptance, requests the provider cancellation and anchors the expired intake
  await controlTx(t.ag.agencyId, async (c) => {
    await c.query(
      "UPDATE kauro.upload_sessions SET state = 'EXPIRED', version = 3, expired_at = now(), terminal_reason = 'RESERVATION_EXPIRED', provider_cancellation_state = 'REQUESTED', provider_cancellation_at = now() WHERE upload_id = $1 AND version = 2",
      [up.uploadId],
    );
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 3, agencyId: t.ag.agencyId, eventType: "upload_session.expired.v1", actorUserId: null, payload: { uploadId: up.uploadId, previousState: "UPLOADING", reasonCode: "RESERVATION_EXPIRED" } });
    await c.query(
      "INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, $5, 'INTAKE_EXPIRED', now(), $6, now())",
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
  const recordDeletion = (result: string | null, residual: string, basis: string | null = "LOCATION_POLICY") =>
    controlTx(t.ag.agencyId, (c) =>
      c.query(
        `UPDATE kauro.stored_objects SET state = 'DELETED', deleted_at = now(), deletion_result = $2, deletion_attempts = 1, provider_residual_until = ${residual}, provider_residual_basis = $3 WHERE object_id = $1`,
        [up.objectId, result, basis],
      ),
    );
  const sevenDays = "now() + interval '604800 seconds'";
  // no deletion is recorded for a location whose effective retention setting was never read back (D-OBJ-2)
  await assert.rejects(recordDeletion("DELETED", "NULL"), refusedWith("KA072"));
  await controlTx(t.ag.agencyId, (c) =>
    c.query(
      "INSERT INTO kauro.storage_location_policies (observation_id, provider, location_ref, soft_delete_retention_seconds, object_versioning, evidence_hash, evidence_class, observed_at) VALUES ($1, 'contract-fake-storage', 'QUARANTINE_PRIMARY', 604800, false, $2, 'SIMULATED', now())",
      [ids.next(), sha("contract fake retention read-back")],
    ),
  );
  // the read-back says the provider keeps a deleted generation seven days: "vanished" and any other residual are refused
  await assert.rejects(recordDeletion("DELETED", "NULL"), refusedWith("KA072"));
  await assert.rejects(recordDeletion("DELETED", "now() + interval '1 day'"), refusedWith("KA072"));
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
