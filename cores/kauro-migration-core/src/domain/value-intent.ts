/**
 * What the engine intends a destination to do with one field of one record.
 *
 * A migration has four distinct things to say about a field, and `string | null`
 * can only say two of them. Collapsing them is how an authorized clear becomes
 * an omission and how a blank source cell becomes a promise to delete data:
 *
 *   PRESERVE(value)  deliver the source value; nothing was decided about it
 *   SET(value)       deliver a different value; a rule changed it
 *   CLEAR            remove the value the destination currently holds
 *   OMIT             say nothing about this field; leave the destination alone
 *
 * `CLEAR` and `OMIT` are opposites, not synonyms. `SET("")` is not a spelling of
 * either and never appears: a transformation that would empty a populated cell
 * without authorization is refused at the transformation chokepoint.
 *
 * Whether a destination can *express* `CLEAR` is a separate question, answered
 * per target and import mode against the captured contract, not here. This type
 * carries the engine's intent; representability is decided where the destination
 * is known.
 */

export const VALUE_INTENT_KINDS = ['PRESERVE', 'SET', 'CLEAR', 'OMIT'] as const;
export type ValueIntentKind = (typeof VALUE_INTENT_KINDS)[number];

/**
 * Why a field says nothing.
 *
 * An absent cell and a blank cell are different observations about the source,
 * and the traceability keeps them apart even though both leave the destination
 * untouched. A reader asking "did this row have a value here?" gets an answer.
 */
export const OMIT_REASONS = [
  /** The row has no cell at that column at all. */
  'SOURCE_CELL_ABSENT',
  /** The cell exists and holds no characters. */
  'SOURCE_CELL_BLANK',
  /** A cell was read, but the mapping produced no value to deliver from it. */
  'NO_VALUE_PRODUCED',
] as const;
export type OmitReason = (typeof OMIT_REASONS)[number];

export type ValueIntent =
  | { readonly kind: 'PRESERVE'; readonly value: string }
  | { readonly kind: 'SET'; readonly value: string }
  | { readonly kind: 'CLEAR' }
  | { readonly kind: 'OMIT'; readonly reason: OmitReason };

export const CLEAR: ValueIntent = { kind: 'CLEAR' };

export function preserve(value: string): ValueIntent {
  return { kind: 'PRESERVE', value };
}

export function set(value: string): ValueIntent {
  return { kind: 'SET', value };
}

export function omit(reason: OmitReason): ValueIntent {
  return { kind: 'OMIT', reason };
}

/**
 * The value this intent puts in a destination field, or `null` where the intent
 * is not a value at all.
 *
 * `CLEAR` returns `null` here on purpose: a clear has no value, and the shape
 * of the emptiness a destination needs is that destination's business. Nothing
 * may use this function to decide whether a field appears in an import file —
 * `CLEAR` and `OMIT` both answer `null` and they are opposite instructions.
 */
export function intendedValue(intent: ValueIntent): string | null {
  return intent.kind === 'PRESERVE' || intent.kind === 'SET' ? intent.value : null;
}

/** `true` when the destination is being asked to hold a value. */
export function carriesValue(intent: ValueIntent): intent is { kind: 'PRESERVE' | 'SET'; value: string } {
  return intent.kind === 'PRESERVE' || intent.kind === 'SET';
}

/** `true` when the destination is being asked to change what it holds. */
export function isDestructive(intent: ValueIntent): boolean {
  return intent.kind === 'CLEAR';
}

/**
 * The intent a transformation outcome expresses.
 *
 * Derived in one place from the outcome kind and the two values, so that no
 * individual transformation decides the question and no consumer re-derives it
 * from a string that cannot answer it.
 *
 * `original === null` means the row had no cell at that column; `original === ''`
 * means the cell was there and empty. The two produce the same instruction to
 * the destination and different evidence about the source.
 */
export function intentFor(kind: string, original: string | null, final: string | null): ValueIntent {
  if (kind === 'CLEAR_EXPLICIT') return CLEAR;
  if (final !== null && final.length > 0) {
    return final === original ? preserve(final) : set(final);
  }
  if (original === null) return omit('SOURCE_CELL_ABSENT');
  if (original.length === 0) return omit('SOURCE_CELL_BLANK');
  // A populated source value that produced nothing, without the outcome that
  // authorizes emptying it. The transformation chokepoint refuses to build such
  // a result, so reaching here is a defect rather than a data condition; the
  // intent stays non-destructive either way.
  return omit('NO_VALUE_PRODUCED');
}

/** Stable text for artifacts and evidence. `PRESERVE`/`SET` are not spelled with their value. */
export function renderIntent(intent: ValueIntent): string {
  return intent.kind === 'OMIT' ? `OMIT:${intent.reason}` : intent.kind;
}
