// The stage-1 composition of B07 (design §15: `b07/stage-1` merges B07-PERSISTENCE, B07-DATA-PLANE and B07-PROVIDER-FAKES, and
// the stage-2 mandates consume what it carries). This test binds the pieces the UPLOAD_INSPECTION pipeline (§12.1, mandate
// B07-CONTROL) will bind, through their ports exactly as the handoffs describe them, so a mismatch between two stage-1 mandates is
// found here rather than in stage 2: the object-storage fake of @kauro/application/testing (owner B07-PROVIDER-FAKES), the real
// isolated container inspector and preview reader of this package, and the scanner fake of @kauro/data-plane/testing (owner
// B07-DATA-PLANE) reading the object through the storage port's exact-generation read, with its scan instant read from a real
// PostgreSQL 17 clock (D-INSP-4). CONTRACT FAKES — SIMULATED: the storage's and the engine's behaviour are the labelled fakes'
// (evidence class SIMULATED, contract-fake-* tokens), never EXECUTED_PROVIDER; the real adapters are B15's. The inspector and the
// preview reader are the platform's own parsers, always real. No fake is created here: each is imported from its single owner.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { CONTRACT_FAKE_STORAGE_PROVIDER, ContractFakeObjectStorage, ContractFakeStorageError } from "@kauro/application/testing";
import { PROVIDER_CALL_TIMEOUT_MS, acceptedObjectName, evaluateScanCoverage, quarantineObjectName, type AgencyId, type ProjectId, type RevisionId, type SourceFileId, type UploadId } from "@kauro/domain";
import { IsolatedContainerInspector, IsolatedTablePreviewReader, PreviewFailure, inspectionLimits, rejectionClassOfInspection, rejectionClassOfScan } from "../src/index.js";
import { ContractFakeMalwareScanner, FAKE_SCANNER_ENGINE, FAKE_SCANNER_EVIDENCE_CLASS } from "../src/testing/index.js";
import { startDatabaseClock, type DatabaseClock } from "./support/database-clock.js";
import { freshDir, removeDir } from "./support/harness.js";
import { buildWorkbook } from "./support/workbook.js";

/** A deterministic UUIDv7 per ordinal (object names are two to five canonical UUIDs, design D-OBJ-1). */
function v7(n: number): string {
  return `0192b000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

const AGENCY = v7(1) as AgencyId;
const PROJECT = v7(2) as ProjectId;
const REVISION = v7(3) as RevisionId;
const UPLOAD = v7(4) as UploadId;
const FILE = v7(5) as SourceFileId;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let clock: DatabaseClock;
let scratch: string;

before(async () => {
  clock = await startDatabaseClock();
  scratch = freshDir("composition");
});

after(async () => {
  await clock.stop();
  removeDir(scratch);
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("stage-1 composition: a workbook finalized through the labelled storage fake's resumable session is observed by stat, inspected in isolation and scanned by the labelled scanner fake through the storage port's exact-generation read on the database clock — COVERED_CLEAN at the observed length; its promotion copy is re-read to the same digest and previewed, a second copy over the live destination is refused, and a generation the storage no longer holds is never read in its place; every provider record SIMULATED", { timeout: 300_000 }, async () => {
  const storage = new ContractFakeObjectStorage();
  const quarantine = storage.location("QUARANTINE");
  const accepted = storage.location("ACCEPTED");
  const quarantineName = quarantineObjectName(AGENCY, PROJECT, REVISION, UPLOAD);
  const workbook = buildWorkbook({ sheets: [{ name: "Contacts", rows: [["Id", "Name", "Email"], [1, "Ana", "ana@example.test"], [2, "Bo", "bo@example.test"]] }] });

  // CMD013's provider call and the browser's upload (SIMULATED): a resumable session for exactly the quarantine name, finalized
  const session = await storage.createResumableSession({ location: quarantine, objectName: quarantineName, declaredBytes: workbook.length, contentType: XLSX_TYPE, origin: "https://app.kauro.test" }, PROVIDER_CALL_TIMEOUT_MS);
  const finalized = storage.uploadThroughSession(session.sessionRef, workbook);
  assert.equal(finalized.outcome, "FINALIZED");
  if (finalized.outcome !== "FINALIZED") return;

  // CMD014 records the browser's completion reference as a claim; UPLOAD_INSPECTION observes the object itself (§12.1 step 2)
  const parsed = storage.parseCompletionClaim(finalized.completionRef);
  assert.equal(parsed.kind, "CLAIM");
  const observation = await storage.stat(quarantine, quarantineName);
  assert.ok(observation !== null, "the finalized object is present");
  assert.deepEqual(parsed.kind === "CLAIM" ? [parsed.claim.generation, parsed.claim.bytes] : [], [observation.generation, observation.bytes], "the true claim agrees with the observation");
  assert.equal(observation.bytes, workbook.length);

  // §12.1 step 3: the bounded container inspection of exactly the observed generation, isolated (D-ISO-1)
  const readGeneration = () => storage.read(quarantine, quarantineName, observation.generation);
  const inspection = await new IsolatedContainerInspector().inspect({ open: readGeneration, declaredFormat: "XLSX", observedBytes: observation.bytes, limits: inspectionLimits(), scratchDir: scratch });
  assert.equal(inspection.refusal, undefined, JSON.stringify(inspection.problems));
  assert.equal(rejectionClassOfInspection(inspection), undefined);
  assert.deepEqual([inspection.detectedFormat, inspection.structureStatus, inspection.sha256, inspection.bytes], ["XLSX", "STRUCTURE_VALID", sha256(workbook), workbook.length]);
  assert.deepEqual([inspection.isolation.mechanism, inspection.isolation.outsideWriteAttempts, inspection.isolation.networkAttempts, inspection.isolation.processAttempts], ["NODE_PERMISSION_CHILD", 0, 0, 0]);
  assert.equal(inspection.isolation.osNetworkDenied, undefined, "the OS-level egress denial is LATER: B15, never claimed");
  assert.deepEqual(inspection.expectedScanParts[0], { partDigest: sha256(workbook), partKind: "CONTAINER", bytes: observation.bytes }, "the container at its observed length");
  assert.deepEqual(readdirSync(scratch), [], "the inspection removed its own directory of the attempt scratch");

  // the scan of the same generation through the storage port, its instant read from the database clock after the bytes
  const scanner = new ContractFakeMalwareScanner({ databaseClock: () => clock.now(), read: (location, objectName, generation) => storage.read(location, objectName, generation) });
  const before = await clock.now();
  const report = await scanner.scan({ location: quarantine, objectName: quarantineName, generation: observation.generation, parts: inspection.expectedScanParts });
  const afterScan = await clock.now();
  assert.ok(clock.readings.includes(report.scannedAt) && before <= report.scannedAt && report.scannedAt <= afterScan, "the scan instant is a database reading inside the scan");
  const coverage = evaluateScanCoverage(inspection.expectedScanParts, report, { pinnedConfigHash: scanner.pinnedConfigHash }, { observedBytes: observation.bytes });
  assert.equal(coverage.scanState, "COVERED_CLEAN", JSON.stringify(coverage.reasons));
  assert.equal(coverage.coverage[0]?.scannedBytes, observation.bytes, "the container was read from the storage port: every byte of the observed generation");
  assert.equal(rejectionClassOfScan(coverage), undefined);

  // §12.1 step 4: promotion copies the exact generation with a no-overwrite precondition, then observes and re-reads the copy
  const acceptedName = acceptedObjectName(AGENCY, PROJECT, FILE);
  const promoted = await storage.copy({ location: quarantine, objectName: quarantineName, generation: observation.generation }, { location: accepted, objectName: acceptedName });
  const acceptedObservation = await storage.stat(accepted, acceptedName);
  assert.equal(acceptedObservation?.generation, promoted.generation);
  const reread: Buffer[] = [];
  for await (const chunk of storage.read(accepted, acceptedName, promoted.generation)) reread.push(Buffer.from(chunk));
  assert.equal(sha256(Buffer.concat(reread)), inspection.sha256, "the accepted generation re-reads to the inspected digest");
  await assert.rejects(
    storage.copy({ location: quarantine, objectName: quarantineName, generation: observation.generation }, { location: accepted, objectName: acceptedName }),
    (error: unknown) => error instanceof ContractFakeStorageError && error.code === "PRECONDITION_FAILED",
    "a second promotion never overwrites the accepted generation",
  );

  // the preview (D-SAPI-7) reads the admitted generation through the port and verifies it is the admitted bytes
  const preview = new IsolatedTablePreviewReader();
  const shown = await preview.preview({ open: () => storage.read(accepted, acceptedName, promoted.generation), sha256: inspection.sha256, bytes: inspection.bytes, format: "XLSX", ordinal: 0, limits: inspectionLimits(), scratchDir: scratch });
  assert.deepEqual(shown.rows.slice(0, 2), [["Id", "Name", "Email"], ["1", "Ana", "ana@example.test"]]);
  await assert.rejects(
    preview.preview({ open: () => storage.read(accepted, acceptedName, promoted.generation), sha256: sha256(Buffer.from("other bytes")), bytes: inspection.bytes, format: "XLSX", ordinal: 0, limits: inspectionLimits(), scratchDir: scratch }),
    (error: unknown) => error instanceof PreviewFailure && error.code === "ACCEPTED_GENERATION_MISMATCH",
    "bytes other than the admitted ones are never previewed",
  );

  // negative control: an out-of-band overwrite of the quarantine name leaves the observed generation unreadable (soft-deleted, no
  // versioning), and the scanner bound to that generation fails — the port never serves another generation in its place
  const overwritten = storage.plantObject(quarantine, quarantineName, new Uint8Array(Buffer.from("not the observed bytes")), { overwrite: true });
  assert.notEqual(overwritten.generation, observation.generation);
  await assert.rejects(
    scanner.scan({ location: quarantine, objectName: quarantineName, generation: observation.generation, parts: inspection.expectedScanParts }),
    (error: unknown) => error instanceof ContractFakeStorageError && error.code === "GENERATION_NOT_FOUND",
  );

  // labels (21 "Evidence classes"): every provider record of the composition is SIMULATED with a contract-fake-* token
  assert.deepEqual([storage.provider, storage.evidenceClass, scanner.engine, scanner.evidenceClass, FAKE_SCANNER_EVIDENCE_CLASS], [CONTRACT_FAKE_STORAGE_PROVIDER, "SIMULATED", FAKE_SCANNER_ENGINE, "SIMULATED", "SIMULATED"]);
  for (const token of [storage.provider, report.engine, report.engineVersion, report.signatureVersion]) assert.match(token, /^contract-fake-/);
  const reads = storage.calls("read");
  assert.ok(reads.length >= 4 && reads.every((c) => c.evidenceClass === "SIMULATED" && c.provider === CONTRACT_FAKE_STORAGE_PROVIDER), "every read is a logged, labelled provider call");
  assert.ok(reads.every((c) => c.request["generation"] === observation.generation || c.request["generation"] === promoted.generation), "every read names an exact generation");
  assert.ok(storage.calls().every((c) => !Object.values(c.request).includes(session.sessionRef)), "no call logs the bearer session reference");
  assert.ok(scanner.calls.every((c) => c.evidenceClass === "SIMULATED" && c.engine === FAKE_SCANNER_ENGINE && c.generation === observation.generation));
  assert.deepEqual(readdirSync(scratch), [], "every isolated attempt removed its own directory");
});
