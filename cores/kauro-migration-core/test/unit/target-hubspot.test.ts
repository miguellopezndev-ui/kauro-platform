import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isMigrationError } from '../../src/domain/errors.js';
import { hashTargetContract } from '../../src/target/contract.js';
import type { TargetArtifactRef, TargetObjectContract } from '../../src/target/contract.js';
import {
  DEFAULT_HUBSPOT_ARTIFACT_LIMITS,
  HUBSPOT_ARTIFACT_KINDS,
  HUBSPOT_PIPELINE_ARTIFACT_HEADERS,
  HUBSPOT_PROPERTY_EXPORT_HEADERS,
  buildHubSpotTargetContract,
  hubSpotArtifactRef,
  hubSpotWriteScopeFor,
  parseHubSpotAccessGrant,
  parseHubSpotPipelineArtifact,
  parseHubSpotPipelines,
  parseHubSpotPropertyApi,
  parseHubSpotPropertyExport,
  parseHubSpotSupplement,
} from '../../src/target/hubspot-artifacts.js';
import type { HubSpotPropertyApiCapture, HubSpotSupplement } from '../../src/target/hubspot-artifacts.js';

/**
 * These artifacts arrive from outside, and the knowledge base documents neither
 * the file format nor the exact column headers. The cases below are therefore
 * mostly hostile: reordered columns, undocumented extras, a column that is
 * missing, two columns claiming one meaning, a cell carrying the delimiter and
 * a newline, and a value a spreadsheet would evaluate.
 */

const CONTACT_HEADERS = 'Name,Internal name,Type,Group,Description,Options';
const CONTACT_ROWS = [
  'Email,email,string,contactinformation,The email address,',
  'Lifecycle Stage,lifecyclestage,enumeration,contactinformation,Where the contact is,Subscriber;Lead;Customer',
];

const DEAL_EXPORT = [
  'Name,Internal name,Type,Group,Description,Options',
  'Deal Name,dealname,string,dealinformation,The name of the deal,',
  'Deal Stage,dealstage,enumeration,dealinformation,The stage of the deal,',
  '',
].join('\n');

const PIPELINES = [
  'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
  'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
  'deals,Sales Pipeline,default,Appointment scheduled,appointmentscheduled,0,0.2,2026-09-01T09:00:00Z',
  'deals,Sales Pipeline,default,Closed won,closedwon,1,won,2026-09-01T09:00:00Z',
  'deals,Renewals,renewals_2026,,,,,2026-09-01T09:00:00Z',
  'deals,Renewals,renewals_2026,Up for renewal,renewal_open,0,0.5,2026-09-01T09:00:00Z',
  '',
].join('\n');

const SUPPLEMENT = JSON.stringify({
  artifactKind: 'HUBSPOT_TARGET_SUPPLEMENT',
  supplementVersion: '1',
  portalId: '24681012',
  portalName: 'Acme Wholesale',
  capturedAt: '2026-09-01T09:00:00Z',
  statedBy: 'Acme RevOps, read from Settings then Properties',
  uniqueProperties: [{ objectApiName: 'contacts', internalName: 'email', unique: 'TRUE' }],
});

const CONTACT_OPTIONS = {
  objectApiName: 'contacts',
  objectLabel: 'Contacts',
  filePath: 'contacts-properties.csv',
};

function contactExport(headers = CONTACT_HEADERS, rows: readonly string[] = CONTACT_ROWS): string {
  return `${headers}\n${rows.join('\n')}\n`;
}

function migrationErrorWith(code: string, ...fragments: readonly string[]) {
  return (error: unknown): boolean =>
    isMigrationError(error) && error.code === code && fragments.every((fragment) => error.message.includes(fragment));
}

describe('the declared header semantics', () => {
  it('states every candidate spelling in the form matching uses', () => {
    for (const table of [HUBSPOT_PROPERTY_EXPORT_HEADERS, HUBSPOT_PIPELINE_ARTIFACT_HEADERS]) {
      for (const role of table) {
        assert.ok(role.candidates.length > 0, `${role.role} declares no spelling`);
        for (const candidate of role.candidates) {
          const matchable = candidate.spelling.replace(/[\s_]+/gu, ' ').trim().toLowerCase();
          assert.equal(candidate.spelling, matchable, `${candidate.spelling} would never match a header`);
        }
      }
    }
  });

  it('never gives one spelling to two roles', () => {
    for (const table of [HUBSPOT_PROPERTY_EXPORT_HEADERS, HUBSPOT_PIPELINE_ARTIFACT_HEADERS]) {
      const owner = new Map<string, string>();
      for (const role of table) {
        for (const candidate of role.candidates) {
          const previous = owner.get(candidate.spelling);
          assert.equal(previous, undefined, `"${candidate.spelling}" belongs to ${String(previous)} and ${role.role}`);
          owner.set(candidate.spelling, role.role);
        }
      }
    }
  });

  it('records where each spelling came from', () => {
    for (const role of HUBSPOT_PROPERTY_EXPORT_HEADERS) {
      // A role has to rest on something somebody can go and check: either a
      // word in HubSpot's documented list of what the export contains, or a
      // column seen in a real export on a stated date.
      //
      // This used to demand a documented word for every role, which held until
      // a real export arrived. HubSpot documents the export's contents as an
      // explicitly non-exhaustive prose list, and the file carries columns that
      // list never mentions — "Read only value" and "Calculated" among them.
      // Demanding prose for those would have meant either discarding the two
      // facts that decide whether a property may be written, or labelling them
      // documented when they are not. Both are worse than saying where they
      // really came from.
      const grounded = role.candidates.filter(
        (candidate) => candidate.provenance === 'DOCUMENTED_PROSE' || candidate.confirmedOn !== null,
      );
      assert.ok(grounded.length > 0, `${role.role} rests on neither a documented word nor a real export`);

      for (const candidate of role.candidates) {
        // An unconfirmed variant is a guess at a spelling, and a guess must not
        // carry a date that would read as an observation.
        if (candidate.provenance === 'UNCONFIRMED_VARIANT') {
          assert.equal(candidate.confirmedOn, null, `${candidate.spelling} is unconfirmed and carries a date`);
        }
        // A canonical spelling is one this repository states rather than found
        // in documentation, so it is only admissible with the date an export
        // showed it.
        if (candidate.provenance === 'KAURO_CANONICAL') {
          assert.notEqual(candidate.confirmedOn, null, `${candidate.spelling} is canonical and names no export`);
        }
      }
    }
  });
});

describe('the HubSpot property export', () => {
  it('reads a property export into fields the portal answers to', () => {
    const object = parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS);
    assert.equal(object.apiName, 'contacts');
    assert.equal(object.fields.length, 2);
    assert.deepEqual(
      object.fields.map((field) => field.apiName),
      ['email', 'lifecyclestage'],
    );
    assert.deepEqual(
      object.fields.map((field) => field.type),
      ['string', 'enumeration'],
    );
    assert.equal(object.fields[0]?.label, 'Email');
    assert.equal(object.recordTypes.length, 0);
  });

  it('is header-semantic: the same export in a different column order reads the same', () => {
    const reordered = contactExport('Options,Type,Description,Internal name,Group,Name', [
      ',string,The email address,email,contactinformation,Email',
      'Subscriber;Lead;Customer,enumeration,Where the contact is,lifecyclestage,contactinformation,Lifecycle Stage',
    ]);
    assert.deepEqual(parseHubSpotPropertyExport(reordered, CONTACT_OPTIONS), parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS));
  });

  it('matches headers case- and whitespace-insensitively', () => {
    const shouted = contactExport('  NAME , internal_name ,Type,GROUP,Description,OPTIONS');
    assert.deepEqual(parseHubSpotPropertyExport(shouted, CONTACT_OPTIONS), parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS));
  });

  it('tolerates undocumented columns without letting them become authority', () => {
    const wider = contactExport('Name,Internal name,Type,Group,Description,Options,Usages,Fill rate,User that created it', [
      'Email,email,string,contactinformation,The email address,,4,98%,Dana Ruiz',
      'Lifecycle Stage,lifecyclestage,enumeration,contactinformation,Where the contact is,Subscriber;Lead;Customer,9,71%,Dana Ruiz',
    ]);
    assert.deepEqual(parseHubSpotPropertyExport(wider, CONTACT_OPTIONS), parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS));
  });

  it('leaves unique UNKNOWN rather than FALSE, and keeps externalId and idLookup separate', () => {
    const field = parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS).fields[0];
    assert.equal(field?.unique, 'UNKNOWN');
    assert.equal(field?.externalId, 'UNKNOWN');
    assert.equal(field?.idLookup, 'UNKNOWN');
    assert.equal(field?.restrictedPicklist, 'UNKNOWN');
    assert.equal(field?.evidence, 'ARTIFACT');
  });

  it('fails closed when a required semantic column is absent, and names the headers it saw', () => {
    const withoutType = contactExport('Name,Internal name,Group,Description,Options', [
      'Email,email,contactinformation,The email address,',
      'Lifecycle Stage,lifecyclestage,contactinformation,Where the contact is,Subscriber;Lead',
    ]);
    assert.throws(
      () => parseHubSpotPropertyExport(withoutType, CONTACT_OPTIONS),
      (error: unknown) => {
        if (!isMigrationError(error)) return false;
        assert.equal(error.code, 'INPUT_UNSUPPORTED');
        assert.ok(error.message.includes('carries no column for TYPE'));
        assert.ok(error.message.includes('"Internal name"'));
        assert.deepEqual(error.details['headersSeen'], ['Name', 'Internal name', 'Group', 'Description', 'Options']);
        return true;
      },
    );
  });

  it('fails closed when two columns read as one semantic role', () => {
    const ambiguous = contactExport('Name,Internal name,Type,Field type,Options', [
      'Email,email,string,text,',
      'Lifecycle Stage,lifecyclestage,enumeration,select,Subscriber;Lead',
    ]);
    assert.throws(
      () => parseHubSpotPropertyExport(ambiguous, CONTACT_OPTIONS),
      (error: unknown) => {
        if (!isMigrationError(error)) return false;
        assert.equal(error.code, 'INPUT_UNSUPPORTED');
        assert.ok(error.message.includes('read as TYPE'));
        assert.deepEqual(error.details['matchedHeaders'], ['Type', 'Field type']);
        assert.deepEqual(error.details['headersSeen'], ['Name', 'Internal name', 'Type', 'Field type', 'Options']);
        return true;
      },
    );
  });

  it('keeps a cell holding the delimiter and an embedded newline exactly as it was', () => {
    const awkward = contactExport(CONTACT_HEADERS, [
      '"Email, work\nand home",email,string,contactinformation,"Comma, and\nnewline",',
    ]);
    const field = parseHubSpotPropertyExport(awkward, CONTACT_OPTIONS).fields[0];
    assert.equal(field?.label, 'Email, work\nand home');
    assert.equal(field?.apiName, 'email');
  });

  it('never evaluates a value that looks like a formula', () => {
    const risky = contactExport(CONTACT_HEADERS, [
      '=SUM(A1:A9),email,string,contactinformation,,=1+1;@channel;+15551234567',
    ]);
    const field = parseHubSpotPropertyExport(risky, CONTACT_OPTIONS).fields[0];
    assert.equal(field?.label, '=SUM(A1:A9)');
    assert.deepEqual(
      field?.picklistValues.map((option) => option.value),
      ['=1+1', '@channel', '+15551234567'],
    );
  });

  it('splits options on the semicolon and records what it could not determine', () => {
    const object = parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS);
    assert.deepEqual(object.fields[0]?.picklistValues, []);
    assert.deepEqual(object.fields[1]?.picklistValues, [
      { value: 'Subscriber', label: 'Subscriber', active: true, defaultValue: false },
      { value: 'Lead', label: 'Lead', active: true, defaultValue: false },
      { value: 'Customer', label: 'Customer', active: true, defaultValue: false },
    ]);
    // Nothing says the list is closed, so nothing may be refused for being off it.
    assert.equal(object.fields[1]?.restrictedPicklist, 'UNKNOWN');
  });

  it('takes the internal value out of an option the way a real export writes it', () => {
    // Settled against an "Export all properties" taken from a real portal on
    // 2026-09-01, which writes each option as its label followed by its internal
    // value in parentheses, and marks some of them read-only:
    //
    //     Organic Search (ORGANIC_SEARCH); Paid Search (PAID_SEARCH)
    //     Active (active) [READ-ONLY]; Inactive (inactive) [READ-ONLY]
    //
    // Recording the whole token as the value was materially wrong: the portal
    // does not answer to "Organic Search (ORGANIC_SEARCH)", so a plan checked
    // against such a contract was checked against a value set that never existed.
    const real = [
      'Name,Internal name,Type,Group,Description,Options',
      'Original Source,hs_analytics_source,enumeration,contactinformation,Where it came from,"Organic Search (ORGANIC_SEARCH); Paid Search (PAID_SEARCH)"',
      'Membership,hs_membership,enumeration,contactinformation,Membership state,"Active (active) [READ-ONLY]; Inactive (inactive) [READ-ONLY]"',
      'Plain,plain_prop,enumeration,contactinformation,No parentheses here,"Alpha; Beta"',
      'Bracketed,bracketed_prop,enumeration,contactinformation,A label with its own parentheses,"North America (US) (NA)"',
      '',
    ].join('\n');

    const object = parseHubSpotPropertyExport(real, CONTACT_OPTIONS);
    const options = (name: string): [string, string][] =>
      (object.fields.find((field) => field.apiName === name)?.picklistValues ?? []).map((o) => [o.value, o.label]);

    assert.deepEqual(options('hs_analytics_source'), [
      ['ORGANIC_SEARCH', 'Organic Search'],
      ['PAID_SEARCH', 'Paid Search'],
    ]);

    // The read-only marker qualifies the option; it is not part of its name.
    assert.deepEqual(options('hs_membership'), [
      ['active', 'Active'],
      ['inactive', 'Inactive'],
    ]);

    // No parentheses is the old reading, kept for the case the new one misses.
    assert.deepEqual(options('plain_prop'), [
      ['Alpha', 'Alpha'],
      ['Beta', 'Beta'],
    ]);

    // The value is the last parenthesised group, so a label may carry its own.
    assert.deepEqual(options('bracketed_prop'), [['NA', 'North America (US)']]);
  });

  it('detects a semicolon-delimited export', () => {
    const semicolons = [
      'Name;Internal name;Type;Group;Description;Options',
      'Email;email;string;contactinformation;The email address;',
      'Lifecycle Stage;lifecyclestage;enumeration;contactinformation;Where the contact is;"Subscriber;Lead;Customer"',
      '',
    ].join('\n');
    assert.deepEqual(parseHubSpotPropertyExport(semicolons, CONTACT_OPTIONS), parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS));
  });

  it('detects a tab-delimited export', () => {
    const tabs = [
      'Name\tInternal name\tType\tGroup\tDescription\tOptions',
      'Email\temail\tstring\tcontactinformation\tThe email address\t',
      'Lifecycle Stage\tlifecyclestage\tenumeration\tcontactinformation\tWhere the contact is\tSubscriber;Lead;Customer',
      '',
    ].join('\n');
    assert.deepEqual(parseHubSpotPropertyExport(tabs, CONTACT_OPTIONS), parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS));
  });

  it('reports the columns rather than the delimiter when a stated delimiter reads the file as one column', () => {
    assert.throws(
      () => parseHubSpotPropertyExport(contactExport(), { ...CONTACT_OPTIONS, delimiter: ';' }),
      migrationErrorWith('INPUT_UNSUPPORTED', 'carries no column for INTERNAL_NAME'),
    );
  });

  it('refuses a workbook handed to it as text', () => {
    assert.throws(
      () => parseHubSpotPropertyExport('PK\u0003\u0004\u0014\u0000\u0006\u0000', CONTACT_OPTIONS),
      migrationErrorWith('INPUT_UNSUPPORTED', 'ZIP archive'),
    );
  });

  it('refuses text carrying a NUL', () => {
    assert.throws(
      () => parseHubSpotPropertyExport(`Name,Internal name,Type\nEmail,em\u0000ail,string\n`, CONTACT_OPTIONS),
      migrationErrorWith('INPUT_UNSUPPORTED', 'NUL character'),
    );
  });

  it('refuses a row whose cells do not line up with the header', () => {
    const ragged = contactExport(CONTACT_HEADERS, ['Email,email,string,contactinformation,The email address,', 'Lifecycle Stage,lifecyclestage']);
    assert.throws(
      () => parseHubSpotPropertyExport(ragged, CONTACT_OPTIONS),
      migrationErrorWith('INPUT_CORRUPT', 'record 3 has 2 fields where the header row has 6'),
    );
  });

  it('refuses a blank line rather than reading it as a row', () => {
    assert.throws(
      () => parseHubSpotPropertyExport(`${contactExport()}\n`, CONTACT_OPTIONS),
      migrationErrorWith('INPUT_CORRUPT', 'fields where the header row has 6'),
    );
  });

  it('refuses two rows declaring one internal name', () => {
    const twice = contactExport(CONTACT_HEADERS, [
      'Email,email,string,contactinformation,The email address,',
      'Work email,email,string,contactinformation,The other one,',
    ]);
    assert.throws(
      () => parseHubSpotPropertyExport(twice, CONTACT_OPTIONS),
      migrationErrorWith('INPUT_CORRUPT', 'declares the property "email" twice, at records 2 and 3'),
    );
  });

  it('refuses an internal name surrounded by whitespace', () => {
    const padded = contactExport(CONTACT_HEADERS, ['Email, email ,string,contactinformation,The email address,']);
    assert.throws(
      () => parseHubSpotPropertyExport(padded, CONTACT_OPTIONS),
      migrationErrorWith('INPUT_CORRUPT', 'surrounded by whitespace'),
    );
  });

  it('refuses a row that carries no type', () => {
    const untyped = contactExport(CONTACT_HEADERS, ['Email,email,,contactinformation,The email address,']);
    assert.throws(
      () => parseHubSpotPropertyExport(untyped, CONTACT_OPTIONS),
      migrationErrorWith('INPUT_CORRUPT', 'has no value in "Type"'),
    );
  });

  it('refuses an export carrying a header row and no properties', () => {
    assert.throws(
      () => parseHubSpotPropertyExport(`${CONTACT_HEADERS}\n`, CONTACT_OPTIONS),
      migrationErrorWith('INPUT_CORRUPT', 'header row and no properties'),
    );
  });

  it('refuses an empty file', () => {
    assert.throws(() => parseHubSpotPropertyExport('   \n', CONTACT_OPTIONS), migrationErrorWith('INPUT_CORRUPT', 'carries no header row'));
  });

  it('caps rows, cell length and total characters', () => {
    const limits = { ...DEFAULT_HUBSPOT_ARTIFACT_LIMITS, maxRows: 2 };
    assert.throws(
      () => parseHubSpotPropertyExport(contactExport(), { ...CONTACT_OPTIONS, limits }),
      migrationErrorWith('INPUT_LIMIT_EXCEEDED'),
    );
    assert.throws(
      () =>
        parseHubSpotPropertyExport(contactExport(CONTACT_HEADERS, [`${'x'.repeat(200)},email,string,,,`]), {
          ...CONTACT_OPTIONS,
          limits: { ...DEFAULT_HUBSPOT_ARTIFACT_LIMITS, maxCellLength: 100 },
        }),
      migrationErrorWith('INPUT_LIMIT_EXCEEDED'),
    );
    assert.throws(
      () =>
        parseHubSpotPropertyExport(contactExport(), {
          ...CONTACT_OPTIONS,
          limits: { ...DEFAULT_HUBSPOT_ARTIFACT_LIMITS, maxCharacters: 32 },
        }),
      migrationErrorWith('INPUT_LIMIT_EXCEEDED', 'above the limit of 32'),
    );
  });

  it('caps the options one cell may list', () => {
    const many = Array.from({ length: 40 }, (_, index) => `option${String(index)}`).join(';');
    assert.throws(
      () =>
        parseHubSpotPropertyExport(contactExport(CONTACT_HEADERS, [`Lifecycle,lifecyclestage,enumeration,,,${many}`]), {
          ...CONTACT_OPTIONS,
          limits: { ...DEFAULT_HUBSPOT_ARTIFACT_LIMITS, maxPicklistOptions: 10 },
        }),
      migrationErrorWith('INPUT_LIMIT_EXCEEDED', 'lists 40 options'),
    );
  });
});

describe('the HubSpot pipelines artifact', () => {
  it('reads pipelines and their stages in the order the artifact states them', () => {
    const artifact = parseHubSpotPipelineArtifact(PIPELINES);
    assert.equal(artifact.capturedAt, '2026-09-01T09:00:00Z');
    assert.deepEqual(
      artifact.pipelines.map((pipeline) => pipeline.pipelineInternalName),
      ['default', 'renewals_2026'],
    );
    assert.deepEqual(artifact.pipelines[0]?.stages, [
      { stageLabel: 'Appointment scheduled', stageInternalName: 'appointmentscheduled', displayOrder: 0 },
      { stageLabel: 'Closed won', stageInternalName: 'closedwon', displayOrder: 1 },
    ]);
    assert.deepEqual(parseHubSpotPipelines(PIPELINES), artifact.pipelines);
  });

  it('reads the columns by header, in any order, and tolerates an extra one', () => {
    const shuffled = [
      'captured_at,stage_internal_name,object,display_order,pipeline_internal_name,stage_label,pipeline_label,stage_probability_or_state,exported_by',
      '2026-09-01T09:00:00Z,,deals,,default,,Sales Pipeline,,Dana Ruiz',
      '2026-09-01T09:00:00Z,appointmentscheduled,deals,0,default,Appointment scheduled,Sales Pipeline,0.2,Dana Ruiz',
      '',
    ].join('\n');
    const artifact = parseHubSpotPipelineArtifact(shuffled);
    assert.deepEqual(artifact.pipelines[0]?.stages[0], {
      stageLabel: 'Appointment scheduled',
      stageInternalName: 'appointmentscheduled',
      displayOrder: 0,
    });
  });

  it('fails closed when a stage names a pipeline the artifact does not declare', () => {
    const orphan = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
      'deals,Renewals,renewals_2026,Up for renewal,renewal_open,0,0.5,2026-09-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(
      () => parseHubSpotPipelines(orphan),
      migrationErrorWith('INPUT_CORRUPT', 'which the artifact never declares'),
    );
  });

  it('fails closed on a stage with no internal name', () => {
    const nameless = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
      'deals,Sales Pipeline,default,Closed won,,1,won,2026-09-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(
      () => parseHubSpotPipelines(nameless),
      migrationErrorWith('INPUT_CORRUPT', 'names the stage "Closed won" with no internal name'),
    );
  });

  it('fails closed on a pipeline with no internal name', () => {
    const nameless = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,,,,,,2026-09-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(
      () => parseHubSpotPipelines(nameless),
      migrationErrorWith('INPUT_CORRUPT', 'has no value in "pipeline_internal_name"'),
    );
  });

  it('fails closed on a duplicate pipeline internal name', () => {
    const twice = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
      'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(() => parseHubSpotPipelines(twice), migrationErrorWith('INPUT_CORRUPT', 'twice, at records 2 and 3'));
  });

  it('fails closed on a duplicate stage name inside one pipeline', () => {
    const twice = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
      'deals,Sales Pipeline,default,Closed won,closedwon,0,won,2026-09-01T09:00:00Z',
      'deals,Sales Pipeline,default,Closed won again,closedwon,1,won,2026-09-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(
      () => parseHubSpotPipelines(twice),
      migrationErrorWith('INPUT_CORRUPT', 'more than one stage of the pipeline "default"'),
    );
  });

  it('fails closed when one pipeline\'s label is another pipeline\'s internal name', () => {
    const collision = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
      'deals,default,renewals_2026,,,,,2026-09-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(
      () => parseHubSpotPipelines(collision),
      migrationErrorWith('INPUT_CORRUPT', 'more than one pipeline of deals'),
    );
  });

  it('fails closed when one internal name carries two labels', () => {
    const contradiction = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
      'deals,Selling,default,Closed won,closedwon,1,won,2026-09-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(() => parseHubSpotPipelines(contradiction), migrationErrorWith('INPUT_CORRUPT', 'labels the pipeline'));
  });

  it('fails closed when two rows state different capture times', () => {
    const stitched = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
      'deals,Renewals,renewals_2026,,,,,2026-08-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(
      () => parseHubSpotPipelines(stitched),
      migrationErrorWith('INPUT_CORRUPT', 'was captured at 2026-08-01T09:00:00Z where earlier rows state 2026-09-01T09:00:00Z'),
    );
  });

  it('fails closed on a capture time that is not a date on the calendar', () => {
    const impossible = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,default,,,,,2026-02-30T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(() => parseHubSpotPipelines(impossible), migrationErrorWith('INPUT_CORRUPT', 'not a UTC timestamp'));
  });

  it('fails closed on a display order that is not an integer', () => {
    const fuzzy = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at',
      'deals,Sales Pipeline,default,,,,,2026-09-01T09:00:00Z',
      'deals,Sales Pipeline,default,Closed won,closedwon,first,won,2026-09-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(() => parseHubSpotPipelines(fuzzy), migrationErrorWith('INPUT_CORRUPT', 'not an integer'));
  });

  it('fails closed on an artifact that declares no pipeline', () => {
    const empty =
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,stage_probability_or_state,captured_at\n';
    assert.throws(() => parseHubSpotPipelines(empty), migrationErrorWith('INPUT_CORRUPT', 'declares no pipeline'));
  });

  it('fails closed when a canonical column is missing, naming the headers seen', () => {
    const missing = [
      'object,pipeline_label,pipeline_internal_name,stage_label,stage_internal_name,display_order,captured_at',
      'deals,Sales Pipeline,default,,,,2026-09-01T09:00:00Z',
      '',
    ].join('\n');
    assert.throws(
      () => parseHubSpotPipelines(missing),
      (error: unknown) => {
        if (!isMigrationError(error)) return false;
        assert.equal(error.code, 'INPUT_UNSUPPORTED');
        assert.ok(error.message.includes('carries no column for STAGE_PROBABILITY_OR_STATE'));
        assert.deepEqual(error.details['headersSeen'], [
          'object',
          'pipeline_label',
          'pipeline_internal_name',
          'stage_label',
          'stage_internal_name',
          'display_order',
          'captured_at',
        ]);
        return true;
      },
    );
  });
});

describe('the HubSpot supplement', () => {
  it('reads the portal and the properties the agency states require unique values', () => {
    const supplement = parseHubSpotSupplement(SUPPLEMENT);
    assert.equal(supplement.portalId, '24681012');
    assert.equal(supplement.portalName, 'Acme Wholesale');
    assert.equal(supplement.capturedAt, '2026-09-01T09:00:00Z');
    assert.deepEqual(supplement.uniqueProperties, [
      { objectApiName: 'contacts', internalName: 'email', unique: 'TRUE' },
    ]);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    const extended = JSON.stringify({ ...JSON.parse(SUPPLEMENT), defaultPipeline: 'default' });
    assert.throws(
      () => parseHubSpotSupplement(extended),
      (error: unknown) => isMigrationError(error) && error.code === 'CONFIG_INVALID' && JSON.stringify(error.details).includes('defaultPipeline'),
    );
  });

  it('rejects a document that is not JSON', () => {
    assert.throws(() => parseHubSpotSupplement('portalId: 24681012'), migrationErrorWith('CONFIG_INVALID', 'not well-formed JSON'));
  });

  it('rejects a portal id that is not digits, and a missing author', () => {
    assert.throws(
      () => parseHubSpotSupplement(JSON.stringify({ ...JSON.parse(SUPPLEMENT), portalId: 'acme-portal' })),
      migrationErrorWith('CONFIG_INVALID', 'does not match the HubSpot supplement schema'),
    );
    const { statedBy: _statedBy, ...withoutAuthor } = JSON.parse(SUPPLEMENT) as Record<string, unknown>;
    assert.throws(
      () => parseHubSpotSupplement(JSON.stringify(withoutAuthor)),
      migrationErrorWith('CONFIG_INVALID', 'does not match the HubSpot supplement schema'),
    );
  });

  it('rejects a capture time that is not a date on the calendar', () => {
    assert.throws(
      () => parseHubSpotSupplement(JSON.stringify({ ...JSON.parse(SUPPLEMENT), capturedAt: '2026-02-30T09:00:00Z' })),
      migrationErrorWith('CONFIG_INVALID', 'not a date on the calendar'),
    );
  });

  it('rejects two statements about one property', () => {
    const twice = JSON.stringify({
      ...JSON.parse(SUPPLEMENT),
      uniqueProperties: [
        { objectApiName: 'contacts', internalName: 'email', unique: 'TRUE' },
        { objectApiName: 'contacts', internalName: 'email', unique: 'FALSE' },
      ],
    });
    assert.throws(() => parseHubSpotSupplement(twice), migrationErrorWith('CONFIG_INVALID', 'twice, at entries 0 and 1'));
  });

  it('rejects a stated name carrying surrounding whitespace', () => {
    const padded = JSON.stringify({
      ...JSON.parse(SUPPLEMENT),
      uniqueProperties: [{ objectApiName: 'contacts', internalName: ' email', unique: 'TRUE' }],
    });
    assert.throws(() => parseHubSpotSupplement(padded), migrationErrorWith('CONFIG_INVALID', 'surrounding whitespace'));
  });

  it('rejects a stated name carrying a control character', () => {
    const forged = JSON.stringify({
      ...JSON.parse(SUPPLEMENT),
      uniqueProperties: [
        { objectApiName: 'contacts', internalName: `email${String.fromCharCode(0)}contacts`, unique: 'TRUE' },
      ],
    });
    assert.throws(() => parseHubSpotSupplement(forged), migrationErrorWith('CONFIG_INVALID', 'control character'));
  });
});

describe('building a HubSpot target contract', () => {
  const contacts = (): TargetObjectContract => parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS);
  const deals = (): TargetObjectContract =>
    parseHubSpotPropertyExport(DEAL_EXPORT, {
      objectApiName: 'deals',
      objectLabel: 'Deals',
      filePath: 'deals-properties.csv',
    });
  const supplement = (): HubSpotSupplement => parseHubSpotSupplement(SUPPLEMENT);
  const artifacts = (): TargetArtifactRef[] => [
    hubSpotArtifactRef('contacts-properties.csv', 'HUBSPOT_PROPERTY_EXPORT', contactExport()),
    hubSpotArtifactRef('deals-properties.csv', 'HUBSPOT_PROPERTY_EXPORT', DEAL_EXPORT),
    hubSpotArtifactRef('pipelines.csv', 'HUBSPOT_PIPELINE_ARTIFACT', PIPELINES),
    hubSpotArtifactRef('supplement.json', 'HUBSPOT_SUPPLEMENT', SUPPLEMENT),
  ];

  it('assembles the pieces and records where each fact came from', () => {
    const contract = buildHubSpotTargetContract({
      supplement: supplement(),
      objects: [contacts(), deals()],
      pipelines: parseHubSpotPipelines(PIPELINES),
      artifacts: artifacts(),
    });
    assert.equal(contract.instance.mode, 'HUBSPOT');
    assert.equal(contract.instance.instanceId, '24681012');
    assert.equal(contract.instance.evidence, 'SUPPLEMENT');
    assert.equal(contract.capturedAt, '2026-09-01T09:00:00Z');
    assert.deepEqual(
      contract.objects.map((object) => object.apiName),
      ['contacts', 'deals'],
    );
    assert.equal(contract.artifacts.length, 4);
    assert.equal(contract.pipelines.length, 2);
  });

  it('applies a stated uniqueness and records that field as SUPPLEMENT', () => {
    const contract = buildHubSpotTargetContract({
      supplement: supplement(),
      objects: [contacts(), deals()],
      pipelines: parseHubSpotPipelines(PIPELINES),
      artifacts: artifacts(),
    });
    const email = contract.objects[0]?.fields.find((field) => field.apiName === 'email');
    assert.equal(email?.unique, 'TRUE');
    assert.equal(email?.evidence, 'SUPPLEMENT');
    const stage = contract.objects[0]?.fields.find((field) => field.apiName === 'lifecyclestage');
    assert.equal(stage?.unique, 'UNKNOWN');
    assert.equal(stage?.evidence, 'ARTIFACT');
  });

  it('fails closed on a statement about a property no export carries', () => {
    const stated = parseHubSpotSupplement(
      JSON.stringify({
        ...JSON.parse(SUPPLEMENT),
        uniqueProperties: [{ objectApiName: 'contacts', internalName: 'legacy_id', unique: 'TRUE' }],
      }),
    );
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: stated,
          objects: [contacts()],
          pipelines: [],
          artifacts: [
            hubSpotArtifactRef('contacts-properties.csv', 'HUBSPOT_PROPERTY_EXPORT', contactExport()),
            hubSpotArtifactRef('supplement.json', 'HUBSPOT_SUPPLEMENT', SUPPLEMENT),
          ],
        }),
      migrationErrorWith('CONFIG_INVALID', 'does not carry'),
    );
  });

  it('fails closed on a pipeline whose object the capture does not carry', () => {
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [contacts()],
          pipelines: parseHubSpotPipelines(PIPELINES),
          artifacts: artifacts().filter((artifact) => artifact.path !== 'deals-properties.csv'),
        }),
      migrationErrorWith('CONFIG_INVALID', 'which the capture does not carry'),
    );
  });

  it('fails closed when the artifacts do not account for what the contract carries', () => {
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [contacts(), deals()],
          pipelines: parseHubSpotPipelines(PIPELINES),
          artifacts: artifacts().filter((artifact) => artifact.kind !== 'HUBSPOT_PIPELINE_ARTIFACT'),
        }),
      migrationErrorWith('CONFIG_INVALID', 'pipeline artifacts'),
    );
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [contacts()],
          pipelines: [],
          artifacts: [hubSpotArtifactRef('contacts-properties.csv', 'HUBSPOT_PROPERTY_EXPORT', contactExport())],
        }),
      migrationErrorWith('CONFIG_INVALID', 'supplement artifacts where exactly one belongs'),
    );
  });

  it('refuses the same bytes recorded twice', () => {
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [contacts()],
          pipelines: [],
          artifacts: [
            hubSpotArtifactRef('contacts-properties.csv', 'HUBSPOT_PROPERTY_EXPORT', contactExport()),
            hubSpotArtifactRef('contacts-properties-copy.csv', 'HUBSPOT_PROPERTY_EXPORT', contactExport()),
            hubSpotArtifactRef('supplement.json', 'HUBSPOT_SUPPLEMENT', SUPPLEMENT),
          ],
        }),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_DUPLICATE_FILE',
    );
  });

  it('refuses an artifact path that leaves the capture', () => {
    assert.throws(
      () => hubSpotArtifactRef('../elsewhere/contacts.csv', 'HUBSPOT_PROPERTY_EXPORT', contactExport()),
      migrationErrorWith('CONFIG_INVALID', 'not a relative path inside the capture'),
    );
    assert.throws(
      () => hubSpotArtifactRef('C:/exports/contacts.csv', 'HUBSPOT_PROPERTY_EXPORT', contactExport()),
      migrationErrorWith('CONFIG_INVALID', 'not a relative path inside the capture'),
    );
  });

  it('hashes the same bytes to the same contract, whatever order the pieces arrive in', () => {
    const first = buildHubSpotTargetContract({
      supplement: parseHubSpotSupplement(SUPPLEMENT),
      objects: [parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS), deals()],
      pipelines: parseHubSpotPipelines(PIPELINES),
      artifacts: artifacts(),
    });
    const second = buildHubSpotTargetContract({
      supplement: parseHubSpotSupplement(SUPPLEMENT),
      objects: [deals(), parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS)],
      pipelines: [...parseHubSpotPipelines(PIPELINES)].reverse(),
      artifacts: [...artifacts()].reverse(),
    });
    assert.deepEqual(second, first);
    assert.equal(hashTargetContract(second).contractHash, hashTargetContract(first).contractHash);
    assert.equal(hashTargetContract(first).contractHash, hashTargetContract(first).contractHash);
  });
});

/**
 * The two columns a real export carries and the documented prose does not.
 *
 * "Read only value" and "Calculated" were not read at all until a real export
 * from portal 51872453 was consumed on 2026-09-01. Discarding them left every
 * HubSpot property with updateability UNKNOWN, and a match authority refuses a
 * field whose updateability nobody established — so no HubSpot record could be
 * matched, and UPSERT and UPDATE_ONLY against HubSpot were unreachable.
 */
describe('what the export says about writing a property', () => {
  const HEADERS = 'Name,Internal name,Type,Group,Description,Options,Read only value,Calculated';
  const parse = (rows: readonly string[]): TargetObjectContract =>
    parseHubSpotPropertyExport([HEADERS, ...rows, ''].join('\n'), CONTACT_OPTIONS);

  it('reads a writable property as createable and updateable', () => {
    const [property] = parse(['Email,email,string,contactinformation,The email address,,false,false']).fields;
    assert.equal(property?.updateable, 'TRUE');
    assert.equal(property?.createable, 'TRUE');
    assert.equal(property?.calculated, 'FALSE');
  });

  it('reads a read-only property as neither createable nor updateable', () => {
    const [property] = parse(['Pageviews,hs_pageviews,number,analytics,Set automatically,,true,false']).fields;
    assert.equal(property?.updateable, 'FALSE');
    assert.equal(property?.createable, 'FALSE');
  });

  it('reads a computed property as calculated', () => {
    const [property] = parse(['Score,hs_score,number,analytics,Computed,,true,true']).fields;
    assert.equal(property?.calculated, 'TRUE');
  });

  it('leaves writability unknown when the export does not carry the column', () => {
    // The older export shape, and any future one that drops the column. Silence
    // must not read as "writable": that would authorise matching on a property
    // the portal will refuse to write.
    const object = parseHubSpotPropertyExport(contactExport(), CONTACT_OPTIONS);
    assert.equal(object.fields[0]?.updateable, 'UNKNOWN');
    assert.equal(object.fields[0]?.createable, 'UNKNOWN');
    assert.equal(object.fields[0]?.calculated, 'UNKNOWN');
  });

  it('leaves writability unknown when the cell says something it does not understand', () => {
    const [property] = parse(['Email,email,string,contactinformation,The email address,,yes,perhaps']).fields;
    assert.equal(property?.updateable, 'UNKNOWN');
    assert.equal(property?.calculated, 'UNKNOWN');
  });

  it('does not read "read only definition" as read only value', () => {
    // They are different facts, and conflating them would make almost every
    // HubSpot-defined property unwritable: the portal ships them with editable
    // values and locked definitions. `email` is exactly such a property.
    const object = parseHubSpotPropertyExport(
      [
        'Name,Internal name,Type,Group,Description,Options,Read only value,Read only definition',
        'Email,email,string,contactinformation,The email address,,false,true',
        '',
      ].join('\n'),
      CONTACT_OPTIONS,
    );
    assert.equal(object.fields[0]?.updateable, 'TRUE');
  });
});

/**
 * The properties API capture.
 *
 * The cases below are hostile in a different way from the export's. The bytes
 * are a response rather than a spreadsheet, so nothing here has to guess at a
 * delimiter or a column spelling; what it has to do instead is refuse an error
 * body that parses perfectly, refuse a page of a list read as the list, and
 * never let a key nobody declared reach a contract.
 *
 * The fixture mirrors the shape of the 2026-09-04 capture of portal 51872453
 * (402 contact properties, `email` and `hs_additional_emails` and
 * `hs_unique_creation_key` unique) rather than an imagined one, cut down to the
 * two properties the export fixtures in this file already use so the two readers
 * can be held against each other.
 */
const API_CONTACTS = JSON.stringify({
  results: [
    {
      name: 'email',
      label: 'Email',
      type: 'string',
      fieldType: 'text',
      description: 'The email address',
      groupName: 'contactinformation',
      options: [],
      calculated: false,
      hasUniqueValue: true,
      modificationMetadata: { archivable: true, readOnlyDefinition: true, readOnlyValue: false },
    },
    {
      name: 'lifecyclestage',
      label: 'Lifecycle Stage',
      type: 'enumeration',
      fieldType: 'radio',
      description: 'Where the contact is',
      groupName: 'contactinformation',
      options: [
        { label: 'Subscriber', value: 'subscriber', displayOrder: 0, hidden: false },
        { label: 'Lead', value: 'lead', displayOrder: 1, hidden: false },
        { label: 'Customer', value: 'customer', displayOrder: 2, hidden: true },
      ],
      calculated: false,
      hasUniqueValue: false,
      modificationMetadata: { readOnlyValue: false },
    },
  ],
});

const API_ORIGIN = {
  objectApiName: 'contacts',
  objectLabel: 'Contacts',
  // The portal the SUPPLEMENT above speaks for. The response carries no portal
  // id, so this is stated, and the contract builder compares the two.
  portalId: '24681012',
  portalIdSource: 'GET /account-info captured beside this response, portalId 24681012',
  filePath: 'contacts-properties-api.json',
};

/** The same two properties as an export, so an export and a capture can be compared. */
const MIRROR_EXPORT = [
  'Name,Internal name,Type,Group,Description,Options,Read only value,Calculated',
  'Email,email,string,contactinformation,The email address,,false,false',
  'Lifecycle Stage,lifecyclestage,enumeration,contactinformation,Where the contact is,Subscriber (subscriber);Lead (lead);Customer (customer),false,false',
  '',
].join('\n');

function apiBody(results: readonly unknown[]): string {
  return JSON.stringify({ results });
}

function apiCapture(text = API_CONTACTS): HubSpotPropertyApiCapture {
  return parseHubSpotPropertyApi(text, API_ORIGIN);
}

describe('the HubSpot properties API capture', () => {
  it('reads a properties response into fields the portal answers to', () => {
    const capture = apiCapture();
    assert.equal(capture.objectApiName, 'contacts');
    assert.equal(capture.object.apiName, 'contacts');
    assert.equal(capture.object.label, 'Contacts');
    assert.deepEqual(
      capture.object.fields.map((field) => field.apiName),
      ['email', 'lifecyclestage'],
    );
    const email = capture.object.fields[0];
    assert.equal(email?.label, 'Email');
    // The portal's own token, not a type of ours.
    assert.equal(email?.type, 'string');
    assert.equal(email?.evidence, 'ARTIFACT');
    // HubSpot has no record types, and no reading of any artifact establishes
    // whether the object itself accepts creates or updates.
    assert.deepEqual(capture.object.recordTypes, []);
    assert.equal(capture.object.createable, 'UNKNOWN');
  });

  it('carries hasUniqueValue through in both directions', () => {
    // The one fact no export can carry, and the fact that decides whether a
    // property may be a match key. TRUE and FALSE are both statements; neither
    // is the absence of one.
    const [email, stage] = apiCapture().object.fields;
    assert.equal(email?.unique, 'TRUE');
    assert.equal(stage?.unique, 'FALSE');
  });

  it('leaves what the response does not state UNKNOWN, never FALSE', () => {
    // A describe shows what its user can see. A key the response leaves out is
    // not-established rather than does-not-exist, and rounding it to FALSE would
    // disqualify a match key while looking like an answer.
    const [field] = apiCapture(apiBody([{ name: 'notes', label: 'Notes', type: 'string' }])).object.fields;
    assert.equal(field?.unique, 'UNKNOWN');
    assert.equal(field?.updateable, 'UNKNOWN');
    assert.equal(field?.createable, 'UNKNOWN');
    assert.equal(field?.calculated, 'UNKNOWN');
    assert.equal(field?.nillable, 'UNKNOWN');
    assert.equal(field?.restrictedPicklist, 'UNKNOWN');
    // Nothing in the response establishes these at all, for either reader.
    assert.equal(field?.externalId, 'UNKNOWN');
    assert.equal(field?.idLookup, 'UNKNOWN');
    assert.equal(field?.length, null);
    assert.deepEqual(field?.picklistValues, []);
  });

  it('reads readOnlyValue and calculated as each defeating writability on their own', () => {
    const fields = apiCapture(
      apiBody([
        { name: 'plain', label: 'Plain', type: 'string', calculated: false, modificationMetadata: { readOnlyValue: false } },
        { name: 'locked', label: 'Locked', type: 'string', calculated: false, modificationMetadata: { readOnlyValue: true } },
        { name: 'computed', label: 'Computed', type: 'number', calculated: true, modificationMetadata: { readOnlyValue: false } },
      ]),
    ).object.fields;
    assert.equal(fields[0]?.updateable, 'TRUE');
    assert.equal(fields[0]?.createable, 'TRUE');
    assert.equal(fields[1]?.updateable, 'FALSE');
    // A value the portal is about to overwrite is not one a migration delivers,
    // whatever readOnlyValue says about it.
    assert.equal(fields[2]?.updateable, 'FALSE');
    assert.equal(fields[2]?.calculated, 'TRUE');
  });

  it('derives writability exactly as the export reader does, for every combination', () => {
    // The two readers describe one portal and the contract builder refuses a
    // contract they disagree about, so a difference here would not be a
    // cosmetic difference: it would make every property where the two facts
    // point different ways unbuildable. They share one function, and this is
    // what says so.
    for (const readOnly of [true, false]) {
      for (const calculated of [true, false]) {
        const exported = parseHubSpotPropertyExport(
          [
            'Name,Internal name,Type,Group,Description,Options,Read only value,Calculated',
            `Thing,thing,string,g,d,,${String(readOnly)},${String(calculated)}`,
            '',
          ].join('\n'),
          CONTACT_OPTIONS,
        );
        const captured = apiCapture(
          apiBody([
            { name: 'thing', label: 'Thing', type: 'string', calculated, modificationMetadata: { readOnlyValue: readOnly } },
          ]),
        );
        const where = `readOnlyValue ${String(readOnly)}, calculated ${String(calculated)}`;
        assert.equal(captured.object.fields[0]?.updateable, exported.fields[0]?.updateable, where);
        assert.equal(captured.object.fields[0]?.createable, exported.fields[0]?.createable, where);
        assert.equal(captured.object.fields[0]?.calculated, exported.fields[0]?.calculated, where);
      }
    }
  });

  it('records the options as the response states them, hidden included', () => {
    // Nothing is split. The export has to recover a value from
    // "Subscriber (subscriber)"; the response states both, and a hidden option
    // is recorded as one the portal does not offer rather than dropped.
    const [, stage] = apiCapture().object.fields;
    assert.deepEqual(stage?.picklistValues, [
      { value: 'subscriber', label: 'Subscriber', active: true, defaultValue: false },
      { value: 'lead', label: 'Lead', active: true, defaultValue: false },
      { value: 'customer', label: 'Customer', active: false, defaultValue: false },
    ]);
  });

  it('tolerates a key it does not read, and reads nothing from it', () => {
    // HubSpot adds keys to this response over time, so an unknown key must not
    // fail the read. It must also never become authority: the three below are
    // named exactly as facts this reader carries, in a place the schema does not
    // declare, and every one of them has to come out UNKNOWN.
    const capture = apiCapture(
      apiBody([
        {
          name: 'notes',
          label: 'Notes',
          type: 'string',
          unique: true,
          updateable: true,
          readOnlyValue: false,
          dataSensitivity: 'non_sensitive',
        },
      ]),
    );
    const [field] = capture.object.fields;
    assert.equal(field?.apiName, 'notes');
    assert.equal(field?.unique, 'UNKNOWN');
    assert.equal(field?.updateable, 'UNKNOWN');
    // Tolerated, and recorded as ignored, so "the reader passes over it" is a
    // claim somebody can check rather than one they have to take on trust.
    assert.deepEqual(capture.ignoredKeys, [
      '/results/*/dataSensitivity',
      '/results/*/readOnlyValue',
      '/results/*/unique',
      '/results/*/updateable',
    ]);
  });

  it('names the keys it saw when the body is a failed request rather than a portal', () => {
    // A 401 or a missing-scope answer is well-formed JSON and parses perfectly.
    // Reported as a schema violation it would read as a shape problem instead of
    // as the record of a call that never described the portal at all.
    assert.throws(
      () =>
        parseHubSpotPropertyApi(
          JSON.stringify({
            status: 'error',
            message: 'This app has not been granted the crm.schemas.contacts.read scope',
            category: 'MISSING_SCOPES',
          }),
          API_ORIGIN,
        ),
      migrationErrorWith('INPUT_UNSUPPORTED', 'carries no "results"', '"category", "message", "status"'),
    );
  });

  it('refuses a body that is not JSON, naming the first line', () => {
    assert.throws(
      () => parseHubSpotPropertyApi('results: []', API_ORIGIN),
      migrationErrorWith('INPUT_UNSUPPORTED', 'not well-formed JSON', 'First line seen: "results: []"'),
    );
    assert.throws(
      () => parseHubSpotPropertyApi('[]', API_ORIGIN),
      migrationErrorWith('INPUT_UNSUPPORTED', 'is an array where the properties response is a JSON object'),
    );
  });

  it('refuses a declared key that arrives as something else', () => {
    // The other half of tolerating unknown keys. What the schema declares is
    // read strictly, so "true" the string is not hasUniqueValue the boolean.
    assert.throws(
      () => parseHubSpotPropertyApi(apiBody([{ name: 'a', label: 'A', type: 'string', hasUniqueValue: 'true' }]), API_ORIGIN),
      migrationErrorWith('INPUT_UNSUPPORTED', '/results/0/hasUniqueValue expected a boolean, received a string'),
    );
  });

  it('refuses one page of the property list', () => {
    // A page read as the whole list would put "this portal has no such
    // property" into a contract, which is worse than any refusal.
    assert.throws(
      () => parseHubSpotPropertyApi(JSON.stringify({ results: [], paging: { next: { after: '20' } } }), API_ORIGIN),
      migrationErrorWith('INPUT_UNSUPPORTED', 'carries a "paging" key', 'rather than all of them'),
    );
  });

  it('refuses an empty response, a repeated name and a name carrying whitespace', () => {
    assert.throws(
      () => parseHubSpotPropertyApi(apiBody([]), API_ORIGIN),
      migrationErrorWith('INPUT_CORRUPT', 'carries a results array and no properties'),
    );
    assert.throws(
      () =>
        parseHubSpotPropertyApi(
          apiBody([
            { name: 'a', label: 'A', type: 'string' },
            { name: 'a', label: 'Also A', type: 'string' },
          ]),
          API_ORIGIN,
        ),
      migrationErrorWith('INPUT_CORRUPT', 'lists the property "a" twice, at results[0] and results[1]'),
    );
    assert.throws(
      () => parseHubSpotPropertyApi(apiBody([{ name: ' a', label: 'A', type: 'string' }]), API_ORIGIN),
      migrationErrorWith('INPUT_CORRUPT', 'with surrounding whitespace'),
    );
  });

  it('refuses a portal id that is not a portal id, and one nobody says where they got', () => {
    // The response carries no portal id, so the only thing between a contract
    // and the wrong portal's properties is a stated one that can be checked.
    assert.throws(
      () => parseHubSpotPropertyApi(API_CONTACTS, { ...API_ORIGIN, portalId: 'na1-51872453' }),
      migrationErrorWith('CONFIG_INVALID', 'not the digits HubSpot writes a portal id as'),
    );
    assert.throws(
      () => parseHubSpotPropertyApi(API_CONTACTS, { ...API_ORIGIN, portalIdSource: '   ' }),
      migrationErrorWith('CONFIG_INVALID', 'names no source'),
    );
  });

  it('is one of the artifact kinds a contract can name', () => {
    assert.ok(HUBSPOT_ARTIFACT_KINDS.includes('HUBSPOT_PROPERTY_API'));
    const ref = hubSpotArtifactRef('contacts-properties-api.json', 'HUBSPOT_PROPERTY_API', API_CONTACTS);
    assert.equal(ref.kind, 'HUBSPOT_PROPERTY_API');
    assert.equal(ref.byteLength, new TextEncoder().encode(API_CONTACTS).length);
  });
});

describe('a contract built from the properties API', () => {
  const supplement = (): HubSpotSupplement => parseHubSpotSupplement(SUPPLEMENT);
  const apiRef = (): TargetArtifactRef =>
    hubSpotArtifactRef('contacts-properties-api.json', 'HUBSPOT_PROPERTY_API', API_CONTACTS);
  const supplementRef = (): TargetArtifactRef => hubSpotArtifactRef('supplement.json', 'HUBSPOT_SUPPLEMENT', SUPPLEMENT);
  const exportRef = (): TargetArtifactRef =>
    hubSpotArtifactRef('contacts-properties.csv', 'HUBSPOT_PROPERTY_EXPORT', MIRROR_EXPORT);
  const mirrored = (): TargetObjectContract =>
    parseHubSpotPropertyExport(MIRROR_EXPORT, {
      objectApiName: 'contacts',
      objectLabel: 'Contacts',
      filePath: 'contacts-properties.csv',
    });

  it('builds from a supplement and one capture, with no export anywhere', () => {
    // The minimum artifact set: one supplement, one property artifact of either
    // kind. The supplement is still required because the properties response
    // carries no portal id, no portal name and no capture time, and those are
    // the contract's instance identity and its capturedAt.
    const contract = buildHubSpotTargetContract({
      supplement: supplement(),
      objects: [],
      apiCaptures: [apiCapture()],
      pipelines: [],
      artifacts: [apiRef(), supplementRef()],
    });
    assert.equal(contract.instance.instanceId, '24681012');
    assert.equal(contract.instance.evidence, 'SUPPLEMENT');
    assert.equal(contract.capturedAt, '2026-09-01T09:00:00Z');
    assert.deepEqual(
      contract.objects.map((object) => object.apiName),
      ['contacts'],
    );
    assert.deepEqual(
      contract.artifacts.map((artifact) => artifact.kind),
      ['HUBSPOT_PROPERTY_API', 'HUBSPOT_SUPPLEMENT'],
    );
  });

  it('takes uniqueness from the portal rather than from the supplement agreeing with it', () => {
    // The supplement states contacts.email unique TRUE and the portal says so
    // too. Applying the statement would downgrade the portal's own answer to
    // somebody's agreement with it, so the field keeps ARTIFACT.
    const contract = buildHubSpotTargetContract({
      supplement: supplement(),
      objects: [],
      apiCaptures: [apiCapture()],
      pipelines: [],
      artifacts: [apiRef(), supplementRef()],
    });
    const email = contract.objects[0]?.fields.find((field) => field.apiName === 'email');
    assert.equal(email?.unique, 'TRUE');
    assert.equal(email?.evidence, 'ARTIFACT');
    // And a match is satisfiable from artifacts alone, which is the whole point:
    // on the export path this field's uniqueness could only ever be stated.
    assert.equal(email?.updateable, 'TRUE');
  });

  it('refuses a supplement that contradicts the portal', () => {
    const stated = parseHubSpotSupplement(
      JSON.stringify({
        ...JSON.parse(SUPPLEMENT),
        uniqueProperties: [{ objectApiName: 'contacts', internalName: 'email', unique: 'FALSE' }],
      }),
    );
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: stated,
          objects: [],
          apiCaptures: [apiCapture()],
          pipelines: [],
          artifacts: [apiRef(), supplementRef()],
        }),
      migrationErrorWith('CONFIG_INVALID', 'is unique FALSE and the captured artifact states TRUE'),
    );
  });

  it('refuses a capture taken from a portal the contract does not speak for', () => {
    // The failure this artifact kind exists to prevent, in one line: properties
    // from 51872453 filed under the portal the supplement names.
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [],
          apiCaptures: [parseHubSpotPropertyApi(API_CONTACTS, { ...API_ORIGIN, portalId: '51872453' })],
          pipelines: [],
          artifacts: [apiRef(), supplementRef()],
        }),
      migrationErrorWith('CONFIG_INVALID', 'was captured from portal 51872453', 'speaks for portal 24681012'),
    );
  });

  it('refuses a capture no artifact accounts for', () => {
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [mirrored()],
          apiCaptures: [apiCapture()],
          pipelines: [],
          artifacts: [exportRef(), supplementRef()],
        }),
      migrationErrorWith('CONFIG_INVALID', 'names 0 properties API artifacts and carries 1 API captures'),
    );
  });

  it('refuses a capture with no property artifact of either kind', () => {
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [],
          apiCaptures: [],
          pipelines: [],
          artifacts: [supplementRef()],
        }),
      migrationErrorWith('CONFIG_INVALID', 'neither a property export nor a properties API capture'),
    );
  });

  it('refuses two captures of one object', () => {
    const second = apiBody((JSON.parse(API_CONTACTS) as { results: unknown[] }).results.slice(0, 1));
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [],
          apiCaptures: [apiCapture(), parseHubSpotPropertyApi(second, { ...API_ORIGIN, filePath: 'again.json' })],
          pipelines: [],
          artifacts: [apiRef(), hubSpotArtifactRef('again.json', 'HUBSPOT_PROPERTY_API', second), supplementRef()],
        }),
      migrationErrorWith('CONFIG_INVALID', 'two properties responses for the object "contacts"'),
    );
  });
});

/**
 * The two readers policing each other.
 *
 * This is the check the fourth artifact kind is worth having for. An export and
 * a capture of one object are two readings of one portal, and if they contradict
 * each other they are not two facts: they are one portal described twice and at
 * most once correctly. Nothing here has a basis for preferring either, so the
 * build fails and names what was seen.
 */
describe('an export and a capture of the same object', () => {
  const supplement = (): HubSpotSupplement => parseHubSpotSupplement(SUPPLEMENT);
  const artifacts = (): TargetArtifactRef[] => [
    hubSpotArtifactRef('contacts-properties.csv', 'HUBSPOT_PROPERTY_EXPORT', MIRROR_EXPORT),
    hubSpotArtifactRef('contacts-properties-api.json', 'HUBSPOT_PROPERTY_API', API_CONTACTS),
    hubSpotArtifactRef('supplement.json', 'HUBSPOT_SUPPLEMENT', SUPPLEMENT),
  ];
  const mirrored = (): TargetObjectContract =>
    parseHubSpotPropertyExport(MIRROR_EXPORT, {
      objectApiName: 'contacts',
      objectLabel: 'Contacts',
      filePath: 'contacts-properties.csv',
    });
  const build = (capture: HubSpotPropertyApiCapture) =>
    buildHubSpotTargetContract({
      supplement: supplement(),
      objects: [mirrored()],
      apiCaptures: [capture],
      pipelines: [],
      artifacts: artifacts(),
    });

  it('produces one object when they agree, carrying what each of them establishes', () => {
    const contract = build(apiCapture());
    assert.equal(contract.objects.length, 1);
    const object = contract.objects[0];
    assert.equal(object?.fields.length, 2);
    const email = object?.fields.find((field) => field.apiName === 'email');
    // The export cannot state this and the capture can, so it is not a
    // disagreement: UNKNOWN never contradicts a statement.
    assert.equal(email?.unique, 'TRUE');
    // Both state this one, and both state the same thing.
    assert.equal(email?.updateable, 'TRUE');
    const stage = object?.fields.find((field) => field.apiName === 'lifecyclestage');
    assert.equal(stage?.unique, 'FALSE');
    // The capture's option list is kept where both state options and the values
    // agree: it carries whether an option is offered, which the export cannot.
    assert.deepEqual(
      stage?.picklistValues.map((option) => [option.value, option.active]),
      [
        ['subscriber', true],
        ['lead', true],
        ['customer', false],
      ],
    );
  });

  it('refuses a disagreement about a type, naming both readings', () => {
    const results = (JSON.parse(API_CONTACTS) as { results: { name: string }[] }).results.map((entry) =>
      entry.name === 'email' ? { ...entry, type: 'phone_number' } : entry,
    );
    assert.throws(
      () => build(parseHubSpotPropertyApi(apiBody(results), API_ORIGIN)),
      migrationErrorWith(
        'CONFIG_INVALID',
        'disagree about type on contacts.email',
        'the export states "string" and the capture states "phone_number"',
      ),
    );
  });

  it('refuses a disagreement about whether a property can be written', () => {
    const results = (JSON.parse(API_CONTACTS) as { results: { name: string }[] }).results.map((entry) =>
      entry.name === 'email' ? { ...entry, modificationMetadata: { readOnlyValue: true } } : entry,
    );
    assert.throws(
      () => build(parseHubSpotPropertyApi(apiBody(results), API_ORIGIN)),
      migrationErrorWith('CONFIG_INVALID', 'contacts.email', 'the export states TRUE and the capture states FALSE'),
    );
  });

  it('refuses two readings that describe different properties', () => {
    // The shape of the failure this whole change exists to prevent: an export of
    // a 209-field CONTACT and a capture of a 402-property one, both filed under
    // one portal. Here it is two properties against one.
    const results = (JSON.parse(API_CONTACTS) as { results: { name: string }[] }).results.filter(
      (entry) => entry.name === 'email',
    );
    assert.throws(
      () => build(parseHubSpotPropertyApi(apiBody(results), API_ORIGIN)),
      migrationErrorWith(
        'CONFIG_INVALID',
        'describe different properties of "contacts"',
        'the export carries 2 and the capture 1',
        'only in the export: "lifecyclestage"',
      ),
    );
  });
  it('reconciles the two readings however each caller spelled the object', () => {
    // The bypass this closes. Neither artifact states an object name: the export
    // takes it from its options and the capture from its origin, whose own
    // documentation prescribes the URL segment. So an export read as     // and a capture read as  were two keys, and the check built to
    // catch two readers disagreeing about one object saw two objects and let
    // both into the contract — the real 209-field export and the real 402-field
    // capture of one portal, side by side.
    //
    // Folding the spelling to the object the adapters name is what makes the
    // reconciliation reachable at all, so this asserts the agreement case
    // produces ONE object rather than two.
    const contract = buildHubSpotTargetContract({
      supplement: supplement(),
      objects: [
        parseHubSpotPropertyExport(MIRROR_EXPORT, {
          objectApiName: 'CONTACT',
          objectLabel: 'Contacts',
          filePath: 'contacts-properties.csv',
        }),
      ],
      apiCaptures: [apiCapture()],
      pipelines: [],
      artifacts: artifacts(),
    });
    assert.equal(contract.objects.length, 1, 'CONTACT and contacts are one object, not two');
  });

  it('refuses an object spelling that folds to nothing rather than admitting it', () => {
    // Admitting an unfoldable name is how the two readings drifted apart: it
    // enters under its own key, reconciles against nothing, and becomes a second
    // description of a portal that has one.
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [
            parseHubSpotPropertyExport(MIRROR_EXPORT, {
              objectApiName: 'kontakte',
              objectLabel: 'Contacts',
              filePath: 'contacts-properties.csv',
            }),
          ],
          apiCaptures: [apiCapture()],
          pipelines: [],
          artifacts: artifacts(),
        }),
      migrationErrorWith('CONFIG_INVALID', 'names the object "kontakte"'),
    );
  });
});

describe('the HubSpot access grant (MC-04b: object writeability is an instance fact the portal states)', () => {
  const GRANT = JSON.stringify({
    artifactKind: 'HUBSPOT_ACCESS_GRANT',
    accessGrantVersion: '1',
    portalId: '24681012',
    appId: '4242',
    capturedAt: '2026-09-01T09:00:00Z',
    statedBy: 'HubSpot POST /oauth/v2/private-apps/get/access-token-info, on the credential this capture used',
    scopes: ['crm.objects.contacts.write', 'crm.objects.contacts.read', 'crm.objects.deals.read', 'oauth'],
  });
  const supplement = (): HubSpotSupplement => parseHubSpotSupplement(SUPPLEMENT);
  const grantRef = (text = GRANT): TargetArtifactRef => hubSpotArtifactRef('access-grant.json', 'HUBSPOT_ACCESS_GRANT', text);
  const supplementRef = (): TargetArtifactRef => hubSpotArtifactRef('supplement.json', 'HUBSPOT_SUPPLEMENT', SUPPLEMENT);
  const apiRef = (): TargetArtifactRef =>
    hubSpotArtifactRef('contacts-properties-api.json', 'HUBSPOT_PROPERTY_API', API_CONTACTS);
  const deals = (): TargetObjectContract =>
    parseHubSpotPropertyExport(DEAL_EXPORT, { objectApiName: 'deals', objectLabel: 'Deals', filePath: 'deals-properties.csv' });
  const dealsRef = (): TargetArtifactRef => hubSpotArtifactRef('deals-properties.csv', 'HUBSPOT_PROPERTY_EXPORT', DEAL_EXPORT);
  const pipelinesRef = (): TargetArtifactRef => hubSpotArtifactRef('pipelines.csv', 'HUBSPOT_PIPELINE_ARTIFACT', PIPELINES);

  it('reads the portal, the app and the scopes, sorted and de-duplicated by nothing but the portal\'s spelling', () => {
    const grant = parseHubSpotAccessGrant(GRANT);
    assert.equal(grant.portalId, '24681012');
    assert.equal(grant.appId, '4242');
    assert.deepEqual(grant.scopes, ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'oauth']);
    assert.equal(HUBSPOT_ARTIFACT_KINDS.includes('HUBSPOT_ACCESS_GRANT'), true);
  });

  it('rejects an unknown key, a repeated scope, a token-shaped scope and a missing author', () => {
    assert.throws(
      () => parseHubSpotAccessGrant(JSON.stringify({ ...JSON.parse(GRANT), token: 'pat-x' })),
      migrationErrorWith('CONFIG_INVALID', 'access grant schema'),
    );
    assert.throws(
      () => parseHubSpotAccessGrant(JSON.stringify({ ...JSON.parse(GRANT), scopes: ['oauth', 'oauth'] })),
      migrationErrorWith('CONFIG_INVALID', 'more than once'),
    );
    assert.throws(
      () => parseHubSpotAccessGrant(JSON.stringify({ ...JSON.parse(GRANT), scopes: ['Bearer pat-na1-0000'] })),
      migrationErrorWith('CONFIG_INVALID', 'access grant schema'),
    );
    assert.throws(
      () => parseHubSpotAccessGrant(JSON.stringify({ ...JSON.parse(GRANT), statedBy: '' })),
      migrationErrorWith('CONFIG_INVALID', 'access grant schema'),
    );
  });

  it('without a grant the object flags stay UNKNOWN, exactly as before', () => {
    const contract = buildHubSpotTargetContract({
      supplement: supplement(),
      objects: [deals()],
      apiCaptures: [apiCapture()],
      pipelines: parseHubSpotPipelines(PIPELINES),
      artifacts: [apiRef(), dealsRef(), pipelinesRef(), supplementRef()],
    });
    for (const object of contract.objects) {
      assert.equal(object.createable, 'UNKNOWN');
      assert.equal(object.updateable, 'UNKNOWN');
    }
  });

  it('with a grant, the write scope makes the object createable and updateable, and its absence makes both FALSE', () => {
    const contract = buildHubSpotTargetContract({
      supplement: supplement(),
      objects: [deals()],
      apiCaptures: [apiCapture()],
      pipelines: parseHubSpotPipelines(PIPELINES),
      artifacts: [apiRef(), dealsRef(), pipelinesRef(), supplementRef(), grantRef()],
      accessGrant: parseHubSpotAccessGrant(GRANT),
    });
    const contacts = contract.objects.find((object) => object.apiName === 'contacts');
    const dealsObject = contract.objects.find((object) => object.apiName === 'deals');
    assert.equal(contacts?.createable, 'TRUE');
    assert.equal(contacts?.updateable, 'TRUE');
    // deals.read is granted, deals.write is not: the portal would refuse the write, so the contract says so.
    assert.equal(dealsObject?.createable, 'FALSE');
    assert.equal(dealsObject?.updateable, 'FALSE');
    // The grant is one of the artifacts the contract names, hashed like the others.
    assert.equal(contract.artifacts.filter((artifact) => artifact.kind === 'HUBSPOT_ACCESS_GRANT').length, 1);
    // Field-level facts are untouched by the grant.
    const email = contacts?.fields.find((field) => field.apiName === 'email');
    assert.equal(email?.unique, 'TRUE');
    assert.equal(email?.evidence, 'ARTIFACT');
  });

  it('the flags enter the contract hash: the same capture with and without the grant are two contracts', () => {
    const without = hashTargetContract(
      buildHubSpotTargetContract({
        supplement: supplement(),
        objects: [],
        apiCaptures: [apiCapture()],
        pipelines: [],
        artifacts: [apiRef(), supplementRef()],
      }),
    );
    const withGrant = hashTargetContract(
      buildHubSpotTargetContract({
        supplement: supplement(),
        objects: [],
        apiCaptures: [apiCapture()],
        pipelines: [],
        artifacts: [apiRef(), supplementRef(), grantRef()],
        accessGrant: parseHubSpotAccessGrant(GRANT),
      }),
    );
    assert.notEqual(without.contractHash, withGrant.contractHash);
  });

  it('fails closed on a grant about another portal', () => {
    const foreign = JSON.stringify({ ...JSON.parse(GRANT), portalId: '99999999' });
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [],
          apiCaptures: [apiCapture()],
          pipelines: [],
          artifacts: [apiRef(), supplementRef(), grantRef(foreign)],
          accessGrant: parseHubSpotAccessGrant(foreign),
        }),
      migrationErrorWith('CONFIG_INVALID', 'answered by portal 99999999', 'speaks for portal 24681012'),
    );
  });

  it('fails closed when the grant and its artifact do not account for each other', () => {
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [],
          apiCaptures: [apiCapture()],
          pipelines: [],
          artifacts: [apiRef(), supplementRef()],
          accessGrant: parseHubSpotAccessGrant(GRANT),
        }),
      migrationErrorWith('CONFIG_INVALID', '0 access grant artifacts', 'carries one access grant'),
    );
    assert.throws(
      () =>
        buildHubSpotTargetContract({
          supplement: supplement(),
          objects: [],
          apiCaptures: [apiCapture()],
          pipelines: [],
          artifacts: [apiRef(), supplementRef(), grantRef()],
        }),
      migrationErrorWith('CONFIG_INVALID', '1 access grant artifacts', 'carries no access grant'),
    );
  });

  it('names the write scope of each canonical object and refuses an object it does not admit', () => {
    assert.equal(hubSpotWriteScopeFor('contacts', 'test'), 'crm.objects.contacts.write');
    assert.equal(hubSpotWriteScopeFor('COMPANY', 'test'), 'crm.objects.companies.write');
    assert.equal(hubSpotWriteScopeFor('Deal', 'test'), 'crm.objects.deals.write');
    assert.throws(() => hubSpotWriteScopeFor('tickets', 'test'), migrationErrorWith('CONFIG_INVALID', 'names the object "tickets"'));
  });
});
