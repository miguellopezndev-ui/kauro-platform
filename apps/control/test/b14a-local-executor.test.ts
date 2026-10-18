// B14-A end to end on a real PostgreSQL 17 (docs/design/B14-A-worker-executor.md §8): B08's own control plane drives jobs whose attempts
// run in real, confined worker processes — LocalProcessWorkerHost starting @kauro/migration-worker — which execute the vendored Migration
// Core 3.0.0 over a sealed CSV of the core's own acceptance case A, print the B13 report with the sandboxed Chromium from the platform's
// records (PlatformReportInputs through the attempt ticket), and stage both through the host's broker; B08's steps then submit, read
// back, verify with Migration Core's own verifier, copy and publish.
//
// REAL (EXECUTED_LOCAL): the worker processes and their confinement, Migration Core 3.0.0 (validation and execution), the report chain,
// the browser, B08's control plane and store, the report's inputs, PostgreSQL 17. SYNTHETIC: the legal identity (the labelled TEST
// identity of @kauro/persistence/testing — no record holds the owner's yet). CONTRACT FAKE — SIMULATED: B07's object storage (no cloud
// storage exists locally) and the payment provider's capture (B09's fixtures). The superuser connection is the oracle only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";
import type { ExecutionLimits, ResumableUploadAnswer, ResumableUploadPort, WorkerHostPort } from "@kauro/application";
import type { RowCounts, Sha256Hex } from "@kauro/contracts";
import {
  MIGRATION_CORE_VERSION,
  MigrationCoreAdapter,
  REPORT_PDF_ROLE,
  REPORT_RECORD_ROLE,
  attemptScratchDirectoryOf,
  coreConfigHashOf,
  coreTimersOf,
  findChromiumExecutable,
  killProcessTree,
  readReportPdfRecord,
  reportRecordProblems,
  type AuthorizedReportInputs,
  type LocalProcessHostHooks,
  type ReportInputsPort,
} from "@kauro/data-plane";
import type { ProcessingJobId } from "@kauro/domain";
import { localExecutorOf, PlatformReportInputs, type ControlPlane, type ExecutionPlane, type LocalExecutor } from "../src/index.js";
import { ids, TEST_LIMITS, type Purchase, type SealedFile, type SealedSourceSpec } from "./support/execution-world.js";
import { kitOf } from "./support/report-kit.js";
import { RENDER, sha256, startReportWorld, type ReportWorld } from "./support/report-world.js";

// compiled to apps/control/dist/test: four levels up is the repository root
const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const WORKER_ENTRY = join(REPO_ROOT, "apps", "migration-worker", "dist", "src", "main.js");
const BROWSER = findChromiumExecutable(process.env["KAURO_PDF_BROWSER"] ?? null);
const skip = BROWSER === null && process.env["KAURO_REQUIRE_PDF_ENGINE"] !== "1" ? "no Chromium-family browser (set KAURO_PDF_BROWSER)" : false;
/** The SHA-256 of the vendored core tarball the platform records as the receipts' core package (vendor/MANIFEST.json). */
const CORE_PACKAGE_HASH = sha256(readFileSync(join(REPO_ROOT, "vendor", "kauro-migration-core-3.0.0.tgz")));
/** The wall clock of these tests (CK3 scans product code only). */
const WALL = { now: () => new Date().toISOString() as never, nowMs: () => Date.now() };
const LIMITS: ExecutionLimits = { ...TEST_LIMITS, scratchBudgetBytes: 8 << 20 };

// Migration Core's acceptance case A (cores/kauro-migration-core/test/fixtures/acceptance), its contacts file and mapping alone: the
// core's own synthetic people, every one a public historical name or plainly made up
const CASE_A = join(REPO_ROOT, "cores", "kauro-migration-core", "test", "fixtures", "acceptance", "A-clean-multi-object");
const CONTACTS = new Uint8Array(readFileSync(join(CASE_A, "input", "contacts.csv")));
const CASE_A_CONFIG = JSON.parse(readFileSync(join(CASE_A, "config.json"), "utf8")) as { files: Array<{ id: string }>; records: Array<{ fileId: string }>; [k: string]: unknown };

function bindingOf(file: { readonly objectName: string }): { readonly configDocument: Record<string, unknown>; readonly coreConfigHash: Sha256Hex } {
  const document = {
    ...CASE_A_CONFIG,
    files: CASE_A_CONFIG.files.filter((f) => f.id === "contacts").map((f) => ({ ...f, path: file.objectName })),
    records: CASE_A_CONFIG.records.filter((r) => r.fileId === "contacts"),
    associations: [],
  };
  return { configDocument: document, coreConfigHash: coreConfigHashOf(document) };
}

/** The core's own validation of a binding over the bytes (what PLAN_VALIDATION's receipt records): its counts and manifest hash. */
async function validated(file: SealedFile, binding: ReturnType<typeof bindingOf>, scratchRoot: string): Promise<{ readonly counts: RowCounts; readonly manifest: Sha256Hex }> {
  const attemptId = ids.next();
  mkdirSync(attemptScratchDirectoryOf(scratchRoot, attemptId), { recursive: true });
  const adapter = new MigrationCoreAdapter({
    attemptId,
    scratchRoot,
    inputs: { resolve: () => Promise.resolve([{ ...file, readConfig: { format: "CSV" as const, encoding: null, delimiter: null, sheets: null } }]) },
    documents: { planBinding: () => Promise.resolve(binding) },
    corePackageHash: CORE_PACKAGE_HASH,
    timers: coreTimersOf(WALL),
  });
  const source = { open: () => Promise.resolve({ byteLength: CONTACTS.byteLength, sha256: sha256(CONTACTS), read: async function* () { yield CONTACTS; } }) };
  const scratch = { usage: () => ({ bytes: 0, peakBytes: 0, quotaBytes: 0, segmentCount: 0, bytesWritten: 0, byFamily: [], framingBytesPerLine: 0 }) } as never;
  const r = await adapter.validate({ revisionHash: sha256("b14a-validation"), planBody: {} as never, planHash: sha256("b14a-plan"), targetContractHash: null, scratch, cancellation: { check: () => Promise.resolve("CONTINUE") }, controls: { limits: LIMITS, source, billableSourceUnits: 5 } });
  assert.equal(r.outcome, "VALID", JSON.stringify(r.problems));
  return { counts: r.receipt!.counts, manifest: r.receipt!.artifactEvidenceHash };
}

let w: ReportWorld;
let k: ReturnType<typeof kitOf>;
let root: string;
let counts: RowCounts;

const holder = (): ResumableUploadPort => ({ writeChunk: (ref, chunk, o): Promise<ResumableUploadAnswer> => Promise.resolve(w.storage.writeThroughSession(ref, chunk, o)) });

before(async () => {
  w = await startReportWorld("b14a");
  k = kitOf(w);
  root = mkdtempSync(join(tmpdir(), "kauro-b14a-e2e-"));
  // the populations the seal freezes: the core's own count of the file, under any name (a count never depends on a name)
  counts = (await validated({ objectName: "accepted/00000000-0000-7000-8000-000000000001/00000000-0000-7000-8000-000000000002/00000000-0000-7000-8000-000000000003", generation: "1", sha256: sha256(CONTACTS), byteLength: CONTACTS.byteLength }, bindingOf({ objectName: "accepted/00000000-0000-7000-8000-000000000001/00000000-0000-7000-8000-000000000002/00000000-0000-7000-8000-000000000003" }), join(root, "validation"))).counts;
});

after(async () => {
  await w.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const source: SealedSourceSpec = {
  bytes: CONTACTS,
  bindingOf,
  manifestOf: async (file, binding) => (await validated(file, binding as ReturnType<typeof bindingOf>, join(root, "validation"))).manifest,
};

interface Rig {
  readonly exec: LocalExecutor;
  readonly plane: ControlPlane;
  readonly x: ExecutionPlane;
  readonly scratchRoot: string;
}

let rigs = 0;
const live: Rig[] = [];

// every test leaves no live job and no running worker behind it (the next one needs the ACTIVE slot)
afterEach(async () => {
  for (const rig of live.splice(0)) await rig.exec.host.stop();
  await w.quiesce();
});
function rigOf(options: { readonly hooks?: LocalProcessHostHooks; readonly reportInputs?: ReportInputsPort; readonly host?: (h: WorkerHostPort) => WorkerHostPort } = {}): Rig {
  const n = ++rigs;
  const scratchRoot = join(root, `scratch-${n}`);
  const exec = localExecutorOf({
    units: w.units,
    ids,
    storage: w.storage,
    uploads: holder(),
    clock: w.hostClock,
    limits: LIMITS,
    ...(options.reportInputs === undefined ? {} : { reportInputs: options.reportInputs }),
    host: {
      workerEntry: WORKER_ENTRY,
      codeRoots: [REPO_ROOT],
      hostRoot: join(root, `host-${n}`),
      scratchRoot,
      chromiumExecutable: BROWSER!,
      render: RENDER,
      corePackageHash: CORE_PACKAGE_HASH,
      sessionOrigin: "https://app.kauro.test",
      workerHeapMegabytes: 512,
      coreHeapMegabytes: 512,
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    },
  });
  const plane = w.planeWith({ host: options.host?.(exec.host) ?? exec.host, verifier: exec.verifier, coreVersion: exec.coreVersion, workerScratchRoot: realpathSync.native(scratchRoot) });
  assert.ok(plane.execution !== null);
  const rig = { exec, plane, x: plane.execution, scratchRoot };
  live.push(rig);
  return rig;
}

async function purchase(label: string): Promise<Purchase> {
  const A = await w.agency(label);
  return w.paid(A, label, { report: { counts, expectedManifestSha256: "0".repeat(64) as Sha256Hex, source } });
}

/** Queues, admits and launches the purchase's job through the rig's plane; answers the job and its attempt's identity. */
async function launchedOn(rig: Rig, p: Purchase): Promise<{ readonly jobId: string; readonly identity: string }> {
  const job = await w.queue(p);
  await rig.x.sweepers.jobAdmission.admitRound();
  assert.equal((await w.job(job.jobId)).state, "ADMITTED");
  const step = await rig.x.pipeline.launchNext();
  assert.equal(step.kind, "APPLIED", JSON.stringify(step));
  return { jobId: job.jobId, identity: (await w.attempt(job.jobId)).identity };
}

/** The worker finished; ATTEMPT_MONITOR observes it, then JOB_EXECUTION verifies and publishes (the consumers B08 already has). */
async function observedAndDrained(rig: Rig, identity: string): Promise<void> {
  await rig.exec.host.settled(identity);
  await rig.x.sweepers.attemptMonitor.sweep(w.units, 50);
  await w.drain(rig.x.consumers.jobExecution);
}

test("B14-A OK (EXECUTED_LOCAL, end to end): a paid job's attempt runs in a confined worker process — Migration Core 3.0.0 over the sealed acceptance file, the B13 report from the platform's records printed by Chromium — and B08's own steps verify it with Migration Core's verifier and publish it: package AVAILABLE, job READY, entitlement DELIVERED, the delivered package exactly the one the validation receipt bound", { skip }, async () => {
  const rig = rigOf();
  const p = await purchase("b14a-ok");
  const { jobId, identity } = await launchedOn(rig, p);
  assert.equal((await w.attempt(jobId)).launch_state, "LAUNCHED");
  await observedAndDrained(rig, identity);
  const record = rig.exec.host.record(identity);
  assert.equal(record?.state, "SUCCEEDED", rig.exec.host.diagnostics(identity) ?? "");
  const job = await w.job(jobId);
  assert.deepEqual([job.state, job.terminal_reason, job.holds], ["READY", null, "NONE"]);
  assert.equal((await w.authorization(p.authorizationId)).state, "DELIVERED");
  const [pkg] = await w.packages(jobId);
  assert.equal(pkg?.state, "AVAILABLE");
  const attempt = await w.attempt(jobId);
  assert.equal(attempt.state, "COMMITTED");
  // Migration Core's own verifier, EXECUTED_LOCAL, under the core's version
  const verification = (await w.h.oracle.query<{ result: string; evidence_class: string; core_version: string }>("SELECT result, evidence_class, core_version FROM kauro.package_verifications WHERE attempt_id = $1", [attempt.attempt_id])).rows;
  assert.deepEqual(verification, [{ result: "VALID", evidence_class: "EXECUTED_LOCAL", core_version: MIGRATION_CORE_VERSION }]);

  // the delivery is exactly the staged set — the core's package, the PDF and its record — each read back equal
  const staged = await k.stagedOf(attempt.attempt_id);
  const copies = await k.deliveredOf(pkg!.package_version_id);
  assert.deepEqual(copies.map((c) => [c.role, c.sha256]).sort(), staged.map((s) => [s.role, s.sha256]).sort());
  assert.ok(staged.some((s) => s.role === "package-manifest"));
  const pdf = copies.find((c) => c.role === REPORT_PDF_ROLE)!;
  const recordCopy = copies.find((c) => c.role === REPORT_RECORD_ROLE)!;
  const pdfBytes = await k.bytesOf("DELIVERY", pdf.object_name, pdf.generation);
  const recordBytes = await k.bytesOf("DELIVERY", recordCopy.object_name, recordCopy.generation);
  assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdfBytes.byteLength > 10_000, "a real printed report");
  const scope = { agencyId: p.agency.agencyId, projectId: p.projectId, jobId, attemptId: attempt.attempt_id };
  assert.deepEqual(reportRecordProblems(recordBytes, pdfBytes, scope), []);
  const read = readReportPdfRecord(recordBytes);
  assert.ok(read.ok);
  const receipt = (await w.h.oracle.query<{ artifact_evidence_hash: string }>("SELECT r.artifact_evidence_hash FROM kauro.validation_receipts r JOIN kauro.processing_jobs j ON j.validation_receipt_hash = r.receipt_hash WHERE j.job_id = $1", [jobId])).rows[0];
  assert.equal(read.record.identity.manifestSha256, receipt?.artifact_evidence_hash, "the executed package is byte for byte the validated one");
  const packageManifest = staged.find((s) => s.role === "package-manifest")!;
  assert.equal(packageManifest.sha256, receipt?.artifact_evidence_hash);

  // the worker's evidence: its confinement on its own command line, its run on the host's durable record
  assert.ok(record!.flags.includes("--permission") && record!.flags.includes("--allow-child-process"));
  assert.ok(record!.flags.some((f) => f === `--allow-fs-write=${attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), attempt.attempt_id)}`));
  const evidence = process.env["KAURO_B14A_EVIDENCE_DIR"];
  if (evidence !== undefined) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "b14a-report.pdf"), pdfBytes);
    writeFileSync(join(evidence, "b14a-report-record.json"), recordBytes);
    writeFileSync(join(evidence, "b14a-host-record.json"), JSON.stringify(record, null, 2));
    writeFileSync(join(evidence, "b14a-delivery.json"), JSON.stringify({ job: job.state, package: pkg?.state, verification, copies: copies.map((c) => ({ role: c.role, sha256: c.sha256, bytes: c.byte_length })) }, null, 2));
  }

  // STAGING_JANITOR cleans the finished attempt: the host reports its resources, nothing of the attempt is left in scratch
  await rig.x.sweepers.stagingJanitor.sweep(w.units, 50);
  const cleanup = (await w.h.oracle.query<{ result: string; resource_report: string }>("SELECT result, resource_report FROM kauro.attempt_cleanups WHERE attempt_id = $1", [attempt.attempt_id])).rows;
  assert.deepEqual(cleanup, [{ result: "CLEANED", resource_report: "REPORTED" }]);
});

test("B14-A RACE (S056 through B08): the launch's answer is lost after the local host created the job — the pipeline records UNCERTAIN, ATTEMPT_MONITOR observes the identity before any other create and adopts it, and the one worker run is the one published", { skip }, async () => {
  let lost = 0;
  const rig = rigOf({
    host: (h) => ({
      evidenceClass: h.evidenceClass,
      creationHorizonSeconds: h.creationHorizonSeconds,
      launch: async (spec) => {
        await h.launch(spec);
        lost += 1;
        throw new Error("the launch's answer was lost");
      },
      observe: (id) => h.observe(id),
      terminate: (id) => h.terminate(id),
      resources: (id) => h.resources(id),
    }),
  });
  const p = await purchase("b14a-s056");
  const job = await w.queue(p);
  await rig.x.sweepers.jobAdmission.admitRound();
  const step = await rig.x.pipeline.launchNext();
  assert.deepEqual([step.kind, (step as { what?: string }).what], ["APPLIED", "LAUNCH_UNCERTAIN"]);
  const attempt = await w.attempt(job.jobId);
  assert.equal(attempt.launch_state, "UNCERTAIN");
  await observedAndDrained(rig, attempt.identity);
  assert.equal((await w.attempt(job.jobId)).launch_state, "LAUNCHED", "adopted by observation, never created again");
  assert.equal(lost, 1, "one create request");
  assert.equal((await w.job(job.jobId)).state, "READY");
});

test("B14-A cancellation (CMD037 while the worker runs): EXECUTION_CONTROL terminates the identity — the worker, the core's child and every process of the attempt end — the job is CANCELLED, nothing is delivered and the entitlement is never DELIVERED", { skip }, async () => {
  let reached: () => void = () => undefined;
  const atCore = new Promise<void>((r) => (reached = r));
  const rig = rigOf({ hooks: { atStage: (_id, stage) => (stage === "CORE_STARTED" ? (reached(), new Promise<void>(() => undefined)) : undefined) } });
  const p = await purchase("b14a-cancel");
  const { jobId, identity } = await launchedOn(rig, p);
  await atCore;
  await rig.x.sweepers.attemptMonitor.sweep(w.units, 50);
  assert.equal((await w.job(jobId)).state, "RUNNING");
  await w.cancel(p, jobId);
  await w.drain(rig.x.consumers.executionControl);
  await rig.x.sweepers.attemptMonitor.sweep(w.units, 50);
  await w.drain(rig.x.consumers.executionControl);
  const observed = await rig.exec.host.observe(identity);
  assert.equal(observed.state, "TERMINATED");
  assert.equal((await w.job(jobId)).state, "CANCELLED");
  await k.assertNothingDelivered(jobId, p.agency.agencyId);
  assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED");
  assert.equal(rig.exec.host.running().length, 0);
});

test("B14-A recovery (a worker killed mid-run, S075): the host observes the crash, B08 abandons the attempt and takes the lease over at fence 2 — a new identity, a new prefix, a new worker — which delivers; STAGING_JANITOR cleans the dead attempt's scratch", { skip }, async () => {
  let first: string | null = null;
  let reached: () => void = () => undefined;
  const atCore = new Promise<void>((r) => (reached = r));
  const rig = rigOf({
    hooks: {
      atStage: (id, stage) => {
        if (stage !== "CORE_STARTED") return undefined;
        first ??= id;
        if (id !== first) return undefined;
        reached();
        return new Promise<void>(() => undefined);
      },
    },
  });
  const p = await purchase("b14a-crash");
  const { jobId, identity } = await launchedOn(rig, p);
  await atCore;
  // the worker dies without a word (killed from outside its host, as an out-of-memory kill or a lost machine would)
  killProcessTree(rig.exec.host.record(identity)!.pid!);
  const dead = await rig.exec.host.settled(identity);
  assert.deepEqual([dead?.state, dead?.cause], ["FAILED", "WORKER_CRASHED"]);
  // one step per job per pass (D8-CEX-3): the crash abandons the attempt, the next pass takes the lease over, the next launches it
  await rig.x.sweepers.attemptMonitor.sweep(w.units, 50);
  assert.deepEqual((await w.attempts(jobId)).map((a) => [a.ordinal, a.state, a.terminal_cause]), [[1, "ABANDONED", "WORKER_CRASHED"]]);
  // the dead attempt's lease lapses on the server clock (B06: a takeover only after expiry), then the lease is taken over at fence 2
  w.advance(150);
  await rig.x.sweepers.attemptMonitor.sweep(w.units, 50);
  const attempts = await w.attempts(jobId);
  assert.deepEqual(attempts.map((a) => [a.ordinal, a.state]), [[1, "ABANDONED"], [2, "CLAIMED"]]);
  await rig.x.sweepers.attemptMonitor.sweep(w.units, 50);
  assert.equal((await w.attempt(jobId, 2)).state, "STARTING");
  const second = await w.attempt(jobId, 2);
  assert.notEqual(second.identity, identity);
  assert.equal(second.fence, "2");
  await observedAndDrained(rig, second.identity);
  assert.equal((await w.job(jobId)).state, "READY");
  await rig.x.sweepers.stagingJanitor.sweep(w.units, 50);
  const firstAttempt = attempts[0]!;
  const cleanup = (await w.h.oracle.query<{ result: string }>("SELECT result FROM kauro.attempt_cleanups WHERE attempt_id = $1", [firstAttempt.attempt_id])).rows;
  assert.deepEqual(cleanup.map((c) => c.result), ["CLEANED"]);
  assert.throws(() => readFileSync(attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), firstAttempt.attempt_id)), /ENOENT/);
});

test("B14-A B13 (no legal identity, the production state): when the platform's records hold no issuer document, the real worker refuses the report — the job ends FAILED REFUSED, nothing is published, the entitlement stays CONSUMED", { skip }, async () => {
  const platform = new PlatformReportInputs({ units: w.units, ids });
  const withoutIdentity: ReportInputsPort = {
    async read(scope): Promise<AuthorizedReportInputs | null> {
      const read = await platform.read(scope);
      if (read === null || read.terms === null || read.terms.binding !== "QUOTE_TERMS_V1" || read.terms.issuer === null) return read;
      return { ...read, terms: { ...read.terms, issuer: { ...read.terms.issuer, identity: null } } };
    },
  };
  const rig = rigOf({ reportInputs: withoutIdentity });
  const p = await purchase("b14a-issuer");
  const { jobId, identity } = await launchedOn(rig, p);
  await observedAndDrained(rig, identity);
  assert.equal(rig.exec.host.record(identity)?.refusal, "REPORT_ISSUER_UNAVAILABLE");
  const job = await w.job(jobId);
  assert.deepEqual([job.state, job.terminal_reason], ["FAILED", "REFUSED"]);
  await k.assertNothingDelivered(jobId, p.agency.agencyId);
  assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED");
  assert.equal((await w.attempt(jobId)).terminal_cause, "REFUSED");
  void (jobId as unknown as ProcessingJobId);
});
