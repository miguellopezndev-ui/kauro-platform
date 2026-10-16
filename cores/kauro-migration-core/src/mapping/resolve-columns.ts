import { MigrationError } from '../domain/errors.js';
import type { ColumnRef } from '../domain/config.js';
import type { ColumnLocator } from '../domain/locators.js';

/**
 * Resolves a configured column reference against the header row that was
 * actually ingested.
 *
 * A reference that matches nothing, or that matches more than one column
 * without saying which, fails the run. Guessing here would silently move a
 * whole column of data into the wrong destination field.
 */
export function resolveColumn(
  ref: ColumnRef,
  columns: readonly ColumnLocator[],
  where: string,
): ColumnLocator {
  if (ref.index !== null) {
    const found = columns[ref.index];
    if (found === undefined) {
      throw new MigrationError(
        'MAPPING_INVALID',
        `${where} refers to column index ${String(ref.index)}, but the sheet has ${String(columns.length)} columns`,
        'Correct the index, or address the column by header text.',
        { where, index: ref.index, columnCount: columns.length },
      );
    }
    return found;
  }

  const header = ref.header;
  if (header === null) {
    throw new MigrationError(
      'MAPPING_INVALID',
      `${where} addresses no column`,
      'Set either "header" or "index".',
      { where },
    );
  }

  const matches = columns.filter((column) => column.headerRaw === header);
  if (matches.length === 0) {
    throw new MigrationError(
      'MAPPING_INVALID',
      `${where} refers to the column "${header}", which the sheet does not contain`,
      'Correct the header text. Header matching is exact, including case and surrounding spaces.',
      {
        where,
        header,
        availableHeaders: columns.map((column) => column.headerRaw),
      },
    );
  }

  const occurrence = ref.occurrence ?? 1;
  // Only an unstated occurrence is ambiguous. Saying "occurrence 1" is a
  // decision about which of the repeated columns to read.
  if (ref.occurrence === null && matches.length > 1) {
    throw new MigrationError(
      'MAPPING_INVALID',
      `${where} refers to the column "${header}", which appears ${String(matches.length)} times in the sheet`,
      'Set "occurrence" to say which one you mean. Repeated headers are never collapsed into one field.',
      { where, header, occurrences: matches.length },
    );
  }

  const found = matches[occurrence - 1];
  if (found === undefined) {
    throw new MigrationError(
      'MAPPING_INVALID',
      `${where} asks for occurrence ${String(occurrence)} of "${header}", but the sheet has ${String(matches.length)}`,
      'Correct the occurrence number.',
      { where, header, occurrence, occurrences: matches.length },
    );
  }
  return found;
}
