// AUTHORITY_JOURNAL end to end (docs/design/B07-upload-source-lifecycle.md §12.4; decisions D-RESTORE-1, D-RESTORE-2; mandate
// B07-CONTROL; the gate G-UPLOAD's "restore after deletion" row of docs/design/B07-case-map.md) on a real PostgreSQL 17: every
// terminal authority fact the source lifecycle produces — an upload cancelled, expired or rejected, a revision cancelled, superseded,
// rejected or expired, a file whose admission was revoked — is produced by the path that owns it (the request handlers' writes through
// the persistence adapters, the package's own pipelines and sweepers), reaches the consumer through the outbox and the package's
// dispatcher, and is appended to the external authority journal: the labelled contract fake of @kauro/application/testing — CONTRACT
// FAKE, evidence class SIMULATED — an append-only file outside the database, idempotent by event id and listed in sequence order.
// A forged event whose subject never took the transition it announces is dead-lettered, never tombstoned. The oracle is the superuser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { AUTHORITY_TOMBSTONES, type AuthorityTombstone } from "@kauro/application";
import { CONTRACT_FAKE_JOURNAL_PROVIDER, ContractFakeAuthorityJournal, completionRefOf } from "@kauro/application/testing";
import { authorityTombstoneHashOf, textDigest, type AgencyId, type CorrelationId, type DomainEventRecord, type EventId, type RevisionId, type SourceFileId, type SourceTableId, type SystemContext } from "@kauro/domain";
import { clock, ids, startControlEnv, type ControlEnv } from "./support/env.js";
import { asRequestHandler, bindSelection, cancel, issue, oracle, oracleRows, project, replaceRevision, reserve, sealedRevision, setSessionLimit, tenant, uploadAndReport } from "./support/fixtures.js";
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

function csv(label: string, rows = 2): Uint8Array {
  return buildCsv(["Email", "Name"], Array.from({ length: rows }, (_, i) => [`${label}-${i}@example.test`, `${label} ${i}`]));
}

type RoutedEvent = {
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_id: string;
  readonly sequence: string;
};

test("tombstones of cancelled, expired, rejected and superseded authority and of revoked file admissions are appended once and listed in sequence order, and never for a subject that is not in the tombstone's terminal state", { timeout: 300_000 }, async () => {
  const t = await tenant(env, "journal");
  await setSessionLimit(env, t, 10);
  const agencyId = t.ag.agencyId;

  // an upload EXPIRED by the deadline sweeper (reserved twenty-five hours ago on the test clock)
  const p0 = await project(env, t);
  const expiring = await reserve(env, t, p0, 10, "CSV", new Date(Date.now() - 25 * HOUR_MS));
  assert.equal((await env.plane.sweepers.uploadDeadlines.sweep(env.plane.units, 100)).acted, 1);

  // an upload CANCELLED by its requester (CMD015), one REJECTED by UPLOAD_INSPECTION (a false size), one admitted — and the revision
  // REJECTED by SELECTION_EVALUATION: its selection projects a column it did not select (fatal_input_rejection: no silent removal)
  const p1 = await project(env, t);
  const cancelledUpload = await reserve(env, t, p1, 10, "CSV");
  await issue(env, t, cancelledUpload);
  await cancel(env, t, cancelledUpload);
  const rejectedUpload = await uploadAndReport(env, t, p1, csv("rejected"), "CSV", {
    completionRef: (real) => {
      const parsed = env.storage.parseCompletionClaim(real.completionRef);
      if (parsed.kind !== "CLAIM") throw new Error("unreachable");
      return completionRefOf({ generation: real.generation, bytes: (parsed.claim.bytes ?? 0) + 1 });
    },
  });
  const admittedUpload = await uploadAndReport(env, t, p1, csv("admitted"), "CSV");
  assert.equal((await env.plane.drain(env.plane.consumers.uploadInspection, clock.now())).deadLettered, 0);
  const admitted = await oracle<{ file_id: string; table_id: string; structure_hash: string }>(
    env,
    "SELECT f.file_id, t.table_id, t.structure_hash FROM kauro.source_files f JOIN kauro.source_tables t ON t.file_id = f.file_id WHERE f.origin_upload_id = $1",
    [admittedUpload.up.uploadId],
  );
  await bindSelection(env, t, p1, { fileId: admitted.file_id as SourceFileId, tableId: admitted.table_id as SourceTableId, structureHash: admitted.structure_hash }, (selection) => ({
    ...selection,
    tables: selection.tables.map((table) => ({ ...table, selectedColumns: [0] })),
  }));
  assert.equal((await env.plane.drain(env.plane.consumers.selectionEvaluation, clock.now())).delivered, 1);
  assert.equal((await oracle<{ state: string }>(env, "SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [p1.revisionId])).state, "REJECTED");

  // a mutable revision CANCELLED and a SEALED one SUPERSEDED by CMD012's replacements
  const p2 = await project(env, t);
  await replaceRevision(env, t, p2, p2.revisionId);
  const p3 = await project(env, t);
  const recent = await sealedRevision(env, t, p3, "journal-superseded", new Date(Date.now() - HOUR_MS));
  await replaceRevision(env, t, p3, recent.revisionId as RevisionId);

  // a sealed revision whose retention ended: its file's admission revoked RETENTION_EXPIRED, the revision EXPIRED (RETENTION)
  const p4 = await project(env, t);
  const old = await sealedRevision(env, t, p4, "journal-expired");
  const retention = await env.plane.sweepers.retention.sweep(env.plane.units, 100);
  assert.deepEqual([retention.filesRevoked, retention.revisionsExpired, retention.failed], [1, 1, []]);

  // a forged event: a request handler's own version bump (the session issue) appended under the type of a tombstone — the upload is
  // UPLOADING, it never took the transition the event announces (Q-B07-22; design §6)
  const p5 = await project(env, t);
  const forgedUpload = await reserve(env, t, p5, 10, "CSV");
  const forgedEventId = await asRequestHandler(env, t, null, async (s, emit, c) => {
    const issued = await s.uploads.transition(forgedUpload.uploadId, 1, { event: "session_issued", sessionAttempt: 1, providerSessionDigest: textDigest("forged-session"), providerSessionLifetimeSeconds: 604_800 });
    if (issued.kind !== "APPLIED") throw new Error("unreachable");
    await emit("upload_session", forgedUpload.uploadId, issued.record.version, "upload_session.cancelled.v1", { uploadId: forgedUpload.uploadId, agencyId, revisionId: forgedUpload.revisionId, cancelledByMembershipId: t.ag.ownerMembershipId, reasonCode: "CANCELLED_BY_REQUESTER", providerCancellationState: "NOT_REQUESTED" });
    const r = await c.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'upload_session.cancelled.v1'", [forgedUpload.uploadId]);
    return r.rows[0]?.event_id ?? "";
  });

  // every event routed to AUTHORITY_JOURNAL in this agency, as the database holds them
  const routed = await oracleRows<RoutedEvent>(
    env,
    `SELECT e.event_id, e.event_type, e.aggregate_id, e.sequence::text FROM kauro.domain_events e JOIN kauro.outbox_records o ON o.event_id = e.event_id AND o.consumer = 'AUTHORITY_JOURNAL'
      WHERE e.agency_id = $1 ORDER BY e.sequence`,
    [agencyId],
  );
  const expected: ReadonlyArray<readonly [string, string]> = [
    ["upload_session.expired.v1", expiring.uploadId],
    ["upload_session.cancelled.v1", cancelledUpload.uploadId],
    ["upload_session.rejected.v1", rejectedUpload.up.uploadId],
    ["dataset_revision.rejected.v1", p1.revisionId],
    ["dataset_revision.cancelled.v1", p2.revisionId],
    ["dataset_revision.superseded.v1", recent.revisionId],
    ["source_file.admission_revoked.v1", old.fileId],
    ["dataset_revision.expired.v1", old.revisionId],
    ["upload_session.cancelled.v1", forgedUpload.uploadId],
  ];
  assert.deepEqual(routed.map((e) => [e.event_type, e.aggregate_id]), expected, "one routed event per terminal fact (and the forged one), in sequence order");

  const counts = await env.plane.drain(env.plane.consumers.authorityJournal, clock.now());
  assert.deepEqual([counts.delivered, counts.retried, counts.deadLettered], [8, 0, 1]);
  const forged = await oracle<{ state: string; last_error_code: string }>(env, "SELECT state, last_error_code FROM kauro.outbox_records WHERE event_id = $1 AND consumer = 'AUTHORITY_JOURNAL'", [forgedEventId]);
  assert.deepEqual([forged.state, forged.last_error_code], ["DEAD_LETTER", "SUBJECT_NOT_IN_TOMBSTONE_STATE"], "a subject not in the tombstone's terminal state is an integrity incident");

  // the journal: exactly the eight tombstones, each the kind and state AUTHORITY_TOMBSTONES names, in sequence order
  const listed = await env.journal.list(agencyId as AgencyId, 0);
  const genuine = routed.filter((e) => e.event_id !== forgedEventId);
  assert.deepEqual(
    listed.map((x) => [x.tombstoneId, x.kind, x.state, x.subjectId, x.sequence]),
    genuine.map((e) => {
      const named = AUTHORITY_TOMBSTONES[e.event_type as keyof typeof AUTHORITY_TOMBSTONES];
      return [e.event_id, named.kind, named.state, e.aggregate_id, Number(e.sequence)];
    }),
  );
  assert.ok(listed.every((x, i) => i === 0 || (listed[i - 1]?.sequence ?? 0) < x.sequence), "listed in ascending sequence");
  assert.deepEqual(new Set(listed.map((x) => x.kind)), new Set(["UPLOAD_ACCEPTANCE_REVOKED", "REVISION_REJECTED", "REVISION_CANCELLED", "REVISION_SUPERSEDED", "FILE_ADMISSION_REVOKED", "REVISION_EXPIRED"]));
  assert.ok(!listed.some((x) => x.tombstoneId === forgedEventId), "nothing is tombstoned for the forged event");
  // minimal facts: the revision each subject's authority belonged to, the instant the database recorded for the transition, and
  // the KAURO_AUTHORITY_TOMBSTONE_V1 digest of the other members
  for (const x of listed) {
    const { evidenceHash, ...members } = x;
    assert.equal(evidenceHash, authorityTombstoneHashOf(members));
    assert.match(x.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/, "the database's exact instant");
  }
  const byKind = (kind: AuthorityTombstone["kind"], subjectId: string): AuthorityTombstone => {
    const found = listed.find((x) => x.kind === kind && x.subjectId === subjectId);
    assert.ok(found, `${kind} ${subjectId}`);
    return found;
  };
  const fileTombstone = byKind("FILE_ADMISSION_REVOKED", old.fileId);
  const revokedAt = await oracle<{ at: string }>(env, `SELECT to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM kauro.source_files WHERE file_id = $1`, [old.fileId]);
  assert.deepEqual([fileTombstone.state, fileTombstone.revisionId, fileTombstone.occurredAt], ["ADMISSION_REVOKED", old.revisionId, revokedAt.at], "the SourceFile machine's own terminal state (D-RESTORE-2)");
  assert.equal(byKind("UPLOAD_ACCEPTANCE_REVOKED", cancelledUpload.uploadId).revisionId, p1.revisionId);

  // appended once: a second delivery of every event is ALREADY_PRESENT and writes nothing; a new process lists the same file
  const lines = readFileSync(env.journal.path, "utf8").trim().split("\n");
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => l.includes(`"provider":"${CONTRACT_FAKE_JOURNAL_PROVIDER}"`) && l.includes('"evidenceClass":"SIMULATED"')), "every line is the labelled fake's");
  for (const e of genuine) {
    const record = await env.plane.units.runSource({ kind: "SYSTEM", serviceId: "authority-journal", correlationId: ids.next() as CorrelationId }, (uow) => uow.events.get(e.event_id as EventId));
    assert.ok(record);
    const context: SystemContext = { kind: "SYSTEM", serviceId: "authority-journal", correlationId: record.correlationId as CorrelationId, agencyId: agencyId as AgencyId };
    assert.deepEqual(await env.plane.consumers.authorityJournal.handle(record as DomainEventRecord, context, env.plane.units), { kind: "DONE" });
  }
  assert.equal(readFileSync(env.journal.path, "utf8").trim().split("\n").length, 8, "nothing appended twice");
  assert.ok(env.journal.calls().filter((c) => c.operation === "append").slice(-8).every((c) => c.outcome === "ALREADY_PRESENT"));
  const restored = new ContractFakeAuthorityJournal({ path: env.journal.path });
  assert.deepEqual(await restored.list(agencyId as AgencyId, 0), listed, "a restore reads the same tombstones in the same order");
  assert.deepEqual((await restored.list(agencyId as AgencyId, listed[3]?.sequence ?? 0)).map((x) => x.tombstoneId), listed.slice(4).map((x) => x.tombstoneId), "and resumes after a sequence");
});
