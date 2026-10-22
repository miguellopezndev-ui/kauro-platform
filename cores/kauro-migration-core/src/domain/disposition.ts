/**
 * Dispositions.
 *
 * The row partition is product law: every source row lands in exactly one of
 * these five buckets, and the buckets sum to the number of source rows. There
 * is no sixth outcome and there is no implicit omission.
 */
export const ROW_DISPOSITIONS = [
  /** The row produced a record in a destination import file. */
  'OUTPUT',
  /** The row's content was absorbed into another row proven to describe the same record. */
  'MERGED_PROVEN',
  /** The row was understood well enough to know it is not safe to import as-is. */
  'ISOLATED',
  /** The row is source material the migration configuration does not cover. */
  'LEFTOVER',
  /** The row could not be read as a well-formed row of the source file. */
  'REJECTED_INPUT',
] as const;

export type RowDisposition = (typeof ROW_DISPOSITIONS)[number];

/**
 * Association dispositions form their own partition over source edges. A row
 * can be delivered while one of its relationships cannot, and both facts are
 * recorded independently.
 */
export const EDGE_DISPOSITIONS = [
  /** The edge is delivered exactly once in the destination association output. */
  'OUTPUT',
  /** After proven merges this edge became identical to another delivered edge. */
  'DEDUPLICATED',
  /** One or both endpoints could not be resolved to a delivered record. */
  'UNRESOLVED',
  /** The destination does not support this relationship through file import. */
  'LEFTOVER',
] as const;

export type EdgeDisposition = (typeof EDGE_DISPOSITIONS)[number];

/**
 * What a source row contributed, as `source-lineage.csv` writes it in
 * `contribution_kind`. A closed vocabulary, published in the machine contract so
 * a package reader does not have to learn it from the packages it has seen
 * (N1-1: the platform's report reader refused `NONE`, F-31).
 */
export const CONTRIBUTION_KINDS = [
  /** The row is addressed by a record mapping. */
  'RECORD',
  /** The row is addressed by association mappings only. */
  'ASSOCIATION',
  /** The row is addressed by no mapping: every REJECTED_INPUT row, and every LEFTOVER row of a sheet no mapping covers. */
  'NONE',
] as const;

export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

/** Dispositions whose rows contributed content to a delivered destination record. */
export const DELIVERING_ROW_DISPOSITIONS: readonly RowDisposition[] = ['OUTPUT', 'MERGED_PROVEN'];

export function isRowDisposition(value: string): value is RowDisposition {
  return (ROW_DISPOSITIONS as readonly string[]).includes(value);
}

export function isEdgeDisposition(value: string): value is EdgeDisposition {
  return (EDGE_DISPOSITIONS as readonly string[]).includes(value);
}
