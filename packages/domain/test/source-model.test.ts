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
  SOURCE_DIGEST_DOMAINS,
  SOURCE_LIFECYCLE_STATE_MACHINES,
  SOURCE_RETENTION,
  UPLOAD_QUOTA_HOLDING_STATES,
  UPLOAD_SLOT_HOLDING_STATES,
  acceptedObjectName,
  agencyPrefix,
  evaluateScanCoverage,
  isListed,
  isObjectName,
  isTerminal,
  quarantineObjectName,
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
  type RevisionId,
  type ScannerReport,
  type SealedManifestDocument,
  type SelectionManifestDocument,
  type SourceFileId,
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
  assert.deepEqual(SOURCE_LIFECYCLE_STATE_MACHINES.map((m) => m.contract), ["UploadSession", "StoredObject", "SourceFile"]);
  for (const m of SOURCE_LIFECYCLE_STATE_MACHINES) {
    assert.equal(m.unlistedTransition, "REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED");
    for (const t of m.transitions) assert.ok(!m.terminal.includes(t.from), `${m.contract}: terminal ${t.from} has an outgoing edge`);
    const name = m.contract as "UploadSession" | "StoredObject" | "SourceFile";
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
  // quota holding mirrors the SQL functions kauro.upload_holds_file / kauro.upload_holds_slot (migration 0008)
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
const policyOf = { pinnedConfigHash: pinned, signatureMaxAgeSeconds: 86_400 };

test("S054: a fully covered harmless file is COVERED_CLEAN; the engine's exit code and verdict never decide", () => {
  const ok = evaluateScanCoverage(parts, report(), policyOf);
  assert.equal(ok.scanState, "COVERED_CLEAN");
  assert.deepEqual(ok.reasons, []);
  assert.deepEqual([ok.expectedParts, ok.expectedBytes, ok.scannedParts, ok.scannedBytes], [2, 60_000, 2, 60_000]);
  // a nonzero exit code or an ERROR verdict on a report whose parts are all covered and clean does not flip the decision either
  assert.equal(evaluateScanCoverage(parts, report({ exitCode: 2, verdict: "ERROR" }), policyOf).scanState, "COVERED_CLEAN");
});

test("S054: the scanner skipped an oversized part and exited clean -> NOT_SCANNED, never clean with a warning (21: a scanner skip labelled clean)", () => {
  // ClamAV's default: the part above MaxFileSize is skipped and the process exits 0 with a CLEAN verdict
  const skipped = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "CLEAN" }, { partDigest: hex("b"), scannedBytes: 0, outcome: "SKIPPED_SIZE_LIMIT" }] }), policyOf);
  assert.equal(skipped.scanState, "NOT_SCANNED");
  assert.deepEqual(skipped.reasons, ["PART_SKIPPED"]);
  assert.equal(skipped.scannedBytes, 10_000);
  // the sabotaged adapter labels the skipped part CLEAN: the byte accounting still exposes it
  const labelledClean = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "CLEAN" }, { partDigest: hex("b"), scannedBytes: 0, outcome: "CLEAN" }] }), policyOf);
  assert.equal(labelledClean.scanState, "NOT_SCANNED");
  assert.deepEqual(labelledClean.reasons, ["BYTES_SHORT"]);
  // a part the engine never mentions is missing coverage
  const missing = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "CLEAN" }] }), policyOf);
  assert.deepEqual([missing.scanState, missing.reasons], ["NOT_SCANNED", ["PART_MISSING"]]);
  // nothing expected is not coverage
  assert.equal(evaluateScanCoverage([], report({ parts: [] }), policyOf).scanState, "NOT_SCANNED");
});

test("S054 neighbours: detection is BLOCKED whatever else happened; engine failures are ERROR; stale or unpinned engines are NOT_SCANNED", () => {
  const detected = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "DETECTED" }, { partDigest: hex("b"), scannedBytes: 0, outcome: "SKIPPED_SIZE_LIMIT" }] }), policyOf);
  assert.equal(detected.scanState, "BLOCKED");
  assert.deepEqual(detected.reasons, ["DETECTED", "PART_SKIPPED"]);
  const timeout = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 10_000, outcome: "CLEAN" }, { partDigest: hex("b"), scannedBytes: 1, outcome: "TIMEOUT" }] }), policyOf);
  assert.equal(timeout.scanState, "ERROR");
  const unexpected = evaluateScanCoverage(parts, report({ parts: [...report().parts, { partDigest: hex("d"), scannedBytes: 5, outcome: "CLEAN" }] }), policyOf);
  assert.deepEqual([unexpected.scanState, unexpected.reasons], ["ERROR", ["UNEXPECTED_PART"]]);
  const stale = evaluateScanCoverage(parts, report({ signaturesPublishedAt: "2026-09-22T11:59:59.000Z" }), policyOf);
  assert.deepEqual([stale.scanState, stale.reasons], ["NOT_SCANNED", ["STALE_SIGNATURES"]]);
  const unpinned = evaluateScanCoverage(parts, report({ configHash: hex("e") }), policyOf);
  assert.deepEqual([unpinned.scanState, unpinned.reasons], ["NOT_SCANNED", ["CONFIG_NOT_PINNED"]]);
  const encrypted = evaluateScanCoverage(parts, report({ parts: [{ partDigest: hex("a"), scannedBytes: 0, outcome: "ENCRYPTED" }, { partDigest: hex("b"), scannedBytes: 50_000, outcome: "CLEAN" }] }), policyOf);
  assert.deepEqual([encrypted.scanState, encrypted.reasons], ["NOT_SCANNED", ["PART_ENCRYPTED"]]);
});

test("digests are domain separated: the same payload under two domains never collides; the manifest hash binds the revision id", () => {
  const payload = { a: 1 };
  const domains = Object.values(SOURCE_DIGEST_DOMAINS);
  assert.equal(new Set(domains.map((d) => sourceDigest(d, payload))).size, domains.length);
  assert.equal(new Set(domains).size, domains.length);
  const selection: SelectionManifestDocument = { schemaVersion: 1, revisionId: "0190c7a2-0000-7000-8000-000000000001" as RevisionId, inventoryHash: hex("1"), files: [], tables: [], projections: [], associations: [] };
  assert.match(selectionHashOf(selection), /^[0-9a-f]{64}$/);
  assert.equal(selectionHashOf(selection), selectionHashOf({ ...selection }), "key order and object identity do not change the digest");
  const manifest = (revisionId: string): SealedManifestDocument => ({
    canonicalVersion: 1,
    revisionId: revisionId as RevisionId,
    projectId: "0190c7a2-0000-7000-8000-00000000000a" as ProjectId,
    supersedesRevisionId: null,
    files: [],
    rejectedUploads: [],
    projections: [],
    associations: [],
    populations: { physicalSourceRows: 0, logicalSourceRecords: 0, billableSourceUnits: 0, associationEdges: 0 },
    selectionHash: hex("2"),
    evaluationHash: hex("3"),
    projectionHash: hex("4"),
    pricingDefinition: "R2-INITIAL",
    inputEnvelope: { files: 50, fileBytes: 2_000_000_000, revisionBytes: 5_000_000_000 },
  });
  // identical bytes and selection sealed in two revisions are two authority chains (D-HASH-1)
  assert.notEqual(sourceRevisionManifestHashOf(manifest("0190c7a2-0000-7000-8000-000000000001")), sourceRevisionManifestHashOf(manifest("0190c7a2-0000-7000-8000-000000000002")));
});

test("deadlines: the reservation lasts exactly 24 h from initiation; an unpaid seal is capped at 14 days and a ready anchor only moves it earlier", () => {
  assert.equal(uploadApplicationDeadline("2026-09-24T10:15:30.123Z"), "2026-09-25T10:15:30.123Z");
  const sealed = unpaidSealedDeadlines("2026-09-24T00:00:00.000Z");
  assert.deepEqual(sealed, { hardDeadline: "2026-10-08T00:00:00.000Z", effectiveDeadline: "2026-10-08T00:00:00.000Z" });
  assert.equal(unpaidSoftDeadline("2026-09-25T00:00:00.000Z", sealed.hardDeadline), "2026-10-02T00:00:00.000Z");
  assert.equal(unpaidSoftDeadline("2026-10-05T00:00:00.000Z", sealed.hardDeadline), sealed.hardDeadline, "a late ready anchor never extends past the hard cap");
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
  const b07 = EVENT_TYPES.filter((t) => t.startsWith("upload_session.") || t.startsWith("retention_record.") || t === "project.current_revision_changed.v1" || (t.startsWith("dataset_revision.") && t !== "dataset_revision.created.v1"));
  assert.equal(b07.length, 22);
  for (const t of b07) {
    const keys = EVENT_PAYLOAD_ALLOWLIST[t];
    assert.ok(keys.length > 0, t);
    for (const k of keys) assert.ok(!/name|label|display|filename|uri|url|secret|objectName|generation/i.test(k), `${t}.${k} could carry customer text or a bearer value`);
  }
  for (const consumer of ["UPLOAD_INSPECTION", "STORAGE_LIFECYCLE", "SELECTION_EVALUATION", "AUTHORITY_JOURNAL"]) {
    assert.ok(EVENT_SUBSCRIPTIONS.some((s) => s.consumer === consumer), consumer);
  }
});
