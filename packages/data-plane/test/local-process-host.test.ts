// B14-A: the real local executor (docs/design/B14-A-worker-executor.md §8). Every case starts real worker processes through
// LocalProcessWorkerHost: @kauro/migration-worker's entry under the Node permission model, the vendored Migration Core 3.0.0 in its
// isolated child, the sandboxed Chromium where a browser exists (CI requires one), the attempt envelope of B08 — confined to the
// attempt's own scratch, every object through the host's broker. EXECUTED_LOCAL for the host, the core and the browser; B07's object
// storage stays its labelled CONTRACT FAKE (SIMULATED) — no cloud storage exists locally. The effects asserted are what the storage, the
// host's durable records and the staged manifest hold, and which processes still exist.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readStagedManifest } from "@kauro/application";
import { REPORT_PDF_ROLE, REPORT_RECORD_ROLE, attemptScratchDirectoryOf, browserTempDirectoryOf, readReportPdfRecord, reportRecordProblems } from "../src/index.js";
import { collect } from "./support/attempt.js";
import { BROWSER, BROWSER_REQUIRED, localRig, plantedAttempt, readsFor } from "./support/local-host.js";

const skip = BROWSER === null && !BROWSER_REQUIRED ? "no Chromium-family browser (set KAURO_PDF_BROWSER)" : false;

test("B14-A OK (EXECUTED_LOCAL): one launch runs Migration Core 3.0.0 and the report in a confined worker process; the manifest names the package's files, the PDF and its record, each read back from the attempt's own prefix, and the PDF is the one its record names for this scope", { skip }, async () => {
  const rig = localRig();
  try {
    const planted = plantedAttempt(rig.storage, 1);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    const launch = await rig.host.launch(spec);
    assert.deepEqual([launch.outcome, launch.evidenceClass], ["LAUNCHED", "EXECUTED_LOCAL"], JSON.stringify(launch));
    const record = await rig.host.settled(spec.identity);
    assert.equal(record?.state, "SUCCEEDED", `${JSON.stringify(record)}
${rig.host.diagnostics(spec.identity)}`);
    const observed = await rig.host.observe(spec.identity);
    assert.deepEqual([observed.state, observed.evidenceClass, observed.cause], ["SUCCEEDED", "EXECUTED_LOCAL", null]);
    assert.ok(observed.manifest !== null);
    const staging = rig.storage.location("STAGING");
    const bytes = await collect(rig.storage.read(staging, observed.manifest.objectName, observed.manifest.generation));
    const manifest = readStagedManifest(bytes, {
      jobId: planted.fixture.jobId,
      attemptId: planted.fixture.attemptId,
      fence: 1,
      inputBindingHash: planted.fixture.subject.inputBindingHash,
      stagingPrefix: planted.fixture.prefix,
      manifestObjectName: planted.fixture.capability.manifestObjectName,
    });
    assert.ok(manifest.ok, JSON.stringify(manifest));
    const roles = manifest.payload.artifacts.map((a) => a.role);
    assert.ok(roles.includes("package-manifest"));
    assert.equal(roles.filter((r) => r === REPORT_PDF_ROLE).length, 1);
    assert.equal(roles.filter((r) => r === REPORT_RECORD_ROLE).length, 1);
    const pdf = manifest.payload.artifacts.find((a) => a.role === REPORT_PDF_ROLE)!;
    const recordArtifact = manifest.payload.artifacts.find((a) => a.role === REPORT_RECORD_ROLE)!;
    const pdfBytes = await collect(rig.storage.read(staging, pdf.objectName, pdf.generation));
    const recordBytes = await collect(rig.storage.read(staging, recordArtifact.objectName, recordArtifact.generation));
    assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(pdfBytes.byteLength > 10_000, "a real printed report");
    const scope = { agencyId: planted.fixture.agencyId, projectId: planted.fixture.projectId, jobId: planted.fixture.jobId, attemptId: planted.fixture.attemptId };
    assert.deepEqual(reportRecordProblems(recordBytes, pdfBytes, scope), []);
    const read = readReportPdfRecord(recordBytes);
    assert.ok(read.ok);
    // the attempt's scratch is gone with the attempt; the record is the host's durable evidence
    assert.equal(existsSync(attemptScratchDirectoryOf(rig.scratchRoot, planted.fixture.attemptId)), false);
    // and so is the browser's own temporary directory, which the host made beside it (short: the browser binds a socket there)
    assert.equal(existsSync(browserTempDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId)), false);
    assert.ok(record!.flags.includes("--permission"));
    assert.ok(record!.flags.some((f) => f.startsWith("--allow-fs-write=")));
    assert.deepEqual(readdirSync(join(rig.hostRoot, "jobs")), [spec.identity]);
    // the host's reading of the end came first: its supervisor is stood down for good, no verdict can follow (review round 7, R7-2)
    assert.equal(JSON.parse(readFileSync(join(rig.hostRoot, "jobs", spec.identity, "supervisor.json"), "utf8")).verdict, "STOOD_DOWN");
  } finally {
    await rig.dispose();
  }
});
