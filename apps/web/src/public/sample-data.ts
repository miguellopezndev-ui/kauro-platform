// The synthetic delivery of the Sample delivery page (UI05; A3 3.6: the sample is labelled synthetic and never uses a real customer, logo,
// quote or import). Every number here is invented, and they reconcile: a shown percentage is its count over the population beside it, and
// each output file's rows are its source rows less the rows unified with approval, so the sample teaches the manifest correctly.
import type { PublicCopyId } from "../copy/public.ts";

export const SAMPLE = Object.freeze({
  contacts: 12_480,
  contactsFile: "contacts-clean.csv",
});

export interface ReportRow {
  readonly label: PublicCopyId;
  readonly count: number;
  /** The number the share is taken of, or null where a share means nothing (the file itself, a count of settings). */
  readonly population: number | null;
}

export const REPORT_ROWS: readonly ReportRow[] = Object.freeze([
  { label: "sample.report.contacts", count: SAMPLE.contacts, population: null },
  { label: "sample.report.duplicates", count: 428, population: SAMPLE.contacts },
  { label: "sample.report.emails", count: 191, population: SAMPLE.contacts },
  { label: "sample.report.company", count: 1_137, population: SAMPLE.contacts },
  { label: "sample.report.blockers", count: 3, population: null },
]);

export interface ManifestFile {
  readonly name: string;
  readonly rows: number;
  readonly source: number;
  /** Source rows unified into another row with the agency's approval. */
  readonly unified: number;
}

export const MANIFEST_FILES: readonly ManifestFile[] = Object.freeze([
  { name: SAMPLE.contactsFile, rows: 12_266, source: SAMPLE.contacts, unified: 214 },
  { name: "companies-clean.csv", rows: 2_951, source: 3_204, unified: 253 },
]);

/** What the preparation did to a record of the synthetic file, as the product window on Home shows it. */
export type RecordResult = "valid" | "normalised" | "candidate";

export interface SampleRecord {
  readonly name: string;
  /** The value as it arrived, when the preparation changed it. */
  readonly before: string | null;
  readonly email: string;
  readonly result: RecordResult;
}

/** Three invented records (reserved example.com addresses): one kept as it was, one normalised, one held for the customer's decision. */
export const SAMPLE_RECORDS: readonly SampleRecord[] = Object.freeze([
  { name: "Ana Ruiz", before: null, email: "ana.ruiz@example.com", result: "valid" },
  { name: "John Smith", before: "JOHN  SMITH", email: "john.smith@example.com", result: "normalised" },
  { name: "Maria Lopez", before: null, email: "m.lopez@example.com", result: "candidate" },
]);

/** A count as a percentage of its population with one decimal ("428 of 12,480" is "3.4%"); a count above its population is not a share. */
export function sharePercent(count: number, population: number): string {
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(population) || count < 0 || population < 1) throw new RangeError("a share needs a count and a positive population");
  if (count > population) throw new RangeError("a count never exceeds its population");
  return `${(Math.round((count * 1000) / population) / 10).toFixed(1)}%`;
}

/** Three invented client workspaces of an agency, for the illustration on Home; each is at a different phase of a project. */
export const SAMPLE_CLIENTS: ReadonlyArray<{ readonly name: string; readonly phase: "check" | "decide" | "ready" }> = Object.freeze([
  { name: "Northwind Data", phase: "ready" },
  { name: "Bluefin Retail", phase: "decide" },
  { name: "Atlas Logistics", phase: "check" },
]);

/** The source files a team uploads in the synthetic project, before anything is prepared. */
export const SAMPLE_SOURCES: readonly string[] = Object.freeze(["contacts.csv", "companies.xlsx"]);

/** A column the synthetic file names its own way, and the name the plan maps it to. */
export const SAMPLE_COLUMN = Object.freeze({ from: "E-mail", to: "Email" });

/** Three lines of the synthetic manifest: an output row, the source row it came from, and the rows unified into it with approval. */
export const SAMPLE_TRACE: ReadonlyArray<{ readonly output: number; readonly source: number; readonly unified: number | null }> = Object.freeze([
  { output: 1204, source: 1204, unified: null },
  { output: 1205, source: 1207, unified: 1209 },
  { output: 1206, source: 1210, unified: null },
]);
