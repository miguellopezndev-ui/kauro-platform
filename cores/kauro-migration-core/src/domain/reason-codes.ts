/**
 * Frozen registry of machine-stable reason codes.
 *
 * Every disposition, change, flag and rejection the engine emits must name a
 * code from this registry. Codes are stable identifiers; the `description` is
 * the plain-English sentence shown to a human reviewer. Adding a code is a
 * contract change and must be accompanied by a test that exercises it.
 */

export const REASON_CATEGORIES = [
  'INGEST',
  'MAPPING',
  'TRANSFORM',
  'IDENTITY',
  'ASSOCIATION',
  'DESTINATION',
] as const;

export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

export interface ReasonCodeDefinition {
  readonly category: ReasonCategory;
  readonly description: string;
}

const REGISTRY = {
  // ----------------------------------------------------------------- INGEST
  INGEST_ROW_ACCEPTED: {
    category: 'INGEST',
    description: 'The source row was read successfully and passed structural checks.',
  },
  INGEST_ROW_BLANK: {
    category: 'INGEST',
    description: 'The source row contained no value in any column.',
  },
  INGEST_ROW_COLUMN_COUNT_MISMATCH: {
    category: 'INGEST',
    description: 'The source row had a different number of columns than the header row.',
  },
  INGEST_OCCURRENCE_EXCLUDED: {
    category: 'INGEST',
    description:
      'The row belongs to a file the plan excluded as a copy of another occurrence (occurrences: EXCLUDE_ONE). It was read and counted, and it is not delivered.',
  },
  INGEST_XLSX_ERROR_CELL: {
    category: 'INGEST',
    description: 'The spreadsheet cell held a spreadsheet error value such as #REF! or #N/A.',
  },

  // ---------------------------------------------------------------- MAPPING
  LEFTOVER_NO_RECORD_MAPPING: {
    category: 'MAPPING',
    description:
      'The source sheet is not mapped to any destination object by the migration configuration, so its rows were not migrated.',
  },
  LEFTOVER_ASSOCIATION_SHEET_ONLY: {
    category: 'MAPPING',
    description:
      'The source sheet describes relationships only. Its rows produce associations rather than records.',
  },
  UNMAPPED_COLUMN_PRESERVED: {
    category: 'MAPPING',
    description:
      'The source column is not mapped to a destination field. Its value was preserved in the unmapped-fields artifact instead of being discarded.',
  },

  // -------------------------------------------------------------- TRANSFORM
  TRANSFORM_UNCHANGED: {
    category: 'TRANSFORM',
    description: 'The value was accepted exactly as it appears in the source.',
  },
  TRANSFORM_WHITESPACE_TRIMMED: {
    category: 'TRANSFORM',
    description: 'Leading and trailing whitespace was removed. No other character was altered.',
  },
  TRANSFORM_CONFIGURED_NORMALIZATION_APPLIED: {
    category: 'TRANSFORM',
    description:
      'The value was rewritten by rules the migration configuration declares for this column: Unicode composition, an exact value mapping, or a case rule. The evidence names which of them ran.',
  },
  TRANSFORM_EMAIL_DOMAIN_LOWERCASED: {
    category: 'TRANSFORM',
    description:
      'The domain part of the email address was lowercased. Domains are case-insensitive; the local part was left untouched because it is not.',
  },
  TRANSFORM_EMAIL_INVALID_SYNTAX: {
    category: 'TRANSFORM',
    description: 'The value is not a syntactically valid email address. It was preserved unchanged.',
  },
  TRANSFORM_PHONE_E164: {
    category: 'TRANSFORM',
    description: 'The phone number was rewritten in E.164 form using explicit country evidence.',
  },
  TRANSFORM_PHONE_NO_COUNTRY_EVIDENCE: {
    category: 'TRANSFORM',
    description:
      'The phone number has no international prefix and no country was established for this data, so it was preserved unchanged rather than guessed.',
  },
  TRANSFORM_PHONE_INVALID: {
    category: 'TRANSFORM',
    description:
      'The value could not be read as a valid phone number for the established country. It was preserved unchanged.',
  },
  TRANSFORM_PHONE_EXTENSION_NO_DESTINATION_FIELD: {
    category: 'TRANSFORM',
    description:
      'The phone number carries an extension but the configuration provides no destination field for it. The original value was preserved so the extension is not lost.',
  },
  TRANSFORM_PHONE_EXTENSION_SEPARATED: {
    category: 'TRANSFORM',
    description:
      'The extension was written to its configured destination field and the number was normalized.',
  },
  TRANSFORM_DATE_ISO_ACCEPTED: {
    category: 'TRANSFORM',
    description: 'The value is an unambiguous ISO 8601 calendar date and was accepted as written.',
  },
  TRANSFORM_DATE_PARSED_WITH_DECLARED_FORMAT: {
    category: 'TRANSFORM',
    description: 'The value was read using the date format declared in the migration configuration.',
  },
  TRANSFORM_DATE_AMBIGUOUS_NO_FORMAT_EVIDENCE: {
    category: 'TRANSFORM',
    description:
      'The value is not an ISO 8601 date and no date format was declared for this column, so it was preserved unchanged rather than interpreted.',
  },
  TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT: {
    category: 'TRANSFORM',
    description:
      'The value does not match the date format declared for this column. It was preserved unchanged.',
  },
  TRANSFORM_DATE_FROM_SPREADSHEET_SERIAL: {
    category: 'TRANSFORM',
    description:
      'The spreadsheet cell is stored as a date serial number carrying a date number format, so the workbook itself establishes the calendar date.',
  },
  TRANSFORM_DATETIME_NO_TIMEZONE_EVIDENCE: {
    category: 'TRANSFORM',
    description:
      'The timestamp has no time zone and none was declared for this column, so it was preserved unchanged rather than shifted.',
  },
  TRANSFORM_DATETIME_PARSED: {
    category: 'TRANSFORM',
    description: 'The timestamp was read using the declared format and the declared time zone offset or zone.',
  },
  TRANSFORM_LOCAL_TIME_AMBIGUOUS: {
    category: 'TRANSFORM',
    description:
      'The local time happens twice in the declared zone (the clocks went back) and the plan does not choose the earlier or the later occurrence, so it was preserved unchanged.',
  },
  TRANSFORM_LOCAL_TIME_NONEXISTENT: {
    category: 'TRANSFORM',
    description:
      'The local time never happens in the declared zone (the clocks went forward over it), so it was preserved unchanged rather than moved to another hour.',
  },
  TRANSFORM_NUMBER_PARSED: {
    category: 'TRANSFORM',
    description: 'The number was read using the declared decimal and thousands separators.',
  },
  TRANSFORM_NUMBER_AMBIGUOUS_SEPARATORS: {
    category: 'TRANSFORM',
    description:
      'The value can be read under more than one separator convention and none was declared, so it was preserved unchanged.',
  },
  TRANSFORM_NUMBER_INVALID: {
    category: 'TRANSFORM',
    description:
      'The value is not a number under the declared separator convention. It was preserved unchanged.',
  },
  TRANSFORM_IDENTIFIER_PRESERVED: {
    category: 'TRANSFORM',
    description:
      'The value is an identifier and was carried through as text. Leading zeros and length are preserved exactly.',
  },
  TRANSFORM_IDENTIFIER_NUMERIC_IN_SOURCE: {
    category: 'TRANSFORM',
    description:
      'The spreadsheet stored this identifier as a number, so any leading zeros were already absent from the file before this migration read it. The stored value was carried through unchanged.',
  },
  TRANSFORM_BOOLEAN_PARSED: {
    category: 'TRANSFORM',
    description: 'The value matched a declared true or false spelling and was normalized.',
  },
  TRANSFORM_BOOLEAN_UNRECOGNIZED: {
    category: 'TRANSFORM',
    description:
      'The value is not one of the declared true or false spellings. It was preserved unchanged.',
  },
  TRANSFORM_ENUM_VALUE_ACCEPTED: {
    category: 'TRANSFORM',
    description: 'The value matched one of the allowed options declared for this column.',
  },
  TRANSFORM_ENUM_VALUE_NOT_IN_DECLARED_SET: {
    category: 'TRANSFORM',
    description:
      'The value is not one of the allowed options declared for this column. It was preserved unchanged.',
  },
  TRANSFORM_FORMULA_CACHED_VALUE_NOT_AUTHORIZED: {
    category: 'TRANSFORM',
    description:
      'The spreadsheet cell holds a formula. The engine never evaluates formulas, and the configuration does not authorize using the value the spreadsheet had cached, so the value was preserved and the row was set aside.',
  },
  TRANSFORM_FORMULA_CACHED_VALUE_ABSENT: {
    category: 'TRANSFORM',
    description:
      'The spreadsheet cell holds a formula and the workbook stored no result for it, so it was never calculated. The engine never evaluates formulas and there is no cached value to accept under either policy. This is not an empty cell and it was not treated as one. Obtain a new trusted export in which the workbook has been calculated, or exclude the row or column explicitly in the configuration.',
  },
  TRANSFORM_FORMULA_CACHED_VALUE_ACCEPTED: {
    category: 'TRANSFORM',
    description:
      'The spreadsheet cell holds a formula. The configuration authorizes using the value the spreadsheet cached; the formula text is recorded as provenance and was never evaluated.',
  },
  TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION: {
    category: 'TRANSFORM',
    description:
      'The value was deliberately cleared by a rule the configuration explicitly authorized to destroy data.',
  },

  // --------------------------------------------------------------- ISOLATED
  ISOLATED_AMBIGUOUS_FIELD: {
    category: 'TRANSFORM',
    description:
      'A field on this row could not be interpreted with certainty and the configuration asks for such rows to be set aside for review.',
  },
  ISOLATED_INVALID_FIELD: {
    category: 'TRANSFORM',
    description:
      'A field on this row is not valid for its declared type and the configuration asks for such rows to be set aside for review.',
  },
  ISOLATED_UNSUPPORTED_FIELD: {
    category: 'TRANSFORM',
    description:
      'A field on this row uses source material the engine will not deliver, so the row was set aside for review.',
  },
  ISOLATED_FORMULA_CACHED_VALUE_ABSENT: {
    category: 'TRANSFORM',
    description:
      'The row depends on a spreadsheet formula the workbook never calculated, so there is no value to deliver. It was set aside for review. The remedy is a new trusted export in which the workbook has been calculated, or an explicit exclusion of the row or column in the configuration.',
  },
  ISOLATED_FORMULA_CACHED_VALUE: {
    category: 'TRANSFORM',
    description:
      'The row depends on a spreadsheet formula result the configuration has not authorized, so it was set aside for review.',
  },

  // --------------------------------------------------------------- IDENTITY
  IDENTITY_PROVEN_SOURCE_RECORD_ID: {
    category: 'IDENTITY',
    description:
      'These rows carry the same source CRM record identifier within the same source system and namespace, which proves they describe one record.',
  },
  IDENTITY_PROVEN_EXTERNAL_ID: {
    category: 'IDENTITY',
    description:
      'These rows carry the same value in a column the configuration declares to be an authoritative external identifier.',
  },
  IDENTITY_KEY_NORMALIZED: {
    category: 'IDENTITY',
    description:
      'The plan declares an identity normalization for this key column and it changed the identifier, so the row is keyed by the normalized spelling. The identifier the source wrote is preserved beside it.',
  },
  IDENTITY_NORMALIZATION_COLLISION: {
    category: 'IDENTITY',
    description:
      'Rows whose identifiers the source spelled differently share one identity key only because the plan declares an identity normalization. Every source spelling is named on the merge.',
  },
  IDENTITY_MEMBER_KEY_NOT_SHARED: {
    category: 'IDENTITY',
    description:
      'A key that only one row of a proven merge carries. It is recorded so the merged record can be read in full, but it joined nothing and is not part of the argument for merging.',
  },
  IDENTITY_SAME_ID_ACROSS_IDENTITY_SPACES: {
    category: 'IDENTITY',
    description:
      'The same raw record id appears in two different identity spaces of the same source. These may be two halves of one export or two unrelated id sequences; the engine cannot tell, so it reports the coincidence instead of acting on it.',
  },
  IDENTITY_DISTINCT_NO_PROVING_EVIDENCE: {
    category: 'IDENTITY',
    description:
      'The rows share weaker signals but nothing that proves they are the same record, so they were kept separate.',
  },
  IDENTITY_CANDIDATE_EMAIL_EXACT: {
    category: 'IDENTITY',
    description:
      'The records share the same email address. A shared email address is a signal, not proof of identity.',
  },
  IDENTITY_CANDIDATE_PHONE_E164: {
    category: 'IDENTITY',
    description: 'The records share the same phone number in international form.',
  },
  IDENTITY_CANDIDATE_NAME_EXACT: {
    category: 'IDENTITY',
    description: 'The records share the same full name.',
  },
  IDENTITY_CANDIDATE_COMPANY_DOMAIN: {
    category: 'IDENTITY',
    description: 'The records share the same company web domain.',
  },
  IDENTITY_CANDIDATE_CONFLICTING_ATTRIBUTES: {
    category: 'IDENTITY',
    description:
      'The records share a signal but disagree on other populated fields, which argues against them being one record.',
  },
  IDENTITY_CROSS_NAMESPACE_ID_COLLISION: {
    category: 'IDENTITY',
    description:
      'The same raw record identifier appears under two different source systems or namespaces. These are different records and were not combined.',
  },
  IDENTITY_MERGE_FIELD_CONFLICT: {
    category: 'IDENTITY',
    description:
      'Rows proven to be one record hold different non-empty values for the same field. No winner was chosen automatically.',
  },
  IDENTITY_MERGE_CLEAR_CONFLICT: {
    category: 'IDENTITY',
    description:
      'Rows proven to be one record disagree about whether a field should hold a value or be emptied. Choosing either would destroy one row\'s instruction, so the record was set aside.',
  },
  IDENTITY_MERGE_CONSENT_CONFLICT: {
    category: 'IDENTITY',
    description:
      'Rows proven to be one record disagree on a consent, privacy or suppression field. The engine never resolves these automatically.',
  },
  IDENTITY_MERGE_FIELD_FILLED_FROM_ABSORBED_ROW: {
    category: 'IDENTITY',
    description:
      'The surviving row had no value for this field and took the value from another row proven to be the same record.',
  },
  IDENTITY_ROW_ABSORBED_BY_PROVEN_MERGE: {
    category: 'IDENTITY',
    description: 'This row was combined into another row proven to describe the same record.',
  },
  ISOLATED_IDENTITY_CONFLICT: {
    category: 'IDENTITY',
    description:
      'Rows proven to be one record hold conflicting values, so the combined record was set aside for a human decision instead of a guess.',
  },

  // ------------------------------------------------------------ ASSOCIATION
  ASSOCIATION_RESOLVED: {
    category: 'ASSOCIATION',
    description: 'Both ends of the relationship were resolved to delivered records.',
  },
  ASSOCIATION_ENDPOINT_NOT_FOUND: {
    category: 'ASSOCIATION',
    description:
      'One end of the relationship refers to a record that does not exist in the source data. No record was invented.',
  },
  ASSOCIATION_ENDPOINT_AMBIGUOUS: {
    category: 'ASSOCIATION',
    description:
      'One end of the relationship matches more than one source record, so it could not be resolved.',
  },
  ASSOCIATION_ENDPOINT_NOT_DELIVERED: {
    category: 'ASSOCIATION',
    description:
      'One end of the relationship resolves to a record that was set aside rather than delivered, so the relationship cannot be delivered either.',
  },
  ASSOCIATION_DEDUPLICATED_AFTER_MERGE: {
    category: 'ASSOCIATION',
    description:
      'After proven records were combined, this relationship became a duplicate of another one. The relationship is delivered exactly once.',
  },
  ASSOCIATION_SELF_REFERENCE: {
    category: 'ASSOCIATION',
    description: 'Both ends of the relationship resolve to the same record.',
  },
  ASSOCIATION_UNSUPPORTED_BY_TARGET: {
    category: 'ASSOCIATION',
    description: 'The destination system does not support this relationship through file import.',
  },

  // ------------------------------------------------------------ DESTINATION
  DESTINATION_REQUIRED_FIELD_MISSING: {
    category: 'DESTINATION',
    description: 'The destination system requires this field and the record has no value for it.',
  },
  DESTINATION_KEY_CONFLICT: {
    category: 'DESTINATION',
    description:
      'Two records the source proves to be different would be matched to a single record by the destination import key. Delivering them would silently merge two different records.',
  },
  DESTINATION_VALUE_TOO_LONG: {
    category: 'DESTINATION',
    description: 'The value exceeds the maximum length the destination accepts for this field.',
  },
  DESTINATION_INSTANCE_VALUE_TOO_LONG: {
    category: 'DESTINATION',
    description:
      'The value exceeds a limit the attested target contract declares for this field in the destination instance: its length, or its numeric precision and scale. The value was preserved, not truncated; the record is set aside.',
  },
  DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN: {
    category: 'DESTINATION',
    description:
      'The value is not among the active options the attested target contract declares for this picklist field in the destination instance. It was not mapped onto a nearby option; the record is set aside.',
  },
  DESTINATION_INSTANCE_REQUIRED_FIELD_MISSING: {
    category: 'DESTINATION',
    description:
      'The attested target contract declares this field required to create a record in the destination instance, and the record has no value for it.',
  },
  TARGET_CLEAR_NOT_REPRESENTABLE: {
    category: 'DESTINATION',
    description:
      'The plan authorizes clearing this field, and the destination import path cannot express clearing an existing value. A blank cell is not an instruction to delete: this destination ignores it and keeps the value it already holds. Rather than deliver a file that silently does nothing, the record is set aside.',
  },
  TARGET_CLEAR_TOKEN_COLLISION: {
    category: 'DESTINATION',
    description:
      'A delivered value is exactly the text this format reserves for an authorized clear. Writing it would tell the reader to empty a field the source asked to fill. The record is set aside rather than delivered as an instruction nobody gave.',
  },
  DESTINATION_FORMULA_RISK_VALUE: {
    category: 'DESTINATION',
    description:
      'The delivered value begins with a character that spreadsheet applications interpret as a formula. The import file holds the exact value; import it directly rather than opening it in a spreadsheet first.',
  },
  DESTINATION_INSTANCE_VERIFICATION_REQUIRED: {
    category: 'DESTINATION',
    description:
      'Whether the destination accepts this depends on configuration inside the customer account, which cannot be checked from files alone.',
  },
} as const satisfies Record<string, ReasonCodeDefinition>;

export type ReasonCode = keyof typeof REGISTRY;

export const REASON_CODES: Readonly<Record<ReasonCode, ReasonCodeDefinition>> = REGISTRY;

export const REASON_CODE_LIST: readonly ReasonCode[] = (
  Object.keys(REGISTRY) as ReasonCode[]
).sort();

export function reasonCodeDescription(code: ReasonCode): string {
  return REGISTRY[code].description;
}

export function isReasonCode(value: string): value is ReasonCode {
  return Object.prototype.hasOwnProperty.call(REGISTRY, value);
}
