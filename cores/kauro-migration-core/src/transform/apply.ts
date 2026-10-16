import type { FieldMappingConfig, FieldOptions, LocaleEvidence, Policies } from '../domain/config.js';
import { effectiveValueMapFrom } from '../domain/config.js';
import type { SourceCell } from '../domain/source-cell.js';
import type { TransformEvidence, TransformResult } from '../domain/transform.js';
import { makeTransformResult } from '../domain/transform.js';
import { unreachable } from '../util/assert.js';
import type { StepOutcome } from './transformations.js';
import {
  TRANSFORMATION_VERSION,
  applyCaseTransform,
  transformBoolean,
  transformDate,
  transformDateTime,
  transformEmail,
  transformEnum,
  transformIdentifier,
  transformNumber,
  transformPhone,
  transformText,
} from './transformations.js';

export const FORMULA_PROVENANCE_EVIDENCE = 'FORMULA_PROVENANCE';
export const UNICODE_NORMALIZATION_EVIDENCE = 'UNICODE_NORMALIZATION';
export const VALUE_MAP_EVIDENCE = 'VALUE_MAP';
export const CASE_TRANSFORM_EVIDENCE = 'CASE_TRANSFORM';

export interface FieldTransformInput {
  readonly cell: SourceCell;
  readonly field: FieldMappingConfig;
  readonly locale: LocaleEvidence;
  readonly policies: Policies;
  /** Country established for this cell, or null when none could be established without guessing. */
  readonly countryEvidence: string | null;
  readonly countryEvidenceSource: string;
}

/**
 * Runs one field mapping over one source cell.
 *
 * The order here is deliberate. Formula provenance and spreadsheet errors are
 * settled before any interpretation happens, whitespace trimming never runs if
 * it would empty a cell, and the only path that can turn a populated cell into
 * an empty one is an explicitly authorized clearing rule.
 *
 * The rules the configuration declares — Unicode composition, an exact value
 * mapping, a case rule — run after that and before the semantic transform, so
 * a mapped value is what the semantic transform is asked to validate. If the
 * semantic transform then returns AMBIGUOUS, INVALID or UNSUPPORTED, the
 * delivered value is still the untouched source cell: work done on the way in
 * appears in the evidence, never in the artifact.
 */
export function applyFieldTransform(input: FieldTransformInput): TransformResult {
  const { cell, field } = input;
  const raw = cell.raw;
  const transformationId = `${field.semanticType.toLowerCase()}@${field.destinationField}`;

  const build = (
    kind: TransformResult['kind'],
    final: string | null,
    reasonCode: TransformResult['reasonCode'],
    evidence: readonly TransformEvidence[],
    derived: Readonly<Record<string, string>> = {},
    destructive = false,
  ): TransformResult =>
    makeTransformResult({
      kind,
      original: raw,
      final,
      reasonCode,
      transformationId,
      transformationVersion: TRANSFORMATION_VERSION,
      safetyClass: destructive ? 'DESTRUCTIVE_EXPLICITLY_AUTHORIZED' : 'NON_DESTRUCTIVE',
      evidence,
      derived,
    });

  if (cell.kind === 'XLSX_ERROR') {
    return build('INVALID', raw, 'INGEST_XLSX_ERROR_CELL', [
      { kind: 'SOURCE_REPRESENTATION', detail: 'the spreadsheet cell holds an error value' },
    ]);
  }

  const formulaEvidence: TransformEvidence[] = [];
  if (cell.formula !== null) {
    // A formula the workbook never calculated has no cached value to accept or
    // to refuse. It is not an empty cell and it is not an omission: nobody has
    // a value for it. Both policies stop here, before the policy is consulted,
    // because "accept what the spreadsheet cached" has nothing to accept. The
    // way out is a new trusted export (calculated) or an explicit exclusion.
    if (cell.cachedValue === 'ABSENT' || raw === null) {
      return build('UNSUPPORTED', raw, 'TRANSFORM_FORMULA_CACHED_VALUE_ABSENT', [
        { kind: FORMULA_PROVENANCE_EVIDENCE, detail: `the workbook holds no cached value for the formula: ${cell.formula}` },
      ]);
    }
    if (input.policies.formulaCachedValues === 'ISOLATE_ROW') {
      return build('UNSUPPORTED', raw, 'TRANSFORM_FORMULA_CACHED_VALUE_NOT_AUTHORIZED', [
        { kind: FORMULA_PROVENANCE_EVIDENCE, detail: `formula: ${cell.formula}` },
      ]);
    }
    formulaEvidence.push({
      kind: FORMULA_PROVENANCE_EVIDENCE,
      detail: `value cached by the spreadsheet for the formula: ${cell.formula}`,
    });
  }

  if (raw === null || raw.length === 0) {
    return build('UNCHANGED', raw, formulaEvidence.length > 0 ? 'TRANSFORM_FORMULA_CACHED_VALUE_ACCEPTED' : 'TRANSFORM_UNCHANGED', formulaEvidence);
  }

  const trimmed = field.options.trim ? raw.trim() : raw;
  const trimApplied = trimmed !== raw;

  const clearing = field.options.clearWhenMatches;
  if (
    field.options.destructiveAuthorization &&
    clearing.some((candidate) => candidate.toLowerCase() === trimmed.toLowerCase())
  ) {
    return build(
      'CLEAR_EXPLICIT',
      null,
      'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION',
      [
        ...formulaEvidence,
        {
          kind: 'AUTHORIZED_CLEARING',
          detail: `the configuration authorizes clearing values equal to "${trimmed}"`,
        },
      ],
      {},
      true,
    );
  }

  // Trimming a whitespace-only cell would empty it, which the contract forbids
  // without an explicit clearing rule. Preserve the cell exactly instead.
  if (trimApplied && trimmed.length === 0) {
    return build('UNCHANGED', raw, 'TRANSFORM_UNCHANGED', [
      ...formulaEvidence,
      {
        kind: 'WHITESPACE',
        detail: 'the cell holds only whitespace; trimming was not applied because it would have emptied a populated cell',
      },
    ]);
  }

  const configured = applyConfiguredNormalization(trimmed, field.options);
  const working = configured.value;
  const step = runStep(working, input);

  const evidence: TransformEvidence[] = [...formulaEvidence, ...configured.evidence, ...step.evidence];
  if (trimApplied) {
    evidence.push({ kind: 'WHITESPACE', detail: 'leading and trailing whitespace was removed' });
  }

  switch (step.kind) {
    case 'AMBIGUOUS':
    case 'INVALID':
    case 'UNSUPPORTED':
      // Preserve the source value exactly, including any whitespace.
      return build(step.kind, raw, step.reasonCode, evidence);

    case 'CLEAR_EXPLICIT':
      return build(step.kind, step.value, step.reasonCode, evidence, step.derived, true);

    case 'UNCHANGED':
      // The semantic transform accepted the value as it found it, but the
      // configured rules may already have changed it on the way in.
      if (working !== raw) {
        return build(
          'CHANGED_SAFE',
          working,
          configured.applied ? 'TRANSFORM_CONFIGURED_NORMALIZATION_APPLIED' : 'TRANSFORM_WHITESPACE_TRIMMED',
          evidence,
          step.derived,
        );
      }
      return build(
        'UNCHANGED',
        raw,
        formulaEvidence.length > 0 && step.reasonCode === 'TRANSFORM_UNCHANGED'
          ? 'TRANSFORM_FORMULA_CACHED_VALUE_ACCEPTED'
          : step.reasonCode,
        evidence,
        step.derived,
      );

    case 'CHANGED_SAFE':
      return build('CHANGED_SAFE', step.value, step.reasonCode, evidence, step.derived);

    default:
      return unreachable(step.kind, 'applyFieldTransform');
  }
}

interface ConfiguredNormalization {
  readonly value: string;
  readonly evidence: readonly TransformEvidence[];
  /** True when one of the three configured rules changed the value. */
  readonly applied: boolean;
}

/**
 * The three configured rules, in the one order that makes them composable.
 *
 * Composition first, so a mapping and the value it matches are compared in the
 * same Unicode form. Then the exact mapping, because a mapping is how the
 * operator writes down the case the mechanical rule cannot get right, and a
 * matched value therefore skips casing entirely. Casing last, and only for a
 * value no mapping claimed.
 *
 * Every rule is off by default and applies only where the configuration says
 * so, which the loader has already checked against the semantic type.
 */
function applyConfiguredNormalization(value: string, options: FieldOptions): ConfiguredNormalization {
  const evidence: TransformEvidence[] = [];
  let working = value;

  if (options.unicodeNormalization === 'NFC') {
    const composed = working.normalize('NFC');
    if (composed !== working) {
      evidence.push({ kind: UNICODE_NORMALIZATION_EVIDENCE, detail: 'NFC' });
      working = composed;
    }
  }

  const mapped = options.valueMap.find(
    (entry) => effectiveValueMapFrom(entry.from, options) === working,
  );
  if (mapped !== undefined) {
    const target = options.unicodeNormalization === 'NFC' ? mapped.to.normalize('NFC') : mapped.to;
    evidence.push({ kind: VALUE_MAP_EVIDENCE, detail: `"${working}" -> "${target}"` });
    return { value: target, evidence, applied: target !== value };
  }

  if (options.caseTransform !== 'PRESERVE') {
    const cased = applyCaseTransform(working, options.caseTransform);
    if (cased !== working) {
      evidence.push({ kind: CASE_TRANSFORM_EVIDENCE, detail: options.caseTransform });
      working = cased;
    }
  }

  return { value: working, evidence, applied: working !== value };
}

function runStep(value: string, input: FieldTransformInput): StepOutcome {
  const { field, locale, cell } = input;
  switch (field.semanticType) {
    case 'TEXT':
    case 'URL':
      return transformText(value);

    case 'IDENTIFIER':
      return transformIdentifier(value, cell.kind === 'XLSX_NUMBER');

    case 'EMAIL':
      return transformEmail(value, field.options.lowercaseDomain);

    case 'PHONE':
      return transformPhone(value, {
        countryEvidence: input.countryEvidence,
        countryEvidenceSource: input.countryEvidenceSource,
        extensionDestinationField: field.options.extensionDestinationField,
      });

    case 'DATE':
      return transformDate(value, {
        declaredFormat: field.options.dateFormat ?? locale.dateFormat,
        spreadsheetDateSystem: cell.dateSystem,
        numberFormat: cell.numberFormat,
      });

    case 'DATETIME':
      return transformDateTime(value, field.options.timezoneOffset, field.options.timezone);

    case 'NUMBER':
      return transformNumber(
        value,
        field.options.decimalSeparator ?? locale.decimalSeparator,
        field.options.thousandsSeparator ?? locale.thousandsSeparator,
      );

    case 'BOOLEAN':
      return transformBoolean(value, field.options.trueValues, field.options.falseValues);

    case 'ENUM':
      return transformEnum(value, field.options.allowedValues ?? []);

    default:
      return unreachable(field.semanticType, 'runStep');
  }
}

/** Field outcomes that always deserve a line in the review artifact, even when nothing was changed. */
export function shouldFlag(result: TransformResult): boolean {
  if (result.kind === 'AMBIGUOUS' || result.kind === 'INVALID' || result.kind === 'UNSUPPORTED') {
    return true;
  }
  if (result.reasonCode === 'TRANSFORM_IDENTIFIER_NUMERIC_IN_SOURCE') return true;
  return result.evidence.some((item) => item.kind === FORMULA_PROVENANCE_EVIDENCE);
}
