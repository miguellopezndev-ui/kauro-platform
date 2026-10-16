import { MigrationError } from '../domain/errors.js';
import { readCsv } from '../ingest/csv-reader.js';
import type { CsvRecord } from '../ingest/csv-reader.js';
import { validateAgainstSchema } from '../mapping/schema-validator.js';
import type { Schema } from '../mapping/schema-validator.js';
import { invariant } from '../util/assert.js';
import { sha256Hex } from '../util/hash.js';
import { compareCodeUnits, parseJson } from '../util/json.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import { TARGET_CONTRACT_VERSION, TARGET_PARSER_VERSION } from './contract.js';
import type {
  TargetArtifactRef,
  TargetContract,
  TargetFieldContract,
  TargetFlag,
  TargetObjectContract,
  TargetPicklistValue,
  TargetPipeline,
  TargetPipelineStage,
} from './contract.js';

/**
 * Readers for the artifacts a HubSpot portal can produce about itself.
 *
 * A target contract speaks for one portal, and nothing here reaches the
 * network, so every fact in it arrives as bytes somebody captured and handed
 * over. This file turns four of those into contract material and refuses
 * anything it cannot read unambiguously.
 *
 * Three of the four are files a person produced: the property export, the
 * pipelines artifact and the supplement. The fourth is the body of a
 * `GET /crm/v3/properties/{objectType}` response, captured on the credential a
 * run already holds. It is read by a second parser rather than folded into the
 * first because it is a different artifact stating overlapping facts, and where
 * a contract is built from both, `buildHubSpotTargetContract` holds the two
 * readings against each other and refuses a contract they disagree about. That
 * check is the point of having two readers: neither of them is trusted to be
 * right, they are trusted to catch each other.
 *
 * What the documentation establishes, reviewed 2026-09-01 against
 * knowledge.hubspot.com/properties/organize-and-export-properties:
 *
 *   - The property export is produced from Settings -> Properties -> "Export
 *     all properties". Selecting several objects yields a ZIP holding one file
 *     per object, delivered asynchronously by an emailed download link.
 *   - The knowledge base calls the result "a spreadsheet" and offers a format
 *     dropdown it never enumerates. The file format is therefore chosen by the
 *     person exporting, and this reader detects the delimiter rather than
 *     assuming one.
 *   - The columns are given only as lower-case prose: name, internal name,
 *     type, description, group, options (if applicable), user that created it,
 *     usages, fill rate, and for contact, company, deal and ticket properties
 *     also last updated time and update source. Their literal spelling, their
 *     casing and their order are not documented anywhere, so no single spelling
 *     is treated as the only accepted one.
 *
 * What the export does not carry, and therefore what no reading of it can
 * establish: whether a property requires unique values, a field type distinct
 * from the type, whether a property is required, the display order, and whether
 * a property is custom or default. Each of those comes out of here as UNKNOWN
 * or is absent, never as FALSE.
 *
 * Deal pipelines and stages are a separate artifact because the property export
 * carries neither, and a HubSpot deal cannot be imported without the pipeline
 * and stage the portal answers to. No default pipeline and no default stage is
 * assumed anywhere in this file.
 */

/** Bounds on a single artifact. Every one of these refuses input rather than trimming it. */
export interface HubSpotArtifactLimits {
  /** Characters in the decoded artifact text, checked before any parsing happens. */
  readonly maxCharacters: number;
  /** Records including the header row, enforced by the CSV reader. */
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCellLength: number;
  /** Options in one picklist cell. A cell that splits into more than this is refused rather than truncated. */
  readonly maxPicklistOptions: number;
  /** Artifacts one contract may be built from. */
  readonly maxArtifacts: number;
  /** Total bytes across those artifacts. */
  readonly maxArtifactBytes: number;
}

export const DEFAULT_HUBSPOT_ARTIFACT_LIMITS: HubSpotArtifactLimits = {
  maxCharacters: 33_554_432,
  maxRows: 20_000,
  maxColumns: 256,
  maxCellLength: 131_072,
  maxPicklistOptions: 2_000,
  maxArtifacts: 32,
  maxArtifactBytes: 268_435_456,
};

/**
 * Where a candidate header spelling comes from.
 *
 * `DOCUMENTED_PROSE` is a word the knowledge base itself uses for the column.
 * `UNCONFIRMED_VARIANT` is a spelling nobody has seen in an export; it is here
 * so a real file has a chance of being read, and it carries no authority.
 * `KAURO_CANONICAL` belongs to an artifact this repository defines, where the
 * column names are stated by us rather than discovered.
 */
export type HeaderProvenance = 'DOCUMENTED_PROSE' | 'UNCONFIRMED_VARIANT' | 'KAURO_CANONICAL';

export interface HeaderCandidate {
  /** Already in matching form: lower case, single spaces. Normalizing this string returns this string. */
  readonly spelling: string;
  readonly provenance: HeaderProvenance;
  /** The date a real export was seen carrying exactly this header, or null while nobody has seen one. */
  readonly confirmedOn: string | null;
}

export interface HeaderRole<Role extends string> {
  readonly role: Role;
  /** A required role that matches no column fails the read. An optional one that matches none is simply absent. */
  readonly required: boolean;
  readonly candidates: readonly HeaderCandidate[];
}

export const HUBSPOT_PROPERTY_ROLES = [
  'INTERNAL_NAME',
  'LABEL',
  'TYPE',
  'GROUP',
  'DESCRIPTION',
  'OPTIONS',
  'READ_ONLY_VALUE',
  'CALCULATED',
] as const;
export type HubSpotPropertyRole = (typeof HUBSPOT_PROPERTY_ROLES)[number];

/**
 * The declared header semantics of the property export.
 *
 * Every spelling below is a candidate and none is authority. Matching is exact
 * against the normalized form of a header, so "internal name" and "name" are
 * different columns however similar they look, and a spelling that matches
 * nothing costs nothing.
 *
 * Correcting this table when a real export arrives is one line: add the exact
 * header the file carried, with `confirmedOn` set to the date it was seen, and
 * leave the unconfirmed variants where they are until an export contradicts
 * them. Two spellings that both match one file are what fails the read, and
 * that failure names the headers it saw, so the correction can be made from the
 * error alone.
 *
 * GROUP and DESCRIPTION are declared although `TargetFieldContract` has nowhere
 * to carry them. They are declared so that a column carrying one of them cannot
 * be read as something else, and so that the table describes the documented
 * export rather than only the part of it this version uses.
 */
export const HUBSPOT_PROPERTY_EXPORT_HEADERS: readonly HeaderRole<HubSpotPropertyRole>[] = [
  {
    // The name the portal answers to. Nothing else in the export addresses a property.
    role: 'INTERNAL_NAME',
    required: true,
    candidates: [
      { spelling: 'internal name', provenance: 'DOCUMENTED_PROSE', confirmedOn: null },
      { spelling: 'property internal name', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
      { spelling: 'internal value', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
    ],
  },
  {
    role: 'LABEL',
    required: true,
    candidates: [
      { spelling: 'name', provenance: 'DOCUMENTED_PROSE', confirmedOn: null },
      { spelling: 'label', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
      { spelling: 'property name', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
    ],
  },
  {
    // HubSpot's API distinguishes a property's type from its fieldType, and the
    // export is not documented as carrying both. An export that turns out to
    // carry both matches this role twice and fails the read, which is the
    // intended outcome: choosing one of them would be a guess about which token
    // the portal answers to.
    role: 'TYPE',
    required: true,
    candidates: [
      { spelling: 'type', provenance: 'DOCUMENTED_PROSE', confirmedOn: null },
      { spelling: 'property type', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
      { spelling: 'field type', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
    ],
  },
  {
    role: 'GROUP',
    required: false,
    candidates: [
      { spelling: 'group', provenance: 'DOCUMENTED_PROSE', confirmedOn: null },
      { spelling: 'property group', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
      { spelling: 'group name', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
    ],
  },
  {
    role: 'DESCRIPTION',
    required: false,
    candidates: [
      { spelling: 'description', provenance: 'DOCUMENTED_PROSE', confirmedOn: null },
      { spelling: 'property description', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
    ],
  },
  {
    // "its options (if applicable)" in the prose list: present for the
    // properties that have options and absent otherwise.
    role: 'OPTIONS',
    required: false,
    candidates: [
      { spelling: 'options', provenance: 'DOCUMENTED_PROSE', confirmedOn: null },
      { spelling: 'options (if applicable)', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
      { spelling: 'property options', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
    ],
  },
  {
    // Not in the documented prose list, and in the export. It says whether the
    // portal will accept a value for the property, which is the difference
    // between a property a migration can write and one it cannot.
    //
    // Reading it was not optional in practice. Left out, every HubSpot property
    // came out with updateability UNKNOWN, and a match authority refuses a
    // field whose updateability nobody established — so no HubSpot match was
    // satisfiable at all, and the whole of UPSERT and UPDATE_ONLY against
    // HubSpot was unreachable. A real export settled that on 2026-09-01.
    role: 'READ_ONLY_VALUE',
    required: false,
    candidates: [
      { spelling: 'read only value', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' },
      { spelling: 'read-only value', provenance: 'UNCONFIRMED_VARIANT', confirmedOn: null },
    ],
  },
  {
    // Also absent from the prose list and present in the export. A property the
    // portal computes is not one a migration delivers a value to, and matching
    // on one would match on a value the portal is about to overwrite.
    //
    // "Read only definition" is deliberately not a candidate for either role:
    // it says the property's *definition* cannot be edited, which is true of
    // most HubSpot-defined properties whose values are perfectly writable.
    role: 'CALCULATED',
    required: false,
    candidates: [{ spelling: 'calculated', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' }],
  },
];

export const HUBSPOT_PIPELINE_ROLES = [
  'OBJECT',
  'PIPELINE_LABEL',
  'PIPELINE_INTERNAL_NAME',
  'STAGE_LABEL',
  'STAGE_INTERNAL_NAME',
  'DISPLAY_ORDER',
  'STAGE_PROBABILITY_OR_STATE',
  'CAPTURED_AT',
] as const;
export type HubSpotPipelineRole = (typeof HUBSPOT_PIPELINE_ROLES)[number];

/**
 * The pipelines artifact this repository defines.
 *
 * The property export carries no pipeline and no stage, and a deal import needs
 * both by internal identifier. The columns here are canonical because we state
 * them rather than discover them, which is why every one is required: a file
 * missing one of them is not this artifact, and reading it as this artifact
 * would put a stage into a contract on the strength of a column that was never
 * there.
 *
 * Discovery is still case- and whitespace-insensitive, and underscores fold to
 * spaces, so a file written by hand or round-tripped through a spreadsheet is
 * read the same way. The order of the columns carries no meaning.
 */
export const HUBSPOT_PIPELINE_ARTIFACT_HEADERS: readonly HeaderRole<HubSpotPipelineRole>[] = [
  {
    role: 'OBJECT',
    required: true,
    candidates: [{ spelling: 'object', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' }],
  },
  {
    role: 'PIPELINE_LABEL',
    required: true,
    candidates: [{ spelling: 'pipeline label', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' }],
  },
  {
    role: 'PIPELINE_INTERNAL_NAME',
    required: true,
    candidates: [{ spelling: 'pipeline internal name', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' }],
  },
  {
    role: 'STAGE_LABEL',
    required: true,
    candidates: [{ spelling: 'stage label', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' }],
  },
  {
    role: 'STAGE_INTERNAL_NAME',
    required: true,
    candidates: [{ spelling: 'stage internal name', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' }],
  },
  {
    role: 'DISPLAY_ORDER',
    required: true,
    candidates: [{ spelling: 'display order', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' }],
  },
  {
    role: 'STAGE_PROBABILITY_OR_STATE',
    required: true,
    candidates: [{ spelling: 'stage probability or state', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' }],
  },
  {
    role: 'CAPTURED_AT',
    required: true,
    candidates: [{ spelling: 'captured at', provenance: 'KAURO_CANONICAL', confirmedOn: '2026-09-01' }],
  },
];

export type HubSpotDelimiter = ',' | '\t' | ';';

const DELIMITER_CANDIDATES: readonly HubSpotDelimiter[] = [',', '\t', ';'];

const DELIMITER_NAMES: Readonly<Record<HubSpotDelimiter, string>> = {
  ',': 'comma',
  '\t': 'tab',
  ';': 'semicolon',
};

/** Headers named in an error message, capped so a wide file still produces a message a person can read. */
const HEADERS_IN_MESSAGE = 40;

interface HeaderColumn {
  readonly index: number;
  /** The header exactly as the file spelled it. Every error quotes this, never the normalized form. */
  readonly original: string;
  readonly normalized: string;
}

interface TableRow {
  /** The CSV record number, header included, so an error points at a line the operator can find. */
  readonly recordNumber: number;
  readonly cells: readonly string[];
}

interface DelimitedTable<Role extends string> {
  readonly delimiter: HubSpotDelimiter;
  readonly headers: readonly HeaderColumn[];
  readonly rows: readonly TableRow[];
  readonly columnOf: ReadonlyMap<Role, number>;
}

/**
 * Discovery normalization.
 *
 * Case and runs of whitespace are folded because the documentation gives the
 * columns as prose and an export's casing is unknown. Underscores fold to
 * spaces as well, so `pipeline_internal_name` and `Pipeline Internal Name` are
 * one column. Nothing else is folded: a zero-width character or an accented
 * letter in a header is a header this reader does not recognise, and being told
 * so is better than matching it to something it may not be.
 *
 * This form finds a column and never reports one.
 */
function normalizeHeader(header: string): string {
  return header
    .replace(/^\uFEFF/u, '')
    .replace(/[\s_]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function quoteAll(values: readonly string[]): string {
  const shown = values.slice(0, HEADERS_IN_MESSAGE).map((value) => `"${value}"`);
  const remainder = values.length - shown.length;
  return remainder > 0 ? `${shown.join(', ')} and ${String(remainder)} more` : shown.join(', ');
}

function firstLine(text: string): string {
  const end = text.search(/[\r\n]/u);
  const line = end === -1 ? text : text.slice(0, end);
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

/**
 * Refuse bytes that are not delimited text at all.
 *
 * A workbook handed to a text reader decodes into something with a header row
 * shaped like nothing, and the read then fails somewhere less useful than here.
 * The ZIP signature is an .xlsx, the compound-document signature is a legacy
 * .xls, and a NUL means the file was never text in the encoding it was decoded
 * with.
 */
function guardBinary(text: string, filePath: string): void {
  const signatures: readonly { readonly bytes: string; readonly kind: string }[] = [
    { bytes: 'PK\u0003\u0004', kind: 'a ZIP archive, which is what an .xlsx workbook is' },
    { bytes: '\u00D0\u00CF\u0011\u00E0', kind: 'a legacy .xls compound document' },
  ];
  for (const signature of signatures) {
    if (text.startsWith(signature.bytes)) {
      throw new MigrationError(
        'INPUT_UNSUPPORTED',
        `${filePath} begins with the signature of ${signature.kind}, not delimited text`,
        'Export or save the artifact as CSV and hand that file over. This reader does not open workbooks.',
        { filePath },
      );
    }
  }
  const nul = text.indexOf('\u0000');
  if (nul !== -1) {
    throw new MigrationError(
      'INPUT_UNSUPPORTED',
      `${filePath} contains a NUL character at offset ${String(nul)}, so it is not text in the encoding it was read with`,
      'Re-export the artifact as UTF-8 CSV, or decode it with the encoding it was actually written in.',
      { filePath, characterOffset: nul },
    );
  }
}

function spellingSets<Role extends string>(roles: readonly HeaderRole<Role>[]): ReadonlySet<string>[] {
  return roles.map((role) => new Set(role.candidates.map((candidate) => candidate.spelling)));
}

/**
 * How well one delimiter's reading of the header row fits the declared table.
 *
 * `strong` means every required role matched exactly one column and no role
 * matched two: a reading nothing else has to be weighed against. `weak` means
 * the header row split into several columns and at least one of them is a
 * column this reader knows, which is enough to settle the delimiter even though
 * the columns are wrong.
 */
function scoreHeaders(
  headers: readonly HeaderColumn[],
  sets: readonly ReadonlySet<string>[],
  required: readonly boolean[],
): { readonly strong: boolean; readonly weak: boolean } {
  if (headers.length < 2) return { strong: false, weak: false };
  let recognised = false;
  let strong = true;
  sets.forEach((spellings, index) => {
    const count = headers.filter((header) => spellings.has(header.normalized)).length;
    if (count > 0) recognised = true;
    if (count > 1) strong = false;
    if (count === 0 && required[index] === true) strong = false;
  });
  return { strong: strong && recognised, weak: recognised };
}

interface Attempt {
  readonly delimiter: HubSpotDelimiter;
  readonly headers: readonly HeaderColumn[];
  readonly records: readonly CsvRecord[];
}

function headerColumns(record: CsvRecord): HeaderColumn[] {
  return record.fields.map((original, index) => ({ index, original, normalized: normalizeHeader(original) }));
}

/**
 * Read one delimited artifact.
 *
 * The delimiter is detected because the export's format is chosen by whoever
 * ran it and the knowledge base never says what the choices are. Detection is
 * two passes over the same fixed candidate list, and both passes fail closed:
 *
 *   1. The candidates that read the header as a table this reader fully knows.
 *      Exactly one is the answer; two would mean the file reads as two
 *      different tables and neither could be preferred without guessing.
 *   2. If none does, the candidates whose header row is recognisable at all.
 *      This pass exists so that a file whose delimiter is obvious and whose
 *      columns are wrong reports the column that is missing rather than a
 *      delimiter that is not the problem.
 *
 * Reading the text once per candidate is bounded by `maxCharacters`, which is
 * checked first.
 */
function readArtifactTable<Role extends string>(
  text: string,
  filePath: string,
  limits: HubSpotArtifactLimits,
  roles: readonly HeaderRole<Role>[],
  forcedDelimiter: HubSpotDelimiter | null,
): DelimitedTable<Role> {
  guardBinary(text, filePath);
  if (text.length > limits.maxCharacters) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${filePath} holds ${String(text.length)} characters, above the limit of ${String(limits.maxCharacters)}`,
      'Raise maxCharacters if an artifact this large is expected, or split the export.',
      { filePath, limit: 'maxCharacters', allowed: limits.maxCharacters, actual: text.length },
    );
  }

  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (body.trim() === '') {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} carries no header row`,
      'Supply the exported artifact. An empty file states nothing about the portal.',
      { filePath },
    );
  }

  const csvOptions = {
    filePath,
    maxCellLength: limits.maxCellLength,
    maxColumns: limits.maxColumns,
    maxRows: limits.maxRows,
  };
  const sets = spellingSets(roles);
  const required = roles.map((role) => role.required);

  let chosen: Attempt;
  if (forcedDelimiter !== null) {
    // A stated delimiter is a decision, so a failure to read with it is
    // reported as it happened rather than turned into a search.
    const records = readCsv(body, { ...csvOptions, delimiter: forcedDelimiter }).records;
    const first = records[0];
    if (first === undefined) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${filePath} carries no header row`,
        'Supply the exported artifact. An empty file states nothing about the portal.',
        { filePath },
      );
    }
    chosen = { delimiter: forcedDelimiter, headers: headerColumns(first), records };
  } else {
    const scored: { readonly attempt: Attempt; readonly strong: boolean; readonly weak: boolean }[] = [];
    let limitFailure: MigrationError | null = null;
    for (const delimiter of DELIMITER_CANDIDATES) {
      let records: readonly CsvRecord[];
      try {
        records = readCsv(body, { ...csvOptions, delimiter }).records;
      } catch (error) {
        if (error instanceof MigrationError) {
          if (error.code === 'INPUT_LIMIT_EXCEEDED' && limitFailure === null) limitFailure = error;
          continue;
        }
        throw error;
      }
      const first = records[0];
      if (first === undefined) continue;
      const headers = headerColumns(first);
      const score = scoreHeaders(headers, sets, required);
      scored.push({ attempt: { delimiter, headers, records }, strong: score.strong, weak: score.weak });
    }

    const strong = scored.filter((candidate) => candidate.strong);
    const viable = (strong.length > 0 ? strong : scored.filter((candidate) => candidate.weak)).map(
      (candidate) => candidate.attempt,
    );
    if (viable.length > 1) {
      throw new MigrationError(
        'INPUT_UNSUPPORTED',
        `${filePath} reads as a different table with each of ${viable.map((attempt) => DELIMITER_NAMES[attempt.delimiter]).join(' and ')}`,
        'State the delimiter the artifact was exported with, or re-export it with one delimiter.',
        { filePath, delimiters: viable.map((attempt) => DELIMITER_NAMES[attempt.delimiter]) },
      );
    }
    const single = viable[0];
    if (single === undefined) {
      // A limit breach is the real story when one happened: reporting "no
      // delimiter worked" would hide a file that was simply too large.
      if (limitFailure !== null) throw limitFailure;
      throw new MigrationError(
        'INPUT_UNSUPPORTED',
        `${filePath} is not a delimited table this reader knows: none of comma, tab or semicolon produced a header row carrying a column it recognises. First line seen: "${firstLine(body)}"`,
        'Check that the file is the exported artifact, and extend the declared header semantics if the export uses spellings this reader has not seen.',
        { filePath, delimiters: DELIMITER_CANDIDATES.map((delimiter) => DELIMITER_NAMES[delimiter]) },
      );
    }
    chosen = single;
  }

  const columnOf = resolveRoles(chosen.headers, roles, sets, filePath);

  const rows: TableRow[] = [];
  for (const record of chosen.records.slice(1)) {
    if (record.fields.length !== chosen.headers.length) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${filePath} record ${String(record.recordNumber)} has ${String(record.fields.length)} fields where the header row has ${String(chosen.headers.length)}`,
        'A row whose cells do not line up with the header cannot be read by header. Repair or re-export the artifact; a blank line is not a row.',
        {
          filePath,
          recordNumber: record.recordNumber,
          expected: chosen.headers.length,
          actual: record.fields.length,
        },
      );
    }
    rows.push({ recordNumber: record.recordNumber, cells: [...record.fields] });
  }

  return { delimiter: chosen.delimiter, headers: chosen.headers, rows, columnOf };
}

/**
 * Bind each declared role to one column.
 *
 * Two columns matching one role fails whether or not the role is required: it
 * means the declared table does not describe this file, and reading either
 * column would be a choice nobody made. A required role matching none fails for
 * the plainer reason that the authority is absent. Both messages name the
 * headers the file actually carried, because extending the table is the fix and
 * the fix has to be possible from the error alone.
 */
function resolveRoles<Role extends string>(
  headers: readonly HeaderColumn[],
  roles: readonly HeaderRole<Role>[],
  sets: readonly ReadonlySet<string>[],
  filePath: string,
): ReadonlyMap<Role, number> {
  const seen = headers.map((header) => header.original);
  const columnOf = new Map<Role, number>();
  roles.forEach((role, index) => {
    const spellings = sets[index] ?? new Set<string>();
    const matched = headers.filter((header) => spellings.has(header.normalized));
    if (matched.length > 1) {
      throw new MigrationError(
        'INPUT_UNSUPPORTED',
        `${filePath} has ${String(matched.length)} columns that all read as ${role.role} (${quoteAll(matched.map((header) => header.original))}); columns seen: ${quoteAll(seen)}`,
        'Remove or rename the duplicate column, or narrow the declared header semantics so exactly one spelling matches this export.',
        {
          filePath,
          role: role.role,
          matchedHeaders: matched.map((header) => header.original),
          headersSeen: [...seen],
        },
      );
    }
    const only = matched[0];
    if (only === undefined) {
      if (!role.required) return;
      throw new MigrationError(
        'INPUT_UNSUPPORTED',
        `${filePath} carries no column for ${role.role}; the spellings this reader accepts are ${quoteAll(role.candidates.map((candidate) => candidate.spelling))}, and the columns seen are ${quoteAll(seen)}`,
        'Add the exported spelling to the declared header semantics for this role, or supply the artifact that carries the column.',
        {
          filePath,
          role: role.role,
          candidates: role.candidates.map((candidate) => candidate.spelling),
          headersSeen: [...seen],
        },
      );
    }
    columnOf.set(role.role, only.index);
  });
  return columnOf;
}

/**
 * A boolean column of the export, read as a tri-state.
 *
 * The export writes "true" and "false". A cell that says anything else — an
 * empty cell where the column is absent, a spelling a later export introduces —
 * is not a third boolean, it is the absence of a statement, and it comes out as
 * UNKNOWN so that nothing downstream is authorized by a cell nobody understood.
 */
function booleanFlag(cell: string): TargetFlag {
  const normalized = cell.trim().toLowerCase();
  if (normalized === 'true') return 'TRUE';
  if (normalized === 'false') return 'FALSE';
  return 'UNKNOWN';
}

/**
 * Writability, derived from the two facts that establish it.
 *
 * One function, called by both readers of a HubSpot portal. That is the whole
 * reason it exists as a function rather than as two expressions: the property
 * export and the properties API describe one portal, `buildHubSpotTargetContract`
 * refuses a contract where they disagree, and two derivations of writability
 * that drifted apart would turn every calculated-but-writable property into a
 * refused build. Sharing the derivation makes the disagreement impossible rather
 * than merely unlikely.
 *
 * A property the portal reports read-only is not one an import writes. Nor is
 * one the portal computes: a value the portal is about to overwrite is not a
 * value a migration delivers, and matching on one would match on a number that
 * is about to change. Either fact being TRUE settles it as FALSE.
 *
 * Order matters below. Calculated is checked before a FALSE read-only value is
 * read as writable, so a property that is computed but not marked read-only
 * still comes out not writable. On the 2026-09-04 capture of portal 51872453 no
 * such property exists — all 38 calculated contact properties, all 6 company and
 * all 36 deal ones are also readOnlyValue — so the order is a decision about a
 * case that portal does not currently present rather than one it does.
 *
 * Anything neither fact settles stays UNKNOWN. UNKNOWN is not FALSE and it is
 * not TRUE: the match authority refuses a field whose updateability nobody
 * established, which is the fail-closed answer, and reading silence as writable
 * would authorise writing to a property the portal will refuse.
 */
function writableFrom(readOnlyValue: TargetFlag, calculated: TargetFlag): TargetFlag {
  if (readOnlyValue === 'TRUE') return 'FALSE';
  if (calculated === 'TRUE') return 'FALSE';
  if (readOnlyValue === 'FALSE') return 'TRUE';
  return 'UNKNOWN';
}

function roleCell<Role extends string>(table: DelimitedTable<Role>, role: Role, row: TableRow): string {
  const index = table.columnOf.get(role);
  if (index === undefined) return '';
  return row.cells[index] ?? '';
}

function roleHeader<Role extends string>(table: DelimitedTable<Role>, role: Role): string {
  const index = table.columnOf.get(role);
  if (index === undefined) return role;
  return table.headers[index]?.original ?? role;
}

function requireCell(value: string, header: string, filePath: string, recordNumber: number): string {
  if (value.trim() === '') {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} record ${String(recordNumber)} has no value in "${header}"`,
      'Every row of this artifact must carry that column. Repair or re-export it rather than leaving the cell empty.',
      { filePath, recordNumber, header },
    );
  }
  return value;
}

/**
 * A value that addresses something has to be exactly what it addresses with.
 *
 * An internal name carrying a leading or trailing space is either the portal's
 * name plus an export artifact or a name with a space in it, and nothing in the
 * file says which. Trimming would assert the first reading and keeping it would
 * assert the second, so the read fails instead.
 */
function requireAddressable(value: string, header: string, filePath: string, recordNumber: number): string {
  const present = requireCell(value, header, filePath, recordNumber);
  if (present !== present.trim()) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} record ${String(recordNumber)} has "${header}" surrounded by whitespace ("${present}")`,
      'Remove the surrounding whitespace in the artifact. This value addresses a property, a pipeline or a stage, and trimming it here would guess at the name the portal answers to.',
      { filePath, recordNumber, header, value: present },
    );
  }
  return present;
}

export interface HubSpotPropertyExportOptions {
  /** The object the file describes. The export is one file per object and names the object in the file nowhere. */
  readonly objectApiName: string;
  readonly objectLabel: string;
  /** Used in every error. It is a name for the bytes, never a path anything opens. */
  readonly filePath: string;
  /** Stated when the format is known. Omitted, the delimiter is detected. */
  readonly delimiter?: HubSpotDelimiter;
  readonly limits?: HubSpotArtifactLimits;
}

/**
 * Read one object's property export into an object contract.
 *
 * Every field comes out with evidence `ARTIFACT`: the portal exported it. What
 * the portal did not export comes out as UNKNOWN, and that list is longer than
 * the list of what it did.
 */
export function parseHubSpotPropertyExport(
  text: string,
  options: HubSpotPropertyExportOptions,
): TargetObjectContract {
  const limits = options.limits ?? DEFAULT_HUBSPOT_ARTIFACT_LIMITS;
  const objectApiName = options.objectApiName;
  if (objectApiName.trim() === '' || objectApiName !== objectApiName.trim()) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the object name for ${options.filePath} is "${objectApiName}", which is empty or carries surrounding whitespace`,
      'State the object the export describes, exactly as the rest of the capture spells it.',
      { filePath: options.filePath, objectApiName },
    );
  }
  if (options.objectLabel.trim() === '') {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the object label for ${options.filePath} is empty`,
      'State the label a person would recognise the object by.',
      { filePath: options.filePath, objectApiName },
    );
  }

  const table = readArtifactTable(
    text,
    options.filePath,
    limits,
    HUBSPOT_PROPERTY_EXPORT_HEADERS,
    options.delimiter ?? null,
  );

  const fields: TargetFieldContract[] = [];
  const seenAt = new Map<string, number>();
  for (const row of table.rows) {
    const apiName = requireAddressable(
      roleCell(table, 'INTERNAL_NAME', row),
      roleHeader(table, 'INTERNAL_NAME'),
      options.filePath,
      row.recordNumber,
    );
    const previous = seenAt.get(apiName);
    if (previous !== undefined) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${options.filePath} declares the property "${apiName}" twice, at records ${String(previous)} and ${String(row.recordNumber)}`,
        'Remove the duplicate row. Two rows for one internal name make every lookup of that property ambiguous.',
        {
          filePath: options.filePath,
          apiName,
          firstRecordNumber: previous,
          secondRecordNumber: row.recordNumber,
        },
      );
    }
    seenAt.set(apiName, row.recordNumber);

    fields.push({
      apiName,
      label: requireCell(
        roleCell(table, 'LABEL', row),
        roleHeader(table, 'LABEL'),
        options.filePath,
        row.recordNumber,
      ),
      // The portal's own token, recorded exactly as exported. Mapping it onto a
      // type of ours here would put this parser's opinion into the contract.
      type: requireCell(
        roleCell(table, 'TYPE', row),
        roleHeader(table, 'TYPE'),
        options.filePath,
        row.recordNumber,
      ),
      // A property whose value the portal reports read-only is one no import
      // writes, and so is one it reports computed. Anything else the columns
      // might say is neither, and stays UNKNOWN rather than being rounded to
      // whichever answer is convenient. The derivation lives in one function
      // that the properties-API reader calls as well, so the two readings of one
      // portal cannot drift apart.
      createable: writableFrom(
        booleanFlag(roleCell(table, 'READ_ONLY_VALUE', row)),
        booleanFlag(roleCell(table, 'CALCULATED', row)),
      ),
      updateable: writableFrom(
        booleanFlag(roleCell(table, 'READ_ONLY_VALUE', row)),
        booleanFlag(roleCell(table, 'CALCULATED', row)),
      ),
      nillable: 'UNKNOWN',
      length: null,
      precision: null,
      scale: null,
      // The export does not carry hasUniqueValue. `unique` is therefore UNKNOWN
      // and never FALSE: uniqueness is what decides whether a property may be a
      // match key, so reading the artifact's silence as "not unique" would
      // disqualify the one property a migration was going to match on, and
      // reading it as "unique" would authorise matching on a property that
      // accepts duplicates. Only a supplement can settle it.
      unique: 'UNKNOWN',
      // Separate facts, and separate for their own reason: HubSpot documents no
      // equivalent of Salesforce's External ID or of idLookup, so neither this
      // artifact nor the supplement below can ever establish them.
      externalId: 'UNKNOWN',
      idLookup: 'UNKNOWN',
      calculated: booleanFlag(roleCell(table, 'CALCULATED', row)),
      autoNumber: 'UNKNOWN',
      defaultedOnCreate: 'UNKNOWN',
      // Whether the portal refuses a value outside the option list is not in
      // the export, which is why the options below are not a closed list.
      restrictedPicklist: 'UNKNOWN',
      picklistValues: parseOptionsCell(
        roleCell(table, 'OPTIONS', row),
        limits,
        options.filePath,
        row.recordNumber,
      ),
      referenceTo: [],
      relationshipName: null,
      evidence: 'ARTIFACT',
    });
  }

  if (fields.length === 0) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${options.filePath} carries a header row and no properties`,
      'Supply the full export. An object with no properties is a truncated file rather than a portal with nothing in it.',
      { filePath: options.filePath, objectApiName },
    );
  }

  return {
    apiName: objectApiName,
    label: options.objectLabel,
    // Whether the object accepts creates or updates is account state the
    // property export says nothing about.
    createable: 'UNKNOWN',
    updateable: 'UNKNOWN',
    fields,
    // HubSpot has no record types. The empty list is the fact, not a gap.
    recordTypes: [],
  };
}

/**
 * Options as the export carries them.
 *
 * Settled against a real export, not against documentation. HubSpot documents
 * neither the separator nor the shape of a token, so this reader was written to
 * record the token as both label and value and say plainly that it could not
 * tell them apart. An "Export all properties" taken from a real portal on
 * 2026-09-01 shows it can:
 *
 *     Organic Search (ORGANIC_SEARCH); Paid Search (PAID_SEARCH)
 *     Active (active) [READ-ONLY]; Inactive (inactive) [READ-ONLY]
 *     True (true); False (false)
 *     Forms (1); Emails (2)
 *
 * Options are separated by a semicolon, and each is the option's label followed
 * by its internal value in parentheses. Recording the whole token as the value
 * was materially wrong: `"Organic Search (ORGANIC_SEARCH)"` is not a value the
 * portal accepts, so a plan checked against that contract would have been
 * checked against a value set that does not exist.
 *
 * The internal value is taken from the LAST parenthesised group, because a
 * label may itself contain parentheses and the value never follows anything. A
 * token with no parentheses is recorded as label and value alike — that is the
 * old reading, kept for the case the new one does not cover.
 *
 * The trailing `[READ-ONLY]` marker some options carry is stripped from the
 * label. It qualifies the option rather than naming it, and leaving it in would
 * put it inside a label nothing answers to.
 *
 * Two things this still cannot establish, and what is recorded instead:
 *
 *   - Whether an option is selectable. `active` is true because the export
 *     listed it and carries no archived-option column.
 *   - Which option is the default. `defaultValue` is false on every option,
 *     which reads as "this artifact names no default" rather than as a claim
 *     about any one of them.
 *
 * The order is the order of the cell, preserved because reordering would
 * discard the only ordering the artifact states and add one of ours.
 */
function parseOptionsCell(
  cell: string,
  limits: HubSpotArtifactLimits,
  filePath: string,
  recordNumber: number,
): readonly TargetPicklistValue[] {
  if (cell.trim() === '') return [];
  const tokens = cell
    .split(';')
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (tokens.length > limits.maxPicklistOptions) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${filePath} record ${String(recordNumber)} lists ${String(tokens.length)} options, above the limit of ${String(limits.maxPicklistOptions)}`,
      'Raise maxPicklistOptions if a list this long is expected, or check that the cell is an option list at all.',
      {
        filePath,
        recordNumber,
        limit: 'maxPicklistOptions',
        allowed: limits.maxPicklistOptions,
        actual: tokens.length,
      },
    );
  }
  return tokens.map((token) => splitOption(token));
}

/** `[READ-ONLY]`, and any similar bracketed qualifier, sits after the value rather than inside it. */
const OPTION_QUALIFIER = /\s*\[[^\]]*\]\s*$/u;

/** `Label (INTERNAL_VALUE)`, taking the last parenthesised group so a label may contain its own. */
const OPTION_VALUE = /^(.*)\(([^()]*)\)$/su;

function splitOption(token: string): TargetPicklistValue {
  const withoutQualifier = token.replace(OPTION_QUALIFIER, '').trim();
  const matched = OPTION_VALUE.exec(withoutQualifier);
  if (matched === null) {
    return { value: withoutQualifier, label: withoutQualifier, active: true, defaultValue: false };
  }
  const label = (matched[1] ?? '').trim();
  const value = (matched[2] ?? '').trim();
  // An empty half means the shape was not really `Label (VALUE)`. Reading it as
  // one would name the option with an empty string, so the token stands as it is.
  if (label === '' || value === '') {
    return { value: withoutQualifier, label: withoutQualifier, active: true, defaultValue: false };
  }
  return { value, label, active: true, defaultValue: false };
}

/** The pipelines artifact, with the capture time it states. */
export interface HubSpotPipelineArtifact {
  readonly pipelines: readonly TargetPipeline[];
  /** Every row states it and every row has to agree, so one artifact is one capture. */
  readonly capturedAt: string;
}

export interface HubSpotPipelineArtifactOptions {
  readonly filePath?: string;
  readonly delimiter?: HubSpotDelimiter;
  readonly limits?: HubSpotArtifactLimits;
}

interface PipelineDraft {
  readonly objectApiName: string;
  readonly pipelineLabel: string;
  readonly pipelineInternalName: string;
  readonly recordNumber: number;
  readonly stages: TargetPipelineStage[];
}

/** Two names of one thing are joined by a character no name can contain, so no pair can render as another pair. */
const KEY_SEPARATOR = '\u0000';

/**
 * Read the pipelines artifact.
 *
 * A row with no stage declares a pipeline; a row with a stage names the
 * pipeline it belongs to. Declaration is explicit so that a stage naming a
 * pipeline nobody declared is a contradiction this read catches, rather than a
 * pipeline the reader invents out of the reference to it.
 *
 * Two of the artifact's columns reach no further than this function.
 * `stage_probability_or_state` is required and read but not carried, because
 * `TargetPipelineStage` has nowhere to put it and the contract file is
 * finished. `captured_at` comes out as one value for the whole artifact rather
 * than one per stage.
 */
export function parseHubSpotPipelineArtifact(
  text: string,
  options: HubSpotPipelineArtifactOptions = {},
): HubSpotPipelineArtifact {
  const filePath = options.filePath ?? 'hubspot-pipelines.csv';
  const limits = options.limits ?? DEFAULT_HUBSPOT_ARTIFACT_LIMITS;
  const table = readArtifactTable(
    text,
    filePath,
    limits,
    HUBSPOT_PIPELINE_ARTIFACT_HEADERS,
    options.delimiter ?? null,
  );

  if (table.rows.length === 0) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} declares no pipeline`,
      'Supply the captured artifact. An empty one reads as "this portal has no pipelines", and no deal could then be loaded into any of them.',
      { filePath },
    );
  }

  let capturedAt: string | null = null;
  const drafts: PipelineDraft[] = [];
  const draftByKey = new Map<string, PipelineDraft>();
  const stageRows: { readonly row: TableRow; readonly key: string }[] = [];

  for (const row of table.rows) {
    const objectApiName = requireAddressable(
      roleCell(table, 'OBJECT', row),
      roleHeader(table, 'OBJECT'),
      filePath,
      row.recordNumber,
    );
    const pipelineInternalName = requireAddressable(
      roleCell(table, 'PIPELINE_INTERNAL_NAME', row),
      roleHeader(table, 'PIPELINE_INTERNAL_NAME'),
      filePath,
      row.recordNumber,
    );
    const pipelineLabel = requireCell(
      roleCell(table, 'PIPELINE_LABEL', row),
      roleHeader(table, 'PIPELINE_LABEL'),
      filePath,
      row.recordNumber,
    );

    const rowCapturedAt = requireCell(
      roleCell(table, 'CAPTURED_AT', row),
      roleHeader(table, 'CAPTURED_AT'),
      filePath,
      row.recordNumber,
    );
    if (!isUtcTimestamp(rowCapturedAt)) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${filePath} record ${String(row.recordNumber)} states the capture time "${rowCapturedAt}", which is not a UTC timestamp of the form YYYY-MM-DDTHH:MM:SSZ`,
        'Write the capture time in UTC, to the second, ending in Z. The engine holds no time zone database, so an offset it would have to convert is refused.',
        { filePath, recordNumber: row.recordNumber, capturedAt: rowCapturedAt },
      );
    }
    if (capturedAt === null) capturedAt = rowCapturedAt;
    else if (capturedAt !== rowCapturedAt) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${filePath} record ${String(row.recordNumber)} was captured at ${rowCapturedAt} where earlier rows state ${capturedAt}`,
        'One artifact is one capture. Split the rows into the captures they came from rather than stitching two into one file.',
        { filePath, recordNumber: row.recordNumber, capturedAt, rowCapturedAt },
      );
    }

    const key = `${objectApiName}${KEY_SEPARATOR}${pipelineInternalName}`;
    const stageInternalName = roleCell(table, 'STAGE_INTERNAL_NAME', row);
    const stageLabel = roleCell(table, 'STAGE_LABEL', row);

    if (stageInternalName.trim() === '') {
      if (stageLabel.trim() !== '') {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${filePath} record ${String(row.recordNumber)} names the stage "${stageLabel}" with no internal name`,
          'Capture the stage internal identifier. A deal import addresses a stage by its internal name, and a label cannot stand in for it.',
          { filePath, recordNumber: row.recordNumber, stageLabel },
        );
      }
      const existing = draftByKey.get(key);
      if (existing !== undefined) {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${filePath} declares the pipeline "${pipelineInternalName}" for ${objectApiName} twice, at records ${String(existing.recordNumber)} and ${String(row.recordNumber)}`,
          'Remove the duplicate declaration. Two rows for one internal name make every lookup of that pipeline ambiguous.',
          {
            filePath,
            objectApiName,
            pipelineInternalName,
            firstRecordNumber: existing.recordNumber,
            secondRecordNumber: row.recordNumber,
          },
        );
      }
      const draft: PipelineDraft = {
        objectApiName,
        pipelineLabel,
        pipelineInternalName,
        recordNumber: row.recordNumber,
        stages: [],
      };
      drafts.push(draft);
      draftByKey.set(key, draft);
      continue;
    }

    stageRows.push({ row, key });
  }

  // Stages are attached in a second pass so a declaration may sit anywhere in
  // the file. Row order is not authority over which pipelines exist.
  for (const stageRow of stageRows) {
    const row = stageRow.row;
    const objectApiName = roleCell(table, 'OBJECT', row).trim();
    const pipelineInternalName = roleCell(table, 'PIPELINE_INTERNAL_NAME', row).trim();
    const draft = draftByKey.get(stageRow.key);
    if (draft === undefined) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${filePath} record ${String(row.recordNumber)} places a stage in the pipeline "${pipelineInternalName}" of ${objectApiName}, which the artifact never declares`,
        'Add the pipeline declaration row, or correct the pipeline internal name on the stage row. A stage whose pipeline is not in the capture would put a pipeline nobody established into the contract.',
        { filePath, recordNumber: row.recordNumber, objectApiName, pipelineInternalName },
      );
    }
    const pipelineLabel = roleCell(table, 'PIPELINE_LABEL', row);
    if (pipelineLabel !== draft.pipelineLabel) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${filePath} record ${String(row.recordNumber)} labels the pipeline "${pipelineInternalName}" as "${pipelineLabel}" where its declaration at record ${String(draft.recordNumber)} labels it "${draft.pipelineLabel}"`,
        'Give one pipeline one label. Two labels for one internal name is a capture contradicting itself.',
        {
          filePath,
          recordNumber: row.recordNumber,
          pipelineInternalName,
          declaredLabel: draft.pipelineLabel,
          rowLabel: pipelineLabel,
        },
      );
    }
    draft.stages.push({
      stageLabel: requireCell(
        roleCell(table, 'STAGE_LABEL', row),
        roleHeader(table, 'STAGE_LABEL'),
        filePath,
        row.recordNumber,
      ),
      stageInternalName: requireAddressable(
        roleCell(table, 'STAGE_INTERNAL_NAME', row),
        roleHeader(table, 'STAGE_INTERNAL_NAME'),
        filePath,
        row.recordNumber,
      ),
      displayOrder: parseDisplayOrder(
        roleCell(table, 'DISPLAY_ORDER', row),
        roleHeader(table, 'DISPLAY_ORDER'),
        filePath,
        row.recordNumber,
      ),
    });
  }

  invariant(
    capturedAt !== null,
    'HUBSPOT_PIPELINE_CAPTURE',
    `${filePath} produced rows without a capture time, which the row loop should have refused`,
    { filePath },
  );

  assertPipelinesAddressable(drafts, filePath);

  return {
    pipelines: drafts.map((draft) => ({
      objectApiName: draft.objectApiName,
      pipelineLabel: draft.pipelineLabel,
      pipelineInternalName: draft.pipelineInternalName,
      // The artifact's own row order is kept. Sorting by display order would
      // reorder the stages that state none, and the display order each stage
      // does state is carried on the stage.
      stages: [...draft.stages],
    })),
    capturedAt,
  };
}

/** The pipelines alone, for a caller that has the capture time from elsewhere. */
export function parseHubSpotPipelines(text: string): readonly TargetPipeline[] {
  return parseHubSpotPipelineArtifact(text).pipelines;
}

/**
 * A name has to address exactly one thing.
 *
 * `findPipeline` matches a pipeline by label or by internal name, and
 * `findStage` matches a stage the same way, so it is the union of the two that
 * has to be distinct rather than each of them separately. A pipeline whose
 * label is another pipeline's internal name would make a lookup return whichever
 * came first in the array, which is a coin toss dressed as a contract.
 */
function assertPipelinesAddressable(drafts: readonly PipelineDraft[], filePath: string): void {
  const namesByObject = new Map<string, Map<string, number>>();
  for (const draft of drafts) {
    let names = namesByObject.get(draft.objectApiName);
    if (names === undefined) {
      names = new Map<string, number>();
      namesByObject.set(draft.objectApiName, names);
    }
    for (const name of [draft.pipelineInternalName, draft.pipelineLabel]) {
      const previous = names.get(name);
      if (previous !== undefined && previous !== draft.recordNumber) {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${filePath} uses the name "${name}" for more than one pipeline of ${draft.objectApiName}, at records ${String(previous)} and ${String(draft.recordNumber)}`,
          'Give every pipeline of one object a label and an internal name no other pipeline of that object uses, in either position. A pipeline is looked up by either.',
          {
            filePath,
            objectApiName: draft.objectApiName,
            name,
            firstRecordNumber: previous,
            secondRecordNumber: draft.recordNumber,
          },
        );
      }
      names.set(name, draft.recordNumber);
    }

    const stageNames = new Set<string>();
    for (const stage of draft.stages) {
      for (const name of [stage.stageInternalName, stage.stageLabel]) {
        if (stageNames.has(name)) {
          throw new MigrationError(
            'INPUT_CORRUPT',
            `${filePath} uses the name "${name}" for more than one stage of the pipeline "${draft.pipelineInternalName}"`,
            'Give every stage of one pipeline a label and an internal name no other stage of that pipeline uses, in either position. A stage is looked up by either.',
            { filePath, pipelineInternalName: draft.pipelineInternalName, name },
          );
        }
        stageNames.add(name);
      }
    }
  }
}

/** Display order is an integer or nothing. Anything else is refused, because a misread order silently reorders a pipeline. */
function parseDisplayOrder(cell: string, header: string, filePath: string, recordNumber: number): number | null {
  const value = cell.trim();
  if (value === '') return null;
  const parsed = Number(value);
  if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(parsed)) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} record ${String(recordNumber)} has "${header}" set to "${cell}", which is not an integer this reader can carry exactly`,
      'Write the display order as digits, with an optional leading minus, or leave the cell empty.',
      { filePath, recordNumber, header, value: cell },
    );
  }
  return parsed;
}

/**
 * A capture time is UTC and is checked against the calendar.
 *
 * The engine holds no time zone database, so an offset other than Z would be a
 * value nothing here could compare against another. The round trip through the
 * calendar is what catches a date like 2026-02-30, which the pattern alone
 * accepts.
 */
function isUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return `${parsed.toISOString().slice(0, 19)}Z` === value;
}

export const HUBSPOT_SUPPLEMENT_KIND = 'HUBSPOT_TARGET_SUPPLEMENT';
export const HUBSPOT_SUPPLEMENT_VERSION = '1';

/** One property the agency states requires, or does not require, unique values. */
export interface HubSpotUniqueStatement {
  readonly objectApiName: string;
  readonly internalName: string;
  /**
   * UNKNOWN is not offered. Stating "nobody knows" is not a statement, and a
   * supplement exists only to say something the export could not.
   */
  readonly unique: 'TRUE' | 'FALSE';
}

/**
 * What the agency states because no export carries it.
 *
 * Two facts, and both of them matter for the same reason. The portal id names
 * the instance the contract speaks for, and nothing in a property export
 * identifies the portal at all. Uniqueness decides which properties may be
 * match keys, and the export does not carry it.
 *
 * `statedBy` is required because a statement with no author is not evidence,
 * and everything derived from this file is recorded as SUPPLEMENT rather than
 * ARTIFACT so the weaker evidence stays visible in the contract.
 */
export interface HubSpotSupplement {
  readonly portalId: string;
  readonly portalName: string;
  readonly capturedAt: string;
  readonly statedBy: string;
  readonly uniqueProperties: readonly HubSpotUniqueStatement[];
}

/** Closed: an unknown key is refused rather than ignored, so a misspelled statement cannot read as no statement. */
export const HUBSPOT_SUPPLEMENT_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['artifactKind', 'supplementVersion', 'portalId', 'portalName', 'capturedAt', 'statedBy', 'uniqueProperties'],
  properties: {
    artifactKind: {
      type: 'string',
      enum: [HUBSPOT_SUPPLEMENT_KIND],
      description: 'Names the document, so a supplement for another target cannot be read as this one.',
    },
    supplementVersion: {
      type: 'string',
      enum: [HUBSPOT_SUPPLEMENT_VERSION],
      description: 'The shape this reader understands. A later shape is refused rather than partly read.',
    },
    portalId: {
      type: 'string',
      pattern: '^[0-9]{1,20}$',
      description: 'The HubSpot portal id, as digits.',
    },
    portalName: {
      type: 'string',
      minLength: 1,
      description: 'The account name a person would recognise. Evidence, never the key.',
    },
    capturedAt: {
      type: 'string',
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$',
      description: 'When the agency exported the artifacts, in UTC, as they stated it.',
    },
    statedBy: {
      type: 'string',
      minLength: 1,
      description: 'Who made these statements. A statement with no author is not evidence.',
    },
    uniqueProperties: {
      type: 'array',
      description: 'The properties the agency states require, or do not require, unique values.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['objectApiName', 'internalName', 'unique'],
        properties: {
          objectApiName: { type: 'string', minLength: 1 },
          internalName: { type: 'string', minLength: 1 },
          unique: { type: 'string', enum: ['TRUE', 'FALSE'] },
        },
      },
    },
  },
};

function schemaString(object: JsonObject, key: string, origin: string): string {
  const value = object[key];
  invariant(
    typeof value === 'string',
    'HUBSPOT_SUPPLEMENT_SHAPE',
    `${origin} passed the closed schema with a non-string "${key}"`,
    { origin, key },
  );
  return value;
}

/**
 * Read the supplement.
 *
 * A malformed supplement is reported as a configuration failure rather than a
 * corrupt input: it is a document somebody wrote, not bytes a system exported,
 * and the fix is to correct the pointer the message names.
 */
export function parseHubSpotSupplement(text: string, origin = 'hubspot-supplement.json'): HubSpotSupplement {
  if (text.length > DEFAULT_HUBSPOT_ARTIFACT_LIMITS.maxCharacters) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${origin} holds ${String(text.length)} characters, above the limit of ${String(DEFAULT_HUBSPOT_ARTIFACT_LIMITS.maxCharacters)}`,
      'A supplement is a short statement of what the export could not carry. Check that this is the right file.',
      {
        origin,
        limit: 'maxCharacters',
        allowed: DEFAULT_HUBSPOT_ARTIFACT_LIMITS.maxCharacters,
        actual: text.length,
      },
    );
  }

  let parsed: JsonValue;
  try {
    parsed = parseJson(text);
  } catch (error) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} is not well-formed JSON: ${error instanceof Error ? error.message : String(error)}`,
      'Correct the file. Nothing is read from a document that does not parse.',
      { origin },
    );
  }

  const violations = validateAgainstSchema(parsed, HUBSPOT_SUPPLEMENT_SCHEMA);
  if (violations.length > 0) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} does not match the HubSpot supplement schema`,
      'Correct each listed pointer. The schema is closed, so an unknown key is rejected rather than ignored.',
      {
        origin,
        violations: violations.map((violation) => ({
          pointer: violation.pointer === '' ? '/' : violation.pointer,
          message: violation.message,
        })),
      },
    );
  }

  const raw = parsed as JsonObject;
  const capturedAt = schemaString(raw, 'capturedAt', origin);
  if (!isUtcTimestamp(capturedAt)) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} states the capture time "${capturedAt}", which is not a date on the calendar`,
      'Write the capture time in UTC, to the second, ending in Z.',
      { origin, capturedAt },
    );
  }

  const statementsRaw = raw['uniqueProperties'];
  invariant(
    Array.isArray(statementsRaw),
    'HUBSPOT_SUPPLEMENT_SHAPE',
    `${origin} passed the closed schema without a uniqueProperties array`,
    { origin },
  );

  const uniqueProperties: HubSpotUniqueStatement[] = [];
  const claimedAt = new Map<string, number>();
  statementsRaw.forEach((item, index) => {
    const entry = item as JsonObject;
    const objectApiName = schemaString(entry, 'objectApiName', origin);
    const internalName = schemaString(entry, 'internalName', origin);
    const unique = schemaString(entry, 'unique', origin);
    invariant(
      unique === 'TRUE' || unique === 'FALSE',
      'HUBSPOT_SUPPLEMENT_SHAPE',
      `${origin} passed the closed schema with a unique flag of "${unique}"`,
      { origin, unique },
    );
    for (const [key, value] of [
      ['objectApiName', objectApiName],
      ['internalName', internalName],
    ] as const) {
      if (value !== value.trim()) {
        throw new MigrationError(
          'CONFIG_INVALID',
          `${origin} states ${key} as "${value}", which carries surrounding whitespace`,
          'Write the name exactly as the export spells it. This value addresses a property, and trimming it here would guess at the name the portal answers to.',
          { origin, pointer: `/uniqueProperties/${String(index)}/${key}`, value },
        );
      }
      // A control character in a name is what would let two different pairs of
      // names render as one key below, and no property this reader can match
      // against an export carries one: the artifact readers refuse a NUL
      // outright.
      if (/[\u0000-\u001F]/u.test(value)) {
        throw new MigrationError(
          'CONFIG_INVALID',
          `${origin} states ${key} with a control character in it`,
          'Write the name exactly as the export spells it, in printable characters.',
          { origin, pointer: `/uniqueProperties/${String(index)}/${key}` },
        );
      }
    }
    const key = `${objectApiName}${KEY_SEPARATOR}${internalName}`;
    const previous = claimedAt.get(key);
    if (previous !== undefined) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `${origin} states the uniqueness of ${objectApiName}.${internalName} twice, at entries ${String(previous)} and ${String(index)}`,
        'State each property once. Two statements about one property leave the reader choosing between them.',
        { origin, objectApiName, internalName, first: previous, second: index },
      );
    }
    claimedAt.set(key, index);
    uniqueProperties.push({ objectApiName, internalName, unique });
  });

  return {
    portalId: schemaString(raw, 'portalId', origin),
    portalName: schemaString(raw, 'portalName', origin),
    capturedAt,
    statedBy: schemaString(raw, 'statedBy', origin),
    uniqueProperties,
  };
}

// ---------------------------------------------------------------- access grant
//
// Whether a HubSpot object accepts creates and updates is not in any property
// artifact: the export and the properties response describe properties, and the
// object flags came out of both readers as UNKNOWN. That was honest, and under
// the MC-04 rule — UNKNOWN never authorises — it made every HubSpot CREATE,
// UPDATE and UPSERT run refuse at destination validation with "recapture the
// target schema", which no recapture of properties could ever satisfy. The
// vendor gate found it on the first run after the repair.
//
// The instance fact exists, and the portal states it: the scopes it granted the
// integration that captured the artifacts and will write the records. HubSpot
// answers `POST /oauth/v2/private-apps/get/access-token-info` with the portal,
// the app and the granted scopes; `crm.objects.contacts.write` is the portal's
// own statement that this integration may create and update contacts here. The
// collector writes that answer down as an artifact — minus the token, which is
// the question and never part of the answer — and the contract reads it back
// like every other artifact: hashed, named, and about the same portal.
//
// Without a grant the flags stay UNKNOWN and the run refuses, as before. A grant
// about another portal is refused. A grant that lacks the write scope makes the
// flag FALSE, which is the refusal the import would have met at the API.

export const HUBSPOT_ACCESS_GRANT_KIND = 'HUBSPOT_ACCESS_GRANT';
export const HUBSPOT_ACCESS_GRANT_VERSION = '1';
export const HUBSPOT_ACCESS_GRANT_ENDPOINT = 'POST /oauth/v2/private-apps/get/access-token-info';

export interface HubSpotAccessGrant {
  readonly portalId: string;
  readonly appId: string;
  readonly capturedAt: string;
  readonly statedBy: string;
  /** Sorted, de-duplicated, exactly as the portal spelled them. */
  readonly scopes: readonly string[];
}

/** Closed, like the supplement: a misspelled key is refused rather than read as absent. */
export const HUBSPOT_ACCESS_GRANT_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['artifactKind', 'accessGrantVersion', 'portalId', 'appId', 'capturedAt', 'statedBy', 'scopes'],
  properties: {
    artifactKind: {
      type: 'string',
      enum: [HUBSPOT_ACCESS_GRANT_KIND],
      description: 'Names the document, so a grant for another target cannot be read as this one.',
    },
    accessGrantVersion: {
      type: 'string',
      enum: [HUBSPOT_ACCESS_GRANT_VERSION],
      description: 'The shape this reader understands. A later shape is refused rather than partly read.',
    },
    portalId: {
      type: 'string',
      pattern: '^[0-9]{1,20}$',
      description: 'The portal that answered, as digits (hubId).',
    },
    appId: {
      type: 'string',
      pattern: '^[0-9]{1,20}$',
      description: 'The private app the grant is about, as digits.',
    },
    capturedAt: {
      type: 'string',
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$',
      description: 'When the portal answered, in UTC.',
    },
    statedBy: {
      type: 'string',
      minLength: 1,
      description: 'The endpoint that answered. A statement with no author is not evidence.',
    },
    scopes: {
      type: 'array',
      description: 'The scopes the portal granted the app, as the portal spelled them.',
      items: { type: 'string', pattern: '^[a-z0-9._-]+$' },
    },
  },
};

/**
 * The scope segment of each canonical object, so `crm.objects.<segment>.write`
 * is the portal's statement about that object. The segments are HubSpot's own
 * (the same ones the properties endpoint uses), spelled here once.
 */
const HUBSPOT_OBJECT_SCOPE_SEGMENTS = new Map<string, string>([
  ['CONTACT', 'contacts'],
  ['COMPANY', 'companies'],
  ['DEAL', 'deals'],
]);

export function hubSpotWriteScopeFor(objectApiName: string, origin: string): string {
  const segment = HUBSPOT_OBJECT_SCOPE_SEGMENTS.get(canonicalHubSpotObject(objectApiName, origin));
  invariant(segment !== undefined, 'HUBSPOT_SCOPE_SEGMENT', `${origin} folded to an object with no scope segment`, {
    origin,
    objectApiName,
  });
  return `crm.objects.${segment}.write`;
}

/**
 * Read the access grant the collector wrote.
 *
 * Malformed is a configuration failure, as for the supplement: it is a file
 * the collector wrote from a response, and the fix is to capture again.
 */
export function parseHubSpotAccessGrant(text: string, origin = 'access-grant.json'): HubSpotAccessGrant {
  if (text.length > DEFAULT_HUBSPOT_ARTIFACT_LIMITS.maxCharacters) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${origin} holds ${String(text.length)} characters, above the limit of ${String(DEFAULT_HUBSPOT_ARTIFACT_LIMITS.maxCharacters)}`,
      'An access grant is a short list of scopes. Check that this is the right file.',
      { origin, limit: 'maxCharacters', allowed: DEFAULT_HUBSPOT_ARTIFACT_LIMITS.maxCharacters, actual: text.length },
    );
  }
  let parsed: JsonValue;
  try {
    parsed = parseJson(text);
  } catch (error) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} is not well-formed JSON: ${error instanceof Error ? error.message : String(error)}`,
      'Capture the grant again. Nothing is read from a document that does not parse.',
      { origin },
    );
  }
  const violations = validateAgainstSchema(parsed, HUBSPOT_ACCESS_GRANT_SCHEMA);
  if (violations.length > 0) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} does not match the HubSpot access grant schema`,
      'Correct each listed pointer, or capture the grant again. The schema is closed, so an unknown key is rejected rather than ignored.',
      {
        origin,
        violations: violations.map((violation) => ({
          pointer: violation.pointer === '' ? '/' : violation.pointer,
          message: violation.message,
        })),
      },
    );
  }
  const raw = parsed as JsonObject;
  const capturedAt = schemaString(raw, 'capturedAt', origin);
  if (!isUtcTimestamp(capturedAt)) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} states the capture time "${capturedAt}", which is not a date on the calendar`,
      'Write the capture time in UTC, to the second, ending in Z.',
      { origin, capturedAt },
    );
  }
  const scopesRaw = raw['scopes'];
  invariant(Array.isArray(scopesRaw), 'HUBSPOT_ACCESS_GRANT_SHAPE', `${origin} passed the closed schema without a scopes array`, {
    origin,
  });
  const scopes = [...new Set(scopesRaw.map((scope) => String(scope)))].sort(compareCodeUnits);
  if (scopes.length !== scopesRaw.length) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} lists a scope more than once`,
      'Write each scope once, as the portal returned it. A repeated scope is a response somebody edited.',
      { origin, scopes: scopesRaw.map((scope) => String(scope)) },
    );
  }
  return {
    portalId: schemaString(raw, 'portalId', origin),
    appId: schemaString(raw, 'appId', origin),
    capturedAt,
    statedBy: schemaString(raw, 'statedBy', origin),
    scopes,
  };
}

/**
 * The object flags, from the grant.
 *
 * The write scope is one scope for create and update alike, because that is how
 * HubSpot grants it; both flags therefore read the same and both say where they
 * came from: the grant. Nothing else in the object changes.
 */
function applyAccessGrant(
  objects: readonly TargetObjectContract[],
  grant: HubSpotAccessGrant | undefined,
): TargetObjectContract[] {
  if (grant === undefined) return [...objects];
  return objects.map((object) => {
    const writes = grant.scopes.includes(hubSpotWriteScopeFor(object.apiName, 'the access grant'));
    const flag: TargetFlag = writes ? 'TRUE' : 'FALSE';
    return { ...object, createable: flag, updateable: flag };
  });
}

/**
 * The endpoint this reader reads, named once so every message spells it the same.
 *
 * The path segment is the object, and it is the only place the object appears:
 * the response body names properties and never names what they belong to.
 */
export const HUBSPOT_PROPERTY_API_ENDPOINT = 'GET /crm/v3/properties/{objectType}';

/**
 * Why a second reader of the same facts exists.
 *
 * The property export is produced by a Settings action that emails a file. It
 * cannot be triggered headlessly, so an export only exists where a person went
 * and made one, and the HubSpot exports this repository holds are from the
 * portal whose export somebody happened to have rather than from the portal a
 * qualification authenticates to. That is not a tidiness problem: a contract
 * built from the wrong portal's export describes properties the credentialled
 * portal does not have, and match keys it does not have either.
 *
 * The properties endpoint answers on the credential a run already holds, so the
 * portal a qualification authenticates to is also the portal it can describe.
 * It is not a workaround for the export; it is better evidence, for one reason
 * above all others:
 *
 *   - The export cannot carry uniqueness. `parseHubSpotPropertyExport` therefore
 *     returns `unique: 'UNKNOWN'` for every property, and a human-written
 *     supplement has to state it. Uniqueness is what decides whether a property
 *     may be a match key, so on the export path the single fact a match rests on
 *     is the one fact no artifact establishes.
 *   - The response states `hasUniqueValue` directly. On the 2026-09-04 capture
 *     of portal 51872453 that is `email`, `hs_additional_emails` and
 *     `hs_unique_creation_key` on contacts — stated by the portal rather than by
 *     whoever wrote the supplement.
 *
 * The response also carries `fieldType`, `calculated` and `modificationMetadata`,
 * which the export carries partly or not at all.
 *
 * What it still does not carry, and what therefore stays UNKNOWN here exactly as
 * it does on the export path: whether a property is required, whether the portal
 * refuses a value outside the option list, and any length, precision or scale.
 * `externalOptions` is not restrictedPicklist and is not read as it.
 */

/**
 * Closed about what it reads, open about what it ignores.
 *
 * Both halves are required and they pull opposite ways. HubSpot adds keys to
 * this response over time — `dataSensitivity` and `dateDisplayHint` are on the
 * 2026-09-04 capture and are in no documentation this repository has — so a
 * schema that refused an unknown key would refuse every future portal, and the
 * reader would break on a portal that had done nothing wrong. But a schema that
 * merely ignores unknown keys makes the reader silently open-ended: a key added
 * next year sits in the body being not-read, and nobody can say from the code
 * what was read and what was passed over.
 *
 * The resolution is to read a projection rather than the body. Before anything
 * is validated the body is projected onto this schema: every key the schema
 * declares is kept, every key it does not declare is dropped and its path is
 * recorded on the capture as `ignoredKeys`. The projection is then validated
 * against this closed schema, and the projection is the only thing the parser
 * ever reads.
 *
 * So an unknown key is tolerated — it cannot fail a read — and it cannot become
 * authority, because it is not in the value the parser is handed. What the
 * schema declares is exactly the reader's surface, and a declared key arriving
 * with the wrong type still fails the read rather than being quietly dropped.
 *
 * Three keys are declared and deliberately not carried into the contract, for
 * the same reason `GROUP` and `DESCRIPTION` are declared in the export's header
 * table: declaring them records that this reader saw them and chose, rather than
 * leaving a reader of this file to wonder whether they were missed.
 *
 *   - `fieldType` is HubSpot's widget token (`text`, `select`, `radio`) and is a
 *     different fact from `type` (`string`, `enumeration`). `TargetFieldContract`
 *     has one type slot, and the export's "Type" column carries `type`, so
 *     `type` is what goes in it. Putting `fieldType` there would make the two
 *     readers of one portal disagree about every enumeration property.
 *   - `description` and `groupName` have nowhere to go on a field contract at
 *     all, which is already true of the export's Description and Group columns.
 *
 * `referencedObjectType` is not declared. It is on three of the 402 contact
 * properties, and it is not established that its vocabulary is the vocabulary of
 * `referenceTo`; mapping it would be this parser inventing a fact rather than
 * recording one.
 */
export const HUBSPOT_PROPERTY_API_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      description: "The portal's properties for one object, in the order the response listed them.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'label', 'type'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            description: 'The internal name the portal answers to. Nothing else in the response addresses a property.',
          },
          label: {
            type: 'string',
            minLength: 1,
            description: 'What a person sees. Never used to address the property.',
          },
          type: { type: 'string', minLength: 1, description: "The portal's own type token, recorded verbatim." },
          fieldType: {
            type: 'string',
            description: 'Read and not carried: a different fact from type, and the contract has one type slot.',
          },
          description: { type: 'string', description: 'Read and not carried: a field contract has nowhere to put it.' },
          groupName: { type: 'string', description: 'Read and not carried: a field contract has nowhere to put it.' },
          calculated: {
            type: 'boolean',
            description: 'The portal computes the value. Absent means not established, not false.',
          },
          hasUniqueValue: {
            type: 'boolean',
            description: 'The fact no export can carry, and the one that decides whether a property may be a match key.',
          },
          modificationMetadata: {
            type: 'object',
            additionalProperties: false,
            description: 'Whether the portal accepts a value for the property, and whether the definition can be edited.',
            properties: {
              readOnlyValue: { type: 'boolean', description: 'The portal refuses writes to the value.' },
              readOnlyDefinition: {
                type: 'boolean',
                description:
                  'Read and not carried: the definition is locked, which is true of most HubSpot-defined properties whose values are perfectly writable. Reading it as readOnlyValue would make almost every property unwritable.',
              },
            },
          },
          options: {
            type: 'array',
            description: 'The values the property offers, in the order the response listed them.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['value'],
              properties: {
                value: { type: 'string', minLength: 1, description: 'The token the portal accepts.' },
                // Not minLength 1. One option on the 2026-09-04 contacts capture
                // (hs_sa_first_engagement_descr, value EMPTY_DESCRIPTION) has an
                // empty label, and refusing it would refuse a real portal for
                // telling the truth about itself.
                label: {
                  type: 'string',
                  description: 'What a person sees. May be empty; a real portal returns one that is.',
                },
                hidden: { type: 'boolean', description: 'The option is not offered. Absent is not "shown"; see the reader.' },
              },
            },
          },
        },
      },
    },
  },
};

/** One object's properties as the portal returned them, plus the portal the caller says they came from. */
export interface HubSpotPropertyApiCapture {
  /** The object the request named. The body does not carry it, so the caller states it. */
  readonly objectApiName: string;
  /**
   * The portal these properties came from.
   *
   * Never a constant, and never inferred: the properties response carries no
   * portal id at all, which is exactly how a contract came to name portal
   * 51050101 while the credential authenticated to 51872453. The caller states
   * it and states where it got it, and `buildHubSpotTargetContract` refuses a
   * capture whose portal disagrees with the portal the contract speaks for.
   */
  readonly portalId: string;
  /** The capture that established the portal id — beside the 2026-09-04 captures, the GET /account-info body that states portalId. */
  readonly portalIdSource: string;
  readonly filePath: string;
  readonly object: TargetObjectContract;
  /**
   * The JSON paths the projection dropped, sorted, with `*` for an array
   * position. A key listed here was tolerated and read by nothing; it is
   * recorded so that "the reader ignores it" is a reviewable claim rather than
   * an invisible one.
   */
  readonly ignoredKeys: readonly string[];
}

export interface HubSpotPropertyApiOrigin {
  /** The object the {objectType} segment named. The response body names no object. */
  readonly objectApiName: string;
  readonly objectLabel: string;
  /** Digits, as HubSpot writes a portal id. Stated by the caller because the body does not carry it. */
  readonly portalId: string;
  /** Required. A portal id with no stated source is a constant wearing a capture's clothes. */
  readonly portalIdSource: string;
  /** Used in every error. It is a name for the bytes, never a path anything opens. */
  readonly filePath: string;
  readonly limits?: HubSpotArtifactLimits;
}

/**
 * Project a body onto the schema, keeping the declared keys and recording the rest.
 *
 * A value that is not the shape the schema expects is returned untouched, so the
 * validator that runs next reports the type it actually saw rather than a
 * projection's guess at it.
 *
 * `anyOf` is passed through unprojected. This schema uses none, and projecting
 * through a union would mean choosing a branch, which is the kind of choice this
 * file exists in order not to make.
 */
function projectOntoSchema(value: JsonValue, schema: Schema, ignored: Set<string>, path: string): JsonValue {
  if ('anyOf' in schema) return value;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return value;
    return value.map((item) => projectOntoSchema(item, schema.items, ignored, `${path}/*`));
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const source: JsonObject = value;
    const kept: JsonObject = {};
    for (const key of Object.keys(source)) {
      const declared = schema.properties[key];
      const held = source[key];
      if (declared === undefined) {
        ignored.add(`${path}/${key}`);
        continue;
      }
      if (held === undefined) continue;
      kept[key] = projectOntoSchema(held, declared, ignored, `${path}/${key}`);
    }
    return kept;
  }
  return value;
}

/**
 * A boolean the response either states or does not.
 *
 * `true` and `false` are statements. Absent is not a third boolean and is not
 * `false`: a describe shows what its user can see, and a key the response leaves
 * out is not-established rather than does-not-exist. Rounding absence to FALSE
 * would, for `hasUniqueValue`, disqualify the one property a migration was going
 * to match on while looking like an answer.
 */
function apiBooleanFlag(value: JsonValue | undefined): TargetFlag {
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  return 'UNKNOWN';
}

function apiString(entry: JsonObject, key: string, filePath: string): string {
  const value = entry[key];
  invariant(
    typeof value === 'string',
    'HUBSPOT_PROPERTY_API_SHAPE',
    `${filePath} passed the closed schema with a non-string "${key}"`,
    { filePath, key },
  );
  return value;
}

function typeSeen(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Read one object's properties response into an object contract.
 *
 * The result is the same shape `parseHubSpotPropertyExport` produces, on
 * purpose: both readers describe one portal, both feed one contract builder, and
 * where a contract is built from both, `buildHubSpotTargetContract` holds them
 * against each other property by property.
 *
 * Every field comes out with evidence `ARTIFACT`. A response the portal produced
 * on its own credential is an export by another route, not a statement somebody
 * made about the portal, and recording it as SUPPLEMENT would understate it as
 * badly as recording a supplement as ARTIFACT would overstate one.
 */
export function parseHubSpotPropertyApi(text: string, origin: HubSpotPropertyApiOrigin): HubSpotPropertyApiCapture {
  const limits = origin.limits ?? DEFAULT_HUBSPOT_ARTIFACT_LIMITS;
  const filePath = origin.filePath;

  if (origin.objectApiName.trim() === '' || origin.objectApiName !== origin.objectApiName.trim()) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the object name for ${filePath} is "${origin.objectApiName}", which is empty or carries surrounding whitespace`,
      `State the object the capture describes, exactly as the {objectType} segment of ${HUBSPOT_PROPERTY_API_ENDPOINT} spelled it. The response body names no object.`,
      { filePath, objectApiName: origin.objectApiName },
    );
  }
  if (origin.objectLabel.trim() === '') {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the object label for ${filePath} is empty`,
      'State the label a person would recognise the object by.',
      { filePath, objectApiName: origin.objectApiName },
    );
  }
  if (!/^[0-9]{1,20}$/u.test(origin.portalId)) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the portal id for ${filePath} is "${origin.portalId}", which is not the digits HubSpot writes a portal id as`,
      'Take the portal id from a capture that carries one — the GET /account-info body states portalId — and pass it in. This response carries no portal id, so it cannot be recovered from these bytes.',
      { filePath, portalId: origin.portalId },
    );
  }
  if (origin.portalIdSource.trim() === '') {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the portal id for ${filePath} names no source`,
      'Say which capture established the portal id. A portal id with no stated source is a constant, and a constant is how a contract came to name a portal nobody authenticated to.',
      { filePath, portalId: origin.portalId },
    );
  }

  if (text.length > limits.maxCharacters) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${filePath} holds ${String(text.length)} characters, above the limit of ${String(limits.maxCharacters)}`,
      'Raise maxCharacters if a response this large is expected, or check that this is the properties response.',
      { filePath, limit: 'maxCharacters', allowed: limits.maxCharacters, actual: text.length },
    );
  }

  let parsed: JsonValue;
  try {
    parsed = parseJson(text);
  } catch (error) {
    throw new MigrationError(
      'INPUT_UNSUPPORTED',
      `${filePath} is not well-formed JSON: ${error instanceof Error ? error.message : String(error)}. First line seen: "${firstLine(text)}"`,
      `Capture the body of ${HUBSPOT_PROPERTY_API_ENDPOINT} exactly as the portal returned it. Nothing is read from bytes that do not parse.`,
      { filePath },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MigrationError(
      'INPUT_UNSUPPORTED',
      `${filePath} is ${typeSeen(parsed)} where the properties response is a JSON object. First line seen: "${firstLine(text)}"`,
      `Capture the body of ${HUBSPOT_PROPERTY_API_ENDPOINT} exactly as the portal returned it.`,
      { filePath },
    );
  }

  const body: JsonObject = parsed;
  const topLevelKeys = Object.keys(body).sort(compareCodeUnits);
  // A failed request is a well-formed JSON object too. HubSpot answers an
  // unauthorised or wrong-scope call with {"status":"error","message":...,
  // "category":...}, which carries no results; reported as a schema violation it
  // would read as a shape problem instead of as the record of a call that never
  // described the portal at all.
  if (!Object.prototype.hasOwnProperty.call(body, 'results')) {
    throw new MigrationError(
      'INPUT_UNSUPPORTED',
      `${filePath} is not a properties response: it carries no "results". Top-level keys seen: ${quoteAll(topLevelKeys)}`,
      `Capture the body of a 200 from ${HUBSPOT_PROPERTY_API_ENDPOINT}. An error body records a call that failed, not a description of the portal.`,
      { filePath, keysSeen: [...topLevelKeys] },
    );
  }
  // The properties endpoint returned every property in one body on 2026-09-04
  // and is not documented as paged. If a portal ever answers with a cursor, one
  // page read as the whole list would produce a contract stating the portal
  // lacks properties it has, which is worse than any refusal.
  if (Object.prototype.hasOwnProperty.call(body, 'paging')) {
    throw new MigrationError(
      'INPUT_UNSUPPORTED',
      `${filePath} carries a "paging" key, so it is one page of the portal's properties rather than all of them. Top-level keys seen: ${quoteAll(topLevelKeys)}`,
      'Capture every page and hand over one body holding the whole property list. A page read as the whole list would put "this portal has no such property" into a contract.',
      { filePath, keysSeen: [...topLevelKeys] },
    );
  }

  const ignored = new Set<string>();
  const projection = projectOntoSchema(body, HUBSPOT_PROPERTY_API_SCHEMA, ignored, '');
  const violations = validateAgainstSchema(projection, HUBSPOT_PROPERTY_API_SCHEMA);
  if (violations.length > 0) {
    throw new MigrationError(
      'INPUT_UNSUPPORTED',
      `${filePath} does not match the shape this reader knows for ${HUBSPOT_PROPERTY_API_ENDPOINT}: ${violations
        .slice(0, 5)
        .map((violation) => `${violation.pointer === '' ? '/' : violation.pointer} ${violation.message}`)
        .join('; ')}`,
      'Capture the response exactly as the portal returned it. A key this reader declares is read strictly; a key it does not declare is passed over, so a violation here is a declared key arriving as something else.',
      {
        filePath,
        violations: violations.map((violation) => ({
          pointer: violation.pointer === '' ? '/' : violation.pointer,
          message: violation.message,
        })),
      },
    );
  }

  invariant(
    typeof projection === 'object' && projection !== null && !Array.isArray(projection),
    'HUBSPOT_PROPERTY_API_SHAPE',
    `${filePath} projected to something that is not an object`,
    { filePath },
  );
  const results = projection['results'];
  invariant(
    Array.isArray(results),
    'HUBSPOT_PROPERTY_API_SHAPE',
    `${filePath} passed the closed schema without a results array`,
    { filePath },
  );
  if (results.length > limits.maxRows) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${filePath} lists ${String(results.length)} properties, above the limit of ${String(limits.maxRows)}`,
      'Raise maxRows if a portal with this many properties is expected.',
      { filePath, limit: 'maxRows', allowed: limits.maxRows, actual: results.length },
    );
  }
  if (results.length === 0) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} carries a results array and no properties`,
      'Capture the whole response. An object with no properties is a truncated body or a call against the wrong object, not a portal with nothing in it.',
      { filePath, objectApiName: origin.objectApiName },
    );
  }

  const fields: TargetFieldContract[] = [];
  const seenAt = new Map<string, number>();
  results.forEach((item, index) => {
    invariant(
      typeof item === 'object' && item !== null && !Array.isArray(item),
      'HUBSPOT_PROPERTY_API_SHAPE',
      `${filePath} passed the closed schema with a non-object at results[${String(index)}]`,
      { filePath, index },
    );
    const entry: JsonObject = item;
    const apiName = apiString(entry, 'name', filePath);
    if (apiName !== apiName.trim()) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${filePath} names the property "${apiName}" at results[${String(index)}] with surrounding whitespace`,
        'Record the name exactly as the portal returned it. This value addresses a property, and trimming it here would guess at the name the portal answers to.',
        { filePath, index, apiName },
      );
    }
    const previous = seenAt.get(apiName);
    if (previous !== undefined) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${filePath} lists the property "${apiName}" twice, at results[${String(previous)}] and results[${String(index)}]`,
        'Capture the response as the portal returned it. Two entries for one internal name make every lookup of that property ambiguous.',
        { filePath, apiName, first: previous, second: index },
      );
    }
    seenAt.set(apiName, index);

    const metadataRaw = entry['modificationMetadata'];
    const metadata: JsonObject =
      typeof metadataRaw === 'object' && metadataRaw !== null && !Array.isArray(metadataRaw) ? metadataRaw : {};
    const calculated = apiBooleanFlag(entry['calculated']);
    // The same two facts the export's "Read only value" and "Calculated" columns
    // carry, combined by the same function they are combined by there. Two
    // readers of one portal that derived writability differently would
    // contradict each other on any property where the two facts point different
    // ways, and the contradiction would surface as a refused build rather than
    // as the defect it is.
    const writable = writableFrom(apiBooleanFlag(metadata['readOnlyValue']), calculated);

    fields.push({
      apiName,
      label: apiString(entry, 'label', filePath),
      // The portal's own token, recorded exactly as returned.
      type: apiString(entry, 'type', filePath),
      createable: writable,
      updateable: writable,
      nillable: 'UNKNOWN',
      length: null,
      precision: null,
      scale: null,
      // The whole reason this reader exists. `hasUniqueValue: true` is the portal
      // stating that the property requires unique values, and `false` is the
      // portal stating that it does not. The export carries neither, which is
      // why every property it produces comes out UNKNOWN and needs somebody to
      // write a supplement before any HubSpot match is satisfiable at all.
      unique: apiBooleanFlag(entry['hasUniqueValue']),
      // HubSpot documents no equivalent of Salesforce's External ID or of
      // idLookup, so no reading of any HubSpot artifact can establish them.
      externalId: 'UNKNOWN',
      idLookup: 'UNKNOWN',
      calculated,
      autoNumber: 'UNKNOWN',
      defaultedOnCreate: 'UNKNOWN',
      // `externalOptions` is not this. Nothing in the response says whether the
      // portal refuses a value outside the option list.
      restrictedPicklist: 'UNKNOWN',
      picklistValues: apiOptions(entry['options'], apiName, limits, filePath),
      referenceTo: [],
      relationshipName: null,
      evidence: 'ARTIFACT',
    });
  });

  return {
    objectApiName: origin.objectApiName,
    portalId: origin.portalId,
    portalIdSource: origin.portalIdSource,
    filePath,
    object: {
      apiName: origin.objectApiName,
      label: origin.objectLabel,
      // Whether the object accepts creates or updates is account state the
      // properties response says nothing about, exactly as the export does not.
      createable: 'UNKNOWN',
      updateable: 'UNKNOWN',
      fields,
      // HubSpot has no record types. The empty list is the fact, not a gap.
      recordTypes: [],
    },
    ignoredKeys: [...ignored].sort(compareCodeUnits),
  };
}

/**
 * Options as the response carries them.
 *
 * Nothing is split here. The export reader has to take `Organic Search
 * (ORGANIC_SEARCH)` apart because that is the only form it is given; the
 * response states the label and the value as separate keys, and a reader that
 * re-derived them would be reformatting evidence it was handed.
 *
 * Two readings that are not simply transcription, and why:
 *
 *   - `active` is a plain boolean on the contract with no third state, so an
 *     option the response says nothing about has to round to something.
 *     `hidden: true` is the portal saying the option is not offered, and that
 *     reads as `active: false`. Absent `hidden` rounds to `active: true`, which
 *     is the export reader's reading and keeps an option in the accepted set
 *     rather than quietly removing a value the portal may well accept.
 *   - `defaultValue` is false on every option. The response names no default,
 *     and that reads as "this capture names no default" rather than as a claim
 *     about any one of them.
 *
 * The order is the response's order, kept. `displayOrder` is on the response and
 * is not read: sorting by it would discard the ordering the capture states and
 * add one of ours.
 */
function apiOptions(
  raw: JsonValue | undefined,
  apiName: string,
  limits: HubSpotArtifactLimits,
  filePath: string,
): readonly TargetPicklistValue[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > limits.maxPicklistOptions) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${filePath} lists ${String(raw.length)} options on "${apiName}", above the limit of ${String(limits.maxPicklistOptions)}`,
      'Raise maxPicklistOptions if a list this long is expected.',
      {
        filePath,
        apiName,
        limit: 'maxPicklistOptions',
        allowed: limits.maxPicklistOptions,
        actual: raw.length,
      },
    );
  }
  return raw.map((item): TargetPicklistValue => {
    invariant(
      typeof item === 'object' && item !== null && !Array.isArray(item),
      'HUBSPOT_PROPERTY_API_SHAPE',
      `${filePath} passed the closed schema with a non-object option on "${apiName}"`,
      { filePath, apiName },
    );
    const option: JsonObject = item;
    const value = apiString(option, 'value', filePath);
    const label = option['label'];
    return {
      value,
      // A response that states no label states none; recording the value in its
      // place is what the export reader already does for a token it cannot split.
      label: typeof label === 'string' ? label : value,
      active: option['hidden'] !== true,
      defaultValue: false,
    };
  });
}

export const HUBSPOT_ARTIFACT_KINDS = [
  'HUBSPOT_PROPERTY_EXPORT',
  'HUBSPOT_PROPERTY_API',
  'HUBSPOT_PIPELINE_ARTIFACT',
  'HUBSPOT_SUPPLEMENT',
  'HUBSPOT_ACCESS_GRANT',
] as const;
export type HubSpotArtifactKind = (typeof HUBSPOT_ARTIFACT_KINDS)[number];

/**
 * Name the bytes an artifact was read from.
 *
 * The hash covers the UTF-8 encoding of the same text the parser was handed, so
 * a contract can be checked against the file it claims without re-reading the
 * file the way the parser did. The path is recorded and never opened, and it is
 * still refused when it points outside the capture: a contract that names a
 * file outside the bundle describes a capture nobody can reproduce.
 *
 * `HUBSPOT_PROPERTY_API` is named here the same way the CSV artifacts are, and
 * deliberately so: what is being named is bytes somebody kept, not a file
 * format. A response body that was captured, written down and hashed is
 * reproducible evidence; one that was read from a socket and thrown away is
 * not, which is why the kind exists at all rather than the engine simply
 * calling the endpoint.
 */
export function hubSpotArtifactRef(path: string, kind: HubSpotArtifactKind, text: string): TargetArtifactRef {
  const outside =
    path.trim() === '' ||
    path !== path.trim() ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    path.split('/').includes('..');
  if (outside) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the artifact path "${path}" is not a relative path inside the capture`,
      'Use a relative path with forward slashes that stays inside the capture directory.',
      { path, kind },
    );
  }
  const bytes = new TextEncoder().encode(text);
  return { path, sha256: sha256Hex(bytes), byteLength: bytes.length, kind };
}

export interface HubSpotTargetContractInput {
  readonly supplement: HubSpotSupplement;
  /** Objects read from property exports by `parseHubSpotPropertyExport`. */
  readonly objects: readonly TargetObjectContract[];
  /**
   * Objects read from properties responses by `parseHubSpotPropertyApi`.
   *
   * Kept apart from `objects` rather than merged by the caller, because the two
   * readings of one object have to be held against each other here and a caller
   * that had already merged them would have thrown away the disagreement.
   */
  readonly apiCaptures?: readonly HubSpotPropertyApiCapture[];
  readonly pipelines: readonly TargetPipeline[];
  readonly artifacts: readonly TargetArtifactRef[];
  /**
   * The scopes the portal granted the integration, read by `parseHubSpotAccessGrant`.
   * Absent, the object flags stay UNKNOWN and every writing run refuses; present,
   * it is one more artifact of the capture and must speak for the same portal.
   */
  readonly accessGrant?: HubSpotAccessGrant;
  readonly limits?: HubSpotArtifactLimits;
}

/**
 * Assemble a contract from the artifacts that were read and the statement that
 * covers what they could not carry.
 *
 * The order of the arrays this receives is a decision of whoever assembled
 * them rather than a fact about the portal, and the digest must not depend on
 * it, so objects, pipelines and artifacts are each sorted by an explicit total
 * order here. Inside an object the field order is left as the capture had it:
 * neither reader states a display order, so there is nothing for a sort to
 * preserve and nothing for it to destroy.
 *
 * THE MINIMUM ARTIFACT SET, stated because two readers now produce objects and
 * "which files make a contract" must not be inferred from which branch happened
 * to run:
 *
 *   - Exactly one HUBSPOT_SUPPLEMENT. Still required, and required even where
 *     every object came from the API. The properties response carries no portal
 *     id, no portal name and no capture time, and those three are the contract's
 *     instance identity and its `capturedAt`. The API removes the need for the
 *     supplement's *uniqueness statements*; it does not remove the need for the
 *     supplement.
 *   - At least one property artifact, being a HUBSPOT_PROPERTY_EXPORT or a
 *     HUBSPOT_PROPERTY_API or both. A contract with no property artifact
 *     describes nothing.
 *   - A HUBSPOT_PIPELINE_ARTIFACT if and only if there are pipelines, unchanged.
 *
 * So the smallest valid capture is two files: one supplement and one property
 * artifact of either kind.
 *
 * WHEN BOTH ARE SUPPLIED FOR ONE OBJECT they must agree, and a disagreement is
 * a refusal. This is the most valuable check in the file. Two readers of one
 * portal that contradict each other are not two facts, they are one portal
 * described twice and at most once correctly, and there is no basis here for
 * preferring either. It is also the check that would have caught what this work
 * exists to fix: an export naming a 209-field CONTACT and a capture of a
 * 402-property one cannot both describe the portal a run authenticates to, and
 * the property-set comparison below says so in as many words.
 */
export function buildHubSpotTargetContract(input: HubSpotTargetContractInput): TargetContract {
  const limits = input.limits ?? DEFAULT_HUBSPOT_ARTIFACT_LIMITS;
  const apiCaptures = input.apiCaptures ?? [];

  if (input.artifacts.length > limits.maxArtifacts) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `the capture names ${String(input.artifacts.length)} artifacts, above the limit of ${String(limits.maxArtifacts)}`,
      'Raise maxArtifacts if a capture this large is expected, or split the capture.',
      { limit: 'maxArtifacts', allowed: limits.maxArtifacts, actual: input.artifacts.length },
    );
  }
  const totalBytes = input.artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0);
  if (totalBytes > limits.maxArtifactBytes) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `the capture holds ${String(totalBytes)} bytes of artifacts, above the limit of ${String(limits.maxArtifactBytes)}`,
      'Raise maxArtifactBytes if a capture this large is expected, or split the capture.',
      { limit: 'maxArtifactBytes', allowed: limits.maxArtifactBytes, actual: totalBytes },
    );
  }

  const pathSeen = new Set<string>();
  const digestSeen = new Map<string, string>();
  for (const artifact of input.artifacts) {
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `the artifact "${artifact.path}" carries "${artifact.sha256}" where a lower-case SHA-256 belongs`,
        'Build the reference with hubSpotArtifactRef so the digest covers the bytes that were read.',
        { path: artifact.path, sha256: artifact.sha256 },
      );
    }
    if (pathSeen.has(artifact.path)) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `the capture names the artifact "${artifact.path}" twice`,
        'Name each artifact once. Two entries for one path leave the contract unable to say which bytes it was built from.',
        { path: artifact.path },
      );
    }
    pathSeen.add(artifact.path);
    const previous = digestSeen.get(artifact.sha256);
    if (previous !== undefined) {
      throw new MigrationError(
        'INPUT_DUPLICATE_FILE',
        `"${artifact.path}" is byte-identical to "${previous}"`,
        'Remove one of them. The same bytes twice is one capture recorded twice, not two facts about the portal.',
        { path: artifact.path, duplicateOf: previous, sha256: artifact.sha256 },
      );
    }
    digestSeen.set(artifact.sha256, artifact.path);
  }

  const kinds = input.artifacts.map((artifact) => artifact.kind);
  const countOf = (kind: HubSpotArtifactKind): number => kinds.filter((seen) => seen === kind).length;
  if (countOf('HUBSPOT_SUPPLEMENT') !== 1) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the capture names ${String(countOf('HUBSPOT_SUPPLEMENT'))} supplement artifacts where exactly one belongs`,
      'Record the supplement the portal id and the uniqueness statements were read from.',
      { kinds: [...kinds] },
    );
  }
  if (countOf('HUBSPOT_PROPERTY_EXPORT') + countOf('HUBSPOT_PROPERTY_API') < 1) {
    throw new MigrationError(
      'CONFIG_INVALID',
      'the capture names neither a property export nor a properties API capture',
      'Record every property artifact the objects were read from, of either kind. A contract states which bytes produced it.',
      { kinds: [...kinds] },
    );
  }
  // One response body is one object, so the two counts are the same number or
  // one of them is unaccounted for. A capture with no artifact would put an
  // object into the contract that names no bytes; an artifact with no capture
  // would name bytes nothing was read from.
  if (countOf('HUBSPOT_PROPERTY_API') !== apiCaptures.length) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the capture names ${String(countOf('HUBSPOT_PROPERTY_API'))} properties API artifacts and carries ${String(apiCaptures.length)} API captures`,
      'Record one HUBSPOT_PROPERTY_API artifact for each properties response that was read, and no others.',
      { kinds: [...kinds], apiCaptures: apiCaptures.length },
    );
  }
  // The check this whole artifact kind exists for. The properties response
  // carries no portal id, so the only thing standing between a contract and the
  // wrong portal's properties is that the caller stated where the capture came
  // from and it is compared here against the portal the contract speaks for.
  for (const capture of apiCaptures) {
    if (capture.portalId !== input.supplement.portalId) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `${capture.filePath} was captured from portal ${capture.portalId} (stated from: ${capture.portalIdSource}) and the contract speaks for portal ${input.supplement.portalId}`,
        'Capture the properties from the portal the contract is for, or build the contract for the portal the properties came from. Properties from one portal under the name of another describe an account nobody looked at.',
        {
          filePath: capture.filePath,
          capturePortalId: capture.portalId,
          portalIdSource: capture.portalIdSource,
          supplementPortalId: input.supplement.portalId,
        },
      );
    }
  }
  // The grant, like the properties response, carries the portal it speaks for,
  // and it is compared against the portal the contract is for. A grant is one
  // artifact or none: one statement of what the portal granted, never two.
  const grant = input.accessGrant;
  if (countOf('HUBSPOT_ACCESS_GRANT') !== (grant === undefined ? 0 : 1)) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the capture names ${String(countOf('HUBSPOT_ACCESS_GRANT'))} access grant artifacts and carries ${grant === undefined ? 'no' : 'one'} access grant`,
      'Record the access-grant artifact the scopes were read from, or leave both out. A grant no artifact accounts for names scopes nobody captured.',
      { kinds: [...kinds], accessGrant: grant !== undefined },
    );
  }
  if (grant !== undefined && grant.portalId !== input.supplement.portalId) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the access grant was answered by portal ${grant.portalId} (stated by: ${grant.statedBy}) and the contract speaks for portal ${input.supplement.portalId}`,
      'Capture the grant with the credential of the portal the contract is for. Scopes granted on one portal say nothing about what another portal allows.',
      { grantPortalId: grant.portalId, supplementPortalId: input.supplement.portalId, appId: grant.appId },
    );
  }
  if (countOf('HUBSPOT_PIPELINE_ARTIFACT') > 0 !== input.pipelines.length > 0) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `the capture names ${String(countOf('HUBSPOT_PIPELINE_ARTIFACT'))} pipeline artifacts and carries ${String(input.pipelines.length)} pipelines`,
      'Record the artifact the pipelines were read from, or leave both out. A pipeline no artifact accounts for is a stage nobody captured.',
      { kinds: [...kinds], pipelines: input.pipelines.length },
    );
  }

  const exportedNames = new Set<string>();
  for (const object of input.objects) {
    if (exportedNames.has(object.apiName)) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `the capture carries the object "${object.apiName}" twice`,
        'Read each object once. Two contracts for one object make every field lookup ambiguous.',
        { objectApiName: object.apiName },
      );
    }
    exportedNames.add(object.apiName);
  }
  const capturedNames = new Set<string>();
  for (const capture of apiCaptures) {
    if (capturedNames.has(capture.objectApiName)) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `the capture carries two properties responses for the object "${capture.objectApiName}"`,
        "Read each object once from the API. Two responses for one object are two moments in that portal's life, and this reader has no basis for choosing between them.",
        { objectApiName: capture.objectApiName, filePath: capture.filePath },
      );
    }
    capturedNames.add(capture.objectApiName);
  }

  const readings = reconcileObjectReadings(input.objects, apiCaptures);
  if (readings.length === 0) {
    throw new MigrationError(
      'CONFIG_INVALID',
      'the capture carries no object',
      'Read at least one property export or one properties response. A contract with no object states nothing about the portal.',
      {},
    );
  }
  // One notion of object identity for the whole file. Reconciliation folds the
  // spelling, so the pipeline and supplement lookups must fold it too: two
  // different answers to "is this the same object" is how the 209-field export
  // and the 402-field capture came to sit in one contract.
  const objectNames = new Set(readings.map((object) => canonicalHubSpotObject(object.apiName, 'the capture')));

  const pipelineNames = new Map<string, Set<string>>();
  for (const pipeline of input.pipelines) {
    if (!objectNames.has(canonicalHubSpotObject(pipeline.objectApiName, 'the pipelines artifact'))) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `the pipeline "${pipeline.pipelineInternalName}" belongs to the object "${pipeline.objectApiName}", which the capture does not carry`,
        'Read the property export for that object, or spell the object in the pipelines artifact exactly as the export was read under. Names are matched exactly, never case-folded.',
        {
          pipelineInternalName: pipeline.pipelineInternalName,
          objectApiName: pipeline.objectApiName,
          objects: [...objectNames].sort(compareCodeUnits),
        },
      );
    }
    let names = pipelineNames.get(pipeline.objectApiName);
    if (names === undefined) {
      names = new Set<string>();
      pipelineNames.set(pipeline.objectApiName, names);
    }
    for (const name of [pipeline.pipelineInternalName, pipeline.pipelineLabel]) {
      if (names.has(name)) {
        throw new MigrationError(
          'CONFIG_INVALID',
          `the capture uses the name "${name}" for more than one pipeline of ${pipeline.objectApiName}`,
          'Give every pipeline of one object a label and an internal name no other pipeline of that object uses, in either position. A pipeline is looked up by either.',
          { objectApiName: pipeline.objectApiName, name },
        );
      }
      names.add(name);
    }
  }

  const objects = applyAccessGrant(applyUniqueStatements(readings, input.supplement), input.accessGrant);

  return {
    contractVersion: TARGET_CONTRACT_VERSION,
    parserVersion: TARGET_PARSER_VERSION,
    instance: {
      mode: 'HUBSPOT',
      instanceId: input.supplement.portalId,
      instanceLabel: input.supplement.portalName,
      // Nothing in a property export names the portal, so the instance a
      // contract speaks for is always stated rather than exported.
      evidence: 'SUPPLEMENT',
    },
    // The agency's capture time, not this run's clock.
    capturedAt: input.supplement.capturedAt,
    artifacts: [...input.artifacts].sort((left, right) => compareCodeUnits(left.path, right.path)),
    objects: objects.sort((left, right) => compareCodeUnits(left.apiName, right.apiName)),
    pipelines: [...input.pipelines].sort(
      (left, right) =>
        compareCodeUnits(left.objectApiName, right.objectApiName) ||
        compareCodeUnits(left.pipelineInternalName, right.pipelineInternalName),
    ),
  };
}

/** Property names quoted in a message about a set difference, capped so a 402-property object still reads. */
const NAMES_IN_MESSAGE = 12;

function reconcileFailure(message: string, details: JsonObject): MigrationError {
  return new MigrationError(
    'CONFIG_INVALID',
    message,
    'Capture both readings from the same portal at the same time, or supply only one of them. Two readings of one portal that contradict each other cannot both be evidence, and nothing here has a basis for preferring either.',
    details,
  );
}

/**
 * Hold the two readings of one portal against each other.
 *
 * An object read only one way passes through untouched. An object read both ways
 * is compared fact by fact and the comparison fails closed, which is the only
 * reason to accept two readings at all: an export nobody checks and an API
 * capture nobody checks are two chances to be wrong, while an export and a
 * capture that have to agree are a way of finding out.
 *
 * Where a fact is stated by one reader and not the other, the stated one is
 * carried. That is not a preference between readers, it is the tri-state doing
 * what it is for: `unique` comes from the API on every property because the
 * export cannot carry it, and `updateable` comes from whichever artifact
 * happened to carry the columns.
 */
/**
 * One object, however the caller spelled it.
 *
 * The reconciliation below was keyed on the object name as each caller typed
 * it, and neither artifact states one: the export takes it from
 * `HubSpotPropertyExportOptions` and the capture from `HubSpotPropertyApiOrigin`,
 * whose own documentation prescribes the URL segment. So the export said
 * `CONTACT`, the capture said `contacts`, and the check built to catch two
 * readers disagreeing about one object saw two objects instead. The real
 * 209-field export and the real 402-field capture of the same portal built into
 * one contract, side by side, which is precisely the contradiction this artifact
 * kind exists to refuse.
 *
 * Identity therefore cannot be a string somebody typed. It is folded to the
 * canonical object the adapters already name, and a spelling that folds to
 * nothing is refused rather than admitted under its own name — admitting it is
 * how the two readings drifted apart in the first place.
 */
const HUBSPOT_OBJECT_SPELLINGS = new Map<string, string>([
  ['contact', 'CONTACT'],
  ['contacts', 'CONTACT'],
  ['company', 'COMPANY'],
  ['companies', 'COMPANY'],
  ['deal', 'DEAL'],
  ['deals', 'DEAL'],
]);

export function canonicalHubSpotObject(spelling: string, origin: string): string {
  const folded = HUBSPOT_OBJECT_SPELLINGS.get(spelling.trim().toLowerCase());
  if (folded === undefined) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} names the object "${spelling}", which is not one this adapter admits`,
      `HubSpot carries Contact, Company and Deal. Name one of them, in any spelling this reader folds: ${[...HUBSPOT_OBJECT_SPELLINGS.keys()].join(', ')}. ` +
        'An object named some other way would be reconciled against nothing and would enter the contract as a second description of a portal that has only one.',
      { origin, spelling, admitted: [...new Set(HUBSPOT_OBJECT_SPELLINGS.values())] },
    );
  }
  return folded;
}

function reconcileObjectReadings(
  exported: readonly TargetObjectContract[],
  captures: readonly HubSpotPropertyApiCapture[],
): TargetObjectContract[] {
  const readings: TargetObjectContract[] = [...exported];
  const indexOf = new Map<string, number>();
  readings.forEach((object, index) => {
    const identity = canonicalHubSpotObject(object.apiName, 'the property export');
    const already = indexOf.get(identity);
    if (already !== undefined) {
      throw reconcileFailure(
        `the property export describes ${identity} twice, as "${readings[already]?.apiName ?? ''}" and as "${object.apiName}"`,
        { objectApiName: identity, first: readings[already]?.apiName ?? '', second: object.apiName },
      );
    }
    indexOf.set(identity, index);
  });
  for (const capture of captures) {
    const identity = canonicalHubSpotObject(capture.objectApiName, capture.filePath);
    const index = indexOf.get(identity);
    if (index === undefined) {
      indexOf.set(identity, readings.length);
      readings.push(capture.object);
      continue;
    }
    const exportedObject = readings[index];
    invariant(
      exportedObject !== undefined,
      'HUBSPOT_RECONCILE_INDEX',
      `the object "${capture.objectApiName}" was indexed at ${String(index)} and is not there`,
      { objectApiName: capture.objectApiName },
    );
    readings[index] = reconcileObject(exportedObject, capture);
  }
  return readings;
}

function reconcileObject(exported: TargetObjectContract, capture: HubSpotPropertyApiCapture): TargetObjectContract {
  const api = capture.object;
  if (exported.label !== api.label) {
    throw reconcileFailure(
      `the property export and ${capture.filePath} label the object "${exported.apiName}" differently: the export was read as "${exported.label}" and the capture as "${api.label}"`,
      { objectApiName: exported.apiName, filePath: capture.filePath, exported: exported.label, captured: api.label },
    );
  }

  // The property set first, because a difference here is not a disagreement
  // about a property, it is the two artifacts describing different portals or
  // different days. It is also the shape of the failure this artifact kind
  // exists to prevent: an export of a 209-field CONTACT and a capture of a
  // 402-property one, both filed under one portal.
  const apiNames = new Set(api.fields.map((field) => field.apiName));
  const exportedNames = new Set(exported.fields.map((field) => field.apiName));
  const onlyExported = exported.fields.map((field) => field.apiName).filter((name) => !apiNames.has(name));
  const onlyCaptured = api.fields.map((field) => field.apiName).filter((name) => !exportedNames.has(name));
  if (onlyExported.length > 0 || onlyCaptured.length > 0) {
    throw reconcileFailure(
      `the property export and ${capture.filePath} describe different properties of "${exported.apiName}": the export carries ${String(exported.fields.length)} and the capture ${String(api.fields.length)}; only in the export: ${quoteNames(onlyExported)}; only in the capture: ${quoteNames(onlyCaptured)}`,
      {
        objectApiName: exported.apiName,
        filePath: capture.filePath,
        exportedCount: exported.fields.length,
        capturedCount: api.fields.length,
        onlyExported: onlyExported.slice(0, NAMES_IN_MESSAGE),
        onlyCaptured: onlyCaptured.slice(0, NAMES_IN_MESSAGE),
      },
    );
  }

  const apiByName = new Map<string, TargetFieldContract>(
    api.fields.map((field): [string, TargetFieldContract] => [field.apiName, field]),
  );
  const fields = exported.fields.map((field) => {
    const other = apiByName.get(field.apiName);
    invariant(
      other !== undefined,
      'HUBSPOT_RECONCILE_FIELD',
      `the property "${field.apiName}" passed the set comparison and is not in the capture`,
      { objectApiName: exported.apiName, apiName: field.apiName },
    );
    return reconcileField(exported.apiName, field, other, capture.filePath);
  });

  return {
    apiName: exported.apiName,
    label: exported.label,
    createable: reconcileFlag(exported.createable, api.createable, 'createable', exported.apiName, capture.filePath),
    updateable: reconcileFlag(exported.updateable, api.updateable, 'updateable', exported.apiName, capture.filePath),
    // The export's order. Neither reader states a display order for a property,
    // so the two orders are two arbitrary orders over one set and there is
    // nothing to reconcile; picking the base reading's keeps this function from
    // inventing a third.
    fields,
    // HubSpot has no record types, so both readers state the empty list. There
    // is no third possibility to compare.
    recordTypes: exported.recordTypes,
  };
}

/**
 * Every fact on a field, written out one by one.
 *
 * Deliberately not a spread of one reading over the other. A field added to
 * `TargetFieldContract` and forgotten here would be a fact the two readings
 * were never compared on, which is exactly the fact a wrong contract would slip
 * through on. Listing them costs a line each and makes the omission a type
 * error rather than a silent gap — the same reason `targetContractToJson`
 * writes the contract out property by property instead of casting it.
 */
function reconcileField(
  objectApiName: string,
  exported: TargetFieldContract,
  api: TargetFieldContract,
  filePath: string,
): TargetFieldContract {
  const where = `${objectApiName}.${exported.apiName}`;
  const flag = (
    fact:
      | 'createable'
      | 'updateable'
      | 'nillable'
      | 'unique'
      | 'externalId'
      | 'idLookup'
      | 'calculated'
      | 'autoNumber'
      | 'defaultedOnCreate'
      | 'restrictedPicklist',
  ): TargetFlag => reconcileFlag(exported[fact], api[fact], fact, where, filePath);
  const numeric = (fact: 'length' | 'precision' | 'scale'): number | null =>
    reconcileNumber(exported[fact], api[fact], fact, where, filePath);

  return {
    apiName: exported.apiName,
    label: reconcileText(exported.label, api.label, 'label', where, filePath),
    type: reconcileText(exported.type, api.type, 'type', where, filePath),
    createable: flag('createable'),
    updateable: flag('updateable'),
    nillable: flag('nillable'),
    length: numeric('length'),
    precision: numeric('precision'),
    scale: numeric('scale'),
    unique: flag('unique'),
    externalId: flag('externalId'),
    idLookup: flag('idLookup'),
    calculated: flag('calculated'),
    autoNumber: flag('autoNumber'),
    defaultedOnCreate: flag('defaultedOnCreate'),
    restrictedPicklist: flag('restrictedPicklist'),
    picklistValues: reconcilePicklist(exported.picklistValues, api.picklistValues, where, filePath),
    referenceTo: reconcileList(exported.referenceTo, api.referenceTo, 'referenceTo', where, filePath),
    // Neither HubSpot reader states a relationship name, so this is the null
    // case every time. It still goes through the same rule as everything else:
    // null is silence and takes the other side, and two different names would be
    // a contradiction rather than a preference.
    relationshipName:
      exported.relationshipName === null
        ? api.relationshipName
        : api.relationshipName === null
          ? exported.relationshipName
          : reconcileText(exported.relationshipName, api.relationshipName, 'relationshipName', where, filePath),
    // The weaker of the two. Evidence is carried per field rather than per fact,
    // so anything else would describe a stated fact as an exported one. Both
    // readers produce ARTIFACT today; this is here so that stops being an
    // assumption if one of them ever does not.
    evidence: exported.evidence === 'SUPPLEMENT' || api.evidence === 'SUPPLEMENT' ? 'SUPPLEMENT' : 'ARTIFACT',
  };
}

function reconcileFlag(
  exported: TargetFlag,
  captured: TargetFlag,
  fact: string,
  where: string,
  filePath: string,
): TargetFlag {
  if (exported === captured) return exported;
  // UNKNOWN is the absence of a statement, so it never contradicts one. This is
  // what lets `unique` come from the API on every property: the export states
  // nothing there and disagrees with nothing.
  if (exported === 'UNKNOWN') return captured;
  if (captured === 'UNKNOWN') return exported;
  throw reconcileFailure(
    `the property export and ${filePath} disagree about ${fact} on ${where}: the export states ${exported} and the capture states ${captured}`,
    { where, fact, exported, captured, filePath },
  );
}

function reconcileText(exported: string, captured: string, fact: string, where: string, filePath: string): string {
  if (exported === captured) return exported;
  throw reconcileFailure(
    `the property export and ${filePath} disagree about ${fact} on ${where}: the export states "${exported}" and the capture states "${captured}"`,
    { where, fact, exported, captured, filePath },
  );
}

function reconcileNumber(
  exported: number | null,
  captured: number | null,
  fact: string,
  where: string,
  filePath: string,
): number | null {
  if (exported === captured) return exported;
  if (exported === null) return captured;
  if (captured === null) return exported;
  throw reconcileFailure(
    `the property export and ${filePath} disagree about ${fact} on ${where}: the export states ${String(exported)} and the capture states ${String(captured)}`,
    { where, fact, exported, captured, filePath },
  );
}

function reconcileList(
  exported: readonly string[],
  captured: readonly string[],
  fact: string,
  where: string,
  filePath: string,
): readonly string[] {
  if (exported.length === 0) return captured;
  if (captured.length === 0) return exported;
  const sameLength = exported.length === captured.length;
  if (sameLength && exported.every((value, index) => value === captured[index])) return exported;
  throw reconcileFailure(
    `the property export and ${filePath} disagree about ${fact} on ${where}: the export states ${quoteNames(exported)} and the capture states ${quoteNames(captured)}`,
    { where, fact, exported: [...exported], captured: [...captured], filePath },
  );
}

/**
 * Compare option lists by the values, and keep the capture's.
 *
 * Only the values are compared, and deliberately. A value is what the portal
 * accepts and is what a plan is checked against, so a difference there is a
 * difference about the portal. A label is a display string the export reader has
 * to recover from a rendering — `Organic Search (ORGANIC_SEARCH)` split on the
 * last parenthesised group — while the response states it as its own key, so a
 * difference between the labels is a difference in how well each artifact
 * carries a label rather than a disagreement about the account.
 *
 * The order is not compared either. Both readers keep the order their artifact
 * had, neither artifact states that the order means anything, and a refusal over
 * it would be a refusal about presentation.
 *
 * When both state options and the values agree, the capture's list is what is
 * kept: it carries `active` per option, which the export cannot, and its labels
 * are stated rather than recovered.
 */
function reconcilePicklist(
  exported: readonly TargetPicklistValue[],
  captured: readonly TargetPicklistValue[],
  where: string,
  filePath: string,
): readonly TargetPicklistValue[] {
  if (exported.length === 0) return captured;
  if (captured.length === 0) return exported;
  const exportedValues = [...exported.map((option) => option.value)].sort(compareCodeUnits);
  const capturedValues = [...captured.map((option) => option.value)].sort(compareCodeUnits);
  const same =
    exportedValues.length === capturedValues.length &&
    exportedValues.every((value, index) => value === capturedValues[index]);
  if (!same) {
    throw reconcileFailure(
      `the property export and ${filePath} disagree about the options on ${where}: the export states ${String(exported.length)} (${quoteNames(exportedValues)}) and the capture states ${String(captured.length)} (${quoteNames(capturedValues)})`,
      {
        where,
        fact: 'picklistValues',
        exported: exportedValues.slice(0, NAMES_IN_MESSAGE),
        captured: capturedValues.slice(0, NAMES_IN_MESSAGE),
        filePath,
      },
    );
  }
  return captured;
}

function quoteNames(values: readonly string[]): string {
  if (values.length === 0) return 'none';
  const shown = values.slice(0, NAMES_IN_MESSAGE).map((value) => `"${value}"`);
  const remainder = values.length - shown.length;
  return remainder > 0 ? `${shown.join(', ')} and ${String(remainder)} more` : shown.join(', ');
}

/**
 * Apply the agency's uniqueness statements to the fields the artifacts produced.
 *
 * A statement about a property the export did not carry fails the build. The
 * operator who wrote it believes they have declared a match key, and silently
 * dropping the statement would leave them believing it while the contract says
 * UNKNOWN.
 *
 * A field a statement touches is recorded as SUPPLEMENT even though its name,
 * label and type came from the export. Evidence is carried per field rather
 * than per fact, so the weaker of the two is the only reading that does not
 * describe a stated fact as an exported one.
 *
 * A properties API capture changes what a statement can do, because the portal
 * may already have answered the question the statement answers:
 *
 *   - Where the artifact left `unique` UNKNOWN, the statement applies as it
 *     always has, and the field drops to SUPPLEMENT.
 *   - Where the artifact states the same thing, the statement is left where it
 *     is and the field keeps its ARTIFACT evidence. Applying it would downgrade
 *     the portal's own answer to somebody's agreement with it.
 *   - Where the artifact states the opposite, the build fails. Letting the
 *     statement win would overwrite `hasUniqueValue` from the portal with a
 *     person's recollection of it, and letting the artifact win silently would
 *     leave whoever wrote the supplement believing they had declared a match key
 *     that the contract does not carry.
 */
function applyUniqueStatements(
  objects: readonly TargetObjectContract[],
  supplement: HubSpotSupplement,
): TargetObjectContract[] {
  for (const statement of supplement.uniqueProperties) {
    // Folded, like the reconciliation and the pipelines. A supplement written
    // against the URL segment and an export read under the canonical name are
    // the same object, and matching them exactly here would make a statement
    // about uniqueness silently apply to nothing.
    const wanted = canonicalHubSpotObject(statement.objectApiName, 'the supplement');
    const object = objects.find((candidate) => canonicalHubSpotObject(candidate.apiName, 'the capture') === wanted);
    if (object === undefined) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `the supplement states the uniqueness of ${statement.objectApiName}.${statement.internalName}, and the capture carries no object "${statement.objectApiName}"`,
        'Read the property export or the properties response for that object, or correct the object name in the supplement. Names are matched exactly, never case-folded.',
        { objectApiName: statement.objectApiName, internalName: statement.internalName },
      );
    }
    const field = object.fields.find((candidate) => candidate.apiName === statement.internalName);
    if (field === undefined) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `the supplement states the uniqueness of ${statement.objectApiName}.${statement.internalName}, which the capture for that object does not carry`,
        'Correct the internal name in the supplement, or supply the artifact that carries the property. A statement about a property nobody captured would name a match key the portal may not have.',
        { objectApiName: statement.objectApiName, internalName: statement.internalName },
      );
    }
    if (field.unique !== 'UNKNOWN' && field.unique !== statement.unique) {
      throw new MigrationError(
        'CONFIG_INVALID',
        `the supplement states that ${statement.objectApiName}.${statement.internalName} is unique ${statement.unique} and the captured artifact states ${field.unique}`,
        'Correct the supplement, or drop the statement: the portal has already answered. A properties capture states hasUniqueValue directly, and a statement is only for what no artifact carries.',
        {
          objectApiName: statement.objectApiName,
          internalName: statement.internalName,
          stated: statement.unique,
          captured: field.unique,
        },
      );
    }
  }

  return objects.map((object) => ({
    ...object,
    fields: object.fields.map((field) => {
      if (field.unique !== 'UNKNOWN') return field;
      const statement = supplement.uniqueProperties.find(
        (candidate) => candidate.objectApiName === object.apiName && candidate.internalName === field.apiName,
      );
      if (statement === undefined) return field;
      return { ...field, unique: statement.unique, evidence: 'SUPPLEMENT' };
    }),
  }));
}
