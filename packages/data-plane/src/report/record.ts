/**
 * The report record: the durable statement of which PDF a package carries (B13 x B08; docs/design/B13-report-delivery.md §4).
 *
 * B08 records an attempt's staged artifacts by role, object, generation, SHA-256 and length, and publishes the copies. The PDF's
 * own row therefore carries `pdfSha256`; everything else the identity says (the model, the HTML, the package, the renderer, the
 * engine) and whose it is (agency, project, job, attempt) is this canonical document, staged beside the PDF under its own role and
 * published, hashed and revoked with it by the same mechanisms. It is written only after the PDF was stored and read back, so a
 * record existing means the stored bytes were the ones its identity names.
 */
import { canonicalBytes, isSha256Hex, parseCanonical, rawDigest } from "@kauro/contracts";
import type { PageSize, ReportPdfIdentity } from "@kauro/reports";
import type { ReportScope } from "./facts.js";

export const REPORT_PDF_ROLE = "report-pdf";
export const REPORT_RECORD_ROLE = "report-record";
export const REPORT_RECORD_DOMAIN = "KAURO_REPORT_PDF_RECORD_V1";

/** Where the PDF is stored and what was verified about it. `STAGED_VERIFIED` is not `PUBLISHED`: only B08's publication is. */
export interface ReportPdfRecord {
  readonly scope: ReportScope;
  readonly identity: ReportPdfIdentity;
  readonly pdf: { readonly objectName: string; readonly generation: string; readonly sha256: string; readonly byteLength: number };
  readonly stage: "STAGED_VERIFIED";
}

const SCOPE_KEYS = ["agencyId", "attemptId", "jobId", "projectId"] as const;
const IDENTITY_KEYS = ["byteLength", "engineId", "htmlSha256", "locale", "manifestSha256", "modelHash", "packageDigest", "packageId", "pageSize", "pdfSha256", "renderer", "reportId"] as const;
const IDENTITY_HASHES = ["htmlSha256", "manifestSha256", "modelHash", "packageDigest", "pdfSha256"] as const;

export function reportPdfRecordBytesOf(record: ReportPdfRecord): Uint8Array {
  const { agencyId, projectId, jobId, attemptId } = record.scope;
  const i = record.identity;
  return canonicalBytes({
    domain: REPORT_RECORD_DOMAIN,
    version: 1,
    payload: {
      scope: { agencyId, projectId, jobId, attemptId },
      identity: {
        reportId: i.reportId,
        packageId: i.packageId,
        packageDigest: i.packageDigest,
        manifestSha256: i.manifestSha256,
        modelHash: i.modelHash,
        htmlSha256: i.htmlSha256,
        renderer: i.rendererVersion,
        engineId: i.engineId,
        pageSize: i.pageSize,
        locale: i.locale,
        pdfSha256: i.pdfSha256,
        byteLength: i.byteLength,
      },
      pdf: { objectName: record.pdf.objectName, generation: record.pdf.generation, sha256: record.pdf.sha256, byteLength: record.pdf.byteLength },
      stage: record.stage,
    },
  });
}

const closed = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).sort().join() === [...keys].sort().join();

export type ReportPdfRecordReading = { readonly ok: true; readonly record: ReportPdfRecord } | { readonly ok: false; readonly problem: string };

/** Reads a record back: the closed wrapper and fields, the hashes as hashes, and the bytes exactly the canonical form of what they say. */
export function readReportPdfRecord(bytes: Uint8Array): ReportPdfRecordReading {
  const refuse = (problem: string): ReportPdfRecordReading => ({ ok: false, problem });
  let doc: unknown;
  try {
    doc = parseCanonical(Buffer.from(bytes).toString("utf8"));
  } catch {
    return refuse("NOT_CANONICAL");
  }
  if (!closed(doc, ["domain", "payload", "version"]) || doc["domain"] !== REPORT_RECORD_DOMAIN || doc["version"] !== 1) return refuse("NOT_A_REPORT_RECORD");
  const p = doc["payload"];
  if (!closed(p, ["identity", "pdf", "scope", "stage"]) || p["stage"] !== "STAGED_VERIFIED") return refuse("PAYLOAD_NOT_CLOSED");
  const scope = p["scope"];
  const id = p["identity"];
  const pdf = p["pdf"];
  if (!closed(scope, SCOPE_KEYS) || !SCOPE_KEYS.every((k) => typeof scope[k] === "string")) return refuse("SCOPE_NOT_CLOSED");
  if (!closed(id, IDENTITY_KEYS)) return refuse("IDENTITY_NOT_CLOSED");
  if (!IDENTITY_HASHES.every((k) => isSha256Hex(id[k]))) return refuse("IDENTITY_HASH_MALFORMED");
  for (const k of ["reportId", "packageId", "renderer", "engineId", "locale"] as const) if (typeof id[k] !== "string") return refuse("IDENTITY_FIELD_MALFORMED");
  if ((id["pageSize"] !== "LETTER" && id["pageSize"] !== "A4") || !Number.isSafeInteger(id["byteLength"]) || (id["byteLength"] as number) < 1) return refuse("IDENTITY_FIELD_MALFORMED");
  if (!closed(pdf, ["byteLength", "generation", "objectName", "sha256"]) || typeof pdf["objectName"] !== "string" || typeof pdf["generation"] !== "string" || !isSha256Hex(pdf["sha256"]) || !Number.isSafeInteger(pdf["byteLength"])) return refuse("PDF_NOT_CLOSED");
  const record: ReportPdfRecord = {
    scope: { agencyId: scope["agencyId"] as string, projectId: scope["projectId"] as string, jobId: scope["jobId"] as string, attemptId: scope["attemptId"] as string },
    identity: {
      reportId: id["reportId"] as string,
      packageId: id["packageId"] as string,
      packageDigest: id["packageDigest"] as string,
      manifestSha256: id["manifestSha256"] as string,
      modelHash: id["modelHash"] as string,
      htmlSha256: id["htmlSha256"] as string,
      rendererVersion: id["renderer"] as string,
      engineId: id["engineId"] as string,
      pageSize: id["pageSize"] as PageSize,
      locale: id["locale"] as string,
      pdfSha256: id["pdfSha256"] as string,
      byteLength: id["byteLength"] as number,
    },
    pdf: { objectName: pdf["objectName"], generation: pdf["generation"], sha256: pdf["sha256"] as string, byteLength: pdf["byteLength"] as number },
    stage: "STAGED_VERIFIED",
  };
  if (Buffer.compare(Buffer.from(reportPdfRecordBytesOf(record)), Buffer.from(bytes)) !== 0) return refuse("NOT_THE_CANONICAL_FORM");
  return { ok: true, record };
}

/**
 * What a consumer of a delivered package checks: the record is a record, it is this scope's, and the PDF bytes it was handed are
 * the ones it names. Returns the problems found (empty when the PDF is exactly the record's).
 */
export function reportRecordProblems(recordBytes: Uint8Array, pdfBytes: Uint8Array, scope: ReportScope): readonly string[] {
  const read = readReportPdfRecord(recordBytes);
  if (!read.ok) return [`RECORD_${read.problem}`];
  const { record } = read;
  const problems: string[] = [];
  if (!SCOPE_KEYS.every((k) => record.scope[k] === scope[k])) problems.push("SCOPE_DIFFERS");
  if (record.pdf.sha256 !== record.identity.pdfSha256 || record.pdf.byteLength !== record.identity.byteLength) problems.push("RECORD_INCONSISTENT");
  if (pdfBytes.byteLength !== record.pdf.byteLength) problems.push("PDF_LENGTH_DIFFERS");
  if (rawDigest(pdfBytes) !== record.pdf.sha256) problems.push("PDF_HASH_DIFFERS");
  return problems;
}
