/**
 * `ReportPdfPublisher` over the attempt's own writer (B13 x B08; docs/design/B13-report-delivery.md §2, §4).
 *
 * It stages a generated PDF as one more artifact of the attempt — through the same FencedArtifactWriter that staged the core's
 * package — so everything B08 already proves about an attempt's artifacts applies to the report unchanged: the generation-0
 * precondition, the fence and cancellation checks, the manifest naming it, the control plane's read-back by exact generation, the
 * verifier, the delivery copy with its own read-back, the publication guard, revocation and retention. This class adds only what B13
 * needs before the PDF may be called stored:
 *
 *   1. the object is a ReportPdf `generateReportPdf` returned, and its bytes still hash to its identity;
 *   2. its identity is this attempt's report (report, package, model) and the writer is this scope's;
 *   3. it is written once, under a name derived from the report and the PDF's hash, never over anything;
 *   4. the stored generation is read back by itself and hashes to `identity.pdfSha256`, whatever the writer concluded;
 *   5. only then is the record (identity, scope, location) staged beside it, and only then does `publish` answer.
 *
 * The answer says `STAGED_VERIFIED`. The PDF is not downloadable, not delivered and not published until B08's publication
 * transaction makes the package AVAILABLE; a result that stops short of that never claims it.
 *
 * Retries are safe: the same PDF again returns the same staged artifacts (re-verified); another PDF for the same attempt is refused
 * (one report per attempt; a corrected version is another attempt's artifact); an object under the name that this writer did not
 * write is refused and left in place as evidence; an uncertain read-back leaves the stored object as it is and says so.
 */
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import { stagedArtifactObjectNameOf, type ObjectStoragePort, type StagedArtifact, type StorageLocation } from "@kauro/application";
import { reportPdfProblems, type ReportPdf, type ReportPdfIdentity, type ReportPdfPublisher } from "@kauro/reports";
import type { FencedArtifactWriter } from "../attempt/artifact-writer.js";
import { ReportStageError } from "./errors.js";
import type { ReportScope } from "./facts.js";
import { REPORT_PDF_ROLE, REPORT_RECORD_ROLE, reportPdfRecordBytesOf } from "./record.js";

const WRITE_SLICE_BYTES = 1 << 20;

/** What the attempt's report is: the model it was built from and the package it is about. */
export interface ReportBinding {
  readonly reportId: string;
  readonly packageId: string;
  readonly packageDigest: string;
  readonly manifestSha256: string;
  readonly modelHash: string;
}

export interface StagedReportPdf {
  /** Stored and verified in the attempt's staging prefix; delivery is B08's publication, not this. */
  readonly stage: "STAGED_VERIFIED";
  readonly identity: ReportPdfIdentity;
  /** `<object name>#<generation>` in the STAGING zone. */
  readonly location: string;
  readonly pdf: StagedArtifact;
  readonly record: StagedArtifact;
}

export interface StagedReportPdfPublisherOptions {
  readonly writer: FencedArtifactWriter;
  readonly storage: ObjectStoragePort;
  readonly scope: ReportScope;
  readonly binding: ReportBinding;
}

const nameHash = (kind: "REPORT_PDF" | "REPORT_RECORD", binding: ReportBinding, pdfSha256: string): string => rawDigest(canonicalBytes({ kind, reportId: binding.reportId, pdfSha256 }));

/** The object a report's PDF is staged under: a function of the attempt's prefix, the report and the PDF's own hash. */
export function reportPdfObjectNameOf(stagingPrefix: string, reportId: string, pdfSha256: string): string {
  return stagedArtifactObjectNameOf(stagingPrefix, REPORT_PDF_ROLE, nameHash("REPORT_PDF", { reportId } as ReportBinding, pdfSha256));
}

export class StagedReportPdfPublisher implements ReportPdfPublisher {
  readonly #writer: FencedArtifactWriter;
  readonly #storage: ObjectStoragePort;
  readonly #staging: StorageLocation;
  readonly #scope: ReportScope;
  readonly #binding: ReportBinding;
  #staged: StagedReportPdf | null = null;
  #turn: Promise<unknown> = Promise.resolve();

  constructor(options: StagedReportPdfPublisherOptions) {
    const c = options.writer.capability;
    if (c.agencyId !== options.scope.agencyId || c.projectId !== options.scope.projectId || c.jobId !== options.scope.jobId || c.attemptId !== options.scope.attemptId) {
      throw new ReportStageError("SCOPE_FOREIGN", "the writer is not the attempt of the scope the report is for");
    }
    this.#writer = options.writer;
    this.#storage = options.storage;
    this.#staging = options.storage.location("STAGING");
    this.#scope = options.scope;
    this.#binding = options.binding;
  }

  /** The staged report once `publish` has answered, else null. */
  staged(): StagedReportPdf | null {
    return this.#staged;
  }

  publish(pdf: ReportPdf): Promise<StagedReportPdf> {
    // one call at a time: two concurrent calls with one PDF must not both open the same name
    const run = this.#turn.then(
      () => this.#publish(pdf),
      () => this.#publish(pdf),
    );
    this.#turn = run.catch(() => undefined);
    return run;
  }

  async #publish(pdf: ReportPdf): Promise<StagedReportPdf> {
    const problems = reportPdfProblems(pdf);
    if (problems.length > 0) throw new ReportStageError("PDF_NOT_GENUINE", `the PDF is not what generateReportPdf returned (${problems.join(", ")})`, { problems });
    const id = pdf.identity;
    const b = this.#binding;
    if (id.reportId !== b.reportId || id.packageId !== b.packageId || id.packageDigest !== b.packageDigest || id.manifestSha256 !== b.manifestSha256 || id.modelHash !== b.modelHash) {
      throw new ReportStageError("IDENTITY_FOREIGN", "the PDF is not this attempt's report (report, package or model differs)");
    }
    const pdfPathHash = nameHash("REPORT_PDF", b, id.pdfSha256);
    const pdfName = stagedArtifactObjectNameOf(this.#writer.capability.stagingPrefix, REPORT_PDF_ROLE, pdfPathHash);
    // one report per attempt, however many publishers there have been: the attempt's own writer is the record of what it staged
    if (this.#writer.artifacts().some((a) => a.role === REPORT_PDF_ROLE && a.objectName !== pdfName)) {
      throw new ReportStageError("REPORT_ALREADY_STAGED", "this attempt already staged another PDF; a corrected report is another attempt's artifact");
    }

    const stored = await this.#store(REPORT_PDF_ROLE, pdfPathHash, pdf.bytes);
    // the read-back of the stored generation, by itself and against the identity, before anything is recorded
    await this.#verify(stored, pdf);

    const record = reportPdfRecordBytesOf({
      scope: this.#scope,
      identity: id,
      pdf: { objectName: stored.objectName, generation: stored.generation, sha256: stored.sha256, byteLength: stored.byteLength },
      stage: "STAGED_VERIFIED",
    });
    const recorded = await this.#store(REPORT_RECORD_ROLE, nameHash("REPORT_RECORD", b, id.pdfSha256), record);

    this.#staged = Object.freeze({ stage: "STAGED_VERIFIED", identity: id, location: `${stored.objectName}#${stored.generation}`, pdf: stored, record: recorded });
    return this.#staged;
  }

  /** The artifact under `objectName`: the one this writer already closed, or the writer's new one. Never over another object. */
  async #store(role: string, pathHash: string, bytes: Uint8Array): Promise<StagedArtifact> {
    const objectName = stagedArtifactObjectNameOf(this.#writer.capability.stagingPrefix, role, pathHash);
    const sha256 = rawDigest(bytes);
    const known = this.#writer.artifacts().find((a) => a.objectName === objectName);
    if (known !== undefined) {
      if (known.role !== role || known.sha256 !== sha256 || known.byteLength !== bytes.byteLength) throw new ReportStageError("STORED_BYTES_DIFFER", `the artifact this writer closed under ${role}'s name is not these bytes`);
      return known;
    }
    let present: Awaited<ReturnType<ObjectStoragePort["stat"]>>;
    try {
      present = await this.#storage.stat(this.#staging, objectName);
    } catch (error) {
      throw new ReportStageError("VERIFICATION_UNCERTAIN", "the storage did not answer whether the name is free", { cause: error });
    }
    if (present !== null) throw new ReportStageError("OBJECT_NOT_THIS_WRITERS", `${role}'s name already holds a generation this writer did not write; it is left as it is`);
    const handle = this.#writer.open(role, pathHash);
    for (let offset = 0; offset < bytes.byteLength; offset += WRITE_SLICE_BYTES) await handle.write(bytes.subarray(offset, offset + WRITE_SLICE_BYTES));
    return handle.close();
  }

  async #verify(stored: StagedArtifact, pdf: ReportPdf): Promise<void> {
    const id = pdf.identity;
    if (stored.sha256 !== id.pdfSha256 || stored.byteLength !== id.byteLength) throw new ReportStageError("STORED_BYTES_DIFFER", "the staged artifact is not the PDF's bytes");
    let now: Awaited<ReturnType<ObjectStoragePort["stat"]>>;
    let hash: string;
    let length = 0;
    try {
      now = await this.#storage.stat(this.#staging, stored.objectName);
      const parts: Uint8Array[] = [];
      for await (const chunk of this.#storage.read(this.#staging, stored.objectName, stored.generation)) {
        length += chunk.byteLength;
        parts.push(chunk);
      }
      hash = rawDigest(Buffer.concat(parts));
    } catch (error) {
      // a transient failure proves nothing either way: the stored object stays, no record is made, a retry verifies again.
      // Any other failure to read the very generation that was written means that generation is not there to be recorded.
      if ((error as { transient?: unknown } | null)?.transient === true) throw new ReportStageError("VERIFICATION_UNCERTAIN", "the stored PDF could not be read back; it is kept and nothing is recorded", { cause: error });
      throw new ReportStageError("STORED_BYTES_DIFFER", "the generation that was written cannot be read back", { cause: error });
    }
    if (now === null || now.generation !== stored.generation) throw new ReportStageError("STORED_BYTES_DIFFER", "the stored object is no longer the generation that was written");
    if (length !== id.byteLength || hash !== id.pdfSha256) throw new ReportStageError("STORED_BYTES_DIFFER", "the stored bytes are not the PDF's identity (truncated, altered or another attempt's)");
  }
}

