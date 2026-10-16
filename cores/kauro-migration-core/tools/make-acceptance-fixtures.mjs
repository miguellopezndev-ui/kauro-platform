#!/usr/bin/env node
// Writes the acceptance corpus inputs and configurations.
//
// Three scenario packages exercise the contract end to end, and two
// destination packages run one shared source bundle through each CRM adapter so
// the differences between them are visible side by side. Outputs are generated
// by tools/build-acceptance-packages.ts and committed.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'test', 'fixtures', 'acceptance');

function write(caseId, relativePath, contents) {
  const target = join(root, caseId, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(contents, 'utf8'));
}

const csv = (rows) => `${rows.map((row) => row.join(',')).join('\n')}\n`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const col = (header) => ({ header });
const field = (header, destinationField, semanticType, extra) => ({
  column: col(header),
  destinationField,
  semanticType,
  ...(extra ?? {}),
});

// ------------------------------------------------------- shared source data

const CONTACTS = [
  ['Contact ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Country', 'Job Title', 'Company ID'],
  ['C-1', 'Ada', 'Lovelace', 'ada@analytical.example', '+1 212 555 0147', 'US', 'Chief Engineer', 'A-1'],
  ['C-2', 'Alan', 'Turing', 'alan@bletchley.example', '+44 20 7946 0958', 'GB', 'Cryptanalyst', 'A-2'],
  ['C-3', 'Sofia', 'Restrepo', 'sofia@andina.example', '3001234567', 'CO', 'Head of Sales', 'A-3'],
  ['C-4', 'Grace', 'Hopper', 'grace@analytical.example', '(415) 555-2671', 'US', 'Compiler Lead', 'A-1'],
  ['C-5', 'Lucia', 'Fernandez', 'lucia@iberia.example', '+34 612 345 678', 'ES', 'Account Director', 'A-4'],
];

const COMPANIES = [
  ['Company ID', 'Name', 'Domain', 'City', 'Country', 'Employees'],
  ['A-1', 'Analytical Engines', 'analytical.example', 'London', 'United Kingdom', '120'],
  ['A-2', 'Bletchley Works', 'bletchley.example', 'Milton Keynes', 'United Kingdom', '45'],
  ['A-3', 'Andina Software', 'andina.example', 'Bogotá', 'Colombia', '310'],
  ['A-4', 'Iberia Retail', 'iberia.example', 'Madrid', 'Spain', '900'],
];

const DEALS = [
  ['Deal ID', 'Deal Name', 'Company ID', 'Amount', 'Close Date', 'Stage', 'Pipeline'],
  ['D-1', 'Engine upgrade', 'A-1', '120000.00', '2026-06-30', 'Proposal', 'Sales Pipeline'],
  ['D-2', 'Cipher retainer', 'A-2', '48000.00', '2026-07-15', 'Negotiation', 'Sales Pipeline'],
  ['D-3', 'Andina rollout', 'A-3', '250000.00', '2026-09-01', 'Discovery', 'Sales Pipeline'],
];

// L-1 carries the same email address as contact C-1 on purpose. A lead and a
// contact are separate records in separate identity spaces, so this must not
// merge and must not be reported as one record seen twice.
const LEADS = [
  ['Lead ID', 'First Name', 'Last Name', 'Company', 'Email', 'Phone', 'Country', 'Status'],
  ['L-1', 'Ada', 'Lovelace', 'Analytical Engines', 'ada@analytical.example', '+1 212 555 0147', 'US', 'Open'],
  ['L-2', 'Katherine', 'Johnson', 'Orbital Mechanics', 'katherine@orbital.example', '+1 757 555 0163', 'US', 'Working'],
  ['L-3', 'Dorothy', 'Vaughan', 'Computing Section', 'dorothy@computing.example', '+1 757 555 0198', 'US', 'Open'],
];

const CONTACT_DEALS = [
  ['Contact ID', 'Deal ID'],
  ['C-1', 'D-1'],
  ['C-4', 'D-1'],
  ['C-2', 'D-2'],
  ['C-3', 'D-3'],
];

function writeSharedBundle(caseId, { includeLeads }) {
  write(caseId, 'input/contacts.csv', csv(CONTACTS));
  write(caseId, 'input/companies.csv', csv(COMPANIES));
  write(caseId, 'input/deals.csv', csv(DEALS));
  write(caseId, 'input/contact-deals.csv', csv(CONTACT_DEALS));
  if (includeLeads) write(caseId, 'input/leads.csv', csv(LEADS));
}

const SHARED_FILES = (includeLeads) => [
  { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
  { id: 'companies', path: 'companies.csv', format: 'CSV' },
  { id: 'deals', path: 'deals.csv', format: 'CSV' },
  { id: 'contactdeals', path: 'contact-deals.csv', format: 'CSV' },
  ...(includeLeads ? [{ id: 'leads', path: 'leads.csv', format: 'CSV' }] : []),
];

const PHONE_OPTIONS = { options: { phoneCountryColumn: col('Country') } };

// --------------------------------------------------------------- scenario A

writeSharedBundle('A-clean-multi-object', { includeLeads: true });
write(
  'A-clean-multi-object',
  'config.json',
  json({
    configVersion: '3.0.0',
    source: { system: 'legacy_crm', namespace: 'acme-2026-08' },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    files: SHARED_FILES(true),
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: col('Contact ID'),
        fields: [
          field('First Name', 'contact.firstName', 'TEXT'),
          field('Last Name', 'contact.lastName', 'TEXT'),
          field('Email', 'contact.email', 'EMAIL'),
          field('Phone', 'contact.phone', 'PHONE', PHONE_OPTIONS),
          field('Job Title', 'contact.jobTitle', 'TEXT'),
        ],
      },
      {
        id: 'companies',
        fileId: 'companies',
        object: 'COMPANY',
        sourceRecordIdColumn: col('Company ID'),
        fields: [
          field('Name', 'company.name', 'TEXT'),
          field('Domain', 'company.domain', 'TEXT'),
          field('City', 'company.city', 'TEXT'),
          field('Country', 'company.country', 'TEXT'),
          field('Employees', 'company.employeeCount', 'NUMBER', {
            options: { decimalSeparator: '.', thousandsSeparator: 'NONE' },
          }),
        ],
      },
      {
        id: 'deals',
        fileId: 'deals',
        object: 'DEAL',
        sourceRecordIdColumn: col('Deal ID'),
        fields: [
          field('Deal Name', 'deal.name', 'TEXT'),
          field('Amount', 'deal.amount', 'NUMBER', {
            options: { decimalSeparator: '.', thousandsSeparator: 'NONE' },
          }),
          field('Close Date', 'deal.closeDate', 'DATE'),
          field('Stage', 'deal.stage', 'TEXT'),
          field('Pipeline', 'deal.pipeline', 'TEXT'),
        ],
      },
      {
        id: 'leads',
        fileId: 'leads',
        object: 'LEAD',
        sourceRecordIdColumn: col('Lead ID'),
        fields: [
          field('First Name', 'lead.firstName', 'TEXT'),
          field('Last Name', 'lead.lastName', 'TEXT'),
          field('Company', 'lead.company', 'TEXT'),
          field('Email', 'lead.email', 'EMAIL'),
          field('Phone', 'lead.phone', 'PHONE', PHONE_OPTIONS),
          field('Status', 'lead.status', 'TEXT'),
        ],
      },
    ],
    associations: [
      {
        id: 'contact-company',
        kind: 'COLUMN_REFERENCE',
        recordMappingId: 'contacts',
        relationshipType: 'CONTACT_TO_COMPANY',
        keyColumn: col('Company ID'),
        targetRecordMappingId: 'companies',
        targetMatchKey: 'SOURCE_RECORD_ID',
      },
      {
        id: 'company-deal',
        kind: 'COLUMN_REFERENCE',
        recordMappingId: 'deals',
        relationshipType: 'COMPANY_TO_DEAL',
        ownerSide: 'TO',
        keyColumn: col('Company ID'),
        targetRecordMappingId: 'companies',
        targetMatchKey: 'SOURCE_RECORD_ID',
      },
      {
        id: 'contact-deal',
        kind: 'EDGE_FILE',
        fileId: 'contactdeals',
        relationshipType: 'CONTACT_TO_DEAL',
        fromRecordMappingId: 'contacts',
        fromKeyColumn: col('Contact ID'),
        toRecordMappingId: 'deals',
        toKeyColumn: col('Deal ID'),
      },
    ],
  }),
);

// --------------------------------------------------------------- scenario B

write(
  'B-dirty-multinational',
  'input/contacts.csv',
  csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Country', 'Signed Up', 'Postal Code', 'Segment'],
    ['1', '  Sofia ', 'Restrepo', 'SOFIA@Andina.Example', '+57 300 1234567', 'CO', '2026-01-15', '110111', 'SEG-A'],
    ['2', 'Mateo', ' Gómez', 'mateo@andina.example', '3011234567', 'CO', '2026-02-20', '110221', 'SEG-A'],
    ['3', 'Valentina', 'Ruiz', 'valentina@andina.example', '3021234567', '', '2026-03-05', '050021', ''],
    ['4', 'Lucía', 'Fernández', 'lucia@iberia.example', '+34 612 345 678', 'ES', '2026-04-10', '28013', 'SEG-B'],
    ['5', 'Oliver', 'Bennett', 'oliver@bletchley.example', '+44 20 7946 0958', 'US', '2026-05-22', 'MK3 6EB', 'SEG-B'],
    ['6', 'Grace', 'Hopper', 'grace@analytical.example', '(415) 555-2671', 'US', '2026-06-30', '01730', ''],
    ['7', '芳子', '山田', 'yoshiko@tokyo.example', '+81 3 3234 5678', 'JP', '2026-07-04', '100-0001', 'SEG-C'],
    ['8', 'Ægir', 'Þórsson', 'aegir@nordur.example', '+354 561 2345', 'IS', 'not a date', '101', ''],
  ]),
);
write(
  'B-dirty-multinational',
  'config.json',
  json({
    configVersion: '3.0.0',
    source: { system: 'legacy_crm', namespace: 'multinational-2026-08' },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: col('Contact ID'),
        fields: [
          // This scenario is the dirty one: its names arrive padded, and the plan
          // approves removing the padding from exactly these two fields (D67).
          field('First Name', 'contact.firstName', 'TEXT', { options: { trim: true } }),
          field('Last Name', 'contact.lastName', 'TEXT', { options: { trim: true } }),
          field('Email', 'contact.email', 'EMAIL'),
          field('Phone', 'contact.phone', 'PHONE', PHONE_OPTIONS),
          field('Signed Up', 'contact.createdAt', 'DATE'),
          field('Postal Code', 'contact.postalCode', 'IDENTIFIER'),
        ],
      },
    ],
  }),
);

// --------------------------------------------------------------- scenario C

write(
  'C-identity-adversarial',
  'input/crm-a.csv',
  csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Job Title'],
    ['1001', 'Ada', 'Lovelace', 'ada@analytical.example', 'Chief Engineer'],
    ['1001', 'Ada', 'Lovelace', 'ada@analytical.example', 'Chief Engineer'],
    ['1002', 'Alan', 'Turing', 'shared@bletchley.example', 'Cryptanalyst'],
    ['1003', 'Joan', 'Clarke', 'shared@bletchley.example', 'Cryptanalyst'],
    ['1004', 'Grace', 'Hopper', 'info@analytical.example', 'Compiler Lead'],
    ['1005', 'Jean', 'Bartik', 'info@analytical.example', 'Programmer'],
    ['1006', 'Katherine', 'Johnson', 'katherine@analytical.example', 'Mathematician'],
    ['1006', 'Katherine', 'Johnson', 'katherine.johnson@analytical.example', 'Aerospace Technologist'],
  ]),
);
write(
  'C-identity-adversarial',
  'input/crm-b.csv',
  csv([
    ['Contact ID', 'First Name', 'Last Name', 'Email', 'Job Title'],
    ['1001', 'Dorothy', 'Vaughan', 'dorothy@iberia.example', 'Supervisor'],
    ['1002', 'Mary', 'Jackson', 'mary@iberia.example', 'Engineer'],
  ]),
);
write(
  'C-identity-adversarial',
  'config.json',
  json({
    configVersion: '3.0.0',
    source: { system: 'legacy_crm', namespace: 'unused-default' },
    target: { mode: 'HUBSPOT', importMode: 'CREATE_ONLY' },
    files: [
      { id: 'crma', path: 'crm-a.csv', format: 'CSV', sourceSystem: 'crm_a', sourceNamespace: 'acme-crm-a' },
      { id: 'crmb', path: 'crm-b.csv', format: 'CSV', sourceSystem: 'crm_b', sourceNamespace: 'acme-crm-b' },
    ],
    records: ['a', 'b'].map((suffix) => ({
      id: `contacts-${suffix}`,
      fileId: suffix === 'a' ? 'crma' : 'crmb',
      object: 'CONTACT',
      sourceRecordIdColumn: col('Contact ID'),
      fields: [
        field('First Name', 'contact.firstName', 'TEXT'),
        field('Last Name', 'contact.lastName', 'TEXT'),
        field('Email', 'contact.email', 'EMAIL'),
        field('Job Title', 'contact.jobTitle', 'TEXT'),
      ],
    })),
  }),
);

// ------------------------------------------------------- destination packages

const VENDOR_RECORDS = {
  hubspot: [
    {
      id: 'contacts',
      fileId: 'contacts',
      object: 'CONTACT',
      sourceRecordIdColumn: col('Contact ID'),
      fields: [
        field('First Name', 'contact.firstName', 'TEXT'),
        field('Last Name', 'contact.lastName', 'TEXT'),
        field('Email', 'contact.email', 'EMAIL'),
        field('Phone', 'contact.phone', 'PHONE', PHONE_OPTIONS),
        field('Job Title', 'contact.jobTitle', 'TEXT'),
      ],
    },
    {
      id: 'companies',
      fileId: 'companies',
      object: 'COMPANY',
      sourceRecordIdColumn: col('Company ID'),
      fields: [
        field('Name', 'company.name', 'TEXT'),
        field('Domain', 'company.domain', 'TEXT'),
        field('City', 'company.city', 'TEXT'),
        field('Country', 'company.country', 'TEXT'),
      ],
    },
    {
      id: 'deals',
      fileId: 'deals',
      object: 'DEAL',
      sourceRecordIdColumn: col('Deal ID'),
      fields: [
        field('Deal Name', 'deal.name', 'TEXT'),
        field('Amount', 'deal.amount', 'NUMBER', {
          options: { decimalSeparator: '.', thousandsSeparator: 'NONE' },
        }),
        field('Close Date', 'deal.closeDate', 'DATE'),
        field('Stage', 'deal.stage', 'TEXT'),
        field('Pipeline', 'deal.pipeline', 'TEXT'),
      ],
    },
  ],
  salesforce: [
    {
      id: 'leads',
      fileId: 'leads',
      object: 'LEAD',
      sourceRecordIdColumn: col('Lead ID'),
      fields: [
        field('First Name', 'lead.firstName', 'TEXT'),
        field('Last Name', 'lead.lastName', 'TEXT'),
        field('Company', 'lead.company', 'TEXT'),
        field('Email', 'lead.email', 'EMAIL'),
        field('Phone', 'lead.phone', 'PHONE', PHONE_OPTIONS),
        field('Status', 'lead.status', 'TEXT'),
      ],
    },
    {
      id: 'contacts',
      fileId: 'contacts',
      object: 'CONTACT',
      sourceRecordIdColumn: col('Contact ID'),
      fields: [
        field('First Name', 'contact.firstName', 'TEXT'),
        field('Last Name', 'contact.lastName', 'TEXT'),
        field('Email', 'contact.email', 'EMAIL'),
        field('Phone', 'contact.phone', 'PHONE', PHONE_OPTIONS),
        field('Job Title', 'contact.jobTitle', 'TEXT'),
      ],
    },
    {
      id: 'companies',
      fileId: 'companies',
      object: 'COMPANY',
      sourceRecordIdColumn: col('Company ID'),
      fields: [
        field('Name', 'company.name', 'TEXT'),
        field('City', 'company.city', 'TEXT'),
        field('Country', 'company.country', 'TEXT'),
        field('Employees', 'company.employeeCount', 'NUMBER', {
          options: { decimalSeparator: '.', thousandsSeparator: 'NONE' },
        }),
      ],
    },
    {
      id: 'deals',
      fileId: 'deals',
      object: 'DEAL',
      sourceRecordIdColumn: col('Deal ID'),
      fields: [
        field('Deal Name', 'deal.name', 'TEXT'),
        field('Amount', 'deal.amount', 'NUMBER', {
          options: { decimalSeparator: '.', thousandsSeparator: 'NONE' },
        }),
        field('Close Date', 'deal.closeDate', 'DATE'),
        field('Stage', 'deal.stage', 'TEXT'),
      ],
    },
  ],
};

const VENDOR_ASSOCIATIONS = [
  {
    id: 'contact-company',
    kind: 'COLUMN_REFERENCE',
    recordMappingId: 'contacts',
    relationshipType: 'CONTACT_TO_COMPANY',
    keyColumn: col('Company ID'),
    targetRecordMappingId: 'companies',
    targetMatchKey: 'SOURCE_RECORD_ID',
  },
  {
    id: 'company-deal',
    kind: 'COLUMN_REFERENCE',
    recordMappingId: 'deals',
    relationshipType: 'COMPANY_TO_DEAL',
    ownerSide: 'TO',
    keyColumn: col('Company ID'),
    targetRecordMappingId: 'companies',
    targetMatchKey: 'SOURCE_RECORD_ID',
  },
  {
    id: 'contact-deal',
    kind: 'EDGE_FILE',
    fileId: 'contactdeals',
    relationshipType: 'CONTACT_TO_DEAL',
    fromRecordMappingId: 'contacts',
    fromKeyColumn: col('Contact ID'),
    toRecordMappingId: 'deals',
    toKeyColumn: col('Deal ID'),
  },
];

// HubSpot has no Lead object in the V1 envelope, so only the Salesforce package
// carries the leads file. That difference is the point of running one bundle
// through both adapters.
for (const [caseId, mode, key] of [
  ['D-hubspot', 'HUBSPOT', 'hubspot'],
  ['D-salesforce', 'SALESFORCE', 'salesforce'],
]) {
  const includeLeads = mode === 'SALESFORCE';
  writeSharedBundle(caseId, { includeLeads });
  write(
    caseId,
    'config.json',
    json({
      configVersion: '3.0.0',
      source: { system: 'legacy_crm', namespace: 'acme-2026-08' },
      target: { mode, importMode: 'CREATE_ONLY' },
      files: SHARED_FILES(includeLeads),
      records: VENDOR_RECORDS[key],
      associations: VENDOR_ASSOCIATIONS,
    }),
  );
}

// --------------------------------------------------------------------- write

mkdirSync(root, { recursive: true });
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const known = [
    'A-clean-multi-object',
    'B-dirty-multinational',
    'C-identity-adversarial',
    'D-hubspot',
    'D-salesforce',
  ];
  if (!known.includes(entry.name)) rmSync(join(root, entry.name), { recursive: true, force: true });
}

process.stdout.write('wrote 5 acceptance fixtures\n');
