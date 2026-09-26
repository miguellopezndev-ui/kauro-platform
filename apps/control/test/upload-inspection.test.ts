// UPLOAD_INSPECTION and SELECTION_EVALUATION end to end (docs/design/B07-upload-source-lifecycle.md §12.1, §12.2; mandate
// B07-CONTROL; cases CMD014-OK, S053, S024 of docs/design/B07-case-map.md) on a real PostgreSQL 17: the completion report the request
// handlers recorded reaches the control plane through the outbox, and the package's dispatcher runs the consumers in SYSTEM units of
// work bound to the event's agency (kauro_control_test), revision row first. The platform's parsers are real (the container inspector
// and the selection evaluator of @kauro/data-plane, isolated); the providers are the labelled contract fakes — CONTRACT FAKES,
// evidence class SIMULATED: object storage (@kauro/application/testing) and the malware scanner (@kauro/data-plane/testing), whose
// scan instant is a reading of the same database clock. The oracle is the superuser. Interleavings are fixed by the storage fake's
// hold points and by lock waits observed in pg_stat_activity, never by time.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CONTRACT_FAKE_STORAGE_PROVIDER, completionRefOf, providerChecksumsOf } from "@kauro/application/testing";
import { FAKE_SCANNER_ENGINE, FAKE_SCANNER_EVIDENCE_CLASS } from "@kauro/data-plane/testing";
import { acceptedObjectName, type CausationId, type CorrelationId, type RetentionAnchorId, type SourceFileId, type SourceTableId } from "@kauro/domain";
import { PgEventPublisher, PgSourceStore } from "@kauro/persistence";
import { waitForLockWait } from "@kauro/persistence/testing";
import { clock, ids, startControlEnv, type ControlEnv } from "./support/env.js";
import { bindSelection, eventsOf, oracle, oracleRows, project, reserve, issue, report, setSessionLimit, tenant, uploadAndReport, uploadThrough, type Tenant } from "./support/fixtures.js";
import { buildCsv, buildWorkbook } from "./support/workbook.js";

let env: ControlEnv;

before(async () => {
  env = await startControlEnv();
  // the location read-back comes first: a deletion is never recorded at a location never read back (D-OBJ-2)
  await env.plane.sweepers.locationPolicy.sweep(env.plane.units, 10);
});

after(async () => {
  await env.stop();
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function inspectAll(): Promise<void> {
  const counts = await env.plane.drain(env.plane.consumers.uploadInspection, clock.now());
  assert.equal(counts.deadLettered, 0, "no inspection is dead-lettered");
  assert.equal(counts.retried, 0, "no inspection needed a retry");
}

function csv(label: string, rows: number): Uint8Array {
  return buildCsv(["Email", "Name"], Array.from({ length: rows }, (_, i) => [`${label}-${i}@example.test`, `${label} ${i}`]));
}

test("OK: UPLOAD_INSPECTION observes, hashes, inspects, scans, promotes and admits the file (source_file.admitted.v1); the revision stays UPLOADING until the agency's selection closes the intake", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "ok");
  const p = await project(env, t);
  const content = csv("ok", 3);
  const { up, generation } = await uploadAndReport(env, t, p, content, "CSV");
  const verifying = await oracle<{ state: string; observed_generation: string | null }>(env, "SELECT state, observed_generation FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]);
  assert.deepEqual([verifying.state, verifying.observed_generation], ["VERIFYING", null], "the request recorded a claim; nothing is observed or admitted by it");

  await inspectAll();

  // the upload: observed by the server (set once), admitted under attempt 1 at the server's instants
  const u = await oracle<{ state: string; observed_generation: string; observed_bytes: string; inspection_fence: number; file_id: string; inspection_receipt_hash: string; completion_observed_at: Date; admitted_at: Date; inspection_claimed_at: Date; application_expires_at: Date }>(
    env,
    "SELECT state, observed_generation, observed_bytes::text, inspection_fence, file_id, inspection_receipt_hash, completion_observed_at, admitted_at, inspection_claimed_at, application_expires_at FROM kauro.upload_sessions WHERE upload_id = $1",
    [up.uploadId],
  );
  assert.deepEqual([u.state, u.observed_generation, Number(u.observed_bytes), u.inspection_fence], ["ADMITTED", generation, content.length, 1]);
  assert.ok(u.admitted_at < u.application_expires_at, "admitted before the application deadline");

  // the receipt: this attempt, the recorded observation, the server's SHA-256, complete coverage by the labelled scanner on the
  // database clock inside the attempt (D-INSP-4)
  const r = await oracle<Record<string, unknown>>(
    env,
    `SELECT receipt_hash, outcome, rejection_class, inspection_fence, observed_generation, observed_bytes::text, sha256, claim_consistent, declared_format, detected_format, structure_status, scan_state,
            scanner_engine, scanner_engine_version, signature_version, scanner_exit_code, scanner_verdict, expected_parts, scanned_parts, accepted_generation, accepted_sha256, inspector_version,
            started_at = (SELECT inspection_claimed_at FROM kauro.upload_sessions WHERE upload_id = $1) AS starts_at_claim,
            scanned_at >= (SELECT completion_observed_at FROM kauro.upload_sessions WHERE upload_id = $1) AND scanned_at <= completed_at AS scanned_within_attempt,
            coverage
       FROM kauro.inspection_receipts WHERE upload_id = $1`,
    [up.uploadId],
  );
  assert.equal(r["receipt_hash"], u.inspection_receipt_hash);
  assert.deepEqual(
    [r["outcome"], r["rejection_class"], r["inspection_fence"], r["observed_generation"], Number(r["observed_bytes"]), r["sha256"], r["claim_consistent"], r["declared_format"], r["detected_format"], r["structure_status"], r["scan_state"]],
    ["ADMITTED", null, 1, generation, content.length, sha256(content), true, "CSV", "CSV", "STRUCTURE_VALID", "COVERED_CLEAN"],
  );
  assert.deepEqual([r["scanner_engine"], r["scanner_exit_code"], r["scanner_verdict"], r["inspector_version"]], [FAKE_SCANNER_ENGINE, 0, "CLEAN", "kauro-container-inspector-1.0.0"]);
  assert.match(String(r["scanner_engine_version"]), /^contract-fake-/, "the engine is the labelled fake (SIMULATED)");
  assert.deepEqual([r["starts_at_claim"], r["scanned_within_attempt"]], [true, true]);
  assert.equal((r["coverage"] as Array<{ partKind: string; scannedBytes: number }>)[0]?.scannedBytes, content.length, "the container covered at its observed length");

  // the promotion: the exact generation copied to the accepted zone, re-read to the inspected digest; the file names it
  const file = await oracle<{ file_id: string; state: string; provider_generation: string; sha256: string; bytes: string; accepted_object_id: string; version: string; format: string; scan_state: string }>(
    env,
    "SELECT file_id, state, provider_generation, sha256, bytes::text, accepted_object_id, version::text, format, scan_state FROM kauro.source_files WHERE origin_upload_id = $1",
    [up.uploadId],
  );
  assert.deepEqual([file.file_id, file.state, file.sha256, Number(file.bytes), file.version, file.format, file.scan_state], [u.file_id, "ADMITTED", sha256(content), content.length, "1", "CSV", "COVERED_CLEAN"]);
  assert.deepEqual([r["accepted_generation"], r["accepted_sha256"]], [file.provider_generation, sha256(content)]);
  const acceptedName = acceptedObjectName(t.ag.agencyId, p.projectId, file.file_id as SourceFileId);
  const held = env.storage.generationsOf(env.storage.location("ACCEPTED"), acceptedName);
  assert.deepEqual(held.map((g) => [g.generation, g.sha256, g.origin, g.status]), [[file.provider_generation, sha256(content), "COPY", "LIVE"]], "the provider holds exactly the promoted copy");
  const objects = await oracleRows<{ object_id: string; zone: string; state: string; generation: string; sha256: string | null; data_class: string; late: boolean }>(
    env,
    "SELECT object_id, zone, state, generation, sha256, data_class, late FROM kauro.stored_objects WHERE upload_id = $1 ORDER BY zone",
    [up.uploadId],
  );
  assert.deepEqual(
    objects.map((o) => [o.zone, o.state, o.generation, o.data_class, o.late]),
    [
      ["ACCEPTED", "VERIFIED", file.provider_generation, "RAW", false],
      ["QUARANTINE", "DELETED", generation, "RAW", false],
    ],
    "the accepted generation is verified; the quarantine copy is deleted once the inspection is terminal (09 retention schedule)",
  );
  assert.equal(objects.find((o) => o.zone === "ACCEPTED")?.object_id, file.accepted_object_id);
  assert.equal(env.storage.generationsOf(env.storage.location("QUARANTINE"), up.objectName)[0]?.status, "SOFT_DELETED", "deleted by generation at the provider");

  // the frozen inventory: one CSV table, two positional columns, written with the file
  const tables = await oracleRows<{ table_id: string; kind: string; column_count: number; structure_hash: string; columns: string }>(
    env,
    "SELECT t.table_id, t.kind, t.column_count, t.structure_hash, (SELECT count(*) FROM kauro.source_table_columns c WHERE c.table_id = t.table_id)::text AS columns FROM kauro.source_tables t WHERE t.file_id = $1",
    [file.file_id],
  );
  assert.deepEqual(tables.map((x) => [x.kind, x.column_count, x.columns]), [["CSV_TABLE", 2, "2"]]);

  // the events of the control plane's edges, each as a SERVICE actor; the anchor; the finalized session's bearer record purged
  assert.deepEqual(
    (await eventsOf(env, up.uploadId)).map((e) => [e.event_type, e.actor_kind]),
    [
      ["upload_session.reserved.v1", "USER"],
      ["upload_session.session_issued.v1", "USER"],
      ["upload_session.completion_reported.v1", "USER"],
      ["upload_session.completion_observed.v1", "SERVICE"],
      ["upload_session.admitted.v1", "SERVICE"],
    ],
  );
  assert.deepEqual((await eventsOf(env, file.file_id)).map((e) => [e.event_type, e.actor_kind, e.actor_id]), [["source_file.admitted.v1", "SERVICE", "upload-inspection"]]);
  const anchor = await oracle<{ occurred_at: Date; admitted_at: Date }>(env, "SELECT a.occurred_at, u.admitted_at FROM kauro.retention_anchors a JOIN kauro.upload_sessions u ON u.upload_id = a.upload_id WHERE a.upload_id = $1 AND a.anchor_kind = 'INPUT_ADMITTED'", [up.uploadId]);
  assert.equal(anchor.occurred_at.getTime(), anchor.admitted_at.getTime(), "INPUT_ADMITTED at the admission's server instant");
  assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.upload_session_secrets WHERE upload_id = $1", [up.uploadId])).n, "0");

  // the revision stays UPLOADING (D-INTAKE-1): no observation, inspection outcome or admission closes the intake
  assert.equal((await oracle<{ state: string }>(env, "SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [p.revisionId])).state, "UPLOADING");

  // the agency's selection closes it (all_uploads_completed); SELECTION_EVALUATION then counts it exactly: READY_TO_SEAL
  const table = tables[0];
  assert.ok(table);
  const bound = await bindSelection(env, t, p, { fileId: file.file_id as SourceFileId, tableId: table.table_id as SourceTableId, structureHash: table.structure_hash });
  assert.equal((await oracle<{ state: string }>(env, "SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [p.revisionId])).state, "INSPECTING");
  const evaluated = await env.plane.drain(env.plane.consumers.selectionEvaluation, clock.now());
  assert.deepEqual([evaluated.delivered, evaluated.retried, evaluated.deadLettered], [1, 0, 0]);
  const ready = await oracle<{ state: string; physical_source_rows: string; logical_source_records: string; billable_source_units: string; association_edges: string; selection_hash: string; result: string; evaluator_version: string }>(
    env,
    `SELECT r.state, r.physical_source_rows::text, r.logical_source_records::text, r.billable_source_units::text, r.association_edges::text, r.selection_hash, e.result, e.evaluator_version
       FROM kauro.dataset_revisions r JOIN kauro.selection_evaluations e ON e.evaluation_id = r.evaluation_id WHERE r.revision_id = $1`,
    [p.revisionId],
  );
  assert.deepEqual(
    [ready.state, ready.physical_source_rows, ready.logical_source_records, ready.billable_source_units, ready.association_edges, ready.selection_hash, ready.result, ready.evaluator_version],
    ["READY_TO_SEAL", "3", "3", "3", "0", bound.selectionHash, "COMPLETE", "kauro-selection-evaluator-1.0.0"],
  );
  assert.deepEqual((await eventsOf(env, p.revisionId)).at(-1)?.event_type, "dataset_revision.ready_to_seal.v1");

  // a second delivery of the same completion finds the upload decided: DONE, nothing moves (at least once, idempotent)
  const replayed = await env.plane.consumers.uploadInspection.inspect({ serviceId: "upload-inspection", agencyId: t.ag.agencyId, correlationId: ids.next() as CorrelationId, causationId: ids.next() as CausationId }, env.plane.units, up.uploadId, up.revisionId);
  assert.deepEqual(replayed, { kind: "DONE" });
  assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.inspection_receipts WHERE upload_id = $1", [up.uploadId])).n, "1");
  assert.deepEqual(readdirSync(join(env.scratch, "work", "inspection")), [], "every inspection attempt removed its own scratch directory");
});

test("S053: a completion claiming another generation, a false size or a false hash is REJECTED CLAIM_MISMATCH on the server's own observation; the true neighbour is admitted at the observed generation", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "s053");
  await setSessionLimit(env, t, 4);
  const p = await project(env, t);
  const other = providerChecksumsOf(new Uint8Array(Buffer.from("bytes the browser never uploaded")));
  const forge: Record<string, (real: { readonly generation: string; readonly completionRef: string }) => string> = {
    generation: (real) => {
      const claim = env.storage.parseCompletionClaim(real.completionRef);
      assert.equal(claim.kind, "CLAIM");
      if (claim.kind !== "CLAIM") throw new Error("unreachable");
      return completionRefOf({ ...claim.claim, generation: String(BigInt(real.generation) + 7n), bytes: claim.claim.bytes ?? 0 });
    },
    size: (real) => {
      const claim = env.storage.parseCompletionClaim(real.completionRef);
      if (claim.kind !== "CLAIM") throw new Error("unreachable");
      return completionRefOf({ ...claim.claim, generation: real.generation, bytes: (claim.claim.bytes ?? 0) + 1 });
    },
    hash: (real) => {
      const claim = env.storage.parseCompletionClaim(real.completionRef);
      if (claim.kind !== "CLAIM") throw new Error("unreachable");
      return completionRefOf({ generation: real.generation, bytes: claim.claim.bytes ?? 0, crc32c: other.crc32c, md5: other.md5 });
    },
  };
  const forged = new Map<string, { readonly uploadId: string; readonly generation: string; readonly bytes: number; readonly claimed: string }>();
  for (const [kind, lie] of Object.entries(forge)) {
    const content = csv(`s053-${kind}`, 2);
    const { up, generation } = await uploadAndReport(env, t, p, content, "CSV", { completionRef: (real) => lie(real) });
    const claimed = await oracle<{ claimed_generation: string; claimed_bytes: string }>(env, "SELECT claimed_generation, claimed_bytes::text FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]);
    forged.set(kind, { uploadId: up.uploadId, generation, bytes: content.length, claimed: claimed.claimed_generation });
  }
  const trueContent = csv("s053-true", 2);
  const neighbour = await uploadAndReport(env, t, p, trueContent, "CSV");

  await inspectAll();

  for (const [kind, f] of forged) {
    const u = await oracle<{ state: string; terminal_reason: string; observed_generation: string; observed_bytes: string; file_id: string | null }>(
      env,
      "SELECT state, terminal_reason, observed_generation, observed_bytes::text, file_id FROM kauro.upload_sessions WHERE upload_id = $1",
      [f.uploadId],
    );
    assert.deepEqual([u.state, u.terminal_reason, u.observed_generation, Number(u.observed_bytes), u.file_id], ["REJECTED", "CLAIM_MISMATCH", f.generation, f.bytes, null], `${kind}: rejected on the server's own observation`);
    const receipt = await oracle<{ outcome: string; rejection_class: string; claim_consistent: boolean; observed_generation: string; accepted_generation: string | null; scan_state: string }>(
      env,
      "SELECT outcome, rejection_class, claim_consistent, observed_generation, accepted_generation, scan_state FROM kauro.inspection_receipts WHERE upload_id = $1",
      [f.uploadId],
    );
    assert.deepEqual([receipt.outcome, receipt.rejection_class, receipt.claim_consistent, receipt.observed_generation, receipt.accepted_generation, receipt.scan_state], ["REJECTED", "CLAIM_MISMATCH", false, f.generation, null, "NOT_SCANNED"], kind);
    const observed = (await eventsOf(env, f.uploadId)).map((e) => e.event_type);
    assert.deepEqual(observed.slice(-2), ["upload_session.completion_observed.v1", "upload_session.rejected.v1"], kind);
    assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.source_files WHERE origin_upload_id = $1", [f.uploadId])).n, "0", `${kind}: no file`);
    assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.stored_objects WHERE upload_id = $1 AND zone = 'ACCEPTED'", [f.uploadId])).n, "0", `${kind}: nothing promoted`);
  }
  assert.notEqual(forged.get("generation")?.claimed, forged.get("generation")?.generation, "the claimed generation was a lie the observation contradicted");
  const claimedGeneration = forged.get("generation")?.claimed ?? "";
  assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.stored_objects WHERE generation = $1", [claimedGeneration])).n, "0", "the claimed generation is registered nowhere");

  // the true neighbour: admitted at the generation the server observed, promoted to an accepted generation of the same bytes
  const admitted = await oracle<{ state: string; observed_generation: string; provider_generation: string; sha256: string; receipt_observed: string; claim_consistent: boolean }>(
    env,
    `SELECT u.state, u.observed_generation, f.provider_generation, f.sha256, r.observed_generation AS receipt_observed, r.claim_consistent
       FROM kauro.upload_sessions u JOIN kauro.source_files f ON f.file_id = u.file_id JOIN kauro.inspection_receipts r ON r.receipt_hash = u.inspection_receipt_hash
      WHERE u.upload_id = $1`,
    [neighbour.up.uploadId],
  );
  assert.deepEqual([admitted.state, admitted.observed_generation, admitted.receipt_observed, admitted.sha256, admitted.claim_consistent], ["ADMITTED", neighbour.generation, neighbour.generation, sha256(trueContent), true]);
  assert.notEqual(admitted.provider_generation, neighbour.generation, "the file names the accepted copy's own generation, promoted from the observed one");

  // the rejected uploads' quarantined bytes are cleaned by STORAGE_LIFECYCLE (the rejection event's consumer)
  await env.plane.drain(env.plane.consumers.storageLifecycle, clock.now());
  for (const [kind, f] of forged) {
    const q = await oracle<{ state: string; deletion_result: string }>(env, "SELECT state, deletion_result FROM kauro.stored_objects WHERE upload_id = $1 AND zone = 'QUARANTINE'", [f.uploadId]);
    assert.deepEqual([q.state, q.deletion_result], ["DELETED", "DELETED"], `${kind}: the quarantined bytes are deleted by generation`);
  }
  assert.ok(env.storage.calls().every((c) => c.provider === CONTRACT_FAKE_STORAGE_PROVIDER && c.evidenceClass === "SIMULATED"), "every provider call is the labelled fake's");
});

test("S024 end to end: the hostile workbook is REJECTED with its class and no accepted generation, file or table exists", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "s024");
  const p = await project(env, t);
  const rows = [["Email", "Name"], ["a@example.test", "Ana"]];
  const hostile = {
    ACTIVE_CONTENT: buildWorkbook({ sheet: "Contacts", rows, prologue: '<!DOCTYPE worksheet [<!ENTITY boom "boom">]>' }),
    CORRUPT_STRUCTURE: buildWorkbook({ sheet: "Contacts", rows, extra: [{ name: "../../outside.xml", data: "<x/>" }] }),
  } as const;
  const uploads = new Map<string, { readonly uploadId: string; readonly generation: string }>();
  for (const [expected, bytes] of Object.entries(hostile)) {
    const { up, generation } = await uploadAndReport(env, t, p, bytes, "XLSX");
    uploads.set(expected, { uploadId: up.uploadId, generation });
  }
  const scansBefore = env.scanner.calls.length;

  await inspectAll();

  const problemOf: Record<string, string> = { ACTIVE_CONTENT: "XML_DTD", CORRUPT_STRUCTURE: "PATH_TRAVERSAL" };
  for (const [expected, u] of uploads) {
    const upload = await oracle<{ state: string; terminal_reason: string; file_id: string | null }>(env, "SELECT state, terminal_reason, file_id FROM kauro.upload_sessions WHERE upload_id = $1", [u.uploadId]);
    assert.deepEqual([upload.state, upload.terminal_reason, upload.file_id], ["REJECTED", expected, null], expected);
    const receipt = await oracle<{ outcome: string; rejection_class: string; structure_status: string; detected_format: string; scan_state: string; accepted_object_id: string | null; problems: Array<{ code: string }>; observed_generation: string }>(
      env,
      "SELECT outcome, rejection_class, structure_status, detected_format, scan_state, accepted_object_id, problems, observed_generation FROM kauro.inspection_receipts WHERE upload_id = $1",
      [u.uploadId],
    );
    assert.deepEqual([receipt.outcome, receipt.rejection_class, receipt.structure_status, receipt.scan_state, receipt.accepted_object_id, receipt.observed_generation], ["REJECTED", expected, "STRUCTURE_INVALID", "NOT_SCANNED", null, u.generation], expected);
    assert.ok(receipt.problems.some((x) => x.code === problemOf[expected]), `${expected}: the precise problem token ${problemOf[expected] ?? ""} (${JSON.stringify(receipt.problems)})`);
    // no accepted generation, file or table exists for it — in the registry or at the provider
    assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.stored_objects WHERE upload_id = $1 AND zone = 'ACCEPTED'", [u.uploadId])).n, "0");
    assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.source_files WHERE origin_upload_id = $1", [u.uploadId])).n, "0");
    assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.source_tables t JOIN kauro.source_files f ON f.file_id = t.file_id WHERE f.origin_upload_id = $1", [u.uploadId])).n, "0");
    assert.deepEqual((await eventsOf(env, u.uploadId)).map((e) => e.event_type).slice(-1), ["upload_session.rejected.v1"]);
  }
  const listed = await env.storage.list(env.storage.location("ACCEPTED"), `accepted/${t.ag.agencyId}/`);
  assert.deepEqual(listed.objects, [], "the provider holds no accepted copy of a hostile workbook");
  // the preflight refused them before any scan: the scanner never expanded a hostile archive (09: it scans the parts the bounded
  // inspection allowed)
  assert.equal(env.scanner.calls.length, scansBefore);
  assert.equal(FAKE_SCANNER_EVIDENCE_CLASS, "SIMULATED");
  // the revision is untouched by an inspection outcome (D-INTAKE-1)
  assert.equal((await oracle<{ state: string }>(env, "SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [p.revisionId])).state, "UPLOADING");
  assert.deepEqual(readdirSync(join(env.scratch, "work", "inspection")), [], "no attempt left anything in the scratch");
});

test("completion not observed: a report the provider does not hold reopens the session (VERIFYING → UPLOADING with the control plane's negative observation), and the requester's next report is inspected under a new attempt", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "unobserved");
  const p = await project(env, t);
  const content = csv("late", 2);
  const up = await reserve(env, t, p, content.length, "CSV");
  const sessionRef = await issue(env, t, up);
  // the browser reports a completion before the provider holds the object
  await report(env, t, up, completionRefOf({ generation: "1", bytes: content.length }));
  await inspectAll();
  const reopened = await oracle<{ state: string; completion_not_observed_at: Date | null; completion_claim_digest: string | null; inspection_fence: number; observed_generation: string | null }>(
    env,
    "SELECT state, completion_not_observed_at, completion_claim_digest, inspection_fence, observed_generation FROM kauro.upload_sessions WHERE upload_id = $1",
    [up.uploadId],
  );
  assert.deepEqual([reopened.state, reopened.completion_not_observed_at !== null, reopened.completion_claim_digest, reopened.inspection_fence, reopened.observed_generation], ["UPLOADING", true, null, 1, null]);
  assert.equal((await eventsOf(env, up.uploadId)).at(-1)?.event_type, "upload_session.completion_not_observed.v1");
  assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.inspection_receipts WHERE upload_id = $1", [up.uploadId])).n, "0");
  // the session is still usable: the browser completes it and reports again; attempt 2 admits it
  const written = uploadThrough(env, sessionRef, content);
  await report(env, t, up, written.completionRef);
  await inspectAll();
  const admitted = await oracle<{ state: string; inspection_fence: number; observed_generation: string }>(env, "SELECT state, inspection_fence, observed_generation FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]);
  assert.deepEqual([admitted.state, admitted.inspection_fence, admitted.observed_generation], ["ADMITTED", 2, written.generation]);
});

test("D-LOCK-2: a cancellation that holds the revision row makes the inspection's decision wait on it; the attempt then finds the upload CANCELLED, attaches no receipt, admits no file, and its promotion copy is registered RESIDUAL and deleted by generation", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "race");
  const p = await project(env, t);
  const content = csv("race", 2);
  const { up } = await uploadAndReport(env, t, p, content, "CSV");
  // the pipeline stops at its promotion copy (a hold point of the storage fake): observed, inspected and scanned, not yet decided
  const copying = env.storage.holdNext("copy");
  const dispatched = env.plane.drain(env.plane.consumers.uploadInspection, clock.now());
  await copying.reached;
  // the requester's cancellation takes the revision row, then the upload (D-LOCK-1), and holds its transaction open
  const c = await env.h.appPool.raw.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [t.ag.agencyId, t.ag.ownerUserId]);
    const s = new PgSourceStore(c, "REQUEST");
    await s.revisions.lock(up.revisionId);
    const current = await s.uploads.lock(up.uploadId);
    assert.equal(current?.state, "VERIFYING");
    const cancelled = await s.uploads.transition(up.uploadId, current?.version ?? 0, { event: "cancel_upload", byMembershipId: t.ag.ownerMembershipId, reason: "CANCELLED_BY_REQUESTER" });
    assert.equal(cancelled.kind, "APPLIED");
    if (cancelled.kind !== "APPLIED") return;
    await new PgEventPublisher(c, ids, clock).publish({ aggregateKind: "upload_session", aggregateId: up.uploadId, aggregateVersion: cancelled.record.version, agencyId: t.ag.agencyId, eventType: "upload_session.cancelled.v1", actor: { kind: "USER", userId: t.ag.ownerUserId }, causationId: ids.next() as CausationId, correlationId: ids.next() as CorrelationId, payload: { uploadId: up.uploadId, agencyId: t.ag.agencyId, revisionId: up.revisionId, cancelledByMembershipId: t.ag.ownerMembershipId, reasonCode: "CANCELLED_BY_REQUESTER", providerCancellationState: cancelled.record.providerCancellationState } });
    await s.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: t.ag.agencyId, projectId: up.projectId, revisionId: up.revisionId, uploadId: up.uploadId, kind: "INTAKE_CANCELLED", sourceEvidenceHash: null });
    copying.release();
    // the inspection's decision takes the revision row first and waits on the cancellation (never upload-first: no deadlock)
    // (pg_stat_activity keeps the first 1,024 bytes of a statement: the revision read is recognised by its opening columns)
    await waitForLockWait(env.h.oracle, "kauro-test-control", "SELECT revision_id, agency_id, project_id, version::text AS version, state, manifest_hash");
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const counts = await dispatched;
  assert.deepEqual([counts.retried, counts.deadLettered], [0, 0], "the attempt that lost the upload is DONE, not a failure");
  const u = await oracle<{ state: string; inspection_receipt_hash: string | null; file_id: string | null }>(env, "SELECT state, inspection_receipt_hash, file_id FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]);
  assert.deepEqual([u.state, u.inspection_receipt_hash, u.file_id], ["CANCELLED", null, null]);
  assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.inspection_receipts WHERE upload_id = $1", [up.uploadId])).n, "0", "the stale attempt attached no receipt");
  assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.source_files WHERE origin_upload_id = $1", [up.uploadId])).n, "0", "and admitted no file");
  const promoted = await oracle<{ zone: string; state: string; data_class: string; late: boolean; deletion_result: string; generation: string; object_name: string }>(
    env,
    "SELECT zone, state, data_class, late, deletion_result, generation, object_name FROM kauro.stored_objects WHERE upload_id = $1 AND zone = 'ACCEPTED'",
    [up.uploadId],
  );
  assert.deepEqual([promoted.state, promoted.data_class, promoted.late, promoted.deletion_result], ["DELETED", "RESIDUAL", true, "DELETED"], "the promotion copy is a late residual, deleted by generation");
  assert.equal(env.storage.generationsOf(env.storage.location("ACCEPTED"), promoted.object_name).find((g) => g.generation === promoted.generation)?.status, "SOFT_DELETED");
});
