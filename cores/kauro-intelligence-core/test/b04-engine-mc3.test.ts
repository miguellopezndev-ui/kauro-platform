/**
 * B04 engine on Migration Core 3.0.0 (lane L1).
 *
 * MC3-WS (D4-MC3-1): configuration schema 3.0.0 made whitespace a value — a
 * field trims only when its options say `trim: true` (MC D67). Each primitive's
 * options are decided here, one by one, with a fixture whose cell carries a
 * leading and a trailing space, run through Migration Core's own loadConfig and
 * runMigration both ways (trim off, trim on). There is no blanket default.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CONFIG_SCHEMA_VERSION, SCRATCH_BUDGET_BYTES, createFilesystemScratchStore, loadConfig, runMigration } from 'kauro-migration-core';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { fieldElementOf, optionsOfPrimitive } from '../src/adapter/migration-config.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceEnvelopeV1 } from '../src/contracts/envelope.js';
import type { ProposalItem } from '../src/contracts/proposal.js';
import { INTELLIGENCE_CORE_VERSION, MODEL_POLICY_VERSION, PROMPT_BUNDLE_VERSION, PROPOSAL_SCHEMA_VERSION, compatibilityMatrix } from '../src/contracts/versions.js';
import { scriptedGateway } from '../src/gateway/fake-gateway.js';
import type { ScriptEntry, ScriptPayload } from '../src/gateway/fake-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { ConfigFragmentField, IntelligenceInput, ProjectRevision } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';

/** What Migration Core made of one cell: the outcome, the value delivered (or preserved), and the reason. */
interface Delivered {
  readonly outcome: string;
  readonly value: string | null;
  readonly reason: string;
}

const fieldOf = (semanticType: string, transformPrimitive: string | null, typedTransformParams: Readonly<Record<string, string>> | null = null): ConfigFragmentField => ({
  recordId: 'source',
  fileId: 'source',
  filePath: 'source.csv',
  object: 'CONTACT',
  columnHeader: 'Value',
  columnLocator: 'loc-value',
  destinationField: 'custom:value',
  semanticType,
  required: false,
  onInvalid: 'PRESERVE',
  onAmbiguous: 'PRESERVE',
  transformPrimitive,
  typedTransformParams,
  decisionRef: 'dec-1',
  fragmentHash: '',
});

/** One cell through Migration Core 3.0.0: the field element the adapter writes (or with `trim` forced), a two-column CSV, loadConfig and runMigration. */
function deliver(field: ConfigFragmentField, raw: string, forceTrim?: boolean): Delivered {
  const made = fieldElementOf(field, 1);
  assert.ok('element' in made, JSON.stringify(made));
  const element = made.element as Record<string, unknown>;
  const options = { ...((element['options'] as Record<string, unknown> | undefined) ?? {}), ...(forceTrim === undefined ? {} : { trim: forceTrim }) };
  const document = {
    configVersion: CONFIG_SCHEMA_VERSION,
    source: { system: 'fixture', namespace: 'mc3-ws' },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    files: [{ id: 'source', path: 'source.csv', format: 'CSV' }],
    records: [{ id: 'source', fileId: 'source', object: 'CONTACT', sourceRecordIdColumn: { index: 0 }, fields: [{ ...element, ...(Object.keys(options).length > 0 ? { options } : {}) }] }],
  };
  const root = mkdtempSync(join(tmpdir(), 'ic-mc3-ws-'));
  try {
    writeFileSync(join(root, 'source.csv'), `ID,Value\n1,"${raw}"\n`);
    const loaded = loadConfig(JSON.stringify(document), join(root, 'config.json'));
    const scratch = createFilesystemScratchStore({ root: join(root, 'scratch'), runId: 'ws', quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      const run = runMigration({ inputRoot: root, config: loaded.config, configHash: loaded.configHash, scratch });
      const flag = [...run.truth.flags].find((entry) => entry.destinationField === 'custom:value');
      if (flag !== undefined) return { outcome: flag.outcome, value: flag.preservedValue, reason: flag.reasonCode };
      const change = [...run.truth.changes].find((entry) => entry.destinationField === 'custom:value');
      if (change !== undefined) return { outcome: 'CHANGED_SAFE', value: change.finalValue, reason: change.reasonCode };
      return { outcome: 'UNCHANGED', value: raw, reason: 'TRANSFORM_UNCHANGED' };
    } finally {
      scratch.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The decided whitespace behaviour per primitive (D4-MC3-1). `trimmed` is the
 * value delivered with the adapter's options; `untrimmed` is the outcome of the
 * same cell with `trim: false`, recorded so the decision is visible.
 */
const CASES: readonly { readonly name: string; readonly field: ConfigFragmentField; readonly raw: string; readonly decided: { readonly trim: boolean; readonly value: string }; readonly untrimmed: string }[] = [
  { name: 'no primitive (null)', field: fieldOf('TEXT', null), raw: '  Ada  ', decided: { trim: false, value: '  Ada  ' }, untrimmed: 'UNCHANGED' },
  { name: 'PRESERVE_AS_IS', field: fieldOf('TEXT', 'PRESERVE_AS_IS'), raw: '  Ada  ', decided: { trim: false, value: '  Ada  ' }, untrimmed: 'UNCHANGED' },
  { name: 'TRIM_WHITESPACE', field: fieldOf('TEXT', 'TRIM_WHITESPACE'), raw: '  Ada  ', decided: { trim: true, value: 'Ada' }, untrimmed: 'UNCHANGED' },
  { name: 'NORMALISE_EMAIL_CASE', field: fieldOf('EMAIL', 'NORMALISE_EMAIL_CASE'), raw: '  ada@Kauro-Fixture.TEST  ', decided: { trim: true, value: 'ada@kauro-fixture.test' }, untrimmed: 'INVALID' },
  { name: 'PARSE_PHONE_E164', field: fieldOf('PHONE', 'PARSE_PHONE_E164', { defaultRegion: 'US' }), raw: '  +1 415 555 0100  ', decided: { trim: true, value: '+14155550100' }, untrimmed: 'CHANGED_SAFE' },
  { name: 'NORMALISE_NUMBER', field: fieldOf('NUMBER', 'NORMALISE_NUMBER', { decimalSeparator: '.' }), raw: '  12.5  ', decided: { trim: true, value: '12.5' }, untrimmed: 'INVALID' },
  { name: 'NORMALISE_BOOLEAN', field: fieldOf('BOOLEAN', 'NORMALISE_BOOLEAN'), raw: '  yes  ', decided: { trim: true, value: 'true' }, untrimmed: 'INVALID' },
  { name: 'PARSE_DATE_ISO (DATE)', field: fieldOf('DATE', 'PARSE_DATE_ISO', { dateFormat: 'DD/MM/YYYY' }), raw: '  05/10/2026  ', decided: { trim: true, value: '2026-10-05' }, untrimmed: 'INVALID' },
  { name: 'PARSE_DATE_ISO (DATETIME)', field: fieldOf('DATETIME', 'PARSE_DATE_ISO', { dateFormat: 'ISO_8601' }), raw: '  2026-10-05T10:00:00Z  ', decided: { trim: true, value: '2026-10-05T10:00:00Z' }, untrimmed: 'AMBIGUOUS' },
];

describe('B04 engine on Migration Core 3.0.0: whitespace per primitive (D4-MC3-1)', () => {
  it("MC3-WS: each primitive's options under configuration 3.0.0 deliver the decided value for '  x  ' fixtures; PRESERVE_AS_IS keeps the padding", () => {
    const table: string[] = [];
    for (const entry of CASES) {
      const translated = optionsOfPrimitive(entry.field);
      assert.ok('options' in translated, `${entry.name}: ${JSON.stringify(translated)}`);
      // The decision is written, never left to a default: trim is present exactly when it is on.
      assert.equal(translated.options['trim'], entry.decided.trim ? true : undefined, `${entry.name}: options ${JSON.stringify(translated.options)}`);
      const delivered = deliver(entry.field, entry.raw);
      const off = deliver(entry.field, entry.raw, false);
      const on = deliver(entry.field, entry.raw, true);
      table.push(`${entry.name} | off: ${off.outcome} ${JSON.stringify(off.value)} ${off.reason} | on: ${on.outcome} ${JSON.stringify(on.value)} ${on.reason}`);
      assert.equal(delivered.value, entry.decided.value, `${entry.name}: ${JSON.stringify(delivered)}`);
      if (entry.decided.trim) {
        // A typed parse delivers the clean value only when trimming, and the trim is in the evidence (TRANSFORM_WHITESPACE_TRIMMED or the typed change).
        assert.ok(delivered.outcome === 'CHANGED_SAFE', `${entry.name}: ${JSON.stringify(delivered)}`);
        // Run both ways: with trim off the typed parse refuses the padded cell (INVALID/AMBIGUOUS, preserved as written), except a
        // phone, whose E.164 parse already skips the padding; trim on is then neutral for the value and visible in the evidence.
        assert.equal(off.outcome, entry.untrimmed, `${entry.name}: trim off ${JSON.stringify(off)}`);
        if (off.outcome !== 'CHANGED_SAFE') assert.equal(off.value, entry.raw, `${entry.name}: a refused cell is preserved with its padding`);
      } else {
        assert.equal(delivered.outcome, 'UNCHANGED', `${entry.name}: ${JSON.stringify(delivered)}`);
        assert.deepEqual([off.outcome, off.value], [entry.untrimmed, entry.raw], `${entry.name}: trim off ${JSON.stringify(off)}`);
      }
    }
    process.stdout.write(`# D4-MC3-1 whitespace table\n${table.map((line) => `# ${line}`).join('\n')}\n`);
  });

  it('MC3-WS: a whitespace-only cell is never emptied, even where the field trims (MC rule)', () => {
    for (const entry of CASES.filter((item) => item.decided.trim)) {
      const delivered = deliver(entry.field, '   ');
      assert.equal(delivered.value, '   ', `${entry.name}: ${JSON.stringify(delivered)}`);
    }
  });

  it('MC3-TZ (D68): a DATETIME that names a zone, which needs its tzdata release, is refused UNSUPPORTED_BY_CORE and never written without it', () => {
    const translated = optionsOfPrimitive(fieldOf('DATETIME', 'PARSE_DATE_ISO', { dateFormat: 'ISO_8601', timezone: 'Europe/Madrid' }));
    assert.ok('problem' in translated, JSON.stringify(translated));
    assert.match(translated.problem, /^UNSUPPORTED_BY_CORE:PARSE_DATE_ISO:/u);
  });
});

describe('B04 engine on Migration Core 3.0.0: raw headers in the configuration (D4-HDR-1)', () => {
  /** An answer that maps the column `fieldRef` to the target `targetRef` with NORMALISE_EMAIL_CASE and abstains on everything else; it records the headers the facts showed. */
  const mapping = (fieldRef: string, targetRef: string, seen: string[]): ScriptEntry => ({
    kind: 'proposal',
    build: (envelope: IntelligenceEnvelopeV1, payload: ScriptPayload) => {
      seen.push(...envelope.sourceProfile.fields.map((entry) => entry.header));
      return {
        schemaVersion: PROPOSAL_SCHEMA_VERSION,
        taskId: payload.taskId,
        runId: payload.runId,
        modelPolicyVersion: MODEL_POLICY_VERSION,
        promptBundleVersion: PROMPT_BUNDLE_VERSION,
        envelopeHash: payload.envelopeHash,
        items: envelope.deterministicCandidates.map((candidate): ProposalItem => {
          const abstain: ProposalItem = { candidateRef: candidate.candidateRef, proposalType: 'ABSTAIN', targetRef: null, transformPrimitive: null, typedTransformParams: null, evidenceRefs: candidate.evidenceRefs.slice(0, 32), requiresAgencyDecision: false, rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale: null, alternatives: [], abstainReason: 'INSUFFICIENT_EVIDENCE' };
          return candidate.sourceRefs.includes(fieldRef) && candidate.allowedTargetRefs.includes(targetRef) && candidate.allowedPrimitiveRefs.includes('NORMALISE_EMAIL_CASE') ? { ...abstain, proposalType: 'MAP_FIELD', targetRef, transformPrimitive: 'NORMALISE_EMAIL_CASE', rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE', abstainReason: null } : abstain;
        }),
        overallOutcome: 'MIXED',
      };
    },
  });

  it("B03-HDR-1: a header with a BOM or a zero-width space keeps MC's headerRaw as columnHeader in the configuration and the result, while the facts sent to the model carry displayHeader", { timeout: 180_000 }, async () => {
    for (const [name, raw] of [['zero-width space', 'Corr​eo'], ['byte-order mark', '﻿Correo']] as const) {
      const made = makeBundle(`hdr1-${name.replace(/ /gu, '-')}`, { contacts: `Contact ID,${raw}\n1,ADA@Kauro-Fixture.test\n2,Grace@Kauro-Fixture.test\n`, companies: 'Name\nAnalytical Engines\n' });
      const bundle = { ...made, files: made.files.map((file) => ({ ...file, idHeader: file.object === 'CONTACT' ? 'Contact ID' : 'Name' })) };
      try {
        const profiled = profileBundle(bundle, 'CLEAN_ONLY');
        const headerRaw = profiled.profile.profile.files.flatMap((file) => file.sheets.flatMap((sheet) => sheet.columns)).find((column) => (column.headerRaw ?? '').includes('Corr'))?.headerRaw;
        assert.equal(headerRaw, raw, `${name}: Migration Core's profile keeps the header as written`);
        const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
        const fieldRef = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.header === 'Correo' && entry.headerRaw === raw)?.[0];
        const targetRef = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.destinationField === 'contact.email')?.[0];
        assert.ok(fieldRef !== undefined && targetRef !== undefined, name);
        const clock = new VirtualClock();
        const port = realValidationPort(bundle, profiled.profile, null, { clock });
        const seen: string[] = [];
        const gateway = scriptedGateway({ default: mapping(fieldRef, targetRef, seen) });
        const base = inputFor('CLEAN_ONLY', profiled, null);
        const input: IntelligenceInput = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } } as ProjectRevision };
        const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, CONTEXT);
        // The facts the model saw carry the display header, never the raw one.
        assert.ok(seen.includes('Correo') && !seen.includes(raw), `${name}: ${JSON.stringify(seen)}`);
        assert.equal(result.state, 'PROPOSAL_READY', `${name}: ${JSON.stringify(result.unresolvedItems)}`);
        const email = result.draft.configuration?.fields.find((field) => field.destinationField === 'contact.email');
        // The configuration and the result name the column by Migration Core's headerRaw, the header Migration Core compares.
        assert.equal(email?.columnHeader, raw, `${name}: ${JSON.stringify(email)}`);
        assert.equal(result.draft.fullValidation?.ok, true, name);
      } finally {
        bundle.dispose();
      }
    }
  });
});

describe('B04 S7v: the release version and the Migration Core it accepts', () => {
  const root = join(import.meta.dirname, '..', '..');
  const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

  it('S7v: the package is 0.6.0 (no rc) in package.json, the lockfile, versions.ts and the matrix, and the matrix accepts the vendored Migration Core 3.1.0', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    assert.equal(INTELLIGENCE_CORE_VERSION, '0.6.0');
    assert.deepEqual([pkg.version, lock.version, lock.packages['']?.version, compatibilityMatrix().intelligenceCoreVersion], ['0.6.0', '0.6.0', '0.6.0', '0.6.0']);
    const matrix = read('docs', 'COMPATIBILITY_MATRIX.md');
    assert.match(matrix, /^## Intelligence Core 0\.6\.0$/mu);
    assert.match(matrix, /\| INTELLIGENCE_CORE_VERSION \| 0\.6\.0 \|/u);
    for (const [contract, version] of [['CORE_VERSION', '3.1.0'], ['PACKAGE_FORMAT_VERSION', '2.1.0'], ['CONFIG_SCHEMA_VERSION', '3.0.0']] as const) {
      assert.match(matrix, new RegExp(`\| ${contract} \| ${version.replace(/\./gu, '\.')} \| ${version.replace(/\./gu, '\.')} \|`, 'u'), contract);
    }
    const manifest = JSON.parse(read('vendor', 'MANIFEST.json')) as { sha256: string; source: { tag: string } };
    assert.ok(matrix.includes(manifest.sha256) && matrix.includes(`\`${manifest.source.tag}\``), 'the matrix names the vendored release and its sha256');
  });
});
