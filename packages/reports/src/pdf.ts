/**
 * The report as PDF bytes (design docs/design/B13-report-pdf.md). This module owns the contract, not the browser: a `PdfEngine`
 * prints the one HTML document `renderReportHtml` produced, and `generateReportPdf` binds the bytes it returns to the model, the
 * HTML and the package. The concrete engine (Chromium, scripts and network off) is an adapter: @kauro/data-plane.
 *
 * - Only a VerifiedReport is printed (`renderReportHtml` refuses anything else before any engine runs).
 * - The engine's answer is checked, not trusted: a PDF header and trailer, a non-empty body; otherwise nothing is returned.
 * - `pdfSha256` is SHA-256 of the exact bytes returned. Nothing here stores anything: `storage` says the bytes exist only in
 *   memory/local, and `ReportPdfPublisher` is the port a later phase implements to store and publish them.
 */
import { createHash } from "node:crypto";
import { renderReportHtml } from "./html.js";
import type { PageSize, RenderOptions } from "./html.js";
import type { VerifiedReport } from "./model.js";

export interface PdfPrintRequest {
  /** The complete, self-contained document from `renderReportHtml`. */
  readonly html: string;
  readonly pageSize: PageSize;
}

/** Prints an inert HTML document to PDF bytes. Implementations run with JavaScript and network disabled and throw on any failure. */
export interface PdfEngine {
  /** Pinned engine identity, e.g. "chromium/155.0.4283.45"; recorded beside the PDF. */
  readonly engineId: string;
  print(request: PdfPrintRequest): Promise<Uint8Array>;
}

export const PDF_ERROR_CODES = ["ENGINE_FAILED", "OUTPUT_INVALID"] as const;
export type PdfErrorCode = (typeof PDF_ERROR_CODES)[number];

/** A PDF that could not be produced. Never carries report content; `cause` is the engine's own error. */
export class ReportPdfError extends Error {
  override readonly name = "ReportPdfError";
  readonly code: PdfErrorCode;
  constructor(code: PdfErrorCode, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}

/** The relation between a PDF's bytes and everything it was printed from. */
export interface ReportPdfIdentity {
  readonly reportId: string;
  readonly packageId: string;
  readonly packageDigest: string;
  readonly manifestSha256: string;
  readonly modelHash: string;
  readonly htmlSha256: string;
  readonly rendererVersion: string;
  readonly engineId: string;
  readonly pageSize: PageSize;
  readonly locale: string;
  /** SHA-256 (hex) of `bytes`, exactly. */
  readonly pdfSha256: string;
  readonly byteLength: number;
}

export interface ReportPdf {
  readonly bytes: Uint8Array;
  readonly identity: ReportPdfIdentity;
  /** The bytes exist in memory only: no external storage has been written. A publisher changes this fact, not this module. */
  readonly storage: "NOT_PERSISTED";
}

/**
 * The interface that connects a generated PDF to package publication (not implemented in B13): it must store `bytes`, verify
 * that SHA-256 of what it stored equals `identity.pdfSha256`, and only then return the location. It returns the identity
 * unchanged so a caller can attach `pdfSha256` to the delivery record beside the ReportSnapshot's `modelHash`.
 */
export interface ReportPdfPublisher {
  publish(pdf: ReportPdf): Promise<{ readonly identity: ReportPdfIdentity; readonly location: string }>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The ReportPdfs `generateReportPdf` returned. A publisher accepts no other object, however well it is shaped. */
const GENERATED_PDFS = new WeakSet<object>();
export function isGeneratedReportPdf(value: unknown): value is ReportPdf {
  return typeof value === "object" && value !== null && GENERATED_PDFS.has(value);
}

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(Math.max(0, from), Math.max(0, to)));

/** What is wrong with the shape of PDF bytes (a cheap structural check: header, `startxref`, the end-of-file marker), or null. */
function structureProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 200) return "the output has too few bytes to be a report";
  if (ascii(bytes, 0, 5) !== "%PDF-") return "the output does not start with a PDF header";
  const tail = ascii(bytes, bytes.byteLength - 1024, bytes.byteLength);
  if (!tail.includes("startxref") || !/%%EOF\s*$/.test(tail)) return "the output has no PDF trailer";
  return null;
}

/** A copy of an engine's output, so nothing the engine still holds can change the bytes after they are hashed. */
function checkedPdf(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new ReportPdfError("OUTPUT_INVALID", "the engine did not return bytes");
  const problem = structureProblem(bytes);
  if (problem !== null) throw new ReportPdfError("OUTPUT_INVALID", problem);
  return Uint8Array.from(bytes);
}

export const PDF_CONSISTENCY_PROBLEMS = ["NOT_GENERATED", "BYTES_NOT_PDF", "LENGTH_DIFFERS", "HASH_DIFFERS"] as const;
export type PdfConsistencyProblem = (typeof PDF_CONSISTENCY_PROBLEMS)[number];

/**
 * Every way a ReportPdf's bytes depart from its identity, re-derived from the bytes now: the object is not one `generateReportPdf`
 * returned, the bytes are not a PDF, or their length or SHA-256 is not the identity's. Empty when the identity describes exactly
 * these bytes. A publisher calls it immediately before it stores, so bytes changed after generation are never stored as the report.
 */
export function reportPdfProblems(pdf: ReportPdf): readonly PdfConsistencyProblem[] {
  if (!isGeneratedReportPdf(pdf)) return ["NOT_GENERATED"];
  if (!(pdf.bytes instanceof Uint8Array) || structureProblem(pdf.bytes) !== null) return ["BYTES_NOT_PDF"];
  const problems: PdfConsistencyProblem[] = [];
  if (pdf.bytes.byteLength !== pdf.identity.byteLength) problems.push("LENGTH_DIFFERS");
  if (sha256(pdf.bytes) !== pdf.identity.pdfSha256) problems.push("HASH_DIFFERS");
  return problems;
}

export async function generateReportPdf(report: VerifiedReport, options: RenderOptions, engine: PdfEngine): Promise<ReportPdf> {
  const rendered = renderReportHtml(report, options); // refuses an unverified report or an unsafe logo before the engine is touched
  let output: unknown;
  try {
    output = await engine.print({ html: rendered.html, pageSize: options.pageSize });
  } catch (error) {
    if (error instanceof ReportPdfError) throw error;
    throw new ReportPdfError("ENGINE_FAILED", "the PDF engine could not print the report", error);
  }
  const bytes = checkedPdf(output);
  const m = report.model;
  const pdf: ReportPdf = Object.freeze({
    bytes,
    storage: "NOT_PERSISTED",
    identity: Object.freeze({
      reportId: m.reportId,
      packageId: m.packageId,
      packageDigest: m.package.packageDigest,
      manifestSha256: m.package.manifestSha256,
      modelHash: report.modelHash,
      htmlSha256: rendered.sha256,
      rendererVersion: m.rendererVersion,
      engineId: engine.engineId,
      pageSize: options.pageSize,
      locale: options.locale,
      pdfSha256: sha256(bytes),
      byteLength: bytes.byteLength,
    }),
  });
  GENERATED_PDFS.add(pdf);
  return pdf;
}
