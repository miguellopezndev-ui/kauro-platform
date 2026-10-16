/**
 * IntelligenceProposalV1 — the closed output of one model task, canon §25–§29.
 *
 * The parser proves the shape; the compiler proves the truth. A proposal can
 * name only refs the envelope carried, only proposal types the constraints
 * allowed, only primitives from the closed catalogue; its evidence class is
 * derived by the compiler from the evidence refs, never trusted from the
 * model; a rationale is a short code and at most a sentence, never code.
 */
import { HEX64_PATTERN, IDENTIFIER_PATTERN, REF_PATTERN, VERSION_PATTERN, s, validate } from './schema.js';
import type { Schema, SchemaProblem } from './schema.js';
import { PROPOSAL_TYPES } from './envelope.js';
import type { ProposalType } from './envelope.js';
import { PROPOSAL_SCHEMA_VERSION } from './versions.js';

export const EVIDENCE_CLASSES = Object.freeze(['STRONG', 'SUPPORTED', 'AMBIGUOUS', 'INSUFFICIENT'] as const);
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const OVERALL_OUTCOMES = Object.freeze(['PROPOSED', 'ABSTAINED', 'MIXED'] as const);

/** Rationale codes: the closed vocabulary a proposal explains itself with. */
export const RATIONALE_CODES = Object.freeze([
  'HEADER_MATCHES_TARGET_LABEL',
  'HEADER_MATCHES_TARGET_API_NAME',
  'SHAPE_MATCHES_TARGET_TYPE',
  'MEMORY_CONVENTION_APPLIES',
  'VALUES_ARE_TARGET_OPTIONS',
  'UNIQUE_AND_WELL_FORMED_IDENTIFIER',
  'FOREIGN_KEY_COLUMN',
  'NO_TARGET_IN_ENVELOPE',
  'AMBIGUOUS_BETWEEN_TARGETS',
  'VALUE_NOT_IN_TARGET_OPTIONS',
  'REQUIRED_TARGET_UNSATISFIED',
  'DESTRUCTIVE_NEEDS_AGENCY',
  'IDENTITY_NEEDS_PROOF',
  'INSUFFICIENT_EVIDENCE',
  'OUT_OF_SUPPORT_ENVELOPE',
] as const);
export type RationaleCode = (typeof RATIONALE_CODES)[number];

export const ABSTAIN_REASONS = Object.freeze(['NO_VALID_TARGET', 'AMBIGUOUS', 'INSUFFICIENT_EVIDENCE', 'OUT_OF_SCOPE', 'POLICY'] as const);

/**
 * The closed catalogue of transformation primitives a proposal may name.
 * Each is one of Migration Core's supported behaviours per semantic type; the
 * parameters are closed too. There is no free-form transform: no regex, no
 * expression, no locale guessed from geography.
 */
export const PRIMITIVES = Object.freeze({
  TRIM_WHITESPACE: Object.freeze({ params: Object.freeze([]), destructive: false, semanticTypes: Object.freeze(['TEXT', 'EMAIL', 'PHONE', 'URL', 'IDENTIFIER', 'ENUM']) }),
  NORMALISE_EMAIL_CASE: Object.freeze({ params: Object.freeze([]), destructive: false, semanticTypes: Object.freeze(['EMAIL']) }),
  PARSE_PHONE_E164: Object.freeze({ params: Object.freeze(['defaultRegion']), destructive: false, semanticTypes: Object.freeze(['PHONE']) }),
  // D3-CAP-04: the date format is one of Migration Core's own, which names the separator; `dayFirst` named none and could not be expressed.
  PARSE_DATE_ISO: Object.freeze({ params: Object.freeze(['dateFormat']), destructive: false, semanticTypes: Object.freeze(['DATE', 'DATETIME']) }),
  NORMALISE_BOOLEAN: Object.freeze({ params: Object.freeze([]), destructive: false, semanticTypes: Object.freeze(['BOOLEAN']) }),
  NORMALISE_NUMBER: Object.freeze({ params: Object.freeze(['decimalSeparator']), destructive: false, semanticTypes: Object.freeze(['NUMBER']) }),
  // D3-CAP-05: a value map names its `to` only. The `from` is the value the candidate stands for, from the host's categorical summaries, never a text the model writes.
  MAP_ENUM_VALUE: Object.freeze({ params: Object.freeze(['to']), destructive: false, semanticTypes: Object.freeze(['ENUM']) }),
  PRESERVE_AS_IS: Object.freeze({ params: Object.freeze([]), destructive: false, semanticTypes: Object.freeze(['TEXT', 'EMAIL', 'PHONE', 'DATE', 'DATETIME', 'NUMBER', 'IDENTIFIER', 'BOOLEAN', 'ENUM', 'URL']) }),
  CLEAR_VALUE: Object.freeze({ params: Object.freeze([]), destructive: true, semanticTypes: Object.freeze(['TEXT', 'EMAIL', 'PHONE', 'DATE', 'DATETIME', 'NUMBER', 'IDENTIFIER', 'BOOLEAN', 'ENUM', 'URL']) }),
});
export type PrimitiveRef = keyof typeof PRIMITIVES;
export const PRIMITIVE_REFS = Object.freeze(Object.keys(PRIMITIVES) as PrimitiveRef[]);

/**
 * The date formats a PARSE_DATE_ISO may name: exactly the dateFormat enum of
 * the vendored Migration Core configuration schema, in its order. The
 * release does not export the list, so it is stated here and a test compares
 * it with the schema the release ships (spec/contract/config.schema.json).
 */
export const DATE_FORMAT_DOMAIN = Object.freeze(['ISO_8601', 'MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY/MM/DD', 'MM-DD-YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'MM.DD.YYYY', 'SPREADSHEET_SERIAL'] as const);

/** Parameter value domains, closed. A value inside its domain is still refused unless the evidence names it (D3-CAP-04). */
export const PRIMITIVE_PARAM_DOMAINS: Readonly<Record<string, RegExp>> = Object.freeze({
  defaultRegion: /^[A-Z]{2}$/u,
  dateFormat: new RegExp(`^(?:${DATE_FORMAT_DOMAIN.map((format) => format.replace(/[.]/gu, '\\.')).join('|')})$`, 'u'),
  decimalSeparator: /^[.,]$/u,
  to: /^.{1,256}$/su,
});

/**
 * What the project declares about how its data is written (D3-CAP-04) —
 * the agency's facts, never inferred from geography or a header: the region
 * its local phone numbers are dialled in (an ISO 3166-1 alpha-2 country) and
 * the date format its dates are written in (one of DATE_FORMAT_DOMAIN). The
 * only evidence a PARSE_PHONE_E164 region or a PARSE_DATE_ISO format can
 * stand on; a decimal separator stands on the full-data shapes instead.
 */
export interface LocaleEvidence {
  readonly defaultRegion?: string;
  readonly dateFormat?: string;
}

export interface ProposalItem {
  readonly candidateRef: string;
  readonly proposalType: ProposalType;
  readonly targetRef: string | null;
  readonly transformPrimitive: PrimitiveRef | null;
  readonly typedTransformParams: Readonly<Record<string, string>> | null;
  readonly evidenceRefs: readonly string[];
  readonly requiresAgencyDecision: boolean;
  readonly rationaleCode: RationaleCode;
  readonly shortRationale: string | null;
  readonly alternatives: readonly { readonly targetRef: string; readonly rationaleCode: RationaleCode }[];
  readonly abstainReason: (typeof ABSTAIN_REASONS)[number] | null;
}

export interface IntelligenceProposalV1 {
  readonly schemaVersion: string;
  readonly taskId: string;
  readonly runId: string;
  readonly modelPolicyVersion: string;
  readonly promptBundleVersion: string;
  readonly envelopeHash: string;
  readonly items: readonly ProposalItem[];
  readonly overallOutcome: (typeof OVERALL_OUTCOMES)[number];
}

const ref = s.string({ pattern: REF_PATTERN, maxLength: 64 });

export const PROPOSAL_ITEM_SCHEMA: Schema = s.object({
  candidateRef: ref,
  proposalType: s.enumOf([...PROPOSAL_TYPES]),
  targetRef: s.nullable(ref),
  transformPrimitive: s.nullable(s.enumOf([...PRIMITIVE_REFS])),
  typedTransformParams: s.nullable(s.record(s.string({ maxLength: 256 }), { keyPattern: /^[a-zA-Z][a-zA-Z0-9]{0,31}$/u, maxKeys: 8 })),
  evidenceRefs: s.array(ref, { maxItems: 32, unique: true }),
  requiresAgencyDecision: s.boolean(),
  rationaleCode: s.enumOf([...RATIONALE_CODES]),
  shortRationale: s.nullable(s.string({ maxLength: 512 })),
  alternatives: s.array(s.object({ targetRef: ref, rationaleCode: s.enumOf([...RATIONALE_CODES]) }), { maxItems: 8 }),
  abstainReason: s.nullable(s.enumOf([...ABSTAIN_REASONS])),
});

export const PROPOSAL_SCHEMA: Schema = s.object({
  schemaVersion: s.literal(PROPOSAL_SCHEMA_VERSION),
  taskId: ref,
  runId: ref,
  modelPolicyVersion: s.string({ pattern: VERSION_PATTERN }),
  promptBundleVersion: s.string({ pattern: VERSION_PATTERN }),
  envelopeHash: s.string({ pattern: HEX64_PATTERN }),
  items: s.array(PROPOSAL_ITEM_SCHEMA, { minItems: 1, maxItems: 512 }),
  overallOutcome: s.enumOf([...OVERALL_OUTCOMES]),
});

/** The JSON Schema handed to the provider as the structured-output contract; the same closure, in the provider's dialect. */
export function proposalJsonSchema(): Record<string, unknown> {
  const str = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'string', ...extra });
  const nullable = (schema: Record<string, unknown>): Record<string, unknown> => ({ anyOf: [schema, { type: 'null' }] });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'taskId', 'runId', 'modelPolicyVersion', 'promptBundleVersion', 'envelopeHash', 'items', 'overallOutcome'],
    properties: {
      schemaVersion: { const: PROPOSAL_SCHEMA_VERSION },
      taskId: str({ pattern: REF_PATTERN.source }),
      runId: str({ pattern: REF_PATTERN.source }),
      modelPolicyVersion: str({ pattern: VERSION_PATTERN.source }),
      promptBundleVersion: str({ pattern: VERSION_PATTERN.source }),
      envelopeHash: str({ pattern: HEX64_PATTERN.source }),
      overallOutcome: { enum: [...OVERALL_OUTCOMES] },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 512,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['candidateRef', 'proposalType', 'targetRef', 'transformPrimitive', 'typedTransformParams', 'evidenceRefs', 'requiresAgencyDecision', 'rationaleCode', 'shortRationale', 'alternatives', 'abstainReason'],
          properties: {
            candidateRef: str({ pattern: REF_PATTERN.source }),
            proposalType: { enum: [...PROPOSAL_TYPES] },
            targetRef: nullable(str({ pattern: REF_PATTERN.source })),
            transformPrimitive: nullable({ enum: [...PRIMITIVE_REFS] }),
            typedTransformParams: nullable({ type: 'object', additionalProperties: { type: 'string', maxLength: 256 }, maxProperties: 8 }),
            evidenceRefs: { type: 'array', items: str({ pattern: REF_PATTERN.source }), maxItems: 32, uniqueItems: true },
            requiresAgencyDecision: { type: 'boolean' },
            rationaleCode: { enum: [...RATIONALE_CODES] },
            shortRationale: nullable(str({ maxLength: 512 })),
            alternatives: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['targetRef', 'rationaleCode'], properties: { targetRef: str({ pattern: REF_PATTERN.source }), rationaleCode: { enum: [...RATIONALE_CODES] } } } },
            abstainReason: nullable({ enum: [...ABSTAIN_REASONS] }),
          },
        },
      },
    },
  };
}

export function proposalShapeProblems(value: unknown): readonly SchemaProblem[] {
  return validate(value, PROPOSAL_SCHEMA);
}

export const IDENTIFIER = IDENTIFIER_PATTERN;
