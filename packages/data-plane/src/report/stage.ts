/**
 * The report stage of an attempt (B13 x B08; docs/design/B13-report-delivery.md §1, §2): the chain
 *
 *   readMigrationPackage -> buildReportModel -> generateReportPdf -> stage -> read back -> (B08) verify, copy, publish
 *
 * `produceStagedReport` is the chain up to the staged, read-back PDF; `ReportingExecutionEnvelope` is where it joins B08. It wraps
 * the core's `ExecutionEnvelopePort`: when the core COMPLETED, the package it staged is read back from the attempt's prefix by exact
 * generation (every file hashed against what the core's writer recorded), the report is produced from those bytes and the
 * platform's inputs, and the PDF and its record are staged through the same writer, before the host writes the staged manifest.
 * The manifest therefore names the report with the package; B08's existing steps do the rest. If any step fails the attempt ends
 * REFUSED (or CANCELLED/FENCED) with no manifest, so a package is never published without the report, and a report is never
 * published without its package. Only a refusal about the report's content or the platform's records ends the attempt REFUSED (terminal);
 * an infrastructure failure or an uncertain read-back is thrown, so the worker host reports a retryable error and the job takes over.
 */
import { rawDigest } from "@kauro/contracts";
import type { CancellationChannel, CancellationState, ExecutionEnvelopePort, ExecutionOutcome, ExecutionSubject, HostIo, ObjectStoragePort, StagedArtifact } from "@kauro/application";
import {
  buildReportModel,
  generateReportPdf,
  readMigrationPackage,
  ReportModelError,
  ReportPdfError,
  type PageSize,
  type PdfEngine,
  type VerifiedPackage,
  type VerifiedReport,
} from "@kauro/reports";
import { FencedArtifactWriter } from "../attempt/artifact-writer.js";
import { PACKAGE_MANIFEST_ROLE } from "../cores/migration-core-adapter.js";
import { ReportStageError } from "./errors.js";
import { assembleReportFacts, reportIdOf, reportPackageIdOf, type ReportInputsPort, type ReportScope } from "./facts.js";
import { StagedReportPdfPublisher, type StagedReportPdf } from "./publisher.js";

export interface ReportRenderConfig {
  readonly pageSize: PageSize;
  readonly locale: string;
  /** The renderer's explicit version (the identity of the report's layout); a different version is a different report. */
  readonly rendererVersion: string;
}

/** `readMigrationPackage` is in memory by design (B13 report model); a package beyond this is refused, not truncated. */
export const DEFAULT_MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

export interface ProduceStagedReportRequest {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly scope: ReportScope;
  readonly writer: FencedArtifactWriter;
  readonly storage: ObjectStoragePort;
  readonly inputs: ReportInputsPort;
  readonly engine: PdfEngine;
  readonly render: ReportRenderConfig;
  readonly cancellation: CancellationChannel;
}

export interface ProducedReport {
  readonly staged: StagedReportPdf;
  readonly report: VerifiedReport;
}

async function proceed(cancellation: CancellationChannel, what: string): Promise<void> {
  const state: CancellationState = await cancellation.check();
  if (state !== "CONTINUE") throw new ReportStageError("CANCELLED", `the attempt was ${state === "FENCED" ? "fenced" : "cancelled"} before ${what}`, { problems: [state] });
}

const codesOf = (error: ReportModelError): readonly string[] => [...new Set(error.problems.map((p) => p.code))];

/** The chain for one attempt's package. Throws `ReportStageError` for every refusal; anything else is an infrastructure failure. */
export async function produceStagedReport(request: ProduceStagedReportRequest): Promise<ProducedReport> {
  const { scope, writer } = request;
  const c = writer.capability;
  if (c.agencyId !== scope.agencyId || c.projectId !== scope.projectId || c.jobId !== scope.jobId || c.attemptId !== scope.attemptId) {
    throw new ReportStageError("SCOPE_FOREIGN", "the writer is not the attempt of the scope the report is for");
  }
  await proceed(request.cancellation, "reading the platform's inputs");
  const inputs = await request.inputs.read(scope);
  const facts = assembleReportFacts(scope, inputs, request.render.rendererVersion);
  const logo = inputs === null ? null : inputs.logo;

  let pkg: VerifiedPackage;
  try {
    pkg = readMigrationPackage(request.files);
  } catch (error) {
    if (error instanceof ReportModelError) throw new ReportStageError("PACKAGE_UNREADABLE", "the staged package is not a verifiable Migration Core 3.0.0 package", { problems: codesOf(error), cause: error });
    throw error;
  }
  let report: VerifiedReport;
  try {
    report = buildReportModel(pkg, facts);
  } catch (error) {
    if (error instanceof ReportModelError) throw new ReportStageError("MODEL_REFUSED", "the report model was refused", { problems: codesOf(error), cause: error });
    throw error;
  }
  if (report.countsBinding !== "BOUND") throw new ReportStageError("COUNTS_UNAVAILABLE", "a delivered report is bound to the platform's counts");

  await proceed(request.cancellation, "printing the report");
  let pdf;
  try {
    pdf = await generateReportPdf(report, { pageSize: request.render.pageSize, locale: request.render.locale, logo }, request.engine);
  } catch (error) {
    if (error instanceof ReportPdfError) throw new ReportStageError("PDF_FAILED", `the PDF could not be produced (${error.code})`, { problems: [error.code], cause: error });
    if (error instanceof ReportModelError) throw new ReportStageError("PDF_FAILED", "the report was refused for printing", { problems: codesOf(error), cause: error });
    throw error;
  }

  await proceed(request.cancellation, "staging the PDF");
  const publisher = new StagedReportPdfPublisher({
    writer,
    storage: request.storage,
    scope,
    binding: { reportId: reportIdOf(scope), packageId: reportPackageIdOf(scope), packageDigest: report.model.package.packageDigest, manifestSha256: report.model.package.manifestSha256, modelHash: report.modelHash },
  });
  return { staged: await publisher.publish(pdf), report };
}

// --- reading the package the core staged ----------------------------------------------------------------------------------------

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/**
 * The package the core staged, as the files `readMigrationPackage` reads: every staged artifact read back by its exact generation
 * and hashed against what the core's writer recorded, each file named by the manifest entry that claims its bytes. Refuses a package
 * with no manifest, one too large to read in memory, a read that does not match its record, or a staged file no manifest entry claims.
 */
export async function readStagedPackage(storage: ObjectStoragePort, staged: readonly StagedArtifact[], maxBytes: number = DEFAULT_MAX_PACKAGE_BYTES): Promise<Map<string, Uint8Array>> {
  const manifests = staged.filter((a) => a.role === PACKAGE_MANIFEST_ROLE);
  if (manifests.length !== 1) throw new ReportStageError("PACKAGE_NOT_STAGED", "the attempt staged no single package manifest");
  const total = staged.reduce((sum, a) => sum + a.byteLength, 0);
  if (total > maxBytes) throw new ReportStageError("PACKAGE_TOO_LARGE", `the staged package (${total} bytes) is larger than the ${maxBytes} bytes a report reads in memory`);
  const staging = storage.location("STAGING");
  const bytesOf = new Map<StagedArtifact, Buffer>();
  for (const artifact of staged) {
    const bytes = await collect(storage.read(staging, artifact.objectName, artifact.generation));
    if (bytes.byteLength !== artifact.byteLength || rawDigest(bytes) !== artifact.sha256) throw new ReportStageError("PACKAGE_UNREADABLE", "a staged file read back is not the bytes the core's writer recorded");
    bytesOf.set(artifact, bytes);
  }
  const manifestBytes = bytesOf.get(manifests[0] as StagedArtifact) as Buffer;
  let entries: Array<{ path: string; sha256: string; byteLength: number }>;
  try {
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { artifacts?: unknown };
    if (!Array.isArray(manifest.artifacts)) throw new Error("no artifacts");
    entries = manifest.artifacts.map((a: unknown) => {
      const e = a as { path?: unknown; sha256?: unknown; byteLength?: unknown };
      if (typeof e.path !== "string" || typeof e.sha256 !== "string" || typeof e.byteLength !== "number") throw new Error("entry");
      return { path: e.path, sha256: e.sha256, byteLength: e.byteLength };
    });
  } catch {
    throw new ReportStageError("PACKAGE_UNREADABLE", "the staged package manifest is not readable");
  }
  const files = new Map<string, Uint8Array>([["manifest.json", manifestBytes]]);
  const unused = new Set(staged.filter((a) => a.role !== PACKAGE_MANIFEST_ROLE));
  for (const entry of entries) {
    const match = [...unused].find((a) => a.sha256 === entry.sha256 && a.byteLength === entry.byteLength);
    if (match === undefined) continue; // readMigrationPackage names it ARTIFACT_MISSING
    unused.delete(match);
    files.set(entry.path, bytesOf.get(match) as Buffer);
  }
  if (unused.size > 0) throw new ReportStageError("PACKAGE_UNREADABLE", `${unused.size} staged file(s) are claimed by no manifest entry`);
  return files;
}

// --- the join with B08 ---------------------------------------------------------------------------------------------------------

export interface ReportingExecutionEnvelopeOptions {
  readonly inner: ExecutionEnvelopePort;
  readonly storage: ObjectStoragePort;
  readonly inputs: ReportInputsPort;
  readonly engine: PdfEngine;
  readonly render: ReportRenderConfig;
  readonly maxPackageBytes?: number;
}

export class ReportingExecutionEnvelope implements ExecutionEnvelopePort {
  readonly #o: ReportingExecutionEnvelopeOptions;

  constructor(options: ReportingExecutionEnvelopeOptions) {
    this.#o = options;
  }

  async execute(subject: ExecutionSubject, io: HostIo): Promise<ExecutionOutcome> {
    const outcome = await this.#o.inner.execute(subject, io);
    if (outcome.terminalCause !== "COMPLETED") return outcome;
    const stopped = (cause: ExecutionOutcome["terminalCause"], error: ReportStageError): ExecutionOutcome => ({
      ...outcome,
      terminalCause: cause,
      refusal: { code: `REPORT_${error.code}`, message: error.message },
    });
    if (!(io.writer instanceof FencedArtifactWriter)) return stopped("REFUSED", new ReportStageError("WRITER_UNSUPPORTED", "the report is staged through the attempt's FencedArtifactWriter"));
    const scope: ReportScope = { agencyId: subject.agencyId, projectId: subject.projectId, jobId: subject.jobId, attemptId: subject.attemptId };
    try {
      const files = await readStagedPackage(this.#o.storage, outcome.stagedArtifacts, this.#o.maxPackageBytes);
      const produced = await produceStagedReport({
        files,
        scope,
        writer: io.writer,
        storage: this.#o.storage,
        inputs: this.#o.inputs,
        engine: this.#o.engine,
        render: this.#o.render,
        cancellation: io.cancellation,
      });
      return { ...outcome, stagedArtifacts: [...outcome.stagedArtifacts, produced.staged.pdf, produced.staged.record] };
    } catch (error) {
      if (!(error instanceof ReportStageError)) throw error;
      // an uncertain answer from the storage proves nothing about the report: it is the worker's error (WORKER_ERROR), which a takeover
      // retries in a new attempt, not a refusal, which would end a paid job for a storage hiccup
      if (error.code === "VERIFICATION_UNCERTAIN") throw error;
      if (error.code === "CANCELLED") return stopped(error.problems[0] === "FENCED" ? "FENCED" : "CANCELLED", error);
      return stopped("REFUSED", error);
    }
  }
}
