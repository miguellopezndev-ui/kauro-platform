import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isMigrationError } from '../src/domain/errors.js';
import { loadConfig } from '../src/mapping/load-config.js';
import { runMigration } from '../src/run/run-migration.js';
import type { RunResult } from '../src/run/run-migration.js';
import { hashTargetContract } from '../src/target/contract.js';
import type { HashedTargetContract, TargetContract, TargetFieldContract, TargetPipeline } from '../src/target/contract.js';
import { writeAndPromotePackage } from '../src/artifacts/write-package.js';
import { verifyPackage } from '../src/verify/verify-package.js';
import { attestContract, fixtureField, fixtureObjects } from '../tools/attestation-fixture.js';
import { caseScratch, scratchDir, verifyScratch } from './support/harness.js';

/**
 * HubSpot's deal pipeline and deal stage, against the attested contract
 * (R-MC-PIPELINE, found by HSP-TARGET-01 on the 2.0.3 candidate).
 *
 * HubSpot keeps the options of `pipeline` and `dealstage` outside the
 * property (`externalOptions`): read as properties they are enumerations
 * with no option and no stated restriction, and the portal defines their
 * values as pipelines and stages, which a capture carries in the pipelines
 * artifact. The vocabulary rule of 2.0.3 read the property alone, called both
 * UNKNOWN, and refused every HubSpot deal plan — the adapter requires both
 * fields to create a deal — so the import qualification against portal
 * 51872453 stopped before its first write.
 *
 * The contract's pipelines are the vocabulary: a pipeline's internal name for
 * `pipeline`, a stage's internal name for `dealstage`, and a stage only inside
 * the pipeline the record names. Labels admit nothing, as for every other
 * option. A contract that captured no pipeline leaves both unknown and the
 * plan refused. The run and the verifier apply the one rule.
 */

const SALES: TargetPipeline = {
  objectApiName: 'DEAL',
  pipelineLabel: 'Sales Pipeline',
  pipelineInternalName: 'default',
  stages: [
    { stageLabel: 'Appointment Scheduled', stageInternalName: 'appointmentscheduled', displayOrder: 0 },
    { stageLabel: 'Closed Won', stageInternalName: 'closedwon', displayOrder: 5 },
  ],
};

const RENEWALS: TargetPipeline = {
  objectApiName: 'DEAL',
  pipelineLabel: 'Renewals',
  pipelineInternalName: '81234567',
  stages: [
    { stageLabel: 'Closed Won', stageInternalName: '81234601', displayOrder: 0 },
    { stageLabel: 'Renewal Due', stageInternalName: '81234602', displayOrder: 1 },
  ],
};

/** The two properties as a HubSpot capture states them: enumerations with no option and no stated restriction. */
function capturedAsHubSpotStatesThem(field: TargetFieldContract): TargetFieldContract {
  if (field.apiName !== 'dealstage' && field.apiName !== 'pipeline') return field;
  return { ...field, type: 'enumeration', restrictedPicklist: 'UNKNOWN', picklistValues: [], length: null };
}

function contractWith(pipelines: readonly TargetPipeline[], shape: (field: TargetFieldContract) => TargetFieldContract = capturedAsHubSpotStatesThem): HashedTargetContract {
  const objects = fixtureObjects('HUBSPOT').map((object) => (object.apiName === 'deal' ? { ...object, fields: object.fields.map(shape) } : object));
  const contract: TargetContract = {
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: { mode: 'HUBSPOT', instanceId: '00000072', instanceLabel: 'pipeline vocabulary instance', evidence: 'ARTIFACT' },
    artifacts: [{ path: 'pipelines.csv', sha256: 'd'.repeat(64), byteLength: 10, kind: 'HUBSPOT_PIPELINE_ARTIFACT' }],
    objects,
    pipelines: [...pipelines],
  };
  return hashTargetContract(contract);
}

/** The same deal properties as the unrepaired engine could be made to read them: writable text, no vocabulary at all. */
const permissive = (field: TargetFieldContract): TargetFieldContract =>
  field.apiName === 'dealstage' || field.apiName === 'pipeline' ? fixtureField(field.apiName, field.label, 'string') : field;

interface Deal {
  readonly id: string;
  readonly stage: string;
  readonly pipeline: string;
}

let serial = 0;

type Prepared = ReturnType<typeof loadConfig> & { readonly inputRoot: string; readonly deals: readonly Deal[] };

function prepare(deals: readonly Deal[], valueMaps: { stage?: Record<string, string>; pipeline?: Record<string, string> } = {}): Prepared {
  serial += 1;
  const root = scratchDir('target-pipeline', `input-${String(serial)}`);
  writeFileSync(join(root, 'deals.csv'), `Deal ID,Deal Name,Stage,Pipeline\n${deals.map((deal) => `${deal.id},Deal ${deal.id},${deal.stage},${deal.pipeline}`).join('\n')}\n`);
  const mapped = (map: Record<string, string> | undefined): Record<string, unknown> =>
    map === undefined ? {} : { options: { valueMap: Object.entries(map).map(([from, to]) => ({ from, to })) } };
  const raw = {
    configVersion: '3.0.0',
    source: { system: 'legacy_crm', namespace: 'target-pipeline' },
    target: { mode: 'HUBSPOT', importMode: 'CREATE_ONLY' },
    destinationMatching: [],
    files: [{ id: 'deals', path: 'deals.csv', format: 'CSV' }],
    records: [
      {
        id: 'deals',
        fileId: 'deals',
        object: 'DEAL',
        sourceRecordIdColumn: { header: 'Deal ID' },
        fields: [
          { column: { header: 'Deal Name' }, destinationField: 'deal.name', semanticType: 'TEXT' },
          { column: { header: 'Stage' }, destinationField: 'deal.stage', semanticType: 'TEXT', ...mapped(valueMaps.stage) },
          { column: { header: 'Pipeline' }, destinationField: 'deal.pipeline', semanticType: 'TEXT', ...mapped(valueMaps.pipeline) },
        ],
      },
    ],
  };
  return { ...loadConfig(JSON.stringify(raw), join(root, 'config.json')), inputRoot: root, deals };
}

interface Produced {
  readonly refused: { readonly code: string; readonly remedy: string; readonly message: string } | null;
  readonly delivered: readonly { readonly id: string; readonly stage: string | undefined; readonly pipeline: string | undefined }[];
  readonly isolated: readonly { readonly id: string; readonly reasonCode: string; readonly detail: string }[];
  readonly packageDir: string | null;
  readonly importText: string;
}

function produce(prepared: Prepared, contract: HashedTargetContract): Produced {
  serial += 1;
  let result: RunResult;
  try {
    result = runMigration({
      inputRoot: prepared.inputRoot,
      config: prepared.config,
      configHash: prepared.configHash,
      scratch: caseScratch(`target-pipeline-${String(serial)}`),
      targetContract: contract,
      ...attestContract(contract),
    });
  } catch (error: unknown) {
    if (!isMigrationError(error)) throw error;
    return { refused: { code: error.code, remedy: error.remedy, message: error.message }, delivered: [], isolated: [], packageDir: null, importText: '' };
  }
  const packageDir = scratchDir('target-pipeline', `package-${String(serial)}`);
  writeAndPromotePackage({ result, config: prepared.config, normalizedConfig: prepared.normalizedJson, outputDir: packageDir, force: true });
  let importText = '';
  try {
    importText = readFileSync(join(packageDir, '01_IMPORT', 'hubspot', 'deals.csv'), 'utf8');
  } catch {
    importText = '';
  }
  return {
    refused: null,
    delivered: [...result.truth.deliveredRecords]
      .map((record) => ({ id: String(record.sourceRecordId), stage: record.values['deal.stage'], pipeline: record.values['deal.pipeline'] }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    isolated: [...result.truth.isolated]
      // Row 1 is the header, so source row n is the (n - 1)th deal written.
      .map((entry) => ({ id: prepared.deals[entry.address.rowNumberSource - 2]?.id ?? `row ${String(entry.address.rowNumberSource)}`, reasonCode: entry.reasonCode, detail: entry.detail }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    packageDir,
    importText,
  };
}

type TargetAwareVerify = (
  packageDir: string,
  options: { readonly scratch: ReturnType<typeof verifyScratch>; readonly targetContract?: HashedTargetContract | null; readonly requireTargetContract?: boolean },
) => { readonly passed: boolean };
const verifyWithTarget = verifyPackage as unknown as TargetAwareVerify;

function verifies(packageDir: string, trusted: HashedTargetContract | undefined): boolean {
  const scratch = verifyScratch(packageDir);
  try {
    const options = trusted === undefined ? { scratch } : { scratch, targetContract: trusted, requireTargetContract: true };
    return verifyWithTarget(packageDir, options).passed;
  } finally {
    scratch.dispose();
  }
}

/** Bind a package to another contract digest, re-sealing every artifact that named the old one. */
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
    const text = readFileSync(path).toString('utf8');
    if (!text.includes(previous)) continue;
    const next = Buffer.from(text.split(previous).join(contractHash), 'utf8');
    writeFileSync(path, next);
    artifact.sha256 = createHash('sha256').update(next).digest('hex');
    artifact.byteLength = next.length;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('R-MC-PIPELINE: HubSpot deal pipeline and stage take their vocabulary from the captured pipelines', () => {
  it('a deal delivers its pipeline and stage by internal identity, and the package verifies against the contract', () => {
    const contract = contractWith([SALES, RENEWALS]);
    const out = produce(
      prepare([
        { id: 'D-1', stage: 'closedwon', pipeline: 'default' },
        { id: 'D-2', stage: '81234602', pipeline: '81234567' },
      ]),
      contract,
    );
    assert.equal(out.refused, null, out.refused?.message);
    assert.deepEqual(out.delivered, [
      { id: 'D-1', stage: 'closedwon', pipeline: 'default' },
      { id: 'D-2', stage: '81234602', pipeline: '81234567' },
    ]);
    assert.deepEqual(out.isolated, []);
    for (const value of ['closedwon', 'default', '81234602', '81234567']) assert.ok(out.importText.includes(value), `the import file carries ${value}`);
    assert.equal(verifies(out.packageDir as string, contract), true, 'verifies against the contract it was shaped against');
  });

  it('a label reaches the instance only through an explicit valueMap onto the internal name', () => {
    const contract = contractWith([SALES]);
    const labelled = [
      { id: 'D-1', stage: 'Closed Won', pipeline: 'Sales Pipeline' },
      { id: 'D-2', stage: 'Appointment Scheduled', pipeline: 'Sales Pipeline' },
    ];
    const bare = produce(prepare(labelled), contract);
    assert.equal(bare.refused, null, bare.refused?.message);
    assert.deepEqual(bare.delivered, [], 'no label is delivered');
    assert.equal(bare.isolated.length, 2);
    for (const entry of bare.isolated) {
      assert.equal(entry.reasonCode, 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN');
      assert.match(entry.detail, /display label/u);
    }
    assert.equal(bare.importText.includes('Closed Won'), false, 'no label reaches the import file');
    assert.equal(verifies(bare.packageDir as string, contract), true, 'a package that withheld both still verifies');

    const mapped = produce(
      prepare(labelled, {
        stage: { 'Closed Won': 'closedwon', 'Appointment Scheduled': 'appointmentscheduled' },
        pipeline: { 'Sales Pipeline': 'default' },
      }),
      contract,
    );
    assert.equal(mapped.refused, null, mapped.refused?.message);
    assert.deepEqual(mapped.delivered, [
      { id: 'D-1', stage: 'closedwon', pipeline: 'default' },
      { id: 'D-2', stage: 'appointmentscheduled', pipeline: 'default' },
    ]);
    assert.equal(verifies(mapped.packageDir as string, contract), true);
  });

  it('a stage is eligible only inside the pipeline the record names', () => {
    const contract = contractWith([SALES, RENEWALS]);
    const out = produce(
      prepare([
        { id: 'D-1', stage: '81234601', pipeline: 'default' },
        { id: 'D-2', stage: '81234601', pipeline: '81234567' },
      ]),
      contract,
    );
    assert.equal(out.refused, null, out.refused?.message);
    assert.deepEqual(out.delivered, [{ id: 'D-2', stage: '81234601', pipeline: '81234567' }]);
    assert.equal(out.isolated.length, 1);
    assert.equal(out.isolated[0]?.id, 'D-1');
    assert.equal(out.isolated[0]?.reasonCode, 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN');
    assert.match(out.isolated[0]?.detail ?? '', /not a stage of pipeline "default"/u);
    assert.equal(verifies(out.packageDir as string, contract), true);
  });

  it('a stage or a pipeline no captured pipeline declares is withheld', () => {
    const contract = contractWith([SALES]);
    const out = produce(
      prepare([
        { id: 'D-1', stage: 'closedwonn', pipeline: 'default' },
        { id: 'D-2', stage: 'closedwon', pipeline: 'renewals' },
      ]),
      contract,
    );
    assert.equal(out.refused, null, out.refused?.message);
    assert.deepEqual(out.delivered, []);
    assert.deepEqual(
      out.isolated.map((entry) => [entry.id, entry.reasonCode]),
      [
        ['D-1', 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN'],
        ['D-2', 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN'],
      ],
    );
  });

  it('a contract that captured no pipeline for deals leaves both unknown, and the plan is refused', () => {
    const out = produce(prepare([{ id: 'D-1', stage: 'closedwon', pipeline: 'default' }]), contractWith([]));
    assert.notEqual(out.refused, null, 'the plan is refused');
    assert.equal(out.refused?.code, 'DESTINATION_FIELD_UNKNOWN');
    assert.ok((out.refused?.remedy ?? '').length > 0, 'the refusal says what to do');
  });

  it('a pipeline artifact that names the object as the portal spells it is found', () => {
    const contract = contractWith([{ ...SALES, objectApiName: 'deals' }]);
    const out = produce(prepare([{ id: 'D-1', stage: 'closedwon', pipeline: 'default' }]), contract);
    assert.equal(out.refused, null, out.refused?.message);
    assert.deepEqual(out.delivered, [{ id: 'D-1', stage: 'closedwon', pipeline: 'default' }]);
  });

  it('the verifier applies the same rule to what a package carries', () => {
    const strict = contractWith([SALES, RENEWALS]);
    // Produced the way an engine that read the two properties as free text
    // would produce it, then bound to the strict contract's digest.
    const legacy = produce(
      prepare([
        { id: 'D-1', stage: '81234601', pipeline: 'default' },
        { id: 'D-2', stage: 'closedwon', pipeline: 'default' },
      ]),
      contractWith([], permissive),
    );
    assert.equal(legacy.refused, null, legacy.refused?.message);
    assert.equal(legacy.delivered.length, 2, 'the permissive reading delivers both');
    const packageDir = legacy.packageDir as string;
    rebind(packageDir, strict.contractHash);
    assert.equal(verifies(packageDir, undefined), true, 'structural verification has no evidence about the destination');
    assert.equal(verifies(packageDir, strict), false, 'a stage outside its pipeline is refused against the trusted contract');
  });
});
