#!/usr/bin/env node
// Writes the golden and adversarial fixture inputs.
//
// The generated files are committed. This script exists so the bytes are
// reproducible and so a reviewer can see the intent of each case in one place.
// It never writes an expected result: those are hand-authored in
// test/fixtures/*/expected/case.json and must be committed before the engine is
// run against them.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const goldenRoot = join(repoRoot, 'test', 'fixtures', 'golden');
const adversarialRoot = join(repoRoot, 'test', 'fixtures', 'adversarial');

function write(root, caseId, relativePath, contents) {
  const target = join(root, caseId, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents);
}

/** CSV text with LF endings and a trailing newline. Fields are written verbatim. */
function csv(rows) {
  return `${rows.map((row) => row.join(',')).join('\n')}\n`;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------- config helpers

const col = (header, occurrence) =>
  occurrence === undefined ? { header } : { header, occurrence };

const field = (header, destinationField, semanticType, extra) => ({
  column: col(header),
  destinationField,
  semanticType,
  ...(extra ?? {}),
});

function config({ namespace, mode = 'CLEAN_ONLY', importMode = 'CREATE_ONLY', ...rest }) {
  return {
    configVersion: '3.0.0',
    source: { system: 'generic_csv', namespace },
    target: { mode, importMode },
    ...rest,
  };
}

// ------------------------------------------------------------ XLSX builder

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

// Style index 1 uses built-in number format 14 (a short date). Index 0 is General.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`;

// Fixed archive timestamp (2020-01-01T00:00:00Z) so workbook bytes are reproducible.
const FIXED_MTIME = 1577836800000;

function escapeXml(value) {
  return value
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;')
    .split('"')
    .join('&quot;');
}

function columnLetters(index) {
  let name = '';
  let remaining = index + 1;
  while (remaining > 0) {
    const rest = (remaining - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

/**
 * Cell descriptors: {text}, {number, style?}, or {formula, cached, kind}.
 * A `null` cell is omitted entirely, which is how a sparse sheet is written.
 */
function buildWorkbook(sheetName, rows, { hidden = false, extraParts = {}, workbookRelationships = '', afterSheetData = '' } = {}) {
  const xmlRows = rows
    .map((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const xmlCells = cells
        .map((cell, columnIndex) => {
          if (cell === null || cell === undefined) return '';
          const reference = `${columnLetters(columnIndex)}${rowNumber}`;
          if (cell.formula !== undefined) {
            const type = cell.kind === 'number' ? '' : ' t="str"';
            // `cached: undefined` is a workbook that was never calculated: a formula and no <v> at all.
            const cache = cell.cached === undefined ? '' : `<v>${escapeXml(String(cell.cached))}</v>`;
            return `<c r="${reference}"${type}><f>${escapeXml(cell.formula)}</f>${cache}</c>`;
          }
          if (cell.number !== undefined) {
            const style = cell.style === undefined ? '' : ` s="${String(cell.style)}"`;
            return `<c r="${reference}"${style}><v>${String(cell.number)}</v></c>`;
          }
          if (cell.error !== undefined) {
            return `<c r="${reference}" t="e"><v>${escapeXml(cell.error)}</v></c>`;
          }
          return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${String(rowNumber)}">${xmlCells}</row>`;
    })
    .join('');

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${afterSheetData === '' ? '' : ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'}><sheetData>${xmlRows}</sheetData>${afterSheetData}</worksheet>`;

  const state = hidden ? ' state="hidden"' : '';
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1"${state} r:id="rId1"/></sheets></workbook>`;

  const files = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'xl/workbook.xml': strToU8(workbookXml),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRelationships === '' ? WORKBOOK_RELS : WORKBOOK_RELS.replace('</Relationships>', `${workbookRelationships}</Relationships>`)),
    'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
  };
  for (const [name, text] of Object.entries(extraParts)) files[name] = strToU8(text);

  // A fixed modification time keeps the archive bytes reproducible.
  const withMtime = {};
  for (const [name, data] of Object.entries(files)) withMtime[name] = [data, { mtime: FIXED_MTIME }];
  return Buffer.from(zipSync(withMtime, { level: 0 }));
}

// ------------------------------------------------------------ golden cases

const CONTACT_ID = { header: 'Contact ID' };

function contactsConfig(namespace, fields, extra) {
  return config({
    namespace,
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: CONTACT_ID,
        fields,
      },
    ],
    ...(extra ?? {}),
  });
}

const cases = {};

// G01 - clean contacts. Nothing to change, nothing to flag.
cases.G01 = () => {
  write(goldenRoot, 'G01-clean-contacts', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Phone'],
    ['1', 'Ada', 'Lovelace', 'ada@example.com', '+12125550147'],
    ['2', 'Alan', 'Turing', 'alan@example.org', '+442079460958'],
    ['3', 'Grace', 'Hopper', 'grace@example.net', '+14155552671'],
    ['4', 'Katherine', 'Johnson', 'katherine@example.com', '+573001234567'],
    ['5', 'Mary', 'Jackson', 'mary@example.org', '+34612345678'],
    ['6', 'Dorothy', 'Vaughan', 'dorothy@example.net', '+61293744000'],
  ]));
  write(goldenRoot, 'G01-clean-contacts', 'config.json', json(contactsConfig('g01-clean', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
    field('Phone', 'contact.phone', 'PHONE'),
  ])));
};

// G02 - safe formatting only: whitespace, email domain case, phone form, declared dates, extension split.
cases.G02 = () => {
  write(goldenRoot, 'G02-safe-formatting', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Signed Up'],
    ['1', '  Grace  ', 'Hopper', 'GRACE@Example.COM', '+1 (212) 555-0147', '03/04/2026'],
    ['2', 'Katherine', ' Johnson', 'katherine@example.com', '415-555-2671 ext. 44', '07/04/2025'],
    ['3', 'Mary', 'Jackson', 'mary@Example.com', '+44 20 7946 0958', '12/25/2025'],
    ['4', 'Dorothy', 'Vaughan', 'dorothy@example.net', '+34612345678', '01/02/2026'],
  ]));
  write(goldenRoot, 'G02-safe-formatting', 'config.json', json(contactsConfig('g02-formatting', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
    field('Phone', 'contact.phone', 'PHONE', {
      options: { phoneCountry: 'US', extensionDestinationField: 'contact.phoneExtension' },
    }),
    field('Signed Up', 'contact.createdAt', 'DATE', { options: { dateFormat: 'MM/DD/YYYY' } }),
  ])));
};

// G03 - Colombian numbers, with and without country evidence on the row.
cases.G03 = () => {
  write(goldenRoot, 'G03-colombian-phones', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Country', 'Phone'],
    ['1', 'Sofia', 'Restrepo', 'CO', '+57 300 1234567'],
    ['2', 'Mateo', 'Gomez', 'CO', '3011234567'],
    ['3', 'Valentina', 'Ruiz', '', '3021234567'],
    ['4', 'Santiago', 'Diaz', 'CO', '30012'],
  ]));
  write(goldenRoot, 'G03-colombian-phones', 'config.json', json(contactsConfig('g03-colombia', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Phone', 'contact.phone', 'PHONE', { options: { phoneCountryColumn: col('Country') } }),
  ])));
};

// G04 - four countries in one file. An explicit prefix always outranks the row's country column.
cases.G04 = () => {
  write(goldenRoot, 'G04-mixed-country-phones', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Country', 'Phone'],
    ['1', 'Sofia', 'Restrepo', '', '+57 300 1234567'],
    ['2', 'Lucia', 'Fernandez', '', '+34 612 345 678'],
    ['3', 'Oliver', 'Bennett', 'US', '+44 20 7946 0958'],
    ['4', 'Grace', 'Hopper', 'US', '(415) 555-2671'],
    ['5', 'Valentina', 'Ruiz', '', '3021234567'],
    ['6', 'Mateo', 'Gomez', 'CO', '301 123 4567'],
  ]));
  write(goldenRoot, 'G04-mixed-country-phones', 'config.json', json(contactsConfig('g04-mixed', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Phone', 'contact.phone', 'PHONE', { options: { phoneCountryColumn: col('Country') } }),
  ])));
};

// G05 - ambiguous dates. The configuration asks for such rows to be set aside.
cases.G05 = () => {
  write(goldenRoot, 'G05-ambiguous-dates', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Signed Up'],
    ['1', 'Ada', 'Lovelace', '2026-03-04'],
    ['2', 'Alan', 'Turing', '03/04/2026'],
    ['3', 'Grace', 'Hopper', '13/04/2026'],
    ['4', 'Katherine', 'Johnson', '2026-02-30'],
  ]));
  write(goldenRoot, 'G05-ambiguous-dates', 'config.json', json(contactsConfig('g05-dates', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Signed Up', 'contact.createdAt', 'DATE', { onAmbiguous: 'ISOLATE_ROW', onInvalid: 'PRESERVE' }),
  ])));
};

// G06 - two different people share an email address, against a destination that matches on it.
cases.G06 = () => {
  write(goldenRoot, 'G06-false-email-duplicates', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Phone'],
    ['1', 'Ada', 'Lovelace', 'shared@example.com', '+12125550147'],
    ['2', 'Alan', 'Turing', 'shared@example.com', '+442079460958'],
    ['3', 'Grace', 'Hopper', 'grace@example.net', '+14155552671'],
    ['4', 'Mary', 'Jackson', 'mary@example.org', '+34612345678'],
  ]));
  write(goldenRoot, 'G06-false-email-duplicates', 'config.json', json(contactsConfig('g06-false-dupes', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
    field('Phone', 'contact.phone', 'PHONE'),
  ], { target: { mode: 'HUBSPOT', importMode: 'CREATE_ONLY' } })));
};

// G07 - one record represented by two rows carrying the same source record id.
cases.G07 = () => {
  write(goldenRoot, 'G07-proven-duplicate', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Phone'],
    ['1', 'Ada', 'Lovelace', 'ada@example.com', ''],
    ['1', 'Ada', 'Lovelace', '', '+12125550147'],
    ['2', 'Alan', 'Turing', 'alan@example.org', '+442079460958'],
  ]));
  write(goldenRoot, 'G07-proven-duplicate', 'config.json', json(contactsConfig('g07-proven', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
    field('Phone', 'contact.phone', 'PHONE'),
  ])));
};

// G08 - same source record id, disagreeing on populated fields.
cases.G08 = () => {
  write(goldenRoot, 'G08-conflicting-duplicate', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Job Title'],
    ['1', 'Ada', 'Lovelace', 'ada@example.com', 'Engineer'],
    ['1', 'Ada', 'Lovelace', 'ada.lovelace@example.com', 'Analyst'],
  ]));
  write(goldenRoot, 'G08-conflicting-duplicate', 'config.json', json(contactsConfig('g08-conflict', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
    field('Job Title', 'contact.jobTitle', 'TEXT'),
  ])));
};

// G09 - a shared mailbox used by three people.
cases.G09 = () => {
  write(goldenRoot, 'G09-shared-mailbox', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email'],
    ['1', 'Ada', 'Lovelace', 'info@company.example'],
    ['2', 'Alan', 'Turing', 'info@company.example'],
    ['3', 'Grace', 'Hopper', 'info@company.example'],
    ['4', 'Mary', 'Jackson', 'mary@company.example'],
  ]));
  write(goldenRoot, 'G09-shared-mailbox', 'config.json', json(contactsConfig('g09-mailbox', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
  ])));
};

// G10 - many blank email addresses. Blank is not a signal.
cases.G10 = () => {
  write(goldenRoot, 'G10-blank-emails', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email'],
    ['1', 'Ada', 'Lovelace', ''],
    ['2', 'Alan', 'Turing', ''],
    ['3', 'Grace', 'Hopper', ''],
    ['4', 'Katherine', 'Johnson', ''],
    ['5', 'Mary', 'Jackson', 'mary@example.org'],
  ]));
  write(goldenRoot, 'G10-blank-emails', 'config.json', json(contactsConfig('g10-blanks', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
  ])));
};

// G11 - contacts, companies and deals with correct relationships.
cases.G11 = () => {
  const id = 'G11-associations';
  write(goldenRoot, id, 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Company ID'],
    ['1', 'Ada', 'Lovelace', 'ada@example.com', 'C1'],
    ['2', 'Alan', 'Turing', 'alan@example.org', 'C2'],
    ['3', 'Grace', 'Hopper', 'grace@example.net', 'C1'],
  ]));
  write(goldenRoot, id, 'input/companies.csv', csv([
    ['Company ID', 'Name', 'Domain'],
    ['C1', 'Analytical Engines', 'analytical.example'],
    ['C2', 'Bletchley Works', 'bletchley.example'],
  ]));
  write(goldenRoot, id, 'input/deals.csv', csv([
    ['Deal ID', 'Deal Name', 'Company ID', 'Amount'],
    ['D1', 'Engine upgrade', 'C1', '12000.00'],
    ['D2', 'Cipher retainer', 'C2', '8000.00'],
  ]));
  write(goldenRoot, id, 'input/contact-deals.csv', csv([
    ['Contact ID', 'Deal ID'],
    ['1', 'D1'],
    ['3', 'D1'],
    ['2', 'D2'],
  ]));
  write(goldenRoot, id, 'config.json', json(config({
    namespace: 'g11-associations',
    files: [
      { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
      { id: 'companies', path: 'companies.csv', format: 'CSV' },
      { id: 'deals', path: 'deals.csv', format: 'CSV' },
      { id: 'contactdeals', path: 'contact-deals.csv', format: 'CSV' },
    ],
    records: [
      {
        id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
        fields: [
          field('First Name', 'contact.firstName', 'TEXT'),
          field('Last Name', 'contact.lastName', 'TEXT'),
          field('Email', 'contact.email', 'EMAIL'),
        ],
      },
      {
        id: 'companies', fileId: 'companies', object: 'COMPANY', sourceRecordIdColumn: col('Company ID'),
        fields: [field('Name', 'company.name', 'TEXT'), field('Domain', 'company.domain', 'TEXT')],
      },
      {
        id: 'deals', fileId: 'deals', object: 'DEAL', sourceRecordIdColumn: col('Deal ID'),
        fields: [
          field('Deal Name', 'deal.name', 'TEXT'),
          field('Amount', 'deal.amount', 'NUMBER', { options: { decimalSeparator: '.', thousandsSeparator: 'NONE' } }),
        ],
      },
    ],
    associations: [
      {
        id: 'contact-company', kind: 'COLUMN_REFERENCE', recordMappingId: 'contacts',
        relationshipType: 'CONTACT_TO_COMPANY', keyColumn: col('Company ID'),
        targetRecordMappingId: 'companies', targetMatchKey: 'SOURCE_RECORD_ID',
      },
      {
        id: 'company-deal', kind: 'COLUMN_REFERENCE', recordMappingId: 'deals',
        relationshipType: 'COMPANY_TO_DEAL', ownerSide: 'TO', keyColumn: col('Company ID'),
        targetRecordMappingId: 'companies', targetMatchKey: 'SOURCE_RECORD_ID',
      },
      {
        id: 'contact-deal', kind: 'EDGE_FILE', fileId: 'contactdeals',
        relationshipType: 'CONTACT_TO_DEAL',
        fromRecordMappingId: 'contacts', fromKeyColumn: CONTACT_ID,
        toRecordMappingId: 'deals', toKeyColumn: col('Deal ID'),
      },
    ],
  })));
};

// G12 - an edge that points at a record which does not exist.
cases.G12 = () => {
  const id = 'G12-missing-endpoint';
  write(goldenRoot, id, 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Company ID'],
    ['1', 'Ada', 'Lovelace', 'C1'],
    ['2', 'Alan', 'Turing', 'C9'],
  ]));
  write(goldenRoot, id, 'input/companies.csv', csv([
    ['Company ID', 'Name'],
    ['C1', 'Analytical Engines'],
  ]));
  write(goldenRoot, id, 'config.json', json(config({
    namespace: 'g12-missing',
    files: [
      { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
      { id: 'companies', path: 'companies.csv', format: 'CSV' },
    ],
    records: [
      {
        id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
        fields: [field('First Name', 'contact.firstName', 'TEXT'), field('Last Name', 'contact.lastName', 'TEXT')],
      },
      {
        id: 'companies', fileId: 'companies', object: 'COMPANY', sourceRecordIdColumn: col('Company ID'),
        fields: [field('Name', 'company.name', 'TEXT')],
      },
    ],
    associations: [
      {
        id: 'contact-company', kind: 'COLUMN_REFERENCE', recordMappingId: 'contacts',
        relationshipType: 'CONTACT_TO_COMPANY', keyColumn: col('Company ID'),
        targetRecordMappingId: 'companies', targetMatchKey: 'SOURCE_RECORD_ID',
      },
    ],
  })));
};

// G13 - a proven merge whose two rows both assert the same relationship.
cases.G13 = () => {
  const id = 'G13-merge-association-remap';
  write(goldenRoot, id, 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Company ID'],
    ['1', 'Ada', 'Lovelace', 'ada@example.com', 'C1'],
    ['1', 'Ada', 'Lovelace', '', 'C1'],
    ['2', 'Alan', 'Turing', 'alan@example.org', 'C1'],
  ]));
  write(goldenRoot, id, 'input/companies.csv', csv([
    ['Company ID', 'Name'],
    ['C1', 'Analytical Engines'],
  ]));
  write(goldenRoot, id, 'config.json', json(config({
    namespace: 'g13-remap',
    files: [
      { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
      { id: 'companies', path: 'companies.csv', format: 'CSV' },
    ],
    records: [
      {
        id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
        fields: [
          field('First Name', 'contact.firstName', 'TEXT'),
          field('Last Name', 'contact.lastName', 'TEXT'),
          field('Email', 'contact.email', 'EMAIL'),
        ],
      },
      {
        id: 'companies', fileId: 'companies', object: 'COMPANY', sourceRecordIdColumn: col('Company ID'),
        fields: [field('Name', 'company.name', 'TEXT')],
      },
    ],
    associations: [
      {
        id: 'contact-company', kind: 'COLUMN_REFERENCE', recordMappingId: 'contacts',
        relationshipType: 'CONTACT_TO_COMPANY', keyColumn: col('Company ID'),
        targetRecordMappingId: 'companies', targetMatchKey: 'SOURCE_RECORD_ID',
      },
    ],
  })));
};

// G14 - identifiers that a spreadsheet would silently turn into numbers.
cases.G14 = () => {
  write(goldenRoot, 'G14-identifiers', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Postal Code', 'Account Number'],
    ['0001', 'Ada', 'Lovelace', '01730', '00123456789012345678'],
    ['0002', 'Alan', 'Turing', '02139', '9007199254740993'],
    ['0003', 'Grace', 'Hopper', '00501', '0000000000000001'],
  ]));
  write(goldenRoot, 'G14-identifiers', 'config.json', json(contactsConfig('g14-identifiers', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Postal Code', 'contact.postalCode', 'IDENTIFIER'),
    field('Account Number', 'custom:Account Number', 'IDENTIFIER'),
  ])));
};

// G15 - Unicode round-trip.
cases.G15 = () => {
  write(goldenRoot, 'G15-unicode', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'City'],
    ['1', 'Núñez', "O'Brien", 'Bogotá'],
    ['2', 'François', 'Müller', 'Zürich'],
    ['3', '芳子', '山田', '東京'],
    ['4', 'Ægir', 'Þórsson', 'Reykjavík'],
  ]));
  write(goldenRoot, 'G15-unicode', 'config.json', json(contactsConfig('g15-unicode', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('City', 'contact.city', 'TEXT'),
  ])));
};

// G16 - hostile cell content. Every value must survive byte-exact.
cases.G16 = () => {
  const rows = [
    'Contact ID,First Name,Last Name,Notes',
    '1,Ada,Lovelace,"=SUM(A1:A9)"',
    '2,Alan,Turing,"He said ""hello"", then left"',
    '3,Grace,Hopper,"line one\nline two"',
    '4,Katherine,Johnson,"+1 is a country code, not a formula"',
    '5,Mary,Jackson,@channel',
    '6,Dorothy,Vaughan,-not-a-number',
  ];
  write(goldenRoot, 'G16-hostile-csv', 'input/contacts.csv', `${rows.join('\n')}\n`);
  write(goldenRoot, 'G16-hostile-csv', 'config.json', json(contactsConfig('g16-hostile', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Notes', 'contact.description', 'TEXT'),
  ])));
};

// G17 - two columns with the same header.
cases.G17 = () => {
  write(goldenRoot, 'G17-duplicate-headers', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Phone', 'Phone'],
    ['1', 'Ada', 'Lovelace', '+12125550147', '+14155552671'],
    ['2', 'Alan', 'Turing', '+442079460958', '+34612345678'],
  ]));
  write(goldenRoot, 'G17-duplicate-headers', 'config.json', json(contactsConfig('g17-duplicate-headers', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    { column: col('Phone', 1), destinationField: 'contact.phone', semanticType: 'PHONE' },
    { column: col('Phone', 2), destinationField: 'contact.mobilePhone', semanticType: 'PHONE' },
  ])));
};

// G41 - an empty header and two repeated headers. Three columns, three positions.
cases.G41 = () => {
  write(goldenRoot, 'G41-empty-and-repeated-headers', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', '', 'Phone', 'Phone'],
    ['1', 'Ada', 'Analyst', '+12125550147', '+14155552671'],
    ['2', 'Alan', 'Cryptanalyst', '+442079460958', '+34612345678'],
  ]));
  write(goldenRoot, 'G41-empty-and-repeated-headers', 'config.json', json(contactsConfig('g41-empty-and-repeated-headers', [
    field('First Name', 'contact.firstName', 'TEXT'),
    { column: { index: 2 }, destinationField: 'contact.description', semanticType: 'TEXT' },
    { column: col('Phone', 1), destinationField: 'contact.phone', semanticType: 'PHONE' },
    { column: col('Phone', 2), destinationField: 'contact.mobilePhone', semanticType: 'PHONE' },
  ])));
};

// G18 - a workbook carrying formulas and a date serial. Formulas are never evaluated.
cases.G18 = () => {
  const workbook = buildWorkbook('Contacts', [
    [
      { text: 'Contact ID' }, { text: 'First Name' }, { text: 'Last Name' },
      { text: 'Email' }, { text: 'Signed Up' }, { text: 'Display Name' },
    ],
    [
      { text: '1' }, { text: 'Ada' }, { text: 'Lovelace' }, { text: 'ada@example.com' },
      { number: 45001, style: 1 },
      { formula: 'CONCATENATE(B2," ",C2)', cached: 'Ada Lovelace', kind: 'text' },
    ],
    [
      { text: '2' }, { text: 'Alan' }, { text: 'Turing' }, { text: 'alan@example.org' },
      { number: 45002, style: 1 },
      { text: 'Alan Turing' },
    ],
  ]);
  write(goldenRoot, 'G18-xlsx-formulas', 'input/contacts.xlsx', workbook);
  write(goldenRoot, 'G18-xlsx-formulas', 'config.json', json(config({
    namespace: 'g18-formulas',
    files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
    records: [
      {
        id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
        fields: [
          field('First Name', 'contact.firstName', 'TEXT'),
          field('Last Name', 'contact.lastName', 'TEXT'),
          field('Email', 'contact.email', 'EMAIL'),
          field('Signed Up', 'contact.createdAt', 'DATE'),
          field('Display Name', 'custom:Display Name', 'TEXT'),
        ],
      },
    ],
  })));
};

// G19 - a full multi-object bundle, all four supported objects.
cases.G19 = () => {
  const id = 'G19-multi-file-bundle';
  write(goldenRoot, id, 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Company ID'],
    ['1', 'Ada', 'Lovelace', 'ada@example.com', 'C1'],
    ['2', 'Alan', 'Turing', 'alan@example.org', 'C2'],
  ]));
  write(goldenRoot, id, 'input/companies.csv', csv([
    ['Company ID', 'Name', 'Domain'],
    ['C1', 'Analytical Engines', 'analytical.example'],
    ['C2', 'Bletchley Works', 'bletchley.example'],
  ]));
  write(goldenRoot, id, 'input/deals.csv', csv([
    ['Deal ID', 'Deal Name', 'Company ID', 'Close Date'],
    ['D1', 'Engine upgrade', 'C1', '2026-06-30'],
    ['D2', 'Cipher retainer', 'C2', '2026-07-15'],
  ]));
  write(goldenRoot, id, 'input/leads.csv', csv([
    ['Lead ID', 'First Name', 'Last Name', 'Company', 'Email'],
    ['L1', 'Katherine', 'Johnson', 'Orbital Mechanics', 'ada@example.com'],
    ['L2', 'Dorothy', 'Vaughan', 'Computing Section', 'dorothy@example.net'],
  ]));
  write(goldenRoot, id, 'config.json', json(config({
    namespace: 'g19-bundle',
    files: [
      { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
      { id: 'companies', path: 'companies.csv', format: 'CSV' },
      { id: 'deals', path: 'deals.csv', format: 'CSV' },
      { id: 'leads', path: 'leads.csv', format: 'CSV' },
    ],
    records: [
      {
        id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
        fields: [
          field('First Name', 'contact.firstName', 'TEXT'),
          field('Last Name', 'contact.lastName', 'TEXT'),
          field('Email', 'contact.email', 'EMAIL'),
        ],
      },
      {
        id: 'companies', fileId: 'companies', object: 'COMPANY', sourceRecordIdColumn: col('Company ID'),
        fields: [field('Name', 'company.name', 'TEXT'), field('Domain', 'company.domain', 'TEXT')],
      },
      {
        id: 'deals', fileId: 'deals', object: 'DEAL', sourceRecordIdColumn: col('Deal ID'),
        fields: [field('Deal Name', 'deal.name', 'TEXT'), field('Close Date', 'deal.closeDate', 'DATE')],
      },
      {
        // L1 deliberately carries the same email address as contact 1. A lead
        // and a contact are different records, so this must not merge and must
        // not even be reported as a duplicate candidate across objects.
        id: 'leads', fileId: 'leads', object: 'LEAD',
        sourceRecordIdColumn: col('Lead ID'),
        fields: [
          field('First Name', 'lead.firstName', 'TEXT'),
          field('Last Name', 'lead.lastName', 'TEXT'),
          field('Company', 'lead.company', 'TEXT'),
          field('Email', 'lead.email', 'EMAIL'),
        ],
      },
    ],
    associations: [
      {
        id: 'contact-company', kind: 'COLUMN_REFERENCE', recordMappingId: 'contacts',
        relationshipType: 'CONTACT_TO_COMPANY', keyColumn: col('Company ID'),
        targetRecordMappingId: 'companies', targetMatchKey: 'SOURCE_RECORD_ID',
      },
      {
        id: 'company-deal', kind: 'COLUMN_REFERENCE', recordMappingId: 'deals',
        relationshipType: 'COMPANY_TO_DEAL', ownerSide: 'TO', keyColumn: col('Company ID'),
        targetRecordMappingId: 'companies', targetMatchKey: 'SOURCE_RECORD_ID',
      },
    ],
  })));
};

// G20 - custom and unmapped columns.
cases.G20 = () => {
  write(goldenRoot, 'G20-unmapped-fields', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Loyalty Tier', 'Legacy Segment', 'Internal Note'],
    ['1', 'Ada', 'Lovelace', 'Gold', 'SEG-A', 'imported from old system'],
    ['2', 'Alan', 'Turing', 'Silver', 'SEG-B', ''],
    ['3', 'Grace', 'Hopper', '', '', 'no segment recorded'],
  ]));
  write(goldenRoot, 'G20-unmapped-fields', 'config.json', json(contactsConfig('g20-unmapped', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Loyalty Tier', 'custom:Loyalty Tier', 'TEXT'),
  ])));
};

// G22 - two different people who happen to share a full name.
cases.G22 = () => {
  write(goldenRoot, 'G22-same-name-different-people', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email'],
    ['1', 'Ada', 'Lovelace', 'ada@example.com'],
    ['2', 'Ada', 'Lovelace', 'ada.lovelace@example.net'],
    ['3', 'Alan', 'Turing', 'alan@example.org'],
  ]));
  write(goldenRoot, 'G22-same-name-different-people', 'config.json', json(contactsConfig('g22-same-name', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
  ])));
};

// G23 - a record missing a field the destination requires to create it.
cases.G23 = () => {
  write(goldenRoot, 'G23-destination-required-field', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email'],
    ['1', 'Ada', 'Lovelace', 'ada@example.com'],
    ['2', 'Alan', 'Turing', ''],
    ['3', 'Grace', 'Hopper', 'grace@example.net'],
  ]));
  write(goldenRoot, 'G23-destination-required-field', 'config.json', json(contactsConfig('g23-required', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
  ], { target: { mode: 'HUBSPOT', importMode: 'CREATE_ONLY' } })));
};

// G24 - a record id spelled to look like an authoritative external-id key.
cases.G24 = () => {
  write(goldenRoot, 'G24-forged-external-id', 'input/contacts.csv', csv([
    ['Contact ID', 'SAP ID', 'First Name', 'Last Name', 'Email'],
    ['ext:SAP ID:900', '', 'Alice', 'Anderson', 'alice@alpha.example'],
    ['C-2', '900', 'Bob', 'Brown', 'bob@beta.example'],
  ]));
  write(goldenRoot, 'G24-forged-external-id', 'config.json', json(config({
    namespace: 'g24-forgery',
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: CONTACT_ID,
        authoritativeExternalIdColumns: [col('SAP ID')],
        fields: [
          field('First Name', 'contact.firstName', 'TEXT'),
          field('Last Name', 'contact.lastName', 'TEXT'),
          field('Email', 'contact.email', 'EMAIL'),
        ],
      },
    ],
  })));
};

// G25 - independent id sequences, and one export deliberately split in two.
cases.G25 = () => {
  const id = 'G25-identity-spaces';
  write(goldenRoot, id, 'input/contacts-a.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Phone'],
    ['1', 'Ada', 'Lovelace', 'ada@example.com', ''],
    ['2', 'Alan', 'Turing', 'alan@example.org', '+442079460958'],
  ]));
  write(goldenRoot, id, 'input/contacts-b.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Phone'],
    ['1', 'Ada', 'Lovelace', '', '+12125550147'],
  ]));
  write(goldenRoot, id, 'input/leads.csv', csv([
    ['Lead ID', 'First Name', 'Last Name', 'Email'],
    ['1', 'Grace', 'Hopper', 'grace@example.net'],
    ['2', 'Katherine', 'Johnson', 'katherine@example.com'],
  ]));
  const contactFields = [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
    field('Phone', 'contact.phone', 'PHONE'),
  ];
  write(goldenRoot, id, 'config.json', json(config({
    namespace: 'g25-spaces',
    files: [
      { id: 'contactsa', path: 'contacts-a.csv', format: 'CSV' },
      { id: 'contactsb', path: 'contacts-b.csv', format: 'CSV' },
      { id: 'leads', path: 'leads.csv', format: 'CSV' },
    ],
    records: [
      {
        id: 'contacts-a', fileId: 'contactsa', object: 'CONTACT',
        identitySpace: 'customer-export', sourceRecordIdColumn: CONTACT_ID, fields: contactFields,
      },
      {
        id: 'contacts-b', fileId: 'contactsb', object: 'CONTACT',
        identitySpace: 'customer-export', sourceRecordIdColumn: CONTACT_ID, fields: contactFields,
      },
      {
        id: 'leads', fileId: 'leads', object: 'CONTACT',
        sourceRecordIdColumn: col('Lead ID'),
        fields: [
          field('First Name', 'contact.firstName', 'TEXT'),
          field('Last Name', 'contact.lastName', 'TEXT'),
          field('Email', 'contact.email', 'EMAIL'),
        ],
      },
    ],
  })));
};

// G26 - a consent conflict inside a proven merge, carried in a custom field.
cases.G26 = () => {
  write(goldenRoot, 'G26-consent-conflict', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Do Not Email'],
    ['C-1', 'Ada', 'Lovelace', 'true'],
    ['C-1', 'Ada', 'Lovelace', 'false'],
  ]));
  write(goldenRoot, 'G26-consent-conflict', 'config.json', json(contactsConfig('g26-consent', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    { column: col('Do Not Email'), destinationField: 'custom:Do Not Email', semanticType: 'TEXT', semanticsClass: 'CONSENT' },
  ])));
};

// G27 - PREFER_SURVIVOR when the surviving row has nothing to prefer.
cases.G27 = () => {
  write(goldenRoot, 'G27-prefer-survivor-empty', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Job Title'],
    ['C-1', 'Ada', 'Lovelace', ''],
    ['C-1', 'Ada', 'Lovelace', 'VP Engineering'],
    ['C-1', 'Ada', 'Lovelace', 'Janitor'],
  ]));
  write(goldenRoot, 'G27-prefer-survivor-empty', 'config.json', json(contactsConfig('g27-prefer', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Job Title', 'contact.jobTitle', 'TEXT'),
  ], {
    policies: {
      mergeFieldConflict: 'PREFER_SURVIVOR',
      mergeFieldConflictJustification: 'The first file in this export is the authoritative extract; later files are incremental deltas.',
    },
  })));
};

// G28 - a boolean spelling the configuration does not recognise.
cases.G28 = () => {
  write(goldenRoot, 'G28-unrecognised-boolean', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Opted In'],
    ['C-1', 'Ada', 'Lovelace', 'ada@example.com', 'Y'],
    ['C-2', 'Alan', 'Turing', 'alan@example.org', 'N'],
    ['C-3', 'Grace', 'Hopper', 'grace@example.net', 'true'],
  ]));
  write(goldenRoot, 'G28-unrecognised-boolean', 'config.json', json(contactsConfig('g28-boolean', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
    field('Email', 'contact.email', 'EMAIL'),
    field('Opted In', 'custom:Opted In', 'BOOLEAN', {
      options: { trueValues: ['Y'], falseValues: ['N'] },
    }),
  ], { target: { mode: 'HUBSPOT', importMode: 'CREATE_ONLY' } })));
};

// G21 - the same raw record id in two source namespaces.
cases.G21 = () => {
  const id = 'G21-cross-namespace-ids';
  write(goldenRoot, id, 'input/crm-a.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email'],
    ['1001', 'Ada', 'Lovelace', 'ada@example.com'],
  ]));
  write(goldenRoot, id, 'input/crm-b.csv', csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email'],
    ['1001', 'Alan', 'Turing', 'alan@example.org'],
  ]));
  write(goldenRoot, id, 'config.json', json(config({
    namespace: 'g21-default',
    files: [
      { id: 'crma', path: 'crm-a.csv', format: 'CSV', sourceSystem: 'crm_a', sourceNamespace: 'acme-crm-a' },
      { id: 'crmb', path: 'crm-b.csv', format: 'CSV', sourceSystem: 'crm_b', sourceNamespace: 'acme-crm-b' },
    ],
    records: [
      {
        id: 'contacts-a', fileId: 'crma', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
        fields: [
          field('First Name', 'contact.firstName', 'TEXT'),
          field('Last Name', 'contact.lastName', 'TEXT'),
          field('Email', 'contact.email', 'EMAIL'),
        ],
      },
      {
        id: 'contacts-b', fileId: 'crmb', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
        fields: [
          field('First Name', 'contact.firstName', 'TEXT'),
          field('Last Name', 'contact.lastName', 'TEXT'),
          field('Email', 'contact.email', 'EMAIL'),
        ],
      },
    ],
  })));
};

// -------------------------------------------------------- adversarial cases

const adversarial = {};

adversarial.A01 = () => {
  write(adversarialRoot, 'A01-unterminated-quote', 'input/contacts.csv',
    'Contact ID,First Name,Last Name\n1,"Ada,Lovelace\n');
  write(adversarialRoot, 'A01-unterminated-quote', 'config.json', json(contactsConfig('adv-quote', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
  ])));
};

adversarial.A02 = () => {
  write(adversarialRoot, 'A02-invalid-utf8', 'input/contacts.csv',
    Buffer.concat([
      Buffer.from('Contact ID,First Name,Last Name\n1,Ada,', 'utf8'),
      Buffer.from([0xff, 0xfe, 0x41]),
      Buffer.from('\n', 'utf8'),
    ]));
  write(adversarialRoot, 'A02-invalid-utf8', 'config.json', json(contactsConfig('adv-utf8', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
  ])));
};

adversarial.A03 = () => {
  write(adversarialRoot, 'A03-ragged-rows', 'input/contacts.csv', csv([
    ['Contact ID', 'First Name', 'Last Name'],
    ['1', 'Ada', 'Lovelace'],
    ['2', 'Alan'],
    ['3', 'Grace', 'Hopper', 'extra'],
    ['4', 'Katherine', 'Johnson'],
  ]));
  write(adversarialRoot, 'A03-ragged-rows', 'config.json', json(contactsConfig('adv-ragged', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
  ])));
};

adversarial.A04 = () => {
  write(adversarialRoot, 'A04-blank-rows', 'input/contacts.csv',
    'Contact ID,First Name,Last Name\n1,Ada,Lovelace\n,,\n2,Alan,Turing\n');
  write(adversarialRoot, 'A04-blank-rows', 'config.json', json(contactsConfig('adv-blank', [
    field('First Name', 'contact.firstName', 'TEXT'),
    field('Last Name', 'contact.lastName', 'TEXT'),
  ])));
};

adversarial.A05 = () => {
  // A ZIP whose central directory is intact but whose content is not a workbook.
  const bytes = Buffer.from(
    zipSync({ 'not-a-workbook.txt': [strToU8('nothing to see here'), { mtime: FIXED_MTIME }] }, { level: 0 }),
  );
  write(adversarialRoot, 'A05-corrupt-workbook', 'input/contacts.xlsx', bytes);
  write(adversarialRoot, 'A05-corrupt-workbook', 'config.json', json(config({
    namespace: 'adv-corrupt',
    files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT')],
    }],
  })));
};

adversarial.A06 = () => {
  // An OLE compound-file header: an encrypted workbook or a legacy binary .xls.
  const bytes = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(512, 0x20),
  ]);
  write(adversarialRoot, 'A06-encrypted-workbook', 'input/contacts.xlsx', bytes);
  write(adversarialRoot, 'A06-encrypted-workbook', 'config.json', json(config({
    namespace: 'adv-encrypted',
    files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT')],
    }],
  })));
};

adversarial.A07 = () => {
  // A macro-enabled workbook, declared through both the content types and the part.
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Contact ID</t></is></c></row></sheetData></worksheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const bytes = Buffer.from(zipSync({
    '[Content_Types].xml': [strToU8(CONTENT_TYPES.replace('spreadsheetml.sheet.main+xml', 'ms-excel.sheet.macroEnabled.main+xml')), { mtime: FIXED_MTIME }],
    '_rels/.rels': [strToU8(ROOT_RELS), { mtime: FIXED_MTIME }],
    'xl/workbook.xml': [strToU8(workbookXml), { mtime: FIXED_MTIME }],
    'xl/_rels/workbook.xml.rels': [strToU8(WORKBOOK_RELS), { mtime: FIXED_MTIME }],
    'xl/styles.xml': [strToU8(STYLES), { mtime: FIXED_MTIME }],
    'xl/worksheets/sheet1.xml': [strToU8(sheetXml), { mtime: FIXED_MTIME }],
    'xl/vbaProject.bin': [strToU8('binary macro project'), { mtime: FIXED_MTIME }],
  }, { level: 0 }));
  write(adversarialRoot, 'A07-macro-workbook', 'input/contacts.xlsx', bytes);
  write(adversarialRoot, 'A07-macro-workbook', 'config.json', json(config({
    namespace: 'adv-macro',
    files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT')],
    }],
  })));
};

adversarial.A08 = () => {
  // A workbook whose XML declares an entity. Expansion attacks are refused outright.
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE worksheet [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const bytes = Buffer.from(zipSync({
    '[Content_Types].xml': [strToU8(CONTENT_TYPES), { mtime: FIXED_MTIME }],
    '_rels/.rels': [strToU8(ROOT_RELS), { mtime: FIXED_MTIME }],
    'xl/workbook.xml': [strToU8(workbookXml), { mtime: FIXED_MTIME }],
    'xl/_rels/workbook.xml.rels': [strToU8(WORKBOOK_RELS), { mtime: FIXED_MTIME }],
    'xl/styles.xml': [strToU8(STYLES), { mtime: FIXED_MTIME }],
    'xl/worksheets/sheet1.xml': [strToU8(sheetXml), { mtime: FIXED_MTIME }],
  }, { level: 0 }));
  write(adversarialRoot, 'A08-entity-expansion', 'input/contacts.xlsx', bytes);
  write(adversarialRoot, 'A08-entity-expansion', 'config.json', json(config({
    namespace: 'adv-entity',
    files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT')],
    }],
  })));
};

adversarial.A09 = () => {
  const contacts = csv([
    ['Contact ID', 'First Name', 'Last Name'],
    ['1', 'Ada', 'Lovelace'],
  ]);
  write(adversarialRoot, 'A09-duplicate-file', 'input/contacts.csv', contacts);
  write(adversarialRoot, 'A09-duplicate-file', 'input/contacts-copy.csv', contacts);
  write(adversarialRoot, 'A09-duplicate-file', 'config.json', json(config({
    namespace: 'adv-duplicate-file',
    files: [
      { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
      { id: 'copy', path: 'contacts-copy.csv', format: 'CSV' },
    ],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT')],
    }],
  })));
};

adversarial.A13 = () => {
  // The same export taken from two instances. The bytes are equal; the occurrences are not.
  const contacts = csv([
    ['Contact ID', 'First Name', 'Last Name'],
    ['1', 'Ada', 'Lovelace'],
  ]);
  write(adversarialRoot, 'A13-equal-occurrences', 'input/contacts.csv', contacts);
  write(adversarialRoot, 'A13-equal-occurrences', 'input/contacts-copy.csv', contacts);
  const mapping = (id, fileId) => ({
    id, fileId, object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
    fields: [field('First Name', 'contact.firstName', 'TEXT')],
  });
  write(adversarialRoot, 'A13-equal-occurrences', 'config.json', json(config({
    namespace: 'adv-equal-occurrences',
    files: [
      { id: 'contacts', path: 'contacts.csv', format: 'CSV', sourceNamespace: 'instance-A' },
      { id: 'copy', path: 'contacts-copy.csv', format: 'CSV', sourceNamespace: 'instance-B' },
    ],
    records: [mapping('contacts', 'contacts'), mapping('copy', 'copy')],
  })));
};

adversarial.A14 = () => {
  // A workbook that names a URL, a UNC share and local files in every place a
  // workbook can name one. Nothing it names may be opened.
  const external = (id, type, target) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${escapeXml(target)}" TargetMode="External"/>`;
  const rels = (items) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
  const bytes = buildWorkbook('Contacts', [
    [{ text: 'Contact ID' }, { text: 'First Name' }, { text: 'Site' }],
    [{ text: '1' }, { text: 'Ada' }, { formula: "HYPERLINK(\"http://kauro-a14.invalid/site\",\"site\")", cached: 'site', kind: 'text' }],
    [{ text: '2' }, { text: 'Alan' }, { formula: "'[1]Sheet1'!A1", cached: 'Alan', kind: 'text' }],
  ], {
    workbookRelationships:
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/>' +
      external('rId4', 'hyperlink', 'https://kauro-a14.invalid/workbook'),
    afterSheetData: '<hyperlinks><hyperlink ref="C2" r:id="rId1"/><hyperlink ref="C3" r:id="rId2"/></hyperlinks>',
    extraParts: {
      'xl/externalLinks/externalLink1.xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="rId1"><sheetNames><sheetName val="Sheet1"/></sheetNames></externalBook></externalLink>',
      'xl/externalLinks/_rels/externalLink1.xml.rels': rels([
        external('rId1', 'externalLinkPath', 'file:///C:/kauro-a14-canary.xlsx'),
        external('rId2', 'externalLinkPath', '\\\\kauro-a14.invalid\\share\\canary.xlsx'),
        external('rId3', 'externalLinkPath', 'file:///etc/kauro-a14-canary'),
        external('rId4', 'externalLinkPath', 'http://kauro-a14.invalid/canary.xlsx'),
      ]),
      'xl/worksheets/_rels/sheet1.xml.rels': rels([
        external('rId1', 'hyperlink', 'http://kauro-a14.invalid/site'),
        external('rId2', 'hyperlink', '\\\\kauro-a14.invalid\\share\\page.html'),
      ]),
    },
  });
  write(adversarialRoot, 'A14-external-resources', 'input/contacts.xlsx', bytes);
  write(adversarialRoot, 'A14-external-resources', 'config.json', json(config({
    namespace: 'adv-external-resources',
    files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT')],
    }],
  })));
};

adversarial.A10 = () => {
  write(adversarialRoot, 'A10-giant-cell', 'input/contacts.csv',
    `Contact ID,First Name,Last Name\n1,${'A'.repeat(5000)},Lovelace\n`);
  write(adversarialRoot, 'A10-giant-cell', 'config.json', json(config({
    namespace: 'adv-giant',
    limits: { maxCellLength: 1000 },
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT')],
    }],
  })));
};

adversarial.A11 = () => {
  write(adversarialRoot, 'A11-hidden-sheet', 'input/contacts.xlsx', buildWorkbook('Contacts', [
    [{ text: 'Contact ID' }, { text: 'First Name' }, { text: 'Last Name' }],
    [{ text: '1' }, { text: 'Ada' }, { text: 'Lovelace' }],
  ], { hidden: true }));
  write(adversarialRoot, 'A11-hidden-sheet', 'config.json', json(config({
    namespace: 'adv-hidden',
    files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT'), field('Last Name', 'contact.lastName', 'TEXT')],
    }],
  })));
};

adversarial.A12 = () => {
  write(adversarialRoot, 'A12-spreadsheet-error-cell', 'input/contacts.xlsx', buildWorkbook('Contacts', [
    [{ text: 'Contact ID' }, { text: 'First Name' }, { text: 'Last Name' }],
    [{ text: '1' }, { text: 'Ada' }, { error: '#REF!' }],
    [{ text: '2' }, { text: 'Alan' }, { text: 'Turing' }],
  ]));
  write(adversarialRoot, 'A12-spreadsheet-error-cell', 'config.json', json(config({
    namespace: 'adv-error-cell',
    files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT'), field('Last Name', 'contact.lastName', 'TEXT')],
    }],
  })));
};

adversarial.A15 = () => {
  write(adversarialRoot, 'A15-formula-without-cache', 'input/contacts.xlsx', buildWorkbook('Contacts', [
    [{ text: 'Contact ID' }, { text: 'First Name' }, { text: 'Last Name' }],
    [{ text: '1' }, { text: 'Ada' }, { formula: 'UPPER("lovelace")', kind: 'text' }],
    [{ text: '2' }, { text: 'Alan' }, { text: 'Turing' }],
  ]));
  write(adversarialRoot, 'A15-formula-without-cache', 'config.json', json(config({
    namespace: 'adv-formula-no-cache',
    policies: { formulaCachedValues: 'ACCEPT_WITH_PROVENANCE' },
    files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
    records: [{
      id: 'contacts', fileId: 'contacts', object: 'CONTACT', sourceRecordIdColumn: CONTACT_ID,
      fields: [field('First Name', 'contact.firstName', 'TEXT'), field('Last Name', 'contact.lastName', 'TEXT')],
    }],
  })));
};

// ------------------------------------------------------------------- write

// Only generated inputs and configurations are replaced. Hand-authored
// expectations under expected/ are never touched by this script, and neither
// is a case this script does not define: several cases were written by hand and
// wiping them here would silently delete corpus this file cannot rebuild.
function clearGenerated(root, owned) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!owned.some((id) => entry.name === id || entry.name.startsWith(`${id}-`))) continue;
    rmSync(join(root, entry.name, 'input'), { recursive: true, force: true });
    rmSync(join(root, entry.name, 'config.json'), { force: true });
  }
}
mkdirSync(goldenRoot, { recursive: true });
mkdirSync(adversarialRoot, { recursive: true });
const goldenIds = Object.keys(cases).sort();
const adversarialIds = Object.keys(adversarial).sort();
clearGenerated(goldenRoot, goldenIds);
clearGenerated(adversarialRoot, adversarialIds);

for (const id of goldenIds) cases[id]();
for (const id of adversarialIds) adversarial[id]();

process.stdout.write(
  `wrote ${goldenIds.length} golden fixture inputs and ${adversarialIds.length} adversarial fixture inputs\n`,
);
