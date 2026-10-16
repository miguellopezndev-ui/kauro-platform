import { MigrationError } from '../domain/errors.js';
import { canonicalJsonText, compareCodeUnits, parseJson } from '../util/json.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import { sha256Hex } from '../util/hash.js';
import { validateAgainstSchema } from '../mapping/schema-validator.js';
import type { Schema } from '../mapping/schema-validator.js';
import type { HashedSourceProfile } from './source-profile.js';
import { SOURCE_PROFILE_VERSION } from './source-profile.js';
import type { RunTruth } from '../reconcile/truth.js';
import { CONFIG_SCHEMA_VERSION } from '../domain/config.js';
import { CORE_VERSION, PACKAGE_FORMAT_VERSION, SOURCE_REGISTRY_VERSION } from '../version.js';

/**
 * `CandidateSetV1` — the space Intelligence may choose inside, and nothing else.
 *
 * Intelligence interprets and proposes; Migration Core executes and proves. The
 * seam between them is that a proposal can only select among candidates this
 * engine produced deterministically, or abstain. A candidate is therefore a
 * fact about the source — a column that is unique across every row, a column
 * whose values are shaped like a date nobody can read unambiguously, a cluster
 * of rows that share a signal without proving they are one record — with the
 * references a proposal needs to point at it, and with no authority attached.
 *
 * "No authority" is structural rather than promised. A candidate has no field
 * that could carry a merge decision, a transform, or a permission; its
 * `constraints` say so in words the reader checks (`authority: 'NONE'`,
 * `destructiveAllowed: false`, `identityAutoMergeAllowed: false`), and a set
 * whose candidates say anything else is refused. A duplicate cluster in this set
 * is the same duplicate cluster the package reports as a candidate: something a
 * person or a proposal may look at, never something the engine merges because
 * it was listed here.
 *
 * A set is bound to exactly one reading of one bundle under one configuration
 * of one core: its `refs` name the bundle id, the profile hash, the
 * configuration hash and the versions, and a consumer that holds a different
 * profile or a different revision is refused with `CANDIDATE_SET_INVALID`
 * rather than handed candidates about something else. Access is bounded:
 * `limits.maxItems` caps the set and `truncated` says whether the cap was hit,
 * so a consumer never learns of "the rest" by accident.
 *
 * There is no model here, no gateway, no minimiser and no compiler. Those are
 * Intelligence's, and they take this as input.
 */

export const CANDIDATE_SET_VERSION = '1.0.0';

export const CANDIDATE_TYPES = [
  'KEY_CANDIDATE',
  'AMBIGUOUS_SHAPE_COLUMN',
  'DUPLICATE_CLUSTER',
  'UNMAPPED_MATERIAL',
] as const;
export type CandidateType = (typeof CANDIDATE_TYPES)[number];

/** The default cap on a set. Stated so a consumer knows what "bounded" meant. */
export const DEFAULT_CANDIDATE_LIMIT = 10_000;
/** How many source references one candidate carries at most; the impact counts carry the rest. */
export const SOURCE_REFS_PER_CANDIDATE = 64;

export interface CandidateConstraints {
  /** Always NONE. A candidate is something to look at, never a permission. */
  readonly authority: 'NONE';
  readonly destructiveAllowed: false;
  readonly identityAutoMergeAllowed: false;
}

export interface CandidateV1 {
  /** `cand_` + 16 hex, derived from the candidate's own content. */
  readonly candidateRef: string;
  readonly candidateType: CandidateType;
  /** Locators inside the source: column locators or row locators, at most SOURCE_REFS_PER_CANDIDATE. */
  readonly sourceRefs: readonly string[];
  /** Destination fields a proposal about this candidate may name. Empty means the proposal decides nothing about a destination. */
  readonly allowedTargetRefs: readonly string[];
  /** Transformation primitives a proposal about this candidate may name, by id. */
  readonly allowedPrimitiveRefs: readonly string[];
  /** Where in the profile or the package the evidence for this candidate lives. */
  readonly evidenceRefs: readonly string[];
  readonly impactCounts: Readonly<Record<string, number>>;
  readonly constraints: CandidateConstraints;
}

export interface CandidateSetRefs {
  readonly bundleId: string;
  readonly profileHash: string;
  readonly configHash: string;
  readonly coreVersion: string;
  readonly packageFormatVersion: string;
  readonly sourceRegistryVersion: string;
  readonly configSchemaVersion: string;
  readonly sourceProfileVersion: string;
}

export interface CandidateSetV1 {
  readonly candidateSetVersion: string;
  readonly refs: CandidateSetRefs;
  readonly limits: {
    readonly maxItems: number;
    /** How many candidates were produced before the cap, so a consumer knows what it did not receive. */
    readonly produced: number;
    readonly truncated: boolean;
  };
  /** Sorted by candidateRef, so two builds over the same facts are the same bytes. */
  readonly candidates: readonly CandidateV1[];
}

export interface HashedCandidateSet {
  readonly candidateSet: CandidateSetV1;
  readonly candidateSetHash: string;
}

const CONSTRAINTS: CandidateConstraints = { authority: 'NONE', destructiveAllowed: false, identityAutoMergeAllowed: false };

/** The primitives a proposal may name for a column whose shape is ambiguous. Ids, not code. */
const PRIMITIVES_BY_SHAPE: Readonly<Record<string, readonly string[]>> = {
  slashDateAmbiguous: ['DATE_FORMAT_DECLARATION'],
  phoneLocalDigits: ['PHONE_COUNTRY_DECLARATION'],
  leadingZeroDigits: ['IDENTIFIER_SEMANTIC_TYPE'],
  decimalComma: ['DECIMAL_SEPARATOR_DECLARATION'],
  groupedNumber: ['THOUSANDS_SEPARATOR_DECLARATION'],
  blankPadded: ['TRIM'],
};

export interface BuildCandidateSetInput {
  readonly profile: HashedSourceProfile;
  readonly configHash: string;
  /**
   * The run's truth, where a run has happened. Adds the duplicate clusters and
   * the unmapped material the engine already reports as candidates; without it
   * the set holds what the profile alone establishes.
   */
  readonly truth?: RunTruth | null;
  readonly maxItems?: number;
}

/**
 * Build the set from deterministic facts.
 *
 * Every candidate is derived from numbers the profiler or the engine already
 * produced; nothing here reads a cell value into the set. Duplicate clusters
 * carry row locators, which are addresses, not data.
 */
export function buildCandidateSet(input: BuildCandidateSetInput): HashedCandidateSet {
  const maxItems = input.maxItems ?? DEFAULT_CANDIDATE_LIMIT;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new MigrationError('CANDIDATE_SET_INVALID', `maxItems ${String(maxItems)} is not a positive whole number`, 'Ask for at least one candidate.', {
      maxItems,
    });
  }
  const profile = input.profile.profile;
  const produced: Omit<CandidateV1, 'candidateRef'>[] = [];

  for (const file of profile.files) {
    for (const sheet of file.sheets) {
      for (const column of sheet.columns) {
        const evidence = `profile:${input.profile.profileHash}#${column.columnLocatorId}`;
        if (sheet.candidateKeyColumns.includes(column.columnIndex)) {
          produced.push({
            candidateType: 'KEY_CANDIDATE',
            sourceRefs: [column.columnLocatorId],
            allowedTargetRefs: [],
            allowedPrimitiveRefs: ['SOURCE_RECORD_ID_COLUMN', 'AUTHORITATIVE_EXTERNAL_ID_COLUMN'],
            evidenceRefs: [evidence],
            impactCounts: { rows: sheet.dataRowCount, populated: column.populated, distinct: column.distinctValues },
            constraints: CONSTRAINTS,
          });
        }
        for (const [shape, primitives] of Object.entries(PRIMITIVES_BY_SHAPE)) {
          const count = column.shapes[shape] ?? 0;
          if (count === 0) continue;
          produced.push({
            candidateType: 'AMBIGUOUS_SHAPE_COLUMN',
            sourceRefs: [column.columnLocatorId],
            allowedTargetRefs: [],
            allowedPrimitiveRefs: [...primitives],
            evidenceRefs: [`${evidence}/shapes/${shape}`],
            impactCounts: { rows: sheet.dataRowCount, populated: column.populated, shaped: count },
            constraints: CONSTRAINTS,
          });
        }
      }
    }
  }

  const truth = input.truth ?? null;
  if (truth !== null) {
    // The duplicate candidates are written in cluster order, so a cluster is the
    // run of entries sharing a cluster id and only that run is held.
    let clusterId: string | null = null;
    let rows: string[] = [];
    let rowCount = 0;
    const flush = (): void => {
      if (clusterId === null) return;
      produced.push({
        candidateType: 'DUPLICATE_CLUSTER',
        sourceRefs: rows.slice(0, SOURCE_REFS_PER_CANDIDATE),
        allowedTargetRefs: [],
        // The one thing a proposal may do with a cluster the engine refused to
        // merge is ask a person to look at it. There is no primitive here that
        // combines records, and `identityAutoMergeAllowed` is false besides.
        allowedPrimitiveRefs: ['REVIEW_ONLY'],
        evidenceRefs: [`package:duplicate-candidates.csv#${clusterId}`],
        impactCounts: { rows: rowCount, sourceRefsCarried: Math.min(rowCount, SOURCE_REFS_PER_CANDIDATE) },
        constraints: CONSTRAINTS,
      });
    };
    for (const entry of truth.duplicateCandidates) {
      if (entry.clusterId !== clusterId) {
        flush();
        clusterId = entry.clusterId;
        rows = [];
        rowCount = 0;
      }
      rowCount += 1;
      if (rows.length < SOURCE_REFS_PER_CANDIDATE) rows.push(entry.rowLocatorId);
    }
    flush();

    // Unmapped material, by column: the columns a plan left out, with how many
    // populated cells each would preserve. Counted in one pass over the family.
    const unmapped = new Map<string, { count: number; header: string | null }>();
    for (const entry of truth.unmappedFields) {
      const current = unmapped.get(entry.columnLocatorId) ?? { count: 0, header: entry.columnHeader };
      current.count += 1;
      unmapped.set(entry.columnLocatorId, current);
    }
    for (const [locator, entry] of [...unmapped.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
      produced.push({
        candidateType: 'UNMAPPED_MATERIAL',
        sourceRefs: [locator],
        allowedTargetRefs: [],
        allowedPrimitiveRefs: ['MAP_TO_CUSTOM_FIELD', 'PRESERVE_UNMAPPED'],
        evidenceRefs: [`package:unmapped-fields.csv#${locator}`],
        impactCounts: { populatedCells: entry.count },
        constraints: CONSTRAINTS,
      });
    }
  }

  const withRefs = produced.map((candidate) => ({ candidateRef: candidateRefOf(candidate), ...candidate }));
  withRefs.sort((a, b) => compareCodeUnits(a.candidateRef, b.candidateRef));
  const truncated = withRefs.length > maxItems;
  const candidateSet: CandidateSetV1 = {
    candidateSetVersion: CANDIDATE_SET_VERSION,
    refs: {
      bundleId: profile.bundleId,
      profileHash: input.profile.profileHash,
      configHash: input.configHash,
      coreVersion: CORE_VERSION,
      packageFormatVersion: PACKAGE_FORMAT_VERSION,
      sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
      configSchemaVersion: CONFIG_SCHEMA_VERSION,
      sourceProfileVersion: SOURCE_PROFILE_VERSION,
    },
    limits: { maxItems, produced: withRefs.length, truncated },
    candidates: truncated ? withRefs.slice(0, maxItems) : withRefs,
  };
  return { candidateSet, candidateSetHash: hashCandidateSet(candidateSet) };
}

/** The reference is the digest of the candidate's own content, so it is stable across builds and cannot be reassigned. */
export function candidateRefOf(candidate: Omit<CandidateV1, 'candidateRef'>): string {
  const body: JsonValue = {
    candidateType: candidate.candidateType,
    sourceRefs: [...candidate.sourceRefs],
    allowedTargetRefs: [...candidate.allowedTargetRefs],
    allowedPrimitiveRefs: [...candidate.allowedPrimitiveRefs],
    evidenceRefs: [...candidate.evidenceRefs],
    impactCounts: { ...candidate.impactCounts },
  };
  return `cand_${sha256Hex(canonicalJsonText(body)).slice(0, 16)}`;
}

export function candidateSetToJson(candidateSet: CandidateSetV1): JsonObject {
  return JSON.parse(JSON.stringify(candidateSet)) as JsonObject;
}

export function hashCandidateSet(candidateSet: CandidateSetV1): string {
  return sha256Hex(canonicalJsonText(candidateSetToJson(candidateSet) as JsonValue));
}

export function serializeCandidateSet(hashed: HashedCandidateSet): string {
  return canonicalJsonText({ candidateSetHash: hashed.candidateSetHash, candidateSet: candidateSetToJson(hashed.candidateSet) });
}

/** Bounded access: one candidate at a time, never the array by reference. */
export function* candidatesOf(hashed: HashedCandidateSet): IterableIterator<CandidateV1> {
  for (const candidate of hashed.candidateSet.candidates) yield candidate;
}

// ---------------------------------------------------------------------------
// The schema and the loader
// ---------------------------------------------------------------------------

const NON_NEGATIVE: Schema = { type: 'integer', minimum: 0 };
const SHA256_HEX = '^[0-9a-f]{64}$';

const CANDIDATE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidateRef', 'candidateType', 'sourceRefs', 'allowedTargetRefs', 'allowedPrimitiveRefs', 'evidenceRefs', 'impactCounts', 'constraints'],
  properties: {
    candidateRef: { type: 'string', pattern: '^cand_[0-9a-f]{16}$' },
    candidateType: { type: 'string', enum: [...CANDIDATE_TYPES] },
    sourceRefs: { type: 'array', items: { type: 'string', minLength: 1 } },
    allowedTargetRefs: { type: 'array', items: { type: 'string', minLength: 1 } },
    allowedPrimitiveRefs: { type: 'array', items: { type: 'string', minLength: 1 } },
    evidenceRefs: { type: 'array', items: { type: 'string', minLength: 1 } },
    impactCounts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rows: NON_NEGATIVE,
        populated: NON_NEGATIVE,
        distinct: NON_NEGATIVE,
        shaped: NON_NEGATIVE,
        sourceRefsCarried: NON_NEGATIVE,
        populatedCells: NON_NEGATIVE,
        object: NON_NEGATIVE,
      },
    },
    constraints: {
      type: 'object',
      additionalProperties: false,
      required: ['authority', 'destructiveAllowed', 'identityAutoMergeAllowed'],
      properties: {
        authority: { type: 'string', enum: ['NONE'] },
        destructiveAllowed: { type: 'boolean' },
        identityAutoMergeAllowed: { type: 'boolean' },
      },
    },
  },
};

export const CANDIDATE_SET_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidateSetVersion', 'refs', 'limits', 'candidates'],
  properties: {
    candidateSetVersion: { type: 'string', enum: [CANDIDATE_SET_VERSION] },
    refs: {
      type: 'object',
      additionalProperties: false,
      required: [
        'bundleId',
        'profileHash',
        'configHash',
        'coreVersion',
        'packageFormatVersion',
        'sourceRegistryVersion',
        'configSchemaVersion',
        'sourceProfileVersion',
      ],
      properties: {
        bundleId: { type: 'string', pattern: '^B-[0-9a-f]{16}$' },
        profileHash: { type: 'string', pattern: SHA256_HEX },
        configHash: { type: 'string', pattern: SHA256_HEX },
        coreVersion: { type: 'string', minLength: 1 },
        packageFormatVersion: { type: 'string', minLength: 1 },
        sourceRegistryVersion: { type: 'string', minLength: 1 },
        configSchemaVersion: { type: 'string', minLength: 1 },
        sourceProfileVersion: { type: 'string', minLength: 1 },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['maxItems', 'produced', 'truncated'],
      properties: { maxItems: { type: 'integer', minimum: 1 }, produced: NON_NEGATIVE, truncated: { type: 'boolean' } },
    },
    candidates: { type: 'array', items: CANDIDATE_SCHEMA },
  },
};

export const SERIALIZED_CANDIDATE_SET_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidateSetHash', 'candidateSet'],
  properties: {
    candidateSetHash: { type: 'string', pattern: SHA256_HEX },
    candidateSet: CANDIDATE_SET_SCHEMA,
  },
};

function refuse(where: string, message: string, remedy: string, details: JsonObject = {}): never {
  throw new MigrationError('CANDIDATE_SET_INVALID', `${where} ${message}`, remedy, { where, ...details });
}

/** The first few problems in the message; every one of them in the details. */
const SUMMARISED = 3;

function summarise(problems: readonly string[]): string {
  const shown = problems.slice(0, SUMMARISED).join('; ');
  return problems.length > SUMMARISED ? `${shown}; and ${String(problems.length - SUMMARISED)} more` : shown;
}

/** What no honest set can break, after the schema has settled the shape. */
export function candidateSetInvariantProblems(candidateSet: CandidateSetV1): { pointer: string; message: string }[] {
  const problems: { pointer: string; message: string }[] = [];
  const refs = new Set<string>();
  let previous: string | null = null;
  candidateSet.candidates.forEach((candidate, index) => {
    const at = `/candidates/${String(index)}`;
    if (refs.has(candidate.candidateRef)) problems.push({ pointer: `${at}/candidateRef`, message: `${candidate.candidateRef} appears more than once` });
    refs.add(candidate.candidateRef);
    if (previous !== null && compareCodeUnits(previous, candidate.candidateRef) > 0) {
      problems.push({ pointer: `${at}/candidateRef`, message: 'the candidates are not in reference order' });
    }
    previous = candidate.candidateRef;
    const { candidateRef, ...body } = candidate;
    if (candidateRefOf(body) !== candidateRef) problems.push({ pointer: `${at}/candidateRef`, message: `${candidateRef} is not derived from the candidate's content` });
    if (candidate.constraints.authority !== 'NONE') problems.push({ pointer: `${at}/constraints/authority`, message: 'a candidate carries no authority' });
    if (candidate.constraints.destructiveAllowed !== false) problems.push({ pointer: `${at}/constraints/destructiveAllowed`, message: 'must be false' });
    if (candidate.constraints.identityAutoMergeAllowed !== false) problems.push({ pointer: `${at}/constraints/identityAutoMergeAllowed`, message: 'must be false' });
    if (candidate.sourceRefs.length > SOURCE_REFS_PER_CANDIDATE) {
      problems.push({ pointer: `${at}/sourceRefs`, message: `carries ${String(candidate.sourceRefs.length)} references, above the ${String(SOURCE_REFS_PER_CANDIDATE)} a candidate may hold` });
    }
    if (new Set(candidate.sourceRefs).size !== candidate.sourceRefs.length) problems.push({ pointer: `${at}/sourceRefs`, message: 'repeats a reference' });
  });
  if (candidateSet.candidates.length > candidateSet.limits.maxItems) {
    problems.push({ pointer: '/candidates', message: `holds ${String(candidateSet.candidates.length)} candidates, above maxItems ${String(candidateSet.limits.maxItems)}` });
  }
  if (candidateSet.limits.produced < candidateSet.candidates.length) {
    problems.push({ pointer: '/limits/produced', message: 'is below the number of candidates carried' });
  }
  if (candidateSet.limits.truncated !== candidateSet.limits.produced > candidateSet.candidates.length) {
    problems.push({ pointer: '/limits/truncated', message: 'disagrees with produced and the candidates carried' });
  }
  return problems;
}

/**
 * Read a set off disk, and refuse everything that is not one bound to a known
 * revision of this core.
 */
export function loadCandidateSet(text: string, where: string): HashedCandidateSet {
  if (typeof text !== 'string') refuse(where, 'is not text', 'Supply the candidate set as it was written.');
  let parsed: JsonValue;
  try {
    parsed = parseJson(text);
  } catch (error) {
    refuse(where, 'is not valid JSON', 'Supply the candidate set as it was written.', { detail: error instanceof Error ? error.message : String(error) });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuse(where, 'is not a candidate set document', 'A candidate set file is an object holding candidateSetHash and candidateSet.', {
      received: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
    });
  }
  const body = (parsed as JsonObject)['candidateSet'];
  const declared = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as JsonObject)['candidateSetVersion'] : undefined;
  if (declared !== undefined && declared !== CANDIDATE_SET_VERSION) {
    refuse(where, `declares candidate set version ${String(declared)} and this core reads ${CANDIDATE_SET_VERSION}`, 'Rebuild the set with this core version.', {
      declared: String(declared),
    });
  }
  const violations = validateAgainstSchema(parsed, SERIALIZED_CANDIDATE_SET_SCHEMA);
  if (violations.length > 0) {
    refuse(where, `does not match the candidate set schema: ${summarise(violations.map((violation) => `${violation.pointer === '' ? '/' : violation.pointer}: ${violation.message}`))}`, 'Correct each listed pointer. The schema is closed, so an unknown key — including any that would carry authority — is rejected rather than ignored.', {
      violations: violations.map((violation) => ({ pointer: violation.pointer === '' ? '/' : violation.pointer, message: violation.message })),
    });
  }
  const document = parsed as unknown as { candidateSetHash: string; candidateSet: CandidateSetV1 };
  const problems = candidateSetInvariantProblems(document.candidateSet);
  if (problems.length > 0) {
    refuse(where, `breaks the candidate set invariants: ${summarise(problems.map((problem) => `${problem.pointer} ${problem.message}`))}`, 'Rebuild the set rather than editing it.', {
      problems: problems.map((problem) => ({ pointer: problem.pointer, message: problem.message })),
    });
  }
  const recomputed = hashCandidateSet(document.candidateSet);
  if (recomputed !== document.candidateSetHash) {
    refuse(where, 'does not hash to the digest it claims', 'The set has changed since it was built. Rebuild it rather than repairing the file.', {
      claimed: document.candidateSetHash,
      recomputed,
    });
  }
  // The revision. A set built by another core is about candidates another core
  // would produce; it is refused here rather than partly honoured.
  const refs = document.candidateSet.refs;
  const mismatches: string[] = [];
  if (refs.coreVersion !== CORE_VERSION) mismatches.push(`coreVersion ${refs.coreVersion} (this core is ${CORE_VERSION})`);
  if (refs.packageFormatVersion !== PACKAGE_FORMAT_VERSION) mismatches.push(`packageFormatVersion ${refs.packageFormatVersion} (this core is ${PACKAGE_FORMAT_VERSION})`);
  if (refs.configSchemaVersion !== CONFIG_SCHEMA_VERSION) mismatches.push(`configSchemaVersion ${refs.configSchemaVersion} (this core is ${CONFIG_SCHEMA_VERSION})`);
  if (refs.sourceProfileVersion !== SOURCE_PROFILE_VERSION) mismatches.push(`sourceProfileVersion ${refs.sourceProfileVersion} (this core is ${SOURCE_PROFILE_VERSION})`);
  if (mismatches.length > 0) {
    refuse(where, `was built for another revision: ${mismatches.join(', ')}`, 'Rebuild the candidate set with this core.', { reason: 'REVISION_MISMATCH', mismatches });
  }
  return { candidateSet: document.candidateSet, candidateSetHash: recomputed };
}

export interface CandidateSetExpectation {
  readonly bundleId: string;
  readonly profileHash: string;
  readonly configHash?: string;
}

/**
 * Refuse a set that is about another bundle, another profile or another plan.
 *
 * Intelligence's proposal is bound to an exact profile hash and an exact
 * revision; this is the check on the Migration Core side that the candidates it
 * chose among were the candidates of the thing being run.
 */
export function assertCandidateSetMatches(hashed: HashedCandidateSet, expect: CandidateSetExpectation): void {
  const refs = hashed.candidateSet.refs;
  const mismatches: string[] = [];
  if (refs.bundleId !== expect.bundleId) mismatches.push(`bundle ${refs.bundleId} (this run reads ${expect.bundleId})`);
  if (refs.profileHash !== expect.profileHash) mismatches.push(`profile ${refs.profileHash.slice(0, 16)} (this run holds ${expect.profileHash.slice(0, 16)})`);
  if (expect.configHash !== undefined && refs.configHash !== expect.configHash) {
    mismatches.push(`configuration ${refs.configHash.slice(0, 16)} (this run holds ${expect.configHash.slice(0, 16)})`);
  }
  if (mismatches.length > 0) {
    throw new MigrationError(
      'CANDIDATE_SET_INVALID',
      `the candidate set is about another reading: ${mismatches.join(', ')}`,
      'A proposal chosen among the candidates of one reading may not be applied to another. Rebuild the profile and the candidate set over the bundle and configuration this run is given.',
      { reason: 'REFS_MISMATCH', candidateSetHash: hashed.candidateSetHash, mismatches },
    );
  }
}
