import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isMigrationError } from '../src/domain/errors.js';
import type { SemanticType } from '../src/domain/canonical.js';
import { loadConfig } from '../src/mapping/load-config.js';
import { runMigration } from '../src/run/run-migration.js';
import type { RunResult } from '../src/run/run-migration.js';
import { hashTargetContract, serializeTargetContract } from '../src/target/contract.js';
import type { HashedTargetContract, TargetContract, TargetFieldContract } from '../src/target/contract.js';
import { writeAndPromotePackage } from '../src/artifacts/write-package.js';
import { verifyPackage } from '../src/verify/verify-package.js';
import type { VerificationReport } from '../src/verify/verify-package.js';
import type { ScratchStore } from '../src/scratch/scratch-store.js';
import { attestContract, fixtureField, fixtureObjects } from '../tools/attestation-fixture.js';
import { caseScratch, repoRoot, scratchDir, verifyScratch } from './support/harness.js';

/**
 * The destination-permission boundary, end to end, as an acceptance matrix
 * (defects R-MC-TYPE and R-MC-ENUM; requirement MC-04).
 *
 * Twenty-five vectors, each run in the CRM modes it applies to (48 cases),
 * through the public boundary: runMigration -> writePackage -> the emitted
 * import CSV -> verifyPackage with the host's trusted target contract.
 *
 * - A permitted vector delivers both records with their exact values, the
 *   emitted bytes carry them, nothing is isolated, and the package verifies
 *   against the trusted contract. The same package is refused when the
 *   contract is withheld under `requireTargetContract`, when the body no
 *   longer hashes to the digest it is supplied under, and when a different
 *   valid contract is supplied.
 * - A denied vector writes nothing: either a typed refusal with a remedy, or
 *   both records isolated with a reason and no import row. A package that
 *   withheld everything still verifies.
 * - A legacy-unsafe vector is also produced the way the unrepaired engine
 *   produced it (the value written under a permissive twin of the contract),
 *   then bound to the strict contract's digest. Structural verification alone
 *   still passes that package -- it has no evidence about the destination --
 *   and verification against the trusted contract must refuse it.
 *
 * `verifyPackage` is called through a widened signature so that this file
 * compiles against a verifier that has no target options at all; against such
 * a verifier the target-aware assertions fail behaviourally, which is the
 * negative control this matrix was first run as.
 */

type Mode = 'HUBSPOT' | 'SALESFORCE';

interface Vector {
  readonly id: string;
  readonly modes?: readonly Mode[];
  /** The instance type token; ENUM_TYPE stands for the mode's vocabulary type. */
  readonly type: string;
  readonly semantic: SemanticType;
  readonly values: readonly [string, string];
  readonly expectedValues?: readonly [string, string];
  readonly options?: Readonly<Record<string, unknown>>;
  readonly restriction?: 'TRUE' | 'FALSE' | 'UNKNOWN';
  readonly eligible?: readonly string[];
  readonly labels?: readonly string[];
  readonly inactive?: boolean;
  readonly absent?: boolean;
  readonly unmapped?: boolean;
  readonly field?: Partial<TargetFieldContract>;
  readonly allow: boolean;
  /** The unrepaired engine delivered this vector's values; the verifier must refuse such a package. */
  readonly legacyUnsafe?: boolean;
}

const FIELD_NAMES: Readonly<Record<Mode, string>> = { HUBSPOT: 'qarvex_q71', SALESFORCE: 'Qarvex_Q71__c' };

const VECTORS: readonly Vector[] = [
  { id: 'type-string', type: 'string', semantic: 'TEXT', values: ['Active', 'Inactive'], allow: true },
  { id: 'type-string-case', type: ' String ', semantic: 'TEXT', values: ['Velmora', 'Tazriven'], allow: true },
  { id: 'type-time', type: 'time', semantic: 'TEXT', values: ['Active', 'Inactive'], allow: false, legacyUnsafe: true },
  { id: 'type-future', type: 'future_scalar', semantic: 'TEXT', values: ['Active', 'Inactive'], allow: false, legacyUnsafe: true },
  { id: 'type-held', type: 'scalar_qarvex_83', semantic: 'TEXT', values: ['Zelqorin', 'Nuvrashi'], allow: false, legacyUnsafe: true },
  {
    id: 'scalar-number',
    type: 'number',
    semantic: 'NUMBER',
    values: ['14.25', '27'],
    options: { decimalSeparator: '.', thousandsSeparator: 'NONE' },
    allow: true,
  },
  { id: 'scalar-boolean', type: 'boolean', semantic: 'BOOLEAN', values: ['true', 'false'], allow: true },
  { id: 'scalar-date', type: 'date', semantic: 'DATE', values: ['2026-02-17', '2026-03-21'], options: { dateFormat: 'ISO_8601' }, allow: true },
  { id: 'scalar-datetime', type: 'datetime', semantic: 'DATETIME', values: ['2026-02-17T13:24:05Z', '2026-03-21T07:08:09Z'], allow: true },
  {
    id: 'datetime-explicit-offset',
    modes: ['HUBSPOT'],
    type: 'datetime',
    semantic: 'DATETIME',
    values: ['2026-02-17T13:24:05+00:00', '2026-03-21T07:08:09+00:00'],
    expectedValues: ['2026-02-17T13:24:05Z', '2026-03-21T07:08:09Z'],
    allow: true,
  },
  { id: 'enum-known', type: 'ENUM_TYPE', semantic: 'ENUM', values: ['Active', 'Inactive'], restriction: 'TRUE', eligible: ['Active', 'Inactive'], allow: true },
  { id: 'enum-empty', type: 'ENUM_TYPE', semantic: 'ENUM', values: ['Active', 'Inactive'], restriction: 'TRUE', eligible: [], allow: false, legacyUnsafe: true },
  { id: 'enum-unknown', type: 'ENUM_TYPE', semantic: 'ENUM', values: ['Active', 'Inactive'], restriction: 'UNKNOWN', eligible: [], allow: false, legacyUnsafe: true },
  {
    id: 'enum-inactive',
    type: 'ENUM_TYPE',
    semantic: 'ENUM',
    values: ['Active', 'Inactive'],
    restriction: 'TRUE',
    eligible: ['Active', 'Inactive'],
    inactive: true,
    allow: false,
  },
  {
    id: 'enum-label-only',
    type: 'ENUM_TYPE',
    semantic: 'ENUM',
    values: ['Velmora', 'Tazriven'],
    restriction: 'TRUE',
    eligible: ['q71_internal_a', 'q71_internal_b'],
    labels: ['Velmora', 'Tazriven'],
    allow: false,
    legacyUnsafe: true,
  },
  { id: 'enum-open', modes: ['SALESFORCE'], type: 'picklist', semantic: 'ENUM', values: ['Velmora', 'Tazriven'], restriction: 'FALSE', eligible: [], allow: true },
  { id: 'field-absent', type: 'string', semantic: 'TEXT', values: ['Velmora', 'Tazriven'], absent: true, allow: false },
  { id: 'field-readonly', type: 'string', semantic: 'TEXT', values: ['Velmora', 'Tazriven'], field: { createable: 'FALSE', updateable: 'FALSE' }, allow: false },
  { id: 'field-write-unknown', type: 'string', semantic: 'TEXT', values: ['Velmora', 'Tazriven'], field: { createable: 'UNKNOWN' }, allow: false },
  { id: 'length-denied', type: 'string', semantic: 'TEXT', values: ['Velmora', 'Tazriven'], field: { length: 3 }, allow: false },
  { id: 'length-allowed', type: 'string', semantic: 'TEXT', values: ['Velmora', 'Tazriven'], field: { length: 8 }, allow: true },
  { id: 'required-unmapped', type: 'string', semantic: 'TEXT', values: ['Velmora', 'Tazriven'], field: { nillable: 'FALSE' }, unmapped: true, allow: false },
  { id: 'required-blank', type: 'string', semantic: 'TEXT', values: ['', ''], field: { nillable: 'FALSE' }, allow: false },
  { id: 'required-filled', type: 'string', semantic: 'TEXT', values: ['Velmora', 'Tazriven'], field: { nillable: 'FALSE' }, allow: true },
  {
    id: 'enum-held-empty',
    type: 'ENUM_TYPE',
    semantic: 'ENUM',
    values: ['Jorvexa71', 'Pelnuri82'],
    restriction: 'TRUE',
    eligible: [],
    allow: false,
    legacyUnsafe: true,
  },
];

/** The refusal codes a denied plan may be refused under. Each must carry a remedy. */
const SAFE_REFUSALS = new Set([
  'DESTINATION_FIELD_UNKNOWN',
  'DESTINATION_MODE_UNSUPPORTED',
  'DESTINATION_OBJECT_UNSUPPORTED',
  'MAPPING_INVALID',
  'TARGET_CONTRACT_INVALID',
  'VENDOR_CONSTRAINT_FAILED',
]);

type TargetAwareVerify = (
  packageDir: string,
  options: { readonly scratch: ScratchStore; readonly targetContract?: HashedTargetContract | null; readonly requireTargetContract?: boolean },
) => VerificationReport;
const verifyWithTarget = verifyPackage as unknown as TargetAwareVerify;

const cases = VECTORS.flatMap((vector) => (vector.modes ?? (['HUBSPOT', 'SALESFORCE'] as const)).map((mode) => ({ vector, mode })));

function vocabularyType(mode: Mode): string {
  return mode === 'HUBSPOT' ? 'enumeration' : 'picklist';
}

/** The field the vector describes, as the instance's capture would state it. */
function strictField(vector: Vector, mode: Mode): TargetFieldContract {
  return fixtureField(FIELD_NAMES[mode], 'Sealed field', vector.type === 'ENUM_TYPE' ? vocabularyType(mode) : vector.type, {
    restrictedPicklist: vector.restriction ?? 'FALSE',
    picklistValues: (vector.eligible ?? []).map((value, index) => ({
      value,
      label: vector.labels?.[index] ?? value,
      active: vector.inactive !== true,
      defaultValue: false,
    })),
    ...vector.field,
  });
}

/**
 * The same field as the unrepaired engine read it: a writable text field with
 * no vocabulary of its own. Producing under this and binding the result to
 * the strict contract reproduces a package the unrepaired engine emitted.
 */
function permissiveField(mode: Mode): TargetFieldContract {
  return fixtureField(FIELD_NAMES[mode], 'Sealed field', 'string');
}

function contractWith(mode: Mode, extra: TargetFieldContract | null): HashedTargetContract {
  const contactName = mode === 'HUBSPOT' ? 'contact' : 'Contact';
  const objects = fixtureObjects(mode).map((object) =>
    object.apiName === contactName && extra !== null ? { ...object, fields: [...object.fields, extra] } : object,
  );
  const contract: TargetContract = {
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: {
      mode,
      instanceId: mode === 'HUBSPOT' ? '00000071' : '00D000000000071',
      instanceLabel: 'target permission matrix instance',
      evidence: 'ARTIFACT',
    },
    artifacts: [{ path: 'describe/Contact.json', sha256: 'c'.repeat(64), byteLength: 10, kind: 'DESCRIBE' }],
    objects,
    pipelines: [],
  };
  return hashTargetContract(contract);
}

interface Prepared {
  readonly inputRoot: string;
  readonly config: ReturnType<typeof loadConfig>['config'];
  readonly configHash: string;
  readonly normalizedJson: ReturnType<typeof loadConfig>['normalizedJson'];
}

let serial = 0;

function prepare(vector: Vector, mode: Mode): Prepared {
  serial += 1;
  const root = scratchDir('target-permission', `input-${String(serial)}`);
  writeFileSync(
    join(root, 'contacts.csv'),
    'Contact ID,First Name,Last Name,Email,Phone,Status\n' +
      `1,Ada,Lovelace,ada@sealed.test,,${vector.values[0]}\n` +
      `2,Grace,Hopper,grace@sealed.test,,${vector.values[1]}\n`,
  );
  const apiName = FIELD_NAMES[mode];
  const options = { ...(vector.semantic === 'ENUM' ? { allowedValues: [...vector.values] } : {}), ...vector.options };
  const raw = {
    configVersion: '3.0.0',
    source: { system: 'legacy_crm', namespace: 'target-permission' },
    target: { mode, importMode: 'CREATE_ONLY' },
    destinationMatching: [],
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: { header: 'Contact ID' },
        fields: [
          { column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' },
          { column: { header: 'Last Name' }, destinationField: 'contact.lastName', semanticType: 'TEXT' },
          { column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' },
          ...(vector.unmapped === true
            ? []
            : [
                {
                  column: { header: 'Status' },
                  destinationField: `custom:${apiName}`,
                  semanticType: vector.semantic,
                  ...(Object.keys(options).length === 0 ? {} : { options }),
                },
              ]),
        ],
      },
    ],
  };
  const loaded = loadConfig(JSON.stringify(raw), join(root, 'config.json'));
  return { inputRoot: root, config: loaded.config, configHash: loaded.configHash, normalizedJson: loaded.normalizedJson };
}

interface Produced {
  readonly refused: { readonly code: string; readonly remedy: string; readonly message: string } | null;
  /** Every delivered record, by source record id, with the value it carries for the field. */
  readonly records: readonly { readonly id: string; readonly value: string | undefined }[];
  readonly isolated: readonly string[];
  readonly packageDir: string | null;
  /** The field's column in the emitted import file, sorted; empty when the column is absent. */
  readonly emitted: readonly string[];
}

function produce(prepared: Prepared, contract: HashedTargetContract, mode: Mode): Produced {
  serial += 1;
  let result: RunResult;
  try {
    result = runMigration({
      inputRoot: prepared.inputRoot,
      config: prepared.config,
      configHash: prepared.configHash,
      scratch: caseScratch(`target-permission-${String(serial)}`),
      targetContract: contract,
      ...attestContract(contract),
    });
  } catch (error: unknown) {
    if (!isMigrationError(error)) throw error;
    return { refused: { code: error.code, remedy: error.remedy, message: error.message }, records: [], isolated: [], packageDir: null, emitted: [] };
  }
  const apiName = FIELD_NAMES[mode];
  const packageDir = scratchDir('target-permission', `package-${String(serial)}`);
  writeAndPromotePackage({ result, config: prepared.config, normalizedConfig: prepared.normalizedJson, outputDir: packageDir, force: true });
  const table = csv(readFileSync(join(packageDir, '01_IMPORT', mode === 'HUBSPOT' ? 'hubspot/contacts.csv' : 'salesforce/Contact.csv'), 'utf8'));
  const at = table[0]?.indexOf(apiName) ?? -1;
  return {
    refused: null,
    records: [...result.truth.deliveredRecords]
      .map((record) => ({ id: String(record.sourceRecordId), value: record.values[`custom:${apiName}`] }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    isolated: [...result.truth.isolated].map((entry) => entry.reasonCode),
    packageDir,
    emitted: at < 0 ? [] : table.slice(1).map((row) => row[at] ?? '').sort(),
  };
}

function verifies(packageDir: string, trusted: HashedTargetContract | null | undefined): boolean {
  const scratch = verifyScratch(packageDir);
  try {
    const options = trusted === undefined ? { scratch } : { scratch, targetContract: trusted, requireTargetContract: true };
    return verifyWithTarget(packageDir, options).passed;
  } finally {
    scratch.dispose();
  }
}

/**
 * Bind a package to another contract digest, re-sealing every artifact that
 * named the old one, so the package is internally consistent and only its
 * content can give it away.
 */
function rebind(packageDir: string, contractHash: string): void {
  const manifestPath = join(packageDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    target: { targetContractHash: string | null };
    artifacts: { path: string; sha256: string; byteLength: number }[];
  };
  const previous = manifest.target.targetContractHash;
  assert.ok(typeof previous === 'string' && previous.length > 0, 'a CRM package names the contract it was shaped against');
  manifest.target.targetContractHash = contractHash;
  for (const artifact of manifest.artifacts) {
    const path = join(packageDir, ...artifact.path.split('/'));
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    if (!text.includes(previous)) continue;
    const next = Buffer.from(text.split(previous).join(contractHash), 'utf8');
    writeFileSync(path, next);
    artifact.sha256 = createHash('sha256').update(next).digest('hex');
    artifact.byteLength = next.length;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const c = text[index];
    if (c === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if (c === '\n' && !quoted) {
      row.push(value.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      value = '';
    } else value += c;
  }
  assert.equal(quoted, false, 'the import file is well-formed CSV');
  if (value !== '' || row.length > 0) {
    row.push(value.replace(/\r$/u, ''));
    rows.push(row);
  }
  return rows;
}

describe('MC-04 destination permission matrix: 25 vectors, 48 mode cases', () => {
  it('covers every vector in every mode it applies to', () => {
    assert.equal(VECTORS.length, 25);
    assert.equal(cases.length, 48);
    assert.equal(new Set(VECTORS.map((vector) => vector.id)).size, 25);
  });

  for (const { vector, mode } of cases) {
    const strict = (): HashedTargetContract => contractWith(mode, vector.absent === true ? null : strictField(vector, mode));

    if (vector.allow) {
      it(`${mode} ${vector.id}: both records deliver their exact values, the bytes carry them, and the package verifies against the trusted contract`, () => {
        const contract = strict();
        const out = produce(prepare(vector, mode), contract, mode);
        assert.equal(out.refused, null, out.refused?.message);
        const expected = vector.expectedValues ?? vector.values;
        assert.deepEqual(out.records, [
          { id: '1', value: expected[0] },
          { id: '2', value: expected[1] },
        ]);
        assert.deepEqual(out.emitted, [...expected].sort());
        assert.deepEqual(out.isolated, []);
        assert.equal(verifies(out.packageDir as string, contract), true, 'verifies against the contract it was shaped against');
      });

      it(`${mode} ${vector.id}: the same package is refused without the contract, under a stale body, and under a foreign contract`, () => {
        const contract = strict();
        const out = produce(prepare(vector, mode), contract, mode);
        assert.equal(out.refused, null, out.refused?.message);
        const packageDir = out.packageDir as string;
        assert.equal(verifies(packageDir, null), false, 'requireTargetContract with no contract supplied');
        const changed = structuredClone(contract.contract) as TargetContract & { objects: { apiName: string; fields: TargetFieldContract[] }[] };
        for (const object of changed.objects) object.fields = object.fields.filter((field) => field.apiName !== FIELD_NAMES[mode]);
        assert.equal(verifies(packageDir, { ...contract, contract: changed }), false, 'a changed body under the old digest');
        assert.equal(verifies(packageDir, hashTargetContract(changed)), false, 'a different valid contract');
      });
    } else {
      it(`${mode} ${vector.id}: nothing is written — a typed refusal with a remedy, or both records withheld with a reason and no import row`, () => {
        const contract = strict();
        const out = produce(prepare(vector, mode), contract, mode);
        if (out.refused !== null) {
          assert.ok(SAFE_REFUSALS.has(out.refused.code), `${out.refused.code}: ${out.refused.message}`);
          assert.ok(out.refused.remedy.length > 0, 'the refusal says what to do');
          return;
        }
        assert.deepEqual(out.records, [], 'no record is delivered');
        assert.deepEqual(out.emitted, [], 'no value reaches the import file');
        assert.equal(out.isolated.length, 2, 'both records are withheld');
        assert.ok(out.isolated.every((code) => code.length > 0));
        assert.equal(verifies(out.packageDir as string, contract), true, 'a package that withheld everything still verifies');
      });
    }

    if (vector.legacyUnsafe === true) {
      it(`${mode} ${vector.id}: the package the unrepaired engine emitted passes structure alone and is refused against the trusted contract`, () => {
        const contract = strict();
        const legacy = produce(prepare(vector, mode), contractWith(mode, permissiveField(mode)), mode);
        assert.equal(legacy.refused, null, legacy.refused?.message);
        assert.equal(legacy.records.length, 2, 'the permissive reading delivers both records');
        assert.deepEqual(legacy.emitted, [...vector.values].sort(), 'and the file carries the values');
        const packageDir = legacy.packageDir as string;
        rebind(packageDir, contract.contractHash);
        assert.equal(verifies(packageDir, undefined), true, 'structural verification has no evidence about the destination');
        assert.equal(verifies(packageDir, contract), false, 'verification against the trusted contract refuses what the instance does not take');
        // Neither a permissive body under the strict digest nor a permissive
        // contract under its own digest can stand in for the trusted one.
        const permissive = contractWith(mode, permissiveField(mode));
        assert.equal(verifies(packageDir, { ...contract, contract: permissive.contract }), false, 'a permissive body under the strict digest');
        assert.equal(verifies(packageDir, permissive), false, 'a permissive contract the package was not bound to');
      });
    }
  }
});

describe('the verify command takes the trusted contract', () => {
  const cli = join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
  const verifyCli = (packageDir: string, ...extra: string[]): number | null =>
    spawnSync(process.execPath, [cli, 'verify', '--package', packageDir, '--scratch', `${packageDir}.cli-verify`, ...extra], { encoding: 'utf8' }).status;
  const written = (contract: HashedTargetContract): string => {
    const path = join(scratchDir('target-permission', `contract-${String((serial += 1))}`), 'contract.json');
    writeFileSync(path, serializeTargetContract(contract));
    return path;
  };

  for (const mode of ['HUBSPOT', 'SALESFORCE'] as const) {
    it(`${mode}: exit 0 against the package's own contract, 1 against a foreign one or none when one is required, 0 on structure alone`, () => {
      const vector = VECTORS.find((entry) => entry.id === 'type-string') as Vector;
      const contract = contractWith(mode, strictField(vector, mode));
      const out = produce(prepare(vector, mode), contract, mode);
      const packageDir = out.packageDir as string;
      assert.equal(verifyCli(packageDir, '--target-contract', written(contract)), 0);
      assert.equal(verifyCli(packageDir, '--target-contract', written(contractWith(mode, null))), 1);
      assert.equal(verifyCli(packageDir, '--require-target-contract'), 1);
      assert.equal(verifyCli(packageDir), 0);
    });

    it(`${mode}: exit 1 on a package that carries a value the trusted contract's instance does not take`, () => {
      const vector = VECTORS.find((entry) => entry.id === 'enum-empty') as Vector;
      const contract = contractWith(mode, strictField(vector, mode));
      const legacy = produce(prepare(vector, mode), contractWith(mode, permissiveField(mode)), mode);
      const packageDir = legacy.packageDir as string;
      rebind(packageDir, contract.contractHash);
      assert.equal(verifyCli(packageDir), 0);
      assert.equal(verifyCli(packageDir, '--target-contract', written(contract)), 1);
    });
  }
});
