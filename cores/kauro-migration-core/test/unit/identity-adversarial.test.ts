import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONFIG_SCHEMA_VERSION } from '../../src/domain/config.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import { writeAndPromotePackage } from '../../src/artifacts/write-package.js';
import { verifyPackage } from '../../src/verify/verify-package.js';
import { renderCsv } from '../../src/artifacts/csv-writer.js';
import { caseScratch, readJsonArtifact, readTable, repoRoot, scratchDir, verifyScratch } from '../support/harness.js';
import { textField } from '../support/inline.js';

/**
 * Adversarial identity (F-27), on synthetic files written by the test.
 *
 * Every expectation below is stated from the input. The engine's identity
 * contract is three classes kept apart: a proven identity (same source record
 * id in one identity space, or the same declared authoritative external id),
 * which is merged; supporting evidence (a shared email, phone, full name or
 * company domain), which is reported as a duplicate candidate and changes
 * nothing; and a contradiction inside a proven identity, which sets the record
 * aside. A batch decision downstream can only be as good as these classes, so
 * the attacks are the ones that would blur them.
 */

interface SourceFile {
  readonly id: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

interface Bundle {
  readonly packageDir: string;
  readonly verified: boolean;
  readonly packageBytes: Map<string, string>;
}

function runBundle(name: string, files: readonly SourceFile[], records: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): Bundle {
  const root = scratchDir('identity-adversarial', name);
  const inputDir = join(root, 'input');
  mkdirSync(inputDir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(inputDir, `${file.id}.csv`), Buffer.from(renderCsv([...file.headers], file.rows.map((row) => [...row])), 'utf8'));
  }
  const config = {
    configVersion: CONFIG_SCHEMA_VERSION,
    source: { system: 'generic_csv', namespace: name },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    files: files.map((file) => ({ id: file.id, path: `${file.id}.csv`, format: 'CSV' })),
    records,
    ...extra,
  };
  const loaded = loadConfig(JSON.stringify(config), `inline:${name}`);
  const run = runMigration({
    scratch: caseScratch(`identity-adversarial-${name}`),
    inputRoot: inputDir,
    config: loaded.config,
    configHash: loaded.configHash,
  });
  const packageDir = join(root, 'package');
  writeAndPromotePackage({ result: run, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: packageDir, force: true });
  const verification = verifyPackage(packageDir, { scratch: verifyScratch(packageDir) });
  const manifest = readJsonArtifact(packageDir, 'manifest.json') as { artifacts: { path: string; sha256: string }[] };
  const packageBytes = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  return { packageDir, verified: verification.passed, packageBytes };
}

const CONTACT_HEADERS = ['Contact ID', 'First', 'Last', 'Email', 'Phone'];
const contactFields = [
  textField('First', 'contact.firstName'),
  textField('Last', 'contact.lastName'),
  textField('Email', 'contact.email'),
  textField('Phone', 'contact.phone'),
];
const contactMapping = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'contacts',
  fileId: 'contacts',
  object: 'CONTACT',
  sourceRecordIdColumn: { header: 'Contact ID' },
  fields: contactFields,
  ...overrides,
});

const LEAD_HEADERS = ['Lead ID', 'First', 'Last', 'Company', 'Email', 'Phone'];
const leadMapping: Record<string, unknown> = {
  id: 'leads',
  fileId: 'leads',
  object: 'LEAD',
  sourceRecordIdColumn: { header: 'Lead ID' },
  fields: [
    textField('First', 'lead.firstName'),
    textField('Last', 'lead.lastName'),
    textField('Company', 'lead.company'),
    textField('Email', 'lead.email'),
    textField('Phone', 'lead.phone'),
  ],
};

function candidates(bundle: Bundle): readonly Readonly<Record<string, string>>[] {
  return readTable(bundle.packageDir, 'duplicate-candidates.csv').rows;
}

function clustersBySignal(bundle: Bundle, signal: string): Map<string, Set<string>> {
  const clusters = new Map<string, Set<string>>();
  for (const row of candidates(bundle)) {
    if (row.signal !== signal) continue;
    const members = clusters.get(row.cluster_id ?? '') ?? new Set<string>();
    members.add(`${row.file_path ?? ''}:${row.row_number ?? ''}`);
    clusters.set(row.cluster_id ?? '', members);
  }
  return clusters;
}

function merges(bundle: Bundle): unknown[] {
  return (readJsonArtifact(bundle.packageDir, 'merges.json') as { merges: unknown[] }).merges;
}

function dispositionsByRow(bundle: Bundle): Map<string, string> {
  return new Map(
    readTable(bundle.packageDir, 'source-lineage.csv').rows.map((row) => [`${row.file_path ?? ''}:${row.row_number ?? ''}`, row.disposition ?? '']),
  );
}

describe('[F-27] a Lead is reported as a probable duplicate the way a Contact is', () => {
  // Two web-form leads from one person: the commonest duplicate a Salesforce
  // or clean-only customer has. Section 7 makes a shared email, phone or full
  // name supporting evidence for any record, and LEAD is a first-class object
  // (section 0), so the evidence must be reported for it too.
  const bundle = runBundle(
    'lead-signals',
    [
      {
        id: 'leads',
        headers: LEAD_HEADERS,
        rows: [
          ['L-1', 'Dorothy', 'Vaughan', 'Computing Section', 'dorothy@computing.example', '+17575550198'],
          ['L-2', 'Dorothy', 'Vaughan', 'Computing Section', 'dorothy@computing.example', '+17575550198'],
          ['L-3', 'Mary', 'Jackson', 'Wind Tunnel', 'mary@tunnel.example', '+17575550111'],
        ],
      },
    ],
    [leadMapping],
  );

  it('verifies, and merges nothing: two lead ids are two records', () => {
    assert.equal(bundle.verified, true);
    assert.equal(merges(bundle).length, 0);
  });

  for (const signal of ['EMAIL_EXACT', 'PHONE_E164', 'NAME_EXACT']) {
    it(`reports the two Dorothy leads as one ${signal} cluster`, () => {
      const clusters = [...clustersBySignal(bundle, signal).values()];
      assert.deepEqual(clusters.map((members) => [...members].sort()), [['leads.csv:2', 'leads.csv:3']]);
    });
  }

  it('says why they were not merged: no proving evidence, no conflicting attribute', () => {
    for (const row of candidates(bundle)) {
      assert.equal(row.object, 'LEAD');
      assert.equal(row.not_merged_reason_code, 'IDENTITY_DISTINCT_NO_PROVING_EVIDENCE');
    }
  });
});

describe('[F-27] a Lead and a Contact with one email are two records and no evidence about each other', () => {
  const bundle = runBundle(
    'lead-contact-same-email',
    [
      { id: 'contacts', headers: CONTACT_HEADERS, rows: [['C-1', 'Ada', 'Lovelace', 'ada@analytical.example', '+12125550147']] },
      { id: 'leads', headers: LEAD_HEADERS, rows: [['L-1', 'Ada', 'Lovelace', 'Analytical Engines', 'ada@analytical.example', '+12125550147']] },
    ],
    [contactMapping(), leadMapping],
  );

  it('neither merges them nor reports them as one cluster', () => {
    assert.equal(bundle.verified, true);
    assert.equal(merges(bundle).length, 0);
    assert.equal(candidates(bundle).length, 0);
  });
});

describe('[F-27] supporting evidence never becomes proof', () => {
  const bundle = runBundle(
    'supporting-evidence',
    [
      {
        id: 'contacts',
        headers: CONTACT_HEADERS,
        rows: [
          // A role mailbox shared by two different people.
          ['C-1', 'Grace', 'Hopper', 'info@analytical.example', ''],
          ['C-2', 'Jean', 'Bartik', 'info@analytical.example', ''],
          // Plus-addressing: one mailbox to a person, two strings to a file.
          ['C-3', 'Ada', 'Lovelace', 'ada@analytical.example', ''],
          ['C-4', 'Ada', 'Lovelace', 'ada+crm@analytical.example', ''],
          // A Cyrillic "а" (U+0430) that looks like a Latin "a".
          ['C-5', 'Alan', 'Turing', 'alan@bletchley.example', ''],
          ['C-6', 'Alan', 'Turing', 'аlan@bletchley.example', ''],
          // One name in two Unicode spellings: precomposed and decomposed.
          ['C-7', 'José', 'García', 'jose@iberia.example', ''],
          ['C-8', 'José', 'García', 'jgarcia@iberia.example', ''],
          // Two CRM records that agree on everything but their record id.
          ['C-9', 'Katherine', 'Johnson', 'katherine@orbital.example', '+17575550163'],
          ['C-10', 'Katherine', 'Johnson', 'katherine@orbital.example', '+17575550163'],
        ],
      },
    ],
    [contactMapping()],
  );

  it('verifies and merges nothing at all', () => {
    assert.equal(bundle.verified, true);
    assert.equal(merges(bundle).length, 0);
    const delivered = [...dispositionsByRow(bundle).values()].filter((disposition) => disposition === 'OUTPUT');
    assert.equal(delivered.length, 10);
  });

  it('reports the shared role mailbox as a cluster with conflicting attributes', () => {
    const rows = candidates(bundle).filter((row) => row.signal === 'EMAIL_EXACT' && row.signal_value === 'info@analytical.example');
    assert.deepEqual(rows.map((row) => row.row_number).sort(), ['2', '3']);
    for (const row of rows) assert.equal(row.not_merged_reason_code, 'IDENTITY_CANDIDATE_CONFLICTING_ATTRIBUTES');
  });

  it('reports two records identical but for their record ids as a probable duplicate, never as one record', () => {
    const rows = candidates(bundle).filter((row) => row.signal_value === 'katherine@orbital.example');
    assert.deepEqual(rows.map((row) => row.row_number).sort(), ['10', '11']);
    for (const row of rows) assert.equal(row.not_merged_reason_code, 'IDENTITY_DISTINCT_NO_PROVING_EVIDENCE');
  });

  it('does not equate a plus-address, a look-alike character or another Unicode spelling with the original', () => {
    const emailValues = new Set(candidates(bundle).filter((row) => row.signal === 'EMAIL_EXACT').map((row) => row.signal_value));
    assert.deepEqual([...emailValues].sort(), ['info@analytical.example', 'katherine@orbital.example']);
    const names = new Set(candidates(bundle).filter((row) => row.signal === 'NAME_EXACT').map((row) => row.signal_value));
    // Ada (plus-address pair) and Alan (look-alike pair) share their exact
    // names, which is supporting evidence and nothing more; the two José
    // spellings are different strings and are not reported as one name.
    assert.deepEqual([...names].sort(), ['ada lovelace', 'alan turing', 'katherine johnson']);
  });
});

describe('[F-27] a chain of proofs is one record, and the chain does not depend on row order', () => {
  // Row 1 and row 2 share the authoritative external id X-1; row 2 and row 3
  // share the source record id C-2. All three are one record, though rows 1
  // and 3 share nothing directly.
  const headers = ['Contact ID', 'Legacy ID', 'First', 'Last', 'Email', 'Phone'];
  const chain: (readonly string[])[] = [
    ['C-1', 'X-1', 'Ada', 'Lovelace', 'ada@analytical.example', ''],
    ['C-2', 'X-1', 'Ada', 'Lovelace', '', ''],
    ['C-2', '', 'Ada', 'Lovelace', '', '+12125550147'],
    ['C-9', '', 'Grace', 'Hopper', 'grace@analytical.example', ''],
  ];
  const mapping = contactMapping({ authoritativeExternalIdColumns: [{ header: 'Legacy ID' }] });
  // One source namespace for all three, so the identity keys can be compared.
  const source = { source: { system: 'generic_csv', namespace: 'chain' } };
  const forward = runBundle('chain-forward', [{ id: 'contacts', headers, rows: chain }], [mapping], source);
  const again = runBundle('chain-again', [{ id: 'contacts', headers, rows: chain }], [mapping], source);
  const reversed = runBundle('chain-reversed', [{ id: 'contacts', headers, rows: [...chain].reverse() }], [mapping], source);

  it('merges exactly the three chained rows', () => {
    assert.equal(forward.verified, true);
    assert.equal(merges(forward).length, 1);
    const dispositions = dispositionsByRow(forward);
    assert.deepEqual(
      ['contacts.csv:2', 'contacts.csv:3', 'contacts.csv:4', 'contacts.csv:5'].map((row) => dispositions.get(row)),
      ['OUTPUT', 'MERGED_PROVEN', 'MERGED_PROVEN', 'OUTPUT'],
    );
  });

  it('produces byte-identical packages from identical input', () => {
    assert.deepEqual([...again.packageBytes], [...forward.packageBytes]);
  });

  it('merges the same rows when the file is written in the opposite order', () => {
    assert.equal(reversed.verified, true);
    const dispositions = dispositionsByRow(reversed);
    // Reversed, Grace is row 2 and the chain is rows 3 to 5.
    assert.equal(dispositions.get('contacts.csv:2'), 'OUTPUT');
    const chainRows = ['contacts.csv:3', 'contacts.csv:4', 'contacts.csv:5'].map((row) => dispositions.get(row));
    assert.equal(chainRows.filter((disposition) => disposition === 'OUTPUT').length, 1);
    assert.equal(chainRows.filter((disposition) => disposition === 'MERGED_PROVEN').length, 2);
    const delivered = readTable(reversed.packageDir, 'source-lineage.csv').rows.filter((row) => row.disposition === 'OUTPUT');
    const forwardDelivered = readTable(forward.packageDir, 'source-lineage.csv').rows.filter((row) => row.disposition === 'OUTPUT');
    assert.deepEqual(
      delivered.map((row) => row.record_identity_key).sort(),
      forwardDelivered.map((row) => row.record_identity_key).sort(),
      'the record a chain forms is named by the same smallest identity key whatever the row order',
    );
  });
});

describe('[F-27] a consent disagreement inside a proven identity is never resolved by policy', () => {
  const headers = ['Contact ID', 'First', 'Last', 'Email', 'Do Not Email'];
  const bundle = runBundle(
    'consent-conflict',
    [
      {
        id: 'contacts',
        headers,
        rows: [
          ['C-1', 'Ada', 'Lovelace', 'ada@analytical.example', 'true'],
          ['C-1', 'Ada', 'Lovelace', 'ada@analytical.example', 'false'],
        ],
      },
    ],
    [
      contactMapping({
        fields: [
          textField('First', 'contact.firstName'),
          textField('Last', 'contact.lastName'),
          textField('Email', 'contact.email'),
          { column: { header: 'Do Not Email' }, destinationField: 'contact.doNotEmail', semanticType: 'BOOLEAN' },
        ],
      }),
    ],
    {
      policies: {
        mergeFieldConflict: 'PREFER_SURVIVOR',
        mergeFieldConflictJustification: 'synthetic adversarial case: the policy must not reach a consent field',
      },
    },
  );

  it('sets the record aside rather than choosing either consent value', () => {
    assert.equal(bundle.verified, true);
    const dispositions = dispositionsByRow(bundle);
    assert.equal(dispositions.get('contacts.csv:2'), 'ISOLATED');
    const isolated = readTable(bundle.packageDir, 'isolated.csv').rows;
    assert.ok(
      isolated.some((row) => Object.values(row).includes('IDENTITY_MERGE_CONSENT_CONFLICT') || Object.values(row).includes('ISOLATED_IDENTITY_CONFLICT')),
      `isolated.csv carries ${JSON.stringify(isolated)}`,
    );
  });
});

describe('[F-27] a cluster is named by its members, so a decision about it can be referred to', () => {
  // A downstream decision ("these two are one person") is recorded against a
  // cluster. The cluster id is derived from the signal, the value and the
  // members' migration keys; members with source record ids keep their keys
  // when an unrelated row is added, so the reference survives a re-export
  // that only added rows elsewhere -- and changes when the membership does.
  const base: (readonly string[])[] = [
    ['C-1', 'Ada', 'Lovelace', 'ada@analytical.example', ''],
    ['C-2', 'Ada', 'Lovelace', 'ada@analytical.example', ''],
  ];
  const before = runBundle('cluster-before', [{ id: 'contacts', headers: CONTACT_HEADERS, rows: base }], [contactMapping({ identitySpace: 'crm' })], {
    source: { system: 'generic_csv', namespace: 'cluster-stability' },
  });
  const unrelated = runBundle(
    'cluster-unrelated-row',
    [{ id: 'contacts', headers: CONTACT_HEADERS, rows: [...base, ['C-3', 'Grace', 'Hopper', 'grace@analytical.example', '']] }],
    [contactMapping({ identitySpace: 'crm' })],
    { source: { system: 'generic_csv', namespace: 'cluster-stability' } },
  );
  const joined = runBundle(
    'cluster-new-member',
    [{ id: 'contacts', headers: CONTACT_HEADERS, rows: [...base, ['C-3', 'Ada', 'Lovelace', 'ada@analytical.example', '']] }],
    [contactMapping({ identitySpace: 'crm' })],
    { source: { system: 'generic_csv', namespace: 'cluster-stability' } },
  );
  const idsOf = (bundle: Bundle): string[] => [...clustersBySignal(bundle, 'EMAIL_EXACT').keys()];

  it('keeps the cluster id when an unrelated row is added', () => {
    assert.equal(idsOf(before).length, 1);
    assert.deepEqual(idsOf(unrelated), idsOf(before));
  });

  it('changes the cluster id when the membership changes', () => {
    assert.equal(idsOf(joined).length, 1);
    assert.notDeepEqual(idsOf(joined), idsOf(before));
  });
});

// Keep the harness honest: the file the engine read is the file the test wrote.
describe('[F-27] the adversarial inputs reach the engine as written', () => {
  it('writes the look-alike and decomposed spellings byte for byte', () => {
    const root = join(repoRoot(), 'tmp', 'test', 'identity-adversarial', 'supporting-evidence');
    const text = readFileSync(join(root, 'input', 'contacts.csv'), 'utf8');
    assert.ok(text.includes('аlan@bletchley.example'));
    assert.ok(text.includes('José'));
  });
});
