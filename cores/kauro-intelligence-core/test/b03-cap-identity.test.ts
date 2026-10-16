/**
 * B03-CAP-IDENTITY — the identity families through the public run() and the
 * real Migration Core (closure plan D3-CAP-06, D3-CAP-07, D3-CAP-08; review
 * findings B03-R9 and B03-R10): IDENTITY_STRATEGY from proven authority only,
 * DUPLICATE_SIGNAL_STRATEGY review-only by construction, ASSOCIATION_MAPPING
 * only to declared endpoints over relationships the contract offers.
 *
 * Every case goes through run() with the host's validation port over the
 * vendored Migration Core release (runMigration, writePackage, verifyPackage),
 * and every effect is read back from the package Migration Core wrote: the
 * normalized configuration it loaded, merges.json, duplicate-candidates.csv,
 * associations.csv and unresolved-associations.csv. The model is a labelled
 * fake: a transport that answers from the serialised provider request, each
 * item written by the case as a model would answer it (evidence class
 * SIMULATED). No provider is called.
 *
 * Written first, against ic/b03-stage-1: what the build under test may not
 * have yet — the draft's review groups and association report, the envelope's
 * association channel, the exported ref functions — is read through loose
 * views, so a build without it reads as undefined and the assertion says
 * what is missing.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { hashTargetContract } from 'kauro-migration-core';
import type { HashedCandidateSet, HashedSourceProfile, HashedTargetContract, TargetContract } from 'kauro-migration-core';

import * as publicIndex from '../src/index.js';
import { adaptContracts, evidenceRefFor } from '../src/adapter/contract-adapter.js';
import type { AdaptedContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { recordMappingIdOf } from '../src/contracts/output-scope.js';
import { envelopeHash } from '../src/contracts/envelope.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1 } from '../src/contracts/envelope.js';
import type { ProposalItem } from '../src/contracts/proposal.js';
import { buildEnvelope, decideEgress } from '../src/envelope/envelope-builder.js';
import { resolve as resolveDeterministically } from '../src/resolver/deterministic-resolver.js';
import { compileProposal } from '../src/compiler/compiler.js';
import { oracleProposal } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { parseProviderRequestPayload, transportGateway } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest, Transport } from '../src/gateway/transport-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { CandidateConfiguration, FullDatasetValidationPort, FullDatasetValidationResult, IntelligenceInput } from '../src/ports/ports.js';
import type { Bundle, FixtureValidationPort } from './support/fixtures.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, profileWithTruth, realValidationPort, vendorContract } from './support/fixtures.js';

// ------------------------------------------------------------------------------------------------ loose views of the contract

type Loose = Readonly<Record<string, unknown>>;

/** One review group of the draft (D3-CAP-07): a Migration Core duplicate cluster the agency reviews; nothing merges it. */
interface ReviewGroup {
  readonly groupRef: string;
  readonly decisionRef: string;
  readonly recordMappingIds: readonly string[];
  readonly signalColumns: readonly string[];
  readonly rows: number;
  readonly rowLocators: readonly string[];
  readonly rowsDigest: string | null;
  readonly observed: boolean;
}

/** One association of the draft (D3-CAP-08), with what Migration Core reported of its edges. */
interface AssociationReport {
  readonly associationId: string;
  readonly decisionRef: string;
  readonly relationshipType: string;
  readonly recordMappingId: string;
  readonly targetRecordMappingId: string;
  readonly keyColumnLocator: string;
  readonly fragmentHash: string;
  readonly edgesDelivered: number;
  readonly missingEndpoints: number;
}

/** One option of the envelope's association channel (D3-CAP-08): refs and closed codes only. */
interface AssociationTarget {
  readonly associationRef: string;
  readonly keyFieldRef: string;
  readonly relationshipType: string;
  readonly ownerSide: string;
  readonly targetObject: string;
  readonly targetRecordRef: string;
  readonly targetIdFieldRef: string;
}

interface Disposition {
  readonly candidateRef: string;
  readonly origin: string;
  readonly candidateType: string;
  readonly family: string | null;
  readonly disposition: string;
  readonly code: string;
  readonly taskId: string | null;
}

const exported = publicIndex as unknown as Record<string, unknown>;
const associationRefOf = exported['associationRefOf'] as ((keyFieldRef: string, relationshipType: string, targetRecordRef: string) => string) | undefined;
const recordRefOf = exported['recordRefOf'] as ((recordMappingId: string) => string) | undefined;
const planCandidates = exported['planCandidates'] as ((input: IntelligenceInput) => { readonly candidates: readonly { readonly candidateRef: string; readonly origin: string; readonly family: string | null }[] }) | undefined;

const reviewGroupsOf = (result: IntelligenceResult): readonly ReviewGroup[] | undefined => (result.draft as unknown as { readonly reviewGroups?: readonly ReviewGroup[] }).reviewGroups;
const associationsOf = (result: IntelligenceResult): readonly AssociationReport[] | undefined => (result.draft as unknown as { readonly associations?: readonly AssociationReport[] }).associations;
const associationTargetsOf = (envelope: IntelligenceEnvelopeV1): readonly AssociationTarget[] | undefined => (envelope as unknown as { readonly associationTargets?: readonly AssociationTarget[] }).associationTargets;
const dispositionsOf = (result: IntelligenceResult): readonly Disposition[] => (result as unknown as { readonly candidateAccounting?: { readonly dispositions: readonly Disposition[] } | null }).candidateAccounting?.dispositions ?? [];
const effectsOf = (receipt: FullDatasetValidationResult | null): Loose | null => (receipt as unknown as { readonly effects?: Loose | null } | null)?.effects ?? null;

/** The ref functions of the association channel, asserted exported. */
function refs(): { readonly associationRefOf: NonNullable<typeof associationRefOf>; readonly recordRefOf: NonNullable<typeof recordRefOf> } {
  assert.equal(typeof associationRefOf, 'function', 'associationRefOf is exported by the public entry (D3-CAP-08)');
  assert.equal(typeof recordRefOf, 'function', 'recordRefOf is exported by the public entry (D3-CAP-08)');
  return { associationRefOf: associationRefOf as NonNullable<typeof associationRefOf>, recordRefOf: recordRefOf as NonNullable<typeof recordRefOf> };
}

// ------------------------------------------------------------------------------------------------------------ fixtures

const TIMEOUT = { timeout: 240_000 };

/** A Salesforce field of the contracts this file attests. */
function sfField(apiName: string, label: string, type: string, extra: Partial<TargetContract['objects'][number]['fields'][number]> = {}): TargetContract['objects'][number]['fields'][number] {
  return { apiName, label, type, createable: 'TRUE', updateable: 'TRUE', nillable: 'TRUE', length: 255, precision: null, scale: null, unique: 'FALSE', externalId: 'FALSE', idLookup: 'FALSE', calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE', restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT', ...extra };
}

/**
 * The CAP06 contract: a Salesforce org whose Contact carries Customer_Number__c
 * flagged External ID and unique — the contract's own authority for an
 * identifier — beside Email, which the org can look contacts up by but which
 * is a contact signal, never a proof of identity.
 */
function identityContract(): HashedTargetContract {
  return hashTargetContract({
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: { mode: 'SALESFORCE', instanceId: '00D000000000006', instanceLabel: 'fixture CAP06', evidence: 'ARTIFACT' },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
    objects: [
      {
        apiName: 'Contact',
        label: 'Contact',
        createable: 'TRUE',
        updateable: 'TRUE',
        recordTypes: [],
        fields: [
          sfField('Email', 'Email', 'email', { unique: 'TRUE', idLookup: 'TRUE' }),
          sfField('FirstName', 'First Name', 'string'),
          sfField('LastName', 'Last Name', 'string'),
          sfField('Phone', 'Phone', 'phone'),
          sfField('Customer_Number__c', 'Customer Number', 'string', { unique: 'TRUE', externalId: 'TRUE', idLookup: 'TRUE' }),
        ],
      },
      { apiName: 'Account', label: 'Company', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [sfField('Name', 'Name', 'string'), sfField('Website', 'Website', 'url')] },
    ],
    pipelines: [],
  });
}

const EMAIL = { ada: 'ada@kauro-fixture.test', grace: 'grace@kauro-fixture.test', alan: 'alan@kauro-fixture.test', edsger: 'edsger@kauro-fixture.test' };

/**
 * Two Contact files, each with a Customer Number unique and populated on
 * every row, and an Email unique in each: C-1002 is Grace Hopper in both,
 * with the same email — one record, provable only by the external id.
 */
function twoContactFiles(name: string, headers: { readonly customer?: string } = {}): Bundle {
  const customer = headers.customer ?? 'Customer Number';
  const base = makeBundle(name, { contacts: `Contact ID,${customer},First Name,Last Name,Email\n1,C-1001,Ada,Lovelace,${EMAIL.ada}\n2,C-1002,Grace,Hopper,${EMAIL.grace}\n3,C-1003,Alan,Turing,${EMAIL.alan}\n` });
  writeFileSync(join(base.root, 'contacts2.csv'), `Contact ID,${customer},First Name,Last Name,Email\n1,C-1002,Grace,Hopper,${EMAIL.grace}\n2,C-1004,Edsger,Dijkstra,${EMAIL.edsger}\n`);
  return { ...base, files: [...base.files, { id: 'contacts2', path: 'contacts2.csv', idHeader: 'Contact ID', object: 'CONTACT' }] };
}

const TWO_FILES_DECLARED = { 'contacts.csv': 'CONTACT' as const, 'contacts2.csv': 'CONTACT' as const, 'companies.csv': 'COMPANY' as const };

/** Four contacts, two of them sharing an email and nothing that proves them one: a Migration Core duplicate cluster. */
const CLUSTER_CONTACTS = `Contact ID,First Name,Last Name,Email\n1,Ada,Lovelace,${EMAIL.ada}\n2,Grace,Hopper,${EMAIL.grace}\n3,Alan,Turing,${EMAIL.alan}\n4,Alonzo,Church,${EMAIL.alan}\n`;

/** Contacts whose Company ID references the Companies record id; C9 is no company of the bundle. */
const ASSOCIATION_CONTACTS = `Contact ID,First Name,Last Name,Email,Company ID\n1,Ada,Lovelace,${EMAIL.ada},C1\n2,Grace,Hopper,${EMAIL.grace},C2\n3,Alan,Turing,${EMAIL.alan},C9\n4,Edsger,Dijkstra,${EMAIL.edsger},C1\n`;
const ASSOCIATION_COMPANIES = 'Company ID,Name,Website\nC1,Analytical Engines,https://analytical.test\nC2,COBOL Works,https://cobol.test\n';

/** The declared input of a run: objects and record id columns by path, as the project declares them. */
function declaredInput(mode: 'CLEAN_ONLY' | 'HUBSPOT' | 'SALESFORCE', profiled: { profile: HashedSourceProfile; candidateSet: HashedCandidateSet }, contract: HashedTargetContract | null, declaredObjects: Readonly<Record<string, 'CONTACT' | 'COMPANY' | 'DEAL' | 'LEAD'>>, recordIdColumns?: Readonly<Record<string, string>>, extra: Partial<IntelligenceInput> = {}): IntelligenceInput {
  const base = inputFor(mode, profiled, contract, extra);
  return { ...base, projectRevision: { ...base.projectRevision, declaredObjects, ...(recordIdColumns === undefined ? {} : { recordIdColumns }) } };
}

/** The host's validation port over the real Migration Core, recording every configuration it was handed. */
function recordingPort(real: FixtureValidationPort): FullDatasetValidationPort & { readonly configurations: CandidateConfiguration[]; readonly real: FixtureValidationPort } {
  const configurations: CandidateConfiguration[] = [];
  return {
    configurations,
    real,
    async validate(configuration: CandidateConfiguration) {
      configurations.push(configuration);
      return real.validate(configuration);
    },
  };
}

/** The real port, its receipt altered on the way back: the defence under test is the core's. */
function altered(real: FullDatasetValidationPort, alter: (receipt: FullDatasetValidationResult) => unknown): FullDatasetValidationPort {
  return { async validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult> { return alter(await real.validate(configuration)) as FullDatasetValidationResult; } };
}

interface AnswerContext {
  readonly candidate: DeterministicCandidate;
  readonly envelope: IntelligenceEnvelopeV1;
  /** The real header of the candidate's first column, from the test's own adapted contracts — never the masked one the envelope carries. */
  readonly header: string;
  /** The oracle's answer to the candidate: what a case leaves alone. */
  readonly oracle: ProposalItem;
}

/**
 * A transport answering from the serialised request: for each candidate the
 * oracle's item, unless the case writes another — and, on the identity
 * families, an abstention by default. Every request's bytes and envelope are
 * recorded.
 */
function caseTransport(contracts: AdaptedContracts, answer: (context: AnswerContext) => ProposalItem | undefined, seen: { readonly bytes: string; readonly envelope: IntelligenceEnvelopeV1 }[] = []): Transport {
  const headerOf = (fieldRef: string | undefined): string => (fieldRef === undefined ? '' : (contracts.refs.fieldByRef.get(fieldRef)?.header ?? ''));
  return async (request: ProviderRequest) => {
    const bytes = JSON.stringify(request);
    const payload = parseProviderRequestPayload(bytes);
    const envelope = payload.envelope;
    seen.push({ bytes, envelope });
    const proposal = oracleProposal(envelope, payload.runId, { modelPolicyVersion: payload.policyRef.modelPolicyVersion, promptBundleVersion: payload.promptRef.promptBundleVersion });
    const identityFamily = ['IDENTITY_STRATEGY', 'DUPLICATE_SIGNAL_STRATEGY', 'ASSOCIATION_MAPPING'].includes(envelope.taskType);
    const items = proposal.items.map((item) => {
      const candidate = envelope.deterministicCandidates.find((entry) => entry.candidateRef === item.candidateRef);
      if (candidate === undefined) return item;
      const written = answer({ candidate, envelope, header: headerOf(candidate.sourceRefs[0]), oracle: item });
      return written ?? (identityFamily ? abstain(item) : item);
    });
    const proposed = items.filter((item) => item.proposalType !== 'ABSTAIN' && item.proposalType !== 'UNMAPPED_PRESERVE').length;
    const text = JSON.stringify({ ...proposal, items, overallOutcome: proposed === items.length ? 'PROPOSED' : proposed === 0 ? 'ABSTAINED' : 'MIXED' });
    return { status: 200, body: { id: 'msg_b03_cap_identity', type: 'message', role: 'assistant', model: payload.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: Math.ceil(text.length / 4) } } };
  };
}

/** A gateway over a transport that records every GatewayRequest it was handed. */
function recordingGateway(transport: Transport): ModelGateway & { readonly requests: GatewayRequest[] } {
  const inner = transportGateway(transport);
  const requests: GatewayRequest[] = [];
  return {
    name: 'b03-cap-identity-recording',
    evidenceClass: inner.evidenceClass,
    requests,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      requests.push(request);
      return inner.analyze(request);
    },
  };
}

const answered = (item: ProposalItem, fields: Partial<ProposalItem>): ProposalItem => ({ ...item, targetRef: null, transformPrimitive: null, typedTransformParams: null, requiresAgencyDecision: false, shortRationale: null, alternatives: [], abstainReason: null, ...fields });
const abstain = (item: ProposalItem): ProposalItem => answered(item, { proposalType: 'ABSTAIN', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: 'INSUFFICIENT_EVIDENCE' });
const proposeIdentity = (item: ProposalItem, requiresAgencyDecision = false): ProposalItem => answered(item, { proposalType: 'PROPOSE_IDENTITY_STRATEGY', rationaleCode: 'UNIQUE_AND_WELL_FORMED_IDENTIFIER', requiresAgencyDecision });
/** The claim a duplicate-signal proposal stands on: the records share a signal Migration Core reported as a duplicate cluster, and nothing proves them one — an identity that needs proof. */
const proposeDuplicate = (item: ProposalItem, fields: Partial<ProposalItem> = {}): ProposalItem => answered(item, { proposalType: 'PROPOSE_DUPLICATE_SIGNAL', rationaleCode: 'IDENTITY_NEEDS_PROOF', ...fields });
const mapAssociation = (item: ProposalItem, targetRef: string): ProposalItem => answered(item, { proposalType: 'MAP_ASSOCIATION', targetRef, rationaleCode: 'FOREIGN_KEY_COLUMN' });

/** The ledger's TASK_OUTCOME facts of a result, read loosely. */
const taskOutcomes = (result: IntelligenceResult): { readonly taskId: string; readonly attempt: number; readonly outcome: string; readonly codes: readonly string[] }[] =>
  (result.runLedger as unknown as { readonly kind: string; readonly taskId?: string; readonly attempt?: number; readonly outcome?: string; readonly codes?: readonly string[] }[])
    .filter((event) => event.kind === 'TASK_OUTCOME')
    .map((event) => ({ taskId: event.taskId ?? '', attempt: event.attempt ?? 0, outcome: event.outcome ?? '', codes: event.codes ?? [] }));

/** The task of a family a run planned, asserted present. */
function taskOf(result: IntelligenceResult, taskType: string): IntelligenceResult['tasks'][number] {
  const task = result.tasks.find((entry) => entry.taskType === taskType);
  assert.ok(task !== undefined, `the run planned a ${taskType} task: ${JSON.stringify(result.tasks.map((entry) => [entry.taskType, entry.outcome]))}`);
  return task;
}

/** A file of the package Migration Core last wrote. */
function packageFile(port: FixtureValidationPort, relative: string): string {
  assert.ok(port.lastPackage !== null, 'Migration Core wrote a package');
  return readFileSync(join(port.lastPackage.stagingDir, relative), 'utf8');
}

/** RFC 4180 rows of a CSV the package holds, header first. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.length > 1 || entry[0] !== '');
}

/** The data rows of a package CSV as records by column name. */
function csvRecords(port: FixtureValidationPort, relative: string): readonly Readonly<Record<string, string>>[] {
  const [header, ...rows] = parseCsv(packageFile(port, relative));
  assert.ok(header !== undefined, `${relative} has a header`);
  return rows.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])));
}

/** The configuration Migration Core loaded, as it wrote it into the package. */
function loadedConfiguration(port: FixtureValidationPort): { readonly records: readonly Loose[]; readonly associations: readonly Loose[] } {
  return JSON.parse(packageFile(port, join('03_TRACEABILITY', 'config.normalized.json'))) as { readonly records: readonly Loose[]; readonly associations: readonly Loose[] };
}

/** The proven merges Migration Core made, from the package. */
function merges(port: FixtureValidationPort): readonly Loose[] {
  return (JSON.parse(packageFile(port, join('03_TRACEABILITY', 'merges.json'))) as { readonly merges: readonly Loose[] }).merges;
}

/** A profiled column, by file path and header. */
function columnOf(profile: HashedSourceProfile, path: string, header: string): { readonly locator: string; readonly index: number; readonly fileId: string } {
  for (const file of profile.profile.files) {
    if (file.path !== path) continue;
    for (const sheet of file.sheets) for (const column of sheet.columns) if (column.headerRaw === header) return { locator: column.columnLocatorId, index: column.columnIndex, fileId: file.fileId };
  }
  throw new Error(`no column ${header} in ${path}`);
}

const fileIdOf = (profile: HashedSourceProfile, path: string): string => profile.profile.files.find((file) => file.path === path)?.fileId ?? assert.fail(`no file ${path}`);

// ------------------------------------------------------------------------------------------------------------ CAP06, IC-07

describe('B03-CAP-IDENTITY — CAP06 IDENTITY_STRATEGY: identity only from proven authority (D3-CAP-06)', () => {
  it("CAP06: a Customer Number column named as the contract's external id and unique and populated in two Contact files is proposed as the identity strategy; Migration Core receives it as an authoritative external id and combines the rows it proves one record", TIMEOUT, async () => {
    const bundle = twoContactFiles('b03-cap06');
    try {
      const contract = identityContract();
      const profiled = profileBundle(bundle, 'SALESFORCE');
      const contracts = adaptContracts({ mode: 'SALESFORCE', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const input = declaredInput('SALESFORCE', profiled, contract, TWO_FILES_DECLARED);
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
      const seen: { bytes: string; envelope: IntelligenceEnvelopeV1 }[] = [];
      const gateway = recordingGateway(caseTransport(contracts, ({ envelope, header, oracle }) => (envelope.taskType === 'IDENTITY_STRATEGY' && header === 'Customer Number' ? proposeIdentity(oracle) : undefined), seen));
      const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-cap06' });

      // The question: one IDENTITY_STRATEGY task over both record mappings of the object, the Customer Number of each file among its candidates.
      const identityEnvelopes = seen.filter((entry) => entry.envelope.taskType === 'IDENTITY_STRATEGY').map((entry) => entry.envelope);
      assert.ok(identityEnvelopes.length > 0, `an IDENTITY_STRATEGY task was sent: ${JSON.stringify(seen.map((entry) => entry.envelope.taskType))}`);
      const customerColumns = ['contacts.csv', 'contacts2.csv'].map((path) => columnOf(profiled.profile, path, 'Customer Number'));
      const offered = identityEnvelopes.flatMap((envelope) => envelope.deterministicCandidates).filter((candidate) => customerColumns.some((column) => contracts.refs.refByLocator.get(column.locator) === candidate.sourceRefs[0]));
      assert.equal(offered.length, 2, 'one identity candidate per file for its Customer Number');
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(taskOf(result, 'IDENTITY_STRATEGY').outcome, 'PROPOSED');

      // The configuration: each Contact record names its Customer Number as an authoritative external id, in one identity space for the object.
      const configuration = result.draft.configuration;
      assert.ok(configuration !== null);
      const contactRecords = configuration.records.filter((record) => record.object === 'CONTACT');
      assert.equal(contactRecords.length, 2);
      for (const record of contactRecords) {
        const expected = customerColumns.find((column) => column.fileId === record.fileId);
        assert.deepEqual(record.authoritativeExternalIdColumns.map((column) => column.columnLocator), [expected?.locator], `${record.recordId}: the Customer Number is its authoritative external id`);
        assert.equal(record.sourceRecordIdColumn, null, 'no record id was declared, none is inferred');
      }
      assert.ok(contactRecords[0]?.identitySpace !== null && contactRecords[0]?.identitySpace === contactRecords[1]?.identitySpace, `one identity space for the object: ${JSON.stringify(contactRecords.map((record) => record.identitySpace))}`);
      const companies = configuration.records.find((record) => record.object === 'COMPANY');
      assert.deepEqual([companies?.authoritativeExternalIdColumns.length, companies?.identitySpace], [0, null], 'the companies file had nothing proven; its identity is its own');

      // Evidence and accounting: the proposal names the record fragment it shaped; each Customer Number candidate and the key candidate on it are PROPOSED.
      const dispositions = dispositionsOf(result);
      for (const candidate of offered) {
        const own = dispositions.find((entry) => entry.candidateRef === candidate.candidateRef);
        assert.deepEqual([own?.family, own?.disposition, own?.code], ['IDENTITY_STRATEGY', 'PROPOSED', 'PROPOSE_IDENTITY_STRATEGY'], JSON.stringify(own));
        const evidence = result.draft.evidence.find((entry) => entry.candidateRef === candidate.candidateRef);
        const record = contactRecords.find((entry) => contracts.refs.fieldByRef.get(candidate.sourceRefs[0] ?? '')?.fileId === entry.fileId);
        assert.ok(evidence !== undefined && record !== undefined);
        assert.deepEqual([evidence.origin, evidence.rationaleCode, evidence.fragmentHash], ['PROPOSED', 'UNIQUE_AND_WELL_FORMED_IDENTIFIER', record.fragmentHash], 'the proposal names the record fragment it shaped');
      }
      const keys = profiled.candidateSet.candidateSet.candidates.filter((candidate) => candidate.candidateType === 'KEY_CANDIDATE' && customerColumns.some((column) => candidate.sourceRefs.includes(column.locator)));
      assert.equal(keys.length, 2, 'Migration Core lists each Customer Number as a key candidate');
      for (const key of keys) assert.deepEqual(dispositions.filter((entry) => entry.candidateRef === key.candidateRef).map((entry) => [entry.family, entry.disposition]), [['IDENTITY_STRATEGY', 'PROPOSED']], 'the key candidate is answered by the identity strategy on its column');

      // Migration Core: the loaded configuration carries the external id columns by index, and the one record C-1002 is in both files is combined — proven, by the external id.
      const loaded = loadedConfiguration(port.real);
      for (const column of customerColumns) {
        const record = loaded.records.find((entry) => entry['fileId'] === column.fileId);
        assert.ok(record !== undefined);
        assert.deepEqual((record['authoritativeExternalIdColumns'] as readonly Loose[]).map((entry) => entry['index']), [column.index], 'Migration Core loaded the Customer Number as the authoritative external id');
      }
      const proven = merges(port.real);
      assert.equal(proven.length, 1, `one proven merge: ${JSON.stringify(proven)}`);
      const evidence = (proven[0]?.['identityEvidence'] ?? []) as readonly Loose[];
      assert.ok(evidence.some((entry) => entry['kind'] === 'AUTHORITATIVE_EXTERNAL_ID' && entry['authority'] === 'PROVING'), JSON.stringify(evidence));
      assert.equal(((proven[0]?.['absorbedRowLocatorIds'] ?? []) as readonly string[]).length, 1, 'one row absorbed');
      const effects = effectsOf(result.draft.fullValidation);
      assert.ok(effects !== null);
      assert.deepEqual([(effects['identity'] as Loose)['provenMerges'], (effects['identity'] as Loose)['absorbedRows']], [1, 1]);
      const delivered = (effects['records'] as readonly Loose[]).filter((record) => record['object'] === 'CONTACT').reduce((total, record) => total + Number(record['deliveredRecords']), 0);
      assert.equal(delivered, 4, 'five contact rows, four contacts: the two rows of C-1002 are one record');
    } finally {
      bundle.dispose();
    }
  });

  it('CAP06 / IC-07: an email unique in the profile proposed as identity without the agency is FORBIDDEN; Migration Core receives no authoritative column and keeps the rows as separate records, reported only as a duplicate candidate', TIMEOUT, async () => {
    const bundle = twoContactFiles('b03-ic07');
    try {
      const contract = identityContract();
      const profiled = profileBundle(bundle, 'SALESFORCE');
      const contracts = adaptContracts({ mode: 'SALESFORCE', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const input = declaredInput('SALESFORCE', profiled, contract, TWO_FILES_DECLARED);
      const emails = ['contacts.csv', 'contacts2.csv'].map((path) => columnOf(profiled.profile, path, 'Email'));
      for (const email of emails) assert.ok(profiled.candidateSet.candidateSet.candidates.some((candidate) => candidate.candidateType === 'KEY_CANDIDATE' && candidate.sourceRefs.includes(email.locator)), 'the Email of each file is unique and populated: a key candidate in the profile');

      // A: the email proposed as identity without the agency — FORBIDDEN by name; nothing reaches Migration Core.
      const clockA = new VirtualClock();
      const portA = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock: clockA }));
      const seenA: { bytes: string; envelope: IntelligenceEnvelopeV1 }[] = [];
      const a = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, ({ envelope, header, oracle }) => (envelope.taskType === 'IDENTITY_STRATEGY' && header === 'Email' ? proposeIdentity(oracle) : undefined), seenA)), portA, clockA)).run(input, { ...CONTEXT, auditAttemptId: 'b03-ic07-a' });
      const emailCandidates = seenA.filter((entry) => entry.envelope.taskType === 'IDENTITY_STRATEGY').flatMap((entry) => entry.envelope.deterministicCandidates).filter((candidate) => emails.some((email) => contracts.refs.refByLocator.get(email.locator) === candidate.sourceRefs[0]));
      assert.equal(emailCandidates.length, 2, 'the identity question carried each file\'s Email as a candidate the model could name');
      const refused = taskOutcomes(a).filter((entry) => entry.codes.includes('IDENTITY_WITHOUT_PROOF_NEEDS_AGENCY'));
      assert.equal(refused.length, 1, `the email offered as identity is refused by name: ${JSON.stringify(taskOutcomes(a))}`);
      assert.equal(refused[0]?.outcome, 'FORBIDDEN_PROPOSAL');
      for (const candidate of emailCandidates) assert.ok(a.unresolvedItems.some((entry) => entry.candidateRef === candidate.candidateRef && entry.outcome === 'FORBIDDEN_PROPOSAL' && entry.codes.includes('IDENTITY_WITHOUT_PROOF_NEEDS_AGENCY')), JSON.stringify(a.unresolvedItems));
      assert.deepEqual([a.state, a.draft.status, a.draft.configuration], ['FAILED_COMPILER', 'NOT_DRAFTABLE', null]);
      assert.equal(portA.configurations.length, 0, 'Migration Core receives no configuration from a run whose compiler refused a forbidden identity');

      // B: the same email put to the agency — a bounded agency decision, not an identity: the run drafts with no authoritative column.
      const clockB = new VirtualClock();
      const portB = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock: clockB }));
      const b = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, ({ envelope, header, oracle }) => (envelope.taskType === 'IDENTITY_STRATEGY' && header === 'Email' ? proposeIdentity(oracle, true) : undefined))), portB, clockB)).run(input, { ...CONTEXT, auditAttemptId: 'b03-ic07-b' });
      assert.equal(b.state, 'PROPOSAL_READY', JSON.stringify(b.unresolvedItems));
      assert.equal(taskOf(b, 'IDENTITY_STRATEGY').outcome, 'REQUIRES_AGENCY_DECISION');
      for (const candidate of emailCandidates) assert.ok(b.draft.decisionsRequired.some((entry) => entry.candidateRef === candidate.candidateRef), `the agency decides the email of each file: ${JSON.stringify(b.draft.decisionsRequired)}`);
      const configuration = b.draft.configuration;
      assert.ok(configuration !== null);
      assert.deepEqual(configuration.records.map((record) => [record.authoritativeExternalIdColumns.length, record.identitySpace]), configuration.records.map(() => [0, null]), 'no record carries an authoritative column');
      assert.equal(portB.configurations.length, 1);
      assert.ok(loadedConfiguration(portB.real).records.every((record) => (record['authoritativeExternalIdColumns'] as readonly unknown[]).length === 0), 'Migration Core loaded no authoritative column');

      // Migration Core keeps the rows separate: no merge, every contact row a record of its own, and the two Grace rows reported only as a duplicate candidate.
      assert.deepEqual(merges(portB.real), [], 'no proven merge');
      const effects = effectsOf(b.draft.fullValidation);
      assert.ok(effects !== null);
      assert.equal((effects['identity'] as Loose)['provenMerges'], 0);
      assert.equal((effects['records'] as readonly Loose[]).filter((record) => record['object'] === 'CONTACT').reduce((total, record) => total + Number(record['deliveredRecords']), 0), 5, 'five contact rows, five records');
      const graceRows = csvRecords(portB.real, join('02_EXCEPTIONS', 'duplicate-candidates.csv')).filter((row) => row['signal'] === 'EMAIL_EXACT');
      assert.deepEqual(graceRows.map((row) => row['file_path']).sort(), ['contacts.csv', 'contacts2.csv'], `the shared email is a duplicate candidate across the two files: ${JSON.stringify(graceRows.map((row) => [row['file_path'], row['row_locator_id']]))}`);
      assert.equal(new Set(graceRows.map((row) => row['cluster_id'])).size, 1, 'one cluster');
      assert.ok(graceRows.every((row) => row['not_merged_reason_code'] !== ''), 'reported as not merged');
    } finally {
      bundle.dispose();
    }
  });

  it('guard: identity authority is a contract external id named exactly; a header that only shares a word with it proves nothing, no identity question is asked and its key candidate is IDENTITY_WITHOUT_PROOF', TIMEOUT, async () => {
    const bundle = twoContactFiles('b03-cap06-inexact', { customer: 'Customer Number Legacy' });
    try {
      const contract = identityContract();
      const profiled = profileBundle(bundle, 'SALESFORCE');
      const contracts = adaptContracts({ mode: 'SALESFORCE', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const input = declaredInput('SALESFORCE', profiled, contract, TWO_FILES_DECLARED);
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
      const result = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, ({ envelope, oracle }) => (envelope.taskType === 'IDENTITY_STRATEGY' ? proposeIdentity(oracle) : undefined))), port, clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-cap06-inexact' });
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.ok(!result.tasks.some((task) => task.taskType === 'IDENTITY_STRATEGY'), `no identity question without a proven column: ${JSON.stringify(result.tasks.map((task) => task.taskType))}`);
      const legacy = ['contacts.csv', 'contacts2.csv'].map((path) => columnOf(profiled.profile, path, 'Customer Number Legacy'));
      const keys = profiled.candidateSet.candidateSet.candidates.filter((candidate) => candidate.candidateType === 'KEY_CANDIDATE' && legacy.some((column) => candidate.sourceRefs.includes(column.locator)));
      assert.equal(keys.length, 2);
      for (const key of keys) {
        const found = dispositionsOf(result).find((entry) => entry.candidateRef === key.candidateRef);
        assert.deepEqual([found?.family, found?.disposition, found?.code], ['IDENTITY_STRATEGY', 'DETERMINISTIC', 'IDENTITY_WITHOUT_PROOF'], JSON.stringify(found));
      }
      assert.ok((result.draft.configuration?.records ?? []).every((record) => record.authoritativeExternalIdColumns.length === 0));
      assert.deepEqual(merges(port.real), []);
    } finally {
      bundle.dispose();
    }
  });

  it('guard: two Contact files that both declare a record id column keep their own identity spaces — the proven external id is loaded on each, the agency is asked to join them, and Migration Core never merges rows across the files by a record id they happen to share', TIMEOUT, async () => {
    const bundle = twoContactFiles('b03-cap06-spaces');
    try {
      const contract = identityContract();
      const profiled = profileBundle(bundle, 'SALESFORCE');
      const contracts = adaptContracts({ mode: 'SALESFORCE', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const input = declaredInput('SALESFORCE', profiled, contract, TWO_FILES_DECLARED, { 'contacts.csv': 'Contact ID', 'contacts2.csv': 'Contact ID' });
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
      const result = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, ({ envelope, header, oracle }) => (envelope.taskType === 'IDENTITY_STRATEGY' && header === 'Customer Number' ? proposeIdentity(oracle) : undefined))), port, clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-cap06-spaces' });
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const contactRecords = (result.draft.configuration?.records ?? []).filter((record) => record.object === 'CONTACT');
      assert.equal(contactRecords.length, 2);
      for (const record of contactRecords) {
        assert.equal(record.authoritativeExternalIdColumns.length, 1, `${record.recordId}: the proven external id is loaded`);
        assert.ok(record.sourceRecordIdColumn !== null, `${record.recordId}: the declared record id is loaded`);
        assert.equal(record.identitySpace, null, `${record.recordId}: two declared record id sequences are never put in one space`);
      }
      assert.ok(result.draft.decisionsRequired.some((entry) => entry.reason.startsWith('IDENTITY_SPACE_NOT_SHARED')), `the agency is asked to join the spaces: ${JSON.stringify(result.draft.decisionsRequired)}`);
      assert.deepEqual(merges(port.real), [], 'Contact ID 1 and 2 of one file are not Contact ID 1 and 2 of the other');
    } finally {
      bundle.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ CAP07

describe('B03-CAP-IDENTITY — CAP07 DUPLICATE_SIGNAL_STRATEGY: review-only by construction (D3-CAP-07)', () => {
  it('CAP07: a Migration Core duplicate cluster is proposed as a reviewable group; the draft carries the group for the agency and the package reports the same cluster with every row delivered unmerged', TIMEOUT, async () => {
    const bundle = makeBundle('b03-cap07', { contacts: CLUSTER_CONTACTS });
    try {
      const profiled = profileWithTruth(bundle, 'CLEAN_ONLY');
      const cluster = profiled.candidateSet.candidateSet.candidates.find((candidate) => candidate.candidateType === 'DUPLICATE_CLUSTER');
      assert.ok(cluster !== undefined && cluster.sourceRefs.length === 2, 'the dry run reports the shared email as a duplicate cluster of two rows');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const input = declaredInput('CLEAN_ONLY', profiled, null, { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' }, { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' });
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, null, { clock }));
      const seen: { bytes: string; envelope: IntelligenceEnvelopeV1 }[] = [];
      const result = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, ({ envelope, oracle }) => (envelope.taskType === 'DUPLICATE_SIGNAL_STRATEGY' ? proposeDuplicate(oracle) : undefined), seen)), port, clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-cap07' });

      // The question: the cluster's record mapping and its mapped signal columns, no row and no value.
      const duplicateEnvelopes = seen.filter((entry) => entry.envelope.taskType === 'DUPLICATE_SIGNAL_STRATEGY').map((entry) => entry.envelope);
      assert.equal(duplicateEnvelopes.length, 1, `one DUPLICATE_SIGNAL_STRATEGY request: ${JSON.stringify(seen.map((entry) => entry.envelope.taskType))}`);
      const candidate = duplicateEnvelopes[0]?.deterministicCandidates[0];
      assert.ok(candidate !== undefined);
      const email = columnOf(profiled.profile, 'contacts.csv', 'Email');
      assert.ok(candidate.sourceRefs.includes(contracts.refs.refByLocator.get(email.locator) ?? ''), 'the Email column the cluster shares is a signal column of the question');
      assert.deepEqual([candidate.constraints.identityAutoMergeAllowed, candidate.impactCounts.rows], [false, 2]);
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(taskOf(result, 'DUPLICATE_SIGNAL_STRATEGY').outcome, 'PROPOSED');

      // The draft: one review group for the agency — Migration Core's cluster, by its rows — and nothing in the configuration that could merge.
      const groups = reviewGroupsOf(result);
      assert.ok(groups !== undefined, `the draft carries review groups (D3-CAP-07); it has ${Object.keys(result.draft).join(', ')}`);
      assert.equal(groups.length, 1, JSON.stringify(groups));
      const group = groups[0] as ReviewGroup;
      assert.deepEqual([group.groupRef, group.decisionRef, group.rows, [...group.rowLocators].sort()], [cluster.candidateRef, candidate.candidateRef, 2, [...cluster.sourceRefs].sort()]);
      assert.deepEqual(group.recordMappingIds, [recordMappingIdOf(fileIdOf(profiled.profile, 'contacts.csv'), 'CONTACT')]);
      assert.ok(group.signalColumns.includes(email.locator));
      assert.equal(group.observed, true, 'the package reports the same cluster');
      const configuration = result.draft.configuration;
      assert.ok(configuration !== null);
      assert.ok(configuration.records.every((record) => record.authoritativeExternalIdColumns.length === 0 && record.identitySpace === null), 'a duplicate signal puts no identity into the configuration');
      const dispositions = dispositionsOf(result);
      assert.deepEqual(dispositions.filter((entry) => entry.candidateRef === cluster.candidateRef).map((entry) => [entry.family, entry.disposition, entry.code]), [['DUPLICATE_SIGNAL_STRATEGY', 'PROPOSED', 'PROPOSE_DUPLICATE_SIGNAL']], 'the cluster is answered by the review-group proposal');
      assert.deepEqual(dispositions.filter((entry) => entry.candidateRef === candidate.candidateRef).map((entry) => [entry.family, entry.disposition]), [['DUPLICATE_SIGNAL_STRATEGY', 'PROPOSED']]);

      // Migration Core reports the same cluster, merges nothing and delivers every row.
      const reported = csvRecords(port.real, join('02_EXCEPTIONS', 'duplicate-candidates.csv'));
      const clusterRows = [...new Set(reported.filter((row) => row['signal'] === 'EMAIL_EXACT').map((row) => row['cluster_id']))].map((id) => reported.filter((row) => row['cluster_id'] === id).map((row) => row['row_locator_id']).sort());
      assert.deepEqual(clusterRows, [[...cluster.sourceRefs].sort()], 'the package reports the same rows as one duplicate cluster');
      assert.deepEqual(merges(port.real), [], 'merges nothing');
      const effects = effectsOf(result.draft.fullValidation);
      assert.ok(effects !== null);
      assert.equal((effects['identity'] as Loose)['provenMerges'], 0);
      const contacts = (effects['records'] as readonly Loose[]).find((record) => record['object'] === 'CONTACT');
      assert.deepEqual([contacts?.['deliveredRecords'], (contacts?.['rows'] as Loose | undefined)?.['mergedProven']], [4, 0], 'every contact row delivered, unmerged');
    } finally {
      bundle.dispose();
    }
  });

  it('CAP07: a duplicate-signal answer that asks for a merge, or treats the signal as identity, is FORBIDDEN and Migration Core merges nothing', TIMEOUT, async () => {
    const bundle = makeBundle('b03-cap07-deny', { contacts: CLUSTER_CONTACTS });
    try {
      const profiled = profileWithTruth(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const input = declaredInput('CLEAN_ONLY', profiled, null, { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' }, { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' });
      const answers: readonly { readonly name: string; readonly write: (item: ProposalItem) => ProposalItem }[] = [
        { name: 'a merge asked for as a parameter', write: (item) => proposeDuplicate(item, { typedTransformParams: { merge: 'true' } }) },
        { name: 'a merge asked for with the agency', write: (item) => proposeDuplicate(item, { typedTransformParams: { survivor: 'first' }, requiresAgencyDecision: true }) },
        { name: 'the signal proposed as the identity strategy', write: (item) => proposeIdentity(item) },
        { name: 'the signal offered as a proven identifier', write: (item) => proposeDuplicate(item, { rationaleCode: 'UNIQUE_AND_WELL_FORMED_IDENTIFIER' }) },
      ];
      for (const [index, entry] of answers.entries()) {
        const clock = new VirtualClock();
        const port = recordingPort(realValidationPort(bundle, profiled.profile, null, { clock }));
        const seen: { bytes: string; envelope: IntelligenceEnvelopeV1 }[] = [];
        const gateway = recordingGateway(caseTransport(contracts, ({ envelope, oracle }) => (envelope.taskType === 'DUPLICATE_SIGNAL_STRATEGY' ? entry.write(oracle) : undefined), seen));
        const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, { ...CONTEXT, auditAttemptId: `b03-cap07-deny-${String(index)}` });
        assert.ok(seen.some((request) => request.envelope.taskType === 'DUPLICATE_SIGNAL_STRATEGY'), `${entry.name}: the duplicate question was asked`);
        const refused = taskOutcomes(result).filter((outcome) => outcome.codes.includes('DUPLICATE_SIGNAL_IS_NOT_AUTHORITY'));
        assert.equal(refused.length, 1, `${entry.name}: refused by name: ${JSON.stringify(taskOutcomes(result))}`);
        assert.equal(refused[0]?.outcome, 'FORBIDDEN_PROPOSAL', entry.name);
        assert.equal(gateway.requests.filter((request) => request.envelope.taskId === refused[0]?.taskId).length, 1, `${entry.name}: a forbidden answer is never repaired`);
        assert.deepEqual([result.state, result.draft.status, result.draft.configuration], ['FAILED_COMPILER', 'NOT_DRAFTABLE', null], entry.name);
        assert.equal(reviewGroupsOf(result)?.length ?? 0, 0, `${entry.name}: no review group from a refused answer`);
        assert.equal(port.configurations.length, 0, `${entry.name}: Migration Core is handed nothing to merge`);
      }
    } finally {
      bundle.dispose();
    }
  });

  it("guard: a review group Migration Core's receipt does not report is drafted unobserved, never claimed", TIMEOUT, async () => {
    const bundle = makeBundle('b03-cap07-unobserved', { contacts: CLUSTER_CONTACTS });
    try {
      const profiled = profileWithTruth(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const input = declaredInput('CLEAN_ONLY', profiled, null, { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' }, { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' });
      const clock = new VirtualClock();
      const losing = altered(realValidationPort(bundle, profiled.profile, null, { clock }), (receipt) => {
        const effects = effectsOf(receipt);
        return effects === null ? receipt : { ...receipt, effects: { ...effects, duplicateClusters: [] } };
      });
      const result = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, ({ envelope, oracle }) => (envelope.taskType === 'DUPLICATE_SIGNAL_STRATEGY' ? proposeDuplicate(oracle) : undefined))), losing, clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-cap07-unobserved' });
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const groups = reviewGroupsOf(result);
      assert.ok(groups !== undefined && groups.length === 1, JSON.stringify(groups));
      assert.equal(groups[0]?.observed, false, 'a cluster the receipt does not report is not claimed observed');
    } finally {
      bundle.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ CAP08

describe('B03-CAP-IDENTITY — CAP08 ASSOCIATION_MAPPING: declared endpoints over relationships the contract offers (D3-CAP-08)', () => {
  it('CAP08: a Company ID column of the Contacts file that references the Companies record id is mapped CONTACT_TO_COMPANY; Migration Core delivers one edge per referencing row and reports the missing endpoints', TIMEOUT, async () => {
    const bundle = makeBundle('b03-cap08', { contacts: ASSOCIATION_CONTACTS, companies: ASSOCIATION_COMPANIES });
    try {
      const contract = vendorContract('SALESFORCE');
      const profiled = profileBundle(bundle, 'SALESFORCE');
      const contracts = adaptContracts({ mode: 'SALESFORCE', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const input = declaredInput('SALESFORCE', profiled, contract, { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' }, { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' });
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
      const seen: { bytes: string; envelope: IntelligenceEnvelopeV1 }[] = [];
      const result = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, ({ envelope, candidate, oracle }) => (envelope.taskType === 'ASSOCIATION_MAPPING' && candidate.allowedTargetRefs.length === 1 ? mapAssociation(oracle, candidate.allowedTargetRefs[0] as string) : undefined), seen)), port, clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-cap08' });

      // The question: the key column, one option — the declared Companies record mapping, over the one relationship the contract offers for it.
      const { associationRefOf: refOf, recordRefOf: recordOf } = refs();
      const key = columnOf(profiled.profile, 'contacts.csv', 'Company ID');
      const keyFieldRef = contracts.refs.refByLocator.get(key.locator) ?? '';
      const companiesMapping = recordMappingIdOf(fileIdOf(profiled.profile, 'companies.csv'), 'COMPANY');
      const contactsMapping = recordMappingIdOf(fileIdOf(profiled.profile, 'contacts.csv'), 'CONTACT');
      const expectedRef = refOf(keyFieldRef, 'CONTACT_TO_COMPANY', recordOf(companiesMapping));
      const envelopes = seen.filter((entry) => entry.envelope.taskType === 'ASSOCIATION_MAPPING').map((entry) => entry.envelope);
      assert.equal(envelopes.length, 1, `one ASSOCIATION_MAPPING request: ${JSON.stringify(seen.map((entry) => entry.envelope.taskType))}`);
      const envelope = envelopes[0] as IntelligenceEnvelopeV1;
      assert.deepEqual(envelope.deterministicCandidates.map((candidate) => [candidate.sourceRefs[0], candidate.allowedTargetRefs]), [[keyFieldRef, [expectedRef]]]);
      assert.deepEqual(associationTargetsOf(envelope)?.map((target) => [target.associationRef, target.keyFieldRef, target.relationshipType, target.ownerSide, target.targetObject, target.targetRecordRef]), [[expectedRef, keyFieldRef, 'CONTACT_TO_COMPANY', 'FROM', 'COMPANY', recordOf(companiesMapping)]]);
      assert.deepEqual(envelope.constraints.allowedAssociationTypes, ['CONTACT_TO_COMPANY'], "allowedAssociationTypes are the contract's");
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(taskOf(result, 'ASSOCIATION_MAPPING').outcome, 'PROPOSED');

      // The configuration: one COLUMN_REFERENCE association from the contacts to the declared companies record id; the key column is the association's, no leftover.
      const configuration = result.draft.configuration;
      assert.ok(configuration !== null);
      assert.equal(configuration.associations.length, 1, JSON.stringify(configuration.associations));
      const association = configuration.associations[0];
      assert.ok(association !== undefined);
      assert.deepEqual([association.recordId, association.relationshipType, association.ownerSide, association.keyColumn.columnLocator, association.targetRecordId, association.targetMatchKey, association.decisionRef], [contactsMapping, 'CONTACT_TO_COMPANY', 'FROM', key.locator, companiesMapping, 'SOURCE_RECORD_ID', envelope.deterministicCandidates[0]?.candidateRef]);
      assert.ok(configuration.records.find((record) => record.recordId === companiesMapping)?.sourceRecordIdColumn !== null, 'the target declares its record id');
      assert.ok(!configuration.preservedColumns.some((column) => column.columnLocator === key.locator), 'the key column is read by the association, not preserved as a leftover');
      const found = dispositionsOf(result).find((entry) => entry.candidateRef === association.decisionRef);
      assert.deepEqual([found?.family, found?.disposition, found?.code], ['ASSOCIATION_MAPPING', 'PROPOSED', 'MAP_ASSOCIATION']);
      const manifest = result.draft.fragmentCoverage?.entries.find((entry) => entry.fragmentKind === 'ASSOCIATION');
      assert.deepEqual([manifest?.decisionRef, manifest?.observed, manifest?.fragmentHash], [association.decisionRef, true, association.fragmentHash]);

      // Migration Core: the association loaded, one edge per referencing row — three delivered, and C9 an endpoint it reports missing.
      const loaded = loadedConfiguration(port.real);
      assert.deepEqual(loaded.associations.map((entry) => [entry['kind'], entry['relationshipType'], (entry['keyColumn'] as Loose)['index'], entry['targetMatchKey']]), [['COLUMN_REFERENCE', 'CONTACT_TO_COMPANY', key.index, 'SOURCE_RECORD_ID']]);
      const edges = csvRecords(port.real, join('03_TRACEABILITY', 'associations.csv'));
      assert.equal(edges.length, 4, 'one edge per referencing row');
      assert.deepEqual(edges.map((edge) => edge['disposition']).sort(), ['OUTPUT', 'OUTPUT', 'OUTPUT', 'UNRESOLVED']);
      const missing = csvRecords(port.real, join('02_EXCEPTIONS', 'unresolved-associations.csv'));
      assert.deepEqual(missing.map((edge) => [edge['to_key_raw'], edge['reason_code']]), [['C9', 'ASSOCIATION_ENDPOINT_NOT_FOUND']]);

      // The draft reports what Migration Core reported: the edges delivered and the endpoints missing, by the association's fragment.
      const reports = associationsOf(result);
      assert.ok(reports !== undefined, `the draft carries its associations (D3-CAP-08); it has ${Object.keys(result.draft).join(', ')}`);
      assert.deepEqual(reports.map((report) => [report.associationId, report.decisionRef, report.relationshipType, report.recordMappingId, report.targetRecordMappingId, report.keyColumnLocator, report.fragmentHash, report.edgesDelivered, report.missingEndpoints]), [[association.associationId, association.decisionRef, 'CONTACT_TO_COMPANY', contactsMapping, companiesMapping, key.locator, association.fragmentHash, 3, missing.length]]);
      const effects = effectsOf(result.draft.fullValidation);
      assert.deepEqual(((effects?.['associations'] ?? []) as readonly Loose[]).map((entry) => entry['missingEndpoints']), [1]);
    } finally {
      bundle.dispose();
    }
  });

  it('CAP08: an association whose target record mapping has no declared id column, or whose relationship the contract does not support, is refused; Migration Core receives no association', TIMEOUT, async () => {
    const base = makeBundle('b03-cap08-deny', { contacts: ASSOCIATION_CONTACTS, companies: ASSOCIATION_COMPANIES });
    try {
      // A second Companies file that declares no record id, and a Deals file whose record id is declared: a contact-to-deal link is no relationship a Salesforce import can write.
      writeFileSync(join(base.root, 'companies2.csv'), 'Company Code,Name\nK1,Difference Engines\n');
      writeFileSync(join(base.root, 'deals.csv'), 'Deal ID,Name\nD1,Engine Sale\n');
      const bundle: Bundle = { ...base, files: [...base.files, { id: 'companies2', path: 'companies2.csv', idHeader: 'Company Code', object: 'COMPANY' }, { id: 'deals', path: 'deals.csv', idHeader: 'Deal ID', object: 'COMPANY' }] };
      const contract = vendorContract('SALESFORCE');
      const profiled = profileBundle(bundle, 'SALESFORCE');
      const contracts = adaptContracts({ mode: 'SALESFORCE', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const input = declaredInput('SALESFORCE', profiled, contract, { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY', 'companies2.csv': 'COMPANY', 'deals.csv': 'DEAL' }, { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID', 'deals.csv': 'Deal ID' });
      const { associationRefOf: refOf, recordRefOf: recordOf } = refs();
      const keyFieldRef = contracts.refs.refByLocator.get(columnOf(profiled.profile, 'contacts.csv', 'Company ID').locator) ?? '';
      const declaredRef = refOf(keyFieldRef, 'CONTACT_TO_COMPANY', recordOf(recordMappingIdOf(fileIdOf(profiled.profile, 'companies.csv'), 'COMPANY')));
      const cases: readonly { readonly name: string; readonly ref: string; readonly code: string }[] = [
        { name: 'a target record mapping with no declared id column', ref: refOf(keyFieldRef, 'CONTACT_TO_COMPANY', recordOf(recordMappingIdOf(fileIdOf(profiled.profile, 'companies2.csv'), 'COMPANY'))), code: 'ASSOCIATION_ENDPOINT_UNDECLARED' },
        { name: 'a relationship the contract does not support', ref: refOf(keyFieldRef, 'CONTACT_TO_DEAL', recordOf(recordMappingIdOf(fileIdOf(profiled.profile, 'deals.csv'), 'DEAL'))), code: 'RELATIONSHIP_NOT_SUPPORTED' },
      ];
      for (const [index, entry] of cases.entries()) {
        const clock = new VirtualClock();
        const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
        const seen: { bytes: string; envelope: IntelligenceEnvelopeV1 }[] = [];
        const gateway = recordingGateway(caseTransport(contracts, ({ envelope, oracle }) => (envelope.taskType === 'ASSOCIATION_MAPPING' ? mapAssociation(oracle, entry.ref) : undefined), seen));
        const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, { ...CONTEXT, auditAttemptId: `b03-cap08-deny-${String(index)}` });
        const envelope = seen.find((request) => request.envelope.taskType === 'ASSOCIATION_MAPPING')?.envelope;
        assert.ok(envelope !== undefined, `${entry.name}: the association question was asked`);
        assert.deepEqual(envelope.deterministicCandidates.map((candidate) => candidate.allowedTargetRefs), [[declaredRef]], `${entry.name}: only the declared endpoint over the offered relationship is offered`);
        assert.ok(!envelope.constraints.allowedAssociationTypes.includes('CONTACT_TO_DEAL'), `${entry.name}: the contract offers no contact-to-deal relationship`);
        const refused = taskOutcomes(result).filter((outcome) => outcome.codes.includes(entry.code));
        assert.equal(refused.length, 1, `${entry.name}: refused as ${entry.code}: ${JSON.stringify(taskOutcomes(result))}`);
        assert.equal(refused[0]?.outcome, 'FORBIDDEN_PROPOSAL', entry.name);
        assert.deepEqual([result.state, result.draft.status, result.draft.configuration], ['FAILED_COMPILER', 'NOT_DRAFTABLE', null], entry.name);
        assert.equal(port.configurations.length, 0, `${entry.name}: Migration Core receives no association`);
      }

      // The honest neighbour: the model leaves the column alone, the run drafts, and Migration Core loads no association — the key column is a leftover it accounts.
      const clock = new VirtualClock();
      const port = recordingPort(realValidationPort(bundle, profiled.profile, contract, { clock }));
      const result = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, () => undefined)), port, clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-cap08-deny-abstain' });
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.deepEqual(result.draft.configuration?.associations, []);
      assert.deepEqual(loadedConfiguration(port.real).associations, [], 'Migration Core loaded no association');
      assert.deepEqual(csvRecords(port.real, join('03_TRACEABILITY', 'associations.csv')), [], 'and delivered no edge');
      assert.deepEqual(associationsOf(result) ?? [], []);
    } finally {
      base.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------ channels

describe('B03-CAP-IDENTITY — the association-key and duplicate-signal channels (plan §5)', () => {
  it("sentinel: the association-key and duplicate-signal channels carry refs and counts only; a sentinel in the key column's header and values and in the shared signal value never reaches the provider, nor do Migration Core's cluster ref, its evidence or its row addresses", TIMEOUT, async () => {
    // Synthetic sentinels written for this file.
    const SENTINELS = ['Ondriel', 'Vaskemar', 'ondriel.vaskemar'];
    const shared = 'ondriel.vaskemar@kauro-fixture.test';
    const bundle = makeBundle('b03-cap-identity-sentinel', {
      contacts: `Contact ID,First Name,Last Name,Email,Company Ondriel Vaskemar\n1,Ada,Lovelace,${shared},QV1\n2,Grace,Hopper,${EMAIL.grace},QV2\n3,Alan,Turing,${shared},QV1\n`,
      companies: 'Company ID,Name,Website\nQV1,Analytical Engines,https://analytical.test\nQV2,COBOL Works,https://cobol.test\n',
    });
    try {
      const profiled = profileWithTruth(bundle, 'CLEAN_ONLY');
      const cluster = profiled.candidateSet.candidateSet.candidates.find((candidate) => candidate.candidateType === 'DUPLICATE_CLUSTER');
      assert.ok(cluster !== undefined, 'the shared sentinel email is a duplicate cluster');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const key = columnOf(profiled.profile, 'contacts.csv', 'Company Ondriel Vaskemar');
      const email = columnOf(profiled.profile, 'contacts.csv', 'Email');
      const summaries = new Map<string, readonly string[]>([[key.locator, ['Ondriel', 'Vaskemar']], [email.locator, [shared, EMAIL.grace]]]);
      const input = declaredInput('CLEAN_ONLY', profiled, null, { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' }, { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' }, { categoricalSummaries: summaries });
      const clock = new VirtualClock();
      const seen: { bytes: string; envelope: IntelligenceEnvelopeV1 }[] = [];
      const result = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, ({ envelope, candidate, oracle }) => (envelope.taskType === 'DUPLICATE_SIGNAL_STRATEGY' ? proposeDuplicate(oracle) : envelope.taskType === 'ASSOCIATION_MAPPING' && candidate.allowedTargetRefs.length === 1 ? mapAssociation(oracle, candidate.allowedTargetRefs[0] as string) : undefined), seen)), recordingPort(realValidationPort(bundle, profiled.profile, null, { clock })), clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-cap-identity-sentinel' });

      // Both channels travelled.
      const association = seen.find((entry) => entry.envelope.taskType === 'ASSOCIATION_MAPPING');
      const duplicate = seen.find((entry) => entry.envelope.taskType === 'DUPLICATE_SIGNAL_STRATEGY');
      assert.ok(association !== undefined && duplicate !== undefined, `both questions were asked: ${JSON.stringify(seen.map((entry) => entry.envelope.taskType))}`);
      const targets = associationTargetsOf(association.envelope);
      assert.ok(targets !== undefined && targets.length === 1, 'the association channel carried its option');
      // The association channel is refs and closed codes: its target record mapping travels as the opaque ref of its record mapping id, never as anything its file could be read back from.
      const { recordRefOf: recordOf } = refs();
      assert.equal(targets[0]?.targetRecordRef, recordOf(recordMappingIdOf(fileIdOf(profiled.profile, 'companies.csv'), 'COMPANY')));
      for (const target of targets) for (const [member, value] of Object.entries(target)) assert.match(String(value), /^(?:[a-z][a-z0-9]*_[0-9a-f]{8,32}|[A-Z][A-Z_]*)$/u, `association target ${member} is a ref or a closed code`);

      // Nothing of the sentinels, and nothing of the cluster but the count, left the process.
      const clusterEvidence = cluster.evidenceRefs;
      const forbidden = [...SENTINELS, cluster.candidateRef, ...clusterEvidence, ...clusterEvidence.map((evidence) => evidenceRefFor(evidence)), ...cluster.sourceRefs, 'duplicate-candidates', 'QV1', 'QV2'];
      for (const request of seen) {
        const text = request.bytes.toLowerCase();
        for (const needle of forbidden) assert.ok(!text.includes(needle.toLowerCase()), `the ${request.envelope.taskType} request carries ${needle}`);
      }
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
    } finally {
      bundle.dispose();
    }
  });

  it('guard: the egress decision re-reads the association channel — a member that is not a ref or a closed code, or an association ref its members do not derive, blocks the envelope', TIMEOUT, () => {
    const bundle = makeBundle('b03-cap-identity-egress', { contacts: ASSOCIATION_CONTACTS, companies: ASSOCIATION_COMPANIES });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const resolution = resolveDeterministically(contracts, { declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' }, recordIdColumns: { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' } });
      const candidate = resolution.derivedCandidates.find((entry) => entry.candidateType === 'DERIVED_ASSOCIATION_DECISION');
      assert.ok(candidate !== undefined, 'the Company ID column is an association question');
      const budget = { maxInputTokens: 100_000, maxOutputTokens: 8_192, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 1_000_000, remainingTasks: 32, deadlineAt: '2026-09-30T00:00:00.000Z' };
      const secret = Buffer.alloc(32, 3);
      const input = { task: { taskId: 'task_00000000000000a8', taskType: 'ASSOCIATION_MAPPING' as const, partitionKey: 'association', candidateRefs: [candidate.candidateRef], order: 0 }, contracts, candidates: [candidate], memoryEvidence: [], summaries: new Map(), projectRevisionId: 'rev', projectRevisionHash: 'a'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot: budget, repairContext: null, egressSecret: secret, tenant: CONTEXT.tenant, attemptId: 'attempt-0001', decisions: resolution.decisions };
      const built = buildEnvelope(input as unknown as Parameters<typeof buildEnvelope>[0]);
      assert.equal(built.egress.decision, 'EGRESS_ALLOWED', JSON.stringify(built.egress.blockedReasons));
      const targets = associationTargetsOf(built.envelope);
      assert.ok(targets !== undefined && targets.length === 1);
      const target = targets[0] as AssociationTarget;
      const forgeries: readonly { readonly name: string; readonly target: AssociationTarget }[] = [
        { name: 'a text in a ref member', target: { ...target, targetRecordRef: 'Ondriel Accounts' } },
        { name: 'an association ref its members do not derive', target: { ...target, associationRef: 'assoc_00000000000000ff' } },
      ];
      for (const forgery of forgeries) {
        const envelope = { ...built.envelope, associationTargets: [forgery.target] } as unknown as IntelligenceEnvelopeV1;
        const decision = decideEgress({ envelope, hash: envelopeHash(envelope), minimization: built.minimization, budget, secret });
        assert.equal(decision.decision, 'EGRESS_BLOCKED_POLICY', `${forgery.name}: ${JSON.stringify(decision.blockedReasons)}`);
      }
    } finally {
      bundle.dispose();
    }
  });

  it('guard: a proposal of the identity families on a candidate of another family is FORBIDDEN by name, whatever the task lets through', TIMEOUT, () => {
    const bundle = makeBundle('b03-cap-identity-foreign-answers', { contacts: ASSOCIATION_CONTACTS, companies: ASSOCIATION_COMPANIES });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const resolution = resolveDeterministically(contracts, { declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' }, recordIdColumns: { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' } });
      const association = resolution.derivedCandidates.find((entry) => entry.candidateType === 'DERIVED_ASSOCIATION_DECISION');
      const field = resolution.derivedCandidates.find((entry) => entry.candidateType === 'DERIVED_FIELD_DECISION' && entry.sourceRefs[0] === association?.sourceRefs[0]);
      assert.ok(association !== undefined && field !== undefined, 'the Company ID column is both a field question and an association question');
      const budget = { maxInputTokens: 100_000, maxOutputTokens: 8_192, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 1_000_000, remainingTasks: 32, deadlineAt: '2026-09-30T00:00:00.000Z' };
      const RUN = 'run_00000000000000c8';
      const compileAs = (taskType: 'DUPLICATE_SIGNAL_STRATEGY' | 'ASSOCIATION_MAPPING', write: (item: ProposalItem) => ProposalItem): readonly string[] => {
        const input = { task: { taskId: 'task_00000000000000c8', taskType, partitionKey: 'guard', candidateRefs: [field.candidateRef], order: 0 }, contracts, candidates: [field], memoryEvidence: [], summaries: new Map(), projectRevisionId: 'rev', projectRevisionHash: 'a'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot: budget, repairContext: null, egressSecret: Buffer.alloc(32, 3), tenant: CONTEXT.tenant, attemptId: 'attempt-0001', decisions: resolution.decisions };
        const built = buildEnvelope(input as unknown as Parameters<typeof buildEnvelope>[0]);
        const proposal = oracleProposal(built.envelope, RUN);
        const compiled = compileProposal({ envelope: built.envelope, envelopeHash: built.hash, proposal: { ...proposal, items: proposal.items.map(write) }, runId: RUN, contracts, decisions: resolution.decisions });
        assert.equal(compiled.outcome, 'FORBIDDEN_PROPOSAL', JSON.stringify(compiled.codes));
        return compiled.codes;
      };
      assert.ok(compileAs('DUPLICATE_SIGNAL_STRATEGY', (item) => proposeDuplicate(item)).includes('PROPOSAL_TYPE_NOT_ALLOWED_FOR_CANDIDATE'), 'a review group only stands on a duplicate candidate');
      assert.ok(compileAs('ASSOCIATION_MAPPING', (item) => mapAssociation(item, association.allowedTargetRefs[0] as string)).includes('PROPOSAL_TYPE_NOT_ALLOWED_FOR_CANDIDATE'), 'an association only stands on an association candidate');
    } finally {
      bundle.dispose();
    }
  });

  it("guard: the relationships a run offers are those Migration Core's adapter supports between objects the contract delivers — a Salesforce contact on an opportunity never, a HubSpot contact on a deal when the contract carries deals", TIMEOUT, () => {
    const offered = exported['offeredRelationshipTypes'] as ((contracts: AdaptedContracts) => readonly string[]) | undefined;
    assert.equal(typeof offered, 'function', 'offeredRelationshipTypes is exported');
    const bundle = makeBundle('b03-cap-identity-relationships');
    try {
      const hs = profileBundle(bundle, 'HUBSPOT');
      const sf = profileBundle(bundle, 'SALESFORCE');
      const clean = profileBundle(bundle, 'CLEAN_ONLY');
      const withDeals = (mode: 'HUBSPOT' | 'SALESFORCE'): HashedTargetContract => {
        const base = vendorContract(mode).contract;
        const deal = mode === 'HUBSPOT' ? { apiName: 'deals', label: 'Deal', createable: 'TRUE' as const, updateable: 'TRUE' as const, recordTypes: [], fields: [sfField('dealname', 'Deal Name', 'string'), sfField('amount', 'Amount', 'number')] } : { apiName: 'Opportunity', label: 'Opportunity', createable: 'TRUE' as const, updateable: 'TRUE' as const, recordTypes: [], fields: [sfField('Name', 'Name', 'string'), sfField('Amount', 'Amount', 'currency')] };
        return hashTargetContract({ ...base, objects: [...base.objects, deal] });
      };
      const of = (mode: 'CLEAN_ONLY' | 'HUBSPOT' | 'SALESFORCE', profiled: typeof hs, contract: HashedTargetContract | null): readonly string[] => (offered as NonNullable<typeof offered>)(adaptContracts({ mode, profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract }));
      assert.deepEqual(of('CLEAN_ONLY', clean, null), ['CONTACT_TO_COMPANY', 'CONTACT_TO_DEAL', 'COMPANY_TO_DEAL'], 'CLEAN_ONLY delivers every relationship of the canonical model');
      assert.deepEqual(of('HUBSPOT', hs, vendorContract('HUBSPOT')), ['CONTACT_TO_COMPANY'], 'a contract without deals offers no deal relationship');
      assert.deepEqual(of('HUBSPOT', hs, withDeals('HUBSPOT')), ['CONTACT_TO_COMPANY', 'CONTACT_TO_DEAL', 'COMPANY_TO_DEAL']);
      assert.deepEqual(of('SALESFORCE', sf, withDeals('SALESFORCE')), ['CONTACT_TO_COMPANY', 'COMPANY_TO_DEAL'], 'a contact on an opportunity is an OpportunityContactRole Migration Core does not claim');
    } finally {
      bundle.dispose();
    }
  });

  it('guard: every key candidate and duplicate cluster of the set keeps exactly one disposition — the declared record id DETERMINISTIC, an unproven key IDENTITY_WITHOUT_PROOF, a cluster its duplicate question — and planCandidates names the duplicate question before any request', TIMEOUT, async () => {
    const bundle = makeBundle('b03-cap-identity-accounting', { contacts: CLUSTER_CONTACTS });
    try {
      const profiled = profileWithTruth(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const input = declaredInput('CLEAN_ONLY', profiled, null, { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' }, { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' });
      assert.equal(typeof planCandidates, 'function');
      const expected = (planCandidates as NonNullable<typeof planCandidates>)(input);
      assert.ok(expected.candidates.some((candidate) => candidate.origin === 'RESOLVER' && candidate.family === 'DUPLICATE_SIGNAL_STRATEGY'), 'the duplicate question is in the expected set before any request');
      const clock = new VirtualClock();
      const result = await createIntelligenceCore(depsFor(recordingGateway(caseTransport(contracts, () => undefined)), recordingPort(realValidationPort(bundle, profiled.profile, null, { clock })), clock)).run(input, { ...CONTEXT, auditAttemptId: 'b03-cap-identity-accounting' });
      const dispositions = dispositionsOf(result);
      const declared = new Set(['contacts.csv:Contact ID', 'companies.csv:Company ID'].map((entry) => columnOf(profiled.profile, entry.split(':')[0] as string, entry.split(':')[1] as string).locator));
      for (const original of profiled.candidateSet.candidateSet.candidates.filter((candidate) => candidate.candidateType === 'KEY_CANDIDATE' || candidate.candidateType === 'DUPLICATE_CLUSTER')) {
        const found = dispositions.filter((entry) => entry.candidateRef === original.candidateRef);
        assert.equal(found.length, 1, `${original.candidateType} has one disposition`);
        const [entry] = found as [Disposition];
        if (original.candidateType === 'DUPLICATE_CLUSTER') {
          assert.deepEqual([entry.family, entry.disposition, entry.code], ['DUPLICATE_SIGNAL_STRATEGY', 'PRESERVED', 'ABSTAIN'], 'an abstention on the question leaves the cluster to Migration Core\'s report');
          assert.ok(entry.taskId !== null, 'the question that answered it names its task');
        } else if (original.sourceRefs.some((locator) => declared.has(locator))) assert.deepEqual([entry.family, entry.disposition, entry.code], ['IDENTITY_STRATEGY', 'DETERMINISTIC', 'DECLARED_RECORD_ID']);
        else assert.deepEqual([entry.family, entry.disposition, entry.code], ['IDENTITY_STRATEGY', 'DETERMINISTIC', 'IDENTITY_WITHOUT_PROOF']);
      }
      assert.ok(!dispositions.some((entry) => entry.code === 'FAMILY_NOT_PLANNED' && (entry.family === 'IDENTITY_STRATEGY' || entry.family === 'DUPLICATE_SIGNAL_STRATEGY')), 'no identity or duplicate original is left FAMILY_NOT_PLANNED');
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.deepEqual(reviewGroupsOf(result) ?? [], [], 'an abstention makes no review group');
    } finally {
      bundle.dispose();
    }
  });
});
