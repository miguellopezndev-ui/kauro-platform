/**
 * The bounded preview of one admitted table (10 "Upload and target routes": a preview endpoint returns a bounded authorized sample
 * with safe display escaping and no shared caching; decision D-SAPI-7: at most 20 rows of at most 50 columns, each cell at most 200
 * characters). The reader verifies the bytes it is given are the admitted generation (SHA-256 and length), parses them in the
 * isolated child (decision D-ISO-1) inside its own directory of the attempt scratch, removes that directory, and returns decoded
 * text only — the route escapes nothing itself: the UI escapes, the route sets no-store and never logs (B06 E-CACHE-1).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InspectionLimits } from "@kauro/application";
import type { CsvParserChoice, DeclaredFormat } from "@kauro/domain";
import type { Sha256Hex } from "@kauro/contracts";
import { ARCHIVE_BOUNDS, PREVIEW_BOUNDS, PREVIEW_READER_VERSION } from "../limits.js";
import { runIsolated } from "../sandbox/runner.js";
import { streamToFile } from "../inspector/container-inspector.js";
import type { PreviewPayload, PreviewResult } from "./preview-task.js";

const PREVIEW_TASK = join(dirname(fileURLToPath(import.meta.url)), "preview-task.js");

export interface TablePreviewRequest {
  /** Streams the accepted generation. */
  readonly open: () => AsyncIterable<Uint8Array>;
  /** The admitted file's digest and length: the bytes previewed must be exactly these. */
  readonly sha256: Sha256Hex;
  readonly bytes: number;
  readonly format: DeclaredFormat;
  /** The table: a CSV's single table (ordinal 0) or a worksheet by its ordinal. */
  readonly ordinal: number;
  /** A CSV dialect to read with (the agency's choice); absent: the inspection's discovery rule. */
  readonly csv?: Pick<CsvParserChoice, "encoding" | "delimiter" | "quote">;
  readonly limits: InspectionLimits;
  /** The scratch under which this preview creates, and removes, its own directory. */
  readonly scratchDir: string;
}

export interface TablePreview extends PreviewResult {
  readonly readerVersion: string;
}

export class PreviewFailure extends Error {
  constructor(readonly code: string) {
    super(`the preview could not be read (${code})`);
    this.name = "PreviewFailure";
  }
}

export class IsolatedTablePreviewReader {
  readonly version = PREVIEW_READER_VERSION;

  constructor(private readonly options: { readonly heapMegabytes?: number } = {}) {}

  async preview(request: TablePreviewRequest): Promise<TablePreview> {
    const attempt = mkdtempSync(join(realpathSync.native(request.scratchDir), "preview-"));
    try {
      const inputDir = join(attempt, "input");
      const workDir = join(attempt, "work");
      mkdirSync(inputDir);
      mkdirSync(workDir);
      const path = join(inputDir, "object");
      const streamed = await streamToFile(request.open, path, request.limits.fileBytes);
      if (!streamed.complete || streamed.sha256 !== request.sha256 || streamed.bytes !== request.bytes) throw new PreviewFailure("ACCEPTED_GENERATION_MISMATCH");
      const payload: PreviewPayload = {
        input: path,
        format: request.format,
        ordinal: request.ordinal,
        ...(request.csv === undefined ? {} : { csv: { encoding: request.csv.encoding, delimiter: request.csv.delimiter, quote: request.csv.quote } }),
        bounds: PREVIEW_BOUNDS,
        limits: {
          decodedCellBytes: request.limits.decodedCellBytes,
          decodedRecordBytes: request.limits.decodedRecordBytes,
          maxArchiveEntries: request.limits.maxArchiveEntries,
          xlsxExpandedPartBytes: request.limits.xlsxExpandedPartBytes,
          xlsxExpandedTotalBytes: request.limits.xlsxExpandedTotalBytes,
          maxCompressionRatio: request.limits.maxCompressionRatio,
          ratioGraceBytes: ARCHIVE_BOUNDS.ratioGraceBytes,
          centralDirectoryBytes: ARCHIVE_BOUNDS.centralDirectoryBytes,
          maxXmlDepth: request.limits.maxXmlDepth,
        },
      };
      const run = await runIsolated<PreviewResult>({
        task: PREVIEW_TASK,
        payload,
        readPaths: [path],
        workDir,
        timeoutMs: request.limits.wallClockMs,
        heapMegabytes: this.options.heapMegabytes ?? ARCHIVE_BOUNDS.childHeapMegabytes,
      });
      if (run.outcome === undefined || !run.outcome.ok) throw new PreviewFailure(run.timedOut ? "PREVIEW_WALL_CLOCK_LIMIT" : (run.outcome?.ok === false ? (run.outcome.error.code ?? run.outcome.error.name) : "PREVIEW_EXITED"));
      if (run.observers.outsideWriteAttempts + run.observers.networkAttempts + run.observers.processAttempts > 0) throw new PreviewFailure("ISOLATION_VIOLATION_OBSERVED");
      return { ...run.outcome.value, readerVersion: PREVIEW_READER_VERSION };
    } finally {
      rmSync(attempt, { recursive: true, force: true });
    }
  }
}
