// The rig of the report-delivery tests (B13 x B08): one processing attempt's real envelope (scratch store, fenced writer, generation
// reader) over B07's object-storage fake, a Migration Core 3.0.0 acceptance package staged exactly as MigrationCoreAdapter stages a
// package (same roles, same names from role and path hash), and engines whose PDFs are real (Chromium) or scripted.
// CONTRACT FAKE — SIMULATED: the storage; REAL: the writer, the scratch, the report chain and, where a browser exists, the PDF engine.
import { createHash } from "node:crypto";
import type { RowCounts } from "@kauro/contracts";
import type { CancellationChannel, ExecutionEnvelopePort, ExecutionOutcome, ExecutionSubject, HostIo, ObjectStoragePort, StagedArtifact } from "@kauro/application";
import { ContractFakeObjectStorage } from "@kauro/application/testing";
import { buildReportModel, readMigrationPackage } from "@kauro/reports";
import type { PdfEngine, PdfPrintRequest } from "@kauro/reports";
import { AttemptScratchStore, FencedArtifactWriter, GenerationSourceReader, type ReportScope } from "../../src/index.js";
import { SimulatedReportInputs, simulatedReportInputsOf, type SimulatedReportInputsSpec } from "../../src/testing/index.js";
import { SESSION_ORIGIN, attemptFixture, holderOf, limitsOf, manualChannel, type AttemptFixture } from "./attempt.js";
import { freshDir } from "./harness.js";
import { loadPackage, type CaseName } from "./report-fixtures.js";

const sha = (v: string | Uint8Array): string => createHash("sha256").update(v).digest("hex");

/** MigrationCoreAdapter's `roleOf`, mirrored (the adapter keeps it private): the area of a package file decides its staged role. */
export function packageRoleOf(file: string): string {
  if (file === "manifest.json") return "package-manifest";
  const map: Record<string, string> = { "01_IMPORT": "import", "02_EXCEPTIONS": "exceptions", "03_TRACEABILITY": "traceability", "04_DOCUMENTATION": "documentation" };
  return map[file.split("/")[0] ?? ""] ?? "package-file";
}

/** The manifest hash and the platform counts an acceptance package carries (the oracle the platform's records are made from). */
export function platformRecordOf(name: CaseName): { readonly expectedManifestSha256: string; readonly counts: RowCounts } {
  const files = loadPackage(name);
  const expectedManifestSha256 = sha(files.get("manifest.json") as Uint8Array);
  const unbound = buildReportModel(readMigrationPackage(files), {
    reportId: "rpt-probe",
    packageId: "pkg-probe",
    expectedManifestSha256,
    privacyClass: "SECURE_DETAIL",
    billableSourceUnits: 15,
    quoteId: "q-probe",
    branding: { version: "brand-probe", displayName: "Probe", logo: null },
    termsVersion: "terms-probe",
    termsSha256: "7".repeat(64),
    issuer: { legalName: "Probe S.A.S.", jurisdiction: "Colombia", registrationId: "PROBE-1" },
    findingIds: [],
    materialDecisionIds: [],
    rendererVersion: "renderer-probe",
    declaredCounts: null,
  });
  return { expectedManifestSha256, counts: unbound.snapshot.counts as RowCounts };
}

/** A PDF-shaped output that passes the engine's structural check, with `salt` making it different from another. */
export function scriptedPdf(salt = "a"): Uint8Array {
  const body = `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Salt (${salt}) >>\nendobj\n${"% filler\n".repeat(40)}trailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

export function scriptedEngine(output: (request: PdfPrintRequest, call: number) => Uint8Array | Promise<Uint8Array> = () => scriptedPdf()): PdfEngine & { calls: number } {
  const engine = {
    engineId: "scripted/1",
    calls: 0,
    async print(request: PdfPrintRequest): Promise<Uint8Array> {
      engine.calls += 1;
      return output(request, engine.calls);
    },
  };
  return engine;
}

/** The core's side of an attempt: stages an acceptance package through the writer the way the adapter does, and completes. */
export function acceptanceCore(name: CaseName, options: { readonly drop?: (path: string) => boolean; readonly extra?: Readonly<Record<string, Uint8Array>> } = {}): ExecutionEnvelopePort {
  return {
    async execute(_subject: ExecutionSubject, io: HostIo): Promise<ExecutionOutcome> {
      const files = new Map(loadPackage(name));
      for (const [path, bytes] of Object.entries(options.extra ?? {})) files.set(path, bytes);
      const staged: StagedArtifact[] = [];
      for (const path of [...files.keys()].sort()) {
        if (options.drop?.(path) === true) continue;
        const handle = io.writer.open(packageRoleOf(path), sha(path));
        await handle.write(files.get(path) as Uint8Array);
        staged.push(await handle.close());
      }
      return { evidenceClass: "SIMULATED", terminalCause: "COMPLETED", stagedArtifacts: staged, reconciliationSummary: { ok: true }, resourceMetrics: { peakMemoryBytes: 0, peakScratchBytes: 0, wallClockMs: 0 } };
    },
  };
}

export interface Rig {
  readonly fixture: AttemptFixture;
  readonly scope: ReportScope;
  /** The provider fake, for inspection. */
  readonly fake: ContractFakeObjectStorage;
  /** What the attempt's writer and reader use: the fake, or a wrapper of it the test gave. */
  readonly storage: ObjectStoragePort;
  readonly scratch: AttemptScratchStore;
  readonly writer: FencedArtifactWriter;
  readonly channel: CancellationChannel & { state: "CONTINUE" | "CANCELLED" | "FENCED"; checks: number };
  readonly io: HostIo;
}

export interface RigOptions {
  readonly fake?: ContractFakeObjectStorage;
  readonly wrap?: (fake: ContractFakeObjectStorage) => ObjectStoragePort;
  readonly job?: number;
  readonly agency?: number;
  readonly rewrite?: (chunk: Uint8Array, final: boolean) => Uint8Array;
  readonly channel?: ReturnType<typeof manualChannel>;
}

/** One attempt's envelope. `n` is the attempt; two rigs over one storage with one `job` are two attempts of that job. */
export function rig(n: number, options: RigOptions = {}): Rig {
  const fake = options.fake ?? new ContractFakeObjectStorage({ chunkMultipleBytes: 1024 });
  const storage: ObjectStoragePort = options.wrap === undefined ? fake : options.wrap(fake);
  const fixture = attemptFixture(n, { ...(options.job === undefined ? {} : { job: options.job }), ...(options.agency === undefined ? {} : { agency: options.agency }) });
  const scratch = new AttemptScratchStore({ root: freshDir("report-rig"), attemptId: fixture.attemptId, quotaBytes: 64 << 20 });
  const channel = options.channel ?? manualChannel();
  const writer = new FencedArtifactWriter({
    capability: fixture.capability,
    storage,
    uploads: holderOf(fake, options.rewrite),
    scratch,
    cancellation: channel,
    origin: SESSION_ORIGIN,
    timeoutMs: 30_000,
    uploadChunkBytes: 64 * 1024,
  });
  const source = new GenerationSourceReader({ capability: fixture.capability, storage });
  const scope: ReportScope = { agencyId: fixture.agencyId, projectId: fixture.projectId, jobId: fixture.jobId, attemptId: fixture.attemptId };
  const io: HostIo = { source, scratch, writer, cancellation: channel, limits: limitsOf(64 << 20) };
  return { fixture, scope, fake, storage, scratch, writer, channel, io };
}

/** The platform's inputs for `scope` as the simulator answers them, for an acceptance package. */
export function inputsFor(name: CaseName, spec: Partial<SimulatedReportInputsSpec> = {}, overrides: Parameters<typeof simulatedReportInputsOf>[2] = {}): SimulatedReportInputs {
  const record = platformRecordOf(name);
  return new SimulatedReportInputs((scope) => simulatedReportInputsOf(scope, { ...record, ...spec }, overrides));
}

export { sha };
