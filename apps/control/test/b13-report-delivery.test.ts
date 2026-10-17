// B13 x B08 on a real PostgreSQL 17 (docs/design/B13-report-delivery.md §6): a job's worker produces the PDF report of the package it
// stages, inside the attempt, and B08's own steps — read-back by exact generation, verification, delivery copies with their read-back,
// the publication transaction — carry the report to delivery, or refuse it, exactly as they carry the package's files. Every assertion
// is on what the database and the storage hold afterwards. See support/report-world.ts for what is real and what is simulated.
// (Lifecycle cases — revocation, takeover, crashes, a corrected version, downloads — are in b13-report-lifecycle.test.ts.)
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { REPORT_PDF_ROLE, REPORT_RECORD_ROLE, readReportPdfRecord, reportRecordProblems } from "@kauro/data-plane";
import { admitted, launched, observedDone, type ReportFixture } from "./support/execution-world.js";
import { kitOf } from "./support/report-kit.js";
import { PACKAGE_RECORDS, hasBrowser, reportFixtureOf, sha256, startReportWorld, type PackageName, type ReportScenario, type ReportWorld } from "./support/report-world.js";

let w: ReportWorld;
let k: ReturnType<typeof kitOf>;

before(async () => {
  w = await startReportWorld("b13-delivery");
  k = kitOf(w);
});

after(async () => {
  await w.stop();
});

const CLEAN: PackageName = "A-clean-multi-object";
const SALESFORCE: PackageName = "D-salesforce";

for (const name of [CLEAN, SALESFORCE] as const) {
  test(`${name}: the worker's report is staged with the package, verified, copied and published by B08's steps; the delivered PDF is the one its record names, for this agency, project, job and attempt`, async () => {
    const { A, p, jobId } = await k.delivered(`delivered-${name.slice(0, 5).toLowerCase()}`, name);
    const job = await w.job(jobId);
    assert.deepEqual([job.state, job.terminal_reason, job.holds], ["READY", null, "NONE"]);
    assert.equal((await w.authorization(p.authorizationId)).state, "DELIVERED");
    const [pkg] = await w.packages(jobId);
    assert.equal(pkg?.state, "AVAILABLE");
    assert.equal(job.published_package_id, pkg?.package_version_id);
    const attempt = await w.attempt(jobId);
    assert.equal(attempt.state, "COMMITTED");

    // what the worker staged: the package's files and, beside them, the PDF and its record
    const staged = await k.stagedOf(attempt.attempt_id);
    assert.equal(staged.length, PACKAGE_RECORDS[name].files + 2);
    const stagedPdf = staged.filter((s) => s.role === REPORT_PDF_ROLE);
    assert.equal(stagedPdf.length, 1);
    assert.equal(staged.filter((s) => s.role === REPORT_RECORD_ROLE).length, 1);

    // what was delivered: a copy of every staged artifact, each read back from the delivery location and equal to the staged one
    const copies = await k.deliveredOf(pkg!.package_version_id);
    assert.deepEqual(
      copies.map((c) => [c.role, c.sha256, c.byte_length]).sort(),
      staged.map((s) => [s.role, s.sha256, s.byte_length]).sort(),
      "the delivery is exactly the staged set: the package's files, the PDF and its record",
    );
    for (const copy of copies) assert.equal(sha256(await k.bytesOf("DELIVERY", copy.object_name, copy.generation)), copy.sha256, `${copy.role} as delivered is the bytes recorded`);
    const readbacks = await w.h.oracle.query<{ result: string }>("SELECT result FROM kauro.artifact_readbacks WHERE attempt_id = $1 AND kind = 'DELIVERY'", [attempt.attempt_id]);
    assert.equal(readbacks.rowCount, copies.length);
    assert.ok(readbacks.rows.every((r) => r.result === "EQUAL"));

    // the delivered PDF is the one the delivered record names, and the record names this job's scope
    const pdf = copies.find((c) => c.role === REPORT_PDF_ROLE)!;
    const record = copies.find((c) => c.role === REPORT_RECORD_ROLE)!;
    const pdfBytes = await k.bytesOf("DELIVERY", pdf.object_name, pdf.generation);
    const recordBytes = await k.bytesOf("DELIVERY", record.object_name, record.generation);
    assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");
    if (hasBrowser) assert.ok(pdfBytes.byteLength > 10_000, "a real printed report, not a stub");
    const scope = { agencyId: A.agencyId, projectId: p.projectId, jobId, attemptId: attempt.attempt_id };
    assert.deepEqual(reportRecordProblems(recordBytes, pdfBytes, scope), []);
    const read = readReportPdfRecord(recordBytes);
    assert.ok(read.ok);
    assert.equal(read.record.identity.pdfSha256, stagedPdf[0]!.sha256, "the staged row of the PDF carries the identity's hash");
    assert.equal(read.record.identity.manifestSha256, PACKAGE_RECORDS[name].expectedManifestSha256, "the core's own manifest hash, bound by the validation receipt");
    assert.equal(read.record.identity.packageDigest, PACKAGE_RECORDS[name].packageDigest);
    assert.equal(read.record.stage, "STAGED_VERIFIED");
    const verification = await w.h.oracle.query<{ result: string }>("SELECT result FROM kauro.package_verifications WHERE attempt_id = $1", [attempt.attempt_id]);
    assert.deepEqual(verification.rows, [{ result: "VALID" }]);
    // another agency's records name none of this: the delivered record is not this job's under any other scope
    assert.notDeepEqual(reportRecordProblems(recordBytes, pdfBytes, { ...scope, agencyId: w.B.agencyId }), []);
    assert.notDeepEqual(reportRecordProblems(recordBytes, pdfBytes, { ...scope, projectId: "0192b000-0000-7000-8000-0000000000aa" }), []);
  });
}

test("the platform's records decide: a package other than the receipt's, counts the sealed source or the package's bytes do not support, terms nobody recorded, an unreadable issuer or a failed print end the attempt REFUSED with no manifest, no package, no delivery and the package files kept as evidence", async () => {
  const c = PACKAGE_RECORDS[CLEAN].counts;
  type Scenario = Partial<Omit<ReportScenario, "packageName">>;
  const cases: ReadonlyArray<readonly [string, Scenario, Partial<ReportFixture>]> = [
    ["a package other than the one the receipt bound", {}, { expectedManifestSha256: PACKAGE_RECORDS[SALESFORCE].expectedManifestSha256 }],
    ["receipt counts the package's bytes do not support", {}, { counts: { ...c, emittedRepresentatives: c.emittedRepresentatives - 1 } }],
    ["a receipt that disagrees with the sealed revision's populations", { inputs: (r) => (r === null ? r : { ...r, countFacts: { populations: r.countFacts!.populations, receiptCounts: { ...(r.countFacts!.receiptCounts as object), physicalSourceRows: 18 } } }) }, {}],
    ["no counts at all", { inputs: (r) => (r === null ? r : { ...r, countFacts: null }) }, {}],
    ["terms whose document is not the one the quote recorded", {}, { termsHash: "5".repeat(64) }],
    ["no terms snapshot", { inputs: (r) => (r === null ? r : { ...r, terms: null }) }, {}],
    ["no platform record of the report at all", { inputs: () => null }, {}],
    ["a print that fails", { engine: () => ({ engineId: "boom/1", print: () => Promise.reject(new Error("browser crashed")) }) }, {}],
    ["a print that returns something that is not a PDF", { engine: () => ({ engineId: "junk/1", print: () => Promise.resolve(new TextEncoder().encode("<html>no</html>".repeat(40))) }) }, {}],
  ];
  let n = 0;
  for (const [label, scenario, fixture] of cases) {
    const A = await w.agency(`refuse-${++n}`);
    w.scenario(A, { packageName: CLEAN, ...scenario });
    const p = await w.paid(A, `refuse-${n}`, { report: reportFixtureOf(CLEAN, fixture) });
    const { jobId, identity } = await admitted(w, p);
    await launched(w, jobId);
    await observedDone(w, identity);
    await w.drain(w.x.consumers.jobExecution);
    const job = await w.job(jobId);
    assert.deepEqual([job.state, job.terminal_reason], ["FAILED", "REFUSED"], label);
    const attempt = await w.attempt(jobId);
    assert.deepEqual([attempt.state, attempt.terminal_cause], ["FAILED", "REFUSED"], label);
    await k.assertNothingDelivered(jobId, A.agencyId);
    assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED", `${label}: never DELIVERED`);
    // the package the core staged is kept as evidence for the janitor; no report object exists
    const objects = await k.stagingObjects(attempt.staging_prefix);
    assert.equal(objects.length, PACKAGE_RECORDS[CLEAN].files, `${label}: the package's files and nothing else`);
    for (const o of objects) assert.notEqual((await k.bytesOf("STAGING", o.objectName, o.generation)).subarray(0, 5).toString("latin1"), "%PDF-", label);
  }
  await w.quiesce();
});

test("S061 for the report: a PDF that is partial, another report's or overwritten when the control plane reads it back fails the job by verification_failure with the exact problem, the package is REVOKED with its evidence kept and nothing is delivered; the intact neighbour publishes", async () => {
  const A = await w.agency("tamper");
  w.scenario(A, { packageName: CLEAN });
  const neighbour = await w.paid(A, "tamper-neighbour", { report: reportFixtureOf(CLEAN) });
  const n = await admitted(w, neighbour);
  await launched(w, n.jobId);
  await observedDone(w, n.identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(n.jobId)).state, "READY");
  const neighbourBytes = (await k.deliveredPdf(n.jobId)).bytes;

  const staging = w.storage.location("STAGING");
  const cases: ReadonlyArray<readonly [string, (name: string, bytes: Buffer) => void, string]> = [
    ["partial blob", (name, bytes) => void w.storage.plantObject(staging, name, bytes.subarray(0, bytes.length - 9), { overwrite: true }), "READBACK_PARTIAL_BLOB"],
    // the neighbour's PDF, padded where it is shorter so that the length is not what gives it away (a shorter blob is a partial one)
    ["another report's PDF", (name, bytes) => void w.storage.plantObject(staging, name, Buffer.concat([neighbourBytes, Buffer.alloc(Math.max(0, bytes.length - neighbourBytes.length))]), { overwrite: true }), "READBACK_FOREIGN_CONTENT"],
    ["an overwritten generation", (name, bytes) => void w.storage.plantObject(staging, name, bytes, { overwrite: true }), "READBACK_GENERATION_CHANGED"],
  ];
  for (const [label, tamper, problem] of cases) {
    const p = await w.paid(A, `tamper-${problem.toLowerCase()}`, { report: reportFixtureOf(CLEAN) });
    const { jobId, identity } = await admitted(w, p);
    const finish = w.host.holdNext("finish", identity);
    await launched(w, jobId);
    await finish.reached;
    const attemptBefore = await w.attempt(jobId);
    const pdf = await k.pdfObjectOf(attemptBefore.staging_prefix);
    tamper(pdf.objectName, await k.bytesOf("STAGING", pdf.objectName, pdf.generation));
    finish.release();
    await observedDone(w, identity);
    assert.equal((await w.job(jobId)).state, "VERIFYING", `${label}: the manifest itself is intact and submitted`);
    await w.drain(w.x.consumers.jobExecution);

    const job = await w.job(jobId);
    assert.deepEqual([job.state, job.terminal_reason], ["FAILED", problem], label);
    const attempt = await w.attempt(jobId);
    const readbacks = await w.h.oracle.query<{ object_name: string; result: string }>("SELECT object_name, result FROM kauro.artifact_readbacks WHERE attempt_id = $1 AND kind = 'STAGING'", [attempt.attempt_id]);
    assert.equal(readbacks.rowCount, PACKAGE_RECORDS[CLEAN].files + 2);
    assert.deepEqual(readbacks.rows.filter((r) => r.result !== "EQUAL").map((r) => [r.object_name, r.result]), [[pdf.objectName, "MISMATCH"]], `${label}: only the PDF fails its read-back`);
    const verification = (await w.h.oracle.query<{ result: string; problems: string[] }>("SELECT result, problems FROM kauro.package_verifications WHERE attempt_id = $1", [attempt.attempt_id])).rows;
    assert.deepEqual(verification, [{ result: "INVALID", problems: [problem] }], label);
    const [pkg] = await w.packages(jobId);
    assert.deepEqual([pkg?.state, pkg?.revocation_reason], ["REVOKED", "VERIFICATION_FAILED"], label);
    assert.deepEqual((await w.events(pkg!.package_version_id)).map((e) => e.event_type), ["package_version.staged.v1", "package_version.revoked.v1"], "never VERIFIED_PRIVATE, never AVAILABLE");
    assert.equal(await k.countOf("SELECT 1 FROM kauro.staged_artifacts WHERE attempt_id = $1", [attempt.attempt_id]), PACKAGE_RECORDS[CLEAN].files + 2, "the evidence is kept");
    assert.equal(await k.countOf("SELECT 1 FROM kauro.delivery_artifacts WHERE attempt_id = $1", [attempt.attempt_id]), 0, "nothing was copied for delivery");
    assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED", "never DELIVERED");
  }
  assert.equal((await w.job(n.jobId)).state, "READY", "the neighbour stays published");
  assert.equal((await w.packages(n.jobId))[0]?.state, "AVAILABLE");
  await w.quiesce();
});
