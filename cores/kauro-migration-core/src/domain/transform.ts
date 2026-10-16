import type { ReasonCode } from './reason-codes.js';
import { CoreInvariantError } from '../util/assert.js';
import type { ValueIntent } from './value-intent.js';
import { intentFor } from './value-intent.js';

/**
 * The transformation contract.
 *
 * A transformation returns a structured outcome, never an overloaded string.
 * Three of the six outcomes are explicitly non-destructive by construction: the
 * engine refuses to deliver a value for them other than the original.
 */
export const TRANSFORM_KINDS = [
  'UNCHANGED',
  'CHANGED_SAFE',
  'AMBIGUOUS',
  'INVALID',
  'UNSUPPORTED',
  'CLEAR_EXPLICIT',
] as const;

export type TransformKind = (typeof TRANSFORM_KINDS)[number];

/** Outcomes that must return the original value untouched. */
export const NON_COMMITTAL_KINDS: readonly TransformKind[] = ['AMBIGUOUS', 'INVALID', 'UNSUPPORTED'];

export const SAFETY_CLASSES = [
  'NON_DESTRUCTIVE',
  'DESTRUCTIVE_EXPLICITLY_AUTHORIZED',
] as const;

export type SafetyClass = (typeof SAFETY_CLASSES)[number];

export interface TransformEvidence {
  readonly kind: string;
  readonly detail: string;
}

export interface TransformResult {
  readonly kind: TransformKind;
  /**
   * What the destination is being asked to do with this field.
   *
   * Derived here rather than by any consumer, because `final` alone cannot
   * distinguish an authorized clear from a field this row says nothing about,
   * and every consumer that tried ended up guessing the same way: empty means
   * leave it alone. That guess silently discards a clear the plan authorized.
   */
  readonly intent: ValueIntent;
  readonly original: string | null;
  readonly final: string | null;
  readonly reasonCode: ReasonCode;
  readonly transformationId: string;
  readonly transformationVersion: string;
  readonly safetyClass: SafetyClass;
  readonly evidence: readonly TransformEvidence[];
  /**
   * Extra values a transformation derived from the same source cell, keyed by a
   * logical name such as `extension`. The field mapper routes them to their own
   * destination fields; without a destination they are never dropped silently
   * because the transformation returns UNSUPPORTED instead.
   */
  readonly derived: Readonly<Record<string, string>>;
}

export interface TransformResultDraft {
  readonly kind: TransformKind;
  readonly original: string | null;
  readonly final: string | null;
  readonly reasonCode: ReasonCode;
  readonly transformationId: string;
  readonly transformationVersion: string;
  readonly safetyClass?: SafetyClass;
  readonly evidence?: readonly TransformEvidence[];
  readonly derived?: Readonly<Record<string, string>>;
}

function isNonEmpty(value: string | null): boolean {
  return value !== null && value.length > 0;
}

/**
 * Single chokepoint for building a transformation outcome.
 *
 * Enforces the two prime invariants that no individual transformation is
 * trusted to enforce for itself:
 *
 *  - AMBIGUOUS / INVALID / UNSUPPORTED must return the original value.
 *  - A non-empty source value may only become empty under CLEAR_EXPLICIT with
 *    the destructive safety class.
 *
 * A violation is a defect in the engine, so it raises rather than degrading.
 */
export function makeTransformResult(draft: TransformResultDraft): TransformResult {
  const safetyClass = draft.safetyClass ?? 'NON_DESTRUCTIVE';

  if (NON_COMMITTAL_KINDS.includes(draft.kind) && draft.final !== draft.original) {
    throw new CoreInvariantError(
      'TRANSFORM_NON_COMMITTAL_PRESERVES_ORIGINAL',
      `transformation ${draft.transformationId} returned ${draft.kind} but changed the value`,
      {
        transformationId: draft.transformationId,
        kind: draft.kind,
        original: draft.original,
        final: draft.final,
      },
    );
  }

  if (draft.kind === 'UNCHANGED' && draft.final !== draft.original) {
    throw new CoreInvariantError(
      'TRANSFORM_UNCHANGED_PRESERVES_ORIGINAL',
      `transformation ${draft.transformationId} returned UNCHANGED but changed the value`,
      { transformationId: draft.transformationId, original: draft.original, final: draft.final },
    );
  }

  if (isNonEmpty(draft.original) && !isNonEmpty(draft.final)) {
    const authorized =
      draft.kind === 'CLEAR_EXPLICIT' && safetyClass === 'DESTRUCTIVE_EXPLICITLY_AUTHORIZED';
    if (!authorized) {
      throw new CoreInvariantError(
        'NO_SILENT_CELL_DESTRUCTION',
        `transformation ${draft.transformationId} would empty a non-empty source value without explicit authorization`,
        {
          transformationId: draft.transformationId,
          kind: draft.kind,
          safetyClass,
          original: draft.original,
        },
      );
    }
  }

  if (draft.kind === 'CLEAR_EXPLICIT' && safetyClass !== 'DESTRUCTIVE_EXPLICITLY_AUTHORIZED') {
    throw new CoreInvariantError(
      'CLEAR_REQUIRES_DESTRUCTIVE_AUTHORIZATION',
      `transformation ${draft.transformationId} returned CLEAR_EXPLICIT without the destructive safety class`,
      { transformationId: draft.transformationId },
    );
  }

  const intent = intentFor(draft.kind, draft.original, draft.final);

  // The two directions this derivation must never get wrong. A clear that comes
  // out as anything else is the seam this type exists to close, and a
  // non-committal outcome that comes out as SET would be a value the engine
  // decided while reporting that it had decided nothing.
  if ((draft.kind === 'CLEAR_EXPLICIT') !== (intent.kind === 'CLEAR')) {
    throw new CoreInvariantError(
      'CLEAR_INTENT_MATCHES_OUTCOME',
      `transformation ${draft.transformationId} returned ${draft.kind} but its intent is ${intent.kind}`,
      { transformationId: draft.transformationId, kind: draft.kind, intent: intent.kind },
    );
  }
  if (NON_COMMITTAL_KINDS.includes(draft.kind) && intent.kind === 'SET') {
    throw new CoreInvariantError(
      'NON_COMMITTAL_INTENT_IS_NOT_A_SET',
      `transformation ${draft.transformationId} returned ${draft.kind} but intends to set a value`,
      { transformationId: draft.transformationId, kind: draft.kind },
    );
  }

  return {
    kind: draft.kind,
    intent,
    original: draft.original,
    final: draft.final,
    reasonCode: draft.reasonCode,
    transformationId: draft.transformationId,
    transformationVersion: draft.transformationVersion,
    safetyClass,
    evidence: draft.evidence ?? [],
    derived: draft.derived ?? {},
  };
}

/** `true` when the delivered value differs from the source value and must appear in the change log. */
export function isMaterialChange(result: TransformResult): boolean {
  return result.final !== result.original;
}

/** `true` when the outcome needs human attention but does not by itself block delivery. */
export function needsReview(result: TransformResult): boolean {
  return NON_COMMITTAL_KINDS.includes(result.kind);
}
