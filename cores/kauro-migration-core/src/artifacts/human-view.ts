import { startsLikeFormula } from '../run/validate-destination.js';

/**
 * The human view of a machine table.
 *
 * A machine CSV (`MACHINE_IMPORT_CSV`, `MACHINE_EVIDENCE_CSV`,
 * `MACHINE_EXCEPTION_CSV`) holds exactly the values the migration decided on
 * (D7): a leading apostrophe there would be data written into the destination.
 * A person who double-clicks a file does not want to execute its cells, so the
 * package also carries neutralised copies, declared `HUMAN_VIEW_CSV` (D72).
 *
 * The neutralisation is one rule: a value the formula-risk predicate flags
 * (`startsLikeFormula`) gets one leading U+0027. Everything else is untouched,
 * so a view differs from its source in exactly the cells the predicate names,
 * and the original can be recovered (the apostrophe is only ever added in front
 * of a character no ordinary value starts with).
 */
export const NEUTRALISING_PREFIX = "'";

export function neutraliseCell(value: string): string {
  return startsLikeFormula(value) ? `${NEUTRALISING_PREFIX}${value}` : value;
}

/** A row as a human view prints it. `null` (an absent cell) prints as the empty string, like the machine file. */
export function neutraliseRow(row: readonly (string | null)[]): string[] {
  return row.map((value) => neutraliseCell(value ?? ''));
}

/** Whether any cell of the row would be neutralised. */
export function rowHasRiskyCell(row: readonly (string | null)[]): boolean {
  for (const value of row) if (value !== null && startsLikeFormula(value)) return true;
  return false;
}
