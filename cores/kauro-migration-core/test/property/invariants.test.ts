import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';

// A fixed seed, so a green run means the same corpus passed and not a lucky
// sample. The seed is arbitrary; what matters is that it does not move between
// runs, platforms or machines.
fc.configureGlobal({ seed: 20260829, verbose: 1 });
import { applyPermutation, contactSheet, materialize } from '../support/generate.js';
import { GOLDEN_ROOT, caseScratch, collect, listCases, readTable, repoRoot, runFixture, scratchDir } from '../support/harness.js';
import { packageDigest } from '../../src/artifacts/package-digest.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import { listPackageFiles, writeAndPromotePackage } from '../../src/artifacts/write-package.js';
import { applyFieldTransform } from '../../src/transform/apply.js';
import { CONFIG_SCHEMA_VERSION, DEFAULT_FIELD_OPTIONS, DEFAULT_LOCALE_EVIDENCE, DEFAULT_POLICIES } from '../../src/domain/config.js';
import type { FieldMappingConfig } from '../../src/domain/config.js';
import { SEMANTIC_TYPES } from '../../src/domain/canonical.js';
import type { SemanticType } from '../../src/domain/canonical.js';
import { isSentinelIdentifier, renderIdentityKey } from '../../src/domain/identity.js';

const RUNS = 200;

function runGenerated(name: string, sheet: Parameters<typeof materialize>[1], overrides = {}) {
  const { inputDir, configPath } = materialize(name, sheet, overrides);
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  return {
    loaded,
    result: runMigration({
      scratch: caseScratch('invariants1'), inputRoot: inputDir, config: loaded.config, configHash: loaded.configHash }),
  };
}

describe('P01 row conservation', () => {
  it('never loses a source row, whatever the sheet contains', () => {
    fc.assert(
      fc.property(contactSheet(), (sheet) => {
        const { result } = runGenerated('p01', sheet);
        const rows = result.reconciliation.sourceRows;
        // The number this test knows for itself: how many data rows it wrote.
        // Comparing the lineage against the reconciliation alone would be an
        // identity that no lost row could break.
        assert.equal(rows.ingested, sheet.rows.length, 'rows read');
        assert.equal(rows.total, sheet.rows.length, 'rows in the lineage');
        assert.equal(rows.accountedFor, sheet.rows.length, 'dispositions assigned');
        assert.equal(rows.withoutDisposition, 0);
        assert.equal(rows.equationHolds, true);
        assert.equal(new Set(collect(result.truth.lineage).map((entry) => entry.address.rowLocatorId)).size, rows.total);
      }),
      { numRuns: 60 },
    );
  });
});

describe('P02 no silent destruction', () => {
  const semanticType = fc.constantFrom(...SEMANTIC_TYPES);
  const value = fc.string({ minLength: 1, maxLength: 24 });

  it('an outcome that cannot commit always returns the source value', () => {
    fc.assert(
      fc.property(value, semanticType, fc.boolean(), (raw, type, trim) => {
        const field: FieldMappingConfig = {
          column: { header: 'X', occurrence: null, index: null },
          destinationField: 'contact.description',
          semanticType: type as SemanticType,
    semanticsClass: null,
          required: false,
          onAmbiguous: 'PRESERVE',
          onInvalid: 'PRESERVE',
          options: { ...DEFAULT_FIELD_OPTIONS, trim, allowedValues: type === 'ENUM' ? ['only'] : null },
        };

        const result = applyFieldTransform({
          cell: { columnIndex: 0, raw, kind: 'CSV_TEXT', formula: null, numberFormat: null, dateSystem: null },
          field,
          locale: DEFAULT_LOCALE_EVIDENCE,
          policies: DEFAULT_POLICIES,
          countryEvidence: null,
          countryEvidenceSource: 'none',
        });

        // The prime invariant: a populated cell never becomes empty without an
        // explicit destructive authorisation, which this field does not carry.
        assert.notEqual(result.final, null, `${type} emptied ${JSON.stringify(raw)}`);
        assert.notEqual(result.final, '', `${type} emptied ${JSON.stringify(raw)}`);
        assert.notEqual(result.safetyClass, 'DESTRUCTIVE_EXPLICITLY_AUTHORIZED');

        if (result.kind === 'AMBIGUOUS' || result.kind === 'INVALID' || result.kind === 'UNSUPPORTED') {
          assert.equal(result.final, raw, `${type} changed a value it could not interpret`);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('P03 determinism', () => {
  for (const caseId of listCases(GOLDEN_ROOT)) {
    it(`${caseId} produces identical artifacts twice`, () => {
      const first = runFixture(GOLDEN_ROOT, caseId, { scratchName: `det-a-${caseId}` });
      const second = runFixture(GOLDEN_ROOT, caseId, { scratchName: `det-b-${caseId}` });

      assert.equal(first.result.truth.runId, second.result.truth.runId, 'run id');
      assert.equal(first.written.manifestSha256, second.written.manifestSha256, 'manifest hash');
      assert.deepEqual(
        first.written.artifacts.map((artifact) => `${artifact.path}:${artifact.sha256}`),
        second.written.artifacts.map((artifact) => `${artifact.path}:${artifact.sha256}`),
        'artifact hashes',
      );
    });
  }
});

describe('P04 safe normalisation is idempotent', () => {
  const field = (type: SemanticType): FieldMappingConfig => ({
    column: { header: 'X', occurrence: null, index: null },
    destinationField: 'contact.description',
    semanticType: type,
    semanticsClass: null,
    required: false,
    onAmbiguous: 'PRESERVE',
    onInvalid: 'PRESERVE',
    options: { ...DEFAULT_FIELD_OPTIONS, phoneCountry: type === 'PHONE' ? 'US' : null },
  });

  const apply = (raw: string, type: SemanticType) =>
    applyFieldTransform({
      cell: { columnIndex: 0, raw, kind: 'CSV_TEXT', formula: null, numberFormat: null, dateSystem: null },
      field: field(type),
      locale: DEFAULT_LOCALE_EVIDENCE,
      policies: DEFAULT_POLICIES,
      countryEvidence: type === 'PHONE' ? 'US' : null,
      countryEvidenceSource: 'test',
    });

  it('applying a transformation to its own output changes nothing further', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 24 }),
        fc.constantFrom<SemanticType>('TEXT', 'EMAIL', 'PHONE', 'DATE', 'IDENTIFIER'),
        (raw, type) => {
          const once = apply(raw, type);
          if (once.final === null) return;
          const twice = apply(once.final, type);
          assert.equal(twice.final, once.final, `${type} kept changing ${JSON.stringify(raw)}`);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('P05 namespaced identity', () => {
  const key = (overrides: Partial<Parameters<typeof renderIdentityKey>[0]>): string =>
    renderIdentityKey({
      sourceSystem: 'crm',
      sourceNamespace: 'acme',
      identitySpace: 'contacts',
      objectType: 'CONTACT',
      keyKind: 'SOURCE_RECORD_ID',
      keyColumn: '',
      keyColumnAddress: '',
      sourceRecordId: '1',
      ...overrides,
    });

  it('the same raw id under different namespaces is a different key', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (id, namespaceA, namespaceB) => {
          fc.pre(namespaceA !== namespaceB);
          assert.notEqual(
            key({ sourceNamespace: namespaceA, sourceRecordId: id }),
            key({ sourceNamespace: namespaceB, sourceRecordId: id }),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('the same raw id in two id spaces is a different key', () => {
    // Contacts numbered from 1 and leads numbered from 1 are the ordinary case.
    assert.notEqual(key({ identitySpace: 'contacts' }), key({ identitySpace: 'leads' }));
  });

  it('the same raw id on two objects is a different key', () => {
    // A lead and a contact both numbered 1 are two records, not one, and a
    // lead is not a contact under another name.
    assert.notEqual(key({ objectType: 'CONTACT' }), key({ objectType: 'LEAD' }));
  });

  it('no pair of different key descriptions renders the same string', () => {
    // The forgery this guards against: a plain record id spelled to look like
    // an external-id key used to render byte-identically to one.
    const parts = ['', 'a', 'b', '|', String.fromCharCode(92), ':', 'ext', 'ext:', 'SAP ID', '900', 'ext:SAP ID:900'];
    fc.assert(
      fc.property(
        fc.constantFrom(...parts),
        fc.constantFrom(...parts),
        fc.constantFrom<'SOURCE_RECORD_ID' | 'EXTERNAL_ID'>('SOURCE_RECORD_ID', 'EXTERNAL_ID'),
        fc.constantFrom(...parts),
        fc.constantFrom(...parts),
        fc.constantFrom<'SOURCE_RECORD_ID' | 'EXTERNAL_ID'>('SOURCE_RECORD_ID', 'EXTERNAL_ID'),
        (columnA, idA, kindA, columnB, idB, kindB) => {
          const a = key({ keyColumn: columnA, sourceRecordId: idA, keyKind: kindA });
          const b = key({ keyColumn: columnB, sourceRecordId: idB, keyKind: kindB });
          const same = columnA === columnB && idA === idB && kindA === kindB;
          assert.equal(a === b, same, `${JSON.stringify([columnA, idA, kindA])} vs ${JSON.stringify([columnB, idB, kindB])}`);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('a separator inside a value cannot forge another namespace', () => {
    assert.notEqual(key({ sourceNamespace: 'one|contacts' }), key({ sourceNamespace: 'one' }));
  });

  it('export placeholders are not identifiers', () => {
    for (const sentinel of ['undefined', 'NULL', 'null', '#N/A', 'N/A', ' (null) ', '#REF!']) {
      assert.equal(isSentinelIdentifier(sentinel), true, sentinel);
    }
    for (const real of ['0', '1', 'C-1', 'nullify', '00123']) {
      assert.equal(isSentinelIdentifier(real), false, real);
    }
  });

  it('leaves ordinary short codes alone', () => {
    // NA, NONE and NIL were treated as placeholders and are not. They are
    // ordinary primary keys in division, region and segment tables, and
    // suppressing them made the engine report that no source record matched a
    // relationship endpoint whose record was delivered in the same package.
    for (const real of ['NA', 'na', 'NONE', 'none', 'NIL', 'nil', 'None']) {
      assert.equal(isSentinelIdentifier(real), false, real);
    }
  });
});

describe('P06 order invariance', () => {
  it('shuffling rows does not change which records are delivered', () => {
    fc.assert(
      fc.property(
        contactSheet({ minRows: 2, maxRows: 8 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 8, maxLength: 8 }),
        (sheet, permutation) => {
          const shuffled = { headers: sheet.headers, rows: applyPermutation(sheet.rows, permutation) };
          const base = runGenerated('p06-base', sheet);
          const other = runGenerated('p06-shuffled', shuffled);

          const summarise = (result: typeof base.result): string[] =>
            collect(result.truth.deliveredRecords)
              .map((record) => `${String(record.sourceRecordId)}|${JSON.stringify(record.values)}`)
              .sort();

          assert.deepEqual(summarise(other.result), summarise(base.result), 'delivered records');
          assert.equal(
            other.result.reconciliation.sourceRows.total,
            base.result.reconciliation.sourceRows.total,
          );
          assert.equal(other.result.reconciliation.cells.changed, base.result.reconciliation.cells.changed);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('P07 blank values never form a duplicate cluster', () => {
  it('any number of blank emails stays any number of records', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 25 }), (count) => {
        const rows = Array.from({ length: count }, (_, index) => [
          String(index + 1),
          `First${String(index)}`,
          `Last${String(index)}`,
          '',
        ]);
        const { result } = runGenerated('p07', {
          headers: ['Contact ID', 'First Name', 'Last Name', 'Email'],
          rows,
        });
        assert.equal(result.reconciliation.identity.duplicateCandidateClusters, 0);
        assert.equal(result.reconciliation.identity.provenMerges, 0);
        assert.equal(result.reconciliation.records.byObject.CONTACT, count);
      }),
      { numRuns: 25 },
    );
  });
});

describe('P08 association conservation', () => {
  for (const caseId of listCases(GOLDEN_ROOT)) {
    it(`${caseId} gives every source relationship exactly one disposition`, () => {
      const run = runFixture(GOLDEN_ROOT, caseId, { scratchName: `p08-${caseId}` });
      const associations = run.result.reconciliation.associations;

      // The number this property is about comes from the package on disk, not
      // from the array the dispositions are tallied out of. Comparing
      // `truth.edges.count` against `sourceEdges` was an identity — a
      // relationship could vanish between being built and being counted and
      // every assertion here still held. The manifest records how many
      // candidates were built, which is the one number a lost relationship
      // cannot take with it.
      const manifest = JSON.parse(readFileSync(join(run.packageDir, 'manifest.json'), 'utf8')) as {
        relationshipCandidates: number;
      };
      const ledger = readTable(run.packageDir, 'associations.csv').rows.length;
      assert.equal(associations.withoutDisposition, 0);
      assert.equal(associations.equationHolds, true);
      assert.equal(manifest.relationshipCandidates, ledger, 'the ledger holds every candidate');
      assert.equal(manifest.relationshipCandidates, associations.sourceEdges);
      assert.equal(
        Object.values(associations.byDisposition).reduce((sum, value) => sum + value, 0),
        manifest.relationshipCandidates,
        'the dispositions account for every candidate',
      );
      assert.equal(
        new Set(collect(run.result.truth.edges).map((edge) => edge.sourceEdgeId)).size,
        run.result.truth.edges.count,
        'edge ids are unique',
      );
      for (const edge of run.result.truth.edges) {
        assert.ok(edge.reasonCode.length > 0, 'every relationship carries a reason code');
      }
    });
  }
});

describe('generated packages still verify', () => {
  it('a randomly generated sheet produces a package that verifies', () => {
    fc.assert(
      fc.property(contactSheet({ minRows: 1, maxRows: 6 }), (sheet) => {
        const { inputDir, configPath } = materialize('verify-generated', sheet);
        const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
        const result = runMigration({
      scratch: caseScratch('invariants2'),
          inputRoot: inputDir,
          config: loaded.config,
          configHash: loaded.configHash,
        });
        const outputDir = scratchDir('generated-package');
        writeAndPromotePackage({
          result,
          config: loaded.config,
          normalizedConfig: loaded.normalizedJson,
          outputDir,
          force: true,
        });
      }),
      { numRuns: 25 },
    );
  });
});

describe('the host clock zone decides nothing', () => {
  // The same input and the same plan, run by the command line in child
  // processes whose TZ differs, must produce the same package to the byte.
  // The plan carries three ways of reading a local time — a declared zone with
  // its tzdata, a declared fixed offset, and no evidence at all — and the input
  // holds a summer time, a winter time, the repeated hour, and the missing hour.
  it('[S026] the host TZ does not move any delivered timestamp', () => {
    const root = scratchDir('host-tz');
    const inputDir = join(root, 'input');
    mkdirSync(inputDir, { recursive: true });
    const rows = [
      ['1', '2026-07-01T12:00:00', '2026-07-01T12:00:00', '2026-07-01T12:00:00'],
      ['2', '2026-01-15T12:00:00', '2026-01-15T12:00:00', '2026-01-15T12:00:00'],
      ['3', '2026-10-25T02:30:00', '2026-10-25T02:30:00', '2026-10-25T02:30:00'],
      ['4', '2026-03-29T02:30:00', '2026-03-29T02:30:00', '2026-03-29T02:30:00'],
      ['5', '2026-05-05T09:15:00+05:30', '2026-05-05T09:15:00+05:30', '2026-05-05T09:15:00+05:30'],
    ];
    writeFileSync(
      join(inputDir, 'events.csv'),
      `Event ID,In Madrid,At offset,Nowhere\n${rows.map((row) => row.join(',')).join('\n')}\n`,
    );
    const field = (header: string, destinationField: string, options: Record<string, unknown>) => ({
      column: { header },
      destinationField,
      semanticType: 'DATETIME',
      options,
    });
    const config = {
      configVersion: CONFIG_SCHEMA_VERSION,
      source: { system: 'generic_csv', namespace: 'host-tz' },
      target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
      files: [{ id: 'events', path: 'events.csv', format: 'CSV' }],
      records: [
        {
          id: 'events',
          fileId: 'events',
          object: 'CONTACT',
          sourceRecordIdColumn: { header: 'Event ID' },
          fields: [
            field('In Madrid', 'contact.createdAt', { timezone: { zone: 'Europe/Madrid', tzdata: process.versions.tz, overlap: 'EARLIER' } }),
            field('At offset', 'custom:seenAt', { timezoneOffset: '-05:00' }),
            field('Nowhere', 'custom:loggedAt', {}),
          ],
        },
      ],
    };
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const cli = join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
    const digests = new Map<string, string>();
    const importFiles = new Map<string, string>();
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland', 'Europe/Madrid']) {
      const out = join(root, `out-${zone.replace('/', '-')}`);
      const child = spawnSync(process.execPath, [cli, 'run', '--input', inputDir, '--config', configPath, '--out', out, '--force'], {
        encoding: 'utf8',
        env: { ...process.env, TZ: zone },
      });
      assert.equal(child.status, 0, `${zone}: ${child.stdout}${child.stderr}`);
      digests.set(zone, packageDigest(out).digest);
      importFiles.set(zone, readFileSync(join(out, '01_IMPORT', 'clean-only', 'contacts.csv'), 'utf8'));
    }
    assert.equal(new Set(digests.values()).size, 1, `the package depends on the host zone: ${JSON.stringify([...digests])}`);

    // And the timestamps are the ones worked out by hand from the input:
    // Madrid is UTC+2 in July and UTC+1 in January; the repeated hour takes its
    // EARLIER reading (+02:00); the missing hour is preserved as written; the
    // fixed offset is -05:00; a value with no evidence is preserved as written.
    const table = [...importFiles.values()][0] as string;
    for (const expected of [
      '2026-07-01T10:00:00Z',
      '2026-01-15T11:00:00Z',
      '2026-10-25T00:30:00Z',
      '2026-03-29T02:30:00',
      '2026-07-01T17:00:00Z',
      '2026-05-05T03:45:00Z',
    ]) {
      assert.ok(table.includes(expected), `${expected} is missing from the import file`);
    }
  });
});

describe('the environment decides nothing else (S034)', () => {
  // One subject, written by the test: names that sort differently in different
  // locales (a, B, a-umlaut, Z, e-acute, e, dotted and dotless I, sharp s), a
  // multi-line cell, a quoted comma and a date. It is run by the command line
  // in child processes with another TZ, LANG and LC_ALL each, and in process
  // with the CSV cut into blocks of every size down to one byte. Every package
  // must be the same package, byte for byte.
  it('[S034] canonical artifacts are identical under another TZ, locale and every chunk size, with variable metadata kept separate', () => {
    const root = scratchDir('environment-s034');
    const inputDir = join(root, 'input');
    mkdirSync(inputDir, { recursive: true });
    const rows = [
      ['a1', 'Zoe', 'zoe@example.com', '2026-03-01', 'plain'],
      ['B2', 'Äda', 'ada@example.com', '2026-03-02', 'two\nlines'],
      ['ä3', 'Émile', 'emile@example.com', '2026-03-03', 'a, "quoted" comma'],
      ['Z4', 'Zoë', 'zoe2@example.com', '2026-03-04', 'İstanbul'],
      ['é5', 'Eve', 'eve@example.com', '2026-03-05', 'i̇ dotted'],
      ['e6', 'Ida', 'ida@example.com', '2026-03-06', 'Straße'],
      ['ss7', 'Ivo', 'ivo@example.com', '2026-03-07', 'STRASSE'],
    ];
    const quote = (value: string) => (/[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
    writeFileSync(
      join(inputDir, 'contacts.csv'),
      `${['Contact ID', 'First Name', 'Email', 'Signed Up', 'Notes'].join(',')}\n${rows.map((row) => row.map(quote).join(',')).join('\n')}\n`,
    );
    const field = (header: string, destinationField: string, semanticType: string) => ({
      column: { header },
      destinationField,
      semanticType,
    });
    const config = {
      configVersion: CONFIG_SCHEMA_VERSION,
      source: { system: 'generic_csv', namespace: 's034' },
      target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
      files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
      records: [
        {
          id: 'contacts',
          fileId: 'contacts',
          object: 'CONTACT',
          sourceRecordIdColumn: { header: 'Contact ID' },
          fields: [
            field('First Name', 'contact.firstName', 'TEXT'),
            field('Email', 'contact.email', 'EMAIL'),
            field('Signed Up', 'contact.createdAt', 'DATE'),
            field('Notes', 'contact.description', 'TEXT'),
          ],
        },
      ],
    };
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    // 1. Another TZ, LANG and LC_ALL, by the command line.
    const cli = join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
    const environments = [
      { TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      { TZ: 'America/Los_Angeles', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' },
      { TZ: 'Asia/Kolkata', LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' },
      { TZ: 'Pacific/Auckland', LANG: 'C', LC_ALL: 'C' },
      { TZ: 'Europe/Madrid', LANG: 'sv_SE.UTF-8', LC_ALL: 'sv_SE.UTF-8' },
    ];
    // Node on Windows ignores TZ, LANG and LC_ALL and answers with the system's own
    // settings, so on this host the variation below is nominal and the claim that a
    // second operating system agrees is the cross-OS evidence's (tools/determinism-cross-os.mjs).
    // Where the environment is honoured, it must actually have varied, or the loop proves nothing.
    const resolvedZones = environments.map(
      (environment) =>
        spawnSync(process.execPath, ['-e', 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)'], {
          encoding: 'utf8',
          env: { ...process.env, ...environment },
        }).stdout,
    );
    if (process.platform !== 'win32') {
      assert.equal(new Set(resolvedZones).size, environments.length, `the child processes did not run in ${String(environments.length)} zones: ${resolvedZones.join(', ')}`);
    }
    const digests = new Map<string, string>();
    const packages: string[] = [];
    for (const environment of environments) {
      const label = `${environment.TZ}|${environment.LANG}`;
      const out = join(root, `out-${digests.size}`);
      const child = spawnSync(process.execPath, [cli, 'run', '--input', inputDir, '--config', configPath, '--out', out, '--force'], {
        encoding: 'utf8',
        env: { ...process.env, ...environment },
      });
      assert.equal(child.status, 0, `${label}: ${child.stdout}${child.stderr}`);
      digests.set(label, packageDigest(out).digest);
      packages.push(out);
    }
    assert.equal(new Set(digests.values()).size, 1, `the package depends on the environment: ${JSON.stringify([...digests])}`);
    const reference = [...digests.values()][0] as string;

    // 2. Every chunk size, in process: a block of one byte up to the default.
    // The option is proved to be honoured by counting the reads, so the test
    // cannot pass by passing the size to nothing.
    const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
    const sourceBytes = readFileSync(join(inputDir, 'contacts.csv')).length;
    for (const blockBytes of [1, 2, 3, 5, 7, 11, 64, 1_000, undefined]) {
      const out = join(root, `chunk-${String(blockBytes)}`);
      const original = fs.readSync;
      let reads = 0;
      fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
        reads += 1;
        return (original as (...a: unknown[]) => number)(...args);
      }) as typeof fs.readSync;
      syncBuiltinESMExports();
      try {
        const result = runMigration({
          scratch: caseScratch(`s034-${String(blockBytes)}`),
          inputRoot: inputDir,
          config: loaded.config,
          configHash: loaded.configHash,
          ...(blockBytes === undefined ? {} : { blockBytes }),
        });
        writeAndPromotePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: out, force: true });
      } finally {
        fs.readSync = original;
        syncBuiltinESMExports();
      }
      if (blockBytes !== undefined) {
        assert.ok(
          reads >= Math.ceil(sourceBytes / blockBytes),
          `a block size of ${String(blockBytes)} was not honoured: ${String(reads)} reads for ${String(sourceBytes)} bytes`,
        );
      }
      assert.equal(
        packageDigest(out).digest,
        reference,
        `cutting the CSV into ${String(blockBytes)}-byte blocks changed the package`,
      );
    }

    // 3. Variable metadata is kept out of the canonical artifacts: no host zone,
    // locale, output path or host name is inside any file of the package.
    const variable = [...environments.flatMap((environment) => [environment.TZ, environment.LANG]), ...packages, osHostname()].filter(
      (value) => value !== 'C' && value !== 'UTC' && value.length > 0,
    );
    const first = packages[0] as string;
    for (const path of listPackageFiles(first)) {
      const text = readFileSync(join(first, ...path.split('/')), 'utf8');
      for (const value of variable) {
        assert.ok(!text.includes(value), `${path} carries variable metadata: ${value}`);
      }
    }
  });
});
