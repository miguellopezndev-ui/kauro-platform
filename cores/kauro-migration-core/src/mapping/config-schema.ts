import type { Schema } from './schema-validator.js';
import {
  CANONICAL_OBJECTS,
  FIELD_SEMANTICS_CLASSES,
  IMPORT_MODES,
  SEMANTIC_TYPES,
} from '../domain/canonical.js';
import { RELATIONSHIP_TYPES } from '../domain/associations.js';
import { SOURCE_ENCODINGS, SOURCE_FORMATS } from '../domain/locators.js';
import {
  CASE_TRANSFORMS,
  CONFIG_SCHEMA_VERSION,
  OCCURRENCE_DECISIONS,
  DATE_FORMATS,
  DELIMITERS,
  UNICODE_NORMALIZATIONS,
  TARGET_MODES,
  MATCH_AUTHORITIES,
  TIMEZONE_OVERLAP_POLICIES,
  MATCH_CONFLICT_POLICIES,
  MISSING_MATCH_POLICIES,
} from '../domain/config.js';

const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });

const stringEnum = (values: readonly string[], description: string): Schema => ({
  type: 'string',
  enum: values,
  description,
});

const IDENTIFIER: Schema = {
  type: 'string',
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  description: 'Stable identifier used to cross-reference this entry from elsewhere in the configuration.',
};

const columnRef = (extra: Readonly<Record<string, Schema>> = {}): Schema => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    header: nullable({ type: 'string', description: 'Header text to match, compared exactly.' }),
    occurrence: nullable({
      type: 'integer',
      minimum: 1,
      description: 'Which occurrence of a repeated header to use, counting from 1.',
    }),
    index: nullable({
      type: 'integer',
      minimum: 0,
      description: 'Zero-based physical column position. Cannot be combined with header.',
    }),
    ...extra,
  },
  description: 'Address of a source column, either by header text or by physical position.',
});

const COLUMN_REF: Schema = columnRef();

const IDENTITY_NORMALIZATION: Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    trim: { type: 'boolean', description: 'Remove leading and trailing whitespace from the identifier before it is keyed. Default false.' },
    unicode: nullable(
      stringEnum(['NFC'], 'Compose the identifier to Unicode NFC before it is keyed. Default none: the code points the source wrote.'),
    ),
  },
  description:
    'A declared identity normalization. Without it the identifier enters its identity key exactly as the source wrote it. Every row it changes is flagged, and a merge it causes is recorded as an identity decision.',
};

const KEY_COLUMN_REF: Schema = columnRef({ identityNormalization: nullable(IDENTITY_NORMALIZATION) });

const FIELD_OPTIONS: Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    trim: { type: 'boolean', description: 'Remove leading and trailing whitespace from this field. Default false: whitespace is part of the value until a field approves removing it.' },
    unicodeNormalization: stringEnum(
      UNICODE_NORMALIZATIONS,
      'Canonical Unicode composition for TEXT and ENUM. NFC composes; PRESERVE changes nothing. Default PRESERVE.',
    ),
    caseTransform: stringEnum(
      CASE_TRANSFORMS,
      'Mechanical re-casing for TEXT. TITLE_SIMPLE upper-cases the first letter after the start of the value, Unicode whitespace, "-", "\'" or "’", and has no dictionary of exceptions. Skipped when valueMap matched. Default PRESERVE.',
    ),
    valueMap: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: {
            type: 'string',
            minLength: 1,
            description:
              'The exact source value, compared after trimming and Unicode normalization if this field declares them, and never case-folded.',
          },
          to: {
            type: 'string',
            minLength: 1,
            description: 'The exact value delivered in its place. It can never be empty; clearing a value is clearWhenMatches.',
          },
        },
      },
      description:
        'Exact value substitutions for TEXT and ENUM. Array order carries no meaning and two entries that compare equal are rejected. A value that matches nothing is left for caseTransform and the semantic transform to handle.',
    },
    lowercaseDomain: {
      type: 'boolean',
      description: 'For EMAIL, lowercase the domain part. The local part is never altered. Default true.',
    },
    phoneCountry: nullable({
      type: 'string',
      pattern: '^[A-Z]{2}$',
      description: 'ISO 3166-1 alpha-2 country used for phone numbers with no international prefix.',
    }),
    phoneCountryColumn: nullable(COLUMN_REF),
    extensionDestinationField: nullable({
      type: 'string',
      minLength: 1,
      description: 'Destination field that receives a phone extension. Without it, numbers carrying an extension are preserved unchanged.',
    }),
    dateFormat: nullable(stringEnum(DATE_FORMATS, 'Declared source date format for this column.')),
    timezoneOffset: nullable({
      type: 'string',
      pattern: '^(Z|[+-][0-9]{2}:[0-9]{2})$',
      description: 'Time zone offset applied to timestamps that carry none, for example "+00:00".',
    }),
    timezone: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['zone', 'tzdata', 'overlap'],
      properties: {
        zone: { type: 'string', minLength: 1, description: 'An IANA time zone name, for example "Europe/Madrid".' },
        tzdata: {
          type: 'string',
          minLength: 1,
          description: 'The tzdata release the zone was declared against. It must equal the release of the runtime, or the plan is refused.',
        },
        overlap: stringEnum(
          TIMEZONE_OVERLAP_POLICIES,
          'What to do with a local time that happens twice (the clocks go back): REFUSE leaves it AMBIGUOUS, EARLIER or LATER choose the first or second occurrence. A local time that does not exist (the clocks go forward) is always unresolved.',
        ),
      },
      description:
        'A declared time zone for DATETIME values that carry no offset. Mutually exclusive with timezoneOffset. An offset the value carries always outranks it.',
    }),
    decimalSeparator: nullable({ type: 'string', enum: ['.', ','], description: 'Decimal separator for NUMBER.' }),
    thousandsSeparator: nullable({
      type: 'string',
      enum: ['.', ',', ' ', "'", 'NONE'],
      description: 'Thousands separator for NUMBER, or NONE when the source uses no grouping.',
    }),
    trueValues: { type: 'array', items: { type: 'string' }, description: 'Spellings that mean true, compared case-insensitively.' },
    falseValues: { type: 'array', items: { type: 'string' }, description: 'Spellings that mean false, compared case-insensitively.' },
    allowedValues: nullable({ type: 'array', items: { type: 'string' }, description: 'Allowed options for ENUM.' }),
    clearWhenMatches: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Values the customer authorizes the engine to erase, compared case-insensitively (after trimming, if this field trims). Requires destructiveAuthorization.',
    },
    destructiveAuthorization: {
      type: 'boolean',
      description: 'Explicit permission for this field mapping to turn a non-empty source value into an empty one.',
    },
  },
};

const FIELD_MAPPING: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['column', 'destinationField', 'semanticType'],
  properties: {
    column: COLUMN_REF,
    destinationField: {
      type: 'string',
      minLength: 1,
      description: 'A canonical field name, or "custom:<Header>" for a destination-specific field.',
    },
    semanticType: stringEnum(SEMANTIC_TYPES, 'How the source value should be interpreted.'),
    semanticsClass: nullable(
      stringEnum(
        FIELD_SEMANTICS_CLASSES,
        'Declares that this column carries consent, privacy or suppression meaning. Such a field is never resolved by a merge policy.',
      ),
    ),
    required: { type: 'boolean', description: 'Treat a missing value as a reason to set the row aside. Default false.' },
    onAmbiguous: stringEnum(
      ['PRESERVE', 'ISOLATE_ROW'],
      'What to do when the value cannot be interpreted with certainty. Default PRESERVE.',
    ),
    onInvalid: stringEnum(
      ['PRESERVE', 'ISOLATE_ROW'],
      'What to do when the value is invalid for its declared type. Default PRESERVE.',
    ),
    options: FIELD_OPTIONS,
  },
};

const RECORD_MAPPING: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'fileId', 'object', 'fields'],
  properties: {
    id: IDENTIFIER,
    fileId: IDENTIFIER,
    sheet: nullable({ type: 'string', description: 'Worksheet name. Null selects the only sheet.' }),
    identitySpace: nullable({
      type: 'string',
      minLength: 1,
      description:
        'Scope inside which the record ids on this sheet are unique. Defaults to the mapping id, so two sheets with independent id sequences never collide. Two sheets that are halves of one export declare the same value.',
    }),
    object: stringEnum(CANONICAL_OBJECTS, 'Canonical object this sheet describes.'),
    sourceRecordIdColumn: nullable(KEY_COLUMN_REF),
    authoritativeExternalIdColumns: {
      type: 'array',
      items: KEY_COLUMN_REF,
      description:
        'Columns the customer declares to be authoritative external identifiers. Equal values in these columns prove two rows are one record.',
    },
    fields: { type: 'array', items: FIELD_MAPPING, minItems: 1 },
  },
};

const COLUMN_REFERENCE_ASSOCIATION: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'recordMappingId', 'relationshipType', 'keyColumn', 'targetRecordMappingId'],
  properties: {
    id: IDENTIFIER,
    kind: { type: 'string', enum: ['COLUMN_REFERENCE'] },
    recordMappingId: IDENTIFIER,
    relationshipType: stringEnum(RELATIONSHIP_TYPES, 'The kind of relationship this column expresses.'),
    ownerSide: stringEnum(
      ['FROM', 'TO'],
      'Which end of the relationship the rows carrying the key column sit on. Default FROM.',
    ),
    keyColumn: COLUMN_REF,
    targetRecordMappingId: IDENTIFIER,
    targetMatchKey: stringEnum(
      ['SOURCE_RECORD_ID', 'COLUMN'],
      'Whether the key value matches the target record id or a named target column. Default SOURCE_RECORD_ID.',
    ),
    targetMatchColumn: nullable(COLUMN_REF),
    label: nullable({ type: 'string', description: 'Relationship label carried into the destination where supported.' }),
  },
};

const EDGE_FILE_ASSOCIATION: Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'fileId',
    'relationshipType',
    'fromRecordMappingId',
    'fromKeyColumn',
    'toRecordMappingId',
    'toKeyColumn',
  ],
  properties: {
    id: IDENTIFIER,
    kind: { type: 'string', enum: ['EDGE_FILE'] },
    fileId: IDENTIFIER,
    sheet: nullable({ type: 'string' }),
    relationshipType: stringEnum(RELATIONSHIP_TYPES, 'The kind of relationship each row expresses.'),
    fromRecordMappingId: IDENTIFIER,
    fromKeyColumn: COLUMN_REF,
    toRecordMappingId: IDENTIFIER,
    toKeyColumn: COLUMN_REF,
    labelColumn: nullable(COLUMN_REF),
    label: nullable({ type: 'string' }),
  },
};

const FILE_CONFIG: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'path', 'format'],
  properties: {
    id: IDENTIFIER,
    path: { type: 'string', minLength: 1, description: 'Path relative to the input bundle root.' },
    format: stringEnum(SOURCE_FORMATS, 'Source file format.'),
    encoding: nullable(stringEnum(SOURCE_ENCODINGS, 'Declared encoding, overriding byte-order-mark detection.')),
    delimiter: nullable(stringEnum(DELIMITERS, 'CSV field delimiter. Default is a comma.')),
    sourceSystem: nullable({ type: 'string', minLength: 1, description: 'Overrides source.system for this file.' }),
    sourceNamespace: nullable({ type: 'string', minLength: 1, description: 'Overrides source.namespace for this file.' }),
    sheets: nullable({
      type: 'array',
      items: { type: 'string' },
      description:
        'Asserts the exact set of worksheet names the workbook must contain; the run fails if it differs. Every sheet is always ingested so that no row escapes accounting. Null skips the assertion.',
    }),
  },
};

const DESTINATION_MATCH: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['recordMappingId', 'matchAuthority'],
  properties: {
    recordMappingId: { type: 'string', minLength: 1, description: 'The record mapping this declaration governs.' },
    matchAuthority: stringEnum(
      MATCH_AUTHORITIES,
      'What the destination matches an existing record on. Never a Kauro-owned column: a trace key names a delivered record, it is not evidence about the destination instance.',
    ),
    targetField: nullable({
      type: 'string',
      minLength: 1,
      description:
        'The destination field, by the name the instance answers to. It must exist in the captured target contract carrying the attributes the authority requires. Kauro never creates it.',
    }),
    sourceField: nullable({
      type: 'string',
      minLength: 1,
      description: 'The mapped field on this record whose value is the match value.',
    }),
    onMissingMatch: stringEnum(
      MISSING_MATCH_POLICIES,
      'What to do with a row whose declared match value finds nothing at the destination.',
    ),
    onMatchConflict: stringEnum(
      MATCH_CONFLICT_POLICIES,
      'What to do when two source records carry the same match value. Delivering both would make the destination merge them, so no policy does.',
    ),
  },
};

export const CONFIG_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['configVersion', 'source', 'target', 'files', 'records'],
  description: `kauro-migration-core configuration, schema version ${CONFIG_SCHEMA_VERSION}.`,
  properties: {
    configVersion: { type: 'string', enum: [CONFIG_SCHEMA_VERSION] },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['system', 'namespace'],
      properties: {
        system: { type: 'string', minLength: 1, description: 'Name of the system the export came from.' },
        namespace: {
          type: 'string',
          minLength: 1,
          description: 'Scope within which a source record id is unique. Two exports from different customers must use different namespaces.',
        },
        encoding: nullable(stringEnum(SOURCE_ENCODINGS, 'Default encoding for every file in the bundle.')),
      },
    },
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'importMode'],
      properties: {
        mode: stringEnum(TARGET_MODES, 'The commercial mode. CLEAN_ONLY has no destination instance.'),
        importMode: stringEnum(IMPORT_MODES, 'Intent of the import. Never inferred from the presence of an id column.'),
      },
    },
    localeEvidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phoneCountry: nullable({ type: 'string', pattern: '^[A-Z]{2}$' }),
        dateFormat: nullable(stringEnum(DATE_FORMATS, 'Default date format for every DATE column.')),
        decimalSeparator: nullable({ type: 'string', enum: ['.', ','] }),
        thousandsSeparator: nullable({ type: 'string', enum: ['.', ',', ' ', "'", 'NONE'] }),
      },
      description: 'Facts about the data that the engine may not infer for itself.',
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxFiles: { type: 'integer', minimum: 1 },
        maxBytesPerFile: { type: 'integer', minimum: 1 },
        maxTotalBytes: { type: 'integer', minimum: 1 },
        maxSheetsPerFile: { type: 'integer', minimum: 1 },
        maxRowsPerSheet: { type: 'integer', minimum: 1 },
        maxColumnsPerSheet: { type: 'integer', minimum: 1 },
        maxCellLength: { type: 'integer', minimum: 1 },
        maxWorkbookUncompressedBytes: { type: 'integer', minimum: 1 },
        maxWorkbookPartUncompressedBytes: { type: 'integer', minimum: 1 },
        maxRecordBytes: { type: 'integer', minimum: 1 },
      },
    },
    policies: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rowShapeMismatch: stringEnum(['REJECT_ROW', 'FAIL_RUN'], 'Rows whose column count differs from the header.'),
        blankRow: stringEnum(['REJECT_ROW', 'FAIL_RUN'], 'Rows with no value in any column.'),
        formulaCachedValues: stringEnum(
          ['ISOLATE_ROW', 'ACCEPT_WITH_PROVENANCE'],
          'Whether a value the spreadsheet computed may be delivered. Formulas are never evaluated either way.',
        ),
        destinationKeyConflict: stringEnum(['ISOLATE', 'DELIVER_WITH_ALTERNATE_KEY'], 'Distinct records colliding on the destination key.'),
        mergeFieldConflict: stringEnum(['ISOLATE_RECORD', 'PREFER_SURVIVOR'], 'Proven-identical rows disagreeing on a populated field.'),
        mergeFieldConflictJustification: nullable({
          type: 'string',
          minLength: 1,
          description: 'Why PREFER_SURVIVOR is safe for this dataset. Required when that policy is selected.',
        }),
      },
    },
    files: { type: 'array', items: FILE_CONFIG, minItems: 1 },
    records: { type: 'array', items: RECORD_MAPPING },
    associations: {
      type: 'array',
      items: { anyOf: [COLUMN_REFERENCE_ASSOCIATION, EDGE_FILE_ASSOCIATION] },
    },
    occurrences: {
      type: 'array',
      description:
        'What to do with files that hold the same bytes inside one source namespace. Equal bytes in different namespaces are two occurrences and need no declaration. INDEPENDENT reads every listed file as its own export; EXCLUDE_ONE keeps the first listed file and rejects every row of the others, by name.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['files', 'decision'],
        properties: {
          files: {
            type: 'array',
            minItems: 2,
            items: IDENTIFIER,
            description: 'The ids of the files the decision covers. Their bytes must be equal.',
          },
          decision: stringEnum(OCCURRENCE_DECISIONS, 'Whether the listed files are independent exports or one is a copy to leave out.'),
        },
      },
    },
    destinationMatching: {
      type: 'array',
      description:
        'What the destination is asked to match an existing record on. One entry per record mapping when the import mode matches an existing record; empty under CREATE_ONLY, which matches nothing.',
      items: DESTINATION_MATCH,
    },
  },
};
