#!/usr/bin/env node
/**
 * The source shapes the capacity harness runs, and the generator that makes them.
 *
 * The ladder used to generate one narrow CSV shape and call it representative.
 * It is not: a migration that holds up on six columns of clean contacts says
 * nothing about a workbook of twelve sheets, a column with fifty thousand
 * distinct values, or a relationship graph dense enough to tension the joins.
 * The canonical document names twelve dimensions, and this is the finite set of
 * profiles that covers them.
 *
 * P1-P12 are that matrix: one profile per dimension, each one stressing a single
 * thing so that a failure names the thing it failed on. The three FOUNDING
 * profiles added alongside them are the opposite arrangement and exist for the
 * opposite reason: one profile per mode, exercising every dimension at once,
 * because the founding commitment is a million rows of the work a real migration
 * does rather than a million rows of one dimension at a time. Neither set
 * replaces the other. An integral profile that fails says the mode failed; only
 * the matrix says which dimension it failed on.
 *
 * Two rules the generator follows, both of which exist so the harness cannot
 * flatter itself:
 *
 *   Fixtures are written in blocks. Building the input must not be the largest
 *   thing the machine holds, or the measurement is of the generator.
 *
 *   Expected counts are computed from the parameters, never read back from what
 *   was generated. A count taken from the output is the harness agreeing with
 *   itself, and a generator defect would move both sides together.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const { getAdapter } = await import('../dist/src/adapters/specs.js');
const { objectSpec } = await import('../dist/src/adapters/adapter.js');
const { MAX_IDENTITY_GROUP_MEMBERS } = await import('../dist/src/domain/resource-profile.js');

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MANIFEST_PATH = join(repoRoot, 'qualification', 'capacity', 'profiles.json');

export const CAPACITY_PROFILES_VERSION = '1.2.1';

/** The million-row rung the founding commitment is stated at, and the largest the ladder runs. */
const COMMITMENT_RUNG = 1_000_000;

/**
 * The version of the capacity evidence record, declared once, here.
 *
 * It was declared twice and differently: this file exported `1.0.0`, which
 * `profiles.json` and `docs/CONTRACT.md` repeated, while `tools/capacity.mjs`
 * wrote the literal `'2.0.0'` into two of the three records it produced. Two
 * numbers for one schema means every consumer is reading a record whose shape it
 * has not actually agreed on, and the gate that compared them compared each to
 * whichever it happened to import.
 *
 * MC-3 makes it 3.0.0 rather than picking one of the two, because the record
 * genuinely changed: it now carries the producer's capture of the execution
 * subject, the campaign it belongs to, and per-stage resources — all required.
 * A reader of 1.0.0 or 2.0.0 does not validate any of that, so calling the new
 * record compatible with either would be the claim this constant exists to
 * prevent. The roadmap names `CAPACITY_EVIDENCE_VERSION 1.0.0`; that is the
 * version this front inherited, and it is superseded here with the reason
 * stated rather than reconciled by writing the old number over the new record.
 */
export const CAPACITY_EVIDENCE_SCHEMA_VERSION = '3.0.0';

export function loadProfiles() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.capacityProfilesVersion !== CAPACITY_PROFILES_VERSION) {
    throw new Error(
      `the capacity profile manifest is version ${String(manifest.capacityProfilesVersion)}, and this harness reads ${CAPACITY_PROFILES_VERSION}`,
    );
  }
  // A giant cluster larger than the identity group the engine declares it will
  // form is not measured: the run stops with IDENTITY_GROUP_TOO_LARGE, by
  // design, and the matrix records a refusal where it meant a cluster. 1.2.0's
  // P13 did exactly that at the million rung, twelve hours into a campaign.
  // Checked at the top rung, so a smoke at a small one cannot hide it.
  for (const profile of manifest.profiles) {
    if ((profile.shape.giantClusterShare ?? 0) <= 0) continue;
    const { clusterRows } = planOf(profile, COMMITMENT_RUNG);
    if (clusterRows > MAX_IDENTITY_GROUP_MEMBERS) {
      throw new Error(
        `profile ${String(profile.id)} puts ${String(clusterRows)} rows in one cluster at ${String(COMMITMENT_RUNG)} rows, past the ${String(MAX_IDENTITY_GROUP_MEMBERS)} members the engine admits in one identity group; lower giantClusterShare`,
      );
    }
  }
  return manifest;
}

// --------------------------------------------------------------- the columns

const BASE_COLUMNS = {
  CONTACT: [
    { header: 'Contact ID', kind: 'ID' },
    { header: 'First Name', kind: 'FIRST_NAME' },
    { header: 'Last Name', kind: 'LAST_NAME' },
    { header: 'Email', kind: 'EMAIL' },
    { header: 'Phone', kind: 'PHONE' },
    { header: 'Job Title', kind: 'CATEGORICAL' },
  ],
  COMPANY: [
    { header: 'Company ID', kind: 'ID' },
    { header: 'Name', kind: 'NAME' },
    { header: 'Domain', kind: 'DOMAIN' },
    { header: 'City', kind: 'CATEGORICAL' },
  ],
  DEAL: [
    { header: 'Deal ID', kind: 'ID' },
    { header: 'Deal Name', kind: 'NAME' },
    { header: 'Amount', kind: 'AMOUNT' },
    { header: 'Close Date', kind: 'DATE' },
    { header: 'Stage', kind: 'CATEGORICAL' },
    { header: 'Pipeline', kind: 'CATEGORICAL' },
  ],
  LEAD: [
    { header: 'Lead ID', kind: 'ID' },
    { header: 'First Name', kind: 'FIRST_NAME' },
    { header: 'Last Name', kind: 'LAST_NAME' },
    { header: 'Company', kind: 'NAME' },
    { header: 'Email', kind: 'EMAIL' },
  ],
};

const DESTINATION_FIELD = {
  CONTACT: {
    'First Name': 'contact.firstName',
    'Last Name': 'contact.lastName',
    Email: 'contact.email',
    Phone: 'contact.phone',
    'Job Title': 'contact.jobTitle',
  },
  COMPANY: { Name: 'company.name', Domain: 'company.domain', City: 'company.city' },
  DEAL: {
    'Deal Name': 'deal.name',
    Amount: 'deal.amount',
    'Close Date': 'deal.closeDate',
    Stage: 'deal.stage',
    Pipeline: 'deal.pipeline',
  },
  LEAD: { 'First Name': 'lead.firstName', 'Last Name': 'lead.lastName', Company: 'lead.company', Email: 'lead.email' },
};

const SEMANTIC_TYPE = {
  'contact.email': 'EMAIL',
  'lead.email': 'EMAIL',
  'contact.phone': 'PHONE',
  'deal.closeDate': 'DATE',
  'deal.amount': 'NUMBER',
};

const ID_PREFIX = { CONTACT: 'C', COMPANY: 'A', DEAL: 'D', LEAD: 'L' };
const FILE_NAME = { CONTACT: 'contacts', COMPANY: 'companies', DEAL: 'deals', LEAD: 'leads' };

const RELATIONSHIP_ENDS = {
  CONTACT_TO_COMPANY: { owner: 'CONTACT', target: 'COMPANY' },
  CONTACT_TO_DEAL: { owner: 'CONTACT', target: 'DEAL' },
  COMPANY_TO_DEAL: { owner: 'DEAL', target: 'COMPANY', ownerSide: 'TO' },
};

// ------------------------------------------------------------- the generator

/**
 * What a profile produces at a given rung, worked out before anything is
 * written. Everything the harness later checks comes from here.
 */
export function planOf(profile, rung) {
  const shape = profile.shape;

  // The two duplicate knobs write the same email column and mean different
  // things -- one collapses every row into a group sharing an address, the other
  // gives a small share of rows a twin -- so a profile that sets both would get
  // whichever branch is read first and a shape nobody declared. Refused here
  // rather than in the writing, because the plan is what the harness later
  // checks against and a plan computed for one of them is wrong about the other.
  if ((shape.duplicateSignalRate ?? 0) > 0 && (shape.duplicatePairRate ?? 0) > 0) {
    throw new Error(
      `profile ${String(profile.id)} sets duplicateSignalRate ${String(shape.duplicateSignalRate)} and duplicatePairRate ${String(shape.duplicatePairRate)}; the two describe the same column and only one of them can hold, so set one and remove the other`,
    );
  }

  // A giant cluster is rows proven to be one record by a shared id, and the
  // other merge knobs spread pairs through the file by stride. They write the
  // same id column, so a profile that set both would get a shape nobody declared.
  if ((shape.giantClusterShare ?? 0) > 0 && ((shape.provenMergeRate ?? 0) > 0 || (shape.duplicatePairRate ?? 0) > 0 || (shape.duplicateSignalRate ?? 0) > 0)) {
    throw new Error(
      `profile ${String(profile.id)} sets giantClusterShare together with a merge or duplicate rate; the giant cluster is the only merge such a profile has`,
    );
  }
  if ((shape.hotKeyShare ?? 0) > 0 && (shape.relationships ?? []).length === 0) {
    throw new Error(`profile ${String(profile.id)} sets hotKeyShare and declares no relationship for it to skew`);
  }

  const rows = Math.max(1, Math.round(rung * (shape.rowFactor ?? 1)));
  const objects = shape.objects;
  const counts = {};
  let assigned = 0;
  objects.forEach((object, index) => {
    const share = shape.share[object] ?? 0;
    const count = index === objects.length - 1 ? rows - assigned : Math.floor(rows * share);
    counts[object] = Math.max(1, count);
    assigned += counts[object];
  });

  const mappedSheets = shape.mappedSheets ?? 1;
  const hiddenSheets = shape.hiddenSheets ?? 0;
  const leftoverSheets = shape.leftoverSheets ?? 0;

  const columns = {};
  for (const object of objects) {
    columns[object] = BASE_COLUMNS[object].length + (shape.customFields ?? 0);
  }

  // Rows that never become records, because the reader rejects them.
  const blankRows = Math.floor((counts[objects[0]] ?? 0) * (shape.blankRowRate ?? 0));
  const shortRows = Math.floor((counts[objects[0]] ?? 0) * (shape.shortRowRate ?? 0));

  // One relationship per owning row, which is what the generator writes.
  let edges = 0;
  for (const relationship of shape.relationships ?? []) {
    const ends = RELATIONSHIP_ENDS[relationship];
    edges += counts[ends.owner] ?? 0;
  }

  // GIANT_CLUSTER: the first `giantClusterShare` of the first object's rows
  // are one record, every one of them repeating the first row's id. They are a
  // single proven merge of that many members, so all but the survivor are
  // absorbed -- worked out from the share and the count, not read from a run.
  const clusterRows = giantClusterRowsOf(counts[objects[0]] ?? 0, shape);
  const mergedRows = clusterRows > 0 ? clusterRows - 1 : null;
  const provenMerges = clusterRows > 0 ? 1 : null;

  // SKEWED_JOIN: the first `hotKeyShare` of each owning object's rows name the
  // first record of the target, and the rest are spread as they always were.
  // `hotEdges` is how many relationships end at that one record.
  let hotKey = null;
  if ((shape.hotKeyShare ?? 0) > 0) {
    const relationship = shape.relationships[0];
    const ends = RELATIONSHIP_ENDS[relationship];
    hotKey = {
      relationship,
      targetKeyRaw: `${ID_PREFIX[ends.target]}-0`,
      side: ends.ownerSide === 'TO' ? 'from' : 'to',
      edges: hotEdgesOf(counts[ends.owner] ?? 0, counts[ends.target] ?? 1, shape),
    };
  }

  return {
    rows,
    counts,
    columns,
    clusterRows,
    mergedRows,
    provenMerges,
    hotKey,
    mappedSheets,
    hiddenSheets,
    leftoverSheets,
    blankRows,
    shortRows,
    edges,
    // Every row the reader produces, including the ones it rejects and the ones
    // on sheets nothing maps.
    // Every row a reader produces: the mapped sheets, the hidden one (hidden is
    // not absent -- its rows are still accounted for), the rows the reader
    // rejects, and the sheets nothing maps.
    sourceRows:
      Object.values(counts).reduce((sum, count) => sum + count, 0) * mappedSheets +
      hiddenSheets * Math.min(counts[objects[0]] ?? 0, HIDDEN_SHEET_ROWS) +
      blankRows +
      shortRows +
      leftoverSheets * LEFTOVER_ROWS,
    files: shape.format === 'MIXED' ? objects.length : shape.format === 'XLSX' ? 1 : objects.length,
  };
}

/** The rows of the first object that belong to the giant cluster; 0 when the profile has none. */
function giantClusterRowsOf(firstObjectRows, shape) {
  const share = shape.giantClusterShare ?? 0;
  if (share <= 0) return 0;
  return Math.min(firstObjectRows, Math.max(2, Math.round(firstObjectRows * share)));
}

/** The owning rows that name the hot record: a share of the owner's rows, from the top. */
function hotRowsOf(ownerRows, shape) {
  const share = shape.hotKeyShare ?? 0;
  if (share <= 0) return 0;
  return Math.min(ownerRows, Math.max(1, Math.round(ownerRows * share)));
}

/**
 * The relationships that end at the hot record: the hot rows, plus every later
 * row whose index is a multiple of the target count, which the ordinary spread
 * sends to the first target too. Closed form, so the expected count is a
 * statement about the parameters.
 */
function hotEdgesOf(ownerRows, targetRows, shape) {
  const hot = hotRowsOf(ownerRows, shape);
  if (ownerRows === 0) return 0;
  const lastMultiple = Math.floor((ownerRows - 1) / targetRows);
  const multiplesBelowHot = hot === 0 ? 0 : Math.floor((hot - 1) / targetRows) + 1;
  return hot + (lastMultiple + 1 - multiplesBelowHot);
}

const LEFTOVER_ROWS = 8;

/** A hidden sheet is there to be accounted for, not to be large. */
const HIDDEN_SHEET_ROWS = 16;

/** Deterministic pseudo-random, so a profile is the same bundle every time. */
function mulberry(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CSV_ESCAPE = /[",\n\r]/;
function cell(value) {
  return CSV_ESCAPE.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Appends rows to an open descriptor in blocks, so no whole file is a string. */
function streamCsv(path, headers, count, row) {
  const handle = openSync(path, 'w');
  let bytes = 0;
  try {
    const header = `${headers.map(cell).join(',')}\n`;
    writeSync(handle, header);
    bytes += Buffer.byteLength(header);
    let block = [];
    for (let index = 0; index < count; index += 1) {
      const line = `${row(index).map(cell).join(',')}\n`;
      block.push(line);
      bytes += Buffer.byteLength(line);
      if (block.length === 4096) {
        writeSync(handle, block.join(''));
        block = [];
      }
    }
    if (block.length > 0) writeSync(handle, block.join(''));
  } finally {
    closeSync(handle);
  }
  return bytes;
}

const UNICODE = ['Ana', 'José', '山田', 'Ольга', 'Müller', 'Ådne', 'Zoë'];

function valueFor(kind, object, index, shape, random) {
  const categorical = shape.categoricalValues ?? 8;
  const unicode = shape.unicode === true;
  switch (kind) {
    case 'ID':
      return `${ID_PREFIX[object]}-${String(index)}`;
    case 'FIRST_NAME':
      return unicode ? `${UNICODE[index % UNICODE.length]}${String(index % 997)}` : `First${String(index % 997)}`;
    case 'LAST_NAME':
      return unicode ? `${UNICODE[(index + 3) % UNICODE.length]}${String(index % 991)}` : `Last${String(index % 991)}`;
    case 'NAME': {
      const name = `${object} ${String(index)}`;
      // A bundle whose values never need escaping exercises none of the reader's
      // escaping. Every eighth name carries a comma and an embedded quote, which
      // is what a company or deal name out of a real export looks like often
      // enough to matter, and which the writer has to double rather than emit.
      return shape.quotedValues === true && index % 8 === 0 ? `${name}, "Holdings" Ltd` : name;
    }
    case 'EMAIL':
      return `${object.toLowerCase()}${String(index)}@example.com`;
    case 'DOMAIN':
      return `company${String(index)}.example`;
    case 'PHONE':
      return `(${String(200 + (index % 700))}) 555-${String(2000 + (index % 8000)).padStart(4, '0')}`;
    case 'AMOUNT':
      return `${String(1000 + index)}.00`;
    case 'DATE':
      return `2026-0${String((index % 9) + 1)}-1${String(index % 10)}`;
    case 'CATEGORICAL':
      return `V-${String(index % categorical)}`;
    case 'TEXT': {
      const size = shape.maxTextBytes ?? 32;
      // A line break inside a quoted field is the case a line-oriented reader
      // gets wrong, and exported notes and addresses carry one routinely. Every
      // fifth long value is written across two lines, with a comma and a quote
      // in it as well. The marker comes out of the filler rather than being
      // added to it, so a value stays the size the profile declared wherever
      // maxTextBytes leaves room for it; below about forty bytes there is no
      // room and the marked value is the longer of the two.
      const marker = shape.quotedValues === true && index % 5 === 0 ? 'note, "as written"\nsecond line ' : '';
      // Long values are built once per row rather than per character.
      return `t${String(index)}-${marker}${'x'.repeat(Math.max(0, size - 12 - marker.length))}`;
    }
    default:
      return `${kind}-${String(index)}${random() > 2 ? '' : ''}`;
  }
}

function columnsFor(object, shape) {
  const custom = [];
  for (let index = 0; index < (shape.customFields ?? 0); index += 1) {
    custom.push({ header: `Custom ${String(index)}`, kind: index === 0 ? 'TEXT' : 'CATEGORICAL' });
  }
  return [...BASE_COLUMNS[object], ...custom];
}

/**
 * Writes one profile's bundle and the configuration that maps it.
 *
 * Returns what it declared it would write, not what it observed: the plan is
 * computed from the parameters and the writing follows it.
 */
export function generateProfile(profile, rung, outDir) {
  const shape = profile.shape;
  const plan = planOf(profile, rung);
  const inputDir = join(outDir, 'input');
  mkdirSync(inputDir, { recursive: true });
  const random = mulberry(0x9e3779b9);

  const files = [];
  const records = [];
  let bytes = 0;

  for (const object of shape.objects) {
    const columns = columnsFor(object, shape);
    const count = plan.counts[object];
    const name = FILE_NAME[object];
    const usesWorkbook = shape.format === 'XLSX' || (shape.format === 'MIXED' && object === 'COMPANY');

    // A relationship key column on the owning object.
    const owned = (shape.relationships ?? []).filter((relationship) => RELATIONSHIP_ENDS[relationship].owner === object);
    const keyColumns = owned.map((relationship) => ({
      header: `${RELATIONSHIP_ENDS[relationship].target} Ref`,
      target: RELATIONSHIP_ENDS[relationship].target,
      relationship,
    }));
    const headers = [...columns.map((column) => column.header), ...keyColumns.map((key) => key.header)];

    // The second row of a merge pair says the same things as the first, and
    // leaves one field blank. That is what makes the merge safe: the rows agree
    // wherever they both speak, so the survivor is delivered rather than set
    // aside for a conflict. Rows that disagree are what P4 is for.
    const mergeStride =
      (shape.provenMergeRate ?? 0) > 0 ? Math.max(2, Math.round(1 / (shape.provenMergeRate ?? 1))) : 0;

    // Rows of the giant cluster say exactly what the first row says, so that
    // every one of them is proven to be it and none is a conflict.
    const clusterSize = object === shape.objects[0] ? plan.clusterRows : 0;
    const hotRows = hotRowsOf(count, shape);

    const rowOf = (index) => {
      const absorbed = mergeStride > 0 && index % mergeStride === mergeStride - 1;
      const inCluster = index < clusterSize;
      const valueIndex = absorbed ? index - 1 : inCluster ? 0 : index;
      const values = columns.map((column, columnIndex) => {
        if (absorbed && columnIndex === columns.length - 1) return '';
        if (column.kind === 'ID' && (shape.sourceRecordIds ?? true) === false) return '';
        // Every other row repeats the previous row's id, which is what makes a
        // merge provable rather than guessed.
        if (column.kind === 'ID' && (mergeStride > 0 || inCluster)) return `${ID_PREFIX[object]}-${String(valueIndex)}`;
        if (column.kind === 'EMAIL' && (shape.duplicateSignalRate ?? 0) > 0) {
          const stride = Math.max(2, Math.round(1 / (shape.duplicateSignalRate ?? 1)));
          return `${object.toLowerCase()}${String(index - (index % stride))}@example.com`;
        }
        // The same signal at a density a real export has. duplicateSignalRate
        // above gives every row the group head's address, so every row is a
        // candidate for every other row in its group -- which is the point of
        // P4 and is not what a bundle looks like. This gives one row in `stride`
        // the address of the row before it and leaves the rest alone, so the
        // candidate density is two rows in `stride` rather than all of them.
        //
        // Taken from valueIndex rather than index so that the second row of a
        // proven-merge pair borrows exactly what the first one did. A merge
        // whose two rows disagreed about an email address would be a conflict,
        // and a conflict is a different thing from a duplicate candidate.
        if (column.kind === 'EMAIL' && (shape.duplicatePairRate ?? 0) > 0) {
          const stride = Math.max(2, Math.round(1 / (shape.duplicatePairRate ?? 1)));
          const twin = valueIndex % stride === stride - 1 ? valueIndex - 1 : valueIndex;
          return `${object.toLowerCase()}${String(twin)}@example.com`;
        }
        return valueFor(column.kind, object, valueIndex, shape, random);
      });
      const keys = keyColumns.map((key) =>
        `${ID_PREFIX[key.target]}-${String(index < hotRows ? 0 : index % Math.max(1, plan.counts[key.target] ?? 1))}`,
      );
      return [...values, ...keys];
    };

    if (usesWorkbook) {
      bytes += writeWorkbook(join(inputDir, `${name}.xlsx`), headers, count, rowOf, plan, shape);
      files.push({ id: name, path: `${name}.xlsx`, format: 'XLSX' });
    } else {
      const path = join(inputDir, `${name}.csv`);
      bytes += streamCsv(path, headers, count, rowOf);
      if (object === shape.objects[0] && (plan.blankRows > 0 || plan.shortRows > 0)) {
        bytes += appendExceptions(path, headers.length, plan);
      }
      files.push({ id: name, path: `${name}.csv`, format: 'CSV' });
    }

    // A workbook of several sheets is several record mappings, one per sheet:
    // a mapping that names no sheet is only meaningful where there is one.
    const sheetNames =
      usesWorkbook && plan.mappedSheets > 1
        ? Array.from({ length: plan.mappedSheets }, (_unused, index) => `Sheet${String(index + 1)}`)
        : [null];
    for (const sheetName of sheetNames) {
    records.push({
      id: sheetName === null ? name : `${name}-${sheetName.toLowerCase()}`,
      fileId: name,
      ...(sheetName === null ? {} : { sheet: sheetName }),
      object,
      sourceRecordIdColumn: (shape.sourceRecordIds ?? true) === false ? null : { header: columns[0].header },
      fields: columns
        .filter((column) => column.kind !== 'ID')
        // A destination that does not document a column for a canonical field
        // cannot be asked to import it, and a profile that asked would be
        // testing the refusal rather than the capacity.
        .filter((column) => {
          const destinationField = DESTINATION_FIELD[object][column.header];
          if (destinationField === undefined) return true;
          const spec = objectSpec(getAdapter(profile.mode), object);
          if (spec === null) return false;
          return spec.fields.some((entry) => entry.canonicalField === destinationField);
        })
        .map((column) => {
          const destinationField =
            DESTINATION_FIELD[object][column.header] ?? `custom:${column.header.split(' ').join('')}`;
          return {
            column: { header: column.header },
            destinationField,
            semanticType: SEMANTIC_TYPE[destinationField] ?? 'TEXT',
            ...(SEMANTIC_TYPE[destinationField] === 'PHONE' ? { options: { phoneCountry: 'US' } } : {}),
          };
        }),
    });
    }
  }

  const associations = (shape.relationships ?? []).map((relationship) => {
    const ends = RELATIONSHIP_ENDS[relationship];
    return {
      id: relationship.toLowerCase(),
      kind: 'COLUMN_REFERENCE',
      recordMappingId: FILE_NAME[ends.owner],
      relationshipType: relationship,
      ...(ends.ownerSide === undefined ? {} : { ownerSide: ends.ownerSide }),
      keyColumn: { header: `${ends.target} Ref` },
      targetRecordMappingId: FILE_NAME[ends.target],
      targetMatchKey: 'SOURCE_RECORD_ID',
    };
  });

  const config = {
    configVersion: '3.0.0',
    source: { system: 'capacity', namespace: profile.id.toLowerCase() },
    target: { mode: profile.mode, importMode: 'CREATE_ONLY' },
    // The ladder runs above the shipped defaults on purpose: the defaults cap a
    // sheet at 250,000 rows, which would refuse the top rungs before memory was
    // ever the question.
    limits: {
      maxFiles: 50,
      maxBytesPerFile: 4_294_967_296,
      maxTotalBytes: 17_179_869_184,
      maxSheetsPerFile: 25,
      maxRowsPerSheet: 2_000_000,
      maxColumnsPerSheet: 1_000,
      maxCellLength: 65_536,
      maxWorkbookUncompressedBytes: 1_073_741_824,
      // A workbook of this ladder is one big sheet, so the part is as large as the
      // workbook. The record limit is the shipped default: the widest record the
      // corpus writes is 8,250 bytes (P8), so the default clears it 127 times over.
      maxWorkbookPartUncompressedBytes: 1_073_741_824,
      maxRecordBytes: 1_048_576,
    },
    files,
    records,
    associations,
  };
  const configPath = join(outDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  return { plan, inputDir, configPath, sourceBytes: bytes };
}

/**
 * The rows a reader must account for and no mapping covers: blank rows, and
 * rows with fewer fields than the header declares.
 */
function appendExceptions(path, width, plan) {
  let text = '';
  for (let index = 0; index < plan.blankRows; index += 1) text += `${','.repeat(width - 1)}\n`;
  for (let index = 0; index < plan.shortRows; index += 1) text += `short-${String(index)}\n`;
  if (text.length === 0) return 0;
  appendFileSync(path, text);
  return Buffer.byteLength(text);
}

// ------------------------------------------------------------------- XLSX

/**
 * A workbook of several sheets, written from strings rather than a library.
 *
 * Only what the reader needs: inline strings, a sheet per mapped sheet, one
 * hidden sheet and one sheet nothing maps. Anything richer would be testing a
 * writer nobody ships.
 */
function writeWorkbook(path, headers, count, rowOf, plan, shape) {
  const sheets = [];
  for (let index = 0; index < plan.mappedSheets; index += 1) {
    sheets.push({ name: `Sheet${String(index + 1)}`, hidden: false, headers, count, rowOf });
  }
  for (let index = 0; index < plan.hiddenSheets; index += 1) {
    sheets.push({ name: `Hidden${String(index + 1)}`, hidden: true, headers, count: Math.min(count, HIDDEN_SHEET_ROWS), rowOf });
  }
  for (let index = 0; index < plan.leftoverSheets; index += 1) {
    sheets.push({
      name: `Leftover${String(index + 1)}`,
      hidden: false,
      headers: ['Note'],
      count: LEFTOVER_ROWS,
      rowOf: (row) => [`leftover ${String(row)}`],
    });
  }

  const files = {
    '[Content_Types].xml': strToU8(contentTypes(sheets.length)),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(workbookXml(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels(sheets.length)),
    'xl/styles.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>',
    ),
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${String(index + 1)}.xml`] = strToU8(sheetXml(sheet));
  });

  const zipped = zipSync(files, { level: 0 });
  writeFileSync(path, zipped);
  void shape;
  return zipped.length;
}

function contentTypes(sheetCount) {
  const overrides = Array.from(
    { length: sheetCount },
    (_unused, index) =>
      `<Override PartName="/xl/worksheets/sheet${String(index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    overrides +
    '</Types>'
  );
}

function workbookXml(sheets) {
  const entries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"${sheet.hidden ? ' state="hidden"' : ''}/>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${entries}</sheets></workbook>`
  );
}

function workbookRels(sheetCount) {
  const entries = Array.from(
    { length: sheetCount },
    (_unused, index) =>
      `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`,
  ).join('');
  const styles = `<Relationship Id="rId${String(sheetCount + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    entries +
    styles +
    '</Relationships>'
  );
}

function sheetXml(sheet) {
  const rows = [];
  rows.push(rowXml(1, sheet.headers));
  for (let index = 0; index < sheet.count; index += 1) {
    rows.push(rowXml(index + 2, sheet.rowOf(index).map((value) => String(value))));
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

function rowXml(rowNumber, values) {
  const cells = values
    .map((value, index) =>
      value === ''
        ? ''
        : `<c r="${columnName(index)}${String(rowNumber)}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`,
    )
    .join('');
  return `<row r="${String(rowNumber)}">${cells}</row>`;
}

function columnName(index) {
  let name = '';
  let current = index;
  for (;;) {
    name = String.fromCharCode(65 + (current % 26)) + name;
    current = Math.floor(current / 26) - 1;
    if (current < 0) break;
  }
  return name;
}

function escapeXml(value) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}
