import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { hashTargetContract } from 'kauro-migration-core';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { cleanOnlyTargetRef } from '../src/contracts/envelope.js';
import type { IntelligenceEnvelopeV1 } from '../src/contracts/envelope.js';
import type { MemoryEntry } from '../src/contracts/run.js';
import { oracleProposal } from '../src/gateway/fake-gateway.js';
import { transportGateway } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest, ProviderResponse } from '../src/gateway/transport-gateway.js';
import { MemoryLedgerStore } from '../src/kernel/ledger.js';
import type { LedgerEvent, LedgerStore } from '../src/kernel/ledger.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './support/fixtures.js';

/** Every string leaf of a request, wherever the transport shape puts it. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, into);
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value as Record<string, unknown>)) strings(entry, into);
  return into;
}

/** The envelope inside the data block of a provider request, found by its delimiters rather than by its position; the instructions mention the delimiters too, so only a block that parses counts. */
function envelopeOf(request: ProviderRequest): IntelligenceEnvelopeV1 {
  for (const text of strings(request)) {
    for (const match of text.matchAll(/<data>\s*([\s\S]*?)\s*<\/data>/gu)) {
      const body = match[1] ?? '';
      if (!body.startsWith('{')) continue;
      return JSON.parse(body) as IntelligenceEnvelopeV1;
    }
  }
  throw new Error('no <data> block in the provider request');
}

const HEADER_SENTINEL = 'audit-person@example.test';
const MEMORY_SENTINEL = 'zbigniew.k@example.test';
const SENTINELS = [
  HEADER_SENTINEL,
  MEMORY_SENTINEL,
  'ada@kauro-fixture.test',
  'grace@kauro-fixture.test',
  '+34 612 345 678',
  '(415) 555-0134',
  '+57 300 123 4567',
  '12345678Z',
  'ES9121000418450200051332',
  '4111 1111 1111 1111',
  'Alice',
  'Maria',
  `${String.fromCodePoint(0x0410)}lice`,
  'Calle Mayor 12',
] as const;

describe('F01 on transport bytes: a whole run through the transport gateway leaks no forbidden sentinel', () => {
  it('headers, values, memory, rare values and homoglyphs: none reaches the provider request, the ledger, the telemetry or the result — and mapping still happens', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('privacy-transport', {
      contacts: [
        `Contact ID,First Name,Last Name,Email,Phone,Status,${HEADER_SENTINEL},Segment,Tier,Reference,Contact ${MEMORY_SENTINEL}`,
        `1,Ada,Lovelace,ada@kauro-fixture.test,+57 300 123 4567,Active,Alice,Alice,high,12345678Z,Calle Mayor 12`,
        `2,Grace,Hopper,grace@kauro-fixture.test,(415) 555-0134,Inactive,Maria,Maria,low,ES9121000418450200051332,Calle Mayor 12`,
        `3,Alan,Turing,alan@kauro-fixture.test,+34 612 345 678,Active,Alice,${String.fromCodePoint(0x0410)}lice,urgent,4111 1111 1111 1111,Calle Mayor 12`,
        '',
      ].join('\n'),
    });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const locatorOf = (header: string): string => [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === header)?.locator ?? '';
      const fieldRefOf = (header: string): string => [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.header === header)?.[0] ?? '';
      // What a host may extract: low-cardinality values per column, including the columns nobody should see.
      const summaries = new Map<string, readonly string[]>([
        [locatorOf('Status'), ['Active', 'Inactive']],
        [locatorOf('Email'), ['ada@kauro-fixture.test', 'grace@kauro-fixture.test']],
        [locatorOf('Phone'), ['+57 300 123 4567', '(415) 555-0134', '+34 612 345 678']],
        [locatorOf(HEADER_SENTINEL), ['Alice', 'Maria']],
        [locatorOf('Segment'), ['Alice', 'Maria', `${String.fromCodePoint(0x0410)}lice`]],
        [locatorOf('Tier'), ['high', 'medium', 'low', 'normal', 'urgent', 'critical', 'hot', 'warm', '+34 612 345 678']],
        [locatorOf('Reference'), ['12345678Z', 'ES9121000418450200051332', '4111 1111 1111 1111']],
        [locatorOf(`Contact ${MEMORY_SENTINEL}`), ['Calle Mayor 12']],
      ]);
      const memory: MemoryEntry = { memoryId: 'mem_00000000000000aa', scope: 'CLIENT', tenant: { agencyId: CONTEXT.tenant.agencyId, clientId: CONTEXT.tenant.clientId }, knowledgeType: 'FIELD_MAPPING_CONVENTION', ruleOrPattern: { sourceHeaderPattern: MEMORY_SENTINEL, targetRef: cleanOnlyTargetRef('contact.email'), semanticType: null }, sourceProjectRef: 'project-0', sourcePlanVersion: '1.0.0', targetInstanceRef: null, targetSchemaVersion: null, approvedBy: 'human:qa', verificationOutcome: 'AGENCY_APPROVED', provenance: 'run r task t', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, status: 'ACTIVE', version: 1 };

      // The ledger store is wrapped only to learn the run id the fake provider must answer with.
      const store = new MemoryLedgerStore();
      let runId = '';
      const watching: LedgerStore = { append: (id: string, event: LedgerEvent, expectedLength: number) => { runId = id; return store.append(id, event, expectedLength); }, read: (id: string) => store.read(id), barrier: (id, length, point) => store.barrier(id, length, point) };
      const requests: ProviderRequest[] = [];
      const transport = async (request: ProviderRequest): Promise<ProviderResponse> => {
        requests.push(structuredClone(request));
        const proposal = oracleProposal(envelopeOf(request), runId);
        return { status: 200, body: { model: request.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(proposal) }], usage: { input_tokens: 1000, output_tokens: 200 } }, requestId: `req_${String(requests.length)}` };
      };
      const telemetry: unknown[] = [];
      const deps = { ...depsFor(transportGateway(transport), realValidationPort(bundle, profiled.profile, null)), ledgerStore: watching, telemetry: (event: unknown) => telemetry.push(event) };
      const base = inputFor('CLEAN_ONLY', profiled, null, { categoricalSummaries: summaries, scopedMemorySnapshot: [memory] });
      // Declared as contacts, so a status column is a model question rather than a deterministic lead.status match.
      const input = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: { 'contacts.csv': 'CONTACT' as const, 'companies.csv': 'COMPANY' as const } } };
      const result: IntelligenceResult = await createIntelligenceCore(deps).run(input, CONTEXT);

      // Positives first: the run used the provider and still produced a validated draft.
      assert.ok(requests.length >= 1, 'the transport was called');
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.tasks.map((task) => [task.taskType, task.outcome, task.codes.slice(0, 3)])));
      assert.ok(result.draft.configuration !== null && result.draft.configuration.fields.length >= 2, 'email and first name are still mapped');
      const envelopes = requests.map(envelopeOf);
      const statusRef = fieldRefOf('Status');
      assert.ok(envelopes.some((envelope) => envelope.exemplars.some((exemplar) => exemplar.fieldRef === statusRef && exemplar.dataLevel === 'L1' && exemplar.minimizedValueOrClass === 'Active')), 'the status enumeration travelled as L1');
      const personRef = fieldRefOf(HEADER_SENTINEL);
      assert.ok(envelopes.some((envelope) => envelope.sourceProfile.fields.some((field) => field.fieldRef === personRef && /^hdr_[g-v]{12}$/u.test(field.header))), 'the personal header travelled as a token');
      assert.ok(envelopes.some((envelope) => envelope.memoryEvidence.some((item) => item.memoryId === memory.memoryId && /^hdr_[g-v]{12}$/u.test(item.rule.sourceHeaderPattern))), 'the memory pattern travelled as a token');
      for (const header of ['Segment', 'Tier', 'Reference', HEADER_SENTINEL, `Contact ${MEMORY_SENTINEL}`]) {
        const ref = fieldRefOf(header);
        assert.ok(envelopes.every((envelope) => envelope.exemplars.every((exemplar) => exemplar.fieldRef !== ref)), `no exemplar left ${header}`);
      }

      // The negatives, on the bytes the transport received and on everything the host gets back.
      const wire = JSON.stringify(requests);
      const ledger = JSON.stringify(result.runLedger.filter((event) => event.kind !== 'RESPONSE_STORED'));
      const { runLedger: omitted, ...rest } = result;
      void omitted;
      const returned = JSON.stringify(rest);
      const observed = JSON.stringify(telemetry);
      for (const sentinel of SENTINELS) {
        assert.ok(!wire.includes(sentinel), `provider request carries ${sentinel}`);
        assert.ok(!ledger.includes(sentinel), `ledger carries ${sentinel}`);
        assert.ok(!returned.includes(sentinel), `result carries ${sentinel}`);
        assert.ok(!observed.includes(sentinel), `telemetry carries ${sentinel}`);
      }
      assert.ok(!wire.includes('kauro-fixture.test'), 'no email domain of the dataset');
    } finally {
      bundle.dispose();
    }
  });
});

/** The HubSpot fixture contract with the lifecycle picklist relabelled and its options replaced: the reviewer's S3 shape. */
function picklistContract(label: string, options: readonly string[]): ReturnType<typeof hashTargetContract> {
  const base = vendorContract('HUBSPOT', { withStatusPicklist: true });
  return hashTargetContract({
    ...base.contract,
    objects: base.contract.objects.map((object, index) => (index !== 0 ? object : { ...object, fields: object.fields.map((field) => (field.apiName === 'lifecyclestage' ? { ...field, label, picklistValues: options.map((value) => ({ value, label: value, active: true, defaultValue: false })) } : field)) })),
  });
}

/** One whole HUBSPOT run with a byte-capturing transport behind the transport gateway: what left, and what came back. */
async function runPicklist(name: string, label: string, options: readonly string[], values: readonly string[], header = 'Segment'): Promise<{ result: IntelligenceResult; wire: string; envelopes: IntelligenceEnvelopeV1[]; fieldRef: string; telemetry: string }> {
  const rows = values.map((value, index) => `${String(index + 1)},Ada,Lovelace,p${String(index)}@kauro-fixture.test,,${value}`);
  const bundle = makeBundle(`privacy-r2-${name}`, { contacts: `Contact ID,First Name,Last Name,Email,Phone,${header}\n${rows.join('\n')}\n` });
  try {
    const contract = picklistContract(label, options);
    const profiled = profileBundle(bundle, 'HUBSPOT');
    const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
    const entry = [...contracts.refs.fieldByRef.entries()].find(([, info]) => info.header === header);
    assert.ok(entry !== undefined, `the profile has ${header}`);
    const [fieldRef, info] = entry;
    const store = new MemoryLedgerStore();
    let runId = '';
    const watching: LedgerStore = { append: (id: string, event: LedgerEvent, expectedLength: number) => { runId = id; return store.append(id, event, expectedLength); }, read: (id: string) => store.read(id), barrier: (id, length, point) => store.barrier(id, length, point) };
    const requests: string[] = [];
    const transport = async (request: ProviderRequest): Promise<ProviderResponse> => {
      requests.push(JSON.stringify(request));
      const proposal = oracleProposal(envelopeOf(request), runId);
      return { status: 200, body: { model: request.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(proposal) }], usage: { input_tokens: 1000, output_tokens: 200 } }, requestId: `req_${String(requests.length)}` };
    };
    const telemetry: unknown[] = [];
    const deps = { ...depsFor(transportGateway(transport), realValidationPort(bundle, profiled.profile, contract)), ledgerStore: watching, telemetry: (event: unknown) => telemetry.push(event) };
    const base = inputFor('HUBSPOT', profiled, contract, { categoricalSummaries: new Map([[info.locator, values]]) });
    const input = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: { 'contacts.csv': 'CONTACT' as const, 'companies.csv': 'COMPANY' as const } } };
    const result = await createIntelligenceCore(deps).run(input, CONTEXT);
    assert.ok(requests.length >= 1, `${name}: the transport was called`);
    return { result, wire: requests.join('\n'), envelopes: requests.map((bytes) => envelopeOf(JSON.parse(bytes) as ProviderRequest)), fieldRef, telemetry: JSON.stringify(telemetry) };
  } finally {
    bundle.dispose();
  }
}

/** The reviewer's S3 cases: single-token person names in Basque Latin, Cyrillic, Georgian, Greek and unlisted Latin, under labels the person-field vocabulary does not name. */
const S3_CASES = [
  { name: 'S3a', label: 'Comercial', options: ['Iker', 'Unai', 'Ainhoa', 'Leire'] },
  { name: 'S3b', label: 'Менеджер', options: ['Светлана', 'Дмитрий', 'Ольга'] },
  { name: 'S3c', label: 'Status', options: ['გიორგი', 'ნინო', 'დავითი'] },
  { name: 'S3f', label: 'Vendedor', options: ['Γιώργος', 'Μαρία', 'Νίκος'] },
  { name: 'S3g', label: 'Sales Rep', options: ['Zbigniew', 'Okonkwo', 'Thandiwe', 'Unassigned'] },
] as const;

describe('R2-PC-01 on transport bytes: a name-valued picklist under any label leaks no name through a whole run; a genuine enumeration under the same labels travels', () => {
  it('the reproduction S3a/S3b/S3c/S3f/S3g: no name in the provider request, the ledger, the result or the telemetry — as option or as exemplar', { timeout: 120_000 }, async () => {
    for (const { name, label, options } of S3_CASES) {
      const names = options.filter((option) => option !== 'Unassigned');
      const { result, wire, envelopes, fieldRef, telemetry } = await runPicklist(name, label, options, options);
      assert.equal(result.state, 'PROPOSAL_READY', `${name}: ${JSON.stringify(result.tasks.map((task) => [task.taskType, task.outcome, task.codes.slice(0, 3)]))}`);
      const ledger = JSON.stringify(result.runLedger.filter((event) => event.kind !== 'RESPONSE_STORED'));
      const { runLedger: omitted, ...rest } = result;
      void omitted;
      const returned = JSON.stringify(rest);
      for (const sentinel of names) {
        assert.ok(!wire.includes(sentinel), `${name}: provider request carries ${sentinel}`);
        assert.ok(!ledger.includes(sentinel), `${name}: ledger carries ${sentinel}`);
        assert.ok(!returned.includes(sentinel), `${name}: result carries ${sentinel}`);
        assert.ok(!telemetry.includes(sentinel), `${name}: telemetry carries ${sentinel}`);
      }
      assert.ok(envelopes.every((envelope) => envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef)), `${name}: a column of names emits no exemplar`);
      for (const envelope of envelopes) {
        if (envelope.targetContract.mode === 'CLEAN_ONLY') continue;
        const stage = envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage');
        if (stage === undefined) continue;
        assert.deepEqual(stage.options, options.filter((option) => option === 'Unassigned'), `${name}: only the enumeration survives in the option list on the wire`);
      }
    }
  });
  it('the positives S4 and the same labels with real enumerations: the options are on the wire and the values travel as L1 by them', { timeout: 120_000 }, async () => {
    const cases = [
      { name: 'S4', label: 'Segment', header: 'Tier', options: ['Enterprise', 'Startup', 'SMB'] },
      { name: 'P-comercial', label: 'Comercial', header: 'Segment', options: ['Inbound', 'Outbound'] },
      { name: 'P-salesrep', label: 'Sales Rep', header: 'Segment', options: ['Unassigned', 'Team A'] },
      { name: 'P-status', label: 'Status', header: 'Segment', options: ['Active', 'Pending', 'Won'] },
    ] as const;
    for (const { name, label, header, options } of cases) {
      const { result, wire, envelopes, fieldRef } = await runPicklist(name, label, options, options, header);
      assert.equal(result.state, 'PROPOSAL_READY', name);
      for (const option of options) assert.ok(wire.includes(option), `${name}: ${option} on the wire`);
      const travelled = envelopes.flatMap((envelope) => envelope.exemplars.filter((exemplar) => exemplar.fieldRef === fieldRef && exemplar.dataLevel === 'L1').map((exemplar) => exemplar.minimizedValueOrClass));
      assert.ok(travelled.length >= 1 && travelled.every((value) => (options as readonly string[]).includes(value)), `${name}: L1 exemplars are the options: ${travelled.join('|')}`);
    }
  });
});
