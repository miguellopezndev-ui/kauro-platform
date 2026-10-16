import type { CanonicalObject } from './canonical.js';
import type { ReasonCode } from './reason-codes.js';

/**
 * Identity.
 *
 * Two records are only combined automatically when the source itself proves
 * they are one record. Everything weaker produces a duplicate candidate for a
 * human to decide, which is a legitimate deliverable rather than a failure.
 */

export const IDENTITY_EVIDENCE_AUTHORITIES = [
  /** Sufficient on its own to combine records automatically. */
  'PROVING',
  /** Raises a candidate for review. Never sufficient on its own. */
  'SUPPORTING',
  /** Argues that two records are NOT the same. */
  'CONTRADICTING',
] as const;

export type IdentityEvidenceAuthority = (typeof IDENTITY_EVIDENCE_AUTHORITIES)[number];

export const IDENTITY_EVIDENCE_KINDS = [
  'SOURCE_RECORD_ID',
  'AUTHORITATIVE_EXTERNAL_ID',
  'EMAIL_EXACT',
  'PHONE_E164',
  'NAME_EXACT',
  'COMPANY_DOMAIN',
  'CONFLICTING_ATTRIBUTE',
] as const;

export type IdentityEvidenceKind = (typeof IDENTITY_EVIDENCE_KINDS)[number];

/**
 * The authority table. This is the single place that decides what may combine
 * records without a human. Widening it is a contract change.
 *
 * Email equality is SUPPORTING, never PROVING: a shared mailbox, a family
 * address and a data-entry copy/paste all produce equal emails for different
 * people.
 */
export const EVIDENCE_AUTHORITY: Readonly<Record<IdentityEvidenceKind, IdentityEvidenceAuthority>> = {
  SOURCE_RECORD_ID: 'PROVING',
  AUTHORITATIVE_EXTERNAL_ID: 'PROVING',
  EMAIL_EXACT: 'SUPPORTING',
  PHONE_E164: 'SUPPORTING',
  NAME_EXACT: 'SUPPORTING',
  COMPANY_DOMAIN: 'SUPPORTING',
  CONFLICTING_ATTRIBUTE: 'CONTRADICTING',
};

export interface IdentityEvidence {
  readonly kind: IdentityEvidenceKind;
  readonly authority: IdentityEvidenceAuthority;
  /**
   * How many rows of the merge hold this key. Only a key held by two or more
   * rows joined anything; a key one row carries alone is part of what the
   * merged record now holds, not part of the argument for merging it. Citing
   * both as PROVING made a merge unreadable: the two different record ids that
   * argue the rows are *different* were listed as proof they are the same.
   */
  readonly heldByMembers: number;
  /** The shared value, or for contradictions a rendering of the disagreement. */
  readonly value: string;
  readonly reasonCode: ReasonCode;
  /**
   * Present only on a key that joined rows whose source spellings differ, which
   * is only possible under a declared identity normalization: every spelling
   * the source used, so the collision is a decision a reader can read.
   */
  readonly sourceValues?: readonly string[];
}

export const IDENTITY_OUTCOMES = [
  'SAME_RECORD_PROVEN',
  'POSSIBLE_DUPLICATE',
  'CONFLICTING_IDENTITY',
  'DISTINCT_RECORDS',
  'INSUFFICIENT_EVIDENCE',
] as const;

export type IdentityOutcome = (typeof IDENTITY_OUTCOMES)[number];

export const PROVING_KEY_KINDS = ['SOURCE_RECORD_ID', 'EXTERNAL_ID'] as const;
export type ProvingKeyKind = (typeof PROVING_KEY_KINDS)[number];

/**
 * A source identity key.
 *
 * Every part is a separate, escaped segment. Nothing is concatenated into a
 * segment, because a composite built inside one segment can be forged: a plain
 * record id spelled to look like an external-id key would render the same
 * string and merge two unrelated people.
 *
 * `identitySpace` is the scope inside which a record id means something. It
 * defaults to the record mapping, so two sheets with independent id sequences —
 * contacts numbered from 1 and leads numbered from 1, the most ordinary CRM
 * export there is — never collide. Two sheets that genuinely share one id space
 * say so in the configuration.
 */
export interface SourceIdentityKey {
  readonly sourceSystem: string;
  readonly sourceNamespace: string;
  readonly identitySpace: string;
  readonly objectType: CanonicalObject;
  readonly keyKind: ProvingKeyKind;
  /** Header text of the column that declared an external identifier. Empty for a source record id. */
  readonly keyColumn: string;
  /**
   * Where that column physically is. Header text alone is not an address: two
   * columns can share a header, and a headerless column has none at all.
   * Rendering `#1` for the second case would put synthesized text into the
   * same value space as a column whose header is literally `#1` — the
   * concatenation defect, one field to the left.
   *
   * `occurrence:<n>` and `index:<n>` have disjoint prefixes and digit-only
   * suffixes, so no header text and no column position can render the same
   * segment. Empty for a record-id key.
   */
  readonly keyColumnAddress: string;
  readonly sourceRecordId: string;
}

const SEGMENT_COUNT = 8;

export function renderIdentityKey(key: SourceIdentityKey): string {
  const segments = [
    key.sourceSystem,
    key.sourceNamespace,
    key.identitySpace,
    key.objectType,
    key.keyKind,
    key.keyColumn,
    key.keyColumnAddress,
    key.sourceRecordId,
  ];
  /* istanbul ignore next -- structural guard; the literal above is fixed-length */
  if (segments.length !== SEGMENT_COUNT) {
    throw new Error('identity key segment count changed without updating SEGMENT_COUNT');
  }
  return segments.map(escapeKeySegment).join('|');
}

/** Escaped so that a literal separator inside any value cannot forge a different key. */
function escapeKeySegment(segment: string): string {
  return segment.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * Values that are an export artefact rather than an identifier. Treating one of
 * these as proof would merge every row whose id column failed to export.
 *
 * The list is deliberately short. `NA`, `NONE` and `NIL` were on it and are
 * not any more: they are ordinary primary keys in division, region and segment
 * tables, and suppressing them made the engine state in `associations.csv`
 * that no source record matched an endpoint whose record was delivered in the
 * same package. A rule that produces a false statement about delivered data is
 * worse than the coincidence it guarded against.
 */
const SENTINEL_IDS = new Set(['undefined', 'null', '#n/a', 'n/a', '(null)', '#ref!']);

export function isSentinelIdentifier(value: string): boolean {
  return SENTINEL_IDS.has(value.trim().toLowerCase());
}

export function evidenceAuthority(kind: IdentityEvidenceKind): IdentityEvidenceAuthority {
  return EVIDENCE_AUTHORITY[kind];
}

/** A merge is permitted only with at least one PROVING item. Supporting evidence never accumulates into proof. */
export function permitsAutomaticMerge(evidence: readonly IdentityEvidence[]): boolean {
  return evidence.some((item) => item.authority === 'PROVING');
}
