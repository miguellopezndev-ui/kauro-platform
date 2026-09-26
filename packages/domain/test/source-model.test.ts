// The pure source-lifecycle model of B07 (docs/design/B07-upload-source-lifecycle.md): policy values against the registry, the
// platform machines against the registry's shape and the transition guard, the scan-coverage evaluation of S054 including the
// sabotage of 21 ("a scanner skip labelled clean"), digest domain separation, deadline arithmetic and object-name scope.
import assert from "node:assert/strict";
import { test } from "node:test";
import { policy } from "@kauro/contracts";
import {
  AGENCY_UPLOAD_SESSIONS,
  EVENT_PAYLOAD_ALLOWLIST,
  EVENT_SUBSCRIPTIONS,
  EVENT_TYPES,
  INPUT_ENVELOPE,
  PRICING_DEFINITION,
  REVISION_SELECTABLE_STATES,
  SIGNATURE_MAX_AGE_SECONDS,
  SOURCE_DIGEST_DOMAINS,
  SOURCE_LIFECYCLE_STATE_MACHINES,
  SOURCE_RETENTION,
  UPLOAD_QUOTA_HOLDING_STATES,
  UPLOAD_SLOT_HOLDING_STATES,
  acceptedObjectName,
  agencyPrefix,
  consumersOf,
  evaluateScanCoverage,
  firstSealOfBytes,
  isListed,
  isObjectName,
  isTerminal,
  quarantineObjectName,
  sealedSubjectHashOf,
  selectionHashOf,
  sourceDigest,
  sourceRevisionManifestHashOf,
  statesOf,
  transition,
  unpaidSealedDeadlines,
  unpaidSoftDeadline,
  uploadApplicationDeadline,
  type AgencyId,
  type ExpectedScanPart,
  type ProjectId,
  type ProjectionId,
  type RevisionId,
  type ScannerReport,
  type SealedSubjectDocument,
  type SelectionManifestDocument,
  type SourceFileId,
  type SourceRevisionManifest,
  type SourceTableId,
  type UploadId,
} from "../src/index.js";

const hex = (c: string): string => c.repeat(64).slice(0, 64);

test("policy values of the source lifecycle equal the vendored registry", () => {
  const p = policy() as { input: Record<string, number>; capacity: Record<string, number>; retention: Record<string, number | boolean>; pricing: { scheduleVersion: string } };
  assert.deepEqual({ ...INPUT_ENVELOPE }, {
    files: p.input["files"],
    fileBytes: p.input["fileBytes"],
    revisionBytes: p.input["revisionBytes"],
    columns: p.input["columns"],
    decodedCellBytes: p.input["decodedCellBytes"],
    decodedRecordBytes: p.input["decodedRecordBytes"],
    xlsxExpandedTotalBytes: p.input["xlsxExpandedTotalBytes"],
    xlsxExpandedPartBytes: p.input["xlsxExpandedPartBytes"],
    associationCandidates: p.input["associationCandidates"],
  });
  assert.equal(AGENCY_UPLOAD_SESSIONS, p.capacity["agencyUploads"]);
  assert.equal(SOURCE_RETENTION.uploadReservationSeconds, p.retention["uploadReservationSeconds"]);
  assert.equal(SOURCE_RETENTION.unpaidDaysFromReady, p.retention["unpaidDaysFromReady"]);
  assert.equal(SOURCE_RETENTION.unpaidDaysHardFromSeal, p.retention["unpaidDaysHardFromSeal"]);
  assert.equal(SOURCE_RETENTION.extendHardCap, p.retention["extendHardCap"]);
  assert.equal(PRICING_DEFINITION, p.pricing.scheduleVersion);
});

test("the platform machines are well formed, terminal states have no outgoing edge, and the guard refuses every unlisted pair", () => {
  assert.deepEqual(SOURCE_LIFECYCLE_STATE_MACHINES.map((m) => m.contract), ["UploadSession", "StoredObject", "SourceFile", "RetentionRecord"]);
  for (const m of SOURCE_LIFECYCLE_STATE_MACHINES) {
    assert.equal(m.unlistedTransition, "REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED");
    for (const t of m.transitions) assert.ok(!m.terminal.includes(t.from), `${m.contract}: terminal ${t.from} has an outgoing edge`);
    const name = m.contract as "UploadSession" | "StoredObject" | "SourceFile" | "RetentionRecord";
    const states = statesOf(name);
    const events = [...new Set(m.transitions.map((t) => t.event))];
    for (const from of states) {
      for (const event of events) {
        const listed = m.transitions.find((t) => t.from === from && t.event === event);
        if (listed) assert.equal(transition(name, from, event), listed.to);
        else assert.throws(() => transition(name, from, event), (e: unknown) => (e as { code?: string }).code === "PRECONDITION_FAILED");
      }
    }
  }
  // the UploadSession states are exactly the contract's; acceptance tombstones are terminal; nothing leaves them
  assert.deepEqual([...statesOf("UploadSession")].sort(), ["ADMITTED", "CANCELLED", "EXPIRED", "REJECTED", "RESERVED", "UPLOADING", "VERIFYING"]);
  for (const s of ["CANCELLED", "EXPIRED", "REJECTED"]) assert.ok(isTerminal("UploadSession", s), s);
  assert.equal(isListed("UploadSession", "CANCELLED", "completion_reported"), false, "a late completion cannot resurrect a cancelled upload");
  assert.equal(isListed("UploadSession", "EXPIRED", "inspection_admitted"), false);
  // RetentionRecord (D-RET-2): the registry contract's states; B07 takes ACTIVE -> EXPIRED, the deletion package the rest; a
  // record never becomes ACTIVE again, and its terminal states are the managed deletion's outcomes
  assert.deepEqual([...statesOf("RetentionRecord")].sort(), ["ACTIVE", "DELETED", "DELETED_WITH_RESIDUALS", "DELETING", "EXPIRED"]);
  assert.equal(transition("RetentionRecord", "ACTIVE", "effective_deadline_reached"), "EXPIRED");
  for (const s of ["DELETED", "DELETED_WITH_RESIDUALS"]) assert.ok(isTerminal("RetentionRecord", s), s);
  assert.ok(SOURCE_LIFECYCLE_STATE_MACHINES.find((m) => m.contract === "RetentionRecord")!.transitions.every((t) => t.to !== "ACTIVE"), "no edge returns to ACTIVE");
  // quota holding mirrors the SQL functions kauro.upload_holds_file / kauro.upload_holds_slot (migration 0009)
  assert.deepEqual([...UPLOAD_QUOTA_HOLDING_STATES].sort(), ["ADMITTED", "RESERVED", "UPLOADING", "VERIFYING"]);
  assert.deepEqual([...UPLOAD_SLOT_HOLDING_STATES].sort(), ["RESERVED", "UPLOADING", "VERIFYING"]);
  // the registry DatasetRevision machine drives the revision (no platform copy): the edges B07 relies on are listed
  for (const [from, event, to] of [
    ["DRAFT", "upload_reserved", "UPLOADING"],
    ["UPLOADING", "all_uploads_completed", "INSPECTING"],
    ["DRAFT", "previously_admitted_inputs_selected", "INSPECTING"],
    ["INSPECTING", "all_selected_inputs_admitted", "READY_TO_SEAL"],
    ["INSPECTING", "fatal_input_rejection", "REJECTED"],
    ["READY_TO_SEAL", "selection_changes", "INSPECTING"],
    ["READY_TO_SEAL", "seal_command", "SEALED"],
    ["SEALED", "new_revision_explicitly_supersedes", "SUPERSEDED"],
    ["UPLOADING", "cancel_revision", "CANCELLED"],
    ["CANCELLED", "managed_cleanup_verified", "DELETED"],
  ] as const) {
    assert.equal(transition("DatasetRevision", from, event), to);
  }
  assert.equal(isListed("DatasetRevision", "INSPECTING", "upload_reserved"), false, "no upload enters an INSPECTING revision");
  assert.equal(isListed("DatasetRevision", "SEALED", "selection_changes"), false, "a sealed selection never changes");
  // D-INTAKE-1 (B07-F1): binding a selection on an UPLOADING revision is the agency's explicit all_uploads_completed
  assert.deepEqual([...REVISION_SELECTABLE_STATES].sort(), ["DRAFT", "INSPECTING", "READY_TO_SEAL", "UPLOADING"]);
});

const parts: ReadonlyArray<ExpectedScanPart> = [
  { partDigest: hex("a"), partKind: "CONTAINER", bytes: 10_000 },
  { partDigest: hex("b"), partKind: "WORKSHEET_PART", bytes: 50_000 },
];
const pinned = hex("c");
function report(over: Partial<ScannerReport> = {}): ScannerReport {
  return {
    engine: "contract-fake-scanner",
    engineVersion: "SIMULATED-1",
    signatureVersion: "SIG-1",
    signaturesPublishedAt: "2026-09-24T10:00:00.000Z",
    configHash: pinned,
    scannedAt: "2026-09-24T12:00:00.000Z",
    exitCode: 0,
    verdict: "CLEAN",
    parts: [
      { partDigest: hex("a"), scannedBytes: 10_000, outcome: "CLEAN" },
      { partDigest: hex("b"), scannedBytes: 50_000, outcome: "CLEAN" },
    ],
    ...over,
  };
}
const policyOf = { pinnedConfigHash: pinned };
/** The object the parts describe: the container part is its observed length (B07-F4). */
const container = { observedBytes: 10_000 };

test("S054: a fully covered harmless file is COVERED_CLEAN; the engine's exit code and verdict never decide", () => {
  const ok = evaluateScanCoverage(parts, report(), policyOf, container);
  assert.equal(ok.scanState, "COVERED_CLEAN");
  assert.deepEqual(ok.reasons, []);
  assert.deepEqual([ok.expectedParts, ok.expectedBytes, ok.scannedParts, ok.scannedBytes], [2, 60_000, 2, 60_000]);
  // a nonzero exit code or an ERROR verdict on a report whose parts are all covered and clean does not flip the decision either
  assert.equal(evaluateScanCoverage(parts, report({ exitCode: 2, verdict: "ERROR" }), policyOf, container).scanState, "COVERED_CLEAN");
});

test("S054: the scanner skipped an oversized part and exited clean -> NOT_SCANNED, never clean with a warning (21: a scanner skip labelled clean)", () => {
  // ClamAV's default: the part above MaxFileSize is skipped and the process exits 0 with a CLEAN verdict
  const skipped = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "CLEAN" }, { partDigest: hex("b"), scannedBytes: 0, outcome: "SKIPPED_SIZE_LIMIT" }] }), policyOf, container);
  assert.equal(skipped.scanState, "NOT_SCANNED");
  assert.deepEqual(skipped.reasons, ["PART_SKIPPED"]);
  assert.equal(skipped.scannedBytes, 10_000);
  // the sabotaged adapter labels the skipped part CLEAN: the byte accounting still exposes it
  const labelledClean = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "CLEAN" }, { partDigest: hex("b"), scannedBytes: 0, outcome: "CLEAN" }] }), policyOf, container);
  assert.equal(labelledClean.scanState, "NOT_SCANNED");
  assert.deepEqual(labelledClean.reasons, ["BYTES_SHORT"]);
  // a part the engine never mentions is missing coverage
  const missing = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "CLEAN" }] }), policyOf, container);
  assert.deepEqual([missing.scanState, missing.reasons], ["NOT_SCANNED", ["PART_MISSING"]]);
  // nothing expected is not coverage
  assert.equal(evaluateScanCoverage([], report({ parts: [] }), policyOf, container).scanState, "NOT_SCANNED");
});

test("S054 neighbours: detection is BLOCKED whatever else happened; engine failures are ERROR; stale or unpinned engines are NOT_SCANNED", () => {
  const detected = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "DETECTED" }, { partDigest: hex("b"), scannedBytes: 0, outcome: "SKIPPED_SIZE_LIMIT" }] }), policyOf, container);
  assert.equal(detected.scanState, "BLOCKED");
  assert.deepEqual(detected.reasons, ["DETECTED", "PART_SKIPPED"]);
  const timeout = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "CLEAN" }, { partDigest: hex("b"), scannedBytes: 1, outcome: "TIMEOUT" }] }), policyOf, container);
  assert.equal(timeout.scanState, "ERROR");
  const unexpected = evaluateScanCoverage(parts, report({ parts: [...report().parts, { partDigest: hex("d"), scannedBytes: 5, outcome: "CLEAN" }] }), policyOf, container);
  assert.deepEqual([unexpected.scanState, unexpected.reasons], ["ERROR", ["UNEXPECTED_PART"]]);
  const stale = evaluateScanCoverage(parts, report({ signaturesPublishedAt: "2026-09-22T11:59:59.000Z" }), policyOf, container);
  assert.deepEqual([stale.scanState, stale.reasons], ["NOT_SCANNED", ["STALE_SIGNATURES"]]);
  const unpinned = evaluateScanCoverage(parts, report({ configHash: hex("e") }), policyOf, container);
  assert.deepEqual([unpinned.scanState, unpinned.reasons], ["NOT_SCANNED", ["CONFIG_NOT_PINNED"]]);
  const encrypted = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 0, outcome: "ENCRYPTED" }, { partDigest: hex("b"), scannedBytes: 50_000, outcome: "CLEAN" }] }), policyOf, container);
  assert.deepEqual([encrypted.scanState, encrypted.reasons], ["NOT_SCANNED", ["PART_ENCRYPTED"]]);
});

test("B07-F4: scan coverage is judged against the object — an expected list without the container, or with the container at another length than observed, is never clean", () => {
  // the critic's receipt: the writer expected 1 byte of a 100-byte object and the engine read that byte
  const oneOfHundred = evaluateScanCoverage(
    [{ partDigest: hex("a"), partKind: "CONTAINER", bytes: 1 }],
    report({ parts: [{ partDigest: hex("a"), scannedBytes: 1, outcome: "CLEAN" }] }),
    policyOf,
    { observedBytes: 100 },
  );
  assert.deepEqual([oneOfHundred.scanState, oneOfHundred.reasons], ["NOT_SCANNED", ["CONTAINER_NOT_COVERED"]]);
  // only expanded parts, no container: every listed part covered, still not the object
  const partsOnly = evaluateScanCoverage([{ partDigest: hex("b"), partKind: "WORKSHEET_PART", bytes: 50_000 }], report({ parts: [{ partDigest: hex("b"), scannedBytes: 50_000, outcome: "CLEAN" }] }), policyOf, container);
  assert.deepEqual([partsOnly.scanState, partsOnly.reasons], ["NOT_SCANNED", ["CONTAINER_NOT_COVERED"]]);
  // two containers are not one object either
  const twoContainers = evaluateScanCoverage(
    [...parts, { partDigest: hex("f"), partKind: "CONTAINER", bytes: 10_000 }],
    report({ parts: [...report().parts, { partDigest: hex("f"), scannedBytes: 10_000, outcome: "CLEAN" }] }),
    policyOf,
    container,
  );
  assert.deepEqual([twoContainers.scanState, twoContainers.reasons], ["NOT_SCANNED", ["CONTAINER_NOT_COVERED"]]);
  // the signature age is pinned (86,400 s), never widened by a caller: six-day-old signatures are stale
  assert.equal(SIGNATURE_MAX_AGE_SECONDS, 86_400);
  const sixDays = evaluateScanCoverage(parts, report({ signaturesPublishedAt: "2026-09-18T12:00:00.000Z" }), policyOf, container);
  assert.deepEqual([sixDays.scanState, sixDays.reasons], ["NOT_SCANNED", ["STALE_SIGNATURES"]]);
  // positive neighbour: the container at its observed length and every part covered
  assert.equal(evaluateScanCoverage(parts, report(), policyOf, container).scanState, "COVERED_CLEAN");
});

test("digests are domain separated; the manifest hash is exactly HASHING's KAURO_SOURCE_REVISION_V1 preimage and the sealed subject binds the revision (B07-F12)", () => {
  const payload = { a: 1 };
  const domains = Object.values(SOURCE_DIGEST_DOMAINS);
  assert.equal(new Set(domains.map((d) => sourceDigest(d, payload))).size, domains.length);
  assert.equal(new Set(domains).size, domains.length);
  const selection: SelectionManifestDocument = { schemaVersion: 1, revisionId: "0190c7a2-0000-7000-8000-000000000001" as RevisionId, inventoryHash: hex("1"), files: [], tables: [], projections: [], associations: [] };
  assert.match(selectionHashOf(selection), /^[0-9a-f]{64}$/);
  assert.equal(selectionHashOf(selection), selectionHashOf({ ...selection }), "key order and object identity do not change the digest");
  const file = "0190c7a2-0000-7000-8000-0000000000f1" as SourceFileId;
  const table = "0190c7a2-0000-7000-8000-0000000000f2" as SourceTableId;
  const manifest = (projectionId: string): SourceRevisionManifest => ({
    files: [{ fileId: file, providerGeneration: "1700000000000001", sha256: hex("5"), bytes: 1234 }],
    tableSelection: [{ fileId: file, disposition: "INCLUDED", exclusionReason: null, tables: [{ tableId: table, ordinal: 0, structureHash: hex("6"), visibility: "VISIBLE", disposition: "INCLUDED", exclusionReason: null, selectedColumns: null }] }],
    parserProfile: [{ fileId: file, format: "CSV", parserProfileHash: hex("7"), tables: [{ tableId: table, parser: { kind: "CSV" } }] }],
    projection: { projections: [{ projectionId: projectionId as ProjectionId, projectionKey: "CONTACT", tableId: table, objectKind: "CONTACT", kind: "ROW", fieldOrdinals: [0, 1], billable: true }], associations: [], pricingDefinition: "R2-INITIAL" },
  });
  // the preimage has exactly HASHING's four members: ordered accepted files, table selection, parser profile, projection
  assert.deepEqual(Object.keys(manifest("0190c7a2-0000-7000-8000-0000000000a1")).sort(), ["files", "parserProfile", "projection", "tableSelection"]);
  // the same preimage is the same manifest hash (authority-exact: no revision id, no population inside)
  assert.equal(sourceRevisionManifestHashOf(manifest("0190c7a2-0000-7000-8000-0000000000a1")), sourceRevisionManifestHashOf(manifest("0190c7a2-0000-7000-8000-0000000000a1")));
  // two seals mint two projection identities (SourceLocator.projectionId), so identical bytes sealed twice are two manifests
  assert.notEqual(sourceRevisionManifestHashOf(manifest("0190c7a2-0000-7000-8000-0000000000a1")), sourceRevisionManifestHashOf(manifest("0190c7a2-0000-7000-8000-0000000000a2")));
  const subject = (revisionId: string): SealedSubjectDocument => ({
    canonicalVersion: 1,
    revisionId: revisionId as RevisionId,
    projectId: "0190c7a2-0000-7000-8000-00000000000a" as ProjectId,
    supersedesRevisionId: null,
    manifestHash: sourceRevisionManifestHashOf(manifest("0190c7a2-0000-7000-8000-0000000000a1")),
    projectionHash: hex("4"),
    selectionHash: hex("2"),
    evaluationHash: hex("3"),
    populations: { physicalSourceRows: 120, logicalSourceRecords: 120, billableSourceUnits: 120, associationEdges: 0 },
    files: [{ fileId: file, inspectionReceiptHash: hex("8"), tables: [{ tableId: table, physicalRows: 120 }] }],
    projections: [{ projectionId: "0190c7a2-0000-7000-8000-0000000000a1" as ProjectionId, logicalRecords: 120, billable: true }],
    associations: [],
    rejectedUploads: [],
    inputEnvelope: { files: 50, fileBytes: 2_000_000_000, revisionBytes: 5_000_000_000 },
  });
  // the revision and the populations live in the sealed subject: the same manifest in two revisions is two subjects (D-HASH-4)
  assert.notEqual(sealedSubjectHashOf(subject("0190c7a2-0000-7000-8000-000000000001")), sealedSubjectHashOf(subject("0190c7a2-0000-7000-8000-000000000002")));
  assert.notEqual(sealedSubjectHashOf(subject("0190c7a2-0000-7000-8000-000000000001")), sourceRevisionManifestHashOf(manifest("0190c7a2-0000-7000-8000-0000000000a1")));
});

test("deadlines: the reservation lasts exactly 24 h from initiation; an unpaid seal is capped at 14 days and a ready anchor only moves it earlier", () => {
  assert.equal(uploadApplicationDeadline("2026-09-24T10:15:30.123Z"), "2026-09-25T10:15:30.123Z");
  const sealed = unpaidSealedDeadlines("2026-09-24T00:00:00.000Z");
  assert.deepEqual(sealed, { hardDeadline: "2026-10-08T00:00:00.000Z", effectiveDeadline: "2026-10-08T00:00:00.000Z" });
  assert.equal(unpaidSoftDeadline("2026-09-25T00:00:00.000Z", sealed.hardDeadline), "2026-10-02T00:00:00.000Z");
  assert.equal(unpaidSoftDeadline("2026-10-05T00:00:00.000Z", sealed.hardDeadline), sealed.hardDeadline, "a late ready anchor never extends past the hard cap");
  // D-RET-3 (B07-F5): the hard cap belongs to the bytes — a re-seal of reused bytes keeps the first seal's fourteen days
  const first = firstSealOfBytes("2026-10-01T00:00:00.000Z", ["2026-09-24T00:00:00.000Z", "2026-09-28T00:00:00.000Z"]);
  assert.equal(first, "2026-09-24T00:00:00.000Z");
  assert.equal(unpaidSealedDeadlines(first).hardDeadline, "2026-10-08T00:00:00.000Z", "not 2026-10-15, fourteen days from the re-seal");
  assert.equal(firstSealOfBytes("2026-10-01T00:00:00.000Z", []), "2026-10-01T00:00:00.000Z", "new bytes: this seal");
});

test("object names are opaque, zone-prefixed and scoped to one agency; a prefix of one agency never matches another", () => {
  const agency = "0190c7a2-0000-7000-8000-00000000000a" as AgencyId;
  const project = "0190c7a2-0000-7000-8000-00000000000b" as ProjectId;
  const revision = "0190c7a2-0000-7000-8000-00000000000c" as RevisionId;
  const upload = "0190c7a2-0000-7000-8000-00000000000d" as UploadId;
  const file = "0190c7a2-0000-7000-8000-00000000000e" as SourceFileId;
  const q = quarantineObjectName(agency, project, revision, upload);
  assert.ok(isObjectName(q));
  assert.ok(isObjectName(acceptedObjectName(agency, project, file)));
  assert.ok(q.startsWith(agencyPrefix("QUARANTINE", agency)));
  assert.ok(!q.startsWith(agencyPrefix("QUARANTINE", "0190c7a2-0000-7000-8000-00000000000f" as AgencyId)));
  for (const bad of ["quarantine/contacts.csv", `quarantine/${agency}`, `quarantine/${agency}/${project}/../x`, `QUARANTINE/${agency}/${project}`]) assert.equal(isObjectName(bad), false, bad);
});

test("every B07 event type carries an allowlist without customer-text keys, and every B07 consumer subscription names a registered type", () => {
  const b07 = EVENT_TYPES.filter((t) => t.startsWith("upload_session.") || t.startsWith("retention_record.") || t.startsWith("source_file.") || t === "project.current_revision_changed.v1" || (t.startsWith("dataset_revision.") && t !== "dataset_revision.created.v1"));
  // the ten upload-session edges, the retention record's creation and expiry, the source file's admission and revocation (B07-F9),
  // the project pointer, the selection binding and the nine DatasetRevision lifecycle events B06 registered with the machine (B07
  // publishes them; migration 0012 seeds the other 16)
  assert.deepEqual([...b07].sort(), [
    "dataset_revision.cancelled.v1", "dataset_revision.deleted.v1", "dataset_revision.expired.v1", "dataset_revision.inspecting.v1", "dataset_revision.ready_to_seal.v1",
    "dataset_revision.rejected.v1", "dataset_revision.sealed.v1", "dataset_revision.selection_changed.v1", "dataset_revision.superseded.v1", "dataset_revision.uploading.v1",
    "project.current_revision_changed.v1", "retention_record.created.v1", "retention_record.expired.v1",
    "source_file.admission_revoked.v1", "source_file.admitted.v1",
    "upload_session.admitted.v1", "upload_session.cancelled.v1", "upload_session.completion_not_observed.v1", "upload_session.completion_observed.v1",
    "upload_session.completion_reported.v1", "upload_session.expired.v1", "upload_session.provider_cancellation_recorded.v1", "upload_session.rejected.v1",
    "upload_session.reserved.v1", "upload_session.session_issued.v1",
  ]);
  // B07-F9: an admission revoked under a selection or a seal reaches the execution consumer and the agency; re-check N5: it is a
  // restore tombstone too
  assert.deepEqual([...consumersOf("source_file.admission_revoked.v1")].sort(), ["AUTHORITY_JOURNAL", "EXECUTION_CONTROL", "NOTIFICATIONS"]);
  // B07-F8: every terminal authority fact of the source lifecycle is tombstoned outside the restore boundary
  for (const t of ["upload_session.cancelled.v1", "upload_session.expired.v1", "upload_session.rejected.v1", "dataset_revision.cancelled.v1", "dataset_revision.superseded.v1", "dataset_revision.rejected.v1", "dataset_revision.expired.v1", "dataset_revision.deleted.v1", "source_file.admission_revoked.v1"] as const) {
    assert.ok(consumersOf(t).includes("AUTHORITY_JOURNAL"), t);
  }
  for (const t of b07) {
    const keys = EVENT_PAYLOAD_ALLOWLIST[t];
    assert.ok(keys.length > 0, t);
    for (const k of keys) assert.ok(!/name|label|display|filename|uri|url|secret|objectName|generation/i.test(k), `${t}.${k} could carry customer text or a bearer value`);
  }
  for (const consumer of ["UPLOAD_INSPECTION", "STORAGE_LIFECYCLE", "SELECTION_EVALUATION", "AUTHORITY_JOURNAL"]) {
    assert.ok(EVENT_SUBSCRIPTIONS.some((s) => s.consumer === consumer), consumer);
  }
});
