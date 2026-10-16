import { MigrationError } from '../domain/errors.js';
import { escapeField } from './csv-writer.js';

/** A numbered part, spelled the way `numberedPartPath` writes one. */
const NUMBERED_PART = /-[0-9]{3}([.][^.]*)?$/u;

/**
 * Cutting an import file that is larger than the destination will accept.
 *
 * Every destination this engine writes for states a maximum size for one import
 * file, and the verifier enforces it: a package carrying a file above that
 * maximum is refused rather than delivered, because handing an operator an
 * artifact the vendor rejects at upload is worse than saying so here.
 *
 * Until this module existed there was nothing between those two facts. The
 * engine could produce exactly one file per object, so a migration whose values
 * were wide enough — 200,000 records of long text, which is an ordinary CRM with
 * long notes on it — built a 1,649,699,836-byte file against a limit of
 * 1,073,741,824, reconciled perfectly, and then could not be delivered at all.
 * The migration was correct and the package was undeliverable, which is a
 * missing capability rather than a wrong check.
 *
 * ---- what a cut has to be ----
 *
 * **Deterministic, and derived from the bytes.** The same records in the same
 * order have to produce the same cut every time, or two runs of one migration
 * would deliver different files and nothing downstream could be compared. So the
 * boundary is decided by measuring the bytes each row will occupy, in the order
 * the family already fixes, and cutting where the next row would take the part
 * past the limit. Nothing here consults a row count, a guess at an average
 * width, or the clock.
 *
 * **Visible in the crosswalk.** `03_TRACEABILITY/import-crosswalk.csv` says
 * which file each record landed in and at which row. Both halves have to agree
 * with where the record actually is, so the plan is computed once and handed to
 * the renderer and to the crosswalk, rather than each working it out and
 * agreeing by luck.
 *
 * **Invisible when it is not needed.** A table that fits keeps the name it has
 * always had. Parts appear only when there is more than one, so the overwhelming
 * majority of packages are byte-identical to what they were before this existed.
 *
 * **Fail closed on the case it cannot serve.** A single record whose own row is
 * larger than the destination will accept cannot be delivered by any partition,
 * and no cut makes it deliverable. That is refused here, naming the record,
 * rather than emitted as an over-size part for the verifier to catch later.
 */

/** The bytes one CSV row occupies, including its line ending, as the writer will write it. */
export function renderedRowBytes(cells: readonly (string | null)[]): number {
  let bytes = 1; // the line ending
  for (let index = 0; index < cells.length; index += 1) {
    if (index > 0) bytes += 1; // the delimiter
    bytes += Buffer.byteLength(escapeField(cells[index] ?? ''), 'utf8');
  }
  return bytes;
}

/**
 * How many records each part of one import file holds.
 *
 * Returns one entry per part, in order. A table that fits in the limit returns a
 * single entry, which is also what an empty table returns — a destination that
 * expects a file for an object it maps still gets one, with a header and no
 * rows.
 *
 * The rows are walked once and one at a time. Nothing is collected: the
 * measurement is a running total, and what comes back is a list of counts whose
 * length is the number of parts rather than the number of records.
 */
export function planImportParts(
  headers: readonly string[],
  rows: Iterable<readonly (string | null)[]>,
  maxFileBytes: number,
  describe: (index: number) => string,
): number[] {
  const headerBytes = renderedRowBytes(headers);
  const counts: number[] = [];
  let inThisPart = 0;
  let bytes = headerBytes;
  let index = 0;

  for (const row of rows) {
    const rowBytes = renderedRowBytes(row);
    if (headerBytes + rowBytes > maxFileBytes) {
      // No cut helps: this one record, alone, with only the header above it, is
      // already larger than the destination accepts.
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `${describe(index)} would occupy ${String(rowBytes)} bytes in an import file, and one row with its header already exceeds the ${String(maxFileBytes)} bytes this destination accepts`,
        'Shorten the values on that record, or map fewer fields for this object. Splitting the file cannot help: the row itself is too large.',
        { limit: 'maxFileBytes', allowed: maxFileBytes, actual: rowBytes + headerBytes },
      );
    }
    if (inThisPart > 0 && bytes + rowBytes > maxFileBytes) {
      counts.push(inThisPart);
      inThisPart = 0;
      bytes = headerBytes;
    }
    bytes += rowBytes;
    inThisPart += 1;
    index += 1;
  }
  counts.push(inThisPart);
  return counts;
}

/**
 * The path of one part.
 *
 * `parts === 1` gives the base path unchanged, which is what keeps every package
 * that does not need cutting exactly as it was. Beyond that the number is
 * three digits before the extension, zero-padded so the parts sort in the order
 * they are meant to be imported in — an operator reading a directory listing
 * sees the order, and so does anything that sorts paths, which this package
 * format does in several places.
 */
export function importPartPath(basePath: string, part: number, parts: number): string {
  return parts <= 1 ? basePath : numberedPartPath(basePath, part);
}

/** The numbered spelling, whatever the part count. What the verifier looks for. */
export function numberedPartPath(basePath: string, part: number): string {
  const cut = basePath.lastIndexOf('.');
  const stem = cut === -1 ? basePath : basePath.slice(0, cut);
  const extension = cut === -1 ? '' : basePath.slice(cut);
  return `${stem}-${String(part).padStart(3, '0')}${extension}`;
}

/**
 * Which parts of one import file a package actually holds, read from what it
 * declares rather than from what produced it.
 *
 * The verifier has no access to the plan — it reads a package somebody hands it
 * — so the rule has to be checkable from the listing alone, and it is: either
 * the base path is there on its own, or the parts are there numbered from one
 * with no gap and no base path beside them. Anything else is a package whose
 * file set nobody can account for, and it is reported rather than resolved.
 */
export function importPartsListed(
  basePath: string,
  listed: ReadonlySet<string>,
): { paths: string[]; problem: string | null } {
  const base = listed.has(basePath);
  const parts: string[] = [];
  for (let part = 1; ; part += 1) {
    const path = numberedPartPath(basePath, part);
    if (!listed.has(path)) break;
    parts.push(path);
  }
  // A gap, rather than an end. Stopping at the first absent number and saying
  // nothing would let a package drop part two of five and present four files
  // that each verify on their own.
  for (const path of listed) {
    if (!path.startsWith(`${basePath.slice(0, Math.max(0, basePath.lastIndexOf('.')))}-`)) continue;
    if (!parts.includes(path) && NUMBERED_PART.test(path)) {
      return {
        paths: [],
        problem: `${path} is a numbered part of ${basePath} and the numbering before it is not continuous from 001`,
      };
    }
  }
  if (base && parts.length > 0) {
    return {
      paths: [],
      problem: `${basePath} is present and so are ${String(parts.length)} numbered parts of it; a file is either whole or cut, never both`,
    };
  }
  if (base) return { paths: [basePath], problem: null };
  if (parts.length === 0) {
    return { paths: [], problem: `${basePath} is missing from the package although the configuration maps that object` };
  }
  if (parts.length === 1) {
    return {
      paths: [],
      problem: `${basePath} is cut into a single part, ${parts[0] ?? ''}; a file that fits is written under its own name`,
    };
  }
  return { paths: parts, problem: null };
}
