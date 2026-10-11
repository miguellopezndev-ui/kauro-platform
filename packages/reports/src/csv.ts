/**
 * The narrow CSV reading the report model needs: strict UTF-8, RFC 4180 records (quoted fields may hold the delimiter, quotes
 * and line breaks), LF or CRLF endings. The model never trusts a row count the package declares about itself; it counts the
 * records in the bytes (CMD039-DENY "Matching manifest sums with wrong data … still fails").
 */

export class CsvError extends Error {
  override readonly name = "CsvError";
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new CsvError("not valid UTF-8");
  }
}

/** Every record of the text, the header included, as arrays of field values. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  if (text.length === 0) return records;
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (!atFieldStart) throw new CsvError(`quote inside an unquoted field at offset ${i}`);
      quoted = true;
      atFieldStart = false;
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      atFieldStart = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r") {
        if (text[i + 1] !== "\n") throw new CsvError(`bare carriage return at offset ${i}`);
        i++;
      }
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      atFieldStart = true;
      continue;
    }
    field += ch;
    atFieldStart = false;
  }
  if (quoted) throw new CsvError("unterminated quoted field");
  // A last record without a line ending still counts; a trailing line ending does not open an empty record.
  if (!atFieldStart || field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** The header and the data records; a file without a header is malformed, and every record has the header's width. */
export function readTable(bytes: Uint8Array): { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] } {
  const records = parseCsv(decodeUtf8(bytes));
  const header = records[0];
  if (header === undefined) throw new CsvError("no header record");
  const rows = records.slice(1);
  rows.forEach((row, index) => {
    if (row.length !== header.length) throw new CsvError(`record ${index + 1} has ${row.length} fields, the header has ${header.length}`);
  });
  return { header, rows };
}
