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

/** A count as a percentage of its population with one decimal ("428 of 12,480" is "3.4%"); a count above its population is not a share. */
export function sharePercent(count: number, population: number): string {
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(population) || count < 0 || population < 1) throw new RangeError("a share needs a count and a positive population");
  if (count > population) throw new RangeError("a count never exceeds its population");
  return `${(Math.round((count * 1000) / population) / 10).toFixed(1)}%`;
}
