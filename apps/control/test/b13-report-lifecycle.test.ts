// B13 x B08 lifecycle on a real PostgreSQL 17 (docs/design/B13-report-delivery.md §6): what happens to a report when its authority is
// reversed or cancelled, when its attempt is stale, when the worker or the control plane dies at each step, when the same step runs
// twice, when a corrected report is made, and who can download what. The report is one more staged artifact of the attempt, so B08's
// guards decide, and these cases show their effect on the report specifically. See support/report-world.ts for what is simulated.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { REPORT_PDF_ROLE, REPORT_RECORD_ROLE, readReportPdfRecord, reportRecordProblems } from "@kauro/data-plane";
import type { ProcessingAttemptId, ProcessingJobId } from "@kauro/domain";
import { b08Product, type B08Product } from "./support/b08-product.js";
import { admitted, launched, observedDone, verifiedPrivate } from "./support/execution-world.js";
import { OTHER_OBJECT_ID, kitOf } from "./support/report-kit.js";
import { PACKAGE_RECORDS, defaultEngine, reportFixtureOf, startReportWorld, type ReportWorld } from "./support/report-world.js";

let w: ReportWorld;
let k: ReturnType<typeof kitOf>;
let product: B08Product;

before(async () => {
  w = await startReportWorld("b13-lifecycle");
  k = kitOf(w);
  product = b08Product(w);
});

after(async () => {
  await w.stop();
});

const CLEAN = "A-clean-multi-object" as const;
const FILES = PACKAGE_RECORDS[CLEAN].files;

const actorOf = (a: { readonly agencyId: string; readonly ownerUserId: string }) => ({ agencyId: a.agencyId, userId: a.ownerUserId });

/** CMD038 as the agency's owner asks it (a fresh step-up each time). */
async function download(a: { readonly agencyId: string; readonly ownerUserId: string }, packageId: string, artifactIds: string[]) {
  const proof = await w.h.recordStepUp(a.ownerUserId as never);
  return product.command<{ readonly artifacts: ReadonlyArray<{ readonly artifactId: string; readonly role: string; readonly sha256: string; readonly byteLength: number; readonly url: string }> }>(
    actorOf(a),
    "CMD038",
    { packageId },
    { artifactIds, assuranceProofRef: proof },
  );
}

/** A case of this file: whatever happens, the jobs it left live are ended, so one failure does not starve the next case. */
function lifecycle(title: string, body: () => Promise<void>): void {
  test(title, async () => {
    try {
      await body();
    } finally {
      await w.quiesce();
    }
  });
}

const problemText = (result: unknown): string => JSON.stringify((result as { problem?: unknown }).problem ?? result);

lifecycle("R2-045 for the report: a reversal while the worker is staging the package and its report — the package is verified but never AVAILABLE, it ends REVOKED with the PDF and its record retained privately, the entitlement is never DELIVERED and the report cannot be downloaded", async () => {
  const A = await w.agency("revoked");
  w.scenario(A, { packageName: CLEAN });
  const p = await w.paid(A, "revoked", { report: reportFixtureOf(CLEAN) });
  const { jobId, identity } = await admitted(w, p);
  const finish = w.host.holdNext("finish", identity);
  await launched(w, jobId);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  await finish.reached;
  await w.revoke(p);
  assert.equal((await w.authorization(p.authorizationId)).state, "REVOKED");
  finish.release();
  await observedDone(w, identity);
  assert.equal((await w.x.pipeline.verify(jobId as ProcessingJobId)).kind, "APPLIED");
  assert.equal((await w.packages(jobId))[0]?.state, "VERIFIED_PRIVATE", "the package, report included, is verified");
  await w.drain(w.x.consumers.executionControl);
  const job = await w.job(jobId);
  assert.deepEqual([job.state, job.cancel_reason_code], ["CANCELLED", "AUTHORIZATION_REVOKED"]);
  const [pkg] = await w.packages(jobId);
  assert.deepEqual([pkg?.state, pkg?.revocation_reason], ["REVOKED", "AUTHORIZATION_REVOKED"]);
  assert.equal((await w.x.pipeline.publish(jobId as ProcessingJobId)).kind, "REFUSED");
  assert.deepEqual((await w.events(pkg!.package_version_id)).map((e) => e.event_type), ["package_version.staged.v1", "package_version.verified_private.v1", "package_version.revoked.v1"], "never AVAILABLE");
  // the evidence is retained privately, report included, and the janitor keeps it
  const attempt = await w.attempt(jobId);
  assert.equal(await k.countOf("SELECT 1 FROM kauro.staged_artifacts WHERE attempt_id = $1 AND role IN ('report-pdf', 'report-record')", [attempt.attempt_id]), 2);
  await w.x.sweepers.stagingJanitor.sweep(w.units, 20);
  assert.equal((await k.stagingObjects(attempt.staging_prefix)).length, FILES + 3, "the package, the PDF, its record and the manifest stay, private");
  assert.equal(await k.countOf("SELECT 1 FROM kauro.delivery_artifacts WHERE job_id = $1", [jobId]), 0);
  assert.deepEqual(await w.objectsUnder("DELIVERY", `delivery/${A.agencyId}/`), []);
  assert.equal((await w.events(p.authorizationId)).filter((e) => e.event_type === "commercial_authorization.delivered.v1").length, 0);
  // not downloadable
  const answer = await download(A, pkg!.package_version_id, [OTHER_OBJECT_ID]);
  assert.notEqual(answer.kind, "COMPLETED");
  assert.match(problemText(answer), /PACKAGE_NOT_AVAILABLE/);
  await w.quiesce();
});

lifecycle("CMD037 for the report: a cancellation committed after the package and its report were verified and before the publication wins — the job ends CANCELLED, the package REVOKED, nothing is delivered and nothing is downloadable", async () => {
  const A = await w.agency("cancelled");
  w.scenario(A, { packageName: CLEAN });
  const p = await w.paid(A, "cancelled", { report: reportFixtureOf(CLEAN) });
  const { jobId } = await verifiedPrivate(w, p);
  // unpublished is not downloadable either: the package is VERIFIED_PRIVATE
  const [verified] = await w.packages(jobId);
  assert.equal(verified?.state, "VERIFIED_PRIVATE");
  const early = await download(A, verified!.package_version_id, [OTHER_OBJECT_ID]);
  assert.notEqual(early.kind, "COMPLETED");
  assert.match(problemText(early), /PACKAGE_NOT_AVAILABLE/);

  await w.cancel(p, jobId);
  assert.equal((await w.x.pipeline.publish(jobId as ProcessingJobId)).kind, "REFUSED");
  await w.drain(w.x.consumers.executionControl);
  const job = await w.job(jobId);
  assert.equal(job.state, "CANCELLED");
  const [pkg] = await w.packages(jobId);
  assert.equal(pkg?.state, "REVOKED");
  assert.equal(await k.countOf("SELECT 1 FROM kauro.delivery_artifacts WHERE job_id = $1", [jobId]), 0);
  assert.deepEqual(await w.objectsUnder("DELIVERY", `delivery/${A.agencyId}/`), []);
  assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED");
  const late = await download(A, pkg!.package_version_id, [OTHER_OBJECT_ID]);
  assert.notEqual(late.kind, "COMPLETED");
  assert.match(problemText(late), /PACKAGE_NOT_AVAILABLE/);
  await w.quiesce();
});

lifecycle("S056 for the report: the old attempt survives its takeover and has staged a valid package and report in its own prefix; they are never submitted, verified or published — the delivery holds the takeover's report, and its record names the takeover's attempt", async () => {
  const A = await w.agency("takeover");
  w.scenario(A, { packageName: CLEAN });
  const p = await w.paid(A, "takeover", { report: reportFixtureOf(CLEAN) });
  const { jobId, identity: old } = await admitted(w, p);
  w.host.survivesTermination(old, { reportsAfterFinish: "SUCCEEDED" });
  const beforeManifest = w.host.holdNext("manifest", old);
  await launched(w, jobId);
  await beforeManifest.reached; // the old worker has staged its package, its PDF and its record; its manifest is not written
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  const oldAttempt = await w.attempt(jobId, 1);
  assert.equal((await k.stagingObjects(oldAttempt.staging_prefix)).length, FILES + 2, "the old attempt's package and report are in its prefix");
  w.advance(150);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20); // the lease lapsed: terminate, abandon, take over at fence + 1
  assert.deepEqual([(await w.attempt(jobId, 1)).state, (await w.attempt(jobId, 1)).terminal_cause], ["ABANDONED", "LEASE_LAPSED"]);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  const takeover = await w.attempt(jobId, 2);
  await observedDone(w, takeover.identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.deepEqual([(await w.job(jobId)).state, (await w.job(jobId)).fence], ["READY", "2"]);

  // the old worker now finishes its manifest in its own prefix; its late submission is refused under its lost fence
  beforeManifest.release();
  await w.host.settled(old);
  const observed = await w.host.observe(old);
  assert.equal(observed.state, "SUCCEEDED");
  assert.ok(observed.manifest !== null);
  const late = await w.x.pipeline.submit(oldAttempt.attempt_id as ProcessingAttemptId, observed.manifest);
  assert.equal(late.kind, "REFUSED", JSON.stringify(late));
  assert.equal(await k.countOf("SELECT 1 FROM kauro.staged_manifests WHERE attempt_id = $1", [oldAttempt.attempt_id]), 0, "the old attempt submitted nothing");

  // what is delivered is the takeover's package and report, once
  const [pkg] = await w.packages(jobId);
  assert.deepEqual([pkg?.attempt_id, pkg?.state], [takeover.attempt_id, "AVAILABLE"]);
  const copies = await k.deliveredOf(pkg!.package_version_id);
  assert.equal(copies.length, FILES + 2);
  assert.equal(copies.filter((c) => c.role === REPORT_PDF_ROLE).length, 1);
  assert.equal(await k.countOf("SELECT 1 FROM kauro.delivery_artifacts WHERE attempt_id = $1", [oldAttempt.attempt_id]), 0);
  assert.equal((await w.objectsUnder("DELIVERY", `delivery/${A.agencyId}/`)).length, FILES + 2, "nothing of the old attempt reached the delivery location");
  const delivered = await k.deliveredPdf(jobId);
  const recordCopy = copies.find((c) => c.role === REPORT_RECORD_ROLE)!;
  const recordBytes = await k.bytesOf("DELIVERY", recordCopy.object_name, recordCopy.generation);
  const read = readReportPdfRecord(recordBytes);
  assert.ok(read.ok);
  assert.equal(read.record.scope.attemptId, takeover.attempt_id, "the delivered record names the attempt that was delivered");
  assert.notEqual(read.record.scope.attemptId, oldAttempt.attempt_id);
  assert.deepEqual(reportRecordProblems(recordBytes, delivered.bytes, { agencyId: A.agencyId, projectId: p.projectId, jobId, attemptId: takeover.attempt_id }), []);
  assert.equal((await k.stagingObjects(oldAttempt.staging_prefix)).length, FILES + 3, "the old attempt's package, report and manifest stay private for the janitor");
  await w.quiesce();
});

lifecycle("a worker that dies while the PDF is being printed, or while it is being stored, leaves no report behind: the takeover attempt produces the one that is delivered", async () => {
  // (1) killed while printing: the print is gated; the host kills the worker; the print returns to a dead process
  {
    const A = await w.agency("crash-print");
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let printing = (): void => undefined;
    const inPrint = new Promise<void>((resolve) => (printing = resolve));
    let engines = 0;
    w.scenario(A, {
      packageName: CLEAN,
      engine: () => {
        const real = defaultEngine();
        if (++engines > 1) return real;
        return {
          engineId: "gated/1",
          print: async (request) => {
            printing();
            await gate;
            return real.print(request);
          },
        };
      },
    });
    const p = await w.paid(A, "crash-print", { report: reportFixtureOf(CLEAN) });
    const { jobId, identity } = await admitted(w, p);
    await launched(w, jobId);
    await inPrint;
    await w.host.terminate(identity); // the worker's VM dies mid-print
    release();
    await w.host.settled(identity);
    await w.x.sweepers.attemptMonitor.sweep(w.units, 20); // observed TERMINATED: the attempt is abandoned and the lease taken over
    const dead = await w.attempt(jobId, 1);
    assert.deepEqual([dead.state, dead.terminal_cause], ["ABANDONED", "PROVIDER_JOB_TERMINATED"]);
    assert.equal((await k.stagingObjects(dead.staging_prefix)).length, FILES, "the dead attempt staged its package and no report");
    w.advance(150); // the dead worker's lease lapses on the server clock before the lease can be taken over
    await w.x.sweepers.attemptMonitor.sweep(w.units, 20); // the lease is taken over: attempt 2, claimed
    await w.x.sweepers.attemptMonitor.sweep(w.units, 20); // and launched by its own identity
    const second = await w.attempt(jobId, 2);
    await observedDone(w, second.identity);
    await w.drain(w.x.consumers.jobExecution);
    assert.equal((await w.job(jobId)).state, "READY");
    const [pkg] = await w.packages(jobId);
    assert.equal(pkg?.attempt_id, second.attempt_id);
    assert.equal((await k.deliveredOf(pkg!.package_version_id)).filter((c) => c.role === REPORT_PDF_ROLE).length, 1);
    assert.equal(await k.countOf("SELECT 1 FROM kauro.delivery_artifacts WHERE attempt_id = $1", [dead.attempt_id]), 0);
  }
  // (2) killed while the PDF is being stored: the worker is held at the creation of the PDF's upload session and killed there
  {
    const A = await w.agency("crash-store");
    let storing: ReturnType<typeof w.storage.holdNext> | undefined;
    w.scenario(A, {
      packageName: CLEAN,
      afterCore: async () => {
        storing ??= w.storage.holdNext("createResumableSession"); // the next session is the PDF's
      },
    });
    const p = await w.paid(A, "crash-store", { report: reportFixtureOf(CLEAN) });
    const { jobId, identity } = await admitted(w, p);
    await launched(w, jobId);
    await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
    while (storing === undefined) await new Promise((r) => setTimeout(r, 10));
    await storing.reached;
    await w.host.terminate(identity);
    storing.release();
    await w.host.settled(identity);
    await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
    const dead = await w.attempt(jobId, 1);
    assert.deepEqual([dead.state, dead.terminal_cause], ["ABANDONED", "PROVIDER_JOB_TERMINATED"]);
    for (const o of await k.stagingObjects(dead.staging_prefix)) assert.notEqual((await k.bytesOf("STAGING", o.objectName, o.generation)).subarray(0, 5).toString("latin1"), "%PDF-", "no PDF generation exists in the dead attempt's prefix");
    w.advance(150); // the dead worker's lease lapses on the server clock before the lease can be taken over
    await w.x.sweepers.attemptMonitor.sweep(w.units, 20); // the lease is taken over: attempt 2, claimed
    await w.x.sweepers.attemptMonitor.sweep(w.units, 20); // and launched by its own identity
    const second = await w.attempt(jobId, 2);
    await observedDone(w, second.identity);
    await w.drain(w.x.consumers.jobExecution);
    assert.equal((await w.job(jobId)).state, "READY");
    const [pkg] = await w.packages(jobId);
    assert.equal(pkg?.attempt_id, second.attempt_id);
    const copies = await k.deliveredOf(pkg!.package_version_id);
    assert.equal(copies.filter((c) => c.role === REPORT_PDF_ROLE).length, 1);
    assert.equal(copies.filter((c) => c.role === REPORT_RECORD_ROLE).length, 1);
  }
  await w.quiesce();
});

lifecycle("the control plane dying in verification, and a delivery copy whose answer is lost, change nothing about the report: the steps run again to one AVAILABLE package with one PDF and one record, each delivered once", async () => {
  const A = await w.agency("replay");
  w.scenario(A, { packageName: CLEAN });
  const p = await w.paid(A, "replay", { report: reportFixtureOf(CLEAN) });
  const { jobId, identity } = await admitted(w, p);
  await launched(w, jobId);
  await observedDone(w, identity);
  assert.equal((await w.job(jobId)).state, "VERIFYING");

  // verification: a second control-plane process whose verifier dies after the read-backs are recorded
  const crashing = w.planeWith({ verifier: { verify: () => Promise.reject(new Error("the process died in the verifier")) } });
  await assert.rejects(crashing.execution!.pipeline.verify(jobId as ProcessingJobId), /died in the verifier/);
  assert.equal((await w.packages(jobId))[0]?.state, "STAGED");
  assert.equal((await w.x.pipeline.verify(jobId as ProcessingJobId)).kind, "APPLIED");
  const attempt = await w.attempt(jobId);
  assert.deepEqual((await w.h.oracle.query<{ result: string }>("SELECT result FROM kauro.package_verifications WHERE attempt_id = $1", [attempt.attempt_id])).rows, [{ result: "VALID" }], "one verification, VALID");
  assert.equal((await w.packages(jobId))[0]?.state, "VERIFIED_PRIVATE");

  // delivery: the first copy is made and its answer is lost (TIMEOUT with its effect); the step is retried, never assumed
  w.storage.failNext("copy", { code: "TIMEOUT", applied: true });
  const first = await w.x.pipeline.publish(jobId as ProcessingJobId);
  assert.notEqual(first.kind, "APPLIED", "the publication waits for a certain answer");
  assert.equal((await w.packages(jobId))[0]?.state, "VERIFIED_PRIVATE");
  assert.equal(await k.countOf("SELECT 1 FROM kauro.staged_artifacts WHERE attempt_id = $1", [attempt.attempt_id]), FILES + 2);
  const second = await w.x.pipeline.publish(jobId as ProcessingJobId);
  assert.equal(second.kind, "APPLIED", JSON.stringify(second));
  const [pkg] = await w.packages(jobId);
  assert.equal(pkg?.state, "AVAILABLE");
  const copies = await k.deliveredOf(pkg!.package_version_id);
  assert.equal(copies.length, FILES + 2, "one delivery copy of each staged artifact");
  assert.equal(copies.filter((c) => c.role === REPORT_PDF_ROLE).length, 1);
  assert.equal((await w.objectsUnder("DELIVERY", `delivery/${A.agencyId}/`)).length, FILES + 2, "no object was delivered twice");

  // the step again, and its event again: nothing moves
  assert.equal((await w.x.pipeline.publish(jobId as ProcessingJobId)).kind, "REFUSED");
  await w.redeliver(w.x.consumers.jobExecution, await w.eventOf(pkg!.package_version_id, "package_version.verified_private.v1"));
  assert.equal((await k.deliveredOf(pkg!.package_version_id)).length, FILES + 2);
  assert.equal((await w.packages(jobId)).filter((x) => x.state === "AVAILABLE").length, 1);
  assert.equal((await w.authorization(p.authorizationId)).state, "DELIVERED");
  await w.quiesce();
});

lifecycle("a corrected report is another delivery: the first delivery's package, PDF, record and download stay exactly as they were, and the corrected one has its own identity", async () => {
  const A = await w.agency("corrected");
  const first = await k.delivered("corrected-1", CLEAN, { agency: A });
  const before = await k.deliveredPdf(first.jobId);
  const beforeCopies = await k.deliveredOf(before.packageVersionId);

  const second = await k.delivered("corrected-2", CLEAN, { agency: A, rendererVersion: "renderer-1.1.0" });
  assert.equal((await w.job(second.jobId)).state, "READY");
  const after = await k.deliveredPdf(second.jobId);

  // the first is untouched: still AVAILABLE, the same copies, the same bytes in the delivery location
  assert.equal((await w.job(first.jobId)).state, "READY");
  assert.equal((await w.packages(first.jobId))[0]?.state, "AVAILABLE");
  assert.deepEqual(await k.deliveredOf(before.packageVersionId), beforeCopies);
  assert.equal(k.sha256(await k.bytesOf("DELIVERY", before.copy.object_name, before.copy.generation)), before.copy.sha256);
  // the corrected one is another artifact under another package, with another identity
  assert.notEqual(after.packageVersionId, before.packageVersionId);
  assert.notEqual(after.copy.sha256, before.copy.sha256);
  assert.notEqual(after.copy.object_name, before.copy.object_name);
  const records = await Promise.all(
    [first.jobId, second.jobId].map(async (jobId) => {
      const [pkg] = await w.packages(jobId);
      const copy = (await k.deliveredOf(pkg!.package_version_id)).find((c) => c.role === REPORT_RECORD_ROLE)!;
      const read = readReportPdfRecord(await k.bytesOf("DELIVERY", copy.object_name, copy.generation));
      assert.ok(read.ok);
      return read.record;
    }),
  );
  assert.deepEqual(records.map((r) => r.identity.rendererVersion), ["renderer-1.0.0", "renderer-1.1.0"]);
  assert.notEqual(records[0]!.identity.modelHash, records[1]!.identity.modelHash);
  assert.equal(records[0]!.identity.manifestSha256, records[1]!.identity.manifestSha256, "the same package");
  assert.notEqual(records[0]!.scope.jobId, records[1]!.scope.jobId);
  // the first delivery is still downloadable
  const granted = await download(A, before.packageVersionId, [(await w.h.oracle.query<{ object_id: string }>("SELECT object_id FROM kauro.delivery_artifacts WHERE package_version_id = $1 AND role = $2", [before.packageVersionId, REPORT_PDF_ROLE])).rows[0]!.object_id]);
  assert.equal(granted.kind, "COMPLETED");
  await w.quiesce();
});

lifecycle("CMD038: only the agency that owns a delivered package can download its report, and what it is granted is the delivered PDF; a package that is not published grants nothing", async () => {
  const A = await w.agency("download");
  const { jobId, p } = await k.delivered("download", CLEAN, { agency: A });
  const { copy, bytes, packageVersionId } = await k.deliveredPdf(jobId);
  const objectId = (await w.h.oracle.query<{ object_id: string }>("SELECT object_id FROM kauro.delivery_artifacts WHERE package_version_id = $1 AND role = $2", [packageVersionId, REPORT_PDF_ROLE])).rows[0]!.object_id;
  const granted = await download(A, packageVersionId, [objectId]);
  assert.equal(granted.kind, "COMPLETED");
  const view = granted.kind === "COMPLETED" ? granted.view : null;
  assert.ok(view !== null);
  assert.deepEqual(view.artifacts.map((a) => [a.role, a.sha256, a.byteLength]), [[REPORT_PDF_ROLE, copy.sha256, bytes.byteLength]]);
  assert.equal(k.sha256(bytes), view.artifacts[0]!.sha256, "what is granted is the delivered PDF");
  // another agency does not see the package at all
  const stranger = await download(w.B, packageVersionId, [objectId]);
  assert.notEqual(stranger.kind, "COMPLETED");
  assert.match(problemText(stranger), /NOT_FOUND/);
  // an artifact of another package is not this package's
  const unknown = await download(A, packageVersionId, [OTHER_OBJECT_ID]);
  assert.notEqual(unknown.kind, "COMPLETED");
  assert.match(problemText(unknown), /ARTIFACT_NOT_FOUND/);
  assert.equal((await w.authorization(p.authorizationId)).state, "DELIVERED");
  await w.quiesce();
});
