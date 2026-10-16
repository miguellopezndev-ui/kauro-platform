/**
 * CSV writer for machine import artifacts.
 *
 * The contract for these files is MACHINE_IMPORT_CSV: the bytes carry exactly
 * the values the migration decided on. Nothing is prefixed, escaped for
 * spreadsheet display, or otherwise altered to make a file safer to
 * double-click, because that would change data the destination is about to
 * store. Values a spreadsheet would read as a formula are reported in a
 * separate warning artifact instead.
 */

const DELIMITER = ',';
const LINE_ENDING = '\n';

export function renderCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string {
  const lines = [headers.map(escapeField).join(DELIMITER)];
  for (const row of rows) {
    lines.push(row.map((value) => escapeField(value ?? '')).join(DELIMITER));
  }
  return `${lines.join(LINE_ENDING)}${LINE_ENDING}`;
}

/**
 * RFC 4180 quoting. A field is quoted when it contains the delimiter, a quote,
 * a carriage return or newline, or has leading or trailing whitespace that
 * would otherwise be lost or misread.
 */
export function escapeField(value: string): string {
  const needsQuotes =
    value.includes(DELIMITER) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    value.startsWith('\t') ||
    value.endsWith('\t');

  if (!needsQuotes) return value;
  return `"${value.split('"').join('""')}"`;
}
