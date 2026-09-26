/**
 * The inspection task, run inside the isolated child (decision D-ISO-1). It detects the format from the bytes, never from the
 * declaration (09: declared versus detected format; a CSV claim over a ZIP, or an XLSX claim over text, is reported, the receipt
 * decides FORMAT_MISMATCH), then inspects what it detected: an OOXML package through the hardened archive reader, text through the
 * CSV dialect inspection, anything else (a legacy or encrypted compound file, another archive) as UNSUPPORTED.
 *
 * Loaded inside the isolated child: only node built-ins and this package's child modules.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { InspectionRefusal, refusalOf, type Finding } from "../errors.js";
import { inspectCsv } from "../csv/inspect-csv.js";
import { inspectXlsx } from "../xlsx/inspect-xlsx.js";
import type { InspectPayload, RawInspection, RawProblem } from "./facts.js";

const INSPECTOR = "kauro-container-inspector";

function head(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function problemsOf(findings: ReadonlyArray<Finding>): RawProblem[] {
  return findings.slice(0, 256).map((f) => (f.part === undefined ? { code: f.code } : { code: f.code, partDigest: f.part }));
}

function refused(detectedFormat: RawInspection["detectedFormat"], findings: ReadonlyArray<Finding>, profile: RawInspection["profile"], checks: ReadonlyArray<string>, decompressedBytes: number): RawInspection {
  const refusal = refusalOf(findings) ?? "CORRUPT_STRUCTURE";
  return { detectedFormat, structureStatus: "STRUCTURE_INVALID", refusal, problems: problemsOf(findings), parts: [], tables: [], profile, checksCompleted: checks, decompressedBytes };
}

export async function run(payload: InspectPayload): Promise<RawInspection> {
  const limits = payload.limits;
  const magic = head(payload.input, 8);
  const base = { inspector: INSPECTOR, declaredFormat: payload.declaredFormat };
  if (magic.length >= 4 && magic[0] === 0x50 && magic[1] === 0x4b && (magic[2] === 0x03 || magic[2] === 0x05) && (magic[3] === 0x04 || magic[3] === 0x06)) {
    const archive = {
      maxEntries: limits.maxArchiveEntries,
      partBytes: limits.xlsxExpandedPartBytes,
      totalBytes: limits.xlsxExpandedTotalBytes,
      maxCompressionRatio: limits.maxCompressionRatio,
      ratioGraceBytes: payload.archive.ratioGraceBytes,
      centralDirectoryBytes: payload.archive.centralDirectoryBytes,
    };
    const facts = await inspectXlsx(payload.input, {
      archive,
      xml: { maxDepth: limits.maxXmlDepth, maxTokenChars: Math.max(65_536, limits.decodedCellBytes) },
      decodedCellBytes: limits.decodedCellBytes,
      columns: limits.columns,
      inventoryColumns: payload.archive.inventoryColumns,
    });
    const ooxml = facts.archive.names.some((n) => n.normalize("NFC").toLowerCase() === "[content_types].xml");
    const profile = {
      ...base,
      format: "XLSX",
      zip64: facts.archive.zip64,
      archiveEntries: facts.archive.entries.length,
      date1904: facts.date1904,
      sharedStrings: facts.sharedStrings,
      worksheets: facts.tables.length,
      usedRange: "ROWS_FIRST_TO_LAST_VALUE_COLUMNS_FROM_A",
      partBytesLimit: archive.partBytes,
      totalBytesLimit: archive.totalBytes,
      maxArchiveEntries: archive.maxEntries,
      maxCompressionRatio: archive.maxCompressionRatio,
      ratioGraceBytes: archive.ratioGraceBytes,
      maxXmlDepth: limits.maxXmlDepth,
      decodedCellBytes: limits.decodedCellBytes,
    };
    if (facts.findings.length > 0) return refused(ooxml ? "XLSX" : "UNSUPPORTED", facts.findings, profile, facts.checks, facts.meter.decompressedBytes);
    return {
      detectedFormat: "XLSX",
      structureStatus: "STRUCTURE_VALID",
      problems: [],
      parts: facts.parts,
      tables: facts.tables,
      profile,
      checksCompleted: ["FORMAT_DETECTED", ...facts.checks],
      decompressedBytes: facts.meter.decompressedBytes,
    };
  }
  if (magic.length >= 8 && magic.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    // a compound file: a legacy workbook or an encrypted OOXML package — neither is inspected (04: encryption is not ignored as harmless)
    return refused("UNSUPPORTED", [{ refusal: "UNSUPPORTED_FORMAT", code: "COMPOUND_FILE" }], { ...base, format: "UNSUPPORTED" }, ["FORMAT_DETECTED"], 0);
  }
  if (magic.length === 0) return refused("UNSUPPORTED", [{ refusal: "CORRUPT_STRUCTURE", code: "EMPTY_FILE" }], { ...base, format: "UNSUPPORTED" }, [], 0);
  try {
    const csv = await inspectCsv(payload.input, limits);
    const profile = {
      ...base,
      format: "CSV",
      encoding: csv.encoding.encoding,
      bom: csv.encoding.bom,
      delimiter: csv.delimiter,
      quote: "DOUBLE_QUOTE",
      lineEndings: csv.lineEndings,
      records: csv.records,
      headerCandidate: "FIRST_RECORD",
      decodedCellBytes: limits.decodedCellBytes,
      decodedRecordBytes: limits.decodedRecordBytes,
    };
    return {
      detectedFormat: "CSV",
      structureStatus: "STRUCTURE_VALID",
      problems: [],
      parts: [],
      tables: [csv.table],
      profile,
      checksCompleted: ["FORMAT_DETECTED", "CSV_ENCODING", "CSV_DIALECT", "CSV_RECORDS"],
      decompressedBytes: 0,
    };
  } catch (error) {
    if (!(error instanceof InspectionRefusal)) throw error;
    return refused(error.code === "CSV_NUL_CHARACTER" ? "UNSUPPORTED" : "CSV", [{ refusal: error.refusal, code: error.code }], { ...base, format: "CSV" }, ["FORMAT_DETECTED"], 0);
  }
}
