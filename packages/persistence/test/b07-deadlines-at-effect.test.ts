// CLOCK-SWEEP-B07 lane L2 (docs/design/B07-clock-sweep-plan.md sec. 4 and 6, CS-7/CS-8): the database judges the upload acceptance
// edge (0009:528) and the closed window of the sealed bytes (0011:565, at the deferred COMMIT) at kauro.effect_now(), the server's
// instant of the effect statement, never at the transaction's start; the EXPIRED edge stays on the transaction time (CHECK 0009:464).
// Direct SQL on the runtime login roles (kauro_app_test as the request handler, kauro_control_test as the control plane bound to one
// agency); the superuser is the oracle only.
//
// The crossing is deterministic, never a race against real time: inside the transaction the test first sleeps 5 ms (pg_sleep), then
// positions the TEST CLOCK so that kauro.server_now() is the deadline minus 1 ms. kauro.effect_now() is server_now plus the time the
// transaction has run (0038), at least the 5 ms already slept, so every later statement (and COMMIT) is past the deadline while the
// transaction's own instant precedes it. Each cell asserts both facts on the same connection before the effect. The OK controls place
// server_now 60 s before the deadline without sleeping, so effect_now stays before it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import {
  admitSourceFile,
  appendFixtureEvent,
  countSourceSelection,
  fixtureSelection,
  readySourceRevision,
  sealReadyRevision,
  sealedManifestOf,
  startTemporaryPostgres,
  TEST_CLOCK_OFFSET_SETTING,
  type AdmittedSourceFixture,
  type ReadySourceFixture,
  type SourceFixtureScope,
  type SourceFixtureSessions,
  type TemporaryPostgres,
} from "../src/testing/index.js";
import { agency, endClient, event, ids, offeredCapability, person, processingAuthority, project, sha, tx, type AgencyFixture, type Context } from "./support.js";

let pg: TemporaryPostgres;
let su: Client;
let app: Client;
let control: Client;
let capabilityId: string;

before(async () => {
  pg = await startTemporaryPostgres();
  su = await pg.connect("postgres");
  app = await pg.connect("kauro_app_test");
  control = await pg.connect("kauro_control_test");
  capabilityId = await offeredCapability(control, "CLEAN");
});

after(async () => {
  await control.end();
  await app.end();
  await su.end();
  await pg.stop();
});

const DAY_MS = 86_400_000;

interface Tenant {
  readonly ag: AgencyFixture;
  readonly clientId: string;
}

let tenants = 0;
async function tenant(label: string): Promise<Tenant> {
  const owner = await person(app, `b07-cs-${label}-${++tenants}`);
  const ag = await agency(app, owner, `Agency ${label}`);
  const clientId = await endClient(app, ag, await processingAuthority(app, ag));
  return { ag, clientId };
}

const as = (t: Tenant): Context => ({ agencyId: t.ag.agencyId, userId: t.ag.ownerUserId });

/** A SYSTEM unit of work of the control plane bound to one agency. */
async function controlTx<T>(agencyId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  await control.query("BEGIN");
  try {
    await control.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [agencyId]);
    const out = await fn(control);
    await control.query("COMMIT");
    return out;
  } catch (e) {
    await control.query("ROLLBACK");
    throw e;
  }
}

function sessionsOf(t: Tenant): SourceFixtureSessions {
  return { app: (fn) => tx(app, as(t), fn), control: (fn) => controlTx(t.ag.agencyId, fn) };
}

function scopeOf(t: Tenant, projectId: string): SourceFixtureScope {
  return { agencyId: t.ag.agencyId, projectId, ownerUserId: t.ag.ownerUserId, ownerMembershipId: t.ag.ownerMembershipId };
}

function refusedWith(sqlState: string): (e: unknown) => boolean {
  return (e) => {
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
    assert.equal(code, sqlState, e instanceof Error ? e.message : String(e));
    return true;
  };
}

async function oracleRow<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await su.query<T>(sql, params);
  assert.equal(r.rows.length, 1, sql);
  return r.rows[0] as T;
}

/** Where this transaction stands against `deadline`: its own instant (server_now) and the instant of this statement (effect_now). */
interface ClockFacts {
  readonly serverBefore: boolean;
  readonly effectPast: boolean;
}

/**
 * Positions the TEST CLOCK of the open transaction against `deadline` (an exact timestamptz text). CROSSING: 5 ms slept first, then
 * server_now = deadline - 1 ms, so effect_now is past the deadline from the next statement on. BEFORE: server_now = deadline - 60 s,
 * nothing slept. Returns the facts read right after, on this connection.
 */
async function place(c: Client, deadline: string, mode: "CROSSING" | "BEFORE"): Promise<ClockFacts> {
  if (mode === "CROSSING") await c.query("SELECT pg_sleep(0.005)");
  const lead = mode === "CROSSING" ? "1 millisecond" : "60 seconds";
  await c.query(`SELECT set_config($1, extract(epoch FROM ($2::timestamptz - interval '${lead}' - transaction_timestamp()))::text, true)`, [TEST_CLOCK_OFFSET_SETTING, deadline]);
  const r = await c.query<{ server_before: boolean; effect_past: boolean }>("SELECT kauro.server_now() < $1::timestamptz AS server_before, kauro.effect_now() >= $1::timestamptz AS effect_past", [deadline]);
  return { serverBefore: r.rows[0]!.server_before, effectPast: r.rows[0]!.effect_past };
}

// --- the upload window (0009:528 acceptance edge, 0009:531 EXPIRED edge) ------------------------------------------------------------

interface Uploading {
  readonly uploadId: string;
  readonly revisionId: string;
  readonly deadline: string;
}

/** CMD013 phases 1 and 2 on the real clock: a RESERVED upload with its anchor (DRAFT -> UPLOADING), then its session issued (v2). */
async function uploading(t: Tenant): Promise<Uploading> {
  const p = await project(app, t.ag, t.clientId, capabilityId);
  const uploadId = ids.next();
  const objectId = ids.next();
  await tx(app, as(t), async (c) => {
    await c.query(
      `INSERT INTO kauro.stored_objects (object_id, agency_id, project_id, revision_id, upload_id, zone, data_class, provider, location_ref, object_name, created_by_kind, created_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'QUARANTINE', 'RAW', 'contract-fake-storage', 'QUARANTINE_PRIMARY', $6, 'MEMBERSHIP', $7, kauro.server_now(), now())`,
      [objectId, t.ag.agencyId, p.projectId, p.revisionId, uploadId, `quarantine/${t.ag.agencyId}/${p.projectId}/${p.revisionId}/${uploadId}`, t.ag.ownerMembershipId],
    );
    await c.query(
      `INSERT INTO kauro.upload_sessions (upload_id, agency_id, project_id, revision_id, display_name, declared_format, reserved_bytes, quarantine_object_id, requested_by_membership_id, requested_by_user_id, application_expires_at, session_attempt, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'contacts export.csv', 'CSV', 10, $5, $6, $7, kauro.server_now() + interval '86400 seconds', 1, kauro.server_now(), now())`,
      [uploadId, t.ag.agencyId, p.projectId, p.revisionId, objectId, t.ag.ownerMembershipId, t.ag.ownerUserId],
    );
    await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "upload_session.reserved.v1", actorUserId: t.ag.ownerUserId, payload: { uploadId, reservedBytes: 10 } });
    await c.query(
      `INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, 'UPLOAD_INITIATED', kauro.server_now(), $6, now())`,
      [ids.next(), t.ag.agencyId, p.projectId, p.revisionId, uploadId, sha("anchor-" + uploadId)],
    );
    const r = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'UPLOADING', version = version + 1 WHERE revision_id = $1 AND state = 'DRAFT' RETURNING version::text", [p.revisionId]);
    assert.equal(r.rowCount, 1);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: p.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.uploading.v1", actorUserId: t.ag.ownerUserId, payload: { revisionId: p.revisionId, firstUploadId: uploadId } });
  });
  await tx(app, as(t), async (c) => {
    const r = await c.query(
      "UPDATE kauro.upload_sessions SET state = 'UPLOADING', version = 2, session_issued_at = kauro.server_now(), provider_session_digest = $2, provider_session_expires_at = kauro.server_now() + interval '7 days' WHERE upload_id = $1 AND version = 1",
      [uploadId, sha("session-" + uploadId)],
    );
    assert.equal(r.rowCount, 1);
    await event(c, { aggregateKind: "upload_session", aggregateId: uploadId, aggregateVersion: 2, agencyId: t.ag.agencyId, eventType: "upload_session.session_issued.v1", actorUserId: t.ag.ownerUserId });
  });
  const { deadline } = await oracleRow<{ deadline: string }>("SELECT application_expires_at::text AS deadline FROM kauro.upload_sessions WHERE upload_id = $1", [uploadId]);
  return { uploadId, revisionId: p.revisionId, deadline };
}

/** CMD014's completion claim (UPLOADING -> VERIFYING, v3) in a request transaction positioned by `mode` against the deadline. */
async function reportCompletion(t: Tenant, up: Uploading, mode: "CROSSING" | "BEFORE"): Promise<{ facts: ClockFacts | null; outcome: Promise<void> }> {
  let facts: ClockFacts | null = null;
  const outcome = tx(app, as(t), async (c) => {
    facts = await place(c, up.deadline, mode);
    await c.query(
      "UPDATE kauro.upload_sessions SET state = 'VERIFYING', version = 3, completion_reported_at = kauro.server_now(), completion_claim_digest = $2, claimed_generation = '1700000000000001', claimed_bytes = 10 WHERE upload_id = $1 AND version = 2",
      [up.uploadId, sha("claim-" + up.uploadId)],
    );
    await event(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 3, agencyId: t.ag.agencyId, eventType: "upload_session.completion_reported.v1", actorUserId: t.ag.ownerUserId, payload: { uploadId: up.uploadId } });
  });
  await outcome.catch(() => undefined);
  return { facts, outcome };
}

/** The upload-deadlines sweeper's reservation_expired edge (UPLOADING -> EXPIRED, v3) in a control transaction. */
async function expire(t: Tenant, up: Uploading, position: (c: Client) => Promise<ClockFacts | null>): Promise<{ facts: ClockFacts | null; outcome: Promise<void> }> {
  let facts: ClockFacts | null = null;
  const outcome = controlTx(t.ag.agencyId, async (c) => {
    facts = await position(c);
    await c.query(
      `UPDATE kauro.upload_sessions SET state = 'EXPIRED', version = 3, expired_at = kauro.server_now(), terminal_reason = 'RESERVATION_EXPIRED', provider_cancellation_state = 'REQUESTED', provider_cancellation_at = kauro.server_now()
        WHERE upload_id = $1 AND version = 2`,
      [up.uploadId],
    );
    await appendFixtureEvent(c, { aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: 3, agencyId: t.ag.agencyId, eventType: "upload_session.expired.v1", actorUserId: null, payload: { uploadId: up.uploadId } });
  });
  await outcome.catch(() => undefined);
  return { facts, outcome };
}

async function uploadState(uploadId: string): Promise<{ state: string; version: string }> {
  return oracleRow("SELECT state, version::text FROM kauro.upload_sessions WHERE upload_id = $1", [uploadId]);
}

test("CS-7 DENY: UPLOADING -> VERIFYING in a transaction whose server_now precedes the deadline and whose effect_now is past it -> KA072, nothing commits", async () => {
  const t = await tenant("cs7");
  const up = await uploading(t);
  const { facts, outcome } = await reportCompletion(t, up, "CROSSING");
  assert.deepEqual(facts, { serverBefore: true, effectPast: true }, "the transaction's own instant precedes the deadline, the effect instant is past it");
  await assert.rejects(outcome, refusedWith("KA072"));
  assert.deepEqual(await uploadState(up.uploadId), { state: "UPLOADING", version: "2" });
});

test("CS-7-OK: UPLOADING -> VERIFYING whose effect_now is before the deadline -> applied", async () => {
  const t = await tenant("cs7ok");
  const up = await uploading(t);
  const { facts, outcome } = await reportCompletion(t, up, "BEFORE");
  assert.deepEqual(facts, { serverBefore: true, effectPast: false });
  await outcome;
  assert.deepEqual(await uploadState(up.uploadId), { state: "VERIFYING", version: "3" });
});

test("CS-7 EXPIRED edge unchanged: refused while server_now < deadline even when effect_now is past it; applied once server_now reaches it", async () => {
  const t = await tenant("cs7exp");
  const up = await uploading(t);
  const early = await expire(t, up, (c) => place(c, up.deadline, "CROSSING"));
  assert.deepEqual(early.facts, { serverBefore: true, effectPast: true });
  await assert.rejects(early.outcome, refusedWith("KA072"));
  assert.deepEqual(await uploadState(up.uploadId), { state: "UPLOADING", version: "2" });
  // the positive control: the transaction's own instant 1 ms past the deadline
  const due = await expire(t, up, async (c) => {
    await c.query(`SELECT set_config($1, extract(epoch FROM ($2::timestamptz + interval '1 millisecond' - transaction_timestamp()))::text, true)`, [TEST_CLOCK_OFFSET_SETTING, up.deadline]);
    return null;
  });
  await due.outcome;
  assert.deepEqual(await uploadState(up.uploadId), { state: "EXPIRED", version: "3" });
});

// --- the closed window of the sealed bytes (0011:565, at COMMIT) -----------------------------------------------------------------------

interface ReuseFixture {
  readonly projectId: string;
  readonly ready: ReadySourceFixture;
  readonly firstSealAnchorId: string;
  /** The first seal of the bytes + 14 days, exact (timestamptz text). */
  readonly windowEnd: string;
}

/**
 * A revision R1 that sealed file F about fourteen days ago (on the test clock) and its successor R2 that reuses F, READY_TO_SEAL:
 * R2's seal is governed by F's first seal (R1's), whose fourteen days end shortly after now.
 */
async function reuseOfAlmostClosedBytes(t: Tenant, label: string): Promise<ReuseFixture> {
  const p = await project(app, t.ag, t.clientId, capabilityId);
  const scope = scopeOf(t, p.projectId);
  const admitted: AdmittedSourceFixture = await admitSourceFile(sessionsOf(t), scope, { seed: `cs8-${label}`, base: new Date(Date.now() - 14 * DAY_MS + 3_600_000) });
  const r1 = await sealReadyRevision(sessionsOf(t), scope, await readySourceRevision(sessionsOf(t), scope, admitted));
  // CMD012's shape: a successor DRAFT naming the sealed predecessor, the predecessor SUPERSEDED, the project pointer moved
  const successor = await tx(app, as(t), async (c) => {
    const id = ids.next();
    await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [r1.revisionId]);
    await c.query("INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, supersedes_revision_id, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, now(), now())", [id, t.ag.agencyId, p.projectId, r1.revisionId, t.ag.ownerMembershipId]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: id, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "dataset_revision.created.v1", actorUserId: t.ag.ownerUserId });
    const v = await c.query<{ version: string }>("UPDATE kauro.dataset_revisions SET state = 'SUPERSEDED', superseded_by_revision_id = $2, superseded_at = kauro.server_now(), version = version + 1 WHERE revision_id = $1 RETURNING version::text", [r1.revisionId, id]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: r1.revisionId, aggregateVersion: Number(v.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.superseded.v1", actorUserId: t.ag.ownerUserId });
    const pv = await c.query<{ version: string }>("UPDATE kauro.projects SET current_revision_id = $2, version = version + 1 WHERE project_id = $1 RETURNING version::text", [p.projectId, id]);
    await event(c, { aggregateKind: "project", aggregateId: p.projectId, aggregateVersion: Number(pv.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "project.current_revision_changed.v1", actorUserId: t.ag.ownerUserId });
    return id;
  });
  // the successor's selection reuses F (previously_admitted_inputs_selected), is evaluated, READY_TO_SEAL
  const selection = fixtureSelection(successor, { fileId: admitted.fileId, tableId: admitted.tableId, structureHash: admitted.structureHash, origin: "REUSED" }, sha("reuse-inventory-" + successor));
  const selectionManifestId = ids.next();
  const selectionHash = sha("reuse-selection-" + successor);
  await tx(app, as(t), async (c) => {
    await c.query(
      "INSERT INTO kauro.selection_manifests (selection_manifest_id, agency_id, project_id, revision_id, schema_version, body, body_hash, created_by_membership_id, created_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now())",
      [selectionManifestId, t.ag.agencyId, p.projectId, successor, JSON.stringify(selection), selectionHash, t.ag.ownerMembershipId],
    );
    await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [successor]);
    await c.query("UPDATE kauro.dataset_revisions SET state = 'INSPECTING', selection_manifest_id = $2, selection_hash = $3, inventory_hash = $4, selected_at = kauro.server_now(), version = 2 WHERE revision_id = $1 AND version = 1", [successor, selectionManifestId, selectionHash, selection.inventoryHash]);
    await event(c, { aggregateKind: "dataset_revision", aggregateId: successor, aggregateVersion: 2, agencyId: t.ag.agencyId, eventType: "dataset_revision.selection_changed.v1", actorUserId: t.ag.ownerUserId });
  });
  const bound = { ...admitted, revisionId: successor, clientId: t.clientId, revisionVersion: 2, quarantineObjectId: "", acceptedObjectId: "", selection, selectionManifestId, selectionHash, inventoryHash: selection.inventoryHash };
  const counted = await controlTx(t.ag.agencyId, async (c) => {
    const e = await countSourceSelection(c, scope, bound);
    await c.query(
      "UPDATE kauro.dataset_revisions SET state = 'READY_TO_SEAL', version = 3, evaluation_id = $2, evaluation_hash = $3, physical_source_rows = 120, logical_source_records = 120, billable_source_units = 120, association_edges = 0 WHERE revision_id = $1 AND version = 2",
      [successor, e.evaluationId, e.evaluationHash],
    );
    await appendFixtureEvent(c, { aggregateKind: "dataset_revision", aggregateId: successor, aggregateVersion: 3, agencyId: t.ag.agencyId, eventType: "dataset_revision.ready_to_seal.v1", actorUserId: null, payload: { revisionId: successor } });
    return e;
  });
  const first = await oracleRow<{ anchor_id: string; window_end: string }>(
    "SELECT anchor_id, (occurred_at + interval '1209600 seconds')::text AS window_end FROM kauro.retention_anchors WHERE revision_id = $1 AND anchor_kind = 'REVISION_SEALED'",
    [r1.revisionId],
  );
  return { projectId: p.projectId, ready: { ...bound, ...counted, revisionVersion: 3 }, firstSealAnchorId: first.anchor_id, windowEnd: first.window_end };
}

/** CMD017 for the successor (its UNPAID record anchored on the bytes' first seal) in a request transaction positioned by `mode`. */
async function sealReuse(t: Tenant, f: ReuseFixture, mode: "CROSSING" | "BEFORE"): Promise<{ facts: ClockFacts | null; outcome: Promise<void> }> {
  let facts: ClockFacts | null = null;
  const { ready } = f;
  const outcome = tx(app, as(t), async (c) => {
    facts = await place(c, f.windowEnd, mode);
    const documents = sealedManifestOf(scopeOf(t, f.projectId), ready, ids.next());
    await c.query("SELECT 1 FROM kauro.dataset_revisions WHERE revision_id = $1 FOR NO KEY UPDATE", [ready.revisionId]);
    await c.query(
      `INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, subject_hash, canonical_version, manifest, subject, sealed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, kauro.server_now())`,
      [ready.revisionId, t.ag.agencyId, f.projectId, documents.manifestHash, documents.projectionHash, ready.selectionHash, ready.evaluationHash, documents.subjectHash, JSON.stringify(documents.manifest), JSON.stringify(documents.subject)],
    );
    await c.query("INSERT INTO kauro.sealed_revision_files (revision_id, file_id, agency_id, project_id, ordinal, disposition, provider_generation, sha256, bytes) VALUES ($1, $2, $3, $4, 0, 'INCLUDED', $5, $6, $7)", [ready.revisionId, ready.fileId, t.ag.agencyId, f.projectId, ready.acceptedGeneration, ready.sha256, ready.bytes]);
    await c.query("INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, anchor_kind, occurred_at, evidence_hash, created_at) VALUES ($1, $2, $3, $4, 'REVISION_SEALED', kauro.server_now(), $5, now())", [ids.next(), t.ag.agencyId, f.projectId, ready.revisionId, sha("seal-" + ready.revisionId)]);
    const retentionId = ids.next();
    await c.query(
      `INSERT INTO kauro.retention_records (retention_id, agency_id, client_id, project_id, revision_id, class, anchor_id, anchor_evidence_hash, hard_deadline, effective_deadline, policy_version, created_at, updated_at)
       SELECT $1, $2, $3, $4, $5, 'UNPAID', a.anchor_id, a.evidence_hash, a.occurred_at + interval '1209600 seconds', a.occurred_at + interval '1209600 seconds', 'R2-RETENTION-1', now(), now() FROM kauro.retention_anchors a WHERE a.anchor_id = $6`,
      [retentionId, t.ag.agencyId, t.clientId, f.projectId, ready.revisionId, f.firstSealAnchorId],
    );
    await event(c, { aggregateKind: "retention_record", aggregateId: retentionId, aggregateVersion: 1, agencyId: t.ag.agencyId, eventType: "retention_record.created.v1", actorUserId: t.ag.ownerUserId });
    const r = await c.query<{ version: string }>(
      "UPDATE kauro.dataset_revisions SET state = 'SEALED', manifest_hash = $2, projection_hash = $3, sealed_at = kauro.server_now(), sealed_file_count = 1, sealed_bytes = $4, version = version + 1 WHERE revision_id = $1 RETURNING version::text",
      [ready.revisionId, documents.manifestHash, documents.projectionHash, ready.bytes],
    );
    await event(c, { aggregateKind: "dataset_revision", aggregateId: ready.revisionId, aggregateVersion: Number(r.rows[0]!.version), agencyId: t.ag.agencyId, eventType: "dataset_revision.sealed.v1", actorUserId: t.ag.ownerUserId });
  });
  await outcome.catch(() => undefined);
  return { facts, outcome };
}

async function revisionState(revisionId: string): Promise<{ state: string; manifests: number }> {
  return oracleRow(
    "SELECT r.state, (SELECT count(*)::int FROM kauro.sealed_manifests m WHERE m.revision_id = r.revision_id) AS manifests FROM kauro.dataset_revisions r WHERE r.revision_id = $1",
    [revisionId],
  );
}

test("CS-8 DENY: a seal whose sealed_at precedes first_seal + 14 d and whose COMMIT effect_now is past it -> KA072 at COMMIT, nothing commits", async () => {
  const t = await tenant("cs8");
  const f = await reuseOfAlmostClosedBytes(t, "deny");
  const { facts, outcome } = await sealReuse(t, f, "CROSSING");
  assert.deepEqual(facts, { serverBefore: true, effectPast: true }, "the seal instant precedes the end of the bytes' window, the COMMIT instant is past it");
  await assert.rejects(outcome, refusedWith("KA072"));
  assert.deepEqual(await revisionState(f.ready.revisionId), { state: "READY_TO_SEAL", manifests: 0 });
});

test("CS-8-OK: a seal of reused bytes whose COMMIT effect_now is before first_seal + 14 d -> commits", async () => {
  const t = await tenant("cs8ok");
  const f = await reuseOfAlmostClosedBytes(t, "ok");
  const { facts, outcome } = await sealReuse(t, f, "BEFORE");
  assert.deepEqual(facts, { serverBefore: true, effectPast: false });
  await outcome;
  assert.deepEqual(await revisionState(f.ready.revisionId), { state: "SEALED", manifests: 1 });
});
